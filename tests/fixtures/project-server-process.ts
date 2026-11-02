// An explicitly owned test backend. Production CLI/HTTP/environment settings
// never expose inspectProject; this entry answers only fixed storage questions.
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ChildProcess} from 'node:child_process';
import type {InspectProject} from '../../apps/server/src/index.ts';
import type {ProjectState} from '../helpers/project-state.ts';

export interface ProjectStorageSnapshot {rows: ProjectState['tables']; version: [number, number]}

/** Reads from this exact child, which owns its connection. Each caller gives
 * the actual project ID; no SQL or callback crosses the IPC channel. */
export function createProjectStorageReader(child: ChildProcess): (projectId: string) => Promise<ProjectStorageSnapshot> {
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
      child.send({type: 'storage', id, projectId}, error => { if (error) reply.reject(error); });
      return await reply.promise;
    } finally { clearTimeout(timer); pending.delete(id); }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Every caller creates and cleans this isolated directory with mkdtemp.
  // There is deliberately no fallback to the repository's ordinary data/.
  const dataDir = process.env.MIOON_DATA_DIR;
  if (!dataDir) throw Error('An owned project-server fixture directory is required');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const {startServer} = await import('../../apps/server/src/index.ts');
  const {comfyModuleModeFromEnvironment} = await import('../../apps/server/src/comfy-module.ts');
  const {createHeadlessAgentSecretCodec} = await import('../../apps/server/src/headless-agent-secret-codec.ts');
  const {initializeNodePrivateStorage} = await import('../../packages/node-host/src/private-storage-bootstrap.ts');
  const {readProjectState, changeMarks} = await import('../helpers/project-state.ts');
  await initializeNodePrivateStorage();
  let inspect: InspectProject|undefined;
  const service = await startServer({
    agentSecretCodecFactory: createHeadlessAgentSecretCodec,
    comfyModule: comfyModuleModeFromEnvironment(process.env.MIOON_COMFY_MODULE),
    dataDir, port: Number(process.env.PORT || 4318),
    cacheDir: process.env.MIOON_CACHE_DIR,
    projectsDir: process.env.MIOON_PROJECTS_DIR,
    distDir: process.env.MIOON_DIST_DIR || path.join(root, 'apps/web/dist'),
    token: process.env.MIOON_TOKEN,
    inspectProject: received => { inspect = received; },
  });
  if (process.connected) process.on('message', (raw: unknown) => {
    const message = raw as {type?: unknown; id?: unknown; projectId?: unknown}|null;
    if (typeof message?.id !== 'string') return;
    let reply: unknown;
    try {
      if (message.type !== 'storage' || typeof message.projectId !== 'string' ||
          Object.keys(message).some(key => !['type', 'id', 'projectId'].includes(key))) throw Error('Unsupported project-server fixture message');
      if (!inspect) throw Error('The server has not handed over its connection');
      const data = inspect(message.projectId, db => ({rows: readProjectState(db).tables, version: changeMarks(db)}));
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
