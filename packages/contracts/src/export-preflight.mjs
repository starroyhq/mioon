import {z} from 'zod';
import {timelineOutputPreset} from './timeline-format.mjs';

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
const count = maximum => z.number().int().min(0).max(maximum);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const exportPreflightSchemas = Object.freeze({
  'timeline.export.preflight': z.object({
    projectId: id,
    expectedRevision: revision.describe('Existing timeline revision to check. This read never creates a timeline; a different current revision is reported as stale.'),
  }).strict(),
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
    fps: z.literal(30),
    width: z.union([z.literal(720),z.literal(1280)]),
    height: z.union([z.literal(720),z.literal(1280)]),
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
  }).strict(),
  issues: z.array(z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    severity: z.enum(['error', 'warning']),
    message: z.string().min(1).max(240),
    assetId: id.optional(),
    clipId: id.optional(),
  }).strict()).max(EXPORT_PREFLIGHT_LIMITS.issues),
}).strict().superRefine((value, context) => {
  const fail = (path, message) => context.addIssue({code: z.ZodIssueCode.custom, path, message});
  if (value.checks.checkedAssets > value.checks.totalAssets)
    fail(['checks', 'checkedAssets'], 'Checked assets must not exceed the total asset count.');
  if (value.summary) {
    for (const key of ['visualClipCount', 'audibleClipCount'])
      if (value.summary[key] > value.summary.clipCount)
        fail(['summary', key], 'Visual and audible counts must not exceed the clip count.');
  }
  if (value.status === 'ready') {
    for (const key of ['timelineId', 'timelineRevision', 'snapshotHash', 'summary'])
      if (value[key] === null) fail([key], 'Ready reports require a complete existing timeline binding.');
    if (value.timelineRevision !== value.expectedRevision)
      fail(['timelineRevision'], 'Ready reports must match the requested timeline revision.');
    if (value.checks.checkedAssets !== value.checks.totalAssets || value.summary && value.checks.totalAssets !== value.summary.assetCount)
      fail(['checks', 'checkedAssets'], 'Ready reports require all summarized assets to be checked.');
    if (value.issues.some(issue => issue.severity === 'error'))
      fail(['issues'], 'Ready reports cannot contain known blocking issues.');
  }
});

// Bind acknowledgements to their intended project/revision when caller input is
// available. A report is a point-in-time check, never a durable replay receipt.
export function isExportPreflightResponse(value, input) {
  if (!exportPreflightResponseSchema.safeParse(value).success) return false;
  return !input || (value.projectId === input.projectId && value.expectedRevision === input.expectedRevision);
}
