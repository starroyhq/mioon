import { message } from '../../../packages/i18n/src/index.ts';
import type { MessageDescriptor } from '../../../packages/i18n/src/index.ts';
import { sourceFrameCount } from '@mioon/contracts';
// Renderer-only geometry. Explicit CLI/MCP/business frame edits never snap.
export const SNAP_THRESHOLD_PX = 8;
export const MAX_TIMELINE_FRAME = 18000;
export interface SnappingAsset { mimeType?: string; duration?: unknown; [key: string]: unknown }
export interface SnappingClip { id: string; startFrame: number; durationFrames: number; trackId?: string; [key: string]: unknown }
export interface SnappingTimeline { clips: SnappingClip[]; [key: string]: unknown }
export interface DurationDescription { durationFrames: number; known: boolean; note: string; noteMessage?: MessageDescriptor }
interface SnapTarget { frame: number; kind: 'zero' | 'playhead' | 'clip'; label: string; labelMessage: MessageDescriptor; id: string }
interface SnapCandidate extends SnapTarget { edge: 'start' | 'end'; proposed: number; distance: number }
export interface SnapResult { startFrame: number; snap: SnapCandidate | null; bounded: boolean }
export interface SnapTimelineInput {
  pointerFrame: number; grabFrame?: number; durationFrames: number; pixelsPerFrame: number;
  clips?: readonly SnappingClip[]; excludeClipId?: string; playhead?: number; enabled?: boolean; altKey?: boolean;
  thresholdPx?: number; maxFrame?: number;
}
export interface DropPreviewInput {
  timeline?: SnappingTimeline | null; track?: { id: string; kind?: string; [key: string]: unknown } | null;
  asset?: SnappingAsset | null; clip?: SnappingClip | null; pointerFrame: number; grabFrame?: number;
  pixelsPerFrame: number; playhead?: number; enabled?: boolean; altKey?: boolean;
}

export function assetTimelineDuration(asset: SnappingAsset | null | undefined): DurationDescription {
  if (asset?.mimeType?.startsWith('image/')) return { durationFrames: 90, known: true, note: '图片默认 90 帧', noteMessage: message('timeline.snap.imageDefault') };
  const frames = sourceFrameCount(asset?.duration);
  if (frames !== null && Number.isSafeInteger(frames) && frames >= 1) return { durationFrames: frames, known: true, note: '' };
  return { durationFrames: 60, known: false, note: '素材时长未知，60 帧仅为示意；不能放置', noteMessage: message('timeline.snap.unknownDuration') };
}
export function snapTimelinePosition({ pointerFrame, grabFrame = 0, durationFrames, pixelsPerFrame, clips = [], excludeClipId, playhead = 0, enabled = true, altKey = false, thresholdPx = SNAP_THRESHOLD_PX, maxFrame = MAX_TIMELINE_FRAME }: SnapTimelineInput): SnapResult {
  const maxStart = Math.max(0, maxFrame - durationFrames);
  const raw = Number.isFinite(pointerFrame - grabFrame) ? pointerFrame - grabFrame : 0;
  const bounded = Math.max(0, Math.min(maxStart, raw));
  const startFrame = Math.max(0, Math.min(maxStart, Math.round(bounded)));
  const base: SnapResult = { startFrame, snap: null, bounded: bounded !== raw };
  if (!enabled || altKey || !(pixelsPerFrame > 0) || !Number.isFinite(pixelsPerFrame) || !Number.isSafeInteger(durationFrames) || durationFrames < 1 || durationFrames > maxFrame) return base;
  const targets: SnapTarget[] = [{ frame: 0, kind: 'zero', label: '时间线起点', labelMessage: message('timeline.snap.zero'), id: '' }, { frame: playhead, kind: 'playhead', label: '播放头', labelMessage: message('timeline.view.playhead'), id: '' }];
  for (const clip of clips) if (clip.id !== excludeClipId) {
    targets.push({ frame: clip.startFrame, kind: 'clip', label: '片段起点', labelMessage: message('timeline.snap.clipStart'), id: clip.id }, { frame: clip.startFrame + clip.durationFrames, kind: 'clip', label: '片段终点', labelMessage: message('timeline.snap.clipEnd'), id: clip.id });
  }
  const candidates: SnapCandidate[] = [];
  for (const target of targets) {
    if (!Number.isSafeInteger(target.frame) || target.frame < 0 || target.frame > maxFrame) continue;
    for (const edge of ['start', 'end'] as const) {
      const proposed = target.frame - (edge === 'end' ? durationFrames : 0);
      const distance = Math.abs(proposed - bounded) * pixelsPerFrame;
      if (proposed >= 0 && proposed <= maxStart && distance <= thresholdPx + 1e-9) candidates.push({ ...target, edge, proposed, distance });
    }
  }
  // Stable regardless of clip array order: distance, moving start edge, earlier
  // target, zero/playhead/clip, then ID. Never skip collisions to find a gap.
  const priority: Record<SnapTarget['kind'], number> = { zero: 0, playhead: 1, clip: 2 };
  candidates.sort((a, b) => a.distance - b.distance || (a.edge === 'start' ? 0 : 1) - (b.edge === 'start' ? 0 : 1) || a.frame - b.frame || priority[a.kind] - priority[b.kind] || String(a.id).localeCompare(String(b.id)));
  const snap = candidates[0] ?? null;
  return snap ? { startFrame: snap.proposed, snap, bounded: base.bounded } : base;
}
export function timelineDropPreview({ timeline, track, asset, clip, pointerFrame, grabFrame = 0, pixelsPerFrame, playhead, enabled, altKey = false }: DropPreviewInput) {
  const length: DurationDescription = clip ? { durationFrames: clip.durationFrames, known: true, note: '' } : assetTimelineDuration(asset);
  const position = snapTimelinePosition({ pointerFrame, grabFrame, durationFrames: length.durationFrames, pixelsPerFrame, clips: timeline?.clips, excludeClipId: clip?.id, playhead, enabled: enabled && length.known, altKey });
  let reason = '', reasonMessage: MessageDescriptor | null = null;
  if (!asset || !track || !timeline) { reason = '素材或轨道已不可用'; reasonMessage = message('timeline.snap.unavailable'); }
  else if (track.kind !== (asset.mimeType?.startsWith('audio/') ? 'audio' : 'video')) { reason = '片段类型与目标轨道不兼容'; reasonMessage = message('timeline.snap.incompatible'); }
  else if (!length.known)  { reason = length.note; reasonMessage = length.noteMessage ?? null; }
  else if (length.durationFrames > MAX_TIMELINE_FRAME) { reason = '片段超过时间线 18000 帧上限'; reasonMessage = message('timeline.snap.tooLong'); }
  else if (!clip && timeline.clips.length >= 100) { reason = '时间线最多容纳 100 个片段'; reasonMessage = message('timeline.snap.clipLimit'); }
  else if (timeline.clips.some(other => other.id !== clip?.id && other.trackId === track.id && position.startFrame < other.startFrame + other.durationFrames && position.startFrame + length.durationFrames > other.startFrame)) { reason = '同一轨道不允许重叠'; reasonMessage = message('timeline.snap.overlap'); }
  return { ...position, ...length, trackId: track?.id, valid: !reason, reason, reasonMessage, altKey, unchanged: Boolean(clip && clip.trackId === track?.id && clip.startFrame === position.startFrame) };
}
