import {z} from 'zod';
import {AGENT_TASK_DISPLAY_PROPERTIES, AGENT_TASK_DISPLAY_TARGET_KINDS} from './agent-tasks-v2.ts';
import {projectIdSchema} from './project-file.ts';
import {isNormalizedAbsolutePath} from './media-reference.ts';
/** Versions, restore and packing (project file v1, docs/PROJECT-FILE.md).
 * Version snapshots stay in this computer's records; a project file sent to
 * someone else carries none of them. */

const id = z.string().uuid(), date = z.string().datetime();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const absolutePath = z.string().min(1).max(4096).refine(isNormalizedAbsolutePath, 'Use a normalized absolute path.');

/** manual: "save as version", optionally named. mio-turn: before Mio first
 * changes the project in a turn. bulk-change: before a large change such as a
 * batch delete. restore: before restoring another version. daily-open: on the
 * first open of each day. */
export const PROJECT_VERSION_TRIGGERS = Object.freeze(['manual', 'mio-turn', 'bulk-change', 'restore', 'daily-open'] as const);
export type ProjectVersionTrigger = typeof PROJECT_VERSION_TRIGGERS[number];
export const projectVersionSummarySchema = z.object({
  id, projectId: projectIdSchema, trigger: z.enum(PROJECT_VERSION_TRIGGERS),
  /** Only a manual version can carry a name. */
  name: z.string().min(1).max(150).nullable(),
  /** The Mio run a mio-turn version was saved before. */
  mioRunId: id.nullable(),
  /** The project file's content sequence when the snapshot was taken. */
  contentSequence: count,
  createdAt: date,
}).strict().refine(value => (value.trigger === 'manual' || value.name === null) && (value.trigger === 'mio-turn') === (value.mioRunId !== null),
  'Only manual versions are named; exactly the mio-turn versions name a Mio run.');
export type ProjectVersionSummary = z.infer<typeof projectVersionSummarySchema>;

const displayValue = z.union([z.number().finite(), z.string().max(240), z.boolean(), z.null()]);
/** An object changed by hand after the version; restoring takes it back too.
 * Kinds and properties are the ones Mio's change cards display. */
export const projectRestoreChangeSchema = z.object({
  kind: z.enum(AGENT_TASK_DISPLAY_TARGET_KINDS), id: z.string().min(1).max(200), name: z.string().min(1).max(80).nullable(),
  fields: z.array(z.object({property: z.enum(AGENT_TASK_DISPLAY_PROPERTIES), before: displayValue.optional(), after: displayValue.optional()}).strict()).max(32),
}).strict();
export type ProjectRestoreChange = z.infer<typeof projectRestoreChangeSchema>;
/** Shown before a restore. The current content is saved as a version first,
 * so the restore itself can be taken back. */
export const projectRestorePreviewSchema = z.object({
  version: projectVersionSummarySchema,
  manualChanges: z.array(projectRestoreChangeSchema).max(200),
  /** All manual changes, when the list above is cut short. */
  manualChangeCount: count,
  /** Mio changes after this version; they become superseded and can no longer be undone one by one. */
  supersededMioChanges: count,
}).strict().refine(value => value.manualChangeCount >= value.manualChanges.length, 'The total cannot be below the listed changes.');
export type ProjectRestorePreview = z.infer<typeof projectRestorePreviewSchema>;

/** Packing copies the project file, AGENTS.md and every used media file into
 * a new folder and rewrites the paths relative to it. */
export const projectPackResultSchema = z.object({
  directory: absolutePath,
  projectFile: absolutePath,
  rulesFileCopied: z.boolean(),
  copiedAssets: count,
  copiedBytes: count,
  /** Referenced files that were not found; the packed project shows them as missing. */
  missingAssetIds: z.array(id).max(20_000),
}).strict();
export type ProjectPackResult = z.infer<typeof projectPackResultSchema>;
