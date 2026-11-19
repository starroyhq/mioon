import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
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
