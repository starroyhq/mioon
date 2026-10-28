import { timelineCrossfadeOverlap } from '@mioon/contracts';

export interface CrossfadeTimelineClip { id: string; trackId: string; startFrame: number; durationFrames: number; assetId: string; name?: string; volumeEnvelope?: unknown }
export interface CrossfadeAsset { id: string; mimeType: string; hasAudio?: boolean; name?: string }
/** envelope: either clip already has volume keyframes; locked: either track is
 * locked. Fades are kept and multiply the new curves, so they never block. */
export type CrossfadeBlock = 'envelope' | 'locked';
export interface CrossfadeCandidate {
  outgoingClipId: string; incomingClipId: string; partnerClipId: string; partnerName: string;
  /** What the selected clip does in this pair. */
  role: 'outgoing' | 'incoming'; startFrame: number; durationFrames: number; blocked: CrossfadeBlock | null;
}
export const CROSSFADE_CANDIDATE_LIMIT = 8;

const sounding = (asset: CrossfadeAsset | undefined): boolean => Boolean(asset && asset.hasAudio === true && !asset.mimeType.startsWith('image/'));

/** The pairs the selected clip can form with clips on other tracks, in timeline
 * order. Blocked pairs stay listed with their reason; the backend makes the
 * final decision against the saved timeline. */
export function timelineCrossfadeCandidates(clips: readonly CrossfadeTimelineClip[], assets: readonly CrossfadeAsset[], selectedClipId: string,
  lockedTrackIds: ReadonlySet<string> = new Set()): CrossfadeCandidate[] {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const selected = clips.find(clip => clip.id === selectedClipId);
  if (!selected || !sounding(byId.get(selected.assetId))) return [];
  const rows: CrossfadeCandidate[] = [];
  for (const other of clips) {
    if (other.id === selected.id || !sounding(byId.get(other.assetId))) continue;
    for (const [outgoing, incoming, role] of [[selected, other, 'outgoing'], [other, selected, 'incoming']] as const) {
      const overlap = timelineCrossfadeOverlap(outgoing, incoming);
      if (!overlap) continue;
      const blocked: CrossfadeBlock | null = outgoing.volumeEnvelope != null || incoming.volumeEnvelope != null ? 'envelope'
        : lockedTrackIds.has(outgoing.trackId) || lockedTrackIds.has(incoming.trackId) ? 'locked' : null;
      rows.push({ outgoingClipId: outgoing.id, incomingClipId: incoming.id, partnerClipId: other.id, partnerName: other.name || byId.get(other.assetId)?.name || '',
        role, startFrame: overlap.startFrame, durationFrames: overlap.durationFrames, blocked });
    }
  }
  return rows.sort((a, b) => a.startFrame - b.startFrame || a.partnerClipId.localeCompare(b.partnerClipId)).slice(0, CROSSFADE_CANDIDATE_LIMIT);
}
