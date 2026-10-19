import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {openNewOpacityCandidateApplicationStore, openOpacityCandidateStore} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateApplicationServices} from '../packages/business/src/opacity-candidate-services.ts';
import {createOpacityCandidateTimelineDeliveryGuards, readOpacityCandidateApplicationSource, assertOpacityCandidateApplicationSource} from '../packages/business/src/opacity-candidate-delivery.ts';
import {readTimelineExportPreviewMedia, timelineExportPreviewResponseHeaders, readTimelineDeliveryDownload, timelineDeliveryResponseHeaders} from '../packages/business/src/timeline-delivery-read.ts';
import {mkdtempPortable} from './helpers/temp-root.ts';

const stamp = '2026-10-16T00:00:00.000Z';
const curve = {profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: 0}, {frame: 30, opacity: 1}]};
async function fixture(t, purpose = 'export', named = false) {
  const parent = mkdtempPortable('mioon-opacity-delivery-'), store = openNewOpacityCandidateApplicationStore(path.join(parent, 'fresh42'));
  const services = createOpacityCandidateApplicationServices(store);
  t.after(async () => {try {await services.drain(); store.close();} finally {rmSync(parent, {recursive: true, force: true});}});
  const project = await services.call('project.create', {name: 'Synthetic delivery'}), sourceId = randomUUID();
  store.put('assets', {id: sourceId, projectId: project.id, name: 'Synthetic metadata', mimeType: 'video/mp4', duration: 1,
    width: 720, height: 1280, hasVideo: true, hasAudio: false, sha256: 'a'.repeat(64), relativePath: `media/${sourceId}.mp4`, createdAt: stamp});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  timeline = await services.call('timeline.clip.add', {projectId: project.id, requestId: randomUUID(), expectedRevision: timeline.revision,
    assetId: sourceId, trackId: timeline.tracks[0].id, startFrame: 0, durationFrames: 30, opacityEnvelope: curve});
  const queued = await services.call('timeline.render', {projectId: project.id, requestId: randomUUID(), expectedRevision: timeline.revision, purpose,
    ...(named ? {deliveryName: 'Synthetic named delivery'} : {})});
  const assetId = randomUUID(), bytes = Buffer.from('synthetic metadata only; no output file is opened');
  const asset = {id: assetId, projectId: project.id, mimeType: 'video/mp4', provenance: 'export', name: 'Synthetic output',
    relativePath: `media/export-${queued.id}-${randomUUID()}.mp4`, url: `/media/${assetId}`,
    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, createdAt: stamp};
  store.put('assets', asset);
  const record = {...queued, status: 'succeeded', assetId, url: asset.url, updatedAt: stamp}; store.put('exports', record);
  const guards = createOpacityCandidateTimelineDeliveryGuards(store);
  const url = key => new URL(`/media/${assetId}?${key}=1&exportId=${record.id}`, 'http://127.0.0.1:4319');
  const before = () => JSON.stringify(['projects', 'assets', 'timelines', 'timeline_requests', 'timeline_history', 'exports'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  return {store, services, asset, record, queued, project, guards, url, before};
}

test('fixed application guards play both purposes and download only exports, including unnamed, without effects', async t => {
  let children = 0;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, () => {children++; throw Error('No native process');});
  syncBuiltinESMExports();t.after(() => {mock.restoreAll();syncBuiltinESMExports();assert.equal(children, 0);});
  for (const [purpose, named] of [['preview', false], ['export', false], ['export', true]]) {
    const f = await fixture(t, purpose, named), before = f.before();
    const playback = readTimelineExportPreviewMedia(f.store.db, f.url('preview'), f.guards); assert.ok(playback);
    assert.equal(timelineExportPreviewResponseHeaders(f.store.db, f.url('preview'), f.guards, playback)['Content-Disposition'], 'inline');
    const download = readTimelineDeliveryDownload(f.store.db, f.url('download'), f.guards);
    assert.equal(Boolean(download), purpose === 'export');
    if (download) {assert.match(download.contentDisposition, /^attachment; filename=/); assert.match(download.contentDisposition, /mioon-export-id=/);
      assert.equal(timelineDeliveryResponseHeaders(f.store.db, f.url('download'), f.guards, download)['Content-Type'], 'video/mp4');}
    assert.equal(f.before(), before, 'delivery reads never mutate rows');
    const copied = {...f.guards};
    assert.equal(readTimelineExportPreviewMedia(f.store.db, f.url('preview'), copied), null);
    assert.equal(readTimelineDeliveryDownload(f.store.db, f.url('download'), copied), null);
    const secondHandle = new DatabaseSync(path.join(f.store.root, 'workbench.sqlite'));
    try {assert.equal(readTimelineExportPreviewMedia(secondHandle, f.url('preview'), f.guards), null);
      assert.equal(readTimelineDeliveryDownload(secondHandle, f.url('download'), f.guards), null);} finally {secondHandle.close();}
  }
});

test('candidate media binds exact owner, queued receipt, output path and late response fence', async t => {
  const f = await fixture(t, 'export', true), descriptor = readTimelineExportPreviewMedia(f.store.db, f.url('preview'), f.guards);
  const download = readTimelineDeliveryDownload(f.store.db, f.url('download'), f.guards);assert.ok(descriptor);assert.ok(download);
  const bound = {isTimelineRenderRecord: f.guards.isTimelineRenderRecord.bind(f.guards), readOwnedAsset: f.guards.readOwnedAsset.bind(f.guards)};
  assert.ok(readTimelineDeliveryDownload(f.store.db, f.url('download'), bound), 'a trusted wrapper still checks the fixed owner and receipt');
  const foreign = await f.services.call('project.create', {name: 'Foreign output owner'});
  f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(foreign.id, f.asset.id);
  assert.equal(readTimelineExportPreviewMedia(f.store.db, f.url('preview'), f.guards), null);
  assert.throws(() => timelineExportPreviewResponseHeaders(f.store.db, f.url('preview'), f.guards, descriptor), {code: 'FILE_UNAVAILABLE'});
  assert.throws(() => timelineDeliveryResponseHeaders(f.store.db, f.url('download'), f.guards, download), {code: 'FILE_UNAVAILABLE'});
  f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.project.id, f.asset.id);
  assert.ok(readTimelineExportPreviewMedia(f.store.db, f.url('preview'), f.guards));
  f.store.put('assets', {...f.asset, relativePath: `media/export-${randomUUID()}-${randomUUID()}.mp4`});
  assert.equal(readTimelineExportPreviewMedia(f.store.db, f.url('preview'), f.guards), null);
  f.store.put('assets', f.asset);
  f.store.db.prepare('DELETE FROM timeline_requests WHERE requestId=?').run(f.record.requestId);
  assert.equal(readTimelineExportPreviewMedia(f.store.db, f.url('preview'), f.guards), null);
  assert.equal(readTimelineDeliveryDownload(f.store.db, f.url('download'), f.guards), null);
  assert.equal(readTimelineDeliveryDownload(f.store.db, f.url('download'), bound), null, 'wrapping fixed methods cannot skip original receipt proof');
});

test('ordinary42, copied stores and a closed application never grant candidate delivery rules', async t => {
  const f = await fixture(t);
  assert.throws(() => createOpacityCandidateTimelineDeliveryGuards({...f.store}), {code: 'FILE_UNAVAILABLE'});
  const parent = mkdtempPortable('mioon-opacity-delivery-ordinary-'), ordinary = openOpacityCandidateStore(parent);
  t.after(() => {ordinary.close();rmSync(parent, {recursive: true, force: true});});
  assert.throws(() => createOpacityCandidateTimelineDeliveryGuards(ordinary), {code: 'FILE_UNAVAILABLE'});
  const descriptor = readTimelineExportPreviewMedia(f.store.db, f.url('preview'), f.guards);assert.ok(descriptor);
  await f.services.drain();f.store.close();
  assert.equal(readTimelineExportPreviewMedia(f.store.db, f.url('preview'), f.guards), null);
});

test('raw candidate media only serves managed imports and cannot relabel an output to skip receipt proof', async t => {
  const f = await fixture(t), id = randomUUID();
  const imported = {...f.asset, id, url: `/media/${id}`, name: 'Imported metadata', provenance: 'user-import', relativePath: `media/${id}.mp4`};
  f.store.put('assets', imported);
  const retained = readOpacityCandidateApplicationSource(f.store, id);assert.deepEqual(retained, imported);
  assert.doesNotThrow(() => assertOpacityCandidateApplicationSource(f.store, retained));
  assert.equal(readOpacityCandidateApplicationSource(f.store, f.asset.id), null);
  f.store.put('assets', {...f.asset, provenance: 'user-import'});
  assert.equal(readOpacityCandidateApplicationSource(f.store, f.asset.id), null, 'output path never becomes a bare source');
  f.store.put('assets', {...f.asset, provenance: 'user-import', relativePath: `media/${f.asset.id}.mp4`});
  assert.equal(readOpacityCandidateApplicationSource(f.store, f.asset.id), null, 'reverse output relation refuses even a canonical import path');
  f.store.put('exports', {...f.record, padding: 'x'.repeat(4194304)});
  assert.equal(readOpacityCandidateApplicationSource(f.store, f.asset.id), null, 'an oversized reverse owner is refused before JSON extraction');
  f.store.put('exports', f.record);
  f.store.put('assets', {...imported, sha256: 'b'.repeat(64)});
  assert.throws(() => assertOpacityCandidateApplicationSource(f.store, retained), {code: 'FILE_UNAVAILABLE'});
});
