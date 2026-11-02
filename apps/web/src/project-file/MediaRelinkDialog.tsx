import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { WorkbenchAlert, WorkbenchBadge, WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import { AlertTriangle, CircleAlert, CircleCheck, Image, Video } from '@mioon/ui/components/workbench-icons';
import { useI18n } from '../i18n/I18nProvider.tsx';
import Icon from '../icons.tsx';
import { displayPath } from './format.ts';
import type { ActionState, ViewState } from './types.ts';
import './project-file-common.css';
import './project-file-media.css';

/** One media file being relinked. picked: at the place the user chose. auto:
 * found by the same relative structure, fingerprint matching. changed: still
 * at its place but different. missing: not found yet. */
export interface MediaRelinkRow {
  readonly assetId: string;
  readonly name: string;
  readonly mediaKind: 'video' | 'image' | 'audio';
  readonly from: string;
  readonly to: string | null;
  readonly outcome: 'picked' | 'auto' | 'changed' | 'missing';
}
export interface MediaRelinkResult {
  readonly rows: readonly MediaRelinkRow[];
  /** The file whose new place led to the others. */
  readonly foundBy: { readonly name: string; readonly count: number } | null;
}
export interface MediaRelinkDialogProps {
  readonly open: boolean;
  readonly projectName: string;
  readonly homeDirectory?: string | null;
  readonly state: ViewState<MediaRelinkResult>;
  readonly apply: ActionState<'apply'>;
  readonly onChooseFile: (assetId: string) => void;
  readonly onUseNewFile: (assetId: string) => void;
  readonly onApply: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

/** Relink media (12-05): the files found again, and what still needs a decision. */
export function MediaRelinkDialog(props: MediaRelinkDialogProps): ReactElement {
  const { t } = useI18n();
  const { state, apply } = props;
  const applying = apply.kind === 'working';
  const rows = state.kind === 'ready' ? state.value.rows : [];
  const found = rows.filter(row => row.outcome === 'picked' || row.outcome === 'auto').length;
  const path = (value: string) => displayPath(value, props.homeDirectory);
  const pathLine = (label: string, value: string) => <span className="pf-relink-path"><span>{label}</span><code>{path(value)}</code></span>;
  let body: ReactNode;
  if (state.kind === 'loading') body = <div className="pf-state" role="status" data-testid="pf-relink-searching"><span className="wb-spinner" aria-hidden="true" />{t('projectFile.media.relink.searching')}</div>;
  else if (state.kind === 'error') body = <div className="pf-state" role="alert" data-testid="pf-relink-error"><strong>{t('projectFile.media.relink.error')}</strong>
    {state.retryable && <WorkbenchButton data-testid="pf-relink-retry" onClick={props.onRetry}>{t('projectFile.common.retry')}</WorkbenchButton>}</div>;
  else if (rows.length === 0) body = <div className="pf-state" data-testid="pf-relink-empty"><CircleCheck size={20} aria-hidden="true" className="pf-tone-success" /><strong>{t('projectFile.media.relink.emptyTitle')}</strong>{t('projectFile.media.relink.emptyBody')}</div>;
  else body = <>
    {state.value.foundBy && state.value.foundBy.count > 0 && <WorkbenchAlert tone="success" className="pf-relink-found" icon={<CircleCheck size={16} />} data-testid="pf-relink-found-by">{t('projectFile.media.relink.foundBy', { name: state.value.foundBy.name, count: state.value.foundBy.count })}</WorkbenchAlert>}
    <ul className="pf-rows pf-relink-rows">{rows.map(row => <li key={row.assetId} data-outcome={row.outcome} data-testid={`pf-relink-row-${row.assetId}`}>
      {row.outcome === 'changed' ? <AlertTriangle size={16} aria-hidden="true" className="pf-row-icon pf-tone-warning" />
        : row.outcome === 'missing' ? <CircleAlert size={16} aria-hidden="true" className="pf-row-icon pf-tone-danger" />
          : row.mediaKind === 'image' ? <Image size={16} aria-hidden="true" className="pf-row-icon" /> : row.mediaKind === 'audio' ? <Icon name="music" size={16} className="pf-row-icon" /> : <Video size={16} aria-hidden="true" className="pf-row-icon" />}
      <span className="pf-row-main">
        <span className="pf-row-title">{row.name}</span>
        {row.outcome === 'changed' ? <span className="pf-relink-path"><code>{path(row.from)}</code></span> : pathLine(t('projectFile.media.relink.from'), row.from)}
        {row.to !== null && row.outcome !== 'changed' && pathLine(t('projectFile.media.relink.to'), row.to)}
      </span>
      <span className="pf-row-end pf-relink-end">
        <WorkbenchBadge tone={row.outcome === 'changed' ? 'warning' : row.outcome === 'missing' ? 'danger' : 'success'}>{t(`projectFile.media.relink.outcome.${row.outcome}`)}</WorkbenchBadge>
        {(row.outcome === 'changed' || row.outcome === 'missing') && <span className="pf-relink-actions">
          {row.outcome === 'changed' && <WorkbenchButton size="compact" data-testid={`pf-relink-use-new-${row.assetId}`} disabled={applying} onClick={() => props.onUseNewFile(row.assetId)}>{t('projectFile.media.relink.useNew')}</WorkbenchButton>}
          <WorkbenchButton size="compact" data-testid={`pf-relink-choose-${row.assetId}`} disabled={applying} onClick={() => props.onChooseFile(row.assetId)}>{t('projectFile.media.relink.choose')}</WorkbenchButton>
        </span>}
      </span>
    </li>)}</ul>
    {rows.some(row => row.outcome === 'changed') && <p className="pf-help pf-relink-help">{t('projectFile.media.relink.changedHelp')}</p>}
    {apply.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-relink-apply-error">{t('projectFile.media.relink.applyFailed')}</WorkbenchAlert>}
  </>;
  const ready = state.kind === 'ready' && rows.length > 0;
  return <Dialog open={props.open} onOpenChange={next => { if (!next && !applying) props.onClose(); }}>
    <WorkbenchDialogContent title={t('projectFile.media.relink.title')} size="standard" className="pf-dialog pf-relink-dialog" data-testid="pf-relink-dialog" showCloseButton={!applying}
      description={ready ? t('projectFile.media.relink.subtitle', { name: props.projectName, count: rows.length }) : props.projectName}
      footer={<>
        {ready && <p className="pf-footer-note" data-testid="pf-relink-summary">{t('projectFile.media.relink.summary', { found, pending: rows.length - found })}</p>}
        {state.kind === 'ready' && rows.length === 0
          ? <WorkbenchButton variant="primary" data-testid="pf-relink-close" onClick={props.onClose}>{t('common.close')}</WorkbenchButton>
          : <>
            <WorkbenchButton data-testid="pf-relink-cancel" disabled={applying} onClick={props.onClose}>{t('common.cancel')}</WorkbenchButton>
            <WorkbenchButton variant="primary" data-testid="pf-relink-apply" loading={applying} disabled={!ready || found === 0} onClick={props.onApply}>{t('projectFile.media.relink.apply')}</WorkbenchButton>
          </>}
      </>}>
      {body}
    </WorkbenchDialogContent>
  </Dialog>;
}
