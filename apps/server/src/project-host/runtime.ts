import {handleMioRulesHttp} from '../mio-rules-http.ts';
import {AppError, isTimelineRenderRecord} from '@mioon/contracts';
import path from 'node:path';
import {admitProjectAssetSource, registeredProjectAssetReferences, validatedProjectAssetSource, resolveProjectMediaFile} from '@mioon/business/project-media-storage';
import {createOwnedMediaGraphReader} from '@mioon/business/inspection';
import {readTimelineDeliveryDownload, readTimelineExportPreviewMedia, timelineDeliveryResponseHeaders, timelineExportPreviewResponseHeaders} from '@mioon/business/timeline-delivery-read';
import {readOwnedTimelineAsset} from '@mioon/business/timeline-sources';
import {boundedShutdown} from '@mioon/business/operation-lifecycle';
import type {AppLibrary} from '@mioon/business/app-db/index';
import {createProjectHomeServices,readProjectCover} from '@mioon/business/project-home';
import {createProjectServiceApplication} from '@mioon/business/project-service-application';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {ServerOptions} from '../index.ts';
import type {ApplicationRuntime} from '../application-runtime.ts';
import {body, field, json} from '../http-json.ts';
import {createFileResponses} from '../file-response.ts';
import {createVersionComparisonMediaHttp} from '../version-comparison-media.ts';
import {createProjectDeletionGate} from '../project-deletion-gate.ts';
import {composeProjectRuntime, ProjectRuntimeCleanupError} from '../project-runtime.ts';
import {bindAgentTaskRowValidation} from '@mioon/business/agent/task-project-row-validation-v2';
import {callObservedRpc} from '../rpc-observation.ts';
import {projectHandlerTarget, assertProjectRpc} from './request.ts';
import type {ProjectHostContext, ProjectHostRuntime, ProjectRequest, UnfinishedTask} from './host.ts';
import {ensureProjectRow} from './project-initialization.ts';
import {readWorkspaceInfo} from '../workspace-info.ts';
import {mediaExecutable} from '@mioon/business/media-environment';
import packageMetadata from '../../../../package.json' with {type: 'json'};
import {registerProjectTransactionObserver} from '@mioon/business/project-file/index';
import {createAssetMediaHttp} from '../asset-media-http.ts';
import {sameManagedFile} from '@mioon/business/managed-media';
import {mediaUnavailableError} from '@mioon/contracts/media-reference-errors';
import {createProjectCoverPublisher} from './cover-publisher.ts';

export interface HostedProject extends ProjectHostRuntime {
  readonly project: Awaited<ReturnType<typeof composeProjectRuntime>>;
}

/** Production assembly over the exact kernel connection owned by the manager. */
export async function composeHostedProject(context: ProjectHostContext, library: AppLibrary, app: ApplicationRuntime, options: ServerOptions,
  selfPort: () => number | undefined, listeningPort: () => number): Promise<HostedProject> {
  const {store, projectId} = context, root = store.projectDir;
  ensureProjectRow(store, {name: library.registry.get(projectId)!.name});
  const releaseRowValidation = bindAgentTaskRowValidation(store, library);
  const shutdown = new AbortController();
  const abort = () => shutdown.abort();
  context.signal.addEventListener('abort', abort, {once: true});
  if (context.signal.aborted) abort();
  const deletionGate = createProjectDeletionGate({subscribeMedia: () => () => {}, signal: shutdown.signal,
    busy: () => { throw new AppError('PROJECT_HOST_BUSY', '项目仍有操作在执行。', 409); }});
  const files = createFileResponses({signal: shutdown.signal});
  const comparisons = createVersionComparisonMediaHttp({db: store.db, root, signal: shutdown.signal,
    readGraph: id => createOwnedMediaGraphReader(store.db, id), resolvePath: async (_root, relative) => resolveProjectMediaFile(store, relative).file, createFiles: createFileResponses,
    validateFile: file => resolveProjectMediaFile(store, path.relative(root, file)).info!, assertAvailable: () => { if (!store.db.isOpen) throw new AppError('FILE_UNAVAILABLE', '本地文件不可用。', 404); }});
  let project: HostedProject['project'];
  try {
    project = await composeProjectRuntime({...options, store, shutdown, deletionGate, port: options.port ?? 4318, serverPort: selfPort, listeningPort,
      baseRoot: library.dataDir, application: library, serviceApplication: createProjectServiceApplication(library, shutdown.signal),
      agentSettings: app.agentSettings, settings: app.settings});
  } catch (error) {
    shutdown.abort();
    await Promise.all([files.close(), comparisons.close()]);
    deletionGate.close();
    context.signal.removeEventListener('abort', abort);
    if (!(error instanceof ProjectRuntimeCleanupError)) releaseRowValidation();
    throw error;
  }
  const worker = project.startWorker();
  const summary = () => {
    const value = createProjectHomeServices(store, {readRecentOpened: () => {
      const openedAt = library.registry.get(projectId)?.lastOpenedAt;
      return openedAt ? {[projectId]: openedAt} : {};
    }}).handlers['project.summary.list']()[0];
    if (!value) return null;
    const {id: _id, name, lastOpenedAt: _opened, cover, ...rest} = value;
    return {name, summary: {...rest, cover: cover ? {assetId: cover.assetId, mimeType: cover.mimeType} : null}};
  };
  const assetMediaHttp = createAssetMediaHttp({store, outsidePaths: library.outsidePaths, signal: shutdown.signal, assertMutationAllowed: () => project.services.assertMutationAllowed()});
  const cover = createProjectCoverPublisher({store, readCover:()=>readProjectCover(store,projectId), signal: shutdown.signal});
  const removeCoverObserver = registerProjectTransactionObserver(store.db, () => cover.refresh());
  cover.refresh();
  const unfinishedTasks = (): readonly UnfinishedTask[] => {
    const tables = [['jobs', 'job', "json_extract(data,'$.status')"], ['exports', 'export', "json_extract(data,'$.status')"], ['edit_tasks', 'edit_task', 'status'], ['image_tasks', 'image_task', 'state'], ['frame_tasks', 'frame_task', 'state'], ['scene_tasks', 'scene_task', 'state'], ['subject_variant_batches', 'subject_variant_batch', 'state']] as const;
    const result: UnfinishedTask[] = [];
    for (const [table, kind, status] of tables) {
      // Fixed kernel tables, never supplied by HTTP or inferred from filenames.
      for (const row of store.db.prepare(`SELECT id,${status} AS status FROM ${table}`).all()) {
        if (['queued', 'running', 'pending', 'prepared', 'dispatching', 'receiving', 'persisting', 'polling', 'submitting', 'downloading', 'cancelling', 'recovering', 'uncertain', 'accepted'].includes(String(row.status))) result.push({kind, taskId: String(row.id)});
      }
    }
    return result;
  };
  async function handle({req, res, url, route, signal}: ProjectRequest): Promise<boolean> {
    if (await assetMediaHttp.handle(req, res, url, route)) return true;
    if (route.kind === 'other' && route.segments.join('/') === 'workspace-info' && req.method === 'GET') {
      json(res, 200, {ok: true, data: await readWorkspaceInfo({root, channel: options.localDraftChannel ?? 'web', version: packageMetadata.version,
        tools: {ffmpeg: mediaExecutable('ffmpeg'), ffprobe: mediaExecutable('ffprobe')}, signal})}); return true;
    }
    if(project.projectRules && route.kind==='other' && route.segments[0]==='rules'){
      deletionGate.track(res);
      return handleMioRulesHttp({req,res,url,projectId,rules:project.projectRules,signal});
    }
    const target = projectHandlerTarget(route);
    if (!target) return false;
    const local = new URL(url);
    local.pathname = target.pathname;
    req.url = local.pathname + local.search;
    const address = {projectId};
    deletionGate.track(res);
    // The dispatcher owns response completion, revocation and lease release.
    if (signal.aborted) { res.destroy(); return true; }
    if (local.pathname === '/api/version-comparison/media' && await comparisons.handle(req, res, local)) return true;
    for (const handler of [project.imageHttp, (request: IncomingMessage, response: ServerResponse, target: URL) => project.taskHttpV2!.handle(request, response, target, address),
      project.editTasksHttp, project.localDraftHttp, project.localDeliveryHttp, project.localShotTextHttp,
      project.exportFileRecovery.handle, project.continuousAudioHttp, project.audioPreviewHttp]) {
      if (await handler(req, res, local, address)) return true;
    }
    if (local.pathname === '/api/rpc' && req.method === 'POST') {
      const input = await body(req) as Record<string, unknown>;
      if (!input || typeof input.operation !== 'string') throw new AppError('VALIDATION_ERROR', '缺少 operation', 400);
      assertProjectRpc(store.db, address, input.operation, input.input || {});
      deletionGate.rpc(res, input.operation, input.input);
      const data = await callObservedRpc(req, res, {call: project.serviceCall}, input.operation, input.input || {});
      if (!res.destroyed && !res.writableEnded) json(res, 200, {ok: true, data});
      return true;
    }
    if (route.kind === 'media' && ['GET', 'HEAD'].includes(req.method ?? '')) {
      const preview = local.searchParams.has('preview'), named = local.searchParams.has('exportId');
      const guards = {isTimelineRenderRecord, readOwnedAsset: (id: string, assetId: string) => readOwnedTimelineAsset(store.db, id, assetId)};
      const playback = preview ? readTimelineExportPreviewMedia(store.db, local, guards) : null;
      const delivery = named && !preview ? readTimelineDeliveryDownload(store.db, local, guards) : null;
      const asset = preview ? playback : named ? delivery : store.get('assets', route.assetId);
      if (!asset || field(asset, 'projectId') !== projectId) throw new AppError('NOT_FOUND', '素材不存在', 404);
      const mimeType = field(asset, 'mimeType'), assetId = route.assetId;
      if (typeof mimeType !== 'string') throw new AppError('NOT_FOUND', '素材不存在', 404);
      const owned = store.get('assets', assetId);
      if (!owned || typeof owned !== 'object') throw new AppError('NOT_FOUND', '素材不存在', 404);
      const references = registeredProjectAssetReferences(root);
      if (!references) throw new TypeError('The project media capability is unavailable');
      const source = await admitProjectAssetSource(root, assetId, {signal});
      const fence = (): void => {
        signal.throwIfAborted();
        const current = validatedProjectAssetSource(root, owned);
        if (current.file !== source.file || !sameManagedFile(current.info, source.info)) throw mediaUnavailableError('MEDIA_CHANGED_DURING_READ', assetId);
      };
      const headers: Record<string, string> = {'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store'};
      if (!delivery && local.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="mioon.${mimeType === 'video/mp4' ? 'mp4' : 'bin'}"`;
      await files.send(req, res, {file: source.file, headers: playback ? () => timelineExportPreviewResponseHeaders(store.db, local, guards, playback) : delivery ? () => timelineDeliveryResponseHeaders(store.db, local, guards, delivery) : headers,
        ranges: true, beforeEffect: fence, verifyMetadata: metadata => {if (!sameManagedFile(metadata, source.info)) throw mediaUnavailableError('MEDIA_CHANGED_DURING_READ', assetId);}});
      return true;
    }
    return false;
  }
  return {project, handle, summarize: summary, unfinishedTasks,
    isBusy: () => files.isBusy() || cover.isRendering() || worker.isBusy() || project.taskRuntimeV2!.isBusy() || project.services.isBusy() || Boolean(project.projectRules?.isBusy()) || !deletionGate.isQuiescent(),
    interrupt: () => { shutdown.abort(); project.projectRules?.close(); project.taskRuntimeV2?.close(); project.taskHttpV2?.close(); },
    drain: async () => { await boundedShutdown(Promise.all([worker.stop(), project.taskRuntimeV2?.drain(), project.projectRules?.drain(), project.serviceDrain(), project.editTasks.drain(), cover.drain(), files.close(), comparisons.close(), project.closeSettings()]), 'SERVER_STOP_TIMEOUT'); },
    dispose: () => { project.projectRules?.close(); removeCoverObserver(); project.taskToolsV2?.dispose(); deletionGate.close(); releaseRowValidation(); context.signal.removeEventListener('abort', abort); },
  };
}
