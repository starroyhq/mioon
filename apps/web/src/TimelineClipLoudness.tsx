import { TIMELINE_CLIP_LOUDNESS_LIMITS } from '@mioon/contracts/timeline-clip-loudness';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { useI18n } from './i18n/I18nProvider.tsx';
import { timelineClipLoudnessAvailable, timelineClipLoudnessStatusMessage } from './timeline-clip-loudness-state.ts';
import type { TimelineClipLoudnessView } from './timeline-clip-loudness-state.ts';

/** An ephemeral, isolated saved-clip measurement, never a mix/candidate/apply UI. */
export default function TimelineClipLoudness({ loudness }: { readonly loudness: TimelineClipLoudnessView }) {
  const { t, locale, formatNumber, formatDate } = useI18n();
  const { state, controller } = loudness;
  if (!state.visible) return null;
  const available = timelineClipLoudnessAvailable(state), preparing = state.phase === 'preparing';
  const report = available ? state.report : null, status = timelineClipLoudnessStatusMessage(state, locale);
  const number = (value: number): string => formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
  const peak = (value: number | null, unit: string): string => value === null ? t('audio.loudness.silence', { unit }) : `${number(value)} ${unit}`;
  const statusId = `clip-loudness-status-${state.clipId}`;
  return <details className="export-sample-peak timeline-clip-loudness" data-testid="timeline-clip-loudness"
    onToggle={event => { if (!event.currentTarget.open) controller.revoke(state); }}>
    <summary>{t('audio.loudness.clip.title')}</summary>
    <p data-testid="clip-loudness-limit">{t('audio.loudness.clip.durationLimit', { seconds: TIMELINE_CLIP_LOUDNESS_LIMITS.clipSeconds })}</p>
    <p data-testid="clip-loudness-limitation">{t('audio.loudness.clip.limitation')}</p>
    {!available && <p data-testid="clip-loudness-blocked">{state.durationFrames > TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames ? t('audio.loudness.clip.tooLong') : t(state.restored ? 'audio.loudness.clip.restored' : !state.audioSupported || state.muted || state.gain <= 0 ? 'audio.loudness.clip.inaudible' : 'audio.loudness.clip.blocked')}</p>}
    <div className="export-sample-peak-actions">
      <Button type="button" variant="ghost" size="sm" data-testid="clip-loudness-analyze" disabled={!available || preparing}
        aria-describedby={statusId} onClick={() => { void controller.prepare(state); }}>{t('audio.loudness.clip.analyze')}</Button>
      {preparing && available && <Button type="button" variant="ghost" size="sm" data-testid="clip-loudness-cancel"
        onClick={() => controller.cancel(state)}>{t('audio.loudness.cancelObservation')}</Button>}
    </div>
    <div id={statusId} role="status" aria-live="polite" aria-atomic="true">
      {status && <p data-testid="clip-loudness-status">{status}</p>}
      {report && <>
        <p data-testid="clip-loudness-measurement">{t('audio.loudness.clip.integrated')} {report.measurement.integratedLufs === null ? t(`audio.loudness.state.${report.measurement.state}`) : t('audio.loudness.clip.integratedValue', { value: number(report.measurement.integratedLufs) })}<br />
          {t('audio.loudness.clip.peaks', { truePeak: peak(report.measurement.truePeakDbtp, 'dBTP'), sample: peak(report.measurement.samplePeakDbfs, 'dBFS') })}</p>
        <p data-testid="clip-loudness-range">{t('audio.loudness.clip.range', { start: report.identity.startFrame, end: report.identity.startFrame + report.identity.durationFrames,
          source: report.identity.sourceInFrame, sourceEnd: report.identity.sourceInFrame + report.identity.durationFrames, duration: report.identity.durationFrames })}</p>
        <p data-testid="clip-loudness-stage">{t('audio.loudness.clip.stage', { gain: report.identity.gain, fadeIn: report.identity.fadeInFrames, fadeOut: report.identity.fadeOutFrames })}<br />{report.stage}</p>
        <details><summary>{t('audio.loudness.clip.details')}</summary>
          <p>{t('audio.loudness.clip.identity', { project: report.projectId, timeline: report.timelineId, revision: report.expectedRevision, clip: report.clipId, track: report.identity.trackId, asset: report.identity.assetId })}</p>
          <p>{t('audio.loudness.clip.samples', { frames: report.measurement.sampleFrames, end: report.identity.measurementEndFrame })}<br />
            {t('audio.loudness.profile')}{report.measurementProfile}<br />{report.processingProfile}<br />
            {t('audio.loudness.duration', { seconds: formatNumber(report.measurement.decodedDurationSeconds, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) })}<br />
            {t('audio.loudness.stateLabel')}{t(`audio.loudness.state.${report.measurement.state}`)}<br />
            {t('audio.loudness.gating', { all: formatNumber(report.measurement.gatingBlockCount), absolute: formatNumber(report.measurement.absoluteGatedBlockCount), relative: formatNumber(report.measurement.relativeGatedBlockCount) })}<br />
            {t('audio.loudness.relativeGate')}{report.measurement.relativeGateLufs === null ? t('audio.loudness.unavailable') : t('audio.loudness.clip.integratedValue', { value: number(report.measurement.relativeGateLufs) })}<br />
            {t('audio.loudness.snapshotHash')}{report.identity.snapshotSha256}<br />{t('audio.loudness.clip.sourceHash')}{report.identity.assetSha256}</p>
          <p>{t('audio.loudness.measuredAt')}<time dateTime={report.checkedAt}>{formatDate(report.checkedAt, { dateStyle: 'medium', timeStyle: 'medium' })}</time></p>
        </details>
      </>}
    </div>
  </details>;
}
