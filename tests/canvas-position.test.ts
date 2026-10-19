import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCanvasPosition } from '../apps/web/src/canvas-position.ts';

test('new canvas nodes keep a clear requested drop and avoid existing moved shot/text/image cards', () => {
  const records = [{ position: { x: 350, y: 80 } }, { position: { x: 400, y: 140 } }, { position: { x: 80, y: -184 } }], original = structuredClone(records);
  assert.deepEqual(chooseCanvasPosition(records, { x: 2000, y: 500 }), { x: 2000, y: 500 });
  const chosen = chooseCanvasPosition(records, { x: 350, y: 80 });
  assert.ok(records.every((record: {position: {x: number; y: number}}) => Math.abs(chosen.x - record.position.x) >= 272 || Math.abs(chosen.y - record.position.y) >= 264));
  assert.deepEqual(records, original);
});
test('dense boards use a bounded outside fallback and malformed positions cannot produce NaN', () => {
  const records: {position: {x: number; y: number}}[] = [];
  for (let row = -12; row <= 12; row++) for (let column = -12; column <= 12; column++) records.push({ position: { x: column * 272, y: row * 264 } });
  const chosen = chooseCanvasPosition(records, { x: 0, y: 0 });
  assert.equal(chosen.x, 13 * 272); assert.equal(chosen.y, 0);
  assert.deepEqual(chooseCanvasPosition([{ position: { x: Infinity, y: NaN } }, {}], { x: NaN, y: 1 }), { x: 100, y: 80 });
});
