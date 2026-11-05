import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWebProjectRulesClient, ProjectRulesRequestError} from '../apps/web/src/project-rules-client.ts';
import {createProjectRulesState} from '../apps/web/src/project-rules-state.ts';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createMioProjectRules} from '../packages/business/src/agent/mio-rules.ts';
import {handleMioRulesHttp} from '../apps/server/src/mio-rules-http.ts';
import type {ProjectRulesSaveInput, ProjectRulesSnapshot} from '../packages/contracts/src/mio-rules.ts';

const projectId = randomUUID(), requestId = randomUUID(), hash = 'a'.repeat(64);
const snapshot: ProjectRulesSnapshot = {projectId, file: 'AGENTS.md', exists: true, text: 'Exact\r\n😀', hash, trust: 'trusted', maxBytes: 8192, readError: null, pendingWrites: false};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? {ok: true, data} : {ok: false, error: data}), {status, headers: {'content-type': 'application/json'}});

test('browser rules transport addresses only the project and preserves exact CAS/input and explicit lookup methods', async () => {
  const calls: Array<{path: string; init?: RequestInit}> = [];
  const client = createWebProjectRulesClient({fetcher: async (input, init) => {const route = String(input); calls.push({path: route, init}); return response(route.includes('/requests/') ? {projectId, requestId, status: 'applied', state: 'completed', result: snapshot} : snapshot);}});
  assert.deepEqual(await client.read(projectId), snapshot);
  const input = {requestId, expectedHash: hash, text: 'Exact\r\n😀'};
  await client.save(projectId, input); await client.enable(projectId, {requestId, expectedHash: hash}); await client.lookup(projectId, requestId); await client.reconcile(projectId, requestId);
  assert.deepEqual(calls.map(call => call.init?.method), ['GET', 'PUT', 'POST', 'GET', 'POST']);
  assert.deepEqual(calls.map(call => call.path), [`/api/projects/${projectId}/rules`, `/api/projects/${projectId}/rules`, `/api/projects/${projectId}/rules/enable`, `/api/projects/${projectId}/rules/requests/${requestId}`, `/api/projects/${projectId}/rules/requests/${requestId}/reconcile`]);
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), input); assert.equal(calls[4]!.init?.body, '{}');
  assert.ok(calls.every(call => call.init?.credentials === 'same-origin' && call.init.redirect === 'error'));
});

test('browser rules rejects extra authority and invalid UTF-8-sized text before dispatch', async () => {
  let calls = 0; const client = createWebProjectRulesClient({fetcher: async () => {calls++; return response(snapshot);}});
  for (const text of ['x'.repeat(8193), '雨'.repeat(2731), '\u0007', '\ud800']) await assert.rejects(async () => client.save(projectId, {requestId, expectedHash: null, text}), {code: 'MIO_RULES_INVALID', outcomeUnknown: false});
  await assert.rejects(async () => client.save(projectId, {requestId, expectedHash: null, text: '', trust: true} as unknown as ProjectRulesSaveInput), {code: 'MIO_RULES_INVALID'});
  await assert.rejects(async () => client.read('../other'), {code: 'MIO_RULES_INVALID'}); assert.equal(calls, 0);
});

test('foreign snapshots, receipts and malformed bounded responses never authorize another write', async () => {
  for (const body of [response({...snapshot, projectId: randomUUID()}), new Response('not json', {headers: {'content-type': 'application/json'}}), new Response(new Uint8Array([0xff]), {headers: {'content-type': 'application/json'}}), new Response('x'.repeat(65_537), {headers: {'content-type': 'application/json'}})]) {
    let calls = 0; const client = createWebProjectRulesClient({fetcher: async () => {calls++; return body;}});
    await assert.rejects(client.save(projectId, {requestId, expectedHash: hash, text: 'new'}), {code: 'BACKEND_PROTOCOL_ERROR', outcomeUnknown: true}); assert.equal(calls, 1);
  }
  const client = createWebProjectRulesClient({fetcher: async () => response({projectId, requestId: randomUUID(), status: 'not_applied', state: null, result: null})});
  await assert.rejects(client.lookup(projectId, requestId), {code: 'BACKEND_PROTOCOL_ERROR', outcomeUnknown: false});
});

test('lost, cancelled and sanitized write errors retain uncertainty without retrying or leaking server text', async () => {
  let calls = 0; const client = createWebProjectRulesClient({fetcher: async () => {calls++; throw Error('private provider token must never surface');}});
  await assert.rejects(client.save(projectId, {requestId, expectedHash: hash, text: 'new'}), (error: unknown) => error instanceof ProjectRulesRequestError && error.outcomeUnknown && !error.message.includes('private'));
  assert.equal(calls, 1);
  const abort = new AbortController(); abort.abort(); await assert.rejects(client.save(projectId, {requestId, expectedHash: hash, text: 'new'}, {signal: abort.signal}), {code: 'INTERRUPTED', outcomeUnknown: false}); assert.equal(calls, 1);
  const rejected = createWebProjectRulesClient({fetcher: async () => response({code: 'MIO_RULES_CONFLICT', message: 'private path'}, 409)});
  await assert.rejects(rejected.save(projectId, {requestId, expectedHash: hash, text: 'new'}), {code: 'MIO_RULES_CONFLICT', outcomeUnknown: false});
  const unavailable = createWebProjectRulesClient({fetcher: async () => response({code: 'MIO_RULES_UNAVAILABLE'}, 503)});
  await assert.rejects(unavailable.save(projectId, {requestId, expectedHash: hash, text: 'new'}), {code: 'MIO_RULES_UNAVAILABLE', outcomeUnknown: true});
});

test('real R2 HTTP plus browser state saves exact bytes, detects external CAS and enables only the reviewed hash', async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'web-project-rules-')), store = openStore(root), application = testProjectAppLibrary(store); assert.ok(application);
  store.put('projects', {id: store.projectId, name: 'Browser rules'});
  const rules = createMioProjectRules({store, application}), calls: string[] = [];
  const server = createServer((req, res) => {calls.push(`${req.method} ${req.url}`); void handleMioRulesHttp({req, res, url: new URL(req.url!, 'http://127.0.0.1'), projectId: store.projectId, rules});});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rules.close(); store.close(); rmSync(root, {recursive: true, force: true});});
  const base = `http://127.0.0.1:${address.port}`, client = createWebProjectRulesClient({fetcher: (input, init) => fetch(base + String(input), init)}), values = new Map<string, string>();
  const controller = createProjectRulesState({projectId: store.projectId, client, storage: () => ({getItem: key => values.get(key) ?? null, setItem: (key, value) => {values.set(key, value);}, removeItem: key => {values.delete(key);}})});
  t.after(() => controller.dispose()); await controller.load(); assert.equal(controller.getSnapshot().snapshot?.trust, 'absent');
  controller.setDraft('规则\r\n😀\n'); assert.equal(await controller.save(), true); assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '规则\r\n😀\n'); assert.equal(values.size, 0);
  writeFileSync(path.join(root, 'AGENTS.md'), 'external\r\n'); controller.setDraft('retained draft'); assert.equal(await controller.save(), false); assert.equal(controller.getSnapshot().mutation, 'conflict'); assert.equal(controller.getSnapshot().draft, 'retained draft');
  await controller.loadLatest(); assert.equal(controller.getSnapshot().draft, 'external\r\n'); assert.equal(controller.getSnapshot().snapshot?.trust, 'untrusted');
  assert.equal(await controller.enable(), true); assert.equal(controller.getSnapshot().snapshot?.trust, 'trusted'); assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'external\r\n');
  assert.equal(calls.filter(call => call.startsWith('POST')).length, 1); assert.ok(calls.at(-1)?.endsWith('/enable')); assert.equal(calls.some(call => call.endsWith('/reconcile')), false);
});
