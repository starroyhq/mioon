import {agentChatError, agentChatLimitError, agentChatProtocolError, agentChatStreamError} from './chat-errors.ts';
import type {AgentChatErrorCode} from './chat-errors.ts';
import type {AgentFailureLimit, AgentProtocolFailureReason} from '../../../contracts/src/agent-failure-diagnostic.ts';
import {parseAgentSse, AGENT_SSE_LIMITS} from './sse.ts';
import {parseModelToolArguments} from './model-tool-arguments.ts';
import type {AgentTaskJson} from '@mioon/contracts/agent-tasks-v2';

export type AnthropicContentBlock = {type: 'text'; text: string} | {type: 'thinking'; thinking: string; signature: string} | {type: 'redacted_thinking'; data: string} |
  {type: 'tool_use'; id: string; name: string; input: Record<string, AgentTaskJson>};
export interface AnthropicCompletion {
  text: string;
  content: AnthropicContentBlock[];
  toolCalls: {id: string; name: string; argumentsJson: string}[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';
  usage?: {prompt_tokens?: number; completion_tokens?: number; total_tokens?: number};
}
export interface AnthropicStreamOptions {
  signal?: AbortSignal;
  maxOutputBytes: number;
  maxArgumentBytes: number;
  maxToolCalls: number;
  /** Task measurements are optional passive metadata. Legacy chat consumers
   * keep required, bounded usage validation unless they explicitly opt in. */
  usageMode?: 'required' | 'optional';
  onUsage?: (raw: unknown) => void;
  /** Only a request that enabled thinking admits thinking blocks. They are kept
   * in their original order for this round's continuation, never as text. */
  thinking?: boolean;
  /** Only the exact Sonnet frozen adaptive/low request admits its fixed beta's
   * passive binding metadata. This does not enable thinking or tools. */
  sonnetPrefixBinding?: boolean;
}
export type AnthropicStreamItem = {type: 'delta'; text: string} | {type: 'done'; completion: AnthropicCompletion};
interface TextBlock {type: 'text'; text: string; closed: boolean}
interface ToolBlock {type: 'tool_use'; id: string; name: string; argumentsJson: string; initialInput: boolean; closed: boolean}
interface ThinkingBlock {type: 'thinking'; thinking: string; signature: string; closed: boolean}
interface RedactedThinkingBlock {type: 'redacted_thinking'; data: string; closed: boolean}
type Block = TextBlock | ToolBlock | ThinkingBlock | RedactedThinkingBlock;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const messageEvents = new Set(['error', 'ping', 'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
function fail(code: AgentChatErrorCode, reason: AgentProtocolFailureReason, details?: Parameters<typeof agentChatProtocolError>[2]): never {
  throw agentChatProtocolError(code, reason, details);
}
function invalidField(field: string, code: AgentChatErrorCode = 'AGENT_CHAT_PROTOCOL_ERROR'): never {
  return fail(code, 'invalid_field', {field});
}
function text(value: unknown, maximum: number, field = 'text', limit: AgentFailureLimit = 'output_bytes'): string {
  if (typeof value !== 'string' || Buffer.from(value).toString('utf8') !== value) invalidField(field);
  if (Buffer.byteLength(value) > maximum) throw agentChatLimitError(limit);
  return value;
}
function id(value: unknown, field = 'id'): string {
  const result = text(value, 256, field, 'identifier_bytes');
  if (!result || /[\u0000-\u0020\u007f]/u.test(result)) invalidField(field);
  return result;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalidField('unknown_field');
}
function inputTransformations(value: unknown): void {
  if (value === null) return;
  if (!Array.isArray(value)) invalidField('input_transformations');
  for (const entry of value) {
    if (!object(entry)) invalidField('input_transformations');
    fields(entry, ['type', 'path', 'reason']);
    // Future binding checks may report new values. These fields are passive metadata.
    text(entry.type, 256, 'input_transformations', 'field_bytes');
    text(entry.reason, 256, 'input_transformations', 'field_bytes');
    const path = text(entry.path, 256, 'input_transformations', 'field_bytes'), indices = /^messages\.(0|[1-9][0-9]*)\.content\.(0|[1-9][0-9]*)$/u.exec(path);
    if (!indices || !Number.isSafeInteger(Number(indices[1])) || !Number.isSafeInteger(Number(indices[2]))) invalidField('input_transformations');
  }
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidField('usage');
  if (value > 10_000_000) throw agentChatLimitError('usage_tokens', 'AGENT_CHAT_PROTOCOL_ERROR');
  return value;
}
interface TokenUsage {input: number; cacheCreation: number; cacheRead: number; output: number}
function serviceTier(value: unknown): void {
  if (value != null && !['standard', 'priority', 'batch'].includes(value as string)) invalidField('service_tier');
}
function usageCapabilities(value: Record<string, unknown>, thinking: boolean): void {
  if (value.output_tokens_details != null) {
    if (!object(value.output_tokens_details)) invalidField('usage');
    fields(value.output_tokens_details, ['thinking_tokens']);
    if (count(value.output_tokens_details.thinking_tokens) && !thinking) invalidField('usage', 'AGENT_CHAT_REASONING_UNSUPPORTED');
  }
  if (value.server_tool_use != null) {
    if (!object(value.server_tool_use)) invalidField('usage');
    fields(value.server_tool_use, ['web_fetch_requests', 'web_search_requests']);
    if (count(value.server_tool_use.web_fetch_requests) || count(value.server_tool_use.web_search_requests)) invalidField('usage', 'AGENT_CHAT_TOOLS_UNSUPPORTED');
  }
}
function usageMetadata(value: Record<string, unknown>, start: boolean, thinking: boolean): void {
  fields(value, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'output_tokens_details', 'server_tool_use', 'service_tier',
    ...(start ? ['cache_creation', 'inference_geo', 'speed'] : [])]);
  usageCapabilities(value, thinking);
  if (value.cache_creation != null) {
    if (!object(value.cache_creation)) invalidField('usage');
    fields(value.cache_creation, ['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens']);
    if (count(value.cache_creation.ephemeral_1h_input_tokens) + count(value.cache_creation.ephemeral_5m_input_tokens) > 10_000_000) throw agentChatLimitError('usage_tokens', 'AGENT_CHAT_PROTOCOL_ERROR');
  }
  if (value.inference_geo != null) text(value.inference_geo, 128, 'usage', 'field_bytes');
  serviceTier(value.service_tier);
  if (value.speed != null && !['standard', 'fast'].includes(value.speed as string)) invalidField('usage');
}
function inputUsage(value: unknown, thinking: boolean): TokenUsage {
  if (!object(value)) invalidField('usage');
  usageMetadata(value, true, thinking);
  const usage = {input: count(value.input_tokens), cacheCreation: count(value.cache_creation_input_tokens ?? 0), cacheRead: count(value.cache_read_input_tokens ?? 0), output: count(value.output_tokens)};
  promptTokens(usage);
  return usage;
}
function promptTokens(usage: TokenUsage): number {
  const total = usage.input + usage.cacheCreation + usage.cacheRead;
  if (total > 10_000_000) throw agentChatLimitError('usage_tokens', 'AGENT_CHAT_PROTOCOL_ERROR');
  return total;
}
function refusalDetails(value: unknown, reason: unknown): void {
  if (value == null) return;
  if (reason !== 'refusal' || !object(value)) invalidField('stop_details');
  fields(value, ['type', 'category', 'explanation']);
  if (value.type !== 'refusal' || value.category !== null &&
    !['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms'].includes(value.category as string)) invalidField('stop_details');
  // This is diagnostic metadata, never user text or retained provider output.
  if (value.explanation !== null) text(value.explanation, AGENT_SSE_LIMITS.maxEventBytes, 'stop_details', 'field_bytes');
}

/** Native Messages events only. Text may stream early, but a tool completion is
 * released only after all blocks, message_stop and a clean framed EOF. The SDK
 * neither accumulates/executes tools nor reconnects this bounded raw stream. */
export async function* streamAnthropicMessages(body: AsyncIterable<Uint8Array>, options: AnthropicStreamOptions): AsyncGenerator<AnthropicStreamItem, void, undefined> {
  const optionalUsage = options.usageMode === 'optional', thinking = options.thinking === true;
  let started = false, stopped = false, sawFinalUsage = false, outputBytes = 0, toolCount = 0;
  let stopReason: AnthropicCompletion['stopReason'] | undefined, usage: TokenUsage | undefined;
  const blocks: Block[] = [], toolIds = new Set<string>();
  const addBytes = (value: string) => {
    outputBytes += Buffer.byteLength(value);
    if (outputBytes > options.maxOutputBytes) throw agentChatLimitError('output_bytes');
  };
  const openBlock = (value: unknown): Block => {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= blocks.length) return fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_field', {field: 'index'});
    const block = blocks[value as number]!;
    if (block.closed) return fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_field', {field: 'index'});
    return block;
  };
  for await (const frame of parseAgentSse(body, {...AGENT_SSE_LIMITS, includeEventName: true, signal: options.signal})) {
    if (options.signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
    const event = frame.eventName ?? undefined;
    if (stopped) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_event', {event, field: 'done'});
    let value: unknown;
    try { value = parseModelToolArguments(frame.data, AGENT_SSE_LIMITS.maxEventBytes); }
    catch { fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_event', {event, field: 'json'}); }
    if (!object(value) || frame.eventName !== value.type || frame.event !== value.type) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_event', {event, field: 'event_name'});
    if (!messageEvents.has(frame.event)) fail('AGENT_CHAT_PROTOCOL_ERROR', 'unknown_event', {event});
    if (value.type === 'error') fail('AGENT_CHAT_PROVIDER_ERROR', 'provider_error', {event});
    if (value.type === 'ping') { fields(value, ['type']); continue; }
    if (value.type === 'message_start') {
      fields(value, ['type', 'message']);
      if (started || !object(value.message)) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_event', {event});
      const message = value.message;
      fields(message, ['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence', 'usage', 'container', 'diagnostics', 'stop_details', 'service_tier',
        ...(options.sonnetPrefixBinding === true ? ['input_transformations'] : [])]);
      if (Object.hasOwn(message, 'input_transformations')) inputTransformations(message.input_transformations);
      if (message.type !== 'message') invalidField('type');
      if (message.role !== 'assistant') invalidField('role');
      if (!Array.isArray(message.content) || message.content.length) invalidField('content');
      for (const field of ['stop_reason', 'stop_sequence', 'container', 'diagnostics', 'stop_details']) {
        if (message[field] != null) invalidField(field);
      }
      id(message.id); id(message.model, 'model');
      // Compatible providers may repeat this passive usage metadata on the
      // message itself. Validate it without retaining it or granting abilities.
      serviceTier(message.service_tier);
      if (optionalUsage) {
        if (object(message.usage)) usageCapabilities(message.usage, thinking);
      } else usage = inputUsage(message.usage, thinking);
      options.onUsage?.(message.usage);
      started = true;
      continue;
    }
    if (!started) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_event', {event});
    if (value.type === 'content_block_start') {
      fields(value, ['type', 'index', 'content_block']);
      if (stopReason) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_event', {event, field: 'stop_reason'});
      if (value.index !== blocks.length) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_field', {event, field: 'index'});
      if (!object(value.content_block)) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_field', {event, field: 'content_block'});
      const block = value.content_block;
      if (!thinking && (block.type === 'thinking' || block.type === 'redacted_thinking')) fail('AGENT_CHAT_REASONING_UNSUPPORTED', 'unsupported_item', {event, item: block.type});
      if (block.type === 'text') {
        fields(block, ['type', 'text', 'citations']);
        if (block.citations != null && (!Array.isArray(block.citations) || block.citations.length)) invalidField('citations');
        const initial = text(block.text, options.maxOutputBytes); addBytes(initial);
        blocks.push({type: 'text', text: initial, closed: false});
        if (initial) yield {type: 'delta', text: initial};
      } else if (block.type === 'tool_use') {
        fields(block, ['type', 'id', 'name', 'input', 'caller', 'toolset_name']);
        if (block.caller !== undefined) {
          if (!object(block.caller)) invalidField('caller');
          fields(block.caller, ['type']);
          if (block.caller.type !== 'direct') invalidField('caller', 'AGENT_CHAT_TOOLS_UNSUPPORTED');
        }
        if (block.toolset_name != null) invalidField('toolset_name', 'AGENT_CHAT_TOOLS_UNSUPPORTED');
        const callId = id(block.id), name = id(block.name, 'name');
        if (toolIds.has(callId)) invalidField('id');
        if (++toolCount > options.maxToolCalls) throw agentChatLimitError('tool_calls', 'AGENT_CHAT_TOOLS_UNSUPPORTED');
        if (!object(block.input)) invalidField('input');
        const initialInput = Object.keys(block.input).length > 0;
        const argumentsJson = initialInput ? JSON.stringify(block.input) : '';
        if (Buffer.byteLength(argumentsJson) > options.maxArgumentBytes) throw agentChatLimitError('argument_bytes');
        addBytes(argumentsJson); toolIds.add(callId);
        blocks.push({type: 'tool_use', id: callId, name, argumentsJson, initialInput, closed: false});
      } else if (block.type === 'thinking') {
        fields(block, ['type', 'thinking', 'signature']);
        const initial = text(block.thinking, options.maxOutputBytes, 'thinking', 'reasoning_bytes'), signature = block.signature === undefined ? '' : text(block.signature, options.maxOutputBytes, 'signature', 'reasoning_bytes');
        addBytes(initial); addBytes(signature);
        blocks.push({type: 'thinking', thinking: initial, signature, closed: false});
      } else if (block.type === 'redacted_thinking') {
        fields(block, ['type', 'data']);
        const data = text(block.data, options.maxOutputBytes, 'data', 'reasoning_bytes');
        if (!data) invalidField('data');
        addBytes(data);
        blocks.push({type: 'redacted_thinking', data, closed: false});
      } else fail('AGENT_CHAT_TOOLS_UNSUPPORTED', 'unsupported_item', {event, item: block.type});
      continue;
    }
    if (value.type === 'content_block_delta') {
      fields(value, ['type', 'index', 'delta']);
      if (stopReason || !object(value.delta)) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_event', {event, field: 'delta'});
      const block = openBlock(value.index), delta = value.delta;
      if (!thinking && (delta.type === 'thinking_delta' || delta.type === 'signature_delta')) fail('AGENT_CHAT_REASONING_UNSUPPORTED', 'invalid_field', {event, item: block.type, field: delta.type === 'thinking_delta' ? 'thinking' : 'signature'});
      if (block.type === 'text') {
        fields(delta, ['type', 'text']);
        if (delta.type !== 'text_delta') fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_field', {event, item: block.type, field: 'type'});
        const part = text(delta.text, options.maxOutputBytes); addBytes(part); block.text += part;
        if (part) yield {type: 'delta', text: part};
      } else if (block.type === 'tool_use') {
        fields(delta, ['type', 'partial_json']);
        if (delta.type !== 'input_json_delta' || block.initialInput) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_field', {event, item: block.type, field: 'type'});
        const part = text(delta.partial_json, options.maxArgumentBytes, 'partial_json', 'argument_bytes'); addBytes(part); block.argumentsJson += part;
        if (Buffer.byteLength(block.argumentsJson) > options.maxArgumentBytes) throw agentChatLimitError('argument_bytes');
      } else if (block.type === 'thinking' && delta.type === 'thinking_delta') {
        fields(delta, ['type', 'thinking']);
        const part = text(delta.thinking, options.maxOutputBytes, 'thinking', 'reasoning_bytes'); addBytes(part); block.thinking += part;
      } else if (block.type === 'thinking' && delta.type === 'signature_delta') {
        fields(delta, ['type', 'signature']);
        const part = text(delta.signature, options.maxOutputBytes, 'signature', 'reasoning_bytes'); addBytes(part); block.signature += part;
      } else fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_field', {event, item: block.type, field: 'type'});
      continue;
    }
    if (value.type === 'content_block_stop') {
      fields(value, ['type', 'index']);
      if (stopReason) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_event', {event, field: 'stop_reason'});
      openBlock(value.index).closed = true;
      continue;
    }
    if (value.type === 'message_delta') {
      fields(value, ['type', 'delta', 'usage', ...(options.sonnetPrefixBinding === true ? ['input_transformations'] : [])]);
      if (Object.hasOwn(value, 'input_transformations')) inputTransformations(value.input_transformations);
      if (stopReason || blocks.some(block => !block.closed)) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_event', {event});
      if (!object(value.delta)) invalidField('delta');
      if (!optionalUsage && !object(value.usage)) invalidField('usage');
      fields(value.delta, ['stop_reason', 'stop_sequence', 'container', 'stop_details']);
      if (value.delta.container != null) invalidField('container');
      refusalDetails(value.delta.stop_details, value.delta.stop_reason);
      if (optionalUsage) {
        // Counts may be absent or malformed, but usage cannot advertise an
        // unsupported thinking/server-tool capability and bypass its gate.
        if (object(value.usage)) usageCapabilities(value.usage, thinking);
      } else {
        if (!object(value.usage)) invalidField('usage');
        usageMetadata(value.usage, false, thinking);
        const nextTokens = count(value.usage.output_tokens);
        if (!usage || nextTokens < usage.output) invalidField('usage');
        usage.output = nextTokens;
        // SDK usage counters are whole-message cumulative totals. Null means the
        // counter is absent in this event; present counters replace, never add.
        for (const [field, key] of [['input_tokens', 'input'], ['cache_creation_input_tokens', 'cacheCreation'], ['cache_read_input_tokens', 'cacheRead']] as const) {
          if (value.usage[field] == null) continue;
          const next = count(value.usage[field]);
          if (next < usage[key]) invalidField('usage');
          usage[key] = next;
        }
        promptTokens(usage);
      }
      options.onUsage?.(value.usage);
      const reason = value.delta.stop_reason;
      if (reason == null && value.delta.stop_sequence != null) invalidField('stop_sequence');
      if (reason === 'model_context_window_exceeded') throw agentChatStreamError('output_limit', {}, 'context_tokens');
      if (reason === 'pause_turn') fail('AGENT_CHAT_TOOLS_UNSUPPORTED', 'invalid_field', {event, field: 'stop_reason'});
      if (reason != null) {
        if (!['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal'].includes(reason as string)) fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_field', {event, field: 'stop_reason'});
        stopReason = reason as AnthropicCompletion['stopReason'];
        if (reason === 'stop_sequence') { if (!text(value.delta.stop_sequence, 256, 'stop_sequence', 'field_bytes')) invalidField('stop_sequence'); }
        else if (value.delta.stop_sequence != null) invalidField('stop_sequence');
      }
      sawFinalUsage = true;
      continue;
    }
    if (value.type === 'message_stop') {
      fields(value, ['type']);
      if (!stopReason || (!optionalUsage && !sawFinalUsage) || blocks.some(block => !block.closed)) fail('AGENT_CHAT_PROTOCOL_ERROR', 'incomplete_stream', {event});
      stopped = true;
      continue;
    }
    fail('AGENT_CHAT_PROTOCOL_ERROR', 'unknown_event', {event});
  }
  if (options.signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
  if (!stopped || !stopReason || (!optionalUsage && !usage)) throw agentChatStreamError('missing_done');
  if ((stopReason === 'tool_use') !== (toolCount > 0) && !['max_tokens', 'refusal'].includes(stopReason)) fail('AGENT_CHAT_PROTOCOL_ERROR', 'terminal_mismatch', {event: 'message_stop', field: 'stop_reason'});
  const toolCalls: AnthropicCompletion['toolCalls'] = [];
  const content: AnthropicContentBlock[] = blocks.map(block => {
    if (block.type === 'text') return {type: 'text', text: block.text};
    if (block.type === 'redacted_thinking') return {type: 'redacted_thinking', data: block.data};
    if (block.type === 'thinking') {
      // Continuation must return the signature that lets the provider verify this block.
      if (!block.signature) { if (stopReason === 'max_tokens') throw agentChatStreamError('output_limit'); fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_field', {item: 'thinking', field: 'signature'}); }
      return {type: 'thinking', thinking: block.thinking, signature: block.signature};
    }
    const argumentsJson = block.argumentsJson || '{}';
    let input: Record<string, AgentTaskJson>;
    try { input = parseModelToolArguments(argumentsJson, options.maxArgumentBytes); }
    catch { if (stopReason === 'max_tokens') throw agentChatStreamError('output_limit'); fail('AGENT_CHAT_PROTOCOL_ERROR', 'invalid_field', {item: 'tool_use', field: 'arguments'}); }
    toolCalls.push({id: block.id, name: block.name, argumentsJson});
    return {type: 'tool_use', id: block.id, name: block.name, input};
  });
  yield {type: 'done', completion: {text: content.filter((block): block is Extract<AnthropicContentBlock, {type: 'text'}> => block.type === 'text').map(block => block.text).join(''),
    content, toolCalls, stopReason, ...(usage ? {usage: {prompt_tokens: promptTokens(usage), completion_tokens: usage.output, total_tokens: promptTokens(usage) + usage.output}} : {})}};
}
