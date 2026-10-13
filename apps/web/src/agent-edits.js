import { safeAgentTimelineProposal, safeAgentTimelineTarget, safeAgentTimelineGainProposal, safeAgentTimelineGainTarget, isAgentTimelineGainProposal, AGENT_TIMELINE_GAIN_CONTEXT, agentTimelineApprovalIssue, agentTimelineFrameText } from './agent-timeline-context.js';
export { agentTimelineApprovalIssue, agentTimelineFrameText };
import { safeAgentEditTarget } from './agent-tool-state.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const notAppliedCodes = new Set(['NOT_FOUND', 'REVISION_CONFLICT', 'INVALID_ORDER', 'ASSET_REQUIRED', 'INVALID_NODE_ASSET', 'REFERENCE_CONNECTED']);
const statuses = new Set(['pending', 'approved', 'dispatching', 'unknown', 'applied', 'failed', 'rejected', 'cancelled']);
const runStatuses = new Set(['running', 'completed', 'stopped', 'failed', 'interrupted']);
const failure = (code, definitive = false) => Object.assign(new Error('Could not confirm the saved edit state.'), { code: typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'NETWORK', definitive });
const invalid = () => { throw failure('INVALID_RESPONSE'); };
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };
const text = (value, max) => { if (typeof value !== 'string' || value.length > max) invalid(); return value; };
const time = value => text(value, 50);
export const agentEditStatusText = status => ({ pending: '已提议，尚未应用', approved: '已批准，尚未确认应用', dispatching: '正在应用，结果待确认', unknown: '应用结果未知', applied: '已确认应用', failed: '未应用', rejected: '已拒绝，未应用', cancelled: '提议已失效，未应用' }[status] || '状态未知');
export const agentEditCanApprove = proposal => proposal?.status === 'pending' && proposal.runStatus === 'completed';
export const agentEditCanRecover = proposal => Boolean(proposal?.approval && ['approved', 'dispatching', 'unknown'].includes(proposal.status));
export const agentEditImmutableKey = proposal => JSON.stringify([proposal.id, proposal.projectId, proposal.runId, proposal.digest, proposal.operation, proposal.target, proposal.patch, proposal.diff, proposal.provenance]);

// The model's response text is never evidence of approval or application.
export function safeAgentEditProposal(value, projectId) {
  if (isAgentTimelineGainProposal(value, { projectId })) return safeAgentTimelineGainProposal(value, projectId);
  if (value?.operation === 'timeline.clip.update') return safeAgentTimelineProposal(value, projectId);
  if (!value || !uuid(value.id) || value.projectId !== projectId || !uuid(value.runId) || !hash(value.digest) || !statuses.has(value.status) || !runStatuses.has(value.runStatus) || value.operation !== 'shot.update') invalid();
  const before = value.diff?.before, after = value.diff?.after;
  const target = safeAgentEditTarget({ ...value.target, ...before }, projectId);
  const changed = safeAgentEditTarget({ ...value.target, ...after }, projectId);
  const patch = value.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['title', 'prompt'].includes(key)) ||
      ['title', 'prompt'].some(field => (Object.hasOwn(patch, field) ? patch[field] : target[field]) !== changed[field]) || ['title', 'prompt'].every(field => target[field] === changed[field])) invalid();
  const provenance = value.provenance;
  if (!provenance || provenance.runId !== value.runId || provenance.toolName !== 'mioon_propose_shot_update' || typeof provenance.toolCallId !== 'string' || !provenance.toolCallId || provenance.toolCallId.length > 500) invalid();
  const result = { id: value.id, projectId, runId: value.runId, digest: value.digest, status: value.status, runStatus: value.runStatus, operation: 'shot.update',
    target: { projectId, shotId: target.shotId, expectedRevision: target.expectedRevision }, patch: Object.fromEntries(['title', 'prompt'].filter(field => Object.hasOwn(patch, field)).map(field => [field, patch[field]])),
    diff: { before: { title: target.title, prompt: target.prompt }, after: { title: changed.title, prompt: changed.prompt } },
    provenance: { runId: value.runId, toolCallId: provenance.toolCallId, toolName: provenance.toolName }, createdAt: time(value.createdAt), updatedAt: time(value.updatedAt) };
  if (value.approval !== undefined) {
    if (!value.approval || !uuid(value.approval.requestId)) invalid();
    result.approval = { requestId: value.approval.requestId, approvedAt: time(value.approval.approvedAt) };
  }
  if (value.outcome !== undefined) {
    if (value.outcome?.status === 'applied' && value.outcome.shotId === target.shotId && integer(value.outcome.revision) && value.outcome.revision === target.expectedRevision + 1) result.outcome = { status: 'applied', shotId: target.shotId, revision: value.outcome.revision };
    else if (value.outcome?.status === 'not_applied' && notAppliedCodes.has(value.outcome.code)) result.outcome = { status: 'not_applied', code: value.outcome.code };
    else invalid();
  }
  const unapproved = ['pending', 'rejected', 'cancelled'].includes(result.status), terminal = ['applied', 'failed'].includes(result.status);
  if (unapproved !== !result.approval || terminal !== Boolean(result.outcome) || result.status === 'applied' && result.outcome?.status !== 'applied' || result.status === 'failed' && result.outcome?.status !== 'not_applied') invalid();
  return freeze(result);
}
const identity = (value, projectId) => { if (!value || !uuid(value.instanceId) || value.projectId !== projectId) invalid(); };
export function safeAgentEditEnvelope(value, projectId, proposalId) {
  identity(value, projectId);
  const proposal = safeAgentEditProposal(value.proposal, projectId);
  if (proposalId && proposal.id !== proposalId) invalid();
  return { instanceId: value.instanceId, projectId, proposal };
}
export function safeAgentEditPage(value, projectId) {
  identity(value, projectId);
  if (!Array.isArray(value.proposals) || value.proposals.length > 50 || value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > 2048)) invalid();
  const proposals = value.proposals.map(item => safeAgentEditProposal(item, projectId));
  if (new Set(proposals.map(item => item.id)).size !== proposals.length) invalid();
  return { instanceId: value.instanceId, projectId, proposals, nextCursor: value.nextCursor };
}
export const AGENT_EDIT_RESPONSE_BYTES = 4 * 1024 * 1024;
// Limit transport allocation before parsing or projecting a bounded DTO page.
// A Content-Length header can fail early but never replaces streaming accounting.
export async function readAgentEditJson(response, signal) {
  if (!response?.body?.getReader || typeof response.headers?.get !== 'function') invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }), pieces = [];
  let total = 0, finished = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
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
export function createAgentEditsClient({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 12000 } = {}) {
  const path = projectId => `/api/agent/chat/${encodeURIComponent(projectId)}/edits`;
  async function json(url, method, input, signal) {
    const abort = new AbortController(); const cancel = () => abort.abort(); let timer, rejectOnAbort;
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    try {
      const work = (async () => {
        const response = await fetchImpl(url, { method, credentials: 'same-origin', cache: 'no-store', signal: abort.signal, ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) });
        const body = await readAgentEditJson(response, abort.signal);
        if (!response.ok || body?.ok !== true) throw failure(response.status === 401 ? 'UNAUTHORIZED' : body?.error?.code, response.status >= 400 && response.status < 500 && typeof body?.error?.code === 'string');
        return body.data;
      })();
      return await Promise.race([work, new Promise((_, reject) => {
        if (timeoutMs > 0) timer = setTimeout(() => { abort.abort(); reject(failure('NETWORK')); }, timeoutMs);
        rejectOnAbort = () => reject(failure('NETWORK')); abort.signal.addEventListener('abort', rejectOnAbort, { once: true }); if (abort.signal.aborted) rejectOnAbort();
      })]);
    } catch (error) { throw failure(error?.code, error?.definitive === true); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (rejectOnAbort) abort.signal.removeEventListener('abort', rejectOnAbort); }
  }
  return {
    async list(projectId, { cursor = null, view = 'unresolved', signal } = {}) {
      if (!['unresolved', 'all'].includes(view)) invalid();
      const query = new URLSearchParams({ limit: '20', view }); if (cursor) query.set('cursor', cursor);
      return safeAgentEditPage(await json(`${path(projectId)}?${query}`, 'GET', null, signal), projectId);
    },
    async get(projectId, proposalId, signal) { return safeAgentEditEnvelope(await json(`${path(projectId)}/${encodeURIComponent(proposalId)}`, 'GET', null, signal), projectId, proposalId); },
    async act(projectId, proposalId, action, { instanceId, digest }, signal) {
      if (!['approve', 'reject', 'recover'].includes(action) || !uuid(instanceId) || !hash(digest)) invalid();
      return safeAgentEditEnvelope(await json(`${path(projectId)}/${encodeURIComponent(proposalId)}/${action}`, 'POST', { instanceId, digest }, signal), projectId, proposalId);
    },
  };
}
export const initialAgentEditsState = () => ({ phase: 'loading', instanceId: null, proposals: [], pinnedIds: [], view: 'unresolved', cursor: null, nextCursor: null, trail: [], busy: null, uncertainIds: [], retryApprovalIds: [], message: '' });

// Durable edit identities live on the server. Recreating this controller performs
// GETs only; it never reads sessionStorage, fabricates keys or replays approvals.
export function createAgentEditsSession({ projectId, client = createAgentEditsClient(), onChange = () => {}, onApplied = () => {} } = {}) {
  let active = true, visible = true, serial = 0, state = initialAgentEditsState(), timelineContext = null;
  const reads = new Set(), notified = new Set(), retryProofs = new Map();
  let pageRows = [], pins = new Map();
  const terminal = proposal => ['applied', 'failed', 'rejected', 'cancelled'].includes(proposal.status);
  const projection = () => ({ proposals: [...pageRows, ...[...pins.values()].filter(item => !pageRows.some(row => row.id === item.id))], pinnedIds: [...pins.values()].filter(item => !terminal(item)).map(item => item.id) });
  const pinCapacityMessage = '已有 50 份原操作待核对。请先只读核对或恢复下方保留的原提议，再批准新的提议；原身份与请求不会被丢弃。';
  const publish = patch => { if (active) { state = { ...state, ...patch }; onChange(state); } };
  const valid = epoch => active && epoch === serial;
  const read = async work => { const controller = new AbortController(); reads.add(controller); try { return await work(controller.signal); } finally { reads.delete(controller); } };
  const compatible = (previous, next) => {
    if (!previous) return;
    const progress = { pending: 0, approved: 1, dispatching: 2, unknown: 3, applied: 4, failed: 4, rejected: 4, cancelled: 4 };
    if (progress[next.status] < progress[previous.status] && !(previous.status === 'unknown' && next.status === 'dispatching') || previous.runStatus !== 'running' && previous.runStatus !== next.runStatus) invalid();
    if (agentEditImmutableKey(previous) !== agentEditImmutableKey(next) || previous.approval && JSON.stringify(previous.approval) !== JSON.stringify(next.approval) || previous.outcome && JSON.stringify(previous.outcome) !== JSON.stringify(next.outcome) || ['applied', 'failed', 'rejected', 'cancelled'].includes(previous.status) && previous.status !== next.status) invalid();
  };
  const preserveUnknown = (previous, next) => previous?.status === 'unknown' && next.status === 'dispatching' ? freeze({ ...next, status: 'unknown' }) : next;
  const merge = envelope => {
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
  const confirmApplied = proposal => {
    if (active && proposal.status === 'applied' && proposal.outcome?.status === 'applied' && !notified.has(proposal.id)) { notified.add(proposal.id); onApplied(projectId, proposal); }
  };
  async function load({ view = state.view, cursor = state.cursor, trail = state.trail } = {}) {
    if (!active || !visible || state.busy) return false;
    const samePage = view === state.view && cursor === state.cursor;
    const epoch = ++serial; retryProofs.clear(); publish({ phase: 'loading', retryApprovalIds: [], message: '' });
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
    } catch (error) { if (valid(epoch)) publish({ phase: 'error', message: error.code === 'LOCAL_PIN_LIMIT' ? pinCapacityMessage : '暂时无法读取修改提议。已有差异保留；重新读取不会批准或应用修改。' }); return false; }
  }
  async function inspect(proposalId) {
    if (!active || !visible || state.busy) return false;
    const epoch = ++serial; retryProofs.clear(); publish({ phase: 'loading', retryApprovalIds: [], message: '' });
    try {
      const result = safeAgentEditEnvelope(await read(signal => client.get(projectId, proposalId, signal)), projectId, proposalId);
      if (!valid(epoch)) return false;
      const proposal = merge(result); confirmApplied(proposal);
      if (proposal.status === 'pending' && proposal.runStatus === 'completed' && state.uncertainIds.includes(proposalId)) {
        retryProofs.set(proposalId, { proposal, instanceId: result.instanceId, serial: epoch });
        publish({ retryApprovalIds: [proposalId] });
      }
      publish({ phase: 'ready', message: proposal.status === 'pending' && state.uncertainIds.includes(proposalId) ? '尚未确认原操作是否被接受。刚刚读取的提议仍待批准，不能据此认定先前请求未被接受；可继续只读核对，或明确重试同一份已保存提议的批准请求。' : '' }); return true;
    } catch { if (valid(epoch)) publish({ phase: 'error', message: '未能核对原提议。结果仍待确认，没有重新提交。' }); return false; }
  }
  async function act(action, expected) {
    if (!active || !visible || state.phase !== 'ready' || state.busy || !state.instanceId || !expected) return false;
    const proposal = state.proposals.find(item => item.id === expected.id), retry = action === 'retry_approval', proof = retryProofs.get(expected.id);
    if (!proposal || proposal !== expected || !['approve', 'reject', 'recover', 'retry_approval'].includes(action) ||
        state.uncertainIds.includes(proposal.id) && !['recover', 'retry_approval'].includes(action) ||
        (action === 'recover' ? !agentEditCanRecover(proposal) : !agentEditCanApprove(proposal)) ||
        ['approve', 'retry_approval'].includes(action) && Boolean(agentTimelineApprovalIssue(proposal, timelineContext || {})) ||
        retry && (!state.uncertainIds.includes(proposal.id) || !proof || proof.proposal !== proposal || proof.instanceId !== state.instanceId || proof.serial !== serial)) return false;
    for (const [id, item] of pins) if (terminal(item)) pins.delete(id);
    if (!pins.has(proposal.id) && pins.size >= 50) { publish({ ...projection(), message: pinCapacityMessage }); return false; }
    pins.set(proposal.id, proposal);
    const epoch = ++serial, instanceId = state.instanceId; retryProofs.clear();
    publish({ ...projection(), busy: proposal.id, retryApprovalIds: [], message: '', ...(['approve', 'retry_approval'].includes(action) ? { uncertainIds: [...new Set([...state.uncertainIds, proposal.id])] } : {}) });
    try {
      const result = safeAgentEditEnvelope(await read(signal => client.act(projectId, proposal.id, retry ? 'approve' : action, { instanceId, digest: proposal.digest }, signal)), projectId, proposal.id);
      if (!valid(epoch)) return false;
      // A stale epoch acknowledgement cannot silently authorize a new service.
      if (result.instanceId !== instanceId) invalid();
      const updated = merge(result); confirmApplied(updated);
      publish({ busy: null, phase: 'ready', message: updated.status === 'applied' ? '已确认应用此份不可修改的提议。当前保存内容将单独读取，属性面板中未保存的输入仍保留。' : '' }); return true;
    } catch (error) {
      if (!valid(epoch)) return false;
      publish({ busy: null, phase: 'ready', uncertainIds: [...new Set([...state.uncertainIds, proposal.id])], message: error.definitive ? '本次操作被保存服务阻止，不能据此判断较早操作的结果。正在只读核对原提议；不会自动重试。' : '没有收到操作确认。这不代表已拒绝或未应用；正在只读核对原提议，不会自动重试。' });
      if (visible) await inspect(proposal.id);
      return false;
    }
  }
  return { getState: () => state, load, inspect, act,
    setTimelineContext({ target, blockedReason = '', contextMode } = {}) {
      let next = null; try { if (target) next = contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? safeAgentTimelineGainTarget(target, projectId) : safeAgentTimelineTarget(target, projectId); } catch { /* Malformed or stale selection never approves. */ }
      timelineContext = { target: next, blockedReason: typeof blockedReason === 'string' ? blockedReason : '请先核对当前时间线状态。', contextMode };
    },
    chooseView(view) { if (!active || !visible || state.busy || !['unresolved', 'all'].includes(view)) return false; return load({ view, cursor: null, trail: [] }); },
    older() { return state.nextCursor && !state.trail.includes(state.nextCursor) ? load({ cursor: state.nextCursor, trail: [...state.trail, state.cursor].slice(-64) }) : false; },
    newer() { return state.trail.length ? load({ cursor: state.trail.at(-1), trail: state.trail.slice(0, -1) }) : false; },
    setVisible(value) { if (!active || visible === Boolean(value)) return; visible = Boolean(value); if (!visible) { retryProofs.clear(); publish({ retryApprovalIds: [] }); } if (!visible && !state.busy) { serial++; for (const item of reads) item.abort(); if (state.phase === 'loading') publish({ phase: state.instanceId ? 'ready' : 'loading' }); } else if (visible && !state.busy) void load(); },
    dispose() { active = false; serial++; for (const item of reads) item.abort(); reads.clear(); },
  };
}
