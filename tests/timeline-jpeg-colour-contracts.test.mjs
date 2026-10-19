import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parse, operationEffect} from '@mioon/contracts';
import {
  clipColourSchema, timelineClipColourSchema, timelineImageClipColourSchema,
  timelineJpegEvidenceSchema, timelineJpegSourceSchema, timelineJpegClipColourSchema,
  timelineImageEvidenceSchema, timelineAnyImageEvidenceSchema, timelineAnyImageSourceSchema,
  timelineColourPlanSchema, timelineMixedColourPlanSchema, timelineJpegMixedColourPlanSchema,
  timelineJpegColourPlanClipSchema, timelineAnyColourPlanSchema,
  createTimelineColourPlan, isTimelineColourSnapshot, isTimelineJpegSourceInspection,
  isTimelineImageSourceInspection, TIMELINE_JPEG_DECODE_PROFILE, TIMELINE_IMAGE_TABLE_SHA256,
  TIMELINE_IMAGE_TRANSFORM_PROFILE, TIMELINE_IMAGE_RESIZE_PROFILE,
} from '../packages/contracts/src/timeline-colour.ts';
import {inspectStaticSrgbJfif} from '../packages/business/src/timeline-jpeg-admission.ts';
import {pillowJfifFixture} from './helpers/timeline-jpeg-fixtures.ts';
import {jpegEvidenceOnly, jpegColour} from './helpers/timeline-jpeg-workflow-fixtures.ts';

const stamp = '2026-10-15T00:00:00.000Z';
const evidenceBySampling = new Map();
for (const sampling of ['444', '422', '420'])
  evidenceBySampling.set(sampling, jpegEvidenceOnly(await inspectStaticSrgbJfif(pillowJfifFixture(sampling))));
const evidence = (sampling = '420') => structuredClone(evidenceBySampling.get(sampling));
const jpeg = (sampling = '420') => jpegColour(evidence(sampling));
const png = () => ({profileId: 'mioon-srgb-image-clip-v1', source: {
  assetSha256: 'b'.repeat(64), profileId: 'png-rgb8-srgb-v1', interpretation: 'srgb', declaredBy: 'user', declaredAt: stamp,
  evidence: {profileId: 'png-rgb8-srgb-v1', sha256: 'b'.repeat(64), sourceByteLength: 123,
    width: 17, height: 19, bitDepth: 8, alphaMode: 'straight', orientation: 1, colourTag: 'untagged'},
}, look: null});
const video = () => ({profileId: 'mioon-rec709-sdr-clip-v1', source: {
  assetSha256: 'c'.repeat(64), streamIndex: 2, profileId: 'rec709-yuv-sdr-v1', range: 'limited', declaredBy: 'user', declaredAt: stamp,
}, look: null});
function fixture(kinds = ['jpeg'], sampling = '420') {
  const track = {id: randomUUID(), kind: 'video', hidden: false}, assets = [], clips = [];
  for (const kind of kinds) {
    const colour = kind === 'jpeg' ? jpeg(sampling) : kind === 'png' ? png() : video();
    const asset = {id: randomUUID(), sha256: colour.source.assetSha256,
      mimeType: kind === 'jpeg' ? 'image/jpeg' : kind === 'png' ? 'image/png' : 'video/mp4'};
    assets.push(asset);
    clips.push({id: randomUUID(), assetId: asset.id, trackId: track.id, startFrame: 0, durationFrames: 30, colour});
  }
  return {timeline: {tracks: [track], clips}, assets};
}
const plan = state => createTimelineColourPlan(state.timeline, state.assets);
const snapshot = state => ({...state, colourPlan: plan(state)});
function mutated(value, change) { const copy = structuredClone(value); change(copy); return copy; }

test('JPEG source, clip and evidence form a separate strict generation, never widening old PNG/video schemas', () => {
  for (const sampling of ['444', '422', '420']) {
    const colour = jpeg(sampling);
    assert.ok(timelineJpegEvidenceSchema.safeParse(colour.source.evidence).success);
    assert.ok(timelineJpegSourceSchema.safeParse(colour.source).success);
    assert.ok(timelineJpegClipColourSchema.safeParse(colour).success);
    assert.ok(clipColourSchema.safeParse(colour).success);
    assert.ok(timelineAnyImageEvidenceSchema.safeParse(colour.source.evidence).success);
    assert.ok(timelineAnyImageSourceSchema.safeParse(colour.source).success);
    assert.equal(timelineImageEvidenceSchema.safeParse(colour.source.evidence).success, false);
    assert.equal(timelineImageClipColourSchema.safeParse(colour).success, false);
    assert.equal(timelineClipColourSchema.safeParse(colour).success, false);
  }
  assert.equal(timelineJpegClipColourSchema.safeParse(png()).success, false);
  assert.equal(timelineJpegClipColourSchema.safeParse(video()).success, false);
});

test('JPEG evidence rejects altered decoder, sampling, orientation, alpha, profile, colour and unknown fields', () => {
  const original = evidence();
  for (const change of [
    e => e.decoderPolicy = 'browser-native', e => delete e.decoderPolicy, e => e.sampling = '411',
    e => e.sampling = 420, e => delete e.sampling, e => e.orientation = 6, e => e.orientation = 0,
    e => e.alphaMode = 'straight', e => e.bitDepth = 10, e => e.colourTag = 'srgb', e => e.colourTag = 'icc',
    e => e.profileId = 'png-rgb8-srgb-v1', e => e.status = 'needs_interpretation', e => e.extra = true,
    e => e.width = 0, e => e.width = 4097, e => e.height = 4097, e => {e.width = 1921; e.height = 1080;},
    e => e.sourceByteLength = 0, e => e.sourceByteLength = 32 * 1024 * 1024 + 1, e => e.sourceByteLength = 1.5,
    e => e.sha256 = 'x'.repeat(64), e => e.sha256 = 'A'.repeat(64), e => e.transfer = 'srgb',
  ]) assert.equal(timelineJpegEvidenceSchema.safeParse(mutated(original, change)).success, false);
});

test('JPEG declarations require explicit user sRGB intent, hash binding and exact closed source/clip shape', () => {
  const original = jpeg();
  for (const change of [
    c => c.source.interpretation = 'bt709', c => delete c.source.interpretation,
    c => c.source.declaredBy = 'metadata', c => c.source.declaredBy = 'agent', c => delete c.source.declaredBy,
    c => c.source.declaredAt = 'yesterday', c => delete c.source.declaredAt,
    c => c.source.assetSha256 = 'd'.repeat(64), c => c.source.profileId = 'png-rgb8-srgb-v1',
    c => c.source.extra = true, c => c.extra = true, c => c.profileId = 'mioon-srgb-image-clip-v1',
    c => c.source.evidence.extra = true, c => c.source.transfer = 'srgb',
  ]) assert.equal(clipColourSchema.safeParse(mutated(original, change)).success, false);
  assert.ok(timelineJpegClipColourSchema.safeParse({...original, source: null}).success, 'unconfirmed state can be saved, not rendered');
  const state = fixture(); state.timeline.clips[0].colour.source = null;
  assert.throws(() => plan(state), {code: 'INVALID_TIMELINE_COLOUR'});
});

test('only visible JPEG plan members select v3 while historical PNG-only v2 and video-only v1 remain exact', () => {
  for (const kinds of [['jpeg'], ['jpeg', 'video'], ['png', 'jpeg'], ['video', 'png', 'jpeg']]) {
    const state = fixture(kinds), value = plan(state);
    assert.equal(value.profileId, 'mioon-mixed-sdr-render-v3');
    assert.ok(timelineJpegMixedColourPlanSchema.safeParse(value).success);
    assert.ok(timelineAnyColourPlanSchema.safeParse(value).success);
    assert.equal(timelineMixedColourPlanSchema.safeParse(value).success, false);
    assert.equal(timelineColourPlanSchema.safeParse(value).success, false);
    assert.equal(value.clips.filter(clip => clip.sourceProfileId === 'jfif-ycbcr8-srgb-v1').length, 1);
  }
  const pngState = fixture(['png']), pngPlan = plan(pngState), pc = pngState.timeline.clips[0], pa = pngState.assets[0];
  const expectedPng = {profileId: 'mioon-mixed-sdr-render-v2', working: 'rec709-encoded-rgb8-v1', output: 'rec709-yuv420p-limited-v1',
    lutAlgorithm: 'cube3d-tetrahedral-premixed-v1', outOfDomain: 'clip-lut-domain', clips: [{clipId: pc.id, assetId: pa.id,
      assetSha256: pa.sha256, streamIndex: 0, kind: 'image', sourceProfileId: 'png-rgb8-srgb-v1', interpretation: 'srgb',
      evidence: pc.colour.source.evidence, transformProfile: TIMELINE_IMAGE_TRANSFORM_PROFILE, algorithm: 'rgb8-fixed-linear-table256-v1',
      algorithmSha256: TIMELINE_IMAGE_TABLE_SHA256,
      referenceDisplay: {eotf: 'bt1886-zero-black', gamma: 2.4, black: 0, white: 1, luminance: 'relative', primaries: 'bt709', whitePoint: 'D65'},
      alpha: 'straight-transform-look-premultiply-resize', resizeProfile: TIMELINE_IMAGE_RESIZE_PROFILE, look: null}]};
  assert.equal(JSON.stringify(pngPlan), JSON.stringify(expectedPng));
  assert.equal(Object.hasOwn(pngPlan.clips[0], 'decodeProfile'), false);
  const videoState = fixture(['video']), videoPlan = plan(videoState), vc = videoState.timeline.clips[0], va = videoState.assets[0];
  const expectedVideo = {profileId: 'mioon-rec709-sdr-render-v1', working: 'rec709-encoded-rgb8-v1', output: 'rec709-yuv420p-limited-v1',
    lutAlgorithm: 'cube3d-tetrahedral-premixed-v1', outOfDomain: 'clip-lut-domain', clips: [{clipId: vc.id, assetId: va.id,
      assetSha256: va.sha256, streamIndex: 2, range: 'limited', look: null}]};
  assert.equal(JSON.stringify(videoPlan), JSON.stringify(expectedVideo));
  for (const key of ['kind', 'sourceProfileId', 'decodeProfile', 'evidence']) assert.equal(Object.hasOwn(videoPlan.clips[0], key), false);
  const hidden = fixture(['png', 'jpeg']), hiddenTrack = {id: randomUUID(), kind: 'video', hidden: true};
  hidden.timeline.tracks.push(hiddenTrack); hidden.timeline.clips[1].trackId = hiddenTrack.id;
  assert.equal(plan(hidden).profileId, 'mioon-mixed-sdr-render-v2');
});

test('JPEG plan preserves exact detached source evidence, decoder and alpha/transfer identities', () => {
  const state = fixture(), value = plan(state), original = structuredClone(state.timeline.clips[0].colour.source.evidence);
  assert.deepEqual(value.clips[0].evidence, original);
  assert.equal(value.clips[0].decodeProfile, TIMELINE_JPEG_DECODE_PROFILE);
  assert.equal(value.clips[0].evidence.decoderPolicy, TIMELINE_JPEG_DECODE_PROFILE);
  assert.equal(value.clips[0].alpha, 'opaque-transform-look-premultiply-resize');
  assert.equal(value.clips[0].transformProfile, 'srgb8-to-bt1886-zero-black-display-v1');
  assert.equal(value.clips[0].algorithmSha256, TIMELINE_IMAGE_TABLE_SHA256);
  state.timeline.clips[0].colour.source.evidence.width++;
  assert.deepEqual(value.clips[0].evidence, original, 'plan evidence is not an alias of caller state');
  assert.ok(timelineJpegColourPlanClipSchema.safeParse(value.clips[0]).success);
});

test('saved JPEG snapshots reject every changed evidence/pipeline identity or omitted colour plan', () => {
  const original = snapshot(fixture()); assert.ok(isTimelineColourSnapshot(original));
  for (const change of [
    s => s.colourPlan.profileId = 'mioon-mixed-sdr-render-v2', s => s.colourPlan.extra = true,
    s => s.colourPlan.working = 'linear-rgb', s => s.colourPlan.output = 'rec2020-pq',
    s => s.colourPlan.clips[0].decodeProfile = 'browser-native', s => delete s.colourPlan.clips[0].decodeProfile,
    s => s.colourPlan.clips[0].sourceProfileId = 'png-rgb8-srgb-v1', s => s.colourPlan.clips[0].streamIndex = 1,
    s => s.colourPlan.clips[0].alpha = 'straight-transform-look-premultiply-resize',
    s => s.colourPlan.clips[0].transformProfile = 'srgb-pass-through-v1',
    s => s.colourPlan.clips[0].algorithmSha256 = 'f'.repeat(64), s => s.colourPlan.clips[0].algorithm = 'float-approximate',
    s => s.colourPlan.clips[0].resizeProfile = 'nearest', s => s.colourPlan.clips[0].referenceDisplay.gamma = 2.2,
    s => s.colourPlan.clips[0].referenceDisplay.primaries = 'display-p3', s => s.colourPlan.clips[0].referenceDisplay.extra = true,
    s => s.colourPlan.clips[0].evidence.width++, s => s.colourPlan.clips[0].evidence.sourceByteLength++,
    s => s.colourPlan.clips[0].evidence.sampling = '444', s => s.colourPlan.clips[0].evidence.orientation = 6,
    s => s.colourPlan.clips[0].evidence.decoderPolicy = 'browser-native', s => s.colourPlan.clips[0].evidence.colourTag = 'srgb',
    s => s.colourPlan.clips[0].evidence.extra = true, s => s.colourPlan.clips[0].extra = true,
    s => s.timeline.clips[0].colour.source.evidence.sampling = '422', s => s.timeline.clips[0].colour.source.evidence.height++,
    s => s.timeline.clips[0].colour.source = null, s => s.assets[0].sha256 = 'd'.repeat(64),
    s => s.assets[0].mimeType = 'image/png', s => s.colourPlan.clips[0].assetId = randomUUID(),
    s => s.colourPlan.clips.push(structuredClone(s.colourPlan.clips[0])), s => s.colourPlan.clips = [],
    s => delete s.colourPlan, s => s.colourPlan = null,
  ]) assert.equal(isTimelineColourSnapshot(mutated(original, change)), false);
});

test('JPEG presence, valid JFIF bytes or a needs-interpretation inspection never create an implicit declaration', () => {
  for (const absent of ['missing', null]) {
    const state = fixture();
    if (absent === 'missing') delete state.timeline.clips[0].colour; else state.timeline.clips[0].colour = null;
    const before = structuredClone(state);
    assert.equal(plan(state), undefined); assert.deepEqual(state, before);
  }
  const mixed = fixture(['video', 'jpeg']); delete mixed.timeline.clips[1].colour;
  assert.throws(() => plan(mixed), {code: 'INVALID_TIMELINE_COLOUR'});
  for (const mimeType of ['image/png', 'image/webp', 'image/jpg', 'video/mp4']) {
    const state = fixture(); state.assets[0].mimeType = mimeType;
    assert.throws(() => plan(state), {code: 'INVALID_TIMELINE_COLOUR'});
  }
  const state = fixture(), value = state.timeline.clips[0].colour.source;
  delete value.declaredBy;
  assert.throws(() => plan(state), {code: 'INVALID_TIMELINE_COLOUR'});
});

test('JPEG inspection is distinct, request-bound and always needs interpretation with bounded local-process effects', () => {
  const request = {projectId: randomUUID(), assetId: randomUUID()}, data = evidence();
  const response = {...request, assetSha256: data.sha256, kind: 'image', evidence: data, status: 'needs_interpretation'};
  assert.deepEqual(parse('timeline.colour.jpeg.inspect', request), request);
  assert.ok(isTimelineJpegSourceInspection(response, request));
  assert.equal(isTimelineImageSourceInspection(response, request), false);
  for (const change of [r => r.projectId = randomUUID(), r => r.assetId = randomUUID(), r => r.assetSha256 = 'd'.repeat(64),
    r => r.status = 'compatible', r => r.status = 'unsupported', r => r.extra = true,
    r => r.evidence.colourTag = 'srgb', r => r.evidence.decoderPolicy = 'browser-native', r => r.evidence.extra = true])
    assert.equal(isTimelineJpegSourceInspection(mutated(response, change), request), false);
  assert.equal(isTimelineJpegSourceInspection(response, {...request, extra: true}), false);
  assert.throws(() => parse('timeline.colour.jpeg.inspect', {...request, interpretation: 'srgb'}));
  const effect = operationEffect('timeline.colour.jpeg.inspect');
  for (const key of ['readOnly', 'idempotent', 'localProcess']) assert.equal(effect[key], true);
  for (const key of ['fileWrite', 'databaseWrite', 'externalIO', 'paidGeneration', 'destructive', 'openWorld']) assert.equal(effect[key], false);
});

test('current clip mutation DTO accepts only the explicit JPEG generation and retains unknown-field rejection', () => {
  const state = fixture(), clip = state.timeline.clips[0];
  const request = {projectId: randomUUID(), expectedRevision: 1, requestId: randomUUID(), clipId: clip.id, patch: {colour: clip.colour}};
  assert.deepEqual(parse('timeline.clip.update', request).patch.colour, clip.colour);
  for (const change of [r => r.patch.colour.source.evidence.decoderPolicy = 'unbounded-native', r => r.patch.colour.source.extra = true,
    r => r.patch.colour.extra = true, r => r.patch.colour.source.evidence.colourTag = 'srgb', r => r.patch.sourceEvidence = evidence()])
    assert.throws(() => parse('timeline.clip.update', mutated(request, change)));
});
