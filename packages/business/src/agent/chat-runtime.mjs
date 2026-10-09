import {createHash, randomUUID} from 'node:crypto';
import {exactObject, parseAgentConfiguration} from './config.mjs';
import {AGENT_CREDENTIAL_ACQUIRE, sanitizeAgentCredentialResult, sanitizeAgentSettingsResult} from './settings.mjs';
import {AGENT_PROTOCOLS, deriveAgentEndpoint} from '@mioon/contracts';
import {streamAgentResponse, validateAgentGatewayConfiguration} from './agent-gateway.mjs';
import {CHAT_SYSTEM_INSTRUCTION} from './chat-policy.mjs';
export {CHAT_SYSTEM_INSTRUCTION} from './chat-policy.mjs';
import {agentChatError, safeAgentChatError} from './chat-errors.mjs';

export const CHAT_LIMITS = Object.freeze({messageBytes: 8192, responseBytes: 128 * 1024, contextBytes: 32 * 1024,
  historyRuns: 12, projects: 32, runs: 64, runsPerProject: 16, requests: 2048, active: 4,
  events: 256, eventBytes: 64 * 1024, subscribers: 32, subscribersPerRun: 8, runMs: 120000});
const errors = {
  AGENT_CHAT_SESSION_EXPIRED: [409, '对话服务已重新启动；旧会话已失效，请重新读取后明确发送。'],
  AGENT_CHAT_CONVERSATION_CONFLICT: [409, '对话已被另一个窗口更新，请重新读取后确认发送。'],
  AGENT_CHAT_SETTINGS_CONFLICT: [409, '连接设置已改变，请重新读取并确认目标和模型。'],
  AGENT_CHAT_CONSENT_REQUIRED: [409, '请确认当前目标、模型及仅发送输入聊天文字。'],
  AGENT_CHAT_ACTIVE_RUN: [409, '此项目已有回复正在生成，请等待或停止后再发送。'],
  AGENT_CHAT_IDEMPOTENCY_CONFLICT: [409, '此发送标识已用于不同请求；未重复发送。'],
  AGENT_CHAT_RUN_EXPIRED: [410, '这次对话已离开本次服务的有限缓存；不会自动重新发送。'],
  AGENT_CHAT_NOT_FOUND: [404, '项目或这次对话不存在。'],
  AGENT_CHAT_BUSY: [429, '本地对话缓存或并发已达上限，请稍后或重新启动服务后继续。'],
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
    !exactObject(value.consent, ['destination', 'protocol', 'model', 'context']) || typeof value.consent.destination !== 'string' || value.consent.destination.length > 2080 || typeof value.consent.protocol !== 'string' || !Object.hasOwn(AGENT_PROTOCOLS, value.consent.protocol) || typeof value.consent.model !== 'string' || value.consent.model.length > 200 || value.consent.context !== 'typed_chat_only') throw agentChatError('AGENT_CHAT_VALIDATION');
  return {requestId: value.requestId, instanceId: value.instanceId, expectedSettingsRevision: value.expectedSettingsRevision,
    expectedConversationRevision: value.expectedConversationRevision, message: value.message,
    consent: {destination: value.consent.destination, protocol: value.consent.protocol, model: value.consent.model, context: value.consent.context}};
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

/** Backend-session only. Never touches project content or a business dispatcher.
 * Constructor gateway injection is for trusted synthetic QA, never HTTP/env input. */
export function createChatRuntime({store, agentSettings, gateway = streamAgentResponse, selfPort, mode = 'provider'}) {
  const instanceId = randomUUID(), conversations = new Map(), runs = new Map(), requests = new Map();
  const modeName = mode === 'simulated' ? 'simulated' : 'provider';
  let closing = false, subscribers = 0, tail = Promise.resolve();
  const shutdown = new AbortController();
  const checkProject = projectId => {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 200 || !store.get('projects', projectId)) throw chatRuntimeError('AGENT_CHAT_NOT_FOUND');
  };
  const checkInstance = supplied => { if (!uuid(supplied) || supplied !== instanceId) throw chatRuntimeError('AGENT_CHAT_SESSION_EXPIRED'); };
  const conversation = projectId => {
    checkProject(projectId);
    if (!conversations.has(projectId)) {
      if (conversations.size >= CHAT_LIMITS.projects) throw chatRuntimeError('AGENT_CHAT_BUSY');
      conversations.set(projectId, {projectId, revision: 0, runIds: [], activeId: null});
    }
    return conversations.get(projectId);
  };
  const publicRun = run => ({id: run.id, requestId: run.requestId, projectId: run.projectId, status: run.status,
    userText: run.userText, assistantText: run.assistantText, configuration: {...run.configuration},
    createdAt: run.createdAt, updatedAt: run.updatedAt, lastEventId: run.lastEventId,
    ...(run.error ? {error: {...run.error, details: {}}} : {})});
  const runResponse = run => ({instanceId, projectId: run.projectId, revision: conversations.get(run.projectId).revision, run: publicRun(run)});
  const getRun = (projectId, runId, supplied) => {
    checkProject(projectId); checkInstance(supplied);
    const run = runs.get(runId);
    if (!run || run.projectId !== projectId) throw chatRuntimeError('AGENT_CHAT_NOT_FOUND');
    return run;
  };
  function eventSnapshot(run) {
    return {id: run.lastEventId, type: 'snapshot', instanceId, projectId: run.projectId, runId: run.id,
      revision: conversations.get(run.projectId).revision, run: publicRun(run)};
  }
  function emit(run, type, text) {
    run.lastEventId++;
    const event = {id: run.lastEventId, type, instanceId, projectId: run.projectId, runId: run.id,
      revision: conversations.get(run.projectId).revision, ...(type === 'delta' ? {text} : {run: publicRun(run)})};
    const size = Buffer.byteLength(JSON.stringify(event));
    run.events.push({event, size}); run.eventBytes += size;
    while (run.events.length > CHAT_LIMITS.events || run.eventBytes > CHAT_LIMITS.eventBytes) run.eventBytes -= run.events.shift().size;
    for (const listener of [...run.listeners]) { try { listener(structuredClone(event)); } catch { /* Detachment never retries or aborts inference. */ } }
  }
  function terminal(run, status, error) {
    if (run.status !== 'running') return;
    run.status = status; run.updatedAt = new Date().toISOString(); clearTimeout(run.timer);
    if (error) run.error = publicError(error);
    const conv = conversations.get(run.projectId); conv.activeId = null; conv.revision++;
    emit(run, 'terminal');
    run.controller.abort();
    for (const detach of [...run.detachers]) detach();
  }
  function history(conv, message) {
    const selected = [], current = {role: 'user', content: message};
    let bytes = Buffer.byteLength(CHAT_SYSTEM_INSTRUCTION) + Buffer.byteLength(message);
    for (const id of [...conv.runIds].reverse()) {
      const run = runs.get(id);
      if (run.status !== 'completed') continue;
      const pairBytes = Buffer.byteLength(run.userText) + Buffer.byteLength(run.assistantText);
      if (selected.length >= CHAT_LIMITS.historyRuns || bytes + pairBytes > CHAT_LIMITS.contextBytes) break;
      selected.unshift(run); bytes += pairBytes;
    }
    return [{role: 'system', content: CHAT_SYSTEM_INSTRUCTION}, ...selected.flatMap(run => [
      {role: 'user', content: run.userText}, {role: 'assistant', content: run.assistantText}]), current];
  }
  function evictOne(conv) {
    const candidate = conv ? conv.runIds.map(id => runs.get(id)).find(run => run.status !== 'running') : [...runs.values()].find(run => run.status !== 'running');
    if (!candidate) throw chatRuntimeError('AGENT_CHAT_BUSY');
    for (const detach of [...candidate.detachers]) detach();
    const owner = conversations.get(candidate.projectId);
    owner.runIds = owner.runIds.filter(id => id !== candidate.id); runs.delete(candidate.id);
    // Request fingerprints remain as tombstones. An expired run is never resent.
  }
  async function execute(run, messages, expectedSettingsRevision) {
    let apiKey = null;
    try {
      // Reject unsupported protocol/model profiles before touching a credential.
      // This validation never probes, rewrites, or selects another adapter.
      validateAgentGatewayConfiguration(run.configuration, {selfPort: selfPort()});
      const expected = {expectedRevision: expectedSettingsRevision, configuration: run.configuration};
      let credential;
      try {
        if (typeof agentSettings[AGENT_CREDENTIAL_ACQUIRE] !== 'function') throw chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE');
        credential = sanitizeAgentCredentialResult(await bounded(() => agentSettings[AGENT_CREDENTIAL_ACQUIRE](expected, {selfPort: selfPort(), signal: run.controller.signal}), run.controller.signal), expected);
      } catch (error) {
        if (error?.code === 'AGENT_SETTINGS_CONFLICT') throw chatRuntimeError('AGENT_CHAT_SETTINGS_CONFLICT');
        throw chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE');
      }
      if (run.status !== 'running' || closing || run.controller.signal.aborted) return;
      apiKey = credential.apiKey; credential = null;
      if (!apiKey && run.configuration.presetId !== 'ollama') throw agentChatError('AGENT_CHAT_KEY_REQUIRED');
      let done = false;
      // Exactly one generator invocation; never retries on failures, disconnects,
      // missing acknowledgements, malformed output, or provider instructions.
      for await (const item of gateway({configuration: {...run.configuration}, apiKey, messages, signal: run.controller.signal, selfPort: selfPort()})) {
        if (run.status !== 'running' || closing || run.controller.signal.aborted) return;
        if (item?.type === 'done') {
          if (item.finishReason === 'length') throw agentChatError('AGENT_CHAT_TRUNCATED');
          if (item.finishReason === 'content_filter') throw agentChatError('AGENT_CHAT_PROVIDER_ERROR');
          if (item.finishReason !== 'stop') throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
          done = true; break;
        }
        if (item?.type !== 'delta' || typeof item.text !== 'string') throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
        if (Buffer.byteLength(run.assistantText) + Buffer.byteLength(item.text) > CHAT_LIMITS.responseBytes) throw agentChatError('AGENT_CHAT_LIMIT');
        // Bounded public events even if a trusted gateway returns one large delta.
        for (let offset = 0; offset < item.text.length;) {
          let end = Math.min(offset + 1024, item.text.length);
          if (end < item.text.length && /[\uD800-\uDBFF]/u.test(item.text[end - 1])) end--;
          const text = item.text.slice(offset, end); offset = end;
          run.assistantText += text; run.updatedAt = new Date().toISOString(); emit(run, 'delta', text);
          if (run.status !== 'running') return;
        }
      }
      if (run.status !== 'running' || closing) return;
      if (!done) throw agentChatError('AGENT_CHAT_TRUNCATED');
      terminal(run, 'completed');
    } catch (error) {
      if (run.status === 'running' && !closing) terminal(run, 'failed', error);
    } finally { apiKey = null; }
  }
  const schedule = operation => {
    if (closing) return Promise.reject(chatRuntimeError('AGENT_CHAT_CLOSED'));
    const result = tail.then(() => { if (closing) throw chatRuntimeError('AGENT_CHAT_CLOSED'); return operation(); });
    tail = result.catch(() => {}); return result;
  };
  return Object.freeze({
    async snapshot(projectId) {
      if (closing) throw chatRuntimeError('AGENT_CHAT_CLOSED');
      const conv = conversation(projectId);
      let settings;
      try { settings = sanitizeAgentSettingsResult(await bounded(() => agentSettings.get({selfPort: selfPort()}), shutdown.signal)); }
      catch { throw chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE'); }
      checkProject(projectId);
      if (closing) throw chatRuntimeError('AGENT_CHAT_CLOSED');
      return {instanceId, projectId, revision: conv.revision, scope: 'chat_only', persistence: 'session', mode: modeName,
        settings, runs: conv.runIds.map(id => publicRun(runs.get(id)))};
    },
    send(projectId, value) {
      let input;
      try { input = parseSend(value); } catch (error) { return Promise.reject(error); }
      return schedule(async () => {
        // Project and instance checks precede every idempotent replay.
        checkProject(projectId); checkInstance(input.instanceId);
        const fingerprint = createHash('sha256').update(JSON.stringify({projectId, ...input})).digest('hex');
        const prior = requests.get(input.requestId);
        if (prior) {
          if (prior.projectId !== projectId || prior.fingerprint !== fingerprint) throw chatRuntimeError('AGENT_CHAT_IDEMPOTENCY_CONFLICT');
          const run = runs.get(prior.runId);
          if (!run) throw chatRuntimeError('AGENT_CHAT_RUN_EXPIRED');
          return {...runResponse(run), replayed: true};
        }
        const conv = conversation(projectId);
        if (input.expectedConversationRevision !== conv.revision) throw chatRuntimeError('AGENT_CHAT_CONVERSATION_CONFLICT');
        if (conv.activeId) throw chatRuntimeError('AGENT_CHAT_ACTIVE_RUN');
        if (requests.size >= CHAT_LIMITS.requests || [...runs.values()].filter(run => run.status === 'running').length >= CHAT_LIMITS.active) throw chatRuntimeError('AGENT_CHAT_BUSY');
        let settings;
        try { settings = sanitizeAgentSettingsResult(await bounded(() => agentSettings.get({selfPort: selfPort()}), shutdown.signal)); }
        catch { throw chatRuntimeError('AGENT_CHAT_CREDENTIAL_UNAVAILABLE'); }
        checkProject(projectId);
        if (closing) throw chatRuntimeError('AGENT_CHAT_CLOSED');
        if (settings.revision !== input.expectedSettingsRevision) throw chatRuntimeError('AGENT_CHAT_SETTINGS_CONFLICT');
        const configuration = parseAgentConfiguration(settings.configuration, {selfPort: selfPort()});
        if (input.consent.destination !== deriveAgentEndpoint(configuration) || input.consent.protocol !== configuration.protocol || input.consent.model !== configuration.model) throw chatRuntimeError('AGENT_CHAT_CONSENT_REQUIRED');
        const messages = history(conv, input.message);
        while (conv.runIds.length >= CHAT_LIMITS.runsPerProject) evictOne(conv);
        while (runs.size >= CHAT_LIMITS.runs) evictOne();
        const now = new Date().toISOString();
        const run = {id: randomUUID(), requestId: input.requestId, projectId, status: 'running', userText: input.message, assistantText: '',
          configuration: Object.freeze(configuration), createdAt: now, updatedAt: now, lastEventId: 0,
          events: [], eventBytes: 0, listeners: new Set(), detachers: new Set(), controller: new AbortController()};
        runs.set(run.id, run); conv.runIds.push(run.id); conv.activeId = run.id; conv.revision++;
        requests.set(input.requestId, {projectId, fingerprint, runId: run.id});
        emit(run, 'snapshot');
        run.timer = setTimeout(() => terminal(run, 'failed', agentChatError('AGENT_CHAT_TIMEOUT')), CHAT_LIMITS.runMs);
        void execute(run, messages, settings.revision);
        return {...runResponse(run), replayed: false};
      });
    },
    get(projectId, runId, supplied) { return runResponse(getRun(projectId, runId, supplied)); },
    stop(projectId, runId, input) {
      if (!exactObject(input, ['instanceId'])) throw agentChatError('AGENT_CHAT_VALIDATION');
      const run = getRun(projectId, runId, input.instanceId);
      terminal(run, 'stopped'); return runResponse(run);
    },
    subscribe(projectId, runId, supplied, after, listener) {
      if (closing) throw chatRuntimeError('AGENT_CHAT_CLOSED');
      const run = getRun(projectId, runId, supplied);
      if (!revision(after) || typeof listener !== 'function') throw agentChatError('AGENT_CHAT_VALIDATION');
      if (subscribers >= CHAT_LIMITS.subscribers || run.listeners.size >= CHAT_LIMITS.subscribersPerRun) throw chatRuntimeError('AGENT_CHAT_BUSY');
      const first = run.events[0]?.event.id;
      const replay = after === run.lastEventId || first === undefined || after < first - 1 || after > run.lastEventId ? [eventSnapshot(run)] : run.events.filter(entry => entry.event.id > after).map(entry => entry.event);
      let detached = false;
      const detach = () => { if (detached) return; detached = true; run.listeners.delete(listener); run.detachers.delete(detach); subscribers--; };
      subscribers++; run.listeners.add(listener); run.detachers.add(detach);
      try { for (const event of replay) listener(structuredClone(event)); } catch (error) { detach(); throw error; }
      if (run.status !== 'running') detach();
      return detach;
    },
    close() {
      if (closing) return;
      closing = true; shutdown.abort();
      for (const run of runs.values()) terminal(run, 'interrupted');
      // Nothing awaits a stuck provider: callbacks are inert after the terminal
      // transition; abortable credentials and HTTP transport own their cleanup.
    },
  });
}
