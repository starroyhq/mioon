import React, { useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { Button } from '@mioon/ui/components/button';
import { useI18n } from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import { sceneClock, sceneCutAdjusted, sceneSegmentNumber, sceneSeconds, sceneTime } from './scene-cuts.ts';
import type { SceneDraftCut, SceneSegment } from './scene-cuts.ts';

export interface SceneTile { readonly frame: number; readonly url?: string }
export interface SceneCutBarProps {
  readonly frameCount: number;
  readonly cuts: readonly SceneDraftCut[];
  readonly editable: boolean;
  /** While detecting: frames decoded so far; the rest of the bar waits. */
  readonly detectedFrames?: number | null;
  readonly selected: SceneSegment | null;
  readonly playhead: number | null;
  readonly tiles: readonly SceneTile[];
  readonly onSeek?: (frame: number) => void;
  readonly onAdd?: (frame: number) => void;
  readonly onMove?: (index: number, frame: number) => void;
  readonly onRemove?: (index: number) => void;
}
const percent = (frame: number, frameCount: number): string => `${Math.max(0, Math.min(100, frame * 100 / Math.max(1, frameCount)))}%`;
const axis = [0, 0.25, 0.5, 0.75, 1];

/** The scene dialog's cut bar: a filmstrip with one marker per cut. Markers drag,
 * move with the arrow keys (Shift for ten frames) and delete on right click or
 * Delete; a double click on the strip adds a cut there. */
export function SceneCutBar({ frameCount, cuts, editable, detectedFrames = null, selected, playhead, tiles, onSeek, onAdd, onMove, onRemove }: SceneCutBarProps) {
  const { t } = useI18n();
  const track = useRef<HTMLDivElement | null>(null), drag = useRef<{ index: number; pointer: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const frameAt = (clientX: number): number => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    return Math.max(0, Math.min(frameCount - 1, Math.round((clientX - box.left) / box.width * frameCount)));
  };
  const onMarker = (target: EventTarget | null): boolean => typeof (target as Element | null)?.closest === 'function' && Boolean((target as Element).closest('.scene-cut'));
  const waiting = detectedFrames !== null && detectedFrames < frameCount;
  const active = hover !== null ? cuts[hover] : undefined;
  return <div className="scene-cutbar" data-editable={editable || undefined}>
    <div className="scene-cutbar-track" ref={track} data-testid="scene-cutbar"
      onClick={(event: MouseEvent<HTMLDivElement>) => { if (!onMarker(event.target)) onSeek?.(frameAt(event.clientX)); }}
      onDoubleClick={(event: MouseEvent<HTMLDivElement>) => { if (editable && !onMarker(event.target)) onAdd?.(frameAt(event.clientX)); }}>
      <div className="scene-filmstrip" aria-hidden="true">{tiles.map(tile => <span key={tile.frame} className="scene-filmstrip-tile" data-waiting={waiting && tile.frame >= (detectedFrames ?? 0) || undefined}>{tile.url && !(waiting && tile.frame >= (detectedFrames ?? 0)) && <img src={tile.url} alt="" draggable={false} />}</span>)}</div>
      {waiting && <div className="scene-cutbar-waiting" style={{ left: percent(detectedFrames ?? 0, frameCount) }}><Icon name="clock" size={12} /><span>{t('scene.detecting.waiting')}</span></div>}
      {selected && <span className="scene-cutbar-segment" aria-hidden="true" style={{ left: percent(selected.start, frameCount), width: percent(selected.end - selected.start, frameCount) }} />}
      {playhead !== null && <span className="scene-cutbar-playhead" aria-hidden="true" style={{ left: percent(playhead, frameCount) }} />}
      {cuts.map((cut, index) => editable ? <Button key={`${index}:${cut.origin ?? 'new'}`} type="button" variant="ghost" className="scene-cut" data-adjusted={sceneCutAdjusted(cut) || undefined} data-testid={`scene-cut-${index}`}
        style={{ left: percent(cut.frame, frameCount) }} aria-label={t('scene.cut.label', { time: sceneTime(cut.frame) })} aria-description={t('scene.cut.keyboard')}
        onPointerEnter={() => setHover(index)} onPointerLeave={() => { if (!drag.current) setHover(null); }}
        onPointerDown={(event: PointerEvent<HTMLButtonElement>) => { if (event.button !== 0) return; drag.current = { index, pointer: event.pointerId }; setHover(index); event.currentTarget.setPointerCapture?.(event.pointerId); }}
        onPointerMove={(event: PointerEvent<HTMLButtonElement>) => { if (drag.current?.pointer === event.pointerId) onMove?.(drag.current.index, frameAt(event.clientX)); }}
        onPointerUp={(event: PointerEvent<HTMLButtonElement>) => { if (drag.current?.pointer === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture?.(event.pointerId); } }}
        onPointerCancel={() => { drag.current = null; setHover(null); }}
        onClick={() => onSeek?.(cut.frame)}
        onContextMenu={(event: MouseEvent<HTMLButtonElement>) => { event.preventDefault(); setHover(null); onRemove?.(index); }}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          const step = event.shiftKey ? 10 : 1;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onMove?.(index, cut.frame + (event.key === 'ArrowLeft' ? -step : step)); }
          else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); setHover(null); onRemove?.(index); }
        }}><span className="scene-cut-line" /><span className="scene-cut-handle" /></Button>
        : <span key={`${index}:${cut.frame}`} className="scene-cut" data-adjusted={sceneCutAdjusted(cut) || undefined} style={{ left: percent(cut.frame, frameCount) }}><span className="scene-cut-line" /><span className="scene-cut-handle" /></span>)}
      {editable && active && <span className="scene-cut-tooltip" role="status" style={{ left: percent(active.frame, frameCount) }}>{t('scene.cuts.tooltip', { time: sceneTime(active.frame) })}</span>}
    </div>
    <div className="scene-cutbar-axis" aria-hidden="true">{axis.map(position => <span key={position} style={{ left: `${position * 100}%` }}>{sceneClock(Math.round(position * frameCount))}</span>)}</div>
  </div>;
}

export interface SceneSegmentStripProps {
  readonly segments: readonly SceneSegment[];
  readonly selected: number | null;
  readonly thumbnail: (frame: number) => string | undefined;
  readonly onSelect: (segment: SceneSegment) => void;
}
/** One card per segment with its middle frame, the keyframe a storyboard would use. */
export function SceneSegmentStrip({ segments, selected, thumbnail, onSelect }: SceneSegmentStripProps) {
  const { t, formatNumber } = useI18n();
  return <div className="scene-segments" data-testid="scene-segments">{segments.map(segment => {
    const seconds = formatNumber(sceneSeconds(segment.end - segment.start), { minimumFractionDigits: 1, maximumFractionDigits: 1 }), url = thumbnail(segment.middle);
    return <Button key={segment.index} type="button" variant="ghost" className="scene-segment" data-testid={`scene-segment-${segment.index}`} aria-pressed={selected === segment.index}
      aria-label={t('scene.segment.label', { index: segment.index, seconds })} onClick={() => onSelect(segment)}>
      <span className="scene-segment-thumb">{url && <img src={url} alt="" draggable={false} />}</span>
      <span className="scene-segment-meta"><b>{sceneSegmentNumber(segment.index)}</b><span>{t('scene.seconds', { seconds })}</span></span>
    </Button>;
  })}</div>;
}
