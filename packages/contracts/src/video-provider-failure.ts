import {z} from 'zod';

/** Provider evidence admitted by the adapter's redaction boundary. */
export const videoProviderFailureSchema = z.object({
  providerType: z.string().min(1).max(100).optional(),
  code: z.string().min(1).max(100).optional(),
  message: z.string().min(1).max(256).optional(),
  httpStatus: z.number().int().min(400).max(599).optional(),
}).strict();
export type VideoProviderFailure = z.infer<typeof videoProviderFailureSchema>;
