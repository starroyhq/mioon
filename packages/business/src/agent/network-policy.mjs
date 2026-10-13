import {invokeAgentSubmissionFence} from './gain-context-fence.ts';
import {AGENT_PROTOCOLS, deriveAgentEndpoint} from '@mioon/contracts';
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpsRequestDefault} from 'node:https';
import {request as httpRequestDefault} from 'node:http';
import {checkServerIdentity} from 'node:tls';
import {parseAgentConfiguration} from './config.mjs';
import {agentChatError} from './chat-errors.mjs';

export const AGENT_NETWORK_LIMITS = Object.freeze({connectTimeoutMs: 10000, readTimeoutMs: 20000, totalTimeoutMs: 120000, maxHeaderBytes: 16384, maxDnsAnswers: 64});
const denied = () => { throw agentChatError('AGENT_CHAT_NETWORK_DENIED'); };
const bareHost = host => host.startsWith('[') ? host.slice(1, -1) : host;
function ipv6Words(address) {
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
export function isPublicAgentAddress(address) {
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
function canonicalAddress(address) {
  if (isIP(address) === 4) return address;
  const words = ipv6Words(address);
  if (!words) return null;
  // Some operating systems expose an IPv4 peer in mapped form. Only accept it
  // when it is precisely the independently validated, pinned IPv4 address.
  if (words.slice(0, 5).every(n => n === 0) && words[5] === 0xffff) return `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  return words.map(n => n.toString(16)).join(':');
}
export function assertPinnedAgentSocket(socket, destination) {
  if (canonicalAddress(socket?.remoteAddress) !== canonicalAddress(destination.address) || socket?.remotePort !== destination.port) denied();
  if (destination.secure && socket.authorized !== true) throw agentChatError('AGENT_CHAT_CONNECT_FAILED');
}
function abortError(signal) {
  return signal?.reason?.code === 'AGENT_CHAT_TIMEOUT' ? agentChatError('AGENT_CHAT_TIMEOUT') : agentChatError('AGENT_CHAT_ABORTED');
}
function abortable(promise, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal?.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}
export async function resolveAgentDestination(configuration, {selfPort, lookup = dnsLookup, signal, maxDnsAnswers = AGENT_NETWORK_LIMITS.maxDnsAnswers} = {}) {
  let config;
  try { config = parseAgentConfiguration(configuration, {selfPort}); } catch { denied(); }
  const url = new URL(deriveAgentEndpoint(config));
  const hostname = bareHost(url.hostname), port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (signal?.aborted) throw abortError(signal);
  if (config.presetId === 'ollama') {
    if (!Number.isInteger(selfPort) || selfPort < 1 || selfPort > 65535 || port === selfPort) denied();
    // localhost means this exact loopback destination, never a host-file/DNS alias.
    const address = hostname === 'localhost' ? '127.0.0.1' : hostname;
    if (!['127.0.0.1', '::1'].includes(address) || url.pathname !== `/v1${AGENT_PROTOCOLS[config.protocol].path}`) denied();
    return {hostname, address, family: isIP(address), port, secure: url.protocol === 'https:', path: url.pathname, local: true};
  }
  let addresses;
  if (isIP(hostname)) addresses = [{address: hostname, family: isIP(hostname)}];
  else {
    try { addresses = await abortable(lookup(hostname, {all: true, verbatim: true}), signal); }
    catch (error) { if (signal?.aborted) throw abortError(signal); throw agentChatError('AGENT_CHAT_CONNECT_FAILED'); }
  }
  if (signal?.aborted) throw abortError(signal);
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > maxDnsAnswers) denied();
  for (const item of addresses) if (!item || ![4, 6].includes(item.family) || isIP(item.address) !== item.family || !isPublicAgentAddress(item.address)) denied();
  const {address, family} = addresses[0];
  return {hostname, address, family, port, secure: true, path: url.pathname, local: false};
}
function limitsFor(overrides = {}) {
  const result = {...AGENT_NETWORK_LIMITS};
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(result, key) || !Number.isInteger(value) || value < 1 || value > result[key]) throw agentChatError('AGENT_CHAT_VALIDATION');
    result[key] = value;
  }
  return result;
}
/** Dependency injection is a trusted-code construction boundary, not an HTTP
 * option. Production uses Node HTTPS directly: no fetch, proxy, redirects,
 * cookie jar, global pooled agent, arbitrary header input or second lookup. */
export function createAgentTransport({lookup = dnsLookup, httpsRequest = httpsRequestDefault, httpRequest = httpRequestDefault, limits: overrides} = {}) {
  const limits = limitsFor(overrides);
  return async function openAgentStream({configuration, apiKey, body, signal, selfPort, beforeSubmit}) {
    const controller = new AbortController();
    let request, response, failed = null, rejectPending, closed = false;
    const fail = code => {
      if (closed || failed) return;
      failed = agentChatError(code);
      controller.abort(failed);
      request?.destroy(); response?.destroy();
      rejectPending?.(failed);
    };
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
      const destination = await resolveAgentDestination(configuration, {selfPort, lookup, signal: controller.signal, maxDnsAnswers: limits.maxDnsAnswers});
      if (failed || controller.signal.aborted) throw failed || abortError(controller.signal);
      invokeAgentSubmissionFence(beforeSubmit);
      const headers = {'Content-Type': 'application/json', Accept: 'text/event-stream', 'Accept-Encoding': 'identity', 'Content-Length': String(Buffer.byteLength(body)), Connection: 'close'};
      // apiKey must be acquired by the host for this exact configuration binding.
      // Local Ollama needs no key by default, but an explicitly bound local key
      // is honored rather than silently changing an authenticated configuration.
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      response = await new Promise((resolve, reject) => {
        rejectPending = reject;
        const options = {
          protocol: destination.secure ? 'https:' : 'http:', hostname: destination.hostname, port: destination.port,
          path: destination.path, method: 'POST', headers, agent: false, family: destination.family,
          autoSelectFamily: false, maxHeaderSize: limits.maxHeaderBytes,
          lookup: (_host, options, callback) => {
            if (typeof options === 'function') { callback = options; options = {}; }
            if (controller.signal.aborted) return callback(abortError(controller.signal));
            callback(null, ...(options?.all ? [[{address: destination.address, family: destination.family}]] : [destination.address, destination.family]));
          },
          ...(destination.secure ? {rejectUnauthorized: true, servername: isIP(destination.hostname) ? '' : destination.hostname, checkServerIdentity: (_host, certificate) => checkServerIdentity(destination.hostname, certificate)} : {}),
        };
        request = (destination.secure ? httpsRequest : httpRequest)(options, incoming => {
          response = incoming;
          if (failed) { incoming.destroy(); return; }
          if (incoming.statusCode !== 200) { fail('AGENT_CHAT_HTTP_ERROR'); return; }
          const contentType = incoming.headers['content-type'];
          const encoding = incoming.headers['content-encoding'];
          if (typeof contentType !== 'string' || !/^text\/event-stream(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(contentType) || (encoding && encoding !== 'identity')) { fail('AGENT_CHAT_PROTOCOL_ERROR'); return; }
          incoming.on('error', () => { if (!closed && !failed) failed = agentChatError('AGENT_CHAT_TRUNCATED'); });
          resolve(incoming);
        });
        request.on('error', () => fail('AGENT_CHAT_CONNECT_FAILED'));
        request.on('upgrade', (_res, socket) => { socket.destroy(); fail('AGENT_CHAT_PROTOCOL_ERROR'); });
        request.setTimeout(limits.readTimeoutMs, () => fail('AGENT_CHAT_TIMEOUT'));
        request.once('socket', socket => {
          socket.once(destination.secure ? 'secureConnect' : 'connect', () => {
            if (failed || controller.signal.aborted || closed) { socket.destroy(); return; }
            try { assertPinnedAgentSocket(socket, destination); invokeAgentSubmissionFence(beforeSubmit); }
            catch (error) { fail(error.code); return; }
            clearTimeout(connectTimer);
            // Wait until the pinned peer and, for HTTPS, authenticated TLS are
            // verified before transmitting any headers, key or request content.
            request.end(body);
          });
        });
      });
      return {body: response, close, error: () => failed};
    } catch (error) {
      close();
      if (failed) throw failed;
      throw agentChatError(error?.code);
    }
  };
}
