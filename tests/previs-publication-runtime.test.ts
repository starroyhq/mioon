import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createPrevisPublicationServices} from '../packages/business/src/previs-publication.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {createImageEditSourceResolver} from '../packages/business/src/images/edit-source.ts';
import {validateImageConsumption} from '../packages/business/src/image-consumption.ts';
import {IMAGE_MODELS, imageEditSourceSchema} from '../packages/contracts/src/images.ts';
import {IMAGE_FIXED_OPTIONS} from '../packages/contracts/src/images.ts';
import {IMAGE_SETTINGS_READ_CURRENT, IMAGE_SETTINGS_ASSERT_CURRENT} from '../packages/business/src/images/settings.ts';
import type {ImageServicesOptions} from '../packages/business/src/images.ts';
import {DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import {publishPrevisOutput} from '../apps/web/src/previs/previs-publication.ts';
import {previsPublicationIdentity, isPrevisPublicationResponse} from '../packages/contracts/src/previs-publication.ts';
import type {PrevisPublicationInput, PrevisPublicationResponse} from '../packages/contracts/src/previs-publication.ts';
import type {PrevisNodeRecord} from '../packages/contracts/src/previs.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

async function fixture(t: TestContext, {withImageReview = false} = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-previs-publication-')), store = openStore(root);
  const settings = {
    [IMAGE_SETTINGS_READ_CURRENT]: () => ({revision: 1, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, secret: {configured: true}}),
    [IMAGE_SETTINGS_ASSERT_CURRENT]: (expected: {expectedRevision: number}) => expected.expectedRevision === 1,
  };
  const imageOptions: ImageServicesOptions = {autoRun: false, settings: settings as unknown as ImageServicesOptions['settings'],
    liveGateway: {generate: async () => {throw new Error('Review preparation must never call a provider');}}};
  const services = createServices(store, new Map(), withImageReview ? {imageOptions} : {});
  t.after(async () => {await services.drain(); store.close(); rmSync(root, {recursive: true, force: true});});
  if (withImageReview) await services.call('workspace.settings.set', {expectedRevision: 0, liveGeneration: true});
  const project = await services.call('project.create', {name: '预演发布'}) as {id: string};
  const created = await services.call('previs.create', {projectId: project.id, label: '机位', position: {x: 0, y: 0}, requestId: randomUUID()}) as PrevisNodeRecord;
  const node = await services.call('previs.scene.set', {projectId: project.id, nodeId: created.id, expectedSceneRevision: created.sceneRevision,
    scene: {...created.scene, keyframes: [{id: 'k1', name: '', camera: created.scene.camera, exports: []}], activeKeyframeId: 'k1'}, requestId: randomUUID()}) as PrevisNodeRecord;
  const bytes = png({width: 64, height: 96, rgba: false});
  const input: PrevisPublicationInput = {projectId: project.id, nodeId: node.id, keyframeId: 'k1', sceneRevision: node.sceneRevision, requestId: randomUUID(), name: 'K1.png',
    sha256: createHash('sha256').update(bytes).digest('hex'), width: 64, height: 96, dataBase64: bytes.toString('base64')};
  const outputs = (): string[] => existsSync(path.join(root, '生成')) ? readdirSync(path.join(root, '生成')) : [];
  return {root, store, services, node, bytes, input, outputs};
}
const record = (value: unknown): Record<string, unknown> => {assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;};

test('previs publishes one owned PNG in 生成, replays the exact request and supports lookup without a local manifest', async t => {
  const f = await fixture(t);
  const result = await f.services.call('previs.output.publish', f.input) as PrevisPublicationResponse;
  assert.ok(isPrevisPublicationResponse('previs.output.publish', f.input, result));
  assert.equal(result.asset.provenance, 'generated'); assert.equal(result.asset.sha256, f.input.sha256);
  assert.equal(Object.hasOwn(result.asset, 'reference'), false); assert.equal(Object.hasOwn(result.asset, 'publication'), false);
  const stored = record(f.store.get('assets', result.asset.id)), reference = record(stored.reference), proof = record(stored.publication), owner = record(proof.owner);
  assert.ok(String(reference.path).startsWith('生成/')); assert.equal(reference.path, proof.relativePath);
  assert.deepEqual(readFileSync(path.join(f.root, String(reference.path))), f.bytes);
  assert.equal(owner.kind, 'previs'); assert.equal(owner.id, f.node.id); assert.equal(owner.requestId, f.input.requestId);
  assert.equal(f.outputs().length, 1);
  assert.deepEqual(await f.services.call('previs.output.publish', f.input), result);
  await f.services.call('previs.scene.set', {projectId: f.input.projectId, nodeId: f.node.id, expectedSceneRevision: f.node.sceneRevision,
    scene: {...f.node.scene, camera: {...f.node.scene.camera, focalLength: 50}}, requestId: randomUUID()});
  assert.deepEqual(await f.services.call('previs.output.publish', f.input), result, 'a completed request remains its original output after a later scene save');
  rmSync(path.join(f.store.tempDir, 'previs-publications'), {recursive: true});
  assert.deepEqual(await f.services.call('previs.output.lookup', previsPublicationIdentity(f.input)), result);
  assert.equal(await f.services.call('previs.output.lookup', {...previsPublicationIdentity(f.input), requestId: randomUUID()}), null);
  await assert.rejects(f.services.call('previs.output.lookup', {...previsPublicationIdentity(f.input), name: 'different.png'}), {code: 'IDEMPOTENCY_CONFLICT'});
  assert.equal(f.outputs().length, 1);
});

test('equal PNG bytes from separate previs requests remain separate owned publications', async t => {
  const f = await fixture(t), [first, replay] = await Promise.all([
    f.services.call('previs.output.publish', f.input), f.services.call('previs.output.publish', f.input),
  ]) as PrevisPublicationResponse[];
  assert.equal(first!.asset.id, replay!.asset.id); assert.equal(f.outputs().length, 1);
  const second = await f.services.call('previs.output.publish', {...f.input, requestId: randomUUID()}) as PrevisPublicationResponse;
  assert.notEqual(first!.asset.id, second.asset.id); assert.equal(f.outputs().length, 2);
  await assert.rejects(f.services.call('previs.output.publish', {...f.input, name: 'changed.png'}), {code: 'IDEMPOTENCY_CONFLICT'});
  assert.equal(f.outputs().length, 2);
});

test('a preexisting ordinary image with the same SHA cannot acknowledge a previs publication', async t => {
  const f = await fixture(t), importedId = randomUUID(), relativePath = `media/${importedId}.png`;
  writeFileSync(path.join(f.root, relativePath), f.bytes);
  f.store.put('assets', {id: importedId, projectId: f.store.projectId, name: 'original.png', mimeType: 'image/png', provenance: 'user-import',
    relativePath, sha256: f.input.sha256, sizeBytes: f.bytes.length, width: 64, height: 96});
  assert.equal(await f.services.call('previs.output.lookup', previsPublicationIdentity(f.input)), null);
  const result = await f.services.call('previs.output.publish', f.input) as PrevisPublicationResponse;
  assert.notEqual(result.asset.id, importedId); assert.equal(f.outputs().length, 1); assert.equal(f.store.list('assets').length, 2);
  assert.equal(record(f.store.get('assets', importedId)).provenance, 'user-import');
});

test('a published previs PNG remains a valid owned image source while an unproven generated label is rejected', async t => {
  const f = await fixture(t), result = await f.services.call('previs.output.publish', f.input) as PrevisPublicationResponse;
  const graph = createOwnedMediaGraphReader(f.store.db, f.input.projectId);
  assert.equal(record(graph.asset(result.asset.id)).id, result.asset.id);
  const subject = await f.services.call('subject.create', {projectId: f.input.projectId, kind: 'look', name: '预演构图', assetId: result.asset.id, requestId: randomUUID()});
  assert.equal(record(record(subject).headVersion).assetId, result.asset.id);
  const verified = await createImageEditSourceResolver(f.store).verify({projectId: f.input.projectId, providerId: 'mock', model: IMAGE_MODELS.mock,
    purpose: 'edit', inputImage: {assetId: result.asset.id, sha256: f.input.sha256}});
  assert.equal(verified.descriptor.origin.kind, 'previs-output'); assert.deepEqual(verified.bytes, f.bytes);
  assert.ok(imageEditSourceSchema.safeParse(verified.descriptor).success);
  assert.equal(imageEditSourceSchema.safeParse({...verified.descriptor, width: 65}).success, false);
  const asset = record(f.store.get('assets', result.asset.id)), forgedId = randomUUID();
  f.store.put('assets', {...asset, id: forgedId, publication: undefined});
  assert.throws(() => createOwnedMediaGraphReader(f.store.db, f.input.projectId).asset(forgedId));
  assert.throws(() => validateImageConsumption(f.store.db, {id: forgedId, previsOutput: asset.previsOutput}, f.input.projectId), {code: 'IMAGE_SOURCE_INVALID'});
});

test('same-content relink to an ordinary project image preserves the original previs source and exact request lookup', async t => {
  const f = await fixture(t), original = await f.services.call('previs.output.publish', f.input) as PrevisPublicationResponse;
  const before = record(f.store.get('assets', original.asset.id)), proof = structuredClone(before.publication);
  const relocated = path.join(f.root, 'renamed-render.png');
  renameSync(path.join(f.root, String(record(before.reference).path)), relocated);
  const preview = record(await f.services.call('asset.media.relink.preview', {projectId: f.input.projectId, assetId: original.asset.id,
    sourcePath: relocated, expectedReferenceRevision: 1}));
  await f.services.call('asset.media.relink.apply', {projectId: f.input.projectId, requestId: randomUUID(), previewToken: preview.previewToken});
  const current = record(f.store.get('assets', original.asset.id));
  assert.equal(current.referenceRevision, 2); assert.equal(record(current.reference).path, 'renamed-render.png');
  assert.deepEqual(current.publication, proof); assert.deepEqual(current.previsOutput, before.previsOutput);
  assert.equal(record(createOwnedMediaGraphReader(f.store.db, f.input.projectId).asset(original.asset.id)).id, original.asset.id);
  const lookedUp = await f.services.call('previs.output.lookup', previsPublicationIdentity(f.input)) as PrevisPublicationResponse;
  assert.equal(lookedUp.asset.id, original.asset.id); assert.equal(lookedUp.asset.referenceRevision, 2);
  const verified = await createImageEditSourceResolver(f.store).verify({projectId: f.input.projectId, providerId: 'mock', model: IMAGE_MODELS.mock,
    purpose: 'edit', inputImage: {assetId: original.asset.id, sha256: f.input.sha256}});
  assert.equal(verified.descriptor.origin.kind, 'previs-output'); assert.deepEqual(verified.bytes, f.bytes);
});

test('deleting the source node preserves an already registered exact request while refusing a fresh publication', async t => {
  const f = await fixture(t);
  // A copied saved node has no local autosave receipts. Its published output
  // must outlive a later ordinary node deletion without bypassing any FK.
  const node = {...f.node, id: randomUUID()}; f.store.put('nodes', node);
  const input = {...f.input, nodeId: node.id, requestId: randomUUID()};
  const published = await f.services.call('previs.output.publish', input) as PrevisPublicationResponse;
  const files = f.outputs(), bytes = files.map(name => readFileSync(path.join(f.root, '生成', name)));
  f.store.tx(() => f.store.db.prepare('DELETE FROM nodes WHERE id=?').run(node.id));
  assert.deepEqual(await f.services.call('previs.output.lookup', previsPublicationIdentity(input)), published);
  assert.deepEqual(await f.services.call('previs.output.publish', input), published);
  await assert.rejects(f.services.call('previs.output.publish', {...input, requestId: randomUUID()}), {code: 'NOT_FOUND'});
  assert.equal(f.store.list('assets').length, 1); assert.deepEqual(f.outputs(), files);
  assert.deepEqual(files.map(name => readFileSync(path.join(f.root, '生成', name))), bytes);
});

test('an actual live edit review retains the exact previs origin and replays its immutable intent without submitting', async t => {
  const f = await fixture(t, {withImageReview: true}), output = await f.services.call('previs.output.publish', f.input) as PrevisPublicationResponse;
  const input = {projectId: f.input.projectId, requestId: randomUUID(), name: '预演编辑', prompt: '保持原构图', providerId: 'openai', model: IMAGE_MODELS.openai,
    options: IMAGE_FIXED_OPTIONS, purpose: 'edit', inputImage: {assetId: output.asset.id, sha256: output.asset.sha256}};
  const preparation = {input, settingsRevision: 1}, review = record(await f.services.call('image.review.prepare', preparation));
  assert.equal(record(record(review.sourceImage).origin).kind, 'previs-output');
  assert.equal(record(record(record(review.sourceImage).origin).previsOutput).requestId, f.input.requestId);
  const saved = f.store.db.prepare('SELECT canonicalInput,canonicalIntent FROM image_reviews WHERE id=?').get(String(review.id));
  assert.deepEqual(await f.services.call('image.review.prepare', preparation), review);
  assert.deepEqual(f.store.db.prepare('SELECT canonicalInput,canonicalIntent FROM image_reviews WHERE id=?').get(String(review.id)), saved);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()!.n, 0);
});

test('wrong project, missing keyframe, stale scene and forged PNG identity publish nothing', async t => {
  const f = await fixture(t);
  await assert.rejects(f.services.call('previs.output.publish', {...f.input, projectId: randomUUID()}), {code: 'NOT_FOUND'});
  await assert.rejects(f.services.call('previs.output.publish', {...f.input, keyframeId: 'k2'}), {code: 'PREVIS_THUMBNAIL_SLOT'});
  await assert.rejects(f.services.call('previs.output.publish', {...f.input, sceneRevision: f.input.sceneRevision - 1}), {code: 'REVISION_CONFLICT'});
  await assert.rejects(f.services.call('previs.output.publish', {...f.input, sha256: 'f'.repeat(64)}), {code: 'PREVIS_EXPORT_INVALID'});
  await assert.rejects(f.services.call('previs.output.publish', {...f.input, width: 65}));
  await assert.rejects(f.services.call('previs.output.publish', {...f.input, dataBase64: 'c2FtZS1oYXNoLWlzLW5vdC1hLXBuZw=='}));
  assert.equal(f.store.list('assets').length, 0); assert.deepEqual(f.outputs(), []);
});

test('lost local publication before registration resumes the same artifact without adding a second output', async t => {
  const f = await fixture(t); let interrupted = false;
  const producer = createPrevisPublicationServices(f.store, {beforeEffect: () => {
    if (!interrupted && f.outputs().length > 0 && f.store.list('assets').length === 0) {interrupted = true; throw new Error('simulated crash after exclusive publication');}
  }});
  await assert.rejects(producer.handlers['previs.output.publish'](f.input), /simulated crash/);
  assert.equal(f.outputs().length, 1); assert.equal(f.store.list('assets').length, 0);
  const before = f.outputs().map(name => readFileSync(path.join(f.root, '生成', name)));
  const restarted = createPrevisPublicationServices(f.store), result = await restarted.handlers['previs.output.publish'](f.input);
  assert.equal(result.asset.sha256, f.input.sha256); assert.equal(f.outputs().length, 1); assert.equal(f.store.list('assets').length, 1);
  assert.deepEqual(f.outputs().map(name => readFileSync(path.join(f.root, '生成', name))), before);
});

test('receipt marking failure after DB commit remains an unknown ACK and resolves only through exact lookup', async t => {
  const f = await fixture(t), clear = setProjectOutputPublicationTestHooks(f.store, {fault: point => {
    if (point === 'after_registered') throw new AppError('INVALID_MEDIA', 'simulated receipt marking failure', 409);
  }});
  t.after(clear);
  const calls: string[] = []; let failure: AppError | undefined;
  const outcome = await publishPrevisOutput(f.input, async (operation, input) => {
    calls.push(operation);
    try {return await f.services.call(operation, input);} catch (error) {if (error instanceof AppError) failure = error; throw error;}
  });
  assert.deepEqual(calls, ['previs.output.publish', 'previs.output.lookup']);
  assert.equal(outcome.status, 'imported'); assert.ok(failure);
  assert.equal(failure.code, 'PREVIS_STATE_CONFLICT'); assert.equal(failure.status, 503);
  assert.equal(record(failure.details).submissionMayHaveSucceeded, true); assert.equal(record(failure.details).requestId, f.input.requestId);
  assert.equal(record(failure.cause).code, 'INVALID_MEDIA');
  assert.equal(f.store.list('assets').length, 1); assert.equal(f.outputs().length, 1);
});

test('a changed scene after final publication preserves the file and refuses asset registration', async t => {
  const f = await fixture(t); let changed = false;
  const producer = createPrevisPublicationServices(f.store, {beforeEffect: () => {
    if (!changed && f.outputs().length > 0) {
      changed = true; f.store.tx(() => f.store.put('nodes', {...f.node, revision: f.node.revision + 1, sceneRevision: f.node.sceneRevision + 1}));
    }
  }});
  await assert.rejects(producer.handlers['previs.output.publish'](f.input), {code: 'REVISION_CONFLICT'});
  assert.equal(f.outputs().length, 1); assert.equal(f.store.list('assets').length, 0);
  assert.deepEqual(readFileSync(path.join(f.root, '生成', f.outputs()[0]!)), f.bytes);
  assert.equal(await producer.handlers['previs.output.lookup'](previsPublicationIdentity(f.input)), null);
});

test('same PNG bytes on a replaced final inode cannot be registered after publication returns', async t => {
  const f = await fixture(t), tx = f.store.tx; let ready = false, replaced = false, final = '';
  const clear = setProjectOutputPublicationTestHooks(f.store, {fault: point => {if (point === 'after_final') ready = true;}});
  const preserved = path.join(f.root, 'original-published.png');
  f.store.tx = <T>(callback: () => T): T => {
    if (ready && !replaced) {
      replaced = true; final = path.join(f.root, '生成', f.outputs()[0]!);
      const original = lstatSync(final); renameSync(final, preserved); writeFileSync(final, f.bytes);
      assert.notEqual(lstatSync(final).ino, original.ino);
    }
    return tx(callback);
  };
  try {await assert.rejects(f.services.call('previs.output.publish', f.input), {code: 'INVALID_MEDIA'});}
  finally {f.store.tx = tx; clear();}
  assert.equal(replaced, true); assert.equal(f.store.list('assets').length, 0);
  assert.deepEqual(readFileSync(preserved), f.bytes); assert.deepEqual(readFileSync(final), f.bytes);
});
