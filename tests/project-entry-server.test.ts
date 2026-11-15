import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {request} from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {setTimeout as pause} from 'node:timers/promises';
import {startServer, type InspectApplication, type InspectProject, type ServerOptions} from './helpers/test-server.ts';
import {createProjectEntries} from '../apps/server/src/project-entries.ts';
import {writeProjectCover} from '../apps/server/src/project-host/covers.ts';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {createMemoryProjectRegistry, createProjectHostManager, serverAppDirectories, statProjectFileIdentity} from '../apps/server/src/project-host/index.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {CACHE_SCHEMA_VERSION,createProjectFile,FORMAT4_HISTORY_SCHEMA_VERSION,FORMAT4_PROJECT_SCHEMA_VERSION,HISTORY_SCHEMA_VERSION,isProjectFileHeld,openProjectStore,PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/index.ts';
import {createProjectHomeServices} from '../packages/business/src/project-home.ts';
import {projectEntriesResponseSchema,projectEntryIdentitySchema,projectEntryResponseSchema} from '../packages/contracts/src/project-entry.ts';
import {calculateWorkspaceScope} from '../packages/contracts/src/workspace-scope.ts';
import type {ProjectEntriesResponse} from '../packages/contracts/src/project-entry.ts';
import type {ProjectEntryWindowRevoked} from '../packages/contracts/src/project-entry-native.ts';
import type {RecentProject} from '../packages/contracts/src/project-registry.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {timelineOutputPreset} from '../packages/contracts/src/timeline-output-geometry.ts';
import {createServerProject, openServerProject,schemaObjects} from './helpers/project-database.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const token = 'project-entry-server-synthetic-token';
const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,0,1,0,1,3,1,0x22,0,2,0x11,1,3,0x11,1,0xff,0xda,0,12,3,1,0,2,0x11,3,0x11,0,0x3f,0,0x12,0x34,0xff,0xd9]);
interface WireBody<T> {ok: boolean; data?: T; error?: {code: string; details?: unknown}}
type Server = Awaited<ReturnType<typeof startServer>>;

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function fixture(t: TestContext, channel: ServerOptions['localDraftChannel'] = 'web', {externalProjectsRoot = false,rejectBackup = false,candidateB = false} = {}) {
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
  const bLocation = {localDir: b.store.localDir, cacheDir: b.store.cacheDir, tempDir: b.store.tempDir};
  b.store.close();
  if (candidateB) {
    const candidate = openProjectStore({projectFile: bFile, locate: () => bLocation, format4: {approveUpgrade: () => true}});
    try {
      assert.equal(candidate.db.prepare('PRAGMA project.user_version').get()?.user_version, FORMAT4_PROJECT_SCHEMA_VERSION);
      assert.equal(candidate.db.prepare('SELECT version FROM main.schema_version').get()?.version, FORMAT4_HISTORY_SCHEMA_VERSION);
    } finally {candidate.close();}
  }
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
  let inspect!: InspectProject, inspectApplication!: InspectApplication,backupAttempts=0;
  server = await startServer({dataDir, projectsDir, port: 0, token, localDraftChannel: channel,
    inspectProject: received => {inspect = received;},inspectApplication:received=>{inspectApplication=received;},
    ...(rejectBackup?{projectBackupCopyForTest:async()=>{backupAttempts++;throw Error('Metadata reads must not start backups');}}:{})});
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
    application:<T>(read:(db:DatabaseSync)=>T)=>inspectApplication(read),backupAttempts:()=>backupAttempts,
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

function restoreFsMocks(t: TestContext): void {
  t.mock.restoreAll();
  syncBuiltinESMExports();
}

function registry(f: Fixture): readonly RecentProject[] {
  return f.server.projectEntries.listRecent().registered.map(entry => entry.project);
}

test('application catalog retains the physical application identity and reads metadata without a runtime or legacy route', async t => {
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
  assert.equal(entries.appLibraryScope, calculateWorkspaceScope({channel: 'web', root: f.dataDir,
    directory: lstatSync(f.dataDir), db: lstatSync(path.join(f.dataDir, 'app-library.db'))}));
  for (const method of ['GET', 'PUT']) {
    const legacy = await f.json('/api/last-project', {method});
    assert.equal(legacy.status, 404); assert.equal(legacy.body.error?.code, 'NOT_FOUND');
  }
  const cover = await f.fetch(`/api/project-covers/${f.a.projectId}`);
  assert.equal(cover.status, 200); assert.deepEqual(Buffer.from(await cover.arrayBuffer()), jpeg);
  assert.equal(a.db.isOpen, true); assert.equal(b.db.isOpen, true);
  const selected=await f.json(`/api/project-entries/${f.a.projectId}`);
  assert.equal(selected.status,200);assert.equal(selected.body.ok,true);
  const descriptor=projectEntryResponseSchema.parse(selected.body.data);
  assert.deepEqual(descriptor.entry,entries.registered.find(entry=>entry.project.projectId===f.a.projectId));
  assert.equal(descriptor.instanceId,entries.instanceId);assert.equal(descriptor.appLibraryScope,entries.appLibraryScope);
  assert.equal(a.db.isOpen,true);assert.equal(b.db.isOpen,true);
});

test('default web routes keep the released project format and report the candidate pair as too new', async t => {
  const f = await fixture(t, 'web', {candidateB: true});
  const call = (projectId: string) => f.json(projectRpcPath(projectId), {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({operation: 'timeline.get', input: {projectId}})});
  const stable = await call(f.a.projectId);
  assert.equal(stable.status, 200);
  assert.equal(stable.body.ok, true);
  const db = f.native(f.a.projectId);
  assert.equal(db.prepare('PRAGMA project.user_version').get()?.user_version, PROJECT_FILE_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT version FROM main.schema_version').get()?.version, HISTORY_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT version FROM cache.schema_version').get()?.version, CACHE_SCHEMA_VERSION);

  const recent = (await f.catalog()).registered.find(entry => entry.project.projectId === f.b.projectId);
  const candidate = await call(f.b.projectId);
  assert.equal(candidate.status, 409);
  assert.equal(candidate.body.ok, false);
  assert.equal(candidate.body.error?.code, 'PROJECT_UNAVAILABLE');
  assert.deepEqual(candidate.body.error?.details, {projectId: f.b.projectId, reason: 'PROJECT_FORMAT_NEWER'});
  assert.ok(recent);
  assert.deepEqual(recent.availability, {state: 'invalid', reason: 'format-newer'});
});

test('a catalog shares one private identity scan but checks each project and refreshes on the next read', async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-catalog-snapshot-'));
  const directories = serverAppDirectories(path.join(root, 'app'));
  mkdirSync(directories.projectsDir, {recursive: true});
  const registry = createMemoryProjectRegistry();
  const candidates = ['Stable', 'Candidate'].map((name, index) => {
    const projectFile = path.join(directories.projectsDir, `${name}.mioon`);
    const projectId = createProjectFile(projectFile, index === 0 ? {} : {format4: {}});
    const fileIdentity = statProjectFileIdentity(projectFile);
    assert.ok(fileIdentity);
    registry.upsert({projectId, name, projectFile, fileIdentity, lastOpenedAt: null, summary: null});
    return projectFile;
  });
  const secret = path.join(directories.dataDir, 'private-settings.json');
  let reads: string[] = [], rejectRefresh = false;
  const guard = createApplicationFileGuard(directories, {metadata(file) {
    reads.push(file);
    if (file === directories.dataDir && rejectRefresh) throw new Error('Synthetic unavailable private root');
    const stat = lstatSync(file, {bigint: true, throwIfNoEntry: false});
    // Simulate the candidate being a private inode moved outside the protected
    // tree, independently of filesystem inode and creation-time reuse rules.
    return file === secret && stat ? lstatSync(candidates[1]!, {bigint: true}) : stat;
  }});
  const manager = createProjectHostManager({directories, registry, factory: async () => assert.fail('Catalog must not create a project runtime'),
    maintenance: {recoverProjectFile: () => ({state: 'clean'})}});
  const shutdown = new AbortController();
  t.after(async () => {
    shutdown.abort();
    try { await manager.closeAll(); }
    finally { rmSync(root, {recursive: true, force: true}); }
  });
  const {control} = createProjectEntries({manager, registry, projectsDir: directories.projectsDir, channel: 'web', signal: shutdown.signal,
    readScope: () => 'a'.repeat(64), createProject: async () => assert.fail('Catalog must not create a project'), refreshSummaries() {}, assertProjectFile: guard});
  const opened: string[] = [];
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file: Parameters<typeof open>[0], flags: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
    if (candidates.includes(String(file))) opened.push(String(file));
    return open(file, flags, mode);
  });
  syncBuiltinESMExports();
  t.after(() => restoreFsMocks(t));

  const readCatalog = () => {
    reads = [];
    return control.listRecent().registered.map(entry => entry.availability);
  };
  assert.deepEqual(readCatalog(), [{state: 'available'}, {state: 'invalid', reason: 'format-newer'}]);
  assert.equal(reads.filter(file => file === directories.dataDir).length, 1);
  for (const file of candidates) assert.equal(reads.filter(candidate => candidate === file).length, 1);
  assert.deepEqual(opened, candidates);

  writeFileSync(secret, '{}', {mode: 0o600});
  opened.length = 0;
  assert.deepEqual(readCatalog(), [{state: 'available'}, {state: 'available'}]);
  assert.equal(reads.filter(file => file === directories.dataDir).length, 1);
  assert.ok(reads.includes(secret), 'the second read refreshes private identities before reading any project header');
  for (const file of candidates) assert.equal(reads.filter(candidate => candidate === file).length, 1);
  assert.deepEqual(opened, [], 'a same-generation hint avoids opening the stable file, and the private guard still rejects a previously cached inode');

  const stable = candidates[0]!, bytes = readFileSync(stable), previousMtime = fs.statSync(stable).mtime;
  bytes.writeUInt32BE(FORMAT4_PROJECT_SCHEMA_VERSION, 60);
  writeFileSync(stable, bytes);
  fs.utimesSync(stable, previousMtime, new Date(previousMtime.getTime() + 2000));
  opened.length = 0;
  assert.deepEqual(readCatalog(), [{state: 'invalid', reason: 'format-newer'}, {state: 'available'}]);
  assert.deepEqual(opened, [stable], 'a changed generation is read again');

  rejectRefresh = true;
  assert.deepEqual(readCatalog(), [{state: 'available'}, {state: 'available'}]);
  assert.deepEqual(reads, [directories.dataDir], 'a failed snapshot exposes no project header hints');
});

test('application identity GET bypasses private tree scans and slow project-file opens', async t => {
  const f = await fixture(t, 'production'), route = '/api/project-entries/identity';
  const cache = path.join(f.dataDir, 'cache', 'synthetic-tree');
  mkdirSync(cache, {recursive: true});
  for (let index = 0; index < 16; index++) {
    const folder = path.join(cache, String(index));
    mkdirSync(folder);
    for (let item = 0; item < 64; item++) writeFileSync(path.join(folder, String(item)), '');
  }
  let slowOpens = 0, cacheScans = 0, projectStats = 0;
  const open = fs.openSync, readdir = fs.readdirSync, lstat = fs.lstatSync;
  const delay = new Int32Array(new SharedArrayBuffer(4));
  const injectedDelayMs = 120;
  t.mock.method(fs, 'openSync', (file: Parameters<typeof open>[0], flags: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
    if (file === f.b.projectFile) {
      slowOpens++;
      Atomics.wait(delay, 0, 0, injectedDelayMs);
    }
    return open(file, flags, mode);
  });
  t.mock.method(fs, 'lstatSync', (file: Parameters<typeof lstat>[0], options?: Parameters<typeof lstat>[1]) => {
    if (file === f.b.projectFile) projectStats++;
    return lstat(file, options);
  });
  t.mock.method(fs, 'readdirSync', (file: Parameters<typeof readdir>[0], options: Parameters<typeof readdir>[1]) => {
    if (file === cache) cacheScans++;
    return readdir(file, options);
  });
  syncBuiltinESMExports();
  t.after(() => restoreFsMocks(t));

  assert.equal((await fetch(f.server.url + route)).status, 401);
  const foreign = await f.json(route, {headers: {origin: 'https://foreign.invalid'}});
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error?.code, 'ORIGIN_REJECTED');
  for (const invalidRoute of [route + '?cursor=1', route + '/extra', route + '/', '/api/project-entries/%69dentity']) {
    const result = await f.json(invalidRoute);
    assert.equal(result.status, invalidRoute === route + '?cursor=1' ? 400 : 404);
  }
  const wrongMethod = await f.fetch(route, {method: 'POST'});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  await wrongMethod.arrayBuffer();
  const getBody = await requestGetBody(f.server.url + route, {projectFile: '/outside'});
  assert.equal(getBody.status, 400);
  assert.equal(getBody.body.error?.code, 'VALIDATION_ERROR');

  const readIdentity = async () => {
    const response = await f.fetch(route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as WireBody<unknown>;
    assert.equal(body.ok, true);
    return projectEntryIdentitySchema.parse(body.data);
  };
  const from = performance.now();
  const identity = await readIdentity(), identityMs = performance.now() - from;
  assert.deepEqual(await readIdentity(), identity);
  assert.deepEqual({slowOpens, cacheScans, projectStats}, {slowOpens: 0, cacheScans: 0, projectStats: 0});
  const coldStart = performance.now();
  const catalog = await f.catalog(), coldCatalogMs = performance.now() - coldStart;
  assert.equal(slowOpens, 1);
  assert.equal(cacheScans, 2, 'recovery and header hints each take a fresh private identity snapshot');
  assert.ok(projectStats > 0);
  assert.ok(coldCatalogMs >= injectedDelayMs);
  assert.deepEqual(identity, {appLibraryScope: catalog.appLibraryScope, instanceId: catalog.instanceId});
  const warmStart = performance.now();
  assert.deepEqual(await f.catalog(), catalog);
  assert.equal(slowOpens, 1, 'subsequent catalogs retain the guarded same-generation header result');
  t.diagnostic(`1,024 synthetic cache files and one ${injectedDelayMs} ms open: identity ${identityMs.toFixed(1)} ms, cold catalog ${coldCatalogMs.toFixed(1)} ms, warm catalog ${(performance.now() - warmStart).toFixed(1)} ms`);
});

test('single registration metadata preserves closed project files, records and B1 rows without opening or backing up',async t=>{
  const f=await fixture(t,'web',{rejectBackup:true}),beforeRegistry=registry(f);
  const tree=(directory:string):unknown=>existsSync(directory)?readdirSync(directory,{recursive:true}).map(String).sort().map(name=>{
    const file=path.join(directory,name),stat=lstatSync(file);
    return{name,directory:stat.isDirectory(),bytes:stat.isFile()?readFileSync(file).toString('base64'):null};
  }):null;
  const files=()=>[f.projectsDir,path.join(f.dataDir,'records'),path.join(f.dataDir,'cache')].map(tree);
  const application=()=>f.application(db=>({changes:db.prepare('SELECT total_changes() n').get()!.n,
    rows:schemaObjects(db).filter(row=>row.type==='table').map(row=>({schema:row.schema,name:row.name,
      rows:db.prepare(`SELECT rowid,* FROM "${row.schema}"."${row.name}" ORDER BY rowid`).all()}))}));
  const beforeFiles=files(),beforeApplication=application();
  for(const project of [f.a,f.b]){
    const expected=beforeRegistry.find(entry=>entry.projectId===project.projectId)!;
    assert.equal(isProjectFileHeld(expected.fileIdentity),false);
    const read=async()=>{
      const response=await f.fetch(`/api/project-entries/${project.projectId}`);
      assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
      const body=await response.json() as WireBody<unknown>;assert.equal(body.ok,true);
      return projectEntryResponseSchema.parse(body.data);
    };
    const first=await read(),again=await read();assert.deepEqual(again,first);
    assert.equal(first.version,1);assert.equal(first.entry.project.projectId,project.projectId);
    assert.equal(first.entry.project.projectFile,project.projectFile);assert.deepEqual(first.entry.project.fileIdentity,expected.fileIdentity);
    const actual=lstatSync(project.projectFile,{bigint:true});
    assert.deepEqual(first.entry.project.fileIdentity,{dev:String(actual.dev),ino:String(actual.ino)});
    assert.deepEqual(first.entry.project,expected);assert.equal(first.entry.project.lastOpenedAt,null);
    assert.equal(first.entry.coverUrl,project.projectId===f.a.projectId?`/api/project-covers/${project.projectId}`:null);
    assert.equal(Object.hasOwn(first,'registered'),false);
    assert.equal(isProjectFileHeld(expected.fileIdentity),false);assert.equal(f.backupAttempts(),0);
    assert.deepEqual(application(),beforeApplication);assert.deepEqual(files(),beforeFiles);assert.deepEqual(registry(f),beforeRegistry);
  }
});

test('single registration metadata requires authenticated exact canonical GET with no query or body controls',async t=>{
  const f=await fixture(t,'web',{rejectBackup:true}),route=`/api/project-entries/${f.a.projectId}`,before=registry(f);
  assert.equal((await fetch(f.server.url+route)).status,401);
  const foreign=await f.json(route,{headers:{origin:'https://foreign.invalid'}});assert.equal(foreign.status,403);assert.equal(foreign.body.error!.code,'ORIGIN_REJECTED');
  for(const query of [`projectId=${f.a.projectId}`,'path=%2Foutside','projectFile=%2Foutside','root=%2Foutside','cursor=1']){
    const result=await f.json(route+'?'+query);assert.equal(result.status,400);assert.equal(result.body.error!.code,'VALIDATION_ERROR');
  }
  const getBody=await requestGetBody(f.server.url+route,{projectFile:'/outside',kind:'window'});assert.equal(getBody.status,400);assert.equal(getBody.body.error!.code,'VALIDATION_ERROR');
  for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS']){
    const response=await f.fetch(route,{method});assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'GET');await response.arrayBuffer();
  }
  const unknownId=randomUUID(),unknown=await f.json(`/api/project-entries/${unknownId}`);assert.equal(unknown.status,404);assert.equal(unknown.body.error!.code,'PROJECT_NOT_FOUND');
  const encoded='%'+f.a.projectId.charCodeAt(0).toString(16)+f.a.projectId.slice(1);
  for(const tail of ['not-an-id','AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',encoded,encodeURIComponent(f.a.projectId+'/extra'),f.a.projectId+'/',f.a.projectId+'/extra']){
    const result=await f.json('/api/project-entries/'+tail);assert.equal(result.status,404);assert.equal(result.body.ok,false);
  }
  assert.equal(f.backupAttempts(),0);assert.deepEqual(registry(f),before);
});

for (const firstRead of ['http', 'trusted'] as const) {
  test(`${firstRead} catalog refreshes an open editor's summary without opening a closed project`, async t => {
    t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-11-03T00:00:00.000Z')});
    const f = await fixture(t, 'production'), windowId = randomUUID();
    const opened = await f.server.projectEntries.acquire({projectId: f.a.projectId, windowId});
    const editor = f.native(f.a.projectId), closed = f.hold(f.b.projectId);
    const before = f.server.projectEntries.listRecent();
    const previous = before.registered.find(entry => entry.project.projectId === f.a.projectId)!.project;
    const closedBefore = before.registered.find(entry => entry.project.projectId === f.b.projectId)!;
    assert.equal(closedBefore.project.lastOpenedAt, null);
    // The kernel calls a same-process external holder "open-here". Inspection
    // must still hit its lock: this server has no runtime to borrow for B.
    const assertNotHosted = () => {
      assert.throws(() => f.native(f.b.projectId), error =>
        object(error).code === 'PROJECT_UNAVAILABLE' && object(object(error).details).reason === 'PROJECT_LOCKED');
      assert.equal(closed.db.isOpen, true); assert.equal(closed.db.prepare('SELECT 1 AS value').get()!.value, 1);
    };
    assertNotHosted();
    assert.deepEqual([previous.summary!.width, previous.summary!.height, previous.summary!.durationFrames, previous.summary!.cover], [1080, 1920, 0, null]);
    const call = async (operation: string, input: unknown): Promise<Record<string, unknown>> => {
      const response = await f.json(projectRpcPath(f.a.projectId), {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({operation, input})});
      assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.ok, true);
      return object(response.body.data);
    };
    const format = await call('timeline.format.get', {projectId: f.a.projectId});
    const updatedAt = '2026-11-03T00:00:10.000Z';
    t.mock.timers.setTime(Date.parse(updatedAt));
    await call('timeline.format.set', {projectId: f.a.projectId, expectedProjectRevision: format.projectRevision,
      expectedRevision: format.timelineRevision, requestId: randomUUID(), presetId: 'landscape_720'});
    const asset = await call('asset.import', {projectId: f.a.projectId, name: 'Catalog synthetic source.png', mimeType: 'image/png',
      dataBase64: png({width: 16, height: 16, rgba: false, pixel: () => [255, 0, 0]}).toString('base64')});
    const timeline = await call('timeline.get', {projectId: f.a.projectId});
    assert.ok(Array.isArray(timeline.tracks));
    const track = timeline.tracks.map(object).find(row => row.kind === 'video'); assert.ok(track);
    await call('timeline.clip.add', {projectId: f.a.projectId, requestId: randomUUID(), expectedRevision: timeline.revision,
      assetId: asset.id, trackId: track.id, startFrame: 15, durationFrames: 30});
    // Each endpoint is the first summary read in its own case. Calling the old
    // summary RPC (or the other catalog) first would hide a stale-cache bug.
    const refreshed = firstRead === 'http' ? await f.catalog() : f.server.projectEntries.listRecent();
    const other = firstRead === 'http' ? f.server.projectEntries.listRecent() : await f.catalog();
    for (const entries of [refreshed, other]) {
      const current = entries.registered.find(entry => entry.project.projectId === f.a.projectId)!;
      assert.deepEqual(current.availability, {state: 'open'});
      assert.deepEqual([current.project.summary!.width, current.project.summary!.height, current.project.summary!.fps,
        current.project.summary!.presetId, current.project.summary!.durationFrames], [1280, 720, 30, 'landscape_720', 45]);
      assert.equal(current.project.summary!.updatedAt, updatedAt);
      assert.deepEqual(current.project.summary!.cover, {assetId: asset.id, mimeType: 'image/png'});
      assert.equal(current.coverUrl, `/api/project-covers/${f.a.projectId}`);
      assert.equal(current.project.lastOpenedAt, opened.project.lastOpenedAt, 'refreshing metadata is not another successful open');
      const untouched = entries.registered.find(entry => entry.project.projectId === f.b.projectId)!;
      assert.deepEqual(untouched, closedBefore);
    }
    assertNotHosted();
    assert.equal(editor.isOpen, true); assert.equal(closed.db.isOpen, true);
    assert.equal(closed.db.prepare('SELECT 1 AS value').get()!.value, 1);
    f.server.projectEntries.release({windowId});
  });
}

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
  for(const projectId of [external.projectId,peer.projectId,candidateId]){
    const single=await f.json(`/api/project-entries/${projectId}`);assert.equal(single.status,404);assert.equal(single.body.error!.code,'PROJECT_NOT_FOUND');
  }
  const selected=await f.json(`/api/project-entries/${f.a.projectId}`);assert.equal(selected.status,200);
  assert.equal(projectEntryResponseSchema.parse(selected.body.data).entry.project.projectFile,f.a.projectFile);
  assert.ok(!registry(f).some(entry => entry.projectId === candidateId));
  assert.deepEqual(registry(f), before); assert.deepEqual(readFileSync(candidate), candidateBytes);
  const missing = await f.server.projectEntries.create({name: 'Missing'});
  rmSync(missing.projectFile);
  assert.deepEqual((await f.catalog()).registered.find(entry => entry.project.projectId === missing.projectId)!.availability, {state: 'missing'});
  const missingSingle=await f.json(`/api/project-entries/${missing.projectId}`);assert.equal(missingSingle.status,200);
  const missingDescriptor=projectEntryResponseSchema.parse(missingSingle.body.data);
  assert.equal(missingDescriptor.entry.project.projectFile,missing.projectFile);assert.deepEqual(missingDescriptor.entry.availability,{state:'missing'});
});

for (const channel of ['production', 'development'] as const) {
  test(`${channel} catalog includes registered external projects without acquiring them`, async t => {
    const f = await fixture(t, channel), outside = path.join(f.root, 'outside'); mkdirSync(outside);
    const entry = await f.server.projectEntries.create({name: 'Native external', parentDir: outside});
    const held = f.hold(entry.projectId), data = await f.catalog();
    assert.ok(data.registered.some(item => item.project.projectId === entry.projectId));
    assert.deepEqual(data, f.server.projectEntries.listRecent());
    const single=await f.json(`/api/project-entries/${entry.projectId}`);assert.equal(single.status,200);
    assert.deepEqual(projectEntryResponseSchema.parse(single.body.data).entry,data.registered.find(item=>item.project.projectId===entry.projectId));
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
  const db = f.native(projectId);
  assert.equal(db.prepare('PRAGMA project.user_version').get()?.user_version, PROJECT_FILE_SCHEMA_VERSION);
  assert.equal((await f.catalog()).newProjectFormatVersion, PROJECT_FILE_SCHEMA_VERSION);
  assert.equal(f.server.projectEntries.listRecent().newProjectFormatVersion, PROJECT_FILE_SCHEMA_VERSION);
  const row = db.prepare('SELECT data FROM project.projects WHERE id=?').get(projectId);
  assert.equal(object(JSON.parse(String(row!.data))).description, 'Public description');
  const timeline = db.prepare('SELECT data FROM project.timelines WHERE projectId=?').get(projectId);
  assert.equal(timelineOutputPreset(object(JSON.parse(String(timeline!.data))))?.id, 'landscape_1080');
  const outside = path.join(f.root, 'not-created');
  const rejected = await f.rpc('project.create', {name: 'No HTTP paths', parentDir: outside});
  assert.equal(rejected.status, 400); assert.equal(rejected.body.error!.code, 'VALIDATION_ERROR');
  assert.equal(existsSync(outside), false);
  f.server.projectEntries.release({windowId});
});

test('trusted recent preparation resolves a completely moved directory before location admission without opening the project', async t => {
  const f = await fixture(t, 'production'), old = f.a.projectFile;
  const movedDirectory = path.join(path.dirname(path.dirname(old)), 'Moved Catalog A');
  renameSync(path.dirname(old), movedDirectory);
  assert.equal(existsSync(path.dirname(old)), false);
  const projectFile = path.join(movedDirectory, path.basename(old));
  const before = readFileSync(projectFile);
  const prepared = await f.server.projectEntries.prepareAcquire!({projectId: f.a.projectId});
  assert.equal(prepared.projectFile, projectFile);
  assert.equal(prepared.lastOpenedAt, null, 'metadata resolution is not a successful open');
  assert.deepEqual(readFileSync(projectFile), before);
  const held = f.hold(f.a.projectId);
  assert.equal(held.db.isOpen, true, 'preparation held no project connection or lock');
  held.close();
  const windowId = randomUUID();
  const opened = await f.server.projectEntries.acquire({projectId: f.a.projectId, windowId, expectedProjectFile: projectFile});
  assert.equal(opened.project.projectFile, projectFile);
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

test('provisional native opens update recent metadata once and only for a live ready window', async t => {
  const f = await fixture(t, 'production'), control = f.server.projectEntries;
  const cancelled = randomUUID(), ready = randomUUID(), contextId = randomUUID();
  const lastOpenedAt = (projectId: string) => registry(f).find(entry => entry.projectId === projectId)!.lastOpenedAt;
  const uiRecent = async () => {
    const response = await f.json<{recentOpened: Record<string, string>}>('/api/ui-preferences');
    assert.equal(response.status, 200);
    return response.body.data!.recentOpened;
  };
  assert.equal(lastOpenedAt(f.a.projectId), null);
  assert.equal(lastOpenedAt(f.b.projectId), null);

  const first = await control.acquire({projectId: f.a.projectId, expectedProjectFile: f.a.projectFile,
    windowId: cancelled, deferRecent: true});
  assert.equal(first.project.lastOpenedAt, null);
  assert.equal(lastOpenedAt(f.a.projectId), null);
  control.release({windowId: cancelled});
  await assert.rejects(async () => control.markOpened!({windowId: cancelled, contextId}), {code: 'PROJECT_ENTRY_UNAVAILABLE'});

  const second = await control.openPath({projectFile: f.b.projectFile, windowId: ready, deferRecent: true});
  assert.equal(second.project.lastOpenedAt, null);
  await assert.rejects(async () => control.markOpened!({windowId: randomUUID(), contextId}), {code: 'PROJECT_ENTRY_UNAVAILABLE'});
  assert.equal(lastOpenedAt(f.a.projectId), null);
  assert.equal(lastOpenedAt(f.b.projectId), null, 'no ready acknowledgement has been received');
  assert.deepEqual(await uiRecent(), {});
  assert.equal(await control.markOpened!({windowId: ready, contextId}), true);
  assert.ok(lastOpenedAt(f.b.projectId));
  assert.equal(lastOpenedAt(f.a.projectId), null);
  assert.deepEqual(await uiRecent(), {[f.b.projectId]: lastOpenedAt(f.b.projectId)}, 'both records use the exact accepted open time');
  const changes = f.application(db => db.prepare('SELECT total_changes() n').get()!.n);
  assert.equal(await control.markOpened!({windowId: ready, contextId}), true);
  assert.equal(f.application(db => db.prepare('SELECT total_changes() n').get()!.n), changes, 'repeated readiness performs no application write');
  assert.equal(await control.markOpened!({windowId: ready, contextId: randomUUID()}), true);
  assert.ok(Number(f.application(db => db.prepare('SELECT total_changes() n').get()!.n)) > Number(changes),
    'a reloaded editor can record its new document readiness');
  assert.deepEqual(await uiRecent(), {[f.b.projectId]: lastOpenedAt(f.b.projectId)});
  control.release({windowId: ready});
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
