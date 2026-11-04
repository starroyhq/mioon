import {z} from 'zod';
import {projectIdSchema, PROJECT_FILE_EXTENSION} from './project-file.ts';
import {isNormalizedAbsolutePath} from './media-reference.ts';
import {recentProjectSchema} from './project-registry.ts';
import type {OperationEffect} from './operation-effects.ts';

const id = z.string().uuid();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const date = z.string().datetime();
const absolutePath = z.string().min(1).max(4096).refine(isNormalizedAbsolutePath, 'Use a normalized absolute path.');
const selection = {projectId: projectIdSchema, backupId: id};

/** App-level operations. A backup is selected only by its registered owner
 * and opaque ID; callers cannot provide a source database path. */
export const projectBackupSchemas = {
  'project.backup.list': z.object({projectId: projectIdSchema}).strict(),
  'project.backup.inspect': z.object(selection).strict(),
  'project.backup.restore': z.object({...selection, requestId: id,
    projectFile: absolutePath.refine(value => value.endsWith(PROJECT_FILE_EXTENSION), 'Use a new .mioon file.')}).strict(),
  'project.backup.status': z.object({projectId: projectIdSchema}).strict(),
};
export type ProjectBackupOperation = keyof typeof projectBackupSchemas;
export const isProjectBackupOperation = (operation: string): operation is ProjectBackupOperation => Object.hasOwn(projectBackupSchemas, operation);
export type ProjectBackupListInput = z.infer<typeof projectBackupSchemas['project.backup.list']>;
export type ProjectBackupInspectInput = z.infer<typeof projectBackupSchemas['project.backup.inspect']>;
export type ProjectBackupRestoreInput = z.infer<typeof projectBackupSchemas['project.backup.restore']>;
export type ProjectBackupStatusInput = z.infer<typeof projectBackupSchemas['project.backup.status']>;

export const projectBackupSummarySchema = z.object({
  backupId: id, projectId: projectIdSchema, contentSequence: count, contentToken: z.string().regex(/^[a-f0-9]{32}$/u), createdAt: date,
  reason: z.enum(['open', 'close']), sizeBytes: count,
}).strict();
export type ProjectBackupSummary = z.infer<typeof projectBackupSummarySchema>;
export const projectBackupListResponseSchema = z.object({projectId: projectIdSchema, backups: z.array(projectBackupSummarySchema).max(3)}).strict();
export const projectBackupInspectionSchema = projectBackupSummarySchema.extend({
  projectName: z.string().max(150).nullable(), sourceProjectDir: absolutePath,
  tableCounts: z.record(z.string().min(1).max(128), count).refine(value => Object.keys(value).length <= 256),
}).strict();
export type ProjectBackupInspection = z.infer<typeof projectBackupInspectionSchema>;
export const projectBackupStatusSchema = z.object({
  projectId: projectIdSchema, state: z.enum(['idle', 'running', 'slow', 'failed']),
  lastAttemptAt: date.nullable(), lastCompletedAt: date.nullable(),
  lastError: z.object({code: z.string().min(1).max(100), message: z.string().min(1).max(1000)}).strict().nullable(),
}).strict();
export type ProjectBackupStatus = z.infer<typeof projectBackupStatusSchema>;
export const projectBackupRestoreResponseSchema = z.object({
  requestId: id, sourceProjectId: projectIdSchema, backupId: id, project: recentProjectSchema,
}).strict();
export type ProjectBackupRestoreResponse = z.infer<typeof projectBackupRestoreResponseSchema>;
export const projectBackupResponseSchemas = {
  'project.backup.list': projectBackupListResponseSchema,
  'project.backup.inspect': projectBackupInspectionSchema,
  'project.backup.restore': projectBackupRestoreResponseSchema,
  'project.backup.status': projectBackupStatusSchema,
};

export const projectBackupDescriptions = {
  'project.backup.list': '列出一个项目最近三份自动备份，不打开项目、不恢复任务。备份按项目 ID、内容序号和内容令牌去重。',
  'project.backup.inspect': '只读查看指定项目备份的内容摘要和表计数，不将备份登记或当作普通项目打开。',
  'project.backup.restore': '把指定备份恢复到明确的新 .mioon 文件，分配新项目 ID、新内容令牌和空本机记录；目标已存在就拒绝。保留原项目、备份和素材；稳定 requestId 精确重放。',
  'project.backup.status': '读取项目自动备份的 running/slow 状态、最后完成时间和失败原因，不打开项目或启动备份。',
};
const read: Readonly<OperationEffect> = Object.freeze({readOnly: true, idempotent: true, destructive: false, openWorld: false,
  databaseWrite: false, fileWrite: false, externalIO: false, localProcess: false, paidGeneration: false,
  notes: 'Reads local backup metadata without acquiring a project, modifying files, resuming tasks or calling providers.'});
export const projectBackupEffects: Readonly<Record<ProjectBackupOperation, Readonly<OperationEffect>>> = Object.freeze({
  'project.backup.list': read,
  'project.backup.inspect': Object.freeze({...read, notes: 'Reads only the selected private backup through its dedicated read-only SQLite opener; no project host or local records.'}),
  'project.backup.status': read,
  'project.backup.restore': Object.freeze({...read, readOnly: false, databaseWrite: true, fileWrite: true,
    notes: 'Copies a selected backup into a new project file with a new project ID and empty local records, registers it, and retains an exact request receipt. Never replaces existing files or resumes captured tasks; no provider or media process.'}),
});

/** Verifies response shape and binds every disclosed record to the request. */
export function isProjectBackupResponse(operation: ProjectBackupOperation, input: unknown, output: unknown): boolean {
  const request = projectBackupSchemas[operation].safeParse(input);
  const response = projectBackupResponseSchemas[operation].safeParse(output);
  if (!request.success || !response.success) return false;
  if (operation === 'project.backup.restore') {
    const wanted = request.data as ProjectBackupRestoreInput, actual = response.data as ProjectBackupRestoreResponse;
    return actual.sourceProjectId === wanted.projectId && actual.backupId === wanted.backupId && actual.requestId === wanted.requestId
      && actual.project.projectFile === wanted.projectFile && actual.project.projectId !== wanted.projectId;
  }
  const actual = response.data as {projectId: string; backupId?: string; backups?: ProjectBackupSummary[]};
  return actual.projectId === request.data.projectId
    && (operation !== 'project.backup.inspect' || actual.backupId === (request.data as ProjectBackupInspectInput).backupId)
    && (operation !== 'project.backup.list' || actual.backups!.every(backup => backup.projectId === request.data.projectId)
      && new Set(actual.backups!.map(backup => backup.backupId)).size === actual.backups!.length);
}
