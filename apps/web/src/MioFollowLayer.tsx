import React, { useId, useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { coveredInsets, measuredOverlays } from './canvas-fit.ts';
import type { Box, Side } from './canvas-fit.ts';
import Icon from './icons.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import { mioFollowColor } from './mio-follow.ts';
import type { MioFollowFocus, MioFollowTarget } from './mio-follow.ts';
import { MARK_LAYER_ATTRIBUTE, markTargetElements, markTargetVisible } from './target-marks.ts';
import './mio-follow-layer.css';

const MIO_FOLLOW_IDLE_MS = 2000;
const REVEAL_RETRY_MS = 160;
const LOCATOR_MARGIN = 12;
const LABEL_MAX_WIDTH = 240;
const PANEL = '[data-testid="agent-task-panel"]';
const CANVAS = '[data-testid="canvas-drop-zone"] .react-flow';
const TIMELINE = '[data-testid="timeline-scroll"]';
// The rounded #cursor outline is from Cua Driver's app-icon.svg (MIT).
const CURSOR_PATH = 'M411.5 326 C373 315 340 342.5 345.5 386.5 C345.5 386.5 461 700 461 700 C477.5 744 510.5 744 532.5 705.5 C532.5 705.5 582 595.5 582 595.5 C593 573.5 609.5 557 631.5 546 C631.5 546 703 507.5 703 507.5 C741.5 485.5 736 452.5 697.5 436 C697.5 436 411.5 326 411.5 326 Z';

interface Props {
  focus: MioFollowFocus | null;
  mode: 'canvas' | 'editing';
  enabled: boolean;
  reduceMotion: boolean;
  onReveal: (target: MioFollowTarget, behavior: ScrollBehavior) => boolean;
}

const clamp = (n: number, min: number, max: number) => Math.round(Math.max(min, Math.min(n, max)));
const usable = (node: Element | null | undefined) => node?.isConnected && !node.closest('[hidden], [inert]');

function paneBounds(pane: Element, mode: Props['mode'], view: Window): Box | null {
  const paneRect = pane.getBoundingClientRect();
  let { left, top, right, bottom } = paneRect;
  if (mode === 'canvas') {
    const inset = coveredInsets(paneRect, measuredOverlays(pane));
    left += inset.left; right -= inset.right; top += inset.top; bottom -= inset.bottom;
  } else {
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

function placeCursor(node: HTMLDivElement, label: HTMLDivElement, x: number, y: number, bounds: Box, towardPanel = false) {
  const rightSpace = bounds.right - x - 12, leftSpace = x - bounds.left + 8;
  const side = towardPanel || (rightSpace < LABEL_MAX_WIDTH && leftSpace > rightSpace) ? 'left' : 'right';
  const room = `${clamp(side === 'left' ? leftSpace : rightSpace, 0, LABEL_MAX_WIDTH)}px`;
  if (label.style.maxWidth !== room) label.style.maxWidth = room;
  const below = y + 21 + label.offsetHeight <= bounds.bottom || y - label.offsetHeight < bounds.top;
  const vertical = below ? 'below' : 'above';
  if (node.dataset.label !== vertical) node.dataset.label = vertical;
  place(node, x, y, side);
}

/** Renders one pointer for the latest durable step and measures it in viewport pixels. */
export default function MioFollowLayer({ focus, mode, enabled, reduceMotion, onReveal }: Props) {
  const { t } = useI18n(), gradient = useId();
  const cursor = useRef<HTMLDivElement>(null), label = useRef<HTMLDivElement>(null), locator = useRef<HTMLButtonElement>(null);
  const activity = useRef({ held: new Set<number>(), dragging: false, last: -Infinity });
  const reveal = useRef(onReveal);
  const attempt = useRef({ key: '', time: -Infinity, succeeded: false });
  const target = focus?.target;
  const color = focus ? mioFollowColor(focus.runId) : undefined;
  const targetMode = target && (target.kind === 'shot' || target.kind === 'node' ? 'canvas' : 'editing');
  const active = Boolean(focus && (!targetMode || targetMode === mode));

  useLayoutEffect(() => { reveal.current = onReveal; }, [onReveal]);
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
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) touch();
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
    if (!active || !focus || !view || !pointer || !card || !color) return;
    const key = JSON.stringify([focus.runId, focus.stepId, target?.kind, target?.id]);
    if (attempt.current.key !== key) attempt.current = { key, time: -Infinity, succeeded: false };
    let frame = 0, highlight: HTMLElement | undefined;
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
    const tick = () => {
      frame = view.requestAnimationFrame(tick);
      if (document.hidden) {
        hide(pointer); hide(pill); setHighlight(undefined);
        return;
      }
      if (!target) {
        const panel = document.querySelector(PANEL);
        if (!panel || !usable(panel)) { hide(pointer); return; }
        const panelRect = panel.getBoundingClientRect();
        const row = [...panel.querySelectorAll('[data-step-id]')].find(node => node.getAttribute('data-step-id') === focus.stepId);
        const rowRect = row?.getBoundingClientRect();
        if (panelRect.width <= 0 || panelRect.height <= 0) { hide(pointer); return; }
        const y = clamp((rowRect && rowRect.height > 0 ? rowRect.top + 8 : panelRect.top + panelRect.height / 2),
          panelRect.top + LOCATOR_MARGIN, panelRect.bottom - 21 - LOCATOR_MARGIN);
        placeCursor(pointer, card, panelRect.left - 18, y,
          { left: LOCATOR_MARGIN, right: panelRect.left, top: panelRect.top, bottom: panelRect.bottom }, true);
        return;
      }
      const pane = document.querySelector(mode === 'canvas' ? CANVAS : TIMELINE);
      const bounds = pane && usable(pane) ? paneBounds(pane, mode, view) : null;
      if (!bounds || !pill) { hide(pointer); hide(pill); setHighlight(undefined); return; }
      const elements = markTargetElements(target, document);
      const visible = elements.find(element => markTargetVisible(element, document));
      if (visible) {
        const rect = visible.getBoundingClientRect();
        const left = Math.max(rect.left, bounds.left), right = Math.min(rect.right, bounds.right);
        const top = Math.max(rect.top, bounds.top), bottom = Math.min(rect.bottom, bounds.bottom);
        if (right > left && bottom > top) {
          hide(pill);
          setHighlight(visible);
          placeCursor(pointer, card, clamp((left + right) / 2 - (mode === 'canvas' ? 24 : 2), left, right - 1),
            clamp((top + bottom) / 2 - (mode === 'canvas' ? 30 : 4), top, bottom - 1), bounds);
          return;
        }
      }
      hide(pointer); setHighlight(undefined);
      const now = view.performance.now(), busy = activity.current;
      if (enabled && !busy.held.size && !busy.dragging && document.activeElement !== pill && now - busy.last >= MIO_FOLLOW_IDLE_MS &&
        !attempt.current.succeeded && now - attempt.current.time >= REVEAL_RETRY_MS) {
        attempt.current.time = now;
        attempt.current.succeeded = reveal.current(target, revealBehavior(view, reduceMotion));
        if (attempt.current.succeeded) { hide(pill); return; }
      }
      if (attempt.current.succeeded && now - attempt.current.time < 250) { hide(pill); return; }
      placeLocator(pill, bounds, elements[0]?.getBoundingClientRect());
    };
    frame = view.requestAnimationFrame(tick);
    return () => {
      view.cancelAnimationFrame(frame);
      setHighlight(undefined);
      hide(pointer); hide(pill);
    };
  }, [active, color, enabled, focus, mode, reduceMotion, target]);

  if (!focus || !active || typeof document === 'undefined') return null;
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
        <span className="mio-follow-name"><Icon name="sparkle" size={11} />{t('agent.task.title')}</span>
        <span className="mio-follow-bubble" data-testid="mio-follow-bubble">{focus.text}</span>
      </div>
    </div>
    {target && <WorkbenchButton ref={locator} type="button" variant="secondary" className="mio-follow-locator" data-testid="mio-follow-locator" data-placed="false"
      onClick={() => {
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
