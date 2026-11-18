import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useLayoutEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@mioon/ui/components/button';
import { subtitleAddMessage } from './subtitle-state.ts';
import type { SubtitleTimeline } from './subtitle-state.ts';
import './subtitles.css';
import {timelinePointerFrameAtElement} from './timeline-view-geometry.ts';
import Icon from './icons.tsx';
import {TimelineTrackPlayhead, useTimelinePlaybackFrame} from './timeline-playhead.tsx';
import type {TimelinePlaybackClock} from './timeline-playback-clock.ts';

export interface SubtitleLaneProps {
  timeline: SubtitleTimeline;
  pixelsPerFrame: number;
  pixelsPerSecond: number;
  width: number | string;
  playhead: number;
  playbackClock?: TimelinePlaybackClock;
  selectedCueId?: string | null;
  onSelect: (cueId: string) => unknown;
  onAdd: (frame: number) => unknown;
  onSeek: (frame: number) => unknown;
  busy: boolean;
  visible: boolean;
}

export default function SubtitleLane({ timeline, pixelsPerFrame, pixelsPerSecond, width, playhead, playbackClock, selectedCueId, onSelect, onAdd, onSeek, busy, visible }: SubtitleLaneProps): ReactElement {
  const { t } = useI18n();
  const live = useRef({mounted: false, visible, timeline, busy, playhead, playbackClock});
  useLayoutEffect(() => {
    live.current = {mounted: true, visible, timeline, busy, playhead, playbackClock};
    return () => { live.current.mounted = false; };
  }, [timeline, visible, busy, playhead, playbackClock]);
  const admit = (action: () => unknown): unknown => {
    if (live.current.mounted && live.current.visible && live.current.timeline === timeline) return action();
  };
  const currentPlayhead = () => live.current.playbackClock?.getSnapshot() ?? live.current.playhead;
  const addAt = (frame: number) => {
    if (!live.current.busy && frame === currentPlayhead()) return admit(() => onAdd(frame));
  };
  const cues = timeline?.subtitles?.cues || [];
  return <div className="timeline-track subtitle-track" data-testid="timeline-subtitle-track"><div className="track-label" data-text-selectable={false}><div><span className="track-kind">T</span><strong title={t('subtitles.ui.count', { count: cues.length })}>{t('round3.timeline.subtitles')}</strong></div><SubtitleAddButton timeline={timeline} playhead={playhead} playbackClock={playbackClock} busy={busy} onAdd={addAt} /></div><div className="track-lane subtitle-lane" style={{ width, backgroundSize: `${pixelsPerSecond}px 100%` }} aria-label={t('subtitles.ui.timeline')} onClick={event => { if (event.target === event.currentTarget) admit(() => onSeek(Math.max(0, Math.min(timeline.durationFrames, Math.round(timelinePointerFrameAtElement(event.clientX,event.currentTarget,pixelsPerFrame) ?? currentPlayhead()))))); }}>
    {cues.map(cue => <Button type="button" variant="ghost" key={cue.id} className={`timeline-clip subtitle-cue ${selectedCueId === cue.id ? 'selected' : ''}`} data-testid={`subtitle-cue-${cue.id}`} aria-label={t('subtitles.ui.cueAria', { text: cue.text, start: cue.startFrame, end: cue.startFrame + cue.durationFrames })} aria-pressed={selectedCueId === cue.id} style={{ left: cue.startFrame * pixelsPerFrame, width: Math.max(8, cue.durationFrames * pixelsPerFrame) }} title={t('subtitles.ui.cueTitle', { text: cue.text, start: cue.startFrame, end: cue.startFrame + cue.durationFrames })} onClick={event => { event.stopPropagation(); admit(() => onSelect(cue.id)); }}><span className="clip-copy"><strong>{cue.text.replaceAll('\n', ' / ')}</strong><small>{t('subtitles.ui.range', { start: cue.startFrame, end: cue.startFrame + cue.durationFrames })}</small></span></Button>)}
    {!cues.length && <SubtitleEmptyHint timeline={timeline} playhead={playhead} playbackClock={playbackClock} busy={busy} />}
    <TimelineTrackPlayhead clock={playbackClock} playhead={playhead} pixelsPerFrame={pixelsPerFrame} />
  </div></div>;
}

type SubtitlePositionProps = Pick<SubtitleLaneProps, 'timeline' | 'playhead' | 'playbackClock' | 'busy'>;

function SubtitleAddButton({timeline, playhead, playbackClock, busy, onAdd}: SubtitlePositionProps & {onAdd: SubtitleLaneProps['onAdd']}) {
  const {t, renderMessage} = useI18n();
  const frame = useTimelinePlaybackFrame(playbackClock, playhead);
  const reason = renderMessage(subtitleAddMessage(timeline, frame, busy));
  return <Button type="button" variant="ghost" size="sm" className="subtitle-add" data-testid="subtitle-add"
    aria-label={t('subtitles.ui.add')} title={reason || t('subtitles.ui.addAt', {frame})} disabled={Boolean(reason)}
    onClick={() => {
      const latest = playbackClock?.getSnapshot() ?? playhead;
      if (!subtitleAddMessage(timeline, latest, busy)) onAdd(latest);
    }}><Icon name="plus" size={14} /></Button>;
}

function SubtitleEmptyHint({timeline, playhead, playbackClock, busy}: SubtitlePositionProps) {
  const {t, renderMessage} = useI18n();
  const frame = useTimelinePlaybackFrame(playbackClock, playhead);
  return <span className="track-drop-hint">{renderMessage(subtitleAddMessage(timeline, frame, busy)) || t('subtitles.ui.empty')}</span>;
}
