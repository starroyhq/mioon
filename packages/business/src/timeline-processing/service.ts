import {randomUUID} from 'node:crypto';
import {SCENE_DETECTION_PROFILE_ID} from '../../../contracts/src/scene-tasks.ts';
import {AppError} from '../../../contracts/src/app-error.ts';
import {speedProcessingItemSchema, TIMELINE_PROCESSING_WAIT_DEFAULT_MS} from '../../../contracts/src/timeline-processing.ts';
import type {SpeedProcessingItem, SpeedProcessingReason} from '../../../contracts/src/timeline-speed.ts';
import {processingInputWithClipSchema as inputWithClipSchema, processingReasonSchema as reasons,
  processingRowSchema as rowSchema, processingResultSchema as resultSchema} from '../../../contracts/src/timeline-processing-storage.ts';
import type {ProcessingInput, ProcessingInputWithClip, ProcessingTaskRow, ProcessingTaskState as TaskState,
  ProcessingTaskResult as TaskResult} from '../../../contracts/src/timeline-processing-storage.ts';
import {markBackgroundTaskChanged} from '../background-task-events.ts';
import {pauseUnavailableBackgroundTask, markBackgroundTaskInvalid} from '../background-task-state.ts';
import {verifiedManagedHash, sameManagedFile, validateManagedSource} from '../managed-media.ts';
import type {ManagedFileIdentity} from '../managed-media.ts';
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
import type {TimelineOpticalProxyRequest} from './optical-proxy-port.ts';
import {prepareOpticalProxy, renderOpticalProxy} from './optical.ts';
import {PROCESSING_CACHE_LIMIT_BYTES, ProcessingFailure} from './cache.ts';
import type {ProcessingCache, ProcessingCacheEntry} from './cache.ts';
import {processingHash, processingSourceIdentity, readProcessingDemands} from './demand.ts';
import type {ProcessingDemand} from './demand.ts';
import {prepareReverseProxy, renderReverseProxy} from './reverse.ts';
import type {ReverseProxyInput} from './reverse.ts';
import type {ProcessingScheduler} from './scheduler.ts';

const taskKind = 'timeline-processing' as const;
type Task = Omit<ProcessingTaskRow, 'input' | 'result'> & {
  readonly input: ProcessingInputWithClip; readonly result: TaskResult | null;
};
type StoredReason = NonNullable<ProcessingTaskRow['errorCode']>;
const activeState = (state: TaskState) => state === 'queued' || state === 'running';
const maxOutstanding = 64;
const noEffect = () => {};
const missing = () => new AppError('SPEED_PROCESSING_TASK_NOT_FOUND', '找不到该变速任务。', 404);
const stale = () => new AppError('SPEED_PROCESSING_STALE', '片段的变速设置已变化，请重新读取。', 409);
const refused = () => new AppError('SPEED_PROCESSING_UNAVAILABLE', '当前项目的变速后台处理不可用。', 409);
const terminationUnconfirmed = (error: unknown) => Boolean(error && typeof error === 'object' &&
  'terminationUnconfirmed' in error && error.terminationUnconfirmed);
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;
const sourceStatHash = (info: ManagedFileIdentity) => processingHash([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
function reasonFor(error: unknown): SpeedProcessingReason {
  const code = errorCode(error), direct = reasons.safeParse(code);
  if (code === 'INTERPOLATION_UNAVAILABLE') return code;
  if (direct.success) return direct.data;
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'DISK_FULL';
  if (typeof code === 'string' && (code.startsWith('MANAGED_SOURCE') || code.startsWith('MEDIA_') ||
    ['ENOENT', 'EACCES', 'EPERM'].includes(code))) return 'SOURCE_UNAVAILABLE';
  return 'PROCESSING_FAILED';
}
const now = () => new Date().toISOString();
// Format 6 history's v14 task table predates the detailed phase reason.
// Keep its admitted column value and persist the more specific outcome in
// the typed attempt envelope, alongside the frozen optical request.
const storedReason = (reason: SpeedProcessingReason | null): StoredReason | null => reason === 'INTERPOLATION_UNAVAILABLE' ? 'UNSUPPORTED_FORMAT' : reason;
function withOutcome(input: ProcessingInputWithClip, reason: SpeedProcessingReason | null): ProcessingInputWithClip {
  const {clipId, frozen} = input;
  return {clipId, frozen, ...(reason === 'INTERPOLATION_UNAVAILABLE' ? {outcomeReason: reason} : {})};
}
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
}

export function createTimelineProcessingService(store: ProjectStore, options: ProcessingServiceOptions) {
  const {db, projectId} = store;
  const {cache, scheduler, ownerSignal, beforeEffect, engine = {prepare: prepareReverseProxy, render: renderReverseProxy}} = options;
  const running = new Map<string, {controller: AbortController; done: Promise<void>; cancel: boolean}>();
  const listeners = new Set<() => void>();
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
    const found = cache.lookup(projectId, task.result.cacheKey);
    if (!found || found.result.mapHash !== task.input.frozen.mapHash) return null;
    if (task.kind === 'reverse') return found.result.profileId === 'timeline-reverse-source-v1' ? found : null;
    try {
      return task.result.verifiedProxy && opticalCacheProof(found)?.proof === task.result.verifiedProxy ? found : null;
    } catch { return null; }
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
    const updatedAt = now(), input = withOutcome(attempt?.input ?? task.input, error), errorCode = storedReason(error);
    const changed = db.prepare(`UPDATE main.timeline_processing_tasks SET state=?,revision=revision+1,requestId=?,input=?,
      progress=?,errorCode=?,result=?,updatedAt=? WHERE id=? AND projectId=? AND revision=?`)
      .run(state, attempt?.requestId ?? task.requestId, JSON.stringify(input), progress, errorCode,
        result === null ? null : JSON.stringify(result), updatedAt, task.id, projectId, task.revision);
    if (changed.changes !== 1) throw stale();
    markBackgroundTaskChanged(db, taskKind, task.id);
    return {...task, state, revision: task.revision + 1, input, requestId: attempt?.requestId ?? task.requestId,
      progress, errorCode, result, updatedAt};
  }
  function record(demand: ProcessingDemand): Task {
    const id = randomUUID(), requestId = randomUUID();
    const frozen = demand.input;
    let reason: SpeedProcessingReason | null = demand.unavailable, sourceStat: string | undefined;
    // A sampled reference alone cannot detect an in-place change between
    // enqueue and admission. Capture its metadata before freezing the input.
    if (!reason && !frozen.sourceSha256 && frozen.assetId) {
      const asset = readOwnedTimelineAsset(db, projectId, frozen.assetId);
      try {sourceStat = sourceStatHash(validateManagedSource(store.projectDir, asset).info);}
      catch (error) {reason = reasonFor(error);}
    }
    const state = reason ? 'failed' : 'queued', errorCode = storedReason(reason);
    const input = withOutcome({clipId: demand.clipId, frozen: {...frozen, ...(sourceStat ? {sourceStat} : {})}}, reason), updatedAt = now();
    db.prepare(`INSERT INTO main.timeline_processing_tasks(id,projectId,demandKey,kind,state,revision,requestId,input,progress,errorCode,result,updatedAt)
      VALUES(?,?,?,?,?,1,?,?,NULL,?,NULL,?)`).run(id, projectId, demand.demandKey, demand.input.kind, state,
      requestId, JSON.stringify(input), errorCode, updatedAt);
    markBackgroundTaskChanged(db, taskKind, id);
    return {id, projectId, demandKey: demand.demandKey, kind: demand.input.kind, state, revision: 1, requestId, input,
      progress: null, errorCode, result: null, updatedAt};
  }
  function reconcilePins(): void {
    const keys = new Set<string>();
    for (const {demandKey} of demands) {
      const task = taskForKey(demandKey);
      if (task?.result && (activeState(task.state) || task.state === 'ready')) keys.add(task.result.cacheKey);
    }
    cache.setPins(projectId, [...keys], () => assertEffect(ownerSignal));
  }
  function synchronize(): void {
    if (!active || !enabled() || ownerSignal?.aborted || uncertain) return;
    assertEffect(ownerSignal);
    const next = readProjectContentStamp(db);
    if (!content || !sameContentStamp(content, next)) {
      demands = readProcessingDemands(store);
      content = next;
    }
    reconcilePins();
    const launches: Task[] = [];
    let slots = maxOutstanding - running.size;
    store.tx(() => {
      for (const demand of demands) {
        if (taskForKey(demand.demandKey)) continue;
        if (!demand.unavailable && slots === 0) continue;
        const task = record(demand);
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
    const perform = async (): Promise<void> => {
      effect();
      current = store.tx(() => update(sameAttempt(), 'running', {progress: 0}));
      emit();
      const frozen: ProcessingInput = original.input.frozen;
      if (!frozen.media || !frozen.mapHash || !frozen.sourceFps || !frozen.sourceWindow || !frozen.assetId || !frozen.sourceIdentity) {
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
      const input: ReverseProxyInput = {sourcePath: source.file, sourceSha256: source.sha256, media: frozen.media,
        mapHash: frozen.mapHash, sourceWindow: frozen.sourceWindow, sourceFps: frozen.sourceFps};
      const mediaOptions = {signal, ...(ownerSignal ? {ownerSignal} : {}), beforeEffect: checkSource};
      const prepare = async () => {
        if (frozen.kind === 'reverse') {
          const prepared = await engine.prepare(input, mediaOptions);
          return {prepared, render: (renderOptions: Parameters<typeof renderReverseProxy>[2]) => engine.render(input, prepared, renderOptions)};
        }
        if (!frozen.optical || frozen.media !== 'video') throw new ProcessingFailure('UNSUPPORTED_FORMAT');
        const optical = {sourcePath: source.file, mapHash: input.mapHash, window: frozen.optical, sceneCuts() {
          checkSource();
          const history = createSceneHistoryReaders({db});
          const savedId = history.schemaPresent() ? history.latestResultId(projectId, assetId) : null;
          const saved = savedId ? history.result(projectId, savedId) : null;
          if (saved?.sourceHash === source.sha256 && saved.profileId === SCENE_DETECTION_PROFILE_ID) {
            return saved.cuts.map(cut => cut.frame);
          }
          return null;
        }};
        const prepared = await prepareOpticalProxy(optical, mediaOptions);
        return {prepared, render: (renderOptions: Parameters<typeof renderOpticalProxy>[2]) => renderOpticalProxy(optical, prepared, renderOptions)};
      };
      const {prepared, render} = await prepare();
      checkSource();
      const cacheKey = processingHash([projectId, frozen.recipe, source.sha256, prepared.profile]);
      const result: TaskResult = {cacheKey, sourceSha256: source.sha256};
      current = store.tx(() => update(sameAttempt(), 'running', {progress: current.progress, result}));
      reconcilePins();
      let existing = cache.lookup(projectId, cacheKey);
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
      if (existing?.result.mapHash === frozen.mapHash) cache.touch(existing, checkSource);
      else {
        stage = cache.stage(projectId, cacheKey, prepared.reservationBytes, checkSource);
        const rendered = await render({...mediaOptions, stagingDirectory: stage.directory, onProgress(percent) {
          checkSource();
          // Durable progress is deliberately coarser than encoder callbacks.
          const progress = Math.min(99, Math.floor(percent));
          if (progress < (current.progress ?? 0) + 5) return;
          current = store.tx(() => update(sameAttempt(), 'running', {progress}));
          emit();
        }});
        checkSource();
        existing = stage.publish(rendered);
      }
      checkSource();
      if (frozen.kind === 'optical') {
        const proof = opticalCacheProof(existing)?.proof;
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
      running.delete(original.id);
      emit();
      reconcileSoon();
    });
  }

  function currentDemands(): ProcessingDemand[] {
    const latest = readProjectContentStamp(db);
    return content && sameContentStamp(content, latest) ? demands : readProcessingDemands(store);
  }
  function list(input: {projectId: string}): {items: SpeedProcessingItem[]} {
    requireProject(input);
    if (!enabled()) return {items: []};
    const current = currentDemands();
    const items: SpeedProcessingItem[] = [];
    for (const demand of current) {
      const task = taskForKey(demand.demandKey);
      if (task) items.push(item(task, demand.clipId));
    }
    return {items};
  }
  function inspect(input: {projectId: string; taskId: string}): {item: SpeedProcessingItem} {
    requireProject(input); return {item: item(taskById(input.taskId))};
  }
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
    const demand = readProcessingDemands(store).find(value => value.demandKey === initial.demandKey);
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
    demands = readProcessingDemands(store);
    content = readProjectContentStamp(db);
    reconcilePins();
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
      const demand = currentDemands().find(value => value.clipId === clipId && value.input.assetId === assetId && matches(value.input));
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
    removeObserver();
    for (const attempt of running.values()) attempt.controller.abort();
    emit();
    await Promise.all([...running.values()].map(attempt => attempt.done));
    if (uncertain) throw uncertain;
  }
  return {enabled, activate, close, list, inspect, wait, retry, cancel, cacheGet, cacheClear, opticalProxy};
}
