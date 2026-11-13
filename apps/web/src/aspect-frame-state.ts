import {
  TIMELINE_OUTPUT_RATIOS, timelineOutputPresetForRatio, timelineOutputRatio,
  type TimelineOutputRatio,
} from '../../../packages/contracts/src/timeline-output-geometry.ts';
import {message} from '../../../packages/i18n/src/index.ts';
import type {TimelineFormatIntent} from './timeline-format-state.ts';

interface FrameProject {
  projectFormatVersion?: number;
  project: {id: string; revision: number} | null;
  timeline: {id: string; projectId: string; revision: number; fps: number; width: number; height: number} | null;
}

export function aspectFrameSnapshot({projectFormatVersion, project, timeline}: FrameProject, scope: string) {
  if (projectFormatVersion !== 4 || !project || !timeline || timeline.projectId !== project.id ||
      !Number.isSafeInteger(project.revision) || project.revision < 1 ||
      !Number.isSafeInteger(timeline.revision) || timeline.revision < 1) return null;
  const ratio = timelineOutputRatio(timeline);
  const shortEdge = Math.min(timeline.width, timeline.height);
  if (!ratio || (shortEdge !== 720 && shortEdge !== 1080)) return null;
  return {scope, projectId: project.id, projectRevision: project.revision, timelineId: timeline.id,
    revision: timeline.revision, ratio, shortEdge} as const;
}

export type AspectFrameSnapshot = NonNullable<ReturnType<typeof aspectFrameSnapshot>>;

export function sameAspectFrameVersion(frame: AspectFrameSnapshot, live: AspectFrameSnapshot | null): boolean {
  return Boolean(live && frame.scope === live.scope && frame.projectId === live.projectId &&
    frame.projectRevision === live.projectRevision && frame.timelineId === live.timelineId && frame.revision === live.revision);
}

export function aspectFrameIntent(frame: AspectFrameSnapshot, ratio: TimelineOutputRatio, requestId: string): TimelineFormatIntent | null {
  const preset = timelineOutputPresetForRatio(ratio, frame.shortEdge);
  if (!preset || ratio === frame.ratio) return null;
  return {scope: frame.scope, projectId: frame.projectId, timelineId: frame.timelineId, serial: 0,
    input: {projectId: frame.projectId, expectedProjectRevision: frame.projectRevision,
      expectedRevision: frame.revision, requestId, presetId: preset.id}};
}

interface AspectFrameAsset {mimeType?: string; width?: number; height?: number}
export function isAspectFrameVisual(asset?: AspectFrameAsset | null): boolean {
  return Boolean(asset?.mimeType?.startsWith('video/') || asset?.mimeType?.startsWith('image/'));
}

export function aspectFrameAssetRatio(asset: AspectFrameAsset): TimelineOutputRatio | null {
  const {width, height} = asset;
  if (!isAspectFrameVisual(asset) || !width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 16384 || height > 16384) return null;
  return TIMELINE_OUTPUT_RATIOS.find(ratio => {
    const [horizontal, vertical] = ratio.split(':').map(Number);
    return width * vertical === height * horizontal;
  }) ?? null;
}

/** Browser metadata describes the displayed image, including its orientation
 * and pixel aspect. The imported record can carry coded dimensions instead. */
export function readAspectFrameAssetSize(url: string, mimeType: string, signal: AbortSignal): Promise<{width: number; height: number} | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const element = mimeType.startsWith('video/') ? document.createElement('video') : new Image();
    const video = element instanceof HTMLVideoElement ? element : null;
    const ready = video ? 'loadedmetadata' : 'load';
    const timeout = setTimeout(stop, 10_000);
    function finish(size: {width: number; height: number} | null): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', stop);
      element.removeEventListener(ready, read);
      element.removeEventListener('error', stop);
      element.removeAttribute('src');
      video?.load();
      resolve(size);
    }
    function stop(): void { finish(null); }
    function read(): void {
      const size = video ? {width: video.videoWidth, height: video.videoHeight}
        : {width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight};
      finish(size);
    }
    if (video) video.preload = 'metadata';
    signal.addEventListener('abort', stop, {once: true});
    element.addEventListener(ready, read, {once: true});
    element.addEventListener('error', stop, {once: true});
    element.src = url;
  });
}

export function aspectFrameFailureMessage(error: unknown) {
  const code = (error as {code?: string} | null)?.code;
  if (code === 'TIMELINE_FORMAT_LOCKED' || code === 'MUTATION_PENDING' || code === 'EDIT_TASK_CONFLICT') return message('timeline.aspectFrame.locked');
  if (code === 'REVISION_CONFLICT') return message('timeline.aspectFrame.conflict');
  return message('timeline.aspectFrame.failed');
}

export interface AspectFrameChange {scope: string; timelineId: string; revision: number; ratio: TimelineOutputRatio; clips: number}
export function aspectFrameUndoEntry(change: AspectFrameChange, frame: AspectFrameSnapshot | null, history: unknown): string | null {
  if (!frame || change.scope !== frame.scope || change.timelineId !== frame.timelineId || change.revision !== frame.revision || change.ratio !== frame.ratio) return null;
  const entry = (history as {undoEntry?: {id?: unknown; operation?: unknown}} | null)?.undoEntry;
  return entry?.operation === 'timeline.format.set' && typeof entry.id === 'string' ? entry.id : null;
}
