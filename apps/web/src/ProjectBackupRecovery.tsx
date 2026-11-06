import {featureAdmissionAllowed} from './project-feature-admission.ts';
import type {ProjectFeatureAdmission} from './project-feature-admission.ts';
import React, {useEffect, useRef, useState} from 'react';
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
export default function ProjectBackupRecovery({projectId, onRestore,admission,interactionBlocked}: {readonly projectId: string; readonly onRestore: () => void; readonly admission?:ProjectFeatureAdmission;readonly interactionBlocked?:boolean}) {
  const {t} = useI18n(), [retry, setRetry] = useState(0), [phase, setPhase] = useState<'loading' | 'empty' | 'ready' | 'error'>('loading');
  const current=useRef({admission,interactionBlocked});current.current={admission,interactionBlocked};
  const key=admission?.key;const allowed=()=>!current.current.interactionBlocked&&featureAdmissionAllowed(current.current.admission,key);
  useEffect(() => {
    if(!allowed())return;
    const owner = new AbortController(); setPhase('loading');
    void createProjectHistoryClient().backups({projectId}, owner.signal).then(value => {
      if (!owner.signal.aborted&&allowed()) setPhase(value.backups.length ? 'ready' : 'empty');
    }).catch(() => {if (!owner.signal.aborted&&allowed()) setPhase('error');});
    return () => owner.abort();
  }, [projectId, retry,key,interactionBlocked]);
  if (phase === 'error') return <WorkbenchAlert tone="warning" data-testid="project-backup-recovery-error"
    actions={<WorkbenchButton disabled={!allowed()} onClick={() => {if(allowed())setRetry(value => value + 1);}}>{t('projectFile.common.retry')}</WorkbenchButton>}>
    {t('projectHistory.tabs.backups')} · {t('projectHistory.error.read')}
  </WorkbenchAlert>;
  if (phase !== 'ready') return null;
  return <WorkbenchButton data-testid="project-backup-recovery" disabled={!allowed()} onClick={()=>{if(allowed())onRestore();}}>{t('projectFile.open.invalid.restore')}</WorkbenchButton>;
}
