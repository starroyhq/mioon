import {z} from 'zod';
import {IMAGE_FIXED_OPTIONS, imageOptionsSchema} from './images.ts';
import {CUSTOM_IMAGE_PROFILE_ID} from './image-settings.ts';
import {customImageBaseUrlSchema, customImageModelSchema} from './image-compatible.ts';

// Standalone settings declarations. These are intentionally absent from the
// operation catalog until the explicit-connection generation lane is wired.
export const CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE = 'mioon.images.openai-compatible.v2';
export const CUSTOM_IMAGE_SETTINGS_V2_NOTICE = 'LEGACY_CUSTOM_IMAGE_SETTINGS_RESET';
export const CUSTOM_IMAGE_SETTINGS_V2_LIMITS = Object.freeze({connections: 10, connectionIds: 4096,
  envelopeBytes: 640 * 1024, updateBytes: 128 * 1024, secretBytes: 4096, ciphertextCharacters: 48 * 1024});
export const DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2 = Object.freeze({enabled: false, providerId: 'openai-compatible',
  profileId: CUSTOM_IMAGE_PROFILE_ID, baseUrl: '', model: '', options: IMAGE_FIXED_OPTIONS});
export const customImageConnectionIdV2Schema = z.string().uuid().regex(/^[0-9a-f-]{36}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveRevision = revision.min(1);
const name = z.string().min(1).max(120).refine(value => value.trim() === value &&
  !/[\x00-\x1f\x7f]/.test(value), 'Invalid connection name');
export const customImageConfigurationV2Schema = z.object({enabled: z.boolean(), providerId: z.literal('openai-compatible'),
  profileId: z.literal(CUSTOM_IMAGE_PROFILE_ID), baseUrl: z.union([z.literal(''), customImageBaseUrlSchema]),
  model: z.union([z.literal(''), customImageModelSchema]), options: imageOptionsSchema}).strict().refine(value =>
  value.baseUrl === '' || value.model === '' ? !value.enabled && value.baseUrl === '' && value.model === '' : true,
  'Custom configuration must be complete, or empty and disabled');
export type CustomImageConfigurationV2 = z.infer<typeof customImageConfigurationV2Schema>;
export function isCompleteCustomImageConfigurationV2(value: CustomImageConfigurationV2): boolean {
  return value.baseUrl !== '' && value.model !== '';
}
export const customImageSecretUpdateV2Schema = z.discriminatedUnion('action', [
  z.object({action: z.literal('keep')}).strict(), z.object({action: z.literal('remove')}).strict(),
  z.object({action: z.literal('replace'), storage: z.enum(['session', 'persistent']),
    value: z.string().min(1).max(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.secretBytes).regex(/^[\x21-\x7e]+$/)}).strict(),
]);
export const customImageStorageV2Schema = z.object({persistentAvailable: z.boolean(), sessionScope: z.enum(['app', 'server']),
  reasonCode: z.enum(['WEB_SESSION_ONLY', 'OS_SECRET_STORE_UNAVAILABLE', 'LINUX_BASIC_TEXT']).nullable()}).strict()
  .refine(value => value.persistentAvailable === (value.reasonCode === null), 'Inconsistent storage capabilities');
const secretState = z.object({configured: z.boolean(), storage: z.enum(['none', 'session', 'persistent'])}).strict()
  .refine(value => value.configured === (value.storage !== 'none'), 'Inconsistent credential state');
export const customImageConnectionV2Schema = z.object({connectionId: customImageConnectionIdV2Schema, name,
  configurationRevision: positiveRevision, configuration: customImageConfigurationV2Schema, secret: secretState}).strict()
  .refine(value => !value.secret.configured || isCompleteCustomImageConfigurationV2(value.configuration),
    'Incomplete connection cannot own a credential');
export const customImageSettingsV2ResultSchema = z.object({revision,
  connections: z.array(customImageConnectionV2Schema).max(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.connections),
  storage: customImageStorageV2Schema, notice: z.literal(CUSTOM_IMAGE_SETTINGS_V2_NOTICE).nullable()}).strict()
  .refine(value => new Set(value.connections.map(item => item.connectionId)).size === value.connections.length,
    'Duplicate connection identity')
  .refine(value => value.connections.every(item => item.configurationRevision <= value.revision), 'Invalid configuration revision');
export type CustomImageConnectionV2 = z.infer<typeof customImageConnectionV2Schema>;
export type CustomImageSettingsV2Result = z.infer<typeof customImageSettingsV2ResultSchema>;
const write = {expectedRevision: revision, name, configuration: customImageConfigurationV2Schema, secret: customImageSecretUpdateV2Schema};
export const customImageCreateV2Schema = z.object({...write, connectionId: customImageConnectionIdV2Schema}).strict();
export const customImagePutV2Schema = z.object({...write, connectionId: customImageConnectionIdV2Schema,
  expectedConfigurationRevision: positiveRevision}).strict();
export const customImageRemoveV2Schema = z.object({expectedRevision: revision, connectionId: customImageConnectionIdV2Schema,
  expectedConfigurationRevision: positiveRevision}).strict();
export const customImageBatchV2Schema = z.object({expectedRevision: revision, operations: z.array(z.discriminatedUnion('action', [
  customImageCreateV2Schema.omit({expectedRevision: true}).extend({action: z.literal('create')}).strict(),
  customImagePutV2Schema.omit({expectedRevision: true}).extend({action: z.literal('put')}).strict(),
  customImageRemoveV2Schema.omit({expectedRevision: true}).extend({action: z.literal('remove')}).strict(),
])).min(1).max(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.connections * 2)}).strict().refine(value => {
  const ids = value.operations.map(item => item.connectionId);
  return new Set(ids).size === ids.length;
}, 'A connection may be changed only once in a batch');
export const customImageCredentialRequestV2Schema = z.object({connectionId: customImageConnectionIdV2Schema,
  configurationRevision: positiveRevision, configuration: customImageConfigurationV2Schema}).strict();
export type CustomImageCredentialRequestV2 = z.infer<typeof customImageCredentialRequestV2Schema>;

// Stored shapes remain separate from the renderer's redacted results. They are
// not registered as tools or exposed through the default contracts barrel.
export const customImageEncryptedV2Schema = z.string().min(1).max(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.ciphertextCharacters)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const customImageStoredConnectionV2Schema = z.object({connectionId: customImageConnectionIdV2Schema, name,
  configurationRevision: positiveRevision, configuration: customImageConfigurationV2Schema,
  secret: z.object({binding: z.string().max(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.updateBytes), encrypted: customImageEncryptedV2Schema}).strict().nullable()}).strict();
export const customImageSettingsV2EnvelopeSchema = z.object({version: z.literal(2), namespace: z.literal(CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE), revision,
  connections: z.array(customImageStoredConnectionV2Schema).max(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.connections),
  deletedConnectionIds: z.array(customImageConnectionIdV2Schema).max(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.connectionIds)}).strict()
  .refine(value => {const ids = [...value.connections.map(item => item.connectionId), ...value.deletedConnectionIds];
    return ids.length <= CUSTOM_IMAGE_SETTINGS_V2_LIMITS.connectionIds && new Set(ids).size === ids.length;}, 'Duplicate or excessive connection identity')
  .refine(value => value.connections.every(item => item.configurationRevision <= value.revision) &&
    (value.revision > 0 || value.deletedConnectionIds.length === 0), 'Invalid configuration or collection revision');
export const customImageSecretPlaintextV2Schema = z.object({version: z.literal(2), namespace: z.literal(CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE),
  connectionId: customImageConnectionIdV2Schema, binding: z.string().max(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.updateBytes),
  value: z.string().min(1).max(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.secretBytes).regex(/^[\x21-\x7e]+$/)}).strict();
