import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createDesktopLutRecoveryBridge } from '../apps/desktop/src/lut-recovery-preload.ts';
import { createDesktopOrBrowserLutRecovery, createBrowserClipLutRecovery, createClipLutRecovery } from '../apps/web/src/clip-lut-recovery.ts';
import { CLIP_LUT_RECOVERY_CHANNEL, ClipLutRecoveryError } from '../packages/contracts/src/clip-lut-recovery.ts';
const record = (change = {}) => ({ version: 1, workspaceScope: 'a'.repeat(64), projectId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', name: 'look.cube', sizeBytes: 30, sha256: 'b'.repeat(64), ...change });
const identity = () => ({ workspaceScope: record().workspaceScope, projectId: record().projectId });
const denied = { ok: false, code: 'LUT_RECOVERY_UNAVAILABLE' };
const codeIs = code => error => error instanceof ClipLutRecoveryError && error.code === code;
const bridgeWith = invoke => createDesktopLutRecoveryBridge({ invoke });
function forbidStorage(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let touched = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { touched++; throw new Error('localStorage must not be used'); } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; });
  return () => assert.equal(touched, 0);
}

test('preload exposes four frozen fixed-channel metadata operations, never arbitrary transport', async () => {
  const calls = [], bridge = bridgeWith(async (channel, request) => { calls.push([channel, request]); return { ok: true, value: request.action === 'read' ? record() : null }; });
  assert.deepEqual(Object.keys(bridge).sort(), ['complete', 'read', 'reserve', 'verify']); assert.equal(Object.isFrozen(bridge), true);
  const read = await bridge.read(identity()); assert.deepEqual(read, { ok: true, value: record() });
  assert.equal(Object.isFrozen(read), true); assert.equal(Object.isFrozen(read.value), true);
  for (const action of ['reserve', 'verify', 'complete']) assert.deepEqual(await bridge[action](record()), { ok: true, value: null });
  assert.deepEqual(calls.map(([channel]) => channel), Array(4).fill(CLIP_LUT_RECOVERY_CHANNEL));
  assert.deepEqual(calls.map(([, request]) => request.action), ['read', 'reserve', 'verify', 'complete']);
  assert.deepEqual(calls[0][1], { action: 'read', identity: identity() });
  assert.equal(CLIP_LUT_RECOVERY_CHANNEL, 'mioon:lut-recovery:v1');
});

test('invalid metadata and accessors never reach IPC and responses never leak diagnostics', async () => {
  let calls = 0, getters = 0;
  const bridge = bridgeWith(async () => { calls++; return { ok: true, value: null }; });
  const accessor = Object.defineProperty(record(), 'name', { enumerable: true, get() { getters++; return 'look.cube'; } });
  for (const value of [accessor, { ...record(), path: '/private/store' }, { ...record(), cubeText: 'secret cube' }, record({ name: '/tmp/look.cube' }), record({ name: 'x'.repeat(3000) + '.cube' })]) {
    for (const action of ['reserve', 'verify', 'complete']) assert.equal((await bridge[action](value)).ok, false);
  }
  assert.deepEqual(await bridge.read({ ...identity(), operation: 'fs.read' }), denied);
  assert.equal(calls, 0); assert.equal(getters, 0);
  for (const response of [{ ok: true, value: null, path: '/private/store' }, { ok: false, code: 'ENOENT' },
    { ok: false, code: 'LUT_RECOVERY_CONFLICT', message: '/private/store' }, { ok: true, value: record({ workspaceScope: 'c'.repeat(64) }) }]) {
    assert.deepEqual(await bridgeWith(async () => response).read(identity()), denied);
  }
  assert.deepEqual(await bridgeWith(async () => { throw new Error('EACCES /private/store'); }).read(identity()), denied);
});

test('preload preserves all recognized application failure codes across serialized envelopes', async () => {
  for (const code of ['LUT_RECOVERY_UNAVAILABLE', 'LUT_RECOVERY_CONFLICT', 'LUT_RECOVERY_CORRUPT']) {
    const bridge = bridgeWith(async () => JSON.parse(JSON.stringify({ ok: false, code })));
    for (const action of ['read', 'reserve', 'verify', 'complete']) {
      const result = await bridge[action](action === 'read' ? identity() : record());
      assert.deepEqual(result, { ok: false, code }); assert.equal(Object.isFrozen(result), true);
    }
  }
});

test('desktop missing or broken preload fails closed without touching localStorage', async t => {
  const check = forbidStorage(t);
  const environments = [{ __mioonDesktop: true }, { __mioonProjectWindow: {} }, { navigator: { userAgent: 'Mozilla/5.0 Electron/41.0.0' } },
    { __mioonLutRecovery: null }, { __mioonLutRecovery: {} }, { __mioonLutRecovery: { read() { return { ok: true, value: null }; } } },
    { __mioonLutRecovery: bridgeWith(async () => { throw new Error('/private/store'); }) }];
  for (const environment of environments) {
    const recovery = createDesktopOrBrowserLutRecovery(environment);
    for (const action of ['read', 'reserve', 'verify', 'complete']) await assert.rejects(recovery[action](action === 'read' ? identity() : record()), codeIs('LUT_RECOVERY_UNAVAILABLE'));
  }
  check();
});

test('desktop validates tampered bridge output and preserves application error identity without web fallback', async t => {
  const check = forbidStorage(t);
  for (const response of [{ ok: true, value: record({ workspaceScope: 'c'.repeat(64) }) }, { ok: true, value: null, path: '/private/store' },
    { ok: false, code: 'ENOENT' }, { ok: true, value: { ...record(), cubeText: 'secret' } }]) {
    const bridge = Object.fromEntries(['read', 'reserve', 'verify', 'complete'].map(action => [action, async () => response]));
    await assert.rejects(createDesktopOrBrowserLutRecovery({ __mioonLutRecovery: bridge }).read(identity()));
  }
  for (const code of ['LUT_RECOVERY_UNAVAILABLE', 'LUT_RECOVERY_CONFLICT', 'LUT_RECOVERY_CORRUPT']) {
    const recovery = createDesktopOrBrowserLutRecovery({ __mioonLutRecovery: bridgeWith(async () => ({ ok: false, code })) });
    await assert.rejects(recovery.reserve(record()), codeIs(code));
  }
  const bridge = bridgeWith(async () => ({ ok: true, value: null }));
  const environment = { __mioonLutRecovery: bridge }, recovery = createDesktopOrBrowserLutRecovery(environment);
  assert.equal(await recovery.read(identity()), null);
  environment.__mioonLutRecovery = undefined;
  await assert.rejects(recovery.read(identity()), codeIs('LUT_RECOVERY_UNAVAILABLE'));
  check();
});

test('desktop success uses only bridge metadata and does not require Web Locks or localStorage', async t => {
  const check = forbidStorage(t), calls = [];
  const recovery = createDesktopOrBrowserLutRecovery({ __mioonLutRecovery: bridgeWith(async (_channel, request) => {
    calls.push(request); return { ok: true, value: request.action === 'read' ? record() : null };
  }) });
  assert.deepEqual(await recovery.read(identity()), record());
  for (const action of ['reserve', 'verify', 'complete']) assert.equal(await recovery[action](record()), undefined);
  assert.deepEqual(calls.map(call => call.action), ['read', 'reserve', 'verify', 'complete']); check();
});

test('ordinary web selection retains browser storage, locking and compare-and-swap behavior', async t => {
  const descriptors = Object.fromEntries(['localStorage', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const data = new Map(), locks = [];
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (key, options, action) => { locks.push([key, options.mode]); return action(); } } } });
  t.after(() => { for (const [key, descriptor] of Object.entries(descriptors)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const recovery = createDesktopOrBrowserLutRecovery({ navigator: { userAgent: 'Mozilla/5.0 Chrome/135.0' } });
  await recovery.reserve(record()); assert.deepEqual(await recovery.read(identity()), record()); await recovery.verify(record());
  await assert.rejects(recovery.reserve(record({ name: 'other.cube' })), codeIs('LUT_RECOVERY_CONFLICT'));
  await recovery.complete(record()); assert.equal(await recovery.read(identity()), null);
  assert.ok(locks.length >= 6); assert.ok(locks.every(([key, mode]) => key.includes(record().workspaceScope) && mode === 'exclusive'));
  for (const factory of [createBrowserClipLutRecovery, createClipLutRecovery]) {
    const explicit = factory({ storage: () => storage, lock: async (_name, action) => action() });
    await explicit.reserve(record()); assert.deepEqual(await explicit.read(identity()), record()); await explicit.complete(record());
  }
});

test('real sandbox preload bundles metadata bridge with no filesystem or arbitrary transport exposure', async () => {
  const result = await build({ entryPoints: ['apps/desktop/src/preload.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], write: false, metafile: true });
  assert.deepEqual(Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path)), ['electron']);
  const source = result.outputFiles[0].text;
  assert.match(source, /exposeInMainWorld\("__mioonLutRecovery"/);
  assert.match(source, /mioon:lut-recovery:v1/);
  assert.doesNotMatch(source, /lut-import-pending-v1\.json|node:fs|\.sendSync\(|process\.env/);
});

test('desktop bridge timeout fails closed and late completion never accesses browser storage', async t => {
  const check = forbidStorage(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = Promise.withResolvers();
  const bridge = Object.fromEntries(['read', 'reserve', 'verify', 'complete'].map(action => [action, () => pending.promise]));
  const recovery = createDesktopOrBrowserLutRecovery({ __mioonLutRecovery: bridge });
  const assertion = assert.rejects(recovery.read(identity()), codeIs('LUT_RECOVERY_UNAVAILABLE'));
  t.mock.timers.tick(5000);
  await assertion;
  pending.resolve({ ok: true, value: record() });
  await Promise.resolve(); check();
});
