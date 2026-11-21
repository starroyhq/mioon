/** Bounded, paginated format-5 sequence inspection shared by Mio/MT and UI.
 * A page is bound to one frozen snapshot id; continuing with a cursor from a
 * different snapshot is rejected so the model never stitches mismatched reads. */
import {z} from 'zod';
import type {DialogueAudioMode, DialogueDeliveryStyle} from './dialogue-generation.ts';
import {FORMAT5_INPUT_LIMITS} from './project-format5.ts';
import type {ChainReferenceRole} from './board-sequence.ts';

const uuid = z.string().uuid();
export const SEQUENCE_INSPECTION_LIMITS = Object.freeze({maxLimit: 50, maxCursorBytes: 512});
export const sequenceInspectionArgumentSchema = z.object({
  rootId: uuid.optional(),
  limit: z.number().int().min(1).max(SEQUENCE_INSPECTION_LIMITS.maxLimit).optional(),
  cursor: z.string().min(1).max(SEQUENCE_INSPECTION_LIMITS.maxCursorBytes)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/).optional(),
}).strict();
export const sequenceInspectionSchemas = Object.freeze({
  'sequence.inspect': sequenceInspectionArgumentSchema.extend({projectId: uuid}).strict(),
});
export type SequenceInspectionInput = z.infer<typeof sequenceInspectionSchemas['sequence.inspect']>;

/** One ordered chain segment; free/orphan nodes are not invented into the chain. */
export interface SequenceInspectionSegment {
  readonly nodeId: string;
  readonly kind: 'shot' | 'video' | 'image' | 'text';
  readonly order: number;
  readonly groupIds: readonly string[];
  readonly clipIds: readonly string[];
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly clips: readonly {
    readonly id: string; readonly startFrame: number; readonly durationFrames: number; readonly sourceInFrame: number;
    readonly sourceState?: 'ready' | 'placeholder'; readonly versionMode?: 'follow' | 'locked';
    readonly appliedVersionId?: string | null; readonly boardVersionId?: string | null;
    readonly anchor?: {readonly clipId: string; readonly offsetFrames: number} | null;
  }[];
  readonly inSync: boolean;
  /** RI-a: material reference lines attached to this shot, capped per segment;
   * subject bindings are listed separately as SB evidence. */
  readonly references?: readonly {
    readonly edgeId: string;
    readonly role: string;
    readonly assetId: string;
    readonly sourceNodeId: string;
  }[];
  readonly referenceCount?: number;
  /** DL-a: the shot's ordered dialogue lines (its cue projection is validated by
   * the kernel; the lines are the authoritative text). */
  readonly dialogue?: readonly {
    readonly id: string; readonly text: string; readonly speakerSubjectId?: string;
  }[];
}
export interface SequenceInspectionDiff {
  readonly kind: 'board' | 'track' | 'anchor';
  readonly id: string;
  readonly reason: string;
}
export interface SequenceInspectionPage {
  readonly projectId: string;
  readonly rootNodeId: string;
  readonly snapshotId: string;
  readonly contentRevision: number;
  readonly timelineRevision: number;
  readonly syncRevision: number;
  readonly total: number;
  readonly items: readonly SequenceInspectionSegment[];
  readonly differences: readonly SequenceInspectionDiff[];
  readonly freeNodeIds: readonly string[];
  readonly nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Live generation-input projection (RI-b property panel)
// ---------------------------------------------------------------------------

export const SEQUENCE_GENERATION_INPUT_LIMITS = Object.freeze({
  entries: FORMAT5_INPUT_LIMITS.referenceEdgesPerShot + FORMAT5_INPUT_LIMITS.subjectBindingsPerShot
    + FORMAT5_INPUT_LIMITS.previsSceneSubjects,
});
/** The built-in Mock provider has no configured video connection. The board's
 * read-only input projection still needs an exact identity to report the
 * selected service, so the client sends these reserved UUIDs; the service maps
 * them to Mock capabilities instead of video-settings selection. */
export const FORMAT5_MOCK_INPUT_CONNECTION_ID = '00000000-0000-4000-8000-0000000000a1';
export const FORMAT5_MOCK_INPUT_MODEL_ENTRY_ID = '00000000-0000-4000-8000-0000000000a2';
export const FORMAT5_MOCK_INPUT_CONFIGURATION_REVISION = 1;

export const sequenceGenerationInputSchemas = Object.freeze({
  'sequence.generation-inputs.get': z.object({
    projectId: uuid, shotId: uuid,
    connectionId: uuid.optional(), configurationRevision: z.number().int().positive().optional(),
    modelEntryId: uuid.optional(),
    /** Current "生成声音" switch for this shot; omitted means the service default. */
    generateAudio: z.boolean().optional(),
  }).strict().superRefine((value, context) => {
    const triple = [value.connectionId, value.configurationRevision, value.modelEntryId];
    const supplied = triple.filter(item => item !== undefined).length;
    if (supplied !== 0 && supplied !== 3) {
      context.addIssue({code: z.ZodIssueCode.custom, path: ['connectionId'],
        message: 'A video connection needs connectionId, configurationRevision and modelEntryId together.'});
    }
  }),
});
export type SequenceGenerationInputRequest = z.infer<(typeof sequenceGenerationInputSchemas)['sequence.generation-inputs.get']>;

export type SequenceGenerationInputMode = 'text' | 'frames' | 'references';
export type SequenceGenerationInputStatus = 'used' | 'unsupported';
/** One connected input as the property panel shows it. `label` is already
 * resolved (node/asset/subject name plus version) and `reason` is a stable code
 * the browser localizes; unknown roles never disappear from the list. */
export interface SequenceGenerationInputEntryView {
  readonly source: 'edge' | 'subject' | 'previs';
  readonly edgeId?: string;
  readonly bindingId?: string;
  readonly sourceNodeId?: string;
  readonly sourceKind: 'image' | 'video' | 'audio' | 'previs' | 'subject';
  readonly role: ChainReferenceRole;
  readonly appliedRole?: 'first_frame' | 'last_frame' | 'reference_image' | 'subject_reference' | 'reference_audio';
  readonly status: SequenceGenerationInputStatus;
  readonly reason?: string;
  readonly label: string;
  readonly subjectVersionNumber?: number;
  readonly orderIndex: number;
  readonly primary?: boolean;
}
export interface SequenceGenerationInputServiceView {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly profileId: string;
  readonly profileVersion: string;
}
export type SequenceGenerationDialogueStatus = 'used' | 'unsupported' | 'rejected';
/** DL-b dialogue status for the same selected service. `reason` is a stable code
 * (`SERVICE_NOT_SELECTED`, `SERVICE_DOES_NOT_SPEAK`, `PROMPT_TOO_LONG`) the panel
 * localizes; docs list the official rules the style is based on. */
export interface SequenceGenerationDialogueView {
  readonly status: SequenceGenerationDialogueStatus;
  readonly lineCount: number;
  readonly reason?: string;
  readonly promptCodeUnits: number;
  readonly maxPromptCodeUnits: number;
  readonly style?: DialogueDeliveryStyle;
  readonly audioMode?: DialogueAudioMode;
  readonly docs?: readonly string[];
}
export interface SequenceGenerationInputView {
  readonly projectId: string;
  readonly shotId: string;
  readonly shotRevision: number;
  readonly mode: SequenceGenerationInputMode;
  readonly service: SequenceGenerationInputServiceView | null;
  readonly entries: readonly SequenceGenerationInputEntryView[];
  readonly usedCount: number;
  readonly unsupportedCount: number;
  readonly primaryEdgeId: string | null;
  readonly dialogue: SequenceGenerationDialogueView;
}
