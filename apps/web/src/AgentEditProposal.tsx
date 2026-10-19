import { agentEditStatusDescriptor } from './agent-edits.ts';
import { agentTimelineApprovalIssueDescriptor } from './agent-timeline-context.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter, agentTimelineFrameDisplay } from './creation-i18n.ts';
import { createAgentEditsCloseReporter } from './native-close-sources.ts';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mioon/ui/components/collapsible';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { agentEditCanApprove, agentEditCanRecover, agentEditStatusText, agentTimelineApprovalIssue, agentTimelineFrameText, createAgentEditsSession, initialAgentEditsState } from './agent-edits.ts';
import { isAgentTimelineGainProposal, isAgentTimelineMoveProposal, AGENT_TIMELINE_GAIN_CONTEXT } from './agent-timeline-context.ts';
import { AgentTimelineGainDiff } from './AgentTimelineGain.tsx';
import './agent-edits.css';

export function AgentEditDiff({ proposal }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <div className="agent-edit-diff" data-testid="agent-edit-diff" aria-label={t('agent.proposal.diffAria')}>
    {['title', 'prompt'].map(field => <section key={field} data-field={field} data-changed={proposal.diff.before[field] !== proposal.diff.after[field]}>
      <h4>{field === 'title' ? t('agent.proposal.shotTitle') : t('agent.proposal.visualDescription')}{proposal.diff.before[field] === proposal.diff.after[field] && <span> {t('agent.proposal.unchangedBadge')}</span>}</h4>
      <div className="agent-edit-diff-side"><span>{t('agent.proposal.before')}</span><pre data-testid={`agent-edit-before-${field}`}>{proposal.diff.before[field] || t('agent.proposal.empty')}</pre></div>
      <div className="agent-edit-diff-arrow" aria-hidden="true">↓</div>
      <div className="agent-edit-diff-side is-after"><span>{t('agent.proposal.proposedAfter')}</span><pre data-testid={`agent-edit-after-${field}`}>{proposal.diff.after[field] || t('agent.proposal.cleared')}</pre></div>
    </section>)}
  </div>;
}

export function AgentTimelineMoveDiff({ proposal, visible = true }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const { before, after } = proposal.diff, fps = proposal.target.fps;
  return <div className="agent-edit-diff agent-timeline-diff" data-testid="agent-timeline-diff" tabIndex={visible ? 0 : -1} aria-label={t('agent.proposal.moveDiffAria')}>
    <section><h4>{t('agent.proposal.clipPosition', { fps: creationParameter(fps) })}</h4>
      {['before', 'after'].map(side => <div key={side} className={`agent-edit-diff-side ${side === 'after' ? 'is-after' : ''}`}>
        <span>{side === 'before' ? t('agent.proposal.beforeMove') : t('agent.proposal.afterMove')}</span>
        <p data-testid={`agent-timeline-${side}-start`}>{t('agent.proposal.startTime', { value: creationParameter(agentTimelineFrameDisplay(proposal.diff[side].startFrame, fps, t)) })}</p>
        <p data-testid={`agent-timeline-${side}-end`}>{t('agent.proposal.endTime', { value: creationParameter(agentTimelineFrameDisplay(proposal.diff[side].endFrame, fps, t)) })}</p>
      </div>)}
      <p data-testid="agent-timeline-fixed-duration">{t('agent.proposal.fixedDuration', { value: creationParameter(agentTimelineFrameDisplay(before.durationFrames, fps, t)) })}</p>
      <p data-testid="agent-timeline-preserved">{t('agent.proposal.movePreservesFields')}</p>
      <p data-testid="agent-timeline-non-ripple">{t('agent.proposal.nonRippleMove')}</p>
      <p data-testid="agent-timeline-total-duration">{t('agent.proposal.totalDuration', { value: creationParameter(agentTimelineFrameDisplay(before.timelineDurationFrames, fps, t)), value2: creationParameter(agentTimelineFrameDisplay(after.timelineDurationFrames, fps, t)), value3: creationParameter(before.timelineDurationFrames === after.timelineDurationFrames ? t('agent.proposal.durationUnchanged') : t('agent.proposal.durationChanged')) })}</p>
    </section>
  </div>;
}

// This review surface shares the right dock. Model prose has no action authority;
// only the independently loaded, persisted proposal controls these buttons.
export default function AgentEditProposal({ nativeCloseRegistry, projectId, refreshKey, blockedRunIds = [], selectedTimelineClip = null, timelineEditBlockedReason = '', timelineEditBlockedDescriptor = null, selectedTimelineGainClip = null, timelineGainBlockedReason = '', timelineGainBlockedDescriptor = null, contextMode, onApplied = () => {} }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const visible = useWorkspaceVisibility(), [state, setState] = useState(initialAgentEditsState);
  const session = useRef(null), lifetime = useRef(null), visibleRef = useRef(visible), appliedRef = useRef(onApplied);
  const selectedTarget = contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? selectedTimelineGainClip : selectedTimelineClip;
  const blockedDescriptor = contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? timelineGainBlockedDescriptor : timelineEditBlockedDescriptor;
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
  return <section className="agent-edit-review" data-testid="agent-edit-review" data-project-id={projectId} data-phase={state.phase} aria-label={t('agent.proposal.reviewAria')} hidden={!visible} inert={!visible}>
    <header><h3>{t('agent.proposal.savedProposals')}</h3><span>{t('agent.proposal.independentlySaved')}</span></header>
    <p>{t('agent.proposal.proposalAuthority')}</p>
    <div className="agent-edit-controls">
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-unresolved" aria-pressed={state.view === 'unresolved'} disabled={!visible || busy || state.phase === 'loading'} onClick={() => { if (usable()) void session.current?.chooseView('unresolved'); }}>{t('agent.proposal.unresolved')}</Button>
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-all" aria-pressed={state.view === 'all'} disabled={!visible || busy || state.phase === 'loading'} onClick={() => { if (usable()) void session.current?.chooseView('all'); }}>{t('agent.proposal.allRecords')}</Button>
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-refresh" disabled={!visible || busy || state.phase === 'loading'} onClick={() => { if (usable()) void session.current?.load(); }}>{t('agent.proposal.readOnlyCheck')}</Button>
    </div>
    {state.pinnedIds.length >= 50 && <p role="status" data-testid="agent-edit-pin-capacity">{t('agent.proposal.pinCapacity')}</p>}
    {state.message && <p role="status" className="agent-edit-notice" data-testid="agent-edits-notice">{renderMessage(state.displayMessage)}</p>}
    {!state.proposals.length && <p role="status">{state.phase === 'loading' ? t('agent.proposal.loadingProposals') : state.phase === 'error' ? t('agent.proposal.proposalStatusUnavailable') : state.view === 'unresolved' ? t('agent.proposal.noPendingProposals') : t('agent.proposal.noSavedProposals')}</p>}
    {state.proposals.map(proposal => {
      const uncertain = state.uncertainIds.includes(proposal.id), retryable = state.retryApprovalIds.includes(proposal.id), blocked = blockedRunIds.includes(proposal.runId);
      const timelineGain = isAgentTimelineGainProposal(proposal), timelineMove = isAgentTimelineMoveProposal(proposal), timelineEdit = timelineGain || timelineMove;
      const selectionIssue = agentTimelineApprovalIssue(proposal, { target: selectedTarget, blockedReason, contextMode });
      const atPinLimit = state.pinnedIds.length >= 50 && !state.pinnedIds.includes(proposal.id);
      const reviewable = !blocked && agentEditCanApprove(proposal), approvable = reviewable && !selectionIssue && !atPinLimit, recoverable = agentEditCanRecover(proposal);
      return <article className="agent-edit-card" key={proposal.id} data-testid="agent-edit-proposal" data-proposal-id={proposal.id} data-status={proposal.status}>
        {state.pinnedIds.includes(proposal.id) && <p role="status" data-testid="agent-edit-pinned">{t('agent.proposal.pinnedOriginal')}</p>}
        <h4>{timelineGain ? t('agent.proposal.adjustClipGain') : timelineMove ? t('agent.proposal.moveTimelineClip') : 'shot.update'} <span>{t('agent.proposal.baseRevision', { expectedRevision: creationParameter(proposal.target.expectedRevision) })}</span></h4>
        <div className="agent-edit-status" data-testid="agent-edit-status" role="status">{uncertain && proposal.status === 'pending' ? t('agent.proposal.outcomeUnconfirmed') : renderMessage(agentEditStatusDescriptor(proposal.status))}</div>
        <p className="agent-edit-target">{timelineEdit ? t('agent.proposal.clipTrackSummary', { clipName: creationParameter(proposal.target.clipName), trackName: creationParameter(proposal.target.trackName), value: creationParameter(proposal.target.trackKind === 'audio' ? t('agent.proposal.audioTrack') : t('agent.proposal.videoTrack')) }) : t('agent.proposal.shotIdentity', { shotId: creationParameter(proposal.target.shotId) })}</p>
        {timelineGain ? <AgentTimelineGainDiff proposal={proposal} visible={visible} /> : timelineMove ? <AgentTimelineMoveDiff proposal={proposal} visible={visible} /> : <AgentEditDiff proposal={proposal} />}
        <Collapsible className="agent-edit-identity"><CollapsibleTrigger className="agent-chat-details-trigger" disabled={!visible}>{t('agent.proposal.viewIdentityApproval')}</CollapsibleTrigger><CollapsibleContent><p>{t('agent.proposal.operationIdentity', { operation: creationParameter(proposal.operation) })}</p>{timelineEdit && <><p>{t('agent.proposal.timelineIdentity', { timelineId: creationParameter(proposal.target.timelineId) })}</p><p>{t('agent.proposal.clipTrackIdentity', { clipId: creationParameter(proposal.target.clipId), trackId: creationParameter(proposal.target.trackId) })}</p></>}<p>{t('agent.proposal.proposalIdentity', { id: creationParameter(proposal.id) })}</p><p>{t('agent.proposal.digest', { digest: creationParameter(proposal.digest) })}</p><p>{t('agent.proposal.sourceRun', { runId: creationParameter(proposal.runId), runStatus: creationParameter(proposal.runStatus) })}</p>{proposal.approval && <p data-testid="agent-edit-approval-id">{t('agent.proposal.savedOriginalRequest', { requestId: creationParameter(proposal.approval.requestId) })}</p>}</CollapsibleContent></Collapsible>
        {proposal.status === 'pending' && !reviewable && <p>{t('agent.proposal.completedRunRequired')}</p>}
        {proposal.status === 'pending' && reviewable && selectionIssue && <p role="status" data-testid="agent-timeline-approval-blocked">{renderMessage(blockedReason && blockedDescriptor ? blockedDescriptor : agentTimelineApprovalIssueDescriptor(proposal, { target: selectedTarget, blockedReason, contextMode }))}</p>}
        {proposal.status === 'failed' && <p data-testid="agent-edit-failed">{t('agent.proposal.notAppliedReceipt', { value: creationParameter(proposal.outcome?.code === 'REVISION_CONFLICT' || proposal.outcome?.code === 'CONFLICT' ? t('agent.proposal.revisionConflictDetail') : t('agent.proposal.reviewCurrentContent')) })}</p>}
        {proposal.status === 'applied' && <p data-testid="agent-edit-applied">{t('agent.proposal.appliedHistoricalReceipt', { value: creationParameter(timelineEdit ? t('agent.proposal.timelineObject') : t('agent.proposal.shotObject')), revision: creationParameter(proposal.outcome.revision) })}</p>}
        {uncertain && retryable && <p>{t('agent.proposal.retryApprovalDisclosure')}</p>}
        {recoverable && <p>{t('agent.proposal.recoverOriginalDisclosure')}</p>}
        <div className="agent-edit-controls">
          {proposal.status === 'pending' && <>
            <Button type="button" variant="ghost" className="button primary" data-testid="agent-edit-approve" disabled={!ready || !approvable || uncertain} onClick={() => { if (usable() && approvable) void session.current?.act('approve', proposal); }}>{t('agent.proposal.approveApply')}</Button>
            <Button type="button" variant="ghost" className="button" data-testid="agent-edit-reject" disabled={!ready || !reviewable || uncertain} onClick={() => { if (usable() && !blocked) void session.current?.act('reject', proposal); }}>{t('agent.proposal.reject')}</Button>
          </>}
          {uncertain && retryable && <Button type="button" variant="ghost" className="button" data-testid="agent-edit-retry-approval" disabled={!ready || !approvable} onClick={() => { if (usable() && approvable) void session.current?.act('retry_approval', proposal); }}>{t('agent.proposal.retrySameApproval')}</Button>}
          {recoverable && <Button type="button" variant="ghost" className="button" data-testid="agent-edit-recover" disabled={!ready} onClick={() => { if (usable()) void session.current?.act('recover', proposal); }}>{t('agent.proposal.recoverApprovedRequest')}</Button>}
          {(uncertain || recoverable) && <Button type="button" variant="ghost" className="button" data-testid="agent-edit-inspect" disabled={!visible || busy || state.phase === 'loading'} onClick={() => { if (usable()) void session.current?.inspect(proposal.id); }}>{t('agent.proposal.inspectOriginal')}</Button>}
        </div>
      </article>;
    })}
    {(state.nextCursor || state.trail.length > 0) && <div className="agent-edit-controls">
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-newer" disabled={!ready || !state.trail.length} onClick={() => { if (usable()) void session.current?.newer(); }}>{t('agent.proposal.previousPage')}</Button>
      <Button type="button" variant="ghost" className="button" data-testid="agent-edits-older" disabled={!ready || !state.nextCursor} onClick={() => { if (usable()) void session.current?.older(); }}>{t('agent.proposal.nextPage')}</Button>
      <span>{t('agent.proposal.pageLimit')}</span>
    </div>}
  </section>;
}
