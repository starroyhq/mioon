import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {openStore, openProjectStore} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/index.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createFileResponses} from '../apps/server/src/file-response.ts';
import {createProjectHostManager, serverAppDirectories} from '../apps/server/src/project-host/index.ts';
import {ProjectHostCleanupError} from '../apps/server/src/project-host/host.ts';
import type {ProjectHostContext, ProjectHostRuntime} from '../apps/server/src/project-host/host.ts';

function scratch(): string {
  return mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-host-file-safety-'));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};
}
function files(store: ProjectStore): string[] {
  return [store.projectFile, path.join(store.localDir, 'history.db'), path.join(store.cacheDir, 'cache.db')];
}
/** A separate process's native SQLite connection cannot release this process's
 * locks. An fs descriptor in this process would invalidate the evidence. */
function assertLocked(paths: readonly string[]): void {
  const script = `import {DatabaseSync} from 'node:sqlite';
const results=JSON.parse(process.argv[1]).map(file=>{let db;try{db=new DatabaseSync(file,{timeout:0});db.prepare('SELECT count(*) FROM sqlite_master').get();return 'readable';}catch(error){return error.errcode;}finally{db?.close();}});
process.stdout.write(JSON.stringify(results));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(paths)], {encoding: 'utf8', timeout: 10_000});
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), paths.map(() => 5), 'every held native database still reports SQLITE_BUSY');
}
async function responses(t: TestContext) {
  const root = scratch(), store = openStore(path.join(root, 'project')), library = testProjectAppLibrary(store); assert.ok(library);
  const held = [...files(store), library.databaseFile], opened: string[] = [];
  const response = createFileResponses({openFile: async (file, flags) => {opened.push(file); return open(file, flags);}});
  let selected = held[0]!, fallback: string | undefined;
  const server = createServer(async (req, res) => {
    try {await response.send(req, res, {file: selected, ...(fallback === undefined ? {} : {fallbackFile: fallback}), ranges: true});}
    catch (error) {
      const failure = error as {code?: unknown; status?: unknown};
      if (!res.headersSent && !res.destroyed) {res.writeHead(typeof failure.status === 'number' ? failure.status : 500); res.end(JSON.stringify({code: failure.code}));}
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {await response.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, {recursive: true, force: true});});
  return {root, store, held, opened, async request(file: string, options: {fallback?: string; method?: string; range?: string} = {}) {
    selected = file; fallback = options.fallback;
    return fetch(url, {method: options.method ?? 'GET', headers: {...(options.range ? {range: options.range} : {}), connection: 'close'}});
  }};
}

test('held project, history, cache and app files are refused before openFile and keep their native locks', async t => {
  const f = await responses(t); assertLocked(f.held);
  for (const file of f.held) for (const method of ['GET', 'HEAD']) {
    const response = await f.request(file, {method}); assert.equal(response.status, 404);
    if (method === 'GET') assert.deepEqual(await response.json(), {code: 'FILE_UNAVAILABLE'});
    else assert.equal(await response.text(), '');
  }
  assert.deepEqual(f.opened, []);
  assertLocked(f.held);
});

test('hard and symbolic aliases of all four held databases are refused before the filesystem opener', async t => {
  const f = await responses(t);
  for (const [index, file] of f.held.entries()) for (const kind of ['hard', 'symbolic']) {
    const alias = path.join(f.root, `${kind}-${index}.bin`);
    if (kind === 'hard') linkSync(file, alias); else symlinkSync(file, alias, 'file');
    const response = await f.request(alias);
    assert.equal(response.status, 404); assert.deepEqual(await response.json(), {code: 'FILE_UNAVAILABLE'});
    assert.deepEqual(f.opened, []);
  }
  assertLocked(f.held);
});

test('static fallback cannot open a held database through either kind of index.html alias', async t => {
  const f = await responses(t), missing = path.join(f.root, 'missing.js');
  for (const [index, file] of f.held.entries()) for (const kind of ['hard', 'symbolic']) {
    const directory = path.join(f.root, `static-${kind}-${index}`); mkdirSync(directory);
    const indexFile = path.join(directory, 'index.html');
    if (kind === 'hard') linkSync(file, indexFile); else symlinkSync(file, indexFile, 'file');
    const response = await f.request(missing, {fallback: indexFile});
    assert.equal(response.status, 404); assert.deepEqual(await response.json(), {code: 'FILE_UNAVAILABLE'});
    assert.ok(f.opened.every(file => file === missing), 'only the missing primary candidate reaches openFile');
    assert.equal(f.opened.includes(indexFile), false);
  }
  assertLocked(f.held);
});

test('ordinary full, range, HEAD and static fallback responses still use the real file stream', async t => {
  const f = await responses(t), file = path.join(f.root, 'ordinary.bin'), bytes = Buffer.from('synthetic ordinary content');
  writeFileSync(file, bytes, {mode: 0o600});
  let response = await f.request(file); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  response = await f.request(file, {range: 'bytes=2-5'}); assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(2, 6));
  response = await f.request(file, {method: 'HEAD'}); assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), String(bytes.length)); assert.equal(await response.text(), '');
  const missing = path.join(f.root, 'not-built.js');
  response = await f.request(missing, {fallback: file}); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(f.opened, [file, file, file, missing, file]);
  assertLocked(f.held);
});

function runtime(): ProjectHostRuntime {
  return {handle: async () => false, isBusy: () => false, interrupt() {}, drain: async () => {}, dispose() {}};
}
function managerFixture(t: TestContext, factory: (context: ProjectHostContext) => Promise<ProjectHostRuntime> = async () => runtime()) {
  const root = scratch(), directories = serverAppDirectories(path.join(root, 'app')), library = openAppLibrary({dataDir: directories.dataDir});
  const cleanup: (() => unknown)[] = [];
  let opens = 0;
  const manager = createProjectHostManager({directories, registry: library.registry, factory,
    openStore: options => {opens++; return openProjectStore(options);}});
  t.after(async () => {for (const close of cleanup) await close(); library.close(); rmSync(root, {recursive: true, force: true});});
  return {manager, library, beforeLibraryClose(close: () => unknown) {cleanup.push(close);}, get opens() {return opens;}};
}

test('closeAll waiting for a failed opening propagates unconfirmed cleanup and retains the real database locks', async t => {
  const gate = deferred(), entered = deferred(), failure = new ProjectHostCleanupError([new Error('synthetic pending publication')], 'synthetic cleanup unconfirmed');
  const opened: ProjectStore[] = [];
  const f = managerFixture(t, async context => {opened.push(context.store); entered.resolve(); await gate.promise; throw failure;});
  f.beforeLibraryClose(() => {for (const store of opened) store.close();});
  const project = await f.manager.create({name: 'Failed opening'}), opening = f.manager.acquire(project.projectId, 'request');
  void opening.catch(() => {});
  await entered.promise;
  assert.equal(f.manager.status(project.projectId)?.state, 'opening');
  const closing = f.manager.closeAll(); void closing.catch(() => {});
  gate.resolve();
  await assert.rejects(opening, error => error === failure);
  await assert.rejects(closing, error => error === failure);
  const held = opened[0]; assert.ok(held); assert.equal(held.db.isOpen, true);
  assert.equal(f.manager.status(project.projectId)?.state, 'closing');
  assertLocked([...files(held), f.library.databaseFile]);
  await assert.rejects(f.manager.closeAll(), error => error === failure);
});

test('inspection after closeAll rejects before reopening a project or invoking its callback', async t => {
  const f = managerFixture(t), project = await f.manager.create({name: 'Stopped inspection'});
  await f.manager.closeAll();
  const before = f.opens, rows = f.library.registry.list(); let inspected = false;
  assert.throws(() => f.manager.inspectProject(project.projectId, () => {inspected = true;}), {code: 'PROJECT_HOST_STOPPED', status: 503});
  assert.equal(inspected, false); assert.equal(f.opens, before); assert.equal(before, 0);
  assert.deepEqual(f.library.registry.list(), rows);
  assert.equal(f.manager.status(project.projectId), null);
});

test('a real task lease blocks exclusive work without revocation, then releasing it allows exclusive work', async t => {
  const f = managerFixture(t), project = await f.manager.create({name: 'Task lease'}), lease = await f.manager.acquire(project.projectId, 'task');
  f.beforeLibraryClose(() => f.manager.closeAll());
  const store = lease.host.store, before = store.db.prepare('SELECT total_changes() AS n').get(); let executions = 0;
  await assert.rejects(f.manager.withExclusive(project.projectId, () => {executions++;}), {code: 'PROJECT_HOST_BUSY', status: 409});
  assert.equal(executions, 0); assert.equal(lease.signal.aborted, false); assert.equal(store.db.isOpen, true);
  assert.equal(f.manager.status(project.projectId)?.leases.task, 1);
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS n').get(), before);
  assertLocked(files(store));
  lease.release();
  const result = await f.manager.withExclusive(project.projectId, entry => {executions++; return entry.projectId;});
  assert.equal(result, project.projectId); assert.equal(executions, 1); assert.equal(store.db.isOpen, false);
  assert.equal(f.manager.status(project.projectId), null);
});
