import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import cp from 'node:child_process';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {openNewOpacityCandidateApplicationStore, reopenRestoredOpacityCandidateApplicationStore, getOpacityCandidateAssembly} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateApplicationServices} from '../packages/business/src/opacity-candidate-services.ts';
import {createOpacityCandidateDomain} from '../packages/business/src/opacity-candidate-domain.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {createOpacityCandidateWorkspaceBackup, restoreOpacityCandidateWorkspaceBackup} from '../packages/business/src/opacity-candidate-backup.ts';
import {validateWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {canonical, logicalTables, tree} from './helpers/opacity-backup-fixture.ts';

let effectAttempts = 0;
const forbidden = () => {effectAttempts++; throw Error('No process, listener or network in captured task history regression');};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidden);
mock.method(net.Server.prototype, 'listen', forbidden); mock.method(globalThis, 'fetch', forbidden); syncBuiltinESMExports();
after(() => {mock.restoreAll(); syncBuiltinESMExports(); assert.equal(effectAttempts, 0);});
const stamp = '2026-10-16T00:00:00.000Z', profileId = 'mioon-clip-linear-opacity-v1';
const curve = opacity => ({profileId, points: [{frame: 0, opacity}, {frame: 30, opacity: 1}]});
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, {state = 'applied', mutate} = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-captured-add-history-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const source = path.join(base, 'source42'), backup = path.join(base, 'backup42'), destination = path.join(base, 'restored43');
  const store = openNewOpacityCandidateApplicationStore(source), services = createOpacityCandidateApplicationServices(store), tasks = createEditTasks({store, services});
  let f;
  try {
    const project = await services.call('project.create', {name: 'Captured add opacity history'}), projectId = project.id;
    const page = await services.call('project.get', {projectId});
    const timeline = await services.call('timeline.track.add', {projectId, requestId: randomUUID(), expectedRevision: page.timeline.revision, kind: 'video', name: 'Video'});
    const assetId = randomUUID(), bytes = Buffer.from('Synthetic opaque bytes; no decoder is allowed.\0界'), relativePath = `media/${assetId}.mp4`;
    store.put('assets', {id: assetId, projectId, name: 'Owned synthetic source', mimeType: 'video/mp4', relativePath, sha256: sha(bytes), sizeBytes: bytes.length,
      width: 720, height: 1280, duration: 1, hasVideo: true, hasAudio: false, provenance: 'user-import', createdAt: stamp});
    fs.writeFileSync(path.join(source, relativePath), bytes, {mode: 0o600});
    const input = {projectId, requestId: randomUUID(), expectedRevision: state === 'not_applied' ? 999 : timeline.revision, trackId: timeline.tracks[0].id,
      assetId, startFrame: 0, durationFrames: 30, opacityEnvelope: curve(.25)};
    const prepared = tasks.prepare({projectId, operation: 'timeline.clip.add', input, origin: 'new'});
    let outcome = prepared;
    if (state !== 'prepared') {
      outcome = await tasks.execute({projectId, taskId: prepared.task.id, digest: prepared.task.digest, instanceId: prepared.instanceId});
      assert.equal(outcome.task.status, state);
      outcome = tasks.acknowledge({projectId, taskId: prepared.task.id, digest: prepared.task.digest, expectedRevision: outcome.task.revision, status: state});
    }
    f = {base, source, backup, destination, projectId, input, task: outcome.task, instanceId: outcome.instanceId};
    if (state === 'applied') {
      const saved = await services.call('timeline.get', {projectId});
      f.originalReceipt = store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
      // Reading the original add ACK remains legitimate after later edits.
      await services.call('timeline.clip.update', {projectId, requestId: randomUUID(), expectedRevision: saved.revision, clipId: saved.clips[0].id, patch: {opacityEnvelope: curve(.75)}});
    }
    mutate?.(store.db, f);
  } finally {await tasks.drain(); await services.drain(); store.close();}
  f.sourceBefore = tree(source);
  await createOpacityCandidateWorkspaceBackup({source, destination: backup});
  await restoreOpacityCandidateWorkspaceBackup({directory: backup, destination});
  const restored = reopenRestoredOpacityCandidateApplicationStore(destination), restoredServices = createOpacityCandidateApplicationServices(restored), restoredTasks = createEditTasks({store: restored, services: restoredServices});
  t.after(async () => {await restoredTasks.drain(); await restoredServices.drain(); restored.close();});
  return {...f, store: restored, services: restoredServices, tasks: restoredTasks, domain: createOpacityCandidateDomain(restored),
    origin: getOpacityCandidateAssembly(restored).getRestoreContext().workspaceOrigin};
}
function withoutTriggers(db, change) {
  const triggers = db.prepare("SELECT name,sql FROM main.sqlite_schema WHERE type='trigger' ORDER BY name").all();
  for (const row of triggers) db.exec('DROP TRIGGER "' + row.name + '"');
  try {change();} finally {for (const row of triggers) db.exec(row.sql);}
}

for (const state of ['applied', 'prepared', 'not_applied']) test(`real42 backup/43 restore reads captured opacity add ${state} task without granting new execution`, async t => {
  const f = await fixture(t, {state}), before = logicalTables(f.store.db), context = {expectedWorkspaceOrigin: f.origin};
  const held = f.tasks.get({projectId: f.projectId, taskId: f.task.id});
  assert.deepEqual(held.task, f.task); assert.deepEqual(held.restore, {workspaceOrigin: f.origin, executionEpoch: 'captured', held: true});
  const list = f.tasks.list({projectId: f.projectId, pendingOnly: false});
  assert.deepEqual(list.items, [f.task]); assert.deepEqual(list.restore.tasks, [{taskId: f.task.id, executionEpoch: 'captured', held: true}]);
  assert.deepEqual(f.tasks.list({projectId: f.projectId}).items, []);
  const action = {projectId: f.projectId, taskId: f.task.id, digest: f.task.digest};
  await assert.rejects(f.tasks.execute({...action, instanceId: held.instanceId}, context), {code: 'RESTORED_RECORD_HELD'});
  assert.throws(() => f.tasks.reconcile(action, context), {code: 'RESTORED_RECORD_HELD'});
  assert.throws(() => f.tasks.acknowledge({...action, expectedRevision: f.task.revision, status: 'applied'}, context), {code: 'RESTORED_RECORD_HELD'});
  for (const operation of ['timeline.clip.add', 'timeline.track.add', 'timeline.track.update']) {
    assert.throws(() => f.tasks.prepare({projectId: f.projectId, operation, input: {...f.input, requestId: randomUUID()}, origin: 'new'}, context), {code: 'EDIT_TASK_VALIDATION'});
    await assert.rejects(f.services.call(operation, f.input, context), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  }
  assert.equal(f.domain.isTask({...f.task, id: randomUUID()}), false);
  assert.equal(f.domain.isTask({...f.task, input: {...f.input, opacityEnvelope: curve(.5)}}), false);
  if (state === 'applied') {
    const response = f.domain.boundary(f.input).replay('timeline.clip.add', f.originalReceipt);
    assert.deepEqual(response.clips[0].opacityEnvelope, curve(.25));
    assert.deepEqual((await f.services.call('timeline.get', {projectId: f.projectId})).clips[0].opacityEnvelope, curve(.75));
    assert.throws(() => f.domain.boundary({...f.input, opacityEnvelope: curve(.5)}).replay('timeline.clip.add', f.originalReceipt));
    assert.equal(f.domain.isMutationResponse('timeline.clip.add', f.input, response), false, 'the current43 mutation grammar is unchanged');
  }
  assert.deepEqual(logicalTables(f.store.db), before); validateWorkspaceRestoreSchemaV43(f.store.db);
  assert.deepEqual(tree(f.source), f.sourceBefore, 'captured history reads never touch the original42 source');
});

test('captured malformed task digest stays unreadable through the historical add predicate', async t => {
  const f = await fixture(t, {mutate: (db, value) => withoutTriggers(db, () => db.prepare('UPDATE edit_tasks SET digest=? WHERE id=?').run('f'.repeat(64), value.task.id))});
  const before = logicalTables(f.store.db);
  assert.throws(() => f.tasks.get({projectId: f.projectId, taskId: f.task.id}), {code: 'EDIT_TASK_STORAGE_UNAVAILABLE'});
  assert.throws(() => f.tasks.list({projectId: f.projectId, pendingOnly: false}), {code: 'EDIT_TASK_STORAGE_UNAVAILABLE'});
  assert.deepEqual(logicalTables(f.store.db), before);
});

test('captured valid-shaped receipt cannot change the add opacity accepted by its immutable task', async t => {
  const f = await fixture(t, {mutate: (db, value) => {
    const response = JSON.parse(value.originalReceipt); response.clips[0].opacityEnvelope = curve(.5);
    withoutTriggers(db, () => db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(response), value.input.requestId));
  }});
  const before = logicalTables(f.store.db);
  assert.throws(() => f.tasks.get({projectId: f.projectId, taskId: f.task.id}), {code: 'EDIT_TASK_STORAGE_UNAVAILABLE'});
  assert.throws(() => f.tasks.list({projectId: f.projectId, pendingOnly: false}), {code: 'EDIT_TASK_STORAGE_UNAVAILABLE'});
  assert.deepEqual(logicalTables(f.store.db), before);
});

test('a current-origin add row without a capture hold cannot select the historical task grammar', async t => {
  const f = await fixture(t), before = logicalTables(f.store.db), input = {...f.input, requestId: randomUUID()};
  const value = {...f.task, id: randomUUID(), input, requestId: input.requestId, digest: sha(canonical({operation: 'timeline.clip.add', input})),
    status: 'prepared', revision: 1, acknowledged: false};
  f.store.db.exec('BEGIN IMMEDIATE');
  try {
    f.store.db.prepare(`INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes,executionEpoch)
      VALUES(?,?,'timeline.clip.add',?,?,?,'timeline:mutation','new','prepared',1,0,?,?,16384,?)`).run(
      value.id, f.projectId, JSON.stringify(input), input.requestId, value.digest, value.createdAt, value.updatedAt, f.origin);
    assert.equal(f.domain.isTask(value), false);
  } finally {if (f.store.db.isTransaction) f.store.db.exec('ROLLBACK');}
  assert.deepEqual(logicalTables(f.store.db), before);
});
