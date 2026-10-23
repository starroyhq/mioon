import React, { useLayoutEffect, useRef, useState } from 'react';
import { Textarea } from '@mioon/ui/components/textarea';
import { Input } from '@mioon/ui/components/input';
import { Dialog } from '@mioon/ui/components/dialog';
import { WorkbenchButton as Button, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import { WorkbenchTooltip } from '@mioon/ui/components/workbench-tooltip';
import { WorkbenchPopover, WorkbenchPopoverContent, WorkbenchPopoverTrigger } from '@mioon/ui/components/workbench-popover';
import { useI18n } from './i18n/I18nProvider.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { createAgentTaskSession, createAgentTaskReceiptStore, agentTaskPromptValid, agentTaskNewConversationBlock } from './agent-tasks-v2.ts';
import type { AgentTaskAuthorizationReview, AgentTaskSessionState } from './agent-tasks-v2.ts';
import type { AgentTaskChange, AgentTaskSnapshot, AgentTaskStep } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { createAgentTaskCloseReporter } from './native-close-sources.ts';
import type { NativeCloseSourceRegistry } from './native-close-sources.ts';
import { deriveAgentEndpoint } from './agent-settings.ts';
import LegacyHistory from './AgentLegacyHistory.tsx';
import AgentConversationHistory from './AgentConversationHistory.tsx';
import {readLegacyConversation} from './agent-conversations.ts';
import type {LegacyConversation} from './agent-conversations.ts';
import AgentRetainedEditing from './AgentRetainedEditing.tsx';
import Icon from './icons.tsx';
import { agentTaskErrorKey } from './agent-task-errors.ts';
import { taskBackgroundLocation, taskCurrentEntries, taskDisplayEntries, taskDisplayLines, taskChangeSummary, taskDisplayTargets, taskTargetTitle, taskDurationSeconds, taskRunDurationSeconds, taskOperationTitle, taskStepStatusKey, taskStepTitle } from './agent-task-presentation.ts';
import type { TaskDisplayLookup } from './agent-task-presentation.ts';
import './agent-task-v2.css';

export interface AgentTaskPanelProps { projectId: string; workspaceScope?: string; projectName?: string; timelineFps?:number; targetName?: TaskDisplayLookup; onSettings: (page?: 'agent' | 'models' | 'video-tools') => unknown; onClose: () => unknown; onOpenRequests?: (selectedId?: string) => unknown; onDraftChange?: (dirty: boolean) => unknown; onApplied?: (projectId: string, snapshot: AgentTaskSnapshot) => unknown; onLocate?: (change: AgentTaskChange) => unknown; nativeCloseRegistry?: unknown }
const finished = (status: string) => ['completed', 'failed', 'stopped', 'reverted'].includes(status);
const errorSettings = (code: string): 'agent' | 'models' | 'video-tools' | undefined => {
  if (['FFMPEG_UNAVAILABLE', 'FFMPEG_NOT_FOUND', 'FFMPEG_MISSING', 'FFPROBE_UNAVAILABLE', 'FFPROBE_NOT_FOUND', 'FFMPEG_CAPABILITY_UNAVAILABLE', 'FFMPEG_FILTER_UNAVAILABLE', 'EXPORT_CAPABILITY_TOOL_UNAVAILABLE', 'EXPORT_CAPABILITY_UNSUPPORTED', 'EXPORT_CAPABILITY_CONFIGURATION', 'EXPORT_CAPABILITY_FAILED', 'EXPORT_CAPABILITY_TIMEOUT', 'SUBTITLE_RENDERER_UNAVAILABLE'].includes(code)) return 'video-tools';
  if (['GENERATION_FAILED', 'PROVIDER_ERROR', 'PROVIDER_NOT_FOUND', 'PROVIDER_UNAVAILABLE', 'PROVIDER_GENERATION_FAILED', 'PROVIDER_NOT_READY', 'PROVIDER_POLL_TIMEOUT', 'PROVIDER_CONFIGURATION', 'PROVIDER_DISABLED', 'PROVIDER_REGION_CHANGED', 'IMAGE_SETTINGS_DISABLED', 'IMAGE_SETTINGS_NOT_CONFIGURED', 'IMAGE_CONNECTION_FAILED', 'IMAGE_NETWORK_DENIED', 'IMAGE_TIMEOUT', 'COMFY_SETTINGS_CHECK_REQUIRED', 'COMFY_SETTINGS_DISABLED', 'COMFY_SETTINGS_NOT_CONFIGURED', 'COMFY_CONNECTION_FAILED', 'COMFY_NETWORK_DENIED', 'COMFY_TIMEOUT'].includes(code)) return 'models';
  if (['AGENT_TASK_SETTINGS_CHANGED', 'AGENT_TASK_CONSENT_REQUIRED', 'AGENT_AUTHORIZATION_REQUIRED', 'AGENT_CHAT_CONNECT_FAILED', 'AGENT_CHAT_NETWORK_DENIED', 'AGENT_CHAT_TIMEOUT', 'AGENT_CHAT_HTTP_ERROR', 'AGENT_CHAT_KEY_REQUIRED', 'AGENT_CHAT_PROTOCOL_ERROR', 'AGENT_CHAT_TRUNCATED', 'AGENT_CHAT_PROFILE_UNSUPPORTED', 'AGENT_CHAT_REASONING_UNSUPPORTED', 'AGENT_CHAT_PROVIDER_ERROR'].includes(code)) return 'agent';
};
const modelText = (step: AgentTaskStep): string => step.text || (step.result && typeof step.result === 'object' && !Array.isArray(step.result) && typeof step.result.text === 'string' ? step.result.text : '');
function StepIcon({ step }: { step: AgentTaskStep }) {
  const { t } = useI18n();
  const working = step.status === 'dispatch_started' || step.status === 'intent';
  return <span className="mio-step-icon" data-tone={step.status === 'completed' ? 'success' : step.status === 'failed' ? 'danger' : ['awaiting_approval', 'unknown'].includes(step.status) ? 'warning' : 'neutral'} aria-label={t(taskStepStatusKey(step.status))}>
    {working ? <span className="wb-spinner" /> : <Icon name={step.status === 'completed' ? 'check' : step.status === 'failed' ? 'close' : step.status === 'unknown' ? 'info' : step.status === 'awaiting_approval' ? 'pause' : 'minus'} />}
  </span>;
}
export default function AgentTaskPanel({ projectId, workspaceScope = 'normal', timelineFps, targetName, onSettings, onOpenRequests, onDraftChange = () => {}, onApplied, onLocate, nativeCloseRegistry }: AgentTaskPanelProps) {
  const { t, locale } = useI18n(), visible = useWorkspaceVisibility();
  const [state, setState] = useState<AgentTaskSessionState>({ phase: 'loading', project: null, snapshot: null, draft: '', uploads: [], pending: null, error: '', conversationId:null,conversation:null,rounds:[],selectionKey:'new',legacy:false,draftDirty:false,draftVersion:0,unknownOutcome:false,history: { conversations: [], nextCursor: null, phase: 'closed' } });
  const [undoPreview,setUndoPreview]=useState<{snapshot:AgentTaskSnapshot;selectionKey:string}|null>(null),[undoLoading,setUndoLoading]=useState(false);
  const undoTrigger=useRef<HTMLButtonElement|null>(null),undoCancel=useRef<HTMLButtonElement|null>(null),undoFlight=useRef(false),undoRead=useRef(0);
  const [review, setReview] = useState<AgentTaskAuthorizationReview | null>(null), [historyOpen, setHistoryOpen] = useState(false), [stepsOpen, setStepsOpen] = useState<Record<string,boolean>>({}), [modelMenuOpen, setModelMenuOpen] = useState(false), [following, setFollowing] = useState(true),[composing,setComposing]=useState(false);
  const [legacyView,setLegacyView]=useState<LegacyConversation|null>(null),[legacyBusy,setLegacyBusy]=useState(false),[legacyError,setLegacyError]=useState(false);
  const session = useRef<ReturnType<typeof createAgentTaskSession> | null>(null), callbacks = useRef({ onDraftChange, onApplied }); callbacks.current = { onDraftChange, onApplied };
  const composition=useRef(false),historyVisible=useRef(historyOpen);historyVisible.current=historyOpen;
  const language = useRef(locale); language.current = locale;
  const visibility = useRef(visible); visibility.current = visible;
  const log = useRef<HTMLDivElement | null>(null), follow = useRef(true), historyButton = useRef<HTMLButtonElement | null>(null), input = useRef<HTMLTextAreaElement | null>(null), file = useRef<HTMLInputElement | null>(null), sendButton = useRef<HTMLButtonElement | null>(null), authorizeButton = useRef<HTMLButtonElement | null>(null), sendFlight = useRef(false);
  useLayoutEffect(() => {
    let mounted = true;
    const close = createAgentTaskCloseReporter(nativeCloseRegistry as NativeCloseSourceRegistry | undefined);
    const current = createAgentTaskSession({ projectId, getLocale: () => language.current, receipts: createAgentTaskReceiptStore(undefined, workspaceScope), onChange: next => { if (!mounted) return; close.publish(next); callbacks.current.onDraftChange(next.draftDirty && !next.pending); setState(next); }, onChangeApplied: next => callbacks.current.onApplied?.(projectId, next) });
    session.current = current; close.publish(current.getState());
    const changed = () => current.setVisible(visibility.current && document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed); void current.load();
    return () => { mounted = false; current.dispose(); close.release(); callbacks.current.onDraftChange(false); document.removeEventListener('visibilitychange', changed); if (session.current === current) session.current = null; };
  }, [projectId, workspaceScope, nativeCloseRegistry]);
  useLayoutEffect(() => { session.current?.setVisible(visible && document.visibilityState !== 'hidden'); if (!visible) { setReview(null); setUndoPreview(null); setModelMenuOpen(false); setHistoryOpen(false); } }, [visible]);
  const run = state.snapshot?.run, steps = state.snapshot?.steps ?? [], changes = state.snapshot?.changes ?? [], project = state.project;
  const readOnly = project?.readOnly === true || state.legacy, busy = state.phase === 'submitting' || state.phase === 'loading', blocked = !visible || busy || Boolean(state.pending) || readOnly || !project;
  const backgroundPending = state.snapshot?.backgroundPending === true, active = Boolean(run && !finished(run.status)), approved = project?.authorization.scopes.includes('project_agent');
  const unknown = steps.filter(step => step.status === 'unknown');
  const noteMode = Boolean(run && ['running','awaiting_approval','paused'].includes(run.status));
  const queuedNotes = run?.notes?.filter(note=>note.modelStepId===undefined).length??0;
  const stopInComposer = Boolean(run && (run.status==='accepted'||noteMode&&!state.draft.trim()));
  const model = project?.settings.configuration.model ?? '';
  const latest = steps.filter(step => step.kind === 'model' && modelText(step)).at(-1);
  const configurationKey = project ? JSON.stringify([project.settings.revision, project.settings.configuration, project.authorization.revision]) : '';
  useLayoutEffect(() => { setReview(null); }, [projectId, configurationKey, locale, state.selectionKey]);
  useLayoutEffect(()=>{undoRead.current++;undoFlight.current=false;setUndoLoading(false);setUndoPreview(null);return()=>{undoRead.current++;undoFlight.current=false;};},[projectId,workspaceScope,nativeCloseRegistry,state.selectionKey,visible]);
  useLayoutEffect(() => { follow.current = true; setFollowing(true); setLegacyError(false); composition.current=false;setComposing(false); }, [state.selectionKey]);
  useLayoutEffect(() => { if(run)setStepsOpen(value=>({...value,[run.id]:!finished(run.status)||run.status==='failed'})); }, [run?.id, run?.status]);
  useLayoutEffect(() => { if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [run?.id, run?.revision, latest && modelText(latest), changes.length, state.error]);
  useLayoutEffect(() => { if(historyOpen)void session.current?.history(); }, [historyOpen]);
  const formatOptions={fps:timelineFps,lookup:targetName};
  const newBlocked=agentTaskNewConversationBlock(state);
  const closeHistory=()=>{historyVisible.current=false;session.current?.cancelSelection();setHistoryOpen(false);historyButton.current?.focus();};
  async function selectConversation(id:string){if(!historyVisible.current||composition.current)return;const current=session.current;if(current&&await current.selectConversation(id)&&session.current===current){setLegacyView(null);closeHistory();}}
  function selectLegacy(value:LegacyConversation){if(!historyVisible.current||composition.current)return;if(value.projectId===projectId&&session.current?.selectLegacy(value.id)){setLegacyView(value);closeHistory();}}
  function newConversation(){if(composition.current||session.current?.getState().selectionKey!==state.selectionKey)return;if(session.current?.newConversation()){setLegacyView(null);closeHistory();input.current?.focus();}}
  async function olderLegacy(){const current=session.current,value=legacyView,key=state.selectionKey;if(!current||!value||legacyBusy)return;setLegacyBusy(true);setLegacyError(false);try{const next=await readLegacyConversation(projectId,value);if(visibility.current&&session.current===current&&current.getState().selectionKey===key&&next)setLegacyView(next);}catch{if(visibility.current&&session.current===current&&current.getState().selectionKey===key)setLegacyError(true);}finally{if(session.current===current)setLegacyBusy(false);}}
  const canSend = !blocked && !newBlocked && Boolean(project) && !active && agentTaskPromptValid(state.draft);
  const canNote = !blocked && noteMode && unknown.length===0 && !state.unknownOutcome && queuedNotes<5 && agentTaskPromptValid(state.draft);
  const canSubmit = noteMode?canNote:canSend;
  async function send() {
    if (!canSubmit || composition.current || sendFlight.current || !session.current || session.current.getState().selectionKey!==state.selectionKey) return;
    if(noteMode){sendFlight.current=true;try{await session.current.note();}finally{sendFlight.current=false;}return;}
    if (!approved) { setReview(session.current.authorizationReview()); return; }
    sendFlight.current = true; try { await session.current.send(); } finally { sendFlight.current = false; }
  }
  async function confirmSend() {
    const current = session.current, original = review;
    if (!current || !original || blocked || sendFlight.current) return;
    sendFlight.current = true;
    try { await current.authorizeAndSend(original); } finally { sendFlight.current = false; if (session.current === current) setReview(null); }
  }
  async function undoAll(snapshot:AgentTaskSnapshot,trigger:HTMLButtonElement) {
    const current=session.current,key=state.selectionKey;
    if(!current||blocked||undoFlight.current||!['completed','failed','stopped'].includes(snapshot.run.status))return;
    const owner=++undoRead.current;undoTrigger.current=trigger;undoFlight.current=true;setUndoLoading(true);
    try {
      const fresh=await current.refreshRound(snapshot.run.id);
      if(undoRead.current===owner&&session.current===current&&visibility.current&&current.getState().selectionKey===key&&fresh&&['completed','failed','stopped'].includes(fresh.run.status)&&!fresh.backgroundPending)setUndoPreview({snapshot:fresh,selectionKey:key});
    }finally{if(undoRead.current===owner){undoFlight.current=false;if(session.current===current)setUndoLoading(false);}}
  }
  const undoSnapshot=undoPreview?state.rounds.find(item=>item.run.id===undoPreview.snapshot.run.id):undefined;
  const undoCurrent=Boolean(undoPreview&&undoSnapshot&&undoPreview.selectionKey===state.selectionKey&&undoSnapshot.run.revision===undoPreview.snapshot.run.revision&&JSON.stringify(undoSnapshot.changes)===JSON.stringify(undoPreview.snapshot.changes));
  const undoChanges=undoPreview?.snapshot.changes??[],willUndo=undoChanges.filter(change=>change.status==='applied'&&change.reversible&&change.undoDisposition==='undo');
  const willKeep=undoChanges.filter(change=>!willUndo.includes(change)),undoModified=willKeep.filter(change=>change.status==='superseded'||change.undoDisposition==='retain'&&change.modifiedAfter===true).length;
  const undoBlocked=willKeep.some(change=>change.status==='applied'&&change.reversible&&change.undoDisposition!=='retain');
  function confirmUndo(){
    const current=session.current,preview=undoPreview;
    if(!current||!preview||blocked||!undoCurrent||!willUndo.length||current.getState().selectionKey!==preview.selectionKey)return;
    const fresh=current.getState().rounds.find(item=>item.run.id===preview.snapshot.run.id);
    if(!fresh||fresh.run.revision!==preview.snapshot.run.revision||JSON.stringify(fresh.changes)!==JSON.stringify(preview.snapshot.changes))return;
    setUndoPreview(null);void current.action('undo_all',{undoChangeIds:willUndo.map(change=>change.id)},fresh.run.id);
  }
  const approval = steps.filter(step => step.status === 'awaiting_approval' || step.approvalRequired === true);
  const focusKey = approval[0]?.id ?? unknown[0]?.id ?? (run && ['paused', 'interrupted'].includes(run.status) ? `${run.id}:${run.status}:${run.pauseReason}` : '');
  useLayoutEffect(() => { if (visible && !readOnly && focusKey && !review) log.current?.querySelector<HTMLButtonElement>('[data-mio-primary]:not(:disabled)')?.focus(); }, [projectId, focusKey, visible, readOnly, review]);
  const markedConflicts = steps.filter(step => step.display?.conflict === true);
  const conflictSteps = markedConflicts.length ? markedConflicts : [steps.filter(step => step.kind === 'tool' && ['intent', 'awaiting_approval'].includes(step.status)).at(-1)].filter((step): step is AgentTaskStep => step !== undefined);
  const parameters = (step: AgentTaskStep) => <dl className="mio-parameters">{taskDisplayEntries(step.display, locale,formatOptions).map((entry, index) => <div key={index}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl>;
  const detail = (step: AgentTaskStep) => <details className="mio-safe-details"><summary>{t('agent.panel.details')}</summary><p>{taskStepTitle(step,locale)}</p>{parameters(step)}<p>{t('agent.panel.detailsPrivacy')}</p></details>;
  function recoveryFor(snapshot:AgentTaskSnapshot){
    const run=snapshot.run,unknown=snapshot.steps.filter(step=>step.status==='unknown'),interrupted=run.status==='interrupted';
    const act=(action:Parameters<NonNullable<typeof session.current>['action']>[0],extras?:Parameters<NonNullable<typeof session.current>['action']>[1])=>session.current?.action(action,extras,run.id);
  return interrupted || unknown.length ? <>
    <p>{t('agent.panel.recoveryBody')}</p>
    {unknown.map(step => <div key={step.id} className="mio-unknown-step" data-testid={`agent-task-unknown-${step.id}`}>
      <strong>{t('agent.panel.unknownStep', { name: taskStepTitle(step, locale) })}</strong>
      {step.kind === 'model' ? <><p>{t('agent.panel.unknownModel')}</p><Button data-mio-primary disabled={blocked} onClick={() => { void act('resolve_unknown', { stepId: step.id, resolution: 'discard' }); }}>{t('agent.panel.markFailed')}</Button></> : step.toolCall?.name !== 'mioon_task_wait' && ['read_only', 'local_reversible'].includes(step.tier ?? '') ? <Button data-mio-primary disabled={blocked} onClick={() => { void act('resolve_unknown', { stepId: step.id, resolution: 'discard' }); }}>{t('agent.task.resolveLocal')}</Button> : <>
        <p>{t('agent.task.waitReconcile')}</p>{onOpenRequests && <Button data-mio-primary disabled={!visible} onClick={() => { if (visibility.current) onOpenRequests(taskBackgroundLocation(step)); }}>{t(step.toolCall?.name === 'mioon_generation_submit' || /^[a-f\d-]{36}$/iu.test(taskBackgroundLocation(step) ?? '') ? 'agent.panel.checkProvider' : 'agent.panel.checkOriginal')}</Button>}
        {step.toolCall?.name === 'mioon_task_wait' && <Button data-mio-primary disabled={blocked} onClick={() => { void act('resolve_unknown', { stepId: step.id, resolution: 'accept_result' }); }}>{t('agent.task.resolveAccept')}</Button>}
      </>}
    </div>)}
    <p>{t('agent.panel.recoveryThen')}</p><div className="mio-card-actions"><Button data-mio-primary data-testid="agent-task-resume" disabled={blocked || unknown.length > 0} onClick={() => { void act('resume'); }}>{t('agent.task.resume')}</Button><Button variant="ghost" data-testid="agent-task-stop" disabled={blocked} onClick={() => { void act('stop'); }}>{t('agent.panel.abandon')}</Button></div><p className="mio-secondary">{t('agent.panel.abandonHelp')}</p>
  </> : null;
  }
  const interrupted=run?.status==='interrupted',recovery=state.snapshot?recoveryFor(state.snapshot):null;
  function renderRound(snapshot:AgentTaskSnapshot){
    const run=snapshot.run,steps=snapshot.steps,changes=snapshot.changes,skipped=run.skippedTargets??[],notes=run.notes??[],unknown=steps.filter(step=>step.status==='unknown');
    const latest=steps.filter(step=>step.kind==='model'&&modelText(step)).at(-1),elapsed=taskRunDurationSeconds(snapshot),canUndo=['completed','failed','stopped'].includes(run.status)&&unknown.length===0&&!snapshot.backgroundPending,backgroundPending=snapshot.backgroundPending===true;
    const approval=steps.filter(step=>step.status==='awaiting_approval'||step.approvalRequired===true),marked=steps.filter(step=>step.display?.conflict===true);
    const conflictSteps=marked.length?marked:[steps.filter(step=>step.kind==='tool'&&['intent','awaiting_approval'].includes(step.status)).at(-1)].filter((step):step is AgentTaskStep=>step!==undefined);
    const act=(action:Parameters<NonNullable<typeof session.current>['action']>[0],extras?:Parameters<NonNullable<typeof session.current>['action']>[1])=>session.current?.action(action,extras,run.id);
    const beforeReply=notes.filter(note=>note.modelStepId&&steps.some(step=>step.id===note.modelStepId&&latest&&step.position<=latest.position));
    const afterReply=notes.filter(note=>!beforeReply.includes(note));
    const noteMessages=(items:typeof notes)=>items.map(note=><div key={note.requestId} className="agent-chat-message is-user mio-user mio-user-note" data-testid="agent-task-note"><span className="mio-note-label">{t('agent.panel.note')}</span><p>{note.text}</p></div>);
    return <article className="mio-round" key={run.id} data-testid="agent-task-round" data-run-id={run.id}>
        <div className="agent-task-status mio-run-status" data-testid="agent-task-status" role="status"><span className="mio-run-tag" data-status={run.status}>{['accepted', 'running'].includes(run.status) ? <span className="wb-spinner" aria-hidden="true" /> : <Icon name={run.status === 'completed' ? 'check' : run.status === 'failed' ? 'close' : run.status === 'reverted' ? 'undo' : run.status === 'stopped' ? 'stop' : run.status === 'paused' ? 'pause' : 'clock'} />}<strong>{t(`agent.task.status.${run.status}`)}</strong>{!['accepted', 'reverted'].includes(run.status) && <span> · {run.status === 'completed' ? t('agent.panel.usedSteps', { count: run.stepsUsed }) : t('agent.task.budget', { used: run.stepsUsed, limit: run.budget })}</span>}</span>
          {run.status === 'running' && <Button variant="ghost" size="compact" data-testid="agent-task-pause" disabled={blocked} onClick={() => { void act('pause'); }}>{t('agent.task.pause')}</Button>}
          {finished(run.status) && elapsed !== undefined && <span className="mio-secondary">{t('agent.panel.elapsed', { seconds: elapsed })}</span>}
        </div>
        <p className="agent-chat-message is-user mio-user">{run.text}</p>
        {noteMessages(beforeReply)}
        {latest && <p className="agent-task-text mio-reply" data-testid="agent-task-reply">{modelText(latest)}</p>}
        {noteMessages(afterReply)}
        {steps.length > 0 && <details className="mio-steps" open={stepsOpen[run.id]??(!finished(run.status)||run.status==='failed')} onToggle={event => { const open=event.currentTarget.open;if(open!==(stepsOpen[run.id]??(!finished(run.status)||run.status==='failed')))setStepsOpen(value=>({...value,[run.id]:open})); }}><summary>{t('agent.panel.steps', { count: steps.length })}</summary><div>{steps.map(step => <article key={step.id} data-step-id={step.id} className="agent-task-step mio-step">
          <div className="mio-step-line"><StepIcon step={step} /><span>{taskStepTitle(step, locale)}{['awaiting_approval', 'unknown'].includes(step.status) && <> · {t(taskStepStatusKey(step.status))}</>}</span><span className="mio-step-time">{['intent', 'dispatch_started'].includes(step.status) ? '…' : taskDurationSeconds(step.createdAt, step.updatedAt) !== undefined ? t('agent.panel.stepElapsed', { seconds: taskDurationSeconds(step.createdAt, step.updatedAt)! }) : ''}</span></div>
          {step.kind === 'model' && step !== latest && modelText(step) && <p className="agent-task-text mio-previous-reply">{modelText(step)}</p>}
          {step.cost && <p data-testid={`agent-task-cost-${step.id}`} className="mio-secondary">{t(`agent.task.cost.${step.cost}`)}</p>}
          {step.error && <div className="mio-error-card"><p role="alert" data-testid={`agent-task-step-error-${step.id}`}>{t('agent.panel.failureReason',{reason:t(agentTaskErrorKey(step.error.code))})}</p><div className="mio-failure-actions">{run.status==='failed'&&step.status==='failed'&&step===steps.at(-1)&&unknown.length===0&&!steps.some(item=>item.status==='dispatch_started')&&<Button size="compact" data-testid={`agent-task-retry-${step.id}`} disabled={blocked||backgroundPending} onClick={()=>{void act('retry',{stepId:step.id});}}><Icon name="undo" />{t('agent.panel.retry')}</Button>}{detail(step)}</div>{errorSettings(step.error.code) && <Button variant="ghost" className="mio-settings-link" data-testid={`agent-task-error-settings-${step.id}`} onClick={() => { if (visibility.current) onSettings(errorSettings(step.error!.code)); }} disabled={!visible}>{t(`agent.panel.errorSettings.${errorSettings(step.error.code)!}`)} <Icon name="arrow" /></Button>}</div>}
        </article>)}</div></details>}
        {(changes.length > 0||skipped.length>0) && <section className="mio-changes" aria-live="polite"><header><h4>{t(finished(run.status) ? 'agent.panel.roundChanges' : 'agent.panel.changes', { count: changes.length })}</h4><Button variant="ghost" size="compact" data-testid="agent-task-undo-all" disabled={blocked || undoLoading || !canUndo || !changes.length} onClick={event=>{void undoAll(snapshot,event.currentTarget);}}>{t('agent.task.undoAll')}</Button></header>{changes.map(change => <article key={change.id} className="agent-task-change mio-change" data-change-id={change.id} data-status={change.status}>
          <Button variant="ghost" className="mio-change-locate" aria-label={t('agent.task.locate')} disabled={!visible} onClick={() => { if (visibility.current) onLocate?.(change); }}><Icon name={change.targets.some(target => target.kind === 'timeline_subtitle') ? 'text' : change.display?.fields.some(field => field.property === 'gainDb') ? 'volume' : 'film'} /><span><span className="mio-change-title">{taskChangeSummary(change.display, locale,formatOptions) || taskOperationTitle(change.operation, locale)}</span><span className="mio-secondary">{change.display ? taskDisplayTargets(change.display, locale, targetName) : t('agent.display.target.unknown')}</span></span></Button>
          {change.status === 'reverted' ? <span className="mio-secondary">{t('agent.task.reverted')}</span> : change.reversible ? <Button variant="ghost" size="compact" data-testid={`agent-task-undo-${change.id}`} disabled={blocked || !canUndo || change.status !== 'applied' || change.modifiedAfter===true} onClick={() => { void act('undo_change', { changeId: change.id }); }}><Icon name="undo" />{t('agent.task.undo')}</Button> : <span className="mio-secondary">{t('agent.task.irreversible')}</span>}
          {(change.modifiedAfter===true||change.status==='superseded')&&change.status!=='reverted'&&<p className="mio-modified-after" data-testid={`agent-task-modified-${change.id}`}>{t('agent.panel.modifiedAfter')}</p>}
          <details className="mio-change-details mio-safe-details"><summary>{t('agent.panel.details')}</summary>{taskDisplayLines(change.display,locale,formatOptions).map((line,index)=><p key={index}>{line}</p>)}</details>
        </article>)}{skipped.map((entry,index)=>{
          const step=steps.find(item=>item.id===entry.stepId),display=step?.display;
          const targetIndex=display?.targets.findIndex(target=>target.kind===entry.target.kind&&target.id===entry.target.id)??-1,target=display?.targets[targetIndex];
          const projected=display&&target?{...display,targets:[target],targetCount:1,fields:display.fields.filter(field=>field.targetIndex===targetIndex).map(field=>({...field,targetIndex:0}))}:undefined;
          // The public projection reads current saved values. Missing values
          // cannot be replaced with the plan's after values or a stale snapshot.
          const current=taskCurrentEntries(projected,locale,formatOptions),labels=taskDisplayEntries(projected,locale,formatOptions).slice(0,2).map(value=>value.label).join(' · ');
          const operation=labels||taskOperationTitle(display?.operation??step?.toolCall?.name??'',locale);
          return <article key={`${entry.stepId}:${entry.target.kind}:${entry.target.id}:${index}`} className="mio-skipped" data-testid="agent-task-skipped"><Icon name="play" /><div><p>{t('agent.panel.skippedOperation',{operation})}</p><p className="mio-secondary">{taskTargetTitle(entry.target.kind,entry.target.id,locale,targetName,target?.name)}</p>{current.length>0&&<p className="mio-secondary">{t('agent.panel.retainedValue',{value:current.map(value=>`${value.label} ${value.value}`).join(' · ')})}</p>}</div></article>;
        })}</section>}
        {approval.map(step => <section key={step.id} className="agent-task-approval mio-card" data-testid={`agent-task-approval-${step.id}`}><header><Icon name={step.tier === 'paid' ? 'film' : 'info'} /><strong>{step.tier === 'paid' ? taskOperationTitle(step.display?.operation ?? step.toolCall?.name ?? '', locale) : t('agent.panel.approvalTitle')}</strong></header><p className="mio-secondary">{step.display && taskDisplayTargets(step.display, locale, targetName)}</p>{parameters(step)}{step.tier === 'paid' && step.display?.targets.length ? <dl className="mio-parameters"><div><dt>{t('agent.panel.result')}</dt><dd>{taskDisplayTargets(step.display, locale, targetName)} · {t('agent.panel.newVersion')}</dd></div></dl> : null}{step.tier === 'paid' ? <p className="mio-fee"><Icon name="info" />{t('agent.panel.fee')}</p> : <p>{step.tier ? t(`agent.task.tier.${step.tier}`) : t('agent.task.pending')}</p>}<div className="mio-card-actions"><Button data-testid={`agent-task-deny-${step.id}`} disabled={blocked} onClick={() => { void act('deny', { stepId: step.id }); }}>{t('agent.panel.reject')}</Button><Button variant="primary" data-mio-primary data-testid={`agent-task-approve-${step.id}`} disabled={blocked} onClick={() => { void act('approve', { stepId: step.id }); }}>{t(step.tier === 'paid' ? 'agent.panel.confirmGenerate' : 'agent.task.approve')}</Button></div>{step.tier === 'paid' && <Button variant="ghost" className="mio-settings-link" disabled={!visible} onClick={() => { if (visibility.current) onSettings(); }}>{t('agent.panel.paidSettings')} <Icon name="arrow" /></Button>}</section>)}
        {run.status === 'paused' && unknown.length === 0 && <section className="mio-card" data-testid="agent-task-paused">
          <strong>{t(run.pauseReason === 'budget' ? 'agent.panel.budgetTitle' : ['conflict', 'editing'].includes(run.pauseReason ?? '') ? 'agent.panel.conflictTitle' : 'agent.panel.pauseTitle')}</strong>
          {['conflict', 'editing'].includes(run.pauseReason ?? '') && conflictSteps.map(step => {
            const current = taskCurrentEntries(step.display, locale,formatOptions), planned = taskDisplayEntries(step.display, locale,formatOptions);
            return <dl key={step.id} className="mio-conflict-values" data-testid="agent-task-conflict-values">
              <div><dt>{t('agent.panel.conflictTarget')}</dt><dd>{taskDisplayTargets(step.display, locale, targetName)}</dd></div>
              {current.length > 0 && <div><dt>{t('agent.panel.yourChanges')}</dt><dd>{current.map((entry, index) => <p key={index}>{entry.label} {entry.value}</p>)}</dd></div>}
              {planned.length > 0 && <div><dt>{t('agent.panel.originalPlan')}</dt><dd>{planned.map((entry, index) => <p key={index}>{entry.label} {entry.value}</p>)}</dd></div>}
            </dl>;
          })}
          <p>{run.pauseReason === 'budget' ? t('agent.panel.budgetBody', { count: run.stepsUsed }) : t(['conflict', 'editing'].includes(run.pauseReason ?? '') ? 'agent.panel.conflictBody' : run.pauseReason === 'user' ? 'agent.panel.pauseBody' : agentTaskErrorKey(run.pauseReason))}</p>
          <div className="mio-card-actions"><Button data-mio-primary data-testid="agent-task-resume" disabled={blocked || unknown.length > 0} onClick={() => { void act(['conflict','editing'].includes(run.pauseReason??'')?'skip':'resume'); }}>{['conflict','editing'].includes(run.pauseReason??'')?t('agent.panel.skipContinue'):run.pauseReason === 'budget' ? t('agent.task.nextRound', { count: run.stepLimit }) : t('agent.task.resume')}</Button><Button data-testid="agent-task-stop" disabled={blocked} onClick={() => { void act('stop'); }}>{t('agent.task.stop')}</Button></div>
        </section>}
        {run.status === 'failed' && <p className="mio-error" role="alert" data-testid="agent-task-run-error">{t('agent.panel.failedTail')}</p>}
        {backgroundPending && <section className="mio-card" data-testid="agent-task-background-pending"><p>{t('agent.task.backgroundPending')}</p>{onOpenRequests && steps.filter(step => step.kind !== 'model' && taskBackgroundLocation(step) !== undefined).map(step => <Button key={step.id} variant="ghost" disabled={!visible} data-testid={`agent-task-background-request-${step.id}`} onClick={() => { if (visibility.current) onOpenRequests(taskBackgroundLocation(step)); }}>{taskStepTitle(step, locale)} · {t('agent.panel.checkOriginal')}</Button>)}{run.status === 'completed' && <div className="mio-card-actions"><Button data-testid="agent-task-pause" disabled={blocked} onClick={() => { void act('pause'); }}>{t('agent.task.pause')}</Button><Button data-testid="agent-task-stop" disabled={blocked} onClick={() => { void act('stop'); }}>{t('agent.task.stop')}</Button></div>}</section>}
      {snapshot!==state.snapshot&&(run.status==='interrupted'||unknown.length>0)&&<section className="mio-card">{recoveryFor(snapshot)}</section>}</article>;
  }
  return <section className="agent-panel agent-task-panel mio-panel" data-testid="agent-task-panel" data-phase={state.phase} aria-label={t('agent.task.title')}>
    <header className="agent-task-heading mio-heading"><h3 title={state.legacy?legacyView?.title:state.conversation?.title}>{(state.legacy?legacyView?.title:state.conversation?.title) || t('agent.panel.newConversation')}</h3><div>
      <WorkbenchTooltip content={composing?t('agent.conversation.blocked.composing'):newBlocked?t(`agent.conversation.blocked.${newBlocked}`):t('agent.panel.newConversation')}><Button variant="icon" aria-label={t('agent.panel.newConversation')} data-testid="agent-task-new-conversation" disabled={!visible||composing||Boolean(newBlocked)} aria-describedby={newBlocked||composing?'mio-new-conversation-blocked':undefined} onClick={newConversation}><Icon name="plus" /></Button></WorkbenchTooltip>
      <WorkbenchTooltip content={t('agent.panel.history')}><Button variant="icon" aria-label={t('agent.panel.history')} ref={historyButton} data-testid="agent-task-history-open" aria-expanded={historyOpen} disabled={!visible || busy} onClick={() => { if (visibility.current) setHistoryOpen(value => !value); }}><Icon name="clock" /></Button></WorkbenchTooltip>
      <WorkbenchTooltip content={t('agent.task.settings')}><Button variant="icon" aria-label={t('agent.task.settings')} data-testid="agent-task-settings" disabled={!visible} onClick={() => { if (visibility.current) onSettings(); }}><Icon name="settings" /></Button></WorkbenchTooltip>
    </div></header>
    {(newBlocked||composing)&&<span id="mio-new-conversation-blocked" className="sr-only">{t(composing?'agent.conversation.blocked.composing':`agent.conversation.blocked.${newBlocked!}`)}</span>}
    <div className="mio-message-area">
    <div hidden={historyOpen} inert={historyOpen} aria-hidden={historyOpen||undefined} ref={log} className="agent-task-activity mio-log" role="log" aria-label={t('agent.task.title')} aria-live="polite" aria-relevant="additions text" data-testid="agent-task-activity" onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.clientHeight - node.scrollTop < 24; setFollowing(follow.current); }}>
      {(state.error || state.phase === 'detached') && <p role="alert" className="mio-error" data-testid="agent-task-error">{t(agentTaskErrorKey(state.error))}</p>}
      {state.pending ? <div className="mio-card" data-testid="agent-task-unknown"><p>{t('agent.task.unknown')}</p><Button disabled={!visible || busy} onClick={() => { void session.current?.reconcile(); }}>{t('agent.task.confirmRead')}</Button></div> : ['error', 'read_error', 'detached'].includes(state.phase) && <Button data-testid="agent-task-reload" disabled={!visible || busy} onClick={() => { void session.current?.load(); }}>{t('agent.task.reload')}</Button>}
      {project?.readOnly && <p className="mio-secondary" data-testid="agent-task-read-only">{t('agent.task.readOnly')}</p>}
      {!run && !state.pending && !state.legacy && <div className="mio-empty" data-testid="agent-task-empty"><p>{t('agent.task.empty')}</p><p className="mio-secondary">{t('agent.panel.try')}</p><div className="mio-suggestions">{(['description', 'gaps', 'subtitles', 'export'] as const).map((suggestion, index) => <Button key={suggestion} variant="secondary" disabled={blocked} onClick={() => { session.current?.edit(t(`agent.panel.suggest.${suggestion}`),state.selectionKey); input.current?.focus(); }}><Icon name={['image', 'zoom', 'text', 'check'][index]} />{t(`agent.panel.suggest.${suggestion}`)}</Button>)}</div></div>}
      {(state.rounds.length?state.rounds:state.snapshot?[state.snapshot]:[]).map(renderRound)}
      {/* Project recovery owns its pending-receipt close fence across conversation selection. */}
      <div data-testid="agent-task-retained-owner" hidden={state.legacy} inert={state.legacy}>{!project?.readOnly && <AgentRetainedEditing nativeCloseRegistry={nativeCloseRegistry} projectId={projectId} visible={visible&&!state.legacy} readOnly={false} recovery={state.legacy?null:recovery} targetName={targetName} />}</div>{project?.readOnly && recovery && <section className="mio-card"><strong>{t('agent.panel.recoveryTitle')}</strong>{recovery}</section>}
      {state.legacy&&legacyView&&<><LegacyHistory conversation={legacyView} busy={legacyBusy} onMore={()=>{void olderLegacy();}} />{legacyError&&<p className="mio-error" role="alert">{t('agent.conversation.loadError')}</p>}</>}
    </div>
    <AgentConversationHistory open={historyOpen&&visible} projectId={projectId} conversations={state.history.conversations} phase={state.history.phase} nextCursor={state.history.nextCursor} currentId={state.conversationId} currentLegacyId={state.legacy?legacyView?.id:undefined} newConversation={!state.conversationId&&!state.legacy} disabled={!visible||busy||composing||Boolean(state.pending)} selectionError={state.phase==='read_error'} onClose={closeHistory} onSelect={id=>{void selectConversation(id);}} onSelectLegacy={selectLegacy} onMore={()=>{void session.current?.history(state.history.phase!=='error'&&Boolean(state.history.nextCursor));}} />
    </div>
    {!historyOpen && !following && <Button variant="ghost" className="mio-latest" data-testid="agent-task-latest" onClick={() => { if (log.current) { follow.current = true; setFollowing(true); log.current.scrollTop = log.current.scrollHeight; } }}>{t('agent.panel.latest')} <Icon name="down" /></Button>}
    <form className="agent-task-composer mio-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      {state.uploads.length > 0 && <div className="agent-task-uploads mio-attachments">{state.uploads.map(upload => <span key={upload.id} data-testid="agent-task-uploaded"><span title={upload.name}>{upload.name}</span><Button variant="icon" aria-label={t('agent.task.removeAttachment')} disabled={blocked} onClick={() => session.current?.removeUpload(upload.id,state.selectionKey)}><Icon name="close" /></Button></span>)}</div>}
      <Textarea key={state.selectionKey} ref={input} data-testid="agent-task-draft" aria-label={t('agent.task.draft')} placeholder={state.legacy?t('agent.conversation.legacyDraft'):unknown.length || interrupted || state.unknownOutcome ? t('agent.panel.blockedDraft') : noteMode?t(run?.status==='paused'?'agent.panel.pausedNoteDraft':'agent.panel.noteDraft'):run && finished(run.status) ? t('agent.panel.continuedraft') : t('agent.task.draft')} maxLength={32000} value={state.draft} disabled={!visible || state.phase === 'loading' || readOnly || unknown.length > 0 || interrupted || state.unknownOutcome} onChange={event => session.current?.edit(event.target.value,state.selectionKey)} onCompositionStart={()=>{composition.current=true;setComposing(true);}} onCompositionEnd={()=>{composition.current=false;setComposing(false);}} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } }} />
      {noteMode&&state.uploads.length>0&&<p className="mio-secondary">{t('agent.panel.attachNextRound')}</p>}
      {noteMode&&queuedNotes>=5&&<p className="mio-secondary" role="status" data-testid="agent-task-note-limit">{t('agent.task.error.noteLimit')}</p>}
      <div className="mio-composer-tools">{!readOnly && <Input key={state.selectionKey} ref={file} className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="agent-task-upload" type="file" disabled={blocked||noteMode} accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/mp4,.cube" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; if (selected) void session.current?.upload(selected,state.selectionKey); }} />}
        {!readOnly && <WorkbenchTooltip content={t('agent.task.attach')}><Button variant="icon" data-testid="agent-task-attach" aria-label={t('agent.task.attach')} disabled={blocked||noteMode} onClick={() => file.current?.click()}><Icon name="link" /></Button></WorkbenchTooltip>}
        <WorkbenchPopover open={modelMenuOpen && visible} onOpenChange={open => setModelMenuOpen(open)}><WorkbenchPopoverTrigger render={<Button variant="ghost" className="mio-model-trigger" aria-label={t('agent.panel.modelMenu')} disabled={!visible} />}><span>{model || t('agent.panel.noConnection')} · {t('agent.authorization.scope.project_agent')}</span><Icon name="down" /></WorkbenchPopoverTrigger><WorkbenchPopoverContent className="mio-model-menu"><p>{model}</p>{project && <p className="mio-secondary">{deriveAgentEndpoint(project.settings.configuration)}</p>}<Button variant="ghost" onClick={() => { if (visibility.current) onSettings(); }}>{t('agent.panel.changeModel')}</Button></WorkbenchPopoverContent></WorkbenchPopover>
        <WorkbenchTooltip content={t(stopInComposer ? 'agent.task.stop' : noteMode&&queuedNotes>=5?'agent.task.error.noteLimit':noteMode?'agent.panel.sendNote':'agent.task.send')}><Button variant="primary" className="mio-send" ref={sendButton} type={stopInComposer ? 'button' : 'submit'} aria-label={t(stopInComposer ? 'agent.task.stop' : noteMode?'agent.panel.sendNote':'agent.task.send')} data-testid={stopInComposer ? 'agent-task-stop' : 'agent-task-send'} disabled={stopInComposer ? blocked : !canSubmit} onClick={stopInComposer ? () => { void session.current?.action('stop',{},run?.id); } : undefined}><Icon name={stopInComposer ? 'stop' : 'upload'} /></Button></WorkbenchTooltip>
      </div>
    </form>
    <Dialog open={Boolean(undoPreview)&&visible} onOpenChange={open=>{if(!open)setUndoPreview(null);}}><WorkbenchDialogContent size="confirm" showCloseButton={false} title={t('agent.panel.undoTitle',{count:willUndo.length})} description={undoModified?t('agent.panel.undoRetained',{count:undoModified}):undefined} className="mio-undo-dialog" initialFocus={undoCancel} finalFocus={undoTrigger} data-testid="agent-task-undo-dialog" footer={<><Button ref={undoCancel} data-testid="agent-task-undo-cancel" onClick={()=>setUndoPreview(null)}>{t('common.cancel')}</Button><Button variant="primary" data-testid="agent-task-undo-confirm" disabled={blocked||!undoCurrent||willUndo.length===0} onClick={confirmUndo}><Icon name="undo" />{t('agent.panel.undoCount',{count:willUndo.length})}</Button></>}>
      {([{changes:willUndo,label:'agent.panel.undoWillUndo',testId:'agent-task-undo-list'},{changes:willKeep,label:'agent.panel.undoWillKeep',testId:'agent-task-keep-list'}] as const).filter(group=>group.changes.length).map(group=><section key={group.testId} data-testid={group.testId}><h4>{t(group.label)}</h4><ul>{group.changes.map(change=><li key={change.id}><p>{taskChangeSummary(change.display,locale,formatOptions)||taskOperationTitle(change.operation,locale)}</p><p className="mio-secondary">{change.display?taskDisplayTargets(change.display,locale,targetName):t('agent.display.target.unknown')}</p>{group.changes===willKeep&&<p className="mio-secondary">{t(change.status==='reverted'?'agent.task.reverted':change.status==='superseded'||change.undoDisposition==='retain'&&change.modifiedAfter?'agent.panel.modifiedAfterKept':!change.reversible?'agent.task.irreversible':'agent.panel.undoUnavailable')}</p>}</li>)}</ul></section>)}
      {undoBlocked&&<p className="mio-secondary">{t('agent.panel.undoBlocked')}</p>}{willUndo.length===0&&<p role="status" data-testid="agent-task-undo-empty">{t('agent.panel.undoNone')}</p>}{!undoCurrent&&<p role="status">{t('agent.task.error.changed')}</p>}
    </WorkbenchDialogContent></Dialog>
    <Dialog open={Boolean(review) && visible} onOpenChange={open => { if (!open && !sendFlight.current) setReview(null); }}><WorkbenchDialogContent title={t('agent.panel.authorizationTitle', { model: review?.model ?? '' })} description={t('agent.panel.authorizationIntro')} className="mio-authorization" initialFocus={authorizeButton} finalFocus={sendButton} data-testid="agent-task-authorization-dialog" footer={<><p className="mio-secondary">{t('agent.panel.authorizationRevoke')}</p><Button disabled={busy} onClick={() => { setReview(null); input.current?.focus(); }}>{t('common.cancel')}</Button><Button variant="primary" ref={authorizeButton} data-testid="agent-task-authorize" disabled={blocked} onClick={() => { void confirmSend(); }}>{t('agent.panel.confirmSend')}</Button></>}>
      <section><h4>{t('agent.panel.authorizationScope')}</h4><p>{t('agent.panel.authorizationContent')}</p><p className="mio-secondary">{t('agent.panel.authorizationExcluded')}</p></section><section><h4>{t('agent.panel.authorizationDestination')}</h4><p className="mio-endpoint">{review?.destination}</p><p>{t('agent.panel.model')} · {review?.model}</p></section><section><h4>{t('agent.panel.authorizationFeeTitle')}</h4><p>{t('agent.panel.authorizationFee')}</p></section>
    </WorkbenchDialogContent></Dialog>
  </section>;
}
