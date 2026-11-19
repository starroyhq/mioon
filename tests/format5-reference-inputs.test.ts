import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {upgradeProjectFormatTo5} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from './helpers/format4-release-fixture.ts';
import {prepareSequenceEditHistory, findSequenceEditReceipt} from '../packages/business/src/format5-editor-history.ts';
import {runSequenceSync} from '../packages/business/src/format5-sequence-sync.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {
  buildReferenceEdgeEnvelope, planFormat5GenerationInputs, readFormat5ShotReferenceCandidates,
  readShotReferenceEdges, resolveReferenceSource,
} from '../packages/business/src/format5-reference-inputs.ts';
import {createSequenceEditing} from '../packages/business/src/sequence-edit.ts';

let scratch: string;
before(() => {scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'format5-ri-'));});
after(() => {rmSync(scratch, {recursive: true, force: true});});

let serial = 0;
function fixture() {
  const base = path.join(scratch, `prepare-${serial++}`);
  mkdirSync(base, {mode: 0o700});
  const source = prepareFormat5Release(base, 'v0.2.0');
  const root = path.join(scratch, `ri-${serial++}`);
  cpSync(source.sample, root, {recursive: true, errorOnExist: true, force: false});
  const paths = releaseProjectPaths(root);
  for (const directory of [root, ...Object.values(paths.location)]) chmodSync(directory, 0o700);
  const upgraded = upgradeProjectFormatTo5({projectFile: paths.projectFile, locate: () => paths.location, approveUpgrade: () => true});
  return {store: upgraded.store, root, paths};
}

interface Seeded {
  store: ProjectStore;
  shotId: string;
  imageA: {nodeId: string; assetId: string};
  imageB: {nodeId: string; assetId: string};
  audio: {nodeId: string; assetId: string};
  video: {nodeId: string; assetId: string};
  cardNodeId: string;
  subjectId: string;
}
const timestamp = '2026-01-03T00:00:00.000Z';

function seed(f: ReturnType<typeof fixture>): Seeded {
  const {store} = f;
  const assetRow = store.db.prepare(`SELECT id,data FROM project.assets WHERE json_valid(data)
    AND json_extract(data,'$.mimeType') LIKE 'image/%' LIMIT 1`).get() as {id: string; data: string} | undefined;
  assert.ok(assetRow);
  const image = JSON.parse(assetRow.data) as Record<string, unknown>;
  const shot = store.db.prepare('SELECT id FROM project.shots WHERE archivedAt IS NULL ORDER BY id LIMIT 1').get() as {id: string};
  const doc = (id: string, mimeType: string, extra: Record<string, unknown> = {}): string => JSON.stringify({id, projectId: store.projectId,
    sha256: image.sha256, mimeType, sizeBytes: 1024, width: 1080, height: 1920, createdAt: timestamp, ...extra});
  const imageAsset = (): string => {
    const id = randomUUID();
    store.db.prepare('INSERT INTO project.assets(id,projectId,data) VALUES(?,?,?)').run(id, store.projectId, doc(id, 'image/png'));
    return id;
  };
  const mediaAsset = (mimeType: string, extra: Record<string, unknown>): string => {
    const id = randomUUID();
    store.db.prepare('INSERT INTO project.assets(id,projectId,data) VALUES(?,?,?)').run(id, store.projectId, doc(id, mimeType, extra));
    return id;
  };
  const node = (type: string, assetId: string): string => {
    const id = randomUUID();
    store.put('nodes', {id, projectId: store.projectId, type, assetId, position: {x: 10, y: 10}, createdAt: timestamp});
    return id;
  };
  const imageA = {nodeId: node('image', imageAsset()), assetId: ''};
  const imageB = {nodeId: node('image', imageAsset()), assetId: ''};
  const audioAssetId = mediaAsset('audio/wav', {duration: 5});
  const videoAssetId = mediaAsset('video/mp4', {duration: 4});
  const seeded: Seeded = {store, shotId: shot.id, imageA, imageB,
    audio: {nodeId: node('audio', audioAssetId), assetId: audioAssetId},
    video: {nodeId: node('video', videoAssetId), assetId: videoAssetId},
    cardNodeId: randomUUID(), subjectId: randomUUID()};
  store.tx(() => {
    const head = randomUUID();
    store.db.prepare(`INSERT INTO project.subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?)`).run(seeded.subjectId, store.projectId, 'character', 'Hero', 1, head, timestamp, timestamp);
    const versionAsset = imageAsset();
    store.db.prepare('INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)')
      .run(head, store.projectId, seeded.subjectId, 1, versionAsset,
        JSON.stringify({id: head, projectId: store.projectId, subjectId: seeded.subjectId, number: 1,
          assetId: versionAsset, sha256: image.sha256, mimeType: 'image/png', width: 1080, height: 1920,
          createdAt: timestamp, provenance: {kind: 'user-import', versionId: null, shotId: null, jobId: null}}));
    store.put('nodes', {id: seeded.cardNodeId, projectId: store.projectId, type: 'subject_card', subjectId: seeded.subjectId,
      position: {x: 10, y: 10}, createdAt: timestamp});
  });
  for (const entry of [seeded.imageA, seeded.imageB]) {
    const row = store.db.prepare('SELECT data FROM project.nodes WHERE id=?').get(entry.nodeId) as {data: string};
    entry.assetId = String((JSON.parse(row.data) as Record<string, unknown>).assetId);
  }
  return seeded;
}

function action(store: ProjectStore) {
  const state = prepareSequenceEditHistory(store);
  return {epoch: state.state.epoch, historyPosition: state.state.position, historyRevision: state.state.revision};
}

let requestSerial = 0;
function command(seeded: Seeded, kind: 'attach' | 'set-role' | 'detach', edit: Record<string, unknown>) {
  const store = seeded.store;
  const edgeId = typeof edit.edgeId === 'string' ? edit.edgeId : randomUUID();
  const requestId = `ri-reference-${++requestSerial}-${kind}`;
  const envelope = buildReferenceEdgeEnvelope(store,
    {kind, edgeId, shotId: seeded.shotId, ...edit} as never,
    {...action(store), requestId, actionId: randomUUID()});
  return {requestId, edgeId, envelope};
}

function shotProjection(store: ProjectStore, shotId: string): {referenceAssetIds: unknown[]; lastFrameAssetId: unknown} {
  const row = store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(shotId) as {data: string};
  const data = JSON.parse(row.data) as Record<string, unknown>;
  return {referenceAssetIds: Array.isArray(data.referenceAssetIds) ? data.referenceAssetIds : [], lastFrameAssetId: data.lastFrameAssetId ?? null};
}

test('reference lines: default role, role change, detach and one-step undo ride the unified history', () => {
  const seeded = seed(fixture()), {store} = seeded;
  try {
    // Attach an image with the default role, through the public service route.
    const attach = command(seeded, 'attach', {sourceNodeId: seeded.imageA.nodeId});
    const preview = createFormat5SequenceEditService(store).preview({projectId: store.projectId,
      requestId: attach.requestId, referenceIntent: attach.envelope.referenceIntent,
      allocation: {edges: attach.envelope.allocation.edges}}) as Record<string, any>;
    assert.equal(preview.ok, undefined);
    assert.ok(preview.envelope, JSON.stringify(preview));
    const receipt = createFormat5SequenceEditService(store).commit({projectId: store.projectId,
      envelope: preview.envelope, expectedPlanDigest: preview.planDigest}) as Record<string, any>;
    assert.equal(receipt.status, 'applied');
    assert.equal(receipt.operation, 'reference.attach');
    assert.equal(receipt.affected.edges, 1);
    // Default by type: an image is a first frame and refreshes the legacy projection.
    const [edge] = readShotReferenceEdges(store, seeded.shotId);
    assert.equal(edge!.kind === 'reference' ? edge!.role : null, 'first_frame');
    assert.equal(edge!.kind === 'reference' ? edge!.sourceAssetId : null, seeded.imageA.assetId);
    assert.deepEqual(shotProjection(store, seeded.shotId).referenceAssetIds, [seeded.imageA.assetId]);
    assert.equal(findSequenceEditReceipt(store, attach.requestId)?.receipt.status, 'applied');

    // A second image with a reference role is a multi-reference line: no shot
    // projection write, so the receipt reports only the edge.
    const second = command(seeded, 'attach', {sourceNodeId: seeded.imageB.nodeId, role: 'reference_image'});
    const secondReceipt = runSequenceSync(store, second.envelope) as Record<string, any>;
    assert.equal(secondReceipt.ok, true, JSON.stringify(secondReceipt));
    assert.equal(secondReceipt.receipt.affected.edges, 1);
    assert.equal(secondReceipt.receipt.affected.nodes, 0);
    assert.deepEqual(shotProjection(store, seeded.shotId).referenceAssetIds, [seeded.imageA.assetId]);
    const secondEdge = readShotReferenceEdges(store, seeded.shotId).find(candidate => candidate.kind === 'reference'
      && candidate.role === 'reference_image')!;
    assert.ok(secondEdge);

    // Change the first frame to a reference image: the legacy projection clears
    // in the same action, and one undo restores both rows.
    const roleChange = command(seeded, 'set-role', {edgeId: edge!.id, role: 'reference_image'});
    const changed = runSequenceSync(store, roleChange.envelope) as Record<string, any>;
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.deepEqual(shotProjection(store, seeded.shotId).referenceAssetIds, []);
    assert.equal(readShotReferenceEdges(store, seeded.shotId).filter(candidate => candidate.kind === 'reference'
      && candidate.role === 'first_frame').length, 0);
    const afterChange = prepareSequenceEditHistory(store);
    const undo = createSequenceEditing(store).call('sequence.undo', {projectId: store.projectId,
      requestId: `ri-undo-${randomUUID()}`, actionId: roleChange.envelope.actionId,
      expected: {position: afterChange.state.position, revision: afterChange.state.revision}}) as Record<string, any>;
    assert.equal(undo.status, 'applied');
    assert.deepEqual(shotProjection(store, seeded.shotId).referenceAssetIds, [seeded.imageA.assetId]);
    const restored = readShotReferenceEdges(store, seeded.shotId).find(candidate => candidate.kind === 'reference'
      && candidate.role === 'first_frame');
    assert.equal(restored?.id, edge!.id);
    const afterUndo = prepareSequenceEditHistory(store);
    const redo = createSequenceEditing(store).call('sequence.redo', {projectId: store.projectId,
      requestId: `ri-redo-${randomUUID()}`, actionId: roleChange.envelope.actionId,
      expected: {position: afterUndo.state.position, revision: afterUndo.state.revision}}) as Record<string, any>;
    assert.equal(redo.status, 'applied');
    assert.deepEqual(shotProjection(store, seeded.shotId).referenceAssetIds, []);

    // Detach the reference image edge; the first frame is now the image edge.
    const detach = command(seeded, 'detach', {edgeId: secondEdge.id});
    const detached = runSequenceSync(store, detach.envelope) as Record<string, any>;
    assert.equal(detached.ok, true, JSON.stringify(detached));
    assert.equal(readShotReferenceEdges(store, seeded.shotId).some(candidate => candidate.id === secondEdge.id), false);
  } finally {
    store.close();
  }
});

test('reference lines: first/last frames are exclusive, subject cards use subject binding and invalid roles are rejected', () => {
  const seeded = seed(fixture()), {store} = seeded;
  try {
    const first = command(seeded, 'attach', {sourceNodeId: seeded.imageA.nodeId, role: 'first_frame'});
    assert.equal((runSequenceSync(store, first.envelope) as Record<string, any>).ok, true);
    const last = command(seeded, 'attach', {sourceNodeId: seeded.imageB.nodeId, role: 'last_frame'});
    assert.equal((runSequenceSync(store, last.envelope) as Record<string, any>).ok, true);
    assert.equal(shotProjection(store, seeded.shotId).lastFrameAssetId, seeded.imageB.assetId);
    // A second first frame is rejected without writing.
    const duplicate = command(seeded, 'attach', {sourceNodeId: seeded.imageB.nodeId, role: 'first_frame'});
    const duplicateResult = runSequenceSync(store, duplicate.envelope) as Record<string, any>;
    assert.equal(duplicateResult.ok, false);
    assert.equal(duplicateResult.code, 'FORMAT5_REFERENCE_CARDINALITY');
    // Disconnecting the head while its tail remains is rejected.
    const head = readShotReferenceEdges(store, seeded.shotId).find(candidate => candidate.kind === 'reference'
      && candidate.role === 'first_frame')!;
    const badDetach = command(seeded, 'detach', {edgeId: head.id});
    const badDetachResult = runSequenceSync(store, badDetach.envelope) as Record<string, any>;
    assert.equal(badDetachResult.ok, false);
    assert.equal(badDetachResult.code, 'SEQUENCE_EDIT_REFERENCE_INVALID');
    // Subject cards are not material sources.
    const subjectAttach = command(seeded, 'attach', {sourceNodeId: seeded.cardNodeId});
    const subjectResult = runSequenceSync(store, subjectAttach.envelope) as Record<string, any>;
    assert.equal(subjectResult.ok, false);
    assert.equal(subjectResult.code, 'SEQUENCE_EDIT_REFERENCE_INVALID');
    // An image cannot carry an audio role.
    const wrongRole = command(seeded, 'attach', {sourceNodeId: seeded.imageA.nodeId, role: 'reference_audio'});
    assert.equal((runSequenceSync(store, wrongRole.envelope) as Record<string, any>).code, 'SEQUENCE_EDIT_REFERENCE_INVALID');
    // Audio and video defaults.
    const audio = command(seeded, 'attach', {sourceNodeId: seeded.audio.nodeId});
    assert.equal((runSequenceSync(store, audio.envelope) as Record<string, any>).ok, true);
    assert.equal(readShotReferenceEdges(store, seeded.shotId).find(candidate => candidate.id === audio.edgeId)?.kind === 'reference'
      ? (readShotReferenceEdges(store, seeded.shotId).find(candidate => candidate.id === audio.edgeId) as any).role : null, 'reference_audio');
    const video = command(seeded, 'attach', {sourceNodeId: seeded.video.nodeId});
    assert.equal((runSequenceSync(store, video.envelope) as Record<string, any>).ok, true);
    // The full candidate read keeps the persisted order and resolves assets.
    const [set] = readFormat5ShotReferenceCandidates(store, [seeded.shotId]);
    assert.equal(set!.candidates.length, 4);
    assert.deepEqual(set!.candidates.map(candidate => candidate.role), ['first_frame', 'last_frame', 'reference_audio', 'reference_video']);
    assert.equal(resolveReferenceSource(store, seeded.audio.nodeId).mimeType, 'audio/wav');
  } finally {
    store.close();
  }
});

test('reference generation planning combines frames, multi-image references, previs composition and reference audio against the exact profile', () => {
  const seeded = seed(fixture()), {store} = seeded;
  try {
    const binding = {
      version: 1, connectionId: randomUUID(), configurationRevision: 1, providerId: 'ark',
      region: 'cn-beijing', workspaceId: '', endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
      credentialRef: '00000000-0000-4000-8000-000000000000',
      model: {id: randomUUID(), name: 'doubao-seedance-2-5-260628', modelId: 'doubao-seedance-2-5-260628',
        templateId: 'ark-v3', enabled: true, archived: false, inputModes: ['text', 'image', 'frames', 'reference'],
        aspectRatios: ['9:16', '16:9'], durationResolutionMap: [{duration: [4, 8], resolution: ['720p']}],
        audio: 'off', seed: false},
      outputHosts: ['output.example'],
    } as never;
    // Frames mode: first and last frame are the actual saved-shot selection.
    for (const [nodeId, role] of [[seeded.imageA.nodeId, 'first_frame'], [seeded.imageB.nodeId, 'last_frame']] as const) {
      const attach = command(seeded, 'attach', {sourceNodeId: nodeId, role});
      assert.equal((runSequenceSync(store, attach.envelope) as Record<string, any>).ok, true);
    }
    const framesPlan = planFormat5GenerationInputs(store, seeded.shotId, {binding});
    assert.equal(framesPlan.mode, 'frames');
    assert.deepEqual(framesPlan.images.map(image => image.role), ['first_frame', 'last_frame']);
    assert.equal(framesPlan.entries.filter(entry => entry.status === 'unsupported').length, 0);
    // Planning never writes the timeline: reference audio is a generation
    // input only and must not be mixed into playback.
    const timelineBefore = JSON.stringify(store.db.prepare('SELECT data FROM project.timelines').get());
    // Reference audio is not usable on this service; it stays recorded as unsupported.
    const audio = command(seeded, 'attach', {sourceNodeId: seeded.audio.nodeId});
    runSequenceSync(store, audio.envelope);
    const withAudio = planFormat5GenerationInputs(store, seeded.shotId, {binding});
    assert.equal(JSON.stringify(store.db.prepare('SELECT data FROM project.timelines').get()), timelineBefore);
    const audioEntry = withAudio.entries.find(entry => entry.role === 'reference_audio')!;
    assert.equal(audioEntry.status, 'unsupported');
    assert.equal(audioEntry.reason, 'EXCLUSIVE_MODE');
    // Remove the tail frame and switch the multi-reference mode on: two images
    // are sent in persisted order and the primary image moves first.
    const lastEdge = readShotReferenceEdges(store, seeded.shotId).find(candidate => candidate.kind === 'reference'
      && candidate.role === 'last_frame')!;
    const detachLast = command(seeded, 'detach', {edgeId: lastEdge.id});
    runSequenceSync(store, detachLast.envelope);
    const firstEdge = readShotReferenceEdges(store, seeded.shotId).find(candidate => candidate.kind === 'reference'
      && candidate.role === 'first_frame')!;
    const refA = command(seeded, 'set-role', {edgeId: firstEdge.id, role: 'reference_image'});
    runSequenceSync(store, refA.envelope);
    const imageBEdge = command(seeded, 'attach', {sourceNodeId: seeded.imageB.nodeId, role: 'reference_image'});
    runSequenceSync(store, imageBEdge.envelope);
    const references = planFormat5GenerationInputs(store, seeded.shotId, {binding});
    assert.equal(references.mode, 'references');
    assert.deepEqual(references.images.map(image => image.assetId), [seeded.imageA.assetId, seeded.imageB.assetId]);
    const primary = planFormat5GenerationInputs(store, seeded.shotId, {binding, primaryReferenceId: imageBEdge.edgeId});
    assert.deepEqual(primary.images.map(image => image.assetId), [seeded.imageB.assetId, seeded.imageA.assetId]);
    // Seedance's reference audio becomes an actual request clip in this mode.
    const withAudioReferences = planFormat5GenerationInputs(store, seeded.shotId, {binding});
    const audioUsed = withAudioReferences.entries.find(entry => entry.role === 'reference_audio')!;
    assert.equal(audioUsed.status, 'used');
    assert.deepEqual(withAudioReferences.audios.map(audio => audio.assetId), [seeded.audio.assetId]);
    assert.equal(withAudioReferences.entries.find(entry => entry.role === 'first_frame'), undefined);
    assert.equal(withAudioReferences.unsupported, 0);
  } finally {
    store.close();
  }
});
