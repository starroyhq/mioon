import {AppError} from '../../contracts/src/app-error.ts';
import type {PreviewMedia} from '../../contracts/src/timeline-preview-media.ts';
import {clipTimingSchema} from '../../contracts/src/timeline-speed.ts';
import type {ClipTiming} from '../../contracts/src/timeline-speed.ts';
import {invalidFormat5Timeline, readFormat5TimelineStateForIds} from './project-file/format5-timeline.ts';
import type {ProjectStore} from './project-file/store.ts';

function nativePreviewMedia(timing: ClipTiming | undefined): Extract<PreviewMedia, {mode: 'native'}> | null {
  if (!timing) return {mode: 'native', rate: {numerator: 1, denominator: 1}};
  if (timing.profile !== 'timeline-speed-v1' || timing.view.direction !== 'forward' ||
      timing.basis.speed.kind !== 'constant') return null;
  return {mode: 'native', rate: timing.basis.speed.rate};
}

type Input = {projectId: string; clipId: string};

export function readTimelinePreviewMedia(store: ProjectStore, input: Input): PreviewMedia {
  if (input.projectId !== store.projectId) throw new AppError('PROJECT_ID_MISMATCH', '项目地址与请求不一致。', 409);
  const {header, clips: [row]} = readFormat5TimelineStateForIds(store.db, 'project', {clipIds: [input.clipId], cueIds: []});
  if (!row) throw new AppError('NOT_FOUND', '找不到片段。', 404);
  if (header?.projectId !== input.projectId || row.projectId !== header.projectId || row.timelineId !== header.id) {
    throw invalidFormat5Timeline();
  }
  let clip: unknown;
  try {clip = JSON.parse(row.raw);} catch {throw invalidFormat5Timeline();}
  if (!clip || typeof clip !== 'object' || !('id' in clip) || clip.id !== row.id) throw invalidFormat5Timeline();
  const parsed = clipTimingSchema.optional().safeParse('timing' in clip ? clip.timing : undefined);
  if (!parsed.success) throw invalidFormat5Timeline();
  if (row.columns.sourceState !== 'ready' || !row.columns.assetId) {
    throw new AppError('SPEED_SOURCE_NOT_READY', '片段素材尚未就绪。', 409);
  }
  if (parsed.data?.profile === 'timeline-speed-v1' && parsed.data.interpolation === 'blend') {
    throw new AppError('UNSUPPORTED_FORMAT', '帧混合预览暂不可用。', 409);
  }
  const native = nativePreviewMedia(parsed.data);
  if (native) return native;
  // A proxy read needs a preview task bound to the current clip and an owned,
  // verified media lease before it can return ready. Reverse/export tasks use
  // a different profile and cannot provide that proof.
  throw new AppError('SPEED_PROCESSING_UNAVAILABLE', '当前片段没有可读取的预览代理。', 409);
}
