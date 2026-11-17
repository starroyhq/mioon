import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {availableParallelism} from 'node:os';
import {Worker} from 'node:worker_threads';
import {fixture} from './fixture.ts';
import {createMotionWindow} from './render.ts';
import type {MotionWindow} from './render.ts';

type CaptureOptions = Pick<Parameters<typeof createMotionWindow>[0], 'assetsDirectory' | 'width' | 'height' | 'fps'>
  & {signal: AbortSignal};

export function hashFrame(rgba: Buffer): string {
  return createHash('sha256').update(rgba).digest('hex');
}

async function captureSequence(window: MotionWindow, expected?: readonly string[]) {
  const digest = createHash('sha256');
  const hashes: string[] = [];
  for (let frame = 0; frame < fixture.frames; frame++) {
    const rgba = await window.render(frame);
    const hash = hashFrame(rgba);
    if (expected) assert.equal(hash, expected[frame], `Full sequence changed at frame ${frame}`);
    hashes.push(hash);
    digest.update(rgba);
  }
  return {sha256: digest.digest('hex'), hashes};
}

export async function compareLegacyCaptures(options: CaptureOptions) {
  const window = await createMotionWindow({...options, mode: 'export', capture: 'legacy-double-raf'});
  try {
    const first = await captureSequence(window);
    const second = await captureSequence(window);
    const differentFrames = first.hashes.flatMap((hash, frame) => hash === second.hashes[frame] ? [] : [frame]);
    return {first: first.sha256, second: second.sha256, differentFrames};
  } finally {
    window.close();
  }
}

const loadProgram = `
const {parentPort, workerData} = require('node:worker_threads');
const state = new Int32Array(workerData);
parentPort.postMessage('ready');
let value = 1;
while (Atomics.load(state, 0) === 0) {
  for (let i = 0; i < 100000; i++) value = Math.imul(value ^ i, 1664525) + 1013904223;
  Atomics.add(state, 1, 1);
}
parentPort.postMessage(value);
`;

async function withCpuPressure(work: () => Promise<void>, caller: AbortSignal) {
  const count = Math.min(availableParallelism(), 4);
  const state = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  const workers: Worker[] = [];
  const ready = AbortSignal.any([caller, AbortSignal.timeout(10_000)]);
  try {
    for (let i = 0; i < count; i++) {
      workers.push(new Worker(loadProgram, {eval: true, workerData: state.buffer}));
    }
    await Promise.all(workers.map(worker => once(worker, 'message', {signal: ready})));
    const initialBatches = Atomics.load(state, 1);
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    await work();
    const cpu = process.cpuUsage(cpuStart);
    const elapsedMs = performance.now() - wallStart;
    const completedBatches = Atomics.load(state, 1) - initialBatches;
    assert.ok(completedBatches > 0, 'CPU pressure workers must run during captures');
    return {workers: count, elapsedMs, processCpuPercent: (cpu.user + cpu.system) / (10 * elapsedMs), completedBatches};
  } finally {
    Atomics.store(state, 0, 1);
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

export async function verifyCaptures(
  options: CaptureOptions, expected: readonly string[], expectedSha256: string,
) {
  // Start a new renderer so the second full pass does not depend on an existing page or raster cache.
  const window = await createMotionWindow({...options, mode: 'export'});
  const frames = [3, 7, 13, 21, 24, 60, 120, 140, 146, 149];
  async function checkFrameOrder(): Promise<void> {
    for (const frame of frames) {
      await window.render(frame - 1);
      const sequential = await window.render(frame);
      await window.render((frame + 40) % fixture.frames);
      const seek = await window.render(frame);
      assert.ok(seek.equals(sequential), `Frame ${frame} depends on which frame was drawn before it`);
      assert.equal(hashFrame(seek), expected[frame], `Frame ${frame} differs from the full sequence`);
    }
  }
  try {
    const second = await captureSequence(window, expected);
    assert.equal(second.sha256, expectedSha256, 'Complete verified RGBA sequences differ');
    assert.ok(frames.some(frame => expected[frame] !== expected[frame - 1] &&
      expected[frame] !== expected[(frame + 40) % fixture.frames]), 'Frame order samples must include visible transitions');
    await checkFrameOrder();
    const cpuPressure = await withCpuPressure(checkFrameOrder, options.signal);
    assert.equal(window.captureStats.accepted, fixture.frames + frames.length * 8, 'Every repeat and order probe needs a pixel marker');
    return {secondSha256: second.sha256, frames: fixture.frames, orderProbeFrames: frames, cpuPressure,
      readback: window.captureStats};
  } finally {
    window.close();
  }
}
