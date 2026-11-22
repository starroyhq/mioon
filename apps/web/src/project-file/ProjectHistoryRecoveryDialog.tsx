import {useEffect, useRef, useState} from 'react';
import {Dialog} from '@mioon/ui/components/dialog';
import {WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent} from '@mioon/ui/components/workbench-controls';
import type {ProjectHistoryResolveResult, ProjectHistoryStatus} from '../../../../packages/contracts/src/project-history-recovery.ts';
import type {ProjectVersionPreviewResponse} from '../../../../packages/contracts/src/project-version-operations.ts';
import type {ProjectVersionSummary} from '../../../../packages/contracts/src/project-versions.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import type {ProjectHistoryRecoveryClient} from '../project-history-recovery-client.ts';
import {ProjectHistoryRecoveryError, projectHistoryRecoveryClient} from '../project-history-recovery-client.ts';
import {displayPath} from './format.ts';
import {ProjectFileIcon} from './project-file-icons.tsx';
import './project-file-common.css';
import './project-history-recovery.css';

export interface ProjectHistoryRecoveryDialogProps {
  readonly projectId: string;
  readonly projectName: string | null;
  readonly projectFile: string | null;
  readonly homeDirectory?: string | null;
  readonly onClose: () => void;
  readonly onResolved: (result: ProjectHistoryResolveResult) => void;
  /** The file or local records changed between reading the status and confirming. */
  readonly onStale?: () => void;
  /** Test-only deterministic client and first page. */
  readonly client?: ProjectHistoryRecoveryClient;
  readonly initialStatus?: ProjectHistoryStatus;
  readonly initialVersions?: readonly ProjectVersionSummary[];
  readonly initialPreview?: ProjectVersionPreviewResponse;
  /** Test-only first card. */
  readonly initialView?: 'confirm' | 'versions';
}

type RecoveryPhase = {kind: 'loading'} | {kind: 'ready'} | {kind: 'error'} | {kind: 'resolving'; action: 'continue' | 'restore-version'};

export function ProjectHistoryRecoveryDialog(props: ProjectHistoryRecoveryDialogProps) {
  const {t, formatDate} = useI18n();
  const client = props.client ?? projectHistoryRecoveryClient;
  const first = props.initialVersions?.[0]?.id ?? null;
  const [phase, setPhase] = useState<RecoveryPhase>(props.initialStatus ? {kind: 'ready'} : {kind: 'loading'});
  const [status, setStatus] = useState<ProjectHistoryStatus | null>(props.initialStatus ?? null);
  const [view, setView] = useState<'confirm' | 'versions'>(props.initialView ?? 'confirm');
  const [versions, setVersions] = useState<readonly ProjectVersionSummary[] | null>(props.initialVersions ?? null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(first);
  const [previews, setPreviews] = useState<Record<string, ProjectVersionPreviewResponse>>(props.initialPreview && first ? {[first]: props.initialPreview} : {});
  const [previewErrors, setPreviewErrors] = useState<Record<string, true>>({});
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => {alive.current = false;}, []);
  useEffect(() => {
    if (props.initialStatus) return;
    let cancelled = false;
    void client.status(props.projectId).then(next => {
      if (!cancelled && alive.current) {setStatus(next); setPhase({kind: 'ready'});}
    }).catch(() => {if (!cancelled && alive.current) setPhase({kind: 'error'});});
    return () => {cancelled = true;};
  }, [client, props.initialStatus, props.projectId]);
  const readPreview = async (versionId: string): Promise<ProjectVersionPreviewResponse | null> => {
    if (previews[versionId]) return previews[versionId];
    if (previewErrors[versionId]) return null;
    setPreviewing(versionId); setNotice(null);
    try {
      const next = await client.preview(props.projectId, versionId);
      if (alive.current) setPreviews(current => ({...current, [versionId]: next}));
      return next;
    } catch {
      if (alive.current) setPreviewErrors(current => ({...current, [versionId]: true}));
      return null;
    } finally {if (alive.current) setPreviewing(null);}
  };
  const choose = (versionId: string): void => {setSelected(versionId); void readPreview(versionId);};
  const loadVersions = async (): Promise<void> => {
    if (!status) return;
    setView('versions'); setNotice(null);
    if (versions) {if (!selected && versions[0]) choose(versions[0].id); return;}
    setVersionsLoading(true);
    try {
      const listed = await client.versions(props.projectId);
      const candidates = listed.versions;
      // A version is offered only when this history can preview a restore from it.
      const restorable: ProjectVersionSummary[] = [];
      for (const version of candidates) {
        if (status.recoverableVersionCount === candidates.length) {restorable.push(version); continue;}
        const preview = await readPreview(version.id);
        if (preview) restorable.push(version);
      }
      if (!alive.current) return;
      setVersions(restorable);
      const latest = restorable[0];
      setSelected(latest?.id ?? null);
      if (latest) void readPreview(latest.id);
    } catch {
      if (alive.current) setNotice(t('projectFile.historyRecovery.versionsUnavailable'));
    } finally {if (alive.current) setVersionsLoading(false);}
  };
  const resolve = async (action: 'continue' | 'restore-version'): Promise<void> => {
    if (!status || phase.kind === 'resolving') return;
    const preview = selected ? previews[selected] : undefined;
    if (action === 'restore-version' && (!selected || !preview)) return;
    setPhase({kind: 'resolving', action}); setNotice(null);
    try {
      const base = {projectId: props.projectId, requestId: crypto.randomUUID(), expected: status.file,
        historyIdentity: status.historyIdentity, confirmationDigest: status.confirmationDigest};
      const result = await client.resolve(action === 'continue' ? {...base, action: 'continue'}
        : {...base, action: 'restore-version', versionId: selected!, previewDigest: preview!.previewDigest});
      if (alive.current) props.onResolved(result);
    } catch (error) {
      if (!alive.current) return;
      setPhase({kind: 'ready'});
      if (errorCode(error) === 'PROJECT_HISTORY_BASELINE_CHANGED') {
        if (props.onStale) props.onStale(); else setNotice(t('projectFile.historyRecovery.stale'));
      } else setNotice(t('projectFile.historyRecovery.failed'));
    }
  };
  const name = props.projectName ?? t('projects.project');
  const busy = phase.kind === 'resolving';
  const selectedPreview = selected ? previews[selected] : undefined;
  const selectedFailed = selected ? Boolean(previewErrors[selected]) : false;
  const selectedComparePending = Boolean(selected) && (previewing === selected || !selectedPreview && !selectedFailed);
  const closeButton = <WorkbenchButton data-testid="pf-history-recovery-close" disabled={busy} onClick={props.onClose}>{t('common.close')}</WorkbenchButton>;
  const footer = phase.kind === 'error'
    ? <div className="pf-history-recovery-footer">{[closeButton, <WorkbenchButton key="retry" data-testid="pf-history-recovery-retry" disabled={busy}
        onClick={() => {setPhase({kind: 'loading'}); void client.status(props.projectId).then(next => {setStatus(next); setPhase({kind: 'ready'});})
          .catch(() => setPhase({kind: 'error'}));}}>{t('projectFile.common.retry')}</WorkbenchButton>]}</div>
    : view === 'versions'
      ? <div className="pf-history-recovery-footer">
          <WorkbenchButton data-testid="pf-history-recovery-back" disabled={busy} onClick={() => {setView('confirm'); setNotice(null);}}>{t('projectFile.historyRecovery.back')}</WorkbenchButton>
          <WorkbenchButton variant="primary" data-testid="pf-history-recovery-restore-version" disabled={busy || !selectedPreview || previewing === selected}
            loading={phase.kind === 'resolving' && phase.action === 'restore-version'}
            onClick={() => void resolve('restore-version')}>{t('projectFile.historyRecovery.restoreVersion')}</WorkbenchButton>
        </div>
      : <div className="pf-history-recovery-footer">
          {closeButton}
          {status && status.recoverableVersionCount > 0 && <WorkbenchButton data-testid="pf-history-recovery-restore" disabled={busy}
            onClick={() => void loadVersions()}>{t('projectFile.historyRecovery.restore')}</WorkbenchButton>}
          <WorkbenchButton variant="primary" data-testid="pf-history-recovery-continue" disabled={busy || !status}
            loading={phase.kind === 'resolving' && phase.action === 'continue'} onClick={() => void resolve('continue')}>
            {t('projectFile.historyRecovery.continue')}</WorkbenchButton>
        </div>;
  const path = props.projectFile ? displayPath(props.projectFile, props.homeDirectory) : null;
  return <Dialog open onOpenChange={next => {if (!next && !busy) props.onClose();}}>
    <WorkbenchDialogContent size="standard" className="pf-dialog pf-history-recovery" showCloseButton={false} data-testid="pf-history-recovery"
      data-view={view}
      title={view === 'versions' ? t('projectFile.historyRecovery.versionsTitle', {name}) : t('projectFile.historyRecovery.title', {name})}
      footer={footer}>
      {view === 'confirm' ? <>
        {path && <div className="pf-history-recovery-path" data-testid="pf-history-recovery-path">
          <ProjectFileIcon name="file" size={16} /><span className="pf-mono">{path}</span></div>}
        <p className="pf-history-recovery-copy">{t('projectFile.historyRecovery.reason')}</p>
        <p className="pf-history-recovery-copy">{t('projectFile.historyRecovery.consequence')}</p>
        {phase.kind === 'loading' && <p className="pf-history-recovery-loading" role="status">{t('projectFile.historyRecovery.loading')}</p>}
        {phase.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-history-recovery-error">{t('projectFile.historyRecovery.loadFailed')}</WorkbenchAlert>}
        {status && status.unknownProviderTasks > 0 && <WorkbenchAlert tone="warning" data-testid="pf-history-recovery-warning">
          {t('projectFile.historyRecovery.unknownTasks', {count: status.unknownProviderTasks})}</WorkbenchAlert>}
      </> : <>
        {versionsLoading && <p className="pf-history-recovery-loading" role="status">{t('projectFile.historyRecovery.loadingVersions')}</p>}
        {versions && versions.length === 0 && <p className="pf-history-recovery-copy" data-testid="pf-history-recovery-no-versions">{t('projectFile.historyRecovery.noVersions')}</p>}
        {versions && versions.length > 0 && <ul className="pf-history-recovery-versions" role="radiogroup" aria-label={t('projectFile.historyRecovery.versionsList')}>
          {versions.map(version => <li key={version.id} data-selected={selected === version.id ? '' : undefined}>
            <label>
              <input type="radio" name="pf-history-recovery-version" checked={selected === version.id} disabled={busy}
                onChange={() => choose(version.id)} data-testid={`pf-history-recovery-version-${version.id}`} />
              <span className="pf-history-recovery-version-name">{versionLabel(t, version)}</span>
              <time>{formatDate(version.createdAt, {month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'})}</time>
            </label>
          </li>)}
        </ul>}
        {versions && versions.length > 0 && <p className="pf-history-recovery-compare" role="status" data-testid="pf-history-recovery-compare">
          {selectedComparePending ? t('projectFile.historyRecovery.comparing')
            : selectedPreview ? t('projectFile.historyRecovery.differences', {count: selectedPreview.totalChanges})
              : t('projectFile.historyRecovery.compareUnavailable')}</p>}
        <p className="pf-history-recovery-copy">{t('projectFile.historyRecovery.restoreConsequence')}</p>
      </>}
      {notice && <WorkbenchAlert tone="danger" data-testid="pf-history-recovery-notice">{notice}</WorkbenchAlert>}
    </WorkbenchDialogContent>
  </Dialog>;
}

function versionLabel(t: ReturnType<typeof useI18n>['t'], version: ProjectVersionSummary): string {
  switch (version.trigger) {
    case 'manual': return version.name ?? t('projectFile.historyRecovery.untitledVersion');
    case 'daily-open': return t('projectFile.historyRecovery.version.dailyOpen');
    case 'mio-turn': return t('projectFile.historyRecovery.version.mioTurn');
    case 'restore': return t('projectFile.historyRecovery.version.beforeRestore');
    case 'bulk-change': return t('projectFile.historyRecovery.version.beforeChange');
  }
}
function errorCode(error: unknown): string {
  if (error instanceof ProjectHistoryRecoveryError) return error.code;
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'BACKEND_UNAVAILABLE';
}
