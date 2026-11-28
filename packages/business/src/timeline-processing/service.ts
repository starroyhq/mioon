import {createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {SCENE_DETECTION_PROFILE_ID} from '../../../contracts/src/scene-tasks.ts';
import path from 'node:path';
import {AppError} from '../../../contracts/src/app-error.ts';
import {speedProcessingItemSchema, TIMELINE_PROCESSING_WAIT_DEFAULT_MS} from '../../../contracts/src/timeline-processing.ts';
import type {SpeedProcessingItem, SpeedProcessingReason} from '../../../contracts/src/timeline-speed.ts';
import {processingInputWithClipSchema as inputWithClipSchema, processingReasonSchema as reasons,
  processingRowSchema as rowSchema, processingResultSchema as resultSchema,
  processingDigestSchema, processingProxyResultSchema} from '../../../contracts/src/timeline-processing-storage.ts';
import type {ProcessingInput, ProcessingInputWithClip, ProcessingTaskRow, ProcessingTaskState as TaskState,
  ProcessingTaskResult as TaskResult} from '../../../contracts/src/timeline-processing-storage.ts';
import {compileTimeMap, restoreTimeMap, timeMapPlanInfo} from '../../../contracts/src/timeline-time-map.ts';
import {markBackgroundTaskChanged} from '../background-task-events.ts';
import {pauseUnavailableBackgroundTask, markBackgroundTaskInvalid} from '../background-task-state.ts';
import {verifiedManagedHash, sameManagedFile, validateManagedSource} from '../managed-media.ts';
import type {ManagedFileIdentity} from '../managed-media.ts';
import {hasUnconfirmedMediaProcesses, waitForMediaProcesses} from '../media-processes.ts';
import {readProjectContentStamp, sameContentStamp} from '../project-file/content-stamp.ts';
import {FORMAT6_HISTORY_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION} from '../project-file/schema/databases.ts';
import {registerProjectTransactionObserver} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {assertProjectStore} from '../store-runtime.ts';
import {readOwnedTimelineAsset} from '../timeline-sources.ts';
import {createSceneHistoryReaders} from '../scene-history.ts';
import {createOpticalProxyPort, opticalCacheProof, verifyOpticalCache} from './optical-lease.ts';
import type {ResolvedOpticalProxy} from './optical-lease.ts';
import {OPTICAL_PROXY_PROFILE} from './optical-proxy-port.ts';
import type {TimelineOpticalProxyLease, TimelineOpticalProxyRequest} from './optical-proxy-port.ts';
import {prepareOpticalProxy, renderOpticalProxy} from './optical.ts';
import {PROCESSING_CACHE_LIMIT_BYTES, ProcessingFailure} from './cache.ts';
import type {ProcessingCache, ProcessingCacheEntry} from './cache.ts';
import {processingHash, processingSourceIdentity, readProcessingDemands} from './demand.ts';
import type {ProcessingDemand} from './demand.ts';
import {prepareReverseProxy, renderReverseProxy, REVERSE_PROXY_PROFILE} from './reverse.ts';
import type {ReverseProxyInput} from './reverse.ts';
import type {ReverseProxyMediaOptions} from './reverse-io.ts';
import {TIMELINE_PREVIEW_CACHE_PROFILE} from './preview-port.ts';
import type {PreviewProcessingInput, PreviewProcessingPort, PreviewProcessingProof, PreviewProcessingRenderer, PreviewProcessingRequest} from './preview-port.ts';
import {createTimelineReverseProxyPort} from './reverse-lease.ts';
import type {TimelineReverseProxyRequest} from './reverse-lease.ts';
import type {ProcessingScheduler} from './scheduler.ts';

const taskKind = 'timeline-processing' as const;
type Task = Omit<ProcessingTaskRow, 'input' | 'result'> & {
  readonly input: ProcessingInputWithClip; readonly result: TaskResult | null;
};
type PreviewDemand = ProcessingDemand & {readonly opticalTaskId?: string; readonly offFallback?: ProcessingDemand};
const activeState = (state: TaskState) => state === 'queued' || state === 'running';
const maxOutstanding = 64;
// Allow the current browser player to finish loading and seeking the optical
// preview while it still reads the already-issued off preview.
const opticalHandoffGraceMs = 15_000;
const noEffect = () => {};
const missing = () => new AppError('SPEED_PROCESSING_TASK_NOT_FOUND', '找不到该变速任务。', 404);
const stale = () => new AppError('SPEED_PROCESSING_STALE', '片段的变速设置已变化，请重新读取。', 409);
const refused = () => new AppError('SPEED_PROCESSING_UNAVAILABLE', '当前项目的变速后台处理不可用。', 409);
const terminationUnconfirmed = (error: unknown) => Boolean(error && typeof error === 'object' &&
  'terminationUnconfirmed' in error && error.terminationUnconfirmed);
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;
const sourceStatHash = (info: ManagedFileIdentity) => processingHash([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
const previewBindingKey = ({demandKey, input}: ProcessingDemand): string =>
  processingHash([demandKey, input.timelineId, input.assetId, input.sourceIdentity]);
function reasonFor(error: unknown): SpeedProcessingReason {
  const code = errorCode(error), direct = reasons.safeParse(code);
  if (direct.success) return direct.data;
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'DISK_FULL';
  if (typeof code === 'string' && (code.startsWith('MANAGED_SOURCE') || code.startsWith('MEDIA_') ||
    ['ENOENT', 'EACCES', 'EPERM'].includes(code))) return 'SOURCE_UNAVAILABLE';
  return 'PROCESSING_FAILED';
}
const now = () => new Date().toISOString();
function decode(data: unknown): Task {
  const parsed = rowSchema.parse(data);
  const input = inputWithClipSchema.parse(JSON.parse(parsed.input));
  if (input.frozen.kind !== parsed.kind) throw refused();
  return {...parsed, input, result: parsed.result === null ? null : resultSchema.parse(JSON.parse(parsed.result))};
}

export interface ProcessingServiceOptions {
  readonly enabled: boolean;
  readonly scheduler: ProcessingScheduler;
  readonly cache: ProcessingCache;
  readonly ownerSignal?: AbortSignal;
  readonly beforeEffect: () => void;
  readonly engine?: {prepare: typeof prepareReverseProxy; render: typeof renderReverseProxy};
  readonly previewRenderer?: PreviewProcessingRenderer;
}

export function createTimelineProcessingService(store: ProjectStore, options: ProcessingServiceOptions) {
  const {db, projectId} = store;
  const {cache, scheduler, ownerSignal, beforeEffect, previewRenderer,
    engine = {prepare: prepareReverseProxy, render: renderReverseProxy}} = options;
  const running = new Map<string, {controller: AbortController; done: Promise<void>; cancel: boolean}>();
  const listeners = new Set<() => void>();
  const previewBindings = new Map<string, Map<string, Buffer>>();
  let previewHandoffTimer: ReturnType<typeof setTimeout> | undefined;
  let active = false, closed = false, scheduled = false, uncertain: unknown;
  let content: ReturnType<typeof readProjectContentStamp> | undefined;
  let demands: ProcessingDemand[] = [];
  const enabled = () => options.enabled && !closed && db.isOpen &&
    db.prepare('PRAGMA project.user_version').get()?.user_version === FORMAT6_PROJECT_SCHEMA_VERSION &&
    db.prepare('SELECT version FROM main.schema_version').get()?.version === FORMAT6_HISTORY_SCHEMA_VERSION;
  function assertEffect(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    assertProjectStore(store);
    if (!enabled()) throw refused();
    beforeEffect();
  }
  function requireProject(input: {projectId: string}): void {
    if (input.projectId !== projectId) throw new AppError('PROJECT_ID_MISMATCH', '项目地址与请求不一致。', 409);
  }
  function taskById(taskId: string): Task {
    if (!enabled()) throw refused();
    const row = db.prepare('SELECT * FROM main.timeline_processing_tasks WHERE id=? AND projectId=?').get(taskId, projectId);
    if (!row) throw missing();
    return decode(row);
  }
  function taskForKey(key: string): Task | null {
    const row = db.prepare('SELECT * FROM main.timeline_processing_tasks WHERE projectId=? AND demandKey=?').get(projectId, key);
    return row ? decode(row) : null;
  }
  function entryFor(task: Task): ProcessingCacheEntry | null {
    if (!task.result) return null;
    const profile = task.kind === 'preview' ? TIMELINE_PREVIEW_CACHE_PROFILE
      : task.kind === 'optical' ? OPTICAL_PROXY_PROFILE : REVERSE_PROXY_PROFILE;
    const found = cache.lookup(projectId, task.result.cacheKey, profile);
    if (!found || found.result.mapHash !== task.input.frozen.mapHash) return null;
    if (task.kind !== 'optical') return found;
    try {
      return task.result.verifiedProxy && opticalCacheProof(found)?.proof === task.result.verifiedProxy ? found : null;
    } catch {return null;}
  }
  function item(task: Task, clipId = task.input.clipId): SpeedProcessingItem {
    const status = task.state === 'cancelled' || task.state === 'ready' && !entryFor(task)
      || uncertain && activeState(task.state) ? 'failed' : task.state;
    return speedProcessingItemSchema.parse({taskId: task.id, clipId, kind: task.kind, status,
      ...(status === 'running' ? {progress: task.progress ?? 0} : {}),
      ...(status === 'failed' ? {reason: task.input.outcomeReason ?? task.errorCode ?? 'PROCESSING_FAILED'} : {})});
  }
  function emit(): void {for (const listener of [...listeners]) listener();}
  function update(task: Task, state: TaskState, patch: {progress?: number | null; error?: SpeedProcessingReason | null; result?: TaskResult | null;
    attempt?: {requestId: string; input: Task['input']}} = {}): Task {
    const {attempt, progress = null, error = null, result = task.result} = patch;
    const updatedAt = now();
    const {clipId, frozen} = attempt?.input ?? task.input;
    const input = {clipId, frozen};
    const errorCode = error;
    const changed = db.prepare(`UPDATE main.timeline_processing_tasks SET state=?,revision=revision+1,requestId=?,input=?,
      progress=?,errorCode=?,result=?,updatedAt=? WHERE id=? AND projectId=? AND revision=?`)
      .run(state, attempt?.requestId ?? task.requestId, JSON.stringify(input), progress, errorCode,
        result === null ? null : JSON.stringify(result), updatedAt, task.id, projectId, task.revision);
    if (changed.changes !== 1) throw stale();
    markBackgroundTaskChanged(db, taskKind, task.id);
    return {...task, state, revision: task.revision + 1, input, requestId: attempt?.requestId ?? task.requestId,
      progress, errorCode, result, updatedAt};
  }
  function freeze(demand: ProcessingDemand): {input: ProcessingInputWithClip; errorCode: SpeedProcessingReason | null} {
    const frozen = demand.input;
    let reason: SpeedProcessingReason | null = demand.unavailable, sourceStat: string | undefined;
    // A sampled reference alone cannot detect an in-place change between
    // enqueue and admission. Capture its metadata before freezing the input.
    if (!reason && !frozen.sourceSha256 && frozen.assetId) {
      const asset = readOwnedTimelineAsset(db, projectId, frozen.assetId);
      try {sourceStat = sourceStatHash(validateManagedSource(store.projectDir, asset).info);}
      catch (error) {reason = reasonFor(error);}
    }
    return {input: {clipId: demand.clipId, frozen: {...frozen, ...(sourceStat ? {sourceStat} : {})}}, errorCode: reason};
  }
  function record(demand: ProcessingDemand): Task {
    const id = randomUUID(), requestId = randomUUID();
    const {input, errorCode} = freeze(demand);
    const state = errorCode ? 'failed' : 'queued', updatedAt = now();
    db.prepare(`INSERT INTO main.timeline_processing_tasks(id,projectId,demandKey,kind,state,revision,requestId,input,progress,errorCode,result,updatedAt)
      VALUES(?,?,?,?,?,1,?,?,NULL,?,NULL,?)`).run(id, projectId, demand.demandKey, demand.input.kind, state,
      requestId, JSON.stringify(input), errorCode, updatedAt);
    markBackgroundTaskChanged(db, taskKind, id);
    return {id, projectId, demandKey: demand.demandKey, kind: demand.input.kind, state, revision: 1, requestId, input,
      progress: null, errorCode, result: null, updatedAt};
  }
  function reconcilePins(current = currentDemands()): void {
    const keys = new Set<string>();
    let earliestExpiry = Infinity;
    for (const demand of current) {
      const task = taskForKey(demand.demandKey);
      if (task?.result && (activeState(task.state) || task.state === 'ready')) keys.add(task.result.cacheKey);
      const fallback = previewHandoffFallback(demand, task);
      if (fallback) {
        keys.add(fallback.cacheKey);
        if (fallback.expiresAt !== null) earliestExpiry = Math.min(earliestExpiry, fallback.expiresAt);
      }
    }
    cache.setPins(projectId, [...keys], () => assertEffect(ownerSignal));
    if (previewHandoffTimer) clearTimeout(previewHandoffTimer);
    previewHandoffTimer = Number.isFinite(earliestExpiry) ? setTimeout(reconcileSoon, Math.max(1, earliestExpiry - Date.now())) : undefined;
    previewHandoffTimer?.unref();
  }
  function previewDemand(base: ProcessingDemand, optical: ProcessingDemand | undefined): PreviewDemand {
    if (base.input.kind !== 'preview' || base.input.timing?.profile !== 'timeline-speed-v1' ||
        base.input.timing.interpolation !== 'optical' || base.unavailable || !optical || optical.unavailable) return base;
    const task = taskForKey(optical.demandKey);
    if (task?.state !== 'ready' || !task.result?.verifiedProxy) return base;
    // A completed optical attempt produces a new output variant without a
    // project edit. The same binding selects both worker input and HTTP media.
    const recipe = processingHash([base.input.recipe, 'preview-optical-v1', task.id, task.requestId, task.result.verifiedProxy]);
    return {...base, demandKey: processingHash([base.demandKey, recipe]), input: {...base.input, recipe}, opticalTaskId: task.id, offFallback: base};
  }
  function withPreviewVariants(base: readonly ProcessingDemand[]): PreviewDemand[] {
    const optical = new Map(base.filter(demand => demand.input.kind === 'optical').map(demand => [demand.clipId, demand]));
    return base.map(demand => previewDemand(demand, optical.get(demand.clipId)));
  }
  function scanDemands(): ProcessingDemand[] {
    const current = readProcessingDemands(store, Boolean(previewRenderer));
    if (previewBindings.size > 0 && !db.isTransaction) {
      const live = new Map(withPreviewVariants(current).filter(demand => demand.input.kind === 'preview' && !demand.unavailable)
        .map(demand => [demand.clipId, demand]));
      for (const [clipId, bindings] of previewBindings) {
        const demand = live.get(clipId);
        if (!demand) previewBindings.delete(clipId);
        else prunePreviewBindings(demand, bindings);
      }
    }
    return current;
  }
  function currentBaseDemands(): readonly ProcessingDemand[] {
    const latest = readProjectContentStamp(db);
    return content && sameContentStamp(content, latest) ? demands : scanDemands();
  }
  function currentDemands(): readonly PreviewDemand[] {
    return withPreviewVariants(currentBaseDemands());
  }
  function synchronize(): void {
    if (!active || !enabled() || ownerSignal?.aborted || uncertain) return;
    assertEffect(ownerSignal);
    const next = readProjectContentStamp(db);
    let resumed = new Set<string>();
    if (!content || !sameContentStamp(content, next)) {
      const previouslyNeeded = new Set(demands.map(demand => demand.demandKey));
      demands = scanDemands();
      content = next;
      resumed = new Set(demands.map(demand => demand.demandKey).filter(key => !previouslyNeeded.has(key)));
    }
    const live = withPreviewVariants(demands);
    reconcilePins(live);
    const launches: Task[] = [];
    let slots = maxOutstanding - running.size;
    store.tx(() => {
      for (const demand of live) {
        const prior = taskForKey(demand.demandKey);
        let task: Task;
        if (!prior) {
          if (!demand.unavailable && slots === 0) continue;
          task = record(demand);
        } else {
          if (prior.state !== 'ready' || demand.unavailable || running.has(prior.id)) continue;
          const entry = entryFor(prior);
          if (entry) {
            if (resumed.delete(demand.demandKey)) cache.touch(entry, () => assertEffect(ownerSignal));
            continue;
          }
          if (slots === 0) continue;
          // The prior attempt finished. A current demand for an evicted result
          // is a new attempt. Failed and interrupted attempts stay untouched.
          const {input, errorCode} = freeze(demand);
          task = update(prior, errorCode ? 'failed' : 'queued', {result: null, error: errorCode,
            attempt: {requestId: randomUUID(), input}});
        }
        if (task.state === 'queued') {slots--; launches.push(task);}
      }
    });
    for (const task of launches) launch(task);
    emit();
  }
  const reconcileSoon = (): void => {
    if (scheduled || !active || closed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      try {synchronize();}
      catch { /* The committed edit remains available. A later owned operation can rescan. */ }
    });
  };
  // The existing observer executes inside the project transaction. Read the
  // stamp again in the following microtask to ignore every rollback and own
  // history-only write without requiring a hook in the SP-D edit.
  const removeObserver = options.enabled ? registerProjectTransactionObserver(db, () => {
    if (active && enabled() && !sameContentStamp(content ?? {contentSequence: -1, contentToken: ''}, readProjectContentStamp(db))) reconcileSoon();
  }) : noEffect;

  function activate(): void {
    if (active || !enabled()) return;
    assertEffect(ownerSignal);
    cache.reap(projectId, () => assertEffect(ownerSignal));
    const prior = db.prepare(`SELECT * FROM main.timeline_processing_tasks
      WHERE projectId=? AND state IN ('queued','running') ORDER BY id LIMIT ?`).all(projectId, maxOutstanding + 1);
    if (prior.length > maxOutstanding) throw new AppError('SPEED_PROCESSING_UNAVAILABLE', '待查证的变速任务过多。', 409);
    store.tx(() => {
      for (const row of prior) {
        const task = decode(row);
        if (entryFor(task)) update(task, 'ready');
        else update(task, 'failed', {error: 'PROCESSING_FAILED'});
      }
    });
    active = true;
    reconcileSoon();
  }

  async function prepareWork(frozen: ProcessingInput, source: {file: string; sha256: string}, assetId: string,
    mediaOptions: ReverseProxyMediaOptions, opticalVideo?: TimelineOpticalProxyLease['video']) {
    type RenderScope = {stagingDirectory: string; onProgress(percent: number): void; reserveBytes(requiredBytes: number): void;
      writer?: ReverseProxyMediaOptions['writer']};
    if (frozen.kind === 'preview') {
      if (!previewRenderer || frozen.timing?.profile !== 'timeline-speed-v1' || frozen.media !== 'video') {
        throw new ProcessingFailure('UNSUPPORTED_FORMAT');
      }
      const basis = compileTimeMap(frozen.timing.basis);
      const mapped = basis.ok ? restoreTimeMap(basis.value, {...frozen.timing.view, outputWindow: frozen.timing.outputWindow}) : basis;
      const map = mapped.ok ? timeMapPlanInfo(mapped.value) : mapped;
      if (!mapped.ok || !map.ok || map.value.mapHash !== frozen.mapHash) throw new ProcessingFailure('UNSUPPORTED_FORMAT');
      const input: PreviewProcessingInput = {source: {path: source.file}, sourceSha256: source.sha256,
        plan: mapped.value, interpolation: opticalVideo ? 'optical' : frozen.timing.interpolation === 'blend' ? 'blend' : 'off',
        ...(opticalVideo ? {optical: opticalVideo} : {})};
      const prepared = await previewRenderer.prepare(input, mediaOptions);
      if (prepared.profile.profileId !== TIMELINE_PREVIEW_CACHE_PROFILE || prepared.profile.mapHash !== frozen.mapHash ||
          prepared.profile.sourceSha256 !== source.sha256 ||
          prepared.profile.effectiveInterpolation !== input.interpolation) throw new ProcessingFailure('PROCESSING_FAILED');
      return {prepared, profileId: TIMELINE_PREVIEW_CACHE_PROFILE,
        frameCount: mapped.value.durationFrames,
        render: (scope: RenderScope) => previewRenderer.render(input, prepared, {...mediaOptions, ...scope})} as const;
    }
    if (frozen.kind === 'optical') {
      if (!frozen.optical || frozen.media !== 'video' || !frozen.mapHash) throw new ProcessingFailure('UNSUPPORTED_FORMAT');
      const input = {sourcePath: source.file, mapHash: frozen.mapHash, window: frozen.optical, sceneCuts() {
        mediaOptions.beforeEffect();
        const history = createSceneHistoryReaders({db});
        const savedId = history.schemaPresent() ? history.latestResultId(projectId, assetId) : null;
        const saved = savedId ? history.result(projectId, savedId) : null;
        if (saved?.sourceHash === source.sha256 && saved.profileId === SCENE_DETECTION_PROFILE_ID) {
          return saved.cuts.map(cut => cut.frame);
        }
        return null;
      }};
      const prepared = await prepareOpticalProxy(input, mediaOptions);
      return {prepared, profileId: OPTICAL_PROXY_PROFILE, frameCount: prepared.profile.frameCount,
        render: (scope: RenderScope) => renderOpticalProxy(input, prepared, {...mediaOptions, ...scope})} as const;
    }
    if (!frozen.media || !frozen.mapHash || !frozen.sourceWindow || !frozen.sourceFps) {
      throw new ProcessingFailure('UNSUPPORTED_FORMAT');
    }
    const input: ReverseProxyInput = {sourcePath: source.file, sourceSha256: source.sha256, media: frozen.media,
      mapHash: frozen.mapHash, sourceWindow: frozen.sourceWindow, sourceFps: frozen.sourceFps,
      ...(frozen.audioWindow ? {audioWindow: frozen.audioWindow} : {}),
      ...(frozen.pictureWindow ? {pictureWindow: frozen.pictureWindow} : {})};
    const prepared = await engine.prepare(input, mediaOptions);
    if (prepared.profile.id !== REVERSE_PROXY_PROFILE) throw new ProcessingFailure('PROCESSING_FAILED');
    return {prepared, profileId: REVERSE_PROXY_PROFILE, frameCount: undefined,
      render: (scope: RenderScope) => engine.render(input, prepared, {...mediaOptions, ...scope})} as const;
  }

  function launch(original: Task): void {
    if (closed || running.has(original.id)) return;
    const controller = new AbortController();
    const signal = ownerSignal ? AbortSignal.any([controller.signal, ownerSignal]) : controller.signal;
    const attempt = {controller, cancel: false, done: Promise.resolve()};
    running.set(original.id, attempt);
    let current = original;
    const sameAttempt = (): Task => {
      const stored = taskById(original.id);
      if (stored.requestId !== original.requestId || !activeState(stored.state)) throw stale();
      return stored;
    };
    const effect = (): void => {assertEffect(signal); sameAttempt();};
    let stage: ReturnType<ProcessingCache['stage']> | undefined;
    let opticalLease: TimelineOpticalProxyLease | null = null;
    const perform = async (): Promise<void> => {
      effect();
      current = store.tx(() => update(sameAttempt(), 'running', {progress: 0}));
      emit();
      const frozen: ProcessingInput = original.input.frozen;
      if (!frozen.assetId || !frozen.sourceIdentity) {
        throw new ProcessingFailure('UNSUPPORTED_FORMAT');
      }
      const assetId = frozen.assetId;
      const asset = readOwnedTimelineAsset(db, projectId, assetId);
      if (!asset || processingSourceIdentity(asset) !== frozen.sourceIdentity) throw new ProcessingFailure('SOURCE_UNAVAILABLE');
      const expected = frozen.sourceStat ? validateManagedSource(store.projectDir, asset).info : undefined;
      if (expected && sourceStatHash(expected) !== frozen.sourceStat) throw new ProcessingFailure('SOURCE_UNAVAILABLE');
      const source = await verifiedManagedHash(store.projectDir, asset, {signal, expected, beforeEffect: effect});
      if (frozen.sourceSha256 && source.sha256 !== frozen.sourceSha256) throw new ProcessingFailure('SOURCE_UNAVAILABLE');
      const checkSource = (): void => {
        effect();
        const latest = readOwnedTimelineAsset(db, projectId, assetId);
        if (!latest || processingSourceIdentity(latest) !== frozen.sourceIdentity ||
            !sameManagedFile(validateManagedSource(store.projectDir, latest).info, source.info)) {
          throw new ProcessingFailure('SOURCE_UNAVAILABLE');
        }
      };
      const timing = frozen.timing;
      if (frozen.kind === 'preview' && timing?.profile === 'timeline-speed-v1' && timing.interpolation === 'optical' && frozen.mapHash) {
        // The fallback uses the base demand key. A refined attempt whose
        // dependency disappeared cannot ever publish fallback bytes under it.
        const baseKey = processingHash([projectId, frozen.recipe, frozen.sourceSha256 ?? frozen.sourceIdentity]);
        if (original.demandKey !== baseKey) {
          const selection = currentDemands().find(value => value.demandKey === original.demandKey);
          if (!selection?.opticalTaskId) throw stale();
          const request: TimelineOpticalProxyRequest = {projectId, clipId: selection.clipId, timelineId: frozen.timelineId,
            assetId: selection.input.assetId ?? assetId, sourceSha256: source.sha256, mapHash: frozen.mapHash, timing,
            outputWindow: {fromFrame: 0, toFrame: timing.outputWindow.toFrame - timing.outputWindow.fromFrame}};
          const proof = opticalProxy.lookup(request);
          if (proof?.taskId !== selection.opticalTaskId || !proof.readySha256) throw new ProcessingFailure('INTERPOLATION_UNAVAILABLE');
          opticalLease = await opticalProxy.acquire(request, {taskId: proof.taskId, sha256: proof.readySha256},
            {signal, beforeEffect: checkSource});
          if (!opticalLease) throw new ProcessingFailure('INTERPOLATION_UNAVAILABLE');
        }
      }
      const checkInput = (): void => {
        checkSource();
        if (opticalLease && !opticalLease.verify()) throw new ProcessingFailure('INTERPOLATION_UNAVAILABLE');
      };
      const mediaOptions = {signal, ...(ownerSignal ? {ownerSignal} : {}), beforeEffect: checkInput};
      const work = await prepareWork(frozen, source, assetId, mediaOptions, opticalLease?.video);
      checkInput();
      const cacheKey = processingHash([projectId, frozen.recipe, source.sha256, work.prepared.profile]);
      const result: TaskResult = {cacheKey, sourceSha256: source.sha256, sourceStat: sourceStatHash(source.info)};
      current = store.tx(() => update(sameAttempt(), 'running', {progress: current.progress, result}));
      reconcilePins();
      let existing = cache.lookup(projectId, cacheKey, work.profileId);
      if (existing && frozen.kind === 'optical') {
        let verified: Awaited<ReturnType<typeof verifyOpticalCache>> = null;
        try {verified = await verifyOpticalCache(existing, mediaOptions);}
        catch (error) {
          if (errorCode(error) !== 'WORKSPACE_BACKUP_CHANGED') throw error;
        }
        if (!verified || verified.result.mapHash !== frozen.mapHash) {
          cache.invalidate(existing, checkSource);
          existing = null;
        }
      }
      if (existing?.result.mapHash === frozen.mapHash) cache.touch(existing, checkInput);
      else {
        stage = cache.stage(projectId, cacheKey, work.prepared.reservationBytes, checkInput,
          {taskId: original.id, requestId: original.requestId});
        const rendered = processingProxyResultSchema.parse(await work.render({stagingDirectory: stage.directory,
          reserveBytes: stage.grow, ...(stage.writer ? {writer: stage.writer} : {}), onProgress(percent) {
          checkInput();
          // Durable progress is deliberately coarser than encoder callbacks.
          const progress = Math.min(99, Math.floor(percent));
          if (progress < (current.progress ?? 0) + 5) return;
          current = store.tx(() => update(sameAttempt(), 'running', {progress}));
          emit();
        }}));
        checkInput();
        if (rendered.profileId !== work.profileId || rendered.mapHash !== frozen.mapHash ||
            work.frameCount !== undefined && rendered.frameCount !== work.frameCount) throw new ProcessingFailure('PROCESSING_FAILED');
        existing = stage.publish(rendered);
      }
      checkInput();
      if (frozen.kind === 'optical') {
        const proof = existing && opticalCacheProof(existing)?.proof;
        if (!proof) throw new ProcessingFailure('PROCESSING_FAILED');
        result.verifiedProxy = proof;
      }
      current = store.tx(() => update(sameAttempt(), 'ready', {result}));
      reconcilePins();
      emit();
    };
    attempt.done = scheduler.schedule(signal, async () => {
      try {await perform();}
      catch (error) {
        if (terminationUnconfirmed(error)) stage?.retain();
        else {
          try {stage?.discard();}
          catch (cleanupError) {attempt.cancel = false; throw new ProcessingFailure('PROCESSING_FAILED', {cause: cleanupError});}
        }
        throw error;
      }
    }).catch(error => {
      if (terminationUnconfirmed(error)) {
        uncertain = error;
        if (db.isOpen) markBackgroundTaskInvalid(db, {kind: taskKind, taskId: original.id});
        return;
      }
      if (closed || ownerSignal?.aborted) return;
      try {
        assertEffect();
        const stored = sameAttempt();
        store.tx(() => update(stored, attempt.cancel ? 'cancelled' : 'failed', {
          error: attempt.cancel ? 'PROCESSING_FAILED' : reasonFor(error),
        }));
      } catch (failure) {
        // Source failure belongs to this task. Store/ownership failure cannot
        // write a terminal result against a moved or read-only project.
        pauseUnavailableBackgroundTask(db, {kind: taskKind, taskId: original.id}, failure);
      }
    }).finally(() => {
      const held = opticalLease;
      if (held) {
        if (uncertain || hasUnconfirmedMediaProcesses({signal})) {
          void waitForMediaProcesses({signal}).then(() => held.release()).catch(() => {});
        } else held.release();
      }
      running.delete(original.id);
      emit();
      reconcileSoon();
    });
  }

  function list(input: {projectId: string}): {items: SpeedProcessingItem[]} {
    requireProject(input);
    if (!enabled()) return {items: []};
    const items: SpeedProcessingItem[] = [];
    for (const demand of currentDemands()) {
      const task = taskForKey(demand.demandKey);
      if (task) items.push(item(task, demand.clipId));
    }
    return {items};
  }
  function inspect(input: {projectId: string; taskId: string}): {item: SpeedProcessingItem} {
    requireProject(input); return {item: item(taskById(input.taskId))};
  }
  function sourceEvidence(task: Task, frozen: ProcessingInput): ManagedFileIdentity | null {
    if (!frozen.assetId || !task.result) return null;
    const source = readOwnedTimelineAsset(db, projectId, frozen.assetId);
    if (!source || processingSourceIdentity(source) !== frozen.sourceIdentity ||
        frozen.sourceSha256 && frozen.sourceSha256 !== task.result.sourceSha256) return null;
    try {
      const {info} = validateManagedSource(store.projectDir, source);
      const expected = frozen.assetId === task.input.frozen.assetId
        ? task.result.sourceStat ?? frozen.sourceStat : frozen.sourceStat;
      return !expected || expected === sourceStatHash(info) ? info : null;
    } catch {return null;}
  }
  function readPreviewDemand(input: PreviewProcessingRequest): PreviewDemand | null {
    if (input.projectId !== projectId || !enabled() || ownerSignal?.aborted) return null;
    const current = currentBaseDemands();
    const base = current.find(value => value.clipId === input.clipId && value.input.kind === 'preview');
    return base ? previewDemand(base, current.find(value => value.clipId === input.clipId && value.input.kind === 'optical')) : null;
  }
  function readPreviewTask(input: PreviewProcessingRequest) {
    const demand = readPreviewDemand(input);
    if (!demand) return null;
    const task = taskForKey(demand.demandKey);
    return task ? {demand, task} : null;
  }
  function prunePreviewBindings(demand: PreviewDemand, bindings: Map<string, Buffer>): void {
    const currentKey = previewBindingKey(demand);
    const fallbackKey = demand.offFallback && previewBindingKey(demand.offFallback);
    for (const key of bindings.keys()) if (key !== currentKey && key !== fallbackKey) bindings.delete(key);
    if (!bindings.size) previewBindings.delete(demand.clipId);
  }
  function previewHandoffFallback(demand: PreviewDemand, successor: Task | null) {
    const base = demand.offFallback;
    if (!base) return null;
    const bindings = previewBindings.get(base.clipId);
    const key = previewBindingKey(base);
    if (!bindings?.has(key)) return null;
    const readyAt = successor?.state === 'ready' ? Date.parse(successor.updatedAt) : null;
    const age = readyAt === null ? null : Date.now() - readyAt;
    // A malformed or future persisted clock cannot extend an old proof's life.
    const graceEnded = age === null ? successor !== null && !activeState(successor.state)
      : !(age >= 0 && age < opticalHandoffGraceMs);
    if (graceEnded) {
      bindings.delete(key);
      if (!bindings.size) previewBindings.delete(base.clipId);
      return null;
    }
    const task = taskForKey(base.demandKey);
    const expiresAt = readyAt === null ? null : readyAt + opticalHandoffGraceMs;
    return task?.state === 'ready' && task.result ? {demand: base, task, cacheKey: task.result.cacheKey, expiresAt} : null;
  }
  function readPreviewLeaseTask(input: PreviewProcessingProof) {
    const demand = readPreviewDemand(input);
    if (!demand) return null;
    const task = taskForKey(demand.demandKey);
    if (task?.id === input.taskId) return {demand, task};
    const fallback = previewHandoffFallback(demand, task);
    return fallback?.task.id === input.taskId ? fallback : null;
  }
  function readPreviewEvidence({demand, task}: NonNullable<ReturnType<typeof readPreviewTask>>) {
    if (task.state !== 'ready' || !task.result || demand.unavailable || demand.input.timing?.profile !== 'timeline-speed-v1') return null;
    const source = sourceEvidence(task, demand.input);
    if (!source) return null;
    const owned = cache.lookupWithClock(projectId, task.result.cacheKey, TIMELINE_PREVIEW_CACHE_PROFILE);
    const output = demand.input.timing.outputWindow;
    const durationFrames = output.toFrame - output.fromFrame;
    if (!owned || owned.entry.result.mapHash !== demand.input.mapHash || owned.entry.result.frameCount !== durationFrames) return null;
    try {
      const clock = JSON.parse(owned.clock.toString('utf8'));
      const effective = demand.opticalTaskId ? 'optical' : demand.input.timing.interpolation === 'blend' ? 'blend' : 'off';
      if (!clock || clock.profileId !== TIMELINE_PREVIEW_CACHE_PROFILE || clock.mapHash !== demand.input.mapHash ||
          clock.sourceSha256 !== task.result.sourceSha256 || clock.frameCount !== durationFrames ||
          clock.effectiveInterpolation !== effective) return null;
    } catch {return null;}
    return {source, owned, durationFrames};
  }
  function previewCredential(demand: PreviewDemand, task: Task, receiptDigest: string, issue = false): string | null {
    const key = previewBindingKey(demand);
    let bindings = previewBindings.get(demand.clipId);
    let secret = bindings?.get(key);
    if (!secret) {
      if (!issue || db.isTransaction) return null;
      bindings ??= new Map();
      secret = randomBytes(32);
      bindings.set(key, secret);
      prunePreviewBindings(demand, bindings);
      previewBindings.set(demand.clipId, bindings);
    }
    return createHmac('sha256', secret).update(JSON.stringify([
      projectId, demand.clipId, key, task.id, task.requestId, receiptDigest,
    ])).digest('hex');
  }
  const preview: PreviewProcessingPort = {
    lookup(input) {
      const selection = readPreviewTask(input);
      if (!selection) {
        const dependency = readPreviewDemand(input)?.opticalTaskId;
        // The dependency can complete between two scheduling passes.
        return dependency ? {item: {kind: 'optical', status: 'queued', taskId: dependency, clipId: input.clipId}} : null;
      }
      const summary = item(selection.task, input.clipId);
      if (summary.status !== 'ready') return {item: summary};
      const evidence = readPreviewEvidence(selection);
      if (!evidence) return {item: {...summary, status: 'failed', reason: 'PROCESSING_FAILED'}};
      const sha256 = previewCredential(selection.demand, selection.task, evidence.owned.digest, true);
      if (!sha256) return {item: summary};
      return {item: summary, ready: {proof: {projectId, clipId: input.clipId, taskId: summary.taskId, sha256},
        durationFrames: evidence.durationFrames}};
    },
    async acquire(input, options = {}) {
      options.signal?.throwIfAborted();
      options.beforeEffect?.();
      if (!processingDigestSchema.safeParse(input.sha256).success) return null;
      const selection = readPreviewLeaseTask(input);
      if (!selection) return null;
      const evidence = readPreviewEvidence(selection);
      if (!evidence) return null;
      const expected = previewCredential(selection.demand, selection.task, evidence.owned.digest);
      if (!expected || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.sha256, 'hex'))) return null;
      const lease = await cache.acquire(projectId, evidence.owned.entry.cacheKey, TIMELINE_PREVIEW_CACHE_PROFILE,
        {...options, expectedDigest: evidence.owned.digest});
      if (!lease) return null;
      const verify = (): boolean => {
        try {
          if (options.signal?.aborted) return false;
          options.beforeEffect?.();
          const current = readPreviewLeaseTask(input);
          if (!current || current.demand.unavailable || current.task.state !== 'ready' || current.task.id !== input.taskId ||
              current.task.requestId !== selection.task.requestId || current.task.result?.cacheKey !== lease.entry.cacheKey ||
              previewCredential(current.demand, current.task, lease.digest) !== expected ||
              !sameManagedFile(sourceEvidence(current.task, current.demand.input), evidence.source)) return false;
          lease.verify();
          return true;
        } catch {return false;}
      };
      if (!verify()) {lease.release(); return null;}
      return {proof: {projectId, clipId: input.clipId, taskId: input.taskId, sha256: input.sha256},
        file: path.join(lease.entry.directory, 'preview.mp4'), durationFrames: evidence.durationFrames,
        verify, release: lease.release};
    },
  };
  function resolveReverseTask(request: TimelineReverseProxyRequest, taskId?: string) {
    if (request.projectId !== projectId || !enabled() || ownerSignal?.aborted) return null;
    const demand = currentBaseDemands().find(value => value.clipId === request.clipId && value.input.kind === 'reverse');
    let task: Task | null;
    try {task = taskId ? taskById(taskId) : demand ? taskForKey(demand.demandKey) : null;}
    catch (error) {if (errorCode(error) === 'SPEED_PROCESSING_TASK_NOT_FOUND') return null; throw error;}
    if (!task || task.kind !== 'reverse') return null;
    // Existing export snapshots can continue to use the original clip's task
    // after an edit. Shared aliases must still be members of that same demand.
    const frozen = demand?.demandKey === task.demandKey ? demand.input
      : taskId && task.input.clipId === request.clipId ? task.input.frozen : null;
    if (!frozen || frozen.timelineId !== request.timelineId || frozen.assetId !== request.assetId ||
        frozen.mapHash !== request.mapHash || frozen.media !== request.media ||
        processingHash(frozen.sourceFps) !== processingHash(request.sourceFps) ||
        processingHash(frozen.sourceWindow) !== processingHash(request.sourceWindow) ||
        frozen.sourceSha256 && frozen.sourceSha256 !== request.sourceSha256) return null;
    const ready = task.state === 'ready' && task.result?.sourceSha256 === request.sourceSha256 &&
      (demand?.demandKey !== task.demandKey || !demand.unavailable) && sourceEvidence(task, frozen);
    return {taskId: task.id, ...(ready && task.result ? {ready: {
      cacheKey: task.result.cacheKey, requestId: task.requestId,
    }} : {})};
  }
  const reverseProxy = createTimelineReverseProxyPort({resolveTask: resolveReverseTask, cache});
  function wait(input: {projectId: string; taskId: string; timeoutMs?: number}, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const initial = inspect(input).item;
    if (!activeState(initial.status)) return Promise.resolve({item: initial, timedOut: false});
    return new Promise<{item: SpeedProcessingItem; timedOut: boolean}>((resolve, reject) => {
      const timer = setTimeout(() => finish(true), input.timeoutMs ?? TIMELINE_PROCESSING_WAIT_DEFAULT_MS);
      const cleanup = () => {clearTimeout(timer); listeners.delete(change); signal?.removeEventListener('abort', abort);};
      function abort(): void {cleanup(); reject(signal?.reason);}
      function finish(timedOut: boolean): void {
        try {
          const current = inspect(input).item;
          if (!timedOut && activeState(current.status)) return;
          cleanup(); resolve({item: current, timedOut: timedOut && activeState(current.status)});
        } catch (error) {cleanup(); reject(error);}
      }
      const change = () => finish(false);
      listeners.add(change);
      signal?.addEventListener('abort', abort, {once: true});
    });
  }
  function retry(input: {projectId: string; taskId: string; requestId: string}, approved = noEffect) {
    requireProject(input);
    if (!active || uncertain) throw refused();
    const initial = taskById(input.taskId);
    const prior = db.prepare('SELECT taskId FROM main.timeline_processing_retries WHERE requestId=?').get(input.requestId);
    if (prior) {
      if (prior.taskId !== input.taskId) throw new AppError('REQUEST_ID_REUSED', '请求 ID 已用于其他任务。', 409);
      return {taskId: initial.id};
    }
    const demand = currentDemands().find(value => value.demandKey === initial.demandKey);
    if (!demand) throw stale();
    if (running.has(initial.id) || activeState(initial.state) || item(initial).status === 'ready' || running.size >= maxOutstanding) {
      throw new AppError('SPEED_PROCESSING_BUSY', '当前任务不能重试。', 409);
    }
    assertEffect(ownerSignal);
    approved();
    const queued = store.tx(() => {
      db.prepare('INSERT INTO main.timeline_processing_retries(requestId,taskId) VALUES(?,?)').run(input.requestId, initial.id);
      return update(initial, demand.unavailable ? 'failed' : 'queued', {result: null, error: demand.unavailable,
        attempt: {requestId: input.requestId, input: initial.input}});
    });
    if (queued.state === 'queued') launch(queued);
    reconcileSoon(); emit();
    return {taskId: initial.id};
  }
  async function cancel(input: {projectId: string; taskId: string}, approved = noEffect) {
    requireProject(input);
    const task = taskById(input.taskId);
    if (!activeState(task.state)) return {status: item(task).status};
    const attempt = running.get(task.id);
    if (!attempt || uncertain) throw refused();
    assertEffect(ownerSignal);
    approved();
    attempt.cancel = true;
    attempt.controller.abort();
    await attempt.done;
    if (uncertain) throw refused();
    return {status: item(taskById(task.id)).status};
  }
  function cacheGet(input: {projectId: string}) {
    requireProject(input);
    return enabled() ? cache.stats(projectId) : {usedBytes: 0, limitBytes: PROCESSING_CACHE_LIMIT_BYTES};
  }
  function cacheClear(input: {projectId: string}, approved = noEffect) {
    requireProject(input);
    const check = () => {assertEffect(ownerSignal); approved();};
    check();
    // Bind current clips before eviction, even when a commit has just queued
    // its deferred scan. The request remains scoped to this project.
    reconcilePins(currentDemands());
    return cache.clear(projectId, check);
  }
  function resolveOptical(request: TimelineOpticalProxyRequest, frozenTaskId?: string): ResolvedOpticalProxy | null {
    if (!enabled() || ownerSignal?.aborted || uncertain || request.projectId !== projectId) return null;
    const {clipId, timelineId, assetId, mapHash, timing, sourceSha256, outputWindow: {fromFrame, toFrame}} = request;
    if (!Number.isSafeInteger(fromFrame) || !Number.isSafeInteger(toFrame) || fromFrame >= toFrame) return null;
    const timingHash = processingHash(timing);
    const matches = (frozen: ProcessingInput): boolean =>
      frozen.kind === 'optical' && frozen.timelineId === timelineId && frozen.mapHash === mapHash &&
      (!frozen.sourceSha256 || frozen.sourceSha256 === sourceSha256) && processingHash(frozen.optical?.timing ?? null) === timingHash;
    let task: Task | null = null;
    if (frozenTaskId) {
      // Existing exports own the snapshot's verified task, even after a
      // timeline edit. Identical frozen source bytes may share a prior task.
      const row = db.prepare('SELECT * FROM main.timeline_processing_tasks WHERE id=? AND projectId=?').get(frozenTaskId, projectId);
      if (row) task = decode(row);
    } else {
      const demand = currentBaseDemands().find(value => value.clipId === clipId && value.input.assetId === assetId && matches(value.input));
      if (demand) task = taskForKey(demand.demandKey);
    }
    if (!task || !matches(task.input.frozen) || task.result && task.result.sourceSha256 !== sourceSha256) return null;
    if (task.state !== 'ready') return {taskId: task.id, reason: item(task, clipId).reason};
    const entry = entryFor(task);
    if (entry?.result.profileId !== OPTICAL_PROXY_PROFILE || fromFrame < entry.result.firstOutputFrame ||
        toFrame > entry.result.firstOutputFrame + entry.result.frameCount) {
      return {taskId: task.id, reason: 'PROCESSING_FAILED'};
    }
    return {taskId: task.id, entry, verifiedProxy: task.result?.verifiedProxy};
  }
  const opticalProxy = createOpticalProxyPort(cache, resolveOptical, assertEffect);

  async function close(): Promise<void> {
    closed = true;
    if (previewHandoffTimer) clearTimeout(previewHandoffTimer);
    previewBindings.clear();
    removeObserver();
    for (const attempt of running.values()) attempt.controller.abort();
    emit();
    await Promise.all([...running.values()].map(attempt => attempt.done));
    if (uncertain) throw uncertain;
  }
  return {enabled, activate, close, list, inspect, wait, retry, cancel, cacheGet, cacheClear, preview, reverseProxy, opticalProxy};
}
