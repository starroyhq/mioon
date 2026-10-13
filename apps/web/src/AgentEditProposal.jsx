import { createAgentEditsCloseReporter } from './native-close-sources.ts';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mioon/ui/components/collapsible';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { agentEditCanApprove, agentEditCanRecover, agentEditStatusText, agentTimelineApprovalIssue, agentTimelineFrameText, createAgentEditsSession, initialAgentEditsState } from './agent-edits.js';
import { isAgentTimelineGainProposal, isAgentTimelineMoveProposal, AGENT_TIMELINE_GAIN_CONTEXT } from './agent-timeline-context.js';
import { AgentTimelineGainDiff } from './AgentTimelineGain.tsx';
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

export function AgentTimelineMoveDiff({ proposal, visible = true }) {
  const { before, after } = proposal.diff, fps = proposal.target.fps;
  return <div className="agent-edit-diff agent-timeline-diff" data-testid="agent-timeline-diff" tabIndex={visible ? 0 : -1} aria-label="不可修改的已保存片段移动差异">
    <section><h4>片段位置 · {fps} fps · 结束帧不包含在片段内</h4>
      {['before', 'after'].map(side => <div key={side} className={`agent-edit-diff-side ${side === 'after' ? 'is-after' : ''}`}>
        <span>{side === 'before' ? '移动前' : '提议移动后'}</span>
        <p data-testid={`agent-timeline-${side}-start`}>开始：{agentTimelineFrameText(proposal.diff[side].startFrame, fps)}</p>
        <p data-testid={`agent-timeline-${side}-end`}>结束：{agentTimelineFrameText(proposal.diff[side].endFrame, fps)}</p>
      </div>)}
      <p data-testid="agent-timeline-fixed-duration">片段时长保持 {agentTimelineFrameText(before.durationFrames, fps)}</p>
      <p data-testid="agent-timeline-preserved">仅改变当前轨道上的开始位置。源素材、裁切、画面位置和大小、音量及淡入淡出保持不变。</p>
      <p data-testid="agent-timeline-non-ripple">非波纹移动：不会自动移动其他片段，不会换轨、夹紧或避让。重叠、超界、字幕超出范围或版本变化会阻止应用。</p>
      <p data-testid="agent-timeline-total-duration">时间线总时长：{agentTimelineFrameText(before.timelineDurationFrames, fps)} → {agentTimelineFrameText(after.timelineDurationFrames, fps)}{before.timelineDurationFrames === after.timelineDurationFrames ? '（保持不变）' : '（移动末尾片段会改变总时长）'}</p>
    </section>
  </div>;
}

// This review surface shares the right dock. Model prose has no action authority;
// only the independently loaded, persisted proposal controls these buttons.
export default function AgentEditProposal({ nativeCloseRegistry, projectId, refreshKey, blockedRunIds = [], selectedTimelineClip = null, timelineEditBlockedReason = '', selectedTimelineGainClip = null, timelineGainBlockedReason = '', contextMode, onApplied = () => {} }) {
  const visible = useWorkspaceVisibility(), [state, setState] = useState(initialAgentEditsState);
  const session = useRef(null), lifetime = useRef(null), visibleRef = useRef(visible), appliedRef = useRef(onApplied);
  const selectedTarget = contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? selectedTimelineGainClip : selectedTimelineClip;
  const blockedReason = contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? timelineGainBlockedReason : timelineEditBlockedReason;
  const timelineKey = JSON.stringify([selectedTarget, blockedReason, contextMode]);
  const interaction = useMemo(() => ({ visible, projectId, blocked: blockedRunIds.join('|'), timelineKey }), [visible, projectId, blockedRunIds.join('|'), timelineKey]), interactionRef = useRef(interaction);
  appliedRef.current = onApplied;
  useLayoutEffect(() => {
    const owner = { projectId, closed: false }; lifetime.current = owner;
    const closeReport = createAgentEditsCloseReporter(nativeCloseRegistry);
    const current = createAgentEditsSession({ projectId,
      onChange: next => { if (!owner.closed && lifetime.current === owner) { closeReport.publish(next); setState(next); } },
      onApplied: (id, proposal) => { if (!owner.closed && lifetime.current === owner && id === owner.projectId) appliedRef.current(id, proposal); },
    });
    session.current = current; closeReport.publish(current.getState()); setState(initialAgentEditsState());
    const page = typeof document === 'undefined' ? null : document;
    const updateVisibility = () => current.setVisible(visibleRef.current && page?.visibilityState !== 'hidden');
    page?.addEventListener('visibilitychange', updateVisibility); updateVisibility(); void current.load();
    return () => { owner.closed = true; closeReport.release(); current.dispose(); page?.removeEventListener('visibilitychange', updateVisibility); if (session.current === current) session.current = null; };
  }, [projectId, nativeCloseRegistry]);
  useLayoutEffect(() => { interactionRef.current = interaction; visibleRef.current = visible; session.current?.setVisible(visible && (typeof document === 'undefined' || document.visibilityState !== 'hidden')); }, [interaction]);
  useLayoutEffect(() => { session.current?.setTimelineContext({ target: selectedTarget, blockedReason, contextMode }); }, [projectId, timelineKey]);
  const lastRefresh = useRef(null);
  useLayoutEffect(() => { if (lastRefresh.current !== null && lastRefresh.current !== refreshKey) void session.current?.load(); lastRefresh.current = refreshKey; }, [refreshKey]);
  const owner = lifetime.current;
  const usable = () => Boolean(visible && interactionRef.current === interaction && owner && !owner.closed && lifetime.current === owner && owner.projectId === projectId);
  const busy = Boolean(state.busy), ready = visible && state.phase === 'ready' && !busy;
  return <section className="agent-edit-review" data-testid="agent-edit-review" data-project-id={projectId} data-phase={state.phase} aria-label="审阅已保存的修改提议" hidden={!visible} inert={!visible}>
    <header><h3>已保存的修改提议</h3><span>独立保存 · 可在重启后核对</span></header>
    <p>模型文字可能说“已修改”，请以这里的保存状态为准。只有明确批准后才会应用这份固定差异；不会自动执行、改写或重新基于新版本生成。</p>
    <div className="agent-edit-controls">
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-unresolved" aria-pressed={state.view === 'unresolved'} disabled={!visible || busy || state.phase === 'loading'} onClick={() => { if (usable()) void session.current?.chooseView('unresolved'); }}>待处理</Button>
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-all" aria-pressed={state.view === 'all'} disabled={!visible || busy || state.phase === 'loading'} onClick={() => { if (usable()) void session.current?.chooseView('all'); }}>全部记录</Button>
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-refresh" disabled={!visible || busy || state.phase === 'loading'} onClick={() => { if (usable()) void session.current?.load(); }}>只读核对</Button>
    </div>
    {state.pinnedIds.length >= 50 && <p role="status" data-testid="agent-edit-pin-capacity">已有 50 份原操作待核对。请先只读核对或恢复保留的原提议，再批准新的提议。原身份与请求不会丢弃。</p>}
    {state.message && <p role="status" className="agent-edit-notice" data-testid="agent-edits-notice">{state.message}</p>}
    {!state.proposals.length && <p role="status">{state.phase === 'loading' ? '正在读取保存的提议…' : state.phase === 'error' ? '提议状态暂不可用。' : state.view === 'unresolved' ? '没有待处理的提议。已应用、拒绝或失效的提议可在全部记录中查看。' : '还没有保存的修改提议。'}</p>}
    {state.proposals.map(proposal => {
      const uncertain = state.uncertainIds.includes(proposal.id), retryable = state.retryApprovalIds.includes(proposal.id), blocked = blockedRunIds.includes(proposal.runId);
      const timelineGain = isAgentTimelineGainProposal(proposal), timelineMove = isAgentTimelineMoveProposal(proposal), timelineEdit = timelineGain || timelineMove;
      const selectionIssue = agentTimelineApprovalIssue(proposal, { target: selectedTarget, blockedReason, contextMode });
      const atPinLimit = state.pinnedIds.length >= 50 && !state.pinnedIds.includes(proposal.id);
      const reviewable = !blocked && agentEditCanApprove(proposal), approvable = reviewable && !selectionIssue && !atPinLimit, recoverable = agentEditCanRecover(proposal);
      return <article className="agent-edit-card" key={proposal.id} data-testid="agent-edit-proposal" data-proposal-id={proposal.id} data-status={proposal.status}>
        {state.pinnedIds.includes(proposal.id) && <p role="status" data-testid="agent-edit-pinned">原操作待核对 · 保留显示</p>}
        <h4>{timelineGain ? '调整一个片段的音量' : timelineMove ? '移动一个时间线片段' : 'shot.update'} <span>基准版本 {proposal.target.expectedRevision}</span></h4>
        <div className="agent-edit-status" data-testid="agent-edit-status" role="status">{uncertain && proposal.status === 'pending' ? '操作结果待确认，不能认定未应用' : agentEditStatusText(proposal.status)}</div>
        <p className="agent-edit-target">{timelineEdit ? `${proposal.target.clipName} · ${proposal.target.trackName}（${proposal.target.trackKind === 'audio' ? '音频轨道' : '视频轨道'}）` : `镜头 ${proposal.target.shotId}`}</p>
        {timelineGain ? <AgentTimelineGainDiff proposal={proposal} visible={visible} /> : timelineMove ? <AgentTimelineMoveDiff proposal={proposal} visible={visible} /> : <AgentEditDiff proposal={proposal} />}
        <Collapsible className="agent-edit-identity"><CollapsibleTrigger className="agent-chat-details-trigger" disabled={!visible}>查看提议身份与批准记录</CollapsibleTrigger><CollapsibleContent><p>操作 {proposal.operation}</p>{timelineEdit && <><p>时间线 {proposal.target.timelineId}</p><p>片段 {proposal.target.clipId} · 轨道 {proposal.target.trackId}</p></>}<p>提议 {proposal.id}</p><p>校验摘要 {proposal.digest}</p><p>来源运行 {proposal.runId} · {proposal.runStatus}</p>{proposal.approval && <p data-testid="agent-edit-approval-id">已保存的原请求 {proposal.approval.requestId}</p>}</CollapsibleContent></Collapsible>
        {proposal.status === 'pending' && !reviewable && <p>只有本轮成功完成后才能批准或拒绝。停止、失败或中断的运行不能批准；停止会使尚未批准的提议失效。</p>}
        {proposal.status === 'pending' && reviewable && selectionIssue && <p role="status" data-testid="agent-timeline-approval-blocked">{selectionIssue}</p>}
        {proposal.status === 'failed' && <p data-testid="agent-edit-failed">保存服务已确认未应用{proposal.outcome?.code === 'REVISION_CONFLICT' || proposal.outcome?.code === 'CONFLICT' ? '：已保存内容已变化，请核对最新版本。旧提议不会自动重新基于新版本修改。' : '。请核对提议和当前保存内容。'}</p>}
        {proposal.status === 'applied' && <p data-testid="agent-edit-applied">保存服务已确认应用，{timelineEdit ? '时间线' : '镜头'}版本 {proposal.outcome.revision}。这是一条历史回执；当前内容会单独读取，不会覆盖更新的时间线或把未保存草稿标记为已保存。</p>}
        {uncertain && retryable && <p>较早的批准请求可能已被接受。重试只提交同一提议、同一摘要的批准，复用服务端已保存的原请求；不会创建新差异或新请求 ID。</p>}
        {recoverable && <p>仅恢复上方已批准并保存的原请求，使用同一请求 ID 和差异。结果可能仍未知，不会创建新请求或再次调用模型。</p>}
        <div className="agent-edit-controls">
          {proposal.status === 'pending' && <>
            <Button type="button" variant="ghost" className="button primary" data-testid="agent-edit-approve" disabled={!ready || !approvable || uncertain} onClick={() => { if (usable() && approvable) void session.current?.act('approve', proposal); }}>批准并应用此差异</Button>
            <Button type="button" variant="ghost" className="button" data-testid="agent-edit-reject" disabled={!ready || !reviewable || uncertain} onClick={() => { if (usable() && !blocked) void session.current?.act('reject', proposal); }}>拒绝提议</Button>
          </>}
          {uncertain && retryable && <Button type="button" variant="ghost" className="button" data-testid="agent-edit-retry-approval" disabled={!ready || !approvable} onClick={() => { if (usable() && approvable) void session.current?.act('retry_approval', proposal); }}>重试同一批准请求</Button>}
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
