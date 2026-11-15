import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {startServer, type InspectApplication, type InspectProject} from './helpers/test-server.ts';
import {createProjectRulesClient} from '../packages/client/src/project-rules.ts';
import {openProjectDatabase, projectDirFor} from './helpers/project-database.ts';

const token = 'synthetic-r2-host-rules-token-123456';
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function object(value: unknown): Record<string, unknown> {assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;}
async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-rules-host-'));
  let server: Awaited<ReturnType<typeof startServer>>, client: ReturnType<typeof createProjectRulesClient>;
  let inspectProject!: InspectProject, inspectApplication!: InspectApplication;
  const outside: DatabaseSync[] = [];
  async function start() {
    server = await startServer({dataDir: root, port: 0, token, comfyModule: 'skip', inspectProject: read => {inspectProject = read;}, inspectApplication: read => {inspectApplication = read;}});
    client = createProjectRulesClient({env: {MIOON_BASE_URL: server.url, MIOON_TOKEN: token}});
  }
  await start();
  t.after(async () => {for (const db of outside) if (db.isOpen) db.close(); await server.close(); rmSync(root, {recursive: true, force: true});});
  async function request(route: string, {method = 'GET', input, headers = {}}: {method?: string; input?: unknown; headers?: Record<string, string>} = {}) {
    const response = await fetch(server.url + route, {method, headers: {authorization: `Bearer ${token}`, ...(input === undefined ? {} : {'content-type': 'application/json'}), ...headers}, ...(input === undefined ? {} : {body: JSON.stringify(input)})});
    const text = await response.text(); let body: unknown; try {body = JSON.parse(text);} catch {body = text;}
    return {status: response.status, body};
  }
  async function project() {
    const created = await request('/api/rpc', {method: 'POST', input: {operation: 'project.create', input: {name: 'Rules host project'}}});
    assert.equal(created.status, 200, JSON.stringify(created.body)); const projectId = object(object(created.body).data).id; assert.equal(typeof projectId, 'string');
    const id = String(projectId); return {projectId: id, prefix: `/api/projects/${id}/rules`, file: path.join(projectDirFor(root, id), 'AGENTS.md')};
  }
  return {root, request, project, get client() {return client;},
    inspectProject: <T>(id: string, read: (db: DatabaseSync) => T) => inspectProject(id, read),
    inspectApplication: <T>(read: (db: DatabaseSync) => T) => inspectApplication(read),
    async restart() {await server.close(); await start();},
    holdClosedProject(id: string) {const db = openProjectDatabase(projectDirFor(root, id)); outside.push(db); return db;},
  };
}

test('real native hosts save exact AGENTS bytes, auto-trust manual edits and explicitly enable external changes', async t => {
  const f = await fixture(t), p = await f.project(), requestId = randomUUID();
  assert.deepEqual(await f.client.get({projectId: p.projectId}), {projectId: p.projectId, file: 'AGENTS.md', exists: false, text: null, hash: null, trust: 'absent', maxBytes: 8192, readError: null, pendingWrites: false});
  const empty = await f.client.save({projectId: p.projectId, requestId, expectedHash: null, text: ''});
  assert.equal(empty.trust, 'trusted'); assert.equal(empty.hash, hash('')); assert.equal(readFileSync(p.file, 'utf8'), '');
  const text = 'a\r\n'.repeat(2730) + 'ab', savedId = randomUUID();
  const saved = await f.client.save({projectId: p.projectId, requestId: savedId, expectedHash: empty.hash, text});
  assert.equal(saved.hash, hash(text)); assert.equal(saved.trust, 'trusted'); assert.equal(readFileSync(p.file).byteLength, 8192); assert.equal(readFileSync(p.file, 'utf8'), text);
  assert.deepEqual(await f.client.lookup({projectId: p.projectId, requestId: savedId}), {projectId: p.projectId, requestId: savedId, status: 'applied', state: 'completed', result: saved});
  assert.deepEqual(await f.client.save({projectId: p.projectId, requestId: savedId, expectedHash: empty.hash, text}), saved);
  const external = '# externally changed\r\n'; writeFileSync(p.file, external);
  const untrusted = await f.client.get({projectId: p.projectId}); assert.equal(untrusted.trust, 'untrusted'); assert.equal(untrusted.hash, hash(external));
  await assert.rejects(f.client.enable({projectId: p.projectId, requestId: randomUUID(), expectedHash: saved.hash}), {code: 'MIO_RULES_CONFLICT'});
  const enableId = randomUUID(), enabled = await f.client.enable({projectId: p.projectId, requestId: enableId, expectedHash: untrusted.hash}); assert.equal(enabled.trust, 'trusted');
  assert.deepEqual((await f.client.lookup({projectId: p.projectId, requestId: enableId})).status, 'applied');
  const trust = f.inspectApplication(db => db.prepare('SELECT data FROM project_rules_trust WHERE projectId=?').get(p.projectId)!);
  assert.equal(object(JSON.parse(String(trust.data))).sha256, hash(external));
  assert.equal(f.inspectProject(p.projectId, db => db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE name IN ('user_rules','project_rules_trust','app_operation_receipts')").get()!.n), 0);
});

test('GET stays read-only while restart leaves a proven publication pending until explicit same-request reconciliation', async t => {
  const f = await fixture(t), p = await f.project(), requestId = randomUUID(), input = {projectId: p.projectId, requestId, expectedHash: null, text: 'published before the final receipt\r\n'};
  f.inspectProject(p.projectId, db => db.exec("CREATE TEMP TRIGGER fail_rules_completion BEFORE UPDATE OF state ON mio_rule_writes WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'SYNTHETIC completion failure');END"));
  await assert.rejects(f.client.save(input)); assert.equal(readFileSync(p.file, 'utf8'), input.text);
  let pending = await f.client.lookup({projectId: p.projectId, requestId}); assert.equal(pending.status, 'uncertain'); assert.equal(pending.state, 'trust_pending');
  const oldOwner = f.inspectProject(p.projectId, db => db); await f.restart(); assert.equal(oldOwner.isOpen, false);
  const current = await f.client.get({projectId: p.projectId}); assert.equal(current.trust, 'pending'); assert.equal(current.pendingWrites, true);
  const before = f.inspectProject(p.projectId, db => db.prepare('SELECT total_changes() AS n').get()!.n), appBefore = f.inspectApplication(db => db.prepare('SELECT total_changes() AS n').get()!.n);
  pending = await f.client.lookup({projectId: p.projectId, requestId}); assert.equal(pending.status, 'uncertain');
  assert.equal(f.inspectProject(p.projectId, db => db.prepare('SELECT total_changes() AS n').get()!.n), before); assert.equal(f.inspectApplication(db => db.prepare('SELECT total_changes() AS n').get()!.n), appBefore);
  await assert.rejects(f.client.save(input), {code: 'MIO_RULES_WRITE_UNCERTAIN'});
  const completed = await f.client.reconcile({projectId: p.projectId, requestId}); assert.equal(completed.status, 'applied');
  assert.equal((await f.client.get({projectId: p.projectId})).trust, 'trusted'); assert.equal(readFileSync(p.file, 'utf8'), input.text);
});

test('real routing gates authentication and project identity; user rules work with all projects closed and externally held', async t => {
  const f = await fixture(t), p = await f.project(), other = await f.project(), requestId = randomUUID();
  assert.equal((await f.request(p.prefix, {headers: {authorization: 'Bearer invalid'}})).status, 401);
  assert.equal((await f.request('/api/user-rules', {headers: {origin: 'https://foreign.example'}})).status, 403);
  for (const route of ['/api/rules', '/api/agent/rules', '/api/user-rules/enable']) assert.equal((await f.request(route)).status, 404);
  assert.equal((await f.request(p.prefix, {method: 'PUT', input: {projectId: other.projectId, requestId, expectedHash: null, text: 'must not write'}})).status, 400);
  const saved = await f.client.save({projectId: p.projectId, requestId, expectedHash: null, text: 'owned'});
  await assert.rejects(f.client.lookup({projectId: other.projectId, requestId}), {code: 'MIO_RULES_REQUEST_CONFLICT'});
  assert.equal((await f.client.get({projectId: other.projectId})).exists, false);
  f.inspectProject(p.projectId, db => db.exec('PRAGMA query_only=ON')); f.inspectApplication(db => db.exec('PRAGMA query_only=ON'));
  try {
    assert.deepEqual(await f.client.get({projectId: p.projectId}), saved); assert.equal((await f.client.lookup({projectId: p.projectId, requestId})).status, 'applied');
    await assert.rejects(f.client.save({projectId: p.projectId, requestId: randomUUID(), expectedHash: saved.hash, text: 'read-only cannot publish'}), {code: 'MIO_RULES_UNAVAILABLE'});
    assert.equal(readFileSync(p.file, 'utf8'), 'owned');
  } finally {f.inspectApplication(db => db.exec('PRAGMA query_only=OFF')); f.inspectProject(p.projectId, db => db.exec('PRAGMA query_only=OFF'));}
  const userId = randomUUID(), user = await f.client.saveUser({requestId: userId, expectedRevision: 0, text: 'habits\r\n'});
  await f.restart(); const external = f.holdClosedProject(p.projectId), before = external.prepare('SELECT total_changes() AS n').get()!.n;
  assert.deepEqual(await f.client.getUser(), user); assert.deepEqual(await f.client.lookupUser({requestId: userId}), {requestId: userId, status: 'applied', result: user});
  assert.equal((await f.client.saveUser({requestId: randomUUID(), expectedRevision: user.revision, text: ''})).revision, user.revision + 1);
  assert.equal(external.prepare('SELECT total_changes() AS n').get()!.n, before); assert.equal(external.isOpen, true);
});
