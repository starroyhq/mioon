import React from 'react';
import { WorkbenchBadge, WorkbenchButton, WorkbenchProgress } from '@mioon/ui/components/workbench-controls';
import type { WorkbenchTone } from '@mioon/ui/components/workbench-controls';
import { useI18n } from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import { sceneTaskActive, sceneTaskCanCancel, sceneTaskPercent } from './scene-detection.ts';
import type { SceneDetectTask } from './scene-detection.ts';
import { sceneTaskCenterRows } from './scene-task-views.ts';
import type { SceneTaskViewContext } from './scene-task-views.ts';

const tone = (task: SceneDetectTask): WorkbenchTone => task.state === 'succeeded' ? 'success' : task.state === 'failed' ? 'danger' : task.state === 'interrupted' ? 'warning' : 'neutral';
export interface SceneTaskCenterEntry { readonly key: string; readonly label: string; readonly status: string; readonly active: boolean; readonly warning: boolean; readonly detail: React.ReactNode }
/** The task center's scene rows with their detail cards. */
export function sceneTaskCenterEntries(tasks: readonly SceneDetectTask[], context: SceneTaskViewContext & { readonly busy: boolean }): SceneTaskCenterEntry[] {
  return sceneTaskCenterRows(tasks, context).map(row => ({ key: row.key, label: row.label, status: row.status, active: row.active, warning: row.warning,
    detail: <SceneTaskCard task={row.task} name={row.name} status={row.status} available={row.available} busy={context.busy} readOnly={context.readOnly} onOpen={() => context.onOpen(row.task)} onCancel={() => context.onCancel(row.task)} /> }));
}

export function SceneTaskCard({ task, name, status, available, busy, readOnly, onOpen, onCancel }: { task: SceneDetectTask; name: string; status: string; available: boolean; busy: boolean; readOnly: boolean; onOpen: () => void; onCancel: () => void }) {
  const { t, formatDate } = useI18n();
  return <article className="job-card" data-testid={`scene-task-${task.id}`} data-state={task.state}>
    <div className="job-title"><Icon name="scissors" size={16} /><strong title={name}>{t('scene.task.label', { name })}</strong><WorkbenchBadge tone={tone(task)}>{status}</WorkbenchBadge></div>
    {sceneTaskActive(task) && <WorkbenchProgress value={sceneTaskPercent(task)} label={t('scene.task.label', { name })} />}
    <p className="helper muted">{t('scene.task.created', { time: formatDate(task.createdAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</p>
    <div className="job-actions"><WorkbenchButton variant="ghost" size="compact" data-testid="scene-task-open" disabled={!available} onClick={onOpen}>{t('scene.task.open')}</WorkbenchButton>
      {sceneTaskCanCancel(task) && <WorkbenchButton variant="secondary" size="compact" data-testid="scene-task-cancel" disabled={busy || readOnly} onClick={onCancel}>{t('scene.detecting.cancel')}</WorkbenchButton>}</div>
  </article>;
}
