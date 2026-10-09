import { rulerFrameForKey } from './timeline-keyboard.js';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@video-workbench/ui/components/collapsible';
import { Switch } from '@video-workbench/ui/components/switch';
import { Slider } from '@video-workbench/ui/components/slider';
import { Button } from '@video-workbench/ui/components/button';
import { Input } from '@video-workbench/ui/components/input';
import { Label } from '@video-workbench/ui/components/label';
import React, { useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { assetUrl } from './api.js';
import TimelineHistoryControls from './TimelineHistoryControls.jsx';

export const ASSET_DRAG = 'application/x-workbench-asset';
export const CLIP_DRAG = 'application/x-workbench-clip';
export const assetKind = asset => asset?.mimeType?.split('/')[0] || 'image';
export const framesLabel = (frame, fps = 30) => `${String(Math.floor(frame / fps / 60)).padStart(2, '0')}:${String(Math.floor(frame / fps) % 60).padStart(2, '0')}:${String(frame % fps).padStart(2, '0')}`;
export function dragAsset(event, assetId) { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(ASSET_DRAG, assetId); event.dataTransfer.setData('text/plain', assetId); }

export default function Timeline({ timeline, historyState, onHistory, assets, selectedClipId, onSelectClip, onAddAsset, onMoveClip, onTrackAdd, onTrackUpdate, onSeed, onRender, onSeek, playhead, collapsed, onCollapse, busy, canSeed, renderJob }) {
  const [pixelsPerSecond, setPixelsPerSecond] = useState(76);
  const [dragTrack, setDragTrack] = useState(null);
  const viewport = useRef(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => { const element = viewport.current; if (!element) return; const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth)); observer.observe(element); setViewportWidth(element.clientWidth); return () => observer.disconnect(); }, []);
  const fps = timeline?.fps || 30;
  const pxFrame = pixelsPerSecond / fps;
  const duration = timeline?.durationFrames || 0;
  const contentFrames = Math.max(360, Math.ceil((duration + 90) / 30) * 30);
  const width = Math.max(780, viewportWidth - 160, contentFrames * pxFrame);
  const videoTracks = [...(timeline?.tracks || [])].filter(t => t.kind === 'video').sort((a, b) => b.orderIndex - a.orderIndex);
  const tracks = [...videoTracks, ...(timeline?.tracks || []).filter(t => t.kind === 'audio').sort((a, b) => a.orderIndex - b.orderIndex)];
  const frameAt = (event, el = event.currentTarget) => Math.max(0, Math.min(17999, Math.round((event.clientX - el.getBoundingClientRect().left) / pxFrame)));
  async function drop(event, track) {
    event.preventDefault(); setDragTrack(null);
    if (busy) return;
    const raw = event.dataTransfer.getData(CLIP_DRAG);
    if (raw) {
      try { const payload = JSON.parse(raw); await onMoveClip(payload.id, track.id, Math.max(0, frameAt(event) - (payload.grabFrame || 0))); } catch { /* Invalid drag payload has no side effects. */ }
    } else {
      const id = event.dataTransfer.getData(ASSET_DRAG);
      if (id) await onAddAsset(id, track.id, frameAt(event));
    }
  }
  const stepSeconds = pixelsPerSecond < 45 ? 5 : pixelsPerSecond < 65 ? 2 : 1;
  const ticks = Array.from({ length: Math.ceil(width / (pixelsPerSecond * stepSeconds)) + 1 }, (_, i) => i * stepSeconds);
  return <Collapsible open={!collapsed} onOpenChange={() => onCollapse()} render={<section />} className={`timeline-panel ${collapsed ? 'is-collapsed' : ''}`} aria-label="04 多轨时间线" data-testid="timeline-panel">
    <header className="timeline-header"><div className="region-title"><span className="region-index">04</span><h2>多轨时间线</h2><span className="timeline-spec">30 fps · 720 × 1280</span></div><div className="timeline-header-actions"><TimelineHistoryControls state={historyState} onHistory={onHistory} busy={busy} /><span className="timeline-length">{framesLabel(duration)} · {timeline?.clips?.length || 0} 片段</span><Button variant="ghost" className="button small" data-testid="timeline-render-preview" disabled={!duration || busy || ['queued','running','pending'].includes(renderJob?.status)} onClick={() => onRender('preview')}><Icon name="play" size={13} />{renderJob && ['queued','running'].includes(renderJob.status) ? '正在渲染…' : '渲染预览'}</Button><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" />} title={collapsed ? '展开多轨时间线' : '收起多轨时间线'} aria-label={collapsed ? '展开多轨时间线' : '收起多轨时间线'} data-testid="toggle-timeline"><Icon name={collapsed ? 'plus' : 'minus'} size={16} /></CollapsibleTrigger></div></header>
    <CollapsibleContent className="timeline-body" keepMounted>
      <div className="timeline-toolbar"><Label className="playhead-input"><span>播放头</span><Input aria-label="时间线播放头帧" data-testid="timeline-playhead" type="number" min="0" max="18000" step="1" value={playhead} onChange={e => onSeek(Math.max(0, Math.min(18000, Math.round(Number(e.target.value) || 0))))} /><span>帧</span><output>{framesLabel(playhead)}</output></Label><div className="track-add-actions"><Button variant="ghost" className="button small" data-testid="add-video-track" disabled={!timeline || busy || tracks.length >= 12} onClick={() => onTrackAdd('video')}><Icon name="plus" size={12} />画面轨</Button><Button variant="ghost" className="button small" data-testid="add-audio-track" disabled={!timeline || busy || tracks.length >= 12} onClick={() => onTrackAdd('audio')}><Icon name="plus" size={12} />音频轨</Button><Button variant="ghost" className="text-button seed-timeline" data-testid="seed-timeline" title="将每个镜头的当前选用版本冻结复制到空时间线" disabled={!canSeed || duration > 0 || busy} onClick={onSeed}>从分镜建立时间线</Button></div><Label className="timeline-zoom"><span id="timeline-zoom-label"><span className="sr-only">时间线</span>缩放</span><Slider className="timeline-zoom-slider" aria-labelledby="timeline-zoom-label" min={28} max={220} step={1} value={[pixelsPerSecond]} onValueChange={value => setPixelsPerSecond(Array.isArray(value) ? value[0] : value)} /><span>{Math.round(pixelsPerSecond / 76 * 100)}%</span></Label></div>
      <div className="timeline-scroll" ref={viewport} data-testid="timeline-scroll"><div className="timeline-content" style={{ width: width + 160 }}><div className="timeline-ruler-row"><div className="track-label ruler-label">轨道 <span>上层覆盖下层</span></div><div className="timeline-ruler" style={{ width }} role="slider" aria-label="时间标尺" aria-valuemin={0} aria-valuemax={18000} aria-valuenow={playhead} tabIndex={0} onClick={e => onSeek(frameAt(e))} onKeyDown={e => { const frame = rulerFrameForKey(e.key, playhead); if (frame !== null) { e.preventDefault(); onSeek(frame); } }}>{ticks.map(second => <span key={second} className="ruler-tick" style={{ left: second * pixelsPerSecond }}>{String(Math.floor(second / 60)).padStart(2, '0')}:{String(second % 60).padStart(2, '0')}</span>)}<div className="ruler-head" style={{ left: playhead * pxFrame }} /></div></div>
        {tracks.map((track, index) => <div className={`timeline-track ${track.kind} ${track.hidden ? 'track-hidden' : ''} ${track.muted ? 'track-muted' : ''}`} key={track.id} data-testid={`timeline-track-${track.id}`}><div className="track-label"><div><span className={`track-kind ${track.kind}`}>{track.kind === 'audio' ? 'A' : 'V'}{track.kind === 'audio' ? tracks.filter(t => t.kind === 'audio').indexOf(track) + 1 : videoTracks.length - index}</span><strong title={track.name}>{track.name}</strong></div><div className="track-controls">{track.kind === 'video' && <Label className="track-switch"><Switch size="sm" aria-label={`显示 ${track.name}`} title="仅控制画面，不影响音轨" checked={!track.hidden} disabled={busy} onCheckedChange={checked => onTrackUpdate(track.id, { hidden: !checked })} /><span>{track.hidden ? '隐藏中' : '画面开'}</span></Label>}<Label className="track-switch"><Switch size="sm" aria-label={`静音 ${track.name}`} title="控制本轨全部声音（包括视频内嵌声音）" checked={track.muted} disabled={busy} onCheckedChange={checked => onTrackUpdate(track.id, { muted: checked })} /><span>{track.muted ? '静音中' : '声音开'}</span></Label></div></div><div className={`track-lane ${dragTrack === track.id ? 'drag-over' : ''}`} data-testid={`track-lane-${track.id}`} style={{ width, backgroundSize: `${pixelsPerSecond}px 100%` }} onClick={e => { if (e.target === e.currentTarget) onSeek(frameAt(e)); }} onDragOver={e => { if (e.dataTransfer.types.includes(ASSET_DRAG) || e.dataTransfer.types.includes(CLIP_DRAG)) { e.preventDefault(); setDragTrack(track.id); e.dataTransfer.dropEffect = e.dataTransfer.types.includes(CLIP_DRAG) ? 'move' : 'copy'; } }} onDragLeave={() => setDragTrack(null)} onDrop={e => drop(e, track)}>
          {timeline.clips.filter(clip => clip.trackId === track.id).map(clip => { const asset = assets.find(a => a.id === clip.assetId); const kind = assetKind(asset); return <Button variant="ghost" key={clip.id} className={`timeline-clip ${kind} ${selectedClipId === clip.id ? 'selected' : ''}`} style={{ left: clip.startFrame * pxFrame, width: Math.max(8, clip.durationFrames * pxFrame) }} data-testid={`timeline-clip-${clip.id}`} title={`${clip.name || asset?.name} · ${clip.startFrame}–${clip.startFrame + clip.durationFrames} 帧；拖动移动，点击编辑`} aria-label={`时间线片段 ${clip.name || asset?.name}`} aria-pressed={selectedClipId === clip.id} draggable={!busy} onClick={e => { e.stopPropagation(); onSelectClip(clip.id); }} onDragStart={e => { const grabFrame = Math.max(0, Math.round((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxFrame)); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(CLIP_DRAG, JSON.stringify({ id: clip.id, grabFrame })); }}>
            {kind === 'image' ? <img src={assetUrl(asset)} alt="" draggable={false} /> : <span className="clip-symbol"><Icon name={kind === 'audio' ? 'music' : 'film'} size={16} /></span>}<span className="clip-copy"><strong>{clip.name || asset?.name || '媒体片段'}</strong><small>{clip.durationFrames} 帧 · {(clip.durationFrames / fps).toFixed(2)}s</small></span><span className="clip-end-mark" /></Button>; })}
          {!timeline.clips.some(c => c.trackId === track.id) && <span className="track-drop-hint">拖入{track.kind === 'audio' ? '音频' : '图片或视频'} · {track.kind === 'audio' ? '混音' : '叠加画面'}</span>}<div className="track-playhead" style={{ left: playhead * pxFrame }} /></div></div>)}
        {!timeline && <div className="timeline-empty">创建或打开项目后，开始编排画面与声音。</div>}
      </div></div><footer className="timeline-footnote"><span>拖动片段可跨兼容轨道移动 · 点击片段精确编辑帧 · 同轨不允许重叠</span><span>时间线 rev {timeline?.revision ?? '—'} · 分镜与画布独立</span></footer>
    </CollapsibleContent>
  </Collapsible>;
}
