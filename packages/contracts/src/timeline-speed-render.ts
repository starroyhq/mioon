import {AppError} from './app-error.ts';
import {compileClipTimeMap} from './timeline-clip-timing.ts';
import {clipTimingSchema} from './timeline-speed.ts';
import {timeMapSourceRangeForEdit, type TimeMapSourceBoundary} from './timeline-time-map.ts';

export const SPEED_RENDER_NOT_READY = 'SPEED_RENDER_NOT_READY';
export const SPEED_RENDER_NOT_READY_MESSAGE = 'Rendering retimed clips is unavailable.';

interface RenderClip {
  readonly id?: unknown;
  readonly startFrame?: unknown;
  readonly durationFrames?: unknown;
  readonly sourceInFrame?: unknown;
  readonly timing?: unknown;
}

function isFrameBoundary(boundary: TimeMapSourceBoundary, frame: number): boolean {
  if (boundary.kind === 'q64') return BigInt(boundary.ticks) === BigInt(frame) * (1n << 64n);
  return BigInt(boundary.numerator) === BigInt(frame) * BigInt(boundary.denominator);
}

/** The legacy decoders use an affine source offset at the timeline frame rate.
 * Only admit an explicitly timed clip when that is also its exact mapping. */
export function canRenderTimelineClipAtIdentity(clip: RenderClip, fps: unknown): boolean {
  if (clip.timing === undefined) return true;
  const parsed = clipTimingSchema.safeParse(clip.timing);
  if (!parsed.success || parsed.data.profile !== 'timeline-speed-v1' ||
      typeof clip.id !== 'string' || typeof clip.startFrame !== 'number' ||
      typeof clip.durationFrames !== 'number' || typeof clip.sourceInFrame !== 'number' ||
      !Number.isSafeInteger(clip.sourceInFrame + clip.durationFrames) || !Number.isSafeInteger(clip.sourceInFrame) ||
      typeof fps !== 'number' || !Number.isSafeInteger(fps) || fps < 1) return false;
  const timing = parsed.data;
  const {speed} = timing.basis;
  const rates = speed.kind === 'constant' ? [speed.rate] : speed.points.map(point => point.rate);
  if (timing.view.direction !== 'forward' || timing.interpolation !== 'off' ||
      rates.some(rate => rate.numerator !== rate.denominator)) return false;
  const {id, startFrame, durationFrames, sourceInFrame} = clip;
  const plan = compileClipTimeMap({id, startFrame, durationFrames, sourceInFrame, timing}, {fps});
  if (!plan.ok || plan.value.durationFrames !== durationFrames) return false;
  const visible = timeMapSourceRangeForEdit(plan.value);
  return visible.ok && isFrameBoundary(visible.value.start, sourceInFrame) &&
    isFrameBoundary(visible.value.end, sourceInFrame + durationFrames);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function unreadyTimelineSpeedClips(timeline: unknown): string[] {
  if (!object(timeline) || !Array.isArray(timeline.clips)) return [];
  return timeline.clips.flatMap((clip: unknown) =>
    object(clip) && !canRenderTimelineClipAtIdentity(clip, timeline.fps)
      ? [typeof clip.id === 'string' ? clip.id : '']
      : []);
}

export function assertTimelineSpeedRenderable(timeline: unknown): void {
  const unready = unreadyTimelineSpeedClips(timeline);
  if (unready.length) throw new AppError(SPEED_RENDER_NOT_READY, SPEED_RENDER_NOT_READY_MESSAGE, 409,
    {clipIds: unready.filter(Boolean)});
}

export function isTimelineSpeedRenderError(error: unknown): boolean {
  return error instanceof AppError && error.code === SPEED_RENDER_NOT_READY;
}
