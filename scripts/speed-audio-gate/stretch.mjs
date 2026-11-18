/** ffmpeg-backed time-stretch and continuous-resampling prototypes. */
import {spawnSync} from 'node:child_process';
import {
  fromBuffer, maxFirstDifference, normaliseLength, SAMPLE_RATE, SAMPLES_PER_FRAME, toBuffer,
} from './pcm.mjs';
import {sourceFramesAtOutputTime, sourceSampleForOutputSample} from './timemap.mjs';

export const CHANNELS = 2;

/** atempo factors limited to the conservative 0.5..2 per filter instance. */
export function atempoChain(rate) {
  const chain = [];
  let remaining = rate;
  while (remaining < 0.5 - 1e-12) { chain.push(0.5); remaining /= 0.5; }
  while (remaining > 2 + 1e-12) { chain.push(2); remaining /= 2; }
  chain.push(remaining);
  return chain;
}
export function atempoFilter(chain) {
  return chain.map(factor => `atempo=${factor.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')}`).join(',');
}
function runFfmpeg(ffmpeg, filter, inputSamples) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS), '-i', 'pipe:0', '-af', filter, '-f', 'f32le', '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS), 'pipe:1'], {input: toBuffer(inputSamples), maxBuffer: 1024 * 1024 * 1024, timeout: 120_000});
  if (result.error) throw new Error(`ffmpeg did not finish: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status}): ${result.stderr?.toString().slice(0, 400)}`);
  return fromBuffer(result.stdout);
}

/** Whole-source pitch-preserving stretch with optional edge padding.
 * Front padding is content repeated before the source (dropped from the output);
 * back padding is content repeated after the source (kept as atempo context and
 * later trimmed), used to quantify the tail-loss mitigation. */
export function stretchWithAtempo(ffmpeg, samples, bundle, rate, {frontPadFrames = 0, backPadFrames = 0} = {}) {
  if (bundle.kind === 'curve') throw new Error('use the chunked curve driver');
  const frontPadSamples = Math.round(frontPadFrames * SAMPLES_PER_FRAME);
  const backPadSamples = Math.round(backPadFrames * SAMPLES_PER_FRAME);
  let input;
  if (frontPadSamples || backPadSamples) {
    input = new Float32Array(samples.length + (frontPadSamples + backPadSamples) * 2);
    let cursor = 0;
    for (let index = 0; index < frontPadSamples; index++) { input[cursor++] = samples[0] ?? 0; input[cursor++] = samples[1] ?? 0; }
    input.set(samples, cursor); cursor += samples.length;
    const tailStart = Math.max(0, samples.length - 2);
    for (let index = 0; index < backPadSamples; index++) { input[cursor++] = samples[tailStart] ?? 0; input[cursor++] = samples[tailStart + 1] ?? 0; }
  } else input = samples;
  const chain = atempoChain(rate);
  const raw = runFfmpeg(ffmpeg, atempoFilter(chain), input);
  const dropFront = Math.round(frontPadSamples / rate);
  const target = bundle.totalSamples;
  const normalised = normaliseLength(raw, {dropFront, frames: target});
  return {samples: normalised.samples, naturalFrames: normalised.naturalFrames + dropFront, chain, rawFrames: raw.length / 2};
}

/** Splits the source at a sample boundary and stretches both sides separately,
 * then concatenates: the gate's cut/join probe. */
export function stretchSplitWithAtempo(ffmpeg, samples, bundle, rate, splitSample) {
  const left = runFfmpeg(ffmpeg, atempoFilter(atempoChain(rate)), samples.slice(0, splitSample * 2));
  const right = runFfmpeg(ffmpeg, atempoFilter(atempoChain(rate)), samples.slice(splitSample * 2));
  const leftFrames = left.length / 2;
  const joined = new Float32Array(left.length + right.length);
  joined.set(left, 0); joined.set(right, left.length);
  const normalised = normaliseLength(joined, {frames: bundle.totalSamples});
  return {samples: normalised.samples, naturalFrames: normalised.naturalFrames, splitOutputSample: leftFrames};
}

/** Continuous-resampling pitch-shift prototype: output sample k reads the source
 * at the SP-M continuous position for output frame k/1600; the ceil tail is
 * explicitly silent. */
export function resampleWithTimeMap(material, bundle) {
  const outputFrames = bundle.durationFrames;
  if (bundle.kind !== 'constant') throw new Error('continuous resampling measures the constant-rate map');
  const step = bundle.framesPerOutputFrame;
  const source = material.samples;
  const output = new Float32Array(bundle.totalSamples * 2);
  const motion = Math.min(bundle.totalSamples, Math.ceil(bundle.motionSamples));
  for (let index = 0; index < motion; index++) {
    const position = (sourceSampleForOutputSample(bundle, index) ?? 0);
    output[index * 2] = interpolate(source, position, 0);
    output[index * 2 + 1] = interpolate(source, position, 1);
  }
  void outputFrames; void step;
  return {samples: output, naturalFrames: bundle.totalSamples, motionSamples: motion};
}
function interpolate(samples, position, channel) {
  const index = Math.floor(position), fraction = position - index;
  const at = offset => samples[Math.max(0, Math.min(samples.length / 2 - 1, index + offset)) * 2 + channel] ?? 0;
  const p0 = at(-1), p1 = at(0), p2 = at(1), p3 = at(2);
  return 0.5 * (2 * p1 + (-p0 + p2) * fraction + (2 * p0 - 5 * p1 + 4 * p2 - p3) * fraction * fraction
    + (-p0 + 3 * p1 - 3 * p2 + p3) * fraction * fraction * fraction);
}

function resampleToLength(samples, targetFrames) {
  const sourceFrames = samples.length / 2;
  const output = new Float32Array(targetFrames * 2);
  if (sourceFrames === 0) return output;
  const scale = sourceFrames / targetFrames;
  for (let frame = 0; frame < targetFrames; frame++) {
    const position = Math.min(sourceFrames - 1, frame * scale);
    const index = Math.floor(position), fraction = position - index;
    const next = Math.min(sourceFrames - 1, index + 1);
    output[frame * 2] = (samples[index * 2] ?? 0) * (1 - fraction) + (samples[next * 2] ?? 0) * fraction;
    output[frame * 2 + 1] = (samples[index * 2 + 1] ?? 0) * (1 - fraction) + (samples[next * 2 + 1] ?? 0) * fraction;
  }
  return output;
}

/** Chunked curve time-stretch: each output chunk is mapped through SP-M to a
 * source window with context, stretched with an atempo chain, trimmed to the
 * exact chunk length and overlap-added with short crossfades. */
export function stretchCurveChunked(ffmpeg, material, bundle, options = {}) {
  const chunkFrames = options.chunkFrames ?? 30;
  const contextFrames = options.contextFrames ?? 8;
  const overlapFrames = options.overlapFrames ?? 2;
  const hopFrames = chunkFrames - overlapFrames;
  const output = new Float32Array(bundle.totalSamples * 2);
  const boundaries = [];
  let chunkCount = 0;
  let chunkStart = 0;
  const sourceSamples = material.samples;
  while (chunkStart < bundle.length - 1e-9) {
    const coreEnd = Math.min(chunkStart + chunkFrames, bundle.length);
    const contextStart = Math.max(0, chunkStart - contextFrames);
    const contextEnd = Math.min(bundle.length, coreEnd + contextFrames);
    const sourceStartFrame = sourceFramesAtOutputTime(bundle, contextStart);
    const sourceEndFrame = sourceFramesAtOutputTime(bundle, contextEnd);
    const sourceStartSample = Math.max(0, Math.min(material.audioFrames, Math.round(sourceStartFrame * SAMPLES_PER_FRAME)));
    const sourceEndSample = Math.max(sourceStartSample + 2, Math.min(material.audioFrames, Math.round(sourceEndFrame * SAMPLES_PER_FRAME)));
    const input = sourceSamples.slice(sourceStartSample * 2, sourceEndSample * 2);
    const coreSamples = Math.round((coreEnd - chunkStart) * SAMPLES_PER_FRAME);
    const leftContextSamples = Math.round((chunkStart - contextStart) * SAMPLES_PER_FRAME);
    const rightContextSamples = Math.round((contextEnd - coreEnd) * SAMPLES_PER_FRAME);
    const targetTotalSamples = coreSamples + leftContextSamples + rightContextSamples;
    const ratio = Math.min(10, Math.max(0.1, (input.length / 2) / Math.max(1, targetTotalSamples)));
    const chain = atempoChain(ratio);
    const processedRaw = runFfmpeg(ffmpeg, atempoFilter(chain), input);
    const processed = resampleToLength(processedRaw, targetTotalSamples);
    const processedFrames = processed.length / 2;
    const core = new Float32Array(coreSamples * 2);
    const offset = Math.min(Math.max(0, leftContextSamples), Math.max(0, processedFrames - 1));
    const available = Math.max(0, Math.min(coreSamples, processedFrames - offset));
    core.set(processed.subarray(offset * 2, (offset + available) * 2), 0);
    const startSample = Math.round(chunkStart * SAMPLES_PER_FRAME);
    const overlapSamples = Math.round(overlapFrames * SAMPLES_PER_FRAME);
    for (let index = 0; index < coreSamples; index++) {
      let gain = 1;
      if (chunkStart > 0 && index < overlapSamples) gain = index / overlapSamples;
      if (coreEnd < bundle.length && index >= coreSamples - overlapSamples) gain = Math.min(gain, (coreSamples - index) / overlapSamples);
      const outputIndex = startSample + index;
      if (outputIndex >= bundle.motionSamples) break;
      output[outputIndex * 2] += (core[index * 2] ?? 0) * gain;
      output[outputIndex * 2 + 1] += (core[index * 2 + 1] ?? 0) * gain;
    }
    boundaries.push(startSample);
    chunkCount++;
    void chunkFrames; void hopFrames; void rightContextSamples;
    if (coreEnd >= bundle.length) break;
    chunkStart += hopFrames;
  }
  return {samples: output, naturalFrames: bundle.totalSamples, boundaries, chunkCount};
}

/** Boundary click metric: largest first difference in a ±window around each
 * chunk boundary, compared with the whole signal's large first differences. */
export function boundaryClick(whole, boundaries, windowFrames = Math.round(SAMPLE_RATE * 0.002)) {
  const values = boundaries.map(boundary => maxFirstDifference(whole, boundary - windowFrames, boundary + windowFrames));
  const peak = whole.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  return {maxBoundaryJump: Math.max(0, ...values), boundaries: values.length, peak};
}
