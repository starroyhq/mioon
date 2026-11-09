import {z} from 'zod';
import {projectIdSchema, projectMediaPath} from './project-file.ts';
import {projectOutputPublicationProofSchema} from './project-output-publication.ts';
import {frameOutputResultSchema,sceneOutputResultSchema} from './project-output-sources.ts';
import {previsOutputIdentitySchema} from './previs-output.ts';
import {
  isNormalizedAbsolutePath, MEDIA_PATH_FORMS, MEDIA_PATH_MAX_LENGTH, mediaFingerprintSchema, mediaReferenceSchema, mediaStatusViewSchema,
} from './media-reference.ts';

/** Asset references, shared by the project runtime and its explicit clients. */
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
  ...metadata, producer:z.object({kind:z.enum(['generation','export']),id}).strict().optional(), publication:projectOutputPublicationProofSchema.optional(),frameResult:frameOutputResultSchema.optional(),sceneResult:sceneOutputResultSchema.optional(),previsOutput:previsOutputIdentitySchema.optional(), reference: mediaReferenceSchema, referenceRevision: revision, sha256: hash.nullable(),
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

/** Deliberate client composition: paths and permission writes never enter the
 * generic CLI/MCP discovery surface or Mio's model catalog. */
export const assetMediaPublicSchemas = Object.freeze({
  'asset.media.status.list': assetMediaSchemas['asset.media.status.list'],
  'asset.media.prepare': assetMediaSchemas['asset.media.prepare'],
  'asset.media.relink.preview': assetMediaSchemas['asset.media.relink.preview'],
  'asset.media.relink.apply': assetMediaSchemas['asset.media.relink.apply'],
  'asset.media.acceptChanged': assetMediaSchemas['asset.media.acceptChanged'],
});
export const trustedAssetMediaSchemas = Object.freeze({
  ...trustedAssetMediaLocationSchemas,
  'asset.media.location.list': assetMediaSchemas['asset.media.location.list'],
  'asset.import.path': assetPathImportSchema,
});
export type AssetMediaOperation = keyof typeof assetMediaPublicSchemas;
export type TrustedAssetMediaOperation = keyof typeof trustedAssetMediaSchemas;
export const isAssetMediaOperation = (value: string): value is AssetMediaOperation => Object.hasOwn(assetMediaPublicSchemas, value);
export const isTrustedAssetMediaOperation = (value: string): value is TrustedAssetMediaOperation => Object.hasOwn(trustedAssetMediaSchemas, value);
export const assetMediaDescriptions = Object.freeze({
  'asset.media.status.list': '读取有界素材引用状态，不读取未确认位置的媒体内容',
  'asset.media.prepare': '在事务外准备完整素材哈希并按引用修订核对保存，不执行生成',
  'asset.media.relink.preview': '检查用户选择的重新指向候选，不修改素材或确认目录',
  'asset.media.relink.apply': '按预览和引用修订重新指向同内容素材，不改不可变历史',
  'asset.media.acceptChanged': '为已变化内容创建新素材身份，不覆写旧素材或不可变历史',
});
const mediaRead = {readOnly:true,idempotent:true,destructive:false,openWorld:false,databaseWrite:false,fileWrite:false,externalIO:false,localProcess:false,paidGeneration:false,notes:undefined};
export const assetMediaEffects = Object.freeze({
  'asset.media.status.list': Object.freeze({...mediaRead,notes:'Reads bounded local reference metadata/status; no permission confirmation or provider call.'}),
  'asset.media.prepare': Object.freeze({...mediaRead,readOnly:false,databaseWrite:true,notes:'Hashes admitted media and CAS-pins its full hash; no paid work or permission grant.'}),
  'asset.media.relink.preview': Object.freeze({...mediaRead,readOnly:false,idempotent:false,fileWrite:true,notes:'Examines an admitted candidate and writes a private preview token; never changes an asset or grants directory access.'}),
  'asset.media.relink.apply': Object.freeze({...mediaRead,readOnly:false,databaseWrite:true,fileWrite:true,destructive:true,notes:'CAS-updates an asset reference to the same full content under an exact request key.'}),
  'asset.media.acceptChanged': Object.freeze({...mediaRead,readOnly:false,databaseWrite:true,fileWrite:true,notes:'Creates a new asset ID for explicit changed-content acceptance; preserves the old identity/history.'}),
});
export const assetMediaStatusListResponseSchema = z.object({items:z.array(assetMediaStateSchema).max(ASSET_MEDIA_PAGE_LIMIT),nextCursor:id.nullable()}).strict();
export const assetMediaPrepareResponseSchema = z.object({assets:z.array(assetMediaDtoSchema).max(ASSET_MEDIA_PAGE_LIMIT)}).strict();

/** The only public asset projection. No reference path, volume or local status
 * crosses ordinary RPC, project.get, task results or a model projection. */
export function toAssetMediaDto(value:Record<string,unknown>):AssetMediaDto {
  const reference=mediaReferenceSchema.parse(value.reference);
  // Older records use null for unknown dimensions. Omit only that sentinel;
  // the public schema still validates every other metadata value unchanged.
  const visible=Object.fromEntries(Object.keys(metadata).filter(key=>Object.hasOwn(value,key)&&!((key==='width'||key==='height')&&value[key]===null)).map(key=>[key,value[key]]));
  return assetMediaDtoSchema.parse({...visible,referenceRevision:value.referenceRevision,sha256:reference.fullSha256,
    fingerprint:{sizeBytes:reference.sizeBytes,mtimeMs:reference.mtimeMs,sampledSha256:reference.sampledSha256,fullSha256:reference.fullSha256},
    hashState:reference.fullSha256===null?'sampled':'full',url:projectMediaPath(String(value.projectId),String(value.id))});
}
export const generationReferenceRevisionsSchema=z.array(z.object({assetId:id,referenceRevision:revision,sha256:hash}).strict()).max(40);

export const nativeAssetImportRequestSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('choose')}).strict(),
  z.object({action:z.literal('drop'),paths:z.array(absolutePath).min(1).max(100)}).strict(),
  z.object({action:z.literal('import'),token:id,requestId}).strict(),
]);
export const nativeAssetImportResponseSchema=z.object({asset:assetMediaDtoSchema,confirmedDirectories:z.array(absolutePath).max(100)}).strict();

export function publicMediaFingerprint(value:unknown):z.infer<typeof mediaFingerprintSchema> {
  const reference=mediaReferenceSchema.parse(value);
  return {sizeBytes:reference.sizeBytes,mtimeMs:reference.mtimeMs,sampledSha256:reference.sampledSha256,fullSha256:reference.fullSha256};
}
