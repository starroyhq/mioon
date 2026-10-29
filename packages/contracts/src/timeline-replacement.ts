import {isVolumeEnvelope} from './timeline-volume-envelope-processing.ts';
import {isClipAudioRole} from './timeline-audio-role.ts';
import {isTimelineClipColour} from './timeline-colour.ts';
import {isTimelineSubtitles} from './timeline-subtitles.ts';
import {timelineOutputPreset} from './timeline-format.ts';
import {isClipTransform} from './timeline-clip-transform.ts';
import {isClipTransition} from './timeline-clip-transition.ts';
// Saved timeline acknowledgements are complete records, never patches. These
// guards do not normalize records or claim a historical response is current.
// Project-owned media/version lineage remains the backend's responsibility.
export interface TimelineRect {x: number; y: number; width: number; height: number}
export interface TimelineTrackRecord {id: string; name: string; kind: 'video' | 'audio'; orderIndex: number; hidden: boolean; muted: boolean; [key: string]: unknown}
export interface TimelineClipRecord {
  id: string; trackId: string; assetId: string; name: string;
  startFrame: number; durationFrames: number; sourceInFrame: number;
  rect: TimelineRect; gain: number;
  fadeInFrames?: number; fadeOutFrames?: number; colour?: unknown; audioRole?: unknown; volumeEnvelope?: unknown; transform?: unknown; transitionIn?: unknown;
  versionId?: string; shotId?: string; jobId?: string;
  [key: string]: unknown;
}
export interface TimelineRecord {
  id: string; projectId: string; revision: number; fps: number; width: number; height: number;
  tracks: TimelineTrackRecord[]; clips: TimelineClipRecord[]; durationFrames: number;
  createdAt: string; updatedAt: string; subtitles?: unknown;
  [key: string]: unknown;
}
export interface TimelineRecordOptions {projectId?: unknown}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max;
const fields = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const timestamp = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));
const provenance = ['versionId', 'shotId', 'jobId'];
// The complete legacy shape may exceed 128 KiB when valid names need JSON
// escaping. 256 KiB bounds 100 clips (<2 KiB each), 12 tracks (<2 KiB each),
// 100 manual subtitle cues, and aggregate metadata. Source replacement shares
// the same aggregate budget; model inspection keeps its separate result cap.
export const TIMELINE_RESPONSE_BYTES = 256 * 1024;
export const TIMELINE_REPLACEMENT_RESPONSE_BYTES = TIMELINE_RESPONSE_BYTES;
const encoder = new TextEncoder();
const timelineFields = ['id', 'projectId', 'revision', 'fps', 'width', 'height', 'tracks', 'clips', 'durationFrames', 'createdAt', 'updatedAt'];
const trackFields = ['id', 'name', 'kind', 'orderIndex', 'hidden', 'muted'];
const clipFields = ['id', 'trackId', 'assetId', 'name', 'startFrame', 'durationFrames', 'sourceInFrame', 'rect', 'gain'];

export function isTimelineRecord(value: unknown, {projectId}: TimelineRecordOptions = {}): value is TimelineRecord {
  if (!fields(value, timelineFields, ['subtitles']) || !uuid(value.id) || !uuid(value.projectId) ||
      (projectId !== undefined && value.projectId !== projectId) || !integer(value.revision, 1, Number.MAX_SAFE_INTEGER) ||
      !timelineOutputPreset(value) ||
      !integer(value.durationFrames, 0, 18000) || !timestamp(value.createdAt) || !timestamp(value.updatedAt) ||
      !Array.isArray(value.tracks) || value.tracks.length < 1 || value.tracks.length > 12 ||
      !Array.isArray(value.clips) || value.clips.length > 100) return false;
  const width = value.width as number, height = value.height as number;
  const tracks = new Map<string, TimelineClipRecord[]>(), trackKinds = new Map<string, 'video' | 'audio'>(), ids = new Set<string>();
  for (const track of value.tracks as unknown[]) {
    if (!fields(track, trackFields) || !uuid(track.id) || tracks.has(track.id) || !text(track.name, 150) ||
        typeof track.kind !== 'string' || !['video', 'audio'].includes(track.kind) || !integer(track.orderIndex, 0, 11) ||
        typeof track.hidden !== 'boolean' || typeof track.muted !== 'boolean' || track.kind === 'audio' && track.hidden) return false;
    tracks.set(track.id, []); trackKinds.set(track.id, track.kind as 'video' | 'audio');
  }
  let duration = 0;
  for (const clip of value.clips as unknown[]) {
    if (!fields(clip, clipFields, [...provenance, 'fadeInFrames', 'fadeOutFrames', 'colour', 'audioRole', 'volumeEnvelope', 'transform', 'transitionIn']) ||
        !uuid(clip.id) || ids.has(clip.id) || !uuid(clip.trackId) || !tracks.has(clip.trackId) || !uuid(clip.assetId) || !text(clip.name, 200) ||
        !integer(clip.startFrame, 0, 18000) || !integer(clip.durationFrames, 1, 18000) ||
        clip.startFrame + clip.durationFrames > 18000 || !integer(clip.sourceInFrame, 0, Number.MAX_SAFE_INTEGER - 18000) ||
        !Number.isFinite(clip.gain) || (clip.gain as number) < 0 || (clip.gain as number) > 2 ||
        Object.hasOwn(clip, 'audioRole') && !isClipAudioRole(clip.audioRole) ||
        Object.hasOwn(clip, 'volumeEnvelope') && !isVolumeEnvelope(clip.volumeEnvelope,clip.durationFrames) ||
        // A cleared transform is removed, never saved as null; only visual tracks place content.
        Object.hasOwn(clip, 'transform') && (clip.transform === null || !isClipTransform(clip.transform, clip.durationFrames) || trackKinds.get(clip.trackId) !== 'video') ||
        Object.hasOwn(clip, 'transitionIn') && (clip.transitionIn === null || !isClipTransition(clip.transitionIn) || trackKinds.get(clip.trackId) !== 'video') ||
        provenance.some(key => Object.hasOwn(clip, key) && !uuid(clip[key])) ||
        Object.hasOwn(clip, 'colour') && (!isTimelineClipColour(clip.colour) || clip.colour !== null && trackKinds.get(clip.trackId) !== 'video')) return false;
    const rect = clip.rect as Record<string, unknown>;
    if (!fields(rect, ['x', 'y', 'width', 'height']) || !integer(rect.x, 0, width-2) || !integer(rect.y, 0, height-2) ||
        !integer(rect.width, 2, width) || !integer(rect.height, 2, height) ||
        [rect.x, rect.y, rect.width, rect.height].some(item => (item as number) % 2) || rect.x + rect.width > width || rect.y + rect.height > height) return false;
    for (const field of ['fadeInFrames', 'fadeOutFrames']) if (Object.hasOwn(clip, field) && !integer(clip[field], 0, clip.durationFrames)) return false;
    if ((clip.fadeInFrames as number | undefined ?? 0) + (clip.fadeOutFrames as number | undefined ?? 0) > clip.durationFrames) return false;
    ids.add(clip.id); tracks.get(clip.trackId)!.push(clip as TimelineClipRecord);
    duration = Math.max(duration, clip.startFrame + clip.durationFrames);
  }
  for (const clips of tracks.values()) {
    clips.sort((a, b) => a.startFrame - b.startFrame);
    for (let i = 1; i < clips.length; i++) if (clips[i].startFrame < clips[i - 1].startFrame + clips[i - 1].durationFrames) return false;
  }
  if (duration !== value.durationFrames || Object.hasOwn(value, 'subtitles') && !isTimelineSubtitles(value.subtitles, duration)) return false;
  // Structural caps bound serialization before checking the retained row cap.
  return encoder.encode(JSON.stringify(value)).byteLength <= TIMELINE_RESPONSE_BYTES;
}

export function isTimelineReplacementResponse(value: unknown, input: unknown): boolean {
  if (!object(input) || !text(input.requestId, 200) || input.requestId.length < 8 || !uuid(input.projectId) || !uuid(input.clipId) || !uuid(input.assetId) ||
      !integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) ||
      (input.versionId !== undefined && !uuid(input.versionId)) ||
      !isTimelineRecord(value, {projectId: input.projectId}) || value.revision !== input.expectedRevision + 1 ||
      encoder.encode(JSON.stringify(value)).byteLength > TIMELINE_REPLACEMENT_RESPONSE_BYTES) return false;
  const target = value.clips.find(clip => clip.id === input.clipId);
  if (!target || target.assetId !== input.assetId || Object.hasOwn(target, 'jobId') || target.colour != null && (target.colour as {source?: unknown}).source !== null) return false;
  if (input.versionId === undefined) return provenance.every(key => !Object.hasOwn(target, key));
  return target.versionId === input.versionId && uuid(target.shotId);
}
