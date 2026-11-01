import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { WorkbenchAlert, WorkbenchBadge, WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import type { OutsideProjectLocation } from '../../../../packages/contracts/src/media-reference.ts';
import { PROJECT_RULES_FILE } from '../../../../packages/contracts/src/project-file.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import Icon from '../icons.tsx';
import { displayPath } from './format.ts';
import type { ActionState, ViewState } from './types.ts';
import './project-file-common.css';
import './project-file-media.css';

export type OutsideLocationsAction = 'open' | 'allow';
export interface OutsideLocationsDialogProps {
  readonly open: boolean;
  readonly projectName: string;
  /** The project file was last written on another computer. */
  readonly fromAnotherComputer: boolean;
  readonly state: ViewState<readonly OutsideProjectLocation[]>;
  /** AGENTS.md is not trusted on this computer yet. */
  readonly rulesUntrusted: boolean;
  readonly action: ActionState<OutsideLocationsAction>;
  readonly homeDirectory?: string | null;
  /** Open without reading media outside the project folder. */
  readonly onOpenOnly: () => void;
  readonly onAllow: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

/** Before opening a project whose media sit outside its folder (12-06): the
 * folders are read only once the user allows it. */
export function OutsideLocationsDialog(props: OutsideLocationsDialogProps): ReactElement {
  const { t } = useI18n();
  const { state, action } = props;
  const working = action.kind === 'working';
  const locations = state.kind === 'ready' ? state.value : [];
  const run = (kind: OutsideLocationsAction, label: string, onClick: () => void, primary: boolean, disabled = false) =>
    <WorkbenchButton key={kind} variant={primary ? 'primary' : 'secondary'} data-testid={`pf-outside-${kind}`} loading={working && action.action === kind} disabled={working || disabled} onClick={onClick}>{label}</WorkbenchButton>;
  let body: ReactNode, footer: ReactNode;
  if (state.kind === 'loading') {
    body = <div className="pf-state" role="status" data-testid="pf-outside-loading"><span className="wb-spinner" aria-hidden="true" />{t('projectFile.media.outside.checking')}</div>;
    footer = <>{run('open', t('projectFile.media.outside.openOnly'), props.onOpenOnly, false)}{run('allow', t('projectFile.media.outside.allow'), props.onAllow, true, true)}</>;
  } else if (state.kind === 'error') {
    body = <div className="pf-state" role="alert" data-testid="pf-outside-error"><strong>{t('projectFile.media.outside.error')}</strong>
      {state.retryable && <WorkbenchButton data-testid="pf-outside-retry" disabled={working} onClick={props.onRetry}>{t('projectFile.common.retry')}</WorkbenchButton>}</div>;
    footer = run('open', t('projectFile.media.outside.openOnly'), props.onOpenOnly, true);
  } else if (locations.length === 0) {
    body = <p className="pf-outside-body" data-testid="pf-outside-empty">{t('projectFile.media.outside.emptyBody')}</p>;
    footer = run('open', t('projectFile.media.outside.open'), props.onOpenOnly, true);
  } else {
    body = <>
      <p className="pf-outside-body">{t('projectFile.media.outside.body', { count: locations.length })}</p>
      <ul className="pf-rows pf-outside-rows">{locations.map(location => <li key={location.directory} data-available={location.available} data-testid="pf-outside-row">
        <Icon name="folder" size={16} className="pf-row-icon" />
        <span className="pf-row-main">
          <span className="pf-row-title">{displayPath(location.directory, props.homeDirectory)}</span>
          <span className="pf-row-detail">{t('projectFile.media.outside.assets', { count: location.assetCount })}{!location.available && <> · {t('projectFile.media.outside.notOnComputer')}</>}</span>
        </span>
        <span className="pf-row-end"><WorkbenchBadge tone={location.available ? 'success' : 'neutral'}>{t(location.available ? 'projectFile.media.outside.found' : 'projectFile.media.outside.notFound')}</WorkbenchBadge></span>
      </li>)}</ul>
    </>;
    footer = <>{run('open', t('projectFile.media.outside.openOnly'), props.onOpenOnly, false)}{run('allow', t('projectFile.media.outside.allow'), props.onAllow, true)}</>;
  }
  return <Dialog open={props.open} onOpenChange={next => { if (!next && !working) props.onClose(); }}>
    <WorkbenchDialogContent title={t('projectFile.media.outside.title', { name: props.projectName })} size="standard" className="pf-dialog pf-outside-dialog" data-testid="pf-outside-dialog"
      showCloseButton={!working} description={props.fromAnotherComputer ? t('projectFile.media.outside.fromAnother') : undefined} footer={footer}>
      {body}
      {props.rulesUntrusted && <p className="pf-outside-rules" data-testid="pf-outside-rules"><Icon name="note" size={14} />{t('projectFile.media.outside.rules', { file: PROJECT_RULES_FILE })}</p>}
      {action.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-outside-action-error">{t(`projectFile.media.outside.failed.${action.action}`)}</WorkbenchAlert>}
    </WorkbenchDialogContent>
  </Dialog>;
}
