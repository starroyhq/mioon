import {createTimelineAudioPreviewHttp} from './timeline-audio-preview-http.ts';
import {createTimelineAudioContinuousHttp} from './timeline-audio-continuous-http.ts';
import {readTimelineDeliveryDownload, timelineDeliveryResponseHeaders, readTimelineExportPreviewMedia, timelineExportPreviewResponseHeaders} from '@mioon/business/timeline-delivery-read';
import {readOwnedTimelineAsset} from '@mioon/business/timeline-sources';
import {isTimelineRenderRecord, isTimelineMutationResponse, hasRequestNotAppliedProof, schemas, publicValue, AppError} from '@mioon/contracts';
import {getWorkspaceRestoreContext} from '@mioon/business/workspace-restore-schema';
import {isUnavailableRestoredRoute,workspaceRestoreError} from '@mioon/business/workspace-restore-policy';
import http from 'node:http';
import {createChatRuntime} from '@mioon/business/agent/chat-runtime';
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
import {createLocalDeliveryHttp} from './local-delivery-http.ts';
import {createChatHttp} from './chat-http.mjs';
import {createEditTasksHttp} from './edit-tasks-http.mjs';
import {createImageHttp} from './image-http.mjs';
import {createComfyHttp} from './comfy-http.mjs';
import {createComfySettings} from '@mioon/business/comfy/settings';
import {composeOfficialComfyModule} from './comfy-module.ts';
import {createComfyConnector} from '@mioon/business/comfy/connector';
import {createImageSettings,createCustomImageSettings} from '@mioon/business/images/settings';
import {createImageSettingsFile,createCustomImageSettingsFile} from '@mioon/business/images/settings-file';
import {createLiveImageGateway,createCompatibleImageGateway} from '@mioon/business/images/gateway';
import {createFileResponses} from './file-response.mjs';
import {callObservedRpc} from './rpc-observation.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createAgentSettings, sanitizeAgentSettingsError, sanitizeAgentSettingsResult} from '@mioon/business/agent/settings';
import {createAgentSettingsFile} from '@mioon/business/agent/settings-file';
import {MAX_AGENT_SETTINGS_BYTES} from '@mioon/business/agent/config';
import {openStore, createServices, startWorker, safePath, createProviderRegistry, createWorkspacePreferences, MAX_WORKSPACE_PREFERENCES_BYTES} from '@mioon/business';
import {validateWorkspaceStorage,ownsStoreLock} from '@mioon/business/db';
import {readPrivateFile, writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
import {assertMediaTerminated, boundedShutdown, checkpoint} from '@mioon/business/operation-lifecycle';
import {terminateMediaProcesses} from '@mioon/business/media-processes';

const directory = path.dirname(fileURLToPath(import.meta.url));
const validToken = value => {
  if (typeof value !== 'string' || value.length < 20 || Buffer.byteLength(value, 'utf8') > 4096 || /[\r\n\0]/.test(value)) {
    throw Error('MIOON_TOKEN must contain at least 20 characters, at most 4096 bytes, and no line breaks or NUL bytes');
  }
  return value;
};
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const json = (res, status, data) => {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
};
async function body(req, max = 42 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
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
export async function startServer({
  dataDir = path.resolve(directory, '../../../data'),
  port = 4318,
  distDir = path.resolve(directory, '../../web/dist'),
  token: suppliedToken,
  agentSettings: suppliedAgentSettings,
  imageSecretCodec, // Trusted desktop main codec only; never supplied by HTTP.
  imageNetwork, // Trusted synthetic DNS/HTTPS fixture only; never HTTP/environment.
  comfyNetwork, // Trusted synthetic HTTP fixture only; never HTTP/environment.
  comfyModule = 'load', // Trusted launcher/distribution composition, never HTTP/RPC input.
  chatGateway, // Trusted synthetic QA injection; never configurable through HTTP or environment.
  agentEditFault, // Trusted crash-boundary tests only; never HTTP/environment configuration.
  taskFault, // Trusted durable-edit crash-boundary tests only; never HTTP/environment configuration.
  localDraftChannel = 'web', // Trusted desktop build identity only; never HTTP/environment configuration.
  nativeAudioPreview, // Trusted per-utility authority only; never HTTP/environment configuration.

} = {}) {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw Error('Invalid PORT');
  if (comfyNetwork !== undefined && (comfyNetwork === null || typeof comfyNetwork.httpRequest !== 'function')) throw Error('Invalid local ComfyUI transport');
  if (!['load','skip','not-provided'].includes(comfyModule)) throw Error('Invalid official ComfyUI module composition');
  const root = path.resolve(dataDir), dist = path.resolve(distDir);
  if (suppliedToken !== undefined) validToken(suppliedToken);
  const tokenFile = path.join(root, 'access-token');
  // Validate every existing managed entry before SQLite, lock creation or token
  // generation. An explicit token can override unused malformed token contents,
  // but can never bypass unsafe filesystem metadata on an existing token.
  validateWorkspaceStorage(root);
  let token = suppliedToken;
  if (token === undefined) {
    const stored = readPrivateFile(tokenFile, {root, allowMissing: true, maxBytes: 4098, encoding: 'utf8'});
    // Preserve the server/client token-file whitespace normalization contract.
    if (stored !== null) token = validToken(stored.trim());
  }
  const store = openStore(root);
  const shutdown = new AbortController();
  let worker, server, agentSettings, imageSettings, customImageSettings, comfySettings, chatRuntime, chatHttp, services, editTasks;
  const files = createFileResponses({signal: shutdown.signal});
  try {
    if (token === undefined) {
      token = randomBytes(32).toString('hex');
      writePrivateFileAtomic(tokenFile, token, {root, maxBytes: 4098, replace: false});
    }
    const restored=getWorkspaceRestoreContext(store);
    const providers = restored?new Map():createProviderRegistry({db: store.db, root});
    let imageHttp=async()=>false,comfyHttp=async()=>false;
    if(!restored){
    imageSettings = await createImageSettings({persistence:createImageSettingsFile({directory:path.join(root,'image-settings'),privateRoot:root}),
      ...(imageSecretCodec?{secretCodec:imageSecretCodec,storage:()=>imageSecretCodec.storage()}: {})});
    customImageSettings = await createCustomImageSettings({persistence:createCustomImageSettingsFile({directory:path.join(root,'image-settings'),privateRoot:root}),
      ...(imageSecretCodec?{secretCodec:imageSecretCodec,storage:()=>imageSecretCodec.storage()}: {})});
    // Evaluate at every real I/O boundary, including desktop's port:0 binding.
    // This process knows its backend listener, not unrelated frontend processes.
    const comfyReservedPorts = () => new Set([port, server?.address()?.port].filter(value => Number.isInteger(value) && value > 0));
    comfySettings = await createComfySettings({directory:path.join(root,'comfy-settings'),privateRoot:root,reservedPorts:comfyReservedPorts});
    const {connector:comfyConnector,availability:comfyModuleAvailability} = composeOfficialComfyModule(comfyModule,()=>createComfyConnector({reservedPorts:comfyReservedPorts,...(comfyNetwork ? {networkDeps:{httpRequest:comfyNetwork.httpRequest}} : {})}));
    services = createServices(store, providers, {signal: shutdown.signal,imageOptions:{settings:imageSettings,liveGateway:createLiveImageGateway({settings:imageSettings,...imageNetwork}),customSettings:customImageSettings,customGateway:createCompatibleImageGateway({settings:customImageSettings,...imageNetwork}),comfySettings,comfyConnector,comfyModuleAvailability}});
    imageHttp=createImageHttp({settings:imageSettings,customSettings:customImageSettings,approve:services.imageApproval,reject:services.imageRejection,signal:shutdown.signal});
    comfyHttp=createComfyHttp({settings:comfySettings,connector:comfyConnector,availability:comfyModuleAvailability,signal:shutdown.signal});
    }else services=createServices(store,providers,{signal:shutdown.signal});
    editTasks = createEditTasks({store, services, ...(taskFault ? {fault: taskFault} : {})});
    // openStore already owns the exclusive workspace lock. Startup only
    // reconciles durable evidence and never dispatches a prepared edit.
    await editTasks.reconcileStartup();
    const editTasksHttp = createEditTasksHttp({tasks: editTasks, signal: shutdown.signal});
    const workspacePreferences = createWorkspacePreferences(store);
    const localDrafts = createLocalDrafts({root,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),
        readTimeline:projectId=>createTimelineRecoveryBoundary(store.db,{projectId}).read(),
        readClipAsset:(projectId,clip)=>createTimelineRecoveryBoundary(store.db,{projectId}).clipSource(clip)}});
    const localDraftHttp = createLocalDraftHttp({drafts:localDrafts,signal:shutdown.signal});
    const lastProject = createLastProject({root,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),
        readProject:projectId=>readLastProjectTarget(store.db,projectId)}});
    const lastProjectHttp = createLastProjectHttp({lastProject,signal:shutdown.signal});
    const localDelivery = createLocalDelivery({root,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),
        readTimeline:projectId=>createTimelineRecoveryBoundary(store.db,{projectId}).read({sourceSemantics:false}),
        isRenderInput:value=>schemas['timeline.render'].safeParse(value).success,
        isRenderResponse:(input,value)=>isTimelineMutationResponse('timeline.render',input,value),
        isNotApplied:(input,error)=>hasRequestNotAppliedProof(error,input,{operation:'timeline.render'}),
        readReceipt:input=>{
          const saved=readTimelineReceipt(store.db,input,'timeline.render');
          if(!saved)return null;
          if(saved.requestHash!==hash({operation:'timeline.render',input}))throw new AppError('IDEMPOTENCY_CONFLICT','原导出请求身份与内容不一致。',409);
          return publicValue(createTimelineRecoveryBoundary(store.db,input).replay('timeline.render',saved.response));
        },
        render:input=>services.call('timeline.render',input)}});
    const localDeliveryHttp = createLocalDeliveryHttp({delivery:localDelivery,signal:shutdown.signal});
    const neverMutate=()=>{throw new Error('Read-only shot receipt boundary');};
    const shotReplay=createLocalMutationServices(store,{canonical,readOnly:true,check:neverMutate,now:neverMutate,references:{guardManualUpdate:neverMutate}});
    const shotTextDomain=createLocalShotTextDomain({db:store.db,canonical,
      replay:(projectId,input)=>shotReplay.updateShotInProject(projectId,input),
      validateAsset:(projectId,asset)=>validateImageConsumption(store.db,asset,projectId),
      isRevisionConflict:error=>error instanceof AppError&&error.code==='REVISION_CONFLICT',
      updateShotInProject:(projectId,input)=>services.updateShotInProject(projectId,input)});
    const localShotText=createLocalShotText({root,channel:localDraftChannel,signal:shutdown.signal,
      storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{...shotTextDomain,ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),
        isShotUpdateInput:value=>schemas['shot.update'].safeParse(value).success}});
    const localShotTextHttp=createLocalShotTextHttp({shotText:localShotText,signal:shutdown.signal});
    nativeAudioPreview?.bind(services.audioPreview);
    const audioPreviewHttp=createTimelineAudioPreviewHttp({service:services.audioPreview,nativeAdmission:nativeAudioPreview,signal:shutdown.signal,assertAvailable:()=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();}});
    const continuousAudioHttp=createTimelineAudioContinuousHttp({service:services.audioPreview,nativeAdmission:nativeAudioPreview,signal:shutdown.signal,assertAvailable:()=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();}});
    // Desktop injects a narrow trusted-main proxy. Web mode persists only
    // nonsecret metadata here; newly entered Agent keys remain in backend RAM.
    if(!restored){
    agentSettings = suppliedAgentSettings || await createAgentSettings({
      persistence: createAgentSettingsFile({directory: path.join(root, 'agent-settings')}),
    });
    const editService = createAgentEditService({store, services, ...(agentEditFault ? {fault: agentEditFault} : {})});
    chatRuntime = createChatRuntime({store, agentSettings, editService, inspection: services.inspection, ...(chatGateway ? {gateway: chatGateway, mode: 'simulated'} : {}), selfPort: () => server.address()?.port});
    chatHttp = createChatHttp({runtime: chatRuntime});
    }
    const origins = new Set(), hosts = new Set();
    const auth = req => {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('mioon_session='))?.slice('mioon_session='.length);
      return equal(bearer, token) || equal(cookie, token);
    };
    server = http.createServer(async (req, res) => {
      try {
        checkpoint(shutdown.signal);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
        if (!hosts.has(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) return json(res, 403, {ok: false, error: {code: 'ORIGIN_REJECTED', message: '本地来源校验失败'}});
        const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
        if (url.pathname === '/health') return json(res, 200, {ok: true, service: 'mioon', version: '0.4.0', sqlite: store.db.prepare('select sqlite_version() v').get().v});
        if (url.pathname === '/api/login' && req.method === 'POST') {
          const input = await body(req, 4096);
          checkpoint(shutdown.signal);
          if (!equal(input.token, token)) return json(res, 401, {ok: false, error: {code: 'UNAUTHORIZED', message: '访问令牌无效'}});
          res.setHeader('Set-Cookie', [`mioon_session=${token}; HttpOnly; SameSite=Strict; Path=/`, 'wb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0']);
          return json(res, 200, {ok: true});
        }
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
          if (!auth(req)) return json(res, 401, {ok: false, error: {code: 'UNAUTHORIZED', message: '请使用本地访问令牌登录'}});
        }
        if(restored&&isUnavailableRestoredRoute(url.pathname,req.method))throw workspaceRestoreError();
        if (url.pathname === '/api/agent/settings') {
          try {
            const context = {selfPort: server.address().port};
            if (req.method === 'GET') return json(res, 200, {ok: true, data: sanitizeAgentSettingsResult(await agentSettings.get(context))});
            if (req.method === 'PUT') {
              let input;
              try { input = await body(req, MAX_AGENT_SETTINGS_BYTES); }
              catch (error) { return json(res, error.status === 413 ? 413 : 400, {ok: false, error: {code: 'AGENT_SETTINGS_VALIDATION', message: 'Agent 设置请求过大或 JSON 格式无效。', details: {}, retryable: false}}); }
              checkpoint(shutdown.signal);
              return json(res, 200, {ok: true, data: sanitizeAgentSettingsResult(await agentSettings.put(input, context))});
            }
            res.setHeader('Allow', 'GET, PUT');
            return json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '请使用 GET 或 PUT'}});
          } catch (error) {
            const safe = sanitizeAgentSettingsError(error);
            return json(res, safe.status, {ok: false, error: {code: safe.code, message: safe.message, details: {}, retryable: false}});
          }
        }
        if (await comfyHttp(req,res,url)) return;
        if (await imageHttp(req,res,url)) return;
        if (await chatHttp?.handle(req, res, url)) return;
        if (await editTasksHttp(req, res, url)) return;
        if (await localDraftHttp(req, res, url)) return;
        if (await lastProjectHttp(req, res, url)) return;
        if (await localDeliveryHttp(req, res, url)) return;
        if (await localShotTextHttp(req, res, url)) return;
        if (await continuousAudioHttp(req, res, url)) return;
        if (await audioPreviewHttp(req, res, url)) return;
        checkpoint(shutdown.signal);
        const preferencesRoute = /^\/api\/workspace-preferences\/([^/]+)$/.exec(url.pathname);
        if (preferencesRoute) {
          let projectId;
          try { projectId = decodeURIComponent(preferencesRoute[1]); }
          catch { return json(res, 400, {ok: false, error: {code: 'VALIDATION_ERROR', message: '项目 ID 无效'}}); }
          if (req.method === 'GET') return json(res, 200, {ok: true, data: workspacePreferences.get(projectId)});
          if (req.method === 'PUT') {
            const input = await body(req, MAX_WORKSPACE_PREFERENCES_BYTES);
            checkpoint(shutdown.signal);
            return json(res, 200, {ok: true, data: await workspacePreferences.put(projectId, Object.hasOwn(input,'expectedWorkspaceOrigin')?Object.fromEntries(Object.entries(input).filter(([key])=>key!=='expectedWorkspaceOrigin')):input, {signal:shutdown.signal,...(Object.hasOwn(input,'expectedWorkspaceOrigin')?{expectedWorkspaceOrigin:input.expectedWorkspaceOrigin}:{})})});
          }
          res.setHeader('Allow', 'GET, PUT');
          return json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '请使用 GET 或 PUT'}});
        }
        if (url.pathname === '/api/rpc' && req.method === 'POST') {
          const input = await body(req);
          checkpoint(shutdown.signal);
          if (typeof input.operation !== 'string') return json(res, 400, {ok: false, error: {code: 'VALIDATION_ERROR', message: '缺少 operation'}});
          const data = await callObservedRpc(req, res, services, input.operation, input.input || {},Object.hasOwn(input,'expectedWorkspaceOrigin')?{expectedWorkspaceOrigin:input.expectedWorkspaceOrigin}:{});
          if (res.destroyed || res.writableEnded) return;
          return json(res, 200, {ok: true, data});
        }
        if (url.pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(req.method)) {
          const preview = url.searchParams.has('preview');
          const named = url.searchParams.has('exportId');
          const deliveryGuards = {isTimelineRenderRecord, readOwnedAsset: (projectId, assetId) => readOwnedTimelineAsset(store.db, projectId, assetId)};
          const playback = preview ? readTimelineExportPreviewMedia(store.db, url, deliveryGuards) : null;
          const delivery = named && !preview ? readTimelineDeliveryDownload(store.db, url, deliveryGuards) : null;
          const asset = preview ? playback : named ? delivery : store.get('assets', url.pathname.slice(7));
          if (!asset) return json(res, 404, {ok: false, error: {code: 'NOT_FOUND', message: '素材不存在'}});
          let file;
          try { file = await safePath(root, asset.relativePath); }
          catch { return json(res, 404, {ok: false, error: {code: 'FILE_UNAVAILABLE', message: '本地文件不可用。'}}); }
          const headers = {'Content-Type': asset.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600'};
          if (!delivery && url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="mioon.${asset.mimeType === 'video/mp4' ? 'mp4' : 'bin'}"`;
          return await files.send(req, res, {file, headers: playback ? () => timelineExportPreviewResponseHeaders(store.db, url, deliveryGuards, playback) : delivery ? () => timelineDeliveryResponseHeaders(store.db, url, deliveryGuards, delivery) : headers, ranges: true});
        }
        if (url.pathname.startsWith('/api/') || req.method !== 'GET') return json(res, 404, {ok: false, error: {code: 'NOT_FOUND', message: '接口不存在'}});
        const requested = decodeURIComponent(url.pathname);
        if (requested.includes('..') || requested.includes('\\')) return res.writeHead(400).end();
        const file = path.join(dist, requested === '/' ? 'index.html' : requested);
        if (!file.startsWith(dist + path.sep) && file !== dist) return res.writeHead(403).end();
        return await files.send(req, res, {file, fallbackFile: path.join(dist, 'index.html'), headers: selected => ({
          'Content-Type': {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png'}[path.extname(selected)] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        })});
      } catch (error) {
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) return res.destroy();
        json(res, error.status || 500, {ok: false, error: {code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : '操作失败，请检查输入或后端状态', details: error.details || {}, retryable: false}});
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const actualPort = server.address().port;
    for (const hostname of ['127.0.0.1', 'localhost']) {
      hosts.add(`${hostname}:${actualPort}`);
      origins.add(`http://${hostname}:${actualPort}`);
    }
    worker = startWorker(store, services, providers, {signal: shutdown.signal});
    let closing;
    const close = () => closing ??= (async () => {
      // Fence all async RPC/worker continuations before taking any child snapshot.
      shutdown.abort();
      // Abort inference and close long-lived SSE BEFORE HTTP drain and SQLite.
      chatRuntime?.close();
      chatHttp?.close();
      const drain = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const forceDrain = setTimeout(() => server.closeAllConnections(), 3000);
      forceDrain.unref();
      try {
        await boundedShutdown(Promise.all([
          worker.stop(), services.drain(), editTasks.drain(), files.close(),
          terminateMediaProcesses({signal: shutdown.signal}).then(assertMediaTerminated), drain,
          !suppliedAgentSettings ? agentSettings?.close() : undefined, imageSettings?.close(), customImageSettings?.close(), comfySettings?.close(),
        ]), 'SERVER_STOP_TIMEOUT');
      }
      finally { clearTimeout(forceDrain); }
      store.close();
    })();
    return {url: `http://127.0.0.1:${actualPort}`, port: actualPort, token, tokenFile, dataDir: root, close};
  } catch (error) {
    shutdown.abort();
    chatRuntime?.close(); chatHttp?.close();
    const drain = server?.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    server?.closeAllConnections();
    await boundedShutdown(Promise.all([drain, files.close(), worker?.stop(), services?.drain(), editTasks?.drain(), terminateMediaProcesses({signal: shutdown.signal}).then(assertMediaTerminated), !suppliedAgentSettings ? agentSettings?.close() : undefined, imageSettings?.close(), customImageSettings?.close(), comfySettings?.close()]), 'SERVER_STOP_TIMEOUT');
    store.close();
    throw error;
  }
}
