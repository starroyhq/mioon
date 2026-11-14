import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type {MessagePortMain} from 'electron';
import { BackendSupervisor } from '../apps/desktop/src/supervisor.ts';
import { createDesktopProjectCatalogClient } from '../apps/desktop/src/project-catalog-port.ts';
import { QuitCoordinator, installUnsavedGuard } from '../apps/desktop/src/lifecycle.ts';
import { dataPaths, utilityEnvironment, readToolConfig, saveToolConfig, validateTool,
  writeConnection, removeConnection } from '../apps/desktop/src/config.ts';

test('desktop data location is stable and independent of working directory', () => {
  assert.deepEqual(dataPaths('/home/u/.config'), { userData: '/home/u/.config/app.starroy.mioon.dev',
    dataDir: '/home/u/.config/app.starroy.mioon.dev/data', configFile: '/home/u/.config/app.starroy.mioon.dev/desktop-config.json' });
  assert.equal(dataPaths('/x', '/explicit').dataDir, '/explicit/data');
  assert.throws(() => dataPaths('/x', './relative'));
});

test('utility process inherits only required provider configuration and explicit tools', () => {
  const env = utilityEnvironment({ PATH: '/poison', NODE_OPTIONS: '--require evil', ELECTRON_RUN_AS_NODE: '1',
    UNRELATED_API_KEY: 'secret', HOME: '/home/u', RUNWAYML_API_SECRET: 'provider-secret', MIOON_ENABLE_LIVE_PROVIDER: '0' },
  { ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe' });
  assert.equal(env.MIOON_FFMPEG_PATH, '/tools/ffmpeg'); assert.equal(env.MIOON_FFPROBE_PATH, '/tools/ffprobe');
  assert.equal(env.HOME, '/home/u'); assert.equal(env.RUNWAYML_API_SECRET, 'provider-secret');
  for (const key of ['PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'UNRELATED_API_KEY']) assert.equal(env[key], undefined);
});

test('FFmpeg config contains paths only, explicit env wins, and relative binaries fail', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-desktop-config-'));
  try {
    const file = path.join(directory, 'desktop-config.json');
    assert.deepEqual(await readToolConfig(file, {}), { ffmpeg: '', ffprobe: '' });
    await saveToolConfig(file, { ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe', secret: 'not persisted' } as unknown as Parameters<typeof saveToolConfig>[1]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readToolConfig(file, { MIOON_FFMPEG_PATH: '/override/ffmpeg' }), { ffmpeg: '/override/ffmpeg', ffprobe: '/tools/ffprobe' });
    assert.ok(!(await readFile(file, 'utf8')).includes('secret'));
    await assert.rejects(validateTool('ffmpeg', 'ffmpeg'), /绝对路径/);
    await assert.rejects(validateTool(directory, 'ffmpeg'), /不是可执行文件/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('MCP discovery uses private rotating files and cleanup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-desktop-discovery-'));
  const paths = dataPaths('/unused', directory);
  try {
    const descriptor = await writeConnection(paths, { url: 'http://127.0.0.1:12345', token: 'one', pid: process.pid });
    const connection = JSON.parse(await readFile(descriptor, 'utf8'));
    assert.equal((await stat(descriptor)).mode & 0o777, 0o600);
    assert.equal((await stat(connection.tokenFile)).mode & 0o777, 0o600);
    assert.equal(connection.version, 1); assert.equal(connection.pid, process.pid);
    assert.equal(await readFile(connection.tokenFile, 'utf8'), 'one\n');
    await writeConnection(paths, { url: 'http://127.0.0.1:22222', token: 'two', pid: process.pid });
    assert.equal(await readFile(connection.tokenFile, 'utf8'), 'two\n');
    await removeConnection(paths);
    await assert.rejects(readFile(descriptor), { code: 'ENOENT' });
    await assert.rejects(readFile(connection.tokenFile), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

type SupervisorOptions = ConstructorParameters<typeof BackendSupervisor>[0];
type FakeMessage = {type: string; token?: string} & Record<string, unknown>;
interface FakeChild extends EventEmitter {pid: number | undefined; messages: FakeMessage[]; transfer: unknown[] | undefined; postMessage(message: FakeMessage, transfer?: unknown[]): void; kill(): boolean}
function fakeChild(mode = 'ready'): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 12345;
  child.messages = [];
  child.postMessage = (message, transfer) => {
    if (transfer) child.transfer = transfer;
    child.messages.push(message);
    if (message.type === 'start' && mode === 'ready') setImmediate(() => child.emit('message', {
      type: 'ready', url: 'http://127.0.0.1:49123', runtime: { electron: '44.7.0', node: '24.21.0', pid: child.pid } }));
    if (message.type === 'stop') setImmediate(() => { child.pid = undefined; child.emit('exit', 0); });
  };
  child.kill = () => { setImmediate(() => { child.pid = undefined; child.emit('exit', 1); }); return true; };
  return child;
}

test('supervisor starts only a bundled utility and stops gracefully without host Node', async () => {
  const child = fakeChild(); let options: Record<string, unknown> | undefined;
  const supervisor = new BackendSupervisor({ fork: ((file: string, args: string[], opts: Record<string, unknown>) => {
    assert.equal(file, '/app/backend.cjs'); assert.deepEqual(args, []); options = opts; return child;
  }) as unknown as SupervisorOptions['fork'], modulePath: '/app/backend.cjs', environment: { MIOON_FFMPEG_PATH: '/bin/ffmpeg' } });
  const ready = await supervisor.start({ dataDir: '/data', cacheDir: '/cache', projectsDir: '/films', distDir: '/app/web', token: 'private' } as Parameters<typeof supervisor.start>[0]);
  assert.equal(ready.url, 'http://127.0.0.1:49123'); assert.equal(supervisor.state, 'running');
  assert.equal(options?.allowLoadingUnsignedLibraries, false); assert.equal(options?.stdio, 'ignore');
  assert.deepEqual(options?.execArgv, []); assert.equal(child.messages[0]?.token, 'private');
  assert.equal(child.messages[0]?.cacheDir, '/cache'); assert.equal(child.messages[0]?.projectsDir, '/films');
  await supervisor.stop(); assert.equal(supervisor.state, 'stopped');
  assert.equal(child.messages.at(-1)?.type, 'stop');
});

test('supervisor transfers a dedicated catalog channel without exposing backend credentials', async () => {
  const backend = fakeChild(), catalog = fakeChild('idle');
  catalog.pid = 23456;
  const channel = {port1: {close() {}}, port2: {close() {}}};
  const launches: Array<{modulePath: string; args: string[]; options: Parameters<SupervisorOptions['fork']>[2]}> = [];
  const supervisor = new BackendSupervisor({fork: (modulePath, args, options) => {
    launches.push({modulePath, args, options});
    return modulePath === '/app/backend.cjs' ? backend : catalog;
  }, modulePath: '/app/backend.cjs', environment: {HOME: '/home/u', MIOON_FFMPEG_PATH: '/bin/ffmpeg', RUNWAYML_API_SECRET: 'secret'},
  projectCatalog: {modulePath: '/app/project-catalog.cjs', createChannel: () => channel as ReturnType<NonNullable<SupervisorOptions['projectCatalog']>['createChannel']>}});
  const starting = supervisor.start({token: 'private'} as Parameters<typeof supervisor.start>[0]);
  await starting;
  assert.equal(supervisor.state, 'running');
  assert.equal(backend.transfer, undefined);
  catalog.emit('message', 'project-catalog-ready');
  assert.deepEqual(launches.map(launch => launch.modulePath), ['/app/backend.cjs', '/app/project-catalog.cjs']);
  assert.deepEqual(launches[1].args, []);
  assert.deepEqual(launches[1].options, {env: {HOME: '/home/u'}, stdio: 'ignore', serviceName: 'Mioon Project Catalog',
    allowLoadingUnsignedLibraries: false, execArgv: []});
  assert.deepEqual(catalog.messages, ['start-project-catalog']);
  assert.deepEqual(catalog.transfer, [channel.port1]);
  assert.deepEqual(backend.transfer, [channel.port2]);
  assert.deepEqual(backend.messages.at(-1), {type: 'project-catalog:attach', backendId: backend.messages[0]!.backendId, generation: 1});

  const stopping = supervisor.stop();
  await new Promise(resolve => backend.once('exit', resolve));
  assert.equal(supervisor.state, 'stopping');
  assert.throws(() => supervisor.start({} as Parameters<typeof supervisor.start>[0]), /already active/);
  // Real Electron disconnects the transferred port when the backend exits.
  catalog.emit('exit', 0);
  assert.deepEqual(await stopping, {exitConfirmed: true, forced: false, code: 0});
  assert.equal(supervisor.state, 'stopped');
});

test('a failed initial catalog transfer retires the helper while the backend stays ready', async () => {
  const backend = fakeChild(), catalog = fakeChild('idle');
  catalog.pid = 23456;
  catalog.postMessage = () => {throw new Error('private transfer error');};
  let closedPorts = 0;
  const port = {close: () => {closedPorts++;}};
  const supervisor = new BackendSupervisor({fork: file => file === '/app/backend.cjs' ? backend : catalog,
    modulePath: '/app/backend.cjs', environment: {},
    projectCatalog: {modulePath: '/app/project-catalog.cjs', createChannel: () =>
      ({port1: port, port2: port}) as ReturnType<NonNullable<SupervisorOptions['projectCatalog']>['createChannel']>}});
  const catalogExit = new Promise(resolve => catalog.once('exit', resolve));
  await supervisor.start({} as Parameters<typeof supervisor.start>[0]);
  assert.equal(closedPorts, 2);
  await catalogExit;
  assert.equal(supervisor.state, 'running');
  assert.equal(supervisor.child, backend);
  assert.equal(catalog.pid, undefined);
  await supervisor.stop();
  assert.equal(backend.pid, undefined);
  assert.equal(supervisor.child, null);
});

test('catalog crashes and abort retirements replace only the exact helper with bounded backoff', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const backend = fakeChild(), catalogs: FakeChild[] = [];
  const supervisor = new BackendSupervisor({
    fork: file => {
      if (file === '/app/backend.cjs') return backend;
      const worker = fakeChild('idle');
      worker.pid = 23456 + catalogs.length;
      catalogs.push(worker);
      return worker;
    },
    modulePath: '/app/backend.cjs', environment: {},
    projectCatalog: {modulePath: '/app/project-catalog.cjs', createChannel: () =>
      ({port1: {close() {}}, port2: {close() {}}}) as ReturnType<NonNullable<SupervisorOptions['projectCatalog']>['createChannel']>},
  });
  const waitForCatalog = (milliseconds: number, count: number): FakeChild => {
    t.mock.timers.tick(milliseconds - 1);
    assert.equal(catalogs.length, count - 1, 'restart honors the current backoff');
    t.mock.timers.tick(1);
    assert.equal(catalogs.length, count);
    return catalogs[count - 1]!;
  };
  const closeCatalog = (worker: FakeChild): void => {
    worker.pid = undefined;
    worker.emit('exit', 9);
  };
  const backendId = '11111111-1111-4111-8111-111111111111';
  const notice = (generation: number, owner = backendId) => ({type: 'project-catalog:retire', backendId: owner, generation});
  await supervisor.start({backendId} as Parameters<typeof supervisor.start>[0]);
  try {
    const first = catalogs[0]!;
    first.emit('message', 'project-catalog-ready');
    closeCatalog(first);
    assert.equal(catalogs.length, 1);
    assert.equal(supervisor.state, 'running');
    const second = waitForCatalog(250, 2);
    second.emit('message', 'project-catalog-ready');
    backend.emit('message', notice(1));
    backend.emit('message', notice(2, 'foreign'));
    first.emit('message', 'project-catalog-ready');
    t.mock.timers.tick(120);
    assert.equal(catalogs.length, 2);
    assert.ok(second.pid);

    const exited = new Promise(resolve => second.once('exit', resolve));
    let signalRequests = 0;
    second.kill = () => {signalRequests++; return true;};
    backend.emit('message', notice(2));
    backend.emit('message', notice(2));
    t.mock.timers.tick(150);
    assert.equal(signalRequests, 1);
    assert.equal(catalogs.length, 2, 'a signal request is not proof that the old helper exited');
    closeCatalog(second);
    await exited;
    const third = waitForCatalog(500, 3);
    third.emit('message', 'project-catalog-ready');
    closeCatalog(third);
    const fourth = waitForCatalog(1000, 4);
    fourth.emit('message', 'project-catalog-ready');
    closeCatalog(fourth);
    t.mock.timers.tick(60000);
    assert.equal(catalogs.length, 4);
    assert.equal(supervisor.state, 'running');
    assert.deepEqual(backend.messages.filter(message => message.type === 'project-catalog:attach').map(message => message.generation), [1, 2, 3, 4]);
  } finally {await supervisor.stop();}
});

test('backend catalog client fences dead and stale ports and resumes through the new port', async () => {
  class FakePort extends EventEmitter {
    readonly messages: unknown[] = [];
    started = false;
    closed = false;
    postMessage(message: unknown): void {this.messages.push(message);}
    start(): void {this.started = true;}
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    }
  }
  const backendId = '11111111-1111-4111-8111-111111111111';
  const notices: unknown[] = [];
  const client = createDesktopProjectCatalogClient(backendId, message => notices.push(message));
  const attach = (generation: number, port: FakePort, owner = backendId): void =>
    client.attach({type: 'project-catalog:attach', backendId: owner, generation}, [port as unknown as MessagePortMain]);
  const scan = [{file: path.resolve('/synthetic/project.mioon'), generation: '1:2:3:4:5', birthtime: '4', journalGeneration: null, checkHeader: true}];
  const result = {recovery: {state: 'clean'}, generation: scan[0]!.generation, birthtime: scan[0]!.birthtime};
  const aborted = new AbortController();
  await assert.rejects(client.scan(scan), {code: 'PROJECT_ENTRY_UNAVAILABLE'});
  const early = new FakePort();
  attach(1, early);
  assert.equal(early.started, true);
  const pending = assert.rejects(client.scan(scan, aborted.signal), {code: 'PROJECT_ENTRY_UNAVAILABLE'});
  aborted.abort();
  await pending;
  assert.equal(early.closed, true);
  assert.deepEqual(notices, [{type: 'project-catalog:retire', backendId, generation: 1}]);
  await assert.rejects(client.scan(scan), {code: 'PROJECT_ENTRY_UNAVAILABLE'});
  for (const [generation, owner] of [[1, backendId], [2, 'foreign']] as const) {
    const stale = new FakePort();
    attach(generation, stale, owner);
    assert.equal(stale.started, false);
    assert.equal(stale.closed, true);
  }
  const next = new FakePort();
  attach(2, next);
  const resumed = client.scan(scan);
  early.emit('message', {data: {type: 'project-catalog:result', id: 1, results: []}});
  next.emit('message', {data: {type: 'project-catalog:result', id: 1, results: [result]}});
  assert.deepEqual(await resumed, [result]);
  client.close();
  assert.equal(next.closed, true);
  assert.equal(notices.length, 1, 'closing the server cannot request a restart');
});

test('supervisor rejects wrong-origin handshakes and terminates that child', async () => {
  const child = fakeChild('idle');
  const supervisor = new BackendSupervisor({ fork: (() => child) as unknown as SupervisorOptions['fork'], modulePath: '/app/backend.cjs', environment: {} });
  const promise = supervisor.start({} as Parameters<typeof supervisor.start>[0]);
  child.emit('message', { type: 'ready', url: 'https://evil.example' });
  await assert.rejects(promise, /loopback/);
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(supervisor.state, 'failed');
});

test('supervisor bounds startup timeout and leaves a restartable failed state', async () => {
  const child = fakeChild('idle');
  const supervisor = new BackendSupervisor({ fork: (() => child) as unknown as SupervisorOptions['fork'], modulePath: '/app/backend.cjs', environment: {}, startupTimeout: 10 });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  await assert.rejects(supervisor.start({} as Parameters<typeof supervisor.start>[0]), /超时/); await exited;
  assert.equal(supervisor.state, 'failed');
});

test('supervisor reports unexpected utility crash instead of silently restarting submissions', async () => {
  const child = fakeChild();
  const supervisor = new BackendSupervisor({ fork: (() => child) as unknown as SupervisorOptions['fork'], modulePath: '/app/backend.cjs', environment: {} });
  await supervisor.start({} as Parameters<typeof supervisor.start>[0]);
  type ExitOutcome = {code: number; expected: boolean};
  const exit = new Promise<ExitOutcome>(resolve => supervisor.once('exit', outcome => resolve(outcome as ExitOutcome)));
  child.emit('exit', 9);
  assert.deepEqual(await exit, { code: 9, expected: false });
  assert.equal(supervisor.state, 'failed'); assert.equal(supervisor.child, null);
});

test('supervisor safely rejects a synchronous utility spawn failure', async () => {
  const supervisor = new BackendSupervisor({ fork: (() => { throw new Error('spawn unavailable'); }) as unknown as SupervisorOptions['fork'], modulePath: '/app/backend.cjs', environment: {} });
  await assert.rejects(supervisor.start({} as Parameters<typeof supervisor.start>[0]), /spawn unavailable/);
  assert.equal(supervisor.state, 'failed');
  await supervisor.stop();
});

test('utility crash preserves unknown media ownership without killing a possibly reused PID', async () => {
  const child = fakeChild(), killed: number[] = [];
  const supervisor = new BackendSupervisor({ fork: (() => child) as unknown as SupervisorOptions['fork'], modulePath: '/app/backend.cjs', environment: {}, killMedia: (pid: number) => killed.push(pid) } as unknown as SupervisorOptions);
  await supervisor.start({} as Parameters<typeof supervisor.start>[0]);
  for (const pid of [20001, 20002, -1, process.pid, child.pid]) child.emit('message', { type: 'media-process', event: 'started', pid });
  child.emit('message', { type: 'media-process', event: 'exited', pid: 20002 });
  const result = new Promise<void>(resolve => supervisor.once('exit', outcome => {
    assert.deepEqual(killed, []); assert.equal(outcome.mediaExitConfirmed, false); resolve();
  }));
  child.emit('exit', 9); await result;
  assert.equal(supervisor.mediaPids.size, 1);
  assert.equal(supervisor.state, 'media-unconfirmed');
  assert.throws(() => supervisor.start({} as Parameters<typeof supervisor.start>[0]), { code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED' });
  await assert.rejects(supervisor.stop(), { code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED' });
});

test('cancelled dirty-window quit keeps backend running and permits a later successful quit', async () => {
  type QuitWindowLike = EventEmitter & {webContents: EventEmitter; isDestroyed: () => boolean; close: () => void};
  const win = new EventEmitter() as QuitWindowLike; win.webContents = new EventEmitter(); win.isDestroyed = () => false;
  let discard = false, stopped = 0, finished = 0;
  const coordinator = new QuitCoordinator({ getWindow: () => win as unknown as ReturnType<ConstructorParameters<typeof QuitCoordinator>[0]['getWindow']>, stop: async () => stopped++, finish: () => finished++ });
  installUnsavedGuard(win as unknown as Parameters<typeof installUnsavedGuard>[0], { confirmDiscard: () => discard, onCancel: () => coordinator.cancel() });
  win.close = () => {
    let allowed = false;
    win.webContents.emit('will-prevent-unload', { preventDefault: () => { allowed = true; } });
    if (allowed) win.emit('closed');
  };
  assert.equal(await coordinator.request(), false);
  assert.equal(stopped, 0); assert.equal(finished, 0); assert.equal(coordinator.state, 'idle');
  discard = true;
  assert.equal(await coordinator.request(), true);
  assert.equal(stopped, 1); assert.equal(finished, 1); assert.equal(coordinator.state, 'finished');
});

test('repeated quit requests drain backend only once after renderer closes', async () => {
  const win = new EventEmitter() as EventEmitter & {isDestroyed: () => boolean; close: () => void};
  win.isDestroyed = () => false;
  let stopped = 0, closeCount = 0, finished = 0;
  win.close = () => { closeCount++; setImmediate(() => win.emit('closed')); };
  const coordinator = new QuitCoordinator({ getWindow: () => win as unknown as ReturnType<ConstructorParameters<typeof QuitCoordinator>[0]['getWindow']>, stop: async () => stopped++, finish: () => finished++ });
  const first = coordinator.request(), second = coordinator.request();
  assert.equal(first, second); await first;
  assert.equal(closeCount, 1); assert.equal(stopped, 1); assert.equal(finished, 1);
});
