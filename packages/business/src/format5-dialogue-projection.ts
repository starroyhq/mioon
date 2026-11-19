/** Format-5 dialogue projection core (DL-a).
 *
 * Pure row/projection logic shared by the dialogue action coordinator and the
 * main-track sync projection. No store, no IO, no transaction: callers read the
 * live state and hand the same plain arrays in.
 */
import {createHash} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {TIMELINE_SUBTITLE_PROFILE_ID} from '@mioon/contracts';
import {format5DialogueSchema} from '../../contracts/src/project-format5.ts';
import type {Format5Cue, Format5Dialogue} from '../../contracts/src/project-format5.ts';
import type {SequenceEditDialogueLine, SequenceEditSubtitleProfileChange} from '../../contracts/src/sequence-edit.ts';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Stable identities
// ---------------------------------------------------------------------------

const CUE_ID_DOMAIN = 'mioon.format5.dialogue-cue.v1';
const COPY_LINE_ID_DOMAIN = 'mioon.format5.dialogue-copy-line.v1';

/** Deterministic UUID-shaped identity so a preview, its commit and a retry all
 * carry the same bytes. Version/variant bits are set like a v5 UUID. */
function derivedUuid(domain: string, parts: readonly string[]): string {
  const digest = createHash('sha256').update([domain, ...parts].join('\n')).digest('hex');
  const variant = ((Number.parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(18, 20)}-${digest.slice(20, 32)}`;
}

/** The one real cue a line projects to. */
export function format5DialogueCueId(timelineId: string, shotId: string, lineId: string): string {
  return derivedUuid(CUE_ID_DOMAIN, [timelineId, shotId, lineId]);
}

/** A copied shot keeps the line order but gets fresh line identities (plan
 * §2.4: copying a shot generates new line ids) derived from the new shot and
 * the source position, so re-running the same copy plan is byte-identical. */
export function format5CopiedDialogueLineId(newShotId: string, index: number): string {
  return derivedUuid(COPY_LINE_ID_DOMAIN, [newShotId, String(index)]);
}

// ---------------------------------------------------------------------------
// Shot dialogue rows
// ---------------------------------------------------------------------------

/** Parse one staged shot row's dialogue. Absent means no lines. A stored value
 * that violates the frozen grammar is project corruption, not a user error. */
export function format5ShotDialogue(row: Row): Format5Dialogue {
  if (!Object.hasOwn(row, 'dialogue')) return [];
  const parsed = format5DialogueSchema.safeParse(row.dialogue);
  if (!parsed.success) throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'});
  return parsed.data;
}

/** Replace a shot row's dialogue field, removing the key when there are no lines
 * so a project without dialogue keeps its original bytes. */
export function withFormat5ShotDialogue(row: Row, dialogue: readonly SequenceEditDialogueLine[]): Row {
  const next = {...row};
  if (dialogue.length === 0) delete next.dialogue;
  else next.dialogue = dialogue.map(line => line.speakerSubjectId !== undefined
    ? {id: line.id, text: line.text, speakerSubjectId: line.speakerSubjectId}
    : {id: line.id, text: line.text});
  return next;
}

/** Copy a shot's dialogue onto a new shot id with fresh line identities. */
export function copyFormat5ShotDialogue(row: Row, newShotId: string): Row {
  const source = format5ShotDialogue(row);
  if (source.length === 0) {
    const next = {...row};
    delete next.dialogue;
    return next;
  }
  return withFormat5ShotDialogue(row, source.map((line, index) => ({
    id: format5CopiedDialogueLineId(newShotId, index), text: line.text,
    ...(line.speakerSubjectId === undefined ? {} : {speakerSubjectId: line.speakerSubjectId}),
  })));
}

// ---------------------------------------------------------------------------
// Cue projection
// ---------------------------------------------------------------------------

/** One main-track shot and the segments it occupies after the action. */
export interface Format5DialogueProjectedShot {
  readonly shotId: string;
  readonly lines: readonly {readonly id: string; readonly text: string}[];
  /** Contiguous main-track segments in start order. */
  readonly segments: readonly {readonly clipId: string; readonly startFrame: number; readonly durationFrames: number}[];
}

export interface Format5DialogueProjectionInput {
  readonly timelineId: string;
  /** Every cue after the action's anchor moves. */
  readonly cues: readonly Format5Cue[];
  readonly subtitleProfilePresent: boolean;
  /** Shots that are on the main track after the action. */
  readonly shots: readonly Format5DialogueProjectedShot[];
  /** Shots already on the main track before the action. A detached cue of such a
   * shot stays in place; only a (re-)entering shot gets cues placed. */
  readonly previousMainShotIds: ReadonlySet<string>;
  /** Cue rows before the action, used to keep a trim-detached cue in place. */
  readonly previousCues: ReadonlyMap<string, Format5Cue>;
  /** Live shot ids: a cue whose shot is gone (archived in this action) becomes
   * an ordinary cue at the same frame. */
  readonly liveShotIds: ReadonlySet<string>;
  /** Lines of shots that are not on the main track (their linked cues stay
   * detached): the cue text still follows the line and removed lines remove
   * their cue. */
  readonly linkedShots?: ReadonlyMap<string, readonly {readonly id: string; readonly text: string}[]>;
}

export interface Format5DialogueProjectionSuccess {
  readonly ok: true;
  readonly cues: readonly Format5Cue[];
  readonly changedCueIds: readonly string[];
  readonly removedCueIds: readonly string[];
  readonly subtitles: SequenceEditSubtitleProfileChange;
}
export type Format5DialogueProjectionResult =
  | Format5DialogueProjectionSuccess
  | {readonly ok: false; readonly code: 'SEQUENCE_EDIT_DIALOGUE_CONFLICT'; readonly ids: readonly string[]};

type Interval = {start: number; end: number};

/** Free frame ranges inside [start,end), sorted, excluding every interval. */
function freeIntervals(start: number, end: number, occupied: readonly Interval[]): Interval[] {
  const sorted = [...occupied].filter(item => item.end > item.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const free: Interval[] = [];
  let cursor = start;
  for (const item of sorted) {
    if (item.end <= cursor) continue;
    if (item.start >= end) break;
    if (item.start > cursor) free.push({start: cursor, end: Math.min(item.start, end)});
    cursor = Math.max(cursor, item.end);
    if (cursor >= end) break;
  }
  if (cursor < end) free.push({start: cursor, end});
  return free;
}

function cueIntervals(cues: readonly Format5Cue[]): Interval[] {
  return cues.map(cue => ({start: cue.startFrame, end: cue.startFrame + cue.durationFrames}));
}

interface PendingLine {readonly lineId: string; readonly cue: Format5Cue | null}

/**
 * Project every main-track shot's lines onto real cues. Pure: no store, no IO.
 * Returns exactly the cue rows the transaction writes plus the subtitle header
 * change, or the affected ids when the timeline cannot hold the lines.
 */
export function projectFormat5DialogueCues(input: Format5DialogueProjectionInput): Format5DialogueProjectionResult {
  const next = new Map(input.cues.map(cue => [cue.id, {...cue} as Format5Cue]));
  const changed = new Set<string>();
  const removed = new Set<string>();
  const conflictIds = new Set<string>();

  // A cue of a shot that no longer exists (archived by this action) becomes an
  // ordinary cue at the same frame. Undo restores the link from the patch.
  for (const cue of input.cues) {
    const ref = cue.dialogueRef;
    if (!ref) continue;
    if (input.liveShotIds.has(ref.shotId)) continue;
    const {dialogueRef: _dropped, ...rest} = cue;
    void _dropped;
    next.set(cue.id, rest as Format5Cue);
    changed.add(cue.id);
  }

  for (const shot of input.shots) {
    const segments = [...shot.segments].sort((left, right) => left.startFrame - right.startFrame
      || left.clipId.localeCompare(right.clipId));
    if (segments.length === 0) continue;
    const spanStart = segments[0]!.startFrame;
    const spanEnd = segments[segments.length - 1]!.startFrame + segments[segments.length - 1]!.durationFrames;
    const ownerAt = (frame: number) => segments.find(segment =>
      segment.startFrame <= frame && frame < segment.startFrame + segment.durationFrames) ?? null;
    const lineById = new Map(shot.lines.map(line => [line.id, line] as const));
    const linked = [...next.values()].filter(cue => cue.dialogueRef?.shotId === shot.shotId);
    const cueByLine = new Map<string, Format5Cue>();
    for (const cue of [...linked].sort((left, right) => left.id.localeCompare(right.id))) {
      const lineId = cue.dialogueRef!.lineId;
      if (!lineById.has(lineId)) {
        // The line was removed (or never existed): the projected cue goes away.
        next.delete(cue.id);
        removed.add(cue.id);
        changed.delete(cue.id);
        continue;
      }
      if (cueByLine.has(lineId)) continue;
      cueByLine.set(lineId, cue);
    }
    // Text follows the line on both sides (the fence requires exact equality).
    for (const [lineId, cue] of cueByLine) {
      const text = lineById.get(lineId)!.text;
      if (cue.text !== text) {
        next.set(cue.id, {...cue, text});
        changed.add(cue.id);
      }
    }
    const reentering = !input.previousMainShotIds.has(shot.shotId);
    // A cue start order that disagrees with the dialogue order is re-laid out in
    // full, so the subtitle sequence follows the lines after a reorder (the
    // default timing rule) instead of leaving an inverted pair behind.
    const orderedExisting = [...cueByLine.entries()].map(([lineId, cue]) => ({lineId, cue: next.get(cue.id)!}))
      .sort((left, right) => left.cue.startFrame - right.cue.startFrame || left.cue.id.localeCompare(right.cue.id));
    const lineRank = new Map(shot.lines.map((line, index) => [line.id, index] as const));
    let orderBroken = false, lastRank = -1;
    for (const item of orderedExisting) {
      const rank = lineRank.get(item.lineId) ?? -1;
      if (rank < lastRank) {orderBroken = true; break;}
      lastRank = rank;
    }
    const pending: PendingLine[] = [];
    for (const line of shot.lines) {
      const cue = cueByLine.get(line.id) ?? null;
      if (cue === null) {pending.push({lineId: line.id, cue: null}); continue;}
      const current = next.get(cue.id)!;
      if (orderBroken) {pending.push({lineId: line.id, cue: current}); continue;}
      const anchor = current.anchor;
      const owner = anchor === null ? null : segments.find(segment => segment.clipId === anchor.clipId) ?? null;
      const valid = anchor !== null && owner !== null
        && current.startFrame === owner.startFrame + anchor.offsetFrames
        && anchor.offsetFrames >= 0 && anchor.offsetFrames < owner.durationFrames
        && current.startFrame >= spanStart && current.startFrame + current.durationFrames <= spanEnd;
      if (valid) continue;
      const previous = input.previousCues.get(cue.id);
      const previousOwner = previous?.anchor?.clipId;
      // A cue detached in this action because its owner vanished or was trimmed
      // keeps its absolute frame (plan §2.3: release the anchor in place).
      if (previousOwner !== undefined && previousOwner !== null
        && input.previousMainShotIds.has(shot.shotId) && !reentering) {
        if (current.anchor !== null) {
          next.set(cue.id, {...current, anchor: null});
          changed.add(cue.id);
        }
        continue;
      }
      pending.push({lineId: line.id, cue: current});
    }
    if (pending.length === 0) continue;
    const pendingIds = new Set(pending.map(item => item.cue?.id).filter((id): id is string => typeof id === 'string'));
    // Pending cues are being replaced, so their old frames are free again.
    const occupied = [...next.values()].filter(cue => !pendingIds.has(cue.id));
    const free = freeIntervals(spanStart, spanEnd, cueIntervals(occupied));
    const slots = free.map(interval => ({...interval}));
    for (const [index, item] of pending.entries()) {
      while (slots.length > 0 && slots[0]!.start >= slots[0]!.end) slots.shift();
      if (slots.length === 0) {
        conflictIds.add(item.cue?.id ?? shot.shotId);
        conflictIds.add(shot.shotId);
        continue;
      }
      const total = slots.reduce((sum, slot) => sum + (slot.end - slot.start), 0);
      const remaining = pending.length - index;
      const duration = Math.max(1, Math.floor(total / remaining));
      const slot = slots[0]!;
      const length = Math.min(duration, slot.end - slot.start);
      if (length < 1) {
        conflictIds.add(shot.shotId);
        continue;
      }
      const startFrame = slot.start;
      slot.start += length;
      if (slot.start >= slot.end) slots.shift();
      const owner = ownerAt(startFrame);
      if (!owner) {
        conflictIds.add(shot.shotId);
        continue;
      }
      const id = item.cue?.id ?? format5DialogueCueId(input.timelineId, shot.shotId, item.lineId);
      next.set(id, {id, text: lineById.get(item.lineId)!.text, startFrame, durationFrames: length,
        anchor: {clipId: owner.clipId, offsetFrames: startFrame - owner.startFrame}, dialogueRef: {shotId: shot.shotId, lineId: item.lineId}});
      changed.add(id);
    }
  }
  if (conflictIds.size > 0) {
    return {ok: false, code: 'SEQUENCE_EDIT_DIALOGUE_CONFLICT', ids: [...conflictIds].sort()};
  }
  // A cue linked to a shot that is still live but no longer on the main track
  // keeps its identity and absolute frame (anchor null); its text still follows
  // the line, and a removed line removes the cue.
  const projectedShotIds = new Set(input.shots.map(shot => shot.shotId));
  if (input.linkedShots) {
    for (const cue of [...next.values()]) {
      const ref = cue.dialogueRef;
      if (!ref || projectedShotIds.has(ref.shotId) || !input.liveShotIds.has(ref.shotId)) continue;
      const lines = input.linkedShots.get(ref.shotId);
      if (!lines) continue;
      const line = lines.find(item => item.id === ref.lineId);
      if (!line) {
        next.delete(cue.id);
        removed.add(cue.id);
        changed.delete(cue.id);
        continue;
      }
      if (cue.text !== line.text) {
        next.set(cue.id, {...cue, text: line.text});
        changed.add(cue.id);
      }
    }
  }
  const cues = [...next.values()].sort((left, right) => left.startFrame - right.startFrame
    || left.id.localeCompare(right.id));
  const subtitles: SequenceEditSubtitleProfileChange = input.subtitleProfilePresent || cues.length === 0
    ? {kind: 'unchanged'}
    : {kind: 'set', value: {profileId: TIMELINE_SUBTITLE_PROFILE_ID}};
  return {ok: true, cues, changedCueIds: [...changed].filter(id => next.has(id)).sort(),
    removedCueIds: [...removed].sort(), subtitles};
}

