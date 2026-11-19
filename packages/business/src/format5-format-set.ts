/** FR-B2: one output-preset change as a shared sequence-edit action.
 *
 * The header moves to the new preset. Every clip that has no explicit layout
 * freezes its current frame as the layout basis, so its saved rectangle keeps
 * the composition the user saw; clips that already own a basis are untouched.
 * The whole change (header + layout rows) travels in one history-13 patch.
 */
import {AppError} from '../../contracts/src/app-error.ts';
import {CLIP_LAYOUT_PROFILE} from '../../contracts/src/timeline-clip-layout.ts';
import {timelineOutputPreset} from '../../contracts/src/timeline-output-geometry.ts';
import {TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID, TIMELINE_SUBTITLE_PROFILE_ID} from '../../contracts/src/timeline-subtitle-profile.ts';
import {FORMAT5_LIMITS, getFormat5TimelineIssue} from '../../contracts/src/project-format5.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {findSequenceEditReceipt, prepareSequenceEditHistory, sequenceEditInputDigest,
  writeSequenceEditAction, writeSequenceEditFailure} from './format5-editor-history.ts';
import type {SequenceEditReceiptDraft} from './format5-editor-history.ts';
import {applySequenceEditTimelineDelta} from './format5-sequence-sync.ts';
import {sequenceEditEnvelopeOperationName, SEQUENCE_EDIT_CONTRACT_VERSION} from '../../contracts/src/sequence-edit.ts';
import type {
  SequenceEditEnvelope, SequenceEditErrorCode, SequenceEditExpectedTarget, SequenceEditFormatIntent,
  SequenceEditStateDelta, SequenceEditSubtitleProfileChange, SequenceEditTimelineDelta,
} from '../../contracts/src/sequence-edit.ts';
import type {Format5Clip, Format5Timeline} from '../../contracts/src/project-format5.ts';
import type {ProjectStore} from './project-file/store.ts';

type Row = Record<string, unknown>;
const isFormat5 = (store: ProjectStore): boolean => {
  try { return store.db.prepare("SELECT 1 AS present FROM project.sqlite_schema WHERE type='table' AND name='timeline_clips' LIMIT 1").get() !== undefined; }
  catch { return false; }
};
const clipTargetRevision = (store: ProjectStore, clipId: string): number => {
  const row = store.db.prepare(`SELECT revision FROM project.agent_task_target_revisions_v2
    WHERE projectId=? AND kind='timeline_clip' AND targetId=?`).get(store.projectId, clipId) as Row | undefined;
  return row && Number.isSafeInteger(row.revision) ? Math.max(1, Number(row.revision)) : 1;
};
const failure = (code: SequenceEditErrorCode, ids: readonly string[] = []): {ok: false; code: string; ids: readonly string[]} => ({ok: false, code, ids});
const unchangedTimeline = (): Omit<SequenceEditTimelineDelta, 'clips' | 'header'> => ({
  cues: [], removedClipIds: [], removedCueIds: [], baseline: {kind: 'unchanged'},
});
const apply = (timeline: Format5Timeline, subtitles: Format5Timeline['subtitles']): Format5Timeline => {
  const clips = timeline.clips.map(clip => {
    const candidate = clip as Format5Clip & {layout?: unknown};
    if (Object.hasOwn(candidate, 'layout')) return candidate;
    return {...candidate, layout: {profileId: CLIP_LAYOUT_PROFILE, basisPresetId: timelineOutputPreset(timeline)?.id ?? ''}} as Format5Clip;
  });
  return {...timeline, clips, ...(subtitles ? {subtitles} : {})};
};

export interface TimelineFormatPlan {
  readonly before: SequenceEditStateDelta; readonly after: SequenceEditStateDelta;
  readonly changedClipIds: readonly string[];
  readonly header: SequenceEditTimelineDelta['header'];
}

/** Pure plan against one live record. Throws SEQUENCE_EDIT_NOOP for the same
 * preset, and returns the header + frozen-layout clip rows to write. */
export function planTimelineFormat(store: ProjectStore, timeline: Format5Timeline, intent: SequenceEditFormatIntent): TimelineFormatPlan {
  const current = timelineOutputPreset(timeline);
  const next = timelineOutputPreset(intent.operation.presetId);
  if (!current || !next) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '画幅预设无效。', 409, {});
  if (current.id === next.id) throw new AppError('SEQUENCE_EDIT_NOOP', '时间线已使用此输出规格。', 409, {});
  if (Math.min(current.width, current.height) !== Math.min(next.width, next.height)) {
    throw new AppError('TIMELINE_FORMAT_TIER_MISMATCH', '修改比例时必须保留当前画框的短边档位。', 409, {});
  }
  const nextSubtitles = timeline.subtitles?.profileId === TIMELINE_SUBTITLE_PROFILE_ID
    ? {profileId: TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID, basisPresetId: current.id, cues: timeline.subtitles.cues}
    : timeline.subtitles;
  const nextTimeline = apply(timeline, nextSubtitles);
  const issue = getFormat5TimelineIssue(nextTimeline, {projectId: store.projectId});
  if (issue) {
    throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '切换画幅后片段布局无效。', 409, {issue: issue.code, ids: issue.ids});
  }
  if (Buffer.byteLength(JSON.stringify(nextTimeline)) > FORMAT5_LIMITS.timelineBytes) {
    throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '切换画幅会超过时间线保存上限。', 409, {});
  }
  const before = new Map(timeline.clips.map(clip => [clip.id, clip] as const));
  const after = new Map(nextTimeline.clips.map(clip => [clip.id, clip] as const));
  const changedClipIds = timeline.clips.filter(clip => before.get(clip.id) !== after.get(clip.id)).map(clip => clip.id);
  const beforeHeader: NonNullable<SequenceEditTimelineDelta['header']> = {kind: 'set',
    value: {fps: current.fps, width: current.width, height: current.height}};
  const headerChange: NonNullable<SequenceEditTimelineDelta['header']> = {kind: 'set',
    value: {fps: next.fps, width: next.width, height: next.height}};
  const profile = (value: Format5Timeline['subtitles']): SequenceEditSubtitleProfileChange => value
    ? {kind: 'set', value: {profileId: value.profileId, ...(value.basisPresetId !== undefined ? {basisPresetId: value.basisPresetId} : {})}}
    : {kind: 'absent'};
  const deltas = (clips: readonly Format5Clip[], header: NonNullable<SequenceEditTimelineDelta['header']>,
    subtitles: SequenceEditSubtitleProfileChange): SequenceEditStateDelta => ({
    board: {writes: [], removals: []}, timeline: {...unchangedTimeline(), clips, header, subtitles},
  });
  return {before: deltas(changedClipIds.map(id => before.get(id)!), beforeHeader, profile(timeline.subtitles)),
    after: deltas(changedClipIds.map(id => after.get(id)!), headerChange, profile(nextTimeline.subtitles)),
    changedClipIds, header: headerChange};
}

export function buildTimelineFormatEnvelope(store: ProjectStore, intent: SequenceEditFormatIntent,
  options: {readonly requestId: string; readonly actionId: string; readonly epoch: string;
    readonly origin?: 'user' | 'mio'; readonly historyPosition: number; readonly historyRevision: number}): SequenceEditEnvelope {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  const record = readFormat5TimelineRecord(store.db, 'project');
  if (!record) throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线。', 422, {database: 'project', reason: 'metadata'});
  const plan = planTimelineFormat(store, record, intent);
  const mainTrackId = record.mainTrack.trackId;
  const impact = {
    nodeIds: [], edgeIds: [],
    mainTrackClipIds: plan.changedClipIds.filter(id => record.clips.some(clip => clip.id === id && clip.trackId === mainTrackId)),
    otherTrackItemIds: plan.changedClipIds.filter(id => !record.clips.some(clip => clip.id === id && clip.trackId === mainTrackId)),
    subtitleCueIds: [],
  };
  const targets: SequenceEditExpectedTarget[] = plan.changedClipIds.map(id => ({kind: 'clip', id, revision: clipTargetRevision(store, id)}));
  const content = readProjectContentStamp(store.db).contentSequence;
  const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
  return {contractVersion: SEQUENCE_EDIT_CONTRACT_VERSION, projectId: store.projectId, epoch: options.epoch,
    actionId: options.actionId, requestId: options.requestId, originSide: 'timeline',
    ...(options.origin ? {origin: options.origin} : {}), filmId: record.mainTrack.sequenceNodeId, intents: [],
    formatIntent: intent,
    baseline: {contentRevision: content, timelineRevision: record.revision, syncRevision: Number(sync?.revision ?? 1),
      historyPosition: options.historyPosition, historyRevision: options.historyRevision, targets},
    impact, allocation: {clips: [], nodes: [], splitClips: [], edges: []}};
}

export interface TimelineFormatPreview {readonly envelope: SequenceEditEnvelope; readonly planDigest: string;
  readonly warnings: readonly {code: string}[]}
export function previewTimelineFormat(store: ProjectStore, input: {requestId: string; actionId?: string;
  origin?: 'user' | 'mio'; formatIntent: SequenceEditFormatIntent}): TimelineFormatPreview | {ok: false; code: string; ids: readonly string[]} {
  if (!isFormat5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  try {
    const state = prepareSequenceEditHistory(store).state;
    const envelope = buildTimelineFormatEnvelope(store, input.formatIntent, {requestId: input.requestId,
      actionId: input.actionId ?? crypto.randomUUID(), epoch: state.epoch, ...(input.origin ? {origin: input.origin} : {}),
      historyPosition: state.position, historyRevision: state.revision});
    return {envelope, planDigest: sequenceEditInputDigest(envelope), warnings: []};
  } catch (error) {
    if (error instanceof AppError) return failure(error.code as SequenceEditErrorCode);
    throw error;
  }
}

export function runTimelineFormatSync(store: ProjectStore, envelope: SequenceEditEnvelope): {
  readonly ok: true; readonly actionId: string; readonly operation: string; readonly patch: unknown; readonly receipt: unknown;
} | {readonly ok: false; readonly code: string; readonly ids: readonly string[]} {
  if (!isFormat5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  const intent = envelope.formatIntent;
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
    if (!record) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
    const content = readProjectContentStamp(store.db).contentSequence;
    const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
    if (envelope.baseline.contentRevision !== content || envelope.baseline.timelineRevision !== record.revision
      || envelope.baseline.syncRevision !== Number(sync?.revision ?? 1)) {
      writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_REVISION_CONFLICT');
      return failure('SEQUENCE_EDIT_REVISION_CONFLICT');
    }
    let plan: TimelineFormatPlan;
    try { plan = planTimelineFormat(store, record, intent); }
    catch (error) {
      if (error instanceof AppError) { const code = error.code as SequenceEditErrorCode; writeSequenceEditFailure(store, envelope, code); return failure(code); }
      throw error;
    }
    const applied = applySequenceEditTimelineDelta(store, plan.after.timeline);
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
      affected, contentRevision: readProjectContentStamp(store.db).contentSequence,
      timelineRevision: applied.timelineRevision, syncRevision: Number(sync?.revision ?? 1),
    };
    const patch = {version: SEQUENCE_EDIT_CONTRACT_VERSION, before: plan.before, after: plan.after};
    const stored = writeSequenceEditAction(store, {envelope, patch, receipt});
    return {ok: true, actionId: envelope.actionId, operation: stored.operation, patch, receipt: stored};
  });
}
