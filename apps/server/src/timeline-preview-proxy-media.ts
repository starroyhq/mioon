import type {IncomingMessage, ServerResponse} from 'node:http';
import {sameManagedFile, type ManagedFileIdentity} from '../../../packages/business/src/managed-media.ts';
import {AppError} from '../../../packages/contracts/src/app-error.ts';
import type {FileResponses} from './file-response.ts';

export interface TimelinePreviewMediaLease {
  readonly file: string;
  readonly info: ManagedFileIdentity;
  revalidate(): void;
  release(): void | Promise<void>;
}

const unavailable = () => new AppError('FILE_UNAVAILABLE', '预览代理不可用。', 404);

/** Transfer an admitted preview while holding its cache lease. The project
 * host provides the current clip, source and cache proof via revalidate. */
export async function sendTimelinePreviewProxyMedia({req, res, files, lease, signal}: {
  req: IncomingMessage;
  res: ServerResponse;
  files: Pick<FileResponses, 'send'>;
  lease: TimelinePreviewMediaLease;
  signal?: AbortSignal;
}): Promise<void> {
  const cancel = () => res.destroy();
  try {
    if (signal?.aborted) { cancel(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      throw new AppError('METHOD_NOT_ALLOWED', '请使用 GET 或 HEAD。', 405);
    }
    const {file, info} = lease;
    if (!Number.isSafeInteger(info.size) || info.size < 1) throw unavailable();
    signal?.addEventListener('abort', cancel, {once: true});
    await files.send(req, res, {
      file,
      ranges: true,
      headers: {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store'},
      beforeEffect: () => {
        try {
          signal?.throwIfAborted();
          lease.revalidate();
        } catch {
          throw unavailable();
        }
      },
      verifyMetadata: actual => {
        if (!actual.isFile() || actual.nlink !== 1 || !sameManagedFile(actual, info)) throw unavailable();
      },
    });
  } finally {
    signal?.removeEventListener('abort', cancel);
    // send drains and closes its descriptor before the cache can be evicted.
    try { await lease.release(); }
    catch { throw new AppError('FILE_READ_FAILED', '无法释放预览代理。', 500); }
  }
}
