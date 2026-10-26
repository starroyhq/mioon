import type {DesktopHarnessOptions, DesktopHarnessRecords, DesktopHarnessWindow, DesktopHarnessWindowConfig, DesktopHarnessApp, DesktopHarnessMenu, DesktopHarnessChild, DesktopHarnessBackend, DesktopHarnessSession, DesktopHarnessDialog, DesktopHarnessConnection} from './helpers/strict-desktop-harness-types.ts';
import { WORKSPACE_NATIVE_CHANNEL } from '../packages/contracts/src/workspace-native.ts';
import { createWorkspaceNativeHost } from '../apps/desktop/src/workspace-native-host.ts';
import { createProjectFileOpener, uploadProjectFile, projectFileArguments } from '../apps/desktop/src/project-file-open.ts';
import { createAppLanguageHost } from '../apps/desktop/src/app-language-host.ts';
import { nativeText, setNativeLanguageReader } from '../apps/desktop/src/app-language-text.ts';
import { resolveLocale } from '../packages/i18n/src/locale.ts';
import { APP_LANGUAGE_CHANNEL } from '../packages/i18n/src/preference.ts';
import { WORKSPACE_TOOLS_CHANNEL } from '../packages/contracts/src/workspace-info.ts';
import { createWorkspaceToolsHost } from '../apps/desktop/src/workspace-tools-host.ts';
import { CLIP_LUT_RECOVERY_CHANNEL } from '../packages/contracts/src/clip-lut-recovery.ts';
import { calculateWorkspaceScope } from '../packages/contracts/src/workspace-scope.ts';
import { createDesktopLutRecoveryHost } from '../apps/desktop/src/lut-recovery-host.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { createDesktopStartup } from '../apps/desktop/src/startup.ts';
import { BackendSupervisor, type BackendSupervisorOptions } from '../apps/desktop/src/supervisor.ts';
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
import * as security from '../apps/desktop/src/security.ts';
import { windowChromeOptions, MAC_TRAFFIC_LIGHT_POSITION } from '../apps/desktop/src/window-chrome.ts';
import { settingsWindowOptions } from '../apps/desktop/src/settings-window.ts';
import { createDesktopWindowAppearance } from '../apps/desktop/src/window-appearance.ts';

const source = stripTypeScriptTypes((await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, ''), { mode: 'strip' });
const tools = { ffmpeg: '/synthetic/ffmpeg', ffprobe: '/synthetic/ffprobe', versions: { ffmpeg: 'synthetic' } };
type Gate = Omit<PromiseWithResolvers<unknown>, 'resolve'> & {resolve(value?: unknown): void};
const deferred = () => Promise.withResolvers() as Gate;
const tick = () => new Promise(resolve => setImmediate(resolve));
const failure = (code: string) => Object.assign(new Error(`Synthetic ${code}`), { code });
async function until(predicate: () => unknown) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await tick(); }
  assert.fail('Synthetic window lifecycle did not reach the expected checkpoint');
}

// The real main, supervisor, security and lifecycle functions run in this VM.
// Only OS boundaries are fake. No Electron, native vault, utility or media runs.
// Deferred gates expose causality; they do not claim native event timing.
async function harness(t: test.TestContext, options: DesktopHarnessOptions<DesktopHarnessWindow> = {}) {
  const r: Omit<DesktopHarnessRecords<Window, string>, 'settings' | 'starts'> = { scopes: [], validations: [], backends: [], children: [], sessions: [], windows: [],
    connections: [], connectionWrites: [], dialogs: [], dialogParents: [], syncDialogs: [], nativeChecks: [], drains: 0, removals: 0,
    quits: 0, finished: 0, exits: [], settingsCloses: 0, lutStoreCalls: [] };
  // LUT metadata stays in memory; this lifecycle fixture never admits writes.
  const lutDirectory = Object.freeze({ dev: 1, ino: 2 });
  const lutDatabase = Object.freeze({ dev: 1, ino: 3 });
  const unexpectedLutFileAccess = () => assert.fail('LUT fixture must not access filesystem storage');
  function createLutStore({ userData, guard }: {userData: string; guard(): void}) {
    assert.equal(userData, '/synthetic/userData');
    return Object.fromEntries(['read', 'reserve', 'verify', 'complete'].map(action => [action, () => {
      guard(); r.lutStoreCalls.push(action);
      if (action !== 'read') assert.fail('Ownership cases must not mutate LUT recovery metadata');
      return null;
    }]));
  }
  let menu: DesktopHarnessMenu[], initial: Promise<void>;
  const app = new EventEmitter() as DesktopHarnessApp;
  Object.assign(app, {
    isPackaged: false, enableSandbox() {}, setName() {}, setAppUserModelId() {},
    getPath: () => '/synthetic', getAppPath: () => '/synthetic/app', requestSingleInstanceLock: () => true,
    whenReady: () => ({ then(callback?: ((value: void) => void|PromiseLike<void>)|null|undefined) { return { catch(onError: (reason: unknown) => void | PromiseLike<void>) {
      initial = Promise.resolve().then(callback).catch(onError); return initial;
    } }; } }),
    quit() {
      r.quits++; let prevented = false;
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      if (!prevented) r.finished++;
    },
    exit(code: number) { r.exits.push(code); }
  });
  function fork() {
    const index = r.children.length, config = options.child?.(index) ?? {};
    const child: DesktopHarnessChild<string> = Object.assign(new EventEmitter(), {
      pid: 31000 + index, messages: [], kills: 0, hardKills: 0,
      ready() { child.emit('message', { type: 'ready', url: `http://127.0.0.1:${45000 + index}`, runtime: { pid: child.pid } }); },
      postMessage(message: { type: string; }) {
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
  interface Window extends DesktopHarnessWindow {closedDelivered: boolean; shows: number; focuses: number; flushes: number; index: number; disposition: string; entryTickets: Map<string, string>; popupPolicy(): {action: string};}
  class Window extends EventEmitter {
    static getFocusedWindow() { return options.focusedWindow ? options.focusedWindow(r.windows) : r.windows.findLast(window => !window.destroyed) ?? null; }
    constructor(config: DesktopHarnessWindowConfig) {
      super(); this.config = config; this.destroyed = false; this.closedDelivered = false;
      this.urls = []; this.shows = 0; this.focuses = 0; this.flushes = 0;
      this.index = r.windows.length;
      this.disposition = options.disposition?.(this.index) ?? 'clean';
      let closeToken: string|null = null, closeSerial = 0, capturedDisposition: string|null = null;
      // Run the actual native admission scripts against a clean renderer v1
      // surface. Only the legacy preference flush counts as a flush or waits on
      // the original fixture gate; inspecting and committing are separate calls.
      this.entryTickets = new Map<string, string>();
      const renderer = vm.createContext({
        __mioonProjectEntryAdmission: { consume: (entryToken: string, projectId: string) => {
          const accepted = this.entryTickets.get(entryToken) === projectId; if (accepted) this.entryTickets.delete(entryToken);
          return { version: 1, entryToken, projectId, accepted };
        } },
        __mioonNativeCloseAdmission: {
          inspect: () => {
            r.nativeChecks.push(this);
            return { version: 1, token: closeToken = `window-${this.index}-${++closeSerial}`, disposition: capturedDisposition = this.disposition };
          },
          commit: (token: string|null, admission: { discardDirty: boolean; allowUnknown: boolean; allowDrainFailure: boolean; expiresAt: number; }) => typeof token === 'string' && token === closeToken &&
            capturedDisposition === this.disposition && admission?.discardDirty === ['dirty', 'unknown-dirty'].includes(capturedDisposition) &&
            (!['unknown', 'unknown-dirty'].includes(capturedDisposition) || admission.allowUnknown === true && admission.allowDrainFailure === false) &&
            typeof admission.allowDrainFailure === 'boolean' &&
            Number.isSafeInteger(admission.expiresAt) && admission.expiresAt > Date.now() && admission.expiresAt <= Date.now() + 1500,
          cancel: (token: string|null) => { if (token !== closeToken) return false; closeToken = null; return true; }
        },
        __mioonFlushWorkspacePreferences: async () => { this.flushes++; return await options.flush?.(this.index) ?? true; }
      });
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: 'about:blank' },
        getURL: () => this.webContents.mainFrame.url,
        send() {},
        loadURL: (url: string) => this.loadURL(url),
        executeJavaScript: async (script: string) => vm.runInContext(script, renderer),
        setWindowOpenHandler: (fn: Window['popupPolicy']) => { this.popupPolicy = fn; }
      });
      r.windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    getContentBounds() { return {x: 80, y: 60, width: Number(this.config.width), height: Number(this.config.height)}; }
    setBackgroundColor(value: string) { this.backgroundColor = value; }
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
    showInactive() { this.shows++; }
    hide() {}
    focus() { this.focuses++; }
    async loadURL(url: string) {
      this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
      this.urls.push(url);
      this.webContents.mainFrame = { url };
      this.webContents.emit('did-navigate', {}, url);
      await options.load?.(this.index, this.urls.length, url);
    }
  }
  const context = vm.createContext({ app, createAppLanguageHost, nt: nativeText, setNativeLanguageReader: () => {}, resolveLocale, APP_LANGUAGE_CHANNEL, readAppLanguagePreference: () => null, writeAppLanguagePreference: () => {}, process: { platform: 'darwin', env: {}, on() {} }, path, randomBytes, randomUUID,
    __MIOON_DESKTOP_CHANNEL__: 'development', desktopIdentity: { identityForChannel: () => ({ channel: 'development', productName: 'Synthetic', appId: 'synthetic' }) },
    prepareDesktopStorage: () => ({ userData: '/synthetic/userData', dataDir: '/synthetic/workspace', configFile: '/synthetic/config' }),
    CLIP_LUT_RECOVERY_CHANNEL, createDesktopLutRecoveryHost, calculateWorkspaceScope,
    WORKSPACE_TOOLS_CHANNEL, createWorkspaceToolsHost, WORKSPACE_NATIVE_CHANNEL, createWorkspaceNativeHost, createProjectFileOpener, uploadProjectFile, projectFileArguments,
    nativeTheme: Object.assign(new EventEmitter(), {shouldUseDarkColors:true}),
    createDesktopWindowAppearance: (options: Parameters<typeof createDesktopWindowAppearance>[0]) => createDesktopWindowAppearance({...options,
      // This lifecycle fixture has no persistent appearance sidecar. Keep the
      // real scope/current/abort controller while excluding OS filesystem IO.
      storage:{...options.storage,readPrivateFile:(file,configuration)=>{
        assert.equal(file,'/synthetic/workspace/ui-preferences-v1.json');
        assert.equal(configuration.private,true);return null;
      }},watchDirectory:()=>Object.assign(new EventEmitter(),{close(){}})}),
    createDesktopLutRecoveryStore: createLutStore,
    validatePrivateDirectory: (root: unknown) => { assert.equal(root, '/synthetic/workspace'); return lutDirectory; },
    validateManagedFile: (file: string, { root }: {root: string}) => {
      assert.equal(file, '/synthetic/workspace/workbench.sqlite'); assert.equal(root, '/synthetic/workspace'); return lutDatabase;
    },
    readPrivateFile: unexpectedLutFileAccess, removePrivateFile: unexpectedLutFileAccess, writePrivateFileAtomic: unexpectedLutFileAccess,
    ensureDataIdentity: async () => {}, readToolConfig: async () => tools,
    createDesktopStartup: () => {
      const index = r.scopes.length;
      const scope = createDesktopStartup({ terminate: async () => { r.drains++; return await options.drain?.(index) ?? []; }, wait: async () => {} } as unknown as Parameters<typeof createDesktopStartup>[0]);
      r.scopes.push(scope); return scope;
    },
    validateTools: (_: unknown, { signal }: {signal: AbortSignal}) => { const index = r.validations.length; r.validations.push(signal); return options.validate?.(index) ?? tools; },
    createDesktopAgentSettings: async () => ({ async close() { r.settingsCloses++; } }),
    safeStorage: {}, createDesktopImageSecretCodec: () => ({}), createDesktopVideoSecretCodec: () => ({}), utilityEnvironment: () => ({}), utilityProcess: { fork },
    BackendSupervisor: class extends BackendSupervisor {
      constructor(config: BackendSupervisorOptions) {
        super({ ...config, startupTimeout: 5000, stopTimeout: 5000, terminateTimeout: 100, exitTimeout: 100,
          forceKill: child => { (child as unknown as DesktopHarnessChild).hardKills++; } });
        r.backends.push(this as unknown as DesktopHarnessBackend<string>);
      }
      // Persistence is an OS boundary, not part of the ownership scenarios.
      // Keep diagnostic observations in memory and never publish sidecars.
      recordDiagnostic(event: string, details = {}) {
        (r.diagnosticEvents ??= []).push({ event, ...details });
        this.diagnosticsAvailable = false;
      }
    },
    BrowserWindow: Window, windowChromeOptions: () => windowChromeOptions('darwin'), settingsWindowOptions,
    session: { fromPartition() {
      const index = r.sessions.length;
      const value: DesktopHarnessSession = Object.assign(new EventEmitter(), {
        clears: 0, clearFinished: false, cookieStarted: false, cookieReady: false,
        async clearStorageData() { value.clears++; await options.clear?.(index); value.clearFinished = true; },
        cookies: { async set(cookie: DesktopHarnessSession['cookie']) { value.cookieStarted = true; await options.cookie?.(index); value.cookie = cookie; value.cookieReady = true; } },
        setPermissionRequestHandler(fn: DesktopHarnessSession['permissionRequest']) { value.permissionRequest = fn; },
        setPermissionCheckHandler(fn: DesktopHarnessSession['permissionCheck']) { value.permissionCheck = fn; },
        setDevicePermissionHandler(fn: DesktopHarnessSession['devicePermission']) { value.devicePermission = fn; },
        setDisplayMediaRequestHandler(fn: DesktopHarnessSession['displayPermission']) { value.displayPermission = fn; },
        webRequest: { onBeforeRequest(fn: DesktopHarnessSession['beforeRequest']) { value.beforeRequest = fn; }, onBeforeSendHeaders(fn: DesktopHarnessSession['beforeSendHeaders']) { value.beforeSendHeaders = fn; } }
      } as unknown as DesktopHarnessSession);
      r.sessions.push(value); return value;
    } },
    ...security, createProjectWindowHost, MultiWindowQuitCoordinator, MultiWindowRestartCoordinator,
    createProjectWindowQuitRouter, confirmOwnedWindowRestart, PROJECT_WINDOW_CHANNEL, NATIVE_AUDIO_CHANNEL,
    createNativeAudioPreviewHost, createNativeAudioPreviewSigningIdentity, consumeNativeProjectEntry,
    observeInitialProjectLoad, createProjectRendererRecovery, createProjectBackendIncident,
    ipcMain: { handle(channel: string, handler: (...values: unknown[]) => unknown) {
      assert.ok([APP_LANGUAGE_CHANNEL, PROJECT_WINDOW_CHANNEL, NATIVE_AUDIO_CHANNEL, CLIP_LUT_RECOVERY_CHANNEL, WORKSPACE_TOOLS_CHANNEL, WORKSPACE_NATIVE_CHANNEL].includes(channel)); assert.equal(typeof handler, 'function');
      r.ipcHandlers ??= new Map(); assert.equal(r.ipcHandlers.has(channel), false); r.ipcHandlers.set(channel, handler);
      if (channel === PROJECT_WINDOW_CHANNEL) r.bridge = handler; else if (channel === NATIVE_AUDIO_CHANNEL) r.audioBridge = handler;
    } },
    installNativeCloseAdmission, stopBackendForQuit,
    writeConnection: async (_: unknown, value: DesktopHarnessConnection) => {
      const index = r.connectionWrites.length;
      r.connectionWrites.push(value); await options.connection?.(index); r.connections.push(value);
    },
    removeConnectionOnShutdown: async () => { r.removals++; await options.remove?.(r.removals); },
    Menu: { buildFromTemplate: (value: DesktopHarnessMenu[]) => value, setApplicationMenu: (value: DesktopHarnessMenu[]) => { menu = value; } },
    dialog: {
      showMessageBox: async (parentOrValue: Window | DesktopHarnessDialog, modalValue?: DesktopHarnessDialog) => {
        const value = (modalValue ?? parentOrValue) as DesktopHarnessDialog, parent = modalValue ? parentOrValue as Window : null;
        r.dialogs.push(value); r.dialogParents.push(parent); return await options.dialog?.(value, parent) ?? { response: 0 };
      },
      showMessageBoxSync: (window: Window, value: DesktopHarnessDialog) => { r.syncDialogs.push({ window, value }); return options.syncDialog?.(window, value) ?? 0; }
    },
    storageFailureDialog: (error: Error) => ({ title: 'Storage failure', detail: error.message })
  });
  vm.runInContext(source, context, { filename: 'actual-desktop-main.ts' });
  assert.deepEqual([...r.ipcHandlers!.keys()].sort(),
    [APP_LANGUAGE_CHANNEL, CLIP_LUT_RECOVERY_CHANNEL, NATIVE_AUDIO_CHANNEL, PROJECT_WINDOW_CHANNEL, WORKSPACE_TOOLS_CHANNEL, WORKSPACE_NATIVE_CHANNEL].sort());
  const get = (text: string) => vm.runInContext(text, context);
  t.after(async () => {
    get('quitting = true'); options.release?.();
    for (const child of r.children) child.emit('exit', 0);
    for (const window of r.windows) { window.destroy(); window.deliverClosed(); }
    await tick();
    assert.deepEqual((r.lutStoreCalls as unknown), [], 'Window lifecycle must not read or mutate LUT recovery metadata');
  });
  await until(() => menu);
  return {
    r, app, get, initial: () => initial,
    restart: () => menu.find((item: { label: string; }) => item.label === '应用')!.submenu.find((item: { label: string; }) => item.label === '重启本地服务')!.click(),
    reload: () => menu.find((item: { label: string; }) => item.label === '应用')!.submenu.find((item: { label: string; }) => item.label === '重新载入界面')!.click(),
    activate: () => app.emit('activate'),
    fatals: () => r.dialogs.filter(item => item.title === '无法启动 Mioon'),
    rendererDialogs: () => r.dialogs.filter(item => item.title === '界面需要重新载入'),
    assertCurrent(index: number|undefined = r.backends.length - 1) {
      const live = r.windows.filter(window => !window.destroyed);
      assert.equal(live.length, 1);
      const window = live[0], backend = r.backends[index], session = r.sessions.at(-1), connection = r.connections.at(-1);
      assert.equal(get('win'), window);
      assert.equal(get('ready.url'), backend.origin);
      assert.equal(get('activeSession'), session);
      assert.equal(window.urls.at(-1), `${backend.origin}/`);
      assert.equal(window.config.webPreferences.session, session);
      assert.equal((session)!.cookieReady, true);
      assert.equal((connection)!.url, backend.origin);
      assert.equal((connection)!.pid, backend.child!.pid);
      assert.equal((session)!.cookie.value, (connection)!.token);
      assert.equal(r.quits, 0);
      assert.equal(r.dialogs.some(item => item.title === '无法启动 Mioon'), false);
    },
    assertPolicies() {
      for (const session of r.sessions) {
        let decision: {cancel: boolean} | undefined;
        session.beforeRequest({ url: 'https://untrusted.invalid/', resourceType: 'xhr' }, value => { decision = value; });
        assert.equal((decision)!.cancel, true); assert.equal(session.permissionCheck(), false);
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
    const options: DesktopHarnessOptions<DesktopHarnessWindow> = { release: () => gate.resolve(stage === 'new-validation' ? tools : undefined) };
    // drain/remove/connection deliberately add synthetic pauses; backend exit,
    // session clear, cookie installation and navigation have real async APIs.
    if (stage === 'drain') options.drain = (i: number) => i === 0 ? gate.promise : [];
    if (stage === 'backend-stop') options.child = (i: number) => i === 0 ? { exit: false } : {};
    if (stage === 'remove') options.remove = (n: number) => n === 1 ? gate.promise : undefined;
    if (stage === 'clear') options.clear = (i: number) => i === 0 ? gate.promise : undefined;
    if (stage === 'new-validation') options.validate = (i: number) => i === 1 ? gate.promise : tools;
    if (stage === 'new-backend') options.child = (i: number) => i === 1 ? { ready: false } : {};
    if (stage === 'new-cookie') options.cookie = (i: number) => i === 1 ? gate.promise : undefined;
    if (stage === 'new-connection') options.connection = (i: number) => i === 1 ? gate.promise : undefined;
    if (stage === 'new-load') options.load = (i: number) => i === 1 ? gate.promise : undefined;
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
    assert.equal(f.r.children[0].messages.filter((type: string) => type === 'stop').length, 1);
    assert.equal(f.r.children[0].kills, 0); assert.equal(f.r.children[0].hardKills, 0);
    const current = f.get('win');
    current.emit('ready-to-show'); assert.equal(current.shows >= 1, true);
    f.activate(); await tick(); assert.equal(f.r.windows.length, 2);
  });
}

// These gates hold the real main.start() after the supervisor handshake, before
// publishing its window context. A dead startup has one fatal outcome, never an
// early recovery dialog whose reply loses ownership when that context appears.
for (const stage of ['cookie', 'connection']) {
  test(`unexpected backend exit during initial ${stage} preparation fails before publishing a window context`, async t => {
    const preparation = deferred(), prematureRecovery = deferred();
    const f = await harness(t, { [stage]: () => preparation.promise,
      dialog: (value: { title: string; }) => value.title === '本地服务已停止' ? prematureRecovery.promise : { response: 0 },
      release: () => { preparation.resolve(); prematureRecovery.resolve({ response: 1 }); } });
    await until(() => stage === 'cookie' ? f.r.sessions[0]?.cookieStarted : f.r.connectionWrites.length === 1);
    f.r.children[0].emit('exit', 1);
    assert.equal(f.r.dialogs.filter(value => value.title === '本地服务已停止').length, 0,
      'A pre-publication failure must not spend the live-context recovery prompt');
    assert.equal(f.get('windowContext'), undefined);
    preparation.resolve(); await f.initial(); await until(() => f.r.finished === 1);
    assert.equal(f.fatals().length, 1);
    assert.equal(f.fatals()[0].detail, nativeText('native.originalDiagnostic', { detail: '本地服务在窗口准备完成前已停止' }));
    assert.equal(f.r.windows.length, 0);
    assert.equal(f.r.backends.length, 1, 'No replacement can be started by an ownerless recovery reply');
    assert.equal(f.get('windowContext'), null);
    assert.equal(f.r.connections.length, stage === 'cookie' ? 0 : 1);
    assert.equal(f.r.sessions[0].clearFinished, true);
  });
}

test('unexpected backend exit before the handshake continuation fails before preparing a session', async t => {
  const f = await harness(t, { child: () => ({ ready: false }) });
  await until(() => f.r.children.length === 1);
  f.r.children[0].ready();
  f.r.children[0].emit('exit', 1);
  await f.initial();
  assert.equal(f.fatals().length, 1);
  await until(() => f.r.finished === 1);
  assert.equal(f.fatals()[0].detail, nativeText('native.originalDiagnostic', { detail: '本地服务在窗口准备完成前已停止' }));
  assert.equal(f.r.dialogs.filter(value => value.title === '本地服务已停止').length, 0);
  assert.equal(f.r.sessions.length, 0); assert.equal(f.r.connections.length, 0); assert.equal(f.r.windows.length, 0);
  assert.equal(f.r.backends.length, 1);
});

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
  const f = await harness(t, { holdClosed: (i: number) => i === 0 }); await f.initial();
  const old = f.get('win'), restarting = f.restart();
  await until(() => old.destroyed);
  assert.equal(old.closedDelivered, false);
  assert.equal(f.r.windows.length, 1, 'restart cannot replace before the actual closed event');
  assert.equal(f.get('restartCoordinator.state'), 'requesting');
  old.emit('ready-to-show'); old.deliverClosed();
  await restarting;
  const replacement = f.get('win');
  assert.notEqual(old, replacement); assert.equal(old.destroyed, true); assert.equal(old.closedDelivered, true);
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
    clear: (i: number) => i === 0 ? gate.promise : undefined,
    load: async (i: number) => { if (i > 0 && clearing) { oldNavigationAttempts++; throw failure('OLD_ORIGIN_LOAD_FAILED'); } },
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
    const f = await harness(t, { load: (i: number) => i === 1 ? gate.promise : undefined, release: () => gate.resolve() });
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
      dialog: (value: { title: string; }) => value.title === '界面需要重新载入' ? gate.promise : { response: 0 },
      release: () => gate.resolve({ response: 0 })
    });
    await f.initial(); f.get('win').webContents.emit('unresponsive');
    await until(() => f.rendererDialogs().length === 1);
    await f.restart(); const replacement = f.get('win');
    if (response === 'reject') gate.reject(failure('OLD_RENDERER_DIALOG_FAILED')); else gate.resolve({ response });
    await tick(); await tick();
    assert.equal(replacement.urls.length, 1); f.assertCurrent(1); assert.equal(f.r.backends.length, 2);
  });
}

for (const oldResponse of [0, 1, 'reject']) {
  test(`pending old renderer dialog ${oldResponse} cannot block or release replacement dialog ownership`, async t => {
    const oldGate = deferred(), currentGate = deferred(), freshGate = deferred(); let rendererDialogs = 0;
    const f = await harness(t, {
      dialog: (value: { title: string; }) => {
        if (value.title !== '界面需要重新载入') return { response: 0 };
        const gate = [oldGate, currentGate, freshGate][rendererDialogs++];
        assert.ok(gate, 'Duplicate renderer incidents must not create another prompt');
        return gate.promise;
      },
      release: () => { oldGate.resolve({ response: 0 }); currentGate.resolve({ response: 0 }); freshGate.resolve({ response: 0 }); }
    });
    await f.initial(); const oldWindow = f.get('win');
    oldWindow.webContents.emit('unresponsive'); oldWindow.webContents.emit('render-process-gone');
    await until(() => f.rendererDialogs().length === 1);
    const oldOwner = f.rendererDialogs().at(-1);
    assert.equal(f.r.dialogParents[f.r.dialogs.indexOf(oldOwner!)], oldWindow);
    await f.restart(); const replacement = f.get('win');
    replacement.webContents.emit('unresponsive'); replacement.webContents.emit('render-process-gone');
    await until(() => f.rendererDialogs().length === 2);
    const currentOwner = f.rendererDialogs().at(-1);
    assert.notEqual(currentOwner, oldOwner); assert.equal(f.r.dialogParents[f.r.dialogs.indexOf(currentOwner!)], replacement);
    if (oldResponse === 'reject') oldGate.reject(failure('OLD_RENDERER_DIALOG_FAILED'));
    else oldGate.resolve({ response: oldResponse });
    await tick(); await tick();
    assert.equal(f.rendererDialogs().at(-1), currentOwner);
    assert.equal(replacement.urls.length, 1); f.assertCurrent(1);
    replacement.webContents.emit('unresponsive'); replacement.webContents.emit('render-process-gone');
    oldWindow.webContents.emit('unresponsive'); await tick();
    assert.equal(f.rendererDialogs().length, 2);
    currentGate.resolve({ response: 0 });
    // The replacement's original unresponsive prompt predates its gone
    // incident. Its old choice must stay inert until a fresh prompt is answered.
    await until(() => f.rendererDialogs().length === 3);
    const freshOwner = f.rendererDialogs().at(-1);
    assert.notEqual(freshOwner, currentOwner); assert.equal(f.r.dialogParents[f.r.dialogs.indexOf(freshOwner!)], replacement);
    assert.equal(replacement.urls.length, 1); f.assertCurrent(1);
    await tick();
    assert.equal(f.rendererDialogs().at(-1), freshOwner);
    assert.equal(replacement.urls.length, 1);
    freshGate.resolve({ response: 0 });
    await until(() => replacement.urls.length === 2);
    assert.equal(f.rendererDialogs().length, 3);
    assert.equal(replacement.urls.length, 2); f.assertCurrent(1);
  });
}

for (const entry of ['activate', 'renderer', 'menu']) {
  test(`current ${entry} navigation failure is still fatal, even with a cancellation-shaped code`, async t => {
    const error = failure('DESKTOP_START_CANCELLED');
    const f = await harness(t, { load: async (index: number, call: number) => { if (index > 0 || call > 1) throw error; } });
    await f.initial();
    if (entry === 'activate') { f.get('win').destroy(); f.activate(); }
    else if (entry === 'renderer') f.get('win').webContents.emit('render-process-gone');
    else f.reload();
    await until(() => f.fatals().length === 1);
    assert.equal(f.fatals()[0].detail, nativeText('native.originalDiagnostic', { detail: error.message }));
    await until(() => f.r.finished === 1);
    assert.equal(f.r.backends.length, 1);
  });
}

test('duplicate restart and activate retain one owned drain and one replacement', async t => {
  const gate = deferred();
  const f = await harness(t, { drain: (i: number) => i === 0 ? gate.promise : [], release: () => gate.resolve([]) });
  await f.initial(); const restarting = f.restart(); await until(() => f.r.drains === 1);
  await f.restart(); f.activate(); await tick();
  assert.equal(f.r.drains, 1); assert.equal(f.r.backends.length, 1); assert.equal(f.r.windows.length, 1);
  gate.resolve([]); await restarting; f.assertCurrent(1);
  assert.equal(f.r.backends.length, 2); assert.equal(f.r.windows.length, 2);
});

test('quit wins over activate and replacement during the owned restart drain', async t => {
  const gate = deferred();
  const f = await harness(t, { drain: (i: number) => i === 0 ? gate.promise : [], release: () => gate.resolve([]) });
  await f.initial(); const restarting = f.restart(); await until(() => f.r.drains === 1);
  f.app.quit(); assert.equal(f.get('quitRouter.isPending'), true);
  f.activate(); await tick(); assert.equal(f.r.windows.length, 1);
  gate.resolve([]); await restarting; await f.get('quitRouter.pending');
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

async function openOwnedEditor(f: Awaited<ReturnType<typeof harness>>) {
  const launcher = f.r.windows[0], projectId = '79000000-0000-4000-8000-000000000001';
  const host = f.get('windowHost');
  const entryToken = randomUUID(); launcher.entryTickets.set(entryToken, projectId);
  const opened = await f.r.bridge!({ sender: launcher.webContents, senderFrame: launcher.webContents.mainFrame },
    { action: 'open', contextId: host.contextFor(launcher).contextId, projectId, entryToken, remember: true });
  assert.equal((opened as {ok: boolean}).ok, true);
  const editor = f.r.windows.at(-1)!; await host.loadFor(editor);
  assert.equal(f.r.bridge!({ sender: editor.webContents, senderFrame: editor.webContents.mainFrame },
    { action: 'editor-status', contextId: host.contextFor(editor).contextId, projectId, phase: 'ready' }), true);
  return { launcher, editor };
}

test('actual main creates a parent-bound settings modal and blocks parent close/reload without spending admission', async t => {
  const f = await harness(t, {dialog: () => ({response: 1})}); await f.initial();
  const parent = f.r.windows[0], host = f.get('windowHost');
  assert.equal(host.showSettings('agent', parent), true);
  const settings = f.r.windows.at(-1)!; await host.loadFor(settings);
  assert.equal(settings.config.parent, parent); assert.equal(settings.config.modal, true);
  assert.ok(Number(settings.config.width) < Number(parent.config.width));
  assert.ok(Number(settings.config.height) < Number(parent.config.height));
  assert.equal(settings.config.minimizable, false); assert.equal(settings.config.maximizable, false);
  assert.equal(settings.config.webPreferences.session, parent.config.webPreferences.session);
  f.assertPolicies();
  const checks = f.r.nativeChecks.length, loads = parent.urls.length;
  parent.close(); await tick();
  assert.equal(parent.destroyed, false); assert.equal(host.contextFor(parent).settingsModalOpen, true);
  assert.equal(await f.get('windowAdmissions').get(parent).captureRecoveryDecision().reload(), false);
  assert.equal(await f.get('requestApplicationQuit')(parent), false);
  assert.equal(parent.urls.length, loads); assert.equal(f.r.nativeChecks.length, checks);
  assert.equal(f.get('quitRouter.isPending'), false); assert.equal(f.r.drains, 0);
  const closeSettings = () => f.r.bridge!({ sender: settings.webContents, senderFrame: settings.webContents.mainFrame },
    { action: 'settings-close', contextId: host.contextFor(settings).contextId });
  settings.disposition = 'dirty'; assert.equal(closeSettings(), true); await until(() => f.r.dialogs.some(item => item.title === '尚有未保存的修改'));
  await tick(); assert.equal(settings.destroyed, false); assert.equal(host.contextFor(parent).settingsModalOpen, true);
  settings.disposition = 'clean'; assert.equal(closeSettings(), true); await until(() => settings.destroyed);
  assert.equal(host.contextFor(parent).settingsModalOpen, false); assert.equal(parent.destroyed, false);
  parent.close(); await until(() => parent.destroyed);
});

test('actual Quit and Restart ask the dirty settings child before its parent and retain both on cancellation', async t => {
  for (const action of ['quit', 'restart'] as const) {
    const f = await harness(t, {disposition: index => index === 1 ? 'dirty' : 'clean', dialog: value => ({response: value.title === '尚有未保存的修改' ? 1 : 0})});
    await f.initial(); const parent = f.r.windows[0], host = f.get('windowHost');
    assert.equal(host.showSettings('agent', parent), true); const settings = f.r.windows.at(-1)!; await host.loadFor(settings);
    if (action === 'quit') { f.app.quit(); assert.equal(await f.get('quitRouter.pending'), false); }
    else { await f.restart(); assert.equal(f.get('restartCoordinator.state'), 'idle'); }
    assert.deepEqual(f.r.nativeChecks, [settings]);
    assert.equal(parent.destroyed, false); assert.equal(settings.destroyed, false);
    assert.equal(host.contextFor(parent).settingsModalOpen, true);
    assert.equal(f.r.drains, 0); assert.equal(f.r.children[0].messages.includes('stop'), false);
  }
});

test('actual main retains the modal fence for a destroyed settings handle until its closed event', async t => {
  const f = await harness(t, {holdClosed: index => index === 1}); await f.initial();
  const parent = f.r.windows[0], host = f.get('windowHost');
  assert.equal(host.showSettings('agent', parent), true); const settings = f.r.windows.at(-1)!; await host.loadFor(settings);
  settings.destroy(); assert.equal(settings.closedDelivered, false);
  assert.equal(host.contextFor(parent).settingsModalOpen, true);
  parent.close(); await tick(); assert.equal(parent.destroyed, false);
  assert.equal(await f.get('requestApplicationQuit')(parent), false);
  assert.equal(f.r.nativeChecks.length, 0); assert.equal(f.r.drains, 0);
  settings.deliverClosed(); assert.equal(host.contextFor(parent).settingsModalOpen, false);
  parent.close(); await until(() => parent.destroyed);
});

for (const disposition of ['dirty', 'unknown']) {
  test(`actual before-quit inspects focused editor ${disposition} first and cancellation retains both owners and backend`, async t => {
    const f = await harness(t, { disposition: (index: number) => index === 1 ? disposition : 'clean', dialog: () => ({ response: 1 }) });
    await f.initial(); const { launcher, editor } = await openOwnedEditor(f);
    f.app.quit(); assert.equal(await f.get('quitRouter.pending'), false);
    assert.deepEqual(f.r.nativeChecks, [editor], 'focused source must be admitted before any unrelated owner');
    assert.equal(f.r.dialogParents[0], editor);
    assert.equal(f.r.dialogs[0].title, disposition === 'dirty' ? '尚有未保存的修改' : '此窗口还有结果未知的操作');
    assert.equal(launcher.destroyed, false); assert.equal(editor.destroyed, false);
    assert.equal(f.r.drains, 0); assert.equal(f.r.children[0].messages.includes('stop'), false);
    assert.equal(f.r.settingsCloses, 0); assert.equal(f.r.finished, 0);
    assert.equal(f.get('quitCoordinator.state'), 'idle'); assert.equal(f.get('quitRouter.isPending'), false);
  });
}

for (const focus of ['none', 'untrusted']) {
  test(`actual before-quit with ${focus} focus falls back to the complete owned window set`, async t => {
    const unrelated = { isDestroyed: () => false, close() { assert.fail('An unrelated window must not be closed'); } };
    const f = await harness(t, { focusedWindow: () => focus === 'none' ? null : unrelated });
    await f.initial(); const { launcher, editor } = await openOwnedEditor(f);
    f.app.quit(); assert.equal(await f.get('quitRouter.pending'), true);
    assert.deepEqual(f.r.nativeChecks, [launcher, editor]);
    assert.equal(launcher.closedDelivered, true); assert.equal(editor.closedDelivered, true);
    assert.equal(f.r.children[0].messages.filter((type: string) => type === 'stop').length, 1);
    assert.equal(f.r.finished, 1);
  });
}

for (const frame of ['replaced', 'uncommitted']) {
  test(`actual before-quit with focused owned ${frame} frame falls back without skipping either owner`, async t => {
    const f = await harness(t); await f.initial();
    const { launcher, editor } = await openOwnedEditor(f), host = f.get('windowHost');
    const url = editor.webContents.getURL();
    if (frame === 'replaced') editor.webContents.mainFrame = { url };
    else editor.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    assert.equal(host.owns(editor), true, 'native lifetime alone remains current');
    f.app.quit(); assert.equal(await f.get('quitRouter.pending'), true);
    assert.deepEqual(f.r.nativeChecks, [launcher, editor], 'a stale document cannot gain focused-source priority');
    assert.equal(launcher.closedDelivered, true); assert.equal(editor.closedDelivered, true);
    assert.equal(f.r.children[0].messages.filter((type: string) => type === 'stop').length, 1);
    assert.equal(f.r.finished, 1);
  });
}

test('actual focused editor close reaches later launcher dirty prompt; cancelling partial quit retains its backend', async t => {
  const gate = deferred(); let decision = gate.promise;
  const f = await harness(t, { disposition: (index: number) => index === 0 ? 'dirty' : 'clean',
    dialog: (value: { title: string; }) => value.title === '尚有未保存的修改' ? decision : { response: 0 }, release: () => gate.resolve({ response: 1 }) });
  await f.initial(); const { launcher, editor } = await openOwnedEditor(f);
  f.app.quit(); const pending = f.get('quitRouter.pending');
  await until(() => f.r.dialogs.some(value => value.title === '尚有未保存的修改'));
  assert.deepEqual(f.r.nativeChecks, [editor, launcher]);
  assert.equal(editor.closedDelivered, true, 'later owner is prompted only after actual focused editor closure');
  assert.equal(launcher.destroyed, false); assert.equal(f.r.dialogParents.at(-1), launcher);
  assert.equal(f.r.drains, 0); assert.equal(f.r.children[0].messages.includes('stop'), false);
  gate.resolve({ response: 1 }); assert.equal(await pending, false);
  assert.equal(launcher.destroyed, false); assert.equal(editor.destroyed, true);
  assert.equal(f.r.settingsCloses, 0); assert.equal(f.r.finished, 0);
  assert.equal(f.get('quitCoordinator.state'), 'idle'); assert.equal(f.get('quitRouter.isPending'), false);
  decision = Promise.resolve({ response: 0 }); f.app.quit(); assert.equal(await f.get('quitRouter.pending'), true);
  assert.equal(launcher.closedDelivered, true); assert.equal(f.r.finished, 1);
  assert.equal(f.r.children[0].messages.filter((type: string) => type === 'stop').length, 1);
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
    if (!['backend-stop', 'unconfirmed-media'].includes(stage)) assert.equal(f.fatals()[0].detail, nativeText('native.originalDiagnostic', { detail: error.message }));
  });
}
