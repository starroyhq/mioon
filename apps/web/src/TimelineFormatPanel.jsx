import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { TIMELINE_OUTPUT_PRESETS, timelineFormatCanSave, timelineFormatReason } from './timeline-format-state.js';
import './timeline-format.css';

export default function TimelineFormatPanel({ state, controller, onBack, onOpenTasks }) {
  const saved = state?.saved, draft = TIMELINE_OUTPUT_PRESETS.find(preset => preset.id === state?.draftPresetId);
  return <aside className="timeline-format-panel" data-testid="timeline-format-panel" aria-labelledby="timeline-format-title">
    <header><Button variant="ghost" type="button" size="sm" data-testid="timeline-format-back" onClick={onBack}>返回属性</Button><h2 id="timeline-format-title">时间线输出规格</h2></header>
    <div className="timeline-format-body">
      <p>只调整时间线合成与导出的画面尺寸。源素材、生成比例不会改变；分镜导出固定 9:16。</p>
      <p>仅在尚无片段、编辑历史、请求历史或时间线导出记录时可修改；有待确认编辑时也会阻止保存。开始编辑前可重新选择，规格变更不进入片段撤销历史。</p>
      <div role="status" aria-live="polite">{state?.submitting ? '正在保存规格…' : state?.dirty ? '规格草稿未保存' : state?.phase === 'error' ? '输出规格暂不可用' : saved ? saved.timelineId ? '已保存的时间线规格' : '默认时间线规格（尚未创建）' : '正在核对输出规格…'}</div>
      {saved && <p data-testid="timeline-format-saved">{saved.width} × {saved.height} · {saved.fps} fps · {saved.timelineId ? `时间线 rev ${saved.timelineRevision}` : '尚未创建时间线'}</p>}
      <Label htmlFor="timeline-format-preset">输出画幅</Label>
      <WorkbenchSelect id="timeline-format-preset" data-testid="timeline-format-preset" value={state?.draftPresetId || ''} disabled={!saved || !saved.eligible || !state?.connected} onChange={event => controller.choose(event.target.value, state?.scope ?? null)}>
        {!saved && <option value="">等待已保存规格</option>}{TIMELINE_OUTPUT_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label} · {preset.width} × {preset.height}</option>)}
      </WorkbenchSelect>
      {draft && <p className="input-hint">当前选择：{draft.width} × {draft.height}</p>}
      <dl><div><dt>帧率（固定）</dt><dd data-testid="timeline-format-fps">30 fps</dd></div></dl>
      {saved?.blockedReasons.length > 0 && <div className="notice warning" role="status"><p>服务器当前不允许修改：</p><ul>{saved.blockedReasons.map(reason => <li key={reason}>{timelineFormatReason(reason)}</li>)}</ul></div>}
      {state?.pending && <p className="notice warning">编辑恢复记录尚未核对完成或有请求待确认。请先到任务中心核对。</p>}
      {state?.conflict && <p className="notice warning" role="alert">已保存的项目或时间线已变化。选择仍保留，请载入最新规格后重新选择。</p>}
      {state?.error && <p className="notice error" role="alert">{state.error}</p>}
      {(state?.pending || state?.uncertain) && <Button variant="outline" type="button" size="sm" onClick={onOpenTasks}>打开任务中心</Button>}
      <p className="input-hint">保存时服务器会再次核对资格与版本。切换标签、收起面板或返回属性会保留此草稿。</p>
    </div>
    <footer><Button type="button" data-testid="timeline-format-save" disabled={!timelineFormatCanSave(state)} onClick={() => controller.save(state?.scope ?? null)}>保存输出规格</Button><Button variant="outline" type="button" disabled={!state?.connected || state?.submitting} onClick={() => controller.load(state?.scope ?? null)}>重新核对</Button>{state?.dirty && <Button variant="ghost" type="button" disabled={state?.submitting} onClick={() => controller.discardDraft(state?.scope ?? null)}>载入已保存规格</Button>}</footer>
  </aside>;
}
