import {AppError, publicValue, schemas} from '@mioon/contracts';
import {projectSummaryListSchema} from '../../../packages/contracts/src/project-home.ts';
import {isAppLevelOperation} from '../../../packages/contracts/src/project-addressing.ts';
import type {AppLibrary} from '@mioon/business/app-db/index';
import {createProjectServiceApplication} from '@mioon/business/project-service-application';
import {openProjectStore} from '@mioon/business/project-file/index';
import {projectLocation} from './project-host/directories.ts';
import type {AppDirectories} from './project-host/directories.ts';
import type {ProjectHostManager} from './project-host/manager.ts';
import type {HostedProject} from './project-host/runtime.ts';
import type {ApplicationRuntime} from './application-runtime.ts';
import {projectNotFound} from './project-host/errors.ts';
import type {createInitializedProject} from './project-host/create-project.ts';
import type {ProjectEntryCreateInput} from '../../../packages/contracts/src/project-entry-native.ts';
import {isProjectBackupOperation} from '../../../packages/contracts/src/project-backups.ts';
import {callProjectBackupOperation} from './project-backup-operations.ts';
import type {ProjectBackupOperations} from './project-backup-operations.ts';
import {isProjectCopyActionOperation, isProjectCopyOperation, projectCopyActionSchemas} from '../../../packages/contracts/src/project-copies.ts';
import type {ProjectCopies} from './project-host/copies.ts';
import type {ProjectTrashActions} from './project-host/trash.ts';
import type {ProjectDeleteInput} from '../../../packages/contracts/src/project-lifecycle.ts';

/** App operations never choose an arbitrary project's service as a global
 * facade. Settings and listings work with every project closed. */
export function createApplicationRpc({library, app, manager, directories, signal, providerList, imageProfiles, refreshSummaries, backups, copies, trash, createProject}: {
  library: AppLibrary; app: ApplicationRuntime; manager: ProjectHostManager<HostedProject>; directories: AppDirectories; signal: AbortSignal;
  providerList: () => unknown; imageProfiles: (input: unknown) => unknown;
  refreshSummaries: () => void;
  backups?: ProjectBackupOperations;
  copies?: ProjectCopies;
  trash?: ProjectTrashActions;
  createProject: ReturnType<typeof createInitializedProject>;
}) {
  const ports = createProjectServiceApplication(library, signal);
  const invalid = () => new AppError('VALIDATION_ERROR', '这个操作需要项目地址 /api/projects/<项目 ID>/rpc', 400);
  const unavailable = (operation: string): never => { throw new AppError(operation === 'project.delete' ? 'PROJECT_DELETE_UNAVAILABLE' : 'RESTORE_OPERATION_UNAVAILABLE', '此操作尚未接入项目文件布局，请等待对应的项目管理、打包或备份功能。', 409); };
  const summaries = () => projectSummaryListSchema.parse(library.registry.list().flatMap(entry => {
    if (!entry.summary) return [];
    const {cover, ...summary} = entry.summary;
    return [{id: entry.projectId, name: entry.name, ...summary, lastOpenedAt: entry.lastOpenedAt,
      cover: cover ? {...cover, url: `/api/project-covers/${entry.projectId}`} : null}];
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
  return {async call(operation: string, raw: unknown): Promise<unknown> {
    signal.throwIfAborted();
    if (operation === 'project.notes.set') throw new AppError('UNKNOWN_OPERATION', '未知操作', 404);
    if (isProjectCopyActionOperation(operation)) {
      if (!copies) throw new AppError('PROJECT_COPY_UNAVAILABLE', '项目复制暂不可用。', 503);
      const parsed = projectCopyActionSchemas[operation].safeParse(raw);
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', '项目复制参数无效', 400, {issues: parsed.error.issues});
      switch (operation) {
        case 'project.adopt-copy': return await copies.adoptCopy(parsed.data as Parameters<ProjectCopies['adoptCopy']>[0]);
        case 'project.copy-to': return await copies.copyTo(parsed.data as Parameters<ProjectCopies['copyTo']>[0]);
        case 'project.template.instantiate': return await copies.instantiateTemplate(parsed.data as Parameters<ProjectCopies['instantiateTemplate']>[0]);
      }
    }
    if (isProjectCopyOperation(operation)) {
      if (!copies) throw new AppError('PROJECT_COPY_UNAVAILABLE', '项目复制暂不可用。', 503);
      // Application-only contracts: CLI/MCP discovery deliberately does not
      // expose these until their 0.1.x project commands are implemented.
      const method = operation === 'project.duplicate' ? copies.duplicate : copies.saveAs;
      return await method(raw as Parameters<ProjectCopies['duplicate']>[0]);
    }
    if (isProjectBackupOperation(operation)) {
      if (!backups) throw new AppError('PROJECT_BACKUP_UNAVAILABLE', '项目备份服务尚未配置', 503);
      return await callProjectBackupOperation(backups, operation, raw);
    }
    const schema = (schemas as Record<string, {safeParse(value: unknown): {success: boolean; data?: unknown; error?: unknown}}>)[operation];
    if (!schema) throw new AppError('UNKNOWN_OPERATION', '未知操作', 404);
    if (!isAppLevelOperation(operation)) throw invalid();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '请求参数无效', 400, {issues: parsed.error});
    const input = parsed.data as Record<string, unknown>;
    switch (operation) {
      case 'project.summary.list': refreshSummaries(); return summaries();
      case 'project.list': return library.registry.list().map(entry => ({id: entry.projectId, name: entry.name,
        ...(entry.summary ? {description: entry.summary.description, revision: entry.summary.revision, createdAt: entry.summary.createdAt, updatedAt: entry.summary.updatedAt} : {})}));
      case 'project.create': {
        const created = await createProject({name: input.name as string,
          ...(input.description === undefined ? {} : {description: input.description as string}),
          ...(input.timelinePresetId === undefined ? {} : {timelinePresetId: input.timelinePresetId as NonNullable<ProjectEntryCreateInput['timelinePresetId']>})});
        const lease = await manager.acquire(created.registration.projectId, 'request');
        try {return publicValue(lease.host.store.get('projects', created.registration.projectId));}
        finally {lease.release();}
      }
      case 'project.rename': {
        const id = input.projectId as string;
        if (!library.registry.get(id)) throw projectNotFound(id);
        return await manager.withExclusive(id, async registration => {
          const store = openProjectStore({projectFile: registration.projectFile, locate: id => projectLocation(directories, id), checkCopy: library.registry.checkCopy});
          try {
            // Imported lazily so the app facade does not install legacy lifecycle DDL.
            const {mutateProjectRecord} = await import('../../../packages/business/src/project-record-mutations.ts');
            const updated = mutateProjectRecord(store, operation, input) as {name: string; revision: number; updatedAt: string};
            library.registry.upsert({...registration, name: updated.name,
              summary: registration.summary ? {...registration.summary, revision: updated.revision, updatedAt: updated.updatedAt} : null});
            return publicValue(updated);
          } finally { store.close(); }
        });
      }
      case 'project.delete': {
        if (!trash) throw new AppError('PROJECT_TRASH_UNAVAILABLE', '当前环境暂不支持将项目文件移到废纸篓。', 409);
        return await trash.trash(parsed.data as ProjectDeleteInput);
      }
      case 'agent.authorization.list': return app.authorizations.list(input);
      case 'agent.authorization.grant': return await app.authorizations.grant(input);
      case 'agent.authorization.revoke': return app.authorizations.revoke(input);
      case 'workspace.settings.get': return ports.configuration.get();
      case 'workspace.settings.set': {
        ports.assertMutationAllowed();
        return ports.configuration.set(input as Parameters<typeof ports.configuration.set>[0]);
      }
      case 'provider.list': return providerList();
      case 'image.profile.list': return imageProfiles(input);
      case 'video.connection.list': {
        const {listVideoConnections} = await import('../../../packages/business/src/video/generation.ts');
        return listVideoConnections(app.settings.video, new Date().toISOString().slice(0, 10));
      }
      default: return unavailable(operation);
    }
  }};
}
