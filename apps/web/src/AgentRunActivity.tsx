import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter, agentTimelineFrameDisplay } from './creation-i18n.ts';
import React from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mioon/ui/components/collapsible';
import { AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT, agentTimelineFrameText, agentRunContextMode } from './agent-tool-state.ts';

import { AgentTimelineGainActivity } from './AgentTimelineGain.tsx';

const statusLabel = (step, stopped, editing, t) => ({
  not_started: stopped ? t('agent.activity.notStartedStopped') : t('agent.activity.notStarted'),
  intent: stopped ? t('agent.activity.intentStopped') : t('agent.activity.intentWaiting'),
  dispatch_started: step.kind === 'tool' ? (editing ? t('agent.activity.savingProposal') : t('agent.activity.reading')) : t('agent.activity.requestStarted'),
  completed: step.kind === 'tool' ? (editing ? t('agent.activity.proposalSaved') : t('agent.activity.readComplete')) : t('agent.activity.responseComplete'),
  unknown: t('agent.activity.unknownNoRetry'),
}[step.status] || t('agent.activity.unknown'));

// All model/tool strings stay React text. Results have no links, HTML, fetches,
// navigation, or action buttons, even when their contents look like commands.
export default function AgentRunActivity({ run, visible = true }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const inspected = agentRunContextMode(run) === AGENT_PROJECT_CONTEXT, moving = agentRunContextMode(run) === AGENT_TIMELINE_CONTEXT, gaining = agentRunContextMode(run) === AGENT_TIMELINE_GAIN_CONTEXT, editing = gaining || moving || agentRunContextMode(run) === AGENT_EDIT_CONTEXT;
  const stopped = run.status !== 'running';
  return <div className="agent-run-inspection" data-testid="agent-run-inspection" data-context-mode={agentRunContextMode(run)}>
    {gaining ? <AgentTimelineGainActivity target={run.editTarget} sourceCount={run.provenance.sourceRunIds.length} /> : moving ? <Collapsible className="agent-run-provenance" data-testid="agent-run-provenance">
      <CollapsibleTrigger className="agent-chat-details-trigger" disabled={!visible}>{t('agent.activity.moveSummary', { clipName: creationParameter(run.editTarget.clipName), expectedRevision: creationParameter(run.editTarget.expectedRevision) })}</CollapsibleTrigger>
      <CollapsibleContent><p>{t('agent.activity.moveAuthorization', { trackName: creationParameter(run.editTarget.trackName), clipName: creationParameter(run.editTarget.clipName), value: creationParameter(agentTimelineFrameDisplay(run.editTarget.startFrame, 30, t)), value2: creationParameter(agentTimelineFrameDisplay(run.editTarget.endFrame, 30, t)), count: run.editTarget.occupiedIntervals.length, value3: creationParameter(run.provenance.sourceRunIds.length ? t('agent.activity.chatTurnCount', { count: run.provenance.sourceRunIds.length }) : '') })}</p><p>{t('agent.activity.moveProvenance')}</p></CollapsibleContent>
    </Collapsible> : editing ? <p className="agent-run-provenance" data-testid="agent-run-provenance">{t('agent.activity.shotAuthorization', { projectId: creationParameter(run.provenance.projectId), shotId: creationParameter(run.editTarget.shotId), expectedRevision: creationParameter(run.editTarget.expectedRevision), value: creationParameter(run.provenance.sourceRunIds.length ? t('agent.activity.chatTurnCount', { count: run.provenance.sourceRunIds.length }) : '') })}</p> : inspected ? <Collapsible className="agent-run-provenance" data-testid="agent-run-provenance">
      <CollapsibleTrigger className="agent-chat-details-trigger" disabled={!visible}>{t('agent.activity.projectAuthorizationHeading')}</CollapsibleTrigger>
      <CollapsibleContent><p>{t('agent.activity.projectAuthorization', { projectId: creationParameter(run.provenance.projectId), value: creationParameter(run.provenance.sourceRunIds.length ? t('agent.activity.referencedTurns', { count: run.provenance.sourceRunIds.length }) : '') })}</p></CollapsibleContent>
    </Collapsible> : <p className="agent-run-provenance" data-testid="agent-run-provenance">{t('agent.activity.chatContext')}</p>}
    {run.activity?.length > 0 && <ol className="agent-run-activity" data-testid="agent-run-activity" aria-label={t('agent.activity.activityAria')}>
      {run.activity.map(step => <li key={step.id} data-step-id={step.id} data-kind={step.kind} data-status={step.status}>
        <div className="agent-run-step-heading"><strong>{step.kind === 'model' ? t('agent.activity.modelRequestOrdinal', { ordinal: creationParameter(step.ordinal), value: creationParameter(step.ordinal === 2 ? t('agent.activity.toolsDisabled') : '') }) : step.operation}</strong><span role="status">{statusLabel(step, stopped, editing, t)}</span></div>
        {step.kind === 'tool' && <p className="agent-run-tool-name">{step.name} · {gaining ? t('agent.activity.gainProposalScope') : moving ? t('agent.activity.moveProposalScope') : editing ? t('agent.activity.shotProposalScope') : t('agent.activity.readOnlyScope')}</p>}
        {step.resultJson !== undefined && <Collapsible className="agent-run-result">
          <CollapsibleTrigger className="agent-chat-details-trigger" disabled={!visible} data-testid="agent-tool-result-toggle">{editing ? t('agent.activity.viewProposalReceipt') : t('agent.activity.viewReadResult')}</CollapsibleTrigger>
          <CollapsibleContent><pre data-testid="agent-tool-result">{step.resultJson}</pre></CollapsibleContent>
        </Collapsible>}
      </li>)}
    </ol>}
  </div>;
}
