import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { message } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter, agentTimelineGainDisplay } from './creation-i18n.ts';
import React from 'react';
import type { AgentTimelineGainProposal, AgentTimelineGainReviewTarget } from '../../../packages/contracts/src/agent-timeline-gain.ts';
import type { AgentTimelineGainPolicy } from './agent-timeline-gain-context.ts';
import { agentTimelineGainText } from './agent-timeline-gain-context.ts';

export const AGENT_GAIN_SEND_CONTEXT = message('agent.gain.sendDisclosure');
export const AGENT_GAIN_SEND_CONSENT = message('agent.gain.sendConsent');
export function AgentTimelineGainWarnings({ muted, gain }: { muted: boolean; gain: number }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <>
    {muted && <p role="status" data-testid="agent-gain-track-muted">{t('agent.gain.mutedTrackWarning')}</p>}
    {gain > 1 && <p role="status" data-testid="agent-gain-clipping-risk">{t('agent.gain.clippingWarning')}</p>}
    <p data-testid="agent-gain-source-preview">{t('agent.gain.previewScope')}</p>
  </>;
}
export function AgentTimelineGainDiff({ proposal, visible = true }: { proposal: AgentTimelineGainProposal; visible?: boolean }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <div className="agent-edit-diff agent-timeline-diff" data-testid="agent-timeline-gain-diff" tabIndex={visible ? 0 : -1} aria-label={t('agent.gain.diffAria')}>
    <section><h4>{t('agent.gain.linearGainHeading')}</h4>
      <div className="agent-edit-diff-side"><span>{t('agent.gain.before')}</span><p data-testid="agent-gain-before">{agentTimelineGainDisplay(proposal.diff.before.gain, t)}</p></div>
      <div className="agent-edit-diff-arrow" aria-hidden="true">↓</div>
      <div className="agent-edit-diff-side is-after"><span>{t('agent.gain.proposedAfter')}</span><p data-testid="agent-gain-after">{agentTimelineGainDisplay(proposal.diff.after.gain, t)}</p></div>
      <p>{t('agent.gain.percentageDisclosure')}</p>
      <p data-testid="agent-gain-preserved">{t('agent.gain.preservedFields')}</p>
      <AgentTimelineGainWarnings muted={proposal.target.trackMuted} gain={proposal.diff.after.gain} />
    </section>
  </div>;
}
export function AgentTimelineGainSelection({ target, policy, blockedReason = '', blockedDescriptor = null, visible = true }: { target: AgentTimelineGainReviewTarget | null; policy?: AgentTimelineGainPolicy; blockedReason?: string; blockedDescriptor?: DisplayMessage | null; visible?: boolean }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <section className="agent-edit-selected agent-timeline-selected" data-testid="agent-gain-selected-target" aria-label={t('agent.gain.selectionAria')}>
    <strong>{t('agent.gain.singleAudioClip')}</strong>
    {target ? <>
      <p data-testid="agent-gain-target-summary">{t('agent.gain.targetSummary', { clipName: creationParameter(target.clipName), trackName: creationParameter(target.trackName), value: creationParameter(target.trackKind === 'audio' ? t('agent.gain.audioTrack') : t('agent.gain.videoTrack')), expectedRevision: creationParameter(target.expectedRevision) })}</p>
      <p data-testid="agent-gain-selected-value">{t('agent.gain.savedGainSummary', { value: creationParameter(agentTimelineGainDisplay(target.gain, t)), value2: creationParameter(target.trackMuted ? t('agent.gain.muted') : t('agent.gain.unmuted')) })}</p>
      <p>{t('agent.gain.modelHasNotHeardMedia')}</p>
      <AgentTimelineGainWarnings muted={target.trackMuted} gain={target.gain} />
      {policy && <p data-testid="agent-gain-policy">{t('agent.gain.toolLimits', { schemaVersion: creationParameter(policy.schemaVersion), catalogHash: creationParameter(policy.catalogHash.slice(0, 12)) })}</p>}
      <details className="agent-edit-identity"><summary className="agent-chat-details-trigger" tabIndex={visible ? 0 : -1}>{t('agent.gain.localIdentity')}</summary><p>{t('agent.gain.projectIdentity', { projectId: creationParameter(target.projectId) })}</p><p>{t('agent.gain.timelineIdentities', { timelineId: creationParameter(target.timelineId), clipId: creationParameter(target.clipId), trackId: creationParameter(target.trackId) })}</p></details>
    </> : <p role="status">{t('agent.gain.selectKnownAudio')}</p>}
    {blockedReason && <p role="status" data-testid="agent-gain-context-blocked">{blockedDescriptor ? renderMessage(blockedDescriptor) : t('agent.gain.state.checkTimelineState')}</p>}
  </section>;
}
export function AgentTimelineGainActivity({ target, sourceCount }: { target: AgentTimelineGainReviewTarget; sourceCount: number }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <p className="agent-run-provenance" data-testid="agent-run-provenance">{t('agent.gain.activityProvenance', { clipName: creationParameter(target.clipName), trackName: creationParameter(target.trackName), expectedRevision: creationParameter(target.expectedRevision), value: creationParameter(agentTimelineGainDisplay(target.gain, t)), value2: creationParameter(target.trackMuted ? t('agent.gain.muted') : t('agent.gain.unmuted')), value3: creationParameter(sourceCount ? t('agent.gain.chatTurnCount', { count: sourceCount }) : '') })}</p>;
}
