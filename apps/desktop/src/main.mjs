import { app, BrowserWindow, Menu, session, dialog, utilityProcess, safeStorage } from 'electron';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { prepareDesktopStorage, showStorageStartupFailure, storageFailureDialog, ensureDataIdentity, readToolConfig, validateTools, saveToolConfig, utilityEnvironment, writeConnection, removeConnectionOnShutdown } from './config.mjs';
import desktopIdentity from '../identity.cjs';
import { BackendSupervisor } from './supervisor.mjs';
import { stopBackendForQuit } from './shutdown.mjs';
import { createDesktopStartup } from './startup.mjs';
import { createDesktopAgentSettings } from './secret-store.mjs';
import { createDesktopImageSecretCodec } from './image-secret-store.mjs';
import { QuitCoordinator } from './lifecycle.mjs';
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
let paths, startupStorageError;
try { paths = prepareDesktopStorage(app, process.env.MIOON_DESKTOP_USER_DATA, identity.channel); }
catch (error) { startupStorageError = error; }
let win, backend, activeSession, ready, restarting = false, quitting = false;
let agentSettings;
let startupOperation;
let windowContext;
const windowAdmissions = new WeakMap();
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
    const result = await dialog.showMessageBox({ type: 'warning', title: '配置视频工具',
      message: '需要你已安装的 FFmpeg 和 ffprobe',
      detail: '本应用包含 Electron / Node / SQLite，但不捆绑 FFmpeg。请选择从可信来源安装的 ffmpeg 和 ffprobe 可执行文件。仅保存所选路径，不修改原始素材。\n\n' + error.message,
      buttons: ['选择工具', '退出'], defaultId: 0, cancelId: 1 });
    startup.checkpoint();
    if (result.response !== 0) throw new Error('未配置 FFmpeg');
  }
  const choose = async name => {
    const result = await dialog.showOpenDialog({ title: `选择 ${name} 可执行文件`, properties: ['openFile'] });
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
    backend = new BackendSupervisor({ fork: utilityProcess.fork,
      modulePath: path.join(app.getAppPath(), 'backend.cjs'), environment: utilityEnvironment(process.env, tools), agentSettings,
      imageSecretCodec: createDesktopImageSecretCodec({ safeStorage, appId: identity.appId }) });
    backend.on('exit', ({ expected }) => { if (!expected && ready && !quitting && !smokeOutput) void backendFailed(); });
    const started = await backend.start({ dataDir: paths.dataDir, distDir: path.join(app.getAppPath(), 'web'),
      subtitleResourcesDir:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),'subtitles'),token });
    startup.checkpoint();
    ready = started;
    activeSession = session.fromPartition(`${identity.appId}-${randomUUID()}`, { cache: false });
    installSessionPolicy(activeSession, ready.url, () => win, { downloadsDirectory: app.getPath('downloads') });
    await activeSession.cookies.set(sessionCookie(ready.url, token));
    startup.checkpoint();
    await writeConnection(paths, { url: ready.url, token, pid: ready.runtime.pid, identity });
    startup.checkpoint();
    // A backend handshake alone is not permission to open a window. Publish its
    // context only after this start owns a prepared session and discovery file.
    const context = windowContext = { startup, ready: started, session: activeSession };
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
  return Boolean(window && win === window && !window.isDestroyed() && ownsWindowContext(context));
}

async function loadOwnedWindow(window, context) {
  try { await window.loadURL(`${context.ready.url}/`); }
  catch (error) {
    // A destroyed/superseded window can reject its outstanding navigation. This
    // exemption belongs only to that navigation, never startup or stop cleanup.
    if (ownsWindow(window, context)) throw error;
  }
}

async function openWindow(context = windowContext) {
  if (!ownsWindowContext(context) || (win && !win.isDestroyed())) return;
  const window = new BrowserWindow({ title: identity.productName, width: 1500, height: 960,
    minWidth: 1050, minHeight: 680, backgroundColor: '#f6f4ef', show: false,
    autoHideMenuBar: process.platform !== 'darwin', ...windowChromeOptions(), webPreferences: secureWebPreferences(context.session) });
  win = window;
  installWindowPolicy(window, context.ready.url);
  windowAdmissions.set(window, installNativeCloseAdmission(window, {
    isCurrent: () => ownsWindow(window, context) && isAllowedNavigation(window.webContents.getURL(), context.ready.url),
    confirmClose: action => Boolean(smokeOutput) || dialog.showMessageBox(window, { type: 'warning', title: '本地草稿或视图尚未确认保存',
      message: `部分本地草稿或视图位置尚未确认保存，仍要${action === 'reload' ? '重新载入' : '退出'}？`,
      detail: `${action === 'reload' ? '重新载入' : '直接退出'}可能丢失最后未确认的输入或位置；不会改变已保存的项目和媒体，也不会取消可能仍在处理的保存请求。可以继续编辑并核对保存状态。`,
      buttons: [action === 'reload' ? '仍然重新载入' : '仍然退出', '继续编辑'], defaultId: 1, cancelId: 1 }).then(({ response }) => response === 0),
    confirmDiscard: action => smokeOutput && typeof smokeDiscardDecision === 'boolean' ? smokeDiscardDecision : dialog.showMessageBox(window, { type: 'question', title: '尚有未保存的修改',
      message: `放弃未保存的修改和未发送的输入并${action === 'reload' ? '重新载入' : '退出'}？`, detail: `包括 Agent、图像工坊和连接设置中的未保存输入。${action === 'reload' ? '重新载入' : '退出'}不会保存连接设置或重新发送请求。选择继续编辑会保持当前窗口和本地服务运行。`,
      buttons: ['放弃修改', '继续编辑'], defaultId: 1, cancelId: 1 }).then(({ response }) => response === 0),
    onBlocked: reason => smokeOutput ? undefined : dialog.showMessageBox(window, { type: 'warning', title: '暂时无法安全离开',
      message: reason === 'blocked' ? '还有读取、保存、发送或待核对的状态，请先在原面板处理。' : reason === 'changed' ? '确认期间的输入或状态已变化，本次操作已取消。' : '暂时无法确认当前输入的保存状态，本次操作已取消。',
      detail: '当前操作未继续，窗口和本地服务仍保留。不会放弃输入、保存连接设置或自动重试请求。', buttons: ['继续编辑'], defaultId: 0, cancelId: 0 }),
    onCancel: () => { if (ownsWindow(window, context)) quitCoordinator.cancel(); },
    requestQuit: () => ownsWindow(window, context) ? quitCoordinator.request().catch(quitFailed) : false
  }));
  window.on('closed', () => { if (win === window) win = null; });
  window.once('ready-to-show', () => { if (ownsWindow(window, context)) window.show(); });
  const onRendererFailure = () => {
    if (ownsWindow(window, context) && !smokeOutput) void rendererFailed(window, context).catch(fatal);
  };
  window.webContents.on('render-process-gone', onRendererFailure);
  window.webContents.on('unresponsive', onRendererFailure);
  await loadOwnedWindow(window, context);
}

async function stop() {
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
  if (restarting || quitting) return;
  restarting = true;
  windowContext = null;
  try {
    if (win && !win.isDestroyed()) win.destroy();
    await stop();
    return await start();
  } finally { restarting = false; }
}

async function backendFailed() {
  if (restarting || quitting) return;
  if (win && !win.isDestroyed()) win.hide();
  if (backend?.hasUnconfirmedMedia) return quitFailed({ code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED' });
  const { response } = await dialog.showMessageBox({ type: 'error', title: '本地服务已停止',
    message: '本地服务意外退出。已保存的数据会在重启时恢复。',
    detail: '未保存的界面修改可能丢失。生成任务会按已保存的状态恢复处理；提交结果未知时只对账，不会自动重新提交。Agent 对话保留已保存的文字；重启后不会自动继续推理或重新发送请求。',
    buttons: ['重启本地服务', '退出'], defaultId: 0, cancelId: 1 });
  if (response === 0) { try { await restart(); } catch (error) { await fatal(error); } }
  else app.quit();
}

let rendererErrorOwner = null;
async function rendererFailed(window, context) {
  if (!ownsWindow(window, context) || (rendererErrorOwner?.window === window && rendererErrorOwner.context === context)) return;
  const recovery = windowAdmissions.get(window)?.captureRecoveryDecision();
  if (!recovery?.claimPrompt()) return;
  const owner = rendererErrorOwner = { window, context };
  try {
    const { response } = await dialog.showMessageBox({ type: 'warning', title: '界面需要重新载入',
      message: '工作区界面没有响应。后台任务仍由本地服务管理。',
      detail: '如果界面进程已经崩溃，未保存的输入可能已经丢失。重新载入只恢复当前界面，不会重新提交任务或生成请求。',
      buttons: ['重新载入界面', '退出', '保留窗口'], defaultId: 0, cancelId: 2 });
    if (!ownsWindow(window, context)) return;
    if (response === 0) await recovery?.reload();
    else if (response === 1) await recovery?.exit();
  } catch (error) {
    if (ownsWindow(window, context)) throw error;
  } finally {
    // A pending old-window dialog must neither block a replacement's recovery
    // prompt nor release that replacement's duplicate-event guard when it ends.
    if (rendererErrorOwner === owner) {
      rendererErrorOwner = null;
      if (recovery.takePendingIncident()) await rendererFailed(window, context);
    }
  }
}

async function fatal(error) {
  if (cancelledStartupErrors.has(error)) return;
  if (smokeOutput) {
    await mkdir(path.dirname(smokeOutput), { recursive: true });
    await writeFile(smokeOutput, JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  } else {
    await dialog.showMessageBox(error?.code?.startsWith('STORAGE_') ? storageFailureDialog(error) :
      { type: 'error', title: '无法启动 Mioon', message: '应用无法启动。', detail: error.message, buttons: ['退出'] });
  }
  app.quit();
}

function installMenu() {
  const template = [];
  if (process.platform === 'darwin') template.push({ role: 'appMenu' });
  template.push({ label: '应用', submenu: [
    { label: '重新载入界面', accelerator: 'CmdOrCtrl+R', click: () => {
      if (ownsWindow(win, windowContext)) void windowAdmissions.get(win)?.captureRecoveryDecision().reload().catch(fatal);
    } },
    { label: '重启本地服务', click: async () => {
      const { response } = await dialog.showMessageBox({ type: 'question', message: '重启本地服务？',
        detail: '已保存的数据保留。未保存的界面修改可能丢失。生成任务会按已保存的状态恢复处理；提交结果未知时只对账，不会自动重新提交。Agent 对话保留已保存的文字；重启后不会自动继续推理或重新发送请求。',
        buttons: ['重启', '取消'], defaultId: 1, cancelId: 1 });
      if (response === 0) { try { await restart(); } catch (error) { await fatal(error); } }
    } },
    { type: 'separator' }, { role: 'quit', label: '退出' }
  ] }, { role: 'editMenu', label: '编辑' }, { role: 'windowMenu', label: '窗口' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const quitCoordinator = new QuitCoordinator({ getWindow: () => win,
  stop: async () => {
    quitting = true;
    windowContext = null;
    const onUnconfirmed = () => smokeOutput ? undefined : dialog.showMessageBox({ type: 'error', title: '正在等待本地进程退出',
      message: '本地进程尚未确认退出，应用将继续等待。',
      detail: '当前不会重启服务或继续发送终止信号。确认本地进程退出后，应用会完成清理并退出。',
      buttons: ['知道了'] });
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

async function quitFailed(error) {
  return quitFailureNotice ??= (async () => {
  // Never route a failed quit back through fatal() -> app.quit(). In particular,
  // an unconfirmed owned process must remain supervised, not be abandoned.
  if (!smokeOutput) await dialog.showMessageBox(error?.code === 'BACKEND_MEDIA_EXIT_UNCONFIRMED' ? {
    type: 'error', title: '无法确认媒体进程退出', message: '本地服务已退出，但媒体子进程可能仍在运行。',
    detail: '应用无法安全核验这些进程，因此不会自动重启服务或按记录的进程编号强制终止。退出应用前或再次使用前，请在系统任务管理器中检查 FFmpeg 和 ffprobe 是否仍在运行。',
    buttons: ['退出应用']
  } : { type: 'error', title: '退出清理未完成', message: '本地服务或应用清理未正常完成。',
    detail: backend?.child ? '应用将保留对本地服务的管理，请稍后再尝试退出。' : '已保存的数据保持原样，下次启动时将尝试恢复。',
    buttons: ['知道了'] });
  if (!backend?.child) app.exit(1);
  })();
}

if (startupStorageError) void showStorageStartupFailure(app, dialog, startupStorageError);
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const window = win;
    if (ownsWindow(window, windowContext)) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.on('activate', () => {
    if (!restarting && !quitting && quitCoordinator.state === 'idle' && ownsWindowContext(windowContext)) void openWindow().catch(fatal);
  });
  app.on('window-all-closed', () => { if (!restarting && process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (quitCoordinator.state === 'finished') return;
    event.preventDefault();
    void quitCoordinator.request().catch(quitFailed);
  });
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  app.whenReady().then(async () => {
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
