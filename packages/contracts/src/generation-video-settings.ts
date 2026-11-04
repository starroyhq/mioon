import {z} from 'zod';
import {VIDEO_PROVIDER_NAMES, VIDEO_SETTINGS_LIMITS, videoConnectionConfigurationSchema, videoSecretUpdateSchema} from './video-providers.ts';
import type {VideoStorage} from './video-providers.ts';

export const VIDEO_BUILTIN_PROVIDER_IDS = ['ark', 'veo', 'minimax', 'vidu', 'kling', 'wan'] as const;
export const VIDEO_SETTINGS_V2_PROVIDER_IDS = [...VIDEO_BUILTIN_PROVIDER_IDS, 'compatible'] as const;
export const VIDEO_SETTINGS_V1_RESET_NOTICE = 'VIDEO_SETTINGS_V1_RESET' as const;

// Reuse the implemented protocol/capability validation. Connection archiving is
// absent from v2; model archiving and the frozen execution protocol are unchanged.
export const videoConnectionConfigurationV2Schema = videoConnectionConfigurationSchema.innerType().omit({archived: true}).extend({
  providerId: z.enum(VIDEO_SETTINGS_V2_PROVIDER_IDS),
}).strict().superRefine((configuration, context) => {
  const implemented = videoConnectionConfigurationSchema.safeParse({...configuration, archived: false});
  if (!implemented.success) for (const issue of implemented.error.issues) context.addIssue(issue);
  if (configuration.providerId !== 'compatible' && configuration.name !== VIDEO_PROVIDER_NAMES[configuration.providerId]) {
    context.addIssue({code: 'custom', path: ['name'], message: 'Built-in services use their fixed display name.'});
  }
});
export type VideoConnectionConfigurationV2 = z.infer<typeof videoConnectionConfigurationV2Schema>;

const save = z.object({action: z.literal('save'), configuration: videoConnectionConfigurationV2Schema, secret: videoSecretUpdateSchema}).strict();
const remove = z.object({action: z.literal('delete'), connectionId: z.string().uuid()}).strict();
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

export interface VideoConnectionViewV2 {
  configuration: VideoConnectionConfigurationV2;
  revision: number;
  secret: {configured: boolean; storage: 'none' | 'session' | 'persistent'};
}
export interface VideoSettingsSnapshotV2 {
  revision: number;
  connections: VideoConnectionViewV2[];
  storage: VideoStorage;
  /** Repeated reads do not consume this notice; the first successful explicit write clears it. */
  notice: typeof VIDEO_SETTINGS_V1_RESET_NOTICE | null;
}
