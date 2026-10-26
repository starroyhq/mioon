import type { DisplayMessage, MessageArguments, MessageKey } from '../../../packages/i18n/src/index.ts';
import { message as msg } from '../../../packages/i18n/src/index.ts';
import { sceneErrorMessage, sceneStoryboardErrorMessage, sceneStoryboardFailed, sceneTaskActive, sceneTaskCanCancel, sceneTaskPercent } from './scene-detection.ts';
import type { SceneShotsTask, SceneTask } from './scene-detection.ts';
import { storyboardNeedsAttention } from './scene-storyboard.ts';
import type { TaskOverviewItem } from './TaskPopover.tsx';

// Scene tasks as the task popover and the task center list them: detections
// and the storyboards built from their segments.
export interface SceneTaskViewContext {
  readonly t: <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
  readonly renderMessage: (value: DisplayMessage | string | null | undefined) => string;
  /** The video's name, or undefined when it left the project. */
  readonly name: (assetId: string) => string | undefined;
  readonly remaining: Readonly<Record<string, number>>;
  readonly readOnly: boolean;
  readonly onOpen: (task: SceneTask) => void;
  readonly onCancel: (task: SceneTask) => void;
  /** Builds a storyboard that built nothing again; absent where retry is not offered. */
  readonly onRetry?: (task: SceneShotsTask) => void;
  /** Shows a built storyboard's shots on the canvas. */
  readonly onView?: (task: SceneShotsTask) => void;
}

/** 拆解镜头 · name or 建分镜 · name. */
export const sceneTaskLabel = (task: SceneTask, name: string, t: SceneTaskViewContext['t']): string =>
  task.kind === 'shots' ? t('scene.task.storyboardLabel', { name }) : t('scene.task.label', { name });
/** Why a storyboard built nothing, with that consequence spelled out. */
export const sceneStoryboardFailure = (task: SceneShotsTask, renderMessage: SceneTaskViewContext['renderMessage']): string =>
  renderMessage(msg('scene.storyboard.noShots', { reason: renderMessage(sceneStoryboardErrorMessage(task.errorCode)) }));

/** One line of status, shared by the task popover and the task center. */
export function sceneTaskStatus(task: SceneTask, { t, renderMessage, remaining }: Pick<SceneTaskViewContext, 't' | 'renderMessage' | 'remaining'>): string {
  if (task.state === 'queued') return t('scene.task.queued');
  if (task.state === 'cancelling') return t('scene.task.cancelling');
  if (task.kind === 'shots') {
    if (task.state === 'running') return `${task.progress?.done ?? 0} / ${task.segments.length}`;
    if (task.state === 'persisting') return t('scene.task.storyboardPersisting');
    if (task.state === 'succeeded') return t('scene.task.storyboardSucceeded', { count: task.shots?.length ?? task.segments.length });
    if (task.state === 'undone') return t('scene.task.storyboardUndone');
    if (sceneStoryboardFailed(task)) return task.state === 'interrupted' ? t('scene.task.interrupted') : t('scene.task.failed');
    return t('scene.task.cancelled');
  }
  if (task.state === 'running') {
    const found = t('scene.task.running', { count: task.progress?.cuts ?? 0 }), seconds = remaining[task.id];
    return seconds ? `${found} · ${t('scene.task.remaining', { seconds })}` : found;
  }
  if (task.state === 'succeeded') return t('scene.task.succeeded', { count: (task.result?.cutCount ?? 0) + 1 });
  if (task.state === 'failed') return `${t('scene.task.failed')} · ${renderMessage(sceneErrorMessage(task.errorCode))}`;
  if (task.state === 'interrupted') return t('scene.task.interrupted');
  return t('scene.task.cancelled');
}

/** Active scene tasks for the top bar's task popover (open the dialog or cancel),
 * then storyboards that built nothing, which can be retried from there. */
export function sceneOverviewItems(tasks: readonly SceneTask[], context: SceneTaskViewContext): TaskOverviewItem[] {
  const active = tasks.filter(sceneTaskActive).map((task): TaskOverviewItem => {
    const known = context.name(task.sourceAssetId), name = known ?? context.t('scene.task.unavailable'), running = task.state === 'running';
    // The badge carries the percentage or count; the full status line goes under the progress bar.
    const detail = !running ? undefined : task.kind === 'shots' ? context.t('scene.task.storyboardRunning', { count: task.segments.length }) : sceneTaskStatus(task, context);
    return { id: `scene:${task.id}`, label: sceneTaskLabel(task, name, context.t), status: running && task.kind === 'detect' ? `${sceneTaskPercent(task)}%` : sceneTaskStatus(task, context),
      detail, phase: 'active', progress: sceneTaskPercent(task), tone: 'neutral',
      onOpen: known === undefined ? undefined : () => context.onOpen(task),
      onCancel: !context.readOnly && sceneTaskCanCancel(task) ? () => context.onCancel(task) : undefined,
      cancelLabel: task.kind === 'shots' ? context.t('scene.task.storyboardCancel', { name }) : context.t('scene.task.cancel', { name }) };
  });
  const failed = tasks.filter((task): task is SceneShotsTask => storyboardNeedsAttention(task, tasks)).map((task): TaskOverviewItem => {
    const known = context.name(task.sourceAssetId), name = known ?? context.t('scene.task.unavailable');
    return { id: `scene:${task.id}`, label: sceneTaskLabel(task, name, context.t), status: sceneTaskStatus(task, context), detail: sceneStoryboardFailure(task, context.renderMessage),
      phase: 'attention', tone: 'danger', onOpen: known === undefined ? undefined : () => context.onOpen(task),
      onRetry: known !== undefined && !context.readOnly && context.onRetry ? () => context.onRetry?.(task) : undefined, retryLabel: context.t('scene.task.retryLabel', { name }) };
  });
  return [...active, ...failed];
}

export interface SceneTaskCenterRow {
  readonly key: string; readonly task: SceneTask; readonly name: string; readonly available: boolean; readonly label: string; readonly status: string; readonly active: boolean; readonly warning: boolean;
  /** A storyboard that built nothing and is not yet replaced by a newer one. */
  readonly retry: boolean;
}
/** Every listed scene task for the task center; failures and interruptions need attention. */
export function sceneTaskCenterRows(tasks: readonly SceneTask[], context: SceneTaskViewContext): SceneTaskCenterRow[] {
  return tasks.map(task => {
    const known = context.name(task.sourceAssetId), name = known ?? context.t('scene.task.unavailable');
    return { key: `scene:${task.id}`, task, name, available: known !== undefined, label: sceneTaskLabel(task, name, context.t), status: sceneTaskStatus(task, context), active: sceneTaskActive(task),
      warning: task.state === 'failed' || task.state === 'interrupted' || task.state === 'local_result_error', retry: storyboardNeedsAttention(task, tasks) };
  });
}
