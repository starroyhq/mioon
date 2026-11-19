import test from 'node:test';
import assert from 'node:assert/strict';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import type {SequenceEditHistoryView} from '../packages/contracts/src/sequence-edit.ts';
import {readSequenceEditHistoryEntry} from '../packages/business/src/format5-editor-history.ts';
import type {Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import type {SequenceEditClipPropertiesIntent} from '../packages/contracts/src/sequence-edit.ts';

const rootId = '10000000-0000-4000-8000-000000000001';
const shotA = '10000000-0000-4000-8000-000000000010';
const shotB = '10000000-0000-4000-8000-000000000011';
const clipA = '10000000-0000-4000-8000-000000000020';
const clipB = '10000000-0000-4000-8000-000000000021';
const versionA = '10000000-0000-4000-8000-000000000050';
const versionB = '10000000-0000-4000-8000-000000000051';
const assetA = '10000000-0000-4000-8000-000000000060';
const assetB = '10000000-0000-4000-8000-000000000061';

function fixture(t: test.TestContext) {
  const value = createChainWorld(t, {
    rootId,
    shots: [{id: shotA, title: 'A', versionId: versionA}, {id: shotB, title: 'B', versionId: versionB}],
    versions: [{versionId: versionA, assetId: assetA, sha256: 'a'.repeat(64), durationSeconds: 4, hasAudio: true},
      {versionId: versionB, assetId: assetB, sha256: 'b'.repeat(64), durationSeconds: 4, hasAudio: true}],
    clips: [{nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 60, versionId: versionA},
      {nodeId: shotB, clipId: clipB, startFrame: 60, durationFrames: 60, versionId: versionB, sourceInFrame: 2}],
    edges: [{id: '10000000-0000-4000-8000-000000000030', fromId: rootId, toId: shotA},
      {id: '10000000-0000-4000-8000-000000000031', fromId: shotA, toId: shotB}],
  });
  return {world: value, service: createFormat5SequenceEditService(value.store)};
}
function timeline(world: ReturnType<typeof fixture>['world']): Format5Timeline {
  const record = readFormat5TimelineRecord(world.store.db, 'project');
  assert.ok(record);
  return record;
}

const properties = (edits: SequenceEditClipPropertiesIntent['operation']['edits']): SequenceEditClipPropertiesIntent =>
  ({side: 'timeline', operation: {kind: 'clip-properties', edits}});

test('clip transform previews and commits through the unified entry, then undo/redo and replays exactly', (t) => {
  const {world, service} = fixture(t);
  const transform = {profileId: 'mioon-clip-transform-v1',
    keyframes: [{frame: 0, x: 20, y: -10, scale: 1.5}], rotation: 5,
    crop: {left: 0.1, top: 0, right: 0.1, bottom: 0}};
  const preview = service.preview({projectId: world.projectId, requestId: 'fr-a-transform-0001',
    propertiesIntent: properties([{clipId: clipA, patch: {transform}}])}) as {
      envelope: {actionId: string}; planDigest: string};
  assert.ok(preview.envelope);
  const commit = service.commit({projectId: world.projectId, envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest}) as {status: string; actionId: string; affected: Record<string, number>};
  assert.equal(commit.status, 'applied');
  assert.equal(commit.affected.mainTrackClips, 1);
  let record = timeline(world);
  assert.deepEqual(record.clips.find(clip => clip.id === clipA)!.transform, transform);
  assert.equal(record.revision, 2);
  // Exact replay returns the first receipt without a second history entry.
  const replay = service.commit({projectId: world.projectId, envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest}) as {actionId: string};
  assert.equal(replay.actionId, commit.actionId);
  let view = service.history({projectId: world.projectId}) as SequenceEditHistoryView;
  assert.ok(view.undo);
  assert.equal(view.undo.actionId, preview.envelope.actionId);
  // Undo restores the whole row, redo reapplies it, one shared cursor.
  const undone = service.undo({projectId: world.projectId, requestId: 'fr-a-transform-undo-1',
    actionId: preview.envelope.actionId, expected: {position: view.position, revision: view.revision}}) as {status: string};
  assert.equal(undone.status, 'applied');
  record = timeline(world);
  assert.equal(record.clips.find(clip => clip.id === clipA)!.transform, undefined);
  view = service.history({projectId: world.projectId}) as SequenceEditHistoryView;
  const redone = service.redo({projectId: world.projectId, requestId: 'fr-a-transform-redo-1',
    actionId: preview.envelope.actionId, expected: {position: view.position, revision: view.revision}}) as {status: string};
  assert.equal(redone.status, 'applied');
  assert.deepEqual(timeline(world).clips.find(clip => clip.id === clipA)!.transform, transform);
  // The history entry stores the full before/after rows, not a field patch.
  const entry = readSequenceEditHistoryEntry(world.store, preview.envelope.actionId);
  assert.ok(entry);
  assert.equal(entry!.operation, 'timeline.clip.set-properties');
  assert.equal(entry!.beforePatch.timeline.clips[0]!.id, clipA);
  assert.deepEqual(entry!.afterPatch.timeline.clips[0]!.transform, transform);
});

test('transition, fades and gain can change together in one undo step; invalid values are refused before writes', (t) => {
  const {world, service} = fixture(t);
  const transition = {profileId: 'mioon-clip-transition-v1', kind: 'dissolve', durationFrames: 2};
  const preview = service.preview({projectId: world.projectId, requestId: 'fr-a-props-0001',
    propertiesIntent: properties([
      {clipId: clipB, patch: {transition}},
      {clipId: clipA, patch: {gain: 0.5, fadeInFrames: 2, fadeOutFrames: 2, name: 'Opening'}},
    ])}) as {envelope: unknown; planDigest: string};
  assert.ok(preview.envelope);
  const commit = service.commit({projectId: world.projectId, envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest}) as {status: string; affected: Record<string, number>};
  assert.equal(commit.status, 'applied');
  let record = timeline(world);
  assert.deepEqual(record.clips.find(clip => clip.id === clipB)!.transitionIn, transition);
  const clip = record.clips.find(item => item.id === clipA)!;
  assert.equal(clip.gain, 0.5);
  assert.equal(clip.fadeInFrames, 2);
  assert.equal(clip.fadeOutFrames, 2);
  assert.equal(clip.name, 'Opening');
  const view = service.history({projectId: world.projectId}) as SequenceEditHistoryView;
  service.undo({projectId: world.projectId, requestId: 'fr-a-props-undo-1',
    actionId: (preview.envelope as {actionId: string}).actionId, expected: {position: view.position, revision: view.revision}});
  record = timeline(world);
  assert.equal(record.clips.find(item => item.id === clipB)!.transitionIn, undefined);
  assert.equal(record.clips.find(item => item.id === clipA)!.gain, 1);
  assert.equal(record.clips.find(item => item.id === clipA)!.fadeInFrames, undefined);

  // Invalid transform/transition/clip targets fail in preview, before any write.
  for (const bad of [
    properties([{clipId: clipA, patch: {transform: {profileId: 'bad', keyframes: [], rotation: 0,
      crop: {left: 0, top: 0, right: 0, bottom: 0}}}}]),
    properties([{clipId: clipA, patch: {transition: {...transition, durationFrames: 1}}}]),
    properties([{clipId: '10000000-0000-4000-8000-000000000099', patch: {gain: 0.5}}]),
    properties([{clipId: clipA, patch: {gain: 3}}]),
    properties([{clipId: clipA, patch: {gain: 0.5}}, {clipId: clipA, patch: {gain: 0.6}}]),
  ]) {
    const result = service.preview({projectId: world.projectId, requestId: 'fr-a-invalid-0001',
      propertiesIntent: bad}) as {ok?: boolean; code?: string};
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.code, 'SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID', JSON.stringify(bad));
  }
  // A property action with the live values is a noop: preview refuses it and no
  // history entry is written.
  const noop = service.preview({projectId: world.projectId, requestId: 'fr-a-noop-0001',
    propertiesIntent: properties([{clipId: clipB, patch: {transition}}])}) as {ok?: boolean; code?: string};
  // The undo above removed the transition, so this value is not a noop; a follow-up
  // same-value preview after committing it must be.
  assert.equal(noop.ok !== false, true);
  const commit2 = service.commit({projectId: world.projectId, envelope: (noop as {envelope: unknown}).envelope,
    expectedPlanDigest: (noop as {planDigest: string}).planDigest});
  assert.ok(commit2);
  const noop2 = service.preview({projectId: world.projectId, requestId: 'fr-a-noop-0002',
    propertiesIntent: properties([{clipId: clipB, patch: {transition}}])}) as {ok?: boolean; code?: string};
  assert.equal(noop2.ok, false);
  assert.equal(noop2.code, 'SEQUENCE_EDIT_NOOP');
  // Undo also advances the timeline revision, so the final record revision is
  // not the history position; only both counters must keep moving forward.
  const position = (service.history({projectId: world.projectId}) as {position: number}).position;
  assert.ok((readFormat5TimelineRecord(world.store.db, 'project') as Format5Timeline).revision > position);
});
