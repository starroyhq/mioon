import {createHash, randomUUID} from 'node:crypto';
import {agentChatError} from './chat-errors.mjs';
import {exactObject, parseAgentConfiguration} from './config.mjs';
import {createChatStepJournal, validateInspectionRunFields} from './chat-step-journal.mjs';

export const CHAT_JOURNAL_LIMITS = Object.freeze({runs: 2048, bytes: 64 * 1024 * 1024,
  projects: 32, active: 4, terminalReserveBytes: 2 * 1024 * 1024, pageRuns: 16, replayEvents: 256, replayBytes: 64 * 1024});
const now = () => new Date().toISOString();
const encode = value => JSON.stringify(value);
// Account serialized payload and conservative per-row/index overhead, not the
// SQLite file's physical size (WAL/free pages also depend on SQLite maintenance).
const bytes = value => Buffer.byteLength(value) + 512;
const capacity = () => agentChatError('AGENT_CHAT_STORAGE_LIMIT');
const notFound = () => agentChatError('AGENT_CHAT_NOT_FOUND');
const unavailable = () => agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
const MAX_RUN_JSON_BYTES = 1024 * 1024;
const SELECT_RUN = `SELECT id,projectId,threadId,requestId,position,status,bytes,
 CASE WHEN length(CAST(data AS BLOB))<=${MAX_RUN_JSON_BYTES} THEN data ELSE NULL END AS data FROM agent_chat_runs`;
function parsePersisted(data) {
  if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_RUN_JSON_BYTES) throw unavailable();
  try { return JSON.parse(data); } catch { throw unavailable(); }
}
function validateRun(run, identity) {
  if (!plain(run) || !uuid(run.id) || !uuid(run.requestId) || !uuid(run.threadId) || !uuid(run.modelRequestId) ||
    typeof run.projectId !== 'string' || !run.projectId || run.projectId.length > 200 ||
    !['running', 'completed', 'failed', 'stopped', 'interrupted'].includes(run.status) ||
    typeof run.userText !== 'string' || !run.userText.trim() || Buffer.byteLength(run.userText) > 8192 ||
    typeof run.assistantText !== 'string' || Buffer.byteLength(run.assistantText) > 128 * 1024 ||
    !timestamp(run.createdAt) || !timestamp(run.updatedAt) || !integer(run.lastEventId, 1) ||
    !['not_started', 'dispatch_started', 'completed', 'unknown'].includes(run.modelRequestState) ||
    (run.modelRequestState === 'not_started' ? Object.hasOwn(run, 'modelRequestStartedAt') : !timestamp(run.modelRequestStartedAt)) ||
    (run.status === 'completed') !== (run.modelRequestState === 'completed') ||
    run.status === 'running' && !['not_started', 'dispatch_started'].includes(run.modelRequestState) ||
    Object.hasOwn(run, 'error') && (!exactObject(run.error, ['code', 'message', 'details', 'retryable']) ||
      typeof run.error.code !== 'string' || run.error.code.length > 100 || typeof run.error.message !== 'string' ||
      Buffer.byteLength(run.error.message) > 4096 || !exactObject(run.error.details, []) || run.error.retryable !== false)) throw unavailable();
  for (const key of ['id', 'projectId', 'threadId', 'requestId', 'status']) {
    if (identity && run[key] !== identity[key]) throw unavailable();
  }
  try { parseAgentConfiguration(run.configuration); } catch { throw unavailable(); }
  validateInspectionRunFields(run);
  return run;
}


/** An empty conversation has a stable local identity without a GET-side write.
 * Identity is not authority: every access still checks project ownership. */
export function chatThreadId(projectId) {
  const hex = createHash('sha256').update('mioon:typed-chat:v1\0').update(projectId).digest('hex').slice(0, 32).split('');
  hex[12] = '8'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Synchronous SQLite journal, deliberately independent of settings, secrets,
 * gateways and business dispatch. Trusted limit injection is only for tests. */
export function createChatJournal({store, limits = CHAT_JOURNAL_LIMITS, onRunTerminalInside}) {
  if (!store?.db || typeof store.tx !== 'function') throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
  const db = store.db, bounds = {...CHAT_JOURNAL_LIMITS, ...limits};
  const row = id => db.prepare(`${SELECT_RUN} WHERE id=?`).get(id);
  const read = value => {
    if (!value) return null;
    const run = validateRun(parsePersisted(value.data), value);
    const accepted = db.prepare('SELECT q.runId,q.projectId,q.threadId,t.projectId AS threadProjectId FROM agent_chat_requests q JOIN agent_chat_threads t ON t.id=q.threadId WHERE q.requestId=?').get(run.requestId);
    if (!accepted || accepted.runId !== run.id || accepted.projectId !== run.projectId || accepted.threadId !== run.threadId ||
      accepted.threadProjectId !== run.projectId || run.threadId !== chatThreadId(run.projectId) || !integer(value.position, 1) || !integer(value.bytes)) throw unavailable();
    stepJournal.validate(run);
    return run;
  };
  const quota = () => db.prepare('SELECT * FROM agent_chat_quota WHERE id=1').get();
  const thread = projectId => {
    const value = db.prepare('SELECT * FROM agent_chat_threads WHERE projectId=?').get(projectId) ||
      {id: chatThreadId(projectId), projectId, revision: 0, nextPosition: 1};
    if (value.id !== chatThreadId(projectId) || value.projectId !== projectId || !integer(value.revision) || !integer(value.nextPosition, 1)) throw unavailable();
    return value;
  };
  function account(delta, reserveDelta = 0, runDelta = 0) {
    const current = quota(), nextBytes = current.bytes + delta, reserved = current.reservedBytes + reserveDelta;
    if (nextBytes < 0 || reserved < 0 || nextBytes + reserved > bounds.bytes || current.runs + runDelta > bounds.runs) throw capacity();
    db.prepare('UPDATE agent_chat_quota SET bytes=?,reservedBytes=?,runs=? WHERE id=1').run(nextBytes, reserved, current.runs + runDelta);
  }
  const revision = projectId => thread(projectId).revision;
  function saveRun(previous, run) {
    const data = encode(run), size = bytes(data);
    db.prepare('UPDATE agent_chat_runs SET status=?,data=?,bytes=? WHERE id=?').run(run.status, data, size, run.id);
    return size - previous.bytes;
  }
  function appendEvent(run, type, rev, text) {
    const event = {id: run.lastEventId, type, threadId: run.threadId, projectId: run.projectId, runId: run.id,
      revision: rev, ...(type === 'delta' ? {text} : {run: structuredClone(run)})};
    const data = encode(event), size = bytes(data);
    db.prepare('INSERT INTO agent_chat_events(runId,seq,data,bytes) VALUES(?,?,?,?)').run(run.id, event.id, data, size);
    return {event, bytes: size};
  }
  function finishInside(previous, status, error, pendingText = '') {
    const run = read(previous);
    if (run.status !== 'running') return {run, revision: revision(run.projectId), events: []};
    const rev = revision(run.projectId) + 1, events = [];
    let delta = stepJournal.finish(run, status);
    if (pendingText) {
      run.assistantText += pendingText; run.updatedAt = now(); run.lastEventId++;
      const appended = appendEvent(run, 'delta', rev - 1, pendingText); delta += appended.bytes; events.push(appended.event);
    }
    run.status = status; run.updatedAt = now(); run.lastEventId++;
    if (error) run.error = structuredClone(error);
    if (run.modelRequestState === 'dispatch_started') run.modelRequestState = status === 'completed' ? 'completed' : 'unknown';
    const appended = appendEvent(run, 'terminal', rev); delta += appended.bytes; events.push(appended.event);
    delta += saveRun(previous, run);
    db.prepare('UPDATE agent_chat_threads SET revision=? WHERE id=?').run(rev, run.threadId);
    account(delta, -bounds.terminalReserveBytes);
    onRunTerminalInside?.(structuredClone(run));
    return {run, revision: rev, events};
  }
  const stepJournal = createChatStepJournal({store, readRun: read, row, account, saveRun, appendEvent, revision});
  return Object.freeze({
    steps: stepJournal.steps,
    modelDispatch: stepJournal.modelDispatch,
    modelComplete: stepJournal.modelComplete,
    toolIntent: stepJournal.toolIntent,
    captureTool: stepJournal.captureTool,
    prepareContinuation: stepJournal.prepareContinuation,
    thread,
    request(requestId) { return db.prepare('SELECT projectId,runId,fingerprint FROM agent_chat_requests WHERE requestId=?').get(requestId) || null; },
    get(projectId, id) { return read(db.prepare(`${SELECT_RUN} WHERE projectId=? AND id=?`).get(projectId, id)); },
    lookup(projectId, requestId) {
      const accepted = db.prepare('SELECT runId FROM agent_chat_requests WHERE projectId=? AND requestId=?').get(projectId, requestId);
      if (!accepted) return null;
      const run = read(row(accepted.runId));
      if (!run || run.projectId !== projectId || run.requestId !== requestId) throw unavailable();
      return run;
    },
    active(projectId) { return db.prepare('SELECT id FROM agent_chat_runs WHERE projectId=? AND status=\'running\'').get(projectId)?.id || null; },
    activeCount() { return db.prepare('SELECT count(*) count FROM agent_chat_runs WHERE status=\'running\'').get().count; },
    page(projectId, before = null) {
      let position = Number.MAX_SAFE_INTEGER;
      if (before !== null) {
        const cursor = db.prepare('SELECT position FROM agent_chat_runs WHERE projectId=? AND id=?').get(projectId, before);
        if (!cursor) throw notFound();
        position = cursor.position;
      }
      // LIMIT is applied in SQLite before parsing/materializing chat content.
      const rows = db.prepare(`${SELECT_RUN} WHERE projectId=? AND position<? ORDER BY position DESC LIMIT ?`).all(projectId, position, bounds.pageRuns + 1);
      const more = rows.length > bounds.pageRuns;
      if (more) rows.pop();
      rows.reverse();
      return {runs: rows.map(read), historyCursor: more ? rows[0].id : null};
    },
    replay(runId, after) {
      // Keeping all accepted events does not mean returning unbounded replay.
      const current = read(row(runId));
      if (!current) throw unavailable();
      const rows = db.prepare(`SELECT runId,seq,bytes, CASE WHEN length(CAST(data AS BLOB))<=${MAX_RUN_JSON_BYTES} THEN data ELSE NULL END AS data FROM agent_chat_events WHERE runId=? AND seq>? ORDER BY seq LIMIT ?`).all(runId, after, bounds.replayEvents + 1);
      if (rows.length > bounds.replayEvents || rows.reduce((sum, entry) => sum + entry.bytes, 0) > bounds.replayBytes) return null;
      return rows.map((entry, index) => {
        const event = parsePersisted(entry.data);
        if (!plain(event) || entry.runId !== runId || event.runId !== runId || event.id !== entry.seq || event.id !== after + index + 1 ||
          event.projectId !== current.projectId || event.threadId !== current.threadId || !integer(event.revision) ||
          !['snapshot', 'delta', 'terminal'].includes(event.type)) throw unavailable();
        if (event.type === 'delta') {
          if (typeof event.text !== 'string' || Buffer.byteLength(event.text) > 2048 || Object.hasOwn(event, 'run')) throw unavailable();
        } else {
          validateRun(event.run, {...current, status: event.run?.status});
          if (event.run.lastEventId !== event.id || event.type === 'terminal' && event.run.status === 'running' ||
            event.run.modelRequestId !== current.modelRequestId || event.run.userText !== current.userText ||
            encode(event.run.configuration) !== encode(current.configuration) || event.run.contextMode !== current.contextMode ||
            encode(event.run.provenance) !== encode(current.provenance) || encode(event.run.editTarget) !== encode(current.editTarget)) throw unavailable();
          if (['project_inspection', 'selected_shot_edit'].includes(current.contextMode) && event.run.activity.some((item, index) => {
            const durable = current.activity[index];
            return !durable || ['id', 'kind', 'ordinal', 'name', 'operation'].some(key => item[key] !== durable[key]) ||
              Object.hasOwn(item, 'resultJson') && item.resultJson !== durable.resultJson;
          })) throw unavailable();
        }
        return event;
      });
    },
    accept({projectId, requestId, fingerprint, instanceId, configuration, messages, consent, input, execution}) {
      if (execution === undefined && consent?.context !== 'typed_chat_only') throw unavailable();
      return store.tx(() => {
        let conv = thread(projectId), threadBytes = 0;
        if (!db.prepare('SELECT 1 FROM agent_chat_threads WHERE id=?').get(conv.id)) {
          if (db.prepare('SELECT count(*) count FROM agent_chat_threads').get().count >= bounds.projects) throw capacity();
          db.prepare('INSERT INTO agent_chat_threads(id,projectId,revision,nextPosition) VALUES(?,?,0,1)').run(conv.id, projectId);
          threadBytes = bytes(encode(conv));
        }
        if (this.active(projectId) || this.activeCount() >= bounds.active) throw agentChatError('AGENT_CHAT_BUSY');
        const createdAt = now(), id = randomUUID();
        const run = {id, requestId, threadId: conv.id, projectId, status: 'running', userText: input.message, assistantText: '',
          configuration: structuredClone(configuration), createdAt, updatedAt: createdAt, lastEventId: 1,
          modelRequestId: randomUUID(), modelRequestState: 'not_started'};
        const prepared = execution === undefined ? null : stepJournal.initialize(run, execution);
        // Only explicit, narrow fields enter this immutable acceptance record.
        // Credential acquisition happens later and can never write this record.
        const acceptedData = {version: 1, instanceId, acceptedAt: createdAt,
          expectedSettingsRevision: input.expectedSettingsRevision, expectedConversationRevision: input.expectedConversationRevision,
          configuration, consent, messages, ...(prepared ? {execution: prepared.execution} : {})};
        if (prepared) stepJournal.validateAcceptance(acceptedData, run);
        const acceptance = encode(acceptedData);
        const requestBytes = bytes(acceptance) + bytes(fingerprint), data = encode(run), runBytes = bytes(data);
        db.prepare('INSERT INTO agent_chat_requests(requestId,projectId,threadId,runId,fingerprint,acceptance,bytes) VALUES(?,?,?,?,?,?,?)')
          .run(requestId, projectId, conv.id, id, fingerprint, acceptance, requestBytes);
        db.prepare('INSERT INTO agent_chat_runs(id,projectId,threadId,requestId,position,status,data,bytes) VALUES(?,?,?,?,?,?,?,?)')
          .run(id, projectId, conv.id, requestId, conv.nextPosition, run.status, data, runBytes);
        const stepBytes = prepared ? prepared.insert() : 0;
        const rev = conv.revision + 1;
        db.prepare('UPDATE agent_chat_threads SET revision=?,nextPosition=? WHERE id=?').run(rev, conv.nextPosition + 1, conv.id);
        const appended = appendEvent(run, 'snapshot', rev);
        account(threadBytes + requestBytes + runBytes + appended.bytes + stepBytes, bounds.terminalReserveBytes, 1);
        return {run, ...(prepared ? {step: prepared.step} : {}), revision: rev, events: [appended.event]};
      });
    },
    dispatch(runId) {
      return store.tx(() => {
        const previous = row(runId), run = read(previous);
        if (!run || ['project_inspection', 'selected_shot_edit'].includes(run.contextMode) || run.status !== 'running' || run.modelRequestState !== 'not_started') throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
        // Conservative local boundary BEFORE calling the gateway. This is not
        // evidence that a socket opened, the provider accepted, or billing began.
        run.modelRequestState = 'dispatch_started'; run.modelRequestStartedAt = now();
        account(saveRun(previous, run));
        return run;
      });
    },
    append(runId, text) {
      return store.tx(() => {
        const previous = row(runId), run = read(previous);
        if (!run || run.status !== 'running') throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
        run.assistantText += text; run.updatedAt = now(); run.lastEventId++;
        const rev = revision(run.projectId), appended = appendEvent(run, 'delta', rev, text);
        account(saveRun(previous, run) + appended.bytes);
        return {run, revision: rev, events: [appended.event]};
      });
    },
    finish(runId, status, error, pendingText = '') { return store.tx(() => finishInside(row(runId), status, error, pendingText)); },
    recover() {
      return store.tx(() => {
        const unfinished = db.prepare(`${SELECT_RUN} WHERE status='running' ORDER BY rowid LIMIT ?`).all(bounds.active + 1);
        if (unfinished.length > bounds.active) throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
        return unfinished.map(previous => finishInside(previous, 'interrupted').run);
      });
    },
  });
}
