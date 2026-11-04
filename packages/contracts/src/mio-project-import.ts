import {z} from 'zod';
import {assetMediaDtoSchema, assetPathImportSchema} from './asset-media.ts';
import {isMioProjectMediaRelativePath, MIO_PROJECT_MEDIA_LIMITS} from './mio-project-media.ts';
import {projectIdSchema} from './project-file.ts';

export const MIO_PROJECT_FILE_IMPORT_TOOL = 'mioon_asset_import_project_file';
export const MIO_PROJECT_FILE_IMPORT_OPERATION = 'asset.importProjectFile';

/** Only the trusted host supplies the owner, original request and source path. */
export const mioProjectFileImportInputSchema = z.object({
  path: z.string().min(1).max(MIO_PROJECT_MEDIA_LIMITS.pathBytes)
    .refine(value => isMioProjectMediaRelativePath(value), 'Use a visible project-relative file.'),
  name: assetPathImportSchema.shape.name,
}).strict();
export type MioProjectFileImportInput = z.infer<typeof mioProjectFileImportInputSchema>;

export const mioProjectFileImportResultSchema = z.object({
  registration: z.enum(['created', 'reused']),
  assetId: projectIdSchema,
  asset: assetMediaDtoSchema,
}).strict().refine(value => value.assetId === value.asset.id, 'The registration must identify the returned asset.');
export type MioProjectFileImportResult = z.infer<typeof mioProjectFileImportResultSchema>;
