import {z} from 'zod';

export const DRAFT_SERVICE_PROBE_LIMITS = Object.freeze({responseBytes: 1024 * 1024, models: 1000});
export const draftServiceModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
const model = z.object({id: draftServiceModelIdSchema}).strict();

export const draftServiceProbeResultSchema = z.object({
  result: z.enum(['ok', 'unauthorized', 'unsupported', 'denied', 'unreachable', 'http_error', 'failed']),
  httpStatus: z.number().int().min(100).max(599).optional(),
  models: z.array(model).max(DRAFT_SERVICE_PROBE_LIMITS.models)
    .refine(models => new Set(models.map(entry => entry.id)).size === models.length).optional(),
}).strict().refine(result => result.result === 'ok' || result.models === undefined);

export type DraftServiceProbeResult = z.infer<typeof draftServiceProbeResultSchema>;
