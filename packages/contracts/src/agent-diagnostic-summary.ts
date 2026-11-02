import {z} from 'zod';

/** Safe application-level cache. No project/run ID, endpoint or request text. */
export const agentDiagnosticSummarySchema = z.object({
  completedAt: z.string().datetime(), status: z.enum(['completed', 'failed', 'stopped', 'reverted']),
  protocol: z.enum(['chat_completions', 'responses', 'anthropic_messages']),
  model: z.string().max(200), errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u).nullable(),
}).strict();
export type AgentDiagnosticSummary = z.infer<typeof agentDiagnosticSummarySchema>;
