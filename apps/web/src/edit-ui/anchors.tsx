import React, {useLayoutEffect, useRef, useState} from 'react';
import './edit-ui.css';
import Icon from '../icons.tsx';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {editUiAnchorEntries} from './projection.ts';
import type {EditUiProjection} from './projection.ts';

export interface EditUiAnchorMeasurement {
  readonly id: string;
  readonly kind: 'clip' | 'cue';
  readonly targetClipId: string;
  readonly startFrame: number;
  /** Content-relative source rectangle and main-track segment top. */
  readonly source: {readonly left: number; readonly bottom: number};
  readonly targetTop: number;
}

export interface EditUiAnchorLine {
  readonly id: string;
  readonly kind: 'clip' | 'cue';
  readonly targetClipId: string;
  readonly startFrame: number;
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
}

const SOURCE_GAP_PX = 2;
const DOT_OFFSET_PX = 8;

/** Turns content-relative measurements into drawable links. Nothing here depends
 * on scroll: both rectangles share the scrolling content box, so scrolling moves
 * the link with its clips. The x follows `startFrame × pixelsPerFrame` because it
 * is read from the positioned source element. */
export function editUiAnchorGeometry(measurements: readonly EditUiAnchorMeasurement[]): readonly EditUiAnchorLine[] {
  return measurements.map(item => ({id: item.id, kind: item.kind, targetClipId: item.targetClipId, startFrame: item.startFrame,
    x: item.source.left, top: item.source.bottom + SOURCE_GAP_PX, bottom: item.targetTop + DOT_OFFSET_PX}))
    .filter(line => line.bottom > line.top);
}

interface LayerState {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly EditUiAnchorLine[];
}

/** SVG overlay inside `.timeline-content`: one vertical line per attached anchor
 * and a dot on the main-track segment it points at. Layout is measured because
 * track heights are CSS driven (normal/compact/resized). */
export function EditUiAnchorLayer({projection, timelineRevision, pixelsPerFrame}: {
  readonly projection: EditUiProjection;
  readonly timelineRevision: number;
  readonly pixelsPerFrame: number;
}): React.ReactElement {
  const host = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<LayerState>({width: 0, height: 0, lines: []});
  const entries = editUiAnchorEntries(projection);
  useLayoutEffect(() => {
    const element = host.current;
    const content = element?.parentElement;
    if (!element || !content) return;
    let disposed = false;
    let pending = 0;
    const measure = (): void => {
      if (disposed) return;
      pending = 0;
      const contentRect = content.getBoundingClientRect();
      const measurements: EditUiAnchorMeasurement[] = [];
      for (const entry of entries) {
        const source = content.querySelector<HTMLElement>(
          `[data-testid="${entry.kind === 'cue' ? `subtitle-cue-${entry.id}` : `timeline-clip-${entry.id}`}"]`);
        const target = content.querySelector<HTMLElement>(`[data-testid="timeline-clip-${entry.targetClipId}"]`);
        if (!source || !target) continue;
        const sourceRect = source.getBoundingClientRect(), targetRect = target.getBoundingClientRect();
        measurements.push({id: entry.id, kind: entry.kind, targetClipId: entry.targetClipId, startFrame: entry.startFrame,
          source: {left: sourceRect.left - contentRect.left, bottom: sourceRect.bottom - contentRect.top},
          targetTop: targetRect.top - contentRect.top});
      }
      const lines = editUiAnchorGeometry(measurements);
      setState(current => current.width === content.scrollWidth && current.height === content.scrollHeight
        && current.lines.length === lines.length
        && current.lines.every((line, index) => line.x === lines[index]?.x && line.top === lines[index]?.top && line.bottom === lines[index]?.bottom)
        ? current : {width: content.scrollWidth, height: content.scrollHeight, lines});
    };
    const schedule = (): void => { if (!pending && !disposed) pending = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    measure();
    return () => {disposed = true; observer.disconnect(); if (pending) cancelAnimationFrame(pending);};
  }, [projection, timelineRevision, pixelsPerFrame, entries.length]);
  const ids = entries.map(entry => `${entry.kind}:${entry.id}:${entry.targetClipId}:${entry.startFrame}`).join(',');
  return <div ref={host} className="edit-ui-anchor-layer" data-testid="edit-ui-anchor-layer" data-anchor-count={entries.length}
    data-anchor-ids={ids} aria-hidden="true">
    {state.lines.length > 0 && <svg className="edit-ui-anchor-svg" width={state.width} height={state.height} aria-hidden="true">
      {state.lines.map(line => <g key={`${line.kind}:${line.id}`} className="edit-ui-anchor-link" data-anchor-id={line.id} data-anchor-kind={line.kind}
        data-anchor-start-frame={line.startFrame} data-anchor-target={line.targetClipId}>
        <line className="edit-ui-anchor-line" x1={line.x} y1={line.top} x2={line.x} y2={line.bottom} />
        <circle className="edit-ui-anchor-dot" cx={line.x} cy={line.bottom} r={3} />
      </g>)}
    </svg>}
  </div>;
}

/** The amber "未挂靠" chip shown where a detached subtitle/overlay starts. */
export function EditUiDetachedAnchor({left, testId}: {readonly left: number; readonly testId: string}): React.ReactElement {
  const {t} = useI18n();
  return <span className="edit-ui-detached-anchor" data-testid={testId} style={{left}}>
    <Icon name="info" size={11} /><span>{t('editUi.anchor.detached')}</span>
  </span>;
}
