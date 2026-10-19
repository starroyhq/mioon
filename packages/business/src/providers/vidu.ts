import { approvedAssetHashes, approvedOutputHosts, createJsonRequest, createPollCache, downloadMp4, liveConfiguration, managedImage, outputUrl, providerError, validateModelSnapshot } from './live-common.ts';

const REGIONS = { global: 'https://api.vidu.com', cn: 'https://api.vidu.cn' };
const MODEL = {
  id: 'viduq3-turbo', name: 'Vidu Q3 Turbo', inputModes: ['text', 'image'], aspectRatios: ['9:16', '16:9'], durations: [4, 8],
  referenceImages: { min: 0, max: 1, mimeTypes: ['image/png', 'image/jpeg'], matchAspectRatio: true },
  resolutions: ['720p'], parameters: [], promptRequired: true, maxPromptLength: 1000,
};
const INTERVAL = 10_000;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const STATES = ['created', 'queueing', 'processing', 'success', 'failed'];

function validateFirstFrame(asset, ratio) {
  if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1) throw providerError('INVALID_REFERENCE_DIMENSIONS', 'Vidu needs valid first-frame image dimensions.');
  const [width, height] = ratio.split(':').map(Number);
  if (asset.width * height !== asset.height * width) throw providerError('REFERENCE_ASPECT_RATIO_MISMATCH', 'Use a Vidu first-frame image matching the selected 9:16 or 16:9 ratio.');
}

/** Q3 Turbo only. Unverified output CDN hosts must be explicitly reviewed first. */
export function createViduProvider({ root, fetchImpl = globalThis.fetch, env = process.env, now = Date.now } = {}) {
  const config = liveConfiguration(env, 'VIDU_API_KEY', 'VIDU');
  const region = env.VIDU_REGION ?? 'global', validRegion = Object.hasOwn(REGIONS, region);
  // Official task examples do not identify a trustworthy production output CDN.
  const outputHosts = approvedOutputHosts(env.VIDU_OUTPUT_HOSTS);
  const configured = config.configured && validRegion && outputHosts.size > 0;
  const enabled = config.enabled && configured;
  const configuration = { missing: [...config.configuration.missing, ...(!validRegion ? ['VIDU_REGION (global or cn)'] : []), ...(!outputHosts.size ? ['VIDU_OUTPUT_HOSTS'] : [])], requirements: [...config.configuration.requirements, 'VIDU_REGION=global|cn (credential must match region)', 'VIDU_OUTPUT_HOSTS (exact independently reviewed output CDN hostnames)'] };
  const ensureEnabled = () => {
    config.ensureEnabled();
    if (!validRegion) throw providerError('PROVIDER_CONFIGURATION', 'Vidu server region must be global or cn.');
    if (!outputHosts.size) throw providerError('PROVIDER_CONFIGURATION', 'Vidu needs an independently verified server-side output CDN allowlist before generation.');
  };
  const ensureRegion = context => { if (context.providerRegion !== undefined && context.providerRegion !== region) throw providerError('PROVIDER_REGION_CHANGED', 'Vidu account region changed after this job was created. Restore its original server region before continuing.'); };
  const approvedHashes = approvedAssetHashes(env.VIDU_APPROVED_ASSET_SHA256);
  const request = createJsonRequest({ api: REGIONS[region] ?? REGIONS.global, headers: { Authorization: `Token ${config.secret}` }, fetchImpl, ensureEnabled, name: 'Vidu' });
  function validate(snapshot) {
    validateModelSnapshot(snapshot, MODEL);
    if (snapshot.referenceAssets[0]) validateFirstFrame(snapshot.referenceAssets[0], snapshot.aspectRatio);
    return true;
  }
  function taskPath(id) {
    if (typeof id !== 'string' || !TASK_ID.test(id)) throw providerError('INVALID_PROVIDER_TASK_ID', 'Vidu task ID is invalid.');
    return `/ent/v2/tasks/${id}/creations`;
  }
  const cache = createPollCache({ now, interval: INTERVAL, retrieve: async (id, context) => {
    const task = await request(taskPath(id), { context });
    if (task.id !== id || !STATES.includes(task.state)) throw providerError('INVALID_PROVIDER_RESPONSE', 'Vidu status did not match the requested task.', { retryable: true });
    return task;
  } });
  return {
    id: 'vidu', validate,
    capabilities: {
      id: 'vidu', name: 'Vidu Q3 Turbo · live verification pending', models: [MODEL.id], modelCapabilities: [structuredClone(MODEL)],
      inputModes: [...MODEL.inputModes], aspectRatios: [...MODEL.aspectRatios], durations: [...MODEL.durations],
      mock: false, configured, enabled, status: !configured ? 'not_configured' : enabled ? 'available' : 'disabled', configuration,
      region: validRegion ? region : 'invalid', requiresApprovedReference: true, maxReferenceImages: 1, minPollIntervalMs: INTERVAL,
      supportsRemoteCancel: false, reconciliation: 'known-task-id-only', liveVerified: false, audio: 'disabled',
      imageAspectRatio: 'input-controlled; exact generated dimensions require live verification',
      verification: 'Contract-tested with injected HTTP; real submission and output CDN verification pending authorization.',
    },
    async submit(snapshot, context = {}) {
      ensureEnabled(); ensureRegion(context); validate(snapshot);
      const asset = snapshot.referenceAssets[0];
      const body = { model: MODEL.id, prompt: snapshot.prompt, duration: snapshot.duration, resolution: '720p', audio: false, off_peak: false };
      if (asset) {
        const image = await managedImage({ root, asset, approvedHashes, maxBytes: 9_999_999 });
        validateFirstFrame(image, snapshot.aspectRatio);
        body.images = [`data:${image.mimeType};base64,${image.base64}`];
        body.is_rec = false;
      } else body.aspect_ratio = snapshot.aspectRatio;
      const response = await request(asset ? '/ent/v2/img2video' : '/ent/v2/text2video', { method: 'POST', body, context });
      if (typeof response.task_id !== 'string' || !TASK_ID.test(response.task_id)) throw providerError('SUBMISSION_UNKNOWN', 'Vidu did not return a valid task ID. Do not resubmit.', { uncertain: true });
      return { providerJobId: response.task_id };
    },
    async poll(id, context = {}) {
      ensureEnabled(); ensureRegion(context); taskPath(id);
      const task = await cache.get(id, context);
      if (task.state === 'success') return { status: 'succeeded', progress: 1 };
      if (task.state === 'failed') return { status: 'failed', error: { code: task.err_code === 'UserCancelled' ? 'PROVIDER_CANCELLED' : 'PROVIDER_GENERATION_FAILED', message: task.err_code === 'UserCancelled' ? 'Vidu task was cancelled.' : 'Vidu generation failed. Review the existing task in the provider account.' } };
      return { status: 'running', progress: 0 };
    },
    async download(id, destination, context = {}) {
      ensureEnabled(); ensureRegion(context); taskPath(id);
      const task = await cache.get(id, context);
      if (task.state !== 'success') throw providerError('PROVIDER_NOT_READY', 'Vidu output is not available yet.', { retryable: true });
      return downloadMp4({ root, destination, url: outputUrl(task.creations?.[0]?.url, outputHosts), fetchImpl, context, invalidate: () => cache.invalidate(id) });
    },
    async reconcile() { return null; },
    async cancel() { return { cancelled: false, remoteCancelled: false, scope: 'local', reason: 'Only local waiting was stopped; Vidu generation and charges may continue.' }; },
  };
}
