/** PCM helpers for the SP-E0 audio prototype. Pure Node: no third-party
 * dependencies. Signals are interleaved Float32Array stereo at 48 kHz. */

export const SAMPLE_RATE = 48_000;
export const PROJECT_FPS = 30;
export const SAMPLES_PER_FRAME = SAMPLE_RATE / PROJECT_FPS;

export const db = value => 20 * Math.log10(Math.max(value, 1e-12));
export const fromDb = value => 10 ** (value / 20);

export function peak(samples) {
  let maximum = 0;
  for (const value of samples) if (Math.abs(value) > maximum) maximum = Math.abs(value);
  return maximum;
}
export function rms(samples) {
  let sum = 0;
  for (const value of samples) sum += value * value;
  return Math.sqrt(sum / Math.max(1, samples.length));
}
const frame = (samples, index) => Math.max(Math.abs(samples[index * 2] ?? 0), Math.abs(samples[index * 2 + 1] ?? 0));

/** Number of trailing frames staying at or below the silence threshold. */
export function trailingSilenceFrames(samples, threshold = fromDb(-60)) {
  const frames = samples.length / 2;
  let index = frames - 1;
  while (index >= 0 && frame(samples, index) <= threshold) index--;
  return frames - 1 - index;
}

/** First frame at or after `fromFrame` whose mono magnitude crosses the threshold. */
export function firstOnsetFrame(samples, fromFrame, threshold = fromDb(-40), searchFrames = SAMPLE_RATE) {
  const frames = samples.length / 2;
  const end = Math.min(frames, fromFrame + searchFrames);
  for (let index = Math.max(0, fromFrame); index < end; index++) if (frame(samples, index) > threshold) return index;
  return null;
}

/** Onset proxy: the frame where cumulative energy in [fromFrame, toFrame)
 * first reaches `fraction` of the window's total energy. For a decaying click
 * the 5% crossing is a few ms after the attack; it is robust to the phase
 * vocoder smearing that defeats a single-sample threshold. */
export function energyRiseFrame(samples, fromFrame, toFrame, fraction = 0.05) {
  const start = Math.max(0, Math.floor(fromFrame)), end = Math.min(samples.length / 2, Math.ceil(toFrame));
  let total = 0;
  for (let index = start; index < end; index++) total += frame(samples, index) ** 2;
  if (total <= 1e-12) return null;
  let accumulated = 0;
  for (let index = start; index < end; index++) {
    accumulated += frame(samples, index) ** 2;
    if (accumulated >= total * fraction) return index;
  }
  return null;
}

/** Onset of a transient measured on a short-window energy envelope. The phase
 * vocoder smears an impulse, so energy onset is fairer than a single-sample
 * threshold; the returned frame is the centre of the first window above the
 * threshold (relative to a pre-window baseline). */
export function firstEnergyOnsetFrame(samples, fromFrame, {windowFrames = 240, thresholdDb = -30, searchFrames = SAMPLE_RATE} = {}) {
  const frames = samples.length / 2;
  const baselineStart = Math.max(0, fromFrame - 2 * windowFrames);
  let baseline = 0;
  for (let index = baselineStart; index < Math.max(baselineStart + 1, fromFrame - windowFrames); index++) baseline += frame(samples, index) ** 2;
  baseline = Math.sqrt(baseline / Math.max(1, fromFrame - windowFrames - baselineStart));
  const threshold = Math.max(fromDb(thresholdDb), baseline * 4);
  for (let start = Math.max(0, fromFrame); start < Math.min(frames - windowFrames, fromFrame + searchFrames); start++) {
    let energy = 0;
    for (let offset = 0; offset < windowFrames; offset++) energy += frame(samples, start + offset) ** 2;
    if (Math.sqrt(energy / windowFrames) > threshold) return start + windowFrames / 2;
  }
  return null;
}

/** Inter-channel delay in samples (positive means the right channel leads). */
export function channelLag(channelLeft, channelRight, fromFrame = 0, frames = SAMPLE_RATE, maxLag = 960) {
  const meanLeft = channelLeft.slice(fromFrame, fromFrame + frames).reduce((sum, value) => sum + value, 0) / Math.max(1, frames);
  const meanRight = channelRight.slice(fromFrame, fromFrame + frames).reduce((sum, value) => sum + value, 0) / Math.max(1, frames);
  let bestLag = 0, best = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0, energyLeft = 0, energyRight = 0;
    for (let index = 0; index < frames; index++) {
      const left = (channelLeft[fromFrame + index] ?? 0) - meanLeft;
      const right = (channelRight[fromFrame + index + lag] ?? 0) - meanRight;
      sum += left * right; energyLeft += left * left; energyRight += right * right;
    }
    const score = sum / Math.sqrt(Math.max(1e-12, energyLeft * energyRight));
    if (score > best) { best = score; bestLag = lag; }
  }
  return bestLag;
}

export function channelDelay(samples, {fromFrame = 0, frames = SAMPLE_RATE, maxLag = 960} = {}) {
  const left = new Float32Array(samples.length / 2), right = new Float32Array(samples.length / 2);
  for (let index = 0; index < left.length; index++) { left[index] = samples[index * 2] ?? 0; right[index] = samples[index * 2 + 1] ?? 0; }
  return channelLag(left, right, fromFrame, frames, maxLag);
}

/** Frame index of the largest mono magnitude in [fromFrame, toFrame). */
export function peakFrameNear(samples, fromFrame, toFrame) {
  let best = 0, bestFrame = null;
  for (let index = Math.max(0, Math.floor(fromFrame)); index < Math.min(samples.length / 2, Math.ceil(toFrame)); index++) {
    const value = frame(samples, index);
    if (value > best) { best = value; bestFrame = index; }
  }
  return bestFrame;
}

/** Inter-channel lag for a periodic tone: cross-spectrum phase at `frequency`,
 * wrapped to one period. Used for the stereo-phase material, where plain
 * correlation has many equally valid maxima. */
export function toneChannelLag(samples, frequency, {fromFrame = 0, frames = SAMPLE_RATE} = {}) {
  const left = new Float32Array(samples.length / 2), right = new Float32Array(samples.length / 2);
  for (let index = 0; index < left.length; index++) { left[index] = samples[index * 2] ?? 0; right[index] = samples[index * 2 + 1] ?? 0; }
  const omega = 2 * Math.PI * frequency / SAMPLE_RATE;
  let leftCos = 0, leftSin = 0, rightCos = 0, rightSin = 0;
  for (let index = 0; index < frames; index++) {
    const cos = Math.cos(omega * index), sin = Math.sin(omega * index);
    leftCos += (left[fromFrame + index] ?? 0) * cos; leftSin += (left[fromFrame + index] ?? 0) * sin;
    rightCos += (right[fromFrame + index] ?? 0) * cos; rightSin += (right[fromFrame + index] ?? 0) * sin;
  }
  const phase = Math.atan2(leftSin, leftCos) - Math.atan2(rightSin, rightCos);
  const lag = -phase / (2 * Math.PI * frequency) * SAMPLE_RATE;
  const period = SAMPLE_RATE / frequency;
  return ((lag % period) + period * 1.5) % period - period / 2;
}

/** Catmull-Rom interpolation of one channel at a fractional frame position. */
function catmullRom(samples, position, channel) {
  const index = Math.floor(position), fraction = position - index;
  const at = offset => samples[Math.max(0, Math.min(samples.length / 2 - 1, index + offset)) * 2 + channel] ?? 0;
  const p0 = at(-1), p1 = at(0), p2 = at(1), p3 = at(2);
  return 0.5 * ((2 * p1) + (-p0 + p2) * fraction + (2 * p0 - 5 * p1 + 4 * p2 - p3) * fraction * fraction
    + (-p0 + 3 * p1 - 3 * p2 + p3) * fraction * fraction * fraction);
}

/** Normalises to exactly `frames` frames: drops `dropFront` frames first, pads
 * with silence at the end or truncates. Returns the output and the natural
 * (post-drop) frame count for latency reporting. */
export function normaliseLength(samples, {dropFront = 0, frames}) {
  const sourceFrames = samples.length / 2;
  const available = Math.max(0, sourceFrames - dropFront);
  const output = new Float32Array(frames * 2);
  const keep = Math.min(available, frames);
  const offset = Math.max(0, dropFront) * 2;
  output.set(samples.subarray(offset, offset + keep * 2), 0);
  return {samples: output, naturalFrames: available};
}

/** Peak absolute sample difference between two equally long signals. */
export function maxDifference(left, right) {
  const length = Math.min(left.length, right.length);
  let maximum = 0;
  for (let index = 0; index < length; index++) maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
  return maximum;
}

/** Largest absolute first difference in a frame window. */
export function maxFirstDifference(samples, fromFrame, toFrame) {
  let maximum = 0;
  const start = Math.max(1, fromFrame), end = Math.min(samples.length / 2, toFrame);
  for (let frameIndex = start; frameIndex < end; frameIndex++) {
    for (let channel = 0; channel < 2; channel++) {
      const current = samples[frameIndex * 2 + channel] ?? 0, previous = samples[(frameIndex - 1) * 2 + channel] ?? 0;
      maximum = Math.max(maximum, Math.abs(current - previous));
    }
  }
  return maximum;
}

export function firstDifferencePeak(samples, fromFrame = 0, toFrame = samples.length / 2) {
  let maximum = 0;
  for (let frameIndex = Math.max(1, fromFrame); frameIndex < Math.min(samples.length / 2, toFrame); frameIndex++) {
    for (let channel = 0; channel < 2; channel++) maximum = Math.max(maximum,
      Math.abs((samples[frameIndex * 2 + channel] ?? 0) - (samples[(frameIndex - 1) * 2 + channel] ?? 0)));
  }
  return maximum;
}
export function firstDifferencePercentile(samples, fraction) {
  const values = [];
  for (let frameIndex = 1; frameIndex < samples.length / 2; frameIndex++) {
    values.push(Math.max(Math.abs((samples[frameIndex * 2] ?? 0) - (samples[(frameIndex - 1) * 2] ?? 0)),
      Math.abs((samples[frameIndex * 2 + 1] ?? 0) - (samples[(frameIndex - 1) * 2 + 1] ?? 0))));
  }
  return percentile(values, fraction);
}

export function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)))] ?? 0;
}

/** Buffer conversion for the ffmpeg raw f32le pipe (little-endian hosts). */
export function toBuffer(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}
export function fromBuffer(buffer) {
  const copy = Buffer.from(buffer);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
