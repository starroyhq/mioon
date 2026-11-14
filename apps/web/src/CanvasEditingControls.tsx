import React, {useCallback, useLayoutEffect, useRef, useState} from 'react';
import {getNodesBounds, useStore, ViewportPortal, type ReactFlowState, type Rect} from '@xyflow/react';
import {Dialog} from '@mioon/ui/components/dialog';
import {DropdownMenuItem, DropdownMenuSeparator} from '@mioon/ui/components/dropdown-menu';
import {WorkbenchButton, WorkbenchDialogContent} from '@mioon/ui/components/workbench-controls';
import {WorkbenchContextMenu, type WorkbenchPointerAnchor} from '@mioon/ui/components/workbench-context-menu';
import {WorkbenchPopover, WorkbenchPopoverContent, WorkbenchPopoverTitle, WorkbenchPopoverTrigger} from '@mioon/ui/components/workbench-popover';
import {Clapperboard, Grid2X2, Image, Info, Layers, Link, MousePointer2, Plus, RotateCcw, Trash2, Type, X} from '@mioon/ui/components/workbench-icons';
import type {CanvasArchiveItem} from '../../../packages/contracts/src/canvas-editing.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import {useWorkspaceVisibility} from './workspace-visibility.tsx';
import './canvas-editing.css';

export interface CanvasSelectionItem {
  readonly kind: 'shot'|'node'|'edge';
  readonly type?: string | null;
}

const itemTypes = ['shot', 'image', 'text', 'video', 'audio', 'previs', 'edge', 'node'] as const;
type ItemType = typeof itemTypes[number];
const itemLabels = {
  shot: 'redesign.board.shotProperties', image: 'assets.image', text: 'shell.text', video: 'assets.video', audio: 'assets.audio',
  previs: 'canvas.edit.type.previs', edge: 'canvas.edit.type.edge', node: 'canvas.edit.type.node',
} as const;
const itemIcons = {shot: Clapperboard, image: Image, text: Type, video: Clapperboard, audio: Layers, previs: Grid2X2, edge: Link, node: Grid2X2};

function itemType({kind, type}: CanvasSelectionItem): ItemType {
  if (kind !== 'node') return kind;
  return type === 'image' || type === 'text' || type === 'video' || type === 'audio' || type === 'previs' ? type : 'node';
}

function useSelectionDetail(items: readonly CanvasSelectionItem[]): string {
  const {t} = useI18n();
  const counts = new Map<ItemType, number>();
  for (const item of items) {
    const type = itemType(item);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return itemTypes.flatMap(type => {
    const count = counts.get(type);
    return count ? [t(`canvas.edit.count.${type}`, {count})] : [];
  }).join(' · ');
}

/** Position the feedback above either the collapsed or expanded storyboard. */
function useStoryboardClearance(placement: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [bottom, setBottom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const area = ref.current?.closest<HTMLElement>('.canvas-area');
    const strip = area?.querySelector('.board-storyboard');
    if (!area || !strip) return;
    const place = () => {
      const bounds = area.getBoundingClientRect();
      const clearance = area.offsetHeight ? (bounds.bottom - strip.getBoundingClientRect().top) * (area.offsetHeight / bounds.height) : 0;
      setBottom(Number.isFinite(clearance) ? Math.max(0, Math.round(clearance)) : 0);
    };
    place();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(place);
    observer.observe(strip);
    observer.observe(area);
    return () => observer.disconnect();
  }, [placement]);
  const style = bottom === null ? undefined : {'--canvas-edit-bottom': `${bottom}px`} as React.CSSProperties;
  return {ref, style};
}

export function CanvasSelectionSummary({items, placement, scope}: {
  readonly items: readonly CanvasSelectionItem[];
  readonly placement: string;
  readonly scope?: string;
}) {
  const {t} = useI18n();
  const detail = useSelectionDetail(items);
  const {ref, style} = useStoryboardClearance(`${scope ?? ''}:${placement}:${items.length > 1}`);
  if (items.length < 2) return null;
  return <div ref={ref} style={style} className="canvas-edit-floating canvas-selection-summary" role="status" data-testid="canvas-selection-summary">
    <MousePointer2 size={14} aria-hidden="true" />
    <strong>{t('canvas.edit.selected', {count: items.length})}</strong>
    <span>{detail}</span>
  </div>;
}

export function CanvasSelectionInspector({items}: {readonly items: readonly CanvasSelectionItem[]}) {
  const {t} = useI18n();
  const detail = useSelectionDetail(items);
  return <section className="canvas-selection-inspector" data-testid="canvas-selection-inspector">
    <span className="canvas-selection-inspector-icon"><MousePointer2 size={21} aria-hidden="true" /></span>
    <h2>{t('canvas.edit.selected', {count: items.length})}</h2>
    <p>{t('canvas.edit.selectionHint', {types: detail})}</p>
  </section>;
}

const sameBounds = (left: Rect | null, right: Rect | null): boolean => left === right || Boolean(left && right &&
  left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height);

/** Keep the settled outline in flow coordinates so it follows zoom and pan. */
export function CanvasSelectionFrame({ids}: {readonly ids: ReadonlySet<string>}) {
  const bounds = useStore(useCallback((state: ReactFlowState): Rect | null => {
    if (state.userSelectionActive) return null;
    const nodes = [];
    for (const id of ids) {
      const node = state.nodeLookup.get(id);
      if (!node?.measured.width || !node.measured.height) return null;
      nodes.push(node);
    }
    return nodes.length > 1 ? getNodesBounds(nodes, {nodeLookup: state.nodeLookup}) : null;
  }, [ids]), sameBounds);
  if (!bounds) return null;
  return <ViewportPortal><div className="canvas-selection-frame" data-testid="canvas-selection-frame" aria-hidden="true"
    style={{left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height}}>
    <i /><i /><i /><i />
  </div></ViewportPortal>;
}

export function canvasEditMacShortcuts(): boolean {
  return /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
}

export function CanvasSelectionMenu({anchor, onClose, onArchive, onTidy, canArchive, canTidy}: {
  readonly anchor: WorkbenchPointerAnchor | null;
  readonly onClose: () => void;
  readonly onArchive: () => void;
  readonly onTidy: () => void;
  readonly canArchive: boolean;
  readonly canTidy: boolean;
}) {
  const {t} = useI18n();
  const mac = canvasEditMacShortcuts(), command = mac ? '⌘' : 'Ctrl+';
  const copyShortcut = `${command}C`, pasteShortcut = `${command}V`, duplicateShortcut = `${command}D`;
  return <WorkbenchContextMenu anchor={anchor} onClose={onClose} className="canvas-selection-menu" data-testid="canvas-selection-menu" aria-label={t('canvas.edit.menu')}>
    <DropdownMenuItem disabled data-testid="canvas-menu-copy"><Icon name="note" size={14} />{t('canvas.edit.copy')}<kbd>{copyShortcut}</kbd></DropdownMenuItem>
    <DropdownMenuItem disabled data-testid="canvas-menu-paste"><Layers size={14} aria-hidden="true" />{t('canvas.edit.paste')}<kbd>{pasteShortcut}</kbd></DropdownMenuItem>
    <DropdownMenuItem disabled data-testid="canvas-menu-duplicate"><Plus size={14} aria-hidden="true" />{t('canvas.edit.duplicate')}<kbd>{duplicateShortcut}</kbd></DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem disabled={!canTidy} data-testid="canvas-menu-tidy" onClick={() => {onClose(); onTidy();}}>
      <Grid2X2 size={14} aria-hidden="true" />{t('canvas.edit.tidySelected')}
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem disabled={!canArchive} variant="destructive" data-testid="canvas-menu-delete" onClick={() => {onClose(); onArchive();}}>
      <Trash2 size={14} aria-hidden="true" />{t('canvas.edit.delete')}<kbd>{mac ? '⌫' : 'Delete'}</kbd>
    </DropdownMenuItem>
  </WorkbenchContextMenu>;
}

export function CanvasDeleteDialog({review, busy, onCancel, onConfirm}: {
  readonly review: {readonly count: number; readonly versions: number; readonly clips: number} | null;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const {t} = useI18n();
  const cancel = useRef<HTMLButtonElement | null>(null);
  if (!review) return null;
  return <Dialog open onOpenChange={open => {if (!open && !busy) onCancel();}}>
    <WorkbenchDialogContent data-testid="canvas-delete-dialog" size="confirm" className="canvas-delete-dialog" initialFocus={cancel} showCloseButton={false}
      title={<><span className="canvas-delete-icon"><Trash2 size={18} aria-hidden="true" /></span>{t('canvas.edit.deleteTitle', {count: review.count})}</>}
      description={[
        review.versions ? t('canvas.edit.deleteVersions', {count: review.versions}) : '',
        review.clips ? t('canvas.edit.deleteClips', {count: review.clips}) : '',
        t('canvas.edit.deleteEffect'),
      ].filter(Boolean).join(' ')}
      footer={<><WorkbenchButton ref={cancel} disabled={busy} data-testid="canvas-delete-cancel" onClick={onCancel}>{t('common.cancel')}</WorkbenchButton>
        <WorkbenchButton variant="danger" loading={busy} data-testid="canvas-delete-confirm" onClick={onConfirm}>{t('canvas.edit.delete')}</WorkbenchButton></>}
    />
  </Dialog>;
}

export function CanvasArchivePopover({scope, visible: requestedVisible, count, items, loading, error, busy, readOnly = false, canRestoreAll, onOpen, onRestore, onRestoreAll, onRetry, onLoadMore, renderPreview}: {
  readonly scope: string;
  readonly visible: boolean;
  readonly count: number;
  readonly items: readonly CanvasArchiveItem[];
  readonly loading: boolean;
  readonly error?: React.ReactNode;
  readonly busy: boolean;
  readonly readOnly?: boolean;
  readonly canRestoreAll: boolean;
  readonly onOpen: (open: boolean) => void;
  readonly onRestore: (item: CanvasArchiveItem) => void;
  readonly onRestoreAll: () => void;
  readonly onRetry?: () => void;
  readonly onLoadMore?: () => void;
  readonly renderPreview?: (item: CanvasArchiveItem) => React.ReactNode;
}) {
  const {t, formatDate, formatNumber} = useI18n();
  const ancestorVisible = useWorkspaceVisibility(), visible = requestedVisible && ancestorVisible;
  const [openScope, setOpenScope] = useState<string | null>(null);
  const open = visible && openScope === scope;
  const current = useRef<string | null>(null);
  useLayoutEffect(() => {
    current.current = visible ? scope : null;
    setOpenScope(null);
    return () => {current.current = null;};
  }, [scope, visible]);
  const admit = (action: () => void) => {
    if (open && current.current === scope) action();
  };
  if (!count && !open && !error) return null;
  return <><span className="board-toolbar-separator" aria-hidden="true" /><WorkbenchPopover open={open} onOpenChange={next => {
    if (current.current !== scope) return;
    setOpenScope(next ? scope : null);
    onOpen(next);
  }}>
    <WorkbenchPopoverTrigger render={<WorkbenchButton className="canvas-archive-trigger" variant="ghost" data-testid="canvas-archive-trigger" disabled={!visible}
      aria-label={t('canvas.edit.archiveCount', {count})} />}>
      <Trash2 size={15} aria-hidden="true" /><span className="board-tool-label">{t('canvas.edit.archive')}</span>
      <span className="canvas-archive-count" aria-hidden="true">{formatNumber(count)}</span>
    </WorkbenchPopoverTrigger>
    <WorkbenchPopoverContent className="canvas-archive-popover" data-testid="canvas-archive-popover" hidden={!visible} inert={!visible} finalFocus={visible && count > 0 ? undefined : false}>
      <header className="canvas-archive-heading">
        <WorkbenchPopoverTitle>{t('canvas.edit.archive')}</WorkbenchPopoverTitle>
        <span>{t('redesign.library.itemCount', {count})}</span>
        <WorkbenchButton variant="ghost" size="compact" data-testid="canvas-restore-all" disabled={!canRestoreAll || readOnly || busy || loading}
          title={!canRestoreAll && count > 0 && !readOnly && !error && !loading ? t('canvas.edit.error.countLimit') : undefined}
          onClick={() => admit(onRestoreAll)}><RotateCcw size={14} aria-hidden="true" />{t('canvas.edit.restoreAll')}</WorkbenchButton>
      </header>
      <p className="canvas-archive-hint"><Info size={13} aria-hidden="true" />{t('canvas.edit.archiveHint')}</p>
      {error && <div className="canvas-archive-error" role="alert">{error}
        {onRetry && <WorkbenchButton variant="ghost" size="compact" disabled={loading || busy} onClick={() => admit(onRetry)}>{t('projectFile.common.retry')}</WorkbenchButton>}
      </div>}
      <ul className="canvas-archive-items" aria-busy={loading}>
        {items.map(item => {
          const type = itemType({kind: item.kind, type: item.nodeType}), TypeIcon = itemIcons[type];
          const label = item.label.trim() || t(itemLabels[type]);
          const time = formatDate(item.archive.at, {hour: 'numeric', minute: '2-digit'});
          return <li key={`${item.kind}:${item.id}`} data-testid={`canvas-archived-${item.id}`}>
            <div className="canvas-archive-preview" aria-hidden="true">{renderPreview?.(item) ?? <TypeIcon size={16} />}</div>
            <div className="canvas-archive-item-description"><strong title={label}>{label}</strong>
              <span>{t(itemLabels[type])}
                {item.kind === 'shot' && item.versions !== undefined && ` · ${item.versions ? t('canvas.edit.versions', {count: item.versions}) : t('canvas.edit.notGenerated')}`}
                {' · '}<time dateTime={item.archive.at} title={formatDate(item.archive.at)}>{t('canvas.edit.deletedAt', {time})}</time>
              </span>
            </div>
            <WorkbenchButton variant="secondary" size="compact" aria-label={t('canvas.edit.restoreItem', {name: label})} data-testid={`canvas-restore-${item.id}`}
              disabled={readOnly || busy || loading} onClick={() => admit(() => onRestore(item))}>{t('canvas.edit.restore')}</WorkbenchButton>
          </li>;
        })}
      </ul>
      {loading && <p className="canvas-archive-state" role="status">{t('canvas.edit.archiveLoading')}</p>}
      {!loading && !error && !items.length && <p className="canvas-archive-state" role="status">{t('canvas.edit.archiveEmpty')}</p>}
      {onLoadMore && <WorkbenchButton variant="ghost" size="compact" className="canvas-archive-more" data-testid="canvas-archive-more"
        disabled={loading || busy} onClick={() => admit(onLoadMore)}>{t('canvas.edit.loadMore')}</WorkbenchButton>}
    </WorkbenchPopoverContent>
  </WorkbenchPopover></>;
}

export function CanvasEditToast({kind, count, placement, canUndo, onUndo, onClose}: {
  readonly kind: 'archive'|'layout';
  readonly count: number;
  readonly placement: string;
  readonly canUndo: boolean;
  readonly onUndo: () => void;
  readonly onClose: () => void;
}) {
  const {t} = useI18n();
  const {ref, style} = useStoryboardClearance(placement);
  const mac = canvasEditMacShortcuts();
  return <div ref={ref} style={style} className="canvas-edit-floating canvas-edit-toast" data-testid="canvas-edit-toast">
    {kind === 'archive' ? <Trash2 size={15} aria-hidden="true" /> : <Grid2X2 size={15} aria-hidden="true" />}
    <span role="status">{t(kind === 'archive' ? 'canvas.edit.archivedToast' : 'canvas.edit.tidiedToast', {count})}</span>
    <WorkbenchButton variant="ghost" size="compact" data-testid="canvas-edit-toast-undo" disabled={!canUndo} aria-keyshortcuts={mac ? 'Meta+Z' : 'Control+Z'} onClick={onUndo}>
      {t('scene.toast.undo')}
    </WorkbenchButton>
    <WorkbenchButton variant="icon" size="compact" aria-label={t('common.close')} data-testid="canvas-edit-toast-close" onClick={onClose}><X size={14} aria-hidden="true" /></WorkbenchButton>
  </div>;
}
