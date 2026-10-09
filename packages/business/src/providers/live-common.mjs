import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const providerError = (code, message, tags = {}) => Object.assign(new Error(message), { code, ...tags });
const inside = (base, file) => file !== base && file.startsWith(`${base}${path.sep}`);
const MAX_DOWNLOAD = 128 * 1024 * 1024;
export const timeoutSignal = (context, milliseconds) => context?.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);

async function boundedJson(response) {
  const limit = 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel().catch(() => {}); throw new Error('oversize'); }
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('oversize');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (cause) { await reader.cancel().catch(() => {}); throw cause; }
  finally { reader.releaseLock(); }
}

export function liveConfiguration(env, keyName, prefix) {
  const secret = typeof env[keyName] === 'string' ? env[keyName].trim() : '';
  const configured = Boolean(secret);
  const enabled = configured && env.MIOON_ENABLE_LIVE_PROVIDER === '1';
  return {
    secret, configured, enabled,
    status: !configured ? 'not_configured' : enabled ? 'available' : 'disabled',
    configuration: {
      missing: [...(!configured ? [keyName] : []), ...(env.MIOON_ENABLE_LIVE_PROVIDER !== '1' ? ['MIOON_ENABLE_LIVE_PROVIDER'] : [])],
      requirements: [keyName, 'MIOON_ENABLE_LIVE_PROVIDER=1', `${prefix}_MAX_GENERATIONS (application-enforced approved count)`, `${prefix}_APPROVED_ASSET_SHA256 (required for image input)`],
    },
    ensureEnabled() { if (!enabled) throw providerError('PROVIDER_DISABLED', 'Live provider calls are disabled or its server credential is missing.'); },
  };
}

/** Never forward provider bodies, network errors, request data, or credentials. */
export function createJsonRequest({ api, headers, fetchImpl, ensureEnabled, name }) {
  return async (endpoint, { method = 'GET', body, context = {} } = {}) => {
    ensureEnabled();
    let response;
    try {
      response = await fetchImpl(`${api}${endpoint}`, {
        method, headers: { ...headers, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: timeoutSignal(context, 30_000),
      });
    } catch {
      throw providerError(method === 'POST' ? 'SUBMISSION_UNKNOWN' : 'PROVIDER_UNAVAILABLE', method === 'POST' ? `${name} submission response was not received. Do not resubmit; acceptance may have occurred.` : `${name} status request failed. Query the existing task again.`, { uncertain: method === 'POST', retryable: method !== 'POST' });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // Only unambiguous request/auth/quota rejection codes are safe failures.
      // An unrecognized status (including conflict/redirect) cannot prove no task exists.
      const uncertain = method === 'POST' && ![400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(response.status);
      throw providerError(uncertain ? 'SUBMISSION_UNKNOWN' : `PROVIDER_HTTP_${response.status}`, uncertain ? `${name} returned an inconclusive submission response. Do not resubmit.` : `${name} request was rejected (HTTP ${response.status}).`, { uncertain, retryable: method !== 'POST', httpStatus: response.status });
    }
    try {
      const data = await boundedJson(response);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('shape');
      return data;
    } catch {
      throw providerError(method === 'POST' ? 'SUBMISSION_UNKNOWN' : 'INVALID_PROVIDER_RESPONSE', `${name} returned an unreadable response.`, { uncertain: method === 'POST', retryable: method !== 'POST' });
    }
  };
}

/** Successes AND transient errors are cached; concurrent polls share a single GET. */
export function createPollCache({ now, interval, retrieve }) {
  const cache = new Map();
  return {
    get(id, context = {}) {
      const current = cache.get(id);
      if (current && now() - current.at < interval) return current.promise;
      const entry = { at: now() };
      entry.promise = Promise.resolve().then(() => retrieve(id, context));
      cache.set(id, entry);
      return entry.promise;
    },
    invalidate(id) { cache.delete(id); },
  };
}

export function validateModelSnapshot(snapshot, model, { maximumPrompt = 1000, parameterNames = [] } = {}) {
  if (!snapshot || typeof snapshot !== 'object') throw providerError('INVALID_SNAPSHOT', 'A generation snapshot is required.');
  if ((snapshot.model ?? model.id) !== model.id) throw providerError('UNSUPPORTED_MODEL', 'This provider model is not implemented.');
  if (!model.aspectRatios.includes(snapshot.aspectRatio) || !model.durations.includes(snapshot.duration)) throw providerError('UNSUPPORTED_CAPABILITY', 'Choose an advertised aspect ratio and duration for this model.');
  if (typeof snapshot.prompt !== 'string' || !snapshot.prompt.trim() || snapshot.prompt.length > maximumPrompt) throw providerError('INVALID_PROMPT', `Prompt must contain 1 to ${maximumPrompt} UTF-16 code units.`);
  if (!Array.isArray(snapshot.referenceAssets) || snapshot.referenceAssets.length < model.referenceImages.min || snapshot.referenceAssets.length > model.referenceImages.max) throw providerError('INVALID_REFERENCE_COUNT', 'This model accepts text alone or one first-frame reference image.');
  const parameters = snapshot.parameters ?? {};
  if (typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).some(key => !parameterNames.includes(key))) throw providerError('UNSUPPORTED_PARAMETER', 'This provider accepts only its advertised generation parameters.');
  if (parameters.resolution !== undefined && !model.resolutions.includes(parameters.resolution)) throw providerError('UNSUPPORTED_RESOLUTION', 'Choose an advertised output resolution.');
  for (const asset of snapshot.referenceAssets) {
    if (!asset || !/^[0-9a-f]{64}$/i.test(asset.sha256 ?? '')) throw providerError('INVALID_REFERENCE', 'A managed reference image with its checksum is required.');
    if (!['image/png', 'image/jpeg'].includes(asset.mimeType)) throw providerError('INVALID_REFERENCE_TYPE', 'This adapter accepts PNG or JPEG reference images.');
  }
  return true;
}

/** Read dimensions from actual PNG/JPEG bytes rather than trusting snapshot metadata. */
export function imageDimensions(bytes, mime) {
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

export async function managedImage({ root, asset, approvedHashes, maxBytes = 10 * 1024 * 1024 }) {
  if (!root || !asset || typeof asset.path !== 'string' || !/^[0-9a-f]{64}$/i.test(asset.sha256 ?? '')) throw providerError('INVALID_REFERENCE', 'A managed local reference image is required.');
  if (!approvedHashes.has(asset.sha256.toLowerCase())) throw providerError('REFERENCE_NOT_APPROVED', 'This reference image is not in the server-side provider asset approval list.');
  let bytes;
  try {
    const base = await realpath(root), file = await realpath(asset.path);
    if (!inside(base, file)) throw providerError('UNSAFE_REFERENCE_PATH', 'Reference image must remain inside managed storage.');
    const info = await stat(file);
    if (!info.isFile()) throw providerError('INVALID_REFERENCE', 'Reference must be a managed file.');
    if (info.size > maxBytes) throw providerError('REFERENCE_TOO_LARGE', 'Reference image exceeds this adapter’s managed input limit.');
    bytes = await readFile(file);
    if (bytes.length > maxBytes) throw providerError('REFERENCE_TOO_LARGE', 'Reference image exceeds this adapter’s managed input limit.');
  } catch (cause) {
    if (['UNSAFE_REFERENCE_PATH', 'REFERENCE_TOO_LARGE', 'INVALID_REFERENCE'].includes(cause.code)) throw cause;
    throw providerError('REFERENCE_UNAVAILABLE', 'The managed reference image could not be read.');
  }
  const dimensions = imageDimensions(bytes, asset.mimeType);
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256.toLowerCase()) throw providerError('REFERENCE_CHANGED', 'Reference image changed after its generation snapshot was created.');
  return { ...dimensions, bytes, mimeType: asset.mimeType, base64: bytes.toString('base64') };
}

export const approvedAssetHashes = value => new Set((value ?? '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^[0-9a-f]{64}$/.test(x)));
export const approvedOutputHosts = (value, defaults = []) => new Set([...defaults, ...(value ?? '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(x))]);

export function outputUrl(value, hosts) {
  let url;
  try { url = new URL(value); } catch { throw providerError('INVALID_OUTPUT_URL', 'Provider did not return a valid output URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname.toLowerCase())) throw providerError('UNAPPROVED_OUTPUT_HOST', 'Output host requires server-side verification before download.');
  return url;
}

async function managedDestination(root, destination) {
  try {
    const base = await realpath(root), target = path.resolve(destination);
    if (!inside(base, target)) throw providerError('UNSAFE_OUTPUT_PATH', 'Output must stay inside managed storage.');
    const directory = path.dirname(target);
    // Check the nearest existing ancestor before recursive mkdir can follow an
    // escaping symlink and create directories outside managed storage.
    let ancestor = directory;
    while (true) {
      let actual;
      try { actual = await realpath(ancestor); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; ancestor = path.dirname(ancestor); continue; }
      if (actual !== base && !inside(base, actual)) throw providerError('UNSAFE_OUTPUT_PATH', 'Output directory is outside managed storage.');
      break;
    }
    await mkdir(directory, { recursive: true });
    const parent = await realpath(directory);
    if (parent !== base && !inside(base, parent)) throw providerError('UNSAFE_OUTPUT_PATH', 'Output directory is outside managed storage.');
    return target;
  } catch (cause) {
    if (cause.code === 'UNSAFE_OUTPUT_PATH') throw cause;
    throw providerError('OUTPUT_UNAVAILABLE', 'The managed output directory could not be prepared.', { retryable: true });
  }
}

/** Caller chooses the exact authenticated API route, never a request-supplied URL. */
export async function downloadMp4({ root, destination, url, fetchImpl, headers, context = {}, allowRedirect, invalidate }) {
  const target = await managedDestination(root, destination);
  const temporary = `${target}.${randomUUID()}.partial.mp4`;
  let response, handle, reader;
  try {
    let current = url;
    let currentHeaders = headers;
    for (let redirects = 0; ; redirects++) {
      response = await fetchImpl(current.href, { method: 'GET', ...(currentHeaders ? { headers: currentHeaders } : {}), redirect: allowRedirect ? 'manual' : 'error', signal: timeoutSignal(context, 60_000) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel().catch(() => {});
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
    handle = await open(temporary, 'wx', 0o600);
    let total = 0, header = Buffer.alloc(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DOWNLOAD) throw providerError('OUTPUT_TOO_LARGE', 'Output exceeds the managed download limit.');
      if (header.length < 12) header = Buffer.concat([header, Buffer.from(value).subarray(0, 12 - header.length)]);
      await handle.writeFile(value);
    }
    if (header.length < 12 || header.subarray(4, 8).toString() !== 'ftyp') throw providerError('INVALID_OUTPUT_MEDIA', 'Provider output is not an MP4 container.');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    return { mimeType: 'video/mp4', sizeBytes: total, isMock: false };
  } catch (cause) {
    invalidate?.();
    if (reader) await reader.cancel().catch(() => {});
    else await response?.body?.cancel().catch(() => {});
    if (['DOWNLOAD_FAILED', 'OUTPUT_TOO_LARGE', 'INVALID_OUTPUT_MEDIA', 'UNSAFE_OUTPUT_REDIRECT', 'UNAPPROVED_OUTPUT_HOST', 'INVALID_OUTPUT_URL'].includes(cause.code)) throw cause;
    throw providerError('DOWNLOAD_FAILED', 'Output download failed; retry the existing task, not generation.', { retryable: true });
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
