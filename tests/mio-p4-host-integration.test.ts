import {testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {agentServiceInput} from '../packages/contracts/src/agent-connection-settings.ts';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {startServer, type InspectApplication, type InspectProject} from '../apps/server/src/index.ts';
import {createAgentClient} from '../packages/client/src/agent.ts';
import {agentTaskPolicySchema, agentTaskSnapshotSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import {agentDiagnosticSummarySchema} from '../packages/contracts/src/agent-diagnostic-summary.ts';
import {mioRunUsageSchema} from '../packages/contracts/src/mio-run-usage.ts';
import {MIO_STORAGE_TABLES, mioStorageSnapshotSchema} from '../packages/contracts/src/mio-storage.ts';
import {agentChatHttpError, agentChatProtocolError} from '../packages/business/src/agent/chat-errors.ts';
import type {TaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import {readMioStorage} from '../packages/business/src/agent/mio-storage.ts';
import {authorizeHttpSnapshot} from './helpers/agent-authorizations.ts';
import {openProjectDatabase, projectDirFor} from './helpers/project-database.ts';

const token = 'synthetic-mio-p4-host-integration-token';
const reply = 'PRIVATE_P4_CANONICAL_MODEL_OUTPUT';
const reportedUsage = {inputTokens: 80, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 0};
const diagnosticDocument = 'agent-diagnostic-summary-v1.json';
const globalTables = ['agent_task_policy_v2', 'agent_task_policy_requests_v2'];
function object(value: unknown): Record<string, unknown> {assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;}

async function fixture(t: TestContext, modelFailure?: (call: number) => Error) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-mio-p4-host-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let client!: ReturnType<typeof createAgentClient>;
  let inspectProject!: InspectProject, inspectApplication!: InspectApplication, calls = 0;
  const outside: DatabaseSync[] = [];
  const gateway: TaskGateway = async function* (request) {
    request.beforeSubmit?.(); calls++;
    if (modelFailure) throw modelFailure(calls);
    yield {type: 'delta', text: reply};
    yield {type: 'done', output: {text: reply, toolCalls: [], providerOutput: {role: 'assistant', content: reply}, usage: reportedUsage}};
  };
  t.after(async () => {
    for (const db of outside) if (db.isOpen) db.close();
    await server?.close(); rmSync(root, {recursive: true, force: true});
  });
  async function start() {
    server = await startServer({dataDir: root, port: 0, token, comfyModule: 'skip', taskGatewayV2: gateway,
      inspectProject: read => {inspectProject = read;}, inspectApplication: read => {inspectApplication = read;}});
    client = createAgentClient({env: {MIOON_BASE_URL: server.url, MIOON_TOKEN: token}});
  }
  await start();
  const initial = await client.settingsGet();
  await client.settingsPut({expectedRevision:initial.revision,services:initial.services.map(agentServiceInput),mioSelection:{serviceKey:'ollama',modelId:'qwen3:8b'}}, [{serviceKey:'ollama',action:'remove'}]);
  const request = async (route: string, options: {method?: string; input?: unknown} = {}) => {
    const response = await fetch(server!.url + route, {method: options.method ?? 'GET', headers: {authorization: `Bearer ${token}`, ...(options.input === undefined ? {} : {'content-type': 'application/json'})}, ...(options.input === undefined ? {} : {body: JSON.stringify(options.input)})});
    return {status: response.status, body: await response.json() as unknown};
  };
  async function createProject() {
    const created = await request('/api/rpc', {method: 'POST', input: {operation: 'project.create', input: {name: 'Real P4 Mio project'}}});
    assert.equal(created.status, 200); const id = object(object(created.body).data).id; assert.equal(typeof id, 'string');
    const projectId = id as string;
    await authorizeHttpSnapshot(request, await client.list({projectId}), 'project_agent');
    return projectId;
  }
  async function settled(projectId: string, runId: string, expectedStatus: 'completed' | 'failed' = 'completed') {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const snapshot = await client.status({projectId, runId});
      if (['completed', 'failed', 'stopped'].includes(snapshot.run.status)) {
        assert.equal(snapshot.run.status, expectedStatus);
        if (snapshot.executionEndedAt) return snapshot;
      }
      assert.ok(Date.now() < deadline, 'The offline P4 runtime did not complete');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return {root, request, createProject, settled,
    get client() {return client;}, get calls() {return calls;},
    project: <T>(projectId: string, read: (db: DatabaseSync) => T) => inspectProject(projectId, read),
    application: <T>(read: (db: DatabaseSync) => T) => inspectApplication(read),
    async restart() {await server!.close(); server = undefined; await start();},
    holdClosedProject(projectRoot: string) {const db = openProjectDatabase(projectRoot); outside.push(db); return db;},
  };
}

test('production P4 hosts run R1 canonical records and keep global CAS policy/receipts in B1', {timeout: 60_000}, async t => {
  const f = await fixture(t), beforePolicy = await f.client.policyGet(), requestId = randomUUID();
  const input = {requestId, expectedRevision: beforePolicy.policy.revision, stepLimit: 12, modes: beforePolicy.policy.modes};
  const saved = await f.client.policySet(input);
  assert.equal(saved.policy.revision, beforePolicy.policy.revision + 1);
  assert.equal(saved.policy.stepLimit, beforePolicy.policy.stepLimit, 'The retired policy field accepts legacy input and keeps its stored value');
  assert.deepEqual(await f.client.policySet(input), saved);
  assert.deepEqual(await f.client.policyLookup({requestId}), {found: true, policy: saved.policy, readOnly: false});
  const staleId = randomUUID(), stale = await f.request('/api/agent/tasks/v2/policy', {method: 'PUT', input: {...input, requestId: staleId}});
  assert.equal(stale.status, 409); assert.equal(object(object(stale.body).error).code, 'AGENT_TASK_REVISION_CONFLICT');
  assert.deepEqual(await f.client.policyLookup({requestId: staleId}), {found: false, readOnly: false});
  const appPolicy = f.application(db => ({policy: db.prepare('SELECT data FROM agent_task_policy_v2 WHERE id=1').get(), receipts: db.prepare('SELECT requestId,data FROM agent_task_policy_requests_v2').all()}));
  assert.deepEqual(agentTaskPolicySchema.parse(JSON.parse(String(appPolicy.policy!.data))), saved.policy);
  assert.equal(appPolicy.receipts.length, 1); assert.equal(appPolicy.receipts[0]!.requestId, requestId);
  assert.deepEqual(agentTaskPolicySchema.parse(JSON.parse(String(appPolicy.receipts[0]!.data))), saved.policy);

  const projectId = await f.createProject(), settings = await f.client.settingsGet();
  const accepted = await f.client.send({projectId, requestId: randomUUID(), text: 'PRIVATE_P4_USER_PROMPT', expectedSettingsRevision: testAgentExecution(settings).revision, locale: 'en'});
  const done = agentTaskSnapshotSchema.parse(await f.settled(projectId, accepted.run.id));
  assert.equal(done.run.stepsUsed, 1); assert.equal(f.calls, 1);
  const records = f.project(projectId, db => {
    const databases = db.prepare('PRAGMA database_list').all();
    for (const database of databases) {
      assert.match(String(database.name), /^(main|project|cache|temp)$/u);
      const tables = db.prepare(`SELECT name FROM ${String(database.name)}.sqlite_schema WHERE type='table'`).all().map(row => String(row.name));
      assert.ok(globalTables.every(table => !tables.includes(table)), 'Global policy tables must never be attached or built in the project');
    }
    return {tables: db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name GLOB 'mio_*'").all().map(row => String(row.name)),
      legacyRuns: db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE name='agent_task_runs_v2'").get()!.n,
      requests: db.prepare('SELECT q.state,q.originalBody,q.bodyBytes,s.partialText FROM mio_requests q JOIN mio_steps s ON s.id=q.stepId WHERE s.runId=?').all(done.run.id),
      outputs: db.prepare("SELECT coalesce(e.payloadJson,b.content) AS payload FROM mio_entries e LEFT JOIN mio_blobs b ON b.sha256=e.payloadBlobHash WHERE e.runId=? AND e.kind='model_output'").all(done.run.id)};
  });
  assert.deepEqual([...records.tables].sort(), [...MIO_STORAGE_TABLES].sort()); assert.equal(records.legacyRuns, 0);
  assert.equal(records.requests.length, 1); assert.equal(records.requests[0]!.state, 'completed');
  assert.equal(records.requests[0]!.originalBody, null); assert.equal(records.requests[0]!.partialText, null); assert.ok(Number(records.requests[0]!.bodyBytes) > 0);
  assert.equal(records.outputs.length, 1); assert.equal(object(object(JSON.parse(String(records.outputs[0]!.payload))).providerOutput).content, reply);
  const changes = f.project(projectId, db => db.prepare('SELECT total_changes() AS n').get()!.n), calls = f.calls;
  const usage = mioRunUsageSchema.parse(await f.client.usage({projectId, runId: done.run.id}));
  assert.deepEqual(usage.knownTotals, reportedUsage); assert.equal(usage.modelOutcomes.completed, 1); assert.equal(usage.dispatchedModelSteps, 1);
  assert.doesNotMatch(JSON.stringify(usage), /PRIVATE_|providerOutput|originalBody|configurationBlobHash/u);
  const doctor = await f.client.doctor({projectId}), storage = mioStorageSnapshotSchema.parse(doctor.storage);
  assert.equal(storage.version, 3); assert.equal(storage.scope, 'project'); assert.equal(storage.projectId, projectId); assert.equal(storage.tables.length, 20);
  assert.deepEqual(storage, f.project(projectId, db => readMioStorage(db)));
  assert.equal(f.project(projectId, db => db.prepare('SELECT total_changes() AS n').get()!.n), changes); assert.equal(f.calls, calls);
  assert.equal((await f.client.doctor()).storage, undefined);
});

test('a real text diagnostic persists only the safe B1 summary and selected-entry witness, readable with its project closed and externally locked', {timeout: 60_000}, async t => {
  const f = await fixture(t), projectId = await f.createProject(), settings = await f.client.settingsGet();
  assert.deepEqual(await f.client.diagnoseLatest(), {test: null});
  assert.equal(f.application(db => db.prepare('SELECT data FROM app_documents WHERE name=?').get(diagnosticDocument)), undefined);
  const sent = await f.client.send({projectId, requestId: randomUUID(), text: 'PRIVATE_P4_DIAGNOSTIC_PROMPT', expectedSettingsRevision: testAgentExecution(settings).revision, locale: 'en', diagnostic: {profile: 'text'}});
  await f.settled(projectId, sent.run.id);
  const deadline = Date.now() + 30_000;
  let latest = await f.client.diagnoseLatest();
  while (latest.test === null) {assert.ok(Date.now() < deadline, 'The terminal diagnostic did not publish its application summary'); await new Promise(resolve => setTimeout(resolve, 5)); latest = await f.client.diagnoseLatest();}
  const summary = agentDiagnosticSummarySchema.parse(latest.test);
  assert.deepEqual(Object.keys(summary).sort(), ['completedAt', 'errorCode', 'model', 'protocol', 'settingsBinding', 'settingsRevision', 'status']);
  assert.deepEqual(summary.settingsBinding,testAgentExecution(settings).binding);assert.equal(summary.settingsRevision,testAgentExecution(settings).revision);
  assert.equal(summary.status, 'completed'); assert.equal(summary.protocol, testAgentExecution(settings).configuration.protocol); assert.equal(summary.model, testAgentExecution(settings).configuration.model); assert.equal(summary.errorCode, null);
  const raw = f.application(db => String(db.prepare('SELECT data FROM app_documents WHERE name=?').get(diagnosticDocument)!.data));
  assert.deepEqual(agentDiagnosticSummarySchema.parse(JSON.parse(raw)), summary);
  for (const privateValue of ['PRIVATE_P4_DIAGNOSTIC_PROMPT', reply, sent.run.id, projectId, testAgentExecution(settings).configuration.baseUrl]) assert.equal(raw.includes(privateValue), false);
  const projectRoot = projectDirFor(f.root, projectId), owner = f.project(projectId, db => db);
  await f.restart(); assert.equal(owner.isOpen, false, 'Restart closes the original project and application owners');
  // The external real-kernel owner makes any hidden acquire fail. Only the
  // already-open B1 may serve the global diagnostic/policy reads below.
  const outside = f.holdClosedProject(projectRoot), beforeProjectChanges = outside.prepare('SELECT total_changes() AS n').get()!.n;
  const beforeAppChanges = f.application(db => db.prepare('SELECT total_changes() AS n').get()!.n), calls = f.calls;
  assert.deepEqual(await f.client.diagnoseLatest(), {test: summary});
  await f.client.policyGet();
  assert.equal(f.application(db => String(db.prepare('SELECT data FROM app_documents WHERE name=?').get(diagnosticDocument)!.data)), raw);
  assert.equal(f.application(db => db.prepare('SELECT total_changes() AS n').get()!.n), beforeAppChanges);
  assert.equal(outside.prepare('SELECT total_changes() AS n').get()!.n, beforeProjectChanges); assert.equal(outside.isOpen, true); assert.equal(f.calls, calls);
});

test('model failure details reach HTTP and reopen with older steps and the application summary', {timeout: 60_000}, async t => {
  const privateMessage = 'Private user text with synthetic credential sk-synthetic-011b';
  const diagnostic = {kind: 'http', status: 404, providerType: 'invalid_request_error', providerCode: 'model_not_found'};
  const mismatch = {event: 'response.completed', item: 'reasoning', field: 'summary'};
  const unknownEvent = {event: 'response.future_output.revision_done'};
  const f = await fixture(t, call => {
    if (call === 1) return Object.assign(new Error(privateMessage), {code: 'AGENT_CHAT_HTTP_ERROR', diagnostic});
    if (call === 2) return agentChatProtocolError('AGENT_CHAT_PROTOCOL_ERROR', 'terminal_mismatch', mismatch);
    if (call === 3) return agentChatProtocolError('AGENT_CHAT_PROTOCOL_ERROR', 'unknown_event', {eventProtocol: 'responses', ...unknownEvent});
    return agentChatHttpError(404, Buffer.from(JSON.stringify({error: {type: diagnostic.providerType, code: diagnostic.providerCode, message: privateMessage}})));
  });
  const projectId = await f.createProject(), settings = await f.client.settingsGet();
  const send = {projectId, text: 'Check the current model', expectedSettingsRevision: testAgentExecution(settings).revision};
  const older = await f.client.send({...send, requestId: randomUUID()});
  const olderFailure = (await f.settled(projectId, older.run.id, 'failed')).steps[0]!.error!;
  assert.equal(olderFailure.code, 'AGENT_CHAT_HTTP_ERROR');
  assert.deepEqual(Object.keys(olderFailure).sort(), ['code', 'message']);
  assert.equal(olderFailure.message.includes(privateMessage), false);

  const protocolRun = await f.client.send({...send, requestId: randomUUID()});
  const protocolFailure = (await f.settled(projectId, protocolRun.run.id, 'failed')).steps[0]!.error!;
  assert.equal(protocolFailure.code, 'AGENT_CHAT_PROTOCOL_ERROR');
  assert.deepEqual(protocolFailure.diagnostic, {kind: 'protocol', reason: 'terminal_mismatch', ...mismatch});

  const unknownRun = await f.client.send({...send, requestId: randomUUID()});
  const unknownFailure = (await f.settled(projectId, unknownRun.run.id, 'failed')).steps[0]!.error!;
  assert.equal(unknownFailure.code, 'AGENT_CHAT_PROTOCOL_ERROR');
  assert.deepEqual(unknownFailure.diagnostic, {kind: 'protocol', reason: 'unknown_event', ...unknownEvent});

  const sent = await f.client.send({...send, requestId: randomUUID(), diagnostic: {profile: 'text'}});
  const failed = await f.settled(projectId, sent.run.id, 'failed');
  assert.equal(failed.steps[0]!.kind, 'model');
  assert.equal(failed.steps[0]!.status, 'failed');
  assert.equal(failed.steps[0]!.error?.code, 'AGENT_CHAT_HTTP_ERROR');
  assert.deepEqual(failed.steps[0]!.error?.diagnostic, diagnostic);

  const errorInStorage = (runId: string) => f.project(projectId, db => String(db.prepare("SELECT json_extract(data, '$.controls.error') AS error FROM mio_steps WHERE runId=?").get(runId)!.error));
  assert.deepEqual(JSON.parse(errorInStorage(older.run.id)), olderFailure);
  assert.deepEqual(JSON.parse(errorInStorage(protocolRun.run.id)), protocolFailure);
  assert.deepEqual(JSON.parse(errorInStorage(unknownRun.run.id)), unknownFailure);
  assert.deepEqual(JSON.parse(errorInStorage(sent.run.id)), failed.steps[0]!.error);
  const latest = await f.client.diagnoseLatest();
  assert.equal(latest.test?.status, 'failed');
  assert.equal(latest.test?.errorCode, 'AGENT_CHAT_HTTP_ERROR');
  assert.deepEqual(latest.test?.diagnostic, diagnostic);
  const raw = f.application(db => String(db.prepare('SELECT data FROM app_documents WHERE name=?').get(diagnosticDocument)!.data));
  assert.deepEqual(agentDiagnosticSummarySchema.parse(JSON.parse(raw)), latest.test);
  for (const evidence of [JSON.stringify(failed), errorInStorage(sent.run.id), raw]) {
    assert.doesNotMatch(evidence, /Private user text|sk-synthetic-011b/u);
  }

  await f.restart();
  assert.deepEqual(await f.client.diagnoseLatest(), latest);
  assert.deepEqual((await f.client.status({projectId, runId: older.run.id})).steps[0]!.error, olderFailure);
  assert.deepEqual((await f.client.status({projectId, runId: protocolRun.run.id})).steps[0]!.error, protocolFailure);
  assert.deepEqual((await f.client.status({projectId, runId: unknownRun.run.id})).steps[0]!.error, unknownFailure);
  assert.deepEqual((await f.client.status({projectId, runId: sent.run.id})).steps[0]!.error, failed.steps[0]!.error);
  assert.equal(f.calls, 4);
});
