import {AppError} from '../../contracts/src/app-error.ts';
import {timelinePreviewMediaPath} from '../../contracts/src/timeline-preview-media.ts';
import type {PreviewMedia} from '../../contracts/src/timeline-preview-media.ts';
import {clipTimingSchema} from '../../contracts/src/timeline-speed.ts';
import type {ClipTiming} from '../../contracts/src/timeline-speed.ts';
import {invalidFormat5Timeline, readFormat5TimelineStateForIds} from './project-file/format5-timeline.ts';
import type {ProjectStore} from './project-file/store.ts';
import type {PreviewProcessingPort} from './timeline-processing/preview-port.ts';

function nativePreviewMedia(timing: ClipTiming | undefined): Extract<PreviewMedia, {mode: 'native'}> | null {
  if (!timing) return {mode: 'native', rate: {numerator: 1, denominator: 1}};
  if (timing.profile !== 'timeline-speed-v1' || timing.view.direction !== 'forward' ||
      timing.basis.speed.kind !== 'constant') return null;
  return {mode: 'native', rate: timing.basis.speed.rate};
}

type Input = {projectId: string; clipId: string};

export function readTimelinePreviewClip(store: ProjectStore, input: Input) {
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
  const {assetId, durationFrames, sourceState} = row.columns;
  if (sourceState !== 'ready' || typeof assetId !== 'string') {
    throw new AppError('SPEED_SOURCE_NOT_READY', '片段素材尚未就绪。', 409);
  }
  if (typeof durationFrames !== 'number' || !Number.isSafeInteger(durationFrames) || durationFrames < 1) {
    throw invalidFormat5Timeline();
  }
  return {assetId, timing: parsed.data, durationFrames};
}

export function readTimelinePreviewMedia(store: ProjectStore, input: Input, preview: PreviewProcessingPort): PreviewMedia {
  const {assetId, timing, durationFrames} = readTimelinePreviewClip(store, input);
  if (timing?.profile === 'timeline-speed-v1' && timing.interpolation === 'blend') {
    throw new AppError('UNSUPPORTED_FORMAT', '帧混合预览暂不可用。', 409);
  }
  const native = nativePreviewMedia(timing);
  if (native) return native;
  const task = preview.lookup(input);
  if (task?.item.kind === 'preview' && task.item.clipId === input.clipId) {
    const {status, taskId, progress, reason} = task.item;
    if (status !== 'ready') return {mode: 'proxy', status, taskId,
      ...(progress === undefined ? {} : {progress}), ...(reason === undefined ? {} : {reason})};
    const ready = task.ready;
    if (ready?.proof.projectId === input.projectId && ready.proof.clipId === input.clipId &&
        ready.proof.taskId === taskId && ready.durationFrames === durationFrames) {
      const url = timelinePreviewMediaPath({...input, assetId, taskId, digest: ready.proof.sha256});
      return {mode: 'proxy', status, url, durationFrames};
    }
  }
  throw new AppError('SPEED_PROCESSING_UNAVAILABLE', '当前片段没有可读取的预览代理。', 409);
}
