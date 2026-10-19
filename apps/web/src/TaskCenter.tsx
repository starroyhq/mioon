import TaskRenderList from './TaskRenderList.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import { jobStatusDescriptor, outputReviewDescriptor, workspaceHeldDescriptor, taskErrorDescriptor, safeTaskErrorCode } from './creation-i18n.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter } from './creation-i18n.ts';
import { workspaceIntentDisposition } from './workspace-origin.ts';
import React from 'react';
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
}
export interface DurableTaskProps { task: DurableTaskView; uncertain: boolean; busy: boolean; held?: boolean; onRecover: () => unknown; onAcknowledge: () => unknown }

const subtitleLabels = (t: Translator): Record<string, string> => ({ 'timeline.subtitle.add': t('tasks.center.addSubtitle'), 'timeline.subtitle.update': t('tasks.center.updateSubtitle'), 'timeline.subtitle.remove': t('tasks.center.removeSubtitle') });

function DurableTask({ task, uncertain, busy, held = false, onRecover, onAcknowledge }: DurableTaskProps): React.ReactElement {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const status = !held && uncertain && !['applied', 'not_applied'].includes(task.status) ? 'unknown' : task.status;
  const label = ({ prepared: t('tasks.center.prepared'), dispatching: t('tasks.center.checkingOutcome'), unknown: t('tasks.center.outcomePending'), applied: t('tasks.center.appliedAwaitingClose'), not_applied: t('tasks.center.confirmedNotApplied') } as Record<string, string>)[status];
  return <div className={`job-card ${status}`} data-testid={`durable-task-${task.id}`} data-task-state={status}>
    <div className="job-title"><Icon name="info" size={17} /><strong>{label}</strong></div>
    <div className="job-snapshot"><span>{task.operation === 'timeline.format.set' ? t('tasks.center.timelineFormatOperation') : subtitleLabels(t)[task.operation] ? `${subtitleLabels(t)[task.operation]} · ${task.operation}` : task.operation}</span><span>{formatDate(task.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
    {held && <p className="restored-held-label" data-testid="restored-task-held">{t('tasks.center.historicalHeld')}</p>}
    <p className="helper muted">{t('tasks.center.requestIdentity', { requestId: creationParameter(task.requestId) })}</p>
    {task.origin === 'legacy_session' && <p className="helper muted">{t('tasks.center.legacyAdopted')}</p>}
    <p className="helper muted">{held ? renderMessage(workspaceHeldDescriptor) : t('tasks.center.recoveryScope')}</p>
    <div className="job-actions">{['applied', 'not_applied'].includes(task.status)
      ? <Button variant="ghost" className="button small" data-testid="acknowledge-task" disabled={busy || held} title={held ? renderMessage(workspaceHeldDescriptor) : undefined} onClick={onAcknowledge}>{t('tasks.center.acknowledgeClose')}</Button>
      : <Button variant="ghost" className="button small" data-testid="recover-durable-task" disabled={busy || held} title={held ? renderMessage(workspaceHeldDescriptor) : undefined} onClick={onRecover}><Icon name="refresh" size={13} />{task.status === 'dispatching' ? t('tasks.center.checkSameRequest') : t('tasks.center.recoverSameRequest')}</Button>}</div>
  </div>;
}

export default function TaskCenter({ workspace, activeCount, pending, busy, jobs, data, reconcileIds, setReconcileIds, run, retryGeneration, onInspectJob, context, confirm, isCurrent, captureView, taskViewScope, tasks, onRecover, onReload, onAdopt, onOpenExportHistory }: TaskCenterProps): React.ReactElement {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const restored = workspace?.restored === true;
  const interaction = useTaskWorkspaceInteraction(pass(captureView), taskViewScope, Boolean(useWorkspaceVisibility()));
  return <TaskWorkspace activeCount={activeCount}><TaskRenderList items={data.exports || []} projectId={data.project?.id || ''} restored={restored} heldIds={data.restore?.heldExportIds || []} onHistory={onOpenExportHistory ? () => { if (interaction.capture()) onOpenExportHistory(); } : undefined} /><h3>{t('tasks.center.localEditRequests')}</h3><p className="helper muted" data-testid="durable-task-storage">{t('tasks.center.durableStorage', { length: creationParameter(DURABLE_EDIT_OPERATIONS.length) })}</p>
      <RecoveryStorageDetails domain="task-center" durableOperationCount={DURABLE_EDIT_OPERATIONS.length} />
      {tasks.phase !== 'ready' && <div className="notice warning" role="status" data-testid="task-list-unavailable">{tasks.phase === 'loading' ? t('tasks.center.loadingRecoveryRecords') : t('tasks.center.recoveryListUnavailable')}{tasks.phase !== 'loading' && tasks.error?.displayMessage && <p data-testid="task-list-error-detail">{renderMessage(tasks.error.displayMessage)}</p>}<Button variant="ghost" className="button small" disabled={tasks.phase === 'loading'} onClick={() => { if (interaction.capture()) onReload(); }}>{t('tasks.center.reloadTasks')}</Button></div>}
      {tasks.items.map(task => <DurableTask key={task.id} task={task} held={tasks.heldIds?.includes(task.id)} uncertain={tasks.uncertain.includes(task.id)} busy={busy[`task:${task.id}`] || tasks.busy.includes(task.id) || typeof task.lane === 'string' && tasks.busy.includes(task.lane)} onRecover={() => { const stillCurrent = interaction.capture(); if (stillCurrent) onRecover(task, false, stillCurrent); }} onAcknowledge={() => { const stillCurrent = interaction.capture(); if (stillCurrent) onRecover(task, true, stillCurrent); }} />)}
      {tasks.phase === 'ready' && !tasks.items.length && <p className="helper muted" data-testid="no-durable-tasks">{t('tasks.center.noLocalPending')}</p>}
      {pending.length > 0 && <h3>{t('tasks.center.sessionPending')}</h3>}
      {pending.map(entry => <PendingSubmission key={`${entry.expectedWorkspaceOrigin || 'legacy'}:${entry.key}`} entry={pass(entry)} heldReason={workspace ? pass<{ reason?: string }>(workspaceIntentDisposition(entry, pass(workspace))).reason : undefined} heldCode={workspace ? pass<{ code?: string }>(workspaceIntentDisposition(entry, pass(workspace))).code : undefined} busy={busy[entry.key] || (isMutationOperation(entry.operation) && busy['canvas:mutation'])} duplicate={tasks.items.some(task => task.operation === entry.operation && task.requestId === entry.input.requestId)} onAdopt={isDurableEditOperation(entry.operation) ? () => { if (interaction.capture()) onAdopt(entry); } : undefined} onReplay={() => { if (!interaction.capture()) return; if (isSubjectRetryPending(pass(entry), pass(data.jobs))) run(entry.key, entry.operation, entry.input, message('tasks.center.originalRecovered'), restored ? { replay: true, subjectRetry: true, pendingEntry: entry } : { replay: true, subjectRetry: true }); else run(entry.key, entry.operation, entry.input, message('tasks.center.originalRecovered'), restored ? { replay: true, pendingEntry: entry } : { replay: true }); }} />)}
      <h3>{t('tasks.center.generationTasks')}</h3>{jobs.length ? jobs.map(job => <div className={`job-card ${job.status}`} key={job.id} data-testid={`job-${job.id}`}><div className="job-title"><span className={`job-state-icon ${job.status}`}>{(!restored && activeJob(job)) ? <span className="spinner" /> : <Icon name={job.status === 'succeeded' ? 'check' : job.status === 'failed' ? 'close' : 'info'} size={16} />}</span><strong>{(data.shots ?? []).find(s => s.id === job.shotId)?.title || t('tasks.center.shotTask')}</strong><Badge className="small-badge neutral">{job.providerId}</Badge></div><div className="job-status"><span>{renderMessage(jobStatusDescriptor(job))}{restored && <span className="restored-held-label"> {t('tasks.center.historicalPaused')}</span>}</span><span>{(!restored && activeJob(job)) ? `${Math.round(job.progress || 0)}%` : formatDate(pass(job.createdAt), { hour: '2-digit', minute: '2-digit' })}</span></div>{(!restored && activeJob(job)) && <div className="progress-track"><span style={{ width: `${Math.max(3, job.progress || 0)}%` }} /></div>}{Boolean(job.error) && <p className="job-error">{renderMessage(taskErrorDescriptor(job.error))}{Boolean(safeTaskErrorCode(job.error)) && <small>{t('tasks.error.diagnosticCode', { code: safeTaskErrorCode(job.error) as string })}</small>}</p>}{job.status === 'submission_unknown' && <div className="notice warning">{t('tasks.center.unknownSubmissionWarning')}</div>}{['submission_unknown', 'cancelled'].includes(job.status) && <div className="reconcile-job"><Label className="field-label" htmlFor={`reconcile-${job.id}`}>{t('tasks.center.providerTaskId')}<span className="optional">{t('tasks.center.optional')}</span></Label><Input disabled={restored} id={`reconcile-${job.id}`} value={reconcileIds[job.id] || ''} onChange={e => { if (interaction.capture()) setReconcileIds(ids => ({ ...ids, [job.id]: e.target.value })); }} placeholder={job.providerJobId || t('tasks.center.knownIdRecovered')} /><Button variant="ghost" className="button small" data-testid={`reconcile-job-${job.id}`} disabled={restored || busy[`reconcile:${job.id}`]} onClick={() => { if (interaction.capture()) run(`reconcile:${job.id}`, 'job.reconcile', { jobId: job.id, ...(reconcileIds[job.id]?.trim() ? { providerJobId: (reconcileIds[job.id] ?? '').trim() } : {}) }, message('tasks.center.existingStatusChecked')); }}><Icon name="refresh" size={13} />{t('tasks.center.reconcileExistingTask')}</Button></div>}{outputReviewRequired(job) && <div className="notice warning" data-testid="output-review-required">{renderMessage(outputReviewDescriptor)}</div>}{job.status === 'cancelled' && !outputReviewRequired(job) && <p className="helper muted">{t('tasks.center.stopScope', { value: creationParameter(job.cancelScope === 'remote' ? t('tasks.center.remoteCancellationConfirmed') : t('tasks.center.localWaitOnly')) })}</p>}<div className="job-snapshot"><span>{String(job.snapshot?.duration)}s · {String(job.snapshot?.aspectRatio)}</span><span>{t('tasks.center.submissions', { count: job.submissionCount ?? 1 })}</span></div><SubjectVideoSummary reference={pass(job.snapshot?.subjectReference)} assets={pass(data.assets)} compact /><div className="job-actions"><Button variant="ghost" className="text-button" onClick={() => { const stillCurrent = interaction.capture(); if (stillCurrent) onInspectJob(job, stillCurrent); }}>{t('tasks.center.viewShot')}<Icon name="arrow" size={12} /></Button>{job.status === 'failed' && <Button variant="ghost" className="button small" data-testid={`retry-job-${job.id}`} disabled={restored || busy[`retry:${job.id}`] || jobs.some(child => child.retryOfJobId === job.id && (activeJob(child) || child.status === 'submission_unknown'))} title={restored ? renderMessage(workspaceHeldDescriptor) : jobs.some(child => child.retryOfJobId === job.id && (activeJob(child) || child.status === 'submission_unknown')) ? t('tasks.center.retryAlreadyPending') : t('tasks.center.retryOriginalSnapshot')} onClick={() => { const stillCurrent = interaction.capture(); if (stillCurrent) retryGeneration(job, stillCurrent); }}><Icon name="refresh" size={13} />{jobs.some(child => child.retryOfJobId === job.id && (activeJob(child) || child.status === 'submission_unknown')) ? t('tasks.center.retryExists') : t('tasks.center.retryFailed')}</Button>}{(!restored && activeJob(job)) && <Button variant="ghost" className="button small" disabled={busy[`cancel:${job.id}`]} onClick={async () => { const stillCurrent = interaction.capture(); if (!stillCurrent) return; const captured = context(); if (await confirm(message('tasks.center.stopWaitConfirmation')) && stillCurrent() && isCurrent(captured)) run(`cancel:${job.id}`, 'job.cancel', { jobId: job.id }, message('tasks.center.stopRequested')); }}><Icon name="stop" size={12} />{t('tasks.center.stopWaiting')}</Button>}</div></div>) : <div className="small-empty"><Icon name="clock" size={30} /><h4>{t('tasks.center.noGenerationTasks')}</h4><p>{t('tasks.center.generationEmptyHint')}</p></div>}</TaskWorkspace>;
}
