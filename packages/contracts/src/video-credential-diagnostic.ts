import {z} from 'zod';

const automatic = z.enum([
  'VIDEO_SETTINGS_CONFLICT', 'VIDEO_SETTINGS_CLOSED', 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE',
]);
const userAction = z.enum([
  'VIDEO_SETTINGS_SAVE_FAILED', 'VIDEO_SETTINGS_CORRUPT', 'VIDEO_SETTINGS_NOT_CONFIGURED', 'VIDEO_SETTINGS_DELETED',
  'VIDEO_SETTINGS_UNAVAILABLE', 'VIDEO_BINDING_INVALID', 'VIDEO_CREDENTIAL_UNAVAILABLE', 'VIDEO_CREDENTIAL_INVALID',
]);

// Never persist arbitrary exception messages, provider payloads, or key material.
const currentDiagnostic = z.discriminatedUnion('recovery', [
  z.object({kind: z.literal('video_credential'), cause: automatic, recovery: z.literal('automatic')}).strict(),
  z.object({kind: z.literal('video_credential'), cause: userAction, recovery: z.literal('user_action')}).strict(),
]);
const legacyUnavailable = z.object({
  kind: z.literal('video_credential'),
  cause: z.literal('VIDEO_CREDENTIAL_UNAVAILABLE'),
  recovery: z.literal('automatic'),
}).strict().transform(value => ({...value, recovery: 'user_action' as const}));
export const videoCredentialDiagnosticSchema = z.union([currentDiagnostic, legacyUnavailable]);
export type VideoCredentialDiagnostic = z.infer<typeof videoCredentialDiagnosticSchema>;

export function videoCredentialDiagnosticForCode(code: unknown): VideoCredentialDiagnostic | undefined {
  const transient = automatic.safeParse(code);
  if (transient.success) return {kind: 'video_credential', cause: transient.data, recovery: 'automatic'};
  const blocked = userAction.safeParse(code);
  if (blocked.success) return {kind: 'video_credential', cause: blocked.data, recovery: 'user_action'};
}
