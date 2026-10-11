import { approvedAssetHashes, approvedOutputHosts, createJsonRequest, createPollCache, downloadMp4, liveConfiguration, managedImage, outputUrl, providerError, validateModelSnapshot } from './live-common.mjs';

const API = 'https://ark.cn-beijing.volces.com/api/v3';
const MODEL = {
  id: 'doubao-seedance-2-5-260628', name: 'Seedance 2.5', inputModes: ['text', 'image'],
  aspectRatios: ['9:16', '16:9'], durations: [4, 8],
  referenceImages: { min: 0, max: 2, mimeTypes: ['image/png', 'image/jpeg'], minDimension: 300, maxDimension: 6000, matchAspectRatio: true },
  resolutions: ['720p'], parameters: [], promptRequired: true, maxPromptLength: 1000,
};
const INTERVAL = 10_000;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'];

function validateFrame(asset, ratio) {
  if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 300 || asset.height < 300 || asset.width > 6000 || asset.height > 6000) throw providerError('INVALID_REFERENCE_DIMENSIONS', 'Seedance frame images must be 300–6000 pixels on each side.');
  const [width, height] = ratio.split(':').map(Number);
  if (asset.width * height !== asset.height * width) throw providerError('REFERENCE_ASPECT_RATIO_MISMATCH', 'Seedance frame images must match the chosen 9:16 or 16:9 ratio.');
}

/** Fixed-origin Seedance adapter. No request, upload, or credential use at construction. */
export function createArkProvider({ root, fetchImpl = globalThis.fetch, env = process.env, now = Date.now } = {}) {
  const config = liveConfiguration(env, 'ARK_API_KEY', 'ARK');
  const approvedHashes = approvedAssetHashes(env.ARK_APPROVED_ASSET_SHA256);
  const outputHosts = approvedOutputHosts(env.ARK_OUTPUT_HOSTS, ['ark-content-generation-cn-beijing.tos-cn-beijing.volces.com', 'ark-acg-cn-beijing.tos-cn-beijing.volces.com']);
  const request = createJsonRequest({ api: API, headers: { Authorization: `Bearer ${config.secret}` }, fetchImpl, ensureEnabled: config.ensureEnabled, name: 'Seedance' });
  function validate(snapshot) {
    validateModelSnapshot(snapshot, MODEL);
    const assets=snapshot.referenceAssets;
    if(snapshot.lastFrameAssetId!=null&&assets.length!==2)throw providerError('INVALID_REFERENCE_MANIFEST','A declared last frame requires a complete explicit frame pair.');
    if(snapshot.referenceAssetIds!==undefined&&(!Array.isArray(snapshot.referenceAssetIds)||snapshot.referenceAssetIds.length!==assets.length||snapshot.referenceAssetIds.some((id,index)=>id!==assets[index]?.id)))throw providerError('INVALID_REFERENCE_MANIFEST','Reference identities differ from the frozen image manifest.');
    if(assets.length===2){
      if(assets[0].role!=='first_frame'||assets[1].role!=='last_frame')throw providerError('INVALID_REFERENCE_MANIFEST','A frame pair requires explicit first_frame and last_frame roles.');
      if(typeof assets[0].id!=='string'||typeof assets[1].id!=='string'||assets[0].id===assets[1].id)throw providerError('INVALID_REFERENCE_MANIFEST','First and last frames must be distinct managed assets.');
      if(Object.hasOwn(snapshot,'lastFrameAssetId')&&snapshot.lastFrameAssetId!==assets[1].id)throw providerError('INVALID_REFERENCE_MANIFEST','Last-frame selection does not match the explicit manifest.');
    }else if(assets[0]?.role!==undefined&&assets[0].role!=='first_frame')throw providerError('UNSUPPORTED_INPUT_ROLE','A last frame requires a first frame.');
    if(snapshot.referenceBindings!==undefined){
      const bindings=snapshot.referenceBindings;
      if(!Array.isArray(bindings)||bindings.length!==assets.length||Object.keys(bindings).length!==bindings.length||bindings.some((binding,index)=>!binding||Object.keys(binding).some(key=>!['role','assetId','sha256'].includes(key))||binding.assetId!==assets[index].id||binding.sha256!==assets[index].sha256||binding.role!==(assets[index].role??'first_frame')))throw providerError('INVALID_REFERENCE_MANIFEST','Explicit frame bindings differ from the frozen image manifest.');
    }
    for(const asset of assets)validateFrame(asset,snapshot.aspectRatio);
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
      requiresApprovedReference: true, maxReferenceImages: 2, minPollIntervalMs: INTERVAL, supportsRemoteCancel: false,
      reconciliation: 'known-task-id-only', liveVerified: false, audio: 'disabled',
      verification: 'Contract-tested with injected HTTP; real submission pending authorization.',
    },
    async submit(snapshot, context = {}) {
      config.ensureEnabled();
      validate(snapshot);
      const content = [{ type: 'text', text: snapshot.prompt }];
      // Each image is independently approved and verified from actual bytes.
      // Only the legacy one-image case may default to the first-frame role.
      for(const asset of snapshot.referenceAssets){
        const image = await managedImage({ root, asset, approvedHashes, signal:context.signal, validateCurrent:context.validateReferenceState });
        validateFrame(image, snapshot.aspectRatio);
        if(image.width!==asset.width||image.height!==asset.height)throw providerError('REFERENCE_CHANGED','Actual frame dimensions differ from the frozen image metadata.');
        content.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` }, role: asset.role??'first_frame' });
      }
      const response = await request('/contents/generations/tasks', { method: 'POST', context, body: {
        model: MODEL.id, content, duration: snapshot.duration, ratio: snapshot.referenceAssets.length ? 'adaptive' : snapshot.aspectRatio,
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
