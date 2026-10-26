import type {ProviderEvent} from './helpers/strict-agent-workspace-types.ts';
import type {ProviderItem, MockRequestState, MockRequest, MockIncoming, HttpCapture} from './helpers/strict-agent-workspace-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {agentTimelineMoveTargetFromTimeline, agentTimelineGainTargetFromTimeline} from '@mioon/contracts';
import {selectChatContext} from '../packages/business/src/agent/chat-context.ts';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {AGENT_READ_TOOL_PROFILES} from '../packages/business/src/agent/tool-wire.ts';
import {buildAgentRequest, createAgentGateway, type AgentStreamItem} from '../packages/business/src/agent/agent-gateway.ts';
import {TIMELINE_GAIN_EDIT_TOOL_SYSTEM_INSTRUCTION, TIMELINE_GAIN_EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/timeline-gain-tool-policy.ts';
import {CHAT_SYSTEM_INSTRUCTION} from '../packages/business/src/agent/chat-policy.ts';

const callId = 'call_gain_fixture', itemId = 'fc_separate_gain', name = 'mioon_propose_timeline_clip_gain';
const args = JSON.stringify({gain: 0.4});
const messages = [{role: 'system' as const, content: TIMELINE_GAIN_EDIT_TOOL_SYSTEM_INSTRUCTION}, {role: 'user' as const, content: 'Set the selected saved clip volume to 40%.'}];
const requestMode = {phase: 'request', scope: 'selected_timeline_clip_gain'};
const frame = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const chunk = (delta: import('./helpers/strict-agent-workspace-types.ts').ProviderDelta = {}, finish_reason: string|null = null): ProviderEvent => ({choices: [{index: 0, delta, finish_reason}]});
function ccEvents(argumentsJson = args, toolName = name): ProviderEvent[] {return [
  chunk({tool_calls: [{index: 0, id: callId, type: 'function', function: {name: toolName, arguments: argumentsJson.slice(0, 7)}}]}),
  chunk({tool_calls: [{index: 0, function: {arguments: argumentsJson.slice(7)}}]}), chunk({}, 'tool_calls')];}
function responseEvents(argumentsJson = args, toolName = name): ProviderEvent[] {
  const item = (value: string, status: string) => ({id: itemId, type: 'function_call', call_id: callId, name: toolName, arguments: value, status});
  const response = (output: ProviderItem[], status: string): import('./helpers/strict-agent-workspace-types.ts').ProviderResponse => ({id: 'resp_gain_fixture', object: 'response', status, output, error: null, incomplete_details: null});
  return [{type: 'response.created', response: response([], 'in_progress')},
    {type: 'response.output_item.added', output_index: 0, item: item('', 'in_progress')},
    {type: 'response.function_call_arguments.delta', output_index: 0, item_id: itemId, delta: argumentsJson.slice(0, 7)},
    {type: 'response.function_call_arguments.delta', output_index: 0, item_id: itemId, delta: argumentsJson.slice(7)},
    {type: 'response.function_call_arguments.done', output_index: 0, item_id: itemId, arguments: argumentsJson},
    {type: 'response.output_item.done', output_index: 0, item: item(argumentsJson, 'completed')},
    {type: 'response.completed', response: response([item(argumentsJson, 'completed')], 'completed')}]
    .map((event, sequence_number) => ({...event, sequence_number}));
}
const wire = (protocol: import('../packages/contracts/src/agent-protocol.ts').AgentProtocol, events?: ProviderEvent[]) => (events || (protocol === 'responses' ? responseEvents() : ccEvents())).map(frame).join('') + (protocol === 'responses' ? '' : frame('[DONE]'));
function syntheticTransport(source: string|Uint8Array) {
  const state = ({calls: 0} as unknown as MockRequestState);
  state.request = (_options, callback) => {
    state.calls++;
    const request = (new EventEmitter() as unknown as MockRequest); request.setTimeout = () => {}; request.destroy = () => {};
    request.end = (body: string) => {state.body = JSON.parse((body as string)); const incoming = (Readable.from([Buffer.from(source)]) as unknown as MockIncoming); incoming.statusCode = 200; incoming.headers = {'content-type': 'text/event-stream'}; callback(incoming);};
    queueMicrotask(() => {const socket = new EventEmitter(); Object.assign(socket, {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}}); request.emit('socket', socket); socket.emit('secureConnect');});
    return request;
  };
  return state;
}
function configuration(protocol: import('../packages/contracts/src/agent-protocol.ts').AgentProtocol, presetId = 'openai') {
  const platform = AGENT_PRESETS.find(item => item.id === presetId)!.platforms[0];
  return {protocol, presetId, platformId: platform.id, baseUrl: platform.baseUrl || 'https://fixture.example.com/v1',
    model: protocol === 'responses' && presetId === 'qwen' ? 'qwen3.8-flash' : platform.model || 'fixture-model'};
}
async function run(protocol: import('../packages/contracts/src/agent-protocol.ts').AgentProtocol, source: string, readTools: unknown = requestMode, config = configuration(protocol), input = messages) {
  const transport = syntheticTransport(source), items = [];
  const gateway = createAgentGateway({httpsRequest: (transport.request as unknown as typeof import('node:https').request), httpRequest: (transport.request as unknown as typeof import('node:http').request), lookup: ((async () => [{address: '8.8.8.8', family: 4}]) as unknown as typeof import('node:dns/promises').lookup)});
  for await (const item of gateway({configuration: config, apiKey: 'SYNTHETIC_FAKE_ONLY', messages: input, ...(readTools === null ? {} : {readTools}), selfPort: 1})) items.push(item);
  return {transport, done: items.at(-1)};
}
for (const protocol of ['chat_completions', 'responses'] as const) {
  for (const [presetId, profile] of Object.entries(AGENT_READ_TOOL_PROFILES[protocol])) test(`${protocol}/${presetId}: scoped timeline gain catalog preserves profile controls and exact call-linkage without broadening schema`, async () => {
    const config = configuration(protocol, presetId);
    const body = JSON.parse((buildAgentRequest({configuration: config, messages, readTools: requestMode, selfPort: 1}).body as string));
    assert.equal(body.tools.length, 1);
    const definition = protocol === 'responses' ? body.tools[0] : body.tools[0].function;
    assert.equal(definition.name, name); assert.deepEqual(definition.parameters, TIMELINE_GAIN_EDIT_TOOL_DEFINITIONS[0].parameters);
    assert.equal(definition.strict, profile.strict ? true : undefined);
    assert.equal(body.parallel_tool_calls, profile.parallel ? false : undefined);
    assert.equal(body.tool_choice, profile.choice ? 'auto' : undefined);
    // Local Ollama uses its existing loopback-only route; compile its grammar
    // here and parse the same exact protocol against a no-network fake OpenAI socket.
    const parsed = await run(protocol, wire(protocol), requestMode, presetId === 'ollama' ? configuration(protocol) : config);
    assert.equal((parsed.done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.id, callId); assert.equal((parsed.done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.argumentsJson, args);
    if (protocol === 'responses') assert.equal((parsed.done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.itemId, itemId);
    const answer = {...requestMode, phase: 'answer', toolCall: (parsed.done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall, providerOutput: (parsed.done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).providerOutput,
      result: '{"kind":"untrusted_timeline_clip_gain_proposal","status":"pending_review","applied":false,"proposalId":"backend-id","digest":"backend-digest"}'};
    const final = JSON.parse((buildAgentRequest({configuration: config, messages, readTools: answer, selfPort: 1}).body as string));
    assert.deepEqual(final.tools, []); assert.equal(final.tool_choice, profile.choice ? 'none' : undefined);
    assert.equal(final.previous_response_id, undefined);
    if (protocol === 'responses') {assert.equal(final.store, false); assert.equal(final.input.at(-1).call_id, callId); assert.equal(final.input.at(-2).id, itemId);}
    else {assert.equal(final.messages.at(-1).tool_call_id, callId); assert.equal(final.messages.at(-2).tool_calls[0].id, callId);}
  });
  test(`${protocol}: typed, inspection, shot and move scopes all reject the completed gain tool`, async () => {
    for (const scope of [undefined, 'selected_shot_edit', 'selected_timeline_clip_move'] as const) {
      await assert.rejects(run(protocol, wire(protocol), {phase: 'request', ...(scope ? {scope} : {})}!, configuration(protocol),
        [{role: 'system' as const, content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user' as const, content: 'hello'}]), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
    }
    await assert.rejects(run(protocol, wire(protocol), null, configuration(protocol),
      [{role: 'system' as const, content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user' as const, content: 'hello'}]), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  });
  test(`${protocol}: gain tool rejects foreign functions, identifiers, duplicate keys, wrong types and incomplete streams`, async () => {
    const build = (json?: string|undefined, toolName?: string|undefined) => wire(protocol, protocol === 'responses' ? responseEvents(json, toolName) : ccEvents(json, toolName)!);
    for (const [json, toolName] of [[args, 'mioon_propose_shot_update'], [args, 'mioon_propose_timeline_clip_move'],
      [args, 'mioon_timeline_inspect'], ['{"gain":0.4,"clipId":"x"}', name], ['{"gain":0.4,"gain":0.5}', name],
      ['{"gain":0.4,"ga\\u0069n":0.5}', name], ['{"gain":null}', name], ['{"gain":"0.4"}', name],
      ['{"gain":2.0001}', name], ['{"gain":-1}', name], ['{"gain":-0}', name], ['{"gain":1e999}', name],
      ['{"gain":0.4,"requestId":"forged"}', name], ['{"gain":0.4,"startFrame":90}', name], ['{"gain":0.4,"muted":true}', name]] as const) {
      await assert.rejects(run(protocol, build(json, toolName)));
    }
    for (const gain of [0, 0.4, 1, 2, 0.12345678901234568] as const) {
      const json = JSON.stringify({gain}), parsed = await run(protocol, build(json, name));
      assert.deepEqual((parsed.done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.arguments, {gain}); assert.equal((parsed.done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.argumentsJson, json);
    }
    const oversized = JSON.stringify({gain: 0.4, extra: '界'.repeat(400)});
    assert.ok(oversized.length < 1024 && Buffer.byteLength(oversized) > 1024);
    await assert.rejects(run(protocol, build(oversized, name)), {code: 'AGENT_CHAT_LIMIT'});
    const events = protocol === 'responses' ? responseEvents().slice(0, -1) : ccEvents().slice(0, -1);
    await assert.rejects(run(protocol, wire(protocol, events!)), {code: 'AGENT_CHAT_TRUNCATED'});
  });
  test(`${protocol}: terminal function snapshot changes fail closed and answer phase cannot call again`, async () => {
    const events = protocol === 'responses' ? responseEvents() : ccEvents();
    if (protocol === 'responses') events.at(-1)!.response!.output[0].call_id = itemId;
    else events[1].choices![0].delta.tool_calls![0].id = 'replacement';
    await assert.rejects(run(protocol, wire(protocol, events!)), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
    const {done} = await run(protocol, wire(protocol));
    await assert.rejects(run(protocol, wire(protocol), {...requestMode, phase: 'answer', toolCall: (done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall,
      providerOutput: (done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).providerOutput, result: '{"status":"pending_review","applied":false}'}), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  });
  test(`${protocol}: full bounded selected context plus large proposal remains scoped to edit; arbitrary catalogs fail validation`, async () => {
    const {done} = await run(protocol, wire(protocol));
    const answer = {...requestMode, phase: 'answer', toolCall: (done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall, providerOutput: (done as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).providerOutput, result: '{"applied":false}'};
    const oversizedResult = JSON.stringify({text: '界'.repeat(2730)});
    assert.ok(oversizedResult.length < 8192 && Buffer.byteLength(oversizedResult) > 8192);
    assert.throws(() => buildAgentRequest({configuration: configuration(protocol), messages,
      readTools: {...answer, result: oversizedResult}, selfPort: 1}), {code: 'AGENT_CHAT_LIMIT'});
    const input = [{role: 'system' as const, content: TIMELINE_GAIN_EDIT_TOOL_SYSTEM_INSTRUCTION}, {role: 'user' as const, content: '界'.repeat(8500)}];
    assert.doesNotThrow(() => buildAgentRequest({configuration: configuration(protocol), messages: input, readTools: answer, selfPort: 1}));
    for (const extra of [{catalog: TIMELINE_GAIN_EDIT_TOOL_DEFINITIONS}, {scope: 'arbitrary'}, {operation: 'timeline.clip.update'}] as const)
      assert.throws(() => buildAgentRequest({configuration: configuration(protocol), messages, readTools: {...requestMode, ...extra}, selfPort: 1}));
    assert.throws(() => buildAgentRequest({configuration: configuration(protocol), messages: [{role: 'system' as const, content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user' as const, content: 'hello'}],
      readTools: {...answer, scope: undefined}, selfPort: 1}));
  });
}

for (const protocol of ['chat_completions', 'responses'] as const) {
  test(`${protocol}: duplicate function calls and changed terminal identities never expose a gain call`, async () => {
    const mutate = protocol === 'responses' ? [
(      events: ProviderEvent[]) => { events[2].item_id = 'fc_foreign'; },
(      events: ProviderEvent[]) => { events[4].arguments = '{"gain":0.5}'; },
(      events: ProviderEvent[]) => { events[5].item!.arguments = '{"gain":0.5}'; },
(      events: ProviderEvent[]) => { events.at(-1)!.response!.output.push({...events.at(-1)!.response!.output[0], id: 'fc_second', call_id: 'call_second'}); },
(      events: ProviderEvent[]) => { events.splice(5, 0, {type: 'response.output_item.added', output_index: 1,
        item: {...events[1].item!, id: 'fc_second', call_id: 'call_second'}});
        events.forEach((value, sequence_number) => { value.sequence_number = sequence_number; }); },
    ] : [
(      events: ProviderEvent[]) => { events[0].choices![0].delta.tool_calls!.push({...events[0].choices![0].delta.tool_calls![0], index: 1, id: 'call_second'}); },
(      events: ProviderEvent[]) => { events[1].choices![0].delta.tool_calls![0].index = 1; },
(      events: ProviderEvent[]) => { events[1].choices![0].delta.tool_calls![0].function!.name = name; },
(      events: ProviderEvent[]) => { events.at(-1)!.choices![0].finish_reason = 'stop'; },
(      events: ProviderEvent[]) => { events.at(-1)!.choices![0].finish_reason = 'length'; },
    ];
    for (const change of mutate) {
      const events = protocol === 'responses' ? responseEvents() : ccEvents(); change(events!);
      await assert.rejects(run(protocol, wire(protocol, events!)), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
    }
    if (protocol === 'responses') {
      const foreign = responseEvents(); foreign.at(-1)!.response!.output[0].name = 'mioon_propose_timeline_clip_move';
      await assert.rejects(run(protocol, wire(protocol, foreign)), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
      const events = responseEvents(); events.at(-1)!.type = 'response.incomplete';
      events.at(-1)!.response!.status = 'incomplete'; events.at(-1)!.response!.incomplete_details = {reason: 'max_output_tokens'};
      await assert.rejects(run(protocol, wire(protocol, events)), {code: 'AGENT_CHAT_TRUNCATED'});
    }
    await assert.rejects(run(protocol, wire(protocol) + 'data: {'), {code: 'AGENT_CHAT_TRUNCATED'});
  });
  test(`${protocol}: actual HTTP byte-fragmented UTF-8 gain call waits for clean EOF before dispatch`, async t => {
    const calls: Omit<HttpCapture,'headers'>[] = [], observed: AgentStreamItem[] = [], text = '音量提案 🎚️ pending review';
    let release!: ()=>void, markReady!: ()=>void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { markReady = resolve; });
    const events = protocol === 'responses' ? responseEvents() : [chunk({content: text}), ...ccEvents()];
    if (protocol === 'responses') {
      const part = {type: 'output_text', text, annotations: []}, item = {type: 'message', id: 'msg_gain_utf8', role: 'assistant' as const, status: 'completed', content: [part]};
      const key = {output_index: 0, item_id: item.id, content_index: 0};
      const textEvents = [
        {type: 'response.output_item.added', output_index: 0, item: {...item, status: 'in_progress', content: []}},
        {type: 'response.content_part.added', ...key, part: {...part, text: ''}},
        {type: 'response.output_text.delta', ...key, delta: text},
        {type: 'response.output_text.done', ...key, text},
        {type: 'response.content_part.done', ...key, part},
        {type: 'response.output_item.done', output_index: 0, item},
      ];
      for (const event of events) if (Object.hasOwn(event, 'output_index')) event.output_index = 1;
      events.splice(1, 0, ...textEvents); events.at(-1)!.response!.output.unshift(item);
      events.forEach((value, sequence_number) => { value.sequence_number = sequence_number; });
    }
    const server = createServer(async (request, response) => {
      const buffers = []; for await (const buffer of request) buffers.push(buffer);
      calls.push({path: request.url, body: JSON.parse((Buffer.concat(buffers).toString('utf8') as string))}!);
      response.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8'});
      for (const byte of Buffer.from(wire(protocol, events!))) response.write(Buffer.from([byte]));
      markReady(); await held; response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close((resolve as unknown as ()=>void))); });
    const config = {protocol, presetId: 'ollama', platformId: 'local', baseUrl: `http://127.0.0.1:${(server.address() as unknown as import('node:net').AddressInfo).port}/v1`, model: 'qwen3:8b'};
    const pending = (async () => {
      for await (const event of createAgentGateway()({configuration: config, messages, readTools: requestMode, selfPort: 1})) observed.push(event);
    })();
    await ready; await delay(25);
    assert.equal(observed.some(value => (value as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall), false, 'even a terminal frame does not authorize before clean transport EOF');
    release(); await pending;
    assert.equal(observed.filter(value => value.type === 'delta').map(value => value.text).join(''), text);
    assert.deepEqual((observed.at(-1) as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.arguments, {gain: 0.4});
    assert.equal(calls.length, 1); assert.equal(calls[0].path, protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions');
    if (protocol === 'responses') {assert.equal(calls[0].body.store, false); assert.equal(calls[0].body.previous_response_id, undefined);}
  });
}

test('gain-derived turns never become typed, inspection, shot, move or subsequent gain history', () => {
  const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  const timestamp = '2026-10-12T00:00:00.000Z';
  const clip = {id: id(5), trackId: id(3), assetId: id(6), name: 'Saved clip', startFrame: 30,
    durationFrames: 60, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1};
  const timeline = {id: id(1), projectId: id(2), revision: 4, fps: 30, width: 720, height: 1280,
    tracks: [{id: id(3), name: 'Saved track', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: [clip], durationFrames: 90, createdAt: timestamp, updatedAt: timestamp};
  const gainRun = {id: 'gain-source', status: 'completed', projectId: id(2), contextMode: 'selected_timeline_clip_gain',
    provenance: {category: 'project_selected_timeline_audio_gain'}, userText: 'PRIVATE_GAIN_SELECTED_NAME', assistantText: 'PRIVATE_GAIN_RESULT'};
  const typed = {id: 'typed-source', status: 'completed', projectId: id(2), userText: 'My typed question', assistantText: 'A typed-only answer'};
  const targets = {
    selected_shot_edit: {projectId: id(2), title: 'Saved shot', prompt: 'Saved prompt'},
    selected_timeline_clip_move: agentTimelineMoveTargetFromTimeline(timeline, clip.id),
    selected_timeline_clip_gain: agentTimelineGainTargetFromTimeline(timeline, clip.id, {id: clip.assetId, sha256: 'a'.repeat(64), mimeType: 'video/mp4', hasAudio: true}),
  };
  assert.ok(targets.selected_timeline_clip_move); assert.ok(targets.selected_timeline_clip_gain);
  for (const mode of ['typed_chat_only', 'project_inspection', ...Object.keys(targets)] as const) {
    const context = selectChatContext([typed, gainRun], 'Fresh typed text', mode, {contextBytes: 30000, historyRuns: 10}, (targets as Partial<Record<string,typeof targets[keyof typeof targets]>>)[mode]);
    assert.deepEqual(context.sourceRunIds, [typed.id]); assert.doesNotMatch(JSON.stringify(context.messages), /PRIVATE_GAIN/u);
  }
});

for (const protocol of ['chat_completions', 'responses'] as const) for (const boundary of ['before_dns', 'during_dns', 'during_connect', 'unchanged'] as const) {
  test(`${protocol}: gain beforeSubmit fence at ${boundary} gates actual request.end rather than only preflight`, {timeout: 10000}, async () => {
    const state = ({lookups: 0, requests: 0, bodyWrites: 0, fences: 0, changed: boundary === 'before_dns'} as unknown as MockRequestState);
    let unblock!: ()=>void, reachBoundary!: ()=>void;
    const reached = new Promise<void>(resolve => { reachBoundary = resolve; });
    const paused = new Promise<void>(resolve => { unblock = resolve; });
    const lookup = async () => {
      state.lookups++;
      if (boundary === 'during_dns') {reachBoundary(); await paused;}
      return [{address: '8.8.8.8', family: 4}];
    };
    const request = (_options: unknown, callback: (arg0: Readable) => void) => {
      state.requests++;
      const outgoing = (new EventEmitter() as unknown as MockRequest), socket = new EventEmitter();
      Object.assign(socket, {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {state.socketDestroyed = true;}});
      outgoing.setTimeout = () => {}; outgoing.destroy = () => {state.requestDestroyed = true;};
      outgoing.end = (body: string) => {
        state.bodyWrites++; state.body = JSON.parse((body as string));
        const incoming = (Readable.from([Buffer.from(wire(protocol))]) as unknown as MockIncoming);
        incoming.statusCode = 200; incoming.headers = {'content-type': 'text/event-stream'}; callback(incoming);
      };
      queueMicrotask(async () => {
        outgoing.emit('socket', socket);
        if (boundary === 'during_connect') {reachBoundary(); await paused;}
        socket.emit('secureConnect');
      });
      return outgoing;
    };
    const observed: AgentStreamItem[] = [];
    const pending = (async () => {
      for await (const event of createAgentGateway({lookup:(lookup as unknown as typeof import('node:dns/promises').lookup), httpsRequest:(request as unknown as typeof import('node:https').request)})({configuration: configuration(protocol),
        apiKey: 'SYNTHETIC_FAKE_ONLY', messages, readTools: requestMode, selfPort: 1,
        beforeSubmit() {state.fences++; if (state.changed) throw Object.assign(Error('Selected gain context changed'), {code: 'AGENT_CHAT_CONTEXT_CHANGED'});},
      })) observed.push(event);
    })();
    if (boundary.startsWith('during_')) {await reached; state.changed = true; unblock!();}
    if (boundary === 'unchanged') {
      await pending; assert.equal(state.bodyWrites, 1); assert.equal(state.fences, 3);
      assert.equal((observed.at(-1) as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall!.name, name);
    } else {
      await assert.rejects(pending, {code: 'AGENT_CHAT_CONTEXT_CHANGED'});
      assert.equal(state.bodyWrites, 0, 'the selected context is checked before request.end can send headers, credentials or body');
      assert.equal(observed.some(value => (value as import('../packages/business/src/agent/agent-gateway.ts').AgentStreamDone).toolCall), false);
      assert.equal(state.requests, boundary === 'during_connect' ? 1 : 0);
      assert.equal(state.lookups, boundary === 'before_dns' ? 0 : 1);
    }
  });
}
