import type {ProviderEvent} from './helpers/strict-agent-workspace-types.ts';
import type {ProviderItem, HttpCapture, MockRequestState, MockRequest, MockIncoming} from './helpers/strict-agent-workspace-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {CHAT_SYSTEM_INSTRUCTION} from '../packages/business/src/agent/chat-policy.ts';
import {READ_TOOL_DEFINITIONS, READ_TOOL_LIMITS, READ_TOOL_SYSTEM_INSTRUCTION} from '../packages/business/src/agent/read-tool-policy.ts';
import {AGENT_READ_TOOL_PROFILES} from '../packages/business/src/agent/tool-wire.ts';
import {buildAgentRequest, createAgentGateway, validateAgentGatewayConfiguration, type AgentStreamItem} from '../packages/business/src/agent/agent-gateway.ts';
import {buildAgentChatRequest} from '../packages/business/src/agent/chat-completions.ts';
import {buildAgentResponsesRequest} from '../packages/business/src/agent/responses.ts';
import type { ServerResponse,IncomingMessage } from 'http';

const messages = [{role: 'system' as const, content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user' as const, content: 'Inspect one page of saved metadata.'}];
const name = 'mioon_asset_inspect', args = '{"limit":2,"cursor":null}', callId = 'call_fixture', itemId = 'fc_separate_id';
const frame = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const chunk = (delta: import('./helpers/strict-agent-workspace-types.ts').ProviderDelta = {}, finish_reason: string|null = null): ProviderEvent => ({choices: [{index: 0, delta, finish_reason}]});
function ccEvents({name: toolName = name, argumentsJson = args} = {}): ProviderEvent[] {
  return [chunk({role: 'assistant' as const}), chunk({tool_calls: [{index: 0, id: callId, type: 'function', function: {name: toolName, arguments: argumentsJson.slice(0, 8)}}]}),
    chunk({tool_calls: [{index: 0, function: {arguments: argumentsJson.slice(8)}}]}), chunk({}, 'tool_calls')];
}
const ccWire = (events: ProviderEvent[]) => events.map(frame).join('') + frame('[DONE]');
const textPart = (text: string) => ({type: 'output_text', text, annotations: []});
const messageItem = (id: string, text: string|null, status: string) => ({id, type: 'message', role: 'assistant' as const, status, content: text === null ? [] : [textPart(text)]});
const functionItem = (argumentsJson: string, status?: string|undefined, toolName = name) => ({id: itemId, type: 'function_call', call_id: callId, name: toolName, arguments: argumentsJson, ...(status ? {status} : {})});
const response = (output: ProviderItem[] = [], status = 'in_progress'): import('./helpers/strict-agent-workspace-types.ts').ProviderResponse => ({id: 'resp_fixture', object: 'response', status, output, error: null, incomplete_details: null});
function responseEvents({name: toolName = name, argumentsJson = args, text = null, statuses = true}: {name?: string;argumentsJson?: string;text?: string|null;statuses?: boolean} = {}): ProviderEvent[] {
  const events: ProviderEvent[] = [{type: 'response.created', response: response()}, {type: 'response.in_progress', response: response()}], output: ProviderItem[] = [];
  if (text !== null) {
    const key = {output_index: 0, item_id: 'msg_before_call', content_index: 0};
    events.push({type: 'response.output_item.added', output_index: 0, item: messageItem(key.item_id, null, 'in_progress')},
      {type: 'response.content_part.added', ...key, part: textPart('')}, {type: 'response.output_text.delta', ...key, delta: text},
      {type: 'response.output_text.done', ...key, text}, {type: 'response.content_part.done', ...key, part: textPart(text)},
      {type: 'response.output_item.done', output_index: 0, item: messageItem(key.item_id, text, 'completed')});
    output.push(messageItem(key.item_id, text, 'completed'));
  }
  const output_index = output.length, key = {output_index, item_id: itemId};
  events.push({type: 'response.output_item.added', output_index, item: functionItem('', statuses ? 'in_progress' : undefined, toolName)},
    {type: 'response.function_call_arguments.delta', ...key, delta: argumentsJson.slice(0, 8)},
    {type: 'response.function_call_arguments.delta', ...key, delta: argumentsJson.slice(8)},
    {type: 'response.function_call_arguments.done', ...key, arguments: argumentsJson},
    {type: 'response.output_item.done', output_index, item: functionItem(argumentsJson, statuses ? 'completed' : undefined, toolName)});
  output.push(functionItem(argumentsJson, statuses ? 'completed' : undefined, toolName));
  events.push({type: 'response.completed', response: response(output, 'completed')});
  return events.map((event, sequence_number) => ({...structuredClone(event), sequence_number}));
}
function textResponseEvents(text = 'Saved metadata inspected.'): ProviderEvent[] {
  const events = responseEvents({text}), toolStart = events.findIndex(event => event.item?.type === 'function_call');
  return [...events.slice(0, toolStart), {...events.at(-1), response: response([messageItem('msg_before_call', text, 'completed')], 'completed')}];
}
const responsesWire = (events: ProviderEvent[], named = true) => events.map((value) => `${named ? `event: ${value.type}\n` : ''}data: ${JSON.stringify(value)}\n\n`).join('');
const wire = (protocol: import('../packages/contracts/src/agent-protocol.ts').AgentProtocol, events?: ProviderEvent[]) => protocol === 'responses' ? responsesWire(events || responseEvents()) : ccWire(events || ccEvents());
async function collect(iterator: AsyncGenerator<AgentStreamItem,void,undefined>) { const events = []; for await (const event of iterator) events.push(event); return events; }
async function fixture(t: test.TestContext, protocol: import('../packages/contracts/src/agent-protocol.ts').AgentProtocol, handler: (response: import('node:http').ServerResponse,call: HttpCapture,calls: HttpCapture[])=>unknown, dependencies = {}) {
  const calls: HttpCapture[] = [];
  const server = createServer(async (request, response) => {
    const buffers = []; for await (const buffer of request) buffers.push(buffer);
    calls.push({path: request.url, body: JSON.parse((Buffer.concat(buffers).toString() as string)), headers: request.headers});
    response.writeHead(200, {'Content-Type': 'text/event-stream'});
    await handler(response, calls.at(-1)!, calls);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close((resolve as unknown as ()=>void))); });
  const configuration = {protocol, presetId: 'ollama', platformId: 'local', baseUrl: `http://127.0.0.1:${(server.address() as unknown as import('node:net').AddressInfo).port}/v1`, model: 'qwen3:8b'};
  return {calls, configuration, run: (readTools = {phase: 'request'}, extra = {}) => createAgentGateway(dependencies)({configuration, messages, readTools, selfPort: 1, ...extra})};
}
function remoteFixture(source: string|Uint8Array) {
  const state = ({calls: 0} as unknown as MockRequestState);
  state.request = (options, callback) => {
    state.calls++; state.options = (options as unknown as MockRequestState['options']);
    const request = (new EventEmitter() as unknown as MockRequest); request.setTimeout = () => {}; request.destroy = () => {};
    request.end = (body: string) => { state.body = JSON.parse((body as string)); const incoming = (Readable.from([Buffer.from(source)]) as unknown as MockIncoming); incoming.statusCode = 200; incoming.headers = {'content-type': 'text/event-stream'}; callback(incoming); };
    queueMicrotask(() => { const socket = new EventEmitter(); Object.assign(socket, {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}}); request.emit('socket', socket); socket.emit('secureConnect'); });
    return request;
  };
  return state;
}
function profileConfiguration(protocol: import('../packages/contracts/src/agent-protocol.ts').AgentProtocol, presetId: string) {
  const platform = AGENT_PRESETS.find(preset => preset.id === presetId)!.platforms[0];
  return {protocol, presetId, platformId: platform.id, baseUrl: platform.baseUrl || 'https://fixture.example.com/v1',
    model: protocol === 'responses' && presetId === 'qwen' ? 'qwen3.8-flash' : platform.model || 'fixture-custom-model'};
}
function answerMode(done: import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone): import('./helpers/strict-agent-workspace-types.ts').ProtocolMode { return {phase: 'answer', toolCall: done.toolCall!, providerOutput: (done.providerOutput as import('./helpers/strict-agent-workspace-types.ts').ProtocolMode['providerOutput']), result: '{"untrusted":true,"items":[],"complete":true}'}; }

for (const protocol of ['chat_completions', 'responses'] as const) {
  test(`${protocol}: actual HTTP request/answer continuation is bounded, stateless and has no third round`, async t => {
    const service = await fixture(t, protocol, (response, _call, calls) => response.end(calls.length === 1 ? wire(protocol) : protocol === 'responses' ? responsesWire(textResponseEvents()) : ccWire([chunk({content: 'Saved metadata inspected.'}), chunk({}, 'stop')])));
    const first = await collect(service.run()), done = first.at(-1);
    assert.equal((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).finishReason, 'tool_calls'); assert.equal((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.id, callId); assert.equal((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.name, name); assert.deepEqual((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.arguments, {limit: 2, cursor: null}); assert.equal((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.argumentsJson, args);
    assert.equal(service.calls.length, 1); assert.equal(service.calls[0].body.tools.length, 4);
    const answer = answerMode((done! as unknown as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone)), second = await collect(service.run(answer));
    assert.deepEqual(second, [{type: 'delta', text: 'Saved metadata inspected.'}, {type: 'done', finishReason: 'stop'}]);
    assert.equal(service.calls.length, 2); assert.equal(service.calls[0].path, `/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
    const body = service.calls[1].body;
    assert.deepEqual(body.tools, []); assert.equal(body.previous_response_id, undefined); assert.equal(body.conversation, undefined);
    assert.equal(JSON.stringify(body).includes('synthetic-key'), false);
    if (protocol === 'responses') {
      assert.equal((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.itemId, itemId); assert.notEqual(itemId, callId); assert.equal(body.store, false); assert.equal(body.instructions, READ_TOOL_SYSTEM_INSTRUCTION);
      assert.deepEqual(body.input.slice(-2), [((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).providerOutput as import('./helpers/strict-agent-workspace-types.ts').WireItem[])[0], {type: 'function_call_output', call_id: callId, output: answer.result}]);
      assert.equal(body.tool_choice, undefined);
    } else {
      assert.equal((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.itemId, undefined); assert.equal(body.messages[0].content, READ_TOOL_SYSTEM_INSTRUCTION); assert.equal(body.tool_choice, undefined);
      assert.deepEqual(body.messages.slice(-2), [(done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).providerOutput, {role: 'tool' as const, tool_call_id: callId, content: answer.result}]);
    }
  });
  test(`${protocol}: fragmented UTF-8 and argument chunks emit a tool only after complete transport`, async t => {
    let end; const ended = new Promise(resolve => { end = resolve; });
    const service = await fixture(t, protocol, async (response) => { for (const byte of Buffer.from(wire(protocol, protocol === 'responses' ? responseEvents({argumentsJson: '{"limit":2,"cursor":"测试🙂"}'}) : ccEvents({argumentsJson: '{"limit":2,"cursor":"测试🙂"}'})!))) response.write(Buffer.from([byte])); await ended; response.end(); });
    const events: AgentStreamItem[] = []; const pending = (async () => { for await (const event of service.run()) events.push(event); })();
    await delay(25); assert.equal(events.some(event => (event as unknown as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall), false); end!(); await pending;
    assert.equal((events.at(-1) as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.arguments.cursor, '测试🙂'); assert.equal(service.calls.length, 1);
  });
  test(`${protocol}: tool calls in the answer phase never request a third round`, async t => {
    const service = await fixture(t, protocol, (response) => response.end(wire(protocol)));
    const done = (await collect(service.run())).at(-1), events: AgentStreamItem[] = [];
    await assert.rejects(async () => { for await (const event of service.run(answerMode((done! as unknown as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone)))) events.push(event); }, {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
    assert.equal(events.some(event => (event as unknown as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall), false); assert.equal(service.calls.length, 2);
  });
  test(`${protocol}: Stop before dispatch and during complete-but-unclosed tools closes without execution`, async t => {
    let closed = false;
    const service = await fixture(t, protocol, (response) => { response.on('close', () => { closed = true; }); response.write(wire(protocol)); });
    const controller = new AbortController(), events: AgentStreamItem[] = [];
    const pending = (async () => { for await (const event of service.run({phase: 'request'}, {signal: controller.signal})) events.push(event); })();
    await delay(25); controller.abort(); await assert.rejects(pending, {code: 'AGENT_CHAT_ABORTED'}); await delay(10);
    assert.equal(closed, true); assert.equal(events.some(event => (event as unknown as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall), false); assert.equal(service.calls.length, 1);
    await assert.rejects(collect(service.run({phase: 'request'}, {signal: controller.signal})), {code: 'AGENT_CHAT_ABORTED'}); assert.equal(service.calls.length, 1);
  });
  test(`${protocol}: final text with no tool remains an ordinary completed answer`, async t => {
    const source = protocol === 'responses' ? responsesWire(textResponseEvents('No read needed.')) : ccWire([chunk({content: 'No read needed.'}), chunk({}, 'stop')]);
    const service = await fixture(t, protocol, (response) => response.end(source));
    assert.deepEqual(await collect(service.run()), [{type: 'delta', text: 'No read needed.'}, {type: 'done', finishReason: 'stop'}]); assert.equal(service.calls.length, 1);
  });
}

const expectedProfiles = {
  chat_completions: {openai: [true, true, true], deepseek: [false, true, false], qwen: [true, true, false], zhipu: [false, false, false], kimi: [false, true, false], minimax: [false, false, false], openrouter: [true, true, true], custom: [true, true, true], ollama: [false, false, false]},
  responses: {openai: [true, true, true], deepseek: [false, true, false], qwen: [false, true, false], custom: [true, true, true], ollama: [false, false, false]},
};
for (const [protocol, profiles] of Object.entries(expectedProfiles) as [keyof typeof expectedProfiles, Record<string,boolean[]>][]) for (const [presetId, [parallel, choice, strict]] of Object.entries(profiles)) {
  test(`${protocol}/${presetId}: exact tool profile fields and call grammar are fixture-tested only`, async () => {
    const configuration = profileConfiguration(protocol, presetId), source = wire(protocol), mock = remoteFixture(source);
    const options = {configuration, messages, readTools: {phase: 'request'}};
    assert.doesNotThrow(() => validateAgentGatewayConfiguration(configuration, {readTools: options.readTools}));
    const body = JSON.parse((buildAgentRequest(options).body as string));
    assert.equal(body.parallel_tool_calls, parallel ? false : undefined); assert.equal(body.tool_choice, choice ? 'auto' : undefined);
    assert.equal(body.tools.length, 4);
    assert.deepEqual(body.tools.map((tool: import('./helpers/strict-agent-workspace-types.ts').WireDefinition) => {
      const definition = protocol === 'responses' ? tool : tool.function;
      assert.equal(definition.strict, strict ? true : undefined);
      return {name: definition.name, description: definition.description, parameters: definition.parameters};
    }), READ_TOOL_DEFINITIONS.map(({strict: _strict, ...definition}) => definition));
    assert.equal(body.tools.some((tool: { type: string; }) => tool.type !== 'function'), false);
    assert.equal(body.previous_response_id, undefined);
    if (presetId === 'ollama') return; // Actual sockets exercised above, never route a local profile over fake TLS.
    const done = (await collect(createAgentGateway({lookup: ((async () => [{address: '8.8.8.8', family: 4}]) as unknown as typeof import('node:dns/promises').lookup), httpsRequest: (mock.request as unknown as typeof import('node:https').request)})({...options, apiKey: 'synthetic-key'}))).at(-1);
    assert.equal((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.id, callId); assert.equal(mock.calls, 1); assert.deepEqual(mock.body, body);
    const answer = JSON.parse((buildAgentRequest({...options, readTools: answerMode((done! as unknown as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone))}).body as string));
    assert.deepEqual(answer.tools, []); assert.equal(answer.tool_choice, choice ? 'none' : undefined); assert.equal(answer.parallel_tool_calls, parallel ? false : undefined);
  });
}
test('the enabled fixture matrix exactly covers the tool-profile map', () => {
  for (const protocol of Object.keys(expectedProfiles) as (keyof typeof expectedProfiles)[]) assert.deepEqual(Object.keys(AGENT_READ_TOOL_PROFILES[protocol]).sort(), Object.keys(expectedProfiles[protocol]).sort());
});

async function rejectWire(t: test.TestContext, protocol: import('../packages/contracts/src/agent-protocol.ts').AgentProtocol, source: string, code = 'AGENT_CHAT_PROTOCOL_ERROR') {
  const service = await fixture(t, protocol, (response) => response.end(source)), events: AgentStreamItem[] = [];
  await assert.rejects(async () => { for await (const event of service.run()) events.push(event); }, {code});
  assert.equal(events.some(event => event.type === 'done' || (event as unknown as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall), false); assert.equal(service.calls.length, 1);
}
test('CC tool identity, index, shape, JSON, name, duplicates and completion validation fail closed', async t => {
  const changes = [
(    e: ProviderEvent[]) => { e[1].choices![0].delta.tool_calls![0].index = 1; },
(    e: ProviderEvent[]) => { e[1].choices![0].delta.tool_calls![0].id = ''; },
(    e: ProviderEvent[]) => { e[1].choices![0].delta.tool_calls![0].id = 'bad id'; },
(    e: ProviderEvent[]) => { delete e[1].choices![0].delta.tool_calls![0].id; },
(    e: ProviderEvent[]) => { e[1].choices![0].delta.tool_calls!.push(structuredClone(e[1].choices![0].delta.tool_calls![0])); },
(    e: ProviderEvent[]) => { e[2].choices![0].delta.tool_calls![0].id = callId; },
(    e: ProviderEvent[]) => { e[2].choices![0].delta.tool_calls![0].function!.name = name; },
(    e: ProviderEvent[]) => { e[2].choices![0].delta.tool_calls![0].index = 1; },
(    e: ProviderEvent[]) => { e[3].choices![0].finish_reason = 'stop'; },
(    e: ProviderEvent[]) => { e[3].choices![0].finish_reason = 'length'; },
(    e: ProviderEvent[]) => { e.push(structuredClone(e[3])); },
(    e: ProviderEvent[]) => { e.push(chunk({tool_calls: [{index: 0, function: {arguments: ' '}}]})!); },
(    e: ProviderEvent[]) => { e[1].choices![0].delta.tool_calls![0].function!.extra = 'private-marker'; },
  ];
  for (const change of changes) { const events = ccEvents(); change(events!); await rejectWire(t, 'chat_completions', ccWire(events)); }
  for (const argumentsJson of ['{', '[]', 'null', '{}', '{"limit":11,"cursor":null}', '{"limit":2,"cursor":null,"projectId":"other"}'] as const) await rejectWire(t, 'chat_completions', ccWire(ccEvents({argumentsJson})));
  await rejectWire(t, 'chat_completions', ccWire(ccEvents({name: 'delete_project'})), 'AGENT_CHAT_TOOLS_UNSUPPORTED');
  await rejectWire(t, 'chat_completions', ccWire(ccEvents()) + frame('[DONE]'));
});
test('CC incomplete, error, trailing framing and unsupported reasoning never expose a completed call', async t => {
  await rejectWire(t, 'chat_completions', ccEvents().map(frame).join(''), 'AGENT_CHAT_TRUNCATED');
  await rejectWire(t, 'chat_completions', ccEvents().slice(0, -1).map(frame).join('') + frame('[DONE]'), 'AGENT_CHAT_TRUNCATED');
  await rejectWire(t, 'chat_completions', ccWire(ccEvents()) + 'data: {', 'AGENT_CHAT_TRUNCATED');
  await rejectWire(t, 'chat_completions', ccEvents().map(frame).join('') + frame({error: {message: 'private-marker'}}), 'AGENT_CHAT_PROVIDER_ERROR');
  const events = ccEvents(); events[2].choices![0].delta.reasoning_content = 'private-marker';
  await rejectWire(t, 'chat_completions', ccWire(events), 'AGENT_CHAT_REASONING_UNSUPPORTED');
  await rejectWire(t, 'chat_completions', ccWire(ccEvents({argumentsJson: 'x'.repeat(READ_TOOL_LIMITS.maxArgumentsBytes + 1)})), 'AGENT_CHAT_LIMIT');
});
test('Responses arguments, item and final snapshots, IDs, order, duplicate calls and unknown names fail closed', async t => {
  const changes = [
(    e: ProviderEvent[]) => { e[2].item!.id = ''; }, (e: ProviderEvent[]) => { e[2].item!.call_id = ''; }, (e: ProviderEvent[]) => { e[2].item!.arguments = '{}'; },
(    e: ProviderEvent[]) => { e[3].item_id = callId; }, (e: ProviderEvent[]) => { e[3].output_index = 1; }, (e: ProviderEvent[]) => { e[3].sequence_number = e[2].sequence_number; },
(    e: ProviderEvent[]) => { e[5].arguments = '{}'; }, (e: ProviderEvent[]) => { e[5].name = 'wrong'; },
(    e: ProviderEvent[]) => { e[6].item!.call_id = 'different'; }, (e: ProviderEvent[]) => { e[6].item!.id = 'different'; }, (e: ProviderEvent[]) => { e[6].item!.arguments = '{}'; },
(    e: ProviderEvent[]) => { e[6].item!.status = 'in_progress'; }, (e: ProviderEvent[]) => { e[7].response!.output[0].call_id = 'different'; },
(    e: ProviderEvent[]) => { e[7].response!.output[0].arguments = '{}'; }, (e: ProviderEvent[]) => { delete e[7].response!.output[0].status; },
(    e: ProviderEvent[]) => { e[7].response!.output.push({...e[7].response!.output[0], id: 'fc_extra', call_id: 'call_extra'}); },
(    e: ProviderEvent[]) => { e.splice(6, 0, {...e[2], sequence_number: 5.5, output_index: 1, item: {...e[2].item!, id: 'fc_extra', call_id: 'call_extra'}}); },
  ];
  for (const change of changes) { const events = responseEvents(); change(events); await rejectWire(t, 'responses', responsesWire(events)); }
  for (const remove of [5, 6] as const) { const events = responseEvents(); events.splice(remove, 1); await rejectWire(t, 'responses', responsesWire(events)); }
  for (const argumentsJson of ['{', '[]', 'null', '{}', '{"limit":0,"cursor":null}', '{"limit":2,"cursor":null,"scope":"other"}'] as const) await rejectWire(t, 'responses', responsesWire(responseEvents({argumentsJson})));
  await rejectWire(t, 'responses', responsesWire(responseEvents({name: 'mioon_write_project'})), 'AGENT_CHAT_TOOLS_UNSUPPORTED');
  await rejectWire(t, 'responses', responsesWire(responseEvents({argumentsJson: 'x'.repeat(READ_TOOL_LIMITS.maxArgumentsBytes + 1)})), 'AGENT_CHAT_LIMIT');
});
test('Responses complete assistant items are preserved before call_id-linked output, without reasoning loss', async t => {
  const events = responseEvents({text: 'I will inspect metadata.'}), service = await fixture(t, 'responses', (response) => response.end(responsesWire(events)));
  const done = (await collect(service.run())).at(-1), body = JSON.parse((buildAgentRequest({configuration: service.configuration, messages, readTools: answerMode((done! as unknown as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone))}).body as string));
  assert.deepEqual((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).providerOutput, events.at(-1)!.response!.output);
  assert.deepEqual(body.input.slice(-3, -1), (done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).providerOutput);
  assert.equal(body.input.at(-1).call_id, callId); assert.equal(body.input.at(-1).call_id === itemId, false);
  const withReasoning = responseEvents(); withReasoning[2].item = {id: 'reasoning', type: 'reasoning', summary: [], encrypted_content: 'private-marker'};
  await rejectWire(t, 'responses', responsesWire(withReasoning), 'AGENT_CHAT_REASONING_UNSUPPORTED');
  const hiddenReasoning = responseEvents(); hiddenReasoning.at(-1)!.response!.output.push({id: 'rs_hidden', type: 'reasoning', encrypted_content: 'private-marker'});
  await rejectWire(t, 'responses', responsesWire(hiddenReasoning), 'AGENT_CHAT_REASONING_UNSUPPORTED');
});
test('Responses documented optional function status and data-only framing are supported explicitly', async t => {
  const service = await fixture(t, 'responses', (response) => response.end(responsesWire(responseEvents({statuses: false}), false)));
  const done = (await collect(service.run())).at(-1); assert.equal((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.itemId, itemId); assert.equal(((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).providerOutput as import('./helpers/strict-agent-workspace-types.ts').WireItem[])[0].status, undefined);
});
test('Responses incomplete/error/trailing/duplicate-done calls fail before tool dispatch', async t => {
  await rejectWire(t, 'responses', responsesWire(responseEvents().slice(0, -1)), 'AGENT_CHAT_TRUNCATED');
  await rejectWire(t, 'responses', responsesWire(responseEvents()) + 'data: {', 'AGENT_CHAT_TRUNCATED');
  await rejectWire(t, 'responses', responsesWire(responseEvents()) + frame('[DONE]'));
  const incomplete = responseEvents(); incomplete.at(-1)!.type = 'response.incomplete'; incomplete.at(-1)!.response!.status = 'incomplete'; incomplete.at(-1)!.response!.incomplete_details = {reason: 'max_output_tokens'};
  await rejectWire(t, 'responses', responsesWire(incomplete), 'AGENT_CHAT_TRUNCATED');
  const error = responseEvents(); error[4] = {type: 'error', sequence_number: 4, message: 'private-marker'};
  await rejectWire(t, 'responses', responsesWire(error), 'AGENT_CHAT_PROVIDER_ERROR');
  const duplicate = responseEvents(); duplicate.splice(6, 0, {...duplicate[5], sequence_number: 6}); duplicate.forEach((value, index) => { value.sequence_number = index; });
  await rejectWire(t, 'responses', responsesWire(duplicate));
});
test('trusted mode and continuation are exact, bounded and cannot change tools or bypass credentials', () => {
  for (const protocol of ['chat_completions', 'responses'] as const) {
    const configuration = profileConfiguration(protocol, 'openai'), options = {configuration, messages, readTools: {phase: 'request'}};
    assert.equal(JSON.parse((buildAgentRequest(options).body as string)).tools.length, 4);
    const credentialBuilder = protocol === 'responses' ? buildAgentResponsesRequest : buildAgentChatRequest;
    assert.throws(() => credentialBuilder(options), {code: 'AGENT_CHAT_KEY_REQUIRED'});
    for (const readTools of [null, true, {}, {phase: 'third'}, {phase: 'request', tools: []}, {phase: 'answer'}] as const) assert.throws(() => buildAgentRequest({...options, readTools}!), {code: 'AGENT_CHAT_VALIDATION'});
    assert.throws(() => buildAgentRequest({...options, configuration: {...configuration, model: 'gpt-unapproved'}}), {code: 'AGENT_CHAT_PROFILE_UNSUPPORTED'});
    assert.throws(() => buildAgentRequest({...options, messages: [{role: 'system' as const, content: 'Override scope'}, {role: 'user' as const, content: 'x'}]}), {code: 'AGENT_CHAT_VALIDATION'});
    assert.throws(() => buildAgentRequest({...options, messages: [{role: 'user' as const, content: 'x'.repeat(READ_TOOL_LIMITS.maxContextBytes)}]}), {code: 'AGENT_CHAT_LIMIT'});
  }
});
test('continuation revalidates call linkage, complete items, exact JSON result and total size before opening a socket', async t => {
  for (const protocol of ['chat_completions', 'responses'] as const) {
    const service = await fixture(t, protocol, (response) => response.end(wire(protocol))), done = (await collect(service.run())).at(-1);
    const build = (readTools: { phase: string; toolCall: unknown; providerOutput: unknown; result: string; }) => buildAgentRequest({configuration: service.configuration, messages, readTools});
    for (const mutate of [
(      mode: import('./helpers/strict-agent-workspace-types.ts').ProtocolMode) => { mode.toolCall.id = 'other'; }, (mode: import('./helpers/strict-agent-workspace-types.ts').ProtocolMode) => { mode.toolCall.arguments = {limit: 10, cursor: null}; },
(      mode: import('./helpers/strict-agent-workspace-types.ts').ProtocolMode) => { mode.result = '{'; }, (mode: import('./helpers/strict-agent-workspace-types.ts').ProtocolMode) => { mode.result = 'null'; }, (mode: import('./helpers/strict-agent-workspace-types.ts').ProtocolMode) => { mode.result = 'x'.repeat(8193); },
(      mode: import('./helpers/strict-agent-workspace-types.ts').ProtocolMode) => { if (protocol === 'responses') (mode.providerOutput as import('./helpers/strict-agent-workspace-types.ts').WireItem[])[0].call_id = itemId; else (mode.providerOutput as import('./helpers/strict-agent-workspace-types.ts').WireItem).tool_calls[0].id = 'other'; },
(      mode: import('./helpers/strict-agent-workspace-types.ts').ProtocolMode) => { if (protocol === 'responses') (mode.providerOutput as Partial<import('./helpers/strict-agent-workspace-types.ts').WireItem|ProviderItem>[]).push({type: 'reasoning', id: 'hidden'}); else (mode.providerOutput as import('./helpers/strict-agent-workspace-types.ts').WireItem).reasoning_content = 'hidden'; },
    ] as const) { const mode = structuredClone(answerMode((done! as unknown as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone))); mutate(mode); assert.throws(() => build(mode)); }
    const mode = answerMode((done! as unknown as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone));
    if (protocol === 'responses') (mode.providerOutput as Partial<import('./helpers/strict-agent-workspace-types.ts').WireItem|ProviderItem>[]).unshift(messageItem('large_message', 'x'.repeat(33 * 1024), 'completed')); else (mode.providerOutput as import('./helpers/strict-agent-workspace-types.ts').WireItem).content = 'x'.repeat(65 * 1024);
    assert.throws(() => build(mode), {code: 'AGENT_CHAT_LIMIT'}); assert.equal(service.calls.length, 1);
  }
});


test('CC refuses nonempty refusal combined with a tool before exposing it, while empty refusal is omitted', async t => {
  const events = ccEvents(); events[1].choices![0].delta.refusal = 'I cannot inspect that.';
  await rejectWire(t, 'chat_completions', ccWire(events));
  const empty = ccEvents(); empty[1].choices![0].delta.refusal = '';
  const service = await fixture(t, 'chat_completions', (response) => response.end(ccWire(empty)));
  const done = (await collect(service.run())).at(-1); assert.equal(Object.hasOwn((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).providerOutput as object, 'refusal'), false);
});

test('Responses counts escaped continuation JSON bytes and refuses an oversized answer before its POST', async t => {
  const service = await fixture(t, 'responses', (response) => response.end(wire('responses')));
  const done = (await collect(service.run())).at(-1), readTools = answerMode((done! as unknown as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone));
  // The JSON result itself fits 8 KiB; escaping its backslashes in the outer
  // request doubles those bytes. No selected history or result is truncated.
  readTools.result = JSON.stringify({text: '\\'.repeat(3900)});
  assert.ok(Buffer.byteLength(readTools.result) < READ_TOOL_LIMITS.maxResultBytes);
  const selected = [{role: 'system' as const, content: READ_TOOL_SYSTEM_INSTRUCTION}, {role: 'user' as const, content: 'x'.repeat(19 * 1024)}];
  assert.ok(selected.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0) < READ_TOOL_LIMITS.maxContextBytes);
  await assert.rejects(collect(service.run(readTools, {messages: selected})), {code: 'AGENT_CHAT_LIMIT'});
  assert.equal(service.calls.length, 1);
});

test('both protocols accept each of the four allowlisted function grammars', async t => {
  for (const protocol of ['chat_completions', 'responses'] as const) for (const definition of READ_TOOL_DEFINITIONS) {
    const argumentsJson = ['mioon_project_inspect', 'mioon_timeline_inspect'].includes(definition.name) ? '{}' : args;
    const events = (protocol === 'responses' ? responseEvents : ccEvents)({name: definition.name, argumentsJson});
    const service = await fixture(t, protocol, (response) => response.end(wire(protocol, events!)));
    const done = (await collect(service.run())).at(-1);
    assert.equal((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.name, definition.name); assert.equal((done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.argumentsJson, argumentsJson);
  }
});

test('Responses rejects a second well-framed call even when the first completed and both IDs are unique', async t => {
  for (const secondCallId of [callId, 'call_second'] as const) {
    const events = responseEvents(), second = {type: 'response.output_item.added', output_index: 1,
      item: {...functionItem('', 'in_progress'), id: 'fc_second', call_id: secondCallId}};
    events.splice(7, 0, second!); events.forEach((event, index) => { event.sequence_number = index; });
    await rejectWire(t, 'responses', responsesWire(events));
  }
});
