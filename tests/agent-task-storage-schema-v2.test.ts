import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore, classifyCurrentWorkspaceSchema, type WorkspaceStore} from '../packages/business/src/db.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {AGENT_TASK_TABLES} from '../packages/business/src/agent/task-schema-v2.ts';
import {AGENT_TASK_STORAGE_BYTES_V58, validateAgentTaskStorageRowsV2} from '../packages/business/src/agent/task-storage-schema-v2.ts';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38} from '../packages/business/src/workspace-schema-v38.ts';
import {initializeWorkspaceSchema40} from '../packages/business/src/workspace-schema-v40.ts';
import {initializeWorkspaceSchema44} from '../packages/business/src/workspace-schema-v44.ts';
import {initializeWorkspaceSchema48} from '../packages/business/src/workspace-schema-v48.ts';
import {initializeWorkspaceSchema50} from '../packages/business/src/workspace-schema-v50.ts';
import {initializeWorkspaceSchema52} from '../packages/business/src/workspace-schema-v52.ts';
import {initializeWorkspaceSchema54} from '../packages/business/src/workspace-schema-v54.ts';
import {initializeWorkspaceSchema56} from '../packages/business/src/workspace-schema-v56.ts';
import {initializeWorkspaceSchema58, validateWorkspaceSchema58} from '../packages/business/src/workspace-schema-v58.ts';
import {classifyWorkspaceSchemaV56V57} from '../packages/business/src/workspace-restore-schema-v57.ts';
import {createWorkspaceBackup, verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {AgentTaskJson, AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';

function temporary(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-storage-schema58-'));
  t.after(() => {for (const suffix of ['', '-backup', '-restored']) rmSync(root + suffix, {recursive: true, force: true});});
  return root;
}
function legacy56(t: TestContext) {
  const root = temporary(t), db = new DatabaseSync(join(root, 'workbench.sqlite'));
  t.after(() => {if (db.isOpen) db.close();});
  db.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF');
  initializeWorkspaceSchemaThrough24(db);
  for (const initialize of [initializeWorkspaceSchema26, initializeWorkspaceSchema28, initializeWorkspaceSchema30,
    initializeWorkspaceSchema32, initializeWorkspaceSchema34, initializeWorkspaceSchema36, initializeWorkspaceSchema38,
    initializeWorkspaceSchema40]) initialize(db);
  for (const initialize of [initializeWorkspaceSchema44, initializeWorkspaceSchema48, initializeWorkspaceSchema50,
    initializeWorkspaceSchema52, initializeWorkspaceSchema54, initializeWorkspaceSchema56]) initialize(db, initializeWorkspaceSchemaThrough24);
  const projectId = randomUUID(), project = {id: projectId, name: 'Historical synthetic journal', revision: 1};
  db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId, JSON.stringify(project));
  // The journal only needs the existing store's transaction and owner lookup.
  // Keeping this constructor at56 lets migration tests write genuine old bytes.
  const store = {db, root,
    get(table: string, id: string) {assert.equal(table, 'projects'); return id === projectId ? project : null;},
    tx<T>(consume: () => T): T {db.exec('BEGIN IMMEDIATE'); try {const value = consume(); db.exec('COMMIT'); return value;} catch (error) {if (db.isTransaction) db.exec('ROLLBACK'); throw error;}},
  } as unknown as WorkspaceStore;
  const journal = createAgentTaskJournal(store), run = journal.create({projectId, requestId: randomUUID(), text: 'Retain all history', configuration: {}}).run;
  return {root, db, store, journal, run, projectId};
}
function current(t: TestContext) {
  const root = temporary(t), store = openStore(root);
  t.after(() => {if (store.db.isOpen) store.close();});
  const projectId = randomUUID();store.put('projects', {id: projectId, name: 'Current synthetic journal', revision: 1});
  const journal = createAgentTaskJournal(store), run = journal.create({projectId, requestId: randomUUID(), text: 'Storage integrity', configuration: {}}).run;
  return {root, store, journal, run, projectId};
}
function evidence(db: DatabaseSync) {
  return AGENT_TASK_TABLES.map(table => ({table, rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()}));
}
function insertCompleteModel(db: DatabaseSync, runId: string, projectId: string, position: number, body: string) {
  const date = '2026-10-24T00:00:00.000Z', step: AgentTaskStep = {id: randomUUID(), runId, position, kind: 'model', status: 'completed',
    request: {body, history: []}, createdAt: date, updatedAt: date};
  const data = JSON.stringify(step);
  db.prepare('INSERT INTO agent_task_steps_v2(id,runId,projectId,position,status,data) VALUES(?,?,?,?,?,?)').run(step.id, runId, projectId, position, step.status, data);
  return {step, bytes: Buffer.byteLength(data)};
}

test('schema58 migration preserves every old raw row and frozen56 catalogue semantics', t => {
  const f = legacy56(t), model = f.journal.beginStep(f.run.id, {kind: 'model', request: {body: '{"messages":[]}', history: []}});
  f.journal.markDispatch(f.run.id, model.id);f.journal.completeStep(f.run.id, model.id, {result: {text: 'Retained result'}});
  const before = evidence(f.db), oldEvents = f.journal.events(f.run.id);
  assert.deepEqual(classifyWorkspaceSchemaV56V57(f.db), {schemaVersion: 56, profile: 'ordinary'});
  initializeWorkspaceSchema58(f.db, initializeWorkspaceSchemaThrough24);
  assert.deepEqual(evidence(f.db), before);
  assert.deepEqual(classifyCurrentWorkspaceSchema(f.db), {schemaVersion: 58, profile: 'ordinary'});
  assert.deepEqual(createAgentTaskJournal(f.store).events(f.run.id), oldEvents);
  assert.throws(() => classifyWorkspaceSchemaV56V57(f.db), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM schema_version WHERE version=58').get()!.n, 1);
});

test('schema58 freezes model request originals against update, deletion and replacement without blocking normal state', t => {
  const f = current(t), model = f.journal.beginStep(f.run.id, {kind: 'model', request: {body: 'unchanged raw body', history: []}}), db = f.store.db;
  const before = evidence(db), original = db.prepare('SELECT rowid,* FROM agent_task_steps_v2 WHERE id=?').get(model.id)!;
  db.exec('PRAGMA recursive_triggers=OFF');
  for (const sql of [
    "UPDATE agent_task_steps_v2 SET data=json_set(data,'$.request.body','changed') WHERE id=?",
    "UPDATE agent_task_steps_v2 SET data=json_set(data,'$.kind','tool') WHERE id=?",
    "UPDATE agent_task_steps_v2 SET data=json_remove(data,'$.request') WHERE id=?",
    "UPDATE agent_task_steps_v2 SET data=json_set(data,'$.id','00000000-0000-4000-8000-000000000001') WHERE id=?",
    "UPDATE agent_task_steps_v2 SET data=json_set(data,'$.runId','00000000-0000-4000-8000-000000000001') WHERE id=?",
    "UPDATE agent_task_steps_v2 SET id='00000000-0000-4000-8000-000000000001' WHERE id=?",
    'DELETE FROM agent_task_steps_v2 WHERE id=?',
  ]) assert.throws(() => db.prepare(sql).run(model.id), /model request evidence/u);
  const values = [model.id, f.run.id, f.projectId, model.position, model.status, JSON.stringify({...model, request: {body: 'replaced', history: []}})] as const;
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO agent_task_steps_v2(id,runId,projectId,position,status,data) VALUES(?,?,?,?,?,?)').run(...values), /must not be replaced/u);
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO agent_task_steps_v2(rowid,id,runId,projectId,position,status,data) VALUES(?,?,?,?,?,?,?)').run(original.rowid!, randomUUID(), f.run.id, f.projectId, model.position + 1, model.status, original.data!), /must not be replaced/u);
  assert.deepEqual(evidence(db), before);
  db.prepare('UPDATE agent_task_steps_v2 SET data=data WHERE id=?').run(model.id);
  f.journal.markDispatch(f.run.id, model.id);f.journal.completeStep(f.run.id, model.id, {result: {text: 'Normal finish'}});
  assert.deepEqual(f.journal.step(model.id).request, model.request);validateWorkspaceSchema58(db);
});

test('old56 rejects a new reference representation even when its source, hash and old catalogue are valid', t => {
  const f = legacy56(t), model = f.journal.beginStep(f.run.id, {kind: 'model', request: {body: 'legacy inline', history: []}}), request = JSON.stringify(model.request);
  const sequence = Number(f.db.prepare('SELECT max(sequence)+1 AS n FROM agent_task_events_v2 WHERE runId=?').get(f.run.id)!.n);
  const event = {runId: f.run.id, sequence, type: 'step', data: {...model, request: {format: 'mioon-model-request-ref/1', stepId: model.id,
    sha256: createHash('sha256').update(request).digest('hex'), bytes: Buffer.byteLength(request)}}, createdAt: model.createdAt};
  f.db.prepare('INSERT INTO agent_task_events_v2(runId,projectId,sequence,type,data) VALUES(?,?,?,?,?)').run(f.run.id, f.projectId, sequence, 'step', JSON.stringify(event));
  const before = evidence(f.db);
  assert.throws(() => classifyWorkspaceSchemaV56V57(f.db), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.throws(() => initializeWorkspaceSchema58(f.db, initializeWorkspaceSchemaThrough24), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.deepEqual(evidence(f.db), before);assert.equal(f.db.prepare('SELECT 1 FROM schema_version WHERE version=58').get(), undefined);
});

test('schema58 migration DDL failure rolls back quota replacement, guards and marker without touching history', t => {
  const f = legacy56(t), before = evidence(f.db), catalogue = f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(), exec = f.db.exec.bind(f.db);
  f.db.exec = (sql: string) => {if (sql.includes('CREATE TRIGGER agent_task_model_request_update_v58')) throw Error('synthetic migration failure'); return exec(sql);};
  assert.throws(() => initializeWorkspaceSchema58(f.db, initializeWorkspaceSchemaThrough24), /synthetic migration failure/u);
  f.db.exec = exec;assert.deepEqual(evidence(f.db), before);
  assert.deepEqual(f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(), catalogue);
  assert.deepEqual(classifyWorkspaceSchemaV56V57(f.db), {schemaVersion: 56, profile: 'ordinary'});
});

test('schema58 admits history above64MiB, atomically rejects above256MiB and retains the row count limit', t => {
  const f = current(t), db = f.store.db, body = 'x'.repeat(2 * 1024 * 1024 - 4096);
  let inserted = 0, rowBytes = 0;
  for (; inserted < 128; inserted++) rowBytes += insertCompleteModel(db, f.run.id, f.projectId, inserted + 1, body).bytes;
  assert.ok(rowBytes > 64 * 1024 * 1024 && rowBytes < AGENT_TASK_STORAGE_BYTES_V58);
  validateAgentTaskStorageRowsV2(db);
  const count = db.prepare('SELECT count(*) AS n FROM agent_task_steps_v2').get()!.n;
  assert.throws(() => f.store.tx(() => {
    insertCompleteModel(db, f.run.id, f.projectId, inserted + 1, body);
    db.prepare("UPDATE agent_task_runs_v2 SET data=json_set(data,'$.text','must roll back') WHERE id=?").run(f.run.id);
  }), /AGENT_TASK_STORAGE_LIMIT/u);
  assert.equal(db.prepare('SELECT count(*) AS n FROM agent_task_steps_v2').get()!.n, count);
  assert.equal(f.journal.run(f.run.id).text, 'Storage integrity');
  const triggers = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name GLOB 'agent_quota_*'").all();
  assert.equal(triggers.length, 20);
  assert.ok(triggers.every(row => String(row.sql).includes('>20000') && String(row.sql).includes('>268435456')));
  // Existing manual editing remains usable when execution history is full.
  // Its legitimate heartbeat receipts must not make the next startup fail.
  const ownerId = randomUUID(), targets = Array.from({length: 100}, () => ({kind: 'shot', id: randomUUID(), revision: 0}));
  for (let sequence = 1; sequence <= 24; sequence++) f.journal.edit({requestId: randomUUID(), projectId: f.projectId,
    ownerId, generation: 1, sequence, action: sequence === 1 ? 'claim' : 'heartbeat', targets});
  const manualBytes = Number(db.prepare('SELECT sum(length(CAST(data AS BLOB))) AS bytes FROM agent_task_edit_receipts_v2').get()!.bytes);
  assert.ok(rowBytes + manualBytes > AGENT_TASK_STORAGE_BYTES_V58);
  validateWorkspaceSchema58(db);f.store.close();
  const reopened = openStore(f.root);try {validateWorkspaceSchema58(reopened.db);} finally {reopened.close();}
});

test('schema58 cold backup restores59 with exact event requests, immutable source rows and disabled execution', async t => {
  const f = current(t), original: AgentTaskJson = {body: '{"messages":[{"role":"user","content":"中文 raw body"}]}', history: [{role: 'user', content: '中文 raw body'}]}, model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  f.journal.markDispatch(f.run.id, model.id);f.journal.completeStep(f.run.id, model.id, {result: {text: 'Synthetic final result'}});
  f.journal.transition(f.run.id, f.journal.run(f.run.id).revision, 'completed');
  const before = evidence(f.store.db), events = f.journal.events(f.run.id), snapshot = f.journal.snapshot(f.run.id);
  f.store.close();
  const backup = await createWorkspaceBackup({source: f.root, destination: f.root + '-backup'});
  assert.equal(backup.databaseSchemaVersion, 58);assert.deepEqual(await verifyWorkspaceBackup({directory: f.root + '-backup'}), backup);
  const restored = await restoreWorkspaceBackup({directory: f.root + '-backup', destination: f.root + '-restored'});
  assert.equal(restored.sourceSchema, 58);assert.equal(restored.databaseSchemaVersion, 59);assert.equal(restored.profile, 'restored-local-v18');
  const copy = openStore(f.root + '-restored');
  try {
    assert.deepEqual(evidence(copy.db), before);assert.deepEqual(classifyCurrentWorkspaceSchema(copy.db), {schemaVersion: 59, profile: 'restored-local-v18'});
    const journal = createAgentTaskJournal(copy);assert.deepEqual(journal.events(f.run.id), events);assert.deepEqual(journal.snapshot(f.run.id), snapshot);
    assert.deepEqual(journal.step(model.id).request, original);
    assert.throws(() => journal.beginStep(f.run.id, {kind: 'model', request: original}), /AGENT_TASK_STATE_CONFLICT|RESTORE_OPERATION_UNAVAILABLE|RESTORED_RECORD_HELD/u);
    assert.throws(() => copy.db.prepare('DELETE FROM agent_task_steps_v2 WHERE id=?').run(model.id), /model request evidence|RESTORED_RECORD_HELD/u);
    assert.equal(copy.list('jobs', f.projectId).length, 0);
  } finally {copy.close();}
});

test('a terminal project with retained model originals is deleted only through its scoped transaction', async t => {
  const f = current(t), model = f.journal.beginStep(f.run.id, {kind: 'model', request: {body: '{}', history: []}});
  f.journal.completeStep(f.run.id, model.id, {result: {text: 'Local finish'}});f.journal.transition(f.run.id, f.journal.run(f.run.id).revision, 'completed');
  const services = createServices(f.store, new Map());
  try {
    services.setProjectDeletionCompanions({assertDeletable() {}, removeProject() {}});
    const result = await services.call('project.delete', {requestId: randomUUID(), projectId: f.projectId, expectedRevision: 1, confirmPermanentDeletion: true});
    assert.equal((result as {deleted?: unknown}).deleted, true);assert.equal(f.store.get('projects', f.projectId), null);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_task_steps_v2').get()!.n, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project_deletion_scope').get()!.n, 0);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  } finally {await services.drain();}
});

test('more than64MiB of complete originals survives cold backup, restore and the original project deletion', async t => {
  const f = current(t), body = 'x'.repeat(1024 * 1024);
  for (let position = 1; position <= 65; position++) insertCompleteModel(f.store.db, f.run.id, f.projectId, position, body);
  assert.ok(Number(f.store.db.prepare('SELECT sum(length(CAST(data AS BLOB))) AS bytes FROM agent_task_steps_v2').get()!.bytes) > 64 * 1024 * 1024);
  f.journal.transition(f.run.id, f.journal.run(f.run.id).revision, 'completed');
  validateWorkspaceSchema58(f.store.db);f.store.close();
  const backup = await createWorkspaceBackup({source: f.root, destination: f.root + '-backup'});
  assert.equal(backup.databaseSchemaVersion, 58);
  const result = await restoreWorkspaceBackup({directory: f.root + '-backup', destination: f.root + '-restored'});
  assert.equal(result.databaseSchemaVersion, 59);
  const copy = openStore(f.root + '-restored');
  try {assert.equal(copy.db.prepare('SELECT count(*) AS n FROM agent_task_steps_v2').get()!.n, 65);assert.equal(classifyCurrentWorkspaceSchema(copy.db).schemaVersion, 59);} finally {copy.close();}
  const source = openStore(f.root), services = createServices(source, new Map());
  try {
    services.setProjectDeletionCompanions({assertDeletable() {}, removeProject() {}});
    await services.call('project.delete', {requestId: randomUUID(), projectId: f.projectId, expectedRevision: 1, confirmPermanentDeletion: true});
    assert.equal(source.get('projects', f.projectId), null);assert.equal(source.db.prepare('SELECT count(*) AS n FROM agent_task_steps_v2').get()!.n, 0);
  } finally {await services.drain();source.close();}
});
