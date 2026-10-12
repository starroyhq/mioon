import { lastProjectEnvelopeSchema, lastProjectPutSchema } from '@mioon/contracts/last-project';
import type { LastProjectEnvelope, LastProjectPut } from '@mioon/contracts/last-project';
import { createLastProjectClient, lastProjectFailure, LastProjectRequestError } from './last-project-client.ts';
import type { LastProjectClient, LastProjectFailure, LastProjectSupported } from './last-project-client.ts';

export type LastProjectPhase = 'idle' | 'loading' | 'saved' | 'pending' | 'error' | 'conflict' | 'unavailable';
export interface LastProjectState {
  phase: LastProjectPhase;
  identityBlocked: boolean;
  workspaceScope: string | null;
  instanceId: string | null;
  currentProjectId: string | null;
  currentEpoch: number | null;
  rememberedProjectId: string | null;
  revision: number | null;
  updatedAt: string | null;
  targetStatus: 'matching' | 'missing' | 'unset' | null;
  pendingInput: LastProjectPut | null;
  queuedProjectId: string | null;
  uncertain: boolean;
  failure: LastProjectFailure | null;
  canRetry: boolean;
  canRecheck: boolean;
  reading: boolean;
  rechecked: LastProjectSupported | null;
}
export interface LastProjectDiscovery {
  envelope: LastProjectEnvelope;
  workspaceScope: string | null;
  candidateProjectId: string | null;
  epoch: number;
}
interface Selection { projectId: string; epoch: number }
interface Pending { input: LastProjectPut; selection: Selection; uncertain: boolean }
interface Options { client?: LastProjectClient; getEpoch?: () => number; onChange?: (state: LastProjectState) => void }
const clone = <T,>(value: T): T => structuredClone(value);
const validEpoch = (epoch: number): boolean => Number.isSafeInteger(epoch) && epoch >= 0;

/** Only explicit, successfully opened projects enter this renderer-local queue.
 * Reads and ACKs never select projects, hydrate drafts, or execute business work. */
export function createLastProjectController({ client = createLastProjectClient(), getEpoch, onChange = () => {} }: Options = {}) {
  let active = true, generation = 1, navigationEpoch = 0, readSerial = 0, writeSerial = 0;
  let baseline: LastProjectSupported | null = null, identityBlocked = false, blocked = false, unsupported = false;
  let selected: Selection | null = null, queued: Selection | null = null, pending: Pending | null = null;
  let flight: Promise<void> | null = null, initialRead: Promise<LastProjectDiscovery | null> | null = null;
  let state: LastProjectState = { phase: 'idle', identityBlocked: false, workspaceScope: null, instanceId: null, currentProjectId: null, currentEpoch: null,
    rememberedProjectId: null, revision: null, updatedAt: null, targetStatus: null, pendingInput: null, queuedProjectId: null,
    uncertain: false, failure: null, canRetry: false, canRecheck: true, reading: false, rechecked: null };
  const epoch = () => getEpoch ? getEpoch() : navigationEpoch;
  const belongs = (owner: number) => active && owner === generation;
  const sameSelection = (a: Selection | null, b: Selection | null) => Boolean(a && b && a.projectId === b.projectId && a.epoch === b.epoch);
  const current = (selection: Selection | null) => Boolean(selection && selection.epoch === epoch());
  function snapshot(): LastProjectState {
    return clone({ ...state, identityBlocked, pendingInput: pending?.input ?? null, queuedProjectId: queued?.projectId ?? null,
      uncertain: pending?.uncertain ?? false,
      canRetry: active && blocked && state.phase !== 'pending' && state.failure !== null && !flight && Boolean(pending && sameSelection(pending.selection, selected) && current(selected)) && !identityBlocked && !unsupported && state.failure?.kind !== 'conflict',
      canRecheck: active && !state.reading && !unsupported });
  }
  function emit(patch: Partial<LastProjectState> = {}) { state = { ...state, ...patch }; if (active) onChange(snapshot()); }
  function identityError(code: 'LAST_PROJECT_SCOPE_MISMATCH' | 'LAST_PROJECT_STALE_INSTANCE') {
    identityBlocked = true; blocked = true;
    return new LastProjectRequestError(code, 409);
  }
  function checked(value: unknown): LastProjectEnvelope {
    const parsed = lastProjectEnvelopeSchema.safeParse(value);
    if (!parsed.success) throw new LastProjectRequestError('LAST_PROJECT_PROTOCOL_UNKNOWN');
    return parsed.data;
  }
  function sameIdentity(next: LastProjectSupported) {
    if (baseline && next.workspaceScope !== baseline.workspaceScope) throw identityError('LAST_PROJECT_SCOPE_MISMATCH');
    if (baseline && next.instanceId !== baseline.instanceId) throw identityError('LAST_PROJECT_STALE_INSTANCE');
  }
  function fail(error: unknown, write: boolean) {
    const failure = lastProjectFailure(error);
    if (failure.code === 'LAST_PROJECT_SCOPE_MISMATCH' || failure.code === 'LAST_PROJECT_STALE_INSTANCE') identityBlocked = true;
    blocked = true;
    if (write && pending && failure.kind === 'unknown') pending.uncertain = true;
    // Neither a reread nor a rejected retry cancels an earlier ambiguous PUT.
    const evidence = pending?.uncertain && state.failure ? state.failure : failure;
    emit({ failure: evidence, phase: pending?.uncertain ? 'error' : failure.kind === 'conflict' ? 'conflict' : failure.kind === 'unavailable' ? 'unavailable' : 'error',
      ...(identityBlocked ? { workspaceScope: null, instanceId: null } : {}) });
  }
  function accept(next: LastProjectSupported) {
    baseline = clone(next);
    emit({ workspaceScope: next.workspaceScope, instanceId: next.instanceId, rememberedProjectId: next.projectId,
      revision: next.revision, updatedAt: next.updatedAt, targetStatus: next.targetStatus });
  }
  async function read(initial: boolean): Promise<LastProjectDiscovery | null> {
    if (!active || unsupported) return null;
    const owner = generation, serial = ++readSerial, capturedEpoch = epoch(), capturedWrite = writeSerial;
    emit({ reading: true, ...(initial && !selected ? { phase: 'loading' as const } : {}) });
    try {
      const next = checked(await client.get());
      if (!belongs(owner) || serial !== readSerial || capturedWrite !== writeSerial) return null;
      if (!next.supported) {
        unsupported = true; blocked = true; queued = null;
        emit({ phase: 'unavailable', workspaceScope: null, instanceId: null, failure: null });
        return { envelope: next, workspaceScope: null, candidateProjectId: null, epoch: capturedEpoch };
      }
      sameIdentity(next);
      if (identityBlocked) return null;
      if (!baseline && !pending) {
        accept(next);
        // Only the original discovery may release selections already authorized
        // while it was in flight. A manual reread never resumes a stopped queue.
        if (initial && !blocked) {
          emit({ phase: queued ? 'pending' : 'idle', failure: null });
          void drain();
        } else { emit({ rechecked: next }); }
      } else {
        emit({ rechecked: next });
        if (!pending && baseline && (next.revision !== baseline.revision || next.projectId !== baseline.projectId)) {
          throw new LastProjectRequestError('LAST_PROJECT_CONFLICT', 409);
        }
      }
      return { envelope: next, workspaceScope: next.workspaceScope,
        candidateProjectId: initial && !selected && capturedEpoch === epoch() && next.targetStatus === 'matching' ? next.projectId : null,
        epoch: capturedEpoch };
    } catch (error) {
      if (belongs(owner) && serial === readSerial && capturedWrite === writeSerial) fail(error, false);
      return null;
    } finally {
      if (belongs(owner) && serial === readSerial) emit({ reading: false });
    }
  }
  function discover(): Promise<LastProjectDiscovery | null> {
    if (initialRead) return initialRead;
    const work = read(!baseline && !blocked);
    initialRead = work;
    void work.finally(() => { if (initialRead === work) initialRead = null; });
    return work;
  }
  async function execute(operation: Pending): Promise<void> {
    const owner = generation;
    pending = operation; writeSerial++;
    emit({ phase: 'pending', failure: operation.uncertain ? state.failure : null });
    const work = (async () => {
      try {
        const value = checked(await client.put(clone(operation.input)));
        if (!belongs(owner) || pending !== operation) return;
        if (!value.supported) throw new LastProjectRequestError('LAST_PROJECT_WRITE_UNSUPPORTED');
        sameIdentity(value);
        if (value.workspaceScope !== operation.input.workspaceScope || value.instanceId !== operation.input.instanceId ||
            value.revision !== operation.input.expectedRevision + 1 || value.projectId !== operation.input.projectId || value.targetStatus !== 'matching') {
          throw new LastProjectRequestError('LAST_PROJECT_PROTOCOL_UNKNOWN');
        }
        // A conflicting identity observed by a concurrent read cannot be undone
        // by an older valid ACK arriving afterwards.
        if (identityBlocked) throw new LastProjectRequestError('LAST_PROJECT_RESPONSE_UNKNOWN');
        pending = null; blocked = false; writeSerial++;
        accept(value);
        emit({ phase: sameSelection(operation.selection, selected) && current(selected) && !queued ? 'saved' : queued ? 'pending' : 'idle', failure: null });
      } catch (error) { if (belongs(owner) && pending === operation) fail(error, true); }
    })();
    flight = work;
    try { await work; }
    finally { if (flight === work) flight = null; }
    if (belongs(owner)) { emit(); if (!blocked) await drain(); }
  }
  async function drain(): Promise<void> {
    if (!active || flight || pending || blocked || unsupported || identityBlocked || !baseline || !queued) return;
    const selection = queued;
    if (!current(selection) || !sameSelection(selection, selected)) { queued = null; emit(); return; }
    queued = null;
    const parsed = lastProjectPutSchema.safeParse({ workspaceScope: baseline.workspaceScope, instanceId: baseline.instanceId,
      expectedRevision: baseline.revision, projectId: selection.projectId });
    if (!parsed.success) { fail(new LastProjectRequestError('LAST_PROJECT_VALIDATION', 400), false); return; }
    await execute({ input: clone(parsed.data), selection: clone(selection), uncertain: false });
  }
  function rememberOpened(projectId: string, capturedEpoch: number): void {
    if (!active || !validEpoch(capturedEpoch) || capturedEpoch !== epoch()) return;
    // Validate the UUID using the shared write boundary even before discovery.
    const valid = lastProjectPutSchema.safeParse({ workspaceScope: '0'.repeat(64), instanceId: '00000000-0000-4000-8000-000000000000', expectedRevision: 0, projectId });
    if (!valid.success) return;
    selected = { projectId, epoch: capturedEpoch };
    if (sameSelection(pending?.selection ?? null, selected)) { emit({ currentProjectId: projectId, currentEpoch: capturedEpoch }); return; }
    queued = clone(selected);
    emit({ currentProjectId: projectId, currentEpoch: capturedEpoch, ...(blocked || unsupported ? {} : { phase: 'pending' as const }) });
    if (baseline) void drain();
    else if (!initialRead && !blocked && !unsupported) void discover();
  }
  function invalidateNavigation(next: number): void {
    if (!validEpoch(next) || next < navigationEpoch) return;
    navigationEpoch = next;
    if (queued && queued.epoch !== next) queued = null;
    emit();
  }
  async function retry(): Promise<void> {
    if (!snapshot().canRetry || !pending) return;
    await execute(pending);
  }
  async function recheck(): Promise<void> { if (snapshot().canRecheck) await read(false); }
  async function flush(timeoutMs = 400): Promise<boolean> {
    if (!active || blocked || unsupported) return !pending && !queued;
    const owner = generation;
    const deadline = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(2000, timeoutMs)) : 400;
    const work = (async () => {
      if (initialRead) await initialRead;
      while (belongs(owner) && !blocked) {
        const waiting = flight;
        if (waiting) await waiting;
        if (!belongs(owner)) return false;
        await drain();
        if (!flight) break;
      }
      return belongs(owner) && !pending && !queued;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), deadline); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  function dispose(): void {
    if (!active) return;
    active = false; generation++; readSerial++; initialRead = null; queued = null;
    if (pending) { pending.uncertain = true; blocked = true; state = { ...state, phase: 'error', failure: lastProjectFailure(new LastProjectRequestError('LAST_PROJECT_OWNER_DISPOSED')) }; }
    state = { ...state, reading: false };
  }
  function activate(): void { if (!active) { active = true; generation++; emit(); } }
  return { discover, rememberOpened, invalidateNavigation, retry, recheck, flush, dispose, activate,
    getState: snapshot, getVerifiedScope: () => identityBlocked || unsupported ? null : baseline?.workspaceScope ?? null };
}
export type LastProjectController = ReturnType<typeof createLastProjectController>;
