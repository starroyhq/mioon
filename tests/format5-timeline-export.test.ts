import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {
  assertFormat5ExportAdmissible, createFormat5ExportTicket, recheckFormat5ExportTicket,
} from '../packages/business/src/format5-timeline-export.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `60000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const root = id(2), shotA = id(3), shotB = id(4), track = id(60);
const assetA = id(10), assetShort = id(11), versionA = id(20), versionShort = id(21);
const clipA = id(30), clipB = id(31), groupA = id(40), groupB = id(41);
const timelineId = id(50);
const sha = (letter: string): string => letter.repeat(64);

function fixture(t: test.TestContext): ProjectStore {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-tsb-export-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(directory, 'project.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(directory, 'records'), cacheDir: path.join(directory, 'cache'), tempDir: path.join(directory, 'temp')})});
  t.after(() => {store.close(); rmSync(directory, {recursive: true, force: true});});
  const projectId = store.projectId;
  const timeline = {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 90,
    createdAt: at, updatedAt: at, mainTrack: {trackId: track, sequenceNodeId: root},
    tracks: [{id: track, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: [
      {id: clipA, trackId: track, name: 'Shot A', startFrame: 0, durationFrames: 60, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: assetA, versionId: versionA, shotId: shotA,
        sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: shotA, segmentGroupId: groupA, versionMode: 'follow'}},
      {id: clipB, trackId: track, name: 'Shot B', startFrame: 60, durationFrames: 30, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
        sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: shotB, segmentGroupId: groupB, versionMode: 'follow'}},
    ]};
  const baseline = {version: 1, board: [{nodeId: shotA, kind: 'shot', selectedVersionId: versionA},
    {nodeId: shotB, kind: 'shot', selectedVersionId: null}], track: [
    {nodeId: shotA, segmentGroupId: groupA, clipId: clipA, kind: 'shot', versionMode: 'follow', appliedVersionId: versionA},
    {nodeId: shotB, segmentGroupId: groupB, clipId: clipB, kind: 'shot', versionMode: 'follow', appliedVersionId: null}]};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic export', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: assetA, projectId, mimeType: 'video/mp4', duration: 2, sha256: sha('a')});
    store.put('assets', {id: assetShort, projectId, mimeType: 'video/mp4', duration: 1, sha256: sha('b')});
    store.put('versions', {id: versionA, projectId, jobId: id(70), shotId: shotA, number: 1, assetId: assetA, sha256: sha('a'), createdAt: at});
    store.put('versions', {id: versionShort, projectId, jobId: id(71), shotId: shotA, number: 2, assetId: assetShort, sha256: sha('b'), createdAt: at});
    store.put('shots', {id: shotA, projectId, orderIndex: 0, selectedVersionId: versionA, duration: 2, createdAt: at, updatedAt: at});
    store.put('shots', {id: shotB, projectId, orderIndex: 1, selectedVersionId: null, duration: 1, createdAt: at, updatedAt: at});
    store.put('nodes', {id: root, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    store.put('edges', {id: id(80), projectId, kind: 'sequence', source: root, target: shotA, createdAt: at});
    store.put('edges', {id: id(81), projectId, kind: 'sequence', source: shotA, target: shotB, createdAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, root, 1, JSON.stringify(baseline));
  });
  return store;
}

test('a placeholder in the selected range blocks the frozen export ticket', t => {
  const store = fixture(t);
  const all = createFormat5ExportTicket(store);
  assert.deepEqual(all.blockers, [{code: 'PLACEHOLDER_CLIP', clipId: clipB, nodeId: shotB}]);
  assert.throws(() => assertFormat5ExportAdmissible(all), {code: 'EXPORT_BLOCKED'});
  assert.ok(all.contentRevision >= 1);
  assert.equal(all.timelineRevision, 1);
  assert.equal(all.syncRevision, 1);
  assert.equal(all.snapshotHash.length, 64);
  const firstOnly = createFormat5ExportTicket(store, {startFrame: 0, endFrame: 60});
  assert.deepEqual(firstOnly.blockers, [], 'a range that excludes the placeholder has no placeholder blocker');
});

test('a selected version shorter than the cut blocks export until the user chooses or locks', t => {
  const store = fixture(t);
  store.tx(() => store.db.prepare("UPDATE project.shots SET data=json_set(data,'$.selectedVersionId',?) WHERE id=?")
    .run(versionShort, shotA));
  const ticket = createFormat5ExportTicket(store, {startFrame: 0, endFrame: 60});
  assert.deepEqual(ticket.blockers, [{code: 'VERSION_TOO_SHORT', clipId: clipA, nodeId: shotA, versionId: versionShort,
    shortByFrames: 30}]);
  assert.throws(() => assertFormat5ExportAdmissible(ticket), {code: 'EXPORT_BLOCKED'});
});

test('the three revisions must still match right before the final enqueue', t => {
  const store = fixture(t);
  const ticket = createFormat5ExportTicket(store);
  const fresh = recheckFormat5ExportTicket(store, ticket);
  assert.equal(fresh.ok, true);
  store.tx(() => store.put('timelines', {...(store.get('timelines', timelineId) as Record<string, unknown>),
    revision: 2, updatedAt: at}));
  const stale = recheckFormat5ExportTicket(store, ticket);
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, 'EXPORT_SNAPSHOT_STALE');
    assert.deepEqual(stale.ids, [timelineId]);
  }
});

// ---------------------------------------------------------------------------
// «Save clip sound as an audio asset»: real managed media, real FFmpeg, the
// production task record and publication path (no mocked probe or encode).
// ---------------------------------------------------------------------------
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {probe} from '../packages/business/src/media.ts';
import {referenceForPublishedMedia} from '../packages/business/src/project-media-storage.ts';
import {registerProjectMediaStore} from '../packages/business/src/project-media-storage.ts';
import {validAssetLocator} from '../packages/business/src/asset-reference-record.ts';
import {clipAudioEncodeProgress, clipAudioProgressMicroseconds, getClipAudioExport, runClipAudioExport, startClipAudioExport} from '../packages/business/src/clip-audio-export.ts';
import {createExportControlServices} from '../packages/business/src/export-controls.ts';
import {clipAudioExportRecordSchema} from '../packages/contracts/src/clip-audio-export.ts';
import {previewSeparateSound, runSeparateSoundSync} from '../packages/business/src/format5-clip-sound.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {freezeFormat5RenderSnapshot} from '../packages/business/src/format5-timeline-render.ts';
import {prepareTimelineInputs} from '../packages/business/src/timeline-sources.ts';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';

const mediaSha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

interface RealSoundFixture {
  readonly store: ProjectStore;
  readonly directory: string;
  readonly projectId: string;
  readonly sourcePath: string;
  readonly sourceSha: string;
  readonly sourceAssetId: string;
  readonly clipId: string;
  readonly timelineId: string;
}

/** Generate one real video with the requested audio codec, import it through the
 * production media reference and mount it on a format-5 main track. */
async function realSoundFixture(t: test.TestContext, codec: 'aac' | 'mp3', {seconds = 2}: {seconds?: number} = {}): Promise<RealSoundFixture> {
  const durationFrames = seconds * 30;
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-clip-audio-real-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(directory, 'project.mioon'), format5: true,
    locate: () => ({localDir: path.join(directory, 'records'), cacheDir: path.join(directory, 'cache'),
      tempDir: path.join(directory, 'temp')})});
  const release = registerProjectMediaStore(store);
  t.after(() => {release(); store.close(); rmSync(directory, {recursive: true, force: true});});
  const projectId = store.projectId;
  mkdirSync(path.join(directory, 'media'), {recursive: true, mode: 0o700});
  chmodSync(path.join(directory, 'media'), 0o700);
  const sourcePath = path.join(directory, 'media', `sound-${codec}.mp4`);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x205080:s=320x180:r=30:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=660:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', codec, ...(codec === 'aac' ? ['-b:a', '128k'] : []), '-shortest', sourcePath],
    {timeout: 60000, maxStdoutBytes: 0, maxStderrBytes: 65536});
  chmodSync(sourcePath, 0o600);
  const sourceSha = mediaSha(sourcePath);
  const published = await referenceForPublishedMedia(store, sourcePath, {sha256: sourceSha});
  const timeline = {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames,
    createdAt: at, updatedAt: at, mainTrack: {trackId: track, sequenceNodeId: root},
    tracks: [{id: track, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: [{id: clipA, trackId: track, name: 'Shot A', startFrame: 0, durationFrames, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: assetA, versionId: versionA, shotId: shotA,
      sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: shotA, segmentGroupId: groupA, versionMode: 'follow'}}]};
  const baseline = {version: 1, board: [{nodeId: shotA, kind: 'shot', selectedVersionId: versionA}],
    track: [{nodeId: shotA, segmentGroupId: groupA, clipId: clipA, kind: 'shot', versionMode: 'follow', appliedVersionId: versionA}]};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Real clip sound', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: assetA, projectId, name: `sound-${codec}.mp4`, mimeType: 'video/mp4', duration: seconds,
      sha256: published.sha256, sizeBytes: published.sizeBytes, hasAudio: true, hasVideo: true,
      reference: published.reference, referenceRevision: 1});
    store.put('versions', {id: versionA, projectId, jobId: id(70), shotId: shotA, number: 1, assetId: assetA,
      sha256: published.sha256, createdAt: at});
    store.put('shots', {id: shotA, projectId, orderIndex: 0, selectedVersionId: versionA, duration: seconds, createdAt: at, updatedAt: at});
    store.put('nodes', {id: root, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    store.put('edges', {id: id(80), projectId, kind: 'sequence', source: root, target: shotA, createdAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, root, 1, JSON.stringify(baseline));
  });
  return {store, directory, projectId, sourcePath, sourceSha, sourceAssetId: assetA, clipId: clipA, timelineId};
}

const exportLatest = (store: ProjectStore, exportId: string) => {
  const row = store.db.prepare('SELECT data FROM exports WHERE id=?').get(exportId) as {data?: string} | undefined;
  const parsed = clipAudioExportRecordSchema.safeParse(row?.data ? JSON.parse(row.data) : null);
  assert.ok(parsed.success, 'the accepted task row keeps its closed shape');
  return parsed.data;
};
const claimClipAudio = (store: ProjectStore, exportId: string) => store.tx(() => {
  const record = exportLatest(store, exportId);
  store.put('exports', {...record, status: 'running', updatedAt: new Date().toISOString()});
  return exportLatest(store, exportId);
});
function workerHooks(store: ProjectStore, exportId: string, signal: AbortSignal) {
  const latest = () => {try {return exportLatest(store, exportId);} catch {return null;}};
  return {signal, latest,
    beforeEffect: () => {const current = latest(); if (!current || current.status !== 'running')
      throw Object.assign(Error('The clip-audio task is no longer owned.'), {code: 'INVALID_TIMELINE_SNAPSHOT'});},
    save: (values: Record<string, unknown>) => store.tx(() => {
      const current = latest(); if (!current || current.status !== 'running') return;
      store.put('exports', {...current, ...values, updatedAt: new Date().toISOString()});
    }),
    succeed: (asset: Record<string, unknown>, record: unknown) => store.tx(() => {
      const current = latest(); if (!current || current.status !== 'running')
        throw Object.assign(Error('The clip-audio task is no longer owned.'), {code: 'INVALID_TIMELINE_SNAPSHOT'});
      store.put('assets', asset); store.put('exports', record as never);
    })};
}
async function runAcceptedClipAudio(f: RealSoundFixture, requestId: string): Promise<string> {
  const accepted = startClipAudioExport(f.store, {projectId: f.projectId, requestId, clipId: f.clipId});
  const running = claimClipAudio(f.store, accepted.id);
  const controller = new AbortController();
  await runClipAudioExport(f.store, running, workerHooks(f.store, accepted.id, controller.signal));
  return accepted.id;
}

// ---------------------------------------------------------------------------
// «Separated sound»: one real separation through the edit service, then the
// production freeze -> prepare -> renderTimeline path and PCM inspection.
// ---------------------------------------------------------------------------
async function decodeOutputPcm(file: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const output = await runStreaming('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '2', '-ar', '48000',
    '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'],
    {timeout: 120000, maxStdoutBytes: 8 * 1024 * 1024, maxStderrBytes: 64 * 1024,
      onStdout: (chunk: Uint8Array) => {chunks.push(Buffer.from(chunk));}});
  return Buffer.concat(chunks, output.stdoutBytes);
}
/** Estimated sine amplitude (0..1) over one channel of the decoded stereo PCM. */
function toneAmplitude(pcm: Buffer, fromSeconds: number, toSeconds: number, hz: number): number {
  const first = Math.round(fromSeconds * 48000), last = Math.round(toSeconds * 48000);
  let real = 0, imaginary = 0;
  for (let sample = first; sample < last; sample++) {
    const value = pcm.readInt16LE(sample * 4) / 32768;
    const angle = 2 * Math.PI * hz * sample / 48000;
    real += value * Math.cos(angle); imaginary += value * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / (last - first);
}
function pcmRms(pcm: Buffer, fromSeconds: number, toSeconds: number): number {
  const first = Math.round(fromSeconds * 48000), last = Math.round(toSeconds * 48000);
  let sum = 0;
  for (let sample = first; sample < last; sample++) sum += (pcm.readInt16LE(sample * 4) / 32768) ** 2;
  return Math.sqrt(sum / (last - first));
}
/** The test project's asset rows are synthetic generations without a job
* receipt, so the inspection ownership graph cannot validate them; the renderer
* only needs the same project-owned locator row the format-5 projection uses. */
function readFixtureAsset(store: ProjectStore, assetId: string): Record<string, unknown> | null {
  const row = store.db.prepare('SELECT data FROM project.assets WHERE id=?').get(assetId) as {data?: unknown} | undefined;
  if (typeof row?.data !== 'string') return null;
  const asset = JSON.parse(row.data) as Record<string, unknown>;
  return asset.id === assetId && asset.projectId === store.projectId && validAssetLocator(store.db, asset) ? asset : null;
}
async function renderFrozenFormat5(store: ProjectStore, snapshot: unknown, file: string): Promise<void> {
  const prepared = await prepareTimelineInputs(snapshot as never, {root: store.root, projectId: store.projectId,
    readAsset: (assetId: string) => readFixtureAsset(store, assetId) as never});
  await renderTimeline(snapshot as never, prepared as never, file);
}

test('clip audio export copies AAC sound into a new audio asset with its source range', {timeout: 180000}, async t => {
  const f = await realSoundFixture(t, 'aac');
  const sourceBefore = JSON.stringify(f.store.get('assets', f.sourceAssetId));
  const timelineBefore = JSON.stringify(f.store.db.prepare('SELECT data FROM project.timelines').get());
  const exportId = await runAcceptedClipAudio(f, randomUUID());
  const record = exportLatest(f.store, exportId);
  assert.equal(record.status, 'succeeded', JSON.stringify(record.error));
  assert.equal(record.output!.mode, 'copy');
  assert.equal(record.output!.mimeType, 'audio/mp4');
  assert.equal(record.progress, 100);
  const asset = f.store.get('assets', record.assetId!) as Record<string, unknown>;
  assert.equal(asset.mimeType, 'audio/mp4');
  assert.equal(asset.provenance, 'clip-audio');
  assert.equal(asset.hasAudio, true);
  assert.equal(asset.hasVideo, false);
  assert.deepEqual(asset.clipAudioSource, {clipId: f.clipId, sourceAssetId: f.sourceAssetId,
    sourceHash: f.sourceSha, sourceInFrame: 0, durationFrames: 60, fps: 30, taskId: exportId, mode: 'copy'});
  assert.equal(validAssetLocator(f.store.db, asset), true, 'the asset carries a portable project reference');
  const file = path.join(f.store.projectDir, String((asset.reference as {path?: string}).path));
  assert.equal(mediaSha(file), asset.sha256);
  const probed = await probe(file);
  assert.equal(probed.hasAudio, true);
  assert.equal(probed.hasVideo, false);
  assert.equal(probed.probe.streams.find(stream => stream.codec_type === 'audio')?.codec_name, 'aac');
  assert.ok(Math.abs(probed.duration - 2) < 0.25);
  // Source bytes and the saved timeline never change.
  assert.equal(JSON.stringify(f.store.get('assets', f.sourceAssetId)), sourceBefore);
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT data FROM project.timelines').get()), timelineBefore);
  // The read path and the shared activity/cancel channel accept the task row.
  const view = getClipAudioExport(f.store, {projectId: f.projectId, exportId});
  assert.equal(view.record.status, 'succeeded');
  assert.equal(view.activity.stage, 'complete');
  assert.equal(view.activity.progress, 100);
  const controls = createExportControlServices(f.store as never);
  const activity = controls.handlers['export.activity.get']({projectId: f.projectId, exportId} as never) as {stage: string; status: string};
  assert.equal(activity.stage, 'complete');
  assert.equal(activity.status, 'succeeded');
});

test('clip audio export transcodes non-AAC sound with the export audio settings', {timeout: 180000}, async t => {
  const f = await realSoundFixture(t, 'mp3');
  const exportId = await runAcceptedClipAudio(f, randomUUID());
  const record = exportLatest(f.store, exportId);
  assert.equal(record.status, 'succeeded', JSON.stringify(record.error));
  assert.equal(record.output!.mode, 'transcode');
  const asset = f.store.get('assets', record.assetId!) as Record<string, unknown>;
  const file = path.join(f.store.projectDir, String((asset.reference as {path?: string}).path));
  const probed = await probe(file);
  const audio = probed.probe.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(audio?.codec_name, 'aac');
  assert.equal(Number(audio?.sample_rate), 48000);
  assert.equal(Number(audio?.channels), 2);
  assert.equal((asset.clipAudioSource as {mode: string}).mode, 'transcode');
});

test('separated sound renders the muted source silent and the clip sound exactly once', {timeout: 240000}, async t => {
  const f = await realSoundFixture(t, 'aac');
  // Baseline: the same clip before separation is audible exactly once.
  const beforeSnapshot = freezeFormat5RenderSnapshot(f.store);
  const beforeFile = path.join(f.directory, 'before-separation.mp4');
  await renderFrozenFormat5(f.store, beforeSnapshot, beforeFile);
  const single = toneAmplitude(await decodeOutputPcm(beforeFile), 0.4, 1.6, 660);
  assert.ok(single > 0.03, `the unmuted source must be audible, amplitude=${single}`);
  // One real separation intent through the edit service.
  const preview = previewSeparateSound(f.store, {requestId: randomUUID(),
    soundIntent: {side: 'timeline', operation: {kind: 'separate-sound', clipId: f.clipId}}});
  assert.ok(!('ok' in preview) || preview.ok !== false, JSON.stringify(preview));
  const committed = runSeparateSoundSync(f.store, (preview as {envelope: Parameters<typeof runSeparateSoundSync>[1]}).envelope);
  assert.ok(committed.ok, JSON.stringify(committed));
  const timeline = readFormat5TimelineRecord(f.store.db, 'project')!;
  const source = timeline.clips.find(clip => clip.id === f.clipId)!;
  const sound = timeline.clips.find(clip => clip.id !== f.clipId)!;
  assert.equal(source.muted, true);
  assert.equal(sound.assetId, f.sourceAssetId, 'the sound-only clip references the same video asset');
  assert.equal(sound.soundOnly, true);
  assert.deepEqual([sound.startFrame, sound.durationFrames, sound.sourceInFrame],
    [source.startFrame, source.durationFrames, source.sourceInFrame]);
  assert.deepEqual(sound.anchor, {clipId: f.clipId, offsetFrames: 0});
  const separatedSnapshot = freezeFormat5RenderSnapshot(f.store) as {timeline: {clips: Record<string, unknown>[]}};
  const separatedFile = path.join(f.directory, 'separated-sound.mp4');
  await renderFrozenFormat5(f.store, separatedSnapshot, separatedFile);
  const separated = toneAmplitude(await decodeOutputPcm(separatedFile), 0.4, 1.6, 660);
  assert.ok(Math.abs(separated - single) / single < 0.15,
    `the separated sound must play exactly once (before=${single}, separated=${separated})`);
  // Drop the sound-only clip: only the muted source remains and must be silent.
  const mutedOnly = structuredClone(separatedSnapshot);
  mutedOnly.timeline.clips = mutedOnly.timeline.clips.filter(clip => clip.id === f.clipId);
  const mutedFile = path.join(f.directory, 'muted-source.mp4');
  await renderFrozenFormat5(f.store, mutedOnly, mutedFile);
  const mutedRms = pcmRms(await decodeOutputPcm(mutedFile), 0.4, 1.6);
  assert.ok(mutedRms < single / 50, `the muted source must not be audible (rms=${mutedRms}, single=${single})`);
  // Un-muting the source on top of the sound-only clip would sum twice; the
  // separated shape must not contain that double playback.
  const doubled = structuredClone(separatedSnapshot);
  delete doubled.timeline.clips.find(clip => clip.id === f.clipId)!.muted;
  const doubledFile = path.join(f.directory, 'doubled-sound.mp4');
  await renderFrozenFormat5(f.store, doubled, doubledFile);
  const doubledAmplitude = toneAmplitude(await decodeOutputPcm(doubledFile), 0.4, 1.6, 660);
  assert.ok(Math.abs(doubledAmplitude - single * 2) / (single * 2) < 0.2,
    `two audible instances sum to twice the amplitude (single=${single}, doubled=${doubledAmplitude})`);
  const probed = await probe(separatedFile);
  assert.equal(probed.hasVideo, true);
  assert.equal(probed.hasAudio, true);
  assert.ok(Math.abs(probed.duration - 2) < 0.25);
});

test('clip audio export cancellation leaves no asset and a retry succeeds under a new request', {timeout: 180000}, async t => {
  const f = await realSoundFixture(t, 'aac');
  const controls = createExportControlServices(f.store as never);
  const assetsBefore = Number(f.store.db.prepare('SELECT count(*) n FROM project.assets').get()!.n);
  const first = startClipAudioExport(f.store, {projectId: f.projectId, requestId: randomUUID(), clipId: f.clipId});
  assert.equal(first.status, 'queued');
  const cancelled = controls.handlers['export.cancel']({projectId: f.projectId, exportId: first.id} as never) as {status: string; error?: {code?: string}};
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.error?.code, 'EXPORT_CANCELLED');
  // Running a cancelled task is a no-op and creates no asset or file.
  const running = {...exportLatest(f.store, first.id), status: 'running' as const};
  await runClipAudioExport(f.store, running as never, workerHooks(f.store, first.id, new AbortController().signal));
  assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM project.assets').get()!.n), assetsBefore);
  assert.equal(exportLatest(f.store, first.id).status, 'failed');
  // A retry uses a new request id and a fresh accepted row.
  const exportId = await runAcceptedClipAudio(f, randomUUID());
  assert.equal(exportLatest(f.store, exportId).status, 'succeeded', JSON.stringify(exportLatest(f.store, exportId).error));
  assert.notEqual(exportId, first.id);
  assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM project.assets').get()!.n), assetsBefore + 1);
});

test('clip audio export fails with a retryable reason when the source changed, then retries', {timeout: 180000}, async t => {
  const f = await realSoundFixture(t, 'aac');
  const bytes = readFileSync(f.sourcePath);
  const accepted = startClipAudioExport(f.store, {projectId: f.projectId, requestId: randomUUID(), clipId: f.clipId});
  const running = claimClipAudio(f.store, accepted.id);
  // Replace the source with different bytes of the same size after acceptance.
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] = changed[changed.length - 1] === 0 ? 1 : 0;
  writeFileSync(f.sourcePath, changed);
  const assetsBefore = Number(f.store.db.prepare('SELECT count(*) n FROM project.assets').get()!.n);
  await runClipAudioExport(f.store, running, workerHooks(f.store, accepted.id, new AbortController().signal));
  const failed = exportLatest(f.store, accepted.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error!.code, 'CLIP_AUDIO_SOURCE_UNAVAILABLE');
  assert.equal(failed.error!.retryable, true);
  assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM project.assets').get()!.n), assetsBefore);
  writeFileSync(f.sourcePath, bytes);
  const exportId = await runAcceptedClipAudio(f, randomUUID());
  assert.equal(exportLatest(f.store, exportId).status, 'succeeded');
  assert.equal(exportLatest(f.store, accepted.id).status, 'failed', 'the failed attempt stays readable');
  assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM project.assets').get()!.n), assetsBefore + 1);
});

test('clip audio export maps real FFmpeg progress in microseconds, never a clamped 99% run', {timeout: 240000}, async t => {
  // FFmpeg 9 reports `out_time_ms` in microseconds (1.5s -> 1500000), the exact
  // unit confusion that used to clamp every tick to 99%. A 300 s transcode emits
  // several real ticks, so the intermediate percentages are observable.
  assert.equal(clipAudioProgressMicroseconds('out_time_us=1500000'), 1_500_000);
  assert.equal(clipAudioProgressMicroseconds('out_time_ms=1500000'), 1_500_000);
  assert.equal(clipAudioProgressMicroseconds('out_time=00:00:01.500000'), null);
  assert.equal(clipAudioEncodeProgress(1_500_000, 2_000), 75);
  assert.equal(clipAudioEncodeProgress(2_000_000, 2_000), 99);
  assert.equal(clipAudioEncodeProgress(0, 2_000), 0);
  const f = await realSoundFixture(t, 'mp3', {seconds: 300});
  const accepted = startClipAudioExport(f.store, {projectId: f.projectId, requestId: randomUUID(), clipId: f.clipId});
  const running = claimClipAudio(f.store, accepted.id);
  const saved: Record<string, unknown>[] = [];
  const hooks = workerHooks(f.store, accepted.id, new AbortController().signal);
  const save = hooks.save;
  hooks.save = values => {saved.push({...values}); return save(values);};
  await runClipAudioExport(f.store, running, hooks);
  const record = exportLatest(f.store, accepted.id);
  assert.equal(record.status, 'succeeded', JSON.stringify(record.error));
  assert.equal(record.output!.mode, 'transcode');
  assert.equal(record.progress, 100);
  const progress = saved.flatMap(values => typeof values.progress === 'number' ? [values.progress] : []);
  assert.ok(progress.length >= 2, `expected several real FFmpeg progress ticks, got ${JSON.stringify(saved)}`);
  assert.ok(progress.some(value => value > 0 && value < 99),
    `expected an intermediate percentage instead of an instant 99%, got ${JSON.stringify(progress)}`);
  for (let index = 1; index < progress.length; index++)
    assert.ok(progress[index] >= progress[index - 1], `progress must not go backwards: ${JSON.stringify(progress)}`);
  assert.equal(progress.at(-1), 99, 'the last encoding tick is capped at 99; completion writes 100');
});

test('clip audio export request replay returns the accepted row and rejects changed reuse', {timeout: 60000}, async t => {
  const f = await realSoundFixture(t, 'aac');
  const requestId = randomUUID();
  const first = startClipAudioExport(f.store, {projectId: f.projectId, requestId, clipId: f.clipId});
  const replay = startClipAudioExport(f.store, {projectId: f.projectId, requestId, clipId: f.clipId});
  assert.equal(replay.id, first.id);
  assert.throws(() => startClipAudioExport(f.store, {projectId: f.projectId, requestId, clipId: id(31)}),
    {code: 'IDEMPOTENCY_CONFLICT'});
});
