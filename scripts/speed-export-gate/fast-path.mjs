import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {appendFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  compileTimeMap, initialTimeMap, splitTimeMap, timeMapPlanFrames, timeMapRootFrames,
  timeMapSourceAtOutputFrame,
} from '../../packages/contracts/src/timeline-time-map.ts';

const outputFps = 30;
const frameSize = 16 * 16;
const speeds = [[1, 10], [1, 4], [1, 2], [11, 10], [3, 2], [2, 1], [4, 1], [10, 1]];
const directions = ['forward', 'reverse'];
const threshold = {differingFrames: 0, absoluteFrameCountError: 0};

function unwrap(result) {
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
  return result.value;
}

function execute(executable, label, args, cwd, log) {
  const result = spawnSync(executable, args, {cwd, maxBuffer: 2 * 1024 * 1024});
  appendFileSync(log, `${label} ${JSON.stringify(args)}\n${result.stderr?.toString() ?? ''}`);
  if (result.error || result.status !== 0) throw new Error(`${label} failed; see commands.log`);
  return result.stdout;
}

function sourceFixture(ff, probe, name, fps, frames, variable) {
  const file = `${name}.nut`;
  // The gray plane carries the actual source ordinal in every pixel. Give VFR
  // three distinct presentation spacings and a last frame on the nominal clock.
  const stamp = variable ? `,settb=1/300,setpts='N*10+if(eq(N,${frames - 1}),0,if(eq(mod(N,3),1),-2,3*eq(mod(N,3),2)))'` : '';
  ff(['-filter_threads', '1', '-f', 'lavfi', '-i', `nullsrc=size=16x16:rate=${fps}`,
    '-vf', `format=gray,geq=lum=N${stamp}`, '-frames:v', String(frames), '-fps_mode', 'passthrough',
    '-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', 'gray', '-enc_time_base', `1/${variable ? 300 : fps}`, file]);
  const reported = JSON.parse(probe(['-select_streams', 'v:0', '-show_frames', '-show_streams',
    '-show_entries', 'stream=time_base:frame=pts', '-of', 'json', file]));
  const [timeNumerator, timeDenominator] = reported.streams[0].time_base.split('/').map(Number);
  const pts = reported.frames.map(frame => frame.pts);
  assert.equal(pts.length, frames);
  assert.equal(pts[0], 0);
  assert(pts.every((value, index) => Number.isSafeInteger(value) && (!index || value > pts[index - 1])));
  const exactCfr = pts.every((value, index) => value * timeNumerator * fps === index * timeDenominator);
  assert.equal(exactCfr, !variable);
  return {file, fps, frames, variable, pts, timeNumerator, timeDenominator};
}

function rational(frame) {
  return {kind: 'rational', numerator: String(frame), denominator: '1'};
}

function compile(fps, start, end, p, q) {
  return unwrap(compileTimeMap({
    profile: 'timeline-speed-v1',
    sourceFps: {fpsNumerator: fps, fpsDenominator: 1},
    outputFps: {fpsNumerator: outputFps, fpsDenominator: 1},
    sourceRange: {start: rational(start), end: rational(end)},
    speed: {kind: 'constant', rate: {numerator: p, denominator: q}},
  }));
}

function vfrOrdinal(source, position, direction) {
  // Apply the shared continuous position to the presentation index with exact
  // comparisons. Reverse takes the left limit at a PTS tie.
  assert.equal(position.kind, 'exact');
  const at = BigInt(position.numerator) * BigInt(source.timeDenominator);
  const frameClockScale = BigInt(position.denominator) * BigInt(source.fps) * BigInt(source.timeNumerator);
  let low = 0;
  let high = source.pts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const stamp = BigInt(source.pts[middle]) * frameClockScale;
    if (stamp < at || (stamp === at && direction === 'forward')) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function expectedFrames(source, plan) {
  const frames = [...unwrap(timeMapPlanFrames(plan))];
  if (!source.variable) return frames;
  // For VFR these frame positions belong to the nominal source clock; the
  // frame actually presented there comes from the demuxed PTS index.
  return frames.map((_, j) => vfrOrdinal(source, unwrap(timeMapSourceAtOutputFrame(plan, j)).source, plan.direction));
}

function readFrames(ff, file, filter) {
  const pixels = ff(['-filter_threads', '1', '-i', file, '-vf', filter, '-an',
    '-fps_mode', 'passthrough', '-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
  assert.equal(pixels.length % frameSize, 0, 'partial decoded frame');
  const ids = [];
  for (let offset = 0; offset < pixels.length; offset += frameSize) {
    const id = pixels[offset];
    assert(pixels.subarray(offset, offset + frameSize).every(value => value === id), 'invalid source ordinal');
    ids.push(id);
  }
  return ids;
}

function sourceFilter({source, p, q, start, end, direction, clock}) {
  const filters = [];
  if (start !== 0 || end !== source.frames) filters.push(`trim=start_frame=${start}:end_frame=${end}`);
  if (direction === 'reverse') filters.push('reverse');
  filters.push(`settb=expr=1/(${clock}*${p})`, `setpts=(PTS-STARTPTS)*${q}/${p}`, `fps=${outputFps}:round=up`);
  return filters.join(',');
}

function compare(actual, expected) {
  let differingFrames = 0;
  let differingSharedFrames = 0;
  const firstMismatches = [];
  for (let frame = 0; frame < Math.max(actual.length, expected.length); frame++) {
    if (actual[frame] === expected[frame]) continue;
    differingFrames++;
    if (frame < actual.length && frame < expected.length) differingSharedFrames++;
    if (firstMismatches.length < 8) firstMismatches.push({frame, actual: actual[frame] ?? null, expected: expected[frame] ?? null});
  }
  const absoluteFrameCountError = Math.abs(actual.length - expected.length);
  return {pass: differingFrames <= threshold.differingFrames && absoluteFrameCountError <= threshold.absoluteFrameCountError,
    differingFrames, differingSharedFrames, absoluteFrameCountError, firstMismatches, actualFrames: actual.length, expectedFrames: expected.length};
}

function summarize(rows) {
  return {
    cases: rows.length,
    passed: rows.filter(row => row.pass).length,
    differingFrames: rows.reduce((sum, row) => sum + row.differingFrames, 0),
    maxAbsoluteFrameCountError: Math.max(...rows.map(row => row.absoluteFrameCountError)),
    expectedFrames: rows.reduce((sum, row) => sum + row.expectedFrames, 0),
  };
}

export async function runFastPath({ffmpeg, ffprobe, scratchDir, evidenceDir}) {
  const log = join(evidenceDir, 'commands.log');
  const ff = args => execute(ffmpeg, 'ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', ...args], scratchDir, log);
  const probe = args => execute(ffprobe, 'ffprobe', ['-hide_banner', '-v', 'error', ...args], scratchDir, log);
  const inputs = [24, 25, 30, 60].flatMap(fps => [
    {source: sourceFixture(ff, probe, `cfr-${fps}-120`, fps, 120, false), start: 0, end: 120},
    {source: sourceFixture(ff, probe, `cfr-${fps}-125`, fps, 125, false), start: 3, end: 124},
  ]);
  inputs.push({source: sourceFixture(ff, probe, 'vfr-30', 30, 120, true), start: 0, end: 120});

  const rows = [];
  for (const {source, start, end} of inputs) {
    for (const [p, q] of speeds) {
      const root = compile(source.fps, start, end, p, q);
      for (const direction of directions) {
        const plan = initialTimeMap(root, direction);
        assert.deepEqual(unwrap(timeMapPlanFrames(plan)), unwrap(timeMapRootFrames(root, direction)));
        const whole = expectedFrames(source, plan);
        const cut = 1;
        const right = expectedFrames(source, unwrap(splitTimeMap(plan, cut)).right);
        assert.deepEqual(right, whole.slice(cut));
        const options = {source, p, q, start, end, direction};
        const clockFilter = sourceFilter({...options, clock: source.fps});
        const reset = direction === 'forward' ? {start: right[0]} : {end: right[0] + 1};
        const alignedCut = !source.variable && (cut * source.fps * p) % (outputFps * q) === 0;
        const variants = [
          ['section-3.1-whole', sourceFilter({...options, clock: outputFps}), whole],
          ['source-clock-whole', clockFilter, whole],
          ['reset-right', sourceFilter({...options, ...reset, clock: source.fps}), right],
          ['root-window-right', `${clockFilter},trim=start_frame=${cut},setpts=PTS-STARTPTS`, right],
        ];
        for (const [variant, filter, expected] of variants) {
          const actual = readFrames(ff, source.file, filter);
          rows.push({variant, sourceFile: source.file, sourceFps: source.fps, variable: source.variable,
            sourceRange: [start, end], rate: [p, q], direction,
            ...(variant.endsWith('-right') ? {cut, alignedCut} : {}), filter, ...compare(actual, expected), actual, expected});
        }
      }
    }
  }
  const summary = {};
  for (const variant of new Set(rows.map(row => row.variant))) {
    const matrix = rows.filter(row => row.variant === variant);
    summary[variant] = {};
    for (const kind of ['24', '25', '30', '60', 'vfr']) {
      const group = matrix.filter(row => (row.variable ? 'vfr' : String(row.sourceFps)) === kind);
      summary[variant][kind] = Object.fromEntries(directions.map(direction =>
        [direction, summarize(group.filter(row => row.direction === direction))]));
    }
  }
  const proposed = rows.filter(row => !row.variable && row.direction === 'forward' &&
    (row.variant === 'source-clock-whole' || row.variant === 'root-window-right'));
  const reversalControl = rows.filter(row => !row.variable && row.direction === 'reverse' &&
    (row.variant === 'source-clock-whole' || row.variant === 'root-window-right'));
  const resetCfr = rows.filter(row => row.variant === 'reset-right' && !row.variable);
  const alignedResets = resetCfr.filter(row => row.alignedCut);
  const resetExample = rows.find(row => row.variant === 'reset-right' && row.sourceFile === 'cfr-30-120.nut' &&
    row.direction === 'forward' && row.rate[0] === 3 && row.rate[1] === 2);
  assert(resetExample);
  writeFileSync(join(evidenceDir, 'matrix.json'), JSON.stringify({threshold, inputs, rows}, null, 2) + '\n');
  return {
    pass: proposed.every(row => row.pass) && alignedResets.every(row => row.pass),
    threshold,
    proposed: summarize(proposed),
    reversalControl: summarize(reversalControl),
    rightResetByPhase: {
      aligned: summarize(alignedResets),
      fractional: summarize(resetCfr.filter(row => !row.alignedCut)),
    },
    unrestricted: summarize(rows),
    rightResetExample: compare(resetExample.actual, resetExample.expected),
    summary,
    evidence: 'matrix.json',
  };
}
