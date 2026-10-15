import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
const operationMessages = {
  'timeline.track.add': message('timeline.history.trackAdd'),
  'timeline.track.update': message('timeline.history.trackUpdate'),
  'timeline.clip.add': message('timeline.history.clipAdd'),
  'timeline.clip.update': message('timeline.history.clipUpdate'),
  'timeline.clip.replaceSource': message('timeline.history.clipReplace'),
  'timeline.clip.remove': message('timeline.history.clipRemove'),
  'timeline.clip.split': message('timeline.history.clipSplit'),
  'timeline.subtitle.add': message('timeline.history.subtitleAdd'),
  'timeline.subtitle.update': message('timeline.history.subtitleUpdate'),
  'timeline.subtitle.remove': message('timeline.history.subtitleRemove'),
  'timeline.seed': message('timeline.view.seed'),
};

/** Only a history snapshot paired with the displayed aggregate may enable edits. */
export function timelineHistoryState({ projectId, timeline, history, busy = false, pending = false, dirty = false, online = true }) {
  const validCounts = Number.isSafeInteger(history?.cursor) && Number.isSafeInteger(history?.length)
    && history.cursor >= 0 && history.length >= history.cursor;
  const sameTimeline = timeline
    ? history?.timelineId === timeline.id && history?.revision === timeline.revision
    : history?.timelineId === null && history?.revision === null && history?.length === 0;
  const synced = Boolean(projectId && history?.projectId === projectId && sameTimeline && validCounts
    && history.canUndo === (history.cursor > 0) && history.canRedo === (history.cursor < history.length)
    && (history.canUndo ? history.undoEntry?.id : history.undoEntry === null)
    && (history.canRedo ? history.redoEntry?.id : history.redoEntry === null));
  const blockedMessage = pending ? message('timeline.history.pending')
    : busy ? message('timeline.history.busy')
    : dirty ? message('timeline.history.dirty')
    : !online ? message('timeline.history.offline')
    : !synced ? message('timeline.history.syncing')
    : null;
  const blockedReason = renderMessage('zh-Hans', blockedMessage);
  const undoMessage = synced && history.undoEntry ? operationMessages[history.undoEntry.operation] || message('timeline.history.edit') : null;
  const redoMessage = synced && history.redoEntry ? operationMessages[history.redoEntry.operation] || message('timeline.history.edit') : null;
  return {
    synced,
    cursor: synced ? history.cursor : null,
    length: synced ? history.length : null,
    canUndo: Boolean(synced && timeline && !blockedReason && history.canUndo),
    canRedo: Boolean(synced && timeline && !blockedReason && history.canRedo),
    undoLabel: renderMessage('zh-Hans', undoMessage),
    redoLabel: renderMessage('zh-Hans', redoMessage),
    blockedReason, blockedMessage, undoMessage, redoMessage,
  };
}
