// This protocol identity keeps its compatibility version stable for retained
// requests. A future API-version change must preserve this profile for recovery.
export const ANTHROPIC_MESSAGES_API_VERSION = '2023-06-01';
export const ANTHROPIC_MESSAGES_FIELDS = Object.freeze({thinking: Object.freeze({type: 'disabled' as const})});
// Manual extended thinking for a model that cannot disable it. The documented
// budget is at least 1024 tokens and below max_tokens, which counts thinking.
export const ANTHROPIC_MIN_THINKING_BUDGET_TOKENS = 1024;
export function anthropicThinkingFields(budgetTokens: number): Readonly<{thinking: Readonly<{type: 'enabled'; budget_tokens: number}>}> {
  return Object.freeze({thinking: Object.freeze({type: 'enabled' as const, budget_tokens: budgetTokens})});
}
