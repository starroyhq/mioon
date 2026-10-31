import {getWorkspaceRestoreContext} from '../workspace-restore-schema.ts';
import {workspaceRestoreError} from '../workspace-restore-policy.ts';
import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {DatabaseSync} from 'node:sqlite';
import {createAgentGainContextFence} from './gain-context-fence.ts';
import {exactObject, parseAgentConfiguration} from './config.ts';
import type {AgentConfiguration} from './config.ts';
import {AGENT_CREDENTIAL_ACQUIRE, sanitizeAgentCredentialResult, sanitizeAgentSettingsResult} from './settings.ts';
import type {AgentSettingsService} from './settings.ts';
import {deriveAgentEndpoint, AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_MOVE_PROVENANCE, agentTimelineMoveReviewTarget, AGENT_TIMELINE_GAIN_CONTEXT, AGENT_TIMELINE_GAIN_PROVENANCE, agentTimelineGainReviewTarget} from '@mioon/contracts';
import {streamAgentResponse, validateAgentGatewayConfiguration, buildAgentRequest} from './agent-gateway.ts';
import type {AgentGateway, AgentStreamItem} from './agent-gateway.ts';
import {CHAT_SYSTEM_INSTRUCTION} from './chat-policy.ts';
export {CHAT_SYSTEM_INSTRUCTION} from './chat-policy.ts';
import {agentChatError, errorCode, safeAgentChatError} from './chat-errors.ts';
import {createChatJournal, CHAT_JOURNAL_LIMITS} from './chat-journal.ts';
import type {ChatJournal, ChatRun, ChatStoredEvent, ChatError} from './chat-journal.ts';
import {createInspectionServices} from '../inspection.ts';
import {readToolCapability, readToolPolicy} from './read-tool-policy.ts';
import {editToolCapability, editToolPolicy} from './edit-tool-policy.ts';
import {timelineEditToolCapability, timelineEditToolPolicy} from './timeline-edit-tool-policy.ts';
import {timelineGainEditToolCapability, timelineGainEditToolPolicy, timelineGainConsentMatches} from './timeline-gain-tool-policy.ts';
import {parseChatConsent, inspectionConsentMatches, editConsentMatches, timelineEditConsentMatches, selectChatContext} from './chat-context.ts';
import type {ChatConsent, ChatModeConsent, ChatContextRun} from './chat-context.ts';
import {runReadToolWorkflow} from './read-tool-runner.ts';
import type {InspectionService, EditProposalService, WorkflowControl} from './read-tool-runner.ts';
import type {AgentEditService} from './edit-proposals.ts';
import type {ChatExecution, ChatStep} from './chat-step-journal.ts';
import type {WireMessage} from './tool-wire.ts';
import type {ChatAuthorizations} from './authorization-gate.ts';
export type {ChatAuthorizations} from './authorization-gate.ts';

export const CHAT_LIMITS = Object.freeze({messageBytes: 8192, responseBytes: 128 * 1024, contextBytes: 32 * 1024,
  historyRuns: 12, projects: 32, runs: 2048, runsPerProject: 16, requests: 2048, active: 4,
  batchMs: 50, batchBytes: 2048, storageBytes: CHAT_JOURNAL_LIMITS.bytes,
  events: 256, eventBytes: 64 * 1024, subscribers: 32, subscribersPerRun: 8, runMs: 120000});
const errors = {
  TIMELINE_SOURCE_UNAVAILABLE: [404, '已选择的时间线片段或关联素材不可用，请重新读取保存的时间线。'],
  INVALID_TIMELINE_SNAPSHOT: [409, '保存的时间线内容无法安全验证；本轮未继续生成移动提案。'],
  INSPECTION_BUDGET_EXCEEDED: [413, '保存的项目资料超出安全读取范围；本轮未继续生成移动提案。'],
  AGENT_EDIT_VALIDATION: [400, '镜头修改提案格式无效。'],
  AGENT_EDIT_NOT_FOUND: [404, '项目或镜头修改提案不存在。'],
  AGENT_EDIT_CONFLICT: [409, '镜头修改提案内容或状态已改变，请重新查看。'],
  AGENT_EDIT_RUN_INCOMPLETE: [409, '只有已成功完成的对话提案可以获准修改。'],
  AGENT_EDIT_STORAGE_LIMIT: [507, '镜头修改提案存储已达上限；已有记录已保留。'],
  AGENT_EDIT_STORAGE_UNAVAILABLE: [503, '无法安全读取或保存镜头修改提案。'],
  AGENT_CHAT_SESSION_EXPIRED: [409, '对话服务已重新启动，请重新读取已保存记录；不会自动重新发送。'],
  AGENT_CHAT_CONVERSATION_CONFLICT: [409, '对话已被另一个窗口更新，请重新读取后确认发送。'],
  AGENT_CHAT_SETTINGS_CONFLICT: [409, '连接设置已改变，请重新读取并确认目标和模型。'],
  AGENT_CHAT_CONSENT_REQUIRED: [409, '目标、模型或发送范围尚未授权，或当前请求范围已变化，请核对授权与发送内容。'],
  AGENT_CHAT_ACTIVE_RUN: [409, '此项目已有回复正在生成，请等待或停止后再发送。'],
  AGENT_CHAT_IDEMPOTENCY_CONFLICT: [409, '此发送标识已用于不同请求；未重复发送。'],
  AGENT_CHAT_RUN_EXPIRED: [410, '这次对话已离开本次服务的有限缓存；不会自动重新发送。'],
  AGENT_CHAT_NOT_FOUND: [404, '项目或这次对话不存在。'],
  AGENT_CHAT_BUSY: [429, '正在生成的对话或订阅已达上限，请稍后继续。'],
  AGENT_CHAT_CLOSED: [503, '本地对话服务正在关闭。'],
  AGENT_CHAT_CREDENTIAL_UNAVAILABLE: [503, '当前连接密钥不可用，请检查设置和系统安全存储。'],
} as const;
export type ChatRuntimeErrorCode = keyof typeof errors;
export type ChatRuntimeFailure = Error & {code: string; status: number};
export function chatRuntimeError(code: string): ChatRuntimeFailure {
  if (!Object.hasOwn(errors, code)) return agentChatError(code);
  const resolved = code as ChatRuntimeErrorCode;
  return Object.assign(new Error(errors[resolved][1]), {code: resolved, status: errors[resolved][0]});
}
export function safeChatRuntimeError(error: unknown): {code: string; message: string; status: number} {
  const code = errorCode(error);
  const safe: ChatRuntimeFailure = code !== undefined && Object.hasOwn(errors, code) ? chatRuntimeError(code) : safeAgentChatError(error) as ChatRuntimeFailure;
  return {code: safe.code, message: safe.message, status: safe.status};
}
const publicError = (error: unknown): ChatError => { const {code, message} = safeChatRuntimeError(error); return {code, message, details: {}, retryable: false}; };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const wellFormed = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value;
interface SendInput {
  requestId: string;
  instanceId: string;
  expectedSettingsRevision: number;
  expectedConversationRevision: number;
  message: string;
  consent: ChatConsent;
}
function parseSend(value: unknown): SendInput {
  if (!exactObject(value, ['requestId', 'instanceId', 'expectedSettingsRevision', 'expectedConversationRevision', 'message', 'consent']) ||
    !uuid(value.requestId) || !uuid(value.instanceId) || !revision(value.expectedSettingsRevision) || !revision(value.expectedConversationRevision) ||
    typeof value.message !== 'string' || !value.message.trim() || Buffer.byteLength(value.message) > CHAT_LIMITS.messageBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value.message) ||
    !wellFormed(value.message)) throw agentChatError('AGENT_CHAT_VALIDATION');
  return {requestId: value.requestId, instanceId: value.instanceId, expectedSettingsRevision: value.expectedSettingsRevision as number,
    expectedConversationRevision: value.expectedConversationRevision as number, message: value.message,
    consent: parseChatConsent(value.consent)};
}
function bounded<T>(operation: () => T | Promise<T>, signal: AbortSignal | undefined, ms = 10000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(agentChatError('AGENT_CHAT_ABORTED'));
    const timer = setTimeout(() => finish(chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE')), ms);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, {once: true});
    Promise.resolve().then(() => { if (signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED'); return operation(); }).then(value => finish(null, value), error => finish(error));
  });
}

export interface ChatRuntimeStore {db: DatabaseSync; tx<T>(operation: () => T): T; get(table: string, id: string): unknown}
export interface ChatRuntimeOptions {
  store: ChatRuntimeStore;
  agentSettings: AgentSettingsService;
  gateway?: AgentGateway;
  selfPort: () => number;
  mode?: 'provider' | 'simulated';
  journalLimits?: Record<string, number>;
  inspection?: InspectionService;
  editService?: AgentEditService;
  authorizations?: ChatAuthorizations;
}
interface ActiveState {
  id: string;
  projectId: string;
  controller: AbortController;
  fenced: boolean;
  pending: string;
  pendingBytes: number;
  receivedBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  execution?: ChatExecution;
  authorizationScope: string;
}
interface WatcherEntry {listener: (event: unknown) => void; detached: boolean; detach: () => void}
interface Publication {event?: ChatStoredEvent; detach?: string | undefined}

/** Durable typed chat, explicitly consented inspection and reviewed shot or clip-move proposals. SQLite owns accepted state; only in-flight
 * work, bounded uncommitted text batches and subscribers are process-local.
 * Gateway/limit injection is trusted synthetic QA, never HTTP/env input. */
export function createChatRuntime({store, agentSettings, gateway = streamAgentResponse, selfPort,
  mode = 'provider', journalLimits, inspection = createInspectionServices(store as never) as unknown as InspectionService, editService, authorizations}: ChatRuntimeOptions) {
  if (getWorkspaceRestoreContext(store)) throw workspaceRestoreError();
  const instanceId = randomUUID(), active = new Map<string, ActiveState>(), watchers = new Map<string, Set<WatcherEntry>>(), publications: Publication[] = [];
  const modeName = mode === 'simulated' ? 'simulated' : 'provider';
  let closing = false, fault: ChatRuntimeFailure | null = null, subscribers = 0, publishing = false, tail: Promise<unknown> = Promise.resolve();
  const shutdown = new AbortController();
  let journal: ChatJournal;
  type TimerHandle = ReturnType<typeof setTimeout>;
  const clearTimer = (timer: TimerHandle | null): void => { if (timer !== null) clearTimeout(timer as unknown as number); };
  function detachRun(runId: string) { for (const entry of [...(watchers.get(runId) || [])]) entry.detach(); }
  function fence(state: ActiveState) {
    state.fenced = true; clearTimer(state.timer); clearTimer(state.flushTimer);
    state.pending = ''; state.pendingBytes = 0; state.controller.abort();
  }
  function storageFault(): ChatRuntimeFailure {
    fault ||= agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
    shutdown.abort(); publications.length = 0;
    for (const state of active.values()) fence(state);
    active.clear();
    for (const runId of [...watchers.keys()]) detachRun(runId);
    return fault;
  }
  function access<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) {
      const code = errorCode(error);
      if (code !== undefined && (['AGENT_CHAT_STORAGE_LIMIT', 'AGENT_CHAT_NOT_FOUND', 'AGENT_CHAT_BUSY', 'AGENT_CHAT_INSPECTION_UNAVAILABLE', 'AGENT_CHAT_LIMIT', 'AGENT_CHAT_ABORTED', 'AGENT_CHAT_CONSENT_REQUIRED', 'AGENT_CHAT_CONTEXT_CHANGED', 'TIMELINE_SOURCE_UNAVAILABLE', 'INVALID_TIMELINE_SNAPSHOT', 'INSPECTION_BUDGET_EXCEEDED'].includes(code) || code.startsWith('AGENT_EDIT_'))) throw error;
      throw storageFault();
    }
  }
  // Opening the runtime reconciles unfinished local rows only. It never asks
  // settings for credentials, calls a gateway, acquires tools, or retries POST.
  try { journal = createChatJournal({store, onRunTerminalInside: run => { if (run.status !== 'completed') editService?.cancelRun(run.id); }, ...(journalLimits ? {limits: journalLimits} : {})}); journal.recover(); editService?.reconcile(); }
  catch { throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE'); }
  const checkOpen = (): void => { if (fault) throw fault; if (closing) throw chatRuntimeError('AGENT_CHAT_CLOSED'); };
  const checkProject = (projectId: string): void => {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 200 || !store.get('projects', projectId)) throw chatRuntimeError('AGENT_CHAT_NOT_FOUND');
  };
  const checkInstance = (supplied: unknown): void => { if (!uuid(supplied) || supplied !== instanceId) throw chatRuntimeError('AGENT_CHAT_SESSION_EXPIRED'); };
  const live = (state: ActiveState): boolean => !closing && !fault && !state.fenced && active.get(state.id) === state && !state.controller.signal.aborted;
  // Explicit DTOs are the final serialization boundary, including for saved
  // JSON. Unknown future/internal fields never become renderer-visible data.
  const publicRun = (run: ChatRun): Record<string, unknown> => ({id: run.id, requestId: run.requestId, threadId: run.threadId, projectId: run.projectId,
    status: run.status, userText: run.userText, assistantText: run.assistantText,
    configuration: {presetId: run.configuration.presetId, platformId: run.configuration.platformId,
      baseUrl: run.configuration.baseUrl, model: run.configuration.model, protocol: run.configuration.protocol},
    createdAt: run.createdAt, updatedAt: run.updatedAt, lastEventId: run.lastEventId,
    modelRequestId: run.modelRequestId, modelRequestState: run.modelRequestState,
    ...(['project_inspection', 'selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(run.contextMode as string) ? {contextMode: run.contextMode,
      provenance: run.provenance ? {category: run.provenance.category, projectId: run.provenance.projectId, sourceRunIds: [...run.provenance.sourceRunIds]} : undefined,
      activity: (run.activity || []).map(item => ({id: item.id, kind: item.kind, ordinal: item.ordinal, status: item.status,
        ...(item.kind === 'tool' ? {name: item.name, operation: item.operation, ...(item.resultJson !== undefined ? {resultJson: item.resultJson} : {})} : {})}))} : {}),
    ...(run.contextMode === 'selected_shot_edit' ? {editTarget: structuredClone(run.editTarget)} : {}),
    ...(run.contextMode === AGENT_TIMELINE_MOVE_CONTEXT ? {editTarget: agentTimelineMoveReviewTarget(run.editTarget)} : {}),
    ...(run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? {editTarget: agentTimelineGainReviewTarget(run.editTarget)} : {}),
    ...(run.modelRequestStartedAt ? {modelRequestStartedAt: run.modelRequestStartedAt} : {}),
    ...(run.error ? {error: publicError(run.error)} : {})});
  const publicEvent = (event: ChatStoredEvent): Record<string, unknown> => ({id: event.id, type: event.type, instanceId, threadId: event.threadId,
    projectId: event.projectId, runId: event.runId, revision: event.revision,
    ...(event.type === 'delta' ? {text: event.text} : {run: publicRun(event.run as ChatRun)})});
  const runResponse = (run: ChatRun): Record<string, unknown> => ({instanceId, threadId: run.threadId, projectId: run.projectId,
    revision: access(() => journal.thread(run.projectId)).revision, run: publicRun(run)});
  const getRun = (projectId: string, runId: string, supplied: unknown): ChatRun => {
    checkOpen(); checkProject(projectId); checkInstance(supplied);
    const run = access(() => journal.get(projectId, runId));
    if (!run) throw chatRuntimeError('AGENT_CHAT_NOT_FOUND');
    return run;
  };
  const eventSnapshot = (run: ChatRun): ChatStoredEvent => ({id: run.lastEventId, type: 'snapshot', instanceId, threadId: run.threadId,
    projectId: run.projectId, runId: run.id, revision: access(() => journal.thread(run.projectId)).revision, run} as ChatStoredEvent);
  function publish(events: readonly ChatStoredEvent[], detachAfter = false): void {
    for (const event of events) publications.push({event});
    if (detachAfter) publications.push({detach: events.at(-1)?.runId});
    if (publishing) return;
    publishing = true;
    try {
      while (publications.length && !fault) {
        const next = publications.shift() as Publication;
        if (next.detach !== undefined) { detachRun(next.detach); continue; }
        const event = publicEvent(next.event as ChatStoredEvent);
        for (const entry of [...(watchers.get(event.runId as string) || [])]) {
          if (fault) break;
          if (!entry.detached) { try { entry.listener(structuredClone(event)); } catch { entry.detach(); } }
        }
      }
    } finally { publishing = false; }
  }
  function terminal(state: ActiveState | undefined, status: ChatRun['status'], error?: unknown, {discardPending = false}: {discardPending?: boolean} = {}): void {
    if (!state || state.fenced || fault) return;
    state.fenced = true; clearTimer(state.timer); clearTimer(state.flushTimer);
    let saved: {run: ChatRun; revision: number; events: ChatStoredEvent[]} | undefined;
    try { saved = access(() => journal.finish(state.id, status, error ? publicError(error) : undefined, discardPending ? '' : state.pending)); }
    catch { storageFault(); }
    finally {
      state.pending = ''; state.pendingBytes = 0; active.delete(state.id); state.controller.abort();
    }
    if (saved && !fault) publish(saved.events, true);
  }
  function flush(state: ActiveState): void {
    clearTimer(state.flushTimer); state.flushTimer = null;
    if (!live(state) || !state.pending) return;
    const text = state.pending;
    try {
      const saved = access(() => journal.append(state.id, text));
      state.pending = ''; state.pendingBytes = 0;
      publish(saved.events);
    } catch (error) {
      if (errorCode(error) === 'AGENT_CHAT_STORAGE_LIMIT' && live(state)) terminal(state, 'failed', error, {discardPending: true});
      else if (!fault) throw error;
    }
  }
  function buffer(state: ActiveState, text: string): void {
    for (const char of text) {
      if (!live(state)) return;
      const size = Buffer.byteLength(char);
      if (state.pendingBytes + size > CHAT_LIMITS.batchBytes) flush(state);
      if (!live(state)) return;
      state.pending += char; state.pendingBytes += size;
      if (state.pendingBytes >= CHAT_LIMITS.batchBytes) flush(state);
      else if (!state.flushTimer) state.flushTimer = setTimeout(() => flush(state), CHAT_LIMITS.batchMs);
    }
  }
  function inspectionAvailable(projectId: unknown, configuration: AgentConfiguration): boolean {
    if (!uuid(projectId)) return false;
    try { validateAgentGatewayConfiguration(configuration, {selfPort: selfPort(), readTools: {phase: 'request'}}); return true; }
    catch { return false; }
  }
  function editAvailable(projectId: unknown, configuration: AgentConfiguration): boolean {
    if (!editService || !uuid(projectId)) return false;
    try { validateAgentGatewayConfiguration(configuration, {selfPort: selfPort(), readTools: {phase: 'request', scope: 'selected_shot_edit'}}); return true; }
    catch { return false; }
  }
  function timelineEditAvailable(projectId: unknown, configuration: AgentConfiguration): boolean {
    if (!editService?.pinTimelineTarget || !uuid(projectId)) return false;
    try { validateAgentGatewayConfiguration(configuration, {selfPort: selfPort(), readTools: {phase: 'request', scope: AGENT_TIMELINE_MOVE_CONTEXT}}); return true; }
    catch { return false; }
  }
  function timelineGainAvailable(projectId: unknown, configuration: AgentConfiguration): boolean {
    if (!editService?.pinTimelineGainTarget || !editService?.assertTimelineGainTarget || !uuid(projectId)) return false;
    try { validateAgentGatewayConfiguration(configuration, {selfPort: selfPort(), readTools: {phase: 'request', scope: AGENT_TIMELINE_GAIN_CONTEXT}}); return true; }
    catch { return false; }
  }
  function requireAuthorization(configuration: AgentConfiguration, scope: string): void {
    if (!authorizations) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
    try { authorizations.assertAuthorized({destination: deriveAgentEndpoint(configuration), model: configuration.model, scope}); }
    catch (error) {
      if (errorCode(error) === 'AGENT_AUTHORIZATION_REQUIRED') throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
      throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
    }
  }
  async function execute(state: ActiveState, configuration: AgentConfiguration, messages: readonly WireMessage[], expectedSettingsRevision: number): Promise<void> {
    let apiKey: string | null = null;
    const gainFence = state.execution?.policy.context === AGENT_TIMELINE_GAIN_CONTEXT ? createAgentGainContextFence({
      live: () => live(state), checkTarget: () => (editService as AgentEditService).assertTimelineGainTarget(state.execution?.target)}) : undefined;
    // A saved grant never authorizes later steps after revocation. This same
    // fence runs after async credential acquisition, at each model POST, and
    // immediately before a synchronous tool read or proposal capture.
    const beforeSubmit = (): void => { requireAuthorization(configuration, state.authorizationScope); gainFence?.(); };
    try {
      validateAgentGatewayConfiguration(configuration, {selfPort: selfPort(), ...(state.execution ? {readTools: {phase: 'request', ...(state.execution.target ? {scope: state.execution.policy.context} : {})}} : {})});
      const expected = {expectedRevision: expectedSettingsRevision, configuration};
      let credential: {revision: number; configuration: AgentConfiguration; apiKey: string | null} | null;
      try {
        if (typeof agentSettings[AGENT_CREDENTIAL_ACQUIRE] !== 'function') throw chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE');
        credential = sanitizeAgentCredentialResult(await bounded(() => {
          beforeSubmit?.();
          return agentSettings[AGENT_CREDENTIAL_ACQUIRE](expected, {selfPort: selfPort(), signal: state.controller.signal});
        }, state.controller.signal), expected);
        beforeSubmit?.();
      } catch (error) {
        const code = errorCode(error);
        if (code !== undefined && ['AGENT_CHAT_CONTEXT_CHANGED', 'AGENT_CHAT_ABORTED', 'AGENT_CHAT_CONSENT_REQUIRED', 'AGENT_CHAT_STORAGE_UNAVAILABLE'].includes(code)) throw error;
        if (code === 'AGENT_SETTINGS_CONFLICT') throw chatRuntimeError('AGENT_CHAT_SETTINGS_CONFLICT');
        throw chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE');
      }
      if (!live(state)) return;
      apiKey = credential.apiKey; credential = null;
      if (!apiKey && configuration.presetId !== 'ollama') throw agentChatError('AGENT_CHAT_KEY_REQUIRED');
      if (state.execution) {
        const control: WorkflowControl = {signal: state.controller.signal, live: () => live(state), commit: access, publish: events => publish(events), beforeSubmit,
          flush: () => flush(state), text: (text: string) => {
            const bytes = Buffer.byteLength(text);
            if (state.receivedBytes + bytes > CHAT_LIMITS.responseBytes) throw agentChatError('AGENT_CHAT_LIMIT');
            state.receivedBytes += bytes; buffer(state, text);
          }};
        await runReadToolWorkflow({runId: state.id, projectId: state.projectId, configuration, messages,
          provenance: state.execution.request.provenance, apiKey, gateway, selfPort: selfPort(), journal, inspection, editService: editService as EditProposalService | undefined,
          target: state.execution.target, contextMode: state.execution.policy.context, control});
        if (live(state)) terminal(state, 'completed');
        return;
      }
      access(() => journal.dispatch(state.id));
      if (!live(state)) return;
      beforeSubmit();
      let done = false;
      // Exactly one invocation, after the conservative local dispatch boundary
      // committed. A boundary does not prove provider acceptance or billing.
      for await (const item of gateway({configuration: {...configuration}, apiKey, messages: structuredClone(messages) as WireMessage[], signal: state.controller.signal, selfPort: selfPort(), beforeSubmit})) {
        if (!live(state)) return;
        if (item?.type === 'done') {
          if (item.finishReason === 'length') throw agentChatError('AGENT_CHAT_TRUNCATED');
          if (item.finishReason === 'content_filter') throw agentChatError('AGENT_CHAT_PROVIDER_ERROR');
          if (item.finishReason !== 'stop') throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
          done = true; break;
        }
        if (item?.type !== 'delta' || typeof item.text !== 'string') throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
        const size = Buffer.byteLength(item.text);
        if (state.receivedBytes + size > CHAT_LIMITS.responseBytes) throw agentChatError('AGENT_CHAT_LIMIT');
        state.receivedBytes += size;
        buffer(state, item.text);
      }
      if (!live(state)) return;
      if (!done) throw agentChatError('AGENT_CHAT_TRUNCATED');
      terminal(state, 'completed');
    } catch (error) {
      if (live(state)) terminal(state, 'failed', error);
    } finally { apiKey = null; }
  }
  const schedule = <T>(operation: () => T | Promise<T>): Promise<T> => {
    try { checkOpen(); } catch (error) { return Promise.reject(error); }
    const result = tail.then(() => { checkOpen(); return operation(); });
    tail = result.catch(() => {}); return result;
  };
  function historyPage(projectId: string, before: string | null = null): Record<string, unknown> {
    checkOpen(); checkProject(projectId);
    if (before !== null && !uuid(before)) throw agentChatError('AGENT_CHAT_VALIDATION');
    const conv = access(() => journal.thread(projectId)), page = access(() => journal.page(projectId, before));
    return {instanceId, threadId: conv.id, projectId, revision: conv.revision, runs: page.runs.map(publicRun), historyCursor: page.historyCursor};
  }
  function editAccess(projectId: string): void {
    checkOpen(); checkProject(projectId);
    if (!editService) throw agentChatError('AGENT_CHAT_TOOLS_UNSUPPORTED');
  }
  function editMutation(method: 'approve' | 'reject' | 'recover', projectId: string, proposalId: string, input: unknown): Promise<Record<string, unknown>> {
    editAccess(projectId);
    if (!exactObject(input, ['instanceId', 'digest']) || !uuid(proposalId) || typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.digest)) throw agentChatError('AGENT_CHAT_VALIDATION');
    checkInstance(input.instanceId);
    const service = editService as AgentEditService;
    const proposal = service.get({projectId, proposalId}) as {runId: string};
    const run = access(() => journal.get(projectId, proposal.runId));
    if (['approve', 'recover'].includes(method) && run?.status !== 'completed') throw chatRuntimeError('AGENT_EDIT_RUN_INCOMPLETE');
    return Promise.resolve(service[method]({projectId, proposalId, digest: input.digest})).then(proposal => ({instanceId, projectId, proposal}));
  }
  return Object.freeze({
    async snapshot(projectId: string) {
      checkOpen(); checkProject(projectId);
      let settings;
      try { settings = sanitizeAgentSettingsResult(await bounded(() => agentSettings.get({selfPort: selfPort()}), shutdown.signal)); }
      catch { checkOpen(); throw chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE'); }
      const page = historyPage(projectId);
      const edit = editService as AgentEditService;
      return {...page, scope: editService?.pinTimelineTarget ? 'chat_and_reviewed_timeline_edits' : editService ? 'chat_and_reviewed_shot_edits' : 'chat_and_project_inspection', persistence: 'local_database', mode: modeName, settings,
        authorization: authorizations ? authorizations.snapshot(settings.configuration) : {revision: 0, scopes: []},
        inspection: readToolCapability(inspectionAvailable(projectId, settings.configuration)),
        edit: editToolCapability(editAvailable(projectId, settings.configuration)),
        timelineEdit: timelineEditToolCapability(timelineEditAvailable(projectId, settings.configuration)),
        timelineGainEdit: timelineGainEditToolCapability(timelineGainAvailable(projectId, settings.configuration))};
    },
    send(projectId: string, value: unknown): Promise<Record<string, unknown>> {
      let input: SendInput;
      try { input = parseSend(value); } catch (error) { return Promise.reject(error); }
      return schedule(async () => {
        // Authorization and epoch checks precede every idempotent replay.
        checkProject(projectId); checkInstance(input.instanceId);
        const fingerprint = createHash('sha256').update(JSON.stringify({projectId, ...input})).digest('hex');
        const prior = access(() => journal.request(input.requestId));
        if (prior) {
          if (prior.projectId !== projectId || prior.fingerprint !== fingerprint) throw chatRuntimeError('AGENT_CHAT_IDEMPOTENCY_CONFLICT');
          const run = access(() => journal.get(projectId, prior.runId as string));
          if (!run) throw storageFault();
          return {...runResponse(run), replayed: true};
        }
        const conv = access(() => journal.thread(projectId));
        if (input.expectedConversationRevision !== conv.revision) throw chatRuntimeError('AGENT_CHAT_CONVERSATION_CONFLICT');
        if (access(() => journal.active(projectId))) throw chatRuntimeError('AGENT_CHAT_ACTIVE_RUN');
        if (active.size >= CHAT_LIMITS.active) throw chatRuntimeError('AGENT_CHAT_BUSY');
        let settings;
        try { settings = sanitizeAgentSettingsResult(await bounded(() => agentSettings.get({selfPort: selfPort()}), shutdown.signal)); }
        catch { checkOpen(); throw chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE'); }
        checkOpen(); checkProject(projectId);
        if (settings.revision !== input.expectedSettingsRevision) throw chatRuntimeError('AGENT_CHAT_SETTINGS_CONFLICT');
        const configuration = parseAgentConfiguration(settings.configuration, {selfPort: selfPort()});
        if (input.consent.destination !== deriveAgentEndpoint(configuration) || input.consent.protocol !== configuration.protocol || input.consent.model !== configuration.model) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        const modeConsent = input.consent as ChatModeConsent;
        const useInspection = input.consent.context === 'project_inspection', useEdit = input.consent.context === 'selected_shot_edit',
          useTimelineEdit = input.consent.context === AGENT_TIMELINE_MOVE_CONTEXT, useTimelineGain = input.consent.context === AGENT_TIMELINE_GAIN_CONTEXT;
        const useProposal = useEdit || useTimelineEdit || useTimelineGain;
        if (useInspection && !inspectionConsentMatches(modeConsent, projectId, inspectionAvailable(projectId, configuration))) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        if (useEdit && !editConsentMatches(modeConsent, projectId, editAvailable(projectId, configuration))) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        if (useTimelineEdit && !timelineEditConsentMatches(modeConsent, projectId, timelineEditAvailable(projectId, configuration))) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        if (useTimelineGain && !timelineGainConsentMatches(input.consent as never, projectId, timelineGainAvailable(projectId, configuration))) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        const service = editService as AgentEditService;
        const consent = modeConsent;
        const target: unknown = useTimelineGain ? service.pinTimelineGainTarget(projectId, {timelineId: consent.timelineId, clipId: consent.clipId, expectedRevision: consent.expectedRevision}) : useTimelineEdit ? service.pinTimelineTarget(projectId, {timelineId: consent.timelineId, clipId: consent.clipId, expectedRevision: consent.expectedRevision}) :
          useEdit ? service.pinTarget(projectId, {shotId: consent.shotId, expectedRevision: consent.expectedRevision}) : undefined;
        if (useTimelineGain && !isDeepStrictEqual(modeConsent.reviewTarget, agentTimelineGainReviewTarget(target))) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        requireAuthorization(configuration, input.consent.context);
        const {messages, sourceRunIds} = selectChatContext(access(() => journal.page(projectId)).runs as ChatContextRun[], input.message, input.consent.context, CHAT_LIMITS, target);
        const execution: ChatExecution | undefined = useInspection || useProposal ? {version: 1, policy: useTimelineGain ? timelineGainEditToolPolicy(projectId) : useTimelineEdit ? timelineEditToolPolicy(projectId) : useEdit ? editToolPolicy(projectId) : readToolPolicy(projectId), ...(useProposal ? {target} : {}), request: {protocol: configuration.protocol,
          body: buildAgentRequest({configuration, messages, readTools: {phase: 'request', ...(useProposal ? {scope: input.consent.context} : {})}, selfPort: selfPort()}).body,
          context: messages, provenance: {category: useTimelineGain ? AGENT_TIMELINE_GAIN_PROVENANCE : useTimelineEdit ? AGENT_TIMELINE_MOVE_PROVENANCE : useEdit ? 'project_selected_shot_text' : 'project_saved_text_metadata', projectId, sourceRunIds}}} as unknown as ChatExecution : undefined;
        const saved = access(() => journal.accept({projectId, requestId: input.requestId, fingerprint, instanceId, configuration, messages, consent: input.consent, input, ...(execution ? {execution} : {})}));
        const state: ActiveState = {id: saved.run.id, projectId, controller: new AbortController(), fenced: false,
          pending: '', pendingBytes: 0, receivedBytes: 0, timer: null, flushTimer: null, execution, authorizationScope: input.consent.context};
        active.set(state.id, state);
        publish(saved.events);
        state.timer = setTimeout(() => { if (live(state)) terminal(state, 'failed', agentChatError('AGENT_CHAT_TIMEOUT')); }, CHAT_LIMITS.runMs);
        // Acceptance, exact context and initial event are already durable before
        // acknowledgement and before even credential acquisition can begin.
        void execute(state, Object.freeze({...configuration}), messages, settings.revision);
        return {...runResponse(access(() => journal.get(projectId, saved.run.id)) as ChatRun), replayed: false};
      });
    },
    editList(projectId: string, options: unknown = {}) {
      editAccess(projectId);
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['limit', 'cursor', 'view'].includes(key))) throw agentChatError('AGENT_CHAT_VALIDATION');
      return {instanceId, projectId, ...(editService as AgentEditService).list({...options, projectId})};
    },
    editGet(projectId: string, proposalId: string) {
      editAccess(projectId);
      return {instanceId, projectId, proposal: (editService as AgentEditService).get({projectId, proposalId})};
    },
    editApprove(projectId: string, proposalId: string, input: unknown) { return editMutation('approve', projectId, proposalId, input); },
    editReject(projectId: string, proposalId: string, input: unknown) { return editMutation('reject', projectId, proposalId, input); },
    editRecover(projectId: string, proposalId: string, input: unknown) { return editMutation('recover', projectId, proposalId, input); },
    get(projectId: string, runId: string, supplied: unknown) { return runResponse(getRun(projectId, runId, supplied)); },
    lookup(projectId: string, requestId: string) {
      checkOpen(); checkProject(projectId);
      if (!uuid(requestId)) throw agentChatError('AGENT_CHAT_VALIDATION');
      const run = access(() => journal.lookup(projectId, requestId));
      if (!run) throw chatRuntimeError('AGENT_CHAT_NOT_FOUND');
      return runResponse(run);
    },
    history(projectId: string, options: unknown = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'before')) throw agentChatError('AGENT_CHAT_VALIDATION');
      return historyPage(projectId, (options as {before?: string | null}).before ?? null);
    },
    stop(projectId: string, runId: string, input: unknown) {
      if (!exactObject(input, ['instanceId'])) throw agentChatError('AGENT_CHAT_VALIDATION');
      const run = getRun(projectId, runId, input.instanceId);
      terminal(active.get(run.id), 'stopped');
      // An explicit Stop racing with completion still withdraws its unapproved proposal.
      if (['selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(run.contextMode as string)) access(() => editService?.cancelRun(run.id));
      checkOpen();
      return runResponse(access(() => journal.get(projectId, runId)) as ChatRun);
    },
    subscribe(projectId: string, runId: string, supplied: unknown, after: unknown, listener: unknown, onClose: unknown) {
      const run = getRun(projectId, runId, supplied);
      if (!revision(after) || typeof listener !== 'function' || onClose !== undefined && typeof onClose !== 'function') throw agentChatError('AGENT_CHAT_VALIDATION');
      const entries = watchers.get(runId) || new Set<WatcherEntry>();
      if (subscribers >= CHAT_LIMITS.subscribers || entries.size >= CHAT_LIMITS.subscribersPerRun) throw chatRuntimeError('AGENT_CHAT_BUSY');
      let replay: ChatStoredEvent[] | null = after >= run.lastEventId ? null : access(() => journal.replay(runId, after));
      if (!replay?.length) replay = [eventSnapshot(run)];
      const entry: WatcherEntry = {listener: listener as (event: unknown) => void, detached: false, detach: () => {}};
      const closeListener = onClose as (() => void) | undefined;
      entry.detach = () => {
        if (entry.detached) return;
        entry.detached = true; entries.delete(entry); subscribers--;
        if (!entries.size) watchers.delete(runId);
        try { closeListener?.(); } catch { /* Closing a subscriber cannot mutate a run. */ }
      };
      subscribers++; entries.add(entry); watchers.set(runId, entries);
      try { for (const event of replay) { if (entry.detached) break; entry.listener(publicEvent(event)); } }
      catch (error) { entry.detach(); throw error; }
      if (run.status !== 'running') entry.detach();
      return entry.detach;
    },
    close() {
      if (closing) return;
      closing = true; shutdown.abort();
      if (!fault) {
        for (const state of [...active.values()]) {
          try { terminal(state, 'interrupted'); } catch { storageFault(); break; }
        }
      }
      for (const state of active.values()) fence(state);
      active.clear();
      for (const runId of [...watchers.keys()]) detachRun(runId);
      // No provider or credential promise is awaited. Every later callback is
      // fenced before this returns, so store.close() may follow synchronously.
    },
  });
}
