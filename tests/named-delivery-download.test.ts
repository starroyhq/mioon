import {mediaFixturePath,mp4HeaderFixture} from './helpers/media-reference-fixtures.ts';
import {referenceTestAsset} from '../packages/business/src/project-file/test-asset-fixture.ts';
import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';
import {projectRpcPath,projectMediaPath} from '../packages/contracts/src/project-file.ts';
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
import {createServices, type ServiceStore} from '../packages/business/src/services.ts';
import {readOwnedTimelineAsset} from '../packages/business/src/timeline-sources.ts';
import {readTimelineDeliveryDownload, timelineDeliveryDownloadIdentity, timelineDeliveryResponseHeaders} from '../packages/business/src/timeline-delivery-read.ts';
import {startServer} from './helpers/test-server.ts';
import type {InspectApplication,InspectProject} from '../apps/server/src/index.ts';
import {createFileResponses} from '../apps/server/src/file-response.ts';
import {createServerProject, openProjectDatabase, projectDirFor, schemaObjects, withoutForeignKeys, withoutProcessTargetRevisions} from './helpers/project-database.ts';
import type { BinaryLike } from 'crypto';
import type { FixtureSnapshot } from './helpers/strict-timeline-core-types.ts';

import {dataFileSnapshot,databaseFiles} from './helpers/data-file-snapshot.ts';
import {publishProjectOutput} from '../packages/business/src/project-output-publication.ts';
import {registeredProjectStoreForDatabase} from '../packages/business/src/project-media-storage.ts';
import {exportOutputArtifactIdentity} from '../packages/contracts/src/output-artifact.ts';

const token = 'synthetic-named-delivery-download-token';
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: NonSharedBuffer|BinaryLike) => createHash('sha256').update(value).digest('hex');
const manifest=(root:string,databases:readonly string[]=[])=>dataFileSnapshot(root,databases);
function referencedFixture<T extends {relativePath:string}>(root:string,value:T) {
  const converted=referenceTestAsset(root,value),{relativePath:_relativePath,...metadata}=value;
  return {...metadata,reference:mediaReferenceSchema.parse(converted.reference),referenceRevision:1};
}
const sourcePng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/m1cAAAAASUVORK5CYII=','base64');
async function fixture(t: test.TestContext, {serve = true} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-named-download-'));
  let store: TypedStore|undefined, services: TypedServices|undefined, server: Awaited<ReturnType<typeof startServer>> | undefined, db: DatabaseSync|undefined, inspect: InspectProject|undefined,inspectApp:InspectApplication|undefined;
  t.after(async () => {await server?.close(); db?.close(); await services?.drain(); store?.close(); await rm(root, {recursive: true, force: true});});
  const created = createServerProject(root, {name: 'Named delivery project'});
  const projectDir=created.store.projectDir;
  store = (created.store as unknown as TypedStore); services = (createServices(store, new Map()) as TypedServices);
  const project = store.get('projects', created.projectId)!;
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const sourceId = randomUUID();
  await writeFile(path.join(projectDir,`media/${sourceId}.png`),sourcePng);
  store.put('assets', referencedFixture(projectDir,{id: sourceId, projectId: project.id, name: 'Frozen image', mimeType: 'image/png', sha256: hash(sourcePng),
    relativePath: `media/${sourceId}.png`, width: 1, height: 1, duration: 0, hasAudio: false, sizeBytes: sourcePng.length, createdAt: new Date().toISOString()}));
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks[0].id, assetId: sourceId, startFrame: 0, durationFrames: 30});
  const input = {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export', deliveryName: '海边 交付 V1'};
  const queued = await services.call('timeline.render', input);
  const assetId = randomUUID(), bytes = mp4HeaderFixture('named-delivery-original-mp4-bytes'),stageFile=path.join(created.store.tempDir,`${assetId}.mp4`);
  await writeFile(stageFile, bytes, {mode: 0o600});
  const {relativePath:_publishedPath,...published}=await publishProjectOutput(created.store,{owner:{kind:'export',id:queued.id,requestId:input.requestId,inputHash:hash(exportOutputArtifactIdentity(store.get('exports',queued.id) as unknown as Record<string,unknown>))},assetId,targetKind:'exports',stageFile,mimeType:'video/mp4',sha256:hash(bytes),sizeBytes:bytes.length});
  const asset = {id: assetId, projectId: project.id, name: 'Published output', mimeType: 'video/mp4', provenance: 'export',...published,
    producer:{kind:'export' as const,id:queued.id},url: `/media/${assetId}`, createdAt: new Date().toISOString()};
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
    inspectProject: received => {inspect = received;},inspectApplication:received=>{inspectApp=received;}});
  else db = openProjectDatabase(projectDirFor(root, project.id));
  // While the server runs, the database is read and damaged on its own connection.
  const use = <T>(fn: (db: DatabaseSync) => T): T => inspect ? inspect(project.id, fn) : fn(db!);
  const useForeign=<T>(read:(db:DatabaseSync)=>T):T=>{if(inspect)return inspect(foreign.id,read);const peer=openProjectDatabase(projectDirFor(root,foreign.id));try{return read(peer);}finally{peer.close();}};
  if(server)for(const id of [project.id,foreign.id]){const opened:Response=await fetch(server.url+projectRpcPath(id),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation:'project.get',input:{projectId:id}})});assert.equal(opened.status,200);await opened.arrayBuffer();}
  const guardsFor = (db: DatabaseSync) => ({isTimelineRenderRecord, readOwnedAsset: (projectId: string, assetId: unknown) => readOwnedTimelineAsset(db, projectId, assetId)});
  const route = projectMediaPath(project.id,assetId)+`?download=1&exportId=${record.id}`, url = new URL(`/media/${assetId}?download=1&exportId=${record.id}`, 'http://127.0.0.1:12345');
  const rows = (db: DatabaseSync) => Object.fromEntries(schemaObjects(db).filter(({type}) => type === 'table').map(({name}) =>
    [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  // data_version counts other connections' commits only; total_changes() adds this connection's own writes.
  const changeMarks = (db: DatabaseSync) => [db.prepare('PRAGMA data_version').get()!.data_version, db.prepare('SELECT total_changes() AS n').get()!.n];
  const capture=(db:DatabaseSync)=>({rows:rows(db),schema:schemaObjects(db),version:changeMarks(db)});
  const checkpoint = async () => ({...use(capture),foreign:useForeign(capture),application:inspectApp?.(capture),files:await manifest(root,[...use(databaseFiles),...useForeign(databaseFiles),...(inspectApp?.(databaseFiles)??[])])});
  return {root, projectDir, project, foreign, sourceId, timeline, queued, record, asset, bytes, input, route, url, use,
    // The test's own connection exists only while no server holds the project.
    get db() {if (inspect) throw new Error('The server holds the project: use f.use(db => ...)'); return db!;},
    get guards() {return guardsFor(this.db);},
    read: () => use(db => readTimelineDeliveryDownload(db, url, guardsFor(db))), checkpoint,
    unchanged: async (before: Awaited<ReturnType<typeof checkpoint>>) => {use(db => {assert.deepEqual(rows(db), before.rows); assert.deepEqual(changeMarks(db), before.version);assert.deepEqual(schemaObjects(db),before.schema);});assert.deepEqual(useForeign(capture),before.foreign);assert.deepEqual(inspectApp?.(capture),before.application);assert.deepEqual(await manifest(root,[...use(databaseFiles),...useForeign(databaseFiles),...(inspectApp?.(databaseFiles)??[])]), before.files);},
    request: (selected = route, options: RequestInit = {}) => fetch(server!.url + selected, {...options, headers: {authorization: 'Bearer ' + token, ...options.headers}}),
    get server() {return server;}};
}

function replace(db: DatabaseSync, table: string, value: {id: string} & Record<string, unknown>) {db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), value.id);}
function allowCorruptFixture(f: Awaited<ReturnType<typeof fixture>>) {f.use(db => db.exec('DROP TRIGGER immutable_timeline_render_snapshot; DROP TRIGGER immutable_timeline_responses;'));}

test('real named media GET HEAD ranges and later historical edits retain immutable naming without writes', async t => {
  const f = await fixture(t), before = await f.checkpoint();
  const expected = timelineDeliveryContentDisposition(f.input.deliveryName, f.record.id) + `; mioon-export-id="${f.record.id}"; mioon-asset-id="${f.asset.id}"`;
  for (const options of [{}, {method: 'HEAD'}, {headers: {range: 'bytes=2-7'}}, {method: 'HEAD', headers: {range: 'bytes=-4'}}]) {
    const response = await f.request(undefined, options), ranged = Boolean(options.headers?.range);
    assert.equal(response.status, ranged ? 206 : 200); assert.equal(response.headers.get('content-disposition'), expected);
    assert.equal(response.headers.get('content-type'), 'video/mp4'); assert.equal(response.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    const body = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(body, options.method === 'HEAD' ? Buffer.alloc(0) : ranged ? f.bytes.subarray(2, 8) : f.bytes);
  }
  for (const range of ['bytes=9999-', 'bytes=0-1,3-4', 'bytes=-0']) {
    const response = await f.request(undefined, {headers: {range}}); assert.equal(response.status, 416); assert.equal(await response.text(), '');
    assert.equal(response.headers.get('content-disposition'), null);
  }
  assert.equal(f.timeline.clips.length, 0); assert.deepEqual(f.read()!.reference, f.asset.reference); assert.equal(f.read()!.referenceRevision,f.asset.referenceRevision);
  await f.unchanged(before);
  // The download proof does not require a current timeline or source bytes.
  f.use(db => {db.prepare('DELETE FROM timelines WHERE id=?').run(f.timeline.id); db.prepare('DELETE FROM assets WHERE id=?').run(f.sourceId);});
  const afterDeletion = await f.checkpoint(), response = await f.request();
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-disposition'), expected); await response.arrayBuffer(); await f.unchanged(afterDeletion);
});

test('named request syntax is exact and authentication precedes descriptor disclosure', async t => {
  const f = await fixture(t), before = await f.checkpoint();
  const routes = [f.route + '&download=1', f.route + `&exportId=${f.record.id}`, f.route + '&filename=secret.mp4', f.route + '&path=/tmp/secret',
    f.route + '%0A', f.route.replace('download=1', 'download=0'), f.route.replace('download=1&', ''), f.route.replace(f.record.id, randomUUID()),
    f.route.replace(f.asset.id, randomUUID()), f.route.replace(f.record.id, 'bad')];
  let opaque;
  for (const route of routes) {
    const response = await f.request(route); assert.equal(response.status, 404, route); assert.equal(response.headers.get('content-disposition'), null);
    const text = await response.text(); opaque ??= text; assert.equal(text, opaque); assert.ok(!text.includes(f.input.deliveryName)); assert.ok(!text.includes(f.root));
  }
  const unauthenticated = await fetch(f.server!.url + f.route); assert.equal(unauthenticated.status, 401); assert.equal(unauthenticated.headers.get('content-disposition'), null);
  assert.equal((await f.request(undefined, {headers: {origin: 'https://foreign.invalid'}})).status, 403);
  assert.equal(timelineDeliveryDownloadIdentity(new URL(f.url + '#fragment')), null);
  await f.unchanged(before);
});

test('foreign or corrupt export, receipt, project and output rows are opaque and read-only', async t => {
  const f = await fixture(t); allowCorruptFixture(f);
  const originalReceipt = f.use(db => db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId)!.response);
  // Rows that belong to the other project are written as a corrupt file would hold them.
  const corrupt: [string, (db: DatabaseSync) => unknown][] = [
    ['export relational project', db => withoutProcessTargetRevisions(db, ['exports'], () => withoutForeignKeys(db, () => db.prepare('UPDATE exports SET projectId=? WHERE id=?').run(f.foreign.id, f.record.id)))],
    ['export JSON identity', db => db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify({...f.record, id: randomUUID()}), f.record.id)],
    ['export foreign JSON project', db => replace(db, 'exports', {...f.record, projectId: f.foreign.id})],
    ['export URL', db => replace(db, 'exports', {...f.record, url: `/media/${randomUUID()}`})],
    ['not succeeded', db => replace(db, 'exports', {...f.record, status: 'failed', assetId: null, url: null, error: {code: 'FAILED', message: 'failed'}})],
    ['preview purpose', db => replace(db, 'exports', {...f.record, purpose: 'preview'})],
    ['missing frozen name', db => {const value = clone(f.record); delete value.snapshot.deliveryName; replace(db, 'exports', value);}],
    ['changed frozen name', db => {const value = clone(f.record); value.snapshot.deliveryName = 'Other'; replace(db, 'exports', value);}],
    ['receipt progressed', db => db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(f.record), f.input.requestId)],
    ['receipt different identity', db => db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify({...f.queued, id: randomUUID()}), f.input.requestId)],
    ['receipt changed name', db => {const value = JSON.parse((originalReceipt as string)); value.snapshot.deliveryName = 'Other'; db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(value), f.input.requestId);}],
    ['receipt hash malformed', db => db.prepare('UPDATE timeline_requests SET requestHash=? WHERE requestId=?').run('invalid', f.input.requestId)],
    ['project JSON identity', db => db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...f.project, id: f.foreign.id}), f.project.id)],
    ['asset relational owner', db => withoutForeignKeys(db, () => db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.foreign.id, f.asset.id))],
    ['asset JSON owner', db => replace(db, 'assets', {...f.asset, projectId: f.foreign.id})],
    ['asset JSON identity', db => db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...f.asset, id: randomUUID()}), f.asset.id)],
    ['asset wrong MIME', db => replace(db, 'assets', {...f.asset, mimeType: 'image/png'})],
    ['asset wrong URL', db => replace(db, 'assets', {...f.asset, url: '/media/' + randomUUID()})],
    ['asset wrong provenance', db => replace(db, 'assets', {...f.asset, provenance: 'user-import'})],
    ['missing publication', db => replace(db, 'assets', {...f.asset,publication:undefined})],
    ['foreign publication owner', db => replace(db, 'assets', {...f.asset,publication:{...f.asset.publication,owner:{...f.asset.publication.owner,id:randomUUID()}}})],
    ['relinked external output', db => replace(db, 'assets', {...f.asset,reference:{...f.asset.reference,path:`../${f.asset.id}.mp4`}})],
    ['oversized export', db => db.prepare('UPDATE exports SET data=? WHERE id=?').run(' '.repeat(4 * 1024 * 1024 + 1), f.record.id)],
    ['oversized receipt', db => db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(' '.repeat(4 * 1024 * 1024 + 1), f.input.requestId)],
    ['oversized output', db => db.prepare('UPDATE assets SET data=? WHERE id=?').run(' '.repeat(16 * 1024 + 1), f.asset.id)],
  ];
  const requestHash = f.use(db => db.prepare('SELECT requestHash FROM timeline_requests WHERE requestId=?').get(f.input.requestId)!.requestHash);
  let opaque;
  for (const [label, mutate] of corrupt) {
    f.use(mutate); const before = await f.checkpoint(); assert.equal(f.read(), null, label);
    const response = await f.request(); assert.equal(response.status, 404, label); assert.equal(response.headers.get('content-disposition'), null, label);
    const body = await response.text(); opaque ??= body; assert.equal(body, opaque, label); await f.unchanged(before);
    f.use(db => {
      db.prepare('UPDATE exports SET projectId=?,data=? WHERE id=?').run(f.project.id, JSON.stringify(f.record), f.record.id);
      db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.project.id, JSON.stringify(f.asset), f.asset.id);
      db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(f.project), f.project.id);
      db.prepare('UPDATE timeline_requests SET response=?,requestHash=? WHERE requestId=?').run(originalReceipt, requestHash, f.input.requestId);
    });
  }
  assert.ok(f.read());
});

test('existing safe output graph rejects foreign reverse owners without consulting current source clips', async t => {
  const f = await fixture(t), jobId = randomUUID(), versionId = randomUUID();
  f.use(db => withoutProcessTargetRevisions(db, ['jobs'], () => withoutForeignKeys(db, () => {
    db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(jobId, f.foreign.id, JSON.stringify({id: jobId, projectId: f.foreign.id}));
    db.prepare('INSERT INTO versions(id,projectId,jobId,data) VALUES(?,?,?,?)').run(versionId, f.foreign.id, jobId,
      JSON.stringify({id: versionId, projectId: f.foreign.id, jobId, assetId: f.asset.id}));
  })));
  const before = await f.checkpoint(); assert.equal(f.read(), null);
  const response = await f.request(); assert.equal(response.status, 404); assert.equal(response.headers.get('content-disposition'), null); await response.text(); await f.unchanged(before);
});

test('unnamed/storyboard URL compatibility retains mioon default, while named missing bytes remain sanitized', async t => {
  const f = await fixture(t);
  for (const route of [projectMediaPath(f.project.id,f.asset.id), projectMediaPath(f.project.id,f.asset.id)+`?download`, projectMediaPath(f.project.id,f.asset.id)+`?download=1`]) {
    const response = await f.request(route); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), route.includes('?') ? 'attachment; filename="mioon.mp4"' : null); await response.arrayBuffer();
  }
  await unlink(mediaFixturePath(f.projectDir,f.asset)); const before = await f.checkpoint();
  const response = await f.request(); assert.equal(response.status, 404); assert.equal(response.headers.get('content-disposition'), null);
  const text = await response.text(); assert.match(text, /MEDIA_MISSING/); assert.deepEqual(JSON.parse(text).error.details,{assetId:f.asset.id,reason:'not-found'}); assert.ok(!text.includes(f.root)); assert.ok(!text.includes(f.input.deliveryName)); await f.unchanged(before);
});

test('bounded descriptor proof is repeated after file open and releases the fd on changed ownership', async t => {
  const f = await fixture(t, {serve: false}), descriptor = f.read(); assert.ok(descriptor);
  let opened = 0, closed = 0, streamed = 0;
  const files = createFileResponses({openFile: async (filename, flags) => {
    const handle = await open(filename, flags); opened++;
    withoutForeignKeys(f.db, () => f.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.foreign.id, f.asset.id));
    return {stat: () => handle.stat(), close: async () => {closed++; await handle.close();}, createReadStream: options => {streamed++; return handle.createReadStream(options);}};
  }});
  const server = http.createServer(async (req, res) => {
    try {await files.send(req, res, {file: mediaFixturePath(f.projectDir, f.asset), ranges: true,
      headers: () => timelineDeliveryResponseHeaders(f.db, f.url, f.guards, descriptor)});}
    catch (error) {res.writeHead((error as Failure).status || 500); res.end((error as Failure).code);}
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await files.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const response = await fetch(`http://127.0.0.1:${(server.address()! as import('node:net').AddressInfo).port}/`);
  assert.equal(response.status, 404); assert.equal(response.headers.get('content-disposition'), null); assert.equal(await response.text(), 'FILE_UNAVAILABLE');
  assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(streamed, 0);
});

test('pre-header change fence includes frozen receipt and snapshot even when safe basename stays identical', async t => {
  const f = await fixture(t, {serve: false}); allowCorruptFixture(f);
  // Both display names sanitize to the same filename; comparing only the final
  // filename/path would miss a replacement of the accepted frozen metadata.
  const original = clone(f.record), receipt = JSON.parse((f.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId)!.response as string));
  original.snapshot.deliveryName = 'A/B'; receipt.snapshot.deliveryName = 'A/B';
  replace(f.db, 'exports', original); f.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(receipt), f.input.requestId);
  const originalAsset=clone(f.asset);originalAsset.publication.owner.inputHash=hash(exportOutputArtifactIdentity(original));replace(f.db,'assets',originalAsset);
  const expected = f.read(); assert.ok(expected);
  const originalHash = f.db.prepare('SELECT requestHash FROM timeline_requests WHERE requestId=?').get(f.input.requestId)!.requestHash;
  for (const change of ['name', 'snapshot', 'receipt', 'path']) {
    f.db.prepare('UPDATE timeline_requests SET requestHash=? WHERE requestId=?').run(originalHash, f.input.requestId);
    const record = clone(original), accepted = clone(receipt), asset = clone(originalAsset);
    if (change === 'name') {record.snapshot.deliveryName = 'A\\B'; accepted.snapshot.deliveryName = 'A\\B';}
    if (change === 'snapshot') {record.snapshot.timeline.clips[0].name = 'Changed frozen clip'; accepted.snapshot.timeline.clips[0].name = 'Changed frozen clip';}
    if (change === 'receipt') f.db.prepare('UPDATE timeline_requests SET requestHash=? WHERE requestId=?').run('c'.repeat(64), f.input.requestId);
    if (change === 'path') {const relativePath=`导出/export-${f.record.id}-${randomUUID()}.mp4`;asset.reference={...asset.reference,path:relativePath};asset.publication={...asset.publication,relativePath};}
    asset.publication.owner.inputHash=hash(exportOutputArtifactIdentity(record));
    replace(f.db, 'exports', record); replace(f.db, 'assets', asset);
    f.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(accepted), f.input.requestId);
    assert.ok(f.read(), change + ' is independently valid');
    if (change === 'name') assert.equal(f.read()!.contentDisposition, expected.contentDisposition);
    assert.throws(() => timelineDeliveryResponseHeaders(f.db, f.url, f.guards, expected), error => (error as Failure).code === 'FILE_UNAVAILABLE' && (error as Failure).status === 404, change);
  }
});


test('named download binds the exact worker output path and rejects swapped same-project export artifacts', async t => {
  const f = await fixture(t); allowCorruptFixture(f);
  const secondId = randomUUID(), secondAssetId = randomUUID(), secondRequestId = randomUUID();
  const firstReceipt = JSON.parse((f.use(db => db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId)!.response) as string));
  const secondReceipt = {...clone(firstReceipt), id: secondId, requestId: secondRequestId};
  secondReceipt.snapshot.deliveryName = 'Second owned delivery';
  const owner=f.use(db=>registeredProjectStoreForDatabase(db));assert.ok(owner);
  const secondBytes=mp4HeaderFixture('second owned output'),stageFile=path.join(owner.tempDir,`${secondAssetId}.mp4`);await writeFile(stageFile,secondBytes,{mode:0o600});
  const second = {...clone(f.record), id: secondId, requestId: secondRequestId, snapshot: clone(secondReceipt.snapshot), assetId: secondAssetId, url:`/media/${secondAssetId}`};
  const {relativePath:_secondPath,...published}=await publishProjectOutput(owner,{owner:{kind:'export',id:secondId,requestId:secondRequestId,inputHash:hash(exportOutputArtifactIdentity(second))},assetId:secondAssetId,targetKind:'exports',stageFile,mimeType:'video/mp4',sha256:hash(secondBytes),sizeBytes:secondBytes.length});
  const secondAsset={id:secondAssetId,projectId:f.project.id,name:'Second published output',mimeType:'video/mp4',provenance:'export',...published,
    producer:{kind:'export' as const,id:secondId},url:`/media/${secondAssetId}`,createdAt:new Date().toISOString()};
  f.use(db => {
    db.prepare('INSERT INTO exports(id,projectId,data) VALUES(?,?,?)').run(secondId, f.project.id, JSON.stringify(second));
    db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(secondAssetId, f.project.id, JSON.stringify(secondAsset));
    db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(secondRequestId, 'd'.repeat(64), JSON.stringify(secondReceipt));
  });
  const secondRoute = projectMediaPath(f.project.id,secondAssetId)+`?download=1&exportId=${secondId}`;
  for (const route of [f.route, secondRoute]) {const response = await f.request(route); assert.equal(response.status, 200); await response.arrayBuffer();}
  // Each asset and each frozen receipt independently belongs to this project;
  // only the cross-export output substitution is wrong.
  assert.ok(f.use(db => readOwnedTimelineAsset(db, f.project.id, f.asset.id)));
  assert.ok(f.use(db => readOwnedTimelineAsset(db, f.project.id, secondAssetId)));
  const swapped = {...f.record, assetId: secondAssetId, url: secondAsset.url};
  assert.equal(isTimelineRenderRecord(swapped, {...f.input, exportId: f.record.id}), true);
  f.use(db => replace(db, 'exports', swapped));
  const before = await f.checkpoint();
  const response = await f.request(projectMediaPath(f.project.id,secondAssetId)+`?download=1&exportId=${f.record.id}`);
  assert.equal(response.status, 404); assert.equal(response.headers.get('content-disposition'), null); await response.text(); await f.unchanged(before);
  // Generic legacy managed-media downloads retain their preexisting policy.
  const legacy = await f.request(projectMediaPath(f.project.id,secondAssetId)+`?download`);
  assert.equal(legacy.status, 200); assert.equal(legacy.headers.get('content-disposition'), 'attachment; filename="mioon.mp4"'); await legacy.arrayBuffer();
  f.use(db => replace(db, 'exports', f.record));
  for (const relativePath of [`media/export-${f.record.id}-${randomUUID()}.mp4\n`, `media/export-${f.record.id}-${randomUUID()}.mp4/../x.mp4`,
    `media/../media/export-${f.record.id}-${randomUUID()}.mp4`, `media/export-${secondId}-${randomUUID()}.mp4`,
    `media/export-${f.record.id}-not-a-uuid.mp4`, `/media/export-${f.record.id}-${randomUUID()}.mp4`]) {
    f.use(db => replace(db, 'assets', {...f.asset, relativePath})); assert.equal(f.read(), null, relativePath);
  }
  f.use(db => replace(db, 'assets', f.asset)); assert.ok(f.read(), 'unchanged worker-produced path remains available');
});
