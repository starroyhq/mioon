import {parseAgentConfiguration} from './config.ts';
import type {AgentConfiguration} from './config.ts';
import {agentChatError} from './chat-errors.ts';
import type {AgentProtocol} from '../../../contracts/src/agent-protocol.ts';

function freeze<T extends object>(value: T): Readonly<T> { for (const child of Object.values(value as Record<string, unknown>)) if (child && typeof child === 'object') freeze(child as object); return Object.freeze(value); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code: string): never { throw agentChatError(code); }

// These are explicit text-only profiles, not a vendor-wide compatibility claim.
// Model aliases/edits remain saveable settings, but unsupported named profiles
// fail before inference. Sources and region/account caveats: AGENT-PROVIDERS.md.
interface AgentChatProfile {models: string[] | null; tokenField: 'max_tokens' | 'max_completion_tokens'; fields: Record<string, unknown>}
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
interface AgentResponsesProfile {models: string[] | null; fields: Record<string, unknown>}
const responseProfiles: Record<string, AgentResponsesProfile> = {
  openai: {models: ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'], fields: {truncation: 'disabled'}},
  custom: {models: null, fields: {truncation: 'disabled'}},
  ollama: {models: ['qwen3:8b'], fields: {reasoning: {effort: 'none'}}},
  deepseek: {models: ['deepseek-flash'], fields: {reasoning: {effort: 'none'}}},
  qwen: {models: ['qwen3.8-flash'], fields: {reasoning: {effort: 'none'}}},
};
export const AGENT_RESPONSES_PROFILES: Readonly<Record<string, AgentResponsesProfile>> = freeze(responseProfiles);
/** Unlisted vendor/protocol combinations use the explicitly selected protocol's
 * generic template from the first request, with no error-driven switching. */
export function agentResponsesProfile(configuration: AgentConfiguration): AgentResponsesProfile {
  if (configuration.protocol !== 'responses') throw agentChatError('AGENT_CHAT_VALIDATION');
  return Object.hasOwn(AGENT_RESPONSES_PROFILES, configuration.presetId) ? AGENT_RESPONSES_PROFILES[configuration.presetId] : AGENT_RESPONSES_PROFILES.custom;
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
