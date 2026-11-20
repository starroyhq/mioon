/** Timeline clip context menu (0.3.0 items only).
 *
 * Order follows the confirmed design: the 0.4.0 speed group is not rendered;
 * `切开` comes first, the sound group (separate sound / mute or unmute / save as
 * audio asset) sits in the middle, and the generate group owned by a later card
 * keeps a structural insert point. No disabled placeholder items are shown.
 */
import React, {useEffect, useLayoutEffect, useRef} from 'react';
import {Button} from '@mioon/ui/components/button';
import {useI18n} from './i18n/I18nProvider.tsx';
import type {ClipContextMenuPlan} from './clip-sound-state.ts';

export interface TimelineClipMenuAnchor {readonly clipId: string; readonly x: number; readonly y: number}

export interface TimelineClipContextMenuProps {
  readonly anchor: TimelineClipMenuAnchor | null;
  readonly plan: ClipContextMenuPlan;
  readonly canSplit: boolean;
  readonly busy: boolean;
  readonly onSplit: (clipId: string) => unknown;
  readonly onToggleMute: (clipId: string) => unknown;
  readonly onSeparate: (clipId: string) => unknown;
  readonly onSaveAudio: (clipId: string) => unknown;
  readonly onClose: () => void;
}

/** Focusable item list; arrow keys wrap, Escape closes and returns focus to the
 * clip button that opened it. */
export default function TimelineClipContextMenu({anchor, plan, canSplit, busy, onSplit, onToggleMute,
  onSeparate, onSaveAudio, onClose}: TimelineClipContextMenuProps): React.ReactElement | null {
  const {t} = useI18n();
  const menu = useRef<HTMLDivElement | null>(null);
  const items = useRef<HTMLButtonElement[]>([]);
  const anchorRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    items.current = [];
    anchorRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
    return () => {anchorRef.current?.focus?.();};
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    const close = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      onClose();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {event.preventDefault(); onClose(); return;}
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const focusable = items.current.filter(item => !item.disabled);
      if (!focusable.length) return;
      const index = focusable.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? focusable.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % focusable.length
          : (index - 1 + focusable.length) % focusable.length;
      focusable[next]?.focus();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key, true);
    return () => {window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', key, true);};
  }, [anchor, onClose]);
  if (!anchor) return null;
  const register = (index: number) => (element: HTMLButtonElement | null) => {if (element) items.current[index] = element;};
  const item = (testId: string, label: string, action: () => unknown, enabled: boolean, index: number) =>
    <Button ref={register(index)} type="button" role="menuitem" variant="ghost" className="timeline-clip-menu-item"
      data-testid={testId} disabled={!enabled} onClick={() => {onClose(); void action();}}>{label}</Button>;
  let index = 0;
  return <div ref={menu} className="timeline-clip-menu" data-testid="clip-context-menu" role="menu"
    aria-label={t('clipSound.clipMenu')} style={{left: anchor.x, top: anchor.y}}>
    {item('clip-menu-split', t('clipSound.split'), () => onSplit(anchor.clipId), canSplit && !busy, index++)}
    {plan.sound && <>
      <div className="timeline-clip-menu-separator" role="separator" />
      <div data-slot="sound-group" data-testid="clip-menu-sound-group" role="group">
        {item('clip-menu-separate', t('clipSound.separate'), () => onSeparate(anchor.clipId), !busy, index++)}
        {item('clip-menu-mute', t(plan.muteLabelKey), () => onToggleMute(anchor.clipId), !busy, index++)}
        {plan.saveAudio && item('clip-menu-save-audio', t('clipSound.saveAsAudio'), () => onSaveAudio(anchor.clipId), !busy, index++)}
      </div>
      <div className="timeline-clip-menu-separator" role="separator" />
    </>}
    {/* GE-b inserts «在前面 / 在后面生成镜头» here; this card renders no item. */}
    <div data-slot="generate-group" hidden aria-hidden="true" />
  </div>;
}
