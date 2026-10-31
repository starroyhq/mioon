import {assertAgentGainRequestBudget} from './gain-context-fence.ts';
import {exactObject, MAX_AGENT_SECRET_BYTES} from './config.ts';
import type {AgentConfiguration} from './config.ts';
import {AGENT_CHAT_LIMITS, CHAT_SYSTEM_INSTRUCTION} from './chat-policy.ts';
import {agentChatError, errorCode} from './chat-errors.ts';
import {agentResponsesProfile, validateAgentResponsesProfile} from './model-profiles.ts';
export {AGENT_RESPONSES_PROFILES, agentResponsesProfile} from './model-profiles.ts';
import {createOpenAiSdkTransport} from './openai-sdk-transport.ts';
import type {AgentTransportDependencies, AgentTransportStream} from './network-policy.ts';
import {parseAgentSse, AGENT_SSE_LIMITS} from './sse.ts';
import {isDeepStrictEqual} from 'node:util';
import {toolScope, validateReadTools, readToolRequestFields, readToolMessages, normalizeToolCall, responseToolSnapshot, compareResponseTool, responseToolContinuation} from './tool-wire.ts';
import type {WireMessage, ReadToolState, ResponseToolSnapshot} from './tool-wire.ts';
import type {AgentGateway, AgentUsage} from './agent-gateway.ts';

// Qwen cannot disable provider-side truncation. Its documented 1M-token model
// context is far above this adapter's 32KiB text cap; no native override is sent.
export const AGENT_RESPONSES_LIMITS = Object.freeze({maxInputBytes: 32 * 1024, maxItems: 64, maxParts: 128, maxIdBytes: 256});
const wellFormed = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code: string): never { throw agentChatError(code); }
function protocol(): never { return fail('AGENT_CHAT_PROTOCOL_ERROR'); }
const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
function validString(value: unknown, maximum: number = AGENT_CHAT_LIMITS.maxOutputBytes): value is string {
  return typeof value === 'string' && wellFormed(value) && Buffer.byteLength(value) <= maximum;
}
function id(value: unknown): string { if (!validString(value, AGENT_RESPONSES_LIMITS.maxIdBytes) || !value || /[\u0000-\u0020\u007f]/u.test(value)) protocol(); return value; }
function index(value: unknown, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < 0) protocol(); if ((value as number) >= maximum) fail('AGENT_CHAT_LIMIT'); return value as number; }
function rejectFeatures(value: unknown, {responseConfiguration = false, functionArguments = false}: {responseConfiguration?: boolean; functionArguments?: boolean} = {}): void {
  if (!object(value)) return;
  if (['tool_calls', 'function_call', 'call_id', ...(functionArguments ? [] : ['arguments'])].some(key => present(value[key]))) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
  if (!responseConfiguration && present(value.reasoning)) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
  if (['reasoning_content', 'reasoning_details', 'encrypted_content', 'thinking', 'signature', 'continuation', 'previous_response_id', 'phase'].some(key => present(value[key]))) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
}
export interface AgentResponsesValidationOptions {selfPort?: number; readTools?: unknown}
export function validateAgentResponsesConfiguration(configuration: unknown, {selfPort, readTools}: AgentResponsesValidationOptions = {}): AgentConfiguration {
  const config = validateAgentResponsesProfile(configuration, {selfPort});
  validateReadTools(config, readTools);
  return config;
}
export interface AgentResponsesRequestOptions {
  configuration: unknown;
  apiKey?: unknown;
  messages: readonly WireMessage[];
  selfPort?: number;
  readTools?: unknown;
}
export function buildAgentResponsesRequest({configuration, apiKey, messages, selfPort, readTools}: AgentResponsesRequestOptions): {configuration: AgentConfiguration; body: string} {
  const config = validateAgentResponsesConfiguration(configuration, {selfPort, readTools});
  if (config.presetId !== 'ollama' && (typeof apiKey !== 'string' || !apiKey)) fail('AGENT_CHAT_KEY_REQUIRED');
  if (apiKey != null && apiKey !== '' && (typeof apiKey !== 'string' || Buffer.byteLength(apiKey) > MAX_AGENT_SECRET_BYTES || !/^[\x21-\x7e]+$/.test(apiKey))) fail('AGENT_CHAT_VALIDATION');
  return buildAgentResponsesBody({configuration: config, messages, selfPort, readTools});
}
/** Pure key-free request compilation for acceptance/journaling. */
export function buildAgentResponsesBody({configuration, messages, selfPort, readTools}: {configuration: unknown; messages: readonly WireMessage[]; selfPort?: number; readTools?: unknown}): {configuration: AgentConfiguration; body: string} {
  const config = validateAgentResponsesConfiguration(configuration, {selfPort, readTools});
  if (!Array.isArray(messages) || !messages.length || messages.length > AGENT_CHAT_LIMITS.maxMessages) fail('AGENT_CHAT_VALIDATION');
  const readState = readTools as ReadToolState | undefined;
  // The fixed runtime instruction is never customizable by model/user input.
  const instructions = readState ? toolScope(readState).instruction : CHAT_SYSTEM_INSTRUCTION;
  let list = messages;
  if (readState) list = readToolMessages(list, readState);
  let inputBytes = Buffer.byteLength(instructions);
  const input: Array<Record<string, unknown>> = [];
  for (const [position, message] of list.entries()) {
    if (!exactObject(message, ['role', 'content']) || !validString(message.content, AGENT_CHAT_LIMITS.maxInputBytes)) fail('AGENT_CHAT_VALIDATION');
    if (message.role === 'system') {
      if (position !== 0 || message.content !== instructions) fail('AGENT_CHAT_VALIDATION');
      continue;
    }
    if ((message.role !== 'user' && message.role !== 'assistant') || message.role !== (input.length % 2 === 0 ? 'user' : 'assistant')) fail('AGENT_CHAT_VALIDATION');
    inputBytes += Buffer.byteLength(message.content);
    if (inputBytes > (readState ? toolScope(readState).limits.maxContextBytes : AGENT_RESPONSES_LIMITS.maxInputBytes)) fail('AGENT_CHAT_LIMIT');
    input.push({role: message.role, content: message.content});
  }
  if (!input.length || input.at(-1)?.role !== 'user') fail('AGENT_CHAT_VALIDATION');
  if (readState?.phase === 'answer') {
    input.push(...(responseToolContinuation(readState, messageSnapshot, AGENT_RESPONSES_LIMITS.maxItems) as Array<Record<string, unknown>>));
    const continuationScope = ['selected_shot_edit', 'selected_timeline_clip_move', 'selected_timeline_clip_gain'].includes(readState.scope as string);
    if (Buffer.byteLength(JSON.stringify(input)) + Buffer.byteLength(instructions) > (continuationScope ? (toolScope(readState).limits.maxContinuationBytes as number) : AGENT_RESPONSES_LIMITS.maxInputBytes)) fail('AGENT_CHAT_LIMIT');
  }
  const body = JSON.stringify({model: config.model, stream: true, store: false, max_output_tokens: AGENT_CHAT_LIMITS.maxOutputTokens,
    instructions, input, ...agentResponsesProfile(config).fields, ...readToolRequestFields(config, readState)});
  if (Buffer.byteLength(body) > AGENT_CHAT_LIMITS.maxRequestBytes) fail('AGENT_CHAT_LIMIT');
  assertAgentGainRequestBudget(body, readState);
  return {configuration: config, body};
}
function safeUsage(value: unknown): AgentUsage | undefined {
  if (value == null) return undefined;
  if (!object(value)) protocol();
  const mapped: Array<[string, string]> = [['input_tokens', 'prompt_tokens'], ['output_tokens', 'completion_tokens'], ['total_tokens', 'total_tokens']];
  const totals: Record<string, number> = {};
  for (const [source, target] of mapped) {
    const count = value[source];
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 10_000_000) protocol();
    totals[target] = count as number;
  }
  const prompt = totals.prompt_tokens, completion = totals.completion_tokens, total = totals.total_tokens;
  if (completion > AGENT_CHAT_LIMITS.maxOutputTokens) fail('AGENT_CHAT_LIMIT');
  if (total !== prompt + completion) protocol();
  for (const [field, maximum] of [['input_tokens_details', prompt], ['output_tokens_details', completion]] as Array<[string, number]>) {
    const details = value[field];
    if (details == null) continue;
    if (!object(details)) protocol();
    for (const [key, number] of Object.entries(details)) {
      if (!Number.isSafeInteger(number) || (number as number) < 0 || (number as number) > maximum) protocol();
      if (key === 'reasoning_tokens' && (number as number) > 0) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
    }
  }
  return {prompt_tokens: prompt, completion_tokens: completion, total_tokens: total};
}
interface AgentPartSnapshot {type: 'output_text' | 'refusal'; text: string}
interface AgentMessageSnapshot {type: 'message'; id: string; content: AgentPartSnapshot[]}
function partSnapshot(part: unknown): AgentPartSnapshot {
  if (!object(part)) protocol(); rejectFeatures(part);
  if (part.type === 'reasoning_text' || part.type === 'summary_text') fail('AGENT_CHAT_REASONING_UNSUPPORTED');
  if (!['output_text', 'refusal'].includes(part.type as string)) protocol();
  const field = part.type === 'output_text' ? 'text' : 'refusal';
  const text = part[field];
  if (!validString(text)) { if (typeof text === 'string' && Buffer.byteLength(text) > AGENT_CHAT_LIMITS.maxOutputBytes) fail('AGENT_CHAT_LIMIT'); protocol(); }
  const allowed = part.type === 'output_text' ? ['type', 'text', 'annotations', 'logprobs'] : ['type', 'refusal'];
  if (Object.keys(part).some(key => !allowed.includes(key))) protocol();
  // This text-only profile has neither tool citations nor logprob presentation.
  for (const key of ['annotations', 'logprobs']) {
    const annotations = part[key];
    if (annotations != null && (!Array.isArray(annotations) || annotations.length)) protocol();
  }
  return {type: part.type as 'output_text' | 'refusal', text};
}
function messageSnapshot(item: unknown, status: string): AgentMessageSnapshot {
  if (!object(item)) protocol(); rejectFeatures(item);
  if (item.type === 'reasoning') fail('AGENT_CHAT_REASONING_UNSUPPORTED');
  if (typeof item.type === 'string' && (item.type.includes('call') || item.type.includes('tool') || item.type === 'mcp_approval_request')) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
  if (item.type !== 'message' || item.role !== 'assistant' || item.status !== status || !Array.isArray(item.content)) protocol();
  if (Object.keys(item).some(key => !['id', 'type', 'role', 'status', 'content', 'phase'].includes(key))) protocol();
  const content = item.content as unknown[];
  if (content.length > AGENT_RESPONSES_LIMITS.maxParts) fail('AGENT_CHAT_LIMIT');
  return {type: 'message', id: id(item.id), content: content.map(partSnapshot)};
}
function samePart(actual: {type: string; text: string}, expected: {type: string; text: string}): void { if (actual.type !== expected.type || actual.text !== expected.text) protocol(); }

interface TrackedPart {type: string; text: string; textDone: boolean; done: boolean}
interface TrackedItem {
  id: string;
  type: string;
  content: TrackedPart[];
  done: boolean;
  callId: string;
  name: string;
  argumentsJson: string;
  argumentsDone: boolean;
  snapshot?: unknown;
}

/** Native Responses semantic validator, independent from CC's choices/[DONE].
 * Deltas are provisional. Success requires matching completed snapshots AND a
 * clean framed transport end. Never execute tools, append final text twice, or
 * derive success from [DONE], a completed part, or a convenience output_text. */
export function createResponsesGateway(dependencies: AgentTransportDependencies = {}): AgentGateway {
  const open = createOpenAiSdkTransport(dependencies);
  return async function* streamResponses({configuration, apiKey, messages, signal, selfPort, readTools, beforeSubmit}) {
    if (signal?.aborted) fail('AGENT_CHAT_ABORTED');
    const request = buildAgentResponsesRequest({configuration, apiKey, messages, selfPort, readTools});
    let stream: AgentTransportStream | undefined;
    try {
      stream = await open({...request, apiKey: apiKey as string | null | undefined, signal, selfPort, beforeSubmit});
      let responseId: string | null = null, sequence = -1, completed = false, inProgress = false, outputBytes = 0, partCount = 0, usage: AgentUsage | undefined, toolCount = 0, providerOutput: unknown;
      const readState = readTools as ReadToolState | undefined;
      const allowToolCalls = readState?.phase === 'request';
      const items: TrackedItem[] = [], itemIds = new Set<string>();
      const getItem = (value: Record<string, unknown>): TrackedItem => {
        const item = items[index(value.output_index, AGENT_RESPONSES_LIMITS.maxItems)];
        if (!item || id(value.item_id) !== item.id) protocol();
        return item;
      };
      const getPart = (value: Record<string, unknown>): {item: TrackedItem; part: TrackedPart} => {
        const item = getItem(value);
        if (item.type === 'function_call') protocol();
        const part = item.content[index(value.content_index, AGENT_RESPONSES_LIMITS.maxParts)];
        if (!part || item.done) protocol();
        return {item, part};
      };
      const compareItem = (snapshot: AgentMessageSnapshot | ResponseToolSnapshot, item: TrackedItem): void => {
        if (snapshot.type === 'function_call') return compareResponseTool(snapshot, item);
        if (item.type === 'function_call') protocol();
        if (snapshot.id !== item.id || snapshot.content.length !== item.content.length) protocol();
        for (let n = 0; n < snapshot.content.length; n++) {
          if (!item.content[n].done) protocol();
          samePart(snapshot.content[n], item.content[n]);
        }
      };
      for await (const frame of parseAgentSse(stream.body, {...AGENT_SSE_LIMITS, signal, includeEventName: true})) {
        if (signal?.aborted) fail('AGENT_CHAT_ABORTED');
        // Responses has no sentinel requirement; sentinels are not native events.
        if (frame.data === '[DONE]') protocol();
        let value: unknown;
        try { value = JSON.parse(frame.data); } catch { protocol(); }
        if (!object(value) || typeof value.type !== 'string' || (frame.eventName !== null && frame.eventName !== value.type) || completed) protocol();
        if (!Number.isSafeInteger(value.sequence_number) || (value.sequence_number as number) < 0 || (value.sequence_number as number) <= sequence) protocol();
        sequence = value.sequence_number as number;
        if (value.response_id !== undefined && id(value.response_id) !== (responseId || (value.type === 'response.created' ? (value.response as {id?: unknown} | undefined)?.id : null))) protocol();
        const functionArguments = allowToolCalls && ['response.function_call_arguments.delta', 'response.function_call_arguments.done'].includes(value.type);
        rejectFeatures(value, {functionArguments});
        if (value.type === 'error' || value.type === 'response.error') fail('AGENT_CHAT_PROVIDER_ERROR');
        if (value.error != null) fail('AGENT_CHAT_PROVIDER_ERROR');
        if ((!functionArguments && value.type.startsWith('response.function_call')) || value.type.includes('_call.') || value.type.startsWith('response.mcp_')) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
        if (value.type.startsWith('response.reasoning')) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
        if (['response.created', 'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed'].includes(value.type)) {
          const response = value.response;
          if (!object(response) || response.object !== 'response' || !Array.isArray(response.output)) protocol();
          const outputItems = response.output as unknown[];
          const nextId = id(response.id);
          if (responseId && nextId !== responseId) protocol();
          if (outputItems.length > AGENT_RESPONSES_LIMITS.maxItems) fail('AGENT_CHAT_LIMIT');
          rejectFeatures(response, {responseConfiguration: true});
          // `reasoning` here is request configuration, NOT generated output.
          if (response.reasoning != null && !object(response.reasoning)) protocol();
          for (const item of outputItems) {
            if (object(item) && item.type === 'reasoning') fail('AGENT_CHAT_REASONING_UNSUPPORTED');
            if (allowToolCalls && object(item) && item.type === 'function_call') { responseToolSnapshot(item, 'completed', readTools); continue; }
            if (object(item) && item.type !== 'message') {
              if (typeof item.type === 'string' && (item.type.includes('call') || item.type.includes('tool') || item.type === 'mcp_approval_request')) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
              protocol();
            }
          }
          if (value.type === 'response.created') {
            if (responseId || !['queued', 'in_progress'].includes(response.status as string) || outputItems.length || response.error != null || response.incomplete_details != null) protocol();
            responseId = nextId;
            continue;
          }
          if (!responseId) protocol();
          if (value.type === 'response.in_progress') {
            if (inProgress || items.length || response.status !== 'in_progress' || outputItems.length || response.error != null || response.incomplete_details != null) protocol();
            inProgress = true;
            continue;
          }
          if (value.type === 'response.failed') { if (response.status !== 'failed') protocol(); fail('AGENT_CHAT_PROVIDER_ERROR'); }
          if (value.type === 'response.incomplete') {
            if (response.status !== 'incomplete') protocol();
            fail((response.incomplete_details as {reason?: unknown} | null | undefined)?.reason === 'max_output_tokens' ? 'AGENT_CHAT_TRUNCATED' : 'AGENT_CHAT_PROVIDER_ERROR');
          }
          if (response.status !== 'completed' || response.error != null || response.incomplete_details != null || !items.length || outputItems.length !== items.length) protocol();
          for (let n = 0; n < items.length; n++) {
            if (!items[n].done || (items[n].type !== 'function_call' && !items[n].content.length)) protocol();
            const raw = outputItems[n];
            const snapshot = allowToolCalls && object(raw) && raw.type === 'function_call' ? responseToolSnapshot(raw, 'completed', readTools) : messageSnapshot(raw, 'completed');
            compareItem(snapshot, items[n]);
            if (allowToolCalls && !isDeepStrictEqual(raw, items[n].snapshot)) protocol();
          }
          if (toolCount) providerOutput = structuredClone(outputItems);
          usage = safeUsage(response.usage);
          completed = true;
          continue;
        }
        if (!responseId) protocol();
        if (value.type === 'response.output_item.added') {
          if (index(value.output_index, AGENT_RESPONSES_LIMITS.maxItems) !== items.length || (items.length && !items[items.length - 1].done)) protocol();
          const raw = value.item;
          const added = allowToolCalls && object(raw) && raw.type === 'function_call' ? responseToolSnapshot(raw, 'in_progress', readTools) : messageSnapshot(raw, 'in_progress');
          if (added.type === 'function_call') {
            if (++toolCount > toolScope(readState as ReadToolState).limits.maxToolCalls! || added.argumentsJson !== '') protocol();
            items.push({id: added.id, type: 'function_call', content: [], done: false, callId: added.callId, name: added.name, argumentsJson: added.argumentsJson, argumentsDone: false});
          } else {
            if (added.content.length) protocol();
            items.push({id: added.id, type: 'message', content: added.content.map(part => ({...part, textDone: false, done: false})), done: false, callId: '', name: '', argumentsJson: '', argumentsDone: false});
          }
          if (itemIds.has(added.id)) protocol();
          itemIds.add(added.id);
          continue;
        }
        if (value.type === 'response.output_item.done') {
          const item = items[index(value.output_index, AGENT_RESPONSES_LIMITS.maxItems)];
          if (!item || item.done || (value.item_id !== undefined && id(value.item_id) !== item.id)) protocol();
          const raw = value.item;
          const snapshot = allowToolCalls && object(raw) && raw.type === 'function_call' ? responseToolSnapshot(raw, 'completed', readTools) : messageSnapshot(raw, 'completed');
          compareItem(snapshot, item); item.done = true;
          if (allowToolCalls) item.snapshot = structuredClone(raw);
          continue;
        }
        if (functionArguments) {
          const item = getItem(value);
          if (item.type !== 'function_call' || item.done || item.argumentsDone) protocol();
          const allowed = ['type', 'sequence_number', 'response_id', 'item_id', 'output_index', value.type.endsWith('.done') ? 'arguments' : 'delta', 'name'];
          if (Object.keys(value).some(key => !allowed.includes(key)) || (value.name !== undefined && value.name !== item.name)) protocol();
          if (value.type.endsWith('.done')) {
            if (!validString(value.arguments, toolScope(readState as ReadToolState).limits.maxArgumentsBytes) || value.arguments !== item.argumentsJson) protocol();
            normalizeToolCall({id: item.callId, itemId: item.id, name: item.name, argumentsJson: item.argumentsJson}, readState);
            item.argumentsDone = true;
          } else {
            const delta = value.delta;
            const maximumArgumentsBytes = toolScope(readState as ReadToolState).limits.maxArgumentsBytes;
            if (!validString(delta, maximumArgumentsBytes)) { if (typeof delta === 'string' && Buffer.byteLength(delta) > maximumArgumentsBytes) fail('AGENT_CHAT_LIMIT'); protocol(); }
            item.argumentsJson += delta;
            if (Buffer.byteLength(item.argumentsJson) > maximumArgumentsBytes) fail('AGENT_CHAT_LIMIT');
          }
          continue;
        }
        if (value.type === 'response.content_part.added') {
          const item = getItem(value);
          if (item.type === 'function_call') protocol();
          if (item.done || index(value.content_index, AGENT_RESPONSES_LIMITS.maxParts) !== item.content.length || (item.content.length && !item.content[item.content.length - 1].done)) protocol();
          if (++partCount > AGENT_RESPONSES_LIMITS.maxParts) fail('AGENT_CHAT_LIMIT');
          const part = partSnapshot(value.part);
          if (part.text) protocol();
          item.content.push({...part, textDone: false, done: false});
          continue;
        }
        if (value.type === 'response.content_part.done') {
          const {part} = getPart(value);
          if (part.done || !part.textDone) protocol();
          samePart(partSnapshot(value.part), part); part.done = true;
          continue;
        }
        if (['response.output_text.delta', 'response.refusal.delta', 'response.output_text.done', 'response.refusal.done'].includes(value.type)) {
          const {part} = getPart(value), type = value.type.includes('.refusal.') ? 'refusal' : 'output_text';
          if (part.type !== type || part.done || part.textDone) protocol();
          if (value.type.endsWith('.done')) {
            const text = value[type === 'refusal' ? 'refusal' : 'text'];
            if (!validString(text) || text !== part.text) protocol();
            part.textDone = true;
          } else {
            const delta = value.delta;
            if (!validString(delta)) protocol();
            outputBytes += Buffer.byteLength(delta);
            if (outputBytes > AGENT_CHAT_LIMITS.maxOutputBytes) fail('AGENT_CHAT_LIMIT');
            const text = part.text + delta;
            part.text = text;
            if (delta) yield {type: 'delta', text: delta};
          }
          continue;
        }
        protocol();
      }
      if (stream.error()) throw stream.error();
      if (signal?.aborted) fail('AGENT_CHAT_ABORTED');
      if (!completed) fail('AGENT_CHAT_TRUNCATED');
      stream.close();
      const item = items.find(value => value.type === 'function_call');
      const toolCall = item ? normalizeToolCall({id: item.callId, itemId: item.id, name: item.name, argumentsJson: item.argumentsJson}, readState) : null;
      yield {type: 'done', finishReason: toolCall ? 'tool_calls' : 'stop', ...(usage ? {usage} : {}), ...(toolCall ? {toolCall, providerOutput} : {})};
    } catch (error) {
      if (signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
      throw agentChatError(stream?.error()?.code || errorCode(error) || 'AGENT_CHAT_CONNECT_FAILED');
    } finally { stream?.close(); }
  };
}
export const streamResponses = createResponsesGateway();
