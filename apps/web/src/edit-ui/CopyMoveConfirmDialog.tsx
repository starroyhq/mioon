import React, {useLayoutEffect, useRef} from 'react';
import './edit-ui.css';
import {Button} from '@mioon/ui/components/button';
import {useI18n} from '../i18n/I18nProvider.tsx';

/** Everything UI-E2 needs to check the copy against the original segment and the
 * timeline revision it was requested for. */
export interface EditUiCopyMoveRequest {
  readonly clipId: string;
  readonly nodeId: string;
  readonly segmentGroupId: string;
  readonly targetTrackId: string;
  readonly targetStartFrame: number;
  readonly timelineRevision: number;
}

export type EditUiCopyMoveKey = 'confirm' | 'cancel' | 'focus-next' | 'focus-previous' | null;

/** Keyboard outcome for the confirmation. Enter on the cancel button cancels;
 * Enter anywhere else confirms. Only Tab is trapped. */
export function editUiCopyMoveKeyAction(key: string, focused: 'confirm' | 'cancel' | null): EditUiCopyMoveKey {
  if (key === 'Escape') return 'cancel';
  if (key === 'Enter') return focused === 'cancel' ? 'cancel' : 'confirm';
  if (key === 'Tab') return focused === 'confirm' ? 'focus-previous' : 'focus-next';
  return null;
}

/** The 21-03 confirmation: title and two buttons only. The design's explanatory
 * sentence is intentionally omitted. No animation runs, so reduced motion has
 * nothing to disable. */
export default function CopyMoveConfirmDialog({request, onConfirm, onCancel}: {
  readonly request: EditUiCopyMoveRequest | null;
  readonly onConfirm?: ((request: EditUiCopyMoveRequest) => unknown) | undefined;
  readonly onCancel?: (() => unknown) | undefined;
}): React.ReactElement | null {
  const {t} = useI18n();
  const dialog = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (request) dialog.current?.querySelector<HTMLElement>('[data-action="confirm"]')?.focus();
  }, [request]);
  if (!request) return null;
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const focused = (event.target as HTMLElement | null)?.dataset?.action === 'cancel' ? 'cancel'
      : (event.target as HTMLElement | null)?.dataset?.action === 'confirm' ? 'confirm' : null;
    const action = editUiCopyMoveKeyAction(event.key, focused);
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'confirm') onConfirm?.(request!);
    else if (action === 'cancel') onCancel?.();
    else {
      const next = action === 'focus-next' ? 'confirm' : 'cancel';
      dialog.current?.querySelector<HTMLElement>(`[data-action="${next}"]`)?.focus();
    }
  }
  return <div className="edit-ui-dialog-layer">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="edit-ui-copy-move-title" className="edit-ui-copy-move"
      data-testid="edit-ui-copy-move-dialog" onKeyDown={handleKeyDown}>
      <h2 id="edit-ui-copy-move-title" data-testid="edit-ui-copy-move-title">{t('editUi.copyMove.title')}</h2>
      <div className="edit-ui-dialog-actions">
        <Button type="button" variant="outline" data-action="cancel" data-testid="edit-ui-copy-move-cancel"
          onClick={() => onCancel?.()}>{t('editUi.copyMove.cancel')}</Button>
        <Button type="button" data-action="confirm" data-testid="edit-ui-copy-move-confirm" className="button primary"
          onClick={() => onConfirm?.(request!)}>{t('editUi.copyMove.confirm')}</Button>
      </div>
    </div>
  </div>;
}
