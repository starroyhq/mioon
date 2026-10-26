import { sceneShotTitle, SCENE_LIMITS } from '@mioon/contracts';
import type { SceneUndoBlocker } from '@mioon/contracts';
import { message as msg } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage, MessageArguments, MessageKey } from '../../../packages/i18n/src/index.ts';
import type { SceneSegment } from './scene-cuts.ts';
import { sceneStoryboardFailed } from './scene-detection.ts';
import type { SceneShotsTask, SceneTask } from './scene-detection.ts';

// Storyboards in the workbench: the segments one is built from in the scene
// dialog, each keyframe's state while it is built, and the batch of shots it
// leaves on the canvas, with why that batch can no longer be undone.
type Translate = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;

/** The chosen segment numbers in order; null chooses every segment. */
export function storyboardSegments(chosen: ReadonlySet<number> | null, segments: readonly SceneSegment[]): number[] {
  return segments.map(segment => segment.index).filter(index => !chosen || chosen.has(index));
}

export type StoryboardBlock = 'readOnly' | 'stale' | 'unsaved' | 'busy' | 'none' | 'limit';
/** Why 建分镜 cannot start from what the dialog shows; null when it can. Manual cut
 * adjustments are saved first, so a storyboard always matches a stored result. */
export function storyboardBlock({ readOnly, current, dirty, busy, count }: { readOnly: boolean; current: boolean; dirty: boolean; busy: boolean; count: number }): StoryboardBlock | null {
  return readOnly ? 'readOnly' : !current ? 'stale' : dirty ? 'unsaved' : busy ? 'busy' : count < 1 ? 'none' : count > SCENE_LIMITS.shotsPerTask ? 'limit' : null;
}
export function storyboardBlockMessage(block: StoryboardBlock): DisplayMessage {
  return block === 'readOnly' ? msg('scene.readOnly') : block === 'stale' ? msg('scene.storyboard.blocked.stale') : block === 'unsaved' ? msg('scene.storyboard.blocked.unsaved')
    : block === 'busy' ? msg('scene.storyboard.blocked.busy') : block === 'none' ? msg('scene.storyboard.blocked.none') : msg('scene.storyboard.blocked.limit', { limit: SCENE_LIMITS.shotsPerTask });
}

export type StoryboardKeyframe = 'done' | 'current' | 'waiting' | 'skipped';
/** Each segment's keyframe while a storyboard is built, for segments 1…count.
 * Keyframes are captured in segment order; the shots follow all at once. */
export function storyboardKeyframes(task: SceneShotsTask, count: number): StoryboardKeyframe[] {
  const done = task.state === 'persisting' ? task.segments.length : task.progress?.done ?? 0, position = new Map(task.segments.map((segment, index) => [segment, index]));
  return Array.from({ length: Math.max(0, count) }, (_, offset) => {
    const index = position.get(offset + 1);
    return index === undefined ? 'skipped' : index < done ? 'done' : index === done && task.state === 'running' ? 'current' : 'waiting';
  });
}

/** The title a storyboard gives segment n's shot, as the backend names it. */
export const storyboardShotTitle = (task: Pick<SceneShotsTask, 'titlePrefix'>, segment: number): string => sceneShotTitle(task.titlePrefix, segment);

/** A storyboard that built nothing needs attention until a newer storyboard of the same video replaces it. */
export function storyboardNeedsAttention(task: SceneTask, tasks: readonly SceneTask[]): task is SceneShotsTask {
  return sceneStoryboardFailed(task) && !tasks.some(other => other.kind === 'shots' && other.sourceAssetId === task.sourceAssetId && other.id !== task.id && other.createdAt > task.createdAt);
}

export interface StoryboardBatchShot { readonly id: string; readonly duration?: number; readonly selectedVersionId?: string | null }
export interface StoryboardBatchSummary {
  /** The batch's shots still on the canvas, in segment order. */
  readonly shotIds: readonly string[];
  readonly first: string;
  readonly last: string;
  readonly seconds: number;
  readonly pending: number;
  readonly generated: number;
  readonly edited: number;
  readonly missing: number;
}
/** What the inspector shows for a built storyboard: its shots as they are now. */
export function storyboardBatchSummary(task: SceneShotsTask, shots: readonly StoryboardBatchShot[], blockers: readonly SceneUndoBlocker[] | null): StoryboardBatchSummary {
  const byId = new Map(shots.map(shot => [shot.id, shot])), built = task.shots ?? [];
  const present = built.map(item => byId.get(item.shotId)).filter((shot): shot is StoryboardBatchShot => Boolean(shot));
  const generated = present.filter(shot => Boolean(shot.selectedVersionId)).length;
  return { shotIds: present.map(shot => shot.id), first: storyboardShotTitle(task, task.segments[0] ?? 1), last: storyboardShotTitle(task, task.segments.at(-1) ?? 1),
    seconds: present.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0), pending: present.length - generated, generated,
    edited: blockers?.filter(blocker => blocker.reason === 'EDITED').length ?? 0, missing: built.length - present.length };
}

type FieldKey = 'scene.batch.field.title' | 'scene.batch.field.prompt' | 'scene.batch.field.reference' | 'scene.batch.field.lastFrame' | 'scene.batch.field.aspectRatio'
  | 'scene.batch.field.duration' | 'scene.batch.field.parameters' | 'scene.batch.field.version';
const fieldKeys: Readonly<Record<string, FieldKey>> = Object.freeze({ title: 'scene.batch.field.title', prompt: 'scene.batch.field.prompt', referenceAssetIds: 'scene.batch.field.reference',
  lastFrameAssetId: 'scene.batch.field.lastFrame', aspectRatio: 'scene.batch.field.aspectRatio', duration: 'scene.batch.field.duration', parameters: 'scene.batch.field.parameters',
  selectedVersionId: 'scene.batch.field.version' });
/** Why a built storyboard can no longer be undone, naming its first changed shot; null when nothing blocks it. */
export function storyboardUndoReason(task: Pick<SceneShotsTask, 'titlePrefix'>, blockers: readonly SceneUndoBlocker[], t: Translate): string | null {
  const first = blockers[0];
  if (!first) return null;
  const title = storyboardShotTitle(task, first.segment);
  const fields = (first.fields ?? []).map(field => t(fieldKeys[field] ?? 'scene.batch.field.parameters')).join(t('scene.batch.field.separator'));
  const reason = first.reason === 'EDITED' ? t('scene.batch.blocker.edited', { title, fields }) : first.reason === 'GENERATED' ? t('scene.batch.blocker.generated', { title })
    : first.reason === 'CONNECTED' ? t('scene.batch.blocker.connected', { title }) : first.reason === 'SUBJECT_BOUND' ? t('scene.batch.blocker.bound', { title }) : t('scene.batch.blocker.missing', { title });
  return blockers.length > 1 ? t('scene.batch.undoBlockedMore', { reason, count: blockers.length - 1 }) : t('scene.batch.undoBlocked', { reason });
}

/** 刚刚 / N 分钟前 / N 小时前 for a creation time. */
export function sceneAgo(iso: string, now: number): DisplayMessage {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  return !Number.isFinite(minutes) || minutes < 1 ? msg('scene.time.justNow') : minutes < 60 ? msg('scene.time.minutes', { count: minutes }) : msg('scene.time.hours', { count: Math.floor(minutes / 60) });
}
