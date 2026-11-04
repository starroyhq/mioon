import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFileSync, writeFileSync} from 'node:fs';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import type {IncomingMessage} from 'node:http';
import {AGENT_PRESETS} from '../../packages/business/src/agent/presets.ts';
import type {AgentConfiguration} from '../../packages/business/src/agent/config.ts';
import {resolveAgentPresetBaseUrl} from '../../packages/contracts/src/agent-provider-catalog.ts';
import {deriveAgentEndpoint} from '../../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson} from '../../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTransportDependencies} from '../../packages/business/src/agent/network-policy.ts';
import {buildTaskModelRequest, createTaskGateway, taskContinuation} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelOutput, TaskToolDefinition} from '../../packages/business/src/agent/task-gateway-v2.ts';
import {listAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {selectTaskModelTools} from '../../packages/business/src/agent/task-context-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import {nativeAnthropicEvents, nativeAnthropicSse} from './anthropic-native-events.ts';

const fixtureFile = fileURLToPath(new URL('../fixtures/agent-generic-request-fingerprints.json', import.meta.url));
export const GENERIC_MODEL = 'synthetic-unverified-chat-model';
export const GENERIC_READER = 'mioon_shot_inspect';
const syntheticKey = 'SYNTHETIC_GENERIC_WIRE_ONLY';
const object = (value: unknown): Record<string, unknown> => {assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;};
const json = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
export interface GenericFingerprint {
  presetId: string; platformId: string; protocol: AgentConfiguration['protocol']; scenario: 'text' | 'tool_roundtrip'; index: number;
  endpoint: string; headers: Record<string, string>; bytes: number; sha256: string;
}
export function genericConfigurations(): AgentConfiguration[] {
  return AGENT_PRESETS.flatMap(preset => preset.platforms.flatMap(platform => platform.availableProtocols.map(protocol => {
    const input = platform.addressMode === 'workspace' ? 'synthetic-workspace' : platform.addressMode === 'local' ? 'http://127.0.0.1:11434' : platform.addressMode === 'custom' ? 'https://gateway.example.com/team/v1' : undefined;
    return {presetId: preset.id, platformId: platform.id, protocol, model: GENERIC_MODEL,
      baseUrl: resolveAgentPresetBaseUrl(AGENT_PRESETS, preset.id, platform.id, protocol, input)};
  })));
}
export function genericSse(configuration: AgentConfiguration, call?: {id: string; name: string; arguments: AgentTaskJson}, options: {reasoning?: boolean; omitDone?: boolean} = {}): string {
  if (configuration.protocol === 'anthropic_messages') {
    const events = nativeAnthropicEvents({model: configuration.model, text: 'Synthetic generic reply', ...(call ? {toolName: call.name, argumentsJson: JSON.stringify(call.arguments)} : {})});
    if (call) for (const event of events) if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') event.content_block.id = call.id;
    if (options.reasoning) {
      events[1] = {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: '', signature: ''}};
      events[2] = {type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'SYNTHETIC_PRIVATE_REASONING'}};
    }
    return nativeAnthropicSse(events);
  }
  if (configuration.protocol === 'chat_completions') {
    return json({choices: [{index: 0, delta: {role: 'assistant', ...(options.reasoning ? {reasoning_content: 'SYNTHETIC_PRIVATE_REASONING'} : {}),
      ...(call ? {tool_calls: [{index: 0, id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}]} : {content: 'Synthetic generic reply'})}, finish_reason: null}]}) +
      json({choices: [{index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop'}]}) + (options.omitDone ? '' : 'data: [DONE]\n\n');
  }
  const id = 'resp_generic', item = options.reasoning ? {id: 'rs_generic', type: 'reasoning', summary: []} : call
    ? {id: 'fc_' + call.id, type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed'}
    : {id: 'msg_generic', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'Synthetic generic reply', annotations: []}]};
  const frames: unknown[] = [{type: 'response.created', response: {id, status: 'in_progress', output: []}},
    {type: 'response.output_item.added', output_index: 0, item: call ? {...item, arguments: '', status: 'in_progress'} : item}];
  if (!options.reasoning) {
    if (call) frames.push({type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: JSON.stringify(call.arguments)},
      {type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, name: call.name, arguments: JSON.stringify(call.arguments)});
    else frames.push({type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'Synthetic generic reply'},
      {type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text: 'Synthetic generic reply'});
  }
  frames.push({type: 'response.output_item.done', output_index: 0, item}, {type: 'response.completed', response: {id, status: 'completed', output: [item]}});
  return frames.map(json).join('');
}
/** Only the trusted network construction seam is replaced. SDK serialization,
 * exact endpoint/DNS/peer/TLS/auth headers and bounded SSE parsing stay real. */
export function genericNetwork(configuration: AgentConfiguration, responseBody: string, status = 200) {
  const requests: Array<{endpoint: string; headers: Record<string, string>; body: string}> = [];
  let constructions = 0;
  const request = (options: unknown, callback: (incoming: IncomingMessage) => void) => {
    const selected = object(options); constructions++;
    const outgoing = Object.assign(new EventEmitter(), {setTimeout() {}, destroy() {}, end(body: string) {
      const headers = object(selected.headers), safeHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => {
        assert.equal(typeof value, 'string');
        if (key === 'Authorization') {assert.equal(value, `Bearer ${syntheticKey}`); return [key, 'Bearer <synthetic>'];}
        if (key === 'x-api-key') {assert.equal(value, syntheticKey); return [key, '<synthetic>'];}
        return [key, String(value)];
      }));
      const endpoint = `${selected.protocol}//${selected.hostname}${Number(selected.port) === (selected.protocol === 'https:' ? 443 : 80) ? '' : ':' + selected.port}${selected.path}`;
      assert.equal(endpoint, deriveAgentEndpoint(configuration)); assert.equal(safeHeaders['Content-Length'], String(Buffer.byteLength(body)));
      requests.push({endpoint, headers: safeHeaders, body});
      callback(Object.assign(Readable.from([Buffer.from(responseBody)]), {statusCode: status, headers: {'content-type': 'text/event-stream'}}) as unknown as IncomingMessage);
    }});
    queueMicrotask(() => {
      const socket = Object.assign(new EventEmitter(), {remoteAddress: configuration.presetId === 'ollama' ? '127.0.0.1' : '8.8.8.8', remotePort: Number(selected.port), authorized: true, destroy() {}});
      outgoing.emit('socket', socket); socket.emit(selected.protocol === 'https:' ? 'secureConnect' : 'connect');
    });
    return outgoing;
  };
  const dependencies = {lookup: async () => [{address: configuration.presetId === 'ollama' ? '127.0.0.1' : '8.8.8.8', family: 4}], httpsRequest: request, httpRequest: request} as unknown as AgentTransportDependencies;
  return {requests, dependencies, get constructions() {return constructions;}};
}
export async function genericRound(configuration: AgentConfiguration, body: string, frames: string): Promise<{output: TaskModelOutput; request: {endpoint: string; headers: Record<string, string>; body: string}}> {
  const network = genericNetwork(configuration, frames); let output: TaskModelOutput | undefined;
  for await (const item of createTaskGateway(network.dependencies)({configuration, body, apiKey: syntheticKey, selfPort: 4318})) if (item.type === 'done') output = item.output;
  assert.ok(output); assert.equal(network.requests.length, 1); assert.equal(network.requests[0]!.body, body, 'SDK must preserve the exact already-built request bytes');
  return {output, request: network.requests[0]!};
}
export async function collectGenericRequestFingerprints(onRequest?: (row: GenericFingerprint, body: string) => void): Promise<GenericFingerprint[]> {
  const rows: GenericFingerprint[] = [], catalog = listAgentTaskTools(), core = selectTaskModelTools(catalog), reader = catalog.find(tool => tool.name === GENERIC_READER); assert.ok(reader);
  for (const configuration of genericConfigurations()) {
    const base: AgentTaskJson[] = [{role: 'user', content: 'Synthetic generic profile fixture; load and read only.'}];
    async function send(scenario: GenericFingerprint['scenario'], index: number, history: AgentTaskJson[], tools: readonly TaskToolDefinition[], call?: {id: string; name: string; arguments: AgentTaskJson}) {
      const body = buildTaskModelRequest(configuration, history, tools, 4318, {toolLoading: true}), result = await genericRound(configuration, body, genericSse(configuration, call));
      const row = {...configuration, scenario, index, endpoint: result.request.endpoint, headers: result.request.headers,
        bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex')};
      const {baseUrl: _base, model: _model, ...fingerprint} = row; rows.push(fingerprint); onRequest?.(fingerprint, body); return result.output;
    }
    assert.equal((await send('text', 1, base, core)).text, 'Synthetic generic reply');
    const loaded = await send('tool_roundtrip', 1, base, core, {id: 'call_loader', name: AGENT_TASK_TOOLS_LOAD_NAME, arguments: {names: [GENERIC_READER]}});
    assert.deepEqual(loaded.toolCalls.map(call => call.name), [AGENT_TASK_TOOLS_LOAD_NAME]);
    const afterLoad = [...base, ...taskContinuation(configuration.protocol, loaded, [{callId: loaded.toolCalls[0]!.id, result: {names: [GENERIC_READER], tools: [GENERIC_READER]}}])];
    const read = await send('tool_roundtrip', 2, afterLoad, [...core, reader], {id: 'call_reader', name: GENERIC_READER, arguments: {}});
    assert.deepEqual(read.toolCalls.map(call => call.name), [GENERIC_READER]);
    const afterRead = [...afterLoad, ...taskContinuation(configuration.protocol, read, [{callId: read.toolCalls[0]!.id, result: {shots: []}}])];
    assert.equal((await send('tool_roundtrip', 3, afterRead, [...core, reader])).text, 'Synthetic generic reply');
  }
  return rows;
}
export function readGenericRequestFingerprints(): GenericFingerprint[] {
  return JSON.parse(readFileSync(fixtureFile, 'utf8')).requests as GenericFingerprint[];
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--write') throw new Error('Use --write only after reviewing the new generic profiles');
  const requests = await collectGenericRequestFingerprints();
  writeFileSync(fixtureFile, JSON.stringify({version: 1, note: 'X6a generic templates only; no existing 99-request fixture is replaced or updated.', requests}, null, 2) + '\n');
  process.stdout.write(`Wrote ${requests.length} new generic request fingerprints.\n`);
}
