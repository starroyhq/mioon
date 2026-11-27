import {AppError} from '../../contracts/src/app-error.ts';
import {freezeSourceSha256} from './format6-source-proof.ts';
import {
  FORMAT5_LIMITS, type Format5Anchor, type Format5Clip, type Format5Timeline,
} from '../../contracts/src/project-format5.ts';
import type {SequenceEditAllocation} from '../../contracts/src/sequence-edit.ts';
import {sourceFrameCount} from '../../contracts/src/source-range.ts';
import {clipSourceEndFrame, compileClipTimeMap} from '../../contracts/src/timeline-clip-timing.ts';
import {
  clipTransformAt, clipTransformFieldsAfterEdit, splitClipTransformFields, type ClipTransform, type ClipTransformClip,
} from '../../contracts/src/timeline-clip-transform.ts';
import type {ClipTiming, SequenceEditSpeedIntent, SpeedSetting} from '../../contracts/src/timeline-speed.ts';
import {
  compileTimeMap, initialTimeMap, projectTimeMapToCurrentClipFields, reverseTimeMap, splitTimeMap,
  timeMapBasisFromCurrentClip, timeMapHasSlowMotion, timeMapPlanInfo, timeMapSettingEquals,
  timeMapSourceAtOutputFrame, timeMapSourceRangeForEdit, trimTimeMap, type CompiledTimeMap, type TimeMapResult,
} from '../../contracts/src/timeline-time-map.ts';
import {splitEditingVolumeEnvelopeFields} from '../../contracts/src/timeline-volume-envelope-editing.ts';
import type {VolumeEnvelopeClip} from '../../contracts/src/timeline-volume-envelope.ts';

type SpeedTiming = Extract<ClipTiming, {profile: 'timeline-speed-v1'}>;
type SourceAsset = Parameters<typeof freezeSourceSha256>[0] & {readonly duration?: unknown};
type SourceReader = (id: string) => SourceAsset | undefined;

function invalid(code: string, id: string, message: string): never {
  throw new AppError(code, message, 409, {ids: [id]});
}

function mapped<T>(result: TimeMapResult<T>, id: string): T {
  if (!result.ok) invalid(result.code, id, result.detail);
  return result.value;
}

function timingFields(clip: Format5Clip, plan: CompiledTimeMap,
  timing: ClipTiming): Pick<Format5Clip, 'timing' | 'sourceSpanFrames' | 'sourceInFrame' | 'durationFrames'> {
  const fields = mapped(projectTimeMapToCurrentClipFields(clip, plan), clip.id);
  if (timing.profile === 'timeline-freeze-v1') {
    return {timing, sourceSpanFrames: fields.sourceSpanFrames, sourceInFrame: fields.sourceInFrame, durationFrames: fields.durationFrames};
  }
  const {loTime, hiTime, direction} = mapped(timeMapPlanInfo(plan), clip.id);
  return {timing: {...timing, view: {loTime, hiTime, direction}, outputWindow: plan.outputWindow},
    sourceSpanFrames: fields.sourceSpanFrames, sourceInFrame: fields.sourceInFrame, durationFrames: fields.durationFrames};
}

function resizeEffects(clip: Format5Clip, durationFrames: number): Format5Clip {
  if (durationFrames === clip.durationFrames) return clip;
  const next = {...clip, durationFrames};
  if (clip.transform !== undefined) {
    Object.assign(next, clipTransformFieldsAfterEdit(clip as ClipTransformClip, {durationFrames}, FORMAT5_LIMITS.durationFrames));
  }
  if (clip.volumeEnvelope !== undefined && durationFrames < clip.durationFrames) {
    const [left] = splitEditingVolumeEnvelopeFields(clip as VolumeEnvelopeClip, durationFrames, FORMAT5_LIMITS.durationFrames);
    Object.assign(next, left);
  }
  if (clip.fadeInFrames !== undefined) next.fadeInFrames = Math.min(clip.fadeInFrames, durationFrames);
  if (clip.fadeOutFrames !== undefined) next.fadeOutFrames = Math.min(clip.fadeOutFrames, durationFrames - (next.fadeInFrames ?? 0));
  return next;
}

export function trimTimedSequenceClip(clip: Format5Clip, timeline: Format5Timeline, durationFrames: number): Format5Clip {
  if (!clip.timing) return resizeEffects(clip, durationFrames);
  if (clip.timing.profile === 'timeline-freeze-v1') return resizeEffects(clip, durationFrames);
  const plan = mapped(compileClipTimeMap(clip, timeline), clip.id);
  const trimmed = mapped(trimTimeMap(plan, 0, durationFrames), clip.id);
  return {...resizeEffects(clip, durationFrames), ...timingFields(clip, trimmed, clip.timing)};
}

export function splitSequenceClip(clip: Format5Clip, timeline: Format5Timeline,
  offset: number, rightId: string, rightSourceInFrame = clip.sourceInFrame + offset): [Format5Clip, Format5Clip] {
  const [leftTransform, rightTransform] = clip.transform === undefined ? [{}, {}]
    : splitClipTransformFields(clip as ClipTransformClip, offset, FORMAT5_LIMITS.durationFrames);
  const [leftVolume, rightVolume] = clip.volumeEnvelope === undefined ? [{}, {}]
    : splitEditingVolumeEnvelopeFields(clip as VolumeEnvelopeClip, offset, FORMAT5_LIMITS.durationFrames);
  const {transitionIn: _incoming, ...rightFields} = clip;
  let left = {...clip, durationFrames: offset, ...leftTransform, ...leftVolume};
  let right = {...rightFields, id: rightId, startFrame: clip.startFrame + offset,
    durationFrames: clip.durationFrames - offset, sourceInFrame: rightSourceInFrame, ...rightTransform, ...rightVolume};
  if (clip.fadeInFrames !== undefined) {
    left.fadeInFrames = Math.min(clip.fadeInFrames, offset);
    right.fadeInFrames = Math.max(0, clip.fadeInFrames - offset);
  }
  if (clip.fadeOutFrames !== undefined) {
    left.fadeOutFrames = Math.max(0, clip.fadeOutFrames - right.durationFrames);
    right.fadeOutFrames = Math.min(clip.fadeOutFrames, right.durationFrames);
  }
  if (clip.timing) {
    const plan = mapped(compileClipTimeMap(clip, timeline), clip.id);
    const parts = mapped(splitTimeMap(plan, offset), clip.id);
    left = {...left, ...timingFields(left, parts.left, clip.timing)};
    right = {...right, ...timingFields(right, parts.right, clip.timing)};
  }
  return [left, right];
}

function setClipSpeed(clip: Format5Clip, timeline: Format5Timeline, setting: SpeedSetting): Format5Clip {
  if (clip.timing?.profile === 'timeline-freeze-v1') invalid('SPEED_NOT_SUPPORTED', clip.id, '定格片段只能修改时长。');
  const existing = clip.timing;
  const basis = existing?.basis ?? mapped(timeMapBasisFromCurrentClip(clip, timeline), clip.id);
  const requestedBasis = {...basis, speed: setting.speed};
  const changedRate = !timeMapSettingEquals(basis, requestedBasis);
  let plan = mapped(compileClipTimeMap(clip, timeline), clip.id);
  if (changedRate) {
    const sourceRange = mapped(timeMapSourceRangeForEdit(plan), clip.id);
    const root = mapped(compileTimeMap({...requestedBasis, sourceRange}), clip.id);
    plan = initialTimeMap(root, setting.direction);
    requestedBasis.sourceRange = sourceRange;
  } else if (setting.direction !== plan.direction) {
    plan = reverseTimeMap(plan);
  }
  const interpolation = mapped(timeMapHasSlowMotion(plan), clip.id) ? setting.interpolation : 'off';
  if (!changedRate && setting.direction === (existing?.view.direction ?? 'forward')
      && setting.pitchShift === (existing?.pitchShift ?? false) && interpolation === (existing?.interpolation ?? 'off')) {
    return clip;
  }
  const timing: SpeedTiming = {
    profile: 'timeline-speed-v1', basis: changedRate ? requestedBasis : basis,
    view: {loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}, direction: plan.direction},
    outputWindow: plan.outputWindow, pitchShift: setting.pitchShift, interpolation,
  };
  return {...resizeEffects(clip, plan.durationFrames), ...timingFields(clip, plan, timing)};
}

function freezeClip(clip: Format5Clip, timeline: Format5Timeline,
  operation: Extract<SequenceEditSpeedIntent['operation'], {kind: 'freeze-frame'}>,
  asset: SourceAsset, allocation: SequenceEditAllocation): Format5Clip[] {
  const offset = operation.atFrame - clip.startFrame;
  const durationFrames = operation.durationFrames ?? 2 * timeline.fps;
  if (offset < 0 || offset >= clip.durationFrames) invalid('INVALID_WINDOW', clip.id, '定格位置不在片段内。');
  if (durationFrames > FORMAT5_LIMITS.durationFrames) invalid('OUTPUT_FRAME_LIMIT', clip.id, '定格超过输出帧上限。');
  const freezeId = allocation.clips.find(item => item.nodeId === (clip.sequenceSource?.nodeId ?? clip.id))?.clipId;
  const rightId = allocation.splitClips.find(item => item.clipId === clip.id)?.rightClipId;
  const occupied = new Set(timeline.clips.map(item => item.id));
  if (!freezeId || occupied.has(freezeId) || (offset > 0 && (!rightId || rightId === freezeId || occupied.has(rightId)))) {
    invalid('SEQUENCE_EDIT_CONTRACT_INVALID', clip.id, '定格片段分配无效。');
  }
  const plan = mapped(compileClipTimeMap(clip, timeline), clip.id);
  const {sourceFrame} = mapped(timeMapSourceAtOutputFrame(plan, offset), clip.id);
  const sourceSha256 = freezeSourceSha256(asset);
  if (!sourceSha256) {
    invalid('SPEED_SOURCE_NOT_READY', clip.id, '没有可锁定的源素材指纹。');
  }
  const {transitionIn, fadeInFrames: _fadeIn, fadeOutFrames: _fadeOut,
    volumeEnvelope: _volume, audioRole: _role, ...visual} = clip;
  const freeze: Format5Clip = {...visual, id: freezeId, startFrame: operation.atFrame, durationFrames,
    sourceInFrame: sourceFrame, sourceSpanFrames: 1, muted: true,
    timing: {profile: 'timeline-freeze-v1', sourceFrame, sourceVersionId: clip.versionId ?? null, sourceSha256}};
  if (freeze.sequenceSource?.kind === 'shot') freeze.sequenceSource = {...freeze.sequenceSource, versionMode: 'locked'};
  if (clip.transform) {
    const transform = clip.transform as ClipTransform;
    freeze.transform = {...transform, keyframes: [{frame: 0,
      ...clipTransformAt(clip as ClipTransformClip, offset, FORMAT5_LIMITS.durationFrames)}]};
  }
  if (offset === 0) {
    const {transitionIn: _incoming, ...right} = clip;
    return [{...freeze, ...(transitionIn ? {transitionIn} : {})},
      {...right, startFrame: clip.startFrame + durationFrames}];
  }
  const [left, right] = splitSequenceClip(clip, timeline, offset, rightId!);
  return [left, freeze, {...right, startFrame: right.startFrame + durationFrames}];
}

/** Project the speed edit onto the packed lane and carry clip/cue anchors in
 * output frames. The caller validates overlap and commits the shared delta. */
export function planSpeedTimeline(timeline: Format5Timeline, operation: SequenceEditSpeedIntent['operation'],
  readAsset: SourceReader, allocation: SequenceEditAllocation): {timeline: Format5Timeline; durationFrames: number} {
  const clip = timeline.clips.find(item => item.id === operation.clipId);
  if (!clip) invalid('CLIP_NOT_FOUND', operation.clipId, '片段不存在。');
  const asset = clip.assetId ? readAsset(clip.assetId) : undefined;
  if (!asset || clip.sourceState !== 'ready') invalid('SPEED_SOURCE_NOT_READY', clip.id, '片段素材尚未就绪。');
  const video = typeof asset.mimeType === 'string' && asset.mimeType.startsWith('video/');
  const audio = typeof asset.mimeType === 'string' && asset.mimeType.startsWith('audio/');
  const track = timeline.tracks.find(item => item.id === clip.trackId);
  if ((!video && !audio) || (operation.kind === 'freeze-frame' && (!video || track?.kind !== 'video'))) {
    invalid('SPEED_NOT_SUPPORTED', clip.id, '该片段不支持此变速操作。');
  }
  const sourceFrames = sourceFrameCount(asset.duration, timeline.fps);
  if (sourceFrames === null || sourceFrames < clipSourceEndFrame(clip)) {
    invalid('SPEED_SOURCE_NOT_READY', clip.id, '片段素材尚未就绪。');
  }
  const main = clip.trackId === timeline.mainTrack.trackId;
  let parts = operation.kind === 'clip-speed' ? [setClipSpeed(clip, timeline, operation.setting)]
    : freezeClip(clip, timeline, operation, asset, allocation);
  if (parts[0] === clip) invalid('SEQUENCE_EDIT_NOOP', clip.id, '片段已经是这些变速设置。');
  if (parts.some(part => clipSourceEndFrame(part) > sourceFrames)) {
    invalid('SPEED_SOURCE_NOT_READY', clip.id, '素材没有足够的源帧。');
  }
  if (!main && operation.kind === 'freeze-frame' && clip.anchor) {
    const ownerId = clip.anchor.clipId;
    const owner = timeline.clips.find(item => item.id === ownerId && item.trackId === timeline.mainTrack.trackId);
    if (owner) {
      // A split piece keeps its original host only while its new start is
      // inside that host. Auxiliary edits never move any main-track row.
      parts = parts.map(part => {
        const offsetFrames = part.startFrame - owner.startFrame;
        return {...part, anchor: offsetFrames >= 0 && offsetFrames < owner.durationFrames
          ? {clipId: owner.id, offsetFrames} : null};
      });
    }
  }
  const originalEnd = clip.startFrame + clip.durationFrames;
  const newEnd = parts.at(-1)!.startFrame + parts.at(-1)!.durationFrames;
  const shift = newEnd - originalEnd;
  const replacement = timeline.clips.flatMap(item => {
    if (clip.id === item.id) return parts;
    return main && shift !== 0 && item.trackId === clip.trackId && item.startFrame >= originalEnd
      ? [{...item, startFrame: item.startFrame + shift}] : [item];
  });
  const owners = new Map(replacement.filter(item => item.trackId === timeline.mainTrack.trackId).map(item => [item.id, item]));
  const updateAnchor = <T extends {startFrame: number; anchor?: Format5Anchor}>(item: T): T => {
    const anchor = item.anchor;
    if (!main || !anchor) return item;
    let owner = owners.get(anchor.clipId);
    let offsetFrames = anchor.offsetFrames;
    if (anchor.clipId === clip.id && operation.kind === 'freeze-frame') {
      const cut = operation.atFrame - clip.startFrame;
      if (offsetFrames >= cut) {
        owner = parts.at(-1);
        offsetFrames -= cut;
      }
    }
    if (!owner || offsetFrames >= owner.durationFrames) return {...item, anchor: null};
    const startFrame = owner.startFrame + offsetFrames;
    return startFrame === item.startFrame && owner.id === anchor.clipId && offsetFrames === anchor.offsetFrames
      ? item : {...item, startFrame, anchor: {clipId: owner.id, offsetFrames}};
  };
  const clips = replacement.map(updateAnchor);
  const durationFrames = clips.reduce((maximum, item) => Math.max(maximum, item.startFrame + item.durationFrames), 0);
  if (durationFrames > FORMAT5_LIMITS.durationFrames) invalid('OUTPUT_FRAME_LIMIT', clip.id, '时间线超过输出帧上限。');
  const cues = timeline.subtitles?.cues.map(updateAnchor);
  return {timeline: {...timeline, clips, durationFrames, ...(timeline.subtitles && cues
    ? {subtitles: {...timeline.subtitles, cues}} : {})},
    durationFrames: operation.kind === 'clip-speed' ? parts[0]!.durationFrames : operation.durationFrames ?? 2 * timeline.fps};
}
