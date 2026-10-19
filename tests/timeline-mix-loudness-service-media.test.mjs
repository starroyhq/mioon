import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {run} from '../packages/business/src/media-runtime.ts';
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

test('composed service measures current full float original and changed-gain candidate with real media, no persistent effects', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-mix-loudness-real-')), store = openStore(root), services = createServices(store, new Map());
  const processes = [], off = onMediaProcess(event => processes.push(event));
  t.after(async () => {off(); await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const project = await services.call('project.create', {name: 'Synthetic full mix observation'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const bytes = wav(3), id = randomUUID();
  const asset = {id, projectId: project.id, name: 'Bounded mono 44.1k.wav', mimeType: 'audio/wav', relativePath: `media/${id}.wav`,
    sha256: sha(bytes), sizeBytes: bytes.length, duration: 3, hasAudio: true, hasVideo: false, width: 0, height: 0,
    url: `/media/${id}`, createdAt: new Date().toISOString()};
  await writeFile(path.join(root, asset.relativePath), bytes, {mode: 0o600}); store.put('assets', asset);
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'audio').id, assetId: id, startFrame: 9, durationFrames: 60,
    sourceInFrame: 7, gain: .75, fadeInFrames: 5, fadeOutFrames: 8});
  const input = {projectId: project.id, expectedRevision: timeline.revision, mixProfile: 'timeline-float-mix-v1',
    measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1', target: {integratedLufs: -30, truePeakCeilingDbtp: -1}};
  const rows = () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const before = {rows: rows(), changes: store.db.prepare('SELECT total_changes() AS n').get().n, files: await manifest(root)};
  const result = await services.call('timeline.loudness.prepare', input);
  assert.equal(result.stage, 'preencode_float_mix'); assert.equal(result.applyAllowed, false);
  assert.equal(result.original.sampleFrames, 69 * 1600); assert.equal(result.original.state, 'valid');
  assert.equal(result.candidate.status, 'measured'); assert.equal(result.candidate.measurement.sampleFrames, 69 * 1600);
  assert.ok(Math.abs(result.candidate.measurement.integratedLufs + 30) < .1);
  assert.ok(result.candidate.measurement.truePeakDbtp <= -1.5);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before.changes);
  assert.deepEqual(rows(), before.rows); assert.deepEqual(await manifest(root), before.files);
  assert.ok(!JSON.stringify(result).includes(root) && !JSON.stringify(result).includes(asset.relativePath));
  // A current observation neither enqueues an export nor changes its default.
  assert.equal(store.list('exports', project.id).length, 0);
  assert.ok(processes.length > 0);
});

test('saved false audio metadata is verified against real video bytes before silence may be reported', async t => {
  for (const actualAudio of [true, false]) await t.test(actualAudio ? 'false metadata with real AAC refuses' : 'verified silent video remains valid silence', async t => {
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
    const input = {projectId: project.id, expectedRevision: timeline.revision, mixProfile: 'timeline-float-mix-v1',
      measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1', target: {integratedLufs: -30, truePeakCeilingDbtp: -1}};
    const rows = () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
      .map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    const before = {rows: rows(), changes: store.db.prepare('SELECT total_changes() AS n').get().n, files: await manifest(root)};
    if (actualAudio) await assert.rejects(services.call('timeline.loudness.prepare', input), {code: 'TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH'});
    else {
      const result = await services.call('timeline.loudness.prepare', input);
      assert.equal(result.original.state, 'digital_silence'); assert.equal(result.candidate.reason, 'NO_VALID_LOUDNESS');
      assert.equal(result.checks.bytesHashed, 2 * bytes.length); assert.equal(result.checks.passes, 1);
      assert.deepEqual(result.identity.sources, [{assetId: id, sha256: asset.sha256, sizeBytes: bytes.length}]);
    }
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before.changes);
    assert.deepEqual(rows(), before.rows); assert.deepEqual(await manifest(root), before.files);
  });
});

test('maximum 600-second saved mix completes both real float passes within the fixed operation budget', {timeout: 150000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-mix-loudness-maximum-')), store = openStore(root), services = createServices(store, new Map());
  t.after(async () => {await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const project = await services.call('project.create', {name: 'Maximum complete full-mix observation'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const id = randomUUID(), relativePath = `media/${id}.wav`;
  // A bounded 8kHz mono float source keeps fixture storage at 19.2MB. The real
  // decoder still resamples and streams every one of the 57,600,000 stereo
  // output frames across the two complete 48kHz passes. No skipped maximum.
  const sourceIdentity = await (async () => {
    const bytes = wav(600, 8000, 1);
    await writeFile(path.join(root, relativePath), bytes, {mode: 0o600});
    return {sha256: sha(bytes), sizeBytes: bytes.length};
  })();
  store.put('assets', {id, projectId: project.id, name: 'Maximum duration bounded source.wav', mimeType: 'audio/wav', relativePath,
    ...sourceIdentity, duration: 600, hasAudio: true, hasVideo: false, width: 0, height: 0,
    url: `/media/${id}`, createdAt: new Date().toISOString()});
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'audio').id, assetId: id, startFrame: 0, durationFrames: 18000, gain: .75});
  const input = {projectId: project.id, expectedRevision: timeline.revision, mixProfile: 'timeline-float-mix-v1',
    measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1', target: {integratedLufs: -30, truePeakCeilingDbtp: -1}};
  const beforeChanges = store.db.prepare('SELECT total_changes() AS n').get().n, started = performance.now();
  const result = await services.call('timeline.loudness.prepare', input), elapsedMs = performance.now() - started;
  assert.equal(result.original.sampleFrames, 28800000); assert.equal(result.original.decodedDurationSeconds, 600);
  assert.equal(result.candidate.status, 'measured'); assert.equal(result.candidate.measurement.sampleFrames, 28800000);
  assert.equal(result.candidate.measurement.decodedDurationSeconds, 600);
  assert.equal(result.original.gatingBlockCount, 5997); assert.equal(result.candidate.measurement.gatingBlockCount, 5997);
  assert.equal(result.checks.pcmBytes, 460800000); assert.equal(result.checks.passes, 2);
  assert.equal(result.checks.bytesHashed, 2 * sourceIdentity.sizeBytes); assert.equal(result.checks.decodeWorkFrames, 36002);
  assert.equal(result.checks.segmentCount, 1); assert.equal(result.checks.audioFullyDecoded, true);
  assert.equal(result.candidate.meetsTarget, true); assert.equal(result.candidate.meetsTruePeak, true); assert.equal(result.applyAllowed, false);
  assert.ok(elapsedMs < 120000); assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges);
  assert.equal(store.list('exports', project.id).length, 0);
  // This proves completed duration/PCM/hash budgets and measured wall time. It
  // makes no claim that bounded DSP arrays establish an FFmpeg native RSS cap.
  t.diagnostic(`Maximum full-mix observation: ${Math.round(elapsedMs)}ms; 460800000 streamed PCM bytes; ${2 * sourceIdentity.sizeBytes} hashed source bytes.`);
});

test('real candidate rerender changes absolute gate membership and can miss the arithmetic target', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-mix-loudness-gates-')), store = openStore(root), services = createServices(store, new Map());
  t.after(async () => {await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const project = await services.call('project.create', {name: 'Real candidate absolute gate change'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const reference = wav(2, 48000, 2), calibration = createExportLoudnessAccumulator(2);
  calibration.write(reference.subarray(44)); const referenceLufs = calibration.finish().integratedLufs;
  assert.notEqual(referenceLufs, null);
  const beforeGain = .25, trackId = timeline.tracks.find(track => track.kind === 'audio').id;
  // Calibrate only the deterministic fixture amplitudes. One 2-second clip is
  // above the absolute gate and one is below; their 4LU separation stays below
  // the 10LU relative-gate offset. The candidate must really render both clips.
  for (const [index, desiredOriginalLufs] of [-68, -72].entries()) {
    const bytes = Buffer.from(reference), scale = 10 ** ((desiredOriginalLufs - referenceLufs) / 20) / beforeGain;
    for (let offset = 44; offset < bytes.length; offset += 4) bytes.writeFloatLE(reference.readFloatLE(offset) * scale, offset);
    const id = randomUUID(), relativePath = `media/${id}.wav`;
    await writeFile(path.join(root, relativePath), bytes, {mode: 0o600});
    store.put('assets', {id, projectId: project.id, name: `Gate fixture ${index}.wav`, mimeType: 'audio/wav', relativePath,
      sha256: sha(bytes), sizeBytes: bytes.length, duration: 2, hasAudio: true, hasVideo: false, width: 0, height: 0,
      url: `/media/${id}`, createdAt: new Date().toISOString()});
    timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
      trackId, assetId: id, startFrame: index * 60, sourceInFrame: 0, durationFrames: 60, gain: beforeGain});
  }
  const beforeChanges = store.db.prepare('SELECT total_changes() AS n').get().n, beforeFiles = await manifest(root);
  const result = await services.call('timeline.loudness.prepare', {projectId: project.id, expectedRevision: timeline.revision,
    mixProfile: 'timeline-float-mix-v1', measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1',
    target: {integratedLufs: -60, truePeakCeilingDbtp: -1}});
  assert.equal(result.original.state, 'valid'); assert.equal(result.candidate.status, 'measured');
  assert.equal(result.candidate.gains.length, 2); assert.equal(result.checks.passes, 2);
  assert.equal(result.original.sampleFrames, 192000); assert.equal(result.candidate.measurement.sampleFrames, 192000);
  assert.ok(result.original.absoluteGatedBlockCount < result.original.gatingBlockCount);
  assert.ok(result.candidate.measurement.absoluteGatedBlockCount > result.original.absoluteGatedBlockCount);
  const arithmetic = result.original.integratedLufs + result.candidate.requiredGainDb;
  assert.ok(Math.abs(arithmetic + 60) < 1e-9);
  assert.ok(Math.abs(result.candidate.measurement.integratedLufs - arithmetic) > .1);
  assert.equal(result.candidate.meetsTarget, false); assert.equal(result.applyAllowed, false);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges); assert.deepEqual(await manifest(root), beforeFiles);
  t.diagnostic(`Gate membership changed ${result.original.absoluteGatedBlockCount}→${result.candidate.measurement.absoluteGatedBlockCount}; original ${result.original.integratedLufs.toFixed(4)} LUFS, actual candidate ${result.candidate.measurement.integratedLufs.toFixed(4)} LUFS, arithmetic ${arithmetic.toFixed(4)} LUFS.`);
});
