import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {awaitProvider,checkpoint,operationCancelled} from '../operation-lifecycle.ts';

export interface ProviderError extends Error {
  code: string;
  uncertain?: boolean;
  retryable?: boolean;
  httpStatus?: number;
  terminationUnconfirmed?: boolean;
}
/** Trusted construction options shared by the live provider factories. */
export interface ProviderFactoryOptions {
  root: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}
export interface ProviderContext {
  signal?: AbortSignal;
  beforeSubmit?: () => unknown;
  requestId?: string;
  jobId?: string;
  providerRegion?: string;
  validateReferenceState?: () => unknown;
}
export interface ProviderReferenceAsset {
  id?: unknown; role?: unknown; path?: unknown; sha256?: unknown; mimeType?: unknown; width?: unknown; height?: unknown;
}
export interface ProviderSnapshotView {
  model?: unknown; aspectRatio: unknown; duration: unknown; prompt: unknown; referenceAssets: ProviderReferenceAsset[];
  parameters?: unknown; inputProfileVersion?: unknown; lastFrameAssetId?: unknown;
  referenceAssetIds?: unknown; referenceBindings?: unknown; subjectReference?: unknown;
}
export interface ProviderReferenceImages {
  min: number; max: number; mimeTypes?: readonly string[]; minDimension?: number; maxDimension?: number; matchAspectRatio?: boolean;
}
export interface ProviderModelSpec {
  id: string; name?: string; inputModes?: readonly string[]; aspectRatios: readonly string[]; durations: readonly number[];
  referenceImages: ProviderReferenceImages; resolutions: readonly string[]; parameters?: readonly string[]; promptRequired?: boolean; maxPromptLength?: number;
}
export interface LiveConfiguration {
  secret: string; configured: boolean; enabled: boolean; status: 'not_configured' | 'disabled' | 'available';
  configuration: {missing: string[]; requirements: string[]};
  ensureEnabled(): void;
}
export interface ManagedImage {width: number; height: number; bytes: Buffer; mimeType: string; base64: string}
export interface OutputDownload {mimeType: 'video/mp4'; sizeBytes: number; isMock: false}
export interface JsonRequestOptions {method?: string; body?: unknown; raw?: {bytes: Uint8Array; contentType: string}; context?: ProviderContext}
export interface JsonRequestFactoryOptions {
  api: string; headers: Readonly<Record<string, string>>; fetchImpl: typeof fetch; ensureEnabled: () => void; name: string;
  isRetryableStatus?: (status: number) => boolean;
}
export interface ManagedImageOptions {
  root: string; asset: ProviderReferenceAsset; approvedHashes: ReadonlySet<string>; maxBytes?: number; signal?: AbortSignal; validateCurrent?: () => unknown;
}
export interface DownloadMp4Options {
  root: string; destination: string; url: URL; fetchImpl: typeof fetch; headers?: Readonly<Record<string, string>>;
  context?: ProviderContext; allowRedirect?: (location: string | null, current: URL) => URL; invalidate?: () => void;
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
const codeOf = (error: unknown): string | undefined => {const value = object(error); return value && typeof value.code === 'string' ? value.code : undefined;};
export const providerError = (code: string, message: string, tags: Record<string, unknown> = {}): ProviderError => Object.assign(new Error(message), { code, ...tags }) as ProviderError;
const inside = (base: string, file: string): boolean => file !== base && file.startsWith(`${base}${path.sep}`);
const MAX_DOWNLOAD = 128 * 1024 * 1024;
export const timeoutSignal = (context: ProviderContext | undefined, milliseconds: number): AbortSignal => context?.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);

async function boundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const limit = 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel().catch(() => {}); throw new Error('oversize'); }
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      checkpoint(signal);
      const { done, value } = await awaitProvider(() => reader.read(), signal);
      checkpoint(signal);
      if (done) break;
      size += value!.length;
      if (size > limit) throw new Error('oversize');
      chunks.push(Buffer.from(value!));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (cause) {
    const cancelled = reader.cancel().catch(() => {});
    if (!signal?.aborted) await cancelled;
    throw cause;
  }
  finally { reader.releaseLock(); }
}

export function liveConfiguration(env: NodeJS.ProcessEnv, keyName: string, prefix: string): LiveConfiguration {
  const secret = typeof env[keyName] === 'string' ? env[keyName].trim() : '';
  const configured = Boolean(secret);
  const enabled = () => configured && env.MIOON_ENABLE_LIVE_PROVIDER === '1';
  return {
    secret, configured, get enabled() { return enabled(); },
    get status() { return !configured ? 'not_configured' : enabled() ? 'available' : 'disabled'; },
    configuration: {
      missing: [...(!configured ? [keyName] : []), ...(env.MIOON_ENABLE_LIVE_PROVIDER !== '1' ? ['MIOON_ENABLE_LIVE_PROVIDER'] : [])],
      requirements: [keyName, 'MIOON_ENABLE_LIVE_PROVIDER=1', `${prefix}_APPROVED_ASSET_SHA256 (required for image input)`],
    },
    ensureEnabled() { if (!enabled()) throw providerError('PROVIDER_DISABLED', 'Live provider calls are disabled or its server credential is missing.'); },
  };
}

/** Never forward provider bodies, network errors, request data, or credentials. */
export function createJsonRequest({ api, headers, fetchImpl, ensureEnabled, name, isRetryableStatus = () => true }: JsonRequestFactoryOptions) {
  return async (endpoint: string, { method = 'GET', body, raw, context = {} }: JsonRequestOptions = {}): Promise<Record<string, unknown>> => {
    // This check is deliberately outside the fetch catch. No fetch was invoked,
    // so only this explicit path can certify an unsubmitted POST on shutdown.
    if (context.signal?.aborted) throw operationCancelled({beforeDispatch: method === 'POST'});
    ensureEnabled();
    // Private worker fence: metadata/lifecycle may change while preparing an
    // image. Keep this synchronous and outside the ambiguous fetch catch.
    if(method==='POST'){context.beforeSubmit?.();if(context.signal?.aborted)throw operationCancelled({beforeDispatch:true});ensureEnabled();}
    let response: Response;
    try {
      response = await fetchImpl(`${api}${endpoint}`, {
        method, headers: { ...headers, Accept: 'application/json', ...(raw ? { 'Content-Type': raw.contentType } : body ? { 'Content-Type': 'application/json' } : {}) },
        ...(raw ? { body: raw.bytes as BodyInit } : body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: timeoutSignal(context, 30_000),
      });
    } catch (cause) {
      // Only a pinned transport can prove that nothing was written. Such a POST
      // is definitely unsubmitted: fail it plainly instead of marking it unknown.
      if (object(cause)?.notDispatched === true && context.signal?.aborted) throw operationCancelled({beforeDispatch: method === 'POST'});
      if (object(cause)?.notDispatched === true) throw providerError(codeOf(cause) === 'VIDEO_NETWORK_DENIED' ? 'PROVIDER_NETWORK_DENIED' : 'PROVIDER_UNREACHABLE', method === 'POST' ? `${name} could not be reached. The request was not sent.` : `${name} could not be reached.`, { retryable: method !== 'POST' });
      throw providerError(method === 'POST' ? 'SUBMISSION_UNKNOWN' : 'PROVIDER_UNAVAILABLE', method === 'POST' ? `${name} submission response was not received. Do not resubmit; acceptance may have occurred.` : `${name} status request failed. Query the existing task again.`, { uncertain: method === 'POST', retryable: method !== 'POST' });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // Only unambiguous request/auth/quota rejection codes are safe failures.
      // An unrecognized status (including conflict/redirect) cannot prove no task exists.
      const uncertain = method === 'POST' && ![400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(response.status);
      throw providerError(uncertain ? 'SUBMISSION_UNKNOWN' : `PROVIDER_HTTP_${response.status}`, uncertain ? `${name} returned an inconclusive submission response. Do not resubmit.` : `${name} request was rejected (HTTP ${response.status}).`, { uncertain, retryable: method !== 'POST' && isRetryableStatus(response.status), httpStatus: response.status });
    }
    try {
      const data = await boundedJson(response, context.signal);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('shape');
      return data as Record<string, unknown>;
    } catch {
      throw providerError(method === 'POST' ? 'SUBMISSION_UNKNOWN' : 'INVALID_PROVIDER_RESPONSE', `${name} returned an unreadable response.`, { uncertain: method === 'POST', retryable: method !== 'POST' });
    }
  };
}

export interface PollCacheOptions {now: () => number; interval: number; retrieve: (id: string, context: ProviderContext) => Promise<Record<string, unknown>>}
interface PollCacheEntry {at: number; pending: boolean; promise?: Promise<Record<string, unknown>>}
/** Successes AND transient errors are cached; concurrent polls share a single GET. */
export function createPollCache({ now, interval, retrieve }: PollCacheOptions) {
  const cache = new Map<string, PollCacheEntry>();
  return {
    get(id: string, context: ProviderContext = {}): Promise<Record<string, unknown>> {
      const current = cache.get(id);
      if (current && (current.pending || now() - current.at < interval)) return current.promise!;
      const entry: PollCacheEntry = { at: now(), pending: true };
      entry.promise = Promise.resolve().then(() => retrieve(id, context)).finally(() => {
        // Slow requests still share one GET; begin the cooldown on settlement so
        // a late transient error cannot cause an immediate retry burst. Updating
        // only this entry never restores one explicitly invalidated in flight.
        entry.pending = false;
        entry.at = now();
      });
      cache.set(id, entry);
      return entry.promise;
    },
    invalidate(id: string): void { cache.delete(id); },
  };
}

export function validateModelSnapshot(snapshot: unknown, model: ProviderModelSpec, { maximumPrompt = 1000, parameterNames = [] }: {maximumPrompt?: number; parameterNames?: readonly string[]} = {}): true {
  const value = object(snapshot);
  if (!value) throw providerError('INVALID_SNAPSHOT', 'A generation snapshot is required.');
  if ((value.model ?? model.id) !== model.id) throw providerError('UNSUPPORTED_MODEL', 'This provider model is not implemented.');
  if (typeof value.aspectRatio !== 'string' || !model.aspectRatios.includes(value.aspectRatio) || typeof value.duration !== 'number' || !model.durations.includes(value.duration)) throw providerError('UNSUPPORTED_CAPABILITY', 'Choose an advertised aspect ratio and duration for this model.');
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > maximumPrompt) throw providerError('INVALID_PROMPT', `Prompt must contain 1 to ${maximumPrompt} UTF-16 code units.`);
  const references = value.referenceAssets;
  if (!Array.isArray(references) || references.length < model.referenceImages.min || references.length > model.referenceImages.max) throw providerError('INVALID_REFERENCE_COUNT', 'This model does not support the requested number of reference images.');
  const parameters = value.parameters ?? {}, parameterRecord = object(parameters);
  if (!parameterRecord || Object.keys(parameterRecord).some(key => !parameterNames.includes(key))) throw providerError('UNSUPPORTED_PARAMETER', 'This provider accepts only its advertised generation parameters.');
  if (parameterRecord.resolution !== undefined && (typeof parameterRecord.resolution !== 'string' || !model.resolutions.includes(parameterRecord.resolution))) throw providerError('UNSUPPORTED_RESOLUTION', 'Choose an advertised output resolution.');
  for (const rawAsset of references) {
    const asset = object(rawAsset);
    if(model.referenceImages.max<2&&asset?.role!==undefined&&asset.role!=='first_frame')throw providerError('UNSUPPORTED_INPUT_ROLE','This adapter only supports first-frame image input.');
    if (!asset || !/^[0-9a-f]{64}$/i.test(typeof asset.sha256 === 'string' ? asset.sha256 : '')) throw providerError('INVALID_REFERENCE', 'A managed reference image with its checksum is required.');
    if (!['image/png', 'image/jpeg'].includes(asset.mimeType as string)) throw providerError('INVALID_REFERENCE_TYPE', 'This adapter accepts PNG or JPEG reference images.');
  }
  return true;
}

/** Read dimensions from actual PNG/JPEG bytes rather than trusting snapshot metadata. */
export function imageDimensions(bytes: Buffer, mime: unknown): {width: number; height: number} {
  if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString() === 'IHDR') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mime === 'image/jpeg' && bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 7) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      offset += size;
    }
  }
  throw providerError('INVALID_REFERENCE_TYPE', 'Reference bytes do not match a supported PNG or JPEG image.');
}

export async function managedImage({ root, asset, approvedHashes, maxBytes = 10 * 1024 * 1024, signal, validateCurrent }: ManagedImageOptions): Promise<ManagedImage> {
  let boundaryError: unknown;
  const check=(): void =>{if(signal?.aborted)throw operationCancelled({beforeDispatch:true});try{validateCurrent?.();}catch(error){boundaryError=error;throw error;}};
  check();
  if (!root || !asset || typeof asset.path !== 'string' || !/^[0-9a-f]{64}$/i.test(typeof asset.sha256 === 'string' ? asset.sha256 : '')) throw providerError('INVALID_REFERENCE', 'A managed local reference image is required.');
  if (!approvedHashes.has((asset.sha256 as string).toLowerCase())) throw providerError('REFERENCE_NOT_APPROVED', 'This reference image is not in the server-side provider asset approval list.');
  let bytes: Buffer;
  try {
    const base = await realpath(root);check();
    const file = await realpath(asset.path);check();
    if (!inside(base, file)) throw providerError('UNSAFE_REFERENCE_PATH', 'Reference image must remain inside managed storage.');
    const info = await stat(file);check();
    if (!info.isFile()) throw providerError('INVALID_REFERENCE', 'Reference must be a managed file.');
    if (info.size > maxBytes) throw providerError('REFERENCE_TOO_LARGE', 'Reference image exceeds this adapter’s managed input limit.');
    bytes = await readFile(file);check();
    if (bytes.length > maxBytes) throw providerError('REFERENCE_TOO_LARGE', 'Reference image exceeds this adapter’s managed input limit.');
  } catch (cause) {
    if(cause===boundaryError)throw cause;
    check();
    const code = codeOf(cause);
    if (code && ['UNSAFE_REFERENCE_PATH', 'REFERENCE_TOO_LARGE', 'INVALID_REFERENCE'].includes(code)) throw cause;
    throw providerError('REFERENCE_UNAVAILABLE', 'The managed reference image could not be read.');
  }
  const dimensions = imageDimensions(bytes, asset.mimeType);
  if (createHash('sha256').update(bytes).digest('hex') !== (asset.sha256 as string).toLowerCase()) throw providerError('REFERENCE_CHANGED', 'Reference image changed after its generation snapshot was created.');
  return { ...dimensions, bytes, mimeType: asset.mimeType as string, base64: bytes.toString('base64') };
}

export const approvedAssetHashes = (value: unknown): Set<string> => new Set((typeof value === 'string' ? value : '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^[0-9a-f]{64}$/.test(x)));
export const approvedOutputHosts = (value: unknown, defaults: readonly string[] = []): Set<string> => new Set([...defaults, ...(typeof value === 'string' ? value : '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(x))]);

export function outputUrl(value: unknown, hosts: ReadonlySet<string>): URL {
  let url: URL;
  try { url = new URL(value as string | URL); } catch { throw providerError('INVALID_OUTPUT_URL', 'Provider did not return a valid output URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname.toLowerCase())) {
    // Download URLs can contain signed paths, query tokens and credentials.
    // Persist only these allowlisted fields so a rejected host can be reviewed.
    const diagnostic = { protocol: url.protocol, hostname: url.hostname, port: url.port, hasUserinfo: Boolean(url.username || url.password) };
    throw providerError('UNAPPROVED_OUTPUT_HOST', `Output host requires server-side verification before download. ${JSON.stringify(diagnostic)}`);
  }
  return url;
}

async function managedDestination(root: string, destination: string, signal?: AbortSignal): Promise<string> {
  checkpoint(signal);
  try {
    const base = await realpath(root), target = path.resolve(destination);
    checkpoint(signal);
    if (!inside(base, target)) throw providerError('UNSAFE_OUTPUT_PATH', 'Output must stay inside managed storage.');
    const directory = path.dirname(target);
    // Check the nearest existing ancestor before recursive mkdir can follow an
    // escaping symlink and create directories outside managed storage.
    let ancestor = directory;
    while (true) {
      let actual: string;
      try { actual = await realpath(ancestor); checkpoint(signal); }
      catch (cause) { if (codeOf(cause) !== 'ENOENT') throw cause; ancestor = path.dirname(ancestor); continue; }
      if (actual !== base && !inside(base, actual)) throw providerError('UNSAFE_OUTPUT_PATH', 'Output directory is outside managed storage.');
      break;
    }
    checkpoint(signal);
    await mkdir(directory, { recursive: true });checkpoint(signal);
    const parent = await realpath(directory);checkpoint(signal);
    if (parent !== base && !inside(base, parent)) throw providerError('UNSAFE_OUTPUT_PATH', 'Output directory is outside managed storage.');
    return target;
  } catch (cause) {
    checkpoint(signal);
    if (codeOf(cause) === 'UNSAFE_OUTPUT_PATH') throw cause;
    throw providerError('OUTPUT_UNAVAILABLE', 'The managed output directory could not be prepared.', { retryable: true });
  }
}

/** Caller chooses the exact authenticated API route, never a request-supplied URL. */
export async function downloadMp4({ root, destination, url, fetchImpl, headers, context = {}, allowRedirect, invalidate }: DownloadMp4Options): Promise<OutputDownload> {
  const signal = context.signal;
  checkpoint(signal);
  const target = await managedDestination(root, destination, signal);
  checkpoint(signal);
  const temporary = `${target}.${randomUUID()}.partial.mp4`;
  let response: Response | undefined, handle: FileHandle | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    let current = url;
    let currentHeaders: Readonly<Record<string, string>> | undefined = headers;
    for (let redirects = 0; ; redirects++) {
      checkpoint(signal);
      response = await fetchImpl(current.href, { method: 'GET', ...(currentHeaders ? { headers: currentHeaders } : {}), redirect: allowRedirect ? 'manual' : 'error', signal: timeoutSignal(context, 60_000) });
      checkpoint(signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel().catch(() => {});checkpoint(signal);
      if (!allowRedirect || redirects >= 3) throw providerError('UNSAFE_OUTPUT_REDIRECT', 'Output redirect was not approved.');
      const next = allowRedirect(response.headers.get('location'), current);
      // Every redirect drops authentication, even an initial same-origin hop.
      // Once removed, it is never restored if a later redirect comes back.
      currentHeaders = undefined;
      current = next;
    }
    if (!response.ok || !response.body) throw providerError('DOWNLOAD_FAILED', 'Output download is unavailable; refresh the existing task and retry.', { retryable: true });
    const declaredSize = Number(response.headers.get('content-length'));
    if (declaredSize > MAX_DOWNLOAD) throw providerError('OUTPUT_TOO_LARGE', 'Output exceeds the managed download limit.');
    reader = response.body.getReader();
    checkpoint(signal);
    handle = await open(temporary, 'wx', 0o600);checkpoint(signal);
    let total = 0, header = Buffer.alloc(0);
    while (true) {
      checkpoint(signal);
      const { done, value } = await awaitProvider(() => reader!.read(), signal);
      checkpoint(signal);
      if (done) break;
      total += value!.length;
      if (total > MAX_DOWNLOAD) throw providerError('OUTPUT_TOO_LARGE', 'Output exceeds the managed download limit.');
      if (header.length < 12) header = Buffer.concat([header, Buffer.from(value!).subarray(0, 12 - header.length)]);
      await handle.writeFile(value!);checkpoint(signal);
    }
    if (header.length < 12 || header.subarray(4, 8).toString() !== 'ftyp') throw providerError('INVALID_OUTPUT_MEDIA', 'Provider output is not an MP4 container.');
    await handle.sync();checkpoint(signal);
    await handle.close();
    handle = undefined;
    checkpoint(signal);
    await rename(temporary, target);checkpoint(signal);
    return { mimeType: 'video/mp4', sizeBytes: total, isMock: false };
  } catch (cause) {
    invalidate?.();
    const cancelled = reader ? reader.cancel().catch(() => {}) : response?.body?.cancel().catch(() => {}) ?? Promise.resolve();
    if (!signal?.aborted) await cancelled;
    checkpoint(signal);
    const code = codeOf(cause);
    if (code && ['DOWNLOAD_FAILED', 'OUTPUT_TOO_LARGE', 'INVALID_OUTPUT_MEDIA', 'UNSAFE_OUTPUT_REDIRECT', 'UNAPPROVED_OUTPUT_HOST', 'INVALID_OUTPUT_URL'].includes(code)) throw cause;
    throw providerError('DOWNLOAD_FAILED', 'Output download failed; retry the existing task, not generation.', { retryable: true });
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
