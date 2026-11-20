/** FFmpeg `rubberband` filter prototype (SP-E1 retest).
 *
 * This line runs only when the caller passes a separate FFmpeg build that has
 * `--enable-librubberband`; the product's media-tools FFmpeg stays unchanged.
 * Rubber Band is a streaming time-stretcher with latency and a flush tail, so
 * the prototype trims the calibrated latency from the front, pads the source
 * tail by one project frame, and normalises to the exact SP-M sample count.
 */
import {spawnSync} from 'node:child_process';
import {
  fromBuffer, normaliseLength, peakFrameNear, SAMPLE_RATE, SAMPLES_PER_FRAME, toBuffer,
} from './pcm.mjs';
import {resampleToLength, runFfmpeg} from './stretch.mjs';

/** Filter options chosen after the sweep in the SP-E1 report: smooth transient
 * handling plus the short window was the only combination that kept slow-speed
 * tails under one frame; phase-laminar was best at the slowest and 4x rates. */
export const RUBBERBAND_PARAMS = Object.freeze({
  transients: 'smooth', detector: 'compound', phase: 'laminar', window: 'short',
  smoothing: 'off', formant: 'shifted', pitchq: 'speed', channels: 'apart',
});
export const RUBBERBAND_CANDIDATES = Object.freeze([
  {transients: 'smooth', window: 'short', phase: 'laminar'},
  {transients: 'smooth', window: 'short', phase: 'independent'},
  {transients: 'smooth', window: 'standard', phase: 'laminar'},
  {transients: 'smooth', window: 'standard', phase: 'independent'},
  {transients: 'mixed', window: 'short', phase: 'laminar'},
  {transients: 'mixed', window: 'short', phase: 'independent'},
  {transients: 'mixed', window: 'standard', phase: 'laminar'},
  {transients: 'mixed', window: 'standard', phase: 'independent'},
  {transients: 'crisp', window: 'short', phase: 'laminar'},
  {transients: 'crisp', window: 'short', phase: 'independent'},
  {transients: 'crisp', window: 'standard', phase: 'laminar'},
  {transients: 'crisp', window: 'standard', phase: 'independent'},
  {transients: 'smooth', window: 'short', phase: 'laminar', smoothing: 'on'},
  {transients: 'smooth', window: 'short', phase: 'independent', smoothing: 'on'},
].map(candidate => Object.freeze({...RUBBERBAND_PARAMS, ...candidate})));

/** `tempo` is the playback-speed multiplier: output duration = input / tempo. */
export function rubberbandFilter(tempo, params = RUBBERBAND_PARAMS) {
  const options = Object.entries(params).map(([key, value]) => `${key}=${value}`).join(':');
  return `rubberband=tempo=${tempo}:pitch=1:${options}`;
}
export function runRubberband(ffmpeg, samples, tempo, params = RUBBERBAND_PARAMS) {
  return runFfmpeg(ffmpeg, rubberbandFilter(tempo, params), samples);
}

/** Deterministic latency calibration: one impulse at 2 s in 10 s of silence.
 * Returns the measured output position minus the expected position, in samples;
 * positive means the filter output is late and must be trimmed from the front. */
export function calibrateRubberbandOffset(ffmpeg, tempo, params = RUBBERBAND_PARAMS) {
  const position = Math.round(2 * SAMPLE_RATE), frames = 10 * SAMPLE_RATE;
  const probe = new Float32Array(frames * 2);
  probe[position * 2] = 0.8; probe[position * 2 + 1] = 0.8;
  const output = runRubberband(ffmpeg, probe, tempo, params);
  const expected = position / tempo;
  const onset = peakFrameNear(output, Math.max(0, expected - 1.5 * SAMPLE_RATE),
    Math.min(output.length / 2 - 1, expected + 1.5 * SAMPLE_RATE));
  return onset === null ? 0 : onset - expected;
}

function applyOffset(raw, offsetSamples) {
  if (offsetSamples > 0) return raw.subarray(Math.min(raw.length, offsetSamples * 2));
  if (offsetSamples < 0) {
    const pad = -offsetSamples;
    const padded = new Float32Array(raw.length + pad * 2);
    padded.set(raw, pad * 2);
    return padded;
  }
  return raw;
}

/** Whole-source pitch-preserving stretch. The source is padded by one project
 * frame of its last sample so the filter flushes the tail; the calibrated
 * latency is trimmed from the front and the result is forced to the exact
 * `N × 1600` SP-M sample count. */
export function stretchWithRubberband(ffmpeg, samples, bundle, speed, options = {}) {
  const params = options.params ?? RUBBERBAND_PARAMS;
  const backPadFrames = options.backPadFrames ?? 1;
  const calibration = options.calibration ?? calibrateRubberbandOffset(ffmpeg, speed, params);
  const backPadSamples = Math.round(backPadFrames * SAMPLES_PER_FRAME);
  let input = samples;
  if (backPadSamples) {
    input = new Float32Array(samples.length + backPadSamples * 2);
    input.set(samples);
    const tailStart = Math.max(0, samples.length - 2);
    for (let index = 0; index < backPadSamples; index++) {
      input[samples.length + index * 2] = samples[tailStart] ?? 0;
      input[samples.length + index * 2 + 1] = samples[tailStart + 1] ?? 0;
    }
  }
  const raw = runRubberband(ffmpeg, input, speed, params);
  const normalised = normaliseLength(applyOffset(raw, calibration), {frames: bundle.totalSamples});
  return {samples: normalised.samples, naturalFrames: raw.length / 2 + backPadSamples, rawFrames: raw.length / 2,
    calibrationOffsetSamples: calibration, backPadSamples, params};
}

/** Cut/join probe: both source halves are processed independently with the same
 * calibrated latency, trimmed at the front, concatenated and normalised. */
export function stretchSplitWithRubberband(ffmpeg, samples, bundle, speed, splitSample, options = {}) {
  const params = options.params ?? RUBBERBAND_PARAMS;
  const calibration = options.calibration ?? calibrateRubberbandOffset(ffmpeg, speed, params);
  const process = part => applyOffset(runRubberband(ffmpeg, part, speed, params), calibration);
  const left = process(samples.slice(0, splitSample * 2));
  const right = process(samples.slice(splitSample * 2));
  const joined = new Float32Array(left.length + right.length);
  joined.set(left, 0); joined.set(right, left.length);
  const normalised = normaliseLength(joined, {frames: bundle.totalSamples});
  return {samples: normalised.samples, naturalFrames: joined.length / 2, splitOutputSample: left.length / 2,
    calibrationOffsetSamples: calibration};
}

/** Curve chunk processor: one SP-M-mapped source window → exact target length. */
export function rubberbandChunkProcessor(ffmpeg, params = RUBBERBAND_PARAMS, calibrationCache = new Map()) {
  return (input, targetSamples, ratio) => {
    const tempo = Math.min(100, Math.max(0.01, ratio));
    const key = Math.round(tempo * 1000) / 1000;
    if (!calibrationCache.has(key)) calibrationCache.set(key, calibrateRubberbandOffset(ffmpeg, key, params));
    const raw = runRubberband(ffmpeg, input, key, params);
    return resampleToLength(applyOffset(raw, calibrationCache.get(key)), targetSamples);
  };
}

/** Small parameter sweep used by the report; the default matrix does not run it. */
export function rubberbandSweep(ffmpeg, materials, speeds, candidates = RUBBERBAND_CANDIDATES) {
  const rows = [];
  for (const params of candidates) {
    for (const speed of speeds) {
      for (const material of materials) {
        const frames = Math.round(material.audioFrames / SAMPLES_PER_FRAME);
        const plan = {totalSamples: Math.ceil(frames / speed) * SAMPLES_PER_FRAME, motionSamples: Math.ceil(frames / speed) * SAMPLES_PER_FRAME};
        const started = performance.now();
        const result = stretchWithRubberband(ffmpeg, material.samples, plan, speed, {params});
        rows.push({candidate: Object.fromEntries(Object.keys(RUBBERBAND_CANDIDATES[0]).map(key => [key, params[key]])),
          material: material.name, speed, samples: result.samples.length / 2,
          expectedSamples: plan.totalSamples, calibrationOffsetSamples: result.calibrationOffsetSamples,
          elapsedMs: Math.round(performance.now() - started)});
      }
    }
  }
  return rows;
}

/** Capability probe: the app treats rubberband as available only when the filter
 * is listed and its options parse. */
export function rubberbandAvailability(ffmpeg) {
  const filters = spawnSync(ffmpeg, ['-hide_banner', '-filters'], {encoding: 'utf8'});
  const advertised = filters.status === 0 && /\brubberband\b/u.test(filters.stdout ?? '');
  const help = spawnSync(ffmpeg, ['-hide_banner', '-h', 'filter=rubberband'], {encoding: 'utf8'});
  const options = /AVOptions:/u.test(help.stdout ?? '');
  return {available: advertised && options, filtersStatus: filters.status, helpStatus: help.status};
}
