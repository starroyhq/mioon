import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import { timelineHistoryState } from './timeline-history.ts';

/** Splitting targets one explicit clip and an integer timeline frame, never all lanes. */
export function timelineSplitState({ selectedClipId, playhead, mode = 'editing', ...context }) {
  const history = timelineHistoryState(context);
  const clip = context.timeline?.clips.find(item => item.id === selectedClipId);
  const blockedMessage = mode !== 'editing' ? message('timeline.split.editingRequired')
    : history.blockedMessage
    || (!clip ? message('timeline.split.selectClip')
    : !Number.isSafeInteger(playhead) ? message('timeline.split.integer')
    : playhead <= clip.startFrame || playhead >= clip.startFrame + clip.durationFrames ? message('timeline.split.inside')
    : playhead - clip.startFrame < (clip.fadeInFrames ?? 0) || playhead - clip.startFrame > clip.durationFrames - (clip.fadeOutFrames ?? 0) ? message('timeline.split.fade')
    : context.timeline.clips.length >= 100 ? message('timeline.split.limit')
    : null);
  const blockedReason = renderMessage('zh-Hans', blockedMessage);
  return { canSplit: !blockedReason, blockedReason, blockedMessage, clipSelected: Boolean(clip), clipId: clip?.id ?? null, clipName: clip?.name || '未选择片段', atFrame: playhead,
    leftDuration: clip ? playhead - clip.startFrame : null, rightDuration: clip ? clip.startFrame + clip.durationFrames - playhead : null };
}
