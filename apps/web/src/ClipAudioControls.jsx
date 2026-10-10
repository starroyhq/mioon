import React from 'react';
import { Separator } from '@mioon/ui/components/separator';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { supportsClipAudioFades } from './clip-audio-state.js';

export default function ClipAudioControls({ asset, kind, draft, onEdit, issue }) {
  if (kind === 'image') return null;
  const supported = supportsClipAudioFades(asset);
  const duration = Number(draft.durationFrames);
  const maximum = Number.isSafeInteger(duration) && duration > 0 ? duration : 0;
  return <>
    <Label className="field-label" htmlFor="clip-gain">音量增益（0–2）</Label>
    <Input id="clip-gain" data-testid="clip-gain" type="number" min="0" max="2" step="0.05" required value={draft.gain} onChange={event => onEdit('gain', event.target.value)} />
    <Separator className="section-divider" />
    <div className="section-heading"><span>音频淡入/淡出（帧）</span></div>
    <div className="field-row">
      {[['fadeInFrames', '淡入', 'clip-fade-in'], ['fadeOutFrames', '淡出', 'clip-fade-out']].map(([key, label, id]) => <div key={key}>
        <Label className="field-label" htmlFor={id}>{label}（帧）</Label>
        <Input id={id} data-testid={id} aria-label={`音频${label}（帧）`} type="number" min="0" max={maximum} step="1" required disabled={!supported} value={draft[key] ?? 0} aria-invalid={Boolean(issue)} aria-describedby={`clip-fade-bounds clip-fade-effect${issue ? ' clip-fade-validation' : ''}`} onChange={event => onEdit(key, event.target.value)} />
      </div>)}
    </div>
    <p className="input-hint" id="clip-fade-bounds">30 帧 = 1 秒 · 每项 0–{maximum} 帧，两项合计不得超过片段时长。0 表示关闭。</p>
    <p className="input-hint" id="clip-fade-effect" data-testid="clip-fade-effect">{supported ? '淡入/淡出在重新渲染时间线预览与导出时生效；源素材快速查看播放原始声音。' : asset?.hasAudio === false ? '此素材不含音轨，音频淡入/淡出不会产生效果。' : '尚未确认此素材含音轨，无法启用音频淡入/淡出。'}</p>
    {issue && <p className="notice warning" id="clip-fade-validation" data-testid="clip-fade-validation" role="alert">{issue}</p>}
  </>;
}
