import type {TimelineJpegSource,TimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
type JpegPlanClip=Extract<TimelineColourPlan['clips'][number],{sourceProfileId:'jpeg-baseline-jfif-srgb-v1'}>;
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
for (const sampling of (['444', '422', '420'] as const))
  evidenceBySampling.set(sampling, jpegEvidenceOnly(await inspectStaticSrgbJfif(pillowJfifFixture(sampling))));
const evidence = (sampling: string = '420') => structuredClone(evidenceBySampling.get(sampling));
const jpeg = (sampling: string|undefined = '420') => jpegColour(evidence(((sampling) as unknown as Parameters<typeof evidence>[0])));
const png = () => ({profileId: 'mioon-srgb-image-clip-v1', source: {
  assetSha256: 'b'.repeat(64), profileId: 'png-rgb8-srgb-v1', interpretation: 'srgb', declaredBy: 'user', declaredAt: stamp,
  evidence: {profileId: 'png-rgb8-srgb-v1', sha256: 'b'.repeat(64), sourceByteLength: 123,
    width: 17, height: 19, bitDepth: 8, alphaMode: 'straight', orientation: 1, colourTag: 'untagged'},
}, look: null});
const video = () => ({profileId: 'mioon-rec709-sdr-clip-v1', source: {
  assetSha256: 'c'.repeat(64), streamIndex: 2, profileId: 'rec709-yuv-sdr-v1', range: 'limited', declaredBy: 'user', declaredAt: stamp,
}, look: null});
function fixture(kinds: string[]|undefined = ['jpeg'], sampling: string = '420') {
  const track = {id: randomUUID(), kind: 'video', hidden: false}, assets: ({ id: `${string}-${string}-${string}-${string}-${string}`; sha256: string; mimeType: string; })[] = [], clips: ({ id: `${string}-${string}-${string}-${string}-${string}`; assetId: `${string}-${string}-${string}-${string}-${string}`; trackId: `${string}-${string}-${string}-${string}-${string}`; startFrame: number; durationFrames: number; colour: { profileId: string; source: { assetSha256: string; profileId: string; interpretation: string; declaredBy: string; declaredAt: string; evidence: import("./helpers/timeline-jpeg-workflow-fixtures.ts").JpegColourEvidence; }; look: unknown; } | { profileId: string; source: { assetSha256: string; profileId: string; interpretation: string; declaredBy: string; declaredAt: string; evidence: { profileId: string; sha256: string; sourceByteLength: number; width: number; height: number; bitDepth: number; alphaMode: string; orientation: number; colourTag: string; }; }; look: null; } | { profileId: string; source: { assetSha256: string; streamIndex: number; profileId: string; range: string; declaredBy: string; declaredAt: string; }; look: null; }; })[] = [];
  for (const kind of kinds) {
    const colour = kind === 'jpeg' ? jpeg(sampling) : kind === 'png' ? png() : video();
    const asset = {id: randomUUID(), sha256: colour.source.assetSha256,
      mimeType: kind === 'jpeg' ? 'image/jpeg' : kind === 'png' ? 'image/png' : 'video/mp4'};
    assets.push(asset);
    clips.push({id: randomUUID(), assetId: asset.id, trackId: track.id, startFrame: 0, durationFrames: 30, colour});
  }
  return {timeline: {tracks: [track], clips}, assets};
}
const plan = (state: { timeline: unknown; assets: unknown; }) => createTimelineColourPlan(state.timeline, state.assets);
const snapshot = (state: { timeline: unknown; assets: unknown; }) => ({...state, colourPlan: plan(state)});
function mutated(value: { assetSha256: unknown; kind: string; evidence: unknown; status: string; projectId: `${string}-${string}-${string}-${string}-${string}`; assetId: `${string}-${string}-${string}-${string}-${string}`; }&{ status: "needs_interpretation"; assetSha256: string; evidence: { profileId: "jfif-ycbcr8-srgb-v1"; sha256: string; sourceByteLength: number; width: number; height: number; alphaMode: "opaque"; bitDepth: 8; orientation: 1; colourTag: "untagged"; sampling: "444"|"422"|"420"; decoderPolicy: "ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1"; }; assetId: string; kind: "image"; projectId: string; }, change: ((r?: unknown) => string)|((r?: unknown) => boolean)) { const copy = structuredClone(value); change(copy); return copy; }

test('JPEG source, clip and evidence form a separate strict generation, never widening old PNG/video schemas', () => {
  for (const sampling of (['444', '422', '420'] as const)) {
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
  for (const change of ([
(    e: { decoderPolicy: string; }) => e.decoderPolicy = 'browser-native', (e: { decoderPolicy: unknown; }) => delete e.decoderPolicy, (e: { sampling: string; }) => e.sampling = '411',
(    e: { sampling: number; }) => e.sampling = 420, (e: { sampling: unknown; }) => delete e.sampling, (e: { orientation: number; }) => e.orientation = 6, (e: { orientation: number; }) => e.orientation = 0,
(    e: { alphaMode: string; }) => e.alphaMode = 'straight', (e: { bitDepth: number; }) => e.bitDepth = 10, (e: { colourTag: string; }) => e.colourTag = 'srgb', (e: { colourTag: string; }) => e.colourTag = 'icc',
(    e: { profileId: string; }) => e.profileId = 'png-rgb8-srgb-v1', (e: { status: string; }) => e.status = 'needs_interpretation', (e: { extra: boolean; }) => e.extra = true,
(    e: { width: number; }) => e.width = 0, (e: { width: number; }) => e.width = 4097, (e: { height: number; }) => e.height = 4097, (e: { width: number; height: number; }) => {e.width = 1921; e.height = 1080;},
(    e: { sourceByteLength: number; }) => e.sourceByteLength = 0, (e: { sourceByteLength: number; }) => e.sourceByteLength = 32 * 1024 * 1024 + 1, (e: { sourceByteLength: number; }) => e.sourceByteLength = 1.5,
(    e: { sha256: string; }) => e.sha256 = 'x'.repeat(64), (e: { sha256: string; }) => e.sha256 = 'A'.repeat(64), (e: { transfer: string; }) => e.transfer = 'srgb',
  ] as const)) assert.equal(timelineJpegEvidenceSchema.safeParse(mutated(original, ((change) as unknown as Parameters<typeof mutated>[1]))).success, false);
});

test('JPEG declarations require explicit user sRGB intent, hash binding and exact closed source/clip shape', () => {
  const original = jpeg();
  for (const change of ([
(    c: { source: { interpretation: string; }; }) => c.source.interpretation = 'bt709', (c: { source: { interpretation: unknown; }; }) => delete c.source.interpretation,
(    c: { source: { declaredBy: string; }; }) => c.source.declaredBy = 'metadata', (c: { source: { declaredBy: string; }; }) => c.source.declaredBy = 'agent', (c: { source: { declaredBy: unknown; }; }) => delete c.source.declaredBy,
(    c: { source: { declaredAt: string; }; }) => c.source.declaredAt = 'yesterday', (c: { source: { declaredAt: unknown; }; }) => delete c.source.declaredAt,
(    c: { source: { assetSha256: string; }; }) => c.source.assetSha256 = 'd'.repeat(64), (c: { source: { profileId: string; }; }) => c.source.profileId = 'png-rgb8-srgb-v1',
(    c: { source: { extra: boolean; }; }) => c.source.extra = true, (c: { extra: boolean; }) => c.extra = true, (c: { profileId: string; }) => c.profileId = 'mioon-srgb-image-clip-v1',
(    c: { source: { evidence: { extra: boolean; }; }; }) => c.source.evidence.extra = true, (c: { source: { transfer: string; }; }) => c.source.transfer = 'srgb',
  ] as const)) assert.equal(clipColourSchema.safeParse(mutated(((original) as unknown as Parameters<typeof mutated>[0]), ((change) as unknown as Parameters<typeof mutated>[1]))).success, false);
  assert.ok(timelineJpegClipColourSchema.safeParse({...original, source: null}).success, 'unconfirmed state can be saved, not rendered');
  const state = fixture(); state.timeline.clips[0].colour.source = (null as unknown as (((((typeof state)["timeline"])["clips"])[number])["colour"])["source"]);
  assert.throws(() => plan(state), {code: 'INVALID_TIMELINE_COLOUR'});
});

test('only visible JPEG plan members select v3 while historical PNG-only v2 and video-only v1 remain exact', () => {
  for (const kinds of ([['jpeg'], ['jpeg', 'video'], ['png', 'jpeg'], ['video', 'png', 'jpeg']] as const)) {
    const state = fixture(((kinds) as unknown as Parameters<NonNullable<typeof fixture>>[0])), value = plan(state);
    assert.equal((value)!.profileId, 'mioon-mixed-sdr-render-v3');
    assert.ok(timelineJpegMixedColourPlanSchema.safeParse(value).success);
    assert.ok(timelineAnyColourPlanSchema.safeParse(value).success);
    assert.equal(timelineMixedColourPlanSchema.safeParse(value).success, false);
    assert.equal(timelineColourPlanSchema.safeParse(value).success, false);
    assert.equal((value)!.clips.filter(clip => clip.sourceProfileId === 'jfif-ycbcr8-srgb-v1').length, 1);
  }
  const pngState = fixture(['png']), pngPlan = plan(pngState), pc = pngState.timeline.clips[0], pa = pngState.assets[0];
  const expectedPng = {profileId: 'mioon-mixed-sdr-render-v2', working: 'rec709-encoded-rgb8-v1', output: 'rec709-yuv420p-limited-v1',
    lutAlgorithm: 'cube3d-tetrahedral-premixed-v1', outOfDomain: 'clip-lut-domain', clips: [{clipId: pc.id, assetId: pa.id,
      assetSha256: pa.sha256, streamIndex: 0, kind: 'image', sourceProfileId: 'png-rgb8-srgb-v1', interpretation: 'srgb',
      evidence: (pc.colour.source as TimelineJpegSource).evidence, transformProfile: TIMELINE_IMAGE_TRANSFORM_PROFILE, algorithm: 'rgb8-fixed-linear-table256-v1',
      algorithmSha256: TIMELINE_IMAGE_TABLE_SHA256,
      referenceDisplay: {eotf: 'bt1886-zero-black', gamma: 2.4, black: 0, white: 1, luminance: 'relative', primaries: 'bt709', whitePoint: 'D65'},
      alpha: 'straight-transform-look-premultiply-resize', resizeProfile: TIMELINE_IMAGE_RESIZE_PROFILE, look: null}]};
  assert.equal(JSON.stringify(pngPlan), JSON.stringify(expectedPng));
  assert.equal(Object.hasOwn((pngPlan)!.clips[0], 'decodeProfile'), false);
  const videoState = fixture(['video']), videoPlan = plan(videoState), vc = videoState.timeline.clips[0], va = videoState.assets[0];
  const expectedVideo = {profileId: 'mioon-rec709-sdr-render-v1', working: 'rec709-encoded-rgb8-v1', output: 'rec709-yuv420p-limited-v1',
    lutAlgorithm: 'cube3d-tetrahedral-premixed-v1', outOfDomain: 'clip-lut-domain', clips: [{clipId: vc.id, assetId: va.id,
      assetSha256: va.sha256, streamIndex: 2, range: 'limited', look: null}]};
  assert.equal(JSON.stringify(videoPlan), JSON.stringify(expectedVideo));
  for (const key of (['kind', 'sourceProfileId', 'decodeProfile', 'evidence'] as const)) assert.equal(Object.hasOwn((videoPlan)!.clips[0], key), false);
  const hidden = fixture(['png', 'jpeg']), hiddenTrack = {id: randomUUID(), kind: 'video', hidden: true};
  hidden.timeline.tracks.push(hiddenTrack); hidden.timeline.clips[1].trackId = hiddenTrack.id;
  assert.equal((plan(hidden))!.profileId, 'mioon-mixed-sdr-render-v2');
});

test('JPEG plan preserves exact detached source evidence, decoder and alpha/transfer identities', () => {
  const state = fixture(), value = plan(state), original = structuredClone((state.timeline.clips[0].colour.source as TimelineJpegSource).evidence);
  assert.deepEqual(((value)!.clips[0] as Extract<TimelineColourPlan['clips'][number],{kind:'image'}>).evidence, original);
  assert.equal(((value)!.clips[0] as unknown as {decodeProfile:("browser-native")}).decodeProfile, TIMELINE_JPEG_DECODE_PROFILE);
  assert.equal((((value)!.clips[0] as Extract<TimelineColourPlan['clips'][number],{kind:'image'}>).evidence as import('../packages/contracts/src/timeline-colour.ts').TimelineJpegEvidence).decoderPolicy, TIMELINE_JPEG_DECODE_PROFILE);
  assert.equal(((value)!.clips[0] as unknown as {alpha:("straight-transform-look-premultiply-resize")}).alpha, 'opaque-transform-look-premultiply-resize');
  assert.equal(((value)!.clips[0] as unknown as {transformProfile:("srgb-pass-through-v1")}).transformProfile, 'srgb8-to-bt1886-zero-black-display-v1');
  assert.equal(((value)!.clips[0] as unknown as {algorithmSha256:(string)}).algorithmSha256, TIMELINE_IMAGE_TABLE_SHA256);
  (state.timeline.clips[0].colour.source as TimelineJpegSource).evidence.width++;
  assert.deepEqual(((value)!.clips[0] as Extract<TimelineColourPlan['clips'][number],{kind:'image'}>).evidence, original, 'plan evidence is not an alias of caller state');
  assert.ok(timelineJpegColourPlanClipSchema.safeParse((value)!.clips[0]).success);
});

test('saved JPEG snapshots reject every changed evidence/pipeline identity or omitted colour plan', () => {
  const original = snapshot(fixture()); assert.ok(isTimelineColourSnapshot(original));
  for (const change of ([
(    s: { colourPlan: { profileId: string; }; }) => s.colourPlan.profileId = 'mioon-mixed-sdr-render-v2', (s: { colourPlan: { extra: boolean; }; }) => s.colourPlan.extra = true,
(    s: { colourPlan: { working: string; }; }) => s.colourPlan.working = 'linear-rgb', (s: { colourPlan: { output: string; }; }) => s.colourPlan.output = 'rec2020-pq',
(    s: { colourPlan: { clips: { decodeProfile: string; }[]; }; }) => s.colourPlan.clips[0].decodeProfile = 'browser-native', (s: { colourPlan: { clips: { decodeProfile: unknown; }[]; }; }) => delete s.colourPlan.clips[0].decodeProfile,
(    s: { colourPlan: { clips: { sourceProfileId: string; }[]; }; }) => s.colourPlan.clips[0].sourceProfileId = 'png-rgb8-srgb-v1', (s: { colourPlan: { clips: { streamIndex: number; }[]; }; }) => s.colourPlan.clips[0].streamIndex = 1,
(    s: { colourPlan: { clips: { alpha: string; }[]; }; }) => s.colourPlan.clips[0].alpha = 'straight-transform-look-premultiply-resize',
(    s: { colourPlan: { clips: { transformProfile: string; }[]; }; }) => s.colourPlan.clips[0].transformProfile = 'srgb-pass-through-v1',
(    s: { colourPlan: { clips: { algorithmSha256: string; }[]; }; }) => s.colourPlan.clips[0].algorithmSha256 = 'f'.repeat(64), (s: { colourPlan: { clips: { algorithm: string; }[]; }; }) => s.colourPlan.clips[0].algorithm = 'float-approximate',
(    s: { colourPlan: { clips: { resizeProfile: string; }[]; }; }) => s.colourPlan.clips[0].resizeProfile = 'nearest', (s: { colourPlan: { clips: { referenceDisplay: { gamma: number; }; }[]; }; }) => s.colourPlan.clips[0].referenceDisplay.gamma = 2.2,
(    s: { colourPlan: { clips: { referenceDisplay: { primaries: string; }; }[]; }; }) => s.colourPlan.clips[0].referenceDisplay.primaries = 'display-p3', (s: { colourPlan: { clips: { referenceDisplay: { extra: boolean; }; }[]; }; }) => s.colourPlan.clips[0].referenceDisplay.extra = true,
(    s: { colourPlan: { clips: { evidence: { width: number; }; }[]; }; }) => s.colourPlan.clips[0].evidence.width++, (s: { colourPlan: { clips: { evidence: { sourceByteLength: number; }; }[]; }; }) => s.colourPlan.clips[0].evidence.sourceByteLength++,
(    s: { colourPlan: { clips: { evidence: { sampling: string; }; }[]; }; }) => s.colourPlan.clips[0].evidence.sampling = '444', (s: { colourPlan: { clips: { evidence: { orientation: number; }; }[]; }; }) => s.colourPlan.clips[0].evidence.orientation = 6,
(    s: { colourPlan: { clips: { evidence: { decoderPolicy: string; }; }[]; }; }) => s.colourPlan.clips[0].evidence.decoderPolicy = 'browser-native', (s: { colourPlan: { clips: { evidence: { colourTag: string; }; }[]; }; }) => s.colourPlan.clips[0].evidence.colourTag = 'srgb',
(    s: { colourPlan: { clips: { evidence: { extra: boolean; }; }[]; }; }) => s.colourPlan.clips[0].evidence.extra = true, (s: { colourPlan: { clips: { extra: boolean; }[]; }; }) => s.colourPlan.clips[0].extra = true,
(    s: { timeline: { clips: { colour: { source: { evidence: { sampling: string; }; }; }; }[]; }; }) => s.timeline.clips[0].colour.source.evidence.sampling = '422', (s: { timeline: { clips: { colour: { source: { evidence: { height: number; }; }; }; }[]; }; }) => s.timeline.clips[0].colour.source.evidence.height++,
(    s: { timeline: { clips: { colour: { source: null; }; }[]; }; }) => s.timeline.clips[0].colour.source = null, (s: { assets: { sha256: string; }[]; }) => s.assets[0].sha256 = 'd'.repeat(64),
(    s: { assets: { mimeType: string; }[]; }) => s.assets[0].mimeType = 'image/png', (s: { colourPlan: { clips: { assetId: string; }[]; }; }) => s.colourPlan.clips[0].assetId = randomUUID(),
(    s: { colourPlan: { clips: unknown[]; }; }) => s.colourPlan.clips.push(structuredClone(s.colourPlan.clips[0])), (s: { colourPlan: { clips: never[]; }; }) => s.colourPlan.clips = [],
(    s: { colourPlan: unknown; }) => delete s.colourPlan, (s: { colourPlan: null; }) => s.colourPlan = null,
  ] as const)) assert.equal(isTimelineColourSnapshot(mutated(((original) as unknown as Parameters<typeof mutated>[0]), ((change) as unknown as Parameters<typeof mutated>[1]))), false);
});

test('JPEG presence, valid JFIF bytes or a needs-interpretation inspection never create an implicit declaration', () => {
  for (const absent of (['missing', null] as const)) {
    const state = fixture();
    if (absent === 'missing') delete (state.timeline.clips[0] as {colour?: unknown}).colour; else state.timeline.clips[0].colour = (null as unknown as ((((typeof state)["timeline"])["clips"])[number])["colour"]);
    const before = structuredClone(state);
    assert.equal(plan(state), undefined); assert.deepEqual(state, before);
  }
  const mixed = fixture(['video', 'jpeg']); delete (mixed.timeline.clips[1] as {colour?: unknown}).colour;
  assert.throws(() => plan(mixed), {code: 'INVALID_TIMELINE_COLOUR'});
  for (const mimeType of (['image/png', 'image/webp', 'image/jpg', 'video/mp4'] as const)) {
    const state = fixture(); state.assets[0].mimeType = mimeType;
    assert.throws(() => plan(state), {code: 'INVALID_TIMELINE_COLOUR'});
  }
  const state = fixture(), value = state.timeline.clips[0].colour.source;
  delete (value as {declaredBy?: unknown}).declaredBy;
  assert.throws(() => plan(state), {code: 'INVALID_TIMELINE_COLOUR'});
});

test('JPEG inspection is distinct, request-bound and always needs interpretation with bounded local-process effects', () => {
  const request = {projectId: randomUUID(), assetId: randomUUID()}, data = evidence();
  const response = {...request, assetSha256: data.sha256, kind: 'image', evidence: data, status: 'needs_interpretation'};
  assert.deepEqual(parse('timeline.colour.jpeg.inspect', request), request);
  assert.ok(isTimelineJpegSourceInspection(response, request));
  assert.equal(isTimelineImageSourceInspection(response, request), false);
  for (const change of ([(r: { projectId: string; }) => r.projectId = randomUUID(), (r: { assetId: string; }) => r.assetId = randomUUID(), (r: { assetSha256: string; }) => r.assetSha256 = 'd'.repeat(64),
(    r: { status: string; }) => r.status = 'compatible', (r: { status: string; }) => r.status = 'unsupported', (r: { extra: boolean; }) => r.extra = true,
(    r: { evidence: { colourTag: string; }; }) => r.evidence.colourTag = 'srgb', (r: { evidence: { decoderPolicy: string; }; }) => r.evidence.decoderPolicy = 'browser-native', (r: { evidence: { extra: boolean; }; }) => r.evidence.extra = true] as const))
    assert.equal(isTimelineJpegSourceInspection(mutated(response, ((change) as unknown as Parameters<typeof mutated>[1])), request), false);
  assert.equal(isTimelineJpegSourceInspection(response, {...request, extra: true}), false);
  assert.throws(() => parse('timeline.colour.jpeg.inspect', {...request, interpretation: 'srgb'}));
  const effect = operationEffect('timeline.colour.jpeg.inspect');
  for (const key of (['readOnly', 'idempotent', 'localProcess'] as const)) assert.equal(effect[key], true);
  for (const key of (['fileWrite', 'databaseWrite', 'externalIO', 'paidGeneration', 'destructive', 'openWorld'] as const)) assert.equal(effect[key], false);
});

test('current clip mutation DTO accepts only the explicit JPEG generation and retains unknown-field rejection', () => {
  const state = fixture(), clip = state.timeline.clips[0];
  const request = {projectId: randomUUID(), expectedRevision: 1, requestId: randomUUID(), clipId: clip.id, patch: {colour: clip.colour}};
  assert.deepEqual(parse('timeline.clip.update', request).patch.colour, clip.colour);
  for (const change of ([(r: { patch: { colour: { source: { evidence: { decoderPolicy: string; }; }; }; }; }) => r.patch.colour.source.evidence.decoderPolicy = 'unbounded-native', (r: { patch: { colour: { source: { extra: boolean; }; }; }; }) => r.patch.colour.source.extra = true,
(    r: { patch: { colour: { extra: boolean; }; }; }) => r.patch.colour.extra = true, (r: { patch: { colour: { source: { evidence: { colourTag: string; }; }; }; }; }) => r.patch.colour.source.evidence.colourTag = 'srgb', (r: { patch: { sourceEvidence: unknown; }; }) => r.patch.sourceEvidence = evidence()] as const))
    assert.throws(() => parse('timeline.clip.update', mutated(((request) as unknown as Parameters<typeof mutated>[0]), ((change) as unknown as Parameters<typeof mutated>[1]))));
});
