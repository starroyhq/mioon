import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {lstatSync, readFileSync, readdirSync, realpathSync} from 'node:fs';
import {chmod, copyFile, cp, mkdir, mkdtemp, rm, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isTimelineRenderRecord} from '../packages/contracts/src/index.ts';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';
import {projectOutputPublicationProofSchema} from '../packages/contracts/src/project-output-publication.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {isProjectFileHeld} from '../packages/business/src/project-file/held-files.ts';
import {isAppLibraryHeld} from '../packages/business/src/app-db/connection.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {OrdinaryServices} from '../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {rowKey} from '../packages/business/src/project-versions/document.ts';
import {createAssetMediaServices} from '../packages/business/src/asset-media-services.ts';
import {createProjectAssetReferenceServices} from '../packages/business/src/project-asset-references.ts';
import {resolveReferencePath} from '../packages/business/src/media-reference/index.ts';
import {readOwnedTimelineAsset} from '../packages/business/src/timeline-sources.ts';
import {readTimelineExportOutput, readTimelineExportPreviewMedia, readTimelineDeliveryDownload} from '../packages/business/src/timeline-delivery-read.ts';
import {restorePublishedProjectOutput} from '../packages/business/src/project-output-publication.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const identityFields = (asset: Record<string, unknown>) => Object.fromEntries(
  ['reference', 'referenceRevision', 'sha256', 'sizeBytes', 'fingerprint', 'hashState'].filter(key => Object.hasOwn(asset, key)).map(key => [key, asset[key]]));
const localProcessState = (store: ProjectStore) => Object.fromEntries(
  ['jobs', 'job_events', 'exports', 'timeline_requests', 'idempotency', 'image_tasks', 'frame_tasks', 'scene_tasks'].map(table =>
    [table, store.db.prepare(`SELECT * FROM main."${table}" ORDER BY rowid`).all()]));

/** Only ordinary media is opened. Directory/inode/time facts also detect a
 * delete-and-recreate or same-byte rewrite hidden by a plain hash inventory. */
function mediaSnapshot(projectDir: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const visit = (file: string): void => {
    const before = lstatSync(file, {bigint: true, throwIfNoEntry: false});
    if (!before) return;
    const name = path.relative(projectDir, file), identity = {dev: String(before.dev), ino: String(before.ino)};
    assert.equal(before.isSymbolicLink(), false);
    assert.ok(!isProjectFileHeld(identity) && !isAppLibraryHeld(identity));
    const facts = {name, dev: before.dev, ino: before.ino, mode: before.mode, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs};
    if (before.isDirectory()) {
      assert.equal(realpathSync(file), file); entries.push({...facts, kind: 'directory'});
      for (const child of readdirSync(file).sort()) visit(path.join(file, child));
    } else {
      assert.ok(before.isFile()); const bytes = readFileSync(file), after = lstatSync(file, {bigint: true});
      for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key]);
      entries.push({...facts, kind: 'file', sha256: sha(bytes)});
    }
  };
  for (const folder of ['media', '素材', '生成', '导出']) visit(path.join(projectDir, folder));
  return entries;
}

function versionApi(store: ProjectStore, services: OrdinaryServices) {
  return createProjectVersions(store, {
    assertMutationAllowed: () => services.assertMutationAllowed(),
    assertRestoreAllowed: () => assert.ok(services.isQuiescent(), 'the real service owner is idle before restoration'),
  });
}
function guards(store: ProjectStore) {
  return {isTimelineRenderRecord, readOwnedAsset: (projectId: string, assetId: string) => readOwnedTimelineAsset(store.db, projectId, assetId)};
}
function selected(api: ReturnType<typeof versionApi>, projectId: string, versionId: string) {
  const preview = api.preview({projectId, versionId});
  assert.equal(preview.restoreAvailable, true);
  return {preview, input: {projectId, versionId, requestId: randomUUID(), expectedContentSequence: preview.contentSequence, expectedContentToken: preview.contentToken, previewDigest: preview.previewDigest}};
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-export-version-restore-')), projectDir = path.join(root, 'original');
  const store = openStore(projectDir), services = createServices(store, new Map(), {exportOptions: {inspect: async () => ({status: 'available', code: 'EXPORT_CAPABILITY_AVAILABLE'})}});
  let worker: ReturnType<typeof startWorker> | undefined, closed = false;
  const peers: Array<() => Promise<void>> = [];
  const close = async () => {if (!closed) {await worker?.stop(); worker = undefined; await services.drain(); store.close(); closed = true;}};
  t.after(async () => {try {try {for (const peer of peers) await peer();} finally {await close();}} finally {await rm(root, {recursive: true, force: true});}});
  const project = row(await services.call('project.create', {name: 'Restorable real export'})), projectId = String(project.id);
  const source = row(await services.call('asset.import', {projectId, name: 'Synthetic source.png', mimeType: 'image/png', dataBase64: png({width: 144, height: 256}).toString('base64')}));
  let timeline = row(await services.call('timeline.get', {projectId}));
  assert.ok(Array.isArray(timeline.tracks)); const track = row(timeline.tracks[0]);
  timeline = row(await services.call('timeline.clip.add', {projectId, expectedRevision: timeline.revision, requestId: randomUUID(), assetId: source.id, trackId: track.id, startFrame: 0, durationFrames: 6}));
  const accepted = row(await services.call('timeline.render', {projectId, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export', deliveryName: '版本恢复核验成片'}));
  const exportId = String(accepted.id); worker = startWorker(store, services, new Map());
  await worker.tick(); await worker.stop(); worker = undefined;
  const record = row(store.get('exports', exportId)); assert.equal(record.status, 'succeeded', JSON.stringify(record.error));
  const assetId = String(record.assetId), asset = row(store.get('assets', assetId)), proof = projectOutputPublicationProofSchema.parse(asset.publication);
  const file = resolveReferencePath(projectDir, mediaReferenceSchema.parse(asset.reference)); assert.ok(file);
  assert.equal(proof.owner.kind, 'export'); assert.equal(proof.owner.id, exportId); assert.equal(proof.targetKind, 'exports');
  assert.equal(file, path.join(projectDir, proof.relativePath)); const bytes = readFileSync(file); assert.equal(sha(bytes), asset.sha256);
  const library = testProjectAppLibrary(store); assert.ok(library);
  const api = versionApi(store, services), references = createProjectAssetReferenceServices(store, {outsidePaths: library.outsidePaths});
  return {root, projectDir, store, services, projectId, exportId, assetId, asset, proof, file, bytes, library, api, references, close,
    closePeer: (cleanup: () => Promise<void>) => {peers.push(cleanup);}};
}
async function assertExportReadable(f: Awaited<ReturnType<typeof fixture>>) {
  const output = readTimelineExportOutput(f.store.db, {projectId: f.projectId, exportId: f.exportId}, guards(f.store));
  assert.ok(output); assert.equal(output.assetId, f.assetId); assert.equal(output.asset.sha256, f.asset.sha256);
  const described = row(await f.services.call('export.output.get', {projectId: f.projectId, exportId: f.exportId}));
  assert.equal(described.assetId, f.assetId); assert.equal(described.sha256, f.asset.sha256); assert.equal(described.fileLocation, f.file);
  assert.equal(row(described.publication).publicationId, f.proof.publicationId);
}

test('public version restore retains a real export current reference revision and full hash while restoring mutable metadata', async t => {
  const f = await fixture(t), files = mediaSnapshot(f.projectDir), grants = f.library.outsidePaths.list(f.projectId);
  let children = 0; const off = onMediaProcess(event => {if (event.type === 'started') children++;}); t.after(off);
  const saved = f.api.save({projectId: f.projectId, requestId: randomUUID(), name: 'Published export'});
  // A real same-location relink advances the current reference without moving
  // the output outside its publisher's fixed export location.
  const media = createAssetMediaServices(f.store, {outsidePaths: f.library.outsidePaths, beforeEffect: () => f.services.assertMutationAllowed()});
  const preview = row(await media.call('asset.media.relink.preview', {projectId: f.projectId, assetId: f.assetId, sourcePath: f.file, expectedReferenceRevision: 1}));
  assert.equal(row(preview.chosen).matches, true);
  await media.call('asset.media.relink.apply', {projectId: f.projectId, requestId: randomUUID(), previewToken: preview.previewToken});
  const current = row(f.store.get('assets', f.assetId)); assert.equal(current.referenceRevision, 2);
  f.store.put('assets', {...current, name: 'Changed metadata after capture', editorialNote: 'Only mutable metadata changes'});
  const process = localProcessState(f.store), {preview: plan, input} = selected(f.api, f.projectId, saved.version.id);
  const changed = plan.changes.find(change => change.table === 'assets' && change.key === rowKey('assets', {id: f.assetId}));
  assert.equal(changed?.action, 'change'); assert.match(changed?.reason ?? '', /定位.*保持当前/u);
  const restored = f.api.restore(input), asset = row(f.store.get('assets', f.assetId));
  assert.ok(restored.appliedChanges.some(change => change.key === changed?.key)); assert.equal(asset.name, f.asset.name); assert.equal(Object.hasOwn(asset, 'editorialNote'), false);
  assert.deepEqual(identityFields(asset), identityFields(current)); assert.deepEqual(asset.publication, f.asset.publication);
  assert.deepEqual(localProcessState(f.store), process); await assertExportReadable(f);
  assert.deepEqual(f.api.restore(input), restored); assert.deepEqual(mediaSnapshot(f.projectDir), files); assert.deepEqual(f.library.outsidePaths.list(f.projectId), grants); assert.equal(children, 0);
});

test('public restore fills a missing portable export asset without inventing the original machine export owner', async t => {
  const f = await fixture(t), originalAsset = structuredClone(f.asset), receivedDir = path.join(f.root, 'received');
  await f.close(); await mkdir(receivedDir, {mode: 0o755});
  await copyFile(f.store.projectFile, path.join(receivedDir, 'project.mioon'));
  for (const folder of ['素材', '导出']) await cp(path.join(f.projectDir, folder), path.join(receivedDir, folder), {recursive: true, preserveTimestamps: true});
  const store = openStore(receivedDir), services = createServices(store, new Map()), api = versionApi(store, services);
  f.closePeer(async () => {try {await services.drain();} finally {store.close();}});
  const library = testProjectAppLibrary(store); assert.ok(library);
  const references = createProjectAssetReferenceServices(store, {outsidePaths: library.outsidePaths}), files = mediaSnapshot(receivedDir), grants = library.outsidePaths.list(f.projectId);
  let children = 0; const off = onMediaProcess(event => {if (event.type === 'started') children++;}); t.after(off);
  const process = localProcessState(store); for (const rows of Object.values(process)) assert.deepEqual(rows, []);
  const saved = api.save({projectId: f.projectId, requestId: randomUUID(), name: 'Portable content only'});
  assert.equal(store.db.prepare('DELETE FROM project.assets WHERE id=?').run(f.assetId).changes, 1); assert.equal(store.get('assets', f.assetId), null);
  const {preview, input} = selected(api, f.projectId, saved.version.id);
  assert.equal(preview.changes.find(change => change.table === 'assets' && change.key === rowKey('assets', {id: f.assetId}))?.action, 'add');
  const restored = api.restore(input), asset = row(store.get('assets', f.assetId));
  assert.deepEqual(asset, originalAsset); assert.deepEqual(projectOutputPublicationProofSchema.parse(asset.publication), f.proof);
  assert.deepEqual((await references.read(f.assetId, {maxBytes: f.bytes.length, expectedReferenceRevision: 1, expectedSha256: f.proof.sha256})).bytes, f.bytes);
  const url = new URL(`/media/${f.assetId}?preview=1&exportId=${f.exportId}`, 'http://127.0.0.1');
  assert.equal(readTimelineExportOutput(store.db, {projectId: f.projectId, exportId: f.exportId}, guards(store)), null);
  assert.equal(readTimelineExportPreviewMedia(store.db, url, guards(store)), null); url.search = `download=1&exportId=${f.exportId}`;
  assert.equal(readTimelineDeliveryDownload(store.db, url, guards(store)), null);
  await assert.rejects(services.call('export.output.get', {projectId: f.projectId, exportId: f.exportId}), {code: 'NOT_FOUND'});
  assert.deepEqual(localProcessState(store), process); assert.deepEqual(api.restore(input), restored); assert.deepEqual(library.outsidePaths.list(f.projectId), grants); assert.deepEqual(mediaSnapshot(receivedDir), files); assert.equal(children, 0);
});

test('version restore keeps a same-byte external relink current and does not present it as the original exported output', async t => {
  const f = await fixture(t), external = path.join(f.root, 'external'); await mkdir(external); const candidate = path.join(external, 'same-bytes.mp4'); await copyFile(f.file, candidate);
  f.library.outsidePaths.confirm({projectId: f.projectId, directory: external, confirmedAt: new Date().toISOString()});
  const files = mediaSnapshot(f.projectDir), outsideBytes = readFileSync(candidate), outsideIdentity = lstatSync(candidate, {bigint: true}), grants = f.library.outsidePaths.list(f.projectId);
  const saved = f.api.save({projectId: f.projectId, requestId: randomUUID(), name: 'Original export location'});
  const media = createAssetMediaServices(f.store, {outsidePaths: f.library.outsidePaths, beforeEffect: () => f.services.assertMutationAllowed()});
  const chosen = row(await media.call('asset.media.relink.preview', {projectId: f.projectId, assetId: f.assetId, sourcePath: candidate, expectedReferenceRevision: 1}));
  assert.equal(row(chosen.chosen).matches, true); await media.call('asset.media.relink.apply', {projectId: f.projectId, requestId: randomUUID(), previewToken: chosen.previewToken});
  const current = row(f.store.get('assets', f.assetId)); assert.equal(current.referenceRevision, 2); assert.equal(resolveReferencePath(f.projectDir, mediaReferenceSchema.parse(current.reference)), candidate);
  f.store.put('assets', {...current, name: 'Later external-linked name'}); const process = localProcessState(f.store), {input} = selected(f.api, f.projectId, saved.version.id);
  f.api.restore(input); const asset = row(f.store.get('assets', f.assetId)); assert.equal(asset.name, f.asset.name); assert.deepEqual(identityFields(asset), identityFields(current));
  assert.deepEqual(asset.publication, f.asset.publication); assert.equal(readTimelineExportOutput(f.store.db, {projectId: f.projectId, exportId: f.exportId}, guards(f.store)), null);
  await assert.rejects(f.services.call('export.output.get', {projectId: f.projectId, exportId: f.exportId}), {code: 'EXPORT_FILE_UNAVAILABLE'});
  assert.equal((await f.references.inspect(f.assetId)).readable, true); assert.deepEqual((await f.references.read(f.assetId, {maxBytes: f.bytes.length, expectedReferenceRevision: 2, expectedSha256: f.proof.sha256})).bytes, f.bytes);
  assert.deepEqual(localProcessState(f.store), process); assert.deepEqual(f.library.outsidePaths.list(f.projectId), grants); assert.deepEqual(mediaSnapshot(f.projectDir), files); assert.deepEqual(readFileSync(candidate), outsideBytes);
  const after = lstatSync(candidate, {bigint: true}); for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], outsideIdentity[key]);
});

test('a public version-restored canonical publication still permits explicit missing-output recovery and rejects changed proofs', async t => {
  const f = await fixture(t), files = mediaSnapshot(f.projectDir), saved = f.api.save({projectId: f.projectId, requestId: randomUUID(), name: 'Canonical export publication'});
  f.store.put('assets', {...f.asset, name: 'Changed before actual version restoration'});
  const {input} = selected(f.api, f.projectId, saved.version.id); f.api.restore(input);
  const canonical = row(f.store.get('assets', f.assetId)), publication = row(canonical.publication);
  assert.deepEqual(canonical.publication, f.asset.publication); assert.deepEqual(Object.keys(publication), Object.keys(publication).sort()); assert.notDeepEqual(Object.keys(publication), Object.keys(f.proof));
  assert.deepEqual(mediaSnapshot(f.projectDir), files, 'version save/preview/restore never changes media bytes or filesystem identities');
  // The separate explicit missing-file action may restore only the frozen
  // output path. Preparing this upload is outside version restoration.
  const directory = path.join(f.store.tempDir, 'export-recovery'); ensurePrivateDirectory(directory, {create: true});
  const stage = path.join(directory, `${randomUUID()}.mp4`); await copyFile(f.file, stage); await chmod(stage, 0o600); await unlink(f.file);
  const process = localProcessState(f.store), before = mediaSnapshot(f.projectDir);
  for (const damage of ['hash', 'owner'] as const) {
    const changed = {...canonical, publication: {...publication, ...(damage === 'hash' ? {sha256: 'f'.repeat(64)} : {owner: {...row(publication.owner), id: randomUUID()}})}};
    await assert.rejects(restorePublishedProjectOutput(f.store, {asset: changed, stageFile: stage}, {beforeEffect: () => f.services.assertMutationAllowed()}), {code: 'INVALID_MEDIA'});
    assert.equal(lstatSync(f.file, {throwIfNoEntry: false}), undefined); assert.deepEqual(mediaSnapshot(f.projectDir), before); assert.deepEqual(readFileSync(stage), f.bytes);
  }
  const restored = await restorePublishedProjectOutput(f.store, {asset: canonical, stageFile: stage}, {beforeEffect: () => f.services.assertMutationAllowed()});
  assert.equal(restored.relativePath, f.proof.relativePath); assert.deepEqual(restored.publication, f.proof); assert.deepEqual(readFileSync(f.file), f.bytes);
  assert.deepEqual(f.store.get('assets', f.assetId), canonical); assert.deepEqual(localProcessState(f.store), process); await assertExportReadable(f);
  const otherMedia = (entries: Record<string, unknown>[]) => entries.filter(entry => entry.name !== f.proof.relativePath && entry.name !== '导出');
  assert.deepEqual(otherMedia(mediaSnapshot(f.projectDir)), otherMedia(files)); assert.deepEqual(f.library.outsidePaths.list(f.projectId), []);
});
