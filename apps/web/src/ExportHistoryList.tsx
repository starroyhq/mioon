import { exportHistoryStatusMessage } from './export-display.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Badge } from '@mioon/ui/components/badge';
import Icon from './icons.tsx';
import { statusText } from './api.ts';
import { exportHistoryDelivery } from './export-settings-state.ts';
import { hasNamedTimelineDelivery } from './export-delivery-state.ts';
import { hasInvalidExportRangeHistory } from './export-range-state.ts';
import ExportRangeSummary from './ExportRangeSummary.tsx';
import TimelineDeliveryHistory from './TimelineDeliveryHistory.tsx';
import ExportFileActions from './ExportFileActions.tsx';
import ExportSamplePeak from './ExportSamplePeak.tsx';
import ExportLoudness from './ExportLoudness.tsx';
import { opacityCandidateRenderPresentation } from './opacity-candidate-render-presentation.ts';

/** Presentation only. App owns ordering, project identity, right-dock lifetime and
 * navigation fences. Rows retain their original immutable export snapshots. */
export default function ExportHistoryList({ orderedExports, projectName, projectId, timelineRevision, heldExportIds = [], samplePeak, loudness, opacityApplication = null, candidateConnected = false, fileRecoveryEnabled = true, onReexport }) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  return <div className="export-list">
    {orderedExports.length ? orderedExports.map(item => {
      const candidate = opacityApplication !== null;
      const candidateOutput = candidate ? opacityCandidateRenderPresentation(opacityApplication, item, {projectId, connected: candidateConnected, heldExportIds}) : null;
      if (candidate && !candidateOutput) return <div className="export-card" key={item.id} data-testid="candidate-delivery-invalid"><div className="export-icon"><Icon name="film" size={24} /></div><div className="export-detail"><strong>{t('export.history.title')}</strong><p className="notice warning">{t('export.history.invalidDelivery')}</p></div></div>;
      const delivery = exportHistoryDelivery(item), held = heldExportIds.includes(item.id), invalidRange = hasInvalidExportRangeHistory(item);
      if (hasNamedTimelineDelivery(item)) return <TimelineDeliveryHistory key={item.id} item={item} samplePeak={samplePeak} loudness={loudness} frozenDelivery={delivery} timelineRevision={timelineRevision} statusLabel={exportHistoryStatusMessage(item.status, locale)} held={held} downloadEnabled={!candidate || Boolean(candidateOutput.downloadHref)} fileRecoveryEnabled={fileRecoveryEnabled && !candidate} filmIcon={<Icon name="film" size={24} />} downloadIcon={<Icon name="download" size={15} />} onReexport={!candidate && !held && onReexport ? () => onReexport(item.id) : undefined} />;
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
        {!candidate && !held && onReexport && ['failed', 'cancelled'].includes(item.status) && <Button variant="ghost" type="button" className="button small" data-testid="export-history-reexport" onClick={() => onReexport(item.id)}>{t('redesign.export.reexport')}</Button>}
        {invalidRange ? <Badge className="small-badge warn">{t('export.history.rangeUnavailable')}</Badge> : (candidate ? candidateOutput.downloadHref : (item.url || item.assetId) && ['succeeded', 'completed', 'ready'].includes(item.status))
          ? <ExportFileActions projectId={projectId||item.projectId} exportId={item.id} downloadHref={candidate ? candidateOutput.downloadHref : item.url || `/media/${item.assetId}`} disabled={!fileRecoveryEnabled||candidate||held||item.mode==='timeline'&&item.purpose!=='export'}/>
          : held ? <Badge className="small-badge neutral">{t('export.history.retained')}</Badge> : item.status === 'failed'
            ? <Badge className="small-badge warn">{t('export.history.failed')}</Badge>
            : candidate && item.status === 'succeeded' ? <Badge className="small-badge neutral">{exportHistoryStatusMessage(item.status, locale)}</Badge> : <span className="spinner" />}
      </div>; })
      : <div className="small-empty">
          <Icon name="download" size={29} />
          <h4>{t('export.history.empty')}</h4>
          <p>{t('export.history.emptyHelp')}</p>
        </div>}
  </div>;
}
