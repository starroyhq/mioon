import {z} from 'zod';

export const MIO_USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fieldCoverage = z.object({reportedSteps: count, missingSteps: count, complete: z.boolean(), overflow: z.boolean()}).strict();
const totals = z.object({inputTokens: count.nullable(), outputTokens: count.nullable(), cacheReadTokens: count.nullable(), cacheWriteTokens: count.nullable()}).strict();
const fields = z.object({inputTokens: fieldCoverage, outputTokens: fieldCoverage, cacheReadTokens: fieldCoverage, cacheWriteTokens: fieldCoverage}).strict();

/** Public passive measurements only. Input includes cached tokens; cache
 * counters are breakdowns, and knownTotals may cover only some requests. */
export const mioRunUsageSchema = z.object({
  version: z.literal(1), runId: z.string().uuid(), revision: count.refine(value => value > 0),
  dispatchedModelSteps: count,
  modelOutcomes: z.object({completed: count, failed: count, unknown: count, inflight: count}).strict(),
  knownTotals: totals, coverage: z.object({fields}).strict(),
  cacheReadRate: z.number().finite().min(0).max(1).nullable(),
}).strict().superRefine((value, context) => {
  if (Object.values(value.modelOutcomes).reduce((sum, item) => sum + item, 0) !== value.dispatchedModelSteps) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ['modelOutcomes'], message: 'Outcomes must cover every dispatched request'});
  }
  for (const field of MIO_USAGE_FIELDS) {
    const coverage = value.coverage.fields[field], total = value.knownTotals[field];
    if (coverage.reportedSteps + coverage.missingSteps !== value.dispatchedModelSteps ||
      coverage.complete !== (coverage.missingSteps === 0 && !coverage.overflow) ||
      (total === null) !== (coverage.reportedSteps === 0 || coverage.overflow) ||
      coverage.overflow && coverage.reportedSteps === 0) {
      context.addIssue({code: z.ZodIssueCode.custom, path: ['coverage', 'fields', field], message: 'Coverage and known total disagree'});
    }
  }
  const input = value.knownTotals.inputTokens, read = value.knownTotals.cacheReadTokens;
  const rate = value.coverage.fields.inputTokens.complete && value.coverage.fields.cacheReadTokens.complete &&
    input !== null && input > 0 && read !== null && read <= input ? read / input : null;
  if (value.cacheReadRate !== rate) context.addIssue({code: z.ZodIssueCode.custom, path: ['cacheReadRate'], message: 'Cache rate requires complete input and cache-read coverage'});
});
export type MioRunUsage = z.infer<typeof mioRunUsageSchema>;
