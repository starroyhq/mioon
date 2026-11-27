import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {clipAudioExportRequestHash, getClipAudioExport, startClipAudioExport} from '../packages/business/src/clip-audio-export.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {readSequenceEditHistoryEntry} from '../packages/business/src/format5-editor-history.ts';
import {inspectProjectFormatReadOnly} from '../packages/business/src/project-file/connection.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createProjectStore, type ProjectStore} from '../packages/business/src/project-file/store.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import type {Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import {PROJECT_READER_UPDATE_REQUIRED, TIMELINE_FPS_READER_FEATURE} from '../packages/contracts/src/project-reader-requirements.ts';
import type {SequenceEditHistoryView, SequenceEditReceipt} from '../packages/contracts/src/sequence-edit.ts';
import type {TimelineFps} from '../packages/contracts/src/timeline-fps.ts';

const at = '2026-01-01T00:00:00.000Z';

function timeline(store: ProjectStore): Format5Timeline {
  const value = readFormat5TimelineRecord(store.db, 'project');
  assert.ok(value);
  return value;
}

function fixture(t: test.TestContext, format: 5 | 6 = 6) {
  const gate = 'MIOON_FORMAT6_DEV';
  const prior = process.env[gate];
  process.env[gate] = '1';
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-fps-edit-'));
  const projectFile = path.join(root, 'project.mioon');
  const projectId = randomUUID(), timelineId = randomUUID(), filmId = randomUUID(), trackId = randomUUID();
  const store = createProjectStore({projectId, projectFile, allowFormat6: true,
    targetFormat: format === 6 ? FORMAT6_PROJECT_SCHEMA_VERSION : FORMAT5_PROJECT_SCHEMA_VERSION,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {
    store.close();
    rmSync(root, {recursive: true, force: true});
    if (prior === undefined) delete process.env[gate];
    else process.env[gate] = prior;
  });
  const initial: Format5Timeline = {
    id: timelineId, projectId, revision: 1, width: 1080, height: 1920, fps: 30, durationFrames: 0, createdAt: at, updatedAt: at,
    mainTrack: {trackId, sequenceNodeId: filmId},
    tracks: [{id: trackId, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips: [],
  };
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic empty timeline', createdAt: at, updatedAt: at, revision: 1});
    store.put('nodes', {id: filmId, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    store.put('timelines', initial);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, filmId, 1, JSON.stringify({version: 1, board: [], track: []}));
  });
  const service = createFormat5SequenceEditService(store);
  const preview = (fps: TimelineFps) => service.preview({projectId, requestId: randomUUID(),
    formatIntent: {side: 'timeline', operation: {kind: 'timeline-fps', fps}}});
  const apply = (fps: TimelineFps) => {
    const reviewed = preview(fps);
    assert.ok('envelope' in reviewed, JSON.stringify(reviewed));
    const request = {projectId, envelope: reviewed.envelope, expectedPlanDigest: reviewed.planDigest};
    const receipt = service.commit(request) as SequenceEditReceipt;
    assert.equal(receipt.status, 'applied');
    assert.equal(receipt.operation, 'timeline.fps.set');
    return {receipt, replay: () => service.commit(request)};
  };
  const history = (direction: 'undo' | 'redo', actionId: string) => {
    const {position, revision} = service.history({projectId}) as SequenceEditHistoryView;
    const request = {projectId, requestId: randomUUID(), actionId, expected: {position, revision}};
    const receipt = service[direction](request) as SequenceEditReceipt;
    assert.equal(receipt.status, 'applied');
    assert.equal(receipt.operation, `${direction}:timeline.fps.set`);
    assert.deepEqual(service[direction](request), receipt);
    return receipt;
  };
  return {store, initial, projectId, projectFile, service, preview, apply, history,
    requirements: () => (store.get('projects', projectId) as {requiredReaderFeatures?: unknown}).requiredReaderFeatures};
}

test('format 6 empty FPS commits are isolated header edits with exact replay and undo/redo', t => {
  const {store, initial, preview, apply, history, requirements} = fixture(t);
  const initialReplay = preview(30);
  assert.ok('code' in initialReplay && initialReplay.code === 'SEQUENCE_EDIT_NOOP');
  assert.equal(requirements(), undefined);
  const request24 = apply(24);
  assert.deepEqual(requirements(), [TIMELINE_FPS_READER_FEATURE]);
  for (const fps of [25, 60, 30] as const) {
    const before = timeline(store);
    const {receipt} = apply(fps);
    const latest = timeline(store);
    assert.equal(latest.fps, fps);
    assert.equal(latest.revision, before.revision + 1);
    assert.equal(receipt.timelineRevision, latest.revision);
    assert.equal(receipt.syncRevision, 1);
    assert.deepEqual(latest.tracks, initial.tracks);
    const entry = readSequenceEditHistoryEntry(store, receipt.actionId);
    assert.equal(entry?.beforePatch.timeline.header?.kind, 'set');
    assert.deepEqual(entry?.afterPatch.timeline.header, {kind: 'set', value: {fps, width: initial.width, height: initial.height}});
    assert.deepEqual(entry?.afterPatch.timeline.clips, []);
    history('undo', receipt.actionId);
    assert.equal(timeline(store).fps, before.fps);
    history('redo', receipt.actionId);
    assert.equal(timeline(store).fps, fps);
  }
  assert.deepEqual(request24.replay(), request24.receipt);
  assert.equal(timeline(store).fps, 30);
  assert.deepEqual(requirements(), [TIMELINE_FPS_READER_FEATURE]);
});

test('crossing 30 fps via history retains reader requirements, including after saving and restoring an older 30 fps version', t => {
  const {store, projectId, projectFile, apply, history, requirements} = fixture(t);
  const versions = createProjectVersions(store, {assertMutationAllowed() {}});
  const version = versions.save({projectId, requestId: randomUUID()});
  const {receipt} = apply(24);
  assert.throws(() => versions.preview({projectId, versionId: version.version.id}),
    {code: 'TIMELINE_FORMAT_LOCKED', details: {reason: 'PROJECT_VERSION_CLOCK_MISMATCH', currentFps: 24, savedFps: 30}});
  history('undo', receipt.actionId);
  assert.equal(timeline(store).fps, 30);
  const unchanged = versions.preview({projectId, versionId: version.version.id});
  assert.ok(!unchanged.changes.some(change => change.table === 'projects'));
  assert.throws(() => store.tx(() => store.db.prepare("UPDATE project.projects SET data=json_remove(data,'$.requiredReaderFeatures')").run()),
    {code: 'TIMELINE_FORMAT_LOCKED'});
  store.tx(() => {
    const metadata = store.get('projects', projectId) as {name: string};
    store.put('projects', {...metadata, name: 'Renamed'});
  });
  const confirmation = versions.preview({projectId, versionId: version.version.id});
  const projectChange = confirmation.changes.find(change => change.table === 'projects');
  assert.ok(projectChange);
  const restored = versions.restore({projectId, versionId: version.version.id, requestId: randomUUID(),
    previewDigest: confirmation.previewDigest, expectedContentSequence: confirmation.contentSequence, expectedContentToken: confirmation.contentToken});
  assert.deepEqual(restored.appliedChanges.find(change => change.table === 'projects'), projectChange);
  assert.deepEqual(requirements(), [TIMELINE_FPS_READER_FEATURE]);
  store.close();
  delete process.env.MIOON_FORMAT6_DEV;
  assert.throws(() => inspectProjectFormatReadOnly(projectFile, {allowFormat6: true}), {code: PROJECT_READER_UPDATE_REQUIRED});
});

test('clock changes use the development flag and format-6 storage even for an empty 30 fps project', t => {
  const {preview, store} = fixture(t);
  delete process.env.MIOON_FORMAT6_DEV;
  const rejected = preview(24);
  assert.ok('reason' in rejected);
  assert.equal(rejected.reason, 'FORMAT_REQUIRED');
  assert.equal(timeline(store).fps, 30);
});

test('format 5 rejects the FPS intent through the shared preview', t => {
  const {preview, store} = fixture(t, 5);
  const rejected = preview(25);
  assert.ok('reason' in rejected);
  assert.equal(rejected.reason, 'FORMAT_REQUIRED');
  assert.equal(timeline(store).fps, 30);
});

test('clip and cue targets lock direct FPS changes even after those rows have gone', t => {
  const {store, initial, projectId, apply, preview, history} = fixture(t);
  const {receipt} = apply(25);
  const assetId = randomUUID(), clipId = randomUUID(), cueId = randomUUID(), trackId = randomUUID();
  store.tx(() => {
    store.put('assets', {id: assetId, projectId, mimeType: 'image/png', duration: null, sha256: 'a'.repeat(64)});
    store.put('timelines', {...timeline(store), durationFrames: 25,
      tracks: [...initial.tracks, {id: trackId, name: 'V2', kind: 'video', orderIndex: 1, hidden: false, muted: false}],
      clips: [{id: clipId, trackId, name: 'Still', startFrame: 0, durationFrames: 25,
        sourceInFrame: 0, rect: {x: 0, y: 0, width: initial.width, height: initial.height}, gain: 1, assetId,
        sourceState: 'ready', anchor: null}],
      subtitles: {profileId: 'bottom_cjk_v1', cues: [{id: cueId, text: 'Still', startFrame: 0, durationFrames: 25, anchor: null}]}});
  });
  let rejected = preview(24);
  assert.ok('reason' in rejected);
  assert.equal(rejected.reason, 'TIMELINE_NOT_EMPTY');
  store.tx(() => store.put('timelines', {...timeline(store), durationFrames: 0, clips: [],
    subtitles: {profileId: 'bottom_cjk_v1', cues: []}}));
  const targetRevisions = store.db.prepare(`SELECT kind, targetId FROM project.agent_task_target_revisions_v2
    WHERE projectId=? AND kind IN ('timeline_clip','timeline_subtitle') ORDER BY kind`).all(projectId);
  assert.deepEqual(targetRevisions.map(row => [row.kind, row.targetId]), [['timeline_clip', clipId], ['timeline_subtitle', cueId]]);
  rejected = preview(24);
  assert.ok('reason' in rejected);
  assert.equal(rejected.reason, 'TIMELINE_CONTENT_PREVIOUSLY_EXISTS');
  history('undo', receipt.actionId);
  assert.equal(timeline(store).fps, 30);
  history('redo', receipt.actionId);
  assert.equal(timeline(store).fps, 25);
});


test('a retained render acknowledgement blocks FPS changes and clock-history undo', t => {
  const {store, projectId, preview, apply, service} = fixture(t);
  const {receipt} = apply(24);
  const requestId = randomUUID();
  const accepted = JSON.stringify({id: randomUUID(), requestId, projectId, mode: 'timeline',
    snapshot: {timeline: {fps: 24}}});
  // An acknowledged render receipt may remain after the output was removed.
  store.tx(() => store.db.prepare('INSERT INTO main.timeline_requests(requestId,requestHash,response) VALUES(?,?,?)')
    .run(requestId, 'a'.repeat(64), accepted));
  const rejected = preview(25);
  assert.ok('reason' in rejected);
  assert.equal(rejected.reason, 'FROZEN_TIMELINE_OUTPUT');
  const state = service.history({projectId}) as SequenceEditHistoryView & {undoConflict: boolean};
  assert.equal(state.undoConflict, true);
  assert.throws(() => service.undo({projectId, actionId: receipt.actionId, requestId: randomUUID(),
    expected: {position: state.position, revision: state.revision}}),
  {code: 'TIMELINE_FPS_LOCKED', details: {reason: 'FROZEN_TIMELINE_OUTPUT'}});
  assert.equal(timeline(store).fps, 24);
  assert.equal(store.db.prepare('SELECT response FROM main.timeline_requests WHERE requestId=?').get(requestId)?.response, accepted);
});

for (const mode of ['timeline', 'clip-audio'] as const) {
  test(`a retained ${mode} export row locks empty-timeline FPS edits and history`, t => {
    const {store, projectId, preview, apply, service} = fixture(t);
    const {receipt} = apply(25);
    const id = randomUUID(), requestId = randomUUID(), clipId = randomUUID();
    const audioRequest = {projectId, requestId, clipId};
    const frozen = mode === 'timeline' ? {id, projectId, mode, snapshot: {timeline: {fps: 25}}} : {
      id, projectId, requestId, mode, version: 1, status: 'queued', phase: 'preparing', progress: null,
      error: null, output: null, assetId: null, url: null, createdAt: at, updatedAt: at,
      source: {clipId, clipName: 'Synthetic', assetId: randomUUID(), assetSha256: 'a'.repeat(64),
        name: 'Synthetic', mimeType: 'video/mp4', sizeBytes: 1, sourceInFrame: 0, durationFrames: 25, fps: 25},
    };
    store.tx(() => {
      store.db.prepare('INSERT INTO main.exports(id,projectId,data) VALUES(?,?,?)').run(id, projectId, JSON.stringify(frozen));
      if (mode === 'clip-audio') {
        store.db.prepare("INSERT INTO main.idempotency(scope,requestId,requestHash,resourceId) VALUES('clip-audio-export',?,?,?)")
          .run(requestId, clipAudioExportRequestHash(audioRequest), id);
      }
    });
    const rejected = preview(24);
    assert.ok('reason' in rejected);
    assert.equal(rejected.reason, 'FROZEN_TIMELINE_OUTPUT');
    const {position, revision} = service.history({projectId}) as SequenceEditHistoryView;
    assert.throws(() => service.undo({projectId, actionId: receipt.actionId, requestId: randomUUID(), expected: {position, revision}}),
      {code: 'TIMELINE_FPS_LOCKED', details: {reason: 'FROZEN_TIMELINE_OUTPUT'}});
    assert.equal(timeline(store).fps, 25);
    if (mode === 'clip-audio') {
      assert.deepEqual(getClipAudioExport(store, {projectId, exportId: id}).record, frozen);
      assert.deepEqual(startClipAudioExport(store, audioRequest), frozen);
    }
  });
}
