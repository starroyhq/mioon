import {z} from 'zod';

/** Editorial classification only: no stream evidence, routing or DSP semantics. */
export const TIMELINE_AUDIO_ROLE_PROFILE = 'mioon-clip-audio-role-v1' as const;
export const AUDIO_ROLES = Object.freeze(['human', 'music', 'sfx'] as const);
export const clipAudioRoleSchema = z.enum(AUDIO_ROLES).nullable();
export const timelineAudioRoleCapabilitySchema = z.object({profileId:z.literal(TIMELINE_AUDIO_ROLE_PROFILE),editable:z.boolean()}).strict();
export type TimelineAudioRoleCapability = z.infer<typeof timelineAudioRoleCapabilitySchema>;
export type ClipAudioRole = z.infer<typeof clipAudioRoleSchema>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function isClipAudioRole(value: unknown): value is ClipAudioRole {return value === null || AUDIO_ROLES.includes(value as typeof AUDIO_ROLES[number]);}
export function hasTimelineAudioRoles(timeline: unknown): boolean {
  return object(timeline) && Array.isArray(timeline.clips) && timeline.clips.some(clip => object(clip) && Object.hasOwn(clip, 'audioRole'));
}
export function timelineAudioRoleSnapshotFields(timeline: unknown): {audioRoleProfile?: typeof TIMELINE_AUDIO_ROLE_PROFILE} {
  return hasTimelineAudioRoles(timeline) ? {audioRoleProfile: TIMELINE_AUDIO_ROLE_PROFILE} : {};
}
export function getTimelineAudioRoleIssue(clip: unknown, asset: unknown): {code: string; message: string} | null {
  if (!object(clip) || !Object.hasOwn(clip, 'audioRole')) return null;
  if (!isClipAudioRole(clip.audioRole)) return {code: 'INVALID_AUDIO_ROLE', message: 'The clip audio role must be human, music, sfx or null.'};
  if (!object(asset) || !['audio/wav', 'audio/mpeg', 'audio/mp4', 'video/mp4', 'video/webm'].includes(String(asset.mimeType)))
    return {code: 'AUDIO_ROLE_CLIP_UNSUPPORTED', message: 'Audio roles classify audio or video clips, not still images.'};
  return null;
}
/** Legacy snapshots remain unchanged; explicit clears still carry this profile. */
export function isTimelineAudioRoleSnapshot(snapshot: unknown): boolean {
  if (!object(snapshot)) return false;
  const declared = Object.hasOwn(snapshot, 'audioRoleProfile'), roles = hasTimelineAudioRoles(snapshot.timeline);
  if (declared !== roles || declared && snapshot.audioRoleProfile !== TIMELINE_AUDIO_ROLE_PROFILE) return false;
  if (!roles) return true;
  if (!object(snapshot.timeline) || !Array.isArray(snapshot.timeline.clips) || !Array.isArray(snapshot.assets)) return false;
  for (const clip of snapshot.timeline.clips) {
    if (!object(clip)) return false;
    if (Object.hasOwn(clip, 'audioRole') && getTimelineAudioRoleIssue(clip, snapshot.assets.find(asset => object(asset) && asset.id === clip.assetId))) return false;
  }
  return true;
}
