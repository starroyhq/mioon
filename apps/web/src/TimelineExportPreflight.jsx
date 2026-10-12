import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.jsx';
import { preflightIssueMessage, exportCapabilityMessage } from './export-preflight-state.js';

import TimelineExportSettings from './TimelineExportSettings.jsx';
import TimelineDeliveryName, { TimelineDeliveryNameSnapshot } from './TimelineDeliveryName.tsx';

const phaseLabels = { idle: '尚未检查', checking: '正在检查', ready: '检查通过', blocked: '无法导出', incomplete: '检查未完成', stale: '报告已过期', error: '检查失败' };
const bytesLabel = bytes => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// Presentation only: the parent owns the saved context, explicit read, and
// durable render submission. Hidden tabs retain this view without starting work.
export default function TimelineExportPreflight({ state, projectName, timeline, exportSettings, settingsDisabled, onSettingsChange, deliveryName = '', deliveryNameError, deliveryNameDisabled, onDeliveryNameChange, canCheck, exportBusy, pendingExport, dirty, onCheck, onExport, onUncheckedExport }) {
  const phase = state?.phase || 'idle', report = state?.report, summary = report?.summary;
  const oldReport = Boolean(report && ['checking', 'stale', 'error'].includes(phase));
  const canExport = Boolean(state?.binding && ['ready', 'incomplete'].includes(phase) && !exportBusy && !pendingExport && !state.attempted);
  const canExportUnchecked = Boolean(state?.uncheckedIntent && phase === 'incomplete' && !exportBusy && !pendingExport && !state.attempted);
  return <aside className="export-preflight" data-testid="export-preflight" data-phase={phase} aria-label="时间线交付检查">
    <header className="export-preflight-heading"><div><h2>交付检查</h2><p title={projectName}>{projectName || '请先选择项目'}</p></div><Icon name="info" size={15} /></header>
    <div className="export-preflight-body">
      <TimelineDeliveryName value={deliveryName} error={deliveryNameError} disabled={deliveryNameDisabled || settingsDisabled || exportBusy || pendingExport} onChange={onDeliveryNameChange} />
      <TimelineExportSettings timeline={timeline} value={exportSettings} disabled={settingsDisabled || exportBusy || pendingExport} onChange={onSettingsChange} />
      {exportSettings && <div className={`export-capability-status is-${state?.capabilityPhase || 'idle'}`} data-testid="export-capability-status" data-status={state?.capabilityPhase || 'idle'} role="status" aria-live="polite"><strong>本机编码能力</strong><p>{exportCapabilityMessage(state?.capabilityPhase || 'idle')}</p></div>}
      <details className="export-preflight-scope" data-testid="preflight-scope-details"><summary>仅检查已保存的时间线快照</summary><p>镜头、片段和源范围，以及输出规格的未保存修改均不包含在检查或本次导出中。检查不会保存或放弃草稿。</p></details>
      {dirty && <p className="export-preflight-draft" data-testid="preflight-unsaved">有未保存修改，本次不包含；保存后请重新检查。</p>}
      <div className={`export-preflight-status is-${phase}`} role="status" aria-live="polite"><span>{phase === 'checking' && <span className="spinner" />}{phaseLabels[phase]}</span>{report && <small>{oldReport ? '上次检查' : '检查快照'} · rev {report.timelineRevision ?? '未知'}</small>}</div>
      {state?.error && <p className="notice error" role="alert">{state.error}</p>}
      {phase === 'idle' && <p className="export-preflight-empty">点击“检查本次设置”，先验证本机编码能力，再检查已保存的素材与时间线。打开面板不会开始检查。</p>}
      {phase === 'stale' && <p className="notice warning">项目、时间线、成片名称、成片设置或连接状态已变化。此报告不能用于导出，请重新检查。</p>}
      {oldReport && <p className="export-preflight-note">下方保留上次报告供参考，不能作为当前导出依据。</p>}
      {report && <div className={oldReport ? 'export-preflight-report is-old' : 'export-preflight-report'} data-testid="preflight-report">
        {report.issues.length > 0 && <><h3 className="sr-only">需要注意</h3><ul className="export-preflight-issues" data-testid="preflight-issues">{report.issues.map((issue, index) => <li key={`${issue.code}:${issue.assetId || issue.clipId || index}`} className={`is-${issue.severity}`}><span>{issue.severity === 'error' ? '阻止导出' : '提醒'}</span><p>{issue.code==='SUBTITLE_RESOURCE_UNAVAILABLE'?'内置字幕字体缺失或校验不符，无法安全渲染字幕。请恢复完整的应用资源后重试。':preflightIssueMessage(issue)}</p><small>{issue.code}{issue.assetId && ` · 素材 ${issue.assetId.slice(0, 8)}`}{issue.clipId && ` · 片段 ${issue.clipId.slice(0, 8)}`}</small></li>)}</ul></>}
        <p className="export-preflight-checked"><time dateTime={report.checkedAt}>{new Date(report.checkedAt).toLocaleString('zh-CN')}</time></p>
        {summary && <><h3>输出与编排</h3><dl className="export-preflight-summary">
          <TimelineDeliveryNameSnapshot value={summary.deliveryName} />
          <div><dt>编辑合成规格</dt><dd>{summary.width} × {summary.height} · {summary.fps} fps</dd></div>
          {summary.delivery && <div><dt>检查的成片规格</dt><dd>{summary.delivery.effective.width} × {summary.delivery.effective.height} · {summary.delivery.effective.fps} fps</dd></div>}
          <div><dt>总时长</dt><dd>{(summary.durationFrames / summary.fps).toFixed(2)} 秒 · {summary.durationFrames} 帧</dd></div>
          <div><dt>轨道 / 片段 / 素材</dt><dd>{summary.trackCount} / {summary.clipCount} / {summary.assetCount}</dd></div>
          <div><dt>画面 / 声音启用片段</dt><dd>{summary.visualClipCount} / {summary.audibleClipCount}</dd></div>
          <div><dt>静音 / 隐藏画面轨</dt><dd>{summary.mutedTrackCount} / {summary.hiddenVideoTrackCount}</dd></div>
        </dl></>}
        {report.checks.subtitles&&<p className="export-preflight-note" data-testid="preflight-subtitle-scope">字幕：{report.checks.subtitles.fontVerified?'已校验固定字体与配置':'固定字体尚未通过校验'}。本次不测量实际文字宽高；渲染时逐条测量，超出安全区域会拒绝导出，不缩小、换行或截断文字。</p>}
        <h3>素材检查范围</h3><p className="export-preflight-note">已检查 {report.checks.checkedAssets} / {report.checks.totalAssets} 个素材 · 已校验 {bytesLabel(report.checks.bytesHashed)}</p>
        <p className="export-preflight-note">有限额的文件状态、流式 SHA-256 与媒体探测检查。未进行完整解码，也不能保证检查后文件不再变化。</p>

      </div>}
      {phase === 'incomplete' && <p className="notice warning" data-testid="preflight-incomplete-warning">检查未完成，不代表通过。{state?.binding ? '仍尝试导出可能失败，渲染进程会重新验证素材与快照。' : state?.uncheckedIntent ? '尚未完成快照核验。仍尝试导出会使用当前已保存的时间线版本；渲染进程会重新验证素材。' : '尚未取得有效快照，暂时不能导出。'}</p>}
      {pendingExport && <p className="notice warning">已有导出请求结果待确认。请在任务面板恢复同一请求；重新检查不会重发导出。</p>}
      {state?.attempted && <p className="export-preflight-note" role="status">已发起一次导出提交。请在任务或导出记录查看结果；此报告不代表导出已完成。</p>}
      <p className="export-preflight-note">本机编码检查会进行有限额的短时合成编码与 MP4 封装，测试输出仅留在内存中；后续素材预检为只读。均不创建成片任务。</p>
      <p className="export-preflight-note">上限：100 个片段、12 条轨道、18000 帧。实际导出仍会重新验证；检查报告不是导出成功凭据。</p>
    </div>
    <footer className="export-preflight-actions"><Button variant="ghost" className="button" data-testid="preflight-check" disabled={!canCheck || Boolean(deliveryNameError) || phase === 'checking' || exportBusy} onClick={onCheck}><Icon name="refresh" size={14} />{phase === 'checking' ? state?.checkingStep === 'capability' ? '检查编码能力…' : '检查素材…' : '检查本次设置'}</Button>{!state?.uncheckedIntent && <Button variant="ghost" className={`button ${phase === 'incomplete' ? 'preflight-attempt' : 'primary'}`} data-testid="preflight-export" disabled={!canExport} onClick={() => onExport(state.binding)}><Icon name="download" size={14} />{exportBusy ? '正在提交…' : phase === 'incomplete' ? '检查未完成，仍尝试导出' : '确认导出'}</Button>}{state?.uncheckedIntent && <Button variant="ghost" className="button preflight-attempt" data-testid="preflight-export-unchecked" disabled={!canExportUnchecked} onClick={() => onUncheckedExport(state.uncheckedIntent)}><Icon name="download" size={14} />未完成快照核验，仍尝试导出</Button>}</footer>
  </aside>;
}
