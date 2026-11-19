import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {upgradeProjectFormatTo5} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from './helpers/format4-release-fixture.ts';
import {prepareSequenceEditHistory, findSequenceEditReceipt} from '../packages/business/src/format5-editor-history.ts';
import {runSequenceSync, moveSequenceSyncHistory} from '../packages/business/src/format5-sequence-sync.ts';
import {buildSubjectBindingEnvelope} from '../packages/business/src/format5-subject-binding.ts';
import {buildSubjectCardEnvelope, planSubjectEditAction, readSubjectCardProjection} from '../packages/business/src/format5-subject-card.ts';
import {sequenceBoardGetResponseSchema} from '../packages/contracts/src/sequence-edit-rpc.ts';

let scratch: string;
before(() => {scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'format5-sb-card-'));});
after(() => {rmSync(scratch, {recursive: true, force: true});});
let serial = 0;
function fixture(): ReturnType<typeof prepare> {
  return prepare();
}
function prepare() {
  const base = path.join(scratch, `prepare-${serial++}`);
  mkdirSync(base, {mode: 0o700});
  const source = prepareFormat5Release(base, 'v0.2.0');
  const root = path.join(scratch, `card-${serial++}`);
  cpSync(source.sample, root, {recursive: true, errorOnExist: true, force: false});
  const paths = releaseProjectPaths(root);
  for (const directory of [root, ...Object.values(paths.location)]) chmodSync(directory, 0o700);
  const upgraded = upgradeProjectFormatTo5({projectFile: paths.projectFile, locate: () => paths.location, approveUpgrade: () => true});
  return {store: upgraded.store, root, paths};
}
interface Seeded {store: ProjectStore; subjectId: string; versionId: string; cardId: string; shotId: string; imageAssetId: string}
function seed(f: ReturnType<typeof prepare>, {card = true}: {card?: boolean} = {}): Seeded {
  const {store} = f;
  const asset = store.db.prepare(`SELECT id,data FROM project.assets WHERE json_valid(data)
    AND json_extract(data,'$.mimeType')='image/png' LIMIT 1`).get() as {id: string; data: string} | undefined;
  assert.ok(asset);
  const image = JSON.parse(asset.data) as Record<string, unknown>;
  const shot = store.db.prepare('SELECT id FROM project.shots WHERE archivedAt IS NULL ORDER BY id LIMIT 1').get() as {id: string};
  const subjectId = randomUUID(), cardId = randomUUID(), versionId = randomUUID(), timestamp = '2026-01-03T00:00:00.000Z';
  const versionData = JSON.stringify({id: versionId, projectId: store.projectId, subjectId, number: 1, assetId: asset.id,
    sha256: image.sha256, mimeType: image.mimeType, width: image.width ?? 1080, height: image.height ?? 1920,
    createdAt: timestamp, provenance: {kind: 'user-import', versionId: null, shotId: null, jobId: null}});
  store.tx(() => {
    store.db.prepare(`INSERT INTO project.subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?)`).run(subjectId, store.projectId, 'character', 'Hero', 1, versionId, timestamp, timestamp);
    store.db.prepare(`INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)`)
      .run(versionId, store.projectId, subjectId, 1, asset.id, versionData);
    if (card) store.put('nodes', {id: cardId, projectId: store.projectId, type: 'subject_card', subjectId,
      position: {x: 120, y: 80}, createdAt: timestamp});
  });
  return {store, subjectId, versionId, cardId, shotId: shot.id, imageAssetId: asset.id};
}
function action(seeded: Seeded) {
  const state = prepareSequenceEditHistory(seeded.store);
  return {epoch: state.state.epoch, historyPosition: state.state.position, historyRevision: state.state.revision};
}
function cardEnvelope(seeded: Seeded, command: Parameters<typeof buildSubjectCardEnvelope>[1]) {
  return buildSubjectCardEnvelope(seeded.store, command, {...action(seeded), requestId: `card-${randomUUID()}`,
    actionId: randomUUID()});
}
function undo(seeded: Seeded, envelope: {actionId: string}) {
  const state = prepareSequenceEditHistory(seeded.store);
  return moveSequenceSyncHistory(seeded.store, {projectId: seeded.store.projectId, requestId: `undo-${randomUUID()}`,
    actionId: envelope.actionId, direction: 'undo', expected: {position: state.state.position, revision: state.state.revision}});
}
function redo(seeded: Seeded, envelope: {actionId: string}) {
  const state = prepareSequenceEditHistory(seeded.store);
  return moveSequenceSyncHistory(seeded.store, {projectId: seeded.store.projectId, requestId: `redo-${randomUUID()}`,
    actionId: envelope.actionId, direction: 'redo', expected: {position: state.state.position, revision: state.state.revision}});
}
function cardCount(store: ProjectStore, subjectId?: string) {
  return store.db.prepare(`SELECT count(*) AS n FROM project.nodes WHERE projectId=? AND archivedAt IS NULL
    AND json_valid(data) AND json_extract(data,'$.type')='subject_card'
    ${subjectId === undefined ? '' : "AND json_extract(data,'$.subjectId')=?"}`)
    .get(...(subjectId === undefined ? [store.projectId] : [store.projectId, subjectId]))!.n as number;
}

test('a subject card is created from retained subject data and undone/redone as one board action', () => {
  const f = fixture(), seeded = seed(f, {card: false}), store = seeded.store;
  try {
    const nodeId = randomUUID();
    const envelope = cardEnvelope(seeded, {kind: 'card-create', nodeId, subjectId: seeded.subjectId,
      position: {x: 40, y: 60}});
    assert.deepEqual(planSubjectEditAction(store, envelope).after.board.writes.map(item => item.kind), ['node']);
    const created = runSequenceSync(store, envelope);
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(cardCount(store), 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.subject_versions WHERE subjectId=?').get(seeded.subjectId)!.n, 1,
      'creating a card never copies subject works');
    assert.equal(findSequenceEditReceipt(store, envelope.requestId)?.receipt.operation, 'subject.card.create');
    assert.equal(undo(seeded, envelope).ok, true);
    assert.equal(cardCount(store), 0);
    assert.equal(redo(seeded, envelope).ok, true);
    assert.equal(cardCount(store), 1);
  } finally {store.close();}
});

test('deleting one card detaches its active bindings and removes their edges; undo restores the exact step', () => {
  const f = fixture(), seeded = seed(f), store = seeded.store;
  try {
    const bindingId = randomUUID(), edgeId = randomUUID();
    const binding = buildSubjectBindingEnvelope(store, {kind: 'create', bindingId, shotId: seeded.shotId,
      subjectId: seeded.subjectId, role: 'subject'}, {...action(seeded), requestId: `bind-${randomUUID()}`,
      actionId: randomUUID(), edgeId});
    assert.equal(runSequenceSync(store, binding).ok, true);
    const envelope = cardEnvelope(seeded, {kind: 'card-delete', nodeId: seeded.cardId});
    const planned = planSubjectEditAction(store, envelope);
    assert.equal(planned.after.board.removals.some(item => item.kind === 'node'), true);
    assert.equal(planned.after.board.writes.some(item => item.kind === 'subject_binding'), true);
    const deleted = runSequenceSync(store, envelope);
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.equal(cardCount(store), 0);
    assert.equal(store.db.prepare('SELECT bindingMode FROM project.subject_bindings WHERE id=?').get(bindingId)!.bindingMode, 'detached');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.edges WHERE id=?').get(edgeId)!.n, 0);
    assert.equal(undo(seeded, envelope).ok, true);
    assert.equal(cardCount(store), 1);
    assert.equal(store.db.prepare('SELECT bindingMode FROM project.subject_bindings WHERE id=?').get(bindingId)!.bindingMode, 'follow');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.edges WHERE id=?').get(edgeId)!.n, 1);
    assert.equal(redo(seeded, envelope).ok, true);
    assert.equal(cardCount(store), 0);
  } finally {store.close();}
});

test('the board read projection lists subjects, their versions and every binding state', () => {
  const f = fixture(), seeded = seed(f), store = seeded.store;
  try {
    const bindingId = randomUUID(), edgeId = randomUUID();
    assert.equal(runSequenceSync(store, buildSubjectBindingEnvelope(store, {kind: 'create', bindingId, shotId: seeded.shotId,
      subjectId: seeded.subjectId, role: 'subject'}, {...action(seeded), requestId: `bind-${randomUUID()}`,
      actionId: randomUUID(), edgeId})).ok, true);
    const projection = readSubjectCardProjection(store);
    assert.deepEqual(projection.subjects.map(subject => subject.name), ['Hero']);
    assert.equal(projection.subjects[0]!.headVersionId, seeded.versionId);
    assert.deepEqual(projection.subjects[0]!.versions.map(version => version.number), [1]);
    assert.deepEqual(projection.bindings.map(item => ({shotId: item.shotId, mode: item.bindingMode, edgeId: item.edgeId})),
      [{shotId: seeded.shotId, mode: 'follow', edgeId}]);
    const response = sequenceBoardGetResponseSchema.safeParse({projectId: store.projectId, timelineRevision: 1,
      syncRevision: 1, inSync: true, archived: [], subjects: projection.subjects, bindings: projection.bindings});
    assert.equal(response.success, true, JSON.stringify(response.success ? null : response.error.issues));
  } finally {store.close();}
});

test('card creation rejects a duplicate subject card and an unknown subject', () => {
  const f = fixture(), seeded = seed(f), store = seeded.store;
  try {
    const duplicate = cardEnvelope(seeded, {kind: 'card-create', nodeId: randomUUID(), subjectId: seeded.subjectId,
      position: {x: 0, y: 0}});
    assert.throws(() => planSubjectEditAction(store, duplicate), {code: 'SEQUENCE_EDIT_SUBJECT_BINDING_INVALID'});
    assert.throws(() => cardEnvelope(seeded, {kind: 'card-delete', nodeId: randomUUID()}),
      {code: 'SEQUENCE_EDIT_SUBJECT_BINDING_INVALID'});
  } finally {store.close();}
});
