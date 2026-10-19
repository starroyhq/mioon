import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter } from './creation-i18n.ts';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.tsx';
import { isMutationOperation } from './mutation-submissions.ts';
import { TIMELINE_MUTATION_OPERATIONS } from '@mioon/contracts';
import { isReferenceOperation } from './reference-connections.ts';

export default function PendingSubmission({ entry, busy, onReplay, onAdopt, duplicate, heldReason, heldCode }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const mutation = isMutationOperation(entry.operation) || TIMELINE_MUTATION_OPERATIONS.includes(entry.operation) || isReferenceOperation(entry.operation);
  return <div className="job-card submission_unknown" data-testid="pending-submission">
    {heldReason && <p className="restored-held-label" data-testid="restored-pending-held">{t('tasks.pending.historicalHeld')}</p>}
    <div className="job-title"><Icon name="info" size={17} /><strong>{t('tasks.pending.outcomeUnconfirmed')}</strong></div>
    <p className="helper muted" style={{ marginTop: 12 }}>{t('tasks.pending.sameRequestDisclosure')}</p>
    {mutation && <p className="helper muted" data-testid="mutation-recovery-storage">{t('tasks.pending.mutationStorage')}</p>}
    {!mutation && <p className="helper muted" data-testid="session-request-storage">{t('tasks.pending.submissionStorage')}</p>}
    <div className="job-snapshot"><span>{entry.operation}</span><span>{formatDate(entry.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
    {duplicate && <p className="helper muted" data-testid="legacy-task-duplicate">{t('tasks.pending.duplicateLocalRecord')}</p>}
    {heldReason && <p className="helper muted">{t(heldCode === 'WORKSPACE_ORIGIN_UNVERIFIED' ? 'tasks.unverifiedWorkspace' : 'tasks.heldReason')}</p>}
    <div className="job-actions">{onAdopt && <Button variant="ghost" className="button small" data-testid="adopt-legacy-task" disabled={busy || Boolean(heldReason)} title={heldReason ? t(heldCode === 'WORKSPACE_ORIGIN_UNVERIFIED' ? 'tasks.unverifiedWorkspace' : 'tasks.heldReason') : undefined} onClick={onAdopt}>{t('tasks.pending.adoptOriginal')}</Button>}<Button variant="ghost" className="button small" data-testid="resume-pending" disabled={busy || Boolean(heldReason)} title={heldReason ? t(heldCode === 'WORKSPACE_ORIGIN_UNVERIFIED' ? 'tasks.unverifiedWorkspace' : 'tasks.heldReason') : undefined} onClick={onReplay}><Icon name="refresh" size={13} />{t('tasks.pending.recoverSameRequest')}</Button></div>
  </div>;
}
