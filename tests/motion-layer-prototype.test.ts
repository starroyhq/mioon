import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cubicBezier, fadeOpacity, frameProgress, interpolate, seededRandom, sequenceFrame, springProgress, staggerFrame,
} from '../apps/web/src/motion-layer-prototype/runtime.ts';

test('the motion clock samples both endpoints and composes sequences and staggered fades', () => {
  assert.deepEqual([9, 10, 11, 12, 13].map(frame => sequenceFrame(frame, 10, 3)), [undefined, 0, 1, 2, undefined]);
  assert.deepEqual([0, 1, 2, 3].map(index => staggerFrame(5, index, 1.5)), [5, 3, 2, 0]);
  assert.deepEqual([-1, 0, 1, 2, 3].map(frame => frameProgress(frame, 3)), [0, 0, 0.5, 1, 1]);
  assert.deepEqual([-1, 0, 1, 2, 3, 4, 5, 6, 7].map(frame => fadeOpacity(frame, 7, 3, 3)),
    [0, 0, 0.5, 1, 1, 1, 0.5, 0, 0]);
  assert.deepEqual([0, 1, 2, 3].map(frame => fadeOpacity(frame, 3, 1, 1)), [1, 1, 0, 0]);
  assert.equal(fadeOpacity(0, 1, 0, 0), 1);
});

test('Bézier solves for x and the spring overshoots before settling on the exact endpoint', () => {
  const linear = cubicBezier(0, 0, 1, 1);
  assert.ok(Math.abs(linear(0.2) - 0.2) < 1e-6);
  const ease = cubicBezier(0.2, 0.65, 0.3, 1);
  assert.equal(ease(0), 0);
  assert.ok(ease(0.2) > 0.2);
  assert.equal(ease(1), 1);
  assert.throws(() => cubicBezier(-0.1, 0, 1, 1), RangeError);
  assert.equal(springProgress(0), 0);
  assert.ok(springProgress(Math.PI / 12) > 1);
  assert.equal(springProgress(1), 1);
  assert.equal(interpolate(20, -4, 0.5), 8);
});

test('seeded draws remain reproducible when samples are read out of order', () => {
  const indices = [0, 1, 2, 150];
  const samples = indices.map(index => seededRandom(42, index));
  assert.deepEqual([...indices].reverse().map(index => seededRandom(42, index)), [...samples].reverse());
  assert.ok(samples.every(sample => sample >= 0 && sample < 1));
  assert.equal(new Set(samples).size, indices.length);
  assert.notEqual(seededRandom(43, 1), seededRandom(42, 1));
});
