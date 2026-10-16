import { createDesktopLutRecoveryHost } from './lut-recovery-host.ts';
import { createDesktopLutRecoveryStore } from './lut-recovery-store.ts';
import { CLIP_LUT_RECOVERY_CHANNEL } from '../../../packages/contracts/src/clip-lut-recovery.ts';
import { calculateWorkspaceScope } from '../../../packages/contracts/src/workspace-scope.ts';
import { validatePrivateDirectory, validateManagedFile, readPrivateFile, removePrivateFile, writePrivateFileAtomic } from '@mioon/contracts/private-storage';
import { createAppLanguageHost } from './app-language-host.ts';
import { APP_LANGUAGE_CHANNEL } from '../../../packages/i18n/src/preference.ts';
import { resolveLocale } from '../../../packages/i18n/src/locale.ts';
import { nativeText as nt, setNativeLanguageReader } from './app-language-text.ts';
import { app, BrowserWindow, Menu, session, dialog, utilityProcess, safeStorage, ipcMain } from 'electron';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { prepareDesktopStorage, readAppLanguagePreference, writeAppLanguagePreference, showStorageStartupFailure, storageFailureDialog, ensureDataIdentity, readToolConfig, validateTools, saveToolConfig, utilityEnvironment, writeConnection, removeConnectionOnShutdown } from './config.mjs';
import desktopIdentity from '../identity.cjs';
import { BackendSupervisor } from './supervisor.mjs';
import { stopBackendForQuit } from './shutdown.mjs';
import { createDesktopStartup } from './startup.mjs';
import { createDesktopAgentSettings } from './secret-store.mjs';
import { createDesktopImageSecretCodec } from './image-secret-store.mjs';
import { createProjectWindowHost } from './project-window-host.ts';
import { createNativeAudioPreviewHost, createNativeAudioPreviewSigningIdentity } from './native-audio-preview-host.ts';
import { NATIVE_AUDIO_CHANNEL } from './native-audio-preview-protocol.ts';
import { consumeNativeProjectEntry } from './project-entry-admission.ts';
import { observeInitialProjectLoad, createProjectRendererRecovery, createProjectBackendIncident } from './project-window-recovery.ts';
import { MultiWindowQuitCoordinator, MultiWindowRestartCoordinator, createProjectWindowQuitRouter } from './project-window-quit.ts';
import { confirmOwnedWindowRestart } from './project-window-confirmation.ts';
import { PROJECT_WINDOW_CHANNEL } from './project-window-protocol.ts';
import { installNativeCloseAdmission } from './native-close.ts';
import { secureWebPreferences, sessionCookie, installSessionPolicy, installWindowPolicy, isAllowedNavigation } from './security.mjs';
import { windowChromeOptions } from './window-chrome.ts';

// The renderer never receives privileged Electron APIs or native filesystem paths.
app.enableSandbox();
// Embedded by build.mjs. Runtime env and app.isPackaged cannot change the channel.
const identity = desktopIdentity.identityForChannel(__MIOON_DESKTOP_CHANNEL__);
app.setName(identity.productName);
app.setAppUserModelId(identity.appId);
if (process.platform === 'linux') {
  app.setDesktopName(`${identity.appId}.desktop`);
  app.commandLine.appendSwitch('class', identity.appId);
}
let languageHost;
const systemLanguages = () => { try { return app.getPreferredSystemLanguages(); } catch { return [process.env.LC_ALL || process.env.LANG || 'en']; } };
setNativeLanguageReader(() => languageHost?.snapshot().locale ?? resolveLocale('system', systemLanguages()));
let paths, startupStorageError;
try { paths = prepareDesktopStorage(app, process.env.MIOON_DESKTOP_USER_DATA, identity.channel); }
catch (error) { startupStorageError = error; }
let win, backend, activeSession, ready, restarting = false, quitting = false;
let agentSettings;
let startupOperation;
let windowContext, windowHost, nativeAudioHost, lutRecoveryHost;
const windowAdmissions = new WeakMap();
const initialWindowLoads = new WeakMap();
const cancelledStartupErrors = new WeakSet();
let quitFailureNotice;
let smokeDiscardDecision;
const smokeOutput = !app.isPackaged && process.env.MIOON_DESKTOP_USER_DATA && process.env.MIOON_DESKTOP_SMOKE_OUTPUT;

async function toolsFromUser(startup) {
  let configuration;
  try {
    configuration = await readToolConfig(paths.configFile);
    startup.checkpoint();
    return await validateTools(configuration, { signal: startup.signal });
  }
  catch (error) {
    startup.checkpoint();
    if (error?.code?.startsWith('STORAGE_')) throw error;
    if (smokeOutput) throw error;
    const result = await dialog.showMessageBox({ type: 'warning', title: nt('native.toolsTitle'),
      message: nt('native.toolsMessage'),
      detail: nt('native.toolsDetail') + '\n\n' + nt('native.originalDiagnostic', { detail: error.message }),
      buttons: [nt('native.chooseTools'), nt('native.quit')], defaultId: 0, cancelId: 1 });
    startup.checkpoint();
    if (result.response !== 0) throw new Error('未配置 FFmpeg');
  }
  const choose = async name => {
    const result = await dialog.showOpenDialog({ title: nt('native.chooseExecutable', { name }), buttonLabel: nt('native.chooseTools'), properties: ['openFile'] });
    startup.checkpoint();
    if (result.canceled || result.filePaths.length !== 1) throw new Error(`未选择 ${name}`);
    return result.filePaths[0];
  };
  configuration = await validateTools({ ffmpeg: await choose('ffmpeg'), ffprobe: await choose('ffprobe') }, { signal: startup.signal });
  startup.checkpoint();
  await saveToolConfig(paths.configFile, configuration);
  return configuration;
}

function cancelledStartupError() {
  // Only this exact result belongs to an explicitly cancelled start. A provider
  // or cleanup error with the same code must still reach fatal().
  const error = Object.assign(new Error('本地服务启动已取消。'), { code: 'DESKTOP_START_CANCELLED' });
  cancelledStartupErrors.add(error);
  return error;
}

async function start() {
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
    let ownedAudioHost, backendExitObserved = false;
    backend = new BackendSupervisor({ fork: utilityProcess.fork,
      modulePath: path.join(app.getAppPath(), 'backend.cjs'), environment: utilityEnvironment(process.env, tools), agentSettings,
      imageSecretCodec: createDesktopImageSecretCodec({ safeStorage, appId: identity.appId }) });
    const ownedBackend = backend, incident = createProjectBackendIncident();
    ownedBackend.on('exit', ({ expected }) => {
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
    installSessionPolicy(activeSession, ready.url, contents => windowHost?.windowForContents(contents), { downloadsDirectory: app.getPath('downloads') });
    await activeSession.cookies.set(sessionCookie(ready.url, token));
    startup.checkpoint();
    incident.assertAlive();
    await writeConnection(paths, { url: ready.url, token, pid: ready.runtime.pid, identity });
    startup.checkpoint();
    incident.assertAlive();
    // A backend handshake alone is not permission to open a window. Publish its
    // context only after this start owns a prepared session and discovery file.
    const context = windowContext = { startup, ready: started, session: activeSession, incident };
    windowHost = createProjectWindowHost({
      backendId, launcherUrl: `${started.url}/`, editorUrl: projectId => `${started.url}/?project=${projectId}`,
      isCurrent: () => ownsWindowContext(context),
      canInteract: () => quitRouter.allowsWindows && !context.incident.failed,
      createWindow: () => new BrowserWindow({ title: identity.productName, width: 1500, height: 960,
        icon: path.join(app.getAppPath(), 'icons/icon.png'),
        minWidth: 1050, minHeight: 680, backgroundColor: '#f6f4ef', show: false,
        autoHideMenuBar: process.platform !== 'darwin', ...windowChromeOptions(),
        webPreferences: { ...secureWebPreferences(context.session), preload: path.join(app.getAppPath(), 'preload.cjs') } }),
      prepareWindow: (window, owner) => prepareOwnedWindow(window, context, owner),
      consumeProjectEntry: consumeNativeProjectEntry,
      onDocumentInvalidated: owner => ownedAudioHost?.revokeOwner(owner, false),
      onWebContentsDestroyed: windowId => ownedAudioHost?.revokeWindowDestroyed(windowId),
      onLoadError: (error, window) => { if (ownsWindow(window, context) && !smokeOutput) void initialWindowFailed(window, context).catch(fatal); },
    });
    ownedAudioHost = createNativeAudioPreviewHost({ backendId, origin: started.url, signer: nativeAudioIdentity,
      request: (command, onPending) => ownedBackend.requestNativeAudio(command, onPending),
      isAdmissionAllowed: () => ownsWindowContext(context) && backend === ownedBackend && quitRouter.allowsWindows && !context.incident.failed,
      isBackendExitConfirmed: () => backendExitObserved && ownedBackend.child === null && ownedBackend.stopOutcome?.exitConfirmed === true && !ownedBackend.hasUnconfirmedMedia,
      ownerForContents: contents => { const owner = windowHost?.ownerForContents(contents); return owner?.role === 'editor' ? { ...owner, contents } : null; },
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
    lutRecoveryHost = createDesktopLutRecoveryHost({
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
      createStore: guard => createDesktopLutRecoveryStore({ userData: paths.userData, guard, storage: { validatePrivateDirectory, validateManagedFile, readPrivateFile, removePrivateFile, writePrivateFileAtomic } }),
    });

    activeSession.webRequest.onBeforeSendHeaders((details, callback) => callback(ownedAudioHost.beforeSendHeaders(details)));
    await openWindow(context);
    startup.checkpoint();
    return { identity, runtime: ready.runtime, tools: tools.versions };
  } catch (error) {
    // stop()/quit abort this scope before draining, so an old result may arrive
    // even before its replacement starts. Never suppress a failed settings drain.
    if (startup.signal.aborted && !closingCancelledSettings) throw cancelledStartupError();
    throw error;
  }
}

function ownsWindowContext(context) {
  return Boolean(context && context === windowContext && context.startup === startupOperation &&
    !context.startup.signal.aborted && context.ready === ready && context.session === activeSession && !quitting);
}

function ownsWindow(window, context) {
  return Boolean(window && windowHost?.owns(window) && !window.isDestroyed() && ownsWindowContext(context));
}

async function openWindow(context = windowContext) {
  if (!ownsWindowContext(context)) return;
  const window = windowHost?.ensureLauncher();
  if (window) {
    try { await windowHost.loadFor(window); }
    catch (error) { if (!ownsWindow(window, context) || !initialWindowLoads.get(window)?.failed) throw error; }
  }
}

function prepareOwnedWindow(window, context, owner) {
  win = window;
  const contents = window.webContents;
  const initialLoad = observeInitialProjectLoad(window, owner.url, () => ownsWindow(window, context));
  initialWindowLoads.set(window, initialLoad);
  installWindowPolicy(window, context.ready.url, { url: owner.url, isCurrent: () => owner.isCurrent() });
  windowAdmissions.set(window, installNativeCloseAdmission(window, {
    isCurrent: () => ownsWindow(window, context) && window.webContents.getURL() === owner.url && isAllowedNavigation(window.webContents.getURL(), context.ready.url),
    onCloseStateChange: state => windowHost?.closeStateChanged(window, state),
    consumeInitialEmptyClose: () => initialLoad.consumeClose(),
    beforeReload: signal => {
      if (owner.role !== 'editor') return true;
      const document = windowHost?.ownerForContents(contents);
      return document?.window === window && document.backendId === owner.backendId
        ? context.audioHost?.retireOwnerForReload({ ...document, contents }, signal) ?? false : false;
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
}

async function stop() {
  const context = windowContext, audioHost = context?.audioHost;
  await audioHost?.shutdown();
  if (context && windowContext !== context) throw Object.assign(new Error('Desktop ownership changed during shutdown.'), { code: 'BACKEND_STOP_FAILED' });
  if (nativeAudioHost === audioHost) nativeAudioHost = null;
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

async function restart() {
  return restartCoordinator.request();
}

async function backendFailed(failedBackend = backend, incident = windowContext?.incident) {
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
  isCurrent: (window, context) => ownsWindow(window, context) && quitRouter.allowsWindows && !context.incident.failed,
  capture: window => windowAdmissions.get(window)?.captureRecoveryDecision(),
  prompt: window => dialog.showMessageBox(window, { type: 'warning', title: nt('native.rendererTitle'),
    message: nt('native.rendererMessage'),
    detail: nt('native.rendererDetail'),
    buttons: [nt('native.reload'), nt('native.quitApplication'), nt('native.keepWindow')], defaultId: 0, cancelId: 2 }).then(result => result.response),
});
async function initialWindowFailed(window, context) {
  const proof = initialWindowLoads.get(window)?.captureFailure();
  if (!proof) return rendererFailed(window, context, 'load-error');
  const { response } = await dialog.showMessageBox(window, { type: 'error', title: nt('native.emptyWindowTitle'),
    message: nt('native.emptyWindowMessage'), detail: nt('native.emptyWindowDetail'),
    buttons: [nt('native.retryLoad'), nt('native.closeEmpty'), nt('native.keepWindow')], defaultId: 0, cancelId: 2 });
  if (!ownsWindow(window, context) || !proof.isCurrent()) return;
  if (response === 0 && quitRouter.allowsWindows && !context.incident.failed) { try { await proof.retry(); } catch { if (ownsWindow(window, context)) await initialWindowFailed(window, context); } }
  else if (response === 1) proof.close();
}

async function fatal(error) {
  if (cancelledStartupErrors.has(error)) return;
  if (smokeOutput) {
    await mkdir(path.dirname(smokeOutput), { recursive: true });
    await writeFile(smokeOutput, JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  } else {
    await dialog.showMessageBox(error?.code?.startsWith('STORAGE_') ? storageFailureDialog(error) :
      { type: 'error', title: nt('native.cannotStartTitle'), message: nt('native.cannotStartMessage'), detail: nt('native.originalDiagnostic', { detail: error.message }), buttons: [nt('native.quit')] });
  }
  app.quit();
}

function installMenu() {
  const template = [];
  if (process.platform === 'darwin') template.push({ label: identity.productName, submenu: [
    { role: 'about', label: nt('native.about') }, { type: 'separator' }, { role: 'services', label: nt('native.services') },
    { type: 'separator' }, { role: 'hide', label: nt('native.hide') }, { role: 'hideOthers', label: nt('native.hideOthers') },
    { role: 'unhide', label: nt('native.showAll') }, { type: 'separator' }, { role: 'quit', label: nt('native.quit') },
  ] });
  template.push({ label: nt('native.application'), submenu: [
    { label: nt('native.newProject'), click: () => windowHost?.requestProjectEntry('new', BrowserWindow.getFocusedWindow()) },
    { label: nt('native.openProject'), click: () => windowHost?.requestProjectEntry('open', BrowserWindow.getFocusedWindow()) },
    { label: nt('native.connections'), click: () => windowHost?.showSettings('agent') },
    { label: nt('native.reload'), accelerator: 'CmdOrCtrl+R', click: () => {
      const window = windowHost?.preferredWindow(BrowserWindow.getFocusedWindow());
      if (ownsWindow(window, windowContext) && !windowContext.incident.failed) {
        if (initialWindowLoads.get(window)?.failed) void initialWindowFailed(window, windowContext).catch(fatal);
        else void windowAdmissions.get(window)?.captureRecoveryDecision().reload().catch(fatal);
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
    ...(process.platform === 'darwin' ? [{ role: 'pasteAndMatchStyle', label: nt('native.pasteMatch') }] : []),
    { role: 'delete', label: nt('native.delete') }, { role: 'selectAll', label: nt('native.selectAll') },
  ] }, { label: nt('native.window'), submenu: [
    { role: 'minimize', label: nt('native.minimize') }, { role: 'zoom', label: nt('native.zoom') },
    ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front', label: nt('native.front') }] : [{ role: 'close', label: nt('native.closeWindow') }]),
  ] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const quitCoordinator = new MultiWindowQuitCoordinator({ getWindows: () => windowHost?.windows() || [],
  onStateChange: () => windowHost?.refresh(),
  stop: async () => {
    quitting = true;
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

const restartCoordinator = new MultiWindowRestartCoordinator({
  getWindows: () => windowHost?.windows() || [],
  canRequest: () => quitCoordinator.state === 'idle' && !quitting && !quitRouter.isPending,
  onStateChange: state => { restarting = state !== 'idle'; windowHost?.refresh(); },
  stop, start,
});
const quitRouter = createProjectWindowQuitRouter({ quit: quitCoordinator, restart: restartCoordinator, onPendingChange: () => windowHost?.refresh() });
function requestApplicationQuit(source) { return quitRouter.request(source).catch(quitFailed); }
ipcMain.handle(CLIP_LUT_RECOVERY_CHANNEL, (event, request) => lutRecoveryHost?.dispatch(event, request) ?? { ok: false, code: 'LUT_RECOVERY_UNAVAILABLE' });
ipcMain.handle(APP_LANGUAGE_CHANNEL, (event, request) => {
  if (!languageHost) throw new Error('App language preferences are not available.');
  return languageHost.dispatch(event, request);
});
ipcMain.handle(NATIVE_AUDIO_CHANNEL, (event, request) => nativeAudioHost?.dispatch(event, request) ?? null);
ipcMain.handle(PROJECT_WINDOW_CHANNEL, (event, request) => {
  if (!windowHost) throw new Error('Native windows are not available.');
  return windowHost.dispatch(event, request);
});

async function quitFailed(error) {
  return quitFailureNotice ??= (async () => {
  // Never route a failed quit back through fatal() -> app.quit(). In particular,
  // an unconfirmed owned process must remain supervised, not be abandoned.
  if (!smokeOutput) await dialog.showMessageBox(error?.code === 'BACKEND_MEDIA_EXIT_UNCONFIRMED' ? {
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
  app.on('second-instance', () => {
    if (quitCoordinator.state === 'idle' && !restarting) windowHost?.activate(BrowserWindow.getFocusedWindow());
  });
  app.on('activate', () => {
    if (!restarting && !quitting && quitCoordinator.state === 'idle' && ownsWindowContext(windowContext)) windowHost?.activate(BrowserWindow.getFocusedWindow());
  });
  app.on('window-all-closed', () => { if (!restarting && process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (quitCoordinator.state === 'finished') return;
    event.preventDefault();
    const focused = BrowserWindow.getFocusedWindow();
    void requestApplicationQuit(ownsWindow(focused, windowContext) && windowHost.isTrustedDocument(focused) ? focused : undefined);
  });
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.setIcon(path.join(app.getAppPath(), 'icons/icon.png'));
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
          try { if (windowHost.isTrustedDocument(window)) window.webContents.send(channel, state); }
          catch { /* A disappearing window cannot block other windows or reject a saved preference. */ }
        }
      },
      onChanged: () => installMenu(),
    });
    installMenu();
    const report = await start();
    if (smokeOutput) {
      const { runSmoke } = await import('./smoke-checks.mjs');
      await runSmoke({ app, getWindow: () => win, getSession: () => activeSession,
        getReady: () => ready, getBackend: () => backend, restart, paths, report, output: smokeOutput,
        attemptDirtyQuit: async () => {
          smokeDiscardDecision = false;
          try { return await quitCoordinator.request(); }
          finally { smokeDiscardDecision = undefined; }
        } });
      app.quit();
    }
  }).catch(fatal);
}
