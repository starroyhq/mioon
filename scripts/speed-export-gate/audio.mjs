import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { timelineCompositionSegments } from '../../packages/contracts/src/timeline-segments.ts';
import { timeMapTailInverse } from '../../packages/contracts/src/timeline-time-map.ts';
import {
  firstDifferencePercentile, maxFirstDifference, peak, PROJECT_FPS, SAMPLE_RATE, SAMPLES_PER_FRAME, trailingSilenceFrames,
} from '../speed-audio-gate/pcm.mjs';
import { atempoChain, atempoFilter } from '../speed-audio-gate/stretch.mjs';
import { constantPlan, presetPlan } from '../speed-audio-gate/timemap.mjs';

const CHANNELS = 2;
const BYTES_PER_SAMPLE = CHANNELS * Float32Array.BYTES_PER_ELEMENT;
const SOURCE_FRAMES = 193;
const FREEZE_FRAMES = 60;
const SEAM_RADIUS = 96; // ±2 ms, as in SP-E0.
const THRESHOLDS = {
  sampleCountError: 0,
  differingSamples: 0,
  boundaryStepError: 0,
  freezeNonZeroSamples: 0,
  freezePeak: 0,
  previousSeamRatio: 2,
  previousUnexpectedTailSilenceMs: 20,
};
const MATERIALS = {
  'stereo-chirp': '0.24*sin(2*PI*(173*t+23*t*t))+0.08*sin(2*PI*733*t)'
    + '|0.21*sin(2*PI*(173*(t-0.0005)+23*(t-0.0005)^2))+0.07*sin(2*PI*353*t)',
  'stereo-pulses': '0.13*sin(2*PI*227*t)+0.31*exp(-170*mod(t,0.437))*sin(2*PI*1099*t)'
    + '|0.11*sin(2*PI*301*t)+0.29*exp(-210*mod(t+0.073,0.511))*sin(2*PI*1289*t)',
};

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sampleCount = bytes => {
  if (bytes.length % BYTES_PER_SAMPLE !== 0) throw new Error('Unaligned stereo PCM output');
  return bytes.length / BYTES_PER_SAMPLE;
};
const floats = bytes => new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / Float32Array.BYTES_PER_ELEMENT);
const samplesToBytes = samples => Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
const pcmInput = file => ['-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', file];
const pcmOutput = ['-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'];

function ffmpegCommand(ffmpeg, cwd, label, args, input) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    cwd, input, maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
  });
  if (run.error || run.status !== 0) {
    throw new Error(`${label}: FFmpeg failed (${run.error?.code ?? run.signal ?? run.status})\n${run.stderr?.toString() ?? ''}`);
  }
  return run.stdout;
}

function makeSource(ffmpeg, cwd, material) {
  const source = ffmpegCommand(ffmpeg, cwd, material, [
    '-f', 'lavfi', '-i', `aevalsrc=exprs='${MATERIALS[material]}':sample_rate=${SAMPLE_RATE}:channel_layout=stereo`,
    '-af', `atrim=end_sample=${SOURCE_FRAMES * SAMPLES_PER_FRAME}`, ...pcmOutput,
  ]);
  if (sampleCount(source) !== SOURCE_FRAMES * SAMPLES_PER_FRAME) throw new Error('Unexpected source sample count');
  return source;
}

function windowsFor(outputFrames) {
  const cuts = Array.from({ length: 5 }, (_, index) => Math.floor(outputFrames * index / 4));
  const clips = cuts.slice(1).map((end, index) => ({ startFrame: cuts[index], durationFrames: end - cuts[index] }));
  return timelineCompositionSegments({ durationFrames: outputFrames, clips }).map(({ beginFrame, endFrame }) => ({
    from: beginFrame * SAMPLES_PER_FRAME, to: endFrame * SAMPLES_PER_FRAME,
  }));
}

function comparison(whole, parts, joined, windows) {
  const wholeSamples = sampleCount(whole);
  const joinedSamples = sampleCount(joined);
  const joinedValues = floats(joined);
  const wholeValues = floats(whole);
  const segmentSamples = parts.map(sampleCount);
  const expectedSegmentSamples = windows.map(({ from, to }) => to - from);
  const sampleCountError = Math.max(Math.abs(joinedSamples - expectedSegmentSamples.reduce((sum, length) => sum + length, 0)),
    Math.abs(joinedSamples - wholeSamples), ...segmentSamples.map((length, index) => Math.abs(length - expectedSegmentSamples[index])));
  let differingSamples = Math.abs(wholeSamples - joinedSamples);
  let maxAbsoluteDifference = 0;
  for (let sample = 0; sample < Math.min(wholeSamples, joinedSamples); sample++) {
    const byte = sample * BYTES_PER_SAMPLE;
    if (whole.readBigUInt64LE(byte) !== joined.readBigUInt64LE(byte)) differingSamples++;
    for (let channel = 0; channel < CHANNELS; channel++) {
      const index = sample * CHANNELS + channel;
      maxAbsoluteDifference = Math.max(maxAbsoluteDifference, Math.abs(wholeValues[index] - joinedValues[index]));
    }
  }
  const globalJump = firstDifferencePercentile(wholeValues, 0.999);
  const boundaries = windows.slice(1).map(({ from: sample }) => {
    const windowStart = (sample - SEAM_RADIUS) * BYTES_PER_SAMPLE;
    const windowEnd = (sample + SEAM_RADIUS) * BYTES_PER_SAMPLE;
    const windowEqual = whole.subarray(windowStart, windowEnd).equals(joined.subarray(windowStart, windowEnd));
    const joinedSteps = [];
    const stepErrors = Array.from({ length: CHANNELS }, (_, channel) => {
      const index = sample * CHANNELS + channel;
      const wholeStep = wholeValues[index] - wholeValues[index - CHANNELS];
      const joinedStep = joinedValues[index] - joinedValues[index - CHANNELS];
      joinedSteps.push(Math.abs(joinedStep));
      return Math.abs(wholeStep - joinedStep);
    });
    const wholeJump = maxFirstDifference(wholeValues, sample - SEAM_RADIUS, sample + SEAM_RADIUS);
    const joinedJump = maxFirstDifference(joinedValues, sample - SEAM_RADIUS, sample + SEAM_RADIUS);
    return { sample, windowEqual, stepError: Math.max(...stepErrors),
      previousClickRatio: joinedJump / Math.max(wholeJump, 1e-9),
      previousSeamStepRatio: Math.max(...joinedSteps) / Math.max(globalJump, 1e-12) };
  });
  const wholeSha256 = hash(whole);
  const joinedSha256 = hash(joined);
  return { wholeSamples, joinedSamples, sampleCountError, segmentSamples, expectedSegmentSamples, differingSamples,
    maxAbsoluteDifference, wholeSha256, joinedSha256, boundaries,
    pass: sampleCountError <= THRESHOLDS.sampleCountError && differingSamples <= THRESHOLDS.differingSamples
      && wholeSha256 === joinedSha256
      && boundaries.every(boundary => boundary.windowEqual && boundary.stepError <= THRESHOLDS.boundaryStepError) };
}

// Exercise the export's PCM-in-MOV, ordered-concat layout with the audio stream alone.
// The window renderer can consume one shared PCM producer or render exact windows independently.
function exportWindows(ffmpeg, cwd, label, windows, whole, renderWindow) {
  const wholeFile = `${label}-input.f32le`;
  writeFileSync(join(cwd, wholeFile), whole, { flag: 'wx' });
  const wholePcm = ffmpegCommand(ffmpeg, cwd, `${label} whole`, [...pcmInput(wholeFile), ...pcmOutput]);
  const parts = [];
  const list = [];
  for (const [index, window] of windows.entries()) {
    const file = `${label}-${index}.mov`;
    const { bytes, from, to } = renderWindow?.(window) ?? { bytes: whole, ...window };
    // atrim may stop reading early, so a segment sharing the full PCM reads
    // a bounded regular file instead of closing a still-fed stdin pipe.
    const shared = bytes === whole;
    ffmpegCommand(ffmpeg, cwd, `${label} segment ${index}`, [
      ...pcmInput(shared ? wholeFile : 'pipe:0'), '-af', `atrim=start_sample=${from}:end_sample=${to},asetpts=N/SR/TB`,
      '-c:a', 'pcm_f32le', file,
    ], shared ? undefined : bytes);
    parts.push(ffmpegCommand(ffmpeg, cwd, `${label} decode ${index}`, ['-i', file, ...pcmOutput]));
    const duration = ((window.to - window.from) / SAMPLES_PER_FRAME / PROJECT_FPS).toFixed(9);
    list.push(`file '${file}'\nduration ${duration}`);
  }
  const listFile = `${label}.ffconcat`;
  writeFileSync(join(cwd, listFile), `ffconcat version 1.0\n${list.join('\n')}\n`, { flag: 'wx' });
  const joined = ffmpegCommand(ffmpeg, cwd, `${label} concat`, [
    '-f', 'concat', '-safe', '1', '-i', listFile, '-af', 'asetpts=N/SR/TB', ...pcmOutput,
  ]);
  return { result: comparison(wholePcm, parts, joined, windows), joined };
}

// SP-E0 uses cubic interpolation; use the root sample clock for every segment.
function cubicSample(source, position, channel) {
  const index = Math.floor(position);
  const fraction = position - index;
  const read = offset => source[Math.max(0, Math.min(source.length / CHANNELS - 1, index + offset)) * CHANNELS + channel];
  const [p0, p1, p2, p3] = [read(-1), read(0), read(1), read(2)];
  return 0.5 * (2 * p1 + fraction * ((-p0 + p2) + fraction * ((2 * p0 - 5 * p1 + 4 * p2 - p3)
    + fraction * (-p0 + 3 * p1 - 3 * p2 + p3))));
}

function resampleWindow(source, bundle, { from, to }) {
  const output = new Float32Array((to - from) * CHANNELS);
  for (let sample = from; sample < Math.min(to, bundle.motionSamples); sample++) {
    let sourcePosition = sample * bundle.rate;
    if (bundle.kind === 'curve') {
      const result = timeMapTailInverse(bundle.plan, { numerator: String(sample), denominator: String(SAMPLES_PER_FRAME) },
        { tailInverse: 'latest' });
      if (!result.ok || result.value.tail || result.value.position.kind !== 'numeric') {
        throw new Error(`Shared curve inverse failed for output sample ${sample}: ${result.code ?? 'unexpected position'}`);
      }
      sourcePosition = result.value.position.value * SAMPLES_PER_FRAME;
    }
    for (let channel = 0; channel < CHANNELS; channel++) {
      output[(sample - from) * CHANNELS + channel] = cubicSample(source, sourcePosition, channel);
    }
  }
  return samplesToBytes(output);
}

function pitchShift(ffmpeg, cwd, label, source, bundle) {
  const windows = windowsFor(bundle.durationFrames);
  const samples = floats(source);
  const whole = resampleWindow(samples, bundle, { from: 0, to: bundle.totalSamples });
  const { result } = exportWindows(ffmpeg, cwd, label, windows, whole, window => ({
    bytes: resampleWindow(samples, bundle, window), from: 0, to: window.to - window.from,
  }));
  return { ...result, outputFrames: bundle.durationFrames, motionSamples: bundle.motionSamples, mapHash: bundle.rootInfo.mapHash };
}

function stretch(ffmpeg, cwd, label, source, chain, motionSamples, outputSamples) {
  const raw = ffmpegCommand(ffmpeg, cwd, label, [...pcmInput('pipe:0'), '-af', atempoFilter(chain), ...pcmOutput], source);
  const naturalSamples = sampleCount(raw);
  const bytes = Buffer.alloc(outputSamples * BYTES_PER_SAMPLE);
  const kept = Math.min(naturalSamples, motionSamples);
  raw.copy(bytes, 0, 0, kept * BYTES_PER_SAMPLE);
  return { bytes, length: { motionSamples, outputSamples, naturalSamples,
    naturalDeltaFromMotionSamples: naturalSamples - motionSamples,
    unexpectedMissingMotionSamples: motionSamples - kept, intentionalTailSamples: outputSamples - motionSamples } };
}

function tempoCase(ffmpeg, cwd, label, source, rate) {
  const bundle = constantPlan({ audioFrames: sampleCount(source) }, rate);
  const windows = windowsFor(bundle.durationFrames);
  const chain = atempoChain(bundle.rate);
  const whole = stretch(ffmpeg, cwd, `${label} atempo`, source, chain, bundle.motionSamples, bundle.totalSamples);
  const motionValues = floats(whole.bytes).subarray(0, bundle.motionSamples * CHANNELS);
  const unexpectedWholeTailMs = trailingSilenceFrames(motionValues) * 1000 / SAMPLE_RATE;
  const sharedState = exportWindows(ffmpeg, cwd, `${label}-shared`, windows, whole.bytes);
  const restartedLengths = [];
  const restarted = exportWindows(ffmpeg, cwd, `${label}-reset`, windows, whole.bytes, ({ from, to }) => {
    const sourceFrom = Math.min(sampleCount(source), Math.ceil(from * rate.numerator / rate.denominator));
    const sourceTo = Math.min(sampleCount(source), Math.ceil(to * rate.numerator / rate.denominator));
    const motionSamples = Math.max(0, Math.min(to, bundle.motionSamples) - from);
    const segment = stretch(ffmpeg, cwd, `${label} restarted atempo`,
      source.subarray(sourceFrom * BYTES_PER_SAMPLE, sourceTo * BYTES_PER_SAMPLE), chain, motionSamples, to - from);
    restartedLengths.push({ ...segment.length, sourceFrom, sourceTo });
    return { bytes: segment.bytes, from: 0, to: to - from };
  });
  return { canonicalPcm: whole.bytes, report: { rate: bundle.rate, chain, naturalWhole: whole.length,
    unexpectedWholeTailMs, wholeBelowPreviousTailThreshold: unexpectedWholeTailMs <= THRESHOLDS.previousUnexpectedTailSilenceMs,
    sharedState: sharedState.result, restartedLengths, restarted: restarted.result,
    restartBelowPreviousSeamThreshold: restarted.result.boundaries.every(({ previousClickRatio, previousSeamStepRatio }) =>
      previousClickRatio <= THRESHOLDS.previousSeamRatio && previousSeamStepRatio <= THRESHOLDS.previousSeamRatio),
    pass: sharedState.result.pass && restarted.result.pass } };
}

function freezeInTimeline(ffmpeg, cwd, source, pitchBundle, tempoPcm) {
  const leading = 37 * SAMPLES_PER_FRAME;
  const moving = resampleWindow(floats(source), pitchBundle, { from: 0, to: 2 * leading });
  const freeze = Buffer.alloc(FREEZE_FRAMES * SAMPLES_PER_FRAME * BYTES_PER_SAMPLE);
  const whole = Buffer.concat([moving.subarray(0, leading * BYTES_PER_SAMPLE), freeze,
    moving.subarray(leading * BYTES_PER_SAMPLE), tempoPcm]);
  const freezeFrom = leading;
  const freezeTo = freezeFrom + sampleCount(freeze);
  const windows = windowsFor(sampleCount(whole) / SAMPLES_PER_FRAME);
  const { result, joined } = exportWindows(ffmpeg, cwd, 'mixed-freeze', windows, whole);
  const values = floats(joined);
  const freezeValues = values.subarray(freezeFrom * CHANNELS, freezeTo * CHANNELS);
  let nonZeroSamples = 0;
  for (let index = 0; index < freezeValues.length; index += CHANNELS) {
    if (freezeValues[index] !== 0 || freezeValues[index + 1] !== 0) nonZeroSamples++;
  }
  const peakAmplitude = peak(freezeValues);
  const beforePeak = peak(values.subarray((freezeFrom - SAMPLES_PER_FRAME) * CHANNELS, freezeFrom * CHANNELS));
  const afterPeak = peak(values.subarray(freezeTo * CHANNELS, (freezeTo + SAMPLES_PER_FRAME) * CHANNELS));
  const cutInsideFreeze = windows.some(({ from }) => from > freezeFrom && from < freezeTo);
  return { ...result, freezeFrom, freezeTo, freezeSamples: freezeValues.length / CHANNELS, nonZeroSamples, peakAmplitude, beforePeak, afterPeak, cutInsideFreeze,
    pass: result.pass && freezeValues.length / CHANNELS === FREEZE_FRAMES * SAMPLES_PER_FRAME
      && nonZeroSamples <= THRESHOLDS.freezeNonZeroSamples && peakAmplitude <= THRESHOLDS.freezePeak
      && beforePeak > 0 && afterPeak > 0 && cutInsideFreeze };
}

export async function runAudio({ ffmpeg, scratchDir }) {
  const chirp = makeSource(ffmpeg, scratchDir, 'stereo-chirp');
  const pulses = makeSource(ffmpeg, scratchDir, 'stereo-pulses');
  const pitchBundle = constantPlan({ audioFrames: sampleCount(chirp) }, { numerator: 11, denominator: 10 });
  const shortCurveSource = chirp.subarray(0, 31 * SAMPLES_PER_FRAME * BYTES_PER_SAMPLE);
  const curve = presetPlan({ audioFrames: sampleCount(shortCurveSource) }, 'fastToSlow');
  const pitch = {
    constant1_1: pitchShift(ffmpeg, scratchDir, 'pitch-constant', chirp, pitchBundle),
    curveFastToSlow: pitchShift(ffmpeg, scratchDir, 'pitch-curve', shortCurveSource, curve),
  };
  const rates = [[2, 1], [5, 2], [3, 1], [7, 2], [4, 1]];
  const atempo = [];
  let middleTempo;
  for (const [material, source] of [['stereo-chirp', chirp], ['stereo-pulses', pulses]]) {
    for (const [numerator, denominator] of rates) {
      const { canonicalPcm, report } = tempoCase(ffmpeg, scratchDir, `${material}-${numerator}-${denominator}`, source, { numerator, denominator });
      atempo.push({ material, ...report });
      if (material === 'stereo-pulses' && numerator === 5) middleTempo = canonicalPcm;
    }
  }
  const freeze = freezeInTimeline(ffmpeg, scratchDir, chirp, pitchBundle, middleTempo);
  return { sampleRate: SAMPLE_RATE, channels: CHANNELS, samplesPerFrame: SAMPLES_PER_FRAME, sourceFrames: SOURCE_FRAMES,
    materialSha256: { 'stereo-chirp': hash(chirp), 'stereo-pulses': hash(pulses) }, thresholds: THRESHOLDS, pitchShift: pitch, freeze, atempo,
    pass: Object.values(pitch).every(({ pass }) => pass) && freeze.pass && atempo.every(({ pass }) => pass) };
}
