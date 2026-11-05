import React, {useEffect, useState} from 'react';
import {WorkbenchAlert, WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {createProjectHistoryClient} from './project-history-client.ts';
import {useI18n} from './i18n/I18nProvider.tsx';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function canOfferBackupRecovery(error: unknown): boolean {
  if (!record(error)) return false;
  const details = record(error.details) ? error.details : null;
  if (details?.reason === 'read-only' || details?.invalidReason === 'read-only') return false;
  return error.code === 'PROJECT_INVALID' || error.code === 'PROJECT_UNAVAILABLE' && details?.reason === 'PROJECT_INVALID';
}

/** A failed project is never acquired merely to look for its private backups. */
export default function ProjectBackupRecovery({projectId, onRestore}: {readonly projectId: string; readonly onRestore: () => void}) {
  const {t} = useI18n(), [retry, setRetry] = useState(0), [phase, setPhase] = useState<'loading' | 'empty' | 'ready' | 'error'>('loading');
  useEffect(() => {
    const owner = new AbortController(); setPhase('loading');
    void createProjectHistoryClient().backups({projectId}, owner.signal).then(value => {
      if (!owner.signal.aborted) setPhase(value.backups.length ? 'ready' : 'empty');
    }).catch(() => {if (!owner.signal.aborted) setPhase('error');});
    return () => owner.abort();
  }, [projectId, retry]);
  if (phase === 'error') return <WorkbenchAlert tone="warning" data-testid="project-backup-recovery-error"
    actions={<WorkbenchButton onClick={() => setRetry(value => value + 1)}>{t('projectFile.common.retry')}</WorkbenchButton>}>
    {t('projectHistory.tabs.backups')} · {t('projectHistory.error.read')}
  </WorkbenchAlert>;
  if (phase !== 'ready') return null;
  return <WorkbenchButton data-testid="project-backup-recovery" onClick={onRestore}>{t('projectFile.open.invalid.restore')}</WorkbenchButton>;
}
