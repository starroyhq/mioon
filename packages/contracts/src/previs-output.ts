import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';

/** Portable saved-render facts. This dependency leaf is also used by persisted
 * asset validation, without importing public asset DTOs or model operations. */
export const previsOutputIdentitySchema = z.object({
  projectId: projectIdSchema, nodeId: projectIdSchema,
  keyframeId: z.string().regex(/^k[1-9][0-9]{0,3}$/u),
  sceneRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(8).max(200), name: z.string().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096),
}).strict();
export type PrevisOutputIdentity = z.infer<typeof previsOutputIdentitySchema>;
