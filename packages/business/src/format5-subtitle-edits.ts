/** FR-B + DL-a: format-5 subtitle cue structure as one shared `sequence-edit`
 * action.
 *
 * Add/update/remove keep the TSb anchor rule (`startFrame = owner.startFrame +
 * anchor.offsetFrames`), reject overlaps and reuse the shared history/undo path.
 * No clip or baseline row is touched, so undo restores exactly the cue rows.
 *
 * DL-a linkage (coordinator review item 2): a cue whose `dialogueRef` is set is
 * a projection of one shot dialogue line. Editing its text writes the same line
 * into `shot.data.dialogue` in the same transaction; removing it removes the
 * line (both sides delete a line equivalently, P5 D7); `add` always creates an
 * ordinary subtitle. Linking or unlinking is owned by the dialogue intent, never
 * by a subtitle edit. A cue may stay detached (`anchor: null`, a floating shot's
 * subtitle) and only its text is editable through this entry.
 */
import {AppError} from '../../contracts/src/app-error.ts';
import {sequenceEditPreviewFailure} from './format5-sequence-preview-errors.ts';
import {getFormat5CueIssue, format5AnchorSchema, format5DialogueSchema} from '../../contracts/src/project-format5.ts';
import type {Format5Anchor, Format5Cue, Format5Dialogue, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {getTimelineSubtitleTextIssue, TIMELINE_SUBTITLE_PROFILE_ID} from '../../contracts/src/timeline-subtitles.ts';
import type {
  SequenceEditEnvelope, SequenceEditExpectedTarget, SequenceEditImpact,
  SequenceEditStateDelta, SequenceEditSubtitlesIntent, SequenceEditTimelineDelta,
} from '../../contracts/src/sequence-edit.ts';
import {SEQUENCE_EDIT_CONTRACT_VERSION, sequenceEditEnvelopeOperationName, sequenceEditSubtitlesIntentSchema} from '../../contracts/src/sequence-edit.ts';
import type {ProjectStore} from './project-file/store.ts';
import {isSequenceProjectFormat} from './project-file/schema/databases.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {applySequenceEditTimelineDelta} from './format5-sequence-sync.ts';
import {prepareSequenceEditHistory, findSequenceEditReceipt, sequenceEditInputDigest, writeSequenceEditAction,
  writeSequenceEditFailure} from './format5-editor-history.ts';
import type {SequenceEditReceiptDraft} from './format5-editor-history.ts';

type Row = Record<string, unknown>;
const isFormat5 = (store: ProjectStore): boolean =>
  isSequenceProjectFormat(Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version));
function invalid(message: string, details: Row = {}): never {
  throw new AppError('SEQUENCE_EDIT_SUBTITLE_INVALID', message, 409, details);
}
const failure = (code: string): {ok: false; code: string; ids: readonly string[]} => ({ok: false, code, ids: []});
const UNCHANGED: Omit<SequenceEditTimelineDelta, 'cues' | 'removedCueIds' | 'subtitles'> = Object.freeze({
  clips: [], removedClipIds: [], baseline: Object.freeze({kind: 'unchanged' as const}),
});
const stateDelta = (cues: readonly Format5Cue[], removedCueIds: readonly string[],
  subtitles: NonNullable<SequenceEditTimelineDelta['subtitles']>,
  shots: readonly {id: string; data: Row}[] = []): SequenceEditStateDelta =>
  ({board: {writes: shots.map(shot => ({kind: 'shot' as const, id: shot.id, data: shot.data})), removals: []},
    timeline: {...UNCHANGED, cues, removedCueIds, subtitles}});

export interface SubtitleEditsPlan {
  readonly before: SequenceEditStateDelta;
  readonly after: SequenceEditStateDelta;
  readonly changedCueIds: readonly string[];
  readonly removedCueIds: readonly string[];
  /** Shots whose dialogue lines changed together with their linked cues. */
  readonly changedShotIds: readonly string[];
}

const now = (): string => new Date().toISOString();

type DialogueLineRow = {id: string; text: string; speakerSubjectId?: string};
interface ShotDialogueRows {
  readonly row: Row;
  readonly lines: DialogueLineRow[];
  readonly before: Row;
}
/** Read one live shot row and its validated dialogue lines. */
function readShotDialogue(store: ProjectStore, shotId: string): ShotDialogueRows {
  const row = store.db.prepare('SELECT id,projectId,archivedAt,data FROM project.shots WHERE id=? AND projectId=?')
    .get(shotId, store.projectId) as Row | undefined;
  if (!row) invalid('字幕关联的镜头不存在或不属于当前项目', {shotId});
  if (row.archivedAt !== null && row.archivedAt !== undefined) invalid('字幕关联的镜头已归档', {shotId});
  let data: Row;
  try { data = JSON.parse(String(row.data)) as Row; } catch { invalid('镜头内容无效', {shotId}); }
  const parsed = format5DialogueSchema.safeParse(data.dialogue ?? []);
  if (!parsed.success) invalid('镜头台词内容无效', {shotId});
  return {row: data, before: data, lines: parsed.data.map(line => line.speakerSubjectId !== undefined
    ? {id: line.id, text: line.text, speakerSubjectId: line.speakerSubjectId}
    : {id: line.id, text: line.text})};
}
function writeShotDialogue(_store: ProjectStore, shot: ShotDialogueRows): Row {
  const next = {...shot.row, updatedAt: now()} as Row;
  if (shot.lines.length === 0) delete next.dialogue;
  else next.dialogue = shot.lines.map(line => line.speakerSubjectId !== undefined
    ? {id: line.id, text: line.text, speakerSubjectId: line.speakerSubjectId}
    : {id: line.id, text: line.text});
  return next;
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
    // A floating shot keeps its subtitles detached (`anchor: null`); only the
    // text is edited through this entry and the anchor stays as it is.
    if (anchor === null) continue;
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
  const shots = new Map<string, ShotDialogueRows>();
  const shotFor = (shotId: string): ShotDialogueRows => {
    const existing = shots.get(shotId);
    if (existing) return existing;
    if (!timeline.mainTrack.sequenceNodeId) invalid('时间线没有成片根');
    const shot = readShotDialogue(store, shotId);
    shots.set(shotId, shot);
    return shot;
  };
  const lineOfCue = (cue: Format5Cue): DialogueLineRow => {
    const ref = cue.dialogueRef;
    if (!ref) invalid('字幕没有关联的镜头台词', {cueId: cue.id});
    const shot = shotFor(ref.shotId);
    const line = shot.lines.find(item => item.id === ref.lineId);
    if (!line) invalid('字幕关联的台词行不存在', {cueId: cue.id});
    return line;
  };
  for (const edit of intent.operation.edits) {
    if (edit.kind === 'add') {
      if (cues.has(edit.cue.id)) invalid('字幕标识已存在', {cueId: edit.cue.id});
      const textIssue = getTimelineSubtitleTextIssue(edit.cue.text);
      if (textIssue) invalid(textIssue.message, {cueId: edit.cue.id});
      if (edit.cue.startFrame + edit.cue.durationFrames > timeline.durationFrames) invalid('字幕超出时间线时长', {cueId: edit.cue.id});
      // DL-a: `add` always produces an ordinary subtitle; linking belongs to the
      // dialogue intent, so a supplied dialogueRef is deliberately not stored.
      const cue: Format5Cue = {id: edit.cue.id, text: edit.cue.text, startFrame: edit.cue.startFrame,
        durationFrames: edit.cue.durationFrames, anchor: anchorFor(timeline, edit.cue.startFrame, edit.cue.anchor)};
      cues.set(cue.id, cue); touched.add(cue.id);
    } else if (edit.kind === 'update') {
      const current = cues.get(edit.cueId);
      if (!current) invalid('字幕不存在', {cueId: edit.cueId});
      // Linking/unlinking is a dialogue-intent action, never a subtitle edit.
      if (edit.patch.dialogueRef !== undefined) invalid('字幕关联由镜头台词维护', {cueId: edit.cueId});
      const startFrame = edit.patch.startFrame ?? current.startFrame;
      const durationFrames = edit.patch.durationFrames ?? current.durationFrames;
      const text = edit.patch.text ?? current.text;
      const textIssue = getTimelineSubtitleTextIssue(text);
      if (textIssue) invalid(textIssue.message, {cueId: edit.cueId});
      if (startFrame + durationFrames > timeline.durationFrames) invalid('字幕超出时间线时长', {cueId: edit.cueId});
      const anchor = edit.patch.anchor !== undefined || edit.patch.startFrame !== undefined
        ? anchorFor(timeline, startFrame, edit.patch.anchor) : current.anchor;
      const next: Format5Cue = {id: current.id, text, startFrame, durationFrames, anchor,
        ...(current.dialogueRef !== undefined && current.dialogueRef !== null ? {dialogueRef: current.dialogueRef} : {})};
      if (JSON.stringify(current) !== JSON.stringify(next)) {
        // DL-a: the linked shot line text follows the subtitle text in the same
        // transaction; timing/anchor edits keep the link and do not touch the line.
        if (edit.patch.text !== undefined && current.dialogueRef) {
          const line = lineOfCue(current);
          line.text = text;
        }
        cues.set(current.id, next); touched.add(current.id);
      }
    } else {
      const current = cues.get(edit.cueId);
      if (!current) invalid('字幕不存在', {cueId: edit.cueId});
      // DL-a: removing a linked cue removes its dialogue line as well (P5 D7:
      // deleting a line on either side is equivalent). Its cue is already gone,
      // so the remaining lines keep their one-cue projection.
      if (current.dialogueRef) {
        const shot = shotFor(current.dialogueRef.shotId);
        const index = shot.lines.findIndex(item => item.id === current.dialogueRef!.lineId);
        if (index < 0) invalid('字幕关联的台词行不存在', {cueId: edit.cueId});
        shot.lines.splice(index, 1);
      }
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
  // The shared delta applier is incremental (write these rows, delete these ids),
  // so the inverse patch must list rows the other side created. A full-list
  // rewrite would make undoing an `add` leave the new cue behind.
  const beforeCues = timeline.subtitles?.cues ?? [];
  const beforeIds = new Set(beforeCues.map(cue => cue.id));
  const afterIds = new Set(nextCues.map(cue => cue.id));
  const createdCueIds = nextCues.filter(cue => !beforeIds.has(cue.id)).map(cue => cue.id);
  const deletedCueIds = beforeCues.filter(cue => !afterIds.has(cue.id)).map(cue => cue.id);
  const shotWrites = [...shots.entries()].map(([id, shot]) => ({id, data: writeShotDialogue(store, shot)}))
    .filter((entry, index) => JSON.stringify(entry.data) !== JSON.stringify([...shots.values()][index]!.before));
  const beforeShots = [...shots.entries()].filter(([id]) => shotWrites.some(entry => entry.id === id))
    .map(([id, shot]) => ({id, data: shot.row}));
  return {before: stateDelta(beforeCues, createdCueIds, beforeProfile, beforeShots),
    after: stateDelta(nextCues, deletedCueIds, afterProfile, shotWrites),
    changedCueIds: [...touched].sort(), removedCueIds: deletedCueIds.sort(),
    changedShotIds: shotWrites.map(entry => entry.id).sort()};
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

export function buildSubtitleEnvelope(store: ProjectStore, intent: SequenceEditSubtitlesIntent, options: {
  readonly requestId: string; readonly actionId: string; readonly epoch: string; readonly origin?: 'user' | 'mio';
  readonly historyPosition: number; readonly historyRevision: number;
}): SequenceEditEnvelope {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline) invalid('项目没有格式 5 时间线');
  const plan = planSubtitleEdits(store, intent);
  if (plan.changedCueIds.length === 0) throw new AppError('SEQUENCE_EDIT_NOOP', '字幕后已经是这些内容。', 409, {});
  const impact: SequenceEditImpact = {nodeIds: plan.changedShotIds, edgeIds: [], mainTrackClipIds: [],
    otherTrackItemIds: [],
    subtitleCueIds: [...plan.removedCueIds, ...plan.changedCueIds.filter(id => !plan.removedCueIds.includes(id))]};
  const targets: SequenceEditExpectedTarget[] = [
    ...impact.subtitleCueIds.map(id => ({kind: 'cue' as const, id, revision: cueTargetRevision(store, id)})),
    ...plan.changedShotIds.map(id => ({kind: 'shot' as const, id, revision: shotTargetRevision(store, id)})),
  ];
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
  return targets.every(target => target.kind === 'cue'
    ? target.revision === cueTargetRevision(store, target.id)
    : target.kind === 'shot' && target.revision === shotTargetRevision(store, target.id));
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
    if (error instanceof AppError) return sequenceEditPreviewFailure(error);
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
    for (const entity of plan.after.board.writes) store.put('shots', entity.data);
    const applied = applySequenceEditTimelineDelta(store, plan.after.timeline);
    const contentRevision = readProjectContentStamp(store.db).contentSequence;
    const affected = {nodes: plan.changedShotIds.length, edges: 0, mainTrackClips: 0, otherTrackItems: 0,
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
