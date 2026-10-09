import { agentConfiguration, safeAgentSettings } from './agent-settings.js';

// Chat is an ephemeral, project-labelled text conversation, never a project tool.
export const AGENT_CHAT_PROMPT_BYTES = 8192;
export const AGENT_CHAT_OUTPUT_BYTES = 128 * 1024;
const MAX_RUNS = 16, MAX_FRAME = 1024 * 1024;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bytes = value => new TextEncoder().encode(value).length;
const statuses = new Set(['running', 'completed', 'stopped', 'failed', 'interrupted']);
const codes = new Set(['UNAUTHORIZED', 'AGENT_CHAT_SESSION_EXPIRED', 'AGENT_CHAT_CONVERSATION_CONFLICT', 'AGENT_CHAT_SETTINGS_CONFLICT', 'AGENT_CHAT_CONSENT_REQUIRED', 'AGENT_CHAT_ACTIVE_RUN', 'AGENT_CHAT_IDEMPOTENCY_CONFLICT', 'AGENT_CHAT_RUN_EXPIRED', 'AGENT_CHAT_NOT_FOUND', 'AGENT_CHAT_BUSY', 'AGENT_CHAT_CLOSED', 'AGENT_CHAT_CREDENTIAL_UNAVAILABLE', 'AGENT_CHAT_VALIDATION', 'AGENT_CHAT_LIMIT', 'AGENT_CHAT_PROFILE_UNSUPPORTED', 'AGENT_CHAT_KEY_REQUIRED', 'AGENT_CHAT_NETWORK_DENIED', 'AGENT_CHAT_CONNECT_FAILED', 'AGENT_CHAT_TIMEOUT', 'AGENT_CHAT_ABORTED', 'AGENT_CHAT_HTTP_ERROR', 'AGENT_CHAT_PROTOCOL_ERROR', 'AGENT_CHAT_TRUNCATED', 'AGENT_CHAT_TOOLS_UNSUPPORTED', 'AGENT_CHAT_REASONING_UNSUPPORTED', 'AGENT_CHAT_PROVIDER_ERROR']);
const failure = code => Object.assign(new Error('Agent chat request did not complete.'), { code: codes.has(code) || ['NETWORK', 'INVALID_RESPONSE'].includes(code) ? code : 'NETWORK' });
export const agentChatErrorText = code => ({
  UNAUTHORIZED: '登录会话已过期，请重新登录后打开对话。',
  AGENT_CHAT_SESSION_EXPIRED: '后端会话已更换；旧对话和运行无法恢复，也不会自动重新发送。',
  AGENT_CHAT_SETTINGS_CONFLICT: '连接设置已改变。请核对最新地址和模型，再重新确认发送。',
  AGENT_CHAT_CONVERSATION_CONFLICT: '对话已在其他窗口更新。请核对最新内容，再确认发送。',
  AGENT_CHAT_CONSENT_REQUIRED: '发送目标或对话已改变，请重新核对并确认。',
  AGENT_CHAT_ACTIVE_RUN: '此项目已有一条回复正在生成，请等待或停止后再发送。',
  AGENT_CHAT_CREDENTIAL_UNAVAILABLE: '当前连接的密钥不可用。请在连接设置中检查；没有自动切换服务。',
  AGENT_CHAT_BUSY: '本次会话的运行或容量已达上限，请等待正在进行的回复结束。',
  AGENT_CHAT_RUN_EXPIRED: '这条运行已不在临时缓存中；无法恢复，也不会重新发送。',
  AGENT_CHAT_NOT_FOUND: '未找到这条临时运行；不会重新发送。',
  AGENT_CHAT_CLOSED: '聊天服务已关闭，请重新读取状态或重启应用。',
  AGENT_CHAT_VALIDATION: '消息未通过校验，请检查长度及字符。',
  AGENT_CHAT_PROFILE_UNSUPPORTED: '当前文本聊天尚不支持此模型配置。请在连接设置中选择支持的非思考模型。',
  AGENT_CHAT_KEY_REQUIRED: '请先在连接设置中为当前服务保存 API 密钥。',
  AGENT_CHAT_NETWORK_DENIED: '服务地址未通过安全网络检查；本地服务仅支持专用 Ollama 回环地址。',
  AGENT_CHAT_CONNECT_FAILED: '无法安全连接模型服务，请检查连接设置和网络。',
  AGENT_CHAT_TIMEOUT: '回复超时，已保留收到的文字。不会自动重新发送。',
  AGENT_CHAT_ABORTED: '回复已停止；远端仍可能已计算或计费。',
  AGENT_CHAT_HTTP_ERROR: '模型服务拒绝了请求，请检查账户、模型和配置。',
  AGENT_CHAT_PROTOCOL_ERROR: '模型返回了无效或不支持的文本流，请检查模型兼容配置。',
  AGENT_CHAT_TRUNCATED: '连接提前结束，或回复达到输出限制，内容可能不完整。',
  AGENT_CHAT_LIMIT: '已达到输入、输出或流量限制，当前回复已停止。',
  AGENT_CHAT_TOOLS_UNSUPPORTED: '模型尝试调用工具，当前仅支持文字对话，没有执行工具。',
  AGENT_CHAT_REASONING_UNSUPPORTED: '此模型返回了不支持的推理或续接数据，请选择非思考文本模式。',
  AGENT_CHAT_PROVIDER_ERROR: '模型服务在回复过程中报告错误，已保留收到的文字。',
}[code] || '回复未完成。已保留收到的文字；不会自动重新发送。');

function boundedText(value, max) { if (typeof value !== 'string' || bytes(value) > max) throw failure('INVALID_RESPONSE'); return value; }
function identity(value, projectId, instanceId) {
  if (!value || !uuid(value.instanceId) || typeof value.projectId !== 'string' || value.projectId !== projectId || !integer(value.revision) || (instanceId && value.instanceId !== instanceId)) throw failure('INVALID_RESPONSE');
}
export function safeAgentChatRun(value, projectId) {
  if (!value || !uuid(value.id) || !uuid(value.requestId) || value.projectId !== projectId || !statuses.has(value.status) || !integer(value.lastEventId) || !value.configuration || !['presetId', 'platformId', 'baseUrl', 'model'].every(key => typeof value.configuration[key] === 'string')) throw failure('INVALID_RESPONSE');
  const configuration = agentConfiguration(value.configuration);
  if (configuration.baseUrl.length > 2048 || configuration.model.length > 200 || configuration.presetId.length > 100 || configuration.platformId.length > 100) throw failure('INVALID_RESPONSE');
  return { id: value.id, requestId: value.requestId, projectId, status: value.status,
    userText: boundedText(value.userText, AGENT_CHAT_PROMPT_BYTES), assistantText: boundedText(value.assistantText, AGENT_CHAT_OUTPUT_BYTES),
    configuration, createdAt: typeof value.createdAt === 'string' ? value.createdAt.slice(0, 40) : '', updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt.slice(0, 40) : '', lastEventId: value.lastEventId,
    ...(value.error ? { error: { code: codes.has(value.error.code) ? value.error.code : 'NETWORK' } } : {}) };
}
export function safeAgentChatSnapshot(value, projectId) {
  identity(value, projectId);
  if (value.scope !== 'chat_only' || value.persistence !== 'session' || !['provider', 'simulated'].includes(value.mode) || !Array.isArray(value.runs) || value.runs.length > MAX_RUNS) throw failure('INVALID_RESPONSE');
  const runs = value.runs.map(run => safeAgentChatRun(run, projectId));
  if (new Set(runs.map(run => run.id)).size !== runs.length || runs.filter(run => run.status === 'running').length > 1) throw failure('INVALID_RESPONSE');
  return { instanceId: value.instanceId, projectId, revision: value.revision, scope: 'chat_only', persistence: 'session', mode: value.mode, settings: safeAgentSettings(value.settings), runs };
}
function safeRunEnvelope(value, projectId, instanceId) { identity(value, projectId, instanceId); return { instanceId: value.instanceId, projectId, revision: value.revision, run: safeAgentChatRun(value.run, projectId) }; }
export function safeAgentChatEvent(value, frame, projectId, instanceId, runId) {
  identity(value, projectId, instanceId);
  if (!integer(value.id) || value.id < 1 || String(value.id) !== frame.id || value.type !== frame.type || value.runId !== runId || !['snapshot', 'delta', 'terminal'].includes(value.type)) throw failure('INVALID_RESPONSE');
  const result = { id: value.id, type: value.type, instanceId, projectId, runId, revision: value.revision };
  if (value.type === 'delta') result.text = boundedText(value.text, AGENT_CHAT_OUTPUT_BYTES);
  else { result.run = safeAgentChatRun(value.run, projectId); if (result.run.id !== runId || result.run.lastEventId !== value.id || (value.type === 'terminal' && result.run.status === 'running')) throw failure('INVALID_RESPONSE'); }
  return result;
}

// EventSource cannot surface HTTP failures reliably. This parser uses a bounded,
// authenticated fetch stream and treats every reconnect as a read, never a POST.
export async function readAgentChatSSE(body, onFrame, signal) {
  if (!body?.getReader) throw failure('INVALID_RESPONSE');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', frame = { id: '', type: '', data: [] }, frameBytes = 0;
  const line = value => {
    frameBytes += bytes(value);
    if (frameBytes > MAX_FRAME) throw failure('INVALID_RESPONSE');
    if (value === '') {
      if (frame.data.length) { const data = JSON.parse(frame.data.join('\n')); onFrame({ id: frame.id, type: frame.type || 'message', data }); }
      frame = { id: '', type: '', data: [] }; frameBytes = 0; return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'), name = colon < 0 ? value : value.slice(0, colon), content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
    if (name === 'id') frame.id = content; else if (name === 'event') frame.type = content; else if (name === 'data') frame.data.push(content);
  };
  try {
    while (!signal?.aborted) {
      const part = await reader.read();
      if (part.done) { buffer += decoder.decode(); if (buffer || frame.data.length) throw failure('INVALID_RESPONSE'); return; }
      buffer += decoder.decode(part.value, { stream: true });
      if (bytes(buffer) > MAX_FRAME) throw failure('INVALID_RESPONSE');
      let match;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        // A CR at a chunk boundary might be half of CRLF.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        line(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
        if (signal?.aborted) return;
      }
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

export function createAgentChatClient({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 12000 } = {}) {
  const path = projectId => `/api/agent/chat/${encodeURIComponent(projectId)}`;
  async function json(url, method = 'GET', body, signal) {
    const abort = new AbortController(); let timer;
    const cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const work = (async () => {
      const response = await fetchImpl(url, { method, credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      let envelope;
      try { envelope = await response.json(); } catch { throw failure('INVALID_RESPONSE'); }
      if (!response.ok || envelope?.ok !== true) throw failure(response.status === 401 ? 'UNAUTHORIZED' : envelope?.error?.code);
      return envelope.data;
    })();
    try { return await Promise.race([work, new Promise((_, reject) => {
      if (timeoutMs > 0) timer = setTimeout(() => { abort.abort(); reject(failure('NETWORK')); }, timeoutMs);
      abort.signal.addEventListener('abort', () => reject(failure('NETWORK')), { once: true });
      if (abort.signal.aborted) reject(failure('NETWORK'));
    })]); } catch (error) { throw failure(error?.code); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  return {
    read: async (projectId, signal) => safeAgentChatSnapshot(await json(path(projectId), 'GET', undefined, signal), projectId),
    start: async (projectId, input, signal) => safeRunEnvelope(await json(`${path(projectId)}/runs`, 'POST', input, signal), projectId, input.instanceId),
    run: async (projectId, runId, instanceId, signal) => safeRunEnvelope(await json(`${path(projectId)}/runs/${encodeURIComponent(runId)}?instanceId=${encodeURIComponent(instanceId)}`, 'GET', undefined, signal), projectId, instanceId),
    stop: async (projectId, runId, instanceId, signal) => safeRunEnvelope(await json(`${path(projectId)}/runs/${encodeURIComponent(runId)}/stop`, 'POST', { instanceId }, signal), projectId, instanceId),
    async stream(projectId, runId, instanceId, after, { signal, onEvent }) {
      try {
        const response = await fetchImpl(`${path(projectId)}/runs/${encodeURIComponent(runId)}/events?instanceId=${encodeURIComponent(instanceId)}&after=${after}`, { credentials: 'same-origin', cache: 'no-store', signal, headers: { Accept: 'text/event-stream' } });
        if (!response.ok) { let result; try { result = await response.json(); } catch {} throw failure(response.status === 401 ? 'UNAUTHORIZED' : result?.error?.code); }
        if (!response.headers?.get('content-type')?.includes('text/event-stream')) throw failure('INVALID_RESPONSE');
        await readAgentChatSSE(response.body, frame => onEvent(safeAgentChatEvent(frame.data, frame, projectId, instanceId, runId)), signal);
      } catch (error) { throw failure(error?.code); }
    },
  };
}

const receiptsKey = 'mioon.agent-chat.receipts.v1';
const fallbackReceipts = new Map();
// Only non-secret identities are stored, never prompts, responses or settings.
export function createAgentChatReceipts(storage) {
  const getStorage = () => { try { return storage === undefined ? globalThis.sessionStorage : storage; } catch { return null; } };
  const readAll = () => { try { const value = JSON.parse(getStorage()?.getItem(receiptsKey) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? Object.assign(Object.create(null), value) : Object.create(null); } catch { return Object.create(null); } };
  return {
    get(projectId) { const all = readAll(), value = Object.hasOwn(all, projectId) ? all[projectId] : fallbackReceipts.get(projectId); return value && uuid(value.instanceId) && (!value.requestId || uuid(value.requestId)) ? { instanceId: value.instanceId, ...(value.requestId ? { requestId: value.requestId } : {}) } : null; },
    set(projectId, value) {
      const safe = { instanceId: value.instanceId, ...(value.requestId ? { requestId: value.requestId } : {}) };
      fallbackReceipts.delete(projectId); fallbackReceipts.set(projectId, safe);
      while (fallbackReceipts.size > 32) fallbackReceipts.delete(fallbackReceipts.keys().next().value);
      const all = readAll(); delete all[projectId]; all[projectId] = safe;
      const bounded = Object.fromEntries(Object.entries(all).slice(-32));
      try { getStorage()?.setItem(receiptsKey, JSON.stringify(bounded)); } catch {}
    },
  };
}
export const initialAgentChatState = () => ({ phase: 'loading', snapshot: null, draft: '', consent: null, message: '', sessionLost: false, pending: null });
export const activeAgentChatRun = state => state?.snapshot?.runs.find(run => run.status === 'running') || null;
export const agentChatConsentKey = snapshot => snapshot ? JSON.stringify([snapshot.instanceId, snapshot.revision, snapshot.settings.revision, snapshot.settings.configuration.baseUrl, snapshot.settings.configuration.model]) : null;
export function agentChatPromptIssue(message) {
  if (typeof message !== 'string' || !message.trim()) return '请输入消息。';
  if (bytes(message) > AGENT_CHAT_PROMPT_BYTES) return '消息最多 8192 UTF-8 字节，请缩短后发送。';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(message)) return '消息包含不支持的控制字符。';
  return '';
}
export const agentChatCanSend = state => Boolean(state?.snapshot && state.phase === 'ready' && !state.pending && !activeAgentChatRun(state) && state.consent === agentChatConsentKey(state.snapshot) && state.snapshot.settings.configuration.baseUrl && state.snapshot.settings.configuration.model && !agentChatPromptIssue(state.draft));

/** One immutable project/dialog lifetime. Disposing detaches reads only. */
export function createAgentChatSession({ projectId, client = createAgentChatClient(), receipts = createAgentChatReceipts(), requestId = () => globalThis.crypto.randomUUID(), onChange = () => {} } = {}) {
  let active = true, visible = true, state = initialAgentChatState(), streamAbort = null, serial = 0;
  const pendingReads = new Set();
  const publish = patch => { if (active) { state = { ...state, ...patch }; onChange(state); } };
  const detach = () => { serial++; streamAbort?.abort(); streamAbort = null; };
  const request = async action => { const abort = new AbortController(); pendingReads.add(abort); try { return await action(abort.signal); } finally { pendingReads.delete(abort); } };
  const valid = epoch => active && epoch === serial;
  const receipt = value => { if (active) receipts.set(projectId, value); };
  const mergeRun = envelope => {
    if (!state.snapshot || envelope.instanceId !== state.snapshot.instanceId || envelope.projectId !== projectId || envelope.revision < state.snapshot.revision) throw failure('INVALID_RESPONSE');
    const runs = state.snapshot.runs.filter(run => run.id !== envelope.run.id); runs.push(envelope.run);
    return { ...state.snapshot, revision: envelope.revision, runs: runs.slice(-MAX_RUNS) };
  };
  const finishState = snapshot => ({ snapshot, phase: activeAgentChatRun({ snapshot }) ? 'streaming' : 'ready', consent: null });
  async function recoverStream(runId, instanceId, epoch) {
    try {
      const envelope = await request(signal => client.run(projectId, runId, instanceId, signal));
      if (!valid(epoch)) return;
      const snapshot = mergeRun(envelope);
      publish({ snapshot, phase: envelope.run.status === 'running' ? 'detached' : 'ready', consent: null, message: envelope.run.status === 'running' ? '连接已中断，回复可能仍在继续。重新读取只恢复显示，不会重复发送。' : '' });
    } catch (error) {
      if (!valid(epoch)) return;
      if (error.code === 'AGENT_CHAT_SESSION_EXPIRED') { await load(); return; }
      publish({ phase: 'unknown', consent: null, message: '暂时无法确认运行状态。已收到的文字保留；只会读取状态，不会重新发送。' });
    }
  }
  function attach(run) {
    if (!active || run.status !== 'running' || !state.snapshot) return;
    if (!visible) { publish({ phase: 'detached' }); return; }
    detach(); const epoch = serial, instanceId = state.snapshot.instanceId;
    const abort = new AbortController(); streamAbort = abort;
    publish({ phase: 'streaming' });
    void (async () => {
      try {
        await client.stream(projectId, run.id, instanceId, run.lastEventId, { signal: abort.signal, onEvent: event => {
          if (!valid(epoch) || abort.signal.aborted || event.instanceId !== instanceId || event.projectId !== projectId || event.runId !== run.id) return;
          const previous = state.snapshot.runs.find(item => item.id === run.id);
          if (!previous || event.id <= previous.lastEventId) return;
          if (event.revision < state.snapshot.revision || (event.type === 'delta' && event.id !== previous.lastEventId + 1)) throw failure('INVALID_RESPONSE');
          const next = event.type === 'delta' ? { ...previous, assistantText: boundedText(previous.assistantText + event.text, AGENT_CHAT_OUTPUT_BYTES), lastEventId: event.id } : event.run;
          const snapshot = mergeRun({ instanceId, projectId, revision: event.revision, run: next });
          publish({ snapshot, phase: next.status === 'running' ? 'streaming' : 'ready', consent: null, message: '' });
          if (next.status !== 'running') abort.abort();
        } });
      } catch { /* Read the canonical run after an incomplete stream. */ }
      if (valid(epoch) && !abort.signal.aborted && activeAgentChatRun(state)) await recoverStream(run.id, instanceId, epoch);
    })();
  }
  async function load() {
    if (!active || ['submitting', 'stopping'].includes(state.phase)) return false;
    detach(); const epoch = serial;
    publish({ phase: 'loading', consent: null });
    try {
      const snapshot = await request(signal => client.read(projectId, signal));
      if (!valid(epoch)) return false;
      const previous = receipts.get(projectId), sessionLost = Boolean(previous && previous.instanceId !== snapshot.instanceId);
      const requestPending = !sessionLost && previous?.requestId;
      const accepted = requestPending && snapshot.runs.find(run => run.requestId === requestPending);
      const unresolved = requestPending && !accepted;
      receipt({ instanceId: snapshot.instanceId, ...(unresolved ? { requestId: requestPending } : {}) });
      publish({ ...finishState(snapshot), sessionLost: sessionLost || state.sessionLost, pending: unresolved ? (state.pending || { requestId: requestPending }) : null,
        phase: unresolved ? 'unknown' : activeAgentChatRun({ snapshot }) ? 'streaming' : 'ready',
        message: unresolved ? '未收到发送确认，尚未找到对应运行。重新读取不能证明请求未被接受，不会自动重发。若始终查不到，需重启后端或应用以结束本地待确认状态；所有临时对话会丢失，远端仍可能已计算或计费。' : sessionLost ? agentChatErrorText('AGENT_CHAT_SESSION_EXPIRED') : '' });
      if (!unresolved) { const running = activeAgentChatRun(state); if (running) attach(running); }
      return true;
    } catch (error) { if (valid(epoch)) publish({ phase: state.snapshot ? 'unknown' : 'load_error', message: error.code === 'UNAUTHORIZED' ? agentChatErrorText(error.code) : '暂时无法读取对话。请检查连接后重新读取；不会发起模型请求。', consent: null }); return false; }
  }
  return {
    getState: () => state, load,
    setVisible(value) {
      if (!active || visible === Boolean(value)) return;
      visible = Boolean(value);
      if (!visible) { streamAbort?.abort(); streamAbort = null; if (state.phase === 'streaming') publish({ phase: 'detached' }); }
      else if (!['submitting', 'stopping'].includes(state.phase)) void load();
    },
    edit(value) { if (!active || !visible || typeof value !== 'string' || value.length > AGENT_CHAT_PROMPT_BYTES) return false; publish({ draft: value }); return true; },
    approve(value) { if (!active || !visible || state.phase !== 'ready' || !state.snapshot) return false; publish({ consent: value ? agentChatConsentKey(state.snapshot) : null }); return true; },
    async send() {
      if (!active || !visible || !agentChatCanSend(state)) return false;
      detach(); const epoch = serial, snapshot = state.snapshot, id = requestId(), message = state.draft;
      const input = { requestId: id, instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision, expectedConversationRevision: snapshot.revision, message,
        consent: { destination: snapshot.settings.configuration.baseUrl, model: snapshot.settings.configuration.model, context: 'typed_chat_only' } };
      receipt({ instanceId: snapshot.instanceId, requestId: id });
      publish({ phase: 'submitting', pending: { requestId: id, userText: message }, consent: null, message: '' });
      try {
        const envelope = await request(signal => client.start(projectId, input, signal));
        if (!valid(epoch)) return false;
        if (envelope.run.requestId !== id || envelope.run.userText !== message) throw failure('INVALID_RESPONSE');
        const next = mergeRun(envelope);
        receipt({ instanceId: snapshot.instanceId });
        publish({ ...finishState(next), draft: '', pending: null });
        attach(envelope.run); return true;
      } catch (error) {
        if (!valid(epoch)) return false;
        if (['NETWORK', 'INVALID_RESPONSE'].includes(error.code)) {
          publish({ phase: 'unknown', message: '未收到发送确认。正在读取原请求状态，不会重新发送。' });
          await load();
          if (active && !state.pending && state.snapshot?.instanceId === snapshot.instanceId && state.snapshot.runs.some(run => run.requestId === id)) publish({ draft: '' });
        } else {
          receipt({ instanceId: snapshot.instanceId });
          publish({ phase: 'ready', pending: null, message: agentChatErrorText(error.code) });
          if (['AGENT_CHAT_SETTINGS_CONFLICT', 'AGENT_CHAT_CONVERSATION_CONFLICT', 'AGENT_CHAT_CONSENT_REQUIRED', 'AGENT_CHAT_ACTIVE_RUN', 'AGENT_CHAT_SESSION_EXPIRED'].includes(error.code)) {
            await load(); if (active && error.code !== 'AGENT_CHAT_SESSION_EXPIRED') publish({ message: agentChatErrorText(error.code) });
          }
        }
        return false;
      }
    },
    async stop() {
      const run = activeAgentChatRun(state);
      if (!active || !visible || !run || ['submitting', 'stopping', 'loading'].includes(state.phase)) return false;
      detach(); const epoch = serial, instanceId = state.snapshot.instanceId;
      publish({ phase: 'stopping', consent: null, message: '正在请求停止。已发生的计算或费用无法撤回。' });
      try {
        const envelope = await request(signal => client.stop(projectId, run.id, instanceId, signal));
        if (!valid(epoch)) return false;
        const snapshot = mergeRun(envelope);
        publish({ ...finishState(snapshot), message: envelope.run.status === 'stopped' ? '已停止等待后续回复，已收到的文字保留；远端仍可能已计算或计费。' : '停止请求已返回，运行状态如下；已发生的费用无法撤回。' });
        attach(envelope.run); return true;
      } catch (error) {
        if (!valid(epoch)) return false;
        publish({ phase: 'unknown', message: '未确认停止结果；远端可能仍在运行或计费。正在读取状态，不会重复提交停止。' });
        await recoverStream(run.id, instanceId, epoch); return false;
      }
    },
    dispose() { if (!active) return; active = false; detach(); for (const controller of pendingReads) controller.abort(); pendingReads.clear(); state = initialAgentChatState(); },
  };
}
