import test from 'node:test';
import assert from 'node:assert/strict';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import type {Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import type {SequenceEditHistoryView, SequenceEditSubtitlesIntent} from '../packages/contracts/src/sequence-edit.ts';

const rootId = '10000000-0000-4000-8000-000000000001';
const shotA = '10000000-0000-4000-8000-000000000010';
const shotB = '10000000-0000-4000-8000-000000000011';
const clipA = '10000000-0000-4000-8000-000000000020';
const clipB = '10000000-0000-4000-8000-000000000021';
const versionA = '10000000-0000-4000-8000-000000000050';
const versionB = '10000000-0000-4000-8000-000000000051';
const assetA = '10000000-0000-4000-8000-000000000060';
const assetB = '10000000-0000-4000-8000-000000000061';
const cueOne = '10000000-0000-4000-8000-000000000070';
const cueTwo = '10000000-0000-4000-8000-000000000071';

function fixture(t: test.TestContext) {
  const world = createChainWorld(t, {
    rootId,
    shots: [{id: shotA, title: 'A', versionId: versionA}, {id: shotB, title: 'B', versionId: versionB}],
    versions: [{versionId: versionA, assetId: assetA, sha256: 'a'.repeat(64), durationSeconds: 4},
      {versionId: versionB, assetId: assetB, sha256: 'b'.repeat(64), durationSeconds: 4}],
    clips: [{nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 60, versionId: versionA},
      {nodeId: shotB, clipId: clipB, startFrame: 60, durationFrames: 60, versionId: versionB}],
    edges: [{id: '10000000-0000-4000-8000-000000000030', fromId: rootId, toId: shotA},
      {id: '10000000-0000-4000-8000-000000000031', fromId: shotA, toId: shotB}],
  });
  return {world, service: createFormat5SequenceEditService(world.store)};
}
const subtitles = (edits: SequenceEditSubtitlesIntent['operation']['edits']): SequenceEditSubtitlesIntent =>
  ({side: 'timeline', operation: {kind: 'subtitles', edits}});
function timeline(world: ReturnType<typeof fixture>['world']): Format5Timeline {
  const record = readFormat5TimelineRecord(world.store.db, 'project');
  assert.ok(record);
  return record;
}

test('subtitle cue add/update/remove previews and commits through the unified entry with one-step undo', (t) => {
  const {world, service} = fixture(t);
  const add = service.preview({projectId: world.projectId, requestId: 'fr-b-subtitle-add-1',
    subtitlesIntent: subtitles([{kind: 'add', cue: {id: cueOne, text: 'First caption', startFrame: 10, durationFrames: 20}}])}) as
    {envelope: {actionId: string}; planDigest: string};
  assert.ok(add.envelope);
  const committed = service.commit({projectId: world.projectId, envelope: add.envelope,
    expectedPlanDigest: add.planDigest}) as {status: string; affected: Record<string, number>};
  assert.equal(committed.status, 'applied');
  assert.equal(committed.affected.subtitleCues, 1);
  let record = timeline(world);
  const cue = record.subtitles!.cues.find(item => item.id === cueOne)!;
  assert.equal(cue.text, 'First caption');
  assert.deepEqual(cue.anchor, {clipId: clipA, offsetFrames: 10});
  // Exact replay returns the same receipt without writing again.
  const replay = service.commit({projectId: world.projectId, envelope: add.envelope,
    expectedPlanDigest: add.planDigest}) as {actionId: string};
  assert.equal(replay.actionId, add.envelope.actionId);
  // Update in one action, still one undo step.
  const update = service.preview({projectId: world.projectId, requestId: 'fr-b-subtitle-update-1',
    subtitlesIntent: subtitles([{kind: 'update', cueId: cueOne, patch: {text: 'Edited', startFrame: 60,
      durationFrames: 30}}])}) as {envelope: unknown; planDigest: string};
  assert.ok(update.envelope);
  service.commit({projectId: world.projectId, envelope: update.envelope, expectedPlanDigest: update.planDigest});
  record = timeline(world);
  assert.equal(record.subtitles!.cues[0]!.text, 'Edited');
  assert.deepEqual(record.subtitles!.cues[0]!.anchor, {clipId: clipB, offsetFrames: 0});
  let view = service.history({projectId: world.projectId}) as SequenceEditHistoryView;
  assert.ok(view.undo);
  service.undo({projectId: world.projectId, requestId: 'fr-b-subtitle-undo-1',
    actionId: (update.envelope as {actionId: string}).actionId, expected: {position: view.position, revision: view.revision}});
  assert.equal(timeline(world).subtitles!.cues[0]!.text, 'First caption');
  // Remove and undo restores the exact cue row.
  const remove = service.preview({projectId: world.projectId, requestId: 'fr-b-subtitle-remove-1',
    subtitlesIntent: subtitles([{kind: 'remove', cueId: cueOne}])}) as {envelope: unknown; planDigest: string};
  service.commit({projectId: world.projectId, envelope: remove.envelope, expectedPlanDigest: remove.planDigest});
  assert.deepEqual(timeline(world).subtitles!.cues, []);
  view = service.history({projectId: world.projectId}) as SequenceEditHistoryView;
  assert.ok(view.undo);
  service.undo({projectId: world.projectId, requestId: 'fr-b-subtitle-undo-2',
    actionId: (remove.envelope as {actionId: string}).actionId, expected: {position: view.position, revision: view.revision}});
  assert.equal(timeline(world).subtitles!.cues[0]!.id, cueOne);
});

test('subtitle edits reject missing/overlapping anchors and same-value actions before writing', (t) => {
  const {world, service} = fixture(t);
  const preview = (edits: SequenceEditSubtitlesIntent['operation']['edits'], requestId = 'fr-b-subtitle-invalid-1') =>
    service.preview({projectId: world.projectId, requestId, subtitlesIntent: subtitles(edits)}) as
      {ok?: boolean; code?: string; envelope?: unknown; planDigest?: string};
  for (const edits of [
    [{kind: 'add', cue: {id: cueOne, text: 'X', startFrame: 130, durationFrames: 10}}],
    [{kind: 'add', cue: {id: cueOne, text: 'X', startFrame: 10, durationFrames: 10,
      anchor: {clipId: clipB, offsetFrames: 0}}}],
    [{kind: 'add', cue: {id: cueOne, text: 'X', startFrame: 10, durationFrames: 30}},
      {kind: 'add', cue: {id: cueTwo, text: 'Y', startFrame: 20, durationFrames: 10}}],
  ] as SequenceEditSubtitlesIntent['operation']['edits'][]) {
    const result = preview(edits);
    assert.equal(result.ok, false, JSON.stringify(edits));
    assert.equal(result.code, 'SEQUENCE_EDIT_SUBTITLE_INVALID', JSON.stringify(edits));
  }
  // Same values as the live state are a noop; no history entry/revision move.
  const add = preview([{kind: 'add', cue: {id: cueOne, text: 'X', startFrame: 10, durationFrames: 10}}], 'fr-b-subtitle-ok-1');
  assert.ok(add.envelope);
  service.commit({projectId: world.projectId, envelope: add.envelope, expectedPlanDigest: add.planDigest!});
  const before = timeline(world).revision;
  const noop = preview([{kind: 'update', cueId: cueOne, patch: {text: 'X'}}], 'fr-b-subtitle-noop-1');
  assert.equal(noop.ok, false);
  assert.equal(noop.code, 'SEQUENCE_EDIT_NOOP');
  assert.equal(timeline(world).revision, before);
});
