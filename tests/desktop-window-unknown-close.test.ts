import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { installNativeCloseAdmission } from '../apps/desktop/src/native-close.ts';
import { QuitCoordinator } from '../apps/desktop/src/lifecycle.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await tick(); }
  assert.fail('Unknown-close protocol did not reach the expected causal checkpoint');
}
interface FakeContents extends EventEmitter {getURL(): string; executeJavaScript(code: string): Promise<unknown>; loadURL(): Promise<void>}
interface FakeWindow extends EventEmitter {webContents: FakeContents; destroyed: boolean; pendingUnload: (() => void) | null; isDestroyed(): boolean; close(): void}
interface FixtureOptions {dirty?: boolean; busy?: boolean; unknown?: boolean; holdUnload?: boolean; inspect?: (...args: unknown[]) => unknown; confirmUnknown?: () => boolean | Promise<boolean>; confirmDiscard?: (action: unknown) => boolean | Promise<boolean>}
function fixture(t: TestContext, options: FixtureOptions = {}) {
  const events: unknown[] = [], notices: unknown[] = [], commits: Array<{token: unknown; choice: Record<string, unknown>}> = [], scripts: unknown[] = [];
  const evidence = { result: 'unknown', operation: { id: 'operation-a' }, savedRecord: { id: 'saved-project-a' } };
  let sequence = 0, owns = true; let state: {dirty: boolean; busy: boolean; unknown: boolean; identity: unknown[]} = { dirty: options.dirty ?? false, busy: options.busy ?? false,
    unknown: options.unknown ?? true, identity: [{}, 1, evidence.operation] };
  let writes = 0, stopped = 0, finished = 0, vetoOverrides = 0;
  const registry = createNativeCloseRegistry(), settings = createSettingsNavigationRegistry();
  const url = 'http://127.0.0.1:45000/?project=a';
  const renderer = createNativeCloseAdmission({ registry, settings, readScope: () => 'workspace:project-a:1',
    readDocumentURL: () => url, readAdditionalSnapshot: () => state, newToken: () => `unknown-close-${++sequence}` });
  const sandbox = vm.createContext({ __mioonNativeCloseAdmission: {
    inspect: (...args: unknown[]) => options.inspect ? options.inspect(...args) : (renderer.inspect as (...values: unknown[]) => unknown)(...args),
    commit: (token: unknown, choice: unknown) => { commits.push({token, choice: choice as Record<string, unknown>}); return renderer.commit(token as never, choice as never); },
    cancel: (token: unknown) => renderer.cancel(token as never),
  }, __mioonFlushWorkspacePreferences: () => { writes++; return true; } });
  const win = new EventEmitter() as FakeWindow; win.webContents = new EventEmitter() as FakeContents; win.destroyed = false; win.pendingUnload = null;
  win.isDestroyed = () => win.destroyed; win.webContents.getURL = () => url;
  win.webContents.executeJavaScript = async (code: string) => {
    const kind = code.includes('.inspect(') ? 'inspect' : code.includes('.commit(') ? 'commit' : code.includes('.cancel(') ? 'cancel' : 'flush';
    events.push(kind); scripts.push(code); return vm.runInContext(code, sandbox);
  };
  win.webContents.loadURL = async () => { events.push('reload'); assert.fail('Unknown result must never authorize reload'); };
  const finishUnload = () => {
    win.pendingUnload = null;
    if (!renderer.beforeUnload({ preventDefault() {}, returnValue: '' })) {
      win.webContents.emit('will-prevent-unload', { preventDefault() { vetoOverrides++; } }); return;
    }
    win.destroyed = true; events.push('closed'); win.emit('closed');
  };
  win.close = () => {
    let prevented = false; win.emit('close', { preventDefault() { prevented = true; } });
    if (prevented) return;
    if (options.holdUnload) win.pendingUnload = finishUnload; else finishUnload();
  };
  const quit = new QuitCoordinator({ getWindow: () => win as unknown as ReturnType<ConstructorParameters<typeof QuitCoordinator>[0]['getWindow']>, stop: async () => { stopped++; events.push('stop'); }, finish: () => { finished++; events.push('finish'); } });
  const native = installNativeCloseAdmission(win as unknown as Parameters<typeof installNativeCloseAdmission>[0], {
    timeoutMs: 300, isCurrent: () => owns,
    ...(options.confirmUnknown ? { confirmUnknown: async () => { events.push('confirm-unknown'); return await (options.confirmUnknown as () => boolean | Promise<boolean>)(); } } : {}),
    confirmDiscard: async (action: unknown) => { events.push('confirm-dirty'); return await (options.confirmDiscard?.(action) ?? true); },
    confirmClose: () => { events.push('confirm-drain'); return true; },
    onBlocked: (reason: unknown) => notices.push(reason), onCancel: () => { if (owns && !win.destroyed) quit.cancel(); }, requestQuit: () => quit.request(),
  });
  t.after(() => native.dispose());
  return { win, quit, native, renderer, registry, settings, events, notices, commits, scripts, evidence,
    change(patch: Partial<typeof state>) { state = { ...state, ...patch }; }, get state() { return state; }, replaceWindow() { owns = false; },
    stats: () => ({ writes, stopped, finished, vetoOverrides }),
  };
}

test('unknown keeps the original window and all evidence unless separately approved', async t => {
  for (const choice of [undefined, () => false]) {
    const f = fixture(t, { dirty: true, confirmUnknown: choice }), original = f.evidence;
    assert.equal(await f.quit.request(), false); assert.equal(f.win.destroyed, false);
    assert.strictEqual(f.evidence, original); assert.equal(f.state.unknown, true);
    assert.equal(f.events.includes('confirm-dirty'), false); assert.equal(f.events.includes('confirm-drain'), false);
    assert.equal(f.commits.length, 0); assert.deepEqual(f.stats(), { writes: 0, stopped: 0, finished: 0, vetoOverrides: 0 });
  }
});

test('separate unknown-risk approval closes once with zero drains and no evidence changes', async t => {
  const f = fixture(t, { confirmUnknown: () => true }), original = structuredClone(f.evidence);
  assert.equal(await f.quit.request(), true);
  assert.deepEqual(f.events, ['inspect', 'confirm-unknown', 'commit', 'closed', 'stop', 'finish']);
  assert.deepEqual(f.stats(), { writes: 0, stopped: 1, finished: 1, vetoOverrides: 0 });
  assert.equal(f.commits[0].choice.allowUnknown, true); assert.equal(f.commits[0].choice.allowDrainFailure, false);
  assert.equal(f.commits[0].choice.discardDirty, false); assert.equal(f.commits[0].choice.action, 'close');
  assert.deepEqual(f.evidence, original); assert.equal(f.state.unknown, true);
  assert.equal(f.renderer.commit(f.commits[0]!.token as string, f.commits[0]!.choice as never), false);
});

test('unknown plus other dirty inputs needs both dialogs and still performs no drain', async t => {
  for (const discard of [false, true]) {
    const f = fixture(t, { dirty: true, confirmUnknown: () => true, confirmDiscard: () => discard });
    assert.equal(await f.quit.request(), discard); assert.equal(f.win.destroyed, discard);
    assert.equal(f.events.filter(kind => kind === 'confirm-unknown').length, 1);
    assert.equal(f.events.filter(kind => kind === 'confirm-dirty').length, 1);
    assert.equal(f.events.includes('confirm-drain'), false); assert.equal(f.stats().writes, 0);
    assert.equal(f.state.unknown, true); assert.equal(f.state.dirty, true);
    if (discard) assert.equal(f.commits[0].choice.discardDirty, true);
  }
});

test('busy plus unknown never reaches risk approval or ordinary discard', async t => {
  const f = fixture(t, { dirty: true, busy: true, confirmUnknown: () => true });
  assert.equal(await f.quit.request(), false); assert.equal(f.win.destroyed, false);
  assert.deepEqual(f.events, ['inspect', 'cancel']); assert.deepEqual(f.notices, ['blocked']);
  assert.deepEqual(f.stats(), { writes: 0, stopped: 0, finished: 0, vetoOverrides: 0 });
});

test('unknown result cannot reload, including a malformed renderer that offers an unknown close disposition', async t => {
  for (const override of [undefined, () => ({ version: 1, token: 'malformed-reload', disposition: 'unknown' })]) {
    const f = fixture(t, { confirmUnknown: () => true, inspect: override });
    assert.equal(await f.native.requestReload(), false);
    assert.equal(f.events.includes('confirm-unknown'), false); assert.equal(f.events.includes('reload'), false);
    assert.deepEqual(f.notices, ['blocked']); assert.equal(f.stats().writes, 0);
  }
});

const changes: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  'new busy': f => f.change({ busy: true }),
  'new unknown operation': f => f.change({ identity: [f.state.identity[0], 2, {}] }),
  'owner replacement': f => f.change({ identity: [{}, 1, f.state.identity[2]] }),
  'late acknowledgement': f => f.change({ unknown: false, identity: [f.state.identity[0], 2, f.state.identity[2]] }),
  'new input': f => f.renderer.interacted(),
};
for (const [label, change] of Object.entries(changes)) {
  test(`${label} during unknown dialog rejects the stale approval`, async t => {
    const decision = Promise.withResolvers<boolean>(), f = fixture(t, { confirmUnknown: () => decision.promise });
    const quitting = f.quit.request(); await until(() => f.events.includes('confirm-unknown'));
    change(f); decision.resolve(true);
    assert.equal(await quitting, false); assert.equal(f.win.destroyed, false);
    assert.deepEqual(f.notices, ['changed']); assert.deepEqual(f.stats(), { writes: 0, stopped: 0, finished: 0, vetoOverrides: 0 });
  });
  test(`${label} after commit is vetoed synchronously without native override`, async t => {
    const f = fixture(t, { confirmUnknown: () => true, holdUnload: true });
    const quitting = f.quit.request(); await until(() => f.win.pendingUnload !== null);
    change(f); f.win.pendingUnload!();
    assert.equal(await quitting, false); assert.equal(f.win.destroyed, false);
    assert.deepEqual(f.notices, ['changed']); assert.deepEqual(f.stats(), { writes: 0, stopped: 0, finished: 0, vetoOverrides: 0 });
  });
}

test('new unknown during the second dirty confirmation cannot reuse the first risk decision', async t => {
  const decision = Promise.withResolvers<boolean>(), f = fixture(t, { dirty: true, confirmUnknown: () => true, confirmDiscard: () => decision.promise });
  const quitting = f.quit.request(); await until(() => f.events.includes('confirm-dirty'));
  f.change({ identity: [f.state.identity[0], 2, {}] }); decision.resolve(true);
  assert.equal(await quitting, false); assert.equal(f.win.destroyed, false);
  assert.deepEqual(f.notices, ['changed']); assert.equal(f.stats().writes, 0);
});

test('cancelled risk decision cannot be reused by a later close', async t => {
  let accepted = false;
  const f = fixture(t, { confirmUnknown: () => accepted });
  assert.equal(await f.quit.request(), false);
  assert.equal(f.state.unknown, true); accepted = true;
  assert.equal(await f.quit.request(), true);
  assert.equal(f.events.filter(kind => kind === 'confirm-unknown').length, 2); assert.equal(f.stats().writes, 0);
});

test('throwing risk confirmation retains the original window and zero-write state', async t => {
  const f = fixture(t, { confirmUnknown() { throw Error('Dialog unavailable'); } });
  assert.equal(await f.quit.request(), false); assert.equal(f.win.destroyed, false);
  assert.deepEqual(f.notices, ['unavailable']); assert.equal(f.stats().writes, 0); assert.equal(f.state.unknown, true);
});

test('ordinary clean and dirty paths still drain without consulting the unknown dialog', async t => {
  for (const dirty of [false, true]) {
    const f = fixture(t, { unknown: false, dirty, confirmUnknown() { assert.fail('Unexpected risk dialog'); } });
    assert.equal(await f.quit.request(), true); assert.equal(f.stats().writes, 1);
    assert.equal(f.events.includes('confirm-unknown'), false); assert.equal(f.events.includes('confirm-dirty'), dirty);
    assert.equal(Object.hasOwn(f.commits[0].choice, 'allowUnknown'), false);
  }
});
