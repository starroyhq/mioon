import { agentChatErrorDescriptor, agentChatPromptIssueDescriptor } from './agent-chat.ts';
import type { AgentChatRun, AgentChatState, AgentChatTimelineTarget } from './agent-chat.ts';
import type { NativeCloseSourceRegistry } from './native-close-sources.ts';
import type { EditorSettingsScope } from './editor-settings-scope.ts';
import type { AgentTimelineMoveReviewTarget } from '../../../packages/contracts/src/agent-timeline-move.ts';
import type { AgentTimelineGainReviewTarget } from '../../../packages/contracts/src/agent-timeline-gain.ts';
import type { AgentTimelineGainPolicy } from './agent-timeline-gain-context.ts';
import type { AgentEditProposal as AgentEditProposalRecord } from './agent-edits.ts';
import type { AppShot } from './App.tsx';
import type { DisplayMessage, MessageKey } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter, agentTimelineFrameDisplay } from './creation-i18n.ts';
import { useNativeSettingsActivity } from './editor-settings-scope.ts';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Textarea } from '@mioon/ui/components/textarea';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mioon/ui/components/collapsible';
import {Dialog,DialogContent,DialogTitle,DialogDescription,DialogFooter} from '@mioon/ui/components/dialog';
import { agentTimelineFrameText } from './agent-tool-state.ts';
import AgentRunActivity from './AgentRunActivity.tsx';
import type { AgentRunView } from './AgentRunActivity.tsx';
import AgentEditProposal from './AgentEditProposal.tsx';
import { createAgentChatCloseReporter } from './native-close-sources.ts';
import { AgentTimelineGainSelection, AGENT_GAIN_SEND_CONTEXT, AGENT_GAIN_SEND_CONSENT } from './AgentTimelineGain.tsx';
import { WorkbenchTooltip } from './WorkspaceControls.tsx';
import Icon from './icons.tsx';
import './agent-chat-history.css';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { AGENT_PROTOCOLS, deriveAgentEndpoint, AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT, agentTimelineGainAvailable, agentTimelineAvailable, agentChatCurrentTarget, agentEditAvailable, agentInspectionAvailable, AGENT_CHAT_PROMPT_BYTES, activeAgentChatRun, agentChatCanSend, agentChatConsentKey, agentChatErrorText,
  agentChatPromptIssue, createAgentChatSession, initialAgentChatState } from './agent-chat.ts';

type Translate = ReturnType<typeof useI18n>['t'];
type RenderMessage = ReturnType<typeof useI18n>['renderMessage'];
type AgentChatSession = ReturnType<typeof createAgentChatSession>;
interface TimelineTargetView extends AgentChatTimelineTarget {readonly occupiedIntervals: ReadonlyArray<{readonly startFrame: number; readonly endFrame: number}>}
interface PolicyView {readonly schemaVersion: number; readonly catalogHash: string}
interface ActivityStepView {readonly id: string; readonly kind: string; readonly status: string}
export interface AgentPanelProps {
  nativeSettingsScope?: unknown;
  nativeCloseRegistry?: unknown;
  projectId: string;
  projectName?: string;
  selectedShot?: AppShot | null;
  selectedTimelineClip?: AgentTimelineMoveReviewTarget | null;
  selectedTimelineGainClip?: AgentTimelineGainReviewTarget | null;
  timelineEditBlockedReason?: string;
  timelineEditBlockedDescriptor?: DisplayMessage | null;
  timelineGainBlockedReason?: string;
  timelineGainBlockedDescriptor?: DisplayMessage | null;
  onApplied?: (projectId: string, proposal: AgentEditProposalRecord) => unknown;
  onClose: () => unknown;
  onSettings: () => unknown;
  onDraftChange?: (dirty: boolean) => unknown;
}
const runLabel = (status: string, t: Translate): string => {
  const labels: Readonly<Record<string, string>> = { running: t('agent.chat.replyRunning'), completed: t('agent.chat.replyComplete'), stopped: t('agent.chat.replyStopped'), failed: t('agent.chat.replyFailed'), interrupted: t('agent.chat.replyInterrupted') };
  return labels[status] || t('agent.chat.statusUnknown');
};
const phaseLabel = (phase: string, t: Translate): string => {
  const labels: Readonly<Record<string, string>> = { loading: t('agent.chat.loadingConversation'), submitting: t('agent.chat.confirmingSend'), streaming: t('agent.chat.receivingProgress'), stopping: t('agent.chat.requestingStop'), detached: t('agent.chat.displayDisconnected'), unknown: t('agent.chat.runUnconfirmed'), load_error: t('agent.chat.loadFailed'), ready: t('agent.chat.waitingForMessage') };
  return labels[phase] || t('agent.chat.statusUnconfirmed');
};

function renderRun(run: AgentChatRun, kind: 'recent' | 'archive' | 'recovered', visible: boolean, t: Translate, renderMessage: RenderMessage): React.ReactElement {
  return <article className="agent-chat-turn" key={`${kind}-${run.id}`} data-run-id={run.id} data-history-kind={kind} data-status={run.status}>
          <div className="agent-chat-message is-user"><div className="agent-chat-speaker">{t('agent.chat.you')}</div><p>{run.userText}</p></div>
          <div className="agent-chat-message is-assistant"><div className="agent-chat-speaker"><Icon name="sparkle" size={12} />Agent<span>{runLabel(run.status, t)}</span></div>
            <AgentRunActivity run={run as unknown as AgentRunView} visible={visible} />
            <p data-testid={kind === 'recent' ? 'agent-chat-response' : 'agent-chat-history-response'}>{run.assistantText || (run.status === 'running' ? t('agent.chat.awaitingFirstText') : t('agent.chat.noReplyText'))}</p>
            {run.status === 'interrupted' && <div className="agent-chat-run-error" role="status" data-testid="agent-chat-interrupted">{t('agent.chat.interruptedDisclosure')}</div>}
            {run.error && <div className="agent-chat-run-error" role="status">{renderMessage(agentChatErrorDescriptor(run.error.code))}</div>}
            <div className="agent-chat-run-model" data-testid="agent-chat-run-destination"><span>{AGENT_PROTOCOLS[run.configuration.protocol].label} · {run.configuration.model}</span><span className="agent-chat-endpoint" title={deriveAgentEndpoint(run.configuration)}>{deriveAgentEndpoint(run.configuration)}</span></div>
          </div>
        </article>;
}

export default function AgentPanel({ nativeSettingsScope, nativeCloseRegistry, projectId, projectName, selectedShot = null, selectedTimelineClip = null, timelineEditBlockedReason = '', timelineEditBlockedDescriptor = null, selectedTimelineGainClip = null, timelineGainBlockedReason = '', timelineGainBlockedDescriptor = null, onApplied, onClose, onSettings, onDraftChange = () => {} }: AgentPanelProps): React.ReactElement {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const [state, setState] = useState<AgentChatState>(initialAgentChatState);
  const [disclosure, setDisclosure] = useState<{key: string | null; expanded: boolean; reviewed: boolean}>({ key: null, expanded: true, reviewed: false });
  const [composerDisclosure, setComposerDisclosure] = useState<{projectId: string | null; key: string | null; consented: boolean; expanded: boolean}>({ projectId: null, key: null, consented: false, expanded: false });
  const [authorizationIntent,setAuthorizationIntent]=useState<{key: string | null; checked: boolean; sendAfterApproval: boolean; message: string | null}>({key:null,checked:false,sendAfterApproval:false,message:null});
  const disclosureIdentity = useRef<string | null>(null);
  const paneVisible = useWorkspaceVisibility();
  const nativeSession = useRef<AgentChatSession | null>(null);
  const nativeActive = useNativeSettingsActivity(nativeSettingsScope as EditorSettingsScope | undefined, active => nativeSession.current?.setVisible(active && paneVisible && document.visibilityState !== 'hidden'));
  const visible = paneVisible && nativeActive;
  const selectedKey = JSON.stringify([selectedShot ? [selectedShot.id, selectedShot.revision, selectedShot.title, selectedShot.prompt] : null, selectedTimelineClip, timelineEditBlockedReason, selectedTimelineGainClip, timelineGainBlockedReason]);
  const policyKey = JSON.stringify([state.contextMode, state.snapshot?.instanceId, state.snapshot?.revision, state.snapshot?.settings, state.snapshot?.timelineEdit, state.snapshot?.timelineGainEdit]);
  const interaction = useMemo(() => ({ visible, selectedKey, policyKey }), [visible, selectedKey, policyKey]);
  const interactionRef = useRef<typeof interaction | null>(interaction), visibilityRef = useRef<boolean>(visible);
  type OwnedSession = {projectId: string; closed: boolean};
  const session = useRef<AgentChatSession | null>(null), lifetime = useRef<OwnedSession | null>(null), composer = useRef<HTMLTextAreaElement | null>(null), scroll = useRef<HTMLDivElement | null>(null), archiveScroll = useRef<HTMLDivElement | null>(null), follow = useRef<boolean>(true);
  useLayoutEffect(() => {
    const owner: OwnedSession = { projectId, closed: false }; lifetime.current = owner;
    const closeReport = createAgentChatCloseReporter(nativeCloseRegistry as NativeCloseSourceRegistry | undefined);
    setState(initialAgentChatState()); follow.current = true;
    const current = createAgentChatSession({ projectId, onChange: next => { if (lifetime.current === owner && !owner.closed) { closeReport.publish(next); setState(next); } } });
    session.current = current; nativeSession.current = current;
    closeReport.publish(current.getState());
    const page = typeof document === 'undefined' ? null : document;
    const visibilityChanged = () => current.setVisible(visibilityRef.current && page?.visibilityState !== 'hidden');
    page?.addEventListener('visibilitychange', visibilityChanged);
    visibilityChanged();
    void current.load();
    return () => { page?.removeEventListener('visibilitychange', visibilityChanged); owner.closed = true; closeReport.release(); current.dispose(); if (session.current === current) session.current = null; if (lifetime.current === owner) lifetime.current = null; };
  }, [projectId, nativeCloseRegistry]);
  useLayoutEffect(() => {
    interactionRef.current = interaction; visibilityRef.current = visible;
    session.current?.setVisible(visible && (typeof document === 'undefined' || document.visibilityState !== 'hidden'));
  }, [interaction]);
  useLayoutEffect(() => { session.current?.setEditTarget(selectedShot); }, [projectId, selectedKey]);
  useLayoutEffect(() => { session.current?.setTimelineTarget(selectedTimelineClip, timelineEditBlockedReason); }, [projectId, selectedKey]);
  useLayoutEffect(() => { session.current?.setTimelineGainTarget(selectedTimelineGainClip, timelineGainBlockedReason); }, [projectId, selectedKey]);
  useLayoutEffect(() => { onDraftChange(Boolean(state.draft.trim()) && !state.pending); }, [state.draft, state.pending, onDraftChange]);
  useLayoutEffect(() => () => { onDraftChange(false); }, [projectId]);
  const owner = lifetime.current;
  // Every handler belongs to this render's immutable owner, including close.
  const usable = () => Boolean(visible && interactionRef.current === interaction && owner && !owner.closed && lifetime.current === owner && owner.projectId === projectId);
  const dismiss = (settings: boolean): void => {
    if (!usable()) return;
    if (settings && nativeSettingsScope) { void (nativeSettingsScope as EditorSettingsScope).open('agent'); return; }
    interactionRef.current = null; session.current?.setVisible(false);
    if (settings) {
      const current = session.current;
      const restoreRejectedSettings = (accepted: unknown): void => {
        if (accepted === false && session.current === current && lifetime.current === owner && owner !== null && !owner.closed && visibilityRef.current && interactionRef.current === null) {
          interactionRef.current = interaction; current?.setVisible(typeof document === 'undefined' || document.visibilityState !== 'hidden');
        }
      };
      void Promise.resolve().then(() => onSettings()).then(restoreRejectedSettings, () => restoreRejectedSettings(false));
    } else onClose();
  };
  const { snapshot, phase } = state;
  const running = activeAgentChatRun(state), pending = Boolean(state.pending);
  const configuration = snapshot?.settings.configuration;
  const inspectionPolicy = snapshot?.inspection as PolicyView | null | undefined, editPolicy = snapshot?.edit as PolicyView | null | undefined, timelineEditPolicy = snapshot?.timelineEdit as PolicyView | null | undefined;
  const timelineTargetView = state.timelineTarget as TimelineTargetView | null;
  const inspectionAvailable = agentInspectionAvailable(snapshot as unknown as Parameters<typeof agentInspectionAvailable>[0]), inspecting = state.contextMode === AGENT_PROJECT_CONTEXT;
  const editAvailable = agentEditAvailable(snapshot as unknown as Parameters<typeof agentEditAvailable>[0]), editing = state.contextMode === AGENT_EDIT_CONTEXT;
  const timelineAvailable = agentTimelineAvailable(snapshot), moving = state.contextMode === AGENT_TIMELINE_CONTEXT, selectedTarget = agentChatCurrentTarget(state);
  const gainAvailable = agentTimelineGainAvailable(snapshot), gaining = state.contextMode === AGENT_TIMELINE_GAIN_CONTEXT;
  // Presentation state is tied to the exact displayed disclosure, never approval.
  // A changed target, saved text, scope, destination or policy reopens the details.
  const disclosureKey = JSON.stringify([projectId, state.contextMode, selectedTarget, timelineEditBlockedReason, snapshot?.instanceId, snapshot?.settings.revision, configuration, snapshot?.edit, snapshot?.timelineEdit, snapshot?.timelineGainEdit, timelineGainBlockedReason]);
  useLayoutEffect(() => {
    disclosureIdentity.current = disclosureKey;
    setDisclosure({ key: disclosureKey, expanded: true, reviewed: false });
  }, [disclosureKey]);
  const disclosureOpen = disclosure.key !== disclosureKey || disclosure.expanded;
  const disclosureReviewed = disclosure.key === disclosureKey && disclosure.reviewed;
  const sendConsented = Boolean(snapshot && state.consent !== null && state.consent === agentChatConsentKey(snapshot, state.contextMode, selectedTarget));
  const canCompactDisclosure = disclosureReviewed || sendConsented;
  // Initial retained permission and a new approval compact this presentation.
  // A changed mounted destination/scope/selection is disclosed even if granted.
  const composerKeyChanged = composerDisclosure.key !== disclosureKey;
  const composerOptionsOpen = !sendConsented || (composerDisclosure.projectId === projectId && (composerKeyChanged ? composerDisclosure.consented : composerDisclosure.expanded));
  const composerOptionsVisible = visible && composerOptionsOpen;
  useLayoutEffect(() => {
    setComposerDisclosure(previous => ({ projectId, key: disclosureKey, consented: sendConsented,
      expanded: Boolean(previous.projectId === projectId && sendConsented && previous.consented && previous.key !== disclosureKey) }));
  }, [disclosureKey, sendConsented]);
  const optionsInteraction = useMemo(() => ({ disclosureKey, sendConsented, composerOptionsVisible, interaction }), [disclosureKey, sendConsented, composerOptionsVisible, interaction]);
  const optionsInteractionRef = useRef<typeof optionsInteraction | null>(null);
  useLayoutEffect(() => { optionsInteractionRef.current = optionsInteraction; return () => { optionsInteractionRef.current = null; }; }, [optionsInteraction]);
  const optionsUsable = () => usable() && composerOptionsVisible && optionsInteractionRef.current === optionsInteraction;

  const proposalRefresh = JSON.stringify(snapshot?.runs.map(run => [run.id, run.status, (Array.isArray(run.activity) ? run.activity as ActivityStepView[] : []).filter(step => step.kind === 'tool').map(step => [step.id, step.status])]) || []);
  const blockedRunIds = snapshot?.runs.filter(run => run.status !== 'completed').map(run => run.id) || [];
  const ready = visible && phase === 'ready', canSend = visible && agentChatCanSend(state);
  const promptBytes = new TextEncoder().encode(state.draft).length;
  const promptIssue = state.draft ? renderMessage(agentChatPromptIssueDescriptor(state.draft)) : '';
  const authorizationKey=agentChatConsentKey(snapshot,state.contextMode,selectedTarget);
  const authorizationReady=Boolean(ready&&!pending&&!running&&!state.authorizing&&authorizationKey&&
    !(moving&&timelineEditBlockedReason||gaining&&timelineGainBlockedReason));
  const canStart=canSend||Boolean(authorizationReady&&state.draft.trim()&&!promptIssue);
  const lastRun = snapshot?.runs.at(-1);
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [lastRun?.assistantText, lastRun?.status, lastRun?.lastEventId, snapshot?.runs.length, state.pending]);
  useLayoutEffect(() => { if (archiveScroll.current) archiveScroll.current.scrollTop = 0; }, [state.history.before]);
  async function send() {
    if (!usable()) return;
    if(!sendConsented){if(canStart)setAuthorizationIntent({key:disclosureKey,checked:false,sendAfterApproval:true,message:state.draft});return;}
    const current = session.current, key = disclosureKey, editSend = editing || moving || gaining;
    const accepted = await current?.send();
    if (accepted && editSend && owner && !owner.closed && lifetime.current === owner && session.current === current && disclosureIdentity.current === key)
      setDisclosure({ key, expanded: false, reviewed: true });
  }
  async function confirmAuthorization(){
    if(!usable()||authorizationIntent.key!==disclosureKey||!authorizationIntent.checked||!authorizationReady)return;
    const current=session.current,key=disclosureKey,{sendAfterApproval,message}=authorizationIntent;
    if(sendAfterApproval&&current?.getState().draft!==message)return;
    const approved=await current?.approve(true);
    if(!current||!approved||!usable()||!owner||owner.closed||lifetime.current!==owner||session.current!==current||disclosureIdentity.current!==key)return;
    setAuthorizationIntent({key:null,checked:false,sendAfterApproval:false,message:null});
    // Approval may finish after a draft, target or destination changes. Continue
    // only the exact send that opened this dialog, using the session's own gate.
    const approvedState=current.getState();
    if(sendAfterApproval&&approvedState.draft===message&&approvedState.consent===agentChatConsentKey(approvedState.snapshot,approvedState.contextMode,agentChatCurrentTarget(approvedState))){
      const accepted=await current.send();
      if(accepted&&(editing||moving||gaining)&&usable()&&session.current===current&&disclosureIdentity.current===key)setDisclosure({key,expanded:false,reviewed:true});
    }
  }
  function submit(event: React.FormEvent<HTMLFormElement>): void { event.preventDefault(); void send(); }
  return <section className="agent-chat-page" data-testid="agent-chat-page" data-project-id={projectId} data-phase={phase} aria-label={t('agent.chat.conversationAria')} hidden={!visible} inert={!visible}>
      <header className="modal-header agent-chat-header">
        <div className="agent-chat-heading"><span className="agent-chat-symbol"><Icon name="sparkle" size={21} /></span><div>
          <div className="agent-chat-eyebrow">{t('agent.chat.conversationEyebrow')}</div><h2>{t('agent.chat.conversationHeading')}</h2>
        </div></div>
        <div className="agent-chat-header-actions"><WorkbenchTooltip content={t('agent.chat.settingsKeepDraft')}><Button type="button" variant="ghost" className="icon-button" aria-label={t('agent.chat.connectionSettings')} data-testid="agent-chat-settings" disabled={!visible} onClick={() => dismiss(true)}><Icon name="settings" size={17} /></Button></WorkbenchTooltip><Button type="button" variant="ghost" className="icon-button" aria-label={t('agent.chat.collapsePanel')} data-testid="agent-chat-close" disabled={!visible} onClick={() => dismiss(false)}><Icon name="close" /></Button></div>
      </header>
      <div className="agent-chat-scroll" ref={scroll} data-testid="agent-chat-history" onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; }}>
      <div className="agent-chat-project"><Icon name="folder" size={13} /><strong>{projectName || t('agent.chat.currentProject')}</strong><span className="sr-only">{t('agent.chat.projectId', {projectId:creationParameter(projectId)})}</span><span className="agent-chat-local-label">{inspecting || editing || moving || gaining ? t('agent.chat.selectedProjectScope') : t('agent.chat.chatDoesNotSendLabel')}</span></div>
      <Collapsible className="agent-chat-session-note agent-chat-persistence-note" data-testid="agent-chat-persistence">
        <div className="agent-chat-storage-summary"><CollapsibleTrigger className="agent-chat-details-trigger" disabled={!visible} data-testid="agent-chat-details-toggle"><Icon name="info" size={13} />{t('agent.chat.storageAndExecution')}</CollapsibleTrigger>{snapshot?.mode === 'simulated' && <Badge className="small-badge neutral" data-testid="agent-chat-simulated">{t('agent.chat.simulatedRun')}</Badge>}</div>
        <CollapsibleContent className="agent-chat-details" data-testid="agent-chat-details">
          <p>{gaining ? t('agent.chat.gainScope') : moving ? t('agent.chat.moveScope') : editing ? t('agent.chat.shotScope') : inspecting ? t('agent.chat.inspectionScope') : t('agent.chat.chatScope')}</p>
          <p>{t('agent.chat.localStorageDisclosure')}</p>
          <p>{t('agent.chat.draftPersistence')}</p>
          <p>{t('agent.chat.contextLimits')}</p>
          {inspectionPolicy && <p data-testid="agent-chat-inspection-policy">{t('agent.chat.readOnlyToolVersion', { schemaVersion: creationParameter(inspectionPolicy.schemaVersion), catalogHash: creationParameter(inspectionPolicy.catalogHash.slice(0, 12)) })}</p>}
          <p>{t('agent.chat.inspectionDisclosure')}</p>
          <p>{t('agent.chat.shotProposalDisclosure')}</p>
          <p>{t('agent.chat.moveProposalDisclosure')}</p>
          <p>{t('agent.chat.hiddenRunDisclosure')}</p>
        </CollapsibleContent>
      </Collapsible>
        {state.sessionLost && <div className="agent-chat-warning" role="status" data-testid="agent-chat-session-lost">{t('agent.chat.backendRestarted')}</div>}
        {!snapshot ? <div className="agent-chat-empty"><Icon name="sparkle" size={26} /><h3>{phase === 'loading' ? t('agent.chat.loadingSavedConversation') : t('agent.chat.conversationUnavailable')}</h3><p>{t('agent.chat.openReadsOnly')}</p></div> : !snapshot.runs.length && !pending ? <div className="agent-chat-empty"><Icon name="sparkle" size={26} /><h3>{t('agent.chat.startWithIdea')}</h3><p>{gaining ? t('agent.chat.gainEmptyHint') : moving ? t('agent.chat.moveEmptyHint') : editing ? t('agent.chat.shotEmptyHint') : inspecting ? t('agent.chat.inspectionEmptyHint') : t('agent.chat.chatEmptyHint')}</p></div> : null}
        {(snapshot?.historyCursor || state.history.phase !== 'closed') && <section className="agent-chat-archive" data-testid="agent-chat-archive" aria-label={t('agent.chat.olderSavedConversation')}>
          <div className="agent-chat-archive-heading"><strong>{t('agent.chat.olderSavedConversation')}</strong><span>{t('agent.chat.historyPageLimit')}</span></div>
          <p>{t('agent.chat.historyReadOnly')}</p>
          <div className="agent-chat-archive-controls">
            <Button type="button" variant="ghost" className="button" data-testid="agent-chat-history-older" disabled={!visible || state.history.phase === 'loading' || !(state.history.page ? state.history.page.historyCursor : snapshot?.historyCursor)} onClick={() => { if (usable()) void session.current?.earlier(); }}>{state.history.phase === 'loading' ? t('agent.chat.loading') : state.history.page ? t('agent.chat.olderPage') : t('agent.chat.viewOlderHistory')}</Button>
            {state.history.page && <Button type="button" variant="ghost" className="button" data-testid="agent-chat-history-newer" disabled={!visible || state.history.phase === 'loading' || !state.history.trail.length} onClick={() => { if (usable()) void session.current?.newer(); }}>{t('agent.chat.newerPage')}</Button>}
            {state.history.phase !== 'closed' && <Button type="button" variant="ghost" className="button" data-testid="agent-chat-history-close" disabled={!visible} onClick={() => { if (usable()) session.current?.closeHistory(); }}>{t('agent.chat.collapseHistory')}</Button>}
          </div>
          {state.history.message && <p role="status" data-testid="agent-chat-history-error">{renderMessage(state.history.displayMessage)}</p>}
          {state.history.page && <div className="agent-chat-archive-page" ref={archiveScroll} data-testid="agent-chat-history-page" aria-label={t('agent.chat.savedHistoryPage')} aria-busy={state.history.phase === 'loading'} tabIndex={visible ? 0 : -1}>
            {state.history.page.runs.map(run => renderRun(run, 'archive', visible, t, renderMessage))}
            {!state.history.page.historyCursor && <p role="status">{t('agent.chat.oldestRecordReached')}</p>}
          </div>}
        </section>}
        {state.recoveredRun && <section className="agent-chat-archive" data-testid="agent-chat-recovered-request" aria-label={t('agent.chat.confirmedOriginalRequest')}><p>{t('agent.chat.originalRequestFound')}</p>{renderRun(state.recoveredRun, 'recovered', visible, t, renderMessage)}</section>}
        {snapshot?.runs.map(run => renderRun(run, 'recent', visible, t, renderMessage))}
        {state.pending && <div className="agent-chat-pending" data-testid="agent-chat-pending"><div className="agent-chat-speaker">{t('agent.chat.sendUnconfirmed')}</div>{state.pending.userText && <p>{state.pending.userText}</p>}<span>{t('agent.chat.checkingOriginalRequest')}</span>
          {phase === 'unknown' && snapshot && <div className="agent-chat-archive-controls">
            {!state.abandonRequest ? <Button type="button" variant="ghost" className="button" data-testid="agent-chat-pending-reset" disabled={!visible} onClick={() => { if (usable()) session.current?.confirmAbandonPending(true); }}>{t('agent.chat.endPendingState')}</Button> : <>
              <p role="alert" data-testid="agent-chat-pending-reset-warning">{t('agent.chat.endPendingWarning')}</p>
              <Button type="button" variant="ghost" className="button" data-testid="agent-chat-pending-reset-confirm" disabled={!visible} onClick={() => { if (usable()) session.current?.abandonPending(state.pending!.requestId); }}>{t('agent.chat.acceptEndPending')}</Button>
              <Button type="button" variant="ghost" className="button" data-testid="agent-chat-pending-reset-cancel" disabled={!visible} onClick={() => { if (usable()) session.current?.confirmAbandonPending(false); }}>{t('agent.chat.keepChecking')}</Button>
            </>}
          </div>}
        </div>}
        <AgentEditProposal nativeCloseRegistry={nativeCloseRegistry as NativeCloseSourceRegistry | undefined} projectId={projectId} refreshKey={proposalRefresh} blockedRunIds={blockedRunIds} selectedTimelineClip={selectedTimelineClip} timelineEditBlockedReason={timelineEditBlockedReason} timelineEditBlockedDescriptor={timelineEditBlockedDescriptor} selectedTimelineGainClip={selectedTimelineGainClip} timelineGainBlockedReason={timelineGainBlockedReason} timelineGainBlockedDescriptor={timelineGainBlockedDescriptor} contextMode={state.contextMode} onApplied={onApplied} />
        {state.message && <div className={`agent-chat-notice ${['unknown', 'load_error', 'detached'].includes(phase) ? 'is-warning' : ''}`} role="status" data-testid="agent-chat-notice">{renderMessage(state.displayMessage)}</div>}
      </div>
      <form className="agent-chat-composer" onSubmit={submit} noValidate>
        <Collapsible className="agent-chat-composer-disclosure" data-testid="agent-chat-target-disclosure" open={composerOptionsVisible} onOpenChange={open => {
          if (usable() && sendConsented && optionsInteractionRef.current === optionsInteraction) setComposerDisclosure({ projectId, key: disclosureKey, consented: true, expanded: open });
        }}>
        {sendConsented && <CollapsibleTrigger className="agent-chat-composer-summary" data-testid="agent-chat-options-toggle" disabled={!visible} render={<Button type="button" variant="ghost" />}>
          <span className="agent-chat-composer-summary-model">{t('agent.chat.destination')} · {configuration?.model || t('agent.chat.missingModel')}</span>
          <span className="agent-chat-composer-summary-scope">{t(`agent.authorization.scope.${state.contextMode}` as MessageKey)}</span>
          <span className="agent-chat-composer-summary-target" title={configuration?.baseUrl ? deriveAgentEndpoint(configuration) : undefined}>{configuration?.baseUrl ? deriveAgentEndpoint(configuration) : t('agent.chat.missingEndpoint')}</span><Icon name="down" size={12} />
        </CollapsibleTrigger>}
        <CollapsibleContent keepMounted className="agent-chat-composer-options" data-testid="agent-chat-composer-options" hidden={!composerOptionsVisible} inert={!composerOptionsVisible} aria-hidden={!composerOptionsVisible}>
        <fieldset className="agent-chat-context-mode" disabled={!composerOptionsVisible || !ready || pending} data-testid="agent-chat-context-mode">
          <legend>{t('agent.chat.sendingScope')}</legend>
          <Label htmlFor="agent-chat-mode-typed"><Input id="agent-chat-mode-typed" data-testid="agent-chat-mode-typed" type="radio" name="agent-chat-context-mode" value={AGENT_TYPED_CONTEXT} checked={state.contextMode === AGENT_TYPED_CONTEXT} disabled={!composerOptionsVisible || !ready || pending} onChange={event => { if (optionsUsable() && event.target.checked) session.current?.setContextMode(AGENT_TYPED_CONTEXT); }} /><span>{t('agent.chat.textChatOnly')}</span></Label>
          <Label htmlFor="agent-chat-mode-project"><Input id="agent-chat-mode-project" data-testid="agent-chat-mode-project" type="radio" name="agent-chat-context-mode" value={AGENT_PROJECT_CONTEXT} checked={inspecting} disabled={!inspectionAvailable || !composerOptionsVisible || !ready || pending} onChange={event => { if (optionsUsable() && event.target.checked) session.current?.setContextMode(AGENT_PROJECT_CONTEXT); }} /><span>{t('agent.chat.readOnlyProject')}</span></Label>
          <Label htmlFor="agent-chat-mode-edit"><Input id="agent-chat-mode-edit" data-testid="agent-chat-mode-edit" type="radio" name="agent-chat-context-mode" value={AGENT_EDIT_CONTEXT} checked={editing} disabled={!editAvailable || !composerOptionsVisible || !ready || pending} onChange={event => { if (optionsUsable() && event.target.checked) session.current?.setContextMode(AGENT_EDIT_CONTEXT); }} /><span>{t('agent.chat.selectedShotProposal')}</span></Label>
          <Label htmlFor="agent-chat-mode-timeline"><Input id="agent-chat-mode-timeline" data-testid="agent-chat-mode-timeline" type="radio" name="agent-chat-context-mode" value={AGENT_TIMELINE_CONTEXT} checked={moving} disabled={!timelineAvailable || !composerOptionsVisible || !ready || pending} onChange={event => { if (optionsUsable() && event.target.checked) session.current?.setContextMode(AGENT_TIMELINE_CONTEXT); }} /><span>{t('agent.chat.selectedMoveProposal')}</span></Label>
          <Label htmlFor="agent-chat-mode-gain"><Input id="agent-chat-mode-gain" data-testid="agent-chat-mode-gain" type="radio" name="agent-chat-context-mode" value={AGENT_TIMELINE_GAIN_CONTEXT} checked={gaining} disabled={!gainAvailable || !selectedTimelineGainClip || !composerOptionsVisible || !ready || pending} onChange={event => { if (optionsUsable() && event.target.checked) session.current?.setContextMode(AGENT_TIMELINE_GAIN_CONTEXT); }} /><span>{t('agent.chat.selectedGainProposal')}</span></Label>
          {!gainAvailable && <span className="agent-chat-mode-unavailable">{t('agent.chat.gainUnavailable')}</span>}
          {gainAvailable && !selectedTimelineGainClip && <span className="agent-chat-mode-unavailable">{t('agent.chat.gainRequiresAudio')}</span>}
          {!timelineAvailable && <span className="agent-chat-mode-unavailable">{t('agent.chat.moveUnavailable')}</span>}
          {!editAvailable && <span className="agent-chat-mode-unavailable">{t('agent.chat.shotUnavailable')}</span>}
          {!inspectionAvailable && <span className="agent-chat-mode-unavailable">{t('agent.chat.inspectionUnavailable')}</span>}
        </fieldset>
        {editing && <section className="agent-edit-selected" data-testid="agent-edit-selected-target" aria-label={t('agent.chat.savedShotTextScope')}>
          <strong>{t('agent.chat.useSelectedSavedShot')}</strong>
          {state.editTarget ? <><p data-testid="agent-edit-target-summary">{state.editTarget.title || t('agent.proposal.currentShot')}</p>
            <p>{t('agent.chat.savedShotScope')}</p>
            <Collapsible className="agent-edit-selected-disclosure" data-testid="agent-edit-selected-disclosure" open={disclosureOpen} onOpenChange={open => {
              if (optionsUsable() && disclosureIdentity.current === disclosureKey && (open || canCompactDisclosure)) setDisclosure({ key: disclosureKey, expanded: open, reviewed: disclosureReviewed || sendConsented });
            }}>
              <CollapsibleTrigger className="agent-chat-details-trigger" data-testid="agent-edit-selected-details-toggle" disabled={!composerOptionsVisible || !canCompactDisclosure}>{disclosureOpen ? t('agent.chat.fullTextLimits') : t('agent.chat.expandReviewedText')}</CollapsibleTrigger>
              <CollapsibleContent keepMounted className="agent-edit-selected-details" data-testid="agent-edit-selected-details">
                <p>{t('agent.chat.savedTextDisclosure')}</p>
                <Collapsible><CollapsibleTrigger className="agent-chat-details-trigger" disabled={!composerOptionsVisible}>{t('agent.chat.localIdentity')}</CollapsibleTrigger><CollapsibleContent><p data-testid="agent-edit-target-identity">{t('agent.chat.shotRevision', { shotId: creationParameter(state.editTarget.shotId), expectedRevision: creationParameter(state.editTarget.expectedRevision) })}</p></CollapsibleContent></Collapsible>
                <div className="agent-edit-selected-text"><span>{t('agent.chat.savedTitle')}</span><pre data-testid="agent-edit-selected-title">{state.editTarget.title}</pre><span>{t('agent.chat.savedDescription')}</span><pre data-testid="agent-edit-selected-prompt">{state.editTarget.prompt || t('agent.chat.emptyValue')}</pre></div>
                {editPolicy && <p data-testid="agent-edit-policy">{t('agent.chat.shotToolLimits', { schemaVersion: creationParameter(editPolicy.schemaVersion), catalogHash: creationParameter(editPolicy.catalogHash.slice(0, 12)) })}</p>}
              </CollapsibleContent>
            </Collapsible>
          </> : <p role="status">{t('agent.chat.selectSavedShot')}</p>}
        </section>}
        {moving && <section className="agent-edit-selected agent-timeline-selected" data-testid="agent-timeline-selected-target" aria-label={t('agent.chat.savedTimingScope')}>
          <strong>{t('agent.chat.moveOneSavedClip')}</strong>
          {state.timelineTarget ? <>
            <p data-testid="agent-timeline-target-summary">{t('agent.chat.clipTargetSummary', { clipName: creationParameter(state.timelineTarget.clipName), trackName: creationParameter(state.timelineTarget.trackName), value: creationParameter(state.timelineTarget.trackKind === 'audio' ? t('agent.chat.audioTrack') : t('agent.chat.videoTrack')), expectedRevision: creationParameter(state.timelineTarget.expectedRevision) })}</p>
            <p data-testid="agent-timeline-selected-time">{t('agent.chat.clipTiming', { value: creationParameter(agentTimelineFrameDisplay(state.timelineTarget.startFrame ?? 0, 30, t)), value2: creationParameter(agentTimelineFrameDisplay(state.timelineTarget.endFrame ?? 0, 30, t)), value3: creationParameter(agentTimelineFrameDisplay(state.timelineTarget.durationFrames ?? 0, 30, t)) })}</p>
            <Collapsible className="agent-edit-selected-disclosure" data-testid="agent-timeline-selected-disclosure" open={disclosureOpen} onOpenChange={open => {
              if (optionsUsable() && disclosureIdentity.current === disclosureKey && (open || canCompactDisclosure)) setDisclosure({ key: disclosureKey, expanded: open, reviewed: disclosureReviewed || sendConsented });
            }}>
              <CollapsibleTrigger className="agent-chat-details-trigger" data-testid="agent-timeline-selected-details-toggle" disabled={!composerOptionsVisible || !canCompactDisclosure}>{disclosureOpen ? t('agent.chat.fullScopeLimits') : t('agent.chat.expandReviewedScope')}</CollapsibleTrigger>
              <CollapsibleContent keepMounted className="agent-edit-selected-details" data-testid="agent-timeline-selected-details">
                <p>{t('agent.chat.moveDataDisclosure')}</p>
                <div className="agent-timeline-intervals" data-testid="agent-timeline-occupied-intervals" tabIndex={composerOptionsVisible ? 0 : -1} aria-label={t('agent.chat.sentOccupiedIntervals')}>{timelineTargetView?.occupiedIntervals.length ? <ol>{timelineTargetView.occupiedIntervals.map((interval, index) => <li key={index}>{t('agent.chat.frameInterval', { startFrame: creationParameter(interval.startFrame), endFrame: creationParameter(interval.endFrame) })}</li>)}</ol> : <p>{t('agent.chat.noOtherClips')}</p>}</div>
                <p>{t('agent.chat.moveBounds', { count: timelineTargetView?.occupiedIntervals.length ?? 0 })}</p>
                <p>{t('agent.chat.movePreservedAndConflicts')}</p>
                {timelineEditPolicy && <p data-testid="agent-timeline-policy">{t('agent.chat.proposalToolLimits', { schemaVersion: creationParameter(timelineEditPolicy.schemaVersion), catalogHash: creationParameter(timelineEditPolicy.catalogHash.slice(0, 12)) })}</p>}
                <Collapsible><CollapsibleTrigger className="agent-chat-details-trigger" disabled={!composerOptionsVisible}>{t('agent.chat.localIdentity')}</CollapsibleTrigger><CollapsibleContent><p>{t('agent.chat.projectId', { projectId: creationParameter(projectId) })}</p><p>{t('agent.chat.timelineClipTrackIds', { timelineId: creationParameter(state.timelineTarget.timelineId), clipId: creationParameter(state.timelineTarget.clipId), trackId: creationParameter(state.timelineTarget.trackId) })}</p></CollapsibleContent></Collapsible>
              </CollapsibleContent>
            </Collapsible>
          </> : <p role="status">{t('agent.chat.selectSavedClip')}</p>}
          {timelineEditBlockedReason && <p role="status" data-testid="agent-timeline-context-blocked">{timelineEditBlockedDescriptor ? renderMessage(timelineEditBlockedDescriptor) : t('agent.gain.state.checkTimelineState')}</p>}
        </section>}
        {gaining && <AgentTimelineGainSelection target={state.timelineGainTarget as unknown as AgentTimelineGainReviewTarget | null} policy={snapshot?.timelineGainEdit as AgentTimelineGainPolicy | undefined} blockedReason={timelineGainBlockedReason} blockedDescriptor={timelineGainBlockedDescriptor} visible={composerOptionsVisible} />}
        {configuration && <div className="agent-chat-destination" data-testid="agent-chat-destination"><div><span>{t('agent.chat.destination')}</span><strong>{configuration.model || t('agent.chat.missingModel')}</strong><span data-testid="agent-chat-protocol">{AGENT_PROTOCOLS[configuration.protocol].label}</span></div><p className="agent-chat-endpoint" title={configuration.baseUrl ? deriveAgentEndpoint(configuration) : undefined}>{configuration.baseUrl ? deriveAgentEndpoint(configuration) : t('agent.chat.missingEndpoint')}</p><p className="agent-chat-context" data-testid="agent-chat-context">{gaining ? renderMessage(AGENT_GAIN_SEND_CONTEXT) : moving ? t('agent.chat.moveSendDisclosure') : editing ? t('agent.chat.shotSendDisclosure') : inspecting ? t('agent.chat.inspectionSendDisclosure', { value: creationParameter(projectName || projectId) }) : t('agent.chat.chatSendDisclosure')}</p></div>}
        </CollapsibleContent>
        </Collapsible>
        <div className="agent-chat-composer-input">
        <div className="agent-chat-consent"><span role="status" data-testid="agent-chat-authorization-status">{t(sendConsented?'agent.authorization.saved':'agent.authorization.firstRequired')}</span>{!sendConsented&&<Button type="button" variant="ghost" data-testid="agent-chat-authorization-open" disabled={!authorizationReady} onClick={()=>{if(usable())setAuthorizationIntent({key:disclosureKey,checked:false,sendAfterApproval:false,message:null});}}>{t('agent.authorization.review')}</Button>}</div>
        <Label className="sr-only" htmlFor="agent-chat-prompt">{t('agent.chat.messageLabel')}</Label>
        <Textarea id="agent-chat-prompt" ref={composer} data-testid="agent-chat-prompt" value={state.draft} rows={3} maxLength={AGENT_CHAT_PROMPT_BYTES} disabled={!visible || pending || ['submitting', 'stopping'].includes(phase)} placeholder={t('agent.chat.messagePlaceholder')} aria-describedby="agent-chat-input-help" onChange={event => { if (usable()) session.current?.edit(event.target.value); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="agent-chat-composer-bottom"><div id="agent-chat-input-help"><span className={promptIssue ? 'is-warning' : ''}>{promptIssue || t('agent.chat.promptByteCount', { promptBytes: creationParameter(promptBytes), AGENT_CHAT_PROMPT_BYTES: creationParameter(AGENT_CHAT_PROMPT_BYTES) })}</span><span data-testid="agent-chat-phase" role="status">{phaseLabel(phase, t)}</span></div><div className="agent-chat-controls">
          {['unknown', 'load_error', 'detached'].includes(phase) && <Button type="button" variant="ghost" className="button" data-testid="agent-chat-reload" disabled={!visible} onClick={() => { if (usable()) void session.current?.load(); }}><Icon name="refresh" size={13} />{t('agent.chat.reload')}</Button>}
          {running && <Button type="button" variant="ghost" className="button agent-chat-stop" data-testid="agent-chat-stop" disabled={!visible || ['stopping', 'loading', 'submitting'].includes(phase)} onClick={() => { if (usable()) void session.current?.stop(); }}>{t('agent.chat.stopLaterSteps')}</Button>}
          {!running && <Button type="submit" variant="ghost" className="button primary" data-testid="agent-chat-send" disabled={!canStart}>{phase === 'submitting' ? <span className="spinner" /> : <Icon name="arrow" size={14} />}{t('agent.chat.send')}</Button>}
        </div></div>
        </div>
        <p className="agent-chat-stop-note">{t('agent.chat.stopDisclosure')}</p>
      </form>
      <Dialog open={Boolean(visible&&!sendConsented&&authorizationIntent.key===disclosureKey)} onOpenChange={open=>{if(!open&&!state.authorizing)setAuthorizationIntent({key:null,checked:false,sendAfterApproval:false,message:null});}}>
        <DialogContent className="agent-authorization-dialog" data-testid="agent-chat-authorization-dialog" showCloseButton={!state.authorizing}>
          <DialogTitle>{t('agent.authorization.title')}</DialogTitle><DialogDescription>{t('agent.authorization.explanation')}</DialogDescription>
          <dl className="agent-authorization-summary">
            <div><dt>{t('agent.authorization.scopeLabel')}</dt><dd>{t(`agent.authorization.scope.${state.contextMode}` as MessageKey)}{editing&&state.editTarget?<span>{state.editTarget.title||t('agent.proposal.currentShot')}</span>:inspecting?<span>{projectName||t('agent.chat.currentProject')}</span>:null}<Collapsible><CollapsibleTrigger className="agent-chat-details-trigger" disabled={state.authorizing}>{t('agent.authorization.scopeDetails')}</CollapsibleTrigger><CollapsibleContent><p>{gaining?renderMessage(AGENT_GAIN_SEND_CONTEXT):moving?t('agent.chat.moveSendDisclosure'):editing?t('agent.chat.shotSendDisclosure'):inspecting?t('agent.chat.inspectionSendDisclosure',{value:creationParameter(projectName||projectId)}):t('agent.chat.chatSendDisclosure')}</p></CollapsibleContent></Collapsible></dd></div>
            <div><dt>{t('agent.authorization.destinationLabel')}</dt><dd><strong>{configuration?.model}</strong><span className="agent-chat-endpoint" title={configuration?.baseUrl?deriveAgentEndpoint(configuration):undefined}>{configuration?.baseUrl?deriveAgentEndpoint(configuration):''}</span></dd></div>
            <div><dt>{t('agent.authorization.costLabel')}</dt><dd>{t('agent.authorization.cost')}</dd></div>
          </dl>
          <Label className="agent-chat-consent" htmlFor="agent-chat-consent"><Input id="agent-chat-consent" data-testid="agent-chat-consent" type="checkbox" checked={sendConsented||authorizationIntent.key===disclosureKey&&authorizationIntent.checked} disabled={!authorizationReady||sendConsented} onChange={event=>{if(usable()&&!sendConsented)setAuthorizationIntent({...authorizationIntent,key:disclosureKey,checked:event.target.checked});}}/><span>{t('agent.authorization.remember')}</span></Label>
          <DialogFooter><Button type="button" variant="ghost" disabled={state.authorizing} onClick={()=>setAuthorizationIntent({key:null,checked:false,sendAfterApproval:false,message:null})}>{t('agent.authorization.cancel')}</Button><Button type="button" data-testid="agent-chat-authorization-confirm" disabled={!authorizationReady||!authorizationIntent.checked} onClick={()=>{void confirmAuthorization();}}>{t(state.authorizing?'agent.authorization.saving':authorizationIntent.sendAfterApproval?'agent.authorization.confirmSend':'agent.authorization.confirm')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
  </section>;
}
