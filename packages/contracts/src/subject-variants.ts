import {z} from 'zod';
import {IMAGE_MODELS, IMAGE_STATES, imageSchemas} from './images.ts';
import {IMAGE_EDIT_SOURCE_MIME_TYPES, imageEditProfile, isImageEditOutputSize} from './image-edit-profiles.ts';

type Rec = Record<string, unknown>;
// Subject angle and lighting variants. One batch edits one subject version
// into up to eight new versions through the image edit pipeline; each result
// becomes a subject version that carries its variant and never becomes the
// subject's default (head) version. Undoing a batch hides its versions; the
// images stay in the library.
export const SUBJECT_VARIANT_KINDS = Object.freeze(['angle', 'light'] as const);
// Eight camera positions around the subject, seen from above with the subject
// facing the camera ("front"), plus high and low shots taken from the front.
export const SUBJECT_ANGLE_POSITIONS = Object.freeze(['front', 'front-left', 'left', 'back-left', 'back', 'back-right', 'right', 'front-right', 'high', 'low'] as const);
export const SUBJECT_ANGLE_FOCALS = Object.freeze(['standard', 'wide'] as const);
export const SUBJECT_LIGHT_QUALITIES = Object.freeze(['soft', 'hard', 'back'] as const);
// Only characters and products have a stable look to re-shoot.
export const SUBJECT_VARIANT_SUBJECT_KINDS = Object.freeze(['character', 'product'] as const);
export const SUBJECT_VARIANT_MUTATION_OPERATIONS = Object.freeze(['subject.variants.create', 'subject.variants.retry', 'subject.variants.undo'] as const);
export const SUBJECT_VARIANT_ITEM_STATUSES = Object.freeze(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'unknown', 'recoverable', 'undone'] as const);
// Undo checks run in this order; the first one found is the reason shown.
export const SUBJECT_VARIANT_UNDO_BLOCKERS = Object.freeze(['IN_PROGRESS', 'UNKNOWN', 'BOUND', 'GENERATED', 'SOURCE'] as const);
export const SUBJECT_VARIANT_LIMITS = Object.freeze({
  // Each project queues at most eight image tasks, so one batch fits the queue.
  items: 8, lightItems: 1, attempts: 64,
  inputBytes: 8192, snapshotBytes: 49152, responseBytes: 65536, pageSize: 20, maxPageSize: 50,
  batchesPerProject: 1024, batchesGlobal: 8192, requestsPerProject: 4096, requestsGlobal: 32768, blockers: 64,
});
export const SUBJECT_VARIANT_REQUEST_PREFIX = 'subject-variant:';
export const subjectVariantImageRequestId = (batchId: string, position: number, attempt: number): string => `${SUBJECT_VARIANT_REQUEST_PREFIX}${batchId}:${position}:${attempt}`;

const id = z.string().uuid(), key = z.string().min(8).max(200), revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().min(1).max(40), position = z.number().int().min(1).max(SUBJECT_VARIANT_LIMITS.items);
const angleSpec = z.object({kind: z.literal('angle'), position: z.enum(SUBJECT_ANGLE_POSITIONS), focal: z.enum(SUBJECT_ANGLE_FOCALS)}).strict();
// Azimuth 0 is the camera direction, positive to the subject's right; positive
// elevation is above. Colour temperature is in steps of 100 K.
const lightSpec = z.object({kind: z.literal('light'), azimuth: z.number().int().min(-180).max(180), elevation: z.number().int().min(-90).max(90),
  quality: z.enum(SUBJECT_LIGHT_QUALITIES), kelvin: z.number().int().min(2000).max(10000).multipleOf(100)}).strict();
export const subjectVariantSpecSchema = z.union([angleSpec, lightSpec]);
export type SubjectVariantSpec = z.infer<typeof subjectVariantSpecSchema>;
// The record kept on a subject version: its spec plus where it came from.
export const subjectVersionVariantSchema = z.union([angleSpec.extend({batchId: id, sourceVersionId: id}).strict(), lightSpec.extend({batchId: id, sourceVersionId: id}).strict()]);
export type SubjectVersionVariant = z.infer<typeof subjectVersionVariantSchema>;
const specKey = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const canonicalSubjectVariantInput = specKey;

const createInput = z.object({projectId: id, subjectId: id, sourceVersionId: id, kind: z.enum(SUBJECT_VARIANT_KINDS),
  items: z.array(subjectVariantSpecSchema).min(1).max(SUBJECT_VARIANT_LIMITS.items), providerId: z.enum(['mock', 'openai']), model: z.string().min(1).max(100), requestId: key}).strict()
  .refine(value => value.items.every(item => item.kind === value.kind), 'Every item must match the batch kind')
  .refine(value => value.kind !== 'light' || value.items.length <= SUBJECT_VARIANT_LIMITS.lightItems, 'A lighting batch makes one image')
  .refine(value => new Set(value.items.map(specKey)).size === value.items.length, 'Items must be distinct')
  .refine(value => (IMAGE_MODELS as Record<string, string>)[value.providerId] === value.model, 'Model does not belong to provider');
export const subjectVariantSchemas = Object.freeze({
  'subject.variants.create': createInput,
  'subject.variants.retry': z.object({projectId: id, batchId: id, position, expectedRevision: revision, requestId: key}).strict(),
  'subject.variants.undo': z.object({projectId: id, batchId: id, expectedRevision: revision, requestId: key}).strict(),
  'subject.variants.get': z.object({projectId: id, batchId: id}).strict(),
  'subject.variants.list': z.object({projectId: id, subjectId: id, limit: z.number().int().min(1).max(SUBJECT_VARIANT_LIMITS.maxPageSize).optional(),
    cursor: z.string().min(1).max(768).optional()}).strict(),
});
export const subjectVariantDescriptions = Object.freeze({
  'subject.variants.create': '为角色或产品主体的一个版本记录一批补角度或打光，并返回每张图要提交的图片编辑请求；本身不提交请求、不生成图片、不付费，也不改变默认版本；使用必填稳定requestId精确重放',
  'subject.variants.retry': '为一批补角度或打光中被服务商拒绝或未发出就取消的单张换一个新的图片请求；生成中或结果未知时不能重试；使用必填稳定requestId精确重放',
  'subject.variants.undo': '撤销一批补角度或打光：隐藏这批版本，图片留在素材库；还有图片在生成或结果未知，或者其中一张已被镜头、生成或其他批次用到时不能撤销；使用必填稳定requestId精确重放',
  'subject.variants.get': '只读获取一批补角度或打光的进度、每张的状态和能否撤销；不读取媒体，不提交请求',
  'subject.variants.list': '分页只读列出一个主体的补角度和打光批次；能否撤销需逐批读取',
});

// Frozen at acceptance: the source image, the model and output size, and each
// item's name and prompt. An item's image request is derived from it and its attempt.
export const subjectVariantSnapshotSchema = z.object({schemaVersion: z.literal(1), projectId: id, batchId: id, subjectId: id,
  subjectKind: z.enum(SUBJECT_VARIANT_SUBJECT_KINDS), subjectName: z.string().min(1).max(120), sourceVersionId: id,
  source: z.object({assetId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.enum(IMAGE_EDIT_SOURCE_MIME_TYPES),
    width: z.number().int().min(1).max(100000), height: z.number().int().min(1).max(100000), byteLength: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), number: revision}).strict(),
  kind: z.enum(SUBJECT_VARIANT_KINDS), providerId: z.enum(['mock', 'openai']), model: z.string().min(1).max(100), size: z.string().min(7).max(11),
  items: z.array(z.object({position, spec: subjectVariantSpecSchema, name: z.string().min(1).max(120), prompt: z.string().min(1).max(2000)}).strict()).min(1).max(SUBJECT_VARIANT_LIMITS.items)}).strict()
  .refine(value => value.items.every((item, index) => item.position === index + 1 && item.spec.kind === value.kind), 'Items are numbered from one and match the batch kind')
  .refine(value => isImageEditOutputSize(imageEditProfile(value.providerId, value.model), value.size), 'Size must be a model edit size');
export type SubjectVariantSnapshot = z.infer<typeof subjectVariantSnapshotSchema>;

const imageInput = imageSchemas['image.generate'];
const imageState = z.object({taskId: id, state: z.enum(IMAGE_STATES), dispatched: z.boolean(), errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable()}).strict();
export const subjectVariantItemSchema = z.object({position, spec: subjectVariantSpecSchema, attempt: z.number().int().min(1).max(SUBJECT_VARIANT_LIMITS.attempts),
  imageInput, versionId: id.nullable(), image: imageState.nullable(), status: z.enum(SUBJECT_VARIANT_ITEM_STATUSES)}).strict()
  .refine(value => (value.imageInput as Rec).purpose === 'edit', 'A variant is an image edit')
  .refine(value => (value.status === 'succeeded') === (value.versionId !== null) || value.status === 'undone', 'Only finished items have a version');
export const subjectVariantBlockerSchema = z.object({code: z.enum(SUBJECT_VARIANT_UNDO_BLOCKERS), position, shotId: id.optional(), batchId: id.optional()}).strict();
export type SubjectVariantBlocker = z.infer<typeof subjectVariantBlockerSchema>;
export const subjectVariantBatchSchema = z.object({id, projectId: id, subjectId: id, sourceVersionId: id, kind: z.enum(SUBJECT_VARIANT_KINDS), requestId: key,
  providerId: z.enum(['mock', 'openai']), model: z.string().min(1).max(100), size: z.string().min(7).max(11), state: z.enum(['active', 'undone']), revision,
  items: z.array(subjectVariantItemSchema).min(1).max(SUBJECT_VARIANT_LIMITS.items),
  // Live reads of one batch say whether it can still be undone; lists and receipts carry null.
  undo: z.object({available: z.boolean(), blockers: z.array(subjectVariantBlockerSchema).max(SUBJECT_VARIANT_LIMITS.blockers)}).strict().nullable(),
  createdAt: timestamp, updatedAt: timestamp}).strict()
  .refine(value => isImageEditOutputSize(imageEditProfile(value.providerId, value.model), value.size), 'Size must be a model edit size')
  .refine(value => value.items.every((item, index) => item.position === index + 1 && item.spec.kind === value.kind), 'Items are numbered from one and match the batch kind')
  .refine(value => value.state === 'active' || value.items.every(item => item.status === 'undone'), 'An undone batch has only undone items')
  .refine(value => value.undo === null || value.undo.available === (value.undo.blockers.length === 0 && value.state === 'active'), 'Undo availability must follow its blockers');
export type SubjectVariantBatch = z.infer<typeof subjectVariantBatchSchema>;
export type SubjectVariantItem = z.infer<typeof subjectVariantItemSchema>;
export const isSubjectVariantBatch = (value: unknown): value is SubjectVariantBatch => subjectVariantBatchSchema.safeParse(value).success;

const schemaFor = (operation: string): z.ZodTypeAny | null => Object.hasOwn(subjectVariantSchemas, operation) ? (subjectVariantSchemas as Record<string, z.ZodTypeAny>)[operation]! : null;
/** The acknowledgement a variant mutation must return for its exact input. */
export function isSubjectVariantMutationResponse(operation: unknown, input: unknown, result: unknown): boolean {
  const schema = typeof operation === 'string' ? schemaFor(operation) : null;
  if (!schema || !(SUBJECT_VARIANT_MUTATION_OPERATIONS as readonly unknown[]).includes(operation) || !schema.safeParse(input).success || !isSubjectVariantBatch(result)) return false;
  const request = input as Rec, value = result;
  if (value.projectId !== request.projectId || value.undo !== null) return false;
  if (operation === 'subject.variants.create') return value.requestId === request.requestId && value.subjectId === request.subjectId && value.sourceVersionId === request.sourceVersionId &&
    value.kind === request.kind && value.providerId === request.providerId && value.model === request.model && value.state === 'active' && value.revision === 1 &&
    specKey(value.items.map(item => item.spec)) === specKey(request.items) && value.items.every(item => item.attempt === 1 && item.versionId === null);
  if (value.id !== request.batchId || value.revision !== (request.expectedRevision as number) + 1) return false;
  if (operation === 'subject.variants.undo') return value.state === 'undone';
  const item = value.items[(request.position as number) - 1];
  return value.state === 'active' && item !== undefined && item.attempt > 1 && item.versionId === null && item.image === null && item.status === 'pending';
}
export function isSubjectVariantListResponse(input: unknown, result: unknown): boolean {
  if (!subjectVariantSchemas['subject.variants.list'].safeParse(input).success || !result || typeof result !== 'object' || Array.isArray(result)) return false;
  const request = input as Rec, page = result as Rec;
  if (Object.keys(page).sort().join(',') !== 'items,nextCursor,projectId' || page.projectId !== request.projectId || !Array.isArray(page.items) ||
      page.items.length > ((request.limit as number | undefined) ?? SUBJECT_VARIANT_LIMITS.pageSize) || page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor.length > 768)) return false;
  const items = page.items as unknown[];
  return new Set(items.map(item => (item as Rec)?.id)).size === items.length && items.every(item => isSubjectVariantBatch(item) && item.projectId === request.projectId &&
    item.subjectId === request.subjectId && item.undo === null);
}
