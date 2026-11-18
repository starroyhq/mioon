import {z} from 'zod';
import {mioProjectFileImportInputSchema} from './mio-project-import.ts';

/** Bytes and OS paths remain the trusted host's responsibility. */
export const mioAssetImportInputSchema = z.discriminatedUnion('source', [
  mioProjectFileImportInputSchema.extend({source: z.literal('project_file')}),
  z.object({source: z.literal('selected'), handle: z.string().uuid()}).strict(),
]);
