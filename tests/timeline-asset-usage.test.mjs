import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deriveTimelineAssetUsage, retainTimelineAssetUsage } from '../apps/web/src/timeline-asset-usage.ts';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), firstAssetId = id(3), unusedAssetId = id(4);
const firstTrackId = id(5), secondTrackId = id(6), firstClipId = id(7);
const asset = (assetId = firstAssetId) => ({ id: assetId, projectId, name: 'Source', mimeType: 'video/mp4', sha256: 'a'.repeat(64) });
const track = (trackId = firstTrackId, orderIndex = 0) => ({ id: trackId, name: `Track ${orderIndex}`, orderIndex, kind: 'video', hidden: false, muted: false });
const clip = (clipId = firstClipId, fields = {}) => ({ id: clipId, assetId: firstAssetId, trackId: firstTrackId, name: 'Saved clip', startFrame: 0, durationFrames: 30, sourceInFrame: 15,
  rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1, ...fields });
function fixture() {
  return { projectId, ready: true, assets: [asset(), asset(unusedAssetId)], timeline: {
    id: timelineId, projectId, revision: 9, tracks: [track()], clips: [clip()], durationFrames: 30,
    fps: 30, width: 720, height: 1280, createdAt: '2026-10-12T12:00:00.000Z', updatedAt: '2026-10-12T12:00:00.000Z',
  } };
}
function assertUnknown(input) {
  assert.deepEqual(deriveTimelineAssetUsage(input), { status: 'unknown', projectId: input.projectId, timelineId: null, timelineRevision: null, usesByAssetId: {} });
}
function freeze(value) {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('saved snapshot gives exact copied usage provenance and known unused entries', () => {
  const input = fixture(), result = deriveTimelineAssetUsage(input);
  assert.equal(result.status, 'ready');
  assert.equal(result.projectId, projectId); assert.equal(result.timelineId, timelineId); assert.equal(result.timelineRevision, 9);
  assert.equal(typeof result.usesByAssetId[firstAssetId][0].sourceIdentity, 'string');
  const { sourceIdentity, ...use } = result.usesByAssetId[firstAssetId][0];
  assert.ok(sourceIdentity.length > 0);
  assert.deepEqual(use, { projectId, timelineId, timelineRevision: 9, assetId: firstAssetId,
    clipId: firstClipId, trackId: firstTrackId, clipName: 'Saved clip', trackName: 'Track 0', startFrame: 0, durationFrames: 30, sourceInFrame: 15 });
  assert.deepEqual(result.usesByAssetId[unusedAssetId], []);
  assert.equal(Object.hasOwn(result.usesByAssetId, id(100)), false, 'unloaded asset IDs are never asserted to have zero use');
});

test('complete empty saved timeline is known zero, including an empty asset list', () => {
  const input = fixture(); input.timeline.clips = []; input.timeline.durationFrames = 0;
  let result = deriveTimelineAssetUsage(input);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.usesByAssetId[firstAssetId], []);
  assert.strictEqual(result.usesByAssetId[firstAssetId], result.usesByAssetId[unusedAssetId], 'known-zero arrays are stable immutable values');
  input.assets = []; result = deriveTimelineAssetUsage(input);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.usesByAssetId, {});
});

test('missing, loading or foreign snapshots are unknown rather than zero', () => {
  for (const patch of [{ ready: false }, { ready: 'true' }, { projectId: '' }, { projectId: 'not-a-uuid' },
    { timeline: null }, { timeline: undefined }, { timeline: [] }, { timeline: {} },
    { assets: null }, { assets: undefined }, { assets: {} }, { projectId: id(99) }]) assertUnknown({ ...fixture(), ...patch });
});

test('multiple tracks and uses sort by saved track order, then clip start and stable IDs', () => {
  const input = fixture();
  input.timeline.tracks = [track(secondTrackId, 1), track()];
  input.timeline.clips = [clip(id(11), { trackId: secondTrackId, startFrame: 10 }), clip(id(10), { startFrame: 40 }), clip()];
  input.timeline.durationFrames = 70;
  const result = deriveTimelineAssetUsage(input);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.usesByAssetId[firstAssetId].map(use => use.clipId), [firstClipId, id(10), id(11)]);
  input.timeline.tracks.reverse(); input.timeline.clips.reverse();
  assert.deepEqual(deriveTimelineAssetUsage(input), result, 'input array order does not change use ordering');
  input.timeline.tracks[1].orderIndex = 0;
  assert.deepEqual(deriveTimelineAssetUsage(input).usesByAssetId[firstAssetId].map(use => use.clipId), [firstClipId, id(10), id(11)], 'track ID breaks equal-order ties');
});

test('all saved uses count, including hidden or muted tracks and silent clips', () => {
  const input = fixture(); input.timeline.tracks[0].hidden = true; input.timeline.tracks[0].muted = true; input.timeline.clips[0].gain = 0;
  const result = deriveTimelineAssetUsage(input);
  assert.equal(result.status, 'ready'); assert.equal(result.usesByAssetId[firstAssetId].length, 1);
});

test('duplicate IDs anywhere in required collections make the entire result unknown', () => {
  for (const collection of ['assets', 'tracks', 'clips']) {
    const input = fixture(), items = collection === 'assets' ? input.assets : input.timeline[collection];
    items.push(structuredClone(items[0])); assertUnknown(input);
  }
});

test('foreign asset ownership, unresolved clips and explicit foreign owners cannot become known zero', () => {
  const mutations = [
    input => { input.assets[0].projectId = id(99); },
    input => { input.assets[1].projectId = id(99); },
    input => { input.timeline.projectId = id(99); },
    input => { input.timeline.clips[0].assetId = id(99); },
    input => { input.timeline.clips[0].trackId = id(99); },
    input => { input.assets = []; },
    input => { input.timeline.clips[0].projectId = id(99); },
    input => { input.timeline.clips[0].timelineId = id(99); },
    input => { input.timeline.tracks[0].projectId = id(99); },
    input => { input.timeline.tracks[0].timelineId = id(99); },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assertUnknown(input); }
});

test('partial own metadata and sparse or malformed collections are unknown', () => {
  for (const field of ['id', 'projectId', 'revision', 'tracks', 'clips', 'durationFrames']) {
    const input = fixture(); delete input.timeline[field]; assertUnknown(input);
  }
  for (const field of ['id', 'projectId']) {
    const input = fixture(); delete input.assets[1][field]; assertUnknown(input);
  }
  for (const field of ['id', 'name', 'orderIndex']) {
    const input = fixture(); delete input.timeline.tracks[0][field]; assertUnknown(input);
  }
  for (const field of ['id', 'assetId', 'trackId', 'startFrame', 'durationFrames', 'sourceInFrame']) {
    const input = fixture(); delete input.timeline.clips[0][field]; assertUnknown(input);
  }
  for (const collection of ['assets', 'tracks', 'clips']) {
    for (const bad of [null, [], 12, 'bad']) {
      const input = fixture(), owner = collection === 'assets' ? input : input.timeline;
      owner[collection] = [bad]; assertUnknown(input);
    }
    const input = fixture(), owner = collection === 'assets' ? input : input.timeline;
    owner[collection] = new Array(1); assertUnknown(input);
  }
  const input = fixture(); input.timeline.clips[0] = Object.create(input.timeline.clips[0]); assertUnknown(input);
});

test('invalid revision, track position, names and UUIDs are unknown', () => {
  for (const revision of [0, -1, 1.5, '9', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const input = fixture(); input.timeline.revision = revision; assertUnknown(input);
  }
  for (const orderIndex of [-1, 12, 0.5, '0', NaN]) {
    const input = fixture(); input.timeline.tracks[0].orderIndex = orderIndex; assertUnknown(input);
  }
  for (const [collection, max] of [['tracks', 150], ['clips', 200]]) {
    for (const name of ['', null, undefined, 12, 'x'.repeat(max + 1)]) {
      const input = fixture(); input.timeline[collection][0].name = name; assertUnknown(input);
    }
  }
  for (const field of ['id', 'assetId', 'trackId']) {
    const input = fixture(); input.timeline.clips[0][field] = '__proto__'; assertUnknown(input);
  }
});

test('unsafe, negative, fractional or overflowing frame metadata remains unknown', () => {
  for (const [field, values] of [
    ['startFrame', [-1, 0.1, '0', NaN, Infinity, 18000]],
    ['durationFrames', [0, -1, 0.1, '30', NaN, Infinity, 18001]],
    ['sourceInFrame', [-1, 0.1, '15', NaN, Infinity, Number.MAX_SAFE_INTEGER - 17999]],
  ]) for (const value of values) { const input = fixture(); input.timeline.clips[0][field] = value; assertUnknown(input); }
  for (const duration of [-1, 0, 29, 31, 18001, '30']) {
    const input = fixture(); input.timeline.durationFrames = duration; assertUnknown(input);
  }
});

test('inconsistent aggregate duration or overlapping saved intervals are unknown', () => {
  const input = fixture(); input.timeline.clips.push(clip(id(9), { startFrame: 15 })); input.timeline.durationFrames = 45;
  assertUnknown(input);
  input.timeline.clips[1].startFrame = 30; input.timeline.durationFrames = 60;
  assert.equal(deriveTimelineAssetUsage(input).status, 'ready', 'adjacent intervals are valid');
  input.timeline.clips = []; assertUnknown(input);
});

test('current exact timeline limits pass, while oversized tracks or clips are rejected before traversal', () => {
  const input = fixture(); input.timeline.tracks = Array.from({ length: 12 }, (_, index) => track(id(100 + index), index));
  input.timeline.clips = Array.from({ length: 100 }, (_, index) => clip(id(200 + index), { trackId: id(100), startFrame: index * 180, durationFrames: 180 }));
  input.timeline.durationFrames = 18000;
  assert.equal(deriveTimelineAssetUsage(input).status, 'ready');
  input.timeline.clips.push(clip(id(400))); assertUnknown(input);
  input.timeline.clips.pop(); input.timeline.tracks.push(track(id(401), 0)); assertUnknown(input);
  input.timeline.tracks = []; assertUnknown(input);
});

test('asset libraries are not incorrectly capped at timeline or disposition batch limits', () => {
  const input = fixture(); input.assets.push(...Array.from({ length: 1001 }, (_, index) => asset(id(1000 + index))));
  const result = deriveTimelineAssetUsage(input);
  assert.equal(result.status, 'ready'); assert.equal(Object.keys(result.usesByAssetId).length, 1003);
  assert.deepEqual(result.usesByAssetId[id(2000)], []);
});

test('codec and unrelated render metadata are not usage prerequisites or consulted', () => {
  const input = fixture(); input.assets[0].mimeType = 'video/unknown-future-codec';
  Object.defineProperty(input.assets[0], 'codec', { get() { throw Error('Must not inspect codec'); } });
  Object.defineProperty(input.timeline.clips[0], 'effects', { get() { throw Error('Must not inspect render effects'); } });
  assert.equal(deriveTimelineAssetUsage(input).status, 'ready');
});

test('same-revision source, clip provenance and track changes alter the immutable local identity', () => {
  const original = deriveTimelineAssetUsage(fixture()).usesByAssetId[firstAssetId][0];
  const mutations = [
    input => { input.assets[0].sha256 = 'b'.repeat(64); },
    input => { input.assets[0].mimeType = 'video/a-new-codec'; },
    input => { input.assets[0].name = 'New name'; },
    ...['width', 'height', 'duration', 'sizeBytes'].map(field => input => { input.assets[0][field] = 100; }),
    ...['hasAudio', 'hasVideo'].map(field => input => { input.assets[0][field] = false; }),
    ...['versionId', 'shotId', 'jobId'].map(field => input => { input.timeline.clips[0][field] = id(99); }),
    ...['fadeInFrames', 'fadeOutFrames'].map(field => input => { input.timeline.clips[0][field] = 0; }),
    input => { input.timeline.clips[0].gain = 0.5; },
    input => { input.timeline.clips[0].rect.width = 718; },
    input => { input.timeline.tracks[0].kind = 'audio'; },
    input => { input.timeline.tracks[0].orderIndex = 1; },
    input => { input.timeline.tracks[0].hidden = true; },
    input => { input.timeline.tracks[0].muted = true; },
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input); const result = deriveTimelineAssetUsage(input);
    assert.equal(result.status, 'ready'); const next = result.usesByAssetId[firstAssetId][0];
    assert.equal(next.timelineRevision, original.timelineRevision);
    assert.notEqual(next.sourceIdentity, original.sourceIdentity);
  }
});

test('source identity preserves omission and canonical field order, and never includes paths or arbitrary objects', () => {
  const input = fixture(); input.assets[0].relativePath = '/private/secret.mp4'; input.assets[0].url = 'https://secret.invalid/';
  input.assets[0].toJSON = () => { throw Error('Must not serialize original object'); };
  const before = deriveTimelineAssetUsage(input).usesByAssetId[firstAssetId][0].sourceIdentity;
  assert.doesNotMatch(before, /private|secret|invalid/);
  input.assets[0] = Object.fromEntries(Object.entries(input.assets[0]).reverse());
  input.timeline.clips[0].rect = { height: 1280, width: 720, y: 0, x: 0 };
  assert.equal(deriveTimelineAssetUsage(input).usesByAssetId[firstAssetId][0].sourceIdentity, before);
  delete input.timeline.clips[0].name;
  const missing = deriveTimelineAssetUsage(input).usesByAssetId[firstAssetId][0];
  input.timeline.clips[0].name = '未命名片段';
  const explicit = deriveTimelineAssetUsage(input).usesByAssetId[firstAssetId][0];
  assert.equal(missing.clipName, explicit.clipName); assert.notEqual(missing.sourceIdentity, explicit.sourceIdentity);
});

test('malformed or oversized present identity metadata is unknown rather than arbitrarily serialized', () => {
  const mutations = [
    input => { input.assets[0].sha256 = 'invalid'; },
    input => { input.assets[0].mimeType = 'x'.repeat(201); },
    input => { input.assets[0].name = 'x'.repeat(201); },
    input => { input.assets[0].width = {}; },
    input => { input.assets[0].height = 0.5; },
    input => { input.assets[0].duration = Infinity; },
    input => { input.assets[0].sizeBytes = Number.MAX_SAFE_INTEGER + 1; },
    input => { input.assets[0].hasAudio = 'yes'; },
    input => { input.timeline.clips[0].jobId = null; },
    input => { input.timeline.clips[0].rect = {}; },
    input => { input.timeline.clips[0].rect.x = -1; },
    input => { input.timeline.clips[0].gain = {}; },
    input => { input.timeline.clips[0].fadeInFrames = '0'; },
    input => { input.timeline.clips[0].fadeOutFrames = 18001; },
    input => { input.timeline.tracks[0].kind = {}; },
    input => { input.timeline.tracks[0].muted = undefined; },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assertUnknown(input); }
});

test('canvas nodes, selected versions and unsaved drafts never substitute saved clip source', () => {
  const input = fixture();
  input.nodes = [{ assetId: unusedAssetId }]; input.shots = [{ selectedVersionId: id(99) }]; input.versions = [{ id: id(99), assetId: unusedAssetId }];
  input.draft = { ...input.timeline.clips[0], assetId: unusedAssetId, startFrame: 100 };
  const result = deriveTimelineAssetUsage(input);
  assert.equal(result.usesByAssetId[firstAssetId][0].startFrame, 0); assert.deepEqual(result.usesByAssetId[unusedAssetId], []);
  input.timeline.clips[0].assetId = unusedAssetId;
  const next = deriveTimelineAssetUsage(input);
  assert.equal(next.usesByAssetId[unusedAssetId].length, 1); assert.deepEqual(next.usesByAssetId[firstAssetId], []);
  assert.equal(result.usesByAssetId[firstAssetId][0].assetId, firstAssetId, 'previous provenance is not retargeted');
});

test('names remain literal text, with a fallback only for genuinely absent legacy clip names', () => {
  const input = fixture(); input.timeline.clips[0].name = '<img src=x onerror=alert(1)> & 文本'; input.timeline.tracks[0].name = '<script>bad()</script>';
  const result = deriveTimelineAssetUsage(input);
  assert.equal(result.usesByAssetId[firstAssetId][0].clipName, input.timeline.clips[0].name);
  assert.equal(result.usesByAssetId[firstAssetId][0].trackName, input.timeline.tracks[0].name);
  delete input.timeline.clips[0].name;
  assert.equal(deriveTimelineAssetUsage(input).usesByAssetId[firstAssetId][0].clipName, '未命名片段');
  assert.equal(Object.hasOwn(input.timeline.clips[0], 'name'), false);
});

test('projection is deeply readonly at runtime and never changes even frozen input', () => {
  const input = fixture(), before = structuredClone(input);
  freeze(input); const result = deriveTimelineAssetUsage(input);
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.usesByAssetId));
  assert.ok(Object.isFrozen(result.usesByAssetId[firstAssetId])); assert.ok(Object.isFrozen(result.usesByAssetId[firstAssetId][0]));
  assert.ok(Object.isFrozen(result.usesByAssetId[unusedAssetId]));
  assert.throws(() => { result.usesByAssetId[firstAssetId][0].startFrame = 99; }, TypeError);
  assert.throws(() => { result.usesByAssetId[unusedAssetId].push({}); }, TypeError);
  assert.throws(() => { result.usesByAssetId[firstAssetId] = []; }, TypeError);
  const changed = structuredClone(before); const copied = deriveTimelineAssetUsage(changed);
  changed.timeline.clips[0].name = 'Changed'; changed.timeline.tracks[0].name = 'Changed'; changed.timeline.revision++;
  assert.equal(copied.usesByAssetId[firstAssetId][0].clipName, 'Saved clip');
  assert.equal(copied.usesByAssetId[firstAssetId][0].trackName, 'Track 0'); assert.equal(copied.timelineRevision, 9);
});

test('unknown result is frozen and never leaks a partially built zero/use index', () => {
  const input = fixture(); input.timeline.clips.push(clip(id(99), { assetId: id(999), startFrame: 50 }));
  const result = deriveTimelineAssetUsage(input);
  assert.equal(result.status, 'unknown'); assert.deepEqual(result.usesByAssetId, {});
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.usesByAssetId));
});

test('semantic retention preserves snapshot ownership across unchanged polling and key order', () => {
  const input = fixture(), previous = deriveTimelineAssetUsage(input), copy = deriveTimelineAssetUsage(structuredClone(input));
  assert.notStrictEqual(copy, previous);
  assert.strictEqual(retainTimelineAssetUsage(previous, copy), previous);
  assert.strictEqual(retainTimelineAssetUsage(null, copy), copy);
  assert.strictEqual(retainTimelineAssetUsage(previous, previous), previous);
  input.assets.reverse();
  assert.strictEqual(retainTimelineAssetUsage(previous, deriveTimelineAssetUsage(input)), previous);
  const unknown = deriveTimelineAssetUsage({ ...input, ready: false });
  assert.strictEqual(retainTimelineAssetUsage(unknown, deriveTimelineAssetUsage({ ...input, ready: false })), unknown);
});

test('semantic retention replaces changed status, scope, membership, source identity and every use field', () => {
  const input = fixture(), previous = deriveTimelineAssetUsage(input);
  const mutations = [
    value => { value.ready = false; },
    value => { value.projectId = id(99); },
    value => { value.timeline.id = id(99); },
    value => { value.timeline.revision++; },
    value => { value.assets.push(asset(id(99))); },
    value => { value.assets.pop(); },
    value => { value.assets[1].id = id(99); },
    value => { value.timeline.clips = []; value.timeline.durationFrames = 0; },
    value => { value.timeline.clips[0].assetId = unusedAssetId; },
    value => { value.timeline.clips[0].id = id(99); },
    value => { value.timeline.tracks[0].id = id(99); value.timeline.clips[0].trackId = id(99); },
    value => { value.timeline.clips[0].name = 'Changed clip'; },
    value => { value.timeline.tracks[0].name = 'Changed track'; },
    value => { value.timeline.clips[0].startFrame++; value.timeline.durationFrames++; },
    value => { value.timeline.clips[0].durationFrames++; value.timeline.durationFrames++; },
    value => { value.timeline.clips[0].sourceInFrame++; },
    value => { value.assets[0].sha256 = 'b'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(input); mutate(changed); const next = deriveTimelineAssetUsage(changed);
    assert.strictEqual(retainTimelineAssetUsage(previous, next), next);
  }
  const unknown = deriveTimelineAssetUsage({ ...input, ready: false });
  assert.strictEqual(retainTimelineAssetUsage(unknown, previous), previous);
});

test('projection source has no storage, RPC, mutation or untyped-boundary escape', async () => {
  const source = await readFile(new URL('../apps/web/src/timeline-asset-usage.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s/m, 'pure dependency-free projection');
  assert.doesNotMatch(source, /\b(?:fetch|localStorage|sessionStorage|indexedDB)\b|@ts-ignore|@ts-nocheck|\bas\s+(?:unknown|any)\b|:\s*any\b/);
});
