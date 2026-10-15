import { exportHistoryStatusMessage } from './export-display.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Badge } from '@mioon/ui/components/badge';
import Icon from './icons.jsx';
import { statusText } from './api.js';
import { exportHistoryDelivery } from './export-settings-state.js';
import { hasNamedTimelineDelivery } from './export-delivery-state.ts';
import { hasInvalidExportRangeHistory } from './export-range-state.ts';
import ExportRangeSummary from './ExportRangeSummary.tsx';
import TimelineDeliveryHistory from './TimelineDeliveryHistory.tsx';
import ExportSamplePeak from './ExportSamplePeak.tsx';
import ExportLoudness from './ExportLoudness.tsx';

/** Presentation only. App owns ordering, project identity, right-dock lifetime and
 * navigation fences. Rows retain their original immutable export snapshots. */
export default function ExportHistoryList({ orderedExports, projectName, timelineRevision, heldExportIds = [], samplePeak, loudness }) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  return <div className="export-list">
    {orderedExports.length ? orderedExports.map(item => {
      const delivery = exportHistoryDelivery(item), held = heldExportIds.includes(item.id), invalidRange = hasInvalidExportRangeHistory(item);
      if (hasNamedTimelineDelivery(item)) return <TimelineDeliveryHistory key={item.id} item={item} samplePeak={samplePeak} loudness={loudness} frozenDelivery={delivery} timelineRevision={timelineRevision} statusLabel={exportHistoryStatusMessage(item.status, locale)} held={held} filmIcon={<Icon name="film" size={24} />} downloadIcon={<Icon name="download" size={15} />} />;
      return <div className="export-card" key={item.id}>
        <div className="export-icon"><Icon name="film" size={24} /></div>
        <div className="export-detail">
          <strong>{projectName || t('export.history.film')}.mp4</strong>
          {held && <span className="restored-held-label" data-testid="restored-export-held">{t('export.history.held')}</span>}
          <span>{exportHistoryStatusMessage(item.status, locale)} · {formatDate(item.createdAt, { dateStyle: 'medium', timeStyle: 'medium' })}</span>
          {item.error && <p className="job-error">{t('export.history.safeError')}</p>}
          <small>{item.mode === 'timeline'
            ? t(item.purpose === 'preview' ? 'export.history.previewRevision' : 'export.history.timelineRevision', { revision: item.timelineRevision, snapshot: item.timelineRevision !== timelineRevision ? t('export.history.old') : t('export.history.current') })
            : t('export.history.storyboard', { count: item.orderedVersionIds?.length || 0 })}</small>
          {item.mode === 'timeline' && item.purpose === 'export' && <ExportRangeSummary input={item.snapshot} snapshot testId="export-history-range" />}
          {invalidRange && <p className="notice warning" data-testid="export-history-range-invalid">{t('export.history.invalidRange')}</p>}
          <ExportSamplePeak exportId={item.id} samplePeak={samplePeak} />
          <ExportLoudness exportId={item.id} loudness={loudness} />
          {delivery && <small className="export-frozen-settings" data-testid="export-history-settings">{t('export.history.output', { dimensions: delivery.dimensions, fps: delivery.fps, rate: renderMessage(delivery.rateMessage), upscale: delivery.upscale ? t('export.history.upscale') : '' })}</small>}
        </div>
        {invalidRange ? <Badge className="small-badge warn">{t('export.history.rangeUnavailable')}</Badge> : (item.url || item.assetId) && ['succeeded', 'completed', 'ready'].includes(item.status)
          ? <a className="button primary small" href={item.url || `/media/${item.assetId}`}
              download={`${projectName || 'film'}.mp4`} data-testid="download-export">
              <Icon name="download" size={15} />{t('export.history.download')}</a>
          : held ? <Badge className="small-badge neutral">{t('export.history.retained')}</Badge> : item.status === 'failed'
            ? <Badge className="small-badge warn">{t('export.history.failed')}</Badge>
            : <span className="spinner" />}
      </div>; })
      : <div className="small-empty">
          <Icon name="download" size={29} />
          <h4>{t('export.history.empty')}</h4>
          <p>{t('export.history.emptyHelp')}</p>
        </div>}
  </div>;
}
