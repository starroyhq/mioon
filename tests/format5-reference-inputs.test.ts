import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {upgradeProjectFormatTo5} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from './helpers/format4-release-fixture.ts';
import {prepareSequenceEditHistory, findSequenceEditReceipt} from '../packages/business/src/format5-editor-history.ts';
import {runSequenceSync} from '../packages/business/src/format5-sequence-sync.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {
  buildReferenceEdgeEnvelope, format5GenerationSource, planFormat5GenerationInputs, readFormat5GenerationInputView,
  readFormat5ShotReferenceCandidates, readShotReferenceEdges, resolveReferenceSource,
} from '../packages/business/src/format5-reference-inputs.ts';
import {createPrevisPublicationServices} from '../packages/business/src/previs-publication.ts';
import {defaultPrevisScene} from '../packages/contracts/src/previs.ts';
import type {PrevisFigure, PrevisProp, PrevisScene, PrevisSubjectReference} from '../packages/contracts/src/previs.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {buildSubjectBindingEnvelope} from '../packages/business/src/format5-subject-binding.ts';
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
  const node = (type: string, assetId: string, label: string): string => {
    const id = randomUUID();
    store.put('nodes', {id, projectId: store.projectId, type, assetId, label, position: {x: 10, y: 10}, createdAt: timestamp});
    return id;
  };
  const imageA = {nodeId: node('image', imageAsset(), '参考图 A'), assetId: ''};
  const imageB = {nodeId: node('image', imageAsset(), '参考图 B'), assetId: ''};
  const audioAssetId = mediaAsset('audio/wav', {duration: 5});
  const videoAssetId = mediaAsset('video/mp4', {duration: 4});
  const seeded: Seeded = {store, shotId: shot.id, imageA, imageB,
    audio: {nodeId: node('audio', audioAssetId, '对白'), assetId: audioAssetId},
    video: {nodeId: node('video', videoAssetId, '运镜参考'), assetId: videoAssetId},
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

interface OwnedSubjectVersion {readonly id: string; readonly number: number; readonly assetId: string; readonly sha256: string}
interface OwnedSubject {readonly subjectId: string; readonly cardNodeId: string;
  readonly kind: 'character' | 'product' | 'location' | 'look'; readonly name: string; readonly versions: OwnedSubjectVersion[]}

function imageAssetRow(store: ProjectStore): {assetId: string; sha256: string} {
  const assetId = randomUUID(), sha256 = createHash('sha256').update(assetId).digest('hex');
  store.db.prepare('INSERT INTO project.assets(id,projectId,data) VALUES(?,?,?)').run(assetId, store.projectId,
    JSON.stringify({id: assetId, projectId: store.projectId, sha256, mimeType: 'image/png', sizeBytes: 1024,
      width: 1080, height: 1920, createdAt: timestamp}));
  return {assetId, sha256};
}

function insertSubjectVersion(store: ProjectStore, subjectId: string, versionId: string, number: number,
  asset: {assetId: string; sha256: string}): OwnedSubjectVersion {
  store.db.prepare('INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)')
    .run(versionId, store.projectId, subjectId, number, asset.assetId, JSON.stringify({id: versionId,
      projectId: store.projectId, subjectId, number, assetId: asset.assetId, sha256: asset.sha256,
      mimeType: 'image/png', width: 1080, height: 1920, createdAt: timestamp,
      provenance: {kind: 'user-import', versionId: null, shotId: null, jobId: null}}));
  return {id: versionId, number, assetId: asset.assetId, sha256: asset.sha256};
}

function createSubject(store: ProjectStore, kind: OwnedSubject['kind'], name: string): OwnedSubject {
  const subjectId = randomUUID(), cardNodeId = randomUUID(), headVersionId = randomUUID();
  const versions: OwnedSubjectVersion[] = [];
  store.tx(() => {
    store.db.prepare(`INSERT INTO project.subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?)`).run(subjectId, store.projectId, kind, name, 1, headVersionId, timestamp, timestamp);
    versions.push(insertSubjectVersion(store, subjectId, headVersionId, 1, imageAssetRow(store)));
    store.put('nodes', {id: cardNodeId, projectId: store.projectId, type: 'subject_card', subjectId,
      position: {x: 10, y: 10}, createdAt: timestamp});
  });
  return {subjectId, cardNodeId, kind, name, versions};
}

/** Add a new head version; the follow references of that subject move to it. */
function addSubjectVersion(store: ProjectStore, subject: OwnedSubject): OwnedSubjectVersion {
  let version: OwnedSubjectVersion | null = null;
  store.tx(() => {
    const number = subject.versions.length + 1;
    version = insertSubjectVersion(store, subject.subjectId, randomUUID(), number, imageAssetRow(store));
    store.db.prepare('UPDATE project.subjects SET headVersionId=?, revision=? WHERE id=?')
      .run(version.id, number, subject.subjectId);
  });
  assert.ok(version);
  subject.versions.push(version);
  return version;
}

function previsScene(options: {readonly figures?: readonly (PrevisSubjectReference | null)[];
  readonly props?: readonly (PrevisSubjectReference | null)[]} = {}): PrevisScene {
  const scene = defaultPrevisScene();
  const figures = (options.figures ?? [null]).map((subject, index): PrevisFigure => ({id: `f${index + 1}`, name: '',
    visible: true, position: [index * 0.5, 0, 0], rotation: 0, pose: 'stand', held: null,
    ...(subject ? {subject} : {})}));
  const props = (options.props ?? []).map((subject, index): PrevisProp => ({id: `p${index + 1}`, kind: 'box', name: '',
    visible: true, position: [index * 0.5, 0, 1], rotation: 0, size: [0.5, 0.5, 0.5],
    ...(subject ? {subject} : {})}));
  return {...scene, figures, props, keyframes: [{id: 'k1', name: '', camera: scene.camera, exports: []}],
    activeKeyframeId: 'k1'};
}

/** Write a valid previs node and publish one verifiable output image for it. */
async function publishPrevis(store: ProjectStore, scene: PrevisScene, label: string):
  Promise<{nodeId: string; outputAssetId: string}> {
  const nodeId = randomUUID();
  store.tx(() => store.put('nodes', {id: nodeId, projectId: store.projectId, type: 'previs', label, text: '',
    position: {x: 120, y: 240}, revision: 1, sceneRevision: 1, scene, createdAt: timestamp}));
  const bytes = png({width: 64, height: 96, rgba: false});
  const publication = await createPrevisPublicationServices(store).handlers['previs.output.publish']({
    projectId: store.projectId, nodeId, keyframeId: 'k1', sceneRevision: 1,
    requestId: `previs-output-${randomUUID()}`, name: '预演画面.png',
    sha256: createHash('sha256').update(bytes).digest('hex'), width: 64, height: 96,
    dataBase64: bytes.toString('base64')}) as {asset: {id: string}};
  return {nodeId, outputAssetId: publication.asset.id};
}

function attachNode(seeded: Seeded, sourceNodeId: string, role?: string): void {
  const result = runSequenceSync(seeded.store,
    command(seeded, 'attach', {sourceNodeId, ...(role ? {role} : {})}).envelope) as Record<string, any>;
  assert.equal(result.ok, true, JSON.stringify(result));
}

const arkBinding = () => ({version: 1, connectionId: randomUUID(), configurationRevision: 1, providerId: 'ark',
  region: 'cn-beijing', workspaceId: '', endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
  credentialRef: '00000000-0000-4000-8000-000000000000',
  model: {id: randomUUID(), name: 'doubao-seedance-2-5-260628', modelId: 'doubao-seedance-2-5-260628',
    templateId: 'ark-v3', enabled: true, archived: false, inputModes: ['text', 'image', 'frames', 'reference'],
    aspectRatios: ['9:16', '16:9'], durationResolutionMap: [{duration: [4, 8], resolution: ['720p']}],
    audio: 'off', seed: false},
  outputHosts: ['output.example']}) as never;

const wanBinding = () => ({version: 1, connectionId: randomUUID(), configurationRevision: 1, providerId: 'wan',
  region: 'cn-beijing', workspaceId: '', endpoint: 'https://dashscope.aliyuncs.com/api/v1',
  credentialRef: '00000000-0000-4000-8000-000000000001',
  model: {id: randomUUID(), name: 'wan3.0-video', modelId: 'wan3.0-video', templateId: 'wan30-v1',
    enabled: true, archived: false, inputModes: ['text', 'image', 'frames', 'reference'],
    aspectRatios: ['9:16', '16:9'], durationResolutionMap: [{duration: [4, 8], resolution: ['720P']}],
    audio: 'optional', seed: true},
  outputHosts: ['output.example']}) as never;

function action(store: ProjectStore) {
  const state = prepareSequenceEditHistory(store);
  return {epoch: state.state.epoch, historyPosition: state.state.position, historyRevision: state.state.revision};
}

let requestSerial = 0;
function command(seeded: Seeded, kind: 'attach' | 'set-role' | 'detach' | 'reorder', edit: Record<string, unknown>) {
  const store = seeded.store;
  const edgeId = typeof edit.edgeId === 'string' ? edit.edgeId : randomUUID();
  const requestId = `ri-reference-${++requestSerial}-${kind}`;
  const envelope = buildReferenceEdgeEnvelope(store,
    (kind === 'reorder' ? {kind, shotId: seeded.shotId, edgeIds: edit.edgeIds}
      : {kind, edgeId, shotId: seeded.shotId, ...edit}) as never,
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
    assert.deepEqual(set!.candidates.map(candidate => candidate.orderIndex), [0, 1, 2, 3]);
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

test('reference reorder sets the primary image order and stays one undoable board action', () => {
  const seeded = seed(fixture()), {store} = seeded;
  try {
    const first = command(seeded, 'attach', {sourceNodeId: seeded.imageA.nodeId, role: 'reference_image'});
    assert.equal((runSequenceSync(store, first.envelope) as Record<string, any>).ok, true);
    const second = command(seeded, 'attach', {sourceNodeId: seeded.imageB.nodeId, role: 'reference_image'});
    assert.equal((runSequenceSync(store, second.envelope) as Record<string, any>).ok, true);
    const audio = command(seeded, 'attach', {sourceNodeId: seeded.audio.nodeId});
    assert.equal((runSequenceSync(store, audio.envelope) as Record<string, any>).ok, true);
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
    const before = readFormat5GenerationInputView(store, seeded.shotId, {binding});
    assert.equal(before.primaryEdgeId, first.edgeId);
    assert.deepEqual(planFormat5GenerationInputs(store, seeded.shotId, {binding}).images.map(image => image.assetId),
      [seeded.imageA.assetId, seeded.imageB.assetId]);
    // Put the second image first: it becomes the primary image and numbering base.
    const reorder = command(seeded, 'reorder', {edgeIds: [second.edgeId, first.edgeId, audio.edgeId]});
    const receipt = runSequenceSync(store, reorder.envelope) as Record<string, any>;
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.receipt.operation, 'reference.reorder');
    assert.deepEqual(planFormat5GenerationInputs(store, seeded.shotId, {binding}).images.map(image => image.assetId),
      [seeded.imageB.assetId, seeded.imageA.assetId]);
    const after = readFormat5GenerationInputView(store, seeded.shotId, {binding});
    assert.equal(after.primaryEdgeId, second.edgeId);
    assert.equal(after.primaryEdgeId, after.entries.find(entry => entry.primary)?.edgeId);
    // A partial or foreign order list is rejected without writing.
    const invalid = command(seeded, 'reorder', {edgeIds: [first.edgeId]});
    const invalidResult = runSequenceSync(store, invalid.envelope) as Record<string, any>;
    assert.equal(invalidResult.ok, false);
    assert.equal(invalidResult.code, 'SEQUENCE_EDIT_REFERENCE_INVALID');
    // Undo restores the original provider order.
    const afterChange = prepareSequenceEditHistory(store);
    const undo = createSequenceEditing(store).call('sequence.undo', {projectId: store.projectId,
      requestId: `ri-undo-reorder-${randomUUID()}`, actionId: reorder.envelope.actionId,
      expected: {position: afterChange.state.position, revision: afterChange.state.revision}}) as Record<string, any>;
    assert.equal(undo.status, 'applied');
    assert.deepEqual(planFormat5GenerationInputs(store, seeded.shotId, {binding}).images.map(image => image.assetId),
      [seeded.imageA.assetId, seeded.imageB.assetId]);
  } finally {
    store.close();
  }
});

test('the generation-input view reports mode, resolved labels, subject versions, used and unsupported entries', () => {
  const seeded = seed(fixture()), {store} = seeded;
  try {
    runSequenceSync(store, command(seeded, 'attach', {sourceNodeId: seeded.imageA.nodeId, role: 'reference_image'}).envelope);
    runSequenceSync(store, command(seeded, 'attach', {sourceNodeId: seeded.imageB.nodeId, role: 'reference_image'}).envelope);
    runSequenceSync(store, command(seeded, 'attach', {sourceNodeId: seeded.audio.nodeId}).envelope);
    // A subject binding enters the same plan through the SB intent.
    const bindingId = randomUUID(),
      state = prepareSequenceEditHistory(store);
    const subjectEnvelope = buildSubjectBindingEnvelope(store, {kind: 'create', bindingId,
      shotId: seeded.shotId, subjectId: seeded.subjectId, role: 'subject'},
      {requestId: `ri-subject-${randomUUID()}`, actionId: randomUUID(), edgeId: randomUUID(),
        epoch: state.state.epoch, historyPosition: state.state.position, historyRevision: state.state.revision});
    assert.equal((runSequenceSync(store, subjectEnvelope) as Record<string, any>).ok, true);
    // Without a selected service every connected input stays visible but unsupported.
    const unselected = readFormat5GenerationInputView(store, seeded.shotId);
    assert.equal(unselected.service, null);
    assert.equal(unselected.mode, 'references');
    assert.ok(unselected.entries.length >= 4);
    assert.equal(unselected.usedCount, 0);
    assert.ok(unselected.entries.every(entry => entry.status === 'unsupported' && entry.reason === 'SERVICE_NOT_SELECTED'));
    const ark = {
      version: 1, connectionId: randomUUID(), configurationRevision: 1, providerId: 'ark',
      region: 'cn-beijing', workspaceId: '', endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
      credentialRef: '00000000-0000-4000-8000-000000000000',
      model: {id: randomUUID(), name: 'doubao-seedance-2-5-260628', modelId: 'doubao-seedance-2-5-260628',
        templateId: 'ark-v3', enabled: true, archived: false, inputModes: ['text', 'image', 'frames', 'reference'],
        aspectRatios: ['9:16', '16:9'], durationResolutionMap: [{duration: [4, 8], resolution: ['720p']}],
        audio: 'off', seed: false},
      outputHosts: ['output.example'],
    } as never;
    const view = readFormat5GenerationInputView(store, seeded.shotId, {binding: ark});
    assert.equal(view.service?.providerId, 'ark');
    assert.equal(view.mode, 'references');
    assert.equal(view.unsupportedCount, 0);
    assert.equal(view.usedCount, 4);
    const image = view.entries.find(entry => entry.edgeId === readShotReferenceEdges(store, seeded.shotId)[0]!.id)!;
    assert.equal(image.label, '参考图 A');
    assert.equal(image.sourceKind, 'image');
    assert.equal(image.status, 'used');
    const subject = view.entries.find(entry => entry.source === 'subject')!;
    assert.equal(subject.label, 'Hero');
    assert.equal(subject.subjectVersionNumber, 1);
    assert.equal(subject.role, 'subject_reference');
    // A service without reference support marks every non-frame line explicitly.
    const wan = {...(ark as Record<string, any>), model: {...(ark as Record<string, any>).model,
      modelId: 'wan3.0-video', templateId: 'wan30-v1', inputModes: ['text', 'image', 'frames', 'reference']}} as never;
    const wanView = readFormat5GenerationInputView(store, seeded.shotId, {binding: wan});
    assert.ok(wanView.entries.some(entry => entry.role === 'reference_audio' && entry.status === 'unsupported'));
  } finally {
    store.close();
  }
});


test('previs scene subjects enter generation inputs: follow and locked versions, look as style and the frozen plan', async () => {
  const seeded = seed(fixture()), {store} = seeded;
  try {
    const hero = createSubject(store, 'character', '阿璃');
    const look = createSubject(store, 'look', '霓虹色');
    const previs = await publishPrevis(store, previsScene({
      figures: [{subjectId: hero.subjectId}],
      props: [{subjectId: look.subjectId, subjectVersionId: look.versions[0]!.id}],
    }), '街口');
    attachNode(seeded, previs.nodeId);
    const binding = arkBinding();
    const plan = planFormat5GenerationInputs(store, seeded.shotId, {binding});
    // The previs material line itself is unchanged: an edge composition input.
    const sceneEntry = plan.entries.find(entry => entry.source === 'edge' && entry.sourceKind === 'previs')!;
    assert.equal(sceneEntry.role, 'composition');
    assert.equal(sceneEntry.label, '街口');
    const subjects = plan.entries.filter(entry => entry.source === 'previs');
    assert.deepEqual(subjects.map(entry => entry.subjectId), [hero.subjectId, look.subjectId]);
    const [heroEntry, lookEntry] = subjects;
    assert.equal(heroEntry!.source, 'previs');
    assert.equal(heroEntry!.sourceNodeId, previs.nodeId);
    assert.equal(heroEntry!.sourceKind, 'subject');
    assert.equal(heroEntry!.role, 'subject_reference');
    assert.equal(heroEntry!.bindingMode, 'follow');
    assert.equal(heroEntry!.subjectVersionId, hero.versions[0]!.id);
    assert.equal(heroEntry!.subjectVersionNumber, 1);
    assert.equal(heroEntry!.assetId, hero.versions[0]!.assetId);
    assert.equal(heroEntry!.label, '街口 · 阿璃');
    assert.equal(heroEntry!.status, 'used');
    assert.equal(lookEntry!.role, 'style_reference');
    assert.equal(lookEntry!.bindingMode, 'locked');
    assert.equal(lookEntry!.subjectVersionId, look.versions[0]!.id);
    assert.equal(lookEntry!.label, '街口 · 霓虹色');
    assert.equal(plan.mode, 'references');
    assert.deepEqual(plan.entries.map(entry => entry.orderIndex), [0, 1, 2]);
    assert.deepEqual(plan.images.map(image => image.assetId),
      [previs.outputAssetId, hero.versions[0]!.assetId, look.versions[0]!.assetId]);
    // The freeze carries the exact version each reference used.
    const freeze = format5GenerationSource(plan, binding as never).freeze;
    assert.deepEqual(freeze.entries.filter(entry => entry.source === 'previs').map(entry =>
      ({role: entry.role, subjectId: entry.subjectId, subjectVersionId: entry.subjectVersionId,
        bindingMode: entry.bindingMode, orderIndex: entry.orderIndex, sourceNodeId: entry.sourceNodeId})), [
      {role: 'subject_reference', subjectId: hero.subjectId, subjectVersionId: hero.versions[0]!.id,
        bindingMode: 'follow', orderIndex: 1, sourceNodeId: previs.nodeId},
      {role: 'style_reference', subjectId: look.subjectId, subjectVersionId: look.versions[0]!.id,
        bindingMode: 'locked', orderIndex: 2, sourceNodeId: previs.nodeId},
    ]);
    const frozenBytes = JSON.stringify(freeze);
    // A follow reference reads the next head; a locked one keeps its version.
    const heroV2 = addSubjectVersion(store, hero);
    const lookV2 = addSubjectVersion(store, look);
    const next = planFormat5GenerationInputs(store, seeded.shotId, {binding});
    const nextHero = next.entries.find(entry => entry.source === 'previs' && entry.subjectId === hero.subjectId)!;
    const nextLook = next.entries.find(entry => entry.source === 'previs' && entry.subjectId === look.subjectId)!;
    assert.equal(nextHero.subjectVersionId, heroV2.id);
    assert.equal(nextHero.assetId, heroV2.assetId);
    assert.equal(nextHero.subjectVersionNumber, 2);
    assert.equal(nextLook.subjectVersionId, look.versions[0]!.id);
    assert.equal(nextLook.assetId, look.versions[0]!.assetId);
    assert.equal(lookV2.id, look.versions[1]!.id);
    assert.equal(JSON.stringify(freeze), frozenBytes);
  } finally {
    store.close();
  }
});

test('a subject directly bound to the shot wins over the same subject named by a previs scene', async () => {
  const seeded = seed(fixture()), {store} = seeded;
  try {
    const hero = createSubject(store, 'character', '阿璃');
    const heroV2 = addSubjectVersion(store, hero);
    // Direct binding locked to v1 while the subject head already moved to v2.
    const bindingId = randomUUID();
    let state = prepareSequenceEditHistory(store);
    const created = buildSubjectBindingEnvelope(store, {kind: 'create', bindingId, shotId: seeded.shotId,
      subjectId: hero.subjectId, role: 'subject'}, {requestId: `ri-previs-direct-${randomUUID()}`, actionId: randomUUID(),
      edgeId: randomUUID(), epoch: state.state.epoch, historyPosition: state.state.position, historyRevision: state.state.revision});
    assert.equal((runSequenceSync(store, created) as Record<string, any>).ok, true);
    state = prepareSequenceEditHistory(store);
    const locked = buildSubjectBindingEnvelope(store, {kind: 'set-mode', bindingId, bindingMode: 'locked',
      subjectVersionId: hero.versions[0]!.id}, {requestId: `ri-previs-lock-${randomUUID()}`, actionId: randomUUID(),
      edgeId: randomUUID(), epoch: state.state.epoch, historyPosition: state.state.position, historyRevision: state.state.revision});
    const lockedResult = runSequenceSync(store, locked) as Record<string, any>;
    assert.equal(lockedResult.ok, true, JSON.stringify(lockedResult));
    // The previs scene names the same subject twice (figure follow, prop locked v2).
    const previs = await publishPrevis(store, previsScene({
      figures: [{subjectId: hero.subjectId}],
      props: [{subjectId: hero.subjectId, subjectVersionId: heroV2.id}],
    }), '街口');
    attachNode(seeded, previs.nodeId);
    const plan = planFormat5GenerationInputs(store, seeded.shotId, {binding: arkBinding()});
    const heroEntries = plan.entries.filter(entry => entry.subjectId === hero.subjectId);
    assert.equal(heroEntries.length, 1);
    const [direct] = heroEntries;
    assert.equal(direct!.source, 'subject');
    assert.equal(direct!.bindingId, bindingId);
    assert.equal(direct!.bindingMode, 'locked');
    assert.equal(direct!.subjectVersionId, hero.versions[0]!.id);
    assert.equal(direct!.role, 'subject_reference');
    assert.equal(plan.entries.some(entry => entry.source === 'previs' && entry.subjectId === hero.subjectId), false);
    // Dense numbering: the composition edge is 0, the direct binding 1.
    assert.deepEqual(plan.entries.map(entry => entry.orderIndex), [0, 1]);
    const [set] = readFormat5ShotReferenceCandidates(store, [seeded.shotId]);
    assert.deepEqual(set!.candidates.map(candidate => candidate.orderIndex), [0, 1]);
    assert.equal(set!.candidates[1]!.subjectId, hero.subjectId);
    assert.equal(set!.candidates[1]!.bindingId, bindingId);
  } finally {
    store.close();
  }
});

test('previs scene subjects reuse the RI capacity, unsupported-service and exclusive-mode reasons', async () => {
  const seeded = seed(fixture()), {store} = seeded;
  try {
    const subjects = Array.from({length: 11}, (_, index) =>
      createSubject(store, index < 8 ? 'character' : 'look', `主体 ${index + 1}`));
    const previs = await publishPrevis(store, previsScene({
      figures: subjects.slice(0, 8).map(subject => ({subjectId: subject.subjectId})),
      props: subjects.slice(8).map(subject => ({subjectId: subject.subjectId, subjectVersionId: subject.versions[0]!.id})),
    }), '街口');
    attachNode(seeded, previs.nodeId);
    // Wan 3.0 accepts at most 10 reference images: the last two previs rows are over capacity.
    const capacity = planFormat5GenerationInputs(store, seeded.shotId, {binding: wanBinding()});
    assert.equal(capacity.mode, 'references');
    assert.equal(capacity.entries.filter(entry => entry.status === 'used').length, 10);
    assert.equal(capacity.images.length, 10);
    const over = capacity.entries.filter(entry => entry.reason === 'CAPACITY_EXCEEDED');
    assert.equal(over.length, 2);
    assert.ok(over.every(entry => entry.status === 'unsupported' && entry.source === 'previs'));
    // A service without reference images reports the stable unsupported reason.
    const noReference = arkBinding() as Record<string, any>;
    const noReferencePlan = planFormat5GenerationInputs(store, seeded.shotId,
      {binding: {...noReference, model: {...noReference.model, inputModes: ['text', 'image', 'frames']}} as never});
    assert.ok(noReferencePlan.entries.filter(entry => entry.source === 'previs')
      .every(entry => entry.status === 'unsupported' && entry.reason === 'UNSUPPORTED_REFERENCE_IMAGES'));
    // Without a selected service every connected input stays visible and unsupported.
    const unselected = planFormat5GenerationInputs(store, seeded.shotId);
    assert.ok(unselected.entries.filter(entry => entry.source === 'previs')
      .every(entry => entry.status === 'unsupported' && entry.reason === 'SERVICE_NOT_SELECTED'));
    // Any previs reference role triggers the scene subjects: use the line as the first frame.
    const previsEdge = readShotReferenceEdges(store, seeded.shotId)[0]!;
    const roleChange = command(seeded, 'set-role', {edgeId: previsEdge.id, role: 'first_frame'});
    assert.equal((runSequenceSync(store, roleChange.envelope) as Record<string, any>).ok, true);
    attachNode(seeded, seeded.imageA.nodeId, 'last_frame');
    const frames = planFormat5GenerationInputs(store, seeded.shotId, {binding: arkBinding()});
    assert.equal(frames.mode, 'frames');
    assert.equal(frames.entries.find(entry => entry.edgeId === previsEdge.id)!.appliedRole, 'first_frame');
    const frameSubjects = frames.entries.filter(entry => entry.source === 'previs');
    assert.equal(frameSubjects.length, 11);
    assert.ok(frameSubjects.every(entry => entry.status === 'unsupported' && entry.reason === 'EXCLUSIVE_MODE'));
  } finally {
    store.close();
  }
});

test('an archived previs node is ignored and an unverifiable previs output is not silently dropped', async () => {
  const seeded = seed(fixture()), {store} = seeded;
  try {
    const hero = createSubject(store, 'character', '阿璃');
    const previs = await publishPrevis(store, previsScene({figures: [{subjectId: hero.subjectId}]}), '街口');
    attachNode(seeded, previs.nodeId);
    const binding = arkBinding();
    assert.equal(planFormat5GenerationInputs(store, seeded.shotId, {binding})
      .entries.filter(entry => entry.source === 'previs').length, 1);
    // An archived endpoint hides the reference line: no candidate and no error.
    const archiveBatchId = randomUUID();
    store.tx(() => {store.db.prepare('UPDATE project.nodes SET archivedAt=?, archiveBatchId=?, archiveReason=? WHERE id=?')
      .run(timestamp, archiveBatchId, 'user-delete', previs.nodeId);});
    const archived = planFormat5GenerationInputs(store, seeded.shotId, {binding});
    assert.equal(archived.mode, 'text');
    assert.equal(archived.entries.length, 0);
    // A live node without a verifiable published output keeps the RI error semantics.
    store.tx(() => {store.db.prepare('UPDATE project.nodes SET archivedAt=NULL, archiveBatchId=NULL, archiveReason=NULL WHERE id=?')
      .run(previs.nodeId);});
    // Drop the published evidence outside the content fence: the read path must
    // refuse a live previs line that has no verifiable output.
    store.db.prepare('DELETE FROM project.assets WHERE id=?').run(previs.outputAssetId);
    assert.throws(() => planFormat5GenerationInputs(store, seeded.shotId, {binding}), (error: unknown) => {
      const value = error as {code?: unknown; details?: {reason?: unknown}};
      return value.code === 'SEQUENCE_EDIT_REFERENCE_INVALID' && value.details?.reason === 'PREVIS_OUTPUT_REQUIRED';
    });
  } finally {
    store.close();
  }
});
