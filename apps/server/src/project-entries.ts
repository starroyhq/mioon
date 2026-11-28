import {randomUUID} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import path from 'node:path';
import {lstatSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT5_PROJECT_SCHEMA_VERSION, inspectProjectFileReadOnly, inspectCopiedProjectFile, isProjectFileHeld, projectFileError, sameContentStamp} from '@mioon/business/project-file/index';
import type {ProjectFileFormat} from '@mioon/business/project-file/index';
import {readClosedProjectForFormatUpgrade} from '../../../packages/business/src/project-file/closed-copy.ts';
import {fileIdentityOfStats, isAppLibraryHeld, projectFileIdentity, sameProjectFileIdentity} from '@mioon/business/app-db/index';
import {AppError} from '../../../packages/contracts/src/app-error.ts';
import {projectEntriesResponseSchema, projectEntryIdentitySchema, projectEntryResponseSchema, PROJECT_ENTRY_LIMITS} from '../../../packages/contracts/src/project-entry.ts';
import {isProjectId} from '../../../packages/contracts/src/project-file.ts';
import type {ProjectEntriesResponse} from '../../../packages/contracts/src/project-entry.ts';
import type {AgentTaskEditingLiveness} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import {
  projectEntryCreateInputSchema, projectEntryOpenPathInputSchema, projectEntryAcquireInputSchema, projectEntryPrepareAcquireInputSchema,
  projectEntryMarkOpenedInputSchema, projectEntryReleaseInputSchema, projectEntryWindowSchema,
  projectEntrySaveAsInputSchema, projectEntryAdoptCopyInputSchema, projectEntrySourceObservationSchema,
  projectEntryObserveFormatInputSchema, projectEntryReadOnlyFormatSchema, projectFormatSourceSchema,
} from '../../../packages/contracts/src/project-entry-native.ts';
import type {ProjectFormatUpgradePreview} from '../../../packages/contracts/src/project-format-upgrade.ts';
import {projectCopyInputSchema, projectCopyToInputSchema, projectTemplateInputSchema, projectCopySourceSchema} from '../../../packages/contracts/src/project-copies.ts';
import {fcpChooseDestinationControlInputSchema, fcpCompletedBundleControlInputSchema, projectEntryInspectCopyInputSchema} from '../../../packages/contracts/src/project-entry-control.ts';
import type {ProjectCopyResponse} from '../../../packages/contracts/src/project-copies.ts';
import type {ProjectDesktopTemplate} from '../../../packages/contracts/src/project-entry-desktop.ts';
import type {NativeFcpExportControlPort, ProjectEntryControlPort, ProjectEntryWindow, ProjectEntryWindowRevoked, ProjectEntryCreateInput} from '../../../packages/contracts/src/project-entry-native.ts';
import type {RecentProject} from '../../../packages/contracts/src/project-registry.ts';
import type {ProjectHostManager} from './project-host/manager.ts';
import type {ProjectHostRuntime, ProjectLease} from './project-host/host.ts';
import type {ProjectRegistryPort} from './project-host/ports.ts';
import type {ApplicationFileGuard} from './project-host/application-storage.ts';
import {projectFileMoved, projectHostError} from './project-host/errors.ts';
import type {ProjectCopies} from './project-host/copies.ts';
import type {NativeAssetMediaPort,NativeAssetMediaRequestOptions} from '../../../packages/contracts/src/asset-media-native.ts';
import type {ProjectTrashActions} from './project-host/trash.ts';
import {projectDeleteInputSchema} from '../../../packages/contracts/src/project-lifecycle.ts';
import {json} from './http-json.ts';
import {createProjectCatalog} from './project-host/project-catalog.ts';
import {catalogFileGeneration as generation} from './project-catalog-scan.ts';
import type {ProjectCatalogClient} from './project-catalog-client.ts';
import {matchesRegisteredInode, refreshRegisteredIdentity} from './project-host/registration-identity.ts';

interface WindowSlot<Runtime extends ProjectHostRuntime> {
  readonly key: string;
  readonly promise: Promise<ProjectEntryWindow>;
  lease: ProjectLease<Runtime> | null;
  revoke: (() => void) | null;
  readyContextId: string | null;
}
type ProjectFcpExportServices = {
  [Method in keyof NativeFcpExportControlPort]: (
    input: Omit<Parameters<NativeFcpExportControlPort[Method]>[0], 'windowId'>,
  ) => Awaited<ReturnType<NativeFcpExportControlPort[Method]>>;
};
const invalid = (): AppError => new AppError('VALIDATION_ERROR', '项目入口参数无效', 400);
const unavailable = (): AppError => new AppError('PROJECT_ENTRY_UNAVAILABLE', '项目入口已失效，请重新打开', 503);
const desktopEditingOwner = /^desktop:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):.+$/u;
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
export function createProjectEntries<Runtime extends ProjectHostRuntime>({manager, registry, projectsDir, channel, signal, readScope, createProject, refreshSummaries, markRecentOpened, copies, trash, assertProjectFile, copyOriginal, nativeRelink, nativeFcpExportFor, templates, targetFormat = FORMAT5_PROJECT_SCHEMA_VERSION, catalogClient, catalogTimeoutMs, updateActivity}: {
  readonly manager: ProjectHostManager<Runtime>;
  readonly registry: ProjectRegistryPort;
  readonly projectsDir: string;
  readonly channel: 'web' | 'production' | 'development';
  readonly signal: AbortSignal;
  readonly readScope: () => string;
  readonly createProject: (input: ProjectEntryCreateInput) => Promise<{readonly registration: RecentProject}>;
  readonly refreshSummaries: () => void;
  readonly updateActivity?: ProjectEntryControlPort['updateActivity'];
  readonly markRecentOpened?: (projectId: string, lastOpenedAt: string) => void;
  readonly templates?: readonly ProjectDesktopTemplate[];
  readonly copies?: Pick<ProjectCopies, 'duplicate' | 'saveAs' | 'replay' | 'adoptCopy' | 'copyTo' | 'instantiateTemplate' | 'replayAction'>;
  readonly assertProjectFile?: ApplicationFileGuard;
  readonly catalogClient?: ProjectCatalogClient;
  readonly catalogTimeoutMs?: number;
  readonly copyOriginal?: (candidate:{projectId:string;projectFile:string}) => RecentProject|null;
  readonly nativeRelink?: NativeAssetMediaPort;
  readonly nativeFcpExportFor?: (runtime: Runtime) => ProjectFcpExportServices | undefined;
  readonly trash?: ProjectTrashActions;
  readonly targetFormat?: ProjectFileFormat;
}) {
  targetFormat ??= FORMAT5_PROJECT_SCHEMA_VERSION;
  const format4 = targetFormat === FORMAT4_PROJECT_SCHEMA_VERSION ? {} : undefined;
  const supportsFormatUpgrades = targetFormat >= FORMAT4_PROJECT_SCHEMA_VERSION;
  const instanceId = randomUUID();
  let establishedScope: string | undefined;
  const windows = new Map<string, WindowSlot<Runtime>>();
  // Keep native evidence at the utility lifetime, across individual project
  // host eviction. Older or unobserved owners remain uncertain.
  const editingWindows = new Map<string, {projects:Set<string>; closed:boolean}>();
  const rememberEditingWindow = (windowId: string, observation: {projects:Set<string>; closed:boolean}): void => {
    editingWindows.delete(windowId);
    editingWindows.set(windowId, observation);
    if (editingWindows.size > PROJECT_ENTRY_LIMITS.maxEntries) editingWindows.delete(editingWindows.keys().next().value!);
  };
  function editingLiveness(projectId: string, ownerId: string): AgentTaskEditingLiveness {
    const windowId = desktopEditingOwner.exec(ownerId)?.[1];
    if (!windowId || signal.aborted) return 'uncertain';
    const observed = editingWindows.get(windowId);
    if (observed?.closed && observed.projects.has(projectId)) return 'retained';
    const slot = windows.get(windowId);
    return slot?.lease && !slot.lease.signal.aborted && slot.lease.host.projectId === projectId ? 'in_use' : 'uncertain';
  }
  function editingOwnerAdmission(projectId: string, ownerId: string): boolean {
    if (!ownerId.startsWith('desktop:')) return true; // Existing browser and legacy owners.
    const windowId = desktopEditingOwner.exec(ownerId)?.[1];
    if (!windowId || editingLiveness(projectId, ownerId) !== 'in_use') return false;
    const observed = editingWindows.get(windowId) ?? {projects: new Set<string>(), closed: false};
    observed.projects.add(projectId);
    rememberEditingWindow(windowId, observed);
    return true;
  }
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
  const readIdentity = () => ({appLibraryScope: scope(), instanceId});
  // Before any descriptor is opened (including journal/header reads), refuse
  // every held SQLite inode. Closing an alias would drop the owner's POSIX lock.
  const sourceMetadata = (file:string):BigIntStats => {
    const info=lstatSync(file,{bigint:true}),identity=fileIdentityOfStats(info);
    if(isProjectFileHeld(identity)||isAppLibraryHeld(identity))throw projectFileError('PROJECT_LOCKED',{database:'project',reason:'locked'});
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n)throw projectFileError('PROJECT_INVALID',{database:'project',reason:'not-a-regular-file'});
    return info;
  };
  // Native and HTTP share the same sweep. The web process still does recovery
  // for existing registrations, while header hints and responses are scoped
  // to the web project root.
  const inspectCatalog = createProjectCatalog({client: catalogClient, guard: assertProjectFile, signal, checkpoint: scope,
    timeoutMs: catalogTimeoutMs, targetFormat});
  const readCatalog = async (coversAll: boolean) => {
    const before = scope();
    refreshSummaries();
    const listed = await manager.listForCatalog((projects, isCurrent) =>
      inspectCatalog(projects, isCurrent, file => coversAll || projectEntryWithinRoot(projectsDir, file)));
    if (before !== scope()) throw new AppError('PROJECT_ENTRY_SCOPE_MISMATCH', '应用库身份已变化，请重新打开', 409);
    return {before, listed};
  };
  let catalogFlight: {all: boolean; result: ReturnType<typeof readCatalog>} | undefined;
  const list = async (all: boolean): Promise<ProjectEntriesResponse> => {
    scope();
    // Only direct native control can request out-of-root header hints on a
    // server with the web channel. A web-only flight never authorizes them.
    if (all && catalogFlight && !catalogFlight.all) {
      await catalogFlight.result;
      scope();
    }
    const flight = catalogFlight ??= {
      all, result: readCatalog(all).finally(() => {catalogFlight = undefined;}),
    };
    const {before, listed} = await flight.result;
    scope();
    const registered = listed.filter(entry => all || projectEntryWithinRoot(projectsDir, entry.project.projectFile))
      .map(({project, availability}) => ({project, availability, coverUrl: project.summary?.cover ? '/api/project-covers/' + project.projectId : null}));
    const result = projectEntriesResponseSchema.safeParse({
      version: 1, appLibraryScope: before, instanceId, newProjectFormatVersion: targetFormat, registered,
    });
    if (!result.success) throw unavailable();
    return result.data;
  };
  const observeFile = (file:string) => {
    assertProjectFile?.(file);
    const before=sourceMetadata(file);
    for(const suffix of ['-journal','-wal','-shm'])if(lstatSync(file+suffix,{throwIfNoEntry:false}))sourceMetadata(file+suffix);
    const stamp=inspectProjectFileReadOnly(file);
    const metadata=inspectCopiedProjectFile(file);
    const after=sourceMetadata(file);
    if(generation(before)!==generation(after)||stamp.projectId!==metadata.projectId||stamp.contentSequence!==metadata.contentSequence||stamp.contentToken!==metadata.contentToken)throw unavailable();
    return {metadata,identity:fileIdentityOfStats(after)};
  };
  const registeredFormatSource = (projectId: string): RecentProject => {
    scope();
    const entry = registry.get(projectId);
    if (!supportsFormatUpgrades || channel !== 'web' || !entry || !projectEntryWithinRoot(projectsDir, entry.projectFile)) {
      throw new AppError('PROJECT_NOT_FOUND', '项目未登记', 404, {projectId});
    }
    assertProjectFile?.(entry.projectFile);
    return refreshRegisteredIdentity(registry, entry, projectFileIdentity(entry.projectFile)) ?? entry;
  };
  const fileIdentity = (file: string) => fileIdentityOfStats(lstatSync(file, {bigint: true}));
  const readOnly = (projectId: string, file: string, identity: RecentProject['fileIdentity'], preview?: ProjectFormatUpgradePreview) => {
    const current = scope();
    if (!supportsFormatUpgrades) throw unavailable();
    assertProjectFile?.(file);
    if (!sameProjectFileIdentity(fileIdentity(file), identity)) throw projectFileMoved(projectId);
    const view = readClosedProjectForFormatUpgrade(file, projectId, preview);
    if (current !== scope() || !sameProjectFileIdentity(fileIdentity(file), identity)) throw projectFileMoved(projectId);
    return view;
  };
  const observedOriginal = (source:{projectId:string;projectFile:string}):RecentProject|null => {
    const original=copyOriginal?.(source);
    if(!original)return null;
    try{
      assertProjectFile?.(original.projectFile);
      const before=lstatSync(original.projectFile,{bigint:true});
      const identity=fileIdentityOfStats(before);
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||!matchesRegisteredInode(original,identity))return null;
      const unchanged=()=>generation(lstatSync(original.projectFile,{bigint:true}))===generation(before);
      // An open host is the only reader allowed to touch its live connection;
      // refreshSummaries obtains its verified name without opening an alias.
      if(isProjectFileHeld(identity)){
        if(manager.status(original.projectId)?.state!=='open')return null;
        refreshSummaries();
        const current=registry.get(original.projectId);
        if(!current||current.projectFile!==original.projectFile||!sameProjectFileIdentity(current.fileIdentity,original.fileIdentity)||!unchanged())return null;
        return refreshRegisteredIdentity(registry,current,identity);
      }
      const found=observeFile(original.projectFile);
      if(found.metadata.projectId!==original.projectId||typeof found.metadata.name!=='string'||!sameProjectFileIdentity(found.identity,identity)||!unchanged())return null;
      const current=refreshRegisteredIdentity(registry,original,identity);
      return current&&{...current,name:found.metadata.name};
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
  const bind = (windowId: string, key: string, acquire: () => Promise<ProjectLease<Runtime>>,
    expectedProjectFile?: string, deferRecent = false): Promise<ProjectEntryWindow> => {
    scope();
    if (editingWindows.get(windowId)?.closed) throw unavailable();
    if (deferRecent) key = 'provisional:' + key;
    const existing = windows.get(windowId);
    if (existing) {
      if (existing.key !== key) throw new AppError('PROJECT_ENTRY_WINDOW_CONFLICT', '窗口已绑定其他项目意图', 409);
      return existing.promise;
    }
    if (windows.size >= PROJECT_ENTRY_LIMITS.maxEntries) throw new AppError('PROJECT_ENTRY_LIMIT', '项目窗口数量超过上限', 413);
    let resolve!: (value: ProjectEntryWindow) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ProjectEntryWindow>((accept, fail) => {resolve = accept; reject = fail;});
    const slot: WindowSlot<Runtime> = {key, promise, lease: null, revoke: null, readyContextId: null};
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
  const fcpServiceForWindow = (projectId: string, windowId: string, requestSignal?: AbortSignal): ProjectFcpExportServices => {
    scope();
    requestSignal?.throwIfAborted();
    const slot = windows.get(windowId), lease = slot?.lease;
    if (!slot?.readyContextId || !lease || lease.signal.aborted || lease.host.projectId !== projectId) throw unavailable();
    const service = nativeFcpExportFor?.(lease.host.runtime);
    if (!service) throw unavailable();
    return service;
  };
  const nativeFcpExport: NativeFcpExportControlPort | undefined = channel !== 'web' && nativeFcpExportFor ? {
    async chooseDestination(raw, options) {
      const {windowId, ...input} = parse(fcpChooseDestinationControlInputSchema, raw);
      return fcpServiceForWindow(input.projectId, windowId, options?.signal).chooseDestination(input);
    },
    async completedBundle(raw, options) {
      const {windowId, ...input} = parse(fcpCompletedBundleControlInputSchema, raw);
      return fcpServiceForWindow(input.projectId, windowId, options?.signal).completedBundle(input);
    },
  } : undefined;
  const control: ProjectEntryControlPort = {
    ...(templates?.length?{templates:Object.freeze(templates.map(template=>Object.freeze({...template})))}:{}),
    ...(scopedNative?{nativeRelink:scopedNative}:{}),
    ...(nativeFcpExport ? {nativeFcpExport} : {}),
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
    ...(updateActivity ? {updateActivity: () => {scope(); return updateActivity();}} : {}),
    observeFormat: async raw => {
      scope();
      const {projectFile, preview} = parse(projectEntryObserveFormatInputSchema, raw);
      if (!supportsFormatUpgrades) throw unavailable();
      const {metadata, identity} = observeFile(projectFile);
      if (metadata.projectId !== preview.projectId || metadata.formatVersion !== preview.projectVersion || !sameContentStamp(metadata, preview)) throw projectFileMoved(preview.projectId);
      scope();
      return projectFormatSourceSchema.parse({projectFile, preview, identity});
    },
    readOnlyFormat: async raw => {
      const {projectFile, identity, preview} = parse(projectEntryReadOnlyFormatSchema, raw);
      return readOnly(preview.projectId, projectFile, identity, preview);
    },
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
      const upgrade = selected.formatUpgrade;
      if (upgrade && upgrade.projectFile !== selected.projectFile) throw invalid();
      return bind(selected.windowId, 'path:' + selected.projectFile + (upgrade ? ':upgrade:' + JSON.stringify(upgrade) : ''),
        () => manager.openPath(selected.projectFile, 'window', {deferRecent: selected.deferRecent, formatUpgrade: upgrade?.preview, fileIdentity: upgrade?.identity}), undefined, selected.deferRecent);
    },
    acquire: input => {
      const selected = parse(projectEntryAcquireInputSchema, input);
      const pinned = selected.expectedProjectFile;
      const upgrade = selected.formatUpgrade;
      if (upgrade && (upgrade.projectFile !== pinned || upgrade.preview.projectId !== selected.projectId)) throw invalid();
      return bind(selected.windowId, 'id:' + selected.projectId + (pinned === undefined ? '' : ':path:' + pinned) + (upgrade ? ':upgrade:' + JSON.stringify(upgrade) : ''),
        () => manager.acquire(selected.projectId, 'window', {projectFile: pinned, deferRecent: selected.deferRecent, formatUpgrade: upgrade?.preview, fileIdentity: upgrade?.identity}), pinned, selected.deferRecent);
    },
    markOpened: input => {
      scope();
      const {windowId, contextId} = parse(projectEntryMarkOpenedInputSchema, input), slot = windows.get(windowId);
      if (!slot?.lease || slot.lease.signal.aborted) throw unavailable();
      if (slot.readyContextId !== contextId) {
        const lastOpenedAt = manager.markWindowOpened(slot.lease);
        slot.readyContextId = contextId;
        if (lastOpenedAt) markRecentOpened?.(slot.lease.host.projectId, lastOpenedAt);
      }
      return true;
    },
    release: input => {
      const {windowId, closed} = parse(projectEntryReleaseInputSchema, input), slot = windows.get(windowId);
      const observed = editingWindows.get(windowId);
      if (closed && observed) rememberEditingWindow(windowId, {...observed, closed:true});
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
  return {control, editingLiveness, editingOwnerAdmission,
    readIdentity,
    readRegisteredFormat(projectId: string) {
      const entry = registeredFormatSource(projectId);
      return readOnly(projectId, entry.projectFile, entry.fileIdentity);
    },
    async upgradeRegisteredFormat(projectId: string, preview: ProjectFormatUpgradePreview) {
      const entry = registeredFormatSource(projectId);
      if (preview.projectId !== projectId) throw invalid();
      const lease = await manager.acquire(projectId, 'request', {projectFile: entry.projectFile, fileIdentity: entry.fileIdentity, formatUpgrade: preview});
      try {scope(); return {projectId};} finally {lease.release();}
    },
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const identity = url.pathname === '/api/project-entries/identity';
    const single = !identity && url.pathname.startsWith('/api/project-entries/');
    if (url.pathname !== '/api/project-entries' && !identity && !single) return false;
    const projectId = single ? url.pathname.slice('/api/project-entries/'.length) : null;
    if (projectId !== null && (!isProjectId(projectId) || projectId !== projectId.toLowerCase())) return false;
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
    if (identity) {
      json(res, 200, {ok: true, data: projectEntryIdentitySchema.parse(readIdentity())});
      return true;
    }
    const catalog = await list(channel !== 'web');
    if (res.destroyed || res.writableEnded) return true;
    const entry = projectId === null ? null : catalog.registered.find(item => item.project.projectId === projectId);
    if (projectId !== null && !entry) throw new AppError('PROJECT_NOT_FOUND', '项目未登记', 404, {projectId});
    const data = entry ? projectEntryResponseSchema.parse({version: catalog.version, appLibraryScope: catalog.appLibraryScope,
      instanceId: catalog.instanceId, entry}) : catalog;
    const payload = JSON.stringify({ok: true, data});
    if (Buffer.byteLength(payload, 'utf8') > PROJECT_ENTRY_LIMITS.responseBytes) {
      throw new AppError('PROJECT_ENTRY_LIMIT', '项目目录响应超过传输上限', 413);
    }
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(payload);
    return true;
  }};
}
