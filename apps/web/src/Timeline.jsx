import { useI18n } from './i18n/I18nProvider.tsx';
import { rulerFrameForKey } from './timeline-keyboard.js';
import { staleSourceSentence } from './timeline-source-freshness.ts';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { Switch } from '@mioon/ui/components/switch';
import { Slider } from '@mioon/ui/components/slider';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { assetUrl } from './api.js';
import TimelineHistoryControls from './TimelineHistoryControls.jsx';
import SubtitleLane from './SubtitleLane.jsx';
import TimelineSplitControls from './TimelineSplitControls.jsx';
import { timelineDropPreview } from './timeline-snapping.js';
import TimelineWaveform, { TimelineWaveformControls } from './TimelineWaveform.jsx';
import { useTimelineWaveforms } from './use-timeline-waveforms.js';
import { WAVEFORM_LIMITS } from './waveform-state.js';

export const ASSET_DRAG = 'application/x-workbench-asset';
export const CLIP_DRAG = 'application/x-workbench-clip';
export const assetKind = asset => asset?.mimeType?.split('/')[0] || 'image';
export const framesLabel = (frame, fps = 30) => `${String(Math.floor(frame / fps / 60)).padStart(2, '0')}:${String(Math.floor(frame / fps) % 60).padStart(2, '0')}:${String(frame % fps).padStart(2, '0')}`;
// Native dragover protects getData(). Keep only the current in-document gesture
// in memory so the preview can resolve the same asset/clip before drop.
let activeDrag = null;
export function dragAsset(event, assetId) {
  activeDrag = { type: 'asset', id: assetId };
  event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(ASSET_DRAG, assetId); event.dataTransfer.setData('text/plain', assetId);
}

export default function Timeline({ basicEditingOnly = false, structureReadOnly = false, sessionViewOnly = false, staleClips = new Map(), waveformReadOnly = false, workspaceOrigin = null, timeline, historyState, onHistory, splitState, onSplit, assets, selectedClipId, selectedCueId, onSelectSubtitle, onAddSubtitle, subtitleBlocked = false, onSelectClip, onAddAsset, onMoveClip, onTrackAdd, onTrackUpdate, onSeed, onRender, onSeek, playhead, collapsed, visible = true, onCollapse, busy, canSeed, renderJob, viewState, onViewStateChange }) {
  const { t, renderMessage, locale, formatNumber } = useI18n();
  const [localViewState, setLocalViewState] = useState({ pixelsPerSecond: 76, scrollLeft: 0, scrollTop: 0, snappingEnabled: true });
  const currentView = viewState || localViewState;
  const pixelsPerSecond = Math.max(28, Math.min(220, Number(currentView.pixelsPerSecond) || 76));
  function updateViewState(patch, options) {
    if (!viewState) setLocalViewState(current => ({ ...current, ...patch }));
    onViewStateChange?.(patch, options);
  }
  const snappingEnabled = currentView.snappingEnabled !== false;
  const [preview, setPreview] = useState(null);
  const previewRef = useRef(null), gesture = useRef(null), lastDrag = useRef(null);
  function showPreview(value) { previewRef.current = value; setPreview(value); }
  function clearDrag() { activeDrag = null; gesture.current = null; lastDrag.current = null; showPreview(null); }
  // Cancel and navigation never submit. This also invalidates a gesture when a
  // different writer refreshes its base revision before the user releases it.
  useEffect(() => {
    const cancel = () => clearDrag();
    const key = event => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('dragend', cancel); window.addEventListener('drop', cancel);
    window.addEventListener('keydown', key); window.addEventListener('pagehide', cancel);
    return () => { activeDrag = null; gesture.current = null; previewRef.current = null; lastDrag.current = null; window.removeEventListener('dragend', cancel); window.removeEventListener('drop', cancel); window.removeEventListener('keydown', key); window.removeEventListener('pagehide', cancel); };
  }, []);
  useEffect(() => { if (gesture.current && (gesture.current.revision !== timeline?.revision || gesture.current.projectId !== timeline?.projectId)) clearDrag(); }, [timeline?.revision, timeline?.projectId]);
  useEffect(() => { if (busy || collapsed || !visible) clearDrag(); }, [busy, collapsed, visible]);
  const viewport = useRef(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => { const element = viewport.current; if (!element) return; const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth)); observer.observe(element); setViewportWidth(element.clientWidth); return () => observer.disconnect(); }, []);
  const fps = timeline?.fps || 30;
  const pxFrame = pixelsPerSecond / fps;
  const waveforms = useTimelineWaveforms({ timeline, assets, viewport, pixelsPerFrame: pxFrame, active: visible && !collapsed, readOnly: waveformReadOnly, workspaceOrigin });
  const waveformWindows = new Map(waveforms.windows.slice(0, WAVEFORM_LIMITS.entries).map(item => [item.clipId, item]));
  const duration = timeline?.durationFrames || 0;
  const contentFrames = Math.max(360, Math.ceil((duration + 90) / 30) * 30);
  const width = Math.max(780, viewportWidth - 160, contentFrames * pxFrame);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || collapsed || !visible) return;
    // Workspace switches remount the timeline; restore only session view state.
    element.scrollLeft = Math.max(0, Number(currentView.scrollLeft) || 0);
    element.scrollTop = Math.max(0, Number(currentView.scrollTop) || 0);
  }, [currentView.scrollLeft, currentView.scrollTop, collapsed, visible, width]);
  const videoTracks = [...(timeline?.tracks || [])].filter(t => t.kind === 'video').sort((a, b) => b.orderIndex - a.orderIndex);
  const tracks = [...videoTracks, ...(timeline?.tracks || []).filter(t => t.kind === 'audio').sort((a, b) => a.orderIndex - b.orderIndex)];
  const frameAt = (event, el = event.currentTarget) => Math.max(0, Math.min(17999, Math.round((event.clientX - el.getBoundingClientRect().left) / pxFrame)));
  function over(event, track) {
    if (!event.dataTransfer.types.includes(ASSET_DRAG) && !event.dataTransfer.types.includes(CLIP_DRAG)) return;
    event.preventDefault();
    if (busy || !activeDrag || structureReadOnly && activeDrag.type === 'asset') { event.dataTransfer.dropEffect = 'none'; showPreview(null); return; }
    const drag = activeDrag;
    if (!gesture.current) gesture.current = { drag, projectId: timeline.projectId, revision: timeline.revision };
    if (gesture.current.drag !== drag || gesture.current.revision !== timeline.revision || gesture.current.projectId !== timeline.projectId) { clearDrag(); return; }
    const clip = drag.type === 'clip' ? timeline.clips.find(c => c.id === drag.id) : null;
    const asset = assets.find(a => a.id === (clip?.assetId || (drag.type === 'asset' ? drag.id : null)));
    const value = timelineDropPreview({ timeline, track, asset, clip, pointerFrame: (event.clientX - event.currentTarget.getBoundingClientRect().left) / pxFrame, grabFrame: drag.grabFrame || 0, pixelsPerFrame: pxFrame, playhead, enabled: snappingEnabled, altKey: event.altKey });
    lastDrag.current = { clientX: event.clientX, lane: event.currentTarget, track };
    showPreview(value);
    event.dataTransfer.dropEffect = value.valid ? (drag.type === 'clip' ? 'move' : 'copy') : 'none';
  }
  // Alt may change with a stationary pointer. Browsers that suppress key events
  // during native dragging still report it on their repeating dragover events.
  useEffect(() => {
    const modifier = event => {
      const last = lastDrag.current;
      if (!last || !activeDrag || !['Alt', 'AltGraph'].includes(event.key)) return;
      over({ clientX: last.clientX, currentTarget: last.lane, altKey: event.altKey, preventDefault() {}, dataTransfer: { types: [activeDrag.type === 'clip' ? CLIP_DRAG : ASSET_DRAG] } }, last.track);
    };
    window.addEventListener('keydown', modifier); window.addEventListener('keyup', modifier);
    return () => { window.removeEventListener('keydown', modifier); window.removeEventListener('keyup', modifier); };
  });
  async function drop(event, track) {
    event.preventDefault();
    const value = previewRef.current, session = gesture.current, drag = activeDrag;
    const allowed = !busy && !(structureReadOnly && drag?.type === 'asset') && value?.valid && value.trackId === track.id && session?.drag === drag && session.projectId === timeline.projectId && session.revision === timeline.revision;
    let payloadMatches = false;
    try { payloadMatches = drag?.type === 'clip' ? JSON.parse(event.dataTransfer.getData(CLIP_DRAG)).id === drag.id : event.dataTransfer.getData(ASSET_DRAG) === drag?.id; } catch { /* Invalid payload cannot submit. */ }
    clearDrag();
    if (!allowed || !payloadMatches || value.unchanged) return;
    const snapshot = { projectId: session.projectId, expectedRevision: session.revision, durationFrames: value.durationFrames };
    // Commit exactly the displayed frame, not a new position computed on drop.
    if (drag.type === 'clip') await onMoveClip(drag.id, track.id, value.startFrame, snapshot);
    else await onAddAsset(drag.id, track.id, value.startFrame, snapshot);
  }
  const stepSeconds = pixelsPerSecond < 45 ? 5 : pixelsPerSecond < 65 ? 2 : 1;
  const ticks = Array.from({ length: Math.ceil(width / (pixelsPerSecond * stepSeconds)) + 1 }, (_, i) => i * stepSeconds);
  return <Collapsible open={!collapsed} onOpenChange={() => onCollapse()} render={<section />} className={`timeline-panel ${collapsed ? 'is-collapsed' : ''}`} aria-label={t('timeline.view.region')} data-testid="timeline-panel">
    <header className="timeline-header"><div className="region-title"><h2>{t('timeline.view.title')}</h2><span className="timeline-spec">{timeline ? `${timeline.fps} fps · ${timeline.width} × ${timeline.height}` : t('timeline.view.unsaved')}</span></div><div className="timeline-header-actions"><TimelineHistoryControls state={historyState} onHistory={onHistory} busy={busy} /><span className="timeline-length">{t('timeline.view.clipCount', { duration: framesLabel(duration), count: timeline?.clips?.length || 0 })}</span><Button variant="ghost" className="button small" data-testid="timeline-render-preview" disabled={!duration || busy || ['queued','running','pending'].includes(renderJob?.status)} onClick={() => onRender('preview')}><Icon name="play" size={13} />{renderJob && ['queued','running'].includes(renderJob.status) ? t('timeline.view.rendering') : t('timeline.view.renderPreview')}</Button><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" />} title={collapsed ? t('timeline.view.expand') : t('timeline.view.collapse')} aria-label={collapsed ? t('timeline.view.expand') : t('timeline.view.collapse')} data-testid="toggle-timeline"><Icon name={collapsed ? 'plus' : 'minus'} size={16} /></CollapsibleTrigger></div></header>
    <CollapsibleContent className="timeline-body" keepMounted>
      <div className="timeline-toolbar"><Label className="playhead-input"><span>{t('timeline.view.playhead')}</span><Input aria-label={t('timeline.view.playheadFrame')} data-testid="timeline-playhead" type="number" min="0" max="18000" step="1" value={playhead} onChange={e => onSeek(Math.max(0, Math.min(18000, Math.round(Number(e.target.value) || 0))))} /><span>{t('timeline.view.frames')}</span><output>{framesLabel(playhead)}</output></Label>{!basicEditingOnly && <TimelineSplitControls state={splitState} onSplit={onSplit} />}<Button variant="ghost" className={`button small timeline-snap-toggle ${snappingEnabled ? 'active' : ''}`} data-testid="timeline-snapping" aria-pressed={snappingEnabled} title={t(sessionViewOnly ? 'opacity.restored.snapHint' : 'timeline.view.snapHint')} onClick={() => updateViewState({ snappingEnabled: !snappingEnabled })}><Icon name="magnet" size={14} />{t(snappingEnabled ? 'timeline.view.snapOn' : 'timeline.view.snapOff')}</Button>{!basicEditingOnly && <TimelineWaveformControls state={waveforms} disabled={!timeline} />}<div className="track-add-actions"><Button variant="ghost" className="button small" data-testid="add-video-track" disabled={structureReadOnly || !timeline || busy || tracks.length >= 12} onClick={() => { if (!structureReadOnly) onTrackAdd('video'); }}><Icon name="plus" size={12} />{t('timeline.view.videoTrack')}</Button><Button variant="ghost" className="button small" data-testid="add-audio-track" disabled={structureReadOnly || !timeline || busy || tracks.length >= 12} onClick={() => { if (!structureReadOnly) onTrackAdd('audio'); }}><Icon name="plus" size={12} />{t('timeline.view.audioTrack')}</Button>{!basicEditingOnly && <Button variant="ghost" className="text-button seed-timeline" data-testid="seed-timeline" title={t('timeline.view.seedHint')} disabled={!canSeed || duration > 0 || busy} onClick={onSeed}>{t('timeline.view.seed')}</Button>}</div><Label className="timeline-zoom"><span id="timeline-zoom-label">{t('timeline.view.zoom')}</span><Slider className="timeline-zoom-slider" aria-labelledby="timeline-zoom-label" min={28} max={220} step={1} value={[pixelsPerSecond]} onValueChange={value => updateViewState({ pixelsPerSecond: Array.isArray(value) ? value[0] : value })} /><span>{Math.round(pixelsPerSecond / 76 * 100)}%</span></Label></div>
      <div className="timeline-scroll" ref={viewport} data-testid="timeline-scroll" onScroll={event => { const element = event.currentTarget; if (!collapsed && visible) updateViewState({ scrollLeft: element.scrollLeft, scrollTop: element.scrollTop }, workspaceOrigin ? { passive: true } : undefined); }}><div className="timeline-content" style={{ width: width + 160 }}><div className="timeline-ruler-row"><div className="track-label ruler-label">{t('timeline.view.track')}<span>{t('timeline.view.stacking')}</span></div><div className="timeline-ruler" style={{ width }} role="slider" aria-label={t('timeline.view.ruler')} aria-valuemin={0} aria-valuemax={18000} aria-valuenow={playhead} tabIndex={0} onClick={e => onSeek(frameAt(e))} onKeyDown={e => { const frame = rulerFrameForKey(e.key, playhead); if (frame !== null) { e.preventDefault(); onSeek(frame); } }}>{ticks.map(second => <span key={second} className="ruler-tick" style={{ left: second * pixelsPerSecond }}>{String(Math.floor(second / 60)).padStart(2, '0')}:{String(second % 60).padStart(2, '0')}</span>)}<div className="ruler-head" style={{ left: playhead * pxFrame }} /></div></div>
        {timeline && !basicEditingOnly && <SubtitleLane timeline={timeline} pixelsPerFrame={pxFrame} pixelsPerSecond={pixelsPerSecond} width={width} playhead={playhead} selectedCueId={selectedCueId} onSelect={onSelectSubtitle} onAdd={onAddSubtitle} onSeek={onSeek} busy={busy || subtitleBlocked} visible={visible && !collapsed} />}
        {tracks.map((track, index) => <div className={`timeline-track ${track.kind} ${track.hidden ? 'track-hidden' : ''} ${track.muted ? 'track-muted' : ''}`} key={track.id} data-testid={`timeline-track-${track.id}`} data-waveform-track={track.id}><div className="track-label"><div><span className={`track-kind ${track.kind}`}>{track.kind === 'audio' ? 'A' : 'V'}{track.kind === 'audio' ? tracks.filter(t => t.kind === 'audio').indexOf(track) + 1 : videoTracks.length - index}</span><strong title={track.name}>{track.name}</strong></div><div className="track-controls">{track.kind === 'video' && <Label className="track-switch"><Switch size="sm" aria-label={t('timeline.view.showTrack', { name: track.name })} title={t('timeline.view.pictureOnly')} checked={!track.hidden} disabled={structureReadOnly || busy} onCheckedChange={checked => { if (!structureReadOnly) onTrackUpdate(track.id, { hidden: !checked }); }} /><span>{track.hidden ? t('timeline.view.hidden') : t('timeline.view.pictureOn')}</span></Label>}<Label className="track-switch"><Switch size="sm" aria-label={t('timeline.view.muteTrack', { name: track.name })} title={t('timeline.view.allTrackSound')} checked={track.muted} disabled={structureReadOnly || busy} onCheckedChange={checked => { if (!structureReadOnly) onTrackUpdate(track.id, { muted: checked }); }} /><span>{track.muted ? t('timeline.view.muted') : t('timeline.view.soundOn')}</span></Label></div></div><div className={`track-lane ${preview?.trackId === track.id ? (preview.valid ? 'drag-over' : 'drag-invalid') : ''}`} aria-label={t('timeline.view.dropArea', { name: track.name })} data-testid={`track-lane-${track.id}`} style={{ width, backgroundSize: `${pixelsPerSecond}px 100%` }} onClick={e => { if (e.target === e.currentTarget) onSeek(frameAt(e)); }} onDragOver={e => over(e, track)} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) { lastDrag.current = null; showPreview(null); } }} onDrop={e => drop(e, track)}>
          {timeline.clips.filter(clip => clip.trackId === track.id).map(clip => { const asset = assets.find(a => a.id === clip.assetId); const kind = assetKind(asset); const waveform = waveformWindows.get(clip.id); const stale = staleClips.get(clip.id); return <Button variant="ghost" key={clip.id} className={`timeline-clip ${kind} ${selectedClipId === clip.id ? 'selected' : ''} ${waveforms.enabled && waveform ? 'has-waveform' : ''} ${stale ? 'source-stale' : ''}`} style={{ left: clip.startFrame * pxFrame, width: Math.max(8, clip.durationFrames * pxFrame) }} data-testid={`timeline-clip-${clip.id}`} title={t('timeline.view.clipTooltip', { name: clip.name || asset?.name || t('timeline.view.mediaClip'), start: clip.startFrame, end: clip.startFrame + clip.durationFrames, stale: stale ? ` ${staleSourceSentence(stale, locale)}` : '' })} aria-label={t('timeline.view.clipAria', { name: clip.name || asset?.name || t('timeline.view.mediaClip'), stale: stale ? t('timeline.view.newVersion') : '' })} aria-pressed={selectedClipId === clip.id} draggable={!busy} onClick={e => { e.stopPropagation(); onSelectClip(clip.id); }} onDragStart={e => { const grabFrame = Math.max(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / pxFrame); activeDrag = { type: 'clip', id: clip.id, grabFrame }; gesture.current = { drag: activeDrag, projectId: timeline.projectId, revision: timeline.revision }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(CLIP_DRAG, JSON.stringify({ id: clip.id, grabFrame })); }}>
            {waveforms.enabled && waveform && <TimelineWaveform window={waveform} entry={waveforms.entries.get(waveform.key)} />}{kind === 'image' ? <img src={assetUrl(asset)} alt="" draggable={false} /> : <span className="clip-symbol"><Icon name={kind === 'audio' ? 'music' : 'film'} size={16} /></span>}<span className="clip-copy"><strong>{clip.name || asset?.name || t('timeline.view.mediaClip')}</strong><small>{t('timeline.view.clipDuration', { frames: clip.durationFrames, seconds: formatNumber(clip.durationFrames / fps, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }) })}</small></span><span className="clip-end-mark" />{stale && <span className="clip-stale-mark" aria-hidden="true" />}</Button>; })}
          {preview?.trackId === track.id && <><div className={`timeline-drop-preview ${preview.valid ? '' : 'invalid'}`} data-testid="timeline-drop-preview" data-start-frame={preview.startFrame} data-duration-frames={preview.durationFrames} data-valid={preview.valid} style={{ left: preview.startFrame * pxFrame, width: Math.max(8, preview.durationFrames * pxFrame) }}><span>{preview.startFrame} → {preview.startFrame + preview.durationFrames}f</span></div>{preview.snap && <div className={`timeline-snap-guide ${preview.valid ? '' : 'invalid'}`} data-testid="timeline-snap-guide" data-snap-frame={preview.snap.frame} style={{ left: preview.snap.frame * pxFrame }}><span>{renderMessage(preview.snap.labelMessage)} · {preview.snap.frame}f</span></div>}</>}
          {!timeline.clips.some(c => c.trackId === track.id) && <span className="track-drop-hint">{t(track.kind === 'audio' ? 'timeline.view.dropAudio' : 'timeline.view.dropVisual')}</span>}<div className="track-playhead" style={{ left: playhead * pxFrame }} /></div></div>)}
        {!timeline && <div className="timeline-empty">{t('timeline.view.empty')}</div>}
      </div></div><footer className={`timeline-footnote ${preview && !preview.valid ? 'invalid' : ''}`}><span data-testid="timeline-drop-status" role="status" aria-live="polite">{preview ? t('timeline.view.dropStatus', { action: t(preview.valid ? (preview.unchanged ? 'timeline.view.positionUnchanged' : 'timeline.view.releaseToDrop') : 'timeline.view.cannotDrop'), start: preview.startFrame, end: preview.startFrame + preview.durationFrames, reason: renderMessage(preview.reasonMessage) || (preview.altKey ? t('timeline.view.altNoSnap') : preview.snap ? `${renderMessage(preview.snap.labelMessage)} ${preview.snap.frame}f` : snappingEnabled ? t('timeline.view.outsideSnap') : t('timeline.view.snapDisabled')), note: preview.noteMessage && preview.known ? ` · ${renderMessage(preview.noteMessage)}` : '' }) : t('timeline.view.dragHint')}</span><span>{t('timeline.view.revision', { revision: timeline?.revision ?? '—' })}</span></footer>
    </CollapsibleContent>
  </Collapsible>;
}
