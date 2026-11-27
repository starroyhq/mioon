import assert from 'node:assert/strict';
import test from 'node:test';
import {sequenceSyncIntent} from '../packages/contracts/src/sequence-sync.ts';
import type {SequenceSyncCommand} from '../packages/contracts/src/sequence-sync.ts';
import type {Format5Clip, Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import {sequencePreviewFailureResponseSchema, sequencePreviewResponseSchema} from '../packages/contracts/src/sequence-edit-rpc.ts';
import {sequenceEditReceiptSchema} from '../packages/contracts/src/sequence-edit.ts';
import {sequenceHistoryViewResponseSchema} from '../packages/contracts/src/sequence-editing.ts';
import {format5CopiedDialogueLineId, format5DialogueCueId} from '../packages/business/src/format5-dialogue-projection.ts';
import {adoptFormat5GeneratedVersionInside} from '../packages/business/src/format5-sequence-sync.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {createEditUiWireFixture, WIRE_IDS} from './helpers/edit-ui-wire-fixture.ts';

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

test('overlay clips inherit the landscape timeline frame', async t => {
  const f = await createEditUiWireFixture({width: 1920, height: 1080});
  t.after(() => {f.store.close(); f.library.close();});
  const call = async (operation: string, input: Row): Promise<Row> => await f.services.call(operation, input) as Row;
  const requestId = `ui-${crypto.randomUUID()}`, actionId = crypto.randomUUID();
  const preview = await call('sequence.preview', {projectId: f.projectId, requestId, actionId,
    intents: [sequenceSyncIntent({kind: 'insert-asset', assetId: '90000000-0000-4000-8000-000000000011',
      trackId: '90000000-0000-4000-8000-000000000061', startFrame: 10})]});
  await call('sequence.commit', {projectId: f.projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
  const project = await call('project.get', {projectId: f.projectId});
  const overlay = project.timeline.clips.find((clip: Row) => clip.trackId === '90000000-0000-4000-8000-000000000061');
  assert.deepEqual(overlay.rect, {x: 0, y: 0, width: 1920, height: 1080});
});

test('pasting a shot copies its dialogue with fresh line ids and projects both sides', async t => {
  const f = await createEditUiWireFixture();
  t.after(() => {f.store.close(); f.library.close();});
  const call = async (operation: string, input: Row): Promise<Row> => await f.services.call(operation, input) as Row;
  const requestId = `ui-${crypto.randomUUID()}`, actionId = crypto.randomUUID();
  const preview = await call('sequence.preview', {projectId: f.projectId, requestId, actionId,
    intents: [sequenceSyncIntent({kind: 'paste-clip', clipId: '90000000-0000-4000-8000-000000000030', startFrame: 60})]});
  assert.ok(preview.envelope, JSON.stringify(preview));
  const commit = await call('sequence.commit', {projectId: f.projectId, envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest});
  assert.equal(commit.status, 'applied');
  const project = await call('project.get', {projectId: f.projectId});
  const sourceShot = project.shots.find((shot: Row) => shot.id === '90000000-0000-4000-8000-000000000003');
  const pastedClip = project.timeline.clips.find((clip: Row) => ![
    '90000000-0000-4000-8000-000000000030', '90000000-0000-4000-8000-000000000031',
    '90000000-0000-4000-8000-000000000032', '90000000-0000-4000-8000-000000000033'].includes(clip.id)
    && clip.trackId === '90000000-0000-4000-8000-000000000060');
  assert.ok(pastedClip, 'pasted main clip exists');
  const pastedShotId = pastedClip.sequenceSource.nodeId;
  const copiedShot = project.shots.find((shot: Row) => shot.id === pastedShotId);
  assert.ok(copiedShot, 'pasted shot exists');
  assert.equal(sourceShot.dialogue[0].id, '90000000-0000-4000-8000-000000000091');
  const expectedLineId = format5CopiedDialogueLineId(pastedShotId, 0);
  assert.notEqual(expectedLineId, sourceShot.dialogue[0].id);
  assert.deepEqual(copiedShot.dialogue, [{id: expectedLineId, text: sourceShot.dialogue[0].text}]);
  const cues = project.timeline.subtitles?.cues ?? [];
  const sourceCue = cues.find((cue: Row) => cue.dialogueRef?.shotId === '90000000-0000-4000-8000-000000000003');
  const copiedCue = cues.find((cue: Row) => cue.dialogueRef?.shotId === pastedShotId);
  assert.ok(sourceCue && copiedCue, JSON.stringify(cues));
  assert.equal(sourceCue.dialogueRef.lineId, sourceShot.dialogue[0].id);
  assert.equal(copiedCue.dialogueRef.lineId, expectedLineId);
  assert.notEqual(sourceCue.id, copiedCue.id);
  const view = await call('sequence.history.get', {projectId: f.projectId});
  await call('sequence.undo', {projectId: f.projectId, requestId: `undo-${crypto.randomUUID()}`,
    actionId: view.undo.actionId, expected: {position: view.position, revision: view.revision}});
  const undone = await call('project.get', {projectId: f.projectId});
  assert.equal(undone.shots.some((shot: Row) => shot.id === pastedShotId), false);
  assert.equal((undone.timeline.subtitles?.cues ?? []).length, 0, 'one undo removes the copied dialogue and cues');
  const restoredSource = undone.shots.find((shot: Row) => shot.id === '90000000-0000-4000-8000-000000000003');
  assert.equal(restoredSource.dialogue[0].id, '90000000-0000-4000-8000-000000000091');
});

test('copying a main-track media clip allocates a new media node and node identity', async t => {
  const f = await createEditUiWireFixture();
  t.after(() => {f.store.close(); f.library.close();});
  const call = async (operation: string, input: Row): Promise<Row> => await f.services.call(operation, input) as Row;
  const execute = async (command: SequenceSyncCommand): Promise<Row> => {
    const requestId = `ui-${crypto.randomUUID()}`, actionId = crypto.randomUUID();
    const preview = await call('sequence.preview', {projectId: f.projectId, requestId, actionId,
      intents: [sequenceSyncIntent(command)]});
    assert.ok(preview.envelope, JSON.stringify(preview));
    await call('sequence.commit', {projectId: f.projectId, envelope: preview.envelope,
      expectedPlanDigest: preview.planDigest});
    return await call('project.get', {projectId: f.projectId});
  };
  const before = await call('project.get', {projectId: f.projectId});
  await execute({kind: 'insert-asset', assetId: '90000000-0000-4000-8000-000000000011', trackId: null, startFrame: 150});
  const inserted = await call('project.get', {projectId: f.projectId});
  const media = inserted.timeline.clips.find((clip: Row) => clip.startFrame === 150 && clip.trackId === '90000000-0000-4000-8000-000000000060');
  assert.ok(media && media.sequenceSource.kind === 'media');
  const copied = await execute({kind: 'paste-clip', clipId: media.id, startFrame: 30});
  assert.equal(copied.timeline.clips.length, before.timeline.clips.length + 2);
  const pasted = copied.timeline.clips.find((clip: Row) => !inserted.timeline.clips.some((old: Row) => old.id === clip.id));
  assert.ok(pasted, 'pasted media clip exists');
  assert.equal(pasted.assetId, media.assetId);
  assert.notEqual(pasted.sequenceSource.nodeId, media.sequenceSource.nodeId);
  const view = await call('sequence.history.get', {projectId: f.projectId});
  await call('sequence.undo', {projectId: f.projectId, requestId: `undo-${crypto.randomUUID()}`,
    actionId: view.undo.actionId, expected: {position: view.position, revision: view.revision}});
});

function copyAsNewShotRequest(projectId: string, clipId: string,
  newClipId: string = crypto.randomUUID(), copyNodeId: string = crypto.randomUUID()) {
  return {projectId, requestId: `copy-shot-${crypto.randomUUID()}`,
    intents: [sequenceSyncIntent({kind: 'clip-copy-as-new-shot', clipId, newClipId, copyNodeId})]};
}

async function previewCopyAsNewShot(services: Awaited<ReturnType<typeof createEditUiWireFixture>>['services'],
  request: ReturnType<typeof copyAsNewShotRequest>) {
  const result = await services.call('sequence.preview', request);
  const preview = sequencePreviewResponseSchema.safeParse(result);
  assert.ok(preview.success, JSON.stringify(result));
  return preview.data;
}

test('copy as new shot previews a split piece, preserves the full clip and undoes in one action', async t => {
  const {store, services, library, projectId} = await createEditUiWireFixture();
  t.after(() => {store.close(); library.close();});
  const {clipA, clipA2, clipB, shotA, shotB, imageClip, video2, assetB, versionA} = WIRE_IDS;
  const timeline = (): Format5Timeline => store.get('timelines', WIRE_IDS.timeline) as Format5Timeline;
  const shot = (id: string) => store.get('shots', id) as Row;
  const initial = timeline();
  const original = initial.clips.find(clip => clip.id === clipA)!;
  const source: Format5Clip = {...original, sourceInFrame: 5, gain: 0.6, muted: true,
    fadeInFrames: 2, fadeOutFrames: 3, rect: {...original.rect, x: 10, y: 20, width: 690, height: 1240},
    transform: {profileId: 'mioon-clip-transform-v1', keyframes: [{frame: 0, x: 10, y: 12, scale: 1.2}],
      rotation: 5, crop: {left: 0.05, top: 0, right: 0.05, bottom: 0}},
    sequenceSource: {...original.sequenceSource!, kind: 'shot', versionMode: 'locked'}};
  const overlay = (owner: string, startFrame: number): Format5Clip => ({id: crypto.randomUUID(),
    trackId: video2, name: '叠加', startFrame, durationFrames: 5, sourceInFrame: 0,
    rect: original.rect, gain: 1, assetId: assetB, sourceState: 'ready', anchor: {clipId: owner, offsetFrames: 8}});
  const sourceOverlay = overlay(clipA, 8), followingOverlay = overlay(clipB, 68);
  const line = shot(shotA).dialogue[0]!;
  const dialogueCue = {id: format5DialogueCueId(initial.id, shotA, line.id), text: line.text,
    startFrame: 2, durationFrames: 4, anchor: {clipId: clipA, offsetFrames: 2},
    dialogueRef: {shotId: shotA, lineId: line.id}};
  const sourceCue = {id: crypto.randomUUID(), text: '原片段字幕', startFrame: 12, durationFrames: 4,
    anchor: {clipId: clipA, offsetFrames: 12}};
  const followingCue = {id: crypto.randomUUID(), text: '后续字幕', startFrame: 75, durationFrames: 4,
    anchor: {clipId: clipB, offsetFrames: 15}};
  store.tx(() => {
    store.put('shots', {...shot(shotA), position: {x: 250, y: 80}});
    store.put('shots', {...shot(shotB), title: '窗口剪影 副本'});
    store.put('timelines', {...initial, clips: [source, ...initial.clips.filter(clip => clip.id !== clipA),
      sourceOverlay, followingOverlay], subtitles: {profileId: 'bottom_cjk_v1', cues: [dialogueCue, sourceCue, followingCue]}});
  });
  const snapshot = () => {
    const {revision: _revision, updatedAt: _updatedAt, ...content} = timeline();
    return {timeline: content, ...Object.fromEntries(['shots', 'nodes', 'edges'].map(table =>
      [table, (store.list(table, projectId) as Row[]).sort((left, right) => left.id.localeCompare(right.id))])),
    adoptions: store.db.prepare('SELECT shotId,versionId FROM project.shot_version_adoptions ORDER BY shotId,versionId').all(),
    baseline: store.db.prepare('SELECT baseline FROM project.sequence_sync_state').get()};
  };
  const counts = () => ({
    cursor: store.db.prepare('SELECT count(*) AS count FROM main.editor_history_state').get()?.count,
    entries: store.db.prepare('SELECT count(*) AS count FROM main.editor_history_entries').get()?.count,
    receipts: store.db.prepare('SELECT count(*) AS count FROM main.editor_requests').get()?.count,
  });
  const revisions = () => ({
    stamp: readProjectContentStamp(store.db),
    timeline: timeline().revision,
    sync: store.db.prepare('SELECT revision FROM project.sequence_sync_state').get()?.revision,
  });
  const before = snapshot();
  const revisionsBefore = revisions();
  assert.deepEqual(counts(), {cursor: 0, entries: 0, receipts: 0});
  const newClipId = crypto.randomUUID(), copyNodeId = crypto.randomUUID();
  const request = copyAsNewShotRequest(projectId, clipA, newClipId, copyNodeId);
  const preview = await previewCopyAsNewShot(services, request);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(revisions(), revisionsBefore);
  assert.deepEqual(counts(), {cursor: 1, entries: 0, receipts: 0});
  const commit = {projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest};
  const receipt = sequenceEditReceiptSchema.parse(await services.call('sequence.commit', commit));
  assert.deepEqual([receipt.status, receipt.operation, receipt.history.position],
    ['applied', 'timeline.clip.copy-as-new-shot', 1]);
  const after = snapshot();
  assert.deepEqual([shot(copyNodeId).title, shot(copyNodeId).position, shot(copyNodeId).selectedVersionId],
    ['窗口剪影 副本', {x: 290, y: 120}, versionA]);
  const copiedLineId = format5CopiedDialogueLineId(copyNodeId, 0);
  assert.notEqual(copiedLineId, line.id);
  assert.deepEqual(shot(copyNodeId).dialogue, [{...line, id: copiedLineId}]);
  assert.deepEqual((store.list('edges', projectId) as Row[]).map(edge => [edge.source, edge.target])
    .sort(([left], [right]) => left.localeCompare(right)),
  [[WIRE_IDS.root, shotA], [shotA, copyNodeId], [copyNodeId, shotB], [shotB, WIRE_IDS.imageNode]]
    .sort(([left], [right]) => left!.localeCompare(right!)));
  const main = timeline().clips.filter(clip => clip.trackId === WIRE_IDS.video);
  assert.deepEqual(main.map(clip => [clip.id, clip.startFrame]),
    [[clipA, 0], [clipA2, 30], [newClipId, 60], [clipB, 90], [imageClip, 120]]);
  const copy = main.find(clip => clip.id === newClipId)!;
  assert.equal(copy.sequenceSource?.kind, 'shot');
  assert.notEqual(copy.sequenceSource?.segmentGroupId, source.sequenceSource?.segmentGroupId);
  // Compare the complete clip, so this assertion can also cover timing when
  // this fixture is exercised with the format-6 data/operation support.
  assert.deepEqual(copy, {...source, id: newClipId, startFrame: 60,
    sequenceSource: {...source.sequenceSource, nodeId: copyNodeId, segmentGroupId: copy.sequenceSource!.segmentGroupId}});
  assert.deepEqual(timeline().clips.filter(clip => clip.trackId === video2),
    [sourceOverlay, {...followingOverlay, startFrame: 98}]);
  const copiedDialogueCue = {id: format5DialogueCueId(initial.id, copyNodeId, copiedLineId), text: line.text,
    startFrame: 60, durationFrames: copy.durationFrames, anchor: {clipId: newClipId, offsetFrames: 0},
    dialogueRef: {shotId: copyNodeId, lineId: copiedLineId}};
  assert.deepEqual(timeline().subtitles?.cues, [dialogueCue, sourceCue, copiedDialogueCue, {...followingCue, startFrame: 105}]);
  assert.deepEqual(await services.call('sequence.commit', commit), receipt);
  assert.deepEqual(counts(), {cursor: 1, entries: 1, receipts: 1});

  const revisionsAfter = revisions();
  for (const [clipId, newId, nodeId, code] of [
    [sourceOverlay.id, crypto.randomUUID(), crypto.randomUUID(), 'INVALID_TRACK_TARGET'],
    [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), 'CLIP_NOT_FOUND'],
    [clipA, sourceOverlay.id, crypto.randomUUID(), 'DUPLICATE_CLIP'],
    [clipA, crypto.randomUUID(), shotB, 'COPY_NODE_EXISTS'],
  ] as const) {
    const failure = await services.call('sequence.preview', copyAsNewShotRequest(projectId, clipId, newId, nodeId)) as Row;
    assert.deepEqual([failure.ok, failure.code], [false, code], JSON.stringify(failure));
    assert.deepEqual(snapshot(), after);
    assert.deepEqual(revisions(), revisionsAfter);
    assert.deepEqual(counts(), {cursor: 1, entries: 1, receipts: 1});
  }

  for (const [direction, expectedPosition, expectedContent] of [['undo', 0, before], ['redo', 1, after]] as const) {
    const view = sequenceHistoryViewResponseSchema.parse(await services.call('sequence.history.get', {projectId}));
    assert.equal(view[direction]?.actionId, receipt.actionId);
    const result = sequenceEditReceiptSchema.parse(await services.call(`sequence.${direction}`, {projectId,
      actionId: receipt.actionId, requestId: `copy-shot-${direction}-${crypto.randomUUID()}`,
      expected: {position: view.position, revision: view.revision}}));
    assert.equal(result.status, 'applied');
    assert.equal(result.history.position, expectedPosition);
    assert.deepEqual(snapshot(), expectedContent);
    assert.equal(counts().entries, 1);
  }
});

test('copy as new shot keeps an image source and isolates generation of a copied placeholder', async t => {
  const {store, services, library, projectId} = await createEditUiWireFixture();
  t.after(() => {store.close(); library.close();});
  const timeline = (): Format5Timeline => store.get('timelines', WIRE_IDS.timeline) as Format5Timeline;
  const sourceShot: Row = {...store.get('shots', WIRE_IDS.shotB) as Row, prompt: '雨后的街口'};
  store.put('shots', sourceShot);
  const copy = async (clipId: string) => {
    const before = timeline().clips.find(clip => clip.id === clipId)!;
    const newClipId = crypto.randomUUID(), copyNodeId = crypto.randomUUID();
    const request = copyAsNewShotRequest(projectId, clipId, newClipId, copyNodeId);
    const {envelope, planDigest} = await previewCopyAsNewShot(services, request);
    const receipt = sequenceEditReceiptSchema.parse(await services.call('sequence.commit', {projectId, envelope,
      expectedPlanDigest: planDigest}));
    assert.equal(receipt.status, 'applied');
    const copied = timeline().clips.find(clip => clip.id === newClipId)!;
    assert.deepEqual([copied.sequenceSource?.nodeId, copied.startFrame, copied.assetId, copied.sourceState],
      [copyNodeId, before.startFrame + before.durationFrames, before.assetId, before.sourceState]);
    return {newClipId, copyNodeId};
  };
  const image = await copy(WIRE_IDS.imageClip);
  assert.equal((store.get('nodes', image.copyNodeId) as Row).label, '图片 副本');
  const placeholder = await copy(WIRE_IDS.clipB);
  const generatedShotId = placeholder.copyNodeId;
  const placeholderShot = store.get('shots', generatedShotId) as Row;
  assert.deepEqual([placeholderShot.title, placeholderShot.prompt, placeholderShot.selectedVersionId],
    ['占位镜头 副本', sourceShot.prompt, null]);
  const original = timeline().clips.find(clip => clip.id === WIRE_IDS.clipB);
  const job = {id: crypto.randomUUID(), projectId, shotId: generatedShotId, snapshot: {}};
  const version = {id: crypto.randomUUID(), projectId, jobId: job.id, shotId: generatedShotId, number: 1,
    assetId: WIRE_IDS.assetB, sha256: 'b'.repeat(64), createdAt: sourceShot.createdAt};
  store.tx(() => {
    store.put('jobs', {...job, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock-motion-v1',
      createdAt: sourceShot.createdAt, updatedAt: sourceShot.createdAt});
    store.put('versions', version);
    assert.equal(adoptFormat5GeneratedVersionInside(store, job, version), true);
    store.put('shots', {...placeholderShot, selectedVersionId: version.id});
  });
  const ready = timeline().clips.find(clip => clip.id === placeholder.newClipId);
  assert.deepEqual([ready?.sourceState, ready?.shotId, ready?.versionId], ['ready', generatedShotId, version.id]);
  assert.deepEqual(timeline().clips.find(clip => clip.id === WIRE_IDS.clipB), original);
  assert.equal((store.get('shots', generatedShotId) as Row).selectedVersionId, version.id);
  assert.deepEqual(store.get('shots', WIRE_IDS.shotB), sourceShot);
});

test('main-track PNG split keeps source zero while the same video split advances its source', async t => {
  const f = await createEditUiWireFixture();
  t.after(async () => {await f.services.drain(); f.store.close(); f.library.close();});
  const {projectId} = f;
  const call = (operation: string, input: Record<string, unknown> = {}) =>
    f.services.call(operation, {projectId, ...input});
  const timeline = (): Format5Timeline => f.store.get('timelines', WIRE_IDS.timeline) as Format5Timeline;
  const history = async () => sequenceHistoryViewResponseSchema.parse(await call('sequence.history.get'));
  const preview = async (command: SequenceSyncCommand) => sequencePreviewResponseSchema.parse(await call('sequence.preview', {
    requestId: crypto.randomUUID(), actionId: crypto.randomUUID(), intents: [sequenceSyncIntent(command)],
  }));

  for (const [assetId, rightSourceInFrame] of [[WIRE_IDS.imageAsset, 0], [WIRE_IDS.assetB, 45]] as const) {
    const insertion = await preview({kind: 'insert-asset', assetId, trackId: null, startFrame: 0});
    const inserted = sequenceEditReceiptSchema.parse(await call('sequence.commit',
      {envelope: insertion.envelope, expectedPlanDigest: insertion.planDigest}));
    assert.equal(inserted.status, 'applied');
    const before = timeline();
    const original = before.clips.find(clip => clip.startFrame === 0 && clip.assetId === assetId);
    assert.ok(original?.sequenceSource);
    assert.equal(original.trackId, before.mainTrack.trackId);
    assert.equal(original.durationFrames, 90);
    const cursor = await history();

    if (assetId === WIRE_IDS.imageAsset) {
      const unavailable = sequencePreviewFailureResponseSchema.parse(await call('sequence.preview', {
        requestId: crypto.randomUUID(), actionId: crypto.randomUUID(),
        intents: [sequenceSyncIntent({kind: 'clip-split', clipId: original.id, offsetFrames: 45,
          rightClipId: crypto.randomUUID(), rightSourceInFrame: 45})],
      }));
      assert.equal(unavailable.code, 'SOURCE_BOUNDS');
    }

    const split = await preview({kind: 'clip-split', clipId: original.id, offsetFrames: 45, rightClipId: crypto.randomUUID()});
    assert.deepEqual(timeline(), before);
    assert.deepEqual(await history(), cursor);
    const input = {envelope: split.envelope, expectedPlanDigest: split.planDigest};
    const receipt = sequenceEditReceiptSchema.parse(await call('sequence.commit', input));
    assert.equal(receipt.status, 'applied');
    const after = timeline();
    const pieces = after.clips.filter(clip => clip.sequenceSource?.nodeId === original.sequenceSource?.nodeId);
    assert.deepEqual(pieces.map(clip => [clip.trackId, clip.assetId, clip.startFrame, clip.durationFrames, clip.sourceInFrame]), [
      [before.mainTrack.trackId, assetId, 0, 45, 0],
      [before.mainTrack.trackId, assetId, 45, 45, rightSourceInFrame],
    ]);
    assert.ok(pieces.every(clip => clip.sequenceSource?.segmentGroupId === original.sequenceSource?.segmentGroupId));
    assert.equal(pieces[0]!.id, original.id);
    assert.notEqual(pieces[1]!.id, original.id);
    assert.equal(after.durationFrames, before.durationFrames);
    assert.equal((await history()).position, cursor.position + 1);

    const travel = async (direction: 'undo' | 'redo') => {
      const current = await history();
      assert.equal(current[direction]?.actionId, receipt.actionId);
      const result = sequenceEditReceiptSchema.parse(await call(`sequence.${direction}`, {
        requestId: crypto.randomUUID(), actionId: receipt.actionId,
        expected: {position: current.position, revision: current.revision},
      }));
      assert.equal(result.status, 'applied');
    };
    await travel('undo');
    assert.deepEqual(timeline().clips, before.clips);
    const undone = await history();
    assert.equal(undone.position, cursor.position);
    assert.deepEqual(await call('sequence.commit', input), receipt);
    assert.deepEqual(await history(), undone);
    assert.deepEqual(timeline().clips, before.clips);
    await travel('redo');
    assert.deepEqual(timeline().clips, after.clips);
    assert.equal((await history()).position, cursor.position + 1);
  }
});
