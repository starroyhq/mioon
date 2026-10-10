import { timelineHistoryState } from './timeline-history.js';

/** Splitting targets one explicit clip and an integer timeline frame, never all lanes. */
export function timelineSplitState({ selectedClipId, playhead, mode = 'editing', ...context }) {
  const history = timelineHistoryState(context);
  const clip = context.timeline?.clips.find(item => item.id === selectedClipId);
  const blockedReason = mode !== 'editing' ? '请切换到剪辑工作区'
    : history.blockedReason
    || (!clip ? '请先选择要分割的时间线片段'
    : !Number.isSafeInteger(playhead) ? '播放头必须是整数帧'
    : playhead <= clip.startFrame || playhead >= clip.startFrame + clip.durationFrames ? '将播放头移到所选片段内部，起止帧不能分割'
    : playhead - clip.startFrame < (clip.fadeInFrames ?? 0) || playhead - clip.startFrame > clip.durationFrames - (clip.fadeOutFrames ?? 0) ? '播放头位于音频淡入/淡出内；请移到淡入结束与淡出开始之间（含边界）'
    : context.timeline.clips.length >= 100 ? '时间线已达到100个片段上限'
    : '');
  return { canSplit: !blockedReason, blockedReason, clipId: clip?.id ?? null, clipName: clip?.name || '未选择片段', atFrame: playhead,
    leftDuration: clip ? playhead - clip.startFrame : null, rightDuration: clip ? clip.startFrame + clip.durationFrames - playhead : null };
}
