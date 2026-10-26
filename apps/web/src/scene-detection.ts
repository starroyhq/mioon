import { message as msg } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage, MessageKey } from '../../../packages/i18n/src/index.ts';
import { sceneSchemas, canonicalSceneInput, isSceneTaskResponse, isSceneMutationResponse, isSceneRequestResponse, isSceneListResponse, isSceneResultResponse,
  normalizeSceneDetectionOptions, SCENE_LIMITS, SCENE_MUTATION_OPERATIONS } from '@mioon/contracts';
import type { SceneDetectionOptionsInput, SceneResultResponse, SceneResultSummary, SceneShotsTaskResponse } from '@mioon/contracts';
import { ApiError } from './api.ts';

// Reference-film scene detection in the workbench: the project's detection and
// storyboard tasks, each video's latest result, and the user's detect, cancel,
// save, storyboard and undo requests. Like frame capture, an unconfirmed request
// keeps its exact input until a receipt read or an explicit resend settles it.
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const freeze = <T>(value: T): T => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value as Record<string, unknown>).forEach(freeze); Object.freeze(value); } return value; };
const copy = <T>(value: T): T => structuredClone(value);

export type SceneTaskState = 'queued' | 'running' | 'cancelling' | 'persisting' | 'succeeded' | 'cancelled_before_start' | 'cancelled' | 'interrupted' | 'local_result_error' | 'failed' | 'undone';
/** The detection task as the dialog reads it. */
export interface SceneDetectTask {
  id: string; projectId: string; kind: 'detect'; requestId: string; sourceAssetId: string; sourceHash: string;
  options: SceneDetectionOptionsInput; profileId: string; fps: number;
  state: SceneTaskState; revision: number; started: boolean;
  result: { id: string; frameCount: number; cutCount: number } | null;
  progress: { frames: number; frameCount: number; cuts: number } | null;
  errorCode: string | null; createdAt: string; updatedAt: string;
}
/** A storyboard task: keyframes for the chosen segments, then one shot per segment. */
export type SceneShotsTask = SceneShotsTaskResponse;
export type SceneTask = SceneDetectTask | SceneShotsTask;
export type SceneMutation = typeof SCENE_MUTATION_OPERATIONS[number];
export interface ScenePending { readonly operation: SceneMutation; readonly input: Readonly<Record<string, unknown>>; readonly assetId: string }
export interface SceneResultView { readonly phase: 'loading' | 'ready' | 'error'; readonly response: SceneResultResponse | null }
export interface SceneNotice { readonly assetId: string | null; readonly descriptor: DisplayMessage; readonly tone: 'neutral' | 'warning' | 'danger' }
export interface SceneSourceAsset { id: string; projectId?: string; name?: string; sha256?: string; mimeType?: string; duration?: unknown; sizeBytes?: unknown }
/** Whether a built storyboard can still be undone. Task pages leave this out, so it is read per task. */
export interface SceneUndoView { readonly phase: 'loading' | 'ready' | 'error'; readonly revision: number | null; readonly undo: SceneShotsTask['undo'] }
export interface SceneDetectionState {
  projectId: string | null;
  visible: boolean;
  /** Restored workspaces read results but cannot change them. */
  readOnly: boolean;
  tasks: readonly SceneTask[];
  tasksLoaded: boolean;
  tasksError: boolean;
  results: Readonly<Record<string, SceneResultView>>;
  pending: ScenePending | null;
  phase: 'idle' | 'submitting' | 'unknown';
  notice: SceneNotice | null;
  /** Seconds left for running detections, from the observed decoding rate. */
  remaining: Readonly<Record<string, number>>;
  /** Live undo availability of built storyboards, by task. */
  undo: Readonly<Record<string, SceneUndoView>>;
}
export interface SceneDetectionOptions {
  rpc: (operation: string, input: unknown) => Promise<unknown>;
  createRequestId?: () => string;
  now?: () => number;
  onChange?: (state: SceneDetectionState) => void;
  /** A known task left the active states: it finished, failed or stopped, or a built storyboard was undone. */
  onTaskSettled?: (task: SceneTask) => void;
}

// A storyboard that is saving its shots finishes or fails on its own; it cannot be cancelled.
const activeStates: ReadonlySet<string> = new Set(['queued', 'running', 'cancelling', 'persisting']);
export const sceneTaskActive = (task: Pick<SceneTask, 'state'> | null | undefined): boolean => Boolean(task && activeStates.has(task.state));
export const sceneTaskCanCancel = (task: Pick<SceneTask, 'state'> | null | undefined): boolean => task?.state === 'queued' || task?.state === 'running';
export const sceneShotsTask = (task: SceneTask | null | undefined): task is SceneShotsTask => task?.kind === 'shots';
/** 0–100. A queued task has not decoded anything yet; a storyboard counts captured keyframes. */
export function sceneTaskPercent(task: SceneTask | null | undefined): number {
  if (!task) return 0;
  if (task.state === 'succeeded') return 100;
  if (task.kind === 'shots') {
    const progress = task.progress;
    return task.state === 'persisting' ? 99 : progress && progress.total > 0 ? Math.max(0, Math.min(99, Math.floor(progress.done * 100 / progress.total))) : 0;
  }
  const progress = task.progress;
  return progress && progress.frameCount > 0 ? Math.max(0, Math.min(99, Math.floor(progress.frames * 100 / progress.frameCount))) : 0;
}
/** Failed, interrupted or unsaved storyboards built nothing and can be retried. */
export const sceneStoryboardFailed = (task: SceneTask | null | undefined): task is SceneShotsTask => task?.kind === 'shots' && ['failed', 'interrupted', 'local_result_error'].includes(task.state);
/** Why a video cannot be detected; null when it can. Mirrors the frame capture limits the backend checks. */
export function sceneSourceIssue(asset: SceneSourceAsset | null | undefined): 'type' | 'duration' | 'size' | null {
  if (!asset || !['video/mp4', 'video/webm'].includes(String(asset.mimeType)) || typeof asset.sha256 !== 'string') return 'type';
  const duration = Number(asset.duration), size = Number(asset.sizeBytes);
  if (!Number.isFinite(duration) || duration <= 0 || duration > SCENE_LIMITS.sourceDuration) return 'duration';
  if (Number.isFinite(size) && size > SCENE_LIMITS.sourceBytes) return 'size';
  return null;
}
/** The reason shown beside a disabled 拆解镜头 entry; null when the video can be detected. */
export function sceneSourceIssueMessage(asset: SceneSourceAsset | null | undefined): DisplayMessage | null {
  const issue = sceneSourceIssue(asset);
  return issue === 'type' ? msg('scene.issue.type') : issue === 'duration' ? msg('scene.issue.duration', { minutes: SCENE_LIMITS.sourceDuration / 60 })
    : issue === 'size' ? msg('scene.issue.size', { size: Math.round(SCENE_LIMITS.sourceBytes / 1048576) }) : null;
}
export const sceneSensitivityLevel = (value: number): 'low' | 'medium' | 'high' => value < 40 ? 'low' : value < 70 ? 'medium' : 'high';

const errorKeys: Readonly<Record<string, MessageKey>> = Object.freeze({
  SCENE_CAPACITY: 'scene.error.capacity', SCENE_QUEUE_FULL: 'scene.error.queueFull', SCENE_TASK_ACTIVE: 'scene.error.taskActive',
  SCENE_SEGMENTS_INVALID: 'scene.error.segmentsInvalid', SCENE_UNDO_BLOCKED: 'scene.error.undoBlocked',
  SCENE_REVISION_CONFLICT: 'scene.error.changed', SCENE_STATE_CONFLICT: 'scene.error.changed', SCENE_SOURCE_INVALID: 'scene.error.sourceInvalid',
  SCENE_PROFILE_UNSUPPORTED: 'scene.error.sourceInvalid', SCENE_SOURCE_CHANGED: 'scene.error.sourceChanged', SCENE_RESULT_CONFLICT: 'scene.error.resultConflict',
  SCENE_RESULT_STALE: 'scene.error.resultStale', SCENE_CUTS_INVALID: 'scene.error.cutsInvalid', SCENE_CUTS_LIMIT: 'scene.error.cutsLimit',
  SCENE_INTERRUPTED: 'scene.error.interrupted', SCENE_ATTEMPT_TIMEOUT: 'scene.error.timeout', SCENE_DECODE_INCOMPLETE: 'scene.error.decode',
  SCENE_FRAMES_INVALID: 'scene.error.decode', SCENE_FRAME_LIMIT: 'scene.error.decode', SCENE_SERVICE_STOPPED: 'scene.error.serviceStopped',
  SCENE_OWNER_REQUIRED: 'scene.error.serviceStopped', RESTORE_OPERATION_UNAVAILABLE: 'scene.error.restored',
});
/** Refusals and task failures in the user's words; unknown codes fall back to the generic failure. */
export const sceneErrorMessage = (code: string | null | undefined): DisplayMessage => msg(code && Object.hasOwn(errorKeys, code) ? errorKeys[code]! : 'scene.error.failed');
const storyboardErrorKeys: Readonly<Record<string, MessageKey>> = Object.freeze({
  SCENE_SOURCE_CHANGED: 'scene.storyboard.error.sourceChanged', SCENE_INTERRUPTED: 'scene.storyboard.error.interrupted', SCENE_ATTEMPT_TIMEOUT: 'scene.storyboard.error.timeout',
  SCENE_SHOTS_FAILED: 'scene.storyboard.error.capture', SCENE_DECODE_INCOMPLETE: 'scene.storyboard.error.capture', SCENE_KEYFRAME_UNAVAILABLE: 'scene.storyboard.error.keyframe',
  SCENE_STORAGE_FAILED: 'scene.storyboard.error.storage', SCENE_SERVICE_STOPPED: 'scene.error.serviceStopped', SCENE_OWNER_REQUIRED: 'scene.error.serviceStopped',
});
/** Why a storyboard built nothing. */
export const sceneStoryboardErrorMessage = (code: string | null | undefined): DisplayMessage => msg(code && Object.hasOwn(storyboardErrorKeys, code) ? storyboardErrorKeys[code]! : 'scene.storyboard.error.failed');

// Pre-write refusals the backend can prove under their own status, as in the client package.
const refusalStatus: Readonly<Record<string, number>> = Object.freeze({ SCENE_CAPACITY: 507, SCENE_QUEUE_FULL: 409, SCENE_TASK_ACTIVE: 409, SCENE_REVISION_CONFLICT: 409,
  SCENE_STATE_CONFLICT: 409, SCENE_SOURCE_INVALID: 409, SCENE_SOURCE_CHANGED: 409, SCENE_RESULT_CONFLICT: 409, SCENE_RESULT_STALE: 409, SCENE_CUTS_INVALID: 409,
  SCENE_SEGMENTS_INVALID: 409, SCENE_UNDO_BLOCKED: 409 });
const schemaFor = (operation: string) => Object.hasOwn(sceneSchemas, operation) ? sceneSchemas[operation as keyof typeof sceneSchemas] : null;
/** True only for a refusal whose proof binds this exact operation, project, request and canonical input. */
export async function sceneRequestNotAccepted(error: unknown, operation: string, input: unknown): Promise<boolean> {
  if (!(error instanceof ApiError) || !(SCENE_MUTATION_OPERATIONS as readonly string[]).includes(operation)) return false;
  const code = typeof error.code === 'string' ? error.code : '', details = record(error.details) ? error.details : null, proof = details?.sceneOutcome, request = record(input) ? input : {};
  if (!Object.hasOwn(refusalStatus, code) || error.status !== refusalStatus[code] || !record(proof) || !schemaFor(operation)?.safeParse(input).success ||
    Object.keys(proof).sort().join(',') !== 'inputHash,operation,projectId,requestId,status' || proof.status !== 'not_accepted' || proof.operation !== operation ||
    proof.projectId !== request.projectId || proof.requestId !== request.requestId || typeof proof.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(proof.inputHash)) return false;
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalSceneInput(input)));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') === proof.inputHash;
  } catch { return false; }
}

const sceneTask = (value: unknown): value is SceneTask => isSceneTaskResponse(value) && record(value) && (value.kind === 'detect' || value.kind === 'shots');
const initial = (): SceneDetectionState => ({ projectId: null, visible: false, readOnly: false, tasks: [], tasksLoaded: false, tasksError: false, results: {}, pending: null, phase: 'idle', notice: null, remaining: {}, undo: {} });
interface Owner { epoch: number; projectId: string | null }
interface RateSample { time: number; frames: number }

export function createSceneDetectionController({ rpc, createRequestId = () => globalThis.crypto.randomUUID(), now = () => Date.now(), onChange = () => {}, onTaskSettled = () => {} }: SceneDetectionOptions) {
  let state = freeze(initial()), epoch = 0, listSerial = 0, disposed = false;
  const listeners = new Set<() => void>(), pendingByProject = new Map<string, ScenePending>(), known = new Map<string, SceneTask>(), samples = new Map<string, RateSample>();
  const resultSerial = new Map<string, number>(), undoSerial = new Map<string, number>();
  const emit = (patch: Partial<SceneDetectionState>): SceneDetectionState => { state = freeze({ ...state, ...patch }); onChange(state); listeners.forEach(listener => listener()); return state; };
  const owner = (): Owner => ({ epoch, projectId: state.projectId });
  // Read through a call: the state is replaced by emit, so an earlier check must not narrow it.
  const phase = (): SceneDetectionState['phase'] => state.phase;
  const owns = (token: Owner): boolean => !disposed && token.epoch === epoch && token.projectId === state.projectId;
  const readable = (): boolean => !disposed && Boolean(state.projectId && state.visible);
  const writable = (): boolean => readable() && !state.readOnly && state.phase === 'idle' && !state.pending;
  const inputFor = (operation: string, input: unknown): Record<string, unknown> | null => { const parsed = schemaFor(operation)?.safeParse(input); return parsed?.success ? freeze(parsed.data as Record<string, unknown>) : null; };

  function estimate(task: SceneTask): number | undefined {
    const progress = task.kind === 'detect' && task.state === 'running' ? task.progress : null;
    if (!progress) { samples.delete(task.id); return undefined; }
    const first = samples.get(task.id), time = now();
    if (!first) { samples.set(task.id, { time, frames: progress.frames }); return undefined; }
    const elapsed = (time - first.time) / 1000, decoded = progress.frames - first.frames;
    return elapsed >= 2 && decoded > 0 ? Math.max(1, Math.ceil((progress.frameCount - progress.frames) * elapsed / decoded)) : undefined;
  }
  // Revisions only move forward; an older read never replaces a newer task.
  // Undo availability is live and kept apart in state.undo, so listed tasks never carry it.
  function remember(value: SceneTask): SceneTask {
    const previous = known.get(value.id);
    if (previous && (previous.revision > value.revision || previous.revision === value.revision && previous.updatedAt > value.updatedAt)) return previous;
    if (previous && (previous.kind !== value.kind || previous.requestId !== value.requestId || previous.sourceAssetId !== value.sourceAssetId)) return previous;
    const task = freeze(copy(value.kind === 'shots' ? { ...value, undo: null } : value));
    known.set(task.id, task);
    const undone = previous?.state === 'succeeded' && task.state === 'undone';
    if (previous && (sceneTaskActive(previous) && !sceneTaskActive(task) || undone)) {
      samples.delete(task.id);
      // A shown result for this video is now older than the one just saved.
      if (task.kind === 'detect' && task.state === 'succeeded' && state.results[task.sourceAssetId]) void loadResult(task.sourceAssetId);
      try { onTaskSettled(task); } catch {}
    }
    return task;
  }
  function publish(tasks: SceneTask[], patch: Partial<SceneDetectionState> = {}): void {
    const ordered = [...new Map(tasks.map(task => [task.id, task])).values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).slice(0, SCENE_LIMITS.maxPageSize);
    const remaining: Record<string, number> = {};
    for (const task of ordered) { const seconds = estimate(task); if (seconds !== undefined) remaining[task.id] = seconds; }
    // A storyboard that is no longer built has nothing left to undo.
    const undo = Object.fromEntries(Object.entries(patch.undo ?? state.undo).filter(([id]) => known.get(id)?.state === 'succeeded' || !known.has(id)));
    emit({ tasks: ordered, remaining, ...patch, undo });
  }
  const merge = (task: SceneTask): SceneTask => { const current = remember(task); publish([current, ...state.tasks.filter(item => item.id !== current.id)]); return current; };

  async function refreshTasks(): Promise<boolean> {
    if (!readable()) return false;
    const token = owner(), serial = ++listSerial, input = inputFor('scene.task.list', { projectId: token.projectId, limit: SCENE_LIMITS.pageSize });
    if (!input) return false;
    try {
      const page = await rpc('scene.task.list', copy(input));
      if (!owns(token) || serial !== listSerial) return false;
      if (!isSceneListResponse('scene.task.list', input, page) || !record(page) || !Array.isArray(page.items)) throw new Error('invalid');
      const listed = (page.items as unknown[]).filter(sceneTask).map(remember), ids = new Set(listed.map(task => task.id));
      // A task that fell off the first page keeps its last read state until it is read again,
      // and so does a built storyboard whose undo was read.
      const kept = state.tasks.filter(task => !ids.has(task.id) && (sceneTaskActive(task) || task.id === state.pending?.input.taskId || Object.hasOwn(state.undo, task.id)));
      publish([...listed, ...kept], { tasksLoaded: true, tasksError: false });
      return true;
    } catch { if (owns(token) && serial === listSerial) emit({ tasksError: true }); return false; }
  }
  async function readTask(taskId: string): Promise<SceneTask | null> {
    if (!readable()) return null;
    const token = owner(), input = inputFor('scene.task.get', { projectId: token.projectId, taskId });
    if (!input) return null;
    try {
      const task = await rpc('scene.task.get', copy(input));
      if (!owns(token)) return null;
      if (!sceneTask(task) || task.id !== taskId || task.projectId !== token.projectId) throw new Error('invalid');
      return merge(task);
    } catch { if (owns(token)) emit({ tasksError: true }); return null; }
  }
  /** Reads a built storyboard again for its live undo availability. */
  async function checkUndo(taskId: string): Promise<SceneShotsTask | null> {
    if (!readable()) return null;
    const token = owner(), input = inputFor('scene.task.get', { projectId: token.projectId, taskId });
    if (!input) return null;
    const serial = (undoSerial.get(taskId) ?? 0) + 1; undoSerial.set(taskId, serial);
    const previous = state.undo[taskId], keep = { revision: previous?.revision ?? null, undo: previous?.undo ?? null };
    emit({ undo: { ...state.undo, [taskId]: { phase: 'loading', ...keep } } });
    try {
      const task = await rpc('scene.task.get', copy(input));
      if (!owns(token) || undoSerial.get(taskId) !== serial) return null;
      if (!sceneTask(task) || task.kind !== 'shots' || task.id !== taskId || task.projectId !== token.projectId) throw new Error('invalid');
      // An older read than the task already known says nothing about undo now.
      const current = remember(task);
      if (current.kind !== 'shots') throw new Error('invalid');
      const fresh = current.revision === task.revision && current.updatedAt === task.updatedAt, value = fresh ? task : current;
      const view: SceneUndoView = { phase: 'ready', revision: value.revision, undo: fresh && task.undo ? freeze(copy(task.undo)) : null };
      publish([current, ...state.tasks.filter(item => item.id !== current.id)], { undo: { ...state.undo, [taskId]: view } });
      return value;
    } catch {
      if (owns(token) && undoSerial.get(taskId) === serial) emit({ undo: { ...state.undo, [taskId]: { phase: 'error', ...keep } } });
      return null;
    }
  }
  async function loadResult(assetId: string): Promise<SceneResultResponse | null> {
    if (!readable()) return null;
    const token = owner(), input = inputFor('scene.result.get', { projectId: token.projectId, assetId });
    if (!input) return null;
    const serial = (resultSerial.get(assetId) ?? 0) + 1; resultSerial.set(assetId, serial);
    const previous = state.results[assetId];
    emit({ results: { ...state.results, [assetId]: { phase: 'loading', response: previous?.response ?? null } } });
    try {
      const response = await rpc('scene.result.get', copy(input));
      if (!owns(token) || resultSerial.get(assetId) !== serial) return null;
      if (!isSceneResultResponse(response) || response.projectId !== token.projectId || response.assetId !== assetId) throw new Error('invalid');
      emit({ results: { ...state.results, [assetId]: { phase: 'ready', response: freeze(copy(response)) } } });
      return response;
    } catch {
      if (owns(token) && resultSerial.get(assetId) === serial) emit({ results: { ...state.results, [assetId]: { phase: 'error', response: previous?.response ?? null } } });
      return null;
    }
  }

  function setPending(value: ScenePending | null): void {
    if (state.projectId) { if (value) pendingByProject.set(state.projectId, value); else pendingByProject.delete(state.projectId); }
    emit({ pending: value });
  }
  async function settle(pending: ScenePending, ack: unknown, token: Owner): Promise<unknown> {
    if (!owns(token) || state.pending !== pending) return null;
    if (!isSceneMutationResponse(pending.operation, pending.input, ack)) throw new Error('invalid');
    setPending(null); emit({ phase: 'idle', notice: null });
    if (pending.operation === 'scene.cuts.save') { await loadResult(pending.assetId); return ack; }
    const task = merge(ack as SceneTask);
    await readTask(task.id);
    return owns(token) ? known.get(task.id) ?? task : null;
  }
  async function submit(pending: ScenePending): Promise<unknown> {
    const token = owner();
    setPending(pending); emit({ phase: 'submitting', notice: null });
    try {
      const ack = await rpc(pending.operation, copy(pending.input));
      return await settle(pending, ack, token);
    } catch (error) {
      const refused = await sceneRequestNotAccepted(error, pending.operation, pending.input);
      if (!owns(token) || state.pending !== pending) return null;
      if (refused) {
        setPending(null);
        const code = error instanceof ApiError ? error.code : undefined;
        emit({ phase: 'idle', notice: { assetId: pending.assetId, descriptor: sceneErrorMessage(code), tone: 'warning' } });
        // A refusal can mean the task or result moved on; read the current records.
        if (code === 'SCENE_RESULT_CONFLICT' || code === 'SCENE_RESULT_STALE' || code === 'SCENE_SOURCE_CHANGED' || code === 'SCENE_SEGMENTS_INVALID') void loadResult(pending.assetId);
        if (code === 'SCENE_TASK_ACTIVE' || code === 'SCENE_REVISION_CONFLICT' || code === 'SCENE_STATE_CONFLICT') void refreshTasks();
      } else emit({ phase: 'unknown', notice: { assetId: pending.assetId, descriptor: msg('scene.request.unknown'), tone: 'warning' } });
      return null;
    } finally { if (owns(token) && phase() === 'submitting') emit({ phase: state.pending ? 'unknown' : 'idle' }); }
  }
  function prepared(operation: SceneMutation, input: Record<string, unknown>, assetId: string): ScenePending | null {
    const parsed = inputFor(operation, input);
    if (!parsed) { emit({ notice: { assetId, descriptor: msg('scene.request.invalid'), tone: 'danger' } }); return null; }
    return freeze({ operation, input: parsed, assetId });
  }

  const busyWith = (assetId: string): boolean => {
    if (!state.tasks.some(task => task.sourceAssetId === assetId && sceneTaskActive(task))) return false;
    emit({ notice: { assetId, descriptor: sceneErrorMessage('SCENE_TASK_ACTIVE'), tone: 'warning' } });
    return true;
  };
  async function detect(asset: SceneSourceAsset, options: Partial<SceneDetectionOptionsInput> = {}): Promise<SceneDetectTask | null> {
    if (!writable() || sceneSourceIssue(asset) || asset.projectId !== state.projectId || busyWith(asset.id)) return null;
    const pending = prepared('scene.detect', { projectId: state.projectId, sourceAssetId: asset.id, sourceHash: asset.sha256, options: normalizeSceneDetectionOptions(options), requestId: createRequestId() }, asset.id);
    return pending ? await submit(pending) as SceneDetectTask | null : null;
  }
  async function cancel(candidate: SceneTask): Promise<SceneTask | null> {
    const task = state.tasks.find(item => item.id === candidate.id);
    if (!writable() || !task || !sceneTaskCanCancel(task)) return null;
    const pending = prepared('scene.task.cancel', { projectId: state.projectId, taskId: task.id, expectedRevision: task.revision, requestId: createRequestId() }, task.sourceAssetId);
    return pending ? await submit(pending) as SceneTask | null : null;
  }
  /** Queues a storyboard from the video's current result: one shot per chosen segment. */
  async function createShots(asset: SceneSourceAsset, resultId: string, segments: readonly number[], titlePrefix?: string): Promise<SceneShotsTask | null> {
    if (!writable() || sceneSourceIssue(asset) || asset.projectId !== state.projectId || busyWith(asset.id)) return null;
    const pending = prepared('scene.shots.create', { projectId: state.projectId, sourceAssetId: asset.id, sourceHash: asset.sha256, resultId, segments: [...segments],
      ...(titlePrefix === undefined ? {} : { titlePrefix }), requestId: createRequestId() }, asset.id);
    return pending ? await submit(pending) as SceneShotsTask | null : null;
  }
  /** Builds a storyboard that built nothing again, with its result, segments and titles. */
  const retryShots = (task: SceneShotsTask, asset: SceneSourceAsset): Promise<SceneShotsTask | null> =>
    sceneStoryboardFailed(task) && task.sourceAssetId === asset.id ? createShots(asset, task.resultId, task.segments, task.titlePrefix) : Promise.resolve(null);
  /** Undoes a built storyboard after reading that it is still untouched. */
  async function undoShots(taskId: string): Promise<SceneShotsTask | null> {
    if (!writable()) return null;
    const token = owner();
    emit({ phase: 'submitting', notice: null });
    let task: SceneShotsTask | null = null;
    try { task = await checkUndo(taskId); } finally { if (owns(token) && phase() === 'submitting' && !state.pending) emit({ phase: 'idle' }); }
    if (!task || !owns(token) || !writable()) return null;
    if (task.state !== 'succeeded' || !task.undo?.available) {
      if (task.state === 'succeeded') emit({ notice: { assetId: task.sourceAssetId, descriptor: sceneErrorMessage('SCENE_UNDO_BLOCKED'), tone: 'warning' } });
      return null;
    }
    const pending = prepared('scene.shots.undo', { projectId: state.projectId, taskId, expectedRevision: task.revision, requestId: createRequestId() }, task.sourceAssetId);
    const undone = pending ? await submit(pending) as SceneShotsTask | null : null;
    // A refused undo means a shot changed in between; show why.
    if (!undone && owns(token) && !state.pending) void checkUndo(taskId);
    return undone;
  }
  async function saveCuts(asset: SceneSourceAsset, resultId: string, cuts: readonly number[]): Promise<SceneResultSummary | null> {
    if (!writable() || asset.projectId !== state.projectId || typeof asset.sha256 !== 'string') return null;
    const pending = prepared('scene.cuts.save', { projectId: state.projectId, assetId: asset.id, sourceHash: asset.sha256, expectedResultId: resultId, cuts: [...cuts], requestId: createRequestId() }, asset.id);
    return pending ? await submit(pending) as SceneResultSummary | null : null;
  }
  async function reconcileUnknown(): Promise<unknown> {
    const pending = state.pending;
    if (!readable() || !pending || state.phase !== 'unknown') return null;
    const token = owner(), input = inputFor('scene.request.get', { projectId: pending.input.projectId, requestId: pending.input.requestId });
    if (!input) return null;
    emit({ phase: 'submitting' });
    try {
      const receipt = await rpc('scene.request.get', copy(input));
      if (!owns(token) || state.pending !== pending) return null;
      if (!isSceneRequestResponse(receipt)) throw new Error('invalid');
      if (receipt === null) { emit({ phase: 'unknown', notice: { assetId: pending.assetId, descriptor: msg('scene.request.missing'), tone: 'warning' } }); return null; }
      if (!record(receipt) || receipt.projectId !== input.projectId || receipt.requestId !== input.requestId || receipt.operation !== pending.operation) throw new Error('invalid');
      return await settle(pending, receipt.response, token);
    } catch { if (owns(token)) emit({ phase: 'unknown', notice: { assetId: pending.assetId, descriptor: msg('scene.request.unknown'), tone: 'warning' } }); return null; }
    finally { if (owns(token) && phase() === 'submitting') emit({ phase: state.pending ? 'unknown' : 'idle' }); }
  }

  return {
    getSnapshot: (): SceneDetectionState => state, getState: (): SceneDetectionState => state,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    configure({ projectId = null, visible = false, readOnly = false }: { projectId?: string | null; visible?: boolean; readOnly?: boolean } = {}): void {
      if (disposed) return;
      const changed = projectId !== state.projectId;
      if (!changed && visible === state.visible && readOnly === state.readOnly) return;
      if (changed) { epoch++; listSerial++; known.clear(); samples.clear(); resultSerial.clear(); undoSerial.clear(); }
      const pending = projectId ? pendingByProject.get(projectId) ?? null : null;
      emit({ ...(changed ? { ...initial(), pending, phase: pending ? 'unknown' : 'idle' } : {}), projectId, visible, readOnly });
    },
    refreshTasks, readTask, checkUndo, loadResult, detect, cancel, saveCuts, createShots, retryShots, undoShots, reconcileUnknown,
    /** Sends the same unconfirmed request again; the backend replays it exactly once. */
    retryUnknown: (): Promise<unknown> => readable() && state.pending && state.phase === 'unknown' && !state.readOnly ? submit(state.pending) : Promise.resolve(null),
    clearNotice: (): void => { if (state.notice) emit({ notice: null }); },
    activeTask: (assetId: string): SceneTask | null => state.tasks.find(task => task.sourceAssetId === assetId && sceneTaskActive(task)) ?? null,
    latestTask: (assetId: string): SceneTask | null => state.tasks.find(task => task.sourceAssetId === assetId) ?? null,
    dispose(): void { epoch++; listSerial++; disposed = true; listeners.clear(); },
  };
}
export type SceneDetectionController = ReturnType<typeof createSceneDetectionController>;
