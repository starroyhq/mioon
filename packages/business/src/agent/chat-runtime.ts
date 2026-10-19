import {getWorkspaceRestoreContext} from '../workspace-restore-schema.ts';
import {workspaceRestoreError} from '../workspace-restore-policy.ts';
import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createAgentGainContextFence} from './gain-context-fence.ts';
import {exactObject, parseAgentConfiguration} from './config.ts';
import {AGENT_CREDENTIAL_ACQUIRE, sanitizeAgentCredentialResult, sanitizeAgentSettingsResult} from './settings.ts';
import {deriveAgentEndpoint, AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_MOVE_PROVENANCE, agentTimelineMoveReviewTarget, AGENT_TIMELINE_GAIN_CONTEXT, AGENT_TIMELINE_GAIN_PROVENANCE, agentTimelineGainReviewTarget} from '@mioon/contracts';
import {streamAgentResponse, validateAgentGatewayConfiguration, buildAgentRequest} from './agent-gateway.ts';
import {CHAT_SYSTEM_INSTRUCTION} from './chat-policy.ts';
export {CHAT_SYSTEM_INSTRUCTION} from './chat-policy.ts';
import {agentChatError, safeAgentChatError} from './chat-errors.ts';
import {createChatJournal, CHAT_JOURNAL_LIMITS} from './chat-journal.ts';
import {createInspectionServices} from '../inspection.ts';
import {readToolCapability, readToolPolicy} from './read-tool-policy.ts';
import {editToolCapability, editToolPolicy} from './edit-tool-policy.ts';
import {timelineEditToolCapability, timelineEditToolPolicy} from './timeline-edit-tool-policy.ts';
import {timelineGainEditToolCapability, timelineGainEditToolPolicy, timelineGainConsentMatches} from './timeline-gain-tool-policy.ts';
import {parseChatConsent, inspectionConsentMatches, editConsentMatches, timelineEditConsentMatches, selectChatContext} from './chat-context.ts';
import {runReadToolWorkflow} from './read-tool-runner.ts';

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
};
export function chatRuntimeError(code) {
  if (!Object.hasOwn(errors, code)) return agentChatError(code);
  return Object.assign(new Error(errors[code][1]), {code, status: errors[code][0]});
}
export function safeChatRuntimeError(error) {
  const safe = Object.hasOwn(errors, error?.code) ? chatRuntimeError(error.code) : safeAgentChatError(error);
  return {code: safe.code, message: safe.message, status: safe.status};
}
const publicError = error => { const {code, message} = safeChatRuntimeError(error); return {code, message, details: {}, retryable: false}; };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
function parseSend(value) {
  if (!exactObject(value, ['requestId', 'instanceId', 'expectedSettingsRevision', 'expectedConversationRevision', 'message', 'consent']) ||
    !uuid(value.requestId) || !uuid(value.instanceId) || !revision(value.expectedSettingsRevision) || !revision(value.expectedConversationRevision) ||
    typeof value.message !== 'string' || !value.message.trim() || Buffer.byteLength(value.message) > CHAT_LIMITS.messageBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value.message) ||
    !value.message.isWellFormed()) throw agentChatError('AGENT_CHAT_VALIDATION');
  return {requestId: value.requestId, instanceId: value.instanceId, expectedSettingsRevision: value.expectedSettingsRevision,
    expectedConversationRevision: value.expectedConversationRevision, message: value.message,
    consent: parseChatConsent(value.consent)};
}
function bounded(operation, signal, ms = 10000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(agentChatError('AGENT_CHAT_ABORTED'));
    const timer = setTimeout(() => finish(chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE')), ms);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, {once: true});
    Promise.resolve().then(() => { if (signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED'); return operation(); }).then(value => finish(null, value), error => finish(error));
  });
}

/** Durable typed chat, explicitly consented inspection and reviewed shot or clip-move proposals. SQLite owns accepted state; only in-flight
 * work, bounded uncommitted text batches and subscribers are process-local.
 * Gateway/limit injection is trusted synthetic QA, never HTTP/env input. */
export function createChatRuntime({store, agentSettings, gateway = streamAgentResponse, selfPort,
  mode = 'provider', journalLimits, inspection = createInspectionServices(store), editService, authorizations}) {
 if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();
  const instanceId = randomUUID(), active = new Map(), watchers = new Map(), publications = [];
  const modeName = mode === 'simulated' ? 'simulated' : 'provider';
  let closing = false, fault = null, subscribers = 0, publishing = false, tail = Promise.resolve();
  const shutdown = new AbortController();
  let journal;
  function detachRun(runId) { for (const entry of [...(watchers.get(runId) || [])]) entry.detach(); }
  function fence(state) {
    state.fenced = true; clearTimeout(state.timer); clearTimeout(state.flushTimer);
    state.pending = ''; state.pendingBytes = 0; state.controller.abort();
  }
  function storageFault() {
    fault ||= agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
    shutdown.abort(); publications.length = 0;
    for (const state of active.values()) fence(state);
    active.clear();
    for (const runId of [...watchers.keys()]) detachRun(runId);
    return fault;
  }
  function access(operation) {
    try { return operation(); }
    catch (error) {
      if (['AGENT_CHAT_STORAGE_LIMIT', 'AGENT_CHAT_NOT_FOUND', 'AGENT_CHAT_BUSY', 'AGENT_CHAT_INSPECTION_UNAVAILABLE', 'AGENT_CHAT_LIMIT', 'AGENT_CHAT_ABORTED', 'TIMELINE_SOURCE_UNAVAILABLE', 'INVALID_TIMELINE_SNAPSHOT', 'INSPECTION_BUDGET_EXCEEDED'].includes(error?.code) || error?.code?.startsWith('AGENT_EDIT_')) throw error;
      throw storageFault();
    }
  }
  // Opening the runtime reconciles unfinished local rows only. It never asks
  // settings for credentials, calls a gateway, acquires tools, or retries POST.
  try { journal = createChatJournal({store, onRunTerminalInside: run => { if (run.status !== 'completed') editService?.cancelRun(run.id); }, ...(journalLimits ? {limits: journalLimits} : {})}); journal.recover(); editService?.reconcile(); }
  catch { throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE'); }
  const checkOpen = () => { if (fault) throw fault; if (closing) throw chatRuntimeError('AGENT_CHAT_CLOSED'); };
  const checkProject = projectId => {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 200 || !store.get('projects', projectId)) throw chatRuntimeError('AGENT_CHAT_NOT_FOUND');
  };
  const checkInstance = supplied => { if (!uuid(supplied) || supplied !== instanceId) throw chatRuntimeError('AGENT_CHAT_SESSION_EXPIRED'); };
  const live = state => !closing && !fault && !state.fenced && active.get(state.id) === state && !state.controller.signal.aborted;
  // Explicit DTOs are the final serialization boundary, including for saved
  // JSON. Unknown future/internal fields never become renderer-visible data.
  const publicRun = run => ({id: run.id, requestId: run.requestId, threadId: run.threadId, projectId: run.projectId,
    status: run.status, userText: run.userText, assistantText: run.assistantText,
    configuration: {presetId: run.configuration.presetId, platformId: run.configuration.platformId,
      baseUrl: run.configuration.baseUrl, model: run.configuration.model, protocol: run.configuration.protocol},
    createdAt: run.createdAt, updatedAt: run.updatedAt, lastEventId: run.lastEventId,
    modelRequestId: run.modelRequestId, modelRequestState: run.modelRequestState,
    ...(['project_inspection', 'selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(run.contextMode) ? {contextMode: run.contextMode,
      provenance: {category: run.provenance.category, projectId: run.provenance.projectId, sourceRunIds: [...run.provenance.sourceRunIds]},
      activity: run.activity.map(item => ({id: item.id, kind: item.kind, ordinal: item.ordinal, status: item.status,
        ...(item.kind === 'tool' ? {name: item.name, operation: item.operation, ...(item.resultJson !== undefined ? {resultJson: item.resultJson} : {})} : {})}))} : {}),
    ...(run.contextMode === 'selected_shot_edit' ? {editTarget: structuredClone(run.editTarget)} : {}),
    ...(run.contextMode === AGENT_TIMELINE_MOVE_CONTEXT ? {editTarget: agentTimelineMoveReviewTarget(run.editTarget)} : {}),
    ...(run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? {editTarget: agentTimelineGainReviewTarget(run.editTarget)} : {}),
    ...(run.modelRequestStartedAt ? {modelRequestStartedAt: run.modelRequestStartedAt} : {}),
    ...(run.error ? {error: publicError(run.error)} : {})});
  const publicEvent = event => ({id: event.id, type: event.type, instanceId, threadId: event.threadId,
    projectId: event.projectId, runId: event.runId, revision: event.revision,
    ...(event.type === 'delta' ? {text: event.text} : {run: publicRun(event.run)})});
  const runResponse = run => ({instanceId, threadId: run.threadId, projectId: run.projectId,
    revision: access(() => journal.thread(run.projectId)).revision, run: publicRun(run)});
  const getRun = (projectId, runId, supplied) => {
    checkOpen(); checkProject(projectId); checkInstance(supplied);
    const run = access(() => journal.get(projectId, runId));
    if (!run) throw chatRuntimeError('AGENT_CHAT_NOT_FOUND');
    return run;
  };
  const eventSnapshot = run => ({id: run.lastEventId, type: 'snapshot', instanceId, threadId: run.threadId,
    projectId: run.projectId, runId: run.id, revision: access(() => journal.thread(run.projectId)).revision, run: publicRun(run)});
  function publish(events, detachAfter = false) {
    for (const event of events) publications.push({event});
    if (detachAfter) publications.push({detach: events.at(-1)?.runId});
    if (publishing) return;
    publishing = true;
    try {
      while (publications.length && !fault) {
        const next = publications.shift();
        if (next.detach) { detachRun(next.detach); continue; }
        const event = publicEvent(next.event);
        for (const entry of [...(watchers.get(event.runId) || [])]) {
          if (fault) break;
          if (!entry.detached) { try { entry.listener(structuredClone(event)); } catch { entry.detach(); } }
        }
      }
    } finally { publishing = false; }
  }
  function terminal(state, status, error, {discardPending = false} = {}) {
    if (!state || state.fenced || fault) return;
    state.fenced = true; clearTimeout(state.timer); clearTimeout(state.flushTimer);
    let saved;
    try { saved = access(() => journal.finish(state.id, status, error ? publicError(error) : undefined, discardPending ? '' : state.pending)); }
    catch { storageFault(); }
    finally {
      state.pending = ''; state.pendingBytes = 0; active.delete(state.id); state.controller.abort();
    }
    if (saved && !fault) publish(saved.events, true);
  }
  function flush(state) {
    clearTimeout(state.flushTimer); state.flushTimer = null;
    if (!live(state) || !state.pending) return;
    const text = state.pending;
    try {
      const saved = access(() => journal.append(state.id, text));
      state.pending = ''; state.pendingBytes = 0;
      publish(saved.events);
    } catch (error) {
      if (error?.code === 'AGENT_CHAT_STORAGE_LIMIT' && live(state)) terminal(state, 'failed', error, {discardPending: true});
      else if (!fault) throw error;
    }
  }
  function buffer(state, text) {
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
  function inspectionAvailable(projectId, configuration) {
    if (!uuid(projectId)) return false;
    try { validateAgentGatewayConfiguration(configuration, {selfPort: selfPort(), readTools: {phase: 'request'}}); return true; }
    catch { return false; }
  }
  function editAvailable(projectId, configuration) {
    if (!editService || !uuid(projectId)) return false;
    try { validateAgentGatewayConfiguration(configuration, {selfPort: selfPort(), readTools: {phase: 'request', scope: 'selected_shot_edit'}}); return true; }
    catch { return false; }
  }
  function timelineEditAvailable(projectId, configuration) {
    if (!editService?.pinTimelineTarget || !uuid(projectId)) return false;
    try { validateAgentGatewayConfiguration(configuration, {selfPort: selfPort(), readTools: {phase: 'request', scope: AGENT_TIMELINE_MOVE_CONTEXT}}); return true; }
    catch { return false; }
  }
  function timelineGainAvailable(projectId, configuration) {
    if (!editService?.pinTimelineGainTarget || !editService?.assertTimelineGainTarget || !uuid(projectId)) return false;
    try { validateAgentGatewayConfiguration(configuration, {selfPort: selfPort(), readTools: {phase: 'request', scope: AGENT_TIMELINE_GAIN_CONTEXT}}); return true; }
    catch { return false; }
  }
  function requireAuthorization(configuration, scope) {
    if(!authorizations)throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
    try{authorizations.assertAuthorized({destination:deriveAgentEndpoint(configuration),model:configuration.model,scope});}
    catch(error){
      if(error?.code==='AGENT_AUTHORIZATION_REQUIRED')throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
      throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
    }
  }
  async function execute(state, configuration, messages, expectedSettingsRevision) {
    let apiKey = null;
    const gainFence = state.execution?.policy.context === AGENT_TIMELINE_GAIN_CONTEXT ? createAgentGainContextFence({
      live: () => live(state), checkTarget: () => editService.assertTimelineGainTarget(state.execution.target)}) : undefined;
    // A saved grant never authorizes later steps after revocation. This same
    // fence runs after async credential acquisition and at each model POST.
    const beforeSubmit=()=>{requireAuthorization(configuration,state.authorizationScope);gainFence?.();};
    try {
      validateAgentGatewayConfiguration(configuration, {selfPort: selfPort(), ...(state.execution ? {readTools: {phase: 'request', ...(state.execution.target ? {scope: state.execution.policy.context} : {})}} : {})});
      const expected = {expectedRevision: expectedSettingsRevision, configuration};
      let credential;
      try {
        if (typeof agentSettings[AGENT_CREDENTIAL_ACQUIRE] !== 'function') throw chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE');
        credential = sanitizeAgentCredentialResult(await bounded(() => {
          beforeSubmit?.();
          return agentSettings[AGENT_CREDENTIAL_ACQUIRE](expected, {selfPort: selfPort(), signal: state.controller.signal});
        }, state.controller.signal), expected);
        beforeSubmit?.();
      } catch (error) {
        if (['AGENT_CHAT_CONTEXT_CHANGED', 'AGENT_CHAT_ABORTED', 'AGENT_CHAT_CONSENT_REQUIRED', 'AGENT_CHAT_STORAGE_UNAVAILABLE'].includes(error?.code)) throw error;
        if (error?.code === 'AGENT_SETTINGS_CONFLICT') throw chatRuntimeError('AGENT_CHAT_SETTINGS_CONFLICT');
        throw chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE');
      }
      if (!live(state)) return;
      apiKey = credential.apiKey; credential = null;
      if (!apiKey && configuration.presetId !== 'ollama') throw agentChatError('AGENT_CHAT_KEY_REQUIRED');
      if (state.execution) {
        await runReadToolWorkflow({runId: state.id, projectId: state.projectId, configuration, messages,
          provenance: state.execution.request.provenance, apiKey, gateway, selfPort: selfPort(), journal, inspection, editService, target: state.execution.target, contextMode: state.execution.policy.context,
          control: {signal: state.controller.signal, live: () => live(state), commit: access, publish, ...(beforeSubmit ? {beforeSubmit} : {}),
            flush: () => flush(state), text: text => {
              const bytes = Buffer.byteLength(text);
              if (state.receivedBytes + bytes > CHAT_LIMITS.responseBytes) throw agentChatError('AGENT_CHAT_LIMIT');
              state.receivedBytes += bytes; buffer(state, text);
            }}});
        if (live(state)) terminal(state, 'completed');
        return;
      }
      access(() => journal.dispatch(state.id));
      if (!live(state)) return;
      beforeSubmit();
      let done = false;
      // Exactly one invocation, after the conservative local dispatch boundary
      // committed. A boundary does not prove provider acceptance or billing.
      for await (const item of gateway({configuration: {...configuration}, apiKey, messages: structuredClone(messages), signal: state.controller.signal, selfPort: selfPort(), beforeSubmit})) {
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
  const schedule = operation => {
    try { checkOpen(); } catch (error) { return Promise.reject(error); }
    const result = tail.then(() => { checkOpen(); return operation(); });
    tail = result.catch(() => {}); return result;
  };
  function historyPage(projectId, before = null) {
    checkOpen(); checkProject(projectId);
    if (before !== null && !uuid(before)) throw agentChatError('AGENT_CHAT_VALIDATION');
    const conv = access(() => journal.thread(projectId)), page = access(() => journal.page(projectId, before));
    return {instanceId, threadId: conv.id, projectId, revision: conv.revision, runs: page.runs.map(publicRun), historyCursor: page.historyCursor};
  }
  function editAccess(projectId) {
    checkOpen(); checkProject(projectId);
    if (!editService) throw agentChatError('AGENT_CHAT_TOOLS_UNSUPPORTED');
  }
  function editMutation(method, projectId, proposalId, input) {
    editAccess(projectId);
    if (!exactObject(input, ['instanceId', 'digest']) || !uuid(proposalId) || typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.digest)) throw agentChatError('AGENT_CHAT_VALIDATION');
    checkInstance(input.instanceId);
    const proposal = editService.get({projectId, proposalId});
    const run = access(() => journal.get(projectId, proposal.runId));
    if (['approve', 'recover'].includes(method) && run?.status !== 'completed') throw chatRuntimeError('AGENT_EDIT_RUN_INCOMPLETE');
    return Promise.resolve(editService[method]({projectId, proposalId, digest: input.digest})).then(proposal => ({instanceId, projectId, proposal}));
  }
  return Object.freeze({
    async snapshot(projectId) {
      checkOpen(); checkProject(projectId);
      let settings;
      try { settings = sanitizeAgentSettingsResult(await bounded(() => agentSettings.get({selfPort: selfPort()}), shutdown.signal)); }
      catch { checkOpen(); throw chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE'); }
      const page = historyPage(projectId);
      return {...page, scope: editService?.pinTimelineTarget ? 'chat_and_reviewed_timeline_edits' : editService ? 'chat_and_reviewed_shot_edits' : 'chat_and_project_inspection', persistence: 'local_database', mode: modeName, settings,
        authorization:authorizations?authorizations.snapshot(settings.configuration):{revision:0,scopes:[]},
        inspection: readToolCapability(inspectionAvailable(projectId, settings.configuration)),
        edit: editToolCapability(editAvailable(projectId, settings.configuration)),
        timelineEdit: timelineEditToolCapability(timelineEditAvailable(projectId, settings.configuration)),
        timelineGainEdit: timelineGainEditToolCapability(timelineGainAvailable(projectId, settings.configuration))};
    },
    send(projectId, value) {
      let input;
      try { input = parseSend(value); } catch (error) { return Promise.reject(error); }
      return schedule(async () => {
        // Authorization and epoch checks precede every idempotent replay.
        checkProject(projectId); checkInstance(input.instanceId);
        const fingerprint = createHash('sha256').update(JSON.stringify({projectId, ...input})).digest('hex');
        const prior = access(() => journal.request(input.requestId));
        if (prior) {
          if (prior.projectId !== projectId || prior.fingerprint !== fingerprint) throw chatRuntimeError('AGENT_CHAT_IDEMPOTENCY_CONFLICT');
          const run = access(() => journal.get(projectId, prior.runId));
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
        const useInspection = input.consent.context === 'project_inspection', useEdit = input.consent.context === 'selected_shot_edit',
          useTimelineEdit = input.consent.context === AGENT_TIMELINE_MOVE_CONTEXT, useTimelineGain = input.consent.context === AGENT_TIMELINE_GAIN_CONTEXT;
        const useProposal = useEdit || useTimelineEdit || useTimelineGain;
        if (useInspection && !inspectionConsentMatches(input.consent, projectId, inspectionAvailable(projectId, configuration))) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        if (useEdit && !editConsentMatches(input.consent, projectId, editAvailable(projectId, configuration))) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        if (useTimelineEdit && !timelineEditConsentMatches(input.consent, projectId, timelineEditAvailable(projectId, configuration))) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        if (useTimelineGain && !timelineGainConsentMatches(input.consent, projectId, timelineGainAvailable(projectId, configuration))) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        const target = useTimelineGain ? editService.pinTimelineGainTarget(projectId, {timelineId: input.consent.timelineId, clipId: input.consent.clipId, expectedRevision: input.consent.expectedRevision}) : useTimelineEdit ? editService.pinTimelineTarget(projectId, {timelineId: input.consent.timelineId, clipId: input.consent.clipId, expectedRevision: input.consent.expectedRevision}) :
          useEdit ? editService.pinTarget(projectId, {shotId: input.consent.shotId, expectedRevision: input.consent.expectedRevision}) : undefined;
        if (useTimelineGain && !isDeepStrictEqual(input.consent.reviewTarget, agentTimelineGainReviewTarget(target))) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        requireAuthorization(configuration,input.consent.context);
        const {messages, sourceRunIds} = selectChatContext(access(() => journal.page(projectId)).runs, input.message, input.consent.context, CHAT_LIMITS, target);
        const execution = useInspection || useProposal ? {version: 1, policy: useTimelineGain ? timelineGainEditToolPolicy(projectId) : useTimelineEdit ? timelineEditToolPolicy(projectId) : useEdit ? editToolPolicy(projectId) : readToolPolicy(projectId), ...(useProposal ? {target} : {}), request: {protocol: configuration.protocol,
          body: buildAgentRequest({configuration, messages, readTools: {phase: 'request', ...(useProposal ? {scope: input.consent.context} : {})}, selfPort: selfPort()}).body,
          context: messages, provenance: {category: useTimelineGain ? AGENT_TIMELINE_GAIN_PROVENANCE : useTimelineEdit ? AGENT_TIMELINE_MOVE_PROVENANCE : useEdit ? 'project_selected_shot_text' : 'project_saved_text_metadata', projectId, sourceRunIds}}} : undefined;
        const saved = access(() => journal.accept({projectId, requestId: input.requestId, fingerprint, instanceId, configuration, messages, consent: input.consent, input, ...(execution ? {execution} : {})}));
        const state = {id: saved.run.id, projectId, controller: new AbortController(), fenced: false,
          pending: '', pendingBytes: 0, receivedBytes: 0, timer: null, flushTimer: null, execution, authorizationScope:input.consent.context};
        active.set(state.id, state);
        publish(saved.events);
        state.timer = setTimeout(() => { if (live(state)) terminal(state, 'failed', agentChatError('AGENT_CHAT_TIMEOUT')); }, CHAT_LIMITS.runMs);
        // Acceptance, exact context and initial event are already durable before
        // acknowledgement and before even credential acquisition can begin.
        void execute(state, Object.freeze({...configuration}), messages, settings.revision);
        return {...runResponse(access(() => journal.get(projectId, saved.run.id))), replayed: false};
      });
    },
    editList(projectId, options = {}) {
      editAccess(projectId);
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['limit', 'cursor', 'view'].includes(key))) throw agentChatError('AGENT_CHAT_VALIDATION');
      return {instanceId, projectId, ...editService.list({...options, projectId})};
    },
    editGet(projectId, proposalId) {
      editAccess(projectId);
      return {instanceId, projectId, proposal: editService.get({projectId, proposalId})};
    },
    editApprove(projectId, proposalId, input) { return editMutation('approve', projectId, proposalId, input); },
    editReject(projectId, proposalId, input) { return editMutation('reject', projectId, proposalId, input); },
    editRecover(projectId, proposalId, input) { return editMutation('recover', projectId, proposalId, input); },
    get(projectId, runId, supplied) { return runResponse(getRun(projectId, runId, supplied)); },
    lookup(projectId, requestId) {
      checkOpen(); checkProject(projectId);
      if (!uuid(requestId)) throw agentChatError('AGENT_CHAT_VALIDATION');
      const run = access(() => journal.lookup(projectId, requestId));
      if (!run) throw chatRuntimeError('AGENT_CHAT_NOT_FOUND');
      return runResponse(run);
    },
    history(projectId, options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'before')) throw agentChatError('AGENT_CHAT_VALIDATION');
      return historyPage(projectId, options.before ?? null);
    },
    stop(projectId, runId, input) {
      if (!exactObject(input, ['instanceId'])) throw agentChatError('AGENT_CHAT_VALIDATION');
      const run = getRun(projectId, runId, input.instanceId);
      terminal(active.get(run.id), 'stopped');
      // An explicit Stop racing with completion still withdraws its unapproved proposal.
      if (['selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(run.contextMode)) access(() => editService?.cancelRun(run.id));
      checkOpen();
      return runResponse(access(() => journal.get(projectId, runId)));
    },
    subscribe(projectId, runId, supplied, after, listener, onClose) {
      const run = getRun(projectId, runId, supplied);
      if (!revision(after) || typeof listener !== 'function' || onClose !== undefined && typeof onClose !== 'function') throw agentChatError('AGENT_CHAT_VALIDATION');
      const entries = watchers.get(runId) || new Set();
      if (subscribers >= CHAT_LIMITS.subscribers || entries.size >= CHAT_LIMITS.subscribersPerRun) throw chatRuntimeError('AGENT_CHAT_BUSY');
      let replay = after >= run.lastEventId ? null : access(() => journal.replay(runId, after));
      if (!replay?.length) replay = [eventSnapshot(run)];
      const entry = {listener, detached: false, detach: null};
      entry.detach = () => {
        if (entry.detached) return;
        entry.detached = true; entries.delete(entry); subscribers--;
        if (!entries.size) watchers.delete(runId);
        try { onClose?.(); } catch { /* Closing a subscriber cannot mutate a run. */ }
      };
      subscribers++; entries.add(entry); watchers.set(runId, entries);
      try { for (const event of replay) { if (entry.detached) break; listener(publicEvent(event)); } }
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
