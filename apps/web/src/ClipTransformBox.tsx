import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClipTransform } from '@mioon/contracts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { transformIssue, withKeyframe } from './clip-transform-state.ts';
import { BOX_DRAG_THRESHOLD, boxFields, boxFrame, boxValues, containedPicture, movedBoxValues, sameBoxValues, scaledBoxValues, transformBoxView,
  type BoxClip, type BoxPoint, type BoxRect, type BoxValues, type BoxView } from './clip-transform-box-state.ts';
import './clip-transform.css';

/** What the preview needs to draw and edit the selected clip's transform box. */
export interface PreviewTransformBox {
  readonly clip: BoxClip & { readonly id: string };
  readonly source: { readonly width?: unknown; readonly height?: unknown } | null;
  /** Why the transform cannot change now; the box is then only outlined. */
  readonly disabledReason?: DisplayMessage | null;
  /** A timeline edit is in flight: the box keeps its look but ignores drags. */
  readonly busy?: boolean;
  readonly onSetTransform: (clipId: string, transform: ClipTransform) => unknown;
}
export interface BoxLayout { readonly width: number; readonly height: number; readonly picture: BoxRect }
interface Drag { readonly pointerId: number; readonly mode: 'move' | 'scale'; readonly frame: number; readonly origin: BoxPoint; readonly center: BoxPoint; readonly start: BoxValues; readonly factor: number; values: BoxValues | null }
type Mode = Drag['mode'];
const CORNERS = ['nw', 'ne', 'se', 'sw'] as const;
const percent = (value: number, total: number): string => `${value / total * 100}%`;
const number = (value: number): string => String(Number(value.toFixed(2)));

/** The box itself, positioned in percent of the layer so the app's zoom never
 * matters; the handlers come from ClipTransformBox. */
export function ClipTransformBoxFrame({ layout, view, editable, label, hint, readout, onBegin, onMove, onEnd, onCancel }: {
  layout: BoxLayout; view: BoxView; editable: boolean; label: string; hint: string; readout?: string;
  onBegin?: (mode: Mode) => (event: React.PointerEvent<HTMLElement>) => void;
  onMove?: (event: React.PointerEvent<HTMLElement>) => void; onEnd?: (event: React.PointerEvent<HTMLElement>) => void; onCancel?: () => void;
}) {
  return <>
    <div className="clip-transform-box" data-testid="clip-transform-box" data-editable={editable ? 'true' : 'false'} role="group" aria-label={label} title={hint}
      style={{ left: percent(view.center.x, layout.width), top: percent(view.center.y, layout.height), width: percent(view.width, layout.width), height: percent(view.height, layout.height),
        transform: `translate(-50%, -50%) rotate(${view.rotation}deg)` }}
      onPointerDown={onBegin?.('move')} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onCancel} onLostPointerCapture={onCancel}>
      {editable && CORNERS.map(corner => <span key={corner} className={`clip-transform-handle ${corner}`} data-testid={`clip-transform-handle-${corner}`} aria-hidden="true" onPointerDown={onBegin?.('scale')} />)}
    </div>
    {readout && <output className="clip-transform-box-readout" data-testid="clip-transform-box-readout">{readout}</output>}
  </>;
}

/** The selected clip's content box over the rendered timeline preview at the
 * playhead frame. Dragging the body moves the content and a corner scales it
 * about its centre; releasing sets a keyframe at that frame, as the inspector's
 * button does. The video keeps the last render until the preview is updated. */
export default function ClipTransformBox({ box, playhead, timeline, media, mediaKey }: {
  box: PreviewTransformBox; playhead: number; timeline: { readonly width: number; readonly height: number };
  media: React.RefObject<HTMLMediaElement | null>; mediaKey: string;
}) {
  const { t, renderMessage } = useI18n();
  const layer = useRef<HTMLDivElement | null>(null), drag = useRef<Drag | null>(null);
  const [layout, setLayout] = useState<BoxLayout | null>(null);
  const [live, setLive] = useState<BoxValues | null>(null), [pending, setPending] = useState<BoxValues | null>(null);
  const frame = boxFrame(box.clip, playhead);
  useLayoutEffect(() => {
    const element = media.current as HTMLVideoElement | null, host = layer.current;
    if (!element || !host) { setLayout(null); return; }
    const measure = () => {
      const outer = host.getBoundingClientRect(), inner = element.getBoundingClientRect();
      // Client pixels per CSS pixel: the whole UI is zoomed.
      const unit = element.offsetWidth ? inner.width / element.offsetWidth : 1;
      const picture = containedPicture({ left: inner.left - outer.left + element.clientLeft * unit, top: inner.top - outer.top + element.clientTop * unit,
        width: element.clientWidth * unit, height: element.clientHeight * unit }, element.videoWidth && element.videoHeight ? { width: element.videoWidth, height: element.videoHeight } : timeline);
      setLayout(picture && outer.width > 0 && outer.height > 0 ? { width: outer.width, height: outer.height, picture } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element); observer.observe(host);
    element.addEventListener('loadedmetadata', measure); element.addEventListener('resize', measure);
    return () => { observer.disconnect(); element.removeEventListener('loadedmetadata', measure); element.removeEventListener('resize', measure); };
  }, [media, mediaKey, timeline.width, timeline.height]);
  const cancel = (): void => { if (drag.current) { drag.current = null; setLive(null); } };
  // A drag belongs to the frame and clip it started on.
  useEffect(() => { cancel(); }, [frame, box.clip.id]);
  const dragging = Boolean(live);
  useEffect(() => {
    if (!dragging) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [dragging]);
  const shown = live ?? pending;
  const view = layout && frame !== null ? transformBoxView(box.clip, box.source, timeline, layout.picture, frame, shown) : null;
  const issue = frame === null ? '' : transformIssue(box.clip, frame, boxFields(boxValues(box.clip, frame)));
  const reason = box.disabledReason ? renderMessage(box.disabledReason) : issue ? t(issue) : '';
  const editable = !reason, interactive = editable && !box.busy && !pending;
  const begin = (mode: Mode) => (event: React.PointerEvent<HTMLElement>): void => {
    if (!interactive || event.button !== 0 || frame === null || !view || !layer.current) return;
    event.preventDefault(); event.stopPropagation();
    const outer = layer.current.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, mode, frame, origin: { x: event.clientX, y: event.clientY }, center: { x: outer.left + view.center.x, y: outer.top + view.center.y },
      start: boxValues(box.clip, frame), factor: view.factor, values: null };
  };
  const move = (event: React.PointerEvent<HTMLElement>): void => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const travel = { x: event.clientX - current.origin.x, y: event.clientY - current.origin.y };
    if (!current.values && Math.hypot(travel.x, travel.y) < BOX_DRAG_THRESHOLD) return;
    current.values = current.mode === 'move' ? movedBoxValues(current.start, travel, current.factor) : scaledBoxValues(current.start, current.center, current.origin, { x: event.clientX, y: event.clientY });
    setLive(current.values);
  };
  const end = (event: React.PointerEvent<HTMLElement>): void => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null; setLive(null);
    const next = current.values && !sameBoxValues(current.values, current.start) ? withKeyframe(box.clip, current.frame, boxFields(current.values)) : null;
    if (!next) return;
    setPending(current.values);
    void Promise.resolve(box.onSetTransform(box.clip.id, next)).finally(() => setPending(null));
  };
  return <div ref={layer} className="clip-transform-box-layer" data-testid="clip-transform-box-layer">
    {layout && view && <ClipTransformBoxFrame layout={layout} view={view} editable={editable} label={t('clip.transform.box')} hint={reason || t('clip.transform.box')}
      readout={live ? t('clip.transform.box.readout', { x: number(live.x), y: number(live.y), scale: number(live.scale * 100) }) : undefined}
      onBegin={begin} onMove={move} onEnd={end} onCancel={cancel} />}
  </div>;
}
