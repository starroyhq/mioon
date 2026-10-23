import { approvedAssetHashes, approvedOutputHosts, createJsonRequest, createPollCache, downloadMp4, liveConfiguration, managedImage, outputUrl, providerError, validateModelSnapshot } from './live-common.ts';
import type { OutputDownload, ProviderContext, ProviderFactoryOptions, ProviderSnapshotView, ProviderModelSpec } from './live-common.ts';
import {createVeoSdkClient} from '../video/veo-sdk.ts';

const ORIGIN = 'https://generativelanguage.googleapis.com';
const API = `${ORIGIN}/v1beta`;
const MODEL: ProviderModelSpec = {
  id: 'veo-3.1-generate-preview', name: 'Veo 3.1 (preview)', inputModes: ['text', 'image'],
  aspectRatios: ['9:16', '16:9'], durations: [4, 6, 8], referenceImages: { min: 0, max: 1, mimeTypes: ['image/png', 'image/jpeg'] },
  resolutions: ['720p'], parameters: [], promptRequired: true, maxPromptLength: 1000,
};
const INTERVAL = 10_000;
const OPERATION = /^models\/veo-3\.1-generate-preview\/operations\/[A-Za-z0-9_-]{1,200}$/;
const FILE_PATH = /^\/v1beta\/files\/[A-Za-z0-9_-]{1,200}:download$/;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;

function resultOf(operation: Record<string, unknown>) {
  if (operation.done !== true) return { status: 'running' as const, progress: 0 };
  if (operation.error) return { status: 'failed' as const, error: { code: 'PROVIDER_GENERATION_FAILED', message: 'Veo generation failed. Review the existing operation in the provider account.' } };
  const response = object(operation.response), generated = response ? object(response.generateVideoResponse) : null;
  if (!generated) throw providerError('INVALID_PROVIDER_RESPONSE', 'Veo returned an incomplete operation result.', { retryable: true });
  const samples = generated.generatedSamples, filtered = typeof generated.raiMediaFilteredCount === 'number' ? generated.raiMediaFilteredCount : 0;
  if (!Array.isArray(samples) || samples.length === 0) return { status: 'failed' as const, error: {
    code: filtered > 0 ? 'PROVIDER_CONTENT_FILTERED' : 'PROVIDER_NO_OUTPUT',
    message: filtered > 0 ? 'Veo did not generate a video because of its content safety checks.' : 'Veo completed without a generated video.',
  } };
  const first = object(samples[0]), video = first ? object(first.video) : null;
  if (typeof video?.uri !== 'string') throw providerError('INVALID_PROVIDER_RESPONSE', 'Veo returned an incomplete video result.', { retryable: true });
  return { status: 'succeeded' as const, progress: 1 };
}

/** Gemini Developer API, deliberately separate from Vertex AI and its credentials. */
export function createVeoProvider({ root, fetchImpl = globalThis.fetch, env = process.env, now = Date.now }: ProviderFactoryOptions = {} as ProviderFactoryOptions) {
  const config = liveConfiguration(env, 'GEMINI_API_KEY', 'VEO');
  const approvedHashes = approvedAssetHashes(env.VEO_APPROVED_ASSET_SHA256);
  const outputHosts = approvedOutputHosts(env.VEO_OUTPUT_HOSTS, ['generativelanguage.googleapis.com']);
  const request = createJsonRequest({ api: API, headers: { 'x-goog-api-key': config.secret }, fetchImpl, ensureEnabled: config.ensureEnabled, name: 'Veo' });
  const sdk = createVeoSdkClient({api: API,model: MODEL.id,send: request});
  const validate = (snapshot: unknown): true => validateModelSnapshot(snapshot, MODEL);
  function operationPath(id: unknown): string {
    if (typeof id !== 'string' || !OPERATION.test(id)) throw providerError('INVALID_PROVIDER_TASK_ID', 'Veo operation name is invalid.');
    return `/${id}`;
  }
  const cache = createPollCache({ now, interval: INTERVAL, retrieve: async (id, context) => {
    operationPath(id);
    const operation = await sdk.retrieve(id, context);
    if (operation.name !== id || operation.done !== undefined && typeof operation.done !== 'boolean') throw providerError('INVALID_PROVIDER_RESPONSE', 'Veo response did not match the requested operation.', { retryable: true });
    resultOf(operation);
    return operation;
  } });
  return {
    id: 'veo', validate,
    capabilities: {
      id: 'veo', name: 'Gemini Veo 3.1 preview · live verification pending', models: [MODEL.id], modelCapabilities: [structuredClone(MODEL)],
      inputModes: [...(MODEL.inputModes ?? [])], aspectRatios: [...MODEL.aspectRatios], durations: [...MODEL.durations],
      mock: false, configured: config.configured, enabled: config.enabled, status: config.status, configuration: config.configuration,
      requiresApprovedReference: true, maxReferenceImages: 1, minPollIntervalMs: INTERVAL, supportsRemoteCancel: false,
      reconciliation: 'known-task-id-only', liveVerified: false, audio: 'always-on',
      verification: 'Contract-tested with injected HTTP; real submission pending authorization.',
    },
    async submit(snapshot: unknown, context: ProviderContext = {}): Promise<{providerJobId: string}> {
      config.ensureEnabled(); validate(snapshot);
      const value = snapshot as ProviderSnapshotView;
      const images = [];
      if (value.referenceAssets[0]) {
        const image = await managedImage({ root, asset: value.referenceAssets[0], approvedHashes, signal: context.signal, validateCurrent: context.validateReferenceState });
        images.push({base64: image.base64,mimeType: image.mimeType,role: 'first_frame'});
      }
      const response = await sdk.submit({prompt: value.prompt as string,aspectRatio: value.aspectRatio as string,duration: value.duration as number,parameters: {resolution: '720p'},images,subjectReference: false}, context);
      if (typeof response.name !== 'string' || !OPERATION.test(response.name)) throw providerError('SUBMISSION_UNKNOWN', 'Veo did not return a valid operation name. Do not resubmit.', { uncertain: true });
      return { providerJobId: response.name };
    },
    async poll(id: string, context: ProviderContext = {}) {
      config.ensureEnabled(); operationPath(id);
      return resultOf(await cache.get(id, context));
    },
    async download(id: string, destination: string, context: ProviderContext = {}): Promise<OutputDownload> {
      config.ensureEnabled(); operationPath(id);
      const operation = await cache.get(id, context);
      if (resultOf(operation).status !== 'succeeded') throw providerError('PROVIDER_NOT_READY', 'Veo output is not available yet.', { retryable: true });
      const response = object(operation.response), generated = response ? object(response.generateVideoResponse) : null;
      const samples = generated?.generatedSamples, first = Array.isArray(samples) ? object(samples[0]) : null, video = first ? object(first.video) : null;
      let url = outputUrl(video?.uri, outputHosts);
      let headers: Record<string, string> | undefined;
      if (url.origin === ORIGIN) {
        if (!FILE_PATH.test(url.pathname)) throw providerError('UNAPPROVED_OUTPUT_HOST', 'Veo authenticated downloads must use the official file download route.');
        // Reconstruct the SDK's fixed route; no response-supplied query can move credentials.
        url = new URL(`${url.pathname}?alt=media`, ORIGIN);
        headers = { 'x-goog-api-key': config.secret };
      }
      // Follow only exact verified/configured output hosts. The common downloader
      // strips credentials after the first response, including same-origin hops.
      const allowRedirect = (location: string | null, current: URL): URL => {
        if (!location) throw providerError('INVALID_OUTPUT_URL', 'Veo output redirect has no destination.');
        let candidate: URL;
        try { candidate = new URL(location, current); } catch { throw providerError('INVALID_OUTPUT_URL', 'Veo output redirect is invalid.'); }
        return outputUrl(candidate.href, outputHosts);
      };
      return downloadMp4({ root, destination, url, headers, fetchImpl, context, allowRedirect, invalidate: () => cache.invalidate(id) });
    },
    async reconcile(): Promise<null> { return null; },
    async cancel() { return { cancelled: false, remoteCancelled: false, scope: 'local', reason: 'Only local waiting was stopped; Veo generation and charges may continue.' }; },
  };
}
