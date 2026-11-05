import {randomUUID} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import path from 'node:path';
import {lstatSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {inspectProjectFileReadOnly, inspectCopiedProjectFile, isProjectFileHeld, projectFileError} from '@mioon/business/project-file/index';
import {isAppLibraryHeld, sameProjectFileIdentity} from '@mioon/business/app-db/index';
import {AppError} from '../../../packages/contracts/src/app-error.ts';
import {projectEntriesResponseSchema, PROJECT_ENTRY_LIMITS} from '../../../packages/contracts/src/project-entry.ts';
import type {ProjectEntriesResponse} from '../../../packages/contracts/src/project-entry.ts';
import {
  projectEntryCreateInputSchema, projectEntryOpenPathInputSchema, projectEntryAcquireInputSchema, projectEntryPrepareAcquireInputSchema,
  projectEntryReleaseInputSchema, projectEntryWindowSchema,
  projectEntrySaveAsInputSchema, projectEntryAdoptCopyInputSchema, projectEntrySourceObservationSchema,
} from '../../../packages/contracts/src/project-entry-native.ts';
import {projectCopyInputSchema, projectCopyToInputSchema, projectTemplateInputSchema, projectCopySourceSchema} from '../../../packages/contracts/src/project-copies.ts';
import {projectEntryInspectCopyInputSchema} from '../../../packages/contracts/src/project-entry-control.ts';
import type {ProjectCopyResponse} from '../../../packages/contracts/src/project-copies.ts';
import type {ProjectDesktopTemplate} from '../../../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntryControlPort, ProjectEntryWindow, ProjectEntryWindowRevoked, ProjectEntryCreateInput} from '../../../packages/contracts/src/project-entry-native.ts';
import type {RecentProject} from '../../../packages/contracts/src/project-registry.ts';
import type {ProjectHostManager} from './project-host/manager.ts';
import type {ProjectHostRuntime, ProjectLease} from './project-host/host.ts';
import type {ProjectRegistryPort} from './project-host/ports.ts';
import {projectFileMoved, projectHostError} from './project-host/errors.ts';
import type {ProjectCopies} from './project-host/copies.ts';
import type {NativeAssetMediaPort,NativeAssetMediaRequestOptions} from '../../../packages/contracts/src/asset-media-native.ts';
import type {ProjectTrashActions} from './project-host/trash.ts';
import {projectDeleteInputSchema} from '../../../packages/contracts/src/project-lifecycle.ts';

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
export function createProjectEntries<Runtime extends ProjectHostRuntime>({manager, registry, projectsDir, channel, signal, readScope, createProject, refreshSummaries, copies, trash, assertProjectFile, copyOriginal, nativeRelink, templates}: {
  readonly manager: ProjectHostManager<Runtime>;
  readonly registry: ProjectRegistryPort;
  readonly projectsDir: string;
  readonly channel: 'web' | 'production' | 'development';
  readonly signal: AbortSignal;
  readonly readScope: () => string;
  readonly createProject: (input: ProjectEntryCreateInput) => Promise<{readonly registration: RecentProject}>;
  readonly refreshSummaries: () => void;
  readonly templates?: readonly ProjectDesktopTemplate[];
  readonly copies?: Pick<ProjectCopies, 'duplicate' | 'saveAs' | 'replay' | 'adoptCopy' | 'copyTo' | 'instantiateTemplate' | 'replayAction'>;
  readonly assertProjectFile?: (file:string) => void;
  readonly copyOriginal?: (candidate:{projectId:string;projectFile:string}) => RecentProject|null;
  readonly nativeRelink?: NativeAssetMediaPort;
  readonly trash?: ProjectTrashActions;
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
  const generation = (info:BigIntStats):string => [info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
  // Before any descriptor is opened (including journal/header reads), refuse
  // every held SQLite inode. Closing an alias would drop the owner's POSIX lock.
  const sourceMetadata = (file:string):BigIntStats => {
    const info=lstatSync(file,{bigint:true}),identity={dev:String(info.dev),ino:String(info.ino)};
    if(isProjectFileHeld(identity)||isAppLibraryHeld(identity))throw projectFileError('PROJECT_LOCKED',{database:'project',reason:'locked'});
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n)throw projectFileError('PROJECT_INVALID',{database:'project',reason:'not-a-regular-file'});
    return info;
  };
  const observeFile = (file:string) => {
    assertProjectFile?.(file);
    const before=sourceMetadata(file);
    for(const suffix of ['-journal','-wal','-shm'])if(lstatSync(file+suffix,{throwIfNoEntry:false}))sourceMetadata(file+suffix);
    const stamp=inspectProjectFileReadOnly(file);
    const metadata=inspectCopiedProjectFile(file);
    const after=sourceMetadata(file);
    if(generation(before)!==generation(after)||stamp.projectId!==metadata.projectId||stamp.contentSequence!==metadata.contentSequence||stamp.contentToken!==metadata.contentToken)throw unavailable();
    return {metadata,identity:{dev:String(after.dev),ino:String(after.ino)}};
  };
  const observedOriginal = (source:{projectId:string;projectFile:string}):RecentProject|null => {
    const original=copyOriginal?.(source);
    if(!original)return null;
    try{
      assertProjectFile?.(original.projectFile);
      const before=lstatSync(original.projectFile,{bigint:true});
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||!sameProjectFileIdentity({dev:String(before.dev),ino:String(before.ino)},original.fileIdentity))return null;
      // An open host is the only reader allowed to touch its live connection;
      // refreshSummaries obtains its verified name without opening an alias.
      if(isProjectFileHeld(original.fileIdentity)){
        if(manager.status(original.projectId)?.state!=='open')return null;
        refreshSummaries();
        const current=registry.get(original.projectId);
        return current&&current.projectFile===original.projectFile&&sameProjectFileIdentity(current.fileIdentity,original.fileIdentity)&&generation(lstatSync(original.projectFile,{bigint:true}))===generation(before)?current:null;
      }
      const found=observeFile(original.projectFile);
      if(found.metadata.projectId!==original.projectId||typeof found.metadata.name!=='string'||!sameProjectFileIdentity(found.identity,original.fileIdentity)||generation(lstatSync(original.projectFile,{bigint:true}))!==generation(before))return null;
      return {...original,name:found.metadata.name};
    }catch{return null;}
  };
  const nativeFence = (options:NativeAssetMediaRequestOptions|undefined):NativeAssetMediaRequestOptions & {beforeEffect():void} => {
    scope();
    const beforeEffect=()=>{options?.signal?.throwIfAborted();scope();options?.beforeEffect?.();};
    beforeEffect();
    return {...options,beforeEffect};
  };
  const scopedNative:NativeAssetMediaPort|undefined=nativeRelink?{
    candidate:async(input,options)=>{const fence=nativeFence(options),result=await nativeRelink.candidate(input,fence);fence.beforeEffect();return result;},
    preview:async(input,options)=>{const fence=nativeFence(options),result=await nativeRelink.preview(input,fence);fence.beforeEffect();return result;},
    discard:async(input,options)=>{const fence=nativeFence(options);await nativeRelink.discard(input,fence);fence.beforeEffect();},
    apply:async(input,options)=>{
      const fence=nativeFence(options);
      try{const result=await nativeRelink.apply(input,fence);fence.beforeEffect();return result;}
      catch(error){
        // A dispatched apply may already have committed. Losing the app scope
        // or document fence can never be reported as proof of no execution.
        try{fence.beforeEffect();}catch{throw new AppError('PROJECT_ENTRY_OUTCOME_UNKNOWN','应用结果需要按原请求核对',409,{projectId:input.projectId,requestId:input.requestId,operation:'mediaRelinkApply'});}
        throw error;
      }
    },
  }:undefined;
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
  const bind = (windowId: string, key: string, acquire: () => Promise<ProjectLease<Runtime>>, expectedProjectFile?: string): Promise<ProjectEntryWindow> => {
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
      if (expectedProjectFile !== undefined && project.projectFile !== expectedProjectFile) throw projectFileMoved(lease.host.projectId);
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
    ...(templates?.length?{templates:Object.freeze(templates.map(template=>Object.freeze({...template})))}:{}),
    ...(scopedNative?{nativeRelink:scopedNative}:{}),
    inspectSelectedCopy: async raw => {
      scope();
      const {projectFile} = parse(projectEntryInspectCopyInputSchema, raw);
      const {metadata:stamp,identity}=observeFile(projectFile);
      scope();
      return projectCopySourceSchema.parse({sourceProjectId:stamp.projectId,sourceFile:projectFile,sourceIdentity:identity,sourceStamp:{contentSequence:stamp.contentSequence,contentToken:stamp.contentToken}});
    },
    ...(assertProjectFile?{observeSource:async(raw:unknown)=>{
      scope();
      const {projectFile}=parse(projectEntryInspectCopyInputSchema,raw),{metadata,identity}=observeFile(projectFile);
      const original=observedOriginal({projectId:metadata.projectId,projectFile});
      scope();
      return projectEntrySourceObservationSchema.parse({source:{sourceProjectId:metadata.projectId,sourceFile:projectFile,sourceIdentity:identity,sourceStamp:{contentSequence:metadata.contentSequence,contentToken:metadata.contentToken}},name:metadata.name,original});
    }}:{}),
    listRecent: () => list(true),
    prepareAcquire: async raw => {
      scope();
      const {projectId} = parse(projectEntryPrepareAcquireInputSchema, raw);
      const project = await manager.prepareAcquire(projectId);
      scope();
      return project;
    },
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
      const pinned = selected.expectedProjectFile;
      return bind(selected.windowId, 'id:' + selected.projectId + (pinned === undefined ? '' : ':path:' + pinned),
        () => manager.acquire(selected.projectId, 'window', pinned === undefined ? undefined : {projectFile: pinned}), pinned);
    },
    release: input => {
      const {windowId} = parse(projectEntryReleaseInputSchema, input), slot = windows.get(windowId);
      if (slot) releaseSlot(windowId, slot);
    },
    ...(copies ? {
      adoptCopy: async (raw: unknown): Promise<{copy: ProjectCopyResponse; window: ProjectEntryWindow}> => {
        scope();
        const {windowId, ...input} = parse(projectEntryAdoptCopyInputSchema, raw);
        const cached = copies.replayAction('project.adopt-copy', input);
        const slot = windows.get(windowId);
        if (cached && slot?.lease?.host.projectId === cached.project.projectId) {
          if (slot.lease.signal.aborted) throw unavailable();
          return {copy: cached, window: await slot.promise};
        }
        let copied: ProjectCopyResponse | undefined;
        // Reserve the window before replacing the selected copy. bind checks
        // conflicts/capacity synchronously and owns concurrent retries, so a
        // rejected window can never leave a committed identity replacement.
        const window = await bind(windowId, 'adopt:' + input.requestId, async () => {
          copied = cached ?? await copies.adoptCopy(input);
          scope();
          return await manager.acquire(copied.project.projectId, 'window');
        });
        const copy = copied ?? copies.replayAction('project.adopt-copy', input);
        if (!copy || copy.project.projectId !== window.project.projectId) throw unavailable();
        return {copy, window};
      },
      copyTo: async (raw: unknown): Promise<ProjectCopyResponse> => {
        scope();
        const result = await copies.copyTo(parse(projectCopyToInputSchema, raw));
        scope();
        return result;
      },
      instantiateTemplate: async (raw: unknown): Promise<ProjectCopyResponse> => {
        scope();
        const result = await copies.instantiateTemplate(parse(projectTemplateInputSchema, raw));
        scope();
        return result;
      },
      duplicate: async (raw: unknown): Promise<ProjectCopyResponse> => {
        scope();
        const result = await copies.duplicate(parse(projectCopyInputSchema, raw));
        scope();
        return result;
      },
      saveAs: async (raw: unknown): Promise<{copy: ProjectCopyResponse; window: ProjectEntryWindow}> => {
        scope();
        const {windowId, ...input} = parse(projectEntrySaveAsInputSchema, raw);
        const cached = copies.replay('project.save-as', input);
        const slot = windows.get(windowId);
        if (cached && slot?.lease?.host.projectId === cached.project.projectId) {
          if (slot.lease.signal.aborted) throw unavailable();
          return {copy: cached, window: await slot.promise};
        }
        if (!slot?.lease || slot.lease.host.projectId !== input.projectId || slot.lease.signal.aborted) throw unavailable();
        const status = manager.status(input.projectId);
        if (status?.leases.window !== 1 || status.leases.request > 0 || status.leases.task > 0
          || !slot.lease.host.recovery && slot.lease.host.runtime.isBusy()) throw projectHostError('PROJECT_HOST_BUSY', {projectId: input.projectId});
        // Release only this trusted window owner. The service then closes the
        // source under its exclusive gate; another window is never closed.
        releaseSlot(windowId, slot);
        try {
          const copy = cached ?? await copies.saveAs(input);
          scope();
          const window = await bind(windowId, 'id:' + copy.project.projectId, () => manager.acquire(copy.project.projectId, 'window'));
          return {copy, window};
        } catch (error) {
          if (!signal.aborted) {
            try {await bind(windowId, 'id:' + input.projectId, () => manager.acquire(input.projectId, 'window'));}
            catch (reopenError) {
              throw new AppError('PROJECT_SAVE_AS_REOPEN_FAILED', '另存为未完成，原项目也未能重新打开，请重新定位原项目。', 409,
                {projectId: input.projectId, causeCode: error instanceof AppError ? error.code : 'COPY_FAILED',
                  reopenCode: reopenError instanceof AppError ? reopenError.code : 'OPEN_FAILED'});
            }
          }
          throw error;
        }
      },
    } : {}),
    ...(trash?.available ? {trash: async (raw: unknown) => {
      scope();
      const result = await trash.trash(parse(projectDeleteInputSchema, raw));
      scope();
      return result;
    }} : {}),
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
