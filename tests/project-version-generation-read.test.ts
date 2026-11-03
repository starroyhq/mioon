import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServerProject} from './helpers/project-database.ts';
import {prepareGenerationInputs, readGenerationAsset} from '../packages/business/src/generation-inputs.ts';
import type {GenerationSource} from '../packages/business/src/generation-inputs.ts';
import {createProviderRegistry, normalizedCapabilities} from '../packages/business/src/provider-registry.ts';
import {prepareConfiguredVideoInputs} from '../packages/business/src/video/generation.ts';
import {defaultVideoModels} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding} from '../packages/contracts/src/video-providers.ts';
import type {MediaReference} from '../packages/contracts/src/media-reference.ts';
import {canonicalJson, captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import type {ProjectDocument} from '../packages/business/src/project-versions/document.ts';
import {buildRestorePlan} from '../packages/business/src/project-versions/preview.ts';
import {applyRestorePlanInside} from '../packages/business/src/project-versions/restore.ts';

const at = '2026-11-03T00:00:00.000Z';
interface Binding {role: string; assetId: string; sha256: string}
function fixture(t: TestContext) {
  const roots: string[] = [], stores: ReturnType<typeof createServerProject>['store'][] = [];
  const create = (projectId?: string) => {
    const root = mkdtempSync(path.join(tmpdir(), 'version-generation-read-')); roots.push(root);
    const created = createServerProject(root, {name: 'Generation reader', ...(projectId ? {projectId} : {})}); stores.push(created.store);
    return {...created, root};
  };
  t.after(() => {for (const store of stores) store.close(); for (const root of roots) rmSync(root, {recursive: true, force: true});});
  const source = create(), {projectId, store} = source, shotId = randomUUID();
  const assets = ['a', 'b'].map((digit, index) => ({id: randomUUID(), projectId, name: `Reference ${index}.png`, mimeType: 'image/png', sha256: digit.repeat(64),
    sizeBytes: 1024, relativePath: `media/reference-${index}.png`, width: 720, height: 1280, hasAudio: false, hasVideo: true, provenance: 'user-import', createdAt: at}));
  const bindings: Binding[] = assets.map((asset, index) => ({role: index === 0 ? 'first_frame' : 'last_frame', assetId: asset.id, sha256: asset.sha256}));
  const shot = {id: shotId, projectId, title: 'Existing unpinned binding', prompt: 'Synthetic first and last frame', duration: 4, aspectRatio: '9:16',
    referenceAssetIds: [assets[0].id], lastFrameAssetId: assets[1].id, referenceBindings: bindings, revision: 1, createdAt: at, updatedAt: at};
  store.tx(() => {for (const asset of assets) store.put('assets', asset); store.put('shots', shot);});
  const providers = createProviderRegistry({db: store.db, root: source.root, env: {}}), capabilities = normalizedCapabilities(providers.get('mock')!, {}, 0, {asOf: '2026-10-10', requireInputProfiles: true});
  const read = (target: typeof source) => prepareGenerationInputs({source: target.store.get('shots', shotId) as GenerationSource, projectId,
    providerId: 'mock', model: 'mock-motion-v1', capabilities, readAsset: id => readGenerationAsset(target.store.db, id, projectId), asOf: '2026-10-10'});
  const original = read(source);
  assert.deepEqual(original.fields.referenceBindings, bindings, 'the same strict generation reader accepts the stored row before capture');
  const saved = store.tx(() => captureProjectDocumentInside(store));
  const restore = (document: ProjectDocument) => {
    const target = create(projectId);
    target.store.tx(() => {const plan = buildRestorePlan(target.store, document, captureProjectDocumentInside(target.store), 0, at); applyRestorePlanInside(target.store, plan, {requestId: randomUUID()});});
    return target;
  };
  return {source, projectId, shotId, saved, bindings, read, restore, original, capabilities};
}

test('a previously valid unpinned generation selection remains readable after canonical missing-row restoration', t => {
  const f = fixture(t), target = f.restore(f.saved), raw = String(target.store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(f.shotId)!.data);
  const restored = target.store.get('shots', f.shotId) as {referenceBindings: Binding[]};
  assert.deepEqual(Object.keys(f.bindings[0]), ['role', 'assetId', 'sha256']);
  assert.deepEqual(Object.keys(restored.referenceBindings[0]), ['assetId', 'role', 'sha256'], 'the actual restore wrote canonical JSON');
  assert.deepEqual(f.read(target).fields.referenceBindings, f.bindings);
  assert.equal(String(target.store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(f.shotId)!.data), raw, 'reading does not rewrite the restored content');
  assert.equal(target.store.db.prepare('SELECT count(*) n FROM main.jobs').get()!.n, 0, 'reading and restoring do not fabricate process records');
});

for (const drift of ['role', 'assetId', 'sha256', 'array-order', 'extra-field', 'duplicate-asset'] as const)
  test(`canonical restoration does not legitimize ${drift} drift in an unpinned generation manifest`, t => {
    const f = fixture(t), row = f.saved.tables.shots[0];
    const value = JSON.parse(String(row.data)) as {referenceBindings: Array<Binding & {unexpected?: boolean}>};
    if (drift === 'role') value.referenceBindings[0].role = 'last_frame';
    if (drift === 'assetId') value.referenceBindings[0].assetId = randomUUID();
    if (drift === 'sha256') value.referenceBindings[0].sha256 = 'c'.repeat(64);
    if (drift === 'array-order') value.referenceBindings.reverse();
    if (drift === 'extra-field') value.referenceBindings[0].unexpected = true;
    if (drift === 'duplicate-asset') value.referenceBindings[1].assetId = value.referenceBindings[0].assetId;
    const document: ProjectDocument = {...f.saved, tables: {...f.saved.tables, shots: [{...row, data: canonicalJson(value)}]}};
    const target = f.restore(document), before = target.store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(f.shotId)!.data,
      changes = target.store.db.prepare('SELECT total_changes() n').get()!.n;
    assert.throws(() => f.read(target), {code: 'INVALID_REFERENCE_MANIFEST'});
    assert.equal(target.store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(f.shotId)!.data, before);
    assert.equal(target.store.db.prepare('SELECT total_changes() n').get()!.n, changes);
    assert.equal(target.store.db.prepare('SELECT count(*) n FROM main.jobs').get()!.n, 0);
  });

type FrozenMode = 'profile' | 'configured-frames' | 'configured-audio';
function frozenFixture(t: TestContext, mode: FrozenMode) {
  const f = fixture(t), {store} = f.source;
  const shot = store.get('shots', f.shotId) as GenerationSource;
  const binding: VideoExecutionBinding = {version: 1, connectionId: randomUUID(), configurationRevision: 1, providerId: 'ark',
    region: 'cn-beijing', workspaceId: '', endpoint: 'https://ark.cn-beijing.volces.com/api/v3', credentialRef: randomUUID(),
    model: defaultVideoModels('ark')[0]!, outputHosts: []};
  const audioIds: string[] = [];
  if (mode === 'configured-audio') for (const [index, digit] of ['c', 'd'].entries()) {
    const id = randomUUID(), sha256 = digit.repeat(64); audioIds.push(id);
    store.put('assets', {id, projectId: f.projectId, name: `Audio ${index}.wav`, mimeType: 'audio/wav', sha256, sizeBytes: 1024,
      duration: 4, hasAudio: true, hasVideo: false, provenance: 'user-import', createdAt: at, referenceRevision: 1,
      reference: {pathForm: 'relative', path: `audio-${index}.wav`, volume: null, sizeBytes: 1024, mtimeMs: 1, sampledSha256: sha256, fullSha256: sha256}});
  }
  const planning: GenerationSource = mode === 'profile' ? {...shot, providerId: 'mock', model: 'mock-motion-v1'} : {
    ...shot, providerId: binding.providerId, model: binding.model.modelId, referenceConnections: [], parameters: {resolution: '720p'},
    ...(mode === 'configured-audio' ? {referenceAssetIds: [f.bindings[0].assetId], lastFrameAssetId: null,
      videoInput: {version: 1, mode: 'reference_images', images: [{role: 'reference_image', assetId: f.bindings[0].assetId}],
        audios: audioIds.map(assetId => ({role: 'reference_audio', assetId}))}} : {}),
  };
  const readAsset = (id: string) => readGenerationAsset(store.db, id, f.projectId);
  const prepared = mode === 'profile' ? f.original : prepareConfiguredVideoInputs({source: planning, binding,
    projectId: f.projectId, readAsset, asOf: '2026-10-10'});
  const frozen: GenerationSource = {...planning, ...prepared.fields, referenceAssetIds: prepared.assets.map(asset => asset.id), referenceAssets: prepared.assets};
  const read = () => mode === 'profile' ? prepareGenerationInputs({source: frozen, projectId: f.projectId, providerId: 'mock',
    model: 'mock-motion-v1', capabilities: f.capabilities, readAsset, frozen: true, asOf: '2026-10-10'}) :
    prepareConfiguredVideoInputs({source: frozen, binding, projectId: f.projectId, readAsset, frozen: true, asOf: '2026-10-10'});
  const before = read(), frozenBytes = JSON.stringify(frozen);
  const targetId = mode === 'configured-audio' ? audioIds[0] : f.bindings[0].assetId;
  const originalAsset = readAsset(targetId), reference = originalAsset.reference as MediaReference;
  const saved = store.tx(() => captureProjectDocumentInside(store));
  store.put('assets', {...originalAsset, name: 'Changed name before restore'});
  const plan = store.tx(() => {
    const plan = buildRestorePlan(store, saved, captureProjectDocumentInside(store), 0, at);
    applyRestorePlanInside(store, plan, {requestId: randomUUID()}); return plan;
  });
  const restored = readAsset(targetId);
  assert.equal(restored.name, originalAsset.name);
  assert.deepEqual(restored.reference, reference);
  assert.equal(restored.referenceRevision, originalAsset.referenceRevision);
  assert.notDeepEqual(Object.keys(restored.reference as MediaReference), Object.keys(reference), 'real restore normalizes nested reference key order');
  assert.ok(plan.changes.some(change => change.table === 'assets' && change.action !== 'keep-current'));
  const rows = () => store.db.prepare('SELECT id,data FROM project.assets ORDER BY id').all();
  const state = rows(), writes = store.db.prepare('SELECT total_changes() n').get()!.n;
  assert.deepEqual(read(), before);
  assert.deepEqual(rows(), state); assert.equal(store.db.prepare('SELECT total_changes() n').get()!.n, writes);
  assert.equal(JSON.stringify(frozen), frozenBytes, 'the frozen input is neither refreshed nor rewritten');
  assert.equal(store.db.prepare('SELECT count(*) n FROM main.jobs').get()!.n, 0);
  return {store, read, rows, targetId, frozen, frozenBytes};
}

for (const mode of ['profile', 'configured-frames', 'configured-audio'] as const) {
  test(`${mode} frozen references remain readable after real canonical asset restoration`, t => {
    frozenFixture(t, mode);
  });
  for (const drift of ['path', 'revision', 'hash'] as const)
    test(`${mode} frozen references still reject ${drift} drift after canonical restoration`, t => {
      const f = frozenFixture(t, mode), asset = readGenerationAsset(f.store.db, f.targetId, f.store.projectId), reference = asset.reference as MediaReference;
      const sha256 = 'f'.repeat(64);
      f.store.put('assets', {...asset, ...(drift === 'revision' ? {referenceRevision: Number(asset.referenceRevision) + 1} : {}),
        ...(drift === 'path' ? {reference: {...reference, path: 'different-source.png'}} : {}),
        ...(drift === 'hash' ? {sha256, reference: {...reference, fullSha256: sha256}} : {})});
      const rows = f.rows(), writes = f.store.db.prepare('SELECT total_changes() n').get()!.n;
      assert.throws(f.read, {code: 'REFERENCE_CHANGED', status: 400});
      assert.deepEqual(f.rows(), rows); assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n, writes);
      assert.equal(JSON.stringify(f.frozen), f.frozenBytes);
      assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.jobs').get()!.n, 0);
    });
}
