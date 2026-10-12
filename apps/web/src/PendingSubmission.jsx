import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.jsx';
import { isMutationOperation } from './mutation-submissions.js';
import { TIMELINE_MUTATION_OPERATIONS } from '@mioon/contracts';
import { isReferenceOperation } from './reference-connections.js';

export default function PendingSubmission({ entry, busy, onReplay, onAdopt, duplicate, heldReason }) {
  const mutation = isMutationOperation(entry.operation) || TIMELINE_MUTATION_OPERATIONS.includes(entry.operation) || isReferenceOperation(entry.operation);
  return <div className="job-card submission_unknown" data-testid="pending-submission">
    {heldReason && <p className="restored-held-label" data-testid="restored-pending-held">历史请求 · 暂停恢复</p>}
    <div className="job-title"><Icon name="info" size={17} /><strong>请求结果待确认</strong></div>
    <p className="helper muted" style={{ marginTop: 12 }}>原编号与完整参数保留在当前会话。恢复时由服务器去重；不会自动重试或创建新的请求编号。</p>
    {mutation && <p className="helper muted" data-testid="mutation-recovery-storage">恢复记录仅存于当前浏览器会话，未经保险库加密。关闭窗口或重建应用会话可能丢失记录，请先恢复待确认请求。服务器会为保留的原编号保存去重结果。</p>}
    {!mutation && <p className="helper muted" data-testid="session-request-storage">此待确认提交的恢复参数仍依赖当前浏览器会话。已被服务器接受的生成任务或导出记录会另行持久保存；未知提交不会自动重试。</p>}
    <div className="job-snapshot"><span>{entry.operation}</span><span>{new Date(entry.createdAt).toLocaleTimeString('zh-CN')}</span></div>
    {duplicate && <p className="helper muted" data-testid="legacy-task-duplicate">本地数据库已有此原编号。旧会话记录尚未清除，请明确转存并核对；不会静默隐藏任一记录。</p>}
    {heldReason && <p className="helper muted">{heldReason}</p>}
    <div className="job-actions">{onAdopt && <Button variant="ghost" className="button small" data-testid="adopt-legacy-task" disabled={busy || Boolean(heldReason)} title={heldReason} onClick={onAdopt}>转存原请求以便重启恢复</Button>}<Button variant="ghost" className="button small" data-testid="resume-pending" disabled={busy || Boolean(heldReason)} title={heldReason} onClick={onReplay}><Icon name="refresh" size={13} />恢复同一请求</Button></div>
  </div>;
}
