import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { createWorkspaceBackupController, WORKSPACE_BACKUP_COUNTS, WORKSPACE_BACKUP_UNRESOLVED, WORKSPACE_BACKUP_CREATE_COMMAND, WORKSPACE_BACKUP_VERIFY_COMMAND, WORKSPACE_BACKUP_ISSUES, workspaceBackupCount, workspaceBackupBytes } from './workspace-backup-ui.js';
import backupGuideText from '../../../docs/WORKSPACE-BACKUP-GUIDE.zh-CN.md?raw';
import './workspace-backup.css';

export function WorkspaceBackupDetails({ state, controller }) {
  const [guideOpen, setGuideOpen] = useState(false);
  const report = state?.report;
  const unresolved = report ? WORKSPACE_BACKUP_UNRESOLVED.filter(([key]) => report.unresolved[key] !== 0) : [];
  return <div className="workspace-backup-details" data-testid="workspace-backup-details">
    <p>范围：整个工作区，包含所有项目、聊天、提示词，以及 SQLite 内的本地缓存。</p>
    <p>媒体按离线指南的固定清单收集，不代表工作区内所有文件都会复制。</p>
    <p>不包含应用凭据与应用设置；用户文本仍可能含密钥或其他秘密。请妥善保管备份。</p>
    <p className="workspace-backup-warning">运行中的后端不能创建冷备份。这里只读核对数据库记录，未逐一检查源文件，也没有创建备份或验证恢复。</p>
    <Button variant="outline" type="button" size="sm" data-testid="workspace-backup-inspect" disabled={!state?.connected || !state?.visible || state?.phase === 'checking'} onClick={() => controller.inspect(state?.scope ?? null, state?.version ?? -1)}>{state?.phase === 'checking' ? '正在核对…' : report ? '刷新数据库核对' : '核对数据库状态'}</Button>
    <p role="status" aria-live="polite" data-testid="workspace-backup-status">{!state?.connected ? '连接不可用，恢复连接后请手动核对。' : state?.phase === 'checking' ? '正在读取有上限的数据库记录…' : state?.phase === 'stale' ? '上次核对结果仅供参考，请手动刷新。' : state?.phase === 'error' ? '核对失败，未取得可用结果。' : state?.phase === 'incomplete' ? '数据库核对未完成；未知数量不等于零。' : report ? '数据库记录核对完成，仅为本次瞬时结果；仍须关闭应用后离线创建备份。' : '尚未核对。展开、切换页面或恢复连接不会自动发起请求。'}</p>
    {state?.error && <p className="workspace-backup-warning" role="alert">{state.error}</p>}
    {report && <section aria-label="数据库记录核对" data-testid="workspace-backup-report">
      <h3>数据库记录 · 版本 {workspaceBackupCount(report.databaseSchemaVersion)}</h3>
      <dl className="workspace-backup-counts">{WORKSPACE_BACKUP_COUNTS.map(([key, label]) => <div key={key}><dt>{label}</dt><dd data-testid={`workspace-backup-count-${key}`}>{workspaceBackupCount(report.counts[key])}</dd></div>)}</dl>
      <h3>未解决的任务与请求</h3>
      {unresolved.length ? <dl className="workspace-backup-counts">{unresolved.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{workspaceBackupCount(report.unresolved[key])}</dd></div>)}</dl> : <p>本次数据库核对未发现未解决记录；这不是备份可用性保证。</p>}
      <p>备份保留这些记录，不会自动恢复、提交或重试任务。</p>
      {report.issues.length > 0 && <ul className="workspace-backup-issues">{report.issues.map(code => <li key={code}>{WORKSPACE_BACKUP_ISSUES[code]}</li>)}</ul>}
      <h3>离线命令的容量上限</h3>
      <p>数据库 {workspaceBackupBytes(report.limits.databaseBytes)} · 文件 {workspaceBackupCount(report.limits.fileCount)} 个 · 单文件 {workspaceBackupBytes(report.limits.fileBytes)} · 总计 {workspaceBackupBytes(report.limits.totalBytes)}。实际文件范围与磁盘空间须由离线命令再次核对。</p>
    </section>}
    <section aria-label="离线备份步骤" className="workspace-backup-instructions">
      <h3>关闭应用后，在本地终端操作</h3>
      <ol><li>保存草稿，正常关闭 Mioon 和所有使用同一工作区的后端。不要删除锁文件、WAL 或日志文件来绕过检查。</li><li>在已安装锁定依赖的源码仓库根目录，使用 Node 24+ 运行下面的命令。替换占位绝对路径；目标必须是工作区之外的新目录。平台支持与限制请先查看指南。</li></ol>
      <pre data-testid="workspace-backup-create-command"><code>{WORKSPACE_BACKUP_CREATE_COMMAND}</code></pre>
      <p>单独核验已有备份：</p>
      <pre data-testid="workspace-backup-verify-command"><code>{WORKSPACE_BACKUP_VERIFY_COMMAND}</code></pre>
      <p>核验成功只表示声明的备份内容通过完整性检查，不表示可以安全恢复。本阶段不支持恢复。</p>
      <Collapsible open={guideOpen} onOpenChange={setGuideOpen} className="workspace-backup-guide">
        <a href="#workspace-backup-guide-text" aria-expanded={guideOpen} aria-controls="workspace-backup-guide-text" data-testid="workspace-backup-guide" onClick={event => { event.preventDefault(); setGuideOpen(value => !value); }}>{guideOpen ? '收起离线备份指南' : '查看离线备份指南'}</a>
        <CollapsibleContent inert={!guideOpen || !state?.visible} aria-hidden={!guideOpen || undefined}><pre id="workspace-backup-guide-text" className="workspace-backup-guide-text">{backupGuideText}</pre></CollapsibleContent>
      </Collapsible>
    </section>
  </div>;
}

export default function WorkspaceBackupPanel({ scope, getScope, connected, read, onUnauthorized }) {
  const visible = useWorkspaceVisibility(), [expanded, setExpanded] = useState(false), [state, setState] = useState(null);
  const callbacks = useRef(null), controller = useRef(null);
  callbacks.current = { scope, getScope, connected, visible: visible && expanded, read, onUnauthorized };
  if (!controller.current) controller.current = createWorkspaceBackupController({
    read: (input, options) => callbacks.current.read(input, options), onChange: setState,
    getContext: () => ({ scope: callbacks.current.getScope?.() ?? callbacks.current.scope, connected: callbacks.current.connected, visible: callbacks.current.visible }),
    onUnauthorized: () => callbacks.current.onUnauthorized?.(),
  });
  useLayoutEffect(() => { controller.current.connect(); return () => controller.current.dispose(); }, []);
  useLayoutEffect(() => { controller.current.setContext({ scope, connected, visible: visible && expanded }); }, [scope, connected, visible, expanded]);
  const current = state?.scope === scope ? state : null;
  return <Collapsible open={expanded} onOpenChange={setExpanded} className="workspace-backup-panel" data-testid="workspace-backup-panel" render={<section aria-label="工作区离线备份" />}>
    <CollapsibleTrigger className="workspace-backup-trigger" render={<Button variant="ghost" type="button" disabled={!visible} data-testid="workspace-backup-toggle" />}><span><strong>工作区离线备份</strong><small>整工作区 · 需先正常关闭应用</small></span><span aria-hidden="true">{expanded ? '−' : '+'}</span></CollapsibleTrigger>
    <CollapsibleContent keepMounted className="workspace-backup-content" inert={!visible || !expanded} aria-hidden={!visible || !expanded || undefined}><WorkspaceBackupDetails state={current} controller={controller.current} /></CollapsibleContent>
  </Collapsible>;
}
