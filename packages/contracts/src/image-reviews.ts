type Rec = Record<string, unknown>;
import {z} from 'zod';
import {canonicalImageInput, imageSchemas, imageEditSourceSchema} from './images.ts';
import {customImageConfigurationSchema, isCompleteCustomImageConfiguration, getCustomImageDestination, CUSTOM_IMAGE_ENDPOINT_LIMIT} from './image-settings.ts';
import {comfyImageConfigurationSchema,isCompleteComfyImageConfiguration,getComfyImageDestination,comfyImageExecutionSchema,comfyImagePolicySchema} from './comfy-images.ts';

// Strict additive edit branches leave historical text-to-image receipts intact.
// Review preparation is not authority to send. Approval is a private UI route,
// never a discoverable RPC, CLI, MCP, or Agent operation.
export const IMAGE_EDIT_REVIEW_DESTINATION = 'https://api.openai.com/v1/images/edits';
export const IMAGE_REVIEW_DESTINATION = 'https://api.openai.com/v1/images/generations';
export const IMAGE_REVIEW_POLICY = Object.freeze({maxPostAttempts: 1, automaticRetry: false,
  price: 'usage-based-unknown', promptStorage: 'local-plaintext'});
export const IMAGE_REVIEW_STATES = Object.freeze(['pending', 'approved', 'rejected', 'dispatched'] as const);
export const IMAGE_REVIEW_LIMITS = Object.freeze({intentBytes: 32768, rowBytes: 65536,
  reviewsPerProject: 1000, reviewsGlobal: 10000, pageSize: 20, maxPageSize: 50, cursorCharacters: 768});
const id = z.string().uuid(), revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const key = z.string().min(8).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().min(1).max(40).refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp');
const generation = imageSchemas['image.generate'].refine(value => value.providerId !== 'mock', 'Only live image requests need a review');
const officialGeneration = generation.refine(value => value.providerId === 'openai' && (value as {purpose?: unknown}).purpose === undefined);
const officialEdit = generation.refine(value => value.providerId === 'openai' && (value as {purpose?: unknown}).purpose === 'edit');
interface ReviewEditSourceValues {input?: unknown; sourceImage?: unknown}
const matchesEditSource = (value: ReviewEditSourceValues): boolean => {
  const input = value?.input as {inputImage?: {assetId?: unknown; sha256?: unknown}} | undefined;
  const sourceImage = value?.sourceImage as {assetId?: unknown; sha256?: unknown} | undefined;
  return typeof input?.inputImage?.assetId === 'string' && input.inputImage.assetId === sourceImage?.assetId && input.inputImage.sha256 === sourceImage?.sha256;
};
const customGeneration = generation.refine(value => value.providerId === 'openai-compatible');
const comfyGeneration = generation.refine(value => value.providerId === 'comfy-local');
const reviewedComfyConfiguration = comfyImageConfigurationSchema.refine(value=>value.enabled&&isCompleteComfyImageConfiguration(value));
interface ReviewComfyConfigurationValues {
  configuration?: unknown;
  input?: {model?: unknown; options?: unknown; prompt?: unknown};
  destination?: unknown;
  execution?: {graph?: Record<string, {inputs?: Record<string, unknown>} | undefined>};
}
const matchesComfyConfiguration=(value: ReviewComfyConfigurationValues): boolean=>isCompleteComfyImageConfiguration(value.configuration)&&(value.configuration as {enabled?: boolean}).enabled===true&&value.input?.model===(value.configuration as {model?: unknown}).model&&canonicalImageInput(value.input?.options)===canonicalImageInput((value.configuration as {options?: unknown}).options)&&
  value.destination===getComfyImageDestination((value.configuration as {baseUrl: string}).baseUrl)&&value.execution?.graph?.['1']?.inputs?.ckpt_name===value.input?.model&&value.execution?.graph?.['3']?.inputs?.text===value.input?.prompt;
const reviewedConfiguration = customImageConfigurationSchema.refine(value => value.enabled && isCompleteCustomImageConfiguration(value));
const customDestination = z.string().min(1).max(CUSTOM_IMAGE_ENDPOINT_LIMIT);
interface ReviewCustomConfigurationValues {
  configuration?: unknown;
  input?: {model?: unknown; options?: unknown};
  destination?: unknown;
}
const matchesConfiguration = (value: ReviewCustomConfigurationValues): boolean => isCompleteCustomImageConfiguration(value.configuration) && (value.configuration as {enabled?: boolean}).enabled===true && value.input?.model === (value.configuration as {model?: unknown}).model &&
  canonicalImageInput(value.input?.options) === canonicalImageInput((value.configuration as {options?: unknown}).options) &&
  value.destination === getCustomImageDestination((value.configuration as {baseUrl: string}).baseUrl);
export const imageReviewPolicySchema = z.object({maxPostAttempts: z.literal(1), automaticRetry: z.literal(false),
  price: z.literal('usage-based-unknown'), promptStorage: z.literal('local-plaintext')}).strict();
export const imageReviewSchemas = Object.freeze({
  'image.review.prepare': z.object({input: generation, settingsRevision: revision}).strict(),
  'image.review.get': z.object({projectId: id, reviewId: id}).strict(),
  'image.review.list': z.object({projectId: id,
    limit: z.number().int().min(1).max(IMAGE_REVIEW_LIMITS.maxPageSize).optional(),
    cursor: z.string().min(1).max(IMAGE_REVIEW_LIMITS.cursorCharacters).optional()}).strict(),
});
// Deliberately not part of imageReviewSchemas or any public operation map.
export const imageReviewApprovalSchema = z.object({projectId: id, reviewId: id, expectedRevision: revision}).strict();
export const imageReviewRejectionSchema = imageReviewApprovalSchema;
const officialIntent = z.object({schemaVersion: z.literal(1), reviewId: id,
  input: officialGeneration, settingsRevision: revision, destination: z.literal(IMAGE_REVIEW_DESTINATION),
  policy: imageReviewPolicySchema}).strict();
const customIntent = z.object({schemaVersion: z.literal(2), reviewId: id,
  input: customGeneration, settingsRevision: revision, destination: customDestination,
  policy: imageReviewPolicySchema, configuration: reviewedConfiguration}).strict().refine(matchesConfiguration, 'Custom review configuration mismatch');
const comfyIntent=z.object({schemaVersion:z.literal(3),reviewId:id,input:comfyGeneration,settingsRevision:revision,destination:z.string().max(80),
  policy:comfyImagePolicySchema,configuration:reviewedComfyConfiguration,execution:comfyImageExecutionSchema}).strict().refine(matchesComfyConfiguration,'Local review configuration mismatch');
const editIntent = z.object({schemaVersion:z.literal(4),reviewId:id,input:officialEdit,settingsRevision:revision,
 destination:z.literal(IMAGE_EDIT_REVIEW_DESTINATION),policy:imageReviewPolicySchema,sourceImage:imageEditSourceSchema}).strict().refine(matchesEditSource,'Edit source identity mismatch');
export const imageReviewIntentSchema = z.union([officialIntent, customIntent, comfyIntent, editIntent]);
const responseFields = {id, projectId: id, requestId: key, input: officialGeneration,
  inputHash: hash, settingsRevision: revision, destination: z.literal(IMAGE_REVIEW_DESTINATION), policy: imageReviewPolicySchema,
  state: z.enum(IMAGE_REVIEW_STATES), revision, taskId: id.nullable(), postAttempts: z.number().int().min(0).max(1),
  createdAt: timestamp, updatedAt: timestamp, approvedAt: timestamp.nullable(), rejectedAt: timestamp.nullable(), dispatchedAt: timestamp.nullable(),
};
interface ReviewResponseValues {
  input: {projectId?: unknown; requestId?: unknown};
  projectId?: unknown;
  requestId?: unknown;
  state?: string;
  taskId?: unknown;
  approvedAt?: unknown;
  rejectedAt?: unknown;
  dispatchedAt?: unknown;
  postAttempts?: unknown;
  revision?: unknown;
}
const verifyResponse = (value: ReviewResponseValues, context: z.RefinementCtx) => {
  const issue = (message: string) => context.addIssue({code: z.ZodIssueCode.custom, message});
  if (value.input.projectId !== value.projectId || value.input.requestId !== value.requestId) issue('Review identity mismatch');
  const approved = value.state === 'approved' || value.state === 'dispatched';
  if ((value.taskId !== null) !== approved || (value.approvedAt !== null) !== approved) issue('Approval reservation mismatch');
  if ((value.rejectedAt !== null) !== (value.state === 'rejected')) issue('Rejection mismatch');
  if ((value.dispatchedAt !== null) !== (value.state === 'dispatched') || value.postAttempts !== Number(value.state === 'dispatched')) issue('POST fence mismatch');
  if (value.revision !== ({pending: 1, approved: 2, rejected: 2, dispatched: 3} as Record<string, number>)[value.state as string]) issue('Review revision mismatch');
};
const officialResponse = z.object(responseFields).strict().superRefine(verifyResponse);
const customResponse = z.object({...responseFields, input: customGeneration, destination: customDestination, configuration: reviewedConfiguration})
  .strict().refine(matchesConfiguration, 'Custom review configuration mismatch').superRefine(verifyResponse);
const comfyResponse=z.object({...responseFields,input:comfyGeneration,destination:z.string().max(80),policy:comfyImagePolicySchema,configuration:reviewedComfyConfiguration,execution:comfyImageExecutionSchema})
  .strict().refine(matchesComfyConfiguration,'Local review configuration mismatch').superRefine(verifyResponse);
const editResponse=z.object({...responseFields,input:officialEdit,destination:z.literal(IMAGE_EDIT_REVIEW_DESTINATION),sourceImage:imageEditSourceSchema})
 .strict().refine(matchesEditSource,'Edit source identity mismatch').superRefine(verifyResponse);
export const imageReviewResponseSchema = z.union([officialResponse, customResponse, comfyResponse, editResponse]);
export type ImageReviewResponse = z.infer<typeof imageReviewResponseSchema>;
export const isImageReviewResponse = (value: unknown): value is ImageReviewResponse => imageReviewResponseSchema.safeParse(value).success;
export function isImageReviewListResponse(input: unknown, result: unknown): boolean {
  const request = input as Rec;
  if (!imageReviewSchemas['image.review.list'].safeParse(input).success || !result || typeof result !== 'object' || Array.isArray(result)) return false;
  const response = result as Rec;
  if (Object.keys(response).sort().join(',') !== 'items,nextCursor,projectId' || response.projectId !== request.projectId || !Array.isArray(response.items) ||
      response.items.length > ((request.limit as number | undefined) ?? IMAGE_REVIEW_LIMITS.pageSize) || response.nextCursor !== null &&
      (typeof response.nextCursor !== 'string' || !response.nextCursor.length || response.nextCursor.length > IMAGE_REVIEW_LIMITS.cursorCharacters)) return false;
  const items = response.items as Rec[];
  return new Set(items.map(value => value?.id)).size === items.length && items.every(value => isImageReviewResponse(value) && value.projectId === request.projectId);
}
export function isImageReviewPreparationResponse(input: unknown, result: unknown): boolean {
  if (!imageReviewSchemas['image.review.prepare'].safeParse(input).success || !isImageReviewResponse(result)) return false;
  const request = input as Rec;
  return result.settingsRevision === request.settingsRevision && canonicalImageInput(result.input) === canonicalImageInput(request.input);
}
