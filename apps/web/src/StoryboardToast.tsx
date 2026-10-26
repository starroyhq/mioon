import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { X } from '@mioon/ui/components/workbench-icons';
import { useI18n } from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import './scene-storyboard.css';

const lifetime = 15_000;
/** 已建 N 个镜头 · 撤销 (09-08b). It floats above the canvas storyboard strip and
 * closes by itself; the inspector keeps the undo afterwards. */
export default function StoryboardToast({ count, canView, undoDisabled, placement, onView, onUndo, onClose }: {
  count: number; canView: boolean; undoDisabled: boolean;
  /** Changes when the strip below may have appeared or gone, e.g. the workspace mode. */
  placement: string;
  onView: () => void; onUndo: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const element = useRef<HTMLDivElement | null>(null), [bottom, setBottom] = useState<number | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => { const timer = setTimeout(() => close.current(), lifetime); return () => clearTimeout(timer); }, []);
  // Sit just above the storyboard strip, whose height changes as it opens and closes.
  useLayoutEffect(() => {
    const area = element.current?.parentElement, strip = area?.querySelector('.board-storyboard');
    if (!area || !strip) { setBottom(null); return; }
    const place = (): void => { const box = area.getBoundingClientRect(), top = strip.getBoundingClientRect().top; setBottom(Math.max(0, Math.round(box.bottom - top + 8))); };
    place();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(place);
    observer.observe(strip); observer.observe(area);
    return () => observer.disconnect();
  }, [placement]);
  const shortcut = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘Z' : 'Ctrl+Z';
  return <div ref={element} className="storyboard-toast" role="status" data-testid="storyboard-toast" style={bottom === null ? undefined : { bottom }}>
    <Icon name="check" size={15} /><span>{t('scene.toast.built', { count })}</span>
    {canView && <WorkbenchButton variant="ghost" size="compact" data-testid="storyboard-toast-view" onClick={onView}>{t('scene.toast.view')}</WorkbenchButton>}
    <i aria-hidden="true" />
    <WorkbenchButton variant="ghost" size="compact" data-testid="storyboard-toast-undo" disabled={undoDisabled} aria-keyshortcuts={shortcut === '⌘Z' ? 'Meta+Z' : 'Control+Z'} onClick={onUndo}>
      <Icon name="undo" size={13} />{t('scene.toast.undo')}<kbd>{shortcut}</kbd></WorkbenchButton>
    <WorkbenchButton variant="icon" size="compact" data-testid="storyboard-toast-close" aria-label={t('scene.notice.dismiss')} onClick={onClose}><X size={14} /></WorkbenchButton>
  </div>;
}
