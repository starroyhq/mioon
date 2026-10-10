import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BackendSupervisor } from '../apps/desktop/src/supervisor.mjs';
import { QuitCoordinator, installUnsavedGuard } from '../apps/desktop/src/lifecycle.mjs';
import { dataPaths, utilityEnvironment, readToolConfig, saveToolConfig, validateTool,
  writeConnection, removeConnection } from '../apps/desktop/src/config.mjs';

test('desktop data location is stable and independent of working directory', () => {
  assert.deepEqual(dataPaths('/home/u/.config'), { userData: '/home/u/.config/app.starroy.mioon.dev',
    dataDir: '/home/u/.config/app.starroy.mioon.dev/workspace', configFile: '/home/u/.config/app.starroy.mioon.dev/desktop-config.json' });
  assert.equal(dataPaths('/x', '/explicit').dataDir, '/explicit/workspace');
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
    await saveToolConfig(file, { ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe', secret: 'not persisted' });
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

function fakeChild(mode = 'ready') {
  const child = new EventEmitter();
  child.pid = 12345;
  child.messages = [];
  child.postMessage = message => {
    child.messages.push(message);
    if (message.type === 'start' && mode === 'ready') setImmediate(() => child.emit('message', {
      type: 'ready', url: 'http://127.0.0.1:49123', runtime: { electron: '44.7.0', node: '24.21.0', pid: child.pid } }));
    if (message.type === 'stop') setImmediate(() => { child.pid = undefined; child.emit('exit', 0); });
  };
  child.kill = () => { setImmediate(() => { child.pid = undefined; child.emit('exit', 1); }); return true; };
  return child;
}

test('supervisor starts only a bundled utility and stops gracefully without host Node', async () => {
  const child = fakeChild(); let options;
  const supervisor = new BackendSupervisor({ fork: (file, args, opts) => {
    assert.equal(file, '/app/backend.cjs'); assert.deepEqual(args, []); options = opts; return child;
  }, modulePath: '/app/backend.cjs', environment: { MIOON_FFMPEG_PATH: '/bin/ffmpeg' } });
  const ready = await supervisor.start({ dataDir: '/data', distDir: '/app/web', token: 'private' });
  assert.equal(ready.url, 'http://127.0.0.1:49123'); assert.equal(supervisor.state, 'running');
  assert.equal(options.allowLoadingUnsignedLibraries, false); assert.equal(options.stdio, 'ignore');
  assert.deepEqual(options.execArgv, []); assert.equal(child.messages[0].token, 'private');
  await supervisor.stop(); assert.equal(supervisor.state, 'stopped');
  assert.equal(child.messages.at(-1).type, 'stop');
});

test('supervisor rejects wrong-origin handshakes and terminates that child', async () => {
  const child = fakeChild('idle');
  const supervisor = new BackendSupervisor({ fork: () => child, modulePath: '/app/backend.cjs', environment: {} });
  const promise = supervisor.start({});
  child.emit('message', { type: 'ready', url: 'https://evil.example' });
  await assert.rejects(promise, /loopback/);
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(supervisor.state, 'failed');
});

test('supervisor bounds startup timeout and leaves a restartable failed state', async () => {
  const child = fakeChild('idle');
  const supervisor = new BackendSupervisor({ fork: () => child, modulePath: '/app/backend.cjs', environment: {}, startupTimeout: 10 });
  const exited = new Promise(resolve => child.once('exit', resolve));
  await assert.rejects(supervisor.start({}), /超时/); await exited;
  assert.equal(supervisor.state, 'failed');
});

test('supervisor reports unexpected utility crash instead of silently restarting submissions', async () => {
  const child = fakeChild();
  const supervisor = new BackendSupervisor({ fork: () => child, modulePath: '/app/backend.cjs', environment: {} });
  await supervisor.start({});
  const exit = new Promise(resolve => supervisor.once('exit', resolve));
  child.emit('exit', 9);
  assert.deepEqual(await exit, { code: 9, expected: false });
  assert.equal(supervisor.state, 'failed'); assert.equal(supervisor.child, null);
});

test('supervisor safely rejects a synchronous utility spawn failure', async () => {
  const supervisor = new BackendSupervisor({ fork: () => { throw new Error('spawn unavailable'); }, modulePath: '/app/backend.cjs', environment: {} });
  await assert.rejects(supervisor.start({}), /spawn unavailable/);
  assert.equal(supervisor.state, 'failed');
  await supervisor.stop();
});

test('utility crash preserves unknown media ownership without killing a possibly reused PID', async () => {
  const child = fakeChild(), killed = [];
  const supervisor = new BackendSupervisor({ fork: () => child, modulePath: '/app/backend.cjs', environment: {}, killMedia: pid => killed.push(pid) });
  await supervisor.start({});
  for (const pid of [20001, 20002, -1, process.pid, child.pid]) child.emit('message', { type: 'media-process', event: 'started', pid });
  child.emit('message', { type: 'media-process', event: 'exited', pid: 20002 });
  const result = new Promise(resolve => supervisor.once('exit', outcome => {
    assert.deepEqual(killed, []); assert.equal(outcome.mediaExitConfirmed, false); resolve();
  }));
  child.emit('exit', 9); await result;
  assert.equal(supervisor.mediaPids.size, 1);
  assert.equal(supervisor.state, 'media-unconfirmed');
  assert.throws(() => supervisor.start({}), { code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED' });
  await assert.rejects(supervisor.stop(), { code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED' });
});

test('cancelled dirty-window quit keeps backend running and permits a later successful quit', async () => {
  const win = new EventEmitter(); win.webContents = new EventEmitter(); win.isDestroyed = () => false;
  let discard = false, stopped = 0, finished = 0;
  const coordinator = new QuitCoordinator({ getWindow: () => win, stop: async () => stopped++, finish: () => finished++ });
  installUnsavedGuard(win, { confirmDiscard: () => discard, onCancel: () => coordinator.cancel() });
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
  const win = new EventEmitter(); win.isDestroyed = () => false;
  let stopped = 0, closeCount = 0, finished = 0;
  win.close = () => { closeCount++; setImmediate(() => win.emit('closed')); };
  const coordinator = new QuitCoordinator({ getWindow: () => win, stop: async () => stopped++, finish: () => finished++ });
  const first = coordinator.request(), second = coordinator.request();
  assert.equal(first, second); await first;
  assert.equal(closeCount, 1); assert.equal(stopped, 1); assert.equal(finished, 1);
});
