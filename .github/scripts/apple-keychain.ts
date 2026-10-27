import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {constants} from 'node:fs';
import type {Stats} from 'node:fs';
import {lstat, open, realpath, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const MAX_BYTES = 64 * 1024, MAX_KEYCHAINS = 256;
export const SECURITY_COMMAND_OPTIONS = Object.freeze({timeout:30000,maxBuffer:MAX_BYTES});
export type SecurityExecute = (file: string, args: readonly string[], options: typeof SECURITY_COMMAND_OPTIONS) => Promise<string>;
class KeychainFailure extends Error {}
function fail(code: string): never {throw new KeychainFailure(code);}
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
export function absoluteKeychainPath(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail('APPLE_KEYCHAIN_PATH_INVALID');
  return value;
}
export function parseSearchList(output: string): string[] {
  if (Buffer.byteLength(output) > MAX_BYTES) fail('APPLE_KEYCHAIN_RESPONSE_INVALID');
  const lines = output.split(/\r?\n/).filter(line => line.trim());
  if (lines.length > MAX_KEYCHAINS) fail('APPLE_KEYCHAIN_RESPONSE_INVALID');
  return lines.map(line => {
    let value: unknown;
    try {value = JSON.parse(line.trim()) as unknown;} catch {fail('APPLE_KEYCHAIN_RESPONSE_INVALID');}
    return absoluteKeychainPath(value);
  });
}
const exec = promisify(execFile);
const securityExecute: SecurityExecute = async (file, args, options) => {
  if (process.platform !== 'darwin') fail('APPLE_KEYCHAIN_MACOS_REQUIRED');
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL']) if (process.env[key] !== undefined) env[key] = process.env[key];
  try {
    const result = await exec(file, [...args], {...options,encoding:'utf8',killSignal:'SIGKILL',env});
    if (result.stderr.trim()) fail('APPLE_KEYCHAIN_COMMAND_FAILED');
    return result.stdout;
  } catch {fail('APPLE_KEYCHAIN_COMMAND_FAILED');}
};
async function run(execute: SecurityExecute, args: readonly string[], code: string): Promise<string> {
  try {
    const output = await execute('/usr/bin/security', args, SECURITY_COMMAND_OPTIONS);
    if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_BYTES) fail('APPLE_KEYCHAIN_RESPONSE_INVALID');
    return output;
  } catch (error) {if (error instanceof KeychainFailure) throw error; fail(code);}
}
async function privateParent(file: string): Promise<void> {
  const parent = path.dirname(absoluteKeychainPath(file)), info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent ||
      (process.platform !== 'win32' && ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()))) fail('APPLE_KEYCHAIN_STATE_DIRECTORY_INVALID');
}
interface SavedList {keychains: string[]; identity: Stats}
async function readState(file: string): Promise<SavedList | undefined> {
  absoluteKeychainPath(file);
  let before: Stats;
  try {before = await lstat(file);} catch (error) {if (missing(error)) return undefined; throw error;}
  await privateParent(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > MAX_BYTES ||
      (process.platform !== 'win32' && ((before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.()))) fail('APPLE_KEYCHAIN_STATE_INVALID');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!same(before, await handle.stat())) fail('APPLE_KEYCHAIN_STATE_CHANGED');
    const buffer = Buffer.alloc(MAX_BYTES+1); let bytes = 0;
    while (bytes < buffer.length) {const part = await handle.read(buffer, bytes, buffer.length-bytes, bytes); if (!part.bytesRead) break; bytes += part.bytesRead;}
    if (bytes !== before.size || !same(before, await handle.stat()) || !same(before, await lstat(file))) fail('APPLE_KEYCHAIN_STATE_CHANGED');
    let value: unknown;
    try {value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytes))) as unknown;} catch {fail('APPLE_KEYCHAIN_STATE_INVALID');}
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('keychains' in value) || !Array.isArray(value.keychains) || value.keychains.length > MAX_KEYCHAINS) fail('APPLE_KEYCHAIN_STATE_INVALID');
    return {keychains:value.keychains.map(absoluteKeychainPath),identity:before};
  } finally {await handle.close();}
}
async function setSearchList(keychains: readonly string[], execute: SecurityExecute, code: string): Promise<void> {
  const output = await run(execute, ['list-keychains','-d','user','-s',...keychains], code);
  if (output.trim()) fail('APPLE_KEYCHAIN_RESPONSE_INVALID');
}
export async function captureSearchList(state: string, execute: SecurityExecute = securityExecute): Promise<void> {
  await privateParent(state);
  try {await lstat(state); fail('APPLE_KEYCHAIN_STATE_EXISTS');} catch (error) {if (!missing(error)) throw error;}
  const keychains = parseSearchList(await run(execute, ['list-keychains','-d','user'], 'APPLE_KEYCHAIN_CAPTURE_FAILED'));
  const content = JSON.stringify({keychains})+'\n';
  if (Buffer.byteLength(content) > MAX_BYTES) fail('APPLE_KEYCHAIN_STATE_INVALID');
  await writeFile(state, content, {flag:'wx',mode:0o600});
}
export async function activateSearchList(state: string, keychain: string, execute: SecurityExecute = securityExecute): Promise<void> {
  const saved = await readState(state); if (!saved) fail('APPLE_KEYCHAIN_STATE_MISSING');
  absoluteKeychainPath(keychain); await privateParent(keychain);
  const info = await lstat(keychain);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) fail('APPLE_KEYCHAIN_FILE_INVALID');
  const keychains = [...new Set([keychain,...saved.keychains])];
  if (keychains.length > MAX_KEYCHAINS) fail('APPLE_KEYCHAIN_RESPONSE_INVALID');
  await setSearchList(keychains, execute, 'APPLE_KEYCHAIN_ACTIVATE_FAILED');
}
export async function restoreSearchList(state: string, execute: SecurityExecute = securityExecute): Promise<void> {
  const saved = await readState(state); if (!saved) return;
  await setSearchList(saved.keychains, execute, 'APPLE_KEYCHAIN_RESTORE_FAILED');
  if (!same(saved.identity, await lstat(state))) fail('APPLE_KEYCHAIN_STATE_CHANGED');
  await unlink(state);
}
export async function main(args = process.argv.slice(2), execute: SecurityExecute = securityExecute): Promise<void> {
  const [command,...flags] = args, values = new Map<string,string>();
  if (!['capture','activate','restore'].includes(command ?? '')) fail('APPLE_KEYCHAIN_ARGUMENTS_INVALID');
  for (const flag of flags) {
    const match = /^--(state|keychain)=(.+)$/.exec(flag);
    if (!match || values.has(match[1]!) || (match[1] === 'keychain' && command !== 'activate')) fail('APPLE_KEYCHAIN_ARGUMENTS_INVALID');
    values.set(match[1]!, absoluteKeychainPath(match[2]));
  }
  const state = values.get('state'); if (!state) fail('APPLE_KEYCHAIN_ARGUMENTS_INVALID');
  if (command === 'capture') await captureSearchList(state, execute);
  else if (command === 'restore') await restoreSearchList(state, execute);
  else {const keychain = values.get('keychain'); if (!keychain) fail('APPLE_KEYCHAIN_ARGUMENTS_INVALID'); await activateSearchList(state,keychain,execute);}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {process.stderr.write(`${error instanceof KeychainFailure ? error.message : 'APPLE_KEYCHAIN_FAILED'}\n`); process.exitCode=1;});
}
