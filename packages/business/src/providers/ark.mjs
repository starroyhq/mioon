import { approvedAssetHashes, approvedOutputHosts, createJsonRequest, createPollCache, downloadMp4, liveConfiguration, managedImage, outputUrl, providerError, validateModelSnapshot } from './live-common.mjs';

const API = 'https://ark.cn-beijing.volces.com/api/v3';
const MODEL = {
  id: 'doubao-seedance-2-5-260628', name: 'Seedance 2.5', inputModes: ['text', 'image'],
  aspectRatios: ['9:16', '16:9'], durations: [4, 8],
  referenceImages: { min: 0, max: 1, mimeTypes: ['image/png', 'image/jpeg'], minDimension: 300, maxDimension: 6000, matchAspectRatio: true },
  resolutions: ['720p'], parameters: [], promptRequired: true, maxPromptLength: 1000,
};
const INTERVAL = 10_000;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'];

function validateFirstFrame(asset, ratio) {
  if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 300 || asset.height < 300 || asset.width > 6000 || asset.height > 6000) throw providerError('INVALID_REFERENCE_DIMENSIONS', 'Seedance first-frame images must be 300–6000 pixels on each side.');
  const [width, height] = ratio.split(':').map(Number);
  if (asset.width * height !== asset.height * width) throw providerError('REFERENCE_ASPECT_RATIO_MISMATCH', 'Seedance preserves first-frame aspect ratio. Use an image matching the chosen 9:16 or 16:9 ratio.');
}

/** Fixed-origin Seedance adapter. No request, upload, or credential use at construction. */
export function createArkProvider({ root, fetchImpl = globalThis.fetch, env = process.env, now = Date.now } = {}) {
  const config = liveConfiguration(env, 'ARK_API_KEY', 'ARK');
  const approvedHashes = approvedAssetHashes(env.ARK_APPROVED_ASSET_SHA256);
  const outputHosts = approvedOutputHosts(env.ARK_OUTPUT_HOSTS, ['ark-content-generation-cn-beijing.tos-cn-beijing.volces.com', 'ark-acg-cn-beijing.tos-cn-beijing.volces.com']);
  const request = createJsonRequest({ api: API, headers: { Authorization: `Bearer ${config.secret}` }, fetchImpl, ensureEnabled: config.ensureEnabled, name: 'Seedance' });
  function validate(snapshot) {
    validateModelSnapshot(snapshot, MODEL);
    if (snapshot.referenceAssets[0]) validateFirstFrame(snapshot.referenceAssets[0], snapshot.aspectRatio);
    return true;
  }
  function taskPath(id) {
    if (typeof id !== 'string' || !TASK_ID.test(id)) throw providerError('INVALID_PROVIDER_TASK_ID', 'Seedance task ID is invalid.');
    return `/contents/generations/tasks/${id}`;
  }
  const cache = createPollCache({ now, interval: INTERVAL, retrieve: async (id, context) => {
    const task = await request(taskPath(id), { context });
    if (task.id !== id || !STATUSES.includes(task.status)) throw providerError('INVALID_PROVIDER_RESPONSE', 'Seedance status did not match the requested task.', { retryable: true });
    return task;
  } });
  return {
    id: 'ark', validate,
    capabilities: {
      id: 'ark', name: 'Ark Seedance 2.5 · live verification pending', models: [MODEL.id], modelCapabilities: [structuredClone(MODEL)],
      inputModes: [...MODEL.inputModes], aspectRatios: [...MODEL.aspectRatios], durations: [...MODEL.durations],
      mock: false, configured: config.configured, enabled: config.enabled, status: config.status, configuration: config.configuration,
      requiresApprovedReference: true, maxReferenceImages: 1, minPollIntervalMs: INTERVAL, supportsRemoteCancel: false,
      reconciliation: 'known-task-id-only', liveVerified: false, audio: 'disabled',
      verification: 'Contract-tested with injected HTTP; real submission pending authorization.',
    },
    async submit(snapshot, context = {}) {
      config.ensureEnabled();
      validate(snapshot);
      const content = [{ type: 'text', text: snapshot.prompt }];
      const asset = snapshot.referenceAssets[0];
      if (asset) {
        const image = await managedImage({ root, asset, approvedHashes });
        validateFirstFrame(image, snapshot.aspectRatio);
        content.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` }, role: 'first_frame' });
      }
      const response = await request('/contents/generations/tasks', { method: 'POST', context, body: {
        model: MODEL.id, content, duration: snapshot.duration, ratio: asset ? 'adaptive' : snapshot.aspectRatio,
        resolution: '720p', output_format: 'mp4', generate_audio: false,
      } });
      if (typeof response.id !== 'string' || !TASK_ID.test(response.id)) throw providerError('SUBMISSION_UNKNOWN', 'Seedance did not return a valid task ID. Do not resubmit.', { uncertain: true });
      return { providerJobId: response.id };
    },
    async poll(id, context = {}) {
      config.ensureEnabled(); taskPath(id);
      const task = await cache.get(id, context);
      if (task.status === 'succeeded') return { status: 'succeeded', progress: 1 };
      if (['failed', 'cancelled', 'expired'].includes(task.status)) return { status: 'failed', error: {
        code: task.status === 'cancelled' ? 'PROVIDER_CANCELLED' : task.status === 'expired' ? 'PROVIDER_TASK_EXPIRED' : 'PROVIDER_GENERATION_FAILED',
        message: task.status === 'expired' ? 'Seedance generation expired.' : task.status === 'cancelled' ? 'Seedance task was cancelled.' : 'Seedance generation failed. Review the existing task in the provider account.',
      } };
      return { status: 'running', progress: 0 };
    },
    async download(id, destination, context = {}) {
      config.ensureEnabled(); taskPath(id);
      const task = await cache.get(id, context);
      if (task.status !== 'succeeded') throw providerError('PROVIDER_NOT_READY', 'Seedance output is not available yet.', { retryable: true });
      const url = outputUrl(task.content?.video_url, outputHosts);
      return downloadMp4({ root, destination, url, fetchImpl, context, invalidate: () => cache.invalidate(id) });
    },
    async reconcile() { return null; },
    async cancel() { return { cancelled: false, remoteCancelled: false, scope: 'local', reason: 'Only local waiting was stopped; Seedance generation and charges may continue.' }; },
  };
}
