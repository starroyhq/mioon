/** DL-a: format-5 shot dialogue lines and their subtitle cue projection.
 *
 * `shot.data.dialogue` is the ordered source of truth for a shot's lines. A line
 * is viewed in the shot properties (board side) and, while the shot is on the
 * main track, projected to one real subtitle cue (`cue.dialogueRef =
 * {shotId,lineId}`). Editing either side writes the same line and refreshes the
 * cue in one `sequence-edit` action; one undo restores both sides.
 *
 * Row identity: a projected cue is derived from `(timelineId, shotId, lineId)`
 * and a copied shot's line from `(newShotId, sourceLineIndex)`. Preview, retry,
 * commit and undo/redo therefore always reproduce the same bytes instead of
 * allocating ids inside a plan (a board action can create many cues at once).
 *
 * Ownership rules kept from plan §2.3/§2.4 and P5 D7:
 * - a shot on the main track has one cue per valid line;
 * - default timing uses consecutive legal frames inside the shot span and never
 *   overlaps an ordinary cue; a span that cannot fit its lines rejects the whole
 *   action (`SEQUENCE_EDIT_DIALOGUE_CONFLICT`) instead of truncating text;
 * - a floating shot keeps its cues in place with `anchor: null`, still linked;
 * - re-entering the main track reuses the existing cues instead of creating
 *   duplicates;
 * - an archived shot's cues become ordinary cues (no `dialogueRef`); undo
 *   restores the link from the history patch;
 * - ordinary cues are never renamed, moved or guessed into dialogue.
 */
import {AppError} from '@mioon/contracts';
import {dialogueConflictMessage, sequenceEditPreviewFailure, type SequenceEditPreviewFailure} from './format5-sequence-preview-errors.ts';
import {format5DialogueSchema, getFormat5TimelineIssue} from '../../contracts/src/project-format5.ts';
import type {Format5Cue, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {getTimelineSubtitleTextIssue} from '../../contracts/src/timeline-subtitles.ts';
import type {
  SequenceEditDialogueEdit, SequenceEditDialogueIntent, SequenceEditDialogueLine, SequenceEditEnvelope,
  SequenceEditExpectedTarget, SequenceEditImpact, SequenceEditStateDelta, SequenceEditSubtitleProfileChange,
  SequenceEditTimelineDelta,
} from '../../contracts/src/sequence-edit.ts';
import {SEQUENCE_EDIT_CONTRACT_VERSION, sequenceEditEnvelopeOperationName} from '../../contracts/src/sequence-edit.ts';
import type {ProjectStore} from './project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {applySequenceEditTimelineDelta} from './format5-sequence-sync.ts';
import {
  findSequenceEditReceipt, prepareSequenceEditHistory, sequenceEditInputDigest, writeSequenceEditAction,
  writeSequenceEditFailure,
} from './format5-editor-history.ts';
import type {SequenceEditReceiptDraft} from './format5-editor-history.ts';
import {
  format5ShotDialogue, projectFormat5DialogueCues, withFormat5ShotDialogue,
} from './format5-dialogue-projection.ts';
import type {Format5DialogueProjectedShot} from './format5-dialogue-projection.ts';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const isFormat5 = (store: ProjectStore): boolean =>
  Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === FORMAT5_PROJECT_SCHEMA_VERSION;
function invalid(message: string, details: Row = {}): never {
  throw new AppError('SEQUENCE_EDIT_DIALOGUE_INVALID', message, 409, details);
}
function conflict(message: string, ids: readonly string[]): never {
  throw new AppError('SEQUENCE_EDIT_DIALOGUE_CONFLICT', message, 409, {ids});
}
const failure = (code: string, ids: readonly string[] = []): {ok: false; code: string; ids: readonly string[]} =>
  ({ok: false, code, ids});

// ---------------------------------------------------------------------------
// Dialogue intent planning (board side + linked cue text)
// ---------------------------------------------------------------------------

export interface DialogueActionPlan {
  readonly before: SequenceEditStateDelta;
  readonly after: SequenceEditStateDelta;
  readonly changedShotIds: readonly string[];
  readonly changedCueIds: readonly string[];
  readonly removedCueIds: readonly string[];
  readonly createdCueIds: readonly string[];
  readonly nextTimeline: Format5Timeline;
}

const UNCHANGED_TIMELINE: Omit<SequenceEditTimelineDelta, 'cues' | 'removedCueIds' | 'subtitles'> = Object.freeze({
  clips: [], removedClipIds: [], baseline: Object.freeze({kind: 'unchanged' as const}),
});

function timelineDelta(cues: readonly Format5Cue[], removedCueIds: readonly string[],
  subtitles: SequenceEditSubtitleProfileChange): SequenceEditTimelineDelta {
  return {...UNCHANGED_TIMELINE, cues, removedCueIds, subtitles};
}
function boardWrites(rows: readonly {id: string; data: Row}[]): SequenceEditStateDelta['board'] {
  return {writes: rows.map(row => ({kind: 'shot' as const, id: row.id, data: row.data})), removals: []};
}

function liveShotRow(store: ProjectStore, shotId: string): Row {
  const row = store.db.prepare('SELECT id,projectId,archivedAt,data FROM project.shots WHERE id=? AND projectId=?')
    .get(shotId, store.projectId) as Row | undefined;
  if (!row) invalid('镜头不存在或不属于当前项目', {shotId});
  if (row.archivedAt !== null && row.archivedAt !== undefined) invalid('镜头已归档，不能编辑台词', {shotId});
  let data: unknown;
  try { data = JSON.parse(String(row.data)); } catch { invalid('镜头内容无效', {shotId}); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) invalid('镜头内容无效', {shotId});
  return data as Row;
}

function projectSubjectIds(store: ProjectStore): Set<string> {
  return new Set((store.db.prepare('SELECT id FROM project.subjects WHERE projectId=?').all(store.projectId) as Row[])
    .map(row => String(row.id)));
}

function mainTrackSegments(timeline: Format5Timeline): Map<string, {clipId: string; startFrame: number; durationFrames: number}[]> {
  const groups = new Map<string, {clipId: string; startFrame: number; durationFrames: number}[]>();
  for (const clip of timeline.clips) {
    if (clip.trackId !== timeline.mainTrack.trackId) continue;
    if (clip.sequenceSource?.kind !== 'shot') continue;
    const list = groups.get(clip.sequenceSource.nodeId) ?? [];
    list.push({clipId: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames});
    groups.set(clip.sequenceSource.nodeId, list);
  }
  for (const list of groups.values()) list.sort((left, right) => left.startFrame - right.startFrame || left.clipId.localeCompare(right.clipId));
  return groups;
}

function validateLines(lines: readonly SequenceEditDialogueLine[], subjects: ReadonlySet<string>, shotId: string): void {
  if (new Set(lines.map(line => line.id)).size !== lines.length) invalid('台词行 ID 重复', {shotId});
  for (const line of lines) {
    const textIssue = getTimelineSubtitleTextIssue(line.text);
    if (textIssue) invalid(textIssue.message, {shotId, lineId: line.id});
    if (line.speakerSubjectId !== undefined && !subjects.has(line.speakerSubjectId)) invalid('说话人不是本项目的主体', {shotId, lineId: line.id});
  }
  const parsed = format5DialogueSchema.safeParse(lines.map(line => line.speakerSubjectId !== undefined
    ? {id: line.id, text: line.text, speakerSubjectId: line.speakerSubjectId}
    : {id: line.id, text: line.text}));
  if (!parsed.success) invalid('台词内容不符合格式 5 语法', {shotId});
}

function applyEdits(lines: readonly SequenceEditDialogueLine[], edits: readonly SequenceEditDialogueEdit[],
  shotId: string, cueToLine: (cueId: string) => {shotId: string; lineId: string} | null): SequenceEditDialogueLine[] {
  let current = lines.map(line => ({...line}));
  for (const edit of edits) {
    if (edit.kind === 'reorder') {
      if (edit.shotId !== shotId) continue;
      const known = new Set(current.map(line => line.id));
      if (edit.lineIds.length !== current.length || edit.lineIds.some(id => !known.has(id))) invalid('排序必须包含全部台词行且不能重复', {shotId});
      const byId = new Map(current.map(line => [line.id, line] as const));
      current = edit.lineIds.map(id => byId.get(id)!);
      continue;
    }
    if (edit.kind === 'set-text-by-cue') {
      const ref = cueToLine(edit.cueId);
      if (!ref) invalid('字幕没有关联的镜头台词', {cueId: edit.cueId});
      if (ref.shotId !== shotId) continue;
      const index = current.findIndex(line => line.id === ref.lineId);
      if (index < 0) invalid('字幕关联的台词行不存在', {cueId: edit.cueId, shotId});
      current = current.map((line, at) => at === index ? {...line, text: edit.text} : line);
      continue;
    }
    if (edit.shotId !== shotId) continue;
    if (edit.kind === 'add') {
      if (current.some(line => line.id === edit.line.id)) invalid('台词行 ID 已存在', {shotId, lineId: edit.line.id});
      const line: SequenceEditDialogueLine = {...edit.line};
      if (edit.beforeLineId === undefined || edit.beforeLineId === null) current.push(line);
      else {
        const index = current.findIndex(item => item.id === edit.beforeLineId);
        if (index < 0) invalid('插入位置不在这个镜头', {shotId, lineId: edit.beforeLineId});
        current = [...current.slice(0, index), line, ...current.slice(index)];
      }
      continue;
    }
    const index = current.findIndex(line => line.id === edit.lineId);
    if (index < 0) invalid('台词行不存在', {shotId, lineId: edit.lineId});
    if (edit.kind === 'remove') {current = current.filter((_line, at) => at !== index); continue;}
    current = current.map((line, at) => {
      if (at !== index) return line;
      const next: SequenceEditDialogueLine = {...line, ...(edit.text === undefined ? {} : {text: edit.text})};
      if (edit.speakerSubjectId === undefined) return next;
      if (edit.speakerSubjectId === null) {delete (next as {speakerSubjectId?: string}).speakerSubjectId; return next;}
      return {...next, speakerSubjectId: edit.speakerSubjectId};
    });
  }
  return current;
}

function sameLines(left: readonly SequenceEditDialogueLine[], right: readonly SequenceEditDialogueLine[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Pure planning read: the before/after deltas of one dialogue action. */
export function planDialogueAction(store: ProjectStore, intent: SequenceEditDialogueIntent): DialogueActionPlan {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline) invalid('项目没有格式 5 时间线');
  const cueById = new Map((timeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  const cueToLine = (cueId: string): {shotId: string; lineId: string} | null => {
    const cue = cueById.get(cueId);
    if (!cue || !cue.dialogueRef) return null;
    return {shotId: cue.dialogueRef.shotId, lineId: cue.dialogueRef.lineId};
  };
  const subjects = projectSubjectIds(store);
  const touchedShots = new Set<string>();
  for (const edit of intent.operation.edits) {
    if (edit.kind === 'set-text-by-cue') {
      const ref = cueToLine(edit.cueId);
      if (!ref) invalid('字幕没有关联的镜头台词', {cueId: edit.cueId});
      touchedShots.add(ref.shotId);
    } else touchedShots.add(edit.shotId);
  }
  const segmentsByShot = mainTrackSegments(timeline);
  const beforeShots: {id: string; data: Row}[] = [];
  const afterShots: {id: string; data: Row}[] = [];
  const projectedShots: Format5DialogueProjectedShot[] = [];
  const linesByShot = new Map<string, SequenceEditDialogueLine[]>();
  for (const shotId of [...touchedShots].sort()) {
    const row = liveShotRow(store, shotId);
    const before = format5ShotDialogue(row);
    const after = applyEdits(before, intent.operation.edits, shotId, cueToLine);
    validateLines(after, subjects, shotId);
    linesByShot.set(shotId, after);
    if (sameLines(before, after)) continue;
    beforeShots.push({id: shotId, data: row});
    const nextRow = withFormat5ShotDialogue(row, after);
    nextRow.updatedAt = now();
    afterShots.push({id: shotId, data: nextRow});
    const segments = segmentsByShot.get(shotId);
    if (segments) projectedShots.push({shotId, lines: after, segments});
  }
  if (afterShots.length === 0) {
    return {before: {board: {writes: [], removals: []}, timeline: timelineDelta([], [], {kind: 'unchanged'})},
      after: {board: {writes: [], removals: []}, timeline: timelineDelta([], [], {kind: 'unchanged'})},
      changedShotIds: [], changedCueIds: [], removedCueIds: [], createdCueIds: [], nextTimeline: timeline};
  }
  const linkedShots = new Map<string, {id: string; text: string}[]>();
  for (const [shotId, lines] of linesByShot) {
    if (segmentsByShot.has(shotId)) continue;
    linkedShots.set(shotId, lines.map(line => ({id: line.id, text: line.text})));
  }
  const projection = projectFormat5DialogueCues({
    timelineId: timeline.id,
    cues: timeline.subtitles?.cues ?? [],
    subtitleProfilePresent: timeline.subtitles !== undefined,
    shots: projectedShots,
    previousMainShotIds: new Set(segmentsByShot.keys()),
    previousCues: cueById,
    ...(linkedShots.size ? {linkedShots} : {}),
    liveShotIds: new Set([...store.db.prepare('SELECT id FROM project.shots WHERE projectId=? AND archivedAt IS NULL')
      .all(store.projectId) as Row[]].map(item => String(item.id))),
  });
  if (projection.ok === false) {
    throw new AppError(projection.code, dialogueConflictMessage(projection.dialogueConflict), 409,
      {ids: projection.ids, dialogueConflict: projection.dialogueConflict});
  }
  const beforeCues = new Map((timeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  const afterCues = new Map(projection.cues.map(cue => [cue.id, cue] as const));
  const touchedCueIds = new Set([...projection.changedCueIds, ...projection.removedCueIds]);
  const beforeChangedCues = [...touchedCueIds].map(id => beforeCues.get(id)).filter((cue): cue is Format5Cue => !!cue);
  const afterChangedCues = [...touchedCueIds].map(id => afterCues.get(id)).filter((cue): cue is Format5Cue => !!cue);
  const createdCueIds = afterChangedCues.filter(cue => !beforeCues.has(cue.id)).map(cue => cue.id);
  const removedCueIds = [...projection.removedCueIds];
  // Undo must also delete the cues this action created.
  const beforeSubtitles: SequenceEditSubtitleProfileChange = timeline.subtitles ? {kind: 'unchanged'} : {kind: 'absent'};
  const subtitleProfile = projection.subtitles.kind === 'unchanged'
    ? (timeline.subtitles ? {profileId: timeline.subtitles.profileId,
      ...(timeline.subtitles.basisPresetId === undefined ? {} : {basisPresetId: timeline.subtitles.basisPresetId})} : null)
    : projection.subtitles.kind === 'set' ? projection.subtitles.value as {profileId: string; basisPresetId?: string}
      : null;
  const nextTimeline: Format5Timeline = {...timeline, revision: timeline.revision + 1, updatedAt: now(),
    subtitles: subtitleProfile ? {...subtitleProfile, cues: projection.cues as Format5Cue[]} : undefined};
  const issue = getFormat5TimelineIssue(nextTimeline, {projectId: store.projectId});
  if (issue) conflict('字幕投影后时间线不合法', issue.ids ?? []);
  return {
    before: {board: boardWrites(beforeShots),
      timeline: timelineDelta(beforeChangedCues, createdCueIds, beforeSubtitles)},
    after: {board: boardWrites(afterShots),
      timeline: timelineDelta(afterChangedCues, removedCueIds, projection.subtitles)},
    changedShotIds: afterShots.map(row => row.id).sort(),
    changedCueIds: [...new Set([...projection.changedCueIds, ...removedCueIds])].sort(),
    removedCueIds, createdCueIds, nextTimeline,
  };
}

function shotTargetRevision(store: ProjectStore, shotId: string): number {
  const row = store.db.prepare(`SELECT revision FROM project.agent_task_target_revisions_v2
    WHERE projectId=? AND kind='shot' AND targetId=?`).get(store.projectId, shotId) as Row | undefined;
  return row && Number.isSafeInteger(row.revision) ? Math.max(1, Number(row.revision)) : 1;
}
function cueTargetRevision(store: ProjectStore, cueId: string): number {
  const row = store.db.prepare(`SELECT revision FROM project.agent_task_target_revisions_v2
    WHERE projectId=? AND kind='timeline_cue' AND targetId=?`).get(store.projectId, cueId) as Row | undefined;
  return row && Number.isSafeInteger(row.revision) ? Math.max(1, Number(row.revision)) : 1;
}

function dialogueImpact(plan: DialogueActionPlan): SequenceEditImpact {
  return {nodeIds: plan.changedShotIds, edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [],
    subtitleCueIds: plan.changedCueIds};
}

export function buildDialogueEnvelope(store: ProjectStore, intent: SequenceEditDialogueIntent, options: {
  readonly requestId: string; readonly actionId: string; readonly epoch: string; readonly origin?: 'user' | 'mio';
  readonly historyPosition: number; readonly historyRevision: number;
}): SequenceEditEnvelope {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline) invalid('项目没有格式 5 时间线');
  const plan = planDialogueAction(store, intent);
  if (plan.changedShotIds.length === 0 && plan.changedCueIds.length === 0) {
    throw new AppError('SEQUENCE_EDIT_NOOP', '台词已经是这些内容。', 409, {});
  }
  const targets: SequenceEditExpectedTarget[] = [
    ...plan.changedShotIds.map(id => ({kind: 'shot' as const, id, revision: shotTargetRevision(store, id)})),
    ...plan.changedCueIds.filter(id => !plan.createdCueIds.includes(id))
      .map(id => ({kind: 'cue' as const, id, revision: cueTargetRevision(store, id)})),
  ];
  const content = readProjectContentStamp(store.db).contentSequence;
  const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
  return {
    contractVersion: SEQUENCE_EDIT_CONTRACT_VERSION, projectId: store.projectId, epoch: options.epoch,
    actionId: options.actionId, requestId: options.requestId, originSide: intent.side,
    ...(options.origin ? {origin: options.origin} : {}),
    filmId: timeline.mainTrack.sequenceNodeId, intents: [], dialogueIntent: intent,
    baseline: {contentRevision: content, timelineRevision: timeline.revision, syncRevision: Number(sync?.revision ?? 1),
      historyPosition: options.historyPosition, historyRevision: options.historyRevision, targets},
    impact: dialogueImpact(plan), allocation: {clips: [], nodes: [], splitClips: [], edges: []},
  };
}

export function previewDialogueAction(store: ProjectStore, input: {
  readonly requestId: string; readonly actionId?: string; readonly origin?: 'user' | 'mio';
  readonly dialogueIntent: SequenceEditDialogueIntent;
}): {envelope: SequenceEditEnvelope; planDigest: string; warnings: readonly {code: string}[]}
  | {ok: false; code: string; ids: readonly string[]} {
  if (!isFormat5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  try {
    const state = prepareSequenceEditHistory(store).state;
    const envelope = buildDialogueEnvelope(store, input.dialogueIntent, {
      requestId: input.requestId, actionId: input.actionId ?? crypto.randomUUID(), epoch: state.epoch,
      ...(input.origin ? {origin: input.origin} : {}),
      historyPosition: state.position, historyRevision: state.revision});
    return {envelope, planDigest: sequenceEditInputDigest(envelope), warnings: []};
  } catch (error) {
    if (error instanceof AppError && (error.code === 'SEQUENCE_EDIT_NOOP' || error.code === 'SEQUENCE_EDIT_DIALOGUE_INVALID'
      || error.code === 'SEQUENCE_EDIT_DIALOGUE_CONFLICT')) {
      return sequenceEditPreviewFailure(error);
    }
    throw error;
  }
}

function reviseTargets(store: ProjectStore, targets: readonly SequenceEditExpectedTarget[]): boolean {
  return targets.every(target => target.kind === 'shot'
    ? target.revision === shotTargetRevision(store, target.id)
    : target.kind === 'cue' ? target.revision === cueTargetRevision(store, target.id) : false);
}

/** One transaction: replay, CAS, planning, shot + cue rows, one history entry. */
export function runDialogueAction(store: ProjectStore, envelope: SequenceEditEnvelope): {
  readonly ok: true; readonly actionId: string; readonly operation: string; readonly patch: unknown; readonly receipt: unknown;
} | SequenceEditPreviewFailure {
  if (!isFormat5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  const intent = envelope.dialogueIntent;
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
    if (!timeline) return failure('SEQUENCE_EDIT_DIALOGUE_INVALID');
    const content = readProjectContentStamp(store.db).contentSequence;
    const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
    if (envelope.baseline.contentRevision !== content || envelope.baseline.timelineRevision !== timeline.revision
      || envelope.baseline.syncRevision !== Number(sync?.revision ?? 1) || !reviseTargets(store, envelope.baseline.targets)) {
      writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_REVISION_CONFLICT');
      return failure('SEQUENCE_EDIT_REVISION_CONFLICT');
    }
    let plan: DialogueActionPlan;
    try { plan = planDialogueAction(store, intent); }
    catch (error) {
      if (error instanceof AppError && (error.code === 'SEQUENCE_EDIT_DIALOGUE_INVALID' || error.code === 'SEQUENCE_EDIT_DIALOGUE_CONFLICT')) {
        writeSequenceEditFailure(store, envelope, error.code);
        return sequenceEditPreviewFailure(error);
      }
      throw error;
    }
    if (plan.changedShotIds.length === 0 && plan.changedCueIds.length === 0) {
      writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_NOOP');
      return failure('SEQUENCE_EDIT_NOOP');
    }
    for (const entity of plan.after.board.writes) store.put('shots', entity.data);
    const applied = applySequenceEditTimelineDelta(store, plan.after.timeline);
    const contentRevision = readProjectContentStamp(store.db).contentSequence;
    const receipt: SequenceEditReceiptDraft = {
      version: SEQUENCE_EDIT_CONTRACT_VERSION, requestId: envelope.requestId, inputDigest,
      projectId: store.projectId, actionId: envelope.actionId,
      operation: sequenceEditEnvelopeOperationName(envelope), originSide: envelope.originSide, status: 'applied',
      affected: {nodes: plan.after.board.writes.length, edges: 0, mainTrackClips: 0, otherTrackItems: 0,
        subtitleCues: plan.changedCueIds.length},
      contentRevision, timelineRevision: applied.timelineRevision, syncRevision: Number(sync?.revision ?? 1),
    };
    const patch = {version: SEQUENCE_EDIT_CONTRACT_VERSION, before: plan.before, after: plan.after};
    const stored = writeSequenceEditAction(store, {envelope, patch, receipt});
    return {ok: true, actionId: envelope.actionId, operation: stored.operation, patch, receipt: stored};
  });
}
