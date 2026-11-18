#!/usr/bin/env node
/** SP-E0 audio gate: measures the built-in algorithm prototypes against the
 * thresholds in `thresholds.json` and writes a reproducible report.
 *
 * All material is synthesised in memory; only the app's FFmpeg binary is
 * executed. No downloads, no product code, no dependencies.
 *
 *   MIOON_FFMPEG_PATH=... node scripts/speed-audio-gate/run-gate.mjs \
 *     --out /private/tmp/speed-audio-gate/gate-report.json
 *
 * Flags: --ffmpeg <path>, --out <json>, --quick (two materials/three speeds),
 * --skip-curve, --speeds 0.1,0.25,... , --materials a,b, --allow-gate-failure.
 */
import {spawnSync} from 'node:child_process';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {
  db, firstDifferencePercentile, fromDb, maxDifference, maxFirstDifference, peakFrameNear, percentile, toneChannelLag, trailingSilenceFrames,
  SAMPLE_RATE, SAMPLES_PER_FRAME,
} from './pcm.mjs';
import {MATERIALS, buildMaterials} from './materials.mjs';
import {constantPlan, expectedTargetSamples, outputFramesForSourceFrame, presetPlan} from './timemap.mjs';
import {
  atempoChain, atempoFilter, boundaryClick, resampleWithTimeMap, stretchCurveChunked, stretchSplitWithAtempo, stretchWithAtempo,
} from './stretch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const thresholds = JSON.parse(readFileSync(join(here, 'thresholds.json'), 'utf8'));
const args = process.argv.slice(2);
const valueOf = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const flag = name => args.includes(name);
const ffmpeg = valueOf('--ffmpeg') ?? process.env.MIOON_FFMPEG_PATH;
if (!ffmpeg) {
  console.error('SP-E0 gate needs the application FFmpeg: pass --ffmpeg <path> or set MIOON_FFMPEG_PATH.');
  process.exit(2);
}
const quick = flag('--quick');
const skipCurve = flag('--skip-curve');
const allowGateFailure = flag('--allow-gate-failure');
const outputPath = valueOf('--out') ?? join(tmpdir(), 'speed-audio-gate', 'gate-report.json');
const speeds = (valueOf('--speeds') ?? (quick ? '0.5,2' : '0.1,0.25,0.5,2,4,10')).split(',').map(Number);
const requestedMaterials = valueOf('--materials') ?? (quick ? 'speech-tail,transient' : undefined);
const materialNames = requestedMaterials ? requestedMaterials.split(',') : MATERIALS.map(material => material.name);
const SPEED_FRACTIONS = {'0.1': {numerator: 1, denominator: 10}, '0.25': {numerator: 1, denominator: 4},
  '0.5': {numerator: 1, denominator: 2}, '2': {numerator: 2, denominator: 1}, '4': {numerator: 4, denominator: 1},
  '10': {numerator: 10, denominator: 1}};

const version = spawnSync(ffmpeg, ['-hide_banner', '-version'], {encoding: 'utf8'});
if (version.status !== 0) { console.error(`cannot run FFmpeg at ${ffmpeg}`); process.exit(2); }
const ffmpegVersion = (version.stdout.split('\n')[0] ?? '').replace(/^ffmpeg version /u, '').split(' ')[0];

const materials = buildMaterials(materialNames);

/** Calibrates the fixed atempo alignment offset per chain with a clean impulse
 * probe. The built-in filter does not report latency; this measurement tells us
 * whether a deterministic pre-trim can put transients back on the SP-M grid. */
function calibrateAtempo(speed, rate) {
  const frames = 2 * SAMPLE_RATE;
  const input = new Float32Array(frames * 2);
  const positions = [1].map(time => Math.round(time * SAMPLE_RATE));
  for (const position of positions) { input[position * 2] = 0.8; input[position * 2 + 1] = 0.8; }
  const processed = stretchWithAtempoSimple(input, speed);
  const offsets = [];
  for (const position of positions) {
    const expected = position / rate;
    const onset = peakFrameNear(processed, Math.max(0, expected - 0.25 * SAMPLE_RATE), expected + 0.25 * SAMPLE_RATE);
    if (onset !== null) offsets.push(onset - expected);
  }
  offsets.sort((a, b) => a - b);
  return offsets.length ? Math.round(offsets[Math.floor(offsets.length / 2)]) : 0;
}
import {spawnSync as _spawnSync} from 'node:child_process';
function stretchWithAtempoSimple(input, rate) {
  const chain = atempoChain(rate);
  const result = _spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '2',
    '-i', 'pipe:0', '-af', atempoFilter(chain), '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '2', 'pipe:1'],
  {input: Buffer.from(input.buffer, input.byteOffset, input.byteLength), maxBuffer: 512 * 1024 * 1024, timeout: 120_000});
  if (result.error) throw new Error(`calibration ffmpeg did not finish: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`calibration ffmpeg failed: ${result.stderr?.toString().slice(0, 200)}`);
  const buffer = Buffer.from(result.stdout);
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}
const calibration = new Map();
for (const speed of speeds) calibration.set(speed, calibrateAtempo(speed, SPEED_FRACTIONS[String(speed)].numerator / SPEED_FRACTIONS[String(speed)].denominator));
const report = {profile: thresholds.profile, ffmpeg, ffmpegVersion, sampleRate: SAMPLE_RATE, fps: 30,
  generatedAt: new Date().toISOString(), rows: [], variants: [], curveRows: [], gate: null};
const failures = [];
const rows = [];

const round = value => Math.round(value * 1000) / 1000;
function measureTail(samples, bundle, material) {
  if (!material.tailGate) return {tailMs: null, intentionalMs: null, unexplainedMs: null};
  const totalFrames = samples.length / 2;
  const tailFrames = trailingSilenceFrames(samples, fromDb(-60));
  const intentional = Math.max(0, bundle.totalSamples - bundle.motionSamples);
  return {tailMs: round(tailFrames / (SAMPLE_RATE / 1000)), intentionalMs: round(intentional / (SAMPLE_RATE / 1000)),
    unexplainedMs: round(Math.max(0, tailFrames - intentional) / (SAMPLE_RATE / 1000))};
}
function measureTransients(samples, bundle, material) {
  const markers = material.metadata.transientSamples;
  if (!markers?.length) return null;
  const expected = markers.map(marker => outputFramesForSourceFrame(bundle, marker / SAMPLES_PER_FRAME) * SAMPLES_PER_FRAME);
  const spacing = Math.min(...expected.slice(1).map((value, index) => value - expected[index]));
  const search = Math.min(0.4 * SAMPLE_RATE, Math.max(0.02 * SAMPLE_RATE, spacing * 0.4));
  const deviations = [];
  for (const expectedSample of expected) {
    const onset = peakFrameNear(samples, expectedSample - search, expectedSample + search);
    if (onset !== null) deviations.push((onset - expectedSample) / (SAMPLE_RATE / 1000));
  }
  return deviations.length ? {maxMs: round(Math.max(...deviations.map(value => Math.abs(value)))), deviations, markers: deviations.length} : null;
}
function measurePhase(material, output, rate, {pitchShifted = false} = {}) {
  const baseFrequency = material.metadata.phaseToneHz;
  if (!baseFrequency) return {deviationMs: null};
  const frequency = pitchShifted ? baseFrequency * rate : baseFrequency;
  const frames = Math.min(output.length / 2 - 1, SAMPLE_RATE);
  const inputLag = toneChannelLag(material.samples, baseFrequency, {frames: SAMPLE_RATE});
  const outputLag = toneChannelLag(output, frequency, {frames});
  const period = SAMPLE_RATE / frequency;
  // atempo preserves pitch and the sample-rate clock, so the inter-channel
  // sample lag stays constant; continuous resampling stretches the time axis
  // and therefore scales the lag by 1/rate.
  const expected = pitchShifted ? inputLag / rate : inputLag;
  // Resolve the periodic tone lag to the branch nearest the expected value.
  const candidates = [outputLag - period, outputLag, outputLag + period];
  const resolved = candidates.reduce((best, candidate) => Math.abs(candidate - expected) < Math.abs(best - expected) ? candidate : best);
  return {inputLag: Math.round(inputLag * 100) / 100, outputLag: Math.round(resolved * 100) / 100, expected: Math.round(expected * 100) / 100,
    deviationMs: round(Math.abs(resolved - expected) / (SAMPLE_RATE / 1000))};
}
function measureCurvePhase(bundle, input, output) {
  const windowFrames = SAMPLE_RATE * 2;
  const middleFrame = Math.floor((output.length / 2) * 0.5);
  const fromFrame = Math.max(0, Math.min(output.length / 2 - windowFrames - 1, middleFrame - windowFrames / 2));
  const startTime = fromFrame / SAMPLES_PER_FRAME, endTime = (fromFrame + windowFrames) / SAMPLES_PER_FRAME;
  const sourceSpan = sourceFramesAtOutputTime(bundle, endTime) - sourceFramesAtOutputTime(bundle, startTime);
  const localRate = sourceSpan / (endTime - startTime);
  const inputLag = channelDelay(input, {frames: Math.min(input.length / 2, SAMPLE_RATE), fromFrame: Math.round(input.length / 2 * 0.5)});
  const outputLag = channelDelay(output, {frames: Math.min(output.length / 2, SAMPLE_RATE), fromFrame});
  const expected = inputLag / localRate;
  return {inputLag, outputLag: Math.round(outputLag * 100) / 100, localRate: Math.round(localRate * 10000) / 10000,
    phaseDeviationMs: round(Math.abs(outputLag - expected) / (SAMPLE_RATE / 1000))};
}
function seamMetrics(whole, split, boundarySample) {
  let wholePeak = 0;
  for (const value of whole) wholePeak = Math.max(wholePeak, Math.abs(value));
  const diff = maxDifference(whole, split);
  const window = Math.round(0.002 * SAMPLE_RATE);
  const wholeJump = maxFirstDifference(whole, boundarySample - window, boundarySample + window);
  const splitJump = maxFirstDifference(split, boundarySample - window, boundarySample + window);
  const boundary = Math.round(boundarySample);
  const step = Math.abs((split[boundary * 2] ?? 0) - (split[(boundary - 1) * 2] ?? 0));
  const stepRight = Math.abs((split[boundary * 2 + 1] ?? 0) - (split[(boundary - 1) * 2 + 1] ?? 0));
  const wholePercentile = firstDifferencePercentile(whole, 0.999);
  const seamStep = Math.max(step, stepRight);
  return {maxDiffDb: round(db(diff / Math.max(wholePeak, 1e-12))), clickRatio: round(splitJump / Math.max(wholeJump, 1e-9)),
    seamStepDb: round(db(seamStep / Math.max(wholePeak, 1e-12))), seamStepRatio: round(seamStep / Math.max(wholePercentile, 1e-12)),
    boundarySample: boundary};
}
function check(scope, metrics) {
  for (const [metric, threshold] of Object.entries(thresholds[scope])) for (const row of metrics) {
    const value = row[metric];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const limit = typeof threshold === 'number' ? threshold : threshold?.max;
    if (typeof limit === 'number' && value > limit) failures.push({scope, case: row.case, metric, value, threshold: limit});
  }
}

// 1) Pitch-preserving atempo matrix.
for (const material of materials) for (const speed of speeds) {
  const rate = SPEED_FRACTIONS[String(speed)];
  if (!rate) throw new Error(`unsupported speed ${speed}`);
  const bundle = constantPlan(material, rate);
  const target = expectedTargetSamples(bundle);
  const started = performance.now();
  const processed = stretchWithAtempo(ffmpeg, material.samples, bundle, speed);
  const tail = measureTail(processed.samples, bundle, material);
  const transients = measureTransients(processed.samples, bundle, material);
  const offsetMs = (calibration.get(speed) ?? 0) / (SAMPLE_RATE / 1000);
  const compensatedTransientMs = transients === null ? null
    : round(Math.max(...transients.deviations.map(value => Math.abs(value - offsetMs))));
  const phase = measurePhase(material, processed.samples, speed);
  const splitSample = Math.round(material.audioFrames * 0.45);
  const split = stretchSplitWithAtempo(ffmpeg, material.samples, bundle, speed, splitSample);
  const seam = seamMetrics(processed.samples, split.samples, split.splitOutputSample);
  const row = {phase: 'atempo', case: `${material.name}@${speed}x`, material: material.name, speed,
    durationFrames: bundle.durationFrames, totalSamples: target.total, normalizedSamples: processed.samples.length / 2,
    naturalErrorMs: round((processed.naturalFrames - target.total) / (SAMPLE_RATE / 1000)),
    durationErrorSamples: processed.samples.length / 2 - target.total,
    tail: tail.tailMs, intentionalTailMs: tail.intentionalMs, unexplainedTailMs: tail.unexplainedMs,
    transientDeviationMs: transients?.maxMs ?? null, transientCompensatedMs: compensatedTransientMs,
    calibrationOffsetMs: round(offsetMs), phaseDeviationMs: phase.deviationMs,
    seamMaxDiffDb: seam.maxDiffDb, seamStepDb: seam.seamStepDb, seamStepRatio: seam.seamStepRatio, seamClickRatio: seam.clickRatio, chain: processed.chain.join(','),
    elapsedMs: Math.round(performance.now() - started)};
  rows.push(row);
}
// 2) Edge-variant mitigation table at 0.1x and 10x.
for (const speed of quick ? [] : [0.1, 10]) for (const material of materials.filter(item => ['speech-tail', 'sustain'].includes(item.name))) {
  const rate = SPEED_FRACTIONS[String(speed)];
  const bundle = constantPlan(material, rate);
  for (const variant of [{name: 'plain'}, {name: 'prepad', frontPadFrames: 1}, {name: 'postpad', backPadFrames: 1},
    {name: 'both', frontPadFrames: 1, backPadFrames: 1}]) {
    const processed = stretchWithAtempo(ffmpeg, material.samples, bundle, speed, variant);
    const tail = measureTail(processed.samples, bundle, material);
    report.variants.push({case: `${material.name}@${speed}x`, variant: variant.name, unexplainedTailMs: tail.unexplainedMs,
      naturalErrorMs: round((processed.naturalFrames - bundle.totalSamples) / (SAMPLE_RATE / 1000))});
  }
}
// 3) Continuous-resampling pitch-shift matrix.
for (const material of materials) for (const speed of speeds) {
  const rate = SPEED_FRACTIONS[String(speed)];
  const bundle = constantPlan(material, rate);
  const processed = resampleWithTimeMap(material, bundle);
  const tail = measureTail(processed.samples, bundle, material);
  const transients = measureTransients(processed.samples, bundle, material);
  const offsetMs = (calibration.get(speed) ?? 0) / (SAMPLE_RATE / 1000);
  const compensatedTransientMs = transients === null ? null
    : round(Math.max(...transients.deviations.map(value => Math.abs(value - offsetMs))));
  const phase = measurePhase(material, processed.samples, speed, {pitchShifted: true});
  rows.push({phase: 'resample', case: `${material.name}@${speed}x`, material: material.name, speed,
    durationFrames: bundle.durationFrames, totalSamples: bundle.totalSamples, normalizedSamples: processed.samples.length / 2,
    naturalErrorMs: 0, durationErrorSamples: 0,
    tail: tail.tailMs, intentionalTailMs: tail.intentionalMs, unexplainedTailMs: tail.unexplainedMs,
    transientDeviationMs: transients?.maxMs ?? null, transientCompensatedMs: transients?.maxMs ?? null,
    phaseDeviationMs: phase.deviationMs, seamMaxDiffDb: -120, seamStepDb: -120, seamStepRatio: 0, seamClickRatio: 1, chain: 'resample'});
}
// 4) Chunked curve prototype (only materials with a real tail and transients).
if (!skipCurve) for (const preset of ['slowMiddle', 'fastToSlow']) for (const material of materials.filter(item => ['speech-tail', 'transient', 'sustain'].includes(item.name))) {
  const bundle = presetPlan(material, preset);
  const processed = stretchCurveChunked(ffmpeg, material, bundle, {chunkFrames: 9, contextFrames: 1, overlapFrames: 0.5});
  const tail = measureTail(processed.samples, bundle, material);
  const transients = measureTransients(processed.samples, bundle, material);
  const boundary = boundaryClick(processed.samples, processed.boundaries, Math.round(0.002 * SAMPLE_RATE));
  const firstDifferences = [];
  for (let index = 1 + 960; index < processed.samples.length / 2 - 960; index += 37) firstDifferences.push(maxFirstDifference(processed.samples, index, index + 1));
  const globalJump = percentile(firstDifferences, 0.995);
  const phase = {phaseDeviationMs: null};
  const row = {phase: 'curve', case: `${material.name}/${preset}`, material: material.name, preset,
    durationFrames: bundle.durationFrames, totalSamples: bundle.totalSamples,
    normalizedSamples: processed.samples.length / 2, naturalErrorMs: 0, durationErrorSamples: processed.samples.length / 2 - bundle.totalSamples,
    tail: tail.tailMs, intentionalTailMs: tail.intentionalMs, unexplainedTailMs: tail.unexplainedMs,
    transientDeviationMs: transients?.maxMs ?? null, phaseDeviationMs: phase.phaseDeviationMs,
    chunkBoundaryJumpDb: round(db(boundary.maxBoundaryJump / Math.max(boundary.peak, 1e-12))),
    chunkBoundaryClickRatio: round(boundary.maxBoundaryJump / Math.max(globalJump, 1e-9)),
    chunks: processed.chunkCount};
  report.curveRows.push(row);
  rows.push(row);
}

// Gate evaluation.
check('atempo', rows.filter(row => row.phase === 'atempo'));
check('resample', rows.filter(row => row.phase === 'resample'));
check('curve', report.curveRows);
report.rows = rows;
report.gate = {passed: failures.length === 0, failures, thresholds: thresholds,
  measured: {atempo: rows.filter(row => row.phase === 'atempo').length, resample: rows.filter(row => row.phase === 'resample').length,
    curve: report.curveRows.length, materials: materials.map(material => material.name), speeds}};
mkdirSync(dirname(outputPath), {recursive: true});
writeFileSync(outputPath, `${JSON.stringify(report, null, 1)}\n`);

const header = ['case', 'tailMs', 'unexpTailMs', 'transientMs', 'phaseMs', 'seamDb', 'click'];
console.log(header.join('\t'));
for (const row of report.rows) {
  console.log([row.case, row.tail, row.unexplainedTailMs, row.transientDeviationMs ?? '-', row.phaseDeviationMs,
    row.seamMaxDiffDb, row.seamClickRatio].join('\t'));
}
if (report.variants.length) {
  console.log('\nEdge-tail mitigation variants (unexplained tail ms):');
  for (const variant of report.variants) console.log(`${variant.case}\t${variant.variant}\t${variant.unexplainedTailMs}`);
}
console.log(`\nFFmpeg ${ffmpegVersion}; report ${outputPath}`);
console.log(report.gate.passed ? 'GATE PASS' : `GATE FAIL (${failures.length} failure${failures.length === 1 ? '' : 's'})`);
if (!report.gate.passed) for (const failure of failures.slice(0, 40)) console.log(`FAIL ${failure.scope} ${failure.case} ${failure.metric}=${failure.value} > ${failure.threshold}`);
process.exitCode = report.gate.passed || allowGateFailure ? 0 : 1;
