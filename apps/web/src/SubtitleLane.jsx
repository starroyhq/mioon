import React, { useLayoutEffect, useRef } from 'react';
import { Button } from '@mioon/ui/components/button';
import { subtitleAddReason } from './subtitle-state.js';
import './subtitles.css';

export default function SubtitleLane({ timeline, pixelsPerFrame, pixelsPerSecond, width, playhead, selectedCueId, onSelect, onAdd, onSeek, busy, visible }) {
  const live = useRef({ mounted: false });
  useLayoutEffect(() => { live.current = { mounted: true, visible, timeline, busy, playhead }; return () => { live.current.mounted = false; }; }, [timeline, visible, busy, playhead]);
  const admit = action => { if (live.current.mounted && live.current.visible && live.current.timeline === timeline) return action(); };
  const reason = subtitleAddReason(timeline, playhead, busy), cues = timeline?.subtitles?.cues || [];
  return <div className="timeline-track subtitle-track" data-testid="timeline-subtitle-track"><div className="track-label"><div><span className="track-kind">T</span><strong>手动字幕 · {cues.length}/100</strong></div><Button type="button" variant="ghost" size="sm" className="subtitle-add" data-testid="subtitle-add" title={reason || `在第 ${playhead} 帧新增字幕`} disabled={Boolean(reason)} onClick={() => { if (!reason && !live.current.busy && live.current.playhead === playhead) admit(() => onAdd(playhead)); }}>在播放头处新增</Button></div><div className="track-lane subtitle-lane" style={{ width, backgroundSize: `${pixelsPerSecond}px 100%` }} aria-label="字幕时间线" onClick={event => { if (event.target === event.currentTarget) admit(() => onSeek(Math.max(0, Math.min(timeline.durationFrames, Math.round((event.clientX - event.currentTarget.getBoundingClientRect().left) / pixelsPerFrame))))); }}>
    {cues.map(cue => <Button type="button" variant="ghost" key={cue.id} className={`timeline-clip subtitle-cue ${selectedCueId === cue.id ? 'selected' : ''}`} data-testid={`subtitle-cue-${cue.id}`} aria-label={`字幕 ${cue.text}，${cue.startFrame} 至 ${cue.startFrame + cue.durationFrames} 帧`} aria-pressed={selectedCueId === cue.id} style={{ left: cue.startFrame * pixelsPerFrame, width: Math.max(8, cue.durationFrames * pixelsPerFrame) }} title={`${cue.text}\n${cue.startFrame}–${cue.startFrame + cue.durationFrames} 帧`} onClick={event => { event.stopPropagation(); admit(() => onSelect(cue.id)); }}><span className="clip-copy"><strong>{cue.text.replaceAll('\n', ' / ')}</strong><small>{cue.startFrame}–{cue.startFrame + cue.durationFrames} 帧</small></span></Button>)}
    {!cues.length && <span className="track-drop-hint">{reason || '在播放头处新增，随后在右侧编辑文字与整数帧'}</span>}<div className="track-playhead" style={{ left: playhead * pixelsPerFrame }} />
  </div></div>;
}
