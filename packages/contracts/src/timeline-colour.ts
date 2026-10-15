import {z} from 'zod';
import {LUT_RESOURCE_PROFILE} from './lut-resources.ts';

/** The declaration records user interpretation, not measured file evidence. */
export const TIMELINE_CLIP_COLOUR_PROFILE = 'mioon-rec709-sdr-clip-v1' as const;
export const TIMELINE_COLOUR_SOURCE_PROFILE = 'rec709-yuv-sdr-v1' as const;
export const TIMELINE_COLOUR_RENDER_PROFILE = 'mioon-rec709-sdr-render-v1' as const;
export const TIMELINE_COLOUR_SOURCE_INSPECT = 'timeline.colour.source.inspect' as const;

export const TIMELINE_COLOUR_PREFLIGHT_MESSAGES = Object.freeze({
  TIMELINE_IMAGE_COMPOSITOR_BUDGET: '同一时段最多支持 2 个可见的 SDR 图片片段（PNG 与 JPEG 合计）。请错开图片时间、隐藏多余图片轨道，或减少同时显示的图片；视频轨道上限不变。',
  INVALID_TIMELINE_COLOUR: 'Confirm a supported SDR source interpretation for every visible video or supported image clip before rendering managed colour.',
  TIMELINE_COLOUR_SOURCE_UNSUPPORTED: 'The source has unsupported colour evidence. HDR, Log, non-Rec.709 and unsupported pixel formats are outside this SDR profile.',
  TIMELINE_COLOUR_SOURCE_MISMATCH: 'The saved source interpretation no longer matches the verified source. Inspect and confirm the current source again.',
  TIMELINE_COLOUR_RESOURCE_CHANGED: 'The saved creative LUT resource could not be verified against its frozen bytes, hash and profile.',
  TIMELINE_COLOUR_LUT_BUDGET: 'The saved colour resources or static image layers exceed the bounded render staging budget. Reduce distinct looks, image sizes or layers.',
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
// Historical video/source/render schemas remain closed. Only the current clip
// field admits the separate image profile, gated by ordinary32/restored33.
export const TIMELINE_IMAGE_CLIP_COLOUR_PROFILE = 'mioon-srgb-image-clip-v1' as const;
export const TIMELINE_IMAGE_SOURCE_PROFILE = 'png-rgb8-srgb-v1' as const;
export const TIMELINE_MIXED_COLOUR_RENDER_PROFILE = 'mioon-mixed-sdr-render-v2' as const;
export const TIMELINE_IMAGE_TRANSFORM_PROFILE = 'srgb8-to-bt1886-zero-black-display-v1' as const;
export const TIMELINE_IMAGE_TABLE_SHA256 = '383f159aebd6758ead128a3f1291ec70275bbd6bf60aef603e17d2d3726c303c' as const;
export const TIMELINE_IMAGE_RESIZE_PROFILE = 'png-contain-bilinear-mirror-premultiplied-v1' as const;
export const TIMELINE_IMAGE_SOURCE_INSPECT = 'timeline.colour.image.inspect' as const;
export const TIMELINE_IMAGE_COMPOSITOR_INPUTS = 2;
export function assertTimelineImageCompositorInputCount(count:number):void {
  if(!Number.isSafeInteger(count)||count<0||count>TIMELINE_IMAGE_COMPOSITOR_INPUTS)throw Object.assign(
    new Error(TIMELINE_COLOUR_PREFLIGHT_MESSAGES.TIMELINE_IMAGE_COMPOSITOR_BUDGET),{code:'TIMELINE_IMAGE_COMPOSITOR_BUDGET'});
}
export const timelineImageEvidenceSchema = z.object({
  profileId: z.literal(TIMELINE_IMAGE_SOURCE_PROFILE), sha256: hash,
  sourceByteLength: z.number().int().min(1).max(32 * 1024 * 1024),
  width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096),
  bitDepth: z.literal(8), alphaMode: z.enum(['opaque', 'straight']), orientation: z.literal(1),
  colourTag: z.enum(['srgb', 'untagged']),
}).strict().refine(value => value.width * value.height <= 2073600, 'PNG pixel budget exceeded.');
export const timelineImageSourceSchema = z.object({
  assetSha256: hash, profileId: z.literal(TIMELINE_IMAGE_SOURCE_PROFILE),
  interpretation: z.literal('srgb'), declaredBy: z.literal('user'), declaredAt: z.string().max(40).datetime(),
  evidence: timelineImageEvidenceSchema,
}).strict().refine(value => value.assetSha256 === value.evidence.sha256, 'Image evidence must bind the declared bytes.');
export const timelineImageClipColourSchema = z.object({
  profileId: z.literal(TIMELINE_IMAGE_CLIP_COLOUR_PROFILE), source: timelineImageSourceSchema.nullable(),
  look: timelineColourLookSchema.nullable(),
}).strict();
// Separate JPEG generation. Historical PNG schemas above remain closed.
export const TIMELINE_JPEG_CLIP_COLOUR_PROFILE = 'mioon-jfif-image-clip-v1' as const;
export const TIMELINE_JPEG_SOURCE_PROFILE = 'jfif-ycbcr8-srgb-v1' as const;
export const TIMELINE_JPEG_MIXED_COLOUR_RENDER_PROFILE = 'mioon-mixed-sdr-render-v3' as const;
export const TIMELINE_JPEG_DECODE_PROFILE = 'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1' as const;
export const TIMELINE_JPEG_SOURCE_INSPECT = 'timeline.colour.jpeg.inspect' as const;
export const timelineJpegEvidenceSchema = z.object({
  profileId: z.literal(TIMELINE_JPEG_SOURCE_PROFILE), sha256: hash,
  sourceByteLength: z.number().int().min(1).max(32 * 1024 * 1024),
  width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096),
  bitDepth: z.literal(8), alphaMode: z.literal('opaque'), orientation: z.literal(1),
  colourTag: z.literal('untagged'), sampling: z.enum(['444', '422', '420']),
  decoderPolicy: z.literal(TIMELINE_JPEG_DECODE_PROFILE),
}).strict().refine(value => value.width * value.height <= 2073600, 'JPEG pixel budget exceeded.');
export const timelineJpegSourceSchema = z.object({
  assetSha256: hash, profileId: z.literal(TIMELINE_JPEG_SOURCE_PROFILE),
  interpretation: z.literal('srgb'), declaredBy: z.literal('user'), declaredAt: z.string().max(40).datetime(),
  evidence: timelineJpegEvidenceSchema,
}).strict().refine(value => value.assetSha256 === value.evidence.sha256, 'JPEG evidence must bind the declared bytes.');
export const timelineJpegClipColourSchema = z.object({
  profileId: z.literal(TIMELINE_JPEG_CLIP_COLOUR_PROFILE), source: timelineJpegSourceSchema.nullable(),
  look: timelineColourLookSchema.nullable(),
}).strict();
export const timelineAnyImageEvidenceSchema = z.union([timelineImageEvidenceSchema, timelineJpegEvidenceSchema]);
export const timelineAnyImageSourceSchema = z.union([timelineImageSourceSchema, timelineJpegSourceSchema]);
export type TimelineJpegEvidence = z.infer<typeof timelineJpegEvidenceSchema>;
export type TimelineJpegSource = z.infer<typeof timelineJpegSourceSchema>;
export type TimelineAnyImageEvidence = z.infer<typeof timelineAnyImageEvidenceSchema>;
export const clipColourSchema = z.union([timelineClipColourSchema, timelineImageClipColourSchema, timelineJpegClipColourSchema]).nullable();
export type TimelineImageEvidence = z.infer<typeof timelineImageEvidenceSchema>;
export type TimelineImageSource = z.infer<typeof timelineImageSourceSchema>;
export type TimelineImageClipColour = z.infer<typeof timelineImageClipColourSchema>;
export type ClipColour = z.infer<typeof clipColourSchema>;
export type TimelineClipColour = z.infer<typeof timelineClipColourSchema>;
export type TimelineColourSource = z.infer<typeof timelineColourSourceSchema>;
export type TimelineColourLook = z.infer<typeof timelineColourLookSchema>;
export function isTimelineClipColour(value: unknown): value is ClipColour | null {
  return clipColourSchema.safeParse(value).success;
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
export const timelineMixedColourPlanClipSchema = z.union([
  timelineColourPlanClipSchema.extend({kind: z.literal('video'), sourceProfileId: z.literal(TIMELINE_COLOUR_SOURCE_PROFILE)}).strict(),
  z.object({clipId: id, assetId: id, assetSha256: hash, streamIndex: z.literal(0), kind: z.literal('image'),
    sourceProfileId: z.literal(TIMELINE_IMAGE_SOURCE_PROFILE), interpretation: z.literal('srgb'), evidence: timelineImageEvidenceSchema,
    transformProfile: z.literal(TIMELINE_IMAGE_TRANSFORM_PROFILE), algorithm: z.literal('rgb8-fixed-linear-table256-v1'),
    algorithmSha256: z.literal(TIMELINE_IMAGE_TABLE_SHA256),
    referenceDisplay: z.object({eotf: z.literal('bt1886-zero-black'), gamma: z.literal(2.4), black: z.literal(0), white: z.literal(1),
      luminance: z.literal('relative'), primaries: z.literal('bt709'), whitePoint: z.literal('D65')}).strict(),
    alpha: z.literal('straight-transform-look-premultiply-resize'), resizeProfile: z.literal(TIMELINE_IMAGE_RESIZE_PROFILE),
    look: timelineColourLookSchema.nullable(),
  }).strict().refine(value => value.assetSha256 === value.evidence.sha256, 'Image plan evidence must bind its source.'),
]);
export const timelineMixedColourPlanSchema = z.object({
  profileId: z.literal(TIMELINE_MIXED_COLOUR_RENDER_PROFILE), working: z.literal('rec709-encoded-rgb8-v1'),
  output: z.literal('rec709-yuv420p-limited-v1'), lutAlgorithm: z.literal('cube3d-tetrahedral-premixed-v1'),
  outOfDomain: z.literal('clip-lut-domain'), clips: z.array(timelineMixedColourPlanClipSchema).max(100),
}).strict().refine(value => new Set(value.clips.map(clip => clip.clipId)).size === value.clips.length && value.clips.some(clip => clip.kind === 'image'),
  'Mixed colour plans require unique clip identities and an image.');
export const timelineJpegColourPlanClipSchema = z.object({
  clipId: id, assetId: id, assetSha256: hash, streamIndex: z.literal(0), kind: z.literal('image'),
  sourceProfileId: z.literal(TIMELINE_JPEG_SOURCE_PROFILE), interpretation: z.literal('srgb'), evidence: timelineJpegEvidenceSchema,
  decodeProfile: z.literal(TIMELINE_JPEG_DECODE_PROFILE),
  transformProfile: z.literal(TIMELINE_IMAGE_TRANSFORM_PROFILE), algorithm: z.literal('rgb8-fixed-linear-table256-v1'),
  algorithmSha256: z.literal(TIMELINE_IMAGE_TABLE_SHA256),
  referenceDisplay: z.object({eotf: z.literal('bt1886-zero-black'), gamma: z.literal(2.4), black: z.literal(0), white: z.literal(1),
    luminance: z.literal('relative'), primaries: z.literal('bt709'), whitePoint: z.literal('D65')}).strict(),
  alpha: z.literal('opaque-transform-look-premultiply-resize'), resizeProfile: z.literal(TIMELINE_IMAGE_RESIZE_PROFILE),
  look: timelineColourLookSchema.nullable(),
}).strict().refine(value => value.assetSha256 === value.evidence.sha256, 'JPEG plan evidence must bind its source.');
export const timelineJpegMixedColourPlanSchema = z.object({
  profileId: z.literal(TIMELINE_JPEG_MIXED_COLOUR_RENDER_PROFILE), working: z.literal('rec709-encoded-rgb8-v1'),
  output: z.literal('rec709-yuv420p-limited-v1'), lutAlgorithm: z.literal('cube3d-tetrahedral-premixed-v1'),
  outOfDomain: z.literal('clip-lut-domain'), clips: z.array(z.union([timelineMixedColourPlanClipSchema,timelineJpegColourPlanClipSchema])).max(100),
}).strict().refine(value => new Set(value.clips.map(clip => clip.clipId)).size === value.clips.length &&
  value.clips.some(clip => clip.sourceProfileId === TIMELINE_JPEG_SOURCE_PROFILE), 'JPEG plans require unique clip identities and a JPEG.');
export const timelineAnyColourPlanSchema = z.union([timelineColourPlanSchema, timelineMixedColourPlanSchema, timelineJpegMixedColourPlanSchema]);
export type TimelineColourPlan = z.infer<typeof timelineAnyColourPlanSchema>;
export type TimelineMixedColourPlanClip = z.infer<typeof timelineMixedColourPlanClipSchema>;
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
  const planned: (TimelineMixedColourPlanClip | z.infer<typeof timelineJpegColourPlanClipSchema>)[] = [], clipIds = new Set<string>(), imageEdges:{frame:number;delta:number}[]=[];
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
    if (asset.mimeType === 'image/png' || asset.mimeType === 'image/jpeg') {
      if(!Number.isSafeInteger(clip.startFrame)||!Number.isSafeInteger(clip.durationFrames)||Number(clip.startFrame)<0||Number(clip.durationFrames)<1||Number(clip.startFrame)+Number(clip.durationFrames)>18000)invalid('Invalid image interval.');
      imageEdges.push({frame:Number(clip.startFrame),delta:1},{frame:Number(clip.startFrame)+Number(clip.durationFrames),delta:-1});
      const jpeg = asset.mimeType === 'image/jpeg';
      const result = (jpeg ? timelineJpegClipColourSchema : timelineImageClipColourSchema).safeParse(clip.colour);
      if (!result.success || result.data.source === null) invalid('Every visible supported image requires a confirmed sRGB image interpretation.');
      const colour = result.data, source = colour.source!;
      if (source.assetSha256 !== asset.sha256) invalid('Image interpretation no longer matches the frozen source hash.');
      planned.push({clipId: clip.id, assetId: clip.assetId, assetSha256: source.assetSha256, streamIndex: 0,
        kind: 'image', sourceProfileId: source.profileId, interpretation: source.interpretation,
        ...(jpeg ? {decodeProfile: TIMELINE_JPEG_DECODE_PROFILE} : {}),
        evidence: source.evidence, transformProfile: TIMELINE_IMAGE_TRANSFORM_PROFILE, algorithm: 'rgb8-fixed-linear-table256-v1',
        algorithmSha256: TIMELINE_IMAGE_TABLE_SHA256,
        referenceDisplay: {eotf: 'bt1886-zero-black', gamma: 2.4, black: 0, white: 1, luminance: 'relative', primaries: 'bt709', whitePoint: 'D65'},
        alpha: jpeg ? 'opaque-transform-look-premultiply-resize' : 'straight-transform-look-premultiply-resize', resizeProfile: TIMELINE_IMAGE_RESIZE_PROFILE, look: colour.look} as TimelineMixedColourPlanClip | z.infer<typeof timelineJpegColourPlanClipSchema>);
    } else {
      if (!['video/mp4', 'video/webm'].includes(String(asset.mimeType))) invalid('Managed colour supports only interpreted video and bounded sRGB PNG/JFIF.');
      const result = timelineClipColourSchema.safeParse(clip.colour);
      if (!result.success || result.data.source === null) invalid('Every visible video requires a confirmed SDR source interpretation.');
      const colour = result.data, source = colour.source!;
      if (source.assetSha256 !== asset.sha256) invalid('Clip source interpretation no longer matches the frozen source hash.');
      planned.push({clipId: clip.id, assetId: clip.assetId, assetSha256: source.assetSha256,
        streamIndex: source.streamIndex, range: source.range, look: colour.look, kind: 'video', sourceProfileId: TIMELINE_COLOUR_SOURCE_PROFILE});
    }
  }
  // Segments are cut at every clip edge. End-exclusive intervals release an
  // input before a new one at the same frame; only visible PNGs are counted.
  let activeImages=0;
  for(const edge of imageEdges.sort((a,b)=>a.frame-b.frame||a.delta-b.delta)){activeImages+=edge.delta;assertTimelineImageCompositorInputCount(activeImages);}
  const mixed = planned.some(clip => clip.kind === 'image');
  const plan = {profileId: planned.some(clip => clip.sourceProfileId === TIMELINE_JPEG_SOURCE_PROFILE) ? TIMELINE_JPEG_MIXED_COLOUR_RENDER_PROFILE : mixed ? TIMELINE_MIXED_COLOUR_RENDER_PROFILE : TIMELINE_COLOUR_RENDER_PROFILE, working: 'rec709-encoded-rgb8-v1',
    output: 'rec709-yuv420p-limited-v1', lutAlgorithm: 'cube3d-tetrahedral-premixed-v1', outOfDomain: 'clip-lut-domain',
    clips: mixed ? planned : planned.map(({kind: _kind, sourceProfileId: _profile, ...clip}) => clip)};
  return timelineAnyColourPlanSchema.parse(plan);
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
      timelineAnyColourPlanSchema.safeParse(snapshot.colourPlan).success && same(expected, snapshot.colourPlan);
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
export const timelineColourSchemas = Object.freeze({[TIMELINE_COLOUR_SOURCE_INSPECT]: timelineColourSourceInspectInputSchema, [TIMELINE_IMAGE_SOURCE_INSPECT]: timelineColourSourceInspectInputSchema, [TIMELINE_JPEG_SOURCE_INSPECT]: timelineColourSourceInspectInputSchema});
export const timelineColourDescriptions = Object.freeze({[TIMELINE_COLOUR_SOURCE_INSPECT]:
  'Read-only bounded hash and metadata probe of one owned local video source. Returns evidence and SDR interpretation eligibility, not a grading, decoder, LUT compatibility or future render guarantee. No writes or network.', [TIMELINE_IMAGE_SOURCE_INSPECT]: 'Read-only bounded inspection of one owned static RGB8/RGBA8 PNG. Validates its exact bytes, PNG structure and permitted colour metadata; untagged files still require explicit user sRGB interpretation. No writes, network or providers.', [TIMELINE_JPEG_SOURCE_INSPECT]: 'Read-only bounded strict JFIF baseline JPEG inspection and local decode. JFIF does not prove sRGB: explicit user interpretation is still required. Rejects EXIF, ICC, HDR, progressive and multi-image sources. No writes or network.'});
export const timelineColourEffects = Object.freeze({[TIMELINE_COLOUR_SOURCE_INSPECT]: Object.freeze({
  readOnly: true, idempotent: true, destructive: false, openWorld: false, databaseWrite: false,
  fileWrite: false, externalIO: false, localProcess: true, paidGeneration: false,
  notes: 'Reads and hashes one owned bounded source and invokes a bounded local metadata probe. No decoding, media change, database/file/cache write, network, provider call or paid generation. Missing tags require explicit user interpretation; HDR, Log or conflicting tags are not authorized by a declaration.',
}), [TIMELINE_IMAGE_SOURCE_INSPECT]: Object.freeze({readOnly: true, idempotent: true, destructive: false, openWorld: false, databaseWrite: false, fileWrite: false, externalIO: false, localProcess: false, paidGeneration: false, notes: 'Reads one owned bounded PNG and validates its structure and inflated rows. Does not write, launch a process, change source bytes or infer untagged colour.'}), [TIMELINE_JPEG_SOURCE_INSPECT]: Object.freeze({readOnly: true, idempotent: true, destructive: false, openWorld: false, databaseWrite: false, fileWrite: false, externalIO: false, localProcess: true, paidGeneration: false, notes: 'Reads one bounded owned JFIF, validates complete baseline entropy and invokes one strict bounded local RGB24 decode to a bounded pipe. No file/cache/database writes, provider calls, network or implicit sRGB interpretation.'})});

// Separate operation preserves the original video inspection DTO byte-for-byte.
export const timelineImageSourceInspectResponseSchema = z.object({
  projectId: id, assetId: id, assetSha256: hash, kind: z.literal('image'),
  evidence: timelineImageEvidenceSchema, status: z.enum(['compatible', 'needs_interpretation']),
}).strict().refine(value => value.assetSha256 === value.evidence.sha256 &&
  value.status === (value.evidence.colourTag === 'srgb' ? 'compatible' : 'needs_interpretation'), 'Image inspection evidence mismatch.');
export type TimelineImageSourceInspection = z.infer<typeof timelineImageSourceInspectResponseSchema>;
export function isTimelineImageSourceInspection(value: unknown, input: unknown): value is TimelineImageSourceInspection {
  const parsed = timelineImageSourceInspectResponseSchema.safeParse(value), request = timelineColourSourceInspectInputSchema.safeParse(input);
  return parsed.success && request.success && parsed.data.projectId === request.data.projectId && parsed.data.assetId === request.data.assetId;
}

export const timelineJpegSourceInspectResponseSchema = z.object({
  projectId: id, assetId: id, assetSha256: hash, kind: z.literal('image'),
  evidence: timelineJpegEvidenceSchema, status: z.literal('needs_interpretation'),
}).strict().refine(value => value.assetSha256 === value.evidence.sha256, 'JPEG inspection evidence mismatch.');
export type TimelineJpegSourceInspection = z.infer<typeof timelineJpegSourceInspectResponseSchema>;
export function isTimelineJpegSourceInspection(value: unknown, input: unknown): value is TimelineJpegSourceInspection {
  const parsed = timelineJpegSourceInspectResponseSchema.safeParse(value), request = timelineColourSourceInspectInputSchema.safeParse(input);
  return parsed.success && request.success && parsed.data.projectId === request.data.projectId && parsed.data.assetId === request.data.assetId;
}
