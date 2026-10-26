import type {OpacityTasks} from './helpers/strict-opacity-fixture-types.ts';
import type {FixtureStore} from './helpers/strict-timeline-core-types.ts';
import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {upgradeOpacityWorkspace40To42 as upgrade} from '../packages/business/src/opacity-upgrade.ts';
import {opacityWorkspaceUpgradeResultSchema} from '../packages/contracts/src/opacity-upgrade.ts';
import {classifyCurrentWorkspaceSchema, openStore} from '../packages/business/src/db.ts';
import {classifyWorkspaceSchema42} from '../packages/business/src/workspace-schema-v42.ts';
import {initializeOpacityLegacyThrough40} from '../packages/business/src/workspace-opacity-legacy.ts';
import {reopenOpacityCandidateApplicationStore, getOpacityCandidateAssembly, isOpacityCandidateApplicationStore} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateApplicationServices} from '../packages/business/src/opacity-candidate-services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {createWorkspaceBackup, verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {acquireWorkspaceLock} from '../packages/business/src/workspace-lock.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {calculateWorkspaceScope} from '../packages/contracts/src/workspace-scope.ts';
import {opacityUpgradeFixture as seedFixture, upgradeFixtureStamp} from './helpers/opacity-upgrade-fixture.ts';
import {tree, logicalTables, originalRows, hash} from './helpers/opacity-backup-fixture.ts';

// These tests own all SQLite files and opaque media bytes. No executable,
// provider, decoder, listener, actual project, browser or CLI is permitted.
let childAttempts = 0, listenAttempts = 0, fetchAttempts = 0;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const)
  mock.method(cp, name, () => {childAttempts++; throw Error('No child process is allowed in offline upgrade tests');});
mock.method(net.Server.prototype, 'listen', ((() => {listenAttempts++; throw Error('No listener is allowed in offline upgrade tests');}) as unknown as typeof net.Server.prototype.listen));
mock.method(globalThis, 'fetch', ((() => {fetchAttempts++; throw Error('No network fetch is allowed in offline upgrade tests');}) as unknown as typeof globalThis.fetch));
syncBuiltinESMExports();
const mediaEvents: unknown[] = [], stopMedia = onMediaProcess(event => mediaEvents.push(event));
after(() => {
  stopMedia(); mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(childAttempts, 0); assert.equal(listenAttempts, 0); assert.equal(fetchAttempts, 0); assert.deepEqual(mediaEvents, []);
});

const args = (f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({source: f.source, backup: f.backup, destination: f.destination, channel: 'web'});
async function opacityUpgradeFixture(t: unknown, beforeFreeze?: ((context:import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeContext)=>unknown)|undefined) {
  const f = await (seedFixture(t, {beforeFreeze:beforeFreeze as import('./helpers/opacity-upgrade-fixture.ts').OpacityUpgradeOptions['beforeFreeze']}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture>);
  const remembered = {version: 1, workspaceScope: calculateWorkspaceScope({channel: 'web', root: f.source,
    directory: fs.statSync(f.source), db: fs.statSync(f.database)}), revision: 3, projectId: f.projectId, updatedAt: upgradeFixtureStamp};
  fs.writeFileSync(path.join(f.source, 'last-project-v1.json'), JSON.stringify(remembered) + '\n', {mode: 0o600});
  await (createWorkspaceBackup({source: f.source, destination: f.backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);
  assert.equal((await (verifyWorkspaceBackup({directory: f.backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>)).databaseSchemaVersion, 40);
  f.backupBefore = tree(f.backup); return f;
}
function readDatabase<T>(file: fs.PathLike, callback: (db:DatabaseSync)=>T) {
  // SQLite readOnly can still create WAL/SHM beside a WAL-mode database.
  // All inspection uses a disposable owned copy, preserving source/backup.
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-upgrade-read-'));
  const copy = path.join(scratch, 'workbench.sqlite'); fs.copyFileSync(file, copy); fs.chmodSync(copy, 0o600);
  let db;
  try {db = new DatabaseSync(copy, {readOnly: true}); return callback(db);}
  finally {try {db?.close();} finally {fs.rmSync(scratch, {recursive: true, force: true});}}
}
function mutateDatabase(f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture, callback: { (db: unknown): unknown; (arg0: DatabaseSync): void; }) {
  const db = new DatabaseSync(path.join(f.source, 'workbench.sqlite'));
  try {callback(db);} finally {db.close();}
}
function noPublication(destination: string) {
  assert.equal(fs.existsSync(path.join(destination, 'workbench.sqlite')), false, 'failure must not publish a launchable42 database');
  assert.equal(fs.existsSync(path.join(destination, 'server.lock')), false, 'operation releases only its own destination lock');
}
function noSourceChange(f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture, before: [string,Record<string,unknown>][]) {
  assert.deepEqual(tree(f.source), before, 'the original40 source bytes and layout remain intact');
  assert.deepEqual(tree(f.backup), f.backupBefore, 'upgrade never rewrites the verified original40 backup');
}
function ordinary40(f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) {
  return readDatabase(path.join(f.source, 'workbench.sqlite'), (db) => classifyCurrentWorkspaceSchema(db));
}
async function emptyLegacyBackup(f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) {
  const source = path.join(f.base, 'legacy-empty40'), backup = path.join(f.base, 'legacy-empty40-backup');
  fs.mkdirSync(source, {mode: 0o700}); const database = path.join(source, 'workbench.sqlite'), db = new DatabaseSync(database);
  try {db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;'); initializeOpacityLegacyThrough40(db);} finally {db.close();}
  fs.chmodSync(database, 0o600); await (createWorkspaceBackup({source, destination: backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);
  return {source, backup};
}
function assertRawPreserved(before: import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before'], db: DatabaseSync, omitNew42Marker = true) {
  for (const [table, {fields, rows}] of Object.entries(before))
    assert.deepEqual(originalRows(db, table, fields, omitNew42Marker && table === 'schema_version' ? 'WHERE version<>42' : ''), rows,
      `${table}: preserve original SQLite typed cells, raw JSON/BLOB bytes and rowids`);
}

test('explicit cold ordinary40 copy produces a verified original40 backup and independently reopenable ordinary42 application', async t => {
  const f = await opacityUpgradeFixture(t), before = tree(f.source);
  const original = readDatabase(path.join(f.source, 'workbench.sqlite'), logicalTables);
  assert.deepEqual(ordinary40(f), {schemaVersion: 40, profile: 'ordinary'});
  const result = await upgrade((args(f) as unknown as Parameters<typeof upgrade>[0]));
  assert.equal(opacityWorkspaceUpgradeResultSchema.safeParse(result).success, true);
  assert.equal(result.sourceVersion, 40); assert.equal(result.targetVersion, 42); assert.equal(result.profile, 'ordinary');
  assert.equal(result.publication, 'confirmed'); assert.equal(result.sourcePolicy, 'unchanged');
  assert.equal(result.preferencePolicy, 'preserved'); assert.equal(result.draftPolicy, 'excluded-empty-only'); assert.equal(result.taskPolicy, 'settled-only');
  const backup = await (verifyWorkspaceBackup({directory: f.backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);
  assert.equal(backup.databaseSchemaVersion, 40); assert.equal(backup.backupId, result.sourceBackupId);
  assert.deepEqual(fs.readFileSync(path.join(f.backup, 'payload/workbench.sqlite')), fs.readFileSync(path.join(f.source, 'workbench.sqlite')));
  assert.equal(result.sourceDbHash, hash(fs.readFileSync(path.join(f.source, 'workbench.sqlite'))));
  assert.equal(result.targetDbHash, hash(fs.readFileSync(path.join(f.destination, 'workbench.sqlite'))));
  assert.notEqual(result.targetDbHash, result.sourceDbHash);
  const manifestBytes = fs.readFileSync(path.join(f.backup, 'manifest.json'));
  assert.equal(result.manifestHash, hash(manifestBytes));
  assert.equal(fs.existsSync(path.join(f.source, 'server.lock')), false); assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false);
  for (const suffix of ['-wal', '-shm', '-journal'] as const) assert.equal(fs.existsSync(path.join(f.destination, 'workbench.sqlite' + suffix)), false);
  noSourceChange(f, before);
  readDatabase(path.join(f.destination, 'workbench.sqlite'), (db) => {
    assert.deepEqual(classifyWorkspaceSchema42(db), {schemaVersion: 42, profile: 'ordinary'});
    assertRawPreserved(((original) as unknown as Parameters<typeof assertRawPreserved>[0]), db);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'workspace_restore_%'").get()!.n, 0);
  });
  const mediaEntries = JSON.parse((manifestBytes as unknown as string)).entries.filter((entry: { role: string; }) => entry.role !== 'database');
  assert.ok(mediaEntries.length > 0, 'fixture contains actual managed opaque media files');
  for (const entry of mediaEntries) {
    const relative = entry.path.slice('payload/'.length);
    assert.deepEqual(fs.readFileSync(path.join(f.destination, relative)), fs.readFileSync(path.join(f.source, relative)));
    assert.equal(hash(fs.readFileSync(path.join(f.destination, relative))), entry.sha256);
  }
  const targetBefore = tree(f.destination), store = reopenOpacityCandidateApplicationStore(f.destination);
  const services = (createOpacityCandidateApplicationServices(store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityServices);
  try {
    assert.equal(isOpacityCandidateApplicationStore(store), true); assert.equal((getOpacityCandidateAssembly(store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityAssembly|null)!.getRestoreContext(), null);
    const page = await services.call('project.get', {projectId: f.projectId});
    assert.equal(page.project.id, f.projectId); assert.equal(page.timeline.id, f.timelineId);
    assert.equal(page.assets.some((asset) => asset.id === f.assetId), true); assert.equal(Object.hasOwn(page, 'restore'), false);
    assertRawPreserved(((original) as unknown as Parameters<typeof assertRawPreserved>[0]), store.db);
  } finally {await services.drain(); store.close();}
  assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false);
  // A reopened read can select WAL mode; logical evidence and all managed
  // media remain exact even when SQLite legitimately updates its header.
  assert.ok(targetBefore.some(([name]) => name === 'workbench.sqlite'));
  noSourceChange(f, before);
});

test('remembered project is explicitly rebound to the new path and database identity while view preference rows are byte-preserved', async t => {
  const f = await opacityUpgradeFixture(t), filename = 'last-project-v1.json';
  const old = JSON.parse((fs.readFileSync(path.join(f.source, filename), 'utf8') as string)), before = tree(f.source);
  const sourcePrefs = readDatabase(path.join(f.source, 'workbench.sqlite'), (db) => originalRows(db, 'workspace_preferences', ['projectId', 'revision', 'state']));
  await upgrade((args(f) as unknown as Parameters<typeof upgrade>[0]));
  const next = JSON.parse((fs.readFileSync(path.join(f.destination, filename), 'utf8') as string));
  assert.deepEqual({...next, workspaceScope: old.workspaceScope}, old);
  assert.notEqual(next.workspaceScope, old.workspaceScope);
  assert.equal(next.workspaceScope, calculateWorkspaceScope({channel: 'development', root: f.destination,
    directory: fs.statSync(f.destination), db: fs.statSync(path.join(f.destination, 'workbench.sqlite'))}));
  assert.equal(fs.statSync(path.join(f.destination, filename)).mode & 0o777, 0o600);
  readDatabase(path.join(f.destination, 'workbench.sqlite'), (db) => assert.deepEqual(originalRows(db, 'workspace_preferences', ['projectId', 'revision', 'state']), sourcePrefs));
  noSourceChange(f, before);
});

test('the source remains an ordinary40 workspace and its default40-to41 backup restore behavior is unchanged', async t => {
  const f = await opacityUpgradeFixture(t), before = tree(f.source);
  await upgrade((args(f) as unknown as Parameters<typeof upgrade>[0]));
  assert.deepEqual(ordinary40(f), {schemaVersion: 40, profile: 'ordinary'}); noSourceChange(f, before);
  const legacy = await emptyLegacyBackup(f), legacyBefore = tree(legacy.source), restored41 = path.join(f.base, 'default-restored41');
  const result = await (restoreWorkspaceBackup({directory: legacy.backup, destination: restored41}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceRestoreResult>);
  assert.equal(result.databaseSchemaVersion, 41); assert.equal(result.sourceSchema, 40); assert.equal(result.profile, 'restored-local-v9');
  assert.equal(Object.hasOwn(result, 'draftPolicy'), false); assert.equal(Object.hasOwn(result, 'taskPolicy'), false);
  assert.deepEqual(tree(legacy.source), legacyBefore);
  noSourceChange(f, before);
  const copy = path.join(f.base, 'fresh-default-backup40'), backup = await (createWorkspaceBackup({source: f.source, destination: copy}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);
  assert.equal(backup.databaseSchemaVersion, 40); assert.equal(Object.hasOwn(backup, 'draftPolicy'), false); noSourceChange(f, before);
});

test('ordinary42 cannot be silently admitted through the default production40 constructor and its logical rows remain intact', async t => {
  const f = await opacityUpgradeFixture(t); await upgrade((args(f) as unknown as Parameters<typeof upgrade>[0]));
  const before = readDatabase(path.join(f.destination, 'workbench.sqlite'), logicalTables);
  assert.throws(() => (openStore(f.destination) as unknown as FixtureStore));
  readDatabase(path.join(f.destination, 'workbench.sqlite'), (db) => assertRawPreserved(((before) as unknown as Parameters<typeof assertRawPreserved>[0]), (db as unknown as Parameters<typeof assertRawPreserved>[1]), false));
  assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false);
});

for (const token of [String(process.pid), '2147483647', 'invalid stale token', ''] as const)
  test(`upgrade refuses the preexisting source lock ${JSON.stringify(token)} without deleting or taking it over`, async t => {
    const f = await opacityUpgradeFixture(t), file = path.join(f.source, 'server.lock');
    fs.writeFileSync(file, token, {mode: 0o600}); const identity = fs.statSync(file), before = tree(f.source);
    await assert.rejects(upgrade((args(f) as unknown as Parameters<typeof upgrade>[0])));
    assert.equal(fs.statSync(file).ino, identity.ino); assert.equal(fs.readFileSync(file, 'utf8'), token);
    noSourceChange(f, before); noPublication(f.destination);
  });

test('a real active source lease remains owned after the upgrade is refused', async t => {
  const f = await opacityUpgradeFixture(t), lease = acquireWorkspaceLock(f.source), before = tree(f.source);
  try {await assert.rejects(upgrade((args(f) as unknown as Parameters<typeof upgrade>[0]))); assert.equal(lease.isOwned(), true); noSourceChange(f, before); noPublication(f.destination);}
  finally {assert.equal(lease.release(), true);}
});

for (const suffix of ['-wal', '-journal'] as const) test(`upgrade refuses nonempty ${suffix} and never repairs the cold-source failure`, async t => {
  const f = await opacityUpgradeFixture(t);
  fs.writeFileSync(path.join(f.source, 'workbench.sqlite') + suffix, 'owned synthetic uncheckpointed sidecar', {mode: 0o600}); const before = tree(f.source);
  await assert.rejects(upgrade((args(f) as unknown as Parameters<typeof upgrade>[0]))); noSourceChange(f, before); noPublication(f.destination);
});

for (const mutation of ['non-sqlite', 'bad-catalog', 'bad-project-json', 'dangling-media', 'bad-media-hash'] as const)
  test(`upgrade refuses corrupt ${mutation} without changing the source or publishing42`, async t => {
    const f = await opacityUpgradeFixture(t);
    if (mutation === 'non-sqlite') fs.writeFileSync(path.join(f.source, 'workbench.sqlite'), 'owned invalid SQLite', {mode: 0o600});
    else if (mutation === 'dangling-media' || mutation === 'bad-media-hash') {
      const asset = readDatabase(path.join(f.source, 'workbench.sqlite'), (db) => JSON.parse((db.prepare('SELECT data FROM assets WHERE id=?').get(f.assetId)!.data as string)));
      if (mutation === 'dangling-media') fs.unlinkSync(path.join(f.source, asset.relativePath));
      else fs.writeFileSync(path.join(f.source, asset.relativePath), 'changed opaque synthetic asset', {mode: 0o600});
    } else mutateDatabase(f, (((db: { exec: (arg0: string) => unknown; prepare: (arg0: string) => { (): unknown; new(): unknown; run: { (arg0: string,arg1: string): unknown; new(): unknown; }; }; }) => mutation === 'bad-catalog' ? db.exec('CREATE TABLE unknown_upgrade_family(id TEXT)') : db.prepare('UPDATE projects SET data=? WHERE id=?').run('{', f.projectId)) as unknown as Parameters<typeof mutateDatabase>[1]));
    const before = tree(f.source); await assert.rejects(upgrade((args(f) as unknown as Parameters<typeof upgrade>[0]))); noSourceChange(f, before); noPublication(f.destination);
  });

for (const target of ['destination'] as const) for (const populated of [false, true] as const)
  test(`upgrade preserves an existing ${populated ? 'nonempty' : 'empty'} ${target} directory`, async t => {
    const f = await opacityUpgradeFixture(t); fs.mkdirSync(f[target], {mode: 0o700});
    if (populated) fs.writeFileSync(path.join(f[target], 'sentinel'), 'unrelated owned bytes', {mode: 0o600});
    const sourceBefore = tree(f.source), before = tree(f[target]);
    await assert.rejects(upgrade((args(f) as unknown as Parameters<typeof upgrade>[0]))); assert.deepEqual(tree(f[target]), before); noSourceChange(f, sourceBefore);
    noPublication(f.destination);
  });

for (const populated of [false, true] as const) test(`upgrade refuses an ${populated ? 'nonempty' : 'empty'} directory that is not a complete40 backup`, async t => {
  const f = await opacityUpgradeFixture(t), invalidBackup = path.join(f.base, 'not-a-backup');
  fs.mkdirSync(invalidBackup, {mode: 0o700});
  if (populated) fs.writeFileSync(path.join(invalidBackup, 'sentinel'), 'unrelated backup bytes', {mode: 0o600});
  const before = tree(f.source), invalidBefore = tree(invalidBackup);
  await assert.rejects(upgrade(({...args(f), backup: invalidBackup} as unknown as Parameters<typeof upgrade>[0])));
  noSourceChange(f, before); assert.deepEqual(tree(invalidBackup), invalidBefore); noPublication(f.destination);
});

for (const kind of ['source-root', 'source-database', 'source-media-file', 'source-media-directory', 'backup-root', 'destination-root', 'destination-parent'] as const)
  test(`upgrade refuses ${kind} symlinks without following or changing their targets`, async t => {
    const f = await opacityUpgradeFixture(t), input = args(f);
    const outside = path.join(f.base, 'outside'), sentinel = path.join(outside, 'sentinel');
    fs.mkdirSync(outside, {mode: 0o700}); fs.writeFileSync(sentinel, 'outside source and target remain intact', {mode: 0o600});
    if (kind === 'source-root') {input.source = path.join(f.base, 'source-alias'); fs.symlinkSync(f.source, input.source);}
    if (kind === 'source-database') {const file = path.join(f.source, 'workbench.sqlite'); fs.renameSync(file, path.join(outside, 'workbench.sqlite')); fs.symlinkSync(path.join(outside, 'workbench.sqlite'), file);}
    if (kind === 'source-media-file') {
      const asset = readDatabase(path.join(f.source, 'workbench.sqlite'), (db) => JSON.parse((db.prepare('SELECT data FROM assets WHERE id=?').get(f.assetId)!.data as string)));
      fs.unlinkSync(path.join(f.source, asset.relativePath)); fs.symlinkSync(sentinel, path.join(f.source, asset.relativePath));
    }
    if (kind === 'source-media-directory') {fs.renameSync(path.join(f.source, 'media'), path.join(outside, 'media')); fs.symlinkSync(path.join(outside, 'media'), path.join(f.source, 'media'));}
    if (kind === 'backup-root') {
      fs.renameSync(f.backup, path.join(outside, 'archive40')); fs.symlinkSync(path.join(outside, 'archive40'), f.backup);
      f.backupBefore = tree(f.backup);
    }
    if (kind === 'destination-root') fs.symlinkSync(outside, f.destination);
    if (kind === 'destination-parent') {const alias = path.join(f.base, 'parent-alias'); fs.symlinkSync(outside, alias); input.destination = path.join(alias, 'new42');}
    const sourceBefore = tree(f.source), outsideBefore = tree(outside);
    await assert.rejects(upgrade((input as unknown as Parameters<typeof upgrade>[0]))); noSourceChange(f, sourceBefore); assert.deepEqual(tree(outside), outsideBefore);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside source and target remain intact');
    noPublication(input.destination);
  });

for (const change of [
(  f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({backup: f.source}), (f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({destination: f.source}), (f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({destination: f.backup}),
(  f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({backup: path.join(f.source, 'nested-backup')}), (f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({destination: path.join(f.source, 'nested-target')}),
(  f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({backup: f.base}), (f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({destination: f.base}),
(  f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({destination: path.join(f.backup, 'nested-target')}), (f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({backup: path.join(f.destination, 'nested-backup')}),
(  f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({source: `${f.source}/../${path.basename(f.source)}`}), (f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({backup: 'relative-backup'}), (f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) => ({destination: 'relative-target'}),
] as const) test('upgrade rejects overlapping, nested, relative or noncanonical explicit paths', async t => {
  const f = await opacityUpgradeFixture(t), before = tree(f.source);
  await assert.rejects(upgrade(({...args(f), ...change(f)} as unknown as Parameters<typeof upgrade>[0]))); noSourceChange(f, before); noPublication(f.destination);
});

test('an existing workspace ancestor prevents a nested upgrade destination even when the destination leaf is new', async t => {
  const f = await opacityUpgradeFixture(t), ancestor = path.join(f.base, 'unrelated-workspace');
  fs.mkdirSync(ancestor, {mode: 0o700}); fs.writeFileSync(path.join(ancestor, 'workbench.sqlite'), 'unrelated workspace marker', {mode: 0o600});
  const before = tree(f.source), unrelatedBefore = tree(ancestor), destination = path.join(ancestor, 'new42');
  await assert.rejects(upgrade(({...args(f), destination} as unknown as Parameters<typeof upgrade>[0]))); noSourceChange(f, before); assert.deepEqual(tree(ancestor), unrelatedBefore); noPublication(destination);
});

test('restored41 and already ordinary42 inputs remain separate profiles and are never relabeled as ordinary42', async t => {
  const f = await opacityUpgradeFixture(t);
  const legacy = await emptyLegacyBackup(f), restored41 = path.join(f.base, 'restored41');
  await (restoreWorkspaceBackup({directory: legacy.backup, destination: restored41}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceRestoreResult>);
  const restoredBefore = tree(restored41), restoredDestination = path.join(f.base, 'wrong41-to42');
  await assert.rejects(upgrade({source: restored41, backup: f.backup, destination: restoredDestination, channel: 'web'}));
  assert.deepEqual(tree(restored41), restoredBefore); noPublication(restoredDestination);
  await upgrade((args(f) as unknown as Parameters<typeof upgrade>[0]));
  const candidateBefore = tree(f.destination), second = path.join(f.base, 'wrong42-to42');
  await assert.rejects(upgrade({source: f.destination, backup: f.backup, destination: second, channel: 'web'}));
  assert.deepEqual(tree(f.destination), candidateBefore); noPublication(second);
});

test('a source with a new pending task beside acknowledged history is refused without resuming or rewriting either task', async t => {
  const f = await opacityUpgradeFixture(t, ({tasks, input: originalInput, timeline, projectId}) => {
    const input = {...originalInput, requestId: randomUUID(), expectedRevision: timeline.revision, patch: {name: 'New pending owned intent'}};
    const pending = tasks.prepare({projectId, operation: 'timeline.clip.update', input, origin: 'new'});
    assert.equal(pending.task.status, 'prepared'); assert.equal(pending.task.acknowledged, false);
  });
  const before = tree(f.source); await assert.rejects(upgrade((args(f) as unknown as Parameters<typeof upgrade>[0]))); noSourceChange(f, before); noPublication(f.destination);
});

test('ordinary42 exposes the copied project and new opacity edits while preserved acknowledged tasks do not reenter execution', async t => {
  const f = await opacityUpgradeFixture(t), sourceBefore = tree(f.source); await upgrade((args(f) as unknown as Parameters<typeof upgrade>[0]));
  const store = reopenOpacityCandidateApplicationStore(f.destination), services = (createOpacityCandidateApplicationServices(store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityServices);
  const tasks = (createEditTasks({store, services}) as unknown as OpacityTasks);
  try {
    const savedTask = originalRows(store.db, 'edit_tasks', ['position', 'id', 'input', 'status', 'revision', 'acknowledged', 'receiptDigest']);
    assert.deepEqual(tasks.reconcileStartup(), {processed: 0, unavailable: 0});
    assert.deepEqual(tasks.list({projectId: f.projectId}).items, []);
    const historical = tasks.get({projectId: f.projectId, taskId: f.taskId});
    assert.equal(historical.task.status, 'applied'); assert.equal(historical.task.acknowledged, true);
    assert.deepEqual(originalRows(store.db, 'edit_tasks', ['position', 'id', 'input', 'status', 'revision', 'acknowledged', 'receiptDigest']), savedTask);
    const page = await services.call('project.get', {projectId: f.projectId}), envelope = {
      profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: .35}, {frame: 30, opacity: 1}],
    };
    const saved = await services.call('timeline.clip.update', {projectId: f.projectId, requestId: randomUUID(),
      expectedRevision: page.timeline.revision, clipId: f.clipId, patch: {opacityEnvelope: envelope}});
    assert.deepEqual(saved.clips.find((clip) => clip.id === f.clipId)!.opacityEnvelope, envelope);
    assert.deepEqual((await services.call('timeline.undo', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: saved.revision})).clips.find((clip) => clip.id === f.clipId)!.opacityEnvelope ?? null, null);
    assert.equal(store.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='edit_tasks'").get()!.seq, 7001);
    assert.deepEqual(fs.readFileSync(path.join(f.destination, f.relativePath)), f.mediaBytes);
  } finally {await tasks.drain(); await services.drain(); store.close();}
  noSourceChange(f, sourceBefore);
});

for (const kind of ['missing', 'tampered-manifest', 'tampered-database', 'tampered-media'] as const)
  test(`upgrade refuses ${kind} backup evidence without repairing it`, async t => {
    const f = await opacityUpgradeFixture(t), input = args(f);
    if (kind === 'missing') input.backup = path.join(f.base, 'missing40-backup');
    if (kind === 'tampered-manifest') fs.appendFileSync(path.join(f.backup, 'manifest.json'), ' ');
    if (kind === 'tampered-database') fs.appendFileSync(path.join(f.backup, 'payload/workbench.sqlite'), 'x');
    if (kind === 'tampered-media') fs.appendFileSync(path.join(f.backup, 'payload', f.relativePath), 'x');
    const before = tree(f.source); f.backupBefore = tree(f.backup);
    await assert.rejects(upgrade((input as unknown as Parameters<typeof upgrade>[0]))); noSourceChange(f, before); noPublication(f.destination);
  });

for (const point of ['afterDatabase', 'beforePublish'] as const) test(`injected ${point} failure removes only this unpublished target and preserves source and backup`, async t => {
  const f = await opacityUpgradeFixture(t), before = tree(f.source); let reached = 0;
  await assert.rejects(upgrade(({...args(f), fault: (observed: string) => {if (observed === point) {reached++; throw Error('Owned synchronous fault');}}} as unknown as Parameters<typeof upgrade>[0])));
  assert.equal(reached, 1); noSourceChange(f, before); noPublication(f.destination);
  assert.equal(fs.existsSync(f.destination), false, 'no unowned replacement exists, so this operation can remove its empty target');
});

test('a fault after the atomic publication is uncertain and preserves the ordinary42 database rather than rolling back', async t => {
  const f = await opacityUpgradeFixture(t), before = tree(f.source); let reached = 0;
  await assert.rejects(upgrade(({...args(f), fault: (observed: string) => {if (observed === 'afterPublish') {reached++; throw Error('Owned postpublication fault');}}} as unknown as Parameters<typeof upgrade>[0])), error => {
    assert.match((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code, /PUBLICATION_UNCONFIRMED$/u); return true;
  });
  assert.equal(reached, 1); assert.equal(fs.existsSync(path.join(f.destination, 'workbench.sqlite')), true);
  readDatabase(path.join(f.destination, 'workbench.sqlite'), (db) => assert.deepEqual(classifyWorkspaceSchema42(db), {schemaVersion: 42, profile: 'ordinary'}));
  noSourceChange(f, before);
});

for (const phase of ['beforeStart', 'afterDatabase'] as const) test(`cancellation ${phase} cannot publish42 or mutate the original workspace and archive`, async t => {
  const f = await opacityUpgradeFixture(t), before = tree(f.source), controller = new AbortController(); let reached = 0;
  if (phase === 'beforeStart') controller.abort();
  await assert.rejects(upgrade(({...args(f), signal: controller.signal, fault: (observed: string) => {
    if (phase === 'afterDatabase' && observed === phase) {reached++; controller.abort();}
  }} as unknown as Parameters<typeof upgrade>[0])), error => {assert.match((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code, /CANCELLED$/u); return true;});
  assert.equal(reached, phase === 'beforeStart' ? 0 : 1); noSourceChange(f, before); noPublication(f.destination);
  assert.equal(fs.existsSync(f.destination), false);
});
