import React from 'react';
import type { ReactElement } from 'react';
import { WorkbenchBadge, WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import type { WorkbenchTone } from '@mioon/ui/components/workbench-controls';
import { AlertTriangle, Link } from '@mioon/ui/components/workbench-icons';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MediaStatusUi } from './media-status.ts';
import { ProjectFileIcon } from './project-file-icons.tsx';
import type { ViewState } from './types.ts';
import './project-file-common.css';
import './project-file-media.css';

const TONES: Readonly<Record<Exclude<MediaStatusUi['kind'], 'online'>, WorkbenchTone>> = {
  missing: 'danger', changed: 'warning', 'unconfirmed-found': 'neutral', 'unconfirmed-maybe-changed': 'warning', checking: 'neutral', 'check-failed': 'warning',
};
/** Tone of a media card's border and name for this status; null when online. */
export function mediaStatusTone(status: MediaStatusUi): WorkbenchTone | null {
  return status.kind === 'online' ? null : TONES[status.kind];
}

/** Corner label of a media card (12-04). Nothing while the file is online. */
export function MediaStatusBadge({ status, className }: { readonly status: MediaStatusUi; readonly className?: string }): ReactElement | null {
  const { t } = useI18n();
  if (status.kind === 'online') return null;
  return <WorkbenchBadge tone={TONES[status.kind]} className={['pf-media-badge', className].filter(Boolean).join(' ')} data-media-status={status.kind}>
    {status.kind === 'checking' && <span className="wb-spinner" aria-hidden="true" />}{t(`projectFile.media.badge.${status.kind}`)}
  </WorkbenchBadge>;
}
/** One line under the media name saying what the badge means. */
export function MediaStatusNote({ status }: { readonly status: MediaStatusUi }): ReactElement | null {
  const { t } = useI18n();
  if (status.kind === 'online') return null;
  return <span className="pf-media-note" data-tone={TONES[status.kind]} data-media-status={status.kind}>
    {status.kind === 'missing' ? t(`projectFile.media.note.missing.${status.reason}`) : t(`projectFile.media.note.${status.kind}`)}
  </span>;
}

export interface MediaAttentionBannerProps {
  /** Number of media that need attention; loading while the statuses are checked. */
  readonly state: ViewState<number>;
  readonly onRelink: () => void;
  readonly onRetry: () => void;
}
/** "N media need attention" above the media library (12-04). Nothing when none do. */
export function MediaAttentionBanner({ state, onRelink, onRetry }: MediaAttentionBannerProps): ReactElement | null {
  const { t } = useI18n();
  if (state.kind === 'ready' && state.value === 0) return null;
  if (state.kind === 'loading') return <div className="pf-media-banner" data-state="loading" role="status" data-testid="pf-media-banner"><span className="wb-spinner" aria-hidden="true" /><span>{t('projectFile.media.attentionChecking')}</span></div>;
  if (state.kind === 'error') return <div className="pf-media-banner" data-state="error" data-tone="warning" role="alert" data-testid="pf-media-banner">
    <AlertTriangle size={16} aria-hidden="true" /><span>{t('projectFile.media.attentionFailed')}</span>
    {state.retryable && <WorkbenchButton size="compact" data-testid="pf-media-banner-retry" onClick={onRetry}>{t('projectFile.common.retry')}</WorkbenchButton>}
  </div>;
  return <div className="pf-media-banner" data-state="ready" data-tone="danger" data-testid="pf-media-banner">
    <ProjectFileIcon name="fileX" size={16} /><span>{t('projectFile.media.attention', { count: state.value })}</span>
    <WorkbenchButton size="compact" data-testid="pf-media-banner-relink" onClick={onRelink}><Link size={14} aria-hidden="true" />{t('projectFile.media.relink.action')}</WorkbenchButton>
  </div>;
}
