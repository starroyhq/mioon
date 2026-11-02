import {isDeepStrictEqual} from 'node:util';
import {parseAgentConfiguration} from './config.ts';
import type {AgentConfiguration} from './config.ts';
import {agentChatError} from './chat-errors.ts';
import {ANTHROPIC_MESSAGES_FIELDS, ANTHROPIC_MIN_THINKING_BUDGET_TOKENS, anthropicThinkingFields} from './anthropic-protocol.ts';
import type {AgentProtocol} from '../../../contracts/src/agent-protocol.ts';

function freeze<T extends object>(value: T): Readonly<T> { for (const child of Object.values(value as Record<string, unknown>)) if (child && typeof child === 'object') freeze(child as object); return Object.freeze(value); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code: string): never { throw agentChatError(code); }

/** What a model can do with thinking. An unsupported (or unverified) model
 * never thinks. An optional model documents an off switch: an optional
 * profile's fields are exactly that switch, and task requests send it. A
 * required model always thinks, so its profile carries no off switch. */
export type AgentThinkingTier = 'unsupported' | 'optional' | 'required';
/** Chat Completions and Responses always send this limit, including thinking
 * requests. Messages also uses it when the model's maximum is unknown. */
export const AGENT_DEFAULT_OUTPUT_TOKENS = 4096;
/** Messages caps its documented maximum here. All protocols still share the
 * 1 MiB / 8192-event SSE limits and 120-second deadline, so this does not
 * guarantee that a reply reaches the token limit. Raising Chat Completions or
 * Responses also requires reviewing those limits and rate-limit reservations. */
export const AGENT_OUTPUT_TOKEN_CEILING = 16384;
/** Target answer reserve for required-thinking Messages requests. The minimum
 * thinking budget can leave less when the whole output limit is only 4096. */
export const AGENT_THINKING_ANSWER_TOKENS = 4096;
/** contextTokens is the documented context window (input plus output), or null
 * when it is unknown or set by the user's server. outputTokens is the output
 * limit a task request sends: 4096 for Chat Completions and Responses;
 * min(documented maximum output, 16384) for a listed Messages model, otherwise
 * 4096. Checked 2026-11-02; sources and per-model table: AGENT-PROVIDERS.md. */
export interface AgentModelTokenLimits {contextTokens: number | null; outputTokens: number}
/** Keep documented capability separate from the output limit sent today. */
interface AgentModelTokenProfile extends AgentModelTokenLimits {maxOutputTokens: number | null}
// These are explicit text-only profiles, not a vendor-wide compatibility claim.
// Model aliases/edits remain saveable settings, but unsupported named profiles
// fail before inference. Sources and region/account caveats: AGENT-PROVIDERS.md.
// No catalog model requires thinking: each optional profile's model documents
// the disable switch it sends, and gpt-4.1-mini does not reason.
// Documented maximum output: gpt-4.1-mini 32,768; deepseek-flash 393,216;
// glm-4.7 128,000. Kimi and MiniMax list no separate maximum; input plus output
// must fit the window. qwen-plus has no maximum on its official page.
interface AgentChatProfile extends AgentModelTokenProfile {models: string[] | null; tokenField: 'max_tokens' | 'max_completion_tokens'; fields: Record<string, unknown>; thinkingTier: AgentThinkingTier}
const profiles: Record<string, AgentChatProfile> = {
  openai: Object.freeze({models: ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'], tokenField: 'max_completion_tokens', fields: {store: false}, thinkingTier: 'unsupported', contextTokens: 1047576, maxOutputTokens: 32768, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS}),
  deepseek: Object.freeze({models: ['deepseek-flash'], tokenField: 'max_tokens', fields: {thinking: {type: 'disabled'}}, thinkingTier: 'optional', contextTokens: 1000000, maxOutputTokens: 393216, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS}),
  qwen: Object.freeze({models: ['qwen-plus'], tokenField: 'max_tokens', fields: {enable_thinking: false}, thinkingTier: 'optional', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS}),
  zhipu: Object.freeze({models: ['glm-4.7'], tokenField: 'max_tokens', fields: {thinking: {type: 'disabled'}}, thinkingTier: 'optional', contextTokens: 200000, maxOutputTokens: 128000, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS}),
  kimi: Object.freeze({models: ['kimi-k2.6'], tokenField: 'max_tokens', fields: {thinking: {type: 'disabled'}}, thinkingTier: 'optional', contextTokens: 262144, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS}),
  minimax: Object.freeze({models: ['MiniMax-M3'], tokenField: 'max_completion_tokens', fields: {thinking: {type: 'disabled'}}, thinkingTier: 'optional', contextTokens: 1000000, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS}),
  // OpenRouter routes this model to OpenAI; its limits follow the OpenAI model page.
  openrouter: Object.freeze({models: ['openai/gpt-4.1-mini'], tokenField: 'max_tokens', fields: {provider: {require_parameters: true, allow_fallbacks: false}}, thinkingTier: 'unsupported', contextTokens: 1047576, maxOutputTokens: 32768, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS}),
  custom: Object.freeze({models: null, tokenField: 'max_tokens', fields: {}, thinkingTier: 'unsupported', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS}),
  // Official compatibility docs, checked 2026-10-09: reasoning_effort:'none'
  // requests false for boolean-thinking models. No model pull/probe/cloud route.
  // The local server sets the context window (default 4096), which the
  // compatible API can neither set per request nor report.
  ollama: Object.freeze({models: ['qwen3:8b'], tokenField: 'max_tokens', fields: {reasoning_effort: 'none'}, thinkingTier: 'optional', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS}),
};
export const AGENT_CHAT_PROFILES: Readonly<Record<string, AgentChatProfile>> = freeze(profiles);
/** Select request fields before dispatch. A preset without a dedicated profile
 * uses this protocol's generic template; errors never trigger another attempt. */
export function agentChatProfile(configuration: AgentConfiguration): AgentChatProfile {
  if (configuration.protocol !== 'chat_completions') throw agentChatError('AGENT_CHAT_VALIDATION');
  return Object.hasOwn(AGENT_CHAT_PROFILES, configuration.presetId) ? AGENT_CHAT_PROFILES[configuration.presetId] : AGENT_CHAT_PROFILES.custom;
}
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

// Documentation-backed, deliberately text-only profiles, not live certification.
// Token limits follow the Chat Completions profile of the same model;
// qwen3.8-flash documents a 1,000,000-token window but no maximum output.
interface AgentResponsesProfile extends AgentModelTokenProfile {models: string[] | null; fields: Record<string, unknown>; thinkingTier: AgentThinkingTier}
const responseProfiles: Record<string, AgentResponsesProfile> = {
  openai: {models: ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'], fields: {truncation: 'disabled'}, thinkingTier: 'unsupported', contextTokens: 1047576, maxOutputTokens: 32768, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
  custom: {models: null, fields: {truncation: 'disabled'}, thinkingTier: 'unsupported', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
  ollama: {models: ['qwen3:8b'], fields: {reasoning: {effort: 'none'}}, thinkingTier: 'optional', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
  deepseek: {models: ['deepseek-flash'], fields: {reasoning: {effort: 'none'}}, thinkingTier: 'optional', contextTokens: 1000000, maxOutputTokens: 393216, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
  qwen: {models: ['qwen3.8-flash'], fields: {reasoning: {effort: 'none'}}, thinkingTier: 'optional', contextTokens: 1000000, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
};
export const AGENT_RESPONSES_PROFILES: Readonly<Record<string, AgentResponsesProfile>> = freeze(responseProfiles);
/** Unlisted vendor/protocol combinations use the explicitly selected protocol's
 * generic template from the first request, with no error-driven switching. */
export function agentResponsesProfile(configuration: AgentConfiguration): AgentResponsesProfile {
  if (configuration.protocol !== 'responses') throw agentChatError('AGENT_CHAT_VALIDATION');
  return Object.hasOwn(AGENT_RESPONSES_PROFILES, configuration.presetId) ? AGENT_RESPONSES_PROFILES[configuration.presetId] : AGENT_RESPONSES_PROFILES.custom;
}
/** Messages has its own `thinking` request parameter, which every task request
 * sends disabled, so each Messages preset is optional. The other protocols take
 * the tier from their profile. */
export function agentModelThinkingTier(configuration: AgentConfiguration): AgentThinkingTier {
  if (configuration.protocol === 'chat_completions') return agentChatProfile(configuration).thinkingTier;
  if (configuration.protocol === 'responses') return agentResponsesProfile(configuration).thinkingTier;
  if (configuration.protocol === 'anthropic_messages') return 'optional';
  return fail('AGENT_CHAT_VALIDATION');
}
// Messages has no request profile, so its documented limits list exact model
// names: claude-haiku-4-5 has a 200,000-token window and 64,000 maximum output.
const messagesTokenLimits: Record<string, AgentModelTokenProfile & {models: string[]}> = {
  anthropic: {models: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], contextTokens: 200000, maxOutputTokens: 64000, outputTokens: Math.min(64000, AGENT_OUTPUT_TOKEN_CEILING)},
};
export const AGENT_MESSAGES_TOKEN_LIMITS: Readonly<Record<string, Readonly<AgentModelTokenProfile & {models: string[]}>>> = freeze(messagesTokenLimits);
const tokenLimits = ({contextTokens, outputTokens}: AgentModelTokenLimits): AgentModelTokenLimits => ({contextTokens, outputTokens});
/** Chat Completions and Responses read the protocol's profile. Any combination
 * without verified limits has an unknown window and the default output limit. */
export function agentModelTokenLimits(configuration: AgentConfiguration): AgentModelTokenLimits {
  if (configuration.protocol === 'chat_completions') return tokenLimits(agentChatProfile(configuration));
  if (configuration.protocol === 'responses') return tokenLimits(agentResponsesProfile(configuration));
  if (configuration.protocol !== 'anthropic_messages') return fail('AGENT_CHAT_VALIDATION');
  const listed = Object.hasOwn(AGENT_MESSAGES_TOKEN_LIMITS, configuration.presetId) ? AGENT_MESSAGES_TOKEN_LIMITS[configuration.presetId] : undefined;
  return listed?.models.includes(configuration.model) ? tokenLimits(listed) : {contextTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS};
}
/** Messages thinking control: only a model that cannot disable thinking turns it
 * on. max_tokens counts thinking, so the manual budget leaves the answer at
 * AGENT_THINKING_ANSWER_TOKENS when the output limit permits it, while thinking
 * never goes below the documented minimum. Chat Completions and Responses send
 * their profile fields instead. */
export function agentAnthropicThinkingFields(tier: AgentThinkingTier, outputTokens: number): typeof ANTHROPIC_MESSAGES_FIELDS | ReturnType<typeof anthropicThinkingFields> {
  if (tier !== 'required') return ANTHROPIC_MESSAGES_FIELDS;
  const budget = Math.max(ANTHROPIC_MIN_THINKING_BUDGET_TOKENS, outputTokens - AGENT_THINKING_ANSWER_TOKENS);
  if (budget >= outputTokens) fail('AGENT_CHAT_PROFILE_UNSUPPORTED');
  return anthropicThinkingFields(budget);
}
/** Thinking output is admitted only when this exact request asked for it, so a
 * journaled body keeps its meaning on recovery: always for a required model,
 * never for an unsupported one, and for an optional one only when the request
 * lacks the documented off switch. */
export function agentRequestThinks(configuration: AgentConfiguration, body: Record<string, unknown>): boolean {
  const tier = agentModelThinkingTier(configuration);
  if (tier !== 'optional') return tier === 'required';
  const off = configuration.protocol === 'chat_completions' ? agentChatProfile(configuration).fields
    : configuration.protocol === 'responses' ? agentResponsesProfile(configuration).fields : ANTHROPIC_MESSAGES_FIELDS;
  return !Object.entries(off).every(([key, value]) => isDeepStrictEqual(body[key], value));
}
function qwenEndpoint(config: AgentConfiguration): boolean {
  const fixed: Record<string, string> = {beijing: 'https://dashscope.aliyuncs.com/compatible-mode/v1', singapore: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'};
  if (Object.hasOwn(fixed, config.platformId)) return config.baseUrl === fixed[config.platformId];
  if (!config.platformId.startsWith('workspace-')) return false;
  const region = config.platformId.slice('workspace-'.length), url = new URL(config.baseUrl);
  return url.protocol === 'https:' && !url.port && url.pathname === '/compatible-mode/v1' &&
    new RegExp(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.${region}\\.maas\\.aliyuncs\\.com$`).test(url.hostname);
}

export interface ToolProfile {parallel: boolean; choice: boolean; strict: boolean}
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

export interface AgentProfileValidationOptions {selfPort?: number}
export function validateAgentChatProfile(configuration: unknown, {selfPort}: AgentProfileValidationOptions = {}): AgentConfiguration {
  let config: AgentConfiguration;
  try { config = parseAgentConfiguration(configuration, {selfPort}); } catch { return fail('AGENT_CHAT_VALIDATION'); }
  if (config.protocol !== 'chat_completions') fail('AGENT_CHAT_VALIDATION');
  const profile = agentChatProfile(config);
  if (!profile || (profile.models && !profile.models.includes(config.model))) fail('AGENT_CHAT_PROFILE_UNSUPPORTED');
  return config;
}
export function validateAgentResponsesProfile(configuration: unknown, {selfPort}: AgentProfileValidationOptions = {}): AgentConfiguration {
  let config: AgentConfiguration;
  try { config = parseAgentConfiguration(configuration, {selfPort}); } catch { return fail('AGENT_CHAT_VALIDATION'); }
  if (config.protocol !== 'responses') fail('AGENT_CHAT_VALIDATION');
  const profile = agentResponsesProfile(config);
  if (!profile || (profile.models && !profile.models.includes(config.model)) ||
    (config.presetId === 'deepseek' && config.baseUrl !== 'https://api.deepseek.com') ||
    (config.presetId === 'qwen' && !qwenEndpoint(config))) fail('AGENT_CHAT_PROFILE_UNSUPPORTED');
  return config;
}
// All presets use this same explicit text/client-tool Messages subset, with
// thinking disabled. A model name does not grant additional content families.
export function validateAnthropicMessagesProfile(configuration: unknown, {selfPort}: AgentProfileValidationOptions = {}): AgentConfiguration {
  let config: AgentConfiguration;
  try {config = parseAgentConfiguration(configuration, {selfPort});} catch {return fail('AGENT_CHAT_VALIDATION');}
  if (config.protocol !== 'anthropic_messages') fail('AGENT_CHAT_VALIDATION');
  return config;
}
/** Pure preflight, called before acquiring a credential or opening a socket. */
export function validateAgentGatewayConfiguration(configuration: unknown, options: AgentProfileValidationOptions = {}): AgentConfiguration {
  const protocol = (configuration as {protocol?: unknown} | null | undefined)?.protocol;
  if (protocol === 'chat_completions') return validateAgentChatProfile(configuration, options);
  if (protocol === 'responses') return validateAgentResponsesProfile(configuration, options);
  if (protocol === 'anthropic_messages') return validateAnthropicMessagesProfile(configuration, options);
  throw agentChatError('AGENT_CHAT_VALIDATION');
}
