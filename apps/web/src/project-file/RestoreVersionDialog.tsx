import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import { Clapperboard, Film, Image, Layers, User } from '@mioon/ui/components/workbench-icons';
import type { ProjectRestoreChange, ProjectRestorePreview } from '../../../../packages/contracts/src/project-versions.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import Icon from '../icons.tsx';
import { ProjectFileIcon } from './project-file-icons.tsx';
import type { ActionState, ViewState } from './types.ts';
import { versionTitle } from './VersionHistoryDialog.tsx';
import type { ProjectVersionItem } from './VersionHistoryDialog.tsx';
import './project-file-common.css';
import './project-file-versions.css';

export interface RestoreVersionDialogProps {
  readonly open: boolean;
  readonly version: ProjectVersionItem;
  readonly now: Date;
  readonly preview: ViewState<ProjectRestorePreview>;
  readonly restore: ActionState<'restore'>;
  readonly onRestore: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}
type Property = ProjectRestoreChange['fields'][number]['property'];
/** Units of the numeric properties, as on Mio's change cards. The restore
 * preview carries no unit, so it follows from the property. */
const UNITS: Partial<Record<Property, 'frames' | 'seconds' | 'db' | 'pixels'>> = {
  durationFrames: 'frames', sourceInFrame: 'frames', sourceOutFrame: 'frames', startFrame: 'frames', fadeInFrames: 'frames', fadeOutFrames: 'frames',
  durationSeconds: 'seconds', gainDb: 'db', positionX: 'pixels', positionY: 'pixels', width: 'pixels', height: 'pixels',
};
const KIND_ICONS: Partial<Record<ProjectRestoreChange['kind'], ReactElement>> = {
  timeline_clip: <Film size={16} aria-hidden="true" />, timeline: <Film size={16} aria-hidden="true" />, timeline_track: <Layers size={16} aria-hidden="true" />,
  timeline_subtitle: <ProjectFileIcon name="captions" />, shot: <Clapperboard size={16} aria-hidden="true" />, asset: <Image size={16} aria-hidden="true" />,
  subject: <User size={16} aria-hidden="true" />,
};

/** Before restoring a version (12-09): what the user changed by hand since then is undone too. */
export function RestoreVersionDialog(props: RestoreVersionDialogProps): ReactElement {
  const { t, formatNumber } = useI18n();
  const { preview, restore } = props;
  const working = restore.kind === 'working';
  const value = (property: Property, number: number) => {
    const unit = UNITS[property], text = formatNumber(number, { maximumFractionDigits: 2 });
    return unit ? t(`agent.display.unit.${unit}`, { value: text }) : text;
  };
  const title = (change: ProjectRestoreChange) => {
    const kind = t(`agent.display.target.${change.kind}`);
    if (change.name === null) return kind;
    // Subtitles are named by their text, so the name is quoted.
    return t(change.kind === 'timeline_subtitle' ? 'projectFile.versions.restore.objectQuoted' : 'projectFile.versions.restore.object', { kind, name: change.name });
  };
  const detail = (change: ProjectRestoreChange) => {
    if (change.fields.length === 0) return t('projectFile.versions.restore.changedObject');
    if (change.fields.length > 1) return t('projectFile.versions.restore.changedFields', { count: change.fields.length });
    const [field] = change.fields, property = t(`agent.display.field.${field.property}`);
    return typeof field.before === 'number' && typeof field.after === 'number'
      ? t('projectFile.versions.restore.changedValue', { property, before: value(field.property, field.before), after: value(field.property, field.after) })
      : t('projectFile.versions.restore.changedField', { property });
  };
  let body: ReactNode;
  if (preview.kind === 'loading') body = <div className="pf-state pf-restore-state" role="status" data-testid="pf-restore-loading"><span className="wb-spinner" aria-hidden="true" />{t('projectFile.versions.restore.loading')}</div>;
  else if (preview.kind === 'error') body = <WorkbenchAlert tone="danger" data-testid="pf-restore-error"
    actions={preview.retryable ? <WorkbenchButton size="compact" data-testid="pf-restore-retry" onClick={props.onRetry}>{t('projectFile.common.retry')}</WorkbenchButton> : undefined}>{t('projectFile.versions.restore.error')}</WorkbenchAlert>;
  else {
    const { manualChanges, manualChangeCount, supersededMioChanges } = preview.value, more = manualChangeCount - manualChanges.length;
    body = <>
      <p className="pf-restore-body">{manualChangeCount > 0 ? t('projectFile.versions.restore.body', { count: manualChangeCount }) : t('projectFile.versions.restore.bodyNoManual')}</p>
      {manualChanges.length > 0 && <ul className="pf-rows pf-restore-changes" data-testid="pf-restore-changes">{manualChanges.map(change => <li key={`${change.kind}:${change.id}`}>
        <span className="pf-row-icon">{KIND_ICONS[change.kind] ?? <Icon name="pencil" size={16} />}</span>
        <span className="pf-row-main"><span className="pf-row-title">{title(change)}</span><span className="pf-row-detail pf-mono">{detail(change)}</span></span>
      </li>)}</ul>}
      {more > 0 && <p className="pf-help" data-testid="pf-restore-more">{t('projectFile.versions.restore.more', { count: more })}</p>}
      {supersededMioChanges > 0 && <p className="pf-help" data-testid="pf-restore-superseded">{t(props.version.summary.trigger === 'mio-turn' ? 'projectFile.versions.restore.supersededTurn' : 'projectFile.versions.restore.superseded')}</p>}
      {restore.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-restore-failed">{t('projectFile.versions.restore.failed')}</WorkbenchAlert>}
    </>;
  }
  return <Dialog open={props.open} onOpenChange={next => { if (!next && !working) props.onClose(); }}>
    <WorkbenchDialogContent title={t('projectFile.versions.restore.title', { name: versionTitle(t, props.version, props.now) })} size="confirm" showCloseButton={false}
      className="pf-dialog pf-restore-dialog" data-testid="pf-restore-dialog" footer={<>
        <WorkbenchButton data-testid="pf-restore-cancel" disabled={working} onClick={props.onClose}>{t('common.cancel')}</WorkbenchButton>
        <WorkbenchButton variant="primary" data-testid="pf-restore-confirm" loading={working} disabled={preview.kind !== 'ready'} onClick={props.onRestore}>{t('projectFile.versions.restore.confirm')}</WorkbenchButton>
      </>}>
      {body}
    </WorkbenchDialogContent>
  </Dialog>;
}
