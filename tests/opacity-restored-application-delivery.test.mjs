import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Readable, Writable} from 'node:stream';
import http from 'node:http';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {openOpacityCandidateStore, reopenOpacityCandidateApplicationStore, reopenRestoredOpacityCandidateApplicationStore,
  isOpacityCandidateApplicationStore, isRestoredOpacityCandidateApplicationStore} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateServices} from '../packages/business/src/opacity-candidate-services.ts';
import {createOpacityCandidateWorkspaceBackup, restoreOpacityCandidateWorkspaceBackup} from '../packages/business/src/opacity-candidate-backup.ts';
import {createOpacityCandidateTimelineDeliveryGuards, readOpacityCandidateApplicationSource,
  assertOpacityCandidateApplicationSource} from '../packages/business/src/opacity-candidate-delivery.ts';
import {readTimelineExportPreviewMedia, timelineExportPreviewResponseHeaders, readTimelineDeliveryDownload,
  timelineDeliveryResponseHeaders} from '../packages/business/src/timeline-delivery-read.ts';
import {createFileResponses} from '../apps/server/src/file-response.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {opacityBackupFixture, hash, opacityBackupStamp as stamp} from './helpers/opacity-backup-fixture.mjs';

// Real cold archives, SQLite stores and shared descriptor/range responder;
// outputs remain synthetic bytes. No native codec, provider, GUI or listener.
let forbiddenAttempts = 0;
const forbidden = () => {forbiddenAttempts++; throw Error('No listener or child process is permitted in delivery qualification.');};
mock.method(http.Server.prototype, 'listen', forbidden);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidden);
syncBuiltinESMExports();
const media = [], off = onMediaProcess(event => media.push(event));
after(() => {off(); mock.restoreAll(); syncBuiltinESMExports(); assert.equal(forbiddenAttempts, 0); assert.deepEqual(media, []);});

async function queueOutput(store, services, projectId, purpose, context = {}, named = false) {
  const timeline = await services.call('timeline.get', {projectId});
  const input = {projectId, requestId: randomUUID(), expectedRevision: timeline.revision, purpose,
    ...(named ? {deliveryName: 'Owned synthetic restored delivery'} : {})};
  const queued = await services.call('timeline.render', input, context), id = randomUUID();
  const bytes = Buffer.from(`OWNED_SYNTHETIC_${purpose}_OUTPUT\0${id}`), relativePath = `media/export-${queued.id}-${randomUUID()}.mp4`;
  fs.writeFileSync(path.join(store.root, relativePath), bytes, {mode: 0o600, flag: 'wx'});
  const asset = {id, projectId, name: 'Opaque output bytes', mimeType: 'video/mp4', provenance: 'export', relativePath,
    sha256: hash(bytes), sizeBytes: bytes.length, url: `/media/${id}`, createdAt: stamp};
  const record = {...queued, status: 'succeeded', assetId: id, url: asset.url, updatedAt: stamp};
  store.put('assets', asset); store.put('exports', record);
  return {queued, record, asset, bytes, input};
}
async function fixture(t) {
  const f = await opacityBackupFixture(t);
  const source = reopenOpacityCandidateApplicationStore(f.source), sourceServices = createOpacityCandidateServices(source);
  const captured = [];
  try {for (const purpose of ['preview', 'export']) captured.push(await queueOutput(source, sourceServices, f.projectId, purpose));}
  finally {await sourceServices.drain(); source.close();}
  await createOpacityCandidateWorkspaceBackup({source: f.source, destination: f.backup});
  const restored = await restoreOpacityCandidateWorkspaceBackup({directory: f.backup, destination: f.destination});
  let store, services, guards;
  function openApplication() {
    store = reopenRestoredOpacityCandidateApplicationStore(f.destination); f.stores.push(store);
    services = createOpacityCandidateServices(store); guards = createOpacityCandidateTimelineDeliveryGuards(store);
  }
  const close = async () => {await services?.drain(); store?.close();};
  f.manage(close); openApplication();
  const context = {expectedWorkspaceOrigin: restored.workspaceOrigin};
  return {...f, captured, restored, context, get store() {return store;}, get services() {return services;}, get guards() {return guards;}, close,
    async reopen() {await close(); openApplication();},
    async fresh(purpose = 'export', named = false) {return queueOutput(store, services, f.projectId, purpose, context, named);},
    url(output, key = 'preview') {return new URL(`/media/${output.asset.id}?${key}=1&exportId=${output.record.id}`, 'http://127.0.0.1:4319');},
    read(output, selected = guards) {return readTimelineExportPreviewMedia(store.db, this.url(output), selected);},
    download(output, selected = guards) {return readTimelineDeliveryDownload(store.db, this.url(output, 'download'), selected);},
  };
}
function response() {
  const chunks = [], res = new Writable({write(chunk, _encoding, callback) {chunks.push(Buffer.from(chunk)); callback();}});
  res.status = 0; res.headers = {}; res.headersSent = false;
  res.writeHead = (status, headers = {}) => {res.status = status; res.headers = headers; res.headersSent = true; return res;};
  return {res, bytes: () => Buffer.concat(chunks)};
}
async function sendFile(files, store, descriptor, headers, {method = 'GET', range} = {}) {
  const req = Readable.from([]); req.method = method; req.headers = range ? {range} : {};
  const sent = response();
  await files.send(req, sent.res, {file: path.join(store.root, descriptor.relativePath), ranges: true, headers});
  return {...sent, status: sent.res.status, headers: sent.res.headers};
}

test('only exact restored43 application admission grants delivery; generic, copied and other database handles refuse', async t => {
  const f = await fixture(t), output = await f.fresh();
  assert.equal(isOpacityCandidateApplicationStore(f.store), false); assert.equal(isRestoredOpacityCandidateApplicationStore(f.store), true);
  for (const copy of [{...f.store}, Object.create(f.store)]) {
    assert.equal(isRestoredOpacityCandidateApplicationStore(copy), false);
    assert.equal(readOpacityCandidateApplicationSource(copy, f.assetId), null);
    assert.throws(() => createOpacityCandidateTimelineDeliveryGuards(copy), {code: 'FILE_UNAVAILABLE'});
  }
  const copied = {...f.guards}; assert.equal(f.read(output, copied), null); assert.equal(f.download(output, copied), null);
  const secondDb = new DatabaseSync(path.join(f.destination, 'workbench.sqlite'), {readOnly: true});
  try {
    assert.equal(readTimelineExportPreviewMedia(secondDb, f.url(output), f.guards), null);
    assert.equal(readTimelineDeliveryDownload(secondDb, f.url(output, 'download'), f.guards), null);
  } finally {secondDb.close();}
  await f.close();
  const generic = openOpacityCandidateStore(f.destination);
  try {
    assert.equal(isRestoredOpacityCandidateApplicationStore(generic), false);
    assert.equal(readOpacityCandidateApplicationSource(generic, f.assetId), null);
    assert.throws(() => createOpacityCandidateTimelineDeliveryGuards(generic), {code: 'FILE_UNAVAILABLE'});
  } finally {generic.close();}
  const ordinary = openOpacityCandidateStore(f.source);
  try {assert.throws(() => createOpacityCandidateTimelineDeliveryGuards(ordinary), {code: 'FILE_UNAVAILABLE'});}
  finally {ordinary.close();}
  assert.throws(() => reopenRestoredOpacityCandidateApplicationStore(f.source));
});

test('new-origin preview and named/unnamed exports retain opacity, receipts and guarded range bytes across reopen', async t => {
  const f = await fixture(t), files = createFileResponses(); t.after(() => files.close());
  for (const [purpose, named] of [['preview', false], ['export', false], ['export', true]]) {
    const output = await f.fresh(purpose, named), preview = f.read(output), download = f.download(output); assert.ok(preview);
    assert.deepEqual(output.record.snapshot.timeline.clips[0].opacityEnvelope, f.opacityEnvelope);
    const origin = f.store.db.prepare('SELECT workspaceOrigin,requestScope,requestId FROM workspace_restore_export_origins WHERE exportId=?').get(output.record.id);
    assert.deepEqual({...origin}, {workspaceOrigin: f.restored.workspaceOrigin, requestScope: 'timeline.render', requestId: output.input.requestId});
    assert.equal(Boolean(download), purpose === 'export');
    for (const options of [{}, {method: 'HEAD'}, {range: 'bytes=2-7'}, {range: 'bytes=-4'}, {range: 'bytes=99999-'}]) {
      const sent = await sendFile(files, f.store, preview,
        () => timelineExportPreviewResponseHeaders(f.store.db, f.url(output), f.guards, preview), options);
      assert.equal(sent.status, options.range ? options.range.includes('99999') ? 416 : 206 : 200);
      assert.deepEqual(sent.bytes(), options.method === 'HEAD' || sent.status === 416 ? Buffer.alloc(0)
        : options.range === 'bytes=2-7' ? output.bytes.subarray(2, 8) : options.range === 'bytes=-4' ? output.bytes.subarray(-4) : output.bytes);
      if (sent.status !== 416) {assert.equal(sent.headers['Content-Disposition'], 'inline'); assert.equal(sent.headers['Cache-Control'], 'private, no-store');}
    }
    if (download) {
      const sent = await sendFile(files, f.store, download,
        () => timelineDeliveryResponseHeaders(f.store.db, f.url(output, 'download'), f.guards, download));
      assert.deepEqual(sent.bytes(), output.bytes); assert.match(sent.headers['Content-Disposition'], /^attachment;/);
    }
    const oldGuards = f.guards, oldDb = f.store.db;
    await f.reopen(); assert.ok(f.read(output)); assert.equal(Boolean(f.download(output)), purpose === 'export');
    assert.equal(readTimelineExportPreviewMedia(oldDb, f.url(output), oldGuards), null);
  }
});

test('restored canonical captured imports serve bytes; held output never becomes a raw import by relabeling', async t => {
  const f = await fixture(t), expected = readOpacityCandidateApplicationSource(f.store, f.assetId); assert.ok(expected);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, expected.relativePath)), f.mediaBytes);
  const files = createFileResponses(); t.after(() => files.close());
  const sent = await sendFile(files, f.store, expected, () => {assertOpacityCandidateApplicationSource(f.store, expected); return {'Content-Type': expected.mimeType};}, {range: 'bytes=1-4'});
  assert.equal(sent.status, 206); assert.deepEqual(sent.bytes(), f.mediaBytes.subarray(1, 5));
  for (const old of f.captured) {
    assert.ok(f.store.db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='exports' AND id=?").get(old.record.id));
    assert.equal(f.read(old), null); assert.equal(f.download(old), null);
    assert.equal(readOpacityCandidateApplicationSource(f.store, old.asset.id), null);
    f.store.put('assets', {...old.asset, provenance: 'user-import', relativePath: `media/${old.asset.id}.mp4`});
    assert.equal(readOpacityCandidateApplicationSource(f.store, old.asset.id), null, 'held reverse export remains an owner even for canonical import spelling');
  }
  const foreign = randomUUID(), version = randomUUID(), job = randomUUID();
  f.store.put('projects', {id: foreign, name: 'Synthetic foreign graph', createdAt: stamp, updatedAt: stamp});
  f.store.put('jobs', {id: job, projectId: foreign});
  f.store.put('versions', {id: version, projectId: foreign, jobId: job, assetId: f.assetId});
  assert.equal(readOpacityCandidateApplicationSource(f.store, f.assetId), null);
  assert.throws(() => assertOpacityCandidateApplicationSource(f.store, expected), {code: 'FILE_UNAVAILABLE'});
});

test('missing receipt or origin and corrupt acceptance identity refuse outputs without weakening restored SQL guards', async t => {
  const f = await fixture(t), output = await f.fresh(); assert.ok(f.read(output));
  const clone = {queued: {...output.queued, id: randomUUID(), requestId: randomUUID()}, asset: {...output.asset, id: randomUUID()}};
  clone.asset.url = `/media/${clone.asset.id}`; clone.asset.relativePath = `media/export-${clone.queued.id}-${randomUUID()}.mp4`;
  clone.record = {...clone.queued, status: 'succeeded', assetId: clone.asset.id, url: clone.asset.url, updatedAt: stamp};
  f.store.put('exports', clone.record); f.store.put('assets', clone.asset);
  assert.equal(f.read(clone), null, 'a structurally valid output without a receipt is unavailable');
  const requestHash = 'b'.repeat(64);
  f.store.db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)')
    .run(clone.record.requestId, requestHash, JSON.stringify(clone.queued));
  assert.equal(f.read(clone), null, 'a valid receipt without restored-origin acceptance is unavailable');
  const insert = f.store.db.prepare('INSERT INTO workspace_restore_export_origins(exportId,projectId,workspaceOrigin,requestScope,requestId,requestHash,identityHash) VALUES(?,?,?,?,?,?,?)');
  assert.throws(() => insert.run(clone.record.id, f.projectId, randomUUID(), 'timeline.render', clone.record.requestId, requestHash, 'c'.repeat(64)), /RESTORE_EXPORT_BINDING_INVALID/);
  insert.run(clone.record.id, f.projectId, f.restored.workspaceOrigin, 'timeline.render', clone.record.requestId, requestHash, 'c'.repeat(64));
  assert.equal(f.read(clone), null, 'a well-formed but false identity digest never becomes authority'); assert.equal(f.download(clone), null);
  assert.throws(() => f.store.db.prepare('UPDATE workspace_restore_export_origins SET identityHash=? WHERE exportId=?').run('d'.repeat(64), output.record.id), /RESTORE_METADATA_IMMUTABLE/);
  f.store.db.prepare('DELETE FROM timeline_requests WHERE requestId=?').run(output.record.requestId);
  assert.equal(f.read(output), null); assert.equal(f.download(output), null);
});

test('foreign output ownership and late source/export changes close file descriptors without streaming', async t => {
  const f = await fixture(t), output = await f.fresh(), preview = f.read(output), download = f.download(output); assert.ok(preview); assert.ok(download);
  const foreign = randomUUID(); f.store.put('projects', {id: foreign, name: 'Owned foreign project', createdAt: stamp, updatedAt: stamp});
  let opened = 0, closed = 0, streamed = 0;
  const files = createFileResponses({openFile: async (filename, flags) => {
    const handle = await open(filename, flags); opened++;
    f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(foreign, output.asset.id);
    return {stat: () => handle.stat(), close: async () => {closed++; await handle.close();}, createReadStream: options => {streamed++; return handle.createReadStream(options);}};
  }}); t.after(() => files.close());
  await assert.rejects(sendFile(files, f.store, preview,
    () => timelineExportPreviewResponseHeaders(f.store.db, f.url(output), f.guards, preview)), {code: 'FILE_UNAVAILABLE'});
  assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(streamed, 0); assert.equal(f.read(output), null); assert.equal(f.download(output), null);
  assert.throws(() => timelineDeliveryResponseHeaders(f.store.db, f.url(output, 'download'), f.guards, download), {code: 'FILE_UNAVAILABLE'});
  const source = readOpacityCandidateApplicationSource(f.store, f.assetId); assert.ok(source);
  const original = f.store.get('assets', f.assetId); f.store.put('assets', {...original, sha256: 'e'.repeat(64)});
  assert.throws(() => assertOpacityCandidateApplicationSource(f.store, source), {code: 'FILE_UNAVAILABLE'});
});

test('cancelled range response owns only its descriptor and closing application revokes every retained media grant', async t => {
  const f = await fixture(t), output = await f.fresh(), descriptor = f.read(output), source = readOpacityCandidateApplicationSource(f.store, f.assetId);
  assert.ok(descriptor); assert.ok(source);
  const cancellation = new AbortController(); let opened = 0, closed = 0, streamed = 0;
  const files = createFileResponses({signal: cancellation.signal, openFile: async (filename, flags) => {
    const handle = await open(filename, flags); opened++; cancellation.abort();
    return {stat: () => handle.stat(), close: async () => {closed++; await handle.close();}, createReadStream: options => {streamed++; return handle.createReadStream(options);}};
  }}); t.after(() => files.close());
  const sent = await sendFile(files, f.store, descriptor,
    () => timelineExportPreviewResponseHeaders(f.store.db, f.url(output), f.guards, descriptor), {range: 'bytes=1-4'});
  assert.equal(sent.status, 0); assert.equal(sent.bytes().length, 0); assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(streamed, 0);
  assert.ok(f.read(output), 'cancelling file transport does not cancel accepted render history');
  assert.equal(f.store.get('exports', output.record.id).status, 'succeeded');
  const guards = f.guards, db = f.store.db; await f.close();
  assert.equal(readTimelineExportPreviewMedia(db, f.url(output), guards), null);
  assert.equal(readOpacityCandidateApplicationSource(f.store, f.assetId), null);
  assert.throws(() => assertOpacityCandidateApplicationSource(f.store, source), {code: 'FILE_UNAVAILABLE'});
  await f.reopen(); assert.ok(f.read(output)); assert.ok(readOpacityCandidateApplicationSource(f.store, f.assetId));
});
