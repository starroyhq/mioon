type ObservedResponse = http.ServerResponse&{baselineListeners?:Record<string,number>;sentFrames:unknown[];maxPending:number};
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {setImmediate as turn} from 'node:timers/promises';
import {createChatSse, CHAT_SSE_LIMITS} from '../apps/server/src/chat-sse.ts';

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

test('shutdown owns a buffered end() until finish and bounds even a response that never reports backpressure', async () => {
  const f = transport(); f.stream.event(terminal()); assert.equal(f.res.writableEnded, true); assert.equal(f.settled, 0);
  f.stream.close(); await turn(); assert.equal(f.res.destroyed, true); assert.equal(f.detached, 1);
  f.res.close(); clean(f.res); assert.equal(f.settled, 1);
});
