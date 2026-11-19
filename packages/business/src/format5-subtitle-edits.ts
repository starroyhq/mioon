/** FR-B: format-5 subtitle cue structure as one shared `sequence-edit` action.
 *
 * Cues always carry a main-track owner anchor. Add/update/remove keep the TSb
 * anchor rule (`startFrame = owner.startFrame + anchor.offsetFrames`), reject
 * overlaps and reuse the shared history/undo path. No clip or baseline row is
 * touched, so undo restores exactly the cue rows.
 */
import {AppError} from '../../contracts/src/app-error.ts';
import {getFormat5CueIssue, format5AnchorSchema} from '../../contracts/src/project-format5.ts';
import type {Format5Anchor, Format5Cue, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {getTimelineSubtitleTextIssue, TIMELINE_SUBTITLE_PROFILE_ID} from '../../contracts/src/timeline-subtitles.ts';
import type {
  SequenceEditEnvelope, SequenceEditExpectedTarget, SequenceEditImpact, SequenceEditStateDelta,
  SequenceEditSubtitlesIntent, SequenceEditTimelineDelta,
} from '../../contracts/src/sequence-edit.ts';
import {SEQUENCE_EDIT_CONTRACT_VERSION, sequenceEditEnvelopeOperationName, sequenceEditSubtitlesIntentSchema} from '../../contracts/src/sequence-edit.ts';
import type {ProjectStore} from './project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {applySequenceEditTimelineDelta} from './format5-sequence-sync.ts';
import {prepareSequenceEditHistory, findSequenceEditReceipt, sequenceEditInputDigest, writeSequenceEditAction,
  writeSequenceEditFailure} from './format5-editor-history.ts';
import type {SequenceEditReceiptDraft} from './format5-editor-history.ts';

type Row = Record<string, unknown>;
const isFormat5 = (store: ProjectStore): boolean =>
  Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === FORMAT5_PROJECT_SCHEMA_VERSION;
function invalid(message: string, details: Row = {}): never {
  throw new AppError('SEQUENCE_EDIT_SUBTITLE_INVALID', message, 409, details);
}
const failure = (code: string): {ok: false; code: string; ids: readonly string[]} => ({ok: false, code, ids: []});
const UNCHANGED: Omit<SequenceEditTimelineDelta, 'cues' | 'removedCueIds' | 'subtitles'> = Object.freeze({
  clips: [], removedClipIds: [], baseline: Object.freeze({kind: 'unchanged' as const}),
});
const stateDelta = (cues: readonly Format5Cue[], removedCueIds: readonly string[],
  subtitles: NonNullable<SequenceEditTimelineDelta['subtitles']>): SequenceEditStateDelta =>
  ({board: {writes: [], removals: []}, timeline: {...UNCHANGED, cues, removedCueIds, subtitles}});

export interface SubtitleEditsPlan {
  readonly before: SequenceEditStateDelta;
  readonly after: SequenceEditStateDelta;
  readonly changedCueIds: readonly string[];
  readonly removedCueIds: readonly string[];
}

function ownerClip(timeline: Format5Timeline, frame: number): Format5Timeline['clips'][number] | null {
  return timeline.clips.find(clip => clip.trackId === timeline.mainTrack.trackId &&
    clip.startFrame <= frame && frame < clip.startFrame + clip.durationFrames) ?? null;
}
function anchorFor(timeline: Format5Timeline, startFrame: number, provided?: unknown): Format5Anchor {
  const owner = ownerClip(timeline, startFrame);
  if (provided !== undefined) {
    const parsed = format5AnchorSchema.safeParse(provided);
    if (!parsed.success) invalid('字幕锚点无效');
    const anchor = parsed.data;
    if (anchor === null) invalid('字幕锚点无效');
    const ownerClipRow = timeline.clips.find(clip => clip.id === anchor.clipId);
    if (!ownerClipRow || ownerClipRow.trackId !== timeline.mainTrack.trackId
      || startFrame !== ownerClipRow.startFrame + anchor.offsetFrames
      || anchor.offsetFrames >= ownerClipRow.durationFrames) invalid('字幕锚点必须指向开始帧所在的主轨片段', {startFrame});
    return anchor;
  }
  if (!owner) invalid('字幕开始帧必须位于一个主轨片段内', {startFrame});
  return {clipId: owner.id, offsetFrames: startFrame - owner.startFrame} as Format5Anchor;
}
function validateTimelineCues(timeline: Format5Timeline, cues: readonly Format5Cue[]): void {
  if (cues.length > 1_000) invalid('字幕数量超过格式 5 上限');
  const ids = new Set<string>();
  for (const cue of cues) {
    const issue = getFormat5CueIssue(cue, {durationFrames: timeline.durationFrames});
    if (issue) invalid(issue.message, {cueId: cue.id});
    const textIssue = getTimelineSubtitleTextIssue(cue.text);
    if (textIssue) invalid(textIssue.message, {cueId: cue.id});
    if (ids.has(cue.id)) invalid('字幕标识重复', {cueId: cue.id});
    ids.add(cue.id);
    const anchor = cue.anchor;
    if (anchor === null) invalid('字幕必须携带主轨锚点', {cueId: cue.id});
    const owner = timeline.clips.find(clip => clip.id === anchor.clipId);
    if (!owner || owner.trackId !== timeline.mainTrack.trackId
      || cue.startFrame !== owner.startFrame + anchor.offsetFrames
      || anchor.offsetFrames >= owner.durationFrames) invalid('字幕锚点必须指向开始帧所在的主轨片段', {cueId: cue.id});
  }
  const sorted = [...cues].sort((left, right) => left.startFrame - right.startFrame || (left.id < right.id ? -1 : 1));
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!, current = sorted[index]!;
    if (previous.startFrame + previous.durationFrames > current.startFrame) {
      invalid('字幕时间不能重叠，可以首尾相接', {cueIds: [previous.id, current.id]});
    }
  }
}

/** Pure planning read: returns the before/after cue rows for one subtitle action. */
export function planSubtitleEdits(store: ProjectStore, intent: SequenceEditSubtitlesIntent): SubtitleEditsPlan {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  if (!sequenceEditSubtitlesIntentSchema.safeParse(intent).success) invalid('字幕编辑参数无效');
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline) invalid('项目没有格式 5 时间线');
  const cues = new Map((timeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  const touched = new Set<string>(), removed = new Set<string>();
  for (const edit of intent.operation.edits) {
    if (edit.kind === 'add') {
      if (cues.has(edit.cue.id)) invalid('字幕标识已存在', {cueId: edit.cue.id});
      const textIssue = getTimelineSubtitleTextIssue(edit.cue.text);
      if (textIssue) invalid(textIssue.message, {cueId: edit.cue.id});
      if (edit.cue.startFrame + edit.cue.durationFrames > timeline.durationFrames) invalid('字幕超出时间线时长', {cueId: edit.cue.id});
      const cue: Format5Cue = {id: edit.cue.id, text: edit.cue.text, startFrame: edit.cue.startFrame,
        durationFrames: edit.cue.durationFrames, anchor: anchorFor(timeline, edit.cue.startFrame, edit.cue.anchor),
        ...(edit.cue.dialogueRef !== undefined ? {dialogueRef: edit.cue.dialogueRef as never} : {})};
      cues.set(cue.id, cue); touched.add(cue.id);
    } else if (edit.kind === 'update') {
      const current = cues.get(edit.cueId);
      if (!current) invalid('字幕不存在', {cueId: edit.cueId});
      const startFrame = edit.patch.startFrame ?? current.startFrame;
      const durationFrames = edit.patch.durationFrames ?? current.durationFrames;
      const text = edit.patch.text ?? current.text;
      const textIssue = getTimelineSubtitleTextIssue(text);
      if (textIssue) invalid(textIssue.message, {cueId: edit.cueId});
      if (startFrame + durationFrames > timeline.durationFrames) invalid('字幕超出时间线时长', {cueId: edit.cueId});
      const anchor = edit.patch.anchor !== undefined || edit.patch.startFrame !== undefined
        ? anchorFor(timeline, startFrame, edit.patch.anchor) : current.anchor;
      const next: Format5Cue = {id: current.id, text, startFrame, durationFrames, anchor,
        ...(edit.patch.dialogueRef !== undefined ? {dialogueRef: edit.patch.dialogueRef as never}
          : current.dialogueRef !== undefined ? {dialogueRef: current.dialogueRef} : {})};
      if (JSON.stringify(current) !== JSON.stringify(next)) {cues.set(current.id, next); touched.add(current.id);}
    } else {
      const current = cues.get(edit.cueId);
      if (!current) invalid('字幕不存在', {cueId: edit.cueId});
      cues.delete(edit.cueId); removed.add(edit.cueId); touched.add(edit.cueId);
    }
  }
  const nextCues = [...cues.values()];
  validateTimelineCues(timeline, nextCues);
  const originalCues = new Map((timeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  const before = [...touched].map(id => originalCues.get(id)).filter(Boolean) as Format5Cue[];
  const after = [...touched].filter(id => !removed.has(id)).map(id => cues.get(id)!).filter(Boolean);
  // The cue rows live beside an optional header profile. Creating the first cue
  // also creates that profile; undoing the creation removes it again. Edits that
  // already had a profile leave the header untouched.
  const beforeProfile = timeline.subtitles ? {kind: 'unchanged' as const} : {kind: 'absent' as const};
  const afterProfile = timeline.subtitles ? {kind: 'unchanged' as const}
    : nextCues.length ? {kind: 'set' as const, value: {profileId: TIMELINE_SUBTITLE_PROFILE_ID}} : {kind: 'absent' as const};
  return {before: stateDelta(before, [], beforeProfile), after: stateDelta(after, [...removed], afterProfile),
    changedCueIds: [...touched].sort(), removedCueIds: [...removed].sort()};
}

function cueTargetRevision(store: ProjectStore, cueId: string): number {
  const row = store.db.prepare(`SELECT revision FROM project.agent_task_target_revisions_v2
    WHERE projectId=? AND kind='timeline_cue' AND targetId=?`).get(store.projectId, cueId) as Row | undefined;
  return row && Number.isSafeInteger(row.revision) ? Math.max(1, Number(row.revision)) : 1;
}

export function buildSubtitleEnvelope(store: ProjectStore, intent: SequenceEditSubtitlesIntent, options: {
  readonly requestId: string; readonly actionId: string; readonly epoch: string; readonly origin?: 'user' | 'mio';
  readonly historyPosition: number; readonly historyRevision: number;
}): SequenceEditEnvelope {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline) invalid('项目没有格式 5 时间线');
  const plan = planSubtitleEdits(store, intent);
  if (plan.changedCueIds.length === 0) throw new AppError('SEQUENCE_EDIT_NOOP', '字幕后已经是这些内容。', 409, {});
  const impact: SequenceEditImpact = {nodeIds: [], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [],
    subtitleCueIds: [...plan.removedCueIds, ...plan.changedCueIds.filter(id => !plan.removedCueIds.includes(id))]};
  const targets: SequenceEditExpectedTarget[] = impact.subtitleCueIds.map(id => ({kind: 'cue', id, revision: cueTargetRevision(store, id)}));
  const content = readProjectContentStamp(store.db).contentSequence;
  const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
  return {
    contractVersion: SEQUENCE_EDIT_CONTRACT_VERSION, projectId: store.projectId, epoch: options.epoch,
    actionId: options.actionId, requestId: options.requestId, originSide: 'timeline', ...(options.origin ? {origin: options.origin} : {}),
    filmId: timeline.mainTrack.sequenceNodeId, intents: [], subtitlesIntent: intent,
    baseline: {contentRevision: content, timelineRevision: timeline.revision, syncRevision: Number(sync?.revision ?? 1),
      historyPosition: options.historyPosition, historyRevision: options.historyRevision, targets},
    impact, allocation: {clips: [], nodes: [], splitClips: [], edges: []},
  };
}

function sameTargets(store: ProjectStore, targets: readonly SequenceEditExpectedTarget[]): boolean {
  return targets.every(target => target.kind === 'cue' && target.revision === cueTargetRevision(store, target.id));
}

export function previewSubtitleEdits(store: ProjectStore, input: {
  readonly requestId: string; readonly actionId?: string; readonly origin?: 'user' | 'mio'; readonly subtitlesIntent: SequenceEditSubtitlesIntent;
}): {envelope: SequenceEditEnvelope; planDigest: string; warnings: readonly {code: string}[]}
  | {ok: false; code: string; ids: readonly string[]} {
  if (!isFormat5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  try {
    const state = prepareSequenceEditHistory(store).state;
    const envelope = buildSubtitleEnvelope(store, input.subtitlesIntent, {
      requestId: input.requestId, actionId: input.actionId ?? crypto.randomUUID(), epoch: state.epoch, ...(input.origin ? {origin: input.origin} : {}),
      historyPosition: state.position, historyRevision: state.revision});
    return {envelope, planDigest: sequenceEditInputDigest(envelope), warnings: []};
  } catch (error) {
    if (error instanceof AppError && error.code === 'SEQUENCE_EDIT_NOOP') return failure('SEQUENCE_EDIT_NOOP');
    if (error instanceof AppError) return failure(error.code);
    throw error;
  }
}

export function runSubtitleEditsSync(store: ProjectStore, envelope: SequenceEditEnvelope): {
  readonly ok: true; readonly actionId: string; readonly operation: string; readonly patch: unknown; readonly receipt: unknown;
} | {readonly ok: false; readonly code: string; readonly ids: readonly string[]} {
  if (!isFormat5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  const intent = envelope.subtitlesIntent;
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
    if (!timeline) return failure('SEQUENCE_EDIT_SUBTITLE_INVALID');
    const content = readProjectContentStamp(store.db).contentSequence;
    const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
    if (envelope.baseline.contentRevision !== content || envelope.baseline.timelineRevision !== timeline.revision
      || envelope.baseline.syncRevision !== Number(sync?.revision ?? 1) || !sameTargets(store, envelope.baseline.targets)) {
      writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_REVISION_CONFLICT');
      return failure('SEQUENCE_EDIT_REVISION_CONFLICT');
    }
    let plan: SubtitleEditsPlan;
    try {plan = planSubtitleEdits(store, intent);}
    catch (error) {
      if (error instanceof AppError && error.code === 'SEQUENCE_EDIT_SUBTITLE_INVALID') {
        writeSequenceEditFailure(store, envelope, error.code);
        return failure(error.code);
      }
      throw error;
    }
    if (plan.changedCueIds.length === 0) {
      writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_NOOP');
      return failure('SEQUENCE_EDIT_NOOP');
    }
    const applied = applySequenceEditTimelineDelta(store, plan.after.timeline);
    const contentRevision = readProjectContentStamp(store.db).contentSequence;
    const affected = {nodes: 0, edges: 0, mainTrackClips: 0, otherTrackItems: 0,
      subtitleCues: plan.changedCueIds.length};
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
