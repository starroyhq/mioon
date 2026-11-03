import test from 'node:test';
import assert from 'node:assert/strict';
import {OPACITY_ENVELOPE_PROFILE as profileId, OPACITY_ENVELOPE_LIMITS, validateOpacityEnvelope} from '../packages/contracts/src/timeline-opacity-envelope.ts';

const envelope = (points: [unknown,unknown][]|(string|number)[][]) => ({profileId, points: points.map(([frame, opacity]) => ({frame, opacity}))});

const invalid = (action: () => unknown) => assert.throws(action, {code: 'INVALID_OPACITY_ENVELOPE'});

test('fixed seven-point profile validates exact values without normalization or mutation', () => {
  assert.equal(profileId, 'mioon-clip-linear-opacity-v1');
  assert.deepEqual(OPACITY_ENVELOPE_LIMITS, {points: 7, frames: 18000});
  assert.equal(Object.isFrozen(OPACITY_ENVELOPE_LIMITS), true);
  const value = envelope([[0, 0], [5, .25], [20, 1]]), before = JSON.stringify(value);
  assert.equal(validateOpacityEnvelope(value, 20), value);
  assert.equal(JSON.stringify(value), before);
  assert.equal((validateOpacityEnvelope(null, 20) as unknown), null);
  const maximum = envelope(Array.from({length: 7}, (_, index) => [18000 - 6 + index, index / 6]));
  assert.equal(validateOpacityEnvelope(maximum, 18000), maximum);
  const nullPrototype = Object.assign(Object.create(null), value);
  assert.equal(validateOpacityEnvelope(nullPrototype, 20), nullPrototype);
  const frozen = Object.freeze({profileId, points: Object.freeze([Object.freeze({frame: 0, opacity: 1})])});
  assert.equal(validateOpacityEnvelope(frozen, 20), frozen);
});

test('unknown envelope values reject wrong shapes, profiles, bounds and eight points', () => {
  const value = envelope([[0, 0], [20, 1]]);
  for (const bad of ([
    undefined, false, 0, '', {}, [], new Date(), {...value, extra: 1}, {...value, profileId: 'mioon-clip-linear-attenuation-v1'},
    envelope([]), envelope(Array.from({length: 8}, (_, index) => [index, 1])),
    envelope([[2, 1], [1, 0]]), envelope([[1, 0], [1, 1]]), envelope([[21, 1]]), envelope([[-1, 1]]),
    envelope([[.5, 1]]), envelope([[0, NaN]]), envelope([[0, Infinity]]), envelope([[0, -Infinity]]),
    envelope([[0, '1']]), envelope([[0, 1.1]]), envelope([[0, -.1]]), envelope([[0, -0]]), envelope([[-0, 1]]),
    {...value, points: [{frame: 0, opacity: 1, extra: 1}]},
  ] as const)) invalid(((() => validateOpacityEnvelope(bad, 20)) as unknown as Parameters<typeof invalid>[0]));
  for (const bad of ([undefined, null, '20', 0, -0, -1, .5, 18001, Infinity, NaN] as const)) {
    invalid(((() => validateOpacityEnvelope(null, ((bad) as unknown as Parameters<typeof validateOpacityEnvelope>[1]))) as unknown as Parameters<typeof invalid>[0]));
  }
});

test('arrays and records reject sparse, subclassed, symbolic and nonenumerable data', () => {
  class Points extends Array {}
  const sparse = {profileId, points: new Array(1)};
  const subclassed = {profileId, points: new Points((({frame: 0, opacity: 1}) as unknown as ConstructorParameters<typeof Points>[0]))};
  const extraArray = envelope([[0, 1]]); (extraArray.points as unknown as {extra:(1)}).extra = 1;
  const symbolicArray = envelope([[0, 1]]); (symbolicArray.points as unknown as Record<symbol,unknown>)[Symbol('point')] = 1;
  const symbolicEnvelope = envelope([[0, 1]]); (symbolicEnvelope as unknown as Record<symbol,unknown>)[Symbol('envelope')] = 1;
  const symbolicPoint = envelope([[0, 1]]); (symbolicPoint.points[0] as unknown as Record<symbol,unknown>)[Symbol('opacity')] = 1;
  const hiddenPoint = envelope([[0, 1]]); Object.defineProperty(hiddenPoint.points[0], 'opacity', {value: 1, enumerable: false});
  const hiddenIndex = envelope([[0, 1]]); Object.defineProperty(hiddenIndex.points, '0', {enumerable: false});
  const inheritedPoint = {profileId, points: [Object.create({frame: 0, opacity: 1})]};

  for (const bad of ([sparse, subclassed, extraArray, symbolicArray, symbolicEnvelope, symbolicPoint, hiddenPoint, hiddenIndex, inheritedPoint] as const)) {
    invalid(((() => validateOpacityEnvelope(bad, 20)) as unknown as Parameters<typeof invalid>[0]));
  }

});

test('all relevant getter boundaries reject without executing accessors', () => {
  let calls = 0;
  const accessor = (base: null[], key: PropertyKey) => Object.defineProperty(base, key, {enumerable: true, get() {calls++; throw Error('getter executed');}});
  for (const bad of ([
    accessor((({points: []}) as unknown as Parameters<NonNullable<typeof accessor>>[0]), 'profileId'), accessor((({profileId}) as unknown as Parameters<typeof accessor>[0]), 'points'),
    {profileId, points: [accessor((({opacity: 1}) as unknown as Parameters<NonNullable<typeof accessor>>[0]), 'frame')]},
    {profileId, points: [accessor((({frame: 0}) as unknown as Parameters<NonNullable<typeof accessor>>[0]), 'opacity')]},
    {profileId, points: accessor([null], '0')},
  ] as const)) invalid(((() => validateOpacityEnvelope(bad, 20)) as unknown as Parameters<typeof invalid>[0]));

  assert.equal(calls, 0);
});
