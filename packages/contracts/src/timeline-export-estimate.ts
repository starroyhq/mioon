import {z} from 'zod';
import {TIMELINE_DELIVERY_MAX_EDGE, TIMELINE_EXPORT_RESOLUTIONS} from './timeline-output-geometry.ts';
import {timelineExportRangeSchema, isTimelineExportRangeInput} from './timeline-export-range.ts';
import {timelineExportSettingsSchema} from './timeline-export-profile.ts';

const id = z.string().uuid();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fps = z.number().int().positive().max(60);
const edge = z.number().int().min(2).max(TIMELINE_DELIVERY_MAX_EDGE).multipleOf(2);
const issueFields = {severity: z.literal('error'), message: z.string().min(1).max(240)};

export const TIMELINE_EXPORT_RESOURCE_REJECTION_CODES = [
  'EXPORT_4K_FPS_UNSUPPORTED', 'EXPORT_4K_MEMORY_INSUFFICIENT', 'EXPORT_4K_RASTER_UNSUPPORTED', 'EXPORT_4K_IMAGE_STAGING_LIMIT', 'EXPORT_OUTPUT_TOO_LARGE',
  'EXPORT_DISK_SPACE_INSUFFICIENT',
] as const;
const [fpsCode, memoryCode, rasterCode, stagingCode, artifactCode, diskCode] = TIMELINE_EXPORT_RESOURCE_REJECTION_CODES;
const crfSizeWarningCode = 'EXPORT_CRF_SIZE_UNCERTAIN';
export const TIMELINE_EXPORT_RESOURCE_ISSUE_CODES = [...TIMELINE_EXPORT_RESOURCE_REJECTION_CODES, crfSizeWarningCode] as const;

export const timelineExportResourceIssueSchema = z.discriminatedUnion('code', [
  z.object({...issueFields, code: z.literal(fpsCode), details: z.object({fps, maxFps: fps}).strict()}).strict(),
  z.object({...issueFields, code: z.literal(memoryCode), details: z.object({requiredBytes: bytes}).strict()}).strict(),
  z.object({...issueFields, code: z.literal(rasterCode), details: z.object({width: bytes.positive(), height: bytes.positive()}).strict()}).strict(),
  z.object({...issueFields, code: z.literal(stagingCode), details: z.object({
    requiredPixels: bytes, maxPixels: bytes.positive(), requiredLayers: bytes, maxLayers: bytes.positive(),
  }).strict()}).strict(),
  z.object({...issueFields, code: z.literal(artifactCode), details: z.object({estimatedBytes: bytes, maxBytes: bytes}).strict()}).strict(),
  z.object({...issueFields, code: z.literal(diskCode), details: z.object({estimatedBytes: bytes, availableBytes: bytes}).strict()}).strict(),
  z.object({code: z.literal(crfSizeWarningCode), severity: z.literal('warning'), message: issueFields.message, details: z.object({
    estimatedBytes: bytes, availableBytes: bytes.nullable(), maxBytes: bytes, lowerBoundBytes: bytes, warningThresholdBytes: bytes,
  }).strict()}).strict(),
]);

const [v1Profile, floatProfile] = timelineExportSettingsSchema.options;
export const timelineExportEstimateSchemas = Object.freeze({
  'timeline.export.estimate': z.object({
    projectId: id,
    expectedRevision: revision,
    profileId: z.union([v1Profile.shape.profileId, floatProfile.shape.profileId]),
    rateControl: v1Profile.shape.rateControl,
    exportRange: timelineExportRangeSchema.optional(),
  }).strict().refine(value => isTimelineExportRangeInput(value), {
    message: 'Export range must be explicitly valid', path: ['exportRange'],
  }),
});

const estimateSchema = z.object({
  resolution: z.enum(TIMELINE_EXPORT_RESOLUTIONS),
  width: edge,
  height: edge,
  estimatedBytes: bytes,
  estimatedSeconds: z.number().nonnegative().finite(),
  issues: z.array(timelineExportResourceIssueSchema).max(TIMELINE_EXPORT_RESOURCE_ISSUE_CODES.length),
}).strict();

export const timelineExportEstimateResponseSchema = z.object({
  projectId: id, timelineId: id, timelineRevision: revision, expectedRevision: revision, fps,
  availableBytes: bytes.nullable(),
  estimates: z.array(estimateSchema).length(TIMELINE_EXPORT_RESOLUTIONS.length),
}).strict().refine(value => value.timelineRevision === value.expectedRevision &&
  value.estimates.every((row, index) => row.resolution === TIMELINE_EXPORT_RESOLUTIONS[index]), {
    message: 'Estimates must be bound to the requested revision and include every resolution.',
  });

export type TimelineExportEstimateInput = z.infer<typeof timelineExportEstimateSchemas['timeline.export.estimate']>;
export type TimelineExportEstimateResponse = z.infer<typeof timelineExportEstimateResponseSchema>;
export type TimelineExportResourceIssue = z.infer<typeof timelineExportResourceIssueSchema>;
export type TimelineExportResourceRejection = Extract<TimelineExportResourceIssue, {severity: 'error'}>;

export function isTimelineExportEstimateResponse(value: unknown, input?: unknown): boolean {
  const parsed = timelineExportEstimateResponseSchema.safeParse(value);
  if (!parsed.success) return false;
  if (input === undefined) return true;
  const request = timelineExportEstimateSchemas['timeline.export.estimate'].safeParse(input);
  return request.success && parsed.data.projectId === request.data.projectId &&
    parsed.data.expectedRevision === request.data.expectedRevision;
}
