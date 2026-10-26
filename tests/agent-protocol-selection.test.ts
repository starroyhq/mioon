import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {AGENT_PROTOCOLS, deriveAgentEndpoint} from '@mioon/contracts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {parseAgentConfiguration} from '../packages/business/src/agent/config.ts';
import {buildAgentRequest, createAgentGateway} from '../packages/business/src/agent/agent-gateway.ts';
import {agentChatProfile, AGENT_CHAT_PROFILES} from '../packages/business/src/agent/chat-completions.ts';
import {agentResponsesProfile, AGENT_RESPONSES_PROFILES} from '../packages/business/src/agent/responses.ts';
import {agentReadToolProfile, AGENT_READ_TOOL_PROFILES} from '../packages/business/src/agent/tool-wire.ts';
import {nativeAnthropicEvents, nativeAnthropicSse} from './helpers/anthropic-native-events.ts';

const messages = [{role: 'user', content: 'Offline protocol selection test'}];
function configuration(presetId: string, protocol: AgentProtocol): AgentConfiguration {
  const preset = AGENT_PRESETS.find(item => item.id === presetId)!;
  const platform = preset.platforms[0]!;
  return {presetId, platformId: platform.id, protocol,
    baseUrl: presetId === 'ollama' && protocol === 'anthropic_messages' ? new URL(platform.baseUrl).origin : platform.baseUrl || 'https://selection.example.com/v1',
    model: presetId === 'qwen' && protocol === 'responses' ? 'qwen3.8-flash' : platform.model || 'synthetic-model'};
}

test('every preset independently selects each implemented protocol and its own tool wire format', () => {
  for (const preset of AGENT_PRESETS) for (const protocol of Object.keys(AGENT_PROTOCOLS) as AgentProtocol[]) {
    const chosen = configuration(preset.id, protocol), before = structuredClone(chosen);
    assert.deepEqual(parseAgentConfiguration(chosen, {selfPort: 4318}), chosen);
    const body = JSON.parse(buildAgentRequest({configuration: chosen, messages, selfPort: 4318, readTools: {phase: 'request'}}).body) as Record<string, unknown>;
    assert.equal(body.model, chosen.model); assert.deepEqual(chosen, before);
    assert.equal(deriveAgentEndpoint(chosen), chosen.baseUrl + AGENT_PROTOCOLS[protocol].path);
    const tools = body.tools as Record<string, unknown>[]; assert.ok(tools.length);
    if (protocol === 'anthropic_messages') {
      assert.ok(tools.every(tool => tool.input_schema && !('function' in tool) && !('parameters' in tool)));
      assert.deepEqual(body.thinking, {type: 'disabled'}); assert.equal(body.max_tokens, 2048);
      for (const key of ['max_completion_tokens', 'input', 'instructions', 'store', 'reasoning', 'enable_thinking', 'parallel_tool_calls']) assert.equal(body[key], undefined);
    } else if (protocol === 'responses') {
      assert.ok(Array.isArray(body.input)); assert.equal(body.messages, undefined);
      assert.ok(tools.every(tool => tool.type === 'function' && tool.parameters && !('input_schema' in tool)));
    } else {
      assert.ok(Array.isArray(body.messages)); assert.equal(body.input, undefined);
      assert.ok(tools.every(tool => tool.type === 'function' && tool.function && !('input_schema' in tool)));
    }
  }
});

test('new combinations select a generic protocol template while existing profiles retain identity', () => {
  assert.equal(agentChatProfile(configuration('anthropic', 'chat_completions')), AGENT_CHAT_PROFILES.custom);
  assert.equal(agentResponsesProfile(configuration('minimax', 'responses')), AGENT_RESPONSES_PROFILES.custom);
  assert.equal(agentReadToolProfile(configuration('minimax', 'anthropic_messages')), AGENT_READ_TOOL_PROFILES.anthropic_messages.custom);
  for (const [presetId, profile] of Object.entries(AGENT_CHAT_PROFILES)) assert.equal(agentChatProfile(configuration(presetId, 'chat_completions')), profile);
  for (const [presetId, profile] of Object.entries(AGENT_RESPONSES_PROFILES)) assert.equal(agentResponsesProfile(configuration(presetId, 'responses')), profile);
  assert.throws(() => agentChatProfile(configuration('minimax', 'anthropic_messages')), {code: 'AGENT_CHAT_VALIDATION'});
  assert.throws(() => agentResponsesProfile(configuration('minimax', 'chat_completions')), {code: 'AGENT_CHAT_VALIDATION'});
  assert.throws(() => buildAgentRequest({configuration: {...configuration('qwen', 'responses'), model: 'qwen-plus'}, messages}), {code: 'AGENT_CHAT_PROFILE_UNSUPPORTED'});
});

test('keyless loopback Messages uses the real SDK without leaking its placeholder or widening network scope', async t => {
  const requests: {path: string | undefined; headers: Record<string, unknown>; body: unknown}[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    requests.push({path: request.url, headers: {...request.headers}, body: JSON.parse(Buffer.concat(chunks).toString())});
    response.writeHead(200, {'Content-Type': 'text/event-stream'}); response.end(nativeAnthropicSse(nativeAnthropicEvents()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => {server.close(() => resolve()); server.closeAllConnections();}));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const chosen = {...configuration('ollama', 'anthropic_messages'), baseUrl: `http://127.0.0.1:${address.port}`};
  const gateway = createAgentGateway({lookup: async () => assert.fail('Local requests do not use DNS')});
  const output = []; for await (const event of gateway({configuration: chosen, apiKey: null, messages, selfPort: 1})) output.push(event);
  assert.equal(output.at(-1)?.type, 'done'); assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, '/v1/messages'); assert.equal(requests[0]!.headers.authorization, undefined); assert.equal(requests[0]!.headers['x-api-key'], undefined);
  assert.equal(JSON.stringify(requests).includes('mioon-local-sdk-placeholder'), false);
  for (const baseUrl of [`${chosen.baseUrl}/v1`, 'http://8.8.8.8', 'http://localhost:4318', `${chosen.baseUrl}/other`]) {
    await assert.rejects(async () => {for await (const _event of gateway({configuration: {...chosen, baseUrl}, messages, selfPort: 4318})) { /* No dispatch is expected. */ }}, {code: 'AGENT_CHAT_VALIDATION'});
  }
  assert.equal(requests.length, 1);
});
