import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createBoardUiWireFixture, BOARD_IDS} from './helpers/board-ui-wire-fixture.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {sequenceEditRpcSchemas, sequenceBoardGetResponseSchema} from '../packages/contracts/src/sequence-edit-rpc.ts';
import {operationEffects, operationEffect} from '../packages/contracts/src/operation-effects.ts';
import {defaultPrevisScene} from '../packages/contracts/src/previs.ts';
import {FORMAT5_MOCK_INPUT_CONFIGURATION_REVISION,FORMAT5_MOCK_INPUT_CONNECTION_ID,FORMAT5_MOCK_INPUT_MODEL_ENTRY_ID} from '../packages/contracts/src/sequence-inspection.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

type Services = Awaited<ReturnType<typeof createBoardUiWireFixture>>['services'];
async function boardFixture(t: test.TestContext) {
  const fixture = await createBoardUiWireFixture();
  t.after(async () => {
    await (fixture.services as unknown as {drain?: () => Promise<unknown>}).drain?.();
    fixture.store.close(); fixture.library.close();
  });
  return fixture;
}
const intent = (operation: Record<string, unknown>) => ({side: 'board', operation});
type Call = (operation: string, input: unknown) => Promise<any>;
function callOf(services: Services): Call {
  return (operation, input) => (services.call as unknown as (operation: string, input: unknown) => Promise<any>)(operation, input);
}

async function previewCommit(call: Call, projectId: string, operations: readonly Record<string, unknown>[], allocation?: unknown) {
  const preview = await call('sequence.preview', {projectId, requestId: `preview-${randomUUID()}`,
    intents: operations.map(intent), ...(allocation ? {allocation} : {})});
  assert.equal(preview.ok, undefined, JSON.stringify(preview));
  const committed = await call('sequence.commit', {projectId, envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest});
  assert.equal(committed.status, 'applied');
  return {preview, committed};
}

test('the real project service mounts the board, changes versions, appends shots and undoes them', async (t: test.TestContext) => {
  const f = await boardFixture(t);
  const call = callOf(f.services);
  const project = await call('project.get', {projectId: f.projectId});
  assert.equal(project.projectFormatVersion, undefined); // the host adds the version outside the kernel response
  const mount = await call('sequence.board.get', {projectId: f.projectId});
  assert.equal(mount.inSync, true);
  assert.deepEqual(mount.archived, []);
  assert.equal(sequenceBoardGetResponseSchema.safeParse(mount).success, true);

  const version = await previewCommit(call, f.projectId, [{kind: 'board-version', nodeId: BOARD_IDS.shotA,
    version: {id: BOARD_IDS.versionA2, sourceFrames: 90}}]);
  assert.equal(version.committed.operation, 'board.version');
  const afterVersion = await call('project.get', {projectId: f.projectId});
  const clipA = afterVersion.timeline.clips.find((clip: any) => clip.sequenceSource?.nodeId === BOARD_IDS.shotA);
  assert.equal(clipA.versionId, BOARD_IDS.versionA2);
  assert.equal(afterVersion.shots.find((shot: any) => shot.id === BOARD_IDS.shotA).selectedVersionId, BOARD_IDS.versionA2);

  const appendedId = randomUUID();
  const appended = await previewCommit(call, f.projectId, [{kind: 'board.shot.append', nodeId: appendedId, name: '新镜头'}]);
  assert.equal(appended.committed.operation, 'board.shot.append');
  const afterAppend = await call('project.get', {projectId: f.projectId});
  assert.equal(afterAppend.shots.some((shot: any) => shot.id === appendedId), true);
  assert.equal(afterAppend.timeline.clips.at(-1)?.sequenceSource?.nodeId, appendedId);
  assert.equal((await call('sequence.history.get', {projectId: f.projectId})).undo.operation, 'board.shot.append');
  assert.equal((await call('sequence.board.get', {projectId: f.projectId})).inSync, true);

  const view = await call('sequence.history.get', {projectId: f.projectId});
  await call('sequence.undo', {projectId: f.projectId, requestId: `undo-${randomUUID()}`,
    actionId: view.undo.actionId, expected: {position: view.position, revision: view.revision}});
  const afterUndo = await call('project.get', {projectId: f.projectId});
  assert.equal(afterUndo.shots.some((shot: any) => shot.id === appendedId), false);
  assert.equal(afterUndo.timeline.clips.length, 2);
});

test('layout moves and connect/disconnect use the registered unified operations', async (t: test.TestContext) => {
  const f = await boardFixture(t);
  const call = callOf(f.services);
  const moved = await previewCommit(call, f.projectId, [{kind: 'board.layout.move',
    moves: [{nodeId: BOARD_IDS.shotA, x: 55, y: 77}]}]);
  assert.equal(moved.committed.operation, 'board.layout.move');
  const afterMove = await call('project.get', {projectId: f.projectId});
  assert.deepEqual(afterMove.shots.find((shot: any) => shot.id === BOARD_IDS.shotA).position, {x: 55, y: 77});
  assert.equal(afterMove.timeline.revision, 1);

  await previewCommit(call, f.projectId, [{kind: 'board', edit: {kind: 'disconnect', fromId: BOARD_IDS.shotA, toId: BOARD_IDS.shotB}}]);
  const connected = await previewCommit(call, f.projectId, [{kind: 'board', edit: {kind: 'connect',
    fromId: BOARD_IDS.shotA, toId: BOARD_IDS.shotB}}]);
  assert.equal(connected.committed.operation, 'board.connect');
  const mid = await call('sequence.board.get', {projectId: f.projectId});
  assert.equal(mid.inSync, true);
  const view = await call('sequence.history.get', {projectId: f.projectId});
  await call('sequence.undo', {projectId: f.projectId, requestId: `undo-${randomUUID()}`,
    actionId: view.undo.actionId, expected: {position: view.position, revision: view.revision}});
  assert.equal((await call('sequence.board.get', {projectId: f.projectId})).inSync, true);
});

test('the unified RPC registry exposes the board read operation and its effects', () => {
  assert.equal(Object.hasOwn(schemas, 'sequence.board.get'), true);
  assert.equal(Object.hasOwn(sequenceEditRpcSchemas, 'sequence.board.get'), true);
  assert.equal(operationEffect('sequence.board.get').readOnly, true);
  assert.equal(Object.hasOwn(operationEffects, 'sequence.board.get'), true);
});

test('track add/update ride sequence.preview/commit with one-step undo and main-track identity', async (t: test.TestContext) => {
  const f = await boardFixture(t);
  const call = callOf(f.services);
  const project = await call('project.get', {projectId: f.projectId});
  const mainTrack = project.timeline.tracks.find((track: any) => track.id === project.timeline.mainTrack.trackId);
  assert.ok(mainTrack);
  const trackId = randomUUID();
  const addPreview = await call('sequence.preview', {projectId: f.projectId, requestId: `track-add-${randomUUID()}`,
    trackIntent: {side: 'timeline', operation: {kind: 'track-structure',
      edit: {kind: 'add', trackId, trackKind: 'video', name: '叠加'}}}});
  assert.equal(addPreview.ok, undefined, JSON.stringify(addPreview));
  const addCommit = await call('sequence.commit', {projectId: f.projectId, envelope: addPreview.envelope,
    expectedPlanDigest: addPreview.planDigest});
  assert.equal(addCommit.operation, 'timeline.track.add');
  const added = await call('project.get', {projectId: f.projectId});
  assert.equal(added.timeline.tracks.some((track: any) => track.id === trackId), true);
  assert.equal(added.timeline.mainTrack.trackId, project.timeline.mainTrack.trackId);

  const updatePreview = await call('sequence.preview', {projectId: f.projectId, requestId: `track-update-${randomUUID()}`,
    trackIntent: {side: 'timeline', operation: {kind: 'track-structure',
      edit: {kind: 'update', trackId: mainTrack.id, patch: {muted: true, name: '主画面'}}}}});
  const updateCommit = await call('sequence.commit', {projectId: f.projectId, envelope: updatePreview.envelope,
    expectedPlanDigest: updatePreview.planDigest});
  assert.equal(updateCommit.operation, 'timeline.track.update');
  const updated = await call('project.get', {projectId: f.projectId});
  assert.equal(updated.timeline.tracks.find((track: any) => track.id === mainTrack.id).name, '主画面');
  assert.equal(updated.timeline.tracks.find((track: any) => track.id === mainTrack.id).muted, true);
  assert.equal(updated.timeline.mainTrack.trackId, mainTrack.id);

  const history = await call('sequence.history.get', {projectId: f.projectId});
  await call('sequence.undo', {projectId: f.projectId, requestId: `undo-${randomUUID()}`,
    actionId: history.undo.actionId, expected: {position: history.position, revision: history.revision}});
  const undone = await call('project.get', {projectId: f.projectId});
  assert.equal(undone.timeline.tracks.find((track: any) => track.id === mainTrack.id).muted, mainTrack.muted);

  await assert.rejects(() => call('sequence.commit', {projectId: f.projectId, envelope: updatePreview.envelope,
    expectedPlanDigest: '0'.repeat(64)}), {code: 'SEQUENCE_EDIT_PATCH_INVALID'});
 });

async function previewCommitRequest(call: Call, projectId: string, request: Record<string, unknown>) {
  const preview = await call('sequence.preview', {projectId, requestId: `preview-${randomUUID()}`, ...request});
  assert.equal(preview.ok, undefined, JSON.stringify(preview));
  const committed = await call('sequence.commit', {projectId, envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest});
  assert.equal(committed.status, 'applied', JSON.stringify(committed));
  return {preview, committed};
}

test('the read-only generation-input projection lists connected lines before any service is chosen', async (t: test.TestContext) => {
  const f = await boardFixture(t);
  const call = callOf(f.services);
  assert.equal(Object.hasOwn(schemas, 'sequence.generation-inputs.get'), true);
  assert.equal(operationEffect('sequence.generation-inputs.get').readOnly, true);
  assert.equal(Object.hasOwn(operationEffects, 'sequence.generation-inputs.get'), true);
  const view = await call('sequence.generation-inputs.get', {projectId: f.projectId, shotId: BOARD_IDS.shotA});
  assert.equal(view.service, null);
  assert.equal(view.mode, 'frames');
  assert.equal(view.usedCount, 0);
  assert.equal(view.unsupportedCount, 1);
  assert.equal(view.entries[0].edgeId, BOARD_IDS.referenceEdge);
  assert.equal(view.entries[0].role, 'first_frame');
  assert.equal(view.entries[0].label, '参考图 · 街景');
  assert.equal(view.entries[0].status, 'unsupported');
  assert.equal(view.entries[0].reason, 'SERVICE_NOT_SELECTED');
  assert.equal(view.entries[0].primary, undefined);
  assert.equal(view.dialogue.status, 'unsupported');
  assert.equal(view.dialogue.reason, 'SERVICE_NOT_SELECTED', 'no service selected keeps the no-service dialogue reason');
  // A service triple requires the real configured connection.
  await assert.rejects(call('sequence.generation-inputs.get', {projectId: f.projectId, shotId: BOARD_IDS.shotA,
    connectionId: randomUUID(), configurationRevision: 1, modelEntryId: randomUUID()}),
  error => String((error as {code?: unknown}).code).startsWith('VIDEO_SETTINGS_'));
  // Mock has no configured connection but is a selected service: the projection
  // reports Mock's reviewed capabilities instead of "no service selected".
  const mock = await call('sequence.generation-inputs.get', {projectId: f.projectId, shotId: BOARD_IDS.shotA,
    connectionId: FORMAT5_MOCK_INPUT_CONNECTION_ID,
    configurationRevision: FORMAT5_MOCK_INPUT_CONFIGURATION_REVISION,
    modelEntryId: FORMAT5_MOCK_INPUT_MODEL_ENTRY_ID});
  assert.equal(mock.service.providerId, 'mock');
  assert.equal(mock.service.modelId, 'mock-motion-v1');
  assert.equal(mock.mode, 'frames');
  assert.equal(mock.entries[0].status, 'used');
  assert.equal(mock.entries[0].reason, undefined);
  assert.ok(mock.usedCount >= 1);
  // WT-3-05: Mock is a selected service that cannot speak. The dialogue status
  // must say so instead of falling back to "no service selected".
  assert.equal(mock.dialogue.status, 'unsupported');
  assert.equal(mock.dialogue.reason, 'SERVICE_DOES_NOT_SPEAK');
});

test('reference connect, role change, reorder, detach and one undo step ride the unified sequence RPC', async (t: test.TestContext) => {
  const f = await boardFixture(t);
  const call = callOf(f.services);
  const assetId = randomUUID(), nodeId = randomUUID();
  f.store.tx(() => {
    f.store.put('assets', {id: assetId, projectId: f.projectId, name: '参考图 B.png', mimeType: 'image/png',
      duration: null, sha256: 'e'.repeat(64), sizeBytes: 10, createdAt: '2026-01-01T00:00:00.000Z'});
    f.store.put('nodes', {id: nodeId, projectId: f.projectId, type: 'image', assetId, label: '参考图 B',
      position: {x: 120, y: 330}, createdAt: '2026-01-01T00:00:00.000Z'});
  });
  const attached = await previewCommitRequest(call, f.projectId, {referenceIntent: {side: 'board',
    operation: {kind: 'reference-edge', edit: {kind: 'attach', edgeId: randomUUID(), shotId: BOARD_IDS.shotA,
      sourceNodeId: nodeId, role: 'reference_image'}}}});
  assert.equal(attached.committed.operation, 'reference.attach');
  const afterAttach = await call('project.get', {projectId: f.projectId});
  const referenceEdges = afterAttach.edges.filter((edge: any) => edge.kind === 'reference');
  assert.equal(referenceEdges.length, 4);
  const materialEdges = referenceEdges.filter((edge: any) => edge.sourceAssetId !== undefined);
  assert.equal(materialEdges.length, 4);
  assert.equal((await call('sequence.generation-inputs.get', {projectId: f.projectId, shotId: BOARD_IDS.shotA}))
    .entries.length, 2);

  const newEdge = materialEdges.find((edge: any) => edge.source === nodeId) ?? referenceEdges.find((edge: any) => edge.source === nodeId);
  assert.ok(newEdge);
  const role = await previewCommitRequest(call, f.projectId, {referenceIntent: {side: 'board',
    operation: {kind: 'reference-edge', edit: {kind: 'set-role', edgeId: newEdge.id,
      shotId: BOARD_IDS.shotA, role: 'composition'}}}});
  assert.equal(role.committed.operation, 'reference.role.set');
  const reorder = await previewCommitRequest(call, f.projectId, {referenceIntent: {side: 'board',
    operation: {kind: 'reference-edge', edit: {kind: 'reorder', shotId: BOARD_IDS.shotA,
      edgeIds: [newEdge.id, BOARD_IDS.referenceEdge]}}}});
  assert.equal(reorder.committed.operation, 'reference.reorder');
  const ordered = await call('sequence.generation-inputs.get', {projectId: f.projectId, shotId: BOARD_IDS.shotA});
  assert.deepEqual(ordered.entries.map((entry: any) => entry.edgeId), [newEdge.id, BOARD_IDS.referenceEdge]);
  const detach = await previewCommitRequest(call, f.projectId, {referenceIntent: {side: 'board',
    operation: {kind: 'reference-edge', edit: {kind: 'detach', edgeId: newEdge.id, shotId: BOARD_IDS.shotA}}}});
  assert.equal(detach.committed.operation, 'reference.detach');
  assert.equal((await call('project.get', {projectId: f.projectId})).edges.length, 5);
  const view = await call('sequence.history.get', {projectId: f.projectId});
  await call('sequence.undo', {projectId: f.projectId, requestId: `undo-${randomUUID()}`,
    actionId: view.undo.actionId, expected: {position: view.position, revision: view.revision}});
  assert.equal((await call('project.get', {projectId: f.projectId})).edges.length, 6);
});

function subjectIntent(operation: Record<string, unknown>) { return {side: 'board', operation}; }
async function subjectPreviewCall(call: Call, projectId: string, operation: Record<string, unknown>,
  allocation?: unknown) {
  const preview = await call('sequence.preview', {projectId, requestId: `subject-preview-${randomUUID()}`,
    subjectIntent: subjectIntent(operation), ...(allocation ? {allocation} : {})});
  assert.equal(preview.ok, undefined, JSON.stringify(preview));
  const committed = await call('sequence.commit', {projectId, envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest});
  assert.equal(committed.status, 'applied');
  return {preview, committed};
}

test('subject cards, bindings, delete commands and the board read projection share the unified RPC', async (t: test.TestContext) => {
  const f = await boardFixture(t);
  const call = callOf(f.services);
  const cardId = randomUUID();
  const created = await subjectPreviewCall(call, f.projectId, {kind: 'subject.card.create', nodeId: cardId,
    subjectId: BOARD_IDS.subjectCharacter, position: {x: 240, y: 160}});
  assert.equal(created.committed.operation, 'subject.card.create');
  const afterCard = await call('project.get', {projectId: f.projectId});
  assert.equal(afterCard.nodes.some((node: any) => node.id === cardId && node.subjectId === BOARD_IDS.subjectCharacter), true);

  const bindingId = randomUUID(), edgeId = randomUUID();
  const binding = await subjectPreviewCall(call, f.projectId, {kind: 'subject-binding', edit: {kind: 'create',
    bindingId, shotId: BOARD_IDS.shotA, subjectId: BOARD_IDS.subjectCharacter, role: 'subject'}},
  {clips: [], nodes: [], splitClips: [], edges: [{id: edgeId, fromId: cardId, toId: BOARD_IDS.shotA}]});
  assert.equal(binding.committed.operation, 'subject.binding.create');
  const afterBinding = await call('sequence.board.get', {projectId: f.projectId});
  assert.equal(afterBinding.bindings.some((item: any) => item.id === bindingId && item.bindingMode === 'follow'
    && item.edgeId === edgeId), true);
  assert.equal(afterBinding.subjects.some((item: any) => item.id === BOARD_IDS.subjectCharacter), true);
  assert.equal(afterBinding.subjects.find((item: any) => item.id === BOARD_IDS.subjectCharacter).versions.length, 1);

  const locked = await subjectPreviewCall(call, f.projectId, {kind: 'subject-binding', edit: {kind: 'set-mode',
    bindingId, bindingMode: 'locked', subjectVersionId: BOARD_IDS.subjectCharacterVersion}});
  assert.equal(locked.committed.operation, 'subject.binding.set-mode');
  assert.equal((await call('sequence.board.get', {projectId: f.projectId})).bindings
    .find((item: any) => item.id === bindingId).bindingMode, 'locked');

  await subjectPreviewCall(call, f.projectId, {kind: 'subject.card.delete', nodeId: cardId});
  const afterDelete = await call('sequence.board.get', {projectId: f.projectId});
  assert.equal(afterDelete.bindings.find((item: any) => item.id === bindingId).bindingMode, 'detached');
  assert.equal((await call('project.get', {projectId: f.projectId})).nodes.some((node: any) => node.id === cardId), false);
  const undoView = await call('sequence.history.get', {projectId: f.projectId});
  await call('sequence.undo', {projectId: f.projectId, requestId: `undo-${randomUUID()}`,
    actionId: undoView.undo.actionId, expected: {position: undoView.position, revision: undoView.revision}});
  const afterUndo = await call('sequence.board.get', {projectId: f.projectId});
  assert.equal(afterUndo.bindings.find((item: any) => item.id === bindingId).bindingMode, 'locked');
  assert.equal((await call('project.get', {projectId: f.projectId})).nodes.some((node: any) => node.id === cardId), true);
});

test('a look subject binds to a shot with the style role', async (t: test.TestContext) => {
  const f = await boardFixture(t);
  const call = callOf(f.services);
  const cardId = randomUUID(), bindingId = randomUUID(), edgeId = randomUUID();
  await subjectPreviewCall(call, f.projectId, {kind: 'subject.card.create', nodeId: cardId,
    subjectId: BOARD_IDS.subjectLook, position: {x: 420, y: 220}});
  const binding = await subjectPreviewCall(call, f.projectId, {kind: 'subject-binding', edit: {kind: 'create',
    bindingId, shotId: BOARD_IDS.shotA, subjectId: BOARD_IDS.subjectLook, role: 'style'}},
  {clips: [], nodes: [], splitClips: [], edges: [{id: edgeId, fromId: cardId, toId: BOARD_IDS.shotA}]});
  assert.equal(binding.committed.operation, 'subject.binding.create');
  const mount = await call('sequence.board.get', {projectId: f.projectId});
  assert.equal(mount.bindings.find((item: any) => item.id === bindingId).role, 'style');
  const edge = (await call('project.get', {projectId: f.projectId})).edges.find((item: any) => item.id === edgeId);
  assert.equal(edge.role, 'style_reference');
});

test('the generation-input view lists a bound subject with its name and version', async (t: test.TestContext) => {
  const f = await boardFixture(t);
  const call = callOf(f.services);
  const cardId = randomUUID(), bindingId = randomUUID(), edgeId = randomUUID();
  await subjectPreviewCall(call, f.projectId, {kind: 'subject.card.create', nodeId: cardId,
    subjectId: BOARD_IDS.subjectCharacter, position: {x: 240, y: 640}});
  await subjectPreviewCall(call, f.projectId, {kind: 'subject-binding', edit: {kind: 'create',
    bindingId, shotId: BOARD_IDS.shotB, subjectId: BOARD_IDS.subjectCharacter, role: 'subject'}},
  {clips: [], nodes: [], splitClips: [], edges: [{id: edgeId, fromId: cardId, toId: BOARD_IDS.shotB}]});
  const view = await call('sequence.generation-inputs.get', {projectId: f.projectId, shotId: BOARD_IDS.shotB});
  assert.equal(view.service, null);
  assert.equal(view.mode, 'references');
  assert.equal(view.entries.length, 3);
  const subjectEntry = view.entries.find((entry: any) => entry.source === 'subject');
  assert.equal(subjectEntry.bindingId, bindingId);
  assert.equal(subjectEntry.role, 'subject_reference');
  assert.equal(subjectEntry.label, '阿琦');
  assert.equal(subjectEntry.subjectVersionNumber, 1);
  assert.equal(subjectEntry.status, 'unsupported');
  assert.equal(subjectEntry.reason, 'SERVICE_NOT_SELECTED');
  assert.equal(view.primaryEdgeId, null);
});


test('the read-only generation-input projection carries previs scene subjects to the panel and Mio', async (t) => {
  const f = await boardFixture(t);
  const call = callOf(f.services);
  // A saved previs scene with one follow character and one locked look subject.
  const scene = defaultPrevisScene();
  scene.figures[0]!.subject = {subjectId: BOARD_IDS.subjectCharacter};
  scene.props.push({id: 'p1', kind: 'box', name: '', visible: true, position: [1, 0, 0] as [number, number, number],
    rotation: 0, size: [0.5, 0.5, 0.5] as [number, number, number],
    subject: {subjectId: BOARD_IDS.subjectLook, subjectVersionId: BOARD_IDS.subjectLookVersion}});
  scene.keyframes = [{id: 'k1', name: '', camera: scene.camera, exports: []}];
  scene.activeKeyframeId = 'k1';
  const nodeId = randomUUID();
  f.store.tx(() => f.store.put('nodes', {id: nodeId, projectId: f.projectId, type: 'previs', label: '机位预演',
    text: '', position: {x: 0, y: 0}, revision: 2, sceneRevision: 2, scene, createdAt: '2026-01-01T00:00:00.000Z'}));
  const bytes = png({width: 64, height: 96, rgba: false});
  const published = await call('previs.output.publish', {projectId: f.projectId, nodeId, keyframeId: 'k1',
    sceneRevision: 2, requestId: `previs-output-${randomUUID()}`, name: 'Previs.png',
    sha256: createHash('sha256').update(bytes).digest('hex'), width: 64, height: 96,
    dataBase64: bytes.toString('base64')});
  assert.ok(published.asset.id);
  await previewCommitRequest(call, f.projectId, {referenceIntent: {side: 'board',
    operation: {kind: 'reference-edge', edit: {kind: 'attach', edgeId: randomUUID(), shotId: BOARD_IDS.shotB,
      sourceNodeId: nodeId}}}});
  const ark = (f.settings.list() as unknown as {configuration: {id: string; models: {id: string}[]}}[])
    .find(view => view.configuration.id === BOARD_IDS.arkConnection)!;
  const view = await call('sequence.generation-inputs.get', {projectId: f.projectId, shotId: BOARD_IDS.shotB,
    connectionId: BOARD_IDS.arkConnection, configurationRevision: 1, modelEntryId: ark.configuration.models[0]!.id});
  assert.equal(view.mode, 'references');
  assert.equal(view.service.providerId, 'ark');
  assert.equal(view.unsupportedCount, 0);
  // shotB already had one reference image and one audio line; the previs output
  // line and its two scene subjects join the same used set.
  assert.equal(view.usedCount, 5);
  const previsEntries = view.entries.filter((entry: any) => entry.source === 'previs');
  assert.equal(previsEntries.length, 2);
  // The projection identifies a previs subject by its node, label, role and
  // version (live names stay server-resolved; the browser never looks them up).
  assert.deepEqual(previsEntries.map((entry: any) => entry.label), ['机位预演 · 阿琦', '机位预演 · 霓虹']);
  assert.deepEqual(previsEntries.map((entry: any) => entry.role), ['subject_reference', 'style_reference']);
  assert.deepEqual(previsEntries.map((entry: any) => entry.sourceNodeId), [nodeId, nodeId]);
  const [character, look] = previsEntries;
  assert.equal(character.sourceNodeId, nodeId);
  assert.equal(character.sourceKind, 'subject');
  assert.equal(character.role, 'subject_reference');
  assert.equal(character.label, '机位预演 · 阿琦');
  assert.equal(character.subjectVersionNumber, 1);
  assert.equal(character.status, 'used');
  assert.equal(character.appliedRole, 'reference_image');
  assert.equal(character.orderIndex, 3);
  assert.equal(look.role, 'style_reference');
  assert.equal(look.label, '机位预演 · 霓虹');
  assert.equal(look.status, 'used');
  // The previs row cannot become the primary image: only a material edge owns it.
  assert.ok(view.primaryEdgeId);
  assert.ok(previsEntries.every((entry: any) => entry.primary === undefined && entry.edgeId === undefined));
  // The UI and Mio read this exact projection: the same order and labels, no
  // second filtering path in either consumer.
  const again = await call('sequence.generation-inputs.get', {projectId: f.projectId, shotId: BOARD_IDS.shotB});
  assert.deepEqual(again.entries.map((entry: any) => [entry.source, entry.orderIndex, entry.label]),
    view.entries.map((entry: any) => [entry.source, entry.orderIndex, entry.label]));
});
