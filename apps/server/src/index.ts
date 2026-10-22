import {sendWorkspaceBackup} from './workspace-backup-download.ts';
import {resolveWorkspaceActivation} from '../../../packages/business/src/workspace-backup-runtime.ts';
import {createWorkspaceConfiguration} from '../../../packages/business/src/workspace-configuration.ts';
import {consumeOpacityCandidateLaunch, assertOpacityCandidateBuild, closeUnusedOpacityCandidateLaunch} from './opacity-candidate-launch.ts';
import {createOpacityCandidateApplicationEditorAssembly} from './opacity-candidate-editor-assembly.ts';
import {createOpacityCandidateDomain} from '../../../packages/business/src/opacity-candidate-domain.ts';
import {createOpacityCandidateTimelineDeliveryGuards,readOpacityCandidateApplicationSource,assertOpacityCandidateApplicationSource} from '../../../packages/business/src/opacity-candidate-delivery.ts';
import {createTimelineAudioPreviewHttp} from './timeline-audio-preview-http.ts';
import {createTimelineAudioContinuousHttp} from './timeline-audio-continuous-http.ts';
import {readTimelineDeliveryDownload, timelineDeliveryResponseHeaders, readTimelineExportPreviewMedia, timelineExportPreviewResponseHeaders} from '@mioon/business/timeline-delivery-read';
import {readOwnedTimelineAsset} from '@mioon/business/timeline-sources';
import {isTimelineRenderRecord, isTimelineMutationResponse, hasRequestNotAppliedProof, schemas, publicValue, AppError} from '@mioon/contracts';
import {getWorkspaceRestoreContext} from '@mioon/business/workspace-restore-schema';
import {isUnavailableRestoredRoute,workspaceRestoreError} from '@mioon/business/workspace-restore-policy';
import http from 'node:http';
import type {IncomingMessage, ServerResponse, Server} from 'node:http';
import {createChatRuntime} from '@mioon/business/agent/chat-runtime';
import {createAgentTaskRuntime} from '@mioon/business/agent/task-runtime-v2';
import type {AgentTaskRuntime} from '@mioon/business/agent/task-runtime-v2';
import {createAgentTaskTools} from '@mioon/business/agent/task-tools-v2';
import type {AgentTaskTools} from '@mioon/business/agent/task-tools-v2';
import type {TaskGateway} from '@mioon/business/agent/task-gateway-v2';
import {createAgentTaskHttp} from './agent-task-http-v2.ts';
import {createAgentDiagnosticsHttp} from './agent-diagnostics-http.ts';
import {createAgentAuthorizations} from '../../../packages/business/src/agent/authorizations.ts';
import {createUiPreferences} from '../../../packages/business/src/ui-preferences.ts';
import {createProjectDeletionGate} from './project-deletion-gate.ts';
import {readWorkspaceInfo} from './workspace-info.ts';
import {inspectMediaTools} from '../../../packages/business/src/media-tool-diagnostics.ts';
import {mediaExecutable} from '../../../packages/business/src/media-environment.ts';
import {run as runMedia} from '@mioon/business/media-runtime';
import {createExportFileRecovery} from './export-file-recovery.ts';
import packageMetadata from '../../../package.json' with {type:'json'};
import {deriveAgentEndpoint} from '../../../packages/contracts/src/agent-protocol.ts';
import {createAgentEditService} from '@mioon/business/agent/edit-proposals';
import {createEditTasks} from '@mioon/business/edit-tasks';
import {createLocalDrafts} from '@mioon/business/local-drafts';
import {createLastProject,readLastProjectTarget} from '@mioon/business/last-project';
import {createLocalDelivery} from '@mioon/business/local-delivery';
import {hash,canonical} from '@mioon/business/services';
import {createLocalShotText} from '@mioon/business/local-shot-text';
import {createLocalShotTextDomain} from '@mioon/business/local-shot-text-domain';
import {createLocalMutationServices} from '@mioon/business/local-mutations';
import {validateImageConsumption} from '@mioon/business/image-consumption';
import {createLocalShotTextHttp} from './local-shot-text-http.ts';
import {createTimelineRecoveryBoundary,readTimelineReceipt} from '@mioon/business/timeline-recovery';
import {createLocalDraftHttp} from './local-drafts-http.ts';
import {createLastProjectHttp} from './last-project-http.ts';
import {createProjectPackageHttp} from './project-package-http.ts';
import {createProjectPackageService} from '@mioon/business/project-package/service';
import {createLocalDeliveryHttp} from './local-delivery-http.ts';
import {createChatHttp} from './chat-http.ts';
import type {ChatHttp} from './chat-http.ts';
import {createEditTasksHttp} from './edit-tasks-http.ts';
import {createImageHttp} from './image-http.ts';
import {createVideoHttp} from './video-http.ts';
import {createVideoSettings} from '../../../packages/business/src/video/settings.ts';
import {createComfyHttp} from './comfy-http.ts';
import {createComfySettings} from '@mioon/business/comfy/settings';
import {composeOfficialComfyModule} from './comfy-module.ts';
import {createComfyConnector} from '@mioon/business/comfy/connector';
import {createImageSettings,createCustomImageSettings} from '@mioon/business/images/settings';
import {createImageSettingsFile,createCustomImageSettingsFile} from '@mioon/business/images/settings-file';
import {createLiveImageGateway,createCompatibleImageGateway} from '@mioon/business/images/gateway';
import {createFileResponses} from './file-response.ts';
import type {FileResponses} from './file-response.ts';
import {createOwnedMediaGraphReader} from '@mioon/business/inspection';
import {createVersionComparisonMediaHttp} from './version-comparison-media.ts';
import {callObservedRpc} from './rpc-observation.ts';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {createAgentSettings, sanitizeAgentSettingsError, sanitizeAgentSettingsResult} from '@mioon/business/agent/settings';
import type {AgentSettingsService, SettingsContextOptions, SecretCodec, PublicStorage} from '@mioon/business/agent/settings';
import {createAgentSettingsFile} from '@mioon/business/agent/settings-file';
import {MAX_AGENT_SETTINGS_BYTES} from '@mioon/business/agent/config';
import {openStore, createServices, startWorker, safePath, createProviderRegistry, createWorkspacePreferences, MAX_WORKSPACE_PREFERENCES_BYTES} from '@mioon/business';
import {validateWorkspaceStorage,ownsStoreLock} from '@mioon/business/db';
import type {WorkspaceStore} from '@mioon/business/db';
import {readPrivateFile, writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile,validateManagedDirectory} from '@mioon/contracts/private-storage';
import {assertMediaTerminated, boundedShutdown, checkpoint} from '@mioon/business/operation-lifecycle';
import {terminateMediaProcesses,onMediaProcess} from '@mioon/business/media-processes';
import type {NativeAudioPreviewAuthority} from '@mioon/business/native-audio-preview';
import type {ComfyModuleMode} from '../../../packages/contracts/src/comfy-availability.ts';
import type {ComfyTransportOptions} from '../../../packages/business/src/comfy/network.ts';
import type {ReviewedImageGatewayOptions} from '../../../packages/business/src/images/gateway.ts';
import type {WorkspaceInfo} from '../../../packages/contracts/src/workspace-info.ts';

const directory = path.dirname(fileURLToPath(import.meta.url));
type LocalDraftChannel = WorkspaceInfo['channel'];
type HttpHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
type Services = ReturnType<typeof createServices>;
type OrdinaryServices = Services;
/** Cross-path transport surface shared by ordinary and verified candidate services. */
type ServiceCall = (operation: string, input: unknown, context?: Record<string, unknown>) => Promise<unknown>;
type ServiceDrain = () => Promise<void>;
type EditTasks = ReturnType<typeof createEditTasks>;
type ChatRuntime = ReturnType<typeof createChatRuntime>;
type CandidateEditor = ReturnType<typeof createOpacityCandidateApplicationEditorAssembly>;
type CandidateDomain = ReturnType<typeof createOpacityCandidateDomain>;
type VersionComparisonMedia = ReturnType<typeof createVersionComparisonMediaHttp>;
type AgentAuthorizations = ReturnType<typeof createAgentAuthorizations>;
type UiPreferences = ReturnType<typeof createUiPreferences>;
type ImageSettings = Awaited<ReturnType<typeof createImageSettings>>;
type CustomImageSettings = Awaited<ReturnType<typeof createCustomImageSettings>>;
type VideoSettings = Awaited<ReturnType<typeof createVideoSettings>>;
type ComfySettings = Awaited<ReturnType<typeof createComfySettings>>;
type ComfyConnector = ReturnType<typeof createComfyConnector>;
type LocalShotText = ReturnType<typeof createLocalShotText>;
type LocalDrafts = ReturnType<typeof createLocalDrafts>;
type LocalDelivery = ReturnType<typeof createLocalDelivery>;
type LastProject = ReturnType<typeof createLastProject>;
type ExportFileRecovery = ReturnType<typeof createExportFileRecovery>;
type WorkspacePreferences = ReturnType<typeof createWorkspacePreferences>;
type LocalDraftHttpHandler = ReturnType<typeof createLocalDraftHttp> | CandidateEditor['localDraftHttp'];
type ChatRuntimeOptions = Parameters<typeof createChatRuntime>[0];
type EditTasksOptions = Parameters<typeof createEditTasks>[0];
type TaskFault = NonNullable<EditTasksOptions extends {fault?: infer F} ? F : never>;
type AgentEditServiceOptions = Parameters<typeof createAgentEditService>[0];
type AgentEditFault = NonNullable<AgentEditServiceOptions extends {fault?: infer F} ? F : never>;
type AgentGatewaySeam = ChatRuntimeOptions extends {gateway?: infer G} ? NonNullable<G> : never;
interface SecretOperationOptions {signal?: AbortSignal | undefined; isActive?: (() => boolean) | undefined}
interface ImageSecretStorageState {readonly persistentAvailable: boolean; readonly sessionScope: 'server'; readonly reasonCode: 'OS_SECRET_STORE_UNAVAILABLE' | 'LINUX_BASIC_TEXT' | null}
/** Trusted utility-only codec surface; never supplied from HTTP/environment. */
interface ImageSecretCodecPort {
  storage(options?: SecretOperationOptions): ImageSecretStorageState;
  refreshStorage(options?: SecretOperationOptions): Promise<unknown>;
  encrypt(plaintext: string, options?: SecretOperationOptions): Promise<string>;
  decrypt(ciphertext: string, options?: SecretOperationOptions): Promise<string>;
}
/** Persisted Agent settings surface, whether composed locally or proxied from
 * the trusted desktop main process. It is never HTTP/environment-configurable.
 * The proxy returns already-sanitized values, hence the unknown result types;
 * createChatRuntime re-sanitizes every read at this boundary. */
interface AgentSettingsPort {
  get(options?: SettingsContextOptions & {selfPort?: number | undefined}): Promise<unknown>;
  put(input: unknown, options?: SettingsContextOptions & {selfPort?: number | undefined}): Promise<unknown>;
  close(): unknown;
}
interface ImageNetworkSeam {lookup?: ReviewedImageGatewayOptions['lookup']; httpsRequest?: ReviewedImageGatewayOptions['httpsRequest']}
interface ComfyNetworkSeam {httpRequest: NonNullable<ComfyTransportOptions['httpRequest']>}
export interface ServerOptions {
  dataDir?: string;
  port?: number;
  distDir?: string;
  token?: string;
  agentSettings?: AgentSettingsPort;
  agentSecretCodecFactory?:(options:{directory:string;channel:LocalDraftChannel})=>Promise<{secretCodec:SecretCodec;storage:()=>PublicStorage;close:()=>void}>;
  imageSecretCodec?: ImageSecretCodecPort;
  videoSecretCodec?: ImageSecretCodecPort;
  imageNetwork?: ImageNetworkSeam;
  comfyNetwork?: ComfyNetworkSeam;
  comfyModule?: ComfyModuleMode;
  chatGateway?: AgentGatewaySeam;
  taskGatewayV2?: TaskGateway;
  agentEditFault?: AgentEditFault;
  taskFault?: TaskFault;
  localDraftChannel?: LocalDraftChannel;
  nativeAudioPreview?: NativeAudioPreviewAuthority;
  opacityCandidateLaunch?: object;
}
interface ServerInstance {
  url: string;
  port: number;
  token: string;
  tokenFile: string;
  dataDir: string;
  setBackupDirectory(directory:string): unknown;
  close(): Promise<void>;
  handleRequest?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}
type HttpErrorFields = {status?: number | undefined; code?: string | undefined; message?: string | undefined; details?: unknown};
const field = (value: unknown, name: string): unknown => value !== null && typeof value === 'object' && name in value ? (value as Record<string, unknown>)[name] : undefined;
const errorFields = (error: unknown): HttpErrorFields => (error !== null && typeof error === 'object' ? error : {}) as HttpErrorFields;
/** Parsed JSON from trusted same-origin handlers. Each route validates its own
 * fixed fields; a non-object body fails exactly like the former untyped code. */
const jsonObject = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const validToken = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 20 || Buffer.byteLength(value, 'utf8') > 4096 || /[\r\n\0]/.test(value)) {
    throw Error('MIOON_TOKEN must contain at least 20 characters, at most 4096 bytes, and no line breaks or NUL bytes');
  }
  return value;
};
const equal = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const json = (res: ServerResponse, status: number, data: unknown): void => {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
};
async function body(req: IncomingMessage, max = 42 * 1024 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(Error('Request too large'), {status: 413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw Object.assign(Error('Invalid JSON'), {status: 400}); }
}

/** Transport lifecycle shared by the CLI and the Electron utility process.
 * No signal handlers, process exits, UI imports or host-runtime spawning here.
 */
export async function startServer(options: ServerOptions = {}): Promise<ServerInstance> {
  try {return await composeServer(options, true);}
  catch(error){closeUnusedOpacityCandidateLaunch(options.opacityCandidateLaunch);throw error;}
}

/** In-memory request composition for isolated tests. This never listens or
 * starts a worker, and requires the same exact fresh42 launch proof. */
export async function createOpacityCandidateRequestApplication(options: ServerOptions = {}): Promise<ServerInstance> {
  if (!options.opacityCandidateLaunch) throw Object.assign(Error('A fresh42 development launch is required.'), {code: 'OPACITY_CANDIDATE_LAUNCH_REQUIRED'});
  try {return await composeServer(options, false);}
  catch(error){closeUnusedOpacityCandidateLaunch(options.opacityCandidateLaunch);throw error;}
}

async function composeServer({
  dataDir = path.resolve(directory, '../../../data'),
  port = 4318,
  distDir = path.resolve(directory, '../../web/dist'),
  token: suppliedToken,
  agentSettings: suppliedAgentSettings,
  agentSecretCodecFactory, // Standalone Node launcher only; desktop owns its codec.
  imageSecretCodec, // Trusted desktop main codec only; never supplied by HTTP.
  videoSecretCodec, // Independent video credential namespace on the owned utility channel.
  imageNetwork, // Trusted synthetic DNS/HTTPS fixture only; never HTTP/environment.
  comfyNetwork, // Trusted synthetic HTTP fixture only; never HTTP/environment.
  comfyModule = 'load', // Trusted launcher/distribution composition, never HTTP/RPC input.
  chatGateway, // Trusted synthetic QA injection; never configurable through HTTP or environment.
  taskGatewayV2, // Trusted synthetic v2 QA injection; never HTTP/environment.
  agentEditFault, // Trusted crash-boundary tests only; never HTTP/environment configuration.
  taskFault, // Trusted durable-edit crash-boundary tests only; never HTTP/environment configuration.
  localDraftChannel = 'web', // Trusted desktop build identity only; never HTTP/environment configuration.
  nativeAudioPreview, // Trusted per-utility authority only; never HTTP/environment configuration.
  opacityCandidateLaunch, // Exact one-shot internal dev proof; never payload/environment.
}: ServerOptions = {}, listen = true): Promise<ServerInstance> {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw Error('Invalid PORT');
  if (comfyNetwork !== undefined && (comfyNetwork === null || typeof comfyNetwork.httpRequest !== 'function')) throw Error('Invalid local ComfyUI transport');
  if (!['load','skip','not-provided'].includes(comfyModule)) throw Error('Invalid official ComfyUI module composition');
  // Validate profile-independent arguments before consuming the one-shot
  // launch; the launcher can release an unused proof on an argument failure.
  const dist = path.resolve(distDir);
  const candidate = opacityCandidateLaunch === undefined ? null : consumeOpacityCandidateLaunch(opacityCandidateLaunch);
  const baseRoot=path.resolve(dataDir);
  const activation=candidate?null:await resolveWorkspaceActivation(baseRoot);
  const root = candidate ? candidate.root : activation!.root;
  const indexFile = candidate ? 'opacity-candidate.html' : 'index.html';
  const tokenFile = path.join(root, 'access-token');
  // Validate every existing managed entry before SQLite, lock creation or token
  // generation. An explicit token can override unused malformed token contents,
  // but can never bypass unsafe filesystem metadata on an existing token.
  let token = suppliedToken;
  try {
    if (candidate) assertOpacityCandidateBuild(dist);
    if (suppliedToken !== undefined) validToken(suppliedToken);
    validateWorkspaceStorage(root);
    if (token === undefined) {
      const stored = readPrivateFile(tokenFile, {root, allowMissing: true, maxBytes: 4098, encoding: 'utf8'});
      // Preserve the server/client token-file whitespace normalization contract.
      if (stored !== null) token = validToken((stored as string).trim());
    }
  } catch (error) {candidate?.store.close();throw error;}
  const store = candidate ? candidate.store : openStore(root);
  // candidate === null selects the ordinary store; candidate stores never reach
  // the ordinary service, worker, chat or local-mutation factories below.
  const ordinaryStore = store as WorkspaceStore;
  const shutdown = new AbortController();
  const deletionGate=createProjectDeletionGate({subscribeMedia:onMediaProcess,signal:shutdown.signal,
    busy:()=>{throw new AppError('PROJECT_DELETE_BUSY','工作区仍有媒体、请求或文件传输在执行，请结束后再删除项目。',409);}});
  let worker: ReturnType<typeof startWorker> | undefined, server: Server | undefined, agentSettings: AgentSettingsPort | undefined,
    agentAuthorizations: AgentAuthorizations | undefined, uiPreferences: UiPreferences | undefined, imageSettings: ImageSettings | undefined,
    customImageSettings: CustomImageSettings | undefined, videoSettings: VideoSettings | undefined, comfySettings: ComfySettings | undefined, chatRuntime: ChatRuntime | undefined,
    chatHttp: ChatHttp | undefined, taskRuntimeV2: AgentTaskRuntime | undefined, taskToolsV2: AgentTaskTools | undefined,
    taskHttpV2: ReturnType<typeof createAgentTaskHttp> | undefined, agentDiagnosticsHttp:ReturnType<typeof createAgentDiagnosticsHttp>|undefined, editTasks!: EditTasks, candidateEditor: CandidateEditor | undefined;
  let services!: Services;
  let serviceCall!: ServiceCall;
  let serviceDrain!: ServiceDrain;
  const ownsLock = () => candidate ? candidate.assembly.ownsLock() : ownsStoreLock(store);
  const isRestored = () => Boolean(candidate ? candidate.assembly.getRestoreContext() : getWorkspaceRestoreContext(store));
  let candidateDomain: CandidateDomain | null, files!: FileResponses, versionComparisonMedia!: VersionComparisonMedia;
  const serverPort = (): number | undefined => {
    const address = server?.address();
    return address !== null && typeof address === 'object' ? address.port : undefined;
  };
  // Preserve the original fail-fast behavior when a route needs the bound port.
  const listeningPort = (): number => {
    const address = server?.address();
    if (address === undefined || address === null || typeof address === 'string') throw new TypeError('The local HTTP listener is not bound to a TCP port.');
    return address.port;
  };
  try {
  candidateDomain = candidate ? createOpacityCandidateDomain(store) : null;
  files = createFileResponses({signal: shutdown.signal});
  versionComparisonMedia = createVersionComparisonMediaHttp({db: store.db, root, signal: shutdown.signal,
    readGraph: projectId => createOwnedMediaGraphReader(store.db, projectId), resolvePath: safePath, createFiles: createFileResponses,
    validateFile: file => {
      const metadata = validateManagedFile(file, {root});
      // No allowMissing is passed, so an existing file must produce metadata.
      if (metadata === null) throw Object.assign(Error('本地文件不可用。'), {code: 'FILE_UNAVAILABLE', status: 404});
      return metadata;
    },
    assertAvailable: () => {
      if (candidate || getWorkspaceRestoreContext(store)) throw workspaceRestoreError();
      if (!ownsStoreLock(store)) throw Object.assign(Error('本地文件不可用。'), {code: 'FILE_UNAVAILABLE', status: 404});
    }});
    if (token === undefined) {
      token = randomBytes(32).toString('hex');
      writePrivateFileAtomic(tokenFile, token, {root, maxBytes: 4098, replace: false});
    }
    const restored=candidate ? candidate.assembly.getRestoreContext() : getWorkspaceRestoreContext(store);
    const configuration=candidate?null:createWorkspaceConfiguration({root:baseRoot,env:process.env});
    const providerEnv=configuration?.environment()??process.env;
    const providers = restored || candidate ? new Map() : createProviderRegistry({db: store.db, root,env:providerEnv});
    let imageHttp: HttpHandler=async()=>false,comfyHttp: HttpHandler=async()=>false,videoHttp: HttpHandler=async()=>false;
    if(!restored && !candidate){
    if(suppliedAgentSettings)agentSettings=suppliedAgentSettings;
    else {
      const directory=path.join(root,'agent-settings'),codec=await agentSecretCodecFactory?.({directory,channel:localDraftChannel});
      try{agentSettings=await createAgentSettings({persistence:createAgentSettingsFile({directory}),...(codec?{secretCodec:codec.secretCodec,storage:codec.storage}:{})});}
      catch(error){codec?.close();throw error;}
    }
    agentAuthorizations = createAgentAuthorizations({root,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock,isRestored},readCurrentTarget:async()=>{
        const settings=sanitizeAgentSettingsResult(await agentSettings!.get({selfPort:serverPort()}));
        return {destination:deriveAgentEndpoint(settings.configuration),model:settings.configuration.model,settingsRevision:settings.revision};
      }});
    imageSettings = await createImageSettings({persistence:createImageSettingsFile({directory:path.join(root,'image-settings'),privateRoot:root}),
      ...(imageSecretCodec?{secretCodec:imageSecretCodec,storage:()=>imageSecretCodec.storage()}: {})});
    customImageSettings = await createCustomImageSettings({persistence:createCustomImageSettingsFile({directory:path.join(root,'image-settings'),privateRoot:root}),
      ...(imageSecretCodec?{secretCodec:imageSecretCodec,storage:()=>imageSecretCodec.storage()}: {})});
    videoSettings = await createVideoSettings({directory:path.join(root,'video-settings'),privateRoot:root,signal:shutdown.signal,
      ...(videoSecretCodec?{secretCodec:videoSecretCodec,storage:()=>videoSecretCodec.storage()}: {})});
    // Evaluate at every real I/O boundary, including desktop's port:0 binding.
    // This process knows its backend listener, not unrelated frontend processes.
    const comfyReservedPorts = (): Set<number> => new Set([port, serverPort()].filter((value): value is number => value !== undefined && Number.isInteger(value) && value > 0));
    comfySettings = await createComfySettings({directory:path.join(root,'comfy-settings'),privateRoot:root,reservedPorts:comfyReservedPorts});
    const {connector:comfyConnector,availability:comfyModuleAvailability} = composeOfficialComfyModule(comfyModule,()=>createComfyConnector({reservedPorts:comfyReservedPorts,...(comfyNetwork ? {networkDeps:{httpRequest:comfyNetwork.httpRequest}} : {})}));
    const composed = createServices(ordinaryStore, providers, {env:providerEnv,workspaceBaseRoot:baseRoot,backupQuiescent:()=>!taskRuntimeV2?.isBusy()&&deletionGate.isQuiescent(['workspace.backup.create','workspace.backup.restore.stage','workspace.backup.import']),signal: shutdown.signal,videoSettings,agentAuthorizations,readRecentOpened:()=>uiPreferences?.get().recentOpened??{},imageOptions:{settings:imageSettings,liveGateway:createLiveImageGateway({settings:imageSettings,...imageNetwork}),customSettings:customImageSettings,customGateway:createCompatibleImageGateway({settings:customImageSettings,...imageNetwork}),comfySettings,comfyConnector,comfyModuleAvailability}});
    services = composed;
    serviceCall = (operation, input, context) => composed.call(operation, input, context);
    serviceDrain = () => composed.drain();
    imageHttp=createImageHttp({settings:imageSettings,customSettings:customImageSettings,approve:composed.imageApproval,reject:composed.imageRejection,signal:shutdown.signal});
    videoHttp=createVideoHttp({settings:videoSettings,signal:shutdown.signal});
    comfyHttp=createComfyHttp({settings:comfySettings,connector:comfyConnector,availability:comfyModuleAvailability,signal:shutdown.signal});
    }else if(candidate){
      candidateEditor=createOpacityCandidateApplicationEditorAssembly(store,{signal:shutdown.signal});
      // The candidate coordinator exposes its bounded task subset; candidateEditor.drain()
      // owns candidate shutdown instead of tasks.drain().
      const candidateServices = candidateEditor.services;
      serviceCall = (operation, input, context) => candidateServices.call(operation, input, context);
      serviceDrain = () => candidateServices.drain();
      editTasks=candidateEditor.tasks as EditTasks;
    }else {
      const restoredServices = createServices(ordinaryStore,providers,{signal:shutdown.signal,workspaceBaseRoot:baseRoot});
      services = restoredServices;
      serviceCall = (operation, input, context) => restoredServices.call(operation, input, context);
      serviceDrain = () => restoredServices.drain();
    }
    if(!candidate)editTasks = createEditTasks({store: ordinaryStore, services, ...(taskFault ? {fault: taskFault} : {})});
    // openStore already owns the exclusive workspace lock. Startup only
    // reconciles durable evidence and never dispatches a prepared edit.
    await editTasks.reconcileStartup();
    const editTasksHttp = createEditTasksHttp({tasks: editTasks, signal: shutdown.signal});
    const workspacePreferences: WorkspacePreferences = createWorkspacePreferences(ordinaryStore);
    uiPreferences = createUiPreferences({root,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock,isReadOnly:()=>Boolean(restored||candidate),hasProject:projectId=>readLastProjectTarget(store.db,projectId)!==null}});
    const localDrafts: LocalDrafts | null = candidate ? null : createLocalDrafts({root,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock,isRestored,
        readTimeline:projectId=>createTimelineRecoveryBoundary(store.db,{projectId}).read(),
        readClipAsset:(projectId,clip)=>createTimelineRecoveryBoundary(store.db,{projectId}).clipSource(clip)}});
    const localDraftHttp: LocalDraftHttpHandler = candidate ? candidateEditor!.localDraftHttp : createLocalDraftHttp({drafts:localDrafts!,signal:shutdown.signal});
    const lastProject: LastProject = createLastProject({root,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock,isRestored,
        readProject:projectId=>readLastProjectTarget(store.db,projectId)}});
    const lastProjectHttp = createLastProjectHttp({lastProject,signal:shutdown.signal});
    // Imported generations are finished history, so they are archived out of the task center.
    const projectPackages = !restored && !candidate ? createProjectPackageService({store:ordinaryStore,appVersion:packageMetadata.version,afterCreate:async({projectId,jobIds})=>{
      for(let index=0;index<jobIds.length;index+=100)await serviceCall!('task.disposition.archiveCompleted',{projectId,requestId:randomUUID(),targets:jobIds.slice(index,index+100).map(taskId=>({kind:'generation',taskId,expectedRevision:0,expectedStatus:'succeeded'}))},undefined as never);
    }}) : null;
    projectPackages?.clearStale();
    shutdown.signal.addEventListener('abort',()=>{void projectPackages?.close();},{once:true});
    const projectPackageHttp = createProjectPackageHttp({service:()=>projectPackages!,available:()=>projectPackages!==null,signal:shutdown.signal});
    const localDelivery: LocalDelivery = createLocalDelivery({root,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock,isRestored,
        readTimeline:projectId=>candidateDomain ? candidateDomain.boundary({projectId}).read({sourceSemantics:false}) : createTimelineRecoveryBoundary(store.db,{projectId}).read({sourceSemantics:false}),
        isRenderInput:value=>{if(!candidateDomain)return schemas['timeline.render'].safeParse(value).success;try{candidateDomain.parse('timeline.render',value);return true;}catch{return false;}},
        isRenderResponse:(input,value)=>candidateDomain ? candidateDomain.isMutationResponse('timeline.render',input,value) : isTimelineMutationResponse('timeline.render',input,value),
        isNotApplied:(input,error)=>hasRequestNotAppliedProof(error,input,{operation:'timeline.render'}),
        readReceipt:input=>{
          const saved=readTimelineReceipt(store.db,input,'timeline.render');
          if(!saved)return null;
          if(saved.requestHash!==hash({operation:'timeline.render',input}))throw new AppError('IDEMPOTENCY_CONFLICT','原导出请求身份与内容不一致。',409);
          return publicValue((candidateDomain ? candidateDomain.boundary(input) : createTimelineRecoveryBoundary(store.db,input)).replay('timeline.render',saved.response as string));
        },
        render:async input=>{const response=await serviceCall('timeline.render',input);return candidate ? publicValue(response) : response;}}});
    const localDeliveryHttp = createLocalDeliveryHttp({delivery:localDelivery,signal:shutdown.signal});
    const exportFileRecovery: ExportFileRecovery=createExportFileRecovery({root,db:store.db,signal:shutdown.signal,hold:deletionGate.hold,
      guards:{isTimelineRenderRecord,readOwnedAsset:(projectId,assetId)=>readOwnedTimelineAsset(store.db,projectId,assetId)},
      assertAvailable:()=>{if(restored||candidate)throw workspaceRestoreError();if(!ownsStoreLock(store))throw new AppError('EXPORT_FILE_UNAVAILABLE','导出文件不可用。',409);},
      validateFile:(file,allowMissing)=>validateManagedFile(file,{root,allowMissing}),validateDirectory:directory=>validateManagedDirectory(directory,{root})});
    let localShotText!: LocalShotText,localShotTextHttp: HttpHandler=async()=>false,audioPreviewHttp: HttpHandler=async()=>false,continuousAudioHttp: HttpHandler=async()=>false;
    if(!candidate){
    const ordinary = services;
    const neverMutate=()=>{throw new Error('Read-only shot receipt boundary');};
    // candidate === null selects the ordinary store in this branch.
    const ordinaryStore = store as ReturnType<typeof openStore>;
    const shotReplay=createLocalMutationServices(ordinaryStore,{canonical,readOnly:true,check:neverMutate,now:neverMutate,references:{guardManualUpdate:neverMutate}});
    const shotTextDomain=createLocalShotTextDomain({db:store.db,canonical,
      replay:(projectId,input)=>shotReplay.updateShotInProject(projectId,input),
      // Domain reads cross-project ownership before this fixed consumption check;
      // the stored asset record always starts with its string id.
      validateAsset:(projectId,asset)=>validateImageConsumption(store.db,asset as Record<string, unknown> & {id: string},projectId),
      isRevisionConflict:error=>error instanceof AppError&&error.code==='REVISION_CONFLICT',
      updateShotInProject:(projectId,input)=>ordinary.updateShotInProject(projectId,input)});
    localShotText=createLocalShotText({root,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{...shotTextDomain,ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),
        isShotUpdateInput:value=>schemas['shot.update'].safeParse(value).success}});
    localShotTextHttp=createLocalShotTextHttp({shotText:localShotText,signal:shutdown.signal});
    nativeAudioPreview?.bind(ordinary.audioPreview);
    audioPreviewHttp=createTimelineAudioPreviewHttp({service:ordinary.audioPreview,nativeAdmission:nativeAudioPreview,signal:shutdown.signal,assertAvailable:()=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();}});
    continuousAudioHttp=createTimelineAudioContinuousHttp({service:ordinary.audioPreview,nativeAdmission:nativeAudioPreview,signal:shutdown.signal,assertAvailable:()=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();}});
    }
    // Desktop injects a narrow trusted-main proxy. Web mode persists only
    // nonsecret metadata here; newly entered Agent keys remain in backend RAM.
    if(!restored && !candidate){
    const ordinary = services;
    ordinary.setProjectDeletionCompanions({
      assertDeletable:projectId=>{
        if(taskRuntimeV2?.isBusy())throw new AppError('PROJECT_DELETE_BUSY','智能助理仍有请求在执行，请暂停或停止后再删除项目。',409);
        deletionGate.assertIdle(projectId);
        localDrafts!.assertProjectDeletable(projectId);localDelivery.assertProjectDeletable(projectId);localShotText.assertProjectDeletable(projectId);
      },
      removeProject:projectId=>{
        localDrafts!.removeProject(projectId);localDelivery.removeProject(projectId);localShotText.removeProject(projectId);uiPreferences!.removeProject(projectId);
      },
    });
    const editService = createAgentEditService({store: ordinaryStore, services: ordinary, ...(agentEditFault ? {fault: agentEditFault} : {})});
    // The trusted desktop proxy validates and sanitizes these values itself; the
    // local engine exposes the same dependency. createChatRuntime re-sanitizes reads.
    const chatSettings = agentSettings as unknown as AgentSettingsService;
    chatRuntime = createChatRuntime({store: ordinaryStore, agentSettings: chatSettings, authorizations:agentAuthorizations, editService, inspection: ordinary.inspection, ...(chatGateway ? {gateway: chatGateway, mode: 'simulated'} : {}), selfPort: () => listeningPort()});
    chatHttp = createChatHttp({runtime: chatRuntime});
    taskToolsV2=createAgentTaskTools({store:ordinaryStore,services:ordinary});
    taskRuntimeV2=createAgentTaskRuntime({store:ordinaryStore,agentSettings:chatSettings,authorizations:agentAuthorizations!,tools:taskToolsV2,selfPort:()=>listeningPort(),assertMutationAllowed:()=>ordinary.backups.assertMutationAllowed(),...(taskGatewayV2?{gateway:taskGatewayV2}:{})});
    taskHttpV2=createAgentTaskHttp({runtime:taskRuntimeV2,tools:taskToolsV2,assertMutationAllowed:()=>ordinary.backups.assertMutationAllowed()});
    agentDiagnosticsHttp=createAgentDiagnosticsHttp({settings:chatSettings,authorizations:agentAuthorizations!,tools:taskToolsV2,policy:()=>taskRuntimeV2!.policy(),selfPort:()=>listeningPort(),hasProject:id=>!!store.get('projects',id)});
    }
    if(restored?.schemaVersion===53&&!candidate){
      if(!agentSettings)agentSettings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{throw workspaceRestoreError();}}});
      taskRuntimeV2=createAgentTaskRuntime({store:ordinaryStore,agentSettings:agentSettings as unknown as AgentSettingsService,
        authorizations:{assertAuthorized(){throw workspaceRestoreError();},snapshot(){return {revision:0,scopes:[]};}},selfPort:()=>listeningPort(),readOnly:true});
      taskHttpV2=createAgentTaskHttp({runtime:taskRuntimeV2});
    }
    const origins = new Set<string>(), hosts = new Set<string>();
    const auth = (req: IncomingMessage): boolean => {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('mioon_session='))?.slice('mioon_session='.length);
      return equal(bearer, token) || equal(cookie, token);
    };
    let actualPort = port;
    const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        checkpoint(shutdown.signal);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
        if (!hosts.has(req.headers.host ?? '') || (req.headers.origin && !origins.has(req.headers.origin))) return json(res, 403, {ok: false, error: {code: 'ORIGIN_REJECTED', message: '本地来源校验失败'}});
        const url = new URL(String(req.url), `http://127.0.0.1:${actualPort}`);
        if (url.pathname === '/health') return json(res, 200, {ok: true, service: 'mioon', version: '0.4.0', sqlite: field(store.db.prepare('select sqlite_version() v').get(), 'v')});
        if (url.pathname === '/api/login' && req.method === 'POST') {
          const input = jsonObject(await body(req, 4096));
          checkpoint(shutdown.signal);
          if (!equal(input.token, token)) return json(res, 401, {ok: false, error: {code: 'UNAUTHORIZED', message: '访问令牌无效'}});
          res.setHeader('Set-Cookie', [`mioon_session=${token}; HttpOnly; SameSite=Strict; Path=/`, 'wb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0']);
          return json(res, 200, {ok: true});
        }
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
          if (!auth(req)) return json(res, 401, {ok: false, error: {code: 'UNAUTHORIZED', message: '请使用本地访问令牌登录'}});
          deletionGate.track(res);
        }
        const restoredTaskHistory=restored?.schemaVersion===53&&!candidate&&(url.pathname==='/api/agent/tasks/v2'||url.pathname.startsWith('/api/agent/tasks/v2/'));
        if(restored&&(!restoredTaskHistory&&isUnavailableRestoredRoute(url.pathname,req.method ?? '')||/^\/api\/video-providers(?:\/|$)/u.test(url.pathname)))throw workspaceRestoreError();
        if(candidate && /^\/api\/(?:agent|images|comfy|video-providers|timeline-audio-preview)(?:\/|$)/u.test(url.pathname))throw workspaceRestoreError();
        if(!candidate&&!restored&&req.method!=='GET'&&url.pathname.startsWith('/api/')&&url.pathname!=='/api/rpc'&&!url.pathname.startsWith('/api/workspace-backups/'))(services as OrdinaryServices).backups.assertMutationAllowed();
        if (url.pathname === '/api/version-comparison/media' && await versionComparisonMedia.handle(req, res, url)) return;
        if (url.pathname === '/api/agent/settings') {
          try {
            const context = {selfPort: listeningPort()};
            if (req.method === 'GET') return json(res, 200, {ok: true, data: sanitizeAgentSettingsResult(await agentSettings!.get(context))});
            if (req.method === 'PUT') {
              let input;
              try { input = await body(req, MAX_AGENT_SETTINGS_BYTES); }
              catch (error) { const fields = errorFields(error); return json(res, fields.status === 413 ? 413 : 400, {ok: false, error: {code: 'AGENT_SETTINGS_VALIDATION', message: 'Agent 设置请求过大或 JSON 格式无效。', details: {}, retryable: false}}); }
              checkpoint(shutdown.signal);
              return json(res, 200, {ok: true, data: sanitizeAgentSettingsResult(await agentSettings!.put(input, context))});
            }
            res.setHeader('Allow', 'GET, PUT');
            return json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '请使用 GET 或 PUT'}});
          } catch (error) {
        if(res.headersSent){res.destroy();return;}
            const safe = sanitizeAgentSettingsError(error);
            return json(res, safe.status, {ok: false, error: {code: safe.code, message: safe.message, details: {}, retryable: false}});
          }
        }
        if(url.pathname.startsWith('/api/workspace-backups/')){
          if(candidate||restored)throw workspaceRestoreError();
          const backups=(services as OrdinaryServices).backups;
          const download=/^\/api\/workspace-backups\/([a-f0-9-]{36})\/download$/iu.exec(url.pathname);
          if(download&&req.method==='GET'){
            await sendWorkspaceBackup(res,download[1],signal=>backups.exportBundle(download[1],signal),shutdown.signal);return;
          }
          if(url.pathname==='/api/workspace-backups/import'&&req.method==='POST'&&[...url.searchParams.keys()].join(',')==='requestId'){
            deletionGate.rpc(res,'workspace.backup.import',{});
            return json(res,200,{ok:true,data:await backups.importBundle(req,{requestId:url.searchParams.get('requestId')!})});
          }
          throw new AppError('VALIDATION_ERROR','无效的备份请求',400);
        }
        if (await comfyHttp(req,res,url)) return;
        if (await imageHttp(req,res,url)) return;
        if (await videoHttp(req,res,url)) return;
        if (await chatHttp?.handle(req, res, url)) return;
        if (await taskHttpV2?.handle(req,res,url)) return;
        if (await agentDiagnosticsHttp?.(req,res,url)) return;
        if (await editTasksHttp(req, res, url)) return;
        if (await localDraftHttp(req, res, url)) return;
        if (await projectPackageHttp(req, res, url)) return;
        if (await lastProjectHttp(req, res, url)) return;
        if (await localDeliveryHttp(req, res, url)) return;
        if (await exportFileRecovery.handle(req,res,url)) return;
        if (await localShotTextHttp(req, res, url)) return;
        if (await continuousAudioHttp(req, res, url)) return;
        if (await audioPreviewHttp(req, res, url)) return;
        checkpoint(shutdown.signal);
        if (url.pathname === '/api/workspace-info' && req.method === 'GET') {
          return json(res,200,{ok:true,data:await readWorkspaceInfo({root,channel:localDraftChannel,version:packageMetadata.version,tools:{ffmpeg:mediaExecutable('ffmpeg'),ffprobe:mediaExecutable('ffprobe')},signal:shutdown.signal,
            pendingProjectCleanup:restored||candidate?0:Number(field(store.db.prepare('SELECT count(*) AS n FROM project_deletion_cleanup').get(), 'n'))})});
        }
        if (url.pathname === '/api/media-tools/check' && req.method === 'POST') {
          if(restored||candidate)throw workspaceRestoreError();
          const raw=await body(req,64);
          if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length)throw new AppError('VALIDATION_ERROR','工具检测不接受路径或命令参数。',400);
          return json(res,200,{ok:true,data:await inspectMediaTools({ffmpeg:mediaExecutable('ffmpeg'),ffprobe:mediaExecutable('ffprobe')},{execute:runMedia,signal:shutdown.signal})});
        }
        if (url.pathname === '/api/ui-preferences') {
          if (req.method === 'GET') return json(res,200,{ok:true,data:uiPreferences!.get()});
          if (req.method === 'PUT') return json(res,200,{ok:true,data:uiPreferences!.put(await body(req,8192))});
          res.setHeader('Allow','GET, PUT');
          return json(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'请使用 GET 或 PUT'}});
        }
        if (url.pathname === '/api/ui-preferences/opened' && req.method === 'POST') {
          const input=jsonObject(await body(req,1024));
          if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'projectId'))
            throw new AppError('VALIDATION_ERROR','项目打开记录参数无效',400);
          uiPreferences!.markOpened(input.projectId);
          return json(res,200,{ok:true,data:uiPreferences!.get()});
        }
        const preferencesRoute = /^\/api\/workspace-preferences\/([^/]+)$/.exec(url.pathname);
        if (preferencesRoute) {
          let projectId;
          try { projectId = decodeURIComponent(preferencesRoute[1]); }
          catch { return json(res, 400, {ok: false, error: {code: 'VALIDATION_ERROR', message: '项目 ID 无效'}}); }
          if (req.method === 'GET') return json(res, 200, {ok: true, data: workspacePreferences.get(projectId)});
          if (req.method === 'PUT') {
            const input = jsonObject(await body(req, MAX_WORKSPACE_PREFERENCES_BYTES));
            checkpoint(shutdown.signal);
            return json(res, 200, {ok: true, data: await workspacePreferences.put(projectId, Object.hasOwn(input,'expectedWorkspaceOrigin')?Object.fromEntries(Object.entries(input).filter(([key])=>key!=='expectedWorkspaceOrigin')):input, {signal:shutdown.signal,...(Object.hasOwn(input,'expectedWorkspaceOrigin')?{expectedWorkspaceOrigin:input.expectedWorkspaceOrigin}:{})})});
          }
          res.setHeader('Allow', 'GET, PUT');
          return json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '请使用 GET 或 PUT'}});
        }
        if (url.pathname === '/api/rpc' && req.method === 'POST') {
          const input = jsonObject(await body(req));
          checkpoint(shutdown.signal);
          if (typeof input.operation !== 'string') return json(res, 400, {ok: false, error: {code: 'VALIDATION_ERROR', message: '缺少 operation'}});
          deletionGate.rpc(res,input.operation,input.input);
          const data = await callObservedRpc(req, res, {call: serviceCall}, input.operation, input.input || {},Object.hasOwn(input,'expectedWorkspaceOrigin')?{expectedWorkspaceOrigin:input.expectedWorkspaceOrigin}:{});
          if (res.destroyed || res.writableEnded) return;
          return json(res, 200, {ok: true, data:candidate ? publicValue(data) : data});
        }
        if (url.pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(req.method ?? '')) {
          const preview = url.searchParams.has('preview');
          const named = url.searchParams.has('exportId');
          const deliveryGuards = candidate ? createOpacityCandidateTimelineDeliveryGuards(store) : {isTimelineRenderRecord, readOwnedAsset: (projectId: string, assetId: string) => readOwnedTimelineAsset(store.db, projectId, assetId)};
          const playback = preview ? readTimelineExportPreviewMedia(store.db, url, deliveryGuards) : null;
          const delivery = named && !preview ? readTimelineDeliveryDownload(store.db, url, deliveryGuards) : null;
          const rawAsset = preview || named ? null : candidate ? readOpacityCandidateApplicationSource(store,url.pathname.slice(7)) : store.get('assets', url.pathname.slice(7));
          const asset = preview ? playback : named ? delivery : rawAsset;
          if (!asset) return json(res, 404, {ok: false, error: {code: 'NOT_FOUND', message: '素材不存在'}});
          const relativePath = field(asset, 'relativePath'), mimeType = field(asset, 'mimeType');
          if (typeof relativePath !== 'string' || typeof mimeType !== 'string') return json(res, 404, {ok: false, error: {code: 'NOT_FOUND', message: '素材不存在'}});
          let file;
          try { file = await safePath(root, relativePath); }
          catch { return json(res, 404, {ok: false, error: {code: 'FILE_UNAVAILABLE', message: '本地文件不可用。'}}); }
          const headers: Record<string, string> = {'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600'};
          if (!delivery && url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="mioon.${mimeType === 'video/mp4' ? 'mp4' : 'bin'}"`;
          try{return await files.send(req, res, {file, headers: playback ? () => timelineExportPreviewResponseHeaders(store.db, url, deliveryGuards, playback) : delivery ? () => timelineDeliveryResponseHeaders(store.db, url, deliveryGuards, delivery) : candidate ? () => {assertOpacityCandidateApplicationSource(store,asset as Record<string, unknown>);return headers;} : headers, ranges: true});}
          catch(error){if(process.env.MIOON_DEBUG_PREVIEW)console.error('PREVIEW-SEND-FAIL',(error as {code?:string}).code,(error as Error).message);throw error;}
        }
        if (url.pathname.startsWith('/api/') || req.method !== 'GET') return json(res, 404, {ok: false, error: {code: 'NOT_FOUND', message: '接口不存在'}});
        const requested = decodeURIComponent(url.pathname);
        if (requested.includes('..') || requested.includes('\\')) { res.writeHead(400).end(); return; }
        const file = path.join(dist, requested === '/' ? indexFile : requested);
        if (!file.startsWith(dist + path.sep) && file !== dist) { res.writeHead(403).end(); return; }
        return await files.send(req, res, {file, fallbackFile: path.join(dist, indexFile), headers: selected => {
          const types: Readonly<Record<string,string>> = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png'};
          return {
            'Content-Type': types[path.extname(selected)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
          };
        }});
      } catch (error) {
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) { res.destroy(); return; }
        const fields = errorFields(error);
        const status = fields.status || 500;
        json(res, status, {ok: false, error: {code: fields.code || 'INTERNAL_ERROR', message: status !== 500 ? fields.message : '操作失败，请检查输入或后端状态', details: fields.details || {}, retryable: false}});
      }
    };
    if(listen){
      server = http.createServer(handleRequest);
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, '127.0.0.1', resolve);
      });
      actualPort = listeningPort();
    }
    for (const hostname of ['127.0.0.1', 'localhost']) {
      hosts.add(`${hostname}:${actualPort}`);
      origins.add(`http://${hostname}:${actualPort}`);
    }
    if(listen)worker = startWorker(store, services, providers, {signal: shutdown.signal});
    if(listen&&!restored&&!candidate)(services as OrdinaryServices).backups.start();
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      // Fence all async RPC/worker continuations before taking any child snapshot.
      shutdown.abort();
      // Abort inference and close long-lived SSE BEFORE HTTP drain and SQLite.
      chatRuntime?.close();
      chatHttp?.close();
      taskRuntimeV2?.close();taskHttpV2?.close();
      const drain = server ? new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())) : Promise.resolve();
      const forceDrain = setTimeout(() => server?.closeAllConnections(), 3000);
      forceDrain.unref();
      try {
        await boundedShutdown(Promise.all([
          worker?.stop(), taskRuntimeV2?.drain(), candidateEditor ? candidateEditor.drain() : serviceDrain(), candidateEditor ? undefined : editTasks.drain(), files.close(), versionComparisonMedia.close(),
          terminateMediaProcesses({signal: shutdown.signal}).then(assertMediaTerminated), drain,
          !suppliedAgentSettings ? agentSettings?.close() : undefined, imageSettings?.close(), customImageSettings?.close(), videoSettings?.close(), comfySettings?.close(),
        ]), 'SERVER_STOP_TIMEOUT');
      }
      finally { clearTimeout(forceDrain); }
      taskToolsV2?.dispose();
      store.close();
    })();
    return {url: `http://127.0.0.1:${actualPort}`, port: actualPort, token, tokenFile, dataDir: root,setBackupDirectory:(directory:string)=>{if(candidate||restored||shutdown.signal.aborted)throw workspaceRestoreError();const ordinary=services as OrdinaryServices;ordinary.backups.assertMutationAllowed();return ordinary.configuration.setBackupDirectory(directory);}, close,...(!listen?{handleRequest}:{})};
  } catch (error) {
    shutdown.abort();
    chatRuntime?.close(); chatHttp?.close();
    taskRuntimeV2?.close();taskHttpV2?.close();
    const drain = server?.listening ? new Promise<void>(resolve => server!.close(() => resolve())) : Promise.resolve();
    server?.closeAllConnections();
    await boundedShutdown(Promise.all([drain, taskRuntimeV2?.drain(), files?.close(), versionComparisonMedia?.close(), worker?.stop(), candidateEditor ? candidateEditor.drain() : serviceDrain(), candidateEditor ? undefined : editTasks?.drain(), terminateMediaProcesses({signal: shutdown.signal}).then(assertMediaTerminated), !suppliedAgentSettings ? agentSettings?.close() : undefined, imageSettings?.close(), customImageSettings?.close(), videoSettings?.close(), comfySettings?.close()]), 'SERVER_STOP_TIMEOUT');
    taskToolsV2?.dispose();store.close();
    throw error;
  }
}
