import React, {useRef} from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import { WorkbenchIcon } from '@mioon/ui/components/workbench-icons';
import type {ProjectOpenIssue} from './project-open-issue.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { fileNameOf, revealLabelKey, stemOf } from './format.ts';
import type { ActionState, HostPlatform } from './types.ts';
import './project-file-common.css';
import './project-file-home.css';

export type ProjectOpenFailureAction = 'locate' | 'remove' | 'restore' | 'reveal' | 'update' | 'retry' | 'openOriginal' | 'adoptCopy' | 'copyTo' | 'systemSettings' | 'chooseLocation' | 'closeProject' | 'recheck';
export type ProjectOpenFailureActionState = ActionState<ProjectOpenFailureAction> | {readonly kind: 'unknown'; readonly action: ProjectOpenFailureAction};
export interface ProjectOpenFailureDialogProps {
  readonly open: boolean;
  readonly failure: ProjectOpenIssue;
  /** The name in the registry; without one the file name without `.mioon` is shown. */
  readonly projectName: string | null;
  /** @deprecated Ignored. Staged results are not unfinished generation tasks. */
  readonly inboxCount?: number;
  /** Undefined remains unknown; a confirmed zero is needed to enable removal. */
  readonly waitingTaskCount?: number;
  readonly action: ProjectOpenFailureActionState;
  readonly platform: HostPlatform;
  readonly onLocate?: () => void;
  readonly onRemove?: () => void;
  readonly onCheckUpdate?: () => void;
  readonly onRestoreBackup?: () => void;
  /** Read-only location only: show the file in the file manager. */
  readonly onReveal?: () => void;
  readonly onRetry?: () => void;
  readonly onOpenOriginal?: () => void;
  readonly onAdoptCopy?: () => void;
  /** Uses the shared system save panel, with the project name as the default;
   * the trusted owner selects a destination without overwriting a file. */
  readonly onCopyTo?: () => void;
  readonly onOpenSystemSettings?: () => void;
  readonly onChooseLocation?: () => void;
  readonly onCloseProject?: () => void;
  readonly onRecheck?: () => void;
  readonly onClose: () => void;
}

/** Controlled opening issues (12-03 to 12-03i). Data and capabilities come
 * from a verified owner; the view never observes files or invents native ports. */
export function ProjectOpenFailureDialog(props: ProjectOpenFailureDialogProps): ReactElement {
  const { t } = useI18n();
  const { failure, action } = props;
  const current = useRef(props); current.current = props;
  const working = action.kind === 'working', locked = working || action.kind === 'unknown';
  const name = props.projectName ?? (failure.projectFile ? stemOf(failure.projectFile) : t('projectFile.open.unknownName'));
  const callbacks = (value: ProjectOpenFailureDialogProps): Record<ProjectOpenFailureAction, (() => void) | undefined> => ({locate: value.onLocate, remove: value.onRemove,
    restore: value.onRestoreBackup, reveal: value.onReveal, update: value.onCheckUpdate, retry: value.onRetry, openOriginal: value.onOpenOriginal,
    adoptCopy: value.onAdoptCopy, copyTo: value.onCopyTo, systemSettings: value.onOpenSystemSettings, chooseLocation: value.onChooseLocation, closeProject: value.onCloseProject, recheck: value.onRecheck});
  const count = props.waitingTaskCount;
  const removable = Number.isSafeInteger(count) && count === 0;
  const run = (kind: ProjectOpenFailureAction, label: string, onClick: (() => void) | undefined, primary = false) => {
    if (!onClick) return null;
    const disabled = (locked && !(action.kind === 'unknown' && kind === 'recheck')) || kind === 'remove' && !removable;
    const title = kind === 'remove' && !removable ? t(count !== undefined && count > 0 ? 'projectFile.home.menu.waitingHelp' : 'projectFile.home.waitingUnavailable') : undefined;
    return <WorkbenchButton key={kind} variant={primary ? 'primary' : 'secondary'} title={title} data-testid={`pf-open-${kind}`} loading={working && action.action === kind} disabled={disabled} onClick={() => {
      const next = current.current;
      if (!next.open || next.failure !== failure || next.action.kind === 'working' || next.action.kind === 'unknown' && kind !== 'recheck' || kind === 'remove' && next.waitingTaskCount !== 0) return;
      callbacks(next)[kind]?.();
    }}>{label}</WorkbenchButton>;
  };
  const close = (label: string, primary = false) =>
    <WorkbenchButton key="close" variant={primary ? 'primary' : 'secondary'} data-testid="pf-open-close" disabled={locked} onClick={() => {const next = current.current; if (next.open && next.action.kind !== 'working' && next.action.kind !== 'unknown') next.onClose();}}>{label}</WorkbenchButton>;
  let title: string, body: ReactNode, buttons: ReactNode;
  switch (failure.code) {
    case 'PROJECT_MISSING':
      title = t('projectFile.open.missing.title', { name });
      body = Number.isSafeInteger(count) && count! > 0
        ? <span data-testid="pf-open-waiting">{t('projectFile.open.missing.bodyWithTasks', { path: failure.projectFile, count: count! })}</span>
        : t('projectFile.open.missing.body', { path: failure.projectFile });
      buttons = <>{close(t('common.close'), !props.onLocate)}{run('remove', t('projectFile.open.missing.remove'), props.onRemove)}{run('locate', t('projectFile.home.locate'), props.onLocate, true)}</>;
      break;
    case 'PROJECT_LOCKED':
      title = t('projectFile.open.locked.title', { name });
      body = t('projectFile.open.locked.body');
      buttons = close(t('projectFile.open.locked.ok'), true);
      break;
    case 'PROJECT_FORMAT_NEWER': {
      // Only the project file's own format is "this file"; history and cache are this computer's records.
      const records = failure.database !== 'project';
      const versions = { format: failure.formatVersion, supported: failure.supportedFormatVersion };
      title = t(records ? 'projectFile.open.newerRecords.title' : 'projectFile.open.newer.title');
      body = Number.isSafeInteger(versions.format) && Number.isSafeInteger(versions.supported) && versions.supported > 0 && versions.format > versions.supported
        ? t(records ? 'projectFile.open.newerRecords.body' : 'projectFile.open.newer.body', versions) : t('projectFile.open.unavailable.body');
      buttons = <>{close(t('common.close'), !props.onCheckUpdate)}{props.onCheckUpdate && run('update', t('projectFile.open.newer.checkUpdate'), props.onCheckUpdate, true)}</>;
      break;
    }
    case 'PROJECT_INVALID': {
      title = t('projectFile.open.invalid.title', { file: fileNameOf(failure.projectFile) });
      if (failure.reason === 'read-only') {
        title = t('projectFile.open.readOnly.title', {name});
        body = t('projectFile.open.readOnly.body');
        buttons = <>{close(t('common.close'), !props.onReveal && !props.onCopyTo)}{run('reveal', t(revealLabelKey(props.platform)), props.onReveal, !props.onCopyTo)}{run('copyTo', t('projectFile.open.copyTo'), props.onCopyTo, true)}</>;
      } else {
        body = t(props.onRestoreBackup ? 'projectFile.open.invalid.bodyWithBackup' : 'projectFile.open.invalid.body');
        buttons = <>{close(t('common.close'), !props.onRestoreBackup)}{props.onRestoreBackup && run('restore', t('projectFile.open.invalid.restore'), props.onRestoreBackup, true)}</>;
      }
      break;
    }
    case 'PROJECT_FILE_COPY':
      title = t('projectFile.open.copy.title', {name});
      body = <span className="pf-open-copy"><span>{t('projectFile.open.copy.intro')}</span><span className="pf-open-path" data-testid="pf-open-original-path">{failure.originalProjectFile}</span><span>{t('projectFile.open.copy.body')}</span></span>;
      buttons = <>{close(t('common.cancel'))}{run('openOriginal', t('projectFile.open.copy.openOriginal'), props.onOpenOriginal, !props.onAdoptCopy)}{run('adoptCopy', t('projectFile.open.copy.adopt'), props.onAdoptCopy, true)}</>;
      break;
    case 'PROJECT_FILE_MOVED': {
      title = t('projectFile.open.moved.title', {name});
      const reason = t(failure.reason === 'access-denied' ? 'projectFile.open.moved.access' : failure.reason === 'disk-disconnected' ? 'projectFile.open.moved.disk' : 'projectFile.open.moved.missing');
      body = failure.writeRejected === true ? t('projectFile.open.moved.body', {reason}) : t('projectFile.open.unavailable.body');
      buttons = <>{props.onCloseProject ? run('closeProject', t('projectFile.open.moved.closeProject'), props.onCloseProject) : close(t('common.close'))}{run('locate', t('projectFile.home.locate'), props.onLocate, true)}</>;
      break;
    }
    case 'PROJECT_ACCESS_DENIED': {
      title = t('projectFile.open.access.title', {name});
      body = <span className="pf-open-access"><span>{t(props.platform === 'mac' ? 'projectFile.open.access.mac' : 'projectFile.open.access.system')}</span>
        {props.platform === 'mac' && <span role="list"><span role="listitem">{t('projectFile.open.access.macSettings')}</span><span role="listitem">{t('projectFile.open.access.folder')}</span></span>}
        <span>{t(failure.context === 'create' ? 'projectFile.open.access.choose' : 'projectFile.open.access.retry')}</span></span>;
      buttons = <><span className="pf-open-system-action">{run('systemSettings', t('projectFile.open.access.settings'), props.onOpenSystemSettings)}</span>{close(t(failure.context === 'create' ? 'common.cancel' : 'common.close'))}
        {failure.context === 'create' ? run('chooseLocation', t('projectFile.open.access.otherLocation'), props.onChooseLocation, true) : run('retry', t('projectFile.common.retry'), props.onRetry, true)}</>;
      break;
    }
    case 'NETWORK_LOCATION':
      title = t('projectFile.open.network.title', {name}); body = t('projectFile.open.network.body');
      buttons = <>{close(t('common.close'), !props.onCopyTo)}{run('copyTo', t('projectFile.open.copyTo'), props.onCopyTo, true)}</>;
      break;
    case 'OPEN_UNAVAILABLE':
      title = t('projectFile.open.unavailable.title', {name}); body = t('projectFile.open.unavailable.body');
      buttons = <>{close(t('common.close'), !props.onRetry)}{run('retry', t('projectFile.common.retry'), props.onRetry, true)}</>;
      break;
  }
  return <Dialog open={props.open} onOpenChange={next => {const value = current.current; if (!next && value.action.kind !== 'working' && value.action.kind !== 'unknown') value.onClose(); }}>
    <WorkbenchDialogContent title={title} description={body} size="confirm" showCloseButton={false} className="pf-dialog pf-open-dialog" data-testid="pf-open-dialog" data-code={failure.code} footer={buttons}>
      {action.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-open-error" icon={<WorkbenchIcon name="warning" size={16} />}>{t(`projectFile.open.failed.${action.action}`)}</WorkbenchAlert>}
      {action.kind === 'unknown' && <WorkbenchAlert tone="warning" data-testid="pf-open-unknown">{t('projectFile.open.outcomeUnknown')}{run('recheck', t('projectFile.create.recheck'), props.onRecheck, true)}</WorkbenchAlert>}
    </WorkbenchDialogContent>
  </Dialog>;
}
