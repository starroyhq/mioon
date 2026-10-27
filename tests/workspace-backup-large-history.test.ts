import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, renameSync, writeFileSync, unlinkSync, readFileSync, readdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/db.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {AGENT_TASK_TABLES} from '../packages/business/src/agent/task-schema-v2.ts';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createWorkspaceBackupRuntime} from '../packages/business/src/workspace-backup-runtime.ts';
import {verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import type {AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';

function fixture(t: TestContext, {models = 1, bodyBytes = 1024}: {models?: number; bodyBytes?: number} = {}, createRuntime = createWorkspaceBackupRuntime) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-online-backup-fence-')), root = join(base, 'workspace'), store = openStore(root);
  const projectId = randomUUID();store.put('projects', {id: projectId, name: 'Synthetic stable project', revision: 1});
  const journal = createAgentTaskJournal(store), run = journal.create({projectId, requestId: randomUUID(), text: 'Retained synthetic history', configuration: {}}).run;
  const date = '2026-10-24T00:00:00.000Z', body = 'x'.repeat(bodyBytes);
  for (let position = 1; position <= models; position++) {
    const step: AgentTaskStep = {id: randomUUID(), runId: run.id, position, kind: 'model', status: 'completed', request: {body, history: []}, createdAt: date, updatedAt: date};
    store.db.prepare('INSERT INTO agent_task_steps_v2(id,runId,projectId,position,status,data) VALUES(?,?,?,?,?,?)').run(step.id, run.id, projectId, position, step.status, JSON.stringify(step));
  }
  journal.transition(run.id, journal.run(run.id).revision, 'completed');
  const configuration = createWorkspaceConfiguration({root, env: {MIOON_ENABLE_LIVE_PROVIDER: '0'}}), runtime = createRuntime({store, configuration});
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

async function withNativeBackup(backup: typeof import('node:sqlite').backup): Promise<typeof createWorkspaceBackupRuntime> {
  const runtimeUrl = new URL('../packages/business/src/workspace-backup-runtime.ts', import.meta.url);
  runtimeUrl.searchParams.set('native-backup-rejection', randomUUID());
  const sqliteUrl = 'data:text/javascript,' + encodeURIComponent(`
    export {DatabaseSync} from 'node:sqlite';
    export let backup;
    export const setBackup = callback => {backup = callback;};
    // Each isolated runtime receives only its own callback: ${randomUUID()}
  `);
  const hook = registerHooks({resolve(specifier, context, next) {
    if (context.parentURL === runtimeUrl.href && specifier === 'node:sqlite') return {url: sqliteUrl, shortCircuit: true};
    return next(specifier, context);
  }});
  try {
    const boundary = await import(sqliteUrl) as {setBackup(value: typeof backup): void};
    boundary.setBackup(backup);
    const runtime = await import(runtimeUrl.href) as typeof import('../packages/business/src/workspace-backup-runtime.ts');
    return runtime.createWorkspaceBackupRuntime;
  } finally {hook.deregister();}
}

for (const scenario of ['rollback', 'cancel', 'lock-loss', 'unchanged'] as const) test(`native backup rejection before progress preserves the ${scenario} failure boundary`, async t => {
  const nativeError = Object.assign(new Error('not an error; synthetic private native diagnostic'), {code: 'ERR_SQLITE_ERROR', errcode: 0});
  const expectedCode = scenario === 'rollback' ? 'WORKSPACE_BACKUP_CHANGED' : scenario === 'cancel' ? 'WORKSPACE_BACKUP_IO' : scenario === 'lock-loss' ? 'WORKSPACE_BACKUP_BUSY' : 'ERR_SQLITE_ERROR';
  let calls = 0, f!: ReturnType<typeof fixture>;
  const createRuntime = await withNativeBackup(async (source, _destination, options) => {
    calls++;assert.equal(source, f.store.db);assert.equal(options?.rate, 128);assert.equal(typeof options?.progress, 'function');
    // Native backup can reject before it ever invokes its progress callback.
    // All admission, source/database access and filesystem cleanup stay real.
    if (scenario === 'rollback') {
      f.store.db.exec('BEGIN IMMEDIATE');
      f.store.db.prepare("UPDATE projects SET data=json_set(data,'$.name','Rolled-back synthetic edit') WHERE id=?").run(f.projectId);
      f.store.db.exec('ROLLBACK');
    } else if (scenario === 'cancel') f.runtime.stop();
    else if (scenario === 'lock-loss') unlinkSync(f.lock);
    throw nativeError;
  });
  f = fixture(t, {}, createRuntime);
  const beforeProject = f.store.get('projects', f.projectId), beforeHistory = retainedDigest(f.store.db), changes = totalChanges(f.store.db);
  const pending = f.runtime.create({requestId: randomUUID()});
  if (scenario === 'unchanged') await assert.rejects(pending, error => error === nativeError);
  else if (scenario === 'cancel') await assert.rejects(pending, (error: unknown) => !!error && typeof error === 'object' && ('name' in error && error.name === 'AbortError' || 'code' in error && error.code === 'WORKSPACE_BACKUP_CANCELLED'));
  else await assert.rejects(pending, code(expectedCode));
  assert.equal(calls, 1, 'a rejected native backup is never retried');
  assert.deepEqual(f.store.get('projects', f.projectId), beforeProject);
  assert.equal(retainedDigest(f.store.db), beforeHistory);
  if (scenario === 'rollback') assert.notEqual(totalChanges(f.store.db), changes, 'rolled-back writes really invalidate the frozen source');
  else assert.equal(totalChanges(f.store.db), changes);
  const status = f.runtime.getStatus();
  assert.equal(status.phase, 'idle');assert.equal(f.runtime.isBusy(), false);assert.deepEqual(status.backups, []);assert.equal(status.lastBackupAt, null);
  assert.equal(status.lastError, expectedCode);
  assert.equal(readFileSync(join(f.root, 'workspace-backups-index-v1.json'), 'utf8').includes(nativeError.message), false);
  const directory = f.configuration.get().backupDirectory;
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    assert.ok(entry.isDirectory() && /^\.snapshot-[\da-f-]{36}$/.test(entry.name), 'only unpublished snapshot candidates may remain');
    assert.equal(existsSync(join(directory, entry.name, 'COMPLETE.json')), false, 'failed native capture never publishes a completion marker');
  }
});

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
  assert.equal(result.databaseSchemaVersion, 63);
  const restored = openStore(join(large.base, 'restored'));
  try {assert.equal(retainedDigest(restored.db), before);assert.equal(restored.list('jobs', large.projectId).length, 0);} finally {restored.close();}
  t.diagnostic(`synthetic >64MiB: ${stats.fullScans} full source inspections, ${stats.cheapChecks} progress/chunk fences`);
});
