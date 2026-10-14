import { runClientAllocationCheck } from './client-allocation-browser.ts';
import { audioPreviewPlanSchema, type AudioPreviewPlan } from '../../../packages/contracts/src/timeline-audio-preview.ts';
import { scheduleTimelineAudioPreviewGraph, createTimelineAudioPreviewTransport } from '../../../apps/web/src/timeline-audio-preview-engine.ts';

const RATE = 48000, MAX_MEMORY = 96 * 1024 * 1024;
function assert(condition: unknown, text: string): asserts condition { if (!condition) throw Error(text); }
interface NumericCase { name: string; plan: AudioPreviewPlan; cursorSample: number; oracle: string; absoluteTolerance: number; expectOverOne: boolean }
const reportNode = document.querySelector('#report')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
async function bytes(name: string): Promise<ArrayBuffer> {
  const response = await fetch(name); assert(response.ok, `Missing synthetic fixture ${name}`); return response.arrayBuffer();
}
async function inputBuffers(context: BaseAudioContext, plan: AudioPreviewPlan): Promise<Map<string, AudioBuffer>> {
  const buffers = new Map<string, AudioBuffer>();
  for (const source of plan.sources) {
    const raw = await bytes(`${source.sourceKey}.f32`); assert(raw.byteLength === source.pcmBytes, 'Source payload length mismatch');
    const view = new DataView(raw), buffer = context.createBuffer(2, source.sampleFrames, RATE);
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    for (let sample = 0; sample < source.sampleFrames; sample++) {
      const l = view.getFloat32(sample * 8, true), r = view.getFloat32(sample * 8 + 4, true);
      assert(Number.isFinite(l) && Number.isFinite(r), 'Nonfinite canonical source'); left[sample] = l; right[sample] = r;
    }
    buffers.set(source.sourceKey, buffer);
  }
  return buffers;
}
async function offline(item: NumericCase): Promise<unknown> {
  const plan = audioPreviewPlanSchema.parse(item.plan), frames = plan.range.endSample - item.cursorSample;
  // Explicit test-only capacity for rendered buffer, acquired output channels,
  // and independent oracle. This is separate from production admission.
  const captureReservedBytes = frames * 8 * 3;
  assert(plan.memory.admittedBytes + captureReservedBytes <= MAX_MEMORY, 'Numeric capture would exceed 96 MiB');
  const context = new OfflineAudioContext(2, frames, RATE), buffers = await inputBuffers(context, plan);
  const graph = scheduleTimelineAudioPreviewGraph({ context, plan, buffers, cursorSample: item.cursorSample, originTime: 0 });
  const rendered = await context.startRendering(); graph.stop();
  assert(rendered.length === frames && rendered.sampleRate === RATE && rendered.numberOfChannels === 2, 'Offline sample clock mismatch');
  const oracle = new DataView(await bytes(item.oracle)); assert(oracle.byteLength === frames * 8, 'Oracle sample count mismatch');
  const errors = [], peaks = []; let onset = -1, endExclusive = -1;
  for (let channel = 0; channel < 2; channel++) {
    const actual = rendered.getChannelData(channel); let maximumError = 0, peak = 0, maxErrorSample = -1;
    for (let sample = 0; sample < frames; sample++) {
      const expected = oracle.getFloat32(sample * 8 + channel * 4, true), value = actual[sample];
      assert(Number.isFinite(value), 'Nonfinite graph output'); const difference = Math.abs(value - expected);
      if (difference > maximumError) { maximumError = difference; maxErrorSample = sample; }
      peak = Math.max(peak, Math.abs(value));
      if (channel === 0 && value !== 0) { if (onset < 0) onset = sample; endExclusive = sample + 1; }
    }
    assert(maximumError <= item.absoluteTolerance, `${item.name}: channel ${channel} max error ${maximumError} at ${maxErrorSample}`);
    errors.push({ channel, maximumError, maxErrorSample }); peaks.push(peak);
  }
  if (item.expectOverOne) assert(Math.max(...peaks) > 1, 'Float headroom was clipped or normalized');
  return { name: item.name, passed: true, sampleFrames: frames, onset, endExclusive, peaks, errors, absoluteTolerance: item.absoluteTolerance,
    graphNodes: graph.nodeCount, admittedBytes: plan.memory.admittedBytes, captureReservedBytes, conservativeApplicationBytes: plan.memory.admittedBytes + captureReservedBytes };
}
/** Real production-graph regression at the floating clock boundaries used by
 * currentTime + scheduleLead. One immutable constant PCM buffer is shared; every
 * offline output allocation is reserved cumulatively before the sweep begins. */
async function fractionalOriginSweep(plan: AudioPreviewPlan): Promise<unknown> {
  const bases = [0, 128, 256, 512, 1024, 2048, 4096, 8192, 11520, 11648, 11776, 11904, 12032, 12160, 12288, 12416, 12544, 12672, 12800, 12928, 13056, 13184, 13312, 13440, 13568, 13696, 13824, 13952, 14336, 15360, 16384];
  const origins = bases.flatMap(base => [-1, 0, 1].map(ulp => ({ baseSample: base, ulp, time: base / RATE + .02 + ulp * Number.EPSILON })));
  const captureReservedBytes = origins.reduce((total, item) => total + (Math.ceil(item.time * RATE) + 32) * 8 * 2, 0);
  assert(plan.memory.admittedBytes + captureReservedBytes <= MAX_MEMORY, 'Fractional-origin capture capacity exceeded');
  const allocationContext = new OfflineAudioContext(2, 32, RATE), source = plan.sources[0];
  const buffer = allocationContext.createBuffer(2, source.sampleFrames, RATE);
  buffer.getChannelData(0).fill(.25); buffer.getChannelData(1).fill(-.125);
  const buffers = new Map([[source.sourceKey, buffer]]), probes = [];
  for (const origin of origins) {
    const context = new OfflineAudioContext(2, Math.ceil(origin.time * RATE) + 32, RATE);
    const graph = scheduleTimelineAudioPreviewGraph({ context, plan, buffers, cursorSample: 24000, originTime: origin.time });
    const rendered = await context.startRendering(); graph.stop();
    const left = rendered.getChannelData(0), right = rendered.getChannelData(1);
    const onset = left.findIndex(value => value !== 0); assert(onset >= 0, 'Fractional-origin source never started');
    let maximumError = 0;
    for (let sample = onset; sample < left.length; sample++) maximumError = Math.max(maximumError, Math.abs(left[sample] - 1), Math.abs(right[sample] + .5));
    const probe = { ...origin, originSampleFloat: origin.time * RATE, onset, maximumError,
      left: Array.from(left.subarray(onset, onset + 8)), right: Array.from(right.subarray(onset, onset + 8)) };
    probes.push(probe);
    assert(maximumError <= .000002, `Fractional-origin production gain boundary failed; probes=${JSON.stringify(probes)}; captureReservedBytes=${captureReservedBytes}`);
  }
  return { name: 'fractional-origin-gain-boundary-sweep', passed: true, probes, absoluteTolerance: .000002, captureReservedBytes,
    conservativeApplicationBytes: plan.memory.admittedBytes + captureReservedBytes, source: 'One shared immutable stereo constant buffer, two gain-two production voices; expected additive output exactly1,-0.5.' };
}
const waitUntil = async (context: AudioContext, time: number): Promise<void> => {
  const deadline = performance.now() + 3000;
  while (context.currentTime < time) { assert(context.state === 'running', 'No running realtime audio clock'); assert(performance.now() < deadline, 'Realtime audio clock failed to advance'); await new Promise(resolve => setTimeout(resolve, 4)); }
};
interface Capture { frames: number; startFrame: number; overflow: boolean; left: Float32Array; right: Float32Array }
async function realtime(plan: AudioPreviewPlan): Promise<unknown> {
  const context = new AudioContext({ sampleRate: RATE });
  assert(context.sampleRate === RATE, 'Actual realtime context is not 48 kHz');
  const captureFrames = RATE * 3, captureReservedBytes = captureFrames * 8 * 2;
  assert(plan.memory.admittedBytes + captureReservedBytes <= MAX_MEMORY, 'Realtime capture capacity exceeded');
  let transport: ReturnType<typeof createTimelineAudioPreviewTransport> | null = null;
  let recorder: AudioWorkletNode | null = null;
  try {
    await context.audioWorklet.addModule('capture-worklet.js');
    recorder = new AudioWorkletNode(context, 'sound-audition-capture', { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete', numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { frames: captureFrames } });
    recorder.connect(context.destination);
    const source = plan.sources[0]; assert(plan.sources.length === 1 && source.sampleFrames === RATE, 'Realtime fixture identity changed');
    const buffer = context.createBuffer(2, source.sampleFrames, RATE), left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    // This test-only ramp gives each source sample a decodable identity. The
    // production graph still supplies summing, scheduling, pause and seek.
    for (let index = 0; index < source.sampleFrames; index++) { left[index] = (index + 1) / RATE * .5; right[index] = -(index + 1) / RATE * .3; }
    transport = createTimelineAudioPreviewTransport({ context, plan, buffers: new Map([[source.sourceKey, buffer]]), destination: recorder });
    assert(await transport.play(), 'Realtime play was refused'); await waitUntil(context, context.currentTime + .085);
    transport.pause(); const paused = transport.getState(); assert(paused.sample > 0 && paused.sample < RATE, 'Pause did not retain an interior sample');
    await waitUntil(context, context.currentTime + .04);
    assert(await transport.play(), 'Realtime resume was refused'); await waitUntil(context, context.currentTime + .085);
    assert(transport.seek(15), 'Realtime seek was refused'); const seeked = transport.getState();
    await waitUntil(context, context.currentTime + .085); transport.pause();
    await waitUntil(context, context.currentTime + .04);
    const capture: Capture = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Realtime capture timeout')), 3000);
      recorder!.port.onmessage = event => { clearTimeout(timer); resolve(event.data as Capture); };
      recorder!.port.postMessage('capture');
    });
    assert(!capture.overflow, 'Realtime capture overflowed');
    const runs: Array<{ start: number; end: number; firstSourceSample: number; maxLeftError: number; maxRightError: number }> = [];
    for (let at = 0; at < capture.frames;) {
      if (capture.left[at] === 0 && capture.right[at] === 0) { at++; continue; }
      const start = at; while (at < capture.frames && (capture.left[at] !== 0 || capture.right[at] !== 0)) at++;
      const firstSourceSample = Math.round(capture.left[start] * RATE / 2 - 1); // Two gain-two voices = fourfold source.
      let maxLeftError = 0, maxRightError = 0;
      for (let index = start; index < at; index++) {
        const sourceSample = firstSourceSample + index - start;
        maxLeftError = Math.max(maxLeftError, Math.abs(capture.left[index] - (sourceSample + 1) / RATE * 2));
        maxRightError = Math.max(maxRightError, Math.abs(capture.right[index] + (sourceSample + 1) / RATE * 1.2));
      }
      runs.push({ start, end: at, firstSourceSample, maxLeftError, maxRightError });
    }
    assert(runs.length === 3, `Expected three isolated play/resume/seek generations, got ${runs.length}`);
    const starts = [0, paused.sample, seeked.sample];
    const diagnostic = { paused, seeked, expectedFirstSamples: starts, runs, firstSamples: runs.map(run => ({
      absoluteCaptureSample: capture.startFrame + run.start,
      left: Array.from(capture.left.subarray(run.start, run.start + 8)),
      right: Array.from(capture.right.subarray(run.start, run.start + 8)),
    })) };
    const detail = JSON.stringify(diagnostic);
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index]; assert(run.firstSourceSample === starts[index], `Realtime generation ${index} wrong first sample: ${run.firstSourceSample} != ${starts[index]}; capture=${detail}`);
      assert(run.maxLeftError < .000002 && run.maxRightError < .000002, `Realtime generation ${index} contaminated or changed gain; capture=${detail}`);
      assert(run.end - run.start > 128, 'Realtime generation too short');
      if (index > 0) assert(run.start > runs[index - 1].end, 'Replacement graph overlapped its old generation');
    }
    assert(runs[0].end - runs[0].start === paused.sample, `Pause cursor does not match exact captured source end; capture=${detail}`);
    const pausedState = transport.getState(); await transport.dispose();
    assert(context.state === 'closed', 'Owned realtime context did not close');
    return { name: 'realtime-pre-destination-play-pause-resume-seek', passed: true, actualSampleRate: context.sampleRate, captureFrames: capture.frames, captureStartFrame: capture.startFrame,
      paused, seeked, finalPause: pausedState, runs, firstSamples: diagnostic.firstSamples, captureReservedBytes, conservativeApplicationBytes: plan.memory.admittedBytes + captureReservedBytes,
      output: 'AudioWorklet captured production graph before destination; worklet output intentionally silent. Physical output/listening unclaimed.' };
  } finally { recorder?.disconnect(); recorder?.port.close(); if (transport) await transport.dispose(); else await context.close(); }
}
button.addEventListener('click', async () => {
  button.disabled = true;
  const report: { status: string; browser: string; checks: unknown[]; error?: string; note?: string } = { status: 'running', browser: navigator.userAgent, checks: [] };
  const publish = (): void => { reportNode.textContent = JSON.stringify(report, null, 2); document.body.dataset.status = report.status; };
  publish();
  try {
    const response = await fetch('fixtures.json'); const manifest = await response.json() as { cases: NumericCase[]; note: string }; report.note = manifest.note;
    for (const item of manifest.cases) { report.checks.push(await offline(item)); publish(); }
    report.checks.push(await runClientAllocationCheck(manifest)); publish();
    const item = manifest.cases.find(item => item.expectOverOne)!;
    report.checks.push(await fractionalOriginSweep(audioPreviewPlanSchema.parse(item.plan))); publish();
    report.checks.push(await realtime(audioPreviewPlanSchema.parse(item.plan))); report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = String(error instanceof Error ? error.stack : error); }
  publish(); button.disabled = false;
});
