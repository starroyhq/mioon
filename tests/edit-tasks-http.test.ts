import type {TaskHttpFixture, TaskHttpResponse, TaskEnvelope} from './helpers/strict-edit-task-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {isEditTaskEnvelope, isEditTaskListEnvelope, DURABLE_EDIT_OPERATIONS} from '@mioon/contracts';
import {EDIT_TASK_HTTP_LIMITS} from '../apps/server/src/edit-tasks-http.ts';
import {taskFixture, taskPath, listPath, database, snapshot, REPO, TASK_TOKEN, type FixtureResponse} from './helpers/edit-tasks-http-fixture.ts';

const trackInput = (f: TaskHttpFixture, changes: { expectedRevision?: number; }|undefined = {}) => ({projectId: f.project.id, expectedRevision: f.timeline.revision,
  requestId: randomUUID(), kind: 'audio', name: 'Durable synthetic track', ...changes});
const attachInput = (f: TaskHttpFixture) => ({projectId: f.project.id, sourceNodeId: f.node.id, targetShotId: f.shot.id,
  expectedSourceRevision: f.node.revision, expectedShotRevision: f.shot.revision, requestId: randomUUID(), role: 'first_frame'});
const actionInput = (f: TaskHttpFixture, prepared: TaskEnvelope) => ({projectId: f.project.id, digest: prepared.task.digest, instanceId: prepared.instanceId});
const retained = (f: TaskHttpFixture) => snapshot(f.root, ['edit_tasks']);
const dispatches = (f: TaskHttpFixture) => f.phases.filter((phase: string) => phase === 'beforeDispatch').length;
const assertSafe = (response: TaskHttpResponse, f: TaskHttpFixture) => {
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.retryable, false);
  assert.deepEqual(response.body.error.details, {});
  for (const secret of [TASK_TOKEN, f.root, 'FOREIGN_RECORD_MUST_NOT_LEAK']) assert.equal(JSON.stringify(response.body).includes(secret), false);
};

test('task HTTP preserves authentication, cookie, host/origin, exact methods and bounded closed request schemas', {timeout: 30000}, async t => {
  const f = (await taskFixture(t) as unknown as TaskHttpFixture), input = trackInput(f), prepared = await f.prepare('timeline.track.add', input);
  const before = snapshot(f.root), tasks = retained(f), exec = actionInput(f, prepared);
  const routes = [
    {route: '/api/tasks/prepare', method: 'POST', input: {projectId: f.project.id, operation: 'timeline.track.add', input, origin: 'new'}},
    {route: listPath(f.project.id), method: 'GET'},
    {route: taskPath(prepared.task.id) + '?projectId=' + f.project.id, method: 'GET'},
    ...['execute', 'reconcile', 'acknowledge'].map(action => ({route: taskPath(prepared.task.id, action), method: 'POST', input: exec})),
  ];
  for (const route of routes) {
    assert.equal((await f.request(route.route, {...route, authenticated: false})).status, 401);
    for (const headers of [{origin: 'https://foreign.example'}, {origin: 'null'}, {host: 'foreign.example'}])
      assert.equal((await f.request(route.route, {...route, headers: headers as unknown as Record<string, string>})).status, 403);
    const wrong = await f.request(route.route, {method: route.method === 'GET' ? 'POST' : 'GET'});
    assert.equal(wrong.status, 405); assert.equal(wrong.headers.allow, route.method);
  }
  const cookie = await f.request(listPath(f.project.id), {authenticated: false, headers: {cookie: 'mioon_session=' + TASK_TOKEN}});
  assert.equal(cookie.status, 200); assert.equal(cookie.headers['cache-control'], 'no-store');
  assert.equal(cookie.headers['x-content-type-options'], 'nosniff'); assert.ok(isEditTaskListEnvelope(cookie.body.data));
  for (const [route, value] of [
    ['/api/tasks/prepare', {...routes[0].input, taskFault: 'afterBusinessCommit'}],
    ['/api/tasks/prepare', {...routes[0].input, input: {...input, extra: true}}],
    ['/api/tasks/prepare', {...routes[0].input, origin: 'agent'}],
    [taskPath(prepared.task.id, 'execute'), {...exec, extra: true}],
    [taskPath(prepared.task.id, 'execute'), {...exec, taskId: randomUUID()}],
    [taskPath(prepared.task.id, 'execute'), {...exec, taskId: prepared.task.id}],
    [taskPath(prepared.task.id, 'reconcile'), exec],
    [taskPath(prepared.task.id, 'acknowledge'), {...exec, expectedRevision: 1, status: 'applied'}],
  ] as const) {
    const rejected = await f.request(route, {method: 'POST', input: value});
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body)); assertSafe(rejected, f);
  }
  for (const raw of ['{', 'null', '[]', 'true', '{"__proto__":{}}']) {
    const rejected = await f.request('/api/tasks/prepare', {method: 'POST', raw});
    assert.equal(rejected.status, 400); assertSafe(rejected, f);
  }
  assert.equal((await f.request('/api/tasks/prepare', {method: 'POST', input: routes[0].input, headers: {'content-type': 'text/plain'}})).status, 400);
  assert.equal((await f.request('/api/tasks/prepare', {method: 'POST', input: routes[0].input, headers: {'content-encoding': 'gzip'}})).status, 400);
  for (const chunked of [false, true]) {
    const oversized = await f.request('/api/tasks/prepare', {method: 'POST', chunked, raw: JSON.stringify(routes[0].input) + ' '.repeat(EDIT_TASK_HTTP_LIMITS.prepareBytes)});
    assert.equal(oversized.status, 413); assertSafe(oversized, f);
    const actionOversize = await f.request(taskPath(prepared.task.id, 'execute'), {method: 'POST', chunked, raw: JSON.stringify(exec) + ' '.repeat(EDIT_TASK_HTTP_LIMITS.actionBytes)});
    assert.equal(actionOversize.status, 413); assertSafe(actionOversize, f);
  }
  assert.equal((await f.request('/api/tasks/' + prepared.task.id + '/other')).status, 404);
  assert.equal((await f.request('/api/tasks/prepare/execute', {method: 'POST', input: {}})).status, 404);
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(retained(f), tasks); assert.equal(dispatches(f), 0);
});

test('GET/list are noncreating, strictly bound queries and never convert reads into dispatch or acknowledgement', async t => {
  const f = (await taskFixture(t) as unknown as TaskHttpFixture);
  database(f.root, db => db.prepare('DELETE FROM timelines WHERE projectId=?').run(f.foreign.id), true);
  const before = snapshot(f.root), initial = retained(f);
  const empty = await f.data(listPath(f.foreign.id)); assert.deepEqual((empty.items as unknown), []);
  assert.equal((await f.request(taskPath(randomUUID()) + '?projectId=' + f.foreign.id)).status, 404);
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(retained(f), initial);
  const prepared = await f.prepare('timeline.track.add', trackInput(f));
  const reference = await f.prepare('reference.attach', attachInput(f));
  const first = await f.list('&limit=1'); assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const second = await f.list('&limit=1&cursor=' + encodeURIComponent(first.nextCursor));
  assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...first.items, ...second.items].map(item => item.id)), new Set([prepared.task.id, reference.task.id]));
  const domain = snapshot(f.root), taskRows = retained(f);
  for (const query of ['limit=0', 'limit=51', 'limit=-1', 'limit=1.0', 'limit=1e1', 'limit=01', 'limit=1x',
    'limit=NaN', 'limit=9007199254740992', 'limit=1&limit=2', 'pendingOnly=1', 'pendingOnly=TRUE',
    'pendingOnly=false&pendingOnly=true', 'cursor=', 'cursor=bad', 'extra=1', 'projectId=' + f.project.id]) {
    const rejected = await f.request(listPath(f.project.id) + '&' + query);
    assert.equal(rejected.status, 400, query); assertSafe(rejected, f);
  }
  assert.equal((await f.request(listPath(f.project.id) + '&cursor=' + 'a'.repeat(2100))).status, 413);
  assert.equal((await f.request(listPath(f.foreign.id) + '&cursor=' + encodeURIComponent(first.nextCursor))).status, 400);
  assert.equal((await f.request(listPath(f.project.id) + '&pendingOnly=false&cursor=' + encodeURIComponent(first.nextCursor))).status, 400);
  for (const task of [prepared.task, reference.task]) {
    assert.deepEqual((await f.get(task.id)).task, task);
    assert.equal((await f.request(taskPath(task.id) + '?projectId=' + f.foreign.id)).status, 404);
    assert.equal((await f.request(taskPath(task.id) + '?projectId=' + f.project.id + '&limit=1')).status, 400);
  }
  assert.deepEqual(snapshot(f.root), domain); assert.deepEqual(retained(f), taskRows); assert.equal(dispatches(f), 0);
});

test('fixed durable tasks cannot expose generation, rendering, arbitrary RPC or model/MCP authority', async t => {
  const f = (await taskFixture(t) as unknown as TaskHttpFixture), before = snapshot(f.root);
  assert.equal(DURABLE_EDIT_OPERATIONS.length, 21);
  assert.equal(DURABLE_EDIT_OPERATIONS.includes('timeline.loudness.apply'), true);
  assert.equal(DURABLE_EDIT_OPERATIONS.includes('timeline.clip.rippleRemove'), true);
  for (const operation of ['timeline.render', 'generation.submit', 'shot.update', 'task.execute', 'agent.edit.approve', 'project.create']) {
    const response = await f.request('/api/tasks/prepare', {method: 'POST', input: {projectId: f.project.id, operation, input: trackInput(f), origin: 'new'}});
    assert.equal(response.status, 400); assertSafe(response, f);
  }
  for (const operation of ['tasks.prepare', 'tasks.execute', 'edit_tasks.execute', 'agent.tasks.execute']) {
    const response = await f.request('/api/rpc', {method: 'POST', input: {operation, input: {}}});
    assert.equal(response.body.error.code, 'UNKNOWN_OPERATION');
  }
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(((await f.list()).items as unknown), []); assert.equal(dispatches(f), 0);
});

test('real lost prepare acknowledgement rediscovers the exact persisted intent without automatic POST or business change', async t => {
  const f = (await taskFixture(t) as unknown as TaskHttpFixture), input = trackInput(f), before = snapshot(f.root);
  f.lose('/api/tasks/prepare');
  await assert.rejects(f.viaProxy('/api/tasks/prepare', {method: 'POST', input: {projectId: f.project.id, operation: 'timeline.track.add', input, origin: 'new'}}));
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'POST');
  const accepted = f.observed[0].body.data as TaskEnvelope<'timeline.track.add'>; assert.ok(isEditTaskEnvelope(accepted)); assert.equal(accepted.task.status, 'prepared');
  assert.deepEqual(snapshot(f.root), before); assert.equal(dispatches(f), 0);
  const found = await f.viaProxy(listPath(f.project.id)); assert.deepEqual((found.body.data as import("./helpers/strict-edit-task-types.ts").TaskList).items, [accepted.task]);
  const taskRows = retained(f);
  for (let i = 0; i < 3; i++) assert.deepEqual((await f.get(accepted.task.id)).task, accepted.task);
  assert.equal(f.requests.filter(value => value.method === 'POST').length, 1);
  await f.restart();
  const recovered = await f.get(accepted.task.id) as TaskEnvelope<'timeline.track.add'>;
  assert.notEqual(recovered.instanceId, accepted.instanceId); assert.deepEqual(recovered.task, accepted.task);
  assert.deepEqual(retained(f), taskRows); assert.deepEqual(snapshot(f.root), before); assert.equal(dispatches(f), 0);
  const stale = await f.request(taskPath(accepted.task.id, 'execute'), {method: 'POST', input: actionInput(f, accepted)});
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'EDIT_TASK_STALE_INSTANCE');
  const executed = await f.execute(recovered); assert.equal(executed.task.status, 'applied'); assert.equal(dispatches(f), 1);
  assert.deepEqual(executed.task.input, input); assert.equal((executed.result)!.revision, input.expectedRevision + 1);
});

test('real dropped execute response commits once; reads/restart do not replay and explicit reconcile returns historical receipt', async t => {
  const f = (await taskFixture(t) as unknown as TaskHttpFixture), input = trackInput(f), prepared = await f.prepare('timeline.track.add', input);
  const route = taskPath(prepared.task.id, 'execute'); f.lose(route);
  await assert.rejects(f.viaProxy(route, {method: 'POST', input: actionInput(f, prepared)}));
  assert.equal(f.requests.length, 1); assert.equal(dispatches(f), 1);
  const applied = f.observed[0].body.data as TaskEnvelope<'timeline.track.add'>; assert.equal(applied.task.status, 'applied'); assert.ok(isEditTaskEnvelope(applied));
  const before = snapshot(f.root), rows = retained(f);
  assert.deepEqual((await f.get(applied.task.id)).task, applied.task);
  assert.deepEqual((await f.list()).items, [applied.task]);
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(retained(f), rows);
  await f.restart();
  const current = await f.get(applied.task.id); assert.notEqual(current.instanceId, prepared.instanceId);
  const resolved = await f.reconcile(current.task); assert.deepEqual(resolved.result, applied.result);
  assert.deepEqual(await f.execute(current), resolved); assert.equal(dispatches(f), 1);
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(retained(f), rows);
  const ack = await f.acknowledge(resolved.task); assert.equal(ack.task.acknowledged, true);
  assert.deepEqual(((await f.list()).items as unknown), []);
  assert.deepEqual((await f.list('&pendingOnly=false')).items, [ack.task]);
  assert.deepEqual(snapshot(f.root), before); assert.equal(f.requests.filter(value => value.method === 'POST').length, 1);
});

for (const phase of ['afterPreparePersist', 'afterClaim', 'afterBusinessCommit']) {
  test(`real process death at ${phase} recovers before listen without dispatch and rejects stale instance callbacks`, {timeout: 30000}, async t => {
    const f = (await taskFixture(t, {subprocess: true}) as unknown as TaskHttpFixture), input = trackInput(f), before = snapshot(f.root);
    let prepared;
    if (phase !== 'afterPreparePersist') prepared = await f.prepare('timeline.track.add', input);
    const oldInstance = prepared?.instanceId;
    await (f.backend)!.arm(phase);
    if (!prepared) await assert.rejects(f.request('/api/tasks/prepare', {method: 'POST', input: {projectId: f.project.id, operation: 'timeline.track.add', input, origin: 'new'}}));
    else await assert.rejects(f.request(taskPath(prepared.task.id, 'execute'), {method: 'POST', input: actionInput(f, prepared)}));
    assert.equal((await (f.backend)!.exited).signal, 'SIGKILL');
    await f.restart();
    const listed = await f.list(); assert.equal(listed.items.length, 1); assert.notEqual(listed.instanceId, oldInstance);
    const task = listed.items[0]; assert.deepEqual(task.input, input);
    assert.equal(task.status, phase === 'afterPreparePersist' ? 'prepared' : phase === 'afterClaim' ? 'unknown' : 'applied');
    assert.deepEqual(((await (f.backend)!.observe()).phases as unknown), [], 'startup and rediscovery must never dispatch');
    if (phase !== 'afterBusinessCommit') assert.deepEqual(snapshot(f.root), before);
    if (prepared) {
      const stale = await f.request(taskPath(task.id, 'execute'), {method: 'POST', input: actionInput(f, prepared)});
      assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'EDIT_TASK_STALE_INSTANCE');
    }
    const rows = retained(f), current = snapshot(f.root);
    assert.deepEqual((await f.get(task.id)).task, task); assert.deepEqual(retained(f), rows); assert.deepEqual(snapshot(f.root), current);
    if (phase === 'afterBusinessCommit') {
      const recovered = await f.reconcile(task) as TaskEnvelope<'timeline.track.add'>; assert.equal(recovered.task.status, 'applied'); assert.equal((recovered.result)!.revision, input.expectedRevision + 1);
      assert.deepEqual(((await (f.backend)!.observe()).phases as unknown), []); assert.deepEqual(snapshot(f.root), current);
    } else {
      const read = await f.reconcile(task); assert.equal(read.task.status, task.status); assert.deepEqual(snapshot(f.root), before);
      const executed = await f.execute({task: read.task, instanceId: listed.instanceId}) as TaskEnvelope<'timeline.track.add'>;
      assert.equal(executed.task.status, 'applied'); assert.equal((executed.result)!.revision, input.expectedRevision + 1);
      assert.equal((await (f.backend)!.observe()).phases.filter((value: string) => value === 'beforeDispatch').length, 1);
    }
  });
}

test('legacy session import reconciles exact old RPC receipts and closes the lane only on explicit acknowledgement', async t => {
  const f = (await taskFixture(t) as unknown as TaskHttpFixture), input = trackInput(f), result = await f.rpc('timeline.track.add', input), domain = snapshot(f.root);
  const imported = await f.prepare('timeline.track.add', input, 'legacy_session'); assert.equal(imported.task.status, 'unknown');
  assert.equal(dispatches(f), 0); assert.deepEqual(snapshot(f.root), domain);
  const rows = retained(f); assert.deepEqual((await f.get(imported.task.id)).task, imported.task); assert.deepEqual(retained(f), rows);
  const reconciled = await f.reconcile(imported.task); assert.equal(reconciled.task.status, 'applied'); assert.deepEqual(reconciled.result, result);
  const replacement = {projectId: f.project.id, operation: 'timeline.track.add', input: trackInput(f, {expectedRevision: result.revision}), origin: 'new'};
  assert.equal((await f.request('/api/tasks/prepare', {method: 'POST', input: replacement})).status, 409);
  const staleAck = await f.request(taskPath(imported.task.id, 'acknowledge'), {method: 'POST', input: {projectId: f.project.id, digest: imported.task.digest, expectedRevision: imported.task.revision, status: 'applied'}});
  assert.equal(staleAck.status, 409);
  const acknowledged = await f.acknowledge(reconciled.task); assert.equal(acknowledged.task.acknowledged, true);
  const next = await f.data('/api/tasks/prepare', {method: 'POST', input: replacement}); assert.notEqual(next.task.id, imported.task.id);
  assert.equal(dispatches(f), 0); assert.deepEqual(snapshot(f.root), domain);
});

test('reference attach/detach task receipts remain historical and GET does not reattach a removed edge', async t => {
  const f = (await taskFixture(t) as unknown as TaskHttpFixture), input = attachInput(f), prepared = await f.prepare('reference.attach', input);
  const applied = await f.execute(prepared); assert.equal(applied.task.status, 'applied'); assert.ok((applied.result)!.edge);
  await f.acknowledge(applied.task);
  const detach = {projectId: f.project.id, edgeId: (applied.result)!.edge.id, expectedShotRevision: (applied.result)!.shot.revision, requestId: randomUUID()};
  const removed = await f.execute(await f.prepare('reference.detach', detach));
  assert.equal(removed.task.status, 'applied'); assert.equal((removed.result)!.detached, true);
  const domain = snapshot(f.root), rows = retained(f);
  await f.restart();
  assert.equal((await f.get(applied.task.id)).task.status, 'applied');
  assert.deepEqual((await f.reconcile(applied.task)).result, applied.result);
  assert.deepEqual((await f.reconcile(removed.task)).result, removed.result);
  assert.deepEqual(snapshot(f.root), domain); assert.deepEqual(retained(f), rows); assert.equal(dispatches(f), 2);
  assert.equal(database(f.root, db => (db.prepare('SELECT count(*) AS n FROM edges WHERE id=?').get((applied.result)!.edge.id))!.n), 0);
});

async function command(operation: string, input: Record<string, unknown>, url: string) {
  const child = spawn(process.execPath, [path.join(REPO, 'apps/cli/src/index.ts'), ...operation.split('.'), '--input', JSON.stringify(input)], {
    cwd: REPO, env: {...process.env, MIOON_BASE_URL: url, MIOON_TOKEN: TASK_TOKEN, MIOON_ENABLE_LIVE_PROVIDER: '0'}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill('SIGKILL'); });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  let code, signal;
  try { [code, signal] = await once(child, 'close'); } finally { clearTimeout(timer); }
  assert.equal(signal, null, stderr); assert.equal(code, 0, stdout + stderr);
  assert.equal((stdout + stderr).includes(TASK_TOKEN), false); return JSON.parse(stdout);
}

test('official CLI and MCP replay the same domain receipts after task execution without exposing task tools', {timeout: 30000}, async t => {
  const f = (await taskFixture(t) as unknown as TaskHttpFixture);
  const mcp = new Client({name: 'durable-edit-http-tests', version: '1.0.0'}, {capabilities: {}});
  t.after(() => mcp.close());
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(REPO, 'apps/mcp/src/index.ts')], cwd: REPO,
    env: {...process.env, MIOON_BASE_URL: (f.backend)!.url, MIOON_TOKEN: TASK_TOKEN, MIOON_ENABLE_LIVE_PROVIDER: '0'}, stderr: 'pipe'});
  (transport.stderr as import('node:stream').Readable | null)?.resume(); await mcp.connect(transport);
  const tools = await mcp.listTools();
  assert.equal(tools.tools.some(tool => /^(?:tasks|edit_tasks)_/u.test(tool.name)), false);
  for (const [operation, input] of [['timeline.track.add', trackInput(f)], ['reference.attach', attachInput(f)]] as const) {
    const applied = await f.execute(await f.prepare(operation, input)), domain = snapshot(f.root), rows = retained(f);
    assert.deepEqual(await command(operation, input, (f.backend)!.url), {ok: true, data: applied.result});
    const response = await mcp.callTool({name: operation.replaceAll('.', '_'), arguments: input});
    assert.equal(response.isError, false); assert.deepEqual(response.structuredContent, {ok: true, data: applied.result});
    assert.deepEqual(JSON.parse(((response.content as {type: string; text: string}[]).find((block: { type: string; }) => block.type === 'text'))!.text), response.structuredContent);
    assert.deepEqual(await f.rpc(operation, input), applied.result);
    assert.deepEqual(snapshot(f.root), domain); assert.deepEqual(retained(f), rows);
  }
  assert.equal(dispatches(f), 2);
});

test('shutdown rejects a late request body and waits for owned HTTP work before releasing SQLite', {timeout: 15000}, async t => {
  const f = (await taskFixture(t) as unknown as TaskHttpFixture), input = JSON.stringify({projectId: f.project.id, operation: 'timeline.track.add', input: trackInput(f), origin: 'new'});
  const req = http.request((f.backend)!.url + '/api/tasks/prepare', {method: 'POST', agent: false,
    headers: {authorization: 'Bearer ' + TASK_TOKEN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(input)}}, res => res.resume());
  req.on('error', () => {}); req.write(input.slice(0, 20));
  await once(req, 'socket');
  // Let the real handler enter its bounded body reader before shutdown.
  await new Promise(resolve => setTimeout(resolve, 20));
  const closing = (f.backend)!.close();
  req.end(input.slice(20));
  await closing;
  assert.equal(database(f.root, db => (db.prepare('SELECT count(*) AS n FROM edit_tasks').get())!.n), 0);
  assert.equal(dispatches(f), 0);
  await f.restart(); assert.deepEqual(((await f.list()).items as unknown), []);
});
