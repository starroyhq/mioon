import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { TIMELINE_CLIP_LOUDNESS_LIMITS } from '@mioon/contracts/timeline-clip-loudness';
import { useI18n } from './i18n/I18nProvider.tsx';
import { dialogueLoudnessAvailable, dialogueLoudnessGains, dialogueLoudnessRows, dialogueLoudnessStatusMessage, dialogueLoudnessSuggested, parseDialogueLoudnessTarget } from './dialogue-loudness-state.ts';
import type { DialogueLoudnessRow, DialogueLoudnessView } from './dialogue-loudness-state.ts';

export interface TimelineDialogueLoudnessProps { readonly loudness: DialogueLoudnessView }
const signed = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
const level = (value: number | null | undefined): string => value === null || value === undefined ? '—' : value.toFixed(1);

function RowDetail({ row }: { readonly row: DialogueLoudnessRow }) {
  const { t } = useI18n();
  const seconds = TIMELINE_CLIP_LOUDNESS_LIMITS.clipSeconds;
  if (row.status === 'skipped') return <p>{t(`audio.loudness.dialogue.${row.skip ?? 'noSource'}`, { seconds })}</p>;
  if (row.status === 'waiting') return <p>{t('audio.loudness.dialogue.waiting')}</p>;
  if (row.status === 'measuring') return <p>{t('audio.loudness.dialogue.measuring')}</p>;
  if (row.status === 'failed') return <p className="notice warning">{t('audio.loudness.dialogue.failed', { reason: row.error ?? '' })}</p>;
  const current = t('audio.loudness.dialogue.current', { lufs: level(row.integratedLufs), peak: level(row.truePeakDbtp) });
  if (row.status === 'unavailable') return <p>{current}<br />{t(row.reason === 'GAIN_OUT_OF_RANGE' ? 'audio.loudness.dialogue.gainRange' : 'audio.loudness.dialogue.noLoudness')}</p>;
  if (row.afterGain === row.gain || !dialogueLoudnessSuggested(row) && row.meetsTruePeak) return <p>{current}<br />{t('audio.loudness.dialogue.close')}</p>;
  return <p>{current}<br />{t('audio.loudness.dialogue.suggest', { db: signed(row.requiredGainDb ?? 0), before: row.gain.toFixed(2), after: (row.afterGain ?? row.gain).toFixed(2) })}
    {row.meetsTruePeak === false && <><br /><span className="notice warning" data-testid={`dialogue-loudness-peak-${row.clipId}`}>{t('audio.loudness.dialogue.peakRisk', { peak: level(row.afterTruePeakDbtp) })}</span></>}</p>;
}

/** Explicit, per-clip measurement of every human-voice clip with one reviewed apply. */
export default function TimelineDialogueLoudness({ loudness }: TimelineDialogueLoudnessProps) {
  const { t, locale } = useI18n();
  const { state, controller } = loudness;
  // The apply's own pending edit closes the fences; keep the card mounted, and open, until it settles.
  if (!dialogueLoudnessAvailable(state) && state.phase !== 'applying') return null;
  const parsed = parseDialogueLoudnessTarget(state.draft, locale), measuring = state.phase === 'measuring', applying = state.phase === 'applying';
  const targetError = Boolean(parsed.error && (state.draft.integratedLufs || state.draft.truePeakCeilingDbtp));
  const measurable = state.clips.some(clip => clip.audioRole === 'human');
  // Before measuring, show why nothing can be measured when every line is skipped.
  const preview = state.rows.length ? null : dialogueLoudnessRows(state), waiting = !preview || preview.some(row => row.status === 'waiting');
  const rows = preview ? waiting ? [] : preview : state.rows;
  const gains = dialogueLoudnessGains(state), status = dialogueLoudnessStatusMessage(state, locale);
  const prefix = `dialogue-loudness-${state.timelineId}`, statusId = `${prefix}-status`, errorId = `${prefix}-error`;
  return <details className="export-sample-peak timeline-dialogue-loudness" data-testid="timeline-dialogue-loudness" style={{ minWidth: 0, maxWidth: '100%' }}
    onToggle={event => { if (!event.currentTarget.open) controller.revoke(state); }}>
    <summary className="export-sample-peak-label">{t('audio.loudness.dialogue.label')}</summary>
    <p>{t('audio.loudness.dialogue.help')}</p>
    {!measurable ? <p data-testid="dialogue-loudness-none">{t('audio.loudness.dialogue.none')}</p> : <>
      <label htmlFor={`${prefix}-lufs`} style={{ display: 'block', marginTop: 6 }}>{t('audio.loudness.target.lufs')}</label>
      <Input id={`${prefix}-lufs`} type="number" min={-60} max={-5} step="any" data-testid="dialogue-loudness-target-lufs" disabled={measuring || applying}
        style={{ minWidth: 0, maxWidth: '100%', fontSize: 12 }} value={state.draft.integratedLufs}
        aria-invalid={targetError} aria-describedby={targetError ? errorId : undefined}
        onChange={event => controller.setDraft({ ...state.draft, integratedLufs: event.target.value }, state)} />
      <label htmlFor={`${prefix}-peak`} style={{ display: 'block', marginTop: 6 }}>{t('audio.loudness.target.peak')}</label>
      <Input id={`${prefix}-peak`} type="number" min={-20} max={0} step="any" data-testid="dialogue-loudness-target-peak" disabled={measuring || applying}
        style={{ minWidth: 0, maxWidth: '100%', fontSize: 12 }} value={state.draft.truePeakCeilingDbtp}
        aria-invalid={targetError} aria-describedby={targetError ? errorId : undefined}
        onChange={event => controller.setDraft({ ...state.draft, truePeakCeilingDbtp: event.target.value }, state)} />
      {targetError && <p id={errorId} role="alert" data-testid="dialogue-loudness-target-error">{parsed.error}</p>}
      <div className="export-sample-peak-actions">
        <Button variant="ghost" type="button" className="button quiet small" data-testid="dialogue-loudness-analyze"
          disabled={measuring || applying || !parsed.target || !waiting} aria-describedby={statusId} onClick={() => { void controller.analyze(state); }}>
          {state.phase === 'idle' ? t('audio.loudness.dialogue.analyze') : t('audio.loudness.dialogue.analyzeAgain')}</Button>
        {measuring && <Button variant="ghost" type="button" className="button quiet small" data-testid="dialogue-loudness-stop"
          onClick={() => controller.cancel(state)}>{t('audio.loudness.dialogue.stop')}</Button>}
      </div>
    </>}
    <div id={statusId} className="export-sample-peak-status" role="status" aria-live="polite" aria-atomic="true">
      {status && <p data-testid="dialogue-loudness-status">{status}</p>}
    </div>
    {rows.length > 0 && <ul className="dialogue-loudness-rows" data-testid="dialogue-loudness-rows">
      {rows.map(row => <li key={row.clipId} className="dialogue-loudness-row" data-testid={`dialogue-loudness-row-${row.clipId}`} data-status={row.status}>
        <label className="dialogue-loudness-name">
          {row.status === 'measured' && row.afterGain !== row.gain && <input type="checkbox" checked={row.selected} disabled={state.phase !== 'ready'}
            data-testid={`dialogue-loudness-select-${row.clipId}`} aria-label={t('audio.loudness.dialogue.select', { name: row.name })}
            onChange={event => controller.toggle(row.clipId, event.target.checked, state)} />}
          <span>{row.name} · {row.trackName}</span>
        </label>
        <RowDetail row={row} />
      </li>)}
    </ul>}
    {(state.phase === 'ready' || applying) && <div className="export-sample-peak-actions">
      <Button type="button" className="button small" data-testid="dialogue-loudness-apply" disabled={applying || !gains.length}
        onClick={() => { void controller.apply(state); }}>{t('audio.loudness.dialogue.apply', { count: gains.length })}</Button>
      <p className="input-hint">{t('audio.loudness.dialogue.applyHint')}</p>
    </div>}
    <p className="export-sample-peak-limitation">{t('audio.loudness.dialogue.limitation', { seconds: TIMELINE_CLIP_LOUDNESS_LIMITS.clipSeconds })}</p>
  </details>;
}
