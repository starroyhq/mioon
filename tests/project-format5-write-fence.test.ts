import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {applyFormat5TimelineEntities, readFormat5TimelineRecord} from '../packages/business/src/project-file/index.ts';
import {format5TimelineHeader} from '../packages/contracts/src/project-format5.ts';
import type {Format5Timeline} from '../packages/contracts/src/project-format5.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-format5-fence-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(root, 'project.mioon'), format5: true,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const timeline: Format5Timeline = {id: id(5), projectId: store.projectId, revision: 1, width: 720, height: 1280, fps: 30,
    durationFrames: 0, createdAt: at, updatedAt: at,
    mainTrack: {trackId: id(6), sequenceNodeId: id(7)},
    tracks: [{id: id(6), name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips: []};
  store.tx(() => {
    store.put('projects', {id: store.projectId, name: 'Synthetic editor', createdAt: at, updatedAt: at, revision: 1});
    store.put('nodes', {id: id(7), projectId: store.projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    for (const number of [2, 3]) store.put('shots', {id: id(number), projectId: store.projectId, name: `Shot ${number}`,
      orderIndex: number, selectedVersionId: null, duration: 1, createdAt: at, updatedAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timeline.id, store.projectId, timeline.mainTrack.sequenceNodeId, 1, JSON.stringify({version: 1, board: [], track: []}));
  });
  return {store, timeline};
}
function state(store: ProjectStore) {
  return {stamp: readProjectContentStamp(store.db),
    timeline: store.db.prepare('SELECT data FROM project.timelines WHERE id=?').get(id(5))!.data,
    edges: store.db.prepare('SELECT id,data FROM project.edges ORDER BY id').all(),
    targets: store.db.prepare('SELECT * FROM project.agent_task_target_revisions_v2 ORDER BY kind,targetId').all(),
    history: store.db.prepare('SELECT * FROM main.history_state').all()};
}

test('one-in/one-out SQL constraints admit a cycle which the actual store transaction rejects atomically', t => {
  const {store} = fixture(t), before = state(store);
  assert.throws(() => store.tx(() => {
    store.put('edges', {id: id(10), projectId: store.projectId, source: id(2), target: id(3), kind: 'sequence', createdAt: at});
    store.put('edges', {id: id(11), projectId: store.projectId, source: id(3), target: id(2), kind: 'sequence', createdAt: at});
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.edges').get()!.n, 2,
      'the native CHECK and partial indexes allowed both rows before terminal SA validation');
  }), {code: 'PROJECT_INVALID'});
  assert.deepEqual(state(store), before);
});

test('a standalone store.put cannot publish a main-track placeholder outside its root chain', t => {
  const {store, timeline} = fixture(t), before = state(store);
  assert.throws(() => store.put('timelines', {...timeline, durationFrames: 30, revision: 2, clips: [{
    id: id(12), trackId: id(6), name: 'Unlinked shot', startFrame: 0, durationFrames: 30, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1,
    assetId: null, versionId: null, jobId: null, shotId: id(2), sourceState: 'placeholder',
    sequenceSource: {kind: 'shot', nodeId: id(2), segmentGroupId: id(13), versionMode: 'follow'},
  }]}), {code: 'PROJECT_INVALID'});
  assert.deepEqual(state(store), before);
});

test('history-only receipts commit without rereading the unchanged graph or timeline', t => {
  const {store} = fixture(t), before = readProjectContentStamp(store.db), sql: string[] = [];
  const prepare = store.db.prepare.bind(store.db);
  const observer = t.mock.method(store.db, 'prepare', (statement: string) => {sql.push(statement); return prepare(statement);});
  store.tx(() => {
    store.db.prepare('INSERT INTO main.editor_requests(requestId,projectId,operation,inputDigest,response,issuedAt,createdAt) VALUES(?,?,?,?,?,?,?)')
      .run('synthetic-editor-receipt', store.projectId, 'synthetic-edit', 'a'.repeat(64), '{}', Date.now(), at);
  });
  observer.mock.restore();
  assert.equal(sql.some(statement => /\b(?:FROM|JOIN)\s+(?:project\.)?(?:nodes|edges|timelines)\b/iu.test(statement)), false,
    'history-only bookkeeping does not scan nodes, edges or the timeline aggregate');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM main.editor_requests').get()!.n, 1);
  assert.deepEqual(readProjectContentStamp(store.db), before);
});


test('native rows assemble the read record and only changed entities advance revisions', t => {
  const {store, timeline} = fixture(t);
  const audioTrack = {id: id(40), name: 'A1', kind: 'audio' as const, orderIndex: 1, hidden: false, muted: false};
  const secondTrack = {id: id(44), name: 'A2', kind: 'audio' as const, orderIndex: 2, hidden: false, muted: false};
  const assetId = id(41), first = id(42), second = id(43);
  store.tx(() => store.put('assets', {id: assetId, projectId: store.projectId, mimeType: 'audio/wav', duration: 1, sha256: 'a'.repeat(64)}));
  const clip = (number: string, name: string, trackId = audioTrack.id) => ({id: number, trackId, name, startFrame: 0, durationFrames: 10, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: .5, assetId, sourceState: 'ready' as const, anchor: null});
  const firstRecord = {...timeline, durationFrames: 10, tracks: [...timeline.tracks, audioTrack, secondTrack],
    clips: [clip(first, 'First sound')]};
  const revision = (targetId: string) => Number(store.db.prepare('SELECT revision FROM project.agent_task_target_revisions_v2 WHERE kind=? AND targetId=?').get('timeline_clip', targetId)?.revision);
  store.tx(() => store.put('timelines', firstRecord));
  const stamp = readProjectContentStamp(store.db);
  assert.equal(revision(first), 1);
  assert.deepEqual(store.get('timelines', timeline.id), firstRecord);
  assert.deepEqual(store.list('timelines'), [firstRecord]);
  // An identical whole-record put rewrites no entity bytes and advances no revision.
  store.tx(() => store.put('timelines', firstRecord));
  assert.equal(revision(first), 1);
  assert.equal(readProjectContentStamp(store.db).contentSequence, stamp.contentSequence + 1);
  // The delta API applies only the requested entity and leaves the other row alone.
  applyFormat5TimelineEntities(store, {clips: [clip(first, 'First sound'), clip(second, 'Second sound', secondTrack.id)]});
  assert.equal(revision(first), 1);
  assert.equal(revision(second), 1);
  const assembled = readFormat5TimelineRecord(store.db, 'project')!;
  assert.deepEqual(assembled.clips.map(value => value.id).sort(), [first, second].sort());
  assert.deepEqual(format5TimelineHeader(assembled).mainTrack, timeline.mainTrack);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.timeline_clips').get()!.n, 2);
});

interface SubjectFixtureOptions {wrongHash?: boolean; variantHead?: boolean}
function insertSubjectGraph(store: ProjectStore, {wrongHash = false, variantHead = false}: SubjectFixtureOptions = {}) {
  const subjectId = id(30), versionId = id(31), assetId = id(32), cardId = id(33), bindingId = id(34);
  store.put('assets', {id: assetId, projectId: store.projectId, mimeType: 'image/png', sha256: 'a'.repeat(64)});
  store.db.prepare('INSERT INTO project.subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
    .run(subjectId, store.projectId, 'character', 'Synthetic subject', 1, versionId, at, at);
  const version = {id: versionId, projectId: store.projectId, subjectId, number: 1, assetId,
    sha256: (wrongHash ? 'b' : 'a').repeat(64), createdAt: at,
    ...(variantHead ? {variant: {kind: 'angle', position: 'front-left', focal: 'standard', batchId: id(50), sourceVersionId: id(51)}} : {})};
  store.db.prepare('INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)')
    .run(version.id, version.projectId, version.subjectId, version.number, version.assetId, JSON.stringify(version));
  store.put('nodes', {id: cardId, projectId: store.projectId, type: 'subject_card', subjectId,
    position: {x: 10, y: 10}, createdAt: at});
  store.db.prepare('INSERT INTO project.subject_bindings(id,projectId,shotId,subjectId,role,revision,subjectVersionId,reviewedHeadVersionId,bindingMode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(bindingId, store.projectId, id(2), subjectId, 'subject', 1, null, null, 'follow', at, at);
  store.put('edges', {id: id(35), projectId: store.projectId, source: cardId, target: id(2), kind: 'reference',
    role: 'subject_reference', subjectBindingId: bindingId, createdAt: at});
}

test('actual subject version JSON supports follow, locked and a locked variant without making the variant a head', t => {
  const {store} = fixture(t);
  store.tx(() => insertSubjectGraph(store));
  assert.equal(store.db.prepare('SELECT bindingMode FROM project.subject_bindings WHERE id=?').get(id(34))!.bindingMode, 'follow');
  store.tx(() => store.db.prepare("UPDATE project.subject_bindings SET bindingMode='locked',subjectVersionId=?,reviewedHeadVersionId=?,revision=revision+1 WHERE id=?")
    .run(id(31), id(31), id(34)));
  store.tx(() => {
    store.put('assets', {id: id(36), projectId: store.projectId, mimeType: 'image/png', sha256: 'b'.repeat(64)});
    const version = {id: id(37), projectId: store.projectId, subjectId: id(30), number: 2, assetId: id(36),
      sha256: 'b'.repeat(64), createdAt: at,
      variant: {kind: 'angle', position: 'front-left', focal: 'standard', batchId: id(50), sourceVersionId: id(31)}};
    store.db.prepare('INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)')
      .run(version.id, version.projectId, version.subjectId, version.number, version.assetId, JSON.stringify(version));
    store.db.prepare('UPDATE project.subjects SET revision=revision+1,updatedAt=? WHERE id=?').run(at, id(30));
    store.db.prepare("UPDATE project.subject_bindings SET subjectVersionId=?,revision=revision+1 WHERE id=?").run(id(37), id(34));
  });
  assert.equal(store.db.prepare('SELECT headVersionId FROM project.subjects WHERE id=?').get(id(30))!.headVersionId, id(31));
  assert.equal(store.db.prepare('SELECT subjectVersionId FROM project.subject_bindings WHERE id=?').get(id(34))!.subjectVersionId, id(37));
  store.tx(() => store.db.prepare("UPDATE project.subject_bindings SET bindingMode='follow',subjectVersionId=NULL,revision=revision+1 WHERE id=?")
    .run(id(34)));
  assert.equal(store.db.prepare('SELECT bindingMode FROM project.subject_bindings WHERE id=?').get(id(34))!.bindingMode, 'follow');
});

for (const invalid of ['wrongHash', 'variantHead'] as const) test(`actual subject graph with ${invalid} is rejected and leaves every new row rolled back`, t => {
  const {store} = fixture(t), before = state(store);
  assert.throws(() => store.tx(() => insertSubjectGraph(store, {[invalid]: true})), {code: 'PROJECT_INVALID'});
  for (const table of ['subjects', 'subject_versions', 'subject_bindings']) {
    assert.equal(store.db.prepare(`SELECT count(*) AS n FROM project.${table}`).get()!.n, 0);
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.assets').get()!.n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM project.nodes WHERE json_extract(data,'$.type')='subject_card'").get()!.n, 0);
  assert.deepEqual(state(store), before);
});
