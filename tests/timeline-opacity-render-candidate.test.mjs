import test from 'node:test';
import assert from 'node:assert/strict';
import {isTimelineRenderRecord, resolveTimelineExportDelivery} from '../packages/contracts/src/index.mjs';
import {createTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {
  OPACITY_RENDER_CANDIDATE_PROFILE, captureOpacityRenderInput, createOpacityRenderSnapshotPlan,
  captureOpacityRenderSnapshot, captureOpacityPreparedSourceProjection, isOpacityRenderRecord,
} from '../packages/contracts/src/timeline-opacity-render-candidate.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-16T00:00:00.000Z';
const envelope = () => ({profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: 0}, {frame: 30, opacity: 1}]});
const invalid = callback => assert.throws(callback, {code: 'INVALID_OPACITY_RENDER_CANDIDATE'});
function fixture(fields = {opacityEnvelope: envelope()}, purpose = 'preview') {
  const clip = {id: id(5), trackId: id(4), assetId: id(2), name: 'Synthetic', startFrame: 0, durationFrames: 30, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, ...fields};
  const timeline = {id: id(3), projectId: id(1), revision: 7, fps: 30, width: 720, height: 1280,
    tracks: [{id: id(4), name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips: [clip], durationFrames: 30, createdAt: stamp, updatedAt: stamp};
  const snapshot = {timeline, assets: [{id: id(2), sha256: 'a'.repeat(64), mimeType: 'video/mp4', duration: 1, width: 720, height: 1280, hasAudio: true, relativePath: 'media/never-opened.mp4'}]};
  const input = {projectId: id(1), requestId: 'synthetic-opacity-render', expectedRevision: 7, purpose};
  const record = {id: id(6), projectId: input.projectId, requestId: input.requestId, mode: 'timeline', purpose,
    timelineRevision: input.expectedRevision, snapshot, status: 'queued', assetId: null, url: null, error: null, createdAt: stamp, updatedAt: stamp};
  return {input, snapshot, record};
}
function plannedFixture(fields, purpose) {
  const value = fixture(fields, purpose), plan = createOpacityRenderSnapshotPlan(value.snapshot, value.input.purpose);
  if (plan) value.snapshot.opacityPlan = plan;
  return value;
}

test('raw snapshot retains opacity and derives an exact immutable algorithm/source plan without authority', () => {
  const f = fixture(), before = JSON.stringify(f.snapshot), plan = createOpacityRenderSnapshotPlan(f.snapshot, 'preview');
  assert.equal(plan.profileId, OPACITY_RENDER_CANDIDATE_PROFILE);
  assert.deepEqual(plan.clips, [{clipId: id(5), trackId: id(4), assetId: id(2), assetSha256: 'a'.repeat(64), alphaMode: 'straight'}]);
  assert.equal(plan.stage, 'post-normalize-pre-overlay-v1');
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.clips[0]), true);
  assert.equal(JSON.stringify(f.snapshot), before);
  invalid(() => captureOpacityRenderSnapshot(f.snapshot, 'preview'));
  f.snapshot.opacityPlan = plan;
  const captured = captureOpacityRenderSnapshot(f.snapshot, 'preview');
  assert.deepEqual(captured.snapshot, f.snapshot);
  assert.notEqual(captured.snapshot, f.snapshot);
  assert.equal(isOpacityRenderRecord(f.record, f.input), true);
  assert.equal(isTimelineRenderRecord(f.record, f.input), false);
  f.snapshot.timeline.clips[0].opacityEnvelope.points[0].opacity = 1;
  assert.equal(captured.snapshot.timeline.clips[0].opacityEnvelope.points[0].opacity, 0);
});

test('absent and explicit null preserve raw presence and omit every new plan field', () => {
  for (const fields of [{}, {opacityEnvelope: null}]) {
    const f = fixture(fields), before = JSON.stringify(f.snapshot);
    assert.equal(createOpacityRenderSnapshotPlan(f.snapshot), undefined);
    assert.deepEqual(captureOpacityRenderSnapshot(f.snapshot).snapshot, f.snapshot);
    assert.equal(JSON.stringify(f.snapshot), before);
    assert.equal(Object.hasOwn(f.snapshot, 'opacityPlan'), false);
    assert.equal(isOpacityRenderRecord(f.record, f.input), true);
    const extra = {...f.snapshot, opacityPlan: {...createOpacityRenderSnapshotPlan(fixture().snapshot), clips: []}};
    invalid(() => captureOpacityRenderSnapshot(extra));
  }
});

test('complete queued/progressed preview/export ACKs bind their raw plan and request identity', () => {
  for (const purpose of ['preview', 'export']) {
    const f = plannedFixture(undefined, purpose);
    assert.equal(isOpacityRenderRecord(f.record, f.input), true);
    assert.equal(isOpacityRenderRecord({...f.record, status: 'running'}, f.input), true);
    assert.equal(isOpacityRenderRecord({...f.record, status: 'succeeded', assetId: id(8), url: `/media/${id(8)}`}, f.input), true);
    assert.equal(isOpacityRenderRecord({...f.record, status: 'failed', error: {code: 'SYNTHETIC', message: 'Synthetic failure'}}, f.input), true);
    for (const changed of [{...f.input, requestId: 'different-request'}, {...f.input, expectedRevision: 8}, {...f.input, projectId: id(9)}, {...f.input, purpose: purpose === 'preview' ? 'export' : 'preview'}]) {
      assert.equal(isOpacityRenderRecord(f.record, changed), false);
    }
    assert.equal(isOpacityRenderRecord(f.record, {...f.input, exportId: id(6), timelineId: id(3)}), true);
    assert.equal(isOpacityRenderRecord(f.record, {...f.input, exportId: id(9)}), false);
  }
});

test('named ranged custom export keeps the whole curve and legacy delivery semantics', () => {
  const f = fixture(undefined, 'export');
  const settings = {profileId: 'mp4_h264_v1', resolution: 'native', rateControl: {mode: 'crf', quality: 'standard'}};
  f.input.exportSettings = settings; f.input.deliveryName = 'Synthetic output'; f.input.exportRange = {startFrame: 5, endFrame: 20};
  f.snapshot.delivery = resolveTimelineExportDelivery(f.snapshot.timeline, settings);
  f.snapshot.deliveryName = f.input.deliveryName; f.snapshot.exportRange = {...f.input.exportRange};
  f.snapshot.opacityPlan = createOpacityRenderSnapshotPlan(f.snapshot, 'export');
  assert.equal(isOpacityRenderRecord(f.record, f.input), true);
  assert.deepEqual(f.snapshot.timeline.clips[0].opacityEnvelope, envelope());
  invalid(() => captureOpacityRenderSnapshot(f.snapshot, 'preview'));
  assert.equal(isOpacityRenderRecord(f.record, {...f.input, exportRange: {startFrame: 6, endFrame: 20}}), false);
});

test('managed images derive premultiplied handling from the existing frozen colour plan', () => {
  const f = fixture();
  const sha = f.snapshot.assets[0].sha256, evidence = {profileId: 'png-rgb8-srgb-v1', sha256: sha, sourceByteLength: 123, width: 17, height: 19, bitDepth: 8, alphaMode: 'straight', orientation: 1, colourTag: 'untagged'};
  const clip = f.snapshot.timeline.clips[0];
  f.snapshot.assets[0] = {...f.snapshot.assets[0], mimeType: 'image/png', duration: 0, hasAudio: false};
  clip.colour = {profileId: 'mioon-srgb-image-clip-v1', source: {assetSha256: sha, profileId: 'png-rgb8-srgb-v1', interpretation: 'srgb', declaredBy: 'user', declaredAt: stamp, evidence}, look: null};
  f.snapshot.colourPlan = createTimelineColourPlan(f.snapshot.timeline, f.snapshot.assets);
  f.snapshot.opacityPlan = createOpacityRenderSnapshotPlan(f.snapshot);
  assert.equal(f.snapshot.opacityPlan.clips[0].alphaMode, 'premultiplied');
  assert.equal(isOpacityRenderRecord(f.record, f.input), true);
  const changed = structuredClone(f.record); changed.snapshot.opacityPlan.clips[0].alphaMode = 'straight';
  assert.equal(isOpacityRenderRecord(changed, f.input), false);
});

test('missing, conflicting, extra, misbound and wrong-path plan evidence refuses', () => {
  const f = plannedFixture();
  for (const alter of [
    value => delete value.opacityPlan,
    value => value.opacityPlan.profileId = 'arbitrary-filter',
    value => value.opacityPlan.stage = 'after-output',
    value => value.opacityPlan.clips[0].assetSha256 = 'b'.repeat(64),
    value => value.opacityPlan.clips[0].clipId = id(8),
    value => value.opacityPlan.clips.push({...value.opacityPlan.clips[0]}),
    value => value.opacityPlan.clips[0].filter = 'arbitrary-script',
    value => value.timeline.clips[0].rect.opacityEnvelope = envelope(),
    value => value.assets[0].opacityEnvelope = envelope(),
  ]) {
    const changed = structuredClone(f.snapshot); alter(changed);
    invalid(() => captureOpacityRenderSnapshot(changed));
    assert.equal(isOpacityRenderRecord({...f.record, snapshot: changed}, f.input), false);
  }
});

test('source preparation gets a detached validation-only projection; request payloads cannot select the effect', () => {
  const f = plannedFixture(), before = JSON.stringify(f.snapshot);
  const prepared = captureOpacityPreparedSourceProjection(f.snapshot, 'preview');
  assert.deepEqual(prepared.snapshot, f.snapshot);
  assert.equal(Object.hasOwn(prepared.sourceValidationSnapshot, 'opacityPlan'), false);
  assert.equal(Object.hasOwn(prepared.sourceValidationSnapshot.timeline.clips[0], 'opacityEnvelope'), false);
  assert.equal(JSON.stringify(f.snapshot), before);
  assert.deepEqual(captureOpacityRenderInput(f.input), f.input);
  for (const extra of [{opacityPlan: f.snapshot.opacityPlan}, {candidate: true}, {validator: () => true}]) invalid(() => captureOpacityRenderInput({...f.input, ...extra}));
  let traps = 0;
  invalid(() => captureOpacityRenderSnapshot(new Proxy(f.snapshot, {get() {traps++; throw Error('must not run');}})));
  const getter = {...f.snapshot}; Object.defineProperty(getter, 'timeline', {enumerable: true, get() {traps++; throw Error('must not run');}});
  invalid(() => captureOpacityRenderSnapshot(getter));
  assert.equal(traps, 0);
});
