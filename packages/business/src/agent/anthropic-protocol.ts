// This protocol identity keeps its compatibility version stable for retained
// requests. A future API-version change must preserve this profile for recovery.
export const ANTHROPIC_MESSAGES_API_VERSION = '2023-06-01';
export const ANTHROPIC_MESSAGES_FIELDS = Object.freeze({thinking: Object.freeze({type: 'disabled' as const})});
export const SONNET_PREFIX_BINDING_BETA = 'thinking-binding-controls-2026-08-01';
export const SONNET_PREFIX_BINDING_API_VERSION = '2026-10-21';
const sonnetFields = Object.freeze({
  thinking: Object.freeze({type: 'adaptive' as const, block_binding: Object.freeze({prefix_mismatch_behavior: 'drop_block' as const})}),
  output_config: Object.freeze({effort: 'low' as const}),
});
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** A model-specific policy, never inferred from a compatible endpoint or a
 * user-entered model name under another preset. */
export function agentSonnetConfiguration(configuration: unknown): boolean {
  return record(configuration) && configuration.presetId === 'anthropic' && configuration.platformId === 'global' &&
    configuration.baseUrl === 'https://api.anthropic.com' && configuration.model === 'claude-sonnet-5-5' && configuration.protocol === 'anthropic_messages';
}
export function agentSonnetThinkingFields(): typeof sonnetFields { return sonnetFields; }

/** Derive beta admission from the actual frozen request. In particular, old
 * retained requests do not acquire new behavior merely because a preset moved. */
export function agentSonnetPrefixBinding(configuration: unknown, body: unknown): boolean {
  if (!agentSonnetConfiguration(configuration) || !record(body) || body.model !== 'claude-sonnet-5-5' || body.stream !== true) return false;
  const thinking = body.thinking, output = body.output_config;
  return exact(thinking, ['type', 'block_binding']) && thinking.type === 'adaptive' &&
    exact(thinking.block_binding, ['prefix_mismatch_behavior']) && thinking.block_binding.prefix_mismatch_behavior === 'drop_block' &&
    exact(output, ['effort']) && output.effort === 'low';
}
// Manual extended thinking for a model that cannot disable it. The documented
// budget is at least 1024 tokens and below max_tokens, which counts thinking.
export const ANTHROPIC_MIN_THINKING_BUDGET_TOKENS = 1024;
export function anthropicThinkingFields(budgetTokens: number): Readonly<{thinking: Readonly<{type: 'enabled'; budget_tokens: number}>}> {
  return Object.freeze({thinking: Object.freeze({type: 'enabled' as const, budget_tokens: budgetTokens})});
}
