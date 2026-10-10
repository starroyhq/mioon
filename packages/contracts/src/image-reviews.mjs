import {z} from 'zod';
import {canonicalImageInput, imageSchemas} from './images.mjs';
import {customImageConfigurationSchema, isCompleteCustomImageConfiguration, getCustomImageDestination, CUSTOM_IMAGE_ENDPOINT_LIMIT} from './image-settings.mjs';

// This contract intentionally leaves image.generate and its old receipts intact.
// Review preparation is not authority to send. Approval is a private UI route,
// never a discoverable RPC, CLI, MCP, or Agent operation.
export const IMAGE_REVIEW_DESTINATION = 'https://api.openai.com/v1/images/generations';
export const IMAGE_REVIEW_POLICY = Object.freeze({maxPostAttempts: 1, automaticRetry: false,
  price: 'usage-based-unknown', promptStorage: 'local-plaintext'});
export const IMAGE_REVIEW_STATES = Object.freeze(['pending', 'approved', 'rejected', 'dispatched']);
export const IMAGE_REVIEW_LIMITS = Object.freeze({intentBytes: 32768, rowBytes: 65536,
  reviewsPerProject: 1000, reviewsGlobal: 10000, pageSize: 20, maxPageSize: 50, cursorCharacters: 768});
const id = z.string().uuid(), revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const key = z.string().min(8).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().min(1).max(40).refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp');
const generation = imageSchemas['image.generate'].refine(value => value.providerId !== 'mock', 'Only live image requests need a review');
const officialGeneration = generation.refine(value => value.providerId === 'openai');
const customGeneration = generation.refine(value => value.providerId === 'openai-compatible');
const reviewedConfiguration = customImageConfigurationSchema.refine(value => value.enabled && isCompleteCustomImageConfiguration(value));
const customDestination = z.string().min(1).max(CUSTOM_IMAGE_ENDPOINT_LIMIT);
const matchesConfiguration = value => isCompleteCustomImageConfiguration(value.configuration) && value.configuration.enabled && value.input.model === value.configuration.model &&
  canonicalImageInput(value.input.options) === canonicalImageInput(value.configuration.options) &&
  value.destination === getCustomImageDestination(value.configuration.baseUrl);
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
export const imageReviewIntentSchema = z.union([officialIntent, customIntent]);
const responseFields = {id, projectId: id, requestId: key, input: officialGeneration,
  inputHash: hash, settingsRevision: revision, destination: z.literal(IMAGE_REVIEW_DESTINATION), policy: imageReviewPolicySchema,
  state: z.enum(IMAGE_REVIEW_STATES), revision, taskId: id.nullable(), postAttempts: z.number().int().min(0).max(1),
  createdAt: timestamp, updatedAt: timestamp, approvedAt: timestamp.nullable(), rejectedAt: timestamp.nullable(), dispatchedAt: timestamp.nullable(),
};
const verifyResponse = (value, context) => {
  const issue = message => context.addIssue({code: z.ZodIssueCode.custom, message});
  if (value.input.projectId !== value.projectId || value.input.requestId !== value.requestId) issue('Review identity mismatch');
  const approved = value.state === 'approved' || value.state === 'dispatched';
  if ((value.taskId !== null) !== approved || (value.approvedAt !== null) !== approved) issue('Approval reservation mismatch');
  if ((value.rejectedAt !== null) !== (value.state === 'rejected')) issue('Rejection mismatch');
  if ((value.dispatchedAt !== null) !== (value.state === 'dispatched') || value.postAttempts !== Number(value.state === 'dispatched')) issue('POST fence mismatch');
  if (value.revision !== ({pending: 1, approved: 2, rejected: 2, dispatched: 3})[value.state]) issue('Review revision mismatch');
};
const officialResponse = z.object(responseFields).strict().superRefine(verifyResponse);
const customResponse = z.object({...responseFields, input: customGeneration, destination: customDestination, configuration: reviewedConfiguration})
  .strict().refine(matchesConfiguration, 'Custom review configuration mismatch').superRefine(verifyResponse);
export const imageReviewResponseSchema = z.union([officialResponse, customResponse]);
export const isImageReviewResponse = value => imageReviewResponseSchema.safeParse(value).success;
export function isImageReviewListResponse(input, result) {
  if (!imageReviewSchemas['image.review.list'].safeParse(input).success || !result || typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).sort().join(',') !== 'items,nextCursor,projectId' || result.projectId !== input.projectId || !Array.isArray(result.items) ||
      result.items.length > (input.limit ?? IMAGE_REVIEW_LIMITS.pageSize) || result.nextCursor !== null &&
      (typeof result.nextCursor !== 'string' || !result.nextCursor.length || result.nextCursor.length > IMAGE_REVIEW_LIMITS.cursorCharacters)) return false;
  return new Set(result.items.map(value => value?.id)).size === result.items.length && result.items.every(value => isImageReviewResponse(value) && value.projectId === input.projectId);
}
export function isImageReviewPreparationResponse(input, result) {
  return imageReviewSchemas['image.review.prepare'].safeParse(input).success && isImageReviewResponse(result) &&
    result.settingsRevision === input.settingsRevision && canonicalImageInput(result.input) === canonicalImageInput(input.input);
}
