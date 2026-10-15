import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useId } from 'react';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Button } from '@mioon/ui/components/button';
import { EXPORT_RANGE_HELP, exportRangeDescription } from './export-range-state.ts';
import type { ExportRangeDraft } from './export-range-state.ts';
import type { TimelineExportRange } from '@mioon/contracts/timeline-export-range';

export interface ExportRangeControlsProps {
  draft?: Readonly<ExportRangeDraft>;
  value?: Readonly<TimelineExportRange> | null;
  durationFrames?: number;
  error?: string;
  disabled?: boolean;
  onChange?: (draft: ExportRangeDraft) => void;
}
export default function ExportRangeControls({ draft = { mode: 'whole', startText: '', endText: '' }, value, durationFrames, error = '', disabled = false, onChange }: ExportRangeControlsProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const id = useId(), summary = value ? exportRangeDescription({ exportRange: value }, durationFrames) : null;
  const extent = typeof durationFrames === 'number' && Number.isSafeInteger(durationFrames) && durationFrames > 0 && durationFrames <= 18000 ? durationFrames : null;
  return <section className="timeline-export-settings" data-testid="export-range-controls" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{t('export.range.title')}</h3>
    <p id={`${id}-help`} className="export-preflight-note">{t('export.range.help')}</p>
    <div className="clip-form-actions" role="group" aria-label={t('export.range.label')}>
      <Button type="button" size="sm" variant="outline" data-testid="export-range-whole" aria-pressed={draft.mode === 'whole'} disabled={disabled} onClick={() => onChange?.({ ...draft, mode: 'whole' })}>{t('export.range.whole')}</Button>
      <Button type="button" size="sm" variant="outline" data-testid="export-range-selected" aria-pressed={draft.mode === 'selected'} disabled={disabled} onClick={() => onChange?.({ ...draft, mode: 'selected', ...(draft.startText === '' && draft.endText === '' && extent !== null ? { startText: '0', endText: String(extent) } : {}) })}>{t('export.range.choose')}</Button>
    </div>
    <p className="export-preflight-note">{t('export.range.fixed', { extent: extent === null ? t('export.range.durationUnavailable') : t('export.range.extent', { frames: formatNumber(extent) }) })}</p>
    {draft.mode === 'selected' && <>
      <div className="export-settings-field"><Label htmlFor={`${id}-start`}>{t('export.range.start')}</Label><Input id={`${id}-start`} data-testid="export-range-start" type="text" inputMode="numeric" value={draft.startText} disabled={disabled} autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} onChange={event => onChange?.({ ...draft, startText: event.currentTarget.value })} /></div>
      <div className="export-settings-field"><Label htmlFor={`${id}-end`}>{t('export.range.end')}</Label><Input id={`${id}-end`} data-testid="export-range-end" type="text" inputMode="numeric" value={draft.endText} disabled={disabled} autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} onChange={event => onChange?.({ ...draft, endText: event.currentTarget.value })} /></div>
      <p className="export-preflight-note">{t('export.range.boundsHelp')}</p>
    </>}
    {error && <p id={`${id}-error`} className="notice error" role="alert" data-testid="export-range-error">{t('export.range.invalid')}</p>}
    {summary && <p className="export-preflight-note" data-testid="export-range-output">{t('export.range.output', { start: formatNumber(summary.startFrame), end: formatNumber(summary.endFrame), frames: formatNumber(summary.frames), seconds: summary.seconds })}</p>}
  </section>;
}
