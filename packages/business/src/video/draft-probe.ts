import type {DraftServiceProbeResult} from '../../../contracts/src/draft-service-probe.ts';
import {videoModelsListEndpoint} from '../../../contracts/src/generation-video-settings.ts';
import type {VideoModelsListInput, VideoModelsListRecipient} from '../../../contracts/src/generation-video-settings.ts';
import {readDraftServiceJson, readDraftServiceModels} from '../draft-service-probe.ts';
import {awaitProvider} from '../operation-lifecycle.ts';
import {createPinnedVideoFetch} from './network.ts';

type ProbeTarget = VideoModelsListRecipient & Pick<VideoModelsListInput, 'operation'>;
const videoModelId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function modelEntries(providerId: ProbeTarget['providerId'], payload: unknown): string[] | null {
  const body = record(payload);
  const entries = providerId === 'veo' ? body?.models : body?.data;
  if (!Array.isArray(entries)) return null;
  return entries.flatMap(entry => {
    const model = record(entry);
    if (!model) return [];
    if (providerId === 'veo') {
      const id = typeof model.name === 'string' && model.name.startsWith('models/veo-') ? model.name.slice('models/'.length) : '';
      return videoModelId.test(id) && Array.isArray(model.supportedGenerationMethods)
        && model.supportedGenerationMethods.includes('predictLongRunning') ? [id] : [];
    }
    if (typeof model.id !== 'string' || !videoModelId.test(model.id)) return [];
    if (providerId === 'ark') {
      const output = record(model.modalities)?.output_modalities;
      // The catalog also lists text and image services. Older Seedance rows
      // can be identified by their official model ID if modality is omitted.
      const video = Array.isArray(output) ? output.includes('video') : model.id.startsWith('doubao-seedance-');
      if (!video) return [];
    }
    return [model.id];
  });
}

export function supportsVideoModelsList(providerId: ProbeTarget['providerId']): boolean {
  return providerId === 'compatible' || providerId === 'ark' || providerId === 'veo';
}

function probeUrl(endpoint: string, providerId: ProbeTarget['providerId'], now: number): string {
  switch (providerId) {
    case 'veo': return `${endpoint}/models?pageSize=1000`;
    case 'ark':
    case 'compatible': return `${endpoint}/models`;
    case 'minimax': return `${endpoint}/v2/query/video_generation?page_num=1&page_size=1`;
    case 'vidu': return `${endpoint}/ent/v2/credits`;
    case 'kling': return `${endpoint}/account/costs?start_time=${now - 86_400_000}&end_time=${now}`;
    case 'wan': return `${endpoint}/tasks?page_size=1`;
  }
}

function checkReceipt(providerId: ProbeTarget['providerId'], payload: unknown): DraftServiceProbeResult {
  const body = record(payload);
  if (!body) return {result: 'failed'};
  switch (providerId) {
    case 'minimax': {
      const code = record(body.base_resp)?.status_code;
      if (code === 1004 || code === 2049) return {result: 'unauthorized'};
      return Array.isArray(body.items) && (code === undefined || code === 0) ? {result: 'ok'} : {result: 'failed'};
    }
    case 'vidu': return Array.isArray(body.remains) ? {result: 'ok'} : {result: 'failed'};
    case 'kling': {
      const data = record(body.data);
      if (body.code === 1000 || body.code === 1001 || body.code === 1002 || body.code === 1003 || body.code === 1103) return {result: 'unauthorized'};
      return body.code === 0 && data?.code === 0 && Array.isArray(data.resource_pack_subscribe_infos) ? {result: 'ok'} : {result: 'failed'};
    }
    case 'wan':
      if (body.code === 'InvalidApiKey' || body.code === 'AccessDenied') return {result: 'unauthorized'};
      return Array.isArray(body.data) && body.code === undefined ? {result: 'ok'} : {result: 'failed'};
    default: return {result: 'failed'};
  }
}

/** A fixed read-only observation through the video transport. Model discovery
 * never treats account packages, tasks or a text model catalog as video models. */
export async function probeVideoService(target: ProbeTarget, value: string, {
  fetchImpl = createPinnedVideoFetch(), signal, timeoutMs = 15_000, now = Date.now,
}: {fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; now?: () => number} = {}): Promise<DraftServiceProbeResult> {
  const {providerId, operation} = target;
  const canList = supportsVideoModelsList(providerId);
  if (operation === 'models' && !canList) return {result: 'unsupported'};
  const endpoint = videoModelsListEndpoint(target);
  const timeout = AbortSignal.timeout(timeoutMs);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers = new Headers({Accept: 'application/json'});
  if (providerId === 'veo') headers.set('x-goog-api-key', value);
  else headers.set('Authorization', `${providerId === 'vidu' ? 'Token' : 'Bearer'} ${value}`);
  if (providerId === 'kling') headers.set('Content-Type', 'application/json');
  if (providerId === 'wan' && target.workspaceId) headers.set('X-DashScope-WorkSpace', target.workspaceId);
  let response: Response;
  try {
    response = await awaitProvider(async () => {
      const received = await fetchImpl(probeUrl(endpoint, providerId, now()), {
        method: 'GET', headers,
        signal: bounded, redirect: 'error',
      });
      if (bounded.aborted) void received.body?.cancel().catch(() => {});
      return received;
    }, bounded);
  } catch (error) {
    const code = record(error)?.code;
    return {result: code === 'VIDEO_NETWORK_DENIED' ? 'denied' : 'unreachable'};
  }
  if (!response.ok || response.redirected) {
    void response.body?.cancel().catch(() => {});
    if (response.redirected) return {result: 'denied'};
    const httpStatus = response.status;
    if (httpStatus === 401 || httpStatus === 403) return {result: 'unauthorized', httpStatus};
    if (httpStatus === 404 || httpStatus === 405) return {result: 'unsupported', httpStatus};
    return {result: 'http_error', httpStatus};
  }
  if (canList) {
    const models = await readDraftServiceModels(response, value, bounded, payload => modelEntries(providerId, payload));
    if (bounded.aborted) return {result: 'unreachable'};
    if (!models) return {result: 'failed'};
    return operation === 'models' ? {result: 'ok', models} : {result: 'ok'};
  }
  const payload = await readDraftServiceJson(response, bounded);
  return bounded.aborted ? {result: 'unreachable'} : checkReceipt(providerId, payload);
}
