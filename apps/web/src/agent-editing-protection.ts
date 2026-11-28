import type { AgentTaskClaim, AgentTaskEditingInput, AgentTaskTarget } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { agentTaskEditingRejectedReceiptSchema, agentTaskEditingTargetRevisionKind, agentTaskEditingWritesSchema } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { projectApiPath } from '../../../packages/contracts/src/project-file.ts';
const editingPath = (projectId: string): string => projectApiPath(projectId, 'agent', 'tasks', 'v2', 'editing');

export function agentEditingOwnerIdentity(workspaceScope: string, windowId: string, targets: readonly AgentTaskTarget[]): string { return `${workspaceScope}:${windowId}:${targets.map(target => `${target.kind}:${target.id}`).sort().join(',')}`; }
export function agentEditingOwnerInWindow(ownerId: string, workspaceScope: string, windowId: string): boolean { return ownerId.startsWith(`${workspaceScope}:${windowId}:`); }

interface EditingFault { code: string; details?: unknown }
interface EditingReceipt { requestId: string; projectId: string; ownerId: string; generation: number; sequence: number; error?: EditingFault }
export type AgentEditingClaimResult = { status: 'acquired'; requestId?: string } |
  ({ status: 'rejected'; requestId?: string } & EditingFault) | ({ status: 'unknown'; requestId: string } & EditingFault);
export interface AgentEditingObservation { claims: AgentTaskClaim[]; targets: AgentTaskTarget[]; timelineRevision?:number; ownerVersion?: {generation:number;sequence:number} | null; receipt?: EditingReceipt }
export interface AgentEditingClient { read(projectId: string, ownerId?: string): Promise<AgentEditingObservation>; lookup?(projectId:string,ownerId:string,requestId:string):Promise<AgentEditingObservation>; update(input: AgentTaskEditingInput, keepalive?: boolean): Promise<AgentEditingObservation> }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
interface EditingHttpOptions { fetchImpl?: typeof fetch; timeoutMs?: number }
async function editingData(url: string, {fetchImpl = globalThis.fetch, timeoutMs = 12000}: EditingHttpOptions,
  input?: AgentTaskEditingInput, keepalive = false) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(url, {method: input ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
        signal: controller.signal, ...(input ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input), keepalive} : {})});
      const envelope: unknown = await response.json();
      if (response.ok && record(envelope) && envelope.ok === true && record(envelope.data)) return envelope.data;
      if (record(envelope) && envelope.ok === false && record(envelope.error) && typeof envelope.error.code === 'string') {
        const {code, message, details} = envelope.error;
        throw Object.assign(new Error(typeof message === 'string' ? message : 'Editing protection rejected'),
          {code, details, definitive: response.status >= 400 && response.status < 500});
      }
      throw new Error('Editing protection unconfirmed');
    })(), new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Editing protection unconfirmed')), {once: true}))]);
  } finally { clearTimeout(timeout); }
}
export async function readAgentEditingWrites(projectId: string, options: EditingHttpOptions = {}) {
  return agentTaskEditingWritesSchema.parse(await editingData(`${editingPath(projectId)}/writes`, options));
}
export function createAgentEditingClient(options: EditingHttpOptions = {}): AgentEditingClient {
  async function request(url: string, input?: AgentTaskEditingInput, keepalive = false) {
    const data = await editingData(url, options, input, keepalive);
    const {claims, ownerVersion} = data, targets = data.targets ?? [];
    if (!Array.isArray(claims) || claims.some(claim => !record(claim) || typeof claim.id !== 'string' || typeof claim.projectId !== 'string' || typeof claim.ownerId !== 'string' || !record(claim.target) || typeof claim.target.kind !== 'string' || typeof claim.target.id !== 'string' || !Number.isSafeInteger(claim.target.revision) || !['active', 'uncertain'].includes(String(claim.state)))) throw new Error('Editing protection response invalid');
    if (!Array.isArray(targets) || targets.some(target => !record(target) || typeof target.kind !== 'string' || typeof target.id !== 'string' || !Number.isSafeInteger(target.revision))) throw new Error('Editing target revisions invalid');
    if (input && !receiptMatches(data, input)) throw new Error('Editing acknowledgment identity mismatch');
    if (ownerVersion != null && (!record(ownerVersion) || typeof ownerVersion.generation !== 'number' || !Number.isSafeInteger(ownerVersion.generation) ||
        typeof ownerVersion.sequence !== 'number' || !Number.isSafeInteger(ownerVersion.sequence))) throw new Error('Editing owner version invalid');
    const receipt = record(data.receipt) ? data.receipt : undefined;
    const acknowledged = receipt && typeof receipt.requestId === 'string' && typeof receipt.projectId === 'string' &&
      typeof receipt.ownerId === 'string' && Number.isSafeInteger(receipt.generation) && Number.isSafeInteger(receipt.sequence)
      ? {requestId: receipt.requestId, projectId: receipt.projectId, ownerId: receipt.ownerId, generation: receipt.generation as number, sequence: receipt.sequence as number}
      : undefined;
    const rejected = receipt && Object.hasOwn(receipt, 'error') ? agentTaskEditingRejectedReceiptSchema.parse(receipt) : undefined;
    return {claims: claims as AgentTaskClaim[], targets: targets as AgentTaskTarget[], ownerVersion: ownerVersion as AgentEditingObservation['ownerVersion'],
      ...(typeof data.timelineRevision === 'number' && Number.isSafeInteger(data.timelineRevision) ? {timelineRevision: data.timelineRevision} : {}),
      ...(rejected ?? acknowledged ? {receipt: rejected ?? acknowledged} : {})};
  }
  return { read: (projectId, ownerId) => request(`${editingPath(projectId)}?projectId=${encodeURIComponent(projectId)}${ownerId ? `&ownerId=${encodeURIComponent(ownerId)}` : ''}`), lookup:(projectId,ownerId,requestId)=>request(`${editingPath(projectId)}?projectId=${encodeURIComponent(projectId)}&ownerId=${encodeURIComponent(ownerId)}&requestId=${encodeURIComponent(requestId)}`), update: (input, keepalive) => request(editingPath(input.projectId), input, keepalive) };
}
const receiptMatches = (receipt: unknown, input: AgentTaskEditingInput): boolean => record(receipt) &&
  (['requestId', 'projectId', 'ownerId', 'generation', 'sequence'] as const).every(key => receipt[key] === input[key]);
const sameTarget = (a: AgentTaskTarget, b: AgentTaskTarget): boolean => a.kind === b.kind && a.id === b.id;
const sameRevision = (a: AgentTaskTarget, b: AgentTaskTarget): boolean => sameTarget(a, b) && a.revision === b.revision;
const completeTargets = (given: readonly AgentTaskTarget[], expected: readonly AgentTaskTarget[], compare = sameTarget): boolean =>
  given.length === expected.length && given.every(candidate => expected.some(target => compare(candidate, target))) &&
  expected.every(target => given.filter(candidate => compare(candidate, target)).length === 1);
export function agentEditingTargetRevision(targets: readonly AgentTaskTarget[], {kind, id}: Pick<AgentTaskTarget, 'kind' | 'id'>): number {
  return targets.find(target => target.kind === agentTaskEditingTargetRevisionKind(kind) && target.id === id)?.revision ?? 0;
}
const rejectedClaim = (code: string, details?: unknown, requestId?: string): AgentEditingClaimResult => ({status: 'rejected', code, details, requestId});
const unknownClaim = (requestId: string): AgentEditingClaimResult => ({status: 'unknown', code: 'AGENT_TASK_UNKNOWN_RESULT', requestId});
const unavailableClaim = () => rejectedClaim('AGENT_TASK_EDIT_OWNER_UNCERTAIN');
export interface AgentEditingState { phase: 'idle' | 'loading' | 'acquiring' | 'active' | 'releasing' | 'uncertain' | 'retained'; claims: AgentTaskClaim[]; pending: AgentTaskEditingInput | null; timelineRevision?:number; targets?:AgentTaskTarget[]; claimResult?: AgentEditingClaimResult }
export function createAgentEditingProtection({ projectId, ownerId, targets, generation = Date.now(), client = createAgentEditingClient(), requestId = () => crypto.randomUUID(), onChange = () => {} }: { projectId: string; ownerId: string; targets: readonly AgentTaskTarget[]; generation?: number; client?: AgentEditingClient; requestId?: () => string; onChange?: (state: AgentEditingState) => void }) {
  // Captured target IDs never follow a selection change. Disposal leaves the
  // durable claim intact, including when the window loses its connection.
  const pinned = targets.map(target => ({ ...target }));
  let state: AgentEditingState = { phase: 'idle', claims: [], pending: null }, active = true, busy = false, sequence = 0, writeGeneration = generation, admissionEpoch = 0, invalidated = false, hasObservation = false;
  let exactClaim: AgentTaskEditingInput | null = null;
  const publish = (patch: Partial<AgentEditingState>) => { state = { ...state, ...patch }; if (active) onChange(state); };
  const owned = (claims: AgentTaskClaim[]) => claims.filter(claim => claim.projectId === projectId && claim.ownerId === ownerId);
  const matches = (claims: AgentTaskClaim[]) => pinned.every(target => claims.some(claim => claim.target.kind === target.kind && claim.target.id === target.id && claim.state === 'active'));
  const matchesRevision = (claims: AgentTaskClaim[], targets: readonly AgentTaskTarget[]) => targets.every(target =>
    claims.some(claim => claim.state === 'active' && sameRevision(claim.target, target)));
  const revisionConflict = (current: readonly AgentTaskTarget[], expected: readonly AgentTaskTarget[], requestId?: string) => {
    const targets = expected.flatMap(({kind, id, revision: expectedRevision}) => {
      const currentRevision = agentEditingTargetRevision(current, {kind, id});
      return currentRevision === expectedRevision ? [] : [{kind, id, expectedRevision, currentRevision}];
    });
    return targets.length ? rejectedClaim('AGENT_TASK_TARGET_CHANGED', {reason: 'revision_changed', targets}, requestId) : null;
  };
  const canEdit = () => active && !invalidated && state.phase === 'active' && !state.pending;
  async function refresh() {
    if (!active || busy) return false;
    const knownIdle = hasObservation && state.phase === 'idle' && !state.pending;
    busy = true; const epoch = admissionEpoch, wasActive=state.phase==='active';
    // A verified empty ledger remains noneditable during a GET. Its display
    // phase must not invalidate unrelated close consent on every background
    // poll; the internal busy latch still prevents any new mutation.
    if(!wasActive && !knownIdle)publish({ phase: 'loading' });
    try { const observed = state.pending && client.lookup ? await client.lookup(projectId,ownerId,state.pending.requestId) : await client.read(projectId, ownerId), claims = owned(observed.claims); if (!active || epoch !== admissionEpoch) return false;
      hasObservation = true;
      if (sequence === 0 && ownerId.startsWith('desktop:') && observed.ownerVersion) {
        writeGeneration = Math.max(writeGeneration, observed.ownerVersion.generation + 1);
      }
      for (const target of pinned) target.revision = agentEditingTargetRevision(observed.targets, target);
      const pending = state.pending;
      if (pending) {
        const identified = receiptMatches(observed.receipt, pending);
        if (identified && observed.receipt?.error) {
          const {code, details} = observed.receipt.error;
          publish({phase: claims.length ? 'retained' : 'idle', claims, pending: null, timelineRevision: observed.timelineRevision,
            targets: observed.targets, ...(pending === exactClaim ? {claimResult: rejectedClaim(code, details, pending.requestId)} : {})});
          return false;
        }
        if (pending === exactClaim && client.lookup && identified) {
          const result = revisionConflict(observed.targets, pending.targets, pending.requestId) ??
            (!invalidated && matchesRevision(claims, pending.targets) && observed.ownerVersion?.generation === pending.generation &&
              observed.ownerVersion.sequence === pending.sequence ? {status: 'acquired' as const, requestId: pending.requestId}
              : rejectedClaim('AGENT_TASK_EDIT_OWNER_UNCERTAIN', undefined, pending.requestId));
          publish({phase: result.status === 'acquired' ? 'active' : claims.length ? 'retained' : 'idle', claims, pending: null,
            timelineRevision: observed.timelineRevision, targets: observed.targets, claimResult: result});
          return result.status === 'acquired';
        }
        const done = pending !== exactClaim && (!client.lookup || identified) && (['claim','restore'].includes(pending.action) ? matches(claims) : ['release', 'resolve'].includes(pending.action) && !claims.length);
        // A GET can prove a claim exists; absence cannot prove a delayed claim
        // POST will never arrive. Never turn an unknown acquire into idle.
        if (done) { const wasClaim = ['claim','restore'].includes(pending.action); publish({ phase: wasClaim ? invalidated ? 'retained' : 'active' : 'idle', claims, pending: null,timelineRevision:observed.timelineRevision,targets:observed.targets }); return true; }
        publish({ phase: 'uncertain', claims,timelineRevision:observed.timelineRevision,targets:observed.targets }); return false;
      }
      publish({ phase: wasActive&&!invalidated&&matches(claims)?'active':claims.length ? 'retained' : 'idle', claims,timelineRevision:observed.timelineRevision,targets:observed.targets }); return true;
    } catch { if (active && epoch === admissionEpoch) publish({ phase: 'uncertain' }); return false; } finally { busy = false; }
  }
  async function update(action: AgentTaskEditingInput['action'], keepalive = false, visible?: readonly AgentTaskTarget[]) {
    if (!active || busy || state.pending || action === 'claim' && state.phase !== 'idle') return false;
    const epoch=admissionEpoch, previousPhase=state.phase,input: AgentTaskEditingInput = { requestId: requestId(), action, projectId, ownerId, generation: writeGeneration, sequence: ++sequence, targets: action==='restore'?state.claims.map(claim=>({...claim.target})):(visible ?? pinned).map(target=>({...target})) };
    if (visible) exactClaim = input;
    busy = true; publish({ phase: ['claim','restore'].includes(action) ? 'acquiring' : 'releasing', pending: input,
      claimResult: visible ? unknownClaim(input.requestId) : undefined });
    try { const claims = owned((await client.update(input, keepalive)).claims); if (!active || epoch !== admissionEpoch) return false;
      if (['claim','restore'].includes(action) && !(visible ? matchesRevision(claims, visible) : matches(claims)) || ['release', 'resolve'].includes(action) && claims.length) throw new Error('Editing protection acknowledgment mismatch');
      // A successful POST certifies the requested values even if our preceding
      // owner read had stale target metadata. Keep the last timeline revision.
      let newTargets: AgentTaskTarget[] | undefined;
      if (visible) {
        const covered = visible.map(target => ({...target, kind: agentTaskEditingTargetRevisionKind(target.kind)}));
        newTargets = [...(state.targets ?? []).filter(target => !covered.some(item => sameTarget(target, item))), ...covered];
      }
      invalidated = false; publish({ phase: ['claim','restore'].includes(action) ? 'active' : 'idle', pending: null, claims,
        ...(visible ? {claimResult: {status: 'acquired', requestId: input.requestId}, targets: newTargets} : {}) }); return true;
    } catch(error) {
      if (visible && active && epoch === admissionEpoch && record(error) && error.definitive === true && typeof error.code === 'string') {
        publish({phase: previousPhase, pending: null, claimResult: rejectedClaim(error.code, error.details, input.requestId)});
        return false;
      }
      if(active&&epoch===admissionEpoch&&record(error)&&error.definitive===true&&client.lookup){
        try{const result=await client.lookup(projectId,ownerId,input.requestId);if(!active||epoch!==admissionEpoch)return false;if(!result.receipt){publish({phase:previousPhase,pending:null});busy=false;await refresh();return false;}busy=false;return await refresh();}catch{}
      }
      if (active && epoch === admissionEpoch) publish({ phase: 'uncertain' }); return false;
    } finally { busy = false; }
  }
  function resultAtRevision(visible: readonly AgentTaskTarget[]): AgentEditingClaimResult {
    if (!active) return unavailableClaim();
    if (canEdit()) {
      return revisionConflict(state.targets ?? [], visible) ?? (matchesRevision(state.claims, visible)
        ? {status: 'acquired', requestId: state.claimResult?.requestId} : unavailableClaim());
    }
    const last = state.claimResult;
    return exactClaim && completeTargets(visible, exactClaim.targets, sameRevision) && last && last.status !== 'acquired' ? last : unavailableClaim();
  }
  async function acquireAtRevision(targets: readonly AgentTaskTarget[]): Promise<AgentEditingClaimResult> {
    const visible = targets.map(target => ({...target}));
    if (!completeTargets(visible, pinned) || !visible.every(target => Number.isSafeInteger(target.revision) && target.revision >= 0)) return rejectedClaim('AGENT_TASK_INVALID');
    if (!active || state.pending || canEdit()) return resultAtRevision(visible);
    if (busy || !['idle', 'uncertain'].includes(state.phase)) return unavailableClaim();
    // The owner read initializes the generation, but never rebases the edit
    // on content newer than the draft the caller is currently displaying.
    if (!await refresh() || state.phase !== 'idle') return unavailableClaim();
    await update('claim', false, visible);
    return resultAtRevision(visible);
  }
  async function reconcileClaimAtRevision(targets: readonly AgentTaskTarget[], requestId: string): Promise<AgentEditingClaimResult> {
    const visible = targets.map(target => ({...target}));
    if (exactClaim?.requestId !== requestId || !completeTargets(visible, exactClaim.targets, sameRevision)) return unavailableClaim();
    if (state.pending === exactClaim) await refresh();
    return state.claimResult?.requestId === requestId ? resultAtRevision(visible) : unavailableClaim();
  }
  return { getState: () => state, refresh, invalidate() { admissionEpoch++; invalidated = true; publish({ phase: 'uncertain' }); }, async acquire() { if (state.phase !== 'idle' || busy) return false; if (!await refresh() || state.phase !== 'idle') return false; return update('claim'); }, acquireAtRevision, reconcileClaimAtRevision, restore: async () => { if(state.phase!=='retained'||busy||state.pending||!state.claims.length)return false;return update('restore'); }, release: (keepalive = false) => update('release', keepalive), resolve: () => update('resolve'), canEdit, dispose() { active = false; } };
}
