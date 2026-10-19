import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {AGENT_READ_TOOL_PROFILES} from '../packages/business/src/agent/tool-wire.ts';
import {buildAgentRequest, createAgentGateway} from '../packages/business/src/agent/agent-gateway.ts';
import {EDIT_TOOL_SYSTEM_INSTRUCTION, EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.ts';
import {CHAT_SYSTEM_INSTRUCTION} from '../packages/business/src/agent/chat-policy.ts';

type Obj = Record<string, unknown>;
type Protocol = 'chat_completions' | 'responses';
interface Identity {toolCall: {id: string; argumentsJson: string; itemId?: string}; providerOutput: unknown}
interface ConfigurationView {protocol: Protocol; presetId: string; platformId: string; baseUrl: string; model: string}
interface Chunk {choices: Array<{index: number; delta: Obj; finish_reason: string | null}>}
interface SyntheticRequest extends EventEmitter {setTimeout: (milliseconds?: number) => void; destroy: () => void; end: (body: string) => void}
interface SyntheticIncoming extends Readable {statusCode: number; headers: Record<string, string>}
interface SyntheticTransport {calls: number; body?: Obj; request: (options: Obj, callback: (incoming: SyntheticIncoming) => void) => SyntheticRequest}
const callId = 'call_edit_fixture', itemId = 'fc_separate_edit', name = 'mioon_propose_shot_update';
const args = JSON.stringify({title: null, prompt: '完整修改提示'.repeat(700)});
const messages = [{role: 'system', content: EDIT_TOOL_SYSTEM_INSTRUCTION}, {role: 'user', content: 'Improve the selected saved shot.'}];
const requestMode = {phase: 'request', scope: 'selected_shot_edit'};
const frame = (value: unknown): string => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const chunk = (delta: Obj = {}, finish_reason: string | null = null): Chunk => ({choices: [{index: 0, delta, finish_reason}]});
function ccEvents(argumentsJson = args, toolName = name): Chunk[] {return [
  chunk({tool_calls: [{index: 0, id: callId, type: 'function', function: {name: toolName, arguments: argumentsJson.slice(0, 17)}}]}),
  chunk({tool_calls: [{index: 0, function: {arguments: argumentsJson.slice(17)}}]}), chunk({}, 'tool_calls')];}
function responseEvents(argumentsJson = args, toolName = name): Obj[] {
  const item = (value, status) => ({id: itemId, type: 'function_call', call_id: callId, name: toolName, arguments: value, status});
  const response = (output, status) => ({id: 'resp_edit_fixture', object: 'response', status, output, error: null, incomplete_details: null});
  return [{type: 'response.created', response: response([], 'in_progress')},
    {type: 'response.output_item.added', output_index: 0, item: item('', 'in_progress')},
    {type: 'response.function_call_arguments.delta', output_index: 0, item_id: itemId, delta: argumentsJson.slice(0, 17)},
    {type: 'response.function_call_arguments.delta', output_index: 0, item_id: itemId, delta: argumentsJson.slice(17)},
    {type: 'response.function_call_arguments.done', output_index: 0, item_id: itemId, arguments: argumentsJson},
    {type: 'response.output_item.done', output_index: 0, item: item(argumentsJson, 'completed')},
    {type: 'response.completed', response: response([item(argumentsJson, 'completed')], 'completed')}]
    .map((event, sequence_number) => ({...event, sequence_number}));
}
const wire = (protocol: Protocol, events?: Obj[]): string => (events || (protocol === 'responses' ? responseEvents() : ccEvents())).map(frame).join('') + (protocol === 'responses' ? '' : frame('[DONE]'));
function syntheticTransport(source: string): SyntheticTransport {
  const state = {calls: 0} as SyntheticTransport;
  state.request = (_options: Obj, callback: (incoming: SyntheticIncoming) => void) => {
    state.calls++;
    const request = new EventEmitter() as SyntheticRequest; request.setTimeout = () => {}; request.destroy = () => {};
    request.end = (body: string) => {state.body = JSON.parse(body) as Obj; const incoming = Readable.from([Buffer.from(source)]) as SyntheticIncoming; incoming.statusCode = 200; incoming.headers = {'content-type': 'text/event-stream'}; callback(incoming);};
    queueMicrotask(() => {const socket = new EventEmitter(); Object.assign(socket, {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}}); request.emit('socket', socket); socket.emit('secureConnect');});
    return request;
  };
  return state;
}
function configuration(protocol: Protocol, presetId = 'openai'): ConfigurationView {
  const preset = AGENT_PRESETS.find(item => item.id === presetId); assert.ok(preset); const platform = preset.platforms[0]; assert.ok(platform);
  return {protocol, presetId, platformId: platform.id, baseUrl: platform.baseUrl || 'https://fixture.example.com/v1',
    model: protocol === 'responses' && presetId === 'qwen' ? 'qwen3.8-flash' : platform.model || 'fixture-model'};
}
async function run(protocol: Protocol, source: string, readTools: Obj = requestMode, config: ConfigurationView = configuration(protocol)): Promise<{transport: SyntheticTransport; done: Identity}> {
  const transport = syntheticTransport(source), items: Identity[] = [];
  const gateway = createAgentGateway({httpsRequest: transport.request as never, httpRequest: transport.request as never, lookup: (async () => [{address: '8.8.8.8', family: 4}]) as never});
  for await (const item of gateway({configuration: config as never, apiKey: 'SYNTHETIC_FAKE_ONLY', messages: messages as never, readTools: readTools as never, selfPort: 1})) items.push(item as unknown as Identity);
  const done = items.at(-1); assert.ok(done); return {transport, done};
}
for (const protocol of ['chat_completions', 'responses'] as const) {
  for (const [presetId, profile] of Object.entries(AGENT_READ_TOOL_PROFILES[protocol]) as Array<[string, {strict?: boolean; parallel?: boolean; choice?: boolean}]>) test(`${protocol}/${presetId}: scoped edit catalog preserves profile controls and exact call-linkage without broadening schema`, async () => {
    const config = configuration(protocol, presetId);
    const body = JSON.parse(buildAgentRequest({configuration: config as never, messages: messages as never, readTools: requestMode as never, selfPort: 1}).body) as {tools: Array<{function?: {name?: string; parameters?: unknown}; name?: string; parameters?: unknown}>; parallel_tool_calls?: boolean; tool_choice?: string};
    assert.equal(body.tools.length, 1);
    const definition = (protocol === 'responses' ? body.tools[0] : body.tools[0].function) as {name?: string; parameters?: unknown; strict?: boolean};
    assert.equal(definition.name, name); assert.deepEqual(definition.parameters, EDIT_TOOL_DEFINITIONS[0].parameters);
    assert.equal(definition.strict, profile.strict ? true : undefined);
    assert.equal(body.parallel_tool_calls, profile.parallel ? false : undefined);
    assert.equal(body.tool_choice, profile.choice ? 'auto' : undefined);
    // Local Ollama uses its existing loopback-only route; compile its grammar
    // here and parse the same exact protocol against a no-network fake OpenAI socket.
    const parsed = await run(protocol, wire(protocol), requestMode, presetId === 'ollama' ? configuration(protocol) : config);
    assert.equal(parsed.done.toolCall.id, callId); assert.equal(parsed.done.toolCall.argumentsJson, args);
    if (protocol === 'responses') assert.equal(parsed.done.toolCall.itemId, itemId);
    const answer = {...requestMode, phase: 'answer', toolCall: parsed.done.toolCall, providerOutput: parsed.done.providerOutput,
      result: '{"kind":"untrusted_shot_update_proposal","status":"pending_review","applied":false,"proposalId":"backend-id","digest":"backend-digest"}'};
    const final = JSON.parse(buildAgentRequest({configuration: config as never, messages: messages as never, readTools: answer as never, selfPort: 1}).body) as {tools: unknown[]; tool_choice?: string; previous_response_id?: string; input: Array<{call_id?: string; id?: string}>; messages: Array<{tool_call_id?: string; tool_calls: Array<{id?: string}>}>};
    assert.deepEqual(final.tools, []); assert.equal(final.tool_choice, profile.choice ? 'none' : undefined);
    assert.equal(final.previous_response_id, undefined);
    if (protocol === 'responses') {assert.equal(final.input.at(-1).call_id, callId); assert.equal(final.input.at(-2).id, itemId);}
    else {assert.equal(final.messages.at(-1).tool_call_id, callId); assert.equal(final.messages.at(-2).tool_calls[0].id, callId);}
  });
  test(`${protocol}: edit tool rejects read catalog, identifiers, duplicate keys and incomplete streams before any completed call`, async () => {
    const build = (json, toolName) => wire(protocol, protocol === 'responses' ? responseEvents(json, toolName) : ccEvents(json, toolName));
    for (const [json, toolName] of [[args, 'mioon_shot_inspect'], ['{"title":"x","prompt":null,"projectId":"x"}', name],
      ['{"title":"x","title":"y","prompt":null}', name], ['{"title":null,"prompt":null}', name], ['{"title":"","prompt":null}', name]]) {
      await assert.rejects(run(protocol, build(json, toolName)));
    }
    const events = protocol === 'responses' ? responseEvents().slice(0, -1) : ccEvents().slice(0, -1);
    await assert.rejects(run(protocol, wire(protocol, events)), {code: 'AGENT_CHAT_TRUNCATED'});
    await assert.rejects(run(protocol, wire(protocol), {phase: 'request'}), {code: 'AGENT_CHAT_VALIDATION'});
  });
  test(`${protocol}: terminal function snapshot changes fail closed and answer phase cannot call again`, async () => {
    const events = protocol === 'responses' ? responseEvents() : ccEvents();
    if (protocol === 'responses') events.at(-1).response.output[0].call_id = itemId;
    else events[1].choices[0].delta.tool_calls[0].id = 'replacement';
    await assert.rejects(run(protocol, wire(protocol, events)), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
    const {done} = await run(protocol, wire(protocol));
    await assert.rejects(run(protocol, wire(protocol), {...requestMode, phase: 'answer', toolCall: done.toolCall,
      providerOutput: done.providerOutput, result: '{"status":"pending_review","applied":false}'}), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  });
  test(`${protocol}: full bounded selected context plus large proposal remains scoped to edit; arbitrary catalogs fail validation`, async () => {
    const {done} = await run(protocol, wire(protocol));
    const answer = {...requestMode, phase: 'answer', toolCall: done.toolCall, providerOutput: done.providerOutput, result: '{"applied":false}'};
    const input = [{role: 'system', content: EDIT_TOOL_SYSTEM_INSTRUCTION}, {role: 'user', content: '界'.repeat(8500)}];
    assert.doesNotThrow(() => buildAgentRequest({configuration: configuration(protocol), messages: input, readTools: answer, selfPort: 1}));
    for (const extra of [{catalog: EDIT_TOOL_DEFINITIONS}, {scope: 'arbitrary'}, {operation: 'shot.update'}])
      assert.throws(() => buildAgentRequest({configuration: configuration(protocol), messages, readTools: {...requestMode, ...extra}, selfPort: 1}));
    assert.throws(() => buildAgentRequest({configuration: configuration(protocol), messages: [{role: 'system', content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user', content: 'hello'}],
      readTools: {...answer, scope: undefined}, selfPort: 1}));
  });
}
