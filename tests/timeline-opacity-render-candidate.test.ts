type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import test from 'node:test';
import assert from 'node:assert/strict';
import {isTimelineRenderRecord, resolveTimelineExportDelivery} from '../packages/contracts/src/index.ts';
import {createTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {
  OPACITY_RENDER_CANDIDATE_PROFILE, captureOpacityRenderInput, createOpacityRenderSnapshotPlan,
  captureOpacityRenderSnapshot, captureOpacityPreparedSourceProjection, isOpacityRenderRecord,
type OpacityRenderCandidatePlan,
} from '../packages/contracts/src/timeline-opacity-render-candidate.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-16T00:00:00.000Z';
const envelope = () => ({profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: 0}, {frame: 30, opacity: 1}]});
const invalid = (callback: { (): { snapshot: { [x: string]: unknown; }; plan: OpacityRenderCandidatePlan|undefined; }; (): { snapshot: { [x: string]: unknown; }; plan: OpacityRenderCandidatePlan|undefined; }; (): { snapshot: { [x: string]: unknown; }; plan: OpacityRenderCandidatePlan|undefined; }; (): { snapshot: { [x: string]: unknown; }; plan: OpacityRenderCandidatePlan|undefined; }; (): { [x: string]: unknown; }; (): { snapshot: { [x: string]: unknown; }; plan: OpacityRenderCandidatePlan|undefined; }; (): { snapshot: { [x: string]: unknown; }; plan: OpacityRenderCandidatePlan|undefined; }; (): unknown; }) => assert.throws(callback, {code: 'INVALID_OPACITY_RENDER_CANDIDATE'});
function fixture(fields: {opacityEnvelope?: { profileId: string; points: { frame: number; opacity: number; }[]; };} = {opacityEnvelope: envelope()}, purpose: string|undefined = 'preview') {
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
function plannedFixture(fields?: { opacityEnvelope: { profileId: string; points: { frame: number; opacity: number; }[]; }; }|undefined, purpose?: string|undefined) {
  const value = fixture(fields, purpose), plan = createOpacityRenderSnapshotPlan(value.snapshot, ((value.input.purpose) as unknown as Parameters<typeof createOpacityRenderSnapshotPlan>[1]));
  if (plan) (value.snapshot as unknown as {opacityPlan:(OpacityRenderCandidatePlan)|(OpacityRenderCandidatePlan | undefined)}).opacityPlan = plan;
  return value;
}

test('raw snapshot retains opacity and derives an exact immutable algorithm/source plan without authority', () => {
  const f = fixture(), before = JSON.stringify(f.snapshot), plan = createOpacityRenderSnapshotPlan(f.snapshot, 'preview');
  assert.equal((plan)!.profileId, OPACITY_RENDER_CANDIDATE_PROFILE);
  assert.deepEqual((plan)!.clips, [{clipId: id(5), trackId: id(4), assetId: id(2), assetSha256: 'a'.repeat(64), alphaMode: 'straight'}]);
  assert.equal((plan)!.stage, 'post-normalize-pre-overlay-v1');
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen((plan)!.clips[0]), true);
  assert.equal(JSON.stringify(f.snapshot), before);
  invalid(() => captureOpacityRenderSnapshot(f.snapshot, 'preview'));
  (f.snapshot as unknown as {opacityPlan:(OpacityRenderCandidatePlan)|(OpacityRenderCandidatePlan | undefined)}).opacityPlan = plan;
  const captured = captureOpacityRenderSnapshot(f.snapshot, 'preview');
  assert.deepEqual(captured.snapshot, f.snapshot);
  assert.notEqual(captured.snapshot, f.snapshot);
  assert.equal(isOpacityRenderRecord(f.record, f.input), true);
  assert.equal(isTimelineRenderRecord(f.record, f.input), false);
  (f.snapshot.timeline.clips[0].opacityEnvelope)!.points[0].opacity = 1;
  assert.equal((captured.snapshot.timeline.clips[0].opacityEnvelope)!.points[0].opacity, 0);
});

test('absent and explicit null preserve raw presence and omit every new plan field', () => {
  for (const fields of ([{}, {opacityEnvelope: null}] as const)) {
    const f = fixture(((fields) as unknown as Parameters<typeof fixture>[0])), before = JSON.stringify(f.snapshot);
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
  for (const purpose of (['preview', 'export'] as const)) {
    const f = plannedFixture(undefined, purpose);
    assert.equal(isOpacityRenderRecord(f.record, f.input), true);
    assert.equal(isOpacityRenderRecord({...f.record, status: 'running'}, f.input), true);
    assert.equal(isOpacityRenderRecord({...f.record, status: 'succeeded', assetId: id(8), url: `/media/${id(8)}`}, f.input), true);
    assert.equal(isOpacityRenderRecord({...f.record, status: 'failed', error: {code: 'SYNTHETIC', message: 'Synthetic failure'}}, f.input), true);
    for (const changed of ([{...f.input, requestId: 'different-request'}, {...f.input, expectedRevision: 8}, {...f.input, projectId: id(9)}, {...f.input, purpose: purpose === 'preview' ? 'export' : 'preview'}] as const)) {
      assert.equal(isOpacityRenderRecord(f.record, changed), false);
    }
    assert.equal(isOpacityRenderRecord(f.record, {...f.input, exportId: id(6), timelineId: id(3)}), true);
    assert.equal(isOpacityRenderRecord(f.record, {...f.input, exportId: id(9)}), false);
  }
});

test('named ranged custom export keeps the whole curve and legacy delivery semantics', () => {
  const f = fixture(undefined, 'export');
  const settings = {profileId: 'mp4_h264_v1', resolution: 'native', rateControl: {mode: 'crf', quality: 'standard'}};
  (f.input as unknown as {exportSettings:({ profileId: string; resolution: string; rateControl: { mode: string; quality: string; }; })}).exportSettings = settings; (f.input as unknown as {deliveryName:("Synthetic output")}).deliveryName = 'Synthetic output'; (f.input as unknown as {exportRange:({ startFrame: number; endFrame: number; })}).exportRange = {startFrame: 5, endFrame: 20};
  (f.snapshot as unknown as {delivery:({ exportSettings: { profileId: "mp4_h264_v1"; resolution: "native" | "short_360" | "short_720" | "short_1080"; rateControl: { mode: "crf"; quality: "compact" | "standard" | "high"; } | { mode: "bitrate"; targetKbps: 2000 | 4000 | 8000; }; }; effective: { pixelFormat: "yuv420p"; profileId: "mp4_h264_v1"; width: number; height: number; rateControl: { mode: "crf"; crf: 28 | 23 | 18; } | { mode: "bitrate"; targetKbps: 2000 | 4000 | 8000; }; container: "mp4"; fps: 30; videoCodec: "libx264"; preset: "veryfast"; bFrames: 0; gopFrames: 60; videoTrackTimescale: 30000; scaling: "lanczos"; audioCodec: "aac"; audioKbps: 128; audioSampleRate: 48000; audioChannels: 2; movflags: "faststart"; }; } | { exportSettings: { profileId: "mp4_h264_float_checked_v2"; resolution: "native" | "short_360" | "short_720" | "short_1080"; rateControl: { mode: "crf"; quality: "compact" | "standard" | "high"; } | { mode: "bitrate"; targetKbps: 2000 | 4000 | 8000; }; }; effective: { pixelFormat: "yuv420p"; profileId: "mp4_h264_float_checked_v2"; width: number; height: number; rateControl: { mode: "crf"; crf: 28 | 23 | 18; } | { mode: "bitrate"; targetKbps: 2000 | 4000 | 8000; }; container: "mp4"; fps: 30; videoCodec: "libx264"; preset: "veryfast"; bFrames: 0; gopFrames: 60; videoTrackTimescale: 30000; scaling: "lanczos"; audioCodec: "aac"; audioKbps: 128; audioSampleRate: 48000; audioChannels: 2; movflags: "faststart"; intermediateAudio: { container: "mov"; codec: "pcm_f32le"; sampleFormat: "flt"; sampleRate: 48000; channels: 2; }; preencodeAudioPolicy: { policyId: "preencode_sample_peak_reject_over_one_v1"; maxPeakLinear: 1; overRange: "reject"; }; }; })}).delivery = resolveTimelineExportDelivery(f.snapshot.timeline, settings);
  (f.snapshot as unknown as {deliveryName:("Synthetic output")}).deliveryName = (f.input as unknown as {deliveryName:("Synthetic output")}).deliveryName; (f.snapshot as unknown as {exportRange:({ startFrame: number; endFrame: number; })}).exportRange = {...(f.input as unknown as {exportRange:({ startFrame: number; endFrame: number; })}).exportRange};
  (f.snapshot as unknown as {opacityPlan:(OpacityRenderCandidatePlan)|(OpacityRenderCandidatePlan | undefined)}).opacityPlan = createOpacityRenderSnapshotPlan(f.snapshot, 'export');
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
  (clip as unknown as {colour:({ profileId: string; source: { assetSha256: string; profileId: string; interpretation: string; declaredBy: string; declaredAt: string; evidence: { profileId: string; sha256: string; sourceByteLength: number; width: number; height: number; bitDepth: number; alphaMode: string; orientation: number; colourTag: string; }; }; look: null; })}).colour = {profileId: 'mioon-srgb-image-clip-v1', source: {assetSha256: sha, profileId: 'png-rgb8-srgb-v1', interpretation: 'srgb', declaredBy: 'user', declaredAt: stamp, evidence}, look: null};
  (f.snapshot as typeof f.snapshot & {colourPlan?:ReturnType<typeof createTimelineColourPlan>}).colourPlan = createTimelineColourPlan(f.snapshot.timeline, f.snapshot.assets);
  (f.snapshot as unknown as {opacityPlan:(OpacityRenderCandidatePlan)|(OpacityRenderCandidatePlan | undefined)}).opacityPlan = createOpacityRenderSnapshotPlan(f.snapshot);
  assert.equal(((f.snapshot as unknown as {opacityPlan:(OpacityRenderCandidatePlan)|(OpacityRenderCandidatePlan | undefined)}).opacityPlan)!.clips[0].alphaMode, 'premultiplied');
  assert.equal(isOpacityRenderRecord(f.record, f.input), true);
  const changed = structuredClone(f.record); (((changed.snapshot as unknown as {opacityPlan:(OpacityRenderCandidatePlan)|(OpacityRenderCandidatePlan | undefined)}).opacityPlan)!.clips[0] as unknown as {alphaMode:string}).alphaMode = 'straight';
  assert.equal(isOpacityRenderRecord(changed, f.input), false);
});

test('missing, conflicting, extra, misbound and wrong-path plan evidence refuses', () => {
  const f = plannedFixture();
  for (const alter of ([
(    value: { opacityPlan: unknown; }) => delete value.opacityPlan,
(    value: { opacityPlan: { profileId: string; }; }) => value.opacityPlan.profileId = 'arbitrary-filter',
(    value: { opacityPlan: { stage: string; }; }) => value.opacityPlan.stage = 'after-output',
(    value: { opacityPlan: { clips: { assetSha256: string; }[]; }; }) => value.opacityPlan.clips[0].assetSha256 = 'b'.repeat(64),
(    value: { opacityPlan: { clips: { clipId: string; }[]; }; }) => value.opacityPlan.clips[0].clipId = id(8),
(    value: { opacityPlan: { clips: unknown[]; }; }) => value.opacityPlan.clips.push({...(value.opacityPlan.clips[0] as Record<string, unknown>)}),
(    value: { opacityPlan: { clips: { filter: string; }[]; }; }) => value.opacityPlan.clips[0].filter = 'arbitrary-script',
(    value: { timeline: { clips: { rect: { opacityEnvelope: { profileId: string; points: { frame: number; opacity: number; }[]; }; }; }[]; }; }) => value.timeline.clips[0].rect.opacityEnvelope = envelope(),
(    value: { assets: { opacityEnvelope: { profileId: string; points: { frame: number; opacity: number; }[]; }; }[]; }) => value.assets[0].opacityEnvelope = envelope(),
  ] as const)) {
    const changed = structuredClone(f.snapshot); alter(((((changed) as unknown as Parameters<typeof alter>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof alter>>[0]>));
    invalid(() => captureOpacityRenderSnapshot(changed));
    assert.equal(isOpacityRenderRecord({...f.record, snapshot: changed}, f.input), false);
  }
});

test('source preparation gets a detached validation-only projection; request payloads cannot select the effect', () => {
  const f = plannedFixture(), before = JSON.stringify(f.snapshot);
  const prepared = captureOpacityPreparedSourceProjection(f.snapshot, 'preview');
  assert.deepEqual(prepared.snapshot, f.snapshot);
  assert.equal(Object.hasOwn(prepared.sourceValidationSnapshot, 'opacityPlan'), false);
  assert.equal(Object.hasOwn((prepared.sourceValidationSnapshot as {timeline:{clips:object[]}}).timeline.clips[0], 'opacityEnvelope'), false);
  assert.equal(JSON.stringify(f.snapshot), before);
  assert.deepEqual(captureOpacityRenderInput(f.input), f.input);
  for (const extra of ([{opacityPlan: (f.snapshot as unknown as {opacityPlan:(OpacityRenderCandidatePlan)|(OpacityRenderCandidatePlan | undefined)}).opacityPlan}, {candidate: true}, {validator: () => true}] as const)) invalid(((() => captureOpacityRenderInput({...f.input, ...extra})) as unknown as Parameters<typeof invalid>[0]));
  let traps = 0;
  invalid(() => captureOpacityRenderSnapshot(new Proxy(f.snapshot, {get() {traps++; throw Error('must not run');}})));
  const getter = {...f.snapshot}; Object.defineProperty(getter, 'timeline', {enumerable: true, get() {traps++; throw Error('must not run');}});
  invalid(() => captureOpacityRenderSnapshot(getter));
  assert.equal(traps, 0);
});
