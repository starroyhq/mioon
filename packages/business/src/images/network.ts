import {isIP} from 'node:net';
import {getCustomImageDestination} from '../../../contracts/src/image-settings.ts';
import {checkServerIdentity} from 'node:tls';
import {isPublicAgentAddress, assertPinnedAgentSocket} from '../agent/network-policy.ts';
import type {ClientRequest, IncomingMessage} from 'node:http';
import type {RequestOptions} from 'node:https';
import {IMAGE_EDIT_ENDPOINT, IMAGE_EDIT_NETWORK_LIMITS, IMAGE_GENERATION_ENDPOINT, IMAGE_NETWORK_LIMITS, imageAdapterError} from './profiles.ts';
import type {ImageAdapterError} from './profiles.ts';

export type ImageNetworkLimits = {-readonly [K in keyof typeof IMAGE_NETWORK_LIMITS]: number};
export interface ImageDestination {hostname: string; port: 443; secure: true; address: string; family: number; path: string}
export interface ImageLookupOptions {lookup?: unknown; signal?: AbortSignal; maxDnsAnswers?: number}
export interface ImageTransportOptions {lookup?: unknown; httpsRequest?: unknown; apiKey?: unknown; limits?: Readonly<Record<string, unknown>>}
export interface ImageTransportRequest {body?: unknown; contentType?: unknown; signal?: AbortSignal; beforeDispatch?: unknown}
export interface ImageTransportResponse {body: Buffer; providerRequestId: string | null; dispatched: boolean}

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
const codeOf = (error: unknown): string | undefined => {const value = object(error); return value && typeof value.code === 'string' ? value.code : undefined;};
function limitsFor(overrides: Readonly<Record<string, unknown>> = {}, profileLimits: ImageNetworkLimits = IMAGE_NETWORK_LIMITS): ImageNetworkLimits {
  const limits: ImageNetworkLimits = {...profileLimits};
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, name) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > limits[name as keyof ImageNetworkLimits]) throw imageAdapterError('IMAGE_INVALID_REQUEST');
    limits[name as keyof ImageNetworkLimits] = value;
  }
  return limits;
}
function raceAbort<T>(promise: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function validAnswer(item: unknown): {address: string; family: 4 | 6} | null {
  const value = object(item);
  if (!value || (value.family !== 4 && value.family !== 6)) return null;
  if (typeof value.address !== 'string' || isIP(value.address) !== value.family || !isPublicAgentAddress(value.address)) return null;
  return {address: value.address, family: value.family};
}
async function resolveDestination(endpoint: string, {lookup, signal, maxDnsAnswers = IMAGE_NETWORK_LIMITS.maxDnsAnswers}: ImageLookupOptions = {}): Promise<ImageDestination> {
  if (typeof lookup !== 'function') throw imageAdapterError('IMAGE_LIVE_DISABLED');
  if (typeof maxDnsAnswers !== 'number' || !Number.isInteger(maxDnsAnswers) || maxDnsAnswers < 1 || maxDnsAnswers > IMAGE_NETWORK_LIMITS.maxDnsAnswers) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  if (signal?.aborted) throw imageAdapterError('IMAGE_CANCELLED');
  const url = new URL(endpoint);
  let answers: unknown;
  try {
    const query: unknown = (lookup as (hostname: string, options: {all: boolean; verbatim: boolean}) => unknown)(url.hostname, {all: true, verbatim: true});
    answers = await (signal ? raceAbort(query, signal) : query);
  } catch { throw imageAdapterError(signal?.aborted ? 'IMAGE_CANCELLED' : 'IMAGE_CONNECTION_FAILED'); }
  if (signal?.aborted) throw imageAdapterError('IMAGE_CANCELLED');
  if (!Array.isArray(answers) || !answers.length || answers.length > maxDnsAnswers || answers.some(item => !validAnswer(item))) throw imageAdapterError('IMAGE_NETWORK_DENIED');
  const first = validAnswer(answers[0])!;
  return {hostname: url.hostname, port: 443, secure: true, address: first.address, family: first.family, path: url.pathname};
}
function compatibleEndpoint(baseUrl: unknown): string {
  try { return getCustomImageDestination(baseUrl as string); }
  catch { throw imageAdapterError('IMAGE_INVALID_REQUEST'); }
}
export function resolveImageDestination(options: ImageLookupOptions = {}): Promise<ImageDestination> { return resolveDestination(IMAGE_GENERATION_ENDPOINT, options); }
export function resolveImageEditDestination(options: ImageLookupOptions = {}): Promise<ImageDestination> { return resolveDestination(IMAGE_EDIT_ENDPOINT, options); }
export async function resolveCompatibleImageDestination({baseUrl, ...options}: ImageLookupOptions & {baseUrl?: unknown} = {}): Promise<ImageDestination> {
  return resolveDestination(compatibleEndpoint(baseUrl), options);
}
/** Dependencies are explicit: no ambient fetch, SDK or credential discovery.
 * The dedicated reviewed Images gateway supplies the platform DNS/HTTPS pair;
 * synthetic tests supply inert dependencies and a fake sentinel.
 * No retries, redirects, proxy/environment handling or pooled agents. Endpoint
 * selection happens only in the explicit trusted factories below. */
function createImageTransport(endpoint: string, {lookup, httpsRequest, apiKey, limits: overrides}: ImageTransportOptions = {}, profileLimits: ImageNetworkLimits = IMAGE_NETWORK_LIMITS, multipart = false) {
  if (typeof lookup !== 'function' || typeof httpsRequest !== 'function') throw imageAdapterError('IMAGE_LIVE_DISABLED');
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  const limits = limitsFor(overrides, profileLimits);
  const requestHttps = httpsRequest as (options: RequestOptions & {autoSelectFamily: boolean}, callback: (incoming: IncomingMessage) => void) => ClientRequest;
  return async function postImage({body, contentType = 'application/json', signal, beforeDispatch}: ImageTransportRequest = {}): Promise<ImageTransportResponse> {
    if (typeof contentType !== 'string' || (typeof body !== 'string' && !Buffer.isBuffer(body))) throw imageAdapterError('IMAGE_INVALID_REQUEST');
    if (multipart ? !Buffer.isBuffer(body) || !/^multipart\/form-data; boundary=[A-Za-z0-9-]{1,100}$/.test(contentType) : typeof body !== 'string' || contentType !== 'application/json') throw imageAdapterError('IMAGE_INVALID_REQUEST');
    if (!body.length || Buffer.byteLength(body) > limits.maxRequestBytes || typeof beforeDispatch !== 'function') throw imageAdapterError('IMAGE_INVALID_REQUEST');
    // Copy caller buffers before DNS/TLS waits so a reviewed upload cannot be
    // changed after the SDK's form/hash checks but before the durable fence.
    const payload = Buffer.isBuffer(body) ? Buffer.from(body) : body, key = apiKey;
    if (signal?.aborted) throw imageAdapterError('IMAGE_CANCELLED');
    let request: ClientRequest | undefined, response: IncomingMessage | undefined, rejectPending: ((reason?: unknown) => void) | undefined;
    let failed: ImageAdapterError | undefined, closed = false, dispatched = false, received = false;
    const controller = new AbortController();
    const fail = (code: string): void => {
      if (closed || failed) return;
      failed = imageAdapterError(code, {dispatched});
      controller.abort(failed); request?.destroy(); response?.destroy(); rejectPending?.(failed);
    };
    const externalAbort = (): void => fail('IMAGE_CANCELLED');
    signal?.addEventListener('abort', externalAbort, {once: true});
    if (signal?.aborted) externalAbort();
    const totalTimer = setTimeout(() => fail('IMAGE_TIMEOUT'), limits.totalTimeoutMs);
    const connectTimer = setTimeout(() => fail('IMAGE_TIMEOUT'), limits.connectTimeoutMs);
    const close = (): void => {
      if (closed) return; closed = true;
      clearTimeout(totalTimer); clearTimeout(connectTimer);
      signal?.removeEventListener('abort', externalAbort);
      request?.destroy(); response?.destroy();
    };
    try {
      const destination = await resolveDestination(endpoint, {lookup, signal: controller.signal, maxDnsAnswers: limits.maxDnsAnswers});
      if (failed) throw failed;
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        rejectPending = reject;
        const options: RequestOptions & {autoSelectFamily: boolean} = {protocol: 'https:', hostname: destination.hostname, port: 443, path: destination.path, method: 'POST', agent: false, family: destination.family, autoSelectFamily: false, maxHeaderSize: limits.maxHeaderBytes,
          headers: {'Content-Type': contentType, Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Length': String(Buffer.byteLength(payload)), Connection: 'close', Authorization: `Bearer ${key}`},
          rejectUnauthorized: true, servername: destination.hostname, checkServerIdentity: (_host, certificate) => checkServerIdentity(destination.hostname, certificate),
          lookup: (_host, lookupOptions, callback) => {
            const done = (typeof lookupOptions === 'function' ? lookupOptions : callback) as (...args: unknown[]) => void;
            if (controller.signal.aborted) return done(failed || imageAdapterError('IMAGE_CANCELLED', {dispatched}));
            const all = object(lookupOptions)?.all === true;
            done(null, ...(all ? [[{address: destination.address, family: destination.family}]] : [destination.address, destination.family]));
          },
        };
        request = requestHttps(options, incoming => {
          if (failed || closed || !dispatched || received) { incoming.destroy(); if (!failed && !closed) fail('IMAGE_RESPONSE_INVALID'); return; }
          received = true; response = incoming;
          if (incoming.statusCode !== 200) { fail('IMAGE_HTTP_ERROR'); return; }
          const headers = incoming.headers || {}, type = headers['content-type'], encoding = headers['content-encoding'], length = headers['content-length'];
          if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(type) || (encoding !== undefined && encoding !== 'identity')) { fail('IMAGE_RESPONSE_INVALID'); return; }
          if (length !== undefined && (typeof length !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(length) || Number(length) > limits.maxResponseBytes)) { fail('IMAGE_RESPONSE_TOO_LARGE'); return; }
          incoming.on('error', () => fail('IMAGE_CONNECTION_FAILED'));
          resolve(incoming);
        });
        request.on('error', () => fail('IMAGE_CONNECTION_FAILED'));
        request.on('upgrade', (_incoming, socket) => { socket.destroy(); fail('IMAGE_RESPONSE_INVALID'); });
        request.once('socket', socket => {
          socket.once('secureConnect', () => {
            if (failed || closed || dispatched || controller.signal.aborted) { socket.destroy(); return; }
            try { assertPinnedAgentSocket(socket, {...destination, local: false}); }
            catch { fail('IMAGE_NETWORK_DENIED'); return; }
            clearTimeout(connectTimer);
            try {
              const result = (beforeDispatch as () => unknown)();
              // The host fence is synchronous and durable; never race an async write.
              if (result && typeof (result as {then?: unknown}).then === 'function') { Promise.resolve(result).catch(() => {}); fail('IMAGE_DISPATCH_BLOCKED'); return; }
            } catch { fail('IMAGE_DISPATCH_BLOCKED'); return; }
            if (failed || closed || controller.signal.aborted) return;
            dispatched = true;
            // First possible credential/header/body transmission. Never retry end().
            try { request?.end(payload); } catch { fail('IMAGE_CONNECTION_FAILED'); }
          });
        });
      });
      rejectPending = undefined;
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of response) {
        if (failed) throw failed;
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw imageAdapterError('IMAGE_RESPONSE_INVALID', {dispatched});
        length += chunk.byteLength;
        if (length > limits.maxResponseBytes) throw imageAdapterError('IMAGE_RESPONSE_TOO_LARGE', {dispatched});
        chunks.push(Buffer.from(chunk));
      }
      if (failed) throw failed;
      const declaredLength = response.headers['content-length'];
      if (!length || response.complete !== true || (declaredLength !== undefined && Number(declaredLength) !== length)) throw imageAdapterError('IMAGE_RESPONSE_INVALID', {dispatched});
      const requestId = response.headers['x-request-id'];
      const providerRequestId = typeof requestId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(requestId) ? requestId : null;
      return {body: Buffer.concat(chunks, length), providerRequestId, dispatched: true};
    } catch (error) {
      if (failed) throw failed;
      throw imageAdapterError(codeOf(error), {dispatched});
    } finally { close(); }
  };
}

// The official factory cannot be redirected by supplied URL/profile properties.
export function createImageJsonTransport(options: ImageTransportOptions = {}) { return createImageTransport(IMAGE_GENERATION_ENDPOINT, options); }
export function createImageEditTransport(options: ImageTransportOptions = {}) { return createImageTransport(IMAGE_EDIT_ENDPOINT, options, IMAGE_EDIT_NETWORK_LIMITS, true); }
export function createCompatibleImageJsonTransport({baseUrl, ...options}: ImageTransportOptions & {baseUrl?: unknown} = {}) {
  return createImageTransport(compatibleEndpoint(baseUrl), options);
}
