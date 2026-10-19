import { message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { safeAgentAuthorizationSnapshot, agentAuthorizationKey, agentAuthorizationReceiptSchema } from './agent-authorization-state.ts';
import type { AgentAuthorizationSnapshot } from '../../../packages/contracts/src/agent-authorization.ts';
import { AGENT_PROTOCOLS, deriveAgentEndpoint, agentProtocolConfiguration, agentConfigurationEqual, isAgentProtocol, safeAgentSettings } from './agent-settings.ts';
import type { AgentConfiguration, AgentProtocolConfiguration, AgentSettingsSnapshot } from './agent-settings.ts';

import { AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT, agentTimelineGainAvailable, safeAgentTimelineGainPolicy, safeAgentTimelineGainTarget, agentTimelineGainTargetPatch, agentTimelineAvailable, safeAgentTimelinePolicy, safeAgentTimelineTarget, agentEditAvailable, safeAgentEditPolicy, safeAgentEditTarget, agentEditTargetKey, agentInspectionAvailable, agentRunContextMode, agentRunProvenanceEqual, agentRunActivityCompatible, safeAgentInspectionPolicy, safeAgentRunInspection, agentChatOutboundConsent } from './agent-tool-state.ts';
export { AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT, agentTimelineGainAvailable, safeAgentTimelineGainPolicy, safeAgentTimelineGainTarget, agentTimelineGainTargetPatch, agentTimelineAvailable, safeAgentTimelinePolicy, safeAgentTimelineTarget, agentEditAvailable, safeAgentEditTarget, agentEditTargetKey, agentInspectionAvailable, agentRunContextMode } from './agent-tool-state.ts';
export { AGENT_PROTOCOLS, deriveAgentEndpoint };

export interface AgentChatConfiguration extends AgentProtocolConfiguration { model: string }
export interface AgentChatRun {
  id: string;
  requestId: string;
  threadId: string;
  projectId: string;
  status: string;
  userText: string;
  assistantText: string;
  configuration: AgentChatConfiguration;
  createdAt: string;
  updatedAt: string;
  lastEventId: number;
  error?: { code: string };
  [key: string]: unknown;
}
export interface AgentChatRunEnvelope { instanceId: string; threadId: string; projectId: string; revision: number; run: AgentChatRun }
export interface AgentChatHistoryPage { instanceId: string; threadId: string; projectId: string; revision: number; runs: AgentChatRun[]; historyCursor: string | null }
export interface AgentChatSnapshot {
  instanceId: string;
  threadId: string;
  projectId: string;
  revision: number;
  scope: string;
  inspection: unknown;
  edit: unknown;
  timelineEdit?: unknown;
  timelineGainEdit?: unknown;
  authorization: AgentAuthorizationSnapshot;
  persistence: 'local_database';
  mode: string;
  settings: AgentSettingsSnapshot;
  runs: AgentChatRun[];
  historyCursor: string | null;
}
export interface AgentChatEditTarget { projectId?: string; shotId: string; expectedRevision: number; title: string; prompt: string; [key: string]: unknown }
export interface AgentChatTimelineTarget {
  projectId?: string; timelineId?: string; clipId?: string; trackId?: string; expectedRevision?: number;
  clipName?: string; trackName?: string; trackKind?: string; fps?: number; width?: number; height?: number;
  startFrame?: number; endFrame?: number; durationFrames?: number; timelineDurationFrames?: number;
  occupiedIntervals?: readonly { startFrame: number; endFrame: number }[];
  [key: string]: unknown;
}
export interface AgentChatPending { requestId: string; userText?: string; configuration?: AgentConfiguration; contextMode?: string; editTarget?: unknown }
export interface AgentChatHistoryState { phase: 'closed' | 'loading' | 'ready' | 'error'; page: AgentChatHistoryPage | null; before: string | null; trail: (string | null)[]; message: string; displayMessage: DisplayMessage | null }
export interface AgentChatState {
  phase: 'loading' | 'ready' | 'streaming' | 'detached' | 'unknown' | 'load_error' | 'submitting' | 'stopping' | 'closed';
  snapshot: AgentChatSnapshot | null;
  draft: string;
  contextMode: string;
  editTarget: AgentChatEditTarget | null;
  timelineTarget: AgentChatTimelineTarget | null;
  timelineBlockedReason: string;
  timelineGainTarget: AgentChatTimelineTarget | null;
  timelineGainBlockedReason: string;
  consent: string | null;
  authorizing: boolean;
  message: string;
  displayMessage: DisplayMessage | null;
  sessionLost: boolean;
  pending: AgentChatPending | null;
  abandonRequest: string | null;
  recoveredRun: AgentChatRun | null;
  history: AgentChatHistoryState;
}
export interface AgentChatEvent { id: number; type: string; instanceId: string; threadId: string; projectId: string; runId: string; revision: number; text?: string; run?: AgentChatRun }
export interface AgentChatFrame { id: string; type: string; data: unknown }
export interface AgentChatReceipt { instanceId: string; requestId?: string }
export interface AgentChatReceipts {
  get: (projectId: string) => AgentChatReceipt | null;
  set: (projectId: string, value: AgentChatReceipt) => void;
}
export interface AgentChatClient {
  authorize: (snapshot: AgentChatSnapshot, scope: string, requestId: string, signal?: AbortSignal) => Promise<unknown>;
  read: (projectId: string, signal?: AbortSignal) => Promise<unknown>;
  lookup: (projectId: string, requestId: string, signal?: AbortSignal) => Promise<unknown>;
  history: (projectId: string, before: string | null, signal?: AbortSignal) => Promise<unknown>;
  start: (projectId: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
  run: (projectId: string, runId: string, instanceId: string, signal?: AbortSignal) => Promise<unknown>;
  stop: (projectId: string, runId: string, instanceId: string, signal?: AbortSignal) => Promise<unknown>;
  stream: (projectId: string, runId: string, instanceId: string, after: number, options: { signal?: AbortSignal; onEvent: (event: AgentChatEvent) => void }) => Promise<void>;
}
export interface AgentChatSessionOptions {
  projectId: string;
  client?: AgentChatClient;
  receipts?: AgentChatReceipts;
  requestId?: () => string;
  onChange?: (state: AgentChatState) => void;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const failureCode = (error: unknown): string | undefined => record(error) && typeof error.code === 'string' ? error.code : undefined;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const bytes = (value: string): number => new TextEncoder().encode(value).length;
const statuses: ReadonlySet<string> = new Set(['running', 'completed', 'stopped', 'failed', 'interrupted']);
export const AGENT_CHAT_PROMPT_BYTES = 8192;
export const AGENT_CHAT_OUTPUT_BYTES = 128 * 1024;
const MAX_RUNS = 16, MAX_FRAME = 1024 * 1024, MAX_HISTORY_CURSORS = 32;
const codes: ReadonlySet<string> = new Set(['UNAUTHORIZED', 'AGENT_CHAT_STORAGE_LIMIT', 'AGENT_CHAT_STORAGE_UNAVAILABLE', 'AGENT_CHAT_INTERRUPTED', 'AGENT_CHAT_SESSION_EXPIRED', 'AGENT_CHAT_CONVERSATION_CONFLICT', 'AGENT_CHAT_SETTINGS_CONFLICT', 'AGENT_CHAT_CONSENT_REQUIRED', 'AGENT_CHAT_ACTIVE_RUN', 'AGENT_CHAT_IDEMPOTENCY_CONFLICT', 'AGENT_CHAT_RUN_EXPIRED', 'AGENT_CHAT_NOT_FOUND', 'AGENT_CHAT_BUSY', 'AGENT_CHAT_CLOSED', 'AGENT_CHAT_CREDENTIAL_UNAVAILABLE', 'AGENT_CHAT_VALIDATION', 'AGENT_CHAT_LIMIT', 'AGENT_CHAT_PROFILE_UNSUPPORTED', 'AGENT_CHAT_KEY_REQUIRED', 'AGENT_CHAT_NETWORK_DENIED', 'AGENT_CHAT_CONNECT_FAILED', 'AGENT_CHAT_TIMEOUT', 'AGENT_CHAT_ABORTED', 'AGENT_CHAT_HTTP_ERROR', 'AGENT_CHAT_PROTOCOL_ERROR', 'AGENT_CHAT_TRUNCATED', 'AGENT_CHAT_TOOLS_UNSUPPORTED', 'AGENT_CHAT_INSPECTION_UNAVAILABLE', 'AGENT_CHAT_REASONING_UNSUPPORTED', 'AGENT_CHAT_PROVIDER_ERROR', 'AGENT_CHAT_EDIT_UNAVAILABLE', 'AGENT_CHAT_EDIT_CONFLICT', 'AGENT_CHAT_EDIT_NOT_FOUND', 'AGENT_CHAT_EDIT_INVALID', 'AGENT_CHAT_EDIT_STALE', 'AGENT_CHAT_EDIT_RUN_INCOMPLETE', 'AGENT_EDIT_VALIDATION', 'AGENT_EDIT_NOT_FOUND', 'AGENT_EDIT_CONFLICT', 'AGENT_EDIT_RUN_INCOMPLETE', 'AGENT_EDIT_STORAGE_LIMIT', 'AGENT_EDIT_STORAGE_UNAVAILABLE']);
const failure = (code: unknown): Error => Object.assign(new Error('Agent chat request did not complete.'), { code: typeof code === 'string' && (codes.has(code) || ['NETWORK', 'INVALID_RESPONSE'].includes(code)) ? code : 'NETWORK' });

const errorTexts: Record<string, string> = {
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
};
export const agentChatErrorText = (code: string): string => Object.hasOwn(errorTexts, code) ? errorTexts[code] : '回复未完成。已保留收到的文字；不会自动重新发送。';

const descriptorKeys: Record<string, Parameters<typeof localizedMessage>[0]> = {
  UNAUTHORIZED: 'agent.chat.state.unauthorized',
  AGENT_CHAT_SESSION_EXPIRED: 'agent.chat.state.sessionExpired',
  AGENT_CHAT_STORAGE_LIMIT: 'agent.chat.state.storageFull',
  AGENT_CHAT_STORAGE_UNAVAILABLE: 'agent.chat.state.storageUnavailable',
  AGENT_CHAT_INTERRUPTED: 'agent.chat.state.interrupted',
  AGENT_CHAT_SETTINGS_CONFLICT: 'agent.chat.state.settingsConflict',
  AGENT_CHAT_CONVERSATION_CONFLICT: 'agent.chat.state.conversationConflict',
  AGENT_CHAT_CONSENT_REQUIRED: 'agent.chat.state.consentChanged',
  AGENT_CHAT_ACTIVE_RUN: 'agent.chat.state.activeRun',
  AGENT_CHAT_CREDENTIAL_UNAVAILABLE: 'agent.chat.state.credentialUnavailable',
  AGENT_CHAT_BUSY: 'agent.chat.state.busy',
  AGENT_CHAT_RUN_EXPIRED: 'agent.chat.state.runExpired',
  AGENT_CHAT_NOT_FOUND: 'agent.chat.state.runNotFound',
  AGENT_CHAT_CLOSED: 'agent.chat.state.serviceClosed',
  AGENT_CHAT_VALIDATION: 'agent.chat.state.validation',
  AGENT_CHAT_PROFILE_UNSUPPORTED: 'agent.chat.state.unsupportedProfile',
  AGENT_CHAT_KEY_REQUIRED: 'agent.chat.state.keyRequired',
  AGENT_CHAT_NETWORK_DENIED: 'agent.chat.state.networkDenied',
  AGENT_CHAT_CONNECT_FAILED: 'agent.chat.state.connectionFailed',
  AGENT_CHAT_TIMEOUT: 'agent.chat.state.timeout',
  AGENT_CHAT_ABORTED: 'agent.chat.state.aborted',
  AGENT_CHAT_HTTP_ERROR: 'agent.chat.state.httpError',
  AGENT_CHAT_PROTOCOL_ERROR: 'agent.chat.state.protocolError',
  AGENT_CHAT_TRUNCATED: 'agent.chat.state.truncated',
  AGENT_CHAT_LIMIT: 'agent.chat.state.limitReached',
  AGENT_CHAT_TOOLS_UNSUPPORTED: 'agent.chat.state.unauthorizedTool',
  AGENT_CHAT_INSPECTION_UNAVAILABLE: 'agent.chat.state.inspectionUnavailable',
  AGENT_CHAT_REASONING_UNSUPPORTED: 'agent.chat.state.reasoningUnsupported',
  AGENT_EDIT_VALIDATION: 'agent.chat.state.editValidation',
  AGENT_EDIT_NOT_FOUND: 'agent.chat.state.editTargetNotFound',
  AGENT_EDIT_CONFLICT: 'agent.chat.state.editRevisionConflict',
  AGENT_EDIT_STORAGE_LIMIT: 'agent.chat.state.proposalStorageFull',
  AGENT_EDIT_STORAGE_UNAVAILABLE: 'agent.chat.state.proposalStorageUnavailable',
  AGENT_CHAT_EDIT_UNAVAILABLE: 'agent.chat.state.editScopeUnavailable',
  AGENT_CHAT_EDIT_CONFLICT: 'agent.chat.state.editTargetChanged',
  AGENT_CHAT_PROVIDER_ERROR: 'agent.chat.state.providerError',
};
// Display-only companions keep legacy diagnostics and business identities unchanged.
export const agentChatErrorDescriptor = (code: string): DisplayMessage => localizedMessage(Object.hasOwn(descriptorKeys, code) ? descriptorKeys[code] : 'agent.chat.state.incompleteFallback');

function boundedText(value: unknown, max: number): string { if (typeof value !== 'string' || bytes(value) > max) throw failure('INVALID_RESPONSE'); return value; }
function identity(value: unknown, projectId: string, instanceId?: string | null, threadId?: string | null): asserts value is Record<string, unknown> {
  if (!record(value) || !uuid(value.instanceId) || !uuid(value.threadId) || typeof value.projectId !== 'string' || value.projectId !== projectId || !integer(value.revision) || (instanceId && value.instanceId !== instanceId) || (threadId && value.threadId !== threadId)) throw failure('INVALID_RESPONSE');
}
export function safeAgentChatRun(value: unknown, projectId: string, threadId?: string | null): AgentChatRun {
  if (!record(value) || !uuid(value.id) || !uuid(value.requestId) || !uuid(value.threadId) || (threadId && value.threadId !== threadId) || value.projectId !== projectId || typeof value.status !== 'string' || !statuses.has(value.status) || !integer(value.lastEventId) || !record(value.configuration) || !['presetId', 'platformId', 'baseUrl', 'model', 'protocol'].every(key => typeof (value.configuration as Record<string, unknown>)[key] === 'string') || !isAgentProtocol(value.configuration.protocol)) throw failure('INVALID_RESPONSE');
  const configuration = Object.freeze(agentProtocolConfiguration(value.configuration));
  if (!configuration) throw failure('INVALID_RESPONSE');
  const protocolConfiguration: AgentChatConfiguration = configuration;
  try { deriveAgentEndpoint(configuration); } catch { throw failure('INVALID_RESPONSE'); }
  if (configuration.baseUrl.length > 2048 || configuration.model.length > 200 || configuration.presetId.length > 100 || configuration.platformId.length > 100) throw failure('INVALID_RESPONSE');
  const errorCode = record(value.error) && typeof value.error.code === 'string' ? value.error.code : undefined;
  return { id: value.id, requestId: value.requestId, threadId: value.threadId, projectId, status: value.status,
    userText: boundedText(value.userText, AGENT_CHAT_PROMPT_BYTES), assistantText: boundedText(value.assistantText, AGENT_CHAT_OUTPUT_BYTES),
    configuration: protocolConfiguration, ...(safeAgentRunInspection(value, projectId) as Record<string, unknown>), createdAt: typeof value.createdAt === 'string' ? value.createdAt.slice(0, 40) : '', updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt.slice(0, 40) : '', lastEventId: value.lastEventId,
    ...(value.error ? { error: { code: errorCode && codes.has(errorCode) ? errorCode : 'NETWORK' } } : {}) };
}
function safeRuns(value: Record<string, unknown>, projectId: string): AgentChatRun[] {
  if (!Array.isArray(value.runs) || value.runs.length > MAX_RUNS) throw failure('INVALID_RESPONSE');
  const threadId = typeof value.threadId === 'string' ? value.threadId : '';
  const runs = value.runs.map(run => safeAgentChatRun(run, projectId, threadId));
  if (new Set(runs.map(run => run.id)).size !== runs.length || new Set(runs.map(run => run.requestId)).size !== runs.length || runs.filter(run => run.status === 'running').length > 1) throw failure('INVALID_RESPONSE');
  if (value.historyCursor !== null && (!uuid(value.historyCursor) || value.historyCursor !== runs[0]?.id)) throw failure('INVALID_RESPONSE');
  return runs;
}
export function safeAgentChatSnapshot(value: unknown, projectId: string): AgentChatSnapshot {
  identity(value, projectId);
  if (typeof value.scope !== 'string' || !['chat_only', 'chat_and_project_inspection', 'chat_and_reviewed_shot_edits', 'chat_and_reviewed_timeline_edits'].includes(value.scope) || value.persistence !== 'local_database' || typeof value.mode !== 'string' || !['provider', 'simulated'].includes(value.mode)) throw failure('INVALID_RESPONSE');
  const runs = safeRuns(value, projectId);
  const inspection = value.inspection == null ? null : safeAgentInspectionPolicy(value.inspection);
  const edit = value.edit == null ? null : safeAgentEditPolicy(value.edit);
  const timelineEdit = value.timelineEdit == null ? null : safeAgentTimelinePolicy(value.timelineEdit);
  const timelineGainEdit = value.timelineGainEdit == null ? null : safeAgentTimelineGainPolicy(value.timelineGainEdit);
  let authorization: AgentAuthorizationSnapshot;try{authorization=safeAgentAuthorizationSnapshot(value.authorization);}catch{throw failure('INVALID_RESPONSE');}
  return { instanceId: value.instanceId as string, threadId: value.threadId as string, projectId, revision: value.revision as number, scope: value.scope, inspection, edit, ...(timelineEdit ? { timelineEdit } : {}), ...(timelineGainEdit ? { timelineGainEdit } : {}), authorization, persistence: 'local_database', mode: value.mode, settings: safeAgentSettings(value.settings), runs, historyCursor: typeof value.historyCursor === 'string' ? value.historyCursor : null };
}
export function safeAgentChatHistory(value: unknown, projectId: string, instanceId: string | null, threadId: string | null, before: string | null): AgentChatHistoryPage {
  identity(value, projectId, instanceId, threadId);
  const runs = safeRuns(value, projectId);
  if (runs.some(run => run.status === 'running' || run.id === before) || value.historyCursor === before) throw failure('INVALID_RESPONSE');
  return { instanceId: value.instanceId as string, threadId: value.threadId as string, projectId, revision: value.revision as number, runs, historyCursor: typeof value.historyCursor === 'string' ? value.historyCursor : null };
}
function safeRunEnvelope(value: unknown, projectId: string, instanceId?: string | null, threadId?: string | null): AgentChatRunEnvelope {
  identity(value, projectId, instanceId, threadId);
  return { instanceId: value.instanceId as string, threadId: value.threadId as string, projectId, revision: value.revision as number, run: safeAgentChatRun(value.run, projectId, typeof value.threadId === 'string' ? value.threadId : null) };
}
export function safeAgentChatEvent(value: unknown, frame: AgentChatFrame, projectId: string, instanceId: string, runId: string, threadId: string): AgentChatEvent {
  identity(value, projectId, instanceId, threadId);
  if (!integer(value.id) || value.id < 1 || String(value.id) !== frame.id || value.type !== frame.type || value.runId !== runId || typeof value.type !== 'string' || !['snapshot', 'delta', 'terminal'].includes(value.type)) throw failure('INVALID_RESPONSE');
  const result: AgentChatEvent = { id: value.id, type: value.type, instanceId, threadId: value.threadId as string, projectId, runId, revision: value.revision as number };
  if (value.type === 'delta') result.text = boundedText(value.text, AGENT_CHAT_OUTPUT_BYTES);
  else { result.run = safeAgentChatRun(value.run, projectId, typeof value.threadId === 'string' ? value.threadId : null); const run = result.run; if (run.id !== runId || run.lastEventId !== value.id || (value.type === 'terminal' && run.status === 'running')) throw failure('INVALID_RESPONSE'); }
  return result;
}

// EventSource cannot surface HTTP failures reliably. This parser uses a bounded,
// authenticated fetch stream and treats every reconnect as a read, never a POST.
export async function readAgentChatSSE(body: ReadableStream<Uint8Array> | null | undefined, onFrame: (frame: AgentChatFrame) => void, signal?: AbortSignal): Promise<void> {
  if (!body || typeof body.getReader !== 'function') throw failure('INVALID_RESPONSE');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', frame = { id: '', type: '', data: [] as string[] }, frameBytes = 0;
  const line = (value: string): void => {
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
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        // A CR at a chunk boundary might be half of CRLF.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        line(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
        if (signal?.aborted) return;
      }
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

export function createAgentChatClient({ fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init), timeoutMs = 12000 }: { fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; timeoutMs?: number } = {}): AgentChatClient {
  const path = (projectId: string): string => `/api/agent/chat/${encodeURIComponent(projectId)}`;
  async function json(url: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (): void => abort.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const work = (async () => {
      const response = await fetchImpl(url, { method, credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      let envelope: unknown;
      try { envelope = await response.json(); } catch { throw failure('INVALID_RESPONSE'); }
      const envelopeRecord = record(envelope) ? envelope : {}, errorRecord = record(envelopeRecord.error) ? envelopeRecord.error : {};
      if (!response.ok || envelopeRecord.ok !== true) throw failure(response.status === 401 ? 'UNAUTHORIZED' : errorRecord.code);
      return envelopeRecord.data;
    })();
    try { return await Promise.race([work, new Promise<never>((_, reject) => {
      if (timeoutMs > 0) timer = setTimeout(() => { abort.abort(); reject(failure('NETWORK')); }, timeoutMs);
      abort.signal.addEventListener('abort', () => reject(failure('NETWORK')), { once: true });
      if (abort.signal.aborted) reject(failure('NETWORK'));
    })]); } catch (error) { throw failure(failureCode(error)); }
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
    history: async (projectId, before, signal) => safeAgentChatHistory(await json(`${path(projectId)}/history?before=${encodeURIComponent(before ?? '')}`, 'GET', undefined, signal), projectId, null, null, before),
    start: async (projectId, input, signal) => safeRunEnvelope(await json(`${path(projectId)}/runs`, 'POST', input, signal), projectId, record(input) && typeof input.instanceId === 'string' ? input.instanceId : null),
    run: async (projectId, runId, instanceId, signal) => safeRunEnvelope(await json(`${path(projectId)}/runs/${encodeURIComponent(runId)}?instanceId=${encodeURIComponent(instanceId)}`, 'GET', undefined, signal), projectId, instanceId),
    stop: async (projectId, runId, instanceId, signal) => safeRunEnvelope(await json(`${path(projectId)}/runs/${encodeURIComponent(runId)}/stop`, 'POST', { instanceId }, signal), projectId, instanceId),
    async stream(projectId, runId, instanceId, after, { signal, onEvent }) {
      try {
        const response = await fetchImpl(`${path(projectId)}/runs/${encodeURIComponent(runId)}/events?instanceId=${encodeURIComponent(instanceId)}&after=${after}`, { credentials: 'same-origin', cache: 'no-store', signal, headers: { Accept: 'text/event-stream' } });
        if (!response.ok) { let result: unknown; try { result = await response.json(); } catch {} const errorRecord = record(result) && record(result.error) ? result.error : {}; throw failure(response.status === 401 ? 'UNAUTHORIZED' : errorRecord.code); }
        if (!response.headers?.get('content-type')?.includes('text/event-stream')) throw failure('INVALID_RESPONSE');
        await readAgentChatSSE(response.body, frame => onEvent(safeAgentChatEvent(frame.data, frame, projectId, instanceId, runId, typeof frame.id === 'string' ? frame.id : '')), signal);
      } catch (error) { throw failure(failureCode(error)); }
    },
  };
}

const receiptsKey = 'mioon.agent-chat.receipts.v1';
const fallbackReceipts = new Map<string, AgentChatReceipt>();
// Only non-secret identities are stored, never prompts, responses or settings.
export function createAgentChatReceipts(storage?: Storage): AgentChatReceipts {
  const getStorage = (): Storage | null => { try { return storage === undefined ? globalThis.sessionStorage : storage; } catch { return null; } };
  const readAll = (): Record<string, unknown> => { try { const value: unknown = JSON.parse(getStorage()?.getItem(receiptsKey) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? Object.assign(Object.create(null), value) as Record<string, unknown> : Object.create(null) as Record<string, unknown>; } catch { return Object.create(null) as Record<string, unknown>; } };
  return {
    get(projectId: string): AgentChatReceipt | null { const all = readAll(), value: unknown = Object.hasOwn(all, projectId) ? all[projectId] : fallbackReceipts.get(projectId); return record(value) && uuid(value.instanceId) && (!value.requestId || uuid(value.requestId)) ? { instanceId: value.instanceId, ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}) } : null; },
    set(projectId: string, value: AgentChatReceipt): void {
      const safe: AgentChatReceipt = { instanceId: value.instanceId, ...(value.requestId ? { requestId: value.requestId } : {}) };
      fallbackReceipts.delete(projectId); fallbackReceipts.set(projectId, safe);
      while (fallbackReceipts.size > 32) { const oldest = fallbackReceipts.keys().next().value; if (oldest === undefined) break; fallbackReceipts.delete(oldest); }
      const all = readAll(); delete all[projectId]; all[projectId] = safe;
      const bounded = Object.fromEntries(Object.entries(all).slice(-32));
      try { getStorage()?.setItem(receiptsKey, JSON.stringify(bounded)); } catch {}
    },
  };
}
const initialHistoryState = (): AgentChatHistoryState => ({ phase: 'closed', page: null, before: null, trail: [], message: '', displayMessage: null });
export const initialAgentChatState = (): AgentChatState => ({ phase: 'loading', snapshot: null, draft: '', contextMode: AGENT_TYPED_CONTEXT, editTarget: null, timelineTarget: null, timelineBlockedReason: '', timelineGainTarget: null, timelineGainBlockedReason: '', consent: null, authorizing:false, message: '', displayMessage: null, sessionLost: false, pending: null, abandonRequest: null, recoveredRun: null, history: initialHistoryState() });
export const activeAgentChatRun = (state: AgentChatState | null | undefined): AgentChatRun | null => state?.snapshot?.runs.find(run => run.status === 'running') || null;
export function agentChatConsentKey(snapshot: AgentChatSnapshot | null | undefined, contextMode = AGENT_TYPED_CONTEXT, editTarget?: unknown): string | null {
  if (!snapshot) return null;
  const configuration = snapshot.settings?.configuration;
  try { const consent = agentChatOutboundConsent(snapshot, contextMode, deriveAgentEndpoint(configuration), editTarget); return consent ? agentAuthorizationKey(configuration, contextMode) : null; } catch { return null; }
}
export function agentChatPromptIssue(message: unknown): string {
  if (typeof message !== 'string' || !message.trim()) return '请输入消息。';
  if (bytes(message) > AGENT_CHAT_PROMPT_BYTES) return '消息最多 8192 UTF-8 字节，请缩短后发送。';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(message)) return '消息包含不支持的控制字符。';
  return '';
}
export const agentChatCurrentTarget = (state: AgentChatState | null | undefined): unknown => state?.contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? state.timelineGainTarget : state?.contextMode === AGENT_TIMELINE_CONTEXT ? state.timelineTarget : state?.editTarget;
export const agentChatCanSend = (state: AgentChatState | null | undefined): boolean => Boolean(state?.snapshot && state.phase === 'ready' && !state.pending && !activeAgentChatRun(state) && state.consent !== null && state.consent === agentChatConsentKey(state.snapshot, state.contextMode, agentChatCurrentTarget(state)) && state.snapshot.settings.configuration.baseUrl && state.snapshot.settings.configuration.model && !agentChatPromptIssue(state.draft) && !((state.contextMode === AGENT_TIMELINE_CONTEXT && state.timelineBlockedReason || state.contextMode === AGENT_TIMELINE_GAIN_CONTEXT && state.timelineGainBlockedReason)));

/** One immutable project/chat-page lifetime. Disposing detaches reads only. */
export function createAgentChatSession({ projectId, client = createAgentChatClient(), receipts = createAgentChatReceipts(), requestId = () => globalThis.crypto.randomUUID(), onChange = () => {} }: AgentChatSessionOptions) {
  let active = true, visible = true, state = initialAgentChatState(), streamAbort: AbortController | null = null, serial = 0, historySerial = 0, historyAbort: AbortController | null = null;
  const pendingReads = new Set<AbortController>();
  const publish = (patch: Partial<AgentChatState>): void => { if (active) { state = { ...state, ...patch };state.consent=visible&&((state.snapshot?.authorization?.scopes as readonly string[] | undefined)?.includes(state.contextMode) ?? false)?agentChatConsentKey(state.snapshot,state.contextMode,agentChatCurrentTarget(state)):null;onChange(state); } };
  const detach = (): void => { serial++; streamAbort?.abort(); streamAbort = null; };
  const request = async <T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> => { const abort = new AbortController(); pendingReads.add(abort); try { return await action(abort.signal); } finally { pendingReads.delete(abort); } };
  const valid = (epoch: number): boolean => active && epoch === serial;
  const receipt = (value: AgentChatReceipt): void => { if (active) receipts.set(projectId, value); };
  const resetHistory = (): void => { historySerial++; historyAbort?.abort(); historyAbort = null; };
  const sameRun = (previous: AgentChatRun | undefined, next: AgentChatRun): boolean => !previous || ((previous.status === 'running' || previous.status === next.status) && previous.threadId === next.threadId && agentConfigurationEqual(previous.configuration, next.configuration) && previous.requestId === next.requestId && previous.userText === next.userText && agentRunProvenanceEqual(previous, next) && agentRunActivityCompatible(previous, next));
  const mergeRun = (envelopeValue: unknown): AgentChatSnapshot => {
    const envelope = safeRunEnvelope(envelopeValue, projectId, state.snapshot?.instanceId, state.snapshot?.threadId);
    if (!state.snapshot || envelope.instanceId !== state.snapshot.instanceId || envelope.projectId !== projectId || envelope.revision < state.snapshot.revision) throw failure('INVALID_RESPONSE');
    const snapshot = state.snapshot;
    const previous = snapshot.runs.find(run => run.id === envelope.run.id);
    if (!sameRun(previous, envelope.run)) throw failure('INVALID_RESPONSE');
    const runs = previous ? snapshot.runs.map(run => run.id === envelope.run.id ? envelope.run : run) : [...snapshot.runs, envelope.run];
    const bounded = runs.slice(-MAX_RUNS);
    return { ...snapshot, revision: envelope.revision, runs: bounded, historyCursor: runs.length > MAX_RUNS ? (bounded[0]?.id ?? snapshot.historyCursor) : snapshot.historyCursor };
  };
  const finishState = (snapshot: AgentChatSnapshot): Partial<AgentChatState> => ({ snapshot, phase: activeAgentChatRun({ snapshot } as AgentChatState) ? 'streaming' : 'ready', consent: null });
  async function recoverStream(runId: string, instanceId: string, epoch: number): Promise<void> {
    try {
      const envelope = await request(signal => client.run(projectId, runId, instanceId, signal));
      if (!valid(epoch)) return;
      const snapshot = mergeRun(envelope);
      const run = safeRunEnvelope(envelope, projectId, state.snapshot?.instanceId, state.snapshot?.threadId).run;
      publish({ snapshot, phase: run.status === 'running' ? 'detached' : 'ready', consent: null, message: run.status === 'running' ? '连接已中断，回复可能仍在继续。重新读取只恢复显示，不会重复发送。' : '', displayMessage: run.status === 'running' ? localizedMessage('agent.chat.state.displayDetached') : null });
    } catch (error) {
      if (!valid(epoch)) return;
      if (failureCode(error) === 'AGENT_CHAT_SESSION_EXPIRED') { await load(); return; }
      publish({ phase: 'unknown', consent: null, message: '暂时无法确认运行状态。已收到的文字保留；只会读取状态，不会重新发送。', displayMessage: localizedMessage('agent.chat.state.runStateUnknown') });
    }
  }
  function attach(run: AgentChatRun): void {
    if (!active || run.status !== 'running' || !state.snapshot) return;
    if (!visible) { publish({ phase: 'detached' }); return; }
    detach(); const epoch = serial, instanceId = state.snapshot.instanceId;
    const abort = new AbortController(); streamAbort = abort;
    publish({ phase: 'streaming' });
    void (async () => {
      try {
        await client.stream(projectId, run.id, instanceId, run.lastEventId, { signal: abort.signal, onEvent: (event: AgentChatEvent) => {
          const snapshot = state.snapshot;
          if (!valid(epoch) || abort.signal.aborted || !snapshot || event.instanceId !== instanceId || event.projectId !== projectId || event.threadId !== snapshot.threadId || event.runId !== run.id) return;
          const previous = snapshot.runs.find(item => item.id === run.id);
          if (!previous || event.id <= previous.lastEventId) return;
          if (event.revision < snapshot.revision || (event.type === 'delta' && event.id !== previous.lastEventId + 1)) throw failure('INVALID_RESPONSE');
          const next = event.type === 'delta' ? { ...previous, assistantText: boundedText(previous.assistantText + (event.text ?? ''), AGENT_CHAT_OUTPUT_BYTES), lastEventId: event.id } : event.run;
          if (!next) throw failure('INVALID_RESPONSE');
          const merged = mergeRun({ instanceId, threadId: snapshot.threadId, projectId, revision: event.revision, run: next });
          publish({ snapshot: merged, phase: next.status === 'running' ? 'streaming' : 'ready', consent: null, message: '', displayMessage: null });
          if (next.status !== 'running') abort.abort();
        } });
      } catch { /* Read the canonical run after an incomplete stream. */ }
      if (valid(epoch) && !abort.signal.aborted && activeAgentChatRun(state)) await recoverStream(run.id, instanceId, epoch);
    })();
  }
  async function load(): Promise<boolean> {
    if (!active || ['submitting', 'stopping'].includes(state.phase)) return false;
    detach(); resetHistory(); const epoch = serial;
    publish({ phase: 'loading', consent: null, abandonRequest: null, history: initialHistoryState() });
    try {
      let snapshot = safeAgentChatSnapshot(await request(signal => client.read(projectId, signal)), projectId);
      if (!valid(epoch)) return false;
      const previousSnapshot = state.snapshot;
      if (previousSnapshot && (previousSnapshot.threadId !== snapshot.threadId || snapshot.revision < previousSnapshot.revision)) throw failure('INVALID_RESPONSE');
      for (const run of snapshot.runs) {
        if (!sameRun(previousSnapshot?.runs.find(item => item.id === run.id), run)) throw failure('INVALID_RESPONSE');
      }
      const previous = receipts.get(projectId), sessionLost = Boolean(previous && previous.instanceId !== snapshot.instanceId);
      const requestPending = state.pending?.requestId || previous?.requestId;
      publish({ snapshot, ...((state.contextMode === AGENT_PROJECT_CONTEXT && !agentInspectionAvailable(snapshot) || state.contextMode === AGENT_EDIT_CONTEXT && !agentEditAvailable(snapshot) || state.contextMode === AGENT_TIMELINE_CONTEXT && !agentTimelineAvailable(snapshot) || state.contextMode === AGENT_TIMELINE_GAIN_CONTEXT && !agentTimelineGainAvailable(snapshot)) ? { contextMode: AGENT_TYPED_CONTEXT } : {}), sessionLost: sessionLost || state.sessionLost, pending: requestPending ? (state.pending || { requestId: requestPending }) : null, recoveredRun: null });
      const publishedSnapshot = state.snapshot;
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
            for (const run of snapshot.runs) if (!sameRun(publishedSnapshot?.runs.find(item => item.id === run.id), run)) throw failure('INVALID_RESPONSE');
            const latest = snapshot.runs.find(run => run.id === (accepted as AgentChatRun).id);
            if (!sameRun(accepted, latest || accepted)) throw failure('INVALID_RESPONSE');
            accepted = latest || accepted;
          }
        } catch (error) {
          if (!valid(epoch)) return false;
          if (failureCode(error) !== 'AGENT_CHAT_NOT_FOUND') throw error;
        }
      }
      const acceptedRun = accepted || undefined;
      if (acceptedRun?.status === 'running' && !snapshot.runs.some(run => run.id === acceptedRun.id)) throw failure('INVALID_RESPONSE');
      if (acceptedRun && !sameRun(snapshot.runs.find(run => run.id === acceptedRun.id), acceptedRun)) throw failure('INVALID_RESPONSE');
      if (acceptedRun && (acceptedRun.requestId !== requestPending || (state.pending?.configuration && (!agentConfigurationEqual(acceptedRun.configuration, state.pending.configuration) || acceptedRun.userText !== state.pending.userText || agentRunContextMode(acceptedRun) !== state.pending.contextMode || ([AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(state.pending.contextMode ?? '') && agentEditTargetKey((acceptedRun as AgentChatRun).editTarget) !== agentEditTargetKey(state.pending.editTarget)))))) throw failure('INVALID_RESPONSE');
      const unresolved = requestPending && !acceptedRun;
      receipt({ instanceId: snapshot.instanceId, ...(unresolved && requestPending ? { requestId: requestPending } : {}) });
      const clearDraft = acceptedRun && state.pending?.userText === state.draft;
      publish({ ...finishState(snapshot), sessionLost: sessionLost || state.sessionLost, pending: unresolved ? (state.pending || { requestId: requestPending as string }) : null,
        recoveredRun: acceptedRun && !snapshot.runs.some(run => run.id === acceptedRun.id) ? acceptedRun : null,
        ...(clearDraft ? { draft: '' } : {}),
        phase: unresolved ? 'unknown' : activeAgentChatRun({ snapshot } as AgentChatState) ? 'streaming' : 'ready',
        message: unresolved ? '未收到发送确认，尚未找到原请求。查不到不能证明请求未被接受；待确认标识在当前页面会话内保留，后端重启后仍可核对。请重新读取，不会自动重发，远端仍可能已计算或计费。' : sessionLost ? agentChatErrorText('AGENT_CHAT_SESSION_EXPIRED') : acceptedRun ? '已读取原请求并确认其保存状态，没有重新发送。' : '', displayMessage: unresolved ? localizedMessage('agent.chat.state.unacknowledgedOriginal') : sessionLost ? agentChatErrorDescriptor('AGENT_CHAT_SESSION_EXPIRED') : acceptedRun ? localizedMessage('agent.chat.state.originalConfirmed') : null });
      if (!unresolved) { const running = activeAgentChatRun(state); if (running) attach(running); }
      return true;
    } catch (error) { const code = failureCode(error); if (valid(epoch)) publish({ phase: state.snapshot ? 'unknown' : 'load_error', message: code && ['UNAUTHORIZED', 'AGENT_CHAT_STORAGE_UNAVAILABLE'].includes(code) ? agentChatErrorText(code) : '暂时无法读取或确认对话。草稿与待确认标识保留；重新读取不会发起模型请求。', displayMessage: code && ['UNAUTHORIZED', 'AGENT_CHAT_STORAGE_UNAVAILABLE'].includes(code) ? agentChatErrorDescriptor(code) : localizedMessage('agent.chat.state.conversationReadUnknown'), consent: null }); return false; }
  }
  async function historyPage(before: string | null, trail: (string | null)[]): Promise<boolean> {
    if (!active || !visible || !state.snapshot || !before || !uuid(before) || state.history.phase === 'loading') return false;
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
      const code = failureCode(error);
      if (active && visible && epoch === historySerial && !abort.signal.aborted) publish({ history: { ...state.history, phase: 'error', message: code === 'AGENT_CHAT_STORAGE_UNAVAILABLE' ? agentChatErrorText(code) : '暂时无法读取更早记录。当前回复与草稿仍保留，请返回最近对话后重新读取。', displayMessage: code === 'AGENT_CHAT_STORAGE_UNAVAILABLE' ? agentChatErrorDescriptor(code) : localizedMessage('agent.chat.state.historyReadUnavailable') } });
      return false;
    } finally { pendingReads.delete(abort); if (historyAbort === abort) historyAbort = null; }
  }
  return {
    getState: (): AgentChatState => state, load,
    confirmAbandonPending(value: boolean): boolean {
      if (!active || !visible || state.phase !== 'unknown' || !state.pending || !state.snapshot) return false;
      publish({ abandonRequest: value ? state.pending.requestId : null }); return true;
    },
    abandonPending(id: string): boolean {
      if (!active || !visible || state.phase !== 'unknown' || !state.snapshot || state.pending?.requestId !== id || state.abandonRequest !== id) return false;
      receipt({ instanceId: state.snapshot.instanceId });
      publish({ pending: null, abandonRequest: null, consent: null, phase: activeAgentChatRun(state) ? 'detached' : 'ready', message: '已按你的选择结束本地待确认状态，草稿保留。这不会停止或撤回原请求；再次发送可能造成重复回复或费用，请先核对历史并重新确认。', displayMessage: localizedMessage('agent.chat.state.pendingEnded') });
      return true;
    },
    earlier(): Promise<boolean> {
      const history = state.history;
      return historyPage(history.page ? history.page.historyCursor : state.snapshot?.historyCursor ?? null, history.page ? [...history.trail, history.before] : []);
    },
    newer(): Promise<boolean> { const trail = state.history.trail; return trail.length ? historyPage(trail.at(-1) ?? null, trail.slice(0, -1)) : Promise.resolve(false); },
    closeHistory(): boolean { if (!active || !visible) return false; resetHistory(); publish({ history: initialHistoryState() }); return true; },
    setVisible(value: boolean): void {
      if (!active || visible === Boolean(value)) return;
      visible = Boolean(value);
      if (!visible) { publish({ consent: null }); resetHistory(); if (state.history.phase === 'loading') publish({ history: { ...state.history, phase: state.history.page ? 'ready' : 'closed' } }); streamAbort?.abort(); streamAbort = null; if (state.phase === 'streaming') publish({ phase: 'detached' }); }
      else if (!['submitting', 'stopping'].includes(state.phase)) void load();
    },
    edit(value: unknown): boolean { if (!active || !visible || typeof value !== 'string' || value.length > AGENT_CHAT_PROMPT_BYTES) return false; publish({ draft: value }); return true; },
    setContextMode(value: string): boolean {
      if (!active || !visible || state.phase !== 'ready' || state.pending || activeAgentChatRun(state) || ![AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(value) || (value === AGENT_PROJECT_CONTEXT && !agentInspectionAvailable(state.snapshot)) || (value === AGENT_EDIT_CONTEXT && !agentEditAvailable(state.snapshot)) || (value === AGENT_TIMELINE_CONTEXT && !agentTimelineAvailable(state.snapshot)) || (value === AGENT_TIMELINE_GAIN_CONTEXT && !agentTimelineGainAvailable(state.snapshot))) return false;
      publish({ contextMode: value, consent: null }); return true;
    },
    setEditTarget(value: unknown): boolean {
      if (!active) return false;
      let next: unknown = null; try { if (value) next = safeAgentEditTarget(value, projectId, false); } catch { /* Invalid or oversized saved text cannot be authorized. */ }
      if (agentEditTargetKey(next) === agentEditTargetKey(state.editTarget)) return true;
      publish({ editTarget: next as AgentChatEditTarget | null, consent: null }); return true;
    },
    setTimelineTarget(value: unknown, blockedReason: unknown = ''): boolean {
      if (!active) return false;
      let next: unknown = null; try { if (value) next = safeAgentTimelineTarget(value, projectId); } catch { /* Only exact, bounded saved context is eligible. */ }
      const reason = typeof blockedReason === 'string' ? blockedReason : '请先核对当前时间线状态。';
      if (agentEditTargetKey(next) === agentEditTargetKey(state.timelineTarget) && reason === state.timelineBlockedReason) return true;
      publish({ timelineTarget: next as AgentChatTimelineTarget | null, timelineBlockedReason: reason, consent: null }); return true;
    },
    setTimelineGainTarget(value: unknown, blockedReason: unknown = ''): boolean {
      if (!active) return false;
      const patch = agentTimelineGainTargetPatch(value, projectId, blockedReason) as { timelineGainTarget?: AgentChatTimelineTarget | null; timelineGainBlockedReason?: string };
      if (agentEditTargetKey(patch.timelineGainTarget) === agentEditTargetKey(state.timelineGainTarget) && patch.timelineGainBlockedReason === state.timelineGainBlockedReason) return true;
      publish(patch); return true;
    },
    async approve(value: unknown): Promise<boolean> {
      if(!value||!active||!visible||state.phase!=='ready'||!state.snapshot||state.authorizing)return false;
      const snapshot=state.snapshot,contextMode=state.contextMode,key=agentChatConsentKey(snapshot,contextMode,agentChatCurrentTarget(state));
      if(!key||(contextMode===AGENT_TIMELINE_CONTEXT&&state.timelineBlockedReason||contextMode===AGENT_TIMELINE_GAIN_CONTEXT&&state.timelineGainBlockedReason))return false;
      if((snapshot.authorization.scopes as readonly string[]).includes(contextMode))return true;
      const epoch=serial,approvalRequestId=requestId();publish({authorizing:true});
      try{
        const receiptValue=agentAuthorizationReceiptSchema.parse(await request(signal=>client.authorize(snapshot,contextMode,approvalRequestId,signal)));
        if(!valid(epoch))return false;
        if(receiptValue.operation!=='grant'||receiptValue.requestId!==approvalRequestId||receiptValue.revision!==snapshot.authorization.revision+1||
          !agentConfigurationEqual(state.snapshot?.settings.configuration, snapshot.settings.configuration))throw failure('INVALID_RESPONSE');
        const next: AgentChatSnapshot={...state.snapshot,authorization:{...state.snapshot.authorization,revision:receiptValue.revision,scopes:[...new Set([...(snapshot.authorization.scopes as readonly string[]),contextMode])] as AgentAuthorizationSnapshot['scopes']}};
        publish({snapshot:next,authorizing:false});
        return key===agentChatConsentKey(next,state.contextMode,agentChatCurrentTarget(state))&&Boolean(state.consent);
      }catch(error){if(valid(epoch)){publish({authorizing:false,message:agentChatErrorText('AGENT_CHAT_CONSENT_REQUIRED'),displayMessage:agentChatErrorDescriptor('AGENT_CHAT_CONSENT_REQUIRED')});await load();}return false;}
      finally{if(active)publish({authorizing:false});}
    },
    async send(): Promise<boolean> {
      if (!active || !visible || !agentChatCanSend(state)) return false;
      const snapshot = state.snapshot;
      if (!snapshot) return false;
      detach(); const epoch = serial, id = requestId(), message = state.draft, contextMode = state.contextMode, editTarget = agentChatCurrentTarget(state);
      const configuration = Object.freeze(agentProtocolConfiguration(snapshot.settings.configuration));
      if (!configuration) return false;
      const input = { requestId: id, instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision, expectedConversationRevision: snapshot.revision, message,
        consent: agentChatOutboundConsent(snapshot, contextMode, deriveAgentEndpoint(configuration), editTarget) };
      receipt({ instanceId: snapshot.instanceId, requestId: id });
      publish({ phase: 'submitting', pending: { requestId: id, userText: message, configuration, contextMode, ...([AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(contextMode) ? { editTarget } : {}) }, consent: null, message: '', displayMessage: null });
      try {
        const envelope = safeRunEnvelope(await request(signal => client.start(projectId, input, signal)), projectId, snapshot.instanceId, snapshot.threadId);
        if (!valid(epoch)) return false;
        if (envelope.run.requestId !== id || envelope.run.userText !== message || !agentConfigurationEqual(envelope.run.configuration, configuration) || agentRunContextMode(envelope.run) !== contextMode || ([AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(contextMode) && agentEditTargetKey(envelope.run.editTarget) !== agentEditTargetKey(editTarget))) throw failure('INVALID_RESPONSE');
        const next = mergeRun(envelope);
        receipt({ instanceId: snapshot.instanceId });
        publish({ ...finishState(next), ...(state.draft === message ? { draft: '' } : {}), pending: null, recoveredRun: null });
        attach(envelope.run); return true;
      } catch (error) {
        const code = failureCode(error);
        if (!valid(epoch)) return false;
        if (code && ['NETWORK', 'INVALID_RESPONSE', 'AGENT_CHAT_STORAGE_UNAVAILABLE'].includes(code)) {
          publish({ phase: 'unknown', message: '未收到发送确认。正在读取原请求状态，不会重新发送。', displayMessage: localizedMessage('agent.chat.state.checkingSubmission') });
          await load();
        } else {
          receipt({ instanceId: snapshot.instanceId });
          publish({ phase: 'ready', pending: null, message: agentChatErrorText(code ?? 'NETWORK'), displayMessage: agentChatErrorDescriptor(code ?? 'NETWORK') });
          if (code && ['AGENT_CHAT_SETTINGS_CONFLICT', 'AGENT_CHAT_CONVERSATION_CONFLICT', 'AGENT_CHAT_CONSENT_REQUIRED', 'AGENT_CHAT_ACTIVE_RUN', 'AGENT_CHAT_SESSION_EXPIRED'].includes(code)) {
            await load(); if (active && code !== 'AGENT_CHAT_SESSION_EXPIRED') publish({ message: agentChatErrorText(code), displayMessage: agentChatErrorDescriptor(code) });
          }
        }
        return false;
      }
    },
    async stop(): Promise<boolean> {
      const run = activeAgentChatRun(state);
      if (!active || !visible || !run || ['submitting', 'stopping', 'loading'].includes(state.phase)) return false;
      const snapshot = state.snapshot;
      if (!snapshot) return false;
      detach(); const epoch = serial, instanceId = snapshot.instanceId;
      publish({ phase: 'stopping', consent: null, message: '正在请求停止后续步骤。已发生的计算或费用无法撤回。', displayMessage: localizedMessage('agent.chat.state.requestingStop') });
      try {
        const envelope = safeRunEnvelope(await request(signal => client.stop(projectId, run.id, instanceId, signal)), projectId, snapshot.instanceId, snapshot.threadId);
        if (!valid(epoch)) return false;
        const next = mergeRun(envelope);
        publish({ ...finishState(next), message: envelope.run.status === 'stopped' ? '已停止后续步骤，已收到的文字和读取结果保留；远端仍可能已计算或计费。' : '停止请求已返回，运行状态如下；已发生的费用无法撤回。', displayMessage: envelope.run.status === 'stopped' ? localizedMessage('agent.chat.state.stoppedLaterSteps') : localizedMessage('agent.chat.state.stopResponseReceived') });
        attach(envelope.run); return true;
      } catch (error) {
        if (!valid(epoch)) return false;
        publish({ phase: 'unknown', message: '未确认停止结果；远端可能仍在运行或计费。正在读取状态，不会重复提交停止。', displayMessage: localizedMessage('agent.chat.state.stopUnconfirmed') });
        await recoverStream(run.id, instanceId, epoch); return false;
      }
    },
    dispose(): void { if (!active) return; active = false; detach(); resetHistory(); for (const controller of pendingReads) controller.abort(); pendingReads.clear(); state = initialAgentChatState(); },
  };
}

export function agentChatPromptIssueDescriptor(message: unknown): DisplayMessage | null {
  if (typeof message !== 'string' || !message.trim()) return localizedMessage('agent.chat.state.promptRequired');
  if (bytes(message) > AGENT_CHAT_PROMPT_BYTES) return localizedMessage('agent.chat.state.promptByteLimit');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(message)) return localizedMessage('agent.chat.state.promptControlCharacters');
  return null;
}
