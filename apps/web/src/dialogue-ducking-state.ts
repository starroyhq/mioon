import { VOLUME_ENVELOPE_LIMITS, VOLUME_ENVELOPE_PROFILE, validateVolumeEnvelope } from '../../../packages/contracts/src/timeline-volume-envelope.ts';
import type { RawVolumeEnvelope } from './clip-volume-envelope-state.ts';

// Dialogue-driven ducking candidates. Analysis reads only the dialogue clips'
// saved source peaks (asset.waveform.get); the result is a replacement curve
// for the background clip's draft, which the ordinary Save and Undo apply.
export const DIALOGUE_DUCKING_CHOICES = Object.freeze({
  thresholdDb: [-45, -40, -35, -30, -25],
  paddingFrames: [0, 3, 6, 10, 15],
  multiplier: [0.1, 0.2, 0.3, 0.5],
  attackFrames: [3, 6, 10, 15, 30],
  releaseFrames: [6, 10, 15, 30, 45],
} as const);
export interface DialogueDuckingParameters { thresholdDb: number; paddingFrames: number; multiplier: number; attackFrames: number; releaseFrames: number }
export const DEFAULT_DIALOGUE_DUCKING: Readonly<DialogueDuckingParameters> = Object.freeze({ thresholdDb: -35, paddingFrames: 6, multiplier: 0.3, attackFrames: 6, releaseFrames: 15 });
/** Each ducked region needs up to four points of the 16-point profile. */
export const DIALOGUE_DUCKING_REGION_LIMIT = Math.floor(VOLUME_ENVELOPE_LIMITS.points / 4);
/** The finest useful read: one peak per editing frame, within the read limit. */
export const DIALOGUE_DUCKING_POINTS = 2048;

export interface DuckingClip { id: string; trackId: string; assetId: string; startFrame: number; durationFrames: number; sourceInFrame?: number; audioRole?: unknown }
export interface DuckingTrack { id: string; kind?: string; name?: string }
/** A waveform read of one dialogue clip, over the part that overlaps the background clip. */
export interface DialogueWaveformRead { clipId: string; sourceStartFrame: number; sourceEndFrame: number; peaks: readonly (number | null)[] }
export interface DialogueWaveformRequest { clipId: string; assetId: string; sourceStartFrame: number; sourceEndFrame: number; points: number }
export interface DuckingRegion { attackStart: number; lowStart: number; lowEnd: number; releaseEnd: number }
export interface DialogueDuckingCandidate {
  envelope: RawVolumeEnvelope | null;
  regions: DuckingRegion[];
  /** Speech intervals found before padding and merging. */
  speechCount: number;
  /** Gaps filled to stay within the region limit. */
  bridged: number;
  /** Frames with no decoded coverage, treated as silence. */
  missingFrames: number;
}

const end = (clip: { startFrame: number; durationFrames: number }) => clip.startFrame + clip.durationFrames;

/** Other tracks with clips under the background clip, preferring one whose
 * clips are marked as human voice. */
export function dialogueTrackChoices(background: DuckingClip, clips: readonly DuckingClip[], tracks: readonly DuckingTrack[]): { tracks: DuckingTrack[]; preferred: string | null } {
  const under = clips.filter(clip => clip.trackId !== background.trackId && clip.startFrame < end(background) && background.startFrame < end(clip));
  const ids = new Set(under.map(clip => clip.trackId));
  const choices = tracks.filter(track => ids.has(track.id));
  const voiced = choices.find(track => under.some(clip => clip.trackId === track.id && clip.audioRole === 'human'));
  return { tracks: choices, preferred: (voiced ?? choices[0])?.id ?? null };
}

/** One waveform read per dialogue clip on the chosen track, limited to the
 * part under the background clip, at up to one peak per frame. */
export function dialogueWaveformRequests(background: DuckingClip, clips: readonly DuckingClip[], dialogueTrackId: string): DialogueWaveformRequest[] {
  return clips.filter(clip => clip.trackId === dialogueTrackId && clip.startFrame < end(background) && background.startFrame < end(clip)).map(clip => {
    const from = Math.max(clip.startFrame, background.startFrame), to = Math.min(end(clip), end(background)), sourceIn = clip.sourceInFrame ?? 0;
    const sourceStartFrame = sourceIn + from - clip.startFrame, sourceEndFrame = sourceIn + to - clip.startFrame;
    return { clipId: clip.id, assetId: clip.assetId, sourceStartFrame, sourceEndFrame, points: Math.min(DIALOGUE_DUCKING_POINTS, sourceEndFrame - sourceStartFrame) };
  });
}

/** Timeline intervals [start, end) where one dialogue clip's peaks reach the
 * threshold. Peaks are spread evenly over the read source range. */
export function dialogueActivity(clip: DuckingClip, read: DialogueWaveformRead, thresholdDb: number): { intervals: [number, number][]; missingFrames: number } {
  const count = read.peaks.length, span = read.sourceEndFrame - read.sourceStartFrame;
  if (!count || span <= 0) return { intervals: [], missingFrames: 0 };
  const threshold = 10 ** (thresholdDb / 20), binFrames = span / count, offset = clip.startFrame - (clip.sourceInFrame ?? 0);
  const intervals: [number, number][] = [];
  let missing = 0;
  for (let index = 0; index < count; index++) {
    const peak = read.peaks[index];
    if (peak === null) { missing += binFrames; continue; }
    if (peak < threshold) continue;
    const from = Math.max(clip.startFrame, Math.floor(offset + read.sourceStartFrame + index * binFrames));
    const to = Math.min(end(clip), Math.ceil(offset + read.sourceStartFrame + (index + 1) * binFrames));
    if (from >= to) continue;
    const last = intervals.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to); else intervals.push([from, to]);
  }
  return { intervals, missingFrames: Math.round(missing) };
}

/** Ducked regions in the background clip's local frames. Speech is padded,
 * ramps sit outside it, regions whose ramps touch merge, and beyond the limit
 * the shortest gaps are bridged. */
export function dialogueDuckingRegions(speech: readonly [number, number][], background: { startFrame: number; durationFrames: number },
  parameters: DialogueDuckingParameters): { regions: DuckingRegion[]; bridged: number } {
  const duration = background.durationFrames;
  const regions: DuckingRegion[] = [...speech].sort((a, b) => a[0] - b[0]).flatMap(([from, to]): DuckingRegion[] => {
    const start = Math.max(0, from - background.startFrame), stop = Math.min(duration, to - background.startFrame);
    if (start >= stop) return [];
    const lowStart = Math.max(0, start - parameters.paddingFrames), lowEnd = Math.min(duration, stop + parameters.paddingFrames);
    return [{ attackStart: Math.max(0, lowStart - parameters.attackFrames), lowStart, lowEnd, releaseEnd: Math.min(duration, lowEnd + parameters.releaseFrames) }];
  });
  const merged: DuckingRegion[] = [];
  for (const region of regions) {
    const last = merged.at(-1);
    if (last && region.attackStart <= last.releaseEnd) { last.lowEnd = Math.max(last.lowEnd, region.lowEnd); last.releaseEnd = Math.max(last.releaseEnd, region.releaseEnd); }
    else merged.push({ ...region });
  }
  let bridged = 0;
  while (merged.length > DIALOGUE_DUCKING_REGION_LIMIT) {
    let shortest = 0;
    for (let index = 1; index < merged.length - 1; index++)
      if (merged[index + 1].attackStart - merged[index].releaseEnd < merged[shortest + 1].attackStart - merged[shortest].releaseEnd) shortest = index;
    const [left, right] = merged.splice(shortest, 2);
    merged.splice(shortest, 0, { attackStart: left.attackStart, lowStart: left.lowStart, lowEnd: right.lowEnd, releaseEnd: right.releaseEnd });
    bridged++;
  }
  return { regions: merged, bridged };
}

/** The replacement curve: full volume outside the regions, the multiplier
 * inside, linear ramps between. Null when there is nothing to duck. */
export function dialogueDuckingEnvelope(regions: readonly DuckingRegion[], durationFrames: number, multiplier: number): RawVolumeEnvelope | null {
  if (!regions.length) return null;
  const points: { frame: number; multiplier: number }[] = [];
  for (const region of regions) {
    if (region.attackStart < region.lowStart) points.push({ frame: region.attackStart, multiplier: 1 });
    points.push({ frame: region.lowStart, multiplier }, { frame: region.lowEnd, multiplier });
    if (region.releaseEnd > region.lowEnd) points.push({ frame: region.releaseEnd, multiplier: 1 });
  }
  const value = validateVolumeEnvelope({ profileId: VOLUME_ENVELOPE_PROFILE, points }, durationFrames);
  return value && { profileId: VOLUME_ENVELOPE_PROFILE, points: value.points.map(point => ({ frame: String(point.frame), multiplier: String(point.multiplier) })) };
}

/** The complete candidate from the dialogue clips' reads. */
export function dialogueDuckingCandidate(background: DuckingClip, dialogueClips: readonly DuckingClip[], reads: readonly DialogueWaveformRead[],
  parameters: DialogueDuckingParameters): DialogueDuckingCandidate {
  let missingFrames = 0;
  const speech: [number, number][] = [];
  for (const read of reads) {
    const clip = dialogueClips.find(item => item.id === read.clipId);
    if (!clip) continue;
    const activity = dialogueActivity(clip, read, parameters.thresholdDb);
    speech.push(...activity.intervals);
    missingFrames += activity.missingFrames;
  }
  const { regions, bridged } = dialogueDuckingRegions(speech, background, parameters);
  return { envelope: dialogueDuckingEnvelope(regions, background.durationFrames, parameters.multiplier), regions, speechCount: speech.length, bridged, missingFrames };
}
