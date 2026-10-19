import test from 'node:test';
import assert from 'node:assert/strict';
import {schemas, isTimelineRecord} from '../packages/contracts/src/index.mjs';
import {isEditTask} from '../packages/contracts/src/edit-tasks.mjs';
import {createTimelineOpacityCandidateContracts, OPACITY_CANDIDATE_LIMITS} from '../packages/contracts/src/timeline-opacity-candidate.ts';
import {OPACITY_ENVELOPE_PROFILE, OPACITY_ENVELOPE_LIMITS} from '../packages/contracts/src/timeline-opacity-envelope.ts';
import {captureVolumeEnvelopeCandidateIntent as previousCapture} from './helpers/timeline-volume-envelope-candidate-intent.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const add = 'timeline.clip.add', update = 'timeline.clip.update', stamp = '2026-10-16T00:00:00.000Z';
const context = {trackKind: 'video', durationFrames: 18000};
const candidate = createTimelineOpacityCandidateContracts({isTimelineRecord, validateClipIntent: (operation, input) => schemas[operation].safeParse(input).success});
const envelope = (points = 7) => ({profileId: OPACITY_ENVELOPE_PROFILE, points: Array.from({length: points}, (_, frame) => ({frame, opacity: 1.2345678901234567e-100}))});
const volume = () => ({profileId: 'mioon-clip-linear-attenuation-v1', points: Array.from({length: 16}, (_, frame) => ({frame, multiplier: 1.2345678901234567e-100}))});
function largestColour() {
  const hash = 'f'.repeat(64), profileId = 'jfif-ycbcr8-srgb-v1';
  return {profileId: 'mioon-jfif-image-clip-v1', source: {assetSha256: hash, profileId, interpretation: 'srgb', declaredBy: 'user', declaredAt: stamp,
    evidence: {profileId, sha256: hash, sourceByteLength: 33554432, width: 1920, height: 1080, bitDepth: 8, alphaMode: 'opaque', orientation: 1, colourTag: 'untagged', sampling: '420', decoderPolicy: 'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1'}},
    look: {resourceId: id(1), resourceSha256: hash, resourceProfile: 'mioon-cube3d-normalized-tetrahedral-v1', purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: true, strength: 1}};
}
function maximalAdd() {
  return {projectId: id(1), requestId: '\u0002'.repeat(200), expectedRevision: Number.MAX_SAFE_INTEGER - 1, assetId: id(5), trackId: id(3),
    name: '\u0001'.repeat(200), startFrame: 0, durationFrames: 18000, sourceInFrame: Number.MAX_SAFE_INTEGER - 18000,
    rect: {x: 0, y: 0, width: 1280, height: 720}, gain: 2, fadeInFrames: 9000, fadeOutFrames: 9000, audioRole: 'human', colour: largestColour(), volumeEnvelope: volume()};
}
function maximalUpdate() {
  const {projectId, requestId, expectedRevision, assetId, ...patch} = maximalAdd();
  return {projectId, requestId, expectedRevision, clipId: id(4), patch};
}
function timeline() {
  return {id: id(2), projectId: id(1), revision: 1, fps: 30, width: 720, height: 1280,
    tracks: [{id: id(3), name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: [{id: id(4), assetId: id(5), trackId: id(3), name: 'Synthetic clip', startFrame: 0, durationFrames: 20, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1}],
    durationFrames: 20, createdAt: stamp, updatedAt: stamp};
}
const count = value => 1 + (value && typeof value === 'object' ? Object.values(value).reduce((sum, child) => sum + count(child), 0) : 0);

test('seven points fit the real 128-node prepare wrapper with maximal existing fields', t => {
  assert.equal(OPACITY_ENVELOPE_LIMITS.points, 7);
  for (const [operation, old, oldNodes] of [[add, maximalAdd(), 98], [update, maximalUpdate(), 99]]) {
    assert.equal(count(old), oldNodes);
    assert.equal(previousCapture(operation, old, {durationFrames: 18000}).nodes, oldNodes);
    const input = structuredClone(old), fields = operation === add ? input : input.patch;
    fields.opacityEnvelope = envelope();
    const before = JSON.stringify(input), result = candidate.captureIntent(operation, input, context);
    const prepared = {projectId: input.projectId, operation, input, origin: 'new'};
    assert.equal(count(prepared), oldNodes + 24 + 4);
    assert.equal(result.nodes, oldNodes + 24);
    assert.equal(result.prepareNodes, count(prepared));
    assert.equal(result.prepareDepth, operation === add ? 5 : 6);
    assert.ok(result.prepareNodes <= 128 && result.prepareDepth <= 8 && result.bytes < 8192);
    assert.equal(result.bytes, Buffer.byteLength(before));
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(result.input, input);
    assert.notEqual(result.input, input);
    fields.opacityEnvelope = envelope(8);
    assert.equal(count({projectId: input.projectId, operation, input, origin: 'new'}), oldNodes + 27 + 4);
    const tooMany = JSON.stringify(input);
    assert.throws(() => candidate.captureIntent(operation, input, context));
    assert.equal(JSON.stringify(input), tooMany);
    t.diagnostic(JSON.stringify({operation, baselineNodes: oldNodes, points: 7, nodes: result.nodes, prepareNodes: result.prepareNodes, bytes: result.bytes, depth: result.prepareDepth}));
  }
  assert.deepEqual(OPACITY_CANDIDATE_LIMITS, {prepareNodes: 128, prepareDepth: 8, inputBytes: 8192, recordBytes: 262144});
});

test('candidate add/update preserve absence/null/value and fail closed on duration and visual kind', () => {
  for (const operation of [add, update]) for (const opacity of [undefined, null, envelope()]) {
    const input = operation === add ? maximalAdd() : maximalUpdate(), fields = operation === add ? input : input.patch;
    if (opacity !== undefined) fields.opacityEnvelope = opacity;
    const result = candidate.captureIntent(operation, input, context);
    const savedFields = operation === add ? result.input : result.input.patch;
    assert.equal(Object.hasOwn(savedFields, 'opacityEnvelope'), opacity !== undefined);
    assert.deepEqual(result.input, input);
    if (opacity !== undefined) assert.throws(() => candidate.captureIntent(operation, input, {trackKind: 'audio'}), {code: 'OPACITY_CANDIDATE_VISUAL_REQUIRED'});
  }
  const input = {projectId: id(1), requestId: 'opacity-only-update', expectedRevision: 1, clipId: id(4), patch: {opacityEnvelope: envelope()}};
  assert.throws(() => candidate.captureIntent(update, input, {trackKind: 'video'}));
  assert.throws(() => candidate.captureIntent(update, input, {trackKind: 'video', durationFrames: 5}));
  const result = candidate.captureIntent(update, input, context);
  assert.deepEqual(result.input.patch, input.patch, 'historical nonempty-patch sentinel must never escape');
  assert.deepEqual(candidate.captureIntent(update, {...input, patch: {opacityEnvelope: null}}, {trackKind: 'video'}).input.patch, {opacityEnvelope: null});
  for (const patch of [{opacityEnvelope: undefined}, {opacityEnvelope: envelope(), unknown: 1}, {opacity: .5}, {}])
    assert.throws(() => candidate.captureIntent(update, {...input, patch}, context));
});

test('candidate intent admits only two exact typed curve arrays, without executing hostile data', () => {
  const base = maximalUpdate();
  base.patch.opacityEnvelope = envelope();
  let calls = 0;
  const trap = () => {calls++; throw Error('untrusted code executed');};
  for (const field of ['name', 'gain', 'rect', 'colour', 'audioRole', 'unknown']) {
    assert.throws(() => candidate.captureIntent(update, {...base, patch: {...base.patch, [field]: []}}, context));
  }
  const points = [{frame: 0, opacity: 1}];
  Object.defineProperty(points, '0', {enumerable: true, get: trap});
  const getter = {...base}; Object.defineProperty(getter, 'patch', {enumerable: true, get: trap});
  const handler = {get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap};
  for (const value of [getter, new Proxy(base, handler), {...base, patch: new Proxy(base.patch, handler)},
    {...base, patch: {...base.patch, opacityEnvelope: {profileId: OPACITY_ENVELOPE_PROFILE, points}}},
    {...base, patch: {...base.patch, opacityEnvelope: {profileId: OPACITY_ENVELOPE_PROFILE, points: new Proxy(envelope().points, handler)}}}])
    assert.throws(() => candidate.captureIntent(update, value, context));
  for (const checked of [new Proxy(context, handler), Object.defineProperty({}, 'trackKind', {enumerable: true, get: trap}), {trackKind: 'video', durationFrames: undefined}, {...context, unknown: 1}])
    assert.throws(() => candidate.captureIntent(update, base, checked));
  assert.equal(calls, 0);
  for (const points of [[], new Array(2), Object.assign([{frame: 0, opacity: 1}], {unknown: true}), [{frame: 0, opacity: 1, unknown: 0}]])
    assert.throws(() => candidate.captureIntent(update, {...base, patch: {...base.patch, opacityEnvelope: {profileId: OPACITY_ENVELOPE_PROFILE, points}}}, context));
  const hostile = {...base, toJSON: trap};
  assert.throws(() => candidate.captureIntent(update, hostile, context));
  assert.equal(calls, 0);
});

test('candidate record checks complete old structure and visual track while keeping new fields detached', () => {
  const base = timeline();
  for (const opacity of [undefined, null, envelope()]) {
    const value = structuredClone(base);
    if (opacity !== undefined) value.clips[0].opacityEnvelope = opacity;
    const before = JSON.stringify(value), result = candidate.captureRecord(value, {projectId: id(1)});
    assert.equal(result.text, before); assert.equal(JSON.stringify(value), before); assert.deepEqual(result.record, value);
    assert.notEqual(result.record.clips, value.clips);
    if (opacity !== undefined) {
      assert.equal(isTimelineRecord(value), false);
      value.tracks[0].kind = 'audio';
      assert.throws(() => candidate.captureRecord(value), {code: 'OPACITY_CANDIDATE_VISUAL_REQUIRED'});
    }
  }
  assert.throws(() => candidate.captureRecord(base, {projectId: id(9)}));
  assert.throws(() => candidate.captureRecord({...base, unknown: 1}));
  const both = timeline(); Object.assign(both.clips[0], {volumeEnvelope: volume(), opacityEnvelope: envelope()});
  assert.deepEqual(candidate.captureRecord(both).record, both);
  both.clips[0].opacityEnvelope.points.push({frame: 8, opacity: 1});
  assert.throws(() => candidate.captureRecord(both));
});

test('record capture refuses hostile records, options and unrelated arrays before any user code runs', () => {
  let calls = 0;
  const trap = () => {calls++; throw Error('must not run');};
  const handler = {get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap};
  const base = timeline(), getter = {...base};
  Object.defineProperty(getter, 'clips', {enumerable: true, get: trap});
  for (const value of [getter, new Proxy(base, handler), {...base, clips: new Proxy(base.clips, handler)},
    {...base, clips: [{...base.clips[0], rect: []}]}, {...base, clips: [{...base.clips[0], opacityEnvelope: new Proxy(envelope(), handler)}]}])
    assert.throws(() => candidate.captureRecord(value));
  for (const options of [new Proxy({projectId: id(1)}, handler), Object.defineProperty({}, 'projectId', {enumerable: true, get: trap}), {unknown: true}])
    assert.throws(() => candidate.captureRecord(base, options));
  assert.equal(calls, 0);
});

test('candidate traversal and complete size rejection leave original input unchanged', () => {
  const input = maximalUpdate();
  const subtree = () => Object.fromEntries(Array.from({length: 60}, (_, i) => ['n' + i, i]));
  const overNodes = {...input, extra: {a: subtree(), b: subtree()}};
  assert.throws(() => candidate.captureIntent(update, overNodes, context), {code: 'OPACITY_CANDIDATE_STRUCTURE_LIMIT'});
  for (const input of [{...maximalUpdate(), requestId: '\ud800'}, {...maximalUpdate(), unknown: undefined}])
    assert.throws(() => candidate.captureIntent(update, input, context));
  const value = timeline();
  value.clips = Array.from({length: 100}, (_, i) => ({...value.clips[0], id: id(100 + i), startFrame: i * 180, durationFrames: 180,
    colour: largestColour(), volumeEnvelope: volume(), opacityEnvelope: envelope(), name: '\u0001'.repeat(200)}));
  value.durationFrames = 18000;
  const before = JSON.stringify(value);
  assert.ok(Buffer.byteLength(before) > 262144);
  assert.throws(() => candidate.captureRecord(value), {code: 'OPACITY_CANDIDATE_RECORD_LIMIT'});
  assert.equal(JSON.stringify(value), before);
});

test('complete opacity record has an exact 262144-byte admission boundary', () => {
  const base = timeline();
  base.clips = Array.from({length: 100}, (_, i) => ({...base.clips[0], id: id(100 + i), startFrame: i * 180, durationFrames: 180,
    colour: largestColour(), volumeEnvelope: volume(), opacityEnvelope: envelope(), name: 'x'}));
  base.durationFrames = 18000;
  const initial = Buffer.byteLength(JSON.stringify(base));
  assert.ok(initial < 262143);
  for (const bytes of [262143, 262144, 262145]) {
    const value = structuredClone(base);
    let remaining = bytes - initial;
    for (const clip of value.clips) {
      const escaped = Math.min(199, Math.floor(remaining / 6));
      clip.name += '\u0001'.repeat(escaped); remaining -= escaped * 6;
      const plain = Math.min(200 - clip.name.length, remaining);
      clip.name += 'x'.repeat(plain); remaining -= plain;
    }
    assert.equal(remaining, 0);
    const before = JSON.stringify(value); assert.equal(Buffer.byteLength(before), bytes);
    if (bytes <= 262144) assert.equal(candidate.captureRecord(value).bytes, bytes);
    else assert.throws(() => candidate.captureRecord(value), {code: 'OPACITY_CANDIDATE_RECORD_LIMIT'});
    assert.equal(JSON.stringify(value), before);
  }
});

test('dormant imports do not broaden production wire, full record or durable task guards', () => {
  const input = maximalAdd(); input.opacityEnvelope = envelope();
  assert.equal(schemas[add].safeParse(input).success, false);
  assert.equal(schemas[update].safeParse({...maximalUpdate(), patch: {opacityEnvelope: null}}).success, false);
  const saved = timeline(); saved.clips[0].opacityEnvelope = envelope();
  assert.equal(isTimelineRecord(saved), false);
  const task = {id: id(10), projectId: input.projectId, operation: add, input, requestId: input.requestId, digest: 'a'.repeat(64), lane: 'timeline:mutation',
    status: 'prepared', revision: 1, createdAt: stamp, updatedAt: stamp, acknowledged: false, origin: 'new'};
  assert.equal(isEditTask(task), false);
});
