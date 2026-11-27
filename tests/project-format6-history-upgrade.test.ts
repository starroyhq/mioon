import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test, {type TestContext} from 'node:test';
import {PROJECT_HISTORY_FILE} from '../packages/contracts/src/project-file.ts';
import {speedProcessingItemSchema} from '../packages/contracts/src/timeline-processing.ts';
import {processingRowSchema} from '../packages/contracts/src/timeline-processing-storage.ts';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import {captureClosedProjectSnapshot} from '../packages/business/src/project-file/closed-copy.ts';
import {inspectProjectFormatReadOnly} from '../packages/business/src/project-file/connection.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {prepareHistorySwitch, projectHistoryFileIdentity, recoverHistorySwitch} from '../packages/business/src/project-file/history-switch.ts';
import {historyManifestForVersion} from '../packages/business/src/project-file/schema/format-manifests.ts';
import {compareManifest, readSchemaManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {FORMAT5_HISTORY_SCHEMA_VERSION, FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT6_HISTORY_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION,
  HISTORY_APPLICATION_ID} from '../packages/business/src/project-file/schema/databases.ts';
import {initializeEditorStorageCounters} from '../packages/business/src/project-file/schema/domains/sequence.ts';
import {initializeMioStorageCounters} from '../packages/business/src/project-file/schema/domains/mio.ts';
import {testEnv} from './helpers/test-env.ts';

const frozen = readFileSync(new URL('./fixtures/kernel-history-previous-schema/v13.sql', import.meta.url), 'utf8');
const historyVersion = (db: DatabaseSync): unknown => db.prepare('SELECT version FROM main.schema_version').get()?.version;
const processingTables = (db: DatabaseSync): string[] => db.prepare(
  "SELECT name FROM main.sqlite_master WHERE type='table' AND name LIKE 'timeline_processing_%' ORDER BY name",
).all().map(row => String(row.name));
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function assertHistorySchema(db: DatabaseSync, version: typeof FORMAT5_HISTORY_SCHEMA_VERSION | typeof FORMAT6_HISTORY_SCHEMA_VERSION): void {
  assert.equal(historyVersion(db), version);
  assert.deepEqual(compareManifest(readSchemaManifest(db, 'main'), historyManifestForVersion(version)!.entries),
    {missing: [], unexpected: [], changed: []});
}

function fixture(t: TestContext, format: typeof FORMAT5_PROJECT_SCHEMA_VERSION | typeof FORMAT6_PROJECT_SCHEMA_VERSION = FORMAT6_PROJECT_SCHEMA_VERSION) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-processing-history-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const projectFile = path.join(root, 'Film.mioon');
  const location = {localDir: path.join(root, 'records'), tempDir: path.join(root, 'temp'), cacheDir: path.join(root, 'cache')};
  const historyFile = path.join(location.localDir, PROJECT_HISTORY_FILE);
  const options = {projectFile, ...(format === FORMAT6_PROJECT_SCHEMA_VERSION ? {allowFormat6: true as const} : {}), locate: () => location};
  return {projectFile, historyFile, location, options,
    create: (projectId?: string) => createProjectStore({...options, projectId, targetFormat: format}),
    open: () => openProjectStore(options),
  };
}

function inspect<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, {readOnly: true});
  try {return read(db);} finally {db.close();}
}
function retained(db: DatabaseSync): readonly unknown[] {
  return ['history_state', 'idempotency', 'canvas_receipt_window', 'editor_receipt_window', 'mio_storage_counters', 'editor_storage_counters']
    .map(table => db.prepare(`SELECT rowid,* FROM main.${table} ORDER BY rowid`).all());
}
function legacyFormat6(t: TestContext) {
  const files = fixture(t), fresh = files.create(), projectId = fresh.projectId;
  try {fresh.put('projects', {id: projectId, name: 'Retained project', revision: 1});}
  finally {fresh.close();}
  const stamp = inspectProjectFormatReadOnly(files.projectFile, {allowFormat6: true});
  rmSync(files.historyFile);
  const history = new DatabaseSync(files.historyFile);
  try {
    history.exec('BEGIN');
    history.exec(frozen);
    history.exec(`PRAGMA main.application_id=${HISTORY_APPLICATION_ID}`);
    history.prepare('INSERT INTO main.schema_version VALUES(?)').run(FORMAT5_HISTORY_SCHEMA_VERSION);
    history.prepare('INSERT INTO main.history_state VALUES(1,?,?,?)').run(projectId, stamp.contentSequence, stamp.contentToken);
    history.prepare('INSERT INTO main.idempotency(rowid,scope,requestId,requestHash,resourceId) VALUES(17,?,?,?,?)')
      .run('legacy-scope', 'retained-request', 'd'.repeat(64), randomUUID());
    history.prepare('INSERT INTO main.canvas_receipt_window VALUES(1,?,7)').run('a'.repeat(32));
    history.prepare('INSERT INTO main.editor_receipt_window VALUES(1,?,3)').run('b'.repeat(32));
    initializeMioStorageCounters(history, 'main');
    initializeEditorStorageCounters(history, 'main');
    history.exec('COMMIT');
  } finally {history.close();}
  chmodSync(files.historyFile, 0o600);
  return {...files, projectId};
}

test('fresh format 6 uses processing history and rejects tasks belonging to another project', t => {
  const files = fixture(t), store = files.create();
  try {
    store.put('projects', {id: store.projectId, name: 'New project', revision: 1});
    assertHistorySchema(store.db, FORMAT6_HISTORY_SCHEMA_VERSION);
    assert.deepEqual(processingTables(store.db), ['timeline_processing_retries', 'timeline_processing_tasks']);
    const put = store.db.prepare(`INSERT INTO timeline_processing_tasks
      (id,projectId,demandKey,kind,state,revision,requestId,input,updatedAt)
      VALUES (?,?,?,'reverse','queued',1,?,'{}',?)`);
    const params = [randomUUID(), randomUUID(), 'a'.repeat(64), randomUUID(), new Date().toISOString()] as const;
    assert.throws(() => put.run(...params), /foreign key/iu);
    assert.equal(put.run(params[0], store.projectId, params[2], params[3], params[4]).changes, 1);
  } finally {store.close();}
});

test('fresh or reopened format 5 has its unchanged history and lacks processing tables', t => {
  const files = fixture(t, FORMAT5_PROJECT_SCHEMA_VERSION);
  for (const open of [files.create, files.open]) {
    const store = open();
    try {
      assertHistorySchema(store.db, FORMAT5_HISTORY_SCHEMA_VERSION);
      assert.deepEqual(processingTables(store.db), []);
    } finally {store.close();}
  }
});

test('closed snapshots accept processing history only with an admitted format 6 project', async t => {
  const current = fixture(t), initial = current.create(), projectId = initial.projectId;
  try {initial.put('projects', {id: projectId, name: 'New project', revision: 1});} finally {initial.close();}
  const old = fixture(t, FORMAT5_PROJECT_SCHEMA_VERSION), oldProject = old.create(projectId);
  try {oldProject.put('projects', {id: projectId, name: 'Previous project', revision: 1});} finally {oldProject.close();}
  const from = digest(readFileSync(current.historyFile));
  const rejected = path.join(old.location.tempDir, 'snapshot');
  const options = {historyFile: () => current.historyFile, format4: {allowFormat6: true as const}};
  await assert.rejects(captureClosedProjectSnapshot({...options, projectFile: old.projectFile, directory: rejected}),
    {code: 'PROJECT_FORMAT_NEWER', details: {database: 'history', reason: 'format-newer', formatVersion: FORMAT6_HISTORY_SCHEMA_VERSION,
      supportedFormatVersion: FORMAT5_HISTORY_SCHEMA_VERSION}});
  assert.equal(existsSync(rejected), false);
  const capture = await captureClosedProjectSnapshot({...options, projectFile: current.projectFile, directory: path.join(current.location.tempDir, 'snapshot')});
  assert.ok(capture.historyFile);
  inspect(capture.historyFile, db => assertHistorySchema(db, FORMAT6_HISTORY_SCHEMA_VERSION));
  assert.equal(digest(readFileSync(current.historyFile)), from);
});

test('exact pre-processing format-6 history upgrades only its execution schema and retains old records', t => {
  assert.equal(digest(frozen), '689be2aeb782c4b0b6bba5856d7143cb5c8c9347bbd2e502acc8f348deed0d16');
  const files = legacyFormat6(t), originalProject = digest(readFileSync(files.projectFile));
  inspect(files.historyFile, db => assertHistorySchema(db, FORMAT5_HISTORY_SCHEMA_VERSION));
  const before = inspect(files.historyFile, retained), store = files.open();
  try {
    assert.equal(store.historyState, 'current');
    assertHistorySchema(store.db, FORMAT6_HISTORY_SCHEMA_VERSION);
    assert.deepEqual(retained(store.db), before);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM timeline_processing_tasks').get()?.count, 0);
    const previewId = randomUUID();
    store.db.prepare(`INSERT INTO main.timeline_processing_tasks
      (id,projectId,demandKey,kind,state,revision,requestId,input,errorCode,updatedAt)
      VALUES (?,?,?,'preview','failed',1,?,'{}','INTERPOLATION_UNAVAILABLE',?)`)
      .run(previewId, store.projectId, 'b'.repeat(64), randomUUID(), new Date().toISOString());
    const row = processingRowSchema.parse(store.db.prepare('SELECT * FROM main.timeline_processing_tasks WHERE id=?').get(previewId));
    assert.deepEqual(speedProcessingItemSchema.parse({taskId: previewId, clipId: randomUUID(), kind: row.kind,
      status: row.state, reason: row.errorCode}).reason, 'INTERPOLATION_UNAVAILABLE');
  } finally {store.close();}
  assert.equal(digest(readFileSync(files.projectFile)), originalProject);
});

test('an unreviewed history-v13 object is refused before migrating any data', t => {
  const files = legacyFormat6(t), db = new DatabaseSync(files.historyFile);
  try {db.exec('CREATE TABLE unreviewed_extension(value TEXT)');} finally {db.close();}
  const originalProject = digest(readFileSync(files.projectFile)), originalHistory = digest(readFileSync(files.historyFile));
  assert.throws(files.open, {code: 'PROJECT_INVALID'});
  assert.equal(digest(readFileSync(files.projectFile)), originalProject);
  assert.equal(digest(readFileSync(files.historyFile)), originalHistory);
});

test('diverged pre-processing history stays on its original schema for archive or restore', t => {
  const files = legacyFormat6(t), db = new DatabaseSync(files.historyFile);
  try {db.prepare('UPDATE main.history_state SET seenContentToken=?').run('e'.repeat(32));} finally {db.close();}
  const original = digest(readFileSync(files.historyFile)), store = files.open();
  try {
    assert.equal(store.historyState, 'diverged');
    assert.equal(historyVersion(store.db), FORMAT5_HISTORY_SCHEMA_VERSION);
    assert.deepEqual(processingTables(store.db), []);
  } finally {store.close();}
  assert.equal(digest(readFileSync(files.historyFile)), original);
});

test('format 6 history replacement archives old processing records and publishes empty processing tables', t => {
  const files = fixture(t), initial = files.create(), projectId = initial.projectId;
  try {
    initial.put('projects', {id: projectId, name: 'Original', revision: 1});
    initial.db.prepare(`INSERT INTO timeline_processing_tasks
      (id,projectId,demandKey,kind,state,revision,requestId,input,updatedAt)
      VALUES (?,?,?,'reverse','cancelled',1,?,'{}',?)`)
      .run(randomUUID(), projectId, 'a'.repeat(64), randomUUID(), new Date().toISOString());
  } finally {initial.close();}
  const external = new DatabaseSync(files.projectFile);
  try {external.prepare("UPDATE projects SET data=json_set(data,'$.name','External','$.revision',2) WHERE id=?").run(projectId);}
  finally {external.close();}
  const original = digest(readFileSync(files.historyFile));
  const options = {projectFile: files.projectFile, location: files.location, allowFormat6: true as const, assertMutationAllowed() {}};
  const diverged = files.open(), requestId = randomUUID();
  try {
    assert.equal(diverged.historyState, 'diverged');
    prepareHistorySwitch(diverged, {projectId, requestId, action: 'continue', expected: readProjectContentStamp(diverged.db),
      historyIdentity: projectHistoryFileIdentity(files.historyFile), confirmationDigest: 'a'.repeat(64)}, options);
  } finally {diverged.close();}
  const result = recoverHistorySwitch(options);
  assert.ok(result);
  assert.equal(result.requestId, requestId);
  assert.equal(digest(readFileSync(path.join(files.location.localDir, result.archive))), original);
  const reopened = files.open();
  try {
    assert.equal(reopened.historyState, 'current');
    assertHistorySchema(reopened.db, FORMAT6_HISTORY_SCHEMA_VERSION);
    assert.equal(reopened.db.prepare('SELECT count(*) AS count FROM timeline_processing_tasks').get()?.count, 0);
  } finally {reopened.close();}
});

test('interrupted processing history DDL rolls back and reopens through the same exact migration', t => {
  const files = legacyFormat6(t), before = inspect(files.historyFile, retained), exec = DatabaseSync.prototype.exec;
  const failure = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string): void {
    if (sql.startsWith('CREATE INDEX main.timeline_processing_tasks_state ')) throw Error('Synthetic history upgrade interruption');
    exec.call(this, sql);
  });
  try {assert.throws(files.open, {code: 'PROJECT_INVALID'});} finally {failure.mock.restore();}
  inspect(files.historyFile, history => {
    assert.equal(historyVersion(history), FORMAT5_HISTORY_SCHEMA_VERSION);
    assert.deepEqual(processingTables(history), []);
    assert.deepEqual(retained(history), before);
  });
  const recovered = files.open();
  try {
    assert.equal(historyVersion(recovered.db), FORMAT6_HISTORY_SCHEMA_VERSION);
    assert.deepEqual(retained(recovered.db), before);
  } finally {recovered.close();}
});

test('SIGKILL after adding processing tables recovers the whole original history', t => {
  const files = legacyFormat6(t), before = inspect(files.historyFile, retained);
  const module = new URL('../packages/business/src/project-file/store.ts', import.meta.url).href;
  const script = `import {DatabaseSync} from 'node:sqlite';
    import {openProjectStore} from ${JSON.stringify(module)};
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      exec.call(this, sql);
      if (sql.startsWith('CREATE TABLE main.timeline_processing_retries(')) process.kill(process.pid, 'SIGKILL');
    };
    openProjectStore({projectFile: process.argv[1], allowFormat6: true, locate: () => JSON.parse(process.argv[2])});
    throw Error('missed history upgrade boundary');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, files.projectFile, JSON.stringify(files.location)],
    {env: testEnv(), stdio: 'ignore', timeout: 30_000});
  assert.equal(result.signal, 'SIGKILL');
  // The opener checks the original v13 manifest after SQLite rolls back the
  // hot journal, then upgrades it normally in a new transaction.
  const recovered = files.open();
  try {
    assert.equal(historyVersion(recovered.db), FORMAT6_HISTORY_SCHEMA_VERSION);
    assert.deepEqual(retained(recovered.db), before);
    assert.equal(recovered.db.prepare('SELECT count(*) AS count FROM timeline_processing_retries').get()?.count, 0);
  } finally {recovered.close();}
});
