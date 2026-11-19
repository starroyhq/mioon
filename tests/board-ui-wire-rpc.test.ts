import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBoardUiWireFixture, BOARD_IDS} from './helpers/board-ui-wire-fixture.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {sequenceEditRpcSchemas, sequenceBoardGetResponseSchema} from '../packages/contracts/src/sequence-edit-rpc.ts';
import {operationEffects, operationEffect} from '../packages/contracts/src/operation-effects.ts';

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

test('removing a subject from the board keeps the subject library rows and uses one undo step', async (t: test.TestContext) => {
  const f = await boardFixture(t);
  const call = callOf(f.services);
  const cardId = randomUUID();
  await subjectPreviewCall(call, f.projectId, {kind: 'subject.card.create', nodeId: cardId,
    subjectId: BOARD_IDS.subjectLook, position: {x: 300, y: 200}});
  await subjectPreviewCall(call, f.projectId, {kind: 'subject.delete', subjectId: BOARD_IDS.subjectLook});
  const after = await call('sequence.board.get', {projectId: f.projectId});
  assert.equal(after.subjects.some((item: any) => item.id === BOARD_IDS.subjectLook), true,
    'the subject library row is retained');
  assert.equal((await call('project.get', {projectId: f.projectId})).nodes.some((node: any) => node.id === cardId), false);
  assert.equal(after.bindings.filter((item: any) => item.subjectId === BOARD_IDS.subjectLook && item.bindingMode !== 'detached').length, 0);
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
