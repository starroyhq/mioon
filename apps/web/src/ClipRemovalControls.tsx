import React from 'react';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {MoreHorizontal, Trash2, ArrowLeftToLine, Play, CornerUpLeft, AlertTriangle, Scissors, FolderOpen, Replace} from '@mioon/ui/components/workbench-icons';
import {Button} from '@mioon/ui/components/button';
import {Dialog, DialogContent, DialogDescription, DialogTitle} from '@mioon/ui/components/dialog';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger} from '@mioon/ui/components/dropdown-menu';
import {useI18n} from './i18n/I18nProvider.tsx';
import {clipRemovalKey, clipRemovalTargetIsEditing, type ClipRemovalMode} from './timeline-removal.ts';
import {hasOpenWorkbenchModal} from './workbench-modal-state.ts';

interface Clip {id: string; name?: string; durationFrames: number}
interface Options {
  clip: Clip | undefined; scope: string; disabled: boolean; canRemove?: () => boolean;
  onRemove?: (clipId: string) => unknown; onRippleRemove?: (clipId: string) => unknown;
}

export function useClipRemoval(options: Options) {
  const {t} = useI18n();
  const current = useRef(options);current.current = options;
  const [pending, setPending] = useState<{mode: ClipRemovalMode; scope: string; id: string} | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(false), inFlight = useRef(false);
  useLayoutEffect(() => {mounted.current = true;return () => {mounted.current = false;};}, []);
  const available = (value: Options, mode: ClipRemovalMode) => Boolean(value.clip && !value.disabled &&
    (mode === 'ripple' ? value.onRippleRemove : value.onRemove) && (!value.canRemove || value.canRemove()));
  function request(mode: ClipRemovalMode) {
    const value = current.current;
    if (!inFlight.current && available(value, mode) && value.clip) setPending({mode, scope: value.scope, id: value.clip.id});
  }
  const valid = Boolean(pending && pending.scope === options.scope && pending.id === options.clip?.id && available(options, pending.mode));
  useEffect(() => {setPending(null);}, [options.scope]);
  async function submit() {
    const value = current.current;
    if (!pending || inFlight.current || pending.scope !== value.scope || pending.id !== value.clip?.id || !available(value, pending.mode)) return;
    const action = pending.mode === 'ripple' ? value.onRippleRemove : value.onRemove;
    if (!action) return;
    inFlight.current = true;setSubmitting(true);setPending(null);
    try {await action(pending.id);} finally {inFlight.current = false;if (mounted.current) setSubmitting(false);}
  }
  const mode = pending?.mode || 'remove';
  const dialog = <Dialog open={valid} onOpenChange={open => {if (!open && !inFlight.current) setPending(null);}}>
    <DialogContent className="clip-remove-dialog" showCloseButton={false}>
      <div className="clip-remove-title"><AlertTriangle size={18} /><DialogTitle>{t(mode === 'ripple' ? 'edit.remove.rippleTitle' : 'edit.remove.title', {name: options.clip?.name || t('timeline.view.mediaClip')})}</DialogTitle></div>
      <DialogDescription>{t(mode === 'ripple' ? 'edit.remove.rippleDetail' : 'edit.remove.detail', {frames: options.clip?.durationFrames || 0})}</DialogDescription>
      <div className="clip-remove-actions"><Button variant="outline" disabled={submitting} onClick={() => setPending(null)}>{t('edit.remove.cancel')}</Button><Button className="clip-remove-confirm" data-testid="confirm-clip-removal" disabled={!valid || submitting} onClick={() => {void submit();}}>{t(mode === 'ripple' ? 'edit.remove.ripple' : 'edit.remove.action')}</Button></div>
    </DialogContent>
  </Dialog>;
  return {request, dialog, available: (mode: ClipRemovalMode) => mounted.current && !inFlight.current && available(current.current, mode)};
}

export function TimelineRemovalShortcuts({disabled, request}: {disabled: boolean; request: (mode: ClipRemovalMode) => void}) {
  const current = useRef({disabled, request});current.current = {disabled, request};
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const menuOpen = Array.from(document.querySelectorAll('[data-slot="dropdown-menu-content"]')).some(menu => !menu.closest('[hidden], [inert], [data-closed], [aria-hidden="true"]'));
      const mode = clipRemovalKey(event, current.current.disabled || hasOpenWorkbenchModal(document) || menuOpen || clipRemovalTargetIsEditing(event.composedPath()));
      if (mode) {event.preventDefault();current.current.request(mode);}
    };
    window.addEventListener('keydown', key);return () => window.removeEventListener('keydown', key);
  }, []);
  return null;
}

export function ClipActionsMenu({disabled, disabledHint, rippleDisabled = false, onRemove, onRippleRemove, onPreview, onReturnToSource, onSplit, splitDisabled = false, onShowAsset, onReplaceSource}: {
  disabled: boolean; disabledHint?: string; rippleDisabled?: boolean; onRemove?: () => void; onRippleRemove?: () => void;
  onPreview?: () => void; onReturnToSource?: () => void; onSplit?: () => unknown; splitDisabled?: boolean; onShowAsset?: () => unknown; onReplaceSource?: () => unknown;
}) {
  const {t} = useI18n();
  return <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" type="button" />} aria-label={t('edit.clip.more')} title={disabledHint} data-testid="clip-more"><MoreHorizontal size={16} /></DropdownMenuTrigger><DropdownMenuContent className="clip-actions-menu" align="end">
    {onSplit && <DropdownMenuItem data-testid="clip-menu-split" disabled={disabled || splitDisabled} onClick={() => {void onSplit();}}><Scissors size={14} />{t('timeline.split.action')}<DropdownMenuShortcut>{t('round3.clip.splitShortcut')}</DropdownMenuShortcut></DropdownMenuItem>}
    {onShowAsset && <DropdownMenuItem data-testid="clip-menu-show-asset" onClick={() => {void onShowAsset();}}><FolderOpen size={14} />{t('round3.clip.showAsset')}</DropdownMenuItem>}
    {onReplaceSource && <DropdownMenuItem data-testid="clip-menu-replace-source" disabled={disabled} onClick={() => {void onReplaceSource();}}><Replace size={14} />{t('round3.clip.replaceSource')}</DropdownMenuItem>}
    {onReturnToSource && <DropdownMenuItem onClick={onReturnToSource}><CornerUpLeft size={14} />{t('timeline.inspector.returnSource')}</DropdownMenuItem>}
    {onPreview && <DropdownMenuItem onClick={onPreview}><Play size={14} />{t('timeline.inspector.previewSource')}</DropdownMenuItem>}
    {(onSplit || onShowAsset || onReplaceSource || onPreview || onReturnToSource) && (onRemove || onRippleRemove) && <DropdownMenuSeparator />}
    {onRemove && <DropdownMenuItem variant="destructive" data-testid="remove-clip" disabled={disabled} onClick={onRemove}><Trash2 size={14} />{t('edit.remove.action')}<DropdownMenuShortcut>⌫</DropdownMenuShortcut></DropdownMenuItem>}
    {onRippleRemove && <DropdownMenuItem variant="destructive" data-testid="ripple-remove-clip" disabled={disabled || rippleDisabled} onClick={onRippleRemove}><ArrowLeftToLine size={14} />{t('edit.remove.ripple')}<DropdownMenuShortcut>⇧⌫</DropdownMenuShortcut></DropdownMenuItem>}
  </DropdownMenuContent></DropdownMenu>;
}
