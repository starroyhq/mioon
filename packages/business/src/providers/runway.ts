import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createJsonRequest, createPollCache, downloadMp4, outputUrl, providerError } from './live-common.ts';
import type { OutputDownload, ProviderContext, ProviderFactoryOptions, ProviderReferenceAsset, ProviderSnapshotView } from './live-common.ts';
import {createRunwaySdkClient} from '../video/runway-sdk.ts';
import type {VideoAdapterImage} from '../video/adapters.ts';

const API = 'https://api.dev.runwayml.com';
const MAX_DATA_URI = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATIOS: Readonly<Record<string, string>> = { '9:16': '720:1280', '16:9': '1280:720', '1:1': '960:960', '3:4': '832:1104', '4:3': '1104:832', '21:9': '1584:672' };
const STATUSES = ['PENDING', 'THROTTLED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
const error = providerError;
const inside = (base: string, file: string): boolean => file !== base && file.startsWith(`${base}${path.sep}`);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;

function isImage(bytes: Buffer, mime: unknown): boolean {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return false;
}

/** Real adapter. Importing/constructing it never makes a request; network is off by default. */
export function createRunwayProvider({ root, fetchImpl = globalThis.fetch, env = process.env, now = Date.now }: ProviderFactoryOptions = {} as ProviderFactoryOptions) {
  const secret = typeof env.RUNWAYML_API_SECRET === 'string' ? env.RUNWAYML_API_SECRET.trim() : '';
  const configured = Boolean(secret);
  const enabled = () => configured && env.MIOON_ENABLE_LIVE_PROVIDER === '1';
  const approvedHashes = new Set((env.RUNWAY_APPROVED_ASSET_SHA256 ?? '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^[0-9a-f]{64}$/.test(x)));
  // The documented output CDN is allowed by default. Additional verified CDN hosts
  // can be configured server-side, never by a request, prompt, or provider response.
  const outputHosts = new Set(['dnznrvs05pmza.cloudfront.net', ...(env.RUNWAY_OUTPUT_HOSTS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(x))]);
  const ensureEnabled = (): void => { if (!enabled()) throw error('PROVIDER_DISABLED', 'Runway live calls are disabled or its server credential is missing.'); };
  const assertTaskId = (id: unknown): void => {
    if (typeof id !== 'string' || !UUID.test(id)) throw error('INVALID_PROVIDER_TASK_ID', 'Runway task ID is invalid.');
  };
  const sdk=createRunwaySdkClient({api:API,send:(endpoint,options)=>createJsonRequest({
    api:API,headers:{Authorization:`Bearer ${secret}`,'X-Runway-Version':new Headers(options.headers).get('x-runway-version')??''},fetchImpl,ensureEnabled,name:'Runway',
    // Preserve the legacy GET retryability and conservative POST classification.
    isRetryableStatus:status=>status>=500||status===429||status===408,
  })(endpoint,options)});
  const cache = createPollCache({ now, interval: 5000, retrieve: async (id, context) => {
    assertTaskId(id);
    const task = await sdk.retrieve(id,context);
    if (task.id !== id || typeof task.status !== 'string' || !(STATUSES as readonly string[]).includes(task.status)) throw error('INVALID_PROVIDER_RESPONSE', 'Runway task response did not match the requested task.', { retryable: true });
    return task;
  } });
  const retrieve = (id: unknown, context: ProviderContext = {}): Promise<Record<string, unknown>> => {
    assertTaskId(id);
    return cache.get(id as string, context);
  };
  async function referenceImage(asset: ProviderReferenceAsset): Promise<VideoAdapterImage> {
    if (!root || !asset || typeof asset.path !== 'string' || !/^[0-9a-f]{64}$/i.test(typeof asset.sha256 === 'string' ? asset.sha256 : '')) throw error('INVALID_REFERENCE', 'A managed reference image with its checksum is required.');
    const sha256 = (asset.sha256 as string).toLowerCase();
    if (!approvedHashes.has(sha256)) throw error('REFERENCE_NOT_APPROVED', 'This reference image has not been approved in the server-side Runway asset allowlist.');
    let bytes: Buffer;
    try {
      const base = await realpath(root); const file = await realpath(asset.path);
      if (!inside(base, file)) throw error('UNSAFE_REFERENCE_PATH', 'Reference image must remain inside managed storage.');
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_DATA_URI * 3 / 4) throw error('REFERENCE_TOO_LARGE', 'Reference image exceeds the Runway data URI limit.');
      bytes = await readFile(file);
    } catch (cause) {
      const code = object(cause)?.code;
      if (code === 'UNSAFE_REFERENCE_PATH' || code === 'REFERENCE_TOO_LARGE') throw cause;
      throw error('REFERENCE_UNAVAILABLE', 'The managed reference image could not be read.');
    }
    if (!isImage(bytes, asset.mimeType)) throw error('INVALID_REFERENCE_TYPE', 'Reference must be a PNG, JPEG, or WebP matching its declared type.');
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw error('REFERENCE_CHANGED', 'Reference image changed after its generation snapshot was created.');
    const base64=bytes.toString('base64'),uri = `data:${asset.mimeType as string};base64,${base64}`;
    if (Buffer.byteLength(uri) > MAX_DATA_URI) throw error('REFERENCE_TOO_LARGE', 'Encoded reference image exceeds Runway’s 5 MiB data URI limit.');
    return {mimeType:asset.mimeType as string,base64,role:'first_frame'};
  }
  function validate(snapshot: unknown): true {
    const value = object(snapshot) as ProviderSnapshotView | null;
    if (!value) throw error('INVALID_SNAPSHOT', 'A generation snapshot is required.');
    if ((value.model ?? 'gen4_turbo') !== 'gen4_turbo') throw error('UNSUPPORTED_MODEL', 'Only Runway Gen-4 Turbo is implemented.');
    if (typeof value.aspectRatio !== 'string' || !Object.hasOwn(RATIOS, value.aspectRatio) || typeof value.duration !== 'number' || !Number.isInteger(value.duration) || value.duration < 2 || value.duration > 10) throw error('UNSUPPORTED_CAPABILITY', 'Runway Gen-4 Turbo requires a supported ratio and an integer duration from 2 to 10 seconds.');
    if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 1000) throw error('INVALID_PROMPT', 'Runway prompt must contain 1 to 1000 UTF-16 code units.');
    if (!Array.isArray(value.referenceAssets) || value.referenceAssets.length !== 1) throw error('INVALID_REFERENCE_COUNT', 'Runway Gen-4 Turbo accepts exactly one first-frame image.');
    const parameters = object(value.parameters ?? {});
    if (!parameters || Object.keys(parameters).some(key => key !== 'seed')) throw error('UNSUPPORTED_PARAMETER', 'The Runway adapter currently accepts only the seed parameter.');
    if (parameters.seed !== undefined && (typeof parameters.seed !== 'number' || !Number.isInteger(parameters.seed) || parameters.seed < 0 || parameters.seed > 4294967295)) throw error('INVALID_SEED', 'Seed must be an unsigned 32-bit integer.');
    return true;
  }
  return {
    id: 'runway', validate,
    capabilities: {
      id: 'runway', name: 'Runway Gen-4 Turbo · live verification pending', models: ['gen4_turbo'], inputModes: ['image'],
      aspectRatios: Object.keys(RATIOS), durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      mock: false, configured, get enabled() { return enabled(); }, requiresApprovedReference: true, liveVerified: false,
      maxReferenceImages: 1, minPollIntervalMs: 5000, supportsRemoteCancel: false,
      reconciliation: 'known-task-id-only', verification: 'Contract-tested with injected HTTP; real submission pending authorization.',
    },
    async submit(snapshot: unknown, context: ProviderContext = {}): Promise<{providerJobId: string}> {
      ensureEnabled();
      validate(snapshot);
      const value = snapshot as ProviderSnapshotView, parameters = object(value.parameters ?? {}) ?? {};
      const image=await referenceImage(value.referenceAssets[0]);
      const response = await sdk.submit({prompt:value.prompt as string,aspectRatio:value.aspectRatio as string,duration:value.duration as number,parameters,images:[image],subjectReference:false},context);
      if (typeof response.id !== 'string' || !UUID.test(response.id)) throw error('SUBMISSION_UNKNOWN', 'Runway accepted the request but no valid task ID was received. Do not resubmit.', { uncertain: true });
      return { providerJobId: response.id };
    },
    async poll(providerJobId: string, context: ProviderContext = {}) {
      ensureEnabled();
      const task = await retrieve(providerJobId, context);
      if (task.status === 'SUCCEEDED') return { status: 'succeeded' as const, progress: 1 };
      if (task.status === 'FAILED' || task.status === 'CANCELLED') return { status: 'failed' as const, error: { code: task.status === 'CANCELLED' ? 'PROVIDER_CANCELLED' : 'PROVIDER_GENERATION_FAILED', message: task.status === 'CANCELLED' ? 'Runway task was cancelled.' : 'Runway generation failed. Review the task in the provider account before retrying.' } };
      return { status: 'running' as const, progress: typeof task.progress === 'number' && Number.isFinite(task.progress) ? Math.max(0, Math.min(0.99, task.progress)) : 0 };
    },
    async reconcile(): Promise<null> {
      // No documented request-ID lookup or create-idempotency guarantee exists for
      // this endpoint. A missing ID must remain unknown; null is NOT safe-to-retry.
      return null;
    },
    async cancel() {
      // DELETE is also permanent deletion for completed tasks. A GET preflight has
      // a race, so this adapter never disguises deletion as routine cancellation.
      return { cancelled: false, remoteCancelled: false, scope: 'local', reason: 'Runway cancellation shares a permanent-delete endpoint. Only local waiting was stopped; remote work and charges may continue.' };
    },
    async download(providerJobId: string, destination: string, context: ProviderContext = {}): Promise<OutputDownload> {
      ensureEnabled();
      const task = await retrieve(providerJobId, context);
      if (task.status !== 'SUCCEEDED') throw error('PROVIDER_NOT_READY', 'Runway output is not available yet.', { retryable: true });
      const output = task.output, first = Array.isArray(output) ? output[0] : undefined;
      const url = outputUrl(first, outputHosts);
      // Signed CDN URLs never receive API credentials or redirect permission.
      return downloadMp4({ root, destination, url, fetchImpl, context, invalidate: () => cache.invalidate(providerJobId) });
    },
  };
}
