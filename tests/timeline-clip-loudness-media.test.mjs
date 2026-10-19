import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {createExportLoudnessAccumulator} from '../packages/business/src/export-loudness-meter.ts';

// Fixed generated local fixtures. Run only in the parent-owned serial media lane.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function wav(seconds, rate = 44100, channels = 1) {
  const frames = Math.round(seconds * rate), bytes = Buffer.alloc(44 + frames * channels * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 4, 28); bytes.writeUInt16LE(channels * 4, 32); bytes.writeUInt16LE(32, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++)
    bytes.writeFloatLE(.2 * Math.sin(2 * Math.PI * 997 * frame / rate), 44 + (frame * channels + channel) * 4);
  return bytes;
}
async function manifest(root) {
  const result = [];
  for (const file of await readdir(root, {recursive: true, withFileTypes: true})) {
    if (!file.isFile() || /^workbench\.sqlite(?:-wal|-shm|-journal)?$/.test(file.name) || file.name === 'server.lock') continue;
    const full = path.join(file.parentPath, file.name); result.push([path.relative(root, full), sha(await readFile(full))]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}

test('saved false audio metadata is verified against real video bytes and genuine no-audio is explicitly refused', async t => {
  for (const actualAudio of [true, false]) await t.test(actualAudio ? 'false metadata with real AAC refuses' : 'verified silent video refuses without fake measurement', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'mioon-mix-loudness-presence-')), store = openStore(root), services = createServices(store, new Map());
    t.after(async () => {await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
    const project = await services.call('project.create', {name: 'Real source audio presence'});
    let timeline = await services.call('timeline.get', {projectId: project.id});
    const id = randomUUID(), relativePath = `media/${id}.mp4`, file = path.join(root, relativePath), soundFile = path.join(root, 'media', 'presence-fixture.wav');
    if (actualAudio) await writeFile(soundFile, wav(1, 48000, 2));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-threads', '1', '-filter_threads', '1',
      '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=30:d=1', ...(actualAudio ? ['-i', soundFile] : []), '-t', '1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      ...(actualAudio ? ['-c:a', 'aac', '-ar', '48000', '-ac', '2'] : ['-an']), file],
      {timeout: 30000, maxStdoutBytes: 0, maxStderrBytes: 65536});
    const bytes = await readFile(file), asset = {id, projectId: project.id, name: 'Observed video presence.mp4', mimeType: 'video/mp4', relativePath,
      sha256: sha(bytes), sizeBytes: bytes.length, duration: 1, hasAudio: false, hasVideo: true, width: 16, height: 16,
      url: `/media/${id}`, createdAt: new Date().toISOString()};
    store.put('assets', asset);
    timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
      trackId: timeline.tracks.find(track => track.kind === 'video').id, assetId: id, startFrame: 0, durationFrames: 30, gain: 1});
    const input = {projectId: project.id, timelineId: timeline.id, expectedRevision: timeline.revision, clipId: timeline.clips[0].id, expectedAssetSha256: asset.sha256, measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1'};
    const rows = () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
      .map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    const before = {rows: rows(), changes: store.db.prepare('SELECT total_changes() AS n').get().n, files: await manifest(root)};
    await assert.rejects(services.call('timeline.clip.loudness', input), {code: actualAudio ? 'TIMELINE_CLIP_LOUDNESS_SOURCE_METADATA_MISMATCH' : 'TIMELINE_CLIP_LOUDNESS_NO_AUDIO'});
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before.changes);
    assert.deepEqual(rows(), before.rows); assert.deepEqual(await manifest(root), before.files);
  });
});

test('real selected post-gain/fade clip matches independently assembled PCM reference, not unrelated overlap or leading silence', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-clip-loudness-real-')), store = openStore(root), services = createServices(store, new Map());
  t.after(async () => {await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const project = await services.call('project.create', {name: 'Synthetic independent selected clip'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const bytes = wav(3), id = randomUUID();
  const asset = {id, projectId: project.id, name: 'Bounded mono 44.1k.wav', mimeType: 'audio/wav', relativePath: `media/${id}.wav`,
    sha256: sha(bytes), sizeBytes: bytes.length, duration: 3, hasAudio: true, hasVideo: false, width: 0, height: 0,
    url: `/media/${id}`, createdAt: new Date().toISOString()};
  await writeFile(path.join(root, asset.relativePath), bytes, {mode: 0o600}); store.put('assets', asset);
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'audio').id, assetId: id, startFrame: 91, durationFrames: 60,
    sourceInFrame: 17, gain: .75, fadeInFrames: 5, fadeOutFrames: 8});
  const selected = timeline.clips[0], inputFor = () => ({projectId: project.id, timelineId: timeline.id, expectedRevision: timeline.revision,
    clipId: selected.id, expectedAssetSha256: asset.sha256, measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1'});
  const rows = () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const checkpoint = async () => ({rows: rows(), changes: store.db.prepare('SELECT total_changes() AS n').get().n, files: await manifest(root)});
  const unchanged = async before => {assert.deepEqual(rows(), before.rows); assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before.changes); assert.deepEqual(await manifest(root), before.files);};
  const before = await checkpoint(), report = await services.call('timeline.clip.loudness', inputFor()); await unchanged(before);
  assert.equal(report.measurement.sampleFrames, 96000); assert.equal(report.identity.startFrame, 91); assert.equal(report.identity.sourceInFrame, 17);
  assert.equal(report.checks.passes, 1); assert.equal(report.checks.segmentCount, 1); assert.equal(report.measurement.state, 'valid');
  // Independent literal reference: no shared graph helper and no other inputs.
  const meter = createExportLoudnessAccumulator(2);
  await runStreaming('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-threads', '1', '-filter_threads', '1',
    '-ss', (17 / 30).toFixed(9), '-t', (61 / 30).toFixed(9), '-i', path.join(root, asset.relativePath),
    '-af', 'asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.75,apad,atrim=end_sample=96000,asettb=1/48000,asetpts=N+0,afade=t=in:ss=0:ns=8000:curve=tri,afade=t=out:ss=83200:ns=12800:curve=tri,asetpts=N/SR/TB',
    '-vn', '-sn', '-dn', '-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1'],
    {timeout: 30000, maxStdoutBytes: 768000, maxStderrBytes: 65536, onStdout: chunk => meter.write(chunk)});
  assert.deepEqual(report.measurement, meter.finish());
  timeline = await services.call('timeline.track.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), kind: 'audio'});
  const track = timeline.tracks.at(-1);
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: track.id, assetId: id, startFrame: 100, durationFrames: 7, sourceInFrame: 0, gain: 2});
  const secondBefore = await checkpoint(), second = await services.call('timeline.clip.loudness', inputFor()); await unchanged(secondBefore);
  assert.deepEqual(second.measurement, report.measurement); assert.deepEqual(second.checks, report.checks);
  assert.notEqual(second.identity.snapshotSha256, report.identity.snapshotSha256);
  assert.equal(store.list('exports', project.id).length, 0);
});

test('real digital silence, short material and low gated signal retain existing meter states', async t => {
  for (const [name, durationFrames, amplitude, state] of [['silence', 30, 0, 'digital_silence'], ['short', 3, 1, 'too_short'], ['quiet', 30, 1e-6, 'below_gate']]) await t.test(name, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'mioon-clip-loudness-states-')), store = openStore(root), services = createServices(store, new Map());
    t.after(async () => {await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
    const project = await services.call('project.create', {name}); let timeline = await services.call('timeline.get', {projectId: project.id});
    const bytes = wav(1, 48000, 2); for (let i = 44; i < bytes.length; i += 4) bytes.writeFloatLE(bytes.readFloatLE(i) * amplitude, i);
    const id = randomUUID(), asset = {id, projectId: project.id, name: name + '.wav', mimeType: 'audio/wav', relativePath: `media/${id}.wav`,
      sha256: sha(bytes), sizeBytes: bytes.length, duration: 1, hasAudio: true, hasVideo: false, width: 0, height: 0, url: `/media/${id}`, createdAt: new Date().toISOString()};
    await writeFile(path.join(root, asset.relativePath), bytes); store.put('assets', asset);
    timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
      trackId: timeline.tracks.find(track => track.kind === 'audio').id, assetId: id, startFrame: 10, durationFrames, gain: 1});
    const report = await services.call('timeline.clip.loudness', {projectId: project.id, timelineId: timeline.id, expectedRevision: timeline.revision,
      clipId: timeline.clips[0].id, expectedAssetSha256: asset.sha256, measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1'});
    assert.equal(report.measurement.state, state); assert.equal(report.measurement.integratedLufs, null);
  });
});

test('real owned decoder cancellation and native-owner drain retire exact children without changing saved state', async t => {
  for (const mode of ['observer', 'owner']) await t.test(mode, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'mioon-clip-loudness-cancel-')), owner = new AbortController(), caller = new AbortController();
    const store = openStore(root), services = createServices(store, new Map(), {signal: owner.signal});
    t.after(async () => {await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
    const project = await services.call('project.create', {name: 'Exact owned cancellation'}); let timeline = await services.call('timeline.get', {projectId: project.id});
    const bytes = wav(2, 48000, 2), id = randomUUID(), asset = {id, projectId: project.id, name: 'Owned.wav', mimeType: 'audio/wav', relativePath: `media/${id}.wav`,
      sha256: sha(bytes), sizeBytes: bytes.length, duration: 2, hasAudio: true, hasVideo: false, width: 0, height: 0, url: `/media/${id}`, createdAt: new Date().toISOString()};
    await writeFile(path.join(root, asset.relativePath), bytes); store.put('assets', asset);
    timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
      trackId: timeline.tracks.find(track => track.kind === 'audio').id, assetId: id, startFrame: 0, durationFrames: 60, gain: 1});
    const before = store.db.prepare('SELECT total_changes() AS n').get().n, beforeFiles = await manifest(root), events = [];
    const off = onMediaProcess(event => {events.push(event); if (event.type === 'started' && event.kind === 'ffmpeg') (mode === 'owner' ? owner : caller).abort();});
    t.after(off);
    await assert.rejects(services.call('timeline.clip.loudness', {projectId: project.id, timelineId: timeline.id, expectedRevision: timeline.revision,
      clipId: timeline.clips[0].id, expectedAssetSha256: asset.sha256, measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1'}, {signal: caller.signal}), {code: 'OPERATION_CANCELLED'});
    await services.drain();
    const started = events.filter(event => event.type === 'started'); assert.ok(started.some(event => event.kind === 'ffmpeg'));
    for (const event of started) assert.ok(events.some(exit => exit.type === 'exited' && exit.pid === event.pid));
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before); assert.deepEqual(await manifest(root), beforeFiles);
    assert.deepEqual(store.get('timelines', timeline.id), timeline);
  });
});

