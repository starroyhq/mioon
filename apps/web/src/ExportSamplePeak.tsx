import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { EXPORT_SAMPLE_PEAK_LABEL, EXPORT_SAMPLE_PEAK_LIMITATION, EXPORT_SAMPLE_PEAK_RESTORED, exportSamplePeakStatusMessage } from './export-sample-peak-state.ts';
import type { ExportSamplePeakView } from './export-sample-peak-state.ts';

export interface ExportSamplePeakProps { readonly exportId: string; readonly samplePeak?: ExportSamplePeakView }
export function formatExportSamplePeak(dbfs: number | null): string { return dbfs === null ? '−∞ dBFS（数字静音）' : `${dbfs > 0 ? '+' : ''}${dbfs.toFixed(4)} dBFS`; }

/** Inline row output, measured from the already-delivered file only. */
export default function ExportSamplePeak({ exportId, samplePeak }: ExportSamplePeakProps) {
  if (!samplePeak) return null;
  const { state, controller } = samplePeak, target = state.targets.find(item => item.exportId === exportId);
  if (!target) return null;
  const selected = state.targetId === exportId && state.targetKey === target.key;
  const busy = state.phase === 'checking', checking = selected && busy;
  const report = selected ? state.report : null;
  const ready = report?.status === 'ready' && report.artifact !== null && report.measurement !== null ? report : null;
  const statusId = `export-sample-peak-status-${exportId}`;
  const status = selected ? exportSamplePeakStatusMessage(state) : '';
  return <section className="export-sample-peak" data-testid="export-sample-peak" aria-label={EXPORT_SAMPLE_PEAK_LABEL}>
    <strong className="export-sample-peak-label">{EXPORT_SAMPLE_PEAK_LABEL}</strong>
    {state.restored ? <p data-testid="export-sample-peak-unavailable">{EXPORT_SAMPLE_PEAK_RESTORED}</p> : <div className="export-sample-peak-actions">
      <Button variant="ghost" type="button" className="button quiet small" data-testid="export-sample-peak-check" disabled={busy || !state.connected || !state.visible}
        aria-label={`${selected && state.phase !== 'idle' ? '重新检查' : '检查'}${EXPORT_SAMPLE_PEAK_LABEL}`} aria-describedby={statusId} onClick={() => { void controller.check(target, state.scope); }}>
        {selected && state.phase !== 'idle' ? '重新检查' : '检查'}
      </Button>
      {checking && <Button variant="ghost" type="button" className="button quiet small" data-testid="export-sample-peak-cancel" onClick={() => controller.cancel()}>取消本次检查</Button>}
    </div>}
    <div id={statusId} className="export-sample-peak-status" role="status" aria-live="polite" aria-atomic="true">
      {checking ? <p>{status}</p> : ready && ready.measurement && ready.artifact ? <>
        <p data-testid="export-sample-peak-overall">总体：{formatExportSamplePeak(ready.measurement.peakDbfs)}</p>
        <p data-testid="export-sample-peak-channels">左声道：{formatExportSamplePeak(ready.measurement.channelPeaks[0].peakDbfs)}<br />右声道：{formatExportSamplePeak(ready.measurement.channelPeaks[1].peakDbfs)}</p>
        {ready.measurement.overFullScale && <p className="notice warning" data-testid="export-sample-peak-warning">此成片解码后的样本峰值超过 0 dBFS；可能存在过载风险。</p>}
        <p>已解码检查此成片 · <time dateTime={ready.checkedAt}>{new Date(ready.checkedAt).toLocaleString('zh-CN')}</time></p>
        <details><summary>检查文件详情</summary><p>导出编号：{ready.exportId}<br />文件编号：{ready.artifact.assetId}<br />SHA-256：{ready.artifact.sha256}<br />冻结版本：rev {ready.artifact.timelineRevision}<br />线性峰值：总体 {ready.measurement.peakLinear}；左 {ready.measurement.channelPeaks[0].peakLinear}；右 {ready.measurement.channelPeaks[1].peakLinear}<br />解码样本帧：{ready.measurement.sampleFrames} · 48 kHz · 双声道</p></details>
      </> : status ? <p data-testid="export-sample-peak-not-ready">{status}</p> : busy && !state.restored ? <p>另一文件正在检查，请等待或取消该检查。</p> : !state.connected && !state.restored ? <p>连接恢复后可明确发起检查。</p> : null}
    </div>
    <p className="export-sample-peak-limitation">{EXPORT_SAMPLE_PEAK_LIMITATION}</p>
  </section>;
}
