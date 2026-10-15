import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter } from './creation-i18n.ts';
import React, { useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';

export type TaskViewCurrent = () => boolean;
export type CaptureTaskView = () => TaskViewCurrent | null;

/** App fences project/navigation/intent; this hook fences the rendered pane's
 * lifetime. A retained handler cannot revive after a hide/show or scope change. */
export function useTaskWorkspaceInteraction(captureView: CaptureTaskView, scope: string, visible: boolean) {
  const token = useMemo(() => ({ scope, visible }), [scope, visible]);
  const live = useRef<typeof token | null>(null);
  useLayoutEffect(() => {
    live.current = token;
    return () => { live.current = null; };
  }, [token]);
  return {
    visible,
    capture(): TaskViewCurrent | null {
      if (!visible || !scope || live.current !== token) return null;
      const currentView = captureView();
      if (!currentView || !currentView()) return null;
      return () => live.current === token && visible && currentView();
    },
  };
}

export interface TaskWorkspaceProps {
  activeCount: number;
  children: ReactNode;
}

/** Inline presentation only. App owns the shared dock tabs and collapse action;
 * task storage details and existing cards remain in this one scroll body. */
export default function TaskWorkspace({ activeCount, children }: TaskWorkspaceProps) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <section className="task-workspace" data-testid="task-workspace" aria-labelledby="task-workspace-heading">
    <header className="task-workspace-heading">
      <h2 id="task-workspace-heading">{t('tasks.workspace.heading')}</h2>
      <p role="status">{activeCount ? t('tasks.workspace.activeTasks', { count: activeCount }) : t('tasks.workspace.traceableSubmissions')}</p>
    </header>
    <div className="task-workspace-body" data-testid="task-workspace-body" role="region" aria-label={t('tasks.workspace.recordsAria')} tabIndex={0}>{children}</div>
    <footer className="task-workspace-note">{t('tasks.workspace.durableState')}</footer>
  </section>;
}
