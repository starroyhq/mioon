import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import { WorkbenchIcon } from '@mioon/ui/components/workbench-icons';
import type { ProjectOpenFailure } from '../../../../packages/contracts/src/project-file.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { fileNameOf, revealLabelKey, stemOf } from './format.ts';
import type { ActionState, HostPlatform } from './types.ts';
import './project-file-common.css';
import './project-file-home.css';

export type ProjectOpenFailureAction = 'locate' | 'remove' | 'restore' | 'reveal' | 'update';
export interface ProjectOpenFailureDialogProps {
  readonly open: boolean;
  readonly failure: ProjectOpenFailure;
  /** The name in the registry; without one the file name without `.mioon` is shown. */
  readonly projectName: string | null;
  /** Generated results waiting in the inbox for this project. */
  readonly inboxCount?: number;
  readonly action: ActionState<ProjectOpenFailureAction>;
  readonly platform: HostPlatform;
  readonly onLocate: () => void;
  readonly onRemove: () => void;
  readonly onCheckUpdate?: () => void;
  readonly onRestoreBackup?: () => void;
  /** Read-only location only: show the file in the file manager. */
  readonly onReveal?: () => void;
  readonly onClose: () => void;
}

/** Why a project cannot be opened (12-03, 12-03b, 12-03c, 12-03d). A read-only
 * location keeps the 12-03d layout with its own wording: the file is not damaged. */
export function ProjectOpenFailureDialog(props: ProjectOpenFailureDialogProps): ReactElement {
  const { t } = useI18n();
  const { failure, action } = props;
  const working = action.kind === 'working';
  const name = props.projectName ?? stemOf(failure.projectFile);
  const run = (kind: ProjectOpenFailureAction, label: string, onClick: () => void, primary = false) =>
    <WorkbenchButton key={kind} variant={primary ? 'primary' : 'secondary'} data-testid={`pf-open-${kind}`} loading={working && action.action === kind} disabled={working} onClick={onClick}>{label}</WorkbenchButton>;
  const close = (label: string, primary = false) =>
    <WorkbenchButton key="close" variant={primary ? 'primary' : 'secondary'} data-testid="pf-open-close" disabled={working} onClick={props.onClose}>{label}</WorkbenchButton>;
  let title: string, body: ReactNode, buttons: ReactNode;
  switch (failure.code) {
    case 'PROJECT_MISSING':
      title = t('projectFile.open.missing.title', { name });
      body = <>{t('projectFile.open.missing.body', { path: failure.projectFile })}{props.inboxCount !== undefined && props.inboxCount > 0 && <span data-testid="pf-open-inbox">{t('projectFile.open.missing.inbox', { count: props.inboxCount })}</span>}</>;
      buttons = <>{run('remove', t('projectFile.open.missing.remove'), props.onRemove)}{run('locate', t('projectFile.home.locate'), props.onLocate, true)}</>;
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
      body = t(records ? 'projectFile.open.newerRecords.body' : 'projectFile.open.newer.body', versions);
      buttons = <>{close(t('common.close'), !props.onCheckUpdate)}{props.onCheckUpdate && run('update', t('projectFile.open.newer.checkUpdate'), props.onCheckUpdate, true)}</>;
      break;
    }
    case 'PROJECT_INVALID': {
      title = t('projectFile.open.invalid.title', { file: fileNameOf(failure.projectFile) });
      if (failure.reason === 'read-only') {
        body = t('projectFile.open.readOnly.body');
        buttons = <>{close(t('common.close'), !props.onReveal)}{props.onReveal && run('reveal', t(revealLabelKey(props.platform)), props.onReveal, true)}</>;
      } else {
        body = <>{t('projectFile.open.invalid.body')}{props.onRestoreBackup && t('projectFile.open.invalid.backupHint')}</>;
        buttons = <>{close(t('common.close'), !props.onRestoreBackup)}{props.onRestoreBackup && run('restore', t('projectFile.open.invalid.restore'), props.onRestoreBackup, true)}</>;
      }
      break;
    }
  }
  return <Dialog open={props.open} onOpenChange={next => { if (!next && !working) props.onClose(); }}>
    <WorkbenchDialogContent title={title} description={body} size="confirm" showCloseButton={false} className="pf-dialog pf-open-dialog" data-testid="pf-open-dialog" data-code={failure.code} footer={buttons}>
      {action.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-open-error" icon={<WorkbenchIcon name="warning" size={16} />}>{t(`projectFile.open.failed.${action.action}`)}</WorkbenchAlert>}
    </WorkbenchDialogContent>
  </Dialog>;
}
