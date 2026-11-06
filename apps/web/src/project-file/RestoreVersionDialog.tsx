import React from 'react';
import type {ReactElement} from 'react';
import {Dialog} from '@mioon/ui/components/dialog';
import {WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent} from '@mioon/ui/components/workbench-controls';
import type {ProjectVersionDifference} from '../../../../packages/contracts/src/project-version-operations.ts';
import type {HistoryPreview} from '../project-history-runtime.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import type {ActionState, ViewState} from './types.ts';
import {versionTitle} from './VersionHistoryDialog.tsx';
import type {ProjectVersionItem} from './VersionHistoryDialog.tsx';
import './project-file-common.css';
import './project-file-versions.css';

export function historyErrorKey(code?: string) {
  if (['PROJECT_VERSION_BASELINE_CHANGED', 'PROJECT_VERSION_PREVIEW_CHANGED', 'PROJECT_VERSION_CURSOR_INVALID'].includes(code ?? '')) return 'projectHistory.error.stale';
  if (code === 'PROJECT_HOST_BUSY' || code === 'PROJECT_BACKUP_RESTORE_BUSY') return 'projectHistory.error.busy';
  if (code === 'PROJECT_FILE_EXISTS') return 'projectHistory.error.exists';
  if (['PROJECT_VERSION_NOT_FOUND', 'PROJECT_BACKUP_NOT_FOUND'].includes(code ?? '')) return 'projectHistory.error.missing';
  if (['EACCES', 'EPERM', 'EROFS', 'PROJECT_FILE_ACCESS_DENIED', 'PROJECT_ACCESS_DENIED'].includes(code ?? '')) return 'projectHistory.error.permission';
  if (['PROJECT_BACKUP_CHANGED', 'PROJECT_BACKUP_RESTORE_CHANGED', 'PROJECT_BACKUP_INDEX_INVALID'].includes(code ?? '')) return 'projectHistory.error.backupChanged';
  if (['PROJECT_LOCATION_REJECTED', 'PROJECT_LOCATION_INVALID'].includes(code ?? '')) return 'projectHistory.error.location';
  if (code === 'WORKSPACE_NATIVE_UNAVAILABLE') return 'projectHistory.error.nativeUnavailable';
  return 'projectHistory.error.rejected';
}
export function historyErrorCode(value: unknown, fallback = 'WORKSPACE_NATIVE_UNAVAILABLE'): string {
  const code = value && typeof value === 'object' && 'code' in value ? value.code : value;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : fallback;
}
const reasonMessages = {
  PROJECT_VERSION_ASSET_LOCATION_CURRENT: 'projectHistory.reason.assetLocation',
  PROJECT_VERSION_IMAGE_GROUP_FORWARD_ONLY: 'projectHistory.reason.imageGroup',
  PROJECT_VERSION_SUBJECT_VARIANT_HEAD: 'projectHistory.reason.subjectVariant',
  PROJECT_VERSION_IMAGE_GROUP_TASK_NOT_REPLAYED: 'projectHistory.reason.imageTask',
  PROJECT_VERSION_PROTECTED_RESULT_CURRENT: 'projectHistory.reason.protectedResult',
  PROJECT_VERSION_TIMELINE_HISTORY_CURRENT: 'projectHistory.reason.timelineHistory',
  PROJECT_VERSION_ANNOTATION_IDENTITY_CURRENT: 'projectHistory.reason.annotationIdentity',
  PROJECT_VERSION_BINDING_TOMBSTONE_CURRENT: 'projectHistory.reason.bindingTombstone',
  PROJECT_VERSION_PROCESS_REFERENCE_CURRENT: 'projectHistory.reason.processReference',
  PROJECT_VERSION_FOREIGN_KEY_REFERENCE_CURRENT: 'projectHistory.reason.foreignKey',
  PROJECT_VERSION_CONTENT_REFERENCE_CURRENT: 'projectHistory.reason.contentReference',
} as const;
const tableMessages = {projects: 'projectHistory.table.projects', assets: 'projectHistory.table.assets', shots: 'projectHistory.table.shots',
  versions: 'projectHistory.table.versions', timelines: 'projectHistory.table.timelines', subjects: 'projectHistory.table.subjects',
  asset_annotations: 'projectHistory.table.asset_annotations', asset_dispositions: 'projectHistory.table.asset_dispositions', asset_ranges: 'projectHistory.table.asset_ranges',
  nodes: 'projectHistory.table.nodes', edges: 'projectHistory.table.edges', subject_versions: 'projectHistory.table.subject_versions', subject_bindings: 'projectHistory.table.subject_bindings',
  image_groups: 'projectHistory.table.image_groups', image_versions: 'projectHistory.table.image_versions', scene_results: 'projectHistory.table.scene_results',
  project_lut_resources: 'projectHistory.table.project_lut_resources'} as const;
const fieldMessages = {clips: 'projectHistory.field.clips', subtitles: 'projectHistory.field.subtitles', title: 'projectHistory.field.title'} as const;
export function VersionDifferenceList({changes, testId = 'pf-restore-changes'}: {changes: readonly ProjectVersionDifference[]; testId?: string}): ReactElement {
  const {t} = useI18n();
  return <ul className="pf-rows pf-restore-changes" data-testid={testId}>{changes.map(change => <li key={JSON.stringify([change.table, change.key])}>
    <span className="pf-row-main"><span className="pf-row-title">{Object.hasOwn(tableMessages, change.table) ? t(tableMessages[change.table as keyof typeof tableMessages]) : change.table} <span className="pf-mono">{change.key}</span></span>
      <span className="pf-row-detail">{t(`projectHistory.action.${change.action}`)} · {t(change.source === 'mio' ? 'projectHistory.source.mio' : 'projectHistory.source.other')}</span>
      {change.fields.length > 0 && <span className="pf-row-detail">{t('projectHistory.fields', {fields: change.fields.map(field => Object.hasOwn(fieldMessages, field)
        ? t(fieldMessages[field as keyof typeof fieldMessages]) : field).join(t('projectFile.common.listSeparator'))})}</span>}
      {(change.reason || change.reasonCode) && <span className="pf-row-detail pf-keep-reason" data-testid="pf-restore-keep-reason">
        {change.reasonCode && Object.hasOwn(reasonMessages, change.reasonCode) ? t(reasonMessages[change.reasonCode as keyof typeof reasonMessages])
          : <>{t('projectHistory.reason.unknown')} <code>{historyErrorCode(change.reasonCode, 'PROJECT_VERSION_REASON_UNAVAILABLE')}</code></>}
      </span>}
    </span>
  </li>)}</ul>;
}
export interface RestoreVersionDialogProps {
  readonly open: boolean; readonly interactionBlocked?:boolean; readonly version: ProjectVersionItem; readonly now: Date;
  readonly preview: ViewState<HistoryPreview>; readonly restore: ActionState<'restore'>;
  readonly unknown?: boolean; readonly pendingEdits?: boolean; readonly errorCode?: string; readonly paging?: boolean;
  readonly onMore?: () => void; readonly onRestore: () => void; readonly onRetry: () => void; readonly onClose: () => void;
}
/** Confirmation uses the actual complete-plan digest, never invented attribution. */
export function RestoreVersionDialog(props: RestoreVersionDialogProps): ReactElement {
  const {t} = useI18n(), {preview, restore} = props, working = restore.kind === 'working';
  const stale = restore.kind === 'error' && !props.unknown && historyErrorKey(props.errorCode) === 'projectHistory.error.stale';
  return <Dialog open={props.open} onOpenChange={next => {if (!next && !working && !props.interactionBlocked) props.onClose();}}>
    <WorkbenchDialogContent inert={props.interactionBlocked||undefined} title={t('projectFile.versions.restore.title', {name: versionTitle(t, props.version, props.now)})} size="confirm" showCloseButton={false}
      className="pf-dialog pf-restore-dialog" data-testid="pf-restore-dialog" footer={<>
        <WorkbenchButton data-testid="pf-restore-cancel" disabled={working} onClick={props.onClose}>{t('common.cancel')}</WorkbenchButton>
        <WorkbenchButton variant="primary" data-testid="pf-restore-confirm" loading={working} disabled={working || stale || props.pendingEdits || preview.kind !== 'ready' || !preview.value.restoreAvailable}
          onClick={() => {if (!props.interactionBlocked && !working && !stale && !props.pendingEdits && preview.kind === 'ready' && preview.value.restoreAvailable) props.onRestore();}}>{t(props.unknown ? 'projectHistory.retryOriginal' : 'projectFile.versions.restore.confirm')}</WorkbenchButton>
      </>}>
      {preview.kind === 'loading' ? <div className="pf-state pf-restore-state" role="status" data-testid="pf-restore-loading"><span className="wb-spinner"/>{t('projectFile.versions.restore.loading')}</div>
        : preview.kind === 'error' ? <WorkbenchAlert tone="danger" data-testid="pf-restore-error" actions={preview.retryable ? <WorkbenchButton data-testid="pf-restore-retry" onClick={props.onRetry}>{t('projectFile.common.retry')}</WorkbenchButton> : undefined}>{t('projectHistory.error.read')}</WorkbenchAlert>
          : <><p className="pf-restore-body" data-testid="pf-restore-totals">{t('projectHistory.plan', {count: preview.value.totalChanges, kept: preview.value.keptCurrentCount})}</p>
            {preview.value.changes.length > 0 && <VersionDifferenceList changes={preview.value.changes}/>}
            {preview.value.nextCursor && <WorkbenchButton data-testid="pf-restore-more" disabled={props.paging} onClick={props.onMore}>{t('projectHistory.more')}</WorkbenchButton>}
            <p className="pf-help" data-testid="pf-restore-undo-note">{t('projectHistory.undo')}</p></>}
      {props.pendingEdits && <WorkbenchAlert tone="warning">{t('projectHistory.pendingEdits')}</WorkbenchAlert>}
      {props.unknown ? <WorkbenchAlert tone="warning" data-testid="pf-restore-unknown">{t('projectHistory.unknown')}</WorkbenchAlert>
        : restore.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-restore-failed" actions={stale ? <WorkbenchButton data-testid="pf-restore-repreview" onClick={props.onRetry}>{t('projectHistory.refreshPreview')}</WorkbenchButton> : undefined}>{t(historyErrorKey(props.errorCode))}{props.errorCode && <code>{props.errorCode}</code>}</WorkbenchAlert>}
    </WorkbenchDialogContent>
  </Dialog>;
}
