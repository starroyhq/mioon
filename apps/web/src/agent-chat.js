import { message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import {safeAgentAuthorizationSnapshot,agentAuthorizationKey,agentAuthorizationReceiptSchema} from './agent-authorization-state.ts';
import { AGENT_PROTOCOLS, deriveAgentEndpoint, agentConfiguration, agentConfigurationEqual, isAgentProtocol, safeAgentSettings } from './agent-settings.js';

import { AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT, agentTimelineGainAvailable, safeAgentTimelineGainPolicy, safeAgentTimelineGainTarget, agentTimelineGainTargetPatch, agentTimelineAvailable, safeAgentTimelinePolicy, safeAgentTimelineTarget, agentEditAvailable, safeAgentEditPolicy, safeAgentEditTarget, agentEditTargetKey, agentInspectionAvailable, agentRunContextMode, agentRunProvenanceEqual, agentRunActivityCompatible, safeAgentInspectionPolicy, safeAgentRunInspection, agentChatOutboundConsent } from './agent-tool-state.js';
export { AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT, agentTimelineGainAvailable, safeAgentTimelineGainPolicy, safeAgentTimelineGainTarget, agentTimelineGainTargetPatch, agentTimelineAvailable, safeAgentTimelinePolicy, safeAgentTimelineTarget, agentEditAvailable, safeAgentEditTarget, agentEditTargetKey, agentInspectionAvailable, agentRunContextMode } from './agent-tool-state.js';
export { AGENT_PROTOCOLS, deriveAgentEndpoint };

// Durable conversation with an explicit, bounded saved-project inspection mode.
export const AGENT_CHAT_PROMPT_BYTES = 8192;
export const AGENT_CHAT_OUTPUT_BYTES = 128 * 1024;
const MAX_RUNS = 16, MAX_FRAME = 1024 * 1024, MAX_HISTORY_CURSORS = 32;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bytes = value => new TextEncoder().encode(value).length;
const statuses = new Set(['running', 'completed', 'stopped', 'failed', 'interrupted']);
const codes = new Set(['UNAUTHORIZED', 'AGENT_CHAT_STORAGE_LIMIT', 'AGENT_CHAT_STORAGE_UNAVAILABLE', 'AGENT_CHAT_INTERRUPTED', 'AGENT_CHAT_SESSION_EXPIRED', 'AGENT_CHAT_CONVERSATION_CONFLICT', 'AGENT_CHAT_SETTINGS_CONFLICT', 'AGENT_CHAT_CONSENT_REQUIRED', 'AGENT_CHAT_ACTIVE_RUN', 'AGENT_CHAT_IDEMPOTENCY_CONFLICT', 'AGENT_CHAT_RUN_EXPIRED', 'AGENT_CHAT_NOT_FOUND', 'AGENT_CHAT_BUSY', 'AGENT_CHAT_CLOSED', 'AGENT_CHAT_CREDENTIAL_UNAVAILABLE', 'AGENT_CHAT_VALIDATION', 'AGENT_CHAT_LIMIT', 'AGENT_CHAT_PROFILE_UNSUPPORTED', 'AGENT_CHAT_KEY_REQUIRED', 'AGENT_CHAT_NETWORK_DENIED', 'AGENT_CHAT_CONNECT_FAILED', 'AGENT_CHAT_TIMEOUT', 'AGENT_CHAT_ABORTED', 'AGENT_CHAT_HTTP_ERROR', 'AGENT_CHAT_PROTOCOL_ERROR', 'AGENT_CHAT_TRUNCATED', 'AGENT_CHAT_TOOLS_UNSUPPORTED', 'AGENT_CHAT_INSPECTION_UNAVAILABLE', 'AGENT_CHAT_REASONING_UNSUPPORTED', 'AGENT_CHAT_PROVIDER_ERROR', 'AGENT_CHAT_EDIT_UNAVAILABLE', 'AGENT_CHAT_EDIT_CONFLICT', 'AGENT_CHAT_EDIT_NOT_FOUND', 'AGENT_CHAT_EDIT_INVALID', 'AGENT_CHAT_EDIT_STALE', 'AGENT_CHAT_EDIT_RUN_INCOMPLETE', 'AGENT_EDIT_VALIDATION', 'AGENT_EDIT_NOT_FOUND', 'AGENT_EDIT_CONFLICT', 'AGENT_EDIT_RUN_INCOMPLETE', 'AGENT_EDIT_STORAGE_LIMIT', 'AGENT_EDIT_STORAGE_UNAVAILABLE']);
const failure = code => Object.assign(new Error('Agent chat request did not complete.'), { code: codes.has(code) || ['NETWORK', 'INVALID_RESPONSE'].includes(code) ? code : 'NETWORK' });
export const agentChatErrorText = code => ({
  UNAUTHORIZED: '登录会话已过期，请重新登录后打开对话。',
  AGENT_CHAT_SESSION_EXPIRED: '后端已重新启动。已保存的对话仍可读取；中断的回复不会自动续接或重新发送。',
  AGENT_CHAT_STORAGE_LIMIT: '本地聊天数据库容量已满，无法保存新的对话。草稿已保留，请检查本地存储；不会自动重新发送。',
  AGENT_CHAT_STORAGE_UNAVAILABLE: '本地聊天数据库暂不可用。请保留草稿并检查本地存储；不会自动重新发送。',
  AGENT_CHAT_INTERRUPTED: '回复因应用或后端中断而结束。已保存的部分文字保留，不会自动续接；远端仍可能已计算或计费。',
  AGENT_CHAT_SETTINGS_CONFLICT: '连接设置已改变。请核对最新协议、地址和模型，再重新确认发送。',
  AGENT_CHAT_CONVERSATION_CONFLICT: '对话已在其他窗口更新。请核对最新内容，再确认发送。',
  AGENT_CHAT_CONSENT_REQUIRED: '目标、模型或发送范围尚未授权，或当前请求范围已变化，请核对授权与发送内容。',
  AGENT_CHAT_ACTIVE_RUN: '此项目已有一条回复正在生成，请等待或停止后再发送。',
  AGENT_CHAT_CREDENTIAL_UNAVAILABLE: '当前连接的密钥不可用。请在连接设置中检查；没有自动切换服务。',
  AGENT_CHAT_BUSY: '本次会话的运行或容量已达上限，请等待正在进行的回复结束。',
  AGENT_CHAT_RUN_EXPIRED: '这条运行暂不可读取；可以重新读取已保存的对话，不会重新发送。',
  AGENT_CHAT_NOT_FOUND: '未找到这条已保存的运行；不会重新发送。',
  AGENT_CHAT_CLOSED: '聊天服务已关闭，请重新读取状态或重启应用。',
  AGENT_CHAT_VALIDATION: '消息未通过校验，请检查长度及字符。',
  AGENT_CHAT_PROFILE_UNSUPPORTED: '当前文本聊天尚不支持此协议与模型组合。请在连接设置中核对协议和支持的精确模型 ID；不会自动换模型或协议。',
  AGENT_CHAT_KEY_REQUIRED: '请先在连接设置中为当前服务保存 API 密钥。',
  AGENT_CHAT_NETWORK_DENIED: '服务地址未通过安全网络检查；本地服务仅支持专用 Ollama 回环地址。',
  AGENT_CHAT_CONNECT_FAILED: '无法安全连接模型服务，请检查连接设置和网络。',
  AGENT_CHAT_TIMEOUT: '回复超时，已保留收到的文字。不会自动重新发送。',
  AGENT_CHAT_ABORTED: '回复已停止；远端仍可能已计算或计费。',
  AGENT_CHAT_HTTP_ERROR: '模型服务拒绝了请求，请检查账户、模型和配置。',
  AGENT_CHAT_PROTOCOL_ERROR: '模型返回了无效或不支持的文本流，请检查模型兼容配置。',
  AGENT_CHAT_TRUNCATED: '连接提前结束，或回复达到输出限制，内容可能不完整。',
  AGENT_CHAT_LIMIT: '已达到输入、输出或流量限制，当前回复已停止。',
  AGENT_CHAT_TOOLS_UNSUPPORTED: '模型请求了未获本轮授权的工具，或超出了本轮工具调用上限；该请求未执行。',
  AGENT_CHAT_INSPECTION_UNAVAILABLE: '所选项目的这项资料无法安全读取，没有继续发送模型请求。已收到的文字保留。',
  AGENT_CHAT_REASONING_UNSUPPORTED: '此模型返回了不支持的推理或续接数据，请选择非思考文本模式。',
  AGENT_EDIT_VALIDATION: '所选内容或提议未通过安全校验，请检查已保存目标、字段及范围。',
  AGENT_EDIT_NOT_FOUND: '所选项目、镜头或时间线片段不可用，请重新核对已保存目标。',
  AGENT_EDIT_CONFLICT: '所选目标的保存版本已变化。请查看最新已保存内容并重新确认；没有自动继续发送。',
  AGENT_EDIT_STORAGE_LIMIT: '本地提议存储已达上限，已保存提议保留，没有自动重发。',
  AGENT_EDIT_STORAGE_UNAVAILABLE: '本地提议存储暂不可用，没有自动重发。请核对已保存状态。',
  AGENT_CHAT_EDIT_UNAVAILABLE: '所选已保存目标不在允许的提议范围内。请核对选择、保存版本及内容范围后重新确认。',
  AGENT_CHAT_EDIT_CONFLICT: '所选目标已变化。请读取最新保存版本并重新核对，本次不会自动发送或应用。',
  AGENT_CHAT_PROVIDER_ERROR: '模型服务在回复过程中报告错误，已保留收到的文字。',
}[code] || '回复未完成。已保留收到的文字；不会自动重新发送。');

function boundedText(value, max) { if (typeof value !== 'string' || bytes(value) > max) throw failure('INVALID_RESPONSE'); return value; }
function identity(value, projectId, instanceId, threadId) {
  if (!value || !uuid(value.instanceId) || !uuid(value.threadId) || typeof value.projectId !== 'string' || value.projectId !== projectId || !integer(value.revision) || (instanceId && value.instanceId !== instanceId) || (threadId && value.threadId !== threadId)) throw failure('INVALID_RESPONSE');
}
export function safeAgentChatRun(value, projectId, threadId) {
  if (!value || !uuid(value.id) || !uuid(value.requestId) || !uuid(value.threadId) || (threadId && value.threadId !== threadId) || value.projectId !== projectId || !statuses.has(value.status) || !integer(value.lastEventId) || !value.configuration || !['presetId', 'platformId', 'baseUrl', 'model', 'protocol'].every(key => typeof value.configuration[key] === 'string') || !isAgentProtocol(value.configuration.protocol)) throw failure('INVALID_RESPONSE');
  const configuration = Object.freeze(agentConfiguration(value.configuration));
  try { deriveAgentEndpoint(configuration); } catch { throw failure('INVALID_RESPONSE'); }
  if (configuration.baseUrl.length > 2048 || configuration.model.length > 200 || configuration.presetId.length > 100 || configuration.platformId.length > 100) throw failure('INVALID_RESPONSE');
  return { id: value.id, requestId: value.requestId, threadId: value.threadId, projectId, status: value.status,
    userText: boundedText(value.userText, AGENT_CHAT_PROMPT_BYTES), assistantText: boundedText(value.assistantText, AGENT_CHAT_OUTPUT_BYTES),
    configuration, ...safeAgentRunInspection(value, projectId), createdAt: typeof value.createdAt === 'string' ? value.createdAt.slice(0, 40) : '', updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt.slice(0, 40) : '', lastEventId: value.lastEventId,
    ...(value.error ? { error: { code: codes.has(value.error.code) ? value.error.code : 'NETWORK' } } : {}) };
}
function safeRuns(value, projectId) {
  if (!Array.isArray(value.runs) || value.runs.length > MAX_RUNS) throw failure('INVALID_RESPONSE');
  const runs = value.runs.map(run => safeAgentChatRun(run, projectId, value.threadId));
  if (new Set(runs.map(run => run.id)).size !== runs.length || new Set(runs.map(run => run.requestId)).size !== runs.length || runs.filter(run => run.status === 'running').length > 1) throw failure('INVALID_RESPONSE');
  if (value.historyCursor !== null && (!uuid(value.historyCursor) || value.historyCursor !== runs[0]?.id)) throw failure('INVALID_RESPONSE');
  return runs;
}
export function safeAgentChatSnapshot(value, projectId) {
  identity(value, projectId);
  if (!['chat_only', 'chat_and_project_inspection', 'chat_and_reviewed_shot_edits', 'chat_and_reviewed_timeline_edits'].includes(value.scope) || value.persistence !== 'local_database' || !['provider', 'simulated'].includes(value.mode)) throw failure('INVALID_RESPONSE');
  const runs = safeRuns(value, projectId);
  const inspection = value.inspection == null ? null : safeAgentInspectionPolicy(value.inspection);
  const edit = value.edit == null ? null : safeAgentEditPolicy(value.edit);
  const timelineEdit = value.timelineEdit == null ? null : safeAgentTimelinePolicy(value.timelineEdit);
  const timelineGainEdit = value.timelineGainEdit == null ? null : safeAgentTimelineGainPolicy(value.timelineGainEdit);
  let authorization;try{authorization=safeAgentAuthorizationSnapshot(value.authorization);}catch{throw failure('INVALID_RESPONSE');}
  return { instanceId: value.instanceId, threadId: value.threadId, projectId, revision: value.revision, scope: value.scope, inspection, edit, ...(timelineEdit ? { timelineEdit } : {}), ...(timelineGainEdit ? { timelineGainEdit } : {}), authorization, persistence: 'local_database', mode: value.mode, settings: safeAgentSettings(value.settings), runs, historyCursor: value.historyCursor };
}
export function safeAgentChatHistory(value, projectId, instanceId, threadId, before) {
  identity(value, projectId, instanceId, threadId);
  const runs = safeRuns(value, projectId);
  if (runs.some(run => run.status === 'running' || run.id === before) || value.historyCursor === before) throw failure('INVALID_RESPONSE');
  return { instanceId: value.instanceId, threadId: value.threadId, projectId, revision: value.revision, runs, historyCursor: value.historyCursor };
}
function safeRunEnvelope(value, projectId, instanceId, threadId) { identity(value, projectId, instanceId, threadId); return { instanceId: value.instanceId, threadId: value.threadId, projectId, revision: value.revision, run: safeAgentChatRun(value.run, projectId, value.threadId) }; }
export function safeAgentChatEvent(value, frame, projectId, instanceId, runId, threadId) {
  identity(value, projectId, instanceId, threadId);
  if (!integer(value.id) || value.id < 1 || String(value.id) !== frame.id || value.type !== frame.type || value.runId !== runId || !['snapshot', 'delta', 'terminal'].includes(value.type)) throw failure('INVALID_RESPONSE');
  const result = { id: value.id, type: value.type, instanceId, threadId: value.threadId, projectId, runId, revision: value.revision };
  if (value.type === 'delta') result.text = boundedText(value.text, AGENT_CHAT_OUTPUT_BYTES);
  else { result.run = safeAgentChatRun(value.run, projectId, value.threadId); if (result.run.id !== runId || result.run.lastEventId !== value.id || (value.type === 'terminal' && result.run.status === 'running')) throw failure('INVALID_RESPONSE'); }
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
    authorize: async (snapshot, scope, requestId, signal) => json('/api/rpc','POST',{operation:'agent.authorization.grant',input:{
      requestId,expectedRevision:snapshot.authorization.revision,expectedSettingsRevision:snapshot.settings.revision,
      destination:deriveAgentEndpoint(snapshot.settings.configuration),model:snapshot.settings.configuration.model,scope,
    }},signal),
    read: async (projectId, signal) => safeAgentChatSnapshot(await json(path(projectId), 'GET', undefined, signal), projectId),
    lookup: async (projectId, requestId, signal) => {
      const result = safeRunEnvelope(await json(`${path(projectId)}/requests/${encodeURIComponent(requestId)}`, 'GET', undefined, signal), projectId);
      if (result.run.requestId !== requestId) throw failure('INVALID_RESPONSE');
      return result;
    },
    history: async (projectId, before, signal) => safeAgentChatHistory(await json(`${path(projectId)}/history?before=${encodeURIComponent(before)}`, 'GET', undefined, signal), projectId, undefined, undefined, before),
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
const initialHistoryState = () => ({ phase: 'closed', page: null, before: null, trail: [], message: '', displayMessage: null });
export const initialAgentChatState = () => ({ phase: 'loading', snapshot: null, draft: '', contextMode: AGENT_TYPED_CONTEXT, editTarget: null, timelineTarget: null, timelineBlockedReason: '', timelineGainTarget: null, timelineGainBlockedReason: '', consent: null, authorizing:false, message: '', displayMessage: null, sessionLost: false, pending: null, abandonRequest: null, recoveredRun: null, history: initialHistoryState() });
export const activeAgentChatRun = state => state?.snapshot?.runs.find(run => run.status === 'running') || null;
export function agentChatConsentKey(snapshot, contextMode = AGENT_TYPED_CONTEXT, editTarget) {
  if (!snapshot) return null;
  const configuration = snapshot.settings?.configuration;
  try { const consent = agentChatOutboundConsent(snapshot, contextMode, deriveAgentEndpoint(configuration), editTarget); return consent ? agentAuthorizationKey(configuration,contextMode) : null; } catch { return null; }
}
export function agentChatPromptIssue(message) {
  if (typeof message !== 'string' || !message.trim()) return '请输入消息。';
  if (bytes(message) > AGENT_CHAT_PROMPT_BYTES) return '消息最多 8192 UTF-8 字节，请缩短后发送。';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(message)) return '消息包含不支持的控制字符。';
  return '';
}
export const agentChatCurrentTarget = state => state?.contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? state.timelineGainTarget : state?.contextMode === AGENT_TIMELINE_CONTEXT ? state.timelineTarget : state?.editTarget;
export const agentChatCanSend = state => Boolean(state?.snapshot && state.phase === 'ready' && !state.pending && !activeAgentChatRun(state) && state.consent !== null && state.consent === agentChatConsentKey(state.snapshot, state.contextMode, agentChatCurrentTarget(state)) && state.snapshot.settings.configuration.baseUrl && state.snapshot.settings.configuration.model && !agentChatPromptIssue(state.draft) && !((state.contextMode === AGENT_TIMELINE_CONTEXT && state.timelineBlockedReason || state.contextMode === AGENT_TIMELINE_GAIN_CONTEXT && state.timelineGainBlockedReason)));

/** One immutable project/chat-page lifetime. Disposing detaches reads only. */
export function createAgentChatSession({ projectId, client = createAgentChatClient(), receipts = createAgentChatReceipts(), requestId = () => globalThis.crypto.randomUUID(), onChange = () => {} } = {}) {
  let active = true, visible = true, state = initialAgentChatState(), streamAbort = null, serial = 0, historySerial = 0, historyAbort = null;
  const pendingReads = new Set();
  const publish = patch => { if (active) { state = { ...state, ...patch };state.consent=visible&&state.snapshot?.authorization?.scopes.includes(state.contextMode)?agentChatConsentKey(state.snapshot,state.contextMode,agentChatCurrentTarget(state)):null;onChange(state); } };
  const detach = () => { serial++; streamAbort?.abort(); streamAbort = null; };
  const request = async action => { const abort = new AbortController(); pendingReads.add(abort); try { return await action(abort.signal); } finally { pendingReads.delete(abort); } };
  const valid = epoch => active && epoch === serial;
  const receipt = value => { if (active) receipts.set(projectId, value); };
  const resetHistory = () => { historySerial++; historyAbort?.abort(); historyAbort = null; };
  const sameRun = (previous, next) => !previous || ((previous.status === 'running' || previous.status === next.status) && previous.threadId === next.threadId && agentConfigurationEqual(previous.configuration, next.configuration) && previous.requestId === next.requestId && previous.userText === next.userText && agentRunProvenanceEqual(previous, next) && agentRunActivityCompatible(previous, next));
  const mergeRun = envelope => {
    envelope = safeRunEnvelope(envelope, projectId, state.snapshot?.instanceId, state.snapshot?.threadId);
    if (!state.snapshot || envelope.instanceId !== state.snapshot.instanceId || envelope.projectId !== projectId || envelope.revision < state.snapshot.revision) throw failure('INVALID_RESPONSE');
    const previous = state.snapshot.runs.find(run => run.id === envelope.run.id);
    if (!sameRun(previous, envelope.run)) throw failure('INVALID_RESPONSE');
    const runs = previous ? state.snapshot.runs.map(run => run.id === envelope.run.id ? envelope.run : run) : [...state.snapshot.runs, envelope.run];
    const bounded = runs.slice(-MAX_RUNS);
    return { ...state.snapshot, revision: envelope.revision, runs: bounded, historyCursor: runs.length > MAX_RUNS ? bounded[0].id : state.snapshot.historyCursor };
  };
  const finishState = snapshot => ({ snapshot, phase: activeAgentChatRun({ snapshot }) ? 'streaming' : 'ready', consent: null });
  async function recoverStream(runId, instanceId, epoch) {
    try {
      const envelope = await request(signal => client.run(projectId, runId, instanceId, signal));
      if (!valid(epoch)) return;
      const snapshot = mergeRun(envelope);
      publish({ snapshot, phase: envelope.run.status === 'running' ? 'detached' : 'ready', consent: null, message: envelope.run.status === 'running' ? '连接已中断，回复可能仍在继续。重新读取只恢复显示，不会重复发送。' : '', displayMessage: envelope.run.status === 'running' ? localizedMessage('agent.chat.state.displayDetached') : null });
    } catch (error) {
      if (!valid(epoch)) return;
      if (error.code === 'AGENT_CHAT_SESSION_EXPIRED') { await load(); return; }
      publish({ phase: 'unknown', consent: null, message: '暂时无法确认运行状态。已收到的文字保留；只会读取状态，不会重新发送。', displayMessage: localizedMessage('agent.chat.state.runStateUnknown') });
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
          if (!valid(epoch) || abort.signal.aborted || event.instanceId !== instanceId || event.projectId !== projectId || event.threadId !== state.snapshot.threadId || event.runId !== run.id) return;
          const previous = state.snapshot.runs.find(item => item.id === run.id);
          if (!previous || event.id <= previous.lastEventId) return;
          if (event.revision < state.snapshot.revision || (event.type === 'delta' && event.id !== previous.lastEventId + 1)) throw failure('INVALID_RESPONSE');
          const next = event.type === 'delta' ? { ...previous, assistantText: boundedText(previous.assistantText + event.text, AGENT_CHAT_OUTPUT_BYTES), lastEventId: event.id } : event.run;
          const snapshot = mergeRun({ instanceId, threadId: state.snapshot.threadId, projectId, revision: event.revision, run: next });
          publish({ snapshot, phase: next.status === 'running' ? 'streaming' : 'ready', consent: null, message: '', displayMessage: null });
          if (next.status !== 'running') abort.abort();
        } });
      } catch { /* Read the canonical run after an incomplete stream. */ }
      if (valid(epoch) && !abort.signal.aborted && activeAgentChatRun(state)) await recoverStream(run.id, instanceId, epoch);
    })();
  }
  async function load() {
    if (!active || ['submitting', 'stopping'].includes(state.phase)) return false;
    detach(); resetHistory(); const epoch = serial;
    publish({ phase: 'loading', consent: null, abandonRequest: null, history: initialHistoryState() });
    try {
      let snapshot = safeAgentChatSnapshot(await request(signal => client.read(projectId, signal)), projectId);
      if (!valid(epoch)) return false;
      if (state.snapshot && (state.snapshot.threadId !== snapshot.threadId || snapshot.revision < state.snapshot.revision)) throw failure('INVALID_RESPONSE');
      for (const run of snapshot.runs) {
        if (!sameRun(state.snapshot?.runs.find(item => item.id === run.id), run)) throw failure('INVALID_RESPONSE');
      }
      const previous = receipts.get(projectId), sessionLost = Boolean(previous && previous.instanceId !== snapshot.instanceId);
      const requestPending = state.pending?.requestId || previous?.requestId;
      publish({ snapshot, ...((state.contextMode === AGENT_PROJECT_CONTEXT && !agentInspectionAvailable(snapshot) || state.contextMode === AGENT_EDIT_CONTEXT && !agentEditAvailable(snapshot) || state.contextMode === AGENT_TIMELINE_CONTEXT && !agentTimelineAvailable(snapshot) || state.contextMode === AGENT_TIMELINE_GAIN_CONTEXT && !agentTimelineGainAvailable(snapshot)) ? { contextMode: AGENT_TYPED_CONTEXT } : {}), sessionLost: sessionLost || state.sessionLost, pending: requestPending ? (state.pending || { requestId: requestPending }) : null, recoveredRun: null });
      let accepted = requestPending && snapshot.runs.find(run => run.requestId === requestPending);
      if (requestPending && !accepted) {
        try {
          const envelope = safeRunEnvelope(await request(signal => client.lookup(projectId, requestPending, signal)), projectId, snapshot.instanceId, snapshot.threadId);
          if (!valid(epoch)) return false;
          if (envelope.run.requestId !== requestPending || envelope.revision < snapshot.revision) throw failure('INVALID_RESPONSE');
          accepted = envelope.run;
          // A concurrent accepted turn changes consent context. Read it, rather
          // than upgrading the revision on an incomplete latest-runs snapshot.
          if (envelope.revision > snapshot.revision) {
            snapshot = safeAgentChatSnapshot(await request(signal => client.read(projectId, signal)), projectId);
            if (!valid(epoch)) return false;
            if (snapshot.instanceId !== envelope.instanceId || snapshot.threadId !== envelope.threadId || snapshot.revision < envelope.revision) throw failure('INVALID_RESPONSE');
            for (const run of snapshot.runs) if (!sameRun(state.snapshot?.runs.find(item => item.id === run.id), run)) throw failure('INVALID_RESPONSE');
            const latest = snapshot.runs.find(run => run.id === accepted.id);
            if (!sameRun(accepted, latest || accepted)) throw failure('INVALID_RESPONSE');
            accepted = latest || accepted;
          }
        } catch (error) {
          if (!valid(epoch)) return false;
          if (error.code !== 'AGENT_CHAT_NOT_FOUND') throw error;
        }
      }
      if (accepted?.status === 'running' && !snapshot.runs.some(run => run.id === accepted.id)) throw failure('INVALID_RESPONSE');
      if (accepted && !sameRun(snapshot.runs.find(run => run.id === accepted.id), accepted)) throw failure('INVALID_RESPONSE');
      if (accepted && (accepted.requestId !== requestPending || (state.pending?.configuration && (!agentConfigurationEqual(accepted.configuration, state.pending.configuration) || accepted.userText !== state.pending.userText || agentRunContextMode(accepted) !== state.pending.contextMode || ([AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(state.pending.contextMode) && agentEditTargetKey(accepted.editTarget) !== agentEditTargetKey(state.pending.editTarget)))))) throw failure('INVALID_RESPONSE');
      const unresolved = requestPending && !accepted;
      receipt({ instanceId: snapshot.instanceId, ...(unresolved ? { requestId: requestPending } : {}) });
      const clearDraft = accepted && state.pending?.userText === state.draft;
      publish({ ...finishState(snapshot), sessionLost: sessionLost || state.sessionLost, pending: unresolved ? (state.pending || { requestId: requestPending }) : null,
        recoveredRun: accepted && !snapshot.runs.some(run => run.id === accepted.id) ? accepted : null,
        ...(clearDraft ? { draft: '' } : {}),
        phase: unresolved ? 'unknown' : activeAgentChatRun({ snapshot }) ? 'streaming' : 'ready',
        message: unresolved ? '未收到发送确认，尚未找到原请求。查不到不能证明请求未被接受；待确认标识在当前页面会话内保留，后端重启后仍可核对。请重新读取，不会自动重发，远端仍可能已计算或计费。' : sessionLost ? agentChatErrorText('AGENT_CHAT_SESSION_EXPIRED') : accepted ? '已读取原请求并确认其保存状态，没有重新发送。' : '', displayMessage: unresolved ? localizedMessage('agent.chat.state.unacknowledgedOriginal') : sessionLost ? agentChatErrorDescriptor('AGENT_CHAT_SESSION_EXPIRED') : accepted ? localizedMessage('agent.chat.state.originalConfirmed') : null });
      if (!unresolved) { const running = activeAgentChatRun(state); if (running) attach(running); }
      return true;
    } catch (error) { if (valid(epoch)) publish({ phase: state.snapshot ? 'unknown' : 'load_error', message: ['UNAUTHORIZED', 'AGENT_CHAT_STORAGE_UNAVAILABLE'].includes(error.code) ? agentChatErrorText(error.code) : '暂时无法读取或确认对话。草稿与待确认标识保留；重新读取不会发起模型请求。', displayMessage: ['UNAUTHORIZED', 'AGENT_CHAT_STORAGE_UNAVAILABLE'].includes(error.code) ? agentChatErrorDescriptor(error.code) : localizedMessage('agent.chat.state.conversationReadUnknown'), consent: null }); return false; }
  }
  async function historyPage(before, trail) {
    if (!active || !visible || !state.snapshot || !uuid(before) || state.history.phase === 'loading') return false;
    resetHistory(); const epoch = historySerial, snapshot = state.snapshot;
    const abort = new AbortController(); historyAbort = abort; pendingReads.add(abort);
    publish({ history: { ...state.history, phase: 'loading', message: '', displayMessage: null } });
    try {
      const page = safeAgentChatHistory(await client.history(projectId, before, abort.signal), projectId, snapshot.instanceId, snapshot.threadId, before);
      if (!active || !visible || epoch !== historySerial || abort.signal.aborted) return false;
      // Browsing never mutates live runs, consent, pending sends or the draft.
      if (page.revision < snapshot.revision || page.runs.some(run => snapshot.runs.some(latest => latest.id === run.id || latest.requestId === run.requestId)) || (page.historyCursor && trail.includes(page.historyCursor))) throw failure('INVALID_RESPONSE');
      publish({ history: { phase: 'ready', page, before, trail: trail.slice(-MAX_HISTORY_CURSORS), message: '', displayMessage: null } });
      return true;
    } catch (error) {
      if (active && visible && epoch === historySerial && !abort.signal.aborted) publish({ history: { ...state.history, phase: 'error', message: error.code === 'AGENT_CHAT_STORAGE_UNAVAILABLE' ? agentChatErrorText(error.code) : '暂时无法读取更早记录。当前回复与草稿仍保留，请返回最近对话后重新读取。', displayMessage: error.code === 'AGENT_CHAT_STORAGE_UNAVAILABLE' ? agentChatErrorDescriptor(error.code) : localizedMessage('agent.chat.state.historyReadUnavailable') } });
      return false;
    } finally { pendingReads.delete(abort); if (historyAbort === abort) historyAbort = null; }
  }
  return {
    getState: () => state, load,
    confirmAbandonPending(value) {
      if (!active || !visible || state.phase !== 'unknown' || !state.pending || !state.snapshot) return false;
      publish({ abandonRequest: value ? state.pending.requestId : null }); return true;
    },
    abandonPending(id) {
      if (!active || !visible || state.phase !== 'unknown' || !state.snapshot || state.pending?.requestId !== id || state.abandonRequest !== id) return false;
      receipt({ instanceId: state.snapshot.instanceId });
      publish({ pending: null, abandonRequest: null, consent: null, phase: activeAgentChatRun(state) ? 'detached' : 'ready', message: '已按你的选择结束本地待确认状态，草稿保留。这不会停止或撤回原请求；再次发送可能造成重复回复或费用，请先核对历史并重新确认。', displayMessage: localizedMessage('agent.chat.state.pendingEnded') });
      return true;
    },
    earlier() {
      const history = state.history;
      return historyPage(history.page ? history.page.historyCursor : state.snapshot?.historyCursor, history.page ? [...history.trail, history.before] : []);
    },
    newer() { const trail = state.history.trail; return trail.length ? historyPage(trail.at(-1), trail.slice(0, -1)) : false; },
    closeHistory() { if (!active || !visible) return false; resetHistory(); publish({ history: initialHistoryState() }); return true; },
    setVisible(value) {
      if (!active || visible === Boolean(value)) return;
      visible = Boolean(value);
      if (!visible) { publish({ consent: null }); resetHistory(); if (state.history.phase === 'loading') publish({ history: { ...state.history, phase: state.history.page ? 'ready' : 'closed' } }); streamAbort?.abort(); streamAbort = null; if (state.phase === 'streaming') publish({ phase: 'detached' }); }
      else if (!['submitting', 'stopping'].includes(state.phase)) void load();
    },
    edit(value) { if (!active || !visible || typeof value !== 'string' || value.length > AGENT_CHAT_PROMPT_BYTES) return false; publish({ draft: value }); return true; },
    setContextMode(value) {
      if (!active || !visible || state.phase !== 'ready' || state.pending || activeAgentChatRun(state) || ![AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(value) || (value === AGENT_PROJECT_CONTEXT && !agentInspectionAvailable(state.snapshot)) || (value === AGENT_EDIT_CONTEXT && !agentEditAvailable(state.snapshot)) || (value === AGENT_TIMELINE_CONTEXT && !agentTimelineAvailable(state.snapshot)) || (value === AGENT_TIMELINE_GAIN_CONTEXT && !agentTimelineGainAvailable(state.snapshot))) return false;
      publish({ contextMode: value, consent: null }); return true;
    },
    setEditTarget(value) {
      if (!active) return false;
      let next = null; try { if (value) next = safeAgentEditTarget(value, projectId, false); } catch { /* Invalid or oversized saved text cannot be authorized. */ }
      if (agentEditTargetKey(next) === agentEditTargetKey(state.editTarget)) return true;
      publish({ editTarget: next, consent: null }); return true;
    },
    setTimelineTarget(value, blockedReason = '') {
      if (!active) return false;
      let next = null; try { if (value) next = safeAgentTimelineTarget(value, projectId); } catch { /* Only exact, bounded saved context is eligible. */ }
      const reason = typeof blockedReason === 'string' ? blockedReason : '请先核对当前时间线状态。';
      if (agentEditTargetKey(next) === agentEditTargetKey(state.timelineTarget) && reason === state.timelineBlockedReason) return true;
      publish({ timelineTarget: next, timelineBlockedReason: reason, consent: null }); return true;
    },
    setTimelineGainTarget(value, blockedReason = '') {
      if (!active) return false;
      const patch = agentTimelineGainTargetPatch(value, projectId, blockedReason);
      if (agentEditTargetKey(patch.timelineGainTarget) === agentEditTargetKey(state.timelineGainTarget) && patch.timelineGainBlockedReason === state.timelineGainBlockedReason) return true;
      publish(patch); return true;
    },
    async approve(value) {
      if(!value||!active||!visible||state.phase!=='ready'||!state.snapshot||state.authorizing)return false;
      const snapshot=state.snapshot,contextMode=state.contextMode,key=agentChatConsentKey(snapshot,contextMode,agentChatCurrentTarget(state));
      if(!key||(contextMode===AGENT_TIMELINE_CONTEXT&&state.timelineBlockedReason||contextMode===AGENT_TIMELINE_GAIN_CONTEXT&&state.timelineGainBlockedReason))return false;
      if(snapshot.authorization.scopes.includes(contextMode))return true;
      const epoch=serial,approvalRequestId=requestId();publish({authorizing:true});
      try{
        const receipt=agentAuthorizationReceiptSchema.parse(await request(signal=>client.authorize(snapshot,contextMode,approvalRequestId,signal)));
        if(!valid(epoch))return false;
        if(receipt.operation!=='grant'||receipt.requestId!==approvalRequestId||receipt.revision!==snapshot.authorization.revision+1||
          !agentConfigurationEqual(state.snapshot.settings.configuration,snapshot.settings.configuration))throw failure('INVALID_RESPONSE');
        const next={...state.snapshot,authorization:{revision:receipt.revision,scopes:[...new Set([...snapshot.authorization.scopes,contextMode])]}};
        publish({snapshot:next,authorizing:false});
        return key===agentChatConsentKey(next,state.contextMode,agentChatCurrentTarget(state))&&Boolean(state.consent);
      }catch(error){if(valid(epoch)){publish({authorizing:false,message:agentChatErrorText('AGENT_CHAT_CONSENT_REQUIRED'),displayMessage:agentChatErrorDescriptor('AGENT_CHAT_CONSENT_REQUIRED')});await load();}return false;}
      finally{if(active)publish({authorizing:false});}
    },
    async send() {
      if (!active || !visible || !agentChatCanSend(state)) return false;
      detach(); const epoch = serial, snapshot = state.snapshot, id = requestId(), message = state.draft, contextMode = state.contextMode, editTarget = agentChatCurrentTarget(state);
      const configuration = Object.freeze(agentConfiguration(snapshot.settings.configuration));
      const input = { requestId: id, instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision, expectedConversationRevision: snapshot.revision, message,
        consent: agentChatOutboundConsent(snapshot, contextMode, deriveAgentEndpoint(configuration), editTarget) };
      receipt({ instanceId: snapshot.instanceId, requestId: id });
      publish({ phase: 'submitting', pending: { requestId: id, userText: message, configuration, contextMode, ...([AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(contextMode) ? { editTarget } : {}) }, consent: null, message: '', displayMessage: null });
      try {
        const envelope = await request(signal => client.start(projectId, input, signal));
        if (!valid(epoch)) return false;
        if (envelope.run.requestId !== id || envelope.run.userText !== message || !agentConfigurationEqual(envelope.run.configuration, configuration) || agentRunContextMode(envelope.run) !== contextMode || ([AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(contextMode) && agentEditTargetKey(envelope.run.editTarget) !== agentEditTargetKey(editTarget))) throw failure('INVALID_RESPONSE');
        const next = mergeRun(envelope);
        receipt({ instanceId: snapshot.instanceId });
        publish({ ...finishState(next), ...(state.draft === message ? { draft: '' } : {}), pending: null, recoveredRun: null });
        attach(envelope.run); return true;
      } catch (error) {
        if (!valid(epoch)) return false;
        if (['NETWORK', 'INVALID_RESPONSE', 'AGENT_CHAT_STORAGE_UNAVAILABLE'].includes(error.code)) {
          publish({ phase: 'unknown', message: '未收到发送确认。正在读取原请求状态，不会重新发送。', displayMessage: localizedMessage('agent.chat.state.checkingSubmission') });
          await load();
        } else {
          receipt({ instanceId: snapshot.instanceId });
          publish({ phase: 'ready', pending: null, message: agentChatErrorText(error.code), displayMessage: agentChatErrorDescriptor(error.code) });
          if (['AGENT_CHAT_SETTINGS_CONFLICT', 'AGENT_CHAT_CONVERSATION_CONFLICT', 'AGENT_CHAT_CONSENT_REQUIRED', 'AGENT_CHAT_ACTIVE_RUN', 'AGENT_CHAT_SESSION_EXPIRED'].includes(error.code)) {
            await load(); if (active && error.code !== 'AGENT_CHAT_SESSION_EXPIRED') publish({ message: agentChatErrorText(error.code), displayMessage: agentChatErrorDescriptor(error.code) });
          }
        }
        return false;
      }
    },
    async stop() {
      const run = activeAgentChatRun(state);
      if (!active || !visible || !run || ['submitting', 'stopping', 'loading'].includes(state.phase)) return false;
      detach(); const epoch = serial, instanceId = state.snapshot.instanceId;
      publish({ phase: 'stopping', consent: null, message: '正在请求停止后续步骤。已发生的计算或费用无法撤回。', displayMessage: localizedMessage('agent.chat.state.requestingStop') });
      try {
        const envelope = await request(signal => client.stop(projectId, run.id, instanceId, signal));
        if (!valid(epoch)) return false;
        const snapshot = mergeRun(envelope);
        publish({ ...finishState(snapshot), message: envelope.run.status === 'stopped' ? '已停止后续步骤，已收到的文字和读取结果保留；远端仍可能已计算或计费。' : '停止请求已返回，运行状态如下；已发生的费用无法撤回。', displayMessage: envelope.run.status === 'stopped' ? localizedMessage('agent.chat.state.stoppedLaterSteps') : localizedMessage('agent.chat.state.stopResponseReceived') });
        attach(envelope.run); return true;
      } catch (error) {
        if (!valid(epoch)) return false;
        publish({ phase: 'unknown', message: '未确认停止结果；远端可能仍在运行或计费。正在读取状态，不会重复提交停止。', displayMessage: localizedMessage('agent.chat.state.stopUnconfirmed') });
        await recoverStream(run.id, instanceId, epoch); return false;
      }
    },
    dispose() { if (!active) return; active = false; detach(); resetHistory(); for (const controller of pendingReads) controller.abort(); pendingReads.clear(); state = initialAgentChatState(); },
  };
}

// Display-only companions keep legacy diagnostics and business identities unchanged.
export const agentChatErrorDescriptor = code => ({ __proto__: null,
  UNAUTHORIZED: localizedMessage('agent.chat.state.unauthorized'),
  AGENT_CHAT_SESSION_EXPIRED: localizedMessage('agent.chat.state.sessionExpired'),
  AGENT_CHAT_STORAGE_LIMIT: localizedMessage('agent.chat.state.storageFull'),
  AGENT_CHAT_STORAGE_UNAVAILABLE: localizedMessage('agent.chat.state.storageUnavailable'),
  AGENT_CHAT_INTERRUPTED: localizedMessage('agent.chat.state.interrupted'),
  AGENT_CHAT_SETTINGS_CONFLICT: localizedMessage('agent.chat.state.settingsConflict'),
  AGENT_CHAT_CONVERSATION_CONFLICT: localizedMessage('agent.chat.state.conversationConflict'),
  AGENT_CHAT_CONSENT_REQUIRED: localizedMessage('agent.chat.state.consentChanged'),
  AGENT_CHAT_ACTIVE_RUN: localizedMessage('agent.chat.state.activeRun'),
  AGENT_CHAT_CREDENTIAL_UNAVAILABLE: localizedMessage('agent.chat.state.credentialUnavailable'),
  AGENT_CHAT_BUSY: localizedMessage('agent.chat.state.busy'),
  AGENT_CHAT_RUN_EXPIRED: localizedMessage('agent.chat.state.runExpired'),
  AGENT_CHAT_NOT_FOUND: localizedMessage('agent.chat.state.runNotFound'),
  AGENT_CHAT_CLOSED: localizedMessage('agent.chat.state.serviceClosed'),
  AGENT_CHAT_VALIDATION: localizedMessage('agent.chat.state.validation'),
  AGENT_CHAT_PROFILE_UNSUPPORTED: localizedMessage('agent.chat.state.unsupportedProfile'),
  AGENT_CHAT_KEY_REQUIRED: localizedMessage('agent.chat.state.keyRequired'),
  AGENT_CHAT_NETWORK_DENIED: localizedMessage('agent.chat.state.networkDenied'),
  AGENT_CHAT_CONNECT_FAILED: localizedMessage('agent.chat.state.connectionFailed'),
  AGENT_CHAT_TIMEOUT: localizedMessage('agent.chat.state.timeout'),
  AGENT_CHAT_ABORTED: localizedMessage('agent.chat.state.aborted'),
  AGENT_CHAT_HTTP_ERROR: localizedMessage('agent.chat.state.httpError'),
  AGENT_CHAT_PROTOCOL_ERROR: localizedMessage('agent.chat.state.protocolError'),
  AGENT_CHAT_TRUNCATED: localizedMessage('agent.chat.state.truncated'),
  AGENT_CHAT_LIMIT: localizedMessage('agent.chat.state.limitReached'),
  AGENT_CHAT_TOOLS_UNSUPPORTED: localizedMessage('agent.chat.state.unauthorizedTool'),
  AGENT_CHAT_INSPECTION_UNAVAILABLE: localizedMessage('agent.chat.state.inspectionUnavailable'),
  AGENT_CHAT_REASONING_UNSUPPORTED: localizedMessage('agent.chat.state.reasoningUnsupported'),
  AGENT_EDIT_VALIDATION: localizedMessage('agent.chat.state.editValidation'),
  AGENT_EDIT_NOT_FOUND: localizedMessage('agent.chat.state.editTargetNotFound'),
  AGENT_EDIT_CONFLICT: localizedMessage('agent.chat.state.editRevisionConflict'),
  AGENT_EDIT_STORAGE_LIMIT: localizedMessage('agent.chat.state.proposalStorageFull'),
  AGENT_EDIT_STORAGE_UNAVAILABLE: localizedMessage('agent.chat.state.proposalStorageUnavailable'),
  AGENT_CHAT_EDIT_UNAVAILABLE: localizedMessage('agent.chat.state.editScopeUnavailable'),
  AGENT_CHAT_EDIT_CONFLICT: localizedMessage('agent.chat.state.editTargetChanged'),
  AGENT_CHAT_PROVIDER_ERROR: localizedMessage('agent.chat.state.providerError'),
}[code] || localizedMessage('agent.chat.state.incompleteFallback'));

export function agentChatPromptIssueDescriptor(message) {
  if (typeof message !== 'string' || !message.trim()) return localizedMessage('agent.chat.state.promptRequired');
  if (bytes(message) > AGENT_CHAT_PROMPT_BYTES) return localizedMessage('agent.chat.state.promptByteLimit');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(message)) return localizedMessage('agent.chat.state.promptControlCharacters');
  return null;
}
