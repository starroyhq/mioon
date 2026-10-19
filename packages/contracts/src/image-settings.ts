import {z} from 'zod';
import {IMAGE_MODELS, IMAGE_FIXED_OPTIONS, imageOptionsSchema} from './images.ts';
import {customImageBaseUrlSchema, customImageModelSchema} from './image-compatible.ts';
export {customImageBaseUrlSchema, customImageModelSchema, normalizeCustomImageBaseUrl, getCustomImageDestination, CUSTOM_IMAGE_ENDPOINT_LIMIT} from './image-compatible.ts';

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
export type ImageSettingsResult = z.infer<typeof imageSettingsResultSchema>;
export function isImageSettingsResult(value: unknown): value is ImageSettingsResult { return imageSettingsResultSchema.safeParse(value).success; }

// A separate explicit slot. The official settings, namespace and key binding
// above remain unchanged; selecting this slot never adopts an official key.
export const CUSTOM_IMAGE_SETTINGS_NAMESPACE = 'mioon.images.openai-compatible.v1';
export const CUSTOM_IMAGE_PROFILE_ID = 'openai-images-json-png-v1';
export const CUSTOM_IMAGE_CONNECTION_ID = 'custom';
export const CUSTOM_IMAGE_SETTINGS_FILENAME = 'custom-settings.json';
export const DEFAULT_CUSTOM_IMAGE_CONFIGURATION = Object.freeze({enabled: false, providerId: 'openai-compatible',
  connectionId: CUSTOM_IMAGE_CONNECTION_ID, profileId: CUSTOM_IMAGE_PROFILE_ID, baseUrl: '', model: '', options: IMAGE_FIXED_OPTIONS});
export const customImageConfigurationSchema = z.object({enabled: z.boolean(), providerId: z.literal('openai-compatible'),
  connectionId: z.literal(CUSTOM_IMAGE_CONNECTION_ID), profileId: z.literal(CUSTOM_IMAGE_PROFILE_ID),
  baseUrl: z.union([z.literal(''), customImageBaseUrlSchema]), model: z.union([z.literal(''), customImageModelSchema]),
  options: imageOptionsSchema}).strict().refine(value =>
    value.baseUrl === '' || value.model === '' ? !value.enabled && value.baseUrl === '' && value.model === '' : true,
  'Custom configuration must be complete, or an empty disabled slot');
export type CustomImageConfiguration = z.infer<typeof customImageConfigurationSchema>;
export function isCompleteCustomImageConfiguration(value: unknown): boolean {
  const parsed = customImageConfigurationSchema.safeParse(value);
  return parsed.success && parsed.data.baseUrl !== '' && parsed.data.model !== '';
}
export const customImageSettingsUpdateSchema = z.object({expectedRevision: revision, configuration: customImageConfigurationSchema, secret}).strict();
export const customImageSettingsResultSchema = z.object({revision, configuration: customImageConfigurationSchema,
  secret: z.object({configured: z.boolean(), storage: z.enum(['none', 'session', 'persistent'])}).strict()
    .refine(value => value.configured === (value.storage !== 'none'), 'Inconsistent credential state'), storage: storageSchema}).strict()
  .refine(value => !value.secret.configured || isCompleteCustomImageConfiguration(value.configuration), 'Incomplete custom slot cannot own a credential');
export type CustomImageSettingsResult = z.infer<typeof customImageSettingsResultSchema>;
export function isCustomImageSettingsResult(value: unknown): value is CustomImageSettingsResult { return customImageSettingsResultSchema.safeParse(value).success; }
