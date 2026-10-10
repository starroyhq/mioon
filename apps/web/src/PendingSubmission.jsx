import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.jsx';
import { isMutationOperation } from './mutation-submissions.js';
import { TIMELINE_MUTATION_OPERATIONS } from '@mioon/contracts';
import { isReferenceOperation } from './reference-connections.js';

export default function PendingSubmission({ entry, busy, onReplay }) {
  const mutation = isMutationOperation(entry.operation) || TIMELINE_MUTATION_OPERATIONS.includes(entry.operation) || isReferenceOperation(entry.operation);
  return <div className="job-card submission_unknown" data-testid="pending-submission">
    <div className="job-title"><Icon name="info" size={17} /><strong>请求结果待确认</strong></div>
    <p className="helper muted" style={{ marginTop: 12 }}>原编号与完整参数已保留。恢复时由服务器去重；不会自动重试或创建新的请求编号。</p>
    {mutation && <p className="helper muted" data-testid="mutation-recovery-storage">恢复记录仅存于当前浏览器会话，未经保险库加密。关闭窗口或重建应用会话可能丢失记录，请先恢复待确认请求。服务器会为保留的原编号保存去重结果。</p>}
    <div className="job-snapshot"><span>{entry.operation}</span><span>{new Date(entry.createdAt).toLocaleTimeString('zh-CN')}</span></div>
    <div className="job-actions"><Button variant="ghost" className="button small" data-testid="resume-pending" disabled={busy} onClick={onReplay}><Icon name="refresh" size={13} />恢复同一请求</Button></div>
  </div>;
}
