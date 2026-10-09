import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.jsx';

export default function TimelineHistoryControls({ state, onHistory, busy = false }) {
  return <div className="timeline-history-controls" role="group" aria-label="时间线编辑历史" aria-busy={busy}>
    <Button variant="ghost" className="button small" data-testid="timeline-undo" disabled={!state.canUndo} aria-label={`撤销时间线${state.undoLabel ? `：${state.undoLabel}` : ''}`} aria-keyshortcuts="Control+Z Meta+Z" title={state.blockedReason || (state.canUndo ? `撤销：${state.undoLabel} · Ctrl/⌘+Z` : '没有可撤销的时间线编辑')} onClick={() => onHistory('undo')}><Icon name="undo" size={13} />撤销</Button>
    <Button variant="ghost" className="button small" data-testid="timeline-redo" disabled={!state.canRedo} aria-label={`重做时间线${state.redoLabel ? `：${state.redoLabel}` : ''}`} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y" title={state.blockedReason || (state.canRedo ? `重做：${state.redoLabel} · Ctrl/⌘+Shift+Z 或 Ctrl+Y` : '没有可重做的时间线编辑')} onClick={() => onHistory('redo')}><Icon name="redo" size={13} />重做</Button>
    <span className="timeline-history-count" data-testid="timeline-history-count" role="status" aria-live="polite" aria-label={state.synced ? `时间线历史：已应用 ${state.cursor} 步，共 ${state.length} 步` : state.blockedReason} title={state.blockedReason || `已应用 ${state.cursor} 步，共 ${state.length} 步；新编辑会清除可重做历史`}><span className="history-label">历史 </span>{state.cursor ?? '—'} / {state.length ?? '—'}</span>
  </div>;
}
