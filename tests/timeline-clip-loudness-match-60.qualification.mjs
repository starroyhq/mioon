// Explicit expensive qualification only. Not part of ordinary *.test.mjs globs.
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

test('60-second clip target candidate fills its bounded PCM buffer and remeasures without persistence', {timeout: 150000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-mix-loudness-maximum-')), store = openStore(root), services = createServices(store, new Map());
  t.after(async () => {await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const project = await services.call('project.create', {name: 'Supported60s independent late-source observation'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const id = randomUUID(), relativePath = `media/${id}.wav`;
  // A bounded 8kHz mono float source keeps fixture storage at 19.2MB. The real
  // decoder still resamples and streams every one of the 2,880,000 stereo
  // output frames in one complete 48kHz pass. No skipped maximum.
  const sourceIdentity = await (async () => {
    const bytes = wav(600, 8000, 1);
    await writeFile(path.join(root, relativePath), bytes, {mode: 0o600});
    return {sha256: sha(bytes), sizeBytes: bytes.length};
  })();
  store.put('assets', {id, projectId: project.id, name: 'Maximum duration bounded source.wav', mimeType: 'audio/wav', relativePath,
    ...sourceIdentity, duration: 600, hasAudio: true, hasVideo: false, width: 0, height: 0,
    url: `/media/${id}`, createdAt: new Date().toISOString()});
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'audio').id, assetId: id, startFrame: 0, durationFrames: 1800, sourceInFrame: 16200, gain: .75});
  const input = {projectId: project.id, timelineId: timeline.id, expectedRevision: timeline.revision, clipId: timeline.clips[0].id, expectedAssetSha256: sourceIdentity.sha256, measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1'};
  const observed = await services.call('timeline.clip.loudness', input);
  assert.equal(observed.measurement.state, 'valid');
  const targetedInput = {...input, target: {integratedLufs: observed.measurement.integratedLufs + 1, truePeakCeilingDbtp: -1}};
  const events = [], off = onMediaProcess(event => events.push(event)); t.after(off);
  const rows = () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const beforeRows = rows(), beforeFiles = await manifest(root);
  const beforeChanges = store.db.prepare('SELECT total_changes() AS n').get().n, started = performance.now();
  const result = await services.call('timeline.clip.loudness', targetedInput), elapsedMs = performance.now() - started;
  assert.equal(result.candidate.status, 'measured');
  assert.equal(result.candidate.measuredPcmBytes, 23040000);
  assert.equal(result.candidate.measurement.sampleFrames, 2880000);
  assert.equal(result.candidate.meetsTarget, true); assert.equal(result.candidate.meetsTruePeak, true);
  assert.equal(result.candidate.applyAllowed, false); assert.equal(result.applyAllowed, false);
  assert.equal(result.loudnessRange.shortTermBlockCount, 571);
  assert.equal(result.loudnessRange.sampleFrames, 2880000);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8192);
  assert.equal(result.measurement.sampleFrames, 2880000); assert.equal(result.measurement.decodedDurationSeconds, 60);
  assert.equal(result.checks.pcmBytes, 23040000); assert.equal(result.checks.passes, 1);
  assert.equal(result.checks.bytesHashed, 2 * sourceIdentity.sizeBytes); assert.equal(result.checks.decodeWorkFrames, 1801);
  assert.equal(result.checks.segmentCount, 1); assert.equal(result.checks.audioFullyDecoded, true);
  assert.ok(elapsedMs < 120000); assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges);
  assert.equal(store.list('exports', project.id).length, 0);
  assert.equal(result.identity.sourceInFrame, 16200); assert.deepEqual(rows(), beforeRows); assert.deepEqual(await manifest(root), beforeFiles);
  const startedChildren = events.filter(event => event.type === 'started'); assert.ok(startedChildren.some(event => event.kind === 'ffmpeg'));
  for (const event of startedChildren) assert.ok(events.some(exit => exit.type === 'exited' && exit.pid === event.pid));
  t.diagnostic(`Owned child ledger: ${JSON.stringify(events)}`);
  // This proves completed duration/PCM/hash budgets and measured wall time. It
  // makes no claim that bounded DSP arrays establish an FFmpeg native RSS cap.
  t.diagnostic(`Supported60s target-candidate observation: ${Math.round(elapsedMs)}ms; 23040000 streamed PCM bytes; ${2 * sourceIdentity.sizeBytes} hashed source bytes.`);
});
