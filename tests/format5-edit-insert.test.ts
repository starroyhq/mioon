import assert from 'node:assert/strict';
import test from 'node:test';
import {sequenceSyncIntent} from '../packages/contracts/src/sequence-sync.ts';
import type {SequenceSyncCommand} from '../packages/contracts/src/sequence-sync.ts';
import {createEditUiWireFixture} from './helpers/edit-ui-wire-fixture.ts';

type Row = Record<string, any>;

test('format-5 insert asset and paste clip through one confirmable action each', async t => {
  const f = await createEditUiWireFixture();
  t.after(() => {f.store.close(); f.library.close();});
  const call = async <T = Row>(operation: string, input: Row): Promise<T> => {
    try {return await f.services.call(operation, input) as T;}
    catch (error) {throw new Error(`${operation} failed: ${(error as {code?: string}).code ?? ''}`, {cause: error});}
  };
  const project = async (): Promise<Row> => await call('project.get', {projectId: f.projectId});
  const baseline = await project();
  const clips = () => baselineClips();
  let latest = baseline;
  async function refresh(): Promise<Row> {latest = await project(); return latest;}
  const baselineClips = (): Row[] => latest.timeline.clips;
  const execute = async (command: SequenceSyncCommand): Promise<Row> => {
    const requestId = `ui-${crypto.randomUUID()}`, actionId = crypto.randomUUID();
    const preview = await call<Row>('sequence.preview', {projectId: f.projectId, requestId, actionId,
      intents: [sequenceSyncIntent(command)]});
    assert.ok(preview.envelope, JSON.stringify(preview));
    assert.ok(preview.planDigest, 'preview returns a digest');
    const committed = await call<Row>('sequence.commit', {projectId: f.projectId,
      envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
    assert.equal(committed.status, 'applied');
    await refresh();
    return preview.envelope;
  };
  const history = async (): Promise<Row> => await call('sequence.history.get', {projectId: f.projectId});
  const undo = async (): Promise<void> => {
    const view = await history();
    assert.ok(view.undo, 'undo entry exists');
    await call('sequence.undo', {projectId: f.projectId, requestId: `undo-${crypto.randomUUID()}`,
      actionId: view.undo.actionId, expected: {position: view.position, revision: view.revision}});
    await refresh();
  };
  const redo = async (): Promise<void> => {
    const view = await history();
    assert.ok(view.redo, 'redo entry exists');
    await call('sequence.redo', {projectId: f.projectId, requestId: `redo-${crypto.randomUUID()}`,
      actionId: view.redo.actionId, expected: {position: view.position, revision: view.revision}});
    await refresh();
  };
  const newClip = (before: Row): Row => {
    const prior = new Set(before.timeline.clips.map((clip: Row) => clip.id));
    const added = latest.timeline.clips.filter((clip: Row) => !prior.has(clip.id));
    assert.equal(added.length, 1, 'one clip is inserted');
    return added[0]!;
  };
  const mainTrackId = baseline.timeline.mainTrack.trackId;
  const imageAsset = '90000000-0000-4000-8000-000000000012';
  const videoAsset = '90000000-0000-4000-8000-000000000011';
  const audioAsset = '90000000-0000-4000-8000-000000000013';
  const v2Track = '90000000-0000-4000-8000-000000000061';
  const audioTrack = '90000000-0000-4000-8000-000000000062';

  // Start, then move to the middle boundary of a split group, then append.
  let before = await project();
  await execute({kind: 'insert-asset', assetId: imageAsset, trackId: null, startFrame: 0});
  assert.equal(newClip(before).startFrame, 0);
  assert.equal(latest.nodes.length, before.nodes.length + 1, 'main insert creates a media node');
  assert.ok(latest.timeline.clips.some((clip: Row) => clip.sequenceSource?.nodeId === newClip(before).sequenceSource.nodeId));
  await undo();
  assert.equal(latest.timeline.clips.length, before.timeline.clips.length);
  await redo();
  assert.equal(latest.timeline.clips.length, before.timeline.clips.length + 1);
  await undo();

  before = await project();
  await execute({kind: 'insert-asset', assetId: videoAsset, trackId: null, startFrame: 45});
  const middle = newClip(before);
  assert.equal(middle.startFrame, 60, 'a drop inside a split group follows the whole group');
  await undo();

  before = await project();
  await execute({kind: 'insert-asset', assetId: imageAsset, trackId: null, startFrame: 150});
  assert.equal(newClip(before).startFrame, 150, 'a drop at the end appends');
  await undo();

  // Other tracks are anchored clips only; no board node is created.
  before = await project();
  await execute({kind: 'insert-asset', assetId: videoAsset, trackId: v2Track, startFrame: 10});
  const overlay = newClip(before);
  assert.equal(overlay.trackId, v2Track);
  assert.equal(overlay.anchor.clipId, '90000000-0000-4000-8000-000000000030');
  assert.equal(latest.nodes.length, before.nodes.length, 'overlay does not create a board node');
  await undo();

  before = await project();
  await execute({kind: 'insert-asset', assetId: audioAsset, trackId: audioTrack, startFrame: 5});
  assert.equal(newClip(before).trackId, audioTrack);
  assert.equal(newClip(before).assetId, audioAsset);
  await undo();

  // Copying a main clip creates a new shot and a new node, then undo/redo.
  before = await project();
  await execute({kind: 'paste-clip', clipId: '90000000-0000-4000-8000-000000000030', startFrame: 60});
  const pasted = newClip(before);
  assert.notEqual(pasted.sequenceSource.nodeId, '90000000-0000-4000-8000-000000000003');
  assert.equal(latest.shots.length, before.shots.length + 1);
  await undo();
  assert.equal(latest.shots.length, before.shots.length);
  await redo();
  assert.equal(latest.shots.length, before.shots.length + 1);
  await undo();

  // Copying an overlay clip re-anchors the new clip under the same main owner.
  before = await project();
  await execute({kind: 'insert-asset', assetId: videoAsset, trackId: v2Track, startFrame: 10});
  const sourceOverlay = latest.timeline.clips.find((clip: Row) => clip.trackId === v2Track)!;
  await undo();
  await redo();
  await execute({kind: 'paste-clip', clipId: sourceOverlay.id, startFrame: 120});
  const overlays = latest.timeline.clips.filter((clip: Row) => clip.trackId === v2Track);
  assert.equal(overlays.length, 2);
  assert.equal(overlays.find((clip: Row) => clip.id === sourceOverlay.id)!.anchor.clipId, '90000000-0000-4000-8000-000000000030');
  assert.ok(overlays.every((clip: Row) => Boolean(clip.anchor?.clipId)));
  await undo();
  await undo();
});
