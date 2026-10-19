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
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {readOwnedTimelineAsset} from '../packages/business/src/timeline-sources.ts';
import {readTimelineDeliveryDownload, timelineDeliveryDownloadIdentity, timelineDeliveryResponseHeaders} from '../packages/business/src/timeline-delivery-read.ts';
import {startServer} from '../apps/server/src/index.ts';
import {createFileResponses} from '../apps/server/src/file-response.ts';

const token = 'synthetic-named-delivery-download-token';
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
async function manifest(root, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push({directory: name}, ...await manifest(root, name));
    else if (!/^workbench\.sqlite(?:-wal|-shm)?$/.test(name) && name !== 'server.lock') result.push({file: name, hash: hash(await readFile(path.join(root, name)))});
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function fixture(t, {serve = true} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-named-download-'));
  let store, services, server, db;
  t.after(async () => {await server?.close(); db?.close(); await services?.drain(); store?.close(); await rm(root, {recursive: true, force: true});});
  store = openStore(root); services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'Named delivery project'});
  const foreign = await services.call('project.create', {name: 'Other project'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const sourceId = randomUUID();
  store.put('assets', {id: sourceId, projectId: project.id, name: 'Frozen image', mimeType: 'image/png', sha256: 'a'.repeat(64),
    relativePath: `media/${sourceId}.png`, width: 720, height: 1280, duration: 0, hasAudio: false, sizeBytes: 20, createdAt: new Date().toISOString()});
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks[0].id, assetId: sourceId, startFrame: 0, durationFrames: 30});
  const input = {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export', deliveryName: '海边 交付 V1'};
  const queued = await services.call('timeline.render', input);
  const assetId = randomUUID(), relativePath = `media/export-${queued.id}-${randomUUID()}.mp4`, bytes = Buffer.from('named-delivery-original-mp4-bytes');
  await writeFile(path.join(root, relativePath), bytes, {mode: 0o600});
  const asset = {id: assetId, projectId: project.id, name: 'Managed output', mimeType: 'video/mp4', provenance: 'export', relativePath,
    url: `/media/${assetId}`, sha256: hash(bytes), sizeBytes: bytes.length, createdAt: new Date().toISOString()};
  store.put('assets', asset);
  const record = {...store.get('exports', queued.id), status: 'succeeded', assetId, url: asset.url, updatedAt: new Date().toISOString()};
  store.put('exports', record);
  // A historical download stays available after edits remove the original clip.
  timeline = await services.call('timeline.clip.remove', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), clipId: timeline.clips[0].id});
  await services.drain(); services = undefined; store.close(); store = undefined;
  if (serve) server = await startServer({dataDir: root, port: 0, token,
    chatGateway: async function* () {assert.fail('Download never calls a model or provider');}});
  db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
  const guards = {isTimelineRenderRecord, readOwnedAsset: (projectId, assetId) => readOwnedTimelineAsset(db, projectId, assetId)};
  const route = `/media/${assetId}?download=1&exportId=${record.id}`, url = new URL(route, 'http://127.0.0.1:12345');
  const rows = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) =>
    [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const checkpoint = async () => ({rows: rows(), version: db.prepare('PRAGMA data_version').get().data_version, files: await manifest(root)});
  return {root, db, project, foreign, sourceId, timeline, queued, record, asset, bytes, input, route, url, guards,
    read: () => readTimelineDeliveryDownload(db, url, guards), checkpoint,
    unchanged: async before => {assert.deepEqual(rows(), before.rows); assert.equal(db.prepare('PRAGMA data_version').get().data_version, before.version); assert.deepEqual(await manifest(root), before.files);},
    request: (selected = route, options = {}) => fetch(server.url + selected, {...options, headers: {authorization: 'Bearer ' + token, ...options.headers}}),
    get server() {return server;}};
}

function replace(db, table, value) {db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), value.id);}
function allowCorruptFixture(f) {f.db.exec('DROP TRIGGER immutable_timeline_render_snapshot; DROP TRIGGER immutable_timeline_responses;');}

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
  assert.equal(f.timeline.clips.length, 0); assert.equal(f.read().relativePath, f.asset.relativePath);
  await f.unchanged(before);
  // The download proof does not require a current timeline or source bytes.
  f.db.prepare('DELETE FROM timelines WHERE id=?').run(f.timeline.id);
  f.db.prepare('DELETE FROM assets WHERE id=?').run(f.sourceId);
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
  const unauthenticated = await fetch(f.server.url + f.route); assert.equal(unauthenticated.status, 401); assert.equal(unauthenticated.headers.get('content-disposition'), null);
  assert.equal((await f.request(undefined, {headers: {origin: 'https://foreign.invalid'}})).status, 403);
  assert.equal(timelineDeliveryDownloadIdentity(new URL(f.url + '#fragment')), null);
  await f.unchanged(before);
});

test('foreign or corrupt export, receipt, project and output rows are opaque and read-only', async t => {
  const f = await fixture(t); allowCorruptFixture(f);
  const originalReceipt = f.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId).response;
  const corrupt = [
    ['export relational project', () => f.db.prepare('UPDATE exports SET projectId=? WHERE id=?').run(f.foreign.id, f.record.id)],
    ['export JSON identity', () => f.db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify({...f.record, id: randomUUID()}), f.record.id)],
    ['export foreign JSON project', () => replace(f.db, 'exports', {...f.record, projectId: f.foreign.id})],
    ['export URL', () => replace(f.db, 'exports', {...f.record, url: `/media/${randomUUID()}`})],
    ['not succeeded', () => replace(f.db, 'exports', {...f.record, status: 'failed', assetId: null, url: null, error: {code: 'FAILED', message: 'failed'}})],
    ['preview purpose', () => replace(f.db, 'exports', {...f.record, purpose: 'preview'})],
    ['missing frozen name', () => {const value = clone(f.record); delete value.snapshot.deliveryName; replace(f.db, 'exports', value);}],
    ['changed frozen name', () => {const value = clone(f.record); value.snapshot.deliveryName = 'Other'; replace(f.db, 'exports', value);}],
    ['receipt progressed', () => f.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(f.record), f.input.requestId)],
    ['receipt different identity', () => f.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify({...f.queued, id: randomUUID()}), f.input.requestId)],
    ['receipt changed name', () => {const value = JSON.parse(originalReceipt); value.snapshot.deliveryName = 'Other'; f.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(value), f.input.requestId);}],
    ['receipt hash malformed', () => f.db.prepare('UPDATE timeline_requests SET requestHash=? WHERE requestId=?').run('invalid', f.input.requestId)],
    ['project JSON identity', () => f.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...f.project, id: f.foreign.id}), f.project.id)],
    ['asset relational owner', () => f.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.foreign.id, f.asset.id)],
    ['asset JSON owner', () => replace(f.db, 'assets', {...f.asset, projectId: f.foreign.id})],
    ['asset JSON identity', () => f.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...f.asset, id: randomUUID()}), f.asset.id)],
    ['asset wrong MIME', () => replace(f.db, 'assets', {...f.asset, mimeType: 'image/png'})],
    ['asset wrong URL', () => replace(f.db, 'assets', {...f.asset, url: '/media/' + randomUUID()})],
    ['asset wrong provenance', () => replace(f.db, 'assets', {...f.asset, provenance: 'user-import'})],
    ['oversized export', () => f.db.prepare('UPDATE exports SET data=? WHERE id=?').run(' '.repeat(4 * 1024 * 1024 + 1), f.record.id)],
    ['oversized receipt', () => f.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(' '.repeat(4 * 1024 * 1024 + 1), f.input.requestId)],
    ['oversized output', () => f.db.prepare('UPDATE assets SET data=? WHERE id=?').run(' '.repeat(16 * 1024 + 1), f.asset.id)],
  ];
  const requestHash = f.db.prepare('SELECT requestHash FROM timeline_requests WHERE requestId=?').get(f.input.requestId).requestHash;
  let opaque;
  for (const [label, mutate] of corrupt) {
    mutate(); const before = await f.checkpoint(); assert.equal(f.read(), null, label);
    const response = await f.request(); assert.equal(response.status, 404, label); assert.equal(response.headers.get('content-disposition'), null, label);
    const body = await response.text(); opaque ??= body; assert.equal(body, opaque, label); await f.unchanged(before);
    f.db.prepare('UPDATE exports SET projectId=?,data=? WHERE id=?').run(f.project.id, JSON.stringify(f.record), f.record.id);
    f.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.project.id, JSON.stringify(f.asset), f.asset.id);
    f.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(f.project), f.project.id);
    f.db.prepare('UPDATE timeline_requests SET response=?,requestHash=? WHERE requestId=?').run(originalReceipt, requestHash, f.input.requestId);
  }
  assert.ok(f.read());
});

test('existing safe output graph rejects foreign reverse owners without consulting current source clips', async t => {
  const f = await fixture(t), jobId = randomUUID(), versionId = randomUUID();
  f.db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(jobId, f.foreign.id, JSON.stringify({id: jobId, projectId: f.foreign.id}));
  f.db.prepare('INSERT INTO versions(id,projectId,jobId,data) VALUES(?,?,?,?)').run(versionId, f.foreign.id, jobId,
    JSON.stringify({id: versionId, projectId: f.foreign.id, jobId, assetId: f.asset.id}));
  const before = await f.checkpoint(); assert.equal(f.read(), null);
  const response = await f.request(); assert.equal(response.status, 404); assert.equal(response.headers.get('content-disposition'), null); await response.text(); await f.unchanged(before);
});

test('unnamed/storyboard URL compatibility retains mioon default, while named missing bytes remain sanitized', async t => {
  const f = await fixture(t);
  for (const route of [`/media/${f.asset.id}`, `/media/${f.asset.id}?download`, `/media/${f.asset.id}?download=1`]) {
    const response = await f.request(route); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), route.includes('?') ? 'attachment; filename="mioon.mp4"' : null); await response.arrayBuffer();
  }
  await unlink(path.join(f.root, f.asset.relativePath)); const before = await f.checkpoint();
  const response = await f.request(); assert.equal(response.status, 404); assert.equal(response.headers.get('content-disposition'), null);
  const text = await response.text(); assert.match(text, /FILE_UNAVAILABLE/); assert.ok(!text.includes(f.root)); assert.ok(!text.includes(f.input.deliveryName)); await f.unchanged(before);
});

test('bounded descriptor proof is repeated after file open and releases the fd on changed ownership', async t => {
  const f = await fixture(t, {serve: false}), descriptor = f.read(); assert.ok(descriptor);
  let opened = 0, closed = 0, streamed = 0;
  const files = createFileResponses({openFile: async (filename, flags) => {
    const handle = await open(filename, flags); opened++;
    f.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.foreign.id, f.asset.id);
    return {stat: () => handle.stat(), close: async () => {closed++; await handle.close();}, createReadStream: options => {streamed++; return handle.createReadStream(options);}};
  }});
  const server = http.createServer(async (req, res) => {
    try {await files.send(req, res, {file: path.join(f.root, descriptor.relativePath), ranges: true,
      headers: () => timelineDeliveryResponseHeaders(f.db, f.url, f.guards, descriptor)});}
    catch (error) {res.writeHead(error.status || 500); res.end(error.code);}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await files.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(response.status, 404); assert.equal(response.headers.get('content-disposition'), null); assert.equal(await response.text(), 'FILE_UNAVAILABLE');
  assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(streamed, 0);
});

test('pre-header change fence includes frozen receipt and snapshot even when safe basename stays identical', async t => {
  const f = await fixture(t, {serve: false}); allowCorruptFixture(f);
  // Both display names sanitize to the same filename; comparing only the final
  // filename/path would miss a replacement of the accepted frozen metadata.
  const original = clone(f.record), receipt = JSON.parse(f.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId).response);
  original.snapshot.deliveryName = 'A/B'; receipt.snapshot.deliveryName = 'A/B';
  replace(f.db, 'exports', original); f.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(receipt), f.input.requestId);
  const expected = f.read(); assert.ok(expected);
  const originalHash = f.db.prepare('SELECT requestHash FROM timeline_requests WHERE requestId=?').get(f.input.requestId).requestHash;
  for (const change of ['name', 'snapshot', 'receipt', 'path']) {
    f.db.prepare('UPDATE timeline_requests SET requestHash=? WHERE requestId=?').run(originalHash, f.input.requestId);
    const record = clone(original), accepted = clone(receipt), asset = clone(f.asset);
    if (change === 'name') {record.snapshot.deliveryName = 'A\\B'; accepted.snapshot.deliveryName = 'A\\B';}
    if (change === 'snapshot') {record.snapshot.timeline.clips[0].name = 'Changed frozen clip'; accepted.snapshot.timeline.clips[0].name = 'Changed frozen clip';}
    if (change === 'receipt') f.db.prepare('UPDATE timeline_requests SET requestHash=? WHERE requestId=?').run('c'.repeat(64), f.input.requestId);
    if (change === 'path') asset.relativePath = `media/export-${f.record.id}-${randomUUID()}.mp4`;
    replace(f.db, 'exports', record); replace(f.db, 'assets', asset);
    f.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(accepted), f.input.requestId);
    assert.ok(f.read(), change + ' is independently valid');
    if (change === 'name') assert.equal(f.read().contentDisposition, expected.contentDisposition);
    assert.throws(() => timelineDeliveryResponseHeaders(f.db, f.url, f.guards, expected), error => error.code === 'FILE_UNAVAILABLE' && error.status === 404, change);
  }
});


test('named download binds the exact worker output path and rejects swapped same-project export artifacts', async t => {
  const f = await fixture(t); allowCorruptFixture(f);
  const secondId = randomUUID(), secondAssetId = randomUUID(), secondRequestId = randomUUID();
  const firstReceipt = JSON.parse(f.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId).response);
  const secondReceipt = {...clone(firstReceipt), id: secondId, requestId: secondRequestId};
  secondReceipt.snapshot.deliveryName = 'Second owned delivery';
  const secondAsset = {...f.asset, id: secondAssetId, relativePath: `media/export-${secondId}-${randomUUID()}.mp4`, url: `/media/${secondAssetId}`};
  await writeFile(path.join(f.root, secondAsset.relativePath), Buffer.from('second owned output'), {mode: 0o600});
  const second = {...clone(f.record), id: secondId, requestId: secondRequestId, snapshot: clone(secondReceipt.snapshot), assetId: secondAssetId, url: secondAsset.url};
  f.db.prepare('INSERT INTO exports(id,projectId,data) VALUES(?,?,?)').run(secondId, f.project.id, JSON.stringify(second));
  f.db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(secondAssetId, f.project.id, JSON.stringify(secondAsset));
  f.db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(secondRequestId, 'd'.repeat(64), JSON.stringify(secondReceipt));
  const secondRoute = `/media/${secondAssetId}?download=1&exportId=${secondId}`;
  for (const route of [f.route, secondRoute]) {const response = await f.request(route); assert.equal(response.status, 200); await response.arrayBuffer();}
  // Each asset and each frozen receipt independently belongs to this project;
  // only the cross-export output substitution is wrong.
  assert.ok(readOwnedTimelineAsset(f.db, f.project.id, f.asset.id));
  assert.ok(readOwnedTimelineAsset(f.db, f.project.id, secondAssetId));
  const swapped = {...f.record, assetId: secondAssetId, url: secondAsset.url};
  assert.equal(isTimelineRenderRecord(swapped, {...f.input, exportId: f.record.id}), true);
  replace(f.db, 'exports', swapped);
  const before = await f.checkpoint();
  const response = await f.request(`/media/${secondAssetId}?download=1&exportId=${f.record.id}`);
  assert.equal(response.status, 404); assert.equal(response.headers.get('content-disposition'), null); await response.text(); await f.unchanged(before);
  // Generic legacy managed-media downloads retain their preexisting policy.
  const legacy = await f.request(`/media/${secondAssetId}?download`);
  assert.equal(legacy.status, 200); assert.equal(legacy.headers.get('content-disposition'), 'attachment; filename="mioon.mp4"'); await legacy.arrayBuffer();
  replace(f.db, 'exports', f.record);
  for (const relativePath of [`media/export-${f.record.id}-${randomUUID()}.mp4\n`, `media/export-${f.record.id}-${randomUUID()}.mp4/../x.mp4`,
    `media/../media/export-${f.record.id}-${randomUUID()}.mp4`, `media/export-${secondId}-${randomUUID()}.mp4`,
    `media/export-${f.record.id}-not-a-uuid.mp4`, `/media/export-${f.record.id}-${randomUUID()}.mp4`]) {
    replace(f.db, 'assets', {...f.asset, relativePath}); assert.equal(f.read(), null, relativePath);
  }
  replace(f.db, 'assets', f.asset); assert.ok(f.read(), 'unchanged worker-produced path remains available');
});
