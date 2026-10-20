import { TIMELINE_CLIP_LOUDNESS_LIMITS, TIMELINE_CLIP_LOUDNESS_TARGET_TOLERANCE_LU } from '@mioon/contracts/timeline-clip-loudness';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { useI18n } from './i18n/I18nProvider.tsx';
import { timelineClipLoudnessAvailable, timelineClipLoudnessStatusMessage, timelineClipLoudnessTarget, timelineClipLoudnessMatchable } from './timeline-clip-loudness-state.ts';
import type { TimelineClipLoudnessView } from './timeline-clip-loudness-state.ts';

/** Isolated saved-clip measurement; matching only stages a checked gain for Save. */
export default function TimelineClipLoudness({ loudness }: { readonly loudness: TimelineClipLoudnessView }) {
  const { t, locale, formatNumber, formatDate } = useI18n();
  const { state, controller } = loudness;
  if (!state.visible) return null;
  const available = timelineClipLoudnessAvailable(state), preparing = state.phase === 'preparing';
  const report = available ? state.report : null, status = timelineClipLoudnessStatusMessage(state, locale);
  const matching = state.targetDraft !== null, target = timelineClipLoudnessTarget(state), candidate = report?.candidate;
  const number = (value: number): string => formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
  const peak = (value: number | null, unit: string): string => value === null ? t('audio.loudness.silence', { unit }) : `${number(value)} ${unit}`;
  const statusId = `clip-loudness-status-${state.clipId}`;
  const stopTargetSubmit = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.stopPropagation();
    if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) event.preventDefault();
  };
  const targetField = (field: 'integratedLufs' | 'truePeakCeilingDbtp', label: string, unit: string) => {
    const id = `clip-loudness-target-${field}-${state.clipId}`;
    return <div><Label htmlFor={id}>{label}</Label><div className="clip-loudness-target-input"><Input id={id} data-testid={`clip-loudness-target-${field}`} type="text" inputMode="decimal" maxLength={16}
      value={state.targetDraft?.[field] ?? ''} disabled={!state.visible || !state.connected} aria-invalid={!target && !state.targetComposing}
      onChange={event => controller.editTarget(state, field, event.target.value)} onKeyDown={stopTargetSubmit}
      onCompositionStart={() => controller.setTargetComposing(state, true)} onCompositionEnd={() => controller.setTargetComposing(state, false)} /><span>{unit}</span></div></div>;
  };
  return <section className="timeline-clip-loudness clip-loudness-card" data-testid="timeline-clip-loudness" aria-label={t('audio.loudness.clip.title')}>
    <div className="clip-loudness-heading"><strong>{t('audio.loudness.clip.title')}</strong><Button type="button" variant="outline" size="sm" data-testid="clip-loudness-analyze" disabled={!available || preparing || matching && !target} aria-describedby={statusId} onClick={() => { void controller.prepare(state); }}>{t('audio.loudness.clip.analyze')}</Button></div>
    <dl className="clip-loudness-metrics" data-testid={report ? 'clip-loudness-measurement' : 'clip-loudness-empty'}><div><dt>{t('round3.audio.integrated')}</dt><dd>{!report ? '—' : report.measurement.integratedLufs === null ? t(`audio.loudness.state.${report.measurement.state}`) : t('audio.loudness.clip.integratedValue', { value: number(report.measurement.integratedLufs) })}</dd></div><div><dt>{t('round3.audio.truePeak')}</dt><dd>{report ? peak(report.measurement.truePeakDbtp, 'dBTP') : '—'}</dd></div></dl>
    {matching && <>
      <dl className="clip-loudness-metrics clip-loudness-range-metric"><div><dt>{t('audio.loudness.match.range')}</dt><dd data-testid="clip-loudness-lra">{!report?.loudnessRange ? '—' : report.loudnessRange.loudnessRangeLu === null ? t(report.loudnessRange.state === 'too_short' ? 'audio.loudness.match.rangeShort' : 'audio.loudness.match.rangeUnavailable') : t('audio.loudness.match.rangeValue', { value: number(report.loudnessRange.loudnessRangeLu) })}</dd></div></dl>
      <div className="clip-loudness-targets" data-testid="clip-loudness-targets">{targetField('integratedLufs', t('audio.loudness.match.target'), 'LUFS')}{targetField('truePeakCeilingDbtp', t('audio.loudness.match.ceiling'), 'dBTP')}</div>
      {!target && !state.targetComposing && <p role="status" data-testid="clip-loudness-target-invalid">{t('audio.loudness.match.targetInvalid')}</p>}
      {candidate && <div className="clip-loudness-candidate" data-testid="clip-loudness-candidate">
        {candidate.status === 'unavailable' ? <p role="status">{t(candidate.reason === 'GAIN_OUT_OF_RANGE' ? 'audio.loudness.match.gainOutOfRange' : 'audio.loudness.match.noValidLoudness')}</p> : <>
          <dl className="clip-loudness-metrics"><div><dt>{t('audio.loudness.match.afterLoudness')}</dt><dd>{candidate.measurement.integratedLufs === null ? '—' : t('audio.loudness.clip.integratedValue', { value: number(candidate.measurement.integratedLufs) })}</dd></div><div><dt>{t('audio.loudness.match.afterPeak')}</dt><dd>{peak(candidate.measurement.truePeakDbtp, 'dBTP')}</dd></div><div><dt>{t('audio.loudness.match.gain')}</dt><dd>{t('audio.loudness.match.gainValue', { value: number(Math.abs(candidate.requiredGainDb) < .005 ? 0 : candidate.requiredGainDb) })}</dd></div></dl>
          {!candidate.meetsTruePeak ? <p role="status">{t('audio.loudness.match.peakConflict')}</p> : !candidate.meetsTarget ? <p role="status">{t('audio.loudness.match.targetMissed')}</p> : candidate.afterGain === candidate.beforeGain || Math.abs(candidate.requiredGainDb) <= TIMELINE_CLIP_LOUDNESS_TARGET_TOLERANCE_LU ? <p role="status">{t('audio.loudness.match.alreadyMatched')}</p> : null}
        </>}
        <Button type="button" variant="outline" size="sm" data-testid="clip-loudness-match" disabled={!timelineClipLoudnessMatchable(state)} onClick={() => { controller.match(state); }}>{t('audio.loudness.match.stage')}</Button>
      </div>}
    </>}
    <p className="input-hint">{t('round3.audio.measurementScope')}</p>
    {!available && <p className="clip-loudness-blocked" data-testid="clip-loudness-blocked">{state.durationFrames > TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames ? t('audio.loudness.clip.tooLong') : t(state.restored ? 'audio.loudness.clip.restored' : !state.audioSupported || state.muted || state.gain <= 0 ? 'audio.loudness.clip.inaudible' : 'audio.loudness.clip.blocked')}</p>}
    <div id={statusId} role="status" aria-live="polite" aria-atomic="true">{status && <p data-testid="clip-loudness-status">{status}</p>}</div>
    {preparing && available && <Button type="button" variant="ghost" size="sm" data-testid="clip-loudness-cancel" onClick={() => controller.cancel(state)}>{t('audio.loudness.cancelObservation')}</Button>}
    <details className="clip-audio-help"><summary>{t('round3.audio.learnMore')}</summary>
      <p data-testid="clip-loudness-limit">{t('audio.loudness.clip.durationLimit', { seconds: TIMELINE_CLIP_LOUDNESS_LIMITS.clipSeconds })}</p>
      <p data-testid="clip-loudness-limitation">{t(matching ? 'audio.loudness.match.limitation' : 'audio.loudness.clip.limitation')}</p>
      {!matching && <p data-testid="clip-loudness-missing-metrics">{t('round3.audio.missingMetrics')}</p>}
      {matching && <p>{t('audio.loudness.match.rangeLimitation')}</p>}
      {report && <>
        <p>{t('round3.audio.samplePeak')} {peak(report.measurement.samplePeakDbfs, 'dBFS')}</p>
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
    </details>
  </section>;
}
