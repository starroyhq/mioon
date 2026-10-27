import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import type { ReactElement } from 'react';
import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { Button } from '@mioon/ui/components/button';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { AlertTriangle, Camera, CircleAlert, CircleCheck, Clapperboard, Clock, Film, Layers, LoaderCircle, RotateCcw, Sun } from '@mioon/ui/components/workbench-icons';
import { subjectVariantTagParts } from './subject-state.ts';
import { subjectVariantProgress, subjectVariantRetryable } from './subject-variant-state.ts';
import type { SubjectVariantController, SubjectVariantState } from './subject-variant-state.ts';
import type { SubjectVariantBatch, SubjectVariantBlocker, SubjectVariantItem } from '@mioon/contracts';
import type { SubjectVersionResponse } from '../../../packages/contracts/src/subjects.ts';
import './subject-variants.css';

type Translate = ReturnType<typeof useI18n>['t'];
type Render = ReturnType<typeof useI18n>['renderMessage'];
export interface SubjectVariantShot { id: string; title?: string; orderIndex?: number; [key: string]: unknown }
interface VariantRowContext {
  controller: SubjectVariantController;
  /** The subject's loaded versions by ID; a finished item is named by its number. */
  versions: Readonly<Record<string, SubjectVersionResponse>>;
  /** True while the pane cannot act or another variant write is in flight or unknown. */
  disabled: boolean;
  admit: (action: () => unknown) => unknown;
}
const UNRESOLVED = new Set(['unknown', 'recoverable', 'interrupted']);
const blockerIcons = Object.freeze({ IN_PROGRESS: LoaderCircle, UNKNOWN: CircleAlert, BOUND: Clapperboard, GENERATED: Film, SOURCE: Layers });

/** The camera or lighting tag of one item, e.g. "左前 · 广角". */
export function subjectVariantItemTag(batch: SubjectVariantBatch, item: SubjectVariantItem, render: Render): string {
  return (subjectVariantTagParts({ ...item.spec, batchId: batch.id, sourceVersionId: batch.sourceVersionId }) ?? []).map(part => render(part)).join(' · ');
}
/** How a reason names an item: its version number once it has one, otherwise its tag. */
export function subjectVariantItemName(batch: SubjectVariantBatch, position: number, versions: Readonly<Record<string, SubjectVersionResponse>>, t: Translate, render: Render): string {
  const item = batch.items[position - 1];
  if (!item) return String(position);
  const version = item.versionId ? versions[item.versionId] : undefined;
  if (version) return `V${version.number}`;
  const tag = subjectVariantItemTag(batch, item, render);
  return batch.kind === 'light' ? `${t('subjects.inspector.variantLight')} · ${tag}` : tag;
}

export interface SubjectVariantBatchRowProps extends VariantRowContext {
  batch: SubjectVariantBatch;
  /** Shots in storyboard order; a reason names the shot that uses a version. */
  shots: readonly SubjectVariantShot[];
  /** This batch's images are being submitted now. */
  submitting: boolean;
  /** Why an image was not submitted, keyed `<batchId>:<position>`. */
  issues: Readonly<Record<string, DisplayMessage>>;
  onShowTasks?: (() => unknown) | undefined;
}
// 09-10c-1 and its supplements: one row per batch with its progress and undo,
// and below it why the batch cannot be undone yet. Nothing here resends on its
// own: unsubmitted images wait for an explicit "continue", unknown results for
// the task center.
export function SubjectVariantBatchRow({ batch, shots, submitting, issues, controller, versions, disabled, admit, onShowTasks }: SubjectVariantBatchRowProps): ReactElement {
  const { t, renderMessage } = useI18n();
  const confirm = useConfirmation();
  const progress = subjectVariantProgress(batch), paid = batch.providerId === 'openai';
  const summary = [t(batch.kind === 'light' ? 'subjects.variants.rowLight' : 'subjects.variants.rowAngle', { done: progress.done, total: progress.total }),
    ...(progress.failed ? [t('subjects.variants.rowFailed', { failed: progress.failed })] : []),
    ...(progress.unknown ? [t('subjects.variants.rowUnknown', { unknown: progress.unknown })] : []),
    ...(progress.pending ? [t('subjects.variants.rowUnsubmitted', { pending: progress.pending })] : [])].join(' · ');
  const moving = submitting || progress.running > 0, attention = !moving && (progress.failed > 0 || progress.unknown > 0);
  const blockers = batch.undo && !batch.undo.available ? batch.undo.blockers : [];
  const name = (position: number): string => subjectVariantItemName(batch, position, versions, t, renderMessage);
  const order = [...shots].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  const reason = (blocker: SubjectVariantBlocker): string => {
    const item = name(blocker.position);
    if (blocker.code === 'IN_PROGRESS') return t('subjects.variants.blocker.inProgress', { item });
    if (blocker.code === 'UNKNOWN') return t('subjects.variants.blocker.unknown', { item });
    if (blocker.code === 'GENERATED') return t('subjects.variants.blocker.generated', { item });
    if (blocker.code === 'SOURCE') return t('subjects.variants.blocker.source', { item });
    const index = order.findIndex(shot => shot.id === blocker.shotId), shot = order[index];
    return shot ? t('subjects.variants.blocker.bound', { item, shot: `${String(index + 1).padStart(2, '0')} ${shot.title || ''}`.trim() }) : t('subjects.variants.blocker.boundAnyShot', { item });
  };
  // One confirmation per explicit action; the batch confirmed is the one shown.
  const continueSubmit = (): void => { void (async () => { if (await confirm(message(paid ? 'subjects.variants.continueConfirmPaid' : 'subjects.variants.continueConfirmMock', { total: progress.pending }))) await controller.submit(batch); })(); };
  const undo = (): void => { void (async () => { if (await confirm(message('subjects.variants.undoConfirm', { total: progress.done }))) await controller.undo(batch); })(); };
  const notes = [...new Set(batch.items.map(item => issues[`${batch.id}:${item.position}`]).filter((issue): issue is DisplayMessage => Boolean(issue)).map(issue => renderMessage(issue)))];
  return <div className="subject-variant-batch" data-testid={`subject-variant-batch-${batch.id}`}>
    <div className={`subject-variant-batch-row${attention ? ' is-danger' : ''}`}>
      {moving ? <LoaderCircle size={13} className="subject-variant-spin" aria-hidden="true" /> : attention ? <CircleAlert size={13} aria-hidden="true" /> : <CircleCheck size={13} aria-hidden="true" />}
      <strong role="status">{summary}</strong>
      {progress.pending > 0 && <Button variant="ghost" size="sm" data-testid={`subject-variant-continue-${batch.id}`} disabled={disabled || submitting} onClick={() => admit(continueSubmit)}>{t('subjects.variants.continue')}</Button>}
      <Button variant="ghost" size="sm" data-testid={`subject-variant-undo-${batch.id}`} disabled={disabled || !batch.undo?.available} onClick={() => admit(undo)}>{t('subjects.variants.undo')}</Button>
    </div>
    {notes.map(note => <p key={note} className="subject-variant-item-note is-danger" role="alert">{note}</p>)}
    {progress.unknown > 0 && <div className="subject-variant-unknown"><p className="subject-variant-item-note">{t('subjects.variants.item.unknownHint')}</p><div className="subject-actions">
      {onShowTasks && <Button variant="outline" size="sm" data-testid={`subject-variant-tasks-${batch.id}`} onClick={() => admit(() => onShowTasks())}>{t('subjects.variants.showTasks')}</Button>}
      <Button variant="ghost" size="sm" data-testid={`subject-variant-reread-${batch.id}`} disabled={disabled} onClick={() => admit(() => controller.readBatch(batch.id))}>{t('subjects.variants.reconcile')}</Button></div></div>}
    {blockers.length > 0 && <div className="subject-variant-blocked" data-testid={`subject-variant-blocked-${batch.id}`}>
      <p><CircleAlert size={12} aria-hidden="true" />{t('subjects.variants.undoBlocked')}</p>
      {blockers.map((blocker, index) => { const BlockerIcon = blockerIcons[blocker.code]; return <p key={`${blocker.code}:${blocker.position}:${index}`}><BlockerIcon size={12} aria-hidden="true" />{reason(blocker)}</p>; })}
    </div>}
  </div>;
}

export interface SubjectVariantItemTileProps extends VariantRowContext {
  batch: SubjectVariantBatch;
  item: SubjectVariantItem;
  submitting: boolean;
}
// An image of a batch that has no version yet, in place in the version grid:
// queued or generating, waiting to be submitted, failed (with a retry only when
// the provider refused it or it was cancelled before sending) or unknown.
export function SubjectVariantItemTile({ batch, item, submitting, controller, disabled, admit }: SubjectVariantItemTileProps): ReactElement {
  const { t, renderMessage } = useI18n();
  const confirm = useConfirmation();
  const failed = item.status === 'failed' || item.status === 'cancelled', unknown = UNRESOLVED.has(item.status), waiting = item.status === 'pending';
  // A finished image whose version is not in the loaded list yet still shows as generating.
  const running = item.status === 'running' || item.status === 'succeeded', moving = running || waiting && submitting;
  const status = running ? t(item.image?.state === 'queued' ? 'subjects.variants.item.queued' : 'subjects.variants.item.running')
    : waiting ? t(submitting ? 'subjects.variants.item.submitting' : 'subjects.variants.item.pending') : failed ? t('subjects.variants.item.failed') : t('subjects.variants.item.unknown');
  const retry = (): void => { void (async () => { if (await confirm(message(batch.providerId === 'openai' ? 'subjects.variants.retryConfirmPaid' : 'subjects.variants.retryConfirmMock'))) await controller.retry(batch, item.position); })(); };
  const StatusIcon = moving ? LoaderCircle : failed ? AlertTriangle : unknown ? CircleAlert : Clock;
  return <div className="subject-version-tile" role="listitem" data-testid={`subject-variant-item-${batch.id}-${item.position}`}>
    <div className={`subject-variant-tile${failed ? ' is-failed' : unknown ? ' is-unknown' : ''}`}>
      <StatusIcon size={16} className={moving ? 'subject-variant-spin' : undefined} aria-hidden="true" />
      <span>{status}</span>
      {subjectVariantRetryable(item) && <Button variant="outline" size="sm" data-testid={`subject-variant-retry-${batch.id}-${item.position}`} disabled={disabled} onClick={() => admit(retry)}><RotateCcw size={12} aria-hidden="true" />{t('subjects.variants.retry')}</Button>}
    </div>
    <span className="subject-version-label is-tag">{batch.kind === 'light' ? <Sun size={10} aria-hidden="true" /> : <Camera size={10} aria-hidden="true" />}{subjectVariantItemTag(batch, item, renderMessage)}</span>
    {failed && <span className="subject-variant-item-note is-danger">{t(item.status === 'cancelled' ? 'subjects.variants.item.cancelledReason' : 'subjects.variants.item.failedReason')}</span>}
  </div>;
}

export interface SubjectVariantNoticeProps { state: SubjectVariantState; controller: SubjectVariantController; disabled: boolean; admit: (action: () => unknown) => unknown }
/** A refusal, or a write whose outcome is unknown with the two ways to resolve it. */
export function SubjectVariantNotice({ state, controller, disabled, admit }: SubjectVariantNoticeProps): ReactElement | null {
  const { t, renderMessage } = useI18n();
  if (!state.notice && !state.pending) return null;
  return <div className="subject-variant-notice" data-testid="subject-variant-notice">
    {state.notice && <p className="subject-warning" role="alert">{renderMessage(state.notice)}</p>}
    <div className="subject-actions">{state.pending ? <>
      <Button variant="outline" size="sm" data-testid="subject-variant-reconcile" disabled={disabled || Boolean(state.busy)} onClick={() => admit(() => controller.reconcile())}>{t('subjects.variants.reconcile')}</Button>
      <Button variant="ghost" size="sm" data-testid="subject-variant-resend" disabled={disabled || Boolean(state.busy)} onClick={() => admit(() => controller.resend())}>{t('subjects.variants.resend')}</Button>
    </> : <Button variant="ghost" size="sm" data-testid="subject-variant-dismiss" onClick={() => admit(() => controller.clearNotice())}>{t('common.close')}</Button>}</div>
  </div>;
}
