import {invokeAgentSubmissionFence} from './submission-fence.ts';
import {AGENT_PROTOCOLS, deriveAgentEndpoint} from '@mioon/contracts';
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpsRequestDefault, type RequestOptions as HttpsRequestOptions} from 'node:https';
import {request as httpRequestDefault, type ClientRequest, type IncomingMessage, type ClientRequestArgs, type RequestOptions as HttpRequestOptions} from 'node:http';
import {checkServerIdentity, type TLSSocket} from 'node:tls';
import {parseAgentConfiguration} from './config.ts';
import type {AgentConfiguration} from './config.ts';
import {AGENT_HTTP_DIAGNOSTIC_MAX_BYTES, agentChatError, agentChatHttpError, errorCode} from './chat-errors.ts';
import type {AgentChatFailure} from './chat-errors.ts';
import {ANTHROPIC_MESSAGES_API_VERSION} from './anthropic-protocol.ts';

export const AGENT_NETWORK_LIMITS = Object.freeze({connectTimeoutMs: 10000, readTimeoutMs: 20000, totalTimeoutMs: 120000, maxHeaderBytes: 16384, maxDnsAnswers: 64});
type NetworkLimits = Record<'connectTimeoutMs' | 'readTimeoutMs' | 'totalTimeoutMs' | 'maxHeaderBytes' | 'maxDnsAnswers', number>;
type NodeLookup = NonNullable<ClientRequestArgs['lookup']>;
export interface AgentTransportDependencies {
  lookup?: typeof dnsLookup;
  httpsRequest?: typeof httpsRequestDefault;
  httpRequest?: typeof httpRequestDefault;
  limits?: Record<string, number>;
}
export interface AgentDestination {
  hostname: string;
  address: string;
  family: number;
  port: number;
  secure: boolean;
  path: string;
  local: boolean;
}
export interface AgentTransportStream {body: AsyncIterable<Uint8Array>; close(): void; error(): AgentChatFailure | null}
export interface AgentTransportRequest {
  configuration: unknown;
  apiKey?: string | null;
  body: string;
  signal?: AbortSignal;
  selfPort?: number;
  beforeSubmit?: unknown;
}
export type AgentTransport = (options: AgentTransportRequest) => Promise<AgentTransportStream>;
const preventedSubmissions=new WeakSet<object>();
/** Only this transport's local send phase can certify absence of HTTP dispatch.
 * Codes and externally supplied properties are never evidence. */
export const wasAgentTransportSubmissionPrevented=(error:unknown):boolean=>error!==null&&typeof error==='object'&&preventedSubmissions.has(error);
function denied(): never { throw agentChatError('AGENT_CHAT_NETWORK_DENIED'); }
const bareHost = (host: string): string => host.startsWith('[') ? host.slice(1, -1) : host;
function ipv6Words(address: string): number[] | null {
  if (isIP(address) !== 6 || address.includes('%')) return null;
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const end = value.lastIndexOf(':');
    const octets = value.slice(end + 1).split('.').map(Number);
    value = `${value.slice(0, end)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return words.map(word => parseInt(word, 16));
}
export function isPublicAgentAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  const family = isIP(address);
  if (family === 4) {
    // Azure's host-platform/WireServer VIP is public-looking but not an API endpoint.
    if (address === '168.63.129.16') return false;
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  const words = ipv6Words(address);
  // Only global unicast. Exclude special-use, Teredo, 6to4, documentation,
  // NAT64, IPv4-compatible/mapped, link-local and unique-local addresses.
  return !!words && words[0] >= 0x2000 && words[0] <= 0x3fff &&
    !(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) && words[0] !== 0x2002 && words[0] !== 0x3fff;
}
function canonicalAddress(address: unknown): string | null {
  const text = typeof address === 'string' ? address : '';
  if (isIP(text) === 4) return text;
  const words = ipv6Words(text);
  if (!words) return null;
  // Some operating systems expose an IPv4 peer in mapped form. Only accept it
  // when it is precisely the independently validated, pinned IPv4 address.
  if (words.slice(0, 5).every(n => n === 0) && words[5] === 0xffff) return `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  return words.map(n => n.toString(16)).join(':');
}
interface AgentSocket {remoteAddress?: string; remotePort?: number; authorized?: boolean}
export function assertPinnedAgentSocket(socket: AgentSocket | undefined, destination: AgentDestination): void {
  if (canonicalAddress(socket?.remoteAddress) !== canonicalAddress(destination.address) || socket?.remotePort !== destination.port) denied();
  if (destination.secure && socket?.authorized !== true) throw agentChatError('AGENT_CHAT_CONNECT_FAILED');
}
function abortError(signal: AbortSignal | undefined): AgentChatFailure {
  return (signal?.reason as {code?: string} | undefined)?.code === 'AGENT_CHAT_TIMEOUT' ? agentChatError('AGENT_CHAT_TIMEOUT') : agentChatError('AGENT_CHAT_ABORTED');
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal?.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}
export async function resolveAgentDestination(configuration: unknown, {selfPort, lookup = dnsLookup, signal, maxDnsAnswers = AGENT_NETWORK_LIMITS.maxDnsAnswers}: {selfPort?: number; lookup?: typeof dnsLookup; signal?: AbortSignal; maxDnsAnswers?: number} = {}): Promise<AgentDestination> {
  let config: AgentConfiguration;
  try { config = parseAgentConfiguration(configuration, {selfPort}); } catch { return denied(); }
  const url = new URL(deriveAgentEndpoint(config));
  const hostname = bareHost(url.hostname), port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (signal?.aborted) throw abortError(signal);
  if (config.presetId === 'ollama') {
    if (typeof selfPort !== 'number' || !Number.isInteger(selfPort) || selfPort < 1 || selfPort > 65535 || port === selfPort) denied();
    // localhost means this exact loopback destination, never a host-file/DNS alias.
    const address = hostname === 'localhost' ? '127.0.0.1' : hostname;
    const prefix = config.protocol === 'anthropic_messages' ? '' : '/v1';
    if (!['127.0.0.1', '::1'].includes(address) || url.pathname !== `${prefix}${AGENT_PROTOCOLS[config.protocol].path}`) denied();
    return {hostname, address, family: isIP(address), port, secure: url.protocol === 'https:', path: url.pathname, local: true};
  }
  let addresses: Array<{address: string; family: number}>;
  if (isIP(hostname)) addresses = [{address: hostname, family: isIP(hostname)}];
  else {
    try { addresses = await abortable(lookup(hostname, {all: true, verbatim: true}), signal); }
    catch { if (signal?.aborted) throw abortError(signal); throw agentChatError('AGENT_CHAT_CONNECT_FAILED'); }
  }
  if (signal?.aborted) throw abortError(signal);
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > maxDnsAnswers) denied();
  for (const item of addresses) if (!item || ![4, 6].includes(item.family) || isIP(item.address) !== item.family || !isPublicAgentAddress(item.address)) denied();
  const {address, family} = addresses[0];
  return {hostname, address, family, port, secure: true, path: url.pathname, local: false};
}
function limitsFor(overrides: Record<string, number> = {}): NetworkLimits {
  const result: NetworkLimits = {...AGENT_NETWORK_LIMITS};
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(result, key) || !Number.isInteger(value) || value < 1 || value > result[key as keyof NetworkLimits]) throw agentChatError('AGENT_CHAT_VALIDATION');
    result[key as keyof NetworkLimits] = value;
  }
  return result;
}
/** Retain at most the diagnostic limit; incomplete/failed streams have no hints.
 * The caller owns cancellation and all existing network deadlines. */
async function readHttp400Diagnostic(incoming: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of incoming) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > AGENT_HTTP_DIAGNOSTIC_MAX_BYTES - size) return undefined;
      size += chunk.byteLength;
      chunks.push(Buffer.from(chunk));
    }
    return size ? Buffer.concat(chunks, size) : undefined;
  } catch { return undefined; }
}
/** Dependency injection is a trusted-code construction boundary, not an HTTP
 * option. Production uses Node HTTPS directly: no fetch, proxy, redirects,
 * cookie jar, global pooled agent, arbitrary header input or second lookup. */
export function createAgentTransport({lookup = dnsLookup, httpsRequest = httpsRequestDefault, httpRequest = httpRequestDefault, limits: overrides}: AgentTransportDependencies = {}): AgentTransport {
  const limits = limitsFor(overrides);
  return async function openAgentStream({configuration, apiKey, body, signal, selfPort, beforeSubmit}: AgentTransportRequest): Promise<AgentTransportStream> {
    const controller = new AbortController();
    let request: ClientRequest | undefined, response: IncomingMessage | undefined, failed: AgentChatFailure | null = null, rejectPending: ((reason: AgentChatFailure) => void) | undefined, closed = false, mayHaveSent = false, readingHttp400 = false;
    function fail(code: string, httpStatus?: number, diagnosticBody?: Uint8Array): void {
      if (closed || failed) return;
      failed = code === 'AGENT_CHAT_HTTP_ERROR' ? agentChatHttpError(httpStatus, diagnosticBody) : agentChatError(code);
      controller.abort(failed);
      request?.destroy(); response?.destroy();
      rejectPending?.(failed);
    }
    const externalAbort = () => fail('AGENT_CHAT_ABORTED');
    signal?.addEventListener('abort', externalAbort, {once: true});
    if (signal?.aborted) externalAbort();
    const totalTimer = setTimeout(() => fail('AGENT_CHAT_TIMEOUT'), limits.totalTimeoutMs);
    const connectTimer = setTimeout(() => fail('AGENT_CHAT_TIMEOUT'), limits.connectTimeoutMs);
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(totalTimer); clearTimeout(connectTimer);
      signal?.removeEventListener('abort', externalAbort);
      request?.destroy(); response?.destroy();
    };
    try {
      invokeAgentSubmissionFence(beforeSubmit);
      let config: AgentConfiguration;
      try { config = parseAgentConfiguration(configuration, {selfPort}); } catch { return denied(); }
      const destination = await resolveAgentDestination(config, {selfPort, lookup, signal: controller.signal, maxDnsAnswers: limits.maxDnsAnswers});
      if (failed || controller.signal.aborted) throw failed || abortError(controller.signal);
      invokeAgentSubmissionFence(beforeSubmit);
      const headers: Record<string, string> = {'Content-Type': 'application/json', Accept: 'text/event-stream', 'Accept-Encoding': 'identity', 'Content-Length': String(Buffer.byteLength(body)), Connection: 'close'};
      // apiKey must be acquired by the host for this exact configuration binding.
      // Local Ollama needs no key by default, but an explicitly bound local key
      // is honored rather than silently changing an authenticated configuration.
      if (config.protocol === 'anthropic_messages') {
        if (apiKey) headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = ANTHROPIC_MESSAGES_API_VERSION;
      } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const pinnedLookup: NodeLookup = (_hostname, lookupOptions, callback) => {
        let options: unknown = lookupOptions;
        let done = callback;
        if (typeof options === 'function') { done = options as typeof callback; options = {}; }
        if (controller.signal.aborted) return done(abortError(controller.signal), '');
        if ((options as {all?: boolean}).all) done(null, [{address: destination.address, family: destination.family}]);
        else done(null, destination.address, destination.family);
      };
      const requestOptions = {
        protocol: destination.secure ? 'https:' : 'http:', hostname: destination.hostname, port: destination.port,
        path: destination.path, method: 'POST', headers, agent: false, family: destination.family,
        autoSelectFamily: false, maxHeaderSize: limits.maxHeaderBytes, lookup: pinnedLookup,
        ...(destination.secure ? {rejectUnauthorized: true, servername: isIP(destination.hostname) ? '' : destination.hostname, checkServerIdentity: (_host: string, certificate: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(destination.hostname, certificate)} : {}),
      };
      const requestFn = (destination.secure ? httpsRequest : httpRequest) as (options: HttpRequestOptions | HttpsRequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        rejectPending = reject;
        request = requestFn(requestOptions as HttpsRequestOptions, incoming => {
          if (failed) { incoming.destroy(); return; }
          if (incoming.statusCode === 400) {
            readingHttp400 = true;
            // Track the response before awaiting bytes so abort/timeout destroys
            // it and settles the pending open, even if the body never completes.
            response = incoming;
            void readHttp400Diagnostic(incoming).then(bytes => fail('AGENT_CHAT_HTTP_ERROR', 400, bytes), () => fail('AGENT_CHAT_HTTP_ERROR', 400));
            return;
          }
          if (incoming.statusCode !== 200) { fail('AGENT_CHAT_HTTP_ERROR', incoming.statusCode); return; }
          const contentType = incoming.headers['content-type'];
          const encoding = incoming.headers['content-encoding'];
          if (typeof contentType !== 'string' || !/^text\/event-stream(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(contentType) || (encoding && encoding !== 'identity')) { fail('AGENT_CHAT_PROTOCOL_ERROR'); return; }
          incoming.on('error', () => { if (!closed && !failed) failed = agentChatError('AGENT_CHAT_TRUNCATED'); });
          resolve(incoming);
        });
        request.on('error', () => readingHttp400 ? fail('AGENT_CHAT_HTTP_ERROR', 400) : fail('AGENT_CHAT_CONNECT_FAILED'));
        request.on('upgrade', (_res, socket) => { socket.destroy(); fail('AGENT_CHAT_PROTOCOL_ERROR'); });
        request.setTimeout(limits.readTimeoutMs, () => fail('AGENT_CHAT_TIMEOUT'));
        request.once('socket', socket => {
          (socket as TLSSocket).once(destination.secure ? 'secureConnect' : 'connect', () => {
            if (failed || controller.signal.aborted || closed) { socket.destroy(); return; }
            try { assertPinnedAgentSocket(socket, destination); invokeAgentSubmissionFence(beforeSubmit); }
            catch (error) { fail(errorCode(error) || 'AGENT_CHAT_CONNECT_FAILED'); return; }
            clearTimeout(connectTimer);
            // Wait until the pinned peer and, for HTTPS, authenticated TLS are
            // verified before transmitting any headers, key or request content.
            // end() can partially send and then throw; retire the no-send proof
            // before entering it, regardless of any resulting error's code.
            mayHaveSent = true;
            try { request?.end(body); } catch { fail('AGENT_CHAT_CONNECT_FAILED'); }
          });
        });
      });
      const resolved = response;
      return {body: resolved, close, error: () => failed};
    } catch (error) {
      close();
      const failure = failed || agentChatError(errorCode(error) || 'AGENT_CHAT_CONNECT_FAILED');
      if (!mayHaveSent) preventedSubmissions.add(failure);
      throw failure;
    }
  };
}
