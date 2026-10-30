import { nativeText as nt } from './app-language-text.ts';
import path from 'node:path';
import type {Stats} from 'node:fs';
import type {App, Dialog, MessageBoxOptions} from 'electron';
import desktopIdentity from '../identity.ts';
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
export type DesktopChannel = 'production' | 'development';
/** The reviewed build identity; values come from identity.ts, never the environment. */
export interface DesktopIdentity {
  readonly channel: DesktopChannel;
  readonly appId: string;
  readonly productName: string;
  readonly executableName: string;
}
export interface DesktopPaths {
  readonly userData: string;
  readonly dataDir: string;
  readonly configFile: string;
}
export interface ToolPaths { readonly ffmpeg: string; readonly ffprobe: string }
export interface ToolValidation { readonly ffmpeg: string; readonly ffprobe: string; readonly versions: ToolPaths }
interface StorageFailureDialog extends MessageBoxOptions {
  readonly type: 'error'; readonly title: string; readonly message: string; readonly detail: string;
  readonly buttons: string[]; readonly defaultId: number; readonly cancelId: number;
}
interface CodedFailure { readonly code?: string; readonly reason?: string }
function codedFailure(error: unknown): CodedFailure {
  return error !== null && typeof error === 'object' ? error as CodedFailure : {};
}
function errorMessage(error: unknown): string {
  const message = error !== null && typeof error === 'object' && 'message' in error ? error.message : error;
  return typeof message === 'string' ? message : 'Unknown error';
}
function privateText(contents: Buffer | string | null): string | null {
  if (contents === null) return null;
  return typeof contents === 'string' ? contents : contents.toString('utf8');
}
const desktopStorageError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** The Windows ACL helper ships outside ASAR: under resources/native when
 * packaged, beside the staged bundles otherwise. Only main names it. */
export const PRIVATE_STORAGE_HELPER = 'mioon_private_storage.node';
export function privateStorageHelperFile(app: Pick<App, 'isPackaged' | 'getAppPath'>, resourcesPath: string = process.resourcesPath): string {
  return path.join(app.isPackaged ? resourcesPath : app.getAppPath(), 'native', PRIVATE_STORAGE_HELPER);
}

export function dataPaths(appDataPath: string, override?: string, channel: DesktopChannel = 'development'): DesktopPaths {
  const identity: DesktopIdentity = desktopIdentity.identityForChannel(channel);
  if (override && !path.isAbsolute(override)) throw desktopStorageError('DESKTOP_USER_DATA_INVALID', 'MIOON_DESKTOP_USER_DATA must be an absolute path');
  const userData = override || path.join(appDataPath, identity.appId);
  return { userData, dataDir: path.join(userData, 'workspace'), configFile: path.join(userData, 'desktop-config.json') };
}

// Must run synchronously before Electron can write caches or a single-instance
// lock. Existing directories are inspected, never repaired implicitly.
export function prepareDesktopStorage(app: App, override?: string, channel: DesktopChannel = 'development'): DesktopPaths {
  const paths = dataPaths(app.getPath('appData'), override, channel);
  validateDesktopStorage(paths);
  const identity: DesktopIdentity = desktopIdentity.identityForChannel(channel);
  const contents = privateText(readPrivateFile(path.join(paths.userData, 'desktop-identity.json'),
    { root: paths.userData, maxBytes: IDENTITY_MAX_BYTES, encoding: 'utf8', allowMissing: true }));
  if (contents !== null) checkDataIdentity(contents, identity);
  ensurePrivateDirectory(paths.userData, { create: true });
  app.setPath('userData', paths.userData);
  return paths;
}

export function validateDesktopStorage(paths: DesktopPaths): void {
  if (!validatePrivateDirectory(paths.userData, { allowMissing: true })) return;
  for (const [name, maxBytes] of [['desktop-identity.json', IDENTITY_MAX_BYTES], ['desktop-config.json', CONFIG_MAX_BYTES],
    ['app-preferences.json', 4096], ['mcp-token', TOKEN_MAX_BYTES], ['mcp-connection.json', CONNECTION_MAX_BYTES]] as const) {
    validateManagedFile(path.join(paths.userData, name), { root: paths.userData, private: true, allowMissing: true, maxBytes });
  }
  const directory = path.join(paths.userData, 'agent-settings');
  if (validateManagedDirectory(directory, { root: paths.userData, private: true, allowMissing: true })) {
    validateManagedFile(path.join(directory, 'settings.json'), { root: directory, private: true, allowMissing: true, maxBytes: 64 * 1024 });
  }
  validateWorkspaceStorage(paths.dataDir);
}

export function storageFailureDialog(error: unknown): StorageFailureDialog {
  const failure = codedFailure(error);
  let message = nt('native.storageMessage');
  let detail = nt('native.storageDetail');
  let recovery = nt('native.storageRecovery');
  if (failure.code === 'DESKTOP_CHANNEL_MISMATCH') {
    message = nt('native.channelMessage');
    detail = nt('native.channelDetail');
    recovery = nt('native.channelRecovery');
  } else if (failure.code === 'DESKTOP_IDENTITY_INVALID') {
    message = nt('native.identityMessage');
    detail = nt('native.identityDetail');
    recovery = nt('native.identityRecovery');
  } else if (failure.code === 'DESKTOP_USER_DATA_INVALID') {
    message = nt('native.pathMessage');
    detail = nt('native.pathDetail');
  } else if (failure.code === 'STORAGE_PRIVACY_UNAVAILABLE' && failure.reason === 'WINDOWS_HELPER_UNAVAILABLE') {
    // Windows storage is implemented; only the helper this app ships is absent.
    message = nt('native.windowsHelperMessage');
    detail = nt('native.windowsHelperDetail');
    recovery = nt('native.windowsHelperRecovery');
  } else if (failure.code === 'STORAGE_PRIVACY_UNAVAILABLE') {
    message = nt('native.privacyMessage');
    detail = nt('native.privacyDetail');
    recovery = nt('native.privacyRecovery');
  } else if (failure.reason === 'SYMBOLIC_LINK') {
    detail = nt('native.linkDetail');
  } else if (failure.reason === 'SIZE_LIMIT') {
    detail = nt('native.sizeDetail');
  }
  return { type: 'error', title: nt('native.storageTitle'), message,
    detail: `${detail}\n\n${nt('native.storagePreserved')}\n${recovery}`,
    buttons: [nt('native.quit')], defaultId: 0, cancelId: 0 };
}

// Linux showErrorBox before ready is stderr-only. A fresh, independently
// verified private directory lets Electron show the fatal dialog without ever
// touching the rejected userData or its normal default location. This is only
// an error-display session: no lock, workspace, settings, token or main window.
export async function showStorageStartupFailure(app: App, dialog: Dialog, error: unknown, { temporaryRoot = tmpdir() }: {temporaryRoot?: string} = {}): Promise<void> {
  const message = storageFailureDialog(error);
  let diagnostic: string;
  let created: Stats | null;
  try {
    diagnostic = createPrivateTemporaryDirectory(temporaryRoot, 'mioon-startup-error-');
    created = validatePrivateDirectory(diagnostic);
    const cleanup = () => {
      try {
        const current = validatePrivateDirectory(diagnostic);
        // Never recursively remove an ambiguous/replaced path. The same-user
        // directory-swap race remains outside the OS-user isolation guarantee.
        if (current && created && current.dev === created.dev && current.ino === created.ino) rmSync(diagnostic, { recursive: true });
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

function checkDataIdentity(contents: string, expected: DesktopIdentity): void {
  let stored: unknown;
  try { stored = JSON.parse(contents); }
  catch { throw desktopStorageError('DESKTOP_IDENTITY_INVALID', 'Desktop data identity is unreadable; choose a separate MIOON_DESKTOP_USER_DATA directory'); }
  const record = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : null;
  const channel = record?.channel;
  if (!record || record.version !== 1 || (channel !== 'production' && channel !== 'development') ||
    desktopIdentity.identityForChannel(channel).appId !== record.appId) {
    throw desktopStorageError('DESKTOP_IDENTITY_INVALID', 'Desktop data identity is unreadable; choose a separate MIOON_DESKTOP_USER_DATA directory');
  }
  if (record.channel !== expected.channel || record.appId !== expected.appId) {
    throw desktopStorageError('DESKTOP_CHANNEL_MISMATCH', 'Desktop data belongs to another app channel; choose a separate MIOON_DESKTOP_USER_DATA directory');
  }
}

// A deliberate path override must not silently reuse the other channel's database.
// This adds one non-secret marker; it never moves, removes or imports legacy data.
export async function ensureDataIdentity(paths: DesktopPaths, identity: DesktopIdentity): Promise<void> {
  const expected: DesktopIdentity = desktopIdentity.identityForChannel(identity.channel);
  if (expected.appId !== identity.appId) throw new Error('Invalid desktop identity');
  validateDesktopStorage(paths);
  ensurePrivateDirectory(paths.userData, { create: true });
  const file = path.join(paths.userData, 'desktop-identity.json');
  let contents = privateText(readPrivateFile(file, { root: paths.userData, maxBytes: IDENTITY_MAX_BYTES, encoding: 'utf8', allowMissing: true }));
  if (contents === null) {
    try {
      writePrivateFileAtomic(file, JSON.stringify({ version: 1, channel: expected.channel, appId: expected.appId }, null, 2) + '\n',
        { root: paths.userData, maxBytes: IDENTITY_MAX_BYTES, replace: false });
      return;
    } catch (error) {
      // A concurrently created marker must still match; never overwrite it.
      contents = privateText(readPrivateFile(file, { root: paths.userData, maxBytes: IDENTITY_MAX_BYTES, encoding: 'utf8', allowMissing: true }));
      if (contents === null) throw error;
    }
  }
  checkDataIdentity(contents, expected);
}

export async function readToolConfig(configFile: string, env: NodeJS.ProcessEnv = process.env): Promise<ToolPaths> {
  let stored: Record<string, unknown> = {};
  const contents = privateText(readPrivateFile(configFile, { maxBytes: CONFIG_MAX_BYTES, encoding: 'utf8', allowMissing: true }));
  if (contents !== null) {
    try {
      const parsed: unknown = JSON.parse(contents);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        ['ffmpeg', 'ffprobe'].some(key => (parsed as Record<string, unknown>)[key] !== undefined && typeof (parsed as Record<string, unknown>)[key] !== 'string')) throw new Error();
      stored = parsed as Record<string, unknown>;
    } catch { throw new Error('desktop-config.json is unreadable or invalid'); }
  }
  const ffmpeg = typeof stored.ffmpeg === 'string' ? stored.ffmpeg : '';
  const ffprobe = typeof stored.ffprobe === 'string' ? stored.ffprobe : '';
  return { ffmpeg: env.MIOON_FFMPEG_PATH || ffmpeg, ffprobe: env.MIOON_FFPROBE_PATH || ffprobe };
}

export async function validateTool(file: string, name: string, { execute = runMedia, signal }: {
  execute?: typeof runMedia; signal?: AbortSignal;
} = {}): Promise<{path: string; version: string}> {
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

export async function validateTools(config: ToolPaths, { execute = runMedia, signal }: {
  execute?: typeof runMedia; signal?: AbortSignal;
} = {}): Promise<ToolValidation> {
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

export async function saveToolConfig(file: string, config: ToolPaths): Promise<void> {
  ensurePrivateDirectory(path.dirname(file), { create: true });
  writePrivateFileAtomic(file, JSON.stringify({ ffmpeg: config.ffmpeg, ffprobe: config.ffprobe }, null, 2) + '\n', { maxBytes: CONFIG_MAX_BYTES });
}

export function utilityEnvironment(env: NodeJS.ProcessEnv, tools: ToolPaths, storageHelper?: string): Record<string, string> {
  // Never inherit Node injection options or unrelated credentials into the utility.
  const result: Record<string, string> = {};
  for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'MIOON_COMFY_MODULE',
    ...providerEnvironmentKeys]) {
    const value = env[key];
    if (typeof value === 'string') result[key] = value;
  }
  result.MIOON_FFMPEG_PATH = tools.ffmpeg;
  result.MIOON_FFPROBE_PATH = tools.ffprobe;
  // Windows only: the backend registers the same helper main verified.
  if (storageHelper) result.MIOON_DESKTOP_PRIVATE_STORAGE_HELPER = storageHelper;
  return result;
}

export async function writeConnection(paths: DesktopPaths, { url, token, pid, identity }: {
  url: string; token: string; pid: number; identity?: DesktopIdentity;
}): Promise<string> {
  const tokenFile = path.join(paths.userData, 'mcp-token');
  const connectionFile = path.join(paths.userData, 'mcp-connection.json');
  const files: Array<[file: string, contents: string, maxBytes: number]> = [
    [tokenFile, token + '\n', TOKEN_MAX_BYTES],
    [connectionFile, JSON.stringify({ version: 1, url, tokenFile, pid, ...(identity ? { appId: identity.appId, channel: identity.channel } : {}) }, null, 2) + '\n', CONNECTION_MAX_BYTES]
  ];
  // Preflight both existing entries before changing either discovery file.
  for (const [file, , maxBytes] of files) validateManagedFile(file, { root: paths.userData, allowMissing: true, private: true, maxBytes });
  for (const [file, contents, maxBytes] of files) {
    writePrivateFileAtomic(file, contents, { root: paths.userData, maxBytes });
  }
  return connectionFile;
}

export async function removeConnection(paths: DesktopPaths): Promise<void> {
  // Only transient discovery files belong to the backend lifetime. App-level
  // language preferences must survive service restart and application quit.
  const files: Array<[name: string, maxBytes: number]> = [['mcp-connection.json', CONNECTION_MAX_BYTES], ['mcp-token', TOKEN_MAX_BYTES]];
  for (const [name, maxBytes] of files) validateManagedFile(path.join(paths.userData, name), { root: paths.userData, allowMissing: true, private: true, maxBytes });
  for (const [name, maxBytes] of files) removePrivateFile(path.join(paths.userData, name), { root: paths.userData, maxBytes });
}

// The backend is already stopped when this runs. A refused privacy check must
// preserve the discovery files, not turn quit into a repeating fatal/quit loop.
// The warning is fixed text: never include native errors, paths or token bytes.
export async function removeConnectionOnShutdown(paths: DesktopPaths, { warn = (message: string) => console.warn(message) }: {
  warn?: (message: string) => void;
} = {}): Promise<boolean> {
  try { await removeConnection(paths); return true; }
  catch (error) {
    const code = codedFailure(error).code;
    if (code !== 'STORAGE_PRIVATE_REQUIRED' && code !== 'STORAGE_PRIVACY_UNAVAILABLE') throw error;
    try { warn('DESKTOP_DISCOVERY_CLEANUP_SKIPPED: Discovery files were preserved because storage privacy checks failed.'); } catch {}
    return false;
  }
}

// Small independent app preference document, outside workspace backups.
export function readAppLanguagePreference(paths: DesktopPaths): string | null {
  return privateText(readPrivateFile(path.join(paths.userData, 'app-preferences.json'), { root: paths.userData, maxBytes: 4096, encoding: 'utf8', allowMissing: true }));
}
export function writeAppLanguagePreference(paths: DesktopPaths, text: string): void {
  writePrivateFileAtomic(path.join(paths.userData, 'app-preferences.json'), text, { root: paths.userData, maxBytes: 4096 });
}
