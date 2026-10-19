import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';

interface TimelineHistoryState {
  canUndo?: boolean; canRedo?: boolean; synced?: boolean;
  blockedMessage?: import('../../../packages/i18n/src/index.ts').DisplayMessage | null;
  undoMessage?: import('../../../packages/i18n/src/index.ts').DisplayMessage | null;
  redoMessage?: import('../../../packages/i18n/src/index.ts').DisplayMessage | null;
  cursor: number; length: number;
}
export default function TimelineHistoryControls({ state, onHistory, busy = false }: {state: TimelineHistoryState; onHistory: (action: 'undo' | 'redo') => void; busy?: boolean}) {
  const { t, renderMessage } = useI18n();
  const blocked = renderMessage(state.blockedMessage), undo = renderMessage(state.undoMessage), redo = renderMessage(state.redoMessage);
  return <div className="timeline-history-controls" role="group" aria-label={t('timeline.history.group')} aria-busy={busy}>
    <Button variant="ghost" className="button small" data-testid="timeline-undo" disabled={!state.canUndo} aria-label={t('timeline.history.undoAria', { label: undo })} aria-keyshortcuts="Control+Z Meta+Z" title={blocked || (state.canUndo ? t('timeline.history.undoHint', { label: undo }) : t('timeline.history.nothingUndo'))} onClick={() => onHistory('undo')}><Icon name="undo" size={13} />{t('timeline.history.undo')}</Button>
    <Button variant="ghost" className="button small" data-testid="timeline-redo" disabled={!state.canRedo} aria-label={t('timeline.history.redoAria', { label: redo })} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y" title={blocked || (state.canRedo ? t('timeline.history.redoHint', { label: redo }) : t('timeline.history.nothingRedo'))} onClick={() => onHistory('redo')}><Icon name="redo" size={13} />{t('timeline.history.redo')}</Button>
    <span className="timeline-history-count" data-testid="timeline-history-count" role="status" aria-live="polite" aria-label={state.synced ? t('timeline.history.count', { cursor: state.cursor, length: state.length }) : blocked} title={blocked || t('timeline.history.countHint', { cursor: state.cursor ?? '—', length: state.length ?? '—' })}><span className="history-label">{t('timeline.history.history')} </span>{state.cursor ?? '—'} / {state.length ?? '—'}</span>
  </div>;
}
