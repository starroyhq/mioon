import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindTimelineOpacityRenderAttempt,
  getTimelineOpacityRenderBinding as get,
} from '../packages/business/src/timeline-opacity-render-binding.ts';

const unavailable = callback => assert.throws(callback, {code: 'OPACITY_RENDER_BINDING_UNAVAILABLE'});
const legacy = () => ({timeline: {clips: [{id: 'ordinary-clip', durationFrames: 3}]}, assets: []});

test('ordinary old snapshots receive no binding and no new effect stage', () => {
  for (const snapshot of [null, undefined, {}, legacy(), {timeline: {clips: []}, assets: []}]) {
    const before = JSON.stringify(snapshot);
    assert.equal(get(snapshot), null);
    assert.equal(get(snapshot, new Map()), null);
    assert.equal(get(snapshot, {path: '/never-opened'}), null);
    assert.equal(JSON.stringify(snapshot), before);
  }
});

test('every unbound own opacity field rejects, including absent-looking null and undefined', () => {
  for (const value of [null, undefined, {}, {profileId: 'mioon-clip-opacity-render-v1'}]) {
    unavailable(() => get({...legacy(), opacityPlan: value}));
    unavailable(() => get({...legacy(), opacityPlan: value}, new Map()));
    const snapshot = legacy(); snapshot.timeline.clips[0].opacityEnvelope = value;
    unavailable(() => get(snapshot));
    unavailable(() => get(structuredClone(snapshot)));
    // JSON omission of undefined produces an ordinary old value, not a grant.
    if (value !== undefined) unavailable(() => get(JSON.parse(JSON.stringify(snapshot))));
  }
});

test('opacity rejection does not execute proxy traps or own accessors', () => {
  let traps = 0;
  const proxy = value => new Proxy(value, {
    get() {traps++; throw Error('must not execute');},
    getOwnPropertyDescriptor() {traps++; throw Error('must not execute');},
    ownKeys() {traps++; throw Error('must not execute');},
  });
  unavailable(() => get(proxy(legacy())));
  unavailable(() => get({timeline: proxy({clips: []})}));
  unavailable(() => get({timeline: {clips: proxy([])}}));
  unavailable(() => get({timeline: {clips: [proxy({})]}}));
  const snapshot = {};
  Object.defineProperty(snapshot, 'timeline', {enumerable: true, get() {traps++; throw Error('must not execute');}});
  unavailable(() => get(snapshot));
  const timeline = {};
  Object.defineProperty(timeline, 'clips', {enumerable: true, get() {traps++; throw Error('must not execute');}});
  unavailable(() => get({timeline}));
  const clips = [];
  Object.defineProperty(clips, '0', {enumerable: true, get() {traps++; throw Error('must not execute');}});
  unavailable(() => get({timeline: {clips}}));
  assert.equal(traps, 0);
});

test('binding accepts no supplied proof callback or forged store/source Map', () => {
  let callbacks = 0;
  assert.throws(() => bindTimelineOpacityRenderAttempt(
    {root: '/never-opened', db: {}, checkpoint() {callbacks++;}},
    {purpose: 'preview', snapshot: legacy()}, new Map(),
    {beforeEffect() {callbacks++;}, validate() {callbacks++;}},
  ));
  assert.equal(callbacks, 0);
  assert.equal(get(legacy()), null);
});
