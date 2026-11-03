







import {projectRpcPath} from '../packages/contracts/src/project-file.ts';

import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';

import {readMioStorage} from '../packages/business/src/agent/mio-storage.ts';
import {MIO_QUOTA_BYTES_SQL,MIO_QUOTA_ROWS_SQL} from '../packages/business/src/project-file/schema/domains/mio.ts';
import {MIO_STORAGE_TABLES,mioStorageSnapshotSchema} from '../packages/contracts/src/mio-storage.ts';
import type {MioStorageSnapshot} from '../packages/contracts/src/mio-storage.ts';


import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {TaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import {startServer} from '../apps/server/src/index.ts';
import type {InspectProject} from '../apps/server/src/index.ts';
import {createAgentClient} from '../packages/client/src/agent.ts';
import {createTestAuthorizations, authorizeTestScope} from './helpers/agent-authorizations.ts';
import {createServerProject} from './helpers/project-database.ts';

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function retained(db: DatabaseSync) {
  return MIO_STORAGE_TABLES.map(name => ({name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()}));
}
function temporary(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-agent-storage-diagnostics-v2-'));
  const created=createServerProject(root,{name:'Synthetic diagnostics'}), store=created.store, projectId=created.projectId; let cleanup = async () => {};
  t.after(async () => {await cleanup(); if (store.db.isOpen) store.close(); rmSync(root, {recursive: true, force: true});});
  return {root, store, projectId, journal: createAgentTaskJournal(store), beforeClose(value: () => Promise<void>) {cleanup = value;}};
}

test('native storage diagnostics retain the complete nineteen-table inventory and receipt row exemption', t => {
  const f = temporary(t), before = readMioStorage(f.store.db);
  const run = f.journal.create({projectId: f.projectId, requestId: randomUUID(), text: 'PRIVATE_PROMPT_DO_NOT_ECHO 中文', configuration: {protocol:'chat_completions'}}).run;
  const model = f.journal.beginModelStep(run.id, {request: {body: JSON.stringify({model:'synthetic',messages:[{role:'user',content:'PRIVATE_PROMPT_DO_NOT_ECHO'}]}), history: []}},[]);
  const base = readMioStorage(f.store.db), requestId = randomUUID(), ownerId = 'synthetic-owner';
  const receipt = JSON.stringify({requestId, projectId: f.projectId, ownerId, generation: 1, sequence: 1, claims: []});
  f.store.db.prepare('INSERT INTO mio_edit_receipts(requestId,projectId,ownerId,digest,data) VALUES(?,?,?,?,?)').run(requestId, f.projectId, ownerId, 'a'.repeat(64), receipt);
  const afterReceipt = readMioStorage(f.store.db);
  assert.equal(afterReceipt.usage.rows, base.usage.rows);
  assert.equal(afterReceipt.usage.bytes - base.usage.bytes, Buffer.byteLength(requestId+f.projectId+ownerId+'a'.repeat(64)+receipt));
  f.store.db.prepare('INSERT INTO mio_job_origins(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run('job', randomUUID(), run.id, model.id, f.projectId, model.id, 'generation.submit');
  f.store.db.prepare('INSERT INTO mio_imports(id,projectId,requestId,name,mimeType,relativePath,sha256,status,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), f.projectId, randomUUID(), 'PRIVATE_FILE_NAME', 'image/png', 'agent-imports/PRIVATE_PATH.bin', 'b'.repeat(64), 'selected', new Date().toISOString());
  const actual = readMioStorage(f.store.db);
  assert.equal(actual.usage.rows - afterReceipt.usage.rows, 2); assert.ok(actual.usage.bytes > afterReceipt.usage.bytes);
  assert.equal(actual.tables.length,20); assert.deepEqual(actual.tables.map(table => table.name), MIO_STORAGE_TABLES);
  for (const table of actual.tables) {
    assert.equal(table.countedBytes, true); assert.equal(table.countedRows, table.name!=='mio_edit_receipts');
    assert.equal(table.rows, Number(f.store.db.prepare(`SELECT count(*) AS n FROM ${table.name}`).get()!.n));
    assert.equal(table.bytes, f.store.db.prepare(`SELECT * FROM ${table.name}`).all().reduce((sum,row)=>sum+Object.values(row).reduce<number>((bytes,value)=>bytes+(typeof value==='string'?Buffer.byteLength(value):0),0),0));
  }
  const expectedBytes = Number(f.store.db.prepare(`SELECT ${MIO_QUOTA_BYTES_SQL} AS n`).get()!.n);
  const expectedRows = Number(f.store.db.prepare(`SELECT ${MIO_QUOTA_ROWS_SQL} AS n`).get()!.n);
  assert.deepEqual(actual.usage, {bytes: expectedBytes, rows: expectedRows});
  assert.deepEqual(actual.remaining, {bytes: 256 * 1024 * 1024 - expectedBytes, rows: 65536 - expectedRows});
  assert.equal(actual.retained.rows,actual.usage.rows+1);
  assert.ok(actual.usage.rows > before.usage.rows);
  const saved = retained(f.store.db),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n; assert.deepEqual(readMioStorage(f.store.db), actual); assert.deepEqual(retained(f.store.db), saved);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE_PROMPT|PRIVATE_FILE_NAME|PRIVATE_PATH/u);
});



test('real server and management client doctor return only safe aggregate storage without executing models or changing history', async t => {
  const f = temporary(t), marker = 'PRIVATE_PROMPT_4c689e0', privatePath = '/private/synthetic-source-never-opened.wav';
  const run = f.journal.create({projectId: f.projectId, requestId: randomUUID(), text: marker, configuration: {protocol:'chat_completions'}}).run;
  const model = f.journal.beginModelStep(run.id, {request: {body: JSON.stringify({model:'synthetic',messages:[{role:'user',content:marker}],path:privatePath}), history: []}},[]);
  f.journal.markDispatch(run.id,model.id);f.journal.completeStep(run.id, model.id, {result: {text: marker,toolCalls:[],providerOutput:{role:'assistant',content:marker}}}); f.journal.transition(run.id, f.journal.run(run.id).revision, 'completed');
  f.store.close(); let modelRequests = 0, inspect!: InspectProject;
  const server = await startServer({dataDir: f.root, port: 0, taskGatewayV2: async function*() {modelRequests++; throw Error('Doctor must never execute a model');},
    inspectProject: received => {inspect = received;}});
  f.beforeClose(async () => {await server.close();});
  // Open the requested project explicitly; a global doctor must not acquire it.
  const opened=await fetch(server.url+projectRpcPath(f.projectId),{method:'POST',headers:{authorization:`Bearer ${server.token}`,'content-type':'application/json'},body:JSON.stringify({operation:'project.get',input:{projectId:f.projectId}})});assert.equal(opened.status,200);
  const before = inspect(f.projectId, db => retained(db)), routes: string[] = [];
  const client = createAgentClient({env: {MIOON_BASE_URL: server.url, MIOON_TOKEN: server.token}, fetchImpl: async (url, options) => {
    assert.equal(options?.method, 'GET'); routes.push(new URL(String(url)).pathname); return fetch(url, options);
  }});
  const doctor = await client.doctor({projectId: f.projectId}), replay=await client.doctor({projectId:f.projectId}),second = await client.doctor();
  assert.ok(doctor.storage); assert.deepEqual(doctor.storage, inspect(f.projectId, db => readMioStorage(db))); assert.deepEqual(replay.storage, doctor.storage);assert.equal(second.storage,undefined);
  assert.equal(doctor.storage.limits.bytes, 256 * 1024 * 1024); assert.equal(doctor.storage.limits.rows,65536);assert.equal(doctor.storage.version,3);assert.equal(doctor.storage.tables.length,20);assert.equal(doctor.storage.format, 'mio_records');
  assert.equal(doctor.verification, 'not_tested'); assert.equal(doctor.projectId, f.projectId); assert.equal(second.projectId, undefined);
  assert.equal(doctor.settings.secret.configured, false); assert.equal(modelRequests, 0);
  assert.deepEqual(routes, ['/api/agent/diagnostics', '/api/agent/diagnostics', '/api/agent/diagnostics']); assert.deepEqual(inspect(f.projectId, db => retained(db)), before);
  const serialized = JSON.stringify(doctor);
  for (const denied of [marker, privatePath, f.root, server.token]) assert.equal(serialized.includes(denied), false);
});

test('storage and client schemas reject inconsistent counters, inventories, permissions and unknown tables', async t => {
  const f = temporary(t), valid = readMioStorage(f.store.db), settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  t.after(() => settings.close());
  const report = {version: 1, projectId:f.projectId,settings: await settings.get(), policy: structuredClone(DEFAULT_AGENT_TASK_POLICY), authorization: {revision: 0, scopes: []},
    catalog: {count: 1, valid: true, issues: []}, verification: 'not_tested'};
  const bad: unknown[] = [
    {...valid, usage: {...valid.usage, bytes: valid.usage.bytes + 1}},
    {...valid, remaining: {...valid.remaining, rows: valid.remaining.rows - 1}},
    {...valid, tables: [...valid.tables, valid.tables[0]]}, {...valid, tables: valid.tables.slice(1)},
    {...valid, tables: valid.tables.map((table, index) => index ? table : {...table, name: 'sqlite_schema'})},
    {...valid, tables: valid.tables.map(table => table.name === 'mio_edit_receipts' ? {...table, countedRows: true} : table)},
    {...valid, tables: valid.tables.map(table => table.name === 'mio_job_origins' ? {...table, countedBytes: false} : table)},
    {...valid, limits: {...valid.limits, bytes: 64 * 1024 * 1024}}, {...valid, status: 'full'},
    {...valid, rawPrompt: 'PRIVATE_STORAGE_PAYLOAD'}, {...valid, usage: {...valid.usage, rows: 0.5}},
  ];
  for (const storage of bad) {
    assert.equal(mioStorageSnapshotSchema.safeParse(storage).success, false);
    const client = createAgentClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: 'synthetic-storage-test-token-only'},
      fetchImpl: async () => new Response(JSON.stringify({ok: true, data: {...report, storage}}), {headers: {'content-type': 'application/json'}})});
    await assert.rejects(client.doctor({projectId:f.projectId}), error => record(error).code === 'BACKEND_PROTOCOL_ERROR' && !String(record(error).message).includes('PRIVATE_STORAGE_PAYLOAD'));
  }
  function atRows(rows: number, status: MioStorageSnapshot['status']) {
    return {...valid, status, tables: valid.tables.map(table => table.name === 'mio_events' ? {...table, rows:rows-1} : table),
      usage: {...valid.usage, rows},retained:{...valid.retained,rows}, remaining: {...valid.remaining, rows: Math.max(0, 65536 - rows)}};
  }
  assert.equal(mioStorageSnapshotSchema.safeParse(atRows(58982, 'available')).success, true);
  assert.equal(mioStorageSnapshotSchema.safeParse(atRows(58983, 'near_limit')).success, true);
  assert.equal(mioStorageSnapshotSchema.safeParse(atRows(65536, 'full')).success, true);
  assert.equal(mioStorageSnapshotSchema.safeParse(atRows(65537, 'full')).success, true);
});

async function runtimeFixture(t: TestContext, injected?: {code: string; message: string}) {
  const f = temporary(t), services = createServices(f.store, new Map()), settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const initial = await settings.get();
  await settings.put({expectedRevision: initial.revision, configuration: initial.configuration, secret: {action: 'replace', storage: 'session', value: 'SYNTHETIC_STORAGE_FIXTURE_ONLY'}});
  const authorizations = createTestAuthorizations(() => ({...f.store}), settings); await authorizeTestScope(authorizations, 'project_agent');
  const tools = createAgentTaskTools({store: f.store, services}), source = createAgentTaskJournal(f.store);
  const journal = injected ? {...source, performControl(input: Parameters<typeof source.performControl>[0], apply: Parameters<typeof source.performControl>[1]) {
    return source.performControl(input, () => {apply(); throw Object.assign(new Error(injected.message), {code: injected.code});});
  }} : source;
  let requests = 0;
  const gateway: TaskGateway = async function*() {requests++; yield {type: 'done', output: {text: 'Synthetic model reply', toolCalls: [], providerOutput: {role:'assistant',content:'Synthetic model reply'}}};};
  const runtime = createAgentTaskRuntime({store: f.store, agentSettings: settings, authorizations, tools, journal, gateway, selfPort: () => 4318});
  f.beforeClose(async () => {runtime.close(); await runtime.drain(); tools.dispose(); await services.drain(); await settings.close();});
  return {...f, services, settings, source, runtime, get requests() {return requests;}};
}

test('quota and ordinary SQLite write failures roll back note and receipt together, retain their precise fail-closed code and never dispatch', async t => {
  const cases = [
    {label: 'native quota trigger', message: 'AGENT_TASK_STORAGE_LIMIT', expected: 'AGENT_TASK_STORAGE_LIMIT'},
    {label: 'ordinary native SQLite failure', message: 'synthetic unrelated SQLite failure', expected: 'AGENT_TASK_STORAGE_UNAVAILABLE'},
    {label: 'quota-like message prefix', message: 'AGENT_TASK_STORAGE_LIMIT unrelated', expected: 'AGENT_TASK_STORAGE_UNAVAILABLE'},
    {label: 'IO error with quota-like text', message: 'AGENT_TASK_STORAGE_LIMIT', expected: 'AGENT_TASK_STORAGE_UNAVAILABLE', code: 'SQLITE_IOERR'},
    {label: 'busy error with quota-like text', message: 'AGENT_TASK_STORAGE_LIMIT', expected: 'AGENT_TASK_STORAGE_UNAVAILABLE', code: 'ERR_SQLITE_BUSY'},
  ];
  for (const item of cases) await t.test(item.label, async t => {
    const f = await runtimeFixture(t, item.code ? {code: item.code, message: item.message} : undefined), current = await f.settings.get();
    const run = f.source.create({projectId: f.projectId, requestId: randomUUID(), text: 'Saved original request', configuration: {...current.configuration}, settingsRevision: current.revision}).run;
    const requestId = randomUUID();
    if (!item.code) f.store.db.exec(`CREATE TEMP TRIGGER synthetic_diagnostic_control_failure BEFORE INSERT ON mio_controls WHEN NEW.requestId='${requestId}' BEGIN SELECT RAISE(ABORT,'${item.message}');END;`);
    const before = retained(f.store.db), action = {requestId, expectedRevision: run.revision, action: 'note', text: 'MUST_ROLL_BACK_PRIVATE_NOTE'};
    await assert.rejects(f.runtime.action(f.projectId, run.id, action), {code: item.expected});
    assert.deepEqual(retained(f.store.db), before); assert.equal(f.source.lookupControl(requestId), null); assert.equal(f.requests, 0);
    await assert.rejects(f.runtime.send(f.projectId, {requestId: randomUUID(), expectedSettingsRevision: current.revision, text: 'No retry after storage fault'}), {code: item.expected});
    assert.equal(f.requests, 0); assert.deepEqual(retained(f.store.db), before);
  });
});

test('a quota failure after the single model dispatch cannot publish its result or trigger a replacement request', async t => {
  const f = await runtimeFixture(t), current = await f.settings.get();
  f.store.db.exec("CREATE TEMP TRIGGER synthetic_model_completion_quota BEFORE INSERT ON mio_entries WHEN NEW.kind='model_output' BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;");
  const sent = await f.runtime.send(f.projectId, {requestId: randomUUID(), expectedSettingsRevision: current.revision, text: 'One synthetic model request'});
  await f.runtime.drain();
  const snapshot = f.source.snapshot(sent.run.id);
  assert.equal(f.requests, 1); assert.equal(snapshot.steps.length, 1);
  assert.ok(['dispatch_started', 'unknown'].includes(snapshot.steps[0]!.status)); assert.equal(snapshot.steps[0]!.result, undefined);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM mio_entries WHERE runId=? AND kind='model_output'").get(sent.run.id)!.n, 0);
  assert.equal(f.store.db.prepare('SELECT originalBody IS NOT NULL AS retained FROM mio_requests WHERE stepId=?').get(snapshot.steps[0]!.id)!.retained,1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n, 0);
  let expandedReads = 0;
  f.source.events = () => {expandedReads++; throw Error('SSE must not hydrate private request history');};
  const observed = f.runtime.events(f.projectId, sent.run.id, 0);
  assert.equal(expandedReads, 0); assert.equal(observed.sequence, f.source.eventSequence(sent.run.id, 0));
  assert.ok(observed.snapshot.steps.every(step => step.request === undefined && step.data === undefined));
  await assert.rejects(f.runtime.send(f.projectId, {requestId: sent.run.requestId, expectedSettingsRevision: current.revision, text: 'One synthetic model request'}), {code: 'AGENT_TASK_STORAGE_LIMIT'});
  await f.runtime.drain(); assert.equal(f.requests, 1); assert.equal(f.source.snapshot(sent.run.id).steps.length, 1);
});
