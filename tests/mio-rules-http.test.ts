import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {handleMioRulesHttp, handleUserRulesHttp} from '../apps/server/src/mio-rules-http.ts';
import type {ProjectRulesPort, UserRulesPort} from '../apps/server/src/mio-rules-http.ts';
import type {ProjectRulesSnapshot, UserRulesSnapshot} from '../packages/contracts/src/mio-rules.ts';

async function fixture(t: TestContext) {
  const projectId = randomUUID(), requestId = randomUUID(), hash = 'a'.repeat(64), calls: Array<{method: string; input?: unknown}> = [];
  let snapshot: ProjectRulesSnapshot = {projectId, file: 'AGENTS.md', exists: true, text: 'exact\r\n', hash, trust: 'trusted', maxBytes: 8192, readError: null, pendingWrites: false};
  let user: UserRulesSnapshot = {text: '', revision: 0, updatedAt: null, maxBytes: 8192};
  const rules: ProjectRulesPort = {
    read() {calls.push({method: 'read'}); return snapshot;},
    save(input) {calls.push({method: 'save', input}); return {...snapshot, text: input.text};},
    enable(input) {calls.push({method: 'enable', input}); return snapshot;},
    lookup(id) {calls.push({method: 'lookup', input: id}); return {projectId, requestId: id, status: 'uncertain', state: 'trust_pending', result: null};},
    reconcile(id) {calls.push({method: 'reconcile', input: id}); return {projectId, requestId: id, status: 'applied', state: 'completed', result: snapshot};},
  };
  const userRules: UserRulesPort = {
    read() {calls.push({method: 'user.read'}); return user;},
    save(input) {calls.push({method: 'user.save', input}); return {...user, text: input.text};},
    lookup(id) {calls.push({method: 'user.lookup', input: id}); return {requestId: id, status: 'not_applied', result: null};},
  };
  const server = createServer((req, res) => {void (async () => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (await handleMioRulesHttp({req, res, url, projectId, rules}) || await handleUserRulesHttp({req, res, url, rules: userRules})) return;
    res.writeHead(404); res.end();
  })().catch(() => {res.writeHead(500); res.end();});});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  async function request(route: string, method = 'GET', input?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(baseUrl + route, {method, headers: {...(input === undefined ? {} : {'content-type': 'application/json'}), ...headers}, ...(input === undefined ? {} : {body: input instanceof Uint8Array ? new Uint8Array(input) : JSON.stringify(input)})});
    return {response, status: response.status, value: await response.json() as {ok: boolean; data?: unknown; error?: {code: string}}};
  }
  return {projectId, requestId, hash, calls, rules, userRules, request, prefix: `/api/projects/${projectId}/rules`, snapshot,
    setSnapshot(value: ProjectRulesSnapshot) {snapshot = value;}, setUser(value: UserRulesSnapshot) {user = value;}};
}

test('project and application rules routes forward only their strict addressed inputs', async t => {
  const f = await fixture(t), save = {requestId: f.requestId, expectedHash: null, text: '\r\n'};
  assert.deepEqual((await f.request(f.prefix)).value.data, f.snapshot);
  assert.equal((await f.request(f.prefix, 'PUT', save)).status, 200);
  assert.deepEqual(f.calls.at(-1), {method: 'save', input: save});
  const enable = {requestId: f.requestId, expectedHash: f.hash};
  assert.equal((await f.request(f.prefix + '/enable', 'POST', enable)).status, 200);
  assert.deepEqual(f.calls.at(-1), {method: 'enable', input: enable});
  assert.equal((await f.request('/api/user-rules')).status, 200);
  const user = {requestId: f.requestId, expectedRevision: 0, text: 'habits\r\n'};
  assert.equal((await f.request('/api/user-rules', 'PUT', user)).status, 200);
  assert.deepEqual(f.calls.at(-1), {method: 'user.save', input: user});
});

test('GET lookup only observes; explicit reconciliation is POST with no claimed authority', async t => {
  const f = await fixture(t), route = f.prefix + '/requests/' + f.requestId;
  assert.equal((await f.request(route)).status, 200); assert.deepEqual(f.calls, [{method: 'lookup', input: f.requestId}]);
  assert.equal((await f.request(route + '/reconcile', 'GET')).status, 405); assert.equal(f.calls.length, 1);
  assert.equal((await f.request(route + '/reconcile', 'POST', {approved: true})).status, 400); assert.equal(f.calls.length, 1);
  assert.equal((await f.request(route + '/reconcile', 'POST', {})).status, 200); assert.deepEqual(f.calls.at(-1), {method: 'reconcile', input: f.requestId});
  assert.equal((await f.request('/api/user-rules/requests/' + f.requestId)).status, 200); assert.deepEqual(f.calls.at(-1), {method: 'user.lookup', input: f.requestId});
});

test('HTTP rejects extra authority, queries, invalid text and malformed UTF-8 before invoking a port', async t => {
  const f = await fixture(t), save = {requestId: f.requestId, expectedHash: null, text: ''};
  for (const extra of [{approved: true}, {trust: true}, {path: '/private'}, {projectId: f.projectId}]) assert.equal((await f.request(f.prefix, 'PUT', {...save, ...extra})).status, 400);
  for (const text of ['\ud800', '\0', 'x'.repeat(8193)]) assert.equal((await f.request(f.prefix, 'PUT', {...save, text})).status, 400);
  assert.equal((await f.request(f.prefix + '?path=AGENTS.md')).status, 400);
  assert.equal((await f.request(f.prefix, 'PUT', Buffer.from([0x7b, 0x22, 0xff]), {'content-type': 'application/json'})).status, 400);
  assert.equal((await f.request(f.prefix, 'PUT', save, {'content-encoding': 'gzip'})).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request(f.prefix, 'PUT', {...save, text: 'x'.repeat(66 * 1024)})).status, 413); assert.equal(f.calls.length, 0);
});

test('HTTP output validation rejects wrong project/receipt and sanitizes unknown failures', async t => {
  const f = await fixture(t);
  f.setSnapshot({...f.snapshot, projectId: randomUUID()});
  assert.equal((await f.request(f.prefix)).status, 503);
  f.rules.lookup = () => ({projectId: f.projectId, requestId: randomUUID(), status: 'not_applied', state: null, result: null});
  assert.equal((await f.request(f.prefix + '/requests/' + f.requestId)).status, 503);
  f.rules.read = () => {throw Object.assign(Error('/private/secret AGENTS text'), {code: 'PRIVATE_CODE'});};
  const rejected = await f.request(f.prefix); assert.equal(rejected.status, 503); assert.equal(rejected.value.error!.code, 'MIO_RULES_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(rejected.value), /private|secret|PRIVATE_CODE/u);
  f.rules.read = () => {throw Object.assign(Error('/private/secret'), {code: 'MIO_RULES_CONFLICT'});};
  assert.equal((await f.request(f.prefix)).status, 409);
});
