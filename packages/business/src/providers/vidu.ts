import { approvedAssetHashes, approvedOutputHosts, createJsonRequest, createPollCache, downloadMp4, liveConfiguration, managedImage, outputUrl, providerError, validateModelSnapshot } from './live-common.ts';
import type { OutputDownload, ProviderContext, ProviderFactoryOptions, ProviderModelSpec, ProviderSnapshotView, ProviderReferenceAsset } from './live-common.ts';

const REGIONS: Readonly<Record<string, string>> = { global: 'https://api.vidu.com', cn: 'https://api.vidu.cn' };
const MODEL: ProviderModelSpec = {
  id: 'viduq3-turbo', name: 'Vidu Q3 Turbo', inputModes: ['text', 'image'], aspectRatios: ['9:16', '16:9'], durations: [4, 8],
  referenceImages: { min: 0, max: 1, mimeTypes: ['image/png', 'image/jpeg'], matchAspectRatio: true },
  resolutions: ['720p'], parameters: [], promptRequired: true, maxPromptLength: 1000,
};
const INTERVAL = 10_000;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const STATES = ['created', 'queueing', 'processing', 'success', 'failed'] as const;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;

function validateFirstFrame(asset: ProviderReferenceAsset, ratio: string): void {
  const width = asset.width, height = asset.height;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw providerError('INVALID_REFERENCE_DIMENSIONS', 'Vidu needs valid first-frame image dimensions.');
  const [ratioWidth, ratioHeight] = ratio.split(':').map(Number);
  if (width * ratioHeight !== height * ratioWidth) throw providerError('REFERENCE_ASPECT_RATIO_MISMATCH', 'Use a Vidu first-frame image matching the selected 9:16 or 16:9 ratio.');
}

/** Q3 Turbo only. Unverified output CDN hosts must be explicitly reviewed first. */
export function createViduProvider({ root, fetchImpl = globalThis.fetch, env = process.env, now = Date.now }: ProviderFactoryOptions = {} as ProviderFactoryOptions) {
  const config = liveConfiguration(env, 'VIDU_API_KEY', 'VIDU');
  const region = env.VIDU_REGION ?? 'global', validRegion = Object.hasOwn(REGIONS, region);
  // Official task examples do not identify a trustworthy production output CDN.
  const outputHosts = approvedOutputHosts(env.VIDU_OUTPUT_HOSTS);
  const configured = config.configured && validRegion && outputHosts.size > 0;
  const enabled = config.enabled && configured;
  const configuration = { missing: [...config.configuration.missing, ...(!validRegion ? ['VIDU_REGION (global or cn)'] : []), ...(!outputHosts.size ? ['VIDU_OUTPUT_HOSTS'] : [])], requirements: [...config.configuration.requirements, 'VIDU_REGION=global|cn (credential must match region)', 'VIDU_OUTPUT_HOSTS (exact independently reviewed output CDN hostnames)'] };
  const ensureEnabled = (): void => {
    config.ensureEnabled();
    if (!validRegion) throw providerError('PROVIDER_CONFIGURATION', 'Vidu server region must be global or cn.');
    if (!outputHosts.size) throw providerError('PROVIDER_CONFIGURATION', 'Vidu needs an independently verified server-side output CDN allowlist before generation.');
  };
  const ensureRegion = (context: ProviderContext): void => { if (context.providerRegion !== undefined && context.providerRegion !== region) throw providerError('PROVIDER_REGION_CHANGED', 'Vidu account region changed after this job was created. Restore its original server region before continuing.'); };
  const approvedHashes = approvedAssetHashes(env.VIDU_APPROVED_ASSET_SHA256);
  const request = createJsonRequest({ api: REGIONS[region] ?? REGIONS.global, headers: { Authorization: `Token ${config.secret}` }, fetchImpl, ensureEnabled, name: 'Vidu' });
  function validate(snapshot: unknown): true {
    validateModelSnapshot(snapshot, MODEL);
    const value = snapshot as ProviderSnapshotView;
    if (value.referenceAssets[0]) validateFirstFrame(value.referenceAssets[0], value.aspectRatio as string);
    return true;
  }
  function taskPath(id: unknown): string {
    if (typeof id !== 'string' || !TASK_ID.test(id)) throw providerError('INVALID_PROVIDER_TASK_ID', 'Vidu task ID is invalid.');
    return `/ent/v2/tasks/${id}/creations`;
  }
  const cache = createPollCache({ now, interval: INTERVAL, retrieve: async (id, context) => {
    const task = await request(taskPath(id), { context });
    if (task.id !== id || typeof task.state !== 'string' || !(STATES as readonly string[]).includes(task.state)) throw providerError('INVALID_PROVIDER_RESPONSE', 'Vidu status did not match the requested task.', { retryable: true });
    return task;
  } });
  return {
    id: 'vidu', validate,
    capabilities: {
      id: 'vidu', name: 'Vidu Q3 Turbo · live verification pending', models: [MODEL.id], modelCapabilities: [structuredClone(MODEL)],
      inputModes: [...(MODEL.inputModes ?? [])], aspectRatios: [...MODEL.aspectRatios], durations: [...MODEL.durations],
      mock: false, configured, enabled, status: !configured ? 'not_configured' : enabled ? 'available' : 'disabled', configuration,
      region: validRegion ? region : 'invalid', requiresApprovedReference: true, maxReferenceImages: 1, minPollIntervalMs: INTERVAL,
      supportsRemoteCancel: false, reconciliation: 'known-task-id-only', liveVerified: false, audio: 'disabled',
      imageAspectRatio: 'input-controlled; exact generated dimensions require live verification',
      verification: 'Contract-tested with injected HTTP; real submission and output CDN verification pending authorization.',
    },
    async submit(snapshot: unknown, context: ProviderContext = {}): Promise<{providerJobId: string}> {
      ensureEnabled(); ensureRegion(context); validate(snapshot);
      const value = snapshot as ProviderSnapshotView;
      const asset = value.referenceAssets[0];
      const body: Record<string, unknown> = { model: MODEL.id, prompt: value.prompt, duration: value.duration, resolution: '720p', audio: false, off_peak: false };
      if (asset) {
        const image = await managedImage({ root, asset, approvedHashes, maxBytes: 9_999_999 });
        validateFirstFrame(image, value.aspectRatio as string);
        body.images = [`data:${image.mimeType};base64,${image.base64}`];
        body.is_rec = false;
      } else body.aspect_ratio = value.aspectRatio;
      const response = await request(asset ? '/ent/v2/img2video' : '/ent/v2/text2video', { method: 'POST', body, context });
      if (typeof response.task_id !== 'string' || !TASK_ID.test(response.task_id)) throw providerError('SUBMISSION_UNKNOWN', 'Vidu did not return a valid task ID. Do not resubmit.', { uncertain: true });
      return { providerJobId: response.task_id };
    },
    async poll(id: string, context: ProviderContext = {}) {
      ensureEnabled(); ensureRegion(context); taskPath(id);
      const task = await cache.get(id, context);
      if (task.state === 'success') return { status: 'succeeded' as const, progress: 1 };
      if (task.state === 'failed') return { status: 'failed' as const, error: { code: task.err_code === 'UserCancelled' ? 'PROVIDER_CANCELLED' : 'PROVIDER_GENERATION_FAILED', message: task.err_code === 'UserCancelled' ? 'Vidu task was cancelled.' : 'Vidu generation failed. Review the existing task in the provider account.' } };
      return { status: 'running' as const, progress: 0 };
    },
    async download(id: string, destination: string, context: ProviderContext = {}): Promise<OutputDownload> {
      ensureEnabled(); ensureRegion(context); taskPath(id);
      const task = await cache.get(id, context);
      if (task.state !== 'success') throw providerError('PROVIDER_NOT_READY', 'Vidu output is not available yet.', { retryable: true });
      const creations = task.creations, first = Array.isArray(creations) ? object(creations[0]) : null;
      return downloadMp4({ root, destination, url: outputUrl(first?.url, outputHosts), fetchImpl, context, invalidate: () => cache.invalidate(id) });
    },
    async reconcile(): Promise<null> { return null; },
    async cancel() { return { cancelled: false, remoteCancelled: false, scope: 'local', reason: 'Only local waiting was stopped; Vidu generation and charges may continue.' }; },
  };
}
