import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';

const APP_ID = 'app.starroy.mioon.dev';
const PLAINTEXT = JSON.stringify({audit: 'synthetic-only', value: 'not-a-real-credential'});
const CIPHERTEXT = Buffer.from(JSON.stringify({version: 1, appId: APP_ID, plaintext: PLAINTEXT})).toString('base64');
const available = {persistentAvailable: true, sessionScope: 'server', reasonCode: null};
const turn = () => new Promise(resolve => setImmediate(resolve));
const dataModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const sourceUrl = name => new URL('../apps/desktop/' + name, import.meta.url);
const slot = Object.freeze({gate: 0, entered: 1, finished: 2, beats: 3, beatsAtEntry: 4, quitEntered: 5, cleanup: 6, stopArmed: 7, stopSettled: 8, kills: 9});
function assertGateReleased(result) {
  assert.notEqual(result, 'timed-out', 'The test must release the gate before its safety cap');
  assert.ok(result === 'ok' || result === 'not-equal', 'Release may precede entry into Atomics.wait');
}

// Import audit: only these reviewed module bodies are evaluated. main.mjs and
// backend.mjs are never imported. Business validation/persistence dependencies
// are explicit test doubles, retained from the dependency-free Mac audit even
// when this checkout has dependencies. This is lifecycle, not schema acceptance.
async function auditedModules() {
  // identity.cjs is loaded by file URL, so check its dependencies separately.
  assert.doesNotMatch(readFileSync(sourceUrl('identity.cjs'), 'utf8'), /\bimport\b|\brequire\s*\(/,
    'New identity dependencies require a fresh import audit');
  const forbidden = () => { throw Error('Persistence is outside this audit'); };
  const stubs = new Map([
    ['@mioon/business/images/settings', dataModule(
      'export function validateImageSecretPlaintext(value) { if (value !== ' + JSON.stringify(PLAINTEXT) + ') throw Error("Not the synthetic fixture"); }\n' +
      'export const imageSettingsError = code => Object.assign(new Error("Synthetic settings error"), {code});')],
    ['@mioon/contracts', dataModule('export const IMAGE_SETTINGS_LIMITS = Object.freeze({ciphertextCharacters: 49152});')],
    ['@mioon/business/agent/settings', dataModule(
      'export const AGENT_CREDENTIAL_ACQUIRE = Symbol("audit-only");\n' +
      ['createAgentSettings', 'sanitizeAgentSettingsResult', 'sanitizeAgentSettingsError', 'parseAgentCredentialRequest', 'sanitizeAgentCredentialResult']
        .map(name => 'export const ' + name + ' = ' + forbidden.toString() + ';').join('\n'))],
    ['@mioon/business/agent/settings-file', dataModule('export const createAgentSettingsFile = ' + forbidden.toString() + ';')],
    ['@mioon/business/agent/config', dataModule('export const agentSettingsError = code => Object.assign(new Error("Synthetic settings error"), {code});')],
    ['@mioon/contracts/private-storage', dataModule('export const validatePrivateDirectory = ' + forbidden.toString() + ';')],
  ]);
  const imports = new Map([
    ['src/secret-store.mjs', {'../identity.cjs': sourceUrl('identity.cjs').href}],
    ['src/image-secret-store.mjs', {'./secret-store.mjs': 'src/secret-store.mjs'}],
    ['src/image-secret-broker.mjs', {}],
    ['src/secret-broker.mjs', {}],
    ['src/security.mjs', {}],
    ['src/shutdown.mjs', {}],
    ['src/supervisor.mjs', {'./security.mjs': 'src/security.mjs', './secret-broker.mjs': 'src/secret-broker.mjs', './image-secret-broker.mjs': 'src/image-secret-broker.mjs'}],
  ]);
  const builtins = new Set(['node:path', 'node:crypto', 'node:events']);
  const urls = new Map(), loaded = [];
  function moduleUrl(name) {
    if (urls.has(name)) return urls.get(name);
    assert.ok(imports.has(name), 'Only reviewed source modules may load');
    let source = readFileSync(sourceUrl(name), 'utf8');
    assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/, 'New dynamic dependencies require a fresh import audit');
    source = source.replace(/\bfrom\s+(['"])([^'"]+)\1/g, (_, quote, specifier) => {
      let target = stubs.get(specifier);
      if (!target && builtins.has(specifier)) target = specifier;
      if (!target && Object.hasOwn(imports.get(name), specifier)) {
        const dependency = imports.get(name)[specifier];
        target = dependency.startsWith('file:') ? dependency : moduleUrl(dependency);
      }
      assert.ok(target, 'Unreviewed module dependency: ' + specifier);
      return 'from ' + JSON.stringify(target);
    });
    // No side-effect imports are permitted outside the named imports above.
    assert.doesNotMatch(source, /\bimport\s*['"]/);
    loaded.push(name);
    const url = dataModule(source); urls.set(name, url); return url;
  }
  const codec = await import(moduleUrl('src/image-secret-store.mjs'));
  const broker = await import(moduleUrl('src/image-secret-broker.mjs'));
  const supervisor = await import(moduleUrl('src/supervisor.mjs'));
  const shutdown = await import(moduleUrl('src/shutdown.mjs'));
  return {...codec, ...broker, ...supervisor, ...shutdown, loaded};
}

function syntheticVault(before = () => {}) {
  return {
    isEncryptionAvailable() { before('status'); return true; },
    encryptString(value) { before('encrypt'); return Buffer.from(value); },
    decryptString(value) { before('decrypt'); return value.toString(); },
  };
}

async function mainSurrogate() {
  const api = await auditedModules();
  const state = new Int32Array(workerData.state);
  const child = new EventEmitter();
  let supervisor, blocked = false, probe;
  child.postMessage = message => {
    if (message.type === 'start') queueMicrotask(() => child.emit('message', {type: 'ready', url: 'http://127.0.0.1:43199/'}));
    else if (message.type === 'stop') {
      if (!workerData.stopBeforeBlock) queueMicrotask(() => child.emit('exit', 0));
    } else if (message.type === 'image-secret-codec-response') parentPort.postMessage({type: 'wire', message});
  };
  child.kill = () => { Atomics.add(state, slot.kills, 1); child.emit('exit', 0); };
  const codec = api.createDesktopImageSecretCodec({appId: APP_ID, platform: 'darwin', safeStorage: syntheticVault(operation => {
    if (blocked || operation !== workerData.operation) return;
    blocked = true;
    if (workerData.stopBeforeBlock) {
      Atomics.store(state, slot.stopArmed, 1);
      void supervisor.stop().then(() => {
        Atomics.store(state, slot.stopSettled, 1);
        parentPort.postMessage({type: 'stop-done'});
      }, error => {
        Atomics.store(state, slot.stopSettled, 2);
        parentPort.postMessage({type: 'stop-done', code: error.code});
      });
    }
    Atomics.store(state, slot.beatsAtEntry, Atomics.load(state, slot.beats));
    Atomics.store(state, slot.entered, 1);
    parentPort.postMessage({type: 'entered'});
    // Finite safety cap. Only the test thread releases this gate; no real OS
    // service, credential, native prompt, socket, or child process is involved.
    const result = Atomics.wait(state, slot.gate, 0, 8000);
    Atomics.store(state, slot.finished, 1);
    parentPort.postMessage({type: 'native-returned', result});
  })});
  supervisor = new api.BackendSupervisor({
    fork: () => child, modulePath: 'synthetic-not-executed', environment: {},
    stopTimeout: 20, terminateTimeout: 20, exitTimeout: 20,
    forceKill: () => { throw Error('No real PID signaling is allowed'); },
    imageSecretCodec: codec,
  });
  await supervisor.start({});
  probe = setInterval(() => Atomics.add(state, slot.beats, 1), 10);
  parentPort.on('message', message => {
    if (message.type === 'wire') child.emit('message', message.message);
    if (message.type === 'owned-exit' && supervisor.child === child) child.emit('exit', 0);
    if (message.type === 'quit') {
      Atomics.store(state, slot.quitEntered, 1);
      void api.stopBackendForQuit({backend: supervisor, cleanup: () => {
        Atomics.store(state, slot.cleanup, 1); clearInterval(probe);
      }}).then(() => parentPort.postMessage({type: 'quit-done'}), error => parentPort.postMessage({type: 'quit-done', code: error.code}));
    }
  });
  // Show that the main-loop probe worked before the injected stall.
  await new Promise(resolve => setTimeout(resolve, 30));
  parentPort.postMessage({type: 'ready'});
}

if (!isMainThread) {
  await mainSurrogate();
} else {
  const api = await auditedModules();
  test('reviewed imports and codec construction never invoke a native vault or persistence', () => {
    let calls = 0;
    const codec = api.createDesktopImageSecretCodec({appId: APP_ID, platform: 'darwin', safeStorage: syntheticVault(() => calls++)});
    assert.equal(calls, 0);
    assert.ok(!api.loaded.some(name => /\/(?:main|backend)\.mjs$/.test(name)));
    assert.equal(codec.decrypt(codec.encrypt(PLAINTEXT)), PLAINTEXT);
    assert.ok(calls > 0, 'Only explicitly requested operations use the injected fake');
  });

  test('real client arms a 2000 ms default and nonblocking broker/codec succeeds', async () => {
    const silentPort = new EventEmitter();
    silentPort.postMessage = () => {};
    const pendingClient = api.createImageSecretClient({port: silentPort});
    const delays = [], originalSetTimeout = globalThis.setTimeout;
    let pendingOutcome;
    try {
      // Capture the actual timer argument without depending on wall-clock
      // scheduling. No await occurs while the global timer is intercepted.
      globalThis.setTimeout = (callback, delay, ...args) => {
        delays.push(delay);
        return originalSetTimeout(callback, delay, ...args);
      };
      pendingOutcome = pendingClient.refreshStorage().then(() => 'unexpected-success', error => error.code);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      pendingClient.close();
    }
    assert.equal(await pendingOutcome, 'IMAGE_SECRET_CODEC_UNAVAILABLE');
    assert.deepEqual(delays, [2000], 'Pin the real default independently of elapsed-time assertions');

    const port = new EventEmitter();
    const codec = api.createDesktopImageSecretCodec({appId: APP_ID, platform: 'darwin', safeStorage: syntheticVault()});
    const broker = api.createImageSecretBroker({imageSecretCodec: codec, send: data => port.emit('message', {data})});
    port.postMessage = message => broker.handle(message);
    const client = api.createImageSecretClient({port});
    try {
      assert.equal(await client.decrypt(await client.encrypt(PLAINTEXT)), PLAINTEXT);
      assert.deepEqual(client.storage(), available);
    } finally { client.close(); broker.close(); }
  });

  test('broker close before its microtask prevents a vault operation that has not started', async () => {
    let calls = 0, replies = 0;
    const broker = api.createImageSecretBroker({imageSecretCodec: {
      storage() { calls++; return available; }, encrypt() { calls++; }, decrypt() { calls++; },
    }, send: () => replies++});
    broker.handle({type: 'image-secret-codec-request', version: 1, namespace: 'images', requestId: randomUUID(), operation: 'status'});
    broker.close(); await turn();
    assert.equal(calls, 0); assert.equal(replies, 0);
  });

  async function blockedFixture(t, operation, stopBeforeBlock = false) {
    const buffer = new SharedArrayBuffer(10 * Int32Array.BYTES_PER_ELEMENT), state = new Int32Array(buffer);
    const worker = new Worker(new URL(import.meta.url), {workerData: {state: buffer, operation, stopBeforeBlock}, execArgv: []});
    const port = new EventEmitter(), messages = [], sent = [];
    const waiters = new Set();
    let failure;
    const fail = error => {
      failure = error;
      for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
      waiters.clear();
    };
    worker.on('error', fail);
    worker.on('message', message => {
      messages.push(message);
      if (message.type === 'wire') port.emit('message', {data: message.message});
      for (const waiter of waiters) if (waiter.type === message.type) {
        clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(message);
      }
    });
    const wait = type => {
      if (failure) return Promise.reject(failure);
      const existing = messages.find(message => message.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {type, resolve, reject};
        waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(Error('Missing synthetic message: ' + type)); }, 6000);
        waiters.add(waiter);
      });
    };
    port.postMessage = message => { sent.push(message); worker.postMessage({type: 'wire', message}); };
    const client = api.createImageSecretClient({port}); // Actual default: 2000 ms.
    const release = () => { Atomics.store(state, slot.gate, 1); Atomics.notify(state, slot.gate); };
    t.after(async () => {
      release(); client.close();
      for (const waiter of waiters) clearTimeout(waiter.timer);
      await worker.terminate(); // The owned synthetic Worker only, never a PID.
    });
    await wait('ready');
    return {state, worker, client, messages, sent, wait, release};
  }

  for (const operation of ['status', 'encrypt', 'decrypt']) {
    test('default utility deadline leaves synchronous main ' + operation + ' running; main probe and queued quit wait', {timeout: 12000}, async t => {
      const f = await blockedFixture(t, operation);
      const begun = performance.now();
      const pending = operation === 'status' ? f.client.refreshStorage() : operation === 'encrypt' ? f.client.encrypt(PLAINTEXT) : f.client.decrypt(CIPHERTEXT);
      // Attach rejection handling before waiting for any cross-thread messages.
      const outcome = pending.then(value => ({value}), error => ({code: error.code}));
      await f.wait('entered');
      assert.equal(Atomics.load(f.state, slot.entered), 1);
      f.worker.postMessage({type: 'quit'});
      assert.deepEqual(await outcome, {code: 'IMAGE_SECRET_CODEC_TIMEOUT'});
      const elapsed = performance.now() - begun;
      assert.ok(elapsed >= 1900, 'Exercise the real two-second default, not a shortened timeout');
      assert.equal(Atomics.load(f.state, slot.finished), 0, 'Timeout did not stop the fake native operation');
      assert.ok(Atomics.load(f.state, slot.beatsAtEntry) > 0);
      assert.equal(Atomics.load(f.state, slot.beats), Atomics.load(f.state, slot.beatsAtEntry), 'Main-loop responsiveness probe is frozen');
      assert.equal(Atomics.load(f.state, slot.quitEntered), 0, 'Queued quit has not entered its main handler');
      assert.equal(Atomics.load(f.state, slot.cleanup), 0);
      assert.deepEqual(f.sent.map(message => message.operation), operation === 'status' ? ['status'] : ['status', operation]);
      f.release();
      assertGateReleased((await f.wait('native-returned')).result);
      assert.equal((await f.wait('quit-done')).code, undefined);
      assert.equal(Atomics.load(f.state, slot.cleanup), 1);
      const timedOutId = f.sent.at(-1).requestId;
      assert.ok(f.messages.some(message => message.type === 'wire' && message.message.requestId === timedOutId && message.message.ok), 'The exact timed-out main invocation eventually returned');
      assert.equal(f.client.storage().persistentAvailable, false, 'Late replies cannot restore timed-out availability');
      t.diagnostic(JSON.stringify({operation, clientElapsedMs: Math.round(elapsed), mainStillBlockedAtTimeout: true, queuedQuitDelayed: true, lateReplyIgnored: true}));
    });
  }

  test('an already-armed supervisor stop budget cannot fire on a synchronously blocked main loop', {timeout: 12000}, async t => {
    const f = await blockedFixture(t, 'encrypt', true);
    const outcome = f.client.encrypt(PLAINTEXT).then(() => 'unexpected-success', error => error.code);
    await f.wait('entered');
    assert.equal(await outcome, 'IMAGE_SECRET_CODEC_TIMEOUT');
    assert.equal(Atomics.load(f.state, slot.stopArmed), 1);
    assert.equal(Atomics.load(f.state, slot.stopSettled), 0, 'Synthetic 60 ms stop budget is already overdue');
    assert.equal(Atomics.load(f.state, slot.kills), 0, 'Scheduled child termination cannot run during the main stall');
    assert.equal(Atomics.load(f.state, slot.finished), 0);
    f.release();
    assertGateReleased((await f.wait('native-returned')).result);
    const stopped = await f.wait('stop-done');
    assert.ok(stopped.code === undefined || stopped.code === 'BACKEND_STOP_UNCONFIRMED');
    assert.ok(Atomics.load(f.state, slot.stopSettled) > 0);
    // Overdue termination and confirmation callbacks may race after release.
    // Supply only a synthetic owned-child exit if confirmation won that race.
    if (stopped.code) f.worker.postMessage({type: 'owned-exit'});
    f.worker.postMessage({type: 'quit'}); await f.wait('quit-done');
    assert.equal(Atomics.load(f.state, slot.cleanup), 1);
    t.diagnostic('Synthetic stop budget: 20 + 20 + 20 ms; still pending at the real 2000 ms client deadline. No real process was signaled.');
  });
}
