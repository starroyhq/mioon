import { createDesktopLutRecoveryHost } from './lut-recovery-host.ts';
import { createDesktopLutRecoveryStore } from './lut-recovery-store.ts';
import { CLIP_LUT_RECOVERY_CHANNEL } from '../../../packages/contracts/src/clip-lut-recovery.ts';
import { calculateWorkspaceScope } from '../../../packages/contracts/src/workspace-scope.ts';
import { ensurePrivateDirectory, validatePrivateDirectory, validateManagedFile, readPrivateFile, removePrivateFile, writePrivateFileAtomic } from '@mioon/contracts/private-storage';
import type {ReadPrivateFileOptions} from '@mioon/contracts/private-storage';
import { createAppLanguageHost } from './app-language-host.ts';
import { APP_LANGUAGE_CHANNEL } from '../../../packages/i18n/src/preference.ts';
import { resolveLocale } from '../../../packages/i18n/src/locale.ts';
import { nativeText as nt, setNativeLanguageReader } from './app-language-text.ts';
import { app, BrowserWindow, Menu, session, dialog, utilityProcess, safeStorage, ipcMain, shell, nativeTheme } from 'electron';
import type {IpcMainInvokeEvent, MenuItemConstructorOptions, Session, WebContents} from 'electron';
import {createWorkspaceToolsHost} from './workspace-tools-host.ts';
import {WORKSPACE_TOOLS_CHANNEL,workspaceInfoSchema} from '../../../packages/contracts/src/workspace-info.ts';
import {workspaceSettingsSchema} from '../../../packages/contracts/src/workspace-configuration.ts';
import {WORKSPACE_NATIVE_CHANNEL} from '../../../packages/contracts/src/workspace-native.ts';
import {createWorkspaceNativeHost,readNativeBackendMetadata} from './workspace-native-host.ts';
import {createProjectFileOpener,uploadProjectFile,projectFileArguments} from './project-file-open.ts';
import {inspectMediaTools} from '../../../packages/business/src/media-tool-diagnostics.ts';
import {run as runMedia} from '@mioon/business/media-runtime';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { prepareDesktopStorage, readAppLanguagePreference, writeAppLanguagePreference, showStorageStartupFailure, storageFailureDialog, ensureDataIdentity, readToolConfig, validateTools, saveToolConfig, utilityEnvironment, writeConnection, removeConnectionOnShutdown } from './config.ts';
import type {DesktopIdentity, DesktopPaths, ToolPaths, ToolValidation} from './config.ts';
import desktopIdentity from '../identity.ts';
import { BackendSupervisor } from './supervisor.ts';
import type {BackendReady, BackendRuntime} from './supervisor.ts';
import { stopBackendForQuit } from './shutdown.ts';
import { createDesktopStartup } from './startup.ts';
import { createDesktopAgentSettings } from './secret-store.ts';
import type {DesktopAgentSettings} from './secret-store.ts';
import { createDesktopImageSecretCodec } from './image-secret-store.ts';
import { createDesktopVideoSecretCodec } from './video-secret-store.ts';
import { createProjectWindowHost } from './project-window-host.ts';
import type {ProjectWindowFrame, ProjectWindowOwner, ProjectWindowWebContents} from './project-window-host.ts';
import { createNativeAudioPreviewHost, createNativeAudioPreviewSigningIdentity } from './native-audio-preview-host.ts';
import { NATIVE_AUDIO_CHANNEL } from './native-audio-preview-protocol.ts';
import { consumeNativeProjectEntry } from './project-entry-admission.ts';
import { observeInitialProjectLoad, createProjectRendererRecovery, createProjectBackendIncident } from './project-window-recovery.ts';
import { MultiWindowQuitCoordinator, MultiWindowRestartCoordinator, createProjectWindowQuitRouter } from './project-window-quit.ts';
import type {ProjectWindowQuitRouter} from './project-window-quit.ts';
import { confirmOwnedWindowRestart } from './project-window-confirmation.ts';
import { PROJECT_WINDOW_CHANNEL } from './project-window-protocol.ts';
import { installNativeCloseAdmission } from './native-close.ts';
import { secureWebPreferences, sessionCookie, installSessionPolicy, installWindowPolicy, isAllowedNavigation } from './security.ts';
import { createRendererDiagnostics, installRendererHealthDiagnostics } from './renderer-diagnostics.ts';
import type { RendererHealthContents } from './renderer-diagnostics.ts';
import { windowChromeOptions } from './window-chrome.ts';
import { settingsWindowOptions } from './settings-window.ts';
import { createDesktopWindowAppearance } from './window-appearance.ts';
import type {DesktopStartReport} from './smoke-checks.ts';

type DesktopStartup = ReturnType<typeof createDesktopStartup>;
type ProjectWindowHost = ReturnType<typeof createProjectWindowHost<BrowserWindow>>;
type DesktopAppearance = ReturnType<typeof createDesktopWindowAppearance<BrowserWindow>>;
type NativeAudioHost = ReturnType<typeof createNativeAudioPreviewHost>;
type LutRecoveryHost = ReturnType<typeof createDesktopLutRecoveryHost<IpcMainInvokeEvent>>;
type LanguageHost = ReturnType<typeof createAppLanguageHost>;
type WorkspaceToolsHost = ReturnType<typeof createWorkspaceToolsHost<IpcMainInvokeEvent>>;
type WorkspaceNativeHost = ReturnType<typeof createWorkspaceNativeHost<IpcMainInvokeEvent>>;
type NativeCloseAdmission = ReturnType<typeof installNativeCloseAdmission>;
type BackendIncident = ReturnType<typeof createProjectBackendIncident>;
type InitialWindowLoad = ReturnType<typeof observeInitialProjectLoad>;
interface DesktopWindowContext {
  readonly startup: DesktopStartup;
  readonly ready: BackendReady;
  readonly session: Session;
  readonly incident: BackendIncident;
  /** Assigned immediately after construction; every reader runs after wiring. */
  appearance: DesktopAppearance;
  audioHost?: NativeAudioHost;
}
interface CodedFailure {
  readonly code?: string;
  readonly reason?: string;
  readonly message?: string;
}
function codedFailure(error: unknown): CodedFailure {
  return error !== null && typeof error === 'object' ? error as CodedFailure : {};
}
function errorCode(error: unknown): string | undefined {
  return codedFailure(error).code;
}
function errorMessage(error: unknown): string {
  const message = codedFailure(error).message ?? error;
  return typeof message === 'string' ? message : 'Unknown error';
}
/** Read-only storage reads never request text; the appearance/LUT stores take bytes. */
function storageRead(file: string, options: ReadPrivateFileOptions): Buffer | null {
  const value = readPrivateFile(file, options);
  return typeof value === 'string' ? Buffer.from(value) : value;
}
/** The build-injected channel moves windows between launcher/editor projects only. */
function requestApplicationQuit(source: BrowserWindow | undefined): Promise<boolean | void> {
  // A confirmed-gone recovery permit belongs to its exact source and current
  // stack. Never move that permit to a settings child or wait and reuse it.
  const settings = source ? windowHost?.settingsForParent(source) : null;
  if (settings) { if (!settings.isDestroyed()) settings.focus(); return Promise.resolve(false); }
  return quitRouter.request(source).catch(quitFailed);
}

// The renderer never receives privileged Electron APIs or native filesystem paths.
app.enableSandbox();
// Embedded by build.ts. Runtime env and app.isPackaged cannot change the channel.
const identity: DesktopIdentity = desktopIdentity.identityForChannel(__MIOON_DESKTOP_CHANNEL__);
app.setName(identity.productName);
app.setAppUserModelId(identity.appId);
if (process.platform === 'linux') {
  app.setDesktopName(`${identity.appId}.desktop`);
  app.commandLine.appendSwitch('class', identity.appId);
}
let languageHost: LanguageHost | null = null;
const systemLanguages = (): readonly string[] => { try { return app.getPreferredSystemLanguages(); } catch { return [process.env.LC_ALL || process.env.LANG || 'en']; } };
setNativeLanguageReader(() => languageHost?.snapshot().locale ?? resolveLocale('system', systemLanguages()));
let paths!: DesktopPaths;
let startupStorageError: unknown;
try { paths = prepareDesktopStorage(app, process.env.MIOON_DESKTOP_USER_DATA, identity.channel); }
catch (error) { startupStorageError = error; }
// Renderer health evidence for issue #4: bounded local records for unresponsive,
// responsive and render-process-gone transitions. The factory is feature-detected
// because VM lifecycle harnesses execute this module with imports stripped; a
// missing factory is treated as diagnostics being unavailable and never changes
// recovery behavior. All writes are best-effort and never throw into Electron.
const rendererDiagnostics = !startupStorageError && typeof createRendererDiagnostics === 'function'
  ? (() => {
      try {
        return createRendererDiagnostics({ dataDir: paths.dataDir, modulePath: path.join(app.getAppPath(), 'package.json'),
          directoryPolicy: { ensurePrivateDirectory, validatePrivateDirectory } });
      } catch { return null; }
    })()
  : null;
let win: BrowserWindow | null = null, backend: BackendSupervisor | null = null, activeSession: Session | null = null, ready: BackendReady | null = null, restarting = false, quitting = false;
let agentSettings: DesktopAgentSettings | null = null;
let startupOperation: DesktopStartup | null = null;
let windowContext: DesktopWindowContext | null | undefined, windowHost: ProjectWindowHost | null | undefined, nativeAudioHost: NativeAudioHost | null | undefined, lutRecoveryHost: LutRecoveryHost | null | undefined;
let workspaceToolsHost: WorkspaceToolsHost | null = null;
let workspaceNativeHost:WorkspaceNativeHost|null=null;
const projectFileFailureText={PROJECT_PACKAGE_NOT_MIOON:'native.openProjectFileNotMioon',PROJECT_PACKAGE_NEWER_FORMAT:'native.openProjectFileNewer',PROJECT_PACKAGE_CORRUPT:'native.openProjectFileDamaged',UNAVAILABLE:'native.openProjectFileUnavailable'} as const;
// Project files opened from the OS wait here until a backend runs; a window then shows the staged preview.
const projectFiles=createProjectFileOpener({
  opened:()=>{if(quitCoordinator.state==='idle'&&!restarting)windowHost?.activate(BrowserWindow.getFocusedWindow());},
  failed:(file,code)=>{
    const options={type:'warning' as const,message:nt('native.openProjectFileFailed'),detail:nt(projectFileFailureText[code],{name:path.basename(file)}),buttons:[nt('native.acknowledge')]};
    if(quitCoordinator.state==='idle'&&!restarting)windowHost?.activate(BrowserWindow.getFocusedWindow());
    // A window-less box runs a modal loop on macOS that stalls the main process
    // long enough for the backend lease to expire, so it is shown as a sheet.
    // A window may still be appearing after activate(); wait briefly for one.
    const show=(attempt:number)=>{
      const parent=BrowserWindow.getFocusedWindow()??BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&window.isVisible());
      if(parent){void dialog.showMessageBox(parent,options);return;}
      if(attempt<20){setTimeout(()=>show(attempt+1),250);return;}
      if(process.platform!=='darwin')void dialog.showMessageBox(options);
    };
    show(0);
  },
});
const windowAdmissions = new WeakMap<BrowserWindow, NativeCloseAdmission>();
const initialWindowLoads = new WeakMap<BrowserWindow, InitialWindowLoad>();
const cancelledStartupErrors = new WeakSet<Error>();
let quitFailureNotice: Promise<void> | null = null;
let smokeDiscardDecision: boolean | undefined;
const smokeOutput: string | false | undefined = !app.isPackaged && process.env.MIOON_DESKTOP_USER_DATA && process.env.MIOON_DESKTOP_SMOKE_OUTPUT;

async function toolsFromUser(startup: DesktopStartup): Promise<ToolValidation> {
  let stored: ToolPaths;
  try {
    stored = await readToolConfig(paths.configFile);
    startup.checkpoint();
    return await validateTools(stored, { signal: startup.signal });
  }
  catch (error) {
    startup.checkpoint();
    if (errorCode(error)?.startsWith('STORAGE_')) throw error;
    if (smokeOutput) throw error;
    const result = await dialog.showMessageBox({ type: 'warning', title: nt('native.toolsTitle'),
      message: nt('native.toolsMessage'),
      detail: nt('native.toolsDetail') + '\n\n' + nt('native.originalDiagnostic', { detail: errorMessage(error) }),
      buttons: [nt('native.chooseTools'), nt('native.quit')], defaultId: 0, cancelId: 1 });
    startup.checkpoint();
    if (result.response !== 0) throw new Error('未配置 FFmpeg');
  }
  const choose = async (name: 'ffmpeg' | 'ffprobe'): Promise<string> => {
    const result = await dialog.showOpenDialog({ title: nt('native.chooseExecutable', { name }), buttonLabel: nt('native.chooseTools'), properties: ['openFile'] });
    startup.checkpoint();
    if (result.canceled || result.filePaths.length !== 1) throw new Error(`未选择 ${name}`);
    return result.filePaths[0];
  };
  const configuration = await validateTools({ ffmpeg: await choose('ffmpeg'), ffprobe: await choose('ffprobe') }, { signal: startup.signal });
  startup.checkpoint();
  await saveToolConfig(paths.configFile, configuration);
  return configuration;
}

function cancelledStartupError(): Error {
  // Only this exact result belongs to an explicitly cancelled start. A provider
  // or cleanup error with the same code must still reach fatal().
  const error = Object.assign(new Error('本地服务启动已取消。'), { code: 'DESKTOP_START_CANCELLED' });
  cancelledStartupErrors.add(error);
  return error;
}
function isCancelledStartup(error: unknown): boolean {
  return error !== null && typeof error === 'object' && cancelledStartupErrors.has(error as Error);
}

async function start(): Promise<DesktopStartReport> {
  if (quitting) throw cancelledStartupError();
  const startup = startupOperation = createDesktopStartup();
  let closingCancelledSettings = false;
  try {
    await ensureDataIdentity(paths, identity);
    startup.checkpoint();
    const tools = await toolsFromUser(startup);
    startup.checkpoint();
    // Main owns the single settings instance across trusted backend restarts.
    if (!agentSettings) {
      const settings = await createDesktopAgentSettings({ safeStorage, userData: app.getPath('userData'), appId: identity.appId, signal: startup.signal });
      if (startup.signal.aborted) {
        closingCancelledSettings = true;
        await settings.close();
        closingCancelledSettings = false;
        startup.checkpoint();
      }
      agentSettings = settings;
    }
    startup.checkpoint();
    const token = randomBytes(32).toString('hex');
    const backendId = randomUUID(), nativeAudioIdentity = createNativeAudioPreviewSigningIdentity(backendId);
    let ownedAudioHost: NativeAudioHost | undefined, backendExitObserved = false;
    backend = new BackendSupervisor({ fork: utilityProcess.fork,
      modulePath: path.join(app.getAppPath(), 'backend.cjs'), environment: utilityEnvironment(process.env, tools), agentSettings,
      imageSecretCodec: createDesktopImageSecretCodec({ safeStorage, appId: identity.appId }),
      videoSecretCodec: createDesktopVideoSecretCodec({ safeStorage, appId: identity.appId }) });
    const ownedBackend = backend, incident = createProjectBackendIncident();
    ownedBackend.on('exit', ({ expected }: {expected?: boolean}) => {
      backendExitObserved = true; ownedAudioHost?.notifyBackendExit();
      if (!expected) incident.fail();
      if (!expected && backend === ownedBackend && !quitting) { windowHost?.refresh(); if (windowContext?.incident === incident && !smokeOutput) void backendFailed(ownedBackend, incident); }
    });
    const started = await backend.start({ dataDir: paths.dataDir, distDir: path.join(app.getAppPath(), 'web'),
      subtitleResourcesDir:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),'subtitles'),token, nativeAudioPreview: nativeAudioIdentity.config });
    startup.checkpoint();
    incident.assertAlive();
    ready = started;
    activeSession = session.fromPartition(`${identity.appId}-${randomUUID()}`, { cache: false });
    installSessionPolicy(activeSession, started.url, contents => windowHost?.windowForContents(contents as ProjectWindowWebContents), { downloadsDirectory: app.getPath('downloads') });
    await activeSession.cookies.set(sessionCookie(started.url, token));
    startup.checkpoint();
    incident.assertAlive();
    await writeConnection(paths, { url: started.url, token, pid: started.runtime.pid, identity });
    startup.checkpoint();
    incident.assertAlive();
    // A backend handshake alone is not permission to open a window. Publish its
    // context only after this start owns a prepared session and discovery file.
    const context = windowContext = { startup, ready: started, session: activeSession, incident } as DesktopWindowContext;
    context.appearance = createDesktopWindowAppearance<BrowserWindow>({root:paths.dataDir,channel:identity.channel,nativeTheme,signal:startup.signal,
      storage:{validatePrivateDirectory,validateManagedFile,readPrivateFile: storageRead},isCurrent:()=>ownsWindowContext(context),
      getWindows:()=>windowHost?.windows()||[],ownsWindow:window=>ownsWindow(window,context)});
    windowHost = createProjectWindowHost<BrowserWindow>({
      backendId, launcherUrl: `${started.url}/`, editorUrl: (projectId: string) => `${started.url}/?project=${projectId}`,
      isCurrent: () => ownsWindowContext(context),
      canInteract: () => quitRouter.allowsWindows && !context.incident.failed,
      canRestoreParentFocus: () => BrowserWindow.getFocusedWindow() !== null,
      createWindow: creation => new BrowserWindow({ title: identity.productName, width: 1500, height: 960,
        icon: path.join(app.getAppPath(), 'icons/icon.png'),
        minWidth: 1050, minHeight: 680, backgroundColor: context.appearance.backgroundColor(), show: false,
        autoHideMenuBar: process.platform !== 'darwin', ...windowChromeOptions(),
        ...(creation.role === 'settings' ? settingsWindowOptions(creation.parent) : {}),
        webPreferences: { ...secureWebPreferences(context.session), preload: path.join(app.getAppPath(), 'preload.cjs') } }),
      prepareWindow: (window, owner) => prepareOwnedWindow(window, context, owner),
      consumeProjectEntry: consumeNativeProjectEntry,
      onDocumentInvalidated: owner => ownedAudioHost?.revokeOwner({ ...owner, projectId: owner.projectId as string }, false),
      onWebContentsDestroyed: windowId => ownedAudioHost?.revokeWindowDestroyed(windowId),
      onLoadError: (error, window) => { if (ownsWindow(window, context) && !smokeOutput) void initialWindowFailed(window, context).catch(fatal); },
    });
    ownedAudioHost = createNativeAudioPreviewHost({ backendId, origin: started.url, signer: nativeAudioIdentity,
      request: (command, onPending) => ownedBackend.requestNativeAudio(command, onPending),
      isAdmissionAllowed: () => ownsWindowContext(context) && backend === ownedBackend && quitRouter.allowsWindows && !context.incident.failed,
      isBackendExitConfirmed: () => backendExitObserved && ownedBackend.child === null && ownedBackend.stopOutcome?.exitConfirmed === true && !ownedBackend.hasUnconfirmedMedia,
      ownerForContents: contents => { const owner = windowHost?.ownerForContents(contents as unknown as ProjectWindowWebContents); return owner?.role === 'editor' ? { ...owner, projectId: owner.projectId as string, contents } : null; },
    });
    nativeAudioHost = context.audioHost = ownedAudioHost;
    // Host authority is independent of the renderer's workspace claim and of
    // localhost's random port/session partition. Pin the existing filesystem
    // fingerprint for this backend lifetime and recompute at every boundary.
    const currentLutWorkspaceScope = () => {
      if (!ownsWindowContext(context) || backend !== ownedBackend || !quitRouter.allowsWindows || context.incident.failed || backendExitObserved) throw new Error('LUT recovery owner unavailable.');
      const directory = validatePrivateDirectory(paths.dataDir);
      const db = validateManagedFile(path.join(paths.dataDir, 'workbench.sqlite'), { root: paths.dataDir });
      if (!directory || !db) throw new Error('LUT recovery workspace unavailable.');
      return calculateWorkspaceScope({ channel: identity.channel, root: paths.dataDir, directory, db });
    };
    const lutWorkspaceScope = currentLutWorkspaceScope();
    lutRecoveryHost = createDesktopLutRecoveryHost<IpcMainInvokeEvent>({
      currentWorkspaceScope: () => {
        const scope = currentLutWorkspaceScope();
        if (scope !== lutWorkspaceScope) throw new Error('LUT recovery workspace changed.');
        return scope;
      },
      ownerForEvent: event => {
        const owner = windowHost?.ownerForContents(event.sender);
        if (!owner || owner.role !== 'editor' || !owner.projectId || event.senderFrame !== owner.frame || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== owner.url) return null;
        return { projectId: owner.projectId, isCurrent: () => ownsWindowContext(context) && owner.isCurrent() &&
          event.senderFrame === owner.frame && event.senderFrame === event.sender.mainFrame && event.senderFrame?.url === owner.url };
      },
      createStore: guard => createDesktopLutRecoveryStore({ userData: paths.userData, guard, storage: {
        validatePrivateDirectory: directory => validatePrivateDirectory(directory),
        validateManagedFile: (file, options) => validateManagedFile(file, options),
        readPrivateFile: (file, options) => storageRead(file, options),
        removePrivateFile: (file, options) => removePrivateFile(file, options),
        writePrivateFileAtomic: (file, bytes, options) => writePrivateFileAtomic(file, bytes, options),
      } }),
    });

    const nativeBackendCurrent=()=>{if(!ownsWindowContext(context)||backend!==ownedBackend||ownedBackend.state!=='running'||!quitRouter.allowsWindows||context.incident.failed||backendExitObserved)throw new Error('Native workspace action is unavailable.');};
    const nativeRead=(resource:'/api/rpc'|'/api/workspace-info',input?:object)=>readNativeBackendMetadata({base:started.url,token,resource,input,signal:context.startup.signal,check:nativeBackendCurrent});
    workspaceNativeHost=createWorkspaceNativeHost<IpcMainInvokeEvent>({
      ownerForEvent:event=>{
        const owner=windowHost?.ownerForContents(event.sender),window=windowHost?.windowForContents(event.sender);
        if(!window||!owner||!owner.isCurrent()||!ownsWindow(window,context)||event.senderFrame!==window.webContents.mainFrame||event.senderFrame!==owner.frame||event.senderFrame?.url!==owner.url)return null;
        return {projectId:owner.role==='editor'?(owner.projectId??undefined):undefined,isCurrent:()=>{try{nativeBackendCurrent();return !restarting&&owner.isCurrent()&&ownsWindow(window,context)&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame===owner.frame&&event.senderFrame?.url===owner.url;}catch{return false;}}};
      },
      chooseDirectory:async()=>{const result=await dialog.showOpenDialog({title:nt('native.chooseBackupLocation'),properties:['openDirectory','createDirectory']});return result.canceled||result.filePaths.length!==1?null:result.filePaths[0];},
      setBackupDirectory:directory=>{nativeBackendCurrent();return ownedBackend.setBackupDirectory(directory);},
      readSettings:async()=>workspaceSettingsSchema.parse(await nativeRead('/api/rpc',{operation:'workspace.settings.get',input:{}})),
      readWorkspaceRoot:async()=>workspaceInfoSchema.parse(await nativeRead('/api/workspace-info')).dataDirectory,
      readExport:identity=>nativeRead('/api/rpc',{operation:'export.output.get',input:identity}),
      openPath:file=>shell.openPath(file),revealPath:file=>shell.showItemInFolder(file),restart,
      chooseSaveFile:async suggestedName=>{const result=await dialog.showSaveDialog({title:nt('native.saveProjectFile'),defaultPath:path.join(app.getPath('documents'),suggestedName),filters:[{name:nt('native.projectFileFilter'),extensions:['mioon']}],properties:['showOverwriteConfirmation','createDirectory']});return result.canceled||!result.filePath?null:result.filePath;},
      fetchProjectPackage:exportId=>{nativeBackendCurrent();return fetch(new URL(`/api/project-packages/exports/${exportId}/download`,started.url),{headers:{authorization:`Bearer ${token}`},redirect:'error',signal:context.startup.signal});},
    });
    activeSession.webRequest.onBeforeSendHeaders((details, callback) => callback(ownedAudioHost.beforeSendHeaders(details)));
    await openWindow(context);
    startup.checkpoint();
    const uploadOpened=(file:string)=>{nativeBackendCurrent();return uploadProjectFile({base:started.url,token,file,signal:context.startup.signal});};
    projectFiles.attach(uploadOpened);context.startup.signal.addEventListener('abort',()=>projectFiles.detach(uploadOpened),{once:true});
    return { identity, runtime: started.runtime, tools: tools.versions };
  } catch (error) {
    if(windowContext?.startup===startup)windowContext.appearance?.dispose();
    // stop()/quit abort this scope before draining, so an old result may arrive
    // even before its replacement starts. Never suppress a failed settings drain.
    if (startup.signal.aborted && !closingCancelledSettings) throw cancelledStartupError();
    throw error;
  }
}

function ownsWindowContext(context: DesktopWindowContext | null | undefined): boolean {
  return Boolean(context && context === windowContext && context.startup === startupOperation &&
    !context.startup.signal.aborted && context.ready === ready && context.session === activeSession && !quitting);
}

function ownsWindow(window: BrowserWindow | null | undefined, context: DesktopWindowContext | null | undefined): window is BrowserWindow {
  return Boolean(window && windowHost?.owns(window) && !window.isDestroyed() && ownsWindowContext(context));
}

async function openWindow(context = windowContext) {
  if (!ownsWindowContext(context)) return;
  const window = windowHost?.ensureLauncher();
  if (window && windowHost) {
    try { await windowHost.loadFor(window); }
    catch (error) { if (!ownsWindow(window, context) || !initialWindowLoads.get(window)?.failed) throw error; }
  }
}

function prepareOwnedWindow(window: BrowserWindow, context: DesktopWindowContext, owner: ProjectWindowOwner<BrowserWindow>): void {
  win = window;
  const contents = window.webContents;
  const refreshAppearance = () => context.appearance.refresh();
  window.on('focus', refreshAppearance);
  window.once('closed', () => window.removeListener('focus', refreshAppearance));
  const initialLoad = observeInitialProjectLoad(window, owner.url, () => ownsWindow(window, context));
  initialWindowLoads.set(window, initialLoad);
  installWindowPolicy(window, context.ready.url, { url: owner.url, isCurrent: () => owner.isCurrent() });
  windowAdmissions.set(window, installNativeCloseAdmission(window, {
    isCurrent: () => ownsWindow(window, context) && window.webContents.getURL() === owner.url && isAllowedNavigation(window.webContents.getURL(), context.ready.url),
    canAct: () => {
      const settings = windowHost?.settingsForParent(window);
      if (!settings) return true;
      if (!settings.isDestroyed()) settings.focus();
      return false;
    },
    onCloseStateChange: state => windowHost?.closeStateChanged(window, state),
    consumeInitialEmptyClose: () => initialLoad.consumeClose(),
    beforeReload: signal => {
      if (owner.role !== 'editor') return true;
      const document = windowHost?.ownerForContents(contents as ProjectWindowWebContents);
      return document?.window === window && document.backendId === owner.backendId
        ? context.audioHost?.retireOwnerForReload({ ...document, projectId: document.projectId as string, contents }, signal) ?? false : false;
    },
    confirmClose: action => Boolean(smokeOutput) || dialog.showMessageBox(window, { type: 'warning', title: nt('native.draftTitle'),
      message: nt(action === 'reload' ? 'native.draftReloadMessage' : 'native.draftQuitMessage'),
      detail: nt(action === 'reload' ? 'native.draftReloadDetail' : 'native.draftQuitDetail'),
      buttons: [action === 'reload' ? nt('native.reloadAnyway') : nt('native.quitAnyway'), nt('native.keepEditing')], defaultId: 1, cancelId: 1 }).then(({ response }) => response === 0),
    confirmUnknown: () => dialog.showMessageBox(window, { type: 'warning', title: nt('native.unknownTitle'),
      message: nt('native.unknownMessage'),
      detail: nt('native.unknownDetail'),
      buttons: [nt('native.understandClose'), nt('native.keepWindow')], defaultId: 1, cancelId: 1 }).then(({ response }) => response === 0),
    confirmDiscard: action => smokeOutput && typeof smokeDiscardDecision === 'boolean' ? smokeDiscardDecision : dialog.showMessageBox(window, { type: 'question', title: nt('native.unsavedTitle'),
      message: nt(action === 'reload' ? 'native.discardReloadMessage' : 'native.discardQuitMessage'), detail: nt(action === 'reload' ? 'native.discardReloadDetail' : 'native.discardQuitDetail'),
      buttons: [nt('native.discard'), nt('native.keepEditing')], defaultId: 1, cancelId: 1 }).then(({ response }) => response === 0),
    onBlocked: reason => smokeOutput ? undefined : dialog.showMessageBox(window, { type: 'warning', title: nt('native.leaveBlockedTitle'),
      message: reason === 'blocked' ? nt('native.leaveBlocked') : reason === 'changed' ? nt('native.leaveChanged') : nt('native.leaveUnverified'),
      detail: nt('native.leaveDetail'), buttons: [nt('native.keepEditing')], defaultId: 0, cancelId: 0 }),
    onCancel: () => { if (ownsWindow(window, context)) { quitCoordinator.cancel(window); restartCoordinator.cancel(window); } },
    requestQuit: () => ownsWindow(window, context) ? requestApplicationQuit(window) : false
  }));
  window.on('closed', () => { if (win === window) win = null; });
  const onRendererFailure = () => {
    if (ownsWindow(window, context) && !smokeOutput) void rendererFailed(window, context).catch(fatal);
  };
  window.webContents.on('render-process-gone', onRendererFailure);
  window.webContents.on('unresponsive', onRendererFailure);
  // Recording is additive: it does not replace, delay or gate the existing
  // recovery dialog/reload path above. Only fixed health fields are persisted.
  // VM lifecycle harnesses strip imports; the packaged main always has it.
  if (typeof installRendererHealthDiagnostics === 'function')
    installRendererHealthDiagnostics(window.webContents as unknown as RendererHealthContents, rendererDiagnostics);
}

async function stop() {
  const context = windowContext, audioHost = context?.audioHost;
  await audioHost?.shutdown();
  if (context && windowContext !== context) throw Object.assign(new Error('Desktop ownership changed during shutdown'), { code: 'BACKEND_STOP_FAILED' });
  if (nativeAudioHost === audioHost) nativeAudioHost = null;
  context?.appearance?.dispose();
  windowHost?.dispose(); windowHost = null;
  windowContext = null;
  await startupOperation?.abort();
  await backend?.stop();
  await cleanupStoppedBackend();
}

async function cleanupStoppedBackend() {
  await removeConnectionOnShutdown(paths);
  await activeSession?.clearStorageData();
  activeSession = null;
  ready = null;
}

async function restart(): Promise<boolean> {
  return restartCoordinator.request();
}

async function backendFailed(failedBackend: BackendSupervisor | null = backend, incident: BackendIncident | undefined = windowContext?.incident): Promise<void> {
  if (restarting || quitting || backend !== failedBackend || !incident?.claimPrompt()) return;
  const failedContext = windowContext;
  if (backend?.hasUnconfirmedMedia) return quitFailed({ code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED' });
  const { response } = await dialog.showMessageBox({ type: 'error', title: nt('native.serviceStoppedTitle'),
    message: nt('native.serviceStopped'),
    detail: nt('native.serviceStoppedDetail'),
    buttons: [nt('native.restartService'), nt('native.quit')], defaultId: 0, cancelId: 1 });
  if (backend !== failedBackend || windowContext !== failedContext || quitting) return;
  if (response === 0) { try { await restart(); } catch (error) { await fatal(error); } }
  else app.quit();
}

const rendererFailed = createProjectRendererRecovery({
  isCurrent: (window: BrowserWindow, context: DesktopWindowContext) => ownsWindow(window, context) && quitRouter.allowsWindows && !context.incident.failed,
  capture: window => windowAdmissions.get(window)?.captureRecoveryDecision(),
  prompt: window => dialog.showMessageBox(window, { type: 'warning', title: nt('native.rendererTitle'),
    message: nt('native.rendererMessage'),
    detail: nt('native.rendererDetail'),
    buttons: [nt('native.reload'), nt('native.quitApplication'), nt('native.keepWindow')], defaultId: 0, cancelId: 2 }).then(result => result.response),
});
async function initialWindowFailed(window: BrowserWindow, context: DesktopWindowContext): Promise<void> {
  const proof = initialWindowLoads.get(window)?.captureFailure();
  if (!proof) return rendererFailed(window, context, 'load-error');
  const { response } = await dialog.showMessageBox(window, { type: 'error', title: nt('native.emptyWindowTitle'),
    message: nt('native.emptyWindowMessage'), detail: nt('native.emptyWindowDetail'),
    buttons: [nt('native.retryLoad'), nt('native.closeEmpty'), nt('native.keepWindow')], defaultId: 0, cancelId: 2 });
  if (!ownsWindow(window, context) || !proof.isCurrent()) return;
  if (response === 0 && quitRouter.allowsWindows && !context.incident.failed) { try { await proof.retry(); } catch { if (ownsWindow(window, context)) await initialWindowFailed(window, context); } }
  else if (response === 1) proof.close();
}

async function fatal(error: unknown): Promise<void> {
  if (isCancelledStartup(error)) return;
  if (smokeOutput) {
    await mkdir(path.dirname(smokeOutput), { recursive: true });
    await writeFile(smokeOutput, JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2));
    process.exitCode = 1;
  } else {
    await dialog.showMessageBox(errorCode(error)?.startsWith('STORAGE_') ? storageFailureDialog(error) :
      { type: 'error', title: nt('native.cannotStartTitle'), message: nt('native.cannotStartMessage'), detail: nt('native.originalDiagnostic', { detail: errorMessage(error) }), buttons: [nt('native.quit')] });
  }
  app.quit();
}

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin') template.push({ label: identity.productName, submenu: [
    { role: 'about', label: nt('native.about') }, { type: 'separator' }, { role: 'services', label: nt('native.services') },
    { type: 'separator' }, { role: 'hide', label: nt('native.hide') }, { role: 'hideOthers', label: nt('native.hideOthers') },
    { role: 'unhide', label: nt('native.showAll') }, { type: 'separator' }, { role: 'quit', label: nt('native.quit') },
  ] });
  template.push({ label: nt('native.application'), submenu: [
    { label: nt('native.newProject'), click: () => windowHost?.requestProjectEntry('new', BrowserWindow.getFocusedWindow()) },
    { label: nt('native.openProject'), click: () => windowHost?.requestProjectEntry('open', BrowserWindow.getFocusedWindow()) },
    { label: nt('native.connections'), click: () => windowHost?.showSettings('agent', BrowserWindow.getFocusedWindow()) },
    { label: nt('native.reload'), accelerator: 'CmdOrCtrl+R', click: () => {
      const window = windowHost?.preferredWindow(BrowserWindow.getFocusedWindow());
      if (ownsWindow(window, windowContext) && windowContext && !windowContext.incident.failed) {
        if (initialWindowLoads.get(window!)?.failed) void initialWindowFailed(window!, windowContext).catch(fatal);
        else void windowAdmissions.get(window!)?.captureRecoveryDecision().reload().catch(fatal);
      }
    } },
    { label: nt('native.restartService'), click: () => confirmOwnedWindowRestart({
      getOwner: () => windowContext || startupOperation, canRequest: () => quitRouter.allowsWindows && !restarting,
      confirm: () => dialog.showMessageBox({ type: 'question', message: nt('native.restartQuestion'),
        detail: nt('native.restartDetail'),
        buttons: [nt('native.restart'), nt('native.cancel')], defaultId: 1, cancelId: 1 }).then(({ response }) => response === 0),
      restart,
    }).catch(fatal) },
    { type: 'separator' }, { role: 'quit', label: nt('native.quit') }
  ] }, { label: nt('native.edit'), submenu: [
    { role: 'undo', label: nt('native.undo') }, { role: 'redo', label: nt('native.redo') }, { type: 'separator' },
    { role: 'cut', label: nt('native.cut') }, { role: 'copy', label: nt('native.copy') }, { role: 'paste', label: nt('native.paste') },
    ...(process.platform === 'darwin' ? [{ role: 'pasteAndMatchStyle' as const, label: nt('native.pasteMatch') }] : []),
    { role: 'delete', label: nt('native.delete') }, { role: 'selectAll', label: nt('native.selectAll') },
  ] }, { label: nt('native.window'), submenu: [
    { role: 'minimize', label: nt('native.minimize') }, { role: 'zoom', label: nt('native.zoom') },
    ...(process.platform === 'darwin' ? [{ type: 'separator' as const }, { role: 'front' as const, label: nt('native.front') }] : [{ role: 'close' as const, label: nt('native.closeWindow') }]),
  ] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const quitCoordinator: MultiWindowQuitCoordinator<BrowserWindow> = new MultiWindowQuitCoordinator<BrowserWindow>({ getWindows: () => windowHost?.closeOrder() || [],
  onStateChange: () => windowHost?.refresh(),
  stop: async () => {
    quitting = true;
    windowContext?.appearance?.dispose();
    windowHost?.dispose(); windowHost = null;
    windowContext = null;
    const onUnconfirmed = () => smokeOutput ? undefined : dialog.showMessageBox({ type: 'error', title: nt('native.waitExitTitle'),
      message: nt('native.waitExitMessage'),
      detail: nt('native.waitExitDetail'),
      buttons: [nt('native.acknowledge')] });
    // Abort validation before observing backend state so late validation cannot
    // create a utility. The two owned drains proceed together inside the budget.
    const startupDrain = startupOperation?.abort({ onUnconfirmed });
    await stopBackendForQuit({ backend,
      onUnconfirmed,
      cleanup: async () => {
        await startupDrain;
        await cleanupStoppedBackend();
        await agentSettings?.close(); agentSettings = null;
      }
    });
  }, finish: () => app.quit() });

const restartCoordinator: MultiWindowRestartCoordinator<BrowserWindow> = new MultiWindowRestartCoordinator<BrowserWindow>({
  getWindows: () => windowHost?.closeOrder() || [],
  canRequest: () => quitCoordinator.state === 'idle' && !quitting && !quitRouter.isPending,
  onStateChange: state => { restarting = state !== 'idle'; windowHost?.refresh(); },
  stop, start,
});
const quitRouter: ProjectWindowQuitRouter<BrowserWindow> = createProjectWindowQuitRouter<BrowserWindow>({ quit: quitCoordinator, restart: restartCoordinator, onPendingChange: () => windowHost?.refresh() });
ipcMain.handle(CLIP_LUT_RECOVERY_CHANNEL, (event, request) => lutRecoveryHost?.dispatch(event, request) ?? { ok: false, code: 'LUT_RECOVERY_UNAVAILABLE' });
ipcMain.handle(WORKSPACE_TOOLS_CHANNEL,(event,request)=>{
  if(!workspaceToolsHost)throw new Error('Workspace tools are unavailable.');
  return workspaceToolsHost.dispatch(event,request);
});
ipcMain.handle(WORKSPACE_NATIVE_CHANNEL,(event,request)=>{
  if(!workspaceNativeHost)throw new Error('Native workspace action is unavailable.');
  return workspaceNativeHost.dispatch(event,request);
});
ipcMain.handle(APP_LANGUAGE_CHANNEL, (event, request) => {
  if (!languageHost) throw new Error('App language preferences are not available.');
  return languageHost.dispatch(event, request);
});
ipcMain.handle(NATIVE_AUDIO_CHANNEL, (event, request) => nativeAudioHost?.dispatch(event, request) ?? null);
ipcMain.handle(PROJECT_WINDOW_CHANNEL, (event, request) => {
  if (!windowHost) throw new Error('Native windows are not available.');
  return windowHost.dispatch(event, request);
});

async function quitFailed(error: unknown): Promise<void> {
  return quitFailureNotice ??= (async () => {
  // Never route a failed quit back through fatal() -> app.quit(). In particular,
  // an unconfirmed owned process must remain supervised, not be abandoned.
  if (!smokeOutput) await dialog.showMessageBox(errorCode(error) === 'BACKEND_MEDIA_EXIT_UNCONFIRMED' ? {
    type: 'error', title: nt('native.mediaExitTitle'), message: nt('native.mediaExitMessage'),
    detail: nt('native.mediaExitDetail'),
    buttons: [nt('native.quitApplication')]
  } : { type: 'error', title: nt('native.cleanupTitle'), message: nt('native.cleanupMessage'),
    detail: backend?.child ? nt('native.cleanupManaged') : nt('native.cleanupPreserved'),
    buttons: [nt('native.acknowledge')] });
  if (!backend?.child) app.exit(1);
  })();
}

if (startupStorageError) void showStorageStartupFailure(app, dialog, startupStorageError);
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (quitCoordinator.state === 'idle' && !restarting) windowHost?.activate(BrowserWindow.getFocusedWindow());
    projectFiles.add(projectFileArguments(argv, workingDirectory));
  });
  // macOS delivers double-clicked files here, possibly before ready; Windows and Linux use argv.
  app.on('open-file', (event, file) => { event.preventDefault(); projectFiles.add([file]); });
  projectFiles.add(projectFileArguments(process.argv));
  app.on('activate', () => {
    if (!restarting && !quitting && quitCoordinator.state === 'idle' && ownsWindowContext(windowContext)) windowHost?.activate(BrowserWindow.getFocusedWindow());
  });
  app.on('window-all-closed', () => { if (!restarting && process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (quitCoordinator.state === 'finished') return;
    event.preventDefault();
    const focused = BrowserWindow.getFocusedWindow();
    if (windowHost) {
      void requestApplicationQuit(ownsWindow(focused, windowContext) && windowHost.isTrustedDocument(focused) ? focused : undefined);
    } else void requestApplicationQuit(undefined);
  });
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.setIcon(path.join(app.getAppPath(), 'icons/icon.png'));
    workspaceToolsHost=createWorkspaceToolsHost<IpcMainInvokeEvent>({
      isTrusted:event=>{
        const window=windowHost?.windowForContents(event.sender as ProjectWindowWebContents),owner=windowHost?.ownerForContents(event.sender as ProjectWindowWebContents);
        return Boolean(!restarting&&quitCoordinator.state==='idle'&&window&&owner&&ownsWindow(window,windowContext)&&owner.isCurrent()&&
          event.senderFrame===window.webContents.mainFrame&&event.senderFrame===owner.frame&&event.senderFrame?.url===owner.url);
      },
      read:()=>readToolConfig(paths.configFile),
      select:async name=>{const result=await dialog.showOpenDialog({title:nt('native.chooseExecutable',{name}),properties:['openFile']});return result.canceled||result.filePaths.length!==1?null:result.filePaths[0];},
      check:async configuration=>{
        const signal=windowContext?.startup.signal;if(!signal)throw new Error('Workspace tools are unavailable.');
        const checked=await validateTools(configuration,{signal});
        return inspectMediaTools({ffmpeg:checked.ffmpeg,ffprobe:checked.ffprobe},{execute:runMedia,signal});
      },
      save:configuration=>saveToolConfig(paths.configFile,configuration),
      revealWorkspace:async()=>{validatePrivateDirectory(paths.dataDir);return (await shell.openPath(paths.dataDir))==='';},
    });
    languageHost = createAppLanguageHost({ systemLanguages,
      storage: { read: () => readAppLanguagePreference(paths), write: text => writeAppLanguagePreference(paths, text) },
      isTrusted: event => {
        const window = windowHost?.windowForContents(event.sender);
        const owner = windowHost?.ownerForContents(event.sender);
        return Boolean(window && owner && ownsWindow(window, windowContext) && owner.isCurrent() &&
          event.senderFrame === window.webContents.mainFrame && event.senderFrame === owner.frame && event.senderFrame?.url === owner.url);
      },
      broadcast: (channel, state) => {
        for (const window of windowHost?.windows() || []) {
          try { if (windowHost?.isTrustedDocument(window)) window.webContents.send(channel, state); }
          catch { /* A disappearing window cannot block other windows or reject a saved preference. */ }
        }
      },
      onChanged: () => installMenu(),
    });
    installMenu();
    const report = await start();
    if (smokeOutput) {
      const output = smokeOutput;
      const { runSmoke } = await import('./smoke-checks.ts');
      await runSmoke({ app, getWindow: () => win, getSession: () => activeSession,
        getProjectWindow: (projectId: string) => windowHost?.windows().find(window => windowHost?.contextFor(window)?.initialProjectId === projectId),
        getReady: () => ready, getBackend: () => backend, restart,
        reload: () => win ? windowAdmissions.get(win)?.requestReload() ?? Promise.resolve(false) : Promise.resolve(false), paths, report, output,
        attemptDirtyQuit: async () => {
          smokeDiscardDecision = false;
          try { return await quitCoordinator.request(); }
          finally { smokeDiscardDecision = undefined; }
        } });
      app.quit();
    }
  }).catch(fatal);
}
