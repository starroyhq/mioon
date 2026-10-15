import { translate } from '../../../packages/i18n/src/index.ts';
import type { Locale } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import type { ExportLoudnessMeasurement } from '@mioon/contracts/export-loudness';
import { TIMELINE_MIX_LOUDNESS_LABEL, TIMELINE_MIX_LOUDNESS_LIMITATION, parseTimelineMixLoudnessTarget, timelineMixLoudnessAvailable, timelineMixLoudnessStatusMessage } from './timeline-mix-loudness-state.ts';
import type { TimelineMixLoudnessView } from './timeline-mix-loudness-state.ts';

export interface TimelineMixLoudnessProps { readonly loudness: TimelineMixLoudnessView; readonly apply?: React.ReactNode; readonly onRevokeApply?: () => void }
const fixed = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
const peak = (value: number | null, unit: string, locale: Locale): string => value === null ? translate(locale, 'audio.loudness.silence', { unit }) : `${fixed(value)} ${unit}`;
function Measurement({ value, label, testId }: { readonly value: ExportLoudnessMeasurement; readonly label: string; readonly testId: string }) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  return <p data-testid={testId}>{label}：{value.integratedLufs === null ? t(`audio.loudness.state.${value.state}`) : `${fixed(value.integratedLufs)} LUFS`}<br />
    {t('audio.loudness.mix.peaks', { truePeak: peak(value.truePeakDbtp, 'dBTP', locale), sample: peak(value.samplePeakDbfs, 'dBFS', locale) })}</p>;
}

/** Read-only observation with a separately owned, explicit human apply control. */
export default function TimelineMixLoudness({ loudness, apply, onRevokeApply }: TimelineMixLoudnessProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const { state, controller } = loudness;
  if (!timelineMixLoudnessAvailable(state)) return apply ?? null;
  const parsed = parseTimelineMixLoudnessTarget(state.draft, locale), preparing = state.phase === 'preparing', report = state.report;
  const status = timelineMixLoudnessStatusMessage(state, locale), targetError = Boolean(parsed.error && (state.draft.integratedLufs || state.draft.truePeakCeilingDbtp));
  const prefix = `timeline-mix-loudness-${state.timelineId}`, statusId = `${prefix}-status`, errorId = `${prefix}-error`;
  return <details className="export-sample-peak timeline-mix-loudness" data-testid="timeline-mix-loudness" style={{ minWidth: 0, maxWidth: '100%' }}
    onToggle={event => { if (!event.currentTarget.open) { controller.revoke(state); onRevokeApply?.(); } }}>
    <summary className="export-sample-peak-label">{t('audio.loudness.mix.label')}</summary>
    <p data-testid="timeline-mix-loudness-scope">{t('audio.loudness.mix.scope', { end: formatNumber(state.durationFrames), revision: state.revision ?? '' })}</p>
    <p>{t('audio.loudness.mix.targetHelp')}</p>
    <label htmlFor={`${prefix}-lufs`} style={{ display: 'block', marginTop: 6 }}>{t('audio.loudness.target.lufs')}</label>
    <Input id={`${prefix}-lufs`} type="number" min={-60} max={-5} step="any" data-testid="timeline-mix-loudness-target-lufs"
      style={{ minWidth: 0, maxWidth: '100%', fontSize: 12 }} value={state.draft.integratedLufs}
      aria-invalid={targetError} aria-describedby={targetError ? errorId : undefined}
      onChange={event => controller.setDraft({ ...state.draft, integratedLufs: event.target.value }, state)} />
    <label htmlFor={`${prefix}-peak`} style={{ display: 'block', marginTop: 6 }}>{t('audio.loudness.target.peak')}</label>
    <Input id={`${prefix}-peak`} type="number" min={-20} max={0} step="any" data-testid="timeline-mix-loudness-target-peak"
      style={{ minWidth: 0, maxWidth: '100%', fontSize: 12 }} value={state.draft.truePeakCeilingDbtp}
      aria-invalid={targetError} aria-describedby={targetError ? errorId : undefined}
      onChange={event => controller.setDraft({ ...state.draft, truePeakCeilingDbtp: event.target.value }, state)} />
    {targetError && <p id={errorId} role="alert" data-testid="timeline-mix-loudness-target-error">{parsed.error}</p>}
    <div className="export-sample-peak-actions">
      <Button variant="ghost" type="button" className="button quiet small" data-testid="timeline-mix-loudness-prepare"
        disabled={preparing || !parsed.target} aria-describedby={statusId} onClick={() => { void controller.prepare(state); }}>{state.phase === 'idle' ? t('audio.loudness.mix.prepare') : t('audio.loudness.mix.prepareAgain')}</Button>
      {preparing && <Button variant="ghost" type="button" className="button quiet small" data-testid="timeline-mix-loudness-cancel"
        onClick={() => controller.cancel(state)}>{t('audio.loudness.cancelObservation')}</Button>}
    </div>
    <div id={statusId} className="export-sample-peak-status" role="status" aria-live="polite" aria-atomic="true">
      {status && <p data-testid="timeline-mix-loudness-status">{status}</p>}
      {report && <>
        <p data-testid="timeline-mix-loudness-captured-target">{t('audio.loudness.mix.target', { lufs: report.target.integratedLufs, peak: report.target.truePeakCeilingDbtp, margin: report.candidate.marginDb })}</p>
        <Measurement value={report.original} label={t('audio.loudness.mix.original')} testId="timeline-mix-loudness-original" />
        {report.candidate.status === 'measured' ? <>
          <Measurement value={report.candidate.measurement} label={t('audio.loudness.mix.candidate')} testId="timeline-mix-loudness-candidate" />
          <p data-testid="timeline-mix-loudness-gain">{t('audio.loudness.mix.gain', { gain: fixed(report.candidate.requiredGainDb), multiplier: report.candidate.gainMultiplier.toFixed(4), count: report.candidate.gains.length })}</p>
          <p data-testid="timeline-mix-loudness-comparison">{t('audio.loudness.mix.comparison', { target: t(report.candidate.meetsTarget ? 'audio.loudness.yes' : 'audio.loudness.no'), peak: t(report.candidate.meetsTruePeak ? 'audio.loudness.yes' : 'audio.loudness.no') })}</p>
          {(!report.candidate.meetsTarget || !report.candidate.meetsTruePeak) && <p className="notice warning" data-testid="timeline-mix-loudness-conflict">{t('audio.loudness.mix.conflict')}</p>}
        </> : <p data-testid="timeline-mix-loudness-unavailable">{t('audio.loudness.mix.unavailable', { reason: t(report.candidate.reason === 'NO_VALID_LOUDNESS' ? 'audio.loudness.mix.noLoudness' : 'audio.loudness.mix.gainBounds') })}</p>}
        <details><summary>{t('audio.loudness.mix.details')}</summary>
          <p>{t('audio.loudness.projectId')}{report.projectId}<br />{t('audio.loudness.mix.timelineId')}{report.identity.timelineId}<br />{t('audio.loudness.mix.savedRevision', { revision: report.identity.timelineRevision })}<br />{t('audio.loudness.snapshotHash')}{report.identity.snapshotSha256}
            <br />{t('audio.loudness.mix.fullRange', { end: formatNumber(report.identity.range.endFrame) })}<br />{t('audio.loudness.mix.fullSamples', { frames: formatNumber(report.identity.range.sampleFrames) })}
            <br />{t('audio.loudness.mix.profile')}{report.mixProfile}<br />{t('audio.loudness.profile')}{report.measurementProfile}<br />{t('audio.loudness.mix.authority')}</p>
          {report.identity.sources.map(source => <p key={source.assetId}>{t('audio.loudness.mix.source', { id: source.assetId })}<br />SHA-256：{source.sha256} · {t('audio.loudness.mix.bytes', { bytes: formatNumber(source.sizeBytes) })}</p>)}
          {report.candidate.gains.map(gain => <p key={gain.clipId}>{t('audio.loudness.mix.clipGain', { id: gain.clipId, before: gain.beforeGain.toFixed(4), after: gain.afterGain.toFixed(4) })}</p>)}
          <p>{t('audio.loudness.measuredAt')}<time dateTime={report.checkedAt}>{formatDate(report.checkedAt, { dateStyle: 'medium', timeStyle: 'medium' })}</time></p>
        </details>
      </>}
    </div>
    <p className="export-sample-peak-limitation">{t('audio.loudness.mix.limitation')}</p>
    {apply}
  </details>;
}
