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
  return {source, projectId, shotId, saved, bindings, read, restore};
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
