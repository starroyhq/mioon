import {z} from 'zod';
import {assetUploadImportSchema} from './asset-media.ts';

export const MIO_PROJECT_MEDIA_LIST_TOOL = 'mioon_project_media_list';
export const MIO_PROJECT_MEDIA_LIST_OPERATION = 'project.media.list';
export const MIO_PROJECT_MEDIA_LIMITS = Object.freeze({
  defaultLimit: 50, maxLimit: 100, pathBytes: 4096, cursorBytes: 2048,
  resultBytes: 16 * 1024, scanEntries: 5000,
});
const encoder = new TextEncoder();
const deviceName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;

/** A narrow portable spelling, never a grant or a normalized file path. */
export function isMioProjectMediaRelativePath(value: string, allowRoot = false): boolean {
  if (value === '') return allowRoot;
  if (value.length > MIO_PROJECT_MEDIA_LIMITS.pathBytes || /^[\/\\]/u.test(value) || /[\\\u0000-\u001f\u007f-\u009f<>:"|?*]/u.test(value)) return false;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  if (encoder.encode(value).length > MIO_PROJECT_MEDIA_LIMITS.pathBytes) return false;
  return value.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.') &&
    !part.endsWith(' ') && !deviceName.test(part.split('.')[0]!.trimEnd()));
}

const directory = z.string().max(MIO_PROJECT_MEDIA_LIMITS.pathBytes)
  .refine(value => isMioProjectMediaRelativePath(value, true), 'Use a project-relative directory.');
const cursor = z.string().min(1).max(MIO_PROJECT_MEDIA_LIMITS.cursorBytes)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const mioProjectMediaListInputSchema = z.object({
  directory: directory.optional(),
  limit: z.number().int().min(1).max(MIO_PROJECT_MEDIA_LIMITS.maxLimit).optional(),
  cursor: cursor.optional(),
}).strict();
export type MioProjectMediaListInput = z.infer<typeof mioProjectMediaListInputSchema>;

export const mioProjectMediaEntrySchema = z.object({
  name: z.string().min(1).max(MIO_PROJECT_MEDIA_LIMITS.pathBytes).refine(value =>
    !value.includes('/') && isMioProjectMediaRelativePath(value), 'Use one visible entry name.'),
  kind: z.enum(['folder', 'image', 'audio', 'video']),
  mimeType: assetUploadImportSchema.shape.mimeType.nullable(),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  durationSeconds: z.number().finite().nonnegative().nullable(),
}).strict().refine(value => value.kind === 'folder'
  ? value.mimeType === null && value.sizeBytes === null && value.durationSeconds === null
  : value.mimeType !== null && value.sizeBytes !== null && value.mimeType.startsWith(value.kind + '/') &&
    (value.kind !== 'image' || value.durationSeconds === null), 'Entry metadata must match its kind.');
export type MioProjectMediaEntry = z.infer<typeof mioProjectMediaEntrySchema>;
export const mioProjectMediaListingSchema = z.object({
  directory,
  entries: z.array(mioProjectMediaEntrySchema).max(MIO_PROJECT_MEDIA_LIMITS.maxLimit),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
}).strict().refine(value => new Set(value.entries.map(entry => entry.name)).size === value.entries.length,
  'Entry names must be unique.')
  .refine(value => value.nextCursor === null || value.truncated && value.entries.length > 0,
    'A continuation must advance a truncated page.')
  .refine(value => encoder.encode(JSON.stringify(value)).length <= MIO_PROJECT_MEDIA_LIMITS.resultBytes,
    'Listing exceeds its bounded result budget.');
export type MioProjectMediaListing = z.infer<typeof mioProjectMediaListingSchema>;

/** Trusted business port. Neither its owner nor its fence comes from a model. */
export interface MioProjectMediaPort {
  list(projectId: string, input: MioProjectMediaListInput,
    context: {readonly signal?: AbortSignal; readonly beforeEffect: () => void}): Promise<MioProjectMediaListing>;
}
