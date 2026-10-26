import React from 'react';
import { WorkbenchBadge, WorkbenchButton, WorkbenchProgress } from '@mioon/ui/components/workbench-controls';
import type { WorkbenchTone } from '@mioon/ui/components/workbench-controls';
import { RotateCcw } from '@mioon/ui/components/workbench-icons';
import { useI18n } from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import { sceneStoryboardFailed, sceneTaskActive, sceneTaskCanCancel, sceneTaskPercent } from './scene-detection.ts';
import type { SceneShotsTask, SceneTask } from './scene-detection.ts';
import { sceneStoryboardFailure, sceneTaskCenterRows } from './scene-task-views.ts';
import type { SceneTaskViewContext } from './scene-task-views.ts';

const tone = (task: SceneTask): WorkbenchTone => task.state === 'succeeded' ? 'success' : task.state === 'failed' || task.state === 'local_result_error' ? 'danger' : task.state === 'interrupted' ? 'warning' : 'neutral';
export interface SceneTaskCenterEntry { readonly key: string; readonly label: string; readonly status: string; readonly active: boolean; readonly warning: boolean; readonly detail: React.ReactNode }
/** The task center's scene rows with their detail cards. */
export function sceneTaskCenterEntries(tasks: readonly SceneTask[], context: SceneTaskViewContext & { readonly busy: boolean }): SceneTaskCenterEntry[] {
  return sceneTaskCenterRows(tasks, context).map(row => {
    const shots = row.task.kind === 'shots' ? row.task : null;
    return { key: row.key, label: row.label, status: row.status, active: row.active, warning: row.warning,
      detail: <SceneTaskCard task={row.task} name={row.name} label={row.label} status={row.status} available={row.available} retry={row.retry} busy={context.busy} readOnly={context.readOnly}
        onOpen={() => context.onOpen(row.task)} onCancel={() => context.onCancel(row.task)}
        onRetry={shots && context.onRetry ? () => context.onRetry?.(shots) : undefined} onView={shots && context.onView ? () => context.onView?.(shots) : undefined} /> };
  });
}

export function SceneTaskCard({ task, name, label, status, available, retry, busy, readOnly, onOpen, onCancel, onRetry, onView }: {
  task: SceneTask; name: string; label: string; status: string; available: boolean; retry: boolean; busy: boolean; readOnly: boolean;
  onOpen: () => void; onCancel: () => void; onRetry?: () => void; onView?: () => void;
}) {
  const { t, formatDate, renderMessage } = useI18n();
  const storyboard: SceneShotsTask | null = task.kind === 'shots' ? task : null;
  return <article className="job-card" data-testid={`scene-task-${task.id}`} data-state={task.state} data-kind={task.kind}>
    <div className="job-title"><Icon name={storyboard ? 'grid' : 'scissors'} size={16} /><strong title={name}>{label}</strong><WorkbenchBadge tone={tone(task)}>{status}</WorkbenchBadge></div>
    {sceneTaskActive(task) && <WorkbenchProgress value={sceneTaskPercent(task)} label={label} />}
    {storyboard && sceneStoryboardFailed(storyboard) && <p className="helper scene-task-failure">{sceneStoryboardFailure(storyboard, renderMessage)}</p>}
    <p className="helper muted">{t('scene.task.created', { time: formatDate(task.createdAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</p>
    <div className="job-actions"><WorkbenchButton variant="ghost" size="compact" data-testid="scene-task-open" disabled={!available} onClick={onOpen}>{t('scene.task.open')}</WorkbenchButton>
      {storyboard?.state === 'succeeded' && onView && <WorkbenchButton variant="ghost" size="compact" data-testid="scene-task-view" onClick={onView}>{t('scene.task.viewShots')}</WorkbenchButton>}
      {retry && onRetry && <WorkbenchButton variant="secondary" size="compact" data-testid="scene-task-retry" disabled={!available || busy || readOnly} onClick={onRetry}><RotateCcw size={13} />{t('shell.retry')}</WorkbenchButton>}
      {sceneTaskCanCancel(task) && <WorkbenchButton variant="secondary" size="compact" data-testid="scene-task-cancel" disabled={busy || readOnly} onClick={onCancel}>{t(storyboard ? 'scene.storyboard.cancel' : 'scene.detecting.cancel')}</WorkbenchButton>}</div>
  </article>;
}
