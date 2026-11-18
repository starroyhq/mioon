import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {getFormat5TimelineIssue} from '../packages/contracts/src/project-format5.ts';
import {defaultPrevisScene, isPrevisScene, previsSceneSchema} from '../packages/contracts/src/previs.ts';
import {upgradeProjectFormatTo5} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from './helpers/format4-release-fixture.ts';
import {prepareSequenceEditHistory, findSequenceEditReceipt} from '../packages/business/src/format5-editor-history.ts';
import {runSequenceSync, moveSequenceSyncHistory} from '../packages/business/src/format5-sequence-sync.ts';
import {
  buildSubjectBindingEnvelope, readSubjectBinding, readSubjectBindings, resolveGenerationSubjectInputs,
  resolvePrevisSubjectReference, subjectCardDeletionImpact, subjectDeletionImpact,
} from '../packages/business/src/format5-subject-binding.ts';

let scratch: string;
before(() => {scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'format5-sb-'));});
after(() => {rmSync(scratch, {recursive: true, force: true});});

let serial = 0;
function fixture() {
  const base = path.join(scratch, `prepare-${serial++}`);
  mkdirSync(base, {mode: 0o700});
  const source = prepareFormat5Release(base, 'v0.2.0');
  const root = path.join(scratch, `sb-${serial++}`);
  cpSync(source.sample, root, {recursive: true, errorOnExist: true, force: false});
  const paths = releaseProjectPaths(root);
  for (const directory of [root, ...Object.values(paths.location)]) chmodSync(directory, 0o700);
  const upgraded = upgradeProjectFormatTo5({projectFile: paths.projectFile, locate: () => paths.location, approveUpgrade: () => true});
  return {store: upgraded.store, root, paths};
}

interface Seeded {store: ProjectStore; subjectId: string; versionIds: string[]; cardId: string; shotId: string; imageAssetId: string}
function seed(f: ReturnType<typeof fixture>): Seeded {
  const {store} = f;
  const asset = store.db.prepare(`SELECT id,data FROM project.assets WHERE json_valid(data)
    AND json_extract(data,'$.mimeType')='image/png' LIMIT 1`).get() as {id: string; data: string} | undefined;
  assert.ok(asset);
  const image = JSON.parse(asset.data) as Record<string, unknown>;
  const shot = store.db.prepare('SELECT id FROM project.shots WHERE archivedAt IS NULL ORDER BY id LIMIT 1').get() as {id: string};
  const subjectId = randomUUID(), cardId = randomUUID(), timestamp = '2026-01-03T00:00:00.000Z';
  const version = (): {id: string; number: number} => ({id: randomUUID(), number: 1});
  const head = version();
  const versionData = (id: string, number: number) => JSON.stringify({id, projectId: store.projectId, subjectId,
    number, assetId: asset.id, sha256: image.sha256, mimeType: image.mimeType,
    width: image.width ?? 1080, height: image.height ?? 1920, createdAt: timestamp,
    provenance: {kind: 'user-import', versionId: null, shotId: null, jobId: null}});
  store.tx(() => {
    store.db.prepare(`INSERT INTO project.subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?)`).run(subjectId, store.projectId, 'character', 'Hero', 1, head.id, timestamp, timestamp);
    store.db.prepare(`INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)`)
      .run(head.id, store.projectId, subjectId, 1, asset.id, versionData(head.id, 1));
    store.put('nodes', {id: cardId, projectId: store.projectId, type: 'subject_card', subjectId,
      position: {x: 120, y: 80}, createdAt: timestamp});
  });
  return {store, subjectId, versionIds: [head.id], cardId, shotId: shot.id, imageAssetId: asset.id};
}

function nextAction(seeded: Seeded) {
  const state = prepareSequenceEditHistory(seeded.store);
  return {epoch: state.state.epoch, historyPosition: state.state.position, historyRevision: state.state.revision};
}

function bindingCommand(seeded: Seeded, kind: 'create' | 'set-mode' | 'detach' | 'restore',
  extra: Record<string, unknown> = {}) {
  const base = {bindingId: '', ...extra};
  return {kind, ...base} as never;
}

test('format-5 binding create, follow/locked, detach, restore and one-step undo use the shared history', () => {
  const f = fixture(), seeded = seed(f), store = seeded.store;
  try {
    const bindingId = randomUUID(), edgeId = randomUUID();
    const action = nextAction(seeded);
    const createEnvelope = buildSubjectBindingEnvelope(store,
      {kind: 'create', bindingId, shotId: seeded.shotId, subjectId: seeded.subjectId, role: 'subject'},
      {...action, requestId: 'subject-binding-create-0001', actionId: randomUUID(), edgeId});
    assert.equal(getFormat5TimelineIssue((store.list('timelines') as never[])[0] as never, {projectId: store.projectId}), null);
    const created = runSequenceSync(store, createEnvelope);
    assert.equal(created.ok, true, JSON.stringify(created));
    const follow = readSubjectBinding(store, bindingId)!;
    assert.equal(follow.bindingMode, 'follow');
    assert.equal(follow.subjectVersionId, null);
    assert.equal(store.db.prepare('SELECT count(*) n FROM project.edges WHERE id=?').get(edgeId)!.n, 1);
    assert.equal(findSequenceEditReceipt(store, 'subject-binding-create-0001')?.receipt.affected.subjectBindings, 1);
    // Generation input freezes the current head and its asset hash.
    const frozen = resolveGenerationSubjectInputs(store, [seeded.shotId]);
    assert.deepEqual(frozen.map(item => ({...item, sha256: undefined})), [{bindingId, subjectId: seeded.subjectId,
      subjectVersionId: seeded.versionIds[0]!, role: 'subject', mode: 'follow', sha256: undefined,
      mimeType: 'image/png'}]);
    assert.match(frozen[0]!.sha256, /^[a-f0-9]{64}$/u);
    // Undo create: row survives as a detached tombstone, edge removed, revision advanced.
    const afterCreate = prepareSequenceEditHistory(store);
    const undo = moveSequenceSyncHistory(store, {projectId: store.projectId, requestId: 'subject-binding-create-undo-1',
      actionId: createEnvelope.actionId, direction: 'undo',
      expected: {position: afterCreate.state.position, revision: afterCreate.state.revision}});
    assert.equal(undo.ok, true, JSON.stringify(undo));
    const detached = readSubjectBinding(store, bindingId)!;
    assert.equal(detached.bindingMode, 'detached');
    assert.equal(detached.subjectVersionId, null);
    assert.ok(detached.revision > follow.revision);
    assert.equal(store.db.prepare('SELECT count(*) n FROM project.edges WHERE id=?').get(edgeId)!.n, 0);
    // Redo create restores follow and the reference edge, still without a new row.
    const afterUndo = prepareSequenceEditHistory(store);
    const redo = moveSequenceSyncHistory(store, {projectId: store.projectId, requestId: 'subject-binding-create-redo-1',
      actionId: createEnvelope.actionId, direction: 'redo',
      expected: {position: afterUndo.state.position, revision: afterUndo.state.revision}});
    assert.equal(redo.ok, true, JSON.stringify(redo));
    assert.equal(readSubjectBinding(store, bindingId)!.bindingMode, 'follow');
    assert.equal(store.db.prepare('SELECT count(*) n FROM project.edges WHERE id=?').get(edgeId)!.n, 1);

    // Lock the current head; generation input keeps that version even after a
    // newer head arrives, while a follow binding switches to the new head.
    const lockAction = nextAction(seeded);
    const locked = runSequenceSync(store, buildSubjectBindingEnvelope(store,
      {kind: 'set-mode', bindingId, bindingMode: 'locked', subjectVersionId: seeded.versionIds[0]!},
      {...lockAction, requestId: 'subject-binding-lock-0001', actionId: randomUUID(), edgeId: randomUUID()}));
    assert.equal(locked.ok, true, JSON.stringify(locked));
    const secondVersionId = randomUUID();
    store.tx(() => {
      const asset = store.db.prepare('SELECT id,data FROM project.assets WHERE id=?').get(seeded.imageAssetId) as {id: string; data: string};
      const image = JSON.parse(asset.data) as Record<string, unknown>;
      store.db.prepare(`INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)`)
        .run(secondVersionId, store.projectId, seeded.subjectId, 2, asset.id,
          JSON.stringify({id: secondVersionId, projectId: store.projectId, subjectId: seeded.subjectId, number: 2,
            assetId: asset.id, sha256: image.sha256, mimeType: image.mimeType, width: image.width ?? 1080,
            height: image.height ?? 1920, createdAt: '2026-01-04T00:00:00.000Z',
            provenance: {kind: 'user-import', versionId: null, shotId: null, jobId: null}}));
      store.db.prepare('UPDATE project.subjects SET headVersionId=?,revision=2,updatedAt=? WHERE id=?')
        .run(secondVersionId, '2026-01-04T00:00:00.000Z', seeded.subjectId);
    });
    assert.equal(resolveGenerationSubjectInputs(store, [seeded.shotId])[0]!.subjectVersionId, seeded.versionIds[0]!);
    const followAction = nextAction(seeded);
    const followBack = runSequenceSync(store, buildSubjectBindingEnvelope(store,
      {kind: 'set-mode', bindingId, bindingMode: 'follow', subjectVersionId: null},
      {...followAction, requestId: 'subject-binding-follow-0001', actionId: randomUUID(), edgeId: randomUUID()}));
    assert.equal(followBack.ok, true, JSON.stringify(followBack));
    assert.equal(resolveGenerationSubjectInputs(store, [seeded.shotId])[0]!.subjectVersionId, secondVersionId);
    // Undo follow: locked content comes back (revision moves forward, row stays).
    const followState = prepareSequenceEditHistory(store);
    const followUndo = moveSequenceSyncHistory(store, {projectId: store.projectId, requestId: 'subject-binding-follow-undo-1',
      actionId: followBack.actionId, direction: 'undo', expected: {position: followState.state.position, revision: followState.state.revision}});
    assert.equal(followUndo.ok, true, JSON.stringify(followUndo));
    const restoredLock = readSubjectBinding(store, bindingId)!;
    assert.equal(restoredLock.bindingMode, 'locked');
    assert.equal(restoredLock.subjectVersionId, seeded.versionIds[0]);
    assert.ok(restoredLock.revision > readSubjectBinding(store, bindingId)!.revision - 100);
    // Detach removes the edge and keeps the row; generation input drops it.
    const detachAction = nextAction(seeded);
    const detachedResult = runSequenceSync(store, buildSubjectBindingEnvelope(store,
      {kind: 'detach', bindingId}, {...detachAction, requestId: 'subject-binding-detach-0001', actionId: randomUUID(), edgeId: randomUUID()}));
    assert.equal(detachedResult.ok, true, JSON.stringify(detachedResult));
    assert.equal(readSubjectBinding(store, bindingId)!.bindingMode, 'detached');
    assert.equal(store.db.prepare('SELECT count(*) n FROM project.edges WHERE json_extract(data,\'$.subjectBindingId\')=?').get(bindingId)!.n, 0);
    assert.deepEqual(resolveGenerationSubjectInputs(store, [seeded.shotId]), []);
    // Restore brings the reference edge back through the pre-allocated id.
    const restoreEdgeId = randomUUID(), restoreAction = nextAction(seeded);
    const restored = runSequenceSync(store, buildSubjectBindingEnvelope(store,
      {kind: 'restore', bindingId, bindingMode: 'follow', subjectVersionId: null},
      {...restoreAction, requestId: 'subject-binding-restore-0001', actionId: randomUUID(), edgeId: restoreEdgeId}));
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(readSubjectBinding(store, bindingId)!.bindingMode, 'follow');
    assert.equal(store.db.prepare('SELECT count(*) n FROM project.edges WHERE id=?').get(restoreEdgeId)!.n, 1);
    // Deletion confirmation impact keeps the tombstone list separate.
    const impact = subjectDeletionImpact(store, seeded.subjectId);
    assert.deepEqual(impact.shotIds, [seeded.shotId]);
    assert.ok(impact.bindingIds.includes(bindingId));
    assert.ok(impact.activeBindingIds.includes(bindingId));
    const cardImpact = subjectCardDeletionImpact(store, seeded.cardId);
    assert.deepEqual(cardImpact.subjectIds, [seeded.subjectId]);
    assert.deepEqual(cardImpact.bindingIds, [bindingId]);
  } finally {store.close();}
});

test('a detached binding refuses direct set-mode and a duplicate create is refused', () => {
  const f = fixture(), seeded = seed(f), store = seeded.store;
  try {
    const bindingId = randomUUID(), edgeId = randomUUID(), action = nextAction(seeded);
    const create = buildSubjectBindingEnvelope(store, {kind: 'create', bindingId, shotId: seeded.shotId,
      subjectId: seeded.subjectId, role: 'subject'}, {...action, requestId: 'subject-binding-dup-0001',
      actionId: randomUUID(), edgeId});
    assert.equal(runSequenceSync(store, create).ok, true);
    const duplicateAction = nextAction(seeded);
    const duplicate = runSequenceSync(store, buildSubjectBindingEnvelope(store, {kind: 'create', bindingId: randomUUID(),
      shotId: seeded.shotId, subjectId: seeded.subjectId, role: 'subject'}, {...duplicateAction,
      requestId: 'subject-binding-dup-0002', actionId: randomUUID(), edgeId: randomUUID()}));
    assert.equal(duplicate.ok, false);
    assert.equal((duplicate as {code: string}).code, 'SEQUENCE_EDIT_SUBJECT_BINDING_INVALID');
  } finally {store.close();}
});

test('previs mannequin and prop may name a subject and follow/locked resolves like a binding', () => {
  const f = fixture(), seeded = seed(f), store = seeded.store;
  try {
    const scene = defaultPrevisScene();
    scene.figures[0] = {...scene.figures[0]!, subject: {subjectId: seeded.subjectId, subjectVersionId: null}};
    assert.equal(isPrevisScene(scene), true);
    scene.props = [{id: 'p1', kind: 'box', name: '', visible: true, position: [0, 0, 0], rotation: 0,
      size: [0.5, 0.5, 0.5], subject: {subjectId: seeded.subjectId, subjectVersionId: seeded.versionIds[0]!}}];
    assert.equal(previsSceneSchema.safeParse(scene).success, true);
    const follow = resolvePrevisSubjectReference(store, {subjectId: seeded.subjectId, subjectVersionId: null});
    assert.equal(follow.mode, 'follow');
    assert.equal(follow.subjectVersionId, seeded.versionIds[0]);
    const locked = resolvePrevisSubjectReference(store, {subjectId: seeded.subjectId, subjectVersionId: seeded.versionIds[0]!});
    assert.equal(locked.mode, 'locked');
    assert.match(locked.sha256, /^[a-f0-9]{64}$/u);
  } finally {store.close();}
});
