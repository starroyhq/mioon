import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export const FILE_RESPONSE_LIMITS = Object.freeze({active: 32, idleMs: 30000, chunkBytes: 64 * 1024});
const failure = (code, status, message) => Object.assign(Error(message), {code, status});
const unavailable = () => failure('FILE_UNAVAILABLE', 404, '本地文件不可用。');
const unavailableCodes = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

// Preserve the existing single-range contract, including suffix/clamped ranges
// and empty/unsatisfiable-file behavior. Multipart ranges remain unsupported.
export function fileRange(value, size) {
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
export function createFileResponses({signal, openFile = open, limits = {}} = {}) {
  const policy = {...FILE_RESPONSE_LIMITS};
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in policy) || !Number.isSafeInteger(value) || value < 1 || value > policy[key]) throw Error('Invalid file response limit');
    policy[key] = value;
  }
  const active = new Set();
  let closing = false;
  const stop = () => { closing = true; for (const record of active) record.cancel(); };
  signal?.addEventListener('abort', stop, {once: true});
  if (signal?.aborted) stop();

  async function send(req, res, {file, fallbackFile, headers = {}, ranges = false}) {
    if (closing) throw failure('FILE_RESPONSE_CLOSED', 503, '本地服务正在关闭。');
    if (active.size >= policy.active) throw failure('FILE_RESPONSE_BUSY', 503, '本地文件传输繁忙，请稍后重试。');
    let handle, source, timer, cancelled = false, release;
    const done = new Promise(resolve => { release = resolve; });
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
      let metadata, selected;
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
          if (unavailableCodes.has(error?.code) || error?.code === 'FILE_UNAVAILABLE') continue;
          if (error?.code === 'FILE_METADATA_INVALID') throw error;
          throw failure('FILE_READ_FAILED', 500, '无法读取本地文件。');
        }
      }
      if (!selected) throw fallbackFile ? failure('BUILD_REQUIRED', 503, '请先运行 pnpm build') : unavailable();
      if (!alive()) return;
      const range = fileRange(ranges ? req.headers.range : undefined, metadata.size);
      if (range.status === 416) { res.writeHead(416); res.end(); return; }
      const responseHeaders = typeof headers === 'function' ? headers(selected) : headers;
      const lengthHeaders = ranges ? {'Content-Length': range.length} : {};
      const rangeHeaders = range.status === 206 ? {'Content-Range': `bytes ${range.start}-${range.end}/${metadata.size}`} : {};
      // Build the readable before headers, so a synchronous construction error
      // can still receive a sanitized response. Empty files never read end=-1.
      if (req.method !== 'HEAD' && range.length) source = handle.createReadStream({start: range.start, end: range.end,
        autoClose: false, highWaterMark: policy.chunkBytes});
      res.writeHead(range.status, {...responseHeaders, ...lengthHeaders, ...rangeHeaders});
      if (!source) { res.end(); return; }
      resetIdle();
      let bytes = 0;
      const count = new Transform({highWaterMark: policy.chunkBytes,
        transform(chunk, _encoding, callback) { bytes += chunk.length; resetIdle(); callback(null, chunk); },
        flush(callback) { callback(bytes === range.length ? null : failure('FILE_READ_TRUNCATED', 500, '本地文件传输未完成。')); },
      });
      // pipeline owns source/transform/response errors and respects writable
      // backpressure. A post-header failure aborts only this response.
      await pipeline(source, count, res);
    } catch (error) {
      if (res.headersSent || !alive()) { cancel(); return; }
      if (error?.status && ['FILE_UNAVAILABLE', 'BUILD_REQUIRED', 'FILE_METADATA_INVALID', 'FILE_READ_FAILED'].includes(error.code)) throw error;
      throw failure('FILE_READ_FAILED', 500, '无法读取本地文件。');
    } finally {
      clearTimeout(timer);
      source?.destroy();
      // FileHandle.close waits for pending read operations. Keep the record
      // until ownership is actually released, including late-open cancellation.
      try { await handle?.close(); }
      finally {
        res.removeListener('close', onClose); res.removeListener('error', cancel); req.removeListener('aborted', cancel);
        active.delete(record); release();
      }
    }
  }
  return Object.freeze({send, async close() {
    stop(); signal?.removeEventListener('abort', stop);
    await Promise.all([...active].map(record => record.done));
  }});
}
