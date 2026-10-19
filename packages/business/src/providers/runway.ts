import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createJsonRequest, createPollCache, downloadMp4, outputUrl } from './live-common.ts';

const API = 'https://api.dev.runwayml.com';
const VERSION = '2024-11-06';
const MAX_DATA_URI = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATIOS = { '9:16': '720:1280', '16:9': '1280:720', '1:1': '960:960', '3:4': '832:1104', '4:3': '1104:832', '21:9': '1584:672' };
const error = (code, message, tags = {}) => Object.assign(new Error(message), { code, ...tags });
const inside = (base, file) => file !== base && file.startsWith(`${base}${path.sep}`);

function isImage(bytes, mime) {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return false;
}

/** Real adapter. Importing/constructing it never makes a request; network is off by default. */
export function createRunwayProvider({ root, fetchImpl = globalThis.fetch, env = process.env, now = Date.now } = {}) {
  const secret = typeof env.RUNWAYML_API_SECRET === 'string' ? env.RUNWAYML_API_SECRET.trim() : '';
  const configured = Boolean(secret);
  const enabled = configured && env.MIOON_ENABLE_LIVE_PROVIDER === '1';
  const approvedHashes = new Set((env.RUNWAY_APPROVED_ASSET_SHA256 ?? '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^[0-9a-f]{64}$/.test(x)));
  // The documented output CDN is allowed by default. Additional verified CDN hosts
  // can be configured server-side, never by a request, prompt, or provider response.
  const outputHosts = new Set(['dnznrvs05pmza.cloudfront.net', ...(env.RUNWAY_OUTPUT_HOSTS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(x))]);
  const ensureEnabled = () => { if (!enabled) throw error('PROVIDER_DISABLED', 'Runway live calls are disabled or its server credential is missing.'); };
  const taskPath = id => {
    if (typeof id !== 'string' || !UUID.test(id)) throw error('INVALID_PROVIDER_TASK_ID', 'Runway task ID is invalid.');
    return `/v1/tasks/${id}`;
  };
  const request = createJsonRequest({
    api: API, headers: { Authorization: `Bearer ${secret}`, 'X-Runway-Version': VERSION },
    fetchImpl, ensureEnabled, name: 'Runway',
    // Preserve Runway's existing GET status retryability; POST classification is
    // owned by the shared conservative explicit-rejection policy.
    isRetryableStatus: status => status >= 500 || status === 429 || status === 408,
  });
  const cache = createPollCache({ now, interval: 5000, retrieve: async (id, context) => {
    const task = await request(taskPath(id), { context });
    if (task.id !== id || !['PENDING', 'THROTTLED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) throw error('INVALID_PROVIDER_RESPONSE', 'Runway task response did not match the requested task.', { retryable: true });
    return task;
  } });
  const retrieve = (id, context = {}) => {
    taskPath(id);
    return cache.get(id, context);
  };
  async function imageDataUri(asset) {
    if (!root || !asset || typeof asset.path !== 'string' || !/^[0-9a-f]{64}$/i.test(asset.sha256 ?? '')) throw error('INVALID_REFERENCE', 'A managed reference image with its checksum is required.');
    if (!approvedHashes.has(asset.sha256.toLowerCase())) throw error('REFERENCE_NOT_APPROVED', 'This reference image has not been approved in the server-side Runway asset allowlist.');
    let base, file, info, bytes;
    try {
      base = await realpath(root); file = await realpath(asset.path);
      if (!inside(base, file)) throw error('UNSAFE_REFERENCE_PATH', 'Reference image must remain inside managed storage.');
      info = await stat(file);
      if (!info.isFile() || info.size > MAX_DATA_URI * 3 / 4) throw error('REFERENCE_TOO_LARGE', 'Reference image exceeds the Runway data URI limit.');
      bytes = await readFile(file);
    } catch (cause) {
      if (cause.code === 'UNSAFE_REFERENCE_PATH' || cause.code === 'REFERENCE_TOO_LARGE') throw cause;
      throw error('REFERENCE_UNAVAILABLE', 'The managed reference image could not be read.');
    }
    if (!isImage(bytes, asset.mimeType)) throw error('INVALID_REFERENCE_TYPE', 'Reference must be a PNG, JPEG, or WebP matching its declared type.');
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256.toLowerCase()) throw error('REFERENCE_CHANGED', 'Reference image changed after the generation snapshot was created.');
    const uri = `data:${asset.mimeType};base64,${bytes.toString('base64')}`;
    if (Buffer.byteLength(uri) > MAX_DATA_URI) throw error('REFERENCE_TOO_LARGE', 'Encoded reference image exceeds Runway’s 5 MiB data URI limit.');
    return uri;
  }
  function validate(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw error('INVALID_SNAPSHOT', 'A generation snapshot is required.');
    if ((snapshot.model ?? 'gen4_turbo') !== 'gen4_turbo') throw error('UNSUPPORTED_MODEL', 'Only Runway Gen-4 Turbo is implemented.');
    if (!Object.hasOwn(RATIOS, snapshot.aspectRatio) || !Number.isInteger(snapshot.duration) || snapshot.duration < 2 || snapshot.duration > 10) throw error('UNSUPPORTED_CAPABILITY', 'Runway Gen-4 Turbo requires a supported ratio and an integer duration from 2 to 10 seconds.');
    if (typeof snapshot.prompt !== 'string' || !snapshot.prompt.trim() || snapshot.prompt.length > 1000) throw error('INVALID_PROMPT', 'Runway prompt must contain 1 to 1000 UTF-16 code units.');
    if (!Array.isArray(snapshot.referenceAssets) || snapshot.referenceAssets.length !== 1) throw error('INVALID_REFERENCE_COUNT', 'Runway Gen-4 Turbo accepts exactly one first-frame image.');
    const parameters = snapshot.parameters ?? {};
    if (typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).some(key => key !== 'seed')) throw error('UNSUPPORTED_PARAMETER', 'The Runway adapter currently accepts only the seed parameter.');
    if (parameters.seed !== undefined && (!Number.isInteger(parameters.seed) || parameters.seed < 0 || parameters.seed > 4294967295)) throw error('INVALID_SEED', 'Seed must be an unsigned 32-bit integer.');
    return true;
  }
  return {
    id: 'runway', validate,
    capabilities: {
      id: 'runway', name: 'Runway Gen-4 Turbo · live verification pending', models: ['gen4_turbo'], inputModes: ['image'],
      aspectRatios: Object.keys(RATIOS), durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      mock: false, configured, enabled, requiresApprovedReference: true, liveVerified: false,
      maxReferenceImages: 1, minPollIntervalMs: 5000, supportsRemoteCancel: false,
      reconciliation: 'known-task-id-only', verification: 'Contract-tested with injected HTTP; real submission pending authorization.',
    },
    async submit(snapshot, context = {}) {
      ensureEnabled();
      validate(snapshot);
      const parameters = snapshot.parameters ?? {};
      const body = {
        model: 'gen4_turbo', promptImage: await imageDataUri(snapshot.referenceAssets[0]), promptText: snapshot.prompt,
        ratio: RATIOS[snapshot.aspectRatio], duration: snapshot.duration,
        ...(parameters.seed === undefined ? {} : { seed: parameters.seed }),
      };
      const response = await request('/v1/image_to_video', { method: 'POST', body, context });
      if (typeof response.id !== 'string' || !UUID.test(response.id)) throw error('SUBMISSION_UNKNOWN', 'Runway accepted the request but no valid task ID was received. Do not resubmit.', { uncertain: true });
      return { providerJobId: response.id };
    },
    async poll(providerJobId, context = {}) {
      ensureEnabled();
      const task = await retrieve(providerJobId, context);
      if (task.status === 'SUCCEEDED') return { status: 'succeeded', progress: 1 };
      if (task.status === 'FAILED' || task.status === 'CANCELLED') return { status: 'failed', error: { code: task.status === 'CANCELLED' ? 'PROVIDER_CANCELLED' : 'PROVIDER_GENERATION_FAILED', message: task.status === 'CANCELLED' ? 'Runway task was cancelled.' : 'Runway generation failed. Review the task in the provider account before retrying.' } };
      return { status: 'running', progress: Number.isFinite(task.progress) ? Math.max(0, Math.min(0.99, task.progress)) : 0 };
    },
    async reconcile() {
      // No documented request-ID lookup or create-idempotency guarantee exists for
      // this endpoint. A missing ID must remain unknown; null is NOT safe-to-retry.
      return null;
    },
    async cancel() {
      // DELETE is also permanent deletion for completed tasks. A GET preflight has
      // a race, so this adapter never disguises deletion as routine cancellation.
      return { cancelled: false, remoteCancelled: false, scope: 'local', reason: 'Runway cancellation shares a permanent-delete endpoint. Only local waiting was stopped; remote work and charges may continue.' };
    },
    async download(providerJobId, destination, context = {}) {
      ensureEnabled();
      const task = await retrieve(providerJobId, context);
      if (task.status !== 'SUCCEEDED') throw error('PROVIDER_NOT_READY', 'Runway output is not available yet.', { retryable: true });
      const url = outputUrl(task.output?.[0], outputHosts);
      // Signed CDN URLs never receive API credentials or redirect permission.
      return downloadMp4({ root, destination, url, fetchImpl, context, invalidate: () => cache.invalidate(providerJobId) });
    },
  };
}
