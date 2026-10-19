import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createImageEditJsonTransport, createImageJsonTransport, createCompatibleImageJsonTransport, resolveImageEditDestination} from '../packages/business/src/images/network.ts';
import {IMAGE_EDIT_ENDPOINT, IMAGE_EDIT_NETWORK_LIMITS, IMAGE_NETWORK_LIMITS} from '../packages/business/src/images/profiles.ts';

import {errorView} from './helpers/test-error.ts';

interface EditHttpsOptions {hostname: string; servername: string; path: string; port: number; method?: string; agent: boolean;
  autoSelectFamily: boolean; rejectUnauthorized: boolean; headers: Record<string, string>;
  checkServerIdentity(name: string, cert: unknown): Error | undefined;
  lookup(host: string, options: {all: boolean}, callback: (error: Error | null, value?: {address: string; family: number}[]) => void): void}
interface EditNetworkState {calls: number; posts: number; destroyed: number; options?: EditHttpsOptions; callback?: (response: {statusCode: number; headers: Record<string, string>; complete: boolean}) => void; request?: unknown; socket?: unknown; payload?: unknown; httpsRequest?: (options: EditHttpsOptions, callback: (response: {statusCode: number; headers: Record<string, string>; complete: boolean}) => void) => unknown}
interface EditNetworkOptions {body?: Buffer; status?: number; headers?: Record<string, string>; complete?: boolean; peer?: string; port?: number;
  authorized?: boolean; onConnect?: (state: EditNetworkState) => void; onEnd?: (state: EditNetworkState) => void; noConnect?: boolean;
  noResponse?: boolean; chunks?: Buffer[]; duplicateSocket?: boolean; duplicateResponse?: boolean}
type Deferred = {promise: Promise<unknown>; resolve: (value?: unknown) => void}
const key = 'synthetic-edit-network-secret', answers = [{address: '8.8.8.8', family: 4}], args = {body: '{}', beforeDispatch: () => {}};
const deferred = (): Deferred => { let resolve: Deferred['resolve'] = () => {}; const promise = new Promise<unknown>(done => { resolve = done; }); return {promise, resolve}; };
function network({body = Buffer.from('{}'), status = 200, headers = {'content-type': 'application/json'}, complete = true,
  peer = '8.8.8.8', port = 443, authorized = true, onConnect, onEnd, noConnect = false, noResponse = false, chunks, duplicateSocket = false, duplicateResponse = false}: EditNetworkOptions = {}): EditNetworkState {
  const state = {calls: 0, posts: 0, destroyed: 0} as unknown as EditNetworkState;
  state.httpsRequest = (options, callback) => {
    state.calls++; state.options = options; state.callback = callback;
    const request = new EventEmitter() as EventEmitter & {destroy: () => void; end: (payload?: unknown) => void}; state.request = request; request.destroy = () => { state.destroyed++; };
    const incoming = () => { const response = Readable.from(chunks ?? [body]) as Readable & {statusCode: number; headers: Record<string, string>; complete: boolean}; Object.assign(response, {statusCode: status, headers, complete}); return response; };
    request.end = (payload?: unknown) => { state.posts++; state.payload = payload; onEnd?.(state); if (noResponse) return; callback(incoming()); if (duplicateResponse) callback(incoming()); };
    queueMicrotask(() => {
      const socket = new EventEmitter(); state.socket = socket; Object.assign(socket, {remoteAddress: peer, remotePort: port, authorized, destroy() { state.destroyed++; }});
      request.emit('socket', socket); onConnect?.(state); if (!noConnect) socket.emit('secureConnect');
      if (duplicateSocket) { request.emit('socket', socket); socket.emit('secureConnect'); }
    });
    return request;
  };
  return state;
}
const transport = (state: EditNetworkState, options: Record<string, unknown> = {}) => createImageEditJsonTransport({lookup: async () => answers, httpsRequest: state.httpsRequest, apiKey: key, ...options} as never);

test('official edit factory pins endpoint, certificate, selected public address and dedicated headers; passed URLs cannot redirect it', async () => {
  const state = network(), order: string[] = []; let lookups = 0;
  const result = await transport(state, {baseUrl: 'https://attacker.invalid', endpoint: 'https://attacker.invalid/edits', path: '/override', lookup: async (hostname: string, options: {all: boolean; verbatim: boolean}) => { lookups++; assert.equal(hostname, 'api.openai.com'); assert.deepEqual(options, {all: true, verbatim: true}); return answers; }})({...args, beforeDispatch: () => { assert.equal(state.posts, 0); order.push('fence'); }});
  assert.equal(IMAGE_EDIT_ENDPOINT, 'https://api.openai.com/v1/images/edits'); assert.equal(result.dispatched, true); assert.equal(state.calls, 1); assert.equal(state.posts, 1); assert.equal(lookups, 1); assert.deepEqual(order, ['fence']);
  const options = state.options!; assert.equal(options.hostname, 'api.openai.com'); assert.equal(options.servername, 'api.openai.com'); assert.equal(options.path, '/v1/images/edits'); assert.equal(options.port, 443); assert.equal(options.method, 'POST');
  assert.equal(options.agent, false); assert.equal(options.autoSelectFamily, false); assert.equal(options.rejectUnauthorized, true); assert.equal(options.headers.Authorization, `Bearer ${key}`); assert.equal(options.headers['Content-Type'], 'application/json'); assert.equal(options.headers['Content-Length'], '2'); assert.equal(options.headers.Cookie, undefined);
  assert.ok(options.checkServerIdentity('api.openai.com', {subjectaltname: 'DNS:attacker.invalid'}) instanceof Error);
  assert.equal(options.checkServerIdentity('ignored.invalid', {subjectaltname: 'DNS:api.openai.com'}), undefined);
  assert.deepEqual(await new Promise((resolve, reject) => options.lookup('rebind.invalid', {all: true}, (error, result) => error ? reject(error) : resolve(result))), answers);
  assert.equal(lookups, 1);
});

test('edit-only request cap admits exact derived maximum and rejects overflow without widening generation/custom bounds', async () => {
  const maximum = IMAGE_EDIT_NETWORK_LIMITS.maxRequestBytes; assert.ok(maximum > 8 * 1024 * 1024); assert.equal(IMAGE_NETWORK_LIMITS.maxRequestBytes, 16384);
  const state = network(); await transport(state)({...args, body: 'x'.repeat(maximum)}); assert.equal(state.posts, 1); assert.equal(state.options!.headers['Content-Length'], String(maximum));
  const blocked = network(); await assert.rejects(transport(blocked)({...args, body: 'x'.repeat(maximum + 1)}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false}); assert.equal(blocked.calls, 0);
  for (const factory of [createImageJsonTransport, createCompatibleImageJsonTransport]) {
    const legacy = network(), dependencies = {lookup: async () => answers, httpsRequest: legacy.httpsRequest, apiKey: key, baseUrl: 'https://custom.example/v1'};
    await assert.rejects(factory(dependencies)({...args, body: 'x'.repeat(16385)}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false}); assert.equal(legacy.calls, 0);
    assert.throws(() => factory({...dependencies, limits: {maxRequestBytes: maximum}}), {code: 'IMAGE_INVALID_REQUEST'});
  }
  for (const value of [maximum + 1, 0, Infinity, NaN, -1]) assert.throws(() => transport(network(), {limits: {maxRequestBytes: value}}), {code: 'IMAGE_INVALID_REQUEST'});
  assert.equal(IMAGE_EDIT_NETWORK_LIMITS.maxResponseBytes, IMAGE_NETWORK_LIMITS.maxResponseBytes); assert.equal(IMAGE_EDIT_NETWORK_LIMITS.maxDecodedBytes, IMAGE_NETWORK_LIMITS.maxDecodedBytes);
});

test('all edit DNS answers and actual TLS peer must pass safety checks; no fallback to other addresses', async () => {
  for (const values of [[], [...answers, {address: '127.0.0.1', family: 4}], [{address: '168.63.129.16', family: 4}], [{address: '8.8.8.8', family: 6}], [{address: '::ffff:8.8.8.8', family: 6}], Array(65).fill(answers[0])]) {
    const state = network(); await assert.rejects(transport(state, {lookup: async () => values})(args), {code: 'IMAGE_NETWORK_DENIED', dispatched: false, outcomeUnknown: false}); assert.equal(state.calls, 0);
  }
  assert.deepEqual(await resolveImageEditDestination({lookup: async () => answers}), {hostname: 'api.openai.com', port: 443, secure: true, address: '8.8.8.8', family: 4, path: '/v1/images/edits'});
  for (const invalid of [{peer: '1.1.1.1'}, {peer: '127.0.0.1'}, {port: 80}, {authorized: false}]) {
    const state = network(invalid); await assert.rejects(transport(state)(args), {code: 'IMAGE_NETWORK_DENIED', dispatched: false}); assert.equal(state.posts, 0);
  }
});

test('the edit dispatch fence runs once synchronously after DNS/TLS and immediately before sole POST, despite duplicate socket events', async () => {
  const order: string[] = [], state = network({duplicateSocket: true, onConnect: () => order.push('tls'), onEnd: () => order.push('post')});
  await transport(state, {lookup: async () => { order.push('dns'); return answers; }})({...args, beforeDispatch: () => { order.push('fence'); queueMicrotask(() => order.push('later')); }});
  assert.deepEqual(order, ['dns', 'tls', 'fence', 'post', 'later']); assert.equal(state.calls, 1); assert.equal(state.posts, 1);
  for (const beforeDispatch of [async () => {}, () => { throw Error(`private detail ${key}`); }]) {
    const blocked = network(); await assert.rejects(transport(blocked)({...args, beforeDispatch}), {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false, outcomeUnknown: false}); assert.equal(blocked.posts, 0);
  }
});

test('pre-dispatch aborts before DNS, during DNS, during TLS and inside fence are unsubmitted; after POST stays outcome-unknown', async () => {
  const pre = new AbortController(); pre.abort(); const a = network(); await assert.rejects(transport(a)({...args, signal: pre.signal}), {code: 'IMAGE_CANCELLED', dispatched: false, outcomeUnknown: false}); assert.equal(a.calls, 0);
  const entered = deferred(), release = deferred(), during = new AbortController(), b = network();
  const pending = transport(b, {lookup: () => { entered.resolve(); return release.promise; }})({...args, signal: during.signal}); await entered.promise; during.abort(); release.resolve(answers);
  await assert.rejects(pending, {code: 'IMAGE_CANCELLED', dispatched: false, outcomeUnknown: false}); assert.equal(b.calls, 0);
  const tls = new AbortController(), c = network({onConnect: () => tls.abort()}); await assert.rejects(transport(c)({...args, signal: tls.signal}), {code: 'IMAGE_CANCELLED', dispatched: false}); assert.equal(c.posts, 0);
  const fenceAbort = new AbortController(), d = network(); await assert.rejects(transport(d)({...args, signal: fenceAbort.signal, beforeDispatch: () => fenceAbort.abort()}), {code: 'IMAGE_CANCELLED', dispatched: false, outcomeUnknown: false}); assert.equal(d.posts, 0);
  const after = new AbortController(), e = network({onEnd: () => after.abort()}); await assert.rejects(transport(e)({...args, signal: after.signal}), {code: 'IMAGE_CANCELLED', dispatched: true, outcomeUnknown: true}); assert.equal(e.posts, 1);
});

test('redirect/error status never follows Location or retries and returned errors redact key, response and server messages', async () => {
  for (const status of [301, 302, 303, 307, 308, 401, 429, 500]) {
    const state = network({status, body: Buffer.from(`private body ${key}`), headers: {'content-type': 'application/json', location: `https://attacker.invalid/${key}`}});
    await assert.rejects(transport(state)(args), error => { assert.equal(error.code, 'IMAGE_HTTP_ERROR'); assert.equal(error.dispatched, true); assert.equal(error.outcomeUnknown, true); assert.equal(error.message.includes(key), false); assert.equal(error.cause, undefined); return true; });
    assert.equal(state.calls, 1); assert.equal(state.posts, 1); assert.equal(state.options!.hostname, 'api.openai.com');
  }
});

test('edit streaming response bounds, headers, completeness and declared lengths stay strict', async () => {
  for (const options of [{headers: {'content-type': 'application/json', 'content-length': '101'}}, {chunks: [Buffer.alloc(60), Buffer.alloc(41)]}, {headers: {'content-type': 'application/json', 'content-length': '2'}, chunks: [Buffer.alloc(60), Buffer.alloc(41)]}]) {
    const state = network(options); await assert.rejects(transport(state, {limits: {maxResponseBytes: 100}})(args), {code: 'IMAGE_RESPONSE_TOO_LARGE', dispatched: true, outcomeUnknown: true}); assert.equal(state.posts, 1);
  }
  for (const options of [{headers: {'content-type': 'image/png'}}, {headers: {'content-type': 'application/json', 'content-encoding': 'gzip'}}, {complete: false}, {headers: {'content-type': 'application/json', 'content-length': '3'}}, {duplicateResponse: true}]) {
    const state = network(options); await assert.rejects(transport(state)(args), {code: 'IMAGE_RESPONSE_INVALID', dispatched: true, outcomeUnknown: true}); assert.equal(state.posts, 1);
  }
});

test('deadlines and late callbacks never dispatch twice or resurrect completed/cancelled edit requests', async () => {
  const before = network({noConnect: true}); await assert.rejects(transport(before, {limits: {connectTimeoutMs: 5}})(args), {code: 'IMAGE_TIMEOUT', dispatched: false});
  before.socket.emit('secureConnect'); before.request.emit('error', Error(`private ${key}`)); assert.equal(before.posts, 0);
  const after = network({noResponse: true}); await assert.rejects(transport(after, {limits: {totalTimeoutMs: 10}})(args), {code: 'IMAGE_TIMEOUT', dispatched: true, outcomeUnknown: true});
  const late = Readable.from([Buffer.from('{}')]); Object.assign(late, {statusCode: 200, headers: {'content-type': 'application/json'}, complete: true}); after.callback(late); after.socket.emit('secureConnect'); assert.equal(after.posts, 1); assert.equal(late.destroyed, true);
  const complete = network(); await transport(complete)(args); const duplicate = Readable.from([Buffer.from('{}')]); complete.callback(duplicate); complete.request.emit('error', Error('late private failure')); complete.socket.emit('secureConnect'); assert.equal(complete.posts, 1); assert.equal(duplicate.destroyed, true);
});
