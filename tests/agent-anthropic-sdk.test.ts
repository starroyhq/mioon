import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {setTimeout as delay} from 'node:timers/promises';
import {buildAgentAnthropicBody, buildAgentAnthropicRequest, createAnthropicMessagesGateway} from '../packages/business/src/agent/anthropic-messages.ts';
import {createAgentGateway, buildAgentRequest} from '../packages/business/src/agent/agent-gateway.ts';
import {createAnthropicSdkTransport} from '../packages/business/src/agent/anthropic-sdk-transport.ts';
import {agentChatHttpStatus, safeAgentChatError} from '../packages/business/src/agent/chat-errors.ts';
import {wasAgentTransportSubmissionPrevented} from '../packages/business/src/agent/network-policy.ts';
import {CHAT_SYSTEM_INSTRUCTION, AGENT_CHAT_LIMITS} from '../packages/business/src/agent/chat-policy.ts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import type {AgentStreamItem, AgentStreamDone} from '../packages/business/src/agent/agent-gateway.ts';
import type {AgentTransportDependencies} from '../packages/business/src/agent/network-policy.ts';
import type {MockRequestState, MockRequest, MockIncoming} from './helpers/strict-agent-workspace-types.ts';
import {nativeAnthropicEvents, nativeAnthropicSse} from './helpers/anthropic-native-events.ts';

const configuration: AgentConfiguration = {protocol: 'anthropic_messages', presetId: 'custom', platformId: 'custom', baseUrl: 'https://fixture.example.com/anthropic', model: 'synthetic-text-model'};
const messages = [{role: 'user', content: 'Synthetic text, never a real provider request.'}];
const frame = (type: string, fields: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({type, ...fields})}\n\n`;
const start = () => frame('message_start', {message: {id: 'msg_fixture', type: 'message', role: 'assistant', model: configuration.model, content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 3, output_tokens: 1}}});
const finish = (reason = 'end_turn') => frame('message_delta', {delta: {stop_reason: reason, stop_sequence: null}, usage: {output_tokens: 3}}) + frame('message_stop');
const textBody = (reason = 'end_turn') => start() + frame('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}) + frame('content_block_delta', {index: 0, delta: {type: 'text_delta', text: '你好，Mio 🙂'}}) + frame('content_block_stop', {index: 0}) + finish(reason);
const toolBody = (name = 'mioon_project_inspect', argumentsJson = '{ }') => start() + frame('content_block_start', {index: 0, content_block: {type: 'tool_use', id: 'tool_fixture', name, input: {}}}) + frame('content_block_delta', {index: 0, delta: {type: 'input_json_delta', partial_json: argumentsJson}}) + frame('content_block_stop', {index: 0}) + finish('tool_use');
async function collect(source: AsyncIterable<AgentStreamItem>): Promise<AgentStreamItem[]> {const result: AgentStreamItem[] = []; for await (const item of source) result.push(item); return result;}

function socketFixture({body = textBody(), status = 200, peer = '8.8.8.8', authorized = true, noConnect = false, responseStream, rejectAfterEnd = false}: {body?: string; status?: number; peer?: string; authorized?: boolean; noConnect?: boolean; responseStream?: Readable; rejectAfterEnd?: boolean} = {}) {
  const state = {calls: 0, ends: 0, destroyed: false} as MockRequestState;
  state.request = (options, callback) => {
    state.calls++; state.options = options as MockRequestState['options'];
    const request = new EventEmitter() as MockRequest;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    request.setTimeout = (milliseconds, handler) => {readTimer = setTimeout(() => handler?.(), milliseconds);};
    request.destroy = () => {clearTimeout(readTimer); state.destroyed = true;};
    request.end = payload => {
      state.ends++; state.payload = payload;
      if (rejectAfterEnd) {queueMicrotask(() => request.emit('error', Error('synthetic-private-network-marker'))); return;}
      const response = (responseStream ?? Readable.from([Buffer.from(body)])) as MockIncoming;
      response.statusCode = status; response.headers = {'content-type': 'text/event-stream', 'x-private-provider': 'synthetic-header-marker'};
      state.response = response; callback(response);
    };
    queueMicrotask(() => {
      const socket = Object.assign(new EventEmitter(), {remoteAddress: peer, remotePort: 443, authorized, destroy() {state.destroyed = true;}});
      request.emit('socket', socket); assert.equal(state.ends, 0);
      if (!noConnect) socket.emit('secureConnect');
    });
    return request;
  };
  const dependencies: AgentTransportDependencies = {lookup: (async () => [{address: '8.8.8.8', family: 4}]) as unknown as AgentTransportDependencies['lookup'], httpsRequest: state.request as unknown as AgentTransportDependencies['httpsRequest']};
  return {state, dependencies};
}

test('Anthropic request compilation is native, bounded, key-free and protocol-specific', () => {
  const body = JSON.parse(buildAgentAnthropicBody({configuration, messages: [{role: 'system', content: CHAT_SYSTEM_INSTRUCTION}, ...messages]}).body) as Record<string, unknown>;
  assert.equal(body.system, CHAT_SYSTEM_INSTRUCTION); assert.deepEqual(body.messages, messages);
  assert.equal(body.max_tokens, AGENT_CHAT_LIMITS.maxOutputTokens); assert.equal(body.stream, true); assert.deepEqual(body.thinking, {type: 'disabled'});
  for (const field of ['store', 'input', 'instructions', 'previous_response_id', 'tools', 'tool_choice', 'max_completion_tokens']) assert.equal(body[field], undefined);
  assert.equal(buildAgentRequest({configuration, messages}).body, buildAgentAnthropicBody({configuration, messages}).body);
  const implicit = JSON.parse(buildAgentAnthropicBody({configuration, messages}).body) as Record<string, unknown>;
  assert.equal(implicit.system, CHAT_SYSTEM_INSTRUCTION); assert.deepEqual(implicit.messages, messages);
  assert.equal(implicit.system, body.system);
  for (const protocol of ['chat_completions', 'responses'] as const) assert.throws(() => buildAgentAnthropicBody({configuration: {...configuration, protocol}, messages}), {code: 'AGENT_CHAT_VALIDATION'});
  for (const patch of [{apiKey: null}, {apiKey: 'synthetic\nkey'}, {apiKey: '密钥'}]) assert.throws(() => buildAgentAnthropicRequest({configuration, messages, ...patch}), error => error instanceof Error && 'code' in error && ['AGENT_CHAT_KEY_REQUIRED', 'AGENT_CHAT_VALIDATION'].includes(String(error.code)));
  for (const input of [[{role: 'system', content: 'untrusted system'}], [{role: 'user', content: [{type: 'image', data: 'never-send'}]}], [{role: 'user', content: '\ud800'}]]) assert.throws(() => buildAgentAnthropicBody({configuration, messages: input}), {code: 'AGENT_CHAT_VALIDATION'});
  assert.throws(() => buildAgentAnthropicBody({configuration, messages: [{role: 'user', content: 'x'.repeat(AGENT_CHAT_LIMITS.maxInputBytes + 1)}]}), {code: 'AGENT_CHAT_LIMIT'});
  assert.throws(() => buildAgentAnthropicBody({configuration, messages: [{role: 'user', content: 'x'.repeat(AGENT_CHAT_LIMITS.maxInputBytes - Buffer.byteLength(CHAT_SYSTEM_INSTRUCTION) + 1)}]}), {code: 'AGENT_CHAT_LIMIT'});
});

test('real Anthropic SDK works from an isolated desktop-style static bundle', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-anthropic-sdk-bundle-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const outfile = path.join(root, 'backend.cjs');
  await build({entryPoints: [fileURLToPath(new URL('../packages/business/src/agent/anthropic-sdk-transport.ts', import.meta.url))], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', define: {'import.meta.url': '__mioon_import_meta_url'},
    banner: {js: 'const __mioon_import_meta_url = require("node:url").pathToFileURL(__filename).href;'}, logLevel: 'silent'});
  const bundled = createRequire(import.meta.url)(outfile) as {createAnthropicSdkTransport: typeof createAnthropicSdkTransport};
  const f = socketFixture(), request = buildAgentAnthropicBody({configuration, messages});
  const response = await bundled.createAnthropicSdkTransport(f.dependencies)({...request, apiKey: 'synthetic-bound-key'});
  let received = '';
  for await (const chunk of response.body) received += Buffer.from(chunk).toString('utf8');
  assert.equal(received, textBody()); assert.equal(f.state.calls, 1); assert.equal(f.state.ends, 1);
  assert.equal(f.state.payload, request.body); assert.equal(f.state.options.path, '/anthropic/v1/messages');
  assert.equal(f.state.options.headers['x-api-key'], 'synthetic-bound-key'); assert.equal(f.state.options.headers['anthropic-version'], '2023-06-01');
});

test('real Anthropic SDK serializes exact accepted bytes through one pinned host request', async () => {
  const f = socketFixture(), built = buildAgentAnthropicBody({configuration, messages});
  const items = await collect(createAgentGateway(f.dependencies)({configuration, messages, apiKey: 'synthetic-bound-key'}));
  assert.deepEqual(items, [{type: 'delta', text: '你好，Mio 🙂'}, {type: 'done', finishReason: 'stop', usage: {prompt_tokens: 3, completion_tokens: 3, total_tokens: 6}}]);
  assert.equal(f.state.calls, 1); assert.equal(f.state.ends, 1); assert.equal(f.state.payload, built.body);
  assert.equal(f.state.options.path, '/anthropic/v1/messages'); assert.equal(f.state.options.hostname, 'fixture.example.com');
  assert.equal(f.state.options.headers['x-api-key'], 'synthetic-bound-key'); assert.equal(f.state.options.headers['anthropic-version'], '2023-06-01');
  assert.equal(f.state.options.headers.Authorization, undefined); assert.equal(f.state.options.rejectUnauthorized, true); assert.equal(f.state.destroyed, true);
});

test('the official Anthropic preset uses its root endpoint without changing model or token budget', async () => {
  const official: AgentConfiguration = {protocol: 'anthropic_messages', presetId: 'anthropic', platformId: 'global', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5'};
  const f = socketFixture();
  await collect(createAgentGateway(f.dependencies)({configuration: official, messages, apiKey: 'synthetic-bound-key'}));
  const body = JSON.parse(String(f.state.payload)) as Record<string, unknown>;
  assert.equal(f.state.options.hostname, 'api.anthropic.com'); assert.equal(f.state.options.path, '/v1/messages');
  assert.equal(body.model, official.model); assert.equal(body.max_tokens, 2048); assert.equal(f.state.calls, 1);
});

test('full SDK-typed native text and direct-tool events complete through the real SDK gateway', async () => {
  const text = socketFixture({body: nativeAnthropicSse(nativeAnthropicEvents())});
  const result = await collect(createAgentGateway(text.dependencies)({configuration, messages, apiKey: 'synthetic-bound-key'}));
  assert.deepEqual(result, [{type: 'delta', text: '你好，Mio 🙂'}, {type: 'done', finishReason: 'stop', usage: {prompt_tokens: 3, completion_tokens: 3, total_tokens: 6}}]);
  const tools = socketFixture({body: nativeAnthropicSse(nativeAnthropicEvents({toolName: 'mioon_project_inspect'}))});
  const tool = (await collect(createAgentGateway(tools.dependencies)({configuration, messages, apiKey: 'synthetic-bound-key', readTools: {phase: 'request'}}))).at(-1)! as AgentStreamDone;
  assert.equal(tool.finishReason, 'tool_calls'); assert.equal(tool.toolCall?.id, 'tool_native_fixture');
  assert.deepEqual(tool.providerOutput, {role: 'assistant', content: [{type: 'tool_use', id: 'tool_native_fixture', name: 'mioon_project_inspect', input: {}}]});
  assert.equal(text.state.calls, 1); assert.equal(tools.state.calls, 1);
});

test('SDK environment defaults, extra headers, credentials and telemetry cannot reach host dispatch', async t => {
  const environment: Record<string, string> = {ANTHROPIC_API_KEY: 'synthetic-env-key', ANTHROPIC_AUTH_TOKEN: 'synthetic-env-token', ANTHROPIC_PROFILE: 'synthetic-missing-profile', ANTHROPIC_BASE_URL: 'https://private.invalid', ANTHROPIC_WEBHOOK_SIGNING_KEY: 'synthetic-webhook-key', ANTHROPIC_CUSTOM_HEADERS: 'Cookie: synthetic-env-cookie\nx-api-key: synthetic-env-header\nanthropic-version: wrong-version', ANTHROPIC_LOG: 'debug', ANTHROPIC_OPEN_TELEMETRY: 'true'};
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  t.after(() => {for (const [key, value] of previous) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}});
  Object.assign(process.env, environment);
  const f = socketFixture(); await collect(createAnthropicMessagesGateway(f.dependencies)({configuration, messages, apiKey: 'synthetic-bound-key'}));
  assert.equal(f.state.calls, 1); assert.equal(f.state.options.hostname, 'fixture.example.com');
  const serialized = JSON.stringify(f.state.options);
  for (const marker of ['synthetic-env', 'synthetic-webhook', 'private.invalid', 'wrong-version']) assert.equal(serialized.includes(marker), false);
  assert.equal(f.state.options.headers.Cookie, undefined); assert.equal(f.state.options.headers.Authorization, undefined);
});

test('real SDK request transformations fail before any socket when they differ from frozen intent', async () => {
  const f = socketFixture();
  const body = JSON.stringify({...JSON.parse(buildAgentAnthropicBody({configuration, messages}).body), user_profile_id: 'sdk-would-move-this-to-headers'});
  await assert.rejects(createAnthropicSdkTransport(f.dependencies)({configuration, body, apiKey: 'synthetic-key'}), {code: 'AGENT_CHAT_VALIDATION'});
  assert.equal(f.state.calls, 0); assert.equal(f.state.ends, 0);
});

test('an SDK dispatch freezes the original body and credential before asynchronous hooks', async () => {
  const f = socketFixture(), request = buildAgentAnthropicBody({configuration, messages});
  const options = {...request, apiKey: 'synthetic-bound-key'};
  const opening = createAnthropicSdkTransport(f.dependencies)(options);
  options.body = '{}'; options.apiKey = 'synthetic-changed-key';
  options.configuration.protocol = 'chat_completions';
  const response = await opening;
  for await (const _chunk of response.body) {}
  assert.equal(f.state.payload, request.body); assert.equal(f.state.options.headers['x-api-key'], 'synthetic-bound-key');
  assert.equal(f.state.options.headers.Authorization, undefined); assert.equal(f.state.calls, 1);
});

test('HTTP failures, redirects and ambiguous accepted-response loss are never retried or rerouted', async () => {
  for (const status of [301, 400, 401, 429, 500, 503]) {
    const f = socketFixture({status, body: JSON.stringify({error: {message: 'synthetic-private-provider-marker'}})});
    let failure: unknown;
    await assert.rejects(collect(createAnthropicMessagesGateway(f.dependencies)({configuration, messages, apiKey: 'synthetic-key'})), error => {failure = error; return error instanceof Error && 'code' in error && error.code === 'AGENT_CHAT_HTTP_ERROR';});
    assert.equal(agentChatHttpStatus(failure), status); assert.equal(f.state.calls, 1); assert.equal(f.state.ends, 1);
    assert.equal(JSON.stringify(safeAgentChatError(failure)).includes('marker'), false);
  }
  const lost = socketFixture({rejectAfterEnd: true});
  await assert.rejects(collect(createAnthropicMessagesGateway(lost.dependencies)({configuration, messages, apiKey: 'synthetic-key'})), {code: 'AGENT_CHAT_CONNECT_FAILED'});
  assert.equal(lost.state.calls, 1); assert.equal(lost.state.ends, 1);
});

test('DNS/private peer and invalid TLS are denied before a body or bound key is written', async () => {
  for (const patch of [{peer: '127.0.0.1'}, {peer: '1.1.1.1'}, {authorized: false}]) {
    const f = socketFixture(patch);
    await assert.rejects(collect(createAnthropicMessagesGateway(f.dependencies)({configuration, messages, apiKey: 'synthetic-key'})), {code: 'authorized' in patch ? 'AGENT_CHAT_CONNECT_FAILED' : 'AGENT_CHAT_NETWORK_DENIED'});
    assert.equal(f.state.ends, 0);
  }
  const f = socketFixture();
  await assert.rejects(collect(createAnthropicMessagesGateway({...f.dependencies, lookup: (async () => [{address: '8.8.8.8', family: 4}, {address: '127.0.0.1', family: 4}]) as unknown as AgentTransportDependencies['lookup']})({configuration, messages, apiKey: 'synthetic-key'})), {code: 'AGENT_CHAT_NETWORK_DENIED'});
  assert.equal(f.state.calls, 0);
});

test('host connect/read/total deadlines remain TIMEOUT and never produce a second POST', async () => {
  for (const phase of ['connect', 'read', 'total'] as const) {
    const f = socketFixture(phase === 'connect' ? {noConnect: true} : {responseStream: new Readable({read() {}})});
    const limits = {connectTimeoutMs: 500, readTimeoutMs: 500, totalTimeoutMs: 500, [`${phase}TimeoutMs`]: 15};
    await assert.rejects(collect(createAnthropicMessagesGateway({...f.dependencies, limits})({configuration, messages, apiKey: 'synthetic-key'})), {code: 'AGENT_CHAT_TIMEOUT'});
    assert.equal(f.state.calls, 1); assert.equal(f.state.ends, phase === 'connect' ? 0 : 1); assert.equal(f.state.destroyed, true);
  }
});

test('abort before and after dispatch and a changed send fence retain their exact local evidence', async () => {
  const aborted = new AbortController(); aborted.abort(); const first = socketFixture();
  await assert.rejects(collect(createAnthropicMessagesGateway(first.dependencies)({configuration, messages, apiKey: 'synthetic-key', signal: aborted.signal})), {code: 'AGENT_CHAT_ABORTED'});
  assert.equal(first.state.calls, 0);
  const f = socketFixture({responseStream: new Readable({read() {}})}), controller = new AbortController();
  const waiting = collect(createAnthropicMessagesGateway(f.dependencies)({configuration, messages, apiKey: 'synthetic-key', signal: controller.signal}));
  await delay(5); controller.abort(); await assert.rejects(waiting, {code: 'AGENT_CHAT_ABORTED'}); assert.equal(f.state.ends, 1); assert.equal(f.state.calls, 1);
  const blocked = socketFixture(); let failure: unknown;
  await assert.rejects(collect(createAnthropicMessagesGateway(blocked.dependencies)({configuration, messages, apiKey: 'synthetic-key', beforeSubmit() {throw Error('synthetic-private-fence-marker');}})), error => {failure = error; return error instanceof Error && 'code' in error && error.code === 'AGENT_CHAT_CONTEXT_CHANGED';});
  assert.equal(wasAgentTransportSubmissionPrevented(failure), true); assert.equal(blocked.state.calls, 0);
});

test('native read tool request/result/answer round trip keeps exact scope and final tools disabled', async () => {
  const first = socketFixture({body: toolBody()}), state = {phase: 'request' as const};
  const events = await collect(createAnthropicMessagesGateway(first.dependencies)({configuration, messages, apiKey: 'synthetic-key', readTools: state}));
  const done = events.at(-1)! as AgentStreamDone;
  assert.equal(done.finishReason, 'tool_calls'); assert.equal(done.toolCall!.name, 'mioon_project_inspect'); assert.equal(done.toolCall!.argumentsJson, '{ }');
  const request = JSON.parse(String(first.state.payload)) as {tools: {name: string; input_schema: unknown}[]; tool_choice: unknown};
  assert.deepEqual(request.tools.map(tool => tool.name), READ_TOOL_DEFINITIONS.map(tool => tool.name));
  assert.deepEqual(request.tools[0]!.input_schema, READ_TOOL_DEFINITIONS[0]!.parameters);
  assert.deepEqual(request.tool_choice, {type: 'auto', disable_parallel_tool_use: true});
  const second = socketFixture(), readTools = {phase: 'answer' as const, toolCall: done.toolCall, providerOutput: done.providerOutput, result: '{"project":"Synthetic"}'};
  const result = await collect(createAnthropicMessagesGateway(second.dependencies)({configuration, messages, apiKey: 'synthetic-key', readTools}));
  assert.equal((result.at(-1)! as AgentStreamDone).finishReason, 'stop');
  const answer = JSON.parse(String(second.state.payload)) as {tools: unknown[]; tool_choice: unknown; messages: unknown[]};
  assert.deepEqual(answer.tools, []); assert.deepEqual(answer.tool_choice, {type: 'none'});
  assert.deepEqual(answer.messages.slice(-2), [{role: 'assistant', content: [{type: 'tool_use', id: 'tool_fixture', name: 'mioon_project_inspect', input: {}}]}, {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tool_fixture', content: readTools.result}]}]);
  const forbidden = socketFixture({body: toolBody()});
  await assert.rejects(collect(createAnthropicMessagesGateway(forbidden.dependencies)({configuration, messages, apiKey: 'synthetic-key', readTools})), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  assert.equal(first.state.calls + second.state.calls, 2); assert.equal(forbidden.state.calls, 1);
});

test('unknown/read-only scope escalation or malformed tool JSON never becomes a tool completion', async () => {
  for (const source of [toolBody('delete_everything'), toolBody('mioon_project_inspect', '{"a":1,"a":2}'), toolBody() + frame('message_stop'), toolBody().replace(frame('message_stop'), '')]) {
    const f = socketFixture({body: source}), delivered: AgentStreamItem[] = [];
    await assert.rejects(async () => {for await (const item of createAnthropicMessagesGateway(f.dependencies)({configuration, messages, apiKey: 'synthetic-key', readTools: {phase: 'request'}})) delivered.push(item);});
    assert.equal(delivered.some(item => item.type === 'done'), false); assert.equal(f.state.calls, 1);
  }
  const normal = socketFixture({body: toolBody()});
  await assert.rejects(collect(createAnthropicMessagesGateway(normal.dependencies)({configuration, messages, apiKey: 'synthetic-key'})), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
});

test('max_tokens/refusal stay explicit and partial tool JSON never gains an executable done', async () => {
  for (const [reason, expected] of [['max_tokens', 'length'], ['refusal', 'content_filter']] as const) {
    const f = socketFixture({body: textBody(reason)});
    const result = await collect(createAnthropicMessagesGateway(f.dependencies)({configuration, messages, apiKey: 'synthetic-key'}));
    assert.equal((result.at(-1)! as AgentStreamDone).finishReason, expected);
  }
  const partial = socketFixture({body: toolBody('mioon_project_inspect', '{',).replace('"stop_reason":"tool_use"', '"stop_reason":"max_tokens"')});
  await assert.rejects(collect(createAnthropicMessagesGateway(partial.dependencies)({configuration, messages, apiKey: 'synthetic-key', readTools: {phase: 'request'}})), {code: 'AGENT_CHAT_TRUNCATED'});
});
