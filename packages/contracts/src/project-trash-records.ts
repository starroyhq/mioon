import {z} from 'zod';
import {projectDeleteInputSchema} from './project-lifecycle.ts';
import {projectTrashFileGenerationSchema} from './project-trash-native.ts';

const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Private operation recovery metadata; not a database schema or HTTP input. */
export const projectTrashIntentSchema = z.object({
  version: z.literal(1), operation: z.literal('project.delete'),
  input: projectDeleteInputSchema, digest: z.string().regex(/^[a-f0-9]{64}$/u),
  phase: z.enum(['prepared', 'dispatched', 'not-started']),
  source: z.object({projectId: z.string().uuid(), revision: safeCount.positive(),
    contentSequence: safeCount, contentToken: z.string().regex(/^[a-f0-9]{32}$/u),
    generation: projectTrashFileGenerationSchema}).strict(),
}).strict();
export type ProjectTrashIntent = z.infer<typeof projectTrashIntentSchema>;
