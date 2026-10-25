import type {TaskDispositionView} from './task-disposition-client.ts';
import type {TaskDisposition} from '../../../packages/contracts/src/task-dispositions.ts';
import TaskRenderList from './TaskRenderList.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import { statusDescriptor, jobStatusDescriptor, outputReviewDescriptor, workspaceHeldDescriptor, taskErrorDescriptor, safeTaskErrorCode } from './creation-i18n.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter } from './creation-i18n.ts';
import { workspaceIntentDisposition } from './workspace-origin.ts';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DURABLE_EDIT_OPERATIONS } from '@mioon/contracts';
import { Badge } from '@mioon/ui/components/badge';
import TaskWorkspace, { useTaskWorkspaceInteraction } from './TaskWorkspace.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import './TaskWorkspace.css';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import Icon from './icons.tsx';
import SubjectVideoSummary from './SubjectVideoSummary.tsx';
import { isSubjectRetryPending } from './submissions.ts';
import PendingSubmission from './PendingSubmission.tsx';
import RecoveryStorageDetails from './RecoveryStorageDetails.tsx';
import { isMutationOperation } from './mutation-submissions.ts';
import { isDurableEditOperation } from './edit-task-client.ts';
import { activeJob, outputReviewRequired } from './api.ts';
import type { DisplayMessage, MessageArguments, MessageKey } from '../../../packages/i18n/src/index.ts';

type Translator = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
const pass = <T,>(value: unknown): T => value as T;
export interface DurableTaskView { id: string; status: string; operation: string; createdAt: string; requestId: string; origin?: string; [key: string]: unknown }
export interface TaskCenterExportData { exports?: readonly unknown[]; project?: { id?: string } | null; restore?: { heldExportIds?: readonly string[] } | null; jobs?: readonly unknown[]; shots?: readonly { id: string; title?: string }[]; [key: string]: unknown }
export interface TaskCenterTaskList { phase: string; items: DurableTaskView[]; error?: { displayMessage?: DisplayMessage } | null; heldIds?: readonly string[]; uncertain: readonly string[]; busy: readonly string[] }
export interface TaskCenterPendingEntry { key: string; operation: string; expectedWorkspaceOrigin?: string | null; input: { requestId?: string; [key: string]: unknown }; [key: string]: unknown }
export interface TaskCenterJobSnapshot { duration?: unknown; aspectRatio?: unknown; subjectReference?: unknown; [key: string]: unknown }
export interface TaskCenterJob { id: string; status: string; shotId?: string; providerId?: string; progress?: number | null; createdAt?: string; error?: unknown; providerJobId?: string | null; snapshot?: TaskCenterJobSnapshot | null; submissionCount?: number; retryOfJobId?: string; lane?: string; [key: string]: unknown }
export interface TaskCenterProps {
  workspace?: { restored?: unknown; [key: string]: unknown } | null;
  activeCount: number;
  pending: readonly TaskCenterPendingEntry[];
  busy: Record<string, boolean | undefined>;
  jobs: readonly TaskCenterJob[];
  data: TaskCenterExportData;
  reconcileIds: Record<string, string | undefined>;
  setReconcileIds: (updater: (ids: Record<string, string | undefined>) => Record<string, string | undefined>) => unknown;
  run: (key: string, operation: string, input: Record<string, unknown>, message: unknown, options?: unknown) => unknown;
  retryGeneration: (job: TaskCenterJob, stillCurrent: () => boolean) => unknown;
  onInspectJob: (job: TaskCenterJob, stillCurrent: () => boolean) => unknown;
  context: () => { projectId?: string | null } | null | undefined;
  confirm: (options: unknown) => Promise<boolean>;
  isCurrent: (captured?: unknown) => boolean;
  captureView: () => unknown;
  taskViewScope: string;
  tasks: TaskCenterTaskList;
  onRecover: (task: DurableTaskView, acknowledge: boolean, stillCurrent: unknown) => unknown;
  onReload: () => unknown;
  onAdopt: (entry: TaskCenterPendingEntry) => unknown;
  onOpenExportHistory?: () => unknown;
  selectedTaskId?: string;
  dispositions?: TaskDispositionView;
  /** Shot detection tasks, prepared by App with their detail cards. */
  scenes?: readonly { key: string; label: string; status: string; active: boolean; warning: boolean; detail: React.ReactNode }[];
}
export interface DurableTaskProps { task: DurableTaskView; uncertain: boolean; busy: boolean; held?: boolean; onRecover: () => unknown; onAcknowledge: () => unknown; dispositionAction?: React.ReactNode }

const subtitleLabels = (t: Translator): Record<string, string> => ({ 'timeline.subtitle.add': t('tasks.center.addSubtitle'), 'timeline.subtitle.update': t('tasks.center.updateSubtitle'), 'timeline.subtitle.remove': t('tasks.center.removeSubtitle') });

function DurableTask({ task, uncertain, busy, held = false, onRecover, onAcknowledge, dispositionAction }: DurableTaskProps): React.ReactElement {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const status = !held && uncertain && !['applied', 'not_applied'].includes(task.status) ? 'unknown' : task.status;
  const label = ({ prepared: t('tasks.center.prepared'), dispatching: t('tasks.center.checkingOutcome'), unknown: t('tasks.center.outcomePending'), applied: t('tasks.center.appliedAwaitingClose'), not_applied: t('tasks.center.confirmedNotApplied') } as Record<string, string>)[status];
  return <div className={`job-card ${status}`} data-testid={`durable-task-${task.id}`} data-task-state={status}>
    <div className="job-title"><Icon name="info" size={17} /><strong>{label}</strong></div>
    <div className="job-snapshot"><span>{task.operation === 'timeline.format.set' ? t('tasks.center.timelineFormatOperation') : subtitleLabels(t)[task.operation] ? `${subtitleLabels(t)[task.operation]} · ${task.operation}` : task.operation}</span><span>{formatDate(task.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
    {held && <p className="restored-held-label" data-testid="restored-task-held">{t('tasks.center.historicalHeld')}</p>}
    <p className="helper muted task-request-id">{t('tasks.center.requestIdentity', { requestId: creationParameter(task.requestId) })}</p>
    <details className="task-card-details"><summary>{t('shell.details')}</summary>
      {task.origin === 'legacy_session' && <p className="helper muted">{t('tasks.center.legacyAdopted')}</p>}
      <p className="helper muted">{held ? renderMessage(workspaceHeldDescriptor) : t('tasks.center.recoveryScope')}</p></details>
    <div className="job-actions">{['applied', 'not_applied'].includes(task.status)
      ? <Button variant="ghost" className="button small" data-testid="acknowledge-task" disabled={busy || held} title={held ? renderMessage(workspaceHeldDescriptor) : undefined} onClick={onAcknowledge}>{t('tasks.center.acknowledgeClose')}</Button>
      : <Button variant="ghost" className="button small" data-testid="recover-durable-task" disabled={busy || held} title={held ? renderMessage(workspaceHeldDescriptor) : undefined} onClick={onRecover}><Icon name="refresh" size={13} />{task.status === 'dispatching' ? t('tasks.center.checkSameRequest') : t('tasks.center.recoverSameRequest')}</Button>}{dispositionAction}</div>
  </div>;
}

interface RenderTaskRow { id: string; projectId: string; mode: string; purpose: string; status: string; snapshot?: { deliveryName?: string } }
type TaskFilter = 'all' | 'active' | 'uncertain' | 'finished';
interface TaskListEntry { key: string; label: string; status: string; warning: boolean; group: string; phase: Exclude<TaskFilter, 'all'>; search?: string }
function renderTaskRow(value: unknown, projectId: string): value is RenderTaskRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<RenderTaskRow>;
  return typeof row.id === 'string' && row.projectId === projectId && row.mode === 'timeline' && ['preview', 'export'].includes(row.purpose ?? '') && typeof row.status === 'string';
}

export default function TaskCenter({ workspace, activeCount, pending, busy, jobs, data, reconcileIds, setReconcileIds, run, retryGeneration, onInspectJob, context, confirm, isCurrent, captureView, taskViewScope, tasks, onRecover, onReload, onAdopt, onOpenExportHistory, selectedTaskId, dispositions, scenes = [] }: TaskCenterProps): React.ReactElement {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const restored = workspace?.restored === true;
  const visible = Boolean(useWorkspaceVisibility());
  const interaction = useTaskWorkspaceInteraction(pass(captureView), taskViewScope, visible);
  const renderTasks = (data.exports || []).filter((item): item is RenderTaskRow => renderTaskRow(item, data.project?.id || ''));
  const localStatus = (task: DurableTaskView) => {
    const status = !tasks.heldIds?.includes(task.id) && tasks.uncertain.includes(task.id) && !['applied', 'not_applied'].includes(task.status) ? 'unknown' : task.status;
    return ({ prepared: t('tasks.center.prepared'), dispatching: t('tasks.center.checkingOutcome'), unknown: t('tasks.center.outcomePending'), applied: t('tasks.center.appliedAwaitingClose'), not_applied: t('tasks.center.confirmedNotApplied') } as Record<string, string>)[status] || status;
  };
  const dispositionKey=(item:TaskDisposition)=>item.kind==='generation'?item.taskId:`${item.kind==='render'?'render':'local'}:${item.taskId}`;
  const dispositionFor=(key:string)=>dispositions?.items.find(item=>dispositionKey(item)===key);
  const entries: TaskListEntry[] = [
    ...renderTasks.map<TaskListEntry>(item => ({ key: `render:${item.id}`, label: typeof item.snapshot?.deliveryName === 'string' ? item.snapshot.deliveryName : t(item.purpose === 'export' ? 'redesign.export.step4' : 'shell.preview'), status: renderMessage(statusDescriptor(item.status)), warning: false, group: t('redesign.tasks.rendering'), phase: ['queued', 'running'].includes(item.status) ? restored || data.restore?.heldExportIds?.includes(item.id) ? 'uncertain' : 'active' : 'finished' })),
    ...tasks.items.map<TaskListEntry>(task => ({ key: `local:${task.id}`, label: subtitleLabels(t)[task.operation] || (task.operation === 'timeline.format.set' ? t('tasks.center.timelineFormatOperation') : task.operation), status: localStatus(task), warning: ['unknown', 'dispatching'].includes(task.status) || tasks.uncertain.includes(task.id), group: t('tasks.center.localEditRequests'), phase: ['applied', 'not_applied'].includes(task.status) ? 'finished' : 'uncertain', search: task.requestId })),
    ...pending.map<TaskListEntry>(entry => ({ key: `pending:${entry.expectedWorkspaceOrigin || 'legacy'}:${entry.key}`, label: entry.operation, status: t('tasks.pending.outcomeUnconfirmed'), warning: true, group: t('tasks.center.sessionPending'), phase: 'uncertain', search: entry.input.requestId })),
    ...scenes.map<TaskListEntry>(item => ({ key: item.key, label: item.label, status: item.status, warning: item.warning, group: t('scene.task.group'), phase: item.active ? 'active' : 'finished' })),
    ...jobs.map<TaskListEntry>(job => ({ key: job.id, label: (data.shots ?? []).find(shot => shot.id === job.shotId)?.title || t('tasks.center.shotTask'), status: renderMessage(jobStatusDescriptor(job)), warning: job.status === 'submission_unknown', group: t('tasks.center.generationTasks'), phase: job.status === 'submission_unknown' || restored && activeJob(job) ? 'uncertain' : activeJob(job) ? 'active' : 'finished', search: typeof job.requestId === 'string' ? job.requestId : undefined })),
  ].filter(item=>{const saved=dispositionFor(item.key);return !saved?.archived||!saved.canArchive;}).map(item=>dispositionFor(item.key)?.markedFailed&&dispositionFor(item.key)?.canMarkFailed?{...item,status:t('redesign.tasks.markedFailed'),warning:true}:item);
  // A selection belongs to the current pane lifetime, including an explicit overview target.
  const selectionContext = useMemo(() => ({ scope: taskViewScope, visible, requested: selectedTaskId }), [taskViewScope, visible, selectedTaskId]);
  const [listView, setListView] = useState<{ context: typeof selectionContext; search: string; filter: TaskFilter } | null>(null);
  const search = listView?.context === selectionContext ? listView.search : '';
  const filter = listView?.context === selectionContext ? listView.filter : 'all';
  const query = search.trim().toLocaleLowerCase();
  const matchingEntries = entries.filter(item => (filter === 'all' || item.phase === filter) && (!query || [item.key, item.label, item.status, item.group, item.search].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)));
  const listOwner = useMemo(() => ({ context: selectionContext, search, filter }), [selectionContext, search, filter]);
  const liveList = useRef<typeof listOwner | null>(null);
  useLayoutEffect(() => { liveList.current = listOwner; return () => { liveList.current = null; }; }, [listOwner]);
  const [selection, setSelection] = useState<{ context: typeof selectionContext; key: string } | null>(null);
  const selectedKey = selection?.context === selectionContext && matchingEntries.some(item => item.key === selection.key) ? selection.key
    : selectedTaskId && matchingEntries.some(item => item.key === selectedTaskId) ? selectedTaskId
    : (query || filter !== 'all' ? matchingEntries[0]?.key : matchingEntries.find(item => item.warning)?.key || matchingEntries[0]?.key) || '';
  const selectionOwner = useMemo(() => ({ context: selectionContext, list: listOwner, key: selectedKey }), [selectionContext, listOwner, selectedKey]);
  const liveSelection = useRef<typeof selectionOwner | null>(null);
  useLayoutEffect(() => { liveSelection.current = selectionOwner; return () => { liveSelection.current = null; }; }, [selectionOwner]);
  const canFilter = () => liveList.current === listOwner && Boolean(interaction.capture());
  const updateList = (nextSearch: string, nextFilter: TaskFilter) => {
    if (!canFilter() || nextSearch === search && nextFilter === filter) return;
    liveList.current = null; liveSelection.current = null;
    setListView({ context: selectionContext, search: nextSearch, filter: nextFilter });
  };
  const captureTask = (key: string) => {
    if (selectedKey !== key || liveSelection.current !== selectionOwner) return null;
    const current = interaction.capture();
    return current ? () => liveSelection.current === selectionOwner && current() : null;
  };
  const [clipboard,setClipboard]=useState<{owner:typeof selectionOwner;state:'copied'|'failed'}|null>(null);
  const selectedEntry=matchingEntries.find(item=>item.key===selectedKey);
  const selectedDisposition=dispositionFor(selectedKey);
  const pendingSelection=selectedKey.startsWith('pending:');
  const selectedId=selectedDisposition?.taskId??(pendingSelection?selectedEntry?.search:selectedKey.replace(/^(render|local):/,''));
  const completed=dispositions?.items.filter(item=>item.canArchive&&!item.archived).slice(0,100)??[];
  const detail = (key: string, content: React.ReactNode) => <div key={key} className="task-center-detail-pane" data-task-detail-key={key} hidden={key !== selectedKey} inert={key !== selectedKey} aria-hidden={key !== selectedKey}>{content}</div>;
  const dispositionAction = (key: string) => {
    const disposition = dispositionFor(key);
    if (key !== selectedKey || !disposition?.canMarkFailed || disposition.markedFailed) return null;
    return <Button type="button" variant="outline" className="button small task-mark-failed" data-testid="task-mark-failed" disabled={restored || dispositions?.phase !== 'ready' || dispositions.busy || dispositions.mutationUncertain} onClick={async () => {
      const stillCurrent = captureTask(key);
      if (!stillCurrent) return;
      const captured = context();
      if (await confirm(message('redesign.tasks.markFailedConfirmation')) && stillCurrent() && isCurrent(captured)) void dispositions?.markFailed(disposition);
    }}>{t('redesign.tasks.markFailed')}</Button>;
  };
  return <TaskWorkspace activeCount={activeCount}><div className="task-center-browser" data-testid="task-center-browser">
    <div className="task-center-list-tools">
        <Input type="search" value={search} data-testid="task-center-search" aria-label={t('redesign.tasks.search')} placeholder={t('redesign.tasks.search')} onChange={event => updateList(event.target.value, filter)} />
        <div className="task-center-filters" role="group" aria-label={t('redesign.tasks.filter')}>{(['all', 'active', 'uncertain', 'finished'] as const).map(value => <Button type="button" variant="ghost" className="task-center-filter" key={value} data-task-filter={value} data-testid={`task-filter-${value}`} aria-pressed={filter === value} onClick={() => updateList(search, value)}>{t(`redesign.tasks.${value}`)}</Button>)}</div>
        <Button type="button" variant="ghost" data-testid="task-archive-completed" disabled={restored||dispositions?.phase!=='ready'||dispositions.busy||dispositions.mutationUncertain||!completed.length} onClick={()=>{if(canFilter())void dispositions?.archiveCompleted(completed);}}>{t('redesign.tasks.archiveCompleted')}</Button>
      </div>
    <aside className="task-center-sidebar" aria-label={t('tasks.workspace.recordsAria')}>
      <p className="task-filter-scope">{t('redesign.tasks.localFilter')}</p>
      <div className="task-center-list" data-testid="task-center-list">{matchingEntries.map(item => <Button type="button" variant="ghost" key={item.key} className="task-center-row" data-testid={`task-select-${item.key}`} data-warning={item.warning} aria-pressed={item.key === selectedKey} onClick={() => {
        if (!canFilter()) return;
        if (item.key !== selectedKey) liveSelection.current = null;
        setSelection({ context: selectionContext, key: item.key });
      }}><span className="task-center-row-icon"><Icon name={item.warning ? 'info' : 'clock'} size={16} /></span><span className="task-center-row-copy"><strong>{item.label}</strong><small>{item.group}</small><span>{item.status}</span></span><Icon name="arrow" size={12} /></Button>)}</div>
      <section className="task-center-local" data-testid="task-center-local" data-empty={tasks.phase === 'ready' && !tasks.items.length}>
        {tasks.phase === 'ready' && !tasks.items.length && <p className="helper muted" data-testid="no-durable-tasks">{t('tasks.center.noLocalPending')}</p>}
        {tasks.phase !== 'ready' && <div className="notice warning" role="status" data-testid="task-list-unavailable">{tasks.phase === 'loading' ? t('tasks.center.loadingRecoveryRecords') : t('tasks.center.recoveryListUnavailable')}{tasks.phase !== 'loading' && tasks.error?.displayMessage && <p data-testid="task-list-error-detail">{renderMessage(tasks.error.displayMessage)}</p>}<Button variant="ghost" className="button small" disabled={tasks.phase === 'loading'} onClick={() => { if (interaction.capture()) onReload(); }}>{t('tasks.center.reloadTasks')}</Button></div>}
        <div className="task-center-storage"><RecoveryStorageDetails domain="task-center" durableOperationCount={DURABLE_EDIT_OPERATIONS.length} /><p className="helper muted" data-testid="durable-task-storage">{t('tasks.center.durableStorage', { length: creationParameter(DURABLE_EDIT_OPERATIONS.length) })}</p></div>
      </section>
    </aside>
    <section className="task-center-detail" data-testid="task-center-detail" aria-label={t('shell.details')}>
      {dispositions?.phase==='error'&&<div className="notice warning" role="alert" data-testid="task-disposition-error">{t('redesign.tasks.dispositionError')}<Button variant="ghost" onClick={()=>{if(canFilter())dispositions.reload();}}>{t('tasks.center.reloadTasks')}</Button></div>}
      {dispositions?.mutationUncertain&&<div className="notice warning" role="alert" data-testid="task-disposition-uncertain">{t('redesign.tasks.dispositionUncertain')}<Button variant="ghost" disabled={dispositions.busy} onClick={()=>{if(canFilter())void dispositions.retry();}}>{t('redesign.tasks.checkDisposition')}</Button></div>}
      {selectedEntry&&<section className="task-detail-summary" data-testid="task-detail-summary"><h3>{selectedEntry.label}</h3><dl><dt>{t('redesign.tasks.type')}</dt><dd>{selectedEntry.group}</dd><dt>{t('redesign.tasks.status')}</dt><dd>{selectedEntry.status}</dd><dt>{t(pendingSelection&&selectedId?'redesign.tasks.requestId':'redesign.tasks.identifier')}</dt><dd className="task-id-copy"><code>{selectedId||t('redesign.tasks.noTaskId')}</code><Button type="button" variant="ghost" data-testid="task-copy-id" disabled={!selectedId} onClick={async()=>{if(!selectedId)return;const stillCurrent=captureTask(selectedKey);if(!stillCurrent)return;try{if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');await navigator.clipboard.writeText(selectedId);if(stillCurrent())setClipboard({owner:selectionOwner,state:'copied'});}catch{if(stillCurrent())setClipboard({owner:selectionOwner,state:'failed'});}}}>{t('redesign.tasks.copyId')}</Button></dd>{selectedEntry.search&&selectedEntry.search!==selectedId&&<><dt>{t('redesign.tasks.requestId')}</dt><dd><code>{selectedEntry.search}</code></dd></>}</dl>
        {clipboard?.owner===selectionOwner&&<p role="status" data-testid="task-copy-result">{t(clipboard.state==='copied'?'redesign.tasks.copied':'redesign.tasks.copyFailed')}</p>}
        {selectedDisposition?.markedFailed&&selectedDisposition.canMarkFailed&&<p className="notice warning" data-testid="task-local-failed-marker">{t('redesign.tasks.markedFailedExplanation')}</p>}
      </section>}
      {scenes.map(item => detail(item.key, item.detail))}
      {renderTasks.map(item => detail(`render:${item.id}`, <TaskRenderList items={[item]} projectId={data.project?.id || ''} restored={restored} heldIds={data.restore?.heldExportIds || []} onHistory={onOpenExportHistory ? () => { if (captureTask(`render:${item.id}`)) onOpenExportHistory(); } : undefined} />))}
      {tasks.items.map(task => detail(`local:${task.id}`, <DurableTask key={task.id} task={task} dispositionAction={dispositionAction(`local:${task.id}`)} held={tasks.heldIds?.includes(task.id)} uncertain={tasks.uncertain.includes(task.id)} busy={busy[`task:${task.id}`] || tasks.busy.includes(task.id) || typeof task.lane === 'string' && tasks.busy.includes(task.lane)} onRecover={() => { const stillCurrent = captureTask(`local:${task.id}`); if (stillCurrent) onRecover(task, false, stillCurrent); }} onAcknowledge={() => { const stillCurrent = captureTask(`local:${task.id}`); if (stillCurrent) onRecover(task, true, stillCurrent); }} />))}
      {pending.map(entry => detail(`pending:${entry.expectedWorkspaceOrigin || 'legacy'}:${entry.key}`, <><PendingSubmission key={`${entry.expectedWorkspaceOrigin || 'legacy'}:${entry.key}`} entry={pass(entry)} heldReason={workspace ? pass<{ reason?: string }>(workspaceIntentDisposition(entry, pass(workspace))).reason : undefined} heldCode={workspace ? pass<{ code?: string }>(workspaceIntentDisposition(entry, pass(workspace))).code : undefined} busy={busy[entry.key] || (isMutationOperation(entry.operation) && busy['canvas:mutation'])} duplicate={tasks.items.some(task => task.operation === entry.operation && task.requestId === entry.input.requestId)} onAdopt={isDurableEditOperation(entry.operation) ? () => { if (captureTask(`pending:${entry.expectedWorkspaceOrigin || 'legacy'}:${entry.key}`)) onAdopt(entry); } : undefined} onReplay={() => { if (!captureTask(`pending:${entry.expectedWorkspaceOrigin || 'legacy'}:${entry.key}`)) return; if (isSubjectRetryPending(pass(entry), pass(data.jobs))) run(entry.key, entry.operation, entry.input, message('tasks.center.originalRecovered'), restored ? { replay: true, subjectRetry: true, pendingEntry: entry } : { replay: true, subjectRetry: true }); else run(entry.key, entry.operation, entry.input, message('tasks.center.originalRecovered'), restored ? { replay: true, pendingEntry: entry } : { replay: true }); }} />{entry.input.requestId && <p className="helper muted task-request-id">{t('tasks.center.requestIdentity', { requestId: creationParameter(entry.input.requestId) })}</p>}</>))}
      {jobs.map(job => detail(job.id, <div className={`job-card ${job.status}`} key={job.id} data-testid={`job-${job.id}`}><div className="job-title"><span className={`job-state-icon ${job.status}`}>{(!restored && activeJob(job)) ? <span className="spinner" /> : <Icon name={job.status === 'succeeded' ? 'check' : job.status === 'failed' ? 'close' : 'info'} size={16} />}</span><strong>{t('round4.tasks.statusAndDiagnostics')}</strong><Badge className="small-badge neutral">{job.providerId}</Badge></div><div className="job-status"><span>{renderMessage(jobStatusDescriptor(job))}{restored && <span className="restored-held-label"> {t('tasks.center.historicalPaused')}</span>}</span><span>{(!restored && activeJob(job)) ? `${Math.round(job.progress || 0)}%` : formatDate(pass(job.createdAt), { hour: '2-digit', minute: '2-digit' })}</span></div>{(!restored && activeJob(job)) && <div className="progress-track"><span style={{ width: `${Math.max(3, job.progress || 0)}%` }} /></div>}{Boolean(job.error) && <p className="job-error">{renderMessage(taskErrorDescriptor(job.error))}{Boolean(safeTaskErrorCode(job.error)) && <small>{t('tasks.error.diagnosticCode', { code: safeTaskErrorCode(job.error) as string })}</small>}</p>}{job.status === 'submission_unknown' && <div className="notice warning">{t('tasks.center.unknownSubmissionWarning')}</div>}{['submission_unknown', 'cancelled'].includes(job.status) && <div className="reconcile-job"><p className="task-reconciliation-explanation">{t('redesign.tasks.reconciliationHint')}</p><Label className="field-label" htmlFor={`reconcile-${job.id}`}>{t('tasks.center.providerTaskId')}<span className="optional">{t('tasks.center.optional')}</span></Label><Input disabled={restored} id={`reconcile-${job.id}`} value={reconcileIds[job.id] || ''} onChange={e => { if (captureTask(job.id)) setReconcileIds(ids => ({ ...ids, [job.id]: e.target.value })); }} placeholder={job.providerJobId || t('tasks.center.knownIdRecovered')} /></div>}{outputReviewRequired(job) && <div className="notice warning" data-testid="output-review-required">{renderMessage(outputReviewDescriptor)}</div>}{job.status === 'cancelled' && !outputReviewRequired(job) && <p className="helper muted">{t('tasks.center.stopScope', { value: creationParameter(job.cancelScope === 'remote' ? t('tasks.center.remoteCancellationConfirmed') : t('tasks.center.localWaitOnly')) })}</p>}{typeof job.requestId === 'string' && <p className="helper muted task-request-id">{t('tasks.center.requestIdentity', { requestId: creationParameter(job.requestId) })}</p>}<details className="task-card-details"><summary>{t('shell.details')}</summary><div className="job-snapshot"><span>{String(job.snapshot?.duration)}s · {String(job.snapshot?.aspectRatio)}</span><span>{t('tasks.center.submissions', { count: job.submissionCount ?? 1 })}</span></div><SubjectVideoSummary reference={pass(job.snapshot?.subjectReference)} assets={pass(data.assets)} compact /></details><div className="job-actions"><Button variant="ghost" className="text-button" onClick={() => { const stillCurrent = captureTask(job.id); if (stillCurrent) onInspectJob(job, stillCurrent); }}>{t('tasks.center.viewShot')}<Icon name="arrow" size={12} /></Button>{['submission_unknown', 'cancelled'].includes(job.status) && <Button type="button" variant="outline" className="button small task-reconcile-action" data-testid={`reconcile-job-${job.id}`} disabled={restored || busy[`reconcile:${job.id}`]} onClick={() => { if (captureTask(job.id)) run(`reconcile:${job.id}`, 'job.reconcile', { jobId: job.id, ...(reconcileIds[job.id]?.trim() ? { providerJobId: (reconcileIds[job.id] ?? '').trim() } : {}) }, message('tasks.center.existingStatusChecked')); }}><Icon name="refresh" size={13} />{t('tasks.center.reconcileExistingTask')}</Button>}{dispositionAction(job.id)}{job.status === 'failed' && <Button variant="ghost" className="button small" data-testid={`retry-job-${job.id}`} disabled={restored || busy[`retry:${job.id}`] || jobs.some(child => child.retryOfJobId === job.id && (activeJob(child) || child.status === 'submission_unknown'))} title={restored ? renderMessage(workspaceHeldDescriptor) : jobs.some(child => child.retryOfJobId === job.id && (activeJob(child) || child.status === 'submission_unknown')) ? t('tasks.center.retryAlreadyPending') : t('tasks.center.retryOriginalSnapshot')} onClick={() => { const stillCurrent = captureTask(job.id); if (stillCurrent) retryGeneration(job, stillCurrent); }}><Icon name="refresh" size={13} />{jobs.some(child => child.retryOfJobId === job.id && (activeJob(child) || child.status === 'submission_unknown')) ? t('tasks.center.retryExists') : t('tasks.center.retryFailed')}</Button>}{(!restored && activeJob(job)) && <Button variant="ghost" className="button small" disabled={busy[`cancel:${job.id}`]} onClick={async () => { const stillCurrent = captureTask(job.id); if (!stillCurrent) return; const captured = context(); if (await confirm(message('tasks.center.stopWaitConfirmation')) && stillCurrent() && isCurrent(captured)) run(`cancel:${job.id}`, 'job.cancel', { jobId: job.id }, message('tasks.center.stopRequested')); }}><Icon name="stop" size={12} />{t('tasks.center.stopWaiting')}</Button>}</div></div>))}
      {!matchingEntries.length && <div className="small-empty" data-testid="task-center-filter-empty"><Icon name="clock" size={30} /><h4>{t(entries.length ? 'redesign.tasks.noMatch' : 'tasks.center.noGenerationTasks')}</h4><p>{t(entries.length ? 'redesign.tasks.localFilter' : 'tasks.center.generationEmptyHint')}</p></div>}
    </section>
  </div></TaskWorkspace>;
}
