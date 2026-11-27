/** Timeline clip context menu. The speed group precedes the shared split,
 * copy, sound and generate actions when the speed capability is available. */
import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {AudioLines, Check, Copy, Download, Gauge, Rewind, Scissors, Snowflake, Sparkles, Volume2, VolumeX} from '@mioon/ui/components/workbench-icons';
import {useI18n} from './i18n/I18nProvider.tsx';
import type {ClipContextMenuPlan} from './clip-sound-state.ts';

export interface TimelineClipMenuAnchor {readonly clipId: string; readonly x: number; readonly y: number}

export interface TimelineClipSpeedMenu {
  readonly showSpeedActions: boolean;
  readonly reversed: boolean;
  readonly canFreeze: boolean;
  readonly onOpenSpeed: (clipId: string) => unknown;
  readonly onToggleReverse: (clipId: string) => unknown;
  readonly onFreeze: (clipId: string) => unknown;
}

export interface TimelineClipContextMenuProps {
  readonly anchor: TimelineClipMenuAnchor | null;
  readonly plan: ClipContextMenuPlan;
  readonly canSplit: boolean;
  readonly busy: boolean;
  readonly onSplit: (clipId: string) => unknown;
  /** Present only for a main-track format-5 clip (21-11). */
  readonly onCopyAsNewShot?: (clipId: string) => unknown;
  readonly onToggleMute: (clipId: string) => unknown;
  readonly onSeparate: (clipId: string) => unknown;
  readonly onSaveAudio: (clipId: string) => unknown;
  /** Speed menu entries (22-03); absent whenever `capabilities.speed !== true`. */
  readonly speedMenu?: TimelineClipSpeedMenu | null;
  /** GE-b: present only for a main-track format-5 shot clip. */
  readonly onGenerateBefore?: (clipId: string) => unknown;
  readonly onGenerateAfter?: (clipId: string) => unknown;
  readonly onClose: () => void;
}

/** Focusable item list; arrow keys wrap, Escape closes and returns focus to the
 * clip button that opened it. */
export default function TimelineClipContextMenu({anchor, plan, canSplit, busy, onSplit, onCopyAsNewShot, onToggleMute,
  onSeparate, onSaveAudio, speedMenu = null, onGenerateBefore, onGenerateAfter, onClose}: TimelineClipContextMenuProps): React.ReactElement | null {
  const {t} = useI18n();
  const menu = useRef<HTMLDivElement | null>(null);
  const items = useRef<HTMLButtonElement[]>([]);
  const anchorRef = useRef<HTMLElement | null>(null);
  // Open at the pointer, then clamp the rendered box inside the viewport. Both
  // layout effects settle before paint, so the clamped position never flashes.
  const [position, setPosition] = useState<{left: number; top: number} | null>(null);
  useLayoutEffect(() => {
    if (!anchor) {setPosition(null); return;}
    items.current = [];
    anchorRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPosition({left: anchor.x, top: anchor.y});
    const first = menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
    return () => {anchorRef.current?.focus?.();};
  }, [anchor]);
  useLayoutEffect(() => {
    if (!anchor || !position) return;
    const node = menu.current;
    if (!node) return;
    const rect = node.getBoundingClientRect(), margin = 8;
    const left = Math.max(margin, Math.min(position.left, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(position.top, window.innerHeight - rect.height - margin));
    if (left !== position.left || top !== position.top) setPosition({left, top});
  }, [anchor, position]);
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
  // Every item leads with its icon in a fixed-width slot, then a left-aligned
  // label, so the text column lines up across the menu (21-11).
  const item = (index: number, testId: string, label: string, icon: React.ReactNode,
    action: () => unknown, enabled: boolean) =>
    <Button ref={register(index)} type="button" role="menuitem" variant="ghost" className="timeline-clip-menu-item"
      data-testid={testId} disabled={!enabled} onClick={() => {onClose(); void action();}}>
      <span className="timeline-clip-menu-icon" aria-hidden="true">{icon}</span>
      <span className="timeline-clip-menu-label">{label}</span>
    </Button>;
  let index = 0;
  return <div ref={menu} className="timeline-clip-menu" data-testid="clip-context-menu" role="menu"
    aria-label={t('clipSound.clipMenu')} style={position ?? {left: anchor.x, top: anchor.y}}>
    {speedMenu?.showSpeedActions && <>
      <div data-slot="speed-group" data-testid="clip-menu-speed-group" role="group">
        {item(index++, 'clip-menu-speed', t('speed.menu.speed'), <Gauge size={16} />,
          () => speedMenu.onOpenSpeed(anchor.clipId), !busy)}
        {item(index++, 'clip-menu-reverse', t('speed.menu.reverse'),
          speedMenu.reversed ? <Check size={16} /> : <Rewind size={16} />,
          () => speedMenu.onToggleReverse(anchor.clipId), !busy)}
        {item(index++, 'clip-menu-freeze', t('speed.menu.freeze'), <Snowflake size={16} />,
          () => speedMenu.onFreeze(anchor.clipId), speedMenu.canFreeze && !busy)}
      </div>
      <div className="timeline-clip-menu-separator" role="separator" />
    </>}
    {item(index++, 'clip-menu-split', t('clipSound.split'), <Scissors size={16} />,
      () => onSplit(anchor.clipId), canSplit && !busy)}
    {onCopyAsNewShot && item(index++, 'clip-menu-copy-new-shot', t('editUi.menu.copyAsNewShot'), <Copy size={16} />,
      () => onCopyAsNewShot(anchor.clipId), !busy)}
    {plan.sound && <>
      <div className="timeline-clip-menu-separator" role="separator" />
      <div data-slot="sound-group" data-testid="clip-menu-sound-group" role="group">
        {item(index++, 'clip-menu-separate', t('clipSound.separate'), <AudioLines size={16} />,
          () => onSeparate(anchor.clipId), !busy)}
        {item(index++, 'clip-menu-mute', t(plan.muteLabelKey),
          plan.muteLabelKey === 'clipSound.unmute' ? <Volume2 size={16} /> : <VolumeX size={16} />,
          () => onToggleMute(anchor.clipId), !busy)}
        {plan.saveAudio && item(index++, 'clip-menu-save-audio', t('clipSound.saveAsAudio'), <Download size={16} />,
          () => onSaveAudio(anchor.clipId), !busy)}
      </div>
    </>}
    {(onGenerateBefore || onGenerateAfter) && <>
      <div className="timeline-clip-menu-separator" role="separator" />
      <div data-slot="generate-group" data-testid="clip-menu-generate-group" role="group">
        {onGenerateBefore && item(index++, 'clip-menu-generate-before', t('timeline.menu.generateBefore'),
          <Sparkles size={16} />, () => onGenerateBefore(anchor.clipId), !busy)}
        {onGenerateAfter && item(index++, 'clip-menu-generate-after', t('timeline.menu.generateAfter'),
          <Sparkles size={16} />, () => onGenerateAfter(anchor.clipId), !busy)}
      </div>
    </>}
  </div>;
}
