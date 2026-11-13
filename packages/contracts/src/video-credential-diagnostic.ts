import {z} from 'zod';

const automatic = z.enum([
  'VIDEO_SETTINGS_CONFLICT', 'VIDEO_SETTINGS_CLOSED', 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE', 'VIDEO_CREDENTIAL_UNAVAILABLE',
]);
const userAction = z.enum([
  'VIDEO_SETTINGS_SAVE_FAILED', 'VIDEO_SETTINGS_CORRUPT', 'VIDEO_SETTINGS_NOT_CONFIGURED', 'VIDEO_SETTINGS_DELETED',
  'VIDEO_SETTINGS_UNAVAILABLE', 'VIDEO_BINDING_INVALID',
]);

// Never persist arbitrary exception messages, provider payloads, or key material.
export const videoCredentialDiagnosticSchema = z.discriminatedUnion('recovery', [
  z.object({kind: z.literal('video_credential'), cause: automatic, recovery: z.literal('automatic')}).strict(),
  z.object({kind: z.literal('video_credential'), cause: userAction, recovery: z.literal('user_action')}).strict(),
]);
export type VideoCredentialDiagnostic = z.infer<typeof videoCredentialDiagnosticSchema>;

export function videoCredentialDiagnosticForCode(code: unknown): VideoCredentialDiagnostic | undefined {
  const transient = automatic.safeParse(code);
  if (transient.success) return {kind: 'video_credential', cause: transient.data, recovery: 'automatic'};
  const blocked = userAction.safeParse(code);
  if (blocked.success) return {kind: 'video_credential', cause: blocked.data, recovery: 'user_action'};
}
