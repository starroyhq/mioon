import { exportHistoryStatusMessage } from './export-display.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import type { ReactNode } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { hasInvalidExportRangeHistory } from './export-range-state.ts';
import ExportRangeSummary from './ExportRangeSummary.tsx';
import { namedTimelineDeliveryHistory } from './export-delivery-state.ts';
import ExportSamplePeak from './ExportSamplePeak.tsx';
import type { ExportSamplePeakView } from './export-sample-peak-state.ts';
import ExportLoudness from './ExportLoudness.tsx';
import ExportFileActions from './ExportFileActions.tsx';
import type { ExportLoudnessView } from './export-loudness-state.ts';

export interface TimelineDeliveryHistoryProps {
  item: unknown;
  samplePeak?: ExportSamplePeakView;
  loudness?: ExportLoudnessView;
  frozenDelivery?: unknown;
  timelineRevision?: unknown;
  statusLabel: string;
  held?: boolean;
  downloadEnabled?: boolean;
  fileRecoveryEnabled?: boolean;
  filmIcon?: ReactNode;
  downloadIcon?: ReactNode;
  onReexport?: () => void;
}

/** Frozen timeline rows stay independent of today's project title/settings. */
export default function TimelineDeliveryHistory({ item, samplePeak, loudness, frozenDelivery, timelineRevision, statusLabel, held = false, downloadEnabled = true, fileRecoveryEnabled = true, filmIcon, downloadIcon, onReexport }: TimelineDeliveryHistoryProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const delivery = namedTimelineDeliveryHistory(item, frozenDelivery);
  if (!delivery || hasInvalidExportRangeHistory(item)) return <div className="export-card" data-testid="named-delivery-invalid"><div className="export-icon">{filmIcon}</div><div className="export-detail"><strong>{t('export.history.title')}</strong><p className="notice warning">{t('export.history.invalidDelivery')}</p>{held && <span className="restored-held-label" data-testid="restored-export-held">{t('export.history.held')}</span>}</div></div>;
  const output = delivery.output;
  const projectId=item!==null&&typeof item==='object'&&'projectId' in item&&typeof item.projectId==='string'?item.projectId:'';
  const snapshot = item !== null && typeof item === 'object' && 'snapshot' in item ? item.snapshot : undefined;
  return <div className="export-card" data-testid="named-delivery-history">
    <div className="export-icon">{filmIcon}</div>
    <div className="export-detail">
      <strong title={delivery.name} data-testid="delivery-history-name">{delivery.name}</strong>
      {held && <span className="restored-held-label" data-testid="restored-export-held">{t('export.history.held')}</span>}
      <span>{exportHistoryStatusMessage(delivery.status, locale)} · <time dateTime={delivery.createdAt}>{formatDate(delivery.createdAt, { dateStyle: 'medium', timeStyle: 'medium' })}</time></span>
      {delivery.error && <p className="job-error">{t('export.history.safeError')}</p>}
      <small>{t('export.history.timelineRevision', { revision: delivery.revision, snapshot: t(delivery.revision !== timelineRevision ? 'export.history.old' : 'export.history.current') })}</small>
      <ExportSamplePeak exportId={delivery.id} samplePeak={samplePeak} />
      <ExportLoudness exportId={delivery.id} loudness={loudness} />
      <ExportRangeSummary input={snapshot} snapshot testId="export-history-range" />
      {output ? <small className="export-frozen-settings" data-testid="export-history-settings">{t(snapshot && typeof snapshot === 'object' && Object.hasOwn(snapshot, 'delivery') ? 'export.history.output' : 'export.history.legacyOutput', { dimensions: output.dimensions, fps: output.fps, rate: renderMessage(output.rateMessage) || t('export.history.legacyRate'), upscale: output.upscale ? t('export.history.upscale') : '' })}</small> : <small>{t('export.history.frozenUnavailable')}</small>}
    </div>
    {!held && onReexport && ['failed', 'cancelled'].includes(delivery.status) && <Button variant="ghost" className="button small" data-testid="export-history-reexport" onClick={onReexport}>{t('redesign.export.reexport')}</Button>}
    {downloadEnabled && delivery.downloadHref
      ? <ExportFileActions projectId={projectId} exportId={delivery.id} downloadHref={delivery.downloadHref} disabled={!fileRecoveryEnabled||held||!projectId}/>
      : held ? <Badge className="small-badge neutral">{t('export.history.retained')}</Badge>
        : delivery.status === 'failed' ? <Badge className="small-badge warn">{t('export.history.failed')}</Badge> : <span className="spinner" />}
  </div>;
}
