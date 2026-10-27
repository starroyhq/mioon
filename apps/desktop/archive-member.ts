import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import type {Stats} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {ChildProcessByStdio} from 'node:child_process';
import type {Readable} from 'node:stream';

const CHUNK_BYTES = 64 * 1024;
export const PACKAGE_FILE_LIMIT = 512 * 1024 * 1024;
const EXTRACTION_TIMEOUT = 120000;
export interface PackageFileDigest {bytes: number; sha256: string}
type ExtractedProcess = ChildProcessByStdio<null, Readable, Readable>;
interface ArchiveMemberOptions {
  maxBytes?: number;
  timeoutMs?: number;
  extract?: (tarball: string, member: string) => ExtractedProcess;
}
const fail = (code: string): never => {throw new Error(code);};
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function limit(value: number, ceiling: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) fail('PACKAGE_INSPECTION_LIMIT_INVALID');
  return value;
}
async function regular(file: string, maxBytes: number): Promise<Stats> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) fail('PACKAGE_FILE_UNSAFE');
  if (info.size > maxBytes) fail('PACKAGE_FILE_LIMIT_EXCEEDED');
  return info;
}
export async function hashPackageFile(file: string, maxBytes = PACKAGE_FILE_LIMIT): Promise<PackageFileDigest> {
  limit(maxBytes, PACKAGE_FILE_LIMIT);
  const before = await regular(file, maxBytes);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!same(before, await handle.stat())) fail('PACKAGE_FILE_CHANGED');
    const hash = createHash('sha256'), buffer = Buffer.alloc(CHUNK_BYTES);
    let bytes = 0;
    while (bytes < before.size) {
      const part = await handle.read(buffer, 0, Math.min(buffer.length, before.size - bytes), bytes);
      if (!part.bytesRead) fail('PACKAGE_FILE_CHANGED');
      bytes += part.bytesRead; hash.update(buffer.subarray(0, part.bytesRead));
    }
    if (!same(before, await handle.stat()) || !same(before, await lstat(file))) fail('PACKAGE_FILE_CHANGED');
    return {bytes, sha256: hash.digest('hex')};
  } finally {await handle.close();}
}
function terminate(child: ExtractedProcess): void {
  // tar may start a gzip child. The default extractor owns a detached process
  // group, so a failed bound terminates the producer and all inherited pipes.
  if (process.platform !== 'win32' && child.pid) {
    try {process.kill(-child.pid, 'SIGKILL'); return;} catch { /* already exited or injected non-detached fixture */ }
  }
  child.kill('SIGKILL');
}
async function extractedDigest(child: ExtractedProcess, expectedBytes: number, timeoutMs: number): Promise<PackageFileDigest> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256'); let bytes = 0, failure: Error | undefined;
    const stop = (code: string): void => {if (!failure) {failure = new Error(code); terminate(child);}};
    const timer = setTimeout(() => stop('ARCHIVE_EXTRACTION_TIMEOUT'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      // The reviewed native member's exact byte count is the extraction limit,
      // rather than an arbitrary stdout buffer that rejects legitimate builds.
      if (chunk.length > expectedBytes - bytes) {stop('ARCHIVE_MEMBER_LIMIT_EXCEEDED'); return;}
      bytes += chunk.length; hash.update(chunk);
    });
    child.stdout.once('error', () => stop('ARCHIVE_OUTPUT_FAILED'));
    child.stderr.once('error', () => stop('ARCHIVE_OUTPUT_FAILED'));
    child.stderr.resume();
    child.once('error', () => {clearTimeout(timer); reject(new Error('ARCHIVE_EXTRACTION_FAILED'));});
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('ARCHIVE_EXTRACTION_FAILED'));
      else if (bytes !== expectedBytes) reject(new Error('ARCHIVE_MEMBER_SIZE_MISMATCH'));
      else resolve({bytes, sha256: hash.digest('hex')});
    });
  });
}
export async function verifyArchiveMember(tarball: string, member: string, nativeFile: string, options: ArchiveMemberOptions = {}): Promise<PackageFileDigest> {
  const maxBytes = limit(options.maxBytes ?? PACKAGE_FILE_LIMIT, PACKAGE_FILE_LIMIT);
  const timeoutMs = limit(options.timeoutMs ?? EXTRACTION_TIMEOUT, EXTRACTION_TIMEOUT);
  if (!member || member.startsWith('/') || member.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0\r\n]/.test(member)) fail('ARCHIVE_MEMBER_PATH_INVALID');
  const archiveBefore = await regular(tarball, PACKAGE_FILE_LIMIT), nativeBefore = await regular(nativeFile, maxBytes);
  const expected = await hashPackageFile(nativeFile, maxBytes);
  const extract = options.extract ?? ((file: string, entry: string) => spawn('tar', ['-xOzf', file, '--', entry], {stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'}));
  const actual = await extractedDigest(extract(tarball, member), expected.bytes, timeoutMs);
  if (!same(archiveBefore, await lstat(tarball)) || !same(nativeBefore, await lstat(nativeFile))) fail('PACKAGE_FILE_CHANGED');
  if (actual.sha256 !== expected.sha256) fail('ARCHIVE_MEMBER_SHA256_MISMATCH');
  return actual;
}
