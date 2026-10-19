import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {AGENT_READ_TOOL_PROFILES} from '../packages/business/src/agent/tool-wire.ts';
import {buildAgentRequest, createAgentGateway} from '../packages/business/src/agent/agent-gateway.ts';
import {TIMELINE_EDIT_TOOL_SYSTEM_INSTRUCTION, TIMELINE_EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/timeline-edit-tool-policy.ts';
import {CHAT_SYSTEM_INSTRUCTION} from '../packages/business/src/agent/chat-policy.ts';

const callId = 'call_edit_fixture', itemId = 'fc_separate_edit', name = 'mioon_propose_timeline_clip_move';
const args = JSON.stringify({startFrame: 90});
const messages = [{role: 'system', content: TIMELINE_EDIT_TOOL_SYSTEM_INSTRUCTION}, {role: 'user', content: 'Move the selected saved clip to frame 90.'}];
const requestMode = {phase: 'request', scope: 'selected_timeline_clip_move'};
const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const chunk = (delta = {}, finish_reason = null) => ({choices: [{index: 0, delta, finish_reason}]});
function ccEvents(argumentsJson = args, toolName = name) {return [
  chunk({tool_calls: [{index: 0, id: callId, type: 'function', function: {name: toolName, arguments: argumentsJson.slice(0, 7)}}]}),
  chunk({tool_calls: [{index: 0, function: {arguments: argumentsJson.slice(7)}}]}), chunk({}, 'tool_calls')];}
function responseEvents(argumentsJson = args, toolName = name) {
  const item = (value, status) => ({id: itemId, type: 'function_call', call_id: callId, name: toolName, arguments: value, status});
  const response = (output, status) => ({id: 'resp_edit_fixture', object: 'response', status, output, error: null, incomplete_details: null});
  return [{type: 'response.created', response: response([], 'in_progress')},
    {type: 'response.output_item.added', output_index: 0, item: item('', 'in_progress')},
    {type: 'response.function_call_arguments.delta', output_index: 0, item_id: itemId, delta: argumentsJson.slice(0, 7)},
    {type: 'response.function_call_arguments.delta', output_index: 0, item_id: itemId, delta: argumentsJson.slice(7)},
    {type: 'response.function_call_arguments.done', output_index: 0, item_id: itemId, arguments: argumentsJson},
    {type: 'response.output_item.done', output_index: 0, item: item(argumentsJson, 'completed')},
    {type: 'response.completed', response: response([item(argumentsJson, 'completed')], 'completed')}]
    .map((event, sequence_number) => ({...event, sequence_number}));
}
const wire = (protocol, events) => (events || (protocol === 'responses' ? responseEvents() : ccEvents())).map(frame).join('') + (protocol === 'responses' ? '' : frame('[DONE]'));
function syntheticTransport(source) {
  const state = {calls: 0};
  state.request = (_options, callback) => {
    state.calls++;
    const request = new EventEmitter(); request.setTimeout = () => {}; request.destroy = () => {};
    request.end = body => {state.body = JSON.parse(body); const incoming = Readable.from([Buffer.from(source)]); incoming.statusCode = 200; incoming.headers = {'content-type': 'text/event-stream'}; callback(incoming);};
    queueMicrotask(() => {const socket = new EventEmitter(); Object.assign(socket, {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}}); request.emit('socket', socket); socket.emit('secureConnect');});
    return request;
  };
  return state;
}
function configuration(protocol, presetId = 'openai') {
  const platform = AGENT_PRESETS.find(item => item.id === presetId).platforms[0];
  return {protocol, presetId, platformId: platform.id, baseUrl: platform.baseUrl || 'https://fixture.example.com/v1',
    model: protocol === 'responses' && presetId === 'qwen' ? 'qwen3.8-flash' : platform.model || 'fixture-model'};
}
async function run(protocol, source, readTools = requestMode, config = configuration(protocol), input = messages) {
  const transport = syntheticTransport(source), items = [];
  const gateway = createAgentGateway({httpsRequest: transport.request, httpRequest: transport.request, lookup: async () => [{address: '8.8.8.8', family: 4}]});
  for await (const item of gateway({configuration: config, apiKey: 'SYNTHETIC_FAKE_ONLY', messages: input, readTools, selfPort: 1})) items.push(item);
  return {transport, done: items.at(-1)};
}
for (const protocol of ['chat_completions', 'responses']) {
  for (const [presetId, profile] of Object.entries(AGENT_READ_TOOL_PROFILES[protocol])) test(`${protocol}/${presetId}: scoped timeline move catalog preserves profile controls and exact call-linkage without broadening schema`, async () => {
    const config = configuration(protocol, presetId);
    const body = JSON.parse(buildAgentRequest({configuration: config, messages, readTools: requestMode, selfPort: 1}).body);
    assert.equal(body.tools.length, 1);
    const definition = protocol === 'responses' ? body.tools[0] : body.tools[0].function;
    assert.equal(definition.name, name); assert.deepEqual(definition.parameters, TIMELINE_EDIT_TOOL_DEFINITIONS[0].parameters);
    assert.equal(definition.strict, profile.strict ? true : undefined);
    assert.equal(body.parallel_tool_calls, profile.parallel ? false : undefined);
    assert.equal(body.tool_choice, profile.choice ? 'auto' : undefined);
    // Local Ollama uses its existing loopback-only route; compile its grammar
    // here and parse the same exact protocol against a no-network fake OpenAI socket.
    const parsed = await run(protocol, wire(protocol), requestMode, presetId === 'ollama' ? configuration(protocol) : config);
    assert.equal(parsed.done.toolCall.id, callId); assert.equal(parsed.done.toolCall.argumentsJson, args);
    if (protocol === 'responses') assert.equal(parsed.done.toolCall.itemId, itemId);
    const answer = {...requestMode, phase: 'answer', toolCall: parsed.done.toolCall, providerOutput: parsed.done.providerOutput,
      result: '{"kind":"untrusted_timeline_clip_move_proposal","status":"pending_review","applied":false,"proposalId":"backend-id","digest":"backend-digest"}'};
    const final = JSON.parse(buildAgentRequest({configuration: config, messages, readTools: answer, selfPort: 1}).body);
    assert.deepEqual(final.tools, []); assert.equal(final.tool_choice, profile.choice ? 'none' : undefined);
    assert.equal(final.previous_response_id, undefined);
    if (protocol === 'responses') {assert.equal(final.store, false); assert.equal(final.input.at(-1).call_id, callId); assert.equal(final.input.at(-2).id, itemId);}
    else {assert.equal(final.messages.at(-1).tool_call_id, callId); assert.equal(final.messages.at(-2).tool_calls[0].id, callId);}
  });
  test(`${protocol}: old shot scope rejects the new timeline tool after a complete response`, async () => {
    await assert.rejects(run(protocol, wire(protocol), {phase: 'request', scope: 'selected_shot_edit'}, configuration(protocol),
      [{role: 'system', content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user', content: 'hello'}]), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  });
  test(`${protocol}: timeline move tool rejects read catalog, identifiers, duplicate keys and incomplete streams before any completed call`, async () => {
    const build = (json, toolName) => wire(protocol, protocol === 'responses' ? responseEvents(json, toolName) : ccEvents(json, toolName));
    for (const [json, toolName] of [[args, 'mioon_propose_shot_update'], ['{"startFrame":90,"clipId":"x"}', name],
      ['{"startFrame":90,"startFrame":91}', name], ['{"startFrame":null}', name], ['{"startFrame":1.5}', name], ['{"startFrame":18001}', name], ['{"startFrame":-1}', name], ['{"startFrame":90,"requestId":"forged"}', name]]) {
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
    const input = [{role: 'system', content: TIMELINE_EDIT_TOOL_SYSTEM_INSTRUCTION}, {role: 'user', content: '界'.repeat(8500)}];
    assert.doesNotThrow(() => buildAgentRequest({configuration: configuration(protocol), messages: input, readTools: answer, selfPort: 1}));
    for (const extra of [{catalog: TIMELINE_EDIT_TOOL_DEFINITIONS}, {scope: 'arbitrary'}, {operation: 'timeline.clip.update'}])
      assert.throws(() => buildAgentRequest({configuration: configuration(protocol), messages, readTools: {...requestMode, ...extra}, selfPort: 1}));
    assert.throws(() => buildAgentRequest({configuration: configuration(protocol), messages: [{role: 'system', content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user', content: 'hello'}],
      readTools: {...answer, scope: undefined}, selfPort: 1}));
  });
}
