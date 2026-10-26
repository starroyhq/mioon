import {assertAgentGainRequestBudget} from './gain-context-fence.ts';
import {AGENT_CHAT_LIMITS, CHAT_SYSTEM_INSTRUCTION} from './chat-policy.ts';
import {exactObject, parseAgentConfiguration, MAX_AGENT_SECRET_BYTES} from './config.ts';
import type {AgentConfiguration} from './config.ts';
import {agentChatError, errorCode, agentChatHttpStatus, agentChatStreamReason} from './chat-errors.ts';
import {createAnthropicSdkTransport} from './anthropic-sdk-transport.ts';
import {streamAnthropicMessages} from './anthropic-stream.ts';
import {ANTHROPIC_MESSAGES_FIELDS} from './anthropic-protocol.ts';
import {anthropicMessages, anthropicToolContinuation, anthropicReadToolCall} from './anthropic-wire.ts';
import {toolScope, validateReadTools, readToolRequestFields, readToolMessages} from './tool-wire.ts';
import type {ReadToolState, WireMessage} from './tool-wire.ts';
import type {AgentGateway} from './agent-gateway.ts';
import type {AgentTransportDependencies, AgentTransportStream} from './network-policy.ts';
import {wasAgentTransportSubmissionPrevented} from './network-policy.ts';

// All presets use this same explicit text/client-tool Messages subset, with
// thinking disabled. A model name does not grant additional content families.
function fail(code: string): never {throw agentChatError(code);}
export interface AnthropicValidationOptions {selfPort?: number; readTools?: unknown}
export function validateAnthropicMessagesConfiguration(configuration: unknown, {selfPort, readTools}: AnthropicValidationOptions = {}): AgentConfiguration {
  let config: AgentConfiguration;
  try {config = parseAgentConfiguration(configuration, {selfPort});} catch {return fail('AGENT_CHAT_VALIDATION');}
  if (config.protocol !== 'anthropic_messages') fail('AGENT_CHAT_VALIDATION');
  validateReadTools(config, readTools);
  return config;
}
export interface AnthropicRequestOptions {
  configuration: unknown;
  apiKey?: unknown;
  messages: readonly WireMessage[];
  selfPort?: number;
  readTools?: unknown;
}
export function buildAgentAnthropicRequest({configuration, apiKey, messages, selfPort, readTools}: AnthropicRequestOptions): {configuration: AgentConfiguration; body: string} {
  const config = validateAnthropicMessagesConfiguration(configuration, {selfPort, readTools});
  if (config.presetId !== 'ollama' && (typeof apiKey !== 'string' || !apiKey)) fail('AGENT_CHAT_KEY_REQUIRED');
  if (apiKey != null && apiKey !== '' && (typeof apiKey !== 'string' || Buffer.byteLength(apiKey) > MAX_AGENT_SECRET_BYTES || !/^[\x21-\x7e]+$/.test(apiKey))) fail('AGENT_CHAT_VALIDATION');
  return buildAgentAnthropicBody({configuration: config, messages, selfPort, readTools});
}
/** Compile the exact key-free intent before credentials or network dispatch. */
export function buildAgentAnthropicBody({configuration, messages, selfPort, readTools}: Omit<AnthropicRequestOptions, 'apiKey'>): {configuration: AgentConfiguration; body: string} {
  const config = validateAnthropicMessagesConfiguration(configuration, {selfPort, readTools});
  if (!Array.isArray(messages) || !messages.length || messages.length > AGENT_CHAT_LIMITS.maxMessages) fail('AGENT_CHAT_VALIDATION');
  if (readTools) messages = readToolMessages(messages, readTools);
  else if (messages[0]?.role !== 'system') messages = [{role: 'system', content: CHAT_SYSTEM_INSTRUCTION}, ...messages];
  const state = readTools as ReadToolState | undefined;
  let inputBytes = 0;
  const safeMessages = messages.map((message, position) => {
    if (!exactObject(message, ['role', 'content']) || !['system', 'user', 'assistant'].includes(message.role as string) ||
      typeof message.content !== 'string' || Buffer.from(message.content).toString('utf8') !== message.content) fail('AGENT_CHAT_VALIDATION');
    if (message.role === 'system' && (position || message.content !== (readTools ? toolScope(state).instruction : CHAT_SYSTEM_INSTRUCTION))) fail('AGENT_CHAT_VALIDATION');
    inputBytes += Buffer.byteLength(message.content);
    if (inputBytes > (state ? toolScope(state).limits.maxContextBytes : AGENT_CHAT_LIMITS.maxInputBytes)) fail('AGENT_CHAT_LIMIT');
    return {role: message.role, content: message.content};
  });
  const history: WireMessage[] = [...safeMessages, ...(state?.phase === 'answer' ? anthropicToolContinuation(state) : [])];
  const converted = anthropicMessages(history);
  if (state?.phase === 'answer' && Buffer.byteLength(JSON.stringify(converted)) > (toolScope(state).limits.maxContinuationBytes ?? AGENT_CHAT_LIMITS.maxInputBytes)) fail('AGENT_CHAT_LIMIT');
  const body = JSON.stringify({model: config.model, ...converted, stream: true, max_tokens: AGENT_CHAT_LIMITS.maxOutputTokens,
    ...ANTHROPIC_MESSAGES_FIELDS, ...readToolRequestFields(config, state)});
  if (Buffer.byteLength(body) > AGENT_CHAT_LIMITS.maxRequestBytes) fail('AGENT_CHAT_LIMIT');
  assertAgentGainRequestBudget(body, state);
  return {configuration: config, body};
}

export function createAnthropicMessagesGateway(dependencies: AgentTransportDependencies = {}): AgentGateway {
  const open = createAnthropicSdkTransport(dependencies);
  return async function* streamAnthropic({configuration, apiKey, messages, signal, selfPort, readTools, beforeSubmit}) {
    if (signal?.aborted) fail('AGENT_CHAT_ABORTED');
    const request = buildAgentAnthropicRequest({configuration, apiKey, messages, selfPort, readTools});
    const state = readTools as ReadToolState | undefined, allowTools = state?.phase === 'request';
    let stream: AgentTransportStream | undefined;
    try {
      stream = await open({...request, apiKey: apiKey as string | null | undefined, signal, selfPort, beforeSubmit});
      for await (const item of streamAnthropicMessages(stream.body, {signal, maxOutputBytes: AGENT_CHAT_LIMITS.maxOutputBytes,
        maxArgumentBytes: toolScope(state).limits.maxArgumentsBytes, maxToolCalls: allowTools ? 1 : 0})) {
        if (item.type === 'delta') {yield item; continue;}
        if (stream.error()) throw stream.error();
        if (signal?.aborted) fail('AGENT_CHAT_ABORTED');
        const completion = item.completion;
        if ((completion.usage?.completion_tokens ?? 0) > AGENT_CHAT_LIMITS.maxOutputTokens) fail('AGENT_CHAT_LIMIT');
        stream.close();
        const finishReason = completion.stopReason === 'tool_use' ? 'tool_calls' : completion.stopReason === 'max_tokens' ? 'length' : completion.stopReason === 'refusal' ? 'content_filter' : 'stop';
        const toolCall = completion.toolCalls.length ? anthropicReadToolCall(completion.content, completion.toolCalls[0]!.argumentsJson, state) : undefined;
        if (toolCall && (finishReason !== 'tool_calls' || !allowTools)) fail('AGENT_CHAT_PROTOCOL_ERROR');
        yield {type: 'done', finishReason, ...(completion.usage ? {usage: completion.usage} : {}),
          ...(toolCall ? {toolCall, providerOutput: {role: 'assistant', content: completion.content}} : {})};
      }
    } catch (error) {
      if (signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
      const failure = stream?.error();
      if (failure) throw failure;
      if (agentChatHttpStatus(error) !== undefined || agentChatStreamReason(error) !== undefined || wasAgentTransportSubmissionPrevented(error)) throw error;
      throw agentChatError(stream?.error()?.code || errorCode(error) || 'AGENT_CHAT_CONNECT_FAILED');
    } finally {stream?.close();}
  };
}
export const streamAnthropicMessagesResponse = createAnthropicMessagesGateway();
