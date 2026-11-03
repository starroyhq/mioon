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
import {ensureProjectRow} from './project-host/project-initialization.ts';
import {rmSync, rmdirSync} from 'node:fs';
import path from 'node:path';
import {isProjectBackupOperation} from '../../../packages/contracts/src/project-backups.ts';
import {callProjectBackupOperation} from './project-backup-operations.ts';
import type {ProjectBackupOperations} from './project-backup-operations.ts';

/** App operations never choose an arbitrary project's service as a global
 * facade. Settings and listings work with every project closed. */
export function createApplicationRpc({library, app, manager, directories, signal, providerList, imageProfiles, refreshSummaries, backups}: {
  library: AppLibrary; app: ApplicationRuntime; manager: ProjectHostManager<HostedProject>; directories: AppDirectories; signal: AbortSignal;
  providerList: () => unknown; imageProfiles: (input: unknown) => unknown;
  refreshSummaries: () => void;
  backups?: ProjectBackupOperations;
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
        const entry = await manager.create({name: input.name as string});
        let initialized = false;
        try {
          const store = openProjectStore({projectFile: entry.projectFile, locate: id => projectLocation(directories, id), checkCopy: library.registry.checkCopy});
          try { ensureProjectRow(store, {name: input.name as string, description: input.description as string | undefined,
            ...(input.timelinePresetId === undefined ? {} : {timelinePresetId: input.timelinePresetId as string})}); initialized = true; }
          finally { store.close(); }
          const lease = await manager.acquire(entry.projectId, 'request');
          try { return publicValue(lease.host.store.get('projects', entry.projectId)); } finally { lease.release(); }
        } catch (error) {
          if (!initialized) {
            library.registry.remove(entry.projectId);
            rmSync(entry.projectFile, {force: true});
            try { rmdirSync(path.dirname(entry.projectFile)); } catch { /* Only an empty folder made by this create may be removed. */ }
          }
          throw error;
        }
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
      case 'project.delete': return unavailable(operation);
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
