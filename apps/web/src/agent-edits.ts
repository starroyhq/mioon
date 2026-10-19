import { message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { safeAgentTimelineProposal, safeAgentTimelineTarget, safeAgentTimelineGainProposal, safeAgentTimelineGainTarget, isAgentTimelineGainProposal, AGENT_TIMELINE_GAIN_CONTEXT, agentTimelineApprovalIssue, agentTimelineFrameText } from './agent-timeline-context.ts';
export { agentTimelineApprovalIssue, agentTimelineFrameText };
import { safeAgentEditTarget } from './agent-tool-state.ts';

export type AgentEditStatus = 'pending' | 'approved' | 'dispatching' | 'unknown' | 'applied' | 'failed' | 'rejected' | 'cancelled';
export type AgentEditRunStatus = 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';
export interface AgentEditTarget { projectId: string; shotId: string; expectedRevision: number; title: string; prompt: string }
export interface AgentEditApproval { requestId: string; approvedAt: string }
export interface AgentEditProposal {
  id: string;
  projectId: string;
  runId: string;
  digest: string;
  status: AgentEditStatus;
  runStatus: AgentEditRunStatus;
  operation: string;
  target: Record<string, unknown>;
  patch: Record<string, unknown>;
  diff: Record<string, unknown>;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  approval?: AgentEditApproval;
  outcome?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface AgentEditEnvelope { instanceId: string; projectId: string; proposal: AgentEditProposal }
export interface AgentEditPage { instanceId: string; projectId: string; proposals: AgentEditProposal[]; nextCursor: string | null }
export interface AgentEditsState {
  phase: 'loading' | 'ready' | 'error';
  instanceId: string | null;
  proposals: AgentEditProposal[];
  pinnedIds: string[];
  view: string;
  cursor: string | null;
  nextCursor: string | null;
  trail: (string | null)[];
  busy: string | null;
  uncertainIds: string[];
  retryApprovalIds: string[];
  message: string;
  displayMessage: DisplayMessage | null;
}
export interface AgentEditsClient {
  list: (projectId: string, options?: { cursor?: string | null; view?: string; signal?: AbortSignal }) => Promise<unknown>;
  get: (projectId: string, proposalId: string, signal?: AbortSignal) => Promise<unknown>;
  act: (projectId: string, proposalId: string, action: string, identity: { instanceId: string; digest: string }, signal?: AbortSignal) => Promise<unknown>;
}
export interface AgentEditsSessionOptions {
  projectId: string;
  client?: AgentEditsClient;
  onChange?: (state: AgentEditsState) => void;
  onApplied?: (projectId: string, proposal: AgentEditProposal) => void;
}
export interface AgentTimelineContextValue { target: unknown; blockedReason: string; contextMode: unknown }

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const failureCode = (error: unknown): string | undefined => record(error) && typeof error.code === 'string' ? error.code : undefined;
const isDefinitive = (error: unknown): boolean => record(error) && error.definitive === true;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const statuses: ReadonlySet<string> = new Set(['pending', 'approved', 'dispatching', 'unknown', 'applied', 'failed', 'rejected', 'cancelled']);
const runStatuses: ReadonlySet<string> = new Set(['running', 'completed', 'stopped', 'failed', 'interrupted']);
const notAppliedCodes: ReadonlySet<string> = new Set(['NOT_FOUND', 'REVISION_CONFLICT', 'INVALID_ORDER', 'ASSET_REQUIRED', 'INVALID_NODE_ASSET', 'REFERENCE_CONNECTED']);
const failure = (code: unknown, definitive = false): Error => Object.assign(new Error('Could not confirm the saved edit state.'), { code: typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'NETWORK', definitive });
const invalid: () => never = () => { throw failure('INVALID_RESPONSE'); };
const freeze = <T>(value: T): T => { for (const child of Object.values(value as Record<string, unknown>)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };
const text = (value: unknown, max: number): string => { if (typeof value !== 'string' || value.length > max) invalid(); return value; };
const time = (value: unknown): string => text(value, 50);
const knownStatus = (value: unknown): value is AgentEditStatus => typeof value === 'string' && statuses.has(value);
const knownRunStatus = (value: unknown): value is AgentEditRunStatus => typeof value === 'string' && runStatuses.has(value);
export const agentEditStatusText = (status: string): string => ({ pending: '已提议，尚未应用', approved: '已批准，尚未确认应用', dispatching: '正在应用，结果待确认', unknown: '应用结果未知', applied: '已确认应用', failed: '未应用', rejected: '已拒绝，未应用', cancelled: '提议已失效，未应用' } as Record<string, string>)[status] || '状态未知';
export const agentEditCanApprove = (proposal: AgentEditProposal | null | undefined): boolean => proposal?.status === 'pending' && proposal.runStatus === 'completed';
export const agentEditCanRecover = (proposal: AgentEditProposal | null | undefined): boolean => Boolean(proposal?.approval && ['approved', 'dispatching', 'unknown'].includes(proposal.status));
export const agentEditImmutableKey = (proposal: AgentEditProposal): string => JSON.stringify([proposal.id, proposal.projectId, proposal.runId, proposal.digest, proposal.operation, proposal.target, proposal.patch, proposal.diff, proposal.provenance]);

// The model's response text is never evidence of approval or application.
export function safeAgentEditProposal(value: unknown, projectId: string): AgentEditProposal {
  if (isAgentTimelineGainProposal(value, { projectId })) return safeAgentTimelineGainProposal(value, projectId) as AgentEditProposal;
  if (record(value) && value.operation === 'timeline.clip.update') return safeAgentTimelineProposal(value, projectId) as AgentEditProposal;
  if (!record(value) || !uuid(value.id) || value.projectId !== projectId || !uuid(value.runId) || !hash(value.digest) || !knownStatus(value.status) || !knownRunStatus(value.runStatus) || value.operation !== 'shot.update') invalid();
  const diff = record(value.diff) ? value.diff : null, before = diff && record(diff.before) ? diff.before : undefined, after = diff && record(diff.after) ? diff.after : undefined;
  const targetInput = { ...(record(value.target) ? value.target : {}), ...before };
  const target = safeAgentEditTarget(targetInput, projectId) as AgentEditTarget, changed = safeAgentEditTarget({ ...(record(value.target) ? value.target : {}), ...after }, projectId) as AgentEditTarget;
  const targetRecord = target as unknown as Record<string, unknown>, changedRecord = changed as unknown as Record<string, unknown>;
  const patch = record(value.patch) ? value.patch : null;
  if (!patch || !Object.keys(patch).length || Object.keys(patch).some(key => !['title', 'prompt'].includes(key)) ||
      ['title', 'prompt'].some(field => (Object.hasOwn(patch, field) ? patch[field] : targetRecord[field]) !== changedRecord[field]) || ['title', 'prompt'].every(field => targetRecord[field] === changedRecord[field])) invalid();
  const provenance = record(value.provenance) ? value.provenance : null;
  if (!provenance || provenance.runId !== value.runId || provenance.toolName !== 'mioon_propose_shot_update' || typeof provenance.toolCallId !== 'string' || !provenance.toolCallId || provenance.toolCallId.length > 500) invalid();
  const result: AgentEditProposal = { id: value.id, projectId, runId: value.runId, digest: value.digest, status: value.status, runStatus: value.runStatus, operation: 'shot.update',
    target: { projectId, shotId: target.shotId, expectedRevision: target.expectedRevision }, patch: Object.fromEntries(['title', 'prompt'].filter(field => Object.hasOwn(patch, field)).map(field => [field, patch[field]])),
    diff: { before: { title: target.title, prompt: target.prompt }, after: { title: changed.title, prompt: changed.prompt } },
    provenance: { runId: value.runId, toolCallId: provenance.toolCallId, toolName: provenance.toolName }, createdAt: time(value.createdAt), updatedAt: time(value.updatedAt) };
  if (value.approval !== undefined) {
    const approval = record(value.approval) ? value.approval : null;
    if (!approval || !uuid(approval.requestId)) invalid();
    result.approval = { requestId: approval.requestId, approvedAt: time(approval.approvedAt) };
  }
  if (value.outcome !== undefined) {
    const outcome = record(value.outcome) ? value.outcome : null;
    if (outcome?.status === 'applied' && outcome.shotId === target.shotId && integer(outcome.revision) && outcome.revision === target.expectedRevision + 1) result.outcome = { status: 'applied', shotId: target.shotId, revision: outcome.revision };
    else if (outcome?.status === 'not_applied' && typeof outcome.code === 'string' && notAppliedCodes.has(outcome.code)) result.outcome = { status: 'not_applied', code: outcome.code };
    else invalid();
  }
  const unapproved = ['pending', 'rejected', 'cancelled'].includes(result.status), terminal = ['applied', 'failed'].includes(result.status);
  if (unapproved !== !result.approval || terminal !== Boolean(result.outcome) || result.status === 'applied' && result.outcome?.status !== 'applied' || result.status === 'failed' && result.outcome?.status !== 'not_applied') invalid();
  return freeze(result);
}
const identity = (value: unknown, projectId: string): void => { if (!record(value) || !uuid(value.instanceId) || value.projectId !== projectId) invalid(); };
export function safeAgentEditEnvelope(value: unknown, projectId: string, proposalId?: string): AgentEditEnvelope {
  identity(value, projectId);
  const envelopeValue = value as unknown as { instanceId: string; proposal: unknown };
  const proposal = safeAgentEditProposal(envelopeValue.proposal, projectId);
  if (proposalId && proposal.id !== proposalId) invalid();
  return { instanceId: envelopeValue.instanceId, projectId, proposal };
}
export function safeAgentEditPage(value: unknown, projectId: string): AgentEditPage {
  identity(value, projectId);
  const pageValue = value as unknown as { instanceId: string; proposals: unknown; nextCursor: unknown };
  const proposalValues = pageValue.proposals;
  if (!Array.isArray(proposalValues) || proposalValues.length > 50 || pageValue.nextCursor !== null && (typeof pageValue.nextCursor !== 'string' || !pageValue.nextCursor || pageValue.nextCursor.length > 2048)) invalid();
  const proposals = (proposalValues as unknown[]).map(item => safeAgentEditProposal(item, projectId));
  if (new Set(proposals.map(item => item.id)).size !== proposals.length) invalid();
  return { instanceId: pageValue.instanceId, projectId, proposals, nextCursor: pageValue.nextCursor as string | null };
}
export const AGENT_EDIT_RESPONSE_BYTES = 4 * 1024 * 1024;
// Limit transport allocation before parsing or projecting a bounded DTO page.
// A Content-Length header can fail early but never replaces streaming accounting.
export async function readAgentEditJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function' || typeof response.headers?.get !== 'function') invalid();
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }), pieces: string[] = [];
  let total = 0, finished = false;
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > AGENT_EDIT_RESPONSE_BYTES)) invalid();
    while (true) {
      if (signal?.aborted) throw failure('NETWORK');
      const chunk = await reader.read();
      if (signal?.aborted) throw failure('NETWORK');
      if (chunk.done) { pieces.push(decoder.decode()); finished = true; break; }
      if (!(chunk.value instanceof Uint8Array)) invalid();
      total += chunk.value.byteLength;
      if (total > AGENT_EDIT_RESPONSE_BYTES) invalid();
      const decoded = decoder.decode(chunk.value, { stream: true }); if (decoded) pieces.push(decoded);
    }
    return JSON.parse(pieces.join(''));
  } catch (error) {
    if (signal?.aborted) throw failure('NETWORK');
    throw failure('INVALID_RESPONSE');
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!finished) { try { await reader.cancel(); } catch {} }
    reader.releaseLock();
  }
}
export function createAgentEditsClient({ fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init), timeoutMs = 12000 }: { fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; timeoutMs?: number } = {}): AgentEditsClient {
  const path = (projectId: string): string => `/api/agent/chat/${encodeURIComponent(projectId)}/edits`;
  async function json(url: string, method: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const abort = new AbortController(); const cancel = (): void => abort.abort(); let timer: ReturnType<typeof setTimeout> | undefined, rejectOnAbort: (() => void) | undefined;
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    try {
      const work = (async () => {
        const response = await fetchImpl(url, { method, credentials: 'same-origin', cache: 'no-store', signal: abort.signal, ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) });
        const body = await readAgentEditJson(response, abort.signal);
        const bodyRecord = record(body) ? body : {}, errorRecord = record(bodyRecord.error) ? bodyRecord.error : {}, code = typeof errorRecord.code === 'string' ? errorRecord.code : undefined;
        if (!response.ok || bodyRecord.ok !== true) throw failure(response.status === 401 ? 'UNAUTHORIZED' : code, response.status >= 400 && response.status < 500 && typeof code === 'string');
        return bodyRecord.data;
      })();
      return await Promise.race([work, new Promise<never>((_, reject) => {
        if (timeoutMs > 0) timer = setTimeout(() => { abort.abort(); reject(failure('NETWORK')); }, timeoutMs);
        rejectOnAbort = () => reject(failure('NETWORK')); abort.signal.addEventListener('abort', rejectOnAbort, { once: true }); if (abort.signal.aborted) rejectOnAbort();
      })]);
    } catch (error) { throw failure(failureCode(error), isDefinitive(error)); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (rejectOnAbort) abort.signal.removeEventListener('abort', rejectOnAbort); }
  }
  return {
    async list(projectId: string, { cursor = null, view = 'unresolved', signal }: { cursor?: string | null; view?: string; signal?: AbortSignal } = {}): Promise<AgentEditPage> {
      if (!['unresolved', 'all'].includes(view)) invalid();
      const query = new URLSearchParams({ limit: '20', view }); if (cursor) query.set('cursor', cursor);
      return safeAgentEditPage(await json(`${path(projectId)}?${query}`, 'GET', null, signal), projectId);
    },
    async get(projectId: string, proposalId: string, signal?: AbortSignal): Promise<AgentEditEnvelope> { return safeAgentEditEnvelope(await json(`${path(projectId)}/${encodeURIComponent(proposalId)}`, 'GET', null, signal), projectId, proposalId); },
    async act(projectId: string, proposalId: string, action: string, { instanceId, digest }: { instanceId: string; digest: string }, signal?: AbortSignal): Promise<AgentEditEnvelope> {
      if (!['approve', 'reject', 'recover'].includes(action) || !uuid(instanceId) || !hash(digest)) invalid();
      return safeAgentEditEnvelope(await json(`${path(projectId)}/${encodeURIComponent(proposalId)}/${action}`, 'POST', { instanceId, digest }, signal), projectId, proposalId);
    },
  };
}
export const initialAgentEditsState = (): AgentEditsState => ({ phase: 'loading', instanceId: null, proposals: [], pinnedIds: [], view: 'unresolved', cursor: null, nextCursor: null, trail: [], busy: null, uncertainIds: [], retryApprovalIds: [], message: '', displayMessage: null });

// Durable edit identities live on the server. Recreating this controller performs
// GETs only; it never reads sessionStorage, fabricates keys or replays approvals.
export function createAgentEditsSession({ projectId, client = createAgentEditsClient(), onChange = () => {}, onApplied = () => {} }: AgentEditsSessionOptions) {
  let active = true, visible = true, serial = 0, state = initialAgentEditsState(), timelineContext: AgentTimelineContextValue | null = null;
  const reads = new Set<AbortController>(), notified = new Set<string>(), retryProofs = new Map<string, { proposal: AgentEditProposal; instanceId: string; serial: number }>();
  let pageRows: AgentEditProposal[] = [], pins = new Map<string, AgentEditProposal>();
  const terminal = (proposal: AgentEditProposal): boolean => ['applied', 'failed', 'rejected', 'cancelled'].includes(proposal.status);
  const projection = (): { proposals: AgentEditProposal[]; pinnedIds: string[] } => ({ proposals: [...pageRows, ...[...pins.values()].filter(item => !pageRows.some(row => row.id === item.id))], pinnedIds: [...pins.values()].filter(item => !terminal(item)).map(item => item.id) });
  const pinCapacityMessage = '已有 50 份原操作待核对。请先只读核对或恢复下方保留的原提议，再批准新的提议；原身份与请求不会被丢弃。';
  const pinCapacityDescriptor = localizedMessage('agent.proposal.state.pinCapacity');
  const publish = (patch: Partial<AgentEditsState>): void => { if (active) { state = { ...state, ...patch }; onChange(state); } };
  const valid = (epoch: number): boolean => active && epoch === serial;
  const read = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => { const controller = new AbortController(); reads.add(controller); try { return await work(controller.signal); } finally { reads.delete(controller); } };
  const compatible = (previous: AgentEditProposal | undefined, next: AgentEditProposal): void => {
    if (!previous) return;
    const progress: Record<AgentEditStatus, number> = { pending: 0, approved: 1, dispatching: 2, unknown: 3, applied: 4, failed: 4, rejected: 4, cancelled: 4 };
    if (progress[next.status] < progress[previous.status] && !(previous.status === 'unknown' && next.status === 'dispatching') || previous.runStatus !== 'running' && previous.runStatus !== next.runStatus) invalid();
    if (agentEditImmutableKey(previous) !== agentEditImmutableKey(next) || previous.approval && JSON.stringify(previous.approval) !== JSON.stringify(next.approval) || previous.outcome && JSON.stringify(previous.outcome) !== JSON.stringify(next.outcome) || ['applied', 'failed', 'rejected', 'cancelled'].includes(previous.status) && previous.status !== next.status) invalid();
  };
  const preserveUnknown = (previous: AgentEditProposal | undefined, next: AgentEditProposal): AgentEditProposal => previous?.status === 'unknown' && next.status === 'dispatching' ? freeze({ ...next, status: 'unknown' }) : next;
  const merge = (envelope: AgentEditEnvelope): AgentEditProposal => {
    const previous = state.proposals.find(item => item.id === envelope.proposal.id);
    compatible(previous, envelope.proposal);
    const proposal = preserveUnknown(previous, envelope.proposal);
    const onPage = pageRows.some(item => item.id === proposal.id);
    if (onPage) pageRows = pageRows.map(item => item.id === proposal.id ? proposal : item);
    if (pins.has(proposal.id) || !onPage) {
      if (!pins.has(proposal.id) && pins.size >= 50) throw failure('LOCAL_PIN_LIMIT');
      if (terminal(proposal) && onPage) pins.delete(proposal.id); else pins.set(proposal.id, proposal);
    }
    publish({ instanceId: envelope.instanceId, ...projection(), uncertainIds: proposal.status === 'pending' ? state.uncertainIds : state.uncertainIds.filter(id => id !== proposal.id) });
    return proposal;
  };
  const confirmApplied = (proposal: AgentEditProposal): void => {
    if (active && proposal.status === 'applied' && proposal.outcome?.status === 'applied' && !notified.has(proposal.id)) { notified.add(proposal.id); onApplied(projectId, proposal); }
  };
  async function load({ view = state.view, cursor = state.cursor, trail = state.trail }: { view?: string; cursor?: string | null; trail?: (string | null)[] } = {}): Promise<boolean> {
    if (!active || !visible || state.busy) return false;
    const samePage = view === state.view && cursor === state.cursor;
    const epoch = ++serial; retryProofs.clear(); publish({ phase: 'loading', retryApprovalIds: [], message: '', displayMessage: null });
    try {
      const page = safeAgentEditPage(await read(signal => client.list(projectId, { view, cursor, signal })), projectId);
      if (!valid(epoch)) return false;
      const nextPins = new Map([...pins].filter(([, item]) => !terminal(item)));
      page.proposals = page.proposals.map(item => {
        const previous = state.proposals.find(saved => saved.id === item.id); compatible(previous, item);
        const next = preserveUnknown(previous, item);
        if (nextPins.has(item.id)) { if (terminal(next)) nextPins.delete(item.id); else nextPins.set(item.id, next); }
        if (state.uncertainIds.includes(item.id) || previous && agentEditCanRecover(previous)) confirmApplied(next);
        return next;
      });
      // Only the same page's disappearance is reconciled. Older/newer/view
      // navigation never pins ordinary saved unknown records from prior pages.
      // Separate local pins retain an exact unresolved action even off-page.
      const missing = new Map([...nextPins].filter(([id]) => !page.proposals.some(item => item.id === id)));
      if (samePage) for (const item of pageRows) if (agentEditCanRecover(item) && !page.proposals.some(next => next.id === item.id)) missing.set(item.id, item);
      const confirmed = [...page.proposals];
      for (const previous of missing.values()) {
        let next = previous;
        try {
          const detail = safeAgentEditEnvelope(await read(signal => client.get(projectId, previous.id, signal)), projectId, previous.id);
          if (!valid(epoch)) return false;
          if (detail.instanceId !== page.instanceId) invalid();
          compatible(previous, detail.proposal); next = preserveUnknown(previous, detail.proposal); confirmApplied(next);
        } catch { /* Missing or failed reads cannot release an original intent. */ }
        if (!valid(epoch)) return false;
        if (!nextPins.has(previous.id) && nextPins.size >= 50) throw failure('LOCAL_PIN_LIMIT');
        nextPins.set(previous.id, next); confirmed.push(next);
      }
      if (!valid(epoch)) return false;
      // <=50 fetched rows plus <=50 independent pins: no fetched identity is
      // truncated, and no unresolved local action is silently dropped.
      pageRows = page.proposals; pins = nextPins;
      publish({ ...page, ...projection(), view, cursor, trail, phase: 'ready', uncertainIds: state.uncertainIds.filter(id => !confirmed.some(item => item.id === id && item.status !== 'pending')) });
      return true;
    } catch (error) { const code = failureCode(error); if (valid(epoch)) publish({ phase: 'error', message: code === 'LOCAL_PIN_LIMIT' ? pinCapacityMessage : '暂时无法读取修改提议。已有差异保留；重新读取不会批准或应用修改。', displayMessage: code === 'LOCAL_PIN_LIMIT' ? pinCapacityDescriptor : localizedMessage('agent.proposal.state.loadUnavailable') }); return false; }
  }
  async function inspect(proposalId: string): Promise<boolean> {
    if (!active || !visible || state.busy) return false;
    const epoch = ++serial; retryProofs.clear(); publish({ phase: 'loading', retryApprovalIds: [], message: '', displayMessage: null });
    try {
      const result = safeAgentEditEnvelope(await read(signal => client.get(projectId, proposalId, signal)), projectId, proposalId);
      if (!valid(epoch)) return false;
      const proposal = merge(result); confirmApplied(proposal);
      if (proposal.status === 'pending' && proposal.runStatus === 'completed' && state.uncertainIds.includes(proposalId)) {
        retryProofs.set(proposalId, { proposal, instanceId: result.instanceId, serial: epoch });
        publish({ retryApprovalIds: [proposalId] });
      }
      publish({ phase: 'ready', message: proposal.status === 'pending' && state.uncertainIds.includes(proposalId) ? '尚未确认原操作是否被接受。刚刚读取的提议仍待批准，不能据此认定先前请求未被接受；可继续只读核对，或明确重试同一份已保存提议的批准请求。' : '', displayMessage: proposal.status === 'pending' && state.uncertainIds.includes(proposalId) ? localizedMessage('agent.proposal.state.originalAcceptanceUnknown') : null }); return true;
    } catch { if (valid(epoch)) publish({ phase: 'error', message: '未能核对原提议。结果仍待确认，没有重新提交。', displayMessage: localizedMessage('agent.proposal.state.inspectFailed') }); return false; }
  }
  async function act(action: string, expected: AgentEditProposal | null | undefined): Promise<boolean> {
    if (!active || !visible || state.phase !== 'ready' || state.busy || !state.instanceId || !expected) return false;
    const proposal = state.proposals.find(item => item.id === expected.id), retry = action === 'retry_approval', proof = retryProofs.get(expected.id);
    if (!proposal || proposal !== expected || !['approve', 'reject', 'recover', 'retry_approval'].includes(action) ||
        state.uncertainIds.includes(proposal.id) && !['recover', 'retry_approval'].includes(action) ||
        (action === 'recover' ? !agentEditCanRecover(proposal) : !agentEditCanApprove(proposal)) ||
        ['approve', 'retry_approval'].includes(action) && Boolean(agentTimelineApprovalIssue(proposal, timelineContext || {})) ||
        retry && (!state.uncertainIds.includes(proposal.id) || !proof || proof.proposal !== proposal || proof.instanceId !== state.instanceId || proof.serial !== serial)) return false;
    for (const [id, item] of pins) if (terminal(item)) pins.delete(id);
    if (!pins.has(proposal.id) && pins.size >= 50) { publish({ ...projection(), message: pinCapacityMessage, displayMessage: pinCapacityDescriptor }); return false; }
    pins.set(proposal.id, proposal);
    const epoch = ++serial, instanceId = state.instanceId; retryProofs.clear();
    publish({ ...projection(), busy: proposal.id, retryApprovalIds: [], message: '', displayMessage: null, ...(['approve', 'retry_approval'].includes(action) ? { uncertainIds: [...new Set([...state.uncertainIds, proposal.id])] } : {}) });
    try {
      const result = safeAgentEditEnvelope(await read(signal => client.act(projectId, proposal.id, retry ? 'approve' : action, { instanceId, digest: proposal.digest }, signal)), projectId, proposal.id);
      if (!valid(epoch)) return false;
      // A stale epoch acknowledgement cannot silently authorize a new service.
      if (result.instanceId !== instanceId) invalid();
      const updated = merge(result); confirmApplied(updated);
      publish({ busy: null, phase: 'ready', message: updated.status === 'applied' ? '已确认应用此份不可修改的提议。当前保存内容将单独读取，属性面板中未保存的输入仍保留。' : '', displayMessage: updated.status === 'applied' ? localizedMessage('agent.proposal.state.appliedConfirmed') : null }); return true;
    } catch (error) {
      if (!valid(epoch)) return false;
      publish({ busy: null, phase: 'ready', uncertainIds: [...new Set([...state.uncertainIds, proposal.id])], message: isDefinitive(error) ? '本次操作被保存服务阻止，不能据此判断较早操作的结果。正在只读核对原提议；不会自动重试。' : '没有收到操作确认。这不代表已拒绝或未应用；正在只读核对原提议，不会自动重试。', displayMessage: isDefinitive(error) ? localizedMessage('agent.proposal.state.operationBlocked') : localizedMessage('agent.proposal.state.acknowledgementMissing') });
      if (visible) await inspect(proposal.id);
      return false;
    }
  }
  return { getState: (): AgentEditsState => state, load, inspect, act,
    setTimelineContext({ target, blockedReason = '', contextMode }: { target?: unknown; blockedReason?: unknown; contextMode?: unknown } = {}): void {
      let next: unknown = null; try { if (target) next = contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? safeAgentTimelineGainTarget(target, projectId) : safeAgentTimelineTarget(target, projectId); } catch { /* Malformed or stale selection never approves. */ }
      timelineContext = { target: next, blockedReason: typeof blockedReason === 'string' ? blockedReason : '请先核对当前时间线状态。', contextMode };
    },
    chooseView(view: string): Promise<boolean> | false { if (!active || !visible || state.busy || !['unresolved', 'all'].includes(view)) return false; return load({ view, cursor: null, trail: [] }); },
    older(): Promise<boolean> | false { return state.nextCursor && !state.trail.includes(state.nextCursor) ? load({ cursor: state.nextCursor, trail: [...state.trail, state.cursor].slice(-64) }) : false; },
    newer(): Promise<boolean> | false { return state.trail.length ? load({ cursor: state.trail.at(-1), trail: state.trail.slice(0, -1) }) : false; },
    setVisible(value: boolean): void { if (!active || visible === Boolean(value)) return; visible = Boolean(value); if (!visible) { retryProofs.clear(); publish({ retryApprovalIds: [] }); } if (!visible && !state.busy) { serial++; for (const item of reads) item.abort(); if (state.phase === 'loading') publish({ phase: state.instanceId ? 'ready' : 'loading' }); } else if (visible && !state.busy) void load(); },
    dispose(): void { active = false; serial++; for (const item of reads) item.abort(); reads.clear(); },
  };
}

// Display-only companions keep legacy diagnostics and business identities unchanged.
export const agentEditStatusDescriptor = (status: string): DisplayMessage => ({ __proto__: null, pending: localizedMessage('agent.proposal.state.pending'), approved: localizedMessage('agent.proposal.state.approved'), dispatching: localizedMessage('agent.proposal.state.dispatching'), unknown: localizedMessage('agent.proposal.state.unknown'), applied: localizedMessage('agent.proposal.state.applied'), failed: localizedMessage('agent.proposal.state.failed'), rejected: localizedMessage('agent.proposal.state.rejected'), cancelled: localizedMessage('agent.proposal.state.cancelled') } as unknown as Record<string, DisplayMessage>)[status] || localizedMessage('agent.proposal.state.statusUnknown');
