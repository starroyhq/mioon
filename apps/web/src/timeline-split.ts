import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import { timelineHistoryState } from './timeline-history.ts';

interface SplitClipView {id?: unknown; name?: unknown; startFrame?: number; durationFrames?: number; fadeInFrames?: number | null; fadeOutFrames?: number | null}
interface SplitTimelineView {id?: unknown; revision?: unknown; clips?: readonly SplitClipView[]}
type TimelineHistoryContext = Parameters<typeof timelineHistoryState>[0];
interface TimelineSplitOptions extends Omit<TimelineHistoryContext, 'timeline'> {
  selectedClipId?: string | null;
  playhead: number;
  mode?: string;
  timeline: (SplitTimelineView & {clips: readonly SplitClipView[]}) | null | undefined;
}
/** Splitting targets one explicit clip and an integer timeline frame, never all lanes. */
export function timelineSplitState({ selectedClipId, playhead, mode = 'editing', ...context }: TimelineSplitOptions) {
  const history = timelineHistoryState(context);
  const clip = context.timeline?.clips.find(item => item.id === selectedClipId);
  const blockedMessage = mode !== 'editing' ? message('timeline.split.editingRequired')
    : history.blockedMessage
    || (!clip ? message('timeline.split.selectClip')
    : !Number.isSafeInteger(playhead) ? message('timeline.split.integer')
    : playhead <= (clip.startFrame as number) || playhead >= (clip.startFrame as number) + (clip.durationFrames as number) ? message('timeline.split.inside')
    : playhead - (clip.startFrame as number) < (clip.fadeInFrames ?? 0) || playhead - (clip.startFrame as number) > (clip.durationFrames as number) - (clip.fadeOutFrames ?? 0) ? message('timeline.split.fade')
    : context.timeline!.clips.length >= 100 ? message('timeline.split.limit')
    : null);
  const blockedReason = renderMessage('zh-Hans', blockedMessage);
  return { canSplit: !blockedReason, blockedReason, blockedMessage, clipSelected: Boolean(clip), clipId: clip?.id ?? null, clipName: typeof clip?.name === 'string' && clip.name ? clip.name : '未选择片段', atFrame: playhead,
    leftDuration: clip ? playhead - (clip.startFrame as number) : null, rightDuration: clip ? (clip.startFrame as number) + (clip.durationFrames as number) - playhead : null };
}
