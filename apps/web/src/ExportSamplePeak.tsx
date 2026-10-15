import { translate } from '../../../packages/i18n/src/index.ts';
import type { Locale } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { EXPORT_SAMPLE_PEAK_LABEL, EXPORT_SAMPLE_PEAK_LIMITATION, EXPORT_SAMPLE_PEAK_RESTORED, exportSamplePeakStatusMessage } from './export-sample-peak-state.ts';
import type { ExportSamplePeakView } from './export-sample-peak-state.ts';

export interface ExportSamplePeakProps { readonly exportId: string; readonly samplePeak?: ExportSamplePeakView }
export function formatExportSamplePeak(dbfs: number | null, locale: Locale = 'zh-Hans'): string { return dbfs === null ? translate(locale, 'audio.loudness.silence', { unit: 'dBFS' }) : `${dbfs > 0 ? '+' : ''}${dbfs.toFixed(4)} dBFS`; }

/** Inline row output, measured from the already-delivered file only. */
export default function ExportSamplePeak({ exportId, samplePeak }: ExportSamplePeakProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  if (!samplePeak) return null;
  const { state, controller } = samplePeak, target = state.targets.find(item => item.exportId === exportId);
  if (!target) return null;
  const selected = state.targetId === exportId && state.targetKey === target.key;
  const busy = state.phase === 'checking', checking = selected && busy;
  const report = selected ? state.report : null;
  const ready = report?.status === 'ready' && report.artifact !== null && report.measurement !== null ? report : null;
  const statusId = `export-sample-peak-status-${exportId}`;
  const status = selected ? exportSamplePeakStatusMessage(state, locale) : '';
  return <section className="export-sample-peak" data-testid="export-sample-peak" aria-label={t('audio.loudness.peak.label')}>
    <strong className="export-sample-peak-label">{t('audio.loudness.peak.label')}</strong>
    {state.restored ? <p data-testid="export-sample-peak-unavailable">{t('audio.loudness.peak.restored')}</p> : <div className="export-sample-peak-actions">
      <Button variant="ghost" type="button" className="button quiet small" data-testid="export-sample-peak-check" disabled={busy || !state.connected || !state.visible}
        aria-label={`${selected && state.phase !== 'idle' ? t('audio.loudness.peak.checkAgain') : t('audio.loudness.peak.check')}${t('audio.loudness.peak.label')}`} aria-describedby={statusId} onClick={() => { void controller.check(target, state.scope); }}>
        {selected && state.phase !== 'idle' ? t('audio.loudness.peak.checkAgain') : t('audio.loudness.peak.check')}
      </Button>
      {checking && <Button variant="ghost" type="button" className="button quiet small" data-testid="export-sample-peak-cancel" onClick={() => controller.cancel()}>{t('audio.loudness.peak.cancel')}</Button>}
    </div>}
    <div id={statusId} className="export-sample-peak-status" role="status" aria-live="polite" aria-atomic="true">
      {checking ? <p>{status}</p> : ready && ready.measurement && ready.artifact ? <>
        <p data-testid="export-sample-peak-overall">{t('audio.loudness.peak.overall')}{formatExportSamplePeak(ready.measurement.peakDbfs, locale)}</p>
        <p data-testid="export-sample-peak-channels">{t('audio.loudness.peak.left')}{formatExportSamplePeak(ready.measurement.channelPeaks[0].peakDbfs, locale)}<br />{t('audio.loudness.peak.right')}{formatExportSamplePeak(ready.measurement.channelPeaks[1].peakDbfs, locale)}</p>
        {ready.measurement.overFullScale && <p className="notice warning" data-testid="export-sample-peak-warning">{t('audio.loudness.peak.warning')}</p>}
        <p>{t('audio.loudness.peak.checked')}<time dateTime={ready.checkedAt}>{formatDate(ready.checkedAt, { dateStyle: 'medium', timeStyle: 'medium' })}</time></p>
        <details><summary>{t('audio.loudness.peak.details')}</summary><p>{t('audio.loudness.exportId')}{ready.exportId}<br />{t('audio.loudness.assetId')}{ready.artifact.assetId}<br />SHA-256：{ready.artifact.sha256}<br />{t('audio.loudness.frozenRevision', { revision: ready.artifact.timelineRevision })}<br />{t('audio.loudness.peak.linear', { overall: formatNumber(ready.measurement.peakLinear), left: formatNumber(ready.measurement.channelPeaks[0].peakLinear), right: formatNumber(ready.measurement.channelPeaks[1].peakLinear) })}<br />{t('audio.loudness.sampleFrames', { frames: formatNumber(ready.measurement.sampleFrames) })}</p></details>
      </> : status ? <p data-testid="export-sample-peak-not-ready">{status}</p> : busy && !state.restored ? <p>{t('audio.loudness.peak.another')}</p> : !state.connected && !state.restored ? <p>{t('audio.loudness.peak.reconnect')}</p> : null}
    </div>
    <p className="export-sample-peak-limitation">{t('audio.loudness.peak.limitation')}</p>
  </section>;
}
