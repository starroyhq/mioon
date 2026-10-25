import type { DisplayMessage, MessageArguments, MessageKey } from '../../../packages/i18n/src/index.ts';
import { sceneErrorMessage, sceneTaskActive, sceneTaskCanCancel, sceneTaskPercent } from './scene-detection.ts';
import type { SceneDetectTask } from './scene-detection.ts';
import type { TaskOverviewItem } from './TaskPopover.tsx';

// Scene tasks as the task popover and the task center list them.
export interface SceneTaskViewContext {
  readonly t: <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
  readonly renderMessage: (value: DisplayMessage | string | null | undefined) => string;
  /** The video's name, or undefined when it left the project. */
  readonly name: (assetId: string) => string | undefined;
  readonly remaining: Readonly<Record<string, number>>;
  readonly readOnly: boolean;
  readonly onOpen: (task: SceneDetectTask) => void;
  readonly onCancel: (task: SceneDetectTask) => void;
}

/** One line of status, shared by the task popover and the task center. */
export function sceneTaskStatus(task: SceneDetectTask, { t, renderMessage, remaining }: Pick<SceneTaskViewContext, 't' | 'renderMessage' | 'remaining'>): string {
  if (task.state === 'queued') return t('scene.task.queued');
  if (task.state === 'cancelling') return t('scene.task.cancelling');
  if (task.state === 'running') {
    const found = t('scene.task.running', { count: task.progress?.cuts ?? 0 }), seconds = remaining[task.id];
    return seconds ? `${found} · ${t('scene.task.remaining', { seconds })}` : found;
  }
  if (task.state === 'succeeded') return t('scene.task.succeeded', { count: (task.result?.cutCount ?? 0) + 1 });
  if (task.state === 'failed') return `${t('scene.task.failed')} · ${renderMessage(sceneErrorMessage(task.errorCode))}`;
  if (task.state === 'interrupted') return t('scene.task.interrupted');
  return t('scene.task.cancelled');
}

/** Active detections for the top bar's task popover: open the dialog or cancel. */
export function sceneOverviewItems(tasks: readonly SceneDetectTask[], context: SceneTaskViewContext): TaskOverviewItem[] {
  return tasks.filter(sceneTaskActive).map(task => {
    const name = context.name(task.sourceAssetId) ?? context.t('scene.task.unavailable');
    // The badge carries the percentage; the full status line goes under the progress bar.
    return { id: `scene:${task.id}`, label: context.t('scene.task.label', { name }), status: task.state === 'running' ? `${sceneTaskPercent(task)}%` : sceneTaskStatus(task, context),
      detail: task.state === 'running' ? sceneTaskStatus(task, context) : undefined, phase: 'active', progress: sceneTaskPercent(task), tone: 'neutral',
      onOpen: context.name(task.sourceAssetId) === undefined ? undefined : () => context.onOpen(task),
      onCancel: !context.readOnly && sceneTaskCanCancel(task) ? () => context.onCancel(task) : undefined, cancelLabel: context.t('scene.task.cancel', { name }) };
  });
}

export interface SceneTaskCenterRow { readonly key: string; readonly task: SceneDetectTask; readonly name: string; readonly available: boolean; readonly label: string; readonly status: string; readonly active: boolean; readonly warning: boolean }
/** Every listed scene task for the task center; failures and interruptions need attention. */
export function sceneTaskCenterRows(tasks: readonly SceneDetectTask[], context: SceneTaskViewContext): SceneTaskCenterRow[] {
  return tasks.map(task => {
    const known = context.name(task.sourceAssetId), name = known ?? context.t('scene.task.unavailable');
    return { key: `scene:${task.id}`, task, name, available: known !== undefined, label: context.t('scene.task.label', { name }), status: sceneTaskStatus(task, context), active: sceneTaskActive(task),
      warning: task.state === 'failed' || task.state === 'interrupted' };
  });
}
