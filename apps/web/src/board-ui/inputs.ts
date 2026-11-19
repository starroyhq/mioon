/** RI-b: reference-line commands and the live generation-input view used by the
 * format-5 board and its property panel.
 *
 * Request builders emit exactly the shared `sequence.preview / commit` payloads;
 * the workbench-owned service allocates the envelope, edge/binding ids and the
 * plan digest. No React state or provider lookup lives here.
 */
import type {ChainReferenceRole, ReferenceSourceKind} from '../../../../packages/contracts/src/board-sequence.ts';
import {REFERENCE_SOURCE_ROLES} from '../../../../packages/contracts/src/board-sequence.ts';
import type {SequenceEditIntent, SequenceEditReferenceIntent, SequenceEditSubjectIntent} from '../../../../packages/contracts/src/sequence-edit.ts';
import type {SequenceGenerationInputEntryView, SequenceGenerationInputMode,
  SequenceGenerationInputView} from '../../../../packages/contracts/src/sequence-inspection.ts';

export type {SequenceGenerationInputEntryView, SequenceGenerationInputMode, SequenceGenerationInputView};

/** Exactly one previewed action family; mirrors the shared envelope rules. */
export type BoardEditRequest =
  | {readonly intents: readonly SequenceEditIntent[]}
  | {readonly referenceIntent: SequenceEditReferenceIntent}
  | {readonly subjectIntent: SequenceEditSubjectIntent};

export const isBoardEditRequest = (value: unknown): value is BoardEditRequest => {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if ('intents' in row) return Array.isArray(row.intents);
  return 'referenceIntent' in row || 'subjectIntent' in row;
};

const uuid = (): string => globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.floor(Math.random() * 16);
    return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });

/** Connect a material card (image/video/audio/previs) to a shot. The role comes
 * from the port classification; the service defaults it by source type when
 * omitted. */
export function referenceAttachRequest(sourceNodeId: string, shotId: string,
  role?: ChainReferenceRole): BoardEditRequest {
  return {referenceIntent: {side: 'board', operation: {kind: 'reference-edge', edit: {kind: 'attach',
    edgeId: uuid(), shotId, sourceNodeId, ...(role ? {role} : {})}}}};
}

/** SB-a owns the subject-card binding row; the shared service routes this to the
 * subject planner, never to the material reference planner. */
export function subjectBindingCreateRequest(shotId: string, subjectId: string,
  role: 'subject' | 'style'): BoardEditRequest {
  return {subjectIntent: {side: 'board', operation: {kind: 'subject-binding', edit: {kind: 'create',
    bindingId: uuid(), shotId, subjectId, role}}}};
}

export function referenceRoleRequest(edgeId: string, shotId: string, role: ChainReferenceRole): BoardEditRequest {
  return {referenceIntent: {side: 'board', operation: {kind: 'reference-edge', edit: {kind: 'set-role',
    edgeId, shotId, role}}}};
}

export function referenceDetachRequest(edgeId: string, shotId: string): BoardEditRequest {
  return {referenceIntent: {side: 'board', operation: {kind: 'reference-edge', edit: {kind: 'detach',
    edgeId, shotId}}}};
}

export function subjectBindingDetachRequest(bindingId: string): BoardEditRequest {
  return {subjectIntent: {side: 'board', operation: {kind: 'subject-binding', edit: {kind: 'detach', bindingId}}}};
}

/** Complete order of one shot's material reference lines. The first reference
 * image becomes the primary image and the provider numbering base. */
export function referenceReorderRequest(shotId: string, edgeIds: readonly string[]): BoardEditRequest {
  return {referenceIntent: {side: 'board', operation: {kind: 'reference-edge', edit: {kind: 'reorder',
    shotId, edgeIds: [...edgeIds]}}}};
}

export const referenceRoleKeys = {
  first_frame: 'boardUi.role.firstFrame',
  last_frame: 'boardUi.role.lastFrame',
  reference_image: 'boardUi.role.referenceImage',
  subject_reference: 'boardUi.role.subject',
  style_reference: 'boardUi.role.style',
  composition: 'boardUi.role.composition',
  reference_audio: 'boardUi.role.audio',
  reference_video: 'boardUi.role.video',
} as const satisfies Record<ChainReferenceRole, string>;

export const generationModeKeys = {
  text: 'boardUi.inputs.mode.text',
  frames: 'boardUi.inputs.mode.frames',
  references: 'boardUi.inputs.mode.references',
} as const satisfies Record<SequenceGenerationInputMode, string>;

/** Stable short reason text. The design keeps only the reason; unknown codes
 * fall back to the generic unsupported label instead of exposing raw internals. */
export const unsupportedReasonKeys = {
  SERVICE_NOT_SELECTED: 'boardUi.inputs.reason.serviceNotSelected',
  EXCLUSIVE_MODE: 'boardUi.inputs.reason.exclusiveMode',
  UNSUPPORTED_FRAME_INPUT: 'boardUi.inputs.reason.unsupported',
  UNSUPPORTED_LAST_FRAME: 'boardUi.inputs.reason.unsupported',
  UNSUPPORTED_REFERENCE_IMAGES: 'boardUi.inputs.reason.unsupported',
  UNSUPPORTED_REFERENCE_AUDIO: 'boardUi.inputs.reason.unsupported',
  UNSUPPORTED_REFERENCE_VIDEO: 'boardUi.inputs.reason.unsupported',
  UNSUPPORTED_REFERENCE_ROLE: 'boardUi.inputs.reason.unsupported',
  CAPACITY_EXCEEDED: 'boardUi.inputs.reason.capacity',
  INVALID_REFERENCE_AUDIO: 'boardUi.inputs.reason.audioInvalid',
  REFERENCE_AUDIO_TOO_LONG: 'boardUi.inputs.reason.audioTooLong',
  LAST_FRAME_WITHOUT_FIRST: 'boardUi.inputs.reason.tailWithoutHead',
} as const;

export function unsupportedReasonKey(reason: string | undefined): string {
  return reason && Object.hasOwn(unsupportedReasonKeys, reason)
    ? unsupportedReasonKeys[reason as keyof typeof unsupportedReasonKeys]
    : 'boardUi.inputs.unsupported';
}

export function referenceRoleKey(role: ChainReferenceRole): string {
  return referenceRoleKeys[role] ?? 'boardUi.inputs.unsupported';
}

/** Roles the source card may carry; shared with the service so the menu never
 * offers a role the planner would reject. */
export function referenceRoleOptions(kind: ReferenceSourceKind): readonly ChainReferenceRole[] {
  return REFERENCE_SOURCE_ROLES[kind];
}

/** Song/track icon per source family (visual only, no separate semantics). */
export const sourceKindIcons = {
  image: 'image', video: 'film', audio: 'music', previs: 'grid', subject: 'sparkle',
} as const satisfies Record<SequenceGenerationInputEntryView['sourceKind'], string>;

/** A material line's source family from its role; reads that need the card kind
 * use the entry's `sourceKind` instead. */
export function isPrimaryCandidate(entry: SequenceGenerationInputEntryView): boolean {
  return entry.source === 'edge' && entry.edgeId !== undefined && entry.appliedRole === 'reference_image';
}
