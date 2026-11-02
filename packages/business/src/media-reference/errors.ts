import {AppError} from '../../../contracts/src/app-error.ts';

// Errors of the media reference layer (task card L1). Like the app library's
// codes they stay here until S1 needs them in the contracts. Their details
// carry a `reason` and never an absolute path:
// - MEDIA_REFERENCE_INVALID: `schema`, `path` or `asset`;
// - MEDIA_MISSING: `not-found`, `no-access`, `not-a-file`, `not-downloaded`,
//   `other-platform` or `project-directory`;
// - MEDIA_CHANGED: `size`, `content` or `not-media`;
// - MEDIA_NOT_MEDIA: `protected`, `extension`, `not-a-file` or `content`;
// - MEDIA_LIST_PATH_INVALID: `path`, `outside`, `missing` or `not-a-directory`;
// - MEDIA_OUTSIDE_NOT_CONFIRMED and MEDIA_CHANGED_DURING_READ: none. After the
//   second the caller may simply try again.
const ERRORS = {
  MEDIA_REFERENCE_INVALID: {status: 400, message: '素材引用无效'},
  MEDIA_MISSING: {status: 404, message: '找不到素材文件'},
  MEDIA_CHANGED: {status: 409, message: '素材文件已变化'},
  MEDIA_NOT_MEDIA: {status: 415, message: '这个文件不是可以使用的媒体文件'},
  MEDIA_OUTSIDE_NOT_CONFIRMED: {status: 403, message: '项目目录以外的这个位置还没有确认过'},
  MEDIA_CHANGED_DURING_READ: {status: 409, message: '读取时素材文件变了，请重试'},
  MEDIA_LIST_PATH_INVALID: {status: 400, message: '项目目录里没有这个文件夹'},
} as const;
export type MediaReferenceErrorCode = keyof typeof ERRORS;

export function mediaReferenceError(code: MediaReferenceErrorCode, details: object = {}): AppError {
  const {status, message} = ERRORS[code];
  return new AppError(code, message, status, details);
}
