import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs, {lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {IncomingMessage, ServerResponse} from 'node:http';
import {Socket} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectHostManager} from '../apps/server/src/project-host/manager.ts';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {composeHostedProject} from '../apps/server/src/project-host/runtime.ts';
import type {HostedProject} from '../apps/server/src/project-host/runtime.ts';
import {composeApplicationRuntime} from '../apps/server/src/application-runtime.ts';
import {startServer} from './helpers/test-server.ts';
import type {InspectProject} from '../apps/server/src/index.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {isProjectFileHeld} from '../packages/business/src/project-file/held-files.ts';
import {DRAFT_TABLES} from '../packages/business/src/project-file/schema/domains/drafts.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import {parseProjectApiPath} from '../packages/contracts/src/project-file.ts';
import type {ClipDraftEnvelope} from '../packages/contracts/src/local-drafts.ts';
import type {LocalDeliveryEnvelope} from '../packages/contracts/src/local-delivery.ts';
import type {LocalShotTextEnvelope} from '../packages/contracts/src/local-shot-text.ts';
import type {ProjectHistoryStatus, ProjectHistoryResolveInput, ProjectHistoryResolveResult} from '../packages/contracts/src/project-history-recovery.ts';

type ClipEnvelope = Extract<ClipDraftEnvelope, {supported: true}>;
type DeliveryEnvelope = Extract<LocalDeliveryEnvelope, {supported: true}>;
type ShotEnvelope = Extract<LocalShotTextEnvelope, {supported: true}>;
const authority = (value: {workspaceScope: string; instanceId: string}) => ({workspaceScope: value.workspaceScope, instanceId: value.instanceId});
const draftSnapshot = (db: DatabaseSync) => Object.fromEntries(DRAFT_TABLES.map(table => [table, db.prepare(`SELECT rowid,* FROM main.${table} ORDER BY rowid`).all()]));
const draftBytes = (db: DatabaseSync) => JSON.stringify(draftSnapshot(db));
const emptyDrafts = () => Object.fromEntries(DRAFT_TABLES.map(table => [table, []]));
const confirmation = (status: ProjectHistoryStatus, action: 'continue' | 'restore-version', versionId: string, previewDigest: string): ProjectHistoryResolveInput => {
  const shared = {projectId: status.projectId, requestId: randomUUID(), expected: status.file,
    historyIdentity: status.historyIdentity, confirmationDigest: status.confirmationDigest};
  return action === 'continue' ? {...shared, action} : {...shared, action, versionId, previewDigest};
};

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-drafts-history-switch-'));
  const library = openAppLibrary({dataDir: root}), owner = new AbortController(), directories = serverAppDirectories(root);
  const application = createProjectServiceApplication(library, owner.signal, {});
  const options = {port: 0, comfyModule: 'skip' as const};
  const app = await composeApplicationRuntime(library, options, owner.signal, () => undefined);
  const normal: {context: Parameters<typeof composeHostedProject>[0]; runtime: HostedProject}[] = [];
  const ports = new Set<object>(), dispatches: {operation: string; input: unknown}[] = [];
  const manager = createProjectHostManager<HostedProject>({directories, registry: library.registry, identity: library.projectFileIdentity,
    assertMutationAllowed: application.assertMutationAllowed,
    factory: async context => {
      const runtime = await composeHostedProject(context, library, app, options, () => undefined, () => 4318);
      const port = runtime.project.draftsFactory(context);
      assert.equal(runtime.project.draftsFactory(context), port, 'a normal host owns one memoized drafts port');
      ports.add(port); normal.push({context, runtime});
      const call = runtime.project.services.call.bind(runtime.project.services);
      t.mock.method(runtime.project.services, 'call', async (operation: Parameters<typeof call>[0], input: Parameters<typeof call>[1], context?: Parameters<typeof call>[2]) => {
        if (operation === 'timeline.render') dispatches.push({operation, input: structuredClone(input)});
        return call(operation, input, context);
      });
      const update = runtime.project.services.updateShotInProject.bind(runtime.project.services);
      t.mock.method(runtime.project.services, 'updateShotInProject', async (projectId: Parameters<typeof update>[0], input: Parameters<typeof update>[1]) => {
        dispatches.push({operation: 'shot.update', input: structuredClone(input)}); return update(projectId, input);
      });
      return runtime;
    }});
  const externalClosers: (() => Promise<void> | void)[] = [];
  let frameworkClosed = false;
  const closeFramework = async () => {
    if (frameworkClosed) return;
    await manager.closeAll(); owner.abort(); await app.close(); library.close(); frameworkClosed = true;
  };
  t.after(async () => {
    for (const close of externalClosers) await close();
    await closeFramework(); rmSync(root, {recursive: true, force: true});
  });
  const registration = await manager.create({name: 'Original'}), projectId = registration.projectId;
  const request = async <Result>(tail: string, method = 'GET', body?: unknown): Promise<Result> => {
    const lease = await manager.acquire(projectId, 'request');
    try {
      const runtime = lease.host.runtime;
      const pathname = `/api/projects/${projectId}${tail}`, url = new URL(pathname, 'http://127.0.0.1:4318');
      const route = parseProjectApiPath(url.pathname); assert.ok(route);
      const socket = new Socket(), req = new IncomingMessage(socket), res = new ServerResponse(req);
      req.method = method; req.url = pathname; req.headers['content-type'] = 'application/json';
      if (body !== undefined) req.push(Buffer.from(JSON.stringify(body)));
      req.push(null); const end = t.mock.method(res, 'end');
      try {
        assert.equal(await runtime.handle({req, res, url, route, signal: lease.signal}), true);
        assert.equal(res.statusCode, 200); assert.equal(end.mock.callCount(), 1);
        const reply = JSON.parse(String(end.mock.calls[0]!.arguments[0])) as {ok: boolean; data: Result};
        assert.equal(reply.ok, true); return reply.data;
      } finally {res.emit('close'); socket.destroy();}
    } finally {lease.release();}
  };
  const initial = await manager.acquire(projectId, 'window'), store = initial.host.store, runtime = initial.host.runtime;
  const asset = await runtime.project.services.call('asset.import', {projectId, name: 'Synthetic PNG', mimeType: 'image/png',
    dataBase64: (await renderMockImagePng()).toString('base64')}) as {id: string; sha256: string};
  const firstTimeline = await runtime.project.services.call('timeline.get', {projectId}) as {id: string; revision: number; tracks: {id: string}[]};
  const timeline = await runtime.project.services.call('timeline.clip.add', {projectId, expectedRevision: firstTimeline.revision, requestId: randomUUID(),
    assetId: asset.id, trackId: firstTimeline.tracks[0]!.id, startFrame: 0, durationFrames: 30}) as {id: string; revision: number; clips: {id: string; trackId: string; rect: {x: number; y: number; width: number; height: number}}[]};
  const shot = await runtime.project.services.call('shot.create', {projectId, title: 'Original shot', prompt: 'Original prompt'}) as {id: string; revision: number; title: string; prompt: string};
  const clip = timeline.clips[0]!, key = {projectId, timelineId: timeline.id, clipId: clip.id};
  const firstClip = await request<ClipEnvelope>(`/local-drafts/clip?projectId=${projectId}&timelineId=${timeline.id}&clipId=${clip.id}`);
  const clipInput = {...authority(firstClip), ...key, expectedRevision: 0, baseRevision: timeline.revision,
    source: {assetId: asset.id, assetSha256: asset.sha256}, raw: {name: '待恢复剪辑 🎬', trackId: clip.trackId,
      startFrame: '0e', durationFrames: '30', sourceInFrame: '0', rect: clip.rect, gain: '1.'}};
  const savedClip = await request<ClipEnvelope>('/local-drafts/clip', 'PUT', clipInput);
  const firstDelivery = await request<DeliveryEnvelope>(`/local-delivery?projectId=${projectId}`), deliveryId = randomUUID(), deliveryRaw = {deliveryName: '待恢复导出 🎬'};
  const deliveryDraft = await request<DeliveryEnvelope>('/local-delivery/draft', 'PUT', {...authority(firstDelivery), projectId,
    expectedDraftRevision: 0, draftId: deliveryId, timelineId: timeline.id, baseRevision: timeline.revision, raw: deliveryRaw});
  const savedDelivery = await request<DeliveryEnvelope>('/local-delivery/prepare', 'POST', {...authority(deliveryDraft), projectId,
    expectedIntentRevision: 0, expectedIntentId: null, intentId: randomUUID(), timelineId: timeline.id, baseRevision: timeline.revision,
    draft: {draftId: deliveryId, revision: deliveryDraft.draftRevision, raw: deliveryRaw},
    input: {projectId, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export', deliveryName: deliveryRaw.deliveryName}});
  const firstShot = await request<ShotEnvelope>(`/local-shot-text?projectId=${projectId}&shotId=${shot.id}`), shotDraftId = randomUUID(), raw = {title: '待恢复标题 🎬', prompt: '原始文字\n不自动提交'};
  const shotDraft = await request<ShotEnvelope>('/local-shot-text/draft', 'PUT', {...authority(firstShot), projectId, shotId: shot.id,
    expectedDraftRevision: 0, draftId: shotDraftId, baseRevision: shot.revision, baseText: {title: shot.title, prompt: shot.prompt}, raw});
  const savedShot = await request<ShotEnvelope>('/local-shot-text/prepare', 'POST', {...authority(shotDraft), projectId, shotId: shot.id,
    expectedIntentRevision: 0, expectedIntentId: null, intentId: randomUUID(), baseRevision: shot.revision, baseText: {title: shot.title, prompt: shot.prompt},
    draft: {draftId: shotDraftId, revision: shotDraft.draftRevision, raw},
    input: {requestId: randomUUID(), shotId: shot.id, expectedRevision: shot.revision, patch: raw}});
  const savedVersion = createProjectVersions(store, {assertMutationAllowed: application.assertMutationAllowed}).save({projectId, requestId: randomUUID(), name: 'Before external content'}).version;
  assert.equal(savedDelivery.intent?.outcome.status, 'pending'); assert.equal(savedShot.intent?.outcome.status, 'pending');
  assert.deepEqual(dispatches, []); assert.equal(normal.length, 1); assert.equal(ports.size, 1);
  const originalDrafts = draftBytes(store.db);
  initial.release(); await manager.close(projectId);
  const local = projectLocation(directories, projectId);
  const rawProject = new DatabaseSync(registration.projectFile);
  let externalSequence: number;
  try {
    rawProject.prepare("UPDATE projects SET data=json_set(data,'$.name','External','$.revision',json_extract(data,'$.revision')+1) WHERE id=?").run(projectId);
    externalSequence = Number(rawProject.prepare('SELECT contentSequence FROM project_file').get()!.contentSequence);
  } finally {rawProject.close();}
  // Equal sequence and different tokens is still diverged, not a newer copy
  // that can silently resume its local pending intentions.
  const rawHistory = new DatabaseSync(path.join(local.localDir, 'history.db'));
  try {rawHistory.prepare('UPDATE history_state SET seenContentSequence=?').run(externalSequence!);} finally {rawHistory.close();}
  const legacy = [
    ['local-drafts-v1.json', {version: 2, workspaceScope: savedClip.workspaceScope, entries: JSON.parse(originalDrafts).local_clip_drafts.map((row: {data: string}) => JSON.parse(row.data))}],
    ['local-delivery-v1.json', {version: 1, workspaceScope: savedDelivery.workspaceScope, entries: JSON.parse(originalDrafts).local_delivery_drafts.map((row: {data: string}) => JSON.parse(row.data))}],
    ['local-shot-text-v1.json', {version: 1, workspaceScope: savedShot.workspaceScope, entries: JSON.parse(originalDrafts).local_shot_text_drafts.map((row: {data: string}) => JSON.parse(row.data))}],
  ] as const;
  const legacyFiles = legacy.map(([name, value]) => {
    const file = path.join(local.localDir, name), bytes = Buffer.from(JSON.stringify(value) + '\n'); writeFileSync(file, bytes, {mode: 0o600}); return {file, bytes};
  });
  const historyFile = path.join(local.localDir, 'history.db'), coldHistory = readFileSync(historyFile), coldProject = readFileSync(registration.projectFile);
  let legacyReads = 0;
  const withoutLegacyReads = async <Result>(read: () => Promise<Result>): Promise<Result> => {
    const native = fs.openSync, paths = new Set(legacyFiles.map(value => value.file));
    const mock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      if (typeof args[0] === 'string' && paths.has(path.resolve(args[0]))) {legacyReads++; assert.fail('Production must not read a retired JSON file');}
      return native(...args);
    });
    syncBuiltinESMExports();
    try {return await read();} finally {mock.mock.restore(); syncBuiltinESMExports();}
  };
  return {root, library, owner, app, manager, registration, projectId, local, normal, ports, dispatches, request,
    savedVersion, key, shotId: shot.id, savedClip, savedDelivery, savedShot, clipInput,
    originalDrafts, coldHistory, coldProject, legacyFiles, historyFile, withoutLegacyReads, legacyReads: () => legacyReads,
    closeFramework, addCloser: (close: () => Promise<void> | void) => {externalClosers.push(close);}};
}

test('diverged history precedes the entire drafts factory and rejects GET, business and native writes without touching evidence', async t => {
  const f = await fixture(t), registration = f.library.registry.get(f.projectId);
  const recovery = await f.withoutLegacyReads(() => f.manager.acquire(f.projectId, 'window'));
  try {
    assert.ok(recovery.host.recovery); assert.equal(f.manager.status(f.projectId)?.state, 'open');
    assert.equal(f.normal.length, 1); assert.equal(f.ports.size, 1); assert.deepEqual(f.dispatches, []);
    assert.throws(() => recovery.host.runtime, {code: 'PROJECT_HISTORY_DIVERGED', status: 409});
    const status = recovery.host.recovery.status(); assert.equal(status.state, 'diverged'); assert.equal(status.reason, 'content-token-different');
    assert.equal(status.file.contentSequence, status.seen.contentSequence); assert.notEqual(status.file.contentToken, status.seen.contentToken);
    const before = draftBytes(recovery.host.store.db), pair = readProjectContentStamp(recovery.host.store.db);
    assert.equal(before, f.originalDrafts);
    await f.withoutLegacyReads(async () => {
      for (const route of [`/local-drafts?projectId=${f.projectId}`, `/local-delivery?projectId=${f.projectId}`, `/local-shot-text?projectId=${f.projectId}&shotId=${f.shotId}`])
        await assert.rejects(f.request(route), {code: 'PROJECT_HISTORY_DIVERGED', status: 409});
      await assert.rejects(f.request('/rpc', 'POST', {operation: 'shot.create', input: {projectId: f.projectId, title: 'Must not run'}}), {code: 'PROJECT_HISTORY_DIVERGED', status: 409});
    });
    const readonly = {code: 'ERR_SQLITE_ERROR', errcode: 8, message: 'attempt to write a readonly database'};
    assert.throws(() => recovery.host.store.tx(() => recovery.host.store.db.exec('UPDATE main.local_clip_drafts SET data=data')), readonly);
    assert.throws(() => recovery.host.store.db.exec('UPDATE main.local_clip_drafts SET data=data'), readonly);
    assert.throws(() => recovery.host.store.put('projects', {id: f.projectId, name: 'Must not write'}), {code: 'PROJECT_HISTORY_DIVERGED', status: 409});
    recovery.host.store.db.exec('PRAGMA query_only=OFF');
    try {
      assert.throws(() => recovery.host.store.db.exec('UPDATE main.local_clip_drafts SET data=data'),
        {code: 'ERR_SQLITE_ERROR', errcode: 1811, message: 'PROJECT_HISTORY_DIVERGED'});
    } finally {recovery.host.store.db.exec('PRAGMA query_only=ON');}
    assert.equal(draftBytes(recovery.host.store.db), before); assert.deepEqual(readProjectContentStamp(recovery.host.store.db), pair);
    assert.deepEqual(f.library.registry.get(f.projectId), registration); assert.equal(f.legacyReads(), 0);
  } finally {recovery.release(); await f.manager.close(f.projectId);}
  assert.equal(f.normal.length, 1); assert.deepEqual(readFileSync(f.historyFile), f.coldHistory);
  for (const {file, bytes} of f.legacyFiles) assert.deepEqual(readFileSync(file), bytes);
});

for (const action of ['continue', 'restore-version'] as const) test(`${action} archives every original draft and starts one empty drafts domain without JSON import or dispatch`, async t => {
  const f = await fixture(t), recovery = await f.manager.acquire(f.projectId, 'window'), session = recovery.host.recovery!;
  const status = session.status(), preview = session.previewVersion({projectId: f.projectId, versionId: f.savedVersion.id});
  assert.equal(preview.restoreAvailable, true); assert.ok(preview.totalChanges > 0);
  const input = confirmation(status, action, f.savedVersion.id, preview.previewDigest);
  recovery.release();
  const result = await f.withoutLegacyReads(() => f.manager.resolveHistory(input));
  assert.equal(result.activation, 'pending'); assert.equal(f.normal.length, 1); assert.equal(f.ports.size, 1);
  if (action === 'continue') assert.deepEqual(result.content, status.file);
  else {assert.ok(result.content.contentSequence > status.file.contentSequence); assert.notEqual(result.content.contentToken, status.file.contentToken);}
  const archive = path.join(f.local.localDir, result.archive), info = lstatSync(archive);
  assert.equal(info.mode & 0o777, 0o400); assert.deepEqual(readFileSync(archive), f.coldHistory);
  assert.equal(isProjectFileHeld({dev: String(info.dev), ino: String(info.ino)}), false, 'the archived database is cold before opening its read-only evidence');
  const old = new DatabaseSync(archive, {readOnly: true});
  try {
    assert.equal(draftBytes(old), f.originalDrafts);
    const states = old.prepare('SELECT kind,workspaceScope FROM local_draft_states ORDER BY kind').all(); assert.equal(states.length, 3);
    assert.ok(states.every(row => row.workspaceScope === f.savedClip.workspaceScope));
    assert.equal(JSON.parse(String(old.prepare('SELECT data FROM local_delivery_drafts').get()!.data)).intent.outcome.status, 'pending');
    assert.equal(JSON.parse(String(old.prepare('SELECT data FROM local_shot_text_drafts').get()!.data)).intent.outcome.status, 'pending');
  } finally {old.close();}
  const current = await f.withoutLegacyReads(() => f.manager.acquire(f.projectId, 'window'));
  try {
    assert.equal(current.host.recovery, undefined); assert.equal(f.normal.length, 2); assert.equal(f.ports.size, 2);
    assert.notEqual(f.normal[0]!.context.store, current.host.store); assert.equal(current.host.store, f.normal[1]!.context.store);
    assert.deepEqual(draftSnapshot(current.host.store.db), emptyDrafts()); assert.deepEqual(f.dispatches, []);
    assert.deepEqual(readProjectContentStamp(current.host.store.db), result.content);
    const seen = current.host.store.db.prepare('SELECT seenContentSequence,seenContentToken FROM history_state').get()!;
    assert.deepEqual({contentSequence: Number(seen.seenContentSequence), contentToken: seen.seenContentToken}, result.content);
    assert.equal((current.host.store.get('projects', f.projectId) as {name: string}).name, action === 'continue' ? 'External' : 'Original');
    const fresh = await f.withoutLegacyReads(() => f.request<ClipEnvelope>(`/local-drafts/clip?projectId=${f.projectId}&timelineId=${f.key.timelineId}&clipId=${f.key.clipId}`));
    assert.equal(fresh.draft, null); assert.equal(fresh.revision, 0); assert.notEqual(fresh.workspaceScope, f.savedClip.workspaceScope); assert.notEqual(fresh.instanceId, f.savedClip.instanceId);
    const delivery = await f.withoutLegacyReads(() => f.request<DeliveryEnvelope>(`/local-delivery?projectId=${f.projectId}`));
    const shot = await f.withoutLegacyReads(() => f.request<ShotEnvelope>(`/local-shot-text?projectId=${f.projectId}&shotId=${f.shotId}`));
    assert.equal(delivery.draft, null); assert.equal(delivery.intent, null); assert.equal(shot.draft, null); assert.equal(shot.intent, null); assert.equal(shot.projectPendingIntent, null);
    const changes = current.host.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    // Capture the normal HTTP adapter's original exact local refusal.
    const port = f.normal[1]!.runtime.project.draftsFactory(f.normal[1]!.context);
    const rejected = async (body: unknown, expected: string) => {
      const pathname = `/api/projects/${f.projectId}/local-drafts/clip`, route = parseProjectApiPath(pathname); assert.ok(route);
      const socket = new Socket(), req = new IncomingMessage(socket), res = new ServerResponse(req);
      req.method = 'PUT'; req.url = pathname; req.headers['content-type'] = 'application/json'; req.push(Buffer.from(JSON.stringify(body))); req.push(null);
      const end = t.mock.method(res, 'end');
      try {
        assert.equal(await port.handle({req, res, url: new URL(pathname, 'http://127.0.0.1'), route, signal: current.signal}), true);
        assert.equal(res.statusCode, 409); const reply = JSON.parse(String(end.mock.calls[0]!.arguments[0])) as {error: {code: string}}; assert.equal(reply.error.code, expected);
      } finally {res.emit('close'); socket.destroy();}
    };
    await rejected({...f.clipInput, expectedRevision: f.savedClip.revision}, 'LOCAL_DRAFT_SCOPE_MISMATCH');
    await rejected({...f.clipInput, workspaceScope: fresh.workspaceScope}, 'LOCAL_DRAFT_STALE_INSTANCE');
    assert.equal(current.host.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
    assert.deepEqual(draftSnapshot(current.host.store.db), emptyDrafts()); assert.deepEqual(f.dispatches, []); assert.equal(f.legacyReads(), 0);
  } finally {current.release(); await f.manager.close(f.projectId);}
  assert.deepEqual(await f.manager.resolveHistory(input), result); assert.equal(f.normal.length, 2);
  assert.equal(readdirSync(f.local.localDir).filter(name => /^history-\d/u.test(name)).length, 1);
  assert.deepEqual(readFileSync(archive), f.coldHistory);
  for (const {file, bytes} of f.legacyFiles) assert.deepEqual(readFileSync(file), bytes);
});

test('real HTTP refuses every draft and ordinary business address during recovery without opening its drafts domain', async t => {
  const f = await fixture(t); await f.closeFramework();
  let inspect!: InspectProject;
  const token = 'synthetic-drafts-history-switch-token', server = await startServer({dataDir: f.root, port: 0, token, inspectProject: value => {inspect = value;}});
  f.addCloser(() => server.close());
  const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};
  const snapshot = () => inspect(f.projectId, db => ({drafts: draftSnapshot(db), file: readProjectContentStamp(db), seen: db.prepare('SELECT * FROM history_state').all()}));
  const status = await fetch(`${server.url}/api/projects/${f.projectId}/history/status`, {headers});
  assert.equal(status.status, 200); const state = await status.json() as {data: ProjectHistoryStatus}; assert.equal(state.data.state, 'diverged');
  const before = snapshot();
  await f.withoutLegacyReads(async () => {
    for (const tail of [`local-drafts?projectId=${f.projectId}`, `local-delivery?projectId=${f.projectId}`, `local-shot-text?projectId=${f.projectId}&shotId=${f.shotId}`]) {
      const response = await fetch(`${server.url}/api/projects/${f.projectId}/${tail}`, {headers});
      assert.equal(response.status, 409); const body = await response.json() as {error: {code: string}}; assert.equal(body.error.code, 'PROJECT_HISTORY_DIVERGED');
    }
    const response = await fetch(`${server.url}/api/projects/${f.projectId}/rpc`, {method: 'POST', headers,
      body: JSON.stringify({operation: 'shot.create', input: {projectId: f.projectId, title: 'No recovery dispatch'}})});
    assert.equal(response.status, 409); const body = await response.json() as {error: {code: string}}; assert.equal(body.error.code, 'PROJECT_HISTORY_DIVERGED');
  });
  assert.deepEqual(snapshot(), before); assert.equal(f.legacyReads(), 0); assert.deepEqual(f.dispatches, []);
  await server.close(); assert.deepEqual(readFileSync(f.historyFile), f.coldHistory);
});

for (const mode of ['aborted', 'replaced'] as const) test(`history switch cannot borrow ${mode} B1 write authority or change drafts`, async t => {
  const f = await fixture(t), recovery = await f.manager.acquire(f.projectId, 'window'), session = recovery.host.recovery!;
  const status = session.status(), preview = session.previewVersion({projectId: f.projectId, versionId: f.savedVersion.id});
  const input = confirmation(status, 'continue', f.savedVersion.id, preview.previewDigest); recovery.release(); await f.manager.close(f.projectId);
  const beforeNames = readdirSync(f.local.localDir).sort(), reason = new Error('Synthetic S8 switch owner stopped');
  let replacement: ReturnType<typeof openAppLibrary> | undefined;
  if (mode === 'aborted') f.owner.abort(reason);
  else {f.library.close(); replacement = openAppLibrary({dataDir: f.root}); f.addCloser(() => replacement?.close()); assert.doesNotThrow(() => createProjectServiceApplication(replacement!).assertMutationAllowed());}
  await assert.rejects(f.manager.resolveHistory(input), mode === 'aborted' ? error => error === reason : /live application library owner/u);
  assert.deepEqual(readdirSync(f.local.localDir).sort(), beforeNames); assert.deepEqual(readFileSync(f.historyFile), f.coldHistory);
  assert.deepEqual(readFileSync(f.registration.projectFile), f.coldProject); assert.equal(f.normal.length, 1); assert.deepEqual(f.dispatches, []);
  for (const {file, bytes} of f.legacyFiles) assert.deepEqual(readFileSync(file), bytes);
});
