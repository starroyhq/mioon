import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPadding, measuredFitPadding } from '../apps/web/src/canvas-fit.ts';

const box = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const pane = box(0, 60, 1500, 960);

test('fit padding clears the docks, heading and storyboard that float over the full-bleed pane', () => {
  const padding = fitPadding(pane, [
    { side: 'left', box: box(12, 72, 254, 948) }, { side: 'right', box: box(1178, 72, 1488, 948) },
    { side: 'top', box: box(266, 72, 1166, 114) }, { side: 'bottom', box: box(266, 915, 1166, 948) },
  ], 20);
  assert.deepEqual(padding, { top: '74px', right: '342px', bottom: '65px', left: '274px' });
});

test('uncovered sides keep only the margin, and an overlay covering most of an axis cannot squeeze the fit to nothing', () => {
  assert.deepEqual(fitPadding(pane, [], 16), { top: '16px', right: '16px', bottom: '16px', left: '16px' });
  const squeezed = fitPadding(box(0, 0, 400, 300), [{ side: 'left', box: box(0, 0, 380, 300) }, { side: 'right', box: box(20, 0, 400, 300) }], 20);
  const left = parseInt(squeezed.left), right = parseInt(squeezed.right);
  assert.ok(left + right <= 0.8 * 400 + 1, `${left} + ${right} leaves no room`);
  assert.ok(left > 0 && right > 0);
});

function fakeDocument(layout) {
  const element = rect => ({ getClientRects: () => (rect ? [rect] : []), getBoundingClientRect: () => rect ?? box(0, 0, 0, 0) });
  return { querySelectorAll: selector => (layout[selector] ?? []).map(element) };
}
const paneElement = (document, rect = pane) => ({ ownerDocument: document, getBoundingClientRect: () => rect });

test('measured padding reads only the visible overlays and falls back when the pane is not on screen', () => {
  const document = fakeDocument({
    '#dock-assets[data-visible="true"]': [box(12, 72, 254, 948)], '.recall-assets': [null],
    '#dock-inspector[data-visible="true"]': [], '.recall-inspector': [box(1460, 72, 1488, 948)],
    '.canvas-heading': [box(266, 72, 1166, 114)], '.storyboard': [box(266, 915, 1166, 948)],
  });
  assert.deepEqual(measuredFitPadding(paneElement(document)), { top: '74px', right: '60px', bottom: '65px', left: '274px' });
  assert.equal(measuredFitPadding(null, 0.18), 0.18);
  assert.equal(measuredFitPadding(undefined), 0.16);
  assert.equal(measuredFitPadding(paneElement(document, box(0, 0, 0, 0)), 0.25), 0.25);
});
