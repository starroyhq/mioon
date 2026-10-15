import path from 'node:path';
import desktopIdentity from '../identity.cjs';
import {providerEnvironmentKeys} from '@mioon/business';
import { run as runMedia } from '@mioon/business/media-runtime';
import { throwIfMediaAborted } from '@mioon/business/media-processes';
import {validateWorkspaceStorage} from '@mioon/business/db';
import { stat, access, realpath } from 'node:fs/promises';
import { constants, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createPrivateTemporaryDirectory, ensurePrivateDirectory, validatePrivateDirectory, validateManagedDirectory,
  validateManagedFile, readPrivateFile, writePrivateFileAtomic, removePrivateFile } from '@mioon/contracts/private-storage';
const IDENTITY_MAX_BYTES = 4096;
const CONFIG_MAX_BYTES = 64 * 1024;
const CONNECTION_MAX_BYTES = 16 * 1024;
const TOKEN_MAX_BYTES = 4096;
const desktopStorageError = (code, message) => Object.assign(new Error(message), { code });

export function dataPaths(appDataPath, override, channel = 'development') {
  const identity = desktopIdentity.identityForChannel(channel);
  if (override && !path.isAbsolute(override)) throw desktopStorageError('DESKTOP_USER_DATA_INVALID', 'MIOON_DESKTOP_USER_DATA must be an absolute path');
  const userData = override || path.join(appDataPath, identity.appId);
  return { userData, dataDir: path.join(userData, 'workspace'), configFile: path.join(userData, 'desktop-config.json') };
}

// Must run synchronously before Electron can write caches or a single-instance
// lock. Existing directories are inspected, never repaired implicitly.
export function prepareDesktopStorage(app, override, channel = 'development') {
  const paths = dataPaths(app.getPath('appData'), override, channel);
  validateDesktopStorage(paths);
  const identity = desktopIdentity.identityForChannel(channel);
  const contents = readPrivateFile(path.join(paths.userData, 'desktop-identity.json'),
    { root: paths.userData, maxBytes: IDENTITY_MAX_BYTES, encoding: 'utf8', allowMissing: true });
  if (contents !== null) checkDataIdentity(contents, identity);
  ensurePrivateDirectory(paths.userData, { create: true });
  app.setPath('userData', paths.userData);
  return paths;
}

export function validateDesktopStorage(paths) {
  if (!validatePrivateDirectory(paths.userData, { allowMissing: true })) return;
  for (const [name, maxBytes] of [['desktop-identity.json', IDENTITY_MAX_BYTES], ['desktop-config.json', CONFIG_MAX_BYTES],
    ['mcp-token', TOKEN_MAX_BYTES], ['mcp-connection.json', CONNECTION_MAX_BYTES]]) {
    validateManagedFile(path.join(paths.userData, name), { root: paths.userData, private: true, allowMissing: true, maxBytes });
  }
  const directory = path.join(paths.userData, 'agent-settings');
  if (validateManagedDirectory(directory, { root: paths.userData, private: true, allowMissing: true })) {
    validateManagedFile(path.join(directory, 'settings.json'), { root: directory, private: true, allowMissing: true, maxBytes: 64 * 1024 });
  }
  validateWorkspaceStorage(paths.dataDir);
}

export function storageFailureDialog(error) {
  let message = '数据目录未通过隐私检查。';
  let detail = '数据目录必须属于当前用户且仅供当前用户访问；应用管理的文件不能是符号链接或硬链接。';
  let recovery = '请先备份已有数据并手动检查权限，或选择一个新的私有目录。MIOON_DESKTOP_USER_DATA 必须使用真实的绝对路径，不能经过符号链接或路径别名。';
  if (error?.code === 'DESKTOP_CHANNEL_MISMATCH') {
    message = '数据目录属于另一个应用通道。';
    detail = '开发版和正式版不能共用同一个数据目录。';
    recovery = '请使用与该目录匹配的应用通道，或将 MIOON_DESKTOP_USER_DATA 设置为另一个新的私有目录。不要删除或改写现有标识来绕过检查。';
  } else if (error?.code === 'DESKTOP_IDENTITY_INVALID') {
    message = '应用数据标识无法读取。';
    detail = '现有数据标识损坏或格式无效，无法确认它属于哪个应用通道。';
    recovery = '请先备份并检查现有数据，或将 MIOON_DESKTOP_USER_DATA 设置为一个新的私有目录。';
  } else if (error?.code === 'DESKTOP_USER_DATA_INVALID') {
    message = '数据目录路径无效。';
    detail = 'MIOON_DESKTOP_USER_DATA 必须是绝对路径。';
  } else if (error?.code === 'STORAGE_PRIVACY_UNAVAILABLE') {
    message = '此平台尚无法验证私有存储权限。';
    detail = 'Windows 私有存储还需要实现并验证当前用户 ACL 保护；0600/0700 文件模式不能代替 ACL 检查。';
    recovery = '请使用受支持的本地 POSIX 文件系统。更改目录路径或启用系统密钥库不能绕过此检查。';
  } else if (error?.reason === 'SYMBOLIC_LINK') {
    detail = '所选目录或应用文件经过符号链接。请使用真实的绝对路径，不能使用链接或路径别名。';
  } else if (error?.reason === 'SIZE_LIMIT') {
    detail = '已有应用文件超过安全读取大小限制。请先备份并检查该目录，不能直接覆盖它。';
  }
  return { type: 'error', title: '无法安全启动 Mioon', message,
    detail: `${detail}\n\n现有数据保持原样，不会自动更改权限。${recovery}`,
    buttons: ['退出'], defaultId: 0, cancelId: 0 };
}

// Linux showErrorBox before ready is stderr-only. A fresh, independently
// verified private directory lets Electron show the fatal dialog without ever
// touching the rejected userData or its normal default location. This is only
// an error-display session: no lock, workspace, settings, token or main window.
export async function showStorageStartupFailure(app, dialog, error, { temporaryRoot = tmpdir() } = {}) {
  const message = storageFailureDialog(error);
  let diagnostic, created;
  try {
    diagnostic = createPrivateTemporaryDirectory(temporaryRoot, 'mioon-startup-error-');
    created = validatePrivateDirectory(diagnostic);
    const cleanup = () => {
      try {
        const current = validatePrivateDirectory(diagnostic);
        // Never recursively remove an ambiguous/replaced path. The same-user
        // directory-swap race remains outside the OS-user isolation guarantee.
        if (current.dev === created.dev && current.ino === created.ino) rmSync(diagnostic, { recursive: true });
      } catch { /* A private diagnostic directory may remain if removal fails. */ }
    };
    app.once('quit', cleanup);
    app.setPath('userData', diagnostic);
    app.setPath('sessionData', diagnostic);
    await app.whenReady();
    await dialog.showMessageBox(message);
  } catch {
    // If a private diagnostic session cannot be established, do not become
    // ready using a default location or attempt workspace startup again.
    dialog.showErrorBox(message.title, `${message.message}\n\n${message.detail}`);
  } finally { app.exit(1); }
}

function checkDataIdentity(contents, expected) {
  let stored;
  try { stored = JSON.parse(contents); }
  catch { throw desktopStorageError('DESKTOP_IDENTITY_INVALID', 'Desktop data identity is unreadable; choose a separate MIOON_DESKTOP_USER_DATA directory'); }
  if (!stored || stored.version !== 1 || !['production', 'development'].includes(stored.channel) ||
    desktopIdentity.identityForChannel(stored.channel).appId !== stored.appId) {
    throw desktopStorageError('DESKTOP_IDENTITY_INVALID', 'Desktop data identity is unreadable; choose a separate MIOON_DESKTOP_USER_DATA directory');
  }
  if (stored.channel !== expected.channel || stored.appId !== expected.appId) {
    throw desktopStorageError('DESKTOP_CHANNEL_MISMATCH', 'Desktop data belongs to another app channel; choose a separate MIOON_DESKTOP_USER_DATA directory');
  }
}

// A deliberate path override must not silently reuse the other channel's database.
// This adds one non-secret marker; it never moves, removes or imports legacy data.
export async function ensureDataIdentity(paths, identity) {
  const expected = desktopIdentity.identityForChannel(identity.channel);
  if (expected.appId !== identity.appId) throw new Error('Invalid desktop identity');
  validateDesktopStorage(paths);
  ensurePrivateDirectory(paths.userData, { create: true });
  const file = path.join(paths.userData, 'desktop-identity.json');
  let contents = readPrivateFile(file, { root: paths.userData, maxBytes: IDENTITY_MAX_BYTES, encoding: 'utf8', allowMissing: true });
  if (contents === null) {
    try {
      writePrivateFileAtomic(file, JSON.stringify({ version: 1, channel: expected.channel, appId: expected.appId }, null, 2) + '\n',
        { root: paths.userData, maxBytes: IDENTITY_MAX_BYTES, replace: false });
      return;
    } catch (error) {
      // A concurrently created marker must still match; never overwrite it.
      contents = readPrivateFile(file, { root: paths.userData, maxBytes: IDENTITY_MAX_BYTES, encoding: 'utf8', allowMissing: true });
      if (contents === null) throw error;
    }
  }
  checkDataIdentity(contents, expected);
}

export async function readToolConfig(configFile, env = process.env) {
  let stored = {};
  const contents = readPrivateFile(configFile, { maxBytes: CONFIG_MAX_BYTES, encoding: 'utf8', allowMissing: true });
  if (contents !== null) {
    try {
      stored = JSON.parse(contents);
      if (!stored || typeof stored !== 'object' || Array.isArray(stored) ||
        ['ffmpeg', 'ffprobe'].some(key => stored[key] !== undefined && typeof stored[key] !== 'string')) throw new Error();
    } catch { throw new Error('desktop-config.json is unreadable or invalid'); }
  }
  return { ffmpeg: env.MIOON_FFMPEG_PATH || stored.ffmpeg || '', ffprobe: env.MIOON_FFPROBE_PATH || stored.ffprobe || '' };
}

export async function validateTool(file, name, { execute = runMedia, signal } = {}) {
  throwIfMediaAborted(signal);
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error(`${name} 必须指定绝对路径`);
  const resolved = await realpath(file);
  if (!(await stat(resolved)).isFile()) throw new Error(`${name} 不是可执行文件`);
  await access(resolved, constants.X_OK);
  throwIfMediaAborted(signal);
  // The shared runner supplies the least-privilege environment and bounded
  // TERM/KILL/reap phases, including when a selected executable ignores TERM.
  const stdout = await execute(resolved, ['-version'], { timeout: 10000, ...(signal ? { signal } : {}),
    maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024 });
  throwIfMediaAborted(signal);
  if (!stdout.startsWith(`${name} version `)) throw new Error(`所选文件不是 ${name}`);
  return { path: resolved, version: stdout.split('\n')[0] };
}

export async function validateTools(config, { execute = runMedia, signal } = {}) {
  const options = { execute, signal };
  const [ffmpeg, ffprobe] = await Promise.all([validateTool(config.ffmpeg, 'ffmpeg', options), validateTool(config.ffprobe, 'ffprobe', options)]);
  // Export depends on these encoders; fail before accepting editing work if unavailable.
  throwIfMediaAborted(signal);
  const stdout = await execute(ffmpeg.path, ['-hide_banner', '-encoders'], { timeout: 10000, ...(signal ? { signal } : {}),
    maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 1024 * 1024 });
  throwIfMediaAborted(signal);
  if (!/\blibx264\b/.test(stdout) || !/\baac\b/.test(stdout)) throw new Error('FFmpeg 必须包含 libx264 和 AAC 编码器');
  return { ffmpeg: ffmpeg.path, ffprobe: ffprobe.path, versions: { ffmpeg: ffmpeg.version, ffprobe: ffprobe.version } };
}

export async function saveToolConfig(file, config) {
  ensurePrivateDirectory(path.dirname(file), { create: true });
  writePrivateFileAtomic(file, JSON.stringify({ ffmpeg: config.ffmpeg, ffprobe: config.ffprobe }, null, 2) + '\n', { maxBytes: CONFIG_MAX_BYTES });
}

export function utilityEnvironment(env, tools) {
  // Never inherit Node injection options or unrelated credentials into the utility.
  const result = {};
  for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'MIOON_COMFY_MODULE',
    ...providerEnvironmentKeys]) {
    if (typeof env[key] === 'string') result[key] = env[key];
  }
  result.MIOON_FFMPEG_PATH = tools.ffmpeg;
  result.MIOON_FFPROBE_PATH = tools.ffprobe;
  return result;
}

export async function writeConnection(paths, { url, token, pid, identity }) {
  const tokenFile = path.join(paths.userData, 'mcp-token');
  const connectionFile = path.join(paths.userData, 'mcp-connection.json');
  const files = [[tokenFile, token + '\n', TOKEN_MAX_BYTES], [connectionFile, JSON.stringify({ version: 1, url, tokenFile, pid, ...(identity ? { appId: identity.appId, channel: identity.channel } : {}) }, null, 2) + '\n', CONNECTION_MAX_BYTES]];
  // Preflight both existing entries before changing either discovery file.
  for (const [file, , maxBytes] of files) validateManagedFile(file, { root: paths.userData, allowMissing: true, private: true, maxBytes });
  for (const [file, contents, maxBytes] of files) {
    writePrivateFileAtomic(file, contents, { root: paths.userData, maxBytes });
  }
  return connectionFile;
}

export async function removeConnection(paths) {
  const files = [['mcp-connection.json', CONNECTION_MAX_BYTES], ['mcp-token', TOKEN_MAX_BYTES]];
  for (const [name, maxBytes] of files) validateManagedFile(path.join(paths.userData, name), { root: paths.userData, allowMissing: true, private: true, maxBytes });
  for (const [name, maxBytes] of files) removePrivateFile(path.join(paths.userData, name), { root: paths.userData, maxBytes });
}

// The backend is already stopped when this runs. A refused privacy check must
// preserve the discovery files, not turn quit into a repeating fatal/quit loop.
// The warning is fixed text: never include native errors, paths or token bytes.
export async function removeConnectionOnShutdown(paths, { warn = message => console.warn(message) } = {}) {
  try { await removeConnection(paths); return true; }
  catch (error) {
    if (!['STORAGE_PRIVATE_REQUIRED', 'STORAGE_PRIVACY_UNAVAILABLE'].includes(error?.code)) throw error;
    try { warn('DESKTOP_DISCOVERY_CLEANUP_SKIPPED: Discovery files were preserved because storage privacy checks failed.'); } catch {}
    return false;
  }
}
