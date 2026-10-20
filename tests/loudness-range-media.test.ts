import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createLoudnessRangeMeter} from '../packages/business/src/loudness-range-meter.ts';
import {loudnessRangeMeasurementSchema} from '../packages/contracts/src/loudness-range.ts';
import {mediaEnvironment, mediaExecutable} from '../packages/business/src/media-environment.ts';

const RATE = 48000;
function levelsPcm(levels: number[], segmentSeconds: number): Buffer {
  const frames = RATE * segmentSeconds * levels.length, bytes = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) {
    const level = levels[Math.floor(i / (RATE * segmentSeconds))];
    const sample = 10 ** (level / 20) * Math.sin(2 * Math.PI * 1000 * i / RATE);
    bytes.writeFloatLE(sample, i * 8); bytes.writeFloatLE(sample, i * 8 + 4);
  }
  return bytes;
}
function ffmpeg(bytes: Buffer, filter: string): string {
  const result = spawnSync(mediaExecutable('ffmpeg'), ['-hide_banner', '-nostats', '-loglevel', 'info', '-nostdin',
    '-threads', '1', '-filter_threads', '1', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
    '-af', filter, '-f', 'null', '-'], {input: bytes, encoding: 'utf8', env: mediaEnvironment(), timeout: 30000, maxBuffer: 1024 * 1024});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stderr;
}

// Local generated PCM only. These independent implementation checks are not
// a certification or the authentic programme signals of the EBU test set.
test('Tech3342 two-tone vectors agree with independent FFmpeg ebur128 and loudnorm LRA', {timeout: 90000}, () => {
  for (const [levels, expected] of [[[-20, -30], 10], [[-20, -15], 5], [[-40, -20], 20]] as const) {
    const bytes = levelsPcm([...levels], 20), meter = createLoudnessRangeMeter();
    for (let offset = 0; offset < bytes.length; offset += 65521) meter.push(bytes.subarray(offset, offset + 65521));
    const measurement = meter.finish(40);
    assert.equal(loudnessRangeMeasurementSchema.safeParse(measurement).success, true);
    assert.equal(measurement.state, 'valid'); assert.notEqual(measurement.loudnessRangeLu, null);
    assert.ok(Math.abs(measurement.loudnessRangeLu! - expected) < 0.1);
    const ebur = [...ffmpeg(bytes, 'ebur128=peak=true').matchAll(/LRA:\s*(-?\d+(?:\.\d+)?) LU/gu)].at(-1);
    assert.ok(ebur, 'FFmpeg ebur128 must emit a real final LRA');
    const norm = [...ffmpeg(bytes, 'loudnorm=I=-23:LRA=7:TP=-1:print_format=json').matchAll(/"input_lra"\s*:\s*"(-?\d+(?:\.\d+)?)"/gu)].at(-1);
    assert.ok(norm, 'FFmpeg loudnorm must emit a real input LRA');
    assert.ok(Math.abs(measurement.loudnessRangeLu! - Number(ebur[1])) <= 0.2, `${measurement.loudnessRangeLu} vs ebur128 ${ebur[1]}`);
    assert.ok(Math.abs(measurement.loudnessRangeLu! - Number(norm[1])) <= 0.2, `${measurement.loudnessRangeLu} vs loudnorm ${norm[1]}`);
  }
});

test('four-level dynamic signal agrees with FFmpeg independently of uniform gain', {timeout: 30000}, () => {
  const bytes = levelsPcm([-35, -15, -25, -20], 7), meter = createLoudnessRangeMeter();
  meter.push(bytes); const result = meter.finish(28);
  const reference = [...ffmpeg(bytes, 'ebur128').matchAll(/LRA:\s*(-?\d+(?:\.\d+)?) LU/gu)].at(-1);
  assert.ok(reference); assert.equal(result.state, 'valid');
  assert.ok(result.loudnessRangeLu! > 15 && result.loudnessRangeLu! < 21);
  assert.ok(Math.abs(result.loudnessRangeLu! - Number(reference[1])) <= 0.3, `${result.loudnessRangeLu} vs ebur128 ${reference[1]}`);
});
