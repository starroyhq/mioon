import {z} from 'zod';
import {LUT_RESOURCE_PROFILE} from './lut-resources.ts';

/** The declaration records user interpretation, not measured file evidence. */
export const TIMELINE_CLIP_COLOUR_PROFILE = 'mioon-rec709-sdr-clip-v1' as const;
export const TIMELINE_COLOUR_SOURCE_PROFILE = 'rec709-yuv-sdr-v1' as const;
export const TIMELINE_COLOUR_RENDER_PROFILE = 'mioon-rec709-sdr-render-v1' as const;
export const TIMELINE_COLOUR_SOURCE_INSPECT = 'timeline.colour.source.inspect' as const;

export const TIMELINE_COLOUR_PREFLIGHT_MESSAGES = Object.freeze({
  INVALID_TIMELINE_COLOUR: 'Confirm a supported SDR source interpretation for every visible video clip before rendering managed colour.',
  TIMELINE_COLOUR_SOURCE_UNSUPPORTED: 'The source has unsupported colour evidence. HDR, Log, non-Rec.709 and unsupported pixel formats are outside this SDR profile.',
  TIMELINE_COLOUR_SOURCE_MISMATCH: 'The saved source interpretation no longer matches the verified source. Inspect and confirm the current source again.',
  TIMELINE_COLOUR_RESOURCE_CHANGED: 'The saved creative LUT resource could not be verified against its frozen bytes, hash and profile.',
  TIMELINE_COLOUR_LUT_BUDGET: 'The saved creative looks exceed the bounded render staging budget. Reduce distinct looks or strengths.',
});
export const TIMELINE_COLOUR_PREFLIGHT_CODES = Object.freeze(Object.keys(TIMELINE_COLOUR_PREFLIGHT_MESSAGES)) as readonly (keyof typeof TIMELINE_COLOUR_PREFLIGHT_MESSAGES)[];

const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const streamIndex = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const timelineColourSourceSchema = z.object({
  assetSha256: hash, streamIndex, profileId: z.literal(TIMELINE_COLOUR_SOURCE_PROFILE),
  range: z.enum(['limited', 'full']), declaredBy: z.literal('user'), declaredAt: z.string().max(40).datetime(),
}).strict();
export const timelineColourLookSchema = z.object({
  resourceId: id, resourceSha256: hash, resourceProfile: z.literal(LUT_RESOURCE_PROFILE),
  purpose: z.literal('rec709-sdr-creative'), declaredBy: z.literal('user'),
  enabled: z.boolean(), strength: z.number().finite().min(0).max(1),
}).strict();
export const timelineClipColourSchema = z.object({
  profileId: z.literal(TIMELINE_CLIP_COLOUR_PROFILE), source: timelineColourSourceSchema.nullable(),
  look: timelineColourLookSchema.nullable(),
}).strict();
export const nullableTimelineClipColourSchema = timelineClipColourSchema.nullable();
export const clipColourSchema = nullableTimelineClipColourSchema;
export type ClipColour = z.infer<typeof clipColourSchema>;
export type TimelineClipColour = z.infer<typeof timelineClipColourSchema>;
export type TimelineColourSource = z.infer<typeof timelineColourSourceSchema>;
export type TimelineColourLook = z.infer<typeof timelineColourLookSchema>;
export function isTimelineClipColour(value: unknown): value is ClipColour | null {
  return nullableTimelineClipColourSchema.safeParse(value).success;
}

export const timelineColourPlanClipSchema = z.object({
  clipId: id, assetId: id, assetSha256: hash, streamIndex,
  range: z.enum(['limited', 'full']), look: timelineColourLookSchema.nullable(),
}).strict();
export const timelineColourPlanSchema = z.object({
  profileId: z.literal(TIMELINE_COLOUR_RENDER_PROFILE), working: z.literal('rec709-encoded-rgb8-v1'),
  output: z.literal('rec709-yuv420p-limited-v1'), lutAlgorithm: z.literal('cube3d-tetrahedral-premixed-v1'),
  outOfDomain: z.literal('clip-lut-domain'), clips: z.array(timelineColourPlanClipSchema).max(100),
}).strict().refine(value => new Set(value.clips.map(clip => clip.clipId)).size === value.clips.length,
  'Colour plan clip identities must be unique.');
export type TimelineColourPlan = z.infer<typeof timelineColourPlanSchema>;
export type TimelineColourPlanClip = z.infer<typeof timelineColourPlanClipSchema>;

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const dense = (value: unknown, maximum: number): value is unknown[] => Array.isArray(value) && value.length <= maximum &&
  Array.from({length: value.length}, (_, index) => Object.hasOwn(value, index)).every(Boolean);
function invalid(message: string): never {throw Object.assign(new Error(message), {code: 'INVALID_TIMELINE_COLOUR'});}
const same = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => same(value, right[index]));
  return object(left) && object(right) ? Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every(key => Object.hasOwn(right, key) && same(left[key], right[key])) : left === right;
};

/** Pure projection of saved intent. It does not probe sources or grant render
 * eligibility: the worker must independently verify files, streams and LUTs.
 * Omitted/null colour preserves legacy bytes; even a hidden managed clip opts
 * the snapshot into the explicit plan, while hidden visual clips are skipped. */
export function createTimelineColourPlan(timeline: unknown, assets: unknown): TimelineColourPlan | undefined {
  if (!object(timeline) || !dense(timeline.clips, 100) || !dense(timeline.tracks, 12)) invalid('Invalid timeline colour structure.');
  const clips = timeline.clips as unknown[], tracks = timeline.tracks as unknown[];
  let managed = false;
  for (const clip of clips) {
    if (!object(clip)) invalid('Invalid timeline clip.');
    if (Object.hasOwn(clip, 'colour')) {
      if (!isTimelineClipColour(clip.colour)) invalid('Invalid clip colour declaration.');
      if (clip.colour !== null) managed = true;
    }
  }
  if (!managed) return undefined;
  if (!dense(assets, 100)) invalid('Invalid colour source assets.');
  const trackMap = new Map<string, RecordValue>(), assetMap = new Map<string, RecordValue>();
  for (const track of tracks) {
    if (!object(track) || !id.safeParse(track.id).success || typeof track.id !== 'string' || trackMap.has(track.id) ||
        !['video', 'audio'].includes(String(track.kind)) || typeof track.hidden !== 'boolean') invalid('Invalid colour track.');
    trackMap.set(track.id as string, track);
  }
  for (const asset of assets as unknown[]) {
    if (!object(asset) || !id.safeParse(asset.id).success || typeof asset.id !== 'string' || assetMap.has(asset.id) ||
        !hash.safeParse(asset.sha256).success || typeof asset.mimeType !== 'string') invalid('Invalid colour source asset.');
    assetMap.set(asset.id as string, asset);
  }
  const planned: TimelineColourPlanClip[] = [], clipIds = new Set<string>();
  for (const value of clips) {
    const clip = value as RecordValue;
    if (typeof clip.id !== 'string' || !id.safeParse(clip.id).success || clipIds.has(clip.id) || typeof clip.trackId !== 'string' || typeof clip.assetId !== 'string') invalid('Invalid colour clip identity.');
    clipIds.add(clip.id);
    const track = trackMap.get(clip.trackId), asset = assetMap.get(clip.assetId);
    if (!track || !asset) invalid('Colour clip source or track is missing.');
    if (track.kind === 'audio') {
      if (clip.colour != null) invalid('Managed colour is available only on video clips.');
      continue;
    }
    if (track.hidden) continue;
    if (!['video/mp4', 'video/webm'].includes(String(asset.mimeType))) invalid('Managed colour cannot be mixed with visible images.');
    const result = timelineClipColourSchema.safeParse(clip.colour);
    if (!result.success || result.data.source === null) invalid('Every visible video requires a confirmed SDR source interpretation.');
    const colour = result.data, source = colour.source!;
    if (source.assetSha256 !== asset.sha256) invalid('Clip source interpretation no longer matches the frozen source hash.');
    planned.push({clipId: clip.id, assetId: clip.assetId, assetSha256: source.assetSha256,
      streamIndex: source.streamIndex, range: source.range, look: colour.look});
  }
  return timelineColourPlanSchema.parse({profileId: TIMELINE_COLOUR_RENDER_PROFILE, working: 'rec709-encoded-rgb8-v1',
    output: 'rec709-yuv420p-limited-v1', lutAlgorithm: 'cube3d-tetrahedral-premixed-v1', outOfDomain: 'clip-lut-domain', clips: planned});
}
export function projectTimelineColourPlan(snapshot: unknown): TimelineColourPlan | undefined {
  if (!object(snapshot)) invalid('Invalid colour snapshot.');
  return createTimelineColourPlan(snapshot.timeline, snapshot.assets);
}
export function isTimelineColourPlanSnapshot(snapshot: unknown): boolean {
  if (!object(snapshot)) return false;
  // The old delivery helper also validates geometry-only projections. Do not
  // impose aggregate validation on legacy values with no colour capability.
  if (!Object.hasOwn(snapshot, 'colourPlan') && (!object(snapshot.timeline) || !Array.isArray(snapshot.timeline.clips) ||
      !snapshot.timeline.clips.some(clip => object(clip) && Object.hasOwn(clip, 'colour')))) return true;
  try {
    const expected = createTimelineColourPlan(snapshot.timeline, snapshot.assets);
    return expected === undefined ? !Object.hasOwn(snapshot, 'colourPlan') : Object.hasOwn(snapshot, 'colourPlan') &&
      timelineColourPlanSchema.safeParse(snapshot.colourPlan).success && same(expected, snapshot.colourPlan);
  } catch {return false;}
}
export const isTimelineColourSnapshot = isTimelineColourPlanSnapshot;

/** Known opaque YUV layouts. Only 8/10-bit are eligible in this slice. A recognized layout is not
 * proof of Rec.709 or source eligibility. No RGB, alpha or gray fallback. */
export function timelineColourPixelBitDepth(format: string | null): number | null {
  if (format === null) return null;
  if (/^(?:yuv(?:420|422|444|440|411|410)p|yuvj(?:420|422|444|440|411)p|nv12|nv21)$/u.test(format)) return 8;
  const planar = /^yuv(?:420|422|444|440)p(9|10|12|14|16)(?:le|be)$/u.exec(format);
  if (planar) return Number(planar[1]);
  const semiplanar = /^p0(10|12|16)(?:le|be)$/u.exec(format);
  return semiplanar ? Number(semiplanar[1]) : null;
}
export function timelineColourSourceEvidenceStatus(evidence: TimelineColourSourceEvidence): 'compatible' | 'needs_interpretation' | 'unsupported' {
  const depth = timelineColourPixelBitDepth(evidence.pixelFormat);
  if (evidence.hdrMetadata || depth === null || ![8, 10].includes(depth) || depth !== evidence.bitDepth ||
      ['primaries', 'transfer', 'matrix'].some(key => evidence[key as 'primaries' | 'transfer' | 'matrix'] !== null && evidence[key as 'primaries' | 'transfer' | 'matrix'] !== 'bt709') ||
      evidence.range !== null && !['limited', 'full'].includes(evidence.range) ||
      evidence.pixelFormat?.startsWith('yuvj') && evidence.range === 'limited') return 'unsupported';
  return ['primaries', 'transfer', 'matrix', 'range'].some(key => evidence[key as keyof TimelineColourSourceEvidence] === null)
    ? 'needs_interpretation' : 'compatible';
}

const evidenceText = z.string().min(1).max(80).nullable();
export const timelineColourSourceEvidenceSchema = z.object({
  primaries: evidenceText, transfer: evidenceText, matrix: evidenceText, range: evidenceText,
  pixelFormat: evidenceText, bitDepth: z.number().int().min(1).max(64).nullable(), hdrMetadata: z.boolean(),
}).strict();
export const timelineColourSourceInspectInputSchema = z.object({projectId: id, assetId: id}).strict();
export const timelineColourSourceInspectResponseSchema = z.object({
  projectId: id, assetId: id, assetSha256: hash, streamIndex: streamIndex.nullable(),
  evidence: timelineColourSourceEvidenceSchema, status: z.enum(['compatible', 'needs_interpretation', 'unsupported']),
  reason: z.string().min(1).max(240).nullable(),
}).strict().refine(value => value.status === (value.streamIndex === null ? 'unsupported' : timelineColourSourceEvidenceStatus(value.evidence)),
  'Inspection status must match the selected stream and its bounded colour evidence.');
export type TimelineColourSourceEvidence = z.infer<typeof timelineColourSourceEvidenceSchema>;
export type TimelineColourSourceInspectInput = z.infer<typeof timelineColourSourceInspectInputSchema>;
export type TimelineColourSourceInspection = z.infer<typeof timelineColourSourceInspectResponseSchema>;
export function isTimelineColourSourceInspection(value: unknown, input: unknown): value is TimelineColourSourceInspection {
  const parsed = timelineColourSourceInspectResponseSchema.safeParse(value), request = timelineColourSourceInspectInputSchema.safeParse(input);
  return parsed.success && request.success && parsed.data.projectId === request.data.projectId && parsed.data.assetId === request.data.assetId;
}
export const isTimelineColourSourceInspectResponse = isTimelineColourSourceInspection;
export const timelineColourSchemas = Object.freeze({[TIMELINE_COLOUR_SOURCE_INSPECT]: timelineColourSourceInspectInputSchema});
export const timelineColourDescriptions = Object.freeze({[TIMELINE_COLOUR_SOURCE_INSPECT]:
  'Read-only bounded hash and metadata probe of one owned local video source. Returns evidence and SDR interpretation eligibility, not a grading, decoder, LUT compatibility or future render guarantee. No writes or network.'});
export const timelineColourEffects = Object.freeze({[TIMELINE_COLOUR_SOURCE_INSPECT]: Object.freeze({
  readOnly: true, idempotent: true, destructive: false, openWorld: false, databaseWrite: false,
  fileWrite: false, externalIO: false, localProcess: true, paidGeneration: false,
  notes: 'Reads and hashes one owned bounded source and invokes a bounded local metadata probe. No decoding, media change, database/file/cache write, network, provider call or paid generation. Missing tags require explicit user interpretation; HDR, Log or conflicting tags are not authorized by a declaration.',
})});
