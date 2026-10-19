import { comfyModuleModeFromEnvironment } from '../apps/server/src/comfy-module.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../apps/desktop/src/backend.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
const privateData = 'private-key-request-body-media-/Users/private/project';

function backendHarness({ close = async () => {}, start, diagnosticFailure = false,
  settingsClose = () => {}, imageClose = () => {} } = {}) {
  const port = new EventEmitter(), events = new EventEmitter();
  const messages = [], exits = [], intervals = [];
  let now = 100000;
  port.postMessage = message => {
    if (diagnosticFailure && message.type === 'exit-diagnostic') throw new Error(privateData);
    messages.push(JSON.parse(JSON.stringify(message)));
  };
  const sandbox = {
    comfyModuleModeFromEnvironment,
    process: { env: {}, parentPort: port, versions: { electron: '44.7.0', node: '24.19.0', sqlite: '3' },
      pid: 23456, on: events.on.bind(events), exit: code => exits.push(code) },
    __MIOON_DESKTOP_CHANNEL__: 'development',
    DatabaseSync: function () {},
    startServer: options => { assert.equal(options.comfyModule, 'load'); return (start ?? (async () => ({ close, url: 'http://127.0.0.1:43210' })))(options); },
    initializeSubtitleResources: () => {}, onMediaProcess: () => {},
    createAgentSettingsClient: () => ({ close: settingsClose }),
    createImageSecretClient: () => ({ close: imageClose, refreshStorage: async () => {} }),
    createNativeAudioPreviewAuthority: () => ({}),
    Date: class extends Date { static now() { return now; } },
    setInterval: callback => { intervals.push(callback); return intervals.length; },
    clearInterval: () => {}, setImmediate
  };
  vm.runInNewContext(source, sandbox, { filename: 'backend-exit-fixture.mjs' });
  return {
    messages, exits, events,
    diagnostics: () => messages.filter(message => message.type === 'exit-diagnostic'),
    start: () => port.emit('message', { data: { type: 'start', token: privateData,
      dataDir: privateData, distDir: privateData, subtitleResourcesDir: privateData } }),
    stop: () => port.emit('message', { data: { type: 'stop', reason: privateData } }),
    ping: () => port.emit('message', { data: { type: 'ping' } }),
    advance: milliseconds => { now += milliseconds; },
    checkLease: () => intervals[0]()
  };
}

const notice = reason => ({ type: 'exit-diagnostic', reason });

test('backend stop reports its first fixed exit intent once and preserves normal cleanup', async () => {
  let closes = 0;
  const runtime = backendHarness({ close: async () => { closes++; } });
  runtime.start(); await tick();
  runtime.stop(); runtime.events.emit('SIGTERM'); runtime.stop(); await tick();
  assert.deepEqual(runtime.diagnostics(), [notice('stop-requested')]);
  assert.deepEqual(runtime.exits, [0]);
  assert.equal(closes, 1);
  assert.equal(runtime.messages.filter(message => message.type === 'stopped').length, 1);
  assert.ok(!JSON.stringify(runtime.diagnostics()).includes(privateData));
});

test('backend lease distinguishes expiry from a recent ping without restarting work', async () => {
  let starts = 0;
  const runtime = backendHarness({ start: async () => { starts++; return { close: async () => {} }; } });
  runtime.start(); await tick();
  runtime.advance(30000); runtime.checkLease();
  assert.deepEqual(runtime.diagnostics(), []);
  runtime.ping(); runtime.advance(30000); runtime.checkLease();
  assert.deepEqual(runtime.diagnostics(), []);
  runtime.advance(1); runtime.checkLease(); await tick();
  assert.deepEqual(runtime.diagnostics(), [notice('lease-expired')]);
  assert.deepEqual(runtime.exits, [0]);
  assert.equal(starts, 1);
});

for (const [signal, reason] of [['SIGTERM', 'signal-term'], ['SIGINT', 'signal-int']]) {
  test(`backend ${signal} reports the explicit signal source`, async () => {
    const runtime = backendHarness();
    runtime.start(); await tick(); runtime.events.emit(signal); await tick();
    assert.deepEqual(runtime.diagnostics(), [notice(reason)]);
    assert.deepEqual(runtime.exits, [0]);
  });
}

for (const failure of ['server', 'agent-settings', 'image-secret']) {
  test(`backend ${failure} close failure adds a fixed failure notice`, async () => {
    const fail = () => { throw Object.assign(new Error(privateData), { code: privateData }); };
    const runtime = backendHarness({ close: failure === 'server' ? fail : undefined,
      settingsClose: failure === 'agent-settings' ? fail : undefined,
      imageClose: failure === 'image-secret' ? fail : undefined });
    runtime.start(); await tick(); runtime.stop(); await tick();
    assert.deepEqual(runtime.diagnostics(), [notice('stop-requested'), notice('shutdown-failed')]);
    assert.deepEqual(runtime.exits, [1]);
    assert.equal(runtime.messages.some(message => message.type === 'stopped'), false);
    assert.ok(!JSON.stringify(runtime.messages).includes(privateData));
  });
}

test('backend startup failure reports only a fixed category before nonzero exit', async () => {
  let starts = 0;
  const runtime = backendHarness({ start: async () => {
    starts++;
    throw Object.assign(new Error(privateData), { code: privateData, body: privateData });
  } });
  runtime.start(); await tick(); await tick();
  assert.deepEqual(runtime.diagnostics(), [notice('startup-failed')]);
  assert.deepEqual(runtime.exits, [1]);
  assert.equal(starts, 1);
  assert.equal(runtime.messages.some(message => message.type === 'ready'), false);
  assert.ok(!JSON.stringify(runtime.messages).includes(privateData));
});

test('backend monitors fatal origins without registering a handler that suppresses Node exit', () => {
  const runtime = backendHarness();
  assert.equal(runtime.events.listenerCount('uncaughtExceptionMonitor'), 1);
  assert.equal(runtime.events.listenerCount('uncaughtException'), 0);
  assert.equal(runtime.events.listenerCount('unhandledRejection'), 0);
  const error = Object.assign(new Error(privateData), { body: privateData, path: privateData });
  runtime.events.emit('uncaughtExceptionMonitor', error, 'uncaughtException');
  runtime.events.emit('uncaughtExceptionMonitor', error, 'unhandledRejection');
  assert.deepEqual(runtime.diagnostics(), [notice('uncaught-exception'), notice('unhandled-rejection')]);
  assert.deepEqual(runtime.exits, []);
  assert.ok(!JSON.stringify(runtime.messages).includes(privateData));
});

test('unavailable diagnostic IPC cannot cause a new failure or turn a clean stop into an error', async () => {
  const runtime = backendHarness({ diagnosticFailure: true });
  assert.doesNotThrow(() => runtime.events.emit('uncaughtExceptionMonitor', new Error(privateData), 'uncaughtException'));
  runtime.start(); await tick(); runtime.stop(); await tick();
  assert.deepEqual(runtime.exits, [0]);
  assert.equal(runtime.messages.at(-1).type, 'stopped');
});

for (const [origin, trigger] of [
  ['uncaught-exception', `setImmediate(() => { throw new Error(${JSON.stringify(privateData)}); });`],
  ['unhandled-rejection', `void Promise.reject(new Error(${JSON.stringify(privateData)}));`]
]) {
  test(`real Node ${origin} retains fatal exit behavior with the backend monitor`, { timeout: 5000 }, async t => {
    const script = `
      import vm from 'node:vm';
      const sandboxProcess = {
        parentPort: { on() {}, postMessage(message) {
          if (message.type === 'exit-diagnostic') process.stdout.write(JSON.stringify(message) + '\\n');
        } },
        versions: { electron: '44.7.0', node: process.versions.node },
        pid: process.pid, on: process.on.bind(process), exit: process.exit.bind(process)
      };
      vm.runInNewContext(${JSON.stringify(source)}, {
        process: sandboxProcess, DatabaseSync: function () {},
        createAgentSettingsClient: () => ({}), createImageSecretClient: () => ({}),
        onMediaProcess() {}, setInterval() { return 1; }, clearInterval() {}, setImmediate
      });
      ${trigger}
    `;
    const child = spawn(process.execPath, ['--unhandled-rejections=throw', '--input-type=module', '-e', script],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, NODE_OPTIONS: '' } });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null);
    assert.equal(code, 1);
    const output = Buffer.concat(chunks).toString('utf8');
    assert.deepEqual(output.trim().split('\n').map(line => JSON.parse(line)), [notice(origin)]);
    assert.ok(!output.includes(privateData));
  });
}
