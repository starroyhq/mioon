import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, copyFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openStore } from '../packages/business/src/db.mjs';
import { createServices } from '../packages/business/src/services.mjs';
import { createMockProvider } from '../packages/business/src/providers/mock.mjs';
import { startWorker } from '../packages/business/src/jobs.mjs';
import { run, probe, stitch, fileHash } from '../packages/business/src/media.mjs';
import { mediaExecutable, mediaEnvironment } from '../packages/business/src/media-environment.mjs';

const exec = promisify(execFile);
const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p'];
const ffmpeg = args => run('ffmpeg', ['-v', 'error', '-n', '-filter_complex_threads', '1', ...args]);
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'storyboard-multistream-'))), f = { root };
  t.after(async () => { await f.worker?.stop(); await f.services?.drain(); f.store?.close(); await rm(root, { recursive: true, force: true }); });
  return f;
}
async function decode(file, args) {
  const { stdout } = await exec(mediaExecutable('ffmpeg'), ['-v', 'error', '-i', file, ...args], { encoding: 'buffer', env: mediaEnvironment(), maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}
async function checkOutput(file, seconds, color, frequency) {
  const info = await probe(file), video = info.probe.streams.find(s => s.codec_type === 'video');
  assert.equal(info.width, 720); assert.equal(info.height, 1280);
  assert.equal(Number(video.nb_frames), seconds * 30); assert.ok(Math.abs(info.duration - seconds) < .04);
  await ffmpeg(['-i', file, '-f', 'null', '-']);
  const pixel = await decode(file, ['-vf', 'crop=2:2:360:640,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']);
  assert.ok(color.every((v, i) => Math.abs(v - pixel[i]) < 25), `expected ${color}, received ${[...pixel.subarray(0, 3)]}`);
  const pcm = await decode(file, ['-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
  const from = 4800, to = 19200;
  let energy = 0; for (let i = from; i < to; i++) energy += pcm.readFloatLE(i * 4) ** 2;
  const rms = Math.sqrt(energy / (to - from));
  if (frequency === null) assert.ok(rms < .002, `expected silence, got RMS ${rms}`);
  else {
    const amplitude = hz => {
      let re = 0, im = 0;
      for (let i = from; i < to; i++) { const v = pcm.readFloatLE(i * 4), angle = 2 * Math.PI * hz * i / 48000; re += v * Math.cos(angle); im += v * Math.sin(angle); }
      return 2 * Math.hypot(re, im) / (to - from);
    };
    assert.ok(amplitude(frequency) > .02);
    if (frequency === 880) assert.ok(amplitude(880) > 8 * amplitude(440), 'must use the later audio stream');
  }
}
function unknownFirstCodecs(bytes) {
  const offsets = []; let cursor = 0;
  while ((cursor = bytes.indexOf('stsd', cursor)) !== -1) { offsets.push(cursor); cursor += 4; }
  assert.equal(offsets.length, 4);
  for (const [index, codec] of [[0, 'avc1'], [2, 'mp4a']]) {
    const offset = offsets[index]; assert.equal(bytes.toString('ascii', offset + 16, offset + 20), codec);
    bytes.write('zzzz', offset + 16, 'ascii');
    if (index === 2) {
      const esds = bytes.indexOf('esds', offset), end = offset - 4 + bytes.readUInt32BE(offset - 4);
      assert.ok(esds > offset && esds < end); bytes.write('zzzz', esds, 'ascii');
    }
  }
  return bytes;
}

test('provider output passes real version publication but storyboard must use the identified later streams', async t => {
  const f = await fixture(t), source = path.join(f.root, 'source.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=32x32:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=72x128:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2',
    '-map', '0:v', '-map', '1:v', '-map', '2:a', '-map', '3:a', ...encode, '-c:a', 'aac', '-ac:a:1', '2',
    '-disposition:v:0', '0', '-disposition:v:1', 'default', '-disposition:a:0', '0', '-disposition:a:1', 'default', source]);
  await writeFile(source, unknownFirstCodecs(await readFile(source)));
  const metadata = await probe(source);
  assert.deepEqual(metadata.probe.streams.map(s => s.codec_name), [undefined, 'h264', undefined, 'aac']);
  assert.equal(metadata.videoStreamIndex, 1); assert.equal(metadata.audioStreamIndex, 3);
  // Exact default decode used by the worker, not a hand-selected map bypass.
  await run('ffmpeg', ['-v', 'error', '-i', source, '-f', 'null', '-']);
  const hash = await fileHash(source);
  f.store = openStore(f.root);
  const mock = createMockProvider({ root: f.root, db: f.store.db }); let downloads = 0;
  // Only simulate the provider download bytes. Submission/polling, validation,
  // publication, automatic selection and export run the real service/worker.
  const provider = { ...mock, download: async (_id, destination, { signal }) => {
    assert.equal(signal.aborted, false); downloads++; await copyFile(source, destination);
  } };
  const providers = new Map([['mock', provider]]); f.services = createServices(f.store, providers);
  const project = await f.services.call('project.create', { name: 'Synthetic storyboard' });
  const shot = await f.services.call('shot.create', { projectId: project.id, title: 'Multistream output', prompt: 'Synthetic download fixture', duration: 2, referenceAssetIds: [] });
  const job = await f.services.call('generation.submit', { shotId: shot.id, expectedRevision: shot.revision, providerId: 'mock', requestId: randomUUID(), parameters: { scenario: 'success', delayMs: 0 } });
  f.worker = startWorker(f.store, f.services, providers);
  for (let i = 0; i < 10 && f.store.get('jobs', job.id).status !== 'succeeded'; i++) await f.worker.tick();
  const completed = await f.services.call('job.get', { jobId: job.id }); assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
  const version = f.store.get('versions', completed.versionId), asset = f.store.get('assets', version.assetId);
  assert.equal(f.store.get('shots', shot.id).selectedVersionId, version.id);
  assert.equal(version.sha256, hash); assert.equal(asset.sha256, hash);
  const published = path.join(f.root, asset.relativePath); assert.equal(await fileHash(published), hash);
  assert.equal((await probe(published)).probe.streams.length, 4);
  const frozenVersion = structuredClone(version), frozenAsset = structuredClone(asset);
  const queued = await f.services.call('export.create', { projectId: project.id, requestId: randomUUID() });
  assert.equal(queued.snapshot[0].versionId, version.id); assert.equal(queued.snapshot[0].sha256, hash);
  await f.worker.tick();
  const exported = await f.services.call('export.get', { exportId: queued.id });
  assert.equal(exported.status, 'succeeded', JSON.stringify(exported));
  const output = f.store.get('assets', exported.assetId);
  await checkOutput(path.join(f.root, output.relativePath), 2, [0, 0, 255], 880);
  assert.deepEqual(f.store.get('versions', version.id), frozenVersion); assert.deepEqual(f.store.get('assets', asset.id), frozenAsset);
  assert.equal(await fileHash(published), hash); assert.equal(await fileHash(source), hash);
  assert.equal(downloads, 1); assert.equal(mock.stats().submissionCount, 1);
  assert.equal((await readdir(path.join(f.root, 'media'))).some(name => name.includes('.part')), false);
});

test('stitch preserves ordinary audio, silent video and video with an attached cover', async t => {
  const f = await fixture(t), plain = path.join(f.root, 'plain.mp4'), silent = path.join(f.root, 'silent.mp4'), cover = path.join(f.root, 'cover.jpg'), covered = path.join(f.root, 'covered.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=yellow:s=72x128:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1', ...encode, '-c:a', 'aac', plain]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=72x128:r=30:d=1', ...encode, silent]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', '-c:v', 'mjpeg', '-threads', '1', cover]);
  await ffmpeg(['-i', cover, '-i', silent, '-map', '0:v', '-map', '1:v', '-c', 'copy', '-disposition:v:0', 'attached_pic', '-disposition:v:1', 'default', covered]);
  const coverMetadata = await probe(covered); assert.equal(coverMetadata.probe.streams.filter(s => s.disposition?.attached_pic).length, 1);
  for (const [name, file, color, frequency] of [['ordinary', plain, [255, 255, 0], 660], ['silent', silent, [0, 0, 255], null], ['covered', covered, [0, 0, 255], null]]) {
    await t.test(name, async () => {
      const hash = await fileHash(file), output = path.join(f.root, `${name}-out.mp4`);
      await stitch([file], output); await checkOutput(output, 1, color, frequency); assert.equal(await fileHash(file), hash);
    });
  }
});

test('stitch rejects an audio-only cover without creating an output', async t => {
  const f = await fixture(t), source = path.join(f.root, 'audio-cover.m4a'), cover = path.join(f.root, 'cover.jpg');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', '-c:v', 'mjpeg', '-threads', '1', cover]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1', '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'copy', '-disposition:v', 'attached_pic', source]);
  assert.equal((await probe(source)).hasVideo, false);
  const hash = await fileHash(source), output = path.join(f.root, 'never.mp4');
  await assert.rejects(stitch([source], output), /Export input has no video stream/);
  await assert.rejects(stat(output), { code: 'ENOENT' }); assert.equal(await fileHash(source), hash);
});
