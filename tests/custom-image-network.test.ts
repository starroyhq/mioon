interface NetworkRequest extends EventEmitter{destroy():void;end(payload:unknown):void}
interface CapturedNetworkOptions extends Omit<import('node:https').RequestOptions,'headers'|'lookup'|'checkServerIdentity'>{headers:Record<string,string>;autoSelectFamily:boolean;lookup(host:string,options:{all:true},callback:(error:Error|null,values:{address:string;family:number}[])=>void):void;lookup(host:string,callback:(error:Error|null,address:string,family:number)=>void):void;checkServerIdentity(host:string,certificate:{subjectaltname:string}):Error|undefined}
interface NetworkState{created:number;posts:number;destroyed:number;options:CapturedNetworkOptions;payload:unknown;httpsRequest:(options:CapturedNetworkOptions,callback:(incoming:Readable)=>void)=>NetworkRequest}
interface NetworkOptions{peer?:string;port?:number;authorized?:boolean;status?:number;headers?:Record<string,string|undefined>;body?:Buffer;complete?:boolean;onConnect?:(state:NetworkState)=>unknown;onEnd?:(state:NetworkState)=>unknown;noConnect?:boolean;noResponse?:boolean;chunks?:Buffer[]}
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createCompatibleImageJsonTransport, createImageJsonTransport, resolveCompatibleImageDestination, type ImageTransportOptions} from '../packages/business/src/images/network.ts';
import {IMAGE_NETWORK_LIMITS} from '../packages/business/src/images/profiles.ts';

const baseUrl = 'https://images.example/gateway/v1';
const key = 'synthetic-custom-images-network-key';
const answers = [{address: '8.8.8.8', family: 4}];
const requestArgs = {body: '{"model":"vendor-model/exact-v1"}', beforeDispatch: () => {}};
function network({peer = '8.8.8.8', port = 443, authorized = true, status = 200,
  headers = {'content-type': 'application/json'}, body = Buffer.from('{}'), complete = true,
  onConnect, onEnd, noConnect = false, noResponse = false, chunks}:NetworkOptions = {}) {
  const state={created:0,posts:0,destroyed:0} as NetworkState;
  state.httpsRequest = (options:CapturedNetworkOptions,callback: (arg0: Readable) => void) => {
    state.created++; state.options = options;
    const request=new EventEmitter() as NetworkRequest;
    request.destroy = () => { state.destroyed++; };
    request.end = (payload: unknown) => {
      state.posts++; state.payload = payload; onEnd?.(state);
      if (noResponse) return;
      const response = Readable.from(chunks ?? [body]);
      Object.assign(response, {statusCode: status, headers, complete});
      callback(response);
    };
    queueMicrotask(() => {
      const socket = new EventEmitter();
      Object.assign(socket, {remoteAddress: peer, remotePort: port, authorized, destroy() { state.destroyed++; }});
      request.emit('socket', socket); onConnect?.(state);
      if (!noConnect) socket.emit('secureConnect');
    });
    return request;
  };
  return state;
}
const transport = (state:NetworkState|undefined, options = {}) => createCompatibleImageJsonTransport({baseUrl, apiKey: key, lookup: async () => answers, ...state, ...options});

test('custom transport pins reviewed hostname/path, DNS selection, TLS identity and key until final fence', async () => {
  const order: ("tls" | "post" | "fence")[] = []; let queries = 0;
  const state = network({onConnect: () => order.push('tls'), onEnd: () => order.push('post')});
  const result = await transport(state, {lookup: async (hostname: unknown, options: unknown) => {
    queries++; assert.equal(hostname, 'images.example'); assert.deepEqual(options, {all: true, verbatim: true});
    return [...answers, {address: '2606:4700:4700::1111', family: 6}];
  }})({...requestArgs, beforeDispatch: () => { assert.equal(state.posts, 0); order.push('fence'); }});
  assert.deepEqual(order, ['tls', 'fence', 'post']); assert.equal(queries, 1);
  assert.equal(state.created, 1); assert.equal(state.posts, 1); assert.equal(state.payload, requestArgs.body);
  assert.equal(result.dispatched, true); assert.deepEqual(result.body, Buffer.from('{}'));
  const options = state.options;
  assert.equal(options.protocol, 'https:'); assert.equal(options.hostname, 'images.example'); assert.equal(options.servername, 'images.example');
  assert.equal(options.port, 443); assert.equal(options.path, '/gateway/v1/images/generations'); assert.equal(options.method, 'POST');
  assert.equal(options.agent, false); assert.equal(options.autoSelectFamily, false); assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.headers.Authorization, `Bearer ${key}`); assert.equal(options.headers['Content-Length'], String(Buffer.byteLength(requestArgs.body)));
  assert.equal(options.headers['Accept-Encoding'], 'identity'); assert.equal(options.headers.Cookie, undefined);
  assert.ok(options.checkServerIdentity('attacker.example', {subjectaltname: 'DNS:attacker.example'}) instanceof Error);
  assert.equal(options.checkServerIdentity('ignored.example', {subjectaltname: 'DNS:images.example'}), undefined);
  assert.deepEqual(await new Promise((resolve, reject) => options.lookup('rebind.example', {all: true}, (error: unknown, values: unknown) => error ? reject(error) : resolve(values))), answers);
  assert.deepEqual(await new Promise((resolve, reject) => options.lookup('rebind.example', (error: unknown, address: unknown, family: unknown) => error ? reject(error) : resolve({address, family}))), answers[0]);
  assert.equal(queries, 1);
});

test('only canonical public-HTTPS DNS URLs reach DNS; aliases, ports and ambiguous path syntax cannot be normalized silently', async () => {
  const invalid = [undefined, '', 'http://images.example/v1', 'https://images.example:80/v1', 'https://images.example:443/v1',
    'https://IMAGES.example/v1', 'https://images.example./v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1',
    'https://2130706433/v1', 'https://0177.0.0.1/v1', 'https://0x7f000001/v1', 'https://images.example/v1?key=secret',
    'https://images.example/v1#fragment', 'https://user@images.example/v1', 'https://user:pass@images.example/v1',
    'https://images.example/v1/', 'https://images.example/a//b', 'https://images.example/a/../b', 'https://images.example/a/./b',
    'https://images.example/%2e%2e', 'https://images.example/%2fpath', 'https://images.example\\@other.example',
    'https://images.example/a\\b', 'https://images.example/a b', 'https://images.example/路径', 'https://images.example/\n'];
  let reads = 0;
  for (const value of invalid) {
    assert.throws(() => createCompatibleImageJsonTransport({baseUrl: value, lookup: () => { reads++; }, httpsRequest: () => assert.fail('No HTTPS'), apiKey: key}), {code: 'IMAGE_INVALID_REQUEST'});
    await assert.rejects(resolveCompatibleImageDestination({baseUrl: value, lookup: () => { reads++; }}), {code: 'IMAGE_INVALID_REQUEST'});
  }
  assert.equal(reads, 0);
  for (const value of ['https://images.example', 'https://images.example/v1', 'https://images.example/prefix_v1/~tenant.json']) {
    const destination = await resolveCompatibleImageDestination({baseUrl: value, lookup: async () => answers});
    assert.equal(destination.path, `${new URL(value).pathname.replace(/\/$/, '')}/images/generations`);
  }
});

test('every DNS answer must be public and well formed, without trying another result after rejection', async () => {
  const invalid = [[], [{address: '10.0.0.1', family: 4}], [...answers, {address: '127.0.0.1', family: 4}],
    [...answers, {address: '169.254.169.254', family: 4}], [...answers, {address: '168.63.129.16', family: 4}],
    [...answers, {address: '::ffff:8.8.8.8', family: 6}], [...answers, {address: 'fc00::1', family: 6}],
    [...answers, {address: '2001:db8::1', family: 6}], [{address: '8.8.8.8', family: 6}], Array(65).fill(answers[0]), null];
  for (const values of invalid) {
    const state = network(); let reads = 0;
    await assert.rejects(transport(state, {lookup: async () => { reads++; return values; }})(requestArgs), {code: 'IMAGE_NETWORK_DENIED', dispatched: false, outcomeUnknown: false});
    assert.equal(reads, 1); assert.equal(state.created, 0); assert.equal(state.posts, 0);
  }
});

for (const failure of [{peer: '1.1.1.1'}, {peer: '127.0.0.1'}, {port: 80}, {authorized: false}]) {
  test(`peer/TLS mismatch ${JSON.stringify(failure)} prevents key/body transmission`, async () => {
    const state = network(failure); let fences = 0;
    await assert.rejects(transport(state)({...requestArgs, beforeDispatch: () => { fences++; }}), {code: 'IMAGE_NETWORK_DENIED', dispatched: false, outcomeUnknown: false});
    assert.equal(state.posts, 0); assert.equal(fences, 0);
  });
}

test('redirect statuses never follow Location, forward the key, retry or report a known remote outcome', async () => {
  for (const status of [301, 302, 303, 307, 308, 429, 500]) {
    const state = network({status, headers: {'content-type': 'application/json', location: 'https://other.example/collect'}});
    await assert.rejects(transport(state)(requestArgs), {code: 'IMAGE_HTTP_ERROR', dispatched: true, outcomeUnknown: true});
    assert.equal(state.created, 1); assert.equal(state.posts, 1); assert.equal(state.options.hostname, 'images.example');
  }
});

test('custom transport shares strict encoding/completeness and stream-size caps', async () => {
  for (const options of [{headers: {'content-type': 'image/png'}}, {headers: {'content-type': 'application/json', 'content-encoding': 'gzip'}}, {complete: false}, {headers: {'content-type': 'application/json', 'content-length': '3'}}]) {
    const state = network(options);
    await assert.rejects(transport(state)(requestArgs), error=>(error as Error&{dispatched:boolean;outcomeUnknown:boolean}).dispatched===true&&(error as Error&{outcomeUnknown:boolean}).outcomeUnknown===true);
    assert.equal(state.posts, 1);
  }
  for (const options of [{headers: {'content-type': 'application/json', 'content-length': '101'}}, {chunks: [Buffer.alloc(60), Buffer.alloc(41)]}]) {
    const state = network(options);
    await assert.rejects(transport(state, {limits: {maxResponseBytes: 100}})(requestArgs), {code: 'IMAGE_RESPONSE_TOO_LARGE', dispatched: true});
    assert.equal(state.posts, 1);
  }
  assert.throws(() => transport(network(), {limits: {maxResponseBytes: IMAGE_NETWORK_LIMITS.maxResponseBytes + 1}}), {code: 'IMAGE_INVALID_REQUEST'});
});

test('aborts before TLS/fence stay undispatched; abort after POST remains unknown with no retry', async () => {
  const pre = new AbortController(); pre.abort(); const a = network();
  await assert.rejects(transport(a)({...requestArgs, signal: pre.signal}), {code: 'IMAGE_CANCELLED', dispatched: false, outcomeUnknown: false});
  assert.equal(a.created, 0);
  const mid = new AbortController(), b = network({onConnect: () => mid.abort()});
  await assert.rejects(transport(b)({...requestArgs, signal: mid.signal}), {code: 'IMAGE_CANCELLED', dispatched: false, outcomeUnknown: false});
  assert.equal(b.posts, 0);
  const post = new AbortController(), c = network({onEnd: () => post.abort()});
  await assert.rejects(transport(c)({...requestArgs, signal: post.signal}), {code: 'IMAGE_CANCELLED', dispatched: true, outcomeUnknown: true});
  assert.equal(c.created, 1); assert.equal(c.posts, 1);
  for (const beforeDispatch of [async () => {}, () => { throw Error('synthetic private fence detail'); }]) {
    const state = network();
    await assert.rejects(transport(state)({...requestArgs, beforeDispatch}), {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false, outcomeUnknown: false});
    assert.equal(state.posts, 0);
  }
});

test('custom connect/total deadlines preserve dispatch classification', async () => {
  const a = network({noConnect: true});
  await assert.rejects(transport(a, {limits: {connectTimeoutMs: 5}})(requestArgs), {code: 'IMAGE_TIMEOUT', dispatched: false});
  assert.equal(a.posts, 0);
  const b = network({noResponse: true});
  await assert.rejects(transport(b, {limits: {totalTimeoutMs: 10}})(requestArgs), {code: 'IMAGE_TIMEOUT', dispatched: true, outcomeUnknown: true});
  assert.equal(b.posts, 1);
});

test('official transport still ignores custom endpoint properties and pins its original destination', async () => {
  const state = network();
  await createImageJsonTransport(({baseUrl, apiKey: key, lookup: async (host: unknown) => { assert.equal(host, 'api.openai.com'); return answers; }, ...state} as unknown as Parameters<typeof createImageJsonTransport>[0]))(requestArgs);
  assert.equal(state.options.hostname, 'api.openai.com'); assert.equal(state.options.path, '/v1/images/generations'); assert.equal(state.posts, 1);
});
