import { WORKSPACE_NATIVE_CHANNEL } from '../packages/contracts/src/workspace-native.ts';
import { createWorkspaceNativeHost } from '../apps/desktop/src/workspace-native-host.ts';
import { createAppLanguageHost } from '../apps/desktop/src/app-language-host.ts';
import { nativeText, setNativeLanguageReader } from '../apps/desktop/src/app-language-text.ts';
import { resolveLocale } from '../packages/i18n/src/locale.ts';
import { APP_LANGUAGE_CHANNEL } from '../packages/i18n/src/preference.ts';
import { CLIP_LUT_RECOVERY_CHANNEL } from '../packages/contracts/src/clip-lut-recovery.ts';
import { calculateWorkspaceScope } from '../packages/contracts/src/workspace-scope.ts';
import { createDesktopLutRecoveryHost } from '../apps/desktop/src/lut-recovery-host.ts';
import { WORKSPACE_TOOLS_CHANNEL } from '../packages/contracts/src/workspace-info.ts';
import { createWorkspaceToolsHost } from '../apps/desktop/src/workspace-tools-host.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { createDesktopStartup } from '../apps/desktop/src/startup.ts';
import { BackendSupervisor } from '../apps/desktop/src/supervisor.ts';
import { stopBackendForQuit } from '../apps/desktop/src/shutdown.ts';
import { createProjectWindowHost } from '../apps/desktop/src/project-window-host.ts';
import { createNativeAudioPreviewHost, createNativeAudioPreviewSigningIdentity } from '../apps/desktop/src/native-audio-preview-host.ts';
import { NATIVE_AUDIO_CHANNEL } from '../apps/desktop/src/native-audio-preview-protocol.ts';
import { consumeNativeProjectEntry } from '../apps/desktop/src/project-entry-admission.ts';
import { observeInitialProjectLoad, createProjectRendererRecovery, createProjectBackendIncident } from '../apps/desktop/src/project-window-recovery.ts';
import { MultiWindowQuitCoordinator, MultiWindowRestartCoordinator, createProjectWindowQuitRouter } from '../apps/desktop/src/project-window-quit.ts';
import { confirmOwnedWindowRestart } from '../apps/desktop/src/project-window-confirmation.ts';
import { PROJECT_WINDOW_CHANNEL } from '../apps/desktop/src/project-window-protocol.ts';
import { installNativeCloseAdmission } from '../apps/desktop/src/native-close.ts';
import { createDesktopWindowAppearance } from '../apps/desktop/src/window-appearance.ts';

const source = stripTypeScriptTypes((await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, ''), { mode: 'strip' });
const tools = { ffmpeg: '/synthetic/ffmpeg', ffprobe: '/synthetic/ffprobe', versions: { ffmpeg: 'synthetic' } };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(predicate) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('Synthetic lifecycle did not reach the expected checkpoint');
}
const failure = (code = 'SYNTHETIC_FAILURE') => Object.assign(new Error(`Synthetic ${code}`), { code });

// Run the actual whenReady chain, menu callback and lifecycle/supervisor code.
// Only OS boundaries are fake: no Electron, utility, native vault or media runs.
async function harness(t, options = {}) {
  const records = { scopes: [], validations: [], settings: [], backends: [], children: [], sessions: [], windows: [], connections: [], dialogs: [], starts: [], drains: 0, removals: 0, quits: 0, finished: 0, exits: [] };
  const expectedChannels = [APP_LANGUAGE_CHANNEL, CLIP_LUT_RECOVERY_CHANNEL, WORKSPACE_TOOLS_CHANNEL, WORKSPACE_NATIVE_CHANNEL, PROJECT_WINDOW_CHANNEL, NATIVE_AUDIO_CHANNEL];
  const lutDirectory = Object.freeze({ dev: 1, ino: 2 });
  const lutDatabase = Object.freeze({ dev: 1, ino: 3 });
  const lutStoreCalls = [];
  const unexpectedLutFileAccess = () => assert.fail('Restart fixture must not access filesystem LUT storage');
  function createLutStore({ userData, guard }) {
    assert.equal(userData, '/synthetic/userData');
    return Object.fromEntries(['read', 'reserve', 'verify', 'complete'].map(action => [action, () => {
      guard(); lutStoreCalls.push(action);
      if (action !== 'read') assert.fail('Restart cases must not mutate LUT recovery metadata');
      return null;
    }]));
  }
  let menu, initial;
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false, enableSandbox() {}, setName() {}, setAppUserModelId() {},
    getPath: () => '/synthetic', getAppPath: () => '/synthetic/app', requestSingleInstanceLock: () => true,
    whenReady: () => ({ then(callback) { return { catch(onError) { initial = Promise.resolve().then(callback).catch(onError); return initial; } }; } }),
    quit() {
      records.quits++;
      let prevented = false;
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      if (!prevented) records.finished++;
    },
    exit(code) { records.exits.push(code); }
  });
  function settings() {
    const value = { closes: 0, async close() { value.closes++; } };
    records.settings.push(value);
    return value;
  }
  function fork() {
    const index = records.children.length;
    const config = options.child?.(index) ?? {};
    const child = new EventEmitter();
    Object.assign(child, { pid: 30000 + index, messages: [], kills: 0, hardKills: 0,
      ready() { child.emit('message', { type: 'ready', url: `http://127.0.0.1:${44000 + index}`, runtime: { pid: child.pid } }); },
      postMessage(message) {
        child.messages.push(message);
        if (message.type === 'start' && config.ready !== false) queueMicrotask(() => child.ready());
        if (message.type === 'stop' && config.exit !== false) queueMicrotask(() => {
          if (config.media) child.emit('message', { type: 'media-process', event: 'started', pid: 50000 + index });
          child.emit('exit', config.exitCode ?? 0);
        });
      },
      kill() { child.kills++; return true; }
    });
    records.children.push(child);
    return child;
  }
  class Window extends EventEmitter {
    static getFocusedWindow() { return records.windows.findLast(window => !window.destroyed) ?? null; }
    constructor(config) {
      super(); this.config = config; this.destroyed = false; this.urls = [];
      let closeToken = null, closeSerial = 0;
      const windowIndex = records.windows.length;
      // This synthetic renderer speaks the real v1 protocol. The preference
      // flush and token-bound commit return booleans; inspection returns data.
      const renderer = vm.createContext({
        __mioonNativeCloseAdmission: {
          inspect: () => ({ version: 1, token: closeToken = `window-${windowIndex}-${++closeSerial}`, disposition: 'clean' }),
          commit: (token, admission) => typeof token === 'string' && token === closeToken &&
            admission?.discardDirty === false && typeof admission.allowDrainFailure === 'boolean' &&
            Number.isSafeInteger(admission.expiresAt) && admission.expiresAt > Date.now() && admission.expiresAt <= Date.now() + 1500,
          cancel: token => { if (token !== closeToken) return false; closeToken = null; return true; }
        },
        __mioonFlushWorkspacePreferences: async () => true
      });
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: 'about:blank' }, send() {},
        getURL: () => this.webContents.mainFrame.url, loadURL: url => this.loadURL(url),
        executeJavaScript: async script => vm.runInContext(script, renderer)
      });
      records.windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    setBackgroundColor(value) { this.backgroundColor = value; }
    isMinimized() { return false; }
    restore() {}
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented) this.destroy(); }
    show() {} showInactive() {} hide() {} focus() {}
    async loadURL(url) {
      this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
      this.urls.push(url); this.webContents.mainFrame = { url };
      this.webContents.emit('did-navigate', {}, url);
      await options.load?.(records.windows.indexOf(this));
    }
  }
  const context = vm.createContext({ app, createAppLanguageHost, nt: nativeText, setNativeLanguageReader: () => {}, resolveLocale, APP_LANGUAGE_CHANNEL, readAppLanguagePreference: () => null, writeAppLanguagePreference: () => {}, process: { platform: 'darwin', env: {}, on() {} }, path, randomBytes, randomUUID,
    __MIOON_DESKTOP_CHANNEL__: 'development', desktopIdentity: { identityForChannel: () => ({ channel: 'development', productName: 'Synthetic', appId: 'synthetic' }) },
    prepareDesktopStorage: () => ({ userData: '/synthetic/userData', dataDir: '/synthetic/workspace', configFile: '/synthetic/config' }),
    CLIP_LUT_RECOVERY_CHANNEL, createDesktopLutRecoveryHost, calculateWorkspaceScope,
    WORKSPACE_TOOLS_CHANNEL, createWorkspaceToolsHost, WORKSPACE_NATIVE_CHANNEL, createWorkspaceNativeHost,
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: true }),
    createDesktopWindowAppearance: configuration => createDesktopWindowAppearance({ ...configuration,
      // Keep real scope/current/abort behavior; only private IO and OS watching
      // are synthetic, with no saved appearance in this lifecycle fixture.
      storage: { ...configuration.storage, readPrivateFile: (file, options) => {
        assert.equal(file, '/synthetic/workspace/ui-preferences-v1.json');
        assert.equal(options.private, true); return null;
      } }, watchDirectory: () => Object.assign(new EventEmitter(), { close() {} }) }),
    createDesktopLutRecoveryStore: createLutStore,
    validatePrivateDirectory: root => { assert.equal(root, '/synthetic/workspace'); return lutDirectory; },
    validateManagedFile: (file, { root }) => {
      assert.equal(file, '/synthetic/workspace/workbench.sqlite'); assert.equal(root, '/synthetic/workspace'); return lutDatabase;
    },
    readPrivateFile: unexpectedLutFileAccess, removePrivateFile: unexpectedLutFileAccess, writePrivateFileAtomic: unexpectedLutFileAccess,
    ensureDataIdentity: async () => {}, readToolConfig: async () => tools,
    createDesktopStartup: () => {
      const index = records.scopes.length;
      const scope = createDesktopStartup({ terminate: async () => { records.drains++; return await options.drain?.(index) ?? []; }, wait: async () => {} });
      records.scopes.push(scope); return scope;
    },
    validateTools: (_, { signal }) => { const index = records.validations.length; records.validations.push(signal); return options.validate?.(index) ?? Promise.resolve(tools); },
    createDesktopAgentSettings: async () => { const value = settings(); return options.settings ? options.settings(records.settings.length - 1, value) : value; },
    safeStorage: {}, createDesktopImageSecretCodec: () => ({}), utilityEnvironment: () => ({}), utilityProcess: { fork },
    BackendSupervisor: class extends BackendSupervisor {
      constructor(config) {
        super({ ...config, startupTimeout: 3000, stopTimeout: 10, terminateTimeout: 10, exitTimeout: 10, forceKill: child => { child.hardKills++; } });
        records.backends.push(this);
      }
      // Diagnostics filesystem persistence is an OS boundary, not a restart
      // decision. Retain observations in memory instead of publishing sidecars.
      recordDiagnostic(event, details = {}) {
        (records.diagnosticEvents ??= []).push({ event, ...details });
        this.diagnosticsAvailable = false;
      }
    },
    BrowserWindow: Window,
    session: { fromPartition() {
      const index = records.sessions.length;
      const value = { cookies: { set: async cookie => { value.cookie = cookie; await options.cookie?.(index); } }, clears: 0,
        async clearStorageData() { value.clears++; await options.clear?.(index); },
        webRequest: { onBeforeSendHeaders(fn) { value.beforeSendHeaders = fn; } } };
      records.sessions.push(value); return value;
    } },
    sessionCookie: (url, token) => ({ url, value: token }), secureWebPreferences: value => ({ session: value }), windowChromeOptions: () => ({}),
    installSessionPolicy() {}, installWindowPolicy() {}, isAllowedNavigation: () => true,
    writeConnection: async (_, value) => { records.connections.push(value); },
    removeConnectionOnShutdown: async () => { records.removals++; await options.remove?.(records.removals); },
    createProjectWindowHost, MultiWindowQuitCoordinator,
    // Restart captures its start callback at construction time. Observe that
    // real callback's result too; do not replace its body or lifecycle policy.
    MultiWindowRestartCoordinator: class extends MultiWindowRestartCoordinator {
      constructor(config) {
        super({ ...config, start: (...args) => config.start(...args).then(
          report => { records.starts.push({ report }); return report; },
          error => { records.starts.push({ error }); throw error; }) });
      }
    },
    createProjectWindowQuitRouter, confirmOwnedWindowRestart, PROJECT_WINDOW_CHANNEL, NATIVE_AUDIO_CHANNEL,
    createNativeAudioPreviewHost, createNativeAudioPreviewSigningIdentity, consumeNativeProjectEntry,
    observeInitialProjectLoad, createProjectRendererRecovery, createProjectBackendIncident,
    ipcMain: { handle(channel, handler) {
      assert.ok(expectedChannels.includes(channel)); assert.equal(typeof handler, 'function');
      records.ipcHandlers ??= new Map(); assert.equal(records.ipcHandlers.has(channel), false); records.ipcHandlers.set(channel, handler);
      if (channel === PROJECT_WINDOW_CHANNEL) records.bridge = handler; else if (channel === NATIVE_AUDIO_CHANNEL) records.audioBridge = handler;
    } },
    installNativeCloseAdmission, stopBackendForQuit,
    Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { menu = value; } },
    dialog: { showMessageBox: async (parentOrValue, modalValue) => { const value = modalValue ?? parentOrValue; records.dialogs.push(value); return { response: 0 }; }, showMessageBoxSync: () => 0 },
    storageFailureDialog: error => ({ title: 'Storage failure', detail: error.message }),
    observeStart: result => records.starts.push(result)
  });
  // Observe return values without replacing the production start body or callers.
  vm.runInContext(source + `\nconst observedStart = start;
    start = (...args) => observedStart(...args).then(
      report => { observeStart({ report }); return report; },
      error => { observeStart({ error }); throw error; });`, context, { filename: 'actual-desktop-main.mjs' });
  assert.deepEqual([...records.ipcHandlers.keys()].sort(), [...expectedChannels].sort());
  t.after(() => {
    vm.runInContext('windowContext?.appearance?.dispose(); quitting = true', context);
    for (const child of records.children) child.emit('exit', 0);
    for (const win of records.windows) win.destroy();
    assert.deepEqual(lutStoreCalls, [], 'Restart lifecycle must not read or mutate LUT recovery metadata');
  });
  await until(() => menu);
  return { records, app, initial: () => initial,
    get: expression => vm.runInContext(expression, context),
    restart: () => menu.find(item => item.label === '应用').submenu.find(item => item.label === '重启本地服务').click(),
    fatals: () => records.dialogs.filter(item => item.title === '无法启动 Mioon'),
    async success(index = records.backends.length - 1) {
      await until(() => records.windows.some(win => !win.destroyed && win.urls.length));
      const backend = records.backends[index], connection = records.connections.at(-1), win = records.windows.at(-1);
      assert.equal(connection.pid, backend.child.pid);
      assert.equal(connection.url, backend.origin);
      assert.equal(win.urls.at(-1), `${backend.origin}/`);
      assert.equal(win.config.webPreferences.session, records.sessions.at(-1));
      assert.equal(records.sessions.at(-1).cookie.value, connection.token);
      assert.equal(records.scopes.at(-1).signal.aborted, false);
      assert.equal(records.quits, 0);
      assert.equal(records.dialogs.some(item => item.title === '无法启动 Mioon'), false);
    }
  };
}

for (const timing of ['pending', 'successful']) for (const outcome of ['resolve', 'cancel', 'reject']) {
  test(`old validation ${outcome} after replacement is ${timing} cannot quit it`, { timeout: 5000 }, async t => {
    const old = deferred(), replacement = deferred();
    const runtime = await harness(t, { validate: index => index === 0 ? old.promise : replacement.promise });
    const r = runtime.records;
    await until(() => r.validations.length === 1);
    const restarting = runtime.restart();
    await until(() => r.validations.length === 2);
    if (timing === 'successful') { replacement.resolve(tools); await restarting; await runtime.success(); }
    if (outcome === 'resolve') old.resolve(tools);
    else old.reject(failure(outcome === 'cancel' ? 'MEDIA_CANCELLED' : 'LATE_VALIDATION_FAILURE'));
    await runtime.initial();
    assert.equal(runtime.fatals().length, 0);
    assert.equal(r.validations[0].aborted, true);
    assert.equal(r.validations[1].aborted, false);
    if (timing === 'pending') { replacement.resolve(tools); await restarting; }
    await runtime.success();
    assert.equal(r.backends.length, 1);
  });
}

test('replacement itself failing remains fatal even when both starts reject the same Error', async t => {
  const old = deferred(), replacement = deferred(), shared = failure('SHARED_SETTINGS_FAILURE');
  const runtime = await harness(t, { settings: index => index === 0 ? old.promise : replacement.promise });
  await until(() => runtime.records.settings.length === 1);
  const restarting = runtime.restart();
  await until(() => runtime.records.settings.length === 2);
  old.reject(shared); await runtime.initial();
  assert.equal(runtime.fatals().length, 0);
  replacement.reject(shared); await restarting;
  assert.equal(runtime.fatals().length, 1);
  assert.equal(runtime.fatals()[0].detail, nativeText('native.originalDiagnostic', { detail: shared.message }));
  await until(() => runtime.records.finished === 1);
});

for (const code of ['DESKTOP_START_CANCELLED', 'BACKEND_START_CANCELLED', 'MEDIA_CANCELLED', 'CURRENT_FAILURE']) {
  test(`current uncancelled start error ${code} is still fatal`, async t => {
    const error = failure(code);
    const runtime = await harness(t, { settings: async () => { throw error; } });
    await runtime.initial();
    assert.equal(runtime.fatals().length, 1);
    assert.equal(runtime.fatals()[0].detail, nativeText('native.originalDiagnostic', { detail: error.message }));
  });
}

test('late settings acquisition closes the old instance once and preserves replacement settings', async t => {
  const old = deferred();
  const runtime = await harness(t, { settings: (index, value) => index === 0 ? old.promise : value });
  const r = runtime.records;
  await until(() => r.settings.length === 1);
  await runtime.restart(); await runtime.success();
  old.resolve(r.settings[0]); await runtime.initial();
  assert.equal(r.settings[0].closes, 1);
  assert.equal(r.settings[1].closes, 0);
  assert.equal(runtime.get('agentSettings'), r.settings[1]);
  assert.equal(r.backends[0].agentSettings, r.settings[1]);
  await runtime.success();
});

for (const action of ['restart', 'quit']) for (const code of ['SETTINGS_CLOSE_FAILED', 'DESKTOP_START_CANCELLED']) {
  test(`late settings close failure ${code} remains visible after ${action}`, async t => {
    const old = deferred(), error = failure(code);
    const runtime = await harness(t, { settings: (index, value) => index === 0 ? old.promise : value });
    await until(() => runtime.records.settings.length === 1);
    if (action === 'restart') { await runtime.restart(); await runtime.success(); }
    else { runtime.app.quit(); await until(() => runtime.records.finished === 1); }
    old.resolve({ async close() { throw error; } }); await runtime.initial();
    assert.equal(runtime.fatals().length, 1);
    assert.equal(runtime.fatals()[0].detail, nativeText('native.originalDiagnostic', { detail: error.message }));
  });
}

test('restart waits for the owned child exit even though old backend.start already rejected', async t => {
  const runtime = await harness(t, { child: index => index === 0 ? { ready: false, exit: false } : {} });
  const r = runtime.records;
  await until(() => r.children.length === 1);
  const restarting = runtime.restart();
  await until(() => r.children[0].messages.some(item => item.type === 'stop'));
  await runtime.initial();
  assert.equal(runtime.fatals().length, 0);
  assert.equal(r.backends.length, 1);
  assert.equal(r.backends[0].child, r.children[0]);
  r.children[0].ready(); // A cancelled original start must not publish this ready.
  assert.equal(r.sessions.length, 0);
  r.children[0].emit('exit', 0);
  await restarting; await runtime.success(1);
  assert.equal(r.backends.length, 2);
  assert.equal(r.windows.length, 1);
});

for (const stage of ['cookie', 'load']) {
  test(`old ${stage} completion after replacement success cannot publish or fail another start`, async t => {
    const old = deferred();
    const runtime = await harness(t, { [stage]: index => index === 0 ? old.promise : undefined });
    const r = runtime.records;
    await until(() => stage === 'cookie' ? r.sessions.length === 1 : r.windows.length === 1);
    await runtime.restart(); await runtime.success(1);
    const count = r.connections.length;
    old.resolve(); await runtime.initial();
    await runtime.success(1);
    assert.equal(r.connections.length, count);
    assert.equal(r.sessions[0].clears, 1);
    assert.equal(runtime.get('ready.url'), r.backends[1].origin);
    assert.equal(r.starts.filter(result => result.report).length, 1);
    assert.equal(r.starts.at(-1).error?.code, 'DESKTOP_START_CANCELLED');
  });
}

test('duplicate restart shares the drain and creates only one replacement', async t => {
  const old = deferred(), drain = deferred();
  const runtime = await harness(t, { validate: index => index === 0 ? old.promise : tools, drain: () => drain.promise });
  const r = runtime.records;
  await until(() => r.validations.length === 1);
  const first = runtime.restart();
  await until(() => r.drains === 1);
  await runtime.restart();
  old.resolve(tools); await runtime.initial();
  assert.equal(r.quits, 0); assert.equal(r.validations.length, 1);
  drain.resolve([]); await first; await runtime.success();
  assert.equal(r.drains, 1); assert.equal(r.removals, 1); assert.equal(r.backends.length, 1);
});

test('quit during restart drain shares quit work and prevents replacement startup', async t => {
  const old = deferred(), drain = deferred();
  const runtime = await harness(t, { validate: () => old.promise, drain: () => drain.promise });
  const r = runtime.records;
  await until(() => r.validations.length === 1);
  const restarting = runtime.restart();
  await until(() => r.drains === 1);
  runtime.app.quit(); const pending = runtime.get('quitRouter.pending');
  runtime.app.quit(); assert.equal(runtime.get('quitRouter.pending'), pending);
  assert.equal(runtime.get('quitRouter.isPending'), true);
  old.reject(failure('LATE_VALIDATION_FAILURE')); await runtime.initial();
  drain.resolve([]); await restarting; await pending;
  assert.equal(r.drains, 1); assert.equal(r.finished, 1);
  assert.equal(runtime.fatals().length, 0);
  assert.equal(r.scopes.length, 1); assert.equal(r.backends.length, 0);
  assert.equal(r.connections.length, 0); assert.equal(r.windows.length, 0);
});

for (const mode of ['unconfirmed', 'media', 'failed']) {
  test(`backend stop ${mode} remains a replacement barrier with cancelled old start`, async t => {
    const runtime = await harness(t, { child: () => ({ ready: false, ...(mode === 'unconfirmed' ? { exit: false } : mode === 'media' ? { media: true } : { exitCode: 1 }) }) });
    const r = runtime.records;
    await until(() => r.children.length === 1);
    await runtime.restart(); await runtime.initial();
    assert.equal(r.backends.length, 1);
    assert.equal(runtime.fatals().length, 1);
    assert.equal(r.windows.length, 0); assert.equal(r.connections.length, 0);
    if (mode === 'unconfirmed') {
      assert.equal(r.backends[0].child, r.children[0]);
      assert.equal(r.children[0].messages.filter(item => item.type === 'stop').length, 1);
      assert.equal(r.children[0].kills, 1); assert.equal(r.children[0].hardKills, 1);
      assert.equal(r.finished, 0);
      r.children[0].emit('exit', 0);
      await until(() => r.finished === 1);
    } else if (mode === 'media') {
      await until(() => r.exits.length === 1);
      assert.equal(r.backends[0].hasUnconfirmedMedia, true);
      assert.equal(r.finished, 0);
    }
  });
}

for (const stage of ['drain', 'remove', 'clear']) {
  test(`${stage} failure is not hidden by old startup cancellation`, async t => {
    const old = deferred(), error = failure(`${stage.toUpperCase()}_FAILED`);
    const options = stage === 'clear'
      ? { cookie: () => old.promise, clear: async () => { throw error; } }
      : { validate: () => old.promise, [stage]: async () => { throw error; } };
    const runtime = await harness(t, options);
    const r = runtime.records;
    await until(() => stage === 'clear' ? r.sessions.length === 1 : r.validations.length === 1);
    await runtime.restart(); old.resolve(tools); await runtime.initial();
    assert.equal(runtime.fatals().length, 1);
    assert.equal(runtime.fatals()[0].detail, nativeText('native.originalDiagnostic', { detail: error.message }));
    assert.equal(r.scopes.length, 1);
    assert.equal(r.windows.length, 0); assert.equal(r.connections.length, 0);
  });
}
