import React, {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Dialog} from '@mioon/ui/components/dialog';
import {Input} from '@mioon/ui/components/input';
import {Label} from '@mioon/ui/components/label';
import {WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent, WorkbenchTabs} from '@mioon/ui/components/workbench-controls';
import type {ProjectBackupNativeActions} from '../project-backup-native.ts';
import {projectHistoryRuntime} from '../project-history-runtime.ts';
import type {HistoryView, ProjectHistoryRuntime, ProjectHistoryState} from '../project-history-runtime.ts';
import type {ProjectBackupInspection, ProjectBackupStatus} from '../../../../packages/contracts/src/project-backups.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {useProjectFileDisplay} from './use-display.ts';
import {VersionHistoryDialog, CURRENT_VERSION} from './VersionHistoryDialog.tsx';
import {RestoreVersionDialog, VersionDifferenceList, historyErrorKey} from './RestoreVersionDialog.tsx';
import './project-file-versions.css';

export interface ProjectHistoryDialogProps {
  readonly open: boolean; readonly projectId: string; readonly projectName: string; readonly projectFile?: string;
  readonly initialTab?: 'versions' | 'backups'; readonly initialAction?: 'save'; readonly nativeBackup?: ProjectBackupNativeActions | null;
  readonly pendingEdits?: boolean;
  readonly onClose: () => void; readonly onRestored: (projectId: string) => void; readonly onOpenProject: (projectId: string) => void;
}
function ReadFailure({code, retry}: {code: string; retry: () => void}) {
  const {t} = useI18n(); return <WorkbenchAlert tone="danger" actions={<WorkbenchButton onClick={retry}>{t('projectFile.common.retry')}</WorkbenchButton>}>{t('projectHistory.error.read')} <code>{code}</code></WorkbenchAlert>;
}
function BackupStatus({value, retry, now}: {value: HistoryView<ProjectBackupStatus>; retry: () => void; now: Date}) {
  const {t} = useI18n(), display = useProjectFileDisplay();
  if (value.kind === 'loading') return <p role="status">{t('projectFile.common.loading')}</p>;
  if (value.kind === 'error') return <ReadFailure code={value.code} retry={retry}/>;
  const status = value.value;
  return <p role="status" data-testid="pf-backup-status" data-state={status.state} className={status.state === 'failed' ? 'pf-backup-failed' : 'pf-help'}>
    {status.state === 'running' ? t('projectHistory.backup.running') : status.state === 'slow' ? t('projectHistory.backup.slow')
      : status.state === 'failed' ? t('projectHistory.backup.failed', {message: status.lastError?.message ?? t('projectHistory.error.read')})
        : status.lastCompletedAt ? t('projectHistory.backup.last', {time: display.when(status.lastCompletedAt, now, true)}) : t('projectHistory.backup.none')}
  </p>;
}
const countKeys = {projects: 'projectHistory.table.projects', assets: 'projectHistory.table.assets', shots: 'projectHistory.table.shots',
  versions: 'projectHistory.table.versions', timelines: 'projectHistory.table.timelines', subjects: 'projectHistory.table.subjects'} as const;
function BackupInspection({value, now}: {value: ProjectBackupInspection; now: Date}) {
  const {t, formatNumber} = useI18n(), display = useProjectFileDisplay();
  return <><p className="pf-help">{display.when(value.createdAt, now, true)} · {t(`projectHistory.backup.${value.reason}`)}</p>
    <h3>{value.projectName ?? t('projectHistory.backup.unknownName')}</h3>
    <dl className="pf-backup-metadata"><dt>{t('projectHistory.backup.location')}</dt><dd className="pf-mono">{value.sourceProjectDir}</dd>
      <dt>{t('projectHistory.backup.size')}</dt><dd>{display.bytes(value.sizeBytes)}</dd></dl>
    <p data-testid="pf-backup-counts">{(Object.keys(countKeys) as (keyof typeof countKeys)[]).filter(key => Object.hasOwn(value.tableCounts, key))
      .map(key => `${t(countKeys[key])} ${formatNumber(value.tableCounts[key])}`).join(' · ')}</p>
    <p className="pf-help">{t('projectHistory.backup.readonly')}</p></>;
}
function MutationNotice({state, runtime}: {state: ProjectHistoryState; runtime: ProjectHistoryRuntime}) {
  const {t} = useI18n(), attempt = state.attempt;
  if (!attempt || attempt.phase === 'complete' && attempt.kind === 'backup') return null;
  const working = attempt.phase === 'working', unknown = attempt.phase === 'unknown';
  return <WorkbenchAlert tone={unknown ? 'warning' : attempt.phase === 'rejected' ? 'danger' : 'neutral'} data-testid="pf-history-attempt"
    actions={unknown ? <WorkbenchButton data-testid="pf-history-retry-original" onClick={() => {void runtime.retry();}}>{t('projectHistory.retryOriginal')}</WorkbenchButton> : !working ? <WorkbenchButton onClick={runtime.dismissAttempt}>{t('common.close')}</WorkbenchButton> : undefined}>
    {working ? t('projectHistory.pending') : unknown ? t('projectHistory.unknown') : attempt.phase === 'complete' ? t(attempt.kind === 'save' ? 'projectHistory.saved' : 'projectHistory.restored')
      : <>{t(historyErrorKey(attempt.code))} <code>{attempt.code}</code></>}
    {attempt.phase === 'complete' && attempt.kind === 'version' && attempt.result && attempt.result.keptCurrent.length > 0 && <>
      <p>{t('projectHistory.plan', {count: attempt.result.totalChanges, kept: attempt.result.keptCurrent.length})}</p>
      <VersionDifferenceList changes={attempt.result.keptCurrent} testId="pf-restore-kept-result"/>
    </>}
  </WorkbenchAlert>;
}
/** The document-local runtime retains in-flight/unknown identities while this
 * controlled view closes or another project's view takes its place. */
export function ProjectHistoryDialog(props: ProjectHistoryDialogProps) {return <HistorySession key={props.projectId} {...props}/>;}
export default ProjectHistoryDialog;
function HistorySession(props: ProjectHistoryDialogProps) {
  const {t} = useI18n(), display = useProjectFileDisplay(), runtime = useMemo(() => projectHistoryRuntime(props.projectId), [props.projectId]);
  const state = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot), now = new Date();
  const [saveOpen, setSaveOpen] = useState(false), [name, setName] = useState(''), [confirmVersion, setConfirmVersion] = useState(false), [confirmBackup, setConfirmBackup] = useState(false), [nativeError, setNativeError] = useState(false);
  const observed = useRef(new Set<string>()), live = useRef(true), current = useRef(props); current.current = props;
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  useEffect(() => {
    setSaveOpen(props.open && props.initialAction === 'save');
    if (props.open) runtime.open(props.initialTab); else runtime.close();
    return runtime.close;
  }, [runtime, props.open, props.initialTab, props.initialAction]);
  useEffect(() => {
    const attempt = state.attempt;
    if (!props.open || attempt?.phase !== 'complete' || observed.current.has(attempt.input.requestId)) return;
    observed.current.add(attempt.input.requestId);
    if (attempt.kind === 'version') {setConfirmVersion(false); props.onRestored(props.projectId);}
    if (attempt.kind === 'save') setSaveOpen(false);
    if (attempt.kind === 'backup') setConfirmBackup(false);
  }, [state.attempt, props.open, props.projectId, props.onRestored]);
  const attempt = state.attempt, working = attempt?.phase === 'working', unknown = attempt?.phase === 'unknown', locked = working || unknown || state.choosing;
  const versions = state.versions.kind === 'ready' ? state.versions.value.map(summary => ({summary})) : [];
  const chosen = versions.find(item => item.summary.id === state.selected);
  const preview = state.preview;
  const detail = preview.kind === 'loading' ? <p role="status">{t('projectFile.versions.comparing')}</p> : preview.kind === 'error' ? <ReadFailure code={preview.code} retry={() => {void runtime.select(state.selected);}}/>
    : <><p>{t('projectHistory.plan', {count: preview.value.totalChanges, kept: preview.value.keptCurrentCount})}</p>
      <VersionDifferenceList changes={preview.value.changes} testId="pf-version-runtime-diff"/>{preview.value.nextCursor && <WorkbenchButton disabled={state.paging || locked} onClick={() => {void runtime.select(state.selected, true);}}>{t('projectHistory.more')}</WorkbenchButton>}</>;
  const requestBackup = async (id: string) => {await runtime.inspect(id); if (live.current && runtime.snapshot().backupSelection === id && runtime.snapshot().inspection?.kind === 'ready') setConfirmBackup(true);};
  const backupContent = <div className="pf-backups" data-testid="pf-backups"><p className="pf-help">{t('projectHistory.backup.description')}</p>
    <BackupStatus value={state.status} retry={() => {void runtime.loadBackups();}} now={now}/>
    {state.backups.kind === 'loading' ? <p role="status">{t('projectFile.common.loading')}</p> : state.backups.kind === 'error' ? <ReadFailure code={state.backups.code} retry={() => {void runtime.loadBackups();}}/>
      : state.backups.value.length === 0 ? <p data-testid="pf-backups-empty">{t('projectHistory.backup.empty')}</p>
        : <ul className="pf-rows">{state.backups.value.map(backup => <li key={backup.backupId}><span className="pf-row-main"><strong>{display.when(backup.createdAt, now, true)}</strong>
          <span className="pf-row-detail">{t(`projectHistory.backup.${backup.reason}`)} · {display.bytes(backup.sizeBytes)}</span></span>
          <WorkbenchButton disabled={locked} onClick={() => {void runtime.inspect(backup.backupId);}}>{t('projectHistory.backup.inspect')}</WorkbenchButton>
          {props.nativeBackup && <WorkbenchButton disabled={locked} onClick={() => {void requestBackup(backup.backupId);}}>{t('projectHistory.backup.restore')}</WorkbenchButton>}
        </li>)}</ul>}
  </div>;
  const completed = attempt?.kind === 'backup' && attempt.phase === 'complete' ? attempt.result : null;
  return <>
    <VersionHistoryDialog open={props.open} projectName={props.projectName} now={now} versions={state.versions.kind === 'ready' ? {kind: 'ready', value: versions} : state.versions}
      selected={state.selected} onSelect={id => {void runtime.select(id);}} comparison={{kind: 'ready', value: []}} detail={detail}
      retention={{recent: 20, days: 7}} onSaveVersion={state.tab === 'versions' && !locked && !props.pendingEdits ? () => setSaveOpen(true) : undefined}
      onRestore={() => {if (!props.pendingEdits) setConfirmVersion(true);}} onRetry={() => {void runtime.loadVersions();}} onRetryComparison={() => {void runtime.select(state.selected);}} onClose={props.onClose}
      restoreDisabled={locked || props.pendingEdits || preview.kind !== 'ready' || !preview.value.restoreAvailable} paging={state.paging}
      onMoreVersions={state.tab === 'versions' && state.versionCursor ? () => {void runtime.loadVersions(true);} : undefined}
      toolbar={<WorkbenchTabs value={state.tab} label={t('projectFile.versions.title')} options={[{value: 'versions', label: t('projectHistory.tabs.versions'), disabled: locked}, {value: 'backups', label: t('projectHistory.tabs.backups'), disabled: locked}]}
        onValueChange={value => {if (value === 'versions' || value === 'backups') runtime.tab(value);}}/>}
      notice={<>{props.pendingEdits && state.tab === 'versions' && <WorkbenchAlert tone="warning" data-testid="pf-history-pending-edits">{t('projectHistory.pendingEdits')}</WorkbenchAlert>}<MutationNotice state={state} runtime={runtime}/></>} content={state.tab === 'backups' ? backupContent : undefined} footerNote={state.tab === 'backups' ? <span/> : undefined}/>
    {chosen && <RestoreVersionDialog open={props.open && confirmVersion} version={chosen} now={now} preview={preview}
      restore={working && attempt?.kind === 'version' ? {kind: 'working', action: 'restore'} : attempt?.kind === 'version' && ['unknown', 'rejected'].includes(attempt.phase) ? {kind: 'error', action: 'restore'} : {kind: 'idle'}}
      unknown={unknown && attempt?.kind === 'version'} pendingEdits={props.pendingEdits} errorCode={attempt?.kind === 'version' ? attempt.code : undefined} paging={state.paging}
      onMore={() => {void runtime.select(state.selected, true);}} onRestore={() => {if (unknown) {void runtime.retry();} else if (!props.pendingEdits) {void runtime.restoreVersion();}}}
      onRetry={() => {runtime.dismissAttempt(); void runtime.select(state.selected);}} onClose={() => setConfirmVersion(false)}/>}
    <Dialog open={props.open && saveOpen} onOpenChange={open => {if (!working) setSaveOpen(open);}}><WorkbenchDialogContent title={t('projectHistory.save.title')} size="confirm" footer={<>
      <WorkbenchButton disabled={working} onClick={() => setSaveOpen(false)}>{t('common.cancel')}</WorkbenchButton><WorkbenchButton variant="primary" disabled={locked || props.pendingEdits} onClick={() => {if (!props.pendingEdits) void runtime.save(name);}}>{t('projectHistory.save.title')}</WorkbenchButton></>}>
      <Label htmlFor="pf-save-name">{t('projectHistory.save.name')}</Label><Input id="pf-save-name" maxLength={150} disabled={locked} value={name} onChange={event => setName(event.target.value)}/>
      {props.pendingEdits && <WorkbenchAlert tone="warning">{t('projectHistory.pendingEdits')}</WorkbenchAlert>}
      <MutationNotice state={state} runtime={runtime}/>
    </WorkbenchDialogContent></Dialog>
    <Dialog open={props.open && state.inspection !== null && !confirmBackup && !completed} onOpenChange={open => {if (!open) runtime.closeInspection();}}>
      <WorkbenchDialogContent title={t('projectHistory.backup.title')} size="confirm" footer={<><WorkbenchButton onClick={runtime.closeInspection}>{t('common.close')}</WorkbenchButton>
        {props.nativeBackup && <WorkbenchButton variant="primary" disabled={locked || state.inspection?.kind !== 'ready'} onClick={() => setConfirmBackup(true)}>{t('projectHistory.backup.restore')}</WorkbenchButton>}</>}>
        {state.inspection?.kind === 'ready' ? <BackupInspection value={state.inspection.value} now={now}/> : state.inspection?.kind === 'error' ? <ReadFailure code={state.inspection.code} retry={() => {if (state.backupSelection) void runtime.inspect(state.backupSelection);}}/> : <p role="status">{t('projectFile.common.loading')}</p>}
      </WorkbenchDialogContent>
    </Dialog>
    <Dialog open={props.open && confirmBackup} onOpenChange={open => {if (!working && !state.choosing) setConfirmBackup(open);}}><WorkbenchDialogContent title={t('projectHistory.backup.confirm')} size="confirm" footer={<>
      <WorkbenchButton disabled={working || state.choosing} onClick={() => setConfirmBackup(false)}>{t('common.cancel')}</WorkbenchButton>
      {props.nativeBackup && <WorkbenchButton variant="primary" loading={working || state.choosing} disabled={working || state.choosing || state.inspection?.kind !== 'ready'} onClick={() => {
        if (unknown) {void runtime.retry(); return;} setNativeError(false); void runtime.chooseBackup(input => props.nativeBackup!.chooseDestination(input)).catch(() => {if (live.current) setNativeError(true);});
      }}>{t(unknown ? 'projectHistory.retryOriginal' : 'projectHistory.backup.choose')}</WorkbenchButton>}</>}>
      <p>{t('projectHistory.backup.confirmBody', {time: state.inspection?.kind === 'ready' ? display.when(state.inspection.value.createdAt, now, true) : ''})}</p>
      <MutationNotice state={state} runtime={runtime}/>{nativeError && <WorkbenchAlert tone="danger">{t('projectHistory.error.permission')}</WorkbenchAlert>}
    </WorkbenchDialogContent></Dialog>
    <Dialog open={props.open && Boolean(completed)} onOpenChange={open => {if (!open) {runtime.dismissAttempt(); runtime.closeInspection();}}}><WorkbenchDialogContent title={completed ? t('projectHistory.backup.completed', {name: completed.project.name}) : t('projectHistory.backup.title')} size="confirm" footer={<>
      <WorkbenchButton onClick={() => {runtime.dismissAttempt(); runtime.closeInspection();}}>{t('common.close')}</WorkbenchButton>
      {completed && props.nativeBackup && <WorkbenchButton onClick={() => {setNativeError(false); void props.nativeBackup!.reveal(completed).catch(() => {if (live.current) setNativeError(true);});}}>{t('projectHistory.backup.reveal')}</WorkbenchButton>}
      {completed && <WorkbenchButton variant="primary" onClick={() => current.current.onOpenProject(completed.project.projectId)}>{t('projectHistory.backup.openResult')}</WorkbenchButton>}</>}>
      {completed && <><p className="pf-mono">{completed.project.projectFile}</p><WorkbenchAlert tone="success" data-testid="pf-backup-originals-preserved">{t('projectHistory.backup.originalsPreserved')}</WorkbenchAlert></>}{nativeError && <WorkbenchAlert tone="danger">{t('projectHistory.error.permission')}</WorkbenchAlert>}
    </WorkbenchDialogContent></Dialog>
  </>;
}
