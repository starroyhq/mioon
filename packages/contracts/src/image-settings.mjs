import {z} from 'zod';
import {IMAGE_MODELS, IMAGE_FIXED_OPTIONS, imageOptionsSchema} from './images.mjs';

// Browser-safe, fixed OpenAI Images configuration. These schemas belong only to
// the dedicated settings HTTP route; never register a secret-bearing RPC tool.
export const IMAGE_SETTINGS_NAMESPACE = 'mioon.images.openai.v1';
export const IMAGE_SETTINGS_BASE_URL = 'https://api.openai.com/v1';
export const IMAGE_SETTINGS_PROFILE_ID = 'openai-images-v1';
export const IMAGE_SETTINGS_LIMITS = Object.freeze({updateBytes: 16 * 1024, secretBytes: 4096, envelopeBytes: 64 * 1024, ciphertextCharacters: 48 * 1024});
export const DEFAULT_IMAGE_CONFIGURATION = Object.freeze({enabled: false, providerId: 'openai', profileId: IMAGE_SETTINGS_PROFILE_ID,
  baseUrl: IMAGE_SETTINGS_BASE_URL, model: IMAGE_MODELS.openai, options: IMAGE_FIXED_OPTIONS});
export const imageConfigurationSchema = z.object({enabled: z.boolean(), providerId: z.literal('openai'), profileId: z.literal(IMAGE_SETTINGS_PROFILE_ID),
  baseUrl: z.literal(IMAGE_SETTINGS_BASE_URL), model: z.literal(IMAGE_MODELS.openai), options: imageOptionsSchema}).strict();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const secret = z.discriminatedUnion('action', [
  z.object({action: z.literal('keep')}).strict(),
  z.object({action: z.literal('remove')}).strict(),
  z.object({action: z.literal('replace'), storage: z.enum(['session', 'persistent']),
    value: z.string().min(1).max(IMAGE_SETTINGS_LIMITS.secretBytes).regex(/^[\x21-\x7e]+$/, 'Invalid credential input')}).strict(),
]);
export const imageSettingsUpdateSchema = z.object({expectedRevision: revision, configuration: imageConfigurationSchema, secret}).strict();
const storageSchema = z.object({persistentAvailable: z.boolean(), sessionScope: z.enum(['app', 'server']),
  reasonCode: z.enum(['WEB_SESSION_ONLY', 'OS_SECRET_STORE_UNAVAILABLE', 'LINUX_BASIC_TEXT']).nullable()}).strict()
  .refine(value => value.persistentAvailable === (value.reasonCode === null), 'Inconsistent storage capabilities');
export const imageSettingsResultSchema = z.object({revision, configuration: imageConfigurationSchema,
  secret: z.object({configured: z.boolean(), storage: z.enum(['none', 'session', 'persistent'])}).strict()
    .refine(value => value.configured === (value.storage !== 'none'), 'Inconsistent credential state'), storage: storageSchema}).strict();
export const isImageSettingsResult = value => imageSettingsResultSchema.safeParse(value).success;
