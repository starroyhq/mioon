import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createOpacityCandidateWorkspaceBackup as create, verifyOpacityCandidateWorkspaceBackup as verify,
  restoreOpacityCandidateWorkspaceBackup as restore, inspectOpacityCandidateRestorePublication as status} from '../packages/business/src/opacity-candidate-backup.ts';
import {openOpacityCandidateStore, getOpacityCandidateAssembly, isOpacityCandidateApplicationStore} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateServices, createOpacityCandidateApplicationServices} from '../packages/business/src/opacity-candidate-services.ts';
import {createOpacityCandidateLocalDrafts} from '../packages/business/src/opacity-candidate-local-drafts.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.mjs';
import {validateWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {initializeOpacityLegacyThrough40} from '../packages/business/src/workspace-opacity-legacy.ts';
import {createWorkspaceBackup, verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {restoreWorkspaceBackup, inspectWorkspaceRestorePublication} from '../packages/business/src/workspace-restore.mjs';
import {classifyCurrentWorkspaceSchema, validateCurrentWorkspaceRestoreSchema} from '../packages/business/src/db.mjs';
import {workspaceBackupManifestSchema} from '../packages/contracts/src/workspace-backup.mjs';
import {workspaceRestoreOfflineResultSchema} from '../packages/contracts/src/workspace-restore-offline.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {opacityBackupFixture, tree, originalRows, hash} from './helpers/opacity-backup-fixture.mjs';

let childAttempts = 0;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  mock.method(cp, name, () => {childAttempts++; throw Error('No child process is allowed in offline opacity backup tests');});
syncBuiltinESMExports();
const mediaEvents = [], stopMedia = onMediaProcess(event => mediaEvents.push(event));
after(() => {stopMedia(); mock.restoreAll(); syncBuiltinESMExports(); assert.equal(childAttempts, 0); assert.deepEqual(mediaEvents, []);});
const createFor = f => create({source: f.source, destination: f.backup});
const restoreFor = f => restore({directory: f.backup, destination: f.destination});
const binding = result => Object.fromEntries(['restorationId', 'sourceBackupId', 'manifestHash', 'sourceDbHash'].map(key => [key, result[key]]));

test('actual cold42 archive restores independent guarded43 while preserving raw opacity, history, tasks, receipts and asset bytes', async t => {
  const f = await opacityBackupFixture(t), sourceBefore = tree(f.source);
  assert.equal(f.store.db.isOpen, false);
  assert.equal(fs.existsSync(path.join(f.source, 'server.lock')), false);
  for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(fs.existsSync(path.join(f.source, 'workbench.sqlite' + suffix)), false);
  const created = await createFor(f), backupBefore = tree(f.backup);
  assert.equal(created.databaseSchemaVersion, 42); assert.equal(created.draftPolicy, 'excluded');
  assert.deepEqual(fs.readFileSync(path.join(f.backup, 'payload/workbench.sqlite')), fs.readFileSync(path.join(f.source, 'workbench.sqlite')),
    'archive preserves the closed42 database bytes before43 construction');
  assert.deepEqual(await verify({directory: f.backup}), created);
  const result = await restoreFor(f);
  assert.equal(result.databaseSchemaVersion, 43); assert.equal(result.sourceSchema, 42); assert.equal(result.profile, 'restored-local-v10');
  assert.equal(result.publication, 'confirmed'); assert.equal(result.draftPolicy, 'excluded'); assert.equal(result.heldCounts.edit_tasks, 1);
  assert.equal(result.heldCounts.timeline_requests, 1); assert.ok(result.databaseBytes > 0);
  assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false);
  assert.deepEqual(tree(f.source), sourceBefore); assert.deepEqual(tree(f.backup), backupBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, f.relativePath)), f.mediaBytes);
  assert.equal(hash(fs.readFileSync(path.join(f.destination, f.relativePath))), hash(f.mediaBytes));
  const db = new DatabaseSync(path.join(f.destination, 'workbench.sqlite'), {readOnly: true});
  try {
    assert.equal(validateWorkspaceRestoreSchemaV43(db).workspaceOrigin, result.workspaceOrigin);
    for (const [table, {fields, rows}] of Object.entries(f.before)) {
      const where = table === 'schema_version' ? 'WHERE version<>43' : '';
      assert.deepEqual(originalRows(db, table, fields, where), rows, `${table}: original typed cells and rowids`);
    }
    assert.equal(db.prepare('SELECT data FROM timelines WHERE id=?').get(f.timelineId).data, f.timelineText);
    assert.equal(db.prepare('SELECT input FROM edit_tasks WHERE id=?').get(f.taskId).input, f.taskText);
    assert.equal(db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.receiptRequestId).response, f.receiptText);
    assert.equal(db.prepare('SELECT beforeSnapshot FROM workspace_restore_timeline_history').get().beforeSnapshot, f.historyBefore);
    assert.equal(db.prepare('SELECT afterSnapshot FROM workspace_restore_timeline_history').get().afterSnapshot, f.historyAfter);
    assert.equal(db.prepare('SELECT position FROM workspace_restore_timeline_cursors WHERE projectId=?').get(f.projectId).position, 1);
    assert.deepEqual({...db.prepare('SELECT status,acknowledged,executionEpoch FROM edit_tasks WHERE id=?').get(f.taskId)},
      {status: 'prepared', acknowledged: 0, executionEpoch: 'captured'});
  } finally {db.close();}
});

test('draft exclusion is explicit in archive, results and status, preserves original v3 bytes and never imports its unfinished opacity', async t => {
  const f = await opacityBackupFixture(t), created = await createFor(f), result = await restoreFor(f);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.backup, 'manifest.json'), 'utf8'));
  assert.equal(created.draftPolicy, 'excluded'); assert.equal(manifest.draftPolicy, 'excluded'); assert.equal(result.draftPolicy, 'excluded');
  assert.equal(f.draft.supported, true); assert.equal(f.draft.draft.raw.opacityEnvelope.points[0].opacity, '.');
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'local-drafts-v3.json')), f.draftBytes);
  assert.equal(manifest.entries.some(entry => entry.path.includes('local-drafts')), false);
  assert.equal(tree(f.backup).some(([name]) => name.includes('local-drafts')), false);
  assert.equal(tree(f.destination).some(([name]) => name.includes('local-drafts')), false);
  const before = tree(f.destination), backupBefore = tree(f.backup);
  const observed = await status({directory: f.backup, destination: f.destination});
  const exact = await status({destination: f.destination, ...binding(result)});
  assert.deepEqual(observed, exact); assert.equal(observed.publication, 'observed_guarded');
  assert.equal(observed.durability, 'not_reconfirmed'); assert.equal(observed.draftPolicy, 'excluded');
  assert.equal(observed.workspaceOrigin, result.workspaceOrigin); assert.deepEqual(tree(f.destination), before); assert.deepEqual(tree(f.backup), backupBefore);
  const store = openOpacityCandidateStore(f.destination); f.stores.push(store);
  assert.deepEqual(createOpacityCandidateLocalDrafts(store).get({projectId: f.projectId, timelineId: f.timelineId, clipId: f.clipId}),
    {supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED'});
  assert.deepEqual(store.get('timelines', f.timelineId).clips[0].opacityEnvelope, f.opacityEnvelope);
});

test('restored old pending task stays held and fresh explicit-origin edit, Undo and Redo use only original candidate capabilities', async t => {
  const f = await opacityBackupFixture(t); await createFor(f); const result = await restoreFor(f);
  const store = openOpacityCandidateStore(f.destination); f.stores.push(store);
  const assembly = getOpacityCandidateAssembly(store), services = createOpacityCandidateServices(store), tasks = createEditTasks({store, services});
  f.manage(async () => {await tasks.drain(); await services.drain();});
  assert.equal(isOpacityCandidateApplicationStore(store), false);
  assert.throws(() => createOpacityCandidateApplicationServices(store), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  assert.deepEqual(assembly.localOperations, ['timeline.clip.update', 'timeline.undo', 'timeline.redo', 'timeline.render']);
  const context = {expectedWorkspaceOrigin: result.workspaceOrigin};
  const pending = tasks.get({projectId: f.projectId, taskId: f.taskId});
  await assert.rejects(tasks.execute({projectId: f.projectId, taskId: f.taskId, digest: f.digest, instanceId: pending.instanceId}, context), {code: 'RESTORED_RECORD_HELD'});
  assert.deepEqual(tasks.reconcileStartup(), {processed: 0, unavailable: 0});
  assert.equal(tasks.list({projectId: f.projectId}).items.length, 0, 'captured pending does not enter the new-origin queue');
  assert.equal(tasks.list({projectId: f.projectId, pendingOnly: false}).items.length, 1);
  assert.throws(() => tasks.prepare({projectId: f.projectId, operation: 'timeline.clip.update', input: f.input, origin: 'new'}, context), {code: 'RESTORED_RECORD_HELD'});
  const patch = {opacityEnvelope: {...f.opacityEnvelope, points: [{frame: 0, opacity: .6}, {frame: 30, opacity: 1}]}};
  const input = {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3, clipId: f.clipId, patch};
  await assert.rejects(services.call('timeline.clip.update', input), {code: 'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  await assert.rejects(services.call('timeline.clip.update', input, {expectedWorkspaceOrigin: randomUUID()}), {code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
  for (const operation of ['project.create', 'asset.import', 'timeline.track.add', 'timeline.clip.add', 'generation.submit'])
    await assert.rejects(services.call(operation, {projectId: f.projectId}, context), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  const mutate = async (operation, extra = {}) => {
    const timeline = await services.call('timeline.get', {projectId: f.projectId});
    const intent = {projectId: f.projectId, requestId: randomUUID(), expectedRevision: timeline.revision, ...extra};
    const prepared = tasks.prepare({projectId: f.projectId, operation, input: intent, origin: 'new'}, context);
    assert.equal(store.db.prepare('SELECT executionEpoch FROM edit_tasks WHERE id=?').get(prepared.task.id).executionEpoch, result.workspaceOrigin);
    const applied = await tasks.execute({projectId: f.projectId, taskId: prepared.task.id, digest: prepared.task.digest, instanceId: prepared.instanceId}, context);
    assert.equal(applied.task.status, 'applied', JSON.stringify(applied));
    tasks.acknowledge({projectId: f.projectId, taskId: applied.task.id, digest: applied.task.digest, expectedRevision: applied.task.revision, status: 'applied'}, context);
    return applied.result;
  };
  const saved = await mutate('timeline.clip.update', {clipId: f.clipId, patch});
  assert.deepEqual(saved.clips[0].opacityEnvelope, patch.opacityEnvelope);
  assert.deepEqual((await mutate('timeline.undo')).clips[0].opacityEnvelope, f.opacityEnvelope);
  assert.deepEqual((await mutate('timeline.redo')).clips[0].opacityEnvelope, patch.opacityEnvelope);
  assert.equal(validateWorkspaceRestoreSchemaV43(store.db).workspaceOrigin, result.workspaceOrigin);
  assert.equal(store.db.prepare('SELECT input FROM edit_tasks WHERE id=?').get(f.taskId).input, f.taskText);
  assert.equal(store.db.prepare('SELECT status FROM edit_tasks WHERE id=?').get(f.taskId).status, 'prepared');
  assert.equal(store.db.prepare('SELECT beforeSnapshot FROM workspace_restore_timeline_history').get().beforeSnapshot, f.historyBefore);
});

test('guarded43 cannot produce a recursive archive through candidate or default backup entry', async t => {
  const f = await opacityBackupFixture(t); await createFor(f); await restoreFor(f); const before = tree(f.destination);
  for (const [index, capture] of [create, createWorkspaceBackup].entries()) {
    const destination = path.join(f.base, `recursive-${index}`);
    await assert.rejects(capture({source: f.destination, destination}), {code: 'RESTORE_BACKUP_UNAVAILABLE'});
    assert.equal(fs.existsSync(destination), false); assert.deepEqual(tree(f.destination), before);
  }
});

test('default40-to41 archive and restoration retain original DTO boundaries while fixed42-to43 stays separate', async t => {
  const f = await opacityBackupFixture(t), oldSource = path.join(f.base, 'old40'), oldBackup = path.join(f.base, 'old-backup40'), oldDestination = path.join(f.base, 'old-restored41');
  fs.mkdirSync(oldSource, {mode: 0o700});
  const db = new DatabaseSync(path.join(oldSource, 'workbench.sqlite'));
  try {db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;'); initializeOpacityLegacyThrough40(db);}
  finally {db.close();}
  fs.chmodSync(path.join(oldSource, 'workbench.sqlite'), 0o600);
  const before = tree(oldSource), created = await createWorkspaceBackup({source: oldSource, destination: oldBackup});
  assert.equal(created.databaseSchemaVersion, 40); assert.equal(Object.hasOwn(created, 'draftPolicy'), false);
  assert.deepEqual(await verifyWorkspaceBackup({directory: oldBackup}), created);
  const restored = await restoreWorkspaceBackup({directory: oldBackup, destination: oldDestination});
  assert.equal(restored.databaseSchemaVersion, 41); assert.equal(restored.sourceSchema, 40); assert.equal(Object.hasOwn(restored, 'draftPolicy'), false);
  assert.equal(workspaceRestoreOfflineResultSchema.safeParse(restored).success, true); assert.deepEqual(tree(oldSource), before);
  const observation = await inspectWorkspaceRestorePublication({directory: oldBackup, destination: oldDestination});
  assert.equal(observation.databaseSchemaVersion, 41); assert.equal(observation.durability, 'not_reconfirmed');
  const restoredDb = new DatabaseSync(path.join(oldDestination, 'workbench.sqlite'), {readOnly: true});
  try {assert.equal(validateCurrentWorkspaceRestoreSchema(restoredDb).schemaVersion, 41);}
  finally {restoredDb.close();}
  const wrongTarget = path.join(f.base, 'old-as42');
  await assert.rejects(create({source: oldSource, destination: wrongTarget}), {code: 'WORKSPACE_BACKUP_IO'});
  assert.equal(fs.existsSync(wrongTarget), false); assert.deepEqual(tree(oldSource), before);
  await assert.rejects(restore({directory: oldBackup, destination: path.join(f.base, 'old-as43')}));
  await createFor(f); const candidate = await restoreFor(f);
  assert.equal(workspaceBackupManifestSchema.safeParse(JSON.parse(fs.readFileSync(path.join(f.backup, 'manifest.json'), 'utf8'))).success, false);
  assert.equal(workspaceRestoreOfflineResultSchema.safeParse(candidate).success, false);
  await assert.rejects(verifyWorkspaceBackup({directory: f.backup}));
  await assert.rejects(restoreWorkspaceBackup({directory: f.backup, destination: path.join(f.base, 'candidate-as-old')}));
  await assert.rejects(inspectWorkspaceRestorePublication({directory: f.backup, destination: f.destination}), {code: 'WORKSPACE_RESTORE_STATUS_UNAVAILABLE'});
  const candidateDb = new DatabaseSync(path.join(f.destination, 'workbench.sqlite'), {readOnly: true});
  try {assert.throws(() => classifyCurrentWorkspaceSchema(candidateDb), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});}
  finally {candidateDb.close();}
});
