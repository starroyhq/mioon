import React, { useId, useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { coveredInsets, measuredOverlays } from './canvas-fit.ts';
import type { Box, Side } from './canvas-fit.ts';
import Icon from './icons.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import { mioFollowColor } from './mio-follow.ts';
import type { MioFollowFocus, MioFollowLocation, MioFollowTarget } from './mio-follow.ts';
import { createMioCursorMotion } from './mio-follow-motion.ts';
import type { MioFollowPoint } from './mio-follow-motion.ts';
import { MARK_LAYER_ATTRIBUTE, markTargetElements, markTargetVisible } from './target-marks.ts';
import './mio-follow-layer.css';

const MIO_FOLLOW_IDLE_MS = 2000;
const REVEAL_RETRY_MS = 160;
const MEASURE_INTERVAL_MS = 100;
const LOCATOR_MARGIN = 12;
const LABEL_MAX_WIDTH = 240;
const CANVAS = '[data-testid="canvas-drop-zone"] .react-flow';
const TIMELINE = '[data-testid="timeline-scroll"]';
const EDITABLE = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
// The rounded #cursor outline is from Cua Driver's app-icon.svg (MIT).
const CURSOR_PATH = 'M411.5 326 C373 315 340 342.5 345.5 386.5 C345.5 386.5 461 700 461 700 C477.5 744 510.5 744 532.5 705.5 C532.5 705.5 582 595.5 582 595.5 C593 573.5 609.5 557 631.5 546 C631.5 546 703 507.5 703 507.5 C741.5 485.5 736 452.5 697.5 436 C697.5 436 411.5 326 411.5 326 Z';

interface Props {
  focus: MioFollowFocus | null;
  mode: 'canvas' | 'editing';
  enabled: boolean;
  reduceMotion: boolean;
  onReveal: (target: MioFollowTarget, behavior: ScrollBehavior) => boolean;
  onLocate?: (target: MioFollowTarget) => void;
  resolveLocation?: (location: MioFollowLocation, pane: Element) => MioFollowPoint | null;
}

const clamp = (n: number, min: number, max: number) => Math.round(Math.max(min, Math.min(n, max)));
const usable = (node: Element | null | undefined): node is Element => Boolean(node?.isConnected && !node.closest('[hidden], [inert]'));
const modeOf = (target: MioFollowTarget) => target.kind === 'shot' || target.kind === 'node' ? 'canvas' : 'editing';
const modeOfLocation = (location: MioFollowLocation) => location.kind === 'canvas' ? 'canvas' : 'editing';
const center = ({left, right, top, bottom}: Box): MioFollowPoint => ({x: (left + right) / 2, y: (top + bottom) / 2});

function cursorArea({left, top, right, bottom}: Box): Box | null {
  const horizontal = right - left - 20, vertical = bottom - top - 21;
  if (horizontal < 0 || vertical < 0) return null;
  const xPadding = Math.min(4, horizontal / 2), yPadding = Math.min(4, vertical / 2);
  return {left: left + xPadding, right: right - 20 - xPadding, top: top + yPadding, bottom: bottom - 21 - yPadding};
}

function anchorFor(rect: Box, bounds: Box, mode: Props['mode'], target?: MioFollowTarget): MioFollowPoint | null {
  const top = Math.max(rect.top, bounds.top), bottom = Math.min(rect.bottom, bounds.bottom);
  if (bottom <= top) return null;
  const y = clamp((top + bottom) / 2 - (mode === 'canvas' ? 30 : 4), top, bottom - 1);
  // Track headers are sticky, so point at their lane inside the visible editor area.
  if (target?.kind === 'timeline_track') return {x: bounds.left + 4, y};
  const left = Math.max(rect.left, bounds.left), right = Math.min(rect.right, bounds.right);
  if (right <= left) return null;
  return {
    x: clamp((left + right) / 2 - (mode === 'canvas' ? 24 : 2), left, right - 1),
    y,
  };
}

type CursorState = { last?: MioFollowPoint; move: ReturnType<typeof createMioCursorMotion> };

function paneBounds(pane: Element, mode: Props['mode'], view: Window): Box | null {
  const paneRect = pane.getBoundingClientRect();
  let { left, top, right, bottom } = paneRect;
  if (mode === 'canvas') {
    const inset = coveredInsets(paneRect, measuredOverlays(pane));
    left += inset.left; right -= inset.right; top += inset.top; bottom -= inset.bottom;
  } else {
    if (pane instanceof HTMLElement && pane.offsetWidth > 0 && pane.offsetHeight > 0 && pane.clientWidth > 0 && pane.clientHeight > 0) {
      const scaleX = paneRect.width / pane.offsetWidth, scaleY = paneRect.height / pane.offsetHeight;
      left += pane.clientLeft * scaleX;
      top += pane.clientTop * scaleY;
      right = Math.min(right, left + pane.clientWidth * scaleX);
      bottom = Math.min(bottom, top + pane.clientHeight * scaleY);
    }
    const label = pane.querySelector('.track-label')?.getBoundingClientRect();
    const ruler = pane.querySelector('.timeline-ruler-row')?.getBoundingClientRect();
    if (label && label.width > 0) left = Math.max(left, label.right);
    if (ruler && ruler.height > 0) top = Math.max(top, ruler.bottom);
  }
  left = Math.max(left, 0); top = Math.max(top, 0);
  right = Math.min(right, view.innerWidth); bottom = Math.min(bottom, view.innerHeight);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function place(node: HTMLElement, x: number, y: number, side: Side) {
  const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  if (node.style.transform !== transform) node.style.transform = transform;
  if (node.dataset.side !== side) node.dataset.side = side;
  if (node.dataset.placed !== 'true') node.dataset.placed = 'true';
}

function placeLocator(node: HTMLButtonElement, bounds: Box, target: Box | undefined) {
  const { left, right, top, bottom } = bounds;
  const edge = target && target.right <= left ? 'left' : target && target.bottom <= top ? 'top'
    : target && target.top >= bottom ? 'bottom' : 'right';
  const { offsetWidth: width, offsetHeight: height } = node;
  if (right - left < width + 2 * LOCATOR_MARGIN || bottom - top < height + 2 * LOCATOR_MARGIN) {
    node.dataset.placed = 'false';
    return;
  }
  const x = edge === 'left' ? left + LOCATOR_MARGIN : edge === 'right' ? right - width - LOCATOR_MARGIN
    : clamp(((target?.left ?? left) + (target?.right ?? right) - width) / 2, left + LOCATOR_MARGIN, right - width - LOCATOR_MARGIN);
  const y = edge === 'top' ? top + LOCATOR_MARGIN : edge === 'bottom' ? bottom - height - LOCATOR_MARGIN
    : clamp(((target?.top ?? top) + (target?.bottom ?? bottom) - height) / 2, top + LOCATOR_MARGIN, bottom - height - LOCATOR_MARGIN);
  place(node, x, y, edge);
}

function placeCursor(node: HTMLDivElement, label: HTMLDivElement, x: number, y: number, bounds: Box) {
  const rightSpace = bounds.right - x - 12, leftSpace = x - bounds.left + 8;
  const side = rightSpace < LABEL_MAX_WIDTH && leftSpace > rightSpace ? 'left' : 'right';
  const room = `${clamp(side === 'left' ? leftSpace : rightSpace, 0, LABEL_MAX_WIDTH)}px`;
  const labelHeight = label.offsetHeight;
  if (label.style.maxWidth !== room) label.style.maxWidth = room;
  const below = y + 21 + labelHeight <= bounds.bottom || y - labelHeight < bounds.top;
  const vertical = below ? 'below' : 'above';
  if (node.dataset.label !== vertical) node.dataset.label = vertical;
  place(node, x, y, side);
}

/** Renders the live step pointer in viewport pixels without rendering React frames. */
export default function MioFollowLayer({ focus, mode, enabled, reduceMotion, onReveal, onLocate, resolveLocation }: Props) {
  const { t } = useI18n(), gradient = useId();
  const cursor = useRef<HTMLDivElement>(null), label = useRef<HTMLDivElement>(null), locator = useRef<HTMLButtonElement>(null);
  const activity = useRef({ held: new Set<number>(), dragging: false, last: -Infinity });
  const reveal = useRef(onReveal);
  const resolve = useRef(resolveLocation);
  const attempt = useRef({ key: '', time: -Infinity, succeeded: false });
  const motion = useRef<{ runId: string; modes: Partial<Record<Props['mode'], CursorState>> } | null>(null);
  const target = focus?.phase === 'idle' ? undefined : focus?.target;
  const location = focus?.phase === 'idle' ? undefined : focus?.location;
  const color = focus ? mioFollowColor(focus.runId) : undefined;
  const targetMode = target && modeOf(target);

  useLayoutEffect(() => { reveal.current = onReveal; }, [onReveal]);
  useLayoutEffect(() => { resolve.current = resolveLocation; }, [resolveLocation]);
  useLayoutEffect(() => {
    const view = document.defaultView;
    if (!view) return;
    const state = activity.current;
    const touch = () => { state.last = view.performance.now(); };
    const down = (event: PointerEvent) => { state.held.add(event.pointerId); touch(); };
    const up = (event: PointerEvent) => { if (state.held.delete(event.pointerId)) touch(); };
    // A release outside the window can leave pointerup undelivered.
    const move = (event: PointerEvent) => { if (event.buttons === 0) up(event); };
    const dragStart = () => { state.dragging = true; touch(); };
    const dragEnd = () => { state.dragging = false; touch(); };
    const blur = () => { state.held.clear(); state.dragging = false; touch(); };
    const inputKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest(EDITABLE)) touch();
    };
    view.addEventListener('pointerdown', down, true);
    view.addEventListener('pointerup', up, true);
    view.addEventListener('pointercancel', up, true);
    view.addEventListener('pointermove', move, { capture: true, passive: true });
    view.addEventListener('dragstart', dragStart, true);
    view.addEventListener('dragend', dragEnd, true);
    view.addEventListener('drop', dragEnd, true);
    view.addEventListener('wheel', touch, { capture: true, passive: true });
    view.addEventListener('input', touch, true);
    view.addEventListener('keydown', inputKey, true);
    view.addEventListener('blur', blur);
    return () => {
      view.removeEventListener('pointerdown', down, true);
      view.removeEventListener('pointerup', up, true);
      view.removeEventListener('pointercancel', up, true);
      view.removeEventListener('pointermove', move, true);
      view.removeEventListener('dragstart', dragStart, true);
      view.removeEventListener('dragend', dragEnd, true);
      view.removeEventListener('drop', dragEnd, true);
      view.removeEventListener('wheel', touch, true);
      view.removeEventListener('input', touch, true);
      view.removeEventListener('keydown', inputKey, true);
      view.removeEventListener('blur', blur);
    };
  }, []);

  useLayoutEffect(() => {
    const view = document.defaultView, pointer = cursor.current, card = label.current, pill = locator.current;
    if (!focus || !view || !pointer || !card || !color) return;
    const key = JSON.stringify([focus.runId, focus.stepId, target?.kind, target?.id]);
    if (attempt.current.key !== key) attempt.current = { key, time: -Infinity, succeeded: false };
    if (motion.current?.runId !== focus.runId) motion.current = { runId: focus.runId, modes: {} };
    const movement = motion.current.modes[mode] ??= { move: createMioCursorMotion() };
    const destination = JSON.stringify([focus.stepId, focus.phase, target?.kind, target?.id, location]);
    const systemMotion = view.matchMedia?.('(prefers-reduced-motion: reduce)');
    let frame: number | null = null, highlight: HTMLElement | undefined;
    let pane: Element | null = null, bounds: Box | null = null, measuredAt = -Infinity;
    let elements: Element[] = [], visible: Element | undefined;
    const setHighlight = (next: Element | undefined) => {
      if (next === highlight) return;
      highlight?.removeAttribute('data-mio-follow-highlight');
      highlight?.style.removeProperty('--mio-follow-color');
      highlight = next instanceof HTMLElement ? next : undefined;
      if (highlight) {
        highlight.setAttribute('data-mio-follow-highlight', mode);
        highlight.style.setProperty('--mio-follow-color', color);
      }
    };
    const hide = (node: HTMLElement | null) => { if (node?.dataset.placed === 'true') node.dataset.placed = 'false'; };
    const invalidate = () => { measuredAt = -Infinity; };
    const visibility = () => {
      if (document.hidden) {
        if (frame !== null) view.cancelAnimationFrame(frame);
        frame = null;
        hide(pointer); hide(pill); setHighlight(undefined);
      } else if (frame === null) {
        invalidate();
        frame = view.requestAnimationFrame(tick);
      }
    };
    const tick = (now: number) => {
      frame = null;
      if (document.hidden) { visibility(); return; }
      frame = view.requestAnimationFrame(tick);
      // React Flow may mount new elements while the viewport moves. Cache
      // selector and visibility checks, but read the current target rect to
      // follow it between measurements.
      if (now - measuredAt >= MEASURE_INTERVAL_MS || pane && !usable(pane) || visible && !usable(visible)) {
        measuredAt = now;
        pane = document.querySelector(mode === 'canvas' ? CANVAS : TIMELINE);
        bounds = usable(pane) ? paneBounds(pane, mode, view) : null;
        elements = target && targetMode === mode ? markTargetElements(target, document) : [];
        visible = elements.find(element => markTargetVisible(element, document));
      }
      if (!bounds || !pane) { hide(pointer); hide(pill); setHighlight(undefined); return; }
      const area = cursorArea(bounds);
      const reduced = Boolean(reduceMotion || systemMotion?.matches);
      const inMode = targetMode === mode;
      const rect = visible?.getBoundingClientRect();
      const prospective = !rect && location && modeOfLocation(location) === mode ? resolve.current?.(location, pane) : undefined;
      const inside = prospective && prospective.x >= bounds.left && prospective.x < bounds.right &&
        prospective.y >= bounds.top && prospective.y < bounds.bottom;
      // Before creation there is no object to reveal. An offscreen projected
      // position still gives the cursor a direction within the visible pane.
      const projected = area && prospective && Number.isFinite(prospective.x) && Number.isFinite(prospective.y) && (!target || inside)
        ? { x: clamp(prospective.x, area.left, area.right), y: clamp(prospective.y, area.top, area.bottom) } : null;
      const aim = rect ? anchorFor(rect, bounds, mode, target) : projected;
      if (aim || !inMode) {
        setHighlight(aim && focus.highlight ? visible : undefined);
        if (area) {
          if (aim) movement.last = aim;
          const point = movement.move(`${destination}:${aim ? 'target' : 'idle'}`, aim ?? movement.last ?? center(area), area,
            now, aim ? (focus.phase === 'approval' ? 0.4 : 0) : 1, reduced);
          placeCursor(pointer, card, point.x, point.y, bounds);
        } else hide(pointer);
        if (pill && target && !inMode) placeLocator(pill, bounds, undefined);
        else hide(pill);
        return;
      }
      hide(pointer); setHighlight(undefined);
      if (!target || !pill) return;
      const busy = activity.current;
      if (enabled && !busy.held.size && !busy.dragging && document.activeElement !== pill && now - busy.last >= MIO_FOLLOW_IDLE_MS &&
        !attempt.current.succeeded && now - attempt.current.time >= REVEAL_RETRY_MS) {
        attempt.current.time = now;
        attempt.current.succeeded = reveal.current(target, reduced ? 'auto' : 'smooth');
        if (attempt.current.succeeded) { hide(pill); return; }
      }
      if (attempt.current.succeeded && now - attempt.current.time < 250) { hide(pill); return; }
      placeLocator(pill, bounds, elements[0]?.getBoundingClientRect());
    };
    document.addEventListener('visibilitychange', visibility);
    view.addEventListener('resize', invalidate);
    visibility();
    return () => {
      if (frame !== null) view.cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', visibility);
      view.removeEventListener('resize', invalidate);
      setHighlight(undefined);
    };
  }, [color, enabled, focus, location, mode, reduceMotion, target, targetMode]);

  if (!focus || typeof document === 'undefined') return null;
  return createPortal(<div className="mio-follow-layer" data-testid="mio-follow-layer" {...{ [MARK_LAYER_ATTRIBUTE]: '' }}
    data-reduced-motion={reduceMotion ? 'true' : undefined} style={{ '--mio-follow-color': color } as CSSProperties}>
    <div ref={cursor} className="mio-follow-cursor" data-testid="mio-follow-cursor" data-placed="false" aria-hidden="true">
      <svg className="mio-follow-pointer" width="20" height="21" viewBox="325 305 432 460" focusable="false">
        <defs><linearGradient id={gradient} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" className="mio-follow-pointer-light" />
          <stop offset="50%" className="mio-follow-pointer-middle" />
          <stop offset="100%" className="mio-follow-pointer-dark" />
        </linearGradient></defs>
        <path d={CURSOR_PATH} fill={`url(#${gradient})`} stroke="white" strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div ref={label} className="mio-follow-cursor-label">
        <span className="mio-follow-bubble" data-testid="mio-follow-bubble">{focus.text}</span>
      </div>
    </div>
    {target && <WorkbenchButton ref={locator} type="button" variant="secondary" className="mio-follow-locator" data-testid="mio-follow-locator" data-placed="false"
      onClick={() => {
        if (targetMode !== mode && onLocate) { onLocate(target); return; }
        const view = document.defaultView;
        if (view && reveal.current(target, revealBehavior(view, reduceMotion))) {
          attempt.current.time = view.performance.now();
          attempt.current.succeeded = true;
        }
      }}>
      <span className="mio-follow-locator-mark"><Icon name="sparkle" size={10} /></span>
      <span>{t('agent.follow.locator', { target: target.name })}</span><Icon name="arrow" size={14} className="mio-follow-locator-arrow" />
    </WorkbenchButton>}
  </div>, document.body);
}

function revealBehavior(view: Window, reduceMotion: boolean): ScrollBehavior {
  return reduceMotion || view.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
