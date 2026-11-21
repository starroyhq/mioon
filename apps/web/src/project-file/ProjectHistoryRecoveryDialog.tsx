import React, {useEffect, useRef, useState} from 'react';
import {Dialog} from '@mioon/ui/components/dialog';
import {WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent} from '@mioon/ui/components/workbench-controls';
import {Layers, WorkbenchIcon} from '@mioon/ui/components/workbench-icons';
import type {ProjectHistoryResolveResult, ProjectHistoryStatus} from '../../../../packages/contracts/src/project-history-recovery.ts';
import type {ProjectVersionListResponse, ProjectVersionPreviewResponse} from '../../../../packages/contracts/src/project-version-operations.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import type {ProjectHistoryRecoveryClient} from '../project-history-recovery-client.ts';
import {ProjectHistoryRecoveryError, projectHistoryRecoveryClient} from '../project-history-recovery-client.ts';
import './project-file-common.css';
import './project-history-recovery.css';

export interface ProjectHistoryRecoveryDialogProps {
  readonly projectId: string;
  readonly projectName: string | null;
  readonly onClose: () => void;
  readonly onResolved: (result: ProjectHistoryResolveResult) => void;
  /** Test-only deterministic client and preloaded first page. */
  readonly client?: ProjectHistoryRecoveryClient;
  readonly initialStatus?: ProjectHistoryStatus;
  readonly initialVersions?: ProjectVersionListResponse;
}

type RecoveryPhase = {kind: 'loading'} | {kind: 'ready'} | {kind: 'error'; code: string} |
  {kind: 'resolving'; action: 'continue' | 'restore-version'};

const reasonKey = (reason: ProjectHistoryStatus['reason']): 'file-sequence-smaller' | 'file-sequence-larger' | 'content-token-different' | 'legacy-token-missing' => {
  if (reason === 'file-sequence-smaller' || reason === 'file-sequence-larger' || reason === 'content-token-different' || reason === 'legacy-token-missing') return reason;
  return 'content-token-different';
};

export function ProjectHistoryRecoveryDialog(props: ProjectHistoryRecoveryDialogProps) {
  const {t, formatDate} = useI18n();
  const client = props.client ?? projectHistoryRecoveryClient;
  const [phase, setPhase] = useState<RecoveryPhase>(props.initialStatus ? {kind: 'ready'} : {kind: 'loading'});
  const [status, setStatus] = useState<ProjectHistoryStatus | null>(props.initialStatus ?? null);
  const [versions, setVersions] = useState<ProjectVersionListResponse | null>(props.initialVersions ?? null);
  const [showVersions, setShowVersions] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProjectVersionPreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => {alive.current = false;}, []);
  useEffect(() => {
    if (props.initialStatus) return;
    let cancelled = false;
    void client.status(props.projectId).then(next => {
      if (!cancelled && alive.current) {setStatus(next); setPhase({kind: 'ready'});}
    }).catch((error: unknown) => {
      if (!cancelled && alive.current) setPhase({kind: 'error', code: errorCode(error)});
    });
    return () => {cancelled = true;};
  }, [client, props.initialStatus, props.projectId]);
  const loadVersions = async (): Promise<void> => {
    setShowVersions(true);
    if (versions) return;
    try {const next = await client.versions(props.projectId); if (alive.current) setVersions(next);}
    catch (error) {if (alive.current) setNotice(t('projectFile.historyRecovery.versionsUnavailable'));}
  };
  const chooseVersion = async (versionId: string): Promise<void> => {
    setSelected(versionId); setPreview(null); setPreviewBusy(true); setNotice(null);
    try {const next = await client.preview(props.projectId, versionId); if (alive.current) setPreview(next);}
    catch (error) {if (alive.current) setNotice(t('projectFile.historyRecovery.previewUnavailable'));}
    finally {if (alive.current) setPreviewBusy(false);}
  };
  const resolve = async (action: 'continue' | 'restore-version'): Promise<void> => {
    if (!status || phase.kind === 'resolving') return;
    if (action === 'restore-version' && (!selected || !preview)) return;
    setPhase({kind: 'resolving', action}); setNotice(null);
    try {
      const base = {projectId: props.projectId, requestId: crypto.randomUUID(), expected: status.file,
        historyIdentity: status.historyIdentity, confirmationDigest: status.confirmationDigest};
      const result = await client.resolve(action === 'continue' ? {...base, action: 'continue'}
        : {...base, action: 'restore-version', versionId: selected!, previewDigest: preview!.previewDigest});
      if (alive.current) props.onResolved(result);
    } catch (error) {
      if (alive.current) {
        setPhase({kind: 'ready'});
        setNotice(errorCode(error) === 'PROJECT_HISTORY_BASELINE_CHANGED'
          ? t('projectFile.historyRecovery.stale') : t('projectFile.historyRecovery.failed'));
      }
    }
  };
  const name = props.projectName ?? t('projects.project');
  const busy = phase.kind === 'resolving';
  const footer = phase.kind === 'error'
    ? <><WorkbenchButton data-testid="pf-history-recovery-retry" onClick={() => {setPhase({kind: 'loading'}); void client.status(props.projectId)
        .then(next => {setStatus(next); setPhase({kind: 'ready'});}).catch(error => setPhase({kind: 'error', code: errorCode(error)}));}}>{t('projectFile.common.retry')}</WorkbenchButton>
      <WorkbenchButton data-testid="pf-history-recovery-close" onClick={props.onClose}>{t('common.close')}</WorkbenchButton></>
    : showVersions
      ? <><WorkbenchButton disabled={busy || previewBusy || !selected || !preview} loading={phase.kind === 'resolving' && phase.action === 'restore-version'}
          data-testid="pf-history-recovery-restore-version" variant="primary" onClick={() => void resolve('restore-version')}>{t('projectFile.historyRecovery.restoreSelected')}</WorkbenchButton>
        <WorkbenchButton data-testid="pf-history-recovery-back" disabled={busy} onClick={() => {setShowVersions(false); setSelected(null); setPreview(null);}}>{t('projectFile.historyRecovery.back')}</WorkbenchButton>
        <WorkbenchButton data-testid="pf-history-recovery-close" disabled={busy} onClick={props.onClose}>{t('common.close')}</WorkbenchButton></>
      : <><WorkbenchButton disabled={busy || !status} data-testid="pf-history-recovery-continue"
          onClick={() => void resolve('continue')}>{t('projectFile.historyRecovery.continue')}</WorkbenchButton>
        <WorkbenchButton disabled={busy || !status} data-testid="pf-history-recovery-restore" onClick={() => void loadVersions()}>{t('projectFile.historyRecovery.restore')}</WorkbenchButton>
        <WorkbenchButton data-testid="pf-history-recovery-close" disabled={busy} onClick={props.onClose}>{t('common.close')}</WorkbenchButton></>;
  return <Dialog open onOpenChange={next => {if (!next && !busy) props.onClose();}}>
    <WorkbenchDialogContent size="confirm" className="pf-dialog pf-history-recovery" showCloseButton={false} data-testid="pf-history-recovery"
      title={<><span className="pf-history-recovery-icon"><WorkbenchIcon name="warning" size={18} /></span>{t('projectFile.historyRecovery.title', {name})}</>}
      description={t('projectFile.historyRecovery.body')} footer={footer}>
      {phase.kind === 'loading' && <p className="pf-history-recovery-loading" role="status">{t('projectFile.historyRecovery.loading')}</p>}
      {phase.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-history-recovery-error">{t('projectFile.historyRecovery.loadFailed')}</WorkbenchAlert>}
      {status && phase.kind !== 'error' && <>
        <div className="pf-history-recovery-pairs">
          <span>{t('projectFile.historyRecovery.file', {sequence: status.file.contentSequence})}</span>
          <span>{t('projectFile.historyRecovery.records', {sequence: status.seen.contentSequence})}</span>
          <span>{t(`projectFile.historyRecovery.reason.${reasonKey(status.reason)}`)}</span>
        </div>
        <div className="pf-history-recovery-counts">
          <span>{t('projectFile.historyRecovery.versionCount', {count: status.versionCount})}</span>
          <span>{t('projectFile.historyRecovery.recoverableCount', {count: status.recoverableVersionCount})}</span>
          <span>{t('projectFile.historyRecovery.unknownTasks', {count: status.unknownProviderTasks})}</span>
        </div>
        <WorkbenchAlert tone="warning" data-testid="pf-history-recovery-warning">
          <span>{t('projectFile.historyRecovery.archive')}</span>
          {status.unknownProviderTasks > 0 && <span>{t('projectFile.historyRecovery.unknownTasksDetail')}</span>}
        </WorkbenchAlert>
        {showVersions && <section className="pf-history-recovery-versions" aria-label={t('projectFile.historyRecovery.versionsTitle')}>
          <h3>{t('projectFile.historyRecovery.versionsTitle')}</h3>
          {!versions ? <p role="status">{t('projectFile.historyRecovery.loading')}</p> : versions.versions.length === 0
            ? <p>{t('projectFile.historyRecovery.noVersions')}</p>
            : <ul>{versions.versions.map(version => <li key={version.id}>
              <label><input type="radio" name="history-version" disabled={busy} checked={selected === version.id}
                onChange={() => void chooseVersion(version.id)} data-testid={`pf-history-recovery-version-${version.id}`} />
                <span>{version.name ?? t('projectFile.historyRecovery.untitledVersion')}</span><time>{formatDate(version.createdAt, {dateStyle: 'medium', timeStyle: 'short'})}</time></label>
              {selected === version.id && <span className="pf-history-recovery-preview" role="status">{previewBusy ? t('projectFile.historyRecovery.previewLoading')
                : preview ? t('projectFile.historyRecovery.preview', {count: preview.totalChanges}) : t('projectFile.historyRecovery.previewUnavailable')}</span>}
            </li>)}</ul>}
        </section>}
      </>}
      {notice && <WorkbenchAlert tone="danger" data-testid="pf-history-recovery-notice">{notice}</WorkbenchAlert>}
      <p className="pf-history-recovery-hint"><Layers size={14} aria-hidden="true" />{t('projectFile.historyRecovery.hint')}</p>
    </WorkbenchDialogContent>
  </Dialog>;
}

function errorCode(error: unknown): string {
  if (error instanceof ProjectHistoryRecoveryError) return error.code;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
  return code ?? 'BACKEND_UNAVAILABLE';
}
