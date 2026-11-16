import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter } from './creation-i18n.ts';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { WorkbenchTooltip } from './WorkspaceControls.tsx';
import Icon from './icons.tsx';
import { isMutationOperation } from './mutation-submissions.ts';
import { TIMELINE_MUTATION_OPERATIONS } from '@mioon/contracts';
import { isReferenceOperation } from './reference-connections.ts';

interface PendingSubmissionEntry {readonly operation: string; readonly createdAt: string}
interface PendingSubmissionProps {
  entry: PendingSubmissionEntry; busy?: boolean; onReplay: () => void; onAdopt?: () => void;
  duplicate?: boolean;
}
export default function PendingSubmission({ entry, busy, onReplay, onAdopt, duplicate }: PendingSubmissionProps) {
  const { t, formatDate } = useI18n();
  const mutation = isMutationOperation(entry.operation) || TIMELINE_MUTATION_OPERATIONS.includes(entry.operation) || isReferenceOperation(entry.operation);
  return <div className="job-card submission_unknown" data-testid="pending-submission">
    <div className="job-title">
      <strong>{t('tasks.pending.outcomeUnconfirmed')}</strong>
      <WorkbenchTooltip content={<div className="task-tooltip-copy">
        <p>{t('tasks.pending.sameRequestDisclosure')}</p>
        <p data-testid={mutation ? 'mutation-recovery-storage' : 'session-request-storage'}>{t(mutation ? 'tasks.pending.mutationStorage' : 'tasks.pending.submissionStorage')}</p>
      </div>}><Button type="button" variant="ghost" size="icon-sm" aria-label={t('shell.details')} data-testid="pending-submission-info"><Icon name="info" /></Button></WorkbenchTooltip>
    </div>
    <div className="job-snapshot"><span>{entry.operation}</span><span>{formatDate(entry.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
    {duplicate && <p className="helper muted" data-testid="legacy-task-duplicate">{t('tasks.pending.duplicateLocalRecord')}</p>}
    <div className="job-actions">{onAdopt && <Button variant="ghost" className="button small" data-testid="adopt-legacy-task" disabled={busy} onClick={onAdopt}>{t('tasks.pending.adoptOriginal')}</Button>}<Button variant="ghost" className="button small" data-testid="resume-pending" disabled={busy} onClick={onReplay}><Icon name="refresh" size={13} />{t('tasks.pending.recoverSameRequest')}</Button></div>
  </div>;
}
