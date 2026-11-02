import {agentChatError, agentChatStreamError} from './chat-errors.ts';
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
}
export type AnthropicStreamItem = {type: 'delta'; text: string} | {type: 'done'; completion: AnthropicCompletion};
interface TextBlock {type: 'text'; text: string; closed: boolean}
interface ToolBlock {type: 'tool_use'; id: string; name: string; argumentsJson: string; initialInput: boolean; closed: boolean}
interface ThinkingBlock {type: 'thinking'; thinking: string; signature: string; closed: boolean}
interface RedactedThinkingBlock {type: 'redacted_thinking'; data: string; closed: boolean}
type Block = TextBlock | ToolBlock | ThinkingBlock | RedactedThinkingBlock;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code = 'AGENT_CHAT_PROTOCOL_ERROR'): never { throw agentChatError(code); }
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || Buffer.from(value).toString('utf8') !== value) fail();
  if (Buffer.byteLength(value) > maximum) fail('AGENT_CHAT_LIMIT');
  return value;
}
function id(value: unknown): string {
  const result = text(value, 256);
  if (!result || /[\u0000-\u0020\u007f]/u.test(result)) fail();
  return result;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail();
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10_000_000) fail();
  return value;
}
interface TokenUsage {input: number; cacheCreation: number; cacheRead: number; output: number}
function serviceTier(value: unknown): void {
  if (value != null && !['standard', 'priority', 'batch'].includes(value as string)) fail();
}
function usageCapabilities(value: Record<string, unknown>, thinking: boolean): void {
  if (value.output_tokens_details != null) {
    if (!object(value.output_tokens_details)) fail();
    fields(value.output_tokens_details, ['thinking_tokens']);
    if (count(value.output_tokens_details.thinking_tokens) && !thinking) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
  }
  if (value.server_tool_use != null) {
    if (!object(value.server_tool_use)) fail();
    fields(value.server_tool_use, ['web_fetch_requests', 'web_search_requests']);
    if (count(value.server_tool_use.web_fetch_requests) || count(value.server_tool_use.web_search_requests)) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
  }
}
function usageMetadata(value: Record<string, unknown>, start: boolean, thinking: boolean): void {
  fields(value, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'output_tokens_details', 'server_tool_use', 'service_tier',
    ...(start ? ['cache_creation', 'inference_geo', 'speed'] : [])]);
  usageCapabilities(value, thinking);
  if (value.cache_creation != null) {
    if (!object(value.cache_creation)) fail();
    fields(value.cache_creation, ['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens']);
    if (count(value.cache_creation.ephemeral_1h_input_tokens) + count(value.cache_creation.ephemeral_5m_input_tokens) > 10_000_000) fail();
  }
  if (value.inference_geo != null) text(value.inference_geo, 128);
  serviceTier(value.service_tier);
  if (value.speed != null && !['standard', 'fast'].includes(value.speed as string)) fail();
}
function inputUsage(value: unknown, thinking: boolean): TokenUsage {
  if (!object(value)) fail();
  usageMetadata(value, true, thinking);
  const usage = {input: count(value.input_tokens), cacheCreation: count(value.cache_creation_input_tokens ?? 0), cacheRead: count(value.cache_read_input_tokens ?? 0), output: count(value.output_tokens)};
  promptTokens(usage);
  return usage;
}
function promptTokens(usage: TokenUsage): number {
  const total = usage.input + usage.cacheCreation + usage.cacheRead;
  if (total > 10_000_000) fail();
  return total;
}
function refusalDetails(value: unknown, reason: unknown): void {
  if (value == null) return;
  if (reason !== 'refusal' || !object(value)) fail();
  fields(value, ['type', 'category', 'explanation']);
  if (value.type !== 'refusal' || value.category !== null &&
    !['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms'].includes(value.category as string)) fail();
  // This is diagnostic metadata, never user text or retained provider output.
  if (value.explanation !== null) text(value.explanation, AGENT_SSE_LIMITS.maxEventBytes);
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
    if (outputBytes > options.maxOutputBytes) fail('AGENT_CHAT_LIMIT');
  };
  const openBlock = (value: unknown): Block => {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= blocks.length) return fail();
    const block = blocks[value as number]!;
    if (block.closed) return fail();
    return block;
  };
  for await (const frame of parseAgentSse(body, {...AGENT_SSE_LIMITS, includeEventName: true, signal: options.signal})) {
    if (options.signal?.aborted) fail('AGENT_CHAT_ABORTED');
    if (stopped) fail();
    const value: unknown = parseModelToolArguments(frame.data, AGENT_SSE_LIMITS.maxEventBytes);
    if (!object(value) || frame.eventName !== value.type || frame.event !== value.type) fail();
    if (value.type === 'error') fail('AGENT_CHAT_PROVIDER_ERROR');
    if (value.type === 'ping') { fields(value, ['type']); continue; }
    if (value.type === 'message_start') {
      fields(value, ['type', 'message']);
      if (started || !object(value.message)) fail();
      const message = value.message;
      fields(message, ['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence', 'usage', 'container', 'diagnostics', 'stop_details', 'service_tier']);
      if (message.type !== 'message' || message.role !== 'assistant' || !Array.isArray(message.content) || message.content.length ||
        message.stop_reason != null || message.stop_sequence != null || message.container != null || message.diagnostics != null || message.stop_details != null) fail();
      id(message.id); id(message.model);
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
    if (!started) fail();
    if (value.type === 'content_block_start') {
      fields(value, ['type', 'index', 'content_block']);
      if (stopReason || value.index !== blocks.length || !object(value.content_block)) fail();
      const block = value.content_block;
      if (!thinking && (block.type === 'thinking' || block.type === 'redacted_thinking')) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
      if (block.type === 'text') {
        fields(block, ['type', 'text', 'citations']);
        if (block.citations != null && (!Array.isArray(block.citations) || block.citations.length)) fail();
        const initial = text(block.text, options.maxOutputBytes); addBytes(initial);
        blocks.push({type: 'text', text: initial, closed: false});
        if (initial) yield {type: 'delta', text: initial};
      } else if (block.type === 'tool_use') {
        fields(block, ['type', 'id', 'name', 'input', 'caller', 'toolset_name']);
        if (block.caller !== undefined) {
          if (!object(block.caller)) fail();
          fields(block.caller, ['type']);
          if (block.caller.type !== 'direct') fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
        }
        if (block.toolset_name != null) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
        const callId = id(block.id), name = id(block.name);
        if (toolIds.has(callId)) fail();
        if (++toolCount > options.maxToolCalls) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
        if (!object(block.input)) fail();
        const initialInput = Object.keys(block.input).length > 0;
        const argumentsJson = initialInput ? JSON.stringify(block.input) : '';
        if (Buffer.byteLength(argumentsJson) > options.maxArgumentBytes) fail('AGENT_CHAT_LIMIT');
        addBytes(argumentsJson); toolIds.add(callId);
        blocks.push({type: 'tool_use', id: callId, name, argumentsJson, initialInput, closed: false});
      } else if (block.type === 'thinking') {
        fields(block, ['type', 'thinking', 'signature']);
        const initial = text(block.thinking, options.maxOutputBytes), signature = block.signature === undefined ? '' : text(block.signature, options.maxOutputBytes);
        addBytes(initial); addBytes(signature);
        blocks.push({type: 'thinking', thinking: initial, signature, closed: false});
      } else if (block.type === 'redacted_thinking') {
        fields(block, ['type', 'data']);
        const data = text(block.data, options.maxOutputBytes);
        if (!data) fail();
        addBytes(data);
        blocks.push({type: 'redacted_thinking', data, closed: false});
      } else fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
      continue;
    }
    if (value.type === 'content_block_delta') {
      fields(value, ['type', 'index', 'delta']);
      if (stopReason || !object(value.delta)) fail();
      const block = openBlock(value.index), delta = value.delta;
      if (!thinking && (delta.type === 'thinking_delta' || delta.type === 'signature_delta')) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
      if (block.type === 'text') {
        fields(delta, ['type', 'text']);
        if (delta.type !== 'text_delta') fail();
        const part = text(delta.text, options.maxOutputBytes); addBytes(part); block.text += part;
        if (part) yield {type: 'delta', text: part};
      } else if (block.type === 'tool_use') {
        fields(delta, ['type', 'partial_json']);
        if (delta.type !== 'input_json_delta' || block.initialInput) fail();
        const part = text(delta.partial_json, options.maxArgumentBytes); addBytes(part); block.argumentsJson += part;
        if (Buffer.byteLength(block.argumentsJson) > options.maxArgumentBytes) fail('AGENT_CHAT_LIMIT');
      } else if (block.type === 'thinking' && delta.type === 'thinking_delta') {
        fields(delta, ['type', 'thinking']);
        const part = text(delta.thinking, options.maxOutputBytes); addBytes(part); block.thinking += part;
      } else if (block.type === 'thinking' && delta.type === 'signature_delta') {
        fields(delta, ['type', 'signature']);
        const part = text(delta.signature, options.maxOutputBytes); addBytes(part); block.signature += part;
      } else fail();
      continue;
    }
    if (value.type === 'content_block_stop') {
      fields(value, ['type', 'index']);
      if (stopReason) fail();
      openBlock(value.index).closed = true;
      continue;
    }
    if (value.type === 'message_delta') {
      fields(value, ['type', 'delta', 'usage']);
      if (stopReason || blocks.some(block => !block.closed) || !object(value.delta) || (!optionalUsage && !object(value.usage))) fail();
      fields(value.delta, ['stop_reason', 'stop_sequence', 'container', 'stop_details']);
      if (value.delta.container != null) fail();
      refusalDetails(value.delta.stop_details, value.delta.stop_reason);
      if (optionalUsage) {
        // Counts may be absent or malformed, but usage cannot advertise an
        // unsupported thinking/server-tool capability and bypass its gate.
        if (object(value.usage)) usageCapabilities(value.usage, thinking);
      } else {
        if (!object(value.usage)) fail();
        usageMetadata(value.usage, false, thinking);
        const nextTokens = count(value.usage.output_tokens);
        if (!usage || nextTokens < usage.output) fail();
        usage.output = nextTokens;
        // SDK usage counters are whole-message cumulative totals. Null means the
        // counter is absent in this event; present counters replace, never add.
        for (const [field, key] of [['input_tokens', 'input'], ['cache_creation_input_tokens', 'cacheCreation'], ['cache_read_input_tokens', 'cacheRead']] as const) {
          if (value.usage[field] == null) continue;
          const next = count(value.usage[field]);
          if (next < usage[key]) fail();
          usage[key] = next;
        }
        promptTokens(usage);
      }
      options.onUsage?.(value.usage);
      const reason = value.delta.stop_reason;
      if (reason == null && value.delta.stop_sequence != null) fail();
      if (reason === 'model_context_window_exceeded') throw agentChatStreamError('output_limit');
      if (reason === 'pause_turn') fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
      if (reason != null) {
        if (!['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal'].includes(reason as string)) fail();
        stopReason = reason as AnthropicCompletion['stopReason'];
        if (reason === 'stop_sequence') { if (!text(value.delta.stop_sequence, 256)) fail(); }
        else if (value.delta.stop_sequence != null) fail();
      }
      sawFinalUsage = true;
      continue;
    }
    if (value.type === 'message_stop') {
      fields(value, ['type']);
      if (!stopReason || (!optionalUsage && !sawFinalUsage) || blocks.some(block => !block.closed)) fail();
      stopped = true;
      continue;
    }
    fail();
  }
  if (options.signal?.aborted) fail('AGENT_CHAT_ABORTED');
  if (!stopped || !stopReason || (!optionalUsage && !usage)) throw agentChatStreamError('missing_done');
  if ((stopReason === 'tool_use') !== (toolCount > 0) && !['max_tokens', 'refusal'].includes(stopReason)) fail();
  const toolCalls: AnthropicCompletion['toolCalls'] = [];
  const content: AnthropicContentBlock[] = blocks.map(block => {
    if (block.type === 'text') return {type: 'text', text: block.text};
    if (block.type === 'redacted_thinking') return {type: 'redacted_thinking', data: block.data};
    if (block.type === 'thinking') {
      // Continuation must return the signature that lets the provider verify this block.
      if (!block.signature) { if (stopReason === 'max_tokens') throw agentChatStreamError('output_limit'); fail(); }
      return {type: 'thinking', thinking: block.thinking, signature: block.signature};
    }
    const argumentsJson = block.argumentsJson || '{}';
    let input: Record<string, AgentTaskJson>;
    try { input = parseModelToolArguments(argumentsJson, options.maxArgumentBytes); }
    catch (error) { if (stopReason === 'max_tokens') throw agentChatStreamError('output_limit'); throw error; }
    toolCalls.push({id: block.id, name: block.name, argumentsJson});
    return {type: 'tool_use', id: block.id, name: block.name, input};
  });
  yield {type: 'done', completion: {text: content.filter((block): block is Extract<AnthropicContentBlock, {type: 'text'}> => block.type === 'text').map(block => block.text).join(''),
    content, toolCalls, stopReason, ...(usage ? {usage: {prompt_tokens: promptTokens(usage), completion_tokens: usage.output, total_tokens: promptTokens(usage) + usage.output}} : {})}};
}
