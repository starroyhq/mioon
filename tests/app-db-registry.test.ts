// The recent-project registry of the app library (task card B1): project file
// identity by lstat, copies refused through the kernel's checkCopy hook (plan
// 5.2), moved projects found by file identity (plan 8.2), and that none of it
// drops the SQLite locks of a project this process has open.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {PROJECT_FILE_COPY, projectCacheDirSegments, projectLocalDirSegments} from '../packages/contracts/src/project-file.ts';
import type {ProjectFileIdentity, RecentProject} from '../packages/contracts/src/project-registry.ts';
import {createProjectFile, openProjectConnection} from '../packages/business/src/project-file/index.ts';
import type {ProjectLocation} from '../packages/business/src/project-file/index.ts';
import {
  findMovedProjectFile, findMovedSearchRoots, identityOfStats, MAX_RECENT_PROJECTS, NODE_FIND_MOVED_FILE_SYSTEM, openAppLibrary,
  sameProjectFileIdentity,
} from '../packages/business/src/app-db/index.ts';
import type {AppLibrary, AppLibraryOptions, DirectoryEntry, FindMovedFileSystem} from '../packages/business/src/app-db/index.ts';

const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const CHILD = fileURLToPath(new URL('./helpers/project-file-child.ts', import.meta.url));
const LOCKED = {ok: false, message: 'database is locked', errcode: 5};

interface Setup {
  readonly root: string;
  readonly dataDir: string;
  readonly projects: string;
  readonly library: AppLibrary;
  readonly locate: (projectId: string) => ProjectLocation;
}
function setup(t: TestContext, options: Omit<AppLibraryOptions, 'dataDir'> = {}): Setup {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-b1-registry-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const dataDir = path.join(root, 'data'), projects = path.join(root, 'projects');
  mkdirSync(projects);
  const library = openAppLibrary({dataDir, ...options});
  t.after(() => library.close());
  // The server layout: local records under records/, cache and staging per project.
  const locate = (projectId: string): ProjectLocation => ({
    localDir: path.join(dataDir, ...projectLocalDirSegments(projectId)),
    cacheDir: path.join(dataDir, 'cache', ...projectCacheDirSegments(projectId)),
    tempDir: path.join(dataDir, 'tmp', 'projects', projectId),
  });
  return {root, dataDir, projects, library, locate};
}
/** A new project file at `projectFile` (folders created), registered. */
function registered(library: AppLibrary, projectFile: string, name = path.basename(projectFile, '.mioon')): RecentProject {
  mkdirSync(path.dirname(projectFile), {recursive: true});
  const projectId = createProjectFile(projectFile);
  const entry: RecentProject = {projectId, projectFile, fileIdentity: library.projectFileIdentity(projectFile)!, name, lastOpenedAt: null, summary: null};
  library.registry.upsert(entry);
  return entry;
}
function appError(action: () => unknown): AppError {
  let result: unknown;
  try {
    result = action();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    return error;
  }
  (result as {close?: () => void} | undefined)?.close?.();
  assert.fail('expected an AppError');
}
/** Another process reading the file read-only with a busy timeout of 0. */
function readInChild(file: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [CHILD], {cwd: REPOSITORY, env: {...process.env, MODE: 'raw-read', FILE: file}, encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
}
const lstatIdentity = (file: string): ProjectFileIdentity => {
  const info = lstatSync(file, {bigint: true});
  return {dev: String(info.dev), ino: String(info.ino)};
};

// ---------------------------------------------------------------------------
// Identity

test('projectFileIdentity is the decimal dev and ino of an lstat, null for anything but a regular file', t => {
  const {root, library} = setup(t);
  const file = path.join(root, 'Film.mioon');
  writeFileSync(file, 'x');
  assert.deepEqual(library.projectFileIdentity(file), lstatIdentity(file));
  assert.equal(library.projectFileIdentity(path.join(root, 'missing.mioon')), null);
  assert.equal(library.projectFileIdentity(path.join(file, 'below-a-file.mioon')), null);
  assert.equal(library.projectFileIdentity(root), null);
  symlinkSync(file, path.join(root, 'Link.mioon'));
  assert.equal(library.projectFileIdentity(path.join(root, 'Link.mioon')), null);
  assert.throws(() => library.projectFileIdentity(''), TypeError);
  assert.throws(() => library.projectFileIdentity(`${file}\u0000`), TypeError);
});

test('identities keep 64-bit file IDs exactly, and a file ID of 0 never matches', () => {
  const stats = (dev: bigint, ino: bigint, file = true) => ({dev, ino, isFile: () => file});
  // Windows: a 32-bit volume serial number and a 64-bit file index.
  assert.deepEqual(identityOfStats(stats(0xffff_ffffn, 0xffff_ffff_ffff_ffffn)), {dev: '4294967295', ino: '18446744073709551615'});
  assert.deepEqual(identityOfStats(stats(1n, 2n ** 53n + 1n)), {dev: '1', ino: '9007199254740993'});
  assert.equal(identityOfStats(stats(1n, 2n, false)), null);
  assert.equal(identityOfStats(undefined), null);
  const a = {dev: '4294967295', ino: '18446744073709551615'};
  assert.equal(sameProjectFileIdentity(a, {...a}), true);
  assert.equal(sameProjectFileIdentity(a, {...a, ino: '18446744073709551614'}), false);
  assert.equal(sameProjectFileIdentity(a, {...a, dev: '1'}), false);
  assert.equal(sameProjectFileIdentity({dev: '7', ino: '0'}, {dev: '7', ino: '0'}), false);
  assert.equal(sameProjectFileIdentity(a, null), false);
  assert.equal(sameProjectFileIdentity(undefined, a), false);
});

// ---------------------------------------------------------------------------
// The registry

test('the registry keeps valid entries in the order they were first registered', t => {
  const {library} = setup(t);
  const entry = (name: string): RecentProject => ({
    projectId: randomUUID(), projectFile: `/Films/${name}/${name}.mioon`, fileIdentity: {dev: '1', ino: String(name.length)}, name, lastOpenedAt: null, summary: null,
  });
  const a = entry('A'), b = entry('Bee');
  library.registry.upsert(a);
  library.registry.upsert(b);
  const opened = {...a, lastOpenedAt: '2026-11-01T08:00:00.000Z', name: 'A, renamed'};
  library.registry.upsert(opened);
  assert.deepEqual(library.registry.list(), [opened, b]);
  assert.deepEqual(library.registry.get(b.projectId), b);
  library.registry.remove(a.projectId);
  library.registry.upsert(a);
  assert.deepEqual(library.registry.list(), [b, a]);
  assert.equal(library.registry.get(randomUUID()), null);
  assert.equal(library.registry.get('NOT-AN-ID'), null);
  library.registry.remove('NOT-AN-ID');
  assert.throws(() => library.registry.upsert({...a, projectFile: 'relative/A.mioon'}), {name: 'ZodError'});
  assert.throws(() => library.registry.upsert({...a, fileIdentity: {dev: '1', ino: '-2'}}), {name: 'ZodError'});
  assert.throws(() => library.registry.upsert({...a, extra: true} as RecentProject), {name: 'ZodError'});
  assert.throws(() => library.registry.upsert({...a, projectId: a.projectId.toUpperCase()}), {name: 'ZodError'});
  assert.deepEqual(library.registry.list(), [b, a]);
});

test(`the registry holds at most ${MAX_RECENT_PROJECTS} projects; updating one at the limit still works`, t => {
  const {library} = setup(t);
  const entry = (index: number): RecentProject => ({
    projectId: randomUUID(), projectFile: `/Films/${index}/Film.mioon`, fileIdentity: {dev: '1', ino: String(index + 1)}, name: `Film ${index}`, lastOpenedAt: null, summary: null,
  });
  const first = entry(0);
  library.tx(() => {
    library.registry.upsert(first);
    for (let index = 1; index < MAX_RECENT_PROJECTS; index++) library.registry.upsert(entry(index));
  });
  const error = appError(() => library.registry.upsert(entry(MAX_RECENT_PROJECTS)));
  assert.deepEqual([error.code, error.status, error.details], ['APP_LIBRARY_LIMIT', 507, {limit: MAX_RECENT_PROJECTS}]);
  library.registry.upsert({...first, name: 'Still updatable'});
  assert.equal(library.registry.list().length, MAX_RECENT_PROJECTS);
  assert.equal(library.registry.list()[0]!.name, 'Still updatable');
});

// ---------------------------------------------------------------------------
// Copies (plan 5.2)

test('a copy is refused in the kernel\'s checkCopy hook, before any local records exist', t => {
  const {projects, dataDir, library, locate} = setup(t);
  const film = registered(library, path.join(projects, 'Film', 'Film.mioon'));
  const copy = path.join(projects, 'Film copy', 'Film.mioon');
  mkdirSync(path.dirname(copy));
  copyFileSync(film.projectFile, copy);
  const located: string[] = [];
  const spy = (projectId: string): ProjectLocation => {
    located.push(projectId);
    return locate(projectId);
  };
  const error = appError(() => openProjectConnection({projectFile: copy, locate: spy, checkCopy: library.registry.checkCopy}));
  assert.deepEqual([error.code, error.status, error.details], [PROJECT_FILE_COPY, 409, {projectId: film.projectId}]);
  assert.deepEqual(located, []);
  assert.equal(existsSync(path.join(dataDir, ...projectLocalDirSegments(film.projectId))), false);
  assert.equal(library.registry.copyOf({projectId: film.projectId, projectFile: copy}), film.projectFile);
  // The registered file opens through the same hook; the copy stays refused.
  const connection = openProjectConnection({projectFile: film.projectFile, locate: spy, checkCopy: library.registry.checkCopy});
  connection.close();
  assert.deepEqual(located, [film.projectId]);
  assert.equal(appError(() => openProjectConnection({projectFile: copy, locate: spy, checkCopy: library.registry.checkCopy})).code, PROJECT_FILE_COPY);
});

test('not a copy: the registered file itself, moved or hard-linked, or a file whose original is gone', t => {
  const {projects, library, locate} = setup(t);
  const check = (projectId: string, projectFile: string): string | null => library.registry.copyOf({projectId, projectFile});
  const film = registered(library, path.join(projects, 'Film', 'Film.mioon'));
  assert.equal(check(film.projectId, film.projectFile), null);
  assert.equal(check(randomUUID(), film.projectFile), null);
  // Hard links reach the same file.
  const linked = path.join(projects, 'Linked.mioon');
  linkSync(film.projectFile, linked);
  assert.equal(check(film.projectId, linked), null);
  rmSync(linked);
  // Moved with its folder: the same file identity, so it opens and is not a copy.
  const moved = path.join(projects, 'Film moved', 'Film.mioon');
  renameSync(path.dirname(film.projectFile), path.dirname(moved));
  assert.equal(check(film.projectId, moved), null);
  openProjectConnection({projectFile: moved, locate, checkCopy: library.registry.checkCopy}).close();
  // A copy whose original was deleted is taken as the moved project.
  const copy = path.join(projects, 'Copy.mioon');
  copyFileSync(moved, copy);
  library.registry.upsert({...film, projectFile: moved});
  assert.equal(check(film.projectId, copy), moved);
  rmSync(moved);
  assert.equal(check(film.projectId, copy), null);
});

test('the registered place holding another registered project is not the original; holding an unknown file is', t => {
  const {projects, library} = setup(t);
  const place = path.join(projects, 'Film', 'Film.mioon');
  const film = registered(library, place);
  const backup = path.join(projects, 'Backup.mioon');
  copyFileSync(place, backup);
  // The folder is deleted and a new project created under the same name.
  rmSync(path.dirname(place), {recursive: true});
  const other = registered(library, place);
  assert.notEqual(other.projectId, film.projectId);
  assert.equal(library.registry.copyOf({projectId: film.projectId, projectFile: backup}), null);
  // A file nobody registered at the registered place counts as the original
  // (for example one a sync tool replaced in place): the backup is a copy.
  rmSync(place);
  copyFileSync(backup, place);
  library.registry.remove(other.projectId);
  assert.equal(library.registry.copyOf({projectId: film.projectId, projectFile: backup}), place);
});

// ---------------------------------------------------------------------------
// Moved projects (plan 8.2)

test('a project moved while closed is found by its file identity', async t => {
  const {root, projects, library} = setup(t);
  const film = registered(library, path.join(projects, 'Film', 'Film.mioon'));
  const find = (): Promise<string | null> => library.registry.findMoved(library.registry.get(film.projectId)!);
  assert.equal(await find(), film.projectFile);
  // The folder renamed.
  const renamed = path.join(projects, 'Film final', 'Film.mioon');
  renameSync(path.dirname(film.projectFile), path.dirname(renamed));
  assert.equal(await find(), renamed);
  // The .mioon renamed in its folder.
  const retitled = path.join(path.dirname(renamed), 'Final cut.mioon');
  renameSync(renamed, retitled);
  assert.equal(await library.registry.findMoved({...film, projectFile: renamed}), retitled);
  // The folder moved into an archive folder next to it: one level deeper than the old parent.
  const archived = path.join(projects, 'Archive', 'Film final', 'Final cut.mioon');
  mkdirSync(path.join(projects, 'Archive'));
  renameSync(path.dirname(retitled), path.dirname(archived));
  assert.equal(await library.registry.findMoved({...film, projectFile: retitled}), archived);
  // Far away: found only from an extra root, such as the projects directory.
  const far = path.join(root, 'elsewhere', 'deep', 'Film', 'Final cut.mioon');
  mkdirSync(path.join(root, 'elsewhere', 'deep'), {recursive: true});
  renameSync(path.dirname(archived), path.dirname(far));
  const entry = {...film, projectFile: archived};
  assert.equal(await library.registry.findMoved(entry), null);
  assert.equal(await findMovedProjectFile(entry, {roots: [path.join(root, 'elsewhere')]}), far);
  // Deleted: nothing has its identity any more.
  rmSync(far);
  assert.equal(await findMovedProjectFile({...film, projectFile: far}, {roots: [root]}), null);
  await assert.rejects(library.registry.findMoved({...film, projectFile: 'relative.mioon'}), {name: 'ZodError'});
});

test('the search skips hidden entries, journals, links and project output folders, lstats only .mioon files and stops at its limit', async t => {
  const {root, projects, library} = setup(t);
  const film = registered(library, path.join(projects, 'Film', 'Film.mioon'));
  const folder = path.dirname(film.projectFile);
  const away = path.join(root, 'away', 'Film.mioon');
  mkdirSync(path.dirname(away));
  renameSync(film.projectFile, away);
  const identities: string[] = [];
  const fileSystem: FindMovedFileSystem = {
    readDirectory: (directory, limit) => NODE_FIND_MOVED_FILE_SYSTEM.readDirectory(directory, limit),
    identity: file => {
      identities.push(path.basename(file));
      return NODE_FIND_MOVED_FILE_SYSTEM.identity(file);
    },
  };
  const find = (): Promise<string | null> => findMovedProjectFile(film, {fileSystem});
  // The same file under names the search must pass over.
  mkdirSync(path.join(projects, '.hidden'));
  mkdirSync(path.join(folder, '生成'));
  mkdirSync(path.join(folder, '导出'));
  for (const name of [path.join(folder, 'Film.mioon-journal'), path.join(folder, '.Film.mioon'), path.join(projects, '.hidden', 'Film.mioon'),
    path.join(folder, '生成', 'Film.mioon'), path.join(folder, '导出', 'Film.mioon'), path.join(folder, 'Copy.MIOON-JOURNAL')]) linkSync(away, name);
  symlinkSync(away, path.join(folder, 'Link.mioon'));
  for (let index = 0; index < 40; index++) writeFileSync(path.join(folder, `notes ${String(index).padStart(2, '0')}.txt`), '');
  writeFileSync(path.join(folder, 'Other.mioon'), 'not this one');
  assert.equal(await find(), null);
  assert.deepEqual(identities, ['Other.mioon']);
  // Any case of the extension is a candidate.
  const upper = path.join(folder, 'FILM COPY.MIOON');
  linkSync(away, upper);
  assert.equal(await find(), upper);
  // The old folder alone holds 48 entries: too many within 30.
  assert.equal(await findMovedProjectFile(film, {limit: 30}), null);
  assert.equal(await findMovedProjectFile(film, {limit: 60}), upper);
  // Breadth first, each folder in name order: a link in the parent comes
  // before one a level deeper, and of two in one folder the first by name.
  rmSync(upper);
  mkdirSync(path.join(projects, 'Zed'));
  linkSync(away, path.join(projects, 'Zed', 'Film.mioon'));
  assert.equal(await find(), path.join(projects, 'Zed', 'Film.mioon'));
  linkSync(away, path.join(projects, 'B.mioon'));
  linkSync(away, path.join(projects, 'A.mioon'));
  assert.equal(await find(), path.join(projects, 'A.mioon'));
  rmSync(path.join(projects, 'A.mioon'));
  rmSync(path.join(projects, 'B.mioon'));
  assert.equal(await findMovedProjectFile(film, {depth: 0}), null);
  assert.equal(await findMovedProjectFile(film, {depth: 1}), path.join(projects, 'Zed', 'Film.mioon'));
});

test('a project moved while open is found, and nothing here drops its SQLite locks', async t => {
  const {projects, library, locate} = setup(t);
  const film = registered(library, path.join(projects, 'Film', 'Film.mioon'));
  const connection = openProjectConnection({projectFile: film.projectFile, locate, checkCopy: library.registry.checkCopy});
  t.after(() => connection.close());
  connection.db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(film.projectId, '{}');
  const moved = path.join(projects, 'Film moved', 'Film.mioon');
  renameSync(path.dirname(film.projectFile), path.dirname(moved));
  const entry = library.registry.get(film.projectId)!;
  assert.equal(await library.registry.findMoved(entry), moved);
  assert.deepEqual(library.projectFileIdentity(moved), film.fileIdentity);
  assert.equal(library.registry.copyOf({projectId: film.projectId, projectFile: moved}), null);
  library.registry.checkCopy({projectId: film.projectId, projectFile: moved});
  // Its local records are found through the moved file, so they are not listed.
  assert.deepEqual(await library.localRecords.list(), []);
  assert.deepEqual(readInChild(moved), LOCKED);
  connection.db.prepare('UPDATE projects SET data=? WHERE id=?').run('{"moved":true}', film.projectId);
  assert.deepEqual(readInChild(moved), LOCKED);
  // The control: reading the file with fs in this process drops SQLite's
  // POSIX lock, and the other process can read it.
  if (process.platform !== 'win32') {
    readFileSync(moved);
    assert.deepEqual(readInChild(moved), {ok: true});
  }
});

// ---------------------------------------------------------------------------
// Windows paths, with path.win32 and a file system in memory

function memoryFileSystem(tree: Readonly<Record<string, readonly DirectoryEntry[]>>, identities: Readonly<Record<string, ProjectFileIdentity>>) {
  const reads: string[] = [], stats: string[] = [];
  const fileSystem: FindMovedFileSystem = {
    readDirectory: async (directory, limit) => {
      reads.push(directory);
      return tree[directory]?.slice(0, limit) ?? null;
    },
    identity: async file => {
      stats.push(file);
      return identities[file] ?? null;
    },
  };
  return {fileSystem, reads, stats};
}
const file = (name: string): DirectoryEntry => ({name, kind: 'file'});
const folder = (name: string): DirectoryEntry => ({name, kind: 'directory'});

test('Windows: search roots of drive and UNC paths', () => {
  assert.deepEqual(findMovedSearchRoots('C:\\Users\\me\\Videos\\Mioon\\Film\\Film.mioon', ['D:\\Projects\\'], path.win32),
    ['C:\\Users\\me\\Videos\\Mioon\\Film', 'C:\\Users\\me\\Videos\\Mioon', 'D:\\Projects\\']);
  assert.deepEqual(findMovedSearchRoots('\\\\nas\\share\\Film\\Film.mioon', [], path.win32), ['\\\\nas\\share\\Film', '\\\\nas\\share\\']);
  assert.deepEqual(findMovedSearchRoots('C:\\Film.mioon', ['C:\\'], path.win32), ['C:\\']);
  assert.deepEqual(findMovedSearchRoots('/Films/Film/Film.mioon', ['/Films/'], path.posix), ['/Films/Film', '/Films', '/Films/']);
});

test('Windows: a moved project is found on a drive and on a UNC share by its 64-bit file ID', async () => {
  const identity = {dev: '2882400001', ino: '18446744073709551615'};
  const entry = {projectFile: 'C:\\Users\\me\\Videos\\Mioon\\Film\\Film.mioon', fileIdentity: identity};
  const mioon = 'C:\\Users\\me\\Videos\\Mioon';
  const drive = memoryFileSystem({
    [mioon]: [file('desktop.ini'), folder('Other'), folder('Archive')],
    [`${mioon}\\Archive`]: [folder('Film')],
    [`${mioon}\\Archive\\Film`]: [file('FILM.MIOON-journal'), folder('生成'), file('FILM.MIOON')],
    [`${mioon}\\Other`]: [folder('.hidden'), file('Other.mioon')],
  }, {
    [`${mioon}\\Archive\\Film\\FILM.MIOON`]: identity,
    [`${mioon}\\Archive\\Film\\FILM.MIOON-journal`]: identity,
    [`${mioon}\\Other\\Other.mioon`]: {...identity, ino: '18446744073709551614'},
  });
  assert.equal(await findMovedProjectFile(entry, {fileSystem: drive.fileSystem, path: path.win32}), `${mioon}\\Archive\\Film\\FILM.MIOON`);
  assert.deepEqual(drive.reads, [`${mioon}\\Film`, mioon, `${mioon}\\Archive`, `${mioon}\\Other`, `${mioon}\\Archive\\Film`]);
  assert.deepEqual(drive.stats, [`${mioon}\\Other\\Other.mioon`, `${mioon}\\Archive\\Film\\FILM.MIOON`]);

  const share = memoryFileSystem({
    '\\\\nas\\share\\': [folder('Film 2')],
    '\\\\nas\\share\\Film 2': [file('Film.mioon')],
  }, {'\\\\nas\\share\\Film 2\\Film.mioon': identity});
  const unc = {projectFile: '\\\\nas\\share\\Film\\Film.mioon', fileIdentity: identity};
  assert.equal(await findMovedProjectFile(unc, {fileSystem: share.fileSystem, path: path.win32}), '\\\\nas\\share\\Film 2\\Film.mioon');
  assert.equal(await findMovedProjectFile({...unc, fileIdentity: {...identity, ino: '0'}}, {fileSystem: share.fileSystem, path: path.win32}), null);
});
