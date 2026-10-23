import React, { useState } from 'react';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { AlertTriangle, ChevronDown, ChevronUp, CornerUpLeft, LocateFixed, RefreshCw, X } from '@mioon/ui/components/workbench-icons';
import { useI18n } from './i18n/I18nProvider.tsx';
import type { SourceRefreshSkip } from './timeline-source-freshness.ts';
import './timeline-source-banner.css';

/** A finished timeline.clip.refreshSources (or its NOTHING_TO_REFRESH refusal), kept by App only while the saved
 * timeline still has the revision it produced, so undo here always means "undo this batch". */
export interface SourceRefreshOutcome { revision: number; refreshed: readonly { clipId: string }[]; skipped: readonly SourceRefreshSkip[] }
export interface TimelineSourceBannerProps {
  staleClipIds: readonly string[];
  outcome: SourceRefreshOutcome | null;
  describeSkip: (skip: SourceRefreshSkip) => string;
  disabledReason?: string | null;
  busy?: boolean;
  canUndo?: boolean;
  onRefreshAll: (clipIds: string[]) => unknown;
  onSelectClip: (clipId: string) => unknown;
  onUndo: () => unknown;
  onDismissOutcome: () => unknown;
}

// Presentation only. App owns the request, its recovery and the outcome's lifetime.
export default function TimelineSourceBanner({ staleClipIds, outcome, describeSkip, disabledReason = null, busy = false, canUndo = false, onRefreshAll, onSelectClip, onUndo, onDismissOutcome }: TimelineSourceBannerProps) {
  const { t } = useI18n();
  const staleKey = staleClipIds.join(',');
  // Hiding lasts until the set of outdated clips changes, so a newly outdated clip is announced again.
  const [hiddenKey, setHiddenKey] = useState<string | null>(null), [cursor, setCursor] = useState(0), [collapsed, setCollapsed] = useState(false);
  if (outcome) {
    const refreshed = outcome.refreshed.length, skipped = outcome.skipped.length;
    return <section className="timeline-source-banner is-result" data-testid="timeline-source-result" role="status" aria-live="polite">
      <div className="timeline-source-banner-row">
        <AlertTriangle size={14} className="timeline-source-banner-icon" aria-hidden="true" />
        <strong>{refreshed ? skipped ? t('timeline.sync.result.updatedSkipped', { count: refreshed, skipped }) : t('timeline.sync.result.updated', { count: refreshed }) : t('timeline.sync.result.none', { count: skipped })}</strong>
        <span className="timeline-source-banner-detail">{refreshed ? t('timeline.sync.result.detail', { count: refreshed }) : t('timeline.sync.result.noneDetail')}</span>
        <span className="timeline-source-banner-actions">
          {refreshed > 0 && <WorkbenchButton variant="secondary" size="compact" data-testid="timeline-source-undo" disabled={!canUndo || busy} onClick={() => onUndo()}><CornerUpLeft size={13} />{t('timeline.history.undo')}</WorkbenchButton>}
          {skipped > 0 && <WorkbenchButton variant="icon" size="compact" data-testid="timeline-source-skipped-toggle" aria-expanded={!collapsed} aria-label={t(collapsed ? 'timeline.sync.result.showSkipped' : 'timeline.sync.result.hideSkipped')} title={t(collapsed ? 'timeline.sync.result.showSkipped' : 'timeline.sync.result.hideSkipped')} onClick={() => setCollapsed(value => !value)}>{collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</WorkbenchButton>}
          <WorkbenchButton variant="icon" size="compact" data-testid="timeline-source-result-close" aria-label={t('timeline.sync.result.dismiss')} title={t('timeline.sync.result.dismiss')} onClick={() => onDismissOutcome()}><X size={14} /></WorkbenchButton>
        </span>
      </div>
      {skipped > 0 && !collapsed && <ul className="timeline-source-skipped" data-testid="timeline-source-skipped">{outcome.skipped.map(skip => <li key={skip.clipId}>
        <span className="timeline-source-skip-tag">{t('timeline.sync.result.skipTag')}</span><span className="timeline-source-skip-text">{describeSkip(skip)}</span>
        <WorkbenchButton variant="ghost" size="compact" data-testid={`timeline-source-locate-${skip.clipId}`} title={t('timeline.sync.result.locateHint')} onClick={() => onSelectClip(skip.clipId)}><LocateFixed size={13} />{t('timeline.sync.result.locate')}</WorkbenchButton>
      </li>)}</ul>}
    </section>;
  }
  if (!staleClipIds.length || hiddenKey === staleKey) return null;
  const view = () => { const index = cursor % staleClipIds.length; setCursor(index + 1); onSelectClip(staleClipIds[index]!); };
  return <section className="timeline-source-banner" data-testid="timeline-source-banner" aria-label={t('timeline.sync.stale.title', { count: staleClipIds.length })}>
    <div className="timeline-source-banner-row">
      <RefreshCw size={14} className="timeline-source-banner-icon" aria-hidden="true" />
      <strong>{t('timeline.sync.stale.title', { count: staleClipIds.length })}</strong>
      <span className="timeline-source-banner-detail">{disabledReason || t('timeline.sync.stale.detail')}</span>
      <span className="timeline-source-banner-actions">
        <WorkbenchButton variant="ghost" size="compact" data-testid="timeline-source-view" title={t('timeline.sync.stale.viewHint')} onClick={view}>{t('timeline.sync.stale.view')}</WorkbenchButton>
        <WorkbenchButton variant="primary" size="compact" data-testid="timeline-source-refresh-all" disabled={busy || Boolean(disabledReason)} title={disabledReason ?? undefined} onClick={() => onRefreshAll([...staleClipIds])}>{t('timeline.sync.stale.refreshAll')}</WorkbenchButton>
        <WorkbenchButton variant="icon" size="compact" data-testid="timeline-source-dismiss" aria-label={t('timeline.sync.stale.dismiss')} title={t('timeline.sync.stale.dismiss')} onClick={() => setHiddenKey(staleKey)}><X size={14} /></WorkbenchButton>
      </span>
    </div>
  </section>;
}
