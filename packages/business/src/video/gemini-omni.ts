import {awaitProvider, checkpoint, operationCancelled} from '../operation-lifecycle.ts';
import {downloadMp4, outputUrl, providerError, providerHttpError, timeoutSignal} from '../providers/live-common.ts';
import type {OutputDownload, ProviderContext} from '../providers/live-common.ts';
import type {ConfiguredVideoTask, VideoAdapterInput} from './adapters.ts';
import {getOmniFailure, omniFailure, omniProviderError, rememberOmniTaskFailure, rememberOmniTaskLookupFailure} from './gemini-omni-errors.ts';
export {getOmniFailure, getOmniTaskFailure} from './gemini-omni-errors.ts';

const ORIGIN = 'https://generativelanguage.googleapis.com';
const API = ORIGIN + '/v1beta';
const MODEL = 'gemini-omni-1.2-flash';
const TASK = /^[A-Za-z0-9_-]{1,200}$/u;
const FILE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const OUTPUT_BYTES = 128 * 1024 * 1024;
const RESPONSE_BYTES = Math.ceil(OUTPUT_BYTES / 3) * 4 + 64 * 1024;
const SMALL_RESPONSE_BYTES = 1024 * 1024;
const INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const invalid = () => providerError('INVALID_PROVIDER_RESPONSE', 'Gemini returned an incomplete video result.', {retryable: true});
function taskId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !TASK.test(id)) throw providerError('INVALID_PROVIDER_TASK_ID', 'The Gemini interaction identity is invalid.');
}
function base64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes / 3) * 4 ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value))
    throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value) throw invalid();
  return bytes;
}
async function readJson(response: Response, limit: number, signal?: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > limit) {await response.body?.cancel().catch(() => {}); throw invalid();}
  if (!response.body) throw invalid();
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      checkpoint(signal);
      const {done, value} = await awaitProvider(() => reader.read(), signal);
      checkpoint(signal);
      if (done) break;
      size += value.length;
      if (size > limit) throw invalid();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    const cancelled = reader.cancel().catch(() => {});
    if (!signal?.aborted) await cancelled;
    throw error;
  } finally {reader.releaseLock();}
}
interface GeminiOmniClientOptions {
  api: string;
  model: string;
  root: string;
  acquireCredential: (context: ProviderContext) => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  outputHosts?: readonly string[];
}
interface Observation {
  task: ConfiguredVideoTask;
  video?: {data?: string; uri?: string};
}
function videoFile(uri: unknown): {id: string; url: URL} {
  if (typeof uri !== 'string') throw invalid();
  let url: URL;
  try {url = new URL(uri);} catch {throw invalid();}
  const match = /^\/v1beta\/files\/([^/]+?)(?::download)?$/u.exec(url.pathname);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || !match || !FILE.test(match[1]!) ||
      [...url.searchParams].some(([key, value]) => key !== 'alt' || value !== 'media')) throw providerError('UNAPPROVED_OUTPUT_HOST', 'Gemini returned an unapproved file resource.');
  return {id: match[1]!, url: new URL(API + '/files/' + match[1] + ':download?alt=media')};
}
function observe(value: unknown, id: string): Observation {
  const interaction = object(value);
  if (!interaction || interaction.id !== id || interaction.model !== undefined && interaction.model !== MODEL ||
      interaction.object !== undefined && interaction.object !== 'interaction' ||
      !['in_progress', 'completed', 'failed', 'cancelled', 'incomplete', 'requires_action'].includes(String(interaction.status))) throw invalid();
  if (interaction.status === 'in_progress') return {task: {id, status: 'running', progress: 0}};
  if (interaction.status !== 'completed') {
    return {task: rememberOmniTaskFailure({id, status: 'failed' as const}, omniFailure(interaction))};
  }
  if (!Array.isArray(interaction.steps) || interaction.steps.length > 256) throw invalid();
  const videos = interaction.steps.flatMap(rawStep => {
    const step = object(rawStep);
    if (step?.type !== 'model_output') return [];
    if (!Array.isArray(step.content) || step.content.length > 256) throw invalid();
    return step.content.map(object).filter(content => content?.type === 'video');
  });
  const video = videos[0];
  if (videos.length !== 1 || !video || video.mime_type !== 'video/mp4' || (typeof video.data !== 'string') === (typeof video.uri !== 'string')) throw invalid();
  if (typeof video.uri === 'string') return {task: {id, status: 'succeeded', progress: 1, url: videoFile(video.uri).url.href}, video: {uri: video.uri}};
  if (typeof video.data !== 'string' || !video.data.length || video.data.length > Math.ceil(OUTPUT_BYTES / 3) * 4) throw invalid();
  return {task: {id, status: 'succeeded', progress: 1}, video: {data: video.data}};
}

/** Gemini Interactions wire protocol. Media is transient and never enters the
 * task observation cache, persisted job record, or request-error diagnostic. */
export function createGeminiOmniClient({api, model, root, acquireCredential, fetchImpl = globalThis.fetch, outputHosts = [new URL(ORIGIN).hostname]}: GeminiOmniClientOptions) {
  if (api !== API || model !== MODEL) throw providerError('VIDEO_BINDING_INVALID', 'Gemini Omni requires its exact reviewed model and official Interactions endpoint.');
  const hosts = new Set([new URL(ORIGIN).hostname, ...outputHosts]);
  async function request(endpoint: string, method: 'POST' | 'GET', context: ProviderContext, body?: unknown, media = false): Promise<unknown> {
    if (context.signal?.aborted) throw operationCancelled({beforeDispatch: method === 'POST'});
    const secret = await acquireCredential(context);
    if (context.signal?.aborted) throw operationCancelled({beforeDispatch: method === 'POST'});
    if (method === 'POST') context.beforeSubmit?.();
    if (context.signal?.aborted) throw operationCancelled({beforeDispatch: method === 'POST'});
    const signal = timeoutSignal(context, method === 'POST' ? 30000 : 120000);
    let response: Response;
    try {
      response = await awaitProvider(() => fetchImpl(API + endpoint, {
        method, headers: {'x-goog-api-key': secret, Accept: 'application/json', ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}), redirect: 'error', signal,
      }), signal, {submit: method === 'POST'});
    } catch (error) {
      const notDispatched = object(error)?.notDispatched === true;
      if (notDispatched && context.signal?.aborted) throw operationCancelled({beforeDispatch: method === 'POST'});
      throw providerError(method === 'POST' && !notDispatched ? 'SUBMISSION_UNKNOWN' : 'PROVIDER_UNAVAILABLE',
        method === 'POST' && !notDispatched ? 'Gemini submission was not confirmed. Query the existing task before generating again.' : 'The Gemini request could not be completed.',
        {uncertain: method === 'POST' && !notDispatched, retryable: method === 'GET'});
    }
    if (!response.ok) {
      let payload: unknown;
      try {payload = await readJson(response, 64 * 1024, signal);} catch { /* Preserve the HTTP classification. */ }
      const error = providerHttpError({status: response.status, method, message: 'Gemini rejected the request.',
        uncertainMessage: 'Gemini submission was not confirmed. Query the existing task before generating again.',
        detail: omniFailure(payload)});
      if (method === 'GET' && endpoint.startsWith('/interactions/')) rememberOmniTaskLookupFailure(error);
      throw error;
    }
    try {return await readJson(response, media ? RESPONSE_BYTES : SMALL_RESPONSE_BYTES, signal);}
    catch {
      throw providerError(method === 'POST' ? 'SUBMISSION_UNKNOWN' : 'INVALID_PROVIDER_RESPONSE', 'The Gemini response could not be read.',
        {uncertain: method === 'POST', retryable: method === 'GET'});
    }
  }
  async function existing(id: string, context: ProviderContext): Promise<Observation> {
    taskId(id);
    return observe(await request('/interactions/' + id, 'GET', context, undefined, true), id);
  }
  async function fileState(uri: string, context: ProviderContext): Promise<{id: string; url: URL; active: boolean}> {
    const file = videoFile(uri), result = object(await request('/files/' + file.id, 'GET', context));
    if (!result || result.name !== 'files/' + file.id || !['ACTIVE', 'PROCESSING', 'FAILED'].includes(String(result.state))) throw invalid();
    if (result.state === 'FAILED') throw omniProviderError('PROVIDER_GENERATION_FAILED', 'Gemini could not prepare the generated video.', omniFailure(result));
    return {...file, active: result.state === 'ACTIVE'};
  }
  return {
    async submit(input: VideoAdapterInput, context: ProviderContext = {}): Promise<{providerJobId: string}> {
      const resolution = input.parameters.resolution ?? '720p';
      if (Object.keys(input.parameters).some(key => key !== 'resolution') ||
          !['360p', '720p', '1080p', '4k'].includes(String(resolution)) ||
          !Number.isInteger(input.duration) || input.duration < 3 || input.duration > 15 || !['16:9', '9:16'].includes(input.aspectRatio))
        throw providerError('UNSUPPORTED_PARAMETER', 'Choose an advertised Gemini video format.');
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 1000)
        throw providerError('INVALID_PROMPT', 'A Gemini video prompt is required.');
      if (input.subjectReference || input.images.length > 1 || input.audios?.length || input.images.some(image => image.role !== 'first_frame' || !['image/jpeg', 'image/png'].includes(image.mimeType)))
        throw providerError('UNSUPPORTED_INPUT_ROLE', 'Gemini Omni currently accepts text or one first frame.');
      const image = input.images[0];
      if (image) base64(image.base64, INPUT_IMAGE_BYTES);
      const payload = {model, input: [...(image ? [{type: 'image', data: image.base64, mime_type: image.mimeType}] : []), {type: 'text', text: input.prompt}],
        response_format: {type: 'video', delivery: 'uri', duration: input.duration + 's', resolution, aspect_ratio: input.aspectRatio},
        generation_config: {video_config: {task: image ? 'image_to_video' : 'text_to_video'}},
        background: true, store: true, stream: false};
      const response = object(await request('/interactions', 'POST', context, payload, true));
      try {
        taskId(response?.id);
        if (!response || response.model !== undefined && response.model !== model ||
            response.object !== undefined && response.object !== 'interaction' ||
            !['in_progress', 'completed', 'failed', 'cancelled', 'incomplete'].includes(String(response.status))) throw invalid();
      } catch {throw providerError('SUBMISSION_UNKNOWN', 'Gemini did not return a valid interaction receipt. Query the existing task before generating again.', {uncertain: true});}
      return {providerJobId: response.id as string};
    },
    async retrieve(id: string, context: ProviderContext = {}): Promise<ConfiguredVideoTask> {
      const result = await existing(id, context);
      if (result.video?.uri) {
        try {
          const file = await fileState(result.video.uri, context);
          if (!file.active) return {id, status: 'running', progress: 0};
        } catch (error) {
          const detail = getOmniFailure(error);
          if (object(error)?.code === 'PROVIDER_GENERATION_FAILED' && detail)
            return rememberOmniTaskFailure({id, status: 'failed' as const}, detail);
          throw error;
        }
      }
      return result.task;
    },
    async download(id: string, destination: string, context: ProviderContext = {}): Promise<OutputDownload> {
      const result = await existing(id, context);
      if (result.task.status !== 'succeeded' || !result.video) throw providerError('PROVIDER_NOT_READY', 'The Gemini video is still being prepared.', {retryable: true});
      if (result.video.data !== undefined) {
        const bytes = base64(result.video.data, OUTPUT_BYTES);
        const local = new URL(API + '/interactions/' + id + '/managed-inline-output');
        // This private fetch closure consumes the already received bytes. The
        // synthetic route is never dispatched over the network.
        let credentialFailure: unknown;
        try {
          return await downloadMp4({root, destination, url: local, context, fetchImpl: async (url, init) => {
            if (String(url) !== local.href || init?.method !== 'GET') throw invalid();
            try {await acquireCredential(context); checkpoint(context.signal);}
            catch (error) {credentialFailure = error; throw error;}
            return new Response(new Uint8Array(bytes), {headers: {'content-type': 'video/mp4', 'content-length': String(bytes.length)}});
          }});
        } catch (error) {
          if (credentialFailure !== undefined) throw credentialFailure;
          throw error;
        }
      }
      const file = await fileState(result.video.uri!, context);
      if (!file.active) throw providerError('PROVIDER_NOT_READY', 'The Gemini video is still being prepared.', {retryable: true});
      let initial = true, credentialFailure: unknown;
      try {
        return await downloadMp4({root, destination, url: file.url, context,
          headers: {'x-goog-api-key': 'bound-at-dispatch'},
          fetchImpl: async (url, init) => {
            let secret: string;
            try {secret = await acquireCredential(context); checkpoint(context.signal);} catch (error) {credentialFailure = error; throw error;}
            const headers = new Headers(init?.headers);
            if (initial) {
              initial = false;
              if (String(url) !== file.url.href) throw invalid();
              headers.set('x-goog-api-key', secret);
            } else headers.delete('x-goog-api-key');
            const response = await fetchImpl(url, {...init, headers});
            if (!response.ok && ![301, 302, 303, 307, 308].includes(response.status)) {
              let payload: unknown;
              try {payload = await readJson(response, 64 * 1024, context.signal);} catch { /* Preserve the HTTP classification. */ }
              credentialFailure = providerHttpError({status: response.status, method: 'GET',
                message: 'Gemini rejected the download request.', detail: omniFailure(payload)});
              throw credentialFailure;
            }
            return response;
          },
          allowRedirect(location, current) {
            if (!location) throw providerError('INVALID_OUTPUT_URL', 'Gemini returned an empty download redirect.');
            let next: URL;
            try {next = new URL(location, current);} catch {throw providerError('INVALID_OUTPUT_URL', 'Gemini returned an invalid download redirect.');}
            return outputUrl(next.href, hosts);
          }});
      } catch (error) {
        if (credentialFailure !== undefined) throw credentialFailure;
        throw error;
      }
    },
  };
}
