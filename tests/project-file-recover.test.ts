// recoverProjectFile: step 1 of the opening order alone, for projects that are
// not open (at startup and when listing recent projects). It rolls back a hot
// journal beside the project file and does nothing else. A crash in the
// middle of a commit that spans both files, recovered and then copied without
// the local records, is in project-file-crash.test.ts.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createProjectStore, openProjectStore, PROJECT_FILE_APPLICATION_ID, recoverProjectFile} from '../packages/business/src/project-file/index.ts';
import type {ProjectLocation} from '../packages/business/src/project-file/index.ts';
import {isHotJournal} from '../packages/business/src/project-file/journals.ts';
import {addCrashProject, crashPad, readCrashRows, writeCrashRows} from './helpers/project-file-crash-data.ts';

const CHILD = fileURLToPath(new URL('./helpers/project-file-child.ts', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
const NO_PERMISSIONS = process.platform === 'win32' ? 'POSIX permissions only'
  : process.getuid?.() === 0 ? 'root ignores file permissions' : false;

interface Project extends ProjectLocation {
  readonly projectFile: string;
  readonly historyFile: string;
}
/** `<base>/Film/project.mioon` with this computer's directories in
 * `<base>/app/`, holding k = 1 as the crash tests write it, closed. */
function newProject(t: TestContext): Project {
  const base = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-s0a-recover-'));
  t.after(() => {
    chmodSync(path.join(base, 'Film'), 0o700);
    rmSync(base, {recursive: true, force: true});
  });
  mkdirSync(path.join(base, 'Film'));
  const app = path.join(base, 'app');
  const project: Project = {
    projectFile: path.join(base, 'Film', 'project.mioon'), historyFile: path.join(app, 'local', 'history.db'),
    localDir: path.join(app, 'local'), cacheDir: path.join(app, 'cache'), tempDir: path.join(app, 'tmp'),
  };
  const store = createProjectStore({projectFile: project.projectFile, locate: () => project});
  try {
    store.tx(() => {
      addCrashProject(store);
      writeCrashRows(store, 1, crashPad(1, 1024));
    });
  } finally {
    store.close();
  }
  return project;
}

function childEnv(mode: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env, ...extra, MODE: mode, PAYLOAD_MIB: '1'};
  delete env.ROOT;
  delete env.MOVED_PROJECT_FILE;
  return env;
}
const projectEnv = (project: Project): Record<string, string> => ({
  PROJECT_FILE: project.projectFile, LOCAL_DIR: project.localDir, CACHE_DIR: project.cacheDir, TEMP_DIR: project.tempDir,
});
/** What another process reads from a file with a plain SQLite connection. */
function rawRead(file: string): unknown {
  const result = spawnSync(process.execPath, [CHILD], {cwd: REPOSITORY, env: childEnv('raw-read', {FILE: file}), encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
}
const LOCKED_READ = {ok: false, message: 'database is locked', errcode: 5};
/** sha256 and stat of a file, by another process (the file may be held here). */
function fileState(file: string): string {
  const script = "const fs=require('node:fs');const s=fs.statSync(process.argv[1],{bigint:true});process.stdout.write(require('node:crypto').createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex')+':'+s.size+':'+s.mtimeNs)";
  const result = spawnSync(process.execPath, ['-e', script, file], {encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Another process with the project open: idle (open-hold), or in the middle of
 * a transaction it has spilled into both files (mid-transaction), until killed. */
async function holdInChild(t: TestContext, project: Project, mode: 'open-hold' | 'mid-transaction'): Promise<ChildProcess> {
  const holder = spawn(process.execPath, [CHILD], {cwd: REPOSITORY, env: childEnv(mode, projectEnv(project)), stdio: ['ignore', 'pipe', 'pipe']});
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
const killed = async (holder: ChildProcess): Promise<void> => {
  const closed = new Promise(resolve => holder.once('close', resolve));
  holder.kill('SIGKILL');
  await closed;
};

test('a project file without a hot journal is clean and stays as it is', t => {
  const project = newProject(t);
  const before = fileState(project.projectFile);
  assert.deepEqual(recoverProjectFile(project.projectFile), {state: 'clean'});
  assert.deepEqual(readdirSync(path.dirname(project.projectFile)), ['project.mioon']);
  // A journal SQLite emptied (left beside a project moved while open) is not hot either,
  // nor is one whose header is still zero.
  for (const journal of [Buffer.alloc(0), Buffer.alloc(512)]) {
    writeFileSync(`${project.projectFile}-journal`, journal);
    assert.deepEqual(recoverProjectFile(project.projectFile), {state: 'clean'});
    assert.equal(statSync(`${project.projectFile}-journal`).size, journal.length);
  }
  assert.equal(fileState(project.projectFile), before);
});

test('without a hot journal nothing of the project file is read: an unreadable one is clean, and its header is read only beside a hot journal', {skip: NO_PERMISSIONS}, t => {
  const project = newProject(t);
  const journal = `${project.projectFile}-journal`;
  const before = fileState(project.projectFile);
  // Write-only: any read of the file, its header included, fails with EACCES.
  chmodSync(project.projectFile, 0o200);
  try {
    assert.deepEqual(recoverProjectFile(project.projectFile), {state: 'clean'});
    writeFileSync(journal, '');
    assert.deepEqual(recoverProjectFile(project.projectFile), {state: 'clean'});
    // With a hot journal beside it the header is read, and the read fails.
    writeFileSync(journal, Buffer.concat([JOURNAL_MAGIC, Buffer.alloc(504, 1)]));
    assert.deepEqual(recoverProjectFile(project.projectFile), {state: 'invalid', reason: 'unusable'});
    rmSync(journal);
  } finally {
    chmodSync(project.projectFile, 0o644);
  }
  assert.equal(fileState(project.projectFile), before);
  assert.deepEqual(recoverProjectFile(project.projectFile), {state: 'clean'});
});

test('a project this process has open is recognised without touching its files', t => {
  const project = newProject(t);
  const store = openProjectStore({projectFile: project.projectFile, locate: () => project});
  t.after(() => store.close());
  const linked = path.join(path.dirname(project.projectFile), 'linked.mioon');
  linkSync(project.projectFile, linked);
  assert.deepEqual(recoverProjectFile(project.projectFile), {state: 'open-here'});
  assert.deepEqual(recoverProjectFile(linked), {state: 'open-here'});
  for (const file of [project.historyFile, path.join(project.cacheDir, 'cache.db')]) {
    assert.deepEqual(recoverProjectFile(file), {state: 'invalid', reason: 'not-a-project-file'});
  }
  // None of these opened and closed a descriptor of a held file: the locks stand.
  for (const file of [project.projectFile, project.historyFile]) assert.deepEqual(rawRead(file), LOCKED_READ, file);
  assert.equal(store.historyState, 'current');
});

test('a project another process holds: nothing to recover while it is idle, locked while it writes', async t => {
  const idle = newProject(t);
  const holder = await holdInChild(t, idle, 'open-hold');
  // The holder's journal is open but empty: not hot, so the file is not opened.
  assert.equal(statSync(`${idle.projectFile}-journal`).size, 0);
  assert.deepEqual(recoverProjectFile(idle.projectFile), {state: 'clean'});
  assert.deepEqual(rawRead(idle.projectFile), LOCKED_READ);
  await killed(holder);

  const busy = newProject(t);
  const writer = await holdInChild(t, busy, 'mid-transaction');
  // The writer spilled its transaction: its journal looks hot from outside, but
  // the writer's lock keeps SQLite from rolling it back.
  assert.equal(isHotJournal(`${busy.projectFile}-journal`), true);
  assert.deepEqual(recoverProjectFile(busy.projectFile), {state: 'locked'});
  assert.deepEqual(rawRead(busy.projectFile), LOCKED_READ, 'the writer still holds it');
  assert.equal(isHotJournal(`${busy.projectFile}-journal`), true);
  await killed(writer);
});

test('a missing path is missing; other files are clean without a hot journal and invalid beside one, which stays as it is', t => {
  const project = newProject(t);
  const other = path.dirname(project.projectFile);
  writeFileSync(path.join(other, 'plain-file'), 'x');
  for (const file of [path.join(other, 'none.mioon'), path.join(other, 'no-folder', 'none.mioon'), path.join(other, 'plain-file', 'none.mioon')]) {
    assert.deepEqual(recoverProjectFile(file), {state: 'missing'}, file);
  }
  mkdirSync(path.join(other, 'folder.mioon'));
  symlinkSync(project.projectFile, path.join(other, 'link.mioon'));
  writeFileSync(path.join(other, 'notes.mioon'), 'Mioon project notes\n'.repeat(20));
  const wal = path.join(other, 'wal.mioon');
  const db = new DatabaseSync(wal);
  db.exec(`PRAGMA application_id=${PROJECT_FILE_APPLICATION_ID}; PRAGMA journal_mode=WAL; CREATE TABLE t(x)`);
  db.close();
  const cases: readonly (readonly [string, string])[] = [
    [path.join(other, 'folder.mioon'), 'not-a-regular-file'], [path.join(other, 'link.mioon'), 'not-a-regular-file'],
    [path.join(other, 'notes.mioon'), 'not-a-project-file'], [wal, 'journal-mode'],
    // history.db is never opened on its own: SQLite would roll it back out of order.
    [project.historyFile, 'not-a-project-file'],
  ];
  // Without a hot journal the file itself is not read, so only the open finds it is no project file.
  for (const [file, reason] of cases) {
    assert.deepEqual(recoverProjectFile(file), reason === 'not-a-regular-file' ? {state: 'invalid', reason} : {state: 'clean'}, file);
  }
  for (const [file, reason] of cases) {
    const journal = Buffer.concat([JOURNAL_MAGIC, Buffer.alloc(504, 1)]);
    if (reason !== 'not-a-regular-file') writeFileSync(`${file}-journal`, journal);
    assert.deepEqual(recoverProjectFile(file), {state: 'invalid', reason}, file);
    if (reason !== 'not-a-regular-file') assert.deepEqual(statSync(`${file}-journal`).size, journal.length);
  }
});

test('a hot journal beside a read-only project file is reported as read-only, and recovered once it is writable', {skip: NO_PERMISSIONS}, async t => {
  const project = newProject(t);
  const writer = await holdInChild(t, project, 'mid-transaction');
  await killed(writer);
  assert.equal(isHotJournal(`${project.projectFile}-journal`), true);
  const before = fileState(project.projectFile);
  chmodSync(project.projectFile, 0o444);
  assert.deepEqual(recoverProjectFile(project.projectFile), {state: 'invalid', reason: 'read-only'});
  assert.equal(isHotJournal(`${project.projectFile}-journal`), true);
  assert.equal(fileState(project.projectFile), before);
  chmodSync(project.projectFile, 0o644);
  assert.deepEqual(recoverProjectFile(project.projectFile), {state: 'recovered'});
  assert.equal(isHotJournal(`${project.projectFile}-journal`), false);
  assert.deepEqual(recoverProjectFile(project.projectFile), {state: 'clean'});
  // The local records still have their own hot journal; the next open rolls them back.
  assert.equal(isHotJournal(`${project.historyFile}-journal`), true);
  const store = openProjectStore({projectFile: project.projectFile, locate: () => project});
  try {
    assert.deepEqual(readCrashRows(store.db, store.projectId), {content: 1, records: 1, receipt: 1, samePad: true});
    assert.equal(store.historyState, 'current');
    for (const schema of ['main', 'project', 'cache']) {
      assert.deepEqual(store.db.prepare(`PRAGMA ${schema}.integrity_check`).all().map(row => row.integrity_check), ['ok'], schema);
    }
  } finally {
    store.close();
  }
});
