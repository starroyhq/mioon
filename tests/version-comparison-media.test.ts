import type {FixtureAsset,FixtureVersion} from './helpers/strict-timeline-core-types.ts';
import type {AddressInfo} from 'node:net';
import type {RootFailure} from './helpers/strict-root-error-types.ts';
import type {TypedStore, TypedServices, MediaJob, GenerationSnapshot} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtemp, writeFile, readFile, readdir, rm, open, rename, symlink, link, chmod, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {getWorkspaceRestoreContext, ownsStoreLock} from '../packages/business/src/db.ts';
import {workspaceRestoreError} from '../packages/business/src/workspace-restore-policy.ts';
import {validateManagedFile} from '../packages/contracts/src/private-storage.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {createFileResponses} from '../apps/server/src/file-response.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices, type JobRecord, type ServiceRow} from '../packages/business/src/services.ts';
import {createProviderRegistry, type Provider} from '../packages/business/src/provider-registry.ts';
import {startWorker, type Worker} from '../packages/business/src/jobs.ts';
import {safePath} from '../packages/business/src/media.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {startServer} from '../apps/server/src/index.ts';
import {createVersionComparisonMediaHttp, readVersionComparisonMedia, versionComparisonMediaIdentity, type VersionComparisonMediaOptions} from '../apps/server/src/version-comparison-media.ts';
import type { BinaryLike } from 'crypto';
import type { CreateReadStreamOptions, FileHandle } from 'fs/promises';
import type { PathLike } from 'fs';

const token = 'synthetic-version-comparison-media-token';
const hash = (bytes: NonSharedBuffer|BinaryLike) => createHash('sha256').update(bytes).digest('hex');
async function manifest(root: string, relative: string|undefined = ''): Promise<({directory: string} | {file: string; hash: string})[]> {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push({directory: name}, ...await manifest(root, name));
    else if (!/^workbench\.sqlite(?:-wal|-shm)?$/.test(name) && name !== 'server.lock') result.push({file: name, hash: hash(await readFile(path.join(root, name)))});
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function replace(db: DatabaseSync, table: string, record: Record<string, unknown> & {id: string}) {db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(record), record.id);}
async function fixture(t: test.TestContext, {serve = true, published = false} = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'mioon-version-comparison-')), root = path.join(base, 'source');
  let store: TypedStore | undefined = (openStore(root) as unknown as TypedStore), services: TypedServices | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined, db: DatabaseSync | undefined, worker: Worker | undefined;
  t.after(async () => {await server?.close(); await worker?.stop(); db?.close(); await services?.drain(); store?.close(); await rm(base, {recursive: true, force: true});});
  const providers = createProviderRegistry({db: store.db, root, env: {MIOON_ENABLE_LIVE_PROVIDER: '0'}});
  services = (createServices(store, providers) as unknown as TypedServices);
  const project = await services.call('project.create', {name: 'Comparison source'});
  const foreign = await services.call('project.create', {name: 'Foreign project'});
  const shot = await services.call('shot.create', {projectId: project.id, title: 'Immutable source', prompt: 'Synthetic offline shape', duration: 2});
  const otherShot = await services.call('shot.create', {projectId: project.id, title: 'Other shot'});
  const input = {shotId: shot.id, expectedRevision: shot.revision, requestId: randomUUID(), providerId: 'mock', parameters: {delayMs: 0}};
  const submitted = await services.call('generation.submit', input);
  let job: MediaJob, version: FixtureVersion & {snapshot?: GenerationSnapshot;providerId?: string;model?: string;isMock?: boolean;createdAt?: string}, asset: FixtureAsset, bytes: Buffer;
  if (published) {
    worker = startWorker(store, services, providers);
    for (let count = 0; count < 10 && (store.get('jobs', submitted.id))!.status !== 'succeeded'; count++) await worker.tick();
    await worker.stop(); worker = undefined;
    job = store.get('jobs', submitted.id)!; assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    version = store.get('versions', job.versionId!)!; asset = store.get('assets', version.assetId)!; bytes = await readFile(path.join(root, asset.relativePath));
  } else {
    // Real submitted snapshot and production publication shape; only the media
    // payload is synthetic so corruption/transport cases never need decoding.
    job = store.get('jobs', submitted.id)!;
    bytes = Buffer.from('immutable-shot-version-original-mp4-bytes');
    asset = {id: randomUUID(), projectId: project.id, name: 'Mock output.mp4', mimeType: 'video/mp4', width: 720, height: 1280,
      duration: 2, hasVideo: true, hasAudio: false, sha256: hash(bytes), sizeBytes: bytes.length, relativePath: `media/result-${job.id}.mp4`,
      provenance: 'synthetic-mock', createdAt: job.createdAt} as FixtureAsset;
    asset.url = `/media/${asset.id}`;
    await writeFile(path.join(root, asset.relativePath), bytes, {mode: 0o600}); store.put('assets', asset);
    version = {id: randomUUID(), projectId: project.id, shotId: shot.id, jobId: job.id, number: 1, providerId: job.providerId,
      model: job.model, isMock: true, snapshot: job.snapshot, assetId: asset.id, url: asset.url, sha256: asset.sha256, createdAt: job.createdAt};
    store.put('versions', version);
    job = {...job, status: 'succeeded', phase: 'complete', versionId: version.id, progress: 100, error: null}; store.put('jobs', job);
  }
  // Historical playback must not follow current shot selection.
  store.put('shots', {...store.get('shots', shot.id), selectedVersionId: null});
  const route = '/api/version-comparison/media?' + new URLSearchParams({projectId: project.id, shotId: shot.id, versionId: version.id,
    assetId: asset.id, sha256: asset.sha256, workspaceOrigin: 'normal'}), url = new URL(route, 'http://127.0.0.1:12345');
  if (serve) {
    await services.drain(); services = undefined; store!.close(); store = undefined;
    server = await startServer({dataDir: root, port: 0, token, chatGateway: async function* () {assert.fail('Media must not call AI');}});
    db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
  }
  const database = () => db || store!.db;
  const rows = () => Object.fromEntries(database().prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) =>
    [name, database().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const checkpoint = async () => ({rows: rows(), version: (database().prepare('PRAGMA data_version').get())!.data_version, files: await manifest(root)});
  return {base, root, project, foreign, shot, otherShot, job, version, asset, bytes, route, url,
    get db() {return database();}, get store() {return store!;}, get server() {return server!;},
    read: () => readVersionComparisonMedia(database(), url, projectId => createOwnedMediaGraphReader(database(), projectId)), checkpoint,
    unchanged: async (before: Awaited<ReturnType<typeof checkpoint>>) => {assert.deepEqual(rows(), before.rows); assert.equal((database().prepare('PRAGMA data_version').get())!.data_version, before.version); assert.deepEqual(await manifest(root), before.files);},
    request: (selected: unknown = route, options: RequestInit|undefined = {}) => fetch(server!.url + selected, {...options, headers: {authorization: 'Bearer ' + token, ...options.headers}}),
    closeSource: async () => {await services?.drain(); services = undefined; store!.close(); store = undefined;}};
}

async function directServer(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>, options: Partial<VersionComparisonMediaOptions> = {}) {
  const media = createVersionComparisonMediaHttp({db: f.db, root: f.root, readGraph: projectId => createOwnedMediaGraphReader(f.db, projectId),
    validateFile: file => validateManagedFile(file, {root: f.root})!, createFiles: createFileResponses, resolvePath: safePath,
    assertAvailable: () => {if (getWorkspaceRestoreContext(f.store)) throw workspaceRestoreError(); if (!ownsStoreLock(f.store)) throw Object.assign(Error('Unavailable'), {code: 'FILE_UNAVAILABLE', status: 404});}, ...options});
  const server = http.createServer(async (req, res) => {
    try {if (!await media.handle(req, res, new URL(req.url!, 'http://127.0.0.1'))) res.writeHead(404).end();}
    catch (error) {res.writeHead((error as RootFailure).status || 500); res.end((error as RootFailure).code);}
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await media.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return (options: RequestInit|undefined = {}) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${f.route}`, options);
}

for (const published of [false, true]) test(`comparison GET/HEAD/ranges serve exact ${published ? 'production Mock-published' : 'historical'} version with no writes`, async t => {
  const f = await fixture(t, {published}), before = await f.checkpoint(); assert.ok(f.read());
  for (const [options, status, expected] of [
    [{}, 200, f.bytes], [{method: 'HEAD'}, 200, Buffer.alloc(0)],
    [{headers: {range: 'bytes=2-7'}}, 206, f.bytes.subarray(2, 8)],
    [{headers: {range: 'bytes=-4'}}, 206, f.bytes.subarray(-4)],
    [{headers: {range: 'bytes=2-'}}, 206, f.bytes.subarray(2)],
    [{headers: {range: 'bytes=0-99999999'}}, 206, f.bytes],
    [{method: 'HEAD', headers: {range: 'bytes=-4'}}, 206, Buffer.alloc(0)],
  ] as [RequestInit,number,Buffer][]) {
    const response = await f.request(undefined, options); assert.equal(response.status, status);
    assert.equal(response.headers.get('content-type')!, 'video/mp4'); assert.equal(response.headers.get('content-disposition'), 'inline');
    assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-length'), String(options.method === 'HEAD' ? options.headers ? 4 : f.bytes.length : expected.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  for (const range of ['bytes=999999999-', 'bytes=7-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-2', 'bytes=9007199254740992-']) {
    for (const method of ['GET', 'HEAD']) {const response = await f.request(undefined, {method, headers: {range}}); assert.equal(response.status, 416, range); assert.equal((await response.arrayBuffer()).byteLength, 0);}
  }
  await f.unchanged(before);
});

test('exact query shape, identity, method, authentication and browser-origin envelope fail closed', async t => {
  const f = await fixture(t), before = await f.checkpoint();
  const invalid = [f.route + '&', f.route + '&unknown=1', f.route + '&path=/tmp/private', f.route + '&sha256=' + f.asset.sha256,
    f.route.replace('workspaceOrigin=normal', 'workspaceOrigin=' + randomUUID()), f.route.replace('workspaceOrigin=normal', 'workspaceOrigin=restored%3A' + randomUUID()),
    f.route.replace(f.asset.sha256, f.asset.sha256.toUpperCase()), f.route.replace(f.asset.sha256, f.asset.sha256 + '%0A'), f.route.replace(f.project.id, f.project.id + '%0A'), f.route.replace(f.asset.sha256, 'a'.repeat(63)), f.route.replace(f.asset.sha256, 'a'.repeat(64)),
    f.route.replace(f.project.id, 'bad%ZZ'), f.route.replace(f.shot.id, '%00' + f.shot.id), f.route + '&long=' + 'x'.repeat(2050)];
  for (const field of ['projectId', 'shotId', 'versionId', 'assetId', 'sha256', 'workspaceOrigin']) {
    const missing = new URL(f.url); missing.searchParams.delete(field); invalid.push(missing.pathname + missing.search);
    const duplicate = new URL(f.url); duplicate.searchParams.append(field, duplicate.searchParams.get(field)!); invalid.push(duplicate.pathname + duplicate.search);
  }
  for (const field of ['projectId', 'shotId', 'versionId', 'assetId']) {const missing = new URL(f.url); missing.searchParams.set(field, randomUUID()); invalid.push(missing.pathname + missing.search);}
  invalid.push(f.route.replace(f.project.id, f.foreign.id), f.route.replace(f.shot.id, f.otherShot.id));
  for (const route of invalid) {const response = await f.request(route); assert.equal(response.status, 404, route); const text = await response.text(); assert.ok(!text.includes(f.root)); assert.ok(!text.includes(f.asset.relativePath));}
  assert.equal(versionComparisonMediaIdentity(new URL(f.url + '#fragment')), null);
  const unauthorized = await fetch(f.server.url + f.route); assert.equal(unauthorized.status, 401); await unauthorized.text();
  const origin = await f.request(undefined, {headers: {origin: 'https://foreign.invalid'}}); assert.equal(origin.status, 403); await origin.text();
  const host = await new Promise<(number | undefined)>((resolve, reject) => {const request = http.get(f.server.url + f.route, {headers: {host: 'foreign.invalid', authorization: 'Bearer ' + token}}, response => {response.resume(); response.on('end', () => resolve(response.statusCode));}); request.on('error', reject);}); assert.equal(host, 403);
  const cookie = await fetch(f.server.url + f.route, {headers: {cookie: `mioon_session=${token}`}}); assert.equal(cookie.status, 200); await cookie.arrayBuffer();
  const post = await f.request(undefined, {method: 'POST'}); assert.equal(post.status, 405); assert.equal(post.headers.get('allow'), 'GET, HEAD'); await post.text();
  await f.unchanged(before);
});

test('SQL/JSON ownership, job/version/snapshot links, recorded hash and published output path all remain exact', async t => {
  const f = await fixture(t); f.db.exec('DROP TRIGGER immutable_versions; PRAGMA foreign_keys=OFF');
  const saved = Object.fromEntries(['projects', 'shots', 'jobs', 'versions', 'assets'].map(table => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]));
  const mutations = [
    () => f.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...f.project, id: f.foreign.id}), f.project.id),
    () => f.db.prepare('UPDATE shots SET projectId=? WHERE id=?').run(f.foreign.id, f.shot.id),
    () => replace(f.db, 'shots', {...f.shot, projectId: f.foreign.id}),
    () => replace(f.db, 'shots', {...f.shot, referenceAssetIds: [randomUUID()]}),
    () => f.db.prepare('UPDATE versions SET projectId=? WHERE id=?').run(f.foreign.id, f.version.id),
    () => replace(f.db, 'versions', {...f.version, projectId: f.foreign.id}),
    () => f.db.prepare('UPDATE versions SET jobId=? WHERE id=?').run(randomUUID(), f.version.id),
    ...['shotId', 'jobId', 'assetId', 'sha256'].map(key => () => replace(f.db, 'versions', {...f.version, [key]: key === 'sha256' ? 'b'.repeat(64) : randomUUID()})),
    () => replace(f.db, 'versions', {...f.version, sha256: undefined}),
    () => replace(f.db, 'versions', {...f.version, snapshot: {...f.version.snapshot!, projectId: f.foreign.id}}),
    () => replace(f.db, 'versions', {...f.version, snapshot: {...f.version.snapshot!, shotId: f.otherShot.id}}),
    () => f.db.prepare('UPDATE jobs SET projectId=? WHERE id=?').run(f.foreign.id, f.job.id),
    ...['projectId', 'shotId', 'versionId', 'assetId'].map(key => () => replace(f.db, 'jobs', {...f.job, [key]: randomUUID()})),
    () => f.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.foreign.id, f.asset.id),
    () => replace(f.db, 'assets', {...f.asset, projectId: f.foreign.id}),
    ...[{sha256: 'b'.repeat(64)}, {sizeBytes: -1}, {sizeBytes: undefined}, {mimeType: 'image/png'}, {provenance: 'export'}, {relativePath: 'media/../access-token'}, {relativePath: `media/result-${randomUUID()}.mp4`}]
      .map(patch => () => replace(f.db, 'assets', {...f.asset, ...patch})),
    () => f.db.prepare('UPDATE assets SET data=? WHERE id=?').run('{invalid', f.asset.id),
  ];
  for (const [index, mutate] of mutations.entries()) {
    mutate(); const before = await f.checkpoint(); assert.equal(f.read(), null, `Corruption case ${index}`);
    const response = await f.request(); assert.equal(response.status, 404); await response.text(); await f.unchanged(before);
    for (const [table, rows] of Object.entries(saved)) for (const row of rows) {
      const columns = Object.keys(row).filter(key => key !== 'id'); f.db.prepare(`UPDATE ${table} SET ${columns.map(key => `${key}=?`).join(',')} WHERE id=?`).run(...columns.map(key => row[key]), row.id);
    }
  }
  // URL metadata is not a source selector, even when it looks authoritative.
  replace(f.db, 'versions', {...f.version, url: 'https://foreign.invalid/never-fetch'}); replace(f.db, 'assets', {...f.asset, url: '/media/' + randomUUID()});
  const before = await f.checkpoint(), response = await f.request(); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes); await f.unchanged(before);
});

test('foreign and duplicate reverse owners cannot disguise generated bytes as another version', async t => {
  const f = await fixture(t);
  for (const projectId of [f.project.id, f.foreign.id]) {
    const id = randomUUID(), jobId = randomUUID();
    f.db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(jobId, projectId, JSON.stringify({...f.job, id: jobId, projectId, versionId: id}));
    f.db.prepare('INSERT INTO versions(id,projectId,jobId,data) VALUES(?,?,?,?)').run(id, projectId, jobId, JSON.stringify({...f.version, id, projectId, jobId}));
    const before = await f.checkpoint(); assert.equal(f.read(), null); const response = await f.request(); assert.equal(response.status, 404); await response.text(); await f.unchanged(before);
    f.db.prepare('DELETE FROM versions WHERE id=?').run(id); f.db.prepare('DELETE FROM jobs WHERE id=?').run(jobId);
  }
});

test('missing file, symlink, hardlink and other-writable files never disclose media', async t => {
  const f = await fixture(t), file = path.join(f.root, f.asset.relativePath), saved = file + '.saved';
  await rename(file, saved);
  for (const setup of [async () => {}, () => symlink(saved, file), () => link(saved, file), async () => {await writeFile(file, f.bytes); await chmod(file, 0o666);}]) {
    await setup(); const response = await f.request(); assert.equal(response.status, 404); await response.text(); await rm(file, {force: true});
  }
  await rename(saved, file);
});

for (const stage of ['resolve', 'open', 'stat']) test(`late ${stage} ownership changes are fenced before bytes and descriptors close`, async t => {
  const f = await fixture(t, {serve: false}); let opened = 0, closed = 0, streamed = 0;
  const corrupt = () => f.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.foreign.id, f.asset.id);
  const request = await directServer(t, f, {
    resolvePath: async (...args) => {const file = await safePath(...args); if (stage === 'resolve') corrupt(); return file;},
    openFile: async (...args) => {const handle = await open(...args); opened++; if (stage === 'open') corrupt(); let stats = 0;
      return {stat: async () => {const result = await handle.stat(); if (stage === 'stat' && ++stats === 2) corrupt(); return result;},
        close: async () => {closed++; await handle.close();}, createReadStream: (options?: CreateReadStreamOptions|undefined) => {streamed++; return handle.createReadStream(options);}};},
  });
  const response = await request(stage === 'stat' ? {headers: {range: 'bytes=9999999-'}} : {}); assert.equal(response.status, 404); assert.equal(await response.text(), 'FILE_UNAVAILABLE');
  assert.equal(opened, stage === 'resolve' ? 0 : 1); assert.equal(closed, opened); assert.equal(streamed, 0);
});

test('late path replacement and immutable record edits cannot reuse a valid earlier observation', async t => {
  for (const kind of ['inode', 'version']) {
    const f = await fixture(t, {serve: false}); f.db.exec('DROP TRIGGER immutable_versions'); let closed = 0, streamed = 0;
    const request = await directServer(t, f, {openFile: async (...args: [string,number]) => {
      const handle = await open(...args);
      if (kind === 'inode') {await rename(args[0], args[0] + '.old'); await writeFile(args[0], f.bytes, {mode: 0o600});}
      else replace(f.db, 'versions', {...f.version, number: 2});
      return {stat: () => handle.stat(), close: async () => {closed++; await handle.close();}, createReadStream: (options?: CreateReadStreamOptions|undefined) => {streamed++; return handle.createReadStream(options);}};
    }});
    const response = await request(); assert.equal(response.status, 404); await response.text(); assert.equal(closed, 1); assert.equal(streamed, 0);
  }
});

test('loss of actual workspace lock refuses playback, not just copied store metadata', async t => {
  const f = await fixture(t, {serve: false}); let opened = 0;
  const request = await directServer(t, f, {openFile: async (...args) => {opened++; return open(...args);}});
  await unlink(path.join(f.root, 'server.lock'));
  const response = await request(); assert.equal(response.status, 404); await response.text(); assert.equal(opened, 0);
});

test('restored workspace including held source versions refuses this route before file access', async t => {
  const f = await fixture(t, {serve: false}); await f.closeSource();
  const backup = path.join(f.base, 'backup'), destination = path.join(f.base, 'restored');
  await createWorkspaceBackup({source: f.root, destination: backup});
  const restored = await restoreWorkspaceBackup({directory: backup, destination});
  const server = await startServer({dataDir: destination, port: 0, token}); t.after(() => server.close());
  const db = new DatabaseSync(path.join(destination, 'workbench.sqlite')); t.after(() => db.close());
  assert.ok(db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='versions' AND id=?").get(f.version.id));
  const before = await manifest(destination), changes = (db.prepare('PRAGMA data_version').get())!.data_version;
  for (const origin of ['normal', restored.workspaceOrigin, 'restored:' + restored.workspaceOrigin]) {
    const url = new URL(f.route, server.url); url.searchParams.set('workspaceOrigin', origin as string);
    for (const method of ['GET', 'HEAD']) {const response = await fetch(url, {method, headers: {authorization: 'Bearer ' + token}}); assert.equal(response.status, 409); if (method === 'GET') assert.equal((await response.json()).error.code, 'RESTORE_OPERATION_UNAVAILABLE');}
  }
  assert.equal((db.prepare('PRAGMA data_version').get())!.data_version, changes); assert.deepEqual(await manifest(destination), before);
});
