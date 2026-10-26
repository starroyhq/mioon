type ObservedResponse = http.ServerResponse&{baselineListeners?:Record<string,number>;sentFrames:unknown[];maxPending:number};
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {EventEmitter, once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {createChatHttp, type ChatHttp} from '../apps/server/src/chat-http.ts';
import {createChatSse, CHAT_SSE_LIMITS} from '../apps/server/src/chat-sse.ts';
import {CHAT_LIMITS, chatRuntimeError} from '../packages/business/src/agent/chat-runtime.ts';

const frame = (value: { id: unknown; type: unknown; text?: string; run?: { status: string; }; }) => `id: ${value.id}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const delta = (id = 1, text = 'synthetic') => ({id, type: 'delta', text});
const terminal = (id = 2) => ({id, type: 'terminal', run: {status: 'completed'}});
class Response extends EventEmitter {
 declare statusCode:number;declare headers:unknown;declare baselineListeners?:Record<string,number>;

  headersSent = false; writableEnded = false; writableFinished = false; destroyed = false; closed = false;
  writableLength = 0; writes: string[] = []; callbacks: (((error?:Error)=>void)|undefined)[] = []; returnValue = true; endCalls = 0; destroyCalls = 0;
  writeHead(status: number, headers: unknown) { this.statusCode = status; this.headers = headers; this.headersSent = true; }
  setHeader() {}
  flushHeaders() {}
  write(value: string, callback: ((error?:Error)=>void)|undefined) { this.writes.push(value); this.callbacks.push(callback); this.writableLength += Buffer.byteLength(value); return this.returnValue; }
  end(value: string|undefined) { this.endCalls++; this.writableEnded = true; if (value) this.writes.push(value); }
  destroy() { this.destroyCalls++; this.destroyed = true; }
  drain() { this.writableLength = 0; for (const callback of this.callbacks.splice(0)) callback?.(); this.emit('drain'); }
  finish() { this.writableFinished = true; this.writableLength = 0; this.emit('finish'); }
  close() { this.closed = true; this.emit('close'); }
}
function transport(options = {}) {
  const res = new Response(); let detached = 0, settled = 0;
  const stream = createChatSse(({res, options, onSettled() { settled++; }} as unknown as Parameters<typeof createChatSse>[0]));
  stream.attach(() => { detached++; stream.end(); }); stream.start();
  return {res, stream, get detached() { return detached; }, get settled() { return settled; }};
}
function clean(res: import('node:events').EventEmitter&{baselineListeners?:Record<string,number>}) { for (const name of ['close', 'finish', 'error', 'drain'] as const) assert.ok(res.listenerCount(name) <= ((res as ObservedResponse).baselineListeners?.[name] ?? 0), name); }

test('SSE ordinary cap includes the next UTF-8 frame and never writes the crossing frame', () => {
  const f = transport();
  f.res.writableLength = CHAT_SSE_LIMITS.maxBufferedBytes - Buffer.byteLength(frame(delta(1, '漢字'))) + 1;
  f.stream.event(delta(1, '漢字'));
  assert.equal(f.res.writes.length, 0); assert.equal(f.res.destroyed, true); assert.equal(f.detached, 1);
  assert.equal(f.settled, 0, 'destroying is not yet socket close');
  f.res.close(); assert.equal(f.settled, 1); clean(f.res);
});

test('write(false) pauses frames and heartbeat; only a real drain resets the 30 s stall deadline', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const f = transport(); f.res.returnValue = false; f.stream.event(delta());
  f.stream.event(delta(2)); assert.equal(f.res.writes.length, 1);
  t.mock.timers.tick(15000); assert.equal(f.res.writes.length, 1, 'heartbeat adds no bytes while blocked');
  t.mock.timers.tick(14999); assert.equal(f.res.destroyed, false);
  f.res.drain(); assert.equal(f.res.writes.length, 2);
  t.mock.timers.tick(29999); assert.equal(f.res.destroyed, false, 'successful drain starts a fresh stall deadline');
  t.mock.timers.tick(1); assert.equal(f.res.destroyed, true); assert.equal(f.detached, 1);
  f.res.close(); clean(f.res); t.mock.timers.tick(120000); assert.equal(f.res.destroyCalls, 1);
});

test('a running write(true) below the high-water mark still has a 30 s stalled-write deadline', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const f = transport(); f.stream.event(delta()); assert.equal(f.res.returnValue, true);
  t.mock.timers.tick(29999); assert.equal(f.res.destroyed, false);
  t.mock.timers.tick(1); assert.equal(f.res.destroyed, true); assert.equal(f.detached, 1);
  f.res.close(); clean(f.res);
});

test('successful small-write callbacks extend healthy progress but older generations cannot extend a new stall', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const healthy = transport(); healthy.stream.event(delta());
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(20000); healthy.res.writableLength = 1; healthy.res.callbacks.shift()!();
    assert.equal(healthy.res.destroyed, false);
  }
  healthy.res.close(); clean(healthy.res);
  const f = transport(); f.res.returnValue = false; f.stream.event(delta());
  const oldCallback = f.res.callbacks[0]; t.mock.timers.tick(10000);
  f.res.writableLength = 0; f.res.emit('drain');
  f.res.returnValue = true; f.stream.event(delta(2));
  t.mock.timers.tick(20000); oldCallback!();
  t.mock.timers.tick(9999); assert.equal(f.res.destroyed, false);
  t.mock.timers.tick(1); assert.equal(f.res.destroyed, true, 'old callback did not refresh the newer unblocked stall');
  f.res.close(); clean(f.res);
});

test('healthy streams have no transport duration cap and heartbeat overflow destroys rather than only end()', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const f = transport();
  for (let i = 0; i < 20; i++) { t.mock.timers.tick(15000); f.res.drain(); }
  assert.equal(f.res.destroyed, false); assert.equal(f.res.writes.length, 20);
  f.res.writableLength = CHAT_SSE_LIMITS.maxBufferedBytes - 1;
  t.mock.timers.tick(15000); assert.equal(f.res.destroyed, true); assert.equal(f.res.endCalls, 0);
  assert.equal(f.res.writes.length, 20); assert.equal(f.detached, 1); f.res.close(); clean(f.res);
});

test('terminal queues after a blocked frame, releases subscriber immediately, and stays owned until finish', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const f = transport(); f.res.returnValue = false; f.stream.event(delta()); f.stream.event(terminal());
  assert.equal(f.detached, 1); assert.equal(f.res.endCalls, 0); assert.equal(f.settled, 0);
  t.mock.timers.tick(15000); assert.equal(f.res.writes.length, 1);
  f.res.returnValue = true; f.res.drain();
  assert.deepEqual(f.res.writes, [frame(delta()), frame(terminal())]); assert.equal(f.res.endCalls, 1);
  assert.equal(f.settled, 0, 'end() alone cannot free a buffered transport');
  f.res.finish(); assert.equal(f.settled, 1); clean(f.res);
  t.mock.timers.tick(60000); assert.equal(f.res.destroyed, false); assert.equal(f.detached, 1);
});

test('terminal with pending end() is still bounded even if the response never emits drain or finish', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const f = transport(); f.stream.event(terminal());
  assert.equal(f.res.writableEnded, true); t.mock.timers.tick(30000);
  assert.equal(f.res.destroyed, true); assert.equal(f.detached, 1); f.res.close(); clean(f.res);
});

test('synchronous terminal replay before the detach handle returns releases that handle once', () => {
  const res = new Response(); let detached = 0, settled = 0;
  const stream = createChatSse(({res, onSettled() { settled++; }} as unknown as Parameters<typeof createChatSse>[0]));
  stream.event(terminal()); stream.attach(() => { detached++; stream.end(); }); stream.start();
  assert.equal(detached, 1); assert.equal(res.endCalls, 1); assert.equal(settled, 0);
  stream.event(delta(3)); assert.equal(res.writes.length, 1); res.finish(); clean(res); assert.equal(settled, 1);
});

test('write/header/end exceptions, asynchronous response errors and write callback errors stay local', () => {
  for (const fault of ['write', 'headers', 'end', 'error', 'callback'] as const) {
    const f = transport();
    if (fault === 'write') f.res.write = () => { throw new Error('synthetic write'); };
    if (fault === 'headers') f.res.flushHeaders = () => { throw new Error('synthetic headers'); };
    if (fault === 'end') f.res.end = () => { throw new Error('synthetic end'); };
    assert.doesNotThrow(() => f.stream.event(fault === 'end' ? terminal() : delta()));
    if (fault === 'error') assert.doesNotThrow(() => f.res.emit('error', new Error('synthetic async response')));
    if (fault === 'callback') assert.doesNotThrow(() => f.res.callbacks[0]!(new Error('synthetic callback')));
    assert.equal(f.res.destroyed, true, fault); assert.equal(f.detached, 1, fault);
    f.res.close(); clean(f.res); f.stream.close(); assert.equal(f.detached, 1);
  }
});

test('only one oversized frame allowance exists and oversize frames never bypass the maximum', () => {
  const options = {maxBufferedBytes: 256, maxFrameBytes: 1024};
  const f = transport(options); f.res.returnValue = false;
  f.stream.event(delta(1, 'x'.repeat(600))); assert.equal(f.res.writes.length, 1); assert.equal(f.res.destroyed, false);
  f.stream.event(delta(2, 'small')); assert.equal(f.res.destroyed, false);
  f.stream.event(delta(3, 'x'.repeat(600))); assert.equal(f.res.destroyed, true); assert.equal(f.res.writes.length, 1);
  f.res.close(); clean(f.res);
  const g = transport(options); g.stream.event(delta(1, 'x'.repeat(1024)));
  assert.equal(g.res.writes.length, 0); assert.equal(g.res.destroyed, true); g.res.close(); clean(g.res);
});

function syntheticRuntime() {
  const id = randomUUID(), instanceId = randomUUID(), projectId = 'synthetic-project', subscribers: Set<{listener:(event:unknown)=>void;detach():void}> = new Set();
  let events: ({ id: number; type: string; run?: { status: string; } | { status: string; assistantText: string; userText: string; }; text?: string; })[] = [], lastId = 0, status = 'running', inferenceCalls = 0, stopCalls = 0, detached = 0, subscriptions = 0;
  const snapshot = () => ({id: lastId, type: 'snapshot', instanceId, projectId, runId: id, run: {id, status, assistantText: ''}});
  return {
    id, instanceId, projectId, subscribers,
    get inferenceCalls() { return inferenceCalls; }, get stopCalls() { return stopCalls; },
    get detached() { return detached; }, get subscriptions() { return subscriptions; },
    send() { inferenceCalls++; return {instanceId, run: {id, status}}; },
    stop() { stopCalls++; throw new Error('Transport must never call Stop'); },
    get() { return {instanceId, run: {id, status}}; },
    publish(value: { id?: number; type: string; run?: { status: string; }|{ status: string; assistantText: string; userText: string; }; text?: string; }) {
      const event = {...value, id: ++lastId}; if (event.type === 'terminal') status = event.run!.status;
      events.push(event); if (events.length > 8) events.shift();
      for (const entry of [...subscribers] as const) { entry.listener(event); if (event.type === 'terminal') entry.detach(); }
      return event;
    },
    subscribe(project: unknown, run: unknown, supplied: unknown, after: number, listener: (arg0: unknown) => void, onClose: () => void) {
      subscriptions++;
      if ((this as typeof this&{subscriptionError?:Error}).subscriptionError) throw (this as typeof this&{subscriptionError?:Error}).subscriptionError;
      assert.equal(project, projectId); assert.equal(run, id); assert.equal(supplied, instanceId);
      const entry = {listener, detach: () => { if (subscribers.delete(entry)) { detached++; onClose(); } }};
      subscribers.add(entry);
      const replay = events.filter(event => event.id > after);
      for (const event of replay.length ? replay : [snapshot()]) { if (!subscribers.has(entry)) break; listener(event); }
      if (status !== 'running') entry.detach();
      return entry.detach;
    },
  };
}
test('default independent client cap counts 32 terminal sockets until actual close', async () => {
  const runtime = syntheticRuntime(); runtime.publish(terminal());
  const handler = createChatHttp({runtime: (runtime as unknown as Parameters<typeof createChatHttp>[0]['runtime'])}), responses: { close: () => void; }[] = [], url = new URL(`http://localhost/api/agent/chat/${runtime.projectId}/runs/${runtime.id}/events?instanceId=${runtime.instanceId}`);
  const request = async () => { const res = new Response(); res.returnValue = false; responses.push(res); await handler.handle(({method: 'GET', headers: {}} as unknown as http.IncomingMessage), (res as unknown as http.ServerResponse), url); return res; };
  try {
    for (let i = 0; i < 32; i++) assert.equal((await request()).statusCode, 200);
    assert.equal(runtime.subscribers.size, 0); assert.equal(runtime.detached, 32);
    const busy = await request(); assert.equal(busy.statusCode, 429); assert.equal(JSON.parse((busy.writes[0] as string)).error.code, 'AGENT_CHAT_BUSY');
    assert.equal(runtime.subscriptions, 32);
    responses[0].close(); assert.equal((await request()).statusCode, 200); assert.equal(runtime.subscriptions, 33);
  } finally { handler.close(); for (const res of responses) res.close(); }
});

test('shutdown owns a buffered end() until finish and bounds even a response that never reports backpressure', async () => {
  const f = transport(); f.stream.event(terminal()); assert.equal(f.res.writableEnded, true); assert.equal(f.settled, 0);
  f.stream.close(); await turn(); assert.equal(f.res.destroyed, true); assert.equal(f.detached, 1);
  f.res.close(); clean(f.res); assert.equal(f.settled, 1);
});

async function fixture(t: test.TestContext, options = {}) {
  const runtime = syntheticRuntime(), routeHandler = createChatHttp({runtime: (runtime as unknown as Parameters<typeof createChatHttp>[0]['runtime']), sseOptions: options}), responses: ObservedResponse[] = [], clients: Set<net.Socket> = new Set();
  const server = http.createServer((req, res) => {
    if (req.url!.includes('/events?')) {
      responses.push(res as ObservedResponse); (res as ObservedResponse).baselineListeners = Object.fromEntries(['close', 'finish', 'error', 'drain'].map(name => [name, res.listenerCount(name)])); (res as ObservedResponse).sentFrames = []; (res as ObservedResponse).maxPending = 0;
      const write = res.write;
      res.write = function(value, ...args) {
        const result = (write as (...args:unknown[])=>boolean).call(this, value, ...(((args!)))); (this as ObservedResponse).sentFrames.push(value);
        (this as ObservedResponse).maxPending = Math.max((this as ObservedResponse).maxPending, this.writableLength); return result;
      };
    }
    routeHandler.handle(req, (res as unknown as http.ServerResponse), new URL(req.url!, 'http://localhost')).catch(error => { res.destroy(error); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo)!.port}`, base = `/api/agent/chat/${runtime.projectId}/runs/${runtime.id}`;
  t.after(async () => { routeHandler.close(); for (const socket of clients) socket.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close((resolve as unknown as ()=>void))); });
  const f = {runtime, routeHandler, responses, server, url, base,
    events(after = 0) { return `${base}/events?instanceId=${runtime.instanceId}&after=${after}`; },
    async paused() {
      const socket = net.createConnection({host: '127.0.0.1', port: (server.address() as import('node:net').AddressInfo)!.port, highWaterMark: 1024} as unknown as net.NetConnectOpts); clients.add(socket);
      socket.on('error', () => {}); await once(socket, 'connect'); socket.pause();
      const index = responses.length;
      socket.write(`GET ${this.events()} HTTP/1.1\r\nHost: 127.0.0.1:${(server.address() as import('node:net').AddressInfo)!.port}\r\nConnection: close\r\n\r\n`);
      await until(() => responses.length > index, 'raw SSE request accepted');
      return {socket, res: responses[index]};
    },
  };
  const sent = await fetch(`${url}/api/agent/chat/${runtime.projectId}/runs`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal(sent.status, 200); await sent.json(); return f;
}
async function until<T>(predicate: ()=>T, label?: string|Error|undefined): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, label); await turn(); }
}
async function saturate(f: Awaited<ReturnType<typeof fixture>>, res: ObservedResponse) {
  // Actually fill the loopback socket while the raw reader is paused. Yielding
  // lets healthy writes drain; this does not simulate write(false) or length.
  for (let i = 0; i < 4096; i++) {
    f.runtime.publish(delta(0, 'x'.repeat(16 * 1024))); await turn();
    if (res.writableNeedDrain) { await turn(); if (res.writableNeedDrain) return; }
    assert.equal(res.destroyed, false, 'socket should block before reaching the ordinary cap');
  }
  assert.fail('Paused loopback receiver never applied backpressure');
}

test('real paused socket crosses the inclusive queue cap locally and cursor reconnect never re-infers', {timeout: 10000}, async t => {
  const f = await fixture(t), {res} = await f.paused(); await saturate(f, res);
  const written = (res as ObservedResponse).sentFrames.length;
  for (let i = 0; i < 32 && !res.destroyed; i++) f.runtime.publish(delta(0, 'y'.repeat(16 * 1024)));
  assert.equal(res.destroyed, true); assert.equal((res as ObservedResponse).sentFrames.length, written, 'no further writes after write(false)');
  assert.ok((res as ObservedResponse).maxPending <= CHAT_SSE_LIMITS.maxBufferedBytes); await until(() => res.closed, 'overflow response closes');
  assert.equal(f.runtime.subscribers.size, 0); clean(res);
  const committed = f.runtime.publish(terminal());
  const text = await (await fetch(f.url + f.events(committed.id - 1))).text();
  assert.equal(text, frame(committed)); assert.equal(f.runtime.inferenceCalls, 1); assert.equal(f.runtime.stopCalls, 0);
});

test('real paused terminal keeps a transport slot after runtime detach and shutdown destroys the pending socket', {timeout: 10000}, async t => {
  const f = await fixture(t, {clients: 1}), {res} = await f.paused(); await saturate(f, res);
  f.runtime.publish(terminal()); assert.equal(f.runtime.subscribers.size, 0); assert.equal(res.writableFinished, false);
  const busy = await fetch(f.url + f.events()); assert.equal(busy.status, 429);
  assert.equal((await busy.json()).error.code, 'AGENT_CHAT_BUSY'); assert.equal(f.runtime.subscriptions, 1);
  f.routeHandler.close(); await until(() => res.closed, 'shutdown closes terminal backpressure'); clean(res);
  const replay = await fetch(f.url + f.events()); assert.equal(replay.status, 200); assert.match(await replay.text(), /event: terminal/);
  assert.equal(f.runtime.inferenceCalls, 1); assert.equal(f.runtime.stopCalls, 0);
});

test('real asynchronous response error and reader disconnect detach without business cancellation', async t => {
  const f = await fixture(t), first = await f.paused();
  const closed = new Promise(resolve => first.res.once('close', resolve));
  setImmediate(() => first.res.emit('error', new Error('synthetic asynchronous response fault')));
  await closed; assert.equal(f.runtime.subscribers.size, 0); clean(first.res);
  const second = await f.paused(); second.socket.destroy(); await until(() => second.res.closed, 'reader disconnect cleanup');
  assert.equal(f.runtime.subscribers.size, 0); clean(second.res);
  f.runtime.publish(terminal()); assert.match(await (await fetch(f.url + f.events())).text(), /event: terminal/);
  assert.equal(f.runtime.inferenceCalls, 1); assert.equal(f.runtime.stopCalls, 0);
});

test('real paused socket stall deadline destroys transport even without another model event', {timeout: 10000}, async t => {
  // Socket acceptance and kernel saturation have no 50ms wall-clock guarantee.
  // Freeze timer progression until a real paused receiver causes lasting
  // write(false). Network I/O, writableLength, drain and close remain real.
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const f = await fixture(t, {stallTimeoutMs: 50, heartbeatMs: 5}), {res} = await f.paused(); await saturate(f, res);
  assert.equal(res.writableNeedDrain, true, 'actual socket backpressure is a required precondition');
  assert.equal(res.destroyed, false); assert.equal(res.closed, false);
  assert.ok(res.writableLength > 0); assert.ok((res as ObservedResponse).maxPending <= CHAT_SSE_LIMITS.maxBufferedBytes);
  const written = (res as ObservedResponse).sentFrames.length;
  t.mock.timers.tick(49);
  assert.equal(res.destroyed, false, 'stall deadline must not fire early');
  assert.equal((res as ObservedResponse).sentFrames.length, written, 'heartbeats cannot enlarge or refresh the blocked backlog');
  t.mock.timers.tick(1);
  assert.equal(res.destroyed, true, 'the 50ms transport deadline destroys without another model event');
  await until(() => res.closed, 'actual destroyed socket close and listener cleanup');
  assert.equal((res as ObservedResponse).sentFrames.length, written, 'no writes after deadline');
  assert.equal(f.runtime.subscribers.size, 0); assert.equal(f.runtime.inferenceCalls, 1); assert.equal(f.runtime.stopCalls, 0); clean(res);
});

test('real HTTP preserves maximal JSON-escaped legal snapshot using one bounded frame allowance', async t => {
  const f = await fixture(t);
  const assistantText = '\u0000'.repeat(CHAT_LIMITS.responseBytes), userText = '\t'.repeat(CHAT_LIMITS.messageBytes);
  const saved = f.runtime.publish({type: 'terminal', run: {status: 'completed', assistantText, userText}});
  assert.ok(Buffer.byteLength(frame(saved)) > CHAT_SSE_LIMITS.maxBufferedBytes);
  assert.ok(Buffer.byteLength(frame(saved)) < CHAT_SSE_LIMITS.maxFrameBytes);
  const response = await fetch(f.url + f.events()); assert.equal(response.status, 200);
  assert.equal(await response.text(), frame(saved)); assert.equal(f.runtime.subscribers.size, 0);
  assert.equal(f.runtime.inferenceCalls, 1); assert.equal(f.runtime.stopCalls, 0);
});

test('real pre-header runtime validation and subscriber errors preserve JSON status without leaking a transport slot', async t => {
  const f = await fixture(t, {clients: 1});
  for (const [code, status] of [['AGENT_CHAT_SESSION_EXPIRED', 409], ['AGENT_CHAT_BUSY', 429]] as const) {
    (f.runtime as typeof f.runtime&{subscriptionError?:Error}).subscriptionError = chatRuntimeError(code);
    const response = await fetch(f.url + f.events()); assert.equal(response.status, status);
    assert.match(response.headers.get('content-type')!, /application\/json/); assert.equal((await response.json()).error.code, code);
  }
  (f.runtime as typeof f.runtime&{subscriptionError?:Error}).subscriptionError = undefined; f.runtime.publish(terminal());
  const response = await fetch(f.url + f.events()); assert.equal(response.status, 200); assert.match(await response.text(), /event: terminal/);
  assert.equal(f.runtime.inferenceCalls, 1); assert.equal(f.runtime.stopCalls, 0);
});
