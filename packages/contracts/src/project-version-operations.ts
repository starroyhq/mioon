import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';
import {projectVersionSummarySchema} from './project-versions.ts';
import type {OperationEffect} from './operation-effects.ts';

const id = z.string().uuid();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().min(1).max(4096);
const page = {limit: z.number().int().min(1).max(100).optional(), cursor: cursor.optional()};
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const contentToken = z.string().regex(/^[a-f0-9]{32}$/u);
/** Closed project content inventory; metadata and revision ledgers are not
 * restore targets. The snapshot inventory test checks this independently. */
export const PROJECT_VERSION_CONTENT_TABLES = Object.freeze([
  'projects', 'assets', 'asset_annotations', 'asset_dispositions', 'asset_ranges', 'shots', 'nodes', 'edges', 'versions',
  'timelines', 'subjects', 'subject_versions', 'subject_bindings', 'image_groups', 'image_versions', 'scene_results', 'project_lut_resources',
] as const);

/** These are project-level operations. Automatic capture stays internal; callers
 * cannot supply an automatic trigger, a Mio run or a snapshot document. */
export const projectVersionSchemas = {
  'project.version.list': z.object({projectId: projectIdSchema, ...page}).strict(),
  'project.version.save': z.object({projectId: projectIdSchema, requestId: id, name: z.string().min(1).max(150).optional()}).strict(),
  'project.version.preview': z.object({projectId: projectIdSchema, versionId: id, ...page}).strict(),
  'project.version.restore': z.object({projectId: projectIdSchema, versionId: id, requestId: id,
    expectedContentSequence: count, expectedContentToken: contentToken, previewDigest: digest}).strict(),
};
export type ProjectVersionOperation = keyof typeof projectVersionSchemas;
export const isProjectVersionOperation = (operation: string): operation is ProjectVersionOperation => Object.hasOwn(projectVersionSchemas, operation);
export type ProjectVersionListInput = z.infer<typeof projectVersionSchemas['project.version.list']>;
export type ProjectVersionSaveInput = z.infer<typeof projectVersionSchemas['project.version.save']>;
export type ProjectVersionPreviewInput = z.infer<typeof projectVersionSchemas['project.version.preview']>;
export type ProjectVersionRestoreInput = z.infer<typeof projectVersionSchemas['project.version.restore']>;

export const projectVersionListResponseSchema = z.object({
  projectId: projectIdSchema, versions: z.array(projectVersionSummarySchema).max(100), nextCursor: cursor.nullable(),
}).strict().refine(value => value.nextCursor === null || value.versions.length > 0, 'A continuation requires a nonempty page.');
export const projectVersionSaveResponseSchema = z.object({
  projectId: projectIdSchema, requestId: id, version: projectVersionSummarySchema,
}).strict();
export const PROJECT_VERSION_DIFFERENCE_REASON_CODES = Object.freeze([
  'PROJECT_VERSION_ASSET_LOCATION_CURRENT', 'PROJECT_VERSION_IMAGE_GROUP_FORWARD_ONLY',
  'PROJECT_VERSION_SUBJECT_VARIANT_HEAD', 'PROJECT_VERSION_IMAGE_GROUP_TASK_NOT_REPLAYED',
  'PROJECT_VERSION_PROTECTED_RESULT_CURRENT', 'PROJECT_VERSION_TIMELINE_HISTORY_CURRENT',
  'PROJECT_VERSION_ANNOTATION_IDENTITY_CURRENT', 'PROJECT_VERSION_BINDING_TOMBSTONE_CURRENT',
  'PROJECT_VERSION_PROCESS_REFERENCE_CURRENT', 'PROJECT_VERSION_FOREIGN_KEY_REFERENCE_CURRENT',
  'PROJECT_VERSION_CONTENT_REFERENCE_CURRENT',
] as const);
export type ProjectVersionDifferenceReasonCode = typeof PROJECT_VERSION_DIFFERENCE_REASON_CODES[number];
/** Optional for historical receipts. Bounded future codes remain readable so
 * clients can show a generic localized reason and the unrecognized code. */
export const projectVersionDifferenceReasonCodeSchema = z.string().regex(/^PROJECT_VERSION_[A-Z][A-Z0-9_]{0,95}$/u);
/** A bounded row identity and changed-field list, never raw SQL, private
 * process history or embedded resource/media bytes. `source` follows Mio's
 * recorded targets; the other label deliberately includes unknown origins. */
export const projectVersionDifferenceSchema = z.object({
  table: z.enum(PROJECT_VERSION_CONTENT_TABLES), key: z.string().min(1).max(4096),
  action: z.enum(['add', 'remove', 'change', 'keep-current']),
  source: z.enum(['mio', 'user-or-other']), fields: z.array(z.string().min(1).max(200)).max(128),
  reason: z.string().min(1).max(1000).nullable(),
  reasonCode: projectVersionDifferenceReasonCodeSchema.optional(),
}).strict().refine(value => value.action !== 'keep-current' || value.reason !== null, 'A retained current row requires a reason.');
export type ProjectVersionDifference = z.infer<typeof projectVersionDifferenceSchema>;
export const projectVersionPreviewResponseSchema = z.object({
  projectId: projectIdSchema, version: projectVersionSummarySchema, contentSequence: count, contentToken, previewDigest: digest,
  totalChanges: count, keptCurrentCount: count,
  changes: z.array(projectVersionDifferenceSchema).max(100), nextCursor: cursor.nullable(),
  restoreAvailable: z.boolean(),
}).strict().refine(value => value.totalChanges >= value.changes.length && value.keptCurrentCount <= value.totalChanges
  && (value.nextCursor === null || value.changes.length > 0),
  'Preview totals must cover the page and retained-current subset.');
export type ProjectVersionListResponse = z.infer<typeof projectVersionListResponseSchema>;
export type ProjectVersionSaveResponse = z.infer<typeof projectVersionSaveResponseSchema>;
export type ProjectVersionPreviewResponse = z.infer<typeof projectVersionPreviewResponseSchema>;
export const projectVersionRestoreResponseSchema = z.object({
  projectId: projectIdSchema, requestId: id, versionId: id, beforeVersionId: id,
  contentSequence: count, contentToken, totalChanges: count,
  appliedChanges: z.array(projectVersionDifferenceSchema),
  keptCurrent: z.array(projectVersionDifferenceSchema),
}).strict().refine(value => value.totalChanges === value.appliedChanges.length + value.keptCurrent.length
  && value.appliedChanges.every(change => change.action !== 'keep-current')
  && value.keptCurrent.every(change => change.action === 'keep-current')
  && new Set([...value.appliedChanges, ...value.keptCurrent].map(change => `${change.table}:${change.key}`)).size === value.totalChanges,
  'A restore receipt contains the complete, disjoint applied and retained plan.');
export type ProjectVersionRestoreResponse = z.infer<typeof projectVersionRestoreResponseSchema>;
export const projectVersionResponseSchemas = {
  'project.version.list': projectVersionListResponseSchema,
  'project.version.save': projectVersionSaveResponseSchema,
  'project.version.preview': projectVersionPreviewResponseSchema,
  'project.version.restore': projectVersionRestoreResponseSchema,
};

export const projectVersionDescriptions = {
  'project.version.list': '分页列出本机保存的项目版本，不读取媒体、不恢复内容或任务。',
  'project.version.save': '以稳定 requestId 手动保存当前项目完整内容快照，可选名称；只写本机记录，不改变项目内容。重复输入返回原始回执。',
  'project.version.preview': '只读预览当前内容与所选版本的完整差异计数和分页，列明 Mio 或你/其他来源、保持当前及原因；摘要绑定整份差异和恢复确认。',
  'project.version.restore': '按完整预览摘要和当前内容序号及令牌恢复所选项目版本，先保存恢复前版本；保持当前项属于成功回执，稳定请求重放原结果，不重发任务或媒体效果。',
};
const read: Readonly<OperationEffect> = Object.freeze({readOnly: true, idempotent: true, destructive: false, openWorld: false,
  databaseWrite: false, fileWrite: false, externalIO: false, localProcess: false, paidGeneration: false,
  notes: 'Reads local version records and project content without changing rows or reading external media.'});
export const projectVersionEffects: Readonly<Record<ProjectVersionOperation, Readonly<OperationEffect>>> = Object.freeze({
  'project.version.list': read,
  'project.version.preview': read,
  'project.version.save': Object.freeze({...read, readOnly: false, databaseWrite: true,
    notes: 'Saves an immutable local content snapshot and exact request receipt; no content mutation, provider, media process or task replay.'}),
  'project.version.restore': Object.freeze({...read, readOnly: false, databaseWrite: true, destructive: true,
    notes: 'Restores confirmed project content in one transaction with a before-version and exact receipt, while retaining protected results and current media locations; never replays providers or source media effects.'}),
});

/** Strict response validation includes request identity, cross-project
 * disclosure checks and page bounds, not just the shape of one record. */
export function isProjectVersionResponse(operation: ProjectVersionOperation, input: unknown, output: unknown): boolean {
  const request = projectVersionSchemas[operation].safeParse(input);
  const response = projectVersionResponseSchemas[operation].safeParse(output);
  if (!request.success || !response.success || request.data.projectId !== response.data.projectId) return false;
  if (operation === 'project.version.list') {
    const wanted = request.data as ProjectVersionListInput, actual = response.data as ProjectVersionListResponse;
    return actual.versions.length <= (wanted.limit ?? 100) && actual.versions.every(version => version.projectId === wanted.projectId)
      && new Set(actual.versions.map(version => version.id)).size === actual.versions.length;
  }
  if (operation === 'project.version.save') {
    const wanted = request.data as ProjectVersionSaveInput, actual = response.data as ProjectVersionSaveResponse;
    return actual.requestId === wanted.requestId && actual.version.projectId === wanted.projectId
      && actual.version.trigger === 'manual' && actual.version.name === (wanted.name ?? null);
  }
  if (operation === 'project.version.restore') {
    const wanted = request.data as ProjectVersionRestoreInput, actual = response.data as ProjectVersionRestoreResponse;
    return actual.requestId === wanted.requestId && actual.versionId === wanted.versionId
      && actual.beforeVersionId !== wanted.versionId && actual.contentSequence >= wanted.expectedContentSequence
      && (actual.contentSequence === wanted.expectedContentSequence ? actual.contentToken === wanted.expectedContentToken : actual.contentToken !== wanted.expectedContentToken);
  }
  const wanted = request.data as ProjectVersionPreviewInput, actual = response.data as ProjectVersionPreviewResponse;
  return actual.version.projectId === wanted.projectId && actual.version.id === wanted.versionId
    && actual.changes.length <= (wanted.limit ?? 100)
    && new Set(actual.changes.map(change => `${change.table}:${change.key}`)).size === actual.changes.length;
}
