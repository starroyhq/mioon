import {isDeepStrictEqual} from 'node:util';
import {parseAgentConfiguration} from './config.ts';
import type {AgentConfiguration} from './config.ts';
import {AGENT_PRESETS} from './presets.ts';
import {agentPresetPlatform} from '../../../contracts/src/agent-provider-catalog.ts';
import {agentChatError} from './chat-errors.ts';
import {ANTHROPIC_MESSAGES_FIELDS, ANTHROPIC_MIN_THINKING_BUDGET_TOKENS, anthropicThinkingFields, agentSonnetThinkingFields, agentSonnetConfiguration} from './anthropic-protocol.ts';
import type {AgentProtocol} from '../../../contracts/src/agent-protocol.ts';
import {agentOpenAiReasoningFamily,agentOpenAiModelIsAdapted,AGENT_OPENAI_REASONING_MODEL_HINTS,AGENT_OPENROUTER_REASONING_MODEL_HINTS} from '../../../contracts/src/agent-openai-model-family.ts';

function freeze<T extends object>(value: T): Readonly<T> { for (const child of Object.values(value as Record<string, unknown>)) if (child && typeof child === 'object') freeze(child as object); return Object.freeze(value); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code: string): never { throw agentChatError(code); }

/** What a model can do with thinking. An unsupported model never thinks. An unverified official Responses
 * model admits reasoning without guessing request parameters. An optional model documents an off switch: an optional
 * profile's fields are exactly that switch, and task requests send it. A
 * required (or not yet documented) reasoning family has no proven off switch,
 * so its output may contain reasoning even at the selected minimum. */
export type AgentThinkingTier = 'unsupported' | 'optional' | 'required';
/** Conservative default for generic models and legacy named profiles. */
export const AGENT_DEFAULT_OUTPUT_TOKENS = 4096;
/** OpenAI reasoning output includes internal reasoning and the visible answer.
 * Keep a bounded reserve below each documented maximum (or an unverified
 * family's unknown maximum); stream/deadline caps remain independently active. */
export const AGENT_OPENAI_REASONING_OUTPUT_TOKENS = 32768;
/** Messages caps its documented maximum here. The 120-second deadline and
 * independent protocol stream limits can end a response sooner. OpenAI
 * Responses reserves separate framing space for metadata and reasoning; this
 * does not increase the limits of other protocols or providers. */
export const AGENT_OUTPUT_TOKEN_CEILING = 16384;
/** Target answer reserve for required-thinking Messages requests. The minimum
 * thinking budget can leave less when the whole output limit is only 4096. */
export const AGENT_THINKING_ANSWER_TOKENS = 4096;
/** contextTokens is the documented context window (input plus output), or null
 * when it is unknown or set by the user's server. outputTokens is the output
 * limit a task request sends: 32768 for OpenAI reasoning families, otherwise
 * 4096 for Chat Completions and Responses;
 * min(documented maximum output, 16384) for a listed Messages model, otherwise
 * 4096. Checked 2026-11-10; sources and per-model table: AGENT-PROVIDERS.md. */
export interface AgentModelTokenLimits {contextTokens: number | null; outputTokens: number}
/** Keep documented capability separate from the output limit sent today. */
interface AgentModelTokenProfile extends AgentModelTokenLimits {maxOutputTokens: number | null}
// These are explicit text-only profiles, not a vendor-wide compatibility claim.
// Unknown models use a separate conservative generic profile; combinations
// without a runnable endpoint fail before inference. Sources and region/account
// caveats: AGENT-PROVIDERS.md.
// Legacy optional profiles document their disable switch. New OpenAI reasoning
// families are resolved separately; their minimum need not turn reasoning off.
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
// New exact models have independent controls; retained legacy names keep the
// same frozen profiles and request bytes on recovery.
const vendorChatProfiles: Readonly<Record<string, readonly AgentChatProfile[]>> = freeze({
  qwen: [{models: ['qwen3.8-flash'], tokenField: 'max_tokens', fields: {enable_thinking: false}, thinkingTier: 'optional', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS}],
  kimi: [{models: ['kimi-k3.1-pro'], tokenField: 'max_completion_tokens', fields: {reasoning_effort: 'low'}, thinkingTier: 'required', contextTokens: 1048576, maxOutputTokens: 1048576, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS}],
});
// Generic models have a separately bounded profile. They never borrow a named
// model's context/output capacity or its special stream termination contract.
const genericChatProfiles: Readonly<Record<string, AgentChatProfile>> = freeze(Object.fromEntries(Object.entries(profiles).map(([id, profile]) => [id, {
  ...profile, models: null, contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS, thinkingTier: 'unsupported' as const,
  ...(id === 'openrouter' ? {fields: {...profile.fields, reasoning: {enabled: false}}} : {}),
}])));
/** Select request fields before dispatch. A preset without a dedicated profile
 * uses this protocol's generic template; errors never trigger another attempt. */
export function agentChatProfile(configuration: AgentConfiguration): AgentChatProfile {
  if (configuration.protocol !== 'chat_completions') throw agentChatError('AGENT_CHAT_VALIDATION');
  const family = reasoningFamily(configuration);
  if (family?.chatCompletions) return freeze({models: [configuration.model], tokenField: configuration.presetId === 'openai' ? 'max_completion_tokens' : 'max_tokens',
    fields: configuration.presetId === 'openai' ? {store: false, ...(family.minimumEffort ? {reasoning_effort: family.minimumEffort} : {})}
      : {provider: {require_parameters: true, allow_fallbacks: false}, ...(family.minimumEffort ? {reasoning: {effort: family.minimumEffort}} : {})},
    thinkingTier: family.minimumEffort === 'none' ? 'optional' : 'required', contextTokens: family.contextTokens,
    maxOutputTokens: family.maxOutputTokens, outputTokens: AGENT_OPENAI_REASONING_OUTPUT_TOKENS});
  const current = Object.hasOwn(vendorChatProfiles, configuration.presetId) ? vendorChatProfiles[configuration.presetId]?.find(profile => profile.models?.includes(configuration.model)) : undefined;
  if (current) return current;
  const exact = Object.hasOwn(AGENT_CHAT_PROFILES, configuration.presetId) ? AGENT_CHAT_PROFILES[configuration.presetId] : undefined;
  if (exact && (exact.models === null || exact.models.includes(configuration.model))) return exact;
  return Object.hasOwn(genericChatProfiles, configuration.presetId) ? genericChatProfiles[configuration.presetId] : genericChatProfiles.custom;
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
// Each protocol uses only confirmed exact capacity; Qwen documents 1M/128K
// abbreviations, so both exact capacity fields remain unknown.
interface AgentResponsesProfile extends AgentModelTokenProfile {models: string[] | null; fields: Record<string, unknown>; thinkingTier: AgentThinkingTier}
const responseProfiles: Record<string, AgentResponsesProfile> = {
  openai: {models: ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'], fields: {truncation: 'disabled'}, thinkingTier: 'unsupported', contextTokens: 1047576, maxOutputTokens: 32768, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
  custom: {models: null, fields: {truncation: 'disabled'}, thinkingTier: 'unsupported', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
  ollama: {models: ['qwen3:8b'], fields: {reasoning: {effort: 'none'}}, thinkingTier: 'optional', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
  deepseek: {models: ['deepseek-flash'], fields: {reasoning: {effort: 'none'}}, thinkingTier: 'optional', contextTokens: 1000000, maxOutputTokens: 393216, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
  qwen: {models: ['qwen3.8-flash'], fields: {reasoning: {effort: 'none'}}, thinkingTier: 'optional', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
};
export const AGENT_RESPONSES_PROFILES: Readonly<Record<string, AgentResponsesProfile>> = freeze(responseProfiles);
const genericResponsesProfiles: Readonly<Record<string, AgentResponsesProfile>> = freeze({
  ...Object.fromEntries(Object.entries(responseProfiles).map(([id, profile]) => [id, {...profile, models: null, contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS, thinkingTier: 'unsupported' as const}])),
  zhipu: {models: null, fields: {reasoning: {effort: 'none'}}, thinkingTier: 'unsupported', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
  minimax: {models: null, fields: {reasoning: {effort: 'none'}}, thinkingTier: 'unsupported', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
  // The Responses schema independently supports enabled:false. provider fields
  // enforce routing constraints. Unverified models still never admit thinking;
  // in particular an old fallback body gains no capability from today's map.
  openrouter: {models: null, fields: {provider: {require_parameters: true, allow_fallbacks: false}, reasoning: {enabled: false}}, thinkingTier: 'unsupported', contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
});
/** Unlisted vendor/protocol combinations use the explicitly selected protocol's
 * generic template from the first request, with no error-driven switching. */
export function agentResponsesProfile(configuration: AgentConfiguration): AgentResponsesProfile {
  if (configuration.protocol !== 'responses') throw agentChatError('AGENT_CHAT_VALIDATION');
  const family = configuration.presetId === 'openai' ? agentOpenAiReasoningFamily(configuration.model) : null;
  if (family) return freeze({models: [configuration.model], fields: {truncation: 'disabled', ...(family.minimumEffort ? {reasoning: {effort: family.minimumEffort}} : {})},
    thinkingTier: family.minimumEffort === 'none' ? 'optional' : 'required', contextTokens: family.contextTokens,
    maxOutputTokens: family.maxOutputTokens, outputTokens: family.documented ? AGENT_OPENAI_REASONING_OUTPUT_TOKENS : AGENT_DEFAULT_OUTPUT_TOKENS});
  const exact = Object.hasOwn(AGENT_RESPONSES_PROFILES, configuration.presetId) ? AGENT_RESPONSES_PROFILES[configuration.presetId] : undefined;
  if (exact && (exact.models === null || exact.models.includes(configuration.model))) return exact;
  return Object.hasOwn(genericResponsesProfiles, configuration.presetId) ? genericResponsesProfiles[configuration.presetId] : genericResponsesProfiles.custom;
}
function reasoningFamily(configuration: AgentConfiguration) {
  if (configuration.presetId === 'openai') return agentOpenAiReasoningFamily(configuration.model);
  if (configuration.presetId === 'openrouter' && configuration.protocol === 'chat_completions' && configuration.model.startsWith('openai/')) {
    const family = agentOpenAiReasoningFamily(configuration.model.slice('openai/'.length));
    return family?.documented ? {...family,chatCompletions:family.openRouterChatCompletions} : null;
  }
  return null;
}
/** Protocol carrier support is independent of whether this request selects
 * none effort. Unknown official model IDs keep this carrier but no adaptation,
 * explicit effort or documented capacity. Other providers retain their policy. */
export function agentResponsesReasoningCapable(configuration: AgentConfiguration): boolean {
  return configuration.protocol === 'responses' && configuration.presetId === 'openai' && agentOpenAiReasoningFamily(configuration.model) !== null;
}
/** Messages keeps the legacy disabled policy except for the exact approved
 * native Sonnet configuration. Other protocols take their exact model tier. */
export function agentModelThinkingTier(configuration: AgentConfiguration): AgentThinkingTier {
  if (configuration.protocol === 'chat_completions') return agentChatProfile(configuration).thinkingTier;
  if (configuration.protocol === 'responses') return agentResponsesProfile(configuration).thinkingTier;
  if (configuration.protocol === 'anthropic_messages') return agentSonnetConfiguration(configuration) ? 'required' : 'optional';
  return fail('AGENT_CHAT_VALIDATION');
}
// Exact Messages token metadata stays separate from its wire controls. Legacy
// limits retain their original identity; new models do not borrow old capacity.
const messagesTokenLimits: Record<string, AgentModelTokenProfile & {models: string[]}> = {
  anthropic: {models: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], contextTokens: 200000, maxOutputTokens: 64000, outputTokens: Math.min(64000, AGENT_OUTPUT_TOKEN_CEILING)},
  qwen: {models: ['qwen3.8-flash'], contextTokens: null, maxOutputTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS},
};
const vendorMessageTokenLimits: Readonly<Record<string, readonly (AgentModelTokenProfile & {models: string[]})[]>> = freeze({
  anthropic: [{models: ['claude-sonnet-5-5'], contextTokens: null, maxOutputTokens: 128000, outputTokens: AGENT_OUTPUT_TOKEN_CEILING}],
});
export const AGENT_MESSAGES_TOKEN_LIMITS: Readonly<Record<string, Readonly<AgentModelTokenProfile & {models: string[]}>>> = freeze(messagesTokenLimits);
const tokenLimits = ({contextTokens, outputTokens}: AgentModelTokenLimits): AgentModelTokenLimits => ({contextTokens, outputTokens});
/** Chat Completions and Responses read the protocol's profile. Any combination
 * without verified limits has an unknown window and the default output limit. */
export function agentModelTokenLimits(configuration: AgentConfiguration): AgentModelTokenLimits {
  if (configuration.protocol === 'chat_completions') return tokenLimits(agentChatProfile(configuration));
  if (configuration.protocol === 'responses') return tokenLimits(agentResponsesProfile(configuration));
  if (configuration.protocol !== 'anthropic_messages') return fail('AGENT_CHAT_VALIDATION');
  const current = Object.hasOwn(vendorMessageTokenLimits, configuration.presetId) ? vendorMessageTokenLimits[configuration.presetId]?.find(profile => profile.models.includes(configuration.model)) : undefined;
  if (current) return tokenLimits(current);
  const listed = Object.hasOwn(AGENT_MESSAGES_TOKEN_LIMITS, configuration.presetId) ? AGENT_MESSAGES_TOKEN_LIMITS[configuration.presetId] : undefined;
  return listed?.models.includes(configuration.model) ? tokenLimits(listed) : {contextTokens: null, outputTokens: AGENT_DEFAULT_OUTPUT_TOKENS};
}
/** Exact native Sonnet requests use the approved adaptive policy. The legacy
 * manual helper retains its existing budget semantics for other callers;
 * Chat Completions and Responses send their own model-specific fields. */
export function agentAnthropicThinkingFields(tier: AgentThinkingTier, outputTokens: number, configuration?: AgentConfiguration): typeof ANTHROPIC_MESSAGES_FIELDS | ReturnType<typeof anthropicThinkingFields> | ReturnType<typeof agentSonnetThinkingFields> {
  const sonnet=agentSonnetThinkingFields();
  if(configuration&&agentSonnetConfiguration(configuration))return sonnet;
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
/** Only exact named profiles get the adapted label, regardless of whether a
 * model came from a fetched list, manual input or an old saved selection. */
export function agentAdaptedModelHints(presetId: string): Partial<Record<AgentProtocol, string[]>> {
  if (presetId === 'custom') return {};
  const extraChat = Object.hasOwn(vendorChatProfiles, presetId) ? vendorChatProfiles[presetId]!.flatMap(profile => profile.models ?? []) : [];
  const legacyChat = AGENT_CHAT_PROFILES[presetId]?.models;
  const chat = extraChat.length ? [...extraChat, ...(legacyChat ?? [])] : legacyChat, responses = AGENT_RESPONSES_PROFILES[presetId]?.models,
    messages = [...(Object.hasOwn(vendorMessageTokenLimits, presetId) ? vendorMessageTokenLimits[presetId]!.flatMap(profile => profile.models) : []), ...(AGENT_MESSAGES_TOKEN_LIMITS[presetId]?.models ?? [])];
  if (presetId === 'openai') return {chat_completions: [...AGENT_OPENAI_REASONING_MODEL_HINTS.chat_completions], responses: [...AGENT_OPENAI_REASONING_MODEL_HINTS.responses]};
  if (presetId === 'openrouter') return {chat_completions: [...AGENT_OPENROUTER_REASONING_MODEL_HINTS]};
  return {...(chat ? {chat_completions: [...chat]} : {}), ...(responses ? {responses: [...responses]} : {}), ...(messages.length ? {anthropic_messages: [...messages]} : {})};
}
export function agentModelAdaptation(configuration: AgentConfiguration): 'adapted' | 'unverified' {
  if (agentOpenAiModelIsAdapted(configuration.presetId, configuration.protocol, configuration.model)) return 'adapted';
  return agentAdaptedModelHints(configuration.presetId)[configuration.protocol]?.includes(configuration.model) ? 'adapted' : 'unverified';
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
    zhipu: {parallel: false, choice: false, strict: false},
    minimax: {parallel: false, choice: false, strict: false},
    openrouter: {parallel: false, choice: true, strict: false},
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
function rejectBlockedEndpoint(configuration: unknown): void {
  if (!object(configuration) || typeof configuration.presetId !== 'string' || typeof configuration.platformId !== 'string' ||
      !['chat_completions', 'responses', 'anthropic_messages'].includes(String(configuration.protocol))) return;
  const platform = agentPresetPlatform(AGENT_PRESETS, configuration.presetId, configuration.platformId);
  if (platform && !platform.availableProtocols.includes(configuration.protocol as AgentProtocol)) fail('AGENT_CHAT_PROFILE_UNSUPPORTED');
}
export function validateAgentChatProfile(configuration: unknown, {selfPort}: AgentProfileValidationOptions = {}): AgentConfiguration {
  let config: AgentConfiguration;
  rejectBlockedEndpoint(configuration);
  try { config = parseAgentConfiguration(configuration, {selfPort}); } catch { return fail('AGENT_CHAT_VALIDATION'); }
  if (config.protocol !== 'chat_completions') fail('AGENT_CHAT_VALIDATION');
  const profile = agentChatProfile(config);
  if (!profile || (profile.models && !profile.models.includes(config.model))) fail('AGENT_CHAT_PROFILE_UNSUPPORTED');
  return config;
}
export function validateAgentResponsesProfile(configuration: unknown, {selfPort}: AgentProfileValidationOptions = {}): AgentConfiguration {
  let config: AgentConfiguration;
  rejectBlockedEndpoint(configuration);
  try { config = parseAgentConfiguration(configuration, {selfPort}); } catch { return fail('AGENT_CHAT_VALIDATION'); }
  if (config.protocol !== 'responses') fail('AGENT_CHAT_VALIDATION');
  const profile = agentResponsesProfile(config);
  if (!profile || (profile.models && !profile.models.includes(config.model))) fail('AGENT_CHAT_PROFILE_UNSUPPORTED');
  return config;
}
// All presets use this same explicit text/client-tool Messages subset, with
// thinking disabled. A model name does not grant additional content families.
export function validateAnthropicMessagesProfile(configuration: unknown, {selfPort}: AgentProfileValidationOptions = {}): AgentConfiguration {
  let config: AgentConfiguration;
  rejectBlockedEndpoint(configuration);
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
