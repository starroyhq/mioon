// SIGKILL during a store transaction that writes the project file and the
// local records together. A child process (helpers/project-file-child.ts)
// writes a counter k to both files and is killed at a chosen moment; the files
// it leaves behind are recorded, and the project is opened again through the
// kernel. The local records live outside the project directory, as on a user's
// computer: SQLite puts the super-journal of a commit that spans files next to
// the main database (history.db-mj…), so it stays in place when the project
// directory is moved after the crash.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import type {DatabaseSync} from 'node:sqlite';
import {PROJECT_HISTORY_FILE} from '../packages/contracts/src/project-file.ts';
import {createProjectStore, foreignKeyCheck, openProjectStore} from '../packages/business/src/project-file/index.ts';
import type {ProjectLocation} from '../packages/business/src/project-file/index.ts';
import {addCrashProject, crashPad, readCrashRows, writeCrashRows} from './helpers/project-file-crash-data.ts';
import type {CrashRows} from './helpers/project-file-crash-data.ts';

const CHILD = fileURLToPath(new URL('./helpers/project-file-child.ts', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
/** The first 8 bytes of a rollback journal once SQLite has synced its page
 * records and written its header: before that the header is zero. */
const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
const SUPER_JOURNAL_PREFIX = `${PROJECT_HISTORY_FILE}-mj`;
const BASELINE_PAD_BYTES = 1024;
const TIMEOUT = 300_000;

interface Project extends ProjectLocation {
  readonly projectFile: string;
}
/** A project in `<base>/Film/project.mioon` with this computer's directories
 * in `<base>/app/`, holding the project row and k = 1. */
function newProject(t: TestContext): Project {
  const base = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-k1-crash-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  mkdirSync(path.join(base, 'Film'));
  const app = path.join(base, 'app');
  const project: Project = {
    projectFile: path.join(base, 'Film', 'project.mioon'),
    localDir: path.join(app, 'local'), cacheDir: path.join(app, 'cache'), tempDir: path.join(app, 'tmp'),
  };
  const store = createProjectStore({projectFile: project.projectFile, locate: () => project});
  try {
    store.tx(() => {
      addCrashProject(store);
      writeCrashRows(store, 1, crashPad(1, BASELINE_PAD_BYTES));
    });
  } finally {
    store.close();
  }
  return project;
}
const historyFileOf = (project: Project): string => path.join(project.localDir, PROJECT_HISTORY_FILE);

// ---------------------------------------------------------------------------
// The files a killed commit leaves behind (read only while no connection of
// this process holds them)

/** Size and modification time of a database file. Outside a cache spill SQLite
 * writes a database file only while committing, so a new stamp means the
 * commit has started writing that file. (The change counter in the header
 * does not tell: in exclusive locking mode SQLite raises it only once.) */
function stampOf(file: string): string {
  const info = statSync(file, {bigint: true});
  return `${info.size}:${info.mtimeNs}`;
}
interface Stamps {
  readonly history: string;
  readonly project: string;
}
const stampsOf = (project: Project): Stamps => ({history: stampOf(historyFileOf(project)), project: stampOf(project.projectFile)});
const superJournals = (project: Project): string[] => readdirSync(project.localDir).filter(name => name.startsWith(SUPER_JOURNAL_PREFIX));

interface JournalScene {
  /** Size of `<database>-journal`, -1 when there is none. */
  readonly bytes: number;
  /** The journal header has been written: SQLite had synced this journal. */
  readonly magic: boolean;
  /** The database file was written after the last commit returned. */
  readonly fileChanged: boolean;
}
interface Scene {
  readonly superJournals: readonly {readonly name: string; readonly bytes: number}[];
  readonly history: JournalScene;
  readonly project: JournalScene;
}
function journalScene(database: string, committed: string): JournalScene {
  const fileChanged = stampOf(database) !== committed;
  let fd: number;
  try {
    fd = openSync(`${database}-journal`, 'r');
  } catch {
    return {bytes: -1, magic: false, fileChanged};
  }
  try {
    const head = Buffer.alloc(8);
    const read = readSync(fd, head, 0, 8, 0);
    return {bytes: fstatSync(fd).size, magic: read === 8 && head.equals(JOURNAL_MAGIC), fileChanged};
  } finally {
    closeSync(fd);
  }
}
function sceneOf(project: Project, committed: Stamps): Scene {
  return {
    superJournals: superJournals(project).map(name => ({name, bytes: statSync(path.join(project.localDir, name)).size})),
    history: journalScene(historyFileOf(project), committed.history),
    project: journalScene(project.projectFile, committed.project),
  };
}

/** Where in the commit the kill landed, from the files it left behind. SQLite
 * commits a transaction that spans files like this: it creates and syncs the
 * super-journal, then for main (history.db) and then for the project file
 * appends the super-journal's name to the journal, syncs the journal, writes
 * its header, writes the database file and syncs it; deleting the super-journal
 * is the commit point. */
type Moment = 'before-commit' | 'writing-super-journal' | 'writing-local-records' | 'writing-project-file' | 'after-commit-point';
function momentOf(scene: Scene, value: number, before: number): Moment {
  if (scene.superJournals.length) return scene.project.magic ? 'writing-project-file' : scene.history.magic ? 'writing-local-records' : 'writing-super-journal';
  return value > before ? 'after-commit-point' : 'before-commit';
}

// ---------------------------------------------------------------------------
// The child

interface ChildRun {
  /** Resolves true at the first stdout line passing `test`, false if the child exits first. */
  until(test: (line: string) => boolean): Promise<boolean>;
  isRunning(): boolean;
  kill(): void;
  /** Once the child has exited and its output is read. */
  readonly closed: Promise<{readonly lines: readonly string[]; readonly signal: NodeJS.Signals | null; readonly code: number | null; readonly stderr: string}>;
}
function startChild(t: TestContext, project: Project, mode: string, payloadMiB: number, onLine: (line: string) => void): ChildRun {
  const env: NodeJS.ProcessEnv = {
    ...process.env, MODE: mode, PAYLOAD_MIB: String(payloadMiB),
    PROJECT_FILE: project.projectFile, LOCAL_DIR: project.localDir, CACHE_DIR: project.cacheDir, TEMP_DIR: project.tempDir,
  };
  delete env.ROOT;
  const child = spawn(process.execPath, [CHILD], {cwd: REPOSITORY, env, stdio: ['ignore', 'pipe', 'pipe']});
  const isRunning = (): boolean => child.exitCode === null && child.signalCode === null;
  t.after(() => { if (isRunning()) child.kill('SIGKILL'); });
  const lines: string[] = [];
  let waiters: {readonly test: (line: string) => boolean; readonly resolve: (found: boolean) => void}[] = [];
  let pending = '', stderr = '', exited = false;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      lines.push(line);
      onLine(line);
      waiters = waiters.filter(waiter => {
        if (!waiter.test(line)) return true;
        waiter.resolve(true);
        return false;
      });
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const closed = new Promise<{lines: readonly string[]; signal: NodeJS.Signals | null; code: number | null; stderr: string}>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      exited = true;
      for (const waiter of waiters) waiter.resolve(false);
      waiters = [];
      resolve({lines, signal, code, stderr});
    });
  });
  return {
    until: test => lines.some(test) ? Promise.resolve(true) : exited ? Promise.resolve(false) : new Promise(resolve => { waiters.push({test, resolve}); }),
    isRunning, kill: () => { child.kill('SIGKILL'); }, closed,
  };
}
const committedLine = (line: string): number | undefined => /^committed (\d+)$/.exec(line) ? Number(line.slice('committed '.length)) : undefined;

/** Polls in 2 ms bursts between event-loop turns; SIGKILLs the child `delayMs`
 * after `hit` first returns true. False when the child exited first. */
function killWhen(run: ChildRun, hit: () => boolean, delayMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const poll = (): void => {
      if (!run.isRunning()) return resolve(false);
      const burst = performance.now() + 2;
      while (performance.now() < burst) {
        if (!hit()) continue;
        const until = performance.now() + delayMs;
        while (performance.now() < until) { /* wait */ }
        run.kill();
        return resolve(true);
      }
      setImmediate(poll);
    };
    poll();
  });
}

// ---------------------------------------------------------------------------
// One crash

type KillAt =
  /** Inside the transaction, after SQLite spilled it into both files (mid-transaction). */
  | {readonly at: 'ready'}
  /** After COMMIT returned (after-commit). */
  | {readonly at: 'committed'}
  /** `delayMs` after the super-journal appears, in the third commit or later (commit-loop). */
  | {readonly at: 'super-journal'; readonly delayMs: number}
  /** While SQLite writes history.db, the project file still untouched (commit-loop). */
  | {readonly at: 'local-records'}
  /** While SQLite writes the project file, history.db already written (commit-loop). */
  | {readonly at: 'project-file'};

interface Outcome {
  readonly kill: string;
  readonly payloadMiB: number;
  readonly moved: boolean;
  /** k of the last commit that returned before the kill (1 for the baseline). */
  readonly before: number;
  /** k after opening again. */
  readonly value: number;
  readonly moment: Moment;
  readonly scene: Scene;
  /** Super-journals in the local directory after the project was opened and closed again. */
  readonly superJournalsLeft: number;
}

const integrity = (db: DatabaseSync, schema: string): unknown[] => db.prepare(`PRAGMA ${schema}.integrity_check`).all().map(row => row.integrity_check);

/** Kills a child at `killAt`, optionally moves the project directory, opens
 * the project through the kernel and checks it: both files agree on k and the
 * content sequence, the history state is current, every database passes its
 * integrity check and no foreign key is broken. A kill while the super-journal
 * still exists must leave the old value. */
async function crash(t: TestContext, killAt: KillAt, payloadMiB: number, move = false): Promise<Outcome> {
  const project = newProject(t);
  const mode = killAt.at === 'ready' ? 'mid-transaction' : killAt.at === 'committed' ? 'after-commit' : 'commit-loop';
  let committed = stampsOf(project), before = 1, commits = 0;
  const run = startChild(t, project, mode, payloadMiB, line => {
    const k = committedLine(line);
    if (k === undefined) return;
    committed = stampsOf(project);
    commits += 1;
    if (mode === 'commit-loop') before = k;
  });
  let killed: boolean;
  if (killAt.at === 'ready' || killAt.at === 'committed') {
    killed = await run.until(line => line === (killAt.at === 'ready' ? 'ready' : 'committed 2'));
    if (killed) run.kill();
  } else {
    const hit = killAt.at === 'super-journal' ? () => superJournals(project).length > 0
      : killAt.at === 'local-records' ? () => {
        if (!superJournals(project).length) return false;
        const now = stampsOf(project);
        return now.history !== committed.history && now.project === committed.project;
      }
      : () => superJournals(project).length > 0 && stampOf(project.projectFile) !== committed.project;
    // Two commits first: from then on each commit rewrites the same pages of both files.
    killed = await run.until(() => commits >= 2) && await killWhen(run, hit, killAt.at === 'super-journal' ? killAt.delayMs : 0);
  }
  const exit = await run.closed;
  assert.ok(killed && exit.signal === 'SIGKILL', `the child was not killed (exit ${String(exit.code)}): ${exit.stderr}`);
  const scene = sceneOf(project, committed);
  let projectFile = project.projectFile;
  if (move) {
    const directory = path.dirname(projectFile);
    renameSync(directory, `${directory}-moved`);
    projectFile = path.join(`${directory}-moved`, path.basename(projectFile));
  }
  const store = openProjectStore({projectFile, locate: () => project});
  let reopened: {rows: CrashRows; file: unknown; seen: unknown; historyState: string; integrity: Record<string, unknown[]>; foreignKeys: unknown[]};
  try {
    const sequences = store.db.prepare('SELECT (SELECT contentSequence FROM project.project_file) AS file,(SELECT seenContentSequence FROM main.history_state) AS seen').get();
    reopened = {
      rows: readCrashRows(store.db, store.projectId), file: sequences?.file, seen: sequences?.seen, historyState: store.historyState,
      integrity: Object.fromEntries(['main', 'project', 'cache'].map(schema => [schema, integrity(store.db, schema)])),
      foreignKeys: foreignKeyCheck(store.db),
    };
  } finally {
    store.close();
  }
  const {rows} = reopened, value = rows.content;
  const outcome: Outcome = {
    kill: killAt.at === 'super-journal' ? `super-journal+${killAt.delayMs}ms` : killAt.at, payloadMiB, moved: move,
    before, value, moment: momentOf(scene, value, before), scene, superJournalsLeft: superJournals(project).length,
  };
  t.diagnostic(JSON.stringify(outcome));
  assert.deepEqual({records: rows.records, receipt: rows.receipt, samePad: rows.samePad}, {records: value, receipt: value, samePad: true}, 'both files hold the same k');
  assert.equal(reopened.seen, reopened.file, 'history.db has seen the content sequence of the project file');
  assert.equal(reopened.historyState, 'current');
  assert.deepEqual(reopened.integrity, {main: ['ok'], project: ['ok'], cache: ['ok']});
  assert.deepEqual(reopened.foreignKeys, []);
  if (killAt.at === 'ready') assert.equal(value, 1, 'killed inside the transaction');
  else if (killAt.at === 'committed') assert.equal(value, 2, 'killed after COMMIT returned');
  else if (scene.superJournals.length) assert.equal(value, before, 'killed while the super-journal existed');
  else assert.ok(value === before || value === before + 1, `k ${value} after the last commit ${before}`);
  return outcome;
}

/** Up to 5 crashes with the payload doubling from 16 MiB until `wanted` holds. */
async function crashUntil(t: TestContext, killAt: KillAt, wanted: (outcome: Outcome) => boolean, move = false): Promise<void> {
  const outcomes: Outcome[] = [];
  for (let payloadMiB = 16; outcomes.length < 5; payloadMiB *= 2) {
    const outcome = await crash(t, killAt, payloadMiB, move);
    outcomes.push(outcome);
    if (wanted(outcome)) return;
  }
  assert.fail(`no crash hit the wanted moment in ${outcomes.length} attempts: ${JSON.stringify(outcomes)}`);
}

// ---------------------------------------------------------------------------

test('SIGKILL inside the transaction, after SQLite spilled it into both files: both keep the old value', {timeout: TIMEOUT}, async t => {
  const outcome = await crash(t, {at: 'ready'}, 1);
  assert.equal(outcome.moment, 'before-commit');
  // Both files had spilled pages and hot journals to roll them back.
  const {history, project} = outcome.scene;
  assert.deepEqual([history.magic, history.fileChanged, project.magic, project.fileChanged], [true, true, true, true]);
});

test('SIGKILL as soon as the super-journal appears: both files keep the old value', {timeout: TIMEOUT}, async t => {
  await crashUntil(t, {at: 'super-journal', delayMs: 0}, outcome => outcome.scene.superJournals.length > 0);
});

test('SIGKILL 1 to 40 ms after the super-journal appears: both files agree', {timeout: TIMEOUT}, async t => {
  const moments: string[] = [];
  for (const delayMs of [1, 3, 6, 10, 20, 40]) moments.push(`${delayMs} ms: ${(await crash(t, {at: 'super-journal', delayMs}, 16)).moment}`);
  t.diagnostic(moments.join('; '));
});

test('SIGKILL after COMMIT returned: both files have the new value', {timeout: TIMEOUT}, async t => {
  const outcome = await crash(t, {at: 'committed'}, 1);
  assert.equal(outcome.moment, 'after-commit-point');
  assert.deepEqual(outcome.scene.superJournals, []);
});

for (const move of [false, true]) {
  const where = move ? 'after moving the project directory' : 'in place';
  test(`SIGKILL while SQLite writes the local records, opened ${where}: both files roll back`, {timeout: TIMEOUT}, async t => {
    await crashUntil(t, {at: 'local-records'}, outcome => outcome.moment === 'writing-local-records' && outcome.scene.history.fileChanged && !outcome.scene.project.fileChanged, move);
  });
  test(`SIGKILL while SQLite writes the project file, opened ${where}: both files roll back`, {timeout: TIMEOUT}, async t => {
    await crashUntil(t, {at: 'project-file'}, outcome => outcome.moment === 'writing-project-file' && outcome.scene.project.fileChanged && outcome.scene.history.fileChanged, move);
  });
}
