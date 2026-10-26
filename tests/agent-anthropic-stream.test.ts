import test from 'node:test';
import assert from 'node:assert/strict';
import {streamAnthropicMessages} from '../packages/business/src/agent/anthropic-stream.ts';
import type {AnthropicStreamItem} from '../packages/business/src/agent/anthropic-stream.ts';
import {nativeAnthropicEvents, nativeAnthropicSse} from './helpers/anthropic-native-events.ts';
import type {AnthropicNativeStreamEvent} from '../packages/business/src/agent/anthropic-sdk-transport.ts';

const options = {maxOutputBytes: 128 * 1024, maxArgumentBytes: 32 * 1024, maxToolCalls: 30};
const event = (type: string, value: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
const start = () => event('message_start', {message: {id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 7, output_tokens: 1}}});
const block = (index: number, value: Record<string, unknown>) => event('content_block_start', {index, content_block: value});
const delta = (index: number, value: Record<string, unknown>) => event('content_block_delta', {index, delta: value});
const close = (index: number) => event('content_block_stop', {index});
const finish = (reason = 'end_turn', output = 4) => event('message_delta', {delta: {stop_reason: reason, stop_sequence: null}, usage: {output_tokens: output}}) + event('message_stop');
async function* bytes(source: string, fragmented = false) {
  const value = Buffer.from(source);
  if (fragmented) {for (const byte of value) yield Buffer.from([byte]);}
  else yield value;
}
async function collect(source: string, patch: Partial<typeof options> = {}, fragmented = false) {
  const result: AnthropicStreamItem[] = [];
  for await (const item of streamAnthropicMessages(bytes(source, fragmented), {...options, ...patch})) result.push(item);
  return result;
}
const textBody = () => start() + block(0, {type: 'text', text: ''}) + delta(0, {type: 'text_delta', text: '你好 🙂'}) + close(0) + finish();
const toolBody = (argumentsJson = '{"projectId":"p"}', reason = 'tool_use') => start() + block(0, {type: 'tool_use', id: 'tool_one', name: 'project_inspect', input: {}}) + delta(0, {type: 'input_json_delta', partial_json: argumentsJson}) + close(0) + finish(reason);

test('native Messages framing preserves fragmented multilingual text and safe token usage', async () => {
  assert.deepEqual(await collect(': keepalive\r\n\r\n' + textBody(), {}, true), [
    {type: 'delta', text: '你好 🙂'},
    {type: 'done', completion: {text: '你好 🙂', content: [{type: 'text', text: '你好 🙂'}], toolCalls: [], stopReason: 'end_turn', usage: {prompt_tokens: 7, completion_tokens: 4, total_tokens: 11}}},
  ]);
});

test('interleaved text/tool indices seal all arguments before exposing one ordered completion', async () => {
  const source = start() + block(0, {type: 'text', text: '先读'}) + block(1, {type: 'tool_use', id: 'tool_one', name: 'first', input: {}}) +
    block(2, {type: 'tool_use', id: 'tool_two', name: 'second', input: {}}) + delta(1, {type: 'input_json_delta', partial_json: '{"a":'}) +
    delta(2, {type: 'input_json_delta', partial_json: '{"b":2}'}) + close(2) + delta(0, {type: 'text_delta', text: '资料'}) + close(0) +
    delta(1, {type: 'input_json_delta', partial_json: '1}'}) + close(1) + finish('tool_use');
  const items = await collect(source), done = items.at(-1)!;
  assert.equal(done.type, 'done');
  if (done.type !== 'done') assert.fail('terminal completion required');
  assert.deepEqual(done.completion.toolCalls, [{id: 'tool_one', name: 'first', argumentsJson: '{"a":1}'}, {id: 'tool_two', name: 'second', argumentsJson: '{"b":2}'}]);
  assert.deepEqual(done.completion.content, [{type: 'text', text: '先读资料'}, {type: 'tool_use', id: 'tool_one', name: 'first', input: {a: 1}}, {type: 'tool_use', id: 'tool_two', name: 'second', input: {b: 2}}]);
});

test('native initial tool input stays semantic and cannot be overwritten by a later JSON delta', async () => {
  const source = start() + block(0, {type: 'tool_use', id: 'tool_one', name: 'first', input: {a: 1}});
  const done = (await collect(source + close(0) + finish('tool_use'))).at(-1)!;
  assert.equal(done.type, 'done'); if (done.type !== 'done') assert.fail();
  assert.deepEqual(done.completion.toolCalls, [{id: 'tool_one', name: 'first', argumentsJson: '{"a":1}'}]);
  assert.deepEqual(done.completion.content, [{type: 'tool_use', id: 'tool_one', name: 'first', input: {a: 1}}]);
  await assert.rejects(collect(source + delta(0, {type: 'input_json_delta', partial_json: '{"a":2}'}) + close(0) + finish('tool_use')), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
});

test('a tool is never handed off at block close or message_stop before clean EOF', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve;});
  async function* source() {yield Buffer.from(toolBody()); await pending;}
  const iterator = streamAnthropicMessages(source(), options);
  let settled = false;
  const first = iterator.next().then(value => {settled = true; return value;});
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false); release();
  assert.equal((await first).value?.type, 'done');
  assert.equal((await iterator.next()).done, true);
});

test('truncated or unframed streams do not turn partial tool arguments into executable output', async () => {
  for (const source of [toolBody().replace(event('message_stop'), ''), toolBody().replace(/\n\n$/u, '\n'), start() + block(0, {type: 'tool_use', id: 't', name: 'read', input: {}}) + delta(0, {type: 'input_json_delta', partial_json: '{"a":'})]) {
    const delivered: AnthropicStreamItem[] = [];
    await assert.rejects(async () => {for await (const item of streamAnthropicMessages(bytes(source), options)) delivered.push(item);}, {code: 'AGENT_CHAT_TRUNCATED'});
    assert.equal(delivered.some(item => item.type === 'done'), false);
  }
});

test('duplicate keys, incomplete/deep parameters and duplicate envelope keys are rejected', async () => {
  for (const args of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":', '[]', '{"a":' + '['.repeat(34) + '0' + ']'.repeat(34) + '}']) await assert.rejects(collect(toolBody(args)), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
  await assert.rejects(collect(toolBody().replace('"type":"message_start"', '"type":"message_start","type":"message_start"')), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
});

test('wrong indices, repeated IDs, duplicate terminal and post-terminal data fail closed', async () => {
  const variants = [
    start() + block(1, {type: 'text', text: ''}) + finish(),
    start() + delta(0, {type: 'text_delta', text: 'x'}) + finish(),
    start() + block(0, {type: 'text', text: ''}) + close(0) + close(0) + finish(),
    start() + block(0, {type: 'text', text: ''}) + finish(),
    start() + block(0, {type: 'tool_use', id: 'same', name: 'one', input: {}}) + close(0) + block(1, {type: 'tool_use', id: 'same', name: 'two', input: {}}) + close(1) + finish('tool_use'),
    toolBody() + event('message_stop'), toolBody() + event('ping'), textBody() + delta(0, {type: 'text_delta', text: 'late'}),
    textBody().replace('event: message_start', 'event: message_delta'), textBody().replace('event: message_start\n', ''),
    toolBody('{}', 'end_turn'), textBody().replace('"stop_reason":"end_turn"', '"stop_reason":"tool_use"'),
  ];
  for (const source of variants) await assert.rejects(collect(source), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
});

test('thought/server-tool blocks and provider errors never become text or allowed tools', async () => {
  for (const type of ['thinking', 'redacted_thinking']) await assert.rejects(collect(start() + block(0, {type})), {code: 'AGENT_CHAT_REASONING_UNSUPPORTED'});
  for (const type of ['server_tool_use', 'web_search_tool_result', 'image']) await assert.rejects(collect(start() + block(0, {type})), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  await assert.rejects(collect(event('error', {error: {message: 'synthetic-private-marker'}})), error => error instanceof Error && 'code' in error && error.code === 'AGENT_CHAT_PROVIDER_ERROR' && !error.message.includes('marker'));
});

test('usage is bounded/monotonic, including cached input, without retaining provider metadata', async () => {
  const cached = textBody().replace('"input_tokens":7', '"input_tokens":7,"cache_creation_input_tokens":2,"cache_read_input_tokens":3').replace('"output_tokens":4', '"input_tokens":7,"output_tokens":4');
  const last = (await collect(cached)).at(-1)!;
  assert.equal(last.type, 'done'); if (last.type !== 'done') assert.fail();
  assert.deepEqual(last.completion.usage, {prompt_tokens: 12, completion_tokens: 4, total_tokens: 16});
  for (const source of [textBody().replace('"output_tokens":4', '"output_tokens":0'), textBody().replace('"input_tokens":7', '"input_tokens":-1'), textBody().replace('"output_tokens":4', '"output_tokens":"4"')]) await assert.rejects(collect(source), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
});

test('text, arguments, tool count and cancellation honor the supplied host caps', async () => {
  await assert.rejects(collect(textBody(), {maxOutputBytes: 1}), {code: 'AGENT_CHAT_LIMIT'});
  await assert.rejects(collect(toolBody(), {maxArgumentBytes: 1}), {code: 'AGENT_CHAT_LIMIT'});
  await assert.rejects(collect(toolBody(), {maxToolCalls: 0}), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(async () => {for await (const _item of streamAnthropicMessages(bytes(textBody()), {...options, signal: controller.signal})) {}}, {code: 'AGENT_CHAT_ABORTED'});
  await assert.rejects(collect(toolBody('{"a":', 'max_tokens')), {code: 'AGENT_CHAT_TRUNCATED'});
});

test('SDK-typed native metadata and direct callers are accepted and stripped from retained output', async () => {
  const textEvents = nativeAnthropicEvents();
  const textDone = (await collect(nativeAnthropicSse(textEvents))).at(-1)!;
  assert.equal(textDone.type, 'done'); if (textDone.type !== 'done') assert.fail();
  assert.deepEqual(textDone.completion.content, [{type: 'text', text: '你好，Mio 🙂'}]);
  assert.deepEqual(textDone.completion.usage, {prompt_tokens: 3, completion_tokens: 3, total_tokens: 6});
  const toolEvents = nativeAnthropicEvents({toolName: 'read', argumentsJson: '{"a":1}'});
  const toolDone = (await collect(nativeAnthropicSse(toolEvents))).at(-1)!;
  assert.equal(toolDone.type, 'done'); if (toolDone.type !== 'done') assert.fail();
  assert.deepEqual(toolDone.completion.content, [{type: 'tool_use', id: 'tool_native_fixture', name: 'read', input: {a: 1}}]);
  const block = textEvents[1]!;
  assert.equal(block.type, 'content_block_start'); if (block.type !== 'content_block_start' || block.content_block.type !== 'text') assert.fail();
  block.content_block.citations = [];
  assert.equal((await collect(nativeAnthropicSse(textEvents))).at(-1)?.type, 'done');
});

test('SDK cumulative whole-message usage replaces prior counters and treats null as absence', async () => {
  const events = nativeAnthropicEvents(), final = events[4]!;
  assert.equal(final.type, 'message_delta'); if (final.type !== 'message_delta') assert.fail();
  const intermediate: Extract<AnthropicNativeStreamEvent, {type: 'message_delta'}> = {
    ...final, delta: {...final.delta, stop_reason: null}, usage: {...final.usage, input_tokens: 5, cache_creation_input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 2},
  };
  final.usage = {...final.usage, input_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 3};
  events.splice(4, 0, intermediate);
  const done = (await collect(nativeAnthropicSse(events))).at(-1)!;
  assert.equal(done.type, 'done'); if (done.type !== 'done') assert.fail();
  assert.deepEqual(done.completion.usage, {prompt_tokens: 12, completion_tokens: 3, total_tokens: 15});
  final.usage = {...final.usage, input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null};
  const absent = (await collect(nativeAnthropicSse(events))).at(-1)!;
  assert.equal(absent.type, 'done'); if (absent.type !== 'done') assert.fail();
  assert.deepEqual(absent.completion.usage, {prompt_tokens: 8, completion_tokens: 3, total_tokens: 11});
  for (const patch of [{input_tokens: 2}, {input_tokens: -1}, {cache_creation_input_tokens: 0}, {cache_read_input_tokens: 1}, {cache_creation_input_tokens: -1}, {cache_read_input_tokens: -1}, {input_tokens: 10_000_001}, {input_tokens: 10_000_000, cache_read_input_tokens: 1}]) {
    final.usage = {...final.usage, ...patch};
    await assert.rejects(collect(nativeAnthropicSse(events)), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
    final.usage = {...final.usage, input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null};
  }
});

test('MiniMax-like message and start/final usage service tiers share validation and are stripped from output', async () => {
  const tiers = [undefined, null, 'standard', 'priority', 'batch'];
  for (const toolName of [undefined, 'read']) {
    const events = nativeAnthropicEvents({toolName}), start = events[0]!, final = events[4]!;
    assert.equal(start.type, 'message_start'); if (start.type !== 'message_start') assert.fail();
    assert.equal(final.type, 'message_delta'); if (final.type !== 'message_delta') assert.fail();
    const baseline = await collect(nativeAnthropicSse(events));
    for (const messageTier of tiers) for (const usageTier of tiers) {
      const source = event('message_start', {message: {...start.message, service_tier: messageTier,
        usage: {...start.message.usage, service_tier: usageTier}}}) + nativeAnthropicSse(events.slice(1, 4)) +
        event('message_delta', {delta: final.delta, usage: {...final.usage, service_tier: usageTier}}) + nativeAnthropicSse(events.slice(5));
      const actual = await collect(source);
      assert.deepEqual(actual, baseline);
      assert.doesNotMatch(JSON.stringify(actual), /service_tier/u);
    }
  }
});

test('service-tier compatibility rejects invalid tiers and does not admit active metadata', async () => {
  const events = nativeAnthropicEvents(), start = events[0]!, final = events[4]!;
  assert.equal(start.type, 'message_start'); if (start.type !== 'message_start') assert.fail();
  assert.equal(final.type, 'message_delta'); if (final.type !== 'message_delta') assert.fail();
  const source = (messageTier: unknown, usageTier: unknown, extra: Record<string, unknown> = {}, finalTier: unknown = 'standard') => event('message_start', {
    message: {...start.message, service_tier: messageTier, usage: {...start.message.usage, service_tier: usageTier}, ...extra},
  }) + nativeAnthropicSse(events.slice(1, 4)) + event('message_delta', {
    delta: final.delta, usage: {...final.usage, service_tier: finalTier},
  }) + nativeAnthropicSse(events.slice(5));
  for (const invalid of ['', 'unknown', 'STANDARD', 1, false, [], {}]) {
    await assert.rejects(collect(source(invalid, 'standard')), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
    await assert.rejects(collect(source('standard', invalid)), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
    await assert.rejects(collect(source('standard', 'standard', {}, invalid)), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
  }
  for (const extra of [{unknown_activity: true}, {tools: []}, {thinking: {type: 'enabled'}},
    {container: {id: 'private-container'}}, {diagnostics: {active: true}}]) {
    await assert.rejects(collect(source('standard', 'standard', extra)), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
  }
});

test('SDK-typed refusal details complete only a refusal and are never retained', async () => {
  type NativeDelta = Extract<AnthropicNativeStreamEvent, {type: 'message_delta'}>;
  type RefusalDetails = NonNullable<NativeDelta['delta']['stop_details']>;
  const categories: readonly RefusalDetails['category'][] = ['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms', null];
  for (const category of categories) for (const explanation of [null, 'PRIVATE_REFUSAL_REASON 🙂']) {
    const events = nativeAnthropicEvents(), final = events[4]!;
    assert.equal(final.type, 'message_delta'); if (final.type !== 'message_delta') assert.fail();
    const details: RefusalDetails = {type: 'refusal', category, explanation};
    final.delta = {...final.delta, stop_reason: 'refusal', stop_details: details};
    const done = (await collect(nativeAnthropicSse(events))).at(-1)!;
    assert.equal(done.type, 'done'); if (done.type !== 'done') assert.fail();
    assert.equal(done.completion.stopReason, 'refusal');
    assert.deepEqual(done.completion.toolCalls, []);
    assert.doesNotMatch(JSON.stringify(done), /PRIVATE_REFUSAL_REASON|stop_details|explanation/u);
  }
});

test('refusal metadata rejects unknown fields, malformed details and non-refusal stop reasons', async () => {
  const events = nativeAnthropicEvents(), final = events[4]!;
  assert.equal(final.type, 'message_delta'); if (final.type !== 'message_delta') assert.fail();
  const prefix = nativeAnthropicSse(events.slice(0, 4));
  const source = (details: unknown, reason: unknown = 'refusal') => prefix + event('message_delta', {
    delta: {...final.delta, stop_reason: reason, stop_details: details}, usage: final.usage,
  }) + event('message_stop');
  const valid = {type: 'refusal', category: null, explanation: 'PRIVATE_REFUSAL_REASON'};
  for (const details of [[], 'refusal', {}, {type: 'refusal'}, {...valid, type: 'other'}, {...valid, category: 'unknown'},
    {...valid, category: 1}, {...valid, explanation: false}, {...valid, explanation: '\ud800'}, {...valid, extra: true},
    {type: 'refusal', explanation: null}, {type: 'refusal', category: null}]) {
    await assert.rejects(collect(source(details)), error => error instanceof Error && 'code' in error &&
      error.code === 'AGENT_CHAT_PROTOCOL_ERROR' && !error.message.includes('PRIVATE_REFUSAL_REASON'));
  }
  for (const reason of [null, 'end_turn', 'tool_use', 'max_tokens', 'stop_sequence']) {
    await assert.rejects(collect(source(valid, reason)), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
  }
  await assert.rejects(collect(source({...valid, explanation: 'x'.repeat(64 * 1024)})), {code: 'AGENT_CHAT_LIMIT'});
  const start = events[0]!;
  assert.equal(start.type, 'message_start'); if (start.type !== 'message_start') assert.fail();
  start.message.stop_details = {type: 'refusal', category: null, explanation: null};
  await assert.rejects(collect(nativeAnthropicSse(events)), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
});

test('empty metadata support does not admit references, server callers, active containers or extra fields', async () => {
  const text = nativeAnthropicSse(nativeAnthropicEvents());
  const tool = nativeAnthropicSse(nativeAnthropicEvents({toolName: 'read'}));
  const variants = [
    text.replace('"citations":null', '"citations":[{"type":"char_location"}]'),
    text.replace('"citations":null', '"citations":{}'),
    text.replace('"citations":null', '"citations":null,"unknown_activity":true'),
    text.replace('"container":null', '"container":{"id":"private-container"}'),
    text.replace('"diagnostics":null', '"diagnostics":{"cache_miss_reason":null}'),
    text.replace('"stop_details":null', '"stop_details":{"type":"refusal"}'),
    text.replace('"role":"assistant"', '"role":"assistant","unknown_activity":true'),
    text.replace('"container":null,"stop_details":null},"usage"', '"container":{"id":"private-container"},"stop_details":null},"usage"'),
    text.replace('"container":null,"stop_details":null},"usage"', '"container":null,"stop_details":{"type":"refusal"}},"usage"'),
    text.replace('"stop_reason":"end_turn"', '"unknown_activity":true,"stop_reason":"end_turn"'),
    text.replace('"stop_reason":"end_turn","stop_sequence":null', '"stop_reason":null,"stop_sequence":"unrequested-sequence"'),
    text.replace('"input_tokens":null', '"input_tokens":null,"unknown_activity":true'),
    tool.replace('"caller":{"type":"direct"}', '"caller":{"type":"code_execution_20250825","tool_id":"private-tool"}'),
    tool.replace('"caller":{"type":"direct"}', '"caller":{"type":"direct","extra":true}'),
    tool.replace('"toolset_name":null', '"toolset_name":"browser"'),
    text.replace('"server_tool_use":null', '"server_tool_use":{"web_fetch_requests":1,"web_search_requests":0}'),
    text.replace('"output_tokens_details":null', '"output_tokens_details":{"thinking_tokens":1}'),
  ];
  for (const source of variants) await assert.rejects(collect(source));
});
