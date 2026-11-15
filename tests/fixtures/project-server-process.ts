import {isProjectId} from '../../packages/contracts/src/project-file.ts';
// An explicitly owned test backend. Production CLI/HTTP/environment settings
// never expose inspectProject; this entry answers only fixed storage questions.
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ChildProcess} from 'node:child_process';
import type {InspectApplication,InspectProject} from '../../apps/server/src/index.ts';
import type {ProjectState} from '../helpers/project-state.ts';

export interface ProjectStorageSnapshot {schema?: ProjectState['schema']; databases?: string[]; rows: ProjectState['tables']; version: [number, number]}

/** Reads from this exact child, which owns its connection. Each caller gives
 * the actual project ID; no SQL or callback crosses the IPC channel. */
export function createProjectStorageReader(child: ChildProcess, application = false): (projectId: string) => Promise<ProjectStorageSnapshot> {
  const pending = new Map<string, PromiseWithResolvers<ProjectStorageSnapshot>>();
  child.on('message', (raw: unknown) => {
    const message = raw as {type?: unknown; id?: unknown; data: ProjectStorageSnapshot; error?: {code: string; message: string}}|null;
    if (!message || message.type !== 'reply' || typeof message.id !== 'string') return;
    const reply = pending.get(message.id);
    if (!reply) return;
    if (message.error) reply.reject(Object.assign(Error(message.error.message), {code: message.error.code}));
    else reply.resolve(message.data);
  });
  const exited = (): void => {
    for (const reply of pending.values()) reply.reject(Error('The backend exited before it answered the storage question'));
  };
  child.once('exit', exited);
  child.once('error', exited);
  return async (projectId: string): Promise<ProjectStorageSnapshot> => {
    if (child.exitCode !== null || child.signalCode || !child.connected) throw Error('No running backend to inspect');
    const id = randomUUID(), reply = Promise.withResolvers<ProjectStorageSnapshot>();
    pending.set(id, reply);
    const timer = setTimeout(() => reply.reject(Error('The backend did not answer the storage question within 10 seconds')), 10_000);
    try {
      child.send(application ? {type: 'app-storage', id} : {type: 'storage', id, projectId}, error => { if (error) reply.reject(error); });
      return await reply.promise;
    } finally { clearTimeout(timer); pending.delete(id); }
  };
}

export function createApplicationStorageReader(child: ChildProcess): () => Promise<ProjectStorageSnapshot> {
  const read = createProjectStorageReader(child, true);
  return () => read('');
}

/** One fixed synthetic ownership fault, on the same native connection the
 * real backend holds. No SQL, pathname, callback or arbitrary value is accepted. */
export async function corruptReplacementSourceOwner(child:ChildProcess,input:{projectId:string;assetId:string;foreignProjectId:string}):Promise<{moved:number}> {
  const id=randomUUID(),reply=Promise.withResolvers<{moved:number}>();
  const receive=(raw:unknown)=>{const message=raw as {type?:string;id?:string;data?:{moved:number};error?:{code:string;message:string}};
    if(message.type!=='reply'||message.id!==id)return;
    if(message.error)reply.reject(Object.assign(Error(message.error.message),{code:message.error.code}));else reply.resolve(message.data!);
  };
  const exit=()=>reply.reject(Error('The exact replacement fixture owner exited'));
  child.on('message',receive);child.once('exit',exit);
  const timer=setTimeout(()=>reply.reject(Error('Replacement fixture fault timed out')),10000);
  try {child.send({type:'replacement-source-owner',id,...input},error=>{if(error)reply.reject(error);});return await reply.promise;}
  finally {clearTimeout(timer);child.off('message',receive);child.off('exit',exit);}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Every caller creates and cleans this isolated directory with mkdtemp.
  // There is deliberately no fallback to the repository's ordinary data/.
  const dataDir = process.env.MIOON_DATA_DIR;
  if (!dataDir) throw Error('An owned project-server fixture directory is required');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const {startServer} = await import('../helpers/test-server.ts');
  const {comfyModuleModeFromEnvironment} = await import('../../apps/server/src/comfy-module.ts');
  const {createHeadlessAgentSecretCodec} = await import('../../apps/server/src/headless-agent-secret-codec.ts');
  const {initializeNodePrivateStorage} = await import('../../packages/node-host/src/private-storage-bootstrap.ts');
  const {readProjectState, changeMarks} = await import('../helpers/project-state.ts');
  const {withoutForeignKeys} = await import('../helpers/project-database.ts');
  const {databaseFiles} = await import('../helpers/data-file-snapshot.ts');
  await initializeNodePrivateStorage();
  let inspect: InspectProject|undefined, inspectApplication: InspectApplication|undefined;
  const service = await startServer({
    agentSecretCodecFactory: createHeadlessAgentSecretCodec,
    comfyModule: comfyModuleModeFromEnvironment(process.env.MIOON_COMFY_MODULE),
    dataDir, port: Number(process.env.PORT || 4318),
    cacheDir: process.env.MIOON_CACHE_DIR,
    projectsDir: process.env.MIOON_PROJECTS_DIR,
    distDir: process.env.MIOON_DIST_DIR || path.join(root, 'apps/web/dist'),
    token: process.env.MIOON_TOKEN,
    inspectProject: received => { inspect = received; },
    inspectApplication: received => { inspectApplication = received; },
  });
  if (process.connected) process.on('message', (raw: unknown) => {
    const message = raw as {type?: unknown; id?: unknown; projectId?: unknown;assetId?:unknown;foreignProjectId?:unknown}|null;
    if (typeof message?.id !== 'string') return;
    let reply: unknown;
    try {
      let data: ProjectStorageSnapshot;
      if(message.type==='replacement-source-owner'){
        if(!inspect||!isProjectId(message.projectId)||!isProjectId(message.assetId)||!isProjectId(message.foreignProjectId)||message.projectId===message.foreignProjectId||Object.keys(message).some(key=>!['type','id','projectId','assetId','foreignProjectId'].includes(key)))throw Error('Unsupported replacement ownership fault');
        const {projectId,assetId,foreignProjectId}=message;
        const moved=inspect(projectId,db=>withoutForeignKeys(db,()=>Number(db.prepare('UPDATE assets SET projectId=? WHERE id=? AND projectId=?').run(foreignProjectId,assetId,projectId).changes)));
        reply={type:'reply',id:message.id,data:{moved}};if(process.connected)process.send?.(reply);return;
      }
      if (message.type === 'app-storage' && Object.keys(message).every(key => ['type','id'].includes(key))) {
        if (!inspectApplication) throw Error('The server has not handed over its application connection');
        data = inspectApplication(db => {const state=readProjectState(db);return {schema:state.schema,rows:state.tables,version:changeMarks(db),databases:databaseFiles(db)};});
      } else {
        if (message.type !== 'storage' || typeof message.projectId !== 'string' || Object.keys(message).some(key => !['type', 'id', 'projectId'].includes(key))) throw Error('Unsupported project-server fixture message');
        if (!inspect) throw Error('The server has not handed over its connection');
        data = inspect(message.projectId, db => ({rows: readProjectState(db).tables, version: changeMarks(db),databases:databaseFiles(db)}));
      }
      reply = {type: 'reply', id: message.id, data};
    } catch (error) {
      const failure = error as {code?: unknown; message?: unknown}|null;
      reply = {type: 'reply', id: message.id, error: {code: failure?.code ?? 'FIXTURE_ERROR', message: String(failure?.message ?? error)}};
    }
    if (process.connected) process.send?.(reply);
  });
  console.log(`Mioon ready at ${service.url}; local token file: ${service.tokenFile}`);
  let closing: Promise<unknown>|undefined;
  const close = (): Promise<unknown> => closing ??= service.close().catch(error => {
    const fields = error as {code?: unknown; name?: unknown}|null;
    console.error('Shutdown failed:', fields?.code || fields?.name); process.exitCode = 1;
  }).finally(() => { if (process.connected) process.disconnect(); });
  process.on('SIGTERM', close); process.on('SIGINT', close); process.once('disconnect', close);
}
