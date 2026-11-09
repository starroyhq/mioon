/** Pure model-name policy shared by the request profiles and settings UI.
 * Compatibility is not model availability or account access. Sources and the
 * checked family boundaries are recorded in AGENT-PROVIDERS.md (2026-11-09). */
export type AgentOpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export interface AgentOpenAiReasoningFamily {
  readonly documented: boolean;
  readonly minimumEffort: AgentOpenAiReasoningEffort | null;
  readonly efforts: readonly AgentOpenAiReasoningEffort[] | null;
  readonly contextTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly chatCompletions: boolean;
}
export const AGENT_DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
const initial = Object.freeze(['minimal', 'low', 'medium', 'high'] as const);
const standard = Object.freeze(['none', 'low', 'medium', 'high'] as const);
const extended = Object.freeze([...standard, 'xhigh'] as const);
const required = Object.freeze(['low', 'medium', 'high'] as const);
const family = (efforts: readonly AgentOpenAiReasoningEffort[], contextTokens: number, maxOutputTokens = 128000, chatCompletions = true): AgentOpenAiReasoningFamily =>
  Object.freeze({documented: true, minimumEffort: efforts[0]!, efforts, contextTokens, maxOutputTokens, chatCompletions});
const documented: Readonly<Record<string, AgentOpenAiReasoningFamily>> = Object.freeze({
  'gpt-5.4-mini': family(extended, 400000),
  'gpt-5.4': family(extended, 1050000),
  'gpt-5.4-nano': family(extended, 400000),
  'gpt-5.5': family(extended, 1050000),
  'gpt-5': family(initial, 400000),
  'gpt-5-mini': family(initial, 400000),
  'gpt-5-nano': family(initial, 400000),
  'gpt-5.1': family(standard, 400000),
  'gpt-5.2': family(extended, 400000),
  // These specialized models document a different minimum and Responses-only
  // use. They must not borrow the standard model's none switch or CC profile.
  'gpt-5.3-codex': family(Object.freeze(['low', 'medium', 'high', 'xhigh']), 400000, 128000, false),
  'gpt-5-pro': family(Object.freeze(['high']), 400000, 272000, false),
  'gpt-5.4-pro': family(Object.freeze(['medium', 'high', 'xhigh']), 1050000, 128000, false),
  // o1 is retained only for archived configurations, never as a new default.
  'o1': family(required, 200000, 100000),
  'o3': family(required, 200000, 100000),
  'o3-mini': family(required, 200000, 100000),
  'o4-mini': family(required, 200000, 100000),
});
const unverified: AgentOpenAiReasoningFamily = Object.freeze({documented: false, minimumEffort: null, efforts: null, contextTokens: null, maxOutputTokens: null, chatCompletions: true});

/** Date snapshots inherit their documented parent. Unknown canonical GPT-5.x
 * text families can carry reasoning but do not borrow any effort or capacity.
 * Specialized suffixes (chat, codex, pro, research) require their own evidence. */
export function agentOpenAiReasoningFamily(model: string): AgentOpenAiReasoningFamily | null {
  const parent = model.replace(/-\d{4}-\d{2}-\d{2}$/u, '');
  if (Object.hasOwn(documented, parent)) return documented[parent]!;
  // The SDK preserves this old spelling for type compatibility and explicitly
  // says it is not an API model. Never label it as a supported family.
  if (parent === 'gpt-5.1-mini') return null;
  return /^gpt-5\.[1-9]\d*(?:-(?:mini|nano))?$/u.test(parent) ? unverified : null;
}

export function agentOpenAiModelIsAdapted(presetId: string, protocol: string, model: string): boolean {
  if (presetId === 'openrouter' && protocol === 'chat_completions' && model.startsWith('openai/')) model = model.slice('openai/'.length);
  else if (presetId !== 'openai') return false;
  const selected = agentOpenAiReasoningFamily(model);
  return selected?.documented === true && (protocol === 'responses' && presetId === 'openai' || protocol === 'chat_completions' && selected.chatCompletions);
}

/** Finite suggestions only: fetched/manual snapshot IDs are classified by the
 * same matcher, rather than copying a supplier's adaptation label. */
export const AGENT_OPENAI_REASONING_MODEL_HINTS = Object.freeze({
  chat_completions: Object.freeze(Object.keys(documented).filter(model => documented[model]!.chatCompletions)),
  responses: Object.freeze(Object.keys(documented)),
});
