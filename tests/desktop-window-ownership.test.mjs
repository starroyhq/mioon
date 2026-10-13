import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { createDesktopStartup } from '../apps/desktop/src/startup.mjs';
import { BackendSupervisor } from '../apps/desktop/src/supervisor.mjs';
import { stopBackendForQuit } from '../apps/desktop/src/shutdown.mjs';
import * as lifecycle from '../apps/desktop/src/lifecycle.mjs';
import * as security from '../apps/desktop/src/security.mjs';
import { windowChromeOptions, MAC_TRAFFIC_LIGHT_POSITION } from '../apps/desktop/src/window-chrome.ts';

const source = (await readFile(new URL('../apps/desktop/src/main.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const tools = { ffmpeg: '/synthetic/ffmpeg', ffprobe: '/synthetic/ffprobe', versions: { ffmpeg: 'synthetic' } };
const deferred = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));
const failure = code => Object.assign(new Error(`Synthetic ${code}`), { code });
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await tick(); }
  assert.fail('Synthetic window lifecycle did not reach the expected checkpoint');
}

// The real main, supervisor, security and lifecycle functions run in this VM.
// Only OS boundaries are fake. No Electron, native vault, utility or media runs.
// Deferred gates expose causality; they do not claim native event timing.
async function harness(t, options = {}) {
  const r = { scopes: [], validations: [], backends: [], children: [], sessions: [], windows: [],
    connections: [], connectionWrites: [], dialogs: [], syncDialogs: [], drains: 0, removals: 0,
    quits: 0, finished: 0, exits: [], settingsCloses: 0 };
  let menu, initial;
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false, enableSandbox() {}, setName() {}, setAppUserModelId() {},
    getPath: () => '/synthetic', getAppPath: () => '/synthetic/app', requestSingleInstanceLock: () => true,
    whenReady: () => ({ then(callback) { return { catch(onError) {
      initial = Promise.resolve().then(callback).catch(onError); return initial;
    } }; } }),
    quit() {
      r.quits++; let prevented = false;
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      if (!prevented) r.finished++;
    },
    exit(code) { r.exits.push(code); }
  });
  function fork() {
    const index = r.children.length, config = options.child?.(index) ?? {};
    const child = Object.assign(new EventEmitter(), {
      pid: 31000 + index, messages: [], kills: 0, hardKills: 0,
      ready() { child.emit('message', { type: 'ready', url: `http://127.0.0.1:${45000 + index}`, runtime: { pid: child.pid } }); },
      postMessage(message) {
        child.messages.push(message.type);
        if (message.type === 'start' && config.ready !== false) queueMicrotask(() => child.ready());
        if (message.type === 'stop' && config.exit !== false) queueMicrotask(() => {
          if (config.media) child.emit('message', { type: 'media-process', event: 'started', pid: 50000 + index });
          child.emit('exit', config.exitCode ?? 0);
        });
      },
      kill() { child.kills++; }
    });
    r.children.push(child); return child;
  }
  class Window extends EventEmitter {
    constructor(config) {
      super(); this.config = config; this.destroyed = false; this.closedDelivered = false;
      this.urls = []; this.shows = 0; this.focuses = 0; this.flushes = 0;
      this.index = r.windows.length;
      this.webContents = Object.assign(new EventEmitter(), {
        getURL: () => this.urls.at(-1),
        executeJavaScript: async () => { this.flushes++; return await options.flush?.(this.index) ?? true; },
        setWindowOpenHandler: fn => { this.popupPolicy = fn; }
      });
      r.windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    deliverClosed() { if (!this.closedDelivered) { this.closedDelivered = true; this.emit('closed'); } }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (options.holdClosed?.(this.index)) return;
      this.deliverClosed();
    }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (!prevented) this.destroy();
    }
    show() { this.shows++; }
    hide() {}
    focus() { this.focuses++; }
    async loadURL(url) {
      this.urls.push(url);
      await options.load?.(this.index, this.urls.length, url);
    }
  }
  const context = vm.createContext({ app, process: { platform: 'darwin', env: {}, on() {} }, path, randomBytes, randomUUID,
    __MIOON_DESKTOP_CHANNEL__: 'development', desktopIdentity: { identityForChannel: () => ({ channel: 'development', productName: 'Synthetic', appId: 'synthetic' }) },
    prepareDesktopStorage: () => ({ dataDir: '/synthetic/workspace', configFile: '/synthetic/config' }),
    ensureDataIdentity: async () => {}, readToolConfig: async () => tools,
    createDesktopStartup: () => {
      const index = r.scopes.length;
      const scope = createDesktopStartup({ terminate: async () => { r.drains++; return await options.drain?.(index) ?? []; }, wait: async () => {} });
      r.scopes.push(scope); return scope;
    },
    validateTools: (_, { signal }) => { const index = r.validations.length; r.validations.push(signal); return options.validate?.(index) ?? tools; },
    createDesktopAgentSettings: async () => ({ async close() { r.settingsCloses++; } }),
    safeStorage: {}, createDesktopImageSecretCodec: () => ({}), utilityEnvironment: () => ({}), utilityProcess: { fork },
    BackendSupervisor: class extends BackendSupervisor {
      constructor(config) {
        super({ ...config, startupTimeout: 5000, stopTimeout: 5000, terminateTimeout: 100, exitTimeout: 100,
          forceKill: child => { child.hardKills++; } });
        r.backends.push(this);
      }
    },
    BrowserWindow: Window, windowChromeOptions: () => windowChromeOptions('darwin'),
    session: { fromPartition() {
      const index = r.sessions.length;
      const value = Object.assign(new EventEmitter(), {
        clears: 0, clearFinished: false, cookieStarted: false, cookieReady: false,
        async clearStorageData() { value.clears++; await options.clear?.(index); value.clearFinished = true; },
        cookies: { async set(cookie) { value.cookieStarted = true; await options.cookie?.(index); value.cookie = cookie; value.cookieReady = true; } },
        setPermissionRequestHandler(fn) { value.permissionRequest = fn; },
        setPermissionCheckHandler(fn) { value.permissionCheck = fn; },
        setDevicePermissionHandler(fn) { value.devicePermission = fn; },
        setDisplayMediaRequestHandler(fn) { value.displayPermission = fn; },
        webRequest: { onBeforeRequest(fn) { value.beforeRequest = fn; } }
      });
      r.sessions.push(value); return value;
    } },
    ...security, ...lifecycle, stopBackendForQuit,
    writeConnection: async (_, value) => {
      const index = r.connectionWrites.length;
      r.connectionWrites.push(value); await options.connection?.(index); r.connections.push(value);
    },
    removeConnectionOnShutdown: async () => { r.removals++; await options.remove?.(r.removals); },
    Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { menu = value; } },
    dialog: {
      showMessageBox: async value => { r.dialogs.push(value); return await options.dialog?.(value) ?? { response: 0 }; },
      showMessageBoxSync: (window, value) => { r.syncDialogs.push({ window, value }); return options.syncDialog?.(window, value) ?? 0; }
    },
    storageFailureDialog: error => ({ title: 'Storage failure', detail: error.message })
  });
  vm.runInContext(source, context, { filename: 'actual-desktop-main.mjs' });
  const get = text => vm.runInContext(text, context);
  t.after(async () => {
    get('quitting = true'); options.release?.();
    for (const child of r.children) child.emit('exit', 0);
    for (const window of r.windows) { window.destroy(); window.deliverClosed(); }
    await tick();
  });
  await until(() => menu);
  return {
    r, app, get, initial: () => initial,
    restart: () => menu.find(item => item.label === '应用').submenu.find(item => item.label === '重启本地服务').click(),
    reload: () => menu.find(item => item.label === '应用').submenu.find(item => item.label === '重新载入界面').click(),
    activate: () => app.emit('activate'),
    fatals: () => r.dialogs.filter(item => item.title === '无法启动 Mioon'),
    rendererDialogs: () => r.dialogs.filter(item => item.title === '界面需要重新载入'),
    assertCurrent(index = r.backends.length - 1) {
      const live = r.windows.filter(window => !window.destroyed);
      assert.equal(live.length, 1);
      const window = live[0], backend = r.backends[index], session = r.sessions.at(-1), connection = r.connections.at(-1);
      assert.equal(get('win'), window);
      assert.equal(get('ready.url'), backend.origin);
      assert.equal(get('activeSession'), session);
      assert.equal(window.urls.at(-1), `${backend.origin}/`);
      assert.equal(window.config.webPreferences.session, session);
      assert.equal(session.cookieReady, true);
      assert.equal(connection.url, backend.origin);
      assert.equal(connection.pid, backend.child.pid);
      assert.equal(session.cookie.value, connection.token);
      assert.equal(r.quits, 0);
      assert.equal(r.dialogs.some(item => item.title === '无法启动 Mioon'), false);
    },
    assertPolicies() {
      for (const session of r.sessions) {
        let decision;
        session.beforeRequest({ url: 'https://untrusted.invalid/', resourceType: 'xhr' }, value => { decision = value; });
        assert.equal(decision.cancel, true); assert.equal(session.permissionCheck(), false);
      }
      for (const window of r.windows) {
        assert.equal(window.config.webPreferences.sandbox, true);
        assert.equal(window.config.webPreferences.contextIsolation, true);
        assert.equal(window.config.webPreferences.nodeIntegration, false);
        assert.equal(window.config.titleBarStyle, 'hidden');
        assert.deepEqual(window.config.trafficLightPosition, MAC_TRAFFIC_LIGHT_POSITION);
        assert.equal(window.popupPolicy().action, 'deny');
      }
    }
  };
}

for (const stage of ['drain', 'backend-stop', 'remove', 'clear', 'new-validation', 'new-backend', 'new-cookie', 'new-connection', 'new-load']) {
  test(`activate cannot open a second window at restart ${stage}`, { timeout: 10000 }, async t => {
    const gate = deferred();
    const options = { release: () => gate.resolve(stage === 'new-validation' ? tools : undefined) };
    // drain/remove/connection deliberately add synthetic pauses; backend exit,
    // session clear, cookie installation and navigation have real async APIs.
    if (stage === 'drain') options.drain = i => i === 0 ? gate.promise : [];
    if (stage === 'backend-stop') options.child = i => i === 0 ? { exit: false } : {};
    if (stage === 'remove') options.remove = n => n === 1 ? gate.promise : undefined;
    if (stage === 'clear') options.clear = i => i === 0 ? gate.promise : undefined;
    if (stage === 'new-validation') options.validate = i => i === 1 ? gate.promise : tools;
    if (stage === 'new-backend') options.child = i => i === 1 ? { ready: false } : {};
    if (stage === 'new-cookie') options.cookie = i => i === 1 ? gate.promise : undefined;
    if (stage === 'new-connection') options.connection = i => i === 1 ? gate.promise : undefined;
    if (stage === 'new-load') options.load = i => i === 1 ? gate.promise : undefined;
    const f = await harness(t, options); await f.initial(); f.assertCurrent();
    const restarting = f.restart();
    await until(() => stage === 'drain' ? f.r.drains === 1 : stage === 'backend-stop' ? f.r.children[0].messages.includes('stop') :
      stage === 'remove' ? f.r.removals === 1 : stage === 'clear' ? f.r.sessions[0].clears === 1 :
      stage === 'new-validation' ? f.r.validations.length === 2 : stage === 'new-backend' ? f.r.children.length === 2 :
      stage === 'new-cookie' ? f.r.sessions[1]?.cookieStarted : stage === 'new-connection' ? f.r.connectionWrites.length === 2 : f.r.windows.length === 2);
    assert.equal(f.get('restarting'), true);
    const windows = f.r.windows.length, backends = f.r.backends.length;
    f.activate(); f.activate(); f.app.emit('second-instance'); f.reload(); await tick();
    assert.equal(f.r.windows.length, windows);
    assert.equal(f.r.backends.length, backends);
    if (stage === 'backend-stop') f.r.children[0].emit('exit', 0);
    else if (stage === 'new-backend') f.r.children[1].ready();
    else gate.resolve(stage === 'new-validation' ? tools : undefined);
    await restarting;
    f.assertCurrent(1); f.assertPolicies();
    assert.equal(f.r.windows.length, 2); assert.equal(f.r.backends.length, 2);
    assert.equal(f.r.children[0].messages.filter(type => type === 'stop').length, 1);
    assert.equal(f.r.children[0].kills, 0); assert.equal(f.r.children[0].hardKills, 0);
    const current = f.get('win');
    current.emit('ready-to-show'); assert.equal(current.shows >= 1, true);
    f.activate(); await tick(); assert.equal(f.r.windows.length, 2);
  });
}

for (const stage of ['cookie', 'connection']) {
  test(`initial ${stage} preparation cannot be bypassed by activate`, async t => {
    const gate = deferred();
    const f = await harness(t, { [stage]: () => gate.promise, release: () => gate.resolve() });
    await until(() => stage === 'cookie' ? f.r.sessions[0]?.cookieStarted : f.r.connectionWrites.length === 1);
    f.activate(); f.activate(); await tick();
    assert.equal(f.r.windows.length, 0); assert.equal(f.r.backends.length, 1);
    gate.resolve(); await f.initial(); f.assertCurrent(); f.assertPolicies();
    assert.equal(f.r.windows.length, 1);
  });
}

test('normal activate reopens only the existing authenticated backend session', async t => {
  const f = await harness(t); await f.initial();
  f.activate(); f.activate(); await tick(); assert.equal(f.r.windows.length, 1);
  f.r.windows[0].destroy(); f.activate(); f.activate(); await tick();
  f.assertCurrent(); f.assertPolicies();
  assert.equal(f.r.windows.length, 2); assert.equal(f.r.backends.length, 1); assert.equal(f.r.sessions.length, 1);
});

test('old closed, ready-to-show and renderer events cannot affect a replacement', async t => {
  const f = await harness(t, { holdClosed: i => i === 0 }); await f.initial();
  const old = f.get('win'); await f.restart();
  const replacement = f.get('win');
  assert.notEqual(old, replacement); assert.equal(old.destroyed, true); assert.equal(old.closedDelivered, false);
  old.emit('ready-to-show'); old.deliverClosed();
  old.webContents.emit('render-process-gone'); old.webContents.emit('unresponsive'); await tick();
  assert.equal(replacement.shows, 0); assert.equal(old.shows, 0); assert.equal(f.rendererDialogs().length, 0);
  assert.equal(f.get('win'), replacement);
  f.activate(); await tick(); f.assertCurrent(1); assert.equal(f.r.windows.length, 2);
  replacement.emit('ready-to-show'); assert.equal(replacement.shows, 1);
});

test('activate cannot navigate to the old origin while its session is clearing', async t => {
  const gate = deferred(); let clearing = true, oldNavigationAttempts = 0;
  const f = await harness(t, {
    clear: i => i === 0 ? gate.promise : undefined,
    load: async i => { if (i > 0 && clearing) { oldNavigationAttempts++; throw failure('OLD_ORIGIN_LOAD_FAILED'); } },
    release: () => gate.resolve()
  });
  await f.initial(); const restarting = f.restart(); await until(() => f.r.sessions[0].clears === 1);
  f.activate(); await tick();
  assert.equal(oldNavigationAttempts, 0); assert.equal(f.fatals().length, 0); assert.equal(f.r.quits, 0);
  clearing = false; gate.resolve(); await restarting; f.assertCurrent(1);
});

for (const outcome of ['resolve', 'reject']) {
  test(`superseded activate navigation ${outcome} cannot fail its replacement`, async t => {
    const gate = deferred();
    const f = await harness(t, { load: i => i === 1 ? gate.promise : undefined, release: () => gate.resolve() });
    await f.initial(); f.get('win').destroy(); f.activate(); await until(() => f.r.windows.length === 2);
    const old = f.get('win'); await f.restart(); const replacement = f.get('win');
    if (outcome === 'resolve') gate.resolve(); else gate.reject(failure('OLD_NAVIGATION_FAILED'));
    await tick(); await tick();
    assert.equal(old.destroyed, true); assert.notEqual(old, replacement); assert.equal(f.get('win'), replacement);
    f.assertCurrent(1); assert.equal(f.r.backends.length, 2); assert.equal(f.r.windows.length, 3);
  });
}

for (const response of [0, 1, 'reject']) {
  test(`superseded renderer dialog result ${response} cannot reload or quit replacement`, async t => {
    const gate = deferred();
    const f = await harness(t, {
      dialog: value => value.title === '界面需要重新载入' ? gate.promise : { response: 0 },
      release: () => gate.resolve({ response: 0 })
    });
    await f.initial(); f.get('win').webContents.emit('unresponsive');
    await until(() => f.rendererDialogs().length === 1);
    await f.restart(); const replacement = f.get('win');
    if (response === 'reject') gate.reject(failure('OLD_RENDERER_DIALOG_FAILED')); else gate.resolve({ response });
    await until(() => f.get('rendererErrorOwner') === null); await tick();
    assert.equal(replacement.urls.length, 1); f.assertCurrent(1); assert.equal(f.r.backends.length, 2);
  });
}

for (const oldResponse of [0, 1, 'reject']) {
  test(`pending old renderer dialog ${oldResponse} cannot block or release replacement dialog ownership`, async t => {
    const oldGate = deferred(), currentGate = deferred(); let rendererDialogs = 0;
    const f = await harness(t, {
      dialog: value => value.title === '界面需要重新载入'
        ? (++rendererDialogs === 1 ? oldGate.promise : currentGate.promise) : { response: 0 },
      release: () => { oldGate.resolve({ response: 0 }); currentGate.resolve({ response: 0 }); }
    });
    await f.initial(); const oldWindow = f.get('win');
    oldWindow.webContents.emit('unresponsive'); oldWindow.webContents.emit('render-process-gone');
    await until(() => f.rendererDialogs().length === 1);
    const oldOwner = f.get('rendererErrorOwner');
    await f.restart(); const replacement = f.get('win');
    replacement.webContents.emit('unresponsive'); replacement.webContents.emit('render-process-gone');
    await until(() => f.rendererDialogs().length === 2);
    const currentOwner = f.get('rendererErrorOwner');
    assert.notEqual(currentOwner, oldOwner); assert.equal(currentOwner.window, replacement);
    if (oldResponse === 'reject') oldGate.reject(failure('OLD_RENDERER_DIALOG_FAILED'));
    else oldGate.resolve({ response: oldResponse });
    await tick(); await tick();
    assert.equal(f.get('rendererErrorOwner'), currentOwner);
    assert.equal(replacement.urls.length, 1); f.assertCurrent(1);
    replacement.webContents.emit('unresponsive'); replacement.webContents.emit('render-process-gone');
    oldWindow.webContents.emit('unresponsive'); await tick();
    assert.equal(f.rendererDialogs().length, 2);
    currentGate.resolve({ response: 0 });
    await until(() => f.get('rendererErrorOwner') === null);
    assert.equal(replacement.urls.length, 2); f.assertCurrent(1);
  });
}

for (const entry of ['activate', 'renderer', 'menu']) {
  test(`current ${entry} navigation failure is still fatal, even with a cancellation-shaped code`, async t => {
    const error = failure('DESKTOP_START_CANCELLED');
    const f = await harness(t, { load: async (index, call) => { if (index > 0 || call > 1) throw error; } });
    await f.initial();
    if (entry === 'activate') { f.get('win').destroy(); f.activate(); }
    else if (entry === 'renderer') f.get('win').webContents.emit('render-process-gone');
    else f.reload();
    await until(() => f.fatals().length === 1);
    assert.equal(f.fatals()[0].detail, error.message);
    await until(() => f.r.finished === 1);
    assert.equal(f.r.backends.length, 1);
  });
}

test('duplicate restart and activate retain one owned drain and one replacement', async t => {
  const gate = deferred();
  const f = await harness(t, { drain: i => i === 0 ? gate.promise : [], release: () => gate.resolve([]) });
  await f.initial(); const restarting = f.restart(); await until(() => f.r.drains === 1);
  await f.restart(); f.activate(); await tick();
  assert.equal(f.r.drains, 1); assert.equal(f.r.backends.length, 1); assert.equal(f.r.windows.length, 1);
  gate.resolve([]); await restarting; f.assertCurrent(1);
  assert.equal(f.r.backends.length, 2); assert.equal(f.r.windows.length, 2);
});

test('quit wins over activate and replacement during the owned restart drain', async t => {
  const gate = deferred();
  const f = await harness(t, { drain: i => i === 0 ? gate.promise : [], release: () => gate.resolve([]) });
  await f.initial(); const restarting = f.restart(); await until(() => f.r.drains === 1);
  f.app.quit(); await until(() => f.get('quitting') === true);
  f.activate(); await tick(); assert.equal(f.r.windows.length, 1);
  gate.resolve([]); await restarting; await f.get('quitCoordinator.pending');
  assert.equal(f.r.finished, 1); assert.equal(f.r.backends.length, 1); assert.equal(f.r.windows.length, 1);
  assert.equal(f.get('ready'), null); assert.equal(f.get('activeSession'), null);
  assert.equal(f.fatals().length, 0); assert.equal(f.r.settingsCloses, 1);
});

test('activate between accepted window close and quit continuation cannot replace that window', async t => {
  const f = await harness(t); await f.initial();
  f.get('win').on('closed', () => f.activate());
  f.app.quit(); await until(() => f.r.finished === 1);
  assert.equal(f.r.windows.length, 1); assert.equal(f.r.backends.length, 1);
});

for (const stage of ['drain', 'remove', 'clear', 'backend-stop', 'unconfirmed-media']) {
  test(`${stage} failure remains visible and cannot authorize a replacement window or backend`, async t => {
    const error = failure(`${stage.toUpperCase()}_FAILED`);
    const options = stage === 'backend-stop' ? { child: () => ({ exitCode: 1 }) } :
      stage === 'unconfirmed-media' ? { child: () => ({ media: true }) } : { [stage]: async () => { throw error; } };
    const f = await harness(t, options); await f.initial();
    await f.restart(); await until(() => f.fatals().length === 1);
    f.activate(); await tick();
    assert.equal(f.r.backends.length, 1); assert.equal(f.r.windows.length, 1);
    assert.equal(f.r.windows[0].destroyed, true);
    if (!['backend-stop', 'unconfirmed-media'].includes(stage)) assert.equal(f.fatals()[0].detail, error.message);
  });
}
