import { nativeText } from '../apps/desktop/src/app-language-text.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { installNativeCloseAdmission } from '../apps/desktop/src/native-close.ts';
import { createProjectRendererRecovery } from '../apps/desktop/src/project-window-recovery.ts';
import { installPreferencesCloseDrain, installUnsavedGuard, QuitCoordinator } from '../apps/desktop/src/lifecycle.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';

const executable = source => stripTypeScriptTypes(source, { mode: 'strip' });
const deferred = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await tick(); }
  assert.fail('The synthetic close did not reach its causal checkpoint');
}

// Exercise the production desktop controller and its actual fixed scripts. The
// page is a deterministic protocol peer, not a claim about native OS timing.
function fixture(t, options = {}) {
  const events = [], scripts = [], notices = [], commits = [], reloads = [];
  let owns = true, allowed = options.allowed ?? true, documentId = 1, revision = 0, sequence = 0, captured = null, armed = null;
  let currentUrl = options.url ?? 'http://127.0.0.1:45000/?project=project-a';
  let dirty = options.dirty ?? false, blocked = options.blocked ?? false;
  let cancelCount = 0, discardCount = 0, drainDecisionCount = 0, stopped = 0, finished = 0, vetoOverrides = 0;
  const win = new EventEmitter(); win.webContents = new EventEmitter();
  win.destroyed = false; win.closeCalls = 0; win.pendingBeforeUnload = null;
  win.isDestroyed = () => win.destroyed;
  win.webContents.getURL = () => currentUrl;
  function inspect(action = 'close', targetUrl = null) {
    const token = `doc${documentId}:${++sequence}`;
    captured = { token, revision, documentId, action, targetUrl }; armed = null;
    return { version: 1, token, disposition: blocked ? 'blocked' : dirty ? 'dirty' : 'clean' };
  }
  const valid = token => captured?.token === token && captured.revision === revision && captured.documentId === documentId && !blocked;
  function commit(token, choice) {
    commits.push({ token, choice });
    if (!valid(token) || (choice.action ?? 'close') !== captured.action || (choice.targetUrl ?? null) !== captured.targetUrl ||
      dirty && choice.discardDirty !== true || !Number.isFinite(choice.expiresAt) ||
      choice.expiresAt <= Date.now() || choice.expiresAt > Date.now() + 1500) return false;
    armed = { token, ...choice }; return true;
  }
  function cancel(token) {
    if (captured?.token !== token) return false;
    captured = null; armed = null; return true;
  }
  function rendererAllowsUnload() {
    if (options.allowsUnload) return options.allowsUnload();
    if (options.unexpectedVeto) return false;
    if (armed) {
      const ticket = armed; armed = null;
      return valid(ticket.token) && Date.now() < ticket.expiresAt && (!dirty || ticket.discardDirty);
    }
    return !dirty && !blocked;
  }
  const sandbox = vm.createContext({ nt: nativeText,
    __mioonNativeCloseAdmission: { inspect: options.inspect ?? inspect, commit: options.commit ?? commit, cancel: options.cancel ?? cancel },
    __mioonFlushWorkspacePreferences: () => options.flush?.() ?? true,
  });
  const kindOf = code => code.includes('.inspect(') ? 'inspect' : code.includes('.commit(') ? 'commit' : code.includes('.cancel(') ? 'cancel' : 'flush';
  win.webContents.executeJavaScript = async code => {
    const kind = kindOf(code); events.push(kind); scripts.push(code);
    const execute = () => vm.runInContext(code, sandbox);
    return options.execute ? await options.execute(kind, execute, code) : await execute();
  };
  win.webContents.loadURL = async url => {
    reloads.push(url); events.push('reload');
    win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    const perform = () => {
      options.beforeUnload?.();
      if (!rendererAllowsUnload()) {
        win.webContents.emit('will-prevent-unload', { preventDefault() { vetoOverrides++; } });
        throw Object.assign(Error('Navigation aborted'), { code: 'ERR_ABORTED', errno: -3 });
      }
      documentId++; revision++; captured = null; armed = null; currentUrl = url;
      events.push('reloaded');
      win.webContents.emit('did-navigate', {}, url);
    };
    return options.reload ? await options.reload(url, perform) : perform();
  };
  function beforeUnload() {
    win.pendingBeforeUnload = null;
    options.beforeUnload?.();
    if (!rendererAllowsUnload()) {
      let override = false;
      win.webContents.emit('will-prevent-unload', { preventDefault() { override = true; vetoOverrides++; } });
      if (!override) return;
    }
    win.destroyed = true; events.push('closed'); win.emit('closed');
  }
  win.close = () => {
    win.closeCalls++;
    let prevented = false;
    win.emit('close', { preventDefault() { prevented = true; } });
    if (prevented) return;
    if (options.holdBeforeUnload) win.pendingBeforeUnload = beforeUnload;
    else beforeUnload();
  };
  const coordinator = new QuitCoordinator({ getWindow: () => win,
    stop: async () => { stopped++; events.push('stop'); await options.stop?.(); }, finish: () => { finished++; events.push('finish'); } });
  const installed = installNativeCloseAdmission(win, {
    timeoutMs: options.timeoutMs ?? 200,
    isCurrent: () => owns && allowed,
    beforeReload: options.beforeReload,
    reloadPreparationTimeoutMs: options.reloadPreparationTimeoutMs,
    confirmDiscard: async action => { discardCount++; events.push('confirm-discard'); return await (options.confirmDiscard?.(action) ?? true); },
    confirmClose: async action => { drainDecisionCount++; events.push('confirm-drain'); return await (options.confirmClose?.(action) ?? true); },
    onBlocked: reason => { notices.push(reason); events.push(`notice:${reason}`); },
    onCancel: () => { if (!owns || win.destroyed) return; cancelCount++; events.push('cancelled'); coordinator.cancel(); },
    requestQuit: () => options.requestQuit ? options.requestQuit(coordinator) : coordinator.request(),
  });
  t.after(() => installed.dispose());
  return {
    win, coordinator, events, scripts, notices, commits, sandbox, reloads, admission: installed,
    change({ nextDirty = dirty, nextBlocked = blocked } = {}) { revision++; dirty = nextDirty; blocked = nextBlocked; },
    replaceOwner() { owns = false; },
    setAllowed(value) { allowed = value; },
    changeUrl(url) { currentUrl = url; },
    navigate() {
      win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      documentId++; revision++; captured = null; armed = null;
    },
    get armed() { return armed; },
    stats: () => ({ cancelCount, discardCount, drainDecisionCount, stopped, finished, vetoOverrides }),
  };
}

test('legacy control reproduces the P0 generic-discard override recorded by the red baseline', async () => {
  const win = new EventEmitter(); win.webContents = new EventEmitter(); win.destroyed = false;
  win.isDestroyed = () => win.destroyed;
  win.close = () => {
    let prevented = false; win.emit('close', { preventDefault() { prevented = true; } }); if (prevented) return;
    let overridden = false; win.webContents.emit('will-prevent-unload', { preventDefault() { overridden = true; } });
    if (overridden) { win.destroyed = true; win.emit('closed'); }
  };
  installPreferencesCloseDrain(win, { flush: async () => true, confirmClose: () => true, onCancel() {} });
  installUnsavedGuard(win, { confirmDiscard: () => true, onCancel() {} });
  win.close(); await tick();
  assert.equal(win.destroyed, true, 'This is the unsafe legacy control, not the production installer');
});

test('main uses typed admission instead of either unsafe legacy installer', async () => {
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /import \{ installNativeCloseAdmission \} from '\.\/native-close\.ts'/);
  assert.match(main, /installNativeCloseAdmission\(window,/);
  assert.doesNotMatch(main, /installPreferencesCloseDrain\(window|installUnsavedGuard\(window/);
});

test('clean close drains then arms and closes once before stopping backend', async t => {
  const f = fixture(t);
  assert.equal(await f.coordinator.request(), true);
  assert.deepEqual(f.events, ['inspect', 'flush', 'commit', 'closed', 'stop', 'finish']);
  assert.deepEqual(f.stats(), { cancelCount: 0, discardCount: 0, drainDecisionCount: 0, stopped: 1, finished: 1, vetoOverrides: 0 });
  assert.equal(f.commits[0].choice.discardDirty, false);
  assert.equal(f.commits[0].choice.allowDrainFailure, false);
  assert.ok(Number.isFinite(f.commits[0].choice.expiresAt));
  assert.equal(f.win.closeCalls, 2);
});

for (const label of ['busy owner', 'unknown owner']) {
  test(`${label} cancels before drain or generic discard and keeps backend alive`, async t => {
    const f = fixture(t, { blocked: true, dirty: true });
    assert.equal(await f.coordinator.request(), false);
    assert.equal(f.win.destroyed, false);
    assert.deepEqual(f.notices, ['blocked']);
    assert.equal(f.events.includes('flush'), false);
    assert.deepEqual(f.stats(), { cancelCount: 1, discardCount: 0, drainDecisionCount: 0, stopped: 0, finished: 0, vetoOverrides: 0 });
  });
}

for (const result of [true, null, {}, [], { version: 2, token: 'x', disposition: 'clean' },
  { version: 1, token: '', disposition: 'clean' }, { version: 1, token: 'x'.repeat(129), disposition: 'clean' },
  { version: 1, token: "x');globalThis.bypass=true;//", disposition: 'clean' },
  { version: 1, token: 'x', disposition: 'unknown' }, { version: 1, token: 'x', disposition: 'clean', privateDraft: 'secret' }]) {
  test(`malformed admission is never treated as discardable: ${JSON.stringify(result).slice(0, 90)}`, async t => {
    const f = fixture(t, { inspect: () => result });
    assert.equal(await f.coordinator.request(), false);
    assert.deepEqual(f.notices, ['unavailable']);
    assert.equal(f.events.includes('flush'), false);
    assert.equal(f.stats().discardCount, 0); assert.equal(f.stats().drainDecisionCount, 0);
  });
}

test('missing and throwing page admission fail closed', async t => {
  for (const unavailable of ['missing', 'throwing']) {
    const f = fixture(t, { inspect: () => { throw Error('Unavailable'); } });
    if (unavailable === 'missing') delete f.sandbox.__mioonNativeCloseAdmission;
    assert.equal(await f.coordinator.request(), false);
    assert.deepEqual(f.notices, ['unavailable']);
    assert.equal(f.win.destroyed, false);
  }
});

test('dirty confirmation can cancel without clearing input and a fresh request can later succeed', async t => {
  let discard = false;
  const f = fixture(t, { dirty: true, confirmDiscard: () => discard });
  assert.equal(await f.coordinator.request(), false);
  assert.equal(f.win.destroyed, false); assert.equal(f.commits.length, 0);
  assert.equal(f.stats().stopped, 0); assert.equal(f.stats().cancelCount, 1);
  discard = true;
  assert.equal(await f.coordinator.request(), true);
  assert.equal(f.stats().discardCount, 2); assert.equal(f.stats().stopped, 1);
  assert.equal(f.commits[0].choice.discardDirty, true);
});

test('new input during a dirty dialog invalidates its exact confirmation', async t => {
  const decision = deferred();
  const f = fixture(t, { dirty: true, confirmDiscard: () => decision.promise });
  const quitting = f.coordinator.request();
  await until(() => f.stats().discardCount === 1);
  f.change(); decision.resolve(true);
  assert.equal(await quitting, false);
  assert.deepEqual(f.notices, ['changed']);
  assert.equal(f.win.destroyed, false); assert.equal(f.stats().stopped, 0);
  assert.equal(f.stats().discardCount, 1);
});

test('state becoming clean still invalidates the exact old discard confirmation', async t => {
  const decision = deferred();
  const f = fixture(t, { dirty: true, confirmDiscard: () => decision.promise });
  const quitting = f.coordinator.request(); await until(() => f.stats().discardCount === 1);
  f.change({ nextDirty: false }); decision.resolve(true);
  assert.equal(await quitting, false); assert.equal(f.win.destroyed, false);
});

test('new input after commit reply is rejected by final beforeunload, never overridden', async t => {
  const f = fixture(t, { dirty: true, holdBeforeUnload: true });
  const quitting = f.coordinator.request(); await until(() => f.win.pendingBeforeUnload);
  f.change(); f.win.pendingBeforeUnload();
  assert.equal(await quitting, false);
  assert.equal(f.win.destroyed, false); assert.equal(f.stats().vetoOverrides, 0);
  assert.equal(f.stats().discardCount, 1); assert.deepEqual(f.notices, ['changed']);
});

test('an unexpected renderer veto is final even after clean successful preflight', async t => {
  const f = fixture(t, { unexpectedVeto: true });
  assert.equal(await f.coordinator.request(), false);
  assert.equal(f.stats().vetoOverrides, 0); assert.equal(f.stats().discardCount, 0);
  assert.equal(f.stats().stopped, 0);
});

test('old and latest preference drains complete before confirmation, close and backend stop', async t => {
  const older = deferred(), latest = deferred(), saves = [];
  const f = fixture(t, { dirty: true, flush: async () => { saves.push('older'); await older.promise; saves.push('latest'); await latest.promise; return true; } });
  const quitting = f.coordinator.request(); await until(() => saves.length === 1);
  f.win.close(); f.win.close();
  assert.equal(f.events.filter(event => event === 'inspect').length, 1);
  assert.equal(f.stats().discardCount, 0); assert.equal(f.stats().stopped, 0);
  older.resolve(); await until(() => saves.length === 2);
  assert.equal(f.win.destroyed, false); assert.equal(f.stats().discardCount, 0);
  latest.resolve(); assert.equal(await quitting, true);
  assert.deepEqual(saves, ['older', 'latest']);
  assert.equal(f.stats().discardCount, 1); assert.equal(f.stats().stopped, 1);
});

test('drain failure has its own explicit decision before dirty confirmation', async t => {
  const f = fixture(t, { dirty: true, flush: () => false });
  assert.equal(await f.coordinator.request(), true);
  assert.deepEqual(f.events.slice(0, 5), ['inspect', 'flush', 'confirm-drain', 'confirm-discard', 'commit']);
  assert.equal(f.commits[0].choice.allowDrainFailure, true);
});

test('declining failed drain never reaches dirty confirmation or stops backend', async t => {
  const f = fixture(t, { dirty: true, flush: () => false, confirmClose: () => false });
  assert.equal(await f.coordinator.request(), false);
  assert.equal(f.stats().discardCount, 0); assert.equal(f.stats().stopped, 0);
  assert.equal(f.stats().drainDecisionCount, 1); assert.equal(f.win.destroyed, false);
});

test('input changed during failed-drain dialog cancels after the decision', async t => {
  const decision = deferred();
  const f = fixture(t, { flush: () => false, confirmClose: () => decision.promise });
  const quitting = f.coordinator.request(); await until(() => f.stats().drainDecisionCount === 1);
  f.change({ nextDirty: true }); decision.resolve(true);
  assert.equal(await quitting, false); assert.deepEqual(f.notices, ['changed']);
  assert.equal(f.stats().discardCount, 0); assert.equal(f.win.destroyed, false);
});

test('timed-out inspect cannot resume close when it eventually resolves', async t => {
  const gate = deferred();
  const f = fixture(t, { timeoutMs: 20, execute: (kind, execute) => kind === 'inspect' ? gate.promise.then(execute) : execute() });
  assert.equal(await f.coordinator.request(), false);
  gate.resolve(); await tick(); await tick();
  assert.deepEqual(f.notices, ['unavailable']);
  assert.equal(f.events.includes('flush'), false); assert.equal(f.win.destroyed, false);
});

test('timed-out drain preserves the original explicit close decision and ignores its late result', async t => {
  const gate = deferred();
  const f = fixture(t, { timeoutMs: 20, flush: () => gate.promise });
  assert.equal(await f.coordinator.request(), true);
  gate.resolve(true); await tick(); await tick();
  assert.equal(f.stats().drainDecisionCount, 1); assert.equal(f.stats().stopped, 1);
  assert.equal(f.win.closeCalls, 2);
});

test('late commit execution cannot arm after deadline even if cancel transport fails', async t => {
  const gate = deferred(); let expiresAt = null;
  const f = fixture(t, { dirty: true, timeoutMs: 20, execute: (kind, execute, code) => {
    if (kind === 'commit') {
      expiresAt = Number(code.match(/expiresAt:(\d+)/u)?.[1]);
      return gate.promise.then(execute);
    }
    if (kind === 'cancel') throw Error('Renderer cleanup unavailable');
    return execute();
  } });
  assert.equal(await f.coordinator.request(), false);
  assert.ok(Number.isSafeInteger(expiresAt));
  // A timer callback may wake just before its wall-clock lease. This test
  // releases the delayed script only after the actual captured deadline,
  // rather than treating timer completion as proof that Date.now crossed it.
  assert.equal(f.commits.length, 0);
  while (Date.now() < expiresAt) await sleep(Math.max(1, expiresAt - Date.now()));
  assert.ok(Date.now() >= expiresAt);
  gate.resolve(); await tick(); await tick();
  assert.equal(f.commits.length, 1); assert.equal(f.armed, null);
  assert.equal(f.win.closeCalls, 1); assert.deepEqual(f.notices, ['changed']);
});

test('late commit reply leaves no usable ticket after its absolute expiry', async t => {
  const gate = deferred();
  const f = fixture(t, { dirty: true, timeoutMs: 20, execute: (kind, execute) => {
    if (kind === 'commit') { const result = execute(); return gate.promise.then(() => result); }
    if (kind === 'cancel') throw Error('Renderer cleanup unavailable');
    return execute();
  } });
  assert.equal(await f.coordinator.request(), false);
  assert.ok(f.armed);
  // A timer wake and the wall-clock lease boundary can differ by one tick.
  // Observe the actual recorded deadline rather than assume timeout completion
  // proves Date.now has crossed it; the same fixed lease and assertions apply.
  while (Date.now() < f.armed.expiresAt) await sleep(Math.max(1, f.armed.expiresAt - Date.now()));
  assert.ok(f.armed.expiresAt <= Date.now());
  gate.resolve(); await tick();
  assert.equal(f.win.closeCalls, 1); assert.equal(f.win.destroyed, false);
});

test('expiry during the final IPC gap cancels without a business retry', async t => {
  const f = fixture(t, { dirty: true, timeoutMs: 20, holdBeforeUnload: true });
  const quitting = f.coordinator.request(); await until(() => f.win.pendingBeforeUnload);
  await sleep(25); assert.equal(await quitting, false);
  f.win.pendingBeforeUnload();
  assert.equal(f.win.destroyed, false); assert.equal(f.stats().vetoOverrides, 0);
  assert.equal(f.events.filter(event => event === 'flush').length, 1);
});

test('replacement window ownership prevents old continuation, cancellation and dialogs', async t => {
  const gate = deferred();
  const f = fixture(t, { dirty: true, flush: () => gate.promise });
  f.win.close(); await until(() => f.events.includes('flush'));
  f.replaceOwner(); gate.resolve(false); await tick(); await tick();
  assert.equal(f.win.destroyed, false); assert.equal(f.stats().cancelCount, 0);
  assert.equal(f.stats().discardCount, 0); assert.equal(f.stats().drainDecisionCount, 0);
  assert.deepEqual(f.notices, []); assert.equal(f.events.includes('commit'), false);
});

test('same-URL document replacement cancels the old attempt and admits a fresh one', async t => {
  const gate = deferred(); let first = true;
  const f = fixture(t, { dirty: true, execute: (kind, execute) => {
    if (kind === 'commit' && first) { first = false; return gate.promise.then(execute); }
    return execute();
  } });
  const oldQuit = f.coordinator.request(); await until(() => f.events.includes('commit'));
  f.navigate(); assert.equal(await oldQuit, false);
  const freshQuit = f.coordinator.request();
  assert.equal(await freshQuit, true);
  gate.resolve(); await tick(); await tick();
  assert.equal(f.stats().stopped, 1); assert.equal(f.stats().cancelCount, 1);
  assert.equal(f.commits.at(-1).token.startsWith('doc1:'), true);
  assert.equal(f.armed, null);
});

test('renderer loss cancels a pending probe and keeps backend alive', async t => {
  const gate = deferred();
  const f = fixture(t, { execute: (kind, execute) => kind === 'inspect' ? gate.promise.then(execute) : execute() });
  const quitting = f.coordinator.request(); await until(() => f.events.includes('inspect'));
  f.win.webContents.emit('render-process-gone');
  assert.equal(await quitting, false); assert.equal(f.stats().stopped, 0);
  gate.resolve(); await tick(); assert.equal(f.win.destroyed, false);
});

test('throwing dialogs or commit probes cannot close or create unhandled rejections', async t => {
  for (const phase of ['drain-dialog', 'discard-dialog', 'commit']) {
    const f = fixture(t, {
      dirty: true, flush: () => phase === 'drain-dialog' ? false : true,
      confirmClose: () => { throw Error('No dialog'); },
      confirmDiscard: () => { if (phase === 'discard-dialog') throw Error('No dialog'); return true; },
      execute: (kind, execute) => { if (phase === 'commit' && kind === 'commit') throw Error('No renderer'); return execute(); },
    });
    assert.equal(await f.coordinator.request(), false);
    assert.equal(f.stats().stopped, 0); assert.equal(f.win.destroyed, false);
  }
});

test('production desktop scripts and real renderer admission enforce exact one-shot input approval', async t => {
  const registry = createNativeCloseRegistry(), settings = createSettingsNavigationRegistry();
  const owner = registry.register('agent-chat');
  owner.update({ dirty: true, busy: false, blocked: false, version: 1 });
  const page = createNativeCloseAdmission({ registry, settings, readScope: () => 'project-a', readLegacyDirty: () => false });
  const f = fixture(t, {
    inspect: () => page.inspect(), commit: (token, choice) => page.commit(token, choice), cancel: token => page.cancel(token),
    allowsUnload: () => page.beforeUnload({ preventDefault() {}, returnValue: '' }), holdBeforeUnload: true,
  });
  const firstQuit = f.coordinator.request(); await until(() => f.win.pendingBeforeUnload);
  owner.update({ dirty: true, busy: false, blocked: false, version: 2 });
  f.win.pendingBeforeUnload();
  assert.equal(await firstQuit, false); assert.equal(f.stats().stopped, 0); assert.equal(f.stats().vetoOverrides, 0);
  const secondQuit = f.coordinator.request(); await until(() => f.win.pendingBeforeUnload);
  f.win.pendingBeforeUnload();
  assert.equal(await secondQuit, true); assert.equal(f.stats().stopped, 1); assert.equal(f.stats().discardCount, 2);
});

test('fixed-current-URL reload uses its own action-bound ticket without closing or stopping backend', async t => {
  const f = fixture(t);
  assert.equal(await f.admission.requestReload(), true);
  assert.deepEqual(f.reloads, ['http://127.0.0.1:45000/?project=project-a']);
  assert.deepEqual(f.events, ['inspect', 'flush', 'commit', 'reload', 'reloaded']);
  assert.equal(f.commits[0].choice.action, 'reload');
  assert.equal(f.commits[0].choice.targetUrl, f.reloads[0]);
  assert.equal(f.win.closeCalls, 0); assert.equal(f.win.destroyed, false);
  assert.equal(f.stats().stopped, 0);
});

test('dirty reload confirms the capture and retains backend lifetime', async t => {
  const f = fixture(t, { dirty: true });
  assert.equal(await f.admission.requestReload(), true);
  assert.equal(f.stats().discardCount, 1); assert.equal(f.stats().stopped, 0);
  assert.equal(f.commits[0].choice.discardDirty, true); assert.equal(f.win.destroyed, false);
});

test('cancelled dirty reload never begins navigation', async t => {
  const f = fixture(t, { dirty: true, confirmDiscard: () => false });
  assert.equal(await f.admission.requestReload(), false);
  assert.deepEqual(f.reloads, []); assert.equal(f.stats().stopped, 0);
  assert.equal(f.win.destroyed, false);
});

test('blocked reload has no dirty or drain-failure override', async t => {
  const f = fixture(t, { dirty: true, blocked: true });
  assert.equal(await f.admission.requestReload(), false);
  assert.deepEqual(f.reloads, []); assert.deepEqual(f.notices, ['blocked']);
  assert.equal(f.stats().discardCount, 0); assert.equal(f.stats().drainDecisionCount, 0);
});

test('new input during reload confirmation invalidates navigation', async t => {
  const decision = deferred();
  const f = fixture(t, { dirty: true, confirmDiscard: () => decision.promise });
  const reload = f.admission.requestReload(); await until(() => f.stats().discardCount === 1);
  f.change(); decision.resolve(true);
  assert.equal(await reload, false); assert.deepEqual(f.reloads, []);
  assert.deepEqual(f.notices, ['changed']);
});

test('new input after reload commit is vetoed at beforeunload and ERR_ABORTED resolves false', async t => {
  const gate = deferred();
  const f = fixture(t, { dirty: true, reload: async (_url, perform) => { await gate.promise; perform(); } });
  const reload = f.admission.requestReload(); await until(() => f.reloads.length === 1);
  f.change(); gate.resolve();
  assert.equal(await reload, false); assert.equal(f.stats().vetoOverrides, 0);
  assert.equal(f.events.includes('reloaded'), false); assert.equal(f.win.destroyed, false);
});

test('same-URL replacement document during reload confirmation invalidates that approval', async t => {
  const decision = deferred();
  const f = fixture(t, { dirty: true, confirmDiscard: () => decision.promise });
  const reload = f.admission.requestReload(); await until(() => f.stats().discardCount === 1);
  f.navigate(); decision.resolve(true);
  assert.equal(await reload, false); await tick();
  assert.deepEqual(f.reloads, []); assert.equal(f.stats().stopped, 0);
});

test('a second same-URL navigation cannot borrow the reload attempt', async t => {
  const gate = deferred();
  const f = fixture(t, { dirty: true, reload: async (_url, perform) => { await gate.promise; perform(); } });
  const reload = f.admission.requestReload(); await until(() => f.reloads.length === 1);
  f.win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: f.reloads[0] });
  assert.equal(await reload, false);
  gate.resolve(); await tick();
  assert.equal(f.events.includes('reloaded'), false); assert.equal(f.win.destroyed, false);
});

test('close cannot borrow a pending reload approval or leave quit waiting', async t => {
  const decision = deferred();
  const f = fixture(t, { dirty: true, confirmDiscard: () => decision.promise });
  const reload = f.admission.requestReload(); await until(() => f.stats().discardCount === 1);
  assert.equal(await f.coordinator.request(), false);
  assert.equal(f.stats().stopped, 0); assert.equal(f.win.destroyed, false);
  decision.resolve(true); assert.equal(await reload, true);
  assert.equal(f.stats().discardCount, 1); assert.equal(f.commits[0].choice.action, 'reload');
});

test('reload cannot borrow close approval, and repeated reloads share one attempt', async t => {
  const closeDecision = deferred();
  const first = fixture(t, { dirty: true, confirmDiscard: () => closeDecision.promise });
  const quitting = first.coordinator.request(); await until(() => first.stats().discardCount === 1);
  assert.equal(await first.admission.requestReload(), false);
  closeDecision.resolve(true); assert.equal(await quitting, true); assert.deepEqual(first.reloads, []);
  const reloadDecision = deferred();
  const second = fixture(t, { dirty: true, confirmDiscard: () => reloadDecision.promise });
  const reload = second.admission.requestReload();
  assert.equal(reload, second.admission.requestReload());
  reloadDecision.resolve(true); assert.equal(await reload, true);
  assert.equal(second.stats().discardCount, 1); assert.equal(second.reloads.length, 1);
});

test('a committed reload does not block a fresh close while loadURL waits forever', async t => {
  const gate = deferred();
  const f = fixture(t, { timeoutMs: 20, reload: async (_url, perform) => { perform(); await gate.promise; } });
  const reload = f.admission.requestReload(); await until(() => f.events.includes('reloaded'));
  await sleep(25);
  assert.equal(f.stats().cancelCount, 0); assert.deepEqual(f.notices, []);
  assert.equal(await f.coordinator.request(), true);
  assert.equal(await reload, false); assert.equal(f.stats().stopped, 1);
  assert.equal(f.win.destroyed, true);
});

test('ERR_ABORTED is an ordinary cancelled reload; other owned load errors stay observable', async t => {
  const aborted = fixture(t, { reload: () => { throw Object.assign(Error('Cancelled'), { code: 'ERR_ABORTED' }); } });
  assert.equal(await aborted.admission.requestReload(), false);
  assert.equal(aborted.win.destroyed, false); assert.equal(aborted.stats().stopped, 0);
  const failed = fixture(t, { reload: () => { throw Object.assign(Error('Failed'), { code: 'ERR_CONNECTION_REFUSED' }); } });
  await assert.rejects(failed.admission.requestReload(), { code: 'ERR_CONNECTION_REFUSED' });
  assert.equal(failed.win.destroyed, false); assert.equal(failed.stats().stopped, 0);
});

test('source URL changes cancel close and reload without hanging the quit coordinator', async t => {
  for (const action of ['close', 'reload']) {
    const gate = deferred();
    const f = fixture(t, { dirty: true, flush: () => gate.promise });
    const result = action === 'close' ? f.coordinator.request() : f.admission.requestReload();
    await until(() => f.events.includes('flush'));
    f.changeUrl('http://127.0.0.1:45000/?project=project-b'); gate.resolve(true);
    assert.equal(await result, false);
    assert.equal(f.stats().stopped, 0); assert.equal(f.events.includes('commit'), false);
  }
});

test('real renderer binds reload to the exact current document URL and action', async t => {
  const url = 'http://127.0.0.1:45000/?project=project-a';
  const registry = createNativeCloseRegistry(), settings = createSettingsNavigationRegistry();
  const owner = registry.register('agent-chat'); owner.update({ dirty: true, busy: false, blocked: false, version: 1 });
  const page = createNativeCloseAdmission({ registry, settings, readScope: () => 'project-a', readLegacyDirty: () => false, readDocumentURL: () => url });
  const f = fixture(t, {
    inspect: (action, targetUrl) => page.inspect(action, targetUrl),
    commit: (token, choice) => page.commit(token, choice), cancel: token => page.cancel(token),
    allowsUnload: () => page.beforeUnload({ preventDefault() {}, returnValue: '' }),
  });
  assert.equal(await f.admission.requestReload(), true);
  assert.equal(f.reloads[0], url); assert.equal(f.stats().discardCount, 1); assert.equal(f.stats().stopped, 0);
  const close = page.inspect('close', null), options = { discardDirty: true, allowDrainFailure: false, expiresAt: Date.now() + 1000 };
  assert.equal(page.commit(close.token, { ...options, action: 'reload', targetUrl: url }), false);
  const reload = page.inspect('reload', url);
  assert.equal(page.commit(reload.token, { ...options, action: 'close', targetUrl: null }), false);
  assert.equal(page.commit(reload.token, { ...options, action: 'reload', targetUrl: `${url}-other` }), false);
});

test('main routes user reload through admission and only proved initial empty load failures remain recoverable', async () => {
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /windowAdmissions\.get\(window!?\)\?\.captureRecoveryDecision\(\)\.reload\(\)\.catch\(fatal\)/);
  assert.match(main, /capture: window => windowAdmissions\.get\(window\)\?\.captureRecoveryDecision\(\)/);
  assert.match(main, /const rendererFailed = createProjectRendererRecovery\(/);
  const start = main.indexOf('async function openWindow('), end = main.indexOf('\nfunction prepareOwnedWindow(', start);
  const source = stripTypeScriptTypes(main.slice(start, end), { mode: 'strip' });
  assert.match(source, /await windowHost\.loadFor\(window\)/);
  assert.doesNotMatch(source, /requestReload/);
  const window = {}, startupError = Object.assign(Error('Startup failed'), { code: 'ERR_ABORTED' });
  const context = vm.createContext({ nt: nativeText, ownsWindowContext: () => true, ownsWindow: () => true, initialWindowLoads: new WeakMap(),
    windowHost: { ensureLauncher: () => window, loadFor: async target => { assert.equal(target, window); throw startupError; } } });
  vm.runInContext(source, context);
  context.context = { ready: { url: 'http://127.0.0.1:45000' } };
  await assert.rejects(vm.runInContext('openWindow(context)', context), { code: 'ERR_ABORTED' });
});

test('both native dialogs receive the typed close or reload action for precise wording', async t => {
  for (const action of ['close', 'reload']) {
    const dialogs = [];
    const f = fixture(t, { dirty: true, flush: () => false,
      confirmClose: received => { dialogs.push(['drain', received]); return true; },
      confirmDiscard: received => { dialogs.push(['dirty', received]); return true; } });
    assert.equal(await (action === 'close' ? f.coordinator.request() : f.admission.requestReload()), true);
    assert.deepEqual(dialogs, [['drain', action], ['dirty', action]]);
  }
});

test('quit during initial about:blank navigation settles cancelled and can succeed after app load', async t => {
  const f = fixture(t, { allowed: false, url: 'about:blank' });
  assert.equal(await f.coordinator.request(), false);
  assert.equal(f.coordinator.state, 'idle'); assert.equal(f.stats().cancelCount, 1);
  assert.equal(f.stats().stopped, 0); assert.equal(f.win.destroyed, false); assert.deepEqual(f.scripts, []);
  f.changeUrl('http://127.0.0.1:45000/?project=project-a'); f.setAllowed(true);
  assert.equal(await f.coordinator.request(), true); assert.equal(f.stats().stopped, 1);
  const stale = fixture(t, { allowed: false, url: 'about:blank' });
  stale.replaceOwner(); stale.win.close();
  assert.equal(stale.stats().cancelCount, 0); assert.deepEqual(stale.scripts, []);
});

test('fresh dirty close after document commit needs its own approval and stale load errors are inert', async t => {
  const gate = deferred(); let discard = false;
  const f = fixture(t, { confirmDiscard: () => discard, reload: async (_url, perform) => { perform(); await gate.promise; } });
  const reload = f.admission.requestReload(); await until(() => f.events.includes('reloaded'));
  f.change({ nextDirty: true });
  assert.equal(await f.coordinator.request(), false);
  assert.equal(await reload, false); assert.equal(f.win.destroyed, false); assert.equal(f.stats().stopped, 0);
  assert.equal(f.stats().discardCount, 1);
  gate.reject(Object.assign(Error('Old load failed after newer close'), { code: 'ERR_CONNECTION_REFUSED' }));
  await tick(); await tick();
  assert.deepEqual(f.notices, []); assert.equal(f.stats().stopped, 0);
  discard = true;
  assert.equal(await f.coordinator.request(), true); assert.equal(f.stats().discardCount, 2);
});

test('new input during fresh close after reload commit invalidates only the new close approval', async t => {
  const load = deferred(), decision = deferred();
  const f = fixture(t, { confirmDiscard: () => decision.promise, reload: async (_url, perform) => { perform(); await load.promise; } });
  const reload = f.admission.requestReload(); await until(() => f.events.includes('reloaded'));
  f.change({ nextDirty: true });
  const close = f.coordinator.request(); await until(() => f.stats().discardCount === 1);
  f.change(); decision.resolve(true);
  assert.equal(await close, false); assert.equal(await reload, false);
  assert.equal(f.win.destroyed, false); assert.equal(f.stats().stopped, 0);
  load.resolve(); await tick(); assert.equal(f.win.destroyed, false);
  assert.deepEqual(f.notices, ['changed']);
});

test('close before reload document commit remains fail-closed and cannot take its unload ticket', async t => {
  const gate = deferred();
  const f = fixture(t, { dirty: true, reload: async (_url, perform) => { await gate.promise; perform(); } });
  const reload = f.admission.requestReload(); await until(() => f.reloads.length === 1);
  assert.equal(await f.coordinator.request(), false);
  assert.equal(f.events.filter(event => event === 'inspect').length, 1);
  assert.equal(f.events.includes('reloaded'), false); assert.equal(f.stats().stopped, 0);
  gate.resolve(); assert.equal(await reload, true); assert.equal(f.win.destroyed, false);
});

test('confirmed renderer-gone explicit recovery reloads without executing the dead page', async t => {
  let gone = false;
  const f = fixture(t, { execute: (_kind, execute) => { if (gone) throw Error('Renderer process gone'); return execute(); } });
  gone = true;
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  const recover = f.admission.captureRecoveryDecision().reload;
  assert.equal(await recover(), true, 'Confirmed renderer-gone recovery cannot depend on JavaScript in the dead page');
  assert.deepEqual(f.reloads, ['http://127.0.0.1:45000/?project=project-a']);
  assert.deepEqual(f.scripts, []); assert.equal(f.stats().stopped, 0); assert.equal(f.win.destroyed, false);
});

test('gone recovery skips old dirty/busy metadata but never sends or retries business work', async t => {
  const f = fixture(t, { dirty: true, blocked: true, allowsUnload: () => true,
    execute: () => { throw Error('Dead page must not be queried'); } });
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(await f.admission.captureRecoveryDecision().reload(), true);
  assert.deepEqual(f.scripts, []); assert.equal(f.stats().discardCount, 0); assert.equal(f.stats().drainDecisionCount, 0);
  assert.equal(f.stats().stopped, 0); assert.equal(f.reloads.length, 1);
});

test('unresponsive recovery stays ordinary admission and cannot override unknown owner', async t => {
  const f = fixture(t, { dirty: true, blocked: true });
  f.win.webContents.emit('unresponsive');
  assert.equal(await f.admission.captureRecoveryDecision().reload(), false);
  assert.deepEqual(f.reloads, []); assert.deepEqual(f.events.filter(event => event === 'inspect'), ['inspect']);
  assert.deepEqual(f.notices, ['blocked']); assert.equal(f.stats().discardCount, 0);
});

test('live recovery still needs exact dirty confirmation', async t => {
  const f = fixture(t, { dirty: true, confirmDiscard: () => false });
  f.win.webContents.emit('unresponsive');
  assert.equal(await f.admission.captureRecoveryDecision().reload(), false);
  assert.equal(f.stats().discardCount, 1); assert.deepEqual(f.reloads, []); assert.equal(f.win.destroyed, false);
});

test('ordinary menu reload cannot use a confirmed-gone proof', async t => {
  const f = fixture(t, { execute: () => { throw Error('Renderer process gone'); } });
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(await f.admission.requestReload(), false);
  assert.deepEqual(f.reloads, []); assert.deepEqual(f.notices, ['unavailable']);
});

test('one gone proof and one captured recovery decision can be consumed only once', async t => {
  const load = deferred();
  const f = fixture(t, { reload: async (_url, perform) => { await load.promise; perform(); } });
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  const recover = f.admission.captureRecoveryDecision().reload, duplicate = f.admission.captureRecoveryDecision().reload;
  const result = recover();
  assert.equal(await recover(), false); assert.equal(await duplicate(), false);
  assert.equal(f.reloads.length, 1); assert.deepEqual(f.scripts, []);
  load.resolve(); assert.equal(await result, true);
});

test('late recovery dialog cannot consume a newer gone incident', async t => {
  const f = fixture(t);
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  const old = f.admission.captureRecoveryDecision().reload;
  f.navigate();
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  const current = f.admission.captureRecoveryDecision().reload;
  assert.equal(await old(), false); assert.deepEqual(f.reloads, []);
  assert.equal(await current(), true); assert.equal(f.reloads.length, 1);
});

test('unresponsive dialog cannot become a gone bypass after its captured generation changes', async t => {
  const f = fixture(t);
  f.win.webContents.emit('unresponsive');
  const old = f.admission.captureRecoveryDecision().reload;
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(await old(), false); assert.deepEqual(f.reloads, []);
  assert.equal(await f.admission.captureRecoveryDecision().reload(), true);
});

test('gone recovery is invalidated by exact URL, document or window ownership changes', async t => {
  for (const changed of ['url', 'document', 'owner']) {
    const f = fixture(t);
    f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    const recover = f.admission.captureRecoveryDecision().reload;
    if (changed === 'url') f.changeUrl('http://127.0.0.1:45000/?project=project-b');
    else if (changed === 'document') f.navigate();
    else f.replaceOwner();
    assert.equal(await recover(), false); assert.deepEqual(f.reloads, []); assert.deepEqual(f.scripts, []);
  }
});

test('late gone events from a replaced window cannot authorize recovery or cancel its replacement', async t => {
  const f = fixture(t); f.replaceOwner();
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(await f.admission.captureRecoveryDecision().reload(), false);
  assert.deepEqual(f.reloads, []); assert.equal(f.stats().cancelCount, 0); assert.deepEqual(f.notices, []);
});

test('late recovery load error after a newer window or close is inert', async t => {
  for (const changed of ['owner', 'close']) {
    const gate = deferred();
    const f = fixture(t, { reload: async (_url, perform) => { perform(); await gate.promise; } });
    f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    const result = f.admission.captureRecoveryDecision().reload(); await until(() => f.events.includes('reloaded'));
    if (changed === 'owner') f.replaceOwner();
    else assert.equal(await f.coordinator.request(), true);
    gate.reject(Object.assign(Error('Late old recovery error'), { code: 'ERR_CONNECTION_REFUSED' }));
    assert.equal(await result, false); await tick();
    assert.deepEqual(f.notices, []); assert.equal(f.stats().stopped, changed === 'close' ? 1 : 0);
  }
});

test('gone recovery ERR_ABORTED consumes proof without retrying the page or any task', async t => {
  const f = fixture(t, { reload: () => { throw Object.assign(Error('Cancelled recovery'), { code: 'ERR_ABORTED' }); },
    execute: () => { throw Error('Dead renderer'); } });
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  const recover = f.admission.captureRecoveryDecision().reload;
  assert.equal(await recover(), false); assert.equal(await recover(), false);
  assert.equal(f.reloads.length, 1); assert.deepEqual(f.scripts, []); assert.equal(f.stats().stopped, 0);
});

test('main captures incident-bound recovery before asking and discloses possible crash loss', async () => {
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  const from = main.indexOf('const rendererFailed = createProjectRendererRecovery('), to = main.indexOf('\nasync function fatal(', from);
  const recovery = main.slice(from, to);
  assert.match(recovery, /capture: window => windowAdmissions\.get\(window\)\?\.captureRecoveryDecision\(\)/);
  const coordinator = await readFile(new URL('../apps/desktop/src/project-window-recovery.ts', import.meta.url), 'utf8');
  assert.ok(coordinator.indexOf('options.capture(window)') < coordinator.indexOf('await options.prompt(window)'));
  assert.ok(coordinator.indexOf('recovery.claimPrompt()') < coordinator.indexOf('await options.prompt(window)'));
  assert.ok(recovery.includes("detail: nt('native.rendererDetail')"));
  assert.match(nativeText('native.rendererDetail'), /未保存的输入可能已经丢失/);
  assert.match(nativeText('native.rendererDetail'), /不会重新提交任务或生成请求/);
  assert.match(coordinator, /if \(result === 0\) await recovery\.reload\(\)/);
});

test('explicit confirmed-gone Exit closes once before stopping backend, without dead-page calls', async t => {
  const stop = deferred();
  const f = fixture(t, { dirty: true, blocked: true, allowsUnload: () => true,
    execute: () => { throw Error('The dead renderer must not be queried'); }, stop: () => stop.promise });
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  const decision = f.admission.captureRecoveryDecision();
  const exiting = decision.exit(); await until(() => f.stats().stopped === 1);
  assert.equal(f.win.destroyed, true); assert.equal(f.stats().finished, 0);
  assert.deepEqual(f.events, ['closed', 'stop']); assert.deepEqual(f.scripts, []);
  assert.equal(await decision.exit(), false); assert.equal(await decision.reload(), false);
  stop.resolve(); assert.equal(await exiting, true);
  assert.deepEqual(f.events, ['closed', 'stop', 'finish']); assert.equal(f.stats().stopped, 1);
});

test('unresponsive or live recovery Exit retains ordinary dirty and blocked admission', async t => {
  for (const blocked of [false, true]) {
    const f = fixture(t, { dirty: true, blocked, confirmDiscard: () => false });
    f.win.webContents.emit('unresponsive');
    assert.equal(await f.admission.captureRecoveryDecision().exit(), false);
    assert.equal(f.win.destroyed, false); assert.equal(f.stats().stopped, 0);
    assert.equal(f.stats().discardCount, blocked ? 0 : 1);
    assert.equal(f.events.includes('inspect'), true); assert.equal(f.stats().vetoOverrides, 0);
  }
});

test('gone Exit cannot override an unexpected renderer veto and leaves backend alive', async t => {
  const f = fixture(t, { unexpectedVeto: true });
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(await f.admission.captureRecoveryDecision().exit(), false);
  assert.equal(f.win.destroyed, false); assert.equal(f.stats().stopped, 0);
  assert.equal(f.stats().vetoOverrides, 0); assert.deepEqual(f.scripts, []);
});

test('unused gone Exit allowance cannot leak to a later unrelated quit', async t => {
  const f = fixture(t, { requestQuit: () => Promise.resolve(true), execute: () => { throw Error('Dead page'); } });
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  const decision = f.admission.captureRecoveryDecision();
  assert.equal(await decision.exit(), false); assert.equal(f.win.closeCalls, 0);
  assert.equal(await f.coordinator.request(), false);
  assert.equal(f.win.destroyed, false); assert.equal(f.stats().stopped, 0);
  assert.equal(f.events.includes('inspect'), true);
});

test('asynchronously scheduled quit cannot consume the synchronous gone allowance', async t => {
  const f = fixture(t, { requestQuit: coordinator => Promise.resolve().then(() => coordinator.request()),
    execute: () => { throw Error('Dead page'); } });
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(await f.admission.captureRecoveryDecision().exit(), false);
  await until(() => f.stats().cancelCount === 1);
  assert.equal(f.win.destroyed, false); assert.equal(f.stats().stopped, 0);
});

test('reload and Exit share exactly one confirmed-gone recovery decision', async t => {
  const load = deferred();
  const f = fixture(t, { reload: async (_url, perform) => { await load.promise; perform(); } });
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  const decision = f.admission.captureRecoveryDecision(), duplicate = f.admission.captureRecoveryDecision();
  const reloading = decision.reload();
  assert.equal(await decision.exit(), false); assert.equal(await duplicate.exit(), false);
  assert.equal(f.win.closeCalls, 0); assert.equal(f.stats().stopped, 0);
  load.resolve(); assert.equal(await reloading, true);
});

test('late recovery Exit cannot close a replacement window, changed URL/document or newer incident', async t => {
  for (const changed of ['owner', 'url', 'document', 'incident']) {
    const f = fixture(t);
    f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    const decision = f.admission.captureRecoveryDecision();
    if (changed === 'owner') f.replaceOwner();
    else if (changed === 'url') f.changeUrl('http://127.0.0.1:45000/?project=project-b');
    else if (changed === 'document') f.navigate();
    else { f.navigate(); f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 }); }
    assert.equal(await decision.exit(), false);
    assert.equal(f.win.closeCalls, 0); assert.equal(f.stats().stopped, 0); assert.equal(f.win.destroyed, false);
    if (changed === 'incident') assert.equal(await f.admission.captureRecoveryDecision().exit(), true);
  }
});

test('cancel/Escape in the actual recovery dialog retains window, backend and unconsumed proof', async t => {
  const f = fixture(t, { execute: () => { throw Error('Dead page must not be queried'); } });
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  const from = main.indexOf('const rendererFailed = createProjectRendererRecovery('), to = main.indexOf('\nasync function fatal(', from);
  let dialogOptions;
  const context = vm.createContext({ nt: nativeText, createProjectRendererRecovery, quitRouter: {allowsWindows: true}, windowAdmissions: new WeakMap([[f.win, f.admission]]),
    ownsWindow: () => true, dialog: { showMessageBox: async (parent, options) => { assert.equal(parent, f.win); dialogOptions = options; return { response: options.cancelId }; } },
    app: { quit() { assert.fail('Cancel cannot quit'); } }, window: f.win, ownerContext: {incident: {failed: false}} });
  vm.runInContext(executable(main.slice(from, to)), context);
  await vm.runInContext('rendererFailed(window, ownerContext)', context);
  assert.equal(dialogOptions.cancelId, 2);
  assert.deepEqual(Array.from(dialogOptions.buttons), ['重新载入界面', '退出应用', '保留窗口']);
  assert.equal(f.win.destroyed, false); assert.equal(f.stats().stopped, 0); assert.deepEqual(f.scripts, []);
  assert.equal(await f.admission.captureRecoveryDecision().exit(), true);
});

test('the actual recovery dialog authorizes Exit only for explicit response one', async t => {
  const f = fixture(t, { execute: () => { throw Error('Dead page must not be queried'); } });
  f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  const from = main.indexOf('const rendererFailed = createProjectRendererRecovery('), to = main.indexOf('\nasync function fatal(', from);
  const context = vm.createContext({ nt: nativeText, createProjectRendererRecovery, quitRouter: {allowsWindows: true}, windowAdmissions: new WeakMap([[f.win, f.admission]]),
    ownsWindow: () => true, dialog: { showMessageBox: async () => ({ response: 1 }) },
    app: { quit() { assert.fail('Explicit recovery must use its captured scoped decision'); } }, window: f.win, ownerContext: {incident: {failed: false}} });
  vm.runInContext(executable(main.slice(from, to)), context);
  await vm.runInContext('rendererFailed(window, ownerContext)', context);
  assert.equal(f.win.destroyed, true); assert.equal(f.stats().stopped, 1); assert.equal(f.stats().finished, 1);
  assert.deepEqual(f.scripts, []);
});

async function recoveryDialogHarness(t, f, show, isCurrent = () => true) {
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  const from = main.indexOf('const rendererFailed = createProjectRendererRecovery('), to = main.indexOf('\nasync function fatal(', from);
  const calls = [], pending = [], errors = [];
  const context = vm.createContext({ nt: nativeText, createProjectRendererRecovery, quitRouter: {allowsWindows: true}, windowAdmissions: new WeakMap([[f.win, f.admission]]),
    ownsWindow: () => isCurrent() && !f.win.destroyed,
    dialog: { showMessageBox: (parent, options) => { assert.equal(parent, f.win); calls.push(options); return show(calls.length, options); } },
    window: f.win, ownerContext: {incident: {failed: false}} });
  vm.runInContext(executable(main.slice(from, to)), context);
  const onFailure = () => pending.push(vm.runInContext('rendererFailed(window, ownerContext)', context).catch(error => errors.push(error)));
  f.win.webContents.on('unresponsive', onFailure); f.win.webContents.on('render-process-gone', onFailure);
  t.after(() => { f.win.webContents.removeListener('unresponsive', onFailure); f.win.webContents.removeListener('render-process-gone', onFailure); });
  return { calls, pending, errors };
}

for (const oldResponse of [0, 1, 2]) {
  test(`pending live recovery response ${oldResponse} cannot consume gone proof and a fresh explicit prompt remains reachable`, async t => {
    const old = deferred(), fresh = deferred();
    const f = fixture(t, { execute: () => { throw Error('The dead renderer must not be queried'); } });
    const h = await recoveryDialogHarness(t, f, index => index === 1 ? old.promise : fresh.promise);
    f.win.webContents.emit('unresponsive'); assert.equal(h.calls.length, 1);
    f.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    assert.equal(h.calls.length, 1);
    old.resolve({ response: oldResponse });
    await until(() => h.calls.length === 2);
    assert.equal(f.reloads.length, 0); assert.equal(f.win.closeCalls, 0); assert.equal(f.stats().stopped, 0);
    fresh.resolve({ response: oldResponse }); await Promise.all(h.pending);
    assert.equal(h.calls.length, 2); assert.deepEqual(h.errors, []); assert.deepEqual(f.scripts, []);
    assert.equal(f.reloads.length, oldResponse === 0 ? 1 : 0);
    assert.equal(f.win.destroyed, oldResponse === 1); assert.equal(f.stats().stopped, oldResponse === 1 ? 1 : 0);
  });
}

test('duplicate notifications of one unchanged renderer incident do not reopen a kept dialog', async t => {
  const gate = deferred(), f = fixture(t);
  const h = await recoveryDialogHarness(t, f, () => gate.promise);
  f.win.webContents.emit('render-process-gone');
  f.win.webContents.emit('render-process-gone'); f.win.webContents.emit('unresponsive');
  gate.resolve({ response: 2 }); await Promise.all(h.pending);
  f.win.webContents.emit('render-process-gone'); f.win.webContents.emit('unresponsive'); await tick();
  assert.equal(h.calls.length, 1); assert.equal(f.reloads.length, 0); assert.equal(f.win.closeCalls, 0);
  assert.deepEqual(h.errors, []); assert.equal(f.stats().stopped, 0);
});

test('a queued newer renderer incident cannot prompt after owner, document, URL or action replacement', async t => {
  for (const changed of ['owner', 'document', 'url', 'action']) {
    const gate = deferred(), f = fixture(t); let current = true;
    const h = await recoveryDialogHarness(t, f, () => gate.promise, () => current);
    f.win.webContents.emit('unresponsive'); f.win.webContents.emit('render-process-gone');
    if (changed === 'owner') { current = false; f.replaceOwner(); }
    else if (changed === 'document') f.navigate();
    else if (changed === 'url') f.changeUrl('http://127.0.0.1:45000/?project=project-b');
    else assert.equal(await f.admission.requestReload(), true);
    gate.resolve({ response: 2 }); await Promise.all(h.pending); await tick();
    assert.equal(h.calls.length, 1); assert.equal(f.stats().stopped, 0); assert.deepEqual(h.errors, []);
  }
});

test('a recovered live renderer can report a later hang without inheriting old dialog permission', async t => {
  const f = fixture(t), h = await recoveryDialogHarness(t, f, async () => ({ response: 2 }));
  f.win.webContents.emit('unresponsive'); await Promise.all(h.pending);
  f.win.webContents.emit('unresponsive'); await Promise.all(h.pending); assert.equal(h.calls.length, 1);
  f.win.webContents.emit('responsive'); f.win.webContents.emit('unresponsive'); await Promise.all(h.pending);
  assert.equal(h.calls.length, 2); assert.equal(f.reloads.length, 0); assert.equal(f.win.closeCalls, 0);
});

async function reloadMenuHarness(f, isCurrent = () => true) {
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  const from = main.indexOf('function installMenu()'), to = main.indexOf('\nconst quitCoordinator', from);
  let menu;
  const errors = [];
  const context = vm.createContext({ nt: nativeText, process: { platform: 'linux' }, windowContext: {incident: {failed: false}}, windowHost: {preferredWindow: () => f.win}, initialWindowLoads: new WeakMap(), win: f.win, BrowserWindow: { getFocusedWindow: () => f.win },
    windowAdmissions: new WeakMap([[f.win, f.admission]]), ownsWindow: () => isCurrent() && !f.win.destroyed,
    Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { menu = value; } }, fatal: error => errors.push(error) });
  vm.runInContext(executable(main.slice(from, to)) + '\ninstallMenu();', context);
  return { reload: () => menu.find(item => item.label === '应用').submenu.find(item => item.label === '重新载入界面').click(), errors };
}

test('the explicit Reload menu can recover a kept confirmed-gone incident exactly once', async t => {
  const f = fixture(t, { execute: () => { throw Error('Dead page cannot be probed'); } });
  const h = await recoveryDialogHarness(t, f, async () => ({ response: 2 }));
  f.win.webContents.emit('render-process-gone'); await Promise.all(h.pending);
  assert.equal(h.calls.length, 1); assert.equal(f.reloads.length, 0); assert.equal(f.win.closeCalls, 0);
  const oldDecision = f.admission.captureRecoveryDecision(), menu = await reloadMenuHarness(f);
  menu.reload(); await until(() => f.events.includes('reloaded')); await tick();
  assert.equal(f.reloads.length, 1); assert.deepEqual(f.scripts, []); assert.deepEqual(menu.errors, []);
  assert.equal(f.stats().stopped, 0); assert.equal(f.win.destroyed, false);
  assert.equal(await oldDecision.reload(), false); assert.equal(await oldDecision.exit(), false);
  menu.reload(); await until(() => f.notices.includes('unavailable'));
  assert.equal(f.reloads.length, 1, 'The consumed gone proof cannot authorize another reload');
});

test('the explicit Reload menu cannot treat unresponsive or replaced owners as confirmed gone', async t => {
  for (const replaced of [false, true]) {
    const f = fixture(t, { blocked: true });
    f.win.webContents.emit(replaced ? 'render-process-gone' : 'unresponsive');
    if (replaced) f.replaceOwner();
    const menu = await reloadMenuHarness(f, () => !replaced);
    menu.reload(); await tick(); await tick();
    assert.equal(f.reloads.length, 0); assert.equal(f.win.closeCalls, 0); assert.equal(f.stats().stopped, 0);
    assert.equal(f.stats().discardCount, 0); assert.deepEqual(menu.errors, []);
    assert.deepEqual(f.notices, replaced ? [] : ['blocked']);
  }
});

async function actualMainAdmissionCallbacks(dialog, window = {}, owner = () => true, bindings = {}) {
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  const from = main.indexOf('windowAdmissions.set(window, installNativeCloseAdmission(window, {');
  const to = main.indexOf("\n  window.on('closed'", from);
  let callbacks;
  const context = vm.createContext({ nt: nativeText, window, context: { ready: { url: 'http://127.0.0.1:45000' } },
    owner: {url: 'http://127.0.0.1:45000'}, initialLoad: {consumeClose: () => false}, windowHost: {closeStateChanged() {}},
    windowAdmissions: new WeakMap(), installNativeCloseAdmission: (_window, value) => { callbacks = value; return {}; },
    ownsWindow: owner, isAllowedNavigation: () => true, smokeOutput: false, smokeDiscardDecision: undefined,
    dialog, quitCoordinator: { cancel() {}, request: () => Promise.resolve(false) }, quitFailed() {}, ...bindings });
  vm.runInContext(executable(main.slice(from, to)), context);
  return callbacks;
}

for (const kind of ['confirmClose', 'confirmDiscard', 'confirmUnknown', 'onBlocked']) {
  test(`actual main ${kind} leaves utility heartbeat schedulable while the native dialog awaits its response`, async () => {
    const gate = deferred(), window = {};
    let heartbeat = 0, settled = false, presented;
    const callbacks = await actualMainAdmissionCallbacks({
      showMessageBox(parent, options) { assert.equal(parent, window); presented = options; return gate.promise; },
      showMessageBoxSync(_parent, options) {
        presented = options;
        // Model a synchronous native-dialog wait on main. It returns before
        // queued utility callbacks run and cannot expose an unresolved choice.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        return 0;
      },
    }, window);
    const ping = new Promise(resolve => setImmediate(() => { heartbeat++; resolve(); }));
    const choice = Promise.resolve(callbacks[kind](kind === 'onBlocked' ? 'changed' : 'reload'));
    void choice.then(() => { settled = true; });
    await ping;
    assert.equal(heartbeat, 1); assert.equal(settled, false, 'A pending native dialog must not synchronously return or block utility processing');
    assert.equal(presented.cancelId, kind === 'onBlocked' ? 0 : 1);
    gate.resolve({ response: 0 });
    const result = await choice;
    if (kind !== 'onBlocked') assert.equal(result, true);
  });
}

for (const kind of ['confirmClose', 'confirmDiscard']) {
  test(`actual async ${kind} preserves decline and cannot authorize a replaced owner`, async t => {
    for (const replaced of [false, true]) {
      const gate = deferred(); let presented;
      const callbacks = await actualMainAdmissionCallbacks({
        showMessageBox(_parent, options) { presented = options; return gate.promise; },
        showMessageBoxSync() { assert.fail('Admission must never use a synchronous native dialog'); },
      });
      const f = fixture(t, { dirty: kind === 'confirmDiscard', flush: () => kind !== 'confirmClose',
        [kind]: action => callbacks[kind](action) });
      const closing = f.coordinator.request();
      await until(() => presented);
      assert.equal(presented.defaultId, 1); assert.equal(presented.cancelId, 1);
      assert.equal(f.win.destroyed, false); assert.equal(f.stats().stopped, 0);
      if (replaced) f.replaceOwner();
      gate.resolve({ response: replaced ? 0 : 1 });
      if (replaced) {
        // The real owner's replacement cancels its old QuitCoordinator scope;
        // the native continuation must not cancel or close the new owner.
        f.coordinator.cancel();
      }
      assert.equal(await closing, false); await tick();
      assert.equal(f.win.destroyed, false); assert.equal(f.stats().stopped, 0);
      assert.equal(f.commits.length, 0); assert.equal(f.stats().vetoOverrides, 0);
    }
  });
}

test('native close completion and disposal never reacquire destroyed BrowserWindow contents', async t => {
  const f = fixture(t), contents = f.win.webContents;
  Object.defineProperty(f.win, 'webContents', {get() {
    if (f.win.destroyed) throw new TypeError('Object has been destroyed');
    return contents;
  }});
  assert.equal(await f.coordinator.request(), true);
  const scripts = f.scripts.length;
  assert.doesNotThrow(() => f.admission.dispose()); assert.doesNotThrow(() => f.admission.dispose());
  assert.equal(await f.admission.requestReload(), false); assert.equal(f.scripts.length, scripts);
  for (const event of ['will-prevent-unload', 'did-start-navigation', 'did-navigate', 'render-process-gone', 'unresponsive', 'responsive']) {
    assert.equal(contents.listenerCount(event), 0);
  }
});


test('pre-reload retirement is shared and finishes before any fresh P0 inspection', async t => {
  const retirement = deferred(); let calls = 0, signal;
  const f = fixture(t, { beforeReload: value => { calls++; signal = value; return retirement.promise; } });
  const first = f.admission.requestReload(), duplicate = f.admission.requestReload();
  assert.equal(first, duplicate); await tick();
  assert.equal(calls, 1); assert.deepEqual(f.scripts, []); assert.deepEqual(f.reloads, []); assert.equal(signal.aborted, false);
  retirement.resolve(true); assert.equal(await first, true);
  assert.deepEqual(f.events, ['inspect', 'flush', 'commit', 'reload', 'reloaded']);
  assert.equal(signal.aborted, true, 'Document commit releases only this reload preparation fence');
});

for (const outcome of ['denied', 'rejected']) {
  test(`pre-reload retirement ${outcome} leaves the page and P0 untouched`, async t => {
    const retirement = deferred(); let signal;
    const f = fixture(t, { beforeReload: value => { signal = value; return retirement.promise; } });
    const reloading = f.admission.requestReload(); await tick();
    assert.deepEqual(f.scripts, []);
    if (outcome === 'denied') retirement.resolve(false); else retirement.reject(Error('Cleanup unknown'));
    assert.equal(await reloading, false); assert.deepEqual(f.reloads, []); assert.deepEqual(f.scripts, []);
    assert.equal(signal.aborted, true); assert.equal(f.win.destroyed, false);
  });
}

test('pre-reload retirement captures later input afresh and cancelled consent never resumes playback', async t => {
  const retirement = deferred(); let calls = 0, signal;
  const f = fixture(t, { beforeReload: value => { calls++; signal = value; return retirement.promise; }, confirmDiscard: () => false });
  const reloading = f.admission.requestReload(); await tick();
  assert.deepEqual(f.scripts, []); f.change({nextDirty: true}); retirement.resolve(true);
  assert.equal(await reloading, false); assert.equal(f.stats().discardCount, 1);
  assert.equal(calls, 1); assert.equal(signal.aborted, true); assert.deepEqual(f.reloads, []); assert.equal(f.win.destroyed, false);
});

for (const replaced of ['owner', 'document', 'url', 'closed', 'disposed']) {
  test(`pre-reload retirement late success cannot reload a replaced ${replaced}`, async t => {
    const retirement = deferred(); let signal;
    const f = fixture(t, {beforeReload: value => {signal = value; return retirement.promise;}});
    const reloading = f.admission.requestReload(); await tick();
    assert.deepEqual(f.scripts, []);
    if (replaced === 'owner') f.replaceOwner();
    if (replaced === 'document') f.navigate();
    if (replaced === 'url') f.changeUrl('http://127.0.0.1:45000/?project=project-b');
    if (replaced === 'closed') {f.win.destroyed = true; f.win.emit('closed');}
    if (replaced === 'disposed') f.admission.dispose();
    retirement.resolve(true); assert.equal(await reloading, false); await tick();
    assert.deepEqual(f.scripts, []); assert.deepEqual(f.reloads, []); assert.equal(signal.aborted, true);
  });
}

test('pre-reload retirement old completion cannot release or advance a newer reload attempt', async t => {
  const old = deferred(), fresh = deferred(), signals = [];
  const f = fixture(t, {beforeReload: signal => {signals.push(signal); return signals.length === 1 ? old.promise : fresh.promise;}});
  const first = f.admission.requestReload(); await tick(); assert.deepEqual(f.scripts, []);
  f.navigate(); assert.equal(await first, false);
  const second = f.admission.requestReload(); await tick(); assert.equal(signals.length, 2);
  old.resolve(true); await tick(); assert.deepEqual(f.scripts, []); assert.equal(signals[1].aborted, false);
  fresh.resolve(true); assert.equal(await second, true); assert.equal(f.reloads.length, 1); assert.equal(signals[1].aborted, true);
});

test('pre-reload retirement is not requested for ordinary close or confirmed-gone recovery', async t => {
  const close = fixture(t, {beforeReload: () => assert.fail('Close retains its existing protocol')});
  assert.equal(await close.coordinator.request(), true);
  const gone = fixture(t, {beforeReload: () => assert.fail('Gone proof cannot wait for a dead renderer ACK')});
  gone.win.webContents.emit('render-process-gone');
  assert.equal(await gone.admission.captureRecoveryDecision().reload(), true);
  assert.deepEqual(gone.events, ['reload', 'reloaded']);
});


test('pre-reload retirement timeout abandons observation without lending the P0 ticket lease', async t => {
  const retirement = deferred(); let signal;
  const f = fixture(t, {reloadPreparationTimeoutMs: 5, timeoutMs: 200,
    beforeReload: value => {signal = value; return retirement.promise;}});
  const reloading = f.admission.requestReload();
  assert.equal(await reloading, false); assert.equal(signal.aborted, true); assert.deepEqual(f.scripts, []);
  retirement.resolve(true); await tick(); assert.deepEqual(f.reloads, []);
});


test('actual main pre-reload hook binds the original audio host and captured exact editor contents', async () => {
  const contents = {}, window = {}, signal = new AbortController().signal, gate = deferred(), calls = [];
  const owner = {role: 'editor', backendId: 'backend-a'}, document = {...owner, window, contextId: 'document-a'};
  let currentDocument = document;
  Object.defineProperty(window, 'webContents', {get() {assert.fail('The callback must use the previously captured contents');}});
  const callbacks = await actualMainAdmissionCallbacks({}, window, () => true, {contents, owner,
    context: {audioHost: {retireOwnerForReload(captured, received) {calls.push(captured); assert.equal(received, signal); return gate.promise;}}},
    nativeAudioHost: {retireOwnerForReload() {assert.fail('Never use a replacement global audio host');}},
    windowHost: {ownerForContents(received) {assert.equal(received, contents); return currentDocument;}}});
  const preparation = callbacks.beforeReload(signal);
  assert.equal(calls.length, 1); assert.equal(calls[0].window, window); assert.equal(calls[0].contents, contents);
  assert.equal(calls[0].contextId, 'document-a'); gate.resolve(true); assert.equal(await preparation, true);
  currentDocument = null; assert.equal(await callbacks.beforeReload(signal), false); assert.equal(calls.length, 1);
});
