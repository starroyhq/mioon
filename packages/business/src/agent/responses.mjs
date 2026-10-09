import {exactObject, parseAgentConfiguration, MAX_AGENT_SECRET_BYTES} from './config.mjs';
import {AGENT_CHAT_LIMITS, CHAT_SYSTEM_INSTRUCTION} from './chat-policy.mjs';
import {agentChatError} from './chat-errors.mjs';
import {createAgentTransport} from './network-policy.mjs';
import {parseAgentSse, AGENT_SSE_LIMITS} from './sse.mjs';
import {isDeepStrictEqual} from 'node:util';
import {READ_TOOL_LIMITS, READ_TOOL_SYSTEM_INSTRUCTION} from './read-tool-policy.mjs';
import {validateReadTools, readToolRequestFields, readToolMessages, normalizeToolCall, responseToolSnapshot, compareResponseTool, responseToolContinuation} from './tool-wire.mjs';

// Documentation-backed, deliberately text-only profiles, not live certification.
// Qwen cannot disable provider-side truncation. Its documented 1M-token model
// context is far above this adapter's 32KiB text cap; no native override is sent.
export const AGENT_RESPONSES_LIMITS = Object.freeze({maxInputBytes: 32 * 1024, maxItems: 64, maxParts: 128, maxIdBytes: 256});
function freeze(value) { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); }
export const AGENT_RESPONSES_PROFILES = freeze({
  openai: {models: ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'], fields: {truncation: 'disabled'}},
  custom: {models: null, fields: {truncation: 'disabled'}},
  ollama: {models: ['qwen3:8b'], fields: {reasoning: {effort: 'none'}}},
  deepseek: {models: ['deepseek-flash'], fields: {reasoning: {effort: 'none'}}},
  qwen: {models: ['qwen3.8-flash'], fields: {reasoning: {effort: 'none'}}},
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw agentChatError(code); };
const protocol = () => fail('AGENT_CHAT_PROTOCOL_ERROR');
const present = value => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
function validString(value, maximum = AGENT_CHAT_LIMITS.maxOutputBytes) {
  return typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= maximum;
}
function id(value) { if (!validString(value, AGENT_RESPONSES_LIMITS.maxIdBytes) || !value || /[\u0000-\u0020\u007f]/u.test(value)) protocol(); return value; }
function index(value, maximum) { if (!Number.isSafeInteger(value) || value < 0) protocol(); if (value >= maximum) fail('AGENT_CHAT_LIMIT'); return value; }
function rejectFeatures(value, {responseConfiguration = false, functionArguments = false} = {}) {
  if (!object(value)) return;
  if (['tool_calls', 'function_call', 'call_id', ...(functionArguments ? [] : ['arguments'])].some(key => present(value[key]))) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
  if (!responseConfiguration && present(value.reasoning)) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
  if (['reasoning_content', 'reasoning_details', 'encrypted_content', 'thinking', 'signature', 'continuation', 'previous_response_id', 'phase'].some(key => present(value[key]))) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
}
function qwenEndpoint(config) {
  const fixed = {beijing: 'https://dashscope.aliyuncs.com/compatible-mode/v1', singapore: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'};
  if (Object.hasOwn(fixed, config.platformId)) return config.baseUrl === fixed[config.platformId];
  if (!config.platformId.startsWith('workspace-')) return false;
  const region = config.platformId.slice('workspace-'.length), url = new URL(config.baseUrl);
  return url.protocol === 'https:' && !url.port && url.pathname === '/compatible-mode/v1' &&
    new RegExp(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.${region}\\.maas\\.aliyuncs\\.com$`).test(url.hostname);
}
export function validateAgentResponsesConfiguration(configuration, {selfPort, readTools} = {}) {
  let config;
  try { config = parseAgentConfiguration(configuration, {selfPort}); } catch { fail('AGENT_CHAT_VALIDATION'); }
  if (config.protocol !== 'responses') fail('AGENT_CHAT_VALIDATION');
  const profile = AGENT_RESPONSES_PROFILES[config.presetId];
  if (!profile || (profile.models && !profile.models.includes(config.model)) ||
    (config.presetId === 'deepseek' && config.baseUrl !== 'https://api.deepseek.com') ||
    (config.presetId === 'qwen' && !qwenEndpoint(config))) fail('AGENT_CHAT_PROFILE_UNSUPPORTED');
  validateReadTools(config, readTools);
  return config;
}
export function buildAgentResponsesRequest({configuration, apiKey, messages, selfPort, readTools}) {
  const config = validateAgentResponsesConfiguration(configuration, {selfPort, readTools});
  if (config.presetId !== 'ollama' && (typeof apiKey !== 'string' || !apiKey)) fail('AGENT_CHAT_KEY_REQUIRED');
  if (apiKey != null && apiKey !== '' && (typeof apiKey !== 'string' || Buffer.byteLength(apiKey) > MAX_AGENT_SECRET_BYTES || !/^[\x21-\x7e]+$/.test(apiKey))) fail('AGENT_CHAT_VALIDATION');
  return buildAgentResponsesBody({configuration: config, messages, selfPort, readTools});
}
/** Pure key-free request compilation for acceptance/journaling. */
export function buildAgentResponsesBody({configuration, messages, selfPort, readTools}) {
  const config = validateAgentResponsesConfiguration(configuration, {selfPort, readTools});
  if (!Array.isArray(messages) || !messages.length || messages.length > AGENT_CHAT_LIMITS.maxMessages) fail('AGENT_CHAT_VALIDATION');
  // The fixed runtime instruction is never customizable by model/user input.
  const instructions = readTools ? READ_TOOL_SYSTEM_INSTRUCTION : CHAT_SYSTEM_INSTRUCTION;
  if (readTools) messages = readToolMessages(messages);
  let inputBytes = Buffer.byteLength(instructions), input = [];
  for (const [position, message] of messages.entries()) {
    if (!exactObject(message, ['role', 'content']) || !validString(message.content, AGENT_CHAT_LIMITS.maxInputBytes)) fail('AGENT_CHAT_VALIDATION');
    if (message.role === 'system') {
      if (position !== 0 || message.content !== instructions) fail('AGENT_CHAT_VALIDATION');
      continue;
    }
    if (!['user', 'assistant'].includes(message.role) || message.role !== (input.length % 2 === 0 ? 'user' : 'assistant')) fail('AGENT_CHAT_VALIDATION');
    inputBytes += Buffer.byteLength(message.content);
    if (inputBytes > (readTools ? READ_TOOL_LIMITS.maxContextBytes : AGENT_RESPONSES_LIMITS.maxInputBytes)) fail('AGENT_CHAT_LIMIT');
    input.push({role: message.role, content: message.content});
  }
  if (!input.length || input.at(-1).role !== 'user') fail('AGENT_CHAT_VALIDATION');
  if (readTools?.phase === 'answer') {
    input.push(...responseToolContinuation(readTools, messageSnapshot, AGENT_RESPONSES_LIMITS.maxItems));
    if (Buffer.byteLength(JSON.stringify(input)) + Buffer.byteLength(instructions) > AGENT_RESPONSES_LIMITS.maxInputBytes) fail('AGENT_CHAT_LIMIT');
  }
  const body = JSON.stringify({model: config.model, stream: true, store: false, max_output_tokens: AGENT_CHAT_LIMITS.maxOutputTokens,
    instructions, input, ...AGENT_RESPONSES_PROFILES[config.presetId].fields, ...readToolRequestFields(config, readTools)});
  if (Buffer.byteLength(body) > AGENT_CHAT_LIMITS.maxRequestBytes) fail('AGENT_CHAT_LIMIT');
  return {configuration: config, body};
}
function safeUsage(value) {
  if (value == null) return undefined;
  if (!object(value)) protocol();
  const result = {};
  for (const [source, target] of [['input_tokens', 'prompt_tokens'], ['output_tokens', 'completion_tokens'], ['total_tokens', 'total_tokens']]) {
    if (!Number.isSafeInteger(value[source]) || value[source] < 0 || value[source] > 10_000_000) protocol();
    result[target] = value[source];
  }
  if (result.completion_tokens > AGENT_CHAT_LIMITS.maxOutputTokens) fail('AGENT_CHAT_LIMIT');
  if (result.total_tokens !== result.prompt_tokens + result.completion_tokens) protocol();
  for (const [field, total] of [['input_tokens_details', result.prompt_tokens], ['output_tokens_details', result.completion_tokens]]) {
    if (value[field] == null) continue;
    if (!object(value[field])) protocol();
    for (const [key, number] of Object.entries(value[field])) {
      if (!Number.isSafeInteger(number) || number < 0 || number > total) protocol();
      if (key === 'reasoning_tokens' && number > 0) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
    }
  }
  return result;
}
function partSnapshot(part) {
  if (!object(part)) protocol(); rejectFeatures(part);
  if (part.type === 'reasoning_text' || part.type === 'summary_text') fail('AGENT_CHAT_REASONING_UNSUPPORTED');
  if (!['output_text', 'refusal'].includes(part.type)) protocol();
  const field = part.type === 'output_text' ? 'text' : 'refusal';
  if (!validString(part[field])) { if (typeof part[field] === 'string' && Buffer.byteLength(part[field]) > AGENT_CHAT_LIMITS.maxOutputBytes) fail('AGENT_CHAT_LIMIT'); protocol(); }
  const allowed = part.type === 'output_text' ? ['type', 'text', 'annotations', 'logprobs'] : ['type', 'refusal'];
  if (Object.keys(part).some(key => !allowed.includes(key))) protocol();
  // This text-only profile has neither tool citations nor logprob presentation.
  for (const key of ['annotations', 'logprobs']) if (part[key] != null && (!Array.isArray(part[key]) || part[key].length)) protocol();
  return {type: part.type, text: part[field]};
}
function messageSnapshot(item, status) {
  if (!object(item)) protocol(); rejectFeatures(item);
  if (item.type === 'reasoning') fail('AGENT_CHAT_REASONING_UNSUPPORTED');
  if (typeof item.type === 'string' && (item.type.includes('call') || item.type.includes('tool') || item.type === 'mcp_approval_request')) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
  if (item.type !== 'message' || item.role !== 'assistant' || item.status !== status || !Array.isArray(item.content)) protocol();
  if (Object.keys(item).some(key => !['id', 'type', 'role', 'status', 'content', 'phase'].includes(key))) protocol();
  if (item.content.length > AGENT_RESPONSES_LIMITS.maxParts) fail('AGENT_CHAT_LIMIT');
  return {id: id(item.id), content: item.content.map(partSnapshot)};
}
function samePart(actual, expected) { if (actual.type !== expected.type || actual.text !== expected.text) protocol(); }

/** Native Responses semantic validator, independent from CC's choices/[DONE].
 * Deltas are provisional. Success requires matching completed snapshots AND a
 * clean framed transport end. Never execute tools, append final text twice, or
 * derive success from [DONE], a completed part, or a convenience output_text. */
export function createResponsesGateway(dependencies = {}) {
  const open = createAgentTransport(dependencies);
  return async function* streamResponses({configuration, apiKey, messages, signal, selfPort, readTools}) {
    if (signal?.aborted) fail('AGENT_CHAT_ABORTED');
    const request = buildAgentResponsesRequest({configuration, apiKey, messages, selfPort, readTools});
    let stream;
    try {
      stream = await open({...request, apiKey, signal, selfPort});
      let responseId = null, sequence = -1, completed = false, inProgress = false, outputBytes = 0, partCount = 0, usage, toolCount = 0, providerOutput;
      const allowToolCalls = readTools?.phase === 'request';
      const items = [], itemIds = new Set();
      const getItem = value => {
        const item = items[index(value.output_index, AGENT_RESPONSES_LIMITS.maxItems)];
        if (!item || id(value.item_id) !== item.id) protocol();
        return item;
      };
      const getPart = value => {
        const item = getItem(value);
        if (item.type === 'function_call') protocol();
        const part = item.content[index(value.content_index, AGENT_RESPONSES_LIMITS.maxParts)];
        if (!part || item.done) protocol();
        return {item, part};
      };
      const compareItem = (snapshot, item) => {
        if (snapshot.type === 'function_call') return compareResponseTool(snapshot, item);
        if (item?.type === 'function_call') protocol();
        if (!item || snapshot.id !== item.id || snapshot.content.length !== item.content.length) protocol();
        for (let n = 0; n < snapshot.content.length; n++) {
          if (!item.content[n].done) protocol();
          samePart(snapshot.content[n], item.content[n]);
        }
      };
      for await (const frame of parseAgentSse(stream.body, {...AGENT_SSE_LIMITS, signal, includeEventName: true})) {
        if (signal?.aborted) fail('AGENT_CHAT_ABORTED');
        // Responses has no sentinel requirement; sentinels are not native events.
        if (frame.data === '[DONE]') protocol();
        let value;
        try { value = JSON.parse(frame.data); } catch { protocol(); }
        if (!object(value) || typeof value.type !== 'string' || (frame.eventName !== null && frame.eventName !== value.type) || completed) protocol();
        if (!Number.isSafeInteger(value.sequence_number) || value.sequence_number < 0 || value.sequence_number <= sequence) protocol();
        sequence = value.sequence_number;
        if (value.response_id !== undefined && id(value.response_id) !== (responseId || (value.type === 'response.created' ? value.response?.id : null))) protocol();
        const functionArguments = allowToolCalls && ['response.function_call_arguments.delta', 'response.function_call_arguments.done'].includes(value.type);
        rejectFeatures(value, {functionArguments});
        if (value.type === 'error' || value.type === 'response.error') fail('AGENT_CHAT_PROVIDER_ERROR');
        if (value.error != null) fail('AGENT_CHAT_PROVIDER_ERROR');
        if ((!functionArguments && value.type.startsWith('response.function_call')) || value.type.includes('_call.') || value.type.startsWith('response.mcp_')) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
        if (value.type.startsWith('response.reasoning')) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
        if (['response.created', 'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed'].includes(value.type)) {
          const response = value.response;
          if (!object(response) || response.object !== 'response' || !Array.isArray(response.output)) protocol();
          const nextId = id(response.id);
          if (responseId && nextId !== responseId) protocol();
          if (response.output.length > AGENT_RESPONSES_LIMITS.maxItems) fail('AGENT_CHAT_LIMIT');
          rejectFeatures(response, {responseConfiguration: true});
          // `reasoning` here is request configuration, NOT generated output.
          if (response.reasoning != null && !object(response.reasoning)) protocol();
          for (const item of response.output) {
            if (object(item) && item.type === 'reasoning') fail('AGENT_CHAT_REASONING_UNSUPPORTED');
            if (allowToolCalls && object(item) && item.type === 'function_call') { responseToolSnapshot(item, 'completed'); continue; }
            if (object(item) && item.type !== 'message') {
              if (typeof item.type === 'string' && (item.type.includes('call') || item.type.includes('tool') || item.type === 'mcp_approval_request')) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
              protocol();
            }
          }
          if (value.type === 'response.created') {
            if (responseId || !['queued', 'in_progress'].includes(response.status) || response.output.length || response.error != null || response.incomplete_details != null) protocol();
            responseId = nextId;
            continue;
          }
          if (!responseId) protocol();
          if (value.type === 'response.in_progress') {
            if (inProgress || items.length || response.status !== 'in_progress' || response.output.length || response.error != null || response.incomplete_details != null) protocol();
            inProgress = true;
            continue;
          }
          if (value.type === 'response.failed') { if (response.status !== 'failed') protocol(); fail('AGENT_CHAT_PROVIDER_ERROR'); }
          if (value.type === 'response.incomplete') {
            if (response.status !== 'incomplete') protocol();
            fail(response.incomplete_details?.reason === 'max_output_tokens' ? 'AGENT_CHAT_TRUNCATED' : 'AGENT_CHAT_PROVIDER_ERROR');
          }
          if (response.status !== 'completed' || response.error != null || response.incomplete_details != null || !items.length || response.output.length !== items.length) protocol();
          for (let n = 0; n < items.length; n++) {
            if (!items[n].done || (items[n].type !== 'function_call' && !items[n].content.length)) protocol();
            const snapshot = response.output[n]?.type === 'function_call' && allowToolCalls ? responseToolSnapshot(response.output[n], 'completed') : messageSnapshot(response.output[n], 'completed');
            compareItem(snapshot, items[n]);
            if (allowToolCalls && !isDeepStrictEqual(response.output[n], items[n].snapshot)) protocol();
          }
          if (toolCount) providerOutput = structuredClone(response.output);
          usage = safeUsage(response.usage);
          completed = true;
          continue;
        }
        if (!responseId) protocol();
        if (value.type === 'response.output_item.added') {
          if (index(value.output_index, AGENT_RESPONSES_LIMITS.maxItems) !== items.length || (items.length && !items.at(-1).done)) protocol();
          const item = allowToolCalls && value.item?.type === 'function_call' ? responseToolSnapshot(value.item, 'in_progress') : messageSnapshot(value.item, 'in_progress');
          if (item.type === 'function_call') {
            if (++toolCount > READ_TOOL_LIMITS.maxToolCalls || item.argumentsJson !== '') protocol();
          } else if (item.content.length) protocol();
          if (itemIds.has(item.id)) protocol();
          itemIds.add(item.id); items.push({...item, done: false});
          continue;
        }
        if (value.type === 'response.output_item.done') {
          const item = items[index(value.output_index, AGENT_RESPONSES_LIMITS.maxItems)];
          if (!item || item.done || (value.item_id !== undefined && id(value.item_id) !== item.id)) protocol();
          const snapshot = allowToolCalls && value.item?.type === 'function_call' ? responseToolSnapshot(value.item, 'completed') : messageSnapshot(value.item, 'completed');
          compareItem(snapshot, item); item.done = true;
          if (allowToolCalls) item.snapshot = structuredClone(value.item);
          continue;
        }
        if (functionArguments) {
          const item = getItem(value);
          if (item.type !== 'function_call' || item.done || item.argumentsDone) protocol();
          const allowed = ['type', 'sequence_number', 'response_id', 'item_id', 'output_index', value.type.endsWith('.done') ? 'arguments' : 'delta', 'name'];
          if (Object.keys(value).some(key => !allowed.includes(key)) || (value.name !== undefined && value.name !== item.name)) protocol();
          if (value.type.endsWith('.done')) {
            if (!validString(value.arguments, READ_TOOL_LIMITS.maxArgumentsBytes) || value.arguments !== item.argumentsJson) protocol();
            normalizeToolCall({id: item.callId, itemId: item.id, name: item.name, argumentsJson: item.argumentsJson});
            item.argumentsDone = true;
          } else {
            if (!validString(value.delta, READ_TOOL_LIMITS.maxArgumentsBytes)) { if (typeof value.delta === 'string' && Buffer.byteLength(value.delta) > READ_TOOL_LIMITS.maxArgumentsBytes) fail('AGENT_CHAT_LIMIT'); protocol(); }
            item.argumentsJson += value.delta;
            if (Buffer.byteLength(item.argumentsJson) > READ_TOOL_LIMITS.maxArgumentsBytes) fail('AGENT_CHAT_LIMIT');
          }
          continue;
        }
        if (value.type === 'response.content_part.added') {
          const item = getItem(value);
          if (item.type === 'function_call') protocol();
          if (item.done || index(value.content_index, AGENT_RESPONSES_LIMITS.maxParts) !== item.content.length || (item.content.length && !item.content.at(-1).done)) protocol();
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
            if (!validString(value.delta)) protocol();
            outputBytes += Buffer.byteLength(value.delta);
            if (outputBytes > AGENT_CHAT_LIMITS.maxOutputBytes) fail('AGENT_CHAT_LIMIT');
            part.text += value.delta;
            if (value.delta) yield {type: 'delta', text: value.delta};
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
      const toolCall = item ? normalizeToolCall({id: item.callId, itemId: item.id, name: item.name, argumentsJson: item.argumentsJson}) : null;
      yield {type: 'done', finishReason: toolCall ? 'tool_calls' : 'stop', ...(usage ? {usage} : {}), ...(toolCall ? {toolCall, providerOutput} : {})};
    } catch (error) {
      if (signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
      throw agentChatError(stream?.error()?.code || error?.code);
    } finally { stream?.close(); }
  };
}
export const streamResponses = createResponsesGateway();
