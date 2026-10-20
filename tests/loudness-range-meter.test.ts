import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoudnessRangeMeter} from '../packages/business/src/loudness-range-meter.ts';
import {LOUDNESS_RANGE_LIMITS, LOUDNESS_RANGE_PROFILE, loudnessRangeMeasurementSchema,
  type LoudnessRangeMeasurement} from '../packages/contracts/src/loudness-range.ts';

const RATE = 48000;
function pcm(frames: number, sample: (frame: number, channel: number) => number): Buffer {
  const bytes = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) for (let channel = 0; channel < 2; channel++) bytes.writeFloatLE(sample(i, channel), i * 8 + channel * 4);
  return bytes;
}
const tone = (level: number) => (i: number): number => 10 ** (level / 20) * Math.sin(2 * Math.PI * 1000 * i / RATE);
function measure(bytes: Uint8Array, chunkSize = bytes.length): LoudnessRangeMeasurement {
  const meter = createLoudnessRangeMeter();
  for (let offset = 0; offset < bytes.length; offset += chunkSize) meter.push(bytes.subarray(offset, offset + chunkSize));
  const result = meter.finish(bytes.length / 8 / RATE);
  assert.equal(loudnessRangeMeasurementSchema.safeParse(result).success, true, JSON.stringify(result));
  return result;
}
function near(actual: number | null, expected: number, tolerance = 1e-8): void {
  assert.notEqual(actual, null); assert.ok(Math.abs(actual! - expected) <= tolerance, `${actual} differs from ${expected}`);
}

// Different filter form and full-window summation: it deliberately stores a
// short fixture rather than sharing the production compensated-hop reducer.
function reference(bytes: Buffer): Pick<LoudnessRangeMeasurement, 'shortTermBlockCount' | 'absoluteGatedBlockCount' |
  'relativeGatedBlockCount' | 'relativeGateLufs' | 'lowPercentileLufs' | 'highPercentileLufs' | 'loudnessRangeLu'> {
  const energy = new Float64Array(bytes.length / 8);
  for (let channel = 0; channel < 2; channel++) {
    let signal = Array.from({length: bytes.length / 8}, (_, i) => bytes.readFloatLE(i * 8 + channel * 4));
    for (const [b0, b1, b2, a1, a2] of [[1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
      [1, -2, 1, -1.99004745483398, 0.99007225036621]]) {
      const output: number[] = [];
      for (let i = 0; i < signal.length; i++) output.push(b0 * signal[i] + b1 * (signal[i - 1] ?? 0) +
        b2 * (signal[i - 2] ?? 0) - a1 * (output[i - 1] ?? 0) - a2 * (output[i - 2] ?? 0));
      signal = output;
    }
    for (let i = 0; i < signal.length; i++) energy[i] += signal[i] ** 2;
  }
  const levels: number[] = [];
  for (let start = 0; start + 144000 <= energy.length; start += 4800) {
    let sum = 0;
    for (let i = start; i < start + 144000; i++) sum += energy[i];
    levels.push(-0.691 + 10 * Math.log10(sum / 144000));
  }
  const absolute = levels.filter(v => v >= -70);
  const threshold = absolute.length ? 10 * Math.log10(absolute.reduce((sum, v) => sum + 10 ** (v / 10), 0) / absolute.length) - 20 : null;
  const gated = absolute.filter(v => threshold !== null && v >= threshold).sort((a, b) => a - b);
  const low = gated.length ? gated[Math.round((gated.length - 1) * 0.1)] : null;
  const high = gated.length ? gated[Math.round((gated.length - 1) * 0.95)] : null;
  return {shortTermBlockCount: levels.length, absoluteGatedBlockCount: absolute.length, relativeGatedBlockCount: gated.length,
    relativeGateLufs: threshold, lowPercentileLufs: low, highPercentileLufs: high, loudnessRangeLu: low === null || high === null ? null : high - low};
}

test('range profile is separate, bounded and counts only complete three-second windows', () => {
  assert.equal(LOUDNESS_RANGE_PROFILE, 'ebu3342-2023-48k-stereo-3s-100ms-complete-v1');
  assert.equal(LOUDNESS_RANGE_LIMITS.pcmBytes, 60 * RATE * 8);
  for (const frames of [1, 143999, 144000, 144001, 148799, 148800, 148801]) {
    const result = measure(pcm(frames, tone(-20)));
    assert.equal(result.shortTermBlockCount, frames < 144000 ? 0 : frames < 148800 ? 1 : 2);
    assert.equal(result.state, frames < 144000 ? 'too_short' : 'valid');
    if (frames < 144000) assert.equal(result.loudnessRangeLu, null);
    else near(result.loudnessRangeLu, 0, 0.001);
  }
});

test('split float/frame chunks and Uint8Array offsets do not change the report', () => {
  const bytes = pcm(153617, (i, c) => (c ? -1 : 1) * 0.13 * Math.sin(2 * Math.PI * 997 * i / RATE));
  const expected = measure(bytes);
  const backing = new Uint8Array(bytes.length + 9); backing.set(bytes, 5);
  for (const size of [1, 3, 7, 8, 13, 4093, 65536]) assert.deepEqual(measure(backing.subarray(5, 5 + bytes.length), size), expected);
  const meter = createLoudnessRangeMeter(); meter.push(bytes);
  const first = meter.finish(); assert.ok(Object.isFrozen(first)); assert.strictEqual(meter.finish(), first);
  assert.throws(() => meter.push(Buffer.alloc(0)), {code: 'LOUDNESS_INVALID_PCM'});
  assert.strictEqual(meter.finish(), first);
});

test('complete-window stereo energy and gated percentiles match independent direct-form reference', () => {
  const bytes = pcm(RATE * 8 + 1703, (i, c) => {
    const level = i < RATE * 3 ? -55 : i < RATE * 5 ? -17 : -44;
    return (c ? -1 : 1) * 10 ** (level / 20) * Math.sin(2 * Math.PI * 977 * i / RATE);
  });
  const actual = measure(bytes, 4093), expected = reference(bytes);
  for (const key of ['shortTermBlockCount', 'absoluteGatedBlockCount', 'relativeGatedBlockCount'] as const)
    assert.equal(actual[key], expected[key]);
  for (const key of ['relativeGateLufs', 'lowPercentileLufs', 'highPercentileLufs', 'loudnessRangeLu'] as const)
    near(actual[key], expected[key]!, 1e-7);
  assert.ok(actual.relativeGatedBlockCount < actual.absoluteGatedBlockCount);
});

test('short input, exact silence and below-gate audio never fabricate a zero range', () => {
  const shortSilence = measure(pcm(143999, () => 0));
  assert.equal(shortSilence.state, 'too_short'); assert.equal(shortSilence.loudnessRangeLu, null);
  for (const [sample, state] of [[() => 0, 'digital_silence'], [tone(-90), 'below_gate']] as const) {
    const result = measure(pcm(RATE * 4, sample));
    assert.equal(result.state, state); assert.equal(result.loudnessRangeLu, null);
    assert.equal(result.lowPercentileLufs, null); assert.equal(result.highPercentileLufs, null);
    assert.equal(result.relativeGateLufs, null); assert.equal(result.relativeGatedBlockCount, 0);
  }
  const silentWindowsWithNonzeroIncompleteTail = measure(pcm(144001, i => i === 144000 ? 1 : 0));
  assert.equal(silentWindowsWithNonzeroIncompleteTail.state, 'below_gate');
  assert.equal(silentWindowsWithNonzeroIncompleteTail.loudnessRangeLu, null);
});

test('uniform gain shifts qualified percentile levels but preserves loudness range', () => {
  const signal = (i: number, c: number): number => {
    const level = [-30, -15, -24, -20][Math.floor(i / (RATE * 5))];
    return (c ? -1 : 1) * 10 ** (level / 20) * Math.sin(2 * Math.PI * 1000 * i / RATE);
  };
  const base = measure(pcm(RATE * 20, signal));
  const shifted = measure(pcm(RATE * 20, (i, c) => signal(i, c) * 0.5));
  near(shifted.loudnessRangeLu, base.loudnessRangeLu!);
  near(shifted.lowPercentileLufs! - base.lowPercentileLufs!, 20 * Math.log10(0.5));
  near(shifted.highPercentileLufs! - base.highPercentileLufs!, 20 * Math.log10(0.5));
  assert.equal(shifted.relativeGatedBlockCount, base.relativeGatedBlockCount);
});

test('invalid samples, partial frames and invalid durations fail terminally', () => {
  for (const sample of [NaN, Infinity, -Infinity]) for (const channel of [0, 1]) {
    const meter = createLoudnessRangeMeter();
    assert.throws(() => meter.push(pcm(1, (_, c) => c === channel ? sample : 0)), {code: 'LOUDNESS_INVALID_PCM'});
    assert.throws(() => meter.finish(), {code: 'LOUDNESS_INVALID_PCM'});
  }
  for (let residual = 0; residual < 8; residual++) {
    const meter = createLoudnessRangeMeter(); meter.push(Buffer.alloc(residual ? 144000 * 8 + residual : 0));
    assert.throws(() => meter.finish(), {code: 'LOUDNESS_INVALID_PCM'});
    assert.throws(() => meter.push(Buffer.alloc(8)), {code: 'LOUDNESS_INVALID_PCM'});
  }
  for (const value of [null, 'pcm', new DataView(new ArrayBuffer(8))]) {
    const meter = createLoudnessRangeMeter();
    assert.throws(() => meter.push(value as never), {code: 'LOUDNESS_INVALID_PCM'});
    assert.throws(() => meter.finish(), {code: 'LOUDNESS_INVALID_PCM'});
  }
  for (const duration of [NaN, Infinity, -1, 0, '3']) {
    const meter = createLoudnessRangeMeter(); meter.push(pcm(144000, tone(-20)));
    assert.throws(() => meter.finish(duration as number), {code: 'LOUDNESS_INVALID_PCM'});
  }
  const longDuration = createLoudnessRangeMeter(); longDuration.push(pcm(144000, tone(-20)));
  assert.throws(() => longDuration.finish(60.01), {code: 'LOUDNESS_DURATION_LIMIT'});
  const mismatch = createLoudnessRangeMeter(); mismatch.push(pcm(144000, tone(-20)));
  assert.throws(() => mismatch.finish(3.1001), {code: 'LOUDNESS_DURATION_MISMATCH'});
  const boundary = createLoudnessRangeMeter(); boundary.push(pcm(144000, tone(-20)));
  assert.equal(boundary.finish(3.1).decodedDurationSeconds, 3);
});

test('sixty seconds gives exactly 571 windows and exceeding its byte cap is terminal', () => {
  const chunk = pcm(RATE, tone(-20)), meter = createLoudnessRangeMeter();
  for (let second = 0; second < 60; second++) meter.push(chunk);
  const result = meter.finish(60);
  assert.equal(result.shortTermBlockCount, 571); assert.equal(result.sampleFrames, 2880000);
  assert.equal(loudnessRangeMeasurementSchema.safeParse(result).success, true);
  const capped = createLoudnessRangeMeter();
  for (let second = 0; second < 60; second++) capped.push(chunk);
  assert.throws(() => capped.push(Buffer.alloc(1)), {code: 'LOUDNESS_RESOURCE_LIMIT'});
  assert.throws(() => capped.finish(), {code: 'LOUDNESS_RESOURCE_LIMIT'});
});

test('strict report rejects forged counts, nullability, percentiles, duration and profile', () => {
  const valid = measure(pcm(RATE * 4, tone(-20)));
  const alterations = [{profile: 'bs1770-5-48k-stereo-fir4x-v1'}, {sampleFrames: RATE * 61}, {decodedDurationSeconds: 4.001},
    {shortTermBlockCount: 12}, {absoluteGatedBlockCount: 12}, {relativeGatedBlockCount: 0},
    {relativeGateLufs: null}, {lowPercentileLufs: -95}, {highPercentileLufs: -90},
    {loudnessRangeLu: null}, {loudnessRangeLu: 1}, {state: 'below_gate'}, {samplePeakLinear: 0}, {extra: true}];
  for (const alteration of alterations) assert.equal(loudnessRangeMeasurementSchema.safeParse({...valid, ...alteration}).success, false, JSON.stringify(alteration));
});
