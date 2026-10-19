import type { ComparisonBinding } from './version-comparison-state.ts';

export const comparisonDetailKeys = ['model', 'provider', 'duration', 'aspectRatio', 'references', 'prompt', 'seed', 'createdAt'] as const;
export type ComparisonDetailKey = typeof comparisonDetailKeys[number];
export interface ComparisonDetailRow { key: ComparisonDetailKey; values: readonly [string | number | null, string | number | null]; different: boolean }
/** Values come only from the frozen version binding, never mutable shot defaults. */
export function comparisonDetailRows(a: ComparisonBinding, b: ComparisonBinding): readonly ComparisonDetailRow[] {
  return comparisonDetailKeys.map(key => {
    const values = [a.metadata[key], b.metadata[key]] as const;
    return { key, values, different: values[0] !== values[1] };
  });
}
