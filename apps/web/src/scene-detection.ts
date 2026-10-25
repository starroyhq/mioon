import { message as msg } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage, MessageKey } from '../../../packages/i18n/src/index.ts';
import { sceneSchemas, canonicalSceneInput, isSceneTaskResponse, isSceneMutationResponse, isSceneRequestResponse, isSceneListResponse, isSceneResultResponse,
  normalizeSceneDetectionOptions, SCENE_LIMITS, SCENE_MUTATION_OPERATIONS } from '@mioon/contracts';
import type { SceneDetectionOptionsInput, SceneResultResponse, SceneResultSummary } from '@mioon/contracts';
import { ApiError } from './api.ts';

// Reference-film scene detection in the workbench: the project's detection
// tasks, each video's latest result, and the user's detect, cancel and save
// requests. Like frame capture, an unconfirmed request keeps its exact input
// until a receipt read or an explicit resend of the same request settles it.
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const freeze = <T>(value: T): T => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value as Record<string, unknown>).forEach(freeze); Object.freeze(value); } return value; };
const copy = <T>(value: T): T => structuredClone(value);

export type SceneTaskState = 'queued' | 'running' | 'cancelling' | 'persisting' | 'succeeded' | 'cancelled_before_start' | 'cancelled' | 'interrupted' | 'local_result_error' | 'failed' | 'undone';
/** The detection task as the dialog reads it. Storyboard tasks are left to their own view. */
export interface SceneDetectTask {
  id: string; projectId: string; kind: 'detect'; requestId: string; sourceAssetId: string; sourceHash: string;
  options: SceneDetectionOptionsInput; profileId: string; fps: number;
  state: SceneTaskState; revision: number; started: boolean;
  result: { id: string; frameCount: number; cutCount: number } | null;
  progress: { frames: number; frameCount: number; cuts: number } | null;
  errorCode: string | null; createdAt: string; updatedAt: string;
}
export type SceneMutation = typeof SCENE_MUTATION_OPERATIONS[number];
export interface ScenePending { readonly operation: SceneMutation; readonly input: Readonly<Record<string, unknown>>; readonly assetId: string }
export interface SceneResultView { readonly phase: 'loading' | 'ready' | 'error'; readonly response: SceneResultResponse | null }
export interface SceneNotice { readonly assetId: string | null; readonly descriptor: DisplayMessage; readonly tone: 'neutral' | 'warning' | 'danger' }
export interface SceneSourceAsset { id: string; projectId?: string; name?: string; sha256?: string; mimeType?: string; duration?: unknown; sizeBytes?: unknown }
export interface SceneDetectionState {
  projectId: string | null;
  visible: boolean;
  /** Restored workspaces read results but cannot change them. */
  readOnly: boolean;
  tasks: readonly SceneDetectTask[];
  tasksLoaded: boolean;
  tasksError: boolean;
  results: Readonly<Record<string, SceneResultView>>;
  pending: ScenePending | null;
  phase: 'idle' | 'submitting' | 'unknown';
  notice: SceneNotice | null;
  /** Seconds left for running tasks, from the observed decoding rate. */
  remaining: Readonly<Record<string, number>>;
}
export interface SceneDetectionOptions {
  rpc: (operation: string, input: unknown) => Promise<unknown>;
  createRequestId?: () => string;
  now?: () => number;
  onChange?: (state: SceneDetectionState) => void;
  /** A known task left the active states: detection finished, failed or stopped. */
  onTaskSettled?: (task: SceneDetectTask) => void;
}

const activeStates: ReadonlySet<string> = new Set(['queued', 'running', 'cancelling']);
export const sceneTaskActive = (task: Pick<SceneDetectTask, 'state'> | null | undefined): boolean => Boolean(task && activeStates.has(task.state));
export const sceneTaskCanCancel = (task: Pick<SceneDetectTask, 'state'> | null | undefined): boolean => task?.state === 'queued' || task?.state === 'running';
/** 0–100. A queued task has not decoded anything yet. */
export function sceneTaskPercent(task: Pick<SceneDetectTask, 'state' | 'progress'> | null | undefined): number {
  if (!task) return 0;
  if (task.state === 'succeeded') return 100;
  const progress = task.progress;
  return progress && progress.frameCount > 0 ? Math.max(0, Math.min(99, Math.floor(progress.frames * 100 / progress.frameCount))) : 0;
}
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
  SCENE_REVISION_CONFLICT: 'scene.error.changed', SCENE_STATE_CONFLICT: 'scene.error.changed', SCENE_SOURCE_INVALID: 'scene.error.sourceInvalid',
  SCENE_PROFILE_UNSUPPORTED: 'scene.error.sourceInvalid', SCENE_SOURCE_CHANGED: 'scene.error.sourceChanged', SCENE_RESULT_CONFLICT: 'scene.error.resultConflict',
  SCENE_RESULT_STALE: 'scene.error.resultStale', SCENE_CUTS_INVALID: 'scene.error.cutsInvalid', SCENE_CUTS_LIMIT: 'scene.error.cutsLimit',
  SCENE_INTERRUPTED: 'scene.error.interrupted', SCENE_ATTEMPT_TIMEOUT: 'scene.error.timeout', SCENE_DECODE_INCOMPLETE: 'scene.error.decode',
  SCENE_FRAMES_INVALID: 'scene.error.decode', SCENE_FRAME_LIMIT: 'scene.error.decode', SCENE_SERVICE_STOPPED: 'scene.error.serviceStopped',
  SCENE_OWNER_REQUIRED: 'scene.error.serviceStopped', RESTORE_OPERATION_UNAVAILABLE: 'scene.error.restored',
});
/** Refusals and task failures in the user's words; unknown codes fall back to the generic failure. */
export const sceneErrorMessage = (code: string | null | undefined): DisplayMessage => msg(code && Object.hasOwn(errorKeys, code) ? errorKeys[code]! : 'scene.error.failed');

// Pre-write refusals the backend can prove under their own status, as in the client package.
const refusalStatus: Readonly<Record<string, number>> = Object.freeze({ SCENE_CAPACITY: 507, SCENE_QUEUE_FULL: 409, SCENE_TASK_ACTIVE: 409, SCENE_REVISION_CONFLICT: 409,
  SCENE_STATE_CONFLICT: 409, SCENE_SOURCE_INVALID: 409, SCENE_SOURCE_CHANGED: 409, SCENE_RESULT_CONFLICT: 409, SCENE_RESULT_STALE: 409, SCENE_CUTS_INVALID: 409 });
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

const detectTask = (value: unknown): value is SceneDetectTask => isSceneTaskResponse(value) && record(value) && value.kind === 'detect';
const initial = (): SceneDetectionState => ({ projectId: null, visible: false, readOnly: false, tasks: [], tasksLoaded: false, tasksError: false, results: {}, pending: null, phase: 'idle', notice: null, remaining: {} });
interface Owner { epoch: number; projectId: string | null }
interface RateSample { time: number; frames: number }

export function createSceneDetectionController({ rpc, createRequestId = () => globalThis.crypto.randomUUID(), now = () => Date.now(), onChange = () => {}, onTaskSettled = () => {} }: SceneDetectionOptions) {
  let state = freeze(initial()), epoch = 0, listSerial = 0, disposed = false;
  const listeners = new Set<() => void>(), pendingByProject = new Map<string, ScenePending>(), known = new Map<string, SceneDetectTask>(), samples = new Map<string, RateSample>();
  const resultSerial = new Map<string, number>();
  const emit = (patch: Partial<SceneDetectionState>): SceneDetectionState => { state = freeze({ ...state, ...patch }); onChange(state); listeners.forEach(listener => listener()); return state; };
  const owner = (): Owner => ({ epoch, projectId: state.projectId });
  // Read through a call: the state is replaced by emit, so an earlier check must not narrow it.
  const phase = (): SceneDetectionState['phase'] => state.phase;
  const owns = (token: Owner): boolean => !disposed && token.epoch === epoch && token.projectId === state.projectId;
  const readable = (): boolean => !disposed && Boolean(state.projectId && state.visible);
  const writable = (): boolean => readable() && !state.readOnly && state.phase === 'idle' && !state.pending;
  const inputFor = (operation: string, input: unknown): Record<string, unknown> | null => { const parsed = schemaFor(operation)?.safeParse(input); return parsed?.success ? freeze(parsed.data as Record<string, unknown>) : null; };

  function estimate(task: SceneDetectTask): number | undefined {
    const progress = task.state === 'running' ? task.progress : null;
    if (!progress) { samples.delete(task.id); return undefined; }
    const first = samples.get(task.id), time = now();
    if (!first) { samples.set(task.id, { time, frames: progress.frames }); return undefined; }
    const elapsed = (time - first.time) / 1000, decoded = progress.frames - first.frames;
    return elapsed >= 2 && decoded > 0 ? Math.max(1, Math.ceil((progress.frameCount - progress.frames) * elapsed / decoded)) : undefined;
  }
  // Revisions only move forward; an older read never replaces a newer task.
  function remember(value: SceneDetectTask): SceneDetectTask {
    const previous = known.get(value.id);
    if (previous && (previous.revision > value.revision || previous.revision === value.revision && previous.updatedAt > value.updatedAt)) return previous;
    if (previous && (previous.requestId !== value.requestId || previous.sourceAssetId !== value.sourceAssetId)) return previous;
    const task = freeze(copy(value));
    known.set(task.id, task);
    if (previous && sceneTaskActive(previous) && !sceneTaskActive(task)) {
      samples.delete(task.id);
      // A shown result for this video is now older than the one just saved.
      if (task.state === 'succeeded' && state.results[task.sourceAssetId]) void loadResult(task.sourceAssetId);
      try { onTaskSettled(task); } catch {}
    }
    return task;
  }
  function publish(tasks: SceneDetectTask[], patch: Partial<SceneDetectionState> = {}): void {
    const ordered = [...new Map(tasks.map(task => [task.id, task])).values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).slice(0, SCENE_LIMITS.maxPageSize);
    const remaining: Record<string, number> = {};
    for (const task of ordered) { const seconds = estimate(task); if (seconds !== undefined) remaining[task.id] = seconds; }
    emit({ tasks: ordered, remaining, ...patch });
  }
  const merge = (task: SceneDetectTask): SceneDetectTask => { const current = remember(task); publish([current, ...state.tasks.filter(item => item.id !== current.id)]); return current; };

  async function refreshTasks(): Promise<boolean> {
    if (!readable()) return false;
    const token = owner(), serial = ++listSerial, input = inputFor('scene.task.list', { projectId: token.projectId, limit: SCENE_LIMITS.pageSize });
    if (!input) return false;
    try {
      const page = await rpc('scene.task.list', copy(input));
      if (!owns(token) || serial !== listSerial) return false;
      if (!isSceneListResponse('scene.task.list', input, page) || !record(page) || !Array.isArray(page.items)) throw new Error('invalid');
      const listed = (page.items as unknown[]).filter(detectTask).map(remember), ids = new Set(listed.map(task => task.id));
      // A task that fell off the first page keeps its last read state until it is read again.
      const kept = state.tasks.filter(task => !ids.has(task.id) && (sceneTaskActive(task) || task.id === state.pending?.input.taskId));
      publish([...listed, ...kept], { tasksLoaded: true, tasksError: false });
      return true;
    } catch { if (owns(token) && serial === listSerial) emit({ tasksError: true }); return false; }
  }
  async function readTask(taskId: string): Promise<SceneDetectTask | null> {
    if (!readable()) return null;
    const token = owner(), input = inputFor('scene.task.get', { projectId: token.projectId, taskId });
    if (!input) return null;
    try {
      const task = await rpc('scene.task.get', copy(input));
      if (!owns(token)) return null;
      if (!detectTask(task) || task.id !== taskId || task.projectId !== token.projectId) throw new Error('invalid');
      return merge(task);
    } catch { if (owns(token)) emit({ tasksError: true }); return null; }
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
    const task = merge(ack as SceneDetectTask);
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
        if (code === 'SCENE_RESULT_CONFLICT' || code === 'SCENE_RESULT_STALE' || code === 'SCENE_SOURCE_CHANGED') void loadResult(pending.assetId);
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

  async function detect(asset: SceneSourceAsset, options: Partial<SceneDetectionOptionsInput> = {}): Promise<SceneDetectTask | null> {
    if (!writable() || sceneSourceIssue(asset) || asset.projectId !== state.projectId) return null;
    if (state.tasks.some(task => task.sourceAssetId === asset.id && sceneTaskActive(task))) { emit({ notice: { assetId: asset.id, descriptor: sceneErrorMessage('SCENE_TASK_ACTIVE'), tone: 'warning' } }); return null; }
    const pending = prepared('scene.detect', { projectId: state.projectId, sourceAssetId: asset.id, sourceHash: asset.sha256, options: normalizeSceneDetectionOptions(options), requestId: createRequestId() }, asset.id);
    return pending ? await submit(pending) as SceneDetectTask | null : null;
  }
  async function cancel(candidate: SceneDetectTask): Promise<SceneDetectTask | null> {
    const task = state.tasks.find(item => item.id === candidate.id);
    if (!writable() || !task || !sceneTaskCanCancel(task)) return null;
    const pending = prepared('scene.task.cancel', { projectId: state.projectId, taskId: task.id, expectedRevision: task.revision, requestId: createRequestId() }, task.sourceAssetId);
    return pending ? await submit(pending) as SceneDetectTask | null : null;
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
      if (changed) { epoch++; listSerial++; known.clear(); samples.clear(); resultSerial.clear(); }
      const pending = projectId ? pendingByProject.get(projectId) ?? null : null;
      emit({ ...(changed ? { ...initial(), pending, phase: pending ? 'unknown' : 'idle' } : {}), projectId, visible, readOnly });
    },
    refreshTasks, readTask, loadResult, detect, cancel, saveCuts, reconcileUnknown,
    /** Sends the same unconfirmed request again; the backend replays it exactly once. */
    retryUnknown: (): Promise<unknown> => readable() && state.pending && state.phase === 'unknown' && !state.readOnly ? submit(state.pending) : Promise.resolve(null),
    clearNotice: (): void => { if (state.notice) emit({ notice: null }); },
    activeTask: (assetId: string): SceneDetectTask | null => state.tasks.find(task => task.sourceAssetId === assetId && sceneTaskActive(task)) ?? null,
    latestTask: (assetId: string): SceneDetectTask | null => state.tasks.find(task => task.sourceAssetId === assetId) ?? null,
    dispose(): void { epoch++; listSerial++; disposed = true; listeners.clear(); },
  };
}
export type SceneDetectionController = ReturnType<typeof createSceneDetectionController>;
