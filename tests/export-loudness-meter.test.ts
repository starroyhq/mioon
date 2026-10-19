import test from 'node:test';
import assert from 'node:assert/strict';
import {createExportLoudnessAccumulator, EXPORT_LOUDNESS_SAMPLE_RATE, EXPORT_LOUDNESS_CHANNELS,
  EXPORT_LOUDNESS_MAX_SECONDS, EXPORT_LOUDNESS_MAX_PCM_BYTES,
  EXPORT_LOUDNESS_DURATION_TOLERANCE_SECONDS} from '../packages/business/src/export-loudness-meter.ts';

const RATE = 48000;
function pcm(frames, sample) {
  const bytes = Buffer.alloc(frames * 8);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 2; channel++)
    bytes.writeFloatLE(sample(frame, channel), frame * 8 + channel * 4);
  return bytes;
}
function measure(bytes, chunkSize = bytes.length, duration = bytes.length / 8 / RATE) {
  const meter = createExportLoudnessAccumulator(duration);
  for (let offset = 0; offset < bytes.length; offset += chunkSize) meter.write(bytes.subarray(offset, offset + chunkSize));
  return meter.finish();
}
function near(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by ${actual - expected}`);
}

// Independent direct-form-I reference, retaining the signal and summing each
// complete block from scratch. Production uses transposed direct form II and
// compensated hop sums. Coefficients/equations: BS.1770-5 Annex 1, Tables 1/2.
function referenceLoudness(bytes) {
  const channels = [];
  for (let channel = 0; channel < 2; channel++) {
    let signal = Array.from({length: bytes.length / 8}, (_, i) => bytes.readFloatLE(i * 8 + channel * 4));
    for (const [b0, b1, b2, a1, a2] of [
      [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
      [1, -2, 1, -1.99004745483398, 0.99007225036621],
    ]) {
      const filtered = [];
      for (let i = 0; i < signal.length; i++) filtered.push(b0 * signal[i] + b1 * (signal[i - 1] ?? 0) +
        b2 * (signal[i - 2] ?? 0) - a1 * (filtered[i - 1] ?? 0) - a2 * (filtered[i - 2] ?? 0));
      signal = filtered;
    }
    channels.push(signal);
  }
  const energy = [];
  for (let start = 0; start + 19200 <= bytes.length / 8; start += 4800) {
    let sum = 0;
    for (let frame = start; frame < start + 19200; frame++) sum += channels[0][frame] ** 2 + channels[1][frame] ** 2;
    energy.push(sum / 19200);
  }
  const db = e => -0.691 + 10 * Math.log10(e);
  const absolute = energy.filter(e => db(e) > -70);
  const relativeThreshold = absolute.length ? db(absolute.reduce((a, b) => a + b, 0) / absolute.length) - 10 : null;
  const relative = absolute.filter(e => db(e) > relativeThreshold);
  return {integratedLufs: relative.length ? db(relative.reduce((a, b) => a + b, 0) / relative.length) : null,
    gatingBlockCount: energy.length, absoluteGatedBlockCount: absolute.length,
    relativeGatedBlockCount: relative.length, relativeGateLufs: relativeThreshold};
}

// A differently arranged, non-polyphase oracle: explicit 4x zero insertion
// and full causal 48-tap convolution. Rows match Annex 2's printed table.
const FIR = [
  [0.0017089843750, -0.0291748046875, -0.0189208984375, -0.0083007812500],
  [0.0109863281250, 0.0292968750000, 0.0330810546875, 0.0148925781250],
  [-0.0196533203125, -0.0517578125000, -0.0582275390625, -0.0266113281250],
  [0.0332031250000, 0.0891113281250, 0.1015625000000, 0.0476074218750],
  [-0.0594482421875, -0.1665039062500, -0.2003173828125, -0.1022949218750],
  [0.1373291015625, 0.4650878906250, 0.7797851562500, 0.9721679687500],
  [0.9721679687500, 0.7797851562500, 0.4650878906250, 0.1373291015625],
  [-0.1022949218750, -0.2003173828125, -0.1665039062500, -0.0594482421875],
  [0.0476074218750, 0.1015625000000, 0.0891113281250, 0.0332031250000],
  [-0.0266113281250, -0.0582275390625, -0.0517578125000, -0.0196533203125],
  [0.0148925781250, 0.0330810546875, 0.0292968750000, 0.0109863281250],
  [-0.0083007812500, -0.0189208984375, -0.0291748046875, 0.0017089843750],
].flat();
function referenceTruePeak(bytes) {
  let peak = 0;
  for (let channel = 0; channel < 2; channel++) {
    const frames = bytes.length / 8, output = new Float64Array((frames - 1) * 4 + FIR.length);
    for (let frame = 0; frame < frames; frame++) {
      const sample = bytes.readFloatLE(frame * 8 + channel * 4);
      peak = Math.max(peak, Math.abs(sample));
      for (let tap = 0; tap < FIR.length; tap++) output[frame * 4 + tap] += sample * FIR[tap];
    }
    for (const sample of output) peak = Math.max(peak, Math.abs(sample));
  }
  return peak;
}

test('loudness fixed profile is stereo f32le48k, 600 seconds and 100ms duration tolerance', () => {
  assert.equal(EXPORT_LOUDNESS_SAMPLE_RATE, RATE); assert.equal(EXPORT_LOUDNESS_CHANNELS, 2);
  assert.equal(EXPORT_LOUDNESS_MAX_SECONDS, 600); assert.equal(EXPORT_LOUDNESS_MAX_PCM_BYTES, 230400000);
  assert.equal(EXPORT_LOUDNESS_DURATION_TOLERANCE_SECONDS, 0.1);
  for (const duration of [NaN, Infinity, -Infinity, 0, -1, '1', undefined])
    assert.throws(() => createExportLoudnessAccumulator(duration), {code: 'LOUDNESS_INVALID_PCM'});
  assert.throws(() => createExportLoudnessAccumulator(600.00001), {code: 'LOUDNESS_DURATION_LIMIT'});
});

test('loudness is identical across single-byte, split-float and irregular chunk boundaries', () => {
  const bytes = pcm(19201, (i, c) => (c ? -0.07 : 0.1) * Math.sin(2 * Math.PI * 997 * i / RATE));
  const expected = measure(bytes);
  for (const size of [1, 3, 4, 7, 8, 13, 127, 4093, 65536]) assert.deepEqual(measure(bytes, size), expected);
  const meter = createExportLoudnessAccumulator(19201 / RATE);
  meter.write(bytes); const result = meter.finish();
  assert.ok(Object.isFrozen(result)); assert.strictEqual(meter.finish(), result);
  assert.throws(() => meter.write(Buffer.alloc(0)), {code: 'LOUDNESS_INVALID_PCM'});
  assert.strictEqual(meter.finish(), result);
});

test('19199/19200/19201 frames respect complete block boundary without padded loudness', () => {
  const results = [19199, 19200, 19201].map(n => measure(pcm(n, (i, c) => (c ? -1 : 1) * 0.1 * Math.sin(2 * Math.PI * 997 * i / RATE))));
  assert.deepEqual(results.map(r => r.sampleFrames), [19199, 19200, 19201]);
  assert.deepEqual(results.map(r => r.gatingBlockCount), [0, 1, 1]);
  assert.deepEqual(results.map(r => r.state), ['too_short', 'valid', 'valid']);
  assert.equal(results[0].integratedLufs, null);
  near(results[1].integratedLufs, -19.999035330961945);
  assert.equal(results[1].integratedLufs, results[2].integratedLufs);
  for (const n of [23999, 24000, 24001]) assert.equal(measure(pcm(n, () => 0.01)).gatingBlockCount, n < 24000 ? 1 : 2);
});

test('independent causal filter/block oracle verifies absolute and relative gates', () => {
  for (const levels of [[-90, -40, -90, -90], [-40, -10, -40, -40]]) {
    const bytes = pcm(96000, i => 10 ** (levels[Math.floor(i / 24000)] / 20) * Math.sin(2 * Math.PI * 1000 * i / RATE));
    const actual = measure(bytes), expected = referenceLoudness(bytes);
    for (const key of ['gatingBlockCount', 'absoluteGatedBlockCount', 'relativeGatedBlockCount']) assert.equal(actual[key], expected[key]);
    near(actual.integratedLufs, expected.integratedLufs, 1e-9);
    near(actual.relativeGateLufs, expected.relativeGateLufs, 1e-9);
    assert.ok(actual.relativeGatedBlockCount < actual.gatingBlockCount);
    if (levels[0] === -90) assert.ok(actual.absoluteGatedBlockCount < actual.gatingBlockCount);
    else assert.equal(actual.absoluteGatedBlockCount, actual.gatingBlockCount);
  }
});

test('silence, short programme and below-absolute-gate signals remain distinct', () => {
  for (const n of [1, 19199, 19200, 48000]) {
    const result = measure(pcm(n, (_, c) => c ? -0 : 0));
    assert.equal(result.state, 'digital_silence'); assert.equal(result.integratedLufs, null);
    assert.equal(result.samplePeakLinear, 0); assert.equal(result.truePeakLinear, 0);
    assert.equal(result.samplePeakDbfs, null); assert.equal(result.truePeakDbtp, null);
    assert.equal(result.relativeGateLufs, null); assert.equal(result.absoluteGatedBlockCount, 0);
  }
  for (const level of [-90, -70.1, -69.9]) {
    const result = measure(pcm(48000, i => 10 ** (level / 20) * Math.sin(2 * Math.PI * 1000 * i / RATE)));
    assert.equal(result.state, level < -70 ? 'below_gate' : 'valid');
    if (level < -70) {assert.equal(result.integratedLufs, null); assert.equal(result.relativeGateLufs, null);}
    else near(result.integratedLufs, level, 0.02);
    assert.ok(result.samplePeakLinear > 0);
  }
  assert.equal(measure(pcm(19199, () => 0.01)).state, 'too_short');
  // A nonzero incomplete final hop does not invent a complete gating block.
  const tail = measure(pcm(19201, i => i === 19200 ? 1 : 0));
  assert.equal(tail.state, 'below_gate'); assert.equal(tail.integratedLufs, null);
});

test('channel energy is summed with independent K filters, never phase cancellation', () => {
  const mono = measure(pcm(48000, (i, c) => c ? 0 : 0.1 * Math.sin(2 * Math.PI * 997 * i / RATE)));
  const same = measure(pcm(48000, i => 0.1 * Math.sin(2 * Math.PI * 997 * i / RATE)));
  const opposite = measure(pcm(48000, (i, c) => (c ? -1 : 1) * 0.1 * Math.sin(2 * Math.PI * 997 * i / RATE)));
  near(same.integratedLufs - mono.integratedLufs, 10 * Math.log10(2));
  assert.deepEqual(same, opposite);
});

test('all polyphase coefficients and EOF delay match full causal convolution', () => {
  let random = 0x12345678;
  for (const frames of [1, 2, 4, 11, 12, 13, 24, 97]) {
    const bytes = pcm(frames, () => {random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 0x80000000 - 1;});
    near(measure(bytes, 3).truePeakLinear, referenceTruePeak(bytes), 1e-14);
  }
  // These exact binary-rational goldens require the FIR delayed peak; the
  // original-sample floor alone cannot satisfy them.
  for (const [signal, peak] of [[[1, 1], 1.244873046875], [[1, -1], 1.074462890625],
    [[0.75, -0.75, -0.75, 0.75], 1.208770751953125]]) {
    const bytes = pcm(signal.length, (i, c) => c ? 0 : signal[i]);
    assert.equal(referenceTruePeak(bytes), peak); assert.equal(measure(bytes).truePeakLinear, peak);
  }
});

test('first and final frame peaks, including EOF-only intersample peaks, survive', () => {
  for (const channel of [0, 1]) for (const start of [0, 23]) {
    const bytes = pcm(25, (i, c) => c === channel && (i === start || i === start + 1) ? 1 : 0);
    const result = measure(bytes, 7);
    assert.equal(result.truePeakLinear, 1.244873046875);
    assert.equal(result.sampleFrames, 25); assert.equal(result.gatingBlockCount, 0);
    assert.equal(result.decodedDurationSeconds, 25 / RATE);
  }
});

test('4x interpolation resolves phased intersample peaks without clipping float amplitudes', () => {
  // Synthesized from Tech3341 Table 1 phase/amplitude family, with short
  // tapers so the test measures the sinusoid rather than a cut-edge transient.
  for (const [amplitude, period, phase] of [[0.5, 4, 0], [0.5, 4, Math.PI / 4], [0.5, 6, Math.PI / 3],
    [0.5, 8, 3 * Math.PI / 8], [1.41, 4, Math.PI / 4]]) {
    const bytes = pcm(4096, i => amplitude * Math.sin(2 * Math.PI / period * i + phase) * Math.min(1, i / 480, (4095 - i) / 480));
    const result = measure(bytes, 4093), target = amplitude > 1 ? 3 : -6;
    assert.ok(result.truePeakDbtp >= target - 0.4 && result.truePeakDbtp <= target + 0.2);
    near(result.truePeakLinear, referenceTruePeak(bytes), 1e-13);
    if (phase === Math.PI / 4) assert.ok(result.truePeakDbtp - result.samplePeakDbfs > 2.5);
    if (amplitude > 1) assert.ok(result.truePeakDbtp > 2.5);
  }
});

test('all finite float32 amplitudes remain finite and subnormals are not called silence', () => {
  for (const amplitude of [1.401298464324817e-45, 1e-30, 0.5, 1, 1.25, 3.4028234663852886e38]) {
    const result = measure(pcm(19200, (i, c) => (c ? -1 : 1) * amplitude * Math.sin(Math.PI / 2 * i)));
    assert.equal(result.samplePeakLinear, Math.fround(amplitude));
    assert.ok(Number.isFinite(result.samplePeakDbfs)); assert.ok(Number.isFinite(result.truePeakDbtp));
    assert.ok(result.truePeakLinear >= result.samplePeakLinear); assert.notEqual(result.state, 'digital_silence');
    if (amplitude >= 0.5) {assert.equal(result.state, 'valid'); assert.ok(Number.isFinite(result.integratedLufs));}
    else {assert.equal(result.state, 'below_gate'); assert.equal(result.integratedLufs, null);}
  }
});

test('nonfinite samples in either channel poison all later writes and finish', () => {
  for (const value of [NaN, Infinity, -Infinity]) for (const channel of [0, 1]) {
    const meter = createExportLoudnessAccumulator(19200 / RATE);
    meter.write(pcm(19199, () => 0.25));
    let failure;
    assert.throws(() => meter.write(pcm(1, (_, c) => c === channel ? value : 0.25)), error => {
      failure = error; return error.code === 'LOUDNESS_INVALID_PCM';
    });
    assert.throws(() => meter.finish(), error => error === failure);
    assert.throws(() => meter.write(Buffer.alloc(8)), error => error === failure);
  }
});

test('empty, incomplete byteframes and invalid write values never yield partial reports', () => {
  for (let residual = 0; residual < 8; residual++) {
    const meter = createExportLoudnessAccumulator(0.4);
    meter.write(Buffer.alloc(residual ? 19200 * 8 + residual : 0));
    assert.throws(() => meter.finish(), {code: 'LOUDNESS_INVALID_PCM'});
    assert.throws(() => meter.write(Buffer.alloc(8)), {code: 'LOUDNESS_INVALID_PCM'});
  }
  for (const value of [new Uint8Array(8), null, 'pcm']) {
    const meter = createExportLoudnessAccumulator(0.4);
    assert.throws(() => meter.write(value), {code: 'LOUDNESS_INVALID_PCM'});
    assert.throws(() => meter.finish(), {code: 'LOUDNESS_INVALID_PCM'});
  }
});

test('100ms decoded-duration allowance is inclusive and counts no EOF drain zeros', () => {
  for (const delta of [-4801, -4800, 4800, 4801]) {
    const meter = createExportLoudnessAccumulator(1);
    meter.write(pcm(RATE + delta, i => i === RATE + delta - 1 ? 0.5 : 0));
    if (Math.abs(delta) > 4800) {
      assert.throws(() => meter.finish(), {code: 'LOUDNESS_DURATION_MISMATCH'});
      assert.throws(() => meter.finish(), {code: 'LOUDNESS_DURATION_MISMATCH'});
    } else assert.equal(meter.finish().sampleFrames, RATE + delta);
  }
});

// This opt-in resource-boundary test is intentionally kept outside the quick
// lane. It streams one reusable buffer; it never allocates 600 seconds of PCM.
test('600-second streaming cap includes residual bytes and is terminal', () => {
  const chunk = pcm(RATE, i => 0.1 * Math.sin(2 * Math.PI * 1000 * i / RATE));
  for (const excess of [0, 1, 8]) {
    const meter = createExportLoudnessAccumulator(600);
    for (let second = 0; second < 600; second++) meter.write(chunk);
    if (excess) {
      assert.throws(() => meter.write(Buffer.alloc(excess)), {code: 'LOUDNESS_RESOURCE_LIMIT'});
      assert.throws(() => meter.finish(), {code: 'LOUDNESS_RESOURCE_LIMIT'});
    } else {
      const result = meter.finish(); assert.equal(result.sampleFrames, 28800000);
      assert.equal(result.gatingBlockCount, 5997); assert.equal(result.decodedDurationSeconds, 600);
    }
  }
});
