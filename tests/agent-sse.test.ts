import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAgentSse} from '../packages/business/src/agent/sse.ts';
type SseOptions = Parameters<typeof parseAgentSse>[1];
const collect = async (source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>, options?: SseOptions) => { const result: Array<{event: string; data: string}> = []; for await (const event of parseAgentSse(source as AsyncIterable<Uint8Array>, options as never)) result.push(event); return result; };
const bytes = (text: string): Buffer[] => [Buffer.from(text)];

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
  await assert.rejects(collect(bytes('data: x\n\n'), {signal: controller.signal}), (error: unknown) => {const failure=error as {code?: string; message?: string};return failure.code === 'AGENT_CHAT_ABORTED' && !String(failure.message).includes('synthetic');});
});

test('optional event-name metadata distinguishes data-only framing from explicit message or empty names',async()=>{
  const source=(async function*(){yield Buffer.from('data: one\n\nevent: message\ndata: two\n\nevent:\ndata: three\n\nevent: response.created\ndata: four\n\n');})();
  const events: Array<{event: string; eventName: string | null; data: string}> = [];for await(const event of parseAgentSse(source,{includeEventName:true} as never))events.push(event as never);
  assert.deepEqual(events,[{event:'message',eventName:null,data:'one'},{event:'message',eventName:'message',data:'two'},{event:'message',eventName:'',data:'three'},{event:'response.created',eventName:'response.created',data:'four'}]);
});

const q11LifecycleNames=['response.created','response.in_progress','response.completed'];
const q11LifecycleLimits={includeEventName:true,maxBytes:4*1024*1024,eventByteLimits:{...Object.fromEntries(q11LifecycleNames.map(name=>[name,2*1024*1024])),'response.output_text.done':512*1024}};
const q11NamedWire=(event:string,value:string)=>`event: ${event}\r\ndata: ${value}\r\n\r\n`;

test('explicit lifecycle event budgets admit bounded echoed data across fragmented names and UTF-8 framing',async()=>{
  const value=JSON.stringify({instructions:'🙂'.repeat(18*1024),tools:[],output:[]});
  assert.ok(Buffer.byteLength(value)>70*1024);
  for(const name of q11LifecycleNames){
    const wire=Buffer.from(q11NamedWire(name,value)),splits=[0,1,8,name.length+7,name.length+11,wire.length-3,wire.length];
    const chunks=splits.slice(1).map((end,index)=>wire.subarray(splits[index]!,end));
    assert.deepEqual(await collect(chunks,q11LifecycleLimits),[{event:name,eventName:name,data:value}]);
    await assert.rejects(collect([wire]),{code:'AGENT_CHAT_LIMIT'},'The same event keeps the original limit without an explicit opt-in');
  }
});

test('lifecycle allowance never extends unlisted, data-only, late-named or renamed frames',async()=>{
  const large='x'.repeat(70*1024);
  for(const wire of [
    q11NamedWire('response.output_text.delta',large),
    q11NamedWire('response.created.extra',large),
    `data: ${large}\n\nevent: response.created\n\n`,
    `data: ${large}\nevent: response.created\n\n`,
    `event: response.created\ndata: ${large}\nevent: response.output_text.delta\n\n`,
    `event: response.created\ndata: ${large}\nevent:\n\n`,
    q11NamedWire('response.created','small')+`data: ${large}\n\n`,
    q11NamedWire('response.created','small')+q11NamedWire('message',large),
  ])await assert.rejects(collect(bytes(wire),q11LifecycleLimits),{code:'AGENT_CHAT_LIMIT'});
});

test('lifecycle event bytes, raw stream bytes and event count remain separately bounded',async()=>{
  await assert.rejects(collect(bytes(q11NamedWire('response.created','x'.repeat(2*1024*1024))),q11LifecycleLimits),{code:'AGENT_CHAT_LIMIT'});
  const frame=q11NamedWire('response.created','x'.repeat(1500*1024));
  assert.ok(Buffer.byteLength(frame)<2*1024*1024);
  await assert.rejects(collect(bytes(frame.repeat(3)),q11LifecycleLimits),{code:'AGENT_CHAT_LIMIT'});
  const done=q11NamedWire('response.output_text.done','x'.repeat(70*1024));
  assert.equal((await collect(bytes(done),q11LifecycleLimits)).length,1);
  await assert.rejects(collect(bytes(q11NamedWire('response.output_text.done','x'.repeat(512*1024))),q11LifecycleLimits),{code:'AGENT_CHAT_LIMIT'});
  await assert.rejects(collect(bytes(q11NamedWire('response.created','x'.repeat(1500*1024))),{maxEventBytes:2*1024*1024}),{code:'AGENT_CHAT_LIMIT'},'The default raw stream budget remains 1 MiB even when its per-event ceiling is explicitly larger');
  await assert.rejects(collect(bytes(q11NamedWire('response.created','{}').repeat(8193)),q11LifecycleLimits),{code:'AGENT_CHAT_LIMIT'});
  const short={...q11LifecycleLimits,maxEvents:1};
  await assert.rejects(collect(bytes(q11NamedWire('response.created','{}')+q11NamedWire('response.completed','{}')),short),{code:'AGENT_CHAT_LIMIT'});
});
