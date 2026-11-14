import {z} from 'zod';
import {COMPATIBLE_VIDEO_CHECK_RESULTS, VIDEO_PROVIDER_NAMES, VIDEO_SETTINGS_LIMITS, compatibleVideoCheckSchema, normalizeCompatibleVideoBaseUrl, videoConnectionConfigurationSchema, videoConnectionEndpoint, videoExecutionBindingSchema, videoModelEntrySchema, videoSecretUpdateSchema} from './video-providers.ts';

export const VIDEO_BUILTIN_PROVIDER_IDS = ['ark', 'veo', 'minimax', 'vidu', 'kling', 'wan'] as const;
export const VIDEO_SETTINGS_V2_PROVIDER_IDS = [...VIDEO_BUILTIN_PROVIDER_IDS, 'compatible'] as const;
export const VIDEO_SETTINGS_V1_RESET_NOTICE = 'VIDEO_SETTINGS_V1_RESET' as const;
export const videoSettingsUuidV2Schema = z.string().uuid().regex(/^[0-9a-f-]+$/, 'A v2 identity must be a lowercase UUID.');
export const videoModelEntryV2Schema = videoModelEntrySchema.extend({id: videoSettingsUuidV2Schema});

// Reuse the implemented protocol/capability validation. Connection archiving is
// absent from v2; model archiving and the frozen execution protocol are unchanged.
export const videoConnectionConfigurationV2Schema = videoConnectionConfigurationSchema.innerType().omit({archived: true}).extend({
  id: videoSettingsUuidV2Schema,
  providerId: z.enum(VIDEO_SETTINGS_V2_PROVIDER_IDS),
  models: z.array(videoModelEntryV2Schema).max(VIDEO_SETTINGS_LIMITS.models),
}).strict().superRefine((configuration, context) => {
  const implemented = videoConnectionConfigurationSchema.safeParse({...configuration, archived: false});
  if (!implemented.success) for (const issue of implemented.error.issues) context.addIssue(issue);
  if (configuration.providerId !== 'compatible' && configuration.name !== VIDEO_PROVIDER_NAMES[configuration.providerId]) {
    context.addIssue({code: 'custom', path: ['name'], message: 'Built-in services use their fixed display name.'});
  }
});
export type VideoConnectionConfigurationV2 = z.infer<typeof videoConnectionConfigurationV2Schema>;

const save = z.object({action: z.literal('save'), configuration: videoConnectionConfigurationV2Schema, secret: videoSecretUpdateSchema}).strict();
const remove = z.object({action: z.literal('delete'), connectionId: videoSettingsUuidV2Schema}).strict();
export const videoSettingsOperationV2Schema = z.discriminatedUnion('action', [save, remove]);
const expectedRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const videoSettingsUpdateV2Schema = z.discriminatedUnion('action', [
  save.extend({expectedRevision}), remove.extend({expectedRevision}),
  z.object({action: z.literal('batch'), expectedRevision, operations: z.array(videoSettingsOperationV2Schema).min(1).max(VIDEO_SETTINGS_LIMITS.connections)}).strict(),
]).superRefine((update, context) => {
  const operations = update.action === 'batch' ? update.operations : [update];
  const identities = operations.map(operation => operation.action === 'save' ? operation.configuration.id : operation.connectionId);
  if (new Set(identities).size !== identities.length) context.addIssue({code: 'custom', message: 'A batch must change each connection at most once.'});
});
export type VideoSettingsOperationV2 = z.infer<typeof videoSettingsOperationV2Schema>;
export type VideoSettingsUpdateV2 = z.infer<typeof videoSettingsUpdateV2Schema>;

export const videoStorageV2Schema = z.object({
  persistentAvailable: z.boolean(), sessionScope: z.enum(['app', 'server']),
  reasonCode: z.enum(['WEB_SESSION_ONLY', 'OS_SECRET_STORE_UNAVAILABLE', 'OS_SECRET_STORE_PENDING', 'LINUX_BASIC_TEXT']).nullable(),
}).strict().superRefine((storage, context) => {
  if (storage.persistentAvailable !== (storage.reasonCode === null)) context.addIssue({code: 'custom', message: 'Storage availability and reason must agree.'});
});
export type VideoStorageV2 = z.infer<typeof videoStorageV2Schema>;
export const videoConnectionViewV2Schema = z.object({
  configuration: videoConnectionConfigurationV2Schema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  secret: z.object({configured: z.boolean(), storage: z.enum(['none', 'session', 'persistent'])}).strict(),
}).strict().superRefine((view, context) => {
  if (view.secret.configured !== (view.secret.storage !== 'none')) context.addIssue({code: 'custom', path: ['secret'], message: 'Secret availability and storage must agree.'});
});
export const videoSettingsSnapshotV2Schema = z.object({
  revision: expectedRevision,
  connections: z.array(videoConnectionViewV2Schema).max(VIDEO_SETTINGS_LIMITS.connections),
  storage: videoStorageV2Schema,
  /** Reads do not consume this notice; the first successful explicit save clears it. */
  notice: z.literal(VIDEO_SETTINGS_V1_RESET_NOTICE).nullable(),
}).strict().superRefine((snapshot, context) => {
  const ids = snapshot.connections.map(view => view.configuration.id);
  const builtins = snapshot.connections.filter(view => view.configuration.providerId !== 'compatible').map(view => view.configuration.providerId);
  if (new Set(ids).size !== ids.length || new Set(builtins).size !== builtins.length || snapshot.connections.some(view => view.revision > snapshot.revision)) context.addIssue({code: 'custom', path: ['connections'], message: 'Invalid connection identities or revisions.'});
});
export type VideoConnectionViewV2 = z.infer<typeof videoConnectionViewV2Schema>;
export type VideoSettingsSnapshotV2 = z.infer<typeof videoSettingsSnapshotV2Schema>;

/** The frozen wire format is still v1. Only the v2 settings boundary requires
 * lowercase identities; legacy binding readers and tool schemas are unchanged. */
export const videoExecutionBindingV2Schema = videoExecutionBindingSchema.extend({connectionId: videoSettingsUuidV2Schema, credentialRef: videoSettingsUuidV2Schema, model: videoModelEntryV2Schema});
export const videoSettingsSelectionV2Schema = z.object({connectionId: videoSettingsUuidV2Schema, configurationRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), modelEntryId: videoSettingsUuidV2Schema}).strict();
export const compatibleVideoCheckV2Schema = z.discriminatedUnion('source', [
  compatibleVideoCheckSchema.options[0],
  compatibleVideoCheckSchema.options[1].extend({connectionId: videoSettingsUuidV2Schema, configurationRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}),
]);
export const compatibleVideoCheckResultV2Schema = z.object({result: z.enum(COMPATIBLE_VIDEO_CHECK_RESULTS), httpStatus: z.number().int().min(100).max(599).optional()}).strict();


const videoModelsListTarget = z.object({
  operation: z.enum(['check', 'models']),
  providerId: z.enum(VIDEO_SETTINGS_V2_PROVIDER_IDS),
  region: z.string().min(1).max(40),
  workspaceId: z.string().regex(/^[A-Za-z0-9_-]{0,80}$/u),
  baseUrl: z.string().min(1).max(2048).optional(),
}).strict();

export const videoModelsListInputSchema = z.discriminatedUnion('source', [
  videoModelsListTarget.extend({source: z.literal('draft'), value: compatibleVideoCheckSchema.options[0].shape.value}),
  videoModelsListTarget.extend({
    source: z.literal('saved'), connectionId: videoSettingsUuidV2Schema,
    configurationRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
]).superRefine((input, context) => {
  try {videoModelsListEndpoint(input);}
  catch {context.addIssue({code: 'custom', path: ['baseUrl'], message: 'Invalid video service destination.'});}
});
export type VideoModelsListInput = z.infer<typeof videoModelsListInputSchema>;
export type VideoModelsListRecipient = Pick<VideoModelsListInput, 'providerId' | 'region' | 'workspaceId' | 'baseUrl'>;

export function videoModelsListEndpoint(recipient: VideoModelsListRecipient): string {
  if (recipient.providerId === 'compatible') {
    return videoConnectionEndpoint({...recipient, baseUrl: normalizeCompatibleVideoBaseUrl(recipient.baseUrl)});
  }
  if (recipient.baseUrl !== undefined) throw new TypeError('Built-in services use their fixed endpoint.');
  return videoConnectionEndpoint(recipient);
}
