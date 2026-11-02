// This protocol identity keeps its compatibility version stable for retained
// requests. A future API-version change must preserve this profile for recovery.
export const ANTHROPIC_MESSAGES_API_VERSION = '2023-06-01';
export const ANTHROPIC_MESSAGES_FIELDS = Object.freeze({thinking: Object.freeze({type: 'disabled' as const})});
// Manual extended thinking for a model that cannot disable it: the smallest
// documented budget (at least 1024 and below max_tokens, which counts thinking).
// Per-model token budgets and output limits are separate work.
export const ANTHROPIC_THINKING_FIELDS = Object.freeze({thinking: Object.freeze({type: 'enabled' as const, budget_tokens: 1024})});
