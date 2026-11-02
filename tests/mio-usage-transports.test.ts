import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAgentTaskHttp} from '../apps/server/src/agent-task-http-v2.ts';
import {createAgentDiagnosticsHttp} from '../apps/server/src/agent-diagnostics-http.ts';
import {projectRouteTarget} from '../apps/server/src/project-routes.ts';
import {createAgentClient} from '../packages/client/src/agent.ts';
import {ClientError} from '../packages/client/src/index.ts';
import {projectApiPath} from '../packages/contracts/src/project-file.ts';
import {mioRunUsageSchema} from '../packages/contracts/src/mio-run-usage.ts';
import {mioStorageSnapshotSchema} from '../packages/contracts/src/mio-storage.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createMioRuntime} from '../packages/business/src/agent/mio-runtime.ts';
import {readMioStorage} from '../packages/business/src/agent/mio-storage.ts';
import {createMioTestFixture, mioTestPolicy} from './helpers/mio-runtime-fixture.ts';

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const measured = {inputTokens: 120, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 0};
const privateText = 'PRIVATE_CANONICAL_OUTPUT_NOT_IN_USAGE';

async function fixture(t: TestContext, protocol: AgentProtocol, readOnly = false) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-usage-transport-'));
  let models = 0;
  const f = await createMioTestFixture(root, async function* (request) {
    request.beforeSubmit?.(); models++;
    const providerOutput: AgentTaskJson = protocol === 'chat_completions' ? {role: 'assistant', content: privateText}
      : protocol === 'responses' ? [{id: 'msg_final', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: privateText, annotations: []}]}]
        : {role: 'assistant', content: [{type: 'text', text: privateText}]};
    yield {type: 'done', output: {text: privateText, toolCalls: [], providerOutput, usage: measured}};
  }, undefined, protocol);
  const sent = await f.runtime.send(f.store.projectId, {requestId: randomUUID(), text: 'PRIVATE_USER_MESSAGE_NOT_IN_USAGE', expectedSettingsRevision: (await f.settings.get()).revision});
  await f.runtime.drain(); assert.equal(f.runtime.get(f.store.projectId, sent.run.id).run.status, 'completed');
  let runtime = f.runtime;
  if (readOnly) {
    runtime.close();
    runtime = createMioRuntime({store: f.store, agentSettings: f.settings, authorizations: f.authorizations, tools: f.tools, gateway: f.gateway, selfPort: () => 4318, policy: mioTestPolicy, journal: runtime.journal, readOnly: true});
  }
  const route = createAgentTaskHttp({runtime, tools: f.tools});
  const doctor = createAgentDiagnosticsHttp({settings: f.settings, authorizations: f.authorizations, tools: f.tools, policy: () => runtime.policy(), selfPort: () => 4318,
    hasProject: id => id === f.store.projectId, storage: id => id === f.store.projectId ? readMioStorage(f.store.db) : undefined});
  const token = randomUUID();
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {res.writeHead(401); res.end(); return;}
    const url = new URL(req.url ?? '/', 'http://127.0.0.1'), scoped = projectRouteTarget(url.pathname);
    if (scoped) url.pathname = scoped.pathname;
    void (async () => {
      if (await doctor(req, res, url)) return;
      if (await route.handle(req, res, url, scoped ? {projectId: scoped.projectId} : undefined)) return;
      res.writeHead(404); res.end();
    })().catch(() => res.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, headers = {Authorization: `Bearer ${token}`};
  t.after(async () => {
    f.store.db.exec('PRAGMA query_only=OFF'); route.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.close(); await runtime.drain(); await f.close(); rmSync(root, {recursive: true, force: true});
  });
  const client = createAgentClient({env: {MIOON_BASE_URL: base, MIOON_TOKEN: token}});
  return {...f, runtime, client, base, headers, projectId: f.store.projectId, runId: sent.run.id,
    get models() {return models;}, usagePath: projectApiPath(f.store.projectId, 'agent', 'tasks', 'v2', sent.run.id, 'usage')};
}

for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) test(`${protocol}: canonical usage GET and client read exact passive measurements with zero writes`, async t => {
  const f = await fixture(t, protocol), before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n, calls = f.models;
  f.store.db.exec('PRAGMA query_only=ON');
  const routes: string[] = [];
  const client = createAgentClient({env: {MIOON_BASE_URL: f.base, MIOON_TOKEN: f.headers.Authorization.slice(7)}, fetchImpl: async (url, options) => {
    routes.push(new URL(String(url)).pathname); assert.equal(options?.method, 'GET'); return fetch(url, options);
  }});
  const usage = await client.usage({projectId: f.projectId, runId: f.runId});
  assert.deepEqual(usage, mioRunUsageSchema.parse(f.runtime.usage(f.projectId, f.runId)));
  assert.deepEqual(usage.knownTotals, measured); assert.equal(usage.dispatchedModelSteps, 1); assert.equal(usage.cacheReadRate, 0.75);
  assert.deepEqual(routes, [f.usagePath]);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before); assert.equal(f.models, calls);
  assert.doesNotMatch(JSON.stringify(usage), /PRIVATE_|providerOutput|originalBody|configuration|apiKey/u);
  const status = await f.client.status({projectId: f.projectId, runId: f.runId});
  assert.doesNotMatch(JSON.stringify(status), /"(?:usage|knownTotals|inputTokens|outputTokens|cacheReadTokens|cacheWriteTokens|providerOutput|request)"\s*:/u);
  assert.equal((await fetch(f.base + f.usagePath)).status, 401);
  assert.equal((await fetch(f.base + f.usagePath + '?unexpected=1', {headers: f.headers})).status, 400);
  const post = await fetch(f.base + f.usagePath, {method: 'POST', headers: f.headers}); assert.equal(post.status, 405); assert.equal(post.headers.get('Allow'), 'GET');
  const unscoped = projectRouteTarget(f.usagePath); assert.ok(unscoped);
  assert.equal((await fetch(f.base + unscoped.pathname, {headers: f.headers})).status, 404);
  const other = projectApiPath(randomUUID(), 'agent', 'tasks', 'v2', f.runId, 'usage');
  assert.equal((await fetch(f.base + other, {headers: f.headers})).status, 404);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before); assert.equal(f.models, calls);
});

test('read-only runtime permits usage and doctor returns only the requested project inventory', async t => {
  const f = await fixture(t, 'chat_completions', true);
  const before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  f.store.db.exec('PRAGMA query_only=ON');
  assert.deepEqual((await f.client.usage({projectId: f.projectId, runId: f.runId})).knownTotals, measured);
  const doctor = await f.client.doctor({projectId: f.projectId}); assert.ok(doctor.storage?.version === 2);
  assert.deepEqual(mioStorageSnapshotSchema.parse(doctor.storage), readMioStorage(f.store.db));
  assert.equal(doctor.storage.projectId, f.projectId); assert.equal(doctor.storage.tables.length, 19);
  assert.equal((await f.client.doctor()).storage, undefined);
  assert.equal((await fetch(f.base + `/api/agent/diagnostics?projectId=${randomUUID()}`, {headers: f.headers})).status, 404);
  assert.doesNotMatch(JSON.stringify(doctor.storage), /PRIVATE_|providerOutput|originalBody|relativePath/u);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
});

test('doctor reports corrupted counters through HTTP and client without repairing storage', async t => {
  const f = await fixture(t, 'chat_completions');
  const saved = readMioStorage(f.store.db);
  f.store.tx(() => f.store.db.prepare('UPDATE mio_storage_counters SET bytes=bytes+1 WHERE singleton=1').run());
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  f.store.db.exec('PRAGMA query_only=ON');
  const response = await fetch(f.base + `/api/agent/diagnostics?projectId=${f.projectId}`, {headers: f.headers});
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(object(object(body).error).code, 'AGENT_TASK_STORAGE_CORRUPT');
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|originalBody|inputManifest/u);
  await assert.rejects(f.client.doctor({projectId: f.projectId}), error => error instanceof ClientError && error.code === 'AGENT_TASK_STORAGE_CORRUPT');
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  f.store.db.exec('PRAGMA query_only=OFF');
  f.store.tx(() => f.store.db.prepare('UPDATE mio_storage_counters SET bytes=bytes-1 WHERE singleton=1').run());
  assert.deepEqual(readMioStorage(f.store.db), saved);
});

test('usage client rejects wrong identity, unknown private fields and inconsistent coverage; doctor rejects project swaps', async t => {
  const f = await fixture(t, 'chat_completions'), usage = f.runtime.usage(f.projectId, f.runId), doctor = await f.client.doctor({projectId: f.projectId});
  const invalid = [ {...usage, runId: randomUUID()}, {...usage, providerOutput: {secret: 'PRIVATE_RAW'}}, {...usage, cacheReadRate: 1},
    {...usage, coverage: {fields: {...usage.coverage.fields, inputTokens: {...usage.coverage.fields.inputTokens, missingSteps: 3}}}}, ];
  for (const value of invalid) {
    const client = createAgentClient({env: {MIOON_BASE_URL: f.base, MIOON_TOKEN: f.headers.Authorization.slice(7)}, fetchImpl: async () => new Response(JSON.stringify({ok: true, data: value}), {status: 200})});
    await assert.rejects(client.usage({projectId: f.projectId, runId: f.runId}), error => error instanceof ClientError && error.code === 'BACKEND_PROTOCOL_ERROR');
  }
  assert.ok(doctor.storage && 'scope' in doctor.storage);
  const client = createAgentClient({env: {MIOON_BASE_URL: f.base, MIOON_TOKEN: f.headers.Authorization.slice(7)}, fetchImpl: async () => new Response(JSON.stringify({ok: true, data: {...doctor, storage: {...doctor.storage, projectId: randomUUID()}}}), {status: 200})});
  await assert.rejects(client.doctor({projectId: f.projectId}), error => error instanceof ClientError && error.code === 'BACKEND_PROTOCOL_ERROR');
  const body = object(doctor); assert.equal(body.projectId, f.projectId);
});
