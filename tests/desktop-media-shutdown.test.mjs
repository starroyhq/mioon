import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { BackendSupervisor, BACKEND_STOP_BUDGET } from '../apps/desktop/src/supervisor.mjs';
import { stopBackendForQuit } from '../apps/desktop/src/shutdown.mjs';
import { createDesktopStartup } from '../apps/desktop/src/startup.mjs';
import { QuitCoordinator } from '../apps/desktop/src/lifecycle.mjs';
import { validateTools } from '../apps/desktop/src/config.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const syntheticFailure = 'synthetic-private-body-/never-show-this-path';

function fakeChild({ ready = true, graceful = false, termExit = false } = {}) {
  const child = new EventEmitter();
  child.pid = 34567;
  child.sent = [];
  child.termCalls = 0;
  child.postMessage = message => {
    child.sent.push(message);
    if (message.type === 'start' && ready) setImmediate(() => child.emit('message', {
      type: 'ready', url: 'http://127.0.0.1:43210', runtime: { pid: child.pid }
    }));
    if (message.type === 'stop' && graceful) setImmediate(() => child.emit('exit', 0));
  };
  child.kill = () => {
    child.termCalls++;
    if (termExit) child.emit('exit', 1);
    return true;
  };
  return child;
}

function supervisorFor(child, options = {}) {
  return new BackendSupervisor({ fork: () => child, modulePath: '/synthetic/backend.cjs', environment: {},
    stopTimeout: 10, terminateTimeout: 10, exitTimeout: 10, forceKill: () => {}, killMedia: () => {}, ...options });
}

test('utility shutdown has a finite 13-second default budget and rejects unbounded overrides', () => {
  assert.equal(Object.values(BACKEND_STOP_BUDGET).reduce((sum, value) => sum + value, 0), 13000);
  for (const value of [Infinity, -1, NaN, 60001]) {
    assert.throws(() => supervisorFor(fakeChild(), { exitTimeout: value }), /lifecycle budget/);
  }
});

test('graceful utility exit is confirmed without requesting any signal', async () => {
  const child = fakeChild({ graceful: true });
  let hardCalls = 0;
  const supervisor = supervisorFor(child, { forceKill: () => hardCalls++ });
  await supervisor.start({});
  assert.deepEqual(await supervisor.stop(), { exitConfirmed: true, forced: false, code: 0 });
  assert.equal(child.termCalls, 0);
  assert.equal(hardCalls, 0);
  assert.equal(supervisor.child, null);
});

test('a missing utility exit rejects within the budget without forgetting or restarting its child', async t => {
  const child = fakeChild(), killed = [];
  let hardCalls = 0, forks = 0;
  const supervisor = supervisorFor(child, { fork: () => { forks++; return child; },
    forceKill: owned => { assert.equal(owned, child); hardCalls++; }, killMedia: pid => killed.push(pid) });
  await supervisor.start({});
  child.emit('message', { type: 'media-process', event: 'started', pid: 45678 });
  // Drive all three timely phases causally; a delayed real event-loop turn may
  // legitimately reach the absolute deadline before the nested hard-stop timer.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = performance.now();
  const rejected = assert.rejects(supervisor.stop(), error => {
    assert.equal(error.code, 'BACKEND_STOP_UNCONFIRMED');
    assert.equal(error.exitConfirmed, false);
    assert.doesNotMatch(error.message, /34567|backend\.cjs/);
    return true;
  });
  t.mock.timers.tick(9); assert.equal(child.termCalls, 0); assert.equal(hardCalls, 0);
  t.mock.timers.tick(1); assert.equal(child.termCalls, 1); assert.equal(hardCalls, 0);
  t.mock.timers.tick(9); assert.equal(hardCalls, 0);
  t.mock.timers.tick(1); assert.equal(hardCalls, 1);
  t.mock.timers.tick(9); assert.equal(supervisor.state, 'stopping');
  t.mock.timers.tick(1); await rejected;
  assert.ok(performance.now() - started < 1000);
  assert.equal(supervisor.state, 'stop-unconfirmed');
  assert.equal(supervisor.child, child);
  assert.equal(supervisor.stopOutcome, null);
  assert.equal(child.termCalls, 1);
  assert.equal(hardCalls, 1);
  assert.equal(supervisor.mediaPids.has(45678), true);
  assert.deepEqual(killed, []);
  assert.throws(() => supervisor.start({}), /already active/);
  await assert.rejects(supervisor.stop(), { code: 'BACKEND_STOP_UNCONFIRMED' });
  child.emit('error', new Error(syntheticFailure));
  assert.equal(child.termCalls, 1);
  assert.equal(hardCalls, 1);
  assert.equal(forks, 1);
  child.emit('message', { type: 'media-process', event: 'exited', pid: 45678 });
  child.emit('exit', 9);
  assert.equal(supervisor.state, 'stopped');
  assert.equal(supervisor.child, null);
  assert.deepEqual(supervisor.stopOutcome, { exitConfirmed: true, forced: true, code: 9 });
  assert.deepEqual(killed, []);
  assert.equal(supervisor.mediaPids.size, 0);
});

test('delayed grace cannot extend the absolute utility deadline or signal after unconfirmed completion', async t => {
  const child = fakeChild();
  let hardCalls = 0, forks = 0;
  const supervisor = supervisorFor(child, { fork: () => { forks++; return child; },
    forceKill: owned => { assert.equal(owned, child); hardCalls++; } });
  await supervisor.start({});
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, cleared: false }; timers.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { if (timer) timer.cleared = true; });
  const rejected = assert.rejects(supervisor.stop(), { code: 'BACKEND_STOP_UNCONFIRMED', exitConfirmed: false });
  assert.deepEqual(timers.map(timer => timer.delay), [30, 10], 'absolute confirmation timer is armed before graceful phase');
  // Deliver grace late: its nested +10 ms hard-stop is still pending when the
  // original absolute deadline becomes runnable. No wall-clock sleep is needed.
  timers[1].callback();
  assert.equal(child.termCalls, 1); assert.equal(hardCalls, 0);
  assert.deepEqual(timers.map(timer => timer.delay), [30, 10, 10], 'late grace never reschedules the original deadline');
  timers[0].callback(); await rejected;
  assert.equal(supervisor.state, 'stop-unconfirmed');
  assert.equal(supervisor.child, child); assert.equal(supervisor.stopOutcome, null);
  assert.equal(timers[2].cleared, true);
  // Even already-queued callbacks must respect the completed attempt fence.
  timers[2].callback(); timers[1].callback();
  await assert.rejects(supervisor.stop(), { code: 'BACKEND_STOP_UNCONFIRMED' });
  assert.throws(() => supervisor.start({}), /already active/);
  assert.equal(child.termCalls, 1); assert.equal(hardCalls, 0); assert.equal(forks, 1);
  child.emit('exit', 9);
  assert.equal(supervisor.child, null); assert.equal(supervisor.state, 'stopped');
  assert.deepEqual(supervisor.stopOutcome, { exitConfirmed: true, forced: true, code: 9 });
});

test('throwing stop IPC and signals still have a fixed safe unconfirmed outcome', async () => {
  const child = fakeChild();
  const supervisor = supervisorFor(child, { forceKill: () => { throw new Error(syntheticFailure); } });
  await supervisor.start({});
  child.postMessage = () => { throw new Error(syntheticFailure); };
  child.kill = () => { throw new Error(syntheticFailure); };
  await assert.rejects(supervisor.stop(), error => {
    assert.equal(error.code, 'BACKEND_STOP_UNCONFIRMED');
    assert.ok(!JSON.stringify(error).includes(syntheticFailure));
    assert.ok(!error.message.includes(syntheticFailure));
    return true;
  });
  assert.equal(supervisor.child, child);
  child.emit('exit', 1);
});

test('confirmed forced utility exit is distinct from graceful shutdown', async () => {
  const child = fakeChild({ termExit: true });
  let hardCalls = 0;
  const supervisor = supervisorFor(child, { forceKill: () => hardCalls++ });
  await supervisor.start({});
  assert.deepEqual(await supervisor.stop(), { exitConfirmed: true, forced: true, code: 1 });
  assert.equal(child.termCalls, 1);
  assert.equal(hardCalls, 0);
});

test('utility close failure remains an error after a confirmed exit', async () => {
  const child = fakeChild();
  const supervisor = supervisorFor(child);
  await supervisor.start({});
  const stopping = supervisor.stop();
  child.emit('message', { type: 'shutdown-failed', code: syntheticFailure, message: syntheticFailure });
  child.emit('exit', 1);
  await assert.rejects(stopping, error => {
    assert.equal(error.code, 'BACKEND_STOP_FAILED');
    assert.equal(error.exitConfirmed, true);
    assert.ok(!error.message.includes(syntheticFailure));
    return true;
  });
  assert.equal(supervisor.child, null);
});

test('startup failure retains a live utility and stop fences its late ready message', async () => {
  const child = fakeChild({ ready: false });
  const supervisor = supervisorFor(child, { startupTimeout: 10 });
  await assert.rejects(supervisor.start({}), /超时/);
  assert.equal(supervisor.child, child);
  assert.throws(() => supervisor.start({}), /already active/);
  const stopping = supervisor.stop();
  child.emit('message', { type: 'ready', url: 'http://127.0.0.1:43210' });
  assert.equal(supervisor.state, 'stopping');
  child.emit('exit', 0);
  await stopping;
});

test('media tracking accepts only current trusted utility telemetry, fencing old-child messages', async () => {
  const first = fakeChild(), second = fakeChild({ graceful: true }), killed = [];
  let current = first;
  const supervisor = supervisorFor(first, { fork: () => current, killMedia: pid => killed.push(pid) });
  await supervisor.start({});
  first.emit('exit', 9);
  current = second;
  await supervisor.start({});
  for (const pid of [98760, 98761]) first.emit('message', { type: 'media-process', event: 'started', pid });
  for (const pid of [-2, 0, 1, 1.5, '98765', process.pid, second.pid]) {
    second.emit('message', { type: 'media-process', event: 'started', pid });
  }
  second.emit('message', { type: 'media-process', event: 'started', pid: 98763 });
  second.emit('message', { type: 'media-process', event: 'started', pid: 98764 });
  second.emit('message', { type: 'media-process', event: 'exited', pid: 98764 });
  second.emit('message', { type: 'media-process', event: 'unknown', pid: 98765 });
  await assert.rejects(supervisor.stop(), { code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED', mediaExitConfirmed: false });
  assert.deepEqual(killed, []);
  first.emit('message', { type: 'media-process', event: 'started', pid: 98766 });
  second.emit('message', { type: 'media-process', event: 'started', pid: 98767 });
  assert.deepEqual([...supervisor.mediaPids], [98763]);
  assert.equal(supervisor.hasUnconfirmedMedia, true);
  assert.throws(() => supervisor.start({}), { code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED' });
});

test('stale media PID never authorizes killing an unrelated replacement or clearing uncertainty', async () => {
  const child = fakeChild();
  let kills = 0, forks = 0;
  const supervisor = supervisorFor(child, { fork: () => { forks++; return child; } });
  await supervisor.start({});
  child.emit('message', { type: 'media-process', event: 'started', pid: 56789 });
  const originalKill = process.kill;
  try {
    // Trap the real API rather than a removed injection seam. This synchronous
    // fake-child section never sends a signal to any operating-system process.
    process.kill = () => { kills++; throw new Error('Unexpected PID-based signal'); };
    child.emit('exit', 1);
    // A numeric PID can now refer to any process. Even a late report from the
    // departed utility cannot prove which process currently owns that PID.
    child.emit('message', { type: 'media-process', event: 'exited', pid: 56789 });
    assert.equal(kills, 0);
  } finally { process.kill = originalKill; }
  assert.deepEqual([...supervisor.mediaPids], [56789]);
  assert.equal(supervisor.child, null);
  assert.throws(() => supervisor.start({}), { code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED' });
  await assert.rejects(supervisor.stop(), { code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED', exitConfirmed: true, mediaExitConfirmed: false });
  assert.equal(forks, 1);
});

test('native quit waits for the same unconfirmed child then cleans settings once, with no signal retry', async () => {
  const child = fakeChild();
  let hardCalls = 0, notices = 0, cleanups = 0, finishes = 0;
  const supervisor = supervisorFor(child, { forceKill: () => hardCalls++ });
  await supervisor.start({});
  let notified;
  const notice = new Promise(resolve => { notified = resolve; });
  const coordinator = new QuitCoordinator({ getWindow: () => null,
    stop: () => stopBackendForQuit({ backend: supervisor,
      onUnconfirmed: () => { notices++; notified(); }, cleanup: async () => { cleanups++; } }),
    finish: () => { finishes++; } });
  const pending = coordinator.request();
  await notice;
  assert.equal(coordinator.state, 'stopping');
  assert.equal(coordinator.request(), pending);
  assert.equal(cleanups, 0);
  assert.equal(finishes, 0);
  assert.equal(notices, 1);
  assert.equal(supervisor.child, child);
  child.emit('exit', 9);
  assert.equal(await pending, true);
  assert.equal(cleanups, 1);
  assert.equal(finishes, 1);
  assert.equal(child.termCalls, 1);
  assert.equal(hardCalls, 1);
  await coordinator.request();
  child.emit('exit', 9);
  assert.equal(cleanups, 1);
  assert.equal(finishes, 1);
});

test('native quit handles exit-before-listener and notification failure without losing cleanup', async () => {
  const child = fakeChild();
  let cleanups = 0;
  const backend = { child, stopOutcome: null, async stop() {
    this.child = null;
    this.stopOutcome = { exitConfirmed: true, forced: true, code: 9 };
    child.emit('exit', 9);
    throw Object.assign(new Error('fixed timeout'), { code: 'BACKEND_STOP_UNCONFIRMED', exitConfirmed: false });
  } };
  await stopBackendForQuit({ backend, onUnconfirmed: () => { throw new Error(syntheticFailure); },
    cleanup: async () => { cleanups++; } });
  assert.equal(cleanups, 1);
  assert.equal(child.listenerCount('exit'), 0);
});

test('native quit cleans only after confirmed failure and surfaces the failure without looping', async () => {
  const child = fakeChild();
  let cleanups = 0, finishes = 0, calls = 0;
  const supervisor = supervisorFor(child);
  await supervisor.start({});
  const coordinator = new QuitCoordinator({ getWindow: () => null,
    stop: () => { calls++; return stopBackendForQuit({ backend: supervisor, cleanup: async () => { cleanups++; } }); },
    finish: () => { finishes++; } });
  const pending = coordinator.request();
  child.emit('exit', 1);
  await assert.rejects(pending, { code: 'BACKEND_STOP_FAILED', exitConfirmed: true });
  await tick();
  assert.equal(calls, 1);
  assert.equal(cleanups, 1);
  assert.equal(finishes, 0);
  const main = await readFile(new URL('../apps/desktop/src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /quitCoordinator\.request\(\)\.catch\(quitFailed\)/);
  assert.doesNotMatch(main, /quitCoordinator\.request\(\)\.catch\(fatal\)/);
  assert.doesNotMatch(main, /finally\s*\{\s*await agentSettings\?\.close\(\)/);
});

test('real controlled utility ignores TERM, receives an owned hard stop and actually exits', {
  skip: process.platform === 'win32' ? 'POSIX signal behavior; native Windows process verification remains required' : false,
  timeout: 5000
}, async () => {
  const source = "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000);";
  const native = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'], env: {}, shell: false });
  const utility = new EventEmitter();
  utility.pid = native.pid;
  utility.kill = () => native.kill('SIGTERM');
  utility.postMessage = message => {
    if (message.type === 'start') setImmediate(() => utility.emit('message', {
      type: 'ready', url: 'http://127.0.0.1:43210', runtime: { pid: native.pid }
    }));
  };
  native.once('exit', (code, signal) => { utility.pid = undefined; utility.emit('exit', code ?? (signal ? 1 : 0)); });
  let hardCalls = 0;
  const supervisor = supervisorFor(utility, { stopTimeout: 20, terminateTimeout: 20, exitTimeout: 1000,
    forceKill: owned => { assert.equal(owned, utility); hardCalls++; native.kill('SIGKILL'); } });
  try {
    await once(native.stdout, 'data');
    await supervisor.start({});
    const result = await supervisor.stop();
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.forced, true);
    assert.equal(hardCalls, 1);
    assert.equal(native.signalCode, 'SIGKILL');
    assert.equal(supervisor.child, null);
  } finally {
    if (native.exitCode === null && native.signalCode === null) { native.kill('SIGKILL'); await once(native, 'exit'); }
    await supervisor.stop();
  }
});

test('desktop tool validation routes version and encoder checks through bounded media execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-tool-bounds-'));
  const ffmpeg = path.join(root, 'ffmpeg'), ffprobe = path.join(root, 'ffprobe');
  await Promise.all([writeFile(ffmpeg, 'inert', { mode: 0o700 }), writeFile(ffprobe, 'inert', { mode: 0o700 })]);
  const calls = [];
  const execute = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === '-version') return `${path.basename(file)} version synthetic\n`;
    return 'libx264 aac\n';
  };
  try { await validateTools({ ffmpeg, ffprobe }, { execute }); }
  finally { await rm(root, { recursive: true, force: true }); }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.args), [['-version'], ['-version'], ['-hide_banner', '-encoders']]);
  assert.deepEqual(calls.map(call => call.options), [
    { timeout: 10000, maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024 },
    { timeout: 10000, maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024 },
    { timeout: 10000, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 1024 * 1024 }
  ]);
});

test('desktop real version and encoder children reject synthetic secrets and injection variables', {
  skip: process.platform === 'win32' ? 'Executable shebang fixture; native Windows tool verification remains required' : false,
  timeout: 10000
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-tool-env-'));
  const env = { PATH: '/synthetic/tools', HOME: '/synthetic/home', LANG: 'C', TMPDIR: root,
    NODE_OPTIONS: '--require=/synthetic/never-execute', NODE_PATH: '/synthetic/modules', ELECTRON_RUN_AS_NODE: '1',
    RUNWAYML_API_SECRET: 'synthetic-provider', OPENAI_API_KEY: 'synthetic-agent', AWS_SECRET_ACCESS_KEY: 'synthetic-cloud',
    HTTP_PROXY: 'http://synthetic.invalid', HTTPS_PROXY: 'http://synthetic.invalid', ALL_PROXY: 'http://synthetic.invalid',
    FUTURE_UNRECOGNIZED_CREDENTIAL: 'synthetic-unknown', FFREPORT: 'file=synthetic-leak', LD_PRELOAD: '/synthetic/library' };
  const forbidden = Object.keys(env).filter(key => !['PATH', 'HOME', 'LANG', 'TMPDIR'].includes(key));
  try {
    const ffmpeg = path.join(root, '工具 ffmpeg'), ffprobe = path.join(root, '工具 ffprobe');
    for (const [file, name] of [[ffmpeg, 'ffmpeg'], [ffprobe, 'ffprobe']]) {
      await writeFile(file, `#!${process.execPath}\nif (${JSON.stringify(forbidden)}.some(key => process.env[key] !== undefined)) process.exit(20);\nif (process.env.PATH !== '/synthetic/tools' || process.env.HOME !== '/synthetic/home' || process.env.LANG !== 'C') process.exit(21);\nprocess.stdout.write(process.argv.includes('-encoders') ? 'libx264 aac\\n' : '${name} version synthetic\\n');\n`, { mode: 0o700 });
    }
    const url = new URL('../apps/desktop/src/config.mjs', import.meta.url).href;
    const source = `import {validateTools} from ${JSON.stringify(url)}; Object.assign(process.env,${JSON.stringify(env)}); await validateTools(${JSON.stringify({ ffmpeg, ffprobe })}); process.stdout.write('validated');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: {}, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr);
    assert.equal(stdout, 'validated');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aborted validation cannot start encoder inspection after late version completion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-tool-abort-'));
  const ffmpeg = path.join(root, 'ffmpeg'), ffprobe = path.join(root, 'ffprobe');
  await Promise.all([writeFile(ffmpeg, 'inert', { mode: 0o700 }), writeFile(ffprobe, 'inert', { mode: 0o700 })]);
  const controller = new AbortController(), calls = [], completions = [];
  let bothStarted;
  const started = new Promise(resolve => { bothStarted = resolve; });
  const execute = (file, args, options) => {
    calls.push(args);
    assert.equal(options.signal, controller.signal);
    return new Promise(resolve => {
      completions.push(() => resolve(`${path.basename(file)} version synthetic\n`));
      if (completions.length === 2) bothStarted();
    });
  };
  try {
    const validation = validateTools({ ffmpeg, ffprobe }, { execute, signal: controller.signal });
    const rejected = assert.rejects(validation, { code: 'MEDIA_CANCELLED' });
    await started;
    controller.abort();
    completions.forEach(finish => finish());
    await rejected;
    assert.deepEqual(calls, [['-version'], ['-version']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('startup abort drains only its signal and retains an unconfirmed owned validation child', async () => {
  let termCalls = 0, waitCalls = 0, notices = 0, confirm;
  const startup = createDesktopStartup({ terminate: async options => {
    termCalls++; assert.equal(options.signal, startup.signal); return [{ status: 'unconfirmed' }];
  }, wait: options => {
    waitCalls++; assert.equal(options.signal, startup.signal);
    return new Promise(resolve => { confirm = resolve; });
  } });
  const first = startup.abort({ onUnconfirmed: () => { notices++; } });
  assert.equal(startup.signal.aborted, true);
  assert.equal(startup.abort(), first);
  assert.throws(() => startup.checkpoint(), { code: 'DESKTOP_START_CANCELLED' });
  await tick();
  assert.equal(termCalls, 1); assert.equal(waitCalls, 1); assert.equal(notices, 1);
  confirm([{ status: 'exited' }]);
  await first;
});

async function mainStartupHarness({ validate, settings } = {}) {
  const source = (await readFile(new URL('../apps/desktop/src/main.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const app = new EventEmitter();
  const counts = { forks: 0, settings: 0, quits: 0, cleanup: 0, exits: [], notices: [] };
  Object.assign(app, { isPackaged: false, enableSandbox() {}, setName() {}, setAppUserModelId() {}, setDesktopName() {},
    commandLine: { appendSwitch() {} }, getPath: () => '/synthetic', requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), quit: () => { counts.quits++; }, exit: code => counts.exits.push(code) });
  const context = vm.createContext({ app, process: { platform: 'linux', env: {}, on() {} }, path,
    __MIOON_DESKTOP_CHANNEL__: 'development', desktopIdentity: { identityForChannel: () => ({ channel: 'development', productName: 'Synthetic', appId: 'synthetic' }) },
    prepareDesktopStorage: () => ({ userData: '/synthetic', dataDir: '/synthetic/workspace', configFile: '/synthetic/config' }),
    createDesktopStartup: () => createDesktopStartup({ terminate: async () => [] }),
    ensureDataIdentity: async () => {}, readToolConfig: async () => ({ ffmpeg: '/synthetic/ffmpeg', ffprobe: '/synthetic/ffprobe' }),
    validateTools: validate ?? (async () => ({ ffmpeg: '/synthetic/ffmpeg', ffprobe: '/synthetic/ffprobe' })),
    createDesktopAgentSettings: async () => { counts.settings++; return settings ? settings() : { close() {} }; }, safeStorage: {},
    BackendSupervisor: class { constructor() { counts.forks++; } },
    QuitCoordinator, stopBackendForQuit, removeConnectionOnShutdown: async () => { counts.cleanup++; },
    dialog: { showMessageBox: async message => { counts.notices.push(message); return { response: 0 }; } }
  });
  vm.runInContext(source, context, { filename: 'main-startup-fixture.mjs' });
  return { counts, start: () => vm.runInContext('start()', context), quit: () => vm.runInContext('quitCoordinator.request()', context),
    unknownMediaCrash: () => vm.runInContext('backend = {hasUnconfirmedMedia: true}; backendFailed()', context),
    failQuit: code => vm.runInContext(`quitFailed({code:${JSON.stringify(code)}})`, context) };
}

test('main quit aborts active tool validation and a late result cannot create backend or settings', async () => {
  let finish, signal;
  const runtime = await mainStartupHarness({ validate: (_, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  const starting = runtime.start();
  const rejected = assert.rejects(starting, { code: 'DESKTOP_START_CANCELLED' });
  await tick();
  assert.equal(signal.aborted, false);
  await runtime.quit();
  assert.equal(signal.aborted, true);
  finish({ ffmpeg: '/synthetic/ffmpeg', ffprobe: '/synthetic/ffprobe' });
  await rejected;
  assert.equal(runtime.counts.forks, 0);
  assert.equal(runtime.counts.settings, 0);
  assert.equal(runtime.counts.quits, 1);
  assert.equal(runtime.counts.cleanup, 1);
});

test('main quit during settings initialization closes late settings without creating a backend', async () => {
  let finish, closes = 0;
  const runtime = await mainStartupHarness({ settings: () => new Promise(resolve => { finish = resolve; }) });
  const starting = runtime.start();
  const rejected = assert.rejects(starting, { code: 'DESKTOP_START_CANCELLED' });
  await tick();
  await runtime.quit();
  finish({ close: async () => { closes++; } });
  await rejected;
  assert.equal(runtime.counts.forks, 0);
  assert.equal(runtime.counts.settings, 1);
  assert.equal(closes, 1);
});

test('main ready arriving after quit cannot create a fresh startup scope', async () => {
  let validationCalls = 0;
  const runtime = await mainStartupHarness({ validate: async () => { validationCalls++; } });
  await runtime.quit();
  await assert.rejects(runtime.start(), { code: 'DESKTOP_START_CANCELLED' });
  assert.equal(validationCalls, 0);
  assert.equal(runtime.counts.settings, 0);
  assert.equal(runtime.counts.forks, 0);
});

test('unconfirmed orphan media quit requires a fixed explicit exit warning and ends nonzero', async () => {
  const runtime = await mainStartupHarness();
  await Promise.all([runtime.unknownMediaCrash(), runtime.failQuit('BACKEND_MEDIA_EXIT_UNCONFIRMED')]);
  assert.deepEqual(runtime.counts.exits, [1]);
  assert.equal(runtime.counts.notices.length, 1);
  assert.equal(runtime.counts.notices[0].buttons[0], '退出应用');
  assert.match(runtime.counts.notices[0].message, /可能仍在运行/);
  assert.equal(runtime.counts.quits, 0);
});

test('native smoke explicitly skips unsafe orphan-crash recovery without counting it as a pass', async () => {
  const source = await readFile(new URL('../apps/desktop/src/smoke-checks.mjs', import.meta.url), 'utf8');
  assert.match(source, /skippedChecks\.push\(\{ name: 'active-render-utility-crash-media-ownership-recovery'/);
  assert.match(source, /checks, skippedChecks, screenshot/);
  assert.doesNotMatch(source, /active-render-utility-crash-kills-owned-ffmpeg-and-recovers|process\.kill\(getReady\(\)\.runtime\.pid|process\.kill\(pid, 0\)/);
  assert.match(source, /record\('crashed-backend-recovery-clears-stale-lock'\)/);
  assert.match(source, /record\('graceful-restart-interrupts-and-recovers-active-render'\)/);
});

async function backendHarness({ close = async () => {}, start, settingsClose = () => {}, imageClose = () => {}, imageRefresh = async () => {} } = {}) {
  const source = (await readFile(new URL('../apps/desktop/src/backend.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const port = new EventEmitter(), processEvents = new EventEmitter(), messages = [], exits = [];
  let enterStart; const started = new Promise(resolve => { enterStart = resolve; });
  port.postMessage = message => { messages.push(message); };
  const sandbox = { process: { parentPort: port, versions: { electron: '44.7.0', node: '24.19.0', sqlite: '3' },
    pid: 23456, on: processEvents.on.bind(processEvents), exit: code => exits.push(code) },
    __MIOON_DESKTOP_CHANNEL__: 'development',
    DatabaseSync: function () {}, startServer: options => { assert.equal(options.localDraftChannel,'development'); enterStart(options); return (start ?? (async () => ({ close, url: 'http://127.0.0.1:43210' })))(options); },
    initializeSubtitleResources: directory => { assert.equal(directory,'/synthetic/trusted/subtitles'); },
    onMediaProcess: () => {}, createAgentSettingsClient: () => ({ close: settingsClose }),
    createImageSecretClient: () => ({close: imageClose, refreshStorage: imageRefresh}),
    setInterval: () => 1, clearInterval: () => {}, setImmediate };
  vm.runInNewContext(source, sandbox, { filename: 'backend-lifecycle-fixture.mjs' });
  return { messages, exits, port, started, start: () => port.emit('message', { data: { type: 'start',subtitleResourcesDir:'/synthetic/trusted/subtitles' } }),
    stop: () => port.emit('message', { data: { type: 'stop' } }) };
}

test('backend shutdown reports a fixed failure and exits nonzero when close throws', async () => {
  let settingsCloses = 0;
  const runtime = await backendHarness({ close: async () => { throw new Error(syntheticFailure); },
    settingsClose: () => { settingsCloses++; } });
  runtime.start(); await tick(); runtime.stop(); await tick();
  assert.deepEqual(runtime.exits, [1]);
  assert.equal(settingsCloses, 1);
  assert.equal(runtime.messages.at(-1).type, 'shutdown-failed');
  assert.equal(runtime.messages.at(-1).code, 'BACKEND_STOP_FAILED');
  assert.ok(!JSON.stringify(runtime.messages).includes(syntheticFailure));
  assert.equal(runtime.messages.some(message => message.type === 'stopped'), false);
});

test('backend successful close emits stopped only once and exits zero', async () => {
  let closes = 0;
  const runtime = await backendHarness({ close: async () => { closes++; } });
  runtime.start(); await tick(); runtime.stop(); runtime.stop(); await tick();
  assert.deepEqual(runtime.exits, [0]);
  assert.equal(closes, 1);
  assert.equal(runtime.messages.filter(message => message.type === 'stopped').length, 1);
});

test('backend stop during startup suppresses a late ready and drains the created server', async () => {
  let finish, closes = 0;
  const runtime = await backendHarness({ start: () => new Promise(resolve => { finish = resolve; }) });
  runtime.start(); await runtime.started; runtime.stop();
  finish({ url: 'http://127.0.0.1:43210', close: async () => { closes++; } });
  await tick();
  assert.equal(runtime.messages.some(message => message.type === 'ready'), false);
  assert.equal(closes, 1);
  assert.deepEqual(runtime.exits, [0]);
});

test('backend startup and shutdown failures cannot serialize an arbitrary error code', async () => {
  const runtime = await backendHarness({ start: async () => { throw Object.assign(new Error(syntheticFailure), { code: syntheticFailure }); } });
  runtime.start(); await tick(); runtime.stop(); await tick();
  assert.equal(runtime.messages[0].code, 'BACKEND_START_FAILED');
  assert.ok(!JSON.stringify(runtime.messages).includes(syntheticFailure));
  assert.equal(runtime.messages.some(message => message.type === 'stopped'), false);
  assert.ok(runtime.exits.every(code => code === 1));
});

test('backend waits for image codec availability and closes its own narrow client on shutdown', async () => {
  let refreshed, closeCount=0; const gate=new Promise(resolve=>{refreshed=resolve;});
  const runtime=await backendHarness({imageRefresh:()=>gate,imageClose:()=>{closeCount++;}});
  runtime.start(); runtime.stop(); assert.equal(runtime.messages.length,0); assert.equal(closeCount,0);
  refreshed(); const options=await runtime.started; assert.equal(typeof options.imageSecretCodec.refreshStorage,'function');
  await tick(); assert.deepEqual(runtime.exits,[0]); assert.equal(closeCount,1); assert.equal(runtime.messages.some(v=>v.type==='ready'),false);
});
