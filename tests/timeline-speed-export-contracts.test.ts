import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {exportPreflightResponseSchema} from '../packages/contracts/src/export-preflight.ts';
import {hasRequestNotAppliedProof, isTimelineRenderRecord} from '../packages/contracts/src/timeline-acknowledgement.ts';
import {hasTimelineDeliveryIdentity, timelineRenderDeliveryFields} from '../packages/contracts/src/timeline-delivery.ts';
import {isTimelineExportSnapshot, TIMELINE_EXPORT_DEFAULT_SETTINGS,
  timelineExportCapabilitiesResponseSchema} from '../packages/contracts/src/timeline-export-profile.ts';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';
import {
  compileTimelineSpeedExportClips, isTimelineSpeedExportSnapshot, SPEED_PROCESSING_NOT_READY,
  SPEED_INTERPOLATION_NOT_READY, TIMELINE_SPEED_EXPORT_MESSAGES, timelineSpeedExportSnapshotFields,
} from '../packages/contracts/src/timeline-speed-export.ts';

const sha = 'a'.repeat(64);
const clock = {fpsNumerator: 30, fpsDenominator: 1};
const stamp = '2026-10-16T00:00:00.000Z';

function fixture(purpose: 'preview' | 'export' = 'export') {
  const input = {projectId: randomUUID(), expectedRevision: 1, requestId: randomUUID(), purpose};
  const track = {id: randomUUID(), kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false};
  const asset = {id: randomUUID(), sha256: sha, mimeType: 'video/mp4', duration: 10 / 30};
  const clip = {id: randomUUID(), trackId: track.id, assetId: asset.id, name: 'Video', startFrame: 0,
    durationFrames: 10, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1};
  const timeline = {id: randomUUID(), projectId: input.projectId, revision: 1, fps: 30, width: 720, height: 1280,
    durationFrames: 10, tracks: [track], clips: [clip], createdAt: stamp, updatedAt: stamp};
  const record = {id: randomUUID(), projectId: input.projectId, requestId: input.requestId, mode: 'timeline', purpose,
    timelineRevision: 1, snapshot: {timeline, assets: [asset]}, status: 'queued', assetId: null, url: null, error: null,
    createdAt: stamp, updatedAt: stamp};
  return {input, track, asset, clip, timeline, record};
}

function slowed(direction: 'forward' | 'reverse'): ClipTiming {
  return {profile: 'timeline-speed-v1', basis: {profile: 'timeline-speed-v1', sourceFps: clock, outputFps: clock,
    sourceRange: {start: {kind: 'rational', numerator: '0', denominator: '1'},
      end: {kind: 'rational', numerator: '10', denominator: '1'}},
    speed: {kind: 'constant', rate: {numerator: 1, denominator: 2}}},
  view: {direction, loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}},
  outputWindow: {fromFrame: 0, toFrame: 20}, pitchShift: false, interpolation: 'off'};
}

test('historical render records retain their original field presence and bounds', () => {
  for (const purpose of ['preview', 'export'] as const) {
    const {timeline, record, input} = fixture(purpose);
    const before = JSON.stringify(record);
    assert.deepEqual(timelineSpeedExportSnapshotFields(timeline), {});
    assert.equal(isTimelineRenderRecord(record, input), true);
    assert.equal(isTimelineRenderRecord(record, input, {format: 6}), true);
    assert.equal(hasTimelineDeliveryIdentity(record), false);
    assert.equal(JSON.stringify(record), before);
    const malformed = {...record, snapshot: {...record.snapshot, speedExport: undefined}};
    assert.equal(isTimelineRenderRecord(malformed, input), false);
    assert.equal(isTimelineRenderRecord({...record, snapshot: {...record.snapshot, assets: [{...record.snapshot.assets[0], duration: 0.1}]}}, input), false);
  }
});

test('frozen speed exports bind timed clip identity and use source span with legacy API input', () => {
  const {timeline, record, input, clip} = fixture();
  const projected = {...timeline, durationFrames: 20,
    clips: [{...clip, durationFrames: 20, sourceSpanFrames: 10, timing: slowed('forward')}]};
  assert.equal(isTimelineExportSnapshot({...record.snapshot, timeline: projected}), false, 'missing binding must not opt back into legacy rendering');
  const fields = timelineSpeedExportSnapshotFields(projected);
  const frozen = {...record.snapshot, timeline: projected, ...fields};
  assert.equal(frozen.speedExport?.clips[0]?.mapHash, compileTimelineSpeedExportClips(projected)[0]?.plan.root.mapHash);
  assert.deepEqual(timelineRenderDeliveryFields(frozen), {}, 'the snapshot-only field never enters exact request reconstruction');
  assert.equal(isTimelineExportSnapshot(frozen), true);
  assert.equal(hasTimelineDeliveryIdentity({...record, snapshot: frozen}), true);
  assert.equal(isTimelineRenderRecord({...record, snapshot: frozen}, input), true, 'clients can validate before learning the storage format');
  assert.equal(isTimelineRenderRecord({...record, snapshot: frozen}, input, {format: 6}), true);
  assert.equal(isTimelineRenderRecord({...record, snapshot: frozen}, input, {format: 5}), false);
  assert.equal(isTimelineExportSnapshot(frozen, {purpose: 'preview'}), false);
  assert.equal(isTimelineExportSnapshot(frozen, {purpose: undefined}), false);
  assert.equal(isTimelineRenderRecord({...record, purpose: 'preview', snapshot: frozen}, {...input, purpose: 'preview'}), false);
  assert.ok(fields.speedExport);
  const first = fields.speedExport.clips[0]!;
  for (const clips of [[], [first, first], [{...first, clipId: randomUUID()}], [{...first, mapHash: '0'.repeat(16)}],
    [{...first, proxy: undefined}], [{...first, proxy: {taskId: randomUUID(), sha256: sha}}],
    [{...first, path: 'proxy.mkv'}], [{...first, timing: slowed('forward')}], Array.from({length: 101}, () => first)]) {
    const changed: unknown = {...frozen, speedExport: {...fields.speedExport, clips}};
    assert.equal(isTimelineSpeedExportSnapshot(changed), false);
    assert.equal(isTimelineRenderRecord({...record, snapshot: changed}, input), false);
  }
  const inconsistent = {...projected, clips: [{...projected.clips[0]!, sourceSpanFrames: 9}]};
  assert.throws(() => timelineSpeedExportSnapshotFields(inconsistent), {code: 'SPEED_MAPPING_INVALID'});
  assert.equal(isTimelineSpeedExportSnapshot({...frozen, timeline: inconsistent}), false);
  const withTooShortAsset = {...frozen, assets: [{...frozen.assets[0], duration: 9 / 30}]};
  assert.equal(isTimelineRenderRecord({...record, snapshot: withTooShortAsset}, input), false);
});

test('reverse binding stores only digest and task identity; freeze binds its exact video and version', () => {
  const {timeline, record, input, clip, asset} = fixture();
  const reverse = {...timeline, durationFrames: 20,
    clips: [{...clip, durationFrames: 20, sourceSpanFrames: 10, timing: slowed('reverse')}]};
  const proxy = {taskId: randomUUID(), sha256: 'b'.repeat(64)};
  const fields = timelineSpeedExportSnapshotFields(reverse, new Map([[clip.id, proxy]]));
  const frozen = {...record.snapshot, timeline: reverse, ...fields};
  assert.deepEqual(frozen.speedExport?.clips[0]?.proxy, proxy);
  assert.equal(isTimelineRenderRecord({...record, snapshot: frozen}, input), true);
  const error = {code: SPEED_PROCESSING_NOT_READY, message: TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_PROCESSING_NOT_READY], taskId: proxy.taskId};
  const failed = {...record, snapshot: frozen, status: 'failed', error};
  assert.equal(isTimelineRenderRecord(failed, input), true);
  assert.equal(isTimelineRenderRecord({...failed, status: 'queued'}, input), false);
  assert.equal(isTimelineRenderRecord({...failed, error: {...error, taskId: undefined}}, input), false);
  assert.equal(isTimelineRenderRecord({...failed, error: {...error, code: SPEED_INTERPOLATION_NOT_READY}}, input), false);
  assert.equal(isTimelineRenderRecord({...failed, snapshot: record.snapshot}, input), false);
  assert.throws(() => timelineSpeedExportSnapshotFields(reverse, new Map([[randomUUID(), proxy]])), {code: 'SPEED_MAPPING_INVALID'});
  assert.throws(() => timelineSpeedExportSnapshotFields(reverse, new Map([[clip.id, {...proxy, path: 'proxy.mkv'}]])), {code: 'SPEED_MAPPING_INVALID'});
  assert.equal(isTimelineSpeedExportSnapshot({...record.snapshot, timeline: reverse, ...timelineSpeedExportSnapshotFields(reverse)}), true,
    'backend checks reverse availability for participating clips');

  const freeze: ClipTiming = {profile: 'timeline-freeze-v1', sourceFrame: 2, sourceVersionId: null, sourceSha256: sha};
  const fixed = {...timeline, durationFrames: 20, clips: [{...clip, muted: true, sourceInFrame: 2, durationFrames: 20,
    sourceSpanFrames: 1, timing: freeze}]};
  const fixedSnapshot = {...record.snapshot, timeline: fixed, ...timelineSpeedExportSnapshotFields(fixed)};
  assert.equal(isTimelineRenderRecord({...record, snapshot: fixedSnapshot}, input), true);
  assert.equal(isTimelineSpeedExportSnapshot({...fixedSnapshot, assets: [{...asset, sha256: proxy.sha256}]}), false);
  assert.throws(() => timelineSpeedExportSnapshotFields({...fixed, clips: [{...fixed.clips[0]!, muted: false}]}), {code: 'SPEED_MAPPING_INVALID'});
  assert.throws(() => timelineSpeedExportSnapshotFields({...fixed, clips: [{...fixed.clips[0]!, versionId: randomUUID()}]}), {code: 'SPEED_MAPPING_INVALID'});
});

test('readiness reports retain a bounded task id, and rejection proofs bind the original export', () => {
  const {timeline, input, clip} = fixture();
  const issue = {code: SPEED_PROCESSING_NOT_READY, message: TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_PROCESSING_NOT_READY],
    clipId: clip.id, taskId: randomUUID()};
  const base = {projectId: input.projectId, timelineId: timeline.id, timelineRevision: 1, expectedRevision: 1,
    checkedAt: stamp, status: 'blocked'};
  const preflight = {...base, snapshotHash: null, summary: null,
    checks: {totalAssets: 0, checkedAssets: 0, bytesHashed: 0, fullDecode: false}, issues: [{...issue, severity: 'error'}]};
  assert.equal(exportPreflightResponseSchema.safeParse(preflight).success, true);
  assert.equal(exportPreflightResponseSchema.safeParse({...preflight, issues: [{...preflight.issues[0]!, taskId: '/tmp/proxy'}]}).success, false);
  assert.equal(exportPreflightResponseSchema.safeParse({...preflight, issues: [{...preflight.issues[0]!, code: SPEED_INTERPOLATION_NOT_READY}]}).success, false);
  const capabilities = {...base, exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS, delivery: null, issues: [issue]};
  assert.equal(timelineExportCapabilitiesResponseSchema.safeParse(capabilities).success, true);
  assert.equal(timelineExportCapabilitiesResponseSchema.safeParse({...capabilities, status: 'stale'}).success, false);
  const error = {code: issue.code, status: 409, details: {projectId: input.projectId, requestId: input.requestId,
    operation: 'timeline.render', mutationOutcome: 'not_applied', taskId: issue.taskId}};
  const operation = {operation: 'timeline.render'};
  assert.equal(hasRequestNotAppliedProof(error, input, operation), true);
  assert.equal(hasRequestNotAppliedProof({...error, details: {...error.details, requestId: randomUUID()}}, input, operation), false);
  assert.equal(hasRequestNotAppliedProof({...error, details: {...error.details, taskId: 'proxy.mkv'}}, input, operation), false);
  assert.equal(hasRequestNotAppliedProof({...error, details: {taskId: issue.taskId}}, input, operation), false);
  assert.equal(hasRequestNotAppliedProof({...error, terminationUnconfirmed: true}, input, operation), false);
  assert.equal(hasRequestNotAppliedProof(error, {...input, purpose: 'preview'}, operation), false);
});
