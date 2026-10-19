import {request as httpRequestDefault} from 'node:http';
import type {ClientRequest, IncomingMessage, RequestOptions} from 'node:http';
import {COMFY_NODE_CLASSES, assertComfyUuid, comfyError, comfyLimits} from './profile.ts';
import type {ComfyNetworkLimits, ComfyNodeClass} from './profile.ts';

export interface ComfyDestination {address: string; family: 4 | 6; port: number}
export interface ComfyRoute {method: 'GET' | 'POST'; path: string; maxBytes: number; allowNotFound?: boolean; png?: boolean}
export interface ComfyDescriptor {filename: string; subfolder: ''; type: 'output'}
export interface ComfyRequestInput {
  baseUrl?: unknown; operation?: unknown; nodeClass?: unknown; promptId?: unknown; descriptor?: unknown;
  filenamePrefix?: unknown; body?: unknown; signal?: AbortSignal; beforeSubmit?: unknown; maxBytes?: unknown;
}
export interface ComfyResponse {body: Buffer; status: number | undefined; dispatched: boolean; byteLength: number}
export interface ComfyTransportOptions {
  httpRequest?: typeof httpRequestDefault; reservedPorts?: unknown; limits?: Readonly<Record<string, unknown>>;
}
export interface ComfySocketLike {remoteAddress?: string | null; remotePort?: number | null}
const codeOf = (error: unknown): string | undefined => typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
// No URL generalization: exact literal loopback, explicit canonical port, no
// userinfo, pathname, encoded spelling, DNS, proxy, cookies or credentials.
export function resolveComfyDestination(baseUrl: unknown, {reservedPorts}: {reservedPorts?: unknown} = {}): ComfyDestination {
  const match = typeof baseUrl === 'string' && /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(baseUrl);
  if (!match || Number(match[2]) > 65535) throw comfyError('COMFY_NETWORK_DENIED');
  const supplied: unknown = typeof reservedPorts === 'function' ? (reservedPorts as () => unknown)() : reservedPorts;
  const ports: unknown = supplied instanceof Set ? [...(supplied as Set<unknown>)] : supplied;
  if (!Array.isArray(ports)) throw comfyError('COMFY_NETWORK_DENIED');
  const values: readonly unknown[] = ports;
  if (!values.length || values.some(port => typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) || values.includes(Number(match[2]))) throw comfyError('COMFY_NETWORK_DENIED');
  return {address: match[1] === '[::1]' ? '::1' : match[1], family: match[1] === '[::1]' ? 6 : 4, port: Number(match[2])};
}
function peerAddress(address: unknown): unknown {
  if (address === '::ffff:127.0.0.1' || address === '::ffff:7f00:1' || address === '0:0:0:0:0:ffff:7f00:1') return '127.0.0.1';
  if (address === '0:0:0:0:0:0:0:1') return '::1';
  return address;
}
export function assertComfySocket(socket: ComfySocketLike | null | undefined, destination: ComfyDestination): void {
  if (peerAddress(socket?.remoteAddress) !== destination.address || socket?.remotePort !== destination.port) throw comfyError('COMFY_NETWORK_DENIED');
}
export function validateComfyDescriptor(descriptor: unknown, filenamePrefix: unknown): ComfyDescriptor {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) || Object.keys(descriptor).sort().join(',') !== 'filename,subfolder,type') throw comfyError('COMFY_OUTPUT_INVALID');
  const value = descriptor as Record<string, unknown>;
  if (value.type !== 'output' || value.subfolder !== '' || typeof value.filename !== 'string' || typeof filenamePrefix !== 'string' || !/^mioon_[0-9a-f-]{36}$/.test(filenamePrefix)) throw comfyError('COMFY_OUTPUT_INVALID');
  assertComfyUuid(filenamePrefix.slice(6));
  const suffix = value.filename.slice(filenamePrefix.length);
  if (!value.filename.startsWith(filenamePrefix) || !/^_[0-9]{5,12}_\.png$/.test(suffix)) throw comfyError('COMFY_OUTPUT_INVALID');
  return {filename: value.filename, subfolder: '', type: 'output'};
}
function routeFor({operation, nodeClass, promptId, descriptor, filenamePrefix}: ComfyRequestInput, limits: Readonly<ComfyNetworkLimits>): ComfyRoute {
  if (operation === 'system') return {method: 'GET', path: '/system_stats', maxBytes: limits.maxStatusBytes};
  if (operation === 'node' && typeof nodeClass === 'string' && (COMFY_NODE_CLASSES as readonly string[]).includes(nodeClass)) return {method: 'GET', path: `/object_info/${nodeClass as ComfyNodeClass}`, maxBytes: limits.maxNodeInfoBytes};
  if (operation === 'submit') return {method: 'POST', path: '/prompt', maxBytes: limits.maxStatusBytes};
  if (operation === 'job') return {method: 'GET', path: `/api/jobs/${assertComfyUuid(promptId)}`, maxBytes: limits.maxStatusBytes, allowNotFound: true};
  if (operation === 'view') {
    const safe = validateComfyDescriptor(descriptor, filenamePrefix);
    return {method: 'GET', path: `/view?filename=${encodeURIComponent(safe.filename)}&subfolder=&type=output`, maxBytes: limits.maxPngBytes, png: true};
  }
  throw comfyError('COMFY_NETWORK_DENIED');
}

/** Injection is trusted backend/test construction only. Callers select a typed
 * operation, never a method, raw route, URL, header or arbitrary destination. */
export function createComfyTransport({httpRequest = httpRequestDefault, reservedPorts, limits: overrides}: ComfyTransportOptions = {}) {
  if (typeof httpRequest !== 'function') throw comfyError('COMFY_INVALID_REQUEST');
  const limits = comfyLimits(overrides);
  return async function requestComfy({baseUrl, operation, nodeClass, promptId, descriptor, filenamePrefix, body, signal, beforeSubmit, maxBytes}: ComfyRequestInput = {}): Promise<ComfyResponse> {
    const destination = resolveComfyDestination(baseUrl, {reservedPorts});
    const route = routeFor({operation, nodeClass, promptId, descriptor, filenamePrefix}, limits);
    if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > route.maxBytes)) throw comfyError('COMFY_INVALID_REQUEST');
    const cap = typeof maxBytes === 'number' ? maxBytes : route.maxBytes;
    if (route.method === 'POST' ? typeof body !== 'string' || !body.length || Buffer.byteLength(body) > limits.maxRequestBytes || typeof beforeSubmit !== 'function' : body !== undefined || beforeSubmit !== undefined) throw comfyError('COMFY_INVALID_REQUEST');
    if (signal?.aborted) throw comfyError('COMFY_ABORTED');
    let request: ClientRequest | undefined, response: IncomingMessage | undefined, failed: ReturnType<typeof comfyError> | undefined;
    let rejectPending: ((reason?: unknown) => void) | undefined, closed = false, ended = false, dispatched = false;
    const fail = (code: string): void => {
      if (closed || failed) return;
      failed = comfyError(code, {dispatched});
      request?.destroy(); response?.destroy(); rejectPending?.(failed);
    };
    const abort = (): void => fail('COMFY_ABORTED');
    signal?.addEventListener('abort', abort, {once: true});
    const totalTimer = setTimeout(() => fail('COMFY_TIMEOUT'), route.png ? limits.pngTimeoutMs : limits.jsonTimeoutMs);
    const connectTimer = setTimeout(() => fail('COMFY_TIMEOUT'), limits.connectTimeoutMs);
    try {
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        rejectPending = reject;
        const headers: Record<string, string> = {Accept: route.png ? 'image/png' : 'application/json', 'Accept-Encoding': 'identity', Connection: 'close'};
        if (route.method === 'POST') Object.assign(headers, {'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body as string))});
        const options: RequestOptions & {autoSelectFamily: boolean} = {protocol: 'http:', hostname: destination.address, port: destination.port, path: route.path, method: route.method,
          headers, agent: false, family: destination.family, autoSelectFamily: false, maxHeaderSize: limits.maxHeaderBytes,
          // Literal IPs do not invoke lookup; an unexpected resolver call fails.
          lookup: (_host, lookupOptions, callback) => {
            const done = (typeof lookupOptions === 'function' ? lookupOptions : callback) as (error: Error) => void;
            done(comfyError('COMFY_NETWORK_DENIED'));
          }};
        request = httpRequest(options, incoming => {
          response = incoming;
          if (closed || failed || !ended) { incoming.destroy(); fail('COMFY_RESPONSE_INVALID'); return; }
          try { assertComfySocket(incoming.socket ?? request?.socket, destination); } catch { fail('COMFY_NETWORK_DENIED'); return; }
          if (incoming.statusCode !== 200 && !(route.allowNotFound && incoming.statusCode === 404)) { fail('COMFY_HTTP_ERROR'); return; }
          const incomingHeaders = incoming.headers ?? {}, type = incomingHeaders['content-type'], encoding = incomingHeaders['content-encoding'], length = incomingHeaders['content-length'];
          const expectedType = route.png ? /^image\/png\s*$/i : /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i;
          if (typeof type !== 'string' || !expectedType.test(type) || (encoding !== undefined && encoding !== 'identity')) { fail('COMFY_RESPONSE_INVALID'); return; }
          if (length !== undefined && (typeof length !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(length) || Number(length) > cap)) { fail('COMFY_RESPONSE_TOO_LARGE'); return; }
          const chunks: Buffer[] = []; let size = 0;
          incoming.on('error', () => fail('COMFY_CONNECTION_FAILED'));
          incoming.on('aborted', () => fail('COMFY_CONNECTION_FAILED'));
          incoming.on('data', (chunk: Buffer | Uint8Array) => {
            if (failed || closed) return;
            if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) { fail('COMFY_RESPONSE_INVALID'); return; }
            size += chunk.byteLength;
            if (size > cap) { fail('COMFY_RESPONSE_TOO_LARGE'); return; }
            chunks.push(Buffer.from(chunk));
          });
          incoming.on('end', () => {
            if (failed || closed) return;
            if (!size || incoming.complete !== true || (length !== undefined && Number(length) !== size)) { fail('COMFY_RESPONSE_INVALID'); return; }
            resolve(Buffer.concat(chunks, size));
          });
          incoming.on('close', () => { if (!failed && !closed && incoming.complete !== true) fail('COMFY_CONNECTION_FAILED'); });
        });
        request.on('error', () => fail('COMFY_CONNECTION_FAILED'));
        request.on('upgrade', (_incoming, socket) => { socket.destroy(); fail('COMFY_RESPONSE_INVALID'); });
        request.once('socket', socket => {
          socket.once('connect', () => {
            if (failed || closed || signal?.aborted) { socket.destroy(); fail('COMFY_ABORTED'); return; }
            try {
              // Resolve exclusions again at the last possible edge. The runtime's
              // listening ports may have changed after request preparation.
              resolveComfyDestination(baseUrl, {reservedPorts});
              assertComfySocket(socket, destination);
            } catch { fail('COMFY_NETWORK_DENIED'); return; }
            clearTimeout(connectTimer);
            if (route.method === 'POST') {
              try {
                const result = (beforeSubmit as () => unknown)();
                if (result && typeof (result as {then?: unknown}).then === 'function') { Promise.resolve(result).catch(() => {}); fail('COMFY_DISPATCH_BLOCKED'); return; }
              } catch { fail('COMFY_DISPATCH_BLOCKED'); return; }
            }
            if (failed || closed || signal?.aborted) { fail('COMFY_ABORTED'); return; }
            ended = true; dispatched = route.method === 'POST';
            // No await, write, flushHeaders, proxy or retry can precede/follow this.
            try { request?.end(body); } catch { fail('COMFY_CONNECTION_FAILED'); }
          });
        });
        if (signal?.aborted) abort();
      });
      if (failed) throw failed;
      return {body: bytes, status: response!.statusCode, dispatched, byteLength: bytes.length};
    } catch (error) {
      if (failed) throw failed;
      throw comfyError(codeOf(error), {dispatched});
    } finally {
      closed = true; rejectPending = undefined;
      clearTimeout(totalTimer); clearTimeout(connectTimer);
      signal?.removeEventListener('abort', abort); request?.destroy(); response?.destroy();
    }
  };
}
