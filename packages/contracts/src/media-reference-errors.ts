import {z} from 'zod';
import {AppError} from './app-error.ts';
import {projectIdSchema} from './project-file.ts';

/** L1's existing codes and statuses, shared by future asset-media handlers.
 * Moving their definition does not change the low-level error contract. */
export const MEDIA_REFERENCE_ERRORS = Object.freeze({
  MEDIA_REFERENCE_INVALID: {status: 400, message: '素材引用无效'},
  MEDIA_MISSING: {status: 404, message: '找不到素材文件'},
  MEDIA_CHANGED: {status: 409, message: '素材文件已变化'},
  MEDIA_NOT_MEDIA: {status: 415, message: '这个文件不是可以使用的媒体文件'},
  MEDIA_OUTSIDE_NOT_CONFIRMED: {status: 403, message: '项目目录以外的这个位置还没有确认过'},
  MEDIA_CHANGED_DURING_READ: {status: 409, message: '读取时素材文件变了，请重试'},
  MEDIA_LIST_PATH_INVALID: {status: 400, message: '项目目录里没有这个文件夹'},
} as const);
export type MediaReferenceErrorCode = keyof typeof MEDIA_REFERENCE_ERRORS;

export function mediaReferenceError(code: MediaReferenceErrorCode, details: object = {}): AppError {
  const {status, message} = MEDIA_REFERENCE_ERRORS[code];
  return new AppError(code, message, status, details);
}

export const MEDIA_UNAVAILABLE_ERROR_CODES = Object.freeze([
  'MEDIA_MISSING', 'MEDIA_CHANGED', 'MEDIA_NOT_MEDIA', 'MEDIA_OUTSIDE_NOT_CONFIRMED', 'MEDIA_CHANGED_DURING_READ',
] as const);
export type MediaUnavailableErrorCode = typeof MEDIA_UNAVAILABLE_ERROR_CODES[number];
const assetId = projectIdSchema;
const missingReason = z.enum(['not-found', 'no-access', 'not-a-file', 'not-downloaded', 'other-platform', 'project-directory']);
const changedReason = z.enum(['size', 'content', 'not-media']);
const notMediaReason = z.enum(['protected', 'extension', 'not-a-file', 'content']);

/** Public details are deliberately projected rather than forwarded from a
 * filesystem exception. The two codes without an L1 reason use null. */
export const mediaUnavailableErrorDetailsSchemas = Object.freeze({
  MEDIA_MISSING: z.object({assetId, reason: missingReason}).strict(),
  MEDIA_CHANGED: z.object({assetId, reason: changedReason}).strict(),
  MEDIA_NOT_MEDIA: z.object({assetId, reason: notMediaReason}).strict(),
  MEDIA_OUTSIDE_NOT_CONFIRMED: z.object({assetId, reason: z.null()}).strict(),
  MEDIA_CHANGED_DURING_READ: z.object({assetId, reason: z.null()}).strict(),
});
export type MediaUnavailableErrorDetails = z.infer<typeof mediaUnavailableErrorDetailsSchemas[MediaUnavailableErrorCode]>;
export type MediaUnavailableReason = MediaUnavailableErrorDetails['reason'];

/** Use at the asset boundary; never pass an arbitrary error.details object. */
export function mediaUnavailableError(code: MediaUnavailableErrorCode, assetId: string, reason: MediaUnavailableReason = null): AppError {
  const details = mediaUnavailableErrorDetailsSchemas[code].parse({assetId, reason});
  return mediaReferenceError(code, details);
}
