import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
const operationMessages: Readonly<Record<string, DisplayMessage>> = {
  'timeline.track.add': message('timeline.history.trackAdd'),
  'timeline.track.update': message('timeline.history.trackUpdate'),
  'timeline.clip.add': message('timeline.history.clipAdd'),
  'timeline.clip.update': message('timeline.history.clipUpdate'),
  'timeline.clip.replaceSource': message('timeline.history.clipReplace'),
  'timeline.clip.remove': message('timeline.history.clipRemove'),
  'timeline.clip.rippleRemove': message('timeline.history.clipRippleRemove'),
  'timeline.clip.split': message('timeline.history.clipSplit'),
  'timeline.subtitle.add': message('timeline.history.subtitleAdd'),
  'timeline.subtitle.update': message('timeline.history.subtitleUpdate'),
  'timeline.subtitle.remove': message('timeline.history.subtitleRemove'),
  'timeline.seed': message('timeline.view.seed'),
  'timeline.clip.refreshSources': message('timeline.history.sourcesRefresh'),
  'timeline.shots.append': message('timeline.history.shotsAppend'),
  'timeline.clip.splitAtScenes': message('timeline.history.splitAtScenes'),
};
interface HistoryEntryView {id?: unknown; operation?: unknown}
interface HistoryView {
  cursor?: unknown;
  length?: unknown;
  timelineId?: unknown;
  revision?: unknown;
  projectId?: unknown;
  canUndo?: boolean;
  canRedo?: boolean;
  undoEntry?: HistoryEntryView | null;
  redoEntry?: HistoryEntryView | null;
}
interface TimelineView {id?: unknown; revision?: unknown}
interface TimelineHistoryOptions {
  projectId: string | null | undefined;
  timeline: TimelineView | null | undefined;
  history: HistoryView | null | undefined;
  busy?: boolean;
  pending?: boolean;
  dirty?: boolean;
  online?: boolean;
}
/** Only a history snapshot paired with the displayed aggregate may enable edits. */
export type TimelineHistoryState = ReturnType<typeof timelineHistoryState>;
export function timelineHistoryState({ projectId, timeline, history, busy = false, pending = false, dirty = false, online = true }: TimelineHistoryOptions) {
  const validCounts = Number.isSafeInteger(history?.cursor) && Number.isSafeInteger(history?.length)
    && (history!.cursor as number) >= 0 && (history!.length as number) >= (history!.cursor as number);
  const sameTimeline = timeline
    ? history?.timelineId === timeline.id && history?.revision === timeline.revision
    : history?.timelineId === null && history?.revision === null && history?.length === 0;
  const synced = Boolean(projectId && history?.projectId === projectId && sameTimeline && validCounts
    && history!.canUndo === ((history!.cursor as number) > 0) && history!.canRedo === ((history!.cursor as number) < (history!.length as number))
    && (history!.canUndo ? history!.undoEntry?.id : history!.undoEntry === null)
    && (history!.canRedo ? history!.redoEntry?.id : history!.redoEntry === null));
  const blockedMessage = pending ? message('timeline.history.pending')
    : busy ? message('timeline.history.busy')
    : dirty ? message('timeline.history.dirty')
    : !online ? message('timeline.history.offline')
    : !synced ? message('timeline.history.syncing')
    : null;
  const blockedReason = renderMessage('zh-Hans', blockedMessage);
  const undoOperation = typeof history?.undoEntry?.operation === 'string' ? history.undoEntry.operation : undefined;
  const redoOperation = typeof history?.redoEntry?.operation === 'string' ? history.redoEntry.operation : undefined;
  const undoMessage = synced && history?.undoEntry ? (undoOperation !== undefined ? operationMessages[undoOperation] : undefined) || message('timeline.history.edit') : null;
  const redoMessage = synced && history?.redoEntry ? (redoOperation !== undefined ? operationMessages[redoOperation] : undefined) || message('timeline.history.edit') : null;
  return {
    synced,
    cursor: synced ? history!.cursor as number : null,
    length: synced ? history!.length as number : null,
    canUndo: Boolean(synced && timeline && !blockedReason && history!.canUndo),
    canRedo: Boolean(synced && timeline && !blockedReason && history!.canRedo),
    undoLabel: renderMessage('zh-Hans', undoMessage),
    redoLabel: renderMessage('zh-Hans', redoMessage),
    blockedReason, blockedMessage, undoMessage, redoMessage,
  };
}
