import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {isProjectId, PROJECT_FILE_SINGLE_PROJECT, PROJECT_INVALID_REASONS, TEST_STORE_LAYOUT} from '../packages/contracts/src/project-file.ts';
import {createProjectFile, openProjectConnection, PROJECT_JOURNAL_SIZE_LIMIT} from '../packages/business/src/project-file/connection.ts';
import type {ProjectConnection, ProjectCopyCheck, ProjectLocation} from '../packages/business/src/project-file/connection.ts';
import {crossFileTriggerStatements} from '../packages/business/src/project-file/cross-file/install.ts';
import {CACHE_APPLICATION_ID, HISTORY_APPLICATION_ID, HISTORY_SCHEMA_VERSION, PROJECT_FILE_APPLICATION_ID} from '../packages/business/src/project-file/schema/databases.ts';
import {readSchemaManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {SCHEMA_MANIFEST} from '../packages/business/src/project-file/schema/manifest.ts';

const CHILD = fileURLToPath(new URL('./helpers/project-file-child.ts', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));

function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-k1-open-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

interface Project extends ProjectLocation {
  readonly root: string;
  readonly projectFile: string;
  readonly historyFile: string;
  readonly cacheFile: string;
}
/** The test layout: project.mioon in `root`, the local records, cache and
 * temporary directories under `<records>/.mioon-store/`. */
function layout(root: string, records = root): Project {
  const localDir = path.join(records, ...TEST_STORE_LAYOUT.localDir);
  const cacheDir = path.join(records, ...TEST_STORE_LAYOUT.cacheDir);
  return {
    root, projectFile: path.join(root, ...TEST_STORE_LAYOUT.projectFile),
    localDir, cacheDir, tempDir: path.join(records, ...TEST_STORE_LAYOUT.tempDir),
    historyFile: path.join(localDir, 'history.db'), cacheFile: path.join(cacheDir, 'cache.db'),
  };
}
const withFile = (project: Project, projectFile: string): Project => ({...project, projectFile});
function open(project: Project, checkCopy?: ProjectCopyCheck): ProjectConnection {
  const location = {localDir: project.localDir, cacheDir: project.cacheDir, tempDir: project.tempDir};
  return openProjectConnection({projectFile: project.projectFile, locate: () => location, checkCopy});
}
/** A project file that has been opened once (so its local records and cache
 * exist) and has its project row. */
function newProject(t: TestContext): {project: Project; projectId: string} {
  const project = layout(scratch(t));
  const projectId = createProjectFile(project.projectFile);
  const connection = open(project);
  connection.db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId, '{}');
  connection.close();
  return {project, projectId};
}
/** The AppError `action` throws. A connection it returns instead is closed.
 * A PROJECT_INVALID reason must be one the contract lists. */
function appError(action: () => unknown): AppError {
  let result: unknown;
  try {
    result = action();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    if (error.code === 'PROJECT_INVALID') {
      const {reason} = error.details as {reason: (typeof PROJECT_INVALID_REASONS)[number]};
      assert.ok(PROJECT_INVALID_REASONS.includes(reason), `reason ${String(reason)} is in PROJECT_INVALID_REASONS`);
    }
    return error;
  }
  (result as {close?: () => void} | undefined)?.close?.();
  assert.fail('expected an AppError');
}
/** Only for files no connection of this process holds: closing a descriptor of
 * a held file would drop SQLite's POSIX locks on it. */
const digest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const plain = (row: object | undefined): object | undefined => row === undefined ? undefined : {...row};
const pragma = (db: DatabaseSync, name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
const sequences = (db: DatabaseSync) => ({
  file: Number(db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence),
  seen: Number(db.prepare('SELECT seenContentSequence FROM main.history_state').get()?.seenContentSequence),
});
const addShot = (connection: ProjectConnection): void => {
  connection.db.prepare('INSERT INTO shots(id,projectId,data) VALUES(?,?,?)').run(randomUUID(), connection.projectId, '{}');
};

/** A connection in the kernel's layout without its checks and temporary
 * triggers, for changing files that no store has open. */
function tamper(project: Project, change: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(project.historyFile);
  try {
    db.prepare('ATTACH DATABASE ? AS project').run(project.projectFile);
    db.prepare('ATTACH DATABASE ? AS cache').run(project.cacheFile);
    change(db);
  } finally {
    db.close();
  }
}
/** Runs `change` while one of the file's own triggers is dropped, then puts the
 * trigger back with its stored text. */
function withoutTrigger(db: DatabaseSync, schema: string, name: string, change: () => void): void {
  const sql = String(db.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type='trigger' AND name=?`).get(name)?.sql);
  db.exec(`DROP TRIGGER ${schema}.${name}`);
  change();
  db.exec(sql.replace(/^CREATE TRIGGER /, `CREATE TRIGGER ${schema}.`));
}

function childEnv(mode: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env, ...extra, MODE: mode};
  if (!('ROOT' in extra)) delete env.ROOT;
  return env;
}
const projectEnv = (project: Project): Record<string, string> => ({
  PROJECT_FILE: project.projectFile, LOCAL_DIR: project.localDir, CACHE_DIR: project.cacheDir, TEMP_DIR: project.tempDir,
});
function child(mode: 'open-report' | 'raw-read', extra: Record<string, string>): Record<string, unknown> {
  const result = spawnSync(process.execPath, [CHILD], {cwd: REPOSITORY, env: childEnv(mode, extra), encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
}
async function holdInChild(t: TestContext, project: Project): Promise<ChildProcess> {
  const holder = spawn(process.execPath, [CHILD], {cwd: REPOSITORY, env: childEnv('open-hold', projectEnv(project)), stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  holder.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; if (stdout.includes('ready\n')) resolve(); });
    holder.once('error', reject);
    holder.once('exit', code => reject(new Error(`the holding process exited with ${String(code)}: ${stderr}`)));
  });
  return holder;
}
const LOCKED_READ = {ok: false, message: 'database is locked', errcode: 5};

// ---------------------------------------------------------------------------
// Creating

test('createProjectFile publishes a complete project file and never replaces anything', t => {
  const root = scratch(t);
  const file = path.join(root, 'Film.mioon');
  const projectId = randomUUID();
  assert.equal(createProjectFile(file, {projectId}), projectId);
  assert.deepEqual(readdirSync(root), ['Film.mioon'], 'no temporary file or journal is left behind');
  const db = new DatabaseSync(file, {readOnly: true});
  assert.deepEqual(plain(db.prepare('SELECT * FROM project_file').get()), {singleton: 1, projectId, contentSequence: 0});
  assert.equal(pragma(db, 'application_id'), PROJECT_FILE_APPLICATION_ID);
  assert.equal(pragma(db, 'journal_mode'), 'delete');
  assert.deepEqual(readSchemaManifest(db, 'main'), SCHEMA_MANIFEST.project.entries);
  assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get()?.n, 0);
  db.close();

  const before = digest(file);
  for (const target of [file, root]) {
    const error = appError(() => createProjectFile(target));
    assert.equal(error.code, 'PROJECT_FILE_EXISTS');
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, {database: 'project', reason: 'exists'});
  }
  assert.equal(digest(file), before);
  assert.deepEqual(readdirSync(root), ['Film.mioon']);
  assert.throws(() => createProjectFile(path.join(root, 'Other.mioon'), {projectId: 'C0FFEE00-0000-4000-8000-000000000000'}), TypeError);
  assert.equal(existsSync(path.join(root, 'Other.mioon')), false);
  assert.ok(isProjectId(createProjectFile(path.join(root, 'Other.mioon'))));
});

// ---------------------------------------------------------------------------
// The connection

test('the local records are main, the project file and the cache are attached, with the kernel settings read back', t => {
  const {project, projectId} = newProject(t);
  const connection = open(project);
  t.after(() => connection.close());
  const {db} = connection;
  assert.deepEqual({
    projectId: connection.projectId, projectFile: connection.projectFile, projectDir: connection.projectDir,
    localDir: connection.localDir, cacheDir: connection.cacheDir, tempDir: connection.tempDir, historyState: connection.historyState,
  }, {
    projectId, projectFile: project.projectFile, projectDir: project.root,
    localDir: project.localDir, cacheDir: project.cacheDir, tempDir: project.tempDir, historyState: 'current',
  });
  assert.deepEqual(db.prepare('PRAGMA database_list').all().filter(row => row.name !== 'temp').map(row => [row.name, row.file]),
    [['main', project.historyFile], ['project', project.projectFile], ['cache', project.cacheFile]]);
  for (const schema of ['main', 'project', 'cache']) {
    assert.equal(pragma(db, `${schema}.journal_mode`), 'delete', schema);
    assert.equal(pragma(db, `${schema}.locking_mode`), 'exclusive', schema);
    assert.equal(pragma(db, `${schema}.synchronous`), 2, schema);
    assert.equal(pragma(db, `${schema}.journal_size_limit`), PROJECT_JOURNAL_SIZE_LIMIT, schema);
  }
  assert.equal(PROJECT_JOURNAL_SIZE_LIMIT, 0);
  assert.equal(pragma(db, 'foreign_keys'), 1);
  assert.equal(pragma(db, 'trusted_schema'), 0);
  assert.equal(pragma(db, 'busy_timeout'), 0);
  assert.equal(pragma(db, 'cell_size_check'), 1);
  assert.equal(pragma(db, 'main.application_id'), HISTORY_APPLICATION_ID);
  assert.equal(pragma(db, 'project.application_id'), PROJECT_FILE_APPLICATION_ID);
  assert.equal(pragma(db, 'cache.application_id'), CACHE_APPLICATION_ID);
  assert.equal(db.prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE type='trigger'").get()?.n, crossFileTriggerStatements().length);
  assert.throws(() => db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(randomUUID(), randomUUID(), '{}'), {message: 'FOREIGN KEY constraint failed'});
  // A commit to the project file alone leaves its journal at 0 bytes.
  addShot(connection);
  assert.equal(statSync(`${project.projectFile}-journal`).size, 0);
});

test('another process cannot read an open project and fails to open it at once', t => {
  const {project} = newProject(t);
  const connection = open(project);
  t.after(() => connection.close());
  for (const file of [project.projectFile, project.historyFile, project.cacheFile]) {
    assert.deepEqual(child('raw-read', {FILE: file}), LOCKED_READ, file);
  }
  const report = child('open-report', projectEnv(project));
  assert.equal(report.ok, false);
  assert.equal(report.code, 'PROJECT_LOCKED');
  assert.deepEqual(report.details, {database: 'project', reason: 'locked'});
  assert.ok(Number(report.elapsedMs) < 5000, `the open took ${String(report.elapsedMs)} ms`);
});

test('a second open in the same process is PROJECT_LOCKED and keeps the first one locked', t => {
  const {project} = newProject(t);
  const first = open(project);
  t.after(() => first.close());
  const error = appError(() => open(project));
  assert.equal(error.code, 'PROJECT_LOCKED');
  assert.equal(error.status, 409);
  assert.deepEqual(error.details, {database: 'project', reason: 'locked'});
  const linked = path.join(project.root, 'linked.mioon');
  linkSync(project.projectFile, linked);
  assert.equal(appError(() => open(withFile(project, linked))).code, 'PROJECT_LOCKED');
  for (const file of [project.historyFile, project.cacheFile]) {
    assert.deepEqual(appError(() => open(withFile(project, file))).details, {database: 'project', reason: 'not-a-project-file'});
  }
  // None of these opened and closed a descriptor of a held file.
  for (const file of [project.projectFile, project.historyFile, project.cacheFile]) {
    assert.deepEqual(child('raw-read', {FILE: file}), LOCKED_READ, file);
  }
  first.close();
  const again = open(project);
  assert.equal(again.historyState, 'current');
  again.close();
  assert.deepEqual({...child('open-report', projectEnv(project)), elapsedMs: 0},
    {ok: true, projectId: first.projectId, historyState: 'current', elapsedMs: 0});
});

test('a project another process holds opens once that process closes it', async t => {
  const {project} = newProject(t);
  const holder = await holdInChild(t, project);
  const error = appError(() => open(project));
  assert.equal(error.code, 'PROJECT_LOCKED');
  assert.deepEqual(error.details, {database: 'project', reason: 'locked'});
  const exited = new Promise(resolve => holder.once('close', resolve));
  holder.kill('SIGTERM');
  await exited;
  const connection = open(project);
  assert.equal(connection.historyState, 'current');
  connection.close();
});

test('a copy with the same project ID cannot use the local records while the original is open', t => {
  const {project, projectId} = newProject(t);
  const copyDir = scratch(t);
  const copy = {...withFile(project, path.join(copyDir, 'copy.mioon')), root: copyDir};
  copyFileSync(project.projectFile, copy.projectFile);
  const original = open(project);
  t.after(() => original.close());
  const error = appError(() => open(copy));
  assert.equal(error.code, 'PROJECT_LOCKED');
  assert.deepEqual(error.details, {database: 'history', reason: 'locked', projectId});
  assert.deepEqual(child('raw-read', {FILE: project.historyFile}), LOCKED_READ);
  original.close();
  const reopened = open(copy);
  assert.equal(reopened.historyState, 'current');
  reopened.close();
});

// ---------------------------------------------------------------------------
// Files that cannot be opened

test('a missing project file is PROJECT_MISSING', t => {
  const root = scratch(t);
  writeFileSync(path.join(root, 'plain-file'), 'x');
  for (const file of [path.join(root, 'none.mioon'), path.join(root, 'no-folder', 'none.mioon'), path.join(root, 'plain-file', 'none.mioon')]) {
    const error = appError(() => open(withFile(layout(root), file)));
    assert.equal(error.code, 'PROJECT_MISSING', file);
    assert.equal(error.status, 404);
    assert.deepEqual(error.details, {database: 'project', reason: 'missing'});
  }
  assert.equal(existsSync(path.join(root, '.mioon-store')), false);
});

test('files that are not project files are PROJECT_INVALID and leave the local records alone', t => {
  const {project} = newProject(t);
  const history = digest(project.historyFile), projectBytes = digest(project.projectFile);
  const other = scratch(t);
  const file = (name: string, write: (target: string) => void): string => {
    const target = path.join(other, name);
    write(target);
    return target;
  };
  const sqlite = (target: string, setup: string): void => {
    const db = new DatabaseSync(target);
    db.exec(setup);
    db.close();
  };
  const cases: readonly (readonly [string, string, string])[] = [
    ['text', 'not-a-project-file', file('notes.mioon', target => writeFileSync(target, 'Mioon project notes\n'.repeat(20)))],
    ['short text', 'not-a-project-file', file('short.mioon', target => writeFileSync(target, 'hi'))],
    ['empty', 'not-a-project-file', file('empty.mioon', target => writeFileSync(target, ''))],
    ['other SQLite database', 'not-a-project-file', file('other.mioon', target => sqlite(target, 'CREATE TABLE t(x)'))],
    ['history.db', 'not-a-project-file', project.historyFile],
    ['cache.db', 'not-a-project-file', project.cacheFile],
    ['SQLite database with the project application_id only', 'schema-version', file('header.mioon', target => sqlite(target, `PRAGMA application_id=${PROJECT_FILE_APPLICATION_ID}; CREATE TABLE t(x)`))],
    ['symbolic link', 'not-a-regular-file', file('link.mioon', target => symlinkSync(project.projectFile, target))],
    ['directory', 'not-a-regular-file', file('folder.mioon', target => mkdirSync(target))],
  ];
  for (const [name, reason, target] of cases) {
    const error = appError(() => open(withFile(project, target)));
    assert.equal(error.code, 'PROJECT_INVALID', name);
    assert.equal(error.status, 422);
    assert.deepEqual(error.details, {database: 'project', reason}, name);
  }
  assert.equal(digest(project.historyFile), history);
  assert.equal(digest(project.projectFile), projectBytes);
});

const NO_PERMISSIONS = process.platform === 'win32' ? 'POSIX permissions only'
  : process.getuid?.() === 0 ? 'root ignores file permissions' : false;
test('a read-only project file, or a folder where its journal cannot be created, is PROJECT_INVALID with reason read-only', {skip: NO_PERMISSIONS}, t => {
  const {project, projectId} = newProject(t);
  const projectBytes = digest(project.projectFile), history = digest(project.historyFile);
  // Both pass every check: the last step of the open, a change to page 1 that
  // is rolled back, is the first write. SQLite opens a 0444 file read-only and
  // refuses the write (SQLITE_READONLY); in a 0555 folder it cannot create the
  // journal (SQLITE_READONLY_DIRECTORY).
  for (const [target, mode] of [[project.projectFile, 0o444], [project.root, 0o555]] as const) {
    const restore = statSync(target).mode & 0o777;
    chmodSync(target, mode);
    try {
      const error = appError(() => open(project));
      assert.equal(error.code, 'PROJECT_INVALID');
      assert.equal(error.status, 422);
      assert.deepEqual(error.details, {database: 'project', reason: 'read-only', projectId}, mode.toString(8));
      assert.deepEqual(readdirSync(project.root).sort(), ['.mioon-store', 'project.mioon']);
    } finally {
      chmodSync(target, restore);
    }
  }
  const connection = open(project);
  assert.equal(connection.historyState, 'current');
  connection.close();
  assert.equal(digest(project.projectFile), projectBytes);
  assert.equal(digest(project.historyFile), history);
});

const EXPLICIT_INDEX = SCHEMA_MANIFEST.project.entries.find(entry => entry.type === 'index' && !entry.name.startsWith('sqlite_autoindex_'))!.name;
const PROJECT_TAMPERING: readonly {
  readonly name: string;
  readonly details: (projectId: string) => object;
  readonly change: (db: DatabaseSync) => void;
}[] = [
  {name: 'an added trigger', details: () => ({database: 'project', reason: 'schema', differences: ['unexpected trigger:zz_added']}),
    change: db => db.exec('CREATE TRIGGER project.zz_added AFTER INSERT ON shots BEGIN SELECT 1;END')},
  {name: 'a dropped index', details: () => ({database: 'project', reason: 'schema', differences: [`missing index:${EXPLICIT_INDEX}`]}),
    change: db => db.exec(`DROP INDEX project.${EXPLICIT_INDEX}`)},
  {name: 'a changed trigger', details: () => ({database: 'project', reason: 'schema', differences: ['changed trigger:immutable_versions']}),
    change: db => {
      db.exec('DROP TRIGGER project.immutable_versions');
      db.exec("CREATE TRIGGER project.immutable_versions BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'versions may change');END");
    }},
  {name: 'an added view', details: () => ({database: 'project', reason: 'schema', differences: ['unexpected view:zz_view']}),
    change: db => db.exec('CREATE VIEW project.zz_view AS SELECT id FROM shots')},
  {name: 'an added column', details: () => ({database: 'project', reason: 'schema', differences: ['changed table:shots']}),
    change: db => db.exec('ALTER TABLE project.shots ADD COLUMN zz TEXT')},
  {name: 'a replaced schema_version table', details: () => ({database: 'project', reason: 'schema-version'}),
    change: db => db.exec('DROP TABLE project.schema_version; CREATE TABLE project.schema_version(version INTEGER PRIMARY KEY,note TEXT); INSERT INTO project.schema_version(version) VALUES(1)')},
  {name: 'a second project row', details: projectId => ({database: 'project', reason: 'project-row', projectId}),
    change: db => withoutTrigger(db, 'project', 'project_file_single_project_insert', () => {
      db.prepare('INSERT INTO project.projects(id,data) VALUES(?,?)').run(randomUUID(), '{}');
    })},
  {name: 'a deleted metadata row', details: () => ({database: 'project', reason: 'metadata'}),
    change: db => withoutTrigger(db, 'project', 'project_file_guard_delete', () => db.exec('DELETE FROM project.project_file'))},
  {name: 'a row that breaks a foreign key', details: projectId => ({database: 'project', reason: 'foreign-key', projectId}),
    change: db => {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare('INSERT INTO project.shots(id,projectId,data) VALUES(?,?,?)').run(randomUUID(), randomUUID(), '{}');
    }},
  {name: 'WAL mode', details: () => ({database: 'project', reason: 'journal-mode'}),
    change: db => assert.equal(pragma(db, 'project.journal_mode=WAL'), 'wal')},
];

test('a changed project file is PROJECT_INVALID and leaves the local records alone', async t => {
  for (const tampering of PROJECT_TAMPERING) {
    await t.test(tampering.name, t => {
      const {project, projectId} = newProject(t);
      tamper(project, tampering.change);
      const history = digest(project.historyFile);
      const error = appError(() => open(project));
      assert.equal(error.code, 'PROJECT_INVALID');
      assert.deepEqual(error.details, tampering.details(projectId));
      assert.equal(digest(project.historyFile), history);
    });
  }
});

test('a project file from a newer format is PROJECT_FORMAT_NEWER and stays byte for byte', t => {
  const {project} = newProject(t);
  tamper(project, db => db.exec('INSERT INTO project.schema_version VALUES(2)'));
  const projectBytes = digest(project.projectFile), history = digest(project.historyFile);
  const error = appError(() => open(project));
  assert.equal(error.code, 'PROJECT_FORMAT_NEWER');
  assert.equal(error.status, 409);
  assert.deepEqual(error.details, {database: 'project', reason: 'format-newer', formatVersion: 2, supportedFormatVersion: 1});
  assert.equal(digest(project.projectFile), projectBytes);
  assert.equal(digest(project.historyFile), history);
  assert.equal(existsSync(`${project.projectFile}-journal`), false);
});

test('local records with another structure, a newer format or another project fail the open', t => {
  const changed = newProject(t);
  tamper(changed.project, db => db.exec('CREATE TABLE main.zz_extra(x)'));
  let projectBytes = digest(changed.project.projectFile);
  let error = appError(() => open(changed.project));
  assert.equal(error.code, 'PROJECT_INVALID');
  assert.deepEqual(error.details, {database: 'history', reason: 'schema', projectId: changed.projectId, differences: ['unexpected table:zz_extra']});
  assert.equal(digest(changed.project.projectFile), projectBytes);

  const newer = newProject(t);
  tamper(newer.project, db => db.exec(`INSERT INTO main.schema_version VALUES(${HISTORY_SCHEMA_VERSION + 1})`));
  projectBytes = digest(newer.project.projectFile);
  const history = digest(newer.project.historyFile);
  error = appError(() => open(newer.project));
  assert.equal(error.code, 'PROJECT_FORMAT_NEWER');
  assert.deepEqual(error.details, {database: 'history', reason: 'format-newer', projectId: newer.projectId, formatVersion: HISTORY_SCHEMA_VERSION + 1, supportedFormatVersion: HISTORY_SCHEMA_VERSION});
  assert.equal(digest(newer.project.projectFile), projectBytes);
  assert.equal(digest(newer.project.historyFile), history);

  const mine = newProject(t), theirs = newProject(t);
  error = appError(() => open({...theirs.project, root: mine.project.root, projectFile: mine.project.projectFile}));
  assert.equal(error.code, 'PROJECT_INVALID');
  assert.deepEqual(error.details, {database: 'history', reason: 'project-mismatch', projectId: mine.projectId});
});

test('a cache that does not match is rebuilt and the open goes on', async t => {
  const cases: readonly (readonly [string, (project: Project) => void])[] = [
    ['changed structure', project => tamper(project, db => db.exec('CREATE TABLE cache.zz_extra(x)'))],
    ['dropped index', project => tamper(project, db => {
      const index = SCHEMA_MANIFEST.cache.entries.find(entry => entry.type === 'index' && !entry.name.startsWith('sqlite_autoindex_'))!.name;
      db.exec(`DROP INDEX cache.${index}`);
    })],
    ['newer format', project => tamper(project, db => db.exec('INSERT INTO cache.schema_version VALUES(2)'))],
    ['other application_id', project => tamper(project, db => db.exec('PRAGMA cache.application_id=7'))],
    ['not a database', project => writeFileSync(project.cacheFile, 'not a database')],
  ];
  for (const [name, change] of cases) {
    await t.test(name, t => {
      const {project} = newProject(t);
      change(project);
      const connection = open(project);
      try {
        assert.equal(connection.historyState, 'current');
        assert.deepEqual(readSchemaManifest(connection.db, 'cache'), SCHEMA_MANIFEST.cache.entries);
        assert.deepEqual(connection.db.prepare('SELECT version FROM cache.schema_version').all().map(row => row.version), [1]);
        assert.equal(pragma(connection.db, 'cache.application_id'), CACHE_APPLICATION_ID);
      } finally {
        connection.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Local records state and copies

test('the local records state follows the content sequence: fresh, current, file-newer, file-older', t => {
  const project = layout(scratch(t));
  const projectId = createProjectFile(project.projectFile);
  let connection = open(project);
  assert.equal(connection.historyState, 'fresh');
  assert.deepEqual(sequences(connection.db), {file: 0, seen: 0});
  connection.db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId, '{}');
  const withProject = sequences(connection.db);
  assert.ok(withProject.file > 0);
  assert.equal(withProject.seen, withProject.file);
  connection.close();

  connection = open(project);
  assert.equal(connection.historyState, 'current');
  connection.close();

  // Writes to the local records alone leave the project file as it is.
  const projectBytes = digest(project.projectFile);
  connection = open(project);
  connection.db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,0)').run(projectId);
  connection.db.prepare("INSERT INTO idempotency VALUES('k1-open',?,'hash','resource')").run(randomUUID());
  assert.deepEqual(sequences(connection.db), withProject);
  connection.close();
  assert.equal(digest(project.projectFile), projectBytes);

  // Changed with other local records: newer than ours, and opening does not acknowledge it.
  const elsewhere = layout(project.root, scratch(t));
  connection = open(elsewhere);
  assert.equal(connection.historyState, 'fresh');
  addShot(connection);
  connection.close();
  for (let round = 0; round < 2; round++) {
    connection = open(project);
    assert.equal(connection.historyState, 'file-newer');
    connection.close();
  }

  // Replaced by an older copy: older than ours.
  const older = path.join(scratch(t), 'older.mioon');
  copyFileSync(project.projectFile, older);
  connection = open(project);
  addShot(connection);
  const latest = sequences(connection.db);
  assert.equal(latest.seen, latest.file);
  connection.close();
  copyFileSync(older, project.projectFile);
  connection = open(project);
  assert.equal(connection.historyState, 'file-older');
  connection.close();
});

test('the copy check sees the project ID before any local records exist and can stop the open', t => {
  const project = layout(scratch(t));
  const projectId = createProjectFile(project.projectFile);
  const calls: unknown[] = [];
  const refusal = new Error('copy refused');
  assert.throws(() => open(project, file => {
    calls.push({...file, localDir: existsSync(project.localDir), history: existsSync(project.historyFile)});
    throw refusal;
  }), error => error === refusal);
  assert.deepEqual(calls, [{projectId, projectFile: project.projectFile, localDir: false, history: false}]);
  assert.equal(existsSync(project.historyFile), false);
  assert.equal(existsSync(path.join(project.root, '.mioon-store')), false);
  assert.deepEqual(child('raw-read', {FILE: project.projectFile}), {ok: true}, 'the project file is not locked');
  const accepted: string[] = [];
  const connection = open(project, file => { accepted.push(file.projectId); });
  assert.equal(connection.historyState, 'fresh');
  connection.close();
  assert.deepEqual(accepted, [projectId]);
});

test('a project file holds only its own project', t => {
  const project = layout(scratch(t));
  const projectId = createProjectFile(project.projectFile);
  const connection = open(project);
  t.after(() => connection.close());
  const upsert = connection.db.prepare('INSERT INTO projects(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
  upsert.run(projectId, '{"name":"one"}');
  upsert.run(projectId, '{"name":"two"}');
  assert.throws(() => upsert.run(randomUUID(), '{}'), {message: PROJECT_FILE_SINGLE_PROJECT});
  assert.throws(() => connection.db.prepare('UPDATE projects SET id=? WHERE id=?').run(randomUUID(), projectId), {message: PROJECT_FILE_SINGLE_PROJECT});
  assert.deepEqual(connection.db.prepare('SELECT id,data FROM projects').all().map(plain), [{id: projectId, data: '{"name":"two"}'}]);
});
