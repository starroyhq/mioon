import React, { useLayoutEffect, useRef } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Textarea } from '@mioon/ui/components/textarea';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { subtitleCanSave, subtitleDraftIssue } from './subtitle-state.js';
import Icon from './icons.jsx';
import './subtitles.css';

export default function SubtitleInspector({ state, controller, renderJob, onBack, onOpenTasks }) {
  const confirm = useConfirmation(), visible = useWorkspaceVisibility(), live = useRef({ mounted: false, visible: false });
  useLayoutEffect(() => { live.current = { mounted: true, visible }; return () => { live.current.mounted = false; }; }, [visible]);
  const admit = action => { const current = controller.getState(); if (live.current.mounted && live.current.visible && state?.scope === current.scope && state?.selection === current.selection) return action(); };
  const draft = state?.draft, issue = draft ? subtitleDraftIssue(state) : '', stale = renderJob && state?.timeline && renderJob.timelineRevision !== state.timeline.revision;
  return <aside className="inspector subtitle-inspector" data-testid="subtitle-inspector" aria-labelledby="subtitle-title">
    <header className="inspector-heading"><Icon name="text" /><span id="subtitle-title">手动字幕</span><Badge className="small-badge neutral">固定排版</Badge><Button type="button" variant="ghost" size="sm" data-testid="subtitle-back" onClick={() => admit(onBack)}>返回属性</Button></header>
    <ScrollArea className="subtitle-scroll" style={{ flex: 1, minHeight: 0 }}><div className="inspector-scroll subtitle-form">
      <p className="input-hint">底部居中 · 常用汉字、ASCII 与支持的标点 · 1–2 行，每行最多 20 个 Unicode 字符。文字原样保存，不自动换行或删改。</p>
      <p className="input-hint" data-testid="subtitle-render-note">源素材保持原样。字幕烧录在时间线渲染预览和导出中；此处文字框不是最终画面预览。</p>
      <p className={stale ? 'notice warning' : 'input-hint'} data-testid="subtitle-render-status" role="status">{!state?.timeline ? '正在核对当前时间线。' : stale ? `已有渲染是旧快照 rev ${renderJob.timelineRevision}，当前 rev ${state.timeline.revision}，请重新渲染。` : renderJob ? `渲染快照 rev ${renderJob.timelineRevision}，与当前已保存时间线一致。` : '尚无渲染预览。保存后点击时间线的「渲染预览」。'}</p>
      <div role="status" aria-live="polite" data-testid="subtitle-save-status">{state?.submitting ? '正在保存字幕…' : state?.uncertain ? '原请求结果待确认' : state?.dirty ? '有未保存的字幕修改' : draft ? '已保存的字幕' : '在时间线选择字幕，或在播放头处新增。'}</div>
      {draft && <><Label className="field-label" htmlFor="subtitle-text">字幕文字（原样保存）</Label><Textarea id="subtitle-text" data-testid="subtitle-text" value={draft.text} rows={3} spellCheck={false} aria-invalid={Boolean(issue)} aria-describedby="subtitle-validation" onChange={event => admit(() => controller.edit('text', event.target.value, state))} />
        <div className="field-row">{[['startFrame', '开始帧', 0], ['durationFrames', '持续帧数', 1]].map(([key, label, min]) => <div key={key}><Label className="field-label" htmlFor={`subtitle-${key}`}>{label}</Label><Input id={`subtitle-${key}`} data-testid={`subtitle-${key}`} type="number" aria-describedby="subtitle-validation" aria-invalid={Boolean(issue)} step="1" min={min} max={state.timeline?.durationFrames || 0} value={draft[key]} onChange={event => admit(() => controller.edit(key, event.target.value, state))} /></div>)}</div>
        <p className="input-hint">30 帧 = 1 秒 · 出点不包含在范围内 · 媒体时长 {state.timeline?.durationFrames || 0} 帧。字幕不能重叠或延长媒体时长。</p>
        <p id="subtitle-validation" data-testid="subtitle-validation" className={issue ? 'notice warning' : 'input-hint'} role={issue ? 'alert' : undefined}>{issue || `${draft.text.split('\n').map(line => [...line].length).join(' / ')} 字符`}</p>
      </>}
      {state?.conflict && <p className="notice warning" role="alert">时间线已变化，草稿仍保留。放弃修改并载入已保存内容后，才可继续保存。</p>}
      {state?.error && <p className="notice warning" role="alert">{state.error}</p>}
      {(state?.pending || state?.uncertain) && <Button type="button" variant="outline" size="sm" data-testid="subtitle-open-tasks" onClick={() => admit(onOpenTasks)}>打开任务中心</Button>}
      <details className="input-hint"><summary>支持的中文标点</summary><p>，。！？；：、（）【】《》〈〉“”‘’—…·￥％～</p><p>ASCII 空格、英文、数字和标点可用；不支持表情、组合字符和其他文字系统。</p></details>
      <p className="input-hint">切换右侧标签、返回属性或收起面板会保留字幕草稿。响应丢失时只恢复任务中心的原请求。</p>
    </div></ScrollArea>
    <footer className="subtitle-actions"><Button type="button" data-testid="subtitle-save" disabled={!subtitleCanSave(state)} onClick={() => admit(() => controller.save(state))}><Icon name="check" size={14} />保存字幕</Button><Button type="button" variant="outline" data-testid="subtitle-discard" disabled={!draft || state?.submitting} onClick={() => admit(() => controller.discardDraft(state.scope))}>放弃修改</Button><Button type="button" variant="ghost" className="danger-text" data-testid="subtitle-remove" disabled={!state?.cueId || state.dirty || state.conflict || state.submitting || state.pending || state.uncertain || !state.connected} onClick={() => admit(async () => { const snapshot = controller.getState(); if (await confirm('从时间线移除此字幕？可通过时间线撤销恢复。') && snapshot === controller.getState()) admit(() => controller.remove(state)); })}>移除字幕</Button></footer>
  </aside>;
}
