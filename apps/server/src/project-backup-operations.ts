import {AppError} from '../../../packages/contracts/src/app-error.ts';
import {isProjectBackupOperation, isProjectBackupResponse, projectBackupSchemas} from '../../../packages/contracts/src/project-backups.ts';
import type {
  ProjectBackupListInput, ProjectBackupInspectInput, ProjectBackupRestoreInput, ProjectBackupStatusInput,
  ProjectBackupSummary, ProjectBackupInspection, ProjectBackupRestoreResponse, ProjectBackupStatus,
} from '../../../packages/contracts/src/project-backups.ts';

/** App services never acquire a project for backup inspection or recovery. */
export interface ProjectBackupOperations {
  list(input: ProjectBackupListInput): {projectId: string; backups: readonly ProjectBackupSummary[]} | Promise<{projectId: string; backups: readonly ProjectBackupSummary[]}>;
  inspect(input: ProjectBackupInspectInput): ProjectBackupInspection | Promise<ProjectBackupInspection>;
  restore(input: ProjectBackupRestoreInput): Promise<ProjectBackupRestoreResponse>;
  status(input: ProjectBackupStatusInput): ProjectBackupStatus | Promise<ProjectBackupStatus>;
}

export async function callProjectBackupOperation(backups: ProjectBackupOperations, operation: string, raw: unknown): Promise<unknown> {
  if (!isProjectBackupOperation(operation)) throw new AppError('UNKNOWN_OPERATION', '未知操作', 404);
  const parsed = projectBackupSchemas[operation].safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', '请求参数无效', 400, {issues: parsed.error.issues});
  let result: unknown;
  switch (operation) {
    case 'project.backup.list': result = await backups.list(parsed.data); break;
    case 'project.backup.inspect': result = await backups.inspect(parsed.data as ProjectBackupInspectInput); break;
    case 'project.backup.restore': result = await backups.restore(parsed.data as ProjectBackupRestoreInput); break;
    case 'project.backup.status': result = await backups.status(parsed.data); break;
  }
  if (!isProjectBackupResponse(operation, parsed.data, result)) throw new AppError('INTERNAL_ERROR', '项目备份服务返回无效数据', 500);
  return result;
}
