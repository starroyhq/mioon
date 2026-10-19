import {open, unlink, type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {resolveConnection} from './connection.ts';
import {ClientError} from './index.ts';

const assetInput = z.object({assetId: z.string().uuid()}).strict();
export interface DownloadAssetOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}
export interface DownloadedAsset {assetId: string; output: string; bytes: number; mimeType: string}
const errorCode = (error: unknown): unknown => (error as {code?: unknown} | null | undefined)?.code;
/** Save only a UUID managed-media resource. A local destination never reaches HTTP. */
export async function downloadAsset(input: unknown, output: unknown, {env = process.env, fetchImpl = fetch, signal, timeoutMs = 60_000, maxBytes = 512 * 1024 * 1024}: DownloadAssetOptions = {}): Promise<DownloadedAsset> {
  if (!assetInput.safeParse(input).success || typeof output !== 'string' || !output) throw new ClientError('VALIDATION_ERROR', 'Download requires a UUID assetId and an explicit output file.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 * 1024) throw new ClientError('VALIDATION_ERROR', 'Invalid download timeout or size bound.');
  if (signal?.aborted) throw new ClientError('INTERRUPTED', 'Download stopped locally. No remote job was cancelled.');
  const assetId = (input as {assetId: string}).assetId;
  const {base, token} = await resolveConnection(env);
  const timer = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timer]) : timer;
  let handle: FileHandle | undefined, bytes = 0, completed = false;
  const destination = path.resolve(output);
  try {
    // Exclusive creation rejects existing files and symlinks. Never overwrite user data.
    try { handle = await open(destination, 'wx', 0o600); }
    catch (error) { throw new ClientError(errorCode(error) === 'EEXIST' ? 'OUTPUT_EXISTS' : 'FILE_WRITE_ERROR', errorCode(error) === 'EEXIST' ? 'Output already exists. Choose a new filename; no file was overwritten.' : 'Cannot create the requested output file.', {exitCode: errorCode(error) === 'EEXIST' ? 3 : 2}); }
    const response = await fetchImpl(`${base}/media/${assetId}`, {headers: {authorization: `Bearer ${token}`}, redirect: 'error', signal: combined});
    if (!response.ok) {
      await response.body?.cancel();
      throw new ClientError(response.status === 401 ? 'UNAUTHORIZED' : response.status === 404 ? 'NOT_FOUND' : 'BACKEND_UNAVAILABLE', 'Managed media could not be downloaded.', {status: response.status});
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body?.cancel(); throw new ClientError('FILE_TOO_LARGE', 'Managed media exceeds the download size limit.'); }
    if (!response.body) throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an empty media stream.');
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new ClientError('FILE_TOO_LARGE', 'Managed media exceeds the download size limit.');
      let offset = 0;
      while (offset < chunk.length) offset += (await handle!.write(chunk, offset, chunk.length - offset)).bytesWritten;
    }
    if (length !== null && bytes !== Number(length)) throw new ClientError('BACKEND_PROTOCOL_ERROR', 'Media download ended before the declared length.');
    await handle!.sync();
    completed = true;
    return {assetId, output: destination, bytes, mimeType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'};
  } catch (error) {
    if (error instanceof ClientError) throw error;
    if (signal?.aborted) throw new ClientError('INTERRUPTED', 'Download stopped locally. No remote job was cancelled.');
    if (timer.aborted) throw new ClientError('TIMEOUT', 'Media download timed out. The incomplete local file was removed.');
    throw new ClientError('BACKEND_UNAVAILABLE', 'Media download failed. The incomplete local file was removed.');
  } finally {
    await handle?.close();
    if (handle && !completed) await unlink(destination).catch(() => {});
  }
}
