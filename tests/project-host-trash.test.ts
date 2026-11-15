import {testEnv} from './helpers/test-env.ts';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {openProjectStore, isProjectFileHeld} from '../packages/business/src/project-file/index.ts';
import {createProjectHostManager, createProjectFiles} from '../apps/server/src/project-host/manager.ts';
import {createBackgroundCoordinator} from '../apps/server/src/project-host/background-coordinator.ts';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {createProjectTrash} from '../apps/server/src/project-host/trash.ts';
import type {ProjectTrashBoundary} from '../apps/server/src/project-host/trash.ts';
import {createProjectTrashRecords} from '../apps/server/src/project-host/trash-records.ts';
import {ProjectTrashRefusedError} from '../packages/contracts/src/project-trash-native.ts';
import type {ProjectTrashRequest} from '../packages/contracts/src/project-trash-native.ts';
import type {ProjectDeleteInput} from '../packages/contracts/src/project-lifecycle.ts';
import {startServer} from './helpers/test-server.ts';
import type {InspectApplication} from '../apps/server/src/index.ts';

function tree(directory: string): unknown {
  if (!existsSync(directory)) return null;
  return readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), info = lstatSync(file, {bigint: true});
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(isProjectFileHeld({dev: String(info.dev), ino: String(info.ino)}), false, 'never fs-read a held SQLite alias');
    return {name, dev: String(info.dev), ino: String(info.ino), size: info.isDirectory() ? null : String(info.size),
      bytes: info.isDirectory() ? tree(file) : readFileSync(file).toString('base64')};
  });
}
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
};
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-trash-host-'));
  const directories = serverAppDirectories(path.join(root, 'app'), {projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache')});
  const library = openAppLibrary({dataDir: directories.dataDir}), libraries = new Set([library]), owner = new AbortController();
  const assertAllowed = createProjectServiceApplication(library, owner.signal).assertMutationAllowed!;
  const entry = createProjectFiles({name: 'Trash source'}, {directories, registry: library.registry, identity: library.projectFileIdentity});
  const store = openProjectStore({projectFile: entry.projectFile, locate: id => projectLocation(directories, id)});
  store.tx(() => store.put('projects', {id: entry.projectId, name: entry.name, description: '', revision: 1,
    createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z'}));
  store.close();
  let interruptions = 0, reservations = 0, releases = 0, dispatches = 0;
  const osCalls: ProjectTrashRequest[] = [], unblock: Array<() => void> = [];
  const background = createBackgroundCoordinator({index: library.taskIndex, inbox: library.inbox,
    identity: library.projectFileIdentity, assertMutationAllowed: assertAllowed});
  const manager = createProjectHostManager({directories, registry: library.registry, identity: library.projectFileIdentity,
    taskIndex: library.taskIndex, assertMutationAllowed: assertAllowed,
    factory: async () => ({handle: async () => false, isBusy: () => false, interrupt() {interruptions++;},
      drain: async () => {}, dispose() {}})});
  background.bindManager(manager);
  const move = async (request: ProjectTrashRequest) => {
    assert.equal(isProjectFileHeld(entry.fileIdentity), false, 'the OS effect starts after the real source store closes');
    osCalls.push(request);
    renameSync(request.projectFile, path.join(root, `trashed-${request.requestId}.mioon`));
  };
  let native = move;
  let boundary: ((phase: ProjectTrashBoundary, input: ProjectDeleteInput) => void | Promise<void>) | undefined;
  let reserve: (() => void | Promise<void>) | undefined;
  const port = {async reserve() {
    reservations++; await reserve?.();
    return {async trash(request: ProjectTrashRequest) {dispatches++; await native(request);}, release() {releases++;}};
  }};
  const options = {manager, library, directories, signal: owner.signal, assertProjectFile: createApplicationFileGuard(directories),
    inspectProjectWork: background.inspectProjectWork, port,
    onBoundary: (phase: ProjectTrashBoundary, input: ProjectDeleteInput) => boundary?.(phase, input)};
  const trash = createProjectTrash(options), records = createProjectTrashRecords(directories.dataDir, assertAllowed);
  const input = (): ProjectDeleteInput => ({requestId: randomUUID(), projectId: entry.projectId,
    projectFile: entry.projectFile, fileIdentity: entry.fileIdentity, expectedRevision: 1, confirmTrash: true});
  const appRows = () => Object.fromEntries(['recent_projects', 'app_operation_receipts', 'outside_path_confirmations', 'project_inbox', 'background_task_index']
    .map(table => [table, library.db.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all()]));
  const snapshot = () => {
    assert.equal(isProjectFileHeld(entry.fileIdentity), false);
    return {source: existsSync(entry.projectFile) ? readFileSync(entry.projectFile).toString('base64') : null,
      records: tree(projectLocation(directories, entry.projectId).localDir), rows: appRows()};
  };
  t.after(async () => {
    for (const release of unblock) release();
    background.stop(); await manager.closeAll();
    for (const item of libraries) item.close();
    rmSync(root, {recursive: true, force: true});
  });
  return {root, directories, library, libraries, owner, entry, manager, background, trash, options, records, input, snapshot, appRows, osCalls, unblock, move,
    get interruptions() {return interruptions;}, get reservations() {return reservations;}, get releases() {return releases;}, get dispatches() {return dispatches;},
    setNative(fn: typeof native) {native = fn;}, setBoundary(fn: typeof boundary) {boundary = fn;}, setReserve(fn: typeof reserve) {reserve = fn;}};
}

test('closed-project trash commits one B1 receipt; identical concurrent calls and later path reuse never repeat the effect', async t => {
  const f = fixture(t), input = f.input(), entered = gate(), release = gate(); f.unblock.push(release.resolve);
  f.setNative(async request => {entered.resolve(); await release.promise; await f.move(request);});
  const one = f.trash.trash(input), two = f.trash.trash(input); await entered.promise;
  assert.equal(f.dispatches, 1); assert.equal(f.osCalls.length, 0); assert.equal(f.records.read(input.requestId)?.phase, 'dispatched');
  await assert.rejects(async () => f.trash.trash({...input, projectFile: path.join(f.root, 'Different.mioon')}), {code: 'REQUEST_ID_REUSED'});
  release.resolve(); const [first, second] = await Promise.all([one, two]);
  assert.deepEqual(first, second); assert.deepEqual(first, {requestId: input.requestId, projectId: input.projectId,
    projectFile: input.projectFile, trashed: true, records: 'retained'});
  assert.equal(f.library.registry.get(input.projectId), null); assert.equal(f.osCalls.length, 1); assert.equal(f.releases, 1);
  writeFileSync(input.projectFile, 'a later file at the former path');
  assert.deepEqual(await f.trash.trash(input), first);
  assert.equal(readFileSync(input.projectFile, 'utf8'), 'a later file at the former path'); assert.equal(f.osCalls.length, 1);
  assert.deepEqual(createProjectTrash(f.options).available, true);
  assert.deepEqual(await createProjectTrash(f.options).trash(input), first);
});

for (const mode of ['before-effect', 'after-effect'] as const) test(`unconfirmed native ${mode} blocks the original key, new keys and a new service without unregistering`, async t => {
  const f = fixture(t), input = f.input(), before = f.snapshot();
  f.setNative(async request => {if (mode === 'after-effect') await f.move(request); throw Error('synthetic lost OS acknowledgement');});
  await assert.rejects(f.trash.trash(input), {code: 'PROJECT_TRASH_UNCONFIRMED'});
  assert.deepEqual(f.appRows(), before.rows); assert.equal(f.records.read(input.requestId)?.phase, 'dispatched');
  assert.equal(f.osCalls.length, mode === 'after-effect' ? 1 : 0);
  if (mode === 'after-effect') writeFileSync(input.projectFile, 'replacement must survive');
  for (const service of [f.trash, createProjectTrash(f.options)]) {
    await assert.rejects(service.trash(input), {code: 'PROJECT_TRASH_UNCONFIRMED'});
    await assert.rejects(service.trash({...input, requestId: randomUUID()}), {code: 'PROJECT_TRASH_UNCONFIRMED'});
  }
  assert.equal(f.dispatches, 1);
  if (mode === 'after-effect') assert.equal(readFileSync(input.projectFile, 'utf8'), 'replacement must survive');
  else assert.equal(readFileSync(input.projectFile).toString('base64'), before.source);
  assert.deepEqual(tree(projectLocation(f.directories, input.projectId).localDir), before.records);
});

test('only a trusted pre-OS refusal is retryable under the original key', async t => {
  const f = fixture(t), input = f.input(), before = f.snapshot();
  f.setNative(async () => {throw new ProjectTrashRefusedError('PROJECT_TRASH_SOURCE_CHANGED');});
  await assert.rejects(f.trash.trash(input), {code: 'PROJECT_TRASH_SOURCE_CHANGED'});
  assert.equal(f.records.read(input.requestId)?.phase, 'not-started'); assert.equal(f.osCalls.length, 0); assert.deepEqual(f.snapshot(), before);
  f.setNative(f.move); const completed = await f.trash.trash(input);
  assert.equal(completed.trashed, true); assert.equal(f.dispatches, 2); assert.equal(f.osCalls.length, 1);
  assert.deepEqual(await f.trash.trash(input), completed); assert.equal(f.osCalls.length, 1);
});

test('B1 receipt failure rolls back deregistration and leaves a durable uncertain dispatch', async t => {
  const f = fixture(t), input = f.input(), before = f.appRows();
  f.library.db.exec("CREATE TEMP TRIGGER deny_trash_receipt BEFORE INSERT ON main.app_operation_receipts BEGIN SELECT RAISE(ABORT,'synthetic B1 write failure'); END;");
  await assert.rejects(f.trash.trash(input), {code: 'PROJECT_TRASH_UNCONFIRMED'});
  f.library.db.exec('DROP TRIGGER temp.deny_trash_receipt');
  assert.deepEqual(f.appRows(), before); assert.equal(f.osCalls.length, 1); assert.equal(existsSync(input.projectFile), false);
  assert.equal(f.records.read(input.requestId)?.phase, 'dispatched');
  await assert.rejects(f.trash.trash(input), {code: 'PROJECT_TRASH_UNCONFIRMED'});
  await assert.rejects(f.trash.trash({...input, requestId: randomUUID()}), {code: 'PROJECT_TRASH_UNCONFIRMED'});
  assert.equal(f.osCalls.length, 1);
});

for (const phase of ['trashed', 'before-receipt'] as const) test(`a pre-OS error type thrown at ${phase} cannot downgrade a completed OS effect`, async t => {
  const f = fixture(t), input = f.input(), before = f.appRows();
  f.setBoundary(current => {if (current === phase) throw new ProjectTrashRefusedError('PROJECT_HOST_BUSY');});
  await assert.rejects(f.trash.trash(input), {code: 'PROJECT_TRASH_UNCONFIRMED'});
  assert.equal(f.records.read(input.requestId)?.phase, 'dispatched'); assert.equal(f.osCalls.length, 1); assert.deepEqual(f.appRows(), before);
  writeFileSync(input.projectFile, 'later file after a known OS move');
  await assert.rejects(f.trash.trash(input), {code: 'PROJECT_TRASH_UNCONFIRMED'});
  await assert.rejects(f.trash.trash({...input, requestId: randomUUID()}), {code: 'PROJECT_TRASH_UNCONFIRMED'});
  assert.equal(readFileSync(input.projectFile, 'utf8'), 'later file after a known OS move'); assert.equal(f.osCalls.length, 1);
});

for (const mode of ['abort-before', 'reopen-before', 'abort-after-effect'] as const) test(`application write guard: ${mode}`, async t => {
  const f = fixture(t), input = f.input(), before = f.snapshot(), stopped = Error('synthetic owner retired');
  if (mode === 'abort-after-effect') {
    f.setBoundary(phase => {if (phase === 'trashed') f.owner.abort(stopped);});
    await assert.rejects(f.trash.trash(input), {code: 'PROJECT_TRASH_UNCONFIRMED'});
    assert.deepEqual(f.appRows(), before.rows); assert.equal(f.osCalls.length, 1);
  } else if (mode === 'abort-before') {
    f.owner.abort(stopped);
    await assert.rejects(async () => f.trash.trash(input), error => error === stopped);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.reservations, 0); assert.equal(f.osCalls.length, 0);
  } else {
    f.library.close(); const replacement = openAppLibrary({dataDir: f.directories.dataDir}); f.libraries.add(replacement);
    const changes = replacement.db.prepare('SELECT total_changes() AS n').get()!.n;
    await assert.rejects(async () => f.trash.trash(input), /live application library owner/u);
    assert.equal(replacement.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
    assert.equal(f.osCalls.length, 0); assert.equal(f.reservations, 0);
    assert.equal(readFileSync(input.projectFile).toString('base64'), before.source);
    assert.deepEqual(tree(projectLocation(f.directories, input.projectId).localDir), before.records);
  }
});

for (const phase of ['prepared', 'dispatched'] as const) test(`source replacement at ${phase} is refused before the OS and preserves the replacement`, async t => {
  const f = fixture(t), input = f.input(), before = f.appRows();
  f.setBoundary(current => {if (current === phase) {rmSync(input.projectFile); writeFileSync(input.projectFile, 'later source generation');}});
  await assert.rejects(f.trash.trash(input), {code: 'PROJECT_TRASH_SOURCE_CHANGED'});
  assert.equal(f.osCalls.length, 0); assert.equal(f.dispatches, 0); assert.deepEqual(f.appRows(), before);
  assert.equal(readFileSync(input.projectFile, 'utf8'), 'later source generation'); assert.equal(f.records.read(input.requestId)?.phase, 'not-started');
});

test('main window refusal precedes closing an idle real host', async t => {
  const f = fixture(t), lease = await f.manager.acquire(f.entry.projectId, 'request');
  lease.release();
  f.setReserve(() => {throw new ProjectTrashRefusedError('PROJECT_HOST_BUSY');});
  const rows = f.appRows();
  await assert.rejects(f.trash.trash(f.input()), {code: 'PROJECT_HOST_BUSY'});
  assert.equal(f.interruptions, 0); assert.equal(f.manager.status(f.entry.projectId)?.state, 'open');
  assert.equal(f.records.list().length, 0); assert.deepEqual(f.appRows(), rows); assert.equal(f.osCalls.length, 0);
});

for (const phase of ['prepared', 'active', 'blocked'] as const) test(`real S3 closed-project ${phase} work refuses trash without opening a host`, async t => {
  const f = fixture(t), input = f.input();
  f.library.taskIndex.upsert({projectId: input.projectId, projectFile: input.projectFile, kind: 'job', taskId: randomUUID(),
    indexedAt: '2026-11-05T00:00:00.000Z', phase, reason: phase === 'blocked' ? 'REMOTE_UNKNOWN' : null,
    sourceHistory: phase === 'prepared' ? null : 'a'.repeat(64), revision: 1, taskRevision: 1});
  const before = f.snapshot(); assert.equal(f.background.inspectProjectWork(input.projectId).mayWriteBack, true);
  await assert.rejects(f.trash.trash(input), {code: 'PROJECT_HOST_BUSY'});
  assert.equal(f.manager.status(input.projectId), null); assert.equal(f.interruptions, 0); assert.equal(f.reservations, 0);
  assert.equal(f.records.list().length, 0); assert.deepEqual(f.snapshot(), before);
});

test('real S3 closed-project inbox refuses trash; S3 is queried without resuming a worker', async t => {
  const f = fixture(t), input = f.input();
  f.library.inbox.add({id: randomUUID(), projectId: input.projectId, taskKind: 'job', taskId: randomUUID(),
    receivedAt: '2026-11-05T00:00:00.000Z', stagedMedia: []});
  const before = f.snapshot(); assert.equal(f.background.inspectProjectWork(input.projectId).pendingInbox, 1);
  await assert.rejects(f.trash.trash(input), {code: 'PROJECT_HOST_BUSY'});
  assert.deepEqual(f.snapshot(), before); assert.equal(f.reservations, 0); assert.equal(f.osCalls.length, 0);
});

test('an unsynced new intent-directory parent prevents dispatch and can be retried after durable storage recovers', async t => {
  const f = fixture(t), input = f.input(), before = f.snapshot(), parent = lstatSync(f.directories.dataDir, {bigint: true});
  const original = fs.fsyncSync; let rejected = 0;
  const blocked = Object.assign(Error('synthetic parent directory sync failure'), {code: 'EROFS'});
  const injected = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    const info = fs.fstatSync(fd, {bigint: true});
    if (info.isDirectory() && info.dev === parent.dev && info.ino === parent.ino) {rejected++; throw blocked;}
    return original(fd);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.trash.trash(input), error => error === blocked);
    assert.ok(rejected > 0); assert.equal(f.dispatches, 0); assert.equal(f.osCalls.length, 0); assert.deepEqual(f.snapshot(), before);
  } finally {injected.mock.restore(); syncBuiltinESMExports();}
  const completed = await f.trash.trash(input); assert.equal(completed.trashed, true); assert.equal(f.osCalls.length, 1);
});

test('an intent path alias of the held B1 is rejected before opening a second descriptor', async t => {
  const f = fixture(t), input = f.input();
  mkdirSync(f.records.root, {mode: 0o700});
  const alias = path.join(f.records.root, input.requestId + '.json');
  renameSync(f.library.databaseFile, alias);
  try {
    assert.throws(() => f.records.read(input.requestId), {code: 'PROJECT_TRASH_INTENT_INVALID'});
    const probe = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.argv[1],{timeout:0});
      try{db.exec('BEGIN EXCLUSIVE');db.exec('ROLLBACK');process.exitCode=2;}
      catch(error){if(!/locked|busy/i.test(String(error)))throw error;}
      finally{db.close();}
    `, alias], {env: testEnv(), encoding: 'utf8', timeout: 10_000});
    assert.equal(probe.error, undefined); assert.equal(probe.signal, null); assert.equal(probe.status, 0, probe.stderr);
    assert.equal(f.osCalls.length, 0);
  } finally {renameSync(alias, f.library.databaseFile);}
});

test('SIGKILL after the OS move and before its ACK keeps registration and never retries on restart or a later file', async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-trash-crash-'));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures/project-trash-crash-worker.ts'), root], {env: testEnv(), stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;}
    await server?.close(); rmSync(root, {recursive: true, force: true});
  });
  const input = await new Promise<ProjectDeleteInput>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('trash worker did not reach its durable OS boundary')), 20_000);
    timeout.unref();
    child.once('error', error => {clearTimeout(timeout); reject(error);});
    child.once('exit', (code, signal) => {clearTimeout(timeout); reject(Error(`trash worker exited before move: ${code}/${signal}`));});
    child.once('message', message => {
      clearTimeout(timeout); const value = message as {type: string; input: ProjectDeleteInput};
      if (value.type !== 'moved') reject(Error('unexpected trash worker event')); else resolve(value.input);
    });
  });
  assert.equal(existsSync(input.projectFile), false); const ended = once(child, 'exit'); child.kill('SIGKILL');
  const [code, signal] = await ended; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  let inspect!: InspectApplication, calls = 0;
  server = await startServer({dataDir: path.join(root, 'app'), projectsDir: path.join(root, 'projects'), port: 0,
    token: 'synthetic-project-trash-crash-token', comfyModule: 'skip', inspectApplication: value => {inspect = value;},
    projectTrash: {reserve: async () => ({trash: async () => {calls++;}, release() {}})}});
  const rows = () => inspect(db => db.prepare('SELECT data FROM recent_projects WHERE projectId=?').all(input.projectId));
  const before = rows(); assert.equal(before.length, 1);
  assert.ok(server.projectEntries.trash);
  await assert.rejects(server.projectEntries.trash(input), {code: 'PROJECT_TRASH_UNCONFIRMED'});
  writeFileSync(input.projectFile, 'same path, later file');
  await assert.rejects(server.projectEntries.trash({...input, requestId: randomUUID()}), {code: 'PROJECT_TRASH_UNCONFIRMED'});
  assert.equal(readFileSync(input.projectFile, 'utf8'), 'same path, later file'); assert.equal(calls, 0); assert.deepEqual(rows(), before);
  assert.equal(inspect(db => db.prepare("SELECT count(*) AS n FROM app_operation_receipts WHERE operation='project.delete'").get()!.n), 0);
});
