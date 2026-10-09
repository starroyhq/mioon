import { approvedAssetHashes, approvedOutputHosts, createJsonRequest, createPollCache, downloadMp4, liveConfiguration, managedImage, outputUrl, providerError, validateModelSnapshot } from './live-common.mjs';

const ORIGIN = 'https://generativelanguage.googleapis.com';
const API = `${ORIGIN}/v1beta`;
const MODEL = {
  id: 'veo-3.1-generate-preview', name: 'Veo 3.1 (preview)', inputModes: ['text', 'image'],
  aspectRatios: ['9:16', '16:9'], durations: [4, 6, 8], referenceImages: { min: 0, max: 1, mimeTypes: ['image/png', 'image/jpeg'] },
  resolutions: ['720p'], parameters: [], promptRequired: true, maxPromptLength: 1000,
};
const INTERVAL = 10_000;
const OPERATION = /^models\/veo-3\.1-generate-preview\/operations\/[A-Za-z0-9_-]{1,200}$/;
const FILE_PATH = /^\/v1beta\/files\/[A-Za-z0-9_-]{1,200}:download$/;

function resultOf(operation) {
  if (operation.done !== true) return { status: 'running', progress: 0 };
  if (operation.error) return { status: 'failed', error: { code: 'PROVIDER_GENERATION_FAILED', message: 'Veo generation failed. Review the existing operation in the provider account.' } };
  const generated = operation.response?.generateVideoResponse;
  if (!generated || typeof generated !== 'object') throw providerError('INVALID_PROVIDER_RESPONSE', 'Veo returned an incomplete operation result.', { retryable: true });
  if (!Array.isArray(generated.generatedSamples) || generated.generatedSamples.length === 0) return { status: 'failed', error: {
    code: generated.raiMediaFilteredCount > 0 ? 'PROVIDER_CONTENT_FILTERED' : 'PROVIDER_NO_OUTPUT',
    message: generated.raiMediaFilteredCount > 0 ? 'Veo did not generate a video because of its content safety checks.' : 'Veo completed without a generated video.',
  } };
  if (typeof generated.generatedSamples[0]?.video?.uri !== 'string') throw providerError('INVALID_PROVIDER_RESPONSE', 'Veo returned an incomplete video result.', { retryable: true });
  return { status: 'succeeded', progress: 1 };
}

/** Gemini Developer API, deliberately separate from Vertex AI and its credentials. */
export function createVeoProvider({ root, fetchImpl = globalThis.fetch, env = process.env, now = Date.now } = {}) {
  const config = liveConfiguration(env, 'GEMINI_API_KEY', 'VEO');
  const approvedHashes = approvedAssetHashes(env.VEO_APPROVED_ASSET_SHA256);
  const outputHosts = approvedOutputHosts(env.VEO_OUTPUT_HOSTS, ['generativelanguage.googleapis.com']);
  const request = createJsonRequest({ api: API, headers: { 'x-goog-api-key': config.secret }, fetchImpl, ensureEnabled: config.ensureEnabled, name: 'Veo' });
  const validate = snapshot => validateModelSnapshot(snapshot, MODEL);
  function operationPath(id) {
    if (typeof id !== 'string' || !OPERATION.test(id)) throw providerError('INVALID_PROVIDER_TASK_ID', 'Veo operation name is invalid.');
    return `/${id}`;
  }
  const cache = createPollCache({ now, interval: INTERVAL, retrieve: async (id, context) => {
    const operation = await request(operationPath(id), { context });
    if (operation.name !== id || operation.done !== undefined && typeof operation.done !== 'boolean') throw providerError('INVALID_PROVIDER_RESPONSE', 'Veo response did not match the requested operation.', { retryable: true });
    resultOf(operation);
    return operation;
  } });
  return {
    id: 'veo', validate,
    capabilities: {
      id: 'veo', name: 'Gemini Veo 3.1 preview · live verification pending', models: [MODEL.id], modelCapabilities: [structuredClone(MODEL)],
      inputModes: [...MODEL.inputModes], aspectRatios: [...MODEL.aspectRatios], durations: [...MODEL.durations],
      mock: false, configured: config.configured, enabled: config.enabled, status: config.status, configuration: config.configuration,
      requiresApprovedReference: true, maxReferenceImages: 1, minPollIntervalMs: INTERVAL, supportsRemoteCancel: false,
      reconciliation: 'known-task-id-only', liveVerified: false, audio: 'always-on',
      verification: 'Contract-tested with injected HTTP; real submission pending authorization.',
    },
    async submit(snapshot, context = {}) {
      config.ensureEnabled(); validate(snapshot);
      const instance = { prompt: snapshot.prompt };
      if (snapshot.referenceAssets[0]) {
        const image = await managedImage({ root, asset: snapshot.referenceAssets[0], approvedHashes });
        instance.image = { bytesBase64Encoded: image.base64, mimeType: image.mimeType };
      }
      const response = await request(`/models/${MODEL.id}:predictLongRunning`, { method: 'POST', context, body: {
        instances: [instance], parameters: { aspectRatio: snapshot.aspectRatio, durationSeconds: snapshot.duration, resolution: '720p', sampleCount: 1 },
      } });
      if (typeof response.name !== 'string' || !OPERATION.test(response.name)) throw providerError('SUBMISSION_UNKNOWN', 'Veo did not return a valid operation name. Do not resubmit.', { uncertain: true });
      return { providerJobId: response.name };
    },
    async poll(id, context = {}) {
      config.ensureEnabled(); operationPath(id);
      return resultOf(await cache.get(id, context));
    },
    async download(id, destination, context = {}) {
      config.ensureEnabled(); operationPath(id);
      const operation = await cache.get(id, context);
      if (resultOf(operation).status !== 'succeeded') throw providerError('PROVIDER_NOT_READY', 'Veo output is not available yet.', { retryable: true });
      let url = outputUrl(operation.response.generateVideoResponse.generatedSamples[0].video.uri, outputHosts);
      let headers;
      if (url.origin === ORIGIN) {
        if (!FILE_PATH.test(url.pathname)) throw providerError('UNAPPROVED_OUTPUT_HOST', 'Veo authenticated downloads must use the official file download route.');
        // Reconstruct the SDK's fixed route; no response-supplied query can move credentials.
        url = new URL(`${url.pathname}?alt=media`, ORIGIN);
        headers = { 'x-goog-api-key': config.secret };
      }
      // Follow only exact verified/configured output hosts. The common downloader
      // strips credentials after the first response, including same-origin hops.
      const allowRedirect = (location, current) => {
        if (!location) throw providerError('INVALID_OUTPUT_URL', 'Veo output redirect has no destination.');
        let candidate;
        try { candidate = new URL(location, current); } catch { throw providerError('INVALID_OUTPUT_URL', 'Veo output redirect is invalid.'); }
        return outputUrl(candidate.href, outputHosts);
      };
      return downloadMp4({ root, destination, url, headers, fetchImpl, context, allowRedirect, invalidate: () => cache.invalidate(id) });
    },
    async reconcile() { return null; },
    async cancel() { return { cancelled: false, remoteCancelled: false, scope: 'local', reason: 'Only local waiting was stopped; Veo generation and charges may continue.' }; },
  };
}
