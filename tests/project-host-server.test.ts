import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import promises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {startServer, type InspectProject, type ServerOptions} from '../apps/server/src/index.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {DEFAULT_REQUEST_DRAIN_MS} from '../apps/server/src/project-host/types.ts';
import {setTimeout as pause} from 'node:timers/promises';
import {writeProjectCover} from '../apps/server/src/project-host/covers.ts';
import {createServerProject, openProjectDatabase} from './helpers/project-database.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProjectHomeServices} from '../packages/business/src/project-home.ts';
import {projectApiPath, projectMediaPath, projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {agentDiagnosticSummarySchema} from '../packages/contracts/src/agent-diagnostic-summary.ts';
import type {AgentDiagnosticSummary} from '../packages/contracts/src/agent-diagnostic-summary.ts';
import type {AgentTaskPolicy} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {ProjectSummary} from '../packages/contracts/src/project-home.ts';
import {syntheticPng} from './helpers/runway-unknown-fixture.ts';

const token = 'project-host-server-synthetic-token';
const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,0,1,0,1,3,1,0x22,0,2,0x11,1,3,0x11,1,0xff,0xda,0,12,3,1,0,2,0x11,3,0x11,0,0x3f,0,0x12,0x34,0xff,0xd9]);
const latest: AgentDiagnosticSummary = {completedAt: '2026-11-02T00:00:00.000Z', status: 'completed', protocol: 'responses', model: 'synthetic-host-diagnostic', errorCode: null};
interface WireBody<T> {ok: boolean; data?: T; error?: {code: string; message: string; details?: unknown; retryable?: boolean}}
interface Seed {projectId: string; root: string; projectFile: string; assetId: string; shotId: string; shotRevision: number; summary: ProjectSummary}

async function seed(dataDir: string, name: string): Promise<Seed> {
  const created = createServerProject(dataDir, {name}), store = created.store;
  const library = openAppLibrary({dataDir});
  const services = createServices(store, new Map(), {application: createProjectServiceApplication(library, undefined, {MIOON_ENABLE_LIVE_PROVIDER: '0'})});
  try {
    const assetId = randomUUID(), sha256 = createHash('sha256').update(syntheticPng).digest('hex'), relativePath = `media/${assetId}.png`;
    writeFileSync(path.join(store.projectDir, relativePath), syntheticPng, {mode: 0o600});
    store.put('assets', {id: assetId, projectId: created.projectId, name: 'Synthetic pixel', mimeType: 'image/png', width: 1, height: 1,
      sizeBytes: syntheticPng.length, sha256, relativePath, createdAt: '2026-11-02T00:00:00.000Z'});
    const shot = await services.call('shot.create', {projectId: created.projectId, title: name + ' shot'}) as {id: string; revision: number};
    const timeline = await services.call('timeline.get', {projectId: created.projectId}) as {revision: number; tracks: {id: string}[]};
    await services.call('timeline.clip.add', {projectId: created.projectId, expectedRevision: timeline.revision, requestId: randomUUID(),
      assetId, trackId: timeline.tracks[0]!.id, startFrame: 0, durationFrames: 30});
    const summary = createProjectHomeServices(store).handlers['project.summary.list']()[0]!;
    const {id: _id, name: title, lastOpenedAt: _opened, cover, ...rest} = summary;
    assert.equal(cover?.assetId, assetId);
    library.registry.upsert({...library.registry.get(created.projectId)!, name: title,
      summary: {...rest, cover: {assetId, mimeType: 'image/png'}}});
    writeProjectCover({cacheDir: store.cacheDir, source: {assetId, mimeType: 'image/png', sourceSha256: sha256}, jpeg});
    return {projectId: created.projectId, root: store.projectDir, projectFile: store.projectFile, assetId, shotId: shot.id, shotRevision: shot.revision, summary};
  } finally {await services.drain(); store.close(); library.close();}
}

async function fixture(t: TestContext, options: Pick<ServerOptions, 'agentSettings'> = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-project-host-server-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const outside: DatabaseSync[] = [];
  t.after(async () => {for (const db of outside) if (db.isOpen) db.close(); await server?.close(); rmSync(root, {recursive: true, force: true});});
  const a = await seed(root, 'Project A'), b = await seed(root, 'Project B');
  const library = openAppLibrary({dataDir: root});
  try {library.tx(() => library.documents.write('agent-diagnostic-summary-v1.json', JSON.stringify(latest)));}
  finally {library.close();}
  let inspect!: InspectProject;
  server = await startServer({...options, dataDir: root, port: 0, token, inspectProject: received => {inspect = received;}});
  const fetchOwned = (route: string, options: RequestInit = {}) => fetch(server!.url + route, {...options, headers: {authorization: `Bearer ${token}`, ...options.headers}});
  const json = async <T = unknown>(route: string, options: {method?: string; input?: unknown} = {}) => {
    const response = await fetchOwned(route, {method: options.method ?? 'GET', ...(options.input === undefined ? {} :
      {headers: {'content-type': 'application/json'}, body: JSON.stringify(options.input)})});
    return {status: response.status, body: await response.json() as WireBody<T>};
  };
  const rpc = async <T = unknown>(projectId: string | null, operation: string, input: unknown = {}) => {
    const result = await json<T>(projectId === null ? '/api/rpc' : projectRpcPath(projectId), {method: 'POST', input: {operation, input}});
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true); return result.body.data!;
  };
  const holdClosed = (project: Seed): DatabaseSync => {const db = openProjectDatabase(project.root); outside.push(db); return db;};
  return {root, a, b, json, rpc, fetch: fetchOwned, native: (projectId: string) => inspect(projectId, db => db), holdClosed};
}

function managerTimers(t: TestContext) {
  const original = globalThis.setTimeout, grace: number[] = [], drain = Promise.withResolvers<void>();
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof original>) => {
    const timer = original(...args), stack = new Error().stack?.replaceAll('\\', '/') ?? '';
    if (stack.includes('/project-host/manager.ts')) {
      const delay = args[1] ?? 0;
      if (delay > 30_000 && delay <= 60_000) grace.push(Date.now() + delay);
      if (delay === DEFAULT_REQUEST_DRAIN_MS) drain.resolve();
    }
    return timer;
  });
  return {grace, drain: drain.promise};
}

async function waitForIdleTimer(timers: ReturnType<typeof managerTimers>) {
  const deadline = performance.now() + 6000;
  while (!timers.grace.length && performance.now() < deadline) await pause(10);
  assert.ok(timers.grace.length, 'the real host became idle and scheduled its existing grace');
}

async function assertClosedApplicationReads(f: Awaited<ReturnType<typeof fixture>>, projects: Seed[]) {
  const holders = projects.map(project => f.holdClosed(project));
  try {
    const health = await f.json<{service: string}>('/health'); assert.equal(health.status, 200); assert.equal(health.body.ok, true);
    const policy = await f.json<{policy: AgentTaskPolicy; readOnly: boolean}>('/api/agent/tasks/v2/policy');
    assert.equal(policy.status, 200); assert.equal(policy.body.data!.readOnly, false);
    const settings = await f.json('/api/agent/settings'); assert.equal(settings.status, 200);
    const workspace = await f.rpc<{liveGeneration: boolean}>(null, 'workspace.settings.get'); assert.equal(workspace.liveGeneration, false);
    const summaries = await f.rpc<ProjectSummary[]>(null, 'project.summary.list'); assert.equal(summaries.length, 2);
    const diagnostic = await f.json<{test: AgentDiagnosticSummary}>('/api/agent/tasks/v2/diagnostics/latest');
    assert.equal(diagnostic.status, 200); assert.deepEqual(diagnostic.body.data, {test: latest});
    assert.deepEqual(Object.keys(diagnostic.body.data!.test).sort(), ['completedAt', 'errorCode', 'model', 'protocol', 'status']);
    assert.equal(agentDiagnosticSummarySchema.safeParse(diagnostic.body.data!.test).success, true);
    for (const project of projects) {
      const response = await f.fetch(`/api/project-covers/${project.projectId}`); assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/jpeg'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
    }
    assert.ok(holders.every(db => db.isOpen), 'application reads preserve the external native owners of closed projects');
  } finally {for (const db of holders) db.close();}
}

test('real server serves global settings, policy, five-field diagnostics and cover cache while both projects are locked elsewhere', async t => {
  const f = await fixture(t);
  await assertClosedApplicationReads(f, [f.a, f.b]);
  const holders = [f.holdClosed(f.a), f.holdClosed(f.b)];
  try {
    const before = await f.json<{policy: AgentTaskPolicy}>('/api/agent/tasks/v2/policy'), policy = before.body.data!.policy, requestId = randomUUID();
    const input = {requestId, expectedRevision: policy.revision, stepLimit: policy.stepLimit + 1, modes: policy.modes};
    const saved = await f.json<{policy: AgentTaskPolicy}>('/api/agent/tasks/v2/policy', {method: 'PUT', input});
    assert.equal(saved.status, 200); assert.equal(saved.body.data!.policy.revision, policy.revision + 1);
    assert.deepEqual(await f.json('/api/agent/tasks/v2/policy', {method: 'PUT', input}), saved, 'exact application policy ACK replay needs no project');
    const receipt = await f.json(`/api/agent/tasks/v2/policy/requests/${requestId}`);
    assert.deepEqual(receipt.body.data, {found: true, policy: saved.body.data!.policy, readOnly: false});
    for (const [input, status, code] of [
      [{requestId: 'short', modes: policy.modes}, 400, 'AGENT_TASK_INVALID'],
      [{requestId: randomUUID(), expectedRevision: -1, stepLimit: policy.stepLimit, modes: policy.modes}, 409, 'AGENT_TASK_FAILED'],
      [{requestId: randomUUID(), expectedRevision: policy.revision, stepLimit: policy.stepLimit, modes: policy.modes}, 409, 'AGENT_TASK_REVISION_CONFLICT'],
    ] as const) {
      const denied = await f.json('/api/agent/tasks/v2/policy', {method: 'PUT', input});
      assert.equal(denied.status, status); assert.equal(denied.body.error!.code, code);
      assert.deepEqual((await f.json(`/api/agent/tasks/v2/policy/requests/${input.requestId}`)).body.data, {found: false, readOnly: false});
    }
    for (const raw of ['{', ' '.repeat(128 * 1024 + 1)]) {
      const denied = await f.fetch('/api/agent/tasks/v2/policy', {method: 'PUT', headers: {'content-type': 'application/json'}, body: raw});
      assert.equal(denied.status, 400); assert.equal((await denied.json() as WireBody<never>).error!.code, 'AGENT_TASK_INVALID');
    }
    assert.deepEqual((await f.json('/api/agent/tasks/v2/policy')).body.data, saved.body.data, 'invalid requests change neither policy nor its receipts');
    assert.ok(holders.every(db => db.isOpen));
  } finally {for (const db of holders) db.close();}
});

test('concurrent new project routes share one native connection per project and retain isolation, media and legacy refusals', async t => {
  const f = await fixture(t), seen = new Map<string, Set<DatabaseSync>>();
  await Promise.all([f.a, f.b].flatMap(project => Array.from({length: 8}, async () => {
    const result = await f.rpc<{project: {id: string}}>(project.projectId, 'project.get', {projectId: project.projectId});
    assert.equal(result.project.id, project.projectId);
    const db = f.native(project.projectId); assert.equal(db.isOpen, true);
    const instances = seen.get(project.projectId) ?? new Set<DatabaseSync>(); instances.add(db); seen.set(project.projectId, instances);
  })));
  assert.equal(seen.get(f.a.projectId)!.size, 1); assert.equal(seen.get(f.b.projectId)!.size, 1);
  assert.notEqual([...seen.get(f.a.projectId)!][0], [...seen.get(f.b.projectId)!][0]);
  for (const project of [f.a, f.b]) assert.throws(() => openProjectDatabase(project.root), {code: 'PROJECT_LOCKED'}, 'active host retains the full kernel lock');
  const missing = randomUUID(), unknown = await f.json(projectRpcPath(missing), {method: 'POST', input: {operation: 'project.get', input: {projectId: missing}}});
  assert.equal(unknown.status, 404); assert.deepEqual(unknown.body, {ok: false, error: {code: 'PROJECT_NOT_FOUND', message: '这个项目没有登记', details: {projectId: missing}, retryable: false}});
  const foreignRequestId=randomUUID();
  const foreign = await f.json(projectRpcPath(f.a.projectId), {method: 'POST', input: {operation: 'shot.update', input: {shotId: f.b.shotId, expectedRevision: f.b.shotRevision, requestId: foreignRequestId, patch: {title: 'Foreign update denied'}}}});
  assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, {ok: false, error: {code: 'NOT_FOUND', message: '找不到记录', details: {id: f.b.shotId,requestId:foreignRequestId,mutationOutcome:'not_applied'}, retryable: false}});
  const mismatch = await f.json(projectRpcPath(f.a.projectId), {method: 'POST', input: {operation: 'project.get', input: {projectId: f.b.projectId}}});
  assert.equal(mismatch.status, 400); assert.equal(mismatch.body.error!.code, 'PROJECT_ID_MISMATCH'); assert.deepEqual(mismatch.body.error!.details, {projectId: f.a.projectId});
  const media = projectMediaPath(f.a.projectId, f.a.assetId), full = await f.fetch(media);
  assert.equal(full.status, 200); assert.deepEqual(Buffer.from(await full.arrayBuffer()), syntheticPng);
  const head = await f.fetch(media, {method: 'HEAD'}); assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(Number(head.headers.get('content-length')), syntheticPng.length);
  const range = await f.fetch(media, {headers: {range: 'bytes=1-4'}}); assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 1-4/${syntheticPng.length}`); assert.deepEqual(Buffer.from(await range.arrayBuffer()), syntheticPng.subarray(1, 5));
  const oldRpc = await f.json('/api/rpc', {method: 'POST', input: {operation: 'project.get', input: {projectId: f.a.projectId}}});
  assert.equal(oldRpc.status, 400); assert.equal(oldRpc.body.error!.code, 'VALIDATION_ERROR');
  for (const route of [`/media/${f.a.assetId}`, `/api/local-drafts?projectId=${f.a.projectId}`, `/api/agent/tasks/v2/${f.a.projectId}`, `/api/timeline-audio-preview/unknown`]) {
    const response = await f.json(route); assert.equal(response.status, 404); assert.equal(response.body.error!.code, 'NOT_FOUND');
  }
  assert.equal(f.native(f.a.projectId), [...seen.get(f.a.projectId)!][0]); assert.equal(f.native(f.b.projectId), [...seen.get(f.b.projectId)!][0]);
});

test('application rename closes its original native host; global policy and cached covers never reopen it', async t => {
  const f = await fixture(t);
  await f.rpc(f.a.projectId, 'project.get', {projectId: f.a.projectId});
  await f.rpc(f.b.projectId, 'project.get', {projectId: f.b.projectId});
  const oldA = f.native(f.a.projectId), activeB = f.native(f.b.projectId);
  const input = {projectId: f.a.projectId, requestId: randomUUID(), expectedRevision: f.a.summary.revision, name: 'Renamed A'};
  const renamed = await f.rpc<{id: string; name: string; revision: number}>(null, 'project.rename', input);
  assert.equal(renamed.id, f.a.projectId); assert.equal(renamed.name, 'Renamed A'); assert.equal(renamed.revision, input.expectedRevision + 1);
  assert.equal(oldA.isOpen, false); assert.equal(activeB.isOpen, true);
  await assertClosedApplicationReads(f, [f.a]);
  assert.equal(oldA.isOpen, false); assert.equal(f.native(f.b.projectId), activeB);
  const holder = f.holdClosed(f.a);
  try {
    const listed = await f.rpc<{id: string; name: string}[]>(null, 'project.list'); assert.equal(listed.find(project => project.id === f.a.projectId)!.name, 'Renamed A');
    assert.equal(oldA.isOpen, false); assert.equal(holder.isOpen, true);
    const oldMedia = await f.json(`/media/${f.a.assetId}`); assert.equal(oldMedia.status, 404); assert.equal(oldA.isOpen, false);
  } finally {holder.close();}
  // Reopening is explicit: it creates a different native connection and reads
  // the renamed project, while B keeps its original live owner.
  const reopened = await f.rpc<{project: {name: string}}>(f.a.projectId, 'project.get', {projectId: f.a.projectId});
  assert.equal(reopened.project.name, 'Renamed A'); assert.notEqual(f.native(f.a.projectId), oldA); assert.equal(f.native(f.b.projectId), activeB);
});

test('home summaries and diagnostics use application state while close awaits moved-file discovery after native close', {timeout: 15_000}, async t => {
  const f = await fixture(t), timers = managerTimers(t);
  await f.rpc(f.a.projectId, 'project.get', {projectId: f.a.projectId});
  await waitForIdleTimer(timers);
  const native = f.native(f.a.projectId), prepare = native.prepare.bind(native);
  let closedReads = 0;
  t.mock.method(native, 'prepare', (sql: string) => {
    if (!native.isOpen) closedReads++;
    return prepare(sql);
  });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const opendir = promises.opendir.bind(promises);
  let waiting = false;
  const directoryRead = t.mock.method(promises, 'opendir', async (...args: Parameters<typeof promises.opendir>) => {
    if (!waiting && String(args[0]) === f.a.root && !native.isOpen) {
      waiting = true; entered.resolve(); await release.promise;
    }
    return opendir(...args);
  });
  syncBuiltinESMExports();
  const moved = path.join(f.a.root, 'moved.mioon');
  renameSync(f.a.projectFile, moved);
  const renamed = f.rpc<{name: string}>(null, 'project.rename', {projectId: f.a.projectId,
    expectedRevision: f.a.summary.revision, requestId: randomUUID(), name: 'After discovery'});
  void renamed.catch(() => {});
  try {
    await Promise.race([entered.promise, renamed.then(() => { throw new Error('Rename completed without awaiting moved-file discovery'); })]);
    assert.equal(native.isOpen, false, 'the real native connection closes before registry discovery awaits');
    const listed = await f.rpc<ProjectSummary[]>(null, 'project.summary.list');
    assert.equal(listed.length, 2);
    assert.equal(listed.find(project => project.id === f.a.projectId)!.name, f.a.summary.name,
      'a closing project retains its registered summary until discovery settles');
    const diagnostic = await f.json<{projectId: string; catalog: {valid: boolean}; storage?: unknown}>(`/api/agent/diagnostics?projectId=${f.a.projectId}`);
    assert.equal(diagnostic.status, 200);
    assert.equal(diagnostic.body.data!.projectId, f.a.projectId);
    assert.equal(diagnostic.body.data!.catalog.valid, true);
    assert.equal(diagnostic.body.data!.storage, undefined, 'closing projects use application diagnostics without acquiring a host');
    assert.equal(native.isOpen, false);
    assert.equal(closedReads, 0, 'neither request invokes a runtime whose database has closed');
  } finally {
    release.resolve(); directoryRead.mock.restore(); syncBuiltinESMExports();
    await renamed;
  }
  assert.equal((await f.rpc<ProjectSummary[]>(null, 'project.summary.list')).find(project => project.id === f.a.projectId)!.name, 'After discovery');
});

test('home summary refresh does not reset idle grace and diagnostic error paths release their request lease', {timeout: 15_000}, async t => {
  const f = await fixture(t), timers = managerTimers(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await f.rpc(f.a.projectId, 'project.get', {projectId: f.a.projectId});
  await waitForIdleTimer(timers);
  const initial = timers.grace.at(-1)!, count = timers.grace.length;
  now += 30_000;
  for (let index = 0; index < 3; index++) assert.equal((await f.rpc<ProjectSummary[]>(null, 'project.summary.list')).length, 2);
  assert.equal(timers.grace.length, count, 'home refresh takes no request lease or new idle timer');
  assert.equal(timers.grace.at(-1), initial);
  const invalid = await f.json(`/api/agent/diagnostics?projectId=${f.a.projectId}&unknown=1`);
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error!.code, 'AGENT_TASK_INVALID');
  assert.equal(timers.grace.length, count + 1, 'the admitted diagnostic lease is released even on a validation error');
  assert.equal(timers.grace.at(-1), now + 60_000);
  now += 10_000;
  const malformed = await f.json('/api/agent/diagnostics?projectId=bad');
  assert.equal(malformed.status, 400); assert.equal(malformed.body.error!.code, 'AGENT_TASK_INVALID');
  assert.equal(timers.grace.length, count + 1, 'invalid project IDs preserve the handler validation and never enter lease admission');
});

test('an open diagnostic keeps its real database alive across settings await and releases before exclusive close', {timeout: 15_000}, async t => {
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let gated = false;
  const f = await fixture(t, {agentSettings: {
    async get(options) {if (gated) {gated = false; entered.resolve(); await release.promise;} return settings.get(options);},
    put: (...args) => settings.put(...args), close: () => settings.close(),
  }});
  t.after(() => settings.close());
  const timers = managerTimers(t);
  await f.rpc(f.a.projectId, 'project.get', {projectId: f.a.projectId});
  await waitForIdleTimer(timers);
  const native = f.native(f.a.projectId);
  gated = true;
  const diagnostic = f.json<{storage: unknown}>(`/api/agent/diagnostics?projectId=${f.a.projectId}`);
  await entered.promise;
  let settled = false;
  const renamed = f.rpc(null, 'project.rename', {projectId: f.a.projectId, requestId: randomUUID(),
    expectedRevision: f.a.summary.revision, name: 'After diagnostic'}).finally(() => {settled = true;});
  void renamed.catch(() => {});
  try {
    await Promise.race([timers.drain, renamed.then(() => {throw new Error('Exclusive close skipped the live diagnostic request');})]);
    assert.equal(settled, false);
    assert.equal(native.isOpen, true, 'normal close drains the real diagnostic request before touching its database');
  } finally {release.resolve();}
  const response = await diagnostic;
  assert.equal(response.status, 200);
  assert.ok(response.body.data!.storage, 'the admitted open-host diagnostic reads its original live storage');
  await renamed;
  assert.equal(native.isOpen, false, 'finally released the lease, allowing the existing exclusive close to finish');
});

test('one open project summary failure still rejects the whole home list', async t => {
  const f = await fixture(t);
  await f.rpc(f.a.projectId, 'project.get', {projectId: f.a.projectId});
  await f.rpc(f.b.projectId, 'project.get', {projectId: f.b.projectId});
  const db = f.native(f.a.projectId), saved = db.prepare('SELECT data FROM shots WHERE id=?').get(f.a.shotId)!.data as string;
  db.prepare('UPDATE shots SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(saved), id: randomUUID()}), f.a.shotId);
  try {
    const result = await f.json('/api/rpc', {method: 'POST', input: {operation: 'project.summary.list', input: {}}});
    assert.equal(result.status, 409); assert.equal(result.body.error!.code, 'PROJECT_SUMMARY_UNAVAILABLE');
    assert.equal(result.body.data, undefined, 'another valid project is not returned as a partial successful list');
  } finally {db.prepare('UPDATE shots SET data=? WHERE id=?').run(saved, f.a.shotId);}
});
