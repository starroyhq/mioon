import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { isTimelineExportRangeInput, isTimelineExportRangeSnapshot } from '@mioon/contracts/timeline-export-range';
import { exportRangeDescription } from './export-range-state.ts';

export interface ExportRangeSummaryProps { input: unknown; snapshot?: boolean; durationFrames?: unknown; label?: string; showWhole?: boolean; testId?: string }
/** Uses only an original input or validated frozen snapshot, never form state. */
export default function ExportRangeSummary({ input, snapshot = false, durationFrames, label, showWhole = false, testId = 'export-range-summary' }: ExportRangeSummaryProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const object = input !== null && typeof input === 'object' && !Array.isArray(input);
  const present = object && Object.hasOwn(input, 'exportRange');
  if (!present && !showWhole) return null;
  const valid = isTimelineExportRangeInput(input) && (!snapshot || isTimelineExportRangeSnapshot(input, { purpose: 'export' }));
  const summary = valid && present ? exportRangeDescription(input, durationFrames) : null;
  return <small className="export-frozen-settings" data-testid={testId}>{label ?? t('export.range.label')}：{!valid || present && !summary ? t('export.range.unavailable') : summary ? t('export.range.summary', { start: formatNumber(summary.startFrame), end: formatNumber(summary.endFrame), frames: formatNumber(summary.frames), seconds: summary.seconds }) : t('export.range.originalWhole')}</small>;
}
