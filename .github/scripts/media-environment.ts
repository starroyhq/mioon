import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access, mkdir, realpath, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export type TargetPlatform = 'linux' | 'darwin';
export type TargetArch = 'x64' | 'arm64';
export interface Check {name: string; ok: true}
export class CheckFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'CheckFailure'; this.code = code; }
}
export function fail(code: string): never { throw new CheckFailure(code); }
export function safeFailure(error: unknown): string { return error instanceof CheckFailure ? error.code : 'UNEXPECTED_CHECK_FAILURE'; }
export function argumentsFor(args: readonly string[], required: readonly string[], optional: readonly string[] = []): Record<string, string> {
  const values: Record<string, string> = {};
  for (const arg of args) {
    const match = /^--([a-z][a-z-]*)=(.+)$/.exec(arg);
    if (!match || ![...required, ...optional].includes(match[1]) || Object.hasOwn(values, match[1]) || /[\0\r\n]/.test(match[2])) fail('INVALID_ARGUMENTS');
    values[match[1]] = match[2];
  }
  if (required.some(name => !values[name])) fail('MISSING_ARGUMENTS');
  return values;
}
export function targetPlatform(value: string): TargetPlatform { if (value !== 'linux' && value !== 'darwin') fail('UNSUPPORTED_PLATFORM'); return value; }
export function targetArch(value: string): TargetArch { if (value !== 'x64' && value !== 'arm64') fail('UNSUPPORTED_ARCHITECTURE'); return value; }
export function cleanEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMROOT', 'WINDIR']) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}
const exec = promisify(execFile);
export async function command(file: string, args: readonly string[], code: string, options: {timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string} = {}): Promise<string> {
  const timeout = options.timeout ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 180000) fail('INVALID_COMMAND_TIMEOUT');
  try {
    const result = await exec(file, [...args], {encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: options.env ?? cleanEnvironment(), cwd: options.cwd});
    return result.stdout + result.stderr;
  } catch { fail(code); }
}
export async function executable(name: string, override?: string): Promise<string> {
  const candidates = override ? [override] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try the next PATH entry. */ }
  }
  fail(`MISSING_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`);
}
export async function report(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), {recursive: true});
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
}
export function isMain(moduleUrl: string): boolean { return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl); }
export function mediaCapabilities(platform: TargetPlatform, filters: string, encoders: string): {filters: Record<string, boolean>; encoders: Record<string, boolean>} {
  const requiredFilters = platform === 'linux' ? ['drawtext', 'subtitles', 'zscale', 'loudnorm', 'ebur128'] : [];
  const requiredEncoders = platform === 'linux' ? ['libx264', 'aac', 'libwebp', 'libwebp_anim'] : ['libx264', 'aac'];
  const has = (text: string, name: string): boolean => new RegExp(`^\\s*[A-Z.]{3,6}\\s+${name}\\s`, 'm').test(text);
  return {filters: Object.fromEntries(requiredFilters.map(name => [name, has(filters, name)])), encoders: Object.fromEntries(requiredEncoders.map(name => [name, has(encoders, name)]))};
}
export async function inspectMedia(platform: TargetPlatform): Promise<Record<string, unknown>> {
  const ffmpeg = await executable('ffmpeg', process.env.MIOON_FFMPEG_PATH), ffprobe = await executable('ffprobe', process.env.MIOON_FFPROBE_PATH);
  const version = await command(ffmpeg, ['-version'], 'FFMPEG_VERSION_FAILED');
  const probeVersion = await command(ffprobe, ['-version'], 'FFPROBE_VERSION_FAILED');
  if (!version.startsWith('ffmpeg version ') || !probeVersion.startsWith('ffprobe version ')) fail('INVALID_MEDIA_TOOL');
  const filters = await command(ffmpeg, ['-hide_banner', '-filters'], 'FFMPEG_FILTER_PROBE_FAILED');
  const encoders = await command(ffmpeg, ['-hide_banner', '-encoders'], 'FFMPEG_ENCODER_PROBE_FAILED');
  const capabilities = mediaCapabilities(platform, filters, encoders);
  if (Object.values(capabilities.filters).includes(false) || Object.values(capabilities.encoders).includes(false)) fail('REQUIRED_MEDIA_CAPABILITY_MISSING');
  if (platform === 'linux' && !(await command('tar', ['--version'], 'GNU_TAR_PROBE_FAILED')).startsWith('tar (GNU tar)')) fail('GNU_TAR_REQUIRED');
  return {ok: true, platform, tools: {ffmpeg, ffprobe}, versions: {ffmpeg: version.split('\n')[0], ffprobe: probeVersion.split('\n')[0]}, capabilities, gnuTar: platform === 'linux'};
}
if (isMain(import.meta.url)) {
  let output: string | undefined;
  try {
    const args = argumentsFor(process.argv.slice(2), ['platform', 'output']); output = args.output;
    await report(output, await inspectMedia(targetPlatform(args.platform)));
  } catch (error) {
    if (output) await report(output, {ok: false, error: safeFailure(error)});
    console.error(safeFailure(error)); process.exitCode = 1;
  }
}
