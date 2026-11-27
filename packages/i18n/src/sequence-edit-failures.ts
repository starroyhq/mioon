import type {MessageKey} from './index.ts';

const failureKeys = {
  INVALID_SPLIT: 'editUi.error.INVALID_SPLIT',
  CLIP_NOT_FOUND: 'editUi.error.CLIP_NOT_FOUND',
  COPY_NODE_REQUIRED: 'editUi.error.COPY_NODE_REQUIRED',
  INVALID_MEDIA: 'editUi.error.INVALID_MEDIA',
  INVALID_TRACK_TARGET: 'editUi.error.INVALID_TRACK_TARGET',
  SEQUENCE_EDIT_ANCHOR_CONFLICT: 'editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT',
  DUPLICATE_EDGE: 'boardUi.error.sequenceDuplicateEdge',
  MISSING_NODE: 'boardUi.error.sequenceMissingNode',
  FILM_MUST_START: 'boardUi.error.sequenceFilmStart',
  ACTIVE_FILM_REMOVED: 'boardUi.error.sequenceActiveFilmRemoved',
  SEQUENCE_EDIT_NOOP: 'editUi.error.SEQUENCE_EDIT_NOOP',
} as const satisfies Readonly<Record<string, MessageKey>>;

const reasonKeys = {
  'INVALID_MEDIA:ASSET_NOT_FOUND': 'editUi.error.INVALID_MEDIA_NOT_FOUND',
  'INVALID_MEDIA:ASSET_KIND_UNSUPPORTED': 'editUi.error.INVALID_MEDIA_KIND',
  'INVALID_TRACK_TARGET:TRACK_NOT_FOUND': 'editUi.error.INVALID_TRACK_TARGET_NOT_FOUND',
  'INVALID_TRACK_TARGET:TRACK_KIND_MISMATCH': 'editUi.error.INVALID_TRACK_TARGET_KIND',
  'INVALID_TRACK_TARGET:COPY_REQUIRES_MAIN_TRACK': 'editUi.error.INVALID_TRACK_TARGET_COPY',
  'SEQUENCE_EDIT_ANCHOR_CONFLICT:MAIN_TRACK_CLIP_REQUIRED': 'editUi.error.SEQUENCE_EDIT_ANCHOR_MAIN_TRACK_REQUIRED',
} as const satisfies Readonly<Record<string, MessageKey>>;

export function sequenceEditFailureMessageKey(code: string | undefined, reason?: string) {
  if (!code || !Object.hasOwn(failureKeys, code)) return undefined;
  const variant = `${code}:${reason}`;
  if (reason && Object.hasOwn(reasonKeys, variant)) return reasonKeys[variant as keyof typeof reasonKeys];
  return failureKeys[code as keyof typeof failureKeys];
}
