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
  return <section className="task-workspace" data-testid="task-workspace" aria-labelledby="task-workspace-heading">
    <header className="task-workspace-heading">
      <h2 id="task-workspace-heading">任务中心</h2>
      <p role="status">{activeCount ? `${activeCount} 个任务正在处理` : '每次提交都有迹可循'}</p>
    </header>
    <div className="task-workspace-body" data-testid="task-workspace-body" role="region" aria-label="任务记录" tabIndex={0}>{children}</div>
    <footer className="task-workspace-note">生成任务状态持久保存；刷新或重启不会重复提交。</footer>
  </section>;
}
