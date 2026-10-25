import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, renameSync, writeFileSync, unlinkSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/db.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {AGENT_TASK_TABLES} from '../packages/business/src/agent/task-schema-v2.ts';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createWorkspaceBackupRuntime} from '../packages/business/src/workspace-backup-runtime.ts';
import {verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import type {AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';

function fixture(t: TestContext, {models = 1, bodyBytes = 1024}: {models?: number; bodyBytes?: number} = {}) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-online-backup-fence-')), root = join(base, 'workspace'), store = openStore(root);
  const projectId = randomUUID();store.put('projects', {id: projectId, name: 'Synthetic stable project', revision: 1});
  const journal = createAgentTaskJournal(store), run = journal.create({projectId, requestId: randomUUID(), text: 'Retained synthetic history', configuration: {}}).run;
  const date = '2026-10-24T00:00:00.000Z', body = 'x'.repeat(bodyBytes);
  for (let position = 1; position <= models; position++) {
    const step: AgentTaskStep = {id: randomUUID(), runId: run.id, position, kind: 'model', status: 'completed', request: {body, history: []}, createdAt: date, updatedAt: date};
    store.db.prepare('INSERT INTO agent_task_steps_v2(id,runId,projectId,position,status,data) VALUES(?,?,?,?,?,?)').run(step.id, run.id, projectId, position, step.status, JSON.stringify(step));
  }
  journal.transition(run.id, journal.run(run.id).revision, 'completed');
  const configuration = createWorkspaceConfiguration({root, env: {MIOON_ENABLE_LIVE_PROVIDER: '0'}}), runtime = createWorkspaceBackupRuntime({store, configuration});
  let fullScans = 0, cheapChecks = 0;
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql: string) => {
    if (sql === 'SELECT *,length(CAST(data AS BLOB)) AS bytes FROM agent_task_steps_v2 LIMIT 20001') fullScans++;
    if (sql === 'PRAGMA main.data_version') cheapChecks++;
    return prepare(sql);
  };
  t.after(async () => {runtime.stop(); await runtime.drain(); if (store.db.isOpen) store.close(); rmSync(base, {recursive: true, force: true});});
  return {base, root, store, projectId, run, configuration, runtime, database: join(root, 'workbench.sqlite'), lock: join(root, 'server.lock'),
    stats: () => ({fullScans, cheapChecks}), backupDirectory: (id: string) => join(configuration.get().backupDirectory, id)};
}
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const totalChanges = (db: DatabaseSync) => db.prepare('SELECT total_changes() AS n').get()!.n;
const schemaVersion = (db: DatabaseSync) => db.prepare('PRAGMA main.schema_version').get()!.schema_version;
const dataVersion = (db: DatabaseSync) => db.prepare('PRAGMA main.data_version').get()!.data_version;
function retainedDigest(db: DatabaseSync) {
  const hash = createHash('sha256');
  for (const table of AGENT_TASK_TABLES) for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) hash.update(JSON.stringify([table, row]));
  return hash.digest('hex');
}

for (const rollback of [false, true]) test(`same-connection ${rollback ? 'rolled-back' : 'committed'} data writes invalidate admission without rewriting the user edit`, async t => {
  const f = fixture(t), pending = f.runtime.create({requestId: randomUUID()});
  await Promise.resolve();
  if (rollback) f.store.db.exec('BEGIN IMMEDIATE');
  f.store.db.prepare("UPDATE projects SET data=json_set(data,'$.name','Changed locally') WHERE id=?").run(f.projectId);
  if (rollback) f.store.db.exec('ROLLBACK');
  await assert.rejects(pending, code('WORKSPACE_BACKUP_CHANGED'));
  assert.equal((f.store.get('projects', f.projectId) as {name: string}).name, rollback ? 'Synthetic stable project' : 'Changed locally');
  assert.equal(f.runtime.list().length, 0);
});

for (const ddl of [false, true]) test(`external committed ${ddl ? 'DDL' : 'data with unchanged schema'} invalidates the frozen source`, async t => {
  const f = fixture(t), changes = totalChanges(f.store.db), schema = schemaVersion(f.store.db), version = dataVersion(f.store.db);
  const pending = f.runtime.create({requestId: randomUUID()});await Promise.resolve();
  const writer = new DatabaseSync(f.database);
  try {
    if (ddl) writer.exec('CREATE TABLE synthetic_external_change(value TEXT)');
    else writer.prepare("UPDATE projects SET data=json_set(data,'$.name','External committed edit') WHERE id=?").run(f.projectId);
  } finally {writer.close();}
  assert.equal(totalChanges(f.store.db), changes);
  if (!ddl) assert.equal(schemaVersion(f.store.db), schema);
  assert.notEqual(dataVersion(f.store.db), version);
  await assert.rejects(pending, code('WORKSPACE_BACKUP_CHANGED'));
  assert.equal(f.runtime.list().length, 0);
  if (!ddl) assert.equal((f.store.get('projects', f.projectId) as {name: string}).name, 'External committed edit');
});

for (const replacement of [false, true]) test(`source lock ${replacement ? 'replacement' : 'loss'} remains a per-progress blocker`, async t => {
  const f = fixture(t), pending = f.runtime.create({requestId: randomUUID()});await Promise.resolve();
  if (replacement) {renameSync(f.lock, f.lock + '.original'); writeFileSync(f.lock, 'replacement owner', {mode: 0o600});}
  else unlinkSync(f.lock);
  await assert.rejects(pending, code('WORKSPACE_BACKUP_BUSY'));
  assert.equal(f.runtime.list().length, 0);
  if (replacement) assert.equal(readFileSync(f.lock, 'utf8'), 'replacement owner');
});

test('cancellation remains effective before a new progress callback and cannot publish a backup', async t => {
  const f = fixture(t, {models: 4, bodyBytes: 1024 * 1024}), pending = f.runtime.create({requestId: randomUUID()});
  await Promise.resolve();f.runtime.stop();
  await assert.rejects(pending, (error: unknown) => !!error && typeof error === 'object' && ('name' in error && error.name === 'AbortError' || 'code' in error && error.code === 'WORKSPACE_BACKUP_CANCELLED'));
  assert.equal(f.runtime.list().length, 0);assert.equal(f.runtime.isBusy(), false);
});

test('an open source read transaction is refused at admission instead of trusting its stale data_version', async t => {
  const f = fixture(t);f.store.db.exec('BEGIN');f.store.db.prepare('SELECT data FROM projects WHERE id=?').get(f.projectId);
  try {await assert.rejects(f.runtime.create({requestId: randomUUID()}), code('WORKSPACE_BACKUP_BUSY'));assert.equal(f.stats().fullScans, 0);} finally {f.store.db.exec('ROLLBACK');}
});

test('a retained WAL read snapshot cannot conceal an external commit between progress callbacks', async t => {
  const f = fixture(t), pending = f.runtime.create({requestId: randomUUID()});await Promise.resolve();
  f.store.db.exec('BEGIN');f.store.db.prepare('SELECT data FROM projects WHERE id=?').get(f.projectId);
  const version = dataVersion(f.store.db), writer = new DatabaseSync(f.database);
  try {
    writer.prepare("UPDATE projects SET data=json_set(data,'$.name','Committed behind read snapshot') WHERE id=?").run(f.projectId);
    assert.equal(dataVersion(f.store.db), version, 'a held read transaction really masks the external data_version');
    await assert.rejects(pending, code('WORKSPACE_BACKUP_BUSY'));
  } finally {writer.close();f.store.db.exec('ROLLBACK');}
  assert.equal((f.store.get('projects', f.projectId) as {name: string}).name, 'Committed behind read snapshot');
  assert.equal(f.runtime.list().length, 0);
});

test('large stable history performs a constant number of full inspections and survives online backup, verification and restore', async t => {
  const small = fixture(t), smallEntry = await small.runtime.create({requestId: randomUUID()}), baseline = small.stats();
  assert.equal(small.runtime.list()[0]!.id, smallEntry.id);
  const large = fixture(t, {models: 65, bodyBytes: 1024 * 1024}), before = retainedDigest(large.store.db);
  assert.ok(Number(large.store.db.prepare('SELECT sum(length(CAST(data AS BLOB))) AS bytes FROM agent_task_steps_v2').get()!.bytes) > 64 * 1024 * 1024);
  const entry = await large.runtime.create({requestId: randomUUID()}), stats = large.stats();
  assert.equal(stats.fullScans, baseline.fullScans, 'history size and progress count do not multiply full schema/history scans');
  assert.ok(stats.fullScans >= 4 && stats.fullScans <= 8);
  assert.ok(stats.cheapChecks > stats.fullScans * 20, 'each progress/chunk keeps its inexpensive source fence');
  assert.ok(stats.cheapChecks > baseline.cheapChecks * 3);
  assert.equal(retainedDigest(large.store.db), before);assert.equal(large.store.db.isOpen, true);
  assert.deepEqual(await large.runtime.create({requestId: entry.requestId}), entry);
  const directory = large.backupDirectory(entry.id);await verifyWorkspaceBackup({directory});
  const result = await restoreWorkspaceBackup({directory, destination: join(large.base, 'restored')});
  assert.equal(result.databaseSchemaVersion, 59);
  const restored = openStore(join(large.base, 'restored'));
  try {assert.equal(retainedDigest(restored.db), before);assert.equal(restored.list('jobs', large.projectId).length, 0);} finally {restored.close();}
  t.diagnostic(`synthetic >64MiB: ${stats.fullScans} full source inspections, ${stats.cheapChecks} progress/chunk fences`);
});
