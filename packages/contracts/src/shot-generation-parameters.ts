import {z} from 'zod';
import {videoGenerationParametersSchema} from './wan-video.ts';

export const baseShotParametersSchema = z.object({
  scenario: z.enum(['success', 'failure', 'delay', 'timeout', 'unknown', 'reject', 'download_fail_once',
    'rejected_before_accept', 'accepted_then_response_lost', 'poll_timeout_then_recover', 'terminal_failure']).optional(),
  delayMs: z.number().int().min(0).max(120_000).optional(),
  seed: z.number().int().optional(),
}).strict();

export const shotGenerationParametersSchema = baseShotParametersSchema.merge(videoGenerationParametersSchema);
