import { translate } from '../../../packages/i18n/src/index.ts';
import type { Locale } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { EXPORT_LOUDNESS_LABEL, EXPORT_LOUDNESS_LIMITATION, EXPORT_LOUDNESS_RESTORED, exportLoudnessStatusMessage, parseExportLoudnessTarget } from './export-loudness-state.ts';
import type { ExportLoudnessView } from './export-loudness-state.ts';

export interface ExportLoudnessProps { readonly exportId: string; readonly loudness?: ExportLoudnessView }
const fixed = (value: number, digits = 2): string => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
export function formatExportLoudnessValue(value: number | null, unit: string, locale: Locale = 'zh-Hans'): string { return value === null ? translate(locale, 'audio.loudness.silence', { unit }) : `${fixed(value)} ${unit}`; }

/** This row never edits the timeline or treats arithmetic advice as permission. */
export default function ExportLoudness({ exportId, loudness }: ExportLoudnessProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  if (!loudness) return null;
  const { state, controller } = loudness, target = state.targets.find(item => item.exportId === exportId);
  if (!target) return null;
  const selected = state.targetId === exportId && state.targetKey === target.key;
  const busy = state.phase === 'measuring', measuring = selected && busy;
  const draft = selected ? state.draft : { integratedLufs: '', truePeakCeilingDbtp: '' }, parsed = parseExportLoudnessTarget(draft, locale);
  const report = selected ? state.report : null, ready = report?.status === 'ready' ? report : null;
  const statusId = `export-loudness-status-${exportId}`, targetId = `export-loudness-target-${exportId}`, targetErrorId = `${targetId}-error`;
  const status = selected ? exportLoudnessStatusMessage(state, locale) : '';
  const disabled = !state.connected || !state.visible || state.restored;
  return <section className="export-sample-peak export-loudness" data-testid="export-loudness" aria-label={t('audio.loudness.export.label')}>
    <strong className="export-sample-peak-label">{t('audio.loudness.export.label')}</strong>
    {state.restored ? <p data-testid="export-loudness-unavailable">{t('audio.loudness.export.restored')}</p> : <>
      <details className="export-loudness-target" style={{ minWidth: 0, maxWidth: '100%' }}>
        <summary>{t('audio.loudness.target.optional')}</summary>
        <p>{t('audio.loudness.target.optionalHelp')}</p>
        <label htmlFor={`${targetId}-lufs`} style={{ display: 'block', marginTop: 6 }}>{t('audio.loudness.target.lufs')}</label>
        <Input id={`${targetId}-lufs`} type="number" min={-60} max={-5} step="any" data-testid="export-loudness-target-lufs"
          style={{ minWidth: 0, maxWidth: '100%', fontSize: 12 }} value={draft.integratedLufs} disabled={disabled}
          aria-invalid={Boolean(parsed.error)} aria-describedby={parsed.error ? targetErrorId : undefined}
          onChange={event => controller.setDraft(target, state.scope, { ...draft, integratedLufs: event.target.value }, state.draftVersion)} />
        <label htmlFor={`${targetId}-peak`} style={{ display: 'block', marginTop: 6 }}>{t('audio.loudness.target.peak')}</label>
        <Input id={`${targetId}-peak`} type="number" min={-20} max={0} step="any" data-testid="export-loudness-target-peak"
          style={{ minWidth: 0, maxWidth: '100%', fontSize: 12 }} value={draft.truePeakCeilingDbtp} disabled={disabled}
          aria-invalid={Boolean(parsed.error)} aria-describedby={parsed.error ? targetErrorId : undefined}
          onChange={event => controller.setDraft(target, state.scope, { ...draft, truePeakCeilingDbtp: event.target.value }, state.draftVersion)} />
        {parsed.error && <p id={targetErrorId} role="alert" data-testid="export-loudness-target-error">{parsed.error}</p>}
      </details>
      <div className="export-sample-peak-actions">
        <Button variant="ghost" type="button" className="button quiet small" data-testid="export-loudness-measure" disabled={busy || disabled || Boolean(parsed.error)}
          aria-label={`${selected && state.phase !== 'idle' ? t('audio.loudness.measureAgain') : t('audio.loudness.measure')}${t('audio.loudness.export.label')}`} aria-describedby={statusId}
          onClick={() => { void controller.measure(target, state.scope, state.draftVersion); }}>{selected && state.phase !== 'idle' ? t('audio.loudness.measureAgain') : t('audio.loudness.measure')}</Button>
        {measuring && <Button variant="ghost" type="button" className="button quiet small" data-testid="export-loudness-cancel"
          onClick={() => controller.cancel(target, state.scope, state.draftVersion)}>{t('audio.loudness.cancelObservation')}</Button>}
      </div>
    </>}
    <div id={statusId} className="export-sample-peak-status" role="status" aria-live="polite" aria-atomic="true">
      {measuring ? <p>{status}</p> : ready ? <>
        <p data-testid="export-loudness-range">{t('audio.loudness.fileRevision', { file: t(ready.artifact.exportRange ? 'audio.loudness.selectedFile' : 'audio.loudness.fullFile'), revision: ready.artifact.timelineRevision })}</p>
        <p data-testid="export-loudness-integrated">{t('audio.loudness.integratedLabel')}{ready.measurement.integratedLufs === null ? t(`audio.loudness.state.${ready.measurement.state}`) : `${fixed(ready.measurement.integratedLufs)} LUFS`}</p>
        <p data-testid="export-loudness-true-peak">{t('audio.loudness.truePeakLabel')}{formatExportLoudnessValue(ready.measurement.truePeakDbtp, 'dBTP', locale)}</p>
        <p data-testid="export-loudness-sample-peak">{t('audio.loudness.samplePeakLabel')}{formatExportLoudnessValue(ready.measurement.samplePeakDbfs, 'dBFS', locale)}</p>
        {ready.target && <p data-testid="export-loudness-captured-target">{t('audio.loudness.targetValue', { lufs: formatNumber(ready.target.integratedLufs), peak: formatNumber(ready.target.truePeakCeilingDbtp) })}</p>}
        {ready.suggestion ? <>
          <p data-testid="export-loudness-advice">{t('audio.loudness.advice', { gain: fixed(ready.suggestion.requiredGainDb), room: fixed(ready.suggestion.truePeakRoomDb) })}</p>
          {ready.suggestion.conflictsWithCeiling && <p className="notice warning" data-testid="export-loudness-conflict">{t('audio.loudness.conflict')}</p>}
          <p>{t('audio.loudness.adviceHelp')}</p>
        </> : ready.target ? <p>{t('audio.loudness.noAdvice')}</p> : null}
        <details><summary>{t('audio.loudness.details')}</summary>
          <p>{t('audio.loudness.projectId')}{ready.projectId}<br />{t('audio.loudness.exportId')}{ready.exportId}<br />{t('audio.loudness.assetId')}{ready.artifact.assetId}<br />SHA-256：{ready.artifact.sha256}<br />{t('audio.loudness.snapshotHash')}{ready.artifact.snapshotSha256}<br />{t('audio.loudness.frozenRevision', { revision: ready.artifact.timelineRevision })}
            {ready.artifact.exportRange && <><br />{t('audio.loudness.frozenRange', { start: formatNumber(ready.artifact.exportRange.startFrame), end: formatNumber(ready.artifact.exportRange.endFrame) })}</>}
            <br />{t('audio.loudness.profile')}{ready.measurementProfile}<br />{t('audio.loudness.stage')}<br />{t('audio.loudness.sampleFrames', { frames: formatNumber(ready.measurement.sampleFrames) })}<br />{t('audio.loudness.duration', { seconds: formatNumber(ready.measurement.decodedDurationSeconds, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) })}
            <br />{t('audio.loudness.stateLabel')}{t(`audio.loudness.state.${ready.measurement.state}`)}<br />{t('audio.loudness.gating', { all: formatNumber(ready.measurement.gatingBlockCount), absolute: formatNumber(ready.measurement.absoluteGatedBlockCount), relative: formatNumber(ready.measurement.relativeGatedBlockCount) })}
            <br />{t('audio.loudness.relativeGate')}{ready.measurement.relativeGateLufs === null ? t('audio.loudness.unavailable') : `${fixed(ready.measurement.relativeGateLufs)} LUFS`}
            <br />{t('audio.loudness.linearPeaks', { sample: formatNumber(ready.measurement.samplePeakLinear), truePeak: formatNumber(ready.measurement.truePeakLinear) })}
            <br />{t('audio.loudness.measuredAt')}<time dateTime={ready.checkedAt}>{formatDate(ready.checkedAt, { dateStyle: 'medium', timeStyle: 'medium' })}</time></p>
          {ready.suggestion && <p>{t('audio.loudness.projection', { multiplier: ready.suggestion.gainMultiplier.toFixed(4), peak: fixed(ready.suggestion.projectedTruePeakDbtp), margin: ready.suggestion.marginDb })}</p>}
        </details>
      </> : status ? <p data-testid="export-loudness-not-ready">{status}</p> : busy && !state.restored ? <p>{t('audio.loudness.another')}</p> : !state.connected && !state.restored ? <p>{t('audio.loudness.reconnect')}</p> : null}
    </div>
    <p className="export-sample-peak-limitation">{t('audio.loudness.export.limitation')}</p>
  </section>;
}
