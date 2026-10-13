import React from 'react';
import { isTimelineExportRangeInput, isTimelineExportRangeSnapshot } from '@mioon/contracts/timeline-export-range';
import { exportRangeDescription } from './export-range-state.ts';

export interface ExportRangeSummaryProps { input: unknown; snapshot?: boolean; durationFrames?: unknown; label?: string; showWhole?: boolean; testId?: string }
/** Uses only an original input or validated frozen snapshot, never form state. */
export default function ExportRangeSummary({ input, snapshot = false, durationFrames, label = '导出范围', showWhole = false, testId = 'export-range-summary' }: ExportRangeSummaryProps) {
  const object = input !== null && typeof input === 'object' && !Array.isArray(input);
  const present = object && Object.hasOwn(input, 'exportRange');
  if (!present && !showWhole) return null;
  const valid = isTimelineExportRangeInput(input) && (!snapshot || isTimelineExportRangeSnapshot(input, { purpose: 'export' }));
  const summary = valid && present ? exportRangeDescription(input, durationFrames) : null;
  return <small className="export-frozen-settings" data-testid={testId}>{label}：{!valid || present && !summary ? '原范围信息不可用' : summary ? `第 ${summary.startFrame} 帧（含）至第 ${summary.endFrame} 帧（不含） · ${summary.frames} 帧 · ${summary.seconds} 秒 · 30 fps` : '全部原时间线'}</small>;
}
