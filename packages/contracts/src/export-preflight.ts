type Rec = Record<string, unknown>;
export {TIMELINE_COLOUR_PREFLIGHT_MESSAGES,TIMELINE_COLOUR_PREFLIGHT_CODES} from './timeline-colour.ts';
import {timelineExportRangeSchema,isTimelineExportRangeInput,isTimelineExportRangeWithinDuration,isTimelineExportRangeSnapshot} from './timeline-export-range.ts';
import {timelineDeliveryNameSchema,isTimelineDeliveryNameInput,isTimelineDeliveryNameSnapshot} from './timeline-delivery.ts';
import {timelineExportSettingsSchema,timelineExportDeliverySchema,isTimelineExportDelivery} from './timeline-export-profile.ts';
import {z} from 'zod';
import {timelineOutputPreset} from './timeline-format.ts';
import {TIMELINE_SUBTITLE_PROFILE_ID} from './timeline-subtitle-profile.ts';

// Local source verification is bounded and never claims full media decoding.
export const EXPORT_PREFLIGHT_LIMITS = Object.freeze({
  assets: 100,
  sourceBytes: 512 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  timeoutMs: 30_000,
  issues: 128,
});

const id = z.string().uuid();
const revision = z.number().int().positive();
const count = (maximum: number) => z.number().int().min(0).max(maximum);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const exportPreflightSchemas = Object.freeze({
  'timeline.export.preflight': z.object({
    projectId: id,
    exportSettings: timelineExportSettingsSchema.optional(),
    deliveryName: timelineDeliveryNameSchema.optional(),
    exportRange: timelineExportRangeSchema.optional(),
    expectedRevision: revision.describe('Existing timeline revision to check. This read never creates a timeline; a different current revision is reported as stale.'),
  }).strict().refine(value=>isTimelineDeliveryNameInput(value),{message:'Delivery name must be explicitly valid',path:['deliveryName']}).refine(value=>isTimelineExportRangeInput(value),{message:'Export range must be explicitly valid',path:['exportRange']}),
});

export const exportPreflightResponseSchema = z.object({
  projectId: id,
  timelineId: id.nullable(),
  timelineRevision: revision.nullable(),
  expectedRevision: revision,
  snapshotHash: digest.nullable(),
  checkedAt: z.string().datetime(),
  status: z.enum(['ready', 'blocked', 'incomplete', 'stale']),
  summary: z.object({
    delivery: timelineExportDeliverySchema.optional(),
    deliveryName: timelineDeliveryNameSchema.optional(),
    exportRange: timelineExportRangeSchema.optional(),
    fps: z.literal(30),
    width: z.union([z.literal(720),z.literal(1280),z.literal(1080),z.literal(1920)]),
    height: z.union([z.literal(720),z.literal(1280),z.literal(1080),z.literal(1920)]),
    durationFrames: count(18000),
    trackCount: count(12),
    clipCount: count(100),
    assetCount: count(EXPORT_PREFLIGHT_LIMITS.assets),
    visualClipCount: count(100),
    audibleClipCount: count(100),
    mutedTrackCount: count(12),
    hiddenVideoTrackCount: count(12),
  }).strict().refine(value=>timelineOutputPreset(value)!==null,{message:'Summary dimensions must match a supported timeline-output preset.'}).nullable(),
  checks: z.object({
    totalAssets: count(EXPORT_PREFLIGHT_LIMITS.assets),
    checkedAssets: count(EXPORT_PREFLIGHT_LIMITS.assets),
    bytesHashed: count(EXPORT_PREFLIGHT_LIMITS.totalBytes),
    fullDecode: z.literal(false),
    subtitles:z.object({profileId:z.literal(TIMELINE_SUBTITLE_PROFILE_ID),fontVerified:z.boolean(),inkMeasured:z.literal(false)}).strict().optional(),
  }).strict(),
  issues: z.array(z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    severity: z.enum(['error', 'warning']),
    message: z.string().min(1).max(240),
    assetId: id.optional(),
    clipId: id.optional(),
  }).strict()).max(EXPORT_PREFLIGHT_LIMITS.issues),
}).strict().superRefine((value, context) => {
  const fail = (path: (string | number)[], message: string) => context.addIssue({code: z.ZodIssueCode.custom, path, message});
  if (value.checks.checkedAssets > value.checks.totalAssets)
    fail(['checks', 'checkedAssets'], 'Checked assets must not exceed the total asset count.');
  if (value.summary) {
    if(!isTimelineDeliveryNameInput(value.summary))fail(['summary','deliveryName'],'Delivery name must be explicitly valid.');
    if(!isTimelineExportRangeWithinDuration(value.summary,value.summary.durationFrames))fail(['summary','exportRange'],'Export range must fit the full composition duration.');
    if(value.summary.delivery&&!isTimelineExportDelivery(value.summary.delivery,value.summary))fail(['summary','delivery'],'Delivery must match the composition dimensions and frozen settings.');
    for (const key of ['visualClipCount', 'audibleClipCount'] as const)
      if (value.summary[key] > value.summary.clipCount)
        fail(['summary', key], 'Visual and audible counts must not exceed the clip count.');
  }
  if (value.status === 'ready') {
    for (const key of ['timelineId', 'timelineRevision', 'snapshotHash', 'summary'] as const)
      if (value[key] === null) fail([key], 'Ready reports require a complete existing timeline binding.');
    if (value.timelineRevision !== value.expectedRevision)
      fail(['timelineRevision'], 'Ready reports must match the requested timeline revision.');
    if (value.checks.checkedAssets !== value.checks.totalAssets || value.summary && value.checks.totalAssets !== value.summary.assetCount)
      fail(['checks', 'checkedAssets'], 'Ready reports require all summarized assets to be checked.');
    if(value.checks.subtitles&&!value.checks.subtitles.fontVerified)fail(['checks','subtitles','fontVerified'],'Ready reports require a verified font; actual ink measurement still occurs during rendering.');
    if (value.issues.some(issue => issue.severity === 'error'))
      fail(['issues'], 'Ready reports cannot contain known blocking issues.');
  }
});

// Bind acknowledgements to their intended project/revision when caller input is
// available. A report is a point-in-time check, never a durable replay receipt.
export type ExportPreflightResponse = z.infer<typeof exportPreflightResponseSchema>;
export function isExportPreflightResponse(value: unknown, input?: unknown): boolean {
  if (!exportPreflightResponseSchema.safeParse(value).success) return false;
  if (!input) return true;
  const request = input as Rec, response = value as ExportPreflightResponse;
  if (!(isTimelineDeliveryNameInput(input) && isTimelineExportRangeInput(input) && response.projectId === request.projectId && response.expectedRevision === request.expectedRevision)) return false;
  return !response.summary || (isTimelineDeliveryNameSnapshot(response.summary,{input}) && isTimelineExportRangeSnapshot({...response.summary,timeline:response.summary},{input}) && (request.exportSettings!==undefined)===Object.hasOwn(response.summary,'delivery') && (request.exportSettings===undefined||isTimelineExportDelivery(response.summary.delivery,response.summary,request.exportSettings)));
}
