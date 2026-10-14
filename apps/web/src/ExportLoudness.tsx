import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { EXPORT_LOUDNESS_LABEL, EXPORT_LOUDNESS_LIMITATION, EXPORT_LOUDNESS_RESTORED, exportLoudnessStatusMessage, parseExportLoudnessTarget } from './export-loudness-state.ts';
import type { ExportLoudnessView } from './export-loudness-state.ts';

export interface ExportLoudnessProps { readonly exportId: string; readonly loudness?: ExportLoudnessView }
const fixed = (value: number, digits = 2): string => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
export function formatExportLoudnessValue(value: number | null, unit: string): string { return value === null ? `−∞ ${unit}（数字静音）` : `${fixed(value)} ${unit}`; }
const stateLabels = { valid: '可计算综合响度', digital_silence: '数字静音：综合响度不可用', too_short: '短于 400 毫秒：综合响度不可用', below_gate: '低于绝对门限：综合响度不可用' };

/** This row never edits the timeline or treats arithmetic advice as permission. */
export default function ExportLoudness({ exportId, loudness }: ExportLoudnessProps) {
  if (!loudness) return null;
  const { state, controller } = loudness, target = state.targets.find(item => item.exportId === exportId);
  if (!target) return null;
  const selected = state.targetId === exportId && state.targetKey === target.key;
  const busy = state.phase === 'measuring', measuring = selected && busy;
  const draft = selected ? state.draft : { integratedLufs: '', truePeakCeilingDbtp: '' }, parsed = parseExportLoudnessTarget(draft);
  const report = selected ? state.report : null, ready = report?.status === 'ready' ? report : null;
  const statusId = `export-loudness-status-${exportId}`, targetId = `export-loudness-target-${exportId}`, targetErrorId = `${targetId}-error`;
  const status = selected ? exportLoudnessStatusMessage(state) : '';
  const disabled = !state.connected || !state.visible || state.restored;
  return <section className="export-sample-peak export-loudness" data-testid="export-loudness" aria-label={EXPORT_LOUDNESS_LABEL}>
    <strong className="export-sample-peak-label">{EXPORT_LOUDNESS_LABEL}</strong>
    {state.restored ? <p data-testid="export-loudness-unavailable">{EXPORT_LOUDNESS_RESTORED}</p> : <>
      <details className="export-loudness-target" style={{ minWidth: 0, maxWidth: '100%' }}>
        <summary>自定参考目标（可选）</summary>
        <p>两项留空仅测量；不预设平台标准。</p>
        <label htmlFor={`${targetId}-lufs`} style={{ display: 'block', marginTop: 6 }}>目标响度（LUFS，−60 至 −5）</label>
        <Input id={`${targetId}-lufs`} type="number" min={-60} max={-5} step="any" data-testid="export-loudness-target-lufs"
          style={{ minWidth: 0, maxWidth: '100%', fontSize: 12 }} value={draft.integratedLufs} disabled={disabled}
          aria-invalid={Boolean(parsed.error)} aria-describedby={parsed.error ? targetErrorId : undefined}
          onChange={event => controller.setDraft(target, state.scope, { ...draft, integratedLufs: event.target.value }, state.draftVersion)} />
        <label htmlFor={`${targetId}-peak`} style={{ display: 'block', marginTop: 6 }}>真峰值上限（dBTP，−20 至 0）</label>
        <Input id={`${targetId}-peak`} type="number" min={-20} max={0} step="any" data-testid="export-loudness-target-peak"
          style={{ minWidth: 0, maxWidth: '100%', fontSize: 12 }} value={draft.truePeakCeilingDbtp} disabled={disabled}
          aria-invalid={Boolean(parsed.error)} aria-describedby={parsed.error ? targetErrorId : undefined}
          onChange={event => controller.setDraft(target, state.scope, { ...draft, truePeakCeilingDbtp: event.target.value }, state.draftVersion)} />
        {parsed.error && <p id={targetErrorId} role="alert" data-testid="export-loudness-target-error">{parsed.error}</p>}
      </details>
      <div className="export-sample-peak-actions">
        <Button variant="ghost" type="button" className="button quiet small" data-testid="export-loudness-measure" disabled={busy || disabled || Boolean(parsed.error)}
          aria-label={`${selected && state.phase !== 'idle' ? '重新测量' : '测量'}${EXPORT_LOUDNESS_LABEL}`} aria-describedby={statusId}
          onClick={() => { void controller.measure(target, state.scope, state.draftVersion); }}>{selected && state.phase !== 'idle' ? '重新测量' : '测量'}</Button>
        {measuring && <Button variant="ghost" type="button" className="button quiet small" data-testid="export-loudness-cancel"
          onClick={() => controller.cancel(target, state.scope, state.draftVersion)}>取消本次观察</Button>}
      </div>
    </>}
    <div id={statusId} className="export-sample-peak-status" role="status" aria-live="polite" aria-atomic="true">
      {measuring ? <p>{status}</p> : ready ? <>
        <p data-testid="export-loudness-range">{ready.artifact.exportRange ? '所选范围的已导出文件' : '完整冻结时间线的已导出文件'} · rev {ready.artifact.timelineRevision}</p>
        <p data-testid="export-loudness-integrated">综合响度：{ready.measurement.integratedLufs === null ? stateLabels[ready.measurement.state] : `${fixed(ready.measurement.integratedLufs)} LUFS`}</p>
        <p data-testid="export-loudness-true-peak">真峰值估算：{formatExportLoudnessValue(ready.measurement.truePeakDbtp, 'dBTP')}</p>
        <p data-testid="export-loudness-sample-peak">解码样本峰值：{formatExportLoudnessValue(ready.measurement.samplePeakDbfs, 'dBFS')}</p>
        {ready.target && <p data-testid="export-loudness-captured-target">本次参考目标：{ready.target.integratedLufs} LUFS · 上限 {ready.target.truePeakCeilingDbtp} dBTP</p>}
        {ready.suggestion ? <>
          <p data-testid="export-loudness-advice">达到参考响度所需增益（算术）：{fixed(ready.suggestion.requiredGainDb)} dB；真峰值可用余量（已预留0.5 dB）：{fixed(ready.suggestion.truePeakRoomDb)} dB。</p>
          {ready.suggestion.conflictsWithCeiling && <p className="notice warning" data-testid="export-loudness-conflict">所需增益超过参考真峰值余量，两个目标存在冲突。</p>}
          <p>仅供参考，未验证当前时间线；未来如另行调整音量，须重新导出并测量。</p>
        </> : ready.target ? <p>本次综合响度不可用，无法提供增益参考。</p> : null}
        <details><summary>测量文件与算法详情</summary>
          <p>项目编号：{ready.projectId}<br />导出编号：{ready.exportId}<br />文件编号：{ready.artifact.assetId}<br />SHA-256：{ready.artifact.sha256}<br />快照 SHA-256：{ready.artifact.snapshotSha256}<br />冻结版本：rev {ready.artifact.timelineRevision}
            {ready.artifact.exportRange && <><br />冻结范围：第 {ready.artifact.exportRange.startFrame} 帧（含）至第 {ready.artifact.exportRange.endFrame} 帧（不含）</>}
            <br />测量配置：{ready.measurementProfile}<br />阶段：已导出文件解码后<br />解码样本帧：{ready.measurement.sampleFrames} · 48 kHz · 双声道<br />解码时长：{ready.measurement.decodedDurationSeconds.toFixed(3)} 秒
            <br />测量状态：{stateLabels[ready.measurement.state]}<br />门限块：全部 {ready.measurement.gatingBlockCount}；绝对门限后 {ready.measurement.absoluteGatedBlockCount}；相对门限后 {ready.measurement.relativeGatedBlockCount}
            <br />相对门限：{ready.measurement.relativeGateLufs === null ? '不可用' : `${fixed(ready.measurement.relativeGateLufs)} LUFS`}
            <br />线性峰值：样本 {ready.measurement.samplePeakLinear}；真峰值估算 {ready.measurement.truePeakLinear}
            <br />测量时间：<time dateTime={ready.checkedAt}>{new Date(ready.checkedAt).toLocaleString('zh-CN')}</time></p>
          {ready.suggestion && <p>算术倍率：{ready.suggestion.gainMultiplier.toFixed(4)}；投影真峰值：{fixed(ready.suggestion.projectedTruePeakDbtp)} dBTP。余量计算另扣 {ready.suggestion.marginDb} dB 的应用参考预留，不保证编码安全。</p>}
        </details>
      </> : status ? <p data-testid="export-loudness-not-ready">{status}</p> : busy && !state.restored ? <p>另一文件正在测量，请等待或取消该观察。</p> : !state.connected && !state.restored ? <p>连接恢复后可明确发起测量。</p> : null}
    </div>
    <p className="export-sample-peak-limitation">{EXPORT_LOUDNESS_LIMITATION}</p>
  </section>;
}
