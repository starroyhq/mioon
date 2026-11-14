import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {hasRequestNotAppliedProof} from '@mioon/contracts';
import {canvasEditingResponses, createCanvasRequestId} from '../packages/contracts/src/canvas-editing.ts';
import type {PrevisNodeRecord} from '../packages/contracts/src/previs.ts';
import {readMioTargetRevision} from '../packages/business/src/agent/mio-target-revisions.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import type {CanvasArchiveTable} from '../packages/business/src/project-file/schema/domains/canvas.ts';
import {openServerTestStore} from '../packages/business/src/project-file/test-store.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import type {TypedServices, TypedStore} from './helpers/strict-service-responses.ts';

const at = '2026-11-13T00:00:00.000Z';
const archived = {code: 'CANVAS_TARGET_ARCHIVED'};
const position = {x: 0, y: 0};
const notApplied = (requestId: string) => ({...archived, status: 409, details: {mutationOutcome: 'not_applied', requestId}});

async function assertArchivedMutation(store: TypedStore, request: Promise<unknown>, id: string, requestId: string): Promise<void> {
  const expected = notApplied(requestId);
  await assert.rejects(request, {...expected, details: {...expected.details, id}});
  assert.equal(store.db.prepare('SELECT 1 FROM main.mutation_requests WHERE requestId=?').get(requestId), undefined);
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-canvas-active-'));
  const projectFile = path.join(root, 'project.mioon');
  const location = {localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')};
  const open = () => openServerTestStore({projectFile, locate: () => location, format4: {}}, path.join(root, 'application'));
  createProjectFile(projectFile, {format4: {}});
  mkdirSync(path.join(root, 'media'), {mode: 0o700});
  let store = open();
  const openServices = () => {
    const providers = createProviderRegistry({db: store.db, root, env: {}});
    return {providers, services: createServices(store, providers) as TypedServices};
  };
  let {providers, services} = openServices();
  t.after(async () => {
    try {await services.drain();} finally {store.close(); rmSync(root, {recursive: true, force: true});}
  });
  const {id: projectId} = await services.call('project.create', {name: 'Canvas live projection'});
  return {
    projectId, root, get store() {return store as TypedStore;},
    get call() {return services.call;},
    async reopen() {await services.drain(); store.close(); store = open(); ({providers, services} = openServices());},
    startWorker(videoFile: string) {
      const mock = providers.get('mock')!;
      providers.set('mock', {...mock, download: async (_id, destination) => {copyFileSync(videoFile, destination);}});
      const worker = startWorker(store, services, providers);
      t.after(() => worker.stop());
      return worker;
    },
    shot(title: string) {return services.call('shot.create', {projectId, title});},
    node() {return services.call('node.create', {projectId, type: 'text', position});},
    asset(mimeType = 'image/png', provenance = 'user-import') {
      const id = randomUUID();
      return store.put('assets', {id, projectId, name: 'Fixture asset', mimeType, provenance, width: 720, height: 1280,
        duration: 4, hasVideo: mimeType === 'video/mp4', hasAudio: false, sha256: 'a'.repeat(64),
        relativePath: `media/${id}.${mimeType === 'video/mp4' ? 'mp4' : 'png'}`, createdAt: at});
    },
    mark(table: CanvasArchiveTable, id: string, reason = 'user-delete') {
      store.tx(() => store.db.prepare(`UPDATE project.${table} SET archivedAt=?,archiveBatchId=?,archiveReason=? WHERE id=?`)
        .run(at, randomUUID(), reason, id));
    },
  };
}

test('live canvas filters before pagination and keeps retained rows and mutation receipts addressable', async t => {
  const f = await fixture(t), {projectId} = f;
  const candidates = [await f.shot('First fixture'), await f.shot('Second fixture'), await f.shot('Third fixture')];
  const [first, live, extra] = candidates.sort((a, b) => a.id.localeCompare(b.id));
  const node = await f.node(), secondNode = await f.node();
  const editShot = {shotId: first.id, expectedRevision: first.revision, patch: {title: 'Retained'}, requestId: randomUUID()};
  const editNode = {nodeId: node.id, expectedRevision: node.revision, patch: {text: 'Retained'}, requestId: randomUUID()};
  const shotAck = await f.call('shot.update', editShot), nodeAck = await f.call('node.update', editNode);
  const hiddenByNode = await f.call('edge.create', {projectId, source: node.id, target: live.id});
  const hiddenByShot = await f.call('edge.create', {projectId, source: secondNode.id, target: first.id});
  const explicitlyHidden = await f.call('edge.create', {projectId, source: secondNode.id, target: extra.id});
  const visible = await f.call('edge.create', {projectId, source: secondNode.id, target: live.id});
  const asset = f.asset(), initial = await f.call('project.get', {projectId});
  const oldOrder = {projectId, expectedRevision: initial.project.revision, shotIds: [first.id, live.id, extra.id], requestId: randomUUID()};
  const orderAck = await f.call('shot.reorder', oldOrder);
  f.mark('shots', first.id); f.mark('nodes', node.id); f.mark('edges', explicitlyHidden.id);
  await f.reopen();

  const state = await f.call('project.get', {projectId});
  assert.deepEqual(state.shots.map(row => row.id), [live.id, extra.id]);
  assert.deepEqual(state.nodes.map(row => row.id), [secondNode.id]);
  assert.deepEqual(state.edges.map(row => row.id), [visible.id]);
  assert.deepEqual(state.assets.map(row => row.id), [asset.id]);
  assert.equal(f.store.get('shots', first.id)?.title, 'Retained');
  assert.equal(f.store.get('nodes', node.id)?.text, 'Retained');
  for (const edge of [hiddenByNode, hiddenByShot, explicitlyHidden]) assert.ok(f.store.get('edges', edge.id));
  const {counts} = await f.call('project.inspect', {projectId});
  assert.deepEqual([counts.shots, counts.nodes, counts.edges, counts.assets], [2, 1, 1, 1]);
  const page = await f.call('shot.inspect', {projectId, limit: 1});
  assert.deepEqual(page.items.map(row => row.id), [live.id]);
  assert.ok(page.nextCursor);
  const next = await f.call('shot.inspect', {projectId, limit: 1, cursor: page.nextCursor});
  assert.deepEqual(next.items.map(row => row.id), [extra.id]);
  assert.equal(next.nextCursor, null);
  assert.equal((await f.call('project.summary.list', {}))[0]?.shotCount, 2);
  assert.deepEqual(await f.call('shot.update', editShot), shotAck);
  assert.deepEqual(await f.call('node.update', editNode), nodeAck);
  assert.deepEqual(await f.call('shot.reorder', oldOrder), orderAck);
  const freshShot = {...editShot, expectedRevision: shotAck.revision, requestId: randomUUID()};
  const freshNode = {...editNode, expectedRevision: nodeAck.revision, requestId: randomUUID()};
  await assertArchivedMutation(f.store, f.call('shot.update', freshShot), first.id, freshShot.requestId);
  await assertArchivedMutation(f.store, f.call('node.update', freshNode), node.id, freshNode.requestId);
  await assert.rejects(f.call('edge.create', {projectId, source: secondNode.id, target: first.id}), archived);
  await assert.rejects(f.call('edge.delete', {edgeId: hiddenByNode.id}), archived);
  await assert.rejects(f.call('edge.delete', {edgeId: explicitlyHidden.id}), archived);
  await assert.rejects(f.call('shot.reorder', {...oldOrder, expectedRevision: state.project.revision, requestId: randomUUID()}), {code: 'INVALID_ORDER'});
  const added = await f.shot('Append past live ordering gaps');
  assert.equal(added.orderIndex, 3);
  const latest = await f.call('project.get', {projectId});
  await f.call('shot.reorder', {projectId, expectedRevision: latest.project.revision, shotIds: [added.id, extra.id, live.id], requestId: randomUUID()});
  assert.equal(f.store.get('shots', first.id)?.orderIndex, 0);
  assert.deepEqual((await f.call('project.get', {projectId})).shots.map(row => row.id), [added.id, extra.id, live.id]);
});

test('source archival leaves the first-frame asset selected manually and keeps exact attach and binding receipts', async t => {
  const f = await fixture(t), {projectId} = f;
  const asset = f.asset(), replacement = f.asset(), shot = await f.shot('Reference target');
  const node = await f.call('node.create', {projectId, type: 'image', assetId: asset.id, position});
  const attach = {projectId, sourceNodeId: node.id, targetShotId: shot.id, expectedSourceRevision: node.revision,
    expectedShotRevision: shot.revision, role: 'first_frame', requestId: randomUUID()};
  const bound = await f.call('reference.attach', attach);
  const subject = await f.call('subject.create', {projectId, name: 'Subject', kind: 'character', assetId: replacement.id, requestId: randomUUID()});
  const bind = {projectId, shotId: shot.id, subjectId: subject.id, role: 'subject', subjectVersionId: subject.headVersionId,
    expectedRevision: 0, expectedSubjectRevision: subject.revision, requestId: randomUUID()};
  const binding = await f.call('subject.binding.set', bind);
  f.mark('nodes', node.id); f.mark('edges', bound.edge.id, 'reference-source');
  assert.deepEqual(f.store.get('shots', shot.id)?.referenceAssetIds, [asset.id]);
  assert.deepEqual(await f.call('reference.attach', attach), bound);
  const detach = {projectId, edgeId: bound.edge.id, expectedShotRevision: bound.shot.revision, requestId: randomUUID()};
  const freshAttach = {...attach, expectedShotRevision: bound.shot.revision, requestId: randomUUID()};
  for (const [operation, input] of [['reference.attach', freshAttach], ['reference.detach', detach]] as const) {
    await assert.rejects(f.call(operation, input), error => {
      assert.deepEqual((error as {code?: string}).code, archived.code);
      return hasRequestNotAppliedProof(error, input, {operation});
    });
  }
  const updated = await f.call('shot.update', {shotId: shot.id, expectedRevision: bound.shot.revision, patch: {referenceAssetIds: [replacement.id]}});
  assert.deepEqual(updated.referenceAssetIds, [replacement.id]);
  assert.deepEqual(await f.call('reference.attach', attach), bound);
  f.mark('shots', shot.id);
  f.store.put('shots', {...f.store.get('shots', shot.id)!, canvasArchiveOrder: {previous: null, next: null}});
  assert.deepEqual(await f.call('reference.attach', attach), bound);
  assert.deepEqual(await f.call('subject.binding.set', bind), binding);
  const unbind = {...bind, subjectVersionId: null, expectedRevision: binding.revision, requestId: randomUUID()};
  await assert.rejects(f.call('subject.binding.set', unbind), error => {
    assert.equal((error as {code?: string}).code, archived.code);
    return hasRequestNotAppliedProof(error, unbind, {operation: 'subject.binding.set'});
  });
  assert.ok(f.store.db.prepare('SELECT id FROM project.subject_bindings WHERE id=?').get(binding.id));
});

test('legacy edge deletion and reference detachment preserve identities needed by canvas redo', async t => {
  const f = await fixture(t), {projectId} = f;
  const shot = await f.shot('Canvas closure'), other = await f.shot('Unrelated');
  const asset = f.asset(), node = await f.call('node.create', {projectId, type: 'image', assetId: asset.id, position});
  const otherNode = await f.node();
  const decorative = await f.call('edge.create', {projectId, source: node.id, target: shot.id});
  const unrelated = await f.call('edge.create', {projectId, source: otherNode.id, target: other.id});
  const attach = {projectId, sourceNodeId: node.id, targetShotId: shot.id, expectedSourceRevision: node.revision,
    expectedShotRevision: shot.revision, role: 'first_frame', requestId: randomUUID()};
  const bound = await f.call('reference.attach', attach);
  const target = {kind: 'node', id: node.id, revision: readMioTargetRevision(f.store.db, projectId, 'node', node.id)};
  const preview = canvasEditingResponses['canvas.archive.preview'].parse(await f.call('canvas.archive.preview',
    {projectId, operation: 'archive', targets: [target]}));
  const history = canvasEditingResponses['canvas.history.get'].parse(await f.call('canvas.history.get', {projectId}));
  const archiveInput = {projectId, operation: 'archive', targets: [target], historyRevision: preview.historyRevision,
    requestId: createCanvasRequestId(history.requestEpoch, randomUUID()),
    ...(preview.confirmation ? {confirmation: preview.confirmation} : {})};
  const archivedAction = canvasEditingResponses['canvas.apply'].parse(await f.call('canvas.apply', archiveInput));
  const afterArchive = canvasEditingResponses['canvas.history.get'].parse(await f.call('canvas.history.get', {projectId}));
  await f.call('canvas.history.undo', {projectId, historyRevision: archivedAction.history.revision,
    requestId: createCanvasRequestId(afterArchive.requestEpoch, randomUUID())});
  assert.deepEqual(await f.call('canvas.apply', archiveInput), archivedAction);
  await assert.rejects(f.call('edge.delete', {edgeId: decorative.id}), {code: 'CANVAS_HISTORY_DEPENDENCY'});
  assert.deepEqual(await f.call('edge.delete', {edgeId: unrelated.id}), {deleted: true});
  const detach = {projectId, edgeId: bound.edge.id, expectedShotRevision: f.store.get('shots', shot.id)!.revision, requestId: randomUUID()};
  await assert.rejects(f.call('reference.detach', detach), error => {
    assert.equal((error as {code?: string}).code, 'CANVAS_HISTORY_DEPENDENCY');
    return hasRequestNotAppliedProof(error, detach, {operation: 'reference.detach'});
  });
  assert.ok(f.store.get('edges', decorative.id));
  assert.ok(f.store.get('edges', bound.edge.id));
  assert.deepEqual(await f.call('reference.attach', attach), bound);
});

test('archived generation target rejects new submission and retry while preserving the old job result', async t => {
  const f = await fixture(t), shot = await f.shot('Generation target');
  const request = {shotId: shot.id, expectedRevision: shot.revision, providerId: 'mock', requestId: randomUUID()};
  const queued = await f.call('generation.submit', request);
  f.store.put('jobs', {...queued, status: 'failed'});
  const job = await f.call('job.get', {jobId: queued.id});
  f.mark('shots', shot.id);
  assert.deepEqual(await f.call('generation.submit', request), job);
  assert.deepEqual(await f.call('job.get', {jobId: job.id}), job);
  await assert.rejects(f.call('generation.submit', {...request, requestId: randomUUID()}), archived);
  await assert.rejects(f.call('job.retry', {jobId: job.id, requestId: randomUUID()}), archived);
  assert.equal((await f.call('job.list', {projectId: f.projectId})).length, 1);
});

test('late generation result is retained without automatically selecting it on an archived shot', async t => {
  const f = await fixture(t), shot = await f.shot('Previously accepted generation');
  const queued = await f.call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision, providerId: 'mock', requestId: randomUUID()});
  const video = path.join(f.root, 'media', 'completed.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=144x256:r=24', '-frames:v', '4', '-c:v', 'libx264', '-threads', '1', video]);
  const job = f.store.get('jobs', queued.id)!;
  f.store.put('jobs', {...job, status: 'downloading', providerJobId: 'already-accepted', submissionCount: 1});
  f.mark('shots', shot.id);
  const worker = f.startWorker(video);
  try {await worker.tick();} finally {await worker.stop();}
  const result = await f.call('job.get', {jobId: job.id});
  assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
  assert.ok(result.versionId);
  assert.deepEqual((await f.call('version.list', {shotId: shot.id})).map(version => version.id), [result.versionId]);
  assert.equal(f.store.get('shots', shot.id)?.selectedVersionId, null);
});

test('previs saves replay after archival while new saves fail', async t => {
  const f = await fixture(t), {projectId} = f;
  const node = await f.call('previs.create', {projectId, label: 'Camera', position, requestId: randomUUID()}) as PrevisNodeRecord;
  const input = {projectId, nodeId: node.id, scene: node.scene, expectedSceneRevision: node.sceneRevision, requestId: randomUUID()};
  const saved = await f.call('previs.scene.set', input) as PrevisNodeRecord;
  f.mark('nodes', node.id);
  assert.deepEqual(await f.call('previs.scene.set', input), saved);
  await assert.rejects(f.call('previs.scene.set', {...input, expectedSceneRevision: saved.sceneRevision, requestId: randomUUID()}), archived);
});

test('timeline seeding uses active shots while an existing clip and its source version survive archival', async t => {
  const f = await fixture(t), {projectId} = f;
  const live = await f.shot('Live selected shot'), hidden = await f.shot('Archived unselected shot');
  const asset = f.asset('video/mp4', 'generated'), jobId = randomUUID(), versionId = randomUUID();
  f.store.put('jobs', {id: jobId, projectId, shotId: live.id, versionId, assetId: asset.id, status: 'succeeded',
    snapshot: {projectId, shotId: live.id}});
  f.store.put('versions', {id: versionId, projectId, shotId: live.id, jobId, assetId: asset.id, number: 1, sha256: asset.sha256});
  const selection = {shotId: live.id, versionId, expectedRevision: live.revision, requestId: randomUUID()};
  const selectionAck = await f.call('version.select', selection);
  f.mark('shots', hidden.id);
  const timeline = await f.call('timeline.get', {projectId});
  const seed = {projectId, expectedRevision: timeline.revision, requestId: randomUUID()};
  const seeded = await f.call('timeline.seed', seed);
  assert.deepEqual(seeded.clips.map(clip => clip.assetId), [asset.id]);
  f.mark('shots', live.id);
  assert.deepEqual(await f.call('timeline.seed', seed), seeded);
  assert.deepEqual((await f.call('timeline.get', {projectId})).clips, seeded.clips);
  assert.deepEqual((await f.call('version.list', {shotId: live.id})).map(version => version.id), [versionId]);
  assert.deepEqual(await f.call('version.select', selection), selectionAck);
  const freshSelection = {...selection, expectedRevision: selectionAck.revision, requestId: randomUUID()};
  await assertArchivedMutation(f.store, f.call('version.select', freshSelection), live.id, freshSelection.requestId);
});

test('archive undo restores shot order and preserves a version selected on a surviving shot', async t => {
  const f = await fixture(t), {projectId} = f;
  const first = await f.shot('Archive this shot'), second = await f.shot('Select a new version here'), third = await f.shot('Keep this shot');
  const asset = f.asset('video/mp4', 'generated'), jobId = randomUUID(), versionId = randomUUID();
  f.store.put('jobs', {id: jobId, projectId, shotId: second.id, versionId, assetId: asset.id, status: 'succeeded',
    snapshot: {projectId, shotId: second.id}});
  f.store.put('versions', {id: versionId, projectId, shotId: second.id, jobId, assetId: asset.id, number: 1, sha256: asset.sha256});

  const history = async () => canvasEditingResponses['canvas.history.get'].parse(await f.call('canvas.history.get', {projectId}));
  const initial = await history();
  await f.call('canvas.apply', {projectId, operation: 'archive', historyRevision: initial.revision,
    requestId: createCanvasRequestId(initial.requestEpoch, randomUUID()),
    targets: [{kind: 'shot', id: first.id, revision: readMioTargetRevision(f.store.db, projectId, 'shot', first.id)}]});
  const visible = (await f.call('project.get', {projectId})).shots;
  assert.deepEqual(visible.map(shot => [shot.id, shot.orderIndex]), [[second.id, 0], [third.id, 1]]);
  const selected = await f.call('version.select', {shotId: second.id, versionId,
    expectedRevision: visible[0]!.revision, requestId: randomUUID()});
  const updated = await history();
  assert.equal(updated.conflict, false);
  await f.call('canvas.history.undo', {projectId, historyRevision: updated.revision,
    requestId: createCanvasRequestId(updated.requestEpoch, randomUUID())});
  const restored = (await f.call('project.get', {projectId})).shots;
  assert.deepEqual(restored.map(shot => [shot.id, shot.orderIndex]), [[first.id, 0], [second.id, 1], [third.id, 2]]);
  assert.equal(restored[1]!.selectedVersionId, versionId);
  assert.equal(restored[1]!.revision, selected.revision + 1);
});
