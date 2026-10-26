import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isTimelineRecord, TIMELINE_RESPONSE_BYTES} from '../packages/contracts/src/timeline-replacement.ts';
import {isTimelineMutationResponse, hasRequestNotAppliedProof} from '../packages/contracts/src/timeline-acknowledgement.ts';
import {VOLUME_ENVELOPE_PROFILE as profileId, splitVolumeEnvelopeFields} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {volumeEnvelopeCandidateIntentDigest} from './helpers/timeline-volume-envelope-candidate-intent.ts';
import {
  captureTimelineVolumeEnvelopeCandidateRecord as capture,
  isTimelineVolumeEnvelopeCandidateRecord as record,
  isTimelineVolumeEnvelopeCandidateSnapshot as snapshot,
  isTimelineVolumeEnvelopeCandidateMutationResponse as ack,
  isTimelineVolumeEnvelopeCandidateMutationReceipt as receipt,
} from './helpers/timeline-volume-envelope-candidate.ts';

const clone = <T>(value: T): T => structuredClone(value);
const bytes = (value: { id?: `${string}-${string}-${string}-${string}-${string}`; projectId?: unknown; revision?: number; fps?: number; width?: number; height?: number; tracks?: { id: `${string}-${string}-${string}-${string}-${string}`; name: string; kind: string; orderIndex: number; hidden: boolean; muted: boolean; }[]; clips?: { id: `${string}-${string}-${string}-${string}-${string}`; trackId: `${string}-${string}-${string}-${string}-${string}`; assetId: `${string}-${string}-${string}-${string}-${string}`; name: string; startFrame: number; durationFrames: number; sourceInFrame: number; rect: { x: number; y: number; width: number; height: number; }; gain: number; }[]; durationFrames?: number; createdAt?: string; updatedAt?: string; timeline?: unknown; volumeEnvelopeProfile?: { profileId: string; }|{ profileId: string; }; result?: unknown; operation?: string; requestId?: `${string}-${string}-${string}-${string}-${string}`; inputDigest?: string; }) => Buffer.byteLength(JSON.stringify(value));
const stamp = '2026-10-10T00:00:00.000Z';
const curve = (points: number[][]|[unknown,unknown][]|undefined = [[0, 0], [20, 1]]) => ({profileId, points: points.map(([frame, multiplier]) => ({frame, multiplier}))});
function fixture(field: {volumeEnvelope?: undefined | null | { profileId: string; points: unknown; }; versionId?: `${string}-${string}-${string}-${string}-${string}`; shotId?: `${string}-${string}-${string}-${string}-${string}`; jobId?: `${string}-${string}-${string}-${string}-${string}`;} = {}):FixtureTimeline {
  const trackId = randomUUID();
  return ({id: randomUUID(), projectId: randomUUID(), revision: 7, fps: 30, width: 720, height: 1280,
    tracks: [{id: trackId, name: 'Video 1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: [{id: randomUUID(), trackId, assetId: randomUUID(), name: 'Clip', startFrame: 0, durationFrames: 20,
      sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, ...field}],
    durationFrames: 20, createdAt: stamp, updatedAt: stamp} as unknown as FixtureTimeline);
}
const input = <P extends Record<string,unknown>=Record<never,never>>(previous: FixtureTimeline, extra: P = {} as P):P & {projectId:string;expectedRevision:number;requestId:string} => ({projectId: previous.projectId, expectedRevision: previous.revision, requestId: randomUUID(), ...extra});
const next = (previous: FixtureTimeline) => ({...(clone(previous)), revision: previous.revision + 1, updatedAt: '2026-10-10T00:00:01.000Z'});
function update(previous: FixtureTimeline, patch: { gain: number; volumeEnvelope?: undefined; durationFrames?: undefined; }|{ volumeEnvelope: null; gain?: undefined; durationFrames?: undefined; }|{ volumeEnvelope: { profileId: string; points: { frame: number; multiplier: number; }[]; }; gain?: undefined; durationFrames?: undefined; }|{ durationFrames: number; volumeEnvelope: null; gain?: undefined; }|{ durationFrames: number; volumeEnvelope: { profileId: string; points: { frame: number; multiplier: number; }[]; }; gain?: undefined; }) {
  const request = input(((previous) as unknown as Parameters<NonNullable<typeof input>>[0]), {clipId: previous.clips[0].id, patch});
  const value = next(((previous) as unknown as Parameters<typeof next>[0]));
  Object.assign((value).clips[0], clone(patch));
  value.durationFrames = Math.max(...(value).clips.map((clip) => clip.startFrame + clip.durationFrames));
  return {request, value};
}
function split(previous: FixtureTimeline, cut: number) {
  const request = input(((previous) as unknown as Parameters<NonNullable<typeof input>>[0]), {clipId: previous.clips[0].id, atFrame: previous.clips[0].startFrame + cut});
  const value = next(((previous) as unknown as Parameters<typeof next>[0])), original = previous.clips[0];
  const [leftFields, rightFields] = splitVolumeEnvelopeFields(original, cut);
  const left = {...clone(original), ...leftFields, durationFrames: cut};
  const right = {...clone(original), ...rightFields, id: randomUUID(), startFrame: request.atFrame,
    durationFrames: original.durationFrames - cut, sourceInFrame: original.sourceInFrame + cut};
  if (Object.hasOwn(original, 'fadeInFrames')) right.fadeInFrames = 0;
  if (Object.hasOwn(original, 'fadeOutFrames')) left.fadeOutFrames = 0;
  (value).clips.splice(0, 1, left, ((right) as unknown as Parameters<NonNullable<((typeof value)["clips"])["splice"]>>[3]));
  return {request, value};
}
function freeze(value: { [s: string]: unknown; }|ArrayLike<unknown>) {
  if (value && typeof value === 'object') {Object.values(value).forEach(((freeze) as unknown as (value: unknown, index: number, array: unknown[]) => void)); Object.freeze(value);}
  return value;
}

test('candidate and live complete records preserve absent/null/value without workspace authority', () => {
  for (const field of ([{}, {volumeEnvelope: null}, {volumeEnvelope: curve()}] as const)) {
    const value = fixture(field), before = JSON.stringify(value);
    freeze(((value) as unknown as Parameters<NonNullable<typeof freeze>>[0]));
    assert.equal(record(value, {projectId: value.projectId}), true);
    assert.equal(record(value, {projectId: randomUUID()}), false);
    assert.equal(record(value, {projectId: value.projectId, unknown: true}), false);
    assert.equal(isTimelineRecord(value), true);
    const detached = (capture(value) as unknown as {record:FixtureTimeline;text:string;bytes:number});
    assert.equal(detached.text, before);
    assert.equal(detached.bytes, bytes(((value) as unknown as Parameters<NonNullable<typeof bytes>>[0])));
    assert.notEqual(detached.record, value);
    assert.notEqual(detached.record.clips[0], value.clips[0]);
    assert.equal(Object.hasOwn(detached.record.clips[0], 'volumeEnvelope'), Object.hasOwn(field, 'volumeEnvelope'));
    if (field.volumeEnvelope) {
      detached.record.clips[0].volumeEnvelope!.points[0].multiplier = 1;
      assert.equal((value.clips[0].volumeEnvelope)!.points[0].multiplier, 0);
    }
    assert.equal(JSON.stringify(value), before);
  }
  const manifest = JSON.parse(((readFileSync(new URL('../packages/contracts/package.json', import.meta.url))) as unknown as Parameters<typeof JSON.parse>[0]));
  assert.ok(!JSON.stringify(manifest.exports).includes('timeline-volume-envelope-candidate'));
});

test('candidate envelope validation rejects undefined, unknown profiles, extra keys and out-of-duration points', () => {
  for (const invalid of ([undefined, [], {}, {...curve(), profileId: 'future'}, {...curve(), extra: 1},
    curve([[20, 1], [0, 0]]), curve([[21, 0.5]]), curve([[0, -0]]), curve([[0, NaN]]),
    curve(Array.from({length: 17}, (_, i) => [i, 1]))] as const)) {
    assert.equal(record(fixture({volumeEnvelope: ((invalid) as unknown as { profileId: string; points: unknown; } | null | undefined)})), false);
  }
  const value = fixture({volumeEnvelope: curve()});
  (value.clips[0] as unknown as {extra:(true)|(never[])}).extra = true;
  assert.equal(record(value), false, 'legacy extra-field refusal is retained after projection');
  assert.equal(record(fixture((({name: '\ud800'}) as unknown as Parameters<NonNullable<typeof fixture>>[0]))), false, 'candidate text requires well-formed Unicode');
});

test('strict typed traversal rejects getters, proxies, symbols, nonenumerable properties and exotic arrays without executing them', () => {
  let effects = 0;
  const hostile = (target: object) => new Proxy(target, {
    get() {effects++; throw Error('get trap');}, ownKeys() {effects++; throw Error('keys trap');},
    getPrototypeOf() {effects++; throw Error('prototype trap');}, getOwnPropertyDescriptor() {effects++; throw Error('descriptor trap');},
  });
  const changes = [
(    value?: unknown) => hostile(((value) as unknown as Parameters<typeof hostile>[0])),
(    value: { clips: unknown; }) => {value.clips = hostile(((value.clips) as unknown as Parameters<typeof hostile>[0])); return value;},
(    value: { clips: unknown[]; }) => {value.clips[0] = hostile(((value.clips[0]) as unknown as Parameters<typeof hostile>[0])); return value;},
(    value: { clips: { volumeEnvelope: unknown; }[]; }) => {value.clips[0].volumeEnvelope = hostile(((value.clips[0].volumeEnvelope) as unknown as Parameters<typeof hostile>[0])); return value;},
(    value: { clips: { volumeEnvelope: { points: unknown; }; }[]; }) => {value.clips[0].volumeEnvelope.points = hostile(((value.clips[0].volumeEnvelope.points) as unknown as Parameters<typeof hostile>[0])); return value;},
(    value: { clips: { volumeEnvelope: { points: unknown[]; }; }[]; }) => {value.clips[0].volumeEnvelope.points[0] = hostile(((value.clips[0].volumeEnvelope.points[0]) as unknown as Parameters<typeof hostile>[0])); return value;},
(    value: { clips: unknown[]; }) => {Object.defineProperty(value.clips[0], 'volumeEnvelope', {enumerable: true, get() {effects++; throw Error('getter');}}); return value;},
(    value: { clips: { volumeEnvelope: { points: unknown; }; }[]; }) => {Object.defineProperty(value.clips[0].volumeEnvelope.points, '0', {enumerable: true, get() {effects++; throw Error('index getter');}}); return value;},
(    value: { clips: unknown[]; }) => {Object.defineProperty(value.clips[0], 'name', {enumerable: false, value: 'Clip'}); return value;},
(    value: { clips: { [x: string]: number; }[]; }) => {value.clips[0][(Symbol('hidden') as unknown as keyof ((typeof value)["clips"])[number])] = 1; return value;},
(    value: { clips: { volumeEnvelope: { points: unknown[]; }; }[]; }) => {delete value.clips[0].volumeEnvelope.points[0]; return value;},
(    value: { clips: { volumeEnvelope: { points: { extra: boolean; }; }; }[]; }) => {value.clips[0].volumeEnvelope.points.extra = true; return value;},
(    value: { clips: string|unknown[]; }) => {(value.clips as {length: number}).length = 100000000; return value;},
(    value: { clips: { volumeEnvelope: { points: unknown; }; }[]; }) => {Object.setPrototypeOf(value.clips[0].volumeEnvelope.points, class OddArray extends Array {}.prototype); return value;},
(    value: { clips: { rect: never[]; }[]; }) => {value.clips[0].rect = []; return value;},
(    value: { clips: { colour: { source: never[]; }; }[]; }) => {value.clips[0].colour = {source: []}; return value;},
(    value: { tracks: { name: never[]; }[]; }) => {value.tracks[0].name = []; return value;},
(    value: { extra: never[]; }) => {value.extra = []; return value;},
(    value: { clips: { volumeEnvelope: { points: { multiplier: number[]; }[]; }; }[]; }) => {value.clips[0].volumeEnvelope.points[0].multiplier = [0]; return value;},
  ];
  for (const change of changes) assert.equal(record((change as (value:unknown)=>unknown)(((((fixture({volumeEnvelope: curve()})) as unknown as Parameters<typeof change>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof change>>[0]>))), false);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(record(revoked.proxy), false);
  assert.equal(snapshot(hostile({timeline: fixture()})), false);
  assert.equal(snapshot({timeline: fixture({volumeEnvelope: curve()}), volumeEnvelopeProfile: hostile({profileId})}), false);
  const previous = fixture(), {request, value} = update(((previous) as unknown as Parameters<NonNullable<typeof update>>[0]), {gain: 0.5});
  assert.equal(ack('timeline.clip.update', hostile(((request) as unknown as Parameters<NonNullable<typeof hostile>>[0])), value, {previous}), false);
  assert.equal(ack('timeline.clip.update', request, value, hostile({previous}) as unknown as Parameters<typeof ack>[3]), false);
  assert.equal(effects, 0, 'not one accessor or proxy trap may execute');
});

test('standalone candidate snapshot has exact conditional profile presence and is not a production render shape', () => {
  for (const field of ([{}, {volumeEnvelope: null}] as const)) {
    const timeline = fixture(field);
    assert.equal(snapshot({timeline}), true);
    assert.equal(snapshot({timeline, volumeEnvelopeProfile: {profileId}}), false);
    assert.equal(snapshot({timeline, volumeEnvelopeProfile: undefined}), false);
  }
  const timeline = fixture({volumeEnvelope: curve()});
  const correct = {timeline, volumeEnvelopeProfile: {profileId}};
  freeze(correct);
  assert.equal(snapshot(correct), true);
  for (const invalid of ([{timeline}, {...correct, assets: []}, {...correct, volumeEnvelopeProfile: null},
    {...correct, volumeEnvelopeProfile: profileId}, {...correct, volumeEnvelopeProfile: {profileId: 'future'}},
    {...correct, volumeEnvelopeProfile: {profileId, extra: true}}] as const)) assert.equal(snapshot(invalid), false);
});

test('add ACK matches the newly added clip, exact field presence and every untouched previous clip', () => {
  for (const field of ([{}, {volumeEnvelope: null}, {volumeEnvelope: curve()}] as const)) {
    const previous = fixture({volumeEnvelope: curve([[0, 0.5]])});
    const request = input(((previous) as unknown as Parameters<NonNullable<typeof input>>[0]), {assetId: randomUUID(), trackId: previous.tracks[0].id, startFrame: 20, durationFrames: 20, ...field});
    const value = next(((previous) as unknown as Parameters<NonNullable<typeof next>>[0]));
    (value).clips.push((({...(clone(previous.clips[0])), id: randomUUID(), assetId: request.assetId, startFrame: 20, ...field}) as unknown as Parameters<NonNullable<((typeof value)["clips"])["push"]>>[0]));
    delete (value).clips[1].volumeEnvelope;
    Object.assign((value).clips[1], clone(field));
    value.durationFrames = 40;
    const before = JSON.stringify({previous, request, value});
    assert.equal(ack('timeline.clip.add', request, value, {previous}), true);
    assert.equal(JSON.stringify({previous, request, value}), before);
    assert.equal(ack('timeline.clip.add', {...request, assetId: randomUUID()}, value, {previous}), false);
    const altered = clone(value); (altered).clips[0].volumeEnvelope = null;
    assert.equal(ack('timeline.clip.add', request, altered, {previous}), false);
    const changedPresence = clone(value);
    if (Object.hasOwn(field, 'volumeEnvelope')) delete (changedPresence).clips[1].volumeEnvelope;
    else (changedPresence).clips[1].volumeEnvelope = null;
    assert.equal(ack('timeline.clip.add', request, changedPresence, {previous}), false);
    assert.equal(ack('timeline.clip.add', request, value), false);
  }
});

test('update ACK binds exact envelope payload, untouched clips and shrink replacement semantics', () => {
  const previous = fixture({volumeEnvelope: curve()});
  previous.clips.push((({...(clone(previous.clips[0])), id: randomUUID(), startFrame: 20, volumeEnvelope: null}) as unknown as Parameters<typeof previous.clips.push>[0]));
  previous.durationFrames = 40;
  for (const patch of ([{gain: 0.5}, {volumeEnvelope: null}, {volumeEnvelope: curve([[10, 0.25]])},
    {durationFrames: 10, volumeEnvelope: null}, {durationFrames: 10, volumeEnvelope: curve([[10, 0.5]])}] as const)) {
    const {request, value} = update(((previous) as unknown as Parameters<NonNullable<typeof update>>[0]), ((patch) as unknown as Parameters<typeof update>[1]));
    assert.equal(ack('timeline.clip.update', request, value, {previous}), true);
    const wrong = clone(value); delete (wrong).clips[1].volumeEnvelope;
    assert.equal(ack('timeline.clip.update', request, wrong, {previous}), false);
    assert.equal(ack('timeline.clip.update', {...request, patch: {...patch, volumeEnvelope: curve([[0, 0.75]])}}, value, {previous}), false);
    assert.equal(ack('timeline.clip.update', request, value, {previous: {...previous, revision: previous.revision - 1}}), false);
  }
  const shrunk = update(((previous) as unknown as Parameters<NonNullable<typeof update>>[0]), (({durationFrames: 10}) as unknown as Parameters<typeof update>[1]));
  assert.equal(ack('timeline.clip.update', shrunk.request, shrunk.value, {previous}), false);
  const wrongIdentity = update(((previous) as unknown as Parameters<NonNullable<typeof update>>[0]), {gain: 0.5}); (wrongIdentity.value as unknown as {id:(`${string}-${string}-${string}-${string}-${string}`)}).id = randomUUID();
  assert.equal(ack('timeline.clip.update', wrongIdentity.request, wrongIdentity.value, {previous}), false);
});

test('replacement ACK preserves the exact envelope and every non-source field', () => {
  for (const field of ([{}, {volumeEnvelope: null}, {volumeEnvelope: curve()}] as const)) {
    const previous = fixture({...field, versionId: randomUUID(), shotId: randomUUID(), jobId: randomUUID()});
    const request = input(((previous) as unknown as Parameters<NonNullable<typeof input>>[0]), {clipId: previous.clips[0].id, assetId: randomUUID()});
    const value = next(((previous) as unknown as Parameters<NonNullable<typeof next>>[0])), clip = (value).clips[0];
    clip.assetId = request.assetId;
    for (const key of (['versionId', 'shotId', 'jobId'] as const)) delete clip[key];
    assert.equal(ack('timeline.clip.replaceSource', request, value, {previous}), true);
    const wrong = clone(value);
    if (Object.hasOwn(field, 'volumeEnvelope')) delete (wrong).clips[0].volumeEnvelope;
    else (wrong).clips[0].volumeEnvelope = null;
    assert.equal(ack('timeline.clip.replaceSource', request, wrong, {previous}), false);
    const changed = clone(value); (changed).clips[0].gain = 0.5;
    assert.equal(ack('timeline.clip.replaceSource', request, changed, {previous}), false);
    const versioned = clone(value), versionRequest = {...request, versionId: randomUUID()};
    Object.assign((versioned).clips[0], {versionId: versionRequest.versionId, shotId: randomUUID()});
    assert.equal(ack('timeline.clip.replaceSource', versionRequest, versioned, {previous}), true);
  }
});

test('split ACK checks all interior cuts, absent/null/held/ramps/max points and existing fade restrictions', () => {
  const fields = [{}, {volumeEnvelope: null}, {volumeEnvelope: curve()}, {volumeEnvelope: curve([[5, 0.25]])},
    {volumeEnvelope: curve([[5, 0.25], [15, 0.75]])},
    {volumeEnvelope: curve(Array.from({length: 16}, (_, i) => [i + 2, (i % 3) / 2]))}];
  for (const field of fields) for (let cut = 1; cut < 20; cut++) {
    const previous = fixture(field), {request, value} = split(((previous) as unknown as Parameters<NonNullable<typeof split>>[0]), cut);
    assert.equal(ack('timeline.clip.split', request, value, {previous}), true, `cut ${cut}`);
    const wrong = clone(value);
    (wrong).clips[1].durationFrames--;
    wrong.durationFrames--;
    assert.equal(ack('timeline.clip.split', request, wrong, {previous}), false);
    const presence = clone(value);
    if (Object.hasOwn((presence).clips[1], 'volumeEnvelope')) delete (presence).clips[1].volumeEnvelope;
    else (presence).clips[1].volumeEnvelope = null;
    assert.equal(ack('timeline.clip.split', request, presence, {previous}), false);
  }
  const previous = fixture((({volumeEnvelope: curve(), fadeInFrames: 5, fadeOutFrames: 5}) as unknown as Parameters<NonNullable<typeof fixture>>[0]));
  for (const cut of ([5, 10, 15] as const)) {
    const {request, value} = split(((previous) as unknown as Parameters<NonNullable<typeof split>>[0]), cut);
    assert.equal(ack('timeline.clip.split', request, value, {previous}), true);
  }
  // Keep a complete valid result while changing the requested cut into a fade.
  const {request, value} = split(((previous) as unknown as Parameters<NonNullable<typeof split>>[0]), 5);
  assert.equal(ack('timeline.clip.split', {...request, atFrame: 4}, value, {previous}), false);
});

test('Undo/redo require exact expected history; immutable original ACK remains valid after later Undo', () => {
  const previous = fixture({volumeEnvelope: curve()}), changed = update(((previous) as unknown as Parameters<NonNullable<typeof update>>[0]), {volumeEnvelope: null});
  assert.equal(ack('timeline.clip.update', changed.request, changed.value, {previous}), true);
  const undoInput = input(((changed.value) as unknown as Parameters<NonNullable<typeof input>>[0])), restored = {...(clone(previous)), revision: changed.value.revision + 1};
  assert.equal(ack('timeline.undo', undoInput, restored, {previous: changed.value, expectedHistory: previous}), true);
  assert.equal(ack('timeline.undo', undoInput, restored, {previous: changed.value}), false);
  const wrongHistory = clone(previous); delete wrongHistory.clips[0].volumeEnvelope;
  assert.equal(ack('timeline.undo', undoInput, restored, {previous: changed.value, expectedHistory: wrongHistory}), false);
  assert.equal(ack('timeline.clip.update', changed.request, changed.value, {previous}), true, 'original evidence is independent of current state');
  assert.equal(ack('timeline.clip.update', changed.request, changed.value, {previous: restored}), false, 'current state is not original pre-mutation evidence');
  const redone = {...clone(changed.value), revision: restored.revision + 1};
  assert.equal(ack('timeline.redo', input(((restored) as unknown as Parameters<NonNullable<typeof input>>[0])), redone, {previous: restored, expectedHistory: changed.value}), true);
  assert.equal(ack('timeline.render', input(((previous) as unknown as Parameters<NonNullable<typeof input>>[0])), changed.value, {previous}), false);
});

function crowded() {
  const value = fixture();
  value.tracks = Array.from({length: 12}, (_, index) => ({id: randomUUID(), name: '\u0001'.repeat(150), kind: 'video', orderIndex: index, hidden: false, muted: false}));
  const colour = {profileId: 'mioon-rec709-sdr-clip-v1',
    source: {assetSha256: 'a'.repeat(64), streamIndex: 0, profileId: 'rec709-yuv-sdr-v1', range: 'limited', declaredBy: 'user', declaredAt: stamp},
    look: {resourceId: randomUUID(), resourceSha256: 'b'.repeat(64), resourceProfile: 'mioon-cube3d-normalized-tetrahedral-v1', purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: true, strength: 0.12345678901234568}};
  const base = value.clips[0];
  value.clips = (Array.from({length: 100}, (_, index) => ({...(clone(base)), id: randomUUID(), trackId: value.tracks[index % 12].id,
    name: '\u0001'.repeat(200), startFrame: Math.floor(index / 12) * 30, durationFrames: 30,
    versionId: randomUUID(), shotId: randomUUID(), jobId: randomUUID(), fadeInFrames: 0, fadeOutFrames: 0,
    colour: clone(colour), volumeEnvelope: curve(Array.from({length: 16}, (_, i) => [i, 0.0000010000000000000002]))})) as unknown as (typeof value)["clips"]);
  value.durationFrames = 270;
  return value;
}
function tune(value: FixtureTimeline, target: number) {
  let excess = bytes(((value) as unknown as Parameters<typeof bytes>[0])) - target;
  assert.ok(excess > 0);
  for (const clip of value.clips) {
    const replace = Math.min(Math.floor(excess / 5), (clip.name)!.length);
    clip.name = 'x'.repeat(replace) + (clip.name)!.slice(replace);
    excess -= replace * 5;
    if (excess < 5) break;
  }
  if (excess) {
    const clip = value.clips.find(((clip) => (clip.name)!.startsWith('x'.repeat(excess)) && (clip.name)!.length > excess));
    assert.ok(clip); (clip as unknown as {name:(never[])|(string)}).name = (clip as unknown as {name:(never[])|(string)}).name.slice(excess);
  }
  assert.equal(bytes(((value) as unknown as Parameters<typeof bytes>[0])), target);
  return value;
}

test('100 complete envelope clips serialize exactly on both sides of unchanged 256 KiB cap; rejection is pure, not a transaction proof', () => {
  assert.equal(TIMELINE_RESPONSE_BYTES, 256 * 1024);
  const source = crowded();
  assert.ok(bytes(((source) as unknown as Parameters<NonNullable<typeof bytes>>[0])) > TIMELINE_RESPONSE_BYTES);
  for (const size of ([TIMELINE_RESPONSE_BYTES - 1, TIMELINE_RESPONSE_BYTES, TIMELINE_RESPONSE_BYTES + 1] as const)) {
    const value = tune(((clone(source)) as unknown as Parameters<typeof tune>[0]), size), before = JSON.stringify(value);
    freeze(((value) as unknown as Parameters<NonNullable<typeof freeze>>[0]));
    assert.equal(record(value), size <= TIMELINE_RESPONSE_BYTES);
    if (size <= TIMELINE_RESPONSE_BYTES) assert.equal((capture(value) as unknown as {record:FixtureTimeline;text:string;bytes:number}).bytes, size);
    else assert.throws(() => (capture(value) as unknown as {record:FixtureTimeline;text:string;bytes:number}), error => {
      assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code, 'VOLUME_ENVELOPE_CANDIDATE_AGGREGATE_BUDGET');
      assert.deepEqual((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details, {bytes: size, maxBytes: TIMELINE_RESPONSE_BYTES});
      assert.equal(((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.mutationOutcome, undefined);
      assert.equal(hasRequestNotAppliedProof(error, input(((value) as unknown as Parameters<NonNullable<typeof input>>[0])), {operation: 'timeline.clip.update'}), false);
      return true;
    });
    assert.equal(JSON.stringify(value), before, 'input objects remain unchanged; no persistence boundary is exercised');
  }
  const previous = tune(((clone(source)) as unknown as Parameters<typeof tune>[0]), TIMELINE_RESPONSE_BYTES), request = input(((previous) as unknown as Parameters<NonNullable<typeof input>>[0]), {clipId: previous.clips[0].id, patch: {name: '\u0001'.repeat(200)}});
  const value = next(((previous) as unknown as Parameters<typeof next>[0])); (value).clips[0].name = request.patch.name;
  assert.ok(bytes(((value) as unknown as Parameters<NonNullable<typeof bytes>>[0])) > TIMELINE_RESPONSE_BYTES);
  assert.equal(ack('timeline.clip.update', request, value, {previous}), false);
});

test('candidate and live ACK value validation never establishes workspace admission', () => {
  const previous = fixture(), {request, value} = update(((previous) as unknown as Parameters<NonNullable<typeof update>>[0]), {volumeEnvelope: null});
  assert.equal(ack('timeline.clip.update', request, value, {previous}), true);
  assert.equal(isTimelineMutationResponse('timeline.clip.update', request, value), true);
});

test('separate dormant receipt binds exact operation, project, requestId and full input digest without claiming provenance', () => {
  const previous = fixture(), {request, value} = update(((previous) as unknown as Parameters<NonNullable<typeof update>>[0]), {volumeEnvelope: null});
  const operation = 'timeline.clip.update';
  const evidence = {operation, projectId: request.projectId, requestId: request.requestId,
    inputDigest: (volumeEnvelopeCandidateIntentDigest as (...args:Partial<Parameters<typeof volumeEnvelopeCandidateIntentDigest>>)=>ReturnType<typeof volumeEnvelopeCandidateIntentDigest>)(operation, request), result: value};
  assert.equal(receipt(operation, request, evidence, {previous}), true);
  for (const key of Object.keys(evidence)) {
    const missing = {...evidence}; delete missing[(key as keyof typeof missing)];
    assert.equal(receipt(operation, request, missing, {previous}), false, `missing ${key}`);
  }
  for (const changed of ([{operation: 'timeline.clip.add'}, {projectId: randomUUID()}, {requestId: randomUUID()}, {inputDigest: '0'.repeat(64)}, {extra: true}] as const))
    assert.equal(receipt(operation, request, {...evidence, ...changed}, {previous}), false);
  const newRequest = {...request, requestId: randomUUID()};
  assert.equal(ack(operation, newRequest, value, {previous}), true, 'a bare timeline cannot reveal its requestId');
  assert.equal(receipt(operation, newRequest, evidence, {previous}), false, 'receipt binds the original valid requestId');
  assert.equal(receipt(operation, {...request, patch: {volumeEnvelope: curve()}}, evidence, {previous}), false);
  const original = JSON.stringify(evidence); freeze(evidence);
  assert.equal(receipt(operation, request, evidence, {previous}), true);
  assert.equal(JSON.stringify(evidence), original);
  const empty = fixture(); empty.clips = []; empty.durationFrames = 0;
  const addition = fixture({volumeEnvelope: curve()});
  Object.assign(addition, {id: empty.id, projectId: empty.projectId, revision: empty.revision + 1, tracks: clone(empty.tracks)});
  addition.clips[0].trackId = empty.tracks[0].id;
  const addInput = input(((empty) as unknown as Parameters<NonNullable<typeof input>>[0]), {assetId: addition.clips[0].assetId, trackId: empty.tracks[0].id, startFrame: 0, durationFrames: 20, volumeEnvelope: curve()});
  const addEvidence = {operation: 'timeline.clip.add', projectId: addInput.projectId, requestId: addInput.requestId,
    inputDigest: (volumeEnvelopeCandidateIntentDigest as (...args:Partial<Parameters<typeof volumeEnvelopeCandidateIntentDigest>>)=>ReturnType<typeof volumeEnvelopeCandidateIntentDigest>)('timeline.clip.add', addInput), result: addition};
  assert.equal(receipt('timeline.clip.add', addInput, addEvidence, {previous: empty}), true);
});

test('snapshot and receipt complete wrappers, not just inner timelines, obey unchanged 256 KiB cap', () => {
  const source = crowded(), operation = 'timeline.clip.update';
  const request = input(((source) as unknown as Parameters<NonNullable<typeof input>>[0]), {clipId: source.clips[0].id, patch: {gain: 1}});
  const shell = {operation, projectId: request.projectId, requestId: request.requestId,
    inputDigest: (volumeEnvelopeCandidateIntentDigest as (...args:Partial<Parameters<typeof volumeEnvelopeCandidateIntentDigest>>)=>ReturnType<typeof volumeEnvelopeCandidateIntentDigest>)(operation, request)};
  const snapshotOverhead = bytes({timeline: source, volumeEnvelopeProfile: {profileId}}) - bytes(((source) as unknown as Parameters<NonNullable<typeof bytes>>[0]));
  const receiptOverhead = bytes((({...shell, result: source}) as unknown as Parameters<NonNullable<typeof bytes>>[0])) - bytes(((source) as unknown as Parameters<NonNullable<typeof bytes>>[0]));
  assert.ok(snapshotOverhead > 0 && receiptOverhead > 0);
  assert.equal(snapshot({timeline: tune(((clone(source)) as unknown as Parameters<typeof tune>[0]), TIMELINE_RESPONSE_BYTES), volumeEnvelopeProfile: {profileId}}), false);
  for (const size of ([TIMELINE_RESPONSE_BYTES - 1, TIMELINE_RESPONSE_BYTES, TIMELINE_RESPONSE_BYTES + 1] as const)) {
    const timeline = tune(((clone(source)) as unknown as Parameters<typeof tune>[0]), size - snapshotOverhead);
    const snapshotEvidence = {timeline, volumeEnvelopeProfile: {profileId}};
    assert.equal(bytes(snapshotEvidence), size);
    assert.equal(snapshot(snapshotEvidence), size <= TIMELINE_RESPONSE_BYTES);
    const previous = tune(((clone(source)) as unknown as Parameters<typeof tune>[0]), size - receiptOverhead), result = next(((previous) as unknown as Parameters<typeof next>[0]));
    const receiptEvidence = {...shell, result};
    assert.equal(bytes(((receiptEvidence) as unknown as Parameters<NonNullable<typeof bytes>>[0])), size);
    assert.equal(receipt(operation, request, receiptEvidence, {previous}), size <= TIMELINE_RESPONSE_BYTES);
  }
});

test('receipt wrapper rejects hostile binding/context fields without executing code', () => {
  const previous = fixture(), {request, value} = update(((previous) as unknown as Parameters<NonNullable<typeof update>>[0]), {volumeEnvelope: null});
  const operation = 'timeline.clip.update';
  const evidence = {operation, projectId: request.projectId, requestId: request.requestId,
    inputDigest: (volumeEnvelopeCandidateIntentDigest as (...args:Partial<Parameters<typeof volumeEnvelopeCandidateIntentDigest>>)=>ReturnType<typeof volumeEnvelopeCandidateIntentDigest>)(operation, request), result: value};
  let calls = 0;
  const trap = () => { calls++; throw Error('must not execute'); };
  const proxy = (value: object) => new Proxy(value, {get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap});
  assert.equal(receipt(operation, request, proxy(((evidence) as unknown as Parameters<NonNullable<typeof proxy>>[0])), {previous}), false);
  for (const key of (['result', 'requestId'] as const)) {
    const hostile = {...evidence};
    Object.defineProperty(hostile, key, {enumerable: true, get: trap});
    assert.equal(receipt(operation, request, hostile, {previous}), false);
  }
  assert.equal(receipt(operation, request, {...evidence, inputDigest: proxy({})}, {previous}), false);
  assert.equal(receipt(operation, request, evidence, proxy({previous}) as unknown as Parameters<typeof receipt>[3]), false);
  assert.equal(calls, 0);
});
