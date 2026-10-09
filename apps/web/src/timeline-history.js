const operationLabels = {
  'timeline.track.add': '添加轨道',
  'timeline.track.update': '修改轨道',
  'timeline.clip.add': '添加片段',
  'timeline.clip.update': '修改片段',
  'timeline.clip.remove': '移除片段',
  'timeline.seed': '从分镜建立时间线',
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
  const blockedReason = pending ? '上一条时间线操作待确认，请先到任务面板恢复请求'
    : busy ? '正在同步时间线，请稍候'
    : dirty ? '请先保存或放弃片段的未保存修改'
    : !online ? '连接中断，等待重新同步时间线'
    : !synced ? '正在同步时间线历史'
    : '';
  return {
    synced,
    cursor: synced ? history.cursor : null,
    length: synced ? history.length : null,
    canUndo: Boolean(synced && timeline && !blockedReason && history.canUndo),
    canRedo: Boolean(synced && timeline && !blockedReason && history.canRedo),
    undoLabel: synced && history.undoEntry ? operationLabels[history.undoEntry.operation] || '时间线编辑' : '',
    redoLabel: synced && history.redoEntry ? operationLabels[history.redoEntry.operation] || '时间线编辑' : '',
    blockedReason,
  };
}
