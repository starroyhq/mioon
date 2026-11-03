import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {createProjectFile, openProjectConnection} from '../packages/business/src/project-file/connection.ts';
import type {ProjectConnection, ProjectLocation} from '../packages/business/src/project-file/connection.ts';
import {HISTORY_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {S0_HISTORY_V2_MANIFEST} from '../packages/business/src/project-file/schema/history-v2-manifest.ts';
import {R1_HISTORY_V3_MANIFEST} from '../packages/business/src/project-file/schema/history-v3-manifest.ts';
import {MIO_QUOTA_BYTES_SQL,MIO_QUOTA_ROWS_SQL} from '../packages/business/src/project-file/schema/domains/mio.ts';
import {buildPreviousHistoryDatabase} from './fixtures/kernel-history-previous-schema.ts';
import {readSchemaManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {SCHEMA_MANIFEST} from '../packages/business/src/project-file/schema/manifest.ts';
import {LEGACY_MIO_TABLES} from '../packages/business/src/project-file/schema/tables.ts';

const PROCESS_KINDS = ['job', 'export', 'image_task', 'frame_task'] as const;
const WORKER = fileURLToPath(new URL('./fixtures/mio-history-upgrade-worker.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));

for (const [version, manifest] of [
  [2, S0_HISTORY_V2_MANIFEST],
  [3, R1_HISTORY_V3_MANIFEST],
  // R2 freezes this exact main-9f profile as its history4 upgrade whitelist.
  [4, SCHEMA_MANIFEST.history],
] as const) test(`frozen history${version} fixture matches every whitelisted schema object`, () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('BEGIN');
    buildPreviousHistoryDatabase(db, version);
    db.exec('COMMIT');
    assert.deepEqual(readSchemaManifest(db, 'main'), manifest.entries);
    assert.equal(db.prepare('SELECT version FROM schema_version').get()!.version, version);
    assert.equal(db.prepare('PRAGMA application_id').get()!.application_id, 0x4d696f48);
  } finally { db.close(); }
});

interface Fixture extends ProjectLocation {
  readonly root: string;
  readonly projectFile: string;
  readonly historyFile: string;
  readonly projectId: string;
  readonly sequence: number;
}

function fixture(t: TestContext, {fresh = false, processes = true}: {fresh?: boolean; processes?: boolean} = {}): Fixture {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-r1-upgrade-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const localDir = path.join(root, 'records'), cacheDir = path.join(root, 'cache'), tempDir = path.join(root, 'tmp');
  for (const directory of [localDir, cacheDir, tempDir]) mkdirSync(directory, {mode: 0o700});
  const projectFile = path.join(root, 'project.mioon'), projectId = createProjectFile(projectFile);
  const project = new DatabaseSync(projectFile);
  let sequence: number;
  try {
    project.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId, JSON.stringify({id: projectId, name: 'Development movie', revision: 1}));
    if (processes) for (const kind of PROCESS_KINDS) {
      project.prepare('INSERT INTO agent_task_target_revisions_v2 VALUES(?,?,?,?)').run(projectId, kind, randomUUID(), 9);
    }
    sequence = Number(project.prepare('SELECT contentSequence FROM project_file').get()!.contentSequence);
  } finally {
    project.close();
  }
  const value: Fixture = {root, localDir, cacheDir, tempDir, projectFile, projectId, historyFile: path.join(localDir, 'history.db'), sequence};
  if (fresh) return value;
  const db = new DatabaseSync(value.historyFile);
  try {
    db.exec('PRAGMA journal_mode=DELETE; BEGIN');
    buildPreviousHistoryDatabase(db, 2);
    db.prepare('INSERT INTO history_state VALUES(1,?,?)').run(projectId, sequence);
    const runId = randomUUID(), stepId = randomUUID();
    db.prepare('INSERT INTO agent_task_runs_v2 VALUES(?,?,?,?,?,?,?)').run(runId, projectId, randomUUID(), '0'.repeat(64), 'completed', 1,
      JSON.stringify({conversationId: randomUUID(), notes: [], skippedTargets: []}));
    db.prepare('INSERT INTO agent_task_steps_v2 VALUES(?,?,?,?,?,?)').run(stepId, runId, projectId, 1, 'completed', '{}');
    db.prepare('INSERT INTO agent_task_changes_v2 VALUES(?,?,?,?,?)').run(randomUUID(), runId, stepId, projectId, '{"undo":"discard-development-only"}');
    db.prepare("INSERT INTO idempotency VALUES('outside-mio','stable','request-hash','resource-id')").run();
    db.prepare('INSERT INTO timeline_history_cursors VALUES(?,?)').run(projectId, 7);
    db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run('existing-job', projectId, '{"status":"running"}');
    db.exec('COMMIT');
    assert.deepEqual(readSchemaManifest(db, 'main'), S0_HISTORY_V2_MANIFEST.entries, 'fixture is the exact frozen S0 history profile');
  } finally {
    db.close();
  }
  return value;
}

const open = (value: Fixture): ProjectConnection => openProjectConnection({projectFile: value.projectFile, locate: () => value});
function inspect<T>(value: Fixture, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(value.historyFile);
  try {
    db.prepare('ATTACH DATABASE ? AS project').run(value.projectFile);
    return read(db);
  } finally {
    db.close();
  }
}
const sequence = (db: DatabaseSync): number => Number(db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence);
const processRows = (db: DatabaseSync): number => Number(db.prepare("SELECT count(*) AS n FROM project.agent_task_target_revisions_v2 WHERE kind IN ('job','export','image_task','frame_task')").get()!.n);
function otherData(db: DatabaseSync): unknown {
  return {
    jobs: db.prepare('SELECT * FROM main.jobs ORDER BY id').all(),
    receipts: db.prepare('SELECT * FROM main.idempotency ORDER BY scope,requestId').all(),
    cursors: db.prepare('SELECT * FROM main.timeline_history_cursors ORDER BY projectId').all(),
    projects: db.prepare('SELECT * FROM project.projects ORDER BY id').all(),
    contentTargets: db.prepare("SELECT * FROM project.agent_task_target_revisions_v2 WHERE kind NOT IN ('job','export','image_task','frame_task') ORDER BY kind,targetId").all(),
  };
}
function errorOf(action: () => ProjectConnection): AppError {
  try { action().close(); } catch (error) { assert.ok(error instanceof AppError); return error; }
  assert.fail('opening unexpectedly succeeded');
}
function assertOld(value: Fixture): void {
  inspect(value, db => {
    assert.equal(db.prepare('SELECT version FROM main.schema_version').get()!.version, 2);
    assert.deepEqual(readSchemaManifest(db, 'main'), S0_HISTORY_V2_MANIFEST.entries);
    assert.equal(db.prepare('SELECT count(*) AS n FROM main.agent_task_runs_v2').get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM main.agent_task_changes_v2').get()!.n, 1);
    assert.equal(processRows(db), 4);
    assert.equal(sequence(db), value.sequence);
    assert.deepEqual(readSchemaManifest(db, 'project'), SCHEMA_MANIFEST.project.entries);
  });
}

function r1Fixture(t:TestContext):Fixture{
 const value=fixture(t,{fresh:true,processes:false}),db=new DatabaseSync(value.historyFile);
 try{
  const at='2026-11-02T00:00:00.000Z',conversationId=randomUUID(),runId=randomUUID(),stepId=randomUUID(),requestId=randomUUID(),body=JSON.stringify({text:'原件🙂'.repeat(20000)}),shared=createHash('sha256').update('{}').digest('hex');
  db.exec('PRAGMA journal_mode=DELETE; BEGIN');buildPreviousHistoryDatabase(db,3);
  db.prepare('INSERT INTO history_state VALUES(1,?,?)').run(value.projectId,value.sequence);
  db.prepare('INSERT INTO mio_blobs VALUES(?,?,?,?)').run(shared,2,'{}',at);
  db.prepare('INSERT INTO mio_conversations VALUES(?,?,?,?)').run(conversationId,value.projectId,at,at);
  db.prepare('INSERT INTO mio_runs(id,projectId,conversationId,requestId,digest,status,revision,stepLimit,budget,stepsUsed,locale,usageSummary,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(runId,value.projectId,conversationId,randomUUID(),'a'.repeat(64),'interrupted',3,30,30,1,'en','{"retained":true}',at,at);
  db.prepare('INSERT INTO mio_steps(id,runId,projectId,position,kind,status,createdAt,updatedAt,partialText) VALUES(?,?,?,1,?,?,?,?,?)').run(stepId,runId,value.projectId,'model','intent',at,at,'已落盘 partial🙂');
  const manifest=JSON.stringify({version:1,entryIds:[],noteEntryIds:[],configurationBlobHash:shared,toolsBlobHash:shared,systemBlobHash:shared,baselineBlobHash:shared,rulesBlobHash:null,parameters:{},viewVersion:1});
  db.prepare('INSERT INTO mio_requests(id,stepId,assemblyNumber,assemblerVersion,protocol,bodySha256,bodyBytes,state,originalBody,inputManifest,assembledAt,assemblyReason) VALUES(?,?,1,1,?,?,?,?,?,?,?,?)').run(requestId,stepId,'responses',createHash('sha256').update(body).digest('hex'),Buffer.byteLength(body),'intent',body,manifest,at,'initial');
  db.prepare("UPDATE mio_requests SET state='dispatch_started',dispatchStartedAt=? WHERE id=?").run(at,requestId);
  db.prepare("UPDATE mio_requests SET state='unknown',completedAt=? WHERE id=?").run(at,requestId);
  db.prepare("UPDATE mio_steps SET status='unknown',currentRequestId=? WHERE id=?").run(requestId,stepId);
  for(const kind of PROCESS_KINDS)db.prepare('INSERT INTO mio_process_target_revisions VALUES(?,?,?,?)').run(value.projectId,kind,randomUUID(),9);
  db.prepare("INSERT INTO idempotency VALUES('outside-mio','stable','request-hash','resource-id')").run();
  db.exec('COMMIT');assert.deepEqual(readSchemaManifest(db,'main'),R1_HISTORY_V3_MANIFEST.entries);
 }finally{db.close();}
 return value;
}
function r1Data(db:DatabaseSync):unknown{
 return R1_HISTORY_V3_MANIFEST.entries.filter(e=>e.type==='table'&&e.name.startsWith('mio_')).map(e=>({table:e.name,rows:db.prepare(`SELECT * FROM ${e.name} ORDER BY rowid`).all()}));
}

test('exact R1 history3 upgrades losslessly and initializes counters from retained rows without touching project sequence',t=>{
 const value=r1Fixture(t),before=inspect(value,r1Data),sequenceBefore=inspect(value,sequence);
 const connection=open(value);
 try{
  assert.deepEqual(r1Data(connection.db),before);assert.equal(sequence(connection.db),sequenceBefore);
  assert.equal(connection.db.prepare('SELECT version FROM schema_version').get()!.version,4);
  assert.deepEqual(connection.db.prepare('SELECT bytes,rows FROM mio_storage_counters').get(),connection.db.prepare(`SELECT ${MIO_QUOTA_BYTES_SQL} AS bytes,${MIO_QUOTA_ROWS_SQL} AS rows`).get());
  assert.equal(connection.db.prepare('SELECT count(*) AS n FROM mio_process_target_revisions').get()!.n,4);
  assert.deepEqual(readSchemaManifest(connection.db,'main'),SCHEMA_MANIFEST.history.entries);
 }finally{connection.close();}
 const reopened=open(value);try{assert.deepEqual(r1Data(reopened.db),before);assert.equal(sequence(reopened.db),sequenceBefore);}finally{reopened.close();}
});

for(const point of ['after-counter-table','after-counter-init','after-version'] as const)test(`R1 history3 counter upgrade failure ${point} retains every record, trigger and version`,t=>{
 const value=r1Fixture(t),before=inspect(value,r1Data),exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;
 let hit=false;
 t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string):void{
  exec.call(this,sql);
  if(point==='after-counter-table'&&sql.startsWith('CREATE TABLE main.mio_storage_counters(')||point==='after-version'&&sql==='UPDATE main.schema_version SET version=4'){hit=true;throw new Error('injected counter upgrade failure');}
 });
 t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
  const statement=prepare.call(this,sql);
  if(point==='after-counter-init'&&sql.startsWith('INSERT INTO main.mio_storage_counters(')){
   // The initialization INSERT has no bound parameters.
   const run=statement.run.bind(statement);statement.run=()=>{run();hit=true;throw new Error('injected counter initialization failure');};
  }
  return statement;
 });
 assert.equal(errorOf(()=>open(value)).code,'PROJECT_INVALID');t.mock.restoreAll();assert.equal(hit,true);
 inspect(value,db=>{assert.equal(db.prepare('SELECT version FROM schema_version').get()!.version,3);assert.deepEqual(readSchemaManifest(db,'main'),R1_HISTORY_V3_MANIFEST.entries);assert.deepEqual(r1Data(db),before);assert.equal(sequence(db),value.sequence);});
 open(value).close();
});

test('modified R1 history3 manifests are refused without accounting repair or record loss',t=>{
 const value=r1Fixture(t),before=inspect(value,r1Data);
 inspect(value,db=>db.exec('CREATE TABLE unknown_mio_extension(value TEXT)'));
 assert.equal(errorOf(()=>open(value)).code,'PROJECT_INVALID');
 inspect(value,db=>{assert.equal(db.prepare('SELECT version FROM schema_version').get()!.version,3);assert.deepEqual(r1Data(db),before);assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='mio_storage_counters'").get(),undefined);});
});

for(const point of ['counter-after-create','counter-after-init','counter-after-version','counter-after-commit'] as const)test(`SIGKILL ${point} preserves old R1 records and a complete counter profile`,{timeout:60_000},async t=>{
 const value=r1Fixture(t),before=inspect(value,r1Data),kill=await atWorker(t,value,point);
 await kill();
 if(point!=='counter-after-commit')inspect(value,db=>{
  assert.equal(db.prepare('SELECT version FROM schema_version').get()!.version,3);
  assert.deepEqual(readSchemaManifest(db,'main'),R1_HISTORY_V3_MANIFEST.entries);assert.deepEqual(r1Data(db),before);
 });
 const connection=open(value);
 try{
  assert.deepEqual(r1Data(connection.db),before);assert.equal(sequence(connection.db),value.sequence);
  assert.deepEqual(readSchemaManifest(connection.db,'main'),SCHEMA_MANIFEST.history.entries);
  assert.deepEqual(connection.db.prepare('SELECT bytes,rows FROM mio_storage_counters').get(),connection.db.prepare(`SELECT ${MIO_QUOTA_BYTES_SQL} AS bytes,${MIO_QUOTA_ROWS_SQL} AS rows`).get());
 }finally{connection.close();}
});

test('the exact S0 history resets only pre-release Mio in one locked opening transaction', t => {
  const value = fixture(t), before = inspect(value, otherData);
  const exec = DatabaseSync.prototype.exec, writes: {db: DatabaseSync; sql: string; transaction: boolean}[] = [];
  t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string): void {
    if (sql.startsWith('DROP TABLE main.agent_task_') || sql.startsWith('CREATE TABLE main.mio_') || sql.startsWith('UPDATE main.schema_version')) writes.push({db: this, sql, transaction: this.isTransaction});
    exec.call(this, sql);
  });
  const connection = open(value);
  try {
    assert.equal(connection.historyState, 'current');
    assert.equal(connection.db.prepare('SELECT version FROM main.schema_version').get()!.version, HISTORY_SCHEMA_VERSION);
    assert.deepEqual(readSchemaManifest(connection.db, 'main'), SCHEMA_MANIFEST.history.entries);
    assert.deepEqual(otherData(connection.db), before);
    assert.equal(processRows(connection.db), 0);
    assert.equal(sequence(connection.db), value.sequence + 1, 'four removed rows advance the content sequence only once');
    assert.equal(connection.db.prepare('SELECT seenContentSequence FROM main.history_state').get()!.seenContentSequence, value.sequence + 1);
    assert.equal(connection.db.prepare('SELECT count(*) AS n FROM main.mio_runs').get()!.n, 0);
    assert.equal(connection.db.prepare('SELECT count(*) AS n FROM main.mio_changes').get()!.n, 0);
    assert.equal(connection.db.prepare('SELECT count(*) AS n FROM main.mio_process_target_revisions').get()!.n, 0, 'existing jobs are not assigned migrated revision tombstones');
    assert.deepEqual(readSchemaManifest(connection.db, 'project'), SCHEMA_MANIFEST.project.entries, 'temporary removal restores identical project SQL');
    assert.equal(connection.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    assert.equal(writes.filter(item => item.sql.startsWith('DROP TABLE')).length, 13);
    assert.ok(writes.every(item => item.db === connection.db && item.transaction));
    assert.match(writes.at(-1)!.sql, /^UPDATE main\.schema_version SET version=4$/u, 'version is the last mutation in the upgrade');
    for (const table of LEGACY_MIO_TABLES) assert.equal(connection.db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(table), undefined);
    connection.db.prepare('INSERT INTO main.mio_conversations(id,projectId,createdAt,updatedAt) VALUES(?,?,?,?)')
      .run(randomUUID(), value.projectId, '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z');
    connection.db.prepare('UPDATE main.jobs SET data=? WHERE id=?').run('{"status":"succeeded"}', 'existing-job');
    assert.equal(connection.db.prepare("SELECT revision FROM main.mio_process_target_revisions WHERE kind='job' AND targetId='existing-job'").get()!.revision, 1);
    assert.equal(sequence(connection.db), value.sequence + 1, 'normal process progress no longer touches the project');
  } finally {
    connection.close();
  }
  t.mock.restoreAll();
  const reopened = open(value);
  try {
    assert.equal(sequence(reopened.db), value.sequence + 1, 'reopening does not repeat the reset');
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM main.mio_conversations').get()!.n, 1, 'new Mio records survive subsequent opening');
    assert.equal(reopened.db.prepare("SELECT revision FROM main.mio_process_target_revisions WHERE kind='job' AND targetId='existing-job'").get()!.revision, 1);
  } finally { reopened.close(); }
});

for (const processes of [false, true]) test(`fresh history cleans old project process revisions (${processes})`, t => {
  const value = fixture(t, {fresh: true, processes});
  const connection = open(value);
  try {
    assert.equal(connection.historyState, 'fresh');
    assert.equal(processRows(connection.db), 0);
    assert.equal(sequence(connection.db), value.sequence + Number(processes));
    assert.equal(connection.db.prepare('SELECT seenContentSequence FROM main.history_state').get()!.seenContentSequence, sequence(connection.db));
    assert.deepEqual(readSchemaManifest(connection.db, 'main'), SCHEMA_MANIFEST.history.entries);
  } finally { connection.close(); }
});

for (const mutation of ['extra-table', 'changed-trigger', 'unknown-old-version', 'future-version', 'wrong-project', 'file-newer', 'file-older'] as const) {
  test(`history upgrade refuses ${mutation} without resetting development records`, t => {
    const value = fixture(t);
    inspect(value, db => {
      if (mutation === 'extra-table') db.exec('CREATE TABLE main.unreviewed_history(value TEXT)');
      else if (mutation === 'changed-trigger') {
        db.exec('DROP TRIGGER main.agent_quota_agent_task_changes_v2_insert');
        db.exec("CREATE TRIGGER main.agent_quota_agent_task_changes_v2_insert AFTER INSERT ON agent_task_changes_v2 BEGIN SELECT RAISE(ABORT,'not-the-reviewed-trigger');END");
      } else if (mutation === 'unknown-old-version' || mutation === 'future-version') db.prepare('UPDATE main.schema_version SET version=?').run(mutation === 'future-version' ? HISTORY_SCHEMA_VERSION + 1 : 1);
      else if (mutation === 'wrong-project') {
        db.exec('DROP TRIGGER main.history_state_guard_identity');
        db.prepare('UPDATE main.history_state SET projectId=?').run(randomUUID());
        db.exec("CREATE TRIGGER main.history_state_guard_identity BEFORE UPDATE OF singleton,projectId ON history_state WHEN NEW.singleton IS NOT OLD.singleton OR NEW.projectId IS NOT OLD.projectId BEGIN SELECT RAISE(ABORT,'HISTORY_STATE_IDENTITY_IMMUTABLE');END");
      } else db.prepare('UPDATE main.history_state SET seenContentSequence=?').run(value.sequence + (mutation === 'file-older' ? 1 : -1));
    });
    const error = errorOf(() => open(value));
    assert.equal(error.code, mutation === 'future-version' ? 'PROJECT_FORMAT_NEWER' : 'PROJECT_INVALID');
    inspect(value, db => {
      assert.equal(db.prepare('SELECT count(*) AS n FROM main.agent_task_runs_v2').get()!.n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM main.agent_task_changes_v2').get()!.n, 1);
      assert.equal(processRows(db), 4);
      assert.equal(sequence(db), value.sequence);
    });
  });
}

for (const point of ['after-drop', 'after-create', 'after-cleanup', 'after-version'] as const) test(`a thrown upgrade failure ${point} rolls back all files and DDL`, t => {
  const value = fixture(t);
  const exec = DatabaseSync.prototype.exec;
  let hit = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string): void {
    exec.call(this, sql);
    const selected = point === 'after-drop' ? sql === 'DROP TABLE main.agent_task_runs_v2'
      : point === 'after-create' ? sql.startsWith('CREATE TABLE main.mio_conversations(')
      : point === 'after-cleanup' ? sql.startsWith('CREATE TRIGGER project.project_file_sequence_agent_task_target_revisions_v2_delete ')
      : sql === 'UPDATE main.schema_version SET version=4';
    if (selected) { hit = true; throw new Error(`simulated upgrade ${point}`); }
  });
  assert.equal(errorOf(() => open(value)).code, 'PROJECT_INVALID');
  t.mock.restoreAll();
  assert.equal(hit, true);
  assertOld(value);
  open(value).close();
});

test('content-sequence overflow rolls back the reset and its temporarily removed trigger', t => {
  const base = fixture(t);
  inspect(base, db => {
    db.prepare('UPDATE project.project_file SET contentSequence=?').run(Number.MAX_SAFE_INTEGER);
    db.prepare('UPDATE main.history_state SET seenContentSequence=?').run(Number.MAX_SAFE_INTEGER);
  });
  const value = {...base, sequence: Number.MAX_SAFE_INTEGER};
  assert.equal(errorOf(() => open(value)).code, 'PROJECT_INVALID');
  assertOld(value);
});

async function atWorker(t: TestContext, value: Fixture, point: string): Promise<() => Promise<void>> {
  const marker = path.join(value.root, `ready-${point}`);
  // A file is a synchronous barrier inside SQLite's opening transaction; no
  // worker stdout/stderr bytes are parsed as control messages.
  const child = spawn(process.execPath, [WORKER], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: {
    ...process.env, MIO_UPGRADE_PROJECT: value.projectFile, MIO_UPGRADE_LOCAL: value.localDir,
    MIO_UPGRADE_CACHE: value.cacheDir, MIO_UPGRADE_TMP: value.tempDir, MIO_UPGRADE_POINT: point, MIO_UPGRADE_MARKER: marker,
  }});
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker)) {
    assert.equal(child.exitCode, null, 'upgrade worker exited before its barrier');
    assert.equal(child.signalCode, null, 'upgrade worker stopped before its barrier');
    assert.ok(Date.now() < deadline, 'upgrade worker did not reach the barrier');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return async () => {
    child.kill('SIGKILL');
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
  };
}

for (const point of ['after-drop', 'after-cleanup', 'after-version', 'after-commit']) test(`SIGKILL ${point} recovers a complete old or new profile`, {timeout: 60_000}, async t => {
  const value = fixture(t), before = inspect(value, otherData);
  const kill = await atWorker(t, value, point);
  if (point !== 'after-commit') assert.ok(statSync(`${value.historyFile}-journal`).size > 0, 'the killed reset has a real rollback journal');
  await kill();
  if (point !== 'after-commit') {
    // Raw recovery is allowed only while no store of this process holds the
    // files. It proves both files rolled back before retrying the real opener.
    const project = new DatabaseSync(value.projectFile); project.close();
    assertOld(value);
  }
  const connection = open(value);
  try {
    assert.deepEqual(otherData(connection.db), before);
    assert.equal(sequence(connection.db), value.sequence + 1);
    assert.equal(processRows(connection.db), 0);
    assert.equal(connection.db.prepare('SELECT version FROM main.schema_version').get()!.version, 4);
    assert.deepEqual(readSchemaManifest(connection.db, 'main'), SCHEMA_MANIFEST.history.entries);
  } finally { connection.close(); }
});

test('another process holding the old history prevents any upgrade', {timeout: 60_000}, async t => {
  const value = fixture(t);
  const kill = await atWorker(t, value, 'hold-old');
  assert.equal(errorOf(() => open(value)).code, 'PROJECT_LOCKED');
  await kill();
  assertOld(value);
  open(value).close();
});
