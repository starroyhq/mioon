import {createMioUserRules} from '@mioon/business/agent/mio-user-rules';
import {handleUserRulesHttp} from './mio-rules-http.ts';
import {MAX_WORKSPACE_PREFERENCES_BYTES} from '@mioon/business';
import {MAX_AGENT_SETTINGS_BYTES} from '@mioon/business/agent/config';
import type {PublicStorage, SecretCodec, SettingsContextOptions} from '@mioon/business/agent/settings';
import {sanitizeAgentSettingsError, sanitizeAgentSettingsResult} from '@mioon/business/agent/settings';
import type {TaskGateway} from '@mioon/business/agent/task-gateway-v2';
import {agentTaskFailure} from '@mioon/business/agent/task-runtime-v2';
import {createApplicationPolicy} from '@mioon/business/agent/application-policy-v2';
import {openAppLibrary, isAppLibraryHeld, projectFileIdentity} from '@mioon/business/app-db/index';
import {createEditTasks} from '@mioon/business/edit-tasks';
import type {NativeAudioPreviewAuthority} from '@mioon/business/native-audio-preview';
import {boundedShutdown, assertMediaTerminated} from '@mioon/business/operation-lifecycle';
import {terminateMediaProcesses} from '@mioon/business/media-processes';
import {mediaExecutable} from '@mioon/business/media-environment';
import {inspectMediaTools} from '@mioon/business/media-tool-diagnostics';
import {run as runMedia} from '@mioon/business/media-runtime';
import {acquireWorkspaceLock} from '@mioon/business/workspace-lock';
import {openProjectStore, recoverProjectFile} from '@mioon/business/project-file/index';
import {createProviderCatalog} from '@mioon/business/provider-registry';
import {listImageProfiles} from '@mioon/business/images';
import {AppError} from '@mioon/contracts';
import {readPrivateFile, writePrivateFileAtomic, validateManagedFile, validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {calculateWorkspaceScope} from '../../../packages/contracts/src/workspace-scope.ts';
import type {ProjectEntryControlPort} from '../../../packages/contracts/src/project-entry-native.ts';
import {parseProjectApiPath} from '../../../packages/contracts/src/project-file.ts';
import {agentDiagnosticSummarySchema} from '../../../packages/contracts/src/agent-diagnostic-summary.ts';
import {projectIdMismatch, isDatabaseMovedError, projectFileMoved} from './project-host/errors.ts';
import {serverAppDirectories} from './project-host/directories.ts';
import {validateApplicationStorage, createApplicationFileGuard} from './project-host/application-storage.ts';
import {createProjectHostManager} from './project-host/manager.ts';
import {createProjectBackups} from './project-host/backups.ts';
import type {ProjectHostManager} from './project-host/manager.ts';
import type {InspectProject} from './project-host/host.ts';
import {composeHostedProject} from './project-host/runtime.ts';
import type {HostedProject} from './project-host/runtime.ts';
import {createProjectCoverHttp} from './project-host/covers.ts';
import {bindProjectNativeAudio} from './project-host/native-audio.ts';
import {composeApplicationRuntime} from './application-runtime.ts';
import {createApplicationRpc} from './application-rpc.ts';
import {createInitializedProject} from './project-host/create-project.ts';
import {createProjectEntries} from './project-entries.ts';
import {createAgentDiagnosticsHttp} from './agent-diagnostics-http.ts';
import {body, json, field} from './http-json.ts';
import {callObservedRpc} from './rpc-observation.ts';
import {createFileResponses} from './file-response.ts';
import {readWorkspaceInfo} from './workspace-info.ts';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import type {IncomingMessage, Server, ServerResponse} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import {isAsyncFunction, isPromise} from 'node:util/types';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import packageMetadata from '../../../package.json' with {type: 'json'};
import type {ComfyTransportOptions} from '../../../packages/business/src/comfy/network.ts';
import type {ReviewedImageGatewayOptions} from '../../../packages/business/src/images/gateway.ts';
import type {ComfyModuleMode} from '../../../packages/contracts/src/comfy-availability.ts';
import type {WorkspaceInfo} from '../../../packages/contracts/src/workspace-info.ts';
export type {InspectProject} from './project-host/host.ts';
/** Trusted owner inspection, never an HTTP, CLI or environment surface. */
export type InspectApplication = <T>(read: (db: DatabaseSync) => T) => T;
const directory = path.dirname(fileURLToPath(import.meta.url));
type LocalDraftChannel = WorkspaceInfo['channel'];
type TaskFault = NonNullable<Parameters<typeof createEditTasks>[0]['fault']>;
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
export interface ServerOptions {
  dataDir?: string;
  cacheDir?: string;
  projectsDir?: string;
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
  /** Inert legacy fixture option. Frozen transport tests still pass their v1
   * deny-all sentinel; every real model request uses taskGatewayV2. */
  chatGateway?: unknown;
  taskGatewayV2?: TaskGateway;
  taskFault?: TaskFault;
  /** Trusted in-process tests only; never HTTP/environment. Receives this
   * server's InspectProject once its store is open. */
  inspectProject?: (inspect: InspectProject) => void;
  inspectApplication?: (inspect: InspectApplication) => void;
  /** Trusted in-process tests only; never HTTP/environment. Retains a real
   * window lease so a read-only baseline excludes idle-close bookkeeping. */
  retainProjectForTest?: (retain: (projectId: string) => Promise<() => void>) => void;
  /** In-process shutdown fixture only; the default still performs the real
   * SQLite backup/copy. No request or environment can select this port. */
  projectBackupCopyForTest?: Parameters<typeof createProjectBackups>[0]['copy'];
  localDraftChannel?: LocalDraftChannel;
  nativeAudioPreview?: NativeAudioPreviewAuthority;
}
interface ServerInstance {
  url: string;
  port: number;
  token: string;
  tokenFile: string;
  dataDir: string;
  /** Trusted utility-process capability; never dispatched from HTTP/CLI/env. */
  readonly projectEntries: ProjectEntryControlPort;
  setBackupDirectory(directory:string): unknown;
  close(): Promise<void>;
}

const validToken = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 20 || Buffer.byteLength(value, 'utf8') > 4096 || /[\r\n\0]/u.test(value)) throw Error('MIOON_TOKEN must contain at least 20 characters, at most 4096 bytes, and no line breaks or NUL bytes');
  return value;
};
const equal = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const notFound = (res: ServerResponse): void => json(res, 404, {ok: false, error: {code: 'NOT_FOUND', message: '接口不存在'}});

/** One application owner, one independent library, and one kernel connection
 * per acquired project. No legacy activation, workspace DB or backup runtime. */
export async function startServer(options: ServerOptions = {}): Promise<ServerInstance> {
  const port = options.port ?? 4318, channel = options.localDraftChannel ?? 'web';
  if (!Number.isInteger(port) || port !== 0 && (port < 1024 || port > 65535)) throw Error('Invalid PORT');
  if (options.comfyNetwork !== undefined && typeof options.comfyNetwork?.httpRequest !== 'function') throw Error('Invalid local ComfyUI transport');
  if (!['load', 'skip', 'not-provided'].includes(options.comfyModule ?? 'load')) throw Error('Invalid official ComfyUI module composition');
  if (options.token !== undefined) validToken(options.token);
  const directories = serverAppDirectories(path.resolve(options.dataDir ?? path.resolve(directory, '../../../data')), {
    ...(options.cacheDir === undefined ? {} : {cacheDir: options.cacheDir}), ...(options.projectsDir === undefined ? {} : {projectsDir: options.projectsDir}),
  });
  const root = directories.dataDir, dist = path.resolve(options.distDir ?? path.resolve(directory, '../../web/dist'));
  validateApplicationStorage(directories);
  const tokenFile = path.join(root, 'access-token');
  let token = options.token;
  if (token === undefined) {
    const stored = readPrivateFile(tokenFile, {root, allowMissing: true, maxBytes: 4098, encoding: 'utf8'});
    if (stored !== null) token = validToken((stored as string).trim());
  }
  const lock = acquireWorkspaceLock(root, {allowStale: true});
  const shutdown = new AbortController();
  const files = createFileResponses({signal: shutdown.signal});
  let library: ReturnType<typeof openAppLibrary> | undefined;
  let application: Awaited<ReturnType<typeof composeApplicationRuntime>> | undefined;
  let manager: ProjectHostManager<HostedProject> | undefined;
  let drainBackups: (() => Promise<void>) | undefined;
  let server: Server | undefined;
  const opened = new Map<string, HostedProject>();
  const selfPort = (): number | undefined => { const address = server?.address(); return address !== null && typeof address === 'object' ? address.port : undefined; };
  const listeningPort = (): number => { const result = selfPort(); if (result === undefined) throw new TypeError('The local HTTP listener is not bound to a TCP port.'); return result; };
  try {
    library = openAppLibrary({dataDir: root, findMovedRoots: [directories.projectsDir], isProjectOpen: id => manager?.status(id) !== null && manager?.status(id) !== undefined});
    const appLibrary = library;
    application = await composeApplicationRuntime(library, options, shutdown.signal, selfPort);
    const app = application;
    const assertProjectFile = createApplicationFileGuard(directories);
    const backups = createProjectBackups({directories, registry: library.registry, identity: library.projectFileIdentity, assertProjectFile, outsidePaths: library.outsidePaths, copy: options.projectBackupCopyForTest});
    drainBackups = backups.drain;
    manager = createProjectHostManager({directories, registry: library.registry, identity: library.projectFileIdentity, taskIndex: library.taskIndex,
      hooks: [backups.hooks],
      openStore: options => { assertProjectFile(options.projectFile); return openProjectStore(options); },
      maintenance: {recoverProjectFile: file => { assertProjectFile(file); return recoverProjectFile(file); }},
      recoverySnapshot: recover => assertProjectFile.withSnapshot(recover),
      factory: async context => { const runtime = await composeHostedProject(context, appLibrary, app, options, selfPort, listeningPort); opened.set(context.projectId, runtime); return runtime; },
      onEvent: event => { if ((event.type === 'closed' || event.type === 'open-failed') && event.projectId !== null) opened.delete(event.projectId); },
    });
    const projects = manager;
    if (options.nativeAudioPreview) bindProjectNativeAudio(options.nativeAudioPreview, projects);
    options.inspectProject?.(manager.inspectProject);
    options.retainProjectForTest?.(async projectId => {
      shutdown.signal.throwIfAborted();
      const lease = await projects.acquire(projectId, 'window');
      return () => lease.release();
    });
    options.inspectApplication?.(<T>(read: (db: DatabaseSync) => T): T => {
      shutdown.signal.throwIfAborted();
      if (typeof read !== 'function' || isAsyncFunction(read)) throw new TypeError('Application inspection requires a synchronous callback');
      const result = read(appLibrary.db);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof field(result, 'then') === 'function') {
        if (isPromise(result)) Promise.resolve(result).catch(() => {});
        throw new TypeError('Application inspection requires a synchronous callback');
      }
      return result;
    });
    if (token === undefined) { token = randomBytes(32).toString('hex'); writePrivateFileAtomic(tokenFile, token, {root, maxBytes: 4098, replace: false}); }
    const createProject = createInitializedProject({manager, registry: appLibrary.registry, directories,
      identity: appLibrary.projectFileIdentity, assertProjectFile});
    const projectEntries = createProjectEntries({manager, registry: appLibrary.registry, projectsDir: directories.projectsDir,
      channel, signal: shutdown.signal, createProject, readScope: () => {
        const directory = validatePrivateDirectory(root), db = validateManagedFile(appLibrary.databaseFile, {root});
        const identity = projectFileIdentity(appLibrary.databaseFile);
        if (!directory || !db || !identity || !appLibrary.db.isOpen || !isAppLibraryHeld(identity, appLibrary.db)) {
          throw new AppError('PROJECT_ENTRY_UNAVAILABLE', '应用库身份不可用', 503);
        }
        return calculateWorkspaceScope({root, channel, directory, db});
      }});
    const userRules=createMioUserRules(library,{signal:shutdown.signal});
    const appAgentHttp = (await import('./application-agent-http.ts')).createApplicationAgentHttp(library, shutdown.signal);
    const rpc = createApplicationRpc({library, app, manager, directories, backups, createProject, signal: shutdown.signal, providerList: () => createProviderCatalog({root, env: createProjectServiceEnvironment(appLibrary)}).list(),
      imageProfiles: input => listImageProfiles(app.profileDependencies, input as never), refreshSummaries: () => {
        for (const [id, runtime] of opened) {
          // A closing runtime can remain indexed while findMoved awaits I/O,
          // after its native store has already closed. Keep its cached summary.
          if (projects.status(id)?.state !== 'open') continue;
          const entry = appLibrary.registry.get(id), summary = runtime.summarize?.();
          if (entry && summary) appLibrary.registry.upsert({...entry, name: summary.name, summary: summary.summary});
        }
      }});
    const covers = createProjectCoverHttp({directories, readProject: id => library!.registry.get(id), signal: shutdown.signal});
    const policy = createApplicationPolicy(library.agentPolicy);
    const {listAgentTaskTools} = await import('@mioon/business/agent/task-tools-v2');
    const appDiagnostics = createAgentDiagnosticsHttp({settings: app.agentSettings, authorizations: app.authorizations, tools: {list: listAgentTaskTools},
      policy: policy.policy, selfPort: listeningPort, hasProject: id => appLibrary.registry.get(id) !== null});
    const hosts = new Set<string>(), origins = new Set<string>();
    const authenticated = (req: IncomingMessage): boolean => {
      const bearer = req.headers.authorization?.replace(/^Bearer /u, '');
      const cookie = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('mioon_session='))?.slice('mioon_session='.length);
      return equal(bearer, token) || equal(cookie, token);
    };
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      let relocate: (() => void) | undefined, activeProjectId: string | undefined;
      try {
        shutdown.signal.throwIfAborted();
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
        if (!hosts.has(req.headers.host ?? '') || req.headers.origin && !origins.has(req.headers.origin)) return json(res, 403, {ok: false, error: {code: 'ORIGIN_REJECTED', message: '本地来源校验失败'}});
        const url = new URL(String(req.url), `http://127.0.0.1:${listeningPort()}`);
        if (url.pathname === '/health') return json(res, 200, {ok: true, service: 'mioon', version: packageMetadata.version, sqlite: process.versions.sqlite});
        if (url.pathname === '/api/login' && req.method === 'POST') {
          const input = await body(req, 4096);
          shutdown.signal.throwIfAborted();
          if (!equal(field(input, 'token'), token)) return json(res, 401, {ok: false, error: {code: 'UNAUTHORIZED', message: '访问令牌无效'}});
          res.setHeader('Set-Cookie', [`mioon_session=${token}; HttpOnly; SameSite=Strict; Path=/`, 'wb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0']);
          return json(res, 200, {ok: true});
        }
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
          if (!authenticated(req)) return json(res, 401, {ok: false, error: {code: 'UNAUTHORIZED', message: '请使用本地访问令牌登录'}});
        }
        if (projectEntries.handle(req, res, url)) return;
        const route = parseProjectApiPath(url.pathname);
        if (route) {
          if (url.searchParams.getAll('projectId').some(value => value !== route.projectId)) throw projectIdMismatch(route.projectId);
          const lease = await projects.acquire(route.projectId, 'request');
          activeProjectId = route.projectId;
          relocate = lease.host.relocate;
          const revoked = () => { if (!res.writableEnded) res.destroy(); };
          const release = () => { res.off('finish', release); res.off('close', release); lease.signal.removeEventListener('abort', revoked); lease.release(); };
          lease.signal.addEventListener('abort', revoked, {once: true});
          res.once('finish', release); res.once('close', release);
          if (lease.signal.aborted) revoked();
          if (res.destroyed || res.writableEnded || req.aborted) { release(); return; }
          if (!await lease.host.runtime.handle({req, res, url, route, signal: lease.signal})) notFound(res);
          return;
        }
        if (url.pathname.startsWith('/api/projects/')) return notFound(res);
        if (await covers(req, res, url)) return;
        if (await appAgentHttp(req, res, url)) return;
        if (await handleUserRulesHttp({req,res,url,rules:userRules,signal:shutdown.signal})) return;
        if (url.pathname === '/api/agent/diagnostics') {
          const id = url.searchParams.get('projectId');
          // The synchronous lease admission must not wait for an exclusive
          // close and then reopen a project merely for diagnostics.
          const lease = id !== null && projects.status(id)?.state === 'open' ? projects.tryAcquireOpen(id, 'request') : null;
          try { await (lease?.host.runtime.project.agentDiagnosticsHttp ?? appDiagnostics)(req, res, url); }
          finally { lease?.release(); }
          return;
        }
        if (url.pathname === '/api/agent/settings') {
          try {
            const context = {selfPort: listeningPort()};
            if (req.method === 'GET') return json(res, 200, {ok: true, data: sanitizeAgentSettingsResult(await app.agentSettings.get(context))});
            if (req.method === 'PUT') {
              let input;
              try { input = await body(req, MAX_AGENT_SETTINGS_BYTES); }
              catch (error) { return json(res, field(error, 'status') === 413 ? 413 : 400, {ok: false, error: {code: 'AGENT_SETTINGS_VALIDATION', message: 'Agent 设置请求过大或 JSON 格式无效。', details: {}, retryable: false}}); }
              shutdown.signal.throwIfAborted();
              return json(res, 200, {ok: true, data: sanitizeAgentSettingsResult(await app.agentSettings.put(input, context))});
            }
            res.setHeader('Allow', 'GET, PUT'); return json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '请使用 GET 或 PUT'}});
          } catch (error) { const safe = sanitizeAgentSettingsError(error); return json(res, safe.status, {ok: false, error: {code: safe.code, message: safe.message, details: {}, retryable: false}}); }
        }
        if (url.pathname === '/api/images/settings' || url.pathname === '/api/images/custom-settings') { await app.imageHttp(req, res, url); return; }
        if (await app.comfyHttp(req, res, url) || await app.videoHttp(req, res, url) || await app.lastProjectHttp(req, res, url)) return;
        if (url.pathname === '/api/workspace-info' && req.method === 'GET') return json(res, 200, {ok: true, data: await readWorkspaceInfo({root, channel, version: packageMetadata.version, tools: {ffmpeg: mediaExecutable('ffmpeg'), ffprobe: mediaExecutable('ffprobe')}, signal: shutdown.signal})});
        if (url.pathname === '/api/media-tools/check' && req.method === 'POST') {
          const input = await body(req, 64);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new AppError('VALIDATION_ERROR', '工具检测不接受路径或命令参数。', 400);
          return json(res, 200, {ok: true, data: await inspectMediaTools({ffmpeg: mediaExecutable('ffmpeg'), ffprobe: mediaExecutable('ffprobe')}, {execute: runMedia, signal: shutdown.signal})});
        }
        if (url.pathname === '/api/ui-preferences') {
          if (req.method === 'GET') return json(res, 200, {ok: true, data: app.ui.get()});
          if (req.method === 'PUT') return json(res, 200, {ok: true, data: app.ui.put(await body(req, 8192))});
          res.setHeader('Allow', 'GET, PUT'); return json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '请使用 GET 或 PUT'}});
        }
        if (url.pathname === '/api/ui-preferences/opened' && req.method === 'POST') {
          const input = await body(req, 1024);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join() !== 'projectId') throw new AppError('VALIDATION_ERROR', '项目打开记录参数无效', 400);
          const id = field(input, 'projectId');
          app.ui.markOpened(id);
          const preferences = app.ui.get();
          if (typeof id === 'string') {
            const entry = appLibrary.registry.get(id), lastOpenedAt = preferences.recentOpened[id];
            if (entry && lastOpenedAt) appLibrary.registry.upsert({...entry, lastOpenedAt});
          }
          return json(res, 200, {ok: true, data: preferences});
        }
        const preferences = /^\/api\/workspace-preferences\/([^/]+)$/u.exec(url.pathname);
        if (preferences) {
          let id: string;
          try { id = decodeURIComponent(preferences[1]!); } catch { throw new AppError('VALIDATION_ERROR', '项目 ID 无效', 400); }
          if (req.method === 'GET') return json(res, 200, {ok: true, data: app.preferences.get(id)});
          if (req.method === 'PUT') {
            const input = await body(req, MAX_WORKSPACE_PREFERENCES_BYTES);
            const record = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
            const payload = record && Object.hasOwn(record, 'expectedWorkspaceOrigin') ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'expectedWorkspaceOrigin')) : input;
            return json(res, 200, {ok: true, data: app.preferences.put(id, payload, {signal: shutdown.signal})});
          }
          res.setHeader('Allow', 'GET, PUT'); return json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '请使用 GET 或 PUT'}});
        }
        if (url.pathname === '/api/rpc' && req.method === 'POST') {
          const input = await body(req) as Record<string, unknown>;
          if (!input || typeof input.operation !== 'string') throw new AppError('VALIDATION_ERROR', '缺少 operation', 400);
          const data = await callObservedRpc(req, res, rpc, input.operation, input.input || {});
          if (!res.destroyed && !res.writableEnded) json(res, 200, {ok: true, data});
          return;
        }
        if (url.pathname.startsWith('/api/workspace-backups/')) throw new AppError('RESTORE_OPERATION_UNAVAILABLE', '工作区备份和恢复尚未接入项目文件布局。', 409);
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || req.method !== 'GET') return notFound(res);
        const requested = decodeURIComponent(url.pathname);
        if (requested.includes('..') || requested.includes('\\')) { res.writeHead(400).end(); return; }
        const file = path.join(dist, requested === '/' ? 'index.html' : requested);
        if (!file.startsWith(dist + path.sep) && file !== dist) { res.writeHead(403).end(); return; }
        await files.send(req, res, {file, fallbackFile: path.join(dist, 'index.html'), headers: selected => ({
          'Content-Type': ({'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png'} as Readonly<Record<string, string>>)[path.extname(selected)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache',
        })});
      } catch (caught) {
        let error = caught;
        if (relocate && activeProjectId && (isDatabaseMovedError(error) || field(error, 'code') === 'PROJECT_FILE_MOVED')) { relocate(); error = projectFileMoved(activeProjectId); }
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) { res.destroy(); return; }
        const status = typeof field(error, 'status') === 'number' ? field(error, 'status') as number : 500;
        json(res, status, {ok: false, error: {code: field(error, 'code') || 'INTERNAL_ERROR', message: status !== 500 ? field(error, 'message') : '操作失败，请检查输入或后端状态', details: field(error, 'details') || {}, retryable: false}});
      }
    };
    const restored = await manager.restore();
    const restorationTimers = new Set<ReturnType<typeof setInterval>>();
    for (const lease of restored.leases) {
      const timer = setInterval(() => {
        if (lease.signal.aborted || lease.host.runtime.unfinishedTasks?.().length === 0) {
          clearInterval(timer); restorationTimers.delete(timer); lease.release();
        }
      }, 1000);
      timer.unref(); restorationTimers.add(timer);
    }
    server = http.createServer(handle);
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(port, '127.0.0.1', resolve); });
    const actualPort = listeningPort();
    for (const hostname of ['127.0.0.1', 'localhost']) { hosts.add(`${hostname}:${actualPort}`); origins.add(`http://${hostname}:${actualPort}`); }
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      shutdown.abort();
      for (const timer of restorationTimers) clearInterval(timer);
      const drain = new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      const force = setTimeout(() => server?.closeAllConnections(), 3000); force.unref();
      try {
        await boundedShutdown(Promise.all([projects.closeAll(), files.close(), drain, backups.drain()]), 'SERVER_STOP_TIMEOUT');
        await boundedShutdown(Promise.all([terminateMediaProcesses({signal: shutdown.signal}).then(assertMediaTerminated), app.close()]), 'SERVER_STOP_TIMEOUT');
      } finally { clearTimeout(force); }
      appLibrary.close();
      if (!lock.release()) throw new Error('Application lock cleanup could not be confirmed');
    })();
    return {url: `http://127.0.0.1:${actualPort}`, port: actualPort, token, tokenFile, dataDir: root, projectEntries: projectEntries.control,
      setBackupDirectory: directory => { shutdown.signal.throwIfAborted(); return (awaitConfiguration(appLibrary)).setBackupDirectory(directory); }, close};
  } catch (error) {
    shutdown.abort(); server?.closeAllConnections();
    const drain = server?.listening ? new Promise<void>(resolve => server!.close(() => resolve())) : Promise.resolve();
    await boundedShutdown(Promise.all([drain, manager?.closeAll(), files.close(), drainBackups?.()]), 'SERVER_STOP_TIMEOUT');
    await boundedShutdown(Promise.all([terminateMediaProcesses({signal: shutdown.signal}).then(assertMediaTerminated), application?.close()]), 'SERVER_STOP_TIMEOUT');
    library?.close(); lock.release(); throw error;
  }
}

import {createProjectServiceApplication} from '@mioon/business/project-service-application';
function awaitConfiguration(library: NonNullable<ReturnType<typeof openAppLibrary>>) { return createProjectServiceApplication(library).configuration; }
function createProjectServiceEnvironment(library: NonNullable<ReturnType<typeof openAppLibrary>>) { return awaitConfiguration(library).environment(); }
