import {agentSettingsBindingSchema} from '../../../contracts/src/agent-connection-settings.ts';
import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ProjectStore} from '../project-file/store.ts';
import {createMioRecords} from './mio-records.ts';
import type {MioBeginRequest} from './mio-records.ts';
import type {MioRequest, MioEntry} from '../../../contracts/src/mio-records.ts';
import {mioEntrySchema} from '../../../contracts/src/mio-records.ts';
import type {AgentTaskJournal, AgentTaskStepInput, AgentTaskControlRecord, AgentTaskChangeInput} from './task-journal-v2.ts';
import type {AgentTaskRun, AgentTaskStep, AgentTaskJson, AgentTaskPolicy, AgentTaskEvent, AgentTaskSnapshot, AgentTaskNote, AgentTaskSkippedTarget, AgentTaskTarget, AgentTaskChange, AgentTaskReceipt, AgentTaskConversation, AgentTaskHistoryPage, AgentTaskConversationPage, AgentTaskStatus, AgentTaskStepStatus, AgentTaskClaim, AgentTaskEditingInput, AgentTaskPolicyModes, AgentTaskConversationPolicy, AgentTaskConversationPolicySetInput} from '../../../contracts/src/agent-tasks-v2.ts';
import {agentTaskConversationPolicySchema, agentTaskPolicyModesSchema, agentTaskQuestionSchema, agentTaskAnswerSchema, agentTaskStepErrorSchema} from '../../../contracts/src/agent-tasks-v2.ts';
import type {TaskContextHistoryRun, TaskContextHistoryInput} from './task-context-v2.ts';
import type {TaskRunRecordTarget, TaskRunRecordBackground, TaskRunRecordChange} from './task-run-record-v2.ts';
import {projectAgentTaskChangeDisplay} from './task-display-v2.ts';
import {readMioTargetRevision, readMioTargetRevisions} from './mio-target-revisions.ts';
import {parseTaskArguments, taskResponseLocale, taskToolExplanation} from './task-gateway-v2.ts';
import type {TaskModelOutput} from './task-gateway-v2.ts';
import {createMioAssembly} from './mio-assembly.ts';
import {updateMioRunUsageSummary} from './mio-run-usage.ts';

type ModelInput = Omit<AgentTaskStepInput, 'kind'>;
export interface MioJournalAssembly {
  /** The caller is inside the intent transaction; inputs refer to durable entries. */
  freeze(runId: string, stepId: string, input: ModelInput, noteRequestIds: string[]): MioBeginRequest;
  /** Reconstructs a private request projection, verifies its saved body hash. */
  hydrate(request: MioRequest): AgentTaskJson;
  upgrade?(request: MioRequest): MioBeginRequest | undefined;
  freezeContext?(context: AgentTaskJson[], sourceEntryIds: string[]): AgentTaskJson;
  hydrateContext?(view: AgentTaskJson): AgentTaskJson[];
}
export interface MioJournalOptions {
  readonly policy: () => AgentTaskPolicy;
  readonly updatePolicy?: AgentTaskJournal['updatePolicy'];
  readonly lookupPolicy?: AgentTaskJournal['lookupPolicy'];
  readonly assembly?: MioJournalAssembly;
}
const object = (value: unknown): value is Record<string, AgentTaskJson> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code: string): never { throw Object.assign(new Error(code), {code}); }
const encode = (value: unknown): string => JSON.stringify(value);
const hash = (value: unknown): string => createHash('sha256').update(encode(value)).digest('hex');
const date = (): string => new Date().toISOString();
const json = (value: unknown): AgentTaskJson => JSON.parse(encode(value)) as AgentTaskJson;
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;

/** New history journal. Entries own content; mutable rows hold execution state
 * and events are only invalidation notices. Legacy workspace history keeps its
 * separate journal until its host switches to the project kernel. */
export function createMioJournal(store: ProjectStore, options: MioJournalOptions): AgentTaskJournal {
  const {db, projectId} = store, records = createMioRecords(store);
  const assembly = options.assembly ?? createMioAssembly(records);
  const contextAssembly = createMioAssembly(records);
  interface ProjectionCache {
    entries: Map<string, MioEntry[]>; payloads: Map<string, AgentTaskJson>; blobs: Map<string, string>;
    requests: Map<string, AgentTaskJson>; outputs: Map<string, AgentTaskJson>; contexts: Map<string, AgentTaskJson[]>;
  }
  let projectionDepth = 0, projectionCache: ProjectionCache | undefined;
  const invalidateProjection = (): void => { projectionCache = undefined; };
  const readCache = (): ProjectionCache | undefined => projectionDepth === 0 ? undefined : projectionCache ??= {
    entries: new Map(), payloads: new Map(), blobs: new Map(), requests: new Map(), outputs: new Map(), contexts: new Map(),
  };
  function project<Args extends unknown[], Result>(read: (...args: Args) => Result): (...args: Args) => Result {
    return (...args) => {
      const outermost = projectionDepth === 0; projectionDepth++;
      try { return read(...args); } finally { projectionDepth--; if (outermost) invalidateProjection(); }
    };
  }
  // One synchronous public read validates a source once even if several step
  // projections need it. Never retain that validation across another call or
  // a mutation; a subsequent read must detect changed or missing evidence.
  const transact = <T>(apply: () => T): T => {
    invalidateProjection();
    try { return db.isTransaction ? apply() : store.tx(apply); } finally { invalidateProjection(); }
  };
  const inside = (): void => { if (!db.isTransaction) fail('AGENT_TASK_TRANSACTION_REQUIRED'); invalidateProjection(); };
  const own = (id: string): void => { if (id !== projectId) fail('AGENT_TASK_NOT_FOUND'); };
  const entries = (runId: string, kind: MioEntry['kind']): MioEntry[] => {
    const key = `${runId}:${kind}`, cache = readCache(), cached = cache?.entries.get(key); if (cached !== undefined) return cached;
    records.run(runId);
    // Filtering before crossing the SQLite boundary keeps run metadata reads
    // from hydrating unrelated canonical model outputs and tool originals.
    const value = db.prepare('SELECT * FROM mio_entries WHERE runId=? AND projectId=? AND kind=? ORDER BY sequence').all(runId, projectId, kind).map(row => {
      const parsed = mioEntrySchema.safeParse({...row, payloadJson: row.payloadJson === null ? null : decode<AgentTaskJson>(row.payloadJson)});
      return parsed.success ? parsed.data : fail('AGENT_TASK_STORAGE_CORRUPT');
    });
    cache?.entries.set(key, value); return value;
  };
  const payload = (entry: MioEntry): AgentTaskJson => {
    const cache = readCache(), cached = cache?.payloads.get(entry.id); if (cached !== undefined) return cached;
    const value = records.payload(entry); cache?.payloads.set(entry.id, value); return value;
  };
  const blob = (sha256: string): string => {
    const cache = readCache(), cached = cache?.blobs.get(sha256); if (cached !== undefined) return cached;
    const value = records.blob(sha256); cache?.blobs.set(sha256, value); return value;
  };
  const requestProjection = (request: MioRequest): AgentTaskJson => {
    const cache = readCache(), cached = cache?.requests.get(request.id); if (cached !== undefined) return cached;
    const value = assembly.hydrate(request); cache?.requests.set(request.id, value); return value;
  };
  const contextProjection = (entryId: string, view: AgentTaskJson): AgentTaskJson[] => {
    const cache = readCache(), cached = cache?.contexts.get(entryId); if (cached !== undefined) return cached;
    const value = contextAssembly.hydrateContext(view); cache?.contexts.set(entryId, value); return value;
  };
  function content(runId: string, kind: MioEntry['kind']): Array<{entry: MioEntry; value: Record<string, AgentTaskJson>}> {
    return entries(runId, kind).map(entry => {
      const value = payload(entry); if (!object(value)) return fail('AGENT_TASK_STORAGE_CORRUPT'); return {entry, value};
    });
  }
  function append(runId: string, kind: MioEntry['kind'], value: AgentTaskJson, at = date()): MioEntry {
    return records.appendEntry({id: randomUUID(), runId, kind, createdAt: at, payload: {json: value}});
  }
  function notify(runId: string, at = date()): void {
    inside(); records.run(runId);
    db.prepare('INSERT INTO mio_events(runId,sequence,createdAt) SELECT ?,coalesce(max(sequence),0)+1,? FROM mio_events WHERE runId=?').run(runId, at, runId);
  }
  function touch(runId: string, at = date()): void {
    const value = records.run(runId); if (value.revision === Number.MAX_SAFE_INTEGER) fail('AGENT_TASK_REVISION_LIMIT');
    db.prepare('UPDATE mio_runs SET revision=revision+1,updatedAt=? WHERE id=?').run(new Date(Math.max(Date.parse(at), Date.parse(value.createdAt), Date.parse(value.updatedAt))).toISOString(), runId);
  }
  function parseSettingsBinding(value:unknown){const parsed=agentSettingsBindingSchema.safeParse(value);if(!parsed.success)return fail('AGENT_TASK_STORAGE_CORRUPT');return parsed.data;}
  function run(id: string): AgentTaskRun {
    const value = records.run(id), first = content(id, 'user_message')[0]?.value;
    if (!first || typeof first.text !== 'string' || value.configurationBlobHash === null) return fail('AGENT_TASK_STORAGE_CORRUPT');
    const rulesEntries = entries(id, 'rules_snapshot');
    if (value.rulesSnapshotHash === null ? rulesEntries.length !== 0 : rulesEntries.length !== 1 || rulesEntries[0]!.payloadBlobHash !== value.rulesSnapshotHash) return fail('AGENT_TASK_STORAGE_CORRUPT');
    if (value.rulesSnapshotHash !== null) payload(rulesEntries[0]!);
    const contextEntry = content(id, 'host_hint').find(item => item.value.type === 'run_context'), metadata = contextEntry?.value;
    const state = content(id, 'host_state').filter(item => item.value.type === 'run_state').at(-1)?.value;
    const bindings = new Map<string, string>();
    for (const item of content(id, 'host_state')) if (item.value.type === 'notes_bound' && typeof item.value.modelStepId === 'string' && Array.isArray(item.value.requestIds)) for (const requestId of item.value.requestIds) if (typeof requestId === 'string') bindings.set(requestId, item.value.modelStepId);
    const notes: AgentTaskNote[] = content(id, 'note').map(({entry, value}) => {
      if (typeof value.requestId !== 'string' || typeof value.text !== 'string') return fail('AGENT_TASK_STORAGE_CORRUPT');
      const modelStepId = bindings.get(value.requestId); return {requestId: value.requestId, text: value.text, createdAt: entry.createdAt, ...(modelStepId ? {modelStepId} : {})};
    });
    const skippedTargets = content(id, 'host_state').filter(item => item.value.type === 'skipped_targets').flatMap(item => Array.isArray(item.value.items) ? item.value.items as unknown as AgentTaskSkippedTarget[] : []);
    return {id, projectId, conversationId: value.conversationId, requestId: value.requestId, text: first.text, notes, skippedTargets, status: value.status, revision: value.revision, stepLimit: value.stepLimit, budget: value.budget, stepsUsed: value.stepsUsed,
      configuration: decode<AgentTaskJson>(blob(value.configurationBlobHash)), ...(metadata?.settingsBinding===undefined?{}:{settingsBinding:parseSettingsBinding(metadata.settingsBinding)}), ...(value.settingsRevision === null ? {} : {settingsRevision: value.settingsRevision}),
      ...(metadata?.contextView === undefined || contextEntry === undefined ? {} : {context: contextProjection(contextEntry.entry.id, metadata.contextView)}), ...(metadata?.attachments === undefined ? {} : {attachments: metadata.attachments as string[]}), ...(metadata?.diagnostic === undefined ? {} : {diagnostic: metadata.diagnostic as unknown as AgentTaskRun['diagnostic']}),
      createdAt: value.createdAt, updatedAt: value.updatedAt, ...(typeof state?.reason === 'string' ? {pauseReason: state.reason} : {})};
  }
  function output(entryId: string): AgentTaskJson {
    const cache = readCache(), cached = cache?.outputs.get(entryId); if (cached !== undefined) return cached;
    const saved = payload(records.entry(entryId)); if (!object(saved)) return fail('AGENT_TASK_STORAGE_CORRUPT');
    const provider = saved.providerOutput; let text = ''; const toolCalls: AgentTaskJson[] = [];
    if (saved.protocol === 'chat_completions' && object(provider)) {
      text = typeof provider.content === 'string' ? provider.content : '';
      for (const item of Array.isArray(provider.tool_calls) ? provider.tool_calls : []) { if (!object(item) || !object(item.function)) return fail('AGENT_TASK_STORAGE_CORRUPT'); toolCalls.push({id: item.id!, name: item.function.name!, arguments: parseTaskArguments(String(item.function.arguments))}); }
    } else if (saved.protocol === 'responses' && Array.isArray(provider)) {
      for (const item of provider) if (object(item)) {
        if (item.type === 'function_call') toolCalls.push({id: item.call_id!, name: item.name!, arguments: parseTaskArguments(String(item.arguments))});
        if (item.type === 'message' && Array.isArray(item.content)) for (const part of item.content) if (object(part) && part.type === 'output_text' && typeof part.text === 'string') text += part.text;
      }
    } else if (saved.protocol === 'anthropic_messages' && object(provider) && Array.isArray(provider.content)) {
      for (const part of provider.content) if (object(part)) { if (part.type === 'text' && typeof part.text === 'string') text += part.text; if (part.type === 'tool_use') toolCalls.push({id: part.id!, name: part.name!, arguments: part.input!}); }
    } else return fail('AGENT_TASK_STORAGE_CORRUPT');
    const source = db.prepare("SELECT currentRequestId FROM mio_steps WHERE resultEntryId=? AND projectId=? AND kind='model'").get(entryId, projectId);
    if (!source || typeof source.currentRequestId !== 'string') return fail('AGENT_TASK_STORAGE_CORRUPT');
    const request = requestProjection(records.request(source.currentRequestId));
    if (!object(request) || typeof request.body !== 'string') return fail('AGENT_TASK_STORAGE_CORRUPT');
    const body = decode<Record<string, AgentTaskJson>>(request.body), definitions = Array.isArray(body.tools) ? body.tools : [];
    const declaresExplanation = (schema: AgentTaskJson | undefined, depth = 0): boolean => {
      if (depth > 32 || !object(schema)) return false;
      let declared = object(schema.properties) && Object.hasOwn(schema.properties, '_mio_step');
      for (const key of ['anyOf', 'oneOf', 'allOf']) if (Object.hasOwn(schema, key)) {
        const branches = schema[key]; if (!Array.isArray(branches) || !branches.length || !branches.every(branch => declaresExplanation(branch, depth + 1))) return false; declared = true;
      }
      return declared;
    };
    // Match gateway admission using this source request's frozen schema. An
    // upgraded catalog must not reinterpret an old no-wrapper tool intent.
    const projectedCalls = toolCalls.map(call => {
      if (!object(call) || typeof call.name !== 'string') return fail('AGENT_TASK_STORAGE_CORRUPT');
      const definition = definitions.find(item => object(item) && (object(item.function) ? item.function.name : item.name) === call.name);
      const schema = object(definition) ? object(definition.function) ? definition.function.parameters : definition.input_schema ?? definition.parameters : undefined;
      const args = call.arguments;
      return {...call, arguments: (!definition || declaresExplanation(schema)) && object(args) ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== '_mio_step')) : args!};
    });
    const value = {text, toolCalls: projectedCalls, providerOutput: provider!, ...(saved.usage === undefined ? {} : {usage: saved.usage})};
    cache?.outputs.set(entryId, value); return value;
  }
  function step(id: string): AgentTaskStep {
    const value = records.step(id), meta = object(value.data) ? value.data : {};
    const controls = object(meta.controls) ? meta.controls : {};
    const error = controls.error === undefined ? undefined : agentTaskStepErrorSchema.safeParse(controls.error);
    if (error?.success === false) return fail('AGENT_TASK_STORAGE_CORRUPT');
    const result = value.resultEntryId === null ? controls.resolution : value.kind === 'model' ? output(value.resultEntryId) : payload(records.entry(value.resultEntryId));
    let call: AgentTaskStep['toolCall'];
    if (value.sourceEntryId !== null && value.sourceCallIndex !== null) {
      const raw = records.sourceCall(value.sourceEntryId, value.sourceCallIndex), model = output(value.sourceEntryId);
      if (!object(model) || !Array.isArray(model.toolCalls)) return fail('AGENT_TASK_STORAGE_CORRUPT');
      const projected = model.toolCalls[value.sourceCallIndex];
      if (!object(projected) || projected.id !== raw.id || projected.name !== raw.name || projected.arguments === undefined) return fail('AGENT_TASK_STORAGE_CORRUPT');
      call = {id: raw.id, name: raw.name, arguments: structuredClone(projected.arguments)};
    }
    const explanation = call && value.sourceEntryId ? taskToolExplanation(output(value.sourceEntryId) as unknown as TaskModelOutput, call.id) : undefined;
    const partial = value.partialText === null ? null : meta.partialEncoding === 'json' ? decode<string>(value.partialText) : value.partialText;
    const text = partial ?? (value.kind === 'model' && value.status === 'completed' && object(result) && typeof result.text === 'string' ? result.text : explanation);
    return {id, runId: value.runId, position: value.position, kind: value.kind, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt,
      ...(value.tier === null ? {} : {tier: value.tier}), ...(call ? {toolCall: call} : {}), ...(result === undefined ? {} : {result}),
      ...(value.currentRequestId === null ? {} : {request: requestProjection(records.request(value.currentRequestId))}),
      ...(meta.request === undefined ? {} : {request: meta.request}), ...(meta.data === undefined && meta.baselineBlobHash === undefined ? {} : {data: typeof meta.baselineBlobHash === 'string' ? {...(object(meta.data) ? meta.data : {}), baseline: decode<AgentTaskJson>(blob(meta.baselineBlobHash))} : meta.data}),
      ...(controls.targets === undefined ? {} : {targets: controls.targets as unknown as AgentTaskTarget[]}), ...(error ? {error: error.data} : {}), ...(controls.cost === undefined ? {} : {cost: controls.cost as AgentTaskStep['cost']}),
      ...(text === undefined ? {} : {text})};
  }
  const allRuns = (): AgentTaskRun[] => db.prepare('SELECT id FROM mio_runs WHERE projectId=? ORDER BY rowid').all(projectId).map(row => run(String(row.id)));
  function background(runId: string): Array<{kind: string; id: string; status: string; stepId: string}> {
    records.run(runId);
    return db.prepare('SELECT kind,jobId,stepId FROM mio_job_origins WHERE runId=? AND projectId=? ORDER BY rowid').all(runId, projectId).map(row => {
      const kind = String(row.kind), table = {job: 'jobs', export: 'exports', image: 'image_tasks', frame: 'frame_tasks', scene: 'scene_tasks'}[kind];
      if (!table) return fail('AGENT_TASK_STORAGE_CORRUPT');
      const record = db.prepare(`SELECT * FROM ${table} WHERE id=? AND projectId=?`).get(String(row.jobId), projectId);
      const data = record && typeof record.data === 'string' ? decode<Record<string, unknown>>(record.data) : record;
      return {kind, id: String(row.jobId), stepId: String(row.stepId), status: typeof data?.status === 'string' ? data.status : typeof data?.state === 'string' ? data.state : 'unknown'};
    });
  }
  function hasPendingBackground(id: string): boolean {
    return background(id).some(item => !({job: ['succeeded', 'failed', 'cancelled'], export: ['succeeded', 'failed', 'cancelled'], image: ['succeeded', 'failed', 'cancelled_before_dispatch'], frame: ['succeeded', 'failed', 'cancelled_before_start'], scene: ['succeeded', 'undone', 'failed', 'local_result_error', 'interrupted', 'cancelled', 'cancelled_before_start']}[item.kind] ?? []).includes(item.status));
  }
  function snapshot(id: string): AgentTaskSnapshot {
    const value = run(id), execution = content(id, 'host_state').filter(item => item.value.type === 'run_state' && item.value.status !== 'reverted').at(-1);
    const ended = ['completed', 'failed', 'stopped', 'reverted'].includes(value.status) && execution && ['completed', 'failed', 'stopped'].includes(String(execution.value.status)) && (value.status === 'reverted' || value.status === execution.value.status);
    return {run: value, steps: records.steps(id).map(item => step(item.id)), changes: records.changes(id), backgroundPending: hasPendingBackground(id), ...(ended && typeof execution.value.updatedAt === 'string' ? {executionEndedAt: execution.value.updatedAt} : {})};
  }
  function create(input: Parameters<AgentTaskJournal['create']>[0]): AgentTaskSnapshot { return transact(() => {
    own(input.projectId); const digest = hash({projectId: input.projectId, conversationId: input.conversationId, text: input.text, configuration: input.configuration, settingsRevision: input.settingsRevision, ...(input.settingsBinding?{settingsBinding:input.settingsBinding}:{}), context: input.context, attachments: input.attachments, ...(input.diagnostic ? {diagnostic: input.diagnostic} : {}), ...(input.conversationModes ? {conversationModes: input.conversationModes} : {}), ...(input.rulesSnapshot ? {rulesSnapshot: input.rulesSnapshot} : {})});
    const old = db.prepare('SELECT id,digest FROM mio_runs WHERE requestId=? AND projectId=?').get(input.requestId, projectId);
    if (old) { if (old.digest !== digest) fail('AGENT_TASK_REQUEST_CONFLICT'); return snapshot(String(old.id)); }
    if (!store.get('projects', projectId)) fail('PROJECT_NOT_FOUND');
    if (input.conversationId !== undefined) { if (input.diagnostic || input.conversationModes) fail('AGENT_TASK_INVALID'); conversationSummary(projectId, input.conversationId); }
    if (input.conversationModes && input.diagnostic) fail('AGENT_TASK_INVALID');
    if (input.rulesSnapshot && input.diagnostic) fail('AGENT_TASK_INVALID');
    const conversationId = input.conversationId ?? randomUUID();
    const latest = allRuns().filter(item => item.conversationId === conversationId).reduce((previous, item) => Math.max(previous, Date.parse(item.createdAt), Date.parse(item.updatedAt)), -1);
    const timestamp = Math.max(Date.now(), latest + 1); if (!Number.isFinite(timestamp) || timestamp > 253402300799999) fail('AGENT_TASK_STORAGE_LIMIT');
    const at = new Date(timestamp).toISOString();
    if (!input.conversationId) records.createConversation({id: conversationId, createdAt: at, updatedAt: at});
    const configurationBlobHash = records.putBlob(encode(input.configuration), at), selected = input.policy ?? options.policy(), id = randomUUID();
    const rulesSnapshotHash = input.rulesSnapshot ? records.putBlob(encode(input.rulesSnapshot), at) : null;
    records.createRun({id, conversationId, requestId: input.requestId, digest, stepLimit: selected.stepLimit, budget: selected.stepLimit, locale: taskResponseLocale(input.context ?? []), configurationBlobHash, settingsRevision: input.settingsRevision ?? null, rulesSnapshotHash, createdAt: at, updatedAt: at});
    append(id, 'user_message', {text: input.text}, at);
    if (rulesSnapshotHash) records.appendEntry({id: randomUUID(), runId: id, kind: 'rules_snapshot', createdAt: at, payload: {blobHash: rulesSnapshotHash}});
    const sourceEntryIds = db.prepare('SELECT id FROM mio_entries WHERE conversationId=? AND projectId=? ORDER BY rowid').all(conversationId, projectId).map(row => String(row.id));
    append(id, 'host_hint', json({type: 'run_context', contextView: input.context === undefined ? undefined : contextAssembly.freezeContext(input.context, sourceEntryIds), attachments: input.attachments, diagnostic: input.diagnostic,...(input.settingsBinding?{settingsBinding:agentSettingsBindingSchema.parse(input.settingsBinding)}:{})}), at);
    if (input.conversationModes) {
      const modes = agentTaskPolicyModesSchema.parse(input.conversationModes);
      db.prepare('INSERT INTO mio_conversation_policies(conversationId,projectId,revision,data) VALUES(?,?,1,?)').run(conversationId, projectId, encode({conversationId, projectId, revision: 1, modes, updatedAt: at}));
      db.prepare('INSERT INTO mio_conversation_policy_requests(requestId,projectId,conversationId,revision,inputHash,response) VALUES(?,?,?,1,?,?)').run(input.requestId, projectId, conversationId, hash({sentConversationModes: modes}), encode(conversationPolicyView(projectId, conversationId)));
    }
    return snapshot(id);
  }); }
  function conversationTitle(text: string): string {
    const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim(); let title = '';
    for (const character of clean) { if (title.length + character.length > 120) break; title += character; } return title || '…';
  }
  function conversationSummary(id: string, conversationId: string): AgentTaskConversation {
    own(id); records.conversation(conversationId);
    const runs = allRuns().filter(item => !item.diagnostic && item.conversationId === conversationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const first = runs[0], last = runs.at(-1); if (!first || !last) return fail('AGENT_TASK_NOT_FOUND');
    return {id: conversationId, projectId, title: conversationTitle(first.text), createdAt: first.createdAt, updatedAt: runs.reduce((at, item) => item.updatedAt > at ? item.updatedAt : at, first.updatedAt), lastRunId: last.id, lastRunStatus: last.status, changeCount: runs.reduce((count, item) => count + records.changes(item.id).length, 0), runCount: runs.length};
  }
  function page(cursor: string | undefined, limit: number, scope: string[]): string[] | undefined {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('AGENT_TASK_INVALID');
    if (cursor === undefined) return; if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) fail('AGENT_TASK_INVALID');
    let value: unknown; try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { return fail('AGENT_TASK_INVALID'); }
    if (!Array.isArray(value) || value.length !== scope.length + 2 || scope.some((part, index) => part !== value[index]) || typeof value.at(-2) !== 'string' || !Number.isFinite(Date.parse(value.at(-2))) || typeof value.at(-1) !== 'string' || !/^[a-f0-9-]{36}$/iu.test(value.at(-1))) return fail('AGENT_TASK_INVALID');
    return value as string[];
  }
  function history(id: string, {cursor, limit = 50}: {cursor?: string; limit?: number} = {}): AgentTaskHistoryPage {
    own(id); const before = page(cursor, limit, [id]);
    const summaries = [...new Set(allRuns().filter(item => !item.diagnostic).map(item => item.conversationId!))].map(value => conversationSummary(id, value)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).filter(item => !before || item.updatedAt < before.at(-2)! || item.updatedAt === before.at(-2) && item.id < before.at(-1)!);
    const selected = summaries.slice(0, limit), last = selected.at(-1);
    return {conversations: selected, nextCursor: summaries.length > limit && last ? Buffer.from(encode([id, last.updatedAt, last.id])).toString('base64url') : null};
  }
  function conversation(id: string, conversationId: string, {cursor, limit = 50}: {cursor?: string; limit?: number} = {}): AgentTaskConversationPage {
    const summary = conversationSummary(id, conversationId), after = page(cursor, limit, [id, conversationId]);
    const rows = allRuns().filter(item => !item.diagnostic && item.conversationId === conversationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).filter(item => !after || item.createdAt > after.at(-2)! || item.createdAt === after.at(-2) && item.id > after.at(-1)!);
    const selected = rows.slice(0, limit), last = selected.at(-1);
    return {conversation: summary, runs: selected, nextCursor: rows.length > limit && last ? Buffer.from(encode([id, conversationId, last.createdAt, last.id])).toString('base64url') : null};
  }
  function requestConversationId(runId: string): string | undefined {
    const value = run(runId); return allRuns().some(item => !item.diagnostic && item.conversationId === value.conversationId && item.createdAt < value.createdAt) ? value.conversationId : undefined;
  }
  function contextRuns(id: string, conversationId: string): AgentTaskRun[] {
    conversationSummary(id, conversationId); return allRuns().filter(item => !item.diagnostic && item.conversationId === conversationId && item.status === 'completed').sort(newestRunFirst).slice(0, 4);
  }
  const newestRunFirst = (a: AgentTaskRun, b: AgentTaskRun): number => a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  function modelContextRuns(id: string, conversationId: string): TaskContextHistoryRun[] {
    own(id); records.conversation(conversationId);
    const payloadSql = (entry: string): string => `coalesce(${entry}.payloadJson,(SELECT content FROM mio_blobs WHERE sha256=${entry}.payloadBlobHash))`;
    const visible = `r.projectId=? AND r.conversationId=? AND NOT EXISTS(SELECT 1 FROM mio_entries h WHERE h.runId=r.id AND h.projectId=r.projectId AND h.kind='host_hint' AND json_extract(${payloadSql('h')},'$.type')='run_context' AND json_type(${payloadSql('h')},'$.diagnostic')='object')`;
    if (!db.prepare(`SELECT 1 FROM mio_runs r WHERE ${visible} LIMIT 1`).get(projectId, conversationId)) fail('AGENT_TASK_NOT_FOUND');
    const rows = db.prepare(`SELECT r.id,r.status FROM mio_runs r WHERE ${visible} AND r.status IN ('completed','failed','stopped','reverted') ORDER BY r.createdAt DESC,r.id DESC LIMIT 4`).all(projectId, conversationId);
    // SQLite extracts only the canonical text/call/answer fields needed by the
    // next round. Full step() also reconstructs its private request, so it must
    // remain exclusive to detailed snapshots and execution/recovery paths.
    const payloads = `payloads AS (SELECT e.id,e.runId,e.sequence,e.kind,${payloadSql('e')} AS payload FROM mio_entries e WHERE e.runId=? AND e.projectId=?)`;
    const finalSql = `WITH ${payloads}, last_model AS (
      SELECT p.payload FROM mio_steps s LEFT JOIN payloads p ON p.id=s.resultEntryId
      WHERE s.runId=? AND s.projectId=? AND s.kind='model' AND s.status='completed' ORDER BY s.position DESC LIMIT 1)
      SELECT json_extract(payload,'$.protocol') AS protocol,
       CASE WHEN json_type(payload,'$.providerOutput.content')='text' THEN payload -> '$.providerOutput.content' END AS text,
       CASE json_extract(payload,'$.protocol')
        WHEN 'responses' THEN (SELECT json_group_array(part.value -> '$.text' ORDER BY CAST(message.key AS INTEGER),CAST(part.key AS INTEGER)) FROM json_each(payload,'$.providerOutput') message JOIN json_each(CASE WHEN message.type='object' AND json_type(message.value,'$.content')='array' THEN message.value -> '$.content' ELSE '[]' END) part WHERE json_extract(CASE WHEN message.type='object' THEN message.value ELSE '{}' END,'$.type')='message' AND json_extract(CASE WHEN part.type='object' THEN part.value ELSE '{}' END,'$.type')='output_text' AND json_type(CASE WHEN part.type='object' THEN part.value ELSE '{}' END,'$.text')='text')
        WHEN 'anthropic_messages' THEN (SELECT json_group_array(part.value -> '$.text' ORDER BY CAST(part.key AS INTEGER)) FROM json_each(payload,'$.providerOutput.content') part WHERE json_extract(CASE WHEN part.type='object' THEN part.value ELSE '{}' END,'$.type')='text' AND json_type(CASE WHEN part.type='object' THEN part.value ELSE '{}' END,'$.text')='text')
       END AS parts FROM last_model`;
    const answersSql = `WITH ${payloads}, calls AS (
      SELECT p.id,row_number() OVER(PARTITION BY p.id ORDER BY CAST(call.key AS INTEGER))-1 AS callIndex,
       CASE json_extract(p.payload,'$.protocol') WHEN 'chat_completions' THEN json_extract(call.value,'$.function.name') ELSE json_extract(call.value,'$.name') END AS name,
       CASE json_extract(p.payload,'$.protocol') WHEN 'chat_completions' THEN json_extract(call.value,'$.function.arguments') WHEN 'responses' THEN json_extract(call.value,'$.arguments') ELSE call.value -> '$.input' END AS arguments
      FROM payloads p JOIN json_each(p.payload,CASE json_extract(p.payload,'$.protocol') WHEN 'chat_completions' THEN '$.providerOutput.tool_calls' WHEN 'responses' THEN '$.providerOutput' ELSE '$.providerOutput.content' END) call
      WHERE p.kind='model_output' AND call.type='object' AND (json_extract(p.payload,'$.protocol')='chat_completions' OR json_extract(p.payload,'$.protocol')='responses' AND json_extract(CASE WHEN call.type='object' THEN call.value ELSE '{}' END,'$.type')='function_call' OR json_extract(p.payload,'$.protocol')='anthropic_messages' AND json_extract(CASE WHEN call.type='object' THEN call.value ELSE '{}' END,'$.type')='tool_use'))
      SELECT s.position,c.arguments -> '$.question' AS question,
       (SELECT json_group_array(CASE WHEN o.type='object' THEN o.value -> '$.label' END ORDER BY CAST(o.key AS INTEGER)) FROM json_each(c.arguments,'$.options') o WHERE json_type(c.arguments,'$.options')='array') AS labels,
       c.arguments -> '$.multiple' AS multiple,c.arguments -> '$.allowOther' AS allowOther,
       a.payload -> '$.answer.choices' AS choices,a.payload -> '$.answer.text' AS text
      FROM mio_steps s JOIN calls c ON c.id=s.sourceEntryId AND c.callIndex=s.sourceCallIndex JOIN payloads a ON a.id=s.resultEntryId
      WHERE s.runId=? AND s.projectId=? AND s.kind='tool' AND s.status='completed' AND c.name='mioon_ask' AND json_type(a.payload,'$.answer')='object' ORDER BY s.position`;
    // A6 keeps basename-before-text-limit ordering and nontext fallback
    // blockers. Only these four historical name fields cross into JavaScript;
    // prompts, private payloads, before/after snapshots and undo stay in SQL.
    const names = (side: 'before' | 'after'): string => `(SELECT json_group_array(json_object('kind',v.value -> '$.kind','id',v.value -> '$.id','value',json_object(${['name', 'label', 'title', 'text'].map(field => `'${field}',CASE COALESCE(json_type(v.value,'$.value.${field}'),'null') WHEN 'text' THEN v.value -> '$.value.${field}' WHEN 'null' THEN NULL ELSE 0 END`).join(',')})) ORDER BY CAST(v.key AS INTEGER)) FROM json_each(c.data,'$.${side}') v WHERE json_type(c.data,'$.${side}')='array' AND v.type='object' AND json_type(v.value,'$.kind')='text' AND json_type(v.value,'$.id')='text' AND json_type(v.value,'$.value')='object')`;
    const changesSql = `SELECT id,stepId,json_extract(c.data,'$.operation') AS operation,json_extract(c.data,'$.status') AS status,json_extract(c.data,'$.reversible') AS reversible,json_extract(c.data,'$.createdAt') AS createdAt,json_extract(c.data,'$.targets') AS targets,${names('before')} AS beforeNames,${names('after')} AS afterNames FROM mio_changes c WHERE runId=? AND projectId=? ORDER BY rowid DESC LIMIT 64`;
    const backgroundSql = `SELECT b.kind,b.jobId,CASE b.kind
      WHEN 'job' THEN json_extract(j.data,'$.status') WHEN 'export' THEN json_extract(e.data,'$.status') WHEN 'image' THEN i.state WHEN 'frame' THEN f.state WHEN 'scene' THEN sc.state END AS status,json_extract(st.data,'$.controls.cost') AS cost
      FROM mio_job_origins b LEFT JOIN jobs j ON b.kind='job' AND j.id=b.jobId AND j.projectId=b.projectId
      LEFT JOIN exports e ON b.kind='export' AND e.id=b.jobId AND e.projectId=b.projectId
      LEFT JOIN image_tasks i ON b.kind='image' AND i.id=b.jobId AND i.projectId=b.projectId
      LEFT JOIN frame_tasks f ON b.kind='frame' AND f.id=b.jobId AND f.projectId=b.projectId
      LEFT JOIN scene_tasks sc ON b.kind='scene' AND sc.id=b.jobId AND sc.projectId=b.projectId
      LEFT JOIN mio_steps st ON st.id=b.stepId AND st.runId=b.runId AND st.projectId=b.projectId
      WHERE b.runId=? AND b.projectId=? ORDER BY b.rowid DESC LIMIT 64`;
    const identity = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
    return rows.map(row => {
      const runId = String(row.id), status = String(row.status) as TaskContextHistoryRun['status'];
      const states = content(runId, 'host_state').map(item => item.value), notes = content(runId, 'note'), bindings = new Map<string, string>();
      for (const state of states) if (state.type === 'notes_bound' && typeof state.modelStepId === 'string' && Array.isArray(state.requestIds)) for (const requestId of state.requestIds) if (typeof requestId === 'string') bindings.set(requestId, state.modelStepId);
      const steps = db.prepare("SELECT id,position,kind,status,json_extract(data,'$.controls.error.code') AS errorCode FROM mio_steps WHERE runId=? AND projectId=? ORDER BY position").all(runId, projectId);
      const history: Array<{position: number; order: number; input: TaskContextHistoryInput}> = [];
      for (const item of db.prepare(answersSql).iterate(runId, projectId, runId, projectId)) {
        const labels = decode<unknown[]>(item.labels), question = agentTaskQuestionSchema.safeParse({question: item.question === null ? undefined : decode<unknown>(item.question), options: labels.map(label => ({label})), ...(item.multiple === null ? {} : {multiple: decode<unknown>(item.multiple)}), ...(item.allowOther === null ? {} : {allowOther: decode<unknown>(item.allowOther)})});
        const answer = agentTaskAnswerSchema.safeParse({choices: item.choices === null ? undefined : decode<unknown>(item.choices), ...(item.text === null ? {} : {text: decode<unknown>(item.text)})});
        if (!question.success || !answer.success) continue;
        const {choices, text} = answer.data;
        if (new Set(choices).size !== choices.length || choices.some(index => index >= question.data.options.length) || !question.data.multiple && choices.length > 1 || choices.length && text !== undefined && !question.data.allowOther || !choices.length && text === undefined) continue;
        history.push({position: Number(item.position), order: history.length, input: {kind: 'answer', question: question.data.question, selected: choices.map(index => question.data.options[index]!.label), ...(text === undefined ? {} : {text})}});
      }
      if (history.length) for (const note of notes) history.push({position: Number(steps.find(item => item.id === bindings.get(String(note.value.requestId)) && item.kind === 'model')?.position ?? Number.POSITIVE_INFINITY), order: history.length, input: {kind: 'note', text: String(note.value.text)}});
      let finalText: string | undefined;
      if (status === 'completed') {
        const final = db.prepare(finalSql).get(runId, projectId, runId, projectId);
        if (final) {
          if (final.protocol === 'chat_completions') finalText = final.text === null ? '' : decode<string>(final.text);
          else if (final.protocol === 'responses' || final.protocol === 'anthropic_messages') finalText = decode<string[]>(final.parts).join('');
          else fail('AGENT_TASK_STORAGE_CORRUPT');
        }
      }
      const execution = states.filter(item => item.type === 'run_state' && item.status !== 'reverted').at(-1), current = states.filter(item => item.type === 'run_state').at(-1);
      const error = db.prepare(`SELECT json_extract(${payloadSql('e')},'$.code') AS code FROM mio_entries e WHERE e.runId=? AND e.projectId=? AND e.kind='host_hint' AND json_extract(${payloadSql('e')},'$.type')='error' ORDER BY sequence DESC LIMIT 1`).get(runId, projectId);
      const failure = current?.reason ?? error?.code ?? steps.filter(item => ['failed', 'unknown'].includes(String(item.status))).at(-1)?.errorCode;
      const failureCode = (status === 'failed' || execution?.status === 'failed') && typeof failure === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(failure) ? failure : undefined;
      const skippedTargets = states.filter(item => item.type === 'skipped_targets').flatMap(item => Array.isArray(item.items) ? item.items as unknown as AgentTaskSkippedTarget[] : []);
      const skipped: TaskRunRecordTarget[] = skippedTargets.slice(-64).reverse().flatMap(({target}) => /^[a-z][a-z0-9_]{0,79}$/u.test(target.kind) && identity.test(target.id) && typeof target.revision === 'number' ? [{kind: target.kind, id: target.id, revision: target.revision}] : []);
      const projectedBackground: TaskRunRecordBackground[] = [];
      for (const item of db.prepare(backgroundSql).iterate(runId, projectId)) {
        if (typeof item.jobId !== 'string' || !identity.test(item.jobId)) continue;
        const cost = item.cost === 'pending' || item.cost === 'submitted' || item.cost === 'unknown' || item.cost === 'charged' ? item.cost : undefined;
        projectedBackground.push({kind: typeof item.kind === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(item.kind) ? item.kind : 'unknown', id: item.jobId, status: typeof item.status === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(item.status) ? item.status : 'unknown', ...(cost ? {cost} : {})});
      }
      const changes: TaskRunRecordChange[] = [];
      for (const item of db.prepare(changesSql).iterate(runId, projectId)) {
        const change: AgentTaskChange = {id: String(item.id), runId, stepId: String(item.stepId), projectId, operation: String(item.operation), status: String(item.status) as AgentTaskChange['status'], reversible: item.reversible === 1, createdAt: String(item.createdAt), targets: decode<AgentTaskTarget[]>(item.targets), before: decode<AgentTaskJson>(item.beforeNames), after: decode<AgentTaskJson>(item.afterNames)};
        const display = projectAgentTaskChangeDisplay(change); changes.push({id: change.id, status: change.status, reversible: change.reversible, operation: display.operation, targets: display.targets.slice(0, 8), targetCount: display.targetCount});
      }
      const user = content(runId, 'user_message')[0]?.value;
      if (!user || typeof user.text !== 'string' || notes.some(note => typeof note.value.text !== 'string')) fail('AGENT_TASK_STORAGE_CORRUPT');
      const backgroundTotal = Number(db.prepare('SELECT count(*) AS n FROM mio_job_origins WHERE runId=? AND projectId=?').get(runId, projectId)!.n), changeTotal = Number(db.prepare('SELECT count(*) AS n FROM mio_changes WHERE runId=? AND projectId=?').get(runId, projectId)!.n);
      return {id: runId, text: user.text, notes: notes.map(note => String(note.value.text)), status, ...(history.length ? {historyInputs: history.sort((a, b) => a.position - b.position || a.order - b.order).map(item => item.input)} : {}), ...(finalText === undefined ? {} : {finalText}), record: {runId, status, ...(failureCode ? {failureCode} : {}), skipped: {items: skipped, total: skippedTargets.length}, background: {items: projectedBackground, total: backgroundTotal}, changes: {items: changes, total: changeTotal}}};
    });
  }
  const allowedRun: Record<AgentTaskStatus, AgentTaskStatus[]> = {accepted: ['running', 'stopped', 'failed', 'interrupted'], running: ['paused', 'awaiting_approval', 'awaiting_answer', 'completed', 'failed', 'stopped', 'interrupted'], paused: ['running', 'stopped', 'failed', 'interrupted'], awaiting_approval: ['running', 'paused', 'stopped', 'failed', 'interrupted'], awaiting_answer: ['running', 'stopped', 'failed', 'interrupted'], interrupted: ['running', 'stopped', 'failed'], completed: ['reverted'], failed: ['running', 'reverted'], stopped: ['reverted'], reverted: []};
  function transition(runId: string, expectedRevision: number, status: AgentTaskStatus, reason?: string): AgentTaskRun { return transact(() => {
    const value = run(runId); if (value.revision !== expectedRevision) fail('AGENT_TASK_REVISION_CONFLICT');
    if (value.status !== status && !allowedRun[value.status].includes(status) && !(value.status === 'completed' && ['paused', 'awaiting_approval', 'stopped', 'interrupted'].includes(status) && hasPendingBackground(runId))) fail('AGENT_TASK_STATE_CONFLICT');
    const at = date(), updatedAt = new Date(Math.max(Date.parse(at), Date.parse(value.createdAt), Date.parse(value.updatedAt))).toISOString(); db.prepare('UPDATE mio_runs SET status=? WHERE id=?').run(status, runId); append(runId, 'host_state', {type: 'run_state', status, updatedAt, ...(reason ? {reason} : {})}, at); return run(runId);
  }); }
  function metadata(input: ModelInput, at: string): AgentTaskJson {
    const data = object(input.data) ? {...input.data} : input.data;
    let baselineBlobHash: string | undefined;
    if (object(data) && Object.hasOwn(data, 'baseline')) { baselineBlobHash = records.putBlob(encode(data.baseline), at); delete data.baseline; }
    return json({data, baselineBlobHash, controls: {targets: input.targets}, ...(input.request === undefined ? {} : {request: input.request})});
  }
  function beginStep(runId: string, input: AgentTaskStepInput): AgentTaskStep { return transact(() => {
    const value = run(runId); if (value.status !== 'running') fail('AGENT_TASK_STATE_CONFLICT');
    if (input.kind !== 'wait' && value.stepsUsed >= value.budget) fail('AGENT_TASK_BUDGET_EXHAUSTED');
    const at = date(), id = randomUUID(); let sourceEntryId: string | undefined, sourceCallIndex: number | undefined;
    if (input.kind === 'tool') {
      const sourceId = object(input.data) && typeof input.data.sourceModelStepId === 'string' ? input.data.sourceModelStepId : undefined;
      const source = sourceId ? records.step(sourceId) : undefined;
      if (!source || source.runId !== runId || source.kind !== 'model' || source.resultEntryId === null || !input.toolCall) fail('AGENT_TASK_INVALID');
      sourceEntryId = source.resultEntryId;
      const model = output(sourceEntryId); if (!object(model) || !Array.isArray(model.toolCalls)) return fail('AGENT_TASK_STORAGE_CORRUPT');
      sourceCallIndex = model.toolCalls.findIndex(item => isDeepStrictEqual(item, input.toolCall)); if (sourceCallIndex < 0) fail('AGENT_TASK_INVALID');
    }
    // position counts wait records too; a wait must not consume model/tool budget.
    const position = Number(db.prepare('SELECT coalesce(max(position),0)+1 AS value FROM mio_steps WHERE runId=?').get(runId)!.value);
    if (sourceEntryId !== undefined && sourceCallIndex !== undefined) {
      records.sourceCall(sourceEntryId, sourceCallIndex);
      if (db.prepare("SELECT 1 FROM mio_steps WHERE runId=? AND kind='tool' AND sourceEntryId=? AND sourceCallIndex=?").get(runId, sourceEntryId, sourceCallIndex)) fail('AGENT_TASK_REQUEST_CONFLICT');
    }
    db.prepare("INSERT INTO mio_steps(id,runId,projectId,position,kind,status,tier,createdAt,updatedAt,currentRequestId,sourceEntryId,sourceCallIndex,resultEntryId,partialText,data) VALUES(?,?,?,?,?,'intent',?,?,?,NULL,?,?,NULL,NULL,?)").run(id, runId, projectId, position, input.kind, input.tier ?? null, at, at, sourceEntryId ?? null, sourceCallIndex ?? null, encode(metadata({...input, request: input.kind === 'model' ? undefined : input.request}, at)));
    if (input.kind !== 'wait') db.prepare('UPDATE mio_runs SET stepsUsed=stepsUsed+1 WHERE id=?').run(runId);
    touch(runId, at); notify(runId, at); return step(id);
  }); }
  function beginModelStep(runId: string, input: ModelInput, noteRequestIds: string[]): AgentTaskStep { return transact(() => {
    const pending = (run(runId).notes ?? []).filter(note => note.modelStepId === undefined);
    if (!isDeepStrictEqual(pending.map(note => note.requestId), noteRequestIds)) fail('AGENT_TASK_REVISION_CONFLICT');
    const item = beginStep(runId, {...input, kind: 'model'});
    const request = assembly.freeze(runId, item.id, input, noteRequestIds);
    if (request.stepId !== item.id) fail('AGENT_TASK_INVALID'); records.beginRequest(request);
    if (pending.length) append(runId, 'host_state', {type: 'notes_bound', modelStepId: item.id, requestIds: noteRequestIds});
    return step(item.id);
  }); }
  function prepareModelStep(runId: string, stepId: string): AgentTaskStep { return transact(() => {
    const saved = records.step(stepId); if (saved.runId !== runId) fail('AGENT_TASK_NOT_FOUND');
    if (saved.kind !== 'model' || saved.currentRequestId === null) fail('AGENT_TASK_INVALID');
    const request = records.request(saved.currentRequestId);
    // A former beforeSubmit rejection can reset the logical step, but never
    // erases the historical dispatch boundary or permits an upgrade.
    if (saved.status === 'intent' && request.state === 'intent' && request.dispatchStartedAt === null) {
      const replacement = assembly.upgrade?.(request);
      if (replacement) records.reassembleRequest(request.id, replacement, randomUUID());
    }
    return step(stepId);
  }); }
  function appendNoteInside(runId: string, requestId: string, text: string): AgentTaskNote {
    inside(); const value = run(runId); if (!['running', 'awaiting_approval', 'paused'].includes(value.status)) fail('AGENT_TASK_STATE_CONFLICT');
    if ((value.notes ?? []).filter(item => item.modelStepId === undefined).length >= 5) fail('AGENT_TASK_NOTE_LIMIT');
    if (value.notes?.some(item => item.requestId === requestId)) fail('AGENT_TASK_REQUEST_CONFLICT');
    const at = new Date(Math.max(Date.now(), Date.parse(value.createdAt), Date.parse(value.updatedAt))).toISOString(); append(runId, 'note', {requestId, text}, at); return {requestId, text, createdAt: at};
  }
  function skipTargetsInside(runId: string, targets: Array<{stepId: string; target: AgentTaskTarget}>): AgentTaskSkippedTarget[] {
    inside(); const value = run(runId), seen = new Set((value.skippedTargets ?? []).map(item => encode([item.target.kind, item.target.id]))), added: AgentTaskSkippedTarget[] = [];
    for (const item of targets) { const identity = encode([item.target.kind, item.target.id]); if (seen.has(identity)) continue; const source = records.step(item.stepId); if (source.runId !== runId || source.kind !== 'tool') fail('AGENT_TASK_INVALID'); seen.add(identity); added.push({target: structuredClone(item.target), stepId: item.stepId, createdAt: date()}); }
    if (!added.length) fail('AGENT_TASK_INVALID'); append(runId, 'host_state', {type: 'skipped_targets', items: json(added)}); return added;
  }
  const allowedStep: Record<AgentTaskStepStatus, AgentTaskStepStatus[]> = {intent: ['awaiting_approval', 'awaiting_answer', 'dispatch_started', 'completed', 'denied', 'rejected', 'failed'], awaiting_approval: ['intent', 'denied', 'rejected', 'failed'], awaiting_answer: ['completed'], dispatch_started: ['completed', 'failed', 'unknown'], unknown: ['completed', 'failed'], completed: [], denied: [], rejected: [], failed: []};
  type StepPatch = Partial<Pick<AgentTaskStep, 'status' | 'request' | 'data' | 'result' | 'error' | 'cost' | 'targets' | 'tier'>>;
  function updateStep(runId: string, stepId: string, patch: StepPatch): AgentTaskStep { return transact(() => {
    const saved = records.step(stepId), current = step(stepId); if (saved.runId !== runId) fail('AGENT_TASK_NOT_FOUND');
    const status = patch.status ?? saved.status;
    if (status !== saved.status && !allowedStep[saved.status].includes(status)) fail('AGENT_TASK_STATE_CONFLICT');
    if (saved.kind === 'model' && Object.hasOwn(patch, 'request') && !isDeepStrictEqual(patch.request, current.request)) fail('AGENT_TASK_REQUEST_IMMUTABLE');
    if (saved.kind === 'model' && status === 'completed' && saved.status !== 'completed') return completeStepInside(runId, stepId, {result: patch.result});
    if (saved.kind === 'model' && status === 'dispatch_started' && saved.status !== 'dispatch_started') return markDispatch(runId, stepId);
    const at = date(), meta = object(saved.data) ? {...saved.data} : {}, controls = object(meta.controls) ? {...meta.controls} : {};
    if (patch.data !== undefined) {
      const next = metadata({data: patch.data}, at); if (!object(next)) return fail('AGENT_TASK_STORAGE_CORRUPT');
      meta.data = next.data ?? null; if (next.baselineBlobHash !== undefined) meta.baselineBlobHash = next.baselineBlobHash; else delete meta.baselineBlobHash;
    }
    for (const key of ['cost', 'targets'] as const) if (patch[key] !== undefined) controls[key] = json(patch[key]);
    if (patch.error !== undefined) {
      const error = agentTaskStepErrorSchema.safeParse(patch.error);
      if (!error.success) return fail('AGENT_TASK_INVALID');
      controls.error = json(error.data);
    }
    if (saved.kind !== 'model' && patch.request !== undefined) meta.request = patch.request;
    let resultEntryId = saved.resultEntryId;
    if (patch.result !== undefined && !isDeepStrictEqual(patch.result, current.result)) {
      if (saved.kind === 'model') controls.resolution = patch.result;
      else resultEntryId = append(runId, saved.kind === 'tool' && current.toolCall?.name === 'mioon_ask' ? 'answer' : 'tool_result', patch.result, at).id;
    }
    meta.controls = controls;
    if (saved.kind === 'model' && saved.currentRequestId !== null && status !== saved.status) {
      const request = records.request(saved.currentRequestId);
      if (request.state === 'dispatch_started' && (status === 'failed' || status === 'unknown')) records.failRequest(request.id, status, at);
      else if (request.state === 'intent' && status === 'failed') db.prepare("UPDATE mio_requests SET state='failed',completedAt=? WHERE id=?").run(at, request.id);
    }
    db.prepare('UPDATE mio_steps SET status=?,tier=?,data=?,resultEntryId=?,updatedAt=? WHERE id=?').run(status, patch.tier ?? saved.tier, encode(meta), resultEntryId, at, stepId);
    touch(runId, at); notify(runId, at);
    if (saved.kind === 'model' && status !== saved.status) updateMioRunUsageSummary(store, runId);
    return step(stepId);
  }); }
  function markDispatch(runId: string, stepId: string): AgentTaskStep { return transact(() => {
    const saved = records.step(stepId); if (saved.runId !== runId) fail('AGENT_TASK_NOT_FOUND');
    if (saved.kind === 'model') {
      if (saved.currentRequestId === null) fail('AGENT_TASK_STORAGE_CORRUPT');
      const request = records.request(saved.currentRequestId);
      if (request.state === 'intent') records.markDispatched(request.id, date());
      else if (request.state === 'dispatch_started' && saved.status === 'intent' && object(saved.data) && object(saved.data.data) && saved.data.data.dispatchPrevented === true) {
        db.prepare("UPDATE mio_steps SET status='dispatch_started',updatedAt=? WHERE id=?").run(date(), stepId); touch(runId); notify(runId);
        updateMioRunUsageSummary(store, runId);
      } else fail('AGENT_TASK_STATE_CONFLICT');
      return step(stepId);
    }
    if (saved.status !== 'intent') fail('AGENT_TASK_STATE_CONFLICT');
    db.prepare("UPDATE mio_steps SET status='dispatch_started',updatedAt=? WHERE id=?").run(date(), stepId); touch(runId); notify(runId); return step(stepId);
  }); }
  function dispatchPrevented(runId: string, stepId: string, next: 'intent' | 'awaiting_approval'): AgentTaskStep { return transact(() => {
    const saved = records.step(stepId); if (saved.runId !== runId) fail('AGENT_TASK_NOT_FOUND'); if (saved.status !== 'dispatch_started') fail('AGENT_TASK_STATE_CONFLICT');
    const meta = object(saved.data) ? {...saved.data} : {}; meta.data = {...(object(meta.data) ? meta.data : {}), dispatchPrevented: true};
    // The beforeSubmit guard proved this attempt did not send. Historical
    // dispatch evidence remains immutable and cannot authorize reassembly.
    db.prepare('UPDATE mio_steps SET status=?,data=?,updatedAt=? WHERE id=?').run(next, encode(meta), date(), stepId); touch(runId); notify(runId);
    if (saved.kind === 'model') updateMioRunUsageSummary(store, runId);
    return step(stepId);
  }); }
  function appendChangesInside(runId: string, stepId: string, changes: AgentTaskChangeInput[]): AgentTaskChange[] {
    inside(); const value = records.step(stepId); if (value.runId !== runId) fail('AGENT_TASK_NOT_FOUND');
    return changes.map(change => { if (change.projectId !== projectId) fail('AGENT_TASK_PROJECT_MISMATCH'); return records.addChange({...change, id: randomUUID(), runId, stepId, status: 'applied', createdAt: date()}); });
  }
  function completeStepInside(runId: string, stepId: string, input: {result?: AgentTaskJson; change?: AgentTaskChangeInput; changes?: AgentTaskChangeInput[]} = {}): AgentTaskStep {
    inside(); const saved = records.step(stepId); if (saved.runId !== runId) fail('AGENT_TASK_NOT_FOUND'); if (saved.status === 'completed') return step(stepId);
    if (saved.status !== 'dispatch_started' && !(saved.status === 'intent' && (saved.kind === 'model' || saved.kind === 'wait'))) fail('AGENT_TASK_STATE_CONFLICT');
    appendChangesInside(runId, stepId, [...(input.change ? [input.change] : []), ...(input.changes ?? [])]);
    const at = date();
    if (saved.kind === 'model') {
      if (saved.currentRequestId === null || !object(input.result) || input.result.providerOutput === undefined) fail('AGENT_TASK_STORAGE_CORRUPT');
      const request = records.request(saved.currentRequestId);
      records.completeModelRequest(request.id, {entryId: randomUUID(), output: {protocol: request.protocol, providerOutput: input.result.providerOutput, ...(object(input.result.usage) ? {usage: input.result.usage} : {})}, at});
    } else {
      const resultEntryId = input.result === undefined ? saved.resultEntryId : append(runId, step(stepId).toolCall?.name === 'mioon_ask' ? 'answer' : 'tool_result', input.result, at).id;
      db.prepare("UPDATE mio_steps SET status='completed',resultEntryId=?,partialText=NULL,updatedAt=? WHERE id=?").run(resultEntryId, at, stepId); touch(runId, at); notify(runId, at);
    }
    return step(stepId);
  }
  function appendText(runId: string, stepId: string, text: string): void { transact(() => {
    const saved = records.step(stepId); if (saved.runId !== runId) fail('AGENT_TASK_NOT_FOUND'); if (saved.kind !== 'model' || saved.status !== 'dispatch_started') fail('AGENT_TASK_STATE_CONFLICT');
    const meta = object(saved.data) ? saved.data : {}, before = saved.partialText === null ? '' : meta.partialEncoding === 'json' ? decode<string>(saved.partialText) : saved.partialText;
    const next = before + text; if (Buffer.byteLength(next) > 256 * 1024) fail('AGENT_TASK_STORAGE_LIMIT');
    // JSON escaping keeps an isolated UTF-16 surrogate intact through SQLite's
    // UTF-8 TEXT boundary. It is still one bounded mutable checkpoint.
    records.updateStep(stepId, saved.status, {status: saved.status, updatedAt: date(), partialText: encode(next), data: {...meta, partialEncoding: 'json'}});
  }); }
  function appendEvent(runId: string, type: string, data: AgentTaskJson): AgentTaskEvent { return transact(() => {
    const at = date(); append(runId, 'host_hint', {type, ...(object(data) ? data : {value: data})}, at); const sequence = Number(db.prepare('SELECT max(sequence) AS value FROM mio_events WHERE runId=?').get(runId)!.value); return {runId, type, data, createdAt: at, sequence};
  }); }
  function events(runId: string, after = 0): AgentTaskEvent[] {
    return records.events(runId, after).map(event => ({...event, type: 'invalidate', data: null}));
  }
  function lookupControl(requestId: string): AgentTaskReceipt | null {
    const saved = records.control(requestId); return saved ? (records.controlState(requestId) ?? saved.data) as unknown as AgentTaskReceipt : null;
  }
  function savedControl(input: AgentTaskControlRecord): AgentTaskReceipt | null {
    const saved = records.control(input.requestId); if (!saved) return null; if (saved.digest !== hash(input)) fail('AGENT_TASK_REQUEST_CONFLICT'); return lookupControl(input.requestId);
  }
  function receipt(input: AgentTaskControlRecord, result: AgentTaskJson): AgentTaskReceipt {
    const value: AgentTaskReceipt = {requestId: input.requestId, runId: input.runId, action: input.action, revision: records.run(input.runId).revision, result};
    records.saveControl({requestId: input.requestId, runId: input.runId, digest: hash(input), data: json(value)}, date()); return value;
  }
  function control(input: AgentTaskControlRecord, result: AgentTaskJson = null): AgentTaskReceipt { return transact(() => {
    const saved = savedControl(input); if (saved) return saved; if (records.run(input.runId).revision !== input.expectedRevision) fail('AGENT_TASK_REVISION_CONFLICT'); return receipt(input, result);
  }); }
  function performControl(input: AgentTaskControlRecord, apply: () => AgentTaskJson): AgentTaskReceipt { return transact(() => {
    const saved = savedControl(input); if (saved) return saved; if (records.run(input.runId).revision !== input.expectedRevision) fail('AGENT_TASK_REVISION_CONFLICT'); return receipt(input, apply());
  }); }
  function rejectControl(input: AgentTaskControlRecord, failureCode: string): AgentTaskReceipt { return transact(() => {
    if (!/^[A-Z0-9_]{1,100}$/u.test(failureCode)) fail('AGENT_TASK_INVALID'); return savedControl(input) ?? receipt(input, {state: 'rejected', code: failureCode});
  }); }
  function beginControl(input: AgentTaskControlRecord): AgentTaskReceipt { return savedControl(input) ?? control(input, {state: 'pending'}); }
  function finishControl(requestId: string, result: AgentTaskJson): AgentTaskReceipt { return transact(() => {
    const saved = lookupControl(requestId); if (!saved) fail('AGENT_TASK_NOT_FOUND'); const value = {...saved, revision: records.run(saved.runId).revision, result}; records.setControlState(requestId, json(value), date()); return value;
  }); }
  function resume(runId: string, expectedRevision: number, {extendBudget = false}: {extendBudget?: boolean} = {}): AgentTaskRun { return transact(() => {
    const value = records.run(runId); if (value.revision !== expectedRevision) fail('AGENT_TASK_REVISION_CONFLICT'); if (!['paused', 'awaiting_approval', 'awaiting_answer', 'interrupted'].includes(value.status)) fail('AGENT_TASK_STATE_CONFLICT');
    if (records.steps(runId).some(item => item.status === 'dispatch_started' || item.status === 'unknown')) fail('AGENT_TASK_UNKNOWN_RESULT');
    let budget = value.budget; if (extendBudget && value.stepsUsed >= budget) { budget += value.stepLimit; if (!Number.isSafeInteger(budget)) fail('AGENT_TASK_BUDGET_LIMIT'); }
    db.prepare('UPDATE mio_runs SET budget=? WHERE id=?').run(budget, runId); return transition(runId, expectedRevision, 'running');
  }); }
  function recover(): number { return transact(() => {
    let count = 0;
    for (const value of allRuns()) if (['accepted', 'running', 'paused', 'awaiting_approval', 'awaiting_answer'].includes(value.status) || value.status === 'completed' && hasPendingBackground(value.id)) {
      for (const item of records.steps(value.id)) if (item.status === 'dispatch_started') updateStep(value.id, item.id, {status: 'unknown'});
      transition(value.id, records.run(value.id).revision, value.diagnostic ? 'stopped' : 'interrupted', !value.diagnostic && (value.pauseReason === 'conflict' || value.pauseReason === 'editing') ? value.pauseReason : 'restart'); count++;
    }
    markClaimsUncertain();
    for (const row of db.prepare('SELECT requestId FROM mio_controls WHERE projectId=?').all(projectId)) {
      const requestId = String(row.requestId), saved = lookupControl(requestId);
      if (saved && object(saved.result) && saved.result.state === 'pending') finishControl(requestId, {state: 'blocked', error: {code: 'AGENT_TASK_INTERRUPTED', message: '控制操作因进程重启而中断；已完成的变更回退保持不变。'}, revertedIds: records.changes(saved.runId).filter(change => change.status === 'reverted').map(change => change.id)});
    }
    return count;
  }); }
  const policy = (): AgentTaskPolicy => options.policy();
  function conversationPolicyView(id: string, conversationId: string): AgentTaskConversationPolicy {
    own(id); const saved = records.conversationPolicy(conversationId), global = policy(); return agentTaskConversationPolicySchema.parse({projectId, conversationId, revision: saved?.revision ?? 0, override: saved?.modes ?? null, global, effective: saved?.modes ?? global.modes});
  }
  function conversationPolicy(id: string, conversationId: string): AgentTaskConversationPolicy { conversationSummary(id, conversationId); return conversationPolicyView(id, conversationId); }
  function effectiveModes(id: string, conversationId?: string): AgentTaskPolicyModes { own(id); return structuredClone(conversationId ? records.conversationPolicy(conversationId)?.modes ?? policy().modes : policy().modes); }
  function sentConversationModesMatch(requestId: string, modes?: AgentTaskPolicyModes): boolean {
    const saved = db.prepare('SELECT inputHash FROM mio_conversation_policy_requests WHERE requestId=? AND projectId=?').get(requestId, projectId); return saved ? modes !== undefined && saved.inputHash === hash({sentConversationModes: agentTaskPolicyModesSchema.parse(modes)}) : modes === undefined;
  }
  function setConversationPolicy(id: string, conversationId: string, request: AgentTaskConversationPolicySetInput): AgentTaskConversationPolicy { return transact(() => {
    own(id); const inputHash = hash({projectId, conversationId, expectedRevision: request.expectedRevision, modes: request.modes, acknowledgePaid: request.acknowledgePaid === true});
    const saved = db.prepare('SELECT inputHash,response,conversationId FROM mio_conversation_policy_requests WHERE requestId=? AND projectId=?').get(request.requestId, projectId);
    if (saved) { if (saved.inputHash !== inputHash || saved.conversationId !== conversationId) fail('AGENT_TASK_REQUEST_CONFLICT'); return agentTaskConversationPolicySchema.parse(decode(saved.response)); }
    conversationSummary(id, conversationId); const old = records.conversationPolicy(conversationId), global = policy(), revision = old?.revision ?? 0;
    if (request.expectedRevision !== revision) fail('AGENT_TASK_REVISION_CONFLICT'); if (revision === Number.MAX_SAFE_INTEGER) fail('AGENT_TASK_REVISION_LIMIT');
    if ((request.modes ?? global.modes).paid === 'direct' && (old?.modes ?? global.modes).paid !== 'direct' && request.acknowledgePaid !== true) fail('AGENT_TASK_APPROVAL_REQUIRED');
    const modes = request.modes === null ? null : agentTaskPolicyModesSchema.parse(request.modes), at = date();
    db.prepare('INSERT INTO mio_conversation_policies(conversationId,projectId,revision,data) VALUES(?,?,?,?) ON CONFLICT(conversationId) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(conversationId, projectId, revision + 1, encode({conversationId, projectId, revision: revision + 1, modes, updatedAt: at}));
    const view = conversationPolicyView(id, conversationId); db.prepare('INSERT INTO mio_conversation_policy_requests(requestId,projectId,conversationId,revision,inputHash,response) VALUES(?,?,?,?,?,?)').run(request.requestId, projectId, conversationId, revision + 1, inputHash, encode(view)); return view;
  }); }
  function targetRevision(id: string, kind: string, targetId: string): number { own(id); return readMioTargetRevision(db, id, kind, targetId) ?? 0; }
  function claims(id: string, ownerId?: string): AgentTaskClaim[] {
    own(id); return records.claims(ownerId).map(({kind, targetId, revision, ...claim}) => ({...claim, target: {kind, id: targetId, revision}})).sort((a, b) => a.id.localeCompare(b.id));
  }
  function assertTargets(id: string, targets: AgentTaskTarget[]): void {
    own(id); const saved = records.claims(); for (const target of targets) { if (targetRevision(id, target.kind, target.id) !== target.revision) fail('AGENT_TASK_TARGET_CHANGED'); if (saved.some(item => item.kind === target.kind && item.targetId === target.id)) fail('AGENT_TASK_TARGET_CLAIMED'); }
  }
  function conflictingTargets(id: string, targets: AgentTaskTarget[]): AgentTaskTarget[] { own(id); const saved = records.claims(); return targets.filter(target => targetRevision(id, target.kind, target.id) !== target.revision || saved.some(item => item.kind === target.kind && item.targetId === target.id)); }
  function claim(input: {projectId: string; ownerId: string; targets: AgentTaskTarget[]}): AgentTaskClaim[] { return transact(() => {
    own(input.projectId); for (const target of input.targets) {
      if (targetRevision(projectId, target.kind, target.id) !== target.revision) fail('AGENT_TASK_TARGET_CHANGED');
      const old = records.claims(input.ownerId).find(item => item.kind === target.kind && item.targetId === target.id);
      if (old && old.revision !== target.revision) fail('AGENT_TASK_TARGET_CHANGED'); if (old?.state === 'uncertain') fail('AGENT_TASK_EDIT_OWNER_UNCERTAIN');
      const at = date(); records.saveClaim({id: old?.id ?? randomUUID(), ownerId: input.ownerId, kind: target.kind, targetId: target.id, revision: target.revision, state: 'active', createdAt: old?.createdAt ?? at, updatedAt: at});
    } return claims(projectId, input.ownerId);
  }); }
  function releaseClaims(id: string, ownerId: string, targets?: AgentTaskTarget[]): void { transact(() => {
    own(id); for (const item of records.claims(ownerId)) if (!targets || targets.some(target => target.kind === item.kind && target.id === item.targetId)) records.removeClaim(item.id, ownerId);
  }); }
  function markClaimsUncertain(id?: string, ownerId?: string): void { transact(() => {
    if (id !== undefined) own(id); for (const {projectId: _, ...item} of records.claims(ownerId)) if (item.state !== 'uncertain') records.saveClaim({...item, state: 'uncertain'});
  }); }
  function expireClaims(maxAgeMs = 30000): number { return transact(() => {
    let count = 0; const before = new Date(Date.now() - maxAgeMs).toISOString(); for (const {projectId: _, ...item} of records.claims()) if (item.state === 'active' && item.updatedAt < before) { records.saveClaim({...item, state: 'uncertain'}); count++; } return count;
  }); }
  function edit(input: AgentTaskEditingInput): {requestId: string; projectId: string; ownerId: string; generation: number; sequence: number; claims: AgentTaskClaim[]} { return transact(() => {
    own(input.projectId); const digest = hash(input), saved = records.editReceipt(input.requestId);
    if (saved) { if (saved.digest !== digest) fail('AGENT_TASK_REQUEST_CONFLICT'); return saved.data as unknown as ReturnType<typeof edit>; }
    const owner = records.editOwner(input.ownerId);
    if (owner && (owner.generation > input.generation || owner.generation === input.generation && owner.sequence >= input.sequence)) fail('AGENT_TASK_EDIT_OWNER_STALE');
    if (owner && input.generation > owner.generation && !['resolve', 'restore'].includes(input.action)) fail('AGENT_TASK_EDIT_OWNER_UNCERTAIN');
    if (input.action === 'claim' && records.claims(input.ownerId).some(item => item.state === 'uncertain')) fail('AGENT_TASK_EDIT_OWNER_UNCERTAIN');
    if (input.action === 'restore') {
      const retained = records.claims(input.ownerId), requested = new Map(input.targets.map(target => [`${target.kind}:${target.id}`, target]));
      if (!owner || !retained.length || requested.size !== input.targets.length || requested.size !== retained.length) fail('AGENT_TASK_EDIT_OWNER_UNCERTAIN');
      for (const {projectId: _, ...item} of retained) { const target = requested.get(`${item.kind}:${item.targetId}`); if (!target || target.revision !== item.revision || targetRevision(projectId, item.kind, item.targetId) !== item.revision) fail('AGENT_TASK_TARGET_CHANGED'); records.saveClaim({...item, state: 'active', updatedAt: date()}); }
    } else if (input.action === 'claim') claim(input);
    else if (input.action === 'release' || input.action === 'resolve') releaseClaims(projectId, input.ownerId, input.targets);
    else for (const {projectId: _, ...item} of records.claims(input.ownerId)) records.saveClaim({...item, updatedAt: date()});
    records.saveEditOwner(input.ownerId, input.generation, input.sequence);
    const result = {requestId: input.requestId, projectId, ownerId: input.ownerId, generation: input.generation, sequence: input.sequence, claims: claims(projectId, input.ownerId)};
    records.saveEditReceipt({requestId: input.requestId, ownerId: input.ownerId, digest, data: json(result)}); return result;
  }); }
  function change(id: string): AgentTaskChange {
    const row = db.prepare('SELECT runId FROM mio_changes WHERE id=? AND projectId=?').get(id, projectId); if (!row) fail('AGENT_TASK_NOT_FOUND'); const value = records.changes(String(row.runId)).find(item => item.id === id); return value ?? fail('AGENT_TASK_NOT_FOUND');
  }
  function saveChange(value: AgentTaskChange): AgentTaskChange { inside(); db.prepare('UPDATE mio_changes SET data=? WHERE id=? AND projectId=?').run(encode(value), value.id, projectId); touch(value.runId); notify(value.runId); return value; }
  function markChangeRevertedInside(id: string): AgentTaskChange { inside(); const value = change(id); if (!value.reversible) fail('AGENT_TASK_NOT_REVERSIBLE'); return saveChange({...value, status: 'reverted', revertedAt: date(), revertedTargets: value.targets.map(target => ({...target, revision: targetRevision(projectId, target.kind, target.id)}))}); }
  function markChangeSupersededInside(id: string): AgentTaskChange { inside(); const value = change(id); if (!value.reversible || value.status !== 'applied') fail('AGENT_TASK_NOT_REVERSIBLE'); return saveChange({...value, status: 'superseded'}); }
  function markChangeRetainedInside(id: string, reason: string): AgentTaskChange { inside(); const value = change(id); if (!value.reversible || value.status !== 'applied' || value.operation !== 'shot.create') fail('AGENT_TASK_NOT_REVERSIBLE'); return saveChange({...value, reversible: false, summary: `${value.summary ?? value.operation}（${reason}）`}); }
  return {
    expireClaims, markClaimsUncertain, edit, conversationPolicy: project(conversationPolicy), setConversationPolicy, effectiveModes, sentConversationModesMatch, conversationPolicies: () => true,
    lookupRequest: (id, requestId) => project(() => { own(id); const row = db.prepare('SELECT id FROM mio_runs WHERE projectId=? AND requestId=?').get(id, requestId); return row ? snapshot(String(row.id)) : null; })(),
    lookupEdit: requestId => records.editReceipt(requestId)?.data ?? null,
    create, conversation: project(conversation), conversationSummary: project(conversationSummary), contextRuns: project(contextRuns), modelContextRuns: project(modelContextRuns), requestConversationId: project(requestConversationId), snapshot: project(snapshot), hasPendingBackground, history: project(history),
    latestDiagnostic: profile => project(() => { const value = allRuns().filter(item => item.diagnostic?.profile === profile).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).at(0); return value ? snapshot(value.id) : null; })(),
    list: (id, {excludeDiagnostics = false} = {}) => project(() => { own(id); return allRuns().filter(item => !excludeDiagnostics || !item.diagnostic).reverse().slice(0, 100); })(),
    events, eventSequence: (runId, after = 0) => records.events(runId, after).at(-1)?.sequence ?? after,
    run: project(run), step: project(step), transition, beginStep, beginModelStep, prepareModelStep, appendNoteInside, skipTargetsInside, updateStep, dispatchPrevented, markDispatch, completeStepInside, appendChangesInside,
    completeStep: (runId, stepId, input) => transact(() => completeStepInside(runId, stepId, input)), appendText, appendEvent,
    control, performControl, rejectControl, beginControl, finishControl, lookupControl, resume, recover, policy,
    updatePolicy: (input, requestId) => { invalidateProjection(); try { return options.updatePolicy ? options.updatePolicy(input, requestId) : fail('AGENT_TASK_STORAGE_UNAVAILABLE'); } finally { invalidateProjection(); } }, lookupPolicy: requestId => options.lookupPolicy ? options.lookupPolicy(requestId) : fail('AGENT_TASK_STORAGE_UNAVAILABLE'),
    targetRevision, revisionSnapshot: id => { own(id); return readMioTargetRevisions(db, id); }, assertTargets, conflictingTargets, claims, claim, releaseClaims,
    markChangeRevertedInside, markChangeRetainedInside, markChangeSupersededInside,
  };
}
