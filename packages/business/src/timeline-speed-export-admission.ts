import {AppError} from '../../contracts/src/app-error.ts';
import {sourceFrameCount} from '../../contracts/src/source-range.ts';
import {timelineExportRangeFields} from '../../contracts/src/timeline-export-range.ts';
import {
  compileTimelineSpeedExportClips, INTERPOLATION_UNAVAILABLE, SPEED_BUDGET_EXCEEDED, SPEED_CAPABILITY_UNAVAILABLE,
  UNSUPPORTED_INTERPOLATION_FORMAT,
  TIMELINE_SPEED_EXPORT_MESSAGES, type CompiledTimelineSpeedExportClip,
  type TimelineSpeedExportPhase, type TimelineSpeedExportSnapshot,
} from '../../contracts/src/timeline-speed-export.ts';
import {compileInterpolationPhase, INTERPOLATION_PHASE_PROFILE} from '../../contracts/src/timeline-interpolation.ts';
import {timeMapHasSlowMotion} from '../../contracts/src/timeline-time-map.ts';
import {timelineSpeedAudioMode} from './timeline-speed-export-audio.ts';
import {assertSpeedExportVideoCapability, inspectSpeedVideoInterpolation} from './timeline-speed-export-video.ts';
import {checkMediaEffect, run} from './media-runtime.ts';
import {planTimelineExportRange, type TimelineExportRangePlan} from './timeline-export-range-plan.ts';
import {MAX_PRIVATE_TIMELINE_STAGING_FILES} from './timeline-float-staging.ts';
import {timelineTransitionRegions, transitionPictureRange, transitionPlanSnapshot} from './timeline-transition-filter.ts';
import {speedPictureWindows, speedTransitionHandle, type SpeedPictureWindow} from './timeline-speed-export-plan.ts';
import type {TimelineClipRecord, TimelineRecord} from './timeline-inputs.ts';

interface SpeedAsset {
  readonly mimeType: string;
  readonly duration?: unknown;
  readonly hasAudio?: boolean | null;
}

export interface SpeedExportSnapshotContext {
  readonly timeline: TimelineRecord;
  readonly exportRange?: unknown;
  readonly colourPlan?: unknown;
  readonly speedExport?: TimelineSpeedExportSnapshot;
}

interface ActiveClip extends CompiledTimelineSpeedExportClip {
  readonly video: readonly SpeedPictureWindow[];
  readonly audio: boolean;
  readonly clip: TimelineClipRecord;
  readonly interpolation?: {
    readonly mode: 'blend' | 'optical';
    readonly phase: TimelineSpeedExportPhase;
    readonly windows: readonly SpeedPictureWindow[];
  };
}

export interface SpeedExportLayout {
  readonly clips: readonly ActiveClip[];
  readonly segments: TimelineExportRangePlan;
  readonly transitions: ReturnType<typeof timelineTransitionRegions>;
}

function unavailablePhase(clipId: string): AppError {
  return new AppError(INTERPOLATION_UNAVAILABLE, TIMELINE_SPEED_EXPORT_MESSAGES[INTERPOLATION_UNAVAILABLE], 409, {clipId});
}

function interpolationFor(item: CompiledTimelineSpeedExportClip, video: readonly SpeedPictureWindow[]): ActiveClip['interpolation'] {
  if (item.timing.profile !== 'timeline-speed-v1' || item.timing.interpolation === 'off') return;
  const windows: SpeedPictureWindow[] = [];
  let maxPhaseErrorFrames = 0;
  for (const window of video) {
    const slow = timeMapHasSlowMotion(window.plan);
    if (!slow.ok) throw unavailablePhase(item.clipId);
    if (!slow.value) continue;
    const phase = compileInterpolationPhase(window.fullPlan);
    if (!phase.ok) throw unavailablePhase(item.clipId);
    const offset = window.plan.outputWindow.fromFrame - window.fullPlan.outputWindow.fromFrame;
    const used = phase.value.frames.slice(offset, offset + window.plan.durationFrames);
    if (!used.some(frame => frame.active)) continue;
    if (!phase.value.available) throw unavailablePhase(item.clipId);
    maxPhaseErrorFrames = Math.max(maxPhaseErrorFrames, phase.value.maxPhaseErrorFrames);
    windows.push(window);
  }
  if (windows.length) return {mode: item.timing.interpolation, phase: {profile: INTERPOLATION_PHASE_PROFILE, maxPhaseErrorFrames}, windows};
}

export function timelineSpeedExportLayout(snapshot: SpeedExportSnapshotContext,
  assets: ReadonlyMap<string, SpeedAsset>): SpeedExportLayout | null {
  if (!snapshot.speedExport) return null;
  const {timeline} = snapshot;
  const compiled = compileTimelineSpeedExportClips(timeline);
  const byId = new Map(compiled.map(clip => [clip.clipId, clip]));
  const transitions = timelineTransitionRegions(timeline, assets, (clip, side, frames, source) => {
    const timed = byId.get(clip.id);
    if (timed) {
      speedTransitionHandle({...clip, timing: timed.timing}, timed.plan, side, frames, source.frames);
      return true;
    }
    return source.image || (side === 'before' ? clip.sourceInFrame >= frames
      : clip.sourceInFrame + clip.durationFrames + frames <= source.frames);
  });
  const plan = planTimelineExportRange(transitionPlanSnapshot({timeline, ...timelineExportRangeFields(snapshot)}, transitions));
  const tracks = new Map(timeline.tracks.map(track => [track.id, track]));
  const clipsById = new Map(timeline.clips.map(clip => [clip.id, clip]));
  const beginFrame = plan.segments[0]?.beginFrame ?? 0;
  const endFrame = plan.segments.at(-1)?.endFrame ?? 0;
  const used = {start: beginFrame, end: endFrame};
  const clips: ActiveClip[] = [];
  for (const item of compiled) {
    const clip = clipsById.get(item.clipId)!;
    const track = tracks.get(clip.trackId);
    const asset = assets.get(item.assetId);
    const visual = track?.kind === 'video' && !track.hidden;
    const audio = Boolean(track && !track.muted && clip.muted !== true && clip.gain > 0 && asset?.hasAudio !== false &&
      item.timing.profile !== 'timeline-freeze-v1' && clip.startFrame < used.end &&
      clip.startFrame + clip.durationFrames > used.start);
    const video = visual ? speedPictureWindows({...clip, timing: item.timing}, item.plan,
      transitionPictureRange(clip, transitions), used, sourceFrameCount(asset?.duration) ?? 0) : [];
    if (audio || video.length > 0) {
      const interpolation = interpolationFor(item, video);
      clips.push({...item, clip, video, audio, ...(interpolation && {interpolation})});
    }
  }
  const distinctCues = new Set(timeline.subtitles?.cues.map(cue => cue.text)).size;
  const subtitleFiles = distinctCues ? distinctCues + 2 : 0; // Font and ink-measurement script.
  const segmentFiles = plan.segments.length * (distinctCues || snapshot.colourPlan ? 2 : 1);
  const speedFiles = clips.reduce((sum, clip) => sum + clip.video.length * 2 + Number(clip.audio), 0);
  if (subtitleFiles + segmentFiles + speedFiles + 1 > MAX_PRIVATE_TIMELINE_STAGING_FILES) {
    throw new AppError(SPEED_BUDGET_EXCEEDED, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_BUDGET_EXCEEDED], 409);
  }
  return {clips, segments: plan, transitions};
}

export function assertFrozenInterpolationPhase(snapshot: SpeedExportSnapshotContext, layout: SpeedExportLayout): void {
  for (const {clipId, interpolation} of layout.clips) {
    if (!interpolation) continue;
    const frozen = snapshot.speedExport?.clips.find(clip => clip.clipId === clipId)?.interpolationPhase;
    if (frozen?.profile !== interpolation.phase.profile || frozen.maxPhaseErrorFrames !== interpolation.phase.maxPhaseErrorFrames)
      throw unavailablePhase(clipId);
  }
}

interface SpeedCapabilityOptions {
  readonly signal?: AbortSignal;
  readonly beforeEffect?: () => void;
  readonly sources?: ReadonlyMap<string, {readonly path?: string; readonly videoStreamIndex?: string | number | null}>;
}

/** Exercise the selected media tool before any final output write. The source
 * profile's exact format and decoder are checked again during staging. */
export async function assertTimelineSpeedCapability(layout: SpeedExportLayout, {signal, beforeEffect, sources}: SpeedCapabilityOptions = {}): Promise<void> {
  const visual = layout.clips.some(clip => clip.video.length);
  const audio = layout.clips.some(clip => clip.audio);
  const blend = layout.clips.some(clip => clip.interpolation?.mode === 'blend');
  const optical = layout.clips.some(clip => clip.interpolation?.mode === 'optical');
  if (visual) await assertSpeedExportVideoCapability({signal, beforeEffect, interpolation: blend ? 'blend' : optical ? 'optical' : undefined});
  if (blend && optical) await assertSpeedExportVideoCapability({signal, beforeEffect, interpolation: 'optical'});
  if (sources) for (const {clipId, assetId, interpolation} of layout.clips) {
    if (!interpolation) continue;
    const source = sources.get(assetId);
    if (!source?.path) throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '无法读取变速片段的源素材。', 409, {clipId});
    for (const {fullPlan} of interpolation.windows) {
      try {
        await inspectSpeedVideoInterpolation({source: {path: source.path, videoStreamIndex: source.videoStreamIndex},
          plan: fullPlan, signal, beforeEffect});
      } catch (error) {
        if (error instanceof AppError && (error.code === INTERPOLATION_UNAVAILABLE || error.code === UNSUPPORTED_INTERPOLATION_FORMAT)) {
          throw new AppError(error.code, TIMELINE_SPEED_EXPORT_MESSAGES[error.code], 409, {clipId});
        }
        throw error;
      }
    }
  }
  if (!audio) return;
  const audible = layout.clips.filter(clip => clip.audio);
  const tempo = audible.some(clip => timelineSpeedAudioMode(clip.timing) === 'preserve') ? 'atempo=2,atempo=1.5,' : '';
  try {
    await run('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-filter_threads', '1',
      '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=0.5', '-af',
      `asettb=1/48000,asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=flt:channel_layouts=stereo,${tempo}apad,atrim=end_sample=12000,asetpts=N/SR/TB`,
      '-c:a', 'pcm_f32le', '-f', 'null', '-'], {signal, beforeEffect, timeout: 15_000,
      maxStdoutBytes: 32 * 1024, maxStderrBytes: 32 * 1024});
  } catch (error) {
    checkMediaEffect(beforeEffect, signal);
    const failure = error as {code?: string; terminationUnconfirmed?: boolean};
    if (failure.terminationUnconfirmed || !failure.code?.startsWith('MEDIA_') || failure.code === 'MEDIA_CANCELLED') throw error;
    throw new AppError(SPEED_CAPABILITY_UNAVAILABLE, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_CAPABILITY_UNAVAILABLE], 409);
  }
  checkMediaEffect(beforeEffect, signal);
}
