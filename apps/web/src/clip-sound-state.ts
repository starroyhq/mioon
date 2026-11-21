/** Format-5 «clip sound» entry rules and menu plan.
 *
 * The same predicates drive the timeline clip context menu, the inspector audio
 * group and the timeline mute mark, so a silent video, image, placeholder or
 * audio-track clip never offers sound actions and a muted clip always shows its
 * mark. Presentation only: the service re-validates every action.
 */
import type {AppTimelineClip, AppTimelineTrack} from './App.tsx';

export interface ClipSoundEntryInput {
  readonly format5: boolean;
  readonly clip: Pick<AppTimelineClip, 'assetId' | 'trackId' | 'muted' | 'sourceState'> & {soundOnly?: boolean;
    sequenceSource?: unknown};
  readonly asset: {mimeType?: string; hasAudio?: boolean} | null | undefined;
  readonly track?: Pick<AppTimelineTrack, 'kind'> | null;
}

/** «Separate sound / mute / save as audio» are offered only for a ready video
 * clip with an actual audio stream on a picture track. */
export function clipSoundEntriesVisible({format5, clip, asset, track}: ClipSoundEntryInput): boolean {
  if (!format5) return false;
  if (clip.soundOnly === true) return false;
  if (clip.sourceState !== 'ready') return false;
  if (!track || track.kind !== 'video') return false;
  if (!asset || typeof asset.mimeType !== 'string' || !asset.mimeType.startsWith('video/')) return false;
  return asset.hasAudio === true;
}

/** «Save as audio asset» additionally needs a resolvable source asset. */
export function clipSaveAudioVisible(input: ClipSoundEntryInput): boolean {
  return clipSoundEntriesVisible(input) && typeof input.clip.assetId === 'string';
}

export interface ClipContextMenuPlan {
  readonly sound: boolean;
  readonly saveAudio: boolean;
  readonly muteLabelKey: 'clipSound.mute' | 'clipSound.unmute';
}

export function clipContextMenuPlan(input: ClipSoundEntryInput): ClipContextMenuPlan {
  const sound = clipSoundEntriesVisible(input);
  return {sound, saveAudio: sound && clipSaveAudioVisible(input),
    muteLabelKey: input.clip.muted === true ? 'clipSound.unmute' : 'clipSound.mute'};
}
