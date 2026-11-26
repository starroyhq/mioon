import {z} from 'zod';
import {AppError} from './app-error.ts';
import {compileClipTimeMap, MAX_CLIP_SOURCE_SPAN_FRAMES} from './timeline-clip-timing.ts';
import {clipTimingSchema, type ClipTiming} from './timeline-speed.ts';
import {projectTimeMapToCurrentClipFields, type CompiledTimeMap} from './timeline-time-map.ts';

export const TIMELINE_SPEED_EXPORT_PROFILE = 'timeline-speed-export-v1';
export const SPEED_PROCESSING_NOT_READY = 'SPEED_PROCESSING_NOT_READY';
export const SPEED_INTERPOLATION_NOT_READY = 'SPEED_INTERPOLATION_NOT_READY';
export const SPEED_CAPABILITY_UNAVAILABLE = 'SPEED_CAPABILITY_UNAVAILABLE';
export const SPEED_BUDGET_EXCEEDED = 'SPEED_BUDGET_EXCEEDED';
export const SPEED_MAPPING_INVALID = 'SPEED_MAPPING_INVALID';
export const SPEED_SOURCE_UNSUPPORTED = 'SPEED_SOURCE_UNSUPPORTED';

export const TIMELINE_SPEED_EXPORT_MESSAGES = Object.freeze({
  [SPEED_PROCESSING_NOT_READY]: 'Wait for the reverse clip to finish processing before exporting.',
  [SPEED_INTERPOLATION_NOT_READY]: 'This export cannot use the selected frame interpolation.',
  [SPEED_CAPABILITY_UNAVAILABLE]: 'The selected media tools cannot prepare this retimed clip.',
  [SPEED_BUDGET_EXCEEDED]: 'There is not enough working space to prepare this retimed clip.',
  [SPEED_MAPPING_INVALID]: 'The clip’s saved speed settings cannot be verified.',
  [SPEED_SOURCE_UNSUPPORTED]: 'This source format cannot be retimed for export.',
});

export type TimelineSpeedExportReason = keyof typeof TIMELINE_SPEED_EXPORT_MESSAGES;
export function isTimelineSpeedExportReason(value: unknown): value is TimelineSpeedExportReason {
  return typeof value === 'string' && Object.hasOwn(TIMELINE_SPEED_EXPORT_MESSAGES, value);
}

const id = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const maxClips = 100;
const proxySchema = z.object({taskId: id, sha256}).strict();
const clipSchema = z.object({clipId: id, mapHash: z.string().regex(/^[a-f0-9]{16}$/u), proxy: proxySchema.optional()})
  .strict().refine(value => !Object.hasOwn(value, 'proxy') || value.proxy !== undefined);
export const timelineSpeedExportSnapshotSchema = z.object({profileId: z.literal(TIMELINE_SPEED_EXPORT_PROFILE),
  clips: z.array(clipSchema).min(1).max(maxClips)}).strict();
export type TimelineSpeedExportSnapshot = z.infer<typeof timelineSpeedExportSnapshotSchema>;
export type TimelineSpeedExportProxy = z.infer<typeof proxySchema>;
export interface CompiledTimelineSpeedExportClip {
  readonly clipId: string;
  readonly assetId: string;
  readonly timing: ClipTiming;
  readonly plan: CompiledTimeMap;
  readonly mapHash: string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const timed = (value: unknown): value is Record<string, unknown> => object(value) &&
  (Object.hasOwn(value, 'timing') || Object.hasOwn(value, 'sourceSpanFrames'));
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const uuid = (value: unknown): value is string => typeof value === 'string' && id.safeParse(value).success;

function invalid(clipId?: string): never {
  throw new AppError(SPEED_MAPPING_INVALID, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_MAPPING_INVALID], 409,
    clipId === undefined ? undefined : {clipId});
}

/** Compile only projected, explicitly timed clips on the shared project clock. */
export function compileTimelineSpeedExportClips(timeline: unknown): readonly CompiledTimelineSpeedExportClip[] {
  if (!object(timeline) || timeline.fps !== 30 || !Array.isArray(timeline.clips) || timeline.clips.length > maxClips) invalid();
  const seen = new Set<string>(), result: CompiledTimelineSpeedExportClip[] = [];
  for (const clip of timeline.clips as unknown[]) {
    if (!timed(clip)) continue;
    const {id: clipId, assetId, startFrame, durationFrames, sourceInFrame, sourceSpanFrames} = clip;
    const timing = clipTimingSchema.safeParse(clip.timing);
    if (!uuid(clipId) || seen.has(clipId) || !uuid(assetId) || !timing.success || !integer(startFrame, 0, 18000) ||
        !integer(durationFrames, 1, 18000 - startFrame) || !integer(sourceInFrame, 0, Number.MAX_SAFE_INTEGER - 18000) ||
        !integer(sourceSpanFrames, 1, MAX_CLIP_SOURCE_SPAN_FRAMES)) invalid(uuid(clipId) ? clipId : undefined);
    if (timing.data.profile === 'timeline-freeze-v1' && (clip.muted !== true || timing.data.sourceVersionId !== (clip.versionId ?? null))) invalid(clipId);
    const source = {id: clipId, startFrame, durationFrames, sourceInFrame, timing: timing.data};
    const compiled = compileClipTimeMap(source, {fps: timeline.fps});
    if (!compiled.ok) invalid(clipId);
    const plan = compiled.value;
    const projected = projectTimeMapToCurrentClipFields(source, plan);
    if (!projected.ok || projected.value.sourceInFrame !== sourceInFrame || projected.value.durationFrames !== durationFrames ||
        projected.value.sourceSpanFrames !== sourceSpanFrames) invalid(clipId);
    seen.add(clipId);
    result.push({clipId, assetId, timing: timing.data, plan, mapHash: plan.root.mapHash});
  }
  return result;
}

/** Project the frozen clip bindings. The backend supplies any reverse proxy
 * digests from its admitted processing records. */
export function timelineSpeedExportSnapshotFields(timeline: unknown, proxies: ReadonlyMap<string, TimelineSpeedExportProxy> = new Map()):
  {speedExport?: TimelineSpeedExportSnapshot} {
  const compiled = compileTimelineSpeedExportClips(timeline);
  const clips: TimelineSpeedExportSnapshot['clips'] = [];
  let proxyCount = 0;
  for (const {clipId, mapHash, plan} of compiled) {
    if (!proxies.has(clipId)) {clips.push({clipId, mapHash}); continue;}
    const proxy = proxySchema.safeParse(proxies.get(clipId));
    if (plan.direction !== 'reverse' || !proxy.success) invalid(clipId);
    clips.push({clipId, mapHash, proxy: proxy.data});
    proxyCount++;
  }
  if (proxyCount !== proxies.size) invalid();
  return clips.length ? {speedExport: {profileId: TIMELINE_SPEED_EXPORT_PROFILE, clips}} : {};
}

/** Historical snapshots omit this profile entirely. The compiled map and the
 * frozen clip timing are matched here, while the store verifies proxy bytes. */
export function isTimelineSpeedExportSnapshot(snapshot: unknown, options: {purpose?: unknown} = {}): boolean {
  if (!object(snapshot)) return false;
  const {timeline, speedExport} = snapshot;
  const clips = object(timeline) && Array.isArray(timeline.clips) ? timeline.clips as unknown[] : [];
  if (clips.length > maxClips) return false;
  if (!Object.hasOwn(snapshot, 'speedExport')) return !clips.some(timed);
  if (Object.hasOwn(options, 'purpose') && options.purpose !== 'export') return false;
  if (!object(speedExport) || !Array.isArray(speedExport.clips) || speedExport.clips.length > maxClips ||
      !Array.isArray(snapshot.assets) || snapshot.assets.length > maxClips) return false;
  const parsed = timelineSpeedExportSnapshotSchema.safeParse(speedExport);
  if (!parsed.success) return false;
  try {
    const compiled = compileTimelineSpeedExportClips(timeline);
    if (compiled.length !== parsed.data.clips.length) return false;
    const assets = new Map<string, Record<string, unknown>>();
    for (const asset of snapshot.assets as unknown[]) {
      if (!object(asset) || !uuid(asset.id) || assets.has(asset.id)) return false;
      assets.set(asset.id, asset);
    }
    return compiled.every(({clipId, assetId, mapHash, plan, timing}, index) => {
      const frozen = parsed.data.clips[index]!;
      const asset = assets.get(assetId);
      if (!asset || !sha256.safeParse(asset.sha256).success || typeof asset.mimeType !== 'string' ||
          (!asset.mimeType.startsWith('video/') && !asset.mimeType.startsWith('audio/')) ||
          frozen.clipId !== clipId || frozen.mapHash !== mapHash || frozen.proxy !== undefined && plan.direction !== 'reverse') return false;
      return timing.profile !== 'timeline-freeze-v1' || asset.mimeType.startsWith('video/') && asset.sha256 === timing.sourceSha256;
    });
  } catch {return false;}
}
