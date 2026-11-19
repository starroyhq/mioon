/** FR-A: format-5 clip properties as one shared `sequence-edit` action.
 *
 * The user edits one or more clips (transform, transition, gain, fades, colour,
 * audio role, volume envelope, name). Nothing here changes timeline structure:
 * frames, tracks, anchors and chain order stay as they are. The resulting
 * before/after clip rows travel in the ordinary timeline patch, so undo/redo use
 * the same history-13 entry and the same entity delta as TSb.
 */
import {AppError} from '../../contracts/src/app-error.ts';
import {isClipTransform, validateClipTransform} from '../../contracts/src/timeline-clip-transform.ts';
import type {ClipTransform} from '../../contracts/src/timeline-clip-transform.ts';
import {canonicalClipTransition, clipTransitionFits, clipTransitionPredecessor, validateClipTransition} from '../../contracts/src/timeline-clip-transition.ts';
import type {ClipTransition, TransitionSource, TransitionSources} from '../../contracts/src/timeline-clip-transition.ts';
import {isTimelineClipColour} from '../../contracts/src/timeline-colour.ts';
import {isClipAudioRole, getTimelineAudioRoleIssue} from '../../contracts/src/timeline-audio-role.ts';
import {isVolumeEnvelope} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import {getTimelineFadeIssue} from '../../contracts/src/timeline-fades.ts';
import type {Format5Clip, Format5Timeline} from '../../contracts/src/project-format5.ts';
import type {
  SequenceEditClipPropertiesIntent, SequenceEditClipPropertiesPatch, SequenceEditEnvelope, SequenceEditExpectedTarget,
  SequenceEditImpact, SequenceEditStateDelta, SequenceEditTimelineDelta,
} from '../../contracts/src/sequence-edit.ts';
import {SEQUENCE_EDIT_CONTRACT_VERSION, sequenceEditEnvelopeOperationName} from '../../contracts/src/sequence-edit.ts';
import type {ProjectStore} from './project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {applySequenceEditTimelineDelta} from './format5-sequence-sync.ts';
import {prepareSequenceEditHistory, findSequenceEditReceipt, sequenceEditInputDigest, writeSequenceEditAction,
  writeSequenceEditFailure} from './format5-editor-history.ts';
import type {SequenceEditReceiptDraft} from './format5-editor-history.ts';
import {sourceFrameCount} from '../../contracts/src/source-range.ts';
import type {DatabaseSync} from 'node:sqlite';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const isFormat5 = (store: ProjectStore): boolean =>
  Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === FORMAT5_PROJECT_SCHEMA_VERSION;
function invalid(message: string, details: Row = {}): never {
  throw new AppError('SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID', message, 409, details);
}
const failure = (code: string): {ok: false; code: string; ids: readonly string[]} => ({ok: false, code, ids: []});

const UNCHANGED_TIMELINE: Omit<SequenceEditTimelineDelta, 'clips'> = Object.freeze({
  cues: [], removedClipIds: [], removedCueIds: [], baseline: Object.freeze({kind: 'unchanged' as const}),
});
const stateDelta = (clips: readonly Format5Clip[]): SequenceEditStateDelta =>
  ({board: {writes: [], removals: []}, timeline: {...UNCHANGED_TIMELINE, clips}});

export interface ClipPropertiesPlan {
  readonly before: SequenceEditStateDelta;
  readonly after: SequenceEditStateDelta;
  readonly changedClipIds: readonly string[];
}

interface ClipAsset {readonly mimeType: string; readonly duration: number | null; readonly hasAudio: boolean; readonly frames: number}
function assetReader(db: DatabaseSync): (assetId: string) => ClipAsset | null {
  const cache = new Map<string, ClipAsset | null>();
  return assetId => {
    if (!cache.has(assetId)) {
      const row = db.prepare('SELECT id,data FROM project.assets WHERE id=?').get(assetId) as {id: string; data: string} | undefined;
      if (!row) {cache.set(assetId, null);} else {
        try {
          const data = JSON.parse(row.data) as Row;
          const duration = typeof data.duration === 'number' && Number.isFinite(data.duration) ? data.duration : null;
          cache.set(assetId, {mimeType: String(data.mimeType ?? ''), duration,
            hasAudio: data.hasAudio === true, frames: sourceFrameCount(duration) ?? 0});
        } catch {cache.set(assetId, null);}
      }
    }
    return cache.get(assetId) ?? null;
  };
}
function clipSource(asset: (id: string) => ClipAsset | null, clip: Format5Clip): ClipAsset {
  if (typeof clip.assetId !== 'string' || !asset(clip.assetId)) return invalid('片段素材不可用，不能修改属性', {clipId: clip.id});
  return asset(clip.assetId)!;
}

function validatePatch(asset: (id: string) => ClipAsset | null, store: ProjectStore, clip: Format5Clip, patch: SequenceEditClipPropertiesPatch): Format5Clip {
  const keys = Object.keys(patch);
  if (keys.length === 0) invalid('片段属性补丁不能为空', {clipId: clip.id});
  const track = trackOf(store, clip.trackId);
  const next: Format5Clip = {...clip};
  if (patch.transform !== undefined) {
    if (track.kind !== 'video') invalid('只有视频轨片段可以设置变换', {clipId: clip.id});
    if (patch.transform === null) delete (next as Row).transform;
    else {
      const source = clipSource(asset, clip);
      if (!source.mimeType.match(/^(image|video)\//u)) invalid('图片或视频片段才能设置变换', {clipId: clip.id});
      try {validateClipTransform(patch.transform, clip.durationFrames);} catch {invalid('变换关键帧无效', {clipId: clip.id});}
      (next as Row).transform = patch.transform;
    }
  }
  if (patch.transition !== undefined) {
    if (track.kind !== 'video') invalid('只有视频轨片段可以设置转场', {clipId: clip.id});
    if (patch.transition === null) delete (next as Row).transitionIn;
    else {
      const source = clipSource(asset, clip);
      if (!source.mimeType.match(/^(image|video)\//u)) invalid('图片或视频片段才能设置转场', {clipId: clip.id});
      try {validateClipTransition(patch.transition);} catch {invalid('转场参数无效', {clipId: clip.id});}
      (next as Row).transitionIn = canonicalClipTransition(patch.transition as ClipTransition);
    }
  }
  if (patch.gain !== undefined) {
    if (!(typeof patch.gain === 'number' && Number.isFinite(patch.gain) && patch.gain >= 0 && patch.gain <= 2)) invalid('增益必须在 0–2', {clipId: clip.id});
    next.gain = patch.gain;
  }
  if (patch.fadeInFrames !== undefined || patch.fadeOutFrames !== undefined) {
    const fadeIn = patch.fadeInFrames ?? (typeof next.fadeInFrames === 'number' ? next.fadeInFrames : 0);
    const fadeOut = patch.fadeOutFrames ?? (typeof next.fadeOutFrames === 'number' ? next.fadeOutFrames : 0);
    if (!Number.isSafeInteger(fadeIn) || !Number.isSafeInteger(fadeOut) || fadeIn < 0 || fadeOut < 0
      || fadeIn > clip.durationFrames || fadeOut > clip.durationFrames || fadeIn + fadeOut > clip.durationFrames) {
      invalid('淡入淡出必须是不超过片段时长的整数帧', {clipId: clip.id});
    }
    const source = clipSource(asset, clip);
    const issue = getTimelineFadeIssue({...next, fadeInFrames: fadeIn, fadeOutFrames: fadeOut} as never,
      {duration: source.duration, hasAudio: source.hasAudio, mimeType: source.mimeType} as never);
    if (issue) invalid(issue.message, {clipId: clip.id});
    (next as Row).fadeInFrames = fadeIn;
    (next as Row).fadeOutFrames = fadeOut;
  }
  if (patch.colour !== undefined) {
    if (track.kind !== 'video') invalid('只有视频轨片段可以设置色彩/LUT', {clipId: clip.id});
    if (!isTimelineClipColour(patch.colour)) invalid('色彩参数无效', {clipId: clip.id});
    const look = (patch.colour as {look?: {resourceId?: unknown}} | null)?.look;
    if (look && typeof look.resourceId === 'string') {
      if (!store.db.prepare('SELECT 1 FROM project.project_lut_resources WHERE id=? AND projectId=?')
        .get(look.resourceId, store.projectId)) invalid('LUT 不属于此项目', {clipId: clip.id});
    }
    (next as Row).colour = patch.colour;
  }
  if (patch.audioRole !== undefined) {
    if (!isClipAudioRole(patch.audioRole)) invalid('音频角色无效', {clipId: clip.id});
    const issue = getTimelineAudioRoleIssue({...next, audioRole: patch.audioRole} as never, clipSource(asset, clip) as never);
    if (issue) invalid(issue.message, {clipId: clip.id});
    (next as Row).audioRole = patch.audioRole;
  }
  if (patch.volumeEnvelope !== undefined) {
    if (!isVolumeEnvelope(patch.volumeEnvelope, clip.durationFrames)) invalid('音量包络无效', {clipId: clip.id});
    const source = clipSource(asset, clip);
    if (patch.volumeEnvelope !== null && !source.mimeType.startsWith('audio/') && source.hasAudio !== true) {
      invalid('只有有声片段可以设置音量包络', {clipId: clip.id});
    }
    (next as Row).volumeEnvelope = patch.volumeEnvelope;
  }
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.length < 1 || patch.name.length > 200) invalid('片段名称无效', {clipId: clip.id});
    next.name = patch.name;
  }
  return next;
}

function trackOf(store: ProjectStore, trackId: string): {kind: 'video' | 'audio'} {
  const record = readFormat5TimelineRecord(store.db, 'project');
  const track = record?.tracks.find(item => item.id === trackId);
  if (!track) invalid('片段轨道不存在', {trackId});
  return {kind: track.kind};
}

/** Pure planning read: returns the before/after clip rows for one property action. */
export function planClipProperties(store: ProjectStore, intent: SequenceEditClipPropertiesIntent): ClipPropertiesPlan {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  const record = readFormat5TimelineRecord(store.db, 'project');
  if (!record) invalid('项目没有格式 5 时间线');
  const asset = assetReader(store.db);
  const clips = new Map(record.clips.map(clip => [clip.id, clip]));
  const seen = new Set<string>();
  const before: Format5Clip[] = [], after: Format5Clip[] = [], nextById = new Map<string, Format5Clip>();
  for (const edit of intent.operation.edits) {
    if (seen.has(edit.clipId)) invalid('同一个片段不能在一次动作里出现两次', {clipId: edit.clipId});
    seen.add(edit.clipId);
    const clip = clips.get(edit.clipId);
    if (!clip) invalid('片段不属于这个时间线', {clipId: edit.clipId});
    const next = validatePatch(asset, store, clip, edit.patch);
    nextById.set(clip.id, next);
    if (JSON.stringify(clip) === JSON.stringify(next)) continue;
    before.push(clip);
    after.push(next);
  }
  // Transition fitting reads the whole track; validate after every edit is
  // applied so two transitions in one action see each other.
  const draft = record.clips.map(clip => nextById.get(clip.id) ?? clip);
  const sources: TransitionSources = (assetId: string): TransitionSource | null => {
    const value = asset(assetId);
    return value ? {image: value.mimeType.startsWith('image/'), frames: value.frames} : null;
  };
  for (const next of after) {
    const transition = (next as Row).transitionIn;
    if (transition === undefined || transition === null) continue;
    const draftClip = draft.find(clip => clip.id === next.id) ?? next;
    if (!clipTransitionPredecessor(draft as never, draftClip as never)) invalid('同一轨道上没有在此片段开始处结束的片段，不能设置转场', {clipId: next.id});
    if (!clipTransitionFits(draft as never, draftClip as never, (transition as ClipTransition).durationFrames, sources)) {
      invalid('两段素材余量或片段长度不够这个转场', {clipId: next.id});
    }
  }
  return {before: stateDelta(before), after: stateDelta(after), changedClipIds: after.map(clip => clip.id)};
}

function clipTargetRevision(store: ProjectStore, clipId: string): number {
  const row = store.db.prepare(`SELECT revision FROM project.agent_task_target_revisions_v2
    WHERE projectId=? AND kind='timeline_clip' AND targetId=?`).get(store.projectId, clipId) as Row | undefined;
  return row && Number.isSafeInteger(row.revision) ? Math.max(1, Number(row.revision)) : 1;
}

/** Build the shared envelope for a UI/MT caller. */
export function buildClipPropertiesEnvelope(store: ProjectStore, intent: SequenceEditClipPropertiesIntent,
  options: {readonly requestId: string; readonly actionId: string; readonly epoch: string;
    readonly historyPosition: number; readonly historyRevision: number}): SequenceEditEnvelope {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  const record = readFormat5TimelineRecord(store.db, 'project');
  if (!record) invalid('项目没有格式 5 时间线');
  const plan = planClipProperties(store, intent);
  if (plan.changedClipIds.length === 0) throw new AppError('SEQUENCE_EDIT_NOOP', '片段已经是这些属性。', 409, {});
  const mainTrackId = record.mainTrack.trackId;
  const clipIds = plan.changedClipIds;
  const mainIds = clipIds.filter(id => record.clips.some(clip => clip.id === id && clip.trackId === mainTrackId));
  const otherIds = clipIds.filter(id => !mainIds.includes(id));
  const impact: SequenceEditImpact = {nodeIds: [], edgeIds: [], mainTrackClipIds: mainIds,
    otherTrackItemIds: otherIds, subtitleCueIds: []};
  const targets: SequenceEditExpectedTarget[] = clipIds.map(id => ({kind: 'clip', id, revision: clipTargetRevision(store, id)}));
  const content = readProjectContentStamp(store.db).contentSequence;
  const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
  return {
    contractVersion: SEQUENCE_EDIT_CONTRACT_VERSION, projectId: store.projectId, epoch: options.epoch,
    actionId: options.actionId, requestId: options.requestId, originSide: 'timeline',
    filmId: record.mainTrack.sequenceNodeId, intents: [], propertiesIntent: intent,
    baseline: {contentRevision: content, timelineRevision: record.revision, syncRevision: Number(sync?.revision ?? 1),
      historyPosition: options.historyPosition, historyRevision: options.historyRevision, targets},
    impact, allocation: {clips: [], nodes: [], splitClips: [], edges: []},
  };
}

function sameTargets(store: ProjectStore, targets: readonly SequenceEditExpectedTarget[]): boolean {
  return targets.every(target => target.kind === 'clip' && target.revision === clipTargetRevision(store, target.id));
}

export interface ClipPropertiesPreview {
  readonly envelope: SequenceEditEnvelope;
  readonly planDigest: string;
  readonly warnings: readonly {code: string}[];
}
export function previewClipProperties(store: ProjectStore, input: {
  readonly requestId: string; readonly actionId?: string; readonly propertiesIntent: SequenceEditClipPropertiesIntent;
}): ClipPropertiesPreview | {ok: false; code: string; ids: readonly string[]} {
  if (!isFormat5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  try {
    const state = prepareSequenceEditHistory(store).state;
    const envelope = buildClipPropertiesEnvelope(store, input.propertiesIntent, {
      requestId: input.requestId, actionId: input.actionId ?? crypto.randomUUID(), epoch: state.epoch,
      historyPosition: state.position, historyRevision: state.revision});
    return {envelope, planDigest: sequenceEditInputDigest(envelope), warnings: []};
  } catch (error) {
    if (error instanceof AppError && error.code === 'SEQUENCE_EDIT_NOOP') return failure('SEQUENCE_EDIT_NOOP');
    if (error instanceof AppError) return failure(error.code);
    throw error;
  }
}

/** One transaction: replay, CAS, property validation, timeline delta, one history entry. */
export function runClipPropertiesSync(store: ProjectStore, envelope: SequenceEditEnvelope): {
  readonly ok: true; readonly actionId: string; readonly operation: string; readonly patch: unknown;
  readonly receipt: unknown;
} | {readonly ok: false; readonly code: string; readonly ids: readonly string[]} {
  if (!isFormat5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  const intent = envelope.propertiesIntent;
  if (!intent || envelope.intents.length !== 0) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  return store.tx(() => {
    const replay = findSequenceEditReceipt(store, envelope.requestId);
    const inputDigest = sequenceEditInputDigest(envelope);
    if (replay) {
      if (replay.inputDigest !== inputDigest) return failure('SEQUENCE_EDIT_REQUEST_REUSED');
      if (replay.receipt.status === 'not_applied') return failure(replay.receipt.code ?? 'SEQUENCE_EDIT_NOOP');
      return {ok: true, actionId: replay.receipt.actionId, operation: replay.receipt.operation, patch: null, receipt: replay.receipt};
    }
    const record = readFormat5TimelineRecord(store.db, 'project');
    if (!record) return failure('SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID');
    const content = readProjectContentStamp(store.db).contentSequence;
    const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
    if (envelope.baseline.contentRevision !== content || envelope.baseline.timelineRevision !== record.revision
      || envelope.baseline.syncRevision !== Number(sync?.revision ?? 1) || !sameTargets(store, envelope.baseline.targets)) {
      writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_REVISION_CONFLICT');
      return failure('SEQUENCE_EDIT_REVISION_CONFLICT');
    }
    let plan: ClipPropertiesPlan;
    try { plan = planClipProperties(store, intent); }
    catch (error) {
      if (error instanceof AppError && error.code === 'SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID') {
        writeSequenceEditFailure(store, envelope, error.code);
        return failure(error.code);
      }
      throw error;
    }
    if (plan.changedClipIds.length === 0) {
      writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_NOOP');
      return failure('SEQUENCE_EDIT_NOOP');
    }
    const applied = applySequenceEditTimelineDelta(store, plan.after.timeline);
    const contentRevision = readProjectContentStamp(store.db).contentSequence;
    const affected = {
      nodes: 0, edges: 0,
      mainTrackClips: plan.changedClipIds.filter(id => record.clips.some(clip => clip.id === id && clip.trackId === record.mainTrack.trackId)).length,
      otherTrackItems: plan.changedClipIds.filter(id => !record.clips.some(clip => clip.id === id && clip.trackId === record.mainTrack.trackId)).length,
      subtitleCues: 0,
    };
    const receipt: SequenceEditReceiptDraft = {
      version: SEQUENCE_EDIT_CONTRACT_VERSION, requestId: envelope.requestId, inputDigest,
      projectId: store.projectId, actionId: envelope.actionId,
      operation: sequenceEditEnvelopeOperationName(envelope), originSide: envelope.originSide, status: 'applied',
      affected, contentRevision, timelineRevision: applied.timelineRevision, syncRevision: Number(sync?.revision ?? 1),
    };
    const patch = {version: SEQUENCE_EDIT_CONTRACT_VERSION, before: plan.before, after: plan.after};
    const stored = writeSequenceEditAction(store, {envelope, patch, receipt});
    return {ok: true, actionId: envelope.actionId, operation: stored.operation, patch, receipt: stored};
  });
}

export function clipPropertiesOperationName(envelope: SequenceEditEnvelope): string {
  return sequenceEditEnvelopeOperationName(envelope);
}
