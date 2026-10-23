import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpsRequestDefault} from 'node:https';
import {isIP} from 'node:net';
import {Readable} from 'node:stream';
import {checkServerIdentity} from 'node:tls';
import type {ClientRequest, ClientRequestArgs, IncomingMessage} from 'node:http';
import type {RequestOptions} from 'node:https';
import type {TLSSocket} from 'node:tls';
import {assertPinnedAgentSocket, isPublicAgentAddress} from '../agent/network-policy.ts';

/** A compatible video service names its own host, so every request to it (and to
 * any CDN its /content route redirects to) goes through this pinned transport:
 * public DNS answers only, the socket pinned to the checked address, TLS verified
 * for the original host name, and nothing written before the pinned peer is
 * confirmed. No proxy, environment, pooled agent, cookie jar or automatic redirect. */
export const VIDEO_NETWORK_LIMITS = Object.freeze({connectTimeoutMs: 10_000, maxHeaderBytes: 16_384, maxDnsAnswers: 64, maxRequestBytes: 16 * 1024 * 1024});
type Lookup = (hostname: string, options: {all: true; verbatim: true}) => unknown;
type NodeLookup = NonNullable<ClientRequestArgs['lookup']>;
export interface PinnedVideoFetchDependencies {lookup?: Lookup; httpsRequest?: typeof httpsRequestDefault}
export interface VideoNetworkFailure extends Error {code: string; notDispatched?: true}

/** `notDispatched` proves no header, credential or body byte left this process,
 * so a failed POST is definitely unsubmitted. Every other failure is ambiguous. */
const failure = (code: string, message: string, dispatched: boolean): VideoNetworkFailure =>
  Object.assign(new Error(message), {code, ...(dispatched ? {} : {notDispatched: true as const})});
export const isUndispatchedVideoNetworkFailure = (error: unknown): boolean =>
  error !== null && typeof error === 'object' && (error as {notDispatched?: unknown}).notDispatched === true;

function validAnswer(item: unknown): {address: string; family: 4 | 6} | null {
  if (item === null || typeof item !== 'object') return null;
  const {address, family} = item as {address?: unknown; family?: unknown};
  if ((family !== 4 && family !== 6) || typeof address !== 'string' || isIP(address) !== family || !isPublicAgentAddress(address)) return null;
  return {address, family};
}
function requestBody(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw failure('VIDEO_NETWORK_INVALID', 'Unsupported request body.', false);
}
function responseHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, String(value));
  }
  return headers;
}

export function createPinnedVideoFetch({lookup = dnsLookup as unknown as Lookup, httpsRequest = httpsRequestDefault}: PinnedVideoFetchDependencies = {}): typeof fetch {
  const requestHttps = httpsRequest as (options: RequestOptions & {autoSelectFamily: boolean}, callback: (incoming: IncomingMessage) => void) => ClientRequest;
  return (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    if (typeof input !== 'string' && !(input instanceof URL)) throw failure('VIDEO_NETWORK_INVALID', 'Only explicit URLs are accepted.', false);
    let url: URL;
    try { url = new URL(String(input)); } catch { throw failure('VIDEO_NETWORK_INVALID', 'The request URL is invalid.', false); }
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hostname || isIP(hostname.replace(/^\[|\]$/g, ''))) throw failure('VIDEO_NETWORK_DENIED', 'Only https host names are contacted.', false);
    const method = String(init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw failure('VIDEO_NETWORK_INVALID', 'Unsupported request method.', false);
    const body = requestBody(init.body);
    if (body && body.length > VIDEO_NETWORK_LIMITS.maxRequestBytes) throw failure('VIDEO_NETWORK_INVALID', 'The request body is too large.', false);
    const signal = init.signal ?? undefined;
    const aborted = (dispatched: boolean) => failure('VIDEO_NETWORK_ABORTED', 'The request was cancelled.', dispatched);
    if (signal?.aborted) throw aborted(false);

    let answers: unknown;
    try {
      const query = Promise.resolve(lookup(hostname, {all: true, verbatim: true}));
      answers = await (signal ? new Promise<unknown>((resolve, reject) => {
        const abort = () => reject(aborted(false));
        signal.addEventListener('abort', abort, {once: true});
        query.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      }) : query);
    } catch (error) {
      if (signal?.aborted) throw aborted(false);
      throw isUndispatchedVideoNetworkFailure(error) ? error : failure('VIDEO_NETWORK_UNREACHABLE', 'The service host could not be resolved.', false);
    }
    if (signal?.aborted) throw aborted(false);
    if (!Array.isArray(answers) || !answers.length || answers.length > VIDEO_NETWORK_LIMITS.maxDnsAnswers || answers.some(item => !validAnswer(item))) {
      throw failure('VIDEO_NETWORK_DENIED', 'The service host resolves to an address Mioon will not contact.', false);
    }
    const destination = validAnswer(answers[0])!;

    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    headers['accept-encoding'] = 'identity';
    headers.connection = 'close';
    if (body) headers['content-length'] = String(body.length);
    else delete headers['content-length'];

    return new Promise<Response>((resolve, reject) => {
      let request: ClientRequest | undefined, incomingResponse: IncomingMessage | undefined, dispatched = false, settled = false;
      const connectTimer = setTimeout(() => fail(failure('VIDEO_NETWORK_TIMEOUT', 'The service did not accept a connection in time.', dispatched)), VIDEO_NETWORK_LIMITS.connectTimeoutMs);
      const onAbort = () => { if (!settled) fail(aborted(dispatched)); else incomingResponse?.destroy(aborted(true)); };
      signal?.addEventListener('abort', onAbort, {once: true});
      function fail(error: VideoNetworkFailure): void {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        signal?.removeEventListener('abort', onAbort);
        request?.destroy();
        incomingResponse?.destroy();
        reject(error);
      }
      const pinnedLookup: NodeLookup = (_host, options, callback) => {
        let done = callback as (...args: unknown[]) => void;
        let all = false;
        if (typeof options === 'function') done = options as (...args: unknown[]) => void;
        else all = (options as {all?: boolean} | undefined)?.all === true;
        if (settled) return done(aborted(false), '');
        if (all) done(null, [{address: destination.address, family: destination.family}]);
        else done(null, destination.address, destination.family);
      };
      try {
        request = requestHttps({
          protocol: 'https:', hostname, port: 443, path: `${url.pathname}${url.search}`, method, headers, agent: false,
          family: destination.family, autoSelectFamily: false, maxHeaderSize: VIDEO_NETWORK_LIMITS.maxHeaderBytes, lookup: pinnedLookup,
          rejectUnauthorized: true, servername: hostname, checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate),
        }, incoming => {
          if (settled) { incoming.destroy(); return; }
          const status = incoming.statusCode ?? 0;
          if (status < 200 || status > 599 || (status >= 300 && status < 400 && init.redirect !== 'manual')) {
            incoming.destroy();
            fail(failure('VIDEO_NETWORK_RESPONSE', 'The service returned an unexpected response.', true));
            return;
          }
          settled = true;
          clearTimeout(connectTimer);
          incomingResponse = incoming;
          incoming.once('close', () => signal?.removeEventListener('abort', onAbort));
          const empty = [204, 205, 304].includes(status);
          if (empty) incoming.resume();
          resolve(new Response(empty ? null : Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, {status, statusText: incoming.statusMessage ?? '', headers: responseHeaders(incoming)}));
        });
      } catch { fail(failure('VIDEO_NETWORK_INVALID', 'The request could not be prepared.', false)); return; }
      request.on('error', () => fail(failure(dispatched ? 'VIDEO_NETWORK_INTERRUPTED' : 'VIDEO_NETWORK_UNREACHABLE', dispatched ? 'The connection ended before a response.' : 'The service could not be reached.', dispatched)));
      request.on('upgrade', (_incoming, socket) => { socket.destroy(); fail(failure('VIDEO_NETWORK_RESPONSE', 'The service returned an unexpected response.', true)); });
      request.once('socket', socket => {
        (socket as TLSSocket).once('secureConnect', () => {
          if (settled) { socket.destroy(); return; }
          try { assertPinnedAgentSocket(socket as TLSSocket, {hostname, address: destination.address, family: destination.family, port: 443, secure: true, path: url.pathname, local: false}); }
          catch { fail(failure('VIDEO_NETWORK_DENIED', 'The connected peer is not the checked public address.', false)); return; }
          clearTimeout(connectTimer);
          // First possible transmission of headers, the key or the body.
          dispatched = true;
          try { request!.end(body); } catch { fail(failure('VIDEO_NETWORK_INTERRUPTED', 'The connection ended before a response.', true)); }
        });
      });
    });
  }) as typeof fetch;
}
