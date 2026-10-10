import {isIP} from 'node:net';
import {checkServerIdentity} from 'node:tls';
import {isPublicAgentAddress, assertPinnedAgentSocket} from '../agent/network-policy.mjs';
import {IMAGE_GENERATION_ENDPOINT, IMAGE_NETWORK_LIMITS, imageAdapterError} from './profiles.mjs';

function limitsFor(overrides = {}) {
  const limits = {...IMAGE_NETWORK_LIMITS};
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, name) || !Number.isSafeInteger(value) || value < 1 || value > limits[name]) throw imageAdapterError('IMAGE_INVALID_REQUEST');
    limits[name] = value;
  }
  return limits;
}
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function resolveImageDestination({lookup, signal, maxDnsAnswers = IMAGE_NETWORK_LIMITS.maxDnsAnswers} = {}) {
  if (typeof lookup !== 'function') throw imageAdapterError('IMAGE_LIVE_DISABLED');
  if (!Number.isInteger(maxDnsAnswers) || maxDnsAnswers < 1 || maxDnsAnswers > IMAGE_NETWORK_LIMITS.maxDnsAnswers) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  if (signal?.aborted) throw imageAdapterError('IMAGE_CANCELLED');
  const url = new URL(IMAGE_GENERATION_ENDPOINT);
  let answers;
  try {
    const query = lookup(url.hostname, {all: true, verbatim: true});
    answers = await (signal ? raceAbort(query, signal) : query);
  } catch { throw imageAdapterError(signal?.aborted ? 'IMAGE_CANCELLED' : 'IMAGE_CONNECTION_FAILED'); }
  if (signal?.aborted) throw imageAdapterError('IMAGE_CANCELLED');
  if (!Array.isArray(answers) || !answers.length || answers.length > maxDnsAnswers || answers.some(item => !item || ![4, 6].includes(item.family) || isIP(item.address) !== item.family || !isPublicAgentAddress(item.address))) throw imageAdapterError('IMAGE_NETWORK_DENIED');
  return {hostname: url.hostname, port: 443, secure: true, address: answers[0].address, family: answers[0].family, path: url.pathname};
}
/** Dependencies are explicit: no ambient fetch, SDK or credential discovery.
 * The dedicated reviewed Images gateway supplies the platform DNS/HTTPS pair;
 * synthetic tests supply inert dependencies and a fake sentinel.
 * No retries, redirects, proxy/environment handling, pooled agents or URL input. */
export function createImageJsonTransport({lookup, httpsRequest, apiKey, limits: overrides} = {}) {
  if (typeof lookup !== 'function' || typeof httpsRequest !== 'function') throw imageAdapterError('IMAGE_LIVE_DISABLED');
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  const limits = limitsFor(overrides);
  return async function postImageJson({body, signal, beforeDispatch} = {}) {
    if (typeof body !== 'string' || !body.length || Buffer.byteLength(body) > limits.maxRequestBytes || typeof beforeDispatch !== 'function') throw imageAdapterError('IMAGE_INVALID_REQUEST');
    if (signal?.aborted) throw imageAdapterError('IMAGE_CANCELLED');
    let request, response, rejectPending, failed, closed = false, dispatched = false;
    const controller = new AbortController();
    const fail = code => {
      if (closed || failed) return;
      failed = imageAdapterError(code, {dispatched});
      controller.abort(failed); request?.destroy(); response?.destroy(); rejectPending?.(failed);
    };
    const externalAbort = () => fail('IMAGE_CANCELLED');
    signal?.addEventListener('abort', externalAbort, {once: true});
    if (signal?.aborted) externalAbort();
    const totalTimer = setTimeout(() => fail('IMAGE_TIMEOUT'), limits.totalTimeoutMs);
    const connectTimer = setTimeout(() => fail('IMAGE_TIMEOUT'), limits.connectTimeoutMs);
    const close = () => {
      if (closed) return; closed = true;
      clearTimeout(totalTimer); clearTimeout(connectTimer);
      signal?.removeEventListener('abort', externalAbort);
      request?.destroy(); response?.destroy();
    };
    try {
      const destination = await resolveImageDestination({lookup, signal: controller.signal, maxDnsAnswers: limits.maxDnsAnswers});
      if (failed) throw failed;
      response = await new Promise((resolve, reject) => {
        rejectPending = reject;
        const options = {protocol: 'https:', hostname: destination.hostname, port: 443, path: destination.path, method: 'POST', agent: false, family: destination.family, autoSelectFamily: false, maxHeaderSize: limits.maxHeaderBytes,
          headers: {'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Length': String(Buffer.byteLength(body)), Connection: 'close', Authorization: `Bearer ${apiKey}`},
          rejectUnauthorized: true, servername: destination.hostname, checkServerIdentity: (_host, certificate) => checkServerIdentity(destination.hostname, certificate),
          lookup: (_host, options, callback) => {
            if (typeof options === 'function') { callback = options; options = {}; }
            if (controller.signal.aborted) return callback(failed || imageAdapterError('IMAGE_CANCELLED', {dispatched}));
            callback(null, ...(options?.all ? [[{address: destination.address, family: destination.family}]] : [destination.address, destination.family]));
          },
        };
        request = httpsRequest(options, incoming => {
          response = incoming;
          if (failed || closed || !dispatched) { incoming.destroy(); if (!failed && !closed) fail('IMAGE_RESPONSE_INVALID'); return; }
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
            if (failed || closed || controller.signal.aborted) { socket.destroy(); return; }
            try { assertPinnedAgentSocket(socket, destination); }
            catch { fail('IMAGE_NETWORK_DENIED'); return; }
            clearTimeout(connectTimer);
            try {
              const result = beforeDispatch();
              // The host fence is synchronous and durable; never race an async write.
              if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); fail('IMAGE_DISPATCH_BLOCKED'); return; }
            } catch { fail('IMAGE_DISPATCH_BLOCKED'); return; }
            if (failed || closed || controller.signal.aborted) return;
            dispatched = true;
            // First possible credential/header/body transmission. Never retry end().
            try { request.end(body); } catch { fail('IMAGE_CONNECTION_FAILED'); }
          });
        });
      });
      rejectPending = undefined;
      const chunks = []; let length = 0;
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
      throw imageAdapterError(error?.code, {dispatched});
    } finally { close(); }
  };
}
