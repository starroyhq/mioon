import {exactObject} from './config.mjs';
import {agentChatError} from './chat-errors.mjs';
import {CHAT_SYSTEM_INSTRUCTION} from './chat-policy.mjs';
import {EDIT_TOOL_DEFINITIONS, EDIT_TOOL_LIMITS, EDIT_TOOL_SYSTEM_INSTRUCTION, parseEditToolArguments} from './edit-tool-policy.mjs';
import {TIMELINE_EDIT_TOOL_DEFINITIONS, TIMELINE_EDIT_TOOL_LIMITS, TIMELINE_EDIT_TOOL_SYSTEM_INSTRUCTION, parseTimelineEditToolArguments} from './timeline-edit-tool-policy.mjs';
import {AGENT_TIMELINE_MOVE_CONTEXT} from '@mioon/contracts';
import {READ_TOOL_DEFINITIONS, READ_TOOL_LIMITS, READ_TOOL_SYSTEM_INSTRUCTION, parseReadToolArguments} from './read-tool-policy.mjs';

const fail = code => { throw agentChatError(code); };
export const toolProtocolError = () => fail('AGENT_CHAT_PROTOCOL_ERROR');
export const toolObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function toolString(value, maximum) { return typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= maximum; }
export function toolId(value) {
  if (!toolString(value, 256) || !value || /[\u0000-\u0020\u007f]/u.test(value)) toolProtocolError();
  return value;
}
function freeze(value) { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); }
// Deliberate function-wire profiles, fixture tested, never live certification.
// Unsupported controls are omitted rather than relying on them being ignored.
// DeepSeek Responses documents parallel_tool_calls as ignored (always enabled).
// Ollama marks CC tool_choice unsupported and omits it for Responses; Zhipu
// documents only auto. tools:[] and the answer parser enforce the second-round cap.
export const AGENT_READ_TOOL_PROFILES = freeze({
  chat_completions: {
    openai: {parallel: true, choice: true, strict: true},
    custom: {parallel: true, choice: true, strict: true},
    openrouter: {parallel: true, choice: true, strict: true},
    qwen: {parallel: true, choice: true, strict: false},
    deepseek: {parallel: false, choice: true, strict: false},
    zhipu: {parallel: false, choice: false, strict: false},
    kimi: {parallel: false, choice: true, strict: false},
    minimax: {parallel: false, choice: false, strict: false},
    ollama: {parallel: false, choice: false, strict: false},
  },
  responses: {
    openai: {parallel: true, choice: true, strict: true},
    custom: {parallel: true, choice: true, strict: true},
    qwen: {parallel: false, choice: true, strict: false},
    deepseek: {parallel: false, choice: true, strict: false},
    ollama: {parallel: false, choice: false, strict: false},
  },
});
// This selector is internal and closed: callers cannot supply schemas or operations.
export function toolScope(readTools) {
  if (readTools?.scope !== undefined && !['selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT].includes(readTools.scope)) fail('AGENT_CHAT_VALIDATION');
  if (readTools?.scope === AGENT_TIMELINE_MOVE_CONTEXT) return {definitions: TIMELINE_EDIT_TOOL_DEFINITIONS, limits: TIMELINE_EDIT_TOOL_LIMITS,
    instruction: TIMELINE_EDIT_TOOL_SYSTEM_INSTRUCTION, parse: parseTimelineEditToolArguments};
  return readTools?.scope === 'selected_shot_edit' ? {definitions: EDIT_TOOL_DEFINITIONS, limits: EDIT_TOOL_LIMITS,
    instruction: EDIT_TOOL_SYSTEM_INSTRUCTION, parse: parseEditToolArguments} : {definitions: READ_TOOL_DEFINITIONS,
    limits: READ_TOOL_LIMITS, instruction: READ_TOOL_SYSTEM_INSTRUCTION, parse: parseReadToolArguments};
}
export function normalizeToolCall({id, name, argumentsJson, itemId}, readTools) {
  const scope = toolScope(readTools);
  toolId(id); if (itemId !== undefined) toolId(itemId);
  if (!toolString(argumentsJson, scope.limits.maxArgumentsBytes)) {
    if (typeof argumentsJson === 'string' && Buffer.byteLength(argumentsJson) > scope.limits.maxArgumentsBytes) fail('AGENT_CHAT_LIMIT');
    toolProtocolError();
  }
  const parsed = scope.parse(name, argumentsJson);
  return {id, name, arguments: parsed.arguments, argumentsJson, ...(itemId !== undefined ? {itemId} : {})};
}
export function sameToolCall(actual, expected) {
  if (actual.id !== expected.id || actual.name !== expected.name || actual.argumentsJson !== expected.argumentsJson || actual.itemId !== expected.itemId) toolProtocolError();
}
export function validateReadTools(configuration, readTools) {
  if (readTools === undefined) return undefined;
  if (!toolObject(readTools) || !['request', 'answer'].includes(readTools.phase)) fail('AGENT_CHAT_VALIDATION');
  const scope = toolScope(readTools), extra = readTools.scope === undefined ? [] : ['scope'];
  const profile = AGENT_READ_TOOL_PROFILES[configuration.protocol]?.[configuration.presetId];
  if (!profile) fail('AGENT_CHAT_PROFILE_UNSUPPORTED');
  if (readTools.phase === 'request') {
    if (!exactObject(readTools, ['phase', ...extra])) fail('AGENT_CHAT_VALIDATION');
  } else {
    if (!exactObject(readTools, ['phase', 'toolCall', 'providerOutput', 'result', ...extra])) fail('AGENT_CHAT_VALIDATION');
    const call = readTools.toolCall;
    if (!exactObject(call, ['id', 'name', 'arguments', 'argumentsJson', ...(Object.hasOwn(call || {}, 'itemId') ? ['itemId'] : [])])) fail('AGENT_CHAT_VALIDATION');
    const normalized = normalizeToolCall(call, readTools);
    if (JSON.stringify(normalized.arguments) !== JSON.stringify(call.arguments)) fail('AGENT_CHAT_VALIDATION');
    if ((configuration.protocol === 'responses') !== Object.hasOwn(call, 'itemId')) fail('AGENT_CHAT_VALIDATION');
    if (!toolString(readTools.result, scope.limits.maxResultBytes)) {
      if (typeof readTools.result === 'string' && Buffer.byteLength(readTools.result) > scope.limits.maxResultBytes) fail('AGENT_CHAT_LIMIT');
      fail('AGENT_CHAT_VALIDATION');
    }
    try { if (!toolObject(JSON.parse(readTools.result))) fail('AGENT_CHAT_VALIDATION'); } catch { fail('AGENT_CHAT_VALIDATION'); }
  }
  return profile;
}
export function readToolRequestFields(configuration, readTools) {
  const profile = validateReadTools(configuration, readTools);
  if (!profile) return {};
  const tools = readTools.phase === 'answer' ? [] : toolScope(readTools).definitions.map(definition => {
    const {type: _type, strict: _strict, ...fields} = definition;
    const spec = {...fields, ...(profile.strict ? {strict: true} : {})};
    return configuration.protocol === 'responses' ? {type: 'function', ...spec} : {type: 'function', function: spec};
  });
  return {tools, ...(profile.choice ? {tool_choice: readTools.phase === 'answer' ? 'none' : 'auto'} : {}), ...(profile.parallel ? {parallel_tool_calls: false} : {})};
}
export function readToolMessages(messages, readTools) {
  const instruction = toolScope(readTools).instruction;
  const result = [];
  for (const [position, message] of messages.entries()) {
    if (message?.role === 'system') {
      if (position || ![CHAT_SYSTEM_INSTRUCTION, instruction].includes(message.content)) fail('AGENT_CHAT_VALIDATION');
      result.push({...message, content: instruction});
    } else result.push(message);
  }
  if (result[0]?.role !== 'system') result.unshift({role: 'system', content: instruction});
  return result;
}

/** Function metadata appears once; only argument strings are delta-encoded.
 * This state cannot dispatch. finish() is called only after clean transport EOF. */
export function chatToolAccumulator(readTools) {
  const scope = toolScope(readTools);
  let call = null;
  return {
    add(calls) {
      if (!Array.isArray(calls) || calls.length !== 1) toolProtocolError();
      const delta = calls[0];
      if (!toolObject(delta) || Object.keys(delta).some(key => !['index', 'id', 'type', 'function'].includes(key)) || delta.index !== 0 || !toolObject(delta.function) || Object.keys(delta.function).some(key => !['name', 'arguments'].includes(key))) toolProtocolError();
      if (!call) {
        if (delta.type !== 'function' || typeof delta.function.name !== 'string' || !scope.definitions.some(definition => definition.name === delta.function.name)) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
        call = {id: toolId(delta.id), name: delta.function.name, argumentsJson: ''};
      } else if (delta.id != null || delta.type != null || delta.function.name != null) toolProtocolError();
      if (delta.function.arguments !== undefined) {
        if (!toolString(delta.function.arguments, scope.limits.maxArgumentsBytes)) {
          if (typeof delta.function.arguments === 'string' && Buffer.byteLength(delta.function.arguments) > scope.limits.maxArgumentsBytes) fail('AGENT_CHAT_LIMIT');
          toolProtocolError();
        }
        call.argumentsJson += delta.function.arguments;
        if (Buffer.byteLength(call.argumentsJson) > scope.limits.maxArgumentsBytes) fail('AGENT_CHAT_LIMIT');
      }
    },
    get present() { return call !== null; },
    finish() { if (!call) toolProtocolError(); return normalizeToolCall(call, readTools); },
  };
}
export function chatToolContinuation(readTools) {
  const item = readTools.providerOutput;
  if (!exactObject(item, ['role', 'content', 'tool_calls']) || item.role !== 'assistant' || (item.content !== null && !toolString(item.content, 256 * 1024)) || !Array.isArray(item.tool_calls) || item.tool_calls.length !== 1) toolProtocolError();
  const call = item.tool_calls[0];
  if (!exactObject(call, ['id', 'type', 'function']) || call.type !== 'function' || !exactObject(call.function, ['name', 'arguments'])) toolProtocolError();
  sameToolCall(normalizeToolCall({id: call.id, name: call.function.name, argumentsJson: call.function.arguments}, readTools), readTools.toolCall);
  return [structuredClone(item), {role: 'tool', tool_call_id: call.id, content: readTools.result}];
}

export function responseToolSnapshot(item, status, readTools) {
  const scope = toolScope(readTools);
  if (toolObject(item) && ['reasoning', 'reasoning_content', 'reasoning_details', 'encrypted_content', 'thinking', 'signature', 'phase'].some(key => item[key] != null && item[key] !== '')) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
  if (!toolObject(item) || Object.keys(item).some(key => !['id', 'type', 'call_id', 'name', 'arguments', 'status'].includes(key)) || item.type !== 'function_call' || (item.status !== undefined && item.status !== status)) toolProtocolError();
  if (!scope.definitions.some(definition => definition.name === item.name)) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
  if (!toolString(item.arguments, scope.limits.maxArgumentsBytes)) {
    if (typeof item.arguments === 'string' && Buffer.byteLength(item.arguments) > scope.limits.maxArgumentsBytes) fail('AGENT_CHAT_LIMIT');
    toolProtocolError();
  }
  return {type: 'function_call', id: toolId(item.id), callId: toolId(item.call_id), name: item.name, argumentsJson: item.arguments};
}
export function compareResponseTool(snapshot, item) {
  if (!item || snapshot.type !== item.type || snapshot.id !== item.id || snapshot.callId !== item.callId || snapshot.name !== item.name || snapshot.argumentsJson !== item.argumentsJson || !item.argumentsDone) toolProtocolError();
}
export function responseToolContinuation(readTools, messageSnapshot, maxItems) {
  const output = readTools.providerOutput;
  if (!Array.isArray(output) || !output.length || output.length > maxItems) toolProtocolError();
  const ids = new Set(); let call = null;
  for (const item of output) {
    if (item?.type === 'function_call') {
      if (call) toolProtocolError();
      const snapshot = responseToolSnapshot(item, 'completed', readTools);
      call = normalizeToolCall({id: snapshot.callId, itemId: snapshot.id, name: snapshot.name, argumentsJson: snapshot.argumentsJson}, readTools);
      sameToolCall(call, readTools.toolCall);
    } else {
      const message = messageSnapshot(item, 'completed');
      if (!message.content.length) toolProtocolError();
    }
    if (ids.has(item.id)) toolProtocolError(); ids.add(item.id);
  }
  if (!call) toolProtocolError();
  return [...structuredClone(output), {type: 'function_call_output', call_id: call.id, output: readTools.result}];
}
