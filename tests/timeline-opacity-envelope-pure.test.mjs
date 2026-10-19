import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPACITY_ENVELOPE_PROFILE as profileId, OPACITY_ENVELOPE_LIMITS,
  validateOpacityEnvelope, createOpacityEnvelopeEvaluator,
  opacityEnvelopeFieldsAfterEdit, splitOpacityEnvelopeFields,
} from '../packages/contracts/src/timeline-opacity-envelope.ts';

const envelope = points => ({profileId, points: points.map(([frame, opacity]) => ({frame, opacity}))});
const clip = (points, durationFrames = 20) => ({durationFrames, opacityEnvelope: envelope(points)});
const invalid = action => assert.throws(action, {code: 'INVALID_OPACITY_ENVELOPE'});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-14, `${actual} != ${expected}`);

test('fixed seven-point profile validates exact values without normalization or mutation', () => {
  assert.equal(profileId, 'mioon-clip-linear-opacity-v1');
  assert.deepEqual(OPACITY_ENVELOPE_LIMITS, {points: 7, frames: 18000});
  assert.equal(Object.isFrozen(OPACITY_ENVELOPE_LIMITS), true);
  const value = envelope([[0, 0], [5, .25], [20, 1]]), before = JSON.stringify(value);
  assert.equal(validateOpacityEnvelope(value, 20), value);
  assert.equal(JSON.stringify(value), before);
  assert.equal(validateOpacityEnvelope(null, 20), null);
  const maximum = envelope(Array.from({length: 7}, (_, index) => [18000 - 6 + index, index / 6]));
  assert.equal(validateOpacityEnvelope(maximum, 18000), maximum);
  const nullPrototype = Object.assign(Object.create(null), value);
  assert.equal(validateOpacityEnvelope(nullPrototype, 20), nullPrototype);
  const frozen = Object.freeze({profileId, points: Object.freeze([Object.freeze({frame: 0, opacity: 1})])});
  assert.equal(validateOpacityEnvelope(frozen, 20), frozen);
});

test('unknown envelope values reject wrong shapes, profiles, bounds and eight points', () => {
  const value = envelope([[0, 0], [20, 1]]);
  for (const bad of [
    undefined, false, 0, '', {}, [], new Date(), {...value, extra: 1}, {...value, profileId: 'mioon-clip-linear-attenuation-v1'},
    envelope([]), envelope(Array.from({length: 8}, (_, index) => [index, 1])),
    envelope([[2, 1], [1, 0]]), envelope([[1, 0], [1, 1]]), envelope([[21, 1]]), envelope([[-1, 1]]),
    envelope([[.5, 1]]), envelope([[0, NaN]]), envelope([[0, Infinity]]), envelope([[0, -Infinity]]),
    envelope([[0, '1']]), envelope([[0, 1.1]]), envelope([[0, -.1]]), envelope([[0, -0]]), envelope([[-0, 1]]),
    {...value, points: [{frame: 0, opacity: 1, extra: 1}]},
  ]) invalid(() => validateOpacityEnvelope(bad, 20));
  for (const bad of [undefined, null, '20', 0, -0, -1, .5, 18001, Infinity, NaN]) {
    invalid(() => validateOpacityEnvelope(null, bad));
    invalid(() => createOpacityEnvelopeEvaluator({durationFrames: bad}));
  }
});

test('arrays and records reject sparse, subclassed, symbolic and nonenumerable data', () => {
  class Points extends Array {}
  const sparse = {profileId, points: new Array(1)};
  const subclassed = {profileId, points: new Points({frame: 0, opacity: 1})};
  const extraArray = envelope([[0, 1]]); extraArray.points.extra = 1;
  const symbolicArray = envelope([[0, 1]]); symbolicArray.points[Symbol('point')] = 1;
  const symbolicEnvelope = envelope([[0, 1]]); symbolicEnvelope[Symbol('envelope')] = 1;
  const symbolicPoint = envelope([[0, 1]]); symbolicPoint.points[0][Symbol('opacity')] = 1;
  const hiddenPoint = envelope([[0, 1]]); Object.defineProperty(hiddenPoint.points[0], 'opacity', {value: 1, enumerable: false});
  const hiddenIndex = envelope([[0, 1]]); Object.defineProperty(hiddenIndex.points, '0', {enumerable: false});
  const inheritedPoint = {profileId, points: [Object.create({frame: 0, opacity: 1})]};
  const inheritedClip = Object.create({durationFrames: 20});
  for (const bad of [sparse, subclassed, extraArray, symbolicArray, symbolicEnvelope, symbolicPoint, hiddenPoint, hiddenIndex, inheritedPoint]) {
    invalid(() => validateOpacityEnvelope(bad, 20));
  }
  invalid(() => createOpacityEnvelopeEvaluator(inheritedClip));
  invalid(() => createOpacityEnvelopeEvaluator([]));
  invalid(() => opacityEnvelopeFieldsAfterEdit({durationFrames: 20}, []));
});

test('all relevant getter boundaries reject without executing accessors', () => {
  let calls = 0;
  const accessor = (base, key) => Object.defineProperty(base, key, {enumerable: true, get() {calls++; throw Error('getter executed');}});
  for (const bad of [
    accessor({points: []}, 'profileId'), accessor({profileId}, 'points'),
    {profileId, points: [accessor({opacity: 1}, 'frame')]},
    {profileId, points: [accessor({frame: 0}, 'opacity')]},
    {profileId, points: accessor([null], '0')},
  ]) invalid(() => validateOpacityEnvelope(bad, 20));
  for (const bad of [accessor({}, 'durationFrames'), accessor({durationFrames: 20}, 'opacityEnvelope')]) {
    invalid(() => createOpacityEnvelopeEvaluator(bad));
    invalid(() => opacityEnvelopeFieldsAfterEdit(bad, {}));
    invalid(() => splitOpacityEnvelopeFields(bad, 10));
  }
  for (const bad of [accessor({}, 'durationFrames'), accessor({}, 'opacityEnvelope'), accessor({}, 'startFrame')]) {
    invalid(() => opacityEnvelopeFieldsAfterEdit({durationFrames: 20}, bad));
  }
  assert.equal(calls, 0);
});

test('absent and null hold one inside playback with a separate inclusive endpoint evaluator', () => {
  for (const source of [{durationFrames: 20}, {durationFrames: 20, opacityEnvelope: null}, clip([[5, 1]])]) {
    const evaluator = createOpacityEnvelopeEvaluator(source);
    assert.equal(evaluator.atFrame(0), 1);
    assert.equal(evaluator.atFrame(19), 1);
    assert.equal(evaluator.limitAtFrame(20), 1);
    for (const frame of [-Number.MAX_SAFE_INTEGER, -1, 20, Number.MAX_SAFE_INTEGER]) assert.equal(evaluator.atFrame(frame), 0);
    for (const frame of [-1, 21]) invalid(() => evaluator.limitAtFrame(frame));
    for (const frame of [-0, .5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
      invalid(() => evaluator.atFrame(frame));
      invalid(() => evaluator.limitAtFrame(frame));
    }
  }
  invalid(() => createOpacityEnvelopeEvaluator({durationFrames: 20, opacityEnvelope: undefined}));
});

test('linear interpolation, endpoint holding and detached immutable evaluators', () => {
  const source = clip([[5, .25], [15, .75]]), evaluator = createOpacityEnvelopeEvaluator(source);
  assert.equal(Object.isFrozen(evaluator), true);
  for (const frame of [0, 4, 5]) assert.equal(evaluator.limitAtFrame(frame), .25);
  for (const frame of [15, 16, 20]) assert.equal(evaluator.limitAtFrame(frame), .75);
  near(evaluator.atFrame(6), .3);
  assert.equal(evaluator.atFrame(10), .5);
  near(evaluator.atFrame(14), .7);
  source.opacityEnvelope.points[0].opacity = 1;
  source.opacityEnvelope.points[1].frame = 7;
  source.opacityEnvelope.points.push({frame: 20, opacity: 0});
  source.durationFrames = 1;
  source.opacityEnvelope = null;
  assert.equal(evaluator.atFrame(0), .25);
  assert.equal(evaluator.atFrame(10), .5);
  assert.equal(evaluator.limitAtFrame(20), .75);
  assert.equal(evaluator.atFrame(20), 0);
});

test('edits retain local anchors and exact presence, requiring atomic shrink replacement or clear', () => {
  const source = clip([[0, 0], [20, 1]]), before = JSON.stringify(source);
  for (const patch of [{}, {durationFrames: 30}, {startFrame: 100}, {sourceInFrame: 100}, {startFrame: 100, sourceInFrame: 200}]) {
    const changed = opacityEnvelopeFieldsAfterEdit(source, patch);
    assert.deepEqual(changed, {opacityEnvelope: source.opacityEnvelope});
    assert.notEqual(changed.opacityEnvelope, source.opacityEnvelope);
    assert.notEqual(changed.opacityEnvelope.points, source.opacityEnvelope.points);
    assert.notEqual(changed.opacityEnvelope.points[0], source.opacityEnvelope.points[0]);
  }
  invalid(() => opacityEnvelopeFieldsAfterEdit(source, {durationFrames: 10}));
  assert.deepEqual(opacityEnvelopeFieldsAfterEdit(source, {durationFrames: 10, opacityEnvelope: null}), {opacityEnvelope: null});
  const replacement = envelope([[0, 1], [10, .5]]);
  const changed = opacityEnvelopeFieldsAfterEdit(source, {durationFrames: 10, opacityEnvelope: replacement});
  assert.deepEqual(changed, {opacityEnvelope: replacement});
  replacement.points[0].opacity = 0;
  assert.equal(changed.opacityEnvelope.points[0].opacity, 1);
  assert.deepEqual(opacityEnvelopeFieldsAfterEdit({durationFrames: 20}, {durationFrames: 10}), {});
  assert.deepEqual(opacityEnvelopeFieldsAfterEdit({durationFrames: 20, opacityEnvelope: null}, {}), {opacityEnvelope: null});
  assert.deepEqual(opacityEnvelopeFieldsAfterEdit({durationFrames: 20}, {opacityEnvelope: null}), {opacityEnvelope: null});
  assert.equal(JSON.stringify(source), before);
  for (const patch of [{opacityEnvelope: undefined}, {durationFrames: undefined}, {durationFrames: 0}, {durationFrames: 10, opacityEnvelope: envelope([[11, .5]])}]) {
    invalid(() => opacityEnvelopeFieldsAfterEdit(source, patch));
  }
});

test('every interior split rejoins the original integer-frame curve without exceeding seven points', () => {
  const curves = [
    [[0, 0], [20, 1]], [[5, .25], [15, .75]], [[5, .25]], [[0, 1]], [[20, 0]],
    [[0, 1], [5, 0], [10, 1], [20, 0]],
    Array.from({length: 7}, (_, index) => [index * 3, (index % 3) / 2]),
    Array.from({length: 7}, (_, index) => [index + 8, (index % 3) / 2]),
  ];
  for (const points of curves) {
    const source = clip(points), before = JSON.stringify(source), original = createOpacityEnvelopeEvaluator(source);
    for (let cut = 1; cut < 20; cut++) {
      const [leftFields, rightFields] = splitOpacityEnvelopeFields(source, cut);
      assert.ok(leftFields.opacityEnvelope.points.length <= 7);
      assert.ok(rightFields.opacityEnvelope.points.length <= 7);
      const left = createOpacityEnvelopeEvaluator({durationFrames: cut, ...leftFields});
      const right = createOpacityEnvelopeEvaluator({durationFrames: 20 - cut, ...rightFields});
      for (let frame = 0; frame <= 20; frame++) {
        near(original.limitAtFrame(frame), frame <= cut ? left.limitAtFrame(frame) : right.limitAtFrame(frame - cut));
        if (frame < 20) near(original.atFrame(frame), frame < cut ? left.atFrame(frame) : right.atFrame(frame - cut));
      }
      near(left.limitAtFrame(cut), right.limitAtFrame(0));
      assert.equal(left.atFrame(cut), 0);
    }
    assert.equal(JSON.stringify(source), before);
  }
  const joined = splitOpacityEnvelopeFields(clip([[0, 0], [10, .5], [20, 1]]), 10);
  assert.deepEqual(joined[0].opacityEnvelope.points, [{frame: 0, opacity: 0}, {frame: 10, opacity: .5}]);
  assert.deepEqual(joined[1].opacityEnvelope.points, [{frame: 0, opacity: .5}, {frame: 10, opacity: 1}]);
});

test('split preserves absence or null, detaches results, and refuses non-interior cuts', () => {
  assert.deepEqual(splitOpacityEnvelopeFields({durationFrames: 20}, 10), [{}, {}]);
  assert.deepEqual(splitOpacityEnvelopeFields({durationFrames: 20, opacityEnvelope: null}, 10), [{opacityEnvelope: null}, {opacityEnvelope: null}]);
  const source = clip([[0, 0], [20, 1]]), [left, right] = splitOpacityEnvelopeFields(source, 10);
  left.opacityEnvelope.points[0].opacity = 1;
  right.opacityEnvelope.points[0].opacity = 0;
  assert.equal(source.opacityEnvelope.points[0].opacity, 0);
  assert.equal(source.opacityEnvelope.points[1].opacity, 1);
  assert.equal(left.opacityEnvelope.points[1].opacity, .5);
  for (const cut of [0, -0, -1, 20, 21, .5, NaN, Infinity, '10']) invalid(() => splitOpacityEnvelopeFields(source, cut));
  invalid(() => splitOpacityEnvelopeFields({durationFrames: 1}, 1));
});
