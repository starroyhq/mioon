// The app library (task card B1): its structure, lock, private storage rules,
// transactions and stores, and the shapes the project host's ports expect.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskPolicy} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {BackgroundTaskIndexEntry, ProjectFileIdentity, ProjectInboxItem, RecentProject} from '../packages/contracts/src/project-registry.ts';
import {PrivateStorageError} from '../packages/contracts/src/private-storage.ts';
import {
  APP_DOCUMENT_LIMITS, APP_LIBRARY_APPLICATION_ID, APP_LIBRARY_FILE, APP_LIBRARY_SCHEMA_VERSION, openAppLibrary,
} from '../packages/business/src/app-db/index.ts';
import type {AppLibrary} from '../packages/business/src/app-db/index.ts';
import {APP_LIBRARY_STATEMENTS, expectedAppSchema, FORMAT_72_APP_STATEMENTS, readAppSchema} from '../packages/business/src/app-db/schema.ts';
import {deriveFromFormat72} from './helpers/project-file-schema-derivation.ts';

const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const CHILD = fileURLToPath(new URL('./helpers/project-file-child.ts', import.meta.url));
const POSIX = process.platform !== 'win32';

// ---------------------------------------------------------------------------
// The project host's ports, copied from apps/server/src/project-host/ports.ts on
// origin/howard/s0-project-host (a84d84fa, PR #107, not merged): the B1 and S3
// sections. The assignments in the last test check the app library against
// them when the tests are type-checked; S0 replaces them with the real import.

interface ProjectRegistryPort {
  list(): readonly RecentProject[];
  get(projectId: string): RecentProject | null;
  upsert(entry: RecentProject): void;
  remove(projectId: string): void;
  findMoved(entry: RecentProject): Promise<string | null>;
  checkCopy?(file: {readonly projectId: string; readonly projectFile: string}): void;
}
type ProjectFileIdentityPort = (projectFile: string) => ProjectFileIdentity | null;
interface AgentPolicyStorePort {
  read(): AgentTaskPolicy | null;
  readRequest(requestId: string): {readonly digest: string; readonly policy: AgentTaskPolicy} | null;
  write(policy: AgentTaskPolicy, request?: {readonly requestId: string; readonly digest: string}): void;
}
interface AppLibraryPort {
  readonly registry: ProjectRegistryPort;
  readonly agentPolicy: AgentPolicyStorePort;
  readonly projectFileIdentity: ProjectFileIdentityPort;
  readonly databaseFile: string;
  close(): void;
}
interface BackgroundTaskIndexPort {
  list(): readonly BackgroundTaskIndexEntry[];
  replace(projectId: string, entries: readonly BackgroundTaskIndexEntry[]): void;
}
interface ProjectInboxPort {
  add(item: ProjectInboxItem): void;
  list(projectId: string): readonly ProjectInboxItem[];
  remove(projectId: string, itemId: string): void;
}

// ---------------------------------------------------------------------------

function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-b1-library-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
function open(t: TestContext, dataDir: string): AppLibrary {
  const library = openAppLibrary({dataDir});
  t.after(() => library.close());
  return library;
}
function appError(action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected an AppError');
}
const pragma = (db: DatabaseSync, name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
/** A plain connection to a library no store holds, for tampering. */
function tamper(file: string, change: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(file);
  try {
    change(db);
  } finally {
    db.close();
  }
}
/** Another process reading the file read-only with a busy timeout of 0. */
function readInChild(file: string): {ok: boolean; errcode?: number} {
  const result = spawnSync(process.execPath, [CHILD], {cwd: REPOSITORY, env: {...process.env, MODE: 'raw-read', FILE: file}, encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as {ok: boolean; errcode?: number};
}
const project = (overrides: Partial<RecentProject> = {}): RecentProject => ({
  projectId: randomUUID(), projectFile: '/Films/Film/Film.mioon', fileIdentity: {dev: '1', ino: '2'},
  name: 'Film', lastOpenedAt: null, summary: null, ...overrides,
});
const policy = (revision: number): AgentTaskPolicy => ({...structuredClone(DEFAULT_AGENT_TASK_POLICY), revision});
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

test('a new library is built from the format-72 SQL the derivation hands over and the B1 tables', t => {
  const dataDir = path.join(scratch(t), 'data');
  const library = open(t, dataDir);
  assert.equal(library.databaseFile, path.join(dataDir, APP_LIBRARY_FILE));
  assert.equal(library.dataDir, dataDir);
  if (POSIX) {
    assert.equal(lstatSync(library.databaseFile).mode & 0o777, 0o600);
    assert.equal(lstatSync(dataDir).mode & 0o777, 0o700);
  }
  assert.equal(pragma(library.db, 'main.application_id'), APP_LIBRARY_APPLICATION_ID);
  assert.deepEqual(library.db.prepare('SELECT version FROM schema_version').all().map(row => row.version), [APP_LIBRARY_SCHEMA_VERSION]);
  assert.equal(pragma(library.db, 'main.journal_mode'), 'delete');
  assert.equal(pragma(library.db, 'locking_mode'), 'exclusive');
  assert.equal(pragma(library.db, 'trusted_schema'), 0);
  assert.deepEqual(readAppSchema(library.db), expectedAppSchema());

  // `node tests/helpers/project-file-schema-derivation.ts --report`: 3 tables
  // and 2 triggers, byte for byte, and their 2 automatic indexes.
  const handed = deriveFromFormat72().objects.filter(object => object.fate === 'app');
  const builtSql = new Set(readAppSchema(library.db).map(object => object.sql));
  const handedSql = handed.filter(object => object.sql !== null).map(object => object.sql!);
  assert.deepEqual([...handedSql].sort(), [...FORMAT_72_APP_STATEMENTS].sort());
  for (const sql of handedSql) assert.ok(builtSql.has(sql), sql);
  assert.deepEqual(handed.filter(object => object.type === 'table').map(object => object.name).sort(), ['agent_task_policy_requests_v2', 'agent_task_policy_v2', 'workspace_preferences']);
  assert.equal(handed.filter(object => object.type === 'trigger').length, 2);
  const indexes = new Set(readAppSchema(library.db).filter(object => object.type === 'index').map(object => object.name));
  for (const object of handed.filter(item => item.type === 'index')) assert.ok(indexes.has(object.name), object.name);
  // No quota trigger and no foreign key to a project table.
  assert.equal(readAppSchema(library.db).some(object => object.name.startsWith('agent_quota_')), false);
  assert.deepEqual(library.db.prepare('PRAGMA main.foreign_key_list(workspace_preferences)').all(), []);
  assert.equal(APP_LIBRARY_STATEMENTS.some(sql => /REFERENCES/u.test(sql)), false);

  // Changing the structure means a new version: this digest records version 1.
  assert.equal(createHash('sha256').update(JSON.stringify(expectedAppSchema())).digest('hex'),
    'f7aa62f54c5e09ffb405b8efe8369f3445e32758526b5e30484ad542e58f7de9');
});

test('the library is reopened with its records and checked again on every open', t => {
  const dataDir = path.join(scratch(t), 'data');
  const first = openAppLibrary({dataDir});
  const film = project();
  first.registry.upsert(film);
  first.agentPolicy.write(policy(1), {requestId: 'request-1', digest: sha('1')});
  first.documents.write('ui-preferences-v1.json', '{"version":1}');
  first.close();
  const again = open(t, dataDir);
  assert.deepEqual(again.registry.list(), [film]);
  assert.deepEqual(again.agentPolicy.read(), policy(1));
  assert.deepEqual(again.agentPolicy.readRequest('request-1'), {digest: sha('1'), policy: policy(1)});
  assert.equal(again.documents.read('ui-preferences-v1.json'), '{"version":1}');
  assert.equal(again.databaseFile, first.databaseFile);
});

test('another structure, a newer version, another application or not a database refuses the open', t => {
  const dataDir = path.join(scratch(t), 'data');
  openAppLibrary({dataDir}).close();
  const file = path.join(dataDir, APP_LIBRARY_FILE);
  const refused = (): AppError => appError(() => openAppLibrary({dataDir}));

  tamper(file, db => db.exec('CREATE TABLE extra(x)'));
  let error = refused();
  assert.deepEqual([error.code, error.status, error.details], ['APP_LIBRARY_INVALID', 422, {reason: 'schema', differences: ['unexpected table:extra']}]);
  tamper(file, db => db.exec('DROP TABLE extra'));

  tamper(file, db => {
    db.exec('DROP TRIGGER immutable_app_operation_receipts');
    db.exec("CREATE TRIGGER immutable_app_operation_receipts BEFORE UPDATE ON app_operation_receipts BEGIN SELECT 1;END");
  });
  error = refused();
  assert.deepEqual(error.details, {reason: 'schema', differences: ['changed trigger:immutable_app_operation_receipts']});
  tamper(file, db => {
    db.exec('DROP TRIGGER immutable_app_operation_receipts');
    db.exec(APP_LIBRARY_STATEMENTS.at(-1)!);
  });
  openAppLibrary({dataDir}).close();

  tamper(file, db => db.exec('UPDATE schema_version SET version=2'));
  error = refused();
  assert.deepEqual([error.code, error.status, error.details], ['APP_LIBRARY_FORMAT_NEWER', 409, {formatVersion: 2, supportedFormatVersion: 1}]);
  tamper(file, db => db.exec('UPDATE schema_version SET version=1; PRAGMA application_id=1'));
  assert.deepEqual(refused().details, {reason: 'application-id'});
  tamper(file, db => db.exec(`PRAGMA application_id=${APP_LIBRARY_APPLICATION_ID}`));
  openAppLibrary({dataDir}).close();

  writeFileSync(file, Buffer.alloc(4096, 0x5a));
  error = refused();
  assert.deepEqual([error.code, error.details], ['APP_LIBRARY_INVALID', {reason: 'corrupt'}]);
});

/** openAppLibrary in another process: `{ok: true, entries}` or `{ok: false, code}`. */
function openInChild(dataDir: string): Record<string, unknown> {
  const script = `import {openAppLibrary} from ${JSON.stringify(pathToFileURL(path.join(REPOSITORY, 'packages/business/src/app-db/index.ts')).href)};
try {
  const library = openAppLibrary({dataDir: process.env.DATA_DIR});
  const entries = library.registry.list().length;
  library.close();
  console.log(JSON.stringify({ok: true, entries}));
} catch (error) {
  console.log(JSON.stringify({ok: false, code: error.code}));
}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {cwd: REPOSITORY, env: {...process.env, DATA_DIR: dataDir}, encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
}

test('a second open, in this process or in another, is refused until the library closes', t => {
  const dataDir = path.join(scratch(t), 'data');
  const library = openAppLibrary({dataDir});
  const error = appError(() => openAppLibrary({dataDir}));
  assert.deepEqual([error.code, error.status], ['APP_LIBRARY_LOCKED', 409]);
  // Exclusive locking: another process can neither open nor read it.
  assert.deepEqual(openInChild(dataDir), {ok: false, code: 'APP_LIBRARY_LOCKED'});
  assert.deepEqual(readInChild(library.databaseFile), {ok: false, message: 'database is locked', errcode: 5});
  library.registry.upsert(project());
  assert.deepEqual(openInChild(dataDir), {ok: false, code: 'APP_LIBRARY_LOCKED'});
  library.close();
  assert.deepEqual(readInChild(library.databaseFile), {ok: true});
  assert.deepEqual(openInChild(dataDir), {ok: true, entries: 1});
  const again = open(t, dataDir);
  assert.equal(again.registry.list().length, 1);
});

test('the data directory and the library follow the private storage rules', {skip: !POSIX && 'POSIX modes and links'}, t => {
  const root = scratch(t);
  const reason = (action: () => unknown): string => {
    try {
      action();
    } catch (error) {
      assert.ok(error instanceof PrivateStorageError, String(error));
      return error.reason;
    }
    assert.fail('expected a PrivateStorageError');
  };
  const shared = path.join(root, 'shared');
  mkdirSync(shared, {mode: 0o700});
  chmodSync(shared, 0o770);
  assert.equal(reason(() => openAppLibrary({dataDir: shared})), 'DIRECTORY_PERMISSIONS');

  const real = path.join(root, 'real');
  openAppLibrary({dataDir: real}).close();
  symlinkSync(real, path.join(root, 'linked'));
  assert.equal(reason(() => openAppLibrary({dataDir: path.join(root, 'linked')})), 'SYMBOLIC_LINK');

  const file = path.join(real, APP_LIBRARY_FILE);
  chmodSync(file, 0o666);
  assert.equal(reason(() => openAppLibrary({dataDir: real})), 'FILE_PERMISSIONS');
  chmodSync(file, 0o600);
  linkSync(file, path.join(root, 'second-link.db'));
  assert.equal(reason(() => openAppLibrary({dataDir: real})), 'HARD_LINK');
  rmSync(path.join(root, 'second-link.db'));
  openAppLibrary({dataDir: real}).close();

  const elsewhere = path.join(root, 'elsewhere');
  openAppLibrary({dataDir: elsewhere}).close();
  const pointing = path.join(root, 'pointing');
  mkdirSync(pointing, {mode: 0o700});
  symlinkSync(path.join(elsewhere, APP_LIBRARY_FILE), path.join(pointing, APP_LIBRARY_FILE));
  assert.equal(reason(() => openAppLibrary({dataDir: pointing})), 'SYMBOLIC_LINK');
});

test('tx is synchronous and not nested, rolls back on errors, and the stores\' writes join it', t => {
  const library = open(t, path.join(scratch(t), 'data'));
  const film = project();
  assert.throws(() => library.tx(() => library.tx(() => 1)), /Nested transactions are not supported/);
  assert.throws(() => library.tx((async () => 1) as unknown as () => number), TypeError);
  assert.throws(() => library.tx(() => {
    library.registry.upsert(film);
    return Promise.resolve(1);
  }), /synchronous result/);
  assert.equal(library.registry.get(film.projectId), null);
  assert.throws(() => library.tx(() => {
    library.registry.upsert(film);
    library.rulesTrust.set({projectId: film.projectId, sha256: sha('rules'), trustedAt: '2026-11-01T00:00:00.000Z'});
    throw new Error('stop');
  }), /stop/);
  assert.equal(library.registry.get(film.projectId), null);
  assert.equal(library.rulesTrust.get(film.projectId), null);
  // A store's write that fails inside a caller's transaction undoes only itself.
  const item: ProjectInboxItem = {id: randomUUID(), projectId: film.projectId, taskKind: 'job', taskId: randomUUID(), receivedAt: '2026-11-01T00:00:00.000Z', stagedMedia: []};
  library.inbox.add(item);
  library.tx(() => {
    library.registry.upsert(film);
    assert.throws(() => library.inbox.add({...item, taskKind: 'export'}), {code: 'PROJECT_INBOX_ITEM_CONFLICT'});
  });
  assert.deepEqual(library.registry.get(film.projectId), film);
  assert.deepEqual(library.inbox.list(film.projectId), [item]);
  assert.equal(library.db.isTransaction, false);
});

test('after close every store refuses with APP_LIBRARY_CLOSED, and close is idempotent', t => {
  const library = openAppLibrary({dataDir: path.join(scratch(t), 'data')});
  library.close();
  library.close();
  for (const action of [
    () => library.registry.list(), () => library.agentPolicy.read(), () => library.documents.read('last-project-v1.json'),
    () => library.taskIndex.list(), () => library.tx(() => 1),
  ]) assert.equal(appError(action).code, 'APP_LIBRARY_CLOSED');
});

test('documents: the three files as JSON text, each within the size its file had', t => {
  const library = open(t, path.join(scratch(t), 'data'));
  assert.deepEqual(APP_DOCUMENT_LIMITS, {'ui-preferences-v1.json': 1024 * 1024, 'workspace-settings-v1.json': 16 * 1024, 'last-project-v1.json': 4096});
  for (const name of ['ui-preferences-v1.json', 'workspace-settings-v1.json', 'last-project-v1.json'] as const) {
    assert.equal(library.documents.read(name), null);
    library.documents.write(name, `${JSON.stringify({name})}\n`);
    assert.equal(library.documents.read(name), `${JSON.stringify({name})}\n`);
  }
  // `{"padding":"…"}` is 14 bytes around the padding.
  library.documents.write('last-project-v1.json', JSON.stringify({padding: 'x'.repeat(4096 - 14)}));
  assert.equal(Buffer.byteLength(library.documents.read('last-project-v1.json')!), 4096);
  const error = appError(() => library.documents.write('last-project-v1.json', JSON.stringify({padding: 'x'.repeat(4096 - 13)})));
  assert.deepEqual([error.code, error.status, error.details], ['APP_LIBRARY_LIMIT', 507, {document: 'last-project-v1.json', limit: 4096}]);
  library.documents.write('workspace-settings-v1.json', JSON.stringify({padding: 'x'.repeat(16 * 1024 - 14)}));
  assert.equal(appError(() => library.documents.write('workspace-settings-v1.json', JSON.stringify({padding: 'x'.repeat(16 * 1024 - 13)}))).code, 'APP_LIBRARY_LIMIT');
  assert.throws(() => library.documents.write('ui-preferences-v1.json', '{not json'), TypeError);
  assert.throws(() => library.documents.write('agent-authorizations-v1.json' as never, '{}'), TypeError);
  assert.throws(() => library.documents.read('workbench.sqlite' as never), TypeError);
  library.documents.remove('ui-preferences-v1.json');
  assert.equal(library.documents.read('ui-preferences-v1.json'), null);
  // The table refuses other names and oversized text by itself as well.
  assert.throws(() => library.db.prepare("INSERT INTO app_documents(name,data) VALUES('x.json','{}')").run(), /CHECK constraint failed/);
  assert.throws(() => library.db.prepare("INSERT OR REPLACE INTO app_documents(name,data) VALUES('last-project-v1.json',?)").run(JSON.stringify('x'.repeat(5000))), /CHECK constraint failed/);
});

test('the global policy and its receipts: one transaction, receipts never replaced, changed or deleted', t => {
  const library = open(t, path.join(scratch(t), 'data'));
  const store = library.agentPolicy;
  assert.equal(store.read(), null);
  assert.equal(store.readRequest('request-1'), null);
  store.write(policy(1));
  assert.deepEqual(store.read(), policy(1));
  // Mio's updatePolicy: replay by receipt, then the revision check, then write.
  const update = (next: AgentTaskPolicy, requestId: string): AgentTaskPolicy => {
    const digest = sha(JSON.stringify(next));
    const saved = store.readRequest(requestId);
    if (saved) {
      if (saved.digest !== digest) throw new Error('AGENT_TASK_REQUEST_CONFLICT');
      return saved.policy;
    }
    if (next.revision !== store.read()?.revision) throw new Error('AGENT_TASK_REVISION_CONFLICT');
    const written = {...next, revision: next.revision + 1};
    store.write(written, {requestId, digest});
    return written;
  };
  const changed: AgentTaskPolicy = {...policy(1), stepLimit: 12};
  assert.deepEqual(update(changed, 'request-2'), {...changed, revision: 2});
  assert.deepEqual(update(changed, 'request-2'), {...changed, revision: 2});
  assert.throws(() => update(changed, 'request-3'), /AGENT_TASK_REVISION_CONFLICT/);
  assert.deepEqual(store.readRequest('request-2'), {digest: sha(JSON.stringify(changed)), policy: {...changed, revision: 2}});

  // A second receipt under the same request ID changes neither table.
  const error = appError(() => store.write(policy(9), {requestId: 'request-2', digest: sha('other')}));
  assert.deepEqual([error.code, error.status], ['AGENT_POLICY_REQUEST_EXISTS', 409]);
  assert.deepEqual(store.read(), {...changed, revision: 2});
  assert.throws(() => library.db.prepare("UPDATE agent_task_policy_requests_v2 SET digest=? WHERE requestId='request-2'").run(sha('x')), /Agent task evidence is immutable/);
  assert.throws(() => library.db.prepare("DELETE FROM agent_task_policy_requests_v2 WHERE requestId='request-2'").run(), /Agent task evidence must be retained/);
  assert.throws(() => store.write({...policy(3), stepLimit: 0}), {name: 'ZodError'});
  assert.throws(() => store.write(policy(3), {requestId: 'request-4', digest: 'not-a-digest'}), TypeError);
  assert.throws(() => store.write(policy(3), {requestId: '', digest: sha('x')}), TypeError);
  assert.deepEqual(store.read(), {...changed, revision: 2});
});

test('workspace_preferences keeps the format-72 checks; the project is checked in code', t => {
  const library = open(t, path.join(scratch(t), 'data'));
  const projectId = randomUUID();
  library.tx(() => library.db.prepare('INSERT INTO workspace_preferences(projectId,revision,state) VALUES(?,1,?)').run(projectId, '{"version":1}'));
  assert.deepEqual({...library.db.prepare('SELECT revision,state FROM workspace_preferences WHERE projectId=?').get(projectId)}, {revision: 1, state: '{"version":1}'});
  assert.throws(() => library.db.prepare('INSERT INTO workspace_preferences(projectId,revision,state) VALUES(?,0,?)').run(randomUUID(), '{}'), /CHECK constraint failed/);
  assert.throws(() => library.db.prepare('INSERT INTO workspace_preferences(projectId,revision,state) VALUES(?,1,?)').run(randomUUID(), JSON.stringify('x'.repeat(16384))), /CHECK constraint failed/);
  // No project table and no foreign key: an unregistered project ID is the caller's check.
  library.db.prepare('INSERT INTO workspace_preferences(projectId,revision,state) VALUES(?,1,?)').run(randomUUID(), '{}');
});

test('rules trust and outside-path confirmations are kept per project and folder', t => {
  const library = open(t, path.join(scratch(t), 'data'));
  const projectId = randomUUID(), other = randomUUID();
  const trust = {projectId, sha256: sha('rules v1'), trustedAt: '2026-11-01T08:00:00.000Z'};
  library.rulesTrust.set(trust);
  library.rulesTrust.set({...trust, sha256: sha('rules v2')});
  assert.deepEqual(library.rulesTrust.get(projectId), {...trust, sha256: sha('rules v2')});
  assert.equal(library.rulesTrust.get(other), null);
  assert.equal(library.rulesTrust.get('not an id'), null);
  assert.throws(() => library.rulesTrust.set({...trust, sha256: 'x'}), {name: 'ZodError'});
  library.rulesTrust.remove(projectId);
  assert.equal(library.rulesTrust.get(projectId), null);

  const footage = '/Volumes/Footage', music = '/Music';
  library.outsidePaths.confirm({projectId, directory: music, confirmedAt: '2026-11-01T08:00:00.000Z'});
  library.outsidePaths.confirm({projectId, directory: footage, confirmedAt: '2026-11-01T08:00:00.000Z'});
  library.outsidePaths.confirm({projectId, directory: footage, confirmedAt: '2026-11-01T09:00:00.000Z'});
  library.outsidePaths.confirm({projectId: other, directory: footage, confirmedAt: '2026-11-01T08:00:00.000Z'});
  // By directory: '/Music' sorts before '/Volumes/Footage'.
  assert.deepEqual(library.outsidePaths.list(projectId).map(item => [item.directory, item.confirmedAt]),
    [[music, '2026-11-01T08:00:00.000Z'], [footage, '2026-11-01T09:00:00.000Z']]);
  assert.throws(() => library.outsidePaths.confirm({projectId, directory: 'relative/folder', confirmedAt: '2026-11-01T08:00:00.000Z'}), {name: 'ZodError'});
  library.outsidePaths.revoke(projectId, music);
  assert.deepEqual(library.outsidePaths.list(projectId).map(item => item.directory), [footage]);
  library.outsidePaths.revoke(projectId);
  assert.deepEqual(library.outsidePaths.list(projectId), []);
  assert.equal(library.outsidePaths.list(other).length, 1);
});

test('the task index replaces one project\'s entries at a time', t => {
  const library = open(t, path.join(scratch(t), 'data'));
  const a = randomUUID(), b = randomUUID();
  const entry = (projectId: string, kind: BackgroundTaskIndexEntry['kind'], indexedAt: string): BackgroundTaskIndexEntry =>
    ({projectId, projectFile: `/Films/${projectId}/Film.mioon`, kind, taskId: randomUUID(), indexedAt});
  const first = [entry(a, 'job', '2026-11-01T08:00:02.000Z'), entry(a, 'export', '2026-11-01T08:00:01.000Z')];
  const second = [entry(b, 'image_task', '2026-11-01T08:00:00.000Z')];
  library.taskIndex.replace(a, first);
  library.taskIndex.replace(b, second);
  assert.deepEqual(library.taskIndex.list(), [second[0], first[1], first[0]]);
  const next = [entry(a, 'scene_task', '2026-11-01T09:00:00.000Z')];
  library.taskIndex.replace(a, next);
  assert.deepEqual(library.taskIndex.list(), [second[0], next[0]]);
  assert.throws(() => library.taskIndex.replace(a, second), /must belong to the project/);
  assert.throws(() => library.taskIndex.replace(a, [next[0], next[0]]), /each task once/);
  assert.throws(() => library.taskIndex.replace('not an id', []), {name: 'ZodError'});
  assert.deepEqual(library.taskIndex.list(), [second[0], next[0]]);
  library.taskIndex.replace(a, []);
  assert.deepEqual(library.taskIndex.list(), [second[0]]);
});

test('inbox items are added once, listed by arrival and removed by project and ID', t => {
  const library = open(t, path.join(scratch(t), 'data'));
  const projectId = randomUUID();
  const item = (receivedAt: string): ProjectInboxItem => ({
    id: randomUUID(), projectId, taskKind: 'image_task', taskId: randomUUID(), receivedAt,
    stagedMedia: [{fileName: 'result.png', mimeType: 'image/png', sizeBytes: 10, sha256: sha('png')}],
  });
  const late = item('2026-11-01T09:00:00.000Z'), early = item('2026-11-01T08:00:00.000Z');
  library.inbox.add(late);
  library.inbox.add(early);
  library.inbox.add(structuredClone(late));
  assert.deepEqual(library.inbox.list(projectId), [early, late]);
  const error = appError(() => library.inbox.add({...late, taskKind: 'job'}));
  assert.deepEqual([error.code, error.status], ['PROJECT_INBOX_ITEM_CONFLICT', 409]);
  assert.throws(() => library.inbox.add({...late, stagedMedia: [{...late.stagedMedia[0]!, fileName: '../escape'}]}), {name: 'ZodError'});
  library.inbox.remove(projectId, early.id);
  library.inbox.remove(randomUUID(), late.id);
  assert.deepEqual(library.inbox.list(projectId), [late]);
  assert.deepEqual(library.inbox.list(randomUUID()), []);
});

test('cross-project receipts replay exactly and are never changed', t => {
  const library = open(t, path.join(scratch(t), 'data'));
  const receipt = {operation: 'project.create', requestId: randomUUID(), digest: sha('input'), response: {projectId: randomUUID(), name: '短片'}, createdAt: '2026-11-01T08:00:00.000Z'};
  assert.equal(library.receipts.read(receipt.operation, receipt.requestId), null);
  library.receipts.write(receipt);
  library.receipts.write(structuredClone(receipt));
  assert.deepEqual(library.receipts.read(receipt.operation, receipt.requestId), receipt);
  assert.equal(library.receipts.read('project.duplicate', receipt.requestId), null);
  const error = appError(() => library.receipts.write({...receipt, digest: sha('other input')}));
  assert.deepEqual([error.code, error.status], ['APP_OPERATION_RECEIPT_CONFLICT', 409]);
  assert.throws(() => library.db.prepare('UPDATE app_operation_receipts SET createdAt=?').run('2026-11-02T00:00:00.000Z'), /App operation receipts are immutable/);
  for (const invalid of [
    {...receipt, operation: 'create'}, {...receipt, operation: 'Project.Create'}, {...receipt, requestId: ''}, {...receipt, digest: 'x'},
    {...receipt, createdAt: '2026-11-01 08:00'}, {...receipt, response: undefined}, {...receipt, extra: 1},
  ]) assert.throws(() => library.receipts.write(invalid as never), TypeError, JSON.stringify(invalid));
  const large = appError(() => library.receipts.write({...receipt, requestId: randomUUID(), response: 'x'.repeat(70_000)}));
  assert.equal(large.code, 'APP_LIBRARY_LIMIT');
});

test('the library satisfies the project host\'s ports, as plain objects of closures', t => {
  const library = open(t, path.join(scratch(t), 'data'));
  const port: AppLibraryPort = library;
  const taskIndex: BackgroundTaskIndexPort = library.taskIndex;
  const inbox: ProjectInboxPort = library.inbox;
  // Spread and detached, as the host's tests wrap them.
  const {list, upsert, get} = {...port.registry};
  const film = project();
  upsert(film);
  assert.deepEqual([list(), get(film.projectId)], [[film], film]);
  assert.equal(typeof port.registry.checkCopy, 'function');
  const {read, write} = port.agentPolicy;
  write(policy(1));
  assert.deepEqual(read(), policy(1));
  assert.equal(port.projectFileIdentity(path.join(scratch(t), 'missing.mioon')), null);
  assert.deepEqual([taskIndex.list(), inbox.list(film.projectId)], [[], []]);
  assert.equal(port.databaseFile, library.databaseFile);
});
