import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {
  agentTaskChangeSchema, agentTaskConversationPolicySchema, agentTaskPolicyModesSchema, agentTaskPolicySchema,
} from '../../../contracts/src/agent-tasks-v2.ts';
import type {AgentTaskChange, AgentTaskConversationPolicy, AgentTaskJson, AgentTaskPolicy, AgentTaskPolicyModes, AgentTaskStepStatus} from '../../../contracts/src/agent-tasks-v2.ts';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {parseTaskArguments} from './task-gateway-v2.ts';
import {taskModelUsage} from './task-usage-v2.ts';
import {updateMioRunUsageSummary} from './mio-run-usage.ts';
import {
  mioClaimSchema, mioConversationSchema, mioEditOwnerSchema, mioEntrySchema, mioImportSchema, mioInputManifestSchema,
  mioJsonSchema, mioOriginSchema, mioRequestSchema, mioRunSchema, mioStepSchema,
  mioIdentitySchemas, mioControlSchema, mioEditReceiptSchema, mioEventSchema, mioModelOutputSchema,
} from '../../../contracts/src/mio-records.ts';
import type {
  MioClaim, MioConversation, MioEditOwner, MioEntry, MioImport, MioInputManifest, MioOrigin, MioRequest, MioRun, MioStep, MioModelOutput,
} from '../../../contracts/src/mio-records.ts';

const ROW_BYTES = 2 * 1024 * 1024;
const REQUEST_BYTES = 512 * 1024;
const {id: idSchema, requestId: requestIdSchema, hash: hashSchema, date: dateSchema, count: countSchema} = mioIdentitySchemas;
function fail(code: string): never { throw Object.assign(new Error(code), {code}); }
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const object = (value: AgentTaskJson): value is {[key: string]: AgentTaskJson} => value !== null && typeof value === 'object' && !Array.isArray(value);
interface RecordSchema<T> {safeParse(value: unknown): {success: true; data: T} | {success: false}}
function validated<T>(schema: RecordSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail('AGENT_TASK_INVALID');
}
function encoded(value: unknown, limit = ROW_BYTES): string {
  const result = JSON.stringify(validated(mioJsonSchema, value));
  if (Buffer.byteLength(result, 'utf8') > limit) fail('AGENT_TASK_STORAGE_LIMIT');
  return result;
}
function decoded(value: unknown): AgentTaskJson {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > ROW_BYTES) return fail('AGENT_TASK_STORAGE_CORRUPT');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return fail('AGENT_TASK_STORAGE_CORRUPT'); }
  const result = mioJsonSchema.safeParse(parsed);
  return result.success ? result.data : fail('AGENT_TASK_STORAGE_CORRUPT');
}
function rowValue<T>(schema: RecordSchema<T>, value: unknown): T {
  if (value === undefined) return fail('AGENT_TASK_NOT_FOUND');
  const result = schema.safeParse(value);
  return result.success ? result.data : fail('AGENT_TASK_STORAGE_CORRUPT');
}
const stepTransitions: Readonly<Record<AgentTaskStepStatus, readonly AgentTaskStepStatus[]>> = {
  intent: ['awaiting_approval', 'awaiting_answer', 'dispatch_started', 'completed', 'denied', 'rejected', 'failed'],
  awaiting_approval: ['intent', 'denied', 'rejected', 'failed'], awaiting_answer: ['completed'],
  dispatch_started: ['completed', 'failed', 'unknown'], unknown: ['completed', 'failed'],
  completed: [], denied: [], rejected: [], failed: [],
};

export interface MioSourceCall {readonly id: string; readonly name: string; readonly arguments: AgentTaskJson}
/** The provider block is canonical. Calls are derived rather than stored a
 * second time, preserving original argument strings and thinking signatures. */
function sourceCalls(payload: AgentTaskJson): MioSourceCall[] {
  if (!object(payload)) return fail('AGENT_TASK_STORAGE_CORRUPT');
  const {protocol, providerOutput} = payload;
  let calls: AgentTaskJson[];
  if (protocol === 'chat_completions' && providerOutput !== undefined && object(providerOutput) && providerOutput.role === 'assistant' && (typeof providerOutput.content === 'string' || providerOutput.content === null)) {
    const values = providerOutput.tool_calls;
    if (values !== undefined && !Array.isArray(values)) return fail('AGENT_TASK_STORAGE_CORRUPT');
    calls = values ?? [];
  } else if (protocol === 'responses' && Array.isArray(providerOutput)) {
    calls = providerOutput.filter(item => object(item) && item.type === 'function_call');
  } else if (protocol === 'anthropic_messages' && providerOutput !== undefined && object(providerOutput) && providerOutput.role === 'assistant' && Array.isArray(providerOutput.content)) {
    calls = providerOutput.content.filter(item => object(item) && item.type === 'tool_use');
  } else return fail('AGENT_TASK_STORAGE_CORRUPT');
  if (calls.length > 30) return fail('AGENT_TASK_STORAGE_CORRUPT');
  const result = calls.map(value => {
    if (!object(value)) return fail('AGENT_TASK_STORAGE_CORRUPT');
    if (protocol === 'chat_completions' && (value.function === undefined || !object(value.function))) return fail('AGENT_TASK_STORAGE_CORRUPT');
    const fn = protocol === 'chat_completions' && value.function !== undefined && object(value.function) ? value.function : value;
    const id = protocol === 'responses' ? value.call_id : value.id;
    const name = fn.name;
    if (typeof id !== 'string' || id.length < 1 || id.length > 200 || typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(name)) return fail('AGENT_TASK_STORAGE_CORRUPT');
    const args = protocol === 'anthropic_messages' ? value.input : fn.arguments;
    if (args === undefined) return fail('AGENT_TASK_STORAGE_CORRUPT');
    if (protocol !== 'anthropic_messages' && typeof args !== 'string') return fail('AGENT_TASK_STORAGE_CORRUPT');
    if (protocol === 'anthropic_messages' && !object(args)) return fail('AGENT_TASK_STORAGE_CORRUPT');
    let parsed: AgentTaskJson;
    try { parsed = protocol === 'anthropic_messages' ? args : parseTaskArguments(String(args)); }
    catch { return fail('AGENT_TASK_STORAGE_CORRUPT'); }
    return {id, name, arguments: parsed};
  });
  if (new Set(result.map(call => call.id)).size !== result.length) return fail('AGENT_TASK_STORAGE_CORRUPT');
  return result;
}

export type MioCreateRun = Omit<MioRun, 'projectId' | 'status' | 'revision' | 'stepsUsed' | 'usageSummary'>;
export interface MioAppendEntry {
  readonly id: string; readonly runId: string; readonly kind: MioEntry['kind']; readonly createdAt: string;
  readonly payload: {readonly json: AgentTaskJson} | {readonly blobHash: string};
}
export interface MioCreateStep {
  readonly id: string; readonly runId: string; readonly kind: MioStep['kind']; readonly createdAt: string;
  readonly tier?: MioStep['tier']; readonly sourceEntryId?: string; readonly sourceCallIndex?: number; readonly data?: AgentTaskJson;
}
export interface MioBeginRequest {
  readonly id: string; readonly stepId: string; readonly assemblerVersion: number; readonly protocol: MioRequest['protocol'];
  readonly body: string; readonly inputManifest: MioInputManifest; readonly assembledAt: string;
}
export interface MioControlRecord {readonly requestId: string; readonly runId: string; readonly projectId: string; readonly digest: string; readonly data: AgentTaskJson}

/** New-kernel records only. The caller owns store.tx: model dispatch and domain
 * mutations must never escape a transaction whose intent is not durable yet.
 * Savepoints also make each compound call atomic when its caller catches an
 * error inside a larger domain transaction. */
export function createMioRecords(store: ProjectStore) {
  if (!isProjectStore(store)) fail('AGENT_TASK_STORAGE_UNAVAILABLE');
  const {db, projectId} = store;
  let savepoint = 0;
  function write<T>(apply: () => T): T {
    if (!db.isTransaction) return fail('AGENT_TASK_TRANSACTION_REQUIRED');
    const name = `mio_records_${++savepoint}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const result = apply(); db.exec(`RELEASE ${name}`); return result; }
    catch (error) { if (db.isTransaction) db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
  function conversation(id: string): MioConversation {
    validated(idSchema, id);
    return rowValue(mioConversationSchema, db.prepare('SELECT * FROM mio_conversations WHERE id=? AND projectId=?').get(id, projectId));
  }
  function run(id: string): MioRun {
    validated(idSchema, id);
    const row = db.prepare('SELECT * FROM mio_runs WHERE id=? AND projectId=?').get(id, projectId);
    if (!row) return fail('AGENT_TASK_NOT_FOUND');
    return rowValue(mioRunSchema, {...row, usageSummary: row.usageSummary === null ? null : decoded(row.usageSummary)});
  }
  function step(id: string): MioStep {
    validated(idSchema, id);
    const row = db.prepare('SELECT * FROM mio_steps WHERE id=? AND projectId=?').get(id, projectId);
    if (!row) return fail('AGENT_TASK_NOT_FOUND');
    return rowValue(mioStepSchema, {...row, data: decoded(row.data)});
  }
  function entry(id: string): MioEntry {
    validated(idSchema, id);
    const row = db.prepare('SELECT * FROM mio_entries WHERE id=? AND projectId=?').get(id, projectId);
    if (!row) return fail('AGENT_TASK_NOT_FOUND');
    return rowValue(mioEntrySchema, {...row, payloadJson: row.payloadJson === null ? null : decoded(row.payloadJson)});
  }
  function blob(hash: string): string {
    validated(hashSchema, hash);
    const row = db.prepare('SELECT bytes,content FROM mio_blobs WHERE sha256=?').get(hash);
    if (!row) return fail('AGENT_TASK_NOT_FOUND');
    if (typeof row.content !== 'string' || row.bytes !== Buffer.byteLength(row.content, 'utf8') || digest(row.content) !== hash) return fail('AGENT_TASK_STORAGE_CORRUPT');
    return row.content;
  }
  function payload(item: MioEntry): AgentTaskJson {
    const saved = entry(item.id);
    if (!isDeepStrictEqual(saved, item)) fail('AGENT_TASK_REQUEST_CONFLICT');
    return saved.payloadBlobHash === null ? saved.payloadJson : decoded(blob(saved.payloadBlobHash));
  }
  function request(id: string): MioRequest {
    validated(idSchema, id);
    const row = db.prepare('SELECT q.* FROM mio_requests q JOIN mio_steps s ON s.id=q.stepId WHERE q.id=? AND s.projectId=?').get(id, projectId);
    if (!row) return fail('AGENT_TASK_NOT_FOUND');
    const value = rowValue(mioRequestSchema, {...row, inputManifest: decoded(row.inputManifest)});
    if (value.originalBody !== null && (Buffer.byteLength(value.originalBody, 'utf8') !== value.bodyBytes || digest(value.originalBody) !== value.bodySha256)) return fail('AGENT_TASK_STORAGE_CORRUPT');
    return value;
  }
  function emit(runId: string, createdAt: string): void {
    validated(dateSchema, createdAt);
    run(runId);
    db.prepare('INSERT INTO mio_events(runId,sequence,createdAt) SELECT ?,coalesce(max(sequence),0)+1,? FROM mio_events WHERE runId=?').run(runId, createdAt, runId);
  }
  function touch(runId: string, at: string): void {
    const value = run(runId); validated(dateSchema, at);
    if (value.revision === Number.MAX_SAFE_INTEGER) fail('AGENT_TASK_REVISION_LIMIT');
    const updatedAt = new Date(Math.max(Date.parse(at), Date.parse(value.createdAt), Date.parse(value.updatedAt))).toISOString();
    db.prepare('UPDATE mio_runs SET revision=revision+1,updatedAt=? WHERE id=?').run(updatedAt, runId);
  }
  function putBlob(content: string, createdAt: string): string { return write(() => {
    validated(dateSchema, createdAt);
    if (typeof content !== 'string' || Buffer.from(content, 'utf8').toString('utf8') !== content) fail('AGENT_TASK_INVALID');
    if (Buffer.byteLength(content, 'utf8') > ROW_BYTES) fail('AGENT_TASK_STORAGE_LIMIT');
    const sha256 = digest(content);
    if (db.prepare('SELECT 1 FROM mio_blobs WHERE sha256=?').get(sha256)) {
      if (blob(sha256) !== content) fail('AGENT_TASK_STORAGE_CORRUPT');
      return sha256;
    }
    db.prepare('INSERT INTO mio_blobs(sha256,bytes,content,createdAt) VALUES(?,?,?,?)').run(sha256, Buffer.byteLength(content, 'utf8'), content, createdAt);
    return sha256;
  }); }
  function createConversation(input: Omit<MioConversation, 'projectId'>): MioConversation { return write(() => {
    const value = validated(mioConversationSchema, {...input, projectId});
    db.prepare('INSERT INTO mio_conversations(id,projectId,createdAt,updatedAt) VALUES(?,?,?,?)').run(value.id, projectId, value.createdAt, value.updatedAt);
    return value;
  }); }
  function createRun(input: MioCreateRun): MioRun { return write(() => {
    const value = validated(mioRunSchema, {...input, projectId, status: 'running', revision: 1, stepsUsed: 0, usageSummary: null});
    conversation(value.conversationId);
    for (const hash of [value.configurationBlobHash, value.rulesSnapshotHash]) if (hash !== null) blob(hash);
    const old = db.prepare('SELECT id FROM mio_runs WHERE requestId=?').get(value.requestId);
    if (old) {
      const saved = run(String(old.id));
      if (saved.digest !== value.digest || saved.conversationId !== value.conversationId || saved.configurationBlobHash !== value.configurationBlobHash || saved.rulesSnapshotHash !== value.rulesSnapshotHash || saved.locale !== value.locale) fail('AGENT_TASK_REQUEST_CONFLICT');
      return saved;
    }
    if (db.prepare("SELECT 1 FROM mio_runs WHERE projectId=? AND status IN ('running','paused','awaiting_approval','awaiting_answer','interrupted')").get(projectId)) fail('AGENT_TASK_BUSY');
    db.prepare('INSERT INTO mio_runs(id,projectId,conversationId,requestId,digest,status,revision,stepLimit,budget,stepsUsed,locale,configurationBlobHash,settingsRevision,rulesSnapshotHash,usageSummary,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      value.id, projectId, value.conversationId, value.requestId, value.digest, value.status, value.revision, value.stepLimit, value.budget, value.stepsUsed,
      value.locale, value.configurationBlobHash, value.settingsRevision, value.rulesSnapshotHash, null, value.createdAt, value.updatedAt);
    emit(value.id, value.createdAt);
    return value;
  }); }
  function updateRun(id: string, expectedRevision: number, patch: Pick<MioRun, 'status' | 'budget' | 'updatedAt'>): MioRun { return write(() => {
    const old = run(id);
    if (old.revision !== expectedRevision) fail('AGENT_TASK_REVISION_CONFLICT');
    if (old.revision === Number.MAX_SAFE_INTEGER) fail('AGENT_TASK_REVISION_LIMIT');
    if (['completed', 'failed', 'stopped', 'reverted'].includes(old.status) &&
      (patch.status !== old.status && !(old.status === 'completed' && patch.status === 'reverted') || patch.budget !== old.budget)) fail('AGENT_TASK_STATE_CONFLICT');
    const value = validated(mioRunSchema, {...old, ...patch, revision: old.revision + 1});
    db.prepare('UPDATE mio_runs SET status=?,budget=?,revision=?,updatedAt=? WHERE id=?').run(value.status, value.budget, value.revision, value.updatedAt, id);
    emit(id, value.updatedAt); return value;
  }); }
  function appendEntry(input: MioAppendEntry): MioEntry { return write(() => {
    const owner = run(input.runId);
    const sequence = Number(db.prepare('SELECT coalesce(max(sequence),0)+1 AS value FROM mio_entries WHERE runId=?').get(owner.id)?.value);
    const inline = 'json' in input.payload;
    const payloadJson = inline ? encoded(input.payload.json) : null;
    const payloadBlobHash = inline ? null : validated(hashSchema, input.payload.blobHash);
    if (payloadBlobHash !== null) decoded(blob(payloadBlobHash));
    const value = validated(mioEntrySchema, {id: input.id, projectId, conversationId: owner.conversationId, runId: owner.id, sequence, kind: input.kind, payloadJson: inline ? input.payload.json : null, payloadBlobHash, createdAt: input.createdAt});
    db.prepare('INSERT INTO mio_entries(id,projectId,conversationId,runId,sequence,kind,payloadJson,payloadBlobHash,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').run(value.id, projectId, owner.conversationId, owner.id, sequence, value.kind, payloadJson, payloadBlobHash, value.createdAt);
    touch(owner.id, value.createdAt);
    emit(owner.id, value.createdAt); return value;
  }); }
  function sourceCall(entryId: string, index: number): MioSourceCall {
    validated(countSchema, index);
    const saved = entry(entryId);
    if (saved.kind !== 'model_output') return fail('AGENT_TASK_INVALID');
    if (!db.prepare("SELECT 1 FROM mio_steps s JOIN mio_requests q ON q.id=s.currentRequestId WHERE s.runId=? AND s.kind='model' AND s.status='completed' AND s.resultEntryId=? AND q.state='completed'").get(saved.runId, saved.id)) fail('AGENT_TASK_STATE_CONFLICT');
    const call = sourceCalls(payload(saved))[index];
    return call ?? fail('AGENT_TASK_INVALID');
  }
  function createStep(input: MioCreateStep): MioStep { return write(() => {
    const owner = run(input.runId);
    if (owner.stepsUsed >= owner.budget) fail('AGENT_TASK_BUDGET_EXHAUSTED');
    if (input.kind === 'tool') {
      if (input.sourceEntryId === undefined || input.sourceCallIndex === undefined) fail('AGENT_TASK_INVALID');
      const source = entry(input.sourceEntryId);
      if (source.runId !== owner.id) fail('AGENT_TASK_INVALID');
      sourceCall(source.id, input.sourceCallIndex);
      if (db.prepare("SELECT 1 FROM mio_steps WHERE runId=? AND kind='tool' AND sourceEntryId=? AND sourceCallIndex=?").get(owner.id, source.id, input.sourceCallIndex)) fail('AGENT_TASK_REQUEST_CONFLICT');
    } else if (input.sourceEntryId !== undefined || input.sourceCallIndex !== undefined) fail('AGENT_TASK_INVALID');
    const value = validated(mioStepSchema, {
      id: input.id, projectId, runId: owner.id, position: owner.stepsUsed + 1, kind: input.kind, status: 'intent', tier: input.tier ?? null,
      createdAt: input.createdAt, updatedAt: input.createdAt, currentRequestId: null, sourceEntryId: input.sourceEntryId ?? null,
      sourceCallIndex: input.sourceCallIndex ?? null, resultEntryId: null, partialText: null, data: input.data ?? {},
    });
    db.prepare('INSERT INTO mio_steps(id,runId,projectId,position,kind,status,tier,createdAt,updatedAt,currentRequestId,sourceEntryId,sourceCallIndex,resultEntryId,partialText,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      value.id, value.runId, projectId, value.position, value.kind, value.status, value.tier, value.createdAt, value.updatedAt, null, value.sourceEntryId, value.sourceCallIndex, null, null, encoded(value.data));
    db.prepare('UPDATE mio_runs SET stepsUsed=stepsUsed+1 WHERE id=?').run(owner.id);
    touch(owner.id, value.createdAt);
    emit(owner.id, value.createdAt); return value;
  }); }
  type StepPatch = Pick<MioStep, 'status' | 'updatedAt'> & Partial<Pick<MioStep, 'data' | 'partialText' | 'resultEntryId'>>;
  function updateStepInside(id: string, expectedStatus: MioStep['status'], patch: StepPatch, notify = true): MioStep {
    const old = step(id);
    if (old.status !== expectedStatus || patch.status !== old.status && !stepTransitions[old.status].includes(patch.status)) fail('AGENT_TASK_STATE_CONFLICT');
    const value = validated(mioStepSchema, {...old, ...patch});
    if (value.resultEntryId !== null) {
      const result = entry(value.resultEntryId);
      if (result.runId !== old.runId || value.kind === 'tool' && !['tool_result', 'answer'].includes(result.kind) || value.kind === 'model' && result.kind !== 'model_output') fail('AGENT_TASK_INVALID');
    }
    db.prepare('UPDATE mio_steps SET status=?,updatedAt=?,data=?,partialText=?,resultEntryId=? WHERE id=?').run(value.status, value.updatedAt, encoded(value.data), value.partialText, value.resultEntryId, id);
    if (notify) { touch(value.runId, value.updatedAt); emit(value.runId, value.updatedAt); }
    return value;
  }
  function updateStep(id: string, expectedStatus: MioStep['status'], patch: StepPatch): MioStep { return write(() => {
    const old = step(id);
    // Model lifecycle changes own a matching request transition. A general
    // step patch cannot manufacture successful or unsent request evidence.
    if (old.kind === 'model' && (patch.status !== old.status ||
      patch.resultEntryId !== undefined && patch.resultEntryId !== old.resultEntryId ||
      patch.partialText !== undefined && (old.status !== 'dispatch_started' || old.currentRequestId === null || request(old.currentRequestId).state !== 'dispatch_started'))) fail('AGENT_TASK_STATE_CONFLICT');
    return updateStepInside(id, expectedStatus, patch);
  }); }
  function verifyManifest(manifest: MioInputManifest, owner: MioRun): void {
    for (const hash of [manifest.configurationBlobHash, manifest.toolsBlobHash, manifest.systemBlobHash, manifest.baselineBlobHash, manifest.rulesBlobHash]) if (hash !== null) blob(hash);
    for (const id of manifest.entryIds) if (entry(id).conversationId !== owner.conversationId) fail('AGENT_TASK_INVALID');
    for (const id of manifest.noteEntryIds) { const saved = entry(id); if (saved.runId !== owner.id || saved.kind !== 'note') fail('AGENT_TASK_INVALID'); }
  }
  function saveRequest(input: MioBeginRequest, previous: MioRequest | undefined, reason: string): MioRequest {
    const item = step(input.stepId);
    if (item.kind !== 'model' || item.status !== 'intent') return fail('AGENT_TASK_STATE_CONFLICT');
    const manifest = validated(mioInputManifestSchema, input.inputManifest);
    verifyManifest(manifest, run(item.runId));
    if (typeof input.body !== 'string' || Buffer.from(input.body, 'utf8').toString('utf8') !== input.body) fail('AGENT_TASK_INVALID');
    const bodyBytes = Buffer.byteLength(input.body, 'utf8');
    if (!bodyBytes || bodyBytes > REQUEST_BYTES) fail('AGENT_TASK_STORAGE_LIMIT');
    const value = validated(mioRequestSchema, {
      id: input.id, stepId: item.id, assemblyNumber: previous ? previous.assemblyNumber + 1 : 1, assemblerVersion: input.assemblerVersion,
      protocol: input.protocol, bodySha256: digest(input.body), bodyBytes, state: 'intent', originalBody: input.body,
      inputManifest: manifest, firstEntry: manifest.entryIds[0] ?? null, lastEntry: manifest.entryIds.at(-1) ?? null,
      assembledAt: input.assembledAt, dispatchStartedAt: null, completedAt: null, previousRequestId: previous?.id ?? null, assemblyReason: reason,
    });
    db.prepare('INSERT INTO mio_requests(id,stepId,assemblyNumber,assemblerVersion,protocol,bodySha256,bodyBytes,state,originalBody,inputManifest,firstEntry,lastEntry,assembledAt,dispatchStartedAt,completedAt,previousRequestId,assemblyReason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      value.id, value.stepId, value.assemblyNumber, value.assemblerVersion, value.protocol, value.bodySha256, value.bodyBytes, value.state, value.originalBody,
      encoded(manifest), value.firstEntry, value.lastEntry, value.assembledAt, null, null, value.previousRequestId, reason);
    db.prepare('UPDATE mio_steps SET currentRequestId=?,updatedAt=? WHERE id=?').run(value.id, value.assembledAt, item.id);
    touch(item.runId, value.assembledAt);
    emit(item.runId, value.assembledAt); return value;
  }
  function beginRequest(input: MioBeginRequest): MioRequest { return write(() => {
    if (step(input.stepId).currentRequestId !== null) fail('AGENT_TASK_REQUEST_CONFLICT');
    return saveRequest(input, undefined, 'initial');
  }); }
  function reassembleRequest(previousId: string, input: MioBeginRequest, entryId: string): MioRequest { return write(() => {
    const old = request(previousId), item = step(old.stepId);
    if (old.state !== 'intent' || old.dispatchStartedAt !== null || item.status !== 'intent' || item.currentRequestId !== old.id || input.stepId !== item.id || input.assemblerVersion <= old.assemblerVersion) fail('AGENT_TASK_STATE_CONFLICT');
    // Upgrading serialization must not absorb later notes, settings or rules.
    if (input.protocol !== old.protocol || !isDeepStrictEqual(input.inputManifest, old.inputManifest)) fail('AGENT_TASK_REQUEST_CONFLICT');
    db.prepare("UPDATE mio_requests SET state='superseded' WHERE id=?").run(old.id);
    const next = saveRequest(input, old, 'assembler_upgrade');
    appendEntry({id: entryId, runId: item.runId, kind: 'request_reassembled', createdAt: input.assembledAt, payload: {json: {
      previousRequestId: old.id, requestId: next.id, fromVersion: old.assemblerVersion, toVersion: next.assemblerVersion,
      beforeHash: old.bodySha256, afterHash: next.bodySha256, beforeBytes: old.bodyBytes, afterBytes: next.bodyBytes,
    }}});
    return next;
  }); }
  function markDispatched(id: string, at: string): MioRequest { return write(() => {
    const old = request(id), item = step(old.stepId);
    if (old.state !== 'intent' || old.dispatchStartedAt !== null || item.currentRequestId !== old.id || item.status !== 'intent') fail('AGENT_TASK_STATE_CONFLICT');
    validated(dateSchema, at);
    db.prepare("UPDATE mio_requests SET state='dispatch_started',dispatchStartedAt=? WHERE id=?").run(at, id);
    updateStepInside(item.id, item.status, {status: 'dispatch_started', updatedAt: at});
    updateMioRunUsageSummary(store, item.runId); return request(id);
  }); }
  function completeModelRequest(id: string, input: {readonly entryId: string; readonly output: MioModelOutput; readonly at: string}): MioRequest { return write(() => {
    const old = request(id), item = step(old.stepId);
    if (old.state !== 'dispatch_started' || item.currentRequestId !== old.id || item.status !== 'dispatch_started') fail('AGENT_TASK_STATE_CONFLICT');
    const {usage: reportedUsage, ...completion} = input.output, usage = taskModelUsage(reportedUsage);
    const output = validated(mioModelOutputSchema, {...completion, ...(usage ? {usage} : {})});
    if (output.protocol !== old.protocol) fail('AGENT_TASK_INVALID');
    const canonical = validated(mioJsonSchema, output);
    sourceCalls(canonical);
    // Validate the whole completion before releasing its raw request. Clearing
    // first lets quota checks see the final net footprint; the savepoint makes
    // output archival failure restore the request and dispatch state together.
    validated(idSchema, input.entryId); encoded(canonical); validated(dateSchema, input.at);
    // The body-clear trigger requires the completed step first. Defer its
    // notification until raw-body release, so even zero quota headroom can
    // archive a completion whose final footprint is smaller than the raw body.
    updateStepInside(item.id, 'dispatch_started', {status: 'completed', updatedAt: input.at, partialText: null}, false);
    db.prepare("UPDATE mio_requests SET state='completed',completedAt=?,originalBody=NULL WHERE id=?").run(input.at, id);
    db.prepare("UPDATE mio_requests SET originalBody=NULL WHERE stepId=? AND state='superseded'").run(item.id);
    touch(item.runId, input.at); emit(item.runId, input.at);
    const result = appendEntry({id: input.entryId, runId: item.runId, kind: 'model_output', createdAt: input.at, payload: {json: canonical}});
    db.prepare('UPDATE mio_steps SET resultEntryId=? WHERE id=?').run(result.id, item.id);
    updateMioRunUsageSummary(store, item.runId);
    return request(id);
  }); }
  function failRequest(id: string, state: 'failed' | 'unknown', at: string): MioRequest { return write(() => {
    const old = request(id), item = step(old.stepId);
    if (old.state !== 'dispatch_started' || item.currentRequestId !== old.id || item.status !== 'dispatch_started') fail('AGENT_TASK_STATE_CONFLICT');
    validated(dateSchema, at);
    db.prepare('UPDATE mio_requests SET state=?,completedAt=? WHERE id=?').run(state, at, id);
    updateStepInside(item.id, 'dispatch_started', {status: state, updatedAt: at});
    updateMioRunUsageSummary(store, item.runId); return request(id);
  }); }
  function changes(runId: string): AgentTaskChange[] {
    run(runId); return db.prepare('SELECT id,runId,stepId,projectId,data FROM mio_changes WHERE runId=? ORDER BY rowid').all(runId).map(row => {
      const value = rowValue(agentTaskChangeSchema, decoded(row.data));
      if (value.id !== row.id || value.runId !== row.runId || value.stepId !== row.stepId || value.projectId !== projectId || row.projectId !== projectId) fail('AGENT_TASK_STORAGE_CORRUPT');
      return value;
    });
  }
  function addChange(value: AgentTaskChange): AgentTaskChange { return write(() => {
    const change = validated(agentTaskChangeSchema, value);
    const source = step(change.stepId);
    if (change.projectId !== projectId || source.runId !== change.runId || source.kind !== 'tool') fail('AGENT_TASK_INVALID');
    run(change.runId);
    db.prepare('INSERT INTO mio_changes(id,runId,stepId,projectId,data) VALUES(?,?,?,?,?)').run(change.id, change.runId, change.stepId, projectId, encoded(change));
    touch(change.runId, change.createdAt);
    emit(change.runId, change.createdAt); return change;
  }); }
  function control(requestId: string): MioControlRecord | undefined {
    validated(requestIdSchema, requestId);
    const row = db.prepare('SELECT requestId,runId,projectId,digest,data FROM mio_controls WHERE requestId=? AND projectId=?').get(requestId, projectId);
    if (!row) return;
    const value = rowValue(mioControlSchema, {...row, data: decoded(row.data)});
    run(value.runId); return value;
  }
  function saveControl(input: Omit<MioControlRecord, 'projectId'>, at: string): MioControlRecord { return write(() => {
    const value = {requestId: validated(requestIdSchema, input.requestId), runId: run(input.runId).id, projectId, digest: validated(hashSchema, input.digest), data: validated(mioJsonSchema, input.data)};
    const old = control(value.requestId);
    if (old) { if (!isDeepStrictEqual(old, value)) fail('AGENT_TASK_REQUEST_CONFLICT'); return old; }
    db.prepare('INSERT INTO mio_controls(requestId,runId,projectId,digest,data) VALUES(?,?,?,?,?)').run(value.requestId, value.runId, projectId, value.digest, encoded(value.data));
    emit(value.runId, at); return value;
  }); }
  function controlState(requestId: string): AgentTaskJson | undefined {
    const saved = control(requestId); if (!saved) return;
    const row = db.prepare('SELECT data FROM mio_control_states WHERE requestId=? AND projectId=?').get(requestId, projectId);
    return row ? decoded(row.data) : undefined;
  }
  function setControlState(requestId: string, data: AgentTaskJson, at: string): void { write(() => {
    const saved = control(requestId); if (!saved) fail('AGENT_TASK_NOT_FOUND');
    if (isDeepStrictEqual(controlState(requestId), data)) return;
    db.prepare('INSERT INTO mio_control_states(requestId,runId,projectId,data) VALUES(?,?,?,?) ON CONFLICT(requestId) DO UPDATE SET data=excluded.data').run(requestId, saved.runId, projectId, encoded(data));
    emit(saved.runId, at);
  }); }
  function importRecord(id: string): MioImport {
    validated(idSchema, id); return rowValue(mioImportSchema, db.prepare('SELECT * FROM mio_imports WHERE id=? AND projectId=?').get(id, projectId));
  }
  function addImport(input: Omit<MioImport, 'projectId'>): MioImport { return write(() => {
    const value = validated(mioImportSchema, {...input, projectId});
    if (Buffer.byteLength(value.name) > 800 || value.relativePath.split(/[\\/]/u).includes('..') || /^[\\/]|^[A-Za-z]:/u.test(value.relativePath)) fail('AGENT_TASK_INVALID');
    db.prepare('INSERT INTO mio_imports(id,projectId,requestId,name,mimeType,relativePath,sha256,status,assetId,resourceId,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(value.id, projectId, value.requestId, value.name, value.mimeType, value.relativePath, value.sha256, value.status, value.assetId, value.resourceId, value.createdAt);
    return value;
  }); }
  function updateImport(id: string, patch: Pick<MioImport, 'status' | 'assetId' | 'resourceId'>): MioImport { return write(() => {
    const old = importRecord(id), value = validated(mioImportSchema, {...old, ...patch});
    db.prepare('UPDATE mio_imports SET status=?,assetId=?,resourceId=? WHERE id=?').run(value.status, value.assetId, value.resourceId, id); return value;
  }); }
  function origin(kind: MioOrigin['kind'], jobId: string): MioOrigin | undefined {
    validated(idSchema, jobId);
    const row = db.prepare('SELECT * FROM mio_job_origins WHERE kind=? AND jobId=? AND projectId=?').get(kind, jobId, projectId);
    return row ? rowValue(mioOriginSchema, row) : undefined;
  }
  function addOrigin(input: Omit<MioOrigin, 'projectId'>): MioOrigin { return write(() => {
    const value = validated(mioOriginSchema, {...input, projectId});
    if (step(value.stepId).runId !== value.runId) fail('AGENT_TASK_INVALID');
    const old = origin(value.kind, value.jobId);
    if (old) { if (!isDeepStrictEqual(old, value)) fail('AGENT_TASK_REQUEST_CONFLICT'); return old; }
    db.prepare('INSERT INTO mio_job_origins(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run(value.kind, value.jobId, value.runId, value.stepId, projectId, value.requestId, value.operation); return value;
  }); }
  function claims(ownerId?: string): MioClaim[] {
    if (ownerId !== undefined) validated(requestIdSchema, ownerId);
    return db.prepare('SELECT * FROM mio_edit_claims WHERE projectId=? AND (? IS NULL OR ownerId=?) ORDER BY kind,targetId,id').all(projectId, ownerId ?? null, ownerId ?? null).map(row => rowValue(mioClaimSchema, row));
  }
  function saveClaim(input: Omit<MioClaim, 'projectId'>): MioClaim { return write(() => {
    const value = validated(mioClaimSchema, {...input, projectId});
    const old = db.prepare('SELECT projectId,ownerId,kind,targetId,revision FROM mio_edit_claims WHERE id=?').get(value.id);
    if (old && (old.projectId !== projectId || old.ownerId !== value.ownerId || old.kind !== value.kind || old.targetId !== value.targetId)) fail('AGENT_TASK_REQUEST_CONFLICT');
    if (old && typeof old.revision === 'number' && value.revision < old.revision) fail('AGENT_TASK_REVISION_CONFLICT');
    db.prepare('INSERT INTO mio_edit_claims(id,projectId,ownerId,kind,targetId,revision,state,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state,updatedAt=excluded.updatedAt').run(value.id, projectId, value.ownerId, value.kind, value.targetId, value.revision, value.state, value.createdAt, value.updatedAt); return value;
  }); }
  function removeClaim(id: string, ownerId: string): void { write(() => {
    validated(idSchema, id); validated(requestIdSchema, ownerId);
    db.prepare('DELETE FROM mio_edit_claims WHERE id=? AND projectId=? AND ownerId=?').run(id, projectId, ownerId);
  }); }
  function editOwner(ownerId: string): MioEditOwner | undefined {
    validated(requestIdSchema, ownerId);
    const row = db.prepare('SELECT * FROM mio_edit_owners WHERE projectId=? AND ownerId=?').get(projectId, ownerId);
    return row ? rowValue(mioEditOwnerSchema, row) : undefined;
  }
  function saveEditOwner(ownerId: string, generation: number, sequence: number): MioEditOwner { return write(() => {
    const value = validated(mioEditOwnerSchema, {ownerId, projectId, generation, sequence}), old = editOwner(ownerId);
    if (old && (generation < old.generation || generation === old.generation && sequence < old.sequence)) fail('AGENT_TASK_REVISION_CONFLICT');
    db.prepare('INSERT INTO mio_edit_owners(ownerId,projectId,generation,sequence) VALUES(?,?,?,?) ON CONFLICT(projectId,ownerId) DO UPDATE SET generation=excluded.generation,sequence=excluded.sequence').run(ownerId, projectId, generation, sequence); return value;
  }); }
  function editReceipt(requestId: string): {readonly requestId: string; readonly ownerId: string; readonly digest: string; readonly data: AgentTaskJson} | undefined {
    validated(requestIdSchema, requestId);
    const row = db.prepare('SELECT requestId,ownerId,digest,data FROM mio_edit_receipts WHERE requestId=? AND projectId=?').get(requestId, projectId);
    return row ? rowValue(mioEditReceiptSchema, {...row, data: decoded(row.data)}) : undefined;
  }
  function saveEditReceipt(input: {readonly requestId: string; readonly ownerId: string; readonly digest: string; readonly data: AgentTaskJson}): void { write(() => {
    const value = validated(mioEditReceiptSchema, input), old = editReceipt(input.requestId);
    if (old) { if (!isDeepStrictEqual(old, value)) fail('AGENT_TASK_REQUEST_CONFLICT'); return; }
    db.prepare('INSERT INTO mio_edit_receipts(requestId,projectId,ownerId,digest,data) VALUES(?,?,?,?,?)').run(value.requestId, projectId, value.ownerId, value.digest, encoded(value.data, 65536));
  }); }
  function conversationPolicy(conversationId: string): {readonly revision: number; readonly modes: AgentTaskPolicyModes | null} | undefined {
    conversation(conversationId);
    const row = db.prepare('SELECT revision,data FROM mio_conversation_policies WHERE conversationId=? AND projectId=?').get(conversationId, projectId);
    if (!row) return;
    const data = decoded(row.data);
    if (!object(data) || data.projectId !== projectId || data.conversationId !== conversationId || data.revision !== row.revision) return fail('AGENT_TASK_STORAGE_CORRUPT');
    return {revision: rowValue(countSchema, row.revision), modes: data.modes === null ? null : rowValue(agentTaskPolicyModesSchema, data.modes)};
  }
  function setConversationPolicy(input: {readonly requestId: string; readonly conversationId: string; readonly expectedRevision: number; readonly modes: AgentTaskPolicyModes | null; readonly global: AgentTaskPolicy; readonly at: string}): AgentTaskConversationPolicy { return write(() => {
    validated(requestIdSchema, input.requestId); validated(countSchema, input.expectedRevision); validated(dateSchema, input.at);
    const modes = input.modes === null ? null : validated(agentTaskPolicyModesSchema, input.modes), global = validated(agentTaskPolicySchema, input.global);
    conversation(input.conversationId);
    const inputHash = digest(encoded({projectId, conversationId: input.conversationId, expectedRevision: input.expectedRevision, modes}));
    const saved = db.prepare('SELECT inputHash,response FROM mio_conversation_policy_requests WHERE requestId=? AND projectId=?').get(input.requestId, projectId);
    if (saved) { if (saved.inputHash !== inputHash) fail('AGENT_TASK_REQUEST_CONFLICT'); return rowValue(agentTaskConversationPolicySchema, decoded(saved.response)); }
    const previous = conversationPolicy(input.conversationId);
    if ((previous?.revision ?? 0) !== input.expectedRevision) fail('AGENT_TASK_REVISION_CONFLICT');
    if (input.expectedRevision === Number.MAX_SAFE_INTEGER) fail('AGENT_TASK_REVISION_LIMIT');
    const revision = input.expectedRevision + 1;
    const data = {conversationId: input.conversationId, projectId, revision, modes, updatedAt: input.at};
    const response = validated(agentTaskConversationPolicySchema, {projectId, conversationId: input.conversationId, revision, override: modes, global, effective: modes ?? global.modes});
    db.prepare('INSERT INTO mio_conversation_policies(conversationId,projectId,revision,data) VALUES(?,?,?,?) ON CONFLICT(conversationId) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(input.conversationId, projectId, revision, encoded(data));
    db.prepare('INSERT INTO mio_conversation_policy_requests(requestId,projectId,conversationId,revision,inputHash,response) VALUES(?,?,?,?,?,?)').run(input.requestId, projectId, input.conversationId, revision, inputHash, encoded(response));
    return response;
  }); }
  return {
    conversation, createConversation, run, createRun, updateRun, entry, payload, appendEntry, blob, putBlob,
    step, createStep, updateStep, sourceCall, request, beginRequest, reassembleRequest, markDispatched, completeModelRequest, failRequest,
    entries(runId: string): MioEntry[] { run(runId); return db.prepare('SELECT id FROM mio_entries WHERE runId=? ORDER BY sequence').all(runId).map(row => entry(String(row.id))); },
    steps(runId: string): MioStep[] { run(runId); return db.prepare('SELECT id FROM mio_steps WHERE runId=? ORDER BY position').all(runId).map(row => step(String(row.id))); },
    events(runId: string, after = 0): {runId: string; sequence: number; createdAt: string}[] {
      run(runId); validated(countSchema, after);
      return db.prepare('SELECT runId,sequence,createdAt FROM mio_events WHERE runId=? AND sequence>? ORDER BY sequence LIMIT 2000').all(runId, after).map(row => rowValue(mioEventSchema, row));
    },
    changes, addChange, control, saveControl, controlState, setControlState,
    importRecord, addImport, updateImport, origin, addOrigin, claims, saveClaim, removeClaim,
    editOwner, saveEditOwner, editReceipt, saveEditReceipt, conversationPolicy, setConversationPolicy,
  };
}
export type MioRecords = ReturnType<typeof createMioRecords>;
