import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import type { ExportLoudnessMeasurement } from '@mioon/contracts/export-loudness';
import { TIMELINE_MIX_LOUDNESS_LABEL, TIMELINE_MIX_LOUDNESS_LIMITATION, parseTimelineMixLoudnessTarget, timelineMixLoudnessAvailable, timelineMixLoudnessStatusMessage } from './timeline-mix-loudness-state.ts';
import type { TimelineMixLoudnessView } from './timeline-mix-loudness-state.ts';

export interface TimelineMixLoudnessProps { readonly loudness: TimelineMixLoudnessView; readonly apply?: React.ReactNode; readonly onRevokeApply?: () => void }
const fixed = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
const peak = (value: number | null, unit: string): string => value === null ? `−∞ ${unit}（数字静音）` : `${fixed(value)} ${unit}`;
const states = { valid: '可计算综合响度', digital_silence: '数字静音', too_short: '短于 400 毫秒', below_gate: '低于绝对门限' };
function Measurement({ value, label, testId }: { readonly value: ExportLoudnessMeasurement; readonly label: string; readonly testId: string }) {
  return <p data-testid={testId}>{label}：{value.integratedLufs === null ? `${states[value.state]}，综合响度不可用` : `${fixed(value.integratedLufs)} LUFS`}<br />
    真峰值估算 {peak(value.truePeakDbtp, 'dBTP')} · 样本峰值 {peak(value.samplePeakDbfs, 'dBFS')}</p>;
}

/** Read-only observation with a separately owned, explicit human apply control. */
export default function TimelineMixLoudness({ loudness, apply, onRevokeApply }: TimelineMixLoudnessProps) {
  const { state, controller } = loudness;
  if (!timelineMixLoudnessAvailable(state)) return apply ?? null;
  const parsed = parseTimelineMixLoudnessTarget(state.draft), preparing = state.phase === 'preparing', report = state.report;
  const status = timelineMixLoudnessStatusMessage(state), targetError = Boolean(parsed.error && (state.draft.integratedLufs || state.draft.truePeakCeilingDbtp));
  const prefix = `timeline-mix-loudness-${state.timelineId}`, statusId = `${prefix}-status`, errorId = `${prefix}-error`;
  return <details className="export-sample-peak timeline-mix-loudness" data-testid="timeline-mix-loudness" style={{ minWidth: 0, maxWidth: '100%' }}
    onToggle={event => { if (!event.currentTarget.open) { controller.revoke(state); onRevokeApply?.(); } }}>
    <summary className="export-sample-peak-label">{TIMELINE_MIX_LOUDNESS_LABEL}</summary>
    <p data-testid="timeline-mix-loudness-scope">完整已保存时间线：第 0 帧至第 {state.durationFrames} 帧（不含）· rev {state.revision}。始终测量整片，不使用本次所选导出范围。</p>
    <p>请填写两个明确目标；不预设平台标准。真峰值比较额外预留 0.5 dB，准备结果保持只读，应用需另行核对确认。</p>
    <label htmlFor={`${prefix}-lufs`} style={{ display: 'block', marginTop: 6 }}>目标响度（LUFS，−60 至 −5）</label>
    <Input id={`${prefix}-lufs`} type="number" min={-60} max={-5} step="any" data-testid="timeline-mix-loudness-target-lufs"
      style={{ minWidth: 0, maxWidth: '100%', fontSize: 12 }} value={state.draft.integratedLufs}
      aria-invalid={targetError} aria-describedby={targetError ? errorId : undefined}
      onChange={event => controller.setDraft({ ...state.draft, integratedLufs: event.target.value }, state)} />
    <label htmlFor={`${prefix}-peak`} style={{ display: 'block', marginTop: 6 }}>真峰值上限（dBTP，−20 至 0）</label>
    <Input id={`${prefix}-peak`} type="number" min={-20} max={0} step="any" data-testid="timeline-mix-loudness-target-peak"
      style={{ minWidth: 0, maxWidth: '100%', fontSize: 12 }} value={state.draft.truePeakCeilingDbtp}
      aria-invalid={targetError} aria-describedby={targetError ? errorId : undefined}
      onChange={event => controller.setDraft({ ...state.draft, truePeakCeilingDbtp: event.target.value }, state)} />
    {targetError && <p id={errorId} role="alert" data-testid="timeline-mix-loudness-target-error">{parsed.error}</p>}
    <div className="export-sample-peak-actions">
      <Button variant="ghost" type="button" className="button quiet small" data-testid="timeline-mix-loudness-prepare"
        disabled={preparing || !parsed.target} aria-describedby={statusId} onClick={() => { void controller.prepare(state); }}>{state.phase === 'idle' ? '准备并测量候选' : '重新准备并测量'}</Button>
      {preparing && <Button variant="ghost" type="button" className="button quiet small" data-testid="timeline-mix-loudness-cancel"
        onClick={() => controller.cancel(state)}>取消本次观察</Button>}
    </div>
    <div id={statusId} className="export-sample-peak-status" role="status" aria-live="polite" aria-atomic="true">
      {status && <p data-testid="timeline-mix-loudness-status">{status}</p>}
      {report && <>
        <p data-testid="timeline-mix-loudness-captured-target">本次目标：{report.target.integratedLufs} LUFS · 上限 {report.target.truePeakCeilingDbtp} dBTP；额外预留 {report.candidate.marginDb} dB（应用参考余量）。</p>
        <Measurement value={report.original} label="原始整片浮点混音" testId="timeline-mix-loudness-original" />
        {report.candidate.status === 'measured' ? <>
          <Measurement value={report.candidate.measurement} label="重新渲染的固定增益候选" testId="timeline-mix-loudness-candidate" />
          <p data-testid="timeline-mix-loudness-gain">单一固定增益：{fixed(report.candidate.requiredGainDb)} dB · ×{report.candidate.gainMultiplier.toFixed(4)}，覆盖 {report.candidate.gains.length} 个可听片段。</p>
          <p data-testid="timeline-mix-loudness-comparison">候选实测与目标相差≤0.1 LU：{report.candidate.meetsTarget ? '是' : '否'}；真峰值含 0.5 dB 预留后满足上限：{report.candidate.meetsTruePeak ? '是' : '否'}。</p>
          {(!report.candidate.meetsTarget || !report.candidate.meetsTruePeak) && <p className="notice warning" data-testid="timeline-mix-loudness-conflict">此固定增益候选未同时满足两个参考目标，未降低目标或限幅。</p>}
        </> : <p data-testid="timeline-mix-loudness-unavailable">候选不可用：{report.candidate.reason === 'NO_VALID_LOUDNESS' ? '原混音没有可用的综合响度，无法计算固定增益。' : '所需增益会使片段超出支持范围，未夹紧或修改增益。'}</p>}
        <details><summary>本次快照、来源与增益详情</summary>
          <p>项目编号：{report.projectId}<br />时间线编号：{report.identity.timelineId}<br />已保存版本：rev {report.identity.timelineRevision}<br />快照 SHA-256：{report.identity.snapshotSha256}
            <br />完整区间：第 0 帧至第 {report.identity.range.endFrame} 帧（不含）<br />每次完整测量：{report.identity.range.sampleFrames} 样本帧 · 48 kHz · 双声道
            <br />混音配置：{report.mixProfile}<br />测量配置：{report.measurementProfile}<br />来源字节与版本由后端核验；报告不授予应用权限。</p>
          {report.identity.sources.map(source => <p key={source.assetId}>来源 {source.assetId}<br />SHA-256：{source.sha256} · {source.sizeBytes} 字节</p>)}
          {report.candidate.gains.map(gain => <p key={gain.clipId}>片段 {gain.clipId}：{gain.beforeGain.toFixed(4)} → {gain.afterGain.toFixed(4)}</p>)}
          <p>测量时间：<time dateTime={report.checkedAt}>{new Date(report.checkedAt).toLocaleString('zh-CN')}</time></p>
        </details>
      </>}
    </div>
    <p className="export-sample-peak-limitation">{TIMELINE_MIX_LOUDNESS_LIMITATION}</p>
    {apply}
  </details>;
}
