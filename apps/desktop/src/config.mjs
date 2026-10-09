import path from 'node:path';
import desktopIdentity from '../identity.cjs';
import {providerEnvironmentKeys} from '@video-workbench/business';
import { readFile, writeFile, mkdir, rename, stat, access, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function dataPaths(appDataPath, override, channel = 'development') {
  const identity = desktopIdentity.identityForChannel(channel);
  if (override && !path.isAbsolute(override)) throw new Error('WB_DESKTOP_USER_DATA must be an absolute path');
  const userData = override || path.join(appDataPath, identity.appId);
  return { userData, dataDir: path.join(userData, 'workspace'), configFile: path.join(userData, 'desktop-config.json') };
}

// A deliberate path override must not silently reuse the other channel's database.
// This adds one non-secret marker; it never moves, removes or imports legacy data.
export async function ensureDataIdentity(paths, identity) {
  const expected = desktopIdentity.identityForChannel(identity.channel);
  if (expected.appId !== identity.appId) throw new Error('Invalid desktop identity');
  await mkdir(paths.userData, { recursive: true, mode: 0o700 });
  const file = path.join(paths.userData, 'desktop-identity.json');
  try {
    await writeFile(file, JSON.stringify({ version: 1, channel: expected.channel, appId: expected.appId }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stored;
    try { stored = JSON.parse(await readFile(file, 'utf8')); }
    catch { throw new Error('Desktop data identity is unreadable; choose a separate WB_DESKTOP_USER_DATA directory'); }
    if (stored.version !== 1 || stored.channel !== expected.channel || stored.appId !== expected.appId) {
      throw new Error('Desktop data belongs to another app channel; choose a separate WB_DESKTOP_USER_DATA directory');
    }
  }
}

export async function readToolConfig(configFile, env = process.env) {
  let stored = {};
  try { stored = JSON.parse(await readFile(configFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('desktop-config.json is unreadable or invalid'); }
  return { ffmpeg: env.WB_FFMPEG_PATH || stored.ffmpeg || '', ffprobe: env.WB_FFPROBE_PATH || stored.ffprobe || '' };
}

export async function validateTool(file, name) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error(`${name} 必须指定绝对路径`);
  const resolved = await realpath(file);
  if (!(await stat(resolved)).isFile()) throw new Error(`${name} 不是可执行文件`);
  await access(resolved, constants.X_OK);
  const { stdout } = await exec(resolved, ['-version'], { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (!stdout.startsWith(`${name} version `)) throw new Error(`所选文件不是 ${name}`);
  return { path: resolved, version: stdout.split('\n')[0] };
}

export async function validateTools(config) {
  const [ffmpeg, ffprobe] = await Promise.all([validateTool(config.ffmpeg, 'ffmpeg'), validateTool(config.ffprobe, 'ffprobe')]);
  // Export depends on these encoders; fail before accepting editing work if unavailable.
  const { stdout } = await exec(ffmpeg.path, ['-hide_banner', '-encoders'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (!/\blibx264\b/.test(stdout) || !/\baac\b/.test(stdout)) throw new Error('FFmpeg 必须包含 libx264 和 AAC 编码器');
  return { ffmpeg: ffmpeg.path, ffprobe: ffprobe.path, versions: { ffmpeg: ffmpeg.version, ffprobe: ffprobe.version } };
}

export async function saveToolConfig(file, config) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify({ ffmpeg: config.ffmpeg, ffprobe: config.ffprobe }, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}

export function utilityEnvironment(env, tools) {
  // Never inherit Node injection options or unrelated credentials into the utility.
  const result = {};
  for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR',
    ...providerEnvironmentKeys]) {
    if (typeof env[key] === 'string') result[key] = env[key];
  }
  result.WB_FFMPEG_PATH = tools.ffmpeg;
  result.WB_FFPROBE_PATH = tools.ffprobe;
  return result;
}

export async function writeConnection(paths, { url, token, pid, identity }) {
  const tokenFile = path.join(paths.userData, 'mcp-token');
  const connectionFile = path.join(paths.userData, 'mcp-connection.json');
  for (const [file, contents] of [[tokenFile, token + '\n'], [connectionFile, JSON.stringify({ version: 1, url, tokenFile, pid, ...(identity ? { appId: identity.appId, channel: identity.channel } : {}) }, null, 2) + '\n']]) {
    const temp = `${file}.tmp`;
    await rm(temp, { force: true });
    await writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  }
  return connectionFile;
}

export async function removeConnection(paths) {
  await Promise.all(['mcp-connection.json', 'mcp-token'].map(name => rm(path.join(paths.userData, name), { force: true })));
}
