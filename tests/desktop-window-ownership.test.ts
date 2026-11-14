import {createAssetRelinkHost} from '../apps/desktop/src/asset-relink-host.ts';
import {createProjectLocationHelp} from '../apps/desktop/src/project-location-help.ts';
import {NATIVE_ASSET_MEDIA_CHANNEL} from '../packages/contracts/src/asset-media-native.ts';
import {createDesktopHarnessAppearanceCache,createDesktopHarnessProjectBroker,createDesktopHarnessProjectEntries} from './helpers/strict-desktop-harness-types.ts';
import {createProjectEntryDesktopHost} from '../apps/desktop/src/project-entry-desktop-host.ts';
import {PROJECT_ENTRY_DESKTOP_CHANNEL} from '../packages/contracts/src/project-entry-desktop.ts';
import {createProjectEntryControlBroker} from '../apps/desktop/src/project-entry-control.ts';
import {ASSET_IMPORT_CHANNEL,createAssetImportHost,importNativeAssetPath} from '../apps/desktop/src/asset-import-host.ts';
import {desktopAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {isProjectId,projectApiPath} from '../packages/contracts/src/project-file.ts';
import {DEFAULT_UI_PREFERENCES} from '../packages/contracts/src/ui-preferences.ts';
import type {DesktopHarnessOptions, DesktopHarnessRecords, DesktopHarnessWindow, DesktopHarnessWindowConfig, DesktopHarnessApp, DesktopHarnessMenuList, DesktopHarnessChild, DesktopHarnessBackend, DesktopHarnessSession, DesktopHarnessDialog, DesktopHarnessConnection, DesktopHarnessFrame} from './helpers/strict-desktop-harness-types.ts';
import {desktopMenuHarness} from './helpers/desktop-menu-harness.ts';
import {applicationMenuTemplate} from '../apps/desktop/src/application-menu.ts';
import {createMenuCommandHost} from '../apps/desktop/src/menu-command-host.ts';
import {MENU_COMMAND_CHANNEL, MENU_COMMAND_EVENT, MENU_COMMAND_IDS} from '../apps/desktop/src/menu-command-protocol.ts';
import type {MenuCommandId, MenuCommandIntent, MenuCommandState} from '../apps/desktop/src/menu-command-protocol.ts';
import type {MenuCommandGestureBridge} from '../apps/desktop/src/menu-command-protocol.ts';
import {createMenuCommandBridge} from '../apps/desktop/src/menu-command-preload.ts';
import {menuCommandGestureScript} from '../apps/desktop/src/menu-command-gesture.ts';
import { WORKSPACE_NATIVE_CHANNEL } from '../packages/contracts/src/workspace-native.ts';
import { createWorkspaceNativeHost } from '../apps/desktop/src/workspace-native-host.ts';
import { createProjectFileOpener, projectFileArguments } from '../apps/desktop/src/project-file-open.ts';
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
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
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
import { PROJECT_WINDOW_CHANNEL, PROJECT_WINDOW_EVENT, isProjectWindowRequest, type ProjectWindowContext } from '../apps/desktop/src/project-window-protocol.ts';
import { installNativeCloseAdmission } from '../apps/desktop/src/native-close.ts';
import * as security from '../apps/desktop/src/security.ts';
import { windowChromeOptions, MAC_TRAFFIC_LIGHT_POSITION } from '../apps/desktop/src/window-chrome.ts';
import { createLauncherWindowState, type WindowBounds } from '../apps/desktop/src/launcher-window-state.ts';
import { settingsWindowOptions } from '../apps/desktop/src/settings-window.ts';
import { createDesktopTray } from '../apps/desktop/src/tray-host.ts';
import { desktopTrayHarness } from './helpers/desktop-tray-harness.ts';
import { createDesktopWindowAppearance, desktopWindowBackground } from '../apps/desktop/src/window-appearance.ts';

const source = stripTypeScriptTypes((await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, ''), { mode: 'strip' });
const tools = { ffmpeg: '/synthetic/ffmpeg', ffprobe: '/synthetic/ffprobe', versions: { ffmpeg: 'synthetic' } };
type Gate = Omit<PromiseWithResolvers<unknown>, 'resolve'> & {resolve(value?: unknown): void};
const deferred = () => Promise.withResolvers() as Gate;
const tick = () => new Promise(resolve => setImmediate(resolve));
const pendingOpenChannel='mioon:project-entries:pending-open:v1';
const failure = (code: string) => Object.assign(new Error(`Synthetic ${code}`), { code });
async function until(predicate: () => unknown) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await tick(); }
  assert.fail('Synthetic window lifecycle did not reach the expected checkpoint');
}

// The real main, supervisor, security and lifecycle functions run in this VM.
// Only OS boundaries are fake. No Electron, native vault, utility or media runs.
// Deferred gates expose causality; they do not claim native event timing.
async function harness(t: test.TestContext, options: DesktopHarnessOptions<DesktopHarnessWindow> & {
  beforeCommit?(index: number): Promise<void> | undefined;
} = {}) {
  const nativeTray = desktopTrayHarness();
  const launcherStateRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-launcher-owner-'));
  t.after(() => rm(launcherStateRoot, {recursive: true, force: true}));
  const trackedLaunchers: Window[] = [];
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
  let menu: DesktopHarnessMenuList, initial: Promise<void>;
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
    const projectPort=createDesktopHarnessProjectEntries();
    const projectBroker=createDesktopHarnessProjectBroker(message=>queueMicrotask(()=>child.emit('message',message)),options.projectControl?.(index,projectPort)??projectPort);
    const child: DesktopHarnessChild<string> = Object.assign(new EventEmitter(), {
      pid: 31000 + index, messages: [], kills: 0, hardKills: 0,
      ready() { child.emit('message', { type: 'ready', url: `http://127.0.0.1:${45000 + index}`, runtime: { pid: child.pid } }); },
      postMessage(message: { type: string; dataDir?:string; cacheDir?:string; projectsDir?:string; backendId?:string }) {
        if(message.type==='start'){assert.equal(typeof message.backendId,'string');projectBroker.start(message.backendId!);}
        if(projectBroker.handle(message))return;
        if(message.type==='start'){assert.equal(message.dataDir,'/synthetic/data');assert.equal(message.cacheDir,'/synthetic/Library/Caches/synthetic');assert.equal(message.projectsDir,'/synthetic/Mioon');}
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
  const frameBridges = new WeakMap<DesktopHarnessFrame, MenuCommandGestureBridge>();
  interface Window extends DesktopHarnessWindow {closedDelivered: boolean; visible: boolean; fullScreen: boolean; hides: number; shows: number; focuses: number; flushes: number; index: number; disposition: string; entryTickets: Map<string, string>; menuPackets: {channel: string; value: MenuCommandIntent}[]; projectContexts: ProjectWindowContext[]; pendingOpenPackets:unknown[]; gestureCalls: {frame: DesktopHarnessFrame; script: string; userGesture: boolean | undefined}[]; gestureInputs: MenuCommandIntent[]; nativeUndos: number; nativeRedos: number; newFrame(url: string): DesktopHarnessFrame; bindMenuGesture(): Promise<void>; popupPolicy(): {action: string};}
  class Window extends EventEmitter {
    static getFocusedWindow() { return options.focusedWindow ? options.focusedWindow(r.windows) : r.windows.findLast(window => !window.destroyed) ?? null; }
    constructor(config: DesktopHarnessWindowConfig) {
      super();options.windowCreated?.(config); this.config = config; this.destroyed = false; this.closedDelivered = false;
      this.urls = []; this.shows = 0; this.focuses = 0; this.flushes = 0; this.visible = false; this.hides = 0;
      this.fullScreen = false; this.menuPackets = []; this.projectContexts = []; this.pendingOpenPackets=[]; this.nativeUndos = 0; this.nativeRedos = 0;
      this.gestureCalls = []; this.gestureInputs = [];
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
      this.newFrame = (url: string) => {
        let gesturePage!: vm.Context;
        const frame: DesktopHarnessFrame = {url, executeJavaScript: (script, userGesture) => {
          this.gestureCalls.push({frame, script, userGesture});
          const perform = () => vm.runInContext(script, gesturePage);
          return Promise.resolve(options.menuFrameExecute ? options.menuFrameExecute(this.index, perform) : perform());
        }};
        const bridge = createMenuCommandBridge({
          invoke: async (channel, request) => {
            const handler = r.ipcHandlers?.get(channel); assert.ok(handler);
            return handler({sender: this.webContents, senderFrame: frame}, request);
          }, on(){}, removeListener(){},
        });
        gesturePage = vm.createContext({__mioonMenuCommands: bridge}); frameBridges.set(frame, bridge);
        return frame;
      };
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: this.newFrame('about:blank'),
        getURL: () => this.webContents.mainFrame.url,
        send: (channel: string, value: MenuCommandIntent | ProjectWindowContext) => {
          if (channel === MENU_COMMAND_EVENT && 'command' in value) this.menuPackets.push({channel, value});
          if (channel === PROJECT_WINDOW_EVENT && 'quitting' in value) this.projectContexts.push(value);
          if (channel === pendingOpenChannel) this.pendingOpenPackets.push(value);
        },
        undo: () => { this.nativeUndos++; }, redo: () => { this.nativeRedos++; },
        loadURL: (url: string) => this.loadURL(url),
        executeJavaScript: async (script: string) => vm.runInContext(script, renderer),
        setWindowOpenHandler: (fn: Window['popupPolicy']) => { this.popupPolicy = fn; }
      });
      r.windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    async bindMenuGesture() {
      const bridge = frameBridges.get(this.webContents.mainFrame); assert.ok(bridge);
      await bridge.context(); bridge.subscribe(value => this.gestureInputs.push(value));
    }
    isVisible() { return this.visible; }
    isFullScreen() { return this.fullScreen; }
    setFullScreen(value: boolean) { this.fullScreen = value; }
    getTitle() { return String(this.config.title ?? 'Synthetic'); }
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
    show() { this.shows++; this.visible = true; this.emit('show'); }
    showInactive() { this.shows++; this.visible = true; this.emit('show'); }
    hide() { this.hides++; this.visible = false; }
    focus() { this.focuses++; }
    async loadURL(url: string) {
      this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
      this.urls.push(url);
      const beforeCommit = options.beforeCommit?.(this.index);
      if (beforeCommit) await beforeCommit;
      if (this.destroyed) return;
      this.webContents.mainFrame = this.newFrame(url);
      this.webContents.emit('did-navigate', {}, url);
      await options.load?.(this.index, this.urls.length, url);
    }
  }
  const context = vm.createContext({ createAssetRelinkHost, createProjectLocationHelp, NATIVE_ASSET_MEDIA_CHANNEL, createProjectEntryDesktopHost, PROJECT_ENTRY_DESKTOP_CHANNEL, PROJECT_ENTRY_DESKTOP_PENDING_OPEN_EVENT:pendingOpenChannel, desktopWindowBackground, createDesktopAppearanceCache:()=>createDesktopHarnessAppearanceCache(options.cache), probeDesktopProjectLocation:options.projectLocation??(async()=>({fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'})), desktopAppDirectories, isProjectId, projectApiPath, readNativeBackendMetadata: async () => ({revision:0,preferences:DEFAULT_UI_PREFERENCES,recentOpened:{},recoveredDefaults:false,writable:true}), app, applicationMenuTemplate, createMenuCommandHost, menuCommandGestureScript, MENU_COMMAND_CHANNEL, MENU_COMMAND_EVENT, MENU_COMMAND_IDS, queueMicrotask, createDesktopTray, ...nativeTray, createAppLanguageHost, nt: nativeText, setNativeLanguageReader: () => {}, resolveLocale, APP_LANGUAGE_CHANNEL, readAppLanguagePreference: () => null, writeAppLanguagePreference: () => {}, process: { platform: 'darwin', env: {}, on() {} }, path, randomBytes, randomUUID,
    __MIOON_DESKTOP_CHANNEL__: 'development', desktopIdentity: { identityForChannel: () => ({ channel: 'development', productName: 'Synthetic', appId: 'synthetic' }) },
    prepareDesktopStorage: () => ({ userData: '/synthetic/userData', dataDir: '/synthetic/data', configFile: '/synthetic/config' }),
    initializeDesktopPrivateStorage: () => {}, privateStorageHelperFile: () => '/synthetic/native/mioon_private_storage.node',
    CLIP_LUT_RECOVERY_CHANNEL, createDesktopLutRecoveryHost, calculateWorkspaceScope,
    WORKSPACE_TOOLS_CHANNEL, createWorkspaceToolsHost, WORKSPACE_NATIVE_CHANNEL, createWorkspaceNativeHost, ASSET_IMPORT_CHANNEL, createAssetImportHost, importNativeAssetPath, createProjectFileOpener, projectFileArguments,
    nativeTheme: Object.assign(new EventEmitter(), {shouldUseDarkColors:true}),
    createDesktopWindowAppearance,
    createDesktopLutRecoveryStore: createLutStore,
    validatePrivateDirectory: (root: unknown) => { assert.equal(root, '/synthetic/data'); return lutDirectory; },
    validateManagedFile: (file: string, { root }: {root: string}) => {
      assert.equal(file, '/synthetic/data/app-library.db'); assert.equal(root, '/synthetic/data'); return lutDatabase;
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
    screen: {getAllDisplays: () => [{workArea: {x: 0, y: 0, width: 1920, height: 1080}}]},
    createLauncherWindowState: (userData: string, workAreas: () => readonly WindowBounds[]) => {
      assert.equal(userData, '/synthetic/userData');
      return {options: createLauncherWindowState(launcherStateRoot, workAreas).options,
        track: (window: Window) => {trackedLaunchers.push(window);}};
    },
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
    createProjectWindowQuitRouter, confirmOwnedWindowRestart, PROJECT_WINDOW_CHANNEL, isProjectWindowRequest, NATIVE_AUDIO_CHANNEL,
    createNativeAudioPreviewHost, createNativeAudioPreviewSigningIdentity, consumeNativeProjectEntry,
    observeInitialProjectLoad, createProjectRendererRecovery, createProjectBackendIncident,
    ipcMain: { handle(channel: string, handler: (...values: unknown[]) => unknown) {
      assert.ok([ASSET_IMPORT_CHANNEL, APP_LANGUAGE_CHANNEL, PROJECT_WINDOW_CHANNEL, NATIVE_AUDIO_CHANNEL, CLIP_LUT_RECOVERY_CHANNEL, WORKSPACE_TOOLS_CHANNEL, WORKSPACE_NATIVE_CHANNEL, MENU_COMMAND_CHANNEL, PROJECT_ENTRY_DESKTOP_CHANNEL, NATIVE_ASSET_MEDIA_CHANNEL].includes(channel)); assert.equal(typeof handler, 'function');
      r.ipcHandlers ??= new Map(); assert.equal(r.ipcHandlers.has(channel), false); r.ipcHandlers.set(channel, handler);
      if (channel === PROJECT_WINDOW_CHANNEL) r.bridge = handler; else if (channel === NATIVE_AUDIO_CHANNEL) r.audioBridge = handler;
    } },
    installNativeCloseAdmission, stopBackendForQuit,
    writeConnection: async (_: unknown, value: DesktopHarnessConnection) => {
      const index = r.connectionWrites.length;
      r.connectionWrites.push(value); await options.connection?.(index); r.connections.push(value);
    },
    removeConnectionOnShutdown: async () => { r.removals++; await options.remove?.(r.removals); },
    Menu: { buildFromTemplate: desktopMenuHarness, setApplicationMenu: (value: DesktopHarnessMenuList) => { menu = value; } },
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
  options.beforeReady?.(app);
  assert.deepEqual([...r.ipcHandlers!.keys()].sort(),
    [ASSET_IMPORT_CHANNEL, APP_LANGUAGE_CHANNEL, CLIP_LUT_RECOVERY_CHANNEL, NATIVE_AUDIO_CHANNEL, PROJECT_WINDOW_CHANNEL, WORKSPACE_TOOLS_CHANNEL, WORKSPACE_NATIVE_CHANNEL, MENU_COMMAND_CHANNEL, PROJECT_ENTRY_DESKTOP_CHANNEL, NATIVE_ASSET_MEDIA_CHANNEL].sort());
  const get = (text: string) => vm.runInContext(text, context);
  t.after(async () => {
    get('quitting = true; trayHost?.dispose()'); options.release?.();
    for (const child of r.children) child.emit('exit', 0);
    for (const window of r.windows) { window.destroy(); window.deliverClosed(); }
    await tick();
    assert.deepEqual((r.lutStoreCalls as unknown), [], 'Window lifecycle must not read or mutate LUT recovery metadata');
  });
  await until(() => menu);
  return {
    r, app, get, nativeTray, trackedLaunchers, initial: () => initial, menu: (id: string) => menu.getMenuItemById(id)!,
    restart: () => menu.getMenuItemById('app-restart')!.click!(),
    newProject: () => menu.getMenuItemById('app-new-project')!.click!(),
    reload: () => {
      // A real user can invoke Reload only after native presentation. This VM
      // otherwise leaves ready-to-show under individual test control.
      const focused = Window.getFocusedWindow();
      if (focused instanceof Window && !focused.visible) focused.emit('ready-to-show');
      return menu.getMenuItemById('app-reload')!.click!();
    },
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

async function signalEditorReady(f: Awaited<ReturnType<typeof harness>>, editor: DesktopHarnessWindow) {
  const host = f.get('windowHost'); await host.loadFor(editor);
  const context = host.contextFor(editor);
  assert.equal(await f.r.bridge!({sender: editor.webContents, senderFrame: editor.webContents.mainFrame},
    {action: 'editor-status', contextId: context.contextId, projectId: context.editorProjectId, phase: 'ready'}), true);
}

async function readyColdEditor(f: Awaited<ReturnType<typeof harness>>) {
  await until(() => f.r.windows.some(window => window.urls.at(-1)?.includes('?project=')));
  const editor = f.r.windows.find(window => window.urls.at(-1)?.includes('?project='))!;
  await signalEditorReady(f, editor);
  await f.initial();
}

test('real main cold Finder and hot second-instance opens share a leased editor without uploading or flashing a launcher',async t=>{
 const file='/synthetic/Movies/Film.mioon',leases=new Set<string>(),released:string[]=[];let constructions=0,opens=0;
 const f=await harness(t,{
  beforeReady:app=>{app.emit('open-file',{preventDefault(){}},file);},
  windowCreated:()=>{constructions++;if(constructions===1)assert.ok(leases.size>0,'the utility lease must exist before BrowserWindow construction');},
  projectControl:(_index,port)=>({...port,openPath:async input=>{assert.equal(input.projectFile,file);opens++;const result=await port.openPath(input);leases.add(input.windowId);return result;},release:input=>{released.push(input.windowId);leases.delete(input.windowId);port.release(input);}}),
 });
 await readyColdEditor(f);assert.equal(constructions,1,JSON.stringify({opens,dialogs:f.r.dialogs}));assert.equal(f.r.windows.length,1,JSON.stringify({opens,leases:[...leases],dialogs:f.r.dialogs}));assert.ok(f.r.windows[0].urls[0].includes('?project='));assert.equal(opens,1);assert.equal(leases.size,1);
 f.app.emit('second-instance',{},['mioon',file],'/synthetic');try{await until(()=>opens===2&&released.length===1);}catch{assert.fail(JSON.stringify({opens,released,leases:[...leases],dialogs:f.r.dialogs}));}assert.equal(f.r.windows.length,1);assert.equal(leases.size,1);
 f.r.windows[0].destroy();await until(()=>released.length===2);assert.equal(new Set(released).size,2,'temporary duplicate lease and editor lease each release once');assert.equal(leases.size,0);
});

test('real main discards an OS open whose location probe finishes after backend replacement',async t=>{
 const probe=Promise.withResolvers<import('../packages/contracts/src/project-entry-desktop.ts').ProjectLocationFacts>();let probed=0;const opened:number[]=[];
 const f=await harness(t,{projectLocation:async()=>{probed++;return probe.promise;},projectControl:(index,port)=>({...port,openPath:async input=>{opened.push(index);return port.openPath(input);}})});
 await f.initial();f.app.emit('open-file',{preventDefault(){}},'/synthetic/Movies/Late.mioon');await until(()=>probed===1);
 const restart=f.restart();await until(()=>f.r.backends.length===2&&f.r.connections.length===2);
 probe.resolve({fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'});await restart;await tick();
 assert.deepEqual(opened,[],'no old or replacement utility may acquire a lease for the stale OS intent');assert.equal(f.r.windows.filter(window=>!window.destroyed).length,1);assert.ok(f.r.windows.filter(window=>!window.destroyed).every(window=>!window.urls.at(-1)?.includes('?project=')));assert.equal(f.fatals().length,0);
});

test('OS files queued during restart do not wait for a paused renderer to admit its own ready status', async t => {
  const file = '/synthetic/Movies/Restart.mioon', opens: Array<{backend: number; deferRecent?: true}> = [];
  const f = await harness(t, {
    child: index => ({ready: index === 0}),
    projectControl: (backend, port) => ({...port, openPath(input) {
      assert.equal(input.projectFile, file);
      opens.push({backend, deferRecent: input.deferRecent});
      return port.openPath(input);
    }}),
  });
  await f.initial();
  const restart = f.restart();
  await until(() => f.r.children.length === 2);
  f.app.emit('open-file', {preventDefault() {}}, file);
  assert.deepEqual(Array.from(f.get('projectFiles.pending')), [file]);
  f.r.children[1].ready();
  await until(() => f.get('restarting') === false);
  await restart;
  assert.deepEqual(opens, [{backend: 1, deferRecent: undefined}]);
  const editor = f.r.windows.find(window => !window.destroyed && window.urls.at(-1)?.includes('?project='));
  assert.ok(editor);
  await signalEditorReady(f, editor);
  assert.equal(f.get('windowHost').contextFor(editor).editorPhase, 'ready');
  assert.deepEqual(f.fatals(), []);
});

test('real main keeps a later valid OS file queued until the earlier failure sheet closes',async t=>{
 const bad='/synthetic/Movies/Bad.mioon',good='/synthetic/Movies/Good.mioon',sheet=Promise.withResolvers<{response:number}>(),probed:string[]=[],opened:string[]=[];let sheets=0;
 const f=await harness(t,{
  beforeReady:app=>{app.emit('open-file',{preventDefault(){}},bad);app.emit('open-file',{preventDefault(){}},good);},
  projectLocation:async input=>{probed.push(input.path);return {fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'};},
  projectControl:(_index,port)=>({...port,openPath:async input=>{opened.push(input.projectFile);if(input.projectFile===bad)throw Object.assign(Error('synthetic corrupt project'),{code:'PROJECT_INVALID',status:422,details:{reason:'corrupt'}});return port.openPath(input);}}),
  dialog:()=>{sheets++;return sheet.promise;},release:()=>sheet.resolve({response:0}),
 });
 await until(()=>sheets===1);await tick();assert.deepEqual(probed,[bad]);assert.deepEqual(opened,[bad]);assert.deepEqual(Array.from(f.get('projectFiles.pending')),[good]);
 sheet.resolve({response:0});await readyColdEditor(f);
 assert.deepEqual(opened,[bad,good]);assert.deepEqual(probed,[bad,good]);assert.equal(sheets,1);assert.equal(f.r.windows.filter(window=>window.urls.at(-1)?.includes('?project=')).length,1);assert.equal(f.fatals().length,0);
});

test('real main project-entry IPC refuses settings children, their blocked parent and a replaced frame',async t=>{
 const f=await harness(t);await f.initial();const parent=f.r.windows[0],host=f.get('windowHost'),handler=f.r.ipcHandlers!.get(PROJECT_ENTRY_DESKTOP_CHANNEL)!;
 const invoke=(window:typeof parent,frame:DesktopHarnessFrame=window.webContents.mainFrame)=>handler({sender:window.webContents,senderFrame:frame},{action:'capabilities'}) as Promise<{ok:boolean}>;
 assert.equal((await invoke(parent)).ok,true);
 assert.equal((await invoke(parent,{url:parent.webContents.mainFrame.url})).ok,false);
 assert.equal(host.showSettings('agent',parent),true);const settings=f.r.windows.at(-1)!;await host.loadFor(settings);
 assert.equal((await invoke(settings)).ok,false);assert.equal((await invoke(parent)).ok,false);
});

for(const reason of ['network','read-only-volume','read-only-file'] as const){
 test(`real main retains a trusted copy source for a cold ${reason} selection without opening an editor`,async t=>{
  const file='/synthetic/Movies/Source.mioon',projectId=randomUUID();let opens=0,observations=0;
  const f=await harness(t,{
   beforeReady:app=>app.emit('open-file',{preventDefault(){}},file),
   projectLocation:async()=>({fileSystem:'apfs',isLocal:reason!=='network',volumeReadOnly:reason==='read-only-volume',permissionBits:true,cloud:'not-reported'}),
   projectControl:(_index,port)=>({...port,openPath:async()=>{opens++;throw Object.assign(new Error('Read-only source'),{code:'PROJECT_INVALID',details:{database:'project',reason:'read-only'}});},
    observeSource:async input=>{assert.equal(input.projectFile,file);observations++;return {name:'Source',original:null,source:{sourceProjectId:projectId,sourceFile:file,sourceIdentity:{dev:'1',ino:'2'},sourceStamp:{contentSequence:0,contentToken:'a'.repeat(32)}}};}}),
  });
  await f.initial();assert.equal(opens,reason==='read-only-file'?2:0);assert.equal(observations,1);
  assert.equal(f.r.windows.length,1);const launcher=f.r.windows[0];assert.ok(!launcher.urls[0].includes('?project='));
  const handler=f.r.ipcHandlers!.get(PROJECT_ENTRY_DESKTOP_CHANNEL)!;
  const result=await handler({sender:launcher.webContents,senderFrame:launcher.webContents.mainFrame},{action:'takePendingOpen'}) as {ok:boolean;data:{status:string;reason:string;displayPath:string;token:string}};
  assert.equal(result.ok,true);assert.equal(result.data.status,'copy-source');assert.equal(result.data.reason,reason==='network'?'network':'read-only');assert.equal(result.data.displayPath,file);assert.ok(isProjectId(result.data.token));
 });
}

test('real main notifies an already initialized launcher about a later read-only OS open exactly once',async t=>{
 const file='/synthetic/Movies/Hot Readonly.mioon',projectId=randomUUID();let observed=0;
 const f=await harness(t,{
  projectLocation:async()=>({fileSystem:'apfs',isLocal:true,volumeReadOnly:true,permissionBits:true,cloud:'not-reported'}),
  projectControl:(_index,port)=>({...port,observeSource:async input=>{observed++;return {name:'Hot Readonly',original:null,source:{sourceProjectId:projectId,sourceFile:input.projectFile,sourceIdentity:{dev:'1',ino:'2'},sourceStamp:{contentSequence:0,contentToken:'a'.repeat(32)}}};}}),
 });
 await f.initial();const launcher=f.r.windows[0],handler=f.r.ipcHandlers!.get(PROJECT_ENTRY_DESKTOP_CHANNEL)!;
 const take=()=>handler({sender:launcher.webContents,senderFrame:launcher.webContents.mainFrame},{action:'takePendingOpen'}) as Promise<{ok:boolean;data:{status:string;reason:string}|null}>;
 assert.equal((await take()).data,null);
 f.app.emit('open-file',{preventDefault(){}},file);await until(()=>observed===1);await until(()=>launcher.pendingOpenPackets.length===1);
 const notice=launcher.pendingOpenPackets[0] as {backendId:string;windowId:string;contextId:string},owner=f.get('windowHost').contextFor(launcher);
 assert.equal(notice.backendId,owner.backendId);assert.equal(notice.windowId,owner.windowId);assert.equal(notice.contextId,owner.contextId);
 const first=await take();assert.equal(first.ok,true);assert.equal(first.data?.status,'copy-source');assert.equal(first.data?.reason,'read-only');assert.equal((await take()).data,null);
 assert.equal(f.r.windows.length,1);assert.equal(f.r.dialogs.length,0);assert.equal(launcher.pendingOpenPackets.length,1);
});

for(const cold of [false,true])test(`real main confirms an exFAT copy location once during a ${cold?'cold':'hot'} OS open`,async t=>{
 const file='/synthetic/Movies/exFAT Copy.mioon',projectId=randomUUID();let observations=0,opens=0;
 const f=await harness(t,{
  ...(cold?{beforeReady:(app:DesktopHarnessApp)=>app.emit('open-file',{preventDefault(){}},file)}:{}),
  projectLocation:async()=>({fileSystem:'exfat',isLocal:true,volumeReadOnly:false,permissionBits:false,cloud:'not-reported'}),
  projectControl:(_index,port)=>({...port,openPath:async()=>{opens++;throw Object.assign(Error('Project copy requires confirmation'),{code:'PROJECT_FILE_COPY',status:409});},
   observeSource:async input=>{observations++;return {name:'exFAT Copy',original:null,source:{sourceProjectId:projectId,sourceFile:input.projectFile,sourceIdentity:{dev:'1',ino:'2'},sourceStamp:{contentSequence:0,contentToken:'a'.repeat(32)}}};}}),
 });
 await f.initial();if(!cold){f.app.emit('open-file',{preventDefault(){}},file);await until(()=>observations===1);await tick();}
 assert.equal(observations,1);assert.equal(opens,2);assert.equal(f.r.dialogs.length,1,'the main warning must be reused by the fallback, rather than shown a second time');
 const launcher=f.r.windows[0],handler=f.r.ipcHandlers!.get(PROJECT_ENTRY_DESKTOP_CHANNEL)!;
 const result=await handler({sender:launcher.webContents,senderFrame:launcher.webContents.mainFrame},{action:'takePendingOpen'}) as {ok:boolean;data:{status:string}};
 assert.equal(result.ok,true);assert.equal(result.data.status,'copy');assert.equal(launcher.pendingOpenPackets.length,1);assert.equal(f.r.windows.length,1);
});

test('real main delivers a cold copy result after a delayed risk warning even when the launcher already took null',async t=>{
 const file='/synthetic/Movies/Delayed Copy.mioon',projectId=randomUUID(),warning=Promise.withResolvers<{response:number}>(),loaded=Promise.withResolvers<void>();let sheets=0;
 const f=await harness(t,{
  beforeReady:app=>app.emit('open-file',{preventDefault(){}},file),
  load:()=>loaded.promise,
  projectLocation:async()=>({fileSystem:'exfat',isLocal:true,volumeReadOnly:false,permissionBits:false,cloud:'not-reported'}),
  projectControl:(_index,port)=>({...port,openPath:async()=>{throw Object.assign(Error('Project copy requires confirmation'),{code:'PROJECT_FILE_COPY',status:409});},
   observeSource:async input=>({name:'Delayed Copy',original:null,source:{sourceProjectId:projectId,sourceFile:input.projectFile,sourceIdentity:{dev:'1',ino:'2'},sourceStamp:{contentSequence:0,contentToken:'a'.repeat(32)}}})}),
  dialog:()=>{sheets++;return warning.promise;},release:()=>{loaded.resolve();warning.resolve({response:0});},
 });
 await until(()=>f.r.windows.length===1&&f.r.windows[0].urls.length===1);const launcher=f.r.windows[0],handler=f.r.ipcHandlers!.get(PROJECT_ENTRY_DESKTOP_CHANNEL)!;
 const empty=await handler({sender:launcher.webContents,senderFrame:launcher.webContents.mainFrame},{action:'takePendingOpen'}) as {ok:boolean;data:unknown};assert.equal(empty.ok,true);assert.equal(empty.data,null);
 loaded.resolve();await until(()=>sheets===1);
 warning.resolve({response:0});await f.initial();
 assert.equal(sheets,1);assert.equal(launcher.pendingOpenPackets.length,1);
 const result=await handler({sender:launcher.webContents,senderFrame:launcher.webContents.mainFrame},{action:'takePendingOpen'}) as {ok:boolean;data:{status:string}|null};
 assert.equal(result.ok,true);assert.equal(result.data?.status,'copy');
 const again=await handler({sender:launcher.webContents,senderFrame:launcher.webContents.mainFrame},{action:'takePendingOpen'}) as {ok:boolean;data:unknown};assert.equal(again.data,null);
});

test('real main retains relink document tickets across a temporary Settings admission fence',async t=>{
 const projectId='22222222-2222-4222-8222-222222222222',assetId=randomUUID(),owners:string[]=[];let picks=0;
 const f=await harness(t,{
  beforeReady:app=>app.emit('open-file',{preventDefault(){}},'/synthetic/Movies/Project.mioon'),
  projectControl:(_index,port)=>({...port,nativeRelink:{
   candidate:async input=>{owners.push(input.ownerToken);return {projectId,assetId,expectedReferenceRevision:1,candidateToken:randomUUID(),displayPath:'/synthetic/Movies/image.png',outside:false,confirmationRequired:false};},
   preview:async()=>({projectId,assetId,expectedReferenceRevision:1,previewToken:randomUUID(),displayPath:'/synthetic/Movies/image.png',outside:false,rows:[{assetId,name:'image.png',from:'/synthetic/old/image.png',to:'/synthetic/Movies/image.png',outcome:'picked',referenceRevision:1}],foundBy:null}),
   apply:async input=>{owners.push(input.ownerToken);return {status:'failed',error:{code:'MEDIA_CHANGED',status:409},confirmedDirectories:[]};},
   discard:async()=>{},
  }}),
 });
 await readyColdEditor(f);const editor=f.r.windows[0],host=f.get('windowHost'),handler=f.r.ipcHandlers!.get(NATIVE_ASSET_MEDIA_CHANNEL)!;
 f.get('dialog').showOpenDialog=async()=>{picks++;return {canceled:false,filePaths:['/synthetic/Movies/image.png']};};
 const invoke=(input:unknown)=>handler({sender:editor.webContents,senderFrame:editor.webContents.mainFrame},input) as Promise<{ok:boolean;data:{previewToken:string;status?:string}}>;
 const choose={action:'choose',projectId,assetId,expectedReferenceRevision:1},first=await invoke(choose);assert.equal(first.ok,true);
 assert.equal(host.showSettings('agent',editor),true);const settings=f.r.windows.at(-1)!;await host.loadFor(settings);
 assert.equal((await invoke(choose)).ok,false);assert.equal(picks,1,'blocked admission cannot show a picker');
 settings.destroy();settings.deliverClosed();await tick();
 const applied=await invoke({action:'apply',projectId,previewToken:first.data.previewToken,requestId:randomUUID()});
 assert.equal(applied.ok,true,'the original document ticket remains usable after Settings closes');assert.equal(applied.data.status,'failed');
 assert.equal((await invoke(choose)).ok,true);assert.equal(picks,2);assert.equal(new Set(owners).size,1,'temporary admission never retires or remints document authority');
});

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
  assert.equal(replacement.shows, 1, 'explicit activation can show the already committed replacement before ready-to-show');
  replacement.emit('ready-to-show'); assert.equal(replacement.shows, 2);
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
    // The menu now correctly denies restart behind a native dialog. Exercise
    // replacement through the existing internal host operation to retain the
    // independent old-dialog/epoch regression.
    await f.get('restart')(); const replacement = f.get('win');
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
    // A trusted host replacement still must retire this old dialog even
    // though the public menu cannot initiate it while the prompt is open.
    await f.get('restart')(); const replacement = f.get('win');
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

async function openOwnedEditor(f: Awaited<ReturnType<typeof harness>>, projectId = '79000000-0000-4000-8000-000000000001', source = f.r.windows[0]) {
  const launcher = f.r.windows[0];
  const host = f.get('windowHost');
  const entryToken = randomUUID(); source.entryTickets.set(entryToken, projectId);
  const count = f.r.windows.length;
  const opening = f.r.bridge!({ sender: source.webContents, senderFrame: source.webContents.mainFrame },
    { action: 'open', contextId: host.contextFor(source).contextId, projectId, entryToken, remember: true });
  await until(() => f.r.windows.length === count + 1);
  const editor = f.r.windows.at(-1)!; await signalEditorReady(f, editor);
  assert.equal((await opening as {ok: boolean}).ok, true);
  return { launcher, editor };
}

test('a first renderer crash keeps the launcher visible and releases only the hidden candidate on closed', async t => {
  const released: string[] = [], marked: string[] = [];
  const f = await harness(t, {holdClosed: index => index === 1, projectControl: (_index, port) => ({...port,
    markOpened(input) { marked.push(input.windowId); return port.markOpened!(input); },
    release(input) { released.push(input.windowId); port.release(input); },
  })});
  await f.initial();
  const launcher = f.r.windows[0], host = f.get('windowHost');
  const contextId = host.contextFor(launcher).contextId;
  const projectId = '79000000-0000-4000-8000-000000000001', entryToken = randomUUID();
  launcher.emit('ready-to-show'); assert.equal(launcher.visible, true);
  launcher.entryTickets.set(entryToken, projectId);
  const opening = Promise.resolve(f.r.bridge!({sender: launcher.webContents, senderFrame: launcher.webContents.mainFrame},
    {action: 'open', contextId, projectId, entryToken, remember: true}));
  let settled = false; void opening.then(() => { settled = true; });
  await until(() => f.r.windows.length === 2);
  const editor = f.r.windows[1]; await host.loadFor(editor);
  const windowId = host.contextFor(editor).windowId;
  editor.emit('ready-to-show');
  editor.webContents.emit('unresponsive'); await tick();
  assert.equal(editor.shows, 0); assert.equal(editor.destroyed, false); assert.equal(settled, false);
  assert.equal(launcher.visible, true); assert.deepEqual(marked, []);
  editor.webContents.emit('render-process-gone', {}, {reason: 'crashed', exitCode: 1});
  await until(() => editor.destroyed);
  assert.equal(editor.closedDelivered, false); assert.equal(settled, false);
  assert.deepEqual(released, []);
  editor.deliverClosed();
  const result = await opening;
  await until(() => released.length === 1);
  assert.deepEqual(released, [windowId]);
  assert.deepEqual(result, {ok: false, reason: 'unavailable', targetWindowId: null, targetPhase: null});
  assert.deepEqual(host.contextFor(launcher).entryReceipt, {entryToken, result});
  assert.equal(launcher.visible, true); assert.equal(editor.shows, 0);
  assert.deepEqual(marked, []); assert.equal(f.r.quits, 0); assert.equal(f.r.drains, 0);
  assert.deepEqual(f.rendererDialogs(), []);
});

test('an uncommitted editor navigation failure closes by the initial empty proof before replying', async t => {
  const navigation = Promise.withResolvers<void>(), released: string[] = [];
  const f = await harness(t, {
    beforeCommit: index => index === 1 ? navigation.promise : undefined,
    holdClosed: index => index === 1,
    projectControl: (_index, port) => ({...port,
      release(input) { released.push(input.windowId); port.release(input); },
    }),
  });
  await f.initial();
  const launcher = f.r.windows[0], host = f.get('windowHost');
  launcher.emit('ready-to-show');
  const projectId = '79000000-0000-4000-8000-000000000001', entryToken = randomUUID();
  launcher.entryTickets.set(entryToken, projectId);
  const opening = Promise.resolve(f.r.bridge!({sender: launcher.webContents, senderFrame: launcher.webContents.mainFrame},
    {action: 'open', contextId: host.contextFor(launcher).contextId, projectId, entryToken, remember: true}));
  let settled = false; void opening.then(() => { settled = true; });
  await until(() => f.r.windows[1]?.urls.length === 1);
  const editor = f.r.windows[1], windowId = host.contextFor(editor).windowId;
  assert.equal(editor.webContents.getURL(), 'about:blank');
  navigation.reject(new Error('Synthetic pre-commit navigation failure'));
  await until(() => editor.destroyed);
  assert.deepEqual(f.r.nativeChecks, []);
  assert.equal(launcher.visible, true); assert.equal(editor.shows, 0);
  assert.equal(settled, false); assert.deepEqual(released, []);
  editor.deliverClosed();
  const result = await opening;
  assert.deepEqual(result, {ok: false, reason: 'unavailable', targetWindowId: null, targetPhase: null});
  assert.deepEqual(host.contextFor(launcher).entryReceipt, {entryToken, result});
  await until(() => released.length === 1);
  assert.deepEqual(released, [windowId]); assert.deepEqual(f.r.dialogs, []);
});

test('a blocked candidate close warns only its originating launcher and preserves the original result', async t => {
  const f = await harness(t, {disposition: index => index === 1 ? 'blocked' : 'clean'});
  await f.initial();
  const launcher = f.r.windows[0], host = f.get('windowHost');
  launcher.emit('ready-to-show');
  const projectId = '79000000-0000-4000-8000-000000000001', entryToken = randomUUID();
  launcher.entryTickets.set(entryToken, projectId);
  const opening = Promise.resolve(f.r.bridge!({sender: launcher.webContents, senderFrame: launcher.webContents.mainFrame},
    {action: 'open', contextId: host.contextFor(launcher).contextId, projectId, entryToken, remember: true}));
  let settled = false; void opening.then(() => { settled = true; });
  await until(() => f.r.windows.length === 2);
  const candidate = f.r.windows[1]; await host.loadFor(candidate);
  const sender = {sender: candidate.webContents, senderFrame: candidate.webContents.mainFrame};
  const contextId = host.contextFor(candidate).contextId, failure = {code: 'PROJECT_MISSING'};
  assert.equal(f.r.bridge!(sender, {action: 'editor-status', contextId, projectId, phase: 'failed', failure}), true);
  await until(() => f.r.dialogs.some(item => item.title === '暂时无法安全离开'));
  const notice = f.r.dialogs.findIndex(item => item.title === '暂时无法安全离开');
  assert.equal(f.r.dialogParents[notice], launcher);
  assert.equal(candidate.destroyed, false); assert.equal(candidate.shows, 0);
  assert.equal(launcher.visible, true); assert.equal(settled, false);
  candidate.disposition = 'clean';
  assert.equal(f.r.bridge!(sender, {action: 'editor-status', contextId, projectId, phase: 'ready'}), false);
  const result = await opening;
  assert.equal(candidate.closedDelivered, true);
  assert.deepEqual(result, {ok: false, reason: 'unavailable', targetWindowId: null, targetPhase: null, failure});
  assert.deepEqual(host.contextFor(launcher).entryReceipt, {entryToken, result});
  assert.equal(candidate.shows, 0); assert.equal(launcher.visible, true);
});

test('actual main centers and titles the launcher with its own window state', async t => {
  const f = await harness(t); await f.initial();
  const {launcher, editor} = await openOwnedEditor(f);
  const windowOptions = ({width, height, minWidth, minHeight, center, title}: DesktopHarnessWindowConfig) =>
    ({width, height, minWidth, minHeight, center, title});
  assert.deepEqual(windowOptions(launcher.config), {
    width: 1000, height: 680, minWidth: 820, minHeight: 560, center: true, title: 'Mioon',
  });
  assert.equal(Object.hasOwn(launcher.config, 'x'), false);
  assert.equal(Object.hasOwn(launcher.config, 'y'), false);
  assert.deepEqual(windowOptions(editor.config), {
    width: 1500, height: 960, minWidth: 1050, minHeight: 680, center: undefined, title: 'Synthetic',
  });
  for (const projectWindow of [launcher, editor]) {
    const args = projectWindow.config.webPreferences.additionalArguments;
    assert.ok(Array.isArray(args));
    assert.deepEqual(Array.from(args), ['--mioon-home-directory=/synthetic']);
  }
  const allowsPageTitle = (window: DesktopHarnessWindow, title: string) => {
    let prevented = false;
    window.emit('page-title-updated', {preventDefault() { prevented = true; }}, title);
    return !prevented;
  };
  assert.equal(allowsPageTitle(launcher, 'Localized bootstrap title'), false);
  assert.equal(allowsPageTitle(launcher, 'Mioon'), true);
  assert.equal(allowsPageTitle(editor, 'Synthetic Project · Mioon'), true);
  const host = f.get('windowHost');
  assert.equal(host.showSettings('agent', editor), true);
  assert.equal(f.r.windows.length, 3);
  const settingsArgs = f.r.windows[2]?.config.webPreferences.additionalArguments;
  assert.ok(Array.isArray(settingsArgs));
  assert.deepEqual(Array.from(settingsArgs), ['--mioon-settings-locale=en', '--mioon-settings-theme=dark']);
  assert.deepEqual(f.trackedLaunchers.map(window => window.index), [launcher.index]);
});

for (const source of ['menu', 'settings'] as const) {
  test(`011 restart from ${source} restores editor IDs against the new backend independently`, async t => {
    const firstId = '79000000-0000-4000-8000-000000000001', secondId = '79000000-0000-4000-8000-000000000002';
    const relocated = (projectId: string) => `/synthetic/relocated/${projectId}.mioon`;
    const prepared: string[] = [], acquired: {projectId: string; expectedProjectFile: string | undefined}[] = [];
    const openFailure = nativeText('native.openProjectFileFailed'), warning = nativeText('native.projectLocationWarning');
    const acquire = deferred(), failureSheet = deferred();
    const f = await harness(t, {
      release: () => {acquire.resolve(); failureSheet.resolve({response: 0});},
      dialog: value => value.message === openFailure ? failureSheet.promise : {response: 0},
      projectLocation: async ({path}) => ({fileSystem: 'apfs', isLocal: true, volumeReadOnly: false, permissionBits: true,
        cloud: path === relocated(secondId) && source === 'menu' ? 'known-icloud' : 'not-reported'}),
      projectControl: (index, port) => index === 0 ? port : {
        ...port,
        prepareAcquire: async ({projectId}) => {
          prepared.push(projectId);
          if (source === 'settings' && projectId === firstId) throw Object.assign(failure('PROJECT_MISSING'), {status: 404});
          assert.ok(port.prepareAcquire);
          return {...await port.prepareAcquire({projectId}), projectFile: relocated(projectId)};
        },
        acquire: async input => {
          acquired.push({projectId: input.projectId, expectedProjectFile: input.expectedProjectFile});
          if (source === 'menu' && input.projectId === secondId) await acquire.promise;
          const lease = await port.acquire(input);
          return {...lease, project: {...lease.project, projectFile: relocated(input.projectId)}};
        },
        openPath: () => assert.fail('Restart must acquire the registered project ID'),
      },
    });
    await f.initial();
    const {launcher, editor: first} = await openOwnedEditor(f, firstId);
    const {editor: second} = await openOwnedEditor(f, secondId, first);
    if (source === 'settings') {
      const host = f.get('windowHost');
      assert.equal(host.showSettings('video-tools', second), true);
      const settings = f.r.windows.at(-1)!; await host.loadFor(settings);
      assert.equal(await f.r.ipcHandlers!.get(WORKSPACE_NATIVE_CHANNEL)!({
        sender: settings.webContents, senderFrame: settings.webContents.mainFrame,
      }, {action: 'restart'}), true);
    } else {
      const restarting = f.restart();
      await until(() => acquired.length === 2);
      assert.equal(f.r.dialogs.filter(value => value.message === warning).length, 1);
      const host = f.get('windowHost'), newWindows = f.r.windows.filter(window => !window.destroyed);
      assert.equal(newWindows.length, 2);
      for (const window of newWindows) {
        const context = host.contextFor(window);
        assert.equal(context.quitting, true);
        assert.equal(context.autoOpen, false);
      }
      acquire.resolve();
      await restarting;
    }
    assert.ok([launcher, first, second].every(window => window.closedDelivered));
    assert.equal(f.r.backends.length, 2);
    assert.deepEqual(prepared, [firstId, secondId], 'both old editor IDs must be looked up on the fresh backend');
    const expectedIds = source === 'menu' ? [firstId, secondId] : [secondId];
    assert.deepEqual(acquired, expectedIds.map(projectId => ({projectId, expectedProjectFile: relocated(projectId)})));
    const current = f.r.windows.filter(window => !window.destroyed), host = f.get('windowHost');
    assert.deepEqual(current.flatMap(window => host.contextFor(window)?.editorProjectId ?? []), expectedIds);
    for (const window of current) {
      await host.loadFor(window);
      assert.equal(new URL(window.urls.at(-1)!).port, '45001');
    }
    if (source === 'settings') {
      await until(() => f.r.dialogs.some(value => value.message === openFailure));
      const notices = f.r.dialogs.filter(value => value.message === openFailure);
      assert.equal(notices.length, 1);
      assert.match(notices[0].detail!, /找不到/u);
      // The surviving editor is already loaded while the independent notice
      // awaits acknowledgement. Capability discovery resumes on publication.
      assert.ok(current.every(window => host.contextFor(window).quitting === true));
      failureSheet.resolve({response: 0});
      await until(() => current.every(window => host.contextFor(window).quitting === false));
    }
    for (const window of current) {
      const context = host.contextFor(window);
      assert.equal(context.quitting, false);
      assert.equal(context.autoOpen, false);
      assert.ok(window.projectContexts.some(value => value.quitting));
      assert.equal(window.projectContexts.at(-1)?.quitting, false);
      const capabilities = await f.r.ipcHandlers!.get(PROJECT_ENTRY_DESKTOP_CHANNEL)!({
        sender: window.webContents, senderFrame: window.webContents.mainFrame,
      }, {action: 'capabilities'}) as {ok: boolean; data?: {ready: boolean}};
      assert.equal(capabilities.ok, true);
      assert.equal(capabilities.data?.ready, true);
    }
    assert.equal(f.fatals().length, 0);
  });
}

test('011 restart cancelled by an editor close leaves the original backend running', async t => {
  const f = await harness(t, {
    disposition: index => index === 1 ? 'dirty' : 'clean',
    dialog: value => ({response: value.title === '尚有未保存的修改' ? 1 : 0}),
  });
  await f.initial();
  const {editor} = await openOwnedEditor(f);
  assert.equal(await f.restart(), false);
  assert.equal(editor.destroyed, false);
  assert.equal(f.r.backends.length, 1);
  assert.equal(f.r.children[0].messages.includes('stop'), false);
  assert.equal(f.r.windows.filter(window => !window.destroyed && window !== editor).length, 0);
});

test('011 restart failing before the new service is ready leaves no replacement editor', async t => {
  const f = await harness(t, {
    cookie: index => { if (index === 1) throw failure('SYNTHETIC_COOKIE_FAILURE'); },
    projectControl: (index, port) => index === 0 ? port : {
      ...port, prepareAcquire: () => assert.fail('A failed backend must never start window restoration'),
    },
  });
  await f.initial();
  const {launcher, editor} = await openOwnedEditor(f);
  await f.restart();
  await until(() => f.fatals().length === 1);
  assert.ok([launcher, editor].every(window => window.closedDelivered));
  assert.deepEqual(f.r.windows, [launcher, editor]);
});

test('011 restart superseded by Quit releases a pending project acquisition without an editor', async t => {
  const gate = deferred(), released: string[] = [];
  let candidate = '';
  const f = await harness(t, {
    release: () => gate.resolve(),
    projectControl: (index, port) => index === 0 ? port : {
      ...port,
      acquire: async input => {candidate = input.windowId; await gate.promise; return port.acquire(input);},
      release: input => {released.push(input.windowId); return port.release(input);},
    },
  });
  await f.initial();
  await openOwnedEditor(f);
  const restarting = f.restart();
  await until(() => candidate !== '');
  f.app.quit();
  assert.equal(f.get('quitRouter.isPending'), true);
  gate.resolve();
  await restarting;
  await until(() => f.r.finished === 1);
  assert.ok(released.includes(candidate));
  assert.equal(f.r.windows.length, 3, 'Only the fresh launcher was constructed');
  assert.ok(f.r.windows.every(window => window.closedDelivered));
  assert.equal(f.fatals().length, 0);
});

function publishMenuState(f: Awaited<ReturnType<typeof harness>>, window: (typeof f.r.windows)[number], patch: Partial<MenuCommandState> = {}) {
  const state: MenuCommandState = {version: 1, reportVersion: 1, editingContext: 'timeline', workspaceMode: 'editing',
    assetsVisible: true, inspectorVisible: true, timelineVisible: true,
    commands: Object.fromEntries(MENU_COMMAND_IDS.map(command => [command, true])) as Record<MenuCommandId, boolean>, ...patch};
  const document = f.get('windowHost').contextFor(window);
  assert.equal(f.r.ipcHandlers!.get(MENU_COMMAND_CHANNEL)!({sender: window.webContents, senderFrame: window.webContents.mainFrame},
    {action: 'publish', contextId: document.contextId, state}), true);
  return state;
}

test('actual application menu sends business commands only to the focused exact reported document', async t => {
  let focused: DesktopHarnessWindow | null = null;
  const f = await harness(t, {focusedWindow: () => focused}); await f.initial();
  const {launcher, editor} = await openOwnedEditor(f); focused = editor; editor.emit('focus');
  publishMenuState(f, editor); assert.equal(f.menu('command-clip-split').enabled, true);
  const callback = f.menu('command-clip-split').click!; callback();
  assert.equal(editor.menuPackets.length, 1); assert.equal(editor.menuPackets[0].value.command, 'clip-split');
  assert.equal(editor.menuPackets[0].value.contextId, f.get('windowHost').contextFor(editor).contextId);
  assert.equal(launcher.menuPackets.length, 0);
  focused = launcher; launcher.emit('focus'); callback();
  assert.equal(editor.menuPackets.length, 1, 'An unreported focused document cannot borrow the other window\'s enabled state');
  assert.equal(launcher.menuPackets.length, 0);
  assert.throws(() => f.r.ipcHandlers!.get(MENU_COMMAND_CHANNEL)!({sender: editor.webContents, senderFrame: {}},
    {action: 'publish', contextId: f.get('windowHost').contextFor(editor).contextId, state: {...publishMenuState(f, editor, {reportVersion: 2}), reportVersion: 3}}));
});

test('native import executes the fixed gesture script once on its captured frame without a second IPC dispatch', async t => {
  const f = await harness(t); await f.initial(); const {launcher, editor} = await openOwnedEditor(f);
  await editor.bindMenuGesture(); publishMenuState(f, editor);
  const frame = editor.webContents.mainFrame;
  f.menu('command-import-media').click!(); await tick();
  assert.equal(editor.gestureCalls.length, 1); assert.equal(editor.gestureCalls[0].frame, frame);
  assert.equal(editor.gestureCalls[0].userGesture, true);
  assert.equal(editor.gestureInputs.length, 1); assert.equal(editor.gestureInputs[0].command, 'import-media');
  assert.equal(editor.gestureInputs[0].contextId, f.get('windowHost').contextFor(editor).contextId);
  assert.equal(editor.gestureInputs[0].reportVersion, 1);
  assert.equal(editor.gestureCalls[0].script, menuCommandGestureScript(editor.gestureInputs[0]));
  assert.equal(editor.menuPackets.length, 0, 'An import gesture must never also be sent through the ordinary IPC path');
  assert.equal(launcher.gestureCalls.length, 0); assert.equal(launcher.menuPackets.length, 0);
  // This uses the real restricted preload receiver, not a native chooser.
  // Browser transient activation and the OS file picker require native QA.
});

test('uncertain import gesture execution and changed owners never fall back or retry', async t => {
  for (const mode of ['reject', 'throw', 'owner', 'frame'] as const) {
    const gate = deferred();
    const f = await harness(t, {release: () => gate.resolve(), menuFrameExecute: () => {
      if (mode === 'throw') throw Error('synthetic synchronous gesture failure');
      if (mode === 'reject') return Promise.reject(Error('synthetic lost gesture acknowledgement'));
      return gate.promise;
    }});
    await f.initial(); const {launcher, editor} = await openOwnedEditor(f); await editor.bindMenuGesture(); publishMenuState(f, editor);
    const frame = editor.webContents.mainFrame, callback = f.menu('command-import-media').click!;
    callback(); assert.equal(editor.gestureCalls.length, 1); assert.equal(editor.gestureCalls[0].frame, frame);
    if (mode === 'owner') editor.destroy();
    if (mode === 'frame') { await editor.loadURL(editor.urls.at(-1)!); assert.notEqual(editor.webContents.mainFrame, frame); }
    if (mode === 'owner' || mode === 'frame') {
      gate.reject(Error('synthetic original frame delivery lost')); callback();
    }
    await tick(); await tick();
    assert.equal(editor.gestureCalls.length, 1, mode); assert.equal(editor.gestureInputs.length, 0, mode);
    assert.equal(editor.menuPackets.length, 0, mode); assert.equal(launcher.menuPackets.length, 0, mode);
    assert.equal(launcher.gestureCalls.length, 0, mode); assert.equal(f.fatals().length, 0, mode);
  }
});

test('a retained application menu callback cannot borrow a report across a same-URL document replacement', async t => {
  const f = await harness(t); await f.initial(); const {editor} = await openOwnedEditor(f);
  publishMenuState(f, editor); const callback = f.menu('command-export').click!;
  const contextId = f.get('windowHost').contextFor(editor).contextId, oldFrame = editor.webContents.mainFrame;
  await editor.loadURL(editor.urls.at(-1)!);
  assert.notEqual(f.get('windowHost').contextFor(editor).contextId, contextId);
  assert.equal(f.get('menuCommands').stateFor(editor.webContents), null);
  callback(); f.get('executeMenuCommand')('export'); assert.equal(editor.menuPackets.length, 0);
  assert.throws(() => f.r.ipcHandlers!.get(MENU_COMMAND_CHANNEL)!({sender: editor.webContents, senderFrame: oldFrame},
    {action: 'publish', contextId, state: {version: 1}}));
});

test('actual native dialog disables menu business actions and restart, including retained callbacks', async t => {
  const gate = deferred(); const f = await harness(t, {dialog: () => gate.promise, release: () => gate.resolve({response: 1})});
  await f.initial(); const {editor} = await openOwnedEditor(f); publishMenuState(f, editor);
  const callback = f.menu('command-clip-split').click!, restart = f.menu('app-restart').click!, windows = f.r.windows.length;
  const show = f.get('showOwnedDialog')(editor, f.get('windowContext'), {type: 'question', message: 'synthetic pending owner', cancelId: 1});
  assert.equal(f.menu('command-clip-split').enabled, false); assert.equal(f.menu('app-restart').enabled, false);
  assert.equal(f.menu('app-settings').enabled, false); assert.equal(f.menu('app-new-project').enabled, false);
  callback(); restart(); f.get('executeMenuCommand')('clip-split'); await tick();
  assert.equal(editor.menuPackets.length, 0); assert.equal(f.r.windows.length, windows); assert.equal(f.r.backends.length, 1);
  assert.equal(f.get('restartCoordinator.state'), 'idle'); gate.resolve({response: 1}); await show;
  assert.equal(f.menu('command-clip-split').enabled, true); callback(); assert.equal(editor.menuPackets.length, 1);
});

test('settings ownership, hidden native windows and pending reload cannot execute menu business actions', async t => {
  let focused: DesktopHarnessWindow | null = null;
  const drain = deferred(), f = await harness(t, {focusedWindow: () => focused, flush: index => index === 1 ? drain.promise : true, release: () => drain.resolve(true)});
  await f.initial(); const {launcher, editor} = await openOwnedEditor(f); focused = editor; editor.emit('focus'); publishMenuState(f, editor);
  const callback = f.menu('command-clip-split').click!, host = f.get('windowHost');
  assert.equal(host.showSettings('general', editor), true); const settings = f.r.windows.at(-1)!; await host.loadFor(settings);
  const origin = f.r.backends[0].origin, settingsUrl = `${origin}/settings.html`;
  assert.deepEqual(launcher.urls, [`${origin}/`]);
  assert.deepEqual(editor.urls, [`${origin}/?project=${host.contextFor(editor).editorProjectId}`]);
  assert.deepEqual(settings.urls, [settingsUrl]);
  assert.equal(settings.config.parent, editor);
  assert.equal(host.contextFor(launcher).settingsModalOpen, false);
  assert.equal(host.contextFor(editor).settingsModalOpen, true);
  for (const window of [launcher, editor, settings]) {
    let blocked = false;
    window.webContents.emit('will-navigate', {url: settingsUrl, preventDefault() { blocked = true; }});
    assert.equal(blocked, window !== settings);
  }
  editor.emit('focus'); assert.equal(f.menu('command-clip-split').enabled, false); callback();
  focused = settings; settings.emit('ready-to-show'); settings.emit('focus'); publishMenuState(f, settings);
  assert.equal(f.menu('command-clip-split').enabled, false, 'A settings report is never a business command owner');
  callback(); f.get('executeMenuCommand')('clip-split'); assert.equal(settings.menuPackets.length, 0);
  settings.close(); await until(() => settings.destroyed); focused = editor; editor.emit('focus');
  await f.get('performTrayAction')('hide'); assert.equal(editor.visible, false); assert.equal(f.menu('command-clip-split').enabled, false);
  callback(); f.get('executeMenuCommand')('clip-split'); assert.equal(editor.menuPackets.length, 0);
  await f.get('performTrayAction')('show'); editor.emit('focus');
  const admission = f.get('windowAdmissions').get(editor); f.reload(); await until(() => editor.flushes === 1);
  assert.equal(f.menu('command-clip-split').enabled, false); callback(); f.get('executeMenuCommand')('clip-split');
  assert.equal(editor.menuPackets.length, 0); drain.resolve(true); await until(() => !admission.pending);
});

test('native undo and redo use text responders while timeline undo and redo dispatch exactly one command', async t => {
  const f = await harness(t); await f.initial(); const {editor} = await openOwnedEditor(f);
  publishMenuState(f, editor, {editingContext: 'text', commands: Object.fromEntries(MENU_COMMAND_IDS.map(command => [command, false])) as Record<MenuCommandId, boolean>});
  f.menu('command-edit-undo').click!(); f.menu('command-edit-redo').click!();
  assert.equal(editor.nativeUndos, 1); assert.equal(editor.nativeRedos, 1); assert.equal(editor.menuPackets.length, 0);
  publishMenuState(f, editor, {reportVersion: 2});
  f.menu('command-edit-undo').click!(); f.menu('command-edit-redo').click!();
  assert.equal(editor.nativeUndos, 1); assert.equal(editor.nativeRedos, 1);
  assert.deepEqual(editor.menuPackets.map(packet => packet.value.command), ['edit-undo', 'edit-redo']);
  assert.notEqual(editor.menuPackets[0].value.sequence, editor.menuPackets[1].value.sequence);
  publishMenuState(f, editor, {reportVersion: 3, editingContext: 'text'});
  await f.get('performTrayAction')('hide'); f.get('executeMenuCommand')('edit-undo');
  assert.equal(f.menu('command-edit-undo').enabled, false); assert.equal(editor.nativeUndos, 1, 'A stale focused handle cannot edit a hidden text responder');
});

test('the actual Settings menu opens general and the Shortcuts menu reuses its modal owner', async t => {
  const f = await harness(t); await f.initial(); const parent = f.r.windows[0], host = f.get('windowHost');
  await f.menu('app-settings').click!(); const settings = f.r.windows.at(-1)!; await host.loadFor(settings);
  assert.equal(settings.config.parent, parent); assert.equal(host.contextFor(settings).settingsSlot, 'general');
  await f.menu('app-shortcuts').click!(); assert.equal(f.r.windows.length, 2);
  assert.equal(host.contextFor(settings).settingsSlot, 'shortcuts'); assert.equal(settings.config.parent, parent);
});

test('a newer Shortcuts menu intent supersedes an unfinished General settings intent', async t => {
  const load = deferred(), f = await harness(t, {load: index => index === 1 ? load.promise : undefined, release: () => load.resolve()});
  await f.initial(); f.r.windows[0].close(); await until(() => f.r.windows[0].destroyed);
  const general = f.menu('app-settings').click!(); await until(() => f.r.windows.length === 2);
  const shortcuts = f.menu('app-shortcuts').click!(); assert.notEqual(general, shortcuts);
  load.resolve(); await Promise.all([general, shortcuts]);
  const host = f.get('windowHost'), settings = f.r.windows.at(-1)!; await host.loadFor(settings);
  assert.equal(f.r.windows.length, 3); assert.equal(settings.config.parent, f.r.windows[1]);
  assert.equal(host.contextFor(settings).settingsSlot, 'shortcuts');
});

test('the native window list follows committed titles and a closed window callback cannot revive its owner', async t => {
  const f = await harness(t); await f.initial(); const {editor} = await openOwnedEditor(f), host = f.get('windowHost');
  const id = `project-window-${host.contextFor(editor).windowId}`;
  assert.equal(f.menu('window-projects').submenu!.filter(item => item.id?.startsWith('project-window-')).length, 1);
  // Electron announces the page title before its default native title update.
  editor.webContents.emit('page-title-updated'); editor.config.title = 'Updated\u0000 project'; await tick();
  assert.equal(f.menu(id).label, 'Updated  project'); const callback = f.menu(id).click!, windows = f.r.windows.length;
  editor.close(); await until(() => editor.destroyed); const focuses = editor.focuses;
  callback(); await tick(); assert.equal(editor.focuses, focuses); assert.equal(f.r.windows.length, windows);
  assert.equal(f.menu(id), null);
});

test('actual main retains one application tray across backend restart and destroys it only after successful Quit', async t => {
  const f = await harness(t); await f.initial();
  const tray = f.nativeTray.trays[0];
  assert.equal(f.nativeTray.trays.length, 1); assert.equal(tray.image.template, true);
  assert.deepEqual(f.nativeTray.paths, ['/synthetic/app/icons/tray/trayTemplate.png']);
  await f.restart();
  assert.equal(f.r.backends.length, 2); assert.equal(f.nativeTray.trays.length, 1); assert.equal(tray.destroys, 0);
  tray.menu.at(-1)!.click!(); await until(() => f.r.finished === 1);
  assert.equal(tray.destroys, 1); assert.equal(f.get('windowHost'), null);
});

for (const disposition of ['dirty', 'unknown']) test(`actual hidden ${disposition} editor is presented before native inspection and cancelling Quit retains tray and backend`, async t => {
  const f = await harness(t, {disposition: index => index === 1 ? disposition : 'clean', dialog: () => ({response: 1})}); await f.initial();
  const {editor} = await openOwnedEditor(f), tray = f.nativeTray.trays[0];
  await f.get('performTrayAction')('hide'); assert.equal(editor.visible, false);
  tray.menu.at(-1)!.click!(); await until(() => f.r.dialogParents.includes(editor)); await tick();
  assert.equal(editor.visible, true); assert.equal(editor.destroyed, false);
  assert.equal(tray.destroys, 0); assert.equal(f.r.children[0].messages.includes('stop'), false);
  assert.equal(f.get('quitRouter.isPending'), false);
  await f.get('performTrayAction')('hide'); assert.equal(editor.visible, false);
  await f.get('performTrayAction')('show'); assert.equal(editor.visible, true);
  assert.equal(f.r.windows.length, 2); assert.equal(f.r.drains, 0);
});

test('actual tray settings restores a trusted parent, remains a singleton and forbids hiding a modal', async t => {
  const f = await harness(t); await f.initial(); const parent = f.r.windows[0];
  await f.get('performTrayAction')('hide'); assert.equal(parent.visible, false);
  const first = f.get('performTrayAction')('settings'), duplicate = f.get('performTrayAction')('settings');
  assert.equal(first, duplicate); await first;
  const settings = f.r.windows.at(-1)!; await f.get('windowHost').loadFor(settings);
  assert.equal(parent.visible, true); assert.equal(settings.config.parent, parent);
  const windows = f.r.windows.length; await f.get('performTrayAction')('settings');
  assert.equal(f.r.windows.length, windows); assert.equal(f.get('trayCanHide')(), false);
  const hides = parent.hides; await f.get('performTrayAction')('hide'); assert.equal(parent.hides, hides);
});

for (const action of ['settings', 'new-project', 'open-project']) test(`the first zero-window tray ${action} completes after its exact assigned parent load`, async t => {
  const load = deferred();
  const f = await harness(t, {load: index => index === 1 ? load.promise : undefined, release: () => load.resolve()}); await f.initial();
  f.r.windows[0].close(); await until(() => f.r.windows[0].destroyed);
  const opening = f.get('performTrayAction')(action), parent = f.r.windows[1], host = f.get('windowHost');
  assert.ok(parent); const beforeLoad = host.contextFor(parent).contextId;
  await until(() => parent.urls.length === 1);
  assert.notEqual(host.contextFor(parent).contextId, beforeLoad, 'the initial assigned navigation rotates the empty document identity');
  assert.equal(parent.visible, false); load.resolve(); await opening;
  assert.equal(parent.visible, true);
  if (action === 'settings') {
    assert.equal(f.r.windows.length, 3, 'one initial click must attach settings after its own parent is trusted');
    const settings = f.r.windows[2]; await host.loadFor(settings);
    assert.equal(settings.config.parent, parent); assert.equal(host.contextFor(parent).settingsModalOpen, true);
  } else {
    assert.equal(f.r.windows.length, 2);
    assert.equal(host.contextFor(parent).entryMode, action === 'new-project' ? 'new' : 'open');
    assert.equal(host.contextFor(parent).entryVersion, 1);
  }
});

test('a second same-URL navigation cannot borrow the first zero-window tray Settings intent', async t => {
  const load = deferred();
  const f = await harness(t, {load: index => index === 1 ? load.promise : undefined, release: () => load.resolve()}); await f.initial();
  f.r.windows[0].close(); await until(() => f.r.windows[0].destroyed);
  const opening = f.get('performTrayAction')('settings'), parent = f.r.windows[1], host = f.get('windowHost');
  await until(() => parent.urls.length === 1);
  const initial = host.contextFor(parent).contextId, replacement = parent.loadURL(parent.urls[0]);
  assert.notEqual(host.contextFor(parent).contextId, initial); load.resolve(); await Promise.all([opening, replacement]);
  assert.equal(f.r.windows.length, 2); assert.equal(host.contextFor(parent).settingsModalOpen, false);
});

test('a fresh Settings after Hide supersedes the cancelled loading intent without duplicating windows', async t => {
  const load = deferred(); const f = await harness(t, {load: index => index === 1 ? load.promise : undefined, release: () => load.resolve()}); await f.initial();
  f.r.windows[0].close(); await until(() => f.r.windows[0].destroyed);
  const old = f.get('performTrayAction')('settings'); await until(() => f.r.windows.length === 2);
  await f.get('performTrayAction')('hide');
  const fresh = f.get('performTrayAction')('settings'); assert.notEqual(fresh, old);
  load.resolve(); await Promise.all([old, fresh]);
  assert.equal(f.r.windows.length, 3); assert.equal(f.r.windows[2].config.parent, f.r.windows[1]);
});

test('a newer native project-entry intent prevents a late tray Settings sheet', async t => {
  const load = deferred(); const f = await harness(t, {load: index => index === 1 ? load.promise : undefined, release: () => load.resolve()}); await f.initial();
  f.r.windows[0].close(); await until(() => f.r.windows[0].destroyed);
  const opening = f.get('performTrayAction')('settings'); await until(() => f.r.windows.length === 2);
  f.newProject(); load.resolve(); await opening;
  assert.equal(f.r.windows.length, 2); assert.equal(f.get('windowHost').contextFor(f.r.windows[1]).entryMode, 'new');
});

test('Quit during a tray parent load cannot revive its window or attach a settings sheet on late completion', async t => {
  const load = deferred(); const f = await harness(t, {load: index => index === 1 ? load.promise : undefined, release: () => load.resolve()}); await f.initial();
  f.r.windows[0].close(); await until(() => f.r.windows[0].destroyed);
  const opening = f.get('performTrayAction')('settings'); await until(() => f.r.windows.length === 2);
  f.nativeTray.trays[0].menu.at(-1)!.click!(); await until(() => f.r.finished === 1);
  load.resolve(); await opening; assert.equal(f.r.windows.length, 2); assert.equal(f.r.windows[1].destroyed, true);
  assert.equal(f.nativeTray.trays[0].destroys, 1); assert.deepEqual(f.fatals(), []);
});

test('overlapping native dialogs retain the hide guard until both exact tokens settle', async t => {
  const first = deferred(), second = deferred(); let calls = 0;
  const f = await harness(t, {dialog: () => (++calls === 1 ? first : second).promise}); await f.initial();
  const parent = f.r.windows[0], context = f.get('windowContext'), show = f.get('showOwnedDialog');
  const one = show(parent, context, {title: 'synthetic one', cancelId: 1}), two = show(parent, context, {title: 'synthetic two', cancelId: 1});
  assert.equal(f.get('trayCanHide')(), false); first.resolve({response: 1}); await one;
  assert.equal(f.get('trayCanHide')(), false); second.resolve({response: 1}); await two;
  assert.equal(f.get('trayCanHide')(), true);
});

for (const kind of ['renderer-recovery', 'blocked-leave'] as const) test(`an active ${kind} native dialog denies tray entry actions and Show restores its exact owner`, async t => {
  const response = deferred(), title = kind === 'renderer-recovery' ? '界面需要重新载入' : '暂时无法安全离开';
  const f = await harness(t, {disposition: index => kind === 'blocked-leave' && index === 1 ? 'blocked' : 'clean',
    dialog: value => value.title === title ? response.promise : {response: 0}, release: () => response.resolve({response: 2})});
  await f.initial(); const {editor} = await openOwnedEditor(f), host = f.get('windowHost');
  const {editor: other} = await openOwnedEditor(f, '79000000-0000-4000-8000-000000000002', editor);
  const tray = f.nativeTray.trays[0], staleMenu = tray.menu;
  if (kind === 'renderer-recovery') editor.webContents.emit('unresponsive'); else editor.close();
  await until(() => f.r.dialogs.some(item => item.title === title));
  assert.equal(tray.menu[0].enabled, true);
  for (const index of [3, 4, 5]) assert.equal(tray.menu[index].enabled, false);
  const windows = f.r.windows.length, before = f.r.windows.map(window => host.contextFor(window).entryVersion);
  for (const index of [3, 4, 5]) staleMenu[index].click!();
  for (const action of ['new-project', 'open-project', 'settings']) await f.get('performTrayAction')(action);
  assert.equal(f.r.windows.length, windows); assert.deepEqual(f.r.windows.map(window => host.contextFor(window).entryVersion), before);
  const focused = editor.focuses, otherFocused = other.focuses;
  await f.get('performTrayAction')('show');
  assert.equal(editor.focuses > focused, true); assert.equal(other.focuses, otherFocused);
  assert.equal(f.r.windows.length, windows); assert.equal(f.get('nativeDialogs').size, 1);
  response.resolve({response: kind === 'renderer-recovery' ? 2 : 0});
  await until(() => f.get('nativeDialogs').size === 0);
});

test('a native dialog beginning and ending during parent load revokes an older tray Settings intent', async t => {
  const load = deferred(), response = deferred();
  const f = await harness(t, {load: index => index === 1 ? load.promise : undefined,
    dialog: value => value.title === 'synthetic native recovery' ? response.promise : {response: 0},
    release: () => {load.resolve(); response.resolve({response: 1});}}); await f.initial();
  f.r.windows[0].close(); await until(() => f.r.windows[0].destroyed);
  const opening = f.get('performTrayAction')('settings'), parent = f.r.windows[1], host = f.get('windowHost');
  await until(() => parent.urls.length === 1);
  const notice = f.get('showOwnedDialog')(parent, f.get('windowContext'), {title: 'synthetic native recovery', cancelId: 1});
  assert.equal(f.get('nativeDialogs').size, 1); response.resolve({response: 1}); await notice;
  assert.equal(f.get('nativeDialogs').size, 0); load.resolve(); await opening;
  assert.equal(f.r.windows.length, 2); assert.equal(host.contextFor(parent).settingsModalOpen, false);
});

test('native reload inspection cannot be hidden while its original preference drain is pending', async t => {
  const drain = deferred(); const f = await harness(t, {flush: () => drain.promise, release: () => drain.resolve(true)}); await f.initial();
  f.reload(); await until(() => f.r.windows[0].flushes === 1);
  assert.equal(f.get('trayCanHide')(), false); const hides = f.r.windows[0].hides;
  await f.get('performTrayAction')('hide'); assert.equal(f.r.windows[0].hides, hides);
  drain.resolve(true); await until(() => !f.get('windowAdmissions').get(f.r.windows[0]).pending);
  assert.equal(f.get('trayCanHide')(), true);
});

test('loss of the actual tray restores the retained UI and cannot hide it again', async t => {
  const f = await harness(t); await f.initial(); const parent = f.r.windows[0];
  await f.get('performTrayAction')('hide'); assert.equal(parent.visible, false);
  f.nativeTray.trays[0].destroy(); f.get('trayHost').refresh(); assert.equal(parent.visible, true);
  const hides = parent.hides; await f.get('performTrayAction')('hide'); assert.equal(parent.hides, hides);
});

test('actual main creates a parent-bound settings modal and blocks parent close/reload without spending admission', async t => {
  const f = await harness(t, {dialog: () => ({response: 1})}); await f.initial();
  const parent = f.r.windows[0], host = f.get('windowHost');
  assert.equal(host.showSettings('agent', parent), true);
  const settings = f.r.windows.at(-1)!; await host.loadFor(settings);
  const origin = f.r.backends[0].origin, settingsUrl = `${origin}/settings.html`;
  assert.deepEqual(parent.urls, [`${origin}/`]);
  assert.deepEqual(settings.urls, [settingsUrl]);
  const firstSettingsFrame = settings.webContents.mainFrame;
  const firstSettingsContext = f.r.bridge!({sender: settings.webContents, senderFrame: firstSettingsFrame}, {action: 'describe'}) as ProjectWindowContext;
  assert.equal(firstSettingsContext.role, 'settings');
  assert.equal(firstSettingsContext.settingsSlot, 'agent');
  assert.equal(firstSettingsContext.editorProjectId, null);
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
  assert.equal(await f.get('windowAdmissions').get(settings).requestReload(), true);
  assert.deepEqual(settings.urls, [settingsUrl, settingsUrl]);
  assert.deepEqual(f.r.nativeChecks.slice(checks), [settings]);
  assert.equal(host.contextFor(parent).settingsModalOpen, true);
  assert.throws(() => f.r.bridge!({sender: settings.webContents, senderFrame: firstSettingsFrame}, {action: 'describe'}), /sender/);
  const reloadedContext = f.r.bridge!({sender: settings.webContents, senderFrame: settings.webContents.mainFrame}, {action: 'describe'}) as ProjectWindowContext;
  assert.equal(reloadedContext.role, 'settings');
  assert.equal(reloadedContext.windowId, firstSettingsContext.windowId);
  assert.notEqual(reloadedContext.contextId, firstSettingsContext.contextId);
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
