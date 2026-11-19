import React from 'react';
import './edit-ui.css';
import {Button} from '@mioon/ui/components/button';
import Icon from '../icons.tsx';
import {useI18n} from '../i18n/I18nProvider.tsx';
import type {LostResponseView} from './lost-response.ts';

/** One undoable main-track operation. `id` identifies the action so a late
 * dismissal cannot close a newer notice. */
export interface EditUiNotice {
  readonly id: string;
  readonly message: string;
}

export interface EditUiNoticeState {
  readonly notice: EditUiNotice | null;
}

export type EditUiNoticeAction = {readonly type: 'show'; readonly notice: EditUiNotice}
  | {readonly type: 'dismiss'; readonly id?: string}
  | {readonly type: 'undo'; readonly id: string};

/** A single bar at a time: showing a new notice replaces the previous one. */
export function editUiNoticeReducer(state: EditUiNoticeState, action: EditUiNoticeAction): EditUiNoticeState {
  if (action.type === 'show') return state.notice?.id === action.notice.id ? state : {notice: action.notice};
  if (action.type === 'dismiss') return state.notice && (action.id === undefined || state.notice.id === action.id) ? {notice: null} : state;
  return state.notice?.id === action.id ? {notice: null} : state;
}

/** Floating result bar for a main-track removal: message, undo and close. The
 * undo button is a regular focusable button, so the bar works from the keyboard. */
export default function EditUiNoticeBar({notice, onUndo, onDismiss}: {
  readonly notice: EditUiNotice | null;
  readonly onUndo?: ((notice: EditUiNotice) => unknown) | undefined;
  readonly onDismiss?: ((notice: EditUiNotice) => unknown) | undefined;
}): React.ReactElement | null {
  const {t} = useI18n();
  if (!notice) return null;
  return <div className="edit-ui-notice" role="status" data-testid="edit-ui-notice-bar" data-notice-id={notice.id}>
    <Icon name="check" size={14} />
    <span className="edit-ui-notice-message" data-testid="edit-ui-notice-message">{notice.message}</span>
    <Button type="button" variant="ghost" size="sm" className="edit-ui-notice-undo" data-testid="edit-ui-notice-undo"
      onClick={() => onUndo?.(notice)}>{t('editUi.notice.undo')}</Button>
    <Button type="button" variant="ghost" size="icon-sm" className="edit-ui-notice-dismiss" data-testid="edit-ui-notice-dismiss"
      aria-label={t('editUi.notice.dismiss')} onClick={() => onDismiss?.(notice)}><Icon name="close" size={12} /></Button>
  </div>;
}

/** The one unconfirmed edit whose commit response was lost. It has no dismiss
 * control: the user must either retry the same request or abandon it. Status,
 * one bare reason and the two actions only — no explanatory copy. */
export function EditUiUnknownBar({view, onRetry, onAbandon}: {
  readonly view: LostResponseView | null;
  readonly onRetry: () => unknown;
  readonly onAbandon: () => unknown;
}): React.ReactElement | null {
  const {t} = useI18n();
  if (!view) return null;
  return <div className="edit-ui-notice edit-ui-notice-unknown" role="status" data-testid="edit-ui-unconfirmed-bar"
    data-request-id={view.requestId}>
    <Icon name="warning" size={14} />
    <span className="edit-ui-notice-message" data-testid="edit-ui-unconfirmed-status">{t('editUi.unconfirmed.status')}</span>
    <span className="edit-ui-notice-message edit-ui-notice-reason" data-testid="edit-ui-unconfirmed-reason">{t('editUi.unconfirmed.reason')}</span>
    <Button type="button" variant="ghost" size="sm" className="edit-ui-notice-undo" data-testid="edit-ui-unconfirmed-retry"
      onClick={() => onRetry()}>{t('editUi.unconfirmed.retry')}</Button>
    <Button type="button" variant="ghost" size="sm" data-testid="edit-ui-unconfirmed-abandon"
      onClick={() => onAbandon()}>{t('editUi.unconfirmed.abandon')}</Button>
  </div>;
}
