import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer, IncomingMessage, ServerResponse} from 'node:http';
import {Socket} from 'node:net';
import {lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseProjectApiPath} from '../packages/contracts/src/project-file.ts';
import type {LocalDeliveryEnvelope} from '../packages/contracts/src/local-delivery.ts';
import type {LocalShotTextEnvelope} from '../packages/contracts/src/local-shot-text.ts';
import {openAppLibrary, isAppLibraryHeld, projectFileIdentity} from '../packages/business/src/app-db/index.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createProjectDraftsFactory} from '../apps/server/src/project-host/drafts.ts';
import {serverAppDirectories, projectLocation} from '../apps/server/src/project-host/directories.ts';
import type {ProjectHostContext} from '../apps/server/src/project-host/host.ts';
import {CONTENT_TABLES} from '../packages/business/src/project-file/schema/tables.ts';
import {createServerProject} from './helpers/project-database.ts';
import {composeApplicationRuntime} from '../apps/server/src/application-runtime.ts';
import {composeHostedProject} from '../apps/server/src/project-host/runtime.ts';
import {createProjectFiles} from '../apps/server/src/project-host/manager.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
interface Wire<Result> {ok: boolean; data?: Result; error?: {code: string}}

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-host-drafts-'));
  const {store, projectId} = createServerProject(root, {name: 'Draft owner'});
  const library = openAppLibrary({dataDir: root});
  const shutdown = new AbortController();
  const services = createServices(store, new Map(), {signal: shutdown.signal,
    application: createProjectServiceApplication(library, shutdown.signal, {})});
  let mutationChecks = 0, refuseWrites = false, dispatches = 0;
  let afterUpdate: (() => Promise<void>) | undefined;
  const releaseUpdates = new Set<() => void>();
  const context: ProjectHostContext = {projectId, store, directories: serverAppDirectories(root), signal: shutdown.signal,
    relocate: () => {throw new Error('The unchanged fixture must not relocate');}};
  const factory = createProjectDraftsFactory({store, channel: 'web', call: (operation, input) => services.call(operation, input),
    ownsApplicationLock: () => {
      const identity = projectFileIdentity(library.databaseFile);
      return identity !== null && isAppLibraryHeld(identity, library.db);
    },
    services: {
      assertMutationAllowed() {
        mutationChecks++;
        services.assertMutationAllowed();
        if (refuseWrites) throw new Error('Synthetic write admission rejection');
      },
      async updateShotInProject(id, input) {
        dispatches++;
        const result = await services.updateShotInProject(id, input);
        await afterUpdate?.();
        return result;
      },
    }});
  const port = factory(context);
  const activeResponses = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let responseClosed: (() => void) | undefined;
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = parseProjectApiPath(url.pathname);
    if (!route) {res.writeHead(404); res.end(); return;}
    res.once('close', () => responseClosed?.());
    const request = port.handle({req, res, url, route, signal: shutdown.signal}).then(handled => {
      if (!handled && !res.destroyed) {res.writeHead(404); res.end();}
    }).catch(error => {failures.push(error); res.destroy();}).finally(() => activeResponses.delete(request));
    activeResponses.add(request);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/projects/${projectId}`;
  const call = async <Result>(tail: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<{status: number; wire: Wire<Result>}> => {
    const response = await fetch(base + tail, {method, headers: {'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal});
    return {status: response.status, wire: await response.json() as Wire<Result>};
  };
  t.after(async () => {
    for (const release of releaseUpdates) release();
    afterUpdate = undefined;
    shutdown.abort();
    http.closeAllConnections();
    await port.drain();
    await Promise.all(activeResponses);
    await new Promise<void>(resolve => http.close(() => resolve()));
    await services.drain();
    store.close(); library.close();
    rmSync(root, {recursive: true, force: true});
    assert.deepEqual(failures, []);
  });
  return {root, projectId, store, library, services, shutdown, context, factory, port, base, call,
    mutationChecks: () => mutationChecks, refuseWrites: () => {refuseWrites = true;}, dispatches: () => dispatches,
    afterUpdate: (wait: () => Promise<void>, release: () => void) => {afterUpdate = wait; releaseUpdates.add(release);},
    responseClosed: (notify: () => void) => {responseClosed = notify;}};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const authority = (envelope: {workspaceScope: string; instanceId: string}) => ({workspaceScope: envelope.workspaceScope, instanceId: envelope.instanceId});
const contentSnapshot = (f: Fixture) => CONTENT_TABLES.map(table => [table, f.store.db.prepare(`SELECT * FROM project.${table} ORDER BY rowid`).all()]);
const projectMetadata = (f: Fixture) => f.store.db.prepare('SELECT * FROM project.project_file').get();

async function preparedShot(f: Fixture) {
  const shot = await f.services.call('shot.create', {projectId: f.projectId, title: 'Original'}) as {id: string; revision: number; title: string; prompt: string};
  const read = await f.call<LocalShotTextEnvelope>(`/local-shot-text?projectId=${f.projectId}&shotId=${shot.id}`);
  assert.equal(read.status, 200); const initial = read.wire.data!; assert.equal(initial.supported, true);
  if (!initial.supported) throw new Error('Expected a current project');
  const raw = {title: 'Saved draft', prompt: shot.prompt}, draftId = randomUUID();
  const saved = await f.call<LocalShotTextEnvelope>('/local-shot-text/draft', 'PUT', {...authority(initial),
    projectId: f.projectId, shotId: shot.id, expectedDraftRevision: 0, draftId,
    baseRevision: shot.revision, baseText: {title: shot.title, prompt: shot.prompt}, raw});
  assert.equal(saved.status, 200); const draft = saved.wire.data!; assert.equal(draft.supported, true);
  if (!draft.supported) throw new Error('Expected a saved draft');
  const intentId = randomUUID();
  const prepared = await f.call<LocalShotTextEnvelope>('/local-shot-text/prepare', 'POST', {...authority(draft), projectId: f.projectId, shotId: shot.id,
    expectedIntentRevision: 0, expectedIntentId: null, intentId, baseRevision: shot.revision, baseText: {title: shot.title, prompt: shot.prompt},
    draft: {draftId, revision: draft.draftRevision, raw},
    input: {requestId: randomUUID(), shotId: shot.id, expectedRevision: shot.revision, patch: {title: raw.title}}});
  assert.equal(prepared.status, 200); const envelope = prepared.wire.data!; assert.equal(envelope.supported, true);
  if (!envelope.supported) throw new Error('Expected a prepared intent');
  return {shot, envelope, input: {...authority(envelope), projectId: f.projectId, shotId: shot.id, intentId, expectedIntentRevision: envelope.intentRevision}};
}

test('draft factory binds one port to the exact live host without writing on construction', async t => {
  const f = await fixture(t), changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.equal(f.factory(f.context), f.port);
  assert.throws(() => f.factory({...f.context}), /another host context/);
  assert.throws(() => f.factory({...f.context, store: {...f.store}}), {code: 'PROJECT_STORE_UNVERIFIED'});
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(f.port.isBusy(), false);
  assert.equal(f.mutationChecks(), 0);
  assert.equal(f.dispatches(), 0);
});

test('passive draft reads ignore retired JSON and create neither scope state nor business changes', async t => {
  const f = await fixture(t);
  const files = ['local-drafts-v1.json', 'local-delivery-v1.json', 'local-shot-text-v1.json'].map((name, index) => {
    const file = path.join(f.store.localDir, name), bytes = Buffer.from(index === 0 ? '{bad json' : JSON.stringify({version: 999, pending: 'must not run'}));
    writeFileSync(file, bytes, {mode: 0o600}); return {file, bytes};
  });
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const before = contentSnapshot(f), metadata = projectMetadata(f), info = lstatSync(f.store.projectFile);
  assert.equal((await f.call(`/local-drafts?projectId=${f.projectId}`)).status, 200);
  assert.equal((await f.call(`/local-delivery?projectId=${f.projectId}`)).status, 200);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM main.local_draft_states').all(), []);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.deepEqual(contentSnapshot(f), before); assert.deepEqual(projectMetadata(f), metadata);
  assert.equal(lstatSync(f.store.projectFile).mtimeMs, info.mtimeMs);
  for (const {file, bytes} of files) assert.deepEqual(readFileSync(file), bytes);
  assert.equal(f.mutationChecks(), 0); assert.equal(f.dispatches(), 0); assert.equal(f.port.isBusy(), false);
});

test('pure local saves use application write admission and change only their history slot', async t => {
  const f = await fixture(t);
  const timeline = await f.services.call('timeline.get', {projectId: f.projectId}) as {id: string; revision: number};
  const read = await f.call<LocalDeliveryEnvelope>(`/local-delivery?projectId=${f.projectId}`);
  assert.equal(read.status, 200); const envelope = read.wire.data!; assert.equal(envelope.supported, true);
  if (!envelope.supported) throw new Error('Expected a current project');
  const before = contentSnapshot(f), metadata = projectMetadata(f), info = lstatSync(f.store.projectFile);
  const saved = await f.call<LocalDeliveryEnvelope>('/local-delivery/draft', 'PUT', {...authority(envelope), projectId: f.projectId,
    expectedDraftRevision: 0, draftId: randomUUID(), timelineId: timeline.id, baseRevision: timeline.revision, raw: {deliveryName: 'Unsaved local name'}});
  assert.equal(saved.status, 200); assert.equal(f.mutationChecks(), 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM main.local_delivery_drafts').get()!.n, 1);
  assert.deepEqual(contentSnapshot(f), before); assert.deepEqual(projectMetadata(f), metadata);
  assert.equal(lstatSync(f.store.projectFile).mtimeMs, info.mtimeMs);
  assert.equal(f.dispatches(), 0);
  f.refuseWrites();
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const rejected = await f.call('/local-delivery/draft', 'DELETE', {...authority(envelope), projectId: f.projectId,
    expectedDraftRevision: 1, draftId: saved.wire.data && saved.wire.data.supported ? saved.wire.data.draft!.draftId : randomUUID()});
  assert.equal(rejected.status, 503); assert.equal(rejected.wire.error?.code, 'LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal((await f.call(`/local-delivery?projectId=${f.projectId}`)).status, 200);
  assert.equal(f.mutationChecks(), 2);
});

test('stored pending intent is idle and closing never executes it or accepts a new write', async t => {
  const f = await fixture(t), {envelope} = await preparedShot(f);
  assert.equal(envelope.intent?.outcome.status, 'pending'); assert.equal(f.port.isBusy(), false); assert.equal(f.dispatches(), 0);
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  await f.port.drain(); await f.port.drain();
  assert.equal(f.store.db.isOpen, true, 'the port borrows the connection and never closes it');
  assert.equal(f.port.isBusy(), false);
  const rejected = await f.call(`/local-shot-text?projectId=${f.projectId}&shotId=${envelope.shotId}`);
  assert.equal(rejected.status, 503); assert.equal(rejected.wire.error?.code, 'LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(f.dispatches(), 0);
});

test('a drained port rejects late requests without reading body, calling guards or touching SQL', async t => {
  const f = await fixture(t); await f.port.drain();
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const beforeChecks = f.mutationChecks();
  for (const [tail, code] of [['local-drafts/clip', 'LOCAL_DRAFT_STORAGE_UNAVAILABLE'],
    ['local-delivery/draft', 'LOCAL_DELIVERY_STORAGE_UNAVAILABLE'], ['local-shot-text/execute', 'LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE']] as const) {
    const pathname = `/api/projects/${f.projectId}/${tail}`, route = parseProjectApiPath(pathname); assert.ok(route);
    const socket = new Socket(), req = new IncomingMessage(socket), res = new ServerResponse(req);
    req.method = 'POST'; req.url = pathname;
    t.mock.method(req, 'iterator', () => {assert.fail('A closed port cannot inspect an incoming body');});
    const head = t.mock.method(res, 'writeHead'), end = t.mock.method(res, 'end');
    try {
      assert.equal(await f.port.handle({req, res, url: new URL(pathname, 'http://127.0.0.1'), route, signal: f.shutdown.signal}), true);
      assert.equal(res.statusCode, 503);
      assert.equal((head.mock.calls[0]!.arguments[1] as Record<string, string>)['Cache-Control'], 'no-store');
      const reply = JSON.parse(String(end.mock.calls[0]!.arguments[0])) as {ok: boolean; error: {code: string; retryable: boolean; details: unknown}};
      assert.equal(reply.ok, false); assert.equal(reply.error.code, code); assert.equal(reply.error.retryable, false); assert.deepEqual(reply.error.details, {});
      assert.equal(f.port.isBusy(), false);
    } finally {res.emit('close'); socket.destroy();}
  }
  assert.equal(f.mutationChecks(), beforeChecks); assert.equal(f.dispatches(), 0);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
});

test('response disconnect does not release a draft flight and drain joins the terminal continuation', async t => {
  const f = await fixture(t), prepared = await preparedShot(f);
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), disconnected = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  f.afterUpdate(async () => {entered.resolve(); await gate.promise;}, () => gate.resolve());
  f.responseClosed(() => disconnected.resolve());
  const abort = new AbortController();
  const executing = f.call('/local-shot-text/execute', 'POST', prepared.input, abort.signal);
  const rejected = assert.rejects(executing, {name: 'AbortError'});
  await entered.promise;
  assert.equal(f.services.isBusy(), false, 'the real business service has already completed');
  assert.equal(f.dispatches(), 1); assert.equal(f.port.isBusy(), true);
  abort.abort(); await rejected; await disconnected.promise;
  assert.equal(f.port.isBusy(), true, 'response close is not terminal persistence');
  let drained = false;
  const draining = f.port.drain().then(() => {drained = true;});
  await tick(); assert.equal(drained, false); assert.equal(f.store.db.isOpen, true);
  gate.resolve(); await draining;
  assert.equal(f.port.isBusy(), false); assert.equal(f.dispatches(), 1);
  const row = f.store.db.prepare('SELECT data FROM main.local_shot_text_drafts WHERE shotId=?').get(prepared.shot.id)!;
  const retained = JSON.parse(String(row.data)) as {intent: {outcome: {status: string}}};
  assert.equal(retained.intent.outcome.status, 'pending', 'close does not publish a late terminal result after owner cancellation');
  assert.equal((f.store.get('shots', prepared.shot.id) as {title: string}).title, 'Saved draft', 'the real committed business update is retained for explicit recovery');
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  await tick(); assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes, 'successful drain leaves no late SQL');
});

test('a hosted draft continuation blocks idle and the independent version-restore gate after response close', async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-host-draft-restore-'));
  const library = openAppLibrary({dataDir: root}), owner = new AbortController();
  const directories = serverAppDirectories(root);
  const entry = createProjectFiles({name: 'Hosted draft restore'}, {directories, registry: library.registry, identity: library.projectFileIdentity});
  const {projectId} = entry, store = openProjectStore({projectFile: entry.projectFile, locate: id => projectLocation(directories, id)});
  const context: ProjectHostContext = {projectId, store, directories, signal: owner.signal,
    relocate: () => {throw new Error('The unchanged fixture must not relocate');}};
  const options = {port: 0, comfyModule: 'skip' as const};
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let app: Awaited<ReturnType<typeof composeApplicationRuntime>> | undefined;
  let runtime: Awaited<ReturnType<typeof composeHostedProject>> | undefined;
  try {
    app = await composeApplicationRuntime(library, options, owner.signal, () => undefined);
    const host = runtime = await composeHostedProject(context, library, app, options, () => undefined, () => 4318);
    const start = (tail: string, method: string, input: unknown) => {
      const pathname = `/api/projects/${projectId}${tail}`, url = new URL(pathname, 'http://127.0.0.1:4318'), route = parseProjectApiPath(url.pathname); assert.ok(route);
      const socket = new Socket(), req = new IncomingMessage(socket), res = new ServerResponse(req);
      req.method = method; req.url = pathname; req.headers['content-type'] = 'application/json';
      req.push(Buffer.from(JSON.stringify(input))); req.push(null);
      const end = t.mock.method(res, 'end');
      const promise = host.handle({req, res, url, route, signal: owner.signal});
      return {res, end, promise, close: () => {res.emit('close'); socket.destroy();}};
    };
    const json = async <Result>(tail: string, method: string, input: unknown): Promise<Result> => {
      const request = start(tail, method, input);
      try {
        assert.equal(await request.promise, true); assert.equal(request.res.statusCode, 200);
        assert.equal(request.end.mock.callCount(), 1);
        const reply = JSON.parse(String(request.end.mock.calls[0]!.arguments[0])) as {ok: boolean; data: Result};
        assert.equal(reply.ok, true); return reply.data;
      } finally {request.close();}
    };
    const rpc = <Result>(operation: string, input: unknown) => json<Result>('/rpc', 'POST', {operation, input});
    const saved = await rpc<{version: {id: string}}>('project.version.save', {projectId, requestId: randomUUID()});
    const shot = await host.project.services.call('shot.create', {projectId, title: 'Original', prompt: ''}) as {id: string; revision: number; title: string; prompt: string};
    const drafts = host.project.draftsFactory(context);
    const first = start(`/local-shot-text?projectId=${projectId}&shotId=${shot.id}`, 'GET', null);
    let initial: Extract<LocalShotTextEnvelope, {supported: true}>;
    try {
      await first.promise; assert.equal(first.res.statusCode, 200);
      initial = (JSON.parse(String(first.end.mock.calls[0]!.arguments[0])) as {data: typeof initial}).data;
      assert.equal(initial.supported, true);
    } finally {first.close();}
    const raw = {title: 'Saved draft', prompt: shot.prompt}, draftId = randomUUID();
    const draft = await json<Extract<LocalShotTextEnvelope, {supported: true}>>('/local-shot-text/draft', 'PUT', {...authority(initial!),
      projectId, shotId: shot.id, expectedDraftRevision: 0, draftId, baseRevision: shot.revision,
      baseText: {title: shot.title, prompt: shot.prompt}, raw});
    const intentId = randomUUID();
    const prepared = await json<Extract<LocalShotTextEnvelope, {supported: true}>>('/local-shot-text/prepare', 'POST', {...authority(draft),
      projectId, shotId: shot.id, expectedIntentRevision: 0, expectedIntentId: null, intentId, baseRevision: shot.revision,
      baseText: {title: shot.title, prompt: shot.prompt}, draft: {draftId, revision: draft.draftRevision, raw},
      input: {requestId: randomUUID(), shotId: shot.id, expectedRevision: shot.revision, patch: {title: raw.title}}});
    const original = host.project.services.updateShotInProject.bind(host.project.services);
    t.mock.method(host.project.services, 'updateShotInProject', async (id: Parameters<typeof original>[0], input: Parameters<typeof original>[1]) => {
      const result = await original(id, input); entered.resolve(); await gate.promise; return result;
    });
    const pending = start('/local-shot-text/execute', 'POST', {...authority(prepared), projectId, shotId: shot.id, intentId,
      expectedIntentRevision: prepared.intentRevision});
    await entered.promise; pending.close();
    assert.equal(host.project.services.isBusy(), false); assert.equal(drafts.isBusy(), true); assert.equal(host.isBusy(), true);
    const preview = await rpc<{contentSequence: number; contentToken: string; previewDigest: string}>('project.version.preview', {projectId, versionId: saved.version.id});
    const before = store.db.prepare('SELECT total_changes() AS n').get()!.n;
    await assert.rejects(rpc('project.version.restore', {projectId, versionId: saved.version.id, requestId: randomUUID(),
      expectedContentSequence: preview.contentSequence, expectedContentToken: preview.contentToken, previewDigest: preview.previewDigest}), {code: 'PROJECT_HOST_BUSY', status: 409});
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
    gate.resolve(); await pending.promise;
    assert.equal(drafts.isBusy(), false);
  } finally {
    gate.resolve(); owner.abort(); runtime?.interrupt();
    await runtime?.drain(); runtime?.dispose(); await app?.close(); store.close(); library.close();
    rmSync(root, {recursive: true, force: true});
  }
});

async function relocationFixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-host-draft-relocate-'));
  const library = openAppLibrary({dataDir: root}), directories = serverAppDirectories(root);
  const entry = createProjectFiles({name: 'Draft relocation'}, {directories, registry: library.registry, identity: library.projectFileIdentity});
  const {projectId} = entry, options = {port: 0, comfyModule: 'skip' as const};
  let store: ReturnType<typeof openProjectStore>, owner: AbortController;
  let app: Awaited<ReturnType<typeof composeApplicationRuntime>>, host: Awaited<ReturnType<typeof composeHostedProject>>;
  let closed = true, relocations = 0;
  const open = async () => {
    store = openProjectStore({projectFile: entry.projectFile, locate: id => projectLocation(directories, id)});
    const currentOwner = owner = new AbortController();
    app = await composeApplicationRuntime(library, options, currentOwner.signal, () => undefined);
    host = await composeHostedProject({projectId, store, directories, signal: currentOwner.signal,
      relocate() {relocations++; currentOwner.abort();}}, library, app, options, () => undefined, () => 4318);
    // These tests concern the fixed draft callback and its original receipt,
    // not the later export worker. Keep that independent real worker stopped.
    await host.project.startWorker().stop();
    closed = false;
  };
  const close = async () => {
    if (closed) return;
    owner.abort(); host.interrupt(); await host.drain(); host.dispose(); await app.close(); store.close(); closed = true;
  };
  t.after(async () => {await close(); library.close(); rmSync(root, {recursive: true, force: true});});
  await open();
  const wire = async <Result>(tail: string, method = 'GET', body?: unknown) => {
    const pathname = `/api/projects/${projectId}${tail}`, url = new URL(pathname, 'http://127.0.0.1:4318');
    const route = parseProjectApiPath(url.pathname); assert.ok(route);
    const socket = new Socket(), req = new IncomingMessage(socket), res = new ServerResponse(req);
    req.method = method; req.url = pathname; req.headers['content-type'] = 'application/json';
    if (body !== undefined) req.push(Buffer.from(JSON.stringify(body)));
    req.push(null); const end = t.mock.method(res, 'end');
    try {
      assert.equal(await host.handle({req, res, url, route, signal: owner.signal}), true);
      assert.equal(end.mock.callCount(), 1);
      return {status: res.statusCode, wire: JSON.parse(String(end.mock.calls[0]!.arguments[0])) as Wire<Result>};
    } finally {res.emit('close'); socket.destroy();}
  };
  const json = async <Result>(tail: string, method = 'GET', body?: unknown): Promise<Result> => {
    const result = await wire<Result>(tail, method, body); assert.equal(result.status, 200); assert.equal(result.wire.ok, true);
    return result.wire.data!;
  };
  return {projectId, wire, json, get store() {return store;}, get host() {return host;}, relocations: () => relocations,
    reopen: async () => {await close(); await open();}};
}

for (const kind of ['delivery', 'shot-text'] as const) test(`hosted ${kind} moves on its fixed callback failure and recovers the original receipt without redispatch`, async t => {
  const f = await relocationFixture(t), {projectId} = f;
  type Envelope = Extract<LocalDeliveryEnvelope | LocalShotTextEnvelope, {supported: true}>;
  let prepared: Envelope, key: {projectId: string; shotId?: string}, route: string, dispatched = 0, originalResponse: unknown;
  const secret = 'private-fixed-business-moved-marker';
  const moved = kind === 'delivery' ? Object.assign(new Error(secret), {errcode: 1032}) : Object.assign(new Error(secret), {code: 'PROJECT_FILE_MOVED'});
  if (kind === 'delivery') {
    const asset = await f.host.project.services.call('asset.import', {projectId, name: 'Synthetic PNG', mimeType: 'image/png',
      dataBase64: (await renderMockImagePng()).toString('base64')}) as {id: string};
    const timeline = await f.host.project.services.call('timeline.get', {projectId}) as {id: string; revision: number; tracks: {id: string}[]};
    const linked = await f.host.project.services.call('timeline.clip.add', {projectId, expectedRevision: timeline.revision, requestId: randomUUID(),
      assetId: asset.id, trackId: timeline.tracks[0]!.id, startFrame: 0, durationFrames: 30}) as {id: string; revision: number};
    route = '/local-delivery'; key = {projectId};
    const initial = await f.json<Extract<LocalDeliveryEnvelope, {supported: true}>>(`${route}?projectId=${projectId}`), draftId = randomUUID(), raw = {deliveryName: 'Original pending export'};
    const draft = await f.json<Extract<LocalDeliveryEnvelope, {supported: true}>>(`${route}/draft`, 'PUT', {...authority(initial), projectId,
      expectedDraftRevision: 0, draftId, timelineId: linked.id, baseRevision: linked.revision, raw});
    prepared = await f.json<Extract<LocalDeliveryEnvelope, {supported: true}>>(`${route}/prepare`, 'POST', {...authority(draft), projectId,
      expectedIntentRevision: 0, expectedIntentId: null, intentId: randomUUID(), timelineId: linked.id, baseRevision: linked.revision,
      draft: {draftId, revision: draft.draftRevision, raw}, input: {projectId, expectedRevision: linked.revision, requestId: randomUUID(), purpose: 'export', deliveryName: raw.deliveryName}});
    const call = f.host.project.services.call.bind(f.host.project.services);
    t.mock.method(f.host.project.services, 'call', async (operation: Parameters<typeof call>[0], input: Parameters<typeof call>[1], context?: Parameters<typeof call>[2]) => {
      if (operation === 'timeline.render') dispatched++;
      const response = await call(operation, input, context);
      if (operation !== 'timeline.render') return response;
      originalResponse = JSON.parse(JSON.stringify(response)) as unknown;
      throw moved;
    });
  } else {
    const shot = await f.host.project.services.call('shot.create', {projectId, title: 'Original', prompt: 'Preserved baseline'}) as {id: string; title: string; prompt: string; revision: number};
    route = '/local-shot-text'; key = {projectId, shotId: shot.id};
    const initial = await f.json<Extract<LocalShotTextEnvelope, {supported: true}>>(`${route}?projectId=${projectId}&shotId=${shot.id}`), draftId = randomUUID(), raw = {title: 'Pending title', prompt: shot.prompt};
    const draft = await f.json<Extract<LocalShotTextEnvelope, {supported: true}>>(`${route}/draft`, 'PUT', {...authority(initial), ...key,
      expectedDraftRevision: 0, draftId, baseRevision: shot.revision, baseText: {title: shot.title, prompt: shot.prompt}, raw});
    prepared = await f.json<Extract<LocalShotTextEnvelope, {supported: true}>>(`${route}/prepare`, 'POST', {...authority(draft), ...key,
      expectedIntentRevision: 0, expectedIntentId: null, intentId: randomUUID(), baseRevision: shot.revision, baseText: {title: shot.title, prompt: shot.prompt},
      draft: {draftId, revision: draft.draftRevision, raw}, input: {requestId: randomUUID(), shotId: shot.id, expectedRevision: shot.revision, patch: {title: raw.title}}});
    const update = f.host.project.services.updateShotInProject.bind(f.host.project.services);
    t.mock.method(f.host.project.services, 'updateShotInProject', async (id: Parameters<typeof update>[0], input: Parameters<typeof update>[1]) => {
      dispatched++; const response = await update(id, input); originalResponse = JSON.parse(JSON.stringify(response)) as unknown; throw moved;
    });
  }
  assert.ok(prepared.intent); const frozenInput = structuredClone(prepared.intent.input);
  const table = kind === 'delivery' ? 'local_delivery_drafts' : 'local_shot_text_drafts';
  const pendingBytes = f.store.db.prepare(`SELECT data FROM main.${table} ORDER BY ordinal`).get()!.data;
  const execute = {...authority(prepared), ...key, intentId: prepared.intent.intentId, expectedIntentRevision: prepared.intentRevision};
  const failed = await f.wire(`${route}/execute`, 'POST', execute);
  assert.equal(failed.status, 503); assert.equal(failed.wire.error?.code, kind === 'delivery' ? 'LOCAL_DELIVERY_STORAGE_UNAVAILABLE' : 'LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
  assert.equal(JSON.stringify(failed.wire).includes(secret), false); assert.equal(f.relocations(), 1); assert.equal(dispatched, 1); assert.ok(originalResponse);
  assert.equal(f.store.db.prepare(`SELECT data FROM main.${table} ORDER BY ordinal`).get()!.data, pendingBytes, 'moved failure cannot forge not_applied or a terminal draft ACK');
  await f.reopen();
  let redispatched = 0;
  if (kind === 'delivery') {
    const call = f.host.project.services.call.bind(f.host.project.services);
    t.mock.method(f.host.project.services, 'call', async (operation: Parameters<typeof call>[0], input: Parameters<typeof call>[1], context?: Parameters<typeof call>[2]) => {
      if (operation === 'timeline.render') {redispatched++; assert.fail('The original durable render receipt must prevent redispatch');}
      return call(operation, input, context);
    });
  } else t.mock.method(f.host.project.services, 'updateShotInProject', async () => {redispatched++; assert.fail('The original durable shot receipt must prevent redispatch');});
  const current = await f.json<Envelope>(`${route}?projectId=${projectId}${key.shotId ? '&shotId=' + key.shotId : ''}`);
  assert.notEqual(current.instanceId, prepared.instanceId); assert.equal(current.intent?.outcome.status, 'pending');
  assert.deepEqual(current.intent?.input, frozenInput); assert.equal(redispatched, 0);
  const stale = await f.wire(`${route}/execute`, 'POST', execute);
  assert.equal(stale.status, 409); assert.equal(stale.wire.error?.code, kind === 'delivery' ? 'LOCAL_DELIVERY_STALE_INSTANCE' : 'LOCAL_SHOT_TEXT_STALE_INSTANCE');
  const recovered = await f.json<{envelope: Envelope; response: unknown}>(`${route}/recover`, 'POST', {...authority(current), ...key,
    intentId: current.intent!.intentId, expectedIntentRevision: current.intentRevision});
  assert.equal(recovered.envelope.intent?.outcome.status, kind === 'delivery' ? 'accepted' : 'applied');
  assert.deepEqual(recovered.response, originalResponse); assert.deepEqual(recovered.envelope.intent?.input, frozenInput);
  const terminalBytes = f.store.db.prepare(`SELECT data FROM main.${table} ORDER BY ordinal`).get()!.data;
  const repeated = await f.json<{envelope: Envelope; response: unknown}>(`${route}/recover`, 'POST', {...authority(recovered.envelope), ...key,
    intentId: recovered.envelope.intent!.intentId, expectedIntentRevision: recovered.envelope.intentRevision});
  assert.deepEqual(repeated, recovered); assert.equal(f.relocations(), 1); assert.equal(dispatched, 1); assert.equal(redispatched, 0);
  assert.equal(f.store.db.prepare(`SELECT data FROM main.${table} ORDER BY ordinal`).get()!.data, terminalBytes);
});
