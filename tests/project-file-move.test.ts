// The project folder moved while the project is open (macOS and Linux; on
// Windows the open files keep it in place). SQLite opens a database's rollback
// journal for the first write after the database is opened and refuses that
// write with SQLITE_READONLY_DBMOVED (1032) once the file has been renamed; in
// exclusive locking mode it keeps the journal open from then on and does not
// check again. The kernel opens the project file's journal as the last step of
// an open, with a change to page 1 that it rolls back, so a later move does not
// stop the writes. Crashes after such a move are in project-file-crash.test.ts.
// The .mioon renamed or moved without its folder leaves that journal under the
// old name, where a crash would not find it: store.tx and put then throw
// PROJECT_FILE_MOVED before they write.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {PROJECT_FILE_MOVED} from '../packages/contracts/src/project-file.ts';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/index.ts';
import type {ProjectLocation, ProjectStore} from '../packages/business/src/project-file/index.ts';

interface Project extends ProjectLocation {
  readonly base: string;
  readonly projectFile: string;
}
/** `<base>/Film/project.mioon` with this computer's directories in `<base>/app/`,
 * holding its project row, closed. */
function newProject(t: TestContext): Project {
  const base = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-s0a-move-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  mkdirSync(path.join(base, 'Film'));
  const app = path.join(base, 'app');
  const project: Project = {
    base, projectFile: path.join(base, 'Film', 'project.mioon'),
    localDir: path.join(app, 'local'), cacheDir: path.join(app, 'cache'), tempDir: path.join(app, 'tmp'),
  };
  const store = createProjectStore({projectFile: project.projectFile, locate: () => project});
  try {
    store.put('projects', {id: store.projectId, name: 'S0a move'});
  } finally {
    store.close();
  }
  return project;
}
const open = (project: Project, projectFile = project.projectFile): ProjectStore => openProjectStore({projectFile, locate: () => project});

/** sha256 of a file, read by another process: reading a file this process
 * holds open would drop SQLite's POSIX locks on it. */
function digestElsewhere(file: string): string {
  const script = "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))";
  const result = spawnSync(process.execPath, ['-e', script, file], {encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
/** Size and modification time, by stat: it does not open the file. */
function stampOf(file: string): string {
  const info = statSync(file, {bigint: true});
  return `${info.size}:${info.mtimeNs}`;
}
/** Entry names and sizes of a directory, by stat. */
const entries = (directory: string): string[] => readdirSync(directory).sort().map(name => `${name}:${statSync(path.join(directory, name)).size}`);
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50));
const shotCount = (store: ProjectStore): number => Number(store.db.prepare('SELECT count(*) AS n FROM project.shots').get()?.n);
const contentSequence = (store: ProjectStore): number => Number(store.db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence);
/** A write to the local records alone: a receipt in history.db. */
const addReceipt = (store: ProjectStore): void => {
  store.db.prepare("INSERT INTO idempotency VALUES('s0a-2-moved',?,'hash','resource')").run(randomUUID());
};
const receiptCount = (store: ProjectStore): number => Number(store.db.prepare("SELECT count(*) AS n FROM main.idempotency WHERE scope='s0a-2-moved'").get()?.n);
/** The contract's PROJECT_FILE_MOVED, as the project host's projectFileMoved builds it. */
function refusedAsMoved(write: () => unknown, projectId: string): void {
  assert.throws(write, (error: unknown) => {
    assert.ok(error instanceof AppError, String(error));
    assert.deepEqual({code: error.code, status: error.status, details: error.details}, {code: PROJECT_FILE_MOVED, status: 409, details: {projectId}});
    return true;
  });
}

test('SQLite refuses the first write after the database file moved, unless its journal is open already', t => {
  // The mechanism on a plain database with the kernel's locking and journal settings.
  const base = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-s0a-dbmoved-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const attempt = (name: string, openJournal: boolean): unknown => {
    const folder = path.join(base, name);
    mkdirSync(folder);
    const file = path.join(folder, 'film.db');
    const setup = new DatabaseSync(file);
    setup.exec('PRAGMA journal_mode=DELETE; CREATE TABLE t(x); INSERT INTO t VALUES(1)');
    setup.close();
    const db = new DatabaseSync(file, {timeout: 0});
    try {
      db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; PRAGMA journal_size_limit=0');
      if (openJournal) db.exec('BEGIN; PRAGMA user_version=0; ROLLBACK');
      renameSync(folder, `${folder}-moved`);
      try {
        db.exec('INSERT INTO t VALUES(2)');
        return 'written';
      } catch (error) {
        return (error as {errcode?: unknown}).errcode;
      }
    } finally {
      db.close();
    }
  };
  assert.equal(attempt('plain', false), 1032, 'SQLITE_READONLY_DBMOVED');
  assert.equal(attempt('journal-open', true), 'written');
});

test('opening keeps the project file\'s journal open and leaves the file\'s bytes and modification time as they were', async t => {
  const project = newProject(t);
  const directory = path.dirname(project.projectFile);
  const digest = digestElsewhere(project.projectFile), stamp = stampOf(project.projectFile);
  assert.deepEqual(entries(directory), [`project.mioon:${statSync(project.projectFile).size}`]);
  // A write in the same clock tick would keep the time: wait past it.
  await settle();
  const store = open(project);
  try {
    assert.equal(digestElsewhere(project.projectFile), digest);
    assert.equal(stampOf(project.projectFile), stamp);
    assert.deepEqual(entries(directory), [`project.mioon:${statSync(project.projectFile).size}`, 'project.mioon-journal:0']);
    assert.equal(store.db.prepare('PRAGMA project.user_version').get()?.user_version, 0);
  } finally {
    store.close();
  }
  assert.equal(digestElsewhere(project.projectFile), digest);
  assert.equal(stampOf(project.projectFile), stamp);
  assert.deepEqual(readdirSync(directory), ['project.mioon'], 'closing deletes the journal');
});

test('the project folder moved after the open: writes go on, and the project reopens from the new place with them', t => {
  const project = newProject(t);
  const directory = path.dirname(project.projectFile);
  const movedDirectory = `${directory}-moved`, movedFile = path.join(movedDirectory, path.basename(project.projectFile));
  const store = open(project);
  const {projectId} = store;
  const shot = {id: randomUUID(), projectId, title: 'Written after the move'};
  try {
    // Nothing has written the project file since the open. The journal moved
    // with the folder, so tx and put do not take this for a moved .mioon.
    renameSync(directory, movedDirectory);
    store.tx(() => store.put('shots', shot));
    store.tx(() => store.db.prepare("INSERT INTO idempotency VALUES('s0a-move',?,'hash','resource')").run(randomUUID()));
    store.put('shots', {...shot, title: 'Renamed after the move'});
    assert.equal(shotCount(store), 1);
  } finally {
    store.close();
  }
  // SQLite deletes the journal by the path it opened it with, which no longer
  // exists; the emptied journal stays beside the moved project file.
  assert.equal(existsSync(directory), false);
  assert.deepEqual(entries(movedDirectory), [`project.mioon:${statSync(movedFile).size}`, 'project.mioon-journal:0']);
  const reopened = open(project, movedFile);
  try {
    assert.equal(reopened.historyState, 'current');
    assert.deepEqual(reopened.get('shots', shot.id), {...shot, title: 'Renamed after the move'});
    assert.equal(Number(reopened.db.prepare("SELECT count(*) AS n FROM main.idempotency WHERE scope='s0a-move'").get()?.n), 1);
  } finally {
    reopened.close();
  }
  assert.deepEqual(readdirSync(movedDirectory), ['project.mioon'], 'the next open and close at the new place removes it');
});

test('the .mioon renamed in its folder while open: tx and put throw PROJECT_FILE_MOVED and write nothing to either file', t => {
  const project = newProject(t);
  const directory = path.dirname(project.projectFile), renamed = path.join(directory, 'renamed.mioon');
  const historyFile = path.join(project.localDir, 'history.db');
  const store = open(project);
  const {projectId} = store;
  const shot = {id: randomUUID(), projectId, title: 'Refused'};
  try {
    const before = {project: digestElsewhere(project.projectFile), history: digestElsewhere(historyFile), sequence: contentSequence(store)};
    renameSync(project.projectFile, renamed);
    // SQLite keeps the journal under the name the file was opened with.
    assert.deepEqual(entries(directory), ['project.mioon-journal:0', `renamed.mioon:${statSync(renamed).size}`]);
    refusedAsMoved(() => store.tx(() => store.put('shots', shot)), projectId);
    // A put outside a transaction, and a transaction of local records alone.
    refusedAsMoved(() => store.put('shots', shot), projectId);
    refusedAsMoved(() => store.tx(() => addReceipt(store)), projectId);
    // Another file at the opened path is not the file that was opened.
    writeFileSync(project.projectFile, 'not the project file');
    refusedAsMoved(() => store.put('shots', shot), projectId);
    refusedAsMoved(() => store.tx(() => addReceipt(store)), projectId);
    assert.equal(store.db.isTransaction, false);
    assert.equal(shotCount(store), 0);
    assert.equal(receiptCount(store), 0);
    assert.deepEqual({project: digestElsewhere(renamed), history: digestElsewhere(historyFile), sequence: contentSequence(store)}, before);
  } finally {
    store.close();
  }
  // Closing deleted the journal under the opened path.
  assert.deepEqual(readdirSync(directory).sort(), ['project.mioon', 'renamed.mioon']);
  const reopened = open(project, renamed);
  try {
    assert.equal(reopened.historyState, 'current');
    assert.equal(reopened.get('shots', shot.id), null);
    assert.equal(receiptCount(reopened), 0);
  } finally {
    reopened.close();
  }
});

test('the .mioon moved alone to another folder while open: writes are refused until it is back in place, then they go on', t => {
  const project = newProject(t);
  const directory = path.dirname(project.projectFile), elsewhere = path.join(project.base, 'Elsewhere');
  mkdirSync(elsewhere);
  const moved = path.join(elsewhere, path.basename(project.projectFile));
  const store = open(project);
  const {projectId} = store;
  const refused = {id: randomUUID(), projectId, title: 'Refused'}, written = {id: randomUUID(), projectId, title: 'Written once back in place'};
  try {
    renameSync(project.projectFile, moved);
    assert.deepEqual(entries(directory), ['project.mioon-journal:0']);
    refusedAsMoved(() => store.tx(() => store.put('shots', refused)), projectId);
    refusedAsMoved(() => store.put('shots', refused), projectId);
    refusedAsMoved(() => store.tx(() => addReceipt(store)), projectId);
    assert.equal(shotCount(store), 0);
    // Back under the opened path, beside its journal.
    renameSync(moved, project.projectFile);
    store.tx(() => store.put('shots', written));
    store.put('shots', {...written, title: 'Renamed once back in place'});
    store.tx(() => addReceipt(store));
  } finally {
    store.close();
  }
  assert.deepEqual(readdirSync(elsewhere), []);
  const reopened = open(project);
  try {
    assert.equal(reopened.get('shots', refused.id), null);
    assert.deepEqual(reopened.get('shots', written.id), {...written, title: 'Renamed once back in place'});
    assert.equal(shotCount(reopened), 1);
    assert.equal(receiptCount(reopened), 1);
  } finally {
    reopened.close();
  }
});
