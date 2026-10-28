import {canonicalPrevisValue,isPrevisMutationResponse,isPrevisNodeRecord} from '@mioon/contracts';
import type {PrevisNodeRecord,PrevisScene} from '@mioon/contracts';

// Autosave for one open previs node. Saves run one at a time, 0.8 s after the
// last edit, under the node's scene revision. An uncertain answer (network,
// server error, malformed reply) resends the same request, whose receipt
// replays it exactly. A revision conflict is read back from the node the
// server returns: if that node is this save, it was applied; otherwise the
// scene changed elsewhere and saving stops until the user reloads or overwrites.
export const PREVIS_SAVE_DELAY_MS = 800;
const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000]);
export type PrevisSaveStatus = 'saved' | 'pending' | 'saving' | 'retrying' | 'conflict' | 'failed' | 'readOnly';
export interface PrevisSaveState {
  readonly status: PrevisSaveStatus;
  /** The node as last confirmed by the server. */
  readonly node: PrevisNodeRecord;
  /** The newer node found on a conflict, offered for reloading. */
  readonly conflict: PrevisNodeRecord | null;
  readonly errorCode: string | null;
}
interface Failure {code?: unknown; status?: unknown; details?: unknown}
export interface PrevisSaverOptions {
  readonly node: PrevisNodeRecord;
  readonly readOnly?: boolean;
  readonly rpc: (operation: string, input: Record<string, unknown>) => Promise<unknown>;
  readonly requestId: () => string;
  readonly onState?: (state: PrevisSaveState) => void;
  readonly onSaved?: (node: PrevisNodeRecord) => void;
  readonly setTimer?: (callback: () => void, delay: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly delayMs?: number;
}
const same = (a: unknown, b: unknown): boolean => canonicalPrevisValue(a) === canonicalPrevisValue(b);
// Answers that may hide an applied save: resend the same request.
function uncertain(error: unknown): boolean {
  const failure = (error ?? {}) as Failure, status = typeof failure.status === 'number' ? failure.status : undefined;
  if (failure.code === 'PREVIS_CAPACITY') return false;
  return status === undefined || status >= 500 || failure.code === 'BACKEND_PROTOCOL_ERROR' || failure.code === 'NETWORK';
}

export function createPrevisSaver(options: PrevisSaverOptions) {
  const setTimer = options.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const delay = options.delayMs ?? PREVIS_SAVE_DELAY_MS;
  let node = options.node, wanted: PrevisScene = options.node.scene, timer: unknown = null, running: Promise<void> | null = null;
  let status: PrevisSaveStatus = options.readOnly ? 'readOnly' : 'saved', conflict: PrevisNodeRecord | null = null, errorCode: string | null = null, closed = false;
  const publish = (): void => { options.onState?.({status, node, conflict, errorCode}); };
  const set = (next: PrevisSaveStatus): void => { status = next; publish(); };
  const stopTimer = (): void => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimer(resolve, ms); });
  async function send(scene: PrevisScene, expectedSceneRevision: number, requestId: string): Promise<PrevisNodeRecord | 'conflict' | 'failed'> {
    const input = {projectId: node.projectId, nodeId: node.id, expectedSceneRevision, scene, requestId};
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await options.rpc('previs.scene.set', input);
        if (isPrevisMutationResponse('previs.scene.set', input, result)) return result as PrevisNodeRecord;
        throw Object.assign(new Error('Invalid previs acknowledgement'), {code: 'BACKEND_PROTOCOL_ERROR'});
      } catch (error) {
        const failure = (error ?? {}) as Failure;
        if (failure.code === 'REVISION_CONFLICT') {
          const current = (failure.details as {current?: unknown} | undefined)?.current;
          if (!isPrevisNodeRecord(current) || current.id !== node.id) { errorCode = 'REVISION_CONFLICT'; return 'failed'; }
          // An earlier attempt of this save may have been applied before its receipt was pruned.
          if (current.sceneRevision === expectedSceneRevision + 1 && same(current.scene, scene)) return current;
          conflict = current; return 'conflict';
        }
        if (!uncertain(error) || closed && attempt > 0) { errorCode = typeof failure.code === 'string' ? failure.code : 'PREVIS_SAVE_FAILED'; return 'failed'; }
        set('retrying');
        await wait(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!);
      }
    }
  }
  async function drain(): Promise<void> {
    while (!same(wanted, node.scene) && status !== 'conflict' && status !== 'failed' && status !== 'readOnly') {
      const scene = wanted;
      set('saving');
      const outcome = await send(scene, node.sceneRevision, options.requestId());
      if (outcome === 'conflict') { set('conflict'); return; }
      if (outcome === 'failed') { set('failed'); return; }
      node = outcome; options.onSaved?.(node);
    }
    if (status === 'saving' || status === 'retrying' || status === 'pending') set('saved');
  }
  function start(): Promise<void> {
    stopTimer();
    if (!running) running = drain().finally(() => { running = null; if (!same(wanted, node.scene) && status === 'saved') schedule(wanted); });
    return running;
  }
  /** The editor's scene changed; save it after a pause. */
  function schedule(scene: PrevisScene): void {
    wanted = scene;
    if (status === 'readOnly' || status === 'conflict' || status === 'failed' || closed) return;
    if (same(wanted, node.scene) && !running) { stopTimer(); if (status !== 'saved') set('saved'); return; }
    stopTimer();
    if (!running) set('pending');
    timer = setTimer(() => { timer = null; void start(); }, delay);
  }
  /** Saves now and waits until the latest scene is saved or saving stops. */
  async function flush(): Promise<PrevisSaveState> {
    if (status !== 'readOnly' && status !== 'conflict' && status !== 'failed') { while (running) await running; if (!same(wanted, node.scene)) await start(); }
    return {status, node, conflict, errorCode};
  }
  /** After a conflict: keep the other version and drop local edits. */
  function reload(): PrevisNodeRecord | null {
    if (!conflict) return null;
    node = conflict; wanted = conflict.scene; conflict = null; errorCode = null; set('saved');
    return node;
  }
  /** After a conflict: save the local scene over the other version. */
  function overwrite(): Promise<void> {
    if (!conflict) return Promise.resolve();
    node = {...conflict, scene: conflict.scene}; conflict = null; errorCode = null; set('pending');
    return start();
  }
  /** The canvas renamed or moved the node: adopt it when the scene is the one this editor last saved. */
  function adopt(record: PrevisNodeRecord): void {
    if (record.id === node.id && record.sceneRevision === node.sceneRevision && record.revision > node.revision) { node = record; publish(); }
  }
  /** A newer copy of the node arrived from elsewhere (another window, a tool).
   * While nothing is waiting to save, its scene replaces this one and the
   * caller shows it; otherwise the next save meets the conflict and reads back. */
  function external(record: PrevisNodeRecord): 'reloaded' | 'kept' {
    if (record.id !== node.id) return 'kept';
    if (record.sceneRevision === node.sceneRevision) { adopt(record); return 'kept'; }
    if (record.sceneRevision < node.sceneRevision || running || timer !== null || !same(wanted, node.scene) || status !== 'saved') return 'kept';
    node = record; wanted = record.scene; publish();
    return 'reloaded';
  }
  /** After a refused save: send the latest scene again as a new request. A
   * refusal is definite, so the earlier request was not applied. */
  function retry(): Promise<void> {
    if (status !== 'failed' || closed) return Promise.resolve();
    errorCode = null; set('pending');
    return start();
  }
  return {schedule, flush, reload, overwrite, adopt, external, retry, close: () => { closed = true; stopTimer(); },
    state: (): PrevisSaveState => ({status, node, conflict, errorCode})};
}
export type PrevisSaver = ReturnType<typeof createPrevisSaver>;
