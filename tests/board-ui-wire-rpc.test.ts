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
