import React, { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { WorkbenchButton as Button } from '@mioon/ui/components/workbench-controls';
import { WorkbenchTooltip } from '@mioon/ui/components/workbench-tooltip';
import Icon from './icons.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import { MARK_LAYER_ATTRIBUTE } from './target-marks.ts';
import type { MarkSize, TargetMarks } from './target-marks.ts';
import './target-marks.css';

export interface TargetMarkLayerProps {
  marks: TargetMarks;
  /** Visible label text; "Mio 修改" when omitted. Later callers pass their own, for example C6's "待核对". */
  label?: string;
  /** Accessible name; it should start with the visible label. */
  ariaLabel?: string;
  /** The label's icon; the Mio sparkle when omitted. */
  icon?: string;
  /** What one owner's label stands for, shown as its tooltip and appended to its accessible name. */
  describe?: (owner: string) => string | undefined;
  onActivate: (owner: string) => unknown;
}

/**
 * Floating labels for marked canvas and timeline targets. While any mark is active it follows scrolling,
 * panning and zooming once per frame; a label never takes focus when it appears.
 */
export default function TargetMarkLayer({ marks, label, ariaLabel, icon = 'sparkle', describe, onActivate }: TargetMarkLayerProps): ReactElement | null {
  const { t } = useI18n(), text = label ?? t('agent.mark.label'), name = ariaLabel ?? (label === undefined ? t('agent.mark.open') : text);
  const list = useSyncExternalStore(marks.subscribe, marks.list, marks.list);
  const labels = useRef(new Map<string, HTMLButtonElement>());
  const active = list.length > 0;
  useLayoutEffect(() => {
    if (!active) return;
    let frame = 0;
    const measure = (key: string): MarkSize | null => { const node = labels.current.get(key); return node ? { width: node.offsetWidth, height: node.offsetHeight } : null; };
    const tick = () => {
      for (const placement of marks.sync(measure)) {
        const node = labels.current.get(placement.key);
        if (!node) continue;
        node.style.transform = `translate(${Math.round(placement.x)}px, ${Math.round(placement.y)}px)`;
        node.dataset.placed = placement.visible ? 'true' : 'false';
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [marks, active]);
  const shown = list.filter(mark => mark.label);
  if (!shown.length || typeof document === 'undefined') return null;
  return createPortal(<div className="mio-mark-layer" {...{ [MARK_LAYER_ATTRIBUTE]: '' }}>
    {shown.map(mark => {
      const description = describe?.(mark.owner);
      const button = <Button key={mark.key} type="button" variant="primary" size="compact" className="mio-mark" data-testid="mio-mark" data-mark-key={mark.key} data-phase={mark.phase} data-placed="false" aria-label={description ? `${name} · ${description}` : name}
        ref={node => { if (node) labels.current.set(mark.key, node); else labels.current.delete(mark.key); }}
        onClick={() => onActivate(mark.owner)}
        onPointerEnter={() => marks.hold(mark.key, true)} onPointerLeave={() => marks.hold(mark.key, false)}
        onFocus={() => marks.hold(mark.key, true)} onBlur={() => marks.hold(mark.key, false)}>
        <Icon name={icon} size={11} /><span>{text}</span>
      </Button>;
      return description ? <WorkbenchTooltip key={mark.key} content={description}>{button}</WorkbenchTooltip> : button;
    })}
  </div>, document.body);
}
