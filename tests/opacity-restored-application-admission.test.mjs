import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {opacityBackupFixture, hash, tree} from './helpers/opacity-backup-fixture.mjs';
import {createOpacityCandidateWorkspaceBackup, restoreOpacityCandidateWorkspaceBackup} from '../packages/business/src/opacity-candidate-backup.ts';
import {openOpacityCandidateStore, reopenOpacityCandidateApplicationStore, reopenRestoredOpacityCandidateApplicationStore,
  isOpacityCandidateApplicationStore, isRestoredOpacityCandidateApplicationStore, getOpacityCandidateAssembly} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateApplicationServices} from '../packages/business/src/opacity-candidate-services.ts';
import {createOpacityCandidateApplicationEditorAssembly} from '../apps/server/src/opacity-candidate-editor-assembly.ts';
import {createRestoredOpacityCandidateLaunch, consumeOpacityCandidateLaunch, closeUnusedOpacityCandidateLaunch} from '../apps/server/src/opacity-candidate-launch.ts';
import {parseOpacityCandidateArguments} from '../apps/server/src/opacity-candidate-cli.ts';
import {isOpacityRestoredApplicationInspection} from '../packages/contracts/src/opacity-restored-application.ts';
import {isWorkspaceRestoreInspection} from '../packages/contracts/src/workspace-restore.mjs';
import {initializeOpacityLegacyThrough40} from '../packages/business/src/workspace-opacity-legacy.ts';
import {initializeWorkspaceSchema42} from '../packages/business/src/workspace-schema-v42.ts';
import {createWorkspaceRestoreProfileV41} from '../packages/business/src/workspace-restore-schema-v41.ts';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {matchesOpacityCandidateExport} from '../packages/business/src/opacity-candidate-render-authority.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';

let attempts = 0;
const forbidden = () => {attempts++; throw Error('No listener, provider or native media in restored43 admission tests');};
mock.method(http.Server.prototype, 'listen', forbidden);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidden);
syncBuiltinESMExports();
const mediaEvents = [], offMedia = onMediaProcess(event => mediaEvents.push(event));
after(() => {offMedia(); mock.restoreAll(); syncBuiltinESMExports(); assert.equal(attempts, 0); assert.deepEqual(mediaEvents, []);});
const unavailable = {code: 'RESTORE_OPERATION_UNAVAILABLE'};
const metadata = () => ({restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(),
  manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: '2026-10-16T00:00:00.000Z'});
async function restored(t) {
  const f = await opacityBackupFixture(t), source = reopenOpacityCandidateApplicationStore(f.source);
  const service = createOpacityCandidateApplicationServices(source);
  try {
    // Omitted-settings acceptance freezes actual source metadata only. There
    // is no worker or decoder and the bytes remain explicitly synthetic.
    f.captured = await service.call('timeline.render', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3, purpose: 'preview'});
    f.empty = await service.call('project.create', {name: 'Restored project without timeline'});
  } finally {await service.drain(); source.close();}
  await createOpacityCandidateWorkspaceBackup({source: f.source, destination: f.backup});
  f.publication = await restoreOpacityCandidateWorkspaceBackup({directory: f.backup, destination: f.destination});
  return f;
}
function app(f) {
  const store = reopenRestoredOpacityCandidateApplicationStore(f.destination), editor = createOpacityCandidateApplicationEditorAssembly(store);
  f.manage(async () => {await editor.drain(); store.close();});
  return {store, ...editor, origin: getOpacityCandidateAssembly(store).getRestoreContext().workspaceOrigin};
}
function seed(root, version) {
  fs.mkdirSync(root, {mode: 0o700}); const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
    if (version === 42) initializeWorkspaceSchema42(db); else initializeOpacityLegacyThrough40(db);
    if (version === 41) createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24).installWorkspaceRestoreSchemaV41(db, metadata());
  } finally {db.close();}
}

test('restored launch is explicit, mutually exclusive and never creates missing roots or databases', async t => {
  const f = await opacityBackupFixture(t), absent = path.join(f.base, 'absent'), empty = path.join(f.base, 'empty');
  assert.throws(() => reopenRestoredOpacityCandidateApplicationStore(absent)); assert.equal(fs.existsSync(absent), false);
  fs.mkdirSync(empty, {mode: 0o700}); assert.throws(() => reopenRestoredOpacityCandidateApplicationStore(empty)); assert.deepEqual(fs.readdirSync(empty), []);
  assert.deepEqual(parseOpacityCandidateArguments(['--open-restored-workspace', empty]), {directory: empty, port: 4319, mode: 'open-restored'});
  for (const flag of ['--new-workspace', '--open-workspace', '--open-restored-workspace']) {
    assert.throws(() => parseOpacityCandidateArguments(['--open-restored-workspace', empty, flag, absent]));
    assert.throws(() => parseOpacityCandidateArguments([flag, absent, '--open-restored-workspace', empty]));
  }
  assert.throws(() => createRestoredOpacityCandidateLaunch('relative'), {code: 'OPACITY_CANDIDATE_LAUNCH_REQUIRED'});
});

test('restored admission refuses ordinary40/restored41/ordinary42 before changing database bytes', async t => {
  const f = await opacityBackupFixture(t);
  for (const version of [40, 41, 42]) {
    const root = path.join(f.base, `wrong${version}`); seed(root, version);
    const file = path.join(root, 'workbench.sqlite'), before = hash(fs.readFileSync(file));
    assert.throws(() => reopenRestoredOpacityCandidateApplicationStore(root));
    assert.equal(hash(fs.readFileSync(file)), before); assert.equal(fs.existsSync(path.join(root, 'server.lock')), false);
  }
  const corrupt = path.join(f.base, 'corrupt'); fs.mkdirSync(corrupt, {mode: 0o700});
  const file = path.join(corrupt, 'workbench.sqlite'); fs.writeFileSync(file, 'not SQLite', {mode: 0o600});
  const before = hash(fs.readFileSync(file)); assert.throws(() => reopenRestoredOpacityCandidateApplicationStore(corrupt));
  assert.equal(hash(fs.readFileSync(file)), before); assert.equal(fs.existsSync(path.join(corrupt, 'server.lock')), false);
});

test('real cold backup restores a separately admitted read surface with held history and explicit draft policy', async t => {
  const f = await restored(t), a = app(f);
  assert.equal(isOpacityCandidateApplicationStore(a.store), false); assert.equal(isRestoredOpacityCandidateApplicationStore(a.store), true);
  const info = await a.services.call('workspace.restore.inspect', {includeVolumeEnvelopeCapability: true, includeAudioRoleCapability: true});
  assert.equal(isOpacityRestoredApplicationInspection(info), true); assert.equal(isWorkspaceRestoreInspection(info), false);
  assert.equal(info.schemaVersion, 43); assert.equal(info.source.schemaVersion, 42); assert.equal(info.draftPolicy, 'excluded');
  assert.equal(info.workspaceOrigin, a.origin); assert.equal(info.operationPolicy.find(row => row.operation === 'project.create').available, false);
  const page = await a.services.call('project.get', {projectId: f.projectId});
  assert.deepEqual(page.timeline, f.timeline); assert.deepEqual(page.restore, {workspaceOrigin: a.origin, heldExportIds: [f.captured.id]});
  assert.deepEqual(page.exports, [f.captured]); assert.equal(matchesOpacityCandidateExport(a.store, f.captured), false);
  assert.deepEqual(await a.services.call('export.get', {exportId: f.captured.id}), f.captured);
  assert.deepEqual(await a.services.call('export.list', {projectId: f.projectId}), [f.captured]);
  assert.equal((await a.services.call('asset.get', {assetId: f.assetId})).sha256, hash(f.mediaBytes));
  assert.equal((await a.services.call('asset.list', {projectId: f.projectId})).length, 1);
  assert.deepEqual(await a.services.call('provider.list', {}), []);
  assert.equal(fs.readFileSync(path.join(f.destination, f.relativePath)).equals(f.mediaBytes), true);
  assert.equal(fs.existsSync(path.join(f.destination, 'local-drafts-v3.json')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'local-drafts-v3.json')), f.draftBytes);
  const before = a.store.db.prepare('SELECT count(*) AS n FROM timelines').get().n;
  assert.equal((await a.services.call('project.get', {projectId: f.empty.id})).timeline, null);
  assert.equal(await a.services.call('timeline.get', {projectId: f.empty.id}), null);
  assert.equal(a.store.db.prepare('SELECT count(*) AS n FROM timelines').get().n, before);
  for (const operation of ['project.create', 'asset.import', 'timeline.track.add', 'timeline.clip.add', 'timeline.clip.remove', 'generation.submit'])
    await assert.rejects(a.services.call(operation, {}, {expectedWorkspaceOrigin: a.origin}), unavailable);
});

test('new origin edits and durable tasks work while all captured pending task actions remain held', async t => {
  const f = await restored(t), a = app(f), context = {expectedWorkspaceOrigin: a.origin};
  const captured = a.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(f.taskId);
  const held = await a.tasks.get({projectId: f.projectId, taskId: f.taskId});
  const heldAction = {projectId: f.projectId, taskId: f.taskId, digest: held.task.digest};
  await assert.rejects(a.tasks.execute({...heldAction, instanceId: held.instanceId}, context), {code: 'RESTORED_RECORD_HELD'});
  assert.throws(() => a.tasks.reconcile(heldAction, context), {code: 'RESTORED_RECORD_HELD'});
  assert.throws(() => a.tasks.acknowledge({...heldAction, expectedRevision: 1, status: 'applied'}, context), {code: 'RESTORED_RECORD_HELD'});
  assert.deepEqual(a.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(f.taskId), captured);
  assert.equal(captured.executionEpoch, 'captured');
  const curve = {profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: .5}, {frame: 30, opacity: .8}]};
  const input = {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3, clipId: f.clipId, patch: {opacityEnvelope: curve}};
  await assert.rejects(a.services.call('timeline.clip.update', input), {code: 'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  await assert.rejects(a.services.call('timeline.clip.update', input, {expectedWorkspaceOrigin: randomUUID()}), {code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
  const prepared = await a.tasks.prepare({projectId: f.projectId, operation: 'timeline.clip.update', input, origin: 'new'}, context);
  const executed = await a.tasks.execute({projectId: f.projectId, taskId: prepared.task.id, digest: prepared.task.digest, instanceId: prepared.instanceId}, context);
  assert.equal(executed.task.status, 'applied'); assert.deepEqual(executed.result.clips[0].opacityEnvelope, curve);
  assert.equal(a.store.db.prepare('SELECT executionEpoch FROM edit_tasks WHERE id=?').get(prepared.task.id).executionEpoch, a.origin);
  await a.tasks.acknowledge({projectId: f.projectId, taskId: executed.task.id, digest: executed.task.digest, expectedRevision: executed.task.revision, status: 'applied'}, context);
  let timeline = await a.services.call('timeline.undo', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: executed.result.revision}, context);
  assert.deepEqual(timeline.clips[0].opacityEnvelope, f.opacityEnvelope);
  timeline = await a.services.call('timeline.redo', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: timeline.revision}, context);
  assert.deepEqual(timeline.clips[0].opacityEnvelope, curve);
  const render = await a.services.call('timeline.render', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: timeline.revision, purpose: 'preview'}, context);
  assert.equal(matchesOpacityCandidateExport(a.store, render), true);
  assert.deepEqual((await a.services.call('project.get', {projectId: f.projectId})).restore.heldExportIds, [f.captured.id]);
});

test('registered43 proofs are one-shot and copies or a generic43 handle confer no application authority', async t => {
  const f = await restored(t), generic = openOpacityCandidateStore(f.destination);
  try {
    assert.equal(isRestoredOpacityCandidateApplicationStore(generic), false);
    assert.throws(() => createOpacityCandidateApplicationEditorAssembly(generic), unavailable);
  } finally {generic.close();}
  const proof = createRestoredOpacityCandidateLaunch(f.destination);
  for (const copy of [{...proof}, JSON.parse(JSON.stringify(proof))]) assert.throws(() => consumeOpacityCandidateLaunch(copy), {code: 'OPACITY_CANDIDATE_LAUNCH_REQUIRED'});
  const accepted = consumeOpacityCandidateLaunch(proof), old = getOpacityCandidateAssembly(accepted.store), origin = old.getRestoreContext().workspaceOrigin;
  assert.equal(isRestoredOpacityCandidateApplicationStore({...accepted.store}), false);
  assert.throws(() => createOpacityCandidateApplicationServices({...accepted.store}), unavailable);
  assert.throws(() => consumeOpacityCandidateLaunch(proof), {code: 'OPACITY_CANDIDATE_LAUNCH_REQUIRED'});
  accepted.store.close(); assert.throws(old.checkpoint, {code: 'RESTORE_STORE_UNVERIFIED'});
  const reopened = reopenRestoredOpacityCandidateApplicationStore(f.destination);
  try {assert.equal(getOpacityCandidateAssembly(reopened).getRestoreContext().workspaceOrigin, origin);}
  finally {reopened.close();}
  const unused = createRestoredOpacityCandidateLaunch(f.destination); closeUnusedOpacityCandidateLaunch(unused);
  assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false);
});

test('bad restored evidence or catalog is rejected before RW open and its original bytes are preserved', async t => {
  const f = await restored(t);
  for (const kind of ['evidence', 'catalog']) {
    const root = path.join(f.base, `bad-${kind}`); fs.cpSync(f.destination, root, {recursive: true});
    const file = path.join(root, 'workbench.sqlite'), db = new DatabaseSync(file);
    try {
      if (kind === 'catalog') db.exec('CREATE TABLE unexpected(value TEXT)');
      else {
        const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name='restore_workspace_restore_evidence_update'").get().sql;
        db.exec('DROP TRIGGER restore_workspace_restore_evidence_update');
        db.prepare('UPDATE workspace_restore_evidence SET digest=?').run('f'.repeat(64)); db.exec(trigger);
      }
    } finally {db.close();}
    const before = hash(fs.readFileSync(file)); assert.throws(() => reopenRestoredOpacityCandidateApplicationStore(root));
    assert.equal(hash(fs.readFileSync(file)), before); assert.equal(fs.existsSync(path.join(root, 'server.lock')), false);
  }
});

test('restored admission refuses database inode replacement between read-only validation and RW open', async t => {
  const f = await restored(t), file = path.join(f.destination, 'workbench.sqlite'), moved = file + '.original';
  const originalClose = DatabaseSync.prototype.close, before = hash(fs.readFileSync(file)); let swapped = false;
  const wrapped = mock.method(DatabaseSync.prototype, 'close', function () {
    const target = this.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    const result = Reflect.apply(originalClose, this, []);
    if (!swapped && target === file) {swapped = true; fs.renameSync(file, moved); fs.copyFileSync(moved, file);}
    return result;
  });
  try {assert.throws(() => reopenRestoredOpacityCandidateApplicationStore(f.destination), {code: 'RESTORE_STORE_UNVERIFIED'});}
  finally {wrapped.mock.restore();}
  assert.equal(swapped, true); assert.equal(hash(fs.readFileSync(file)), before); assert.equal(hash(fs.readFileSync(moved)), before);
  assert.notEqual(fs.lstatSync(file).ino, fs.lstatSync(moved).ino); assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false);
});

test('active owner and symlinked root/database/media paths are refused without taking over or repairing', async t => {
  const f = await restored(t), a = app(f), lock = path.join(f.destination, 'server.lock'), lockBytes = fs.readFileSync(lock);
  assert.throws(() => reopenRestoredOpacityCandidateApplicationStore(f.destination), /running backend/);
  assert.deepEqual(fs.readFileSync(lock), lockBytes); assert.equal(getOpacityCandidateAssembly(a.store).ownsLock(), true);
  await a.drain(); a.store.close();
  const alias = path.join(f.base, 'root-alias'); fs.symlinkSync(f.destination, alias);
  assert.throws(() => reopenRestoredOpacityCandidateApplicationStore(alias), {code: 'STORAGE_PRIVATE_REQUIRED'});
  for (const kind of ['database', 'media']) {
    const root = path.join(f.base, `link-${kind}`); fs.cpSync(f.destination, root, {recursive: true});
    const target = kind === 'database' ? path.join(root, 'workbench.sqlite') : path.join(root, 'media');
    const owned = target + '.owned'; fs.renameSync(target, owned); fs.symlinkSync(owned, target);
    const before = tree(root); assert.throws(() => reopenRestoredOpacityCandidateApplicationStore(root));
    assert.deepEqual(tree(root), before); assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  }
});

test('pre-aborted restored actions make no writes and a forged fresh output cannot be disclosed', async t => {
  const f = await restored(t), a = app(f), controller = new AbortController(); controller.abort();
  const before = a.store.db.prepare('SELECT total_changes() AS n').get().n;
  await assert.rejects(a.services.call('project.get', {projectId: f.projectId}, {signal: controller.signal}), {code: 'OPERATION_CANCELLED'});
  await assert.rejects(a.services.call('timeline.clip.update', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3,
    clipId: f.clipId, patch: {name: 'Cancelled'}}, {expectedWorkspaceOrigin: a.origin, signal: controller.signal}), {code: 'OPERATION_CANCELLED'});
  assert.equal(a.store.db.prepare('SELECT total_changes() AS n').get().n, before);
  const forged = {...f.captured, id: randomUUID(), requestId: randomUUID()};
  a.store.put('exports', forged);
  await assert.rejects(a.services.call('export.get', {exportId: forged.id}), unavailable);
  await assert.rejects(a.services.call('export.list', {projectId: f.projectId}), unavailable);
});
