import test from 'node:test';
import assert from 'node:assert/strict';
import * as legacy from '@mioon/contracts';
import {createOpacityCandidateBrowserContracts} from '../apps/web/src/opacity-candidate-browser-contracts.ts';
import {createOpacityRenderSnapshotPlan, isOpacityRenderRecord} from '../packages/contracts/src/timeline-opacity-render-candidate.ts';
import {isOpacityApplicationMutationResponse} from '../packages/contracts/src/timeline-opacity-persistence.ts';

const contracts = createOpacityCandidateBrowserContracts(legacy);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-16T00:00:00.000Z';
const curve = () => ({profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: 0}, {frame: 30, opacity: 1}]});
function fixture(fields = {opacityEnvelope: curve()}, purpose = 'preview') {
  const clip = {id: id(5), trackId: id(4), assetId: id(2), name: 'Synthetic', startFrame: 0, durationFrames: 30, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, ...fields};
  const timeline = {id: id(3), projectId: id(1), revision: 7, fps: 30, width: 720, height: 1280,
    tracks: [{id: id(4), name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips: [clip], durationFrames: 30, createdAt: stamp, updatedAt: stamp};
  const snapshot = {timeline, assets: [{id: id(2), sha256: 'a'.repeat(64), mimeType: 'video/mp4', duration: 1, width: 720, height: 1280, hasAudio: true, relativePath: 'media/never-opened.mp4'}]};
  const input = {projectId: id(1), requestId: 'synthetic-opacity-render', expectedRevision: 7, purpose};
  const plan = createOpacityRenderSnapshotPlan(snapshot, purpose);if (plan) snapshot.opacityPlan = plan;
  const record = {id: id(6), projectId: input.projectId, requestId: input.requestId, mode: 'timeline', purpose,
    timelineRevision: 7, snapshot, status: 'queued', assetId: null, url: null, error: null, createdAt: stamp, updatedAt: stamp};
  return {input, snapshot, timeline, clip, record};
}

test('browser candidate preview/export validation agrees with actual Node ACK grammar for raw presence and request/source/plan identity', () => {
  for (const purpose of ['preview', 'export']) for (const fields of [{}, {opacityEnvelope: null}, {opacityEnvelope: curve()}]) {
    const f = fixture(fields, purpose), before = JSON.stringify(f.record);
    assert.equal(contracts.isTimelineRenderRecord(f.record, f.input), true);
    assert.equal(isOpacityRenderRecord(f.record, f.input), true);assert.equal(JSON.stringify(f.record), before);
    for (const corrupt of [
      value => {value.requestId = 'wrong-request';}, value => {value.snapshot.timeline.revision++;},
      value => {value.snapshot.timeline.clips[0].opacityEnvelope = {profileId: 'wrong', points: []};},
      value => {value.snapshot.assets[0].sha256 = 'b'.repeat(64);},
      value => {value.snapshot.opacityPlan = {profileId: 'mioon-clip-opacity-render-v1', clips: []};},
    ]) {
      const value = structuredClone(f.record);corrupt(value);
      assert.equal(contracts.isTimelineRenderRecord(value, f.input), isOpacityRenderRecord(value, f.input));
    }
    const succeeded = {...f.record, status: 'succeeded', assetId: id(9), url: `/media/${id(9)}`};
    assert.equal(contracts.isTimelineRenderRecord(succeeded, f.input), true);
    assert.equal(contracts.isTimelineRenderRecord({...succeeded, url: 'https://invalid.example/'}, f.input), false);
  }
});

test('candidate add ACK checks exact opacity presence on the same legacy-matching clip, and preserves old defaults', () => {
  for (const fields of [{}, {opacityEnvelope: null}, {opacityEnvelope: curve()}]) {
    const f = fixture(fields);f.timeline.revision = 8;
    const input = {projectId: id(1), requestId: 'synthetic-add-clip', expectedRevision: 7, trackId: id(4), assetId: id(2), startFrame: 0, durationFrames: 30, name: 'Synthetic', ...fields};
    assert.equal(contracts.schemas['timeline.clip.add'].safeParse(input).success, true);
    assert.equal(contracts.isTimelineMutationResponse('timeline.clip.add', input, f.timeline), true);
    assert.equal(isOpacityApplicationMutationResponse('timeline.clip.add', input, f.timeline), true);
    const wrong = structuredClone(f.timeline);
    if (Object.hasOwn(fields, 'opacityEnvelope')) delete wrong.clips[0].opacityEnvelope;else wrong.clips[0].opacityEnvelope = null;
    assert.equal(contracts.isTimelineMutationResponse('timeline.clip.add', input, wrong), false);
    f.timeline.clips[0].gain = .5;
    assert.equal(contracts.isTimelineMutationResponse('timeline.clip.add', input, f.timeline), false);
  }
  const f = fixture();f.timeline.revision = 8;
  const input = {projectId: id(1), requestId: 'synthetic-add-clip', expectedRevision: 7, trackId: id(4), assetId: id(2), startFrame: 0, durationFrames: 30, name: 'Synthetic', opacityEnvelope: curve()};
  f.clip.opacityEnvelope = null;f.timeline.clips.push({...structuredClone(f.clip), id: id(10), startFrame: 30, opacityEnvelope: curve()});f.timeline.durationFrames = 60;
  assert.equal(contracts.isTimelineMutationResponse('timeline.clip.add', input, f.timeline), false);
});

test('candidate timeline projection validates all retained opacity and keeps legacy unknown-key rejection', () => {
  const f = fixture();assert.equal(contracts.isTimelineRecord(f.timeline), true);assert.equal(legacy.isTimelineRecord(f.timeline), false);
  for (const mutate of [value => {value.clips[0].gain = -1;}, value => {value.clips[0].unknown = true;},
    value => {value.clips[0].opacityEnvelope.points[1].frame = 31;}, value => {value.tracks[0].kind = 'audio';}]) {
    const copy = structuredClone(f.timeline);mutate(copy);assert.equal(contracts.isTimelineRecord(copy), false);
  }
  assert.equal(contracts.validateProjectSnapshot({project: {id: id(1)}, timeline: f.timeline, exports: [f.record]}), true);
  assert.equal(contracts.validateProjectSnapshot({project: {id: id(8)}, timeline: f.timeline, exports: []}), false);
});
