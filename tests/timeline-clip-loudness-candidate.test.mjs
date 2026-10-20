import test from 'node:test';
import assert from 'node:assert/strict';
import {createExportLoudnessAccumulator} from '../packages/business/src/export-loudness-meter.ts';
import {prepareTimelineClipLoudnessCandidate} from '../packages/business/src/timeline-clip-loudness-candidate.ts';

function signal(seconds, amplitude) {
  const pcm = Buffer.alloc(seconds * 48000 * 8);
  for (let frame = 0; frame < seconds * 48000; frame++) {
    const value = amplitude(frame) * Math.sin(2 * Math.PI * 997 * frame / 48000);
    pcm.writeFloatLE(value, frame * 8); pcm.writeFloatLE(-value, frame * 8 + 4);
  }
  const meter = createExportLoudnessAccumulator(seconds); meter.write(pcm);
  return {pcm, original: meter.finish()};
}
const target = {integratedLufs: -24, truePeakCeilingDbtp: -1};

test('candidate re-gates the actual scaled PCM instead of predicting the target arithmetically', async () => {
  // Most of the clip starts below the absolute gate. Boosting reveals it and
  // changes the relative gate too, so a fixed gain does not reach the target.
  const source = signal(20, frame => frame < 96000 ? .001 : .00015);
  const report = await prepareTimelineClipLoudnessCandidate({...source, target: {...target, integratedLufs: -40}, beforeGain: .01, fence() {}});
  assert.equal(report.status, 'measured'); assert.equal(report.meetsTarget, false);
  assert.equal(report.meetsTruePeak, true); assert.equal(report.measuredPcmBytes, 7680000);
  assert.equal(source.original.absoluteGatedBlockCount, 20);
  assert.equal(report.measurement.absoluteGatedBlockCount, 197);
  assert.ok(Math.abs(report.measurement.integratedLufs + 49.089) < .001);
  assert.ok(report.measurement.integratedLufs < -48);
  assert.equal(report.applyAllowed, false);
});

test('valid constant gain hits the explicit target and preserves the exact multiplier', async () => {
  const source = signal(2, () => .1);
  const report = await prepareTimelineClipLoudnessCandidate({...source, target, beforeGain: .75, fence() {}});
  assert.equal(report.status, 'measured'); assert.equal(report.meetsTarget, true); assert.equal(report.meetsTruePeak, true);
  assert.equal(report.beforeGain, .75); assert.equal(report.afterGain, .75 * report.gainMultiplier);
  assert.ok(Math.abs(report.measurement.integratedLufs - target.integratedLufs) < 1e-6);
  assert.equal(report.measurement.sampleFrames, source.original.sampleFrames);
  assert.equal(report.measuredPcmBytes, source.pcm.length);
});

test('true-peak reserve refuses a target without silently lowering it or clipping transient samples', async () => {
  const source = signal(2, () => .01);
  source.pcm.writeFloatLE(.5, 48000 * 8); source.pcm.writeFloatLE(-.5, 48000 * 8 + 4);
  const meter = createExportLoudnessAccumulator(2); meter.write(source.pcm); source.original = meter.finish();
  const report = await prepareTimelineClipLoudnessCandidate({...source, target: {...target, integratedLufs: -10}, beforeGain: .01, fence() {}});
  assert.equal(report.status, 'measured'); assert.equal(report.meetsTarget, true); assert.equal(report.meetsTruePeak, false);
  assert.ok(report.measurement.samplePeakLinear > 1); assert.ok(report.measurement.truePeakDbtp > 0);
  assert.equal(report.requiredGainDb, -10 - source.original.integratedLufs);
  assert.ok(Math.abs(report.measurement.integratedLufs + 10) < .1);
});

test('silence and gain outside the saved 0–2 range stay unavailable with no candidate meter pass', async () => {
  for (const [source, beforeGain, requested, reason] of [
    [signal(1, () => 0), 1, target, 'NO_VALID_LOUDNESS'],
    [signal(1, () => .001), 1, {...target, integratedLufs: -5}, 'GAIN_OUT_OF_RANGE'],
  ]) {
    const before = Buffer.from(source.pcm);
    const report = await prepareTimelineClipLoudnessCandidate({...source, beforeGain, target: requested, fence() {}});
    assert.equal(report.status, 'unavailable'); assert.equal(report.reason, reason);
    assert.equal(report.afterGain, null); assert.equal(report.measurement, null); assert.equal(report.measuredPcmBytes, 0);
    assert.equal(report.meetsTarget, false); assert.equal(report.meetsTruePeak, false); assert.deepEqual(source.pcm, before);
  }
});

test('candidate slices retain cancellation fences and refuse incomplete PCM', async () => {
  const source = signal(2, () => .1); let fences = 0;
  const cancelled = Object.assign(new Error('cancelled'), {code: 'OPERATION_CANCELLED'});
  await assert.rejects(prepareTimelineClipLoudnessCandidate({...source, beforeGain: .75, target,
    fence() {if (++fences === 4) throw cancelled;}}), cancelled);
  await assert.rejects(prepareTimelineClipLoudnessCandidate({...source, pcm: source.pcm.subarray(0, -8), beforeGain: .75, target, fence() {}}), {code: 'LOUDNESS_INVALID_PCM'});
});
