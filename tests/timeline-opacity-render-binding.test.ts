import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getTimelineOpacityRenderBinding as get,
type TimelineOpacityRenderBinding,
} from '../packages/business/src/timeline-opacity-render-binding.ts';

const unavailable = (callback: { (): Readonly<TimelineOpacityRenderBinding>|null; (): Readonly<TimelineOpacityRenderBinding>|null; (): Readonly<TimelineOpacityRenderBinding>|null; (): Readonly<TimelineOpacityRenderBinding>|null; (): Readonly<TimelineOpacityRenderBinding>|null; (): Readonly<TimelineOpacityRenderBinding>|null; (): Readonly<TimelineOpacityRenderBinding>|null; (): Readonly<TimelineOpacityRenderBinding>|null; (): Readonly<TimelineOpacityRenderBinding>|null; (): Readonly<TimelineOpacityRenderBinding>|null; (): Readonly<TimelineOpacityRenderBinding>|null; (): Readonly<TimelineOpacityRenderBinding>|null; (): unknown; }) => assert.throws(callback, {code: 'OPACITY_RENDER_BINDING_UNAVAILABLE'});
const legacy = () => ({timeline: {clips: [{id: 'ordinary-clip', durationFrames: 3}]}, assets: []});

test('ordinary old snapshots receive no binding and no new effect stage', () => {
  for (const snapshot of ([null, undefined, {}, legacy(), {timeline: {clips: []}, assets: []}] as const)) {
    const before = JSON.stringify(snapshot);
    assert.equal((get(snapshot) as unknown), null);
    assert.equal((get(snapshot, new Map()) as unknown), null);
    assert.equal((get(snapshot, {path: '/never-opened'}) as unknown), null);
    assert.equal(JSON.stringify(snapshot), before);
  }
});

test('every unbound own opacity field rejects, including absent-looking null and undefined', () => {
  for (const value of ([null, undefined, {}, {profileId: 'mioon-clip-opacity-render-v1'}] as const)) {
    unavailable(() => get({...legacy(), opacityPlan: value}));
    unavailable(() => get({...legacy(), opacityPlan: value}, new Map()));
    const snapshot = legacy(); (snapshot.timeline.clips[0] as typeof snapshot.timeline.clips[0] & {opacityEnvelope?: unknown}).opacityEnvelope = value;
    unavailable(() => get(snapshot));
    unavailable(() => get(structuredClone(snapshot)));
    // JSON omission of undefined produces an ordinary old value, not a grant.
    if (value !== undefined) unavailable(() => get(JSON.parse(JSON.stringify(snapshot))));
  }
});

test('opacity rejection does not execute proxy traps or own accessors', () => {
  let traps = 0;
  const proxy = (value: object) => new Proxy(value, {
    get() {traps++; throw Error('must not execute');},
    getOwnPropertyDescriptor() {traps++; throw Error('must not execute');},
    ownKeys() {traps++; throw Error('must not execute');},
  });
  unavailable(() => get(proxy(((legacy()) as unknown as Parameters<typeof proxy>[0]))));
  unavailable(() => get({timeline: proxy({clips: []})}));
  unavailable(() => get({timeline: {clips: proxy([])}}));
  unavailable(() => get({timeline: {clips: [proxy((({}) as unknown as Parameters<typeof proxy>[0]))]}}));
  const snapshot = {};
  Object.defineProperty(snapshot, 'timeline', {enumerable: true, get() {traps++; throw Error('must not execute');}});
  unavailable(() => get(snapshot));
  const timeline = {};
  Object.defineProperty(timeline, 'clips', {enumerable: true, get() {traps++; throw Error('must not execute');}});
  unavailable(() => get({timeline}));
  const clips: unknown[] = [];
  Object.defineProperty(clips, '0', {enumerable: true, get() {traps++; throw Error('must not execute');}});
  unavailable(() => get({timeline: {clips}}));
  assert.equal(traps, 0);
});
