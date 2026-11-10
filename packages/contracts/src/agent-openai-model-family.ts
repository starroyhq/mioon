/** Pure model-name policy shared by the request profiles and settings UI.
 * Compatibility is not model availability or account access. Sources and the
 * checked family boundaries are recorded in AGENT-PROVIDERS.md (2026-11-10). */
export type AgentOpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface AgentOpenAiReasoningFamily {
  readonly documented: boolean;
  readonly minimumEffort: AgentOpenAiReasoningEffort | null;
  readonly efforts: readonly AgentOpenAiReasoningEffort[] | null;
  readonly contextTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly chatCompletions: boolean;
  readonly openRouterChatCompletions: boolean;
  readonly status: 'current' | 'deprecated' | 'unverified';
}
export const AGENT_DEFAULT_OPENAI_MODEL = 'gpt-6.1-terra';
const initial = Object.freeze(['minimal', 'low', 'medium', 'high'] as const);
const standard = Object.freeze(['none', 'low', 'medium', 'high'] as const);
const extended = Object.freeze([...standard, 'xhigh'] as const);
const required = Object.freeze(['low', 'medium', 'high'] as const);
const current = Object.freeze([...extended, 'max'] as const);
const currentRequired = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const);
const family = (efforts: readonly AgentOpenAiReasoningEffort[], contextTokens: number, maxOutputTokens = 128000, chatCompletions = true, status: 'current' | 'deprecated' = 'current', openRouterChatCompletions = chatCompletions): AgentOpenAiReasoningFamily =>
  Object.freeze({documented: true, minimumEffort: efforts[0]!, efforts, contextTokens, maxOutputTokens, chatCompletions, status, openRouterChatCompletions});
const documented: Readonly<Record<string, AgentOpenAiReasoningFamily>> = Object.freeze({
  'gpt-6.1-terra': family(current, 1050000, 128000, false, 'current', true),
  'gpt-6.1-sol': family(currentRequired, 1050000, 128000, false),
  'gpt-6-astra': family(currentRequired, 1050000, 128000, false),
  'gpt-6-luna': family(current, 1050000),
  'gpt-6-sol': family(current, 1050000),
  'gpt-5.6-sol': family(current, 1050000),
  'gpt-5.6-terra': family(current, 1050000),
  'gpt-5.6-luna': family(current, 1050000),
  'gpt-5.6': family(current, 1050000),
  'gpt-5.5': family(extended, 1050000),
  'gpt-5.4-mini': family(extended, 400000),
  'gpt-5.4': family(extended, 1050000),
  'gpt-5.2': family(extended, 400000),
  'gpt-5.4-pro': family(Object.freeze(['medium', 'high', 'xhigh']), 1050000, 128000, false),
  'gpt-5.4-nano': family(extended, 400000, 128000, true, 'deprecated'),
  'gpt-5': family(initial, 400000, 128000, true, 'deprecated'),
  'gpt-5-mini': family(initial, 400000, 128000, true, 'deprecated'),
  'gpt-5-nano': family(initial, 400000, 128000, true, 'deprecated'),
  'gpt-5.1': family(standard, 400000, 128000, true, 'deprecated'),
  'gpt-5.3-codex': family(Object.freeze(['low', 'medium', 'high', 'xhigh']), 400000, 128000, false, 'deprecated'),
  'gpt-5-pro': family(Object.freeze(['high']), 400000, 272000, false, 'deprecated'),
  'o3': family(required, 200000, 100000, true, 'deprecated'),
});
const unverified: AgentOpenAiReasoningFamily = Object.freeze({documented: false, minimumEffort: null, efforts: null, contextTokens: null, maxOutputTokens: null, chatCompletions: false, openRouterChatCompletions: false, status: 'unverified'});
const shutdown = new Set([
  'o1', 'o1-mini', 'o1-preview', 'o1-pro', 'o3-mini', 'o4-mini', 'o3-deep-research', 'o4-mini-deep-research',
  'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.2-codex', 'gpt-5-codex', 'codex-mini-latest',
  'gpt-5-chat-latest', 'gpt-5.1-chat-latest', 'gpt-5.2-chat-latest', 'gpt-5.3-chat-latest',
  'gpt-4.1-nano', 'gpt-4', 'gpt-4-turbo', 'gpt-4-turbo-preview', 'gpt-4.5-preview', 'gpt-3.5-turbo',
  'gpt-4o-search-preview', 'gpt-4o-mini-search-preview', 'chatgpt-4o-latest', 'computer-use-preview',
]);
const legacyText = new Set(['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini']);
const parentModel = (model: string): string => model.replace(/-\d{4}-\d{2}-\d{2}$/u, '');
/** Exact known legacy text/shutdown IDs retain their old carrier policy.
 * Everything else in the official Responses preset may carry reasoning,
 * regardless of future names. No effort, availability or capacity is inferred. */
export function agentOpenAiReasoningFamily(model: string): AgentOpenAiReasoningFamily | null {
  const parent = parentModel(model);
  if (Object.hasOwn(documented, parent)) return documented[parent]!;
  if (shutdown.has(parent) || legacyText.has(parent) || parent === 'gpt-5.1-mini') return null;
  return unverified;
}

export function agentOpenAiModelIsAdapted(presetId: string, protocol: string, model: string): boolean {
  const router = presetId === 'openrouter' && protocol === 'chat_completions' && model.startsWith('openai/');
  if (router) model = model.slice('openai/'.length);
  else if (presetId !== 'openai') return false;
  if (parentModel(model) === 'gpt-4.1-mini') return protocol === 'responses' && !router || protocol === 'chat_completions';
  const selected = agentOpenAiReasoningFamily(model);
  return selected?.documented === true && (protocol === 'responses' && !router || protocol === 'chat_completions' && (router ? selected.openRouterChatCompletions : selected.chatCompletions));
}

/** Suggestions are current verified models, never the entire compatibility map. */
const suggestions = [AGENT_DEFAULT_OPENAI_MODEL, ...Object.keys(documented).filter(model => model !== AGENT_DEFAULT_OPENAI_MODEL)];
export const AGENT_OPENAI_REASONING_MODEL_HINTS = Object.freeze({
  chat_completions: Object.freeze(suggestions.filter(model => documented[model]!.status === 'current' && documented[model]!.chatCompletions)),
  responses: Object.freeze(suggestions.filter(model => documented[model]!.status === 'current')),
});
export const AGENT_OPENROUTER_REASONING_MODEL_HINTS = Object.freeze(suggestions.filter(model => documented[model]!.status === 'current' && documented[model]!.openRouterChatCompletions).map(model => `openai/${model}`));
