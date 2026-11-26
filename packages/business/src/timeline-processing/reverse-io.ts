import {constants} from 'node:fs';
import type {Stats} from 'node:fs';
import {open} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import type {Readable, Writable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {mediaExecutable} from '../media-environment.ts';
import {checkMediaEffect} from '../media-runtime.ts';
import {interruptedMediaError, mediaInterrupted, onMediaInterruption, spawnMedia, terminateMediaProcess} from '../media-processes.ts';
import {checkDirectoryIdentity, checkedDirectory, inspectFile, removeOwnedFile, sameNode, streamFile} from '../managed-file-io.ts';

export interface ReverseProxyMediaOptions {
  readonly signal: AbortSignal;
  readonly ownerSignal?: AbortSignal;
  readonly beforeEffect: () => void;
}

interface ReverseMediaError extends Error {code: string; terminationUnconfirmed?: boolean}
export function reverseError(code: 'SOURCE_UNAVAILABLE' | 'DISK_FULL' | 'CACHE_LIMIT' | 'UNSUPPORTED_FORMAT' | 'PROCESSING_FAILED'): ReverseMediaError {
  const text = {
    SOURCE_UNAVAILABLE: 'The source for the reverse proxy is unavailable.',
    DISK_FULL: 'There is not enough disk space for the reverse proxy.',
    CACHE_LIMIT: 'The reverse proxy exceeds its cache reservation.',
    UNSUPPORTED_FORMAT: 'The source does not match a lossless reverse proxy profile.',
    PROCESSING_FAILED: 'The local reverse proxy could not be verified.',
  };
  return Object.assign(new Error(text[code]), {code});
}

const diskFull = /No space left on device|not enough space on the disk|disk full|disk quota exceeded/i;
export function isDiskFull(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error.code === 'ENOSPC' || error.code === 'EDQUOT'));
}

type ReverseMediaTool = 'ffmpeg' | 'ffprobe';
interface ReverseToolIO {
  readonly stdin?: (stream: Writable) => Promise<void>;
  readonly stdout?: (chunk: Buffer) => Promise<void> | void;
  readonly outputFd?: number;
  readonly stdoutLimit?: number;
  readonly stderrLine?: (line: string) => void;
  readonly timeoutMs?: number;
  readonly onFailure?: (error: unknown) => void;
}

async function pump(stream: Readable, onChunk: (chunk: Buffer) => Promise<void> | void): Promise<void> {
  for await (const chunk of stream as AsyncIterable<Buffer>) await onChunk(chunk);
}

/** Direct owned FFmpeg pipes. A chunk is handled before the next pull, and
 * only the exact child is interrupted. The shared deadline confirms its close. */
export async function runReverseTool(tool: ReverseMediaTool, args: string[], options: ReverseProxyMediaOptions, io: ReverseToolIO = {}): Promise<void> {
  const {signal, ownerSignal, beforeEffect} = options;
  const fence = () => checkMediaEffect(beforeEffect, signal);
  fence();
  const child = spawnMedia(mediaExecutable(tool), args, {stdio: [
    io.stdin ? 'pipe' : 'ignore', io.outputFd ?? (io.stdout ? 'pipe' : 'ignore'), 'pipe',
  ]}, {kind: tool, signal, ownerSignal});
  let failure: unknown;
  let stderrText = '', stderrBytes = 0, stdoutBytes = 0, outOfSpace = false;
  let stopping: Promise<never> | undefined;
  let wakeStop: (result: Promise<never>) => void = () => {};
  const stopped = new Promise<never>(resolve => {wakeStop = resolve;});
  const stop = (error: unknown): void => {
    if (stopping) return;
    failure = error;
    // Announce after terminateMediaProcess installs its own stop promise.
    // A sibling abort may synchronously notify this same observer.
    stopping = Promise.resolve().then(async () => {
      const termination = await terminateMediaProcess(child);
      child.stdin?.destroy();
      if (termination.status !== 'exited') {
        const unconfirmed: ReverseMediaError = Object.assign(reverseError('PROCESSING_FAILED'), {terminationUnconfirmed: true});
        throw unconfirmed;
      }
      throw outOfSpace ? reverseError('DISK_FULL') : failure;
    });
    wakeStop(stopping);
    try {io.onFailure?.(failure);}
    catch { /* A stop observer cannot interrupt confirmation. */ }
  };
  const terminal = new Promise<void>((resolve, reject) => {
    child.once('close', (code, sig) => {
      if (failure) {reject(failure); return;}
      if (signal.aborted || mediaInterrupted(child)) {reject(interruptedMediaError()); return;}
      if (outOfSpace) {reject(reverseError('DISK_FULL')); return;}
      if (code !== 0 || sig !== null) {reject(reverseError('PROCESSING_FAILED')); return;}
      resolve();
    });
    child.once('error', () => stop(reverseError('PROCESSING_FAILED')));
  });
  // EPIPE is reported by write/end as well, but Node's pipe still emits error.
  child.stdin?.on('error', () => {});
  const removeObserver = onMediaInterruption(child, () => stop(interruptedMediaError()));
  const timeout = setTimeout(() => stop(reverseError('PROCESSING_FAILED')), io.timeoutMs ?? 120_000);
  timeout.unref();
  const stderr = pump(child.stderr!, chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > (io.stderrLine ? 4 * 1024 * 1024 : 128 * 1024)) throw reverseError('PROCESSING_FAILED');
    stderrText += chunk.toString('utf8');
    const lines = stderrText.split(/\r?\n/);
    stderrText = lines.pop() ?? '';
    if (stderrText.length > 24 * 1024) throw reverseError('PROCESSING_FAILED');
    for (const line of lines) {
      outOfSpace ||= diskFull.test(line);
      io.stderrLine?.(line);
    }
  }).then(() => {
    outOfSpace ||= diskFull.test(stderrText);
    if (stderrText) io.stderrLine?.(stderrText);
  });
  const stdout = child.stdout ? pump(child.stdout, async chunk => {
    fence();
    stdoutBytes += chunk.length;
    if (stdoutBytes > (io.stdoutLimit ?? 0)) throw reverseError('PROCESSING_FAILED');
    await io.stdout?.(chunk);
  }) : undefined;
  const stdin = child.stdin && io.stdin ? Promise.resolve().then(() => io.stdin!(child.stdin!)) : undefined;
  try {
    await Promise.race([Promise.all([terminal, stderr, stdout, stdin]), stopped]);
    fence();
  } catch (error) {
    stop(isDiskFull(error) ? reverseError('DISK_FULL') : error);
    // The encoder's stdin producer owns its current decoder. Its unwind,
    // along with pending reads/writes, must finish before releasing staging.
    const outcomes = await Promise.allSettled([stopping, stdin, stdout, stderr]);
    const unconfirmed = outcomes.find(outcome => outcome.status === 'rejected' &&
      outcome.reason && typeof outcome.reason === 'object' && outcome.reason.terminationUnconfirmed === true);
    if (unconfirmed?.status === 'rejected') throw unconfirmed.reason;
    if (outOfSpace) throw reverseError('DISK_FULL');
    throw failure;
  } finally {
    clearTimeout(timeout);
    removeObserver();
  }
}

export function writeMediaInput(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => stream.write(chunk, error => error ? reject(error) : resolve()));
}
export async function finishMediaInput(stream: Writable): Promise<void> {
  const done = finished(stream, {readable: false, cleanup: true});
  stream.end();
  await done;
}

export interface ReverseProxyFile {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
}

const fileNames = ['proxy.mkv', 'video.raw', 'audio.f32le', 'clock.json', 'frames.jsonl', 'video-block.raw', 'audio-source.f32le',
  'optical.ffconcat'] as const;
export const MAX_OPTICAL_SEGMENTS = 8192;
export const opticalSegmentName = /^optical-[0-9]{5}\.mkv$/u;
type FileName = typeof fileNames[number] | `optical-${string}.mkv`;
const isFileName = (name: string): boolean => fileNames.some(fixed => fixed === name) || opticalSegmentName.test(name);
interface OwnedFile {readonly fileName: FileName; readonly path: string; readonly handle: FileHandle; readonly identity: Stats}

/** Files are opened exclusively inside the provided owned directory. Only the
 * processor's bounded filenames are reachable from this object. */
export function createReverseStaging(directory: string, options: ReverseProxyMediaOptions) {
  const identity = checkedDirectory(directory, directory);
  if (!identity) throw reverseError('PROCESSING_FAILED');
  const fence = (): void => {
    checkMediaEffect(options.beforeEffect, options.signal);
    checkDirectoryIdentity(directory, directory, identity);
  };
  const changes = new Map<FileName, OwnedFile>();
  const handleFile = async (fileName: FileName): Promise<OwnedFile> => {
    fence();
    if (!isFileName(fileName) || changes.has(fileName)) throw reverseError('PROCESSING_FAILED');
    const file = path.join(directory, fileName);
    const handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fence();
      const info = inspectFile(file, directory, {private: true});
      const owned = await handle.stat();
      if (!info || !owned.isFile() || owned.nlink !== 1 || (process.platform !== 'win32' && !sameNode(info, owned))) throw reverseError('PROCESSING_FAILED');
      const entry = {fileName, path: file, handle, identity: info};
      changes.set(fileName, entry);
      return entry;
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  const current = (entry: OwnedFile): Stats => {
    fence();
    const info = inspectFile(entry.path, directory, {private: true});
    if (!info || !sameNode(info, entry.identity)) throw reverseError('PROCESSING_FAILED');
    return info;
  };
  return {
    fence,
    create: handleFile,
    pathFor(entry: OwnedFile) {current(entry); return entry.path;},
    async evidence(entry: OwnedFile): Promise<ReverseProxyFile> {
      const expected = current(entry);
      if (expected.size < 1) throw reverseError('PROCESSING_FAILED');
      const {bytes, sha256} = await streamFile({file: entry.path, root: directory, signal: options.signal, check: fence, expected, private: true});
      return Object.freeze({fileName: entry.fileName, bytes, sha256});
    },
    async remove(entry: OwnedFile): Promise<void> {
      await entry.handle.close();
      if (!removeOwnedFile(entry.path, directory, current(entry))) throw reverseError('PROCESSING_FAILED');
      changes.delete(entry.fileName);
    },
    async close(): Promise<void> {
      await Promise.all([...changes.values()].map(entry => entry.handle.close()));
    },
  };
}
export type ReverseStaging = ReturnType<typeof createReverseStaging>;

export async function readOwnedBytes(handle: FileHandle, target: Buffer, position: number): Promise<void> {
  let at = 0;
  while (at < target.length) {
    const {bytesRead} = await handle.read(target, at, target.length - at, position + at);
    if (bytesRead === 0) throw reverseError('PROCESSING_FAILED');
    at += bytesRead;
  }
}

export async function writeOwnedBytes(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let at = 0;
  while (at < bytes.length) {
    const {bytesWritten} = await handle.write(bytes, at, bytes.length - at, position + at);
    if (bytesWritten === 0) throw reverseError('PROCESSING_FAILED');
    at += bytesWritten;
  }
}
