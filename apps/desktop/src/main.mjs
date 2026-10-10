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
import { QuitCoordinator, installUnsavedGuard, installPreferencesCloseDrain } from './lifecycle.mjs';
import { secureWebPreferences, sessionCookie, installSessionPolicy, installWindowPolicy, isAllowedNavigation } from './security.mjs';

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

async function start() {
  if (quitting) throw Object.assign(new Error('本地服务启动已取消。'), { code: 'DESKTOP_START_CANCELLED' });
  const startup = startupOperation = createDesktopStartup();
  await ensureDataIdentity(paths, identity);
  startup.checkpoint();
  const tools = await toolsFromUser(startup);
  startup.checkpoint();
  // Main owns the single settings instance across trusted backend restarts.
  if (!agentSettings) {
    const settings = await createDesktopAgentSettings({ safeStorage, userData: app.getPath('userData'), appId: identity.appId, signal: startup.signal });
    if (startup.signal.aborted) { await settings.close(); startup.checkpoint(); }
    agentSettings = settings;
  }
  startup.checkpoint();
  const token = randomBytes(32).toString('hex');
  backend = new BackendSupervisor({ fork: utilityProcess.fork,
    modulePath: path.join(app.getAppPath(), 'backend.cjs'), environment: utilityEnvironment(process.env, tools), agentSettings,
    imageSecretCodec: createDesktopImageSecretCodec({ safeStorage, appId: identity.appId }) });
  backend.on('exit', ({ expected }) => { if (!expected && ready && !quitting && !smokeOutput) void backendFailed(); });
  const started = await backend.start({ dataDir: paths.dataDir, distDir: path.join(app.getAppPath(), 'web'), token });
  startup.checkpoint();
  ready = started;
  activeSession = session.fromPartition(`${identity.appId}-${randomUUID()}`, { cache: false });
  installSessionPolicy(activeSession, ready.url, () => win, { downloadsPath: path.join(app.getPath('downloads'), 'mioon.mp4') });
  await activeSession.cookies.set(sessionCookie(ready.url, token));
  startup.checkpoint();
  await writeConnection(paths, { url: ready.url, token, pid: ready.runtime.pid, identity });
  startup.checkpoint();
  await openWindow();
  return { identity, runtime: ready.runtime, tools: tools.versions };
}

async function openWindow() {
  if (!ready || quitting) return;
  win = new BrowserWindow({ title: identity.productName, width: 1500, height: 960,
    minWidth: 1050, minHeight: 680, backgroundColor: '#f6f4ef', show: false,
    autoHideMenuBar: process.platform !== 'darwin', webPreferences: secureWebPreferences(activeSession) });
  installWindowPolicy(win, ready.url);
  const closingWindow = win;
  installPreferencesCloseDrain(closingWindow, {
    // The fixed function can only perform the renderer's normal same-origin HTTP.
    // It receives no native capabilities, paths, token, or arguments from main.
    flush: () => isAllowedNavigation(closingWindow.webContents.getURL(), ready.url)
      ? closingWindow.webContents.executeJavaScript("typeof globalThis.__mioonFlushWorkspacePreferences === 'function' ? globalThis.__mioonFlushWorkspacePreferences() : true")
      : true,
    confirmClose: () => smokeOutput || dialog.showMessageBoxSync(closingWindow, { type: 'warning', title: '视图位置尚未保存',
      message: '当前视图位置尚未保存，仍要退出？',
      detail: '可以继续编辑并重试连接。直接退出可能丢失最近的工作区、选择或缩放位置；这不会改变已保存的项目和媒体。',
      buttons: ['仍然退出', '继续编辑'], defaultId: 1, cancelId: 1 }) === 0,
    onCancel: () => quitCoordinator.cancel()
  });
  installUnsavedGuard(win, {
    confirmDiscard: () => smokeOutput && typeof smokeDiscardDecision === 'boolean' ? smokeDiscardDecision : dialog.showMessageBoxSync(win, { type: 'question', title: '尚有未保存的修改',
      message: '放弃未保存的修改？', detail: '选择继续编辑会保持当前窗口和本地服务运行。',
      buttons: ['放弃修改', '继续编辑'], defaultId: 1, cancelId: 1 }) === 0,
    onCancel: () => quitCoordinator.cancel()
  });
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); });
  win.webContents.on('render-process-gone', () => { if (!quitting && !smokeOutput) void rendererFailed(); });
  win.webContents.on('unresponsive', () => { if (!quitting && !smokeOutput) void rendererFailed(); });
  await win.loadURL(`${ready.url}/`);
}

async function stop() {
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

let showingRendererError = false;
async function rendererFailed() {
  if (showingRendererError) return;
  showingRendererError = true;
  try {
    const { response } = await dialog.showMessageBox({ type: 'warning', title: '界面需要重新载入',
      message: '工作区界面没有响应。后台任务仍由本地服务管理。',
      buttons: ['重新载入界面', '退出'], defaultId: 0, cancelId: 1 });
    if (response === 0 && win && !win.isDestroyed()) await win.loadURL(`${ready.url}/`);
    else app.quit();
  } finally { showingRendererError = false; }
}

async function fatal(error) {
  if (quitting && ['DESKTOP_START_CANCELLED', 'BACKEND_START_CANCELLED', 'MEDIA_CANCELLED'].includes(error?.code)) return;
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
    { label: '重新载入界面', accelerator: 'CmdOrCtrl+R', click: () => { if (ready && win) void win.loadURL(`${ready.url}/`); } },
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
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.on('activate', () => { if (!win && ready && !quitting) void openWindow().catch(fatal); });
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
