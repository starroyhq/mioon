import {z} from 'zod';
import {projectIdSchema, projectMediaPath} from './project-file.ts';
import {
  isNormalizedAbsolutePath, MEDIA_PATH_FORMS, MEDIA_PATH_MAX_LENGTH, mediaFingerprintSchema, mediaReferenceSchema, mediaStatusViewSchema,
} from './media-reference.ts';

/** S1 foundation contracts. They are not registered in the public operation
 * registry until all asset readers and import callers switch together. */
export const ASSET_UPLOAD_MAX_BYTES = 30 * 1024 * 1024;
export const ASSET_UPLOAD_MAX_BASE64_LENGTH = 40 * 1024 * 1024;
export const ASSET_MEDIA_PAGE_LIMIT = 100;
export const MEDIA_FINGERPRINT_TOKEN_VERSION = 1;
export const PROJECT_ASSETS_FOLDER = '素材';

const id = projectIdSchema;
const requestId = z.string().min(8).max(200);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const name = z.string().min(1).max(200);
const absolutePath = z.string().min(1).max(MEDIA_PATH_MAX_LENGTH).refine(isNormalizedAbsolutePath, 'Use a normalized absolute path.');
const mimeType = z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4']);

/** A request ID binds the exact accepted operation input. Reusing it with
 * different uploaded bytes/path/name is a conflict; replay never rereads a new source.
 * No request ID retains the existing upload call's non-idempotent behavior.
 * Upload byte decoding, media probing and the 30 MiB byte check remain backend
 * responsibilities; this preserves the current upload input shape. */
export const assetPathImportSchema = z.object({projectId: id, requestId, sourcePath: absolutePath, name: name.optional()}).strict();
export const assetUploadImportSchema = z.object({
  projectId: id, name, mimeType, dataBase64: z.string().max(ASSET_UPLOAD_MAX_BASE64_LENGTH), requestId: requestId.optional(),
}).strict();
export const assetImportSchema = z.union([assetPathImportSchema, assetUploadImportSchema]);
export type AssetImportInput = z.infer<typeof assetImportSchema>;

const metadata = {
  id, projectId: id, name, mimeType, sizeBytes: count,
  width: z.number().int().nonnegative().max(100000).optional(),
  height: z.number().int().nonnegative().max(100000).optional(),
  duration: z.number().finite().nonnegative().nullable().optional(),
  hasAudio: z.boolean().optional(), hasVideo: z.boolean().optional(),
  provenance: z.enum(['user-import', 'generated', 'synthetic-mock', 'export', 'extracted-frame', 'scene-keyframe']).optional(),
  createdAt: z.string().datetime().optional(),
};

/** Internal persisted record: reference is the only location source. The
 * optional full hash can never be replaced by a sampled hash. */
export const assetMediaRecordSchema = z.object({
  ...metadata, reference: mediaReferenceSchema, referenceRevision: revision, sha256: hash.nullable(),
}).strict().refine(value => value.sha256 === value.reference.fullSha256 && value.sizeBytes === value.reference.sizeBytes,
  'Asset size and full hash must match its reference.');
export type AssetMediaRecord = z.infer<typeof assetMediaRecordSchema>;

/** Public asset metadata contains neither reference paths nor local status.
 * A media URL identifies the asset; the media route still checks availability. */
export const assetMediaDtoSchema = z.object({
  ...metadata, referenceRevision: revision, sha256: hash.nullable(), fingerprint: mediaFingerprintSchema,
  hashState: z.enum(['sampled', 'full']), url: z.string(),
}).strict().refine(value => value.url === projectMediaPath(value.projectId, value.id), 'Use the project media address.')
  .refine(value => value.sha256 === value.fingerprint.fullSha256 && value.sizeBytes === value.fingerprint.sizeBytes &&
    value.hashState === (value.sha256 === null ? 'sampled' : 'full'), 'Full hash state and fingerprint must agree.');
export type AssetMediaDto = z.infer<typeof assetMediaDtoSchema>;

export const assetMediaStateSchema = mediaStatusViewSchema.extend({assetId: id, referenceRevision: revision, fingerprintToken: hash}).strict();
export type AssetMediaState = z.infer<typeof assetMediaStateSchema>;
/** Only trusted project UI responses carry the display path; never forward
 * this shape to a model result or use displayPath as an admitted file path. */
export const assetMediaLocationSchema = z.object({
  assetId: id, displayPath: z.string().min(1).max(MEDIA_PATH_MAX_LENGTH), pathForm: z.enum(MEDIA_PATH_FORMS),
  volume: z.string().min(1).max(255).nullable(), outside: z.boolean(),
}).strict();
export type AssetMediaLocation = z.infer<typeof assetMediaLocationSchema>;

const assetIds = z.array(id).min(1).max(ASSET_MEDIA_PAGE_LIMIT).refine(values => new Set(values).size === values.length, 'Use distinct asset IDs.');
const page = {projectId: id, cursor: id.optional(), limit: z.number().int().min(1).max(ASSET_MEDIA_PAGE_LIMIT).optional()};
const preparedAssets = z.array(z.object({assetId: id, referenceRevision: revision}).strict()).min(1).max(ASSET_MEDIA_PAGE_LIMIT)
  .refine(values => new Set(values.map(value => value.assetId)).size === values.length, 'Use distinct asset IDs.');

/** These inputs describe future handlers, not a model tool allowlist. No
 * schema can grant a directory confirmation or impersonate a UI gesture. */
export const assetMediaSchemas = Object.freeze({
  'asset.media.status.list': z.object({...page, assetIds: assetIds.optional()}).strict(),
  'asset.media.location.list': z.object(page).strict(),
  'asset.media.prepare': z.object({
    projectId: id, assets: preparedAssets, purpose: z.enum(['generation', 'frame', 'scene', 'timeline', 'export']),
  }).strict(),
  'asset.media.relink.preview': z.object({projectId: id, assetId: id, sourcePath: absolutePath, expectedReferenceRevision: revision}).strict(),
  'asset.media.relink.apply': z.object({projectId: id, requestId, previewToken: id}).strict(),
  'asset.media.acceptChanged': z.object({projectId: id, requestId, assetId: id, expectedReferenceRevision: revision}).strict(),
});

/** Keep permission writes separate from generic operations that CLI/MCP may
 * discover. A future trusted desktop/user-CLI adapter must verify the caller
 * and bind the token to that project and exact directory (no descendants).
 * MCP, Mio and other model inputs must never invoke these handlers. */
export const trustedAssetMediaLocationSchemas = Object.freeze({
  'asset.media.outside.confirm': z.object({projectId: id, requestId, locationToken: id}).strict(),
  'asset.media.outside.revoke': z.object({projectId: id, requestId, locationToken: id}).strict(),
});
