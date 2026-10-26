import type {AgentConfiguration} from './config.ts';
import {TIMELINE_GAIN_EDIT_TOOL_DEFINITIONS, TIMELINE_GAIN_EDIT_TOOL_LIMITS, TIMELINE_GAIN_EDIT_TOOL_SYSTEM_INSTRUCTION, parseTimelineGainEditToolArguments} from './timeline-gain-tool-policy.ts';
import {exactObject} from './config.ts';
import {agentChatError} from './chat-errors.ts';
import {CHAT_SYSTEM_INSTRUCTION} from './chat-policy.ts';
import {EDIT_TOOL_DEFINITIONS, EDIT_TOOL_LIMITS, EDIT_TOOL_SYSTEM_INSTRUCTION, parseEditToolArguments} from './edit-tool-policy.ts';
import {TIMELINE_EDIT_TOOL_DEFINITIONS, TIMELINE_EDIT_TOOL_LIMITS, TIMELINE_EDIT_TOOL_SYSTEM_INSTRUCTION, parseTimelineEditToolArguments} from './timeline-edit-tool-policy.ts';
import {AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT} from '@mioon/contracts';
import {READ_TOOL_DEFINITIONS, READ_TOOL_LIMITS, READ_TOOL_SYSTEM_INSTRUCTION, parseReadToolArguments} from './read-tool-policy.ts';
import type {AgentProtocol} from '../../../contracts/src/agent-protocol.ts';

function fail(code: 'AGENT_CHAT_VALIDATION' | 'AGENT_CHAT_PROTOCOL_ERROR' | 'AGENT_CHAT_LIMIT' | 'AGENT_CHAT_TOOLS_UNSUPPORTED' | 'AGENT_CHAT_REASONING_UNSUPPORTED' | 'AGENT_CHAT_PROFILE_UNSUPPORTED'): never {
  throw agentChatError(code);
}
export function toolProtocolError(): never { return fail('AGENT_CHAT_PROTOCOL_ERROR'); }
export const toolObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const wellFormed = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value;
export function toolString(value: unknown, maximum: number): value is string { return typeof value === 'string' && wellFormed(value) && Buffer.byteLength(value) <= maximum; }
export function toolId(value: unknown): string {
  if (!toolString(value, 256) || !value || /[\u0000-\u0020\u007f]/u.test(value)) toolProtocolError();
  return value;
}
function freeze<T extends object>(value: T): Readonly<T> { for (const child of Object.values(value as Record<string, unknown>)) if (child && typeof child === 'object') freeze(child as object); return Object.freeze(value); }

export interface WireMessage {role: string; content?: unknown; [key: string]: unknown}
export interface ParsedToolArguments {operation: string; arguments: Record<string, unknown>; dispatchArguments: Record<string, unknown>}
export interface ToolCall {id: string; name: string; arguments: Record<string, unknown>; argumentsJson: string; itemId?: string}
export interface ToolCallInput {id: unknown; name: unknown; argumentsJson: unknown; itemId?: unknown}
export interface ToolDefinition {name: string; description: string; parameters: unknown; strict: boolean}
export interface ToolLimits {maxArgumentsBytes: number; maxResultBytes: number; maxToolCalls?: number; maxModelRequests?: number; maxContextBytes: number; maxContinuationBytes?: number}
export interface ToolScope {definitions: readonly ToolDefinition[]; limits: ToolLimits; instruction: string; parse: (name: unknown, argumentsJson: unknown) => ParsedToolArguments}
export interface ToolProfile {parallel: boolean; choice: boolean; strict: boolean}
export interface ToolScopeInput {scope?: string}
export interface ReadToolState extends ToolScopeInput {
  phase?: 'request' | 'answer';
  toolCall?: ToolCall;
  providerOutput?: unknown;
  result?: string;
  [key: string]: unknown;
}
export interface ResponseToolSnapshot {type: 'function_call'; id: string; callId: string; name: string; argumentsJson: string}

// Deliberate function-wire profiles, fixture tested, never live certification.
// Unsupported controls are omitted rather than relying on them being ignored.
// DeepSeek Responses documents parallel_tool_calls as ignored (always enabled).
// Ollama marks CC tool_choice unsupported and omits it for Responses; Zhipu
// documents only auto. tools:[] and the answer parser enforce the second-round cap.
export const AGENT_READ_TOOL_PROFILES: Readonly<Record<AgentProtocol, Readonly<Record<string, ToolProfile>>>> = freeze({
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
  anthropic_messages: {
    anthropic: {parallel: false, choice: true, strict: false},
    custom: {parallel: false, choice: true, strict: false},
  },
});
/** Presets supply defaults, while protocol selection determines the tool wire
 * format. Dedicated profiles retain their existing field constraints. */
export function agentReadToolProfile(configuration: AgentConfiguration): ToolProfile {
  const profiles = AGENT_READ_TOOL_PROFILES[configuration.protocol];
  if (!profiles) fail('AGENT_CHAT_VALIDATION');
  return Object.hasOwn(profiles, configuration.presetId) ? profiles[configuration.presetId] : profiles.custom;
}
// This selector is internal and closed: callers cannot supply schemas or operations.
export function toolScope(readTools: ToolScopeInput | undefined): ToolScope {
  if (readTools?.scope !== undefined && !['selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(readTools.scope)) fail('AGENT_CHAT_VALIDATION');
  if (readTools?.scope === AGENT_TIMELINE_GAIN_CONTEXT) return {definitions: TIMELINE_GAIN_EDIT_TOOL_DEFINITIONS, limits: TIMELINE_GAIN_EDIT_TOOL_LIMITS,
    instruction: TIMELINE_GAIN_EDIT_TOOL_SYSTEM_INSTRUCTION, parse: parseTimelineGainEditToolArguments};
  if (readTools?.scope === AGENT_TIMELINE_MOVE_CONTEXT) return {definitions: TIMELINE_EDIT_TOOL_DEFINITIONS, limits: TIMELINE_EDIT_TOOL_LIMITS,
    instruction: TIMELINE_EDIT_TOOL_SYSTEM_INSTRUCTION, parse: parseTimelineEditToolArguments};
  return readTools?.scope === 'selected_shot_edit' ? {definitions: EDIT_TOOL_DEFINITIONS, limits: EDIT_TOOL_LIMITS,
    instruction: EDIT_TOOL_SYSTEM_INSTRUCTION, parse: parseEditToolArguments} : {definitions: READ_TOOL_DEFINITIONS,
    limits: READ_TOOL_LIMITS, instruction: READ_TOOL_SYSTEM_INSTRUCTION, parse: parseReadToolArguments};
}
export function normalizeToolCall({id, name, argumentsJson, itemId}: ToolCallInput, readTools: ToolScopeInput | undefined): ToolCall {
  const scope = toolScope(readTools);
  toolId(id); if (itemId !== undefined) toolId(itemId);
  if (!toolString(argumentsJson, scope.limits.maxArgumentsBytes)) {
    if (typeof argumentsJson === 'string' && Buffer.byteLength(argumentsJson) > scope.limits.maxArgumentsBytes) fail('AGENT_CHAT_LIMIT');
    toolProtocolError();
  }
  const parsed = scope.parse(name, argumentsJson);
  return {id: toolId(id), name: name as string, arguments: parsed.arguments, argumentsJson, ...(itemId !== undefined ? {itemId: itemId as string} : {})};
}
export function sameToolCall(actual: ToolCall, expected: ToolCall): void {
  if (actual.id !== expected.id || actual.name !== expected.name || actual.argumentsJson !== expected.argumentsJson || actual.itemId !== expected.itemId) toolProtocolError();
}
export function validateReadTools(configuration: AgentConfiguration, readTools: unknown): ToolProfile | undefined {
  if (readTools === undefined) return undefined;
  if (!toolObject(readTools) || !['request', 'answer'].includes(readTools.phase as string)) fail('AGENT_CHAT_VALIDATION');
  const state = readTools as ReadToolState;
  const scope = toolScope(state), extra = state.scope === undefined ? [] : ['scope'];
  const profile = agentReadToolProfile(configuration);
  if (!profile) fail('AGENT_CHAT_PROFILE_UNSUPPORTED');
  if (state.phase === 'request') {
    if (!exactObject(state, ['phase', ...extra])) fail('AGENT_CHAT_VALIDATION');
  } else {
    if (!exactObject(state, ['phase', 'toolCall', 'providerOutput', 'result', ...extra])) fail('AGENT_CHAT_VALIDATION');
    const call = state.toolCall;
    if (!exactObject(call, ['id', 'name', 'arguments', 'argumentsJson', ...(Object.hasOwn(call || {}, 'itemId') ? ['itemId'] : [])])) fail('AGENT_CHAT_VALIDATION');
    const normalized = normalizeToolCall(call, state);
    if (JSON.stringify(normalized.arguments) !== JSON.stringify(call.arguments)) fail('AGENT_CHAT_VALIDATION');
    if ((configuration.protocol === 'responses') !== Object.hasOwn(call, 'itemId')) fail('AGENT_CHAT_VALIDATION');
    if (!toolString(state.result, scope.limits.maxResultBytes)) {
      if (typeof state.result === 'string' && Buffer.byteLength(state.result) > scope.limits.maxResultBytes) fail('AGENT_CHAT_LIMIT');
      fail('AGENT_CHAT_VALIDATION');
    }
    try { if (!toolObject(JSON.parse(state.result))) fail('AGENT_CHAT_VALIDATION'); } catch { fail('AGENT_CHAT_VALIDATION'); }
  }
  return profile;
}
export function readToolRequestFields(configuration: AgentConfiguration, readTools: unknown): Record<string, unknown> {
  const profile = validateReadTools(configuration, readTools);
  if (!profile) return {};
  const state = readTools as ReadToolState;
  if (configuration.protocol === 'anthropic_messages') {
    const tools = state.phase === 'answer' ? [] : toolScope(state).definitions.map(definition => ({
      name: definition.name, description: definition.description, input_schema: definition.parameters,
    }));
    return {tools, tool_choice: state.phase === 'answer' ? {type: 'none'} : {type: 'auto', disable_parallel_tool_use: true}};
  }
  const tools = state.phase === 'answer' ? [] : toolScope(state).definitions.map(definition => {
    const {type: _type, strict: _strict, ...fields} = definition as ToolDefinition & {type?: unknown};
    const spec = {...fields, ...(profile.strict ? {strict: true} : {})};
    return configuration.protocol === 'responses' ? {type: 'function', ...spec} : {type: 'function', function: spec};
  });
  return {tools, ...(profile.choice ? {tool_choice: state.phase === 'answer' ? 'none' : 'auto'} : {}), ...(profile.parallel ? {parallel_tool_calls: false} : {})};
}
export function readToolMessages(messages: readonly WireMessage[], readTools: unknown): WireMessage[] {
  const instruction = toolScope(readTools as ToolScopeInput | undefined).instruction;
  const result: WireMessage[] = [];
  for (const [position, message] of messages.entries()) {
    if (message?.role === 'system') {
      if (position || ![CHAT_SYSTEM_INSTRUCTION, instruction].includes(message.content as string)) fail('AGENT_CHAT_VALIDATION');
      result.push({...message, content: instruction});
    } else result.push(message);
  }
  if (result[0]?.role !== 'system') result.unshift({role: 'system', content: instruction});
  return result;
}
interface ToolAccumulatorCall {id: string; name: string; argumentsJson: string}
export interface ToolAccumulator {add(calls: unknown): void; readonly present: boolean; finish(): ToolCall}

/** Function metadata appears once; only argument strings are delta-encoded.
 * This state cannot dispatch. finish() is called only after clean transport EOF. */
export function chatToolAccumulator(readTools: unknown): ToolAccumulator {
  const scope = toolScope(readTools as ToolScopeInput | undefined);
  let call: ToolAccumulatorCall | null = null;
  return {
    add(calls: unknown) {
      if (!Array.isArray(calls) || calls.length !== 1) toolProtocolError();
      const delta: unknown = calls[0];
      if (!toolObject(delta) || Object.keys(delta).some(key => !['index', 'id', 'type', 'function'].includes(key)) || delta.index !== 0) toolProtocolError();
      const fn = delta.function;
      if (!toolObject(fn) || Object.keys(fn).some(key => !['name', 'arguments'].includes(key))) toolProtocolError();
      if (!call) {
        if (delta.type !== 'function' || typeof fn.name !== 'string') fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
        const name = fn.name;
        if (!scope.definitions.some(definition => definition.name === name)) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
        call = {id: toolId(delta.id), name, argumentsJson: ''};
      } else if (delta.id != null || delta.type != null || fn.name != null) toolProtocolError();
      const argumentsValue = fn.arguments;
      if (argumentsValue !== undefined) {
        if (!toolString(argumentsValue, scope.limits.maxArgumentsBytes)) {
          if (typeof argumentsValue === 'string' && Buffer.byteLength(argumentsValue) > scope.limits.maxArgumentsBytes) fail('AGENT_CHAT_LIMIT');
          toolProtocolError();
        }
        call.argumentsJson += argumentsValue;
        if (Buffer.byteLength(call.argumentsJson) > scope.limits.maxArgumentsBytes) fail('AGENT_CHAT_LIMIT');
      }
    },
    get present(): boolean { return call !== null; },
    finish(): ToolCall { if (!call) toolProtocolError(); return normalizeToolCall(call, readTools as ToolScopeInput | undefined); },
  };
}
export function chatToolContinuation(readTools: ReadToolState): unknown[] {
  const item = readTools.providerOutput;
  if (!exactObject(item, ['role', 'content', 'tool_calls']) || item.role !== 'assistant' || (item.content !== null && !toolString(item.content, 256 * 1024)) || !Array.isArray(item.tool_calls) || item.tool_calls.length !== 1) toolProtocolError();
  const call: unknown = item.tool_calls[0];
  if (!exactObject(call, ['id', 'type', 'function']) || call.type !== 'function' || !exactObject(call.function, ['name', 'arguments'])) toolProtocolError();
  const fn = call.function;
  sameToolCall(normalizeToolCall({id: call.id, name: fn.name, argumentsJson: fn.arguments}, readTools), readTools.toolCall as ToolCall);
  return [structuredClone(item), {role: 'tool', tool_call_id: call.id, content: readTools.result}];
}

export function responseToolSnapshot(item: unknown, status: string, readTools: unknown): ResponseToolSnapshot {
  const scope = toolScope(readTools as ToolScopeInput | undefined);
  if (toolObject(item) && ['reasoning', 'reasoning_content', 'reasoning_details', 'encrypted_content', 'thinking', 'signature', 'phase'].some(key => item[key] != null && item[key] !== '')) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
  if (!toolObject(item) || Object.keys(item).some(key => !['id', 'type', 'call_id', 'name', 'arguments', 'status'].includes(key)) || item.type !== 'function_call' || (item.status !== undefined && item.status !== status)) toolProtocolError();
  if (!scope.definitions.some(definition => definition.name === item.name)) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
  const argumentsValue = item.arguments;
  if (!toolString(argumentsValue, scope.limits.maxArgumentsBytes)) {
    if (typeof argumentsValue === 'string' && Buffer.byteLength(argumentsValue) > scope.limits.maxArgumentsBytes) fail('AGENT_CHAT_LIMIT');
    toolProtocolError();
  }
  return {type: 'function_call', id: toolId(item.id), callId: toolId(item.call_id), name: item.name as string, argumentsJson: argumentsValue};
}
export function compareResponseTool(snapshot: ResponseToolSnapshot, item: unknown): void {
  if (!item || snapshot.type !== (item as {type?: unknown}).type || snapshot.id !== (item as {id?: unknown}).id ||
    snapshot.callId !== (item as {callId?: unknown}).callId || snapshot.name !== (item as {name?: unknown}).name ||
    snapshot.argumentsJson !== (item as {argumentsJson?: unknown}).argumentsJson || !(item as {argumentsDone?: unknown}).argumentsDone) toolProtocolError();
}
export function responseToolContinuation(readTools: ReadToolState, messageSnapshot: (item: unknown, status: string) => {id: string; content: unknown[]}, maxItems: number): unknown[] {
  const output = readTools.providerOutput;
  if (!Array.isArray(output) || !output.length || output.length > maxItems) toolProtocolError();
  const ids = new Set<unknown>(); let call: ToolCall | null = null;
  for (const entry of output) {
    const item = entry as {type?: unknown; id?: unknown} | null;
    if (item?.type === 'function_call') {
      if (call) toolProtocolError();
      const snapshot = responseToolSnapshot(item, 'completed', readTools);
      call = normalizeToolCall({id: snapshot.callId, itemId: snapshot.id, name: snapshot.name, argumentsJson: snapshot.argumentsJson}, readTools);
      sameToolCall(call, readTools.toolCall as ToolCall);
    } else {
      const message = messageSnapshot(item, 'completed');
      if (!message.content.length) toolProtocolError();
    }
    if (ids.has(item?.id)) toolProtocolError(); ids.add(item?.id);
  }
  if (!call) toolProtocolError();
  return [...structuredClone(output), {type: 'function_call_output', call_id: call.id, output: readTools.result}];
}
