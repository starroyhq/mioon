import {z} from 'zod';
import {
  FCP_ITEM_CODES, FCP_MISSING_ITEM_CODES, fcpExportPreviewOutputSchema, fcpExportSchemas,
  fcpItemSchema, fcpMissingItemSchema,
} from './fcp-export.ts';
import type {FcpItemCode} from './fcp-export.ts';

export const PREMIERE_EXPORT_TASK_KIND = 'premiere-export' as const;
export const PREMIERE_EXPORT_OPERATIONS = Object.freeze([
  'export.premiere.preview',
  'export.premiere.start',
  'export.premiere.get',
  'export.premiere.cancel',
] as const);
export type PremiereExportOperation = (typeof PREMIERE_EXPORT_OPERATIONS)[number];
export type PremiereItemCode = FcpItemCode | 'SUBTITLES';

export const PREMIERE_MISSING_ITEM_CODES = Object.freeze([...FCP_MISSING_ITEM_CODES, 'SUBTITLES'] as const);
export const PREMIERE_ITEM_CODES = Object.freeze([...FCP_ITEM_CODES, 'SUBTITLES'] as const);
export type PremiereMissingItemCode = (typeof PREMIERE_MISSING_ITEM_CODES)[number];
export const premiereItemCodeSchema = z.enum(PREMIERE_ITEM_CODES);
export const premiereMissingItemCodeSchema = z.enum(PREMIERE_MISSING_ITEM_CODES);
export const premiereItemSchema = fcpItemSchema.extend({code: premiereItemCodeSchema});
export const premiereMissingItemSchema = fcpMissingItemSchema.extend({code: premiereMissingItemCodeSchema});
export const premiereExportPreviewOutputSchema = fcpExportPreviewOutputSchema.extend({
  missing: z.array(premiereMissingItemSchema),
});
export type PremiereExportPreviewOutput = z.infer<typeof premiereExportPreviewOutputSchema>;

export {
  fcpExportPreviewInputSchema as premiereExportPreviewInputSchema,
  fcpExportStartInputSchema as premiereExportStartInputSchema,
  fcpExportStartOutputSchema as premiereExportStartOutputSchema,
  fcpExportGetInputSchema as premiereExportGetInputSchema,
  fcpExportGetOutputSchema as premiereExportGetOutputSchema,
  fcpExportCancelInputSchema as premiereExportCancelInputSchema,
  fcpExportCancelOutputSchema as premiereExportCancelOutputSchema,
} from './fcp-export.ts';
export type {
  FcpExportPreviewInput as PremiereExportPreviewInput,
  FcpExportStartInput as PremiereExportStartInput,
  FcpExportStartOutput as PremiereExportStartOutput,
  FcpExportGetInput as PremiereExportGetInput,
  FcpExportGetOutput as PremiereExportGetOutput,
  FcpExportCancelInput as PremiereExportCancelInput,
  FcpExportCancelOutput as PremiereExportCancelOutput,
} from './fcp-export.ts';

export const premiereExportSchemas = Object.freeze({
  'export.premiere.preview': {
    ...fcpExportSchemas['export.fcpxml.preview'],
    output: premiereExportPreviewOutputSchema,
  },
  'export.premiere.start': fcpExportSchemas['export.fcpxml.start'],
  'export.premiere.get': fcpExportSchemas['export.fcpxml.get'],
  'export.premiere.cancel': fcpExportSchemas['export.fcpxml.cancel'],
});
