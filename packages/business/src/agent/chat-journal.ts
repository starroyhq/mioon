import {AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT} from '@mioon/contracts';
import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {agentChatError} from './chat-errors.ts';
import {exactObject, parseAgentConfiguration} from './config.ts';
import type {AgentConfiguration} from './config.ts';
import {createChatStepJournal, validateInspectionRunFields} from './chat-step-journal.ts';
import type {ChatStep} from './chat-step-journal.ts';

export const CHAT_JOURNAL_LIMITS = Object.freeze({runs: 2048, bytes: 64 * 1024 * 1024,
  projects: 32, active: 4, terminalReserveBytes: 2 * 1024 * 1024, pageRuns: 16, replayEvents: 256, replayBytes: 64 * 1024});
const now = (): string => new Date().toISOString();
const encode = (value: unknown): string => JSON.stringify(value);
// Account serialized payload and conservative per-row/index overhead, not the
// SQLite file's physical size (WAL/free pages also depend on SQLite maintenance).
const bytes = (value: string): number => Buffer.byteLength(value) + 512;
function capacity(): never { throw agentChatError('AGENT_CHAT_STORAGE_LIMIT'); }
function notFound(): never { throw agentChatError('AGENT_CHAT_NOT_FOUND'); }
function unavailable(): never { throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE'); }
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));

export interface ChatProvenance {category: string; projectId: string; sourceRunIds: string[]}
export interface ChatActivityEntry {
  id: string;
  kind: string;
  ordinal: number;
  status: string;
  name?: string;
  operation?: string;
  resultJson?: string;
  [key: string]: unknown;
}
export interface ChatError {code: string; message: string; details: Record<string, unknown>; retryable: false}
export interface ChatRun {
  id: string;
  requestId: string;
  threadId: string;
  modelRequestId: string;
  projectId: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
  userText: string;
  assistantText: string;
  configuration: AgentConfiguration;
  createdAt: string;
  updatedAt: string;
  lastEventId: number;
  modelRequestState: 'not_started' | 'dispatch_started' | 'completed' | 'unknown';
  modelRequestStartedAt?: string;
  error?: ChatError;
  contextMode?: string;
  provenance?: ChatProvenance;
  activity?: ChatActivityEntry[];
  editTarget?: unknown;
  [key: string]: unknown;
}
export interface ChatStoredEvent {
  id: number;
  type: 'snapshot' | 'delta' | 'terminal';
  threadId: string;
  projectId: string;
  runId: string;
  revision: number;
  text?: string;
  run?: ChatRun;
}
export interface ChatJournalStore {db: DatabaseSync; tx<T>(operation: () => T): T}
export interface ChatJournalResult {run: ChatRun; step?: ChatStep; revision: number; events: ChatStoredEvent[]}
export interface ChatJournalAppendResult {run: ChatRun; revision: number; events: ChatStoredEvent[]}
interface RunRow {id: string; projectId: string; threadId: string; requestId: string; position: number; status: string; bytes: number; data: string | null}
interface QuotaRow {bytes: number; reservedBytes: number; runs: number}
interface ThreadRow {id: string; projectId: string; revision: number; nextPosition: number}
interface RequestRow {projectId: string; runId: string; fingerprint: string; threadId?: string}
interface EventRow {runId: string; seq: number; bytes: number; data: string | null}
interface CursorRow {position: number}
interface AcceptedRow {runId: string; projectId: string; threadId: string; threadProjectId: string}
interface PageRunRow extends RunRow {}

const MAX_RUN_JSON_BYTES = 1024 * 1024;
const SELECT_RUN = `SELECT id,projectId,threadId,requestId,position,status,bytes,
 CASE WHEN length(CAST(data AS BLOB))<=${MAX_RUN_JSON_BYTES} THEN data ELSE NULL END AS data FROM agent_chat_runs`;
function parsePersisted(data: unknown): unknown {
  if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_RUN_JSON_BYTES) throw unavailable();
  try { return JSON.parse(data); } catch { throw unavailable(); }
}
const identityFields = ['id', 'projectId', 'threadId', 'requestId', 'status'] as const;
function validateRun(run: unknown, identity: Partial<Record<typeof identityFields[number], string>> | null = null): ChatRun {
  if (!plain(run) || !uuid(run.id) || !uuid(run.requestId) || !uuid(run.threadId) || !uuid(run.modelRequestId) ||
    typeof run.projectId !== 'string' || !run.projectId || run.projectId.length > 200 ||
    !['running', 'completed', 'failed', 'stopped', 'interrupted'].includes(run.status as string) ||
    typeof run.userText !== 'string' || !run.userText.trim() || Buffer.byteLength(run.userText) > 8192 ||
    typeof run.assistantText !== 'string' || Buffer.byteLength(run.assistantText) > 128 * 1024 ||
    !timestamp(run.createdAt) || !timestamp(run.updatedAt) || !integer(run.lastEventId, 1) ||
    !['not_started', 'dispatch_started', 'completed', 'unknown'].includes(run.modelRequestState as string) ||
    (run.modelRequestState === 'not_started' ? Object.hasOwn(run, 'modelRequestStartedAt') : !timestamp(run.modelRequestStartedAt)) ||
    (run.status === 'completed') !== (run.modelRequestState === 'completed') ||
    run.status === 'running' && !['not_started', 'dispatch_started'].includes(run.modelRequestState as string) ||
    Object.hasOwn(run, 'error') && (!exactObject(run.error, ['code', 'message', 'details', 'retryable']) ||
      typeof run.error.code !== 'string' || run.error.code.length > 100 || typeof run.error.message !== 'string' ||
      Buffer.byteLength(run.error.message) > 4096 || !exactObject(run.error.details, []) || run.error.retryable !== false)) throw unavailable();
  for (const key of identityFields) {
    if (identity && run[key] !== identity[key]) throw unavailable();
  }
  try { parseAgentConfiguration(run.configuration); } catch { throw unavailable(); }
  validateInspectionRunFields(run as ChatRun);
  return run as ChatRun;
}

/** An empty conversation has a stable local identity without a GET-side write.
 * Identity is not authority: every access still checks project ownership. */
export function chatThreadId(projectId: string): string {
  const hex = createHash('sha256').update('mioon:typed-chat:v1\0').update(projectId).digest('hex').slice(0, 32).split('');
  hex[12] = '8'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Synchronous SQLite journal, deliberately independent of settings, secrets,
 * gateways and business dispatch. Trusted limit injection is only for tests. */
export function createChatJournal({store, limits = CHAT_JOURNAL_LIMITS, onRunTerminalInside}: {store: ChatJournalStore; limits?: Record<string, number>; onRunTerminalInside?: (run: ChatRun) => void}) {
  if (!store?.db || typeof store.tx !== 'function') throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
  const db = store.db, bounds = {...CHAT_JOURNAL_LIMITS, ...limits};
  const row = (id: string): unknown => db.prepare(`${SELECT_RUN} WHERE id=?`).get(id);
  const read = (value: unknown): ChatRun | null => {
    if (!value) return null;
    const stored = value as RunRow;
    const run = validateRun(parsePersisted(stored.data), value as Partial<Record<typeof identityFields[number], string>>);
    const accepted = db.prepare('SELECT q.runId,q.projectId,q.threadId,t.projectId AS threadProjectId FROM agent_chat_requests q JOIN agent_chat_threads t ON t.id=q.threadId WHERE q.requestId=?').get(run.requestId) as AcceptedRow | undefined;
    if (!accepted || accepted.runId !== run.id || accepted.projectId !== run.projectId || accepted.threadId !== run.threadId ||
      accepted.threadProjectId !== run.projectId || run.threadId !== chatThreadId(run.projectId) || !integer(stored.position, 1) || !integer(stored.bytes)) throw unavailable();
    stepJournal.validate(run);
    return run;
  };
  const quota = (): QuotaRow => db.prepare('SELECT * FROM agent_chat_quota WHERE id=1').get() as unknown as QuotaRow;
  const thread = (projectId: string): ThreadRow => {
    const value = (db.prepare('SELECT * FROM agent_chat_threads WHERE projectId=?').get(projectId) as ThreadRow | undefined) ||
      {id: chatThreadId(projectId), projectId, revision: 0, nextPosition: 1};
    if (value.id !== chatThreadId(projectId) || value.projectId !== projectId || !integer(value.revision) || !integer(value.nextPosition, 1)) throw unavailable();
    return value;
  };
  function account(delta: number, reserveDelta = 0, runDelta = 0): void {
    const current = quota(), nextBytes = current.bytes + delta, reserved = current.reservedBytes + reserveDelta;
    if (nextBytes < 0 || reserved < 0 || nextBytes + reserved > bounds.bytes || current.runs + runDelta > bounds.runs) throw capacity();
    db.prepare('UPDATE agent_chat_quota SET bytes=?,reservedBytes=?,runs=? WHERE id=1').run(nextBytes, reserved, current.runs + runDelta);
  }
  const revision = (projectId: string): number => thread(projectId).revision;
  function saveRun(previous: {bytes: number}, run: ChatRun): number {
    const data = encode(run), size = bytes(data);
    db.prepare('UPDATE agent_chat_runs SET status=?,data=?,bytes=? WHERE id=?').run(run.status, data, size, run.id);
    return size - previous.bytes;
  }
  function appendEvent(run: ChatRun, type: 'snapshot' | 'delta' | 'terminal', rev: number, text?: string): {event: ChatStoredEvent; bytes: number} {
    const event = {id: run.lastEventId, type, threadId: run.threadId, projectId: run.projectId, runId: run.id,
      revision: rev, ...(type === 'delta' ? {text} : {run: structuredClone(run)})};
    const data = encode(event), size = bytes(data);
    db.prepare('INSERT INTO agent_chat_events(runId,seq,data,bytes) VALUES(?,?,?,?)').run(run.id, event.id, data, size);
    return {event: event as ChatStoredEvent, bytes: size};
  }
  function finishInside(previous: RunRow, status: ChatRun['status'], error?: ChatError, pendingText = ''): ChatJournalAppendResult {
    const run = read(previous);
    if (!run) throw unavailable();
    if (run.status !== 'running') return {run, revision: revision(run.projectId), events: []};
    const rev = revision(run.projectId) + 1, events: ChatStoredEvent[] = [];
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
    steps(projectId: string, runId: string): ChatStep[] { return stepJournal.steps(projectId, runId); },
    modelDispatch(runId: string, stepId: string) { return stepJournal.modelDispatch(runId, stepId); },
    modelComplete(runId: string, stepId: string, supplied: unknown) { return stepJournal.modelComplete(runId, stepId, supplied); },
    toolIntent(runId: string, modelStepId: string, supplied: unknown) { return stepJournal.toolIntent(runId, modelStepId, supplied); },
    captureTool(runId: string, stepId: string, dispatch: () => unknown) { return stepJournal.captureTool(runId, stepId, dispatch); },
    prepareContinuation(runId: string, supplied: unknown) { return stepJournal.prepareContinuation(runId, supplied); },
    thread,
    request(requestId: string): RequestRow | null { return (db.prepare('SELECT projectId,runId,fingerprint,threadId FROM agent_chat_requests WHERE requestId=?').get(requestId) as RequestRow | undefined) || null; },
    get(projectId: string, id: string): ChatRun | null { return read(db.prepare(`${SELECT_RUN} WHERE projectId=? AND id=?`).get(projectId, id)); },
    lookup(projectId: string, requestId: string): ChatRun | null {
      const accepted = db.prepare('SELECT runId FROM agent_chat_requests WHERE projectId=? AND requestId=?').get(projectId, requestId) as {runId: string} | undefined;
      if (!accepted) return null;
      const run = read(row(accepted.runId));
      if (!run || run.projectId !== projectId || run.requestId !== requestId) throw unavailable();
      return run;
    },
    active(projectId: string): string | null { return (db.prepare('SELECT id FROM agent_chat_runs WHERE projectId=? AND status=\'running\'').get(projectId) as {id: string} | undefined)?.id || null; },
    activeCount(): number { return (db.prepare('SELECT count(*) count FROM agent_chat_runs WHERE status=\'running\'').get() as {count: number}).count; },
    page(projectId: string, before: string | null = null): {runs: ChatRun[]; historyCursor: string | null} {
      let position = Number.MAX_SAFE_INTEGER;
      if (before !== null) {
        const cursor = db.prepare('SELECT position FROM agent_chat_runs WHERE projectId=? AND id=?').get(projectId, before) as CursorRow | undefined;
        if (!cursor) throw notFound();
        position = cursor.position;
      }
      // LIMIT is applied in SQLite before parsing/materializing chat content.
      const rows = db.prepare(`${SELECT_RUN} WHERE projectId=? AND position<? ORDER BY position DESC LIMIT ?`).all(projectId, position, bounds.pageRuns + 1) as unknown as PageRunRow[];
      const more = rows.length > bounds.pageRuns;
      if (more) rows.pop();
      rows.reverse();
      const runs: ChatRun[] = [];
      for (const entry of rows) { const run = read(entry); if (run) runs.push(run); }
      return {runs, historyCursor: more ? rows[0].id : null};
    },
    replay(runId: string, after: number): ChatStoredEvent[] | null {
      // Keeping all accepted events does not mean returning unbounded replay.
      const current = read(row(runId));
      if (!current) throw unavailable();
      const rows = db.prepare(`SELECT runId,seq,bytes, CASE WHEN length(CAST(data AS BLOB))<=${MAX_RUN_JSON_BYTES} THEN data ELSE NULL END AS data FROM agent_chat_events WHERE runId=? AND seq>? ORDER BY seq LIMIT ?`).all(runId, after, bounds.replayEvents + 1) as unknown as EventRow[];
      if (rows.length > bounds.replayEvents || rows.reduce((sum, entry) => sum + entry.bytes, 0) > bounds.replayBytes) return null;
      return rows.map((entry, index) => {
        const parsed = parsePersisted(entry.data);
        if (!plain(parsed)) throw unavailable();
        if (entry.runId !== runId || parsed.runId !== runId || parsed.id !== entry.seq || parsed.id !== after + index + 1 ||
          parsed.projectId !== current.projectId || parsed.threadId !== current.threadId || !integer(parsed.revision) ||
          !['snapshot', 'delta', 'terminal'].includes(parsed.type as string)) throw unavailable();
        if (parsed.type === 'delta') {
          if (typeof parsed.text !== 'string' || Buffer.byteLength(parsed.text) > 2048 || Object.hasOwn(parsed, 'run')) throw unavailable();
        } else {
          const eventRun = parsed.run;
          const validated = validateRun(eventRun, {...current, status: plain(eventRun) ? eventRun.status as string : undefined});
          if (validated.lastEventId !== parsed.id || parsed.type === 'terminal' && validated.status === 'running' ||
            validated.modelRequestId !== current.modelRequestId || validated.userText !== current.userText ||
            encode(validated.configuration) !== encode(current.configuration) || validated.contextMode !== current.contextMode ||
            encode(validated.provenance) !== encode(current.provenance) || encode(validated.editTarget) !== encode(current.editTarget)) throw unavailable();
          if (['project_inspection', 'selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(current.contextMode as string) && (validated.activity || []).some((item, index) => {
            const durable = current.activity?.[index];
            return !durable || ['id', 'kind', 'ordinal', 'name', 'operation'].some(key => item[key] !== durable[key]) ||
              Object.hasOwn(item, 'resultJson') && item.resultJson !== durable.resultJson;
          })) throw unavailable();
        }
        return parsed as unknown as ChatStoredEvent;
      });
    },
    accept({projectId, requestId, fingerprint, instanceId, configuration, messages, consent, input, execution}: {
      projectId: string; requestId: string; fingerprint: string; instanceId: string; configuration: unknown; messages: unknown;
      consent: unknown; input: {message: string; expectedSettingsRevision: number; expectedConversationRevision: number}; execution?: unknown;
    }): ChatJournalResult {
      if (execution === undefined && (consent as {context?: unknown} | null | undefined)?.context !== 'typed_chat_only') throw unavailable();
      return store.tx(() => {
        const conv = thread(projectId);
        let threadBytes = 0;
        if (!db.prepare('SELECT 1 FROM agent_chat_threads WHERE id=?').get(conv.id)) {
          if ((db.prepare('SELECT count(*) count FROM agent_chat_threads').get() as {count: number}).count >= bounds.projects) throw capacity();
          db.prepare('INSERT INTO agent_chat_threads(id,projectId,revision,nextPosition) VALUES(?,?,0,1)').run(conv.id, projectId);
          threadBytes = bytes(encode(conv));
        }
        if (this.active(projectId) || this.activeCount() >= bounds.active) throw agentChatError('AGENT_CHAT_BUSY');
        const createdAt = now(), id = randomUUID();
        const run: ChatRun = {id, requestId, threadId: conv.id, projectId, status: 'running', userText: input.message, assistantText: '',
          configuration: structuredClone(configuration) as AgentConfiguration, createdAt, updatedAt: createdAt, lastEventId: 1,
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
    dispatch(runId: string): ChatRun {
      return store.tx(() => {
        const previous = row(runId) as RunRow | undefined;
        const run = read(previous);
        if (!run || ['project_inspection', 'selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(run.contextMode as string) || run.status !== 'running' || run.modelRequestState !== 'not_started') throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
        // Conservative local boundary BEFORE calling the gateway. This is not
        // evidence that a socket opened, the provider accepted, or billing began.
        run.modelRequestState = 'dispatch_started'; run.modelRequestStartedAt = now();
        account(saveRun(previous as RunRow, run));
        return run;
      });
    },
    append(runId: string, text: string): ChatJournalAppendResult {
      return store.tx(() => {
        const previous = row(runId) as RunRow | undefined;
        const run = read(previous);
        if (!run || run.status !== 'running') throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
        run.assistantText += text; run.updatedAt = now(); run.lastEventId++;
        const rev = revision(run.projectId), appended = appendEvent(run, 'delta', rev, text);
        account(saveRun(previous as RunRow, run) + appended.bytes);
        return {run, revision: rev, events: [appended.event]};
      });
    },
    finish(runId: string, status: ChatRun['status'], error?: ChatError, pendingText = ''): ChatJournalAppendResult { return store.tx(() => finishInside(row(runId) as RunRow, status, error, pendingText)); },
    recover(): ChatRun[] {
      return store.tx(() => {
        const unfinished = db.prepare(`${SELECT_RUN} WHERE status='running' ORDER BY rowid LIMIT ?`).all(bounds.active + 1) as unknown as RunRow[];
        if (unfinished.length > bounds.active) throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
        return unfinished.map(previous => finishInside(previous, 'interrupted').run);
      });
    },
  });
}
export type ChatJournal = ReturnType<typeof createChatJournal>;
