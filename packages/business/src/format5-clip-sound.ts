/** FR-G «separate sound»: one user action that mutes a video clip and inserts a
 * sound-only audio clip which keeps referencing the same video asset.
 *
 * The user (or Mio) sends only `{clipId}`. The preview server expands it into a
 * concrete operation: it allocates the audio clip id, chooses the first audio
 * track with a free gap below the source clip or creates one in the same action,
 * resolves the localized name prefix, anchors the new clip to the same owner and
 * inherits the sound-related properties (gain, fades, envelope, audio role,
 * clip mute). The accepted envelope carries those resolved identities, so
 * confirm/retry/replay always write exactly the previewed rows.
 *
 * The whole expansion is a single timeline delta (clips + optional full track
 * header) in one history-13 entry: undo removes the audio clip and any created
 * track and restores the source clip in one step.
 */
import {randomUUID} from 'node:crypto';
import {sequenceEditPreviewFailure} from './format5-sequence-preview-errors.ts';
import {AppError} from '../../contracts/src/app-error.ts';
import {FORMAT5_LIMITS, getFormat5TimelineIssue} from '../../contracts/src/project-format5.ts';
import type {Format5Clip, Format5Timeline} from '../../contracts/src/project-format5.ts';
import type {
  SequenceEditAffectedCounts, SequenceEditEnvelope, SequenceEditImpact,
  SequenceEditSeparateSoundIntent, SequenceEditSeparateSoundOperation, SequenceEditStateDelta,
  SequenceEditTimelineDelta,
} from '../../contracts/src/sequence-edit.ts';
import {SEQUENCE_EDIT_CONTRACT_VERSION, isSequenceEditErrorCode, sequenceEditEnvelopeOperationName} from '../../contracts/src/sequence-edit.ts';
import {translate} from '../../i18n/src/index.ts';
import {isLocale} from '../../i18n/src/locale.ts';
import type {Locale} from '../../i18n/src/types.ts';
import type {ProjectStore} from './project-file/store.ts';
import {isSequenceProjectFormat} from './project-file/schema/databases.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {applySequenceEditTimelineDelta} from './format5-sequence-sync.ts';
import {findSequenceEditReceipt, prepareSequenceEditHistory, sequenceEditInputDigest, writeSequenceEditAction,
  writeSequenceEditFailure} from './format5-editor-history.ts';
import type {SequenceEditReceiptDraft} from './format5-editor-history.ts';
import type {DatabaseSync} from 'node:sqlite';

type Row = Record<string, unknown>;
type Track = Format5Timeline['tracks'][number];
type Operation = SequenceEditSeparateSoundOperation;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isFormat5 = (store: ProjectStore): boolean =>
  isSequenceProjectFormat(store.db.prepare('PRAGMA project.user_version').get()?.user_version);
function invalid(message: string, details: Row = {}): never {
  throw new AppError('SEQUENCE_EDIT_SOUND_INVALID', message, 409, details);
}
const failure = (code: string, ids: readonly string[] = []): {ok: false; code: string; ids: readonly string[]} =>
  ({ok: false, code, ids});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface SoundAsset {readonly mimeType: string; readonly hasAudio: boolean}
function readSoundAsset(db: DatabaseSync, assetId: string): SoundAsset | null {
  const row = db.prepare('SELECT id,data FROM project.assets WHERE id=?').get(assetId) as {data?: unknown} | undefined;
  if (typeof row?.data !== 'string') return null;
  let data: Row;
  try { data = JSON.parse(row.data) as Row; } catch { return null; }
  return {mimeType: String(data.mimeType ?? ''), hasAudio: data.hasAudio === true,
    };
}

function requireTimeline(store: ProjectStore): Format5Timeline {
  const record = readFormat5TimelineRecord(store.db, 'project');
  if (!record) invalid('项目没有格式 5 时间线');
  return record;
}

/** Localized clip name: «clip name · sound». A caller without a language (Mio
 * without a task language, MCP) falls back to Simplified Chinese, the same
 * fallback the generated asset names use; the UI passes a pre-localized `name`
 * instead. */
function soundClipName(base: string, locale: Locale): string {
  const suffix = ` · ${translate(locale, 'clipSound.nameSuffix')}`;
  const room = 200 - suffix.length;
  let stem = base.length <= room ? base : base.slice(0, room);
  if (/[\uD800-\uDBFF]$/u.test(stem)) stem = stem.slice(0, -1);
  return stem.trimEnd() + suffix;
}

function overlaps(startFrame: number, durationFrames: number, clip: Format5Clip): boolean {
  return startFrame < clip.startFrame + clip.durationFrames && clip.startFrame < startFrame + durationFrames;
}

function trackHasGap(timeline: Format5Timeline, trackId: string, startFrame: number, durationFrames: number): boolean {
  return !timeline.clips.some(clip => clip.trackId === trackId && overlaps(startFrame, durationFrames, clip));
}

function trackNameOf(timeline: Format5Timeline, operation: Operation, locale: Locale): string {
  const trimmed = operation.trackName?.trim();
  if (trimmed) {
    if (Buffer.byteLength(trimmed) > 600) invalid('音频轨名称无效');
    return trimmed;
  }
  return translate(locale, 'clipSound.trackName');
}

interface ResolvedSound extends Operation {
  readonly audioClipId: string;
  readonly audioTrackId: string;
  readonly createdTrackId?: string;
  readonly name: string;
  readonly trackName: string;
}

/**
 * Expand a minimal operation into concrete ids and names. `locale` is only used
 * when the caller did not supply localized names, so a resolved operation is
 * reproduced byte-for-byte when it is planned again. Without a recognized
 * language the names fall back to Simplified Chinese, matching the other
 * generated asset names.
 */
export function resolveSeparateSound(store: ProjectStore, operation: Operation, options: {locale?: Locale} = {}): ResolvedSound {
  if (!operation || operation.kind !== 'separate-sound' || !isUuid(operation.clipId)) invalid('分离声音的片段无效');
  const timeline = requireTimeline(store);
  const source = timeline.clips.find(clip => clip.id === operation.clipId);
  if (!source) invalid('片段不属于这个时间线', {clipId: operation.clipId});
  const sourceTrack = timeline.tracks.find(track => track.id === source.trackId);
  if (!sourceTrack || sourceTrack.kind !== 'video') invalid('只有画面轨片段可以分离声音', {clipId: source.id});
  if (source.timing?.profile === 'timeline-freeze-v1') invalid('定格片段没有可分离的声音', {clipId: source.id});
  if (source.sourceState !== 'ready') invalid('占位片段没有可分离的声音', {clipId: source.id});
  const assetId = source.assetId;
  if (typeof assetId !== 'string') invalid('片段没有可用的素材', {clipId: source.id});
  const asset = readSoundAsset(store.db, assetId);
  if (!asset || !asset.mimeType.startsWith('video/') || asset.hasAudio !== true)
    invalid('这个片段没有可分离的声音', {clipId: source.id, assetId});
  const locale: Locale = options.locale !== undefined && isLocale(options.locale) ? options.locale : 'zh-Hans';
  const trackName = trackNameOf(timeline, operation, locale);
  const name = operation.name ?? soundClipName(source.name, locale);
  if (typeof name !== 'string' || name.length < 1 || name.length > 200) invalid('音频片段名称无效');
  let audioClipId = operation.audioClipId;
  if (audioClipId !== undefined && !isUuid(audioClipId)) invalid('音频片段 ID 无效');
  if (audioClipId === undefined) audioClipId = randomUUID();
  if (timeline.clips.some(clip => clip.id === audioClipId)) invalid('音频片段 ID 已被使用', {clipId: audioClipId});
  let audioTrackId = operation.audioTrackId, createdTrackId = operation.createdTrackId;
  if (audioTrackId !== undefined && !isUuid(audioTrackId)) invalid('音频轨 ID 无效');
  if (createdTrackId !== undefined && createdTrackId !== audioTrackId) invalid('新建音频轨必须就是目标轨');
  if (audioTrackId === undefined) {
    // First audio track below the source clip having a free gap for this range.
    const candidate = [...timeline.tracks].filter(track => track.kind === 'audio')
      .sort((left, right) => left.orderIndex - right.orderIndex || left.id.localeCompare(right.id))
      .find(track => trackHasGap(timeline, track.id, source.startFrame, source.durationFrames));
    if (candidate) audioTrackId = candidate.id;
    else {
      if (timeline.tracks.length >= FORMAT5_LIMITS.tracks) {
        throw new AppError('FORMAT5_CAPACITY', `轨道数量最多 ${FORMAT5_LIMITS.tracks} 条`, 409, {ids: [source.id]});
      }
      audioTrackId = randomUUID();
      createdTrackId = audioTrackId;
    }
  } else if (createdTrackId !== undefined) {
    if (timeline.tracks.some(track => track.id === createdTrackId)) invalid('新建音频轨 ID 已被使用', {trackId: createdTrackId});
  } else {
    const track = timeline.tracks.find(item => item.id === audioTrackId);
    if (!track || track.kind !== 'audio') invalid('目标音频轨无效', {trackId: audioTrackId});
    if (!trackHasGap(timeline, track.id, source.startFrame, source.durationFrames)) invalid('目标音频轨这段时间没有空位', {trackId: track.id});
  }
  return {kind: 'separate-sound', clipId: source.id, audioClipId, audioTrackId,
    ...(createdTrackId !== undefined ? {createdTrackId} : {}), name, trackName};
}

/** Fields the separated audio clip inherits from the source clip: everything
 * that shapes how the same sound plays, never picture-only effects. */
function inheritedSoundFields(source: Format5Clip): Row {
  const fields: Row = {gain: source.gain};
  for (const key of ['fadeInFrames', 'fadeOutFrames', 'volumeEnvelope', 'audioRole']) {
    if (Object.hasOwn(source, key)) fields[key] = clone((source as Row)[key]);
  }
  if (source.muted === true) fields.muted = true;
  return fields;
}

function anchorFor(timeline: Format5Timeline, source: Format5Clip): Format5Clip['anchor'] {
  if (source.trackId === timeline.mainTrack.trackId) return {clipId: source.id, offsetFrames: 0};
  return source.anchor ?? null;
}

/** Create the concrete audio track row. The track order stays dense and the
 * main-track identity is untouched. */
function createdAudioTrack(timeline: Format5Timeline, resolved: ResolvedSound): Track {
  const orderIndex = Math.max(-1, ...timeline.tracks.map(track => track.orderIndex)) + 1;
  return {id: resolved.audioTrackId, name: resolved.trackName.slice(0, 150), kind: 'audio',
    orderIndex, hidden: false, muted: false};
}

export interface SeparateSoundPlan {
  readonly before: SequenceEditStateDelta;
  readonly after: SequenceEditStateDelta;
  readonly sourceClipId: string;
  readonly audioClipId: string;
  readonly audioTrackId: string;
  readonly createdTrackId: string | null;
  readonly changedClipIds: readonly string[];
}

function soundTimelineDelta(clips: readonly Format5Clip[], removedClipIds: readonly string[],
  tracks: readonly Track[] | undefined): SequenceEditTimelineDelta {
  return {clips, cues: [], removedClipIds, removedCueIds: [],
    ...(tracks ? {tracks} : {}), baseline: {kind: 'unchanged' as const}};
}
const stateDelta = (delta: SequenceEditTimelineDelta): SequenceEditStateDelta =>
  ({board: {writes: [], removals: []}, timeline: delta});

/** Pure planning read: the exact before/after rows for one separate-sound
 * action. Nothing is written and no server id is reallocated. */
export function planSeparateSound(store: ProjectStore, operation: Operation): SeparateSoundPlan {
  const formatVersion = store.db.prepare('PRAGMA project.user_version').get()?.user_version;
  if (!isSequenceProjectFormat(formatVersion)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  if (!isUuid(operation.audioClipId) || !isUuid(operation.audioTrackId)) {
    throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '分离声音还没有分配片段和轨道。', 409, {});
  }
  const timeline = requireTimeline(store);
  const source = timeline.clips.find(clip => clip.id === operation.clipId);
  if (!source) invalid('片段不属于这个时间线', {clipId: operation.clipId});
  const sourceTrack = timeline.tracks.find(track => track.id === source.trackId);
  if (!sourceTrack || sourceTrack.kind !== 'video') invalid('只有画面轨片段可以分离声音', {clipId: source.id});
  if (source.timing?.profile === 'timeline-freeze-v1') invalid('定格片段没有可分离的声音', {clipId: source.id});
  const createdTrackId = operation.createdTrackId ?? null;
  const destination = timeline.tracks.find(track => track.id === operation.audioTrackId);
  if (createdTrackId !== null) {
    if (createdTrackId !== operation.audioTrackId) invalid('新建音频轨必须就是目标轨');
    if (destination) invalid('新建音频轨 ID 已被使用', {trackId: createdTrackId});
  } else if (!destination || destination.kind !== 'audio' || !trackHasGap(timeline, destination.id, source.startFrame, source.durationFrames)) {
    invalid('目标音频轨这段时间没有空位', {trackId: operation.audioTrackId});
  }
  if (timeline.clips.some(clip => clip.id === operation.audioClipId)) invalid('音频片段 ID 已被使用', {clipId: operation.audioClipId});
  const name = operation.name ?? soundClipName(source.name, 'zh-Hans');
  if (typeof name !== 'string' || name.length < 1 || name.length > 200) invalid('音频片段名称无效');
  const tracks: readonly Track[] = destination ? timeline.tracks
    : [...timeline.tracks, createdAudioTrack(timeline, {kind: 'separate-sound', clipId: operation.clipId,
      audioClipId: operation.audioClipId, audioTrackId: operation.audioTrackId, createdTrackId: createdTrackId as string,
      name, trackName: operation.trackName?.trim() || translate('zh-Hans', 'clipSound.trackName')} as ResolvedSound)];
  const inherit = inheritedSoundFields(source);
  const soundClip = {
    id: operation.audioClipId, trackId: operation.audioTrackId, assetId: source.assetId,
    name, startFrame: source.startFrame, durationFrames: source.durationFrames, sourceInFrame: source.sourceInFrame,
    rect: clone(source.rect), sourceState: 'ready', soundOnly: true, anchor: anchorFor(timeline, source),
    ...(source.timing ? {timing: clone(source.timing), sourceSpanFrames: source.sourceSpanFrames} : {}),
    ...inherit,
  } as Format5Clip;
  const mutedSource: Format5Clip = source.muted === true ? source : {...source, muted: true};
  const clips = [...timeline.clips.map(clip => clip.id === source.id ? mutedSource : clip), soundClip];
  // The separated sound only ever sits inside the source clip's own range, so
  // the timeline duration cannot move.
  const next: Format5Timeline = {...timeline, clips, tracks: [...tracks]};
  const issue = getFormat5TimelineIssue(next, {projectId: store.projectId, formatVersion});
  if (issue) invalid(issue.message ?? '分离声音后的时间线无效', {ids: issue.ids ?? []});
  const trackChanged = createdTrackId !== null;
  const before = stateDelta(soundTimelineDelta([source], [soundClip.id], trackChanged ? timeline.tracks : undefined));
  const after = stateDelta(soundTimelineDelta([mutedSource, soundClip], [], trackChanged ? [...tracks] : undefined));
  return {before, after, sourceClipId: source.id, audioClipId: soundClip.id, audioTrackId: operation.audioTrackId,
    createdTrackId, changedClipIds: [soundClip.id, source.id]};
}

function clipTargetRevision(store: ProjectStore, clipId: string): number {
  const row = store.db.prepare(`SELECT revision FROM project.agent_task_target_revisions_v2
    WHERE projectId=? AND kind='timeline_clip' AND targetId=?`).get(store.projectId, clipId) as Row | undefined;
  return row && Number.isSafeInteger(row.revision) ? Math.max(1, Number(row.revision)) : 1;
}

function sameTarget(store: ProjectStore, clipId: string, revision: number): boolean {
  return clipTargetRevision(store, clipId) === revision;
}

/** Build the shared envelope for a resolved operation. */
export function buildSeparateSoundEnvelope(store: ProjectStore, operation: Operation,
  options: {readonly requestId: string; readonly actionId: string; readonly epoch: string;
    readonly historyPosition: number; readonly historyRevision: number; readonly origin?: 'user' | 'mio'}): SequenceEditEnvelope {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  const timeline = requireTimeline(store);
  const plan = planSeparateSound(store, operation);
  const mainTrackId = timeline.mainTrack.trackId;
  const source = timeline.clips.find(clip => clip.id === plan.sourceClipId)!;
  const sourceOnMain = source.trackId === mainTrackId;
  const impact: SequenceEditImpact = {
    nodeIds: [], edgeIds: [],
    mainTrackClipIds: sourceOnMain ? [plan.sourceClipId] : [],
    otherTrackItemIds: [...(sourceOnMain ? [] : [plan.sourceClipId]), plan.audioClipId],
    subtitleCueIds: [],
    ...(plan.createdTrackId ? {trackIds: [plan.createdTrackId]} : {}),
  };
  const targets = [{kind: 'clip' as const, id: plan.sourceClipId, revision: clipTargetRevision(store, plan.sourceClipId)}];
  const content = readProjectContentStamp(store.db).contentSequence;
  const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
  return {
    contractVersion: SEQUENCE_EDIT_CONTRACT_VERSION, projectId: store.projectId, epoch: options.epoch,
    actionId: options.actionId, requestId: options.requestId, originSide: 'timeline',
    ...(options.origin ? {origin: options.origin} : {}),
    filmId: timeline.mainTrack.sequenceNodeId, intents: [],
    soundIntent: {side: 'timeline', operation},
    baseline: {contentRevision: content, timelineRevision: timeline.revision, syncRevision: Number(sync?.revision ?? 1),
      historyPosition: options.historyPosition, historyRevision: options.historyRevision, targets},
    impact, allocation: {clips: [], nodes: [], splitClips: [], edges: []},
  };
}

export interface SeparateSoundPreview {
  readonly envelope: SequenceEditEnvelope;
  readonly planDigest: string;
  readonly warnings: readonly {code: string}[];
}
/** Preview: expand the minimal intent, validate the exact rows and return the
 * accepted envelope with its plan digest. */
export function previewSeparateSound(store: ProjectStore, input: {
  readonly requestId: string; readonly actionId?: string; readonly origin?: 'user' | 'mio';
  readonly soundIntent: SequenceEditSeparateSoundIntent; readonly locale?: Locale;
}): SeparateSoundPreview | {ok: false; code: string; ids: readonly string[]} {
  if (!isFormat5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  try {
    const state = prepareSequenceEditHistory(store).state;
    const source = input.soundIntent.operation;
    const resolved = resolveSeparateSound(store, source, {locale: input.locale ?? undefined});
    const operation: Operation = {kind: 'separate-sound', clipId: resolved.clipId, audioClipId: resolved.audioClipId,
      audioTrackId: resolved.audioTrackId, ...(resolved.createdTrackId ? {createdTrackId: resolved.createdTrackId} : {}),
      name: resolved.name, ...(resolved.createdTrackId ? {trackName: resolved.trackName} : {})};
    const envelope = buildSeparateSoundEnvelope(store, operation, {
      requestId: input.requestId, actionId: input.actionId ?? randomUUID(), epoch: state.epoch,
      historyPosition: state.position, historyRevision: state.revision, ...(input.origin ? {origin: input.origin} : {})});
    return {envelope, planDigest: sequenceEditInputDigest(envelope), warnings: []};
  } catch (error) {
    if (error instanceof AppError) return sequenceEditPreviewFailure(error);
    throw error;
  }
}

/** One transaction: replay, CAS, exact plan, timeline delta (clips + tracks),
 * one history entry. Undo/redo apply the same stored patch. */
export function runSeparateSoundSync(store: ProjectStore, envelope: SequenceEditEnvelope): {
  readonly ok: true; readonly actionId: string; readonly operation: string; readonly patch: unknown;
  readonly receipt: unknown;
} | {readonly ok: false; readonly code: string; readonly ids: readonly string[]} {
  if (!isFormat5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  const intent = envelope.soundIntent;
  if (!intent || envelope.intents.length !== 0) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  return store.tx(() => {
    const replay = findSequenceEditReceipt(store, envelope.requestId);
    const inputDigest = sequenceEditInputDigest(envelope);
    if (replay) {
      if (replay.inputDigest !== inputDigest) return failure('SEQUENCE_EDIT_REQUEST_REUSED');
      if (replay.receipt.status === 'not_applied') return failure(replay.receipt.code ?? 'SEQUENCE_EDIT_NOOP');
      return {ok: true, actionId: replay.receipt.actionId, operation: replay.receipt.operation, patch: null, receipt: replay.receipt};
    }
    const timeline = readFormat5TimelineRecord(store.db, 'project');
    if (!timeline) return failure('SEQUENCE_EDIT_SOUND_INVALID');
    const content = readProjectContentStamp(store.db).contentSequence;
    const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
    const target = envelope.baseline.targets.find(item => item.kind === 'clip');
    if (envelope.baseline.contentRevision !== content || envelope.baseline.timelineRevision !== timeline.revision
      || envelope.baseline.syncRevision !== Number(sync?.revision ?? 1)
      || !target || !sameTarget(store, target.id, target.revision)) {
      writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_REVISION_CONFLICT');
      return failure('SEQUENCE_EDIT_REVISION_CONFLICT');
    }
    let plan: SeparateSoundPlan;
    try { plan = planSeparateSound(store, intent.operation); }
    catch (error) {
      if (error instanceof AppError) {
        const code = error.code;
        if (isSequenceEditErrorCode(code)) {
          writeSequenceEditFailure(store, envelope, code);
          return failure(code);
        }
      }
      throw error;
    }
    const applied = applySequenceEditTimelineDelta(store, plan.after.timeline);
    const contentRevision = readProjectContentStamp(store.db).contentSequence;
    const mainTrackId = timeline.mainTrack.trackId;
    const sourceOnMain = timeline.clips.some(clip => clip.id === plan.sourceClipId && clip.trackId === mainTrackId);
    const affected: SequenceEditAffectedCounts = {nodes: 0, edges: 0, mainTrackClips: sourceOnMain ? 1 : 0,
      otherTrackItems: 1 + (sourceOnMain ? 0 : 1), subtitleCues: 0, ...(plan.createdTrackId ? {tracks: 1} : {})};
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

/** UI/headless helpers: the exact operation fields a resolved envelope carries. */
export function readSeparateSoundOperation(envelope: SequenceEditEnvelope): Operation | null {
  return envelope.soundIntent?.operation ?? null;
}

