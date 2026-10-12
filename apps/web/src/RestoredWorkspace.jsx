import React from 'react';
import { RESTORE_DISABLED_REASON, RESTORE_BACKUP_REASON } from './restored-workspace.js';
import './restored-workspace.css';

export function RestoredUnavailable({ title = '此功能暂不可用', backup = false }) {
  return <section className="restored-unavailable notice" role="status" data-testid={backup ? 'restored-backup-unavailable' : 'restored-operation-unavailable'}>
    <strong>{title}</strong><p>{backup ? RESTORE_BACKUP_REASON : RESTORE_DISABLED_REASON}</p>
    {!backup && <p>已保存的记录仍被保留；此视图暂不能安全读取或操作这些任务。已完成的素材和版本可在素材库查看。</p>}
  </section>;
}
export default function RestoredWorkspace({ workspace }) {
  if (!workspace?.restored) return null;
  const count = workspace.heldCounts.reduce((sum, item) => sum + item.count, 0);
  const localReady = ['asset.import', 'shot.update', 'timeline.render'].every(operation => workspace.operationPolicy.some(item => item.operation === operation && item.available));
  return <section className="restored-workspace-banner" role="status" data-testid="restored-workspace-banner">
    <div><strong>恢复分支</strong><span>{localReady ? '可本地导入、编辑、预览和导出' : '本地操作按当前支持范围开放'} · 保留 {count.toLocaleString('zh-CN')} 条历史记录</span></div>
    <p>{RESTORE_BACKUP_REASON}</p>
    <details><summary>分支与暂停范围</summary><p>{RESTORE_DISABLED_REASON}</p><p>恢复分支创建时间：{new Date(workspace.createdAt).toLocaleString('zh-CN')}</p><p>来源备份：{workspace.source.backupId}</p><p>分支来源：{workspace.workspaceOrigin}</p><p>这是原备份时点的独立工作区。原工作区之后的修改不会合并；旧任务状态不代表正在执行。</p></details>
  </section>;
}
