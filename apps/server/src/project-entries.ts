import {randomUUID} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import path from 'node:path';
import {AppError} from '../../../packages/contracts/src/app-error.ts';
import {projectEntriesResponseSchema, PROJECT_ENTRY_LIMITS} from '../../../packages/contracts/src/project-entry.ts';
import type {ProjectEntriesResponse} from '../../../packages/contracts/src/project-entry.ts';
import {
  projectEntryCreateInputSchema, projectEntryOpenPathInputSchema, projectEntryAcquireInputSchema,
  projectEntryReleaseInputSchema, projectEntryWindowSchema,
} from '../../../packages/contracts/src/project-entry-native.ts';
import type {ProjectEntryControlPort, ProjectEntryWindow, ProjectEntryWindowRevoked, ProjectEntryCreateInput} from '../../../packages/contracts/src/project-entry-native.ts';
import type {RecentProject} from '../../../packages/contracts/src/project-registry.ts';
import type {ProjectHostManager} from './project-host/manager.ts';
import type {ProjectHostRuntime, ProjectLease} from './project-host/host.ts';
import type {ProjectRegistryPort} from './project-host/ports.ts';
import {projectHostError} from './project-host/errors.ts';

interface WindowSlot<Runtime extends ProjectHostRuntime> {
  readonly key: string;
  readonly promise: Promise<ProjectEntryWindow>;
  lease: ProjectLease<Runtime> | null;
  revoke: (() => void) | null;
}
const invalid = (): AppError => new AppError('VALIDATION_ERROR', '项目入口参数无效', 400);
const unavailable = (): AppError => new AppError('PROJECT_ENTRY_UNAVAILABLE', '项目入口已失效，请重新打开', 503);
function parse<T>(schema: {safeParse(input: unknown): {success: true; data: T} | {success: false}}, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw invalid();
  return result.data;
}
/** Metadata containment only. This never opens or resolves a project file;
 * the kernel remains responsible for validating an actual open. */
export function projectEntryWithinRoot(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

/** A production capability owned by one server instance. Neither its window
 * bindings nor its path-taking methods are registered as HTTP operations. */
export function createProjectEntries<Runtime extends ProjectHostRuntime>({manager, registry, projectsDir, channel, signal, readScope, createProject, refreshSummaries}: {
  readonly manager: ProjectHostManager<Runtime>;
  readonly registry: ProjectRegistryPort;
  readonly projectsDir: string;
  readonly channel: 'web' | 'production' | 'development';
  readonly signal: AbortSignal;
  readonly readScope: () => string;
  readonly createProject: (input: ProjectEntryCreateInput) => Promise<{readonly registration: RecentProject}>;
  readonly refreshSummaries: () => void;
}) {
  const instanceId = randomUUID();
  let establishedScope: string | undefined;
  const windows = new Map<string, WindowSlot<Runtime>>();
  const listeners = new Set<(event: ProjectEntryWindowRevoked) => void>();
  const active = (): void => {if (signal.aborted) throw projectHostError('PROJECT_HOST_STOPPED');};
  const scope = (): string => {
    active();
    const observed = readScope();
    if (!/^[a-f0-9]{64}$/u.test(observed) || establishedScope !== undefined && establishedScope !== observed) {
      throw new AppError('PROJECT_ENTRY_SCOPE_MISMATCH', '应用库身份已变化，请重新打开', 409);
    }
    establishedScope = observed;
    return observed;
  };
  const list = (all: boolean): ProjectEntriesResponse => {
    const before = scope();
    refreshSummaries();
    const registered = manager.list().filter(entry => all || projectEntryWithinRoot(projectsDir, entry.project.projectFile))
      .map(entry => ({...entry, coverUrl: entry.project.summary?.cover ? '/api/project-covers/' + entry.project.projectId : null}));
    if (before !== scope()) throw new AppError('PROJECT_ENTRY_SCOPE_MISMATCH', '应用库身份已变化，请重新打开', 409);
    const result = projectEntriesResponseSchema.safeParse({version: 1, appLibraryScope: before, instanceId, registered});
    if (!result.success) throw unavailable();
    return result.data;
  };
  const releaseSlot = (windowId: string, slot: WindowSlot<Runtime>): void => {
    if (windows.get(windowId) === slot) windows.delete(windowId);
    if (slot.lease && slot.revoke) slot.lease.signal.removeEventListener('abort', slot.revoke);
    slot.revoke = null;
    slot.lease?.release();
    slot.lease = null;
  };
  const notify = (event: ProjectEntryWindowRevoked): void => {
    for (const listener of listeners) {
      try {listener(event);} catch { /* An observer cannot prevent lease cleanup. */ }
    }
  };
  const bind = (windowId: string, key: string, acquire: () => Promise<ProjectLease<Runtime>>): Promise<ProjectEntryWindow> => {
    scope();
    const existing = windows.get(windowId);
    if (existing) {
      if (existing.key !== key) throw new AppError('PROJECT_ENTRY_WINDOW_CONFLICT', '窗口已绑定其他项目意图', 409);
      return existing.promise;
    }
    if (windows.size >= PROJECT_ENTRY_LIMITS.maxEntries) throw new AppError('PROJECT_ENTRY_LIMIT', '项目窗口数量超过上限', 413);
    let resolve!: (value: ProjectEntryWindow) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ProjectEntryWindow>((accept, fail) => {resolve = accept; reject = fail;});
    const slot: WindowSlot<Runtime> = {key, promise, lease: null, revoke: null};
    windows.set(windowId, slot);
    void (async () => {
      // release() can retire an in-flight open. Its eventual lease must never
      // be delivered to a replacement owner with the same identifier.
      if (windows.get(windowId) !== slot) throw unavailable();
      const lease = await acquire();
      slot.lease = lease;
      if (windows.get(windowId) !== slot || signal.aborted || lease.signal.aborted) throw unavailable();
      scope();
      const project = registry.get(lease.host.projectId);
      if (!project) throw unavailable();
      const result = projectEntryWindowSchema.parse({windowId, project});
      slot.revoke = () => {
        if (windows.get(windowId) !== slot) return;
        releaseSlot(windowId, slot);
        notify({windowId, projectId: result.project.projectId});
      };
      lease.signal.addEventListener('abort', slot.revoke, {once: true});
      return result;
    })().then(resolve, error => {releaseSlot(windowId, slot); reject(error);});
    return promise;
  };
  const control: ProjectEntryControlPort = {
    listRecent: () => list(true),
    create: async input => {
      scope();
      const result = await createProject(parse(projectEntryCreateInputSchema, input));
      scope();
      return result.registration;
    },
    openPath: input => {
      const selected = parse(projectEntryOpenPathInputSchema, input);
      return bind(selected.windowId, 'path:' + selected.projectFile, () => manager.openPath(selected.projectFile, 'window'));
    },
    acquire: input => {
      const selected = parse(projectEntryAcquireInputSchema, input);
      return bind(selected.windowId, 'id:' + selected.projectId, () => manager.acquire(selected.projectId, 'window'));
    },
    release: input => {
      const {windowId} = parse(projectEntryReleaseInputSchema, input), slot = windows.get(windowId);
      if (slot) releaseSlot(windowId, slot);
    },
    onWindowRevoked: listener => {
      active();
      if (typeof listener !== 'function') throw invalid();
      listeners.add(listener);
      return () => {listeners.delete(listener);};
    },
  };
  Object.freeze(control);
  signal.addEventListener('abort', () => {
    for (const [windowId, slot] of windows) {
      const projectId = slot.lease?.host.projectId;
      releaseSlot(windowId, slot);
      if (projectId) notify({windowId, projectId});
    }
    listeners.clear();
  }, {once: true});
  return {control, handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (url.pathname !== '/api/project-entries') return false;
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      throw new AppError('METHOD_NOT_ALLOWED', '请使用 GET', 405);
    }
    if (url.search !== '') throw invalid();
    if (req.headers['transfer-encoding'] !== undefined ||
      req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') {
      res.setHeader('Connection', 'close');
      throw invalid();
    }
    const payload = JSON.stringify({ok: true, data: list(channel !== 'web')});
    if (Buffer.byteLength(payload, 'utf8') > PROJECT_ENTRY_LIMITS.responseBytes) {
      throw new AppError('PROJECT_ENTRY_LIMIT', '项目目录响应超过传输上限', 413);
    }
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(payload);
    return true;
  }};
}
