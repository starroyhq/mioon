import type {Failure} from './helpers/strict-timeline-audio-types.ts';
import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtemp, writeFile, readFile, readdir, rm, unlink, open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {isTimelineRenderRecord} from '@mioon/contracts';
import {timelineDeliveryContentDisposition} from '@mioon/contracts/timeline-delivery';
import '@mioon/contracts/timeline-delivery';
import {createServices, type ServiceStore} from '../packages/business/src/services.ts';
import {readOwnedTimelineAsset} from '../packages/business/src/timeline-sources.ts';
import {readTimelineExportPreviewMedia, timelineExportPreviewIdentity, timelineExportPreviewResponseHeaders} from '../packages/business/src/timeline-delivery-read.ts';
import {startServer} from '../apps/server/src/index.ts';
import type {InspectProject} from '../apps/server/src/index.ts';
import {createFileResponses} from '../apps/server/src/file-response.ts';
import {createServerProject, openProjectDatabase, projectDirFor, schemaObjects, withoutForeignKeys} from './helpers/project-database.ts';
import type { BinaryLike } from 'crypto';

const token = 'synthetic-named-delivery-download-token';
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: NonSharedBuffer|BinaryLike) => createHash('sha256').update(value).digest('hex');
async function manifest(root: string, relative = '') {
  const result: ({ directory: string; } | unknown | { file: string; hash: string; })[] = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push({directory: name}, ...await manifest(root, name));
    else if (!/^workbench\.sqlite(?:-wal|-shm)?$/.test(name) && name !== 'server.lock') result.push({file: name, hash: hash(await readFile(path.join(root, name)))});
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function fixture(t: test.TestContext, {serve = true, named = false} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-named-download-'));
  let store: TypedStore|undefined, services: TypedServices|undefined, server: Awaited<ReturnType<typeof startServer>> | undefined, db: DatabaseSync|undefined, inspect: InspectProject|undefined;
  t.after(async () => {await server?.close(); db?.close(); await services?.drain(); store?.close(); await rm(root, {recursive: true, force: true});});
  const created = createServerProject(root, {name: 'Named delivery project'});
  store = (created.store as unknown as TypedStore); services = (createServices(store, new Map()) as TypedServices);
  const project = store.get('projects', created.projectId)!;
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const sourceId = randomUUID();
  store.put('assets', {id: sourceId, projectId: project.id, name: 'Frozen image', mimeType: 'image/png', sha256: 'a'.repeat(64),
    relativePath: `media/${sourceId}.png`, width: 720, height: 1280, duration: 0, hasAudio: false, sizeBytes: 20, createdAt: new Date().toISOString()});
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks[0].id, assetId: sourceId, startFrame: 0, durationFrames: 30});
  const input = {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export', ...(named ? {deliveryName: '海边 交付 V1'} : {})};
  const queued = await services.call('timeline.render', input);
  const assetId = randomUUID(), relativePath = `media/export-${queued.id}-${randomUUID()}.mp4`, bytes = Buffer.from('named-delivery-original-mp4-bytes');
  await writeFile(path.join(root, relativePath), bytes, {mode: 0o600});
  const asset = {id: assetId, projectId: project.id, name: 'Managed output', mimeType: 'video/mp4', provenance: 'export', relativePath,
    url: `/media/${assetId}`, sha256: hash(bytes), sizeBytes: bytes.length, createdAt: new Date().toISOString()};
  store.put('assets', asset);
  const record = {...(store.get('exports', queued.id) as import('./helpers/strict-timeline-core-types.ts').FixtureExport), status: 'succeeded', assetId, url: asset.url, updatedAt: new Date().toISOString()};
  store.put('exports', record);
  // A historical download stays available after edits remove the original clip.
  timeline = await services.call('timeline.clip.remove', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), clipId: timeline.clips[0].id});
  await services.drain(); services = undefined; store.close(); store = undefined;
  // The server knows the other project too; the tests damage rows to belong to it.
  const other = createServerProject(root, {name: 'Other project'}), foreign = (other.store as unknown as TypedStore).get('projects', other.projectId)!;
  other.store.close();
  if (serve) server = await startServer({dataDir: root, port: 0, token,
    chatGateway: async function* () {assert.fail('Download never calls a model or provider');},
    inspectProject: received => {inspect = received;}});
  else db = openProjectDatabase(projectDirFor(root, project.id));
  // While the server runs, the database is read and damaged on its own connection.
  const use = <T>(fn: (db: DatabaseSync) => T): T => inspect ? inspect(project.id, fn) : fn(db!);
  const guardsFor = (db: DatabaseSync) => ({isTimelineRenderRecord, readOwnedAsset: (projectId: string, assetId: unknown) => readOwnedTimelineAsset(db, projectId, assetId)});
  const route = `/media/${assetId}?preview=1&exportId=${record.id}`, url = new URL(route, 'http://127.0.0.1:12345');
  const rows = (db: DatabaseSync) => Object.fromEntries(schemaObjects(db).filter(({type}) => type === 'table').map(({name}) =>
    [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  // data_version counts other connections' commits only; total_changes() adds this connection's own writes.
  const changeMarks = (db: DatabaseSync) => [db.prepare('PRAGMA data_version').get()!.data_version, db.prepare('SELECT total_changes() AS n').get()!.n];
  const checkpoint = async () => ({...use(db => ({rows: rows(db), version: changeMarks(db)})), files: await manifest(root)});
  return {root, project, foreign, sourceId, timeline, queued, record, asset, bytes, input, route, url, use,
    // The test's own connection exists only while no server holds the project.
    get db() {if (inspect) throw new Error('The server holds the project: use f.use(db => ...)'); return db!;},
    get guards() {return guardsFor(this.db);},
    read: () => use(db => readTimelineExportPreviewMedia(db, url, guardsFor(db))), checkpoint,
    unchanged: async (before: { rows: unknown; version: unknown; files: unknown; }) => {use(db => {assert.deepEqual(rows(db), before.rows); assert.deepEqual(changeMarks(db), before.version);}); assert.deepEqual(await manifest(root), before.files);},
    request: (selected = route, options: RequestInit = {}) => fetch(server!.url + selected, {...options, headers: {authorization: 'Bearer ' + token, ...options.headers}}),
    get server() {return server;}};
}

function replace(db: DatabaseSync, table: string, value: {id: string} & Record<string, unknown>) {db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), value.id);}
function allowCorruptFixture(f: Awaited<ReturnType<typeof fixture>>) {f.use(db => db.exec('DROP TRIGGER immutable_timeline_render_snapshot; DROP TRIGGER immutable_timeline_responses;'));}

test('exact preview GET HEAD Range supports named and unnamed historical outputs without writes', async t => {
  for (const named of [false, true]) {
    const f = await fixture(t, {named}), before = await f.checkpoint();
    assert.ok(f.read());
    for (const options of [{}, {method: 'HEAD'}, {headers: {range: 'bytes=2-7'}}, {method: 'HEAD', headers: {range: 'bytes=-4'}}]) {
      const response = await f.request(undefined, options);
      assert.equal(response.status, options.headers?.range ? 206 : 200);
      assert.equal(response.headers.get('content-type'), 'video/mp4');
      assert.equal(response.headers.get('content-disposition'), 'inline');
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), options.method === 'HEAD' ? Buffer.alloc(0) : options.headers?.range ? f.bytes.subarray(2, 8) : f.bytes);
    }
    const range = await f.request(undefined, {headers: {range: 'bytes=999999-'}}); assert.equal(range.status, 416); await range.text();
    await f.unchanged(before);
    // No weakening of existing named-download syntax or unnamed acceptance.
    const download = await f.request(f.route.replace('preview=1', 'download=1'));
    assert.equal(download.status, named ? 200 : 404); await download.arrayBuffer();
  }
});

test('preview syntax is exact and unauthorized requests do not disclose bytes', async t => {
  const f = await fixture(t), before = await f.checkpoint();
  for (const route of [f.route + '&preview=1', f.route + `&exportId=${f.record.id}`, f.route + '&download=1', f.route + '&path=/tmp/x',
    f.route.replace('preview=1', 'preview=0'), f.route.replace('preview=1&', ''), f.route.replace(/&exportId=.*/, ''),
    f.route.replace(f.record.id, randomUUID()), f.route.replace(f.asset.id, randomUUID()), f.route.replace(f.record.id, 'bad')]) {
    const response = await f.request(route); assert.equal(response.status, 404, route); assert.equal(response.headers.get('content-disposition'), null);
    const body = await response.text(); assert.ok(!body.includes(f.root));
  }
  assert.equal(timelineExportPreviewIdentity(new URL(f.url + '#fragment')), null);
  const unauthenticated = await fetch(f.server!.url + f.route); assert.equal(unauthenticated.status, 401); await unauthenticated.text();
  const foreignOrigin = await f.request(undefined, {headers: {origin: 'https://foreign.invalid'}}); assert.equal(foreignOrigin.status, 403); await foreignOrigin.text();
  await f.unchanged(before);
});

test('preview exact ownership requires matching export receipt and owned published asset', async t => {
  const f = await fixture(t); allowCorruptFixture(f);
  const originalReceipt = f.use(db => db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId)!.response);
  // Rows that belong to the other project are written as a corrupt file would hold them.
  const changes = [
    (db: DatabaseSync) => withoutForeignKeys(db, () => db.prepare('UPDATE exports SET projectId=? WHERE id=?').run(f.foreign.id, f.record.id)),
    (db: DatabaseSync) => replace(db, 'exports', {...f.record, assetId: randomUUID()}),
    (db: DatabaseSync) => replace(db, 'exports', {...f.record, purpose: 'preview'}),
    (db: DatabaseSync) => replace(db, 'exports', {...f.record, status: 'queued', assetId: null, url: null}),
    (db: DatabaseSync) => db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify({...f.queued, id: randomUUID()}), f.input.requestId),
    (db: DatabaseSync) => withoutForeignKeys(db, () => db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.foreign.id, f.asset.id)),
    (db: DatabaseSync) => replace(db, 'assets', {...f.asset, projectId: f.foreign.id}),
    (db: DatabaseSync) => replace(db, 'assets', {...f.asset, mimeType: 'audio/wav'}),
    (db: DatabaseSync) => replace(db, 'assets', {...f.asset, provenance: 'user-import'}),
    (db: DatabaseSync) => replace(db, 'assets', {...f.asset, relativePath: `media/export-${randomUUID()}-${randomUUID()}.mp4`}),
  ];
  for (const mutate of changes) {
    f.use(mutate); const before = await f.checkpoint(); assert.equal(f.read(), null);
    const response = await f.request(); assert.equal(response.status, 404); await response.text(); await f.unchanged(before);
    f.use(db => {
      db.prepare('UPDATE exports SET projectId=?,data=? WHERE id=?').run(f.project.id, JSON.stringify(f.record), f.record.id);
      db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.project.id, JSON.stringify(f.asset), f.asset.id);
      db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(originalReceipt, f.input.requestId);
    });
  }
  assert.ok(f.read());
});

test('preview revalidates after open and closes descriptor when ownership changes', async t => {
  const f = await fixture(t, {serve: false}), descriptor = f.read(); assert.ok(descriptor);
  let opened = 0, closed = 0, streamed = 0;
  const files = createFileResponses({openFile: async (filename, flags) => {
    const handle = await open(filename, flags); opened++;
    withoutForeignKeys(f.db, () => f.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.foreign.id, f.asset.id));
    return {stat: () => handle.stat(), close: async () => {closed++; await handle.close();}, createReadStream: options => {streamed++; return handle.createReadStream(options);}};
  }});
  const server = http.createServer(async (req, res) => {
    try {await files.send(req, res, {file: path.join(f.root, descriptor.relativePath), ranges: true,
      headers: () => timelineExportPreviewResponseHeaders(f.db, f.url, f.guards, descriptor)});}
    catch (error) {res.writeHead((error as Failure).status || 500); res.end((error as Failure).code);}
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await files.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const response = await fetch(`http://127.0.0.1:${(server.address()! as import('node:net').AddressInfo).port}/`);
  assert.equal(response.status, 404); assert.equal(await response.text(), 'FILE_UNAVAILABLE');
  assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(streamed, 0);
});

test('preview rejects foreign reverse owner and keeps frozen receipt in late fence', async t => {
  const f = await fixture(t, {serve: false}), descriptor = f.read(); assert.ok(descriptor);
  const jobId = randomUUID(), versionId = randomUUID();
  withoutForeignKeys(f.db, () => {
    f.db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(jobId, f.foreign.id, JSON.stringify({id: jobId, projectId: f.foreign.id}));
    f.db.prepare('INSERT INTO versions(id,projectId,jobId,data) VALUES(?,?,?,?)').run(versionId, f.foreign.id, jobId,
      JSON.stringify({id: versionId, projectId: f.foreign.id, jobId, assetId: f.asset.id}));
  });
  assert.equal(f.read(), null);
  assert.throws(() => timelineExportPreviewResponseHeaders(f.db, f.url, f.guards, descriptor), {code: 'FILE_UNAVAILABLE'});
  f.db.prepare('DELETE FROM versions WHERE id=?').run(versionId); f.db.prepare('DELETE FROM jobs WHERE id=?').run(jobId);
  assert.ok(f.read()); allowCorruptFixture(f);
  f.db.prepare('UPDATE timeline_requests SET requestHash=? WHERE requestId=?').run('b'.repeat(64), f.input.requestId);
  // A still-valid graph is not enough to reuse an old open-file observation.
  assert.ok(f.read());
  assert.throws(() => timelineExportPreviewResponseHeaders(f.db, f.url, f.guards, descriptor), {code: 'FILE_UNAVAILABLE'});
});
