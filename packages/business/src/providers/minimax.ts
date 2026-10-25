import { approvedAssetHashes, approvedOutputHosts, createJsonRequest, createPollCache, downloadMp4, liveConfiguration, managedImage, outputUrl, providerError, validateModelSnapshot } from './live-common.ts';
import type { OutputDownload, ProviderContext, ProviderFactoryOptions, ProviderModelSpec, ProviderSnapshotView, ProviderReferenceAsset } from './live-common.ts';
import {createMinimaxSdkClient} from '../video/minimax-sdk.ts';
import {minimaxOutputHosts} from '../../../contracts/src/video-providers.ts';
import type {VideoAdapterImage} from '../video/adapters.ts';

const REGIONS: Readonly<Record<string, string>> = { global: 'https://api.minimax.io', cn: 'https://api.minimax.cn' };
const MODEL: ProviderModelSpec = {
  id: 'MiniMax-H3', name: 'MiniMax H3', inputModes: ['text', 'image'], aspectRatios: ['9:16', '16:9'], durations: [4, 8],
  referenceImages: { min: 0, max: 1, mimeTypes: ['image/png', 'image/jpeg'], minDimension: 256, maxDimension: 5760, matchAspectRatio: true },
  resolutions: ['2K'], parameters: [], promptRequired: true, maxPromptLength: 1000,
};
const INTERVAL = 10_000;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;

function validateFirstFrame(asset: ProviderReferenceAsset, ratio: string): void {
  const width = asset.width, height = asset.height;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 256 || height < 256 || width > 5760 || height > 5760) throw providerError('INVALID_REFERENCE_DIMENSIONS', 'MiniMax first-frame images must be 256–5760 pixels on each side.');
  const [ratioWidth, ratioHeight] = ratio.split(':').map(Number);
  if (width * ratioHeight !== height * ratioWidth) throw providerError('REFERENCE_ASPECT_RATIO_MISMATCH', 'MiniMax preserves first-frame aspect ratio. Use an image matching the chosen 9:16 or 16:9 ratio.');
}

/** H3 V2 only. Region selects two verified origins, never an arbitrary base URL. */
export function createMinimaxProvider({ root, fetchImpl = globalThis.fetch, env = process.env, now = Date.now }: ProviderFactoryOptions = {} as ProviderFactoryOptions) {
  const config = liveConfiguration(env, 'MINIMAX_API_KEY', 'MINIMAX');
  const region = env.MINIMAX_REGION ?? 'global', validRegion = Object.hasOwn(REGIONS, region);
  const configured = config.configured && validRegion;
  const enabled = config.enabled && configured;
  const configuration = { missing: [...config.configuration.missing, ...(!validRegion ? ['MINIMAX_REGION (global or cn)'] : [])], requirements: [...config.configuration.requirements, 'MINIMAX_REGION=global|cn (credential must match the selected region)'] };
  const ensureEnabled = (): void => { config.ensureEnabled(); if (!validRegion) throw providerError('PROVIDER_CONFIGURATION', 'MiniMax server region must be global or cn.'); };
  const ensureRegion = (context: ProviderContext): void => { if (context.providerRegion !== undefined && context.providerRegion !== region) throw providerError('PROVIDER_REGION_CHANGED', 'MiniMax account region changed after this job was created. Restore its original server region before continuing.'); };
  const approvedHashes = approvedAssetHashes(env.MINIMAX_APPROVED_ASSET_SHA256);
  const outputHosts = approvedOutputHosts(env.MINIMAX_OUTPUT_HOSTS, minimaxOutputHosts(region));
  const request = createJsonRequest({ api: REGIONS[region] ?? REGIONS.global, headers: { Authorization: `Bearer ${config.secret}` }, fetchImpl, ensureEnabled, name: 'MiniMax' });
  const sdk = createMinimaxSdkClient({api:REGIONS[region]??REGIONS.global,model:MODEL.id,send:request});
  function validate(snapshot: unknown): true {
    const capabilities=object(object(snapshot)?.capabilities);
    const models=Array.isArray(capabilities?.modelCapabilities)?capabilities.modelCapabilities.map(object):[];
    const frozenModel=models.find(model=>model?.id===MODEL.id);
    // A historical legacy snapshot may omit parameters while freezing 768P in
    // its advertised model. It remains observable, but must not retry as 2K.
    if(Array.isArray(frozenModel?.resolutions)&&!frozenModel.resolutions.includes('2K'))throw providerError('UNSUPPORTED_PARAMETERS','The original MiniMax task resolution is not supported by the official SDK. Its frozen snapshot was not changed.',{beforeDispatch:true});
    validateModelSnapshot(snapshot, MODEL);
    const value = snapshot as ProviderSnapshotView;
    if (value.referenceAssets[0]) validateFirstFrame(value.referenceAssets[0], value.aspectRatio as string);
    return true;
  }
  function taskId(id: unknown): string {
    if (typeof id !== 'string' || !TASK_ID.test(id)) throw providerError('INVALID_PROVIDER_TASK_ID', 'MiniMax task ID is invalid.');
    return id;
  }
  const cache = createPollCache({ now, interval: INTERVAL, retrieve: async (id, context) => {
    taskId(id);
    const response = await sdk.retrieve(id,context);
    const task = object(response.task);
    if (!task || task.id !== id || typeof task.status !== 'string' || !(STATUSES as readonly string[]).includes(task.status)) throw providerError('INVALID_PROVIDER_RESPONSE', 'MiniMax status did not match the requested task.', { retryable: true });
    return task;
  } });
  return {
    id: 'minimax', validate,
    capabilities: {
      id: 'minimax', name: 'MiniMax H3 · live verification pending', models: [MODEL.id], modelCapabilities: [structuredClone(MODEL)],
      inputModes: [...(MODEL.inputModes ?? [])], aspectRatios: [...MODEL.aspectRatios], durations: [...MODEL.durations],
      mock: false, configured, enabled, status: !configured ? 'not_configured' : enabled ? 'available' : 'disabled', configuration,
      region: validRegion ? region : 'invalid', requiresApprovedReference: true, maxReferenceImages: 1, minPollIntervalMs: INTERVAL,
      supportsRemoteCancel: false, reconciliation: 'known-task-id-only', liveVerified: false,
      verification: 'Contract-tested with injected HTTP; real submission pending authorization.',
    },
    async submit(snapshot: unknown, context: ProviderContext = {}): Promise<{providerJobId: string}> {
      ensureEnabled(); ensureRegion(context); validate(snapshot);
      const value = snapshot as ProviderSnapshotView;
      const images:VideoAdapterImage[]=[],asset=value.referenceAssets[0];
      if (asset) {
        const image = await managedImage({ root, asset, approvedHashes });
        validateFirstFrame(image, value.aspectRatio as string);
        images.push({mimeType:image.mimeType,base64:image.base64,role:'first_frame'});
      }
      const response=await sdk.submit({prompt:value.prompt as string,aspectRatio:value.aspectRatio as string,duration:value.duration as number,parameters:{resolution:'2K'},images,subjectReference:false},context);
      if (typeof response.task_id !== 'string' || !TASK_ID.test(response.task_id)) throw providerError('SUBMISSION_UNKNOWN', 'MiniMax did not return a valid task ID. Do not resubmit.', { uncertain: true });
      return { providerJobId: response.task_id };
    },
    async poll(id: string, context: ProviderContext = {}) {
      ensureEnabled(); ensureRegion(context); taskId(id);
      const task = await cache.get(id, context);
      if (task.status === 'succeeded') return { status: 'succeeded' as const, progress: 1 };
      if (['failed', 'cancelled'].includes(task.status as string)) return { status: 'failed' as const, error: { code: task.status === 'cancelled' ? 'PROVIDER_CANCELLED' : 'PROVIDER_GENERATION_FAILED', message: task.status === 'cancelled' ? 'MiniMax task was cancelled.' : 'MiniMax generation failed. Review the existing task in the provider account.' } };
      return { status: 'running' as const, progress: 0 };
    },
    async download(id: string, destination: string, context: ProviderContext = {}): Promise<OutputDownload> {
      ensureEnabled(); ensureRegion(context); taskId(id);
      const task = await cache.get(id, context);
      if (task.status !== 'succeeded') throw providerError('PROVIDER_NOT_READY', 'MiniMax output is not available yet.', { retryable: true });
      const content = object(task.content);
      return downloadMp4({ root, destination, url: outputUrl(content?.url, outputHosts), fetchImpl, context, invalidate: () => cache.invalidate(id) });
    },
    async reconcile(): Promise<null> { return null; },
    async cancel() { return { cancelled: false, remoteCancelled: false, scope: 'local', reason: 'MiniMax cancellation can permanently delete terminal records. Only local waiting was stopped; generation and charges may continue.' }; },
  };
}
