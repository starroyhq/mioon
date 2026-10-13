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
  const id = useId(), summary = value ? exportRangeDescription({ exportRange: value }, durationFrames) : null;
  const extent = typeof durationFrames === 'number' && Number.isSafeInteger(durationFrames) && durationFrames > 0 && durationFrames <= 18000 ? durationFrames : null;
  return <section className="timeline-export-settings" data-testid="export-range-controls" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>本次导出范围</h3>
    <p id={`${id}-help`} className="export-preflight-note">{EXPORT_RANGE_HELP}</p>
    <div className="clip-form-actions" role="group" aria-label="导出范围">
      <Button type="button" size="sm" variant="outline" data-testid="export-range-whole" aria-pressed={draft.mode === 'whole'} disabled={disabled} onClick={() => onChange?.({ ...draft, mode: 'whole' })}>全部已保存时间线</Button>
      <Button type="button" size="sm" variant="outline" data-testid="export-range-selected" aria-pressed={draft.mode === 'selected'} disabled={disabled} onClick={() => onChange?.({ ...draft, mode: 'selected', ...(draft.startText === '' && draft.endText === '' && extent !== null ? { startText: '0', endText: String(extent) } : {}) })}>选择导出范围</Button>
    </div>
    <p className="export-preflight-note">固定 30 fps · {extent === null ? '已保存时间线时长不可用' : `已保存时间线共 ${extent} 帧`}</p>
    {draft.mode === 'selected' && <>
      <div className="export-settings-field"><Label htmlFor={`${id}-start`}>开始帧（包含）</Label><Input id={`${id}-start`} data-testid="export-range-start" type="text" inputMode="numeric" value={draft.startText} disabled={disabled} autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} onChange={event => onChange?.({ ...draft, startText: event.currentTarget.value })} /></div>
      <div className="export-settings-field"><Label htmlFor={`${id}-end`}>结束帧（不包含）</Label><Input id={`${id}-end`} data-testid="export-range-end" type="text" inputMode="numeric" value={draft.endText} disabled={disabled} autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} onChange={event => onChange?.({ ...draft, endText: event.currentTarget.value })} /></div>
      <p className="export-preflight-note">范围为左闭右开，至少 1 帧。开始帧从 0 起，结束帧不超过已保存时间线。</p>
    </>}
    {error && <p id={`${id}-error`} className="notice error" role="alert" data-testid="export-range-error">{error}</p>}
    {summary && <p className="export-preflight-note" data-testid="export-range-output">本次范围 [{summary.startFrame}, {summary.endFrame}) · {summary.frames} 帧 · {summary.seconds} 秒</p>}
  </section>;
}
