import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import React, { useLayoutEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@mioon/ui/components/button';
import { subtitleAddMessage } from './subtitle-state.ts';
import type { SubtitleTimeline } from './subtitle-state.ts';
import './subtitles.css';
import {timelinePointerFrameAtElement} from './timeline-view-geometry.ts';

export interface SubtitleLaneProps {
  timeline: SubtitleTimeline;
  pixelsPerFrame: number;
  pixelsPerSecond: number;
  width: number | string;
  playhead: number;
  selectedCueId: string | null;
  onSelect: (cueId: string) => unknown;
  onAdd: (frame: number) => unknown;
  onSeek: (frame: number) => unknown;
  busy: boolean;
  visible: boolean;
}

export default function SubtitleLane({ timeline, pixelsPerFrame, pixelsPerSecond, width, playhead, selectedCueId, onSelect, onAdd, onSeek, busy, visible }: SubtitleLaneProps): ReactElement {
  const { t, renderMessage } = useI18n();
  const live = useRef<{ mounted: boolean; visible: boolean; timeline: SubtitleTimeline; busy: boolean; playhead: number }>({ mounted: false, visible, timeline, busy, playhead });
  useLayoutEffect(() => { live.current = { mounted: true, visible, timeline, busy, playhead }; return () => { live.current.mounted = false; }; }, [timeline, visible, busy, playhead]);
  const admit = (action: () => unknown): unknown => { if (live.current.mounted && live.current.visible && live.current.timeline === timeline) return action(); };
  const reason = renderMessage(subtitleAddMessage(timeline, playhead, busy)), cues = timeline?.subtitles?.cues || [];
  return <div className="timeline-track subtitle-track" data-testid="timeline-subtitle-track"><div className="track-label"><div><span className="track-kind">T</span><strong>{t('subtitles.ui.count', { count: cues.length })}</strong></div><Button type="button" variant="ghost" size="sm" className="subtitle-add" data-testid="subtitle-add" title={reason || t('subtitles.ui.addAt', { frame: playhead })} disabled={Boolean(reason)} onClick={() => { if (!reason && !live.current.busy && live.current.playhead === playhead) admit(() => onAdd(playhead)); }}>{t('subtitles.ui.add')}</Button></div><div className="track-lane subtitle-lane" style={{ width, backgroundSize: `${pixelsPerSecond}px 100%` }} aria-label={t('subtitles.ui.timeline')} onClick={event => { if (event.target === event.currentTarget) admit(() => onSeek(Math.max(0, Math.min(timeline.durationFrames, Math.round(timelinePointerFrameAtElement(event.clientX,event.currentTarget,pixelsPerFrame) ?? playhead))))); }}>
    {cues.map(cue => <Button type="button" variant="ghost" key={cue.id} className={`timeline-clip subtitle-cue ${selectedCueId === cue.id ? 'selected' : ''}`} data-testid={`subtitle-cue-${cue.id}`} aria-label={t('subtitles.ui.cueAria', { text: cue.text, start: cue.startFrame, end: cue.startFrame + cue.durationFrames })} aria-pressed={selectedCueId === cue.id} style={{ left: cue.startFrame * pixelsPerFrame, width: Math.max(8, cue.durationFrames * pixelsPerFrame) }} title={t('subtitles.ui.cueTitle', { text: cue.text, start: cue.startFrame, end: cue.startFrame + cue.durationFrames })} onClick={event => { event.stopPropagation(); admit(() => onSelect(cue.id)); }}><span className="clip-copy"><strong>{cue.text.replaceAll('\n', ' / ')}</strong><small>{t('subtitles.ui.range', { start: cue.startFrame, end: cue.startFrame + cue.durationFrames })}</small></span></Button>)}
    {!cues.length && <span className="track-drop-hint">{reason || t('subtitles.ui.empty')}</span>}<div className="track-playhead" style={{ left: playhead * pixelsPerFrame }} />
  </div></div>;
}
