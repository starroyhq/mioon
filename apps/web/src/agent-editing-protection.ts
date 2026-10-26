import type { AgentTaskClaim, AgentTaskEditingInput, AgentTaskTarget } from '../../../packages/contracts/src/agent-tasks-v2.ts';

export function agentEditingOwnerIdentity(workspaceScope: string, windowId: string, targets: readonly AgentTaskTarget[]): string { return `${workspaceScope}:${windowId}:${targets.map(target => `${target.kind}:${target.id}`).join(',')}`; }
export function agentEditingOwnerInWindow(ownerId: string, workspaceScope: string, windowId: string): boolean { return ownerId.startsWith(`${workspaceScope}:${windowId}:`); }

export interface AgentEditingObservation { claims: AgentTaskClaim[]; targets: AgentTaskTarget[]; timelineRevision?:number; receipt?: {requestId:string;projectId:string;ownerId:string;generation:number;sequence:number} }
export interface AgentEditingClient { read(projectId: string, ownerId?: string): Promise<AgentEditingObservation>; lookup?(projectId:string,ownerId:string,requestId:string):Promise<AgentEditingObservation>; update(input: AgentTaskEditingInput): Promise<AgentEditingObservation> }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function createAgentEditingClient({ fetchImpl = globalThis.fetch, timeoutMs = 12000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): AgentEditingClient {
  async function request(url: string, input?: AgentTaskEditingInput) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await Promise.race([fetchImpl(url, { method: input ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin', signal: controller.signal, ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) }), new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Editing protection unconfirmed')), { once: true }))]);
      const envelope: unknown = await response.json();
      if (!response.ok || !record(envelope) || envelope.ok !== true || !record(envelope.data) || !Array.isArray(envelope.data.claims)) throw Object.assign(new Error('Editing protection unconfirmed'),{definitive:response.status>=400&&response.status<500&&record(envelope)&&envelope.ok===false&&record(envelope.error)&&typeof envelope.error.code==='string'});
      const claims = envelope.data.claims, targets = envelope.data.targets ?? [];
      if (claims.some(claim => !record(claim) || typeof claim.id !== 'string' || typeof claim.projectId !== 'string' || typeof claim.ownerId !== 'string' || !record(claim.target) || typeof claim.target.kind !== 'string' || typeof claim.target.id !== 'string' || !Number.isSafeInteger(claim.target.revision) || !['active', 'uncertain'].includes(String(claim.state)))) throw new Error('Editing protection response invalid');
      if (!Array.isArray(targets) || targets.some(target => !record(target) || typeof target.kind !== 'string' || typeof target.id !== 'string' || !Number.isSafeInteger(target.revision))) throw new Error('Editing target revisions invalid');
      if(input && ['requestId','projectId','ownerId','generation','sequence'].some(key=>envelope.data instanceof Object && (envelope.data as Record<string,unknown>)[key]!==input[key as keyof AgentTaskEditingInput]))throw new Error('Editing acknowledgment identity mismatch');
      const receipt=record(envelope.data.receipt)?envelope.data.receipt:undefined;
      return { claims: claims as AgentTaskClaim[], targets: targets as AgentTaskTarget[], ...(typeof envelope.data.timelineRevision==='number'&&Number.isSafeInteger(envelope.data.timelineRevision)?{timelineRevision:envelope.data.timelineRevision}:{}), ...(receipt&&typeof receipt.requestId==='string'&&typeof receipt.projectId==='string'&&typeof receipt.ownerId==='string'&&typeof receipt.generation==='number'&&typeof receipt.sequence==='number'?{receipt:{requestId:receipt.requestId,projectId:receipt.projectId,ownerId:receipt.ownerId,generation:receipt.generation,sequence:receipt.sequence}}:{}) };
    } finally { clearTimeout(timeout); }
  }
  return { read: (projectId, ownerId) => request(`/api/agent/tasks/v2/editing?projectId=${encodeURIComponent(projectId)}${ownerId ? `&ownerId=${encodeURIComponent(ownerId)}` : ''}`), lookup:(projectId,ownerId,requestId)=>request(`/api/agent/tasks/v2/editing?projectId=${encodeURIComponent(projectId)}&ownerId=${encodeURIComponent(ownerId)}&requestId=${encodeURIComponent(requestId)}`), update: input => request('/api/agent/tasks/v2/editing', input) };
}
export interface AgentEditingState { phase: 'idle' | 'loading' | 'acquiring' | 'active' | 'releasing' | 'uncertain' | 'retained'; claims: AgentTaskClaim[]; pending: AgentTaskEditingInput | null; timelineRevision?:number; targets?:AgentTaskTarget[] }
export function createAgentEditingProtection({ projectId, ownerId, targets, generation = Date.now(), client = createAgentEditingClient(), requestId = () => crypto.randomUUID(), onChange = () => {} }: { projectId: string; ownerId: string; targets: readonly AgentTaskTarget[]; generation?: number; client?: AgentEditingClient; requestId?: () => string; onChange?: (state: AgentEditingState) => void }) {
  // Captured target IDs never follow a selection change. Disposal leaves the
  // durable claim intact, including when the window loses its connection.
  const pinned = targets.map(target => ({ ...target }));
  let state: AgentEditingState = { phase: 'idle', claims: [], pending: null }, active = true, busy = false, sequence = 0, admissionEpoch = 0, invalidated = false, hasObservation = false;
  const publish = (patch: Partial<AgentEditingState>) => { state = { ...state, ...patch }; if (active) onChange(state); };
  const owned = (claims: AgentTaskClaim[]) => claims.filter(claim => claim.projectId === projectId && claim.ownerId === ownerId);
  const matches = (claims: AgentTaskClaim[]) => pinned.every(target => claims.some(claim => claim.target.kind === target.kind && claim.target.id === target.id && claim.state === 'active'));
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
      for (const target of pinned) target.revision = observed.targets.find(value => value.kind === target.kind && value.id === target.id)?.revision ?? 0;
      if (state.pending) {
        const receiptMatches=!client.lookup||observed.receipt?.requestId===state.pending.requestId&&observed.receipt.ownerId===ownerId&&observed.receipt.projectId===projectId&&observed.receipt.generation===state.pending.generation&&observed.receipt.sequence===state.pending.sequence;
        const done = receiptMatches&&(['claim','restore'].includes(state.pending.action) ? matches(claims) : ['release', 'resolve'].includes(state.pending.action) && !claims.length);
        // A GET can prove a claim exists; absence cannot prove a delayed claim
        // POST will never arrive. Never turn an unknown acquire into idle.
        if (done) { const wasClaim = ['claim','restore'].includes(state.pending.action); publish({ phase: wasClaim ? invalidated ? 'retained' : 'active' : 'idle', claims, pending: null,timelineRevision:observed.timelineRevision,targets:observed.targets }); return true; }
        publish({ phase: 'uncertain', claims,timelineRevision:observed.timelineRevision,targets:observed.targets }); return false;
      }
      publish({ phase: wasActive&&!invalidated&&matches(claims)?'active':claims.length ? 'retained' : 'idle', claims,timelineRevision:observed.timelineRevision,targets:observed.targets }); return true;
    } catch { if (active && epoch === admissionEpoch) publish({ phase: 'uncertain' }); return false; } finally { busy = false; }
  }
  async function update(action: AgentTaskEditingInput['action']) {
    if (!active || busy || state.pending || action === 'claim' && state.phase !== 'idle') return false;
    const epoch=admissionEpoch, previousPhase=state.phase,input: AgentTaskEditingInput = { requestId: requestId(), action, projectId, ownerId, generation, sequence: ++sequence, targets: action==='restore'?state.claims.map(claim=>({...claim.target})):pinned.map(target=>({...target})) };
    busy = true; publish({ phase: ['claim','restore'].includes(action) ? 'acquiring' : 'releasing', pending: input });
    try { const claims = owned((await client.update(input)).claims); if (!active || epoch !== admissionEpoch) return false;
      if (['claim','restore'].includes(action) && !matches(claims) || ['release', 'resolve'].includes(action) && claims.length) throw new Error('Editing protection acknowledgment mismatch');
      invalidated = false; publish({ phase: ['claim','restore'].includes(action) ? 'active' : 'idle', pending: null, claims }); return true;
    } catch(error) {
      if(active&&epoch===admissionEpoch&&record(error)&&error.definitive===true&&client.lookup){
        try{const result=await client.lookup(projectId,ownerId,input.requestId);if(!active||epoch!==admissionEpoch)return false;if(!result.receipt){publish({phase:previousPhase,pending:null});busy=false;await refresh();return false;}busy=false;return await refresh();}catch{}
      }
      if (active && epoch === admissionEpoch) publish({ phase: 'uncertain' }); return false;
    } finally { busy = false; }
  }
  return { getState: () => state, refresh, invalidate() { admissionEpoch++; invalidated = true; publish({ phase: 'uncertain' }); }, async acquire() { if (state.phase !== 'idle' || busy) return false; if (!await refresh() || state.phase !== 'idle') return false; return update('claim'); }, restore: async () => { if(state.phase!=='retained'||busy||state.pending||!state.claims.length)return false;return update('restore'); }, release: () => update('release'), resolve: () => update('resolve'), canEdit: () => active && !invalidated && state.phase === 'active' && !state.pending, dispose() { active = false; } };
}
