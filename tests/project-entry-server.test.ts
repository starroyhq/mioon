import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {setTimeout as pause} from 'node:timers/promises';
import {startServer, type InspectProject, type ServerOptions} from '../apps/server/src/index.ts';
import {writeProjectCover} from '../apps/server/src/project-host/covers.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectFile} from '../packages/business/src/project-file/index.ts';
import {createProjectHomeServices} from '../packages/business/src/project-home.ts';
import {projectEntriesResponseSchema} from '../packages/contracts/src/project-entry.ts';
import type {ProjectEntriesResponse} from '../packages/contracts/src/project-entry.ts';
import type {ProjectEntryWindowRevoked} from '../packages/contracts/src/project-entry-native.ts';
import type {RecentProject} from '../packages/contracts/src/project-registry.ts';
import {timelineOutputPreset} from '../packages/contracts/src/timeline-output-geometry.ts';
import {createServerProject, openServerProject} from './helpers/project-database.ts';

const token = 'project-entry-server-synthetic-token';
const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,0,1,0,1,3,1,0x22,0,2,0x11,1,3,0x11,1,0xff,0xda,0,12,3,1,0,2,0x11,3,0x11,0,0x3f,0,0x12,0x34,0xff,0xd9]);
interface WireBody<T> {ok: boolean; data?: T; error?: {code: string; details?: unknown}}
type Server = Awaited<ReturnType<typeof startServer>>;

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function fixture(t: TestContext, channel: ServerOptions['localDraftChannel'] = 'web', {externalProjectsRoot = false} = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-project-entry-server-'));
  const dataDir = path.join(root, 'app'), projectsDir = externalProjectsRoot ? path.join(root, 'selected-projects') : path.join(dataDir, 'projects');
  let server: Server | undefined;
  const stores: ReturnType<typeof openServerProject>[] = [];
  t.after(async () => {
    for (const store of stores) if (store.db.isOpen) store.close();
    await server?.close();
    rmSync(root, {recursive: true, force: true});
  });
  const a = createServerProject(dataDir, {name: 'Catalog A'});
  let aFile = a.store.projectFile;
  const summary = createProjectHomeServices(a.store).handlers['project.summary.list']()[0]!;
  const coverAsset = randomUUID();
  writeProjectCover({cacheDir: a.store.cacheDir,
    source: {assetId: coverAsset, mimeType: 'image/png', sourceFingerprint: 'a'.repeat(64)}, jpeg});
  a.store.close();
  const b = createServerProject(dataDir, {name: 'Catalog B'});
  let bFile = b.store.projectFile;
  b.store.close();
  if (externalProjectsRoot) {
    mkdirSync(projectsDir);
    const move = (file: string): string => {
      const directory = path.join(projectsDir, path.basename(path.dirname(file)));
      renameSync(path.dirname(file), directory);
      return path.join(directory, path.basename(file));
    };
    aFile = move(aFile); bFile = move(bFile);
  }
  const library = openAppLibrary({dataDir});
  try {
    // A registered cover is a cache snapshot, not permission to reopen its source.
    const {id: _id, name: _name, lastOpenedAt: _lastOpenedAt, cover: _cover, ...rest} = summary;
    library.registry.upsert({...library.registry.get(a.projectId)!, projectFile: aFile,
      summary: {...rest, cover: {assetId: coverAsset, mimeType: 'image/png'}}});
    if (externalProjectsRoot) library.registry.upsert({...library.registry.get(b.projectId)!, projectFile: bFile});
  } finally {library.close();}
  let inspect!: InspectProject;
  server = await startServer({dataDir, projectsDir, port: 0, token, localDraftChannel: channel,
    inspectProject: received => {inspect = received;}});
  const owned = server;
  const fetchOwned = (route: string, options: RequestInit = {}) => fetch(owned.url + route, {...options,
    headers: {authorization: `Bearer ${token}`, ...options.headers}});
  const json = async <T = unknown>(route: string, options: RequestInit = {}) => {
    const response = await fetchOwned(route, options);
    return {status: response.status, body: await response.json() as WireBody<T>};
  };
  const catalog = async (): Promise<ProjectEntriesResponse> => {
    const result = await json<ProjectEntriesResponse>('/api/project-entries');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    return projectEntriesResponseSchema.parse(result.body.data);
  };
  const rpc = (operation: string, input: unknown) => json('/api/rpc', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({operation, input})});
  const hold = (projectId: string) => {
    const store = openServerProject(dataDir, projectId); stores.push(store); return store;
  };
  return {root, dataDir, projectsDir, server: owned, a: {projectId: a.projectId, projectFile: aFile},
    b: {projectId: b.projectId, projectFile: bFile}, fetch: fetchOwned, json, catalog, rpc, hold,
    native: (projectId: string): DatabaseSync => inspect(projectId, db => db)};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function eventually(check: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    if (check()) return;
    assert.ok(performance.now() < deadline, message);
    await pause(10);
  }
}

function requestGetBody(url: string, body: object): Promise<{status: number; body: WireBody<unknown>}> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(url, {method: 'GET', headers: {authorization: `Bearer ${token}`,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(text)}}, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {resolve({status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireBody<unknown>});}
        catch (error) {reject(error);}
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Owned GET-body request timed out')));
    req.on('error', reject); req.end(text);
  });
}

function registry(f: Fixture): readonly RecentProject[] {
  return f.server.projectEntries.listRecent().registered.map(entry => entry.project);
}

test('application catalog retains legacy identity and reads registered metadata and covers without acquiring a runtime', async t => {
  const f = await fixture(t), before = registry(f);
  const a = f.hold(f.a.projectId), b = f.hold(f.b.projectId);
  const entries = await f.catalog(), again = await f.catalog();
  assert.equal(entries.version, 1); assert.match(entries.appLibraryScope, /^[a-f0-9]{64}$/u);
  assert.match(entries.instanceId, /^[a-f0-9-]{36}$/u);
  assert.equal(again.instanceId, entries.instanceId); assert.equal(again.appLibraryScope, entries.appLibraryScope);
  assert.deepEqual(new Set(entries.registered.map(entry => entry.project.projectId)), new Set([f.a.projectId, f.b.projectId]));
  assert.equal(entries.registered.find(entry => entry.project.projectId === f.a.projectId)!.coverUrl, `/api/project-covers/${f.a.projectId}`);
  assert.equal(entries.registered.find(entry => entry.project.projectId === f.b.projectId)!.coverUrl, null);
  assert.deepEqual(registry(f), before, 'listing does not change successful-open timestamps or registrations');
  const legacy = await f.json<{supported: boolean; workspaceScope: string}>('/api/last-project');
  assert.equal(legacy.status, 200); assert.equal(legacy.body.data!.supported, true);
  assert.equal(entries.appLibraryScope, legacy.body.data!.workspaceScope);
  const cover = await f.fetch(`/api/project-covers/${f.a.projectId}`);
  assert.equal(cover.status, 200); assert.deepEqual(Buffer.from(await cover.arrayBuffer()), jpeg);
  assert.equal(a.db.isOpen, true); assert.equal(b.db.isOpen, true);
});

test('web catalog lists only registered files below its project root and never scans unregistered candidates', async t => {
  const f = await fixture(t, 'web', {externalProjectsRoot: true}), outside = path.join(f.root, 'outside'); mkdirSync(outside);
  const external = await f.server.projectEntries.create({name: 'Outside', parentDir: outside});
  const prefixPeer = path.join(f.root, 'selected-projects-neighbor'); mkdirSync(prefixPeer);
  const peer = await f.server.projectEntries.create({name: 'Prefix peer', parentDir: prefixPeer});
  const candidate = path.join(f.projectsDir, 'unregistered.mioon');
  const candidateId = createProjectFile(candidate), candidateBytes = readFileSync(candidate);
  const before = registry(f), data = await f.catalog();
  assert.deepEqual(new Set(data.registered.map(entry => entry.project.projectId)), new Set([f.a.projectId, f.b.projectId]));
  assert.ok(registry(f).some(entry => entry.projectId === external.projectId));
  assert.ok(registry(f).some(entry => entry.projectId === peer.projectId));
  assert.ok(!registry(f).some(entry => entry.projectId === candidateId));
  assert.deepEqual(registry(f), before); assert.deepEqual(readFileSync(candidate), candidateBytes);
  const missing = await f.server.projectEntries.create({name: 'Missing'});
  rmSync(missing.projectFile);
  assert.deepEqual((await f.catalog()).registered.find(entry => entry.project.projectId === missing.projectId)!.availability, {state: 'missing'});
});

for (const channel of ['production', 'development'] as const) {
  test(`${channel} catalog includes registered external projects without acquiring them`, async t => {
    const f = await fixture(t, channel), outside = path.join(f.root, 'outside'); mkdirSync(outside);
    const entry = await f.server.projectEntries.create({name: 'Native external', parentDir: outside});
    const held = f.hold(entry.projectId), data = await f.catalog();
    assert.ok(data.registered.some(item => item.project.projectId === entry.projectId));
    assert.deepEqual(data, f.server.projectEntries.listRecent());
    assert.equal(held.db.isOpen, true);
  });
}

test('catalog enforces authentication, origin, a read-only exact route and no query or body path controls', async t => {
  const f = await fixture(t), before = registry(f);
  assert.equal((await fetch(f.server.url + '/api/project-entries')).status, 401);
  const foreign = await f.json('/api/project-entries', {headers: {origin: 'https://foreign.invalid'}});
  assert.equal(foreign.status, 403); assert.equal(foreign.body.error!.code, 'ORIGIN_REJECTED');
  for (const query of ['path=%2Foutside', 'projectFile=%2Foutside', 'root=%2Foutside', 'cursor=1']) {
    const result = await f.json('/api/project-entries?' + query);
    assert.equal(result.status, 400); assert.equal(result.body.error!.code, 'VALIDATION_ERROR');
  }
  const getBody = await requestGetBody(f.server.url + '/api/project-entries', {projectFile: '/outside', kind: 'window'});
  assert.equal(getBody.status, 400); assert.equal(getBody.body.error!.code, 'VALIDATION_ERROR');
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const response = await f.fetch('/api/project-entries', {method});
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET'); await response.arrayBuffer();
  }
  for (const suffix of ['/open', '/create', '/window-session', '/release']) {
    const response = await f.json('/api/project-entries' + suffix, {method: 'POST'});
    assert.equal(response.status, 404);
  }
  assert.deepEqual(registry(f), before);
});

test('trusted and public creation reject the same invalid names before any directory or registry changes', async t => {
  const f = await fixture(t), parentDir = path.join(f.root, 'selected parent'); mkdirSync(parentDir);
  writeFileSync(path.join(parentDir, 'keep.txt'), 'preserve selected parent');
  const before = registry(f), projects = readdirSync(f.projectsDir).sort(), selected = readdirSync(parentDir).sort();
  for (const name of ['', '   ', '.', '..', '.hidden', 'trailing.', 'a/b', 'a\\b', 'bad\u0000name', 'CON.txt', 'lpt1', ' padded ']) {
    await assert.rejects(() => f.server.projectEntries.create({name, parentDir}), {code: 'VALIDATION_ERROR', status: 400});
    const response = await f.rpc('project.create', {name});
    assert.equal(response.status, 400); assert.equal(response.body.error!.code, 'VALIDATION_ERROR');
    assert.deepEqual(registry(f), before); assert.deepEqual(readdirSync(f.projectsDir).sort(), projects);
    assert.deepEqual(readdirSync(parentDir).sort(), selected);
  }
  assert.equal(readFileSync(path.join(parentDir, 'keep.txt'), 'utf8'), 'preserve selected parent');
});

test('trusted creation initializes description and preset at each selected location and never replaces an existing target', async t => {
  const f = await fixture(t), parentDir = path.join(f.root, 'selected parent'); mkdirSync(parentDir);
  writeFileSync(path.join(parentDir, 'keep.txt'), 'retain parent');
  const inFolder = await f.server.projectEntries.create({name: 'Folder Project', description: 'Selected folder description',
    timelinePresetId: 'landscape_1080', parentDir});
  assert.equal(path.dirname(path.dirname(inFolder.projectFile)), parentDir);
  assert.equal(path.basename(path.dirname(inFolder.projectFile)), 'Folder Project');
  assert.equal(path.basename(inFolder.projectFile), 'Folder Project.mioon');
  const projectFile = path.join(parentDir, 'Chosen.mioon');
  const exact = await f.server.projectEntries.create({name: 'Document Name', description: 'Selected file description',
    timelinePresetId: 'square_1080', projectFile});
  assert.equal(exact.projectFile, projectFile);
  for (const [entry, name, description, presetId, width, height] of [
    [inFolder, 'Folder Project', 'Selected folder description', 'landscape_1080', 1920, 1080],
    [exact, 'Document Name', 'Selected file description', 'square_1080', 1080, 1080],
  ] as const) {
    const store = f.hold(entry.projectId), project = object(store.get('projects', entry.projectId));
    assert.equal(project.id, entry.projectId); assert.equal(project.name, name); assert.equal(project.description, description);
    assert.equal(project.revision, 1);
    const timelines = store.list('timelines', entry.projectId); assert.equal(timelines.length, 1);
    const timeline = object(timelines[0]);
    assert.equal(timelineOutputPreset(timeline)?.id, presetId); assert.equal(timeline.width, width); assert.equal(timeline.height, height);
    assert.equal(timeline.fps, 30); store.close();
    assert.equal(entry.lastOpenedAt, null, 'creation alone is not a successful editor open');
  }
  const original = readFileSync(projectFile), before = registry(f);
  await assert.rejects(() => f.server.projectEntries.create({name: 'Do not overwrite', projectFile}), {code: 'PROJECT_FILE_EXISTS', status: 409});
  assert.deepEqual(readFileSync(projectFile), original); assert.deepEqual(registry(f), before);
  assert.equal(readFileSync(path.join(parentDir, 'keep.txt'), 'utf8'), 'retain parent');
  assert.deepEqual(readdirSync(parentDir).sort(), ['Chosen.mioon', 'Folder Project', 'keep.txt']);
});

test('failed initialization removes only its new exact file and preserves the selected empty parent', async t => {
  const f = await fixture(t), parentDir = path.join(f.root, 'selected empty parent'); mkdirSync(parentDir);
  const identity = lstatSync(parentDir, {bigint: true}), records = path.join(f.dataDir, 'records');
  const before = registry(f), projectFile = path.join(parentDir, 'Not initialized.mioon');
  // Fail companion creation after the selected project file was created. This
  // uses the real filesystem boundary instead of introducing a server fault seam.
  chmodSync(records, 0o500);
  try {
    await assert.rejects(() => f.server.projectEntries.create({name: 'Not initialized', projectFile}));
  } finally {chmodSync(records, 0o700);}
  const after = lstatSync(parentDir, {bigint: true});
  assert.equal(after.dev, identity.dev); assert.equal(after.ino, identity.ino);
  assert.deepEqual(readdirSync(parentDir), []); assert.equal(existsSync(projectFile), false);
  assert.deepEqual(registry(f), before);
});

test('public project.create uses the same complete initialization without exposing native path selection', async t => {
  const f = await fixture(t);
  const response = await f.rpc('project.create', {name: 'Public Project', description: 'Public description', timelinePresetId: 'landscape_1080'});
  assert.equal(response.status, 200); assert.equal(response.body.ok, true);
  const project = object(response.body.data), projectId = String(project.id), windowId = randomUUID();
  await f.server.projectEntries.acquire({projectId, windowId});
  const row = f.native(projectId).prepare('SELECT data FROM project.projects WHERE id=?').get(projectId);
  assert.equal(object(JSON.parse(String(row!.data))).description, 'Public description');
  const timeline = f.native(projectId).prepare('SELECT data FROM project.timelines WHERE projectId=?').get(projectId);
  assert.equal(timelineOutputPreset(object(JSON.parse(String(timeline!.data))))?.id, 'landscape_1080');
  const outside = path.join(f.root, 'not-created');
  const rejected = await f.rpc('project.create', {name: 'No HTTP paths', parentDir: outside});
  assert.equal(rejected.status, 400); assert.equal(rejected.body.error!.code, 'VALIDATION_ERROR');
  assert.equal(existsSync(outside), false);
  f.server.projectEntries.release({windowId});
});

test('native open registers the original selected file, while missing and locked failures preserve recent records and locks', async t => {
  const f = await fixture(t), donor = createServerProject(path.join(f.root, 'donor-app'), {name: 'Selected ordinary project'});
  const selected = donor.store.projectFile, selectedId = donor.projectId;
  donor.store.close();
  const identity = lstatSync(selected, {bigint: true}), windowId = randomUUID();
  const opened = await f.server.projectEntries.openPath({projectFile: selected, windowId});
  assert.equal(opened.project.projectId, selectedId); assert.equal(opened.project.projectFile, selected);
  assert.equal(opened.windowId, windowId); assert.ok(opened.project.lastOpenedAt);
  const after = lstatSync(selected, {bigint: true});
  assert.equal(after.dev, identity.dev); assert.equal(after.ino, identity.ino);
  const db = f.native(selectedId);
  f.server.projectEntries.release({windowId}); await eventually(() => !db.isOpen, 'selected file window releases its native owner');
  const held = f.hold(f.a.projectId), before = registry(f);
  await assert.rejects(() => f.server.projectEntries.openPath({projectFile: f.a.projectFile, windowId: randomUUID()}), {code: 'PROJECT_LOCKED'});
  assert.equal(held.db.isOpen, true); assert.equal(held.db.prepare('SELECT 1 AS value').get()!.value, 1);
  await assert.rejects(() => f.server.projectEntries.openPath({projectFile: path.join(f.root, 'missing.mioon'), windowId: randomUUID()}), {code: 'PROJECT_MISSING'});
  assert.deepEqual(registry(f), before, 'failed opens do not advance successful-open metadata');
});

test('window bindings share duplicate intent and a project runtime, reject retargeting, and release only their own lease', async t => {
  const f = await fixture(t), one = randomUUID(), two = randomUUID(), revoked: ProjectEntryWindowRevoked[] = [];
  f.server.projectEntries.onWindowRevoked(event => revoked.push(event));
  const opening = f.server.projectEntries.acquire({projectId: f.a.projectId, windowId: one});
  assert.equal(f.server.projectEntries.acquire({projectId: f.a.projectId, windowId: one}), opening);
  const first = await opening, db = f.native(f.a.projectId);
  const second = await f.server.projectEntries.openPath({projectFile: f.a.projectFile, windowId: two});
  assert.equal(first.project.projectId, f.a.projectId); assert.equal(first.windowId, one);
  assert.equal(second.project.projectFile, f.a.projectFile); assert.equal(second.windowId, two);
  assert.equal(f.native(f.a.projectId), db);
  await assert.rejects(async () => f.server.projectEntries.acquire({projectId: f.b.projectId, windowId: one}),
    {code: 'PROJECT_ENTRY_WINDOW_CONFLICT', status: 409});
  assert.throws(() => f.hold(f.a.projectId), {code: 'PROJECT_LOCKED'});
  f.server.projectEntries.release({windowId: one}); f.server.projectEntries.release({windowId: one});
  assert.equal(db.isOpen, true, 'the other native window retains the shared kernel connection');
  f.server.projectEntries.release({windowId: two});
  await eventually(() => !db.isOpen, 'the final window release closes the idle host');
  const reopened = f.hold(f.a.projectId); assert.equal(reopened.db.isOpen, true); reopened.close();
  assert.deepEqual(revoked, [], 'ordinary releases are not forced revocations');
});

test('releasing a pending native open rejects its late result and cannot leak or retire a replacement window', async t => {
  const f = await fixture(t), windowId = randomUUID();
  const pending = f.server.projectEntries.acquire({projectId: f.a.projectId, windowId});
  const rejected = assert.rejects(pending, {code: 'PROJECT_ENTRY_UNAVAILABLE', status: 503});
  f.server.projectEntries.release({windowId});
  const [replacement] = await Promise.all([f.server.projectEntries.acquire({projectId: f.b.projectId, windowId}), rejected]);
  assert.equal(replacement.project.projectId, f.b.projectId);
  const replacementDb = f.native(f.b.projectId); assert.equal(replacementDb.isOpen, true);
  await eventually(() => {
    try {const store = f.hold(f.a.projectId); store.close(); return true;}
    catch (error) {if (object(error).code === 'PROJECT_LOCKED') return false; throw error;}
  }, 'a late cancelled open releases its real kernel lock');
  assert.equal(replacementDb.isOpen, true);
  f.server.projectEntries.release({windowId});
  await eventually(() => !replacementDb.isOpen, 'replacement owns and releases its own lease');
});

test('exclusive project closure notifies each bound window and observer failures do not prevent cleanup', async t => {
  const f = await fixture(t), one = randomUUID(), two = randomUUID(), revoked: ProjectEntryWindowRevoked[] = [];
  await f.server.projectEntries.acquire({projectId: f.a.projectId, windowId: one});
  await f.server.projectEntries.acquire({projectId: f.a.projectId, windowId: two});
  const db = f.native(f.a.projectId);
  const stopThrowing = f.server.projectEntries.onWindowRevoked(() => {throw new Error('Synthetic observer failure');});
  const unsubscribe = f.server.projectEntries.onWindowRevoked(event => revoked.push(event));
  const renamed = await f.rpc('project.rename', {projectId: f.a.projectId, requestId: randomUUID(), expectedRevision: 1, name: 'Renamed catalog project'});
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body)); assert.equal(db.isOpen, false);
  assert.deepEqual(new Set(revoked.map(event => event.windowId)), new Set([one, two]));
  assert.equal(revoked.length, 2); assert.ok(revoked.every(event => event.projectId === f.a.projectId));
  stopThrowing(); unsubscribe();
  await f.server.projectEntries.acquire({projectId: f.a.projectId, windowId: one});
  await f.server.close();
  assert.equal(revoked.length, 2, 'an unsubscribed owner receives no shutdown event');
  assert.throws(() => f.server.projectEntries.listRecent(), {code: 'PROJECT_HOST_STOPPED'});
  await assert.rejects(async () => f.server.projectEntries.acquire({projectId: f.a.projectId, windowId: randomUUID()}), {code: 'PROJECT_HOST_STOPPED'});
});

test('shutdown during acquisition rejects pending delivery and releases the real project lock', async t => {
  const f = await fixture(t), windowId = randomUUID();
  const pending = f.server.projectEntries.acquire({projectId: f.a.projectId, windowId});
  const rejected = assert.rejects(pending, error => {
    const code = object(error).code;
    return code === 'PROJECT_ENTRY_UNAVAILABLE' || code === 'PROJECT_HOST_STOPPED';
  });
  await Promise.all([f.server.close(), rejected]);
  const reopened = f.hold(f.a.projectId); assert.equal(reopened.db.isOpen, true); reopened.close();
  assert.throws(() => f.server.projectEntries.listRecent(), {code: 'PROJECT_HOST_STOPPED'});
});

test('the same native window identifier belongs independently to each backend instance', async t => {
  const first = await fixture(t), second = await fixture(t), windowId = randomUUID();
  const a = await first.server.projectEntries.acquire({projectId: first.a.projectId, windowId});
  const b = await second.server.projectEntries.acquire({projectId: second.a.projectId, windowId});
  assert.equal(a.project.projectId, first.a.projectId); assert.equal(b.project.projectId, second.a.projectId);
  assert.notEqual(first.server.projectEntries.listRecent().instanceId, second.server.projectEntries.listRecent().instanceId);
  const firstDb = first.native(first.a.projectId), secondDb = second.native(second.a.projectId);
  first.server.projectEntries.release({windowId});
  await eventually(() => !firstDb.isOpen, 'only the first backend binding releases');
  assert.equal(secondDb.isOpen, true);
  second.server.projectEntries.release({windowId});
  await eventually(() => !secondDb.isOpen, 'the second backend owns an independent binding');
});
