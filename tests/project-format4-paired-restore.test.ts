import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {captureClosedProjectSnapshot, inspectClosedProjectForTrash} from '../packages/business/src/project-file/closed-copy.ts';
import {inspectProjectFormatReadOnly} from '../packages/business/src/project-file/connection.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {foreignKeyCheck} from '../packages/business/src/project-file/cross-file/inspect.ts';
import {FORMAT_UPGRADE_BACKUP_DIRECTORY} from '../packages/business/src/project-file/format4-backup.ts';
import {restoreFormat4Backup} from '../packages/business/src/project-file/format4-restore.ts';
import type {Format4RestoreBoundary} from '../packages/business/src/project-file/format4-restore.ts';
import {FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import {defaultPrevisScene} from '../packages/contracts/src/previs.ts';

const candidate = {};
const worker = fileURLToPath(new URL('./fixtures/format4-paired-restore-worker.ts', import.meta.url));
const requiresRenameWhileHeld = {skip: process.platform === 'win32' ? 'Requires rename while SQLite holds the file' : false};
const historyScope = 'paired-restore';
const oldResource = 'Before format upgrade';
const newResource = 'After format upgrade';

function readOptional(file: string): Buffer | null {
  return existsSync(file) ? readFileSync(file) : null;
}

function fixture(t: TestContext, backupHistory = true) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-format4-restore-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const location = {localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')};
  const projectDir = path.join(root, 'project');
  mkdirSync(projectDir, {mode: 0o700});
  const projectFile = path.join(projectDir, 'film.mioon'), historyFile = path.join(location.localDir, 'history.db');
  const openOptions = {projectFile, locate: () => location};
  const original = createProjectStore(openOptions);
  const projectId = original.projectId;
  try {
    original.put('projects', {id: projectId, name: oldResource, revision: 1});
    original.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(historyScope, 'original-request', 'original-digest', oldResource);
  } finally {original.close();}
  if (!backupHistory) rmSync(historyFile);
  const originalBytes = {project: readFileSync(projectFile), history: readOptional(historyFile)};
  const oldStamp = inspectProjectFormatReadOnly(projectFile);
  const upgraded = openProjectStore({...openOptions, format4: {approveUpgrade: () => true}});
  let expected: ReturnType<typeof readProjectContentStamp>;
  try {
    assert.equal(upgraded.db.prepare('PRAGMA project.user_version').get()?.user_version, FORMAT4_PROJECT_SCHEMA_VERSION);
    assert.equal(upgraded.db.prepare('SELECT version FROM schema_version').get()?.version, FORMAT4_HISTORY_SCHEMA_VERSION);
    upgraded.put('projects', {id: projectId, name: newResource, revision: 2});
    upgraded.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(historyScope, 'candidate-request', 'candidate-digest', newResource);
    expected = readProjectContentStamp(upgraded.db);
  } finally {upgraded.close();}
  assert.notEqual(expected.contentToken, oldStamp.contentToken);
  const backupRoot = path.join(location.localDir, FORMAT_UPGRADE_BACKUP_DIRECTORY);
  const [backupId] = readdirSync(backupRoot);
  assert.ok(backupId);
  const backupDir = path.join(backupRoot, backupId);
  const backupBytes = () => ({project: readFileSync(path.join(backupDir, 'project.mioon')), history: readOptional(path.join(backupDir, 'history.db')),
    manifest: readFileSync(path.join(backupDir, 'manifest.json'))});
  const liveBytes = () => ({project: readFileSync(projectFile), history: readOptional(historyFile)});
  return {root, projectFile, historyFile, backupDir, backupBytes, originalBytes, oldStamp, liveBytes, openOptions,
    restoreOptions: {projectFile, location, projectId, backupId, expected}};
}

type Fixture = ReturnType<typeof fixture>;

function assertRestored(f: Fixture, hasHistory: boolean): void {
  assert.deepEqual(f.liveBytes(), f.originalBytes, 'publish the complete original bytes of each backed-up database');
  const restored = openProjectStore(f.openOptions);
  try {
    assert.equal(restored.historyState, hasHistory ? 'current' : 'fresh');
    assert.equal(restored.db.prepare('PRAGMA project.user_version').get()?.user_version, PROJECT_FILE_SCHEMA_VERSION);
    assert.equal(restored.db.prepare('SELECT version FROM schema_version').get()?.version, HISTORY_SCHEMA_VERSION);
    assert.deepEqual(readProjectContentStamp(restored.db), {contentSequence: f.oldStamp.contentSequence, contentToken: f.oldStamp.contentToken});
    assert.deepEqual(restored.get('projects', restored.projectId), {id: restored.projectId, name: oldResource, revision: 1});
    assert.deepEqual(restored.db.prepare('SELECT resourceId FROM idempotency WHERE scope=? ORDER BY requestId').all(historyScope).map(row => row.resourceId),
      hasHistory ? [oldResource] : []);
  } finally {restored.close();}
}

function assertResult(f: Fixture, hasHistory: boolean, result: ReturnType<typeof restoreFormat4Backup>): void {
  const {projectId, backupId} = f.restoreOptions;
  assert.deepEqual(result, {projectId, backupId, projectVersion: PROJECT_FILE_SCHEMA_VERSION, historyVersion: hasHistory ? HISTORY_SCHEMA_VERSION : null});
}

function assertDisplacedPair(f: Fixture, before: ReturnType<Fixture['liveBytes']>): void {
  const {localDir} = f.restoreOptions.location;
  const archives = readdirSync(localDir).filter(name => /^format4-restore-[0-9a-f-]{36}$/u.test(name));
  assert.equal(archives.length, 1, 'a resumed restore keeps one displaced pair');
  const archive = path.join(localDir, archives[0]!);
  assert.deepEqual(readFileSync(path.join(archive, 'previous-project.mioon')), before.project);
  assert.deepEqual(readOptional(path.join(archive, 'previous-history.db')), before.history);
}

function killRestore(f: Fixture, phase: Format4RestoreBoundary): void {
  const killed = spawnSync(process.execPath, [worker, JSON.stringify(f.restoreOptions), phase], {
    stdio: 'ignore', timeout: 60_000,
  });
  assert.equal(killed.error, undefined);
  assert.equal(killed.signal, 'SIGKILL');
}

test('Windows refuses paired restore before touching any file', {skip: process.platform !== 'win32'}, t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-format4-restore-unsupported-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const projectFile = path.join(root, 'film.mioon');
  const location = {localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')};
  const original = Buffer.from('existing file');
  writeFileSync(projectFile, original);
  assert.throws(() => restoreFormat4Backup({projectFile, location, projectId: randomUUID(), backupId: randomUUID(),
    expected: {contentSequence: 1, contentToken: 'a'.repeat(32)}, onBoundary: () => assert.fail('must not stage on Windows')}),
    {code: 'PROJECT_FORMAT_RESTORE_UNSUPPORTED'});
  assert.deepEqual(readFileSync(projectFile), original);
  assert.deepEqual(readdirSync(root), ['film.mioon']);
});

for (const [label, backupHistory, currentHistory] of [
  ['an intact candidate pair', true, true],
  ['a missing live history with a retained old history', true, false],
  ['a backup that recorded no history', false, true],
  ['a missing history in both the backup and current location', false, false],
] as const) {
  test(`paired restore handles ${label} without changing the backup`, requiresRenameWhileHeld, t => {
    const f = fixture(t, backupHistory), before = f.backupBytes();
    if (!currentHistory) rmSync(f.historyFile);
    const displaced = f.liveBytes();
    assert.throws(() => openProjectStore(f.openOptions), {code: 'PROJECT_FORMAT_NEWER'});
    const result = restoreFormat4Backup(f.restoreOptions);
    assertResult(f, backupHistory, result);
    assertRestored(f, backupHistory);
    assertDisplacedPair(f, displaced);
    const reopened = openProjectStore(f.openOptions);
    try {reopened.put('projects', {id: reopened.projectId, name: 'New edit after restore', revision: 2});}
    finally {reopened.close();}
    const afterEdit = f.liveBytes();
    assert.deepEqual(restoreFormat4Backup(f.restoreOptions), result, 'replaying a completed confirmation cannot discard later edits');
    assert.deepEqual(f.liveBytes(), afterEdit);
    assert.deepEqual(f.backupBytes(), before);
  });
}

test('restoring only the project manually leaves newer history until the explicit paired recovery', requiresRenameWhileHeld, t => {
  const f = fixture(t);
  const candidateHistory = readFileSync(f.historyFile), manualFile = path.join(f.root, 'manually-restored.mioon');
  copyFileSync(path.join(f.backupDir, 'project.mioon'), manualFile);
  renameSync(manualFile, f.projectFile);
  assert.throws(() => openProjectStore(f.openOptions), {code: 'PROJECT_FORMAT_NEWER',
    details: {database: 'history', reason: 'format-newer', projectId: f.restoreOptions.projectId,
      formatVersion: FORMAT4_HISTORY_SCHEMA_VERSION, supportedFormatVersion: HISTORY_SCHEMA_VERSION}});
  assert.deepEqual(readFileSync(f.historyFile), candidateHistory);
  const {contentSequence, contentToken} = f.oldStamp;
  assertResult(f, true, restoreFormat4Backup({...f.restoreOptions, expected: {contentSequence, contentToken}}));
  assertRestored(f, true);
});

test('a changed candidate content pair or tampered backup leaves the live files untouched', requiresRenameWhileHeld, t => {
  const f = fixture(t), before = f.liveBytes();
  const wrongToken = f.restoreOptions.expected.contentToken === 'a'.repeat(32) ? 'b'.repeat(32) : 'a'.repeat(32);
  assert.throws(() => restoreFormat4Backup({...f.restoreOptions, expected: {...f.restoreOptions.expected, contentToken: wrongToken}}));
  assert.deepEqual(f.liveBytes(), before);
  const tampered = path.join(f.backupDir, 'history.db');
  const contents = readFileSync(tampered);
  contents[0] = contents[0]! ^ 1;
  writeFileSync(tampered, contents);
  assert.throws(() => restoreFormat4Backup(f.restoreOptions));
  assert.deepEqual(f.liveBytes(), before);
  assert.deepEqual(readFileSync(tampered), contents);
});

test('an orphan history rollback journal prevents restoring a missing history file', requiresRenameWhileHeld, t => {
  const f = fixture(t), journal = f.historyFile + '-journal';
  const orphan = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
  rmSync(f.historyFile);
  writeFileSync(journal, orphan);
  const before = f.liveBytes(), backup = f.backupBytes(), records = readdirSync(f.restoreOptions.location.localDir).sort();
  assert.throws(() => restoreFormat4Backup({...f.restoreOptions, onBoundary: () => assert.fail('must not prepare an orphaned history')}),
    {code: 'PROJECT_FORMAT_RESTORE_CONFLICT'});
  assert.deepEqual(f.liveBytes(), before);
  assert.deepEqual(f.backupBytes(), backup);
  assert.deepEqual(readFileSync(journal), orphan);
  assert.deepEqual(readdirSync(f.restoreOptions.location.localDir).sort(), records);
});

test('a held project refuses paired restore and keeps its live store writable', requiresRenameWhileHeld, t => {
  const f = fixture(t);
  const open = openProjectStore({...f.openOptions, format4: candidate});
  try {
    assert.throws(() => restoreFormat4Backup(f.restoreOptions), {code: 'PROJECT_LOCKED'});
    assert.equal(open.db.isOpen, true);
    assert.deepEqual(readProjectContentStamp(open.db), f.restoreOptions.expected);
    open.put('projects', {id: open.projectId, name: 'Held writer remains usable', revision: 3});
  } finally {open.close();}
});

test('the restore holds both native writer locks while publishing the ready intent', requiresRenameWhileHeld, t => {
  const f = fixture(t);
  let checked = false;
  const result = restoreFormat4Backup({...f.restoreOptions, onBoundary(phase) {
    if (phase !== 'ready') return;
    const probe = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import {DatabaseSync} from 'node:sqlite';
      import {strict as assert} from 'node:assert';
      for (const file of process.argv.slice(1)) {
        const db = new DatabaseSync(file, {timeout: 0});
        try {assert.throws(() => db.exec('BEGIN IMMEDIATE'), {errcode: 5});}
        finally {db.close();}
      }
    `, f.projectFile, f.historyFile], {stdio: 'ignore', timeout: 10_000});
    assert.equal(probe.error, undefined);
    assert.equal(probe.status, 0, 'a different process cannot acquire either SQLite write lock');
    checked = true;
  }});
  assert.equal(checked, true);
  assertResult(f, true, result);
  assertRestored(f, true);
});

test('restoring old project content invalidates derived thumbnails for candidate-only nodes', requiresRenameWhileHeld, t => {
  const f = fixture(t), nodeId = randomUUID(), at = '2026-11-13T00:00:00.000Z';
  const current = openProjectStore({...f.openOptions, format4: candidate});
  let expected: ReturnType<typeof readProjectContentStamp>;
  try {
    current.put('nodes', {id: nodeId, projectId: current.projectId, type: 'previs', label: 'Candidate only', text: '',
      position: {x: 0, y: 0}, revision: 1, sceneRevision: 1, scene: defaultPrevisScene(), createdAt: at});
    current.db.prepare("INSERT INTO cache.previs_thumbnails VALUES(?,'card',?,?,1,1,1,?,?)")
      .run(nodeId, current.projectId, 'a'.repeat(64), Buffer.from([0xff,0xd8,0xff,0xd9]), at);
    assert.deepEqual(foreignKeyCheck(current.db), []);
    expected = readProjectContentStamp(current.db);
  } finally {current.close();}
  assertResult(f, true, restoreFormat4Backup({...f.restoreOptions, expected}));
  const restored = openProjectStore(f.openOptions);
  try {
    assert.equal(restored.get('nodes', nodeId), null);
    assert.equal(restored.db.prepare('SELECT count(*) n FROM cache.previs_thumbnails').get()?.n, 0);
    assert.deepEqual(foreignKeyCheck(restored.db), []);
  } finally {restored.close();}
});

for (const phase of ['ready', 'history-published', 'project-published'] as const) {
  test(`paired restore resumes after SIGKILL at ${phase}`, requiresRenameWhileHeld, async t => {
    const f = fixture(t), backup = f.backupBytes(), before = f.liveBytes();
    killRestore(f, phase);
    assert.deepEqual(f.liveBytes(), {
      project: phase === 'project-published' ? f.originalBytes.project : before.project,
      history: phase === 'ready' ? before.history : f.originalBytes.history,
    });
    const pending = {code: 'PROJECT_FORMAT_RESTORE_PENDING'};
    assert.throws(() => openProjectStore({...f.openOptions, format4: candidate}), pending);
    if (phase === 'project-published') assert.throws(() => openProjectStore(f.openOptions), pending);
    const captureDirectory = path.join(f.root, 'capture');
    const readOptions = {projectFile: f.projectFile, historyFile: () => f.historyFile};
    for (const format4 of phase === 'project-published' ? [candidate, undefined] : [candidate]) {
      assert.throws(() => inspectClosedProjectForTrash({...readOptions, format4}), pending);
      await assert.rejects(captureClosedProjectSnapshot({...readOptions, format4, directory: captureDirectory}), pending);
      assert.equal(existsSync(captureDirectory), false);
    }
    assertResult(f, true, restoreFormat4Backup(f.restoreOptions));
    assertRestored(f, true);
    assertDisplacedPair(f, before);
    assert.deepEqual(f.backupBytes(), backup);
  });
}

test('re-entry refuses an inode substituted after restore preparation even when bytes match', requiresRenameWhileHeld, t => {
  const f = fixture(t);
  killRestore(f, 'ready');
  const replacement = path.join(f.root, 'same-bytes.mioon');
  copyFileSync(f.projectFile, replacement);
  renameSync(replacement, f.projectFile);
  const afterSwap = f.liveBytes();
  assert.throws(() => restoreFormat4Backup(f.restoreOptions));
  assert.deepEqual(f.liveBytes(), afterSwap);
  assert.throws(() => openProjectStore({...f.openOptions, format4: candidate}), {code: 'PROJECT_FORMAT_RESTORE_PENDING'});
});

test('re-entry does not publish another file if the displaced archive disappeared', requiresRenameWhileHeld, t => {
  const f = fixture(t);
  killRestore(f, 'history-published');
  const {localDir} = f.restoreOptions.location;
  const archives = readdirSync(localDir).filter(name => /^format4-restore-[0-9a-f-]{36}$/u.test(name));
  assert.equal(archives.length, 1);
  rmSync(path.join(localDir, archives[0]!, 'previous-history.db'));
  const before = f.liveBytes();
  assert.throws(() => restoreFormat4Backup(f.restoreOptions));
  assert.deepEqual(f.liveBytes(), before);
  assert.throws(() => openProjectStore({...f.openOptions, format4: candidate}), {code: 'PROJECT_FORMAT_RESTORE_PENDING'});
});
