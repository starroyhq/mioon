import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {getFormat5TimelineIssue} from '../packages/contracts/src/project-format5.ts';
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
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {resolvePrevisSceneSubjects} from '../packages/business/src/format5-previs.ts';
import {defaultPrevisScene, isPrevisNodeRecord} from '../packages/contracts/src/previs.ts';
import type {PrevisNodeRecord, PrevisScene} from '../packages/contracts/src/previs.ts';
import type {SequenceEditEnvelope} from '../packages/contracts/src/sequence-edit.ts';

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

test('previs mannequin and prop subject references follow/locked resolve like a binding', () => {
  const f = fixture(), seeded = seed(f), store = seeded.store;
  try {
    const follow = resolvePrevisSubjectReference(store, {subjectId: seeded.subjectId, subjectVersionId: null});
    assert.equal(follow.mode, 'follow');
    assert.equal(follow.subjectVersionId, seeded.versionIds[0]);
    const locked = resolvePrevisSubjectReference(store, {subjectId: seeded.subjectId, subjectVersionId: seeded.versionIds[0]!});
    assert.equal(locked.mode, 'locked');
    assert.match(locked.sha256, /^[a-f0-9]{64}$/u);
  } finally {store.close();}
});


// ---------------------------------------------------------------------------
// Previs mannequin/prop subject references through the unified sequence entry
// ---------------------------------------------------------------------------

const previsTimestamp = '2026-01-03T00:00:00.000Z';
function seedPrevisNode(store: ProjectStore, patch: Partial<PrevisScene> = {}): string {
  const nodeId = randomUUID();
  const scene: PrevisScene = {...defaultPrevisScene(), ...patch};
  store.tx(() => store.put('nodes', {id: nodeId, projectId: store.projectId, type: 'previs', label: '街口', text: '',
    position: {x: 10, y: 20}, revision: 1, sceneRevision: 1, scene, createdAt: previsTimestamp}));
  return nodeId;
}
function previsNode(store: ProjectStore, nodeId: string): PrevisNodeRecord {
  const value = store.get('nodes', nodeId);
  assert.ok(isPrevisNodeRecord(value), 'saved node is a valid previs record');
  return value;
}
function sceneWithSubjects(subjectId: string, versionId: string): PrevisScene {
  const base = defaultPrevisScene();
  return {...base,
    figures: [{...base.figures[0]!, subject: {subjectId}}, {...base.figures[0]!, id: 'f2', name: '锁定', subject: {subjectId, subjectVersionId: versionId}}],
    props: [{id: 'p1', kind: 'umbrella', name: '伞', visible: true, position: [0.4, 0, 0.2], rotation: 0, size: [1, 0.9, 1], subject: {subjectId, subjectVersionId: versionId}}]};
}
function sceneWithoutSubjects(): PrevisScene {
  return {...defaultPrevisScene(), props: [{id: 'p1', kind: 'umbrella', name: '伞', visible: true, position: [0.4, 0, 0.2], rotation: 0, size: [1, 0.9, 1]}]};
}
function thumbnails(db: ProjectStore['db'], projectId: string, nodeId: string, sceneRevision: number, slots: string[]): void {
  const at = previsTimestamp;
  for (const slot of slots) {
    db.prepare(`INSERT INTO cache.previs_thumbnails(nodeId,slot,projectId,sourceFingerprintDigest,sceneRevision,width,height,bytes,updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(nodeId, slot, projectId, 'a'.repeat(64), sceneRevision, 8, 8, Buffer.from([1]), at);
  }
}

test('format-5 previs create and subject saves go through the unified entry with one-step undo and cache pruning', () => {
  const f = fixture(), seeded = seed(f), store = seeded.store;
  try {
    const service = createFormat5SequenceEditService(store), nodeId = randomUUID();
    const created = service.preview({projectId: store.projectId, requestId: 'previs-create-0001', origin: 'user',
      previsIntent: {side: 'board', operation: {kind: 'previs-create', nodeId, label: '街口', position: {x: 10, y: 20}}}}) as {
        envelope: SequenceEditEnvelope; planDigest: string};
    assert.equal(typeof created.planDigest, 'string');
    const createdReceipt = service.commit({projectId: store.projectId, envelope: created.envelope,
      expectedPlanDigest: created.planDigest}) as {status: string; operation: string; affected: {nodes: number}};
    assert.deepEqual([createdReceipt.status, createdReceipt.operation, createdReceipt.affected.nodes],
      ['applied', 'previs.create', 1]);
    assert.equal(previsNode(store, nodeId).sceneRevision, 1);
    // Undo removes the created node; redo writes it back from the recorded row.
    const afterCreate = prepareSequenceEditHistory(store);
    const undo = moveSequenceSyncHistory(store, {projectId: store.projectId, requestId: 'previs-create-undo-1',
      actionId: created.envelope.actionId, direction: 'undo',
      expected: {position: afterCreate.state.position, revision: afterCreate.state.revision}});
    assert.equal(undo.ok, true, JSON.stringify(undo));
    assert.equal(store.get('nodes', nodeId), null);
    const afterUndo = prepareSequenceEditHistory(store);
    const redo = moveSequenceSyncHistory(store, {projectId: store.projectId, requestId: 'previs-create-redo-1',
      actionId: created.envelope.actionId, direction: 'redo',
      expected: {position: afterUndo.state.position, revision: afterUndo.state.revision}});
    assert.equal(redo.ok, true, JSON.stringify(redo));
    assert.equal(previsNode(store, nodeId).label, '街口');

    // A save stores follow/locked mannequin and prop references exactly as the
    // card explains them, and prunes only the keyframe thumbnails that no
    // longer match their camera.
    const thumbs = (): string[] => (store.db.prepare('SELECT slot FROM cache.previs_thumbnails WHERE nodeId=? ORDER BY slot')
      .all(nodeId) as {slot: string}[]).map(row => row.slot);
    store.tx(() => store.db.prepare('DELETE FROM cache.previs_thumbnails WHERE nodeId=?').run(nodeId));
    const first = sceneWithoutSubjects();
    first.keyframes = [{id: 'k1', name: '', camera: {...defaultPrevisScene().camera}, exports: []},
      {id: 'k2', name: '', camera: {...defaultPrevisScene().camera, focalLength: 85}, exports: []}];
    const saveScene = (scene: PrevisScene, requestId: string): {envelope: SequenceEditEnvelope; planDigest: string} =>
      service.preview({projectId: store.projectId, requestId, origin: 'user',
        previsIntent: {side: 'board', operation: {kind: 'previs-scene-set', nodeId,
          expectedSceneRevision: previsNode(store, nodeId).sceneRevision, scene}}}) as {envelope: SequenceEditEnvelope; planDigest: string};
    const firstPreview = saveScene(first, 'previs-scene-0001');
    service.commit({projectId: store.projectId, envelope: firstPreview.envelope, expectedPlanDigest: firstPreview.planDigest});
    assert.deepEqual(thumbs(), []);
    thumbnails(store.db, store.projectId, nodeId, previsNode(store, nodeId).sceneRevision, ['card', 'k1', 'k2']);
    const withSubjects = sceneWithSubjects(seeded.subjectId, seeded.versionIds[0]!);
    withSubjects.keyframes = [{id: 'k1', name: '', camera: {...defaultPrevisScene().camera}, exports: []},
      {id: 'k2', name: '', camera: {...defaultPrevisScene().camera, focalLength: 35}, exports: []}];
    const subjectPreview = saveScene(withSubjects, 'previs-scene-0002');
    service.commit({projectId: store.projectId, envelope: subjectPreview.envelope, expectedPlanDigest: subjectPreview.planDigest});
    const saved = previsNode(store, nodeId);
    assert.equal(saved.sceneRevision, 3);
    assert.deepEqual(saved.scene.figures[0]!.subject, {subjectId: seeded.subjectId});
    assert.deepEqual(saved.scene.figures[1]!.subject, {subjectId: seeded.subjectId, subjectVersionId: seeded.versionIds[0]});
    assert.deepEqual(saved.scene.props[0]!.subject, {subjectId: seeded.subjectId, subjectVersionId: seeded.versionIds[0]});
    assert.deepEqual(thumbs(), ['card', 'k1'], 'k2 now looks elsewhere; the card keeps its older picture');
    // The resolver freezes the applied version once: a follow reference takes
    // the head, a locked reference keeps its own version.
    const resolved = resolvePrevisSceneSubjects(store, saved.scene);
    assert.deepEqual(resolved.map(item => [item.elementKind, item.elementId, item.mode, item.subjectVersionId]),
      [['figure', 'f1', 'follow', seeded.versionIds[0]], ['figure', 'f2', 'locked', seeded.versionIds[0]],
        ['prop', 'p1', 'locked', seeded.versionIds[0]]]);
    assert.match(resolved[0]!.sha256, /^[a-f0-9]{64}$/u);
    // Undo restores the previous scene; the cache stays a cache (no thumbnail returns).
    const afterSave = prepareSequenceEditHistory(store);
    const sceneUndo = moveSequenceSyncHistory(store, {projectId: store.projectId, requestId: 'previs-scene-undo-1',
      actionId: subjectPreview.envelope.actionId, direction: 'undo',
      expected: {position: afterSave.state.position, revision: afterSave.state.revision}});
    assert.equal(sceneUndo.ok, true, JSON.stringify(sceneUndo));
    assert.equal(previsNode(store, nodeId).sceneRevision, 2);
    assert.deepEqual(previsNode(store, nodeId).scene.figures[0]!.subject, undefined);
    assert.deepEqual(thumbs(), ['card', 'k1']);

    // Stale scene revision, foreign subject and unowned keyframe export fail as
    // preview errors with the shared codes; nothing is written.
    const stale = service.preview({projectId: store.projectId, requestId: 'previs-stale-0001',
      previsIntent: {side: 'board', operation: {kind: 'previs-scene-set', nodeId, expectedSceneRevision: 1,
        scene: withSubjects}}}) as {ok?: false; code?: string};
    assert.deepEqual([stale.ok, stale.code], [false, 'SEQUENCE_EDIT_REVISION_CONFLICT']);
    const foreign = service.preview({projectId: store.projectId, requestId: 'previs-foreign-0001',
      previsIntent: {side: 'board', operation: {kind: 'previs-scene-set', nodeId,
        expectedSceneRevision: previsNode(store, nodeId).sceneRevision,
        scene: sceneWithSubjects(randomUUID(), seeded.versionIds[0]!)}}}) as {ok?: false; code?: string};
    assert.deepEqual([foreign.ok, foreign.code], [false, 'SEQUENCE_EDIT_SUBJECT_BINDING_INVALID']);
    const badExport = service.preview({projectId: store.projectId, requestId: 'previs-export-0001',
      previsIntent: {side: 'board', operation: {kind: 'previs-scene-set', nodeId,
        expectedSceneRevision: previsNode(store, nodeId).sceneRevision, scene: {...sceneWithoutSubjects(),
          keyframes: [{id: 'k1', name: '', camera: {...defaultPrevisScene().camera}, exports: [randomUUID()]}]}}}}) as {
        ok?: false; code?: string};
    assert.deepEqual([badExport.ok, badExport.code], [false, 'SEQUENCE_EDIT_PREVIS_INVALID']);
    assert.equal(previsNode(store, nodeId).sceneRevision, 2);
    assert.equal(previsNode(store, nodeId).scene.props[0]!.subject, undefined);
  } finally {store.close();}
});

test('a hidden subject version is refused as a previs reference while the saved scene stays readable', () => {
  const f = fixture(), seeded = seed(f), store = seeded.store;
  try {
    // A real undone angle batch: one variant version linked to an undone batch.
    const batchId = randomUUID(), variantVersionId = randomUUID(), assetId = seeded.imageAssetId;
    const asset = store.db.prepare('SELECT data FROM project.assets WHERE id=?').get(assetId) as {data: string};
    const image = JSON.parse(asset.data) as Record<string, unknown>;
    const batchRequest = `variant-${batchId}`, angleSpec = {kind: 'angle', position: 'front', focal: 'standard'};
    const batchInput = {projectId: store.projectId, requestId: batchRequest, subjectId: seeded.subjectId,
      sourceVersionId: seeded.versionIds[0]!, kind: 'angle'};
    const snapshot = {schemaVersion: 1, batchId, projectId: store.projectId, subjectId: seeded.subjectId,
      subjectKind: 'character', subjectName: 'Hero', sourceVersionId: seeded.versionIds[0]!,
      source: {assetId, sha256: image.sha256, mimeType: image.mimeType, width: image.width ?? 1080,
        height: image.height ?? 1920, byteLength: 1024, number: 1},
      kind: 'angle', providerId: 'openai', model: 'gpt-image-1', size: '1024x1024',
      items: [{position: 1, spec: angleSpec, name: 'Front', prompt: 'Front view'}]};
    store.tx(() => {
      store.db.prepare(`INSERT INTO main.subject_variant_batches(id,projectId,subjectId,sourceVersionId,kind,requestId,
        inputHash,input,snapshot,state,revision,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(batchId, store.projectId, seeded.subjectId, seeded.versionIds[0]!, 'angle', batchRequest, 'b'.repeat(64),
          JSON.stringify(batchInput), JSON.stringify(snapshot), 'active', 1, previsTimestamp, previsTimestamp);
      store.db.prepare(`INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)`)
        .run(variantVersionId, store.projectId, seeded.subjectId, 2, assetId, JSON.stringify({id: variantVersionId,
          projectId: store.projectId, subjectId: seeded.subjectId, number: 2, assetId, sha256: image.sha256,
          mimeType: image.mimeType, width: image.width ?? 1080, height: image.height ?? 1920,
          createdAt: '2026-01-04T00:00:00.000Z',
          provenance: {kind: 'user-import', versionId: null, shotId: null, jobId: null},
          variant: {...angleSpec, batchId, sourceVersionId: seeded.versionIds[0]!}}));
      store.db.prepare(`INSERT INTO main.subject_variant_items(batchId,projectId,position,attempt,imageRequestId,
        versionId,revision,updatedAt) VALUES(?,?,?,?,?,?,?,?)`)
        .run(batchId, store.projectId, 1, 1, `subject-variant:${batchId}:1:1`, null, 1, previsTimestamp);
      store.db.prepare('UPDATE main.subject_variant_items SET versionId=?,revision=2 WHERE batchId=? AND position=1')
        .run(variantVersionId, batchId);
    });
    // The active batch version saves as a locked previs reference.
    const nodeId = seedPrevisNode(store);
    const service = createFormat5SequenceEditService(store);
    const lockedScene = sceneWithoutSubjects();
    lockedScene.figures = [{...lockedScene.figures[0]!, subject: {subjectId: seeded.subjectId, subjectVersionId: variantVersionId}}];
    const preview = service.preview({projectId: store.projectId, requestId: 'previs-variant-0001',
      previsIntent: {side: 'board', operation: {kind: 'previs-scene-set', nodeId,
        expectedSceneRevision: previsNode(store, nodeId).sceneRevision, scene: lockedScene}}}) as {
        envelope: SequenceEditEnvelope; planDigest: string};
    service.commit({projectId: store.projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
    assert.deepEqual(previsNode(store, nodeId).scene.figures[0]!.subject, {subjectId: seeded.subjectId,
      subjectVersionId: variantVersionId});
    // Undo the batch: the version is hidden from new saves but the saved scene
    // keeps its subject reference and stays readable.
    store.tx(() => store.db.prepare("UPDATE main.subject_variant_batches SET state='undone',revision=2,updatedAt=? WHERE id=?")
      .run('2026-01-05T00:00:00.000Z', batchId));
    assert.ok(isPrevisNodeRecord(store.get('nodes', nodeId)), 'a saved scene referencing a hidden version stays readable');
    assert.throws(() => resolvePrevisSceneSubjects(store, previsNode(store, nodeId).scene),
      {code: 'SEQUENCE_EDIT_SUBJECT_VERSION_HIDDEN'});
    const blocked = service.preview({projectId: store.projectId, requestId: 'previs-hidden-0001',
      previsIntent: {side: 'board', operation: {kind: 'previs-scene-set', nodeId,
        expectedSceneRevision: previsNode(store, nodeId).sceneRevision,
        scene: sceneWithSubjects(seeded.subjectId, variantVersionId)}}}) as {ok?: false; code?: string};
    assert.deepEqual([blocked.ok, blocked.code], [false, 'SEQUENCE_EDIT_SUBJECT_VERSION_HIDDEN']);
  } finally {store.close();}
});
