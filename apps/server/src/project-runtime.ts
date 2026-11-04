import {validateProjectRetainedRows} from '@mioon/business/project-retained-validation';
import {createMioProjectRules} from '@mioon/business/agent/mio-rules';
import { createProviderRegistry,createServices,createWorkspacePreferences,startWorker } from '@mioon/business';
import { createAgentAuthorizations } from '@mioon/business/agent/authorizations';
import type { AgentSettingsService } from '@mioon/business/agent/settings';
import { createAgentSettings,sanitizeAgentSettingsResult } from '@mioon/business/agent/settings';
import { createAgentSettingsFile } from '@mioon/business/agent/settings-file';
import { createAgentTaskRuntime } from '@mioon/business/agent/task-runtime-v2';
import { readMioStorage } from '@mioon/business/agent/mio-storage';
import { createAgentTaskTools } from '@mioon/business/agent/task-tools-v2';
import { createMioProjectMedia } from '@mioon/business/agent/mio-project-media';
import type { AppLibrary } from '@mioon/business/app-db/index';
import { isAppLibraryHeld, projectFileIdentity } from '@mioon/business/app-db/index';
import { createComfyConnector } from '@mioon/business/comfy/connector';
import { createComfySettings } from '@mioon/business/comfy/settings';
import { createAppCompanionDocuments } from '@mioon/business/companion-scope';
import {resolveProjectMediaFile} from '@mioon/business/project-media-storage';
import type { Store as Store } from '@mioon/business/store-contract';
import { ownsStoreLock, assertProjectStore } from '@mioon/business/store-runtime';
import { createEditTasks } from '@mioon/business/edit-tasks';
import { createCompatibleImageGateway,createLiveImageGateway } from '@mioon/business/images/gateway';
import { createCustomImageSettings,createImageSettings } from '@mioon/business/images/settings';
import { createCustomImageSettingsFile,createImageSettingsFile } from '@mioon/business/images/settings-file';
import { createLastProject,readLastProjectTarget } from '@mioon/business/last-project';
import { boundedShutdown } from '@mioon/business/operation-lifecycle';
import { isProjectStore } from '@mioon/business/project-file/index';
import { createProjectPackageService } from '@mioon/business/project-package/service';
import type { ServiceApplicationPorts } from '@mioon/business/services';
import { readOwnedTimelineAsset } from '@mioon/business/timeline-sources';
import { createUiPreferences } from '@mioon/business/ui-preferences';
import { createVideoSettings } from '@mioon/business/video/settings';
import { createWorkspaceConfiguration } from '@mioon/business/workspace-configuration';
import { AppError,isTimelineRenderRecord } from '@mioon/contracts';
import { readPrivateFile,validateManagedDirectory,validateManagedFile,validatePrivateDirectory,writePrivateFileAtomic } from '@mioon/contracts/private-storage';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage,ServerResponse } from 'node:http';
import path from 'node:path';
import packageMetadata from '../../../package.json' with { type: 'json' };
import { deriveAgentEndpoint } from '../../../packages/contracts/src/agent-protocol.ts';
import {agentDiagnosticSummarySchema} from '../../../packages/contracts/src/agent-diagnostic-summary.ts';
import { createAgentDiagnosticsHttp } from './agent-diagnostics-http.ts';
import { createAgentTaskHttp } from './agent-task-http-v2.ts';
import { createComfyHttp } from './comfy-http.ts';
import { composeOfficialComfyModule } from './comfy-module.ts';
import { createEditTasksHttp } from './edit-tasks-http.ts';
import { createExportFileRecovery } from './export-file-recovery.ts';
import { createImageHttp } from './image-http.ts';
import type { ServerOptions } from './index.ts';
import { createLastProjectHttp } from './last-project-http.ts';
import type { createProjectDeletionGate } from './project-deletion-gate.ts';
import { createProjectPackageHttp } from './project-package-http.ts';
import type { ProjectAddress } from './project-host/request.ts';
import {ProjectHostCleanupError} from './project-host/host.ts';
import {createProjectDraftsFactory} from './project-host/drafts.ts';
import { createTimelineAudioContinuousHttp } from './timeline-audio-continuous-http.ts';
import { createTimelineAudioPreviewHttp } from './timeline-audio-preview-http.ts';
import { createVideoHttp } from './video-http.ts';

type HttpHandler = (req: IncomingMessage, res: ServerResponse, url: URL, address?: ProjectAddress) => Promise<boolean>;
type Services = ReturnType<typeof createServices>;
type ServiceCall = (operation: string, input: unknown, context?: Record<string, unknown>) => Promise<unknown>;
type ImageSettings = Awaited<ReturnType<typeof createImageSettings>>;
type CustomImageSettings = Awaited<ReturnType<typeof createCustomImageSettings>>;
type VideoSettings = Awaited<ReturnType<typeof createVideoSettings>>;
type ComfySettings = Awaited<ReturnType<typeof createComfySettings>>;
type LastProject = ReturnType<typeof createLastProject>;
type WorkspacePreferences = ReturnType<typeof createWorkspacePreferences>;
type ExportFileRecovery = ReturnType<typeof createExportFileRecovery>;

/** Trusted application-owned ports, never HTTP or environment configuration.
 * The app library remains on its own connection; it is not attached here. */
export type ProjectApplication = Pick<AppLibrary, 'dataDir' | 'databaseFile' | 'documents' | 'agentPolicy' | 'db' | 'tx' | 'registry' | 'rulesTrust' | 'userRules' | 'receipts'>;
/** Startup failed before a runtime could be returned, and its private work
 * could not be confirmed settled. The store owner must retain SQLite/locks,
 * just as it does after boundedShutdown rejects during a normal close. */
export class ProjectRuntimeCleanupError extends ProjectHostCleanupError {
  constructor(startupError: unknown, cleanupError: unknown) {
    super([startupError, cleanupError], 'Project startup and cleanup could not finish safely', {cause: startupError});
  }
}
// Begin cancellation synchronously, before another queued continuation can
// publish. Still collect synchronous failures so every closer is attempted.
const invokeCleanup = (close: () => unknown): Promise<unknown> => {
  try { return Promise.resolve(close()); } catch (error) { return Promise.reject(error); }
};
export interface ProjectRuntimeOptions extends Pick<ServerOptions,
  'agentSettings' | 'agentSecretCodecFactory' | 'imageSecretCodec' | 'videoSecretCodec' | 'imageNetwork' | 'comfyNetwork' |
  'comfyModule' | 'taskGatewayV2' | 'taskFault' | 'localDraftChannel' | 'nativeAudioPreview'> {
  readonly store: Store;
  readonly shutdown: AbortController;
  readonly deletionGate: ReturnType<typeof createProjectDeletionGate>;
  readonly baseRoot?: string;
  readonly port: number;
  readonly serverPort: () => number | undefined;
  readonly listeningPort: () => number;
  readonly application?: ProjectApplication;
  readonly serviceApplication?: ServiceApplicationPorts;
  /** Host-owned app data/cache/temp roots; never model or request input. */
  readonly privateMediaDirectories: readonly string[];
  /** Borrowed app settings are closed by their owner, not this project. */
  readonly settings?: {readonly image?: ImageSettings; readonly customImage?: CustomImageSettings; readonly video?: VideoSettings; readonly comfy?: ComfySettings};
}

/** Shared assembly on a real kernel store and explicit application ports.
 * It neither opens a store nor binds a listener; drafts remain an unbound
 * factory until the host supplies its own context. */
export async function composeProjectRuntime({store, shutdown, deletionGate, baseRoot = store.root, port, serverPort, listeningPort,
  agentSettings: suppliedAgentSettings, agentSecretCodecFactory, imageSecretCodec, videoSecretCodec, imageNetwork, comfyNetwork,
  comfyModule = 'load', taskGatewayV2, taskFault, localDraftChannel = 'web', nativeAudioPreview, application, serviceApplication, privateMediaDirectories, settings,
}: ProjectRuntimeOptions) {
  const root = store.root, ordinaryStore = store;
  assertProjectStore(store);
  validateProjectRetainedRows(store);
  const kernel = true;
  if ((!application || !serviceApplication)) throw new TypeError('Kernel project assembly requires application ports');
  const appRoot = application?.dataDir ?? root;
  const appScope = application ? {databaseFile: application.databaseFile} : {};
  const documents = application ? {documents: createAppCompanionDocuments(application)} : {};
  const ownsLock = () => ownsStoreLock(store);
  const ownsAppLock = application ? () => {
    const identity = projectFileIdentity(application.databaseFile);
    return application.db.isOpen && identity !== null && isAppLibraryHeld(identity, application.db);
  } : ownsLock;
  const hasProject = (id: string) => application ? application.registry.get(id) !== null : readLastProjectTarget(store.db, id) !== null;
  let services!: Services, serviceCall!: ServiceCall;
  let serviceDrain: () => Promise<void> = async () => {};
  let agentSettings: NonNullable<ServerOptions['agentSettings']> | undefined;
  let ownsAgentSettings = false;
  let agentAuthorizations: ReturnType<typeof createAgentAuthorizations> | undefined;
  let uiPreferences: ReturnType<typeof createUiPreferences> | undefined;
  let imageSettings: ImageSettings | undefined, customImageSettings: CustomImageSettings | undefined, videoSettings: VideoSettings | undefined, comfySettings: ComfySettings | undefined;
  let taskRuntimeV2: ReturnType<typeof createAgentTaskRuntime> | undefined, taskToolsV2: ReturnType<typeof createAgentTaskTools> | undefined;
  let taskHttpV2: ReturnType<typeof createAgentTaskHttp> | undefined, agentDiagnosticsHttp: ReturnType<typeof createAgentDiagnosticsHttp> | undefined;
  let projectRules: ReturnType<typeof createMioProjectRules> | undefined;
  let editTasks: ReturnType<typeof createEditTasks> | undefined;
  let worker: ReturnType<typeof startWorker> | undefined;
  const closeSettings = async (): Promise<void> => {
    const results = await Promise.allSettled([
      () => ownsAgentSettings ? agentSettings?.close() : undefined,
      () => !settings?.image ? imageSettings?.close() : undefined, () => !settings?.customImage ? customImageSettings?.close() : undefined,
      () => !settings?.video ? videoSettings?.close() : undefined, () => !settings?.comfy ? comfySettings?.close() : undefined,
    ].map(invokeCleanup));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Project settings cleanup failed');
  };
  try {
    const configuration=serviceApplication?.configuration ?? createWorkspaceConfiguration({root:application?.dataDir ?? baseRoot,env:process.env,...documents});
    const providerEnv=configuration?.environment()??process.env;
    const providers = createProviderRegistry({db: store.db, root,env:providerEnv});
    let imageHttp: HttpHandler=async()=>false,comfyHttp: HttpHandler=async()=>false,videoHttp: HttpHandler=async()=>false;
    {
    if(suppliedAgentSettings)agentSettings=suppliedAgentSettings;
    else {
      const directory=path.join(appRoot,'agent-settings'),codec=await agentSecretCodecFactory?.({directory,channel:localDraftChannel});
      try{agentSettings=await createAgentSettings({persistence:createAgentSettingsFile({directory}),...(codec?{secretCodec:codec.secretCodec,storage:codec.storage}:{})});ownsAgentSettings=true;}
      catch(error){codec?.close();throw error;}
    }
    agentAuthorizations = createAgentAuthorizations({root:appRoot,...appScope,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock:ownsAppLock},readCurrentTarget:async()=>{
        const settings=sanitizeAgentSettingsResult(await agentSettings!.get({selfPort:serverPort()}));
        return {destination:deriveAgentEndpoint(settings.configuration),model:settings.configuration.model,settingsRevision:settings.revision};
      }});
    imageSettings = settings?.image ?? await createImageSettings({persistence:createImageSettingsFile({directory:path.join(appRoot,'image-settings'),privateRoot:appRoot}),
      ...(imageSecretCodec?{secretCodec:imageSecretCodec,storage:()=>imageSecretCodec.storage()}: {})});
    customImageSettings = settings?.customImage ?? await createCustomImageSettings({persistence:createCustomImageSettingsFile({directory:path.join(appRoot,'image-settings'),privateRoot:appRoot}),
      ...(imageSecretCodec?{secretCodec:imageSecretCodec,storage:()=>imageSecretCodec.storage()}: {})});
    videoSettings = settings?.video ?? await createVideoSettings({directory:path.join(appRoot,'video-settings'),privateRoot:appRoot,signal:shutdown.signal,
      ...(videoSecretCodec?{secretCodec:videoSecretCodec,storage:()=>videoSecretCodec.storage()}: {})});
    // Evaluate at every real I/O boundary, including desktop's port:0 binding.
    // This process knows its backend listener, not unrelated frontend processes.
    const comfyReservedPorts = (): Set<number> => new Set([port, serverPort()].filter((value): value is number => value !== undefined && Number.isInteger(value) && value > 0));
    comfySettings = settings?.comfy ?? await createComfySettings({directory:path.join(appRoot,'comfy-settings'),privateRoot:appRoot,reservedPorts:comfyReservedPorts});
    const {connector:comfyConnector,availability:comfyModuleAvailability} = composeOfficialComfyModule(comfyModule,()=>createComfyConnector({reservedPorts:comfyReservedPorts,...(comfyNetwork ? {networkDeps:{httpRequest:comfyNetwork.httpRequest}} : {})}));
    const composed = createServices(ordinaryStore, providers, {...(serviceApplication?{application:serviceApplication}:{}),env:providerEnv,signal: shutdown.signal,videoSettings,agentAuthorizations,readRecentOpened:()=>uiPreferences?.get().recentOpened??{},imageOptions:{settings:imageSettings,liveGateway:createLiveImageGateway({settings:imageSettings,...imageNetwork}),customSettings:customImageSettings,customGateway:createCompatibleImageGateway({settings:customImageSettings,...imageNetwork}),comfySettings,comfyConnector,comfyModuleAvailability}});
    services = composed;
    serviceCall = (operation, input, context) => composed.call(operation, input, context);
    serviceDrain = () => composed.drain();
    imageHttp=createImageHttp({settings:imageSettings,customSettings:customImageSettings,approve:composed.imageApproval,reject:composed.imageRejection,signal:shutdown.signal});
    videoHttp=createVideoHttp({settings:videoSettings,signal:shutdown.signal});
    comfyHttp=createComfyHttp({settings:comfySettings,connector:comfyConnector,availability:comfyModuleAvailability,signal:shutdown.signal});
    }
    editTasks = createEditTasks({store: ordinaryStore, services, ...(taskFault ? {fault: taskFault} : {})});
    // openStore already owns the exclusive workspace lock. Startup only
    // reconciles durable evidence and never dispatches a prepared edit.
    await editTasks.reconcileStartup();
    const editTasksHttp = createEditTasksHttp({tasks: editTasks, signal: shutdown.signal});
    const workspacePreferences: WorkspacePreferences = createWorkspacePreferences(ordinaryStore,application?{application:{db:application.db,tx:application.tx,hasProject}}:{});
    uiPreferences = createUiPreferences({root:appRoot,...appScope,...documents,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock:ownsAppLock,isReadOnly:()=>false,hasProject}});
    const lastProject: LastProject = createLastProject({root:appRoot,...appScope,...documents,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock:ownsAppLock,
        readProject:projectId=>application?(hasProject(projectId)?{id:projectId}:null):readLastProjectTarget(store.db,projectId)}});
    const lastProjectHttp = createLastProjectHttp({lastProject,signal:shutdown.signal});
    // Imported generations are finished history, so they are archived out of the task center.
    const projectPackages = null;
    const projectPackageHttp = createProjectPackageHttp({service:()=>projectPackages!,available:()=>projectPackages!==null,signal:shutdown.signal});
    const exportFileRecovery: ExportFileRecovery=createExportFileRecovery({root,db:store.db,signal:shutdown.signal,hold:deletionGate.hold,
      guards:{isTimelineRenderRecord,readOwnedAsset:(projectId,assetId)=>readOwnedTimelineAsset(store.db,projectId,assetId)},
      assertAvailable:()=>{if(!ownsStoreLock(store))throw new AppError('EXPORT_FILE_UNAVAILABLE','导出文件不可用。',409);},
      validateFile:(file,allowMissing)=>resolveProjectMediaFile(store,path.relative(root,file),{allowMissing}).info,
      validateDirectory:directory=>validateManagedDirectory(directory,{root:path.join(root,'media')})});
    const ordinary = services;
    const draftsFactory = createProjectDraftsFactory({store, channel: localDraftChannel, services: ordinary,
      call: (operation, input) => serviceCall(operation, input), ownsApplicationLock: ownsAppLock});
    let audioPreviewHttp: HttpHandler=async()=>false,continuousAudioHttp: HttpHandler=async()=>false;
    audioPreviewHttp=createTimelineAudioPreviewHttp({service:ordinary.audioPreview,nativeAdmission:nativeAudioPreview,signal:shutdown.signal,assertAvailable:()=>{assertProjectStore(store);}});
    continuousAudioHttp=createTimelineAudioContinuousHttp({service:ordinary.audioPreview,nativeAdmission:nativeAudioPreview,signal:shutdown.signal,assertAvailable:()=>{assertProjectStore(store);}});
    // Desktop injects a narrow trusted-main proxy. Web mode persists only
    // nonsecret metadata here; newly entered Agent keys remain in backend RAM.
    {
    const ordinary = services;
    // The trusted desktop proxy validates and sanitizes these values itself; the
    // local engine exposes the same dependency. createAgentTaskRuntime re-sanitizes reads.
    const chatSettings = agentSettings as unknown as AgentSettingsService;
    if(isProjectStore(store)&&application)projectRules=createMioProjectRules({store,application,signal:shutdown.signal,assertMutationAllowed:()=>ordinary.assertMutationAllowed()});
    taskToolsV2=createAgentTaskTools({store:ordinaryStore,services:ordinary,projectMedia:createMioProjectMedia({store,privateDirectories:privateMediaDirectories,signal:shutdown.signal}),...(projectRules?{rules:projectRules}:{}),...(application?{policyStore:application.agentPolicy}:{})});
    taskRuntimeV2=createAgentTaskRuntime({store:ordinaryStore,...(application?{policyStore:application.agentPolicy,onDiagnosticCompleted:summary=>application.tx(()=>{
      const raw=application.documents.read('agent-diagnostic-summary-v1.json');
      const previous=raw===null?null:agentDiagnosticSummarySchema.parse(JSON.parse(raw));
      if(previous===null||previous.completedAt<=summary.completedAt)application.documents.write('agent-diagnostic-summary-v1.json',JSON.stringify(summary));
    })}:{}),agentSettings:chatSettings,authorizations:agentAuthorizations!,tools:taskToolsV2,...(projectRules?{rules:projectRules}:{}),selfPort:()=>listeningPort(),assertMutationAllowed:()=>ordinary.assertMutationAllowed(),checksPreflight:(input,{signal}={})=>ordinary.call('timeline.export.preflight',input,{signal:signal?AbortSignal.any([shutdown.signal,signal]):shutdown.signal}),...(taskGatewayV2?{gateway:taskGatewayV2}:{})});
    taskHttpV2=createAgentTaskHttp({runtime:taskRuntimeV2,tools:taskToolsV2,assertMutationAllowed:()=>ordinary.assertMutationAllowed()});
    agentDiagnosticsHttp=createAgentDiagnosticsHttp({settings:chatSettings,authorizations:agentAuthorizations!,tools:taskToolsV2,policy:()=>taskRuntimeV2!.policy(),selfPort:()=>listeningPort(),hasProject:id=>!!store.get('projects',id),storage:projectId=>projectId===store.projectId?readMioStorage(store.db):undefined});
    }

    return {
      providers, services, serviceCall, serviceDrain, agentSettings, agentAuthorizations, uiPreferences, imageSettings, customImageSettings, videoSettings, comfySettings,
      lastProject, draftsFactory,
      editTasks, workspacePreferences, imageHttp, comfyHttp, videoHttp, editTasksHttp, lastProjectHttp, projectPackageHttp,
      exportFileRecovery, audioPreviewHttp, continuousAudioHttp,
      taskToolsV2, taskRuntimeV2, taskHttpV2, agentDiagnosticsHttp, projectRules, closeSettings,
      startWorker: () => worker ??= startWorker(store, services, providers, {signal: shutdown.signal}),
    };
  } catch (error) {
    shutdown.abort();
    projectRules?.close(); taskRuntimeV2?.close(); taskHttpV2?.close();
    try {
      const results = await boundedShutdown(Promise.allSettled([
        () => taskRuntimeV2?.drain(), () => serviceDrain(), () => editTasks?.drain(), closeSettings,
      ].map(invokeCleanup)), 'SERVER_STOP_TIMEOUT');
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Project cleanup failed');
    } catch (cleanupError) {
      // Keep the store and its fences alive when any continuation might still
      // run. The outer server never received these resources to drain again.
      throw new ProjectRuntimeCleanupError(error, cleanupError);
    }
    taskToolsV2?.dispose();
    throw error;
  }
}
export type ProjectRuntime = Awaited<ReturnType<typeof composeProjectRuntime>>;
