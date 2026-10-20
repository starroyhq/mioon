import test from 'node:test';
import assert from 'node:assert/strict';
import {isTimelineClipLoudnessResponse} from '../packages/contracts/src/timeline-clip-loudness.ts';
import {matchedClipLoudness, matchInput} from './fixtures/clip-loudness-match-fixtures.ts';
import {readyClipLoudness, clipLoudnessInput} from './fixtures/timeline-clip-loudness-fixtures.ts';
import {createLoudnessRangeMeter} from '../packages/business/src/loudness-range-meter.ts';
import {createExportLoudnessAccumulator} from '../packages/business/src/export-loudness-meter.ts';
import {prepareTimelineClipLoudnessCandidate} from '../packages/business/src/timeline-clip-loudness-candidate.ts';

function highAmplitudeReport() {
  const report = matchedClipLoudness();
  // Finite float PCM can exceed full scale. Preserve the logarithmic/linear
  // relationships while exercising a very small supported attenuation.
  report.measurement.integratedLufs += 280;
  report.measurement.relativeGateLufs += 280;
  report.measurement.samplePeakLinear *= 1e14;
  report.measurement.samplePeakDbfs += 280;
  report.measurement.truePeakLinear *= 1e14;
  report.measurement.truePeakDbtp += 280;
  report.candidate.requiredGainDb = matchInput.target.integratedLufs - report.measurement.integratedLufs;
  report.candidate.gainMultiplier = 10 ** (report.candidate.requiredGainDb / 20);
  report.candidate.afterGain = report.identity.gain * report.candidate.gainMultiplier;
  return report;
}
function signal(seconds: number, amplitude: number): {pcm: Buffer; original: ReturnType<ReturnType<typeof createExportLoudnessAccumulator>['finish']>} {
  const pcm = Buffer.alloc(seconds * 48000 * 8);
  for (let frame = 0; frame < seconds * 48000; frame++) {
    const sample = amplitude * Math.sin(2 * Math.PI * 997 * frame / 48000);
    pcm.writeFloatLE(sample, frame * 8); pcm.writeFloatLE(-sample, frame * 8 + 4);
  }
  const meter = createExportLoudnessAccumulator(seconds); meter.write(pcm);
  return {pcm, original: meter.finish()};
}

test('candidate exact small positive attenuation cannot be replaced within an absolute epsilon', () => {
  const valid = highAmplitudeReport();
  assert.equal(isTimelineClipLoudnessResponse(valid, matchInput), true);
  assert.ok(valid.candidate.afterGain < 1e-14);
  for (const field of ['gainMultiplier', 'afterGain'] as const) {
    const forged = highAmplitudeReport(); forged.candidate[field] = 1e-11;
    assert.equal(isTimelineClipLoudnessResponse(forged, matchInput), false, `${field} must be relatively bound even below 1e-10`);
  }
});

test('same PCM binds the range peak exactly while legacy reports remain valid without LRA', () => {
  const report = readyClipLoudness();
  assert.equal(isTimelineClipLoudnessResponse(report, clipLoudnessInput), true);
  const rangeMeter = createLoudnessRangeMeter();
  rangeMeter.push(Buffer.alloc(48000 * 8));
  const forged = {...report, loudnessRange: rangeMeter.finish(1)};
  assert.equal(forged.loudnessRange.state, 'too_short');
  assert.equal(forged.loudnessRange.sampleFrames, report.measurement.sampleFrames);
  assert.notEqual(forged.loudnessRange.samplePeakLinear, report.measurement.samplePeakLinear);
  assert.equal(isTimelineClipLoudnessResponse(forged, clipLoudnessInput), false);
});

test('response target identity includes both fields and rejects an omitted requested candidate', () => {
  const report = matchedClipLoudness();
  assert.equal(isTimelineClipLoudnessResponse(report, matchInput), true);
  for (const target of [{...matchInput.target, integratedLufs: -23.00001},
    {...matchInput.target, truePeakCeilingDbtp: -1.00001}])
    assert.equal(isTimelineClipLoudnessResponse(report, {...matchInput, target}), false);
  const {candidate: _candidate, ...omitted} = report;
  assert.equal(isTimelineClipLoudnessResponse(omitted, matchInput), false);
  let calls = 0;
  const hostile = {...report, get target() {calls++; return matchInput.target;}};
  assert.equal(isTimelineClipLoudnessResponse(hostile, matchInput), false); assert.equal(calls, 0);
});

test('candidate accepts exact gain 2 and refuses a mathematically larger gain without clamping', async () => {
  const source = signal(1, 0.1);
  assert.equal(source.original.state, 'valid');
  const level = source.original.integratedLufs!;
  const exact = await prepareTimelineClipLoudnessCandidate({...source, pcm: Buffer.from(source.pcm),
    target: {integratedLufs: level, truePeakCeilingDbtp: -1}, beforeGain: 2, fence() {}});
  assert.equal(exact.status, 'measured');
  if (exact.status !== 'measured') throw Error('Expected measured candidate.');
  assert.equal(exact.afterGain, 2); assert.equal(exact.gainMultiplier, 1);
  const excessive = await prepareTimelineClipLoudnessCandidate({...source, pcm: Buffer.from(source.pcm),
    target: {integratedLufs: level + 0.000001, truePeakCeilingDbtp: -1}, beforeGain: 2, fence() {}});
  assert.equal(excessive.status, 'unavailable'); assert.equal(excessive.reason, 'GAIN_OUT_OF_RANGE');
  assert.equal(excessive.afterGain, null); assert.equal(excessive.measuredPcmBytes, 0);
});

test('candidate measurement includes float32 scaling and fresh EOF true-peak reconstruction', async () => {
  const source = signal(1, .071);
  source.pcm.writeFloatLE(.75, source.pcm.length - 16); source.pcm.writeFloatLE(.75, source.pcm.length - 8);
  const originalMeter = createExportLoudnessAccumulator(1); originalMeter.write(source.pcm); source.original = originalMeter.finish();
  const candidate = await prepareTimelineClipLoudnessCandidate({...source, pcm: Buffer.from(source.pcm),
    target: {integratedLufs: -28, truePeakCeilingDbtp: -1}, beforeGain: .25, fence() {}});
  assert.equal(candidate.status, 'measured');
  if (candidate.status !== 'measured') throw Error('Expected measured candidate.');
  const independentScaled = Buffer.alloc(source.pcm.length);
  for (let offset = 0; offset < source.pcm.length; offset += 4)
    independentScaled.writeFloatLE(Math.fround(source.pcm.readFloatLE(offset) * candidate.gainMultiplier), offset);
  const checkMeter = createExportLoudnessAccumulator(1); checkMeter.write(independentScaled);
  assert.deepEqual(candidate.measurement, checkMeter.finish());
  assert.ok(candidate.measurement.truePeakLinear > candidate.measurement.samplePeakLinear);
});
