import { createServices,MAX_WORKSPACE_PREFERENCES_BYTES,openStore,safePath,startWorker } from '@mioon/business';
import { MAX_AGENT_SETTINGS_BYTES } from '@mioon/business/agent/config';
import type { PublicStorage,SecretCodec,SettingsContextOptions } from '@mioon/business/agent/settings';
import { sanitizeAgentSettingsError,sanitizeAgentSettingsResult } from '@mioon/business/agent/settings';
import type { TaskGateway } from '@mioon/business/agent/task-gateway-v2';
import type { AgentTaskRuntime } from '@mioon/business/agent/task-runtime-v2';
import type { AgentTaskTools } from '@mioon/business/agent/task-tools-v2';
import type { WorkspaceStore } from '@mioon/business/db';
import { ownsStoreLock,validateWorkspaceStorage } from '@mioon/business/db';
import { createEditTasks } from '@mioon/business/edit-tasks';
import { createOwnedMediaGraphReader } from '@mioon/business/inspection';
import { onMediaProcess,terminateMediaProcesses } from '@mioon/business/media-processes';
import { run as runMedia } from '@mioon/business/media-runtime';
import type { NativeAudioPreviewAuthority } from '@mioon/business/native-audio-preview';
import { assertMediaTerminated,boundedShutdown,checkpoint } from '@mioon/business/operation-lifecycle';
import { readTimelineDeliveryDownload,readTimelineExportPreviewMedia,timelineDeliveryResponseHeaders,timelineExportPreviewResponseHeaders } from '@mioon/business/timeline-delivery-read';
import { readOwnedTimelineAsset } from '@mioon/business/timeline-sources';
import { isUnavailableRestoredRoute,workspaceRestoreError } from '@mioon/business/workspace-restore-policy';
import { getWorkspaceRestoreContext } from '@mioon/business/workspace-restore-schema';
import { AppError,isTimelineRenderRecord } from '@mioon/contracts';
import { readPrivateFile,validateManagedFile,writePrivateFileAtomic } from '@mioon/contracts/private-storage';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import type { IncomingMessage,Server,ServerResponse } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isAsyncFunction,isPromise } from 'node:util/types';
import packageMetadata from '../../../package.json' with { type: 'json' };
import type { ComfyTransportOptions } from '../../../packages/business/src/comfy/network.ts';
import type { ReviewedImageGatewayOptions } from '../../../packages/business/src/images/gateway.ts';
import { mediaExecutable } from '../../../packages/business/src/media-environment.ts';
import { inspectMediaTools } from '../../../packages/business/src/media-tool-diagnostics.ts';
import { createUiPreferences } from '../../../packages/business/src/ui-preferences.ts';
import { resolveWorkspaceActivation } from '../../../packages/business/src/workspace-backup-runtime.ts';
import type { ComfyModuleMode } from '../../../packages/contracts/src/comfy-availability.ts';
import type { WorkspaceInfo } from '../../../packages/contracts/src/workspace-info.ts';
import { isRestoredWorkspaceSchemaSince } from '../../../packages/contracts/src/workspace-schema-lineage.ts';
import { createAgentDiagnosticsHttp } from './agent-diagnostics-http.ts';
import { createAgentTaskHttp } from './agent-task-http-v2.ts';
import type { FileResponses } from './file-response.ts';
import { createFileResponses } from './file-response.ts';
import { createProjectDeletionGate } from './project-deletion-gate.ts';
import type { ProjectAddress } from './project-routes.ts';
import { assertProjectRpc,projectIdMismatch,projectNotFound,projectRouteTarget } from './project-routes.ts';
import type { ProjectRuntime } from './project-runtime.ts';
import { composeProjectRuntime, ProjectRuntimeCleanupError } from './project-runtime.ts';
import { callObservedRpc } from './rpc-observation.ts';
import { createVersionComparisonMediaHttp } from './version-comparison-media.ts';
import { sendWorkspaceBackup } from './workspace-backup-download.ts';
import { readWorkspaceInfo } from './workspace-info.ts';

const directory = path.dirname(fileURLToPath(import.meta.url));
type LocalDraftChannel = WorkspaceInfo['channel'];
type Services = ReturnType<typeof createServices>;
type OrdinaryServices = Services;
/** Cross-path transport surface shared by the ordinary and restored services. */
type ServiceCall = (operation: string, input: unknown, context?: Record<string, unknown>) => Promise<unknown>;
type ServiceDrain = () => Promise<void>;
type EditTasks = ReturnType<typeof createEditTasks>;
type VersionComparisonMedia = ReturnType<typeof createVersionComparisonMediaHttp>;
type UiPreferences = ReturnType<typeof createUiPreferences>;
type EditTasksOptions = Parameters<typeof createEditTasks>[0];
type TaskFault = NonNullable<EditTasksOptions extends {fault?: infer F} ? F : never>;
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
 * createAgentTaskRuntime re-sanitizes every read at this boundary. */
interface AgentSettingsPort {
  get(options?: SettingsContextOptions & {selfPort?: number | undefined}): Promise<unknown>;
  put(input: unknown, options?: SettingsContextOptions & {selfPort?: number | undefined}): Promise<unknown>;
  close(): unknown;
}
interface ImageNetworkSeam {lookup?: ReviewedImageGatewayOptions['lookup']; httpsRequest?: ReviewedImageGatewayOptions['httpsRequest']}
interface ComfyNetworkSeam {httpRequest: NonNullable<ComfyTransportOptions['httpRequest']>}
/** Runs `inspect` synchronously on the server's own connection and returns its
 * result. A project the server does not have fails with PROJECT_NOT_FOUND; an
 * async callback or a promised result is a TypeError, so the connection is
 * never held across an await. */
export type InspectProject = <T>(projectId: string, inspect: (db: DatabaseSync) => T) => T;
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
  /** Has no effect: nothing reads it since the v1 assistant was removed. Mio's
   * model calls go through the v2 task gateway, which tests replace with
   * `taskGatewayV2`. It is still accepted only so test fixtures that pass a
   * deny-all gateway keep compiling. It will be deleted: the W2 test rewrites
   * stop passing it, and S0 removes this option when it rewrites startServer. */
  chatGateway?: unknown;
  taskGatewayV2?: TaskGateway;
  taskFault?: TaskFault;
  /** Trusted in-process tests only; never HTTP/environment. Receives this
   * server's InspectProject once its store is open. */
  inspectProject?: (inspect: InspectProject) => void;
  localDraftChannel?: LocalDraftChannel;
  nativeAudioPreview?: NativeAudioPreviewAuthority;
}
interface ServerInstance {
  url: string;
  port: number;
  token: string;
  tokenFile: string;
  dataDir: string;
  setBackupDirectory(directory:string): unknown;
  close(): Promise<void>;
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
  return await composeServer(options);
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
  taskGatewayV2, // Trusted synthetic v2 QA injection; never HTTP/environment.
  taskFault, // Trusted durable-edit crash-boundary tests only; never HTTP/environment configuration.
  inspectProject, // Trusted in-process test inspection only; never HTTP/environment configuration.
  localDraftChannel = 'web', // Trusted desktop build identity only; never HTTP/environment configuration.
  nativeAudioPreview, // Trusted per-utility authority only; never HTTP/environment configuration.
}: ServerOptions = {}): Promise<ServerInstance> {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw Error('Invalid PORT');
  if (comfyNetwork !== undefined && (comfyNetwork === null || typeof comfyNetwork.httpRequest !== 'function')) throw Error('Invalid local ComfyUI transport');
  if (!['load','skip','not-provided'].includes(comfyModule)) throw Error('Invalid official ComfyUI module composition');
  const dist = path.resolve(distDir);
  const baseRoot=path.resolve(dataDir);
  const activation=await resolveWorkspaceActivation(baseRoot);
  const root = activation.root;
  const indexFile = 'index.html';
  const tokenFile = path.join(root, 'access-token');
  // Validate every existing managed entry before SQLite, lock creation or token
  // generation. An explicit token can override unused malformed token contents,
  // but can never bypass unsafe filesystem metadata on an existing token.
  let token = suppliedToken;
  if (suppliedToken !== undefined) validToken(suppliedToken);
  validateWorkspaceStorage(root);
  if (token === undefined) {
    const stored = readPrivateFile(tokenFile, {root, allowMissing: true, maxBytes: 4098, encoding: 'utf8'});
    // Preserve the server/client token-file whitespace normalization contract.
    if (stored !== null) token = validToken((stored as string).trim());
  }
  const store = openStore(root);
  const ordinaryStore = store as WorkspaceStore;
  const shutdown = new AbortController();
  const deletionGate=createProjectDeletionGate({subscribeMedia:onMediaProcess,signal:shutdown.signal,
    busy:()=>{throw new AppError('PROJECT_DELETE_BUSY','工作区仍有媒体、请求或文件传输在执行，请结束后再删除项目。',409);}});
  let worker: ReturnType<typeof startWorker> | undefined, server: Server | undefined, agentSettings: AgentSettingsPort | undefined,
    uiPreferences: UiPreferences | undefined,
    taskRuntimeV2: AgentTaskRuntime | undefined, taskToolsV2: AgentTaskTools | undefined,
    taskHttpV2: ReturnType<typeof createAgentTaskHttp> | undefined, agentDiagnosticsHttp:ReturnType<typeof createAgentDiagnosticsHttp>|undefined, editTasks!: EditTasks;
  let project: ProjectRuntime | undefined;
  let services!: Services;
  let serviceCall!: ServiceCall;
  let serviceDrain!: ServiceDrain;
  let files!: FileResponses, versionComparisonMedia!: VersionComparisonMedia;
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
  files = createFileResponses({signal: shutdown.signal});
  // Test inspection uses this connection, so it never meets the workspace lock.
  inspectProject?.((projectId, inspect) => {
    if (isAsyncFunction(inspect)) throw new TypeError('inspectProject requires a synchronous callback');
    if (!store.get('projects', projectId)) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404, {projectId});
    const result = inspect(store.db);
    if (isPromise(result)) { result.catch(() => {}); throw new TypeError('inspectProject requires a synchronous result'); }
    return result;
  });
  versionComparisonMedia = createVersionComparisonMediaHttp({db: store.db, root, signal: shutdown.signal,
    readGraph: projectId => createOwnedMediaGraphReader(store.db, projectId), resolvePath: safePath, createFiles: createFileResponses,
    validateFile: file => {
      const metadata = validateManagedFile(file, {root});
      // No allowMissing is passed, so an existing file must produce metadata.
      if (metadata === null) throw Object.assign(Error('本地文件不可用。'), {code: 'FILE_UNAVAILABLE', status: 404});
      return metadata;
    },
    assertAvailable: () => {
      if (getWorkspaceRestoreContext(store)) throw workspaceRestoreError();
      if (!ownsStoreLock(store)) throw Object.assign(Error('本地文件不可用。'), {code: 'FILE_UNAVAILABLE', status: 404});
    }});
    if (token === undefined) {
      token = randomBytes(32).toString('hex');
      writePrivateFileAtomic(tokenFile, token, {root, maxBytes: 4098, replace: false});
    }
    project = await composeProjectRuntime({store: ordinaryStore, shutdown, deletionGate, baseRoot, port, serverPort, listeningPort,
      ...(suppliedAgentSettings ? {agentSettings:suppliedAgentSettings} : {}),
      ...(agentSecretCodecFactory ? {agentSecretCodecFactory} : {}), ...(imageSecretCodec ? {imageSecretCodec} : {}), ...(videoSecretCodec ? {videoSecretCodec} : {}),
      ...(imageNetwork ? {imageNetwork} : {}), ...(comfyNetwork ? {comfyNetwork} : {}), comfyModule,
      ...(taskGatewayV2 ? {taskGatewayV2} : {}), ...(taskFault ? {taskFault} : {}), localDraftChannel,
      ...(nativeAudioPreview ? {nativeAudioPreview} : {}),
    });
    ({services, serviceCall, serviceDrain, agentSettings, uiPreferences,
      taskRuntimeV2, taskToolsV2, taskHttpV2, agentDiagnosticsHttp, editTasks} = project);
    const {restored, workspacePreferences, imageHttp, comfyHttp, videoHttp, editTasksHttp, localDraftHttp, lastProjectHttp,
      projectPackageHttp, localDeliveryHttp, exportFileRecovery, localShotTextHttp, audioPreviewHttp, continuousAudioHttp} = project;
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
        let url = new URL(String(req.url), `http://127.0.0.1:${actualPort}`);
        if (url.pathname === '/health') return json(res, 200, {ok: true, service: 'mioon', version: packageMetadata.version, sqlite: field(store.db.prepare('select sqlite_version() v').get(), 'v')});
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
        // A project-scoped address is served by the path it replaces, so the
        // gates below and each route's exact request checks see that path.
        let address: ProjectAddress | undefined;
        const scoped = projectRouteTarget(url.pathname);
        if (scoped) {
          if (!store.get('projects', scoped.projectId)) throw projectNotFound(scoped.projectId);
          if (url.searchParams.getAll('projectId').some(value => value !== scoped.projectId)) throw projectIdMismatch(scoped.projectId);
          const raw = String(req.url), query = raw.search(/[?#]/u);
          req.url = scoped.pathname + (query < 0 ? '' : raw.slice(query));
          url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
          address = {projectId: scoped.projectId};
        }
        const restoredTaskHistory=isRestoredWorkspaceSchemaSince(52,restored?.schemaVersion)&&(url.pathname==='/api/agent/tasks/v2'||url.pathname.startsWith('/api/agent/tasks/v2/'));
        if(restored&&(!restoredTaskHistory&&isUnavailableRestoredRoute(url.pathname,req.method ?? '')||/^\/api\/video-providers(?:\/|$)/u.test(url.pathname)))throw workspaceRestoreError();
        if(!restored&&req.method!=='GET'&&url.pathname.startsWith('/api/')&&url.pathname!=='/api/rpc'&&!url.pathname.startsWith('/api/workspace-backups/'))(services as OrdinaryServices).backups.assertMutationAllowed();
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
          if(restored)throw workspaceRestoreError();
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
        if (await imageHttp(req,res,url,address)) return;
        if (await videoHttp(req,res,url)) return;
        if (await taskHttpV2?.handle(req,res,url,address)) return;
        if (await agentDiagnosticsHttp?.(req,res,url)) return;
        if (await editTasksHttp(req, res, url, address)) return;
        if (await localDraftHttp(req, res, url, address)) return;
        if (await projectPackageHttp(req, res, url)) return;
        if (await lastProjectHttp(req, res, url)) return;
        if (await localDeliveryHttp(req, res, url, address)) return;
        if (await exportFileRecovery.handle(req,res,url)) return;
        if (await localShotTextHttp(req, res, url, address)) return;
        if (await continuousAudioHttp(req, res, url)) return;
        if (await audioPreviewHttp(req, res, url)) return;
        checkpoint(shutdown.signal);
        if (url.pathname === '/api/workspace-info' && req.method === 'GET') {
          return json(res,200,{ok:true,data:await readWorkspaceInfo({root,channel:localDraftChannel,version:packageMetadata.version,tools:{ffmpeg:mediaExecutable('ffmpeg'),ffprobe:mediaExecutable('ffprobe')},signal:shutdown.signal,
            pendingProjectCleanup:restored?0:Number(field(store.db.prepare('SELECT count(*) AS n FROM project_deletion_cleanup').get(), 'n'))})});
        }
        if (url.pathname === '/api/media-tools/check' && req.method === 'POST') {
          if(restored)throw workspaceRestoreError();
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
          if (address) assertProjectRpc(store.db, address, input.operation, input.input || {});
          deletionGate.rpc(res,input.operation,input.input);
          const data = await callObservedRpc(req, res, {call: serviceCall}, input.operation, input.input || {},Object.hasOwn(input,'expectedWorkspaceOrigin')?{expectedWorkspaceOrigin:input.expectedWorkspaceOrigin}:{});
          if (res.destroyed || res.writableEnded) return;
          return json(res, 200, {ok: true, data});
        }
        if (url.pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(req.method ?? '')) {
          const preview = url.searchParams.has('preview');
          const named = url.searchParams.has('exportId');
          const deliveryGuards = {isTimelineRenderRecord, readOwnedAsset: (projectId: string, assetId: string) => readOwnedTimelineAsset(store.db, projectId, assetId)};
          const playback = preview ? readTimelineExportPreviewMedia(store.db, url, deliveryGuards) : null;
          const delivery = named && !preview ? readTimelineDeliveryDownload(store.db, url, deliveryGuards) : null;
          const rawAsset = preview || named ? null : store.get('assets', url.pathname.slice(7));
          const asset = preview ? playback : named ? delivery : rawAsset;
          // Another project's media answers exactly as missing media does.
          if (!asset || address && field(asset, 'projectId') !== address.projectId) return json(res, 404, {ok: false, error: {code: 'NOT_FOUND', message: '素材不存在'}});
          const relativePath = field(asset, 'relativePath'), mimeType = field(asset, 'mimeType');
          if (typeof relativePath !== 'string' || typeof mimeType !== 'string') return json(res, 404, {ok: false, error: {code: 'NOT_FOUND', message: '素材不存在'}});
          let file;
          try { file = await safePath(root, relativePath); }
          catch { return json(res, 404, {ok: false, error: {code: 'FILE_UNAVAILABLE', message: '本地文件不可用。'}}); }
          const headers: Record<string, string> = {'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600'};
          if (!delivery && url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="mioon.${mimeType === 'video/mp4' ? 'mp4' : 'bin'}"`;
          try{return await files.send(req, res, {file, headers: playback ? () => timelineExportPreviewResponseHeaders(store.db, url, deliveryGuards, playback) : delivery ? () => timelineDeliveryResponseHeaders(store.db, url, deliveryGuards, delivery) : headers, ranges: true});}
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
    server = http.createServer(handleRequest);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, '127.0.0.1', resolve);
    });
    actualPort = listeningPort();
    for (const hostname of ['127.0.0.1', 'localhost']) {
      hosts.add(`${hostname}:${actualPort}`);
      origins.add(`http://${hostname}:${actualPort}`);
    }
    worker = project.startWorker();
    if(!restored)(services as OrdinaryServices).backups.start();
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      // Fence all async RPC/worker continuations before taking any child snapshot.
      shutdown.abort();
      // Abort inference and close long-lived SSE BEFORE HTTP drain and SQLite.
      taskRuntimeV2?.close();taskHttpV2?.close();
      const drain = server ? new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())) : Promise.resolve();
      const forceDrain = setTimeout(() => server?.closeAllConnections(), 3000);
      forceDrain.unref();
      try {
        await boundedShutdown(Promise.all([
          worker?.stop(), taskRuntimeV2?.drain(), serviceDrain(), editTasks.drain(), files.close(), versionComparisonMedia.close(),
          terminateMediaProcesses({signal: shutdown.signal}).then(assertMediaTerminated), drain,
          project?.closeSettings(),
        ]), 'SERVER_STOP_TIMEOUT');
      }
      finally { clearTimeout(forceDrain); }
      taskToolsV2?.dispose();
      store.close();
    })();
    return {url: `http://127.0.0.1:${actualPort}`, port: actualPort, token, tokenFile, dataDir: root,setBackupDirectory:(directory:string)=>{if(restored||shutdown.signal.aborted)throw workspaceRestoreError();const ordinary=services as OrdinaryServices;ordinary.backups.assertMutationAllowed();return ordinary.configuration.setBackupDirectory(directory);}, close};
  } catch (error) {
    shutdown.abort();
    taskRuntimeV2?.close();taskHttpV2?.close();
    const drain = server?.listening ? new Promise<void>(resolve => server!.close(() => resolve())) : Promise.resolve();
    server?.closeAllConnections();
    await boundedShutdown(Promise.all([drain, taskRuntimeV2?.drain(), files?.close(), versionComparisonMedia?.close(), worker?.stop(), serviceDrain?.(), editTasks?.drain(), terminateMediaProcesses({signal: shutdown.signal}).then(assertMediaTerminated), project?.closeSettings()]), 'SERVER_STOP_TIMEOUT');
    taskToolsV2?.dispose();
    if (!(error instanceof ProjectRuntimeCleanupError)) store.close();
    throw error;
  }
}
