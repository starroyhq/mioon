import type { TimelineClipLoudnessContext } from './timeline-clip-loudness-state.ts';
import type { ClipDraftController } from './clip-draft-state.ts';

/** Public saved metadata only. No paths, overrides or draft values enter RPC input. */
export function savedClipLoudnessFields(timeline: { id: string; revision: number; clips: readonly SavedClip[]; tracks: readonly SavedTrack[] } | null,
  assets: readonly SavedAsset[], clipId: string | null) {
  const clips = timeline?.clips.filter(clip => clip.id === clipId) ?? [];
  const clip = clips.length === 1 ? clips[0] : undefined;
  const matches = assets.filter(asset => asset.id === clip?.assetId), asset = matches.length === 1 ? matches[0] : undefined;
  const tracks = timeline?.tracks.filter(track => track.id === clip?.trackId) ?? [], track = tracks.length === 1 ? tracks[0] : undefined;
  return { timelineId: timeline?.id ?? null, revision: timeline?.revision ?? null, clipId: clip?.id ?? null,
    assetId: asset?.id ?? null, assetSha256: asset?.sha256 ?? '', trackId: track?.id ?? null,
    startFrame: clip?.startFrame ?? 0, sourceInFrame: clip?.sourceInFrame ?? 0, durationFrames: clip?.durationFrames ?? 0,
    gain: clip?.gain ?? 0, fadeInFrames: clip?.fadeInFrames ?? 0, fadeOutFrames: clip?.fadeOutFrames ?? 0,
    muted: track?.muted !== false, audioSupported: Boolean(asset && /^(audio|video)\//u.test(asset.mimeType ?? '')) };
}
interface SavedClip { id: string; assetId: string; trackId: string; startFrame: number; sourceInFrame: number; durationFrames: number; gain: number; fadeInFrames?: number; fadeOutFrames?: number }
interface SavedTrack { id: string; muted: boolean }
interface SavedAsset { id: string; sha256?: string; mimeType?: string; hasAudio?: boolean }
export function clipLoudnessDraftContext(context: TimelineClipLoudnessContext, draft: { dirty: boolean; conflict: boolean; submitting: boolean; candidate: unknown; phase: string; businessPending: boolean; compositionPending?: boolean }, visible: boolean): TimelineClipLoudnessContext {
  return { ...context, visible: context.visible && visible,
    hasUnsavedDrafts: context.hasUnsavedDrafts || draft.dirty || draft.conflict || Boolean(draft.candidate), pending: context.pending || draft.submitting || draft.businessPending || draft.compositionPending === true || !['ready', 'saved'].includes(draft.phase) };
}

/** The candidate does not get a separate mutation path or an implicit Save. */
export function stageClipLoudnessGain(controller: ClipDraftController, context: TimelineClipLoudnessContext, gain: number): boolean {
  if (!context.visible || !context.connected || context.restored || context.hasUnsavedDrafts || context.pending ||
      controller.hasPendingComposition() || controller.isDiscarding() || !Number.isFinite(gain) || gain <= 0 || gain > 2) return false;
  return controller.edit('gain', String(gain));
}
