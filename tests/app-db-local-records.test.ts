// The local records list of the app library (task card B1): records folders
// whose project file can no longer be found, their size, and whether a
// super-journal still needed for a rollback keeps them. history.db is never
// opened; the super-journals and journals below are written by hand in
// SQLite's format (pager.c), as in project-file-journals.test.ts.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {projectCacheDirSegments, projectLocalDirSegments, PROJECT_RECORDS_DIRECTORY} from '../packages/contracts/src/project-file.ts';
import type {RecentProject} from '../packages/contracts/src/project-registry.ts';
import {createProjectFile, openProjectConnection} from '../packages/business/src/project-file/index.ts';
import {hasSuperJournalInUse, openAppLibrary} from '../packages/business/src/app-db/index.ts';
import type {AppLibrary, LocalRecordsItem} from '../packages/business/src/app-db/index.ts';

const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
const SUPER_JOURNAL = 'history.db-mj0DA3D190E';

interface Setup {
  readonly root: string;
  readonly dataDir: string;
  readonly library: AppLibrary;
  /** `records/<project ID>/` with files of the given sizes, folders 0700 like the kernel's. */
  records(projectId: string, files?: Readonly<Record<string, number>>): string;
}
function setup(t: TestContext, open: ReadonlySet<string> = new Set()): Setup {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-b1-records-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const dataDir = path.join(root, 'data');
  const library = openAppLibrary({dataDir, isProjectOpen: projectId => open.has(projectId)});
  t.after(() => library.close());
  const records = (projectId: string, files: Readonly<Record<string, number>> = {}): string => {
    const folder = path.join(dataDir, PROJECT_RECORDS_DIRECTORY, projectId);
    mkdirSync(folder, {recursive: true, mode: 0o700});
    for (const [name, size] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(folder, name)), {recursive: true, mode: 0o700});
      writeFileSync(path.join(folder, name), Buffer.alloc(size, 0x5a));
    }
    return folder;
  };
  return {root, dataDir, library, records};
}
function appError(action: () => Promise<unknown>): Promise<AppError> {
  return action().then(() => assert.fail('expected an AppError'), (error: unknown) => {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    return error;
  });
}
const registration = (projectId: string, projectFile: string, fileIdentity = {dev: '1', ino: '999999999'}): RecentProject =>
  ({projectId, projectFile, fileIdentity, name: path.basename(projectFile, '.mioon'), lastOpenedAt: null, summary: null});

/** A rollback journal: a 512-byte header (with the magic when hot), one page
 * record, and optionally the name of its super-journal at the end. */
function writeJournal(file: string, {hot = true, names}: {readonly hot?: boolean; readonly names?: string} = {}): void {
  const header = Buffer.alloc(512);
  if (hot) {
    JOURNAL_MAGIC.copy(header, 0);
    header.writeUInt32BE(1, 8);
  }
  const parts = [header, Buffer.alloc(4 + 4096 + 4, 0x5a)];
  if (names !== undefined) {
    const name = Buffer.from(names, 'utf8');
    const tail = Buffer.alloc(16);
    tail.writeUInt32BE(name.length, 0);
    tail.writeUInt32BE(name.reduce((sum, byte) => (sum + byte) >>> 0, 0), 4);
    JOURNAL_MAGIC.copy(tail, 8);
    parts.push(Buffer.from([0, 0, 0x40, 0x01]), name, tail);
  }
  writeFileSync(file, Buffer.concat(parts));
}
const writeSuperJournal = (file: string, journals: readonly string[]): void => {
  writeFileSync(file, journals.map(journal => `${journal}\u0000`).join(''));
};

test('records whose project file cannot be found are listed with their size, name and last location', async t => {
  const projectA = '00000000-0000-4000-8000-00000000000a', projectC = '00000000-0000-4000-8000-00000000000c';
  const projectOpen = '00000000-0000-4000-8000-00000000000e';
  const {root, dataDir, library, records} = setup(t, new Set([projectOpen]));
  // Not registered: only the project ID is known.
  const folderA = records(projectA, {'history.db': 1000, 'history.db-journal': 0, 'backups/backup-1.mioon': 500, 'imports/note.txt': 24});
  symlinkSync(path.join(root, 'outside'), path.join(folderA, 'imports', 'link'));
  writeFileSync(path.join(root, 'outside'), Buffer.alloc(10_000));
  // Registered, but the file is gone and cannot be found.
  records(projectC, {'history.db': 10});
  library.registry.upsert(registration(projectC, path.join(root, 'projects', 'Gone', 'Gone.mioon')));
  // Registered and in place.
  const present = path.join(root, 'projects', 'Present', 'Present.mioon');
  mkdirSync(path.dirname(present), {recursive: true});
  const presentId = createProjectFile(present);
  library.registry.upsert(registration(presentId, present, library.projectFileIdentity(present)!));
  records(presentId, {'history.db': 10});
  // Registered and moved: found by file identity.
  const movedFrom = path.join(root, 'projects', 'Moved', 'Moved.mioon');
  mkdirSync(path.dirname(movedFrom), {recursive: true});
  const movedId = createProjectFile(movedFrom);
  library.registry.upsert(registration(movedId, movedFrom, library.projectFileIdentity(movedFrom)!));
  renameSync(path.dirname(movedFrom), path.join(root, 'projects', 'Moved again'));
  records(movedId, {'history.db': 10});
  // Open in this process (the host says so), though its file is not found.
  records(projectOpen, {'history.db': 10});
  library.registry.upsert(registration(projectOpen, path.join(root, 'projects', 'Open', 'Open.mioon')));
  // Not records folders.
  records('notes');
  records(projectA.toUpperCase().replace('A', 'B'));
  writeFileSync(path.join(dataDir, PROJECT_RECORDS_DIRECTORY, randomUUID()), '');
  symlinkSync(folderA, path.join(dataDir, PROJECT_RECORDS_DIRECTORY, randomUUID()));

  const expected: LocalRecordsItem[] = [
    {projectId: projectA, sizeBytes: 1524, hasSuperJournal: false, name: null, projectFile: null},
    {projectId: projectC, sizeBytes: 10, hasSuperJournal: false, name: 'Gone', projectFile: path.join(root, 'projects', 'Gone', 'Gone.mioon')},
  ];
  assert.deepEqual(await library.localRecords.list(), expected);
});

test('no records folder lists nothing', async t => {
  const {library} = setup(t);
  assert.deepEqual(await library.localRecords.list(), []);
});

test('a super-journal still needed keeps its folder; one no journal refers to does not', async t => {
  const {root, library, records} = setup(t);
  // In use: history.db's journal is hot and names the super-journal.
  const inUse = randomUUID(), folderInUse = records(inUse, {'history.db': 100});
  writeSuperJournal(path.join(folderInUse, SUPER_JOURNAL), [path.join(folderInUse, 'history.db-journal'), path.join(root, 'gone', 'Film.mioon-journal')]);
  writeJournal(path.join(folderInUse, 'history.db-journal'), {names: path.join(folderInUse, SUPER_JOURNAL)});
  // Unused: the journal was never made hot (killed while writing the super-journal).
  const unused = randomUUID(), folderUnused = records(unused, {'history.db': 100});
  writeSuperJournal(path.join(folderUnused, SUPER_JOURNAL), [path.join(folderUnused, 'history.db-journal')]);
  writeJournal(path.join(folderUnused, 'history.db-journal'), {hot: false, names: path.join(folderUnused, SUPER_JOURNAL)});
  // A hot journal that names another super-journal does not count either.
  const other = randomUUID(), folderOther = records(other);
  writeSuperJournal(path.join(folderOther, SUPER_JOURNAL), [path.join(folderOther, 'history.db-journal')]);
  writeJournal(path.join(folderOther, 'history.db-journal'), {names: path.join(folderOther, 'history.db-mjCAA6C6996')});

  assert.equal(hasSuperJournalInUse(folderInUse), true);
  assert.equal(hasSuperJournalInUse(folderUnused), false);
  assert.equal(hasSuperJournalInUse(folderOther), false);
  assert.equal(hasSuperJournalInUse(path.join(root, 'missing')), false);
  const listed = new Map((await library.localRecords.list()).map(item => [item.projectId, item.hasSuperJournal]));
  assert.deepEqual(Object.fromEntries(listed), {[inUse]: true, [unused]: false, [other]: false});

  const refused = await appError(() => library.localRecords.delete(inUse));
  assert.deepEqual([refused.code, refused.status, refused.details], ['LOCAL_RECORDS_SUPER_JOURNAL', 409, {projectId: inUse}]);
  assert.ok(existsSync(path.join(folderInUse, SUPER_JOURNAL)));
  await library.localRecords.delete(unused);
  await library.localRecords.delete(other);
  assert.equal(existsSync(folderUnused), false);
  assert.equal(existsSync(folderOther), false);
  assert.deepEqual(readdirSync(path.dirname(folderInUse)), [inUse]);

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    // A super-journal that cannot be read is kept.
    chmodSync(path.join(folderInUse, SUPER_JOURNAL), 0);
    rmSync(path.join(folderInUse, 'history.db-journal'));
    assert.equal(hasSuperJournalInUse(folderInUse), true);
    chmodSync(path.join(folderInUse, SUPER_JOURNAL), 0o600);
    assert.equal(hasSuperJournalInUse(folderInUse), false);
  }
});

test('delete checks everything again and removes only an orphaned folder', async t => {
  const open = new Set<string>();
  const {root, dataDir, library, records} = setup(t, open);
  await assert.rejects(library.localRecords.delete('NOT-AN-ID'), TypeError);
  const unknown = randomUUID();
  const missing = await appError(() => library.localRecords.delete(unknown));
  assert.deepEqual([missing.code, missing.status, missing.details], ['LOCAL_RECORDS_NOT_FOUND', 404, {projectId: unknown}]);
  // A file in place of the folder is not a records folder.
  mkdirSync(path.join(dataDir, PROJECT_RECORDS_DIRECTORY), {mode: 0o700});
  writeFileSync(path.join(dataDir, PROJECT_RECORDS_DIRECTORY, unknown), '');
  assert.equal((await appError(() => library.localRecords.delete(unknown))).code, 'LOCAL_RECORDS_NOT_FOUND');

  // The project file is still where it is registered.
  const present = path.join(root, 'projects', 'Present', 'Present.mioon');
  mkdirSync(path.dirname(present), {recursive: true});
  const presentId = createProjectFile(present);
  library.registry.upsert(registration(presentId, present, library.projectFileIdentity(present)!));
  records(presentId, {'history.db': 10});
  const inUse = await appError(() => library.localRecords.delete(presentId));
  assert.deepEqual([inUse.code, inUse.status], ['LOCAL_RECORDS_IN_USE', 409]);
  // The project is open here.
  const openId = randomUUID();
  records(openId, {'history.db': 10});
  open.add(openId);
  assert.equal((await appError(() => library.localRecords.delete(openId))).code, 'LOCAL_RECORDS_IN_USE');
  open.delete(openId);
  await library.localRecords.delete(openId);
  assert.equal(existsSync(path.join(dataDir, PROJECT_RECORDS_DIRECTORY, openId)), false);
  assert.ok(existsSync(path.join(dataDir, PROJECT_RECORDS_DIRECTORY, presentId)));

  // A delete that stopped after its rename leaves a hidden folder; the next list removes it.
  const tombstone = path.join(dataDir, PROJECT_RECORDS_DIRECTORY, `.deleting-${randomUUID()}-${randomUUID()}`);
  mkdirSync(path.join(tombstone, 'backups'), {recursive: true, mode: 0o700});
  writeFileSync(path.join(tombstone, 'backups', 'old.mioon'), 'x');
  await library.localRecords.list();
  assert.equal(existsSync(tombstone), false);
});

test('a records folder the kernel made is listed once its project file is gone, then deleted', async t => {
  const {root, dataDir, library} = setup(t);
  const projectFile = path.join(root, 'projects', 'Film', 'Film.mioon');
  mkdirSync(path.dirname(projectFile), {recursive: true});
  const projectId = createProjectFile(projectFile);
  library.registry.upsert(registration(projectId, projectFile, library.projectFileIdentity(projectFile)!));
  const connection = openProjectConnection({
    projectFile, checkCopy: library.registry.checkCopy,
    locate: id => ({
      localDir: path.join(dataDir, ...projectLocalDirSegments(id)), cacheDir: path.join(dataDir, 'cache', ...projectCacheDirSegments(id)),
      tempDir: path.join(dataDir, 'tmp', 'projects', id),
    }),
  });
  connection.db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId, '{}');
  connection.close();
  assert.deepEqual(await library.localRecords.list(), []);
  rmSync(path.dirname(projectFile), {recursive: true});
  const folder = path.join(dataDir, ...projectLocalDirSegments(projectId));
  const historySize = lstatSync(path.join(folder, 'history.db')).size;
  assert.ok(historySize > 0);
  assert.deepEqual(await library.localRecords.list(), [{projectId, sizeBytes: historySize, hasSuperJournal: false, name: 'Film', projectFile}]);
  await library.localRecords.delete(projectId);
  assert.equal(existsSync(folder), false);
  assert.deepEqual(readdirSync(path.join(dataDir, PROJECT_RECORDS_DIRECTORY)), []);
  assert.deepEqual(await library.localRecords.list(), []);
});
