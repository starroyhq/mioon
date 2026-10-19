import { message as msg, renderMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage, Locale, MessageKey } from '../../../packages/i18n/src/index.ts';
import { frameSchemas, isFrameTaskResponse, isFrameRequestResponse, isFrameMutationResponse, isFrameListResponse, canonicalFrameInput, FRAME_PROFILE, FRAME_LIMITS, FRAME_MUTATION_OPERATIONS } from '@mioon/contracts';
import { sourceFrameCount } from './source-range-state.ts';
import { ApiError } from './api.ts';

export { FRAME_PROFILE };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const failureCode = (error: unknown): string | undefined => record(error) && typeof error.code === 'string' ? error.code : undefined;
const copy = <T>(value: T): T => structuredClone(value);
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value as Record<string, unknown>).forEach(freeze); Object.freeze(value); } return value; };
const safeFailure = '抽帧记录暂时无法核验。请重新读取，原请求仍保留。';
const activeStates = new Set(['queued', 'running', 'persisting']);
const maxHistoryPages = Math.ceil(FRAME_LIMITS.tasksPerProject / FRAME_LIMITS.pageSize);
const refusalStatus = Object.freeze({ FRAME_CAPACITY: 507, FRAME_QUEUE_FULL: 409, FRAME_REVISION_CONFLICT: 409, FRAME_STATE_CONFLICT: 409, FRAME_SOURCE_INVALID: 409, FRAME_SOURCE_CHANGED: 409, FRAME_RESULT_INVALID: 409 });

export type FrameState = 'queued' | 'running' | 'persisting' | 'succeeded' | 'cancelled_before_start' | 'interrupted' | 'local_result_error' | 'failed';
export interface FrameResult { assetId: string; sha256: string; mimeType: string; width: number; height: number; byteLength: number }
export interface FrameTask {
  id: string;
  projectId: string;
  requestId: string;
  sourceAssetId: string;
  sourceHash: string;
  sourceFrame: number;
  fps: number;
  profileId: string;
  state: FrameState;
  revision: number;
  started: boolean;
  result: FrameResult | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface FrameRequestReceipt { projectId: string; requestId: string; operation: string; response: FrameTask | null }
export interface FrameListResponse { projectId: string; items: FrameTask[]; nextCursor: string | null }
export interface FrameAsset {
  id?: string;
  projectId?: string;
  name?: string;
  sha256?: string;
  mimeType?: string;
  duration?: unknown;
  [key: string]: unknown;
}
export interface FrameInput {
  projectId: string;
  requestId: string;
  sourceAssetId?: string;
  sourceHash?: string;
  sourceFrame?: number;
  taskId?: string;
  expectedRevision?: number;
  limit?: number;
  cursor?: string;
}
export interface FramePending { operation: string; input: FrameInput; sourceScope: string | null; sourceName: string; sourceFrame: number }
export interface FrameExtractionState {
  projectId: string | null;
  sourceScope: string | null;
  sourceAsset: FrameAsset | null;
  assets: FrameAsset[];
  visible: boolean;
  blocked: boolean;
  tasks: FrameTask[];
  nextCursor: string | null;
  pageCursor: string | null;
  pageTrail: (string | null)[];
  focusedTaskId: string | null;
  historyLoaded: boolean;
  historyError: boolean;
  loading: boolean;
  phase: 'idle' | 'submitting' | 'unknown';
  pending: FramePending | null;
  acknowledged: FrameTask | null;
  currentTaskPending: string | null;
  actionTaskId: string | null;
  error: string;
  errorMessage: DisplayMessage | null;
  message: string;
  messageDescriptor: DisplayMessage | null;
}
export interface FrameExtractionConfiguration {
  projectId?: string | null;
  sourceScope?: string | null;
  sourceAsset?: FrameAsset | null;
  assets?: readonly FrameAsset[];
  visible?: boolean;
  blocked?: boolean;
  [key: string]: unknown;
}
export interface FrameExtractionOptions {
  rpc: (operation: string, input: unknown) => Promise<unknown>;
  createRequestId?: () => string;
  onChange?: (state: FrameExtractionState) => void;
  onResult?: (projectId: string, task: FrameTask) => unknown;
  revealAsset?: (assetId: string, projectId: string, stillCurrent: () => boolean) => unknown;
}
export interface FrameCaptureIntent { sourceScope: string | null; sourceAssetId: string; sourceHash: string; sourceFrame: number }
interface FrameOwnerToken { epoch: number; projectId: string | null; sourceScope: string | null }

const frameOperation = (operation: string): (typeof frameSchemas)[keyof typeof frameSchemas] | undefined => Object.hasOwn(frameSchemas, operation) ? frameSchemas[operation as keyof typeof frameSchemas] : undefined;
export async function frameRequestNotAccepted(error: unknown, operation: string, input: unknown): Promise<boolean> {
  const errorRecord = record(error) ? error : null;
  const details = errorRecord && record(errorRecord.details) ? errorRecord.details : null;
  const proof = details ? details.frameOutcome : undefined;
  const inputRecord = record(input) ? input : {};
  const schema = frameOperation(operation);
  const apiError = error instanceof ApiError ? error as ApiError & { code?: unknown; status?: unknown } : null;
  const code = typeof apiError?.code === 'string' ? apiError.code : '';
  const expectedStatus = Object.hasOwn(refusalStatus, code) ? refusalStatus[code as keyof typeof refusalStatus] : undefined;
  if (!(FRAME_MUTATION_OPERATIONS as readonly string[]).includes(operation) || !apiError || expectedStatus === undefined || apiError.status !== expectedStatus ||
      !record(proof) || Object.keys(proof).sort().join(',') !== 'inputHash,operation,projectId,requestId,status' ||
      proof.status !== 'not_accepted' || proof.operation !== operation || proof.projectId !== inputRecord.projectId || proof.requestId !== inputRecord.requestId ||
      !/^[a-f0-9]{64}$/.test(typeof proof.inputHash === 'string' ? proof.inputHash : '') || !schema?.safeParse(input).success) return false;
  try {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalFrameInput(input)));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') === proof.inputHash;
  } catch { return false; }
}
const frameStateKeys: Record<string, MessageKey> = Object.freeze({ queued: 'timeline.frame.state.queued', running: 'timeline.frame.state.running', persisting: 'timeline.frame.state.persisting', succeeded: 'timeline.frame.state.succeeded', cancelled_before_start: 'timeline.frame.state.cancelled_before_start', interrupted: 'timeline.frame.state.interrupted', local_result_error: 'timeline.frame.state.local_result_error', failed: 'timeline.frame.state.failed' });
export const frameTaskMessage = (state: string): DisplayMessage => msg(Object.hasOwn(frameStateKeys, state) ? frameStateKeys[state] : 'timeline.frame.state.unknown');
export const frameTaskLabel = (state: string, locale: Locale = 'zh-Hans'): string => renderMessage(locale, frameTaskMessage(state));
export const frameCaptureBusy = (state: FrameExtractionState | null | undefined): boolean => !state || !state.projectId || !state.visible || state.blocked || !state.historyLoaded || Boolean(state.historyError || state.pending || state.actionTaskId || state.currentTaskPending || state.phase === 'submitting');
export const frameCanCancel = (task: Pick<FrameTask, 'started' | 'state'> | null | undefined): boolean => Boolean(task && !task.started && ['queued', 'interrupted'].includes(task.state));
export const frameCanRecover = (task: Pick<FrameTask, 'started' | 'state'> | null | undefined): boolean => task?.started === true && ['local_result_error', 'interrupted'].includes(task.state);
const identity = (task: FrameTask): string => canonicalFrameInput(Object.fromEntries(['id', 'projectId', 'requestId', 'sourceAssetId', 'sourceHash', 'sourceFrame', 'fps', 'profileId', 'createdAt'].map(key => [key, task[key as keyof FrameTask]])));
const initial = (): FrameExtractionState => ({ projectId: null, sourceScope: null, sourceAsset: null, assets: [], visible: false, blocked: false, tasks: [], nextCursor: null, pageCursor: null, pageTrail: [], focusedTaskId: null, historyLoaded: false, historyError: false, loading: false, phase: 'idle', pending: null, acknowledged: null, currentTaskPending: null, actionTaskId: null, error: '', errorMessage: null, message: '', messageDescriptor: null });

// Construction/configuration are inert. Only explicit capture/control methods
// write. The complete unknown input stays in this controller across navigation;
// a recreated window discovers accepted work with read-only task history.
export function createFrameExtractionController({ rpc, createRequestId = () => globalThis.crypto.randomUUID(), onChange = () => {}, onResult = () => {}, revealAsset = () => false }: FrameExtractionOptions) {
  let state = freeze(initial()), epoch = 0, listSerial = 0, disposed = false, configuration: FrameExtractionConfiguration | null = null, pendingListCursor: string | null | undefined;
  const listeners = new Set<() => void>(), pendingByProject = new Map<string, FramePending>(), announced = new Set<string>(), knownTasks = new Map<string, FrameTask>();
  const emit = (patch: Partial<FrameExtractionState>): FrameExtractionState => { state = freeze({ ...state, ...patch }); onChange(state); listeners.forEach(listener => listener()); return state; };
  const owner = (): FrameOwnerToken => ({ epoch, projectId: state.projectId, sourceScope: state.sourceScope });
  const owns = (token: FrameOwnerToken): boolean => !disposed && token.epoch === epoch && token.projectId === state.projectId && token.sourceScope === state.sourceScope;
  const usable = (): boolean => !disposed && Boolean(state.visible && state.projectId && !state.blocked);
  const submittingPhase = (): boolean => state.phase === 'submitting';
  const inputFor = (operation: string, input: unknown): FrameInput => { const parsed = frameOperation(operation)?.safeParse(input); if (!parsed?.success) throw new Error(safeFailure); return freeze(parsed.data) as FrameInput; };
  // Revision memory is project-scoped and bounded by backend retention, not by
  // the current DOM page. Returning to an older page cannot downgrade a task.
  function rememberTask(task: unknown, token: FrameOwnerToken): FrameTask {
    if (!owns(token) || !isFrameTaskResponse(task) || !record(task) || task.projectId !== token.projectId) throw new Error(safeFailure);
    const value = task as unknown as FrameTask;
    const previous = knownTasks.get(value.id);
    if (previous && (identity(previous) !== identity(value) || previous.revision === value.revision && canonicalFrameInput(previous) !== canonicalFrameInput(value))) throw new Error(safeFailure);
    if (previous && previous.revision > value.revision) return previous;
    if (previous?.started && !value.started) throw new Error(safeFailure);
    if (previous && ['succeeded', 'failed', 'cancelled_before_start'].includes(previous.state) && canonicalFrameInput(previous) !== canonicalFrameInput(value)) throw new Error(safeFailure);
    if (!previous && knownTasks.size >= FRAME_LIMITS.tasksPerProject) throw new Error(safeFailure);
    const frozen = freeze(copy(value)); knownTasks.set(frozen.id, frozen); return frozen;
  }
  function announceResult(task: FrameTask, token: FrameOwnerToken): void {
    const result = task.result;
    if (!owns(token) || task.state !== 'succeeded' || !result) return;
    const key = `${task.projectId}:${task.id}:${result.assetId}:${result.sha256}`;
    if (!announced.has(key)) { announced.add(key); try { Promise.resolve(onResult(task.projectId, copy(task))).catch(() => {}); } catch {} }
  }
  function mergeTask(task: unknown, token: FrameOwnerToken): FrameTask {
    const current = rememberTask(task, token), shown = state.tasks.some(item => item.id === current.id);
    const tasks = shown ? state.tasks.map(item => item.id === current.id ? current : item) : [current, ...state.tasks].slice(0, FRAME_LIMITS.maxPageSize);
    emit({ tasks, ...(state.currentTaskPending === current.id && current.revision >= (state.acknowledged?.revision || 1) ? { currentTaskPending: null } : {}) });
    announceResult(current, token); return current;
  }
  async function readTask(taskId: string): Promise<FrameTask | null> {
    if (!usable()) return null;
    const token = owner(), input = inputFor('frame.task.get', { projectId: token.projectId, taskId });
    try {
      const task = await rpc('frame.task.get', copy(input));
      if (!owns(token)) return null;
      if (!isFrameTaskResponse(task) || !record(task) || task.id !== taskId || task.projectId !== token.projectId) throw new Error(safeFailure);
      return mergeTask(task, token);
    } catch { if (owns(token)) emit({ historyError: true, error: safeFailure, errorMessage: msg('timeline.frame.safeFailure') }); return null; }
  }
  async function list(direction: 'latest' | 'older' | 'newer' = 'latest'): Promise<FrameListResponse | null> {
    if (!usable() || direction !== 'latest' && state.loading) return null;
    let cursor: string | null = null, trail: (string | null)[] = [];
    if (direction === 'older') {
      if (!state.nextCursor || state.pageTrail.length >= maxHistoryPages - 1) return null;
      cursor = state.nextCursor; trail = [...state.pageTrail, state.pageCursor];
    } else if (direction === 'newer') {
      if (!state.pageTrail.length) return null;
      cursor = state.pageTrail.at(-1) ?? null; trail = state.pageTrail.slice(0, -1);
    }
    if (state.loading && pendingListCursor === cursor) return null;
    const token = owner(), serial = ++listSerial;
    const input = inputFor('frame.task.list', { projectId: token.projectId, limit: FRAME_LIMITS.pageSize, ...(cursor ? { cursor } : {}) });
    pendingListCursor = cursor; emit({ loading: true, error: '', errorMessage: null });
    try {
      const result = await rpc('frame.task.list', copy(input));
      if (!owns(token) || serial !== listSerial) return null;
      if (!isFrameListResponse('frame.task.list', input, result) || !record(result) || !Array.isArray(result.items)) throw new Error(safeFailure);
      const page = (result.items as FrameTask[]).map(task => rememberTask(task, token)), ids = new Set(page.map(task => task.id));
      // Keep the user's acknowledged/unknown task and known active work visible
      // independently of page navigation. History itself replaces, never grows.
      const pinned = [...knownTasks.values()].filter(task => !ids.has(task.id) && (activeStates.has(task.state) || task.id === state.focusedTaskId || task.id === state.currentTaskPending || task.id === state.pending?.input.taskId));
      const tasks = [...page, ...pinned].slice(0, FRAME_LIMITS.maxPageSize);
      emit({ tasks, pageCursor: cursor, pageTrail: trail, nextCursor: trail.length >= maxHistoryPages - 1 ? null : result.nextCursor as string | null, historyLoaded: true, historyError: false,
        ...(tasks.some(task => task.id === state.currentTaskPending && task.revision >= (state.acknowledged?.revision || 1)) ? { currentTaskPending: null } : {}) });
      for (const task of tasks) announceResult(task, token);
      return result as unknown as FrameListResponse;
    } catch { if (owns(token) && serial === listSerial) emit({ historyError: true, error: safeFailure, errorMessage: msg('timeline.frame.safeFailure') }); return null; }
    finally { if (owns(token) && serial === listSerial) { pendingListCursor = undefined; emit({ loading: false }); } }
  }
  function setPending(value: FramePending | null): void {
    if (value) pendingByProject.set(value.input.projectId, value);
    else if (state.projectId) pendingByProject.delete(state.projectId);
    emit({ pending: value });
  }
  async function acceptAcknowledgement(pending: FramePending, ack: unknown, token: FrameOwnerToken): Promise<FrameTask | null> {
    if (!owns(token) || state.pending !== pending) return null;
    if (!isFrameMutationResponse(pending.operation, pending.input, ack)) throw new Error(safeFailure);
    const acknowledged = ack as FrameTask;
    setPending(null);
    emit({ acknowledged: copy(acknowledged), currentTaskPending: acknowledged.id, focusedTaskId: acknowledged.id, phase: 'idle', message: '原请求已受理。此回执是受理时的快照，正在读取任务当前状态。', messageDescriptor: msg('timeline.frame.acceptedSnapshot') });
    const current = await readTask(acknowledged.id);
    if (current && owns(token)) emit({ message: '原请求已受理；下方显示已核验的任务当前状态。', messageDescriptor: msg('timeline.frame.acceptedVerified') });
    return acknowledged;
  }
  async function submit(pending: FramePending): Promise<FrameTask | null> {
    const token = owner();
    if (!usable() || state.phase === 'submitting') return null;
    setPending(pending);
    emit({ phase: 'submitting', actionTaskId: pending.input.taskId || null, error: '', errorMessage: null, message: '', messageDescriptor: null });
    try {
      const ack = await rpc(pending.operation, copy(pending.input));
      if (!owns(token)) return null;
      return await acceptAcknowledgement(pending, ack, token);
    } catch (error) {
      const code = failureCode(error);
      const rejected = await frameRequestNotAccepted(error, pending.operation, pending.input);
      if (!owns(token) || state.pending !== pending) return null;
      if (rejected) {
        setPending(null);
        emit({ phase: 'idle', historyError: true, messageDescriptor: msg(code === 'FRAME_RESULT_INVALID' ? 'timeline.frame.recoverRefused' : 'timeline.frame.refused'), message: code === 'FRAME_RESULT_INVALID'
          ? '本次恢复已确认未受理：没有可完整核验的本地 PNG。原任务保留，没有重新解码；请重新读取任务后决定是否明确新建提取。'
          : '本次操作已确认未受理，原任务保持不变。请重新读取任务后，再明确选择下一步。' });
      } else emit({ phase: 'unknown', message: '是否受理仍待确认。已保留原操作和完整输入；请核对同一请求，不要新建重复提取。', messageDescriptor: msg('timeline.frame.outcomeUnknown') });
      return null;
    } finally { if (owns(token)) emit({ actionTaskId: null, ...(submittingPhase() ? { phase: state.pending ? 'unknown' : 'idle' } : {}) }); }
  }
  async function capture(intent: FrameCaptureIntent | null | undefined): Promise<FrameTask | null> {
    if (!usable() || frameCaptureBusy(state) || !intent || Object.keys(intent).sort().join(',') !== 'sourceAssetId,sourceFrame,sourceHash,sourceScope') return null;
    const asset = state.sourceAsset;
    if (!asset || !asset.id || !asset.sha256 || typeof asset.mimeType !== 'string') return null;
    const count = sourceFrameCount(asset.duration);
    if (intent.sourceScope !== state.sourceScope || intent.sourceAssetId !== asset.id || intent.sourceHash !== asset.sha256 || asset.projectId !== state.projectId || !['video/mp4', 'video/webm'].includes(asset.mimeType) || count === null || !Number.isSafeInteger(intent.sourceFrame) || intent.sourceFrame < 0 || intent.sourceFrame >= count) return null;
    if ([...knownTasks.values()].some(task => activeStates.has(task.state) && task.sourceAssetId === asset.id && task.sourceHash === asset.sha256 && task.sourceFrame === intent.sourceFrame)) {
      emit({ message: '此源时间点已有未完成任务。请先核对下面的原任务，避免重复提取。', messageDescriptor: msg('timeline.frame.duplicate') }); return null;
    }
    let input: FrameInput;
    try { input = inputFor('frame.extract', { projectId: state.projectId, sourceAssetId: asset.id, sourceHash: asset.sha256, sourceFrame: intent.sourceFrame, requestId: createRequestId() }); }
    catch { emit({ error: '无法创建有效请求标识。尚未提交提取。', errorMessage: msg('timeline.frame.invalidCaptureId') }); return null; }
    return submit(freeze({ operation: 'frame.extract', input, sourceScope: state.sourceScope, sourceName: asset.name || '', sourceFrame: intent.sourceFrame }));
  }
  async function control(operation: string, candidate: FrameTask | null | undefined): Promise<FrameTask | null> {
    if (!usable() || frameCaptureBusy(state)) return null;
    const task = state.tasks.find(item => item.id === candidate?.id);
    if (!task || task.projectId !== state.projectId || canonicalFrameInput(task) !== canonicalFrameInput(candidate) || !(operation === 'frame.task.cancelQueued' ? frameCanCancel(task) : frameCanRecover(task))) return null;
    let input: FrameInput;
    try { input = inputFor(operation, { projectId: state.projectId, taskId: task.id, expectedRevision: task.revision, requestId: createRequestId() }); }
    catch { emit({ error: '无法创建有效请求标识。尚未提交操作。', errorMessage: msg('timeline.frame.invalidControlId') }); return null; }
    return submit(freeze({ operation, input, sourceScope: state.sourceScope, sourceName: '', sourceFrame: task.sourceFrame }));
  }
  async function reconcileUnknown(): Promise<FrameTask | null> {
    const pending = state.pending;
    if (!usable() || !pending || state.phase === 'submitting') return null;
    const token = owner();
    emit({ phase: 'submitting', error: '', errorMessage: null });
    try {
      const input = inputFor('frame.request.get', { projectId: pending.input.projectId, requestId: pending.input.requestId });
      const receipt = await rpc('frame.request.get', copy(input));
      if (!owns(token) || state.pending !== pending) return null;
      if (!isFrameRequestResponse(receipt)) throw new Error(safeFailure);
      const value = receipt as FrameRequestReceipt | null;
      if (value && (value.projectId !== input.projectId || value.requestId !== input.requestId || value.operation !== pending.operation)) throw new Error(safeFailure);
      if (!value) { emit({ phase: 'unknown', message: '尚未找到原请求回执。原标识和输入仍保留；可再次核对，或明确重发同一请求。', messageDescriptor: msg('timeline.frame.receiptMissing') }); return null; }
      return await acceptAcknowledgement(pending, value.response, token);
    } catch { if (owns(token)) emit({ phase: 'unknown', error: safeFailure, errorMessage: msg('timeline.frame.safeFailure') }); return null; }
    finally { if (owns(token) && submittingPhase()) emit({ phase: state.pending ? 'unknown' : 'idle' }); }
  }
  async function revealResult(candidate: FrameTask | null | undefined): Promise<boolean> {
    if (!usable() || state.pending || state.actionTaskId || candidate?.state !== 'succeeded') return false;
    const token = owner(), before = state.tasks.find(task => task.id === candidate.id);
    if (!before || canonicalFrameInput(before) !== canonicalFrameInput(candidate)) return false;
    const current = await readTask(before.id);
    const stillCurrent = (): boolean => owns(token) && usable() && state.tasks.some(task => task.id === before.id && task.state === 'succeeded' && canonicalFrameInput(task.result) === canonicalFrameInput(before.result));
    if (!current || !current.result || !stillCurrent()) return false;
    try { return await revealAsset(current.result.assetId, current.projectId, stillCurrent) !== false; }
    catch { if (owns(token)) emit({ error: '无法打开此 PNG。当前编辑仍保留。', errorMessage: msg('timeline.frame.revealFailed') }); return false; }
  }
  return {
    getSnapshot: (): FrameExtractionState => state, getState: (): FrameExtractionState => state,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    configure(next: FrameExtractionConfiguration = {}): void {
      if (!disposed && configuration && next.sourceAsset?.id === state.sourceAsset?.id && next.sourceAsset?.sha256 === state.sourceAsset?.sha256 && ['projectId', 'sourceScope', 'sourceAsset', 'assets', 'visible', 'blocked'].every(key => configuration?.[key] === next[key])) return;
      configuration = { ...next };
      const projectId = next.projectId || null, sourceScope = next.sourceScope || null;
      const changedProject = projectId !== state.projectId;
      const changed = changedProject || sourceScope !== state.sourceScope || next.sourceAsset?.id !== state.sourceAsset?.id || next.sourceAsset?.sha256 !== state.sourceAsset?.sha256 || Boolean(next.visible) !== state.visible;
      if (changed) { epoch++; listSerial++; pendingListCursor = undefined; }
      if (changedProject) knownTasks.clear();
      disposed = false;
      const pending = projectId ? pendingByProject.get(projectId) || null : null;
      emit({ ...(changedProject ? initial() : {}), projectId, sourceScope, sourceAsset: next.sourceAsset ? copy(next.sourceAsset) : null, assets: copy(next.assets || []) as FrameAsset[], visible: Boolean(next.visible), blocked: Boolean(next.blocked), pending,
        ...(changed ? { loading: false, actionTaskId: null, phase: pending ? 'unknown' : 'idle' } : {}) });
    },
    capture, readTask, refreshTasks: (): Promise<FrameListResponse | null> => list('latest'), loadMoreTasks: (): Promise<FrameListResponse | null> => list('older'), previousTasks: (): Promise<FrameListResponse | null> => list('newer'), reconcileUnknown,
    retryUnknown: (): Promise<FrameTask | null> => usable() && state.pending && state.phase !== 'submitting' ? submit(state.pending) : Promise.resolve(null),
    cancelQueued: (task: FrameTask): Promise<FrameTask | null> => control('frame.task.cancelQueued', task), recoverResult: (task: FrameTask): Promise<FrameTask | null> => control('frame.task.recoverResult', task), revealResult,
    async refreshActive(): Promise<void> { const token = owner(); for (const task of state.tasks.filter(task => activeStates.has(task.state))) { if (!owns(token) || !usable()) break; await readTask(task.id); } },
    dispose(): void { epoch++; listSerial++; disposed = true; listeners.clear(); },
  };
}
