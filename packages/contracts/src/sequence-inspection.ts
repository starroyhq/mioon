/** Bounded, paginated format-5 sequence inspection shared by Mio/MT and UI.
 * A page is bound to one frozen snapshot id; continuing with a cursor from a
 * different snapshot is rejected so the model never stitches mismatched reads. */
import {z} from 'zod';

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
