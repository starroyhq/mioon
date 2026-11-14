import {z} from 'zod';
import {IMAGE_SETTINGS_LIMITS} from './image-settings.ts';
import {customImageBaseUrlSchema} from './image-compatible.ts';
import {customImageConnectionIdV2Schema} from './generation-image-settings.ts';

const operation = z.enum(['check', 'models']);
const configurationRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const draftCredential = z.object({source: z.literal('draft'),
  value: z.string().min(1).max(IMAGE_SETTINGS_LIMITS.secretBytes).regex(/^[\x21-\x7e]+$/u)}).strict();
const savedCredential = z.object({source: z.literal('saved'), configurationRevision}).strict();

export const officialImageProbeSchema = z.object({
  operation,
  credential: z.discriminatedUnion('source', [draftCredential, savedCredential]),
}).strict();

export const customImageProbeSchema = z.object({
  operation,
  baseUrl: customImageBaseUrlSchema,
  credential: z.discriminatedUnion('source', [
    draftCredential, savedCredential.extend({connectionId: customImageConnectionIdV2Schema, configurationRevision: configurationRevision.min(1)}).strict(),
  ]),
}).strict();

export type OfficialImageProbe = z.infer<typeof officialImageProbeSchema>;
export type CustomImageProbe = z.infer<typeof customImageProbeSchema>;
