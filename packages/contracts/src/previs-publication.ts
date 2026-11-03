import {z} from 'zod';
import {assetMediaDtoSchema, ASSET_UPLOAD_MAX_BASE64_LENGTH} from './asset-media.ts';
import {projectIdSchema} from './project-file.ts';
import {previsOutputIdentitySchema} from './previs-output.ts';

/** Public previs output is separate from the fixed model catalog. The backend
 * selects the generated directory and provenance; callers name only the saved
 * scene that was rendered and one stable publication request. */
const identity = previsOutputIdentitySchema.shape;
export const previsPublicationLookupSchema = previsOutputIdentitySchema;
export const previsPublicationInputSchema = z.object({...identity, dataBase64: z.string().min(1).max(ASSET_UPLOAD_MAX_BASE64_LENGTH)}).strict();
export type PrevisPublicationInput = z.infer<typeof previsPublicationInputSchema>;
export type PrevisPublicationLookupInput = z.infer<typeof previsPublicationLookupSchema>;
/** Private completed-render manifest. This is storage validation only and is
 * never an operation input or a client-granted completion capability. */
export const previsPublicationManifestSchema = z.object({version: z.literal(1), identity: previsPublicationLookupSchema, assetId: projectIdSchema, publicationId: projectIdSchema,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u), createdAt: z.string().datetime()}).strict();
export type PrevisPublicationManifest = z.infer<typeof previsPublicationManifestSchema>;
export const previsPublicationSchemas = Object.freeze({
  'previs.output.publish': previsPublicationInputSchema,
  'previs.output.lookup': previsPublicationLookupSchema,
});
export type PrevisPublicationOperation = keyof typeof previsPublicationSchemas;
export const isPrevisPublicationOperation = (value: string): value is PrevisPublicationOperation => Object.hasOwn(previsPublicationSchemas, value);
export const previsPublicationResponseSchema = z.object({...identity, asset: assetMediaDtoSchema}).strict()
  .refine(value => value.asset.projectId === value.projectId && value.asset.name === value.name && value.asset.sizeBytes > 0 && value.asset.mimeType === 'image/png' && value.asset.provenance === 'generated' &&
    value.asset.sha256 === value.sha256 && value.asset.width === value.width && value.asset.height === value.height, 'The asset must match this previs output.');
export type PrevisPublicationResponse = z.infer<typeof previsPublicationResponseSchema>;
export function previsPublicationIdentity(input: PrevisPublicationInput | PrevisPublicationLookupInput): PrevisPublicationLookupInput {
  const {dataBase64: _dataBase64, ...fields} = input as PrevisPublicationInput;
  return previsPublicationLookupSchema.parse(fields);
}
export function isPrevisPublicationResponse(operation: PrevisPublicationOperation, input: unknown, value: unknown): value is PrevisPublicationResponse | null {
  const request = previsPublicationSchemas[operation].safeParse(input);
  if (!request.success) return false;
  if (operation === 'previs.output.lookup' && value === null) return true;
  const result = previsPublicationResponseSchema.safeParse(value);
  if (!result.success) return false;
  const fields = previsPublicationIdentity(request.data);
  return Object.entries(fields).every(([key, expected]) => result.data[key as keyof typeof fields] === expected);
}
export const previsPublicationDescriptions = Object.freeze({
  'previs.output.publish': '将本项目已保存的预演节点关键帧PNG发布至固定生成目录；绑定节点、关键帧、场景修订和稳定requestId，不调用模型、不付费',
  'previs.output.lookup': '按本次预演发布的完整身份与requestId只读查询已登记结果；不按相同图片哈希认领其他素材，不重新发布',
});
const read = {readOnly: true, idempotent: true, destructive: false, openWorld: false, databaseWrite: false, fileWrite: false, externalIO: false, localProcess: false, paidGeneration: false};
export const previsPublicationEffects = Object.freeze({
  'previs.output.publish': Object.freeze({...read, readOnly: false, databaseWrite: true, fileWrite: true,
    notes: 'Publishes one validated PNG for an owned saved previs node/keyframe/revision under an exact request ID. Backend fixes its generated location and provenance. Preserves project files on cancellation or failure; no provider, process or payment.'}),
  'previs.output.lookup': Object.freeze({...read,
    notes: 'Reads only the exact registered previs publication identity and request ID. A missing acknowledgement is not inferred from matching bytes or an unrelated asset. No repair or publication.'}),
});
