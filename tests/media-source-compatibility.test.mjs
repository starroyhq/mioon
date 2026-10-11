import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openStore } from '../packages/business/src/db.mjs';
import { run } from '../packages/business/src/media.mjs';
import { mediaExecutable, mediaEnvironment } from '../packages/business/src/media-environment.mjs';
import { createTimelinePreflightServices } from '../packages/business/src/timeline-preflight.mjs';
import { readTimelinePreflightSnapshot, readOwnedTimelineAsset, prepareTimelineInputs, probeTimelineSource } from '../packages/business/src/timeline-sources.mjs';
import { renderTimeline } from '../packages/business/src/timeline-media.mjs';

const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  // Only canonicalize the new test-owned directory; managed input guards still run.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'media-source-compatibility-')));
  const store = openStore(root), preflight = createTimelinePreflightServices(store);
  const project = store.put('projects', { id: randomUUID(), name: 'Synthetic source compatibility' });
  t.after(async () => { await preflight.drain(); store.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, store,
    async source(file, { mimeType, duration = 1, width = 0, height = 0, hasAudio = true, sourceInFrame = 0, durationFrames = 15 }) {
      const bytes = await readFile(file), id = randomUUID();
      const asset = store.put('assets', { id, projectId: project.id, name: 'Synthetic source', relativePath: path.relative(root, file), mimeType, duration, width, height, hasAudio, sizeBytes: bytes.length, sha256: sha(bytes) });
      const trackId = randomUUID();
      const timeline = store.put('timelines', { id: randomUUID(), projectId: project.id, revision: 1, fps: 30, width: 720, height: 1280, durationFrames,
        tracks: [{ id: trackId, name: 'Source', kind: mimeType.startsWith('audio/') ? 'audio' : 'video', orderIndex: 0, hidden: false, muted: false }],
        clips: [{ id: randomUUID(), trackId, assetId: id, name: 'Synthetic clip', startFrame: 0, sourceInFrame, durationFrames, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 }],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      const input = { projectId: project.id, expectedRevision: timeline.revision };
      return { asset, timeline, check: () => preflight.handlers['timeline.export.preflight'](input),
        async prepare() {
          const { snapshot } = readTimelinePreflightSnapshot(store, project.id);
          const assets = await prepareTimelineInputs(snapshot, { root, projectId: project.id, readAsset: assetId => readOwnedTimelineAsset(store.db, project.id, assetId) });
          return { snapshot, assets };
        } };
    },
  };
}
async function ffmpeg(args) { return run('ffmpeg', ['-v', 'error', '-n', '-filter_complex_threads', '1', ...args]); }
async function outputChecks(file, frames) {
  const result = await probeTimelineSource(file);
  assert.equal(result.duration, frames / 30);
  assert.equal(Number(result.probe.streams.find(s => s.codec_type === 'video').nb_frames), frames);
  await ffmpeg(['-i', file, '-f', 'null', '-']);
  return result;
}

// Edit only codec descriptors in our own deterministic MP4. Track/sample data
// remains intact so explicit selection of the later streams still decodes.
function unidentifiedFirstStreams(bytes) {
  const offsets = []; let cursor = 0;
  while ((cursor = bytes.indexOf('stsd', cursor)) !== -1) { offsets.push(cursor); cursor += 4; }
  assert.equal(offsets.length, 4);
  for (const [stream, codec] of [[0, 'avc1'], [2, 'mp4a']]) {
    const offset = offsets[stream];
    assert.equal(bytes.toString('ascii', offset + 16, offset + 20), codec);
    bytes.write('zzzz', offset + 16, 'ascii');
    if (stream === 2) {
      const descriptor = bytes.indexOf('esds', offset), end = offset - 4 + bytes.readUInt32BE(offset - 4);
      assert.ok(descriptor > offset && descriptor < end);
      bytes.write('zzzz', descriptor, 'ascii');
    }
  }
  return bytes;
}

test('unknown WAV codec blocks preflight and preparation before an inevitably failing audio export', async t => {
  const f = await fixture(t), file = path.join(f.root, 'media', 'unknown.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', file]);
  const bytes = await readFile(file), fmt = bytes.indexOf('fmt ');
  assert.ok(fmt > 0); bytes.writeUInt16LE(0xffff, fmt + 8); await writeFile(file, bytes);
  const raw = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  assert.equal(raw.streams[0].codec_type, 'audio');
  assert.equal(raw.streams[0].codec_name, undefined);
  assert.equal(Number(raw.format.duration), 1);
  await assert.rejects(ffmpeg(['-i', file, '-map', '0:0', '-f', 'null', '-']), { code: 'MEDIA_EXIT_FAILED' });
  const source = await f.source(file, { mimeType: 'audio/wav' });
  const report = await source.check();
  assert.equal(report.status, 'blocked');
  assert.equal(report.issues[0].code, 'PREFLIGHT_MEDIA_INVALID');
  await assert.rejects(source.prepare(), { code: 'MEDIA_NO_STREAM' });
});

test('preflight and renderer select later identified video/audio streams when the first codecs are unknown', async t => {
  const f = await fixture(t), file = path.join(f.root, 'media', 'mixed.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=32x32:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1',
    '-map', '0:v', '-map', '1:v', '-map', '2:a', '-map', '3:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '1', '-c:a', 'aac', file]);
  await writeFile(file, unidentifiedFirstStreams(await readFile(file)));
  const raw = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]));
  assert.deepEqual(raw.streams.map(s => s.codec_name), [undefined, 'h264', undefined, 'aac']);
  await ffmpeg(['-i', file, '-map', '0:1', '-map', '0:3', '-f', 'null', '-']);
  const source = await f.source(file, { mimeType: 'video/mp4', width: 32, height: 32 });
  const report = await source.check(); assert.equal(report.status, 'ready', JSON.stringify(report));
  assert.equal(report.summary.audibleClipCount, 1); assert.equal(report.checks.fullDecode, false);
  const { snapshot, assets } = await source.prepare(), destination = path.join(f.root, 'output.mp4');
  await renderTimeline(snapshot, assets, destination);
  assert.equal(assets.get(source.asset.id).videoStreamIndex, 1);
  assert.equal(assets.get(source.asset.id).audioStreamIndex, 3);
  await outputChecks(destination, 15);
  const { stdout: pixel } = await exec(mediaExecutable('ffmpeg'), ['-v', 'error', '-i', destination, '-vf', 'crop=2:2:360:640,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: 'buffer', env: mediaEnvironment() });
  assert.ok(pixel[2] > 200 && pixel[0] < 25 && pixel[1] < 25, `expected later blue video, got ${[...pixel.subarray(0, 3)]}`);
  const { stdout: pcm } = await exec(mediaExecutable('ffmpeg'), ['-v', 'error', '-i', destination, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { encoding: 'buffer', env: mediaEnvironment() });
  const amplitude = frequency => {
    let real = 0, imaginary = 0; const from = 4800, to = 19200;
    for (let i = from; i < to; i++) { const value = pcm.readFloatLE(i * 4), phase = 2 * Math.PI * frequency * i / 48000; real += value * Math.cos(phase); imaginary += value * Math.sin(phase); }
    return 2 * Math.hypot(real, imaginary) / (to - from);
  };
  assert.ok(amplitude(880) > .02); assert.ok(amplitude(880) > amplitude(440) * 8);
});

test('attached cover stays nonvisual and audio-only preflight matches an audible export', async t => {
  const f = await fixture(t), file = path.join(f.root, 'media', 'cover.m4a'), cover = path.join(f.root, 'cover.jpg');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=32x32:d=1', '-frames:v', '1', '-c:v', 'mjpeg', '-threads', '1', cover]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1', '-i', cover,
    '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'copy', '-disposition:v', 'attached_pic', file]);
  const metadata = await probeTimelineSource(file);
  assert.equal(metadata.hasVideo, false); assert.equal(metadata.hasAudio, true);
  assert.equal(metadata.probe.streams.filter(s => s.disposition?.attached_pic).length, 1);
  const source = await f.source(file, { mimeType: 'audio/mp4' });
  const report = await source.check(); assert.equal(report.status, 'ready', JSON.stringify(report)); assert.equal(report.summary.visualClipCount, 0); assert.equal(report.summary.audibleClipCount, 1);
  const { snapshot, assets } = await source.prepare(), destination = path.join(f.root, 'output.mp4');
  await renderTimeline(snapshot, assets, destination); await outputChecks(destination, 15);
  const { stdout: pcm } = await exec(mediaExecutable('ffmpeg'), ['-v', 'error', '-i', destination, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { encoding: 'buffer', env: mediaEnvironment() });
  let energy = 0;
  for (let i = 4800; i < 19200; i++) energy += pcm.readFloatLE(i * 4) ** 2;
  assert.ok(Math.sqrt(energy / 14400) > .02, 'cover must not displace the audible source');
});
