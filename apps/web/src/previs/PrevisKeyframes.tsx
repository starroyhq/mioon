import React, { useLayoutEffect, useRef, useState } from 'react';
import type { PrevisCamera, PrevisKeyframe, PrevisScene } from '@mioon/contracts';
import { PREVIS_LIMITS } from '@mioon/contracts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@mioon/ui/components/dropdown-menu';
import { Box, Check, Diamond, Focus, ImageDown, Link, MoreHorizontal, PencilLine, Play, Plus, Square, Trash2 } from '@mioon/ui/components/workbench-icons';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { PREVIS_FOCAL_PRESETS } from './previs-camera.ts';
import { isPrevisKeyframeCurrent, previsKeyframeLabel, previsKeyframeName } from './previs-keyframes.ts';
import type { PrevisTranslate } from './previs-keyframes.ts';
import { PREVIS_FRAME_ISSUE_KEYS, previsKeyframeSupplies, previsShotNumber } from './previs-output.ts';
import type { PrevisFrameRefusal, PrevisFrameRole, PrevisFrameUse, PrevisShotView } from './previs-output.ts';

// The keyframe strip under the 3D view (09-12): recorded cameras in order,
// with the current camera's focal presets in its heading. A card jumps the
// camera to its keyframe; its menu exports the picture or sets it as a shot's
// first or last frame. Cards drag to reorder (or Alt+←/→ when focused).
export interface PrevisKeyframesProps {
  scene: PrevisScene;
  thumbnails: Readonly<Record<string, string>>;
  uses: ReadonlyMap<string, readonly PrevisFrameUse[]>;
  connected: readonly PrevisShotView[];
  others: readonly PrevisShotView[];
  readOnly: boolean;
  /** Why nothing can be exported now (no 3D view, a restored copy), or null. */
  exportIssue: string | null;
  busy: boolean;
  frameIssue: (shot: PrevisShotView, role: PrevisFrameRole) => PrevisFrameRefusal | null;
  onRecord: () => void;
  onJump: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, index: number) => void;
  onRemove: (id: string) => void;
  onExport: (id: string) => void;
  onSetFrame: (id: string, shot: PrevisShotView, role: PrevisFrameRole) => void;
  camera: PrevisCamera;
  onFocal: (focalLength: number) => void;
  /** Width over height of the output frame, for the card thumbnails. */
  aspect: number;
  /** Playback previews the camera moving through the keyframes in order (C8 v2). */
  playing?: boolean;
  /** Why playback cannot start now (fewer than two keyframes, no 3D view), or null. */
  playIssue?: string | null;
  onPlay?: () => void;
}
const DRAG_TYPE = 'application/x-mioon-previs-keyframe';
export default function PrevisKeyframes(props: PrevisKeyframesProps): React.ReactElement {
  const { t } = useI18n(), translate = t as unknown as PrevisTranslate;
  const { scene, readOnly, camera } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null), [drop, setDrop] = useState<{ id: string; side: 'before' | 'after' } | null>(null);
  const full = scene.keyframes.length >= PREVIS_LIMITS.keyframes;
  // A newly recorded keyframe scrolls into view at the end of the strip.
  const list = useRef<HTMLDivElement | null>(null), count = useRef(scene.keyframes.length);
  useLayoutEffect(() => {
    const added = scene.keyframes.length > count.current;
    count.current = scene.keyframes.length;
    if (!added || !list.current) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.current.scrollTo({ left: list.current.scrollWidth, behavior: reduce ? 'auto' : 'smooth' });
  }, [scene.keyframes.length]);
  const finishDrag = (): void => { setDragging(null); setDrop(null); };
  const dropAt = (targetId: string, side: 'before' | 'after', movedId: string): void => {
    const from = scene.keyframes.findIndex(item => item.id === movedId), target = scene.keyframes.findIndex(item => item.id === targetId);
    if (from < 0 || target < 0 || movedId === targetId) return;
    const index = side === 'before' ? (from < target ? target - 1 : target) : (from < target ? target : target + 1);
    props.onMove(movedId, index);
  };
  return <section className="previs-keyframes" aria-label={t('previs.keyframes.title')} data-testid="previs-keyframes" style={{ '--previs-frame-aspect': String(props.aspect) } as React.CSSProperties}>
    <header className="previs-keyframes-heading">
      <Diamond size={13} aria-hidden="true" /><strong>{t('previs.keyframes.title')}</strong><small>{scene.keyframes.length}</small>
      {props.onPlay && <button type="button" className="previs-play" data-previs-play="" data-testid="previs-keyframes-play" aria-pressed={Boolean(props.playing)}
        disabled={!props.playing && Boolean(props.playIssue)} title={!props.playing && props.playIssue ? props.playIssue : t('previs.keyframes.playHint')} onClick={props.onPlay}>
        {props.playing ? <Square size={11} aria-hidden="true" /> : <Play size={11} aria-hidden="true" />}{t(props.playing ? 'previs.keyframes.stop' : 'previs.keyframes.play')}</button>}
      {scene.keyframes.length > 1 && !readOnly && <span className="previs-keyframes-hint">{t('previs.keyframes.hint')}</span>}
      <span className="previs-topbar-spacer" />
      <span className="previs-focal-title"><Focus size={13} aria-hidden="true" />{t('previs.focal.title')}</span><small className="previs-focal-note">{t('previs.focal.current')}</small>
      <div className="previs-segments" role="group" aria-label={t('previs.focal.title')} data-testid="previs-focal">
        {PREVIS_FOCAL_PRESETS.map(value => <button type="button" key={value} className="previs-segment" aria-pressed={Math.abs(camera.focalLength - value) < 0.5} aria-label={t('previs.focal.preset', { focal: value })} data-testid={`previs-focal-${value}`} onClick={() => props.onFocal(value)}>{value}</button>)}
      </div>
      <small className="previs-focal-unit">{t('previs.unit.millimetre')}</small>
      {!PREVIS_FOCAL_PRESETS.some(value => Math.abs(camera.focalLength - value) < 0.5) && <output className="previs-focal-value">{Math.round(camera.focalLength)}</output>}
    </header>
    {/* The strip scrolls sideways (a vertical wheel scrolls it too); the record button stays at its right edge. */}
    <div className="previs-keyframe-list" data-testid="previs-keyframe-list" ref={list}
      onWheel={event => { const element = event.currentTarget; if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && element.scrollWidth > element.clientWidth) element.scrollLeft += event.deltaY; }}>
      {scene.keyframes.length === 0 && <p className="previs-keyframes-empty">{t('previs.keyframes.empty')}</p>}
      {scene.keyframes.length > 0 && <div className="previs-keyframe-cards" role="list">{scene.keyframes.map((keyframe, index) => <KeyframeCard key={keyframe.id} {...props} keyframe={keyframe} index={index} translate={translate}
        current={isPrevisKeyframeCurrent(scene, keyframe.id)} renaming={renaming === keyframe.id} onRenaming={value => setRenaming(value ? keyframe.id : null)}
        dragging={dragging === keyframe.id} drop={drop?.id === keyframe.id ? drop.side : null}
        onDragStart={event => { if (readOnly) return; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(DRAG_TYPE, keyframe.id); setDragging(keyframe.id); }}
        onDragOver={event => {
          if (!dragging || dragging === keyframe.id) return;
          event.preventDefault(); event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect(), side = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
          if (drop?.id !== keyframe.id || drop.side !== side) setDrop({ id: keyframe.id, side });
        }}
        onDrop={event => { event.preventDefault(); const moved = event.dataTransfer.getData(DRAG_TYPE) || dragging; if (moved && drop) dropAt(keyframe.id, drop.side, moved); finishDrag(); }}
        onDragEnd={finishDrag} />)}</div>}
      <button type="button" className="previs-keyframe-add" data-testid="previs-keyframe-record" disabled={readOnly || full} title={full ? t('previs.keyframes.limit', { limit: PREVIS_LIMITS.keyframes }) : t('previs.keyframes.recordHint')} onClick={props.onRecord}>
        <span className="previs-keyframe-add-icon"><Plus size={16} aria-hidden="true" /></span>{t('previs.keyframes.record')}<kbd>{t('previs.key.record')}</kbd>
      </button>
    </div>
  </section>;
}
interface CardProps extends PrevisKeyframesProps {
  keyframe: PrevisKeyframe;
  index: number;
  translate: PrevisTranslate;
  current: boolean;
  renaming: boolean;
  onRenaming: (value: boolean) => void;
  dragging: boolean;
  drop: 'before' | 'after' | null;
  onDragStart: React.DragEventHandler<HTMLDivElement>;
  onDragOver: React.DragEventHandler<HTMLDivElement>;
  onDrop: React.DragEventHandler<HTMLDivElement>;
  onDragEnd: React.DragEventHandler<HTMLDivElement>;
}
function KeyframeCard(props: CardProps): React.ReactElement {
  const { t } = useI18n();
  const { keyframe, index, translate, scene, readOnly, busy } = props;
  const label = previsKeyframeLabel(index), name = previsKeyframeName(keyframe, translate), focal = Math.round(keyframe.camera.focalLength);
  const uses = props.uses.get(keyframe.id) ?? [], url = props.thumbnails[keyframe.id];
  const [menu, setMenu] = useState(false), [draft, setDraft] = useState(keyframe.name), input = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => { if (props.renaming) { setDraft(keyframe.name); input.current?.focus(); input.current?.select(); } }, [props.renaming]);
  const commit = (): void => { props.onRenaming(false); if (draft !== keyframe.name) props.onRename(keyframe.id, draft); };
  const exportDisabled = readOnly || busy || Boolean(props.exportIssue);
  const frameItem = (shot: PrevisShotView, role: PrevisFrameRole, text: string): React.ReactElement => {
    const issue = props.frameIssue(shot, role), supplied = previsKeyframeSupplies(scene, keyframe.id, shot, role);
    const reason = props.exportIssue ?? (issue ? t(PREVIS_FRAME_ISSUE_KEYS[issue] as never) : null);
    return <DropdownMenuItem key={`${shot.id}:${role}`} className="previs-menu-item" data-testid={`previs-keyframe-${role}-${shot.id}`} disabled={exportDisabled || Boolean(issue)} onClick={() => props.onSetFrame(keyframe.id, shot, role)}>
      <Link size={14} aria-hidden="true" /><span className="previs-menu-copy">{text}{reason && <small>{reason}</small>}</span>{supplied && <Check size={14} className="previs-menu-check" aria-hidden="true" />}
    </DropdownMenuItem>;
  };
  const shotLine = (shot: PrevisShotView): string => shot.title ? t('previs.shot.label', { number: previsShotNumber(shot), title: shot.title }) : t('previs.shot.untitled', { number: previsShotNumber(shot) });
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (readOnly || props.renaming) return;
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); event.stopPropagation(); props.onMove(keyframe.id, index + (event.key === 'ArrowLeft' ? -1 : 1)); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); props.onRemove(keyframe.id); return; }
    if (event.key === 'F2') { event.preventDefault(); event.stopPropagation(); props.onRenaming(true); }
  };
  return <div role="listitem" className="previs-keyframe" data-testid={`previs-keyframe-${keyframe.id}`} data-current={props.current || undefined} data-dragging={props.dragging || undefined} data-drop={props.drop ?? undefined}
    draggable={!readOnly && !props.renaming} onDragStart={props.onDragStart} onDragOver={props.onDragOver} onDrop={props.onDrop} onDragEnd={props.onDragEnd}
    onContextMenu={event => { event.preventDefault(); setMenu(true); }}>
    <button type="button" className="previs-keyframe-select" aria-pressed={props.current} aria-label={t('previs.keyframe.select', { label, name })} data-testid={`previs-keyframe-jump-${keyframe.id}`}
      onClick={() => props.onJump(keyframe.id)} onDoubleClick={() => { if (!readOnly) props.onRenaming(true); }} onKeyDown={onKeyDown}>
      <span className="previs-keyframe-thumb">{url ? <img src={url} alt="" draggable={false} /> : <Box size={16} aria-hidden="true" />}</span>
      <span className="previs-keyframe-text"><strong><span className="previs-keyframe-label">{label}</span>{!props.renaming && <span className="previs-keyframe-name">{name}</span>}</strong><small>{t('previs.keyframe.focal', { focal })}</small>
        {uses.length > 0 && <span className="previs-keyframe-badge" data-testid={`previs-keyframe-use-${keyframe.id}`}><Link size={10} aria-hidden="true" />
          <span>{t(uses[0]!.role === 'first' ? 'previs.keyframe.useFirst' : 'previs.keyframe.useLast', { number: previsShotNumber(uses[0]!.shot) })}</span>{uses.length > 1 && <span>{t('previs.keyframe.useMore', { count: uses.length - 1 })}</span>}</span>}</span>
    </button>
    {props.renaming && <input ref={input} className="previs-text previs-keyframe-rename" aria-label={t('previs.keyframe.renameLabel')} data-testid={`previs-keyframe-rename-${keyframe.id}`} value={draft} maxLength={PREVIS_LIMITS.nameLength}
      placeholder={previsKeyframeName({ ...keyframe, name: '' }, translate)} onChange={event => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') event.currentTarget.blur(); else if (event.key === 'Escape') { setDraft(keyframe.name); props.onRenaming(false); } }} />}
    <DropdownMenu open={menu} onOpenChange={setMenu}>
      <DropdownMenuTrigger render={<button type="button" className="previs-keyframe-more" aria-label={t('previs.keyframe.actions', { label })} data-testid={`previs-keyframe-menu-${keyframe.id}`} />}><MoreHorizontal size={14} aria-hidden="true" /></DropdownMenuTrigger>
      <DropdownMenuContent className="previs-keyframe-menu" align="start" side="top" sideOffset={6}>
        <DropdownMenuGroup><DropdownMenuLabel>{t('previs.keyframe.menuTitle', { label, name, focal })}</DropdownMenuLabel></DropdownMenuGroup>
        <DropdownMenuItem className="previs-menu-item" data-testid={`previs-keyframe-export-${keyframe.id}`} disabled={exportDisabled} onClick={() => props.onExport(keyframe.id)}>
          <ImageDown size={14} aria-hidden="true" /><span className="previs-menu-copy">{t('previs.keyframe.export')}{props.exportIssue && <small>{props.exportIssue}</small>}</span><span className="previs-menu-hint">{t('previs.keyframe.exportFormat')}</span>
        </DropdownMenuItem>
        {props.connected.map(shot => <React.Fragment key={shot.id}>
          {frameItem(shot, 'first', t('previs.keyframe.setFirst', { number: previsShotNumber(shot) }))}
          {frameItem(shot, 'last', t('previs.keyframe.setLast', { number: previsShotNumber(shot) }))}
        </React.Fragment>)}
        {props.others.length > 0 && (['first', 'last'] as const).map(role => <DropdownMenuSub key={role}>
          <DropdownMenuSubTrigger className="previs-menu-item" data-testid={`previs-keyframe-other-${role}-${keyframe.id}`} disabled={exportDisabled}><Link size={14} aria-hidden="true" />{t(role === 'first' ? 'previs.keyframe.setOtherFirst' : 'previs.keyframe.setOtherLast')}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="previs-keyframe-menu">{props.others.map(shot => frameItem(shot, role, shotLine(shot)))}</DropdownMenuSubContent>
        </DropdownMenuSub>)}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="previs-menu-item" data-testid={`previs-keyframe-rename-start-${keyframe.id}`} disabled={readOnly} onClick={() => props.onRenaming(true)}><PencilLine size={14} aria-hidden="true" />{t('previs.keyframe.rename')}</DropdownMenuItem>
        <DropdownMenuItem className="previs-menu-item" variant="destructive" data-testid={`previs-keyframe-delete-${keyframe.id}`} disabled={readOnly} onClick={() => props.onRemove(keyframe.id)}><Trash2 size={14} aria-hidden="true" />{t('previs.keyframe.delete')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
