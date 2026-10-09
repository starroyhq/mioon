import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAgentSse} from '../packages/business/src/agent/sse.mjs';
const collect = async (source, options) => { const result = []; for await (const event of parseAgentSse(source, options)) result.push(event); return result; };
const bytes = text => [Buffer.from(text)];

test('SSE decodes every byte boundary of UTF-8, CRLF, BOM, multiline data and keepalives', async () => {
  const wire = Buffer.from('\ufeff: ping\r\nevent: message\r\ndata: 你好🙂\r\ndata: second\r\n\r\nid: ignored\nretry: 10\n\ndata: [DONE]\r\r');
  const expected = [{event: 'message', data: '你好🙂\nsecond'}, {event: 'message', data: '[DONE]'}];
  assert.deepEqual(await collect([...wire].map(byte => Buffer.from([byte]))), expected);
  for (let i = 0; i <= wire.length; i++) assert.deepEqual(await collect([wire.subarray(0, i), wire.subarray(i)]), expected, `split ${i}`);
});

test('SSE emits error events and empty data while ignoring comment/unknown-only frames', async () => {
  assert.deepEqual(await collect(bytes(':keepalive\n\nunknown: value\n\ndata:\n\nevent: error\ndata: {}\n\n')), [{event: 'message', data: ''}, {event: 'error', data: '{}'}]);
});

test('SSE rejects invalid UTF-8, incomplete data frame and non-byte input without raw content', async () => {
  await assert.rejects(collect([Buffer.from([0xc3, 0x28])]), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
  await assert.rejects(collect([Buffer.from([0xf0, 0x9f])]), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
  for (const wire of ['data: synthetic-private-marker', 'data: {}\n', 'event: message']) await assert.rejects(collect(bytes(wire)), {code: 'AGENT_CHAT_TRUNCATED'});
  await assert.rejects(collect(['data: x\n\n']), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
  assert.deepEqual(await collect(bytes(': trailing comment')), []);
});

test('SSE bounds raw bytes, event/line bytes and number of events including fragmented lines', async () => {
  await assert.rejects(collect(bytes(':1234567890\n'), {maxBytes: 8}), {code: 'AGENT_CHAT_LIMIT'});
  await assert.rejects(collect(bytes('data: 你好\n\n'), {maxEventBytes: 10}), {code: 'AGENT_CHAT_LIMIT'});
  await assert.rejects(collect(Array.from({length: 20}, () => Buffer.from('x')), {maxEventBytes: 10}), {code: 'AGENT_CHAT_LIMIT'});
  await assert.rejects(collect(bytes('data: a\n\ndata: b\n\n'), {maxEvents: 1}), {code: 'AGENT_CHAT_LIMIT'});
});

test('SSE closes the source iterator on early return and rejects an already-aborted signal', async () => {
  let closed = false;
  async function* source() { try { yield Buffer.from('data: 1\n\ndata: 2\n\n'); } finally { closed = true; } }
  for await (const _event of parseAgentSse(source())) break;
  assert.equal(closed, true);
  const controller = new AbortController(); controller.abort('synthetic-private-marker');
  await assert.rejects(collect(bytes('data: x\n\n'), {signal: controller.signal}), error => error.code === 'AGENT_CHAT_ABORTED' && !error.message.includes('synthetic'));
});

test('optional event-name metadata distinguishes data-only framing from explicit message or empty names',async()=>{
  const source=(async function*(){yield Buffer.from('data: one\n\nevent: message\ndata: two\n\nevent:\ndata: three\n\nevent: response.created\ndata: four\n\n');})();
  const events=[];for await(const event of parseAgentSse(source,{includeEventName:true}))events.push(event);
  assert.deepEqual(events,[{event:'message',eventName:null,data:'one'},{event:'message',eventName:'message',data:'two'},{event:'message',eventName:'',data:'three'},{event:'response.created',eventName:'response.created',data:'four'}]);
});
