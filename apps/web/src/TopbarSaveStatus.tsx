import React from 'react';
import { Button } from '@mioon/ui/components/button';

export type TopbarSaveStatusProps = Readonly<{
  online: boolean;
  syncing: boolean;
  dirty: boolean;
  lastSync: Date | null;
  preferenceStatus: Readonly<{ phase: string; pending: boolean; canRetry?: boolean }>;
  onRetry: () => void;
  onReload: () => void;
}>;

export default function TopbarSaveStatus({
  online, syncing, dirty, lastSync, preferenceStatus, onRetry, onReload,
}: TopbarSaveStatusProps) {
  return <>
    <div className="topbar-sync" title={lastSync ? `最近同步：${lastSync.toLocaleTimeString('zh-CN')}` : ''}>
      <span className={`status-dot ${!online ? 'red' : syncing ? 'orange' : 'green'}`} />
      {!online ? '连接中断' : syncing ? '正在同步' : dirty ? '有未保存修改' : '已保存'}
    </div>
    <div className="workspace-save-status" data-testid="workspace-save-status" data-phase={preferenceStatus.phase} role="status">
      {['local', 'conflict', 'error'].includes(preferenceStatus.phase) ? <>
        <span>{preferenceStatus.phase === 'conflict' ? '视图已在其他窗口更新' : '视图位置未同步'}</span>
        {preferenceStatus.phase === 'error' && preferenceStatus.canRetry && <Button variant="ghost" className="text-button" data-testid="retry-workspace-save" onClick={onRetry}>重试</Button>}
        <Button variant="ghost" className="text-button" data-testid="reload-workspace-preferences" onClick={onReload}>载入已保存视图</Button>
      </> : preferenceStatus.pending ? <span>保存视图…</span> : null}
    </div>
  </>;
}
