import {z} from 'zod';

/** Final Cut Pro (.fcpxmld) export RPC contract.
 *
 * Project-level RPC operations at `/api/projects/{projectId}/rpc`, shared by
 * the desktop renderer, CLI, MCP and Mio.
 */
export const FCP_EXPORT_TASK_KIND = 'fcpxml-export' as const;

export const FCP_EXPORT_OPERATIONS = Object.freeze([
  'export.fcpxml.preview',
  'export.fcpxml.start',
  'export.fcpxml.get',
  'export.fcpxml.cancel',
] as const);
export type FcpExportOperation = (typeof FCP_EXPORT_OPERATIONS)[number];

const missingItemCodes = [
  'LUT',
  'PLACEHOLDER',
  'MEDIA_MISSING',
  'UNSUPPORTED_MEDIA',
] as const;
export const FCP_MISSING_ITEM_CODES = Object.freeze([...missingItemCodes, 'SPEED'] as const);
export type FcpMissingItemCode = (typeof FCP_MISSING_ITEM_CODES)[number];

const approximationItemCodes = [
  'TRANSITION',
  'VOLUME_KEYFRAMES',
  'FADES',
  'SUBTITLE_STYLE',
  'ANCHOR',
  'MUTE',
  'SEPARATE_SOUND',
  'TRANSFORM',
] as const;
export const FCP_APPROXIMATION_ITEM_CODES = Object.freeze([...approximationItemCodes, 'SPEED'] as const);
export type FcpApproximationItemCode = (typeof FCP_APPROXIMATION_ITEM_CODES)[number];

export const FCP_ITEM_CODES = Object.freeze([...missingItemCodes, ...approximationItemCodes, 'SPEED'] as const);
export type FcpItemCode = (typeof FCP_ITEM_CODES)[number];

export const FCP_EXPORT_STATUSES = Object.freeze([
  'running',
  'done',
  'failed',
  'cancelled',
] as const);
export type FcpExportStatus = (typeof FCP_EXPORT_STATUSES)[number];

export const FCP_EXPORT_ERROR_CODES = Object.freeze([
  'DISK_FULL',
  'NOT_WRITABLE',
  'MEDIA_UNREADABLE',
  'EXPORT_FAILED',
] as const);
export type FcpExportErrorCode = (typeof FCP_EXPORT_ERROR_CODES)[number];

export const fcpMissingItemCodeSchema = z.enum(FCP_MISSING_ITEM_CODES);
export const fcpApproximationItemCodeSchema = z.enum(FCP_APPROXIMATION_ITEM_CODES);
export const fcpItemCodeSchema = z.enum(FCP_ITEM_CODES);

export interface FcpClipRef {
  readonly id: string;
  readonly name: string;
  readonly trackLabel?: string | undefined;
}
export const fcpClipRefSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  trackLabel: z.string().min(1).optional(),
}).strict();

export interface FcpItemValues {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly maxErrorFrames?: number | undefined;
}
export const fcpItemValuesSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  maxErrorFrames: z.number().finite().nonnegative().optional(),
}).strict();

export interface FcpItem<Code extends FcpItemCode = FcpItemCode> {
  readonly code: Code;
  readonly clips: ReadonlyArray<FcpClipRef>;
  readonly values?: FcpItemValues | undefined;
}
export const fcpItemSchema = z.object({
  code: fcpItemCodeSchema,
  clips: z.array(fcpClipRefSchema),
  values: fcpItemValuesSchema.optional(),
}).strict();

export const fcpMissingItemSchema = z.object({
  code: fcpMissingItemCodeSchema,
  clips: z.array(fcpClipRefSchema),
  values: fcpItemValuesSchema.optional(),
}).strict();

export const fcpApproximationItemSchema = z.object({
  code: fcpApproximationItemCodeSchema,
  clips: z.array(fcpClipRefSchema),
  values: fcpItemValuesSchema.optional(),
}).strict();

export const fcpExportTimelineSummarySchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  durationFrames: z.number().int().min(0),
  clipCount: z.number().int().min(0),
}).strict();
export type FcpExportTimelineSummary = z.infer<typeof fcpExportTimelineSummarySchema>;

export const fcpExportPreviewInputSchema = z.object({
  projectId: z.string().min(1),
  copyMedia: z.boolean(),
}).strict();
export type FcpExportPreviewInput = z.infer<typeof fcpExportPreviewInputSchema>;

export const fcpExportPreviewOutputSchema = z.object({
  timeline: fcpExportTimelineSummarySchema,
  defaultName: z.string(),
  projectDestination: z.object({
    displayPath: z.string().min(1),
  }).strict(),
  mediaFiles: z.number().int().min(0),
  mediaBytes: z.number().int().min(0),
  missing: z.array(fcpMissingItemSchema),
  approximations: z.array(fcpApproximationItemSchema),
}).strict();
export type FcpExportPreviewOutput = z.infer<typeof fcpExportPreviewOutputSchema>;

export const fcpExportDestinationSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('project')}).strict(),
  z.object({kind: z.literal('chosen'), token: z.string().min(1)}).strict(),
]);
export type FcpExportDestination = z.infer<typeof fcpExportDestinationSchema>;

export const fcpExportStartInputSchema = z.object({
  projectId: z.string().min(1),
  requestId: z.string().min(1),
  name: z.string().min(1),
  copyMedia: z.boolean(),
  destination: fcpExportDestinationSchema,
}).strict();
export type FcpExportStartInput = z.infer<typeof fcpExportStartInputSchema>;

export const fcpExportStartOutputSchema = z.object({
  exportId: z.string().min(1),
}).strict();
export type FcpExportStartOutput = z.infer<typeof fcpExportStartOutputSchema>;

export const fcpExportProgressSchema = z.object({
  files: z.number().int().min(0),
  totalFiles: z.number().int().min(0),
  bytes: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
}).strict();
export type FcpExportProgress = z.infer<typeof fcpExportProgressSchema>;

export const fcpExportResultSchema = z.object({
  bundleName: z.string().min(1),
  displayPath: z.string().min(1),
  bytes: z.number().int().min(0),
  missingCount: z.number().int().min(0),
}).strict();
export type FcpExportResult = z.infer<typeof fcpExportResultSchema>;

export const fcpExportErrorValuesSchema = z.object({
  shortBytes: z.number().int().min(0).optional(),
  file: z.string().optional(),
}).strict();

export const fcpExportErrorSchema = z.object({
  code: z.enum(FCP_EXPORT_ERROR_CODES),
  values: fcpExportErrorValuesSchema.optional(),
}).strict();
export type FcpExportError = z.infer<typeof fcpExportErrorSchema>;

export const fcpExportGetInputSchema = z.object({
  projectId: z.string().min(1),
  exportId: z.string().min(1),
}).strict();
export type FcpExportGetInput = z.infer<typeof fcpExportGetInputSchema>;

export const fcpExportGetOutputSchema = z.object({
  status: z.enum(FCP_EXPORT_STATUSES),
  progress: fcpExportProgressSchema,
  result: fcpExportResultSchema.optional(),
  error: fcpExportErrorSchema.optional(),
}).strict();
export type FcpExportGetOutput = z.infer<typeof fcpExportGetOutputSchema>;

export const fcpExportCancelInputSchema = z.object({
  projectId: z.string().min(1),
  exportId: z.string().min(1),
}).strict();
export type FcpExportCancelInput = z.infer<typeof fcpExportCancelInputSchema>;

export const fcpExportCancelOutputSchema = z.object({
  status: z.enum(['cancelled', 'done', 'failed']),
}).strict();
export type FcpExportCancelOutput = z.infer<typeof fcpExportCancelOutputSchema>;

export const fcpExportSchemas = Object.freeze({
  'export.fcpxml.preview': {
    input: fcpExportPreviewInputSchema,
    output: fcpExportPreviewOutputSchema,
  },
  'export.fcpxml.start': {
    input: fcpExportStartInputSchema,
    output: fcpExportStartOutputSchema,
  },
  'export.fcpxml.get': {
    input: fcpExportGetInputSchema,
    output: fcpExportGetOutputSchema,
  },
  'export.fcpxml.cancel': {
    input: fcpExportCancelInputSchema,
    output: fcpExportCancelOutputSchema,
  },
});
