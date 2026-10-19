import {open} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import type {Stats} from 'node:fs';
import {constants} from 'node:fs';
import {Transform} from 'node:stream';
import type {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {IncomingMessage, ServerResponse} from 'node:http';

export const FILE_RESPONSE_LIMITS = Object.freeze({active: 32, idleMs: 30000, chunkBytes: 64 * 1024});
type LimitName = keyof typeof FILE_RESPONSE_LIMITS;
interface FileResponseFailure extends Error {code: string; status: number}
type ReadHandle = Pick<FileHandle, 'close' | 'createReadStream'> & {stat(): Promise<Stats>};
export interface FileResponsesOptions {
  signal?: AbortSignal;
  openFile?: (path: string, flags: number) => Promise<ReadHandle>;
  limits?: Partial<Record<LimitName, number>>;
}
interface SatisfiableFileRange {status: 200 | 206; start: number; end: number; length: number}
interface UnsatisfiableFileRange {status: 416}
export type FileRange = SatisfiableFileRange | UnsatisfiableFileRange;
export interface FileResponseSendOptions {
  file: string;
  fallbackFile?: string;
  headers?: Record<string, string> | ((selected: string) => Record<string, string>);
  ranges?: boolean;
}
export interface FileResponses {
  send(req: IncomingMessage, res: ServerResponse, options: FileResponseSendOptions): Promise<void>;
  close(): Promise<void>;
}
const failure = (code: string, status: number, message: string): FileResponseFailure => Object.assign(Error(message), {code, status});
const unavailable = (): FileResponseFailure => failure('FILE_UNAVAILABLE', 404, '本地文件不可用。');
const unavailableCodes = new Set<string>(['ENOENT', 'ENOTDIR', 'EISDIR']);
const coded = (error: unknown): {code?: unknown; status?: unknown} => error !== null && typeof error === 'object' ? error : {};

// Preserve the existing single-range contract, including suffix/clamped ranges
// and empty/unsatisfiable-file behavior. Multipart ranges remain unsupported.
export function fileRange(value: string | undefined, size: number): FileRange {
  if (!value) return {status: 200, start: 0, end: size - 1, length: size};
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return {status: 416};
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = Math.min(match[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return {status: 416};
  return {status: 206, start, end, length: end - start + 1};
}

/** One descriptor per response: fstat and reads share its identity. This does
 * not make bytes immutable if another writer overwrites the same inode.
 * openFile/smaller limits are trusted test seams, never HTTP/env configuration.
 * Transport cancellation only owns file reads; it never cancels business work.
 */
export function createFileResponses({signal, openFile = open, limits = {}}: FileResponsesOptions = {}): FileResponses {
  const policy: Record<LimitName, number> = {...FILE_RESPONSE_LIMITS};
  for (const [key, value] of Object.entries(limits) as [LimitName, number][]) {
    if (!(key in policy) || !Number.isSafeInteger(value) || value < 1 || value > policy[key]) throw Error('Invalid file response limit');
    policy[key] = value;
  }
  const active = new Set<{cancel(): void; done: Promise<void>}>();
  let closing = false;
  const stop = () => { closing = true; for (const record of active) record.cancel(); };
  signal?.addEventListener('abort', stop, {once: true});
  if (signal?.aborted) stop();

  async function send(req: IncomingMessage, res: ServerResponse, {file, fallbackFile, headers = {}, ranges = false}: FileResponseSendOptions): Promise<void> {
    if (closing) throw failure('FILE_RESPONSE_CLOSED', 503, '本地服务正在关闭。');
    if (active.size >= policy.active) throw failure('FILE_RESPONSE_BUSY', 503, '本地文件传输繁忙，请稍后重试。');
    let handle: ReadHandle | undefined, source: Readable | undefined, timer: NodeJS.Timeout | undefined, cancelled = false, release: (() => void) | undefined;
    const done = new Promise<void>(resolve => { release = resolve; });
    const cancel = () => {
      if (cancelled) return;
      cancelled = true; clearTimeout(timer);
      source?.destroy();
      if (!res.destroyed) res.destroy();
    };
    const record = {cancel, done};
    active.add(record);
    const alive = () => !cancelled && !closing && !req.aborted && !res.destroyed;
    const resetIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(cancel, policy.idleMs); timer.unref();
    };
    const onClose = () => { if (!res.writableFinished) cancel(); };
    res.on('close', onClose); res.on('error', cancel); req.on('aborted', cancel);
    try {
      // O_NONBLOCK avoids waiting for a FIFO writer before fstat can reject a
      // nonregular file. It does not change ordinary regular-file reads.
      const candidates = fallbackFile && fallbackFile !== file ? [file, fallbackFile] : [file];
      let metadata: Stats | undefined, selected: string | undefined;
      for (const candidate of candidates) {
        if (!alive()) return;
        try {
          handle = await openFile(candidate, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
          if (!alive()) return;
          metadata = await handle.stat();
          if (!metadata.isFile()) throw unavailable();
          if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) throw failure('FILE_METADATA_INVALID', 500, '本地文件元数据无效。');
          selected = candidate; break;
        } catch (error) {
          if (handle) { await handle.close(); handle = undefined; }
          if (!alive()) return;
          const code = coded(error).code;
          if (typeof code === 'string' && (unavailableCodes.has(code) || code === 'FILE_UNAVAILABLE')) continue;
          if (code === 'FILE_METADATA_INVALID') throw error;
          throw failure('FILE_READ_FAILED', 500, '无法读取本地文件。');
        }
      }
      if (!selected || !metadata) throw fallbackFile ? failure('BUILD_REQUIRED', 503, '请先运行 pnpm build') : unavailable();
      if (!alive()) return;
      const range = fileRange(ranges ? req.headers.range : undefined, metadata.size);
      if (range.status === 416) { res.writeHead(416); res.end(); return; }
      const responseHeaders = typeof headers === 'function' ? headers(selected) : headers;
      const lengthHeaders = ranges ? {'Content-Length': range.length} : {};
      const rangeHeaders = range.status === 206 ? {'Content-Range': `bytes ${range.start}-${range.end}/${metadata.size}`} : {};
      // Build the readable before headers, so a synchronous construction error
      // can still receive a sanitized response. Empty files never read end=-1.
      if (req.method !== 'HEAD' && range.length) source = handle!.createReadStream({start: range.start, end: range.end,
        autoClose: false, highWaterMark: policy.chunkBytes});
      res.writeHead(range.status, {...responseHeaders, ...lengthHeaders, ...rangeHeaders});
      if (!source) { res.end(); return; }
      resetIdle();
      let bytes = 0;
      const count = new Transform({highWaterMark: policy.chunkBytes,
        transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; resetIdle(); callback(null, chunk); },
        flush(callback) { callback(bytes === range.length ? null : failure('FILE_READ_TRUNCATED', 500, '本地文件传输未完成。')); },
      });
      // pipeline owns source/transform/response errors and respects writable
      // backpressure. A post-header failure aborts only this response.
      await pipeline(source, count, res);
    } catch (error) {
      if (res.headersSent || !alive()) { cancel(); return; }
      const fields = coded(error);
      if (fields.status && typeof fields.code === 'string' && ['FILE_UNAVAILABLE', 'BUILD_REQUIRED', 'FILE_METADATA_INVALID', 'FILE_READ_FAILED'].includes(fields.code)) throw error;
      throw failure('FILE_READ_FAILED', 500, '无法读取本地文件。');
    } finally {
      clearTimeout(timer);
      source?.destroy();
      // FileHandle.close waits for pending read operations. Keep the record
      // until ownership is actually released, including late-open cancellation.
      try { await handle?.close(); }
      finally {
        res.removeListener('close', onClose); res.removeListener('error', cancel); req.removeListener('aborted', cancel);
        active.delete(record); release?.();
      }
    }
  }
  return Object.freeze({send, async close() {
    stop(); signal?.removeEventListener('abort', stop);
    await Promise.all([...active].map(record => record.done));
  }});
}
