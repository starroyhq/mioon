import { SCENE_LIMITS, SOURCE_RANGE_FPS } from '@mioon/contracts';

// Cut editing in the scene dialog. A cut is the first frame of a new shot on
// the 30 fps grid; the segments between cuts are what storyboards and splits use.
export interface SceneDraftCut {
  readonly frame: number;
  /** The saved cut this one started from; null for a cut the user added. */
  readonly origin: number | null;
}
export interface SceneSegment {
  /** 1-based, as shown in the dialog. */
  readonly index: number;
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  /** The keyframe the storyboard step captures: start + floor(length / 2). */
  readonly middle: number;
}

export const sceneDraftFrom = (cuts: readonly { frame: number }[]): SceneDraftCut[] => cuts.map(cut => ({ frame: cut.frame, origin: cut.frame }));
export const sceneDraftFrames = (draft: readonly SceneDraftCut[]): number[] => draft.map(cut => cut.frame);
export const sceneCutAdjusted = (cut: SceneDraftCut): boolean => cut.origin !== cut.frame;

export function sceneSegments(cuts: readonly number[], frameCount: number): SceneSegment[] {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) return [];
  const bounds = [0, ...cuts.filter(frame => frame > 0 && frame < frameCount), frameCount];
  return bounds.slice(1).map((end, position) => {
    const start = bounds[position]!;
    return { index: position + 1, start, end, middle: start + Math.floor((end - start) / 2) };
  });
}
/** The segment that shows the given frame; frames past the end belong to the last one. */
export function sceneSegmentAt(segments: readonly SceneSegment[], frame: number): SceneSegment | null {
  return segments.find(segment => frame >= segment.start && frame < segment.end) ?? segments.at(-1) ?? null;
}

const inside = (frame: number, frameCount: number): boolean => Number.isSafeInteger(frame) && frame >= 1 && frame <= frameCount - 1;
/** Null when the frame is outside the source, already a cut or over the result limit. */
export function addSceneCut(draft: readonly SceneDraftCut[], frame: number, frameCount: number): SceneDraftCut[] | null {
  if (!inside(frame, frameCount) || draft.length >= SCENE_LIMITS.cuts || draft.some(cut => cut.frame === frame)) return null;
  return [...draft, { frame, origin: null }].sort((left, right) => left.frame - right.frame);
}
/** Keeps the cut between its neighbours, so the order never changes while dragging. */
export function moveSceneCut(draft: readonly SceneDraftCut[], index: number, frame: number, frameCount: number): SceneDraftCut[] {
  const cut = draft[index];
  if (!cut || !Number.isFinite(frame)) return [...draft];
  const low = (draft[index - 1]?.frame ?? 0) + 1, high = (draft[index + 1]?.frame ?? frameCount) - 1;
  const next = Math.min(high, Math.max(low, Math.round(frame)));
  if (next === cut.frame || low > high) return [...draft];
  return draft.map((item, position) => position === index ? { frame: next, origin: item.origin } : item);
}
export const removeSceneCut = (draft: readonly SceneDraftCut[], index: number): SceneDraftCut[] => draft.filter((_, position) => position !== index);
/** Added and moved cuts count once each, and so does every saved cut that is gone. */
export function sceneAdjustments(draft: readonly SceneDraftCut[], saved: readonly number[]): number {
  const kept = new Set(draft.map(cut => cut.origin).filter((origin): origin is number => origin !== null));
  return draft.filter(sceneCutAdjusted).length + saved.filter(frame => !kept.has(frame)).length;
}

/** mm:ss.t, the dialog's time format; whole minutes past an hour keep counting. */
export function sceneTime(frame: number, fps: number = SOURCE_RANGE_FPS): string {
  const tenths = Math.max(0, Math.floor(frame * 10 / fps)), minutes = Math.floor(tenths / 600), seconds = Math.floor(tenths / 10) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}
/** mm:ss for the cut bar's axis. */
export const sceneClock = (frame: number, fps: number = SOURCE_RANGE_FPS): string => sceneTime(frame, fps).slice(0, -2);
export const sceneSeconds = (frames: number, fps: number = SOURCE_RANGE_FPS): number => Math.round(frames * 10 / fps) / 10;
export const sceneSegmentNumber = (index: number): string => String(index).padStart(2, '0');
/** Evenly spaced filmstrip frames, one per tile, sampled at each tile's centre. */
export function sceneFilmstripFrames(frameCount: number, tiles: number): number[] {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || !Number.isSafeInteger(tiles) || tiles < 1) return [];
  return Array.from({ length: tiles }, (_, index) => Math.min(frameCount - 1, Math.floor((index + 0.5) * frameCount / tiles)));
}
