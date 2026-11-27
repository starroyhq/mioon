import {z} from 'zod';
import {sequenceEditSpeedIntentSchema, type SequenceEditSpeedIntent} from './timeline-speed.ts';
import {TIMELINE_TIME_MAP_ERROR_CODES} from './timeline-time-map.ts';
import {FORMAT5_LIMITS, FORMAT5_STORAGE_ERROR_CODES, format5AnchorSchema, format5DialogueRefSchema, format5SubjectBindingSchema, format5SyncBaselineSchema} from './project-format5.ts';
import {getTimelineSubtitleTextIssue} from './timeline-subtitles.ts';
import {isClipTransition} from './timeline-clip-transition.ts';
import {isTimelineClipColour} from './timeline-colour.ts';
import {isClipAudioRole} from './timeline-audio-role.ts';
import {isVolumeEnvelope} from './timeline-volume-envelope-processing.ts';
import {TIMELINE_FORMAT_WRITE_PRESETS} from './timeline-output-geometry.ts';
import type {
  Format5Clip, Format5Cue, Format5ErrorCode, Format5SubjectBinding, Format5SyncBaseline, Format5Timeline,
} from './project-format5.ts';
import type {BoardSequenceErrorCode, ChainReferenceRole} from './board-sequence.ts';
import {PREVIS_LIMITS,previsSceneSchema} from './previs.ts';
import type {PrevisScene} from './previs.ts';
import type {MainTrackErrorCode} from './chain-main-track.ts';
import type {
  ChainSyncOperation, ChainSyncPlan, ChainSyncState, ChainSyncWarning,
} from './chain-sync-algorithm.ts';

/**
 * CS/TS shared action contract for the format-5 board sequence (0.3.0).
 *
 * One user action is planned by the shared SA algorithms (board-sequence /
 * chain-main-track / chain-sync-algorithm) and committed by CS (board graph)
 * and TS (main-track projection) inside one `ProjectStore.tx`. This file fixes
 * the envelope both sides exchange, the two transaction-internal entry
 * signatures, the unified undo/redo identity and the shared error-code table.
 * It contains types, constants and pure canonical/inversion helpers only: no
 * store, IO, planner or history implementation lives here.
 *
 * Boundaries:
 * - Field names and error codes already frozen by K5a (`project-format5.ts`,
 *   `format5-*` storage, history 13) are imported, never restated.
 * - Operation semantics stay in SA. The envelope validator checks identity,
 *   bounds, side/kind agreement and the allowed compound order only.
 * - The timeline half keeps a three-state synchronization baseline (unchanged /
 *   set / absent) so an action only pays for the snapshot it really changes.
 * - Storage shapes: history-13 `editor_history_entries.beforePatch/afterPatch`
 *   hold `SequenceEditStateDelta` objects; `editor_requests.response` holds a
 *   `SequenceEditReceipt`; `operation` holds `sequenceEditOperationName(...)`.
 */

export const SEQUENCE_EDIT_CONTRACT_VERSION = 1 as const;

/** Bounds mirror the frozen history-13 storage limits (K5a). */
export const SEQUENCE_EDIT_LIMITS = Object.freeze({
  /** A repair action may append its required `sync-board` projection. */
  intents: 2,
  requestIdMinBytes: 8,
  requestIdMaxBytes: 200,
  requestIdMaxUtf8Bytes: 800,
  /** history-13 `operation` column. */
  operationBytes: 200,
  /** history-13 `beforePatch` + `afterPatch` combined. */
  patchBytes: FORMAT5_LIMITS.historyEntryBytes,
  receiptBytes: FORMAT5_LIMITS.receiptResponseBytes,
  historyEntries: FORMAT5_LIMITS.historyEntries,
  historyBytes: FORMAT5_LIMITS.historyBytes,
  /** Changed ids carried by one envelope: main track + other-track items + cues. */
  impactIds: FORMAT5_LIMITS.mainTrackClips + FORMAT5_LIMITS.otherTrackClips + FORMAT5_LIMITS.subtitleCues,
  boardWrites: FORMAT5_LIMITS.mainTrackClips + FORMAT5_LIMITS.otherTrackClips,
});

export type SequenceEditSide = 'board' | 'timeline';
export const SEQUENCE_EDIT_SIDES = Object.freeze(['board', 'timeline'] as const);

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const utf8 = new TextEncoder();
export const sequenceEditUtf8Bytes = (value: string): number => utf8.encode(value).length;
export const isSequenceEditUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);
export const isSequenceEditInputDigest = (value: unknown): value is string => typeof value === 'string' && DIGEST_PATTERN.test(value);

/** Idempotency key: the frozen history-13 request window accepts 8..200 characters
 * and at most 800 UTF-8 bytes. A repeated request with the same digest replays
 * its stored receipt; a different digest is rejected (SEQUENCE_EDIT_REQUEST_REUSED). */
export function isSequenceEditRequestId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // SQLite length() counts characters, not UTF-16 code units.
  const characters = [...value].length;
  return characters >= SEQUENCE_EDIT_LIMITS.requestIdMinBytes
    && characters <= SEQUENCE_EDIT_LIMITS.requestIdMaxBytes
    && sequenceEditUtf8Bytes(value) <= SEQUENCE_EDIT_LIMITS.requestIdMaxUtf8Bytes;
}

// ---------------------------------------------------------------------------
// Operation names
// ---------------------------------------------------------------------------

/**
 * One stable history/receipt operation name per SA edit kind. `operation` in
 * history 13 is a byte-bounded string; compound repair actions join the names
 * with `+` in intent order (`board.insert+board.sync`).
 */
export const SEQUENCE_EDIT_OPERATIONS = Object.freeze([
  'board.connect', 'board.disconnect', 'board.insert', 'board.delete', 'board.sync', 'board.version',
  'board.root.create', 'board.shot.append', 'board.layout.move',
  'board.node.create', 'board.shot.update', 'board.node.update', 'board.restore',
  'board.paste', 'board.duplicate',
  'timeline.clip.move', 'timeline.clip.remove', 'timeline.clip.add', 'timeline.clip.split',
  'timeline.clip.trim', 'timeline.clip.version', 'timeline.clip.move-off-track', 'timeline.clip.paste',
  'timeline.clip.copy-as-new-shot',
  'timeline.clip.splitAtScenes', 'timeline.clip.separateSound', 'timeline.format.set', 'timeline.track.add', 'timeline.track.update',
  'timeline.clip.setSpeed', 'timeline.clip.freeze',
  'timeline.generate.placeholder', 'timeline.generate.resize',
  'subject.binding.create', 'subject.binding.set-mode', 'subject.binding.detach', 'subject.binding.restore',
  'subject.card.create', 'subject.card.delete',
  'previs.create', 'previs.scene.set',
  'reference.attach', 'reference.role.set', 'reference.detach', 'reference.reorder',
] as const);
export type SequenceEditOperationName = (typeof SEQUENCE_EDIT_OPERATIONS)[number];

/**
 * UI-B2 board-only intents that create graph rows or move canvas coordinates.
 * They are single-intent board actions (never combined with `sync-board`) and
 * land in the same unified history entry as every other board edit.
 */
export interface BoardPosition {readonly x: number; readonly y: number}
export interface BoardShotUpdatePatch {
  readonly title?: string;
  readonly prompt?: string;
  readonly duration?: number;
  readonly aspectRatio?: string;
  readonly position?: BoardPosition;
}
export interface BoardNodeUpdatePatch {
  readonly name?: string;
  readonly text?: string;
  readonly position?: BoardPosition;
}
export type BoardTarget = {readonly kind: 'shot' | 'node'; readonly id: string};
export type BoardIntentOperation =
  | {readonly kind: 'board.root.create'; readonly nodeId: string; readonly name: string;
    readonly position: BoardPosition}
  | {readonly kind: 'board.shot.append'; readonly nodeId: string; readonly name: string;
    readonly position?: BoardPosition}
  | {readonly kind: 'board.layout.move'; readonly moves: readonly {
    readonly nodeId: string; readonly x: number; readonly y: number}[]}
  | {readonly kind: 'board.node.create'; readonly nodeId: string;
    readonly nodeType: 'image' | 'video' | 'audio' | 'text'; readonly name: string;
    readonly position: BoardPosition; readonly assetId?: string; readonly text?: string}
  | {readonly kind: 'board.shot.update'; readonly shotId: string; readonly expectedRevision: number;
    readonly patch: BoardShotUpdatePatch}
  | {readonly kind: 'board.node.update'; readonly nodeId: string; readonly expectedRevision: number;
    readonly patch: BoardNodeUpdatePatch}
  | {readonly kind: 'board.restore'; readonly items: readonly BoardTarget[]}
  | {readonly kind: 'board.paste'; readonly documentId: string; readonly snapshotId: string;
    readonly viewport: {readonly x: number; readonly y: number; readonly width: number; readonly height: number}}
  | {readonly kind: 'board.duplicate'; readonly items: readonly BoardTarget[];
    readonly viewport?: {readonly x: number; readonly y: number; readonly width: number; readonly height: number}};

/** Board-shape intents are always CS/board side. */
export function isBoardIntentOperation(operation: {readonly kind: string}): operation is BoardIntentOperation {
  return operation.kind === 'board.root.create' || operation.kind === 'board.shot.append'
    || operation.kind === 'board.layout.move' || operation.kind === 'board.node.create'
    || operation.kind === 'board.shot.update' || operation.kind === 'board.node.update'
    || operation.kind === 'board.restore'
    || operation.kind === 'board.paste' || operation.kind === 'board.duplicate';
}

/**
 * SB subject-binding board actions (0.3.0). A subject binding is a board object
 * like a shot/node/edge: the whole row lives in `SequenceEditBoardDelta`, so
 * undo restores identity, mode, applied version, revision and timestamps
 * byte-for-byte. These operations are board-origin and belong to the same
 * history entry and the same undo step as the reference edge that connects a
 * subject card to a shot.
 *
 * `create` is only allowed for a new binding row; a retained `detached`
 * tombstone is restored with `restore`. `set-mode` switches follow/locked;
 * `detach` keeps the row identity and clears the applied version.
 */
export type SubjectBindingOperation =
  | {readonly kind: 'subject-binding'; readonly edit: {readonly kind: 'create'; readonly bindingId: string;
    readonly shotId: string; readonly subjectId: string; readonly role: 'subject' | 'style'}}
  | {readonly kind: 'subject-binding'; readonly edit: {readonly kind: 'set-mode'; readonly bindingId: string;
    readonly bindingMode: 'follow' | 'locked'; readonly subjectVersionId: string | null}}
  | {readonly kind: 'subject-binding'; readonly edit: {readonly kind: 'detach'; readonly bindingId: string}}
  | {readonly kind: 'subject-binding'; readonly edit: {readonly kind: 'restore'; readonly bindingId: string;
    readonly bindingMode: 'follow' | 'locked'; readonly subjectVersionId: string | null}};

/** SB-b subject-card commands. A card stores only `subjectId` and canvas fields;
 * deleting a card is a board-only action in the same unified history. Subject
 * and version rows are retained project evidence, so the only supported removal
 * is the board card (active bindings become detached tombstones and their
 * reference edges are removed). Deleting a subject from the library needs a
 * format-6 archived column and is out of scope for 0.3.0. */
export type SubjectCardOperation =
  | {readonly kind: 'subject.card.create'; readonly nodeId: string; readonly subjectId: string;
    readonly position: {readonly x: number; readonly y: number}}
  | {readonly kind: 'subject.card.delete'; readonly nodeId: string};
export type SubjectEditOperation = SubjectBindingOperation | SubjectCardOperation;

/** One subject intent: always board side, never combined with a sync-board
 * projection because it writes no timeline row. */
export interface SequenceEditSubjectIntent {
  readonly side: 'board';
  readonly operation: SubjectEditOperation;
}

/**
 * Previs scene actions (format 5, FR-0 opened through the unified entry). A
 * previs node is a board object: the whole node row (label, position, scene,
 * revision, sceneRevision) travels in `SequenceEditBoardDelta`, so create and
 * save are one undo step in the same history-13 stack. Operations are board
 * origin and never combine with a CS/TS intent.
 *
 * `create` writes the default scene; `scene-set` replaces the scene under the
 * observed scene revision and is the only path that may carry mannequin/prop
 * subject references. The host fills identity fields, so neither operation
 * carries `projectId` or a request id.
 */
export type PrevisIntentOperation =
  | {readonly kind: 'previs-create'; readonly nodeId: string; readonly label: string;
    readonly position: {readonly x: number; readonly y: number}}
  | {readonly kind: 'previs-scene-set'; readonly nodeId: string; readonly expectedSceneRevision: number;
    readonly scene: PrevisScene};
export interface SequenceEditPrevisIntent {
  readonly side: 'board';
  readonly operation: PrevisIntentOperation;
}

/**
 * RI material reference-line actions (0.3.0). A reference edge is a board object
 * like a shot/node/edge: the whole row lives in `SequenceEditBoardDelta`, so undo
 * restores its identity, role, source asset and order byte-for-byte. Subject
 * cards are NOT this family: their reference edge and binding row travel in
 * SB's `subjectIntent` so those runs never duplicate the binding write.
 *
 * - `attach` default-role by the source node type when `role` is omitted; the
 *   edge id and source asset id are resolved/pre-allocated by the caller.
 * - `set-role` changes only the persisted role (the connector keeps its edge id
 *   and source asset); first/last frame cardinality is re-checked.
 * - `detach` removes the edge row (it is a material edge, not a tombstone).
 * All three keep the legacy first/last-frame shot projection in the same
 * transaction (plan §2.1) so old readers see a consistent selection.
 */
export type ReferenceEdgeOperation =
  | {readonly kind: 'reference-edge'; readonly edit: {readonly kind: 'attach'; readonly edgeId: string;
    readonly shotId: string; readonly sourceNodeId: string; readonly role?: ChainReferenceRole}}
  | {readonly kind: 'reference-edge'; readonly edit: {readonly kind: 'set-role'; readonly edgeId: string;
    readonly shotId: string; readonly role: ChainReferenceRole}}
  | {readonly kind: 'reference-edge'; readonly edit: {readonly kind: 'detach'; readonly edgeId: string;
    readonly shotId: string}}
  /** RI-b: put every material reference edge of one shot in the given order.
   * The first reference image is the primary image; the order is also the
   * prompt/image numbering order sent to the provider. */
  | {readonly kind: 'reference-edge'; readonly edit: {readonly kind: 'reorder'; readonly shotId: string;
    readonly edgeIds: readonly string[]}};

/** One material reference intent: always board side, never combined with a
 * sync-board projection because it writes only the edge and the shot
 * compatibility projection. */
export interface SequenceEditReferenceIntent {
  readonly side: 'board';
  readonly operation: ReferenceEdgeOperation;
}

export function sequenceEditReferenceOperationName(operation: ReferenceEdgeOperation): SequenceEditOperationName {
  switch (operation.edit.kind) {
    case 'attach': return 'reference.attach';
    case 'set-role': return 'reference.role.set';
    case 'detach': return 'reference.detach';
    case 'reorder': return 'reference.reorder';
  }
}

/** FR-A clip properties: one undo step may change several clips (for example one
 * loudness/gain group), but never timeline structure (frames, anchors, tracks,
 * transitions' neighbours). Each patch carries only the fields the user edited;
 * omitted fields stay untouched. */
export interface SequenceEditClipPropertiesPatch {
  readonly transform?: unknown;
  readonly transition?: unknown;
  readonly gain?: number;
  readonly fadeInFrames?: number;
  readonly fadeOutFrames?: number;
  readonly colour?: unknown;
  readonly audioRole?: unknown;
  readonly volumeEnvelope?: unknown;
  readonly name?: string;
  /** Mute the clip's own sound without touching its gain. `false` clears the
   * persisted flag so a format-5 row never stores `muted:false`. */
  readonly muted?: boolean;
  readonly sourceReplacement?: {readonly assetId: string; readonly versionId?: string};
}
export interface SequenceEditClipPropertyEdit {
  readonly clipId: string;
  readonly patch: SequenceEditClipPropertiesPatch;
}
export interface SequenceEditClipPropertiesOperation {
  readonly kind: 'clip-properties';
  readonly edits: readonly SequenceEditClipPropertyEdit[];
}
export interface SequenceEditClipPropertiesIntent {
  readonly side: 'timeline';
  readonly operation: SequenceEditClipPropertiesOperation;
}
/** FR-B2: one output-preset change. All clips without an explicit layout freeze
 * their current frame as their layout basis; the header moves to the new preset. */
export const sequenceEditFormatIntentSchema = z.object({
  side: z.literal('timeline'),
  operation: z.object({kind: z.literal('timeline-format'),
    presetId: z.enum(TIMELINE_FORMAT_WRITE_PRESETS.map(item => item.id) as [string, ...string[]])}).strict(),
}).strict();
export interface SequenceEditFormatIntent {
  readonly side: 'timeline';
  readonly operation: {readonly kind: 'timeline-format';
    readonly presetId: typeof TIMELINE_FORMAT_WRITE_PRESETS[number]['id']};
}

/** FR-D track management: add a track or change its name/visibility/mute/order.
 * A track's identity, kind and the main-track association never change here;
 * deleting a track is not part of the format-5 contract. Locking is a client
 * view protection, not persisted timeline data. */
export interface SequenceEditTrackPatch {
  readonly name?: string;
  readonly hidden?: boolean;
  readonly muted?: boolean;
  readonly orderIndex?: number;
}
export type SequenceEditTrackEdit =
  | {readonly kind: 'add'; readonly trackId: string; readonly trackKind: 'video' | 'audio';
    readonly name?: string; readonly orderIndex?: number}
  | {readonly kind: 'update'; readonly trackId: string; readonly patch: SequenceEditTrackPatch};
export interface SequenceEditTrackOperation {
  readonly kind: 'track-structure';
  readonly edit: SequenceEditTrackEdit;
}
export interface SequenceEditTrackIntent {
  readonly side: 'timeline';
  readonly operation: SequenceEditTrackOperation;
}

/** FR-G separate sound: one action mutes the source clip and inserts a
 * sound-only audio clip that references the same video asset. The server expands
 * the minimal operation below: it allocates the audio clip id, picks the first
 * audio track with a free gap (or creates one in the same action) and resolves
 * the localized name prefix. The resolved ids travel in the accepted envelope
 * so confirm/retry replay exactly the same rows.
 *
 * A resolved action has all three ids: the destination track is either an
 * existing one (`createdTrackId` absent) or the track created by this action
 * (`createdTrackId === audioTrackId`). An unresolved preview request omits them. */
export interface SequenceEditSeparateSoundOperation {
  readonly kind: 'separate-sound';
  readonly clipId: string;
  readonly audioClipId?: string;
  readonly audioTrackId?: string;
  readonly createdTrackId?: string;
  /** New audio clip name; already localized by the caller (Mio omits it). */
  readonly name?: string;
  /** New track name; only used when this action creates the track. */
  readonly trackName?: string;
}
export interface SequenceEditSeparateSoundIntent {
  readonly side: 'timeline';
  readonly operation: SequenceEditSeparateSoundOperation;
}

/** FR-B subtitle structure: one action may add, update and remove cues; every
 * resulting cue keeps the format-5 anchor rule (a main-track clip owns it). */
export interface SequenceEditSubtitleCueInput {
  readonly id: string;
  readonly text: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly anchor?: unknown;
  readonly dialogueRef?: unknown;
}
export interface SequenceEditSubtitlePatch {
  readonly text?: string;
  readonly startFrame?: number;
  readonly durationFrames?: number;
  readonly anchor?: unknown;
  readonly dialogueRef?: unknown;
}
export type SequenceEditSubtitleEdit =
  | {readonly kind: 'add'; readonly cue: SequenceEditSubtitleCueInput}
  | {readonly kind: 'update'; readonly cueId: string; readonly patch: SequenceEditSubtitlePatch}
  | {readonly kind: 'remove'; readonly cueId: string};
export interface SequenceEditSubtitlesOperation {
  readonly kind: 'subtitles';
  readonly edits: readonly SequenceEditSubtitleEdit[];
}
export interface SequenceEditSubtitlesIntent {
  readonly side: 'timeline';
  readonly operation: SequenceEditSubtitlesOperation;
}

/**
 * DL-a dialogue lines (plan §2.4): one shot's ordered `shot.data.dialogue`
 * lines plus the subtitle cues they project to. A line lives on the shot, so
 * its edits are board-side; a cue's text lives on the timeline, so the
 * timeline-side edit addresses the cue and writes the same line through its
 * `dialogueRef`. Both sides travel in one action so one undo restores the text
 * on both sides.
 *
 * `add`/`remove`/`reorder` change lines only. Whenever a shot is on the main
 * track, the cue projection runs in the same transaction: every valid line has
 * exactly one real cue. The line identity is supplied by the caller; cue
 * identity is derived from `(timelineId, shotId, lineId)` so a preview, retry,
 * commit and undo/redo always reproduce the same row identity.
 */
export const SEQUENCE_EDIT_DIALOGUE_LIMITS = Object.freeze({
  /** One shot's dialogue line count (format-5 subtitle capacity). */
  lines: FORMAT5_LIMITS.subtitleCues,
  /** Edits one action may carry (a whole dialogue panel save). */
  edits: 100,
});
export interface SequenceEditDialogueLine {
  readonly id: string;
  readonly text: string;
  readonly speakerSubjectId?: string;
}
export type SequenceEditDialogueEdit =
  | {readonly kind: 'add'; readonly shotId: string; readonly line: SequenceEditDialogueLine;
    readonly beforeLineId?: string | null}
  | {readonly kind: 'update'; readonly shotId: string; readonly lineId: string;
    readonly text?: string; readonly speakerSubjectId?: string | null}
  | {readonly kind: 'remove'; readonly shotId: string; readonly lineId: string}
  | {readonly kind: 'reorder'; readonly shotId: string; readonly lineIds: readonly string[]}
  | {readonly kind: 'set-text-by-cue'; readonly cueId: string; readonly text: string};

export interface SequenceEditDialogueOperation {
  readonly kind: 'dialogue';
  readonly edits: readonly SequenceEditDialogueEdit[];
}
/** Board edits change the shot's lines; `set-text-by-cue` is timeline-origin and
 * writes the linked line through the cue. One action is one family. */
export interface SequenceEditDialogueIntent {
  readonly side: SequenceEditSide;
  readonly operation: SequenceEditDialogueOperation;
}

/** Stable history-13 name of one dialogue edit. `board.`/`timeline.` prefixes
 * let the shared undo routing report the original side. */
export function sequenceEditDialogueEditName(edit: SequenceEditDialogueEdit): string {
  switch (edit.kind) {
    case 'add': return 'board.dialogue.add';
    case 'update': return 'board.dialogue.update';
    case 'remove': return 'board.dialogue.remove';
    case 'reorder': return 'board.dialogue.reorder';
    case 'set-text-by-cue': return 'timeline.dialogue.text';
  }
}
/** Unique operation names in first-edit order, `+`-joined like compound intents. */
export function sequenceEditDialogueOperationName(operation: SequenceEditDialogueOperation): string {
  return [...new Set(operation.edits.map(sequenceEditDialogueEditName))].join('+');
}

/** The side a plan operation belongs to. Board edits and projections are CS,
 * track edits are TS. */
export function sequenceEditIntentSide(operation: {readonly kind: string}): SequenceEditSide {
  return operation.kind === 'track' ? 'timeline' : 'board';
}

/** Stable `history13.operation` name of one subject-binding edit. */
export function sequenceEditSubjectOperationName(operation: SubjectEditOperation): SequenceEditOperationName {
  if (operation.kind === 'subject.card.create') return 'subject.card.create';
  if (operation.kind === 'subject.card.delete') return 'subject.card.delete';
  switch (operation.edit.kind) {
    case 'create': return 'subject.binding.create';
    case 'set-mode': return 'subject.binding.set-mode';
    case 'detach': return 'subject.binding.detach';
    case 'restore': return 'subject.binding.restore';
  }
}

/** Stable `history13.operation` name of one previs edit. */
export function sequenceEditPrevisOperationName(operation: PrevisIntentOperation): SequenceEditOperationName {
  return operation.kind === 'previs-create' ? 'previs.create' : 'previs.scene.set';
}

export function sequenceEditIntentOperationName(operation: ChainSyncOperation | BoardIntentOperation): SequenceEditOperationName {
  switch (operation.kind) {
    case 'board':
      switch (operation.edit.kind) {
        case 'connect': return 'board.connect';
        case 'disconnect': return 'board.disconnect';
        case 'insert': return 'board.insert';
        case 'delete': return 'board.delete';
      }
    // `board` is the only operation whose nested edit needs mapping; a missing
    // branch above is a type error, so the switch cannot silently fall through.
    case 'sync-board': return 'board.sync';
    case 'board-version': return 'board.version';
    case 'board.root.create': return 'board.root.create';
    case 'board.shot.append': return 'board.shot.append';
    case 'board.layout.move': return 'board.layout.move';
    case 'board.node.create': return 'board.node.create';
    case 'board.shot.update': return 'board.shot.update';
    case 'board.node.update': return 'board.node.update';
    case 'board.restore': return 'board.restore';
    case 'board.paste': return 'board.paste';
    case 'board.duplicate': return 'board.duplicate';
    case 'track':
      switch (operation.edit.kind) {
        case 'split-at-scenes': return 'timeline.clip.splitAtScenes';
        case 'move': return 'timeline.clip.move';
        case 'move-off-track': return 'timeline.clip.move-off-track';
        case 'remove': return 'timeline.clip.remove';
        case 'add': return operation.edit.copyFromClipId ? 'timeline.clip.paste' : 'timeline.clip.add';
        case 'insert-asset': return 'timeline.clip.add';
        case 'paste-clip': return 'timeline.clip.paste';
        case 'copy-as-new-shot': return 'timeline.clip.copy-as-new-shot';
        case 'add-overlay': return operation.edit.copyFromClipId ? 'timeline.clip.paste' : 'timeline.clip.add';
        case 'split': return 'timeline.clip.split';
        case 'trim': return 'timeline.clip.trim';
        case 'version': return 'timeline.clip.version';
      }
  }
}

/** `history13.operation` for one action. Total length is bounded by the single
 * name bound times the two allowed intents, still far below 200 bytes. */
export function sequenceEditOperationName(intents: readonly SequenceEditIntent[]): string {
  return intents.map(intent => sequenceEditIntentOperationName(intent.operation)).join('+');
}

/** `history13.operation` for the action envelope. One subject action uses its
 * own stable name; every existing action keeps its intent-joined name. */
export function sequenceEditTrackOperationName(operation: SequenceEditTrackOperation): SequenceEditOperationName {
  return operation.edit.kind === 'add' ? 'timeline.track.add' : 'timeline.track.update';
}

export function sequenceEditEnvelopeOperationName(envelope: Pick<SequenceEditEnvelope, 'intents' | 'subjectIntent' |
  'propertiesIntent' | 'subtitlesIntent' | 'trackIntent' | 'referenceIntent' | 'dialogueIntent' | 'previsIntent' | 'formatIntent' | 'soundIntent' | 'generateIntent' | 'speedIntent'>): string {
  if (envelope.speedIntent) return envelope.speedIntent.operation.kind === 'clip-speed' ? 'timeline.clip.setSpeed' : 'timeline.clip.freeze';
  if (envelope.subjectIntent) return sequenceEditSubjectOperationName(envelope.subjectIntent.operation);
  if (envelope.referenceIntent) return sequenceEditReferenceOperationName(envelope.referenceIntent.operation);
  if (envelope.trackIntent) return sequenceEditTrackOperationName(envelope.trackIntent.operation);
  if (envelope.soundIntent) return 'timeline.clip.separateSound';
  if (envelope.propertiesIntent) return 'timeline.clip.set-properties';
  if (envelope.subtitlesIntent) return 'timeline.subtitle.edit';
  if (envelope.dialogueIntent) return sequenceEditDialogueOperationName(envelope.dialogueIntent.operation);
  if (envelope.previsIntent) return sequenceEditPrevisOperationName(envelope.previsIntent.operation);
  if (envelope.formatIntent) return 'timeline.format.set';
  if (envelope.generateIntent) return envelope.generateIntent.operation.kind === 'generate-placeholder'
    ? 'timeline.generate.placeholder' : 'timeline.generate.resize';
  return sequenceEditOperationName(envelope.intents);
}

// ---------------------------------------------------------------------------
// Actions, baseline, impact and allocation
// ---------------------------------------------------------------------------

export interface SequenceEditIntent {
  readonly side: SequenceEditSide;
  readonly operation: ChainSyncOperation | BoardIntentOperation;
}

/** A repair action may append one `sync-board` projection so that the recovered
 * chain and its main track land in the same transaction and one undo step (SA
 * review). Every other action is a single intent. */
export function isSequenceEditIntentSequence(intents: readonly SequenceEditIntent[]): boolean {
  if (intents.length < 1 || intents.length > SEQUENCE_EDIT_LIMITS.intents) return false;
  if (intents.some(intent => intent.side !== sequenceEditIntentSide(intent.operation))) return false;
  if (intents.some(intent => isBoardIntentOperation(intent.operation))) {
    // Board management intents (create/update/archive/restore/paste) are
    // independent rows written in one shared transaction; one user action may
    // carry several of them and they are all board-side.
    return intents.length <= SEQUENCE_EDIT_LIMITS.intents && intents.every(intent => intent.side === 'board');
  }
  return intents.length === 1 || (intents[0]!.side === 'board' && intents[0]!.operation.kind !== 'sync-board'
    && intents[1]!.side === 'board' && intents[1]!.operation.kind === 'sync-board');
}

/**
 * A cross-side target revision observation, using the project target-revision
 * evidence both surfaces already share. `revision` is the value read before
 * planning; the transaction re-reads every target and rejects a mismatch.
 */
export interface SequenceEditExpectedTarget {
  readonly kind: 'shot' | 'node' | 'edge' | 'clip' | 'cue' | 'subject_binding';
  readonly id: string;
  readonly revision: number;
}
export const SEQUENCE_EDIT_TARGET_KINDS = Object.freeze(['shot', 'node', 'edge', 'clip', 'cue', 'subject_binding', 'timeline_track'] as const);

/**
 * The exact revisions one action was planned against (plan §4). A transaction
 * re-reads them and returns SEQUENCE_EDIT_REVISION_CONFLICT instead of writing
 * onto a newer state.
 */
export interface SequenceEditBaseline {
  /** Project file content sequence (`project_file.contentSequence`). */
  readonly contentRevision: number;
  /** Timeline header revision. */
  readonly timelineRevision: number;
  /** `sequence_sync_state.revision` of this film. */
  readonly syncRevision: number;
  /** Unified history-13 cursor the caller observed. */
  readonly historyPosition: number;
  readonly historyRevision: number;
  /** Per-target evidence; the same ids as the impact arrays are expected here. */
  readonly targets: readonly SequenceEditExpectedTarget[];
}

/**
 * Every persisted object the action may create, change or remove. Ids are
 * returned to the UI/MT receipt and used for target-revision evidence. Counts
 * are bounded by the format-5 K1 capacity so one envelope stays small.
 */
export interface SequenceEditImpact {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly mainTrackClipIds: readonly string[];
  readonly otherTrackItemIds: readonly string[];
  readonly subtitleCueIds: readonly string[];
  /** SB: binding rows created/changed/detached by this action (never a
   * tombstone delete; `detach` keeps the row and only clears the applied
   * version). Optional so every pre-SB envelope and stored patch still parses. */
  readonly subjectBindingIds?: readonly string[];
  /** FR-D tracks created or changed by the action. Optional for old envelopes. */
  readonly trackIds?: readonly string[];
}
export function sequenceEditImpactCount(impact: SequenceEditImpact): number {
  return impact.nodeIds.length + impact.edgeIds.length + impact.mainTrackClipIds.length
    + impact.otherTrackItemIds.length + impact.subtitleCueIds.length + (impact.subjectBindingIds?.length ?? 0)
    + (impact.trackIds?.length ?? 0);
}

/**
 * New ids are allocated by the coordinator before planning and carried in the
 * envelope. A retry of the same request reuses them, so both sides cannot
 * produce two different identities for one action. This mirrors the SA inputs:
 * `newClipIds` for `planChainMainTrack`, the copied node id, split right-clip
 * ids and new edge ids.
 */
export interface SequenceEditAllocation {
  /** nodeId -> main-track clip id (SA `newClipIds`). */
  readonly clips: readonly {readonly nodeId: string; readonly clipId: string}[];
  /** Copied node identity for a «copy and move» decision. */
  readonly nodes: readonly {readonly fromNodeId: string; readonly nodeId: string}[];
  /** Left clip -> new right clip id for splits. */
  readonly splitClips: readonly {readonly clipId: string; readonly rightClipId: string}[];
  /** New sequence/reference edges created by this action. */
  readonly edges: readonly {readonly id: string; readonly fromId: string; readonly toId: string}[];
}

/** History-13 action envelope: one user action, CS/TS, one undo step. */
export interface SequenceEditEnvelope {
  readonly contractVersion: typeof SEQUENCE_EDIT_CONTRACT_VERSION;
  readonly projectId: string;
  /** Unified history-13 epoch recorded with the first format-5 action. */
  readonly epoch: string;
  /** Action identity; undo and redo keep applying this same id (plan §5). */
  readonly actionId: string;
  /** Idempotency key of this request; a replay returns the stored receipt. */
  readonly requestId: string;
  /** The surface the user acted in. The first intent belongs to this side. */
  readonly originSide: SequenceEditSide;
  /** Who performed the action: user editing or the Mio task runtime (D5). */
  readonly origin?: 'user' | 'mio';
  /** Active `sequence_root` node; 0.3.0 actions target one film root. */
  readonly filmId: string;
  readonly intents: readonly SequenceEditIntent[];
  /** SB board actions; exactly one of `intents` and `subjectIntent` is present.
   * A reference edge and its binding row travel in the same intent's board
   * delta, so one undo step restores both. Optional and additive: existing
   * CS/TS envelopes and receipts are unchanged. */
  readonly subjectIntent?: SequenceEditSubjectIntent;
  /** RI material reference-line action; exactly one intent family is present.
   * A subject-card connector travels in `subjectIntent`, never here. */
  readonly referenceIntent?: SequenceEditReferenceIntent;
  /** FR-A clip property patch; exactly one intent family is present. */
  readonly propertiesIntent?: SequenceEditClipPropertiesIntent;
  /** Previs node create/save; exactly one intent family per envelope. Optional
   * and additive: earlier envelopes and stored patches stay valid. */
  readonly previsIntent?: SequenceEditPrevisIntent;
  /** FR-B subtitle cue structure; exactly one of the intent families. */
  readonly subtitlesIntent?: SequenceEditSubtitlesIntent;
  /** DL-a shot dialogue lines / linked cue text; one intent family per action. */
  readonly dialogueIntent?: SequenceEditDialogueIntent;
  /** FR-B2 output-frame change; one intent family like properties. */
  readonly formatIntent?: SequenceEditFormatIntent;  /** FR-D track add/update; exactly one intent family is present. */
  readonly trackIntent?: SequenceEditTrackIntent;
  /** FR-G separate sound; exactly one intent family is present. The operation
   * carries the server-allocated audio clip/track ids so confirming replays them. */
  readonly soundIntent?: SequenceEditSeparateSoundIntent;
  /** GE-a generation placement/resize; exactly one intent family is present. */
  readonly generateIntent?: SequenceEditGenerateIntent;
  readonly speedIntent?: SequenceEditSpeedIntent;
  readonly baseline: SequenceEditBaseline;
  readonly impact: SequenceEditImpact;
  readonly allocation: SequenceEditAllocation;
}

// ---------------------------------------------------------------------------
// Validation (envelope shell only; SA validates operation semantics)
// ---------------------------------------------------------------------------

const uuidSchema = z.string().regex(UUID_PATTERN);
const digestSchema = z.string().regex(DIGEST_PATTERN);
const sequenceSchema = z.number().int().safe().min(0);
const revisionSchema = z.number().int().safe().min(1);
const boundedText = (max: number) => z.string().min(1).max(max);
const idListSchema = (max: number) => z.array(uuidSchema).max(max)
  .refine(value => new Set(value).size === value.length, 'Duplicate id');

const targetSchema = z.object({kind: z.enum(SEQUENCE_EDIT_TARGET_KINDS), id: uuidSchema, revision: revisionSchema}).strict();
const baselineSchema = z.object({
  contentRevision: sequenceSchema, timelineRevision: revisionSchema, syncRevision: revisionSchema,
  historyPosition: sequenceSchema, historyRevision: revisionSchema,
  targets: z.array(targetSchema).max(SEQUENCE_EDIT_LIMITS.impactIds),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const target of value.targets) {
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) context.addIssue({code: z.ZodIssueCode.custom, message: 'Duplicate target revision'});
    seen.add(key);
  }
});
const impactSchema = z.object({
  nodeIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds),
  edgeIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds),
  mainTrackClipIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds),
  otherTrackItemIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds),
  subtitleCueIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds),
  subjectBindingIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds).optional(),
  trackIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds).optional(),
}).strict().superRefine((value, context) => {
  if (sequenceEditImpactCount(value) > SEQUENCE_EDIT_LIMITS.impactIds) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Too many impacted ids'});
  }
});
const allocationSchema = z.object({
  clips: z.array(z.object({nodeId: uuidSchema, clipId: uuidSchema}).strict()).max(SEQUENCE_EDIT_LIMITS.impactIds),
  nodes: z.array(z.object({fromNodeId: uuidSchema, nodeId: uuidSchema}).strict()).max(SEQUENCE_EDIT_LIMITS.impactIds),
  splitClips: z.array(z.object({clipId: uuidSchema, rightClipId: uuidSchema}).strict()).max(SEQUENCE_EDIT_LIMITS.impactIds),
  edges: z.array(z.object({id: uuidSchema, fromId: uuidSchema, toId: uuidSchema}).strict()).max(SEQUENCE_EDIT_LIMITS.impactIds),
}).strict().superRefine((value, context) => {
  const duplicate = (values: readonly string[], label: string): void => {
    if (new Set(values).size !== values.length) context.addIssue({code: z.ZodIssueCode.custom, message: `Duplicate ${label} id`});
  };
  duplicate(value.clips.map(item => item.clipId), 'clip');
  duplicate(value.clips.map(item => item.nodeId), 'clip node');
  duplicate(value.nodes.map(item => item.nodeId), 'node');
  duplicate(value.nodes.map(item => item.fromNodeId), 'copy source node');
  duplicate(value.splitClips.map(item => item.rightClipId), 'split right clip');
  duplicate(value.edges.map(item => item.id), 'edge');
});
export {allocationSchema as sequenceEditAllocationSchema};
export const copyAsNewShotTrackEditSchema = z.object({
  kind: z.literal('copy-as-new-shot'), clipId: uuidSchema, newClipId: uuidSchema, copyNodeId: uuidSchema,
}).strict();
const operationSchema = z.object({kind: z.enum(['board', 'sync-board', 'board-version', 'track',
  'board.root.create', 'board.shot.append', 'board.layout.move', 'board.node.create', 'board.shot.update',
  'board.node.update', 'board.restore', 'board.paste', 'board.duplicate'])}).passthrough();
const intentSchema = z.object({side: z.enum(SEQUENCE_EDIT_SIDES), operation: operationSchema}).strict()
  .superRefine((value, context) => {
    if (sequenceEditIntentSide(value.operation as unknown as Pick<ChainSyncOperation, 'kind'>) !== value.side) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'Intent side does not match its operation kind'});
    }
    const edit = value.operation.kind === 'track' ? value.operation.edit : undefined;
    if (typeof edit === 'object' && edit !== null && 'kind' in edit && edit.kind === 'copy-as-new-shot'
      && !copyAsNewShotTrackEditSchema.safeParse(edit).success) {
      context.addIssue({code: z.ZodIssueCode.custom, path: ['operation', 'edit'], message: 'Invalid copy-as-new-shot edit'});
    }
  });

/**
 * Structural envelope validation for the receipt/idempotency boundary. It does
 * not re-implement SA planning: a valid shell still returns the SA failure code
 * (`CYCLE`, `MULTIPLE_PREDECESSORS`, ...) from `planChainSync`.
 */
const subjectBindingEditSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('create'), bindingId: uuidSchema, shotId: uuidSchema, subjectId: uuidSchema,
    role: z.enum(['subject', 'style'])}).strict(),
  z.object({kind: z.literal('set-mode'), bindingId: uuidSchema, bindingMode: z.enum(['follow', 'locked']),
    subjectVersionId: uuidSchema.nullable()}).strict(),
  z.object({kind: z.literal('detach'), bindingId: uuidSchema}).strict(),
  z.object({kind: z.literal('restore'), bindingId: uuidSchema, bindingMode: z.enum(['follow', 'locked']),
    subjectVersionId: uuidSchema.nullable()}).strict(),
]).superRefine((value, context) => {
  if (value.kind !== 'set-mode' && value.kind !== 'restore') return;
  const locked = value.bindingMode === 'locked';
  if (locked !== (value.subjectVersionId !== null)) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Only a locked binding stores an applied subject version'});
  }
});
const cardPositionSchema = z.object({x: z.number().finite(), y: z.number().finite()}).strict();
const subjectCardOperationSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('subject.card.create'), nodeId: uuidSchema, subjectId: uuidSchema,
    position: cardPositionSchema}).strict(),
  z.object({kind: z.literal('subject.card.delete'), nodeId: uuidSchema}).strict(),
]);
export const sequenceEditSubjectIntentSchema = z.object({
  side: z.literal('board'),
  operation: z.union([
    z.object({kind: z.literal('subject-binding'), edit: subjectBindingEditSchema}).strict(),
    subjectCardOperationSchema,
  ]),
}).strict();
const subjectIntentSchema = sequenceEditSubjectIntentSchema;
const referenceRoleSchema = z.enum(['first_frame', 'last_frame', 'reference_image', 'subject_reference',
  'style_reference', 'composition', 'reference_audio', 'reference_video']);
const referenceEdgeEditSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('attach'), edgeId: uuidSchema, shotId: uuidSchema, sourceNodeId: uuidSchema,
    role: referenceRoleSchema.optional()}).strict(),
  z.object({kind: z.literal('set-role'), edgeId: uuidSchema, shotId: uuidSchema, role: referenceRoleSchema}).strict(),
  z.object({kind: z.literal('detach'), edgeId: uuidSchema, shotId: uuidSchema}).strict(),
  z.object({kind: z.literal('reorder'), shotId: uuidSchema,
    edgeIds: z.array(uuidSchema).min(1).max(48).refine(ids => new Set(ids).size === ids.length, 'Duplicate edge id')}).strict(),
]);
export const sequenceEditReferenceIntentSchema = z.object({
  side: z.literal('board'),
  operation: z.object({kind: z.literal('reference-edge'), edit: referenceEdgeEditSchema}).strict(),
}).strict();
const referenceIntentSchema = sequenceEditReferenceIntentSchema;
const clipPropertiesPatchFields = z.object({
  transform: z.unknown().optional(),
  transition: z.unknown().optional(),
  gain: z.number().finite().min(0).max(2).optional(),
  fadeInFrames: z.number().int().safe().min(0).max(FORMAT5_LIMITS.durationFrames).optional(),
  fadeOutFrames: z.number().int().safe().min(0).max(FORMAT5_LIMITS.durationFrames).optional(),
  colour: z.unknown().optional(),
  audioRole: z.unknown().optional(),
  volumeEnvelope: z.unknown().optional(),
  name: z.string().min(1).max(200).optional(),
  muted: z.boolean().optional(),
}).strict();
const hasClipProperties = (value: SequenceEditClipPropertiesPatch): boolean => Object.keys(value).length > 0;
function clipPropertyEdits(patch: z.ZodType<SequenceEditClipPropertiesPatch>) {
  return z.array(z.object({clipId: uuidSchema, patch}).strict()).min(1).max(100)
    .refine(list => new Set(list.map(edit => edit.clipId)).size === list.length, 'Each clip may appear once');
}
export const sequenceClipPropertyEditsSchema = clipPropertyEdits(
  clipPropertiesPatchFields.refine(hasClipProperties, 'At least one clip property is required'));
const clipPropertiesWithSourcePatchSchema = clipPropertiesPatchFields.extend({
  sourceReplacement: z.object({assetId: uuidSchema, versionId: uuidSchema.optional()}).strict().optional(),
}).refine(hasClipProperties, 'At least one clip property is required');
export const sequenceEditClipPropertiesIntentSchema = z.object({
  side: z.literal('timeline'),
  operation: z.object({kind: z.literal('clip-properties'),
    edits: clipPropertyEdits(clipPropertiesWithSourcePatchSchema)}).strict(),
}).strict();
const trackPatchSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  hidden: z.boolean().optional(),
  muted: z.boolean().optional(),
  orderIndex: z.number().int().min(0).max(FORMAT5_LIMITS.tracks - 1).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'At least one track field is required');
export const sequenceEditTrackIntentSchema = z.object({
  side: z.literal('timeline'),
  operation: z.object({kind: z.literal('track-structure'), edit: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('add'), trackId: uuidSchema, trackKind: z.enum(['video', 'audio']),
      name: z.string().min(1).max(150).optional(),
      orderIndex: z.number().int().min(0).max(FORMAT5_LIMITS.tracks - 1).optional()}).strict(),
    z.object({kind: z.literal('update'), trackId: uuidSchema, patch: trackPatchSchema}).strict(),
  ])}).strict(),
}).strict();
const trackIntentSchema = sequenceEditTrackIntentSchema;
export const sequenceEditSeparateSoundIntentSchema = z.object({
  side: z.literal('timeline'),
  operation: z.object({kind: z.literal('separate-sound'), clipId: uuidSchema,
    audioClipId: uuidSchema.optional(), audioTrackId: uuidSchema.optional(), createdTrackId: uuidSchema.optional(),
    name: z.string().min(1).max(200).optional(), trackName: z.string().min(1).max(150).optional(),
  }).strict()
    .refine(value => (value.audioClipId === undefined) === (value.audioTrackId === undefined),
      'Separate-sound clip and track ids resolve together')
    .refine(value => value.createdTrackId === undefined || value.createdTrackId === value.audioTrackId,
      'A created track is the destination track'),
}).strict();
const soundIntentSchema = sequenceEditSeparateSoundIntentSchema;
const propertiesIntentSchema = sequenceEditClipPropertiesIntentSchema;
const formatIntentSchema = sequenceEditFormatIntentSchema;
const previsLabelSchema = z.string().max(PREVIS_LIMITS.labelLength);
const previsPointSchema = z.object({x: z.number().finite(), y: z.number().finite()}).strict();
export const sequenceEditPrevisIntentSchema = z.object({
  side: z.literal('board'),
  operation: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('previs-create'), nodeId: uuidSchema, label: previsLabelSchema, position: previsPointSchema}).strict(),
    z.object({kind: z.literal('previs-scene-set'), nodeId: uuidSchema, expectedSceneRevision: revisionSchema,
      scene: previsSceneSchema}).strict(),
  ]),
}).strict();
const previsIntentSchema = sequenceEditPrevisIntentSchema;
const subtitleCueInputSchema = z.object({
  id: uuidSchema, text: z.string().max(256), startFrame: z.number().int().safe().min(0).max(FORMAT5_LIMITS.durationFrames),
  durationFrames: z.number().int().safe().min(1).max(FORMAT5_LIMITS.durationFrames),
  anchor: format5AnchorSchema.optional(), dialogueRef: format5DialogueRefSchema.optional(),
}).strict();
const subtitlePatchSchema = z.object({
  text: z.string().max(256).optional(),
  startFrame: z.number().int().safe().min(0).max(FORMAT5_LIMITS.durationFrames).optional(),
  durationFrames: z.number().int().safe().min(1).max(FORMAT5_LIMITS.durationFrames).optional(),
  anchor: format5AnchorSchema.optional(), dialogueRef: format5DialogueRefSchema.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'At least one subtitle field is required');
export const sequenceEditSubtitlesIntentSchema = z.object({
  side: z.literal('timeline'),
  operation: z.object({kind: z.literal('subtitles'),
    edits: z.array(z.discriminatedUnion('kind', [
      z.object({kind: z.literal('add'), cue: subtitleCueInputSchema}).strict(),
      z.object({kind: z.literal('update'), cueId: uuidSchema, patch: subtitlePatchSchema}).strict(),
      z.object({kind: z.literal('remove'), cueId: uuidSchema}).strict(),
    ])).min(1).max(100)
      .refine(list => new Set(list.map(edit => edit.kind === 'add' ? edit.cue.id : edit.cueId)).size === list.length,
        'Each subtitle cue may appear once')}).strict(),
}).strict();
const subtitlesIntentSchema = sequenceEditSubtitlesIntentSchema;
const generationSettingsSchema = z.object({
  requestId: z.string().min(8).max(200),
  // UI placement leaves the service open (the panel picks it and starts the
  // paid call); Mio's paid action requires and freezes the service here.
  providerId: z.string().min(1).max(120).optional(),
  model: z.string().min(1).max(200).optional(),
  region: z.string().min(1).max(120).optional(),
  prompt: z.string().max(5000),
  aspectRatio: z.string().min(1).max(40),
  duration: z.number().int().min(1).max(60),
  parameters: z.record(z.unknown()).optional(),
  connectionId: uuidSchema.optional(),
  configurationRevision: revisionSchema.optional(),
  modelEntryId: z.string().min(1).max(200).optional(),
}).strict();
/** GE-a: place one new shot from the timeline and freeze one generation call.
 * `beforeClipId` null appends at the end of the packed main track. The caller
 * names only the requested position and generation settings; the service
 * allocates the shot, node, edge and clip identities server-side. */
export const sequenceEditGenerateIntentSchema = z.object({
  side: z.literal('timeline'),
  operation: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('generate-placeholder'),
      placement: z.discriminatedUnion('kind', [
        z.object({kind: z.literal('main'), beforeClipId: uuidSchema.nullable()}).strict(),
        z.object({kind: z.literal('track'), trackId: uuidSchema,
          startFrame: z.number().int().min(0).max(300000)}).strict(),
      ]),
      settings: generationSettingsSchema,
      shotId: uuidSchema, clipId: uuidSchema, title: z.string().min(1).max(200),
      // The UI only places the placeholder. Mio's approved action sets this so
      // the same commit also submits the frozen generation call; the RPC
      // sequence service has no submit port for UI placements.
      submit: z.boolean().optional(),
      position: z.object({x: z.number().finite(), y: z.number().finite()}).strict().optional()}).strict(),
    z.object({kind: z.literal('generate-resize'), shotId: uuidSchema,
      duration: z.number().int().min(1).max(60)}).strict(),
  ]),
}).strict();
export type SequenceEditGenerateGeneration = z.infer<typeof generationSettingsSchema>;
export interface SequenceEditGenerateIntent {
  readonly side: 'timeline';
  readonly operation:
    | {readonly kind: 'generate-placeholder';
        readonly placement: {readonly kind: 'main'; readonly beforeClipId: string | null}
          | {readonly kind: 'track'; readonly trackId: string; readonly startFrame: number};
        readonly settings: SequenceEditGenerateGeneration; readonly shotId: string; readonly clipId: string;
        readonly title: string; readonly submit?: boolean; readonly position?: BoardPosition}
    | {readonly kind: 'generate-resize'; readonly shotId: string; readonly duration: number};
}
const generateIntentSchema = sequenceEditGenerateIntentSchema;
const dialogueTextSchema = z.string().superRefine((value, context) => {
  const issue = getTimelineSubtitleTextIssue(value);
  if (issue) context.addIssue({code: z.ZodIssueCode.custom, message: issue.message});
});
const dialogueLineSchema = z.object({
  id: uuidSchema, text: dialogueTextSchema, speakerSubjectId: uuidSchema.optional(),
}).strict();
const dialogueEditsSchema = z.array(z.discriminatedUnion('kind', [
  z.object({kind: z.literal('add'), shotId: uuidSchema, line: dialogueLineSchema,
    beforeLineId: uuidSchema.nullable().optional()}).strict(),
  z.object({kind: z.literal('update'), shotId: uuidSchema, lineId: uuidSchema,
    text: dialogueTextSchema.optional(), speakerSubjectId: uuidSchema.nullable().optional()}).strict(),
  z.object({kind: z.literal('remove'), shotId: uuidSchema, lineId: uuidSchema}).strict(),
  z.object({kind: z.literal('reorder'), shotId: uuidSchema,
    lineIds: z.array(uuidSchema).max(SEQUENCE_EDIT_DIALOGUE_LIMITS.lines)
      .refine(list => new Set(list).size === list.length, 'Reordered line ids must be unique')}).strict(),
  z.object({kind: z.literal('set-text-by-cue'), cueId: uuidSchema, text: dialogueTextSchema}).strict(),
])).min(1).max(SEQUENCE_EDIT_DIALOGUE_LIMITS.edits).superRefine((edits, context) => {
  for (const edit of edits) {
    if (edit.kind === 'update' && edit.text === undefined && edit.speakerSubjectId === undefined) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'A dialogue update needs at least one field'});
    }
  }
});
export const sequenceEditDialogueIntentSchema = z.object({
  side: z.enum(SEQUENCE_EDIT_SIDES),
  operation: z.object({kind: z.literal('dialogue'), edits: dialogueEditsSchema}).strict(),
}).strict().superRefine((value, context) => {
  const timelineEdits = value.operation.edits.filter(edit => edit.kind === 'set-text-by-cue');
  if (timelineEdits.length !== 0 && timelineEdits.length !== value.operation.edits.length) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'A dialogue action mixes board and timeline edits'});
  }
  const expected: SequenceEditSide = timelineEdits.length === 0 ? 'board' : 'timeline';
  if (value.side !== expected) context.addIssue({code: z.ZodIssueCode.custom, message: 'The dialogue intent side does not match its edits'});
  const addIds = new Set<string>(), updateIds = new Set<string>(), removeIds = new Set<string>();
  const reordered = new Set<string>(), cueIds = new Set<string>();
  for (const edit of value.operation.edits) {
    if (edit.kind === 'add') {
      if (addIds.has(edit.line.id)) context.addIssue({code: z.ZodIssueCode.custom, message: 'Duplicate dialogue line id'});
      addIds.add(edit.line.id);
    } else if (edit.kind === 'update') {
      const key = `${edit.shotId}/${edit.lineId}`;
      if (updateIds.has(key)) context.addIssue({code: z.ZodIssueCode.custom, message: 'A dialogue line may be updated once'});
      updateIds.add(key);
    } else if (edit.kind === 'remove') {
      const key = `${edit.shotId}/${edit.lineId}`;
      if (removeIds.has(key)) context.addIssue({code: z.ZodIssueCode.custom, message: 'A dialogue line may be removed once'});
      removeIds.add(key);
    } else if (edit.kind === 'reorder') {
      if (reordered.has(edit.shotId)) context.addIssue({code: z.ZodIssueCode.custom, message: 'A shot may be reordered once'});
      reordered.add(edit.shotId);
    } else {
      if (cueIds.has(edit.cueId)) context.addIssue({code: z.ZodIssueCode.custom, message: 'A cue may be edited once'});
      cueIds.add(edit.cueId);
    }
  }
  for (const key of updateIds) if (removeIds.has(key)) context.addIssue({code: z.ZodIssueCode.custom, message: 'A dialogue line may not be updated and removed'});
});
const dialogueIntentSchema = sequenceEditDialogueIntentSchema;

export const sequenceEditEnvelopeSchema = z.object({
  contractVersion: z.literal(SEQUENCE_EDIT_CONTRACT_VERSION),
  projectId: uuidSchema, epoch: uuidSchema, actionId: uuidSchema, filmId: uuidSchema,
  requestId: z.string().refine(isSequenceEditRequestId, 'Invalid request id'),
  originSide: z.enum(SEQUENCE_EDIT_SIDES),
  origin: z.enum(['user', 'mio']).optional(),
  intents: z.array(intentSchema).max(SEQUENCE_EDIT_LIMITS.intents),
  subjectIntent: subjectIntentSchema.optional(),
  referenceIntent: referenceIntentSchema.optional(),
  propertiesIntent: propertiesIntentSchema.optional(),
  previsIntent: previsIntentSchema.optional(),
  subtitlesIntent: subtitlesIntentSchema.optional(),
  dialogueIntent: dialogueIntentSchema.optional(),
  trackIntent: trackIntentSchema.optional(),
  soundIntent: soundIntentSchema.optional(),
  formatIntent: formatIntentSchema.optional(),
  generateIntent: generateIntentSchema.optional(),
  speedIntent: sequenceEditSpeedIntentSchema.optional(),
  baseline: baselineSchema, impact: impactSchema, allocation: allocationSchema,
}).strict().superRefine((value, context) => {
  const hasSubject = value.subjectIntent !== undefined;
  const hasReference = value.referenceIntent !== undefined;
  const hasProperties = value.propertiesIntent !== undefined;
  const hasPrevis = value.previsIntent !== undefined;
  const hasSubtitles = value.subtitlesIntent !== undefined;
  const hasDialogue = value.dialogueIntent !== undefined;
  const hasTrack = value.trackIntent !== undefined;
  const hasSound = value.soundIntent !== undefined;
  const hasFormat = value.formatIntent !== undefined;
  const hasGenerate = value.generateIntent !== undefined;
  const families = [hasSubject, hasReference, hasProperties, hasSubtitles, hasDialogue, hasTrack, hasPrevis, hasFormat, hasSound, hasGenerate, value.speedIntent !== undefined].filter(Boolean).length
    + (value.intents.length > 0 ? 1 : 0);
  if (families !== 1) context.addIssue({code: z.ZodIssueCode.custom, message: 'An action carries exactly one intent family'});
  if (value.speedIntent) {
    const clipIds = [...value.impact.mainTrackClipIds, ...value.impact.otherTrackItemIds];
    if (value.originSide !== 'timeline' || !clipIds.includes(value.speedIntent.operation.clipId)) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'A speed action is timeline-origin and lists the edited clip'});
    }
    return;
  }
  if (hasSubtitles) {
    if (value.originSide !== 'timeline') context.addIssue({code: z.ZodIssueCode.custom, message: 'A subtitle action is timeline-origin'});
    const edited = value.subtitlesIntent!.operation.edits.flatMap(edit => edit.kind === 'add' ? [edit.cue.id] : [edit.cueId]);
    const impacted = new Set(value.impact.subtitleCueIds);
    if (edited.some(id => !impacted.has(id))) context.addIssue({code: z.ZodIssueCode.custom,
      message: 'Subtitle impact must list every edited cue'});
    return;
  }
  if (hasDialogue) {
    const intent = value.dialogueIntent!;
    if (intent.side !== value.originSide) context.addIssue({code: z.ZodIssueCode.custom,
      message: 'A dialogue action must be planned from its own side'});
    const shotIds = new Set<string>(), cueIds = new Set<string>();
    for (const edit of intent.operation.edits) {
      if (edit.kind === 'set-text-by-cue') cueIds.add(edit.cueId);
      else shotIds.add(edit.shotId);
    }
    const impactedShots = new Set(value.impact.nodeIds);
    if ([...shotIds].some(id => !impactedShots.has(id))) context.addIssue({code: z.ZodIssueCode.custom,
      message: 'Dialogue impact must list every edited shot'});
    const impactedCues = new Set(value.impact.subtitleCueIds);
    if ([...cueIds].some(id => !impactedCues.has(id))) context.addIssue({code: z.ZodIssueCode.custom,
      message: 'Dialogue impact must list the edited cue'});
    return;
  }
  if (hasFormat) {
    if (value.intents.length !== 0) context.addIssue({code: z.ZodIssueCode.custom, message: 'A format action carries no CS/TS intent'});
    if (value.originSide !== 'timeline') context.addIssue({code: z.ZodIssueCode.custom, message: 'A format action is timeline-origin'});
    return;
  }
  if (hasSound) {
    if (value.intents.length !== 0) context.addIssue({code: z.ZodIssueCode.custom, message: 'A separate-sound action carries no CS/TS intent'});
    if (value.originSide !== 'timeline') context.addIssue({code: z.ZodIssueCode.custom, message: 'A separate-sound action is timeline-origin'});
    const operation = value.soundIntent!.operation;
    // A resolved action names its new audio clip in the impact and, when it
    // creates a track, that track too. An unresolved preview request may omit
    // both; the service fills them before the envelope is hashed.
    if (operation.audioClipId !== undefined && !value.impact.otherTrackItemIds.includes(operation.audioClipId)) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'Separate-sound impact must list the new audio clip'});
    }
    if (operation.createdTrackId !== undefined && !(value.impact.trackIds ?? []).includes(operation.createdTrackId)) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'Separate-sound impact must list the created track'});
    }
    return;
  }
  if (hasTrack) {
    if (value.intents.length !== 0) context.addIssue({code: z.ZodIssueCode.custom, message: 'A track action carries no CS/TS intent'});
    if (value.originSide !== 'timeline') context.addIssue({code: z.ZodIssueCode.custom, message: 'A track action is timeline-origin'});
    const edit = value.trackIntent!.operation.edit;
    if (!(value.impact.trackIds ?? []).includes(edit.trackId)) context.addIssue({code: z.ZodIssueCode.custom,
      message: 'Track impact must list the added or edited track'});
    return;
  }
  if (hasGenerate) {
    if (value.intents.length !== 0) context.addIssue({code: z.ZodIssueCode.custom, message: 'A generation action carries no CS/TS intent'});
    if (value.originSide !== 'timeline') context.addIssue({code: z.ZodIssueCode.custom, message: 'A generation action is timeline-origin'});
    const operation = value.generateIntent!.operation;
    if (operation.kind === 'generate-placeholder') {
      if (!value.allocation.clips.some(item => item.nodeId === operation.shotId && item.clipId === operation.clipId)) {
        context.addIssue({code: z.ZodIssueCode.custom, message: 'A generation placeholder requires its shot/clip allocation'});
      }
    } else if (operation.kind === 'generate-resize') {
      if (!value.impact.mainTrackClipIds.length) context.addIssue({code: z.ZodIssueCode.custom, message: 'Resizing a placeholder lists its clip impact'});
    }
    return;
  }
  if (hasReference) {
    if (value.intents.length !== 0) context.addIssue({code: z.ZodIssueCode.custom, message: 'A reference action carries no CS/TS intent'});
    if (value.originSide !== 'board') context.addIssue({code: z.ZodIssueCode.custom, message: 'A reference action is board-origin'});
    const edit = value.referenceIntent!.operation.edit;
    // The edge id is pre-allocated in the envelope for retry identity; a subject
    // binding create keeps its own allocation rule in the subject family.
    if (edit.kind === 'attach' && !value.allocation.edges.some(edge => edge.id === edit.edgeId
      && edge.toId === edit.shotId && edge.fromId === edit.sourceNodeId)) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'A reference attach requires its edge allocation'});
    }
    if ((edit.kind === 'set-role' || edit.kind === 'detach') && !value.impact.edgeIds.includes(edit.edgeId)) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'A reference role change or detach must list its edge impact'});
    }
    if (edit.kind === 'reorder' && edit.edgeIds.some(id => !value.impact.edgeIds.includes(id))) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'A reference reorder must list every reordered edge'});
    }
    return;
  }
  if (hasPrevis) {
    if (value.intents.length !== 0 || hasSubject || hasReference || hasProperties) return;
    if (value.originSide !== 'board') context.addIssue({code: z.ZodIssueCode.custom, message: 'A previs action is board-origin'});
    const operation = value.previsIntent!.operation;
    if (operation.kind === 'previs-create') {
      if (value.impact.nodeIds.length !== 1 || value.impact.nodeIds[0] !== operation.nodeId) {
        context.addIssue({code: z.ZodIssueCode.custom, message: 'A previs create names exactly its new node'});
      }
      if (value.baseline.targets.length !== 0) {
        context.addIssue({code: z.ZodIssueCode.custom, message: 'A previs create carries no target revision'});
      }
    } else if (!value.impact.nodeIds.includes(operation.nodeId)) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'A previs save names its node in the impact'});
    }
    return;
  }
  if (hasProperties) {
    if (value.intents.length !== 0) context.addIssue({code: z.ZodIssueCode.custom, message: 'A clip property action carries no CS/TS intent'});
    if (value.originSide !== 'timeline') context.addIssue({code: z.ZodIssueCode.custom, message: 'A clip property action is timeline-origin'});
    const edited = value.propertiesIntent!.operation.edits.map(edit => edit.clipId);
    const impacted = new Set([...value.impact.mainTrackClipIds, ...value.impact.otherTrackItemIds]);
    if (edited.some(id => !impacted.has(id))) context.addIssue({code: z.ZodIssueCode.custom,
      message: 'Clip property impact must list every edited clip'});
    return;
  }
  if (hasSubject) {
    if (value.intents.length !== 0) context.addIssue({code: z.ZodIssueCode.custom, message: 'A subject action carries no CS/TS intent'});
    if (value.originSide !== 'board') context.addIssue({code: z.ZodIssueCode.custom, message: 'A subject action is board-origin'});
    const operation = value.subjectIntent!.operation;
    if (operation.kind !== 'subject-binding') return;
    const edit = operation.edit;
    // A create action also writes the reference edge that connects the subject
    // card to the shot. Its id is pre-allocated in `allocation.edges`, matching
    // the envelope's retry identity; a missing allocation is rejected rather
    // than deriving an id from the binding.
    if (edit.kind === 'create' && !value.allocation.edges.some(edge => edge.toId === edit.shotId)) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'A subject binding create requires its reference edge allocation'});
    }
    return;
  }
  if (value.intents.length === 0) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'An action requires an intent or a subject intent'});
    return;
  }
  if (!isSequenceEditIntentSequence(value.intents as unknown as readonly SequenceEditIntent[])) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Invalid intent sequence'});
  }
  if (value.intents.length > 0 && value.intents[0]!.side !== value.originSide) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'The first intent must belong to the origin side'});
  }
});
export const isSequenceEditEnvelope = (value: unknown): value is SequenceEditEnvelope =>
  sequenceEditEnvelopeSchema.safeParse(value).success;

// ---------------------------------------------------------------------------
// Deltas, patches and the unified undo step
// ---------------------------------------------------------------------------

/** One persisted board object. `data` is the full row JSON the CS reader owns:
 * a shot record, a `Format5Node` or a `Format5Edge`; additions and removals
 * carry the complete object so undo can restore fields SA does not model. */
export const SEQUENCE_EDIT_BOARD_ENTITY_KINDS = Object.freeze(['shot', 'node', 'edge', 'subject_binding', 'adoption'] as const);
export type SequenceEditBoardEntityKind = (typeof SEQUENCE_EDIT_BOARD_ENTITY_KINDS)[number];
export interface SequenceEditBoardEntity {
  readonly kind: SequenceEditBoardEntityKind;
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SequenceEditBoardDelta {
  readonly writes: readonly SequenceEditBoardEntity[];
  /** Removals never carry `subject_binding`: the frozen schema keeps
   * `retain_subject_bindings` and the +1 revision rule, so a binding row is a
   * tombstone. Its `before`/`after` only describe content (mode/version/role);
   * the transaction always applies revision = current + 1, and undoing a create
   * writes a `detached` row instead of deleting it. */
  readonly removals: readonly SequenceEditBoardEntity[];
}

/**
 * Three-state synchronization baseline (coordinator review 11-18): most actions
 * do not change the "last synced" row, and a full 512 KiB snapshot in every
 * before/after patch would exhaust the history budget. `set` stores a snapshot,
 * `absent` removes the stored row, and `unchanged` writes nothing.
 */
export type SequenceEditBaselineChange =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'set'; readonly value: Format5SyncBaseline }
  | { readonly kind: 'absent' };
export const SEQUENCE_EDIT_BASELINE_CHANGE_KINDS = Object.freeze(['unchanged', 'set', 'absent'] as const);

/** Resolve one baseline delta against the row read in the transaction. Both
 * sides must use this helper: `unchanged` returns the current value and writes
 * nothing (undo also leaves the stored row untouched), `absent` deletes it and
 * `set` stores the supplied snapshot. */
export function applySequenceEditBaselineChange(
  current: Format5SyncBaseline | null, change: SequenceEditBaselineChange,
): Format5SyncBaseline | null {
  switch (change.kind) {
    case 'unchanged': return current;
    case 'absent': return null;
    case 'set': return change.value;
  }
}

/** Timeline half of a patch. Entity arrays use the frozen K5a clip/cue shapes;
 * `removed*Ids` are the rows to delete; `baseline` is the three-state delta that
 * the transaction applies to the stored "last synced" row. */
export type SequenceEditSubtitleProfile = {readonly profileId: string; readonly basisPresetId?: string};
/** Three-state subtitle header change: edits that only touch cues keep the
 * profile (`unchanged`), the first cue may create it (`set`), and undo of that
 * creation removes it (`absent`). Omitted means `unchanged`. */
export type SequenceEditSubtitleProfileChange =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'set'; readonly value: SequenceEditSubtitleProfile }
  | { readonly kind: 'absent' };
export interface SequenceEditTimelineDelta {
  readonly clips: readonly Format5Clip[];
  readonly cues: readonly Format5Cue[];
  readonly removedClipIds: readonly string[];
  readonly removedCueIds: readonly string[];
  /** Present only when the output frame changes; older patches omit it. */
  readonly header?: SequenceEditTimelineHeaderChange;
  /** FR-D full header track rows when a track action changed them. */
  readonly tracks?: ReadonlyArray<Format5Timeline['tracks'][number]>;
  readonly baseline: SequenceEditBaselineChange;
  readonly subtitles?: SequenceEditSubtitleProfileChange;
}
export type SequenceEditTimelineHeaderChange =
  | {readonly kind: 'unchanged'}
  | {readonly kind: 'set'; readonly value: {readonly fps: 30; readonly width: number; readonly height: number}};

/** Everything one action wrote or reverted: exactly one `editor_history_entries`
 * patch direction. Reading and writing remain owned by CS/TS services. */
export interface SequenceEditStateDelta {
  readonly board: SequenceEditBoardDelta;
  readonly timeline: SequenceEditTimelineDelta;
}

export interface SequenceEditPatch {
  readonly version: typeof SEQUENCE_EDIT_CONTRACT_VERSION;
  readonly before: SequenceEditStateDelta;
  readonly after: SequenceEditStateDelta;
}

/** Undo and redo are the same action identity: undo applies `before`, redo
 * applies `after`, and a new action truncates the redo branch (plan §5). */
export function invertSequenceEditPatch(patch: SequenceEditPatch): SequenceEditPatch {
  return {...patch, before: patch.after, after: patch.before};
}

/** history-13 row shape both sides write through the shared history module. */
export interface SequenceEditHistoryEntry {
  readonly actionId: string;
  readonly projectId: string;
  readonly epoch: string;
  readonly position: number;
  readonly operation: string;
  readonly origin: 'user' | 'mio';
  readonly beforePatch: SequenceEditStateDelta;
  readonly afterPatch: SequenceEditStateDelta;
  readonly createdAt: string;
}

const entitySchema = z.object({
  kind: z.enum(SEQUENCE_EDIT_BOARD_ENTITY_KINDS), id: uuidSchema, data: z.record(z.unknown()),
}).strict();
const boardDeltaSchema = z.object({
  writes: z.array(entitySchema).max(SEQUENCE_EDIT_LIMITS.boardWrites),
  removals: z.array(entitySchema).max(SEQUENCE_EDIT_LIMITS.boardWrites),
}).strict().superRefine((value, context) => {
  if (value.removals.some(entity => entity.kind === 'subject_binding')) {
    context.addIssue({code: z.ZodIssueCode.custom,
      message: 'Subject binding rows are tombstones and cannot be removed'});
  }
});
const baselineChangeSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('unchanged')}).strict(),
  z.object({kind: z.literal('set'), value: format5SyncBaselineSchema}).strict(),
  z.object({kind: z.literal('absent')}).strict(),
]);
const timelineHeaderChangeSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('unchanged')}).strict(),
  z.object({kind: z.literal('set'), value: z.object({fps: z.literal(30), width: z.number().int().min(2).max(100000),
    height: z.number().int().min(2).max(100000)}).strict()}).strict(),
]);
const timelineDeltaSchema = z.object({
  clips: z.array(z.record(z.unknown())).max(FORMAT5_LIMITS.mainTrackClips + FORMAT5_LIMITS.otherTrackClips),
  cues: z.array(z.record(z.unknown())).max(FORMAT5_LIMITS.subtitleCues),
  removedClipIds: idListSchema(FORMAT5_LIMITS.mainTrackClips + FORMAT5_LIMITS.otherTrackClips),
  removedCueIds: idListSchema(FORMAT5_LIMITS.subtitleCues),
  header: timelineHeaderChangeSchema.optional(),
  tracks: z.array(z.record(z.unknown())).max(FORMAT5_LIMITS.tracks).optional(),
  baseline: baselineChangeSchema,
  subtitles: z.union([
    z.object({kind: z.literal('unchanged')}).strict(),
    z.object({kind: z.literal('absent')}).strict(),
    z.object({kind: z.literal('set'), value: z.object({profileId: z.string().min(1).max(120),
      basisPresetId: z.string().min(1).max(120).optional()}).strict()}).strict(),
  ]).optional(),
}).strict();
const stateDeltaSchema = z.object({board: boardDeltaSchema, timeline: timelineDeltaSchema}).strict();
export const sequenceEditHistoryEntrySchema = z.object({
  actionId: uuidSchema, projectId: uuidSchema, epoch: uuidSchema, position: revisionSchema,
  operation: z.string().refine(value => sequenceEditUtf8Bytes(value) >= 1 && sequenceEditUtf8Bytes(value) <= SEQUENCE_EDIT_LIMITS.operationBytes),
  origin: z.enum(['user', 'mio']),
  beforePatch: stateDeltaSchema, afterPatch: stateDeltaSchema,
  createdAt: z.string().regex(ISO_PATTERN),
}).strict().refine(value => sequenceEditUtf8Bytes(JSON.stringify(value.beforePatch)) + sequenceEditUtf8Bytes(JSON.stringify(value.afterPatch)) <= SEQUENCE_EDIT_LIMITS.patchBytes,
  'History patches exceed the frozen entry budget');

// ---------------------------------------------------------------------------
// Transaction-internal entry signatures
// ---------------------------------------------------------------------------

/**
 * One transaction, in order (plan §4/§5):
 * 1. The caller captures `baseline` before planning and computes the
 *    `requestId`/`inputDigest` pair. A stored receipt for the same digest is
 *    replayed; a different digest is SEQUENCE_EDIT_REQUEST_REUSED.
 * 2. Inside `ProjectStore.tx` the coordinator re-reads the live board, timeline,
 *    baseline and history cursor, then plans once with SA.
 * 3. Board-origin: CS calls `MainTrackProjectionPort.projectMainTrack`;
 *    track-origin: TS calls `BoardSeamProjectionPort.projectBoardSeam`. Both
 *    calls receive the same envelope/state/plan and return only their half of
 *    the patch; neither writes history, target revisions or the content stamp.
 * 4. The coordinator applies both deltas, advances the touched target revisions,
 *    the content stamp, the sync state and the timeline revision, then writes
 *    exactly one `editor_history_entries` row (before/after delta), the bounded
 *    receipt, and the editor-history state/cursor change.
 * 5. Only after commit does the caller publish the HTTP/RPC projection.
 */

/** `ok` plan for one envelope, produced by exactly one `planChainSync` call. */
export type SequenceEditPlan = Extract<ChainSyncPlan, {readonly ok: true}>;

export const SEQUENCE_EDIT_DIALOGUE_BLOCKER_LIMIT = 8;
export const sequenceEditDialogueConflictSchema = z.object({
  blockers: z.array(z.object({
    cueId: uuidSchema, startFrame: sequenceSchema, endFrame: sequenceSchema, textExcerpt: z.string().max(25),
  }).strict()).max(SEQUENCE_EDIT_DIALOGUE_BLOCKER_LIMIT),
  blockerCount: sequenceSchema,
  requiredFrames: sequenceSchema.positive(),
  availableFrames: sequenceSchema,
}).strict();
export type SequenceEditDialogueConflict = z.infer<typeof sequenceEditDialogueConflictSchema>;

export interface SequenceEditTransactionFailure {
  readonly ok: false;
  readonly code: SequenceEditErrorCode;
  readonly ids: readonly string[];
  /** Bounded validation reason for a user-facing explanation; no raw data. */
  readonly reason?: string;
  readonly message?: string;
  readonly dialogueConflict?: SequenceEditDialogueConflict;
}

/** Input both transaction-internal entries receive. The coordinator reads the
 * live SA state and plans inside the same `ProjectStore.tx` before calling the
 * other side; entries never open a nested transaction and never await IO. */
export interface SequenceEditTransactionRequest {
  readonly envelope: SequenceEditEnvelope;
  readonly state: ChainSyncState;
  readonly plan: SequenceEditPlan;
}

export interface SequenceEditBoardCommit {
  readonly ok: true;
  readonly delta: SequenceEditBoardDelta;
  /** `project_file.contentSequence` after the coordinator advances the stamp. */
  readonly contentRevision: number;
}
export interface SequenceEditTimelineCommit {
  readonly ok: true;
  readonly delta: SequenceEditTimelineDelta;
  readonly warnings: readonly ChainSyncWarning[];
  readonly timelineRevision: number;
  readonly syncRevision: number;
}

/**
 * Implemented by TS, called by CS inside CS's transaction for a board-origin
 * action. It maps the SA plan onto timeline entity/baseline writes and returns
 * the timeline half of the patch. No history row and no content stamp is
 * written here; the coordinator composes both halves and writes them once.
 */
export interface MainTrackProjectionPort {
  projectMainTrack(request: SequenceEditTransactionRequest): SequenceEditTimelineCommit | SequenceEditTransactionFailure;
}

/**
 * Implemented by CS, called by TS inside TS's transaction for a track-origin
 * action. It maps the SA plan onto board node/edge writes (including the seam
 * rewiring of inserted/deleted/reordered segments) and returns the board half.
 */
export interface BoardSeamProjectionPort {
  projectBoardSeam(request: SequenceEditTransactionRequest): SequenceEditBoardCommit | SequenceEditTransactionFailure;
}

// ---------------------------------------------------------------------------
// Receipts, history views and the service entry
// ---------------------------------------------------------------------------

export interface SequenceEditAffectedCounts {
  readonly nodes: number;
  readonly edges: number;
  readonly mainTrackClips: number;
  readonly otherTrackItems: number;
  readonly subtitleCues: number;
  /** SB subject bindings created/changed/detached by this action. Optional so
   * pre-SB receipts still parse; a subject action always reports it. */
  readonly subjectBindings?: number;
  /** FR-D header track rows created/changed by the action. */
  readonly tracks?: number;
}
export interface SequenceEditHistoryAction {
  readonly actionId: string;
  readonly operation: string;
  readonly affected: number;
  /** Present only for Mio-origin actions (D5); user actions stay byte-identical. */
  readonly origin?: 'user' | 'mio';
}
export interface SequenceEditHistoryView {
  readonly epoch: string;
  readonly position: number;
  readonly revision: number;
  readonly undo: SequenceEditHistoryAction | null;
  readonly redo: SequenceEditHistoryAction | null;
}
export interface SequenceEditHistoryCursor {
  readonly position: number;
  readonly revision: number;
}

/** Non-blocking warnings a successful action can return. They are part of the
 * shared receipt because a replayed request must return the same reasons, and
 * UI-E2/MT render them without recomputing SA state. `SOURCE_TOO_SHORT` is the
 * TS main-track warning (an older applied version kept its cut). */
export const SEQUENCE_EDIT_WARNING_CODES = Object.freeze(['SOURCE_TOO_SHORT'] as const);
export type SequenceEditWarningCode = (typeof SEQUENCE_EDIT_WARNING_CODES)[number];

/** `editor_requests.response`, bounded by the frozen 64 KiB receipt window. */
export interface SequenceEditReceipt {
  readonly version: typeof SEQUENCE_EDIT_CONTRACT_VERSION;
  readonly requestId: string;
  readonly inputDigest: string;
  readonly projectId: string;
  readonly actionId: string;
  readonly operation: string;
  readonly originSide: SequenceEditSide;
  readonly status: 'applied' | 'not_applied';
  readonly code?: SequenceEditErrorCode;
  /** Present only on an applied receipt that has something to report. */
  readonly warnings?: readonly ChainSyncWarning[];
  readonly affected: SequenceEditAffectedCounts;
  readonly history: SequenceEditHistoryView;
  readonly contentRevision: number;
  readonly timelineRevision: number;
  readonly syncRevision: number;
  /** Present on applied scene-split receipts: changed and skipped clips. */
  readonly sceneSplit?: SequenceEditSceneSplit;
}
export const sequenceEditHistoryActionSchema = z.object({actionId: uuidSchema, operation: boundedText(SEQUENCE_EDIT_LIMITS.operationBytes), affected: sequenceSchema,
  origin: z.enum(['user', 'mio']).optional()}).strict();
const historyActionSchema = sequenceEditHistoryActionSchema;
export const sequenceEditHistoryViewSchema = z.object({
  epoch: uuidSchema, position: sequenceSchema, revision: revisionSchema,
  undo: historyActionSchema.nullable(), redo: historyActionSchema.nullable(),
}).strict();
export const sequenceEditAffectedCountsSchema = z.object({
  nodes: sequenceSchema, edges: sequenceSchema, mainTrackClips: sequenceSchema,
  otherTrackItems: sequenceSchema, subtitleCues: sequenceSchema, subjectBindings: sequenceSchema.optional(),
  tracks: sequenceSchema.optional(),
}).strict();
export const SEQUENCE_EDIT_SCENE_SPLIT_SKIP_REASONS = Object.freeze(['NO_CUT_IN_RANGE', 'FADE_BOUNDS'] as const);
export type SequenceEditSceneSplitSkipReason = (typeof SEQUENCE_EDIT_SCENE_SPLIT_SKIP_REASONS)[number];
export interface SequenceEditSceneSplitRow {readonly clipId: string; readonly clipIds: readonly string[];
  readonly cutFrames: readonly number[]; readonly fadeCutFrames: readonly number[]}
export interface SequenceEditSceneSplitSkipped {readonly clipId: string;
  readonly reason: SequenceEditSceneSplitSkipReason; readonly cutFrames?: readonly number[]}
export interface SequenceEditSceneSplit {readonly split: readonly SequenceEditSceneSplitRow[];
  readonly skipped: readonly SequenceEditSceneSplitSkipped[]}
const frameListSchema = (max: number) => z.array(sequenceSchema).max(max);
const sceneSplitRowSchema = z.object({clipId: uuidSchema, clipIds: idListSchema(1501), cutFrames: frameListSchema(1500),
  fadeCutFrames: frameListSchema(1500)}).strict();
const sceneSplitSkippedSchema = z.object({clipId: uuidSchema,
  reason: z.enum(SEQUENCE_EDIT_SCENE_SPLIT_SKIP_REASONS), cutFrames: frameListSchema(1500).optional()}).strict();
const sceneSplitSchema = z.object({split: z.array(sceneSplitRowSchema).max(100),
  skipped: z.array(sceneSplitSkippedSchema).max(100)}).strict();
export const sequenceEditReceiptSchema = z.object({
  version: z.literal(SEQUENCE_EDIT_CONTRACT_VERSION),
  requestId: z.string().refine(isSequenceEditRequestId, 'Invalid request id'), inputDigest: digestSchema,
  projectId: uuidSchema, actionId: uuidSchema, operation: boundedText(SEQUENCE_EDIT_LIMITS.operationBytes),
  originSide: z.enum(SEQUENCE_EDIT_SIDES), status: z.enum(['applied', 'not_applied']),
  code: z.string().min(1).max(SEQUENCE_EDIT_LIMITS.operationBytes).optional(),
  warnings: z.array(z.object({
    code: z.literal('SOURCE_TOO_SHORT'), clipId: uuidSchema, nodeId: uuidSchema,
    versionId: uuidSchema, shortByFrames: sequenceSchema,
  }).strict()).max(FORMAT5_LIMITS.mainTrackClips).optional(),
  affected: sequenceEditAffectedCountsSchema, history: sequenceEditHistoryViewSchema,
  contentRevision: sequenceSchema, timelineRevision: revisionSchema, syncRevision: revisionSchema,
  sceneSplit: sceneSplitSchema.optional(),
}).strict().refine(value => value.status === 'applied' ? value.code === undefined : value.code !== undefined,
  'Only a not-applied receipt carries an error code').refine(value => value.status === 'applied' || value.warnings === undefined,
  'A not-applied receipt carries no warnings');

/** External service entry shared by UI-B/UI-E/MT. The same envelope shape feeds
 * `apply`; undo/redo address one existing history action and never blindly apply
 * when the cursor moved. */
export interface SequenceEditCommitRequest {
  readonly envelope: SequenceEditEnvelope;
  /** Impact digest from the preview/confirmation the user accepted. */
  readonly expectedPlanDigest?: string;
}
export interface SequenceEditHistoryCommand {
  readonly projectId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly direction: 'undo' | 'redo';
  readonly expected: SequenceEditHistoryCursor;
  /** Which stack this command belongs to; defaults to the user stack. */
  readonly origin?: 'user' | 'mio';
}
export interface SequenceEditCommitResult {
  readonly ok: true;
  readonly actionId: string;
  readonly operation: string;
  readonly patch: SequenceEditPatch;
  readonly receipt: SequenceEditReceipt;
}
export interface SequenceEditService {
  apply(request: SequenceEditCommitRequest): SequenceEditCommitResult | SequenceEditTransactionFailure;
  undo(command: SequenceEditHistoryCommand): SequenceEditCommitResult | SequenceEditTransactionFailure;
  redo(command: SequenceEditHistoryCommand): SequenceEditCommitResult | SequenceEditTransactionFailure;
}

// ---------------------------------------------------------------------------
// Idempotency digest
// ---------------------------------------------------------------------------

/** Domain separation for `editor_requests.inputDigest`. The host hashes
 * `canonicalSequenceEditInput(envelope)` with SHA-256 and stores the lowercase
 * hex digest. Both sides must use this recipe so a replay is recognized. */
export const SEQUENCE_EDIT_DIGEST_DOMAIN = 'mioon.sequence-edit.action.v1';

const stableKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) sorted[key] = stableKeys(item);
    }
    return sorted;
  }
  return value;
};
/** Deterministic JSON: object keys sorted recursively, array order preserved.
 * Callers hash the returned string with SHA-256 to obtain `inputDigest`. */
export function canonicalSequenceEditInput(envelope: SequenceEditEnvelope): string {
  return `${SEQUENCE_EDIT_DIGEST_DOMAIN}\n${JSON.stringify(stableKeys(envelope))}`;
}

// ---------------------------------------------------------------------------
// Shared error-code table
// ---------------------------------------------------------------------------

/** Plus `CHAIN_TRACK_MISMATCH` (sync failure) and `COPY_NODE_REQUIRED` (a copy
 * decision is missing) these are every non-storage failure `ChainSyncPlan` can
 * return; board and main-track codes are listed separately below. */
const CHAIN_SYNC_FAILURE_CODES = Object.freeze([
  'FILM_NOT_FOUND', 'ACTIVE_FILM_REMOVED', 'FILM_SCOPE_MISMATCH', 'CHAIN_TRACK_MISMATCH',
  'CLIP_NOT_FOUND', 'INVALID_SPLIT', 'INSERT_BETWEEN_SPLIT_PARTS', 'COPY_NODE_EXISTS',
  'INVALID_ANCHOR', 'INVALID_TRACK_TARGET', 'COPY_NODE_REQUIRED',
] as const satisfies readonly Extract<ChainSyncPlan, {readonly ok: false}>['code'][]);
const BOARD_SEQUENCE_ERROR_CODES = Object.freeze([
  'INVALID_SEQUENCE_TYPES', 'INVALID_REFERENCE_TYPES', 'FILM_MUST_START', 'TEXT_IS_ANNOTATION',
  'INVALID_CONNECTION_TYPES', 'MISSING_NODE', 'DUPLICATE_NODE', 'MISSING_EDGE', 'DUPLICATE_EDGE',
  'MULTIPLE_PREDECESSORS', 'MULTIPLE_SUCCESSORS', 'CYCLE', 'NODE_ALREADY_LINKED',
] as const satisfies readonly BoardSequenceErrorCode[]);
const MAIN_TRACK_ERROR_CODES = Object.freeze([
  'DUPLICATE_MEDIA', 'INVALID_MEDIA', 'MISSING_MEDIA', 'DUPLICATE_CLIP', 'INVALID_CLIP_FRAMES',
  'INVALID_CLIP_VERSION', 'TRACK_OVERLAP', 'DUPLICATE_TRACK_NODE', 'INVALID_SPLIT_GROUP',
  'TRACK_FRAME_OVERFLOW', 'NEW_CLIP_ID_REQUIRED', 'SOURCE_BOUNDS',
] as const satisfies readonly MainTrackErrorCode[]);

/**
 * Contract-level codes. Reused K5a/SA codes above stay authoritative; these six
 * cover the cross-side transaction envelope that neither side owned before:
 * - `SEQUENCE_EDIT_CONTRACT_INVALID`: bad version/ids/bounds/side-kind or an
 *   action outside the allowed single/repair shape.
 * - `SEQUENCE_EDIT_REQUEST_REUSED`: the request id already has a receipt with a
 *   different input digest. Never overwrite the immutable receipt.
 * - `SEQUENCE_EDIT_REVISION_CONFLICT`: content/timeline/sync/history or a target
 *   revision changed since planning. Retryable after the caller re-reads.
 * - `SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE`: explicit format-5 admission while the
 *   TS transaction seam is not registered yet; reject writes to a root-bound
 *   chain (plan §7).
 * - `SEQUENCE_EDIT_HISTORY_CONFLICT`: the undo/redo cursor or branch moved; do
 *   not blindly undo (plan §5).
 * - `SEQUENCE_EDIT_PATCH_INVALID`: a stored history patch is outside the frozen
 *   bounds or cannot be applied to the current state.
 * - `SEQUENCE_EDIT_NOOP`: the request is valid but the live state already equals
 *   the requested state; nothing was written, no history entry or revision moved,
 *   and only the immutable receipt (status `not_applied`) is stored so an exact
 *   retry returns the same answer.
 * - `SEQUENCE_EDIT_ANCHOR_CONFLICT`: after a track edit the other-track clips or
 *   cues would overlap, leave the timeline, or lose their anchor target; the
 *   whole action is rejected with the affected ids and nothing is written (P5 D3).
 *   If a cross-track drop overlaps existing clips, preview returns the ids of
 *   those clips on the destination track after main-track compaction.
 * - `SEQUENCE_EDIT_SUBJECT_BINDING_INVALID`: a subject-binding intent names a
 *   missing/foreign shot or subject, a role that does not match the subject kind,
 *   a locked version that does not belong to the same subject, or an edge/row
 *   identity that already has a different owner. The board transaction refuses
 *   it instead of writing a dangling reference edge.
 * - `SEQUENCE_EDIT_SUBJECT_VERSION_HIDDEN`: a locked mode selected a subject
 *   version that belongs to an undone angle/lighting batch; the version stays
 *   readable as history evidence but cannot become a new generation input.
 * - `SEQUENCE_EDIT_SUBJECT_BINDING_LIMIT`: the shot already has the frozen
 *   number of active (follow/locked) subject/style bindings; a detached
 *   tombstone never counts toward the limit.
 * - `SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID`: a clip property edit names a
 *   missing/wrong-track clip, a value outside the frozen clip schema (transform
 *   keyframes, transition fit, gain/fades/envelope/colour/audio role), or the
 *   same clip twice. Nothing is written; the caller re-previews.
 * - `SEQUENCE_EDIT_PREVIS_INVALID`: a previs create names an occupied node id or
 *   exceeds the previs capacity, or a previs save names a missing/foreign/
 *   archived node, a stale scene revision, or an export image that is not an
 *   owned image asset. Nothing is written; the caller re-previews.
 * - `SEQUENCE_EDIT_SUBTITLE_INVALID`: a subtitle edit names a missing cue or an
 *   existing cue id again, the text/interval is outside the frozen subtitle
 *   schema, the anchor clip does not own the cue start, or cues overlap. Nothing
 *   is written; the caller re-previews.
 * - `SEQUENCE_EDIT_REFERENCE_INVALID`: a material reference action names a
 *   missing/archived/foreign source or shot, a role that the source type cannot
 *   provide, a subject-card connector (which belongs to the SB binding family),
 *   a previs node without a verifiable published output, an edge that is not a
 *   material reference, or an edge identity already used by another owner.
 * - `SEQUENCE_EDIT_DIALOGUE_INVALID`: a dialogue edit names a missing/archived
 *   shot, a line that does not exist there, an unsupported subtitle text, a
 *   speaker that is not a project subject, a line id that already exists, or a
 *   cue whose `dialogueRef` does not resolve. Nothing is written.
 * - `SEQUENCE_EDIT_DIALOGUE_CONFLICT`: the projected cues cannot be placed
 *   legally (the shot span has too few free frames, or a plain subtitle occupies
 *   every legal frame). The whole action is rejected with the affected ids; no
 *   text is truncated and no ordinary cue is renamed or moved (P5 D7).
 * - `SEQUENCE_EDIT_SOUND_INVALID`: «separate sound» names a missing/wrong-track
 *   clip, a placeholder, a source without an actual audio stream, or an audio
 *   layout that cannot hold the new sound clip. Nothing is written.
 */
export const SEQUENCE_EDIT_NEW_ERROR_CODES = Object.freeze([
  'SEQUENCE_EDIT_CONTRACT_INVALID', 'SEQUENCE_EDIT_REQUEST_REUSED', 'SEQUENCE_EDIT_REVISION_CONFLICT',
  'SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE', 'SEQUENCE_EDIT_HISTORY_CONFLICT', 'SEQUENCE_EDIT_PATCH_INVALID',
  'SEQUENCE_EDIT_NOOP', 'SEQUENCE_EDIT_ANCHOR_CONFLICT', 'SEQUENCE_EDIT_SUBJECT_BINDING_INVALID',
  'SEQUENCE_EDIT_SUBJECT_VERSION_HIDDEN', 'SEQUENCE_EDIT_SUBJECT_BINDING_LIMIT',
  'SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID', 'SEQUENCE_EDIT_PREVIS_INVALID', 'SEQUENCE_EDIT_SUBTITLE_INVALID',
  'SEQUENCE_EDIT_REFERENCE_INVALID', 'SEQUENCE_EDIT_TRACK_INVALID', 'SEQUENCE_EDIT_DIALOGUE_INVALID',
  'SEQUENCE_EDIT_DIALOGUE_CONFLICT', 'SEQUENCE_EDIT_SOUND_INVALID', 'SEQUENCE_EDIT_SCENE_RESULT_CONFLICT', 'SEQUENCE_EDIT_SCENE_RESULT_STALE',
  'TIMELINE_FORMAT_TIER_MISMATCH', 'NOTHING_TO_SPLIT', 'SEQUENCE_EDIT_GENERATION_INVALID',
  'SPEED_NOT_SUPPORTED', 'SPEED_SOURCE_NOT_READY', 'INTERPOLATION_UNAVAILABLE', 'UNSUPPORTED_FORMAT', ...TIMELINE_TIME_MAP_ERROR_CODES] as const);
export type SequenceEditNewErrorCode = (typeof SEQUENCE_EDIT_NEW_ERROR_CODES)[number];
export type SequenceEditPlanFailureCode = Extract<ChainSyncPlan, {readonly ok: false}>['code'];
export type SequenceEditErrorCode = Format5ErrorCode | SequenceEditPlanFailureCode | SequenceEditNewErrorCode;
export type SequenceEditErrorSource = 'format5' | 'sa' | 'sequence-edit';
export interface SequenceEditErrorDescriptor {
  readonly code: SequenceEditErrorCode;
  readonly source: SequenceEditErrorSource;
  readonly retryable: boolean;
}
const descriptor = (code: SequenceEditErrorCode, source: SequenceEditErrorSource, retryable = false): SequenceEditErrorDescriptor =>
  Object.freeze({code, source, retryable});
export const SEQUENCE_EDIT_ERRORS: readonly SequenceEditErrorDescriptor[] = Object.freeze([
  ...FORMAT5_STORAGE_ERROR_CODES.map(code => descriptor(code, 'format5', code === 'FORMAT5_SYNC_REVISION_CONFLICT')),
  ...BOARD_SEQUENCE_ERROR_CODES.map(code => descriptor(code, 'sa')),
  ...MAIN_TRACK_ERROR_CODES.map(code => descriptor(code, 'sa')),
  ...CHAIN_SYNC_FAILURE_CODES.map(code => descriptor(code, 'sa', code === 'CHAIN_TRACK_MISMATCH')),
  ...SEQUENCE_EDIT_NEW_ERROR_CODES.map(code => descriptor(code, 'sequence-edit', code === 'SEQUENCE_EDIT_REVISION_CONFLICT')),
]);
/** Flat union of every shared code, in table order (unique by construction). */
export const SEQUENCE_EDIT_ERROR_CODES: readonly SequenceEditErrorCode[] = Object.freeze(SEQUENCE_EDIT_ERRORS.map(entry => entry.code));
/** Compile-time proof that the table covers every code both sides may return. */
type AssertNever<T extends never> = T;
export type SequenceEditErrorTableCoverage = AssertNever<
  Exclude<SequenceEditErrorCode, (typeof SEQUENCE_EDIT_ERRORS)[number]['code']>
>;
export const isSequenceEditErrorCode = (value: unknown): value is SequenceEditErrorCode =>
  typeof value === 'string' && SEQUENCE_EDIT_ERRORS.some(entry => entry.code === value);
