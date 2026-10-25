import {assertAgentGainRequestBudget} from './gain-context-fence.ts';
import {AGENT_CHAT_LIMITS} from './chat-policy.ts';
export {CHAT_SYSTEM_INSTRUCTION, AGENT_CHAT_LIMITS} from './chat-policy.ts';
import {exactObject, parseAgentConfiguration, MAX_AGENT_SECRET_BYTES} from './config.ts';
import type {AgentConfiguration} from './config.ts';
import {agentChatError, errorCode} from './chat-errors.ts';
import {createOpenAiSdkTransport} from './openai-sdk-transport.ts';
import type {AgentTransportDependencies, AgentTransportStream} from './network-policy.ts';
import {parseAgentSse, AGENT_SSE_LIMITS} from './sse.ts';
import {toolScope, validateReadTools, readToolRequestFields, readToolMessages, chatToolAccumulator, chatToolContinuation} from './tool-wire.ts';
import type {WireMessage, ToolCall, ReadToolState} from './tool-wire.ts';
import type {AgentGateway, AgentUsage} from './agent-gateway.ts';

// These are explicit text-only profiles, not a vendor-wide compatibility claim.
// Model aliases/edits remain saveable settings, but unsupported named profiles
// fail before inference. Sources and region/account caveats: AGENT-PROVIDERS.md.
interface AgentChatProfile {models: string[] | null; tokenField: 'max_tokens' | 'max_completion_tokens'; fields: Record<string, unknown>}
function freeze<T extends object>(value: T): Readonly<T> { for (const child of Object.values(value as Record<string, unknown>)) if (child && typeof child === 'object') freeze(child as object); return Object.freeze(value); }
const profiles: Record<string, AgentChatProfile> = {
  openai: Object.freeze({models: ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'], tokenField: 'max_completion_tokens', fields: {store: false}}),
  deepseek: Object.freeze({models: ['deepseek-flash'], tokenField: 'max_tokens', fields: {thinking: {type: 'disabled'}}}),
  qwen: Object.freeze({models: ['qwen-plus'], tokenField: 'max_tokens', fields: {enable_thinking: false}}),
  zhipu: Object.freeze({models: ['glm-4.7'], tokenField: 'max_tokens', fields: {thinking: {type: 'disabled'}}}),
  kimi: Object.freeze({models: ['kimi-k2.6'], tokenField: 'max_tokens', fields: {thinking: {type: 'disabled'}}}),
  minimax: Object.freeze({models: ['MiniMax-M3'], tokenField: 'max_completion_tokens', fields: {thinking: {type: 'disabled'}}}),
  openrouter: Object.freeze({models: ['openai/gpt-4.1-mini'], tokenField: 'max_tokens', fields: {provider: {require_parameters: true, allow_fallbacks: false}}}),
  custom: Object.freeze({models: null, tokenField: 'max_tokens', fields: {}}),
  // Official compatibility docs, checked 2026-10-09: reasoning_effort:'none'
  // requests false for boolean-thinking models. No model pull/probe/cloud route.
  ollama: Object.freeze({models: ['qwen3:8b'], tokenField: 'max_tokens', fields: {reasoning_effort: 'none'}}),
};
export const AGENT_CHAT_PROFILES: Readonly<Record<string, AgentChatProfile>> = freeze(profiles);
/** MiniMax recommends the OpenAI SDK, whose SSE iterator accepts natural EOF.
 * Restrict that terminal contract to this exact official non-thinking profile;
 * an edited/custom endpoint or a journaled request for another model cannot opt in. */
export function agentChatAllowsNaturalEof(configuration: AgentConfiguration, body: Record<string, unknown>): boolean {
  return configuration.protocol === 'chat_completions' && configuration.presetId === 'minimax' &&
    configuration.model === 'MiniMax-M3' && body.model === configuration.model && body.stream === true &&
    object(body.thinking) && Object.keys(body.thinking).length === 1 && body.thinking.type === 'disabled' &&
    ((configuration.platformId === 'china' && configuration.baseUrl === 'https://api.minimax.cn/v1') ||
      (configuration.platformId === 'international' && configuration.baseUrl === 'https://api.minimax.io/v1'));
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const wellFormed = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value;
function fail(code: string): never { throw agentChatError(code); }
function unsupported(value: unknown): boolean { return value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0); }
function rejectActiveFeatures(value: unknown, {allowToolCalls = false}: {allowToolCalls?: boolean} = {}): void {
  if (!object(value)) return;
  if (unsupported(value.function_call) || (!allowToolCalls && unsupported(value.tool_calls))) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
  if (['reasoning', 'reasoning_content', 'reasoning_details', 'thinking', 'signature', 'continuation', 'previous_response_id'].some(key => unsupported(value[key]))) fail('AGENT_CHAT_REASONING_UNSUPPORTED');
}
export function safeUsage(value: unknown): AgentUsage | undefined {
  if (value === null || value === undefined) return undefined;
  if (!object(value)) fail('AGENT_CHAT_PROTOCOL_ERROR');
  const result: Record<string, number> = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (value[key] === undefined) continue;
    const count = value[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 10_000_000) fail('AGENT_CHAT_PROTOCOL_ERROR');
    result[key] = count as number;
  }
  if (result.completion_tokens > AGENT_CHAT_LIMITS.maxOutputTokens) fail('AGENT_CHAT_LIMIT');
  if (Object.hasOwn(result, 'total_tokens') && ((result.prompt_tokens || 0) > result.total_tokens || (result.completion_tokens || 0) > result.total_tokens)) fail('AGENT_CHAT_PROTOCOL_ERROR');
  return Object.keys(result).length ? result : undefined;
}
export interface AgentChatValidationOptions {selfPort?: number; readTools?: unknown}
export function validateAgentChatConfiguration(configuration: unknown, {selfPort, readTools}: AgentChatValidationOptions = {}): AgentConfiguration {
  let config: AgentConfiguration;
  try { config = parseAgentConfiguration(configuration, {selfPort}); } catch { return fail('AGENT_CHAT_VALIDATION'); }
  if (config.protocol !== 'chat_completions') fail('AGENT_CHAT_VALIDATION');
  const profile = AGENT_CHAT_PROFILES[config.presetId];
  if (!profile || (profile.models && !profile.models.includes(config.model))) fail('AGENT_CHAT_PROFILE_UNSUPPORTED');
  validateReadTools(config, readTools);
  return config;
}
export interface AgentChatRequestOptions {
  configuration: unknown;
  apiKey?: unknown;
  messages: readonly WireMessage[];
  selfPort?: number;
  readTools?: unknown;
}
export function buildAgentChatRequest({configuration, apiKey, messages, selfPort, readTools}: AgentChatRequestOptions): {configuration: AgentConfiguration; body: string} {
  const config = validateAgentChatConfiguration(configuration, {selfPort, readTools});
  if (config.presetId !== 'ollama' && (typeof apiKey !== 'string' || !apiKey)) fail('AGENT_CHAT_KEY_REQUIRED');
  if (apiKey != null && apiKey !== '' && (typeof apiKey !== 'string' || Buffer.byteLength(apiKey) > MAX_AGENT_SECRET_BYTES || !/^[\x21-\x7e]+$/.test(apiKey))) fail('AGENT_CHAT_VALIDATION');
  return buildAgentChatBody({configuration: config, messages, selfPort, readTools});
}
/** Pure key-free request compilation for acceptance/journaling. */
export function buildAgentChatBody({configuration, messages, selfPort, readTools}: {configuration: unknown; messages: readonly WireMessage[]; selfPort?: number; readTools?: unknown}): {configuration: AgentConfiguration; body: string} {
  const config = validateAgentChatConfiguration(configuration, {selfPort, readTools});
  const profile = AGENT_CHAT_PROFILES[config.presetId];
  if (!Array.isArray(messages) || !messages.length || messages.length > AGENT_CHAT_LIMITS.maxMessages) fail('AGENT_CHAT_VALIDATION');
  if (readTools) messages = readToolMessages(messages, readTools);
  const readState = readTools as ReadToolState | undefined;
  let inputBytes = 0;
  const safeMessages: unknown[] = messages.map(message => {
    if (!exactObject(message, ['role', 'content']) || typeof message.role !== 'string' || !['system', 'user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string' || !wellFormed(message.content)) fail('AGENT_CHAT_VALIDATION');
    inputBytes += Buffer.byteLength(message.content);
    if (inputBytes > (readState ? toolScope(readState).limits.maxContextBytes : AGENT_CHAT_LIMITS.maxInputBytes)) fail('AGENT_CHAT_LIMIT');
    return {role: message.role, content: message.content};
  });
  if (readState?.phase === 'answer') {
    safeMessages.push(...chatToolContinuation(readState));
    if (Buffer.byteLength(JSON.stringify(safeMessages)) > AGENT_CHAT_LIMITS.maxInputBytes) fail('AGENT_CHAT_LIMIT');
  }
  const body = JSON.stringify({model: config.model, messages: safeMessages, stream: true, [profile.tokenField]: AGENT_CHAT_LIMITS.maxOutputTokens, ...profile.fields, ...readToolRequestFields(config, readState)});
  if (Buffer.byteLength(body) > AGENT_CHAT_LIMITS.maxRequestBytes) fail('AGENT_CHAT_LIMIT');
  assertAgentGainRequestBudget(body, readState);
  return {configuration: config, body};
}

/** Exactly one POST, with no tool execution, follow-on rounds, retry, protocol
 * fallback or model substitution. A done event requires finish and a clean framed
 * end; [DONE] is additionally required outside the exact MiniMax EOF profile. */
export function createChatCompletionGateway(dependencies: AgentTransportDependencies = {}): AgentGateway {
  const open = createOpenAiSdkTransport(dependencies);
  return async function* streamChatCompletion({configuration, apiKey, messages, signal, selfPort, readTools, beforeSubmit}) {
    if (signal?.aborted) fail('AGENT_CHAT_ABORTED');
    const request = buildAgentChatRequest({configuration, apiKey, messages, selfPort, readTools});
    let stream: AgentTransportStream | undefined;
    try {
      stream = await open({...request, apiKey: apiKey as string | null | undefined, signal, selfPort, beforeSubmit});
      let finishReason: string | null = null, done = false, outputBytes = 0, usage: AgentUsage | undefined, content = '', refusal = '';
      const tools = chatToolAccumulator(readTools), allowToolCalls = (readTools as ReadToolState | undefined)?.phase === 'request';
      for await (const frame of parseAgentSse(stream.body, {...AGENT_SSE_LIMITS, signal})) {
        if (signal?.aborted) fail('AGENT_CHAT_ABORTED');
        if (frame.event === 'error') fail('AGENT_CHAT_PROVIDER_ERROR');
        if (frame.event !== 'message') fail('AGENT_CHAT_PROTOCOL_ERROR');
        if (frame.data === '[DONE]') {
          if (done && tools.present) fail('AGENT_CHAT_PROTOCOL_ERROR');
          if (!finishReason) fail('AGENT_CHAT_TRUNCATED');
          done = true;
          continue;
        }
        if (done) fail('AGENT_CHAT_PROTOCOL_ERROR');
        let value: unknown;
        try { value = JSON.parse(frame.data); } catch { fail('AGENT_CHAT_PROTOCOL_ERROR'); }
        if (!object(value)) fail('AGENT_CHAT_PROTOCOL_ERROR');
        if (value.error != null) fail('AGENT_CHAT_PROVIDER_ERROR');
        rejectActiveFeatures(value);
        const choices = value.choices;
        if (!Array.isArray(choices) || choices.length > 1) fail('AGENT_CHAT_PROTOCOL_ERROR');
        const nextUsage = safeUsage(value.usage);
        if (nextUsage) {
          if (usage && JSON.stringify(usage) !== JSON.stringify(nextUsage)) fail('AGENT_CHAT_PROTOCOL_ERROR');
          usage = nextUsage;
        }
        if (!choices.length) continue; // Optional usage-only/empty chunks.
        const choice = choices[0];
        if (!object(choice) || choice.index !== 0 || !object(choice.delta)) fail('AGENT_CHAT_PROTOCOL_ERROR');
        rejectActiveFeatures(choice); rejectActiveFeatures(choice.delta, {allowToolCalls});
        const {delta, finish_reason: reason} = choice;
        const knownDelta = ['role', 'content', 'refusal', 'tool_calls', 'function_call', 'reasoning', 'reasoning_content', 'reasoning_details', 'thinking', 'signature'];
        if (Object.keys(delta).some(key => !knownDelta.includes(key))) fail('AGENT_CHAT_PROTOCOL_ERROR');
        if (delta.role != null && delta.role !== 'assistant') fail('AGENT_CHAT_PROTOCOL_ERROR');
        for (const field of ['content', 'refusal']) {
          const fieldValue = delta[field];
          if (fieldValue != null && (typeof fieldValue !== 'string' || !wellFormed(fieldValue))) fail('AGENT_CHAT_PROTOCOL_ERROR');
        }
        if (unsupported(delta.tool_calls)) {
          if (finishReason) fail('AGENT_CHAT_PROTOCOL_ERROR');
          tools.add(delta.tool_calls);
        }
        const text = (typeof delta.content === 'string' ? delta.content : '') + (typeof delta.refusal === 'string' ? delta.refusal : '');
        if (text) {
          if (finishReason) fail('AGENT_CHAT_PROTOCOL_ERROR');
          outputBytes += Buffer.byteLength(text);
          if (outputBytes > AGENT_CHAT_LIMITS.maxOutputBytes) fail('AGENT_CHAT_LIMIT');
        }
        if (reason != null) {
          if (reason === 'function_call' || (reason === 'tool_calls' && !allowToolCalls)) fail('AGENT_CHAT_TOOLS_UNSUPPORTED');
          if (!['stop', 'length', 'content_filter', ...(allowToolCalls ? ['tool_calls'] : [])].includes(reason as string) || (finishReason && (reason !== finishReason || tools.present))) fail('AGENT_CHAT_PROTOCOL_ERROR');
          if ((tools.present && reason !== 'tool_calls') || (!tools.present && reason === 'tool_calls')) fail('AGENT_CHAT_PROTOCOL_ERROR');
          finishReason = reason as string;
        }
        if (allowToolCalls) { content += typeof delta.content === 'string' ? delta.content : ''; refusal += typeof delta.refusal === 'string' ? delta.refusal : ''; }
        if (text) yield {type: 'delta', text};
      }
      if (stream.error()) throw stream.error();
      if (signal?.aborted) fail('AGENT_CHAT_ABORTED');
      const naturalEof = agentChatAllowsNaturalEof(request.configuration, JSON.parse(request.body) as Record<string, unknown>) && (finishReason === 'stop' || finishReason === 'tool_calls');
      if ((!done && !naturalEof) || !finishReason) fail('AGENT_CHAT_TRUNCATED');
      stream.close(); // Release sockets/timers before handing off the terminal event.
      if (tools.present && refusal) fail('AGENT_CHAT_PROTOCOL_ERROR');
      const toolCall: ToolCall | null = tools.present ? tools.finish() : null;
      const providerOutput = toolCall ? {role: 'assistant', content: content || null, tool_calls: [{id: toolCall.id, type: 'function', function: {name: toolCall.name, arguments: toolCall.argumentsJson}}]} : null;
      yield {type: 'done', finishReason: finishReason as 'stop' | 'tool_calls' | 'length' | 'content_filter', ...(usage ? {usage} : {}), ...(toolCall ? {toolCall, providerOutput} : {})};
    } catch (error) {
      if (signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
      throw agentChatError(stream?.error()?.code || errorCode(error) || 'AGENT_CHAT_CONNECT_FAILED');
    } finally {
      stream?.close();
    }
  };
}
export const streamChatCompletion = createChatCompletionGateway();
