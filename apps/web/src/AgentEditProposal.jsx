import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mioon/ui/components/collapsible';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { agentEditCanApprove, agentEditCanRecover, agentEditStatusText, createAgentEditsSession, initialAgentEditsState } from './agent-edits.js';
import './agent-edits.css';

export function AgentEditDiff({ proposal }) {
  return <div className="agent-edit-diff" data-testid="agent-edit-diff" aria-label="不可修改的已保存提议差异">
    {['title', 'prompt'].map(field => <section key={field} data-field={field} data-changed={proposal.diff.before[field] !== proposal.diff.after[field]}>
      <h4>{field === 'title' ? '镜头标题' : '画面描述'}{proposal.diff.before[field] === proposal.diff.after[field] && <span> · 保持不变</span>}</h4>
      <div className="agent-edit-diff-side"><span>修改前</span><pre data-testid={`agent-edit-before-${field}`}>{proposal.diff.before[field] || '（空）'}</pre></div>
      <div className="agent-edit-diff-arrow" aria-hidden="true">↓</div>
      <div className="agent-edit-diff-side is-after"><span>提议修改后</span><pre data-testid={`agent-edit-after-${field}`}>{proposal.diff.after[field] || '（清空）'}</pre></div>
    </section>)}
  </div>;
}

// This review surface shares the right dock. Model prose has no action authority;
// only the independently loaded, persisted proposal controls these buttons.
export default function AgentEditProposal({ projectId, refreshKey, blockedRunIds = [], onApplied = () => {} }) {
  const visible = useWorkspaceVisibility(), [state, setState] = useState(initialAgentEditsState);
  const session = useRef(null), lifetime = useRef(null), visibleRef = useRef(visible), appliedRef = useRef(onApplied);
  const interaction = useMemo(() => ({ visible, projectId, blocked: blockedRunIds.join('|') }), [visible, projectId, blockedRunIds.join('|')]), interactionRef = useRef(interaction);
  appliedRef.current = onApplied;
  useLayoutEffect(() => {
    const owner = { projectId, closed: false }; lifetime.current = owner;
    const current = createAgentEditsSession({ projectId,
      onChange: next => { if (!owner.closed && lifetime.current === owner) setState(next); },
      onApplied: (id, proposal) => { if (!owner.closed && lifetime.current === owner && id === owner.projectId) appliedRef.current(id, proposal); },
    });
    session.current = current; setState(initialAgentEditsState());
    const page = typeof document === 'undefined' ? null : document;
    const updateVisibility = () => current.setVisible(visibleRef.current && page?.visibilityState !== 'hidden');
    page?.addEventListener('visibilitychange', updateVisibility); updateVisibility(); void current.load();
    return () => { owner.closed = true; current.dispose(); page?.removeEventListener('visibilitychange', updateVisibility); if (session.current === current) session.current = null; };
  }, [projectId]);
  useLayoutEffect(() => { interactionRef.current = interaction; visibleRef.current = visible; session.current?.setVisible(visible && (typeof document === 'undefined' || document.visibilityState !== 'hidden')); }, [interaction]);
  const lastRefresh = useRef(null);
  useLayoutEffect(() => { if (lastRefresh.current !== null && lastRefresh.current !== refreshKey) void session.current?.load(); lastRefresh.current = refreshKey; }, [refreshKey]);
  const owner = lifetime.current;
  const usable = () => Boolean(visible && interactionRef.current === interaction && owner && !owner.closed && lifetime.current === owner && owner.projectId === projectId);
  const busy = Boolean(state.busy), ready = visible && state.phase === 'ready' && !busy;
  return <section className="agent-edit-review" data-testid="agent-edit-review" data-project-id={projectId} data-phase={state.phase} aria-label="审阅已保存的镜头修改提议" hidden={!visible} inert={!visible}>
    <header><h3>镜头修改提议</h3><span>独立保存 · 可在重启后核对</span></header>
    <p>模型文字可能说“已修改”，请以这里的保存状态为准。只有明确批准后才会应用这份固定差异；不会自动执行、改写或重新基于新版本生成。</p>
    <div className="agent-edit-controls">
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-unresolved" aria-pressed={state.view === 'unresolved'} disabled={!visible || busy || state.phase === 'loading'} onClick={() => { if (usable()) void session.current?.chooseView('unresolved'); }}>待处理</Button>
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-all" aria-pressed={state.view === 'all'} disabled={!visible || busy || state.phase === 'loading'} onClick={() => { if (usable()) void session.current?.chooseView('all'); }}>全部记录</Button>
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-refresh" disabled={!visible || busy || state.phase === 'loading'} onClick={() => { if (usable()) void session.current?.load(); }}>只读核对</Button>
    </div>
    {state.message && <p role="status" className="agent-edit-notice" data-testid="agent-edits-notice">{state.message}</p>}
    {!state.proposals.length && <p role="status">{state.phase === 'loading' ? '正在读取保存的提议…' : state.phase === 'error' ? '提议状态暂不可用。' : state.view === 'unresolved' ? '没有待处理的提议。已应用、拒绝或失效的提议可在全部记录中查看。' : '还没有保存的修改提议。'}</p>}
    {state.proposals.map(proposal => {
      const uncertain = state.uncertainIds.includes(proposal.id), retryable = state.retryApprovalIds.includes(proposal.id), blocked = blockedRunIds.includes(proposal.runId);
      const reviewable = !blocked && agentEditCanApprove(proposal), recoverable = agentEditCanRecover(proposal);
      return <article className="agent-edit-card" key={proposal.id} data-testid="agent-edit-proposal" data-proposal-id={proposal.id} data-status={proposal.status}>
        <h4>shot.update <span>基准版本 {proposal.target.expectedRevision}</span></h4>
        <div className="agent-edit-status" data-testid="agent-edit-status" role="status">{uncertain && proposal.status === 'pending' ? '操作结果待确认，不能认定未应用' : agentEditStatusText(proposal.status)}</div>
        <p className="agent-edit-target">镜头 {proposal.target.shotId}</p>
        <AgentEditDiff proposal={proposal} />
        <Collapsible className="agent-edit-identity"><CollapsibleTrigger className="agent-chat-details-trigger" disabled={!visible}>查看提议身份与批准记录</CollapsibleTrigger><CollapsibleContent><p>提议 {proposal.id}</p><p>校验摘要 {proposal.digest}</p><p>来源运行 {proposal.runId} · {proposal.runStatus}</p>{proposal.approval && <p data-testid="agent-edit-approval-id">已保存的原请求 {proposal.approval.requestId}</p>}</CollapsibleContent></Collapsible>
        {proposal.status === 'pending' && !reviewable && <p>只有本轮成功完成后才能批准或拒绝。停止、失败或中断的运行不能批准；停止会使尚未批准的提议失效。</p>}
        {proposal.status === 'failed' && <p data-testid="agent-edit-failed">保存服务已确认未应用{proposal.outcome?.code === 'REVISION_CONFLICT' || proposal.outcome?.code === 'CONFLICT' ? '：镜头已变化，请核对最新保存内容。旧提议不会自动重新基于新版本修改。' : '。请核对提议和当前镜头。'}</p>}
        {proposal.status === 'applied' && <p data-testid="agent-edit-applied">保存服务已确认应用，镜头版本 {proposal.outcome.revision}。不会把属性面板中的更新草稿标记为已保存。</p>}
        {uncertain && retryable && <p>较早的批准请求可能已被接受。重试只提交同一提议、同一摘要的批准，复用服务端已保存的原请求；不会创建新差异或新请求 ID。</p>}
        {recoverable && <p>仅恢复上方已批准并保存的原请求，使用同一请求 ID 和差异。结果可能仍未知，不会创建新请求或再次调用模型。</p>}
        <div className="agent-edit-controls">
          {proposal.status === 'pending' && <>
            <Button type="button" variant="ghost" className="button primary" data-testid="agent-edit-approve" disabled={!ready || !reviewable || uncertain} onClick={() => { if (usable() && !blocked) void session.current?.act('approve', proposal); }}>批准并应用此差异</Button>
            <Button type="button" variant="ghost" className="button" data-testid="agent-edit-reject" disabled={!ready || !reviewable || uncertain} onClick={() => { if (usable() && !blocked) void session.current?.act('reject', proposal); }}>拒绝提议</Button>
          </>}
          {uncertain && retryable && <Button type="button" variant="ghost" className="button" data-testid="agent-edit-retry-approval" disabled={!ready || !reviewable} onClick={() => { if (usable() && !blocked) void session.current?.act('retry_approval', proposal); }}>重试同一批准请求</Button>}
          {recoverable && <Button type="button" variant="ghost" className="button" data-testid="agent-edit-recover" disabled={!ready} onClick={() => { if (usable()) void session.current?.act('recover', proposal); }}>恢复已批准的原请求</Button>}
          {(uncertain || recoverable) && <Button type="button" variant="ghost" className="button" data-testid="agent-edit-inspect" disabled={!visible || busy || state.phase === 'loading'} onClick={() => { if (usable()) void session.current?.inspect(proposal.id); }}>只读核对原提议</Button>}
        </div>
      </article>;
    })}
    {(state.nextCursor || state.trail.length > 0) && <div className="agent-edit-controls">
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-newer" disabled={!ready || !state.trail.length} onClick={() => { if (usable()) void session.current?.newer(); }}>上一页</Button>
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-older" disabled={!ready || !state.nextCursor} onClick={() => { if (usable()) void session.current?.older(); }}>下一页</Button>
      <span>每页最多 20 份 · 与聊天历史独立</span>
    </div>}
  </section>;
}
