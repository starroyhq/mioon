import test from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_BOUNDS, clampPanelSize, defaultWorkspaceLayout, normalizeWorkspaceLayout, isWorkspaceLayout, effectiveWorkspaceLayout } from '../apps/web/src/workspace-layout.ts';
import { defaultWorkspaceState, normalizeWorkspaceState } from '../apps/web/src/workspace-state.ts';
import { parseWorkspacePreferencesState } from '../packages/business/src/workspace-preferences.ts';

test('panel defaults and bounds agree across renderer and strict server parsing', () => {
  assert.deepEqual(PANEL_BOUNDS, {
    assetsWidth: { default: 260, min: 180, max: 480 },
    inspectorWidth: { default: 320, min: 240, max: 560 },
    timelineHeight: { default: 300, min: 160, max: 800 },
  });
  const state = defaultWorkspaceState(); delete state.shared.assetSearch;
  assert.deepEqual(parseWorkspacePreferencesState(state), state);
  for (const [key, bounds] of Object.entries(PANEL_BOUNDS)) {
    for (const mode of key === 'timelineHeight' ? ['editing'] : ['canvas', 'editing']) {
      for (const good of [bounds.min, bounds.default, bounds.max, (bounds.min + bounds.max) / 2 + .25]) {
        const value = structuredClone(state); value.layout[mode][key] = good;
        assert.equal(parseWorkspacePreferencesState(value).layout[mode][key], good);
        assert.equal(normalizeWorkspaceState(value).layout[mode][key], good);
      }
      for (const bad of [bounds.min - 1, bounds.max + 1, NaN, Infinity, '300', null]) {
        const value = structuredClone(state); value.layout[mode][key] = bad;
        assert.throws(() => parseWorkspacePreferencesState(value), { code: 'VALIDATION_ERROR' });
        assert.equal(isWorkspaceLayout(value.layout), false);
      }
    }
  }
});

test('preferred dimensions clamp only explicit state normalization and defaults never share objects', () => {
  const first = defaultWorkspaceLayout(), second = defaultWorkspaceLayout();
  first.canvas.assetsWidth = 400;
  assert.equal(first.editing.assetsWidth, 260); assert.equal(second.canvas.assetsWidth, 260);
  assert.equal(isWorkspaceLayout(first), true);
  for (const [key, bounds] of Object.entries(PANEL_BOUNDS)) {
    assert.equal(clampPanelSize(key, -1), bounds.min);
    assert.equal(clampPanelSize(key, 1e6), bounds.max);
    assert.equal(clampPanelSize(key, NaN), bounds.default);
    assert.equal(clampPanelSize(key, '350'), bounds.default);
  }
  assert.deepEqual(normalizeWorkspaceLayout(undefined, { assetsCollapsed: true }).canvas,
    { assetsWidth: 260, inspectorWidth: 320, assetsCollapsed: true, inspectorCollapsed: false });
  const supplied = defaultWorkspaceLayout(); supplied.editing.assetsCollapsed = true;
  assert.deepEqual(normalizeWorkspaceLayout(supplied, { assetsCollapsed: true, inspectorCollapsed: true }), supplied);
});

test('effective geometry preserves center space and never changes durable preferred dimensions', () => {
  const preferred = { assetsWidth: 460, inspectorWidth: 540, timelineHeight: 780, assetsCollapsed: false, inspectorCollapsed: false };
  const before = structuredClone(preferred);
  const options = { centerMinWidth: 300, centerMinHeight: 180, separatorSize: 0, collapsedWidth: 28 };
  const large = effectiveWorkspaceLayout(preferred, { ...options, width: 1800, height: 1200 });
  assert.equal(large.assetsWidth, 460); assert.equal(large.inspectorWidth, 540); assert.equal(large.timelineHeight, 780);
  const smaller = effectiveWorkspaceLayout(preferred, { ...options, width: 900, height: 600 });
  assert.ok(smaller.assetsWidth >= 180); assert.ok(smaller.inspectorWidth >= 240);
  assert.equal(smaller.assetsWidth + smaller.inspectorWidth, 600);
  assert.equal(smaller.timelineHeight, 420);
  assert.equal(smaller.timelineMaxHeight, 420);
  assert.deepEqual(preferred, before);
  assert.deepEqual(effectiveWorkspaceLayout(preferred, { ...options, width: 1800, height: 1200 }), large);
});

test('the center keeps a comfortable height while the timeline can still keep its floor, then yields to the hard minimum', () => {
  const preferred = defaultWorkspaceLayout().editing, before = structuredClone(preferred);
  const options = { width: 1800, centerMinWidth: 300, centerMinHeight: 180, centerComfortHeight: 300, timelineFloorHeight: 220, separatorSize: 0, collapsedWidth: 28 };
  const at = height => effectiveWorkspaceLayout(preferred, { ...options, height });
  assert.equal(at(900).timelineHeight, 300);
  assert.equal(at(584).timelineHeight, 284); assert.equal(at(584).timelineMaxHeight, 284);
  assert.equal(at(434).timelineHeight, 220); assert.equal(at(434).timelineMaxHeight, 220);
  assert.equal(at(380).timelineHeight, 200); assert.equal(at(380).timelineMaxHeight, 200);
  for (const height of [0, 100, 300]) { const result = at(height); assert.ok(Number.isFinite(result.timelineHeight) && result.timelineHeight >= 0); assert.ok(result.timelineHeight <= height); }
  assert.deepEqual(preferred, before);
  // Callers that do not ask for a comfortable height keep the plain hard minimum.
  assert.equal(effectiveWorkspaceLayout(preferred, { ...options, centerComfortHeight: undefined, timelineFloorHeight: undefined, height: 584 }).timelineMaxHeight, 404);
});

test('effective collapsed and extremely narrow layouts stay finite and preserve saved visibility', () => {
  const preferred = { ...defaultWorkspaceLayout().editing, assetsCollapsed: true };
  const wide = effectiveWorkspaceLayout(preferred, { width: 1200, height: 900, collapsedWidth: 28, separatorSize: 0 });
  assert.equal(wide.assetsWidth, 28); assert.equal(wide.inspectorWidth, 320);
  assert.equal(wide.assetsCollapsed, true); assert.equal(wide.inspectorCollapsed, false);
  for (const width of [0, 120, 500, 800]) for (const height of [0, 100, 400]) {
    const result = effectiveWorkspaceLayout(preferred, { width, height });
    for (const key of ['assetsWidth', 'inspectorWidth', 'timelineHeight', 'assetsMaxWidth', 'inspectorMaxWidth', 'timelineMaxHeight']) {
      assert.ok(Number.isFinite(result[key])); assert.ok(result[key] >= 0);
    }
    assert.ok(result.assetsWidth + result.inspectorWidth <= width);
    assert.ok(result.timelineHeight <= height);
    assert.equal(result.assetsCollapsed, true); assert.equal(result.inspectorCollapsed, false);
  }
  assert.equal(preferred.assetsWidth, 260); assert.equal(preferred.timelineHeight, 300);
});

test('layout validation rejects extra, missing, malformed and symbolic fields at every boundary', () => {
  const invalid = [null, [], false, {}, { canvas: {}, editing: {} }];
  for (const mode of ['canvas', 'editing']) {
    for (const key of Object.keys(defaultWorkspaceLayout()[mode])) {
      const value = defaultWorkspaceLayout(); delete value[mode][key]; invalid.push(value);
    }
    for (const key of ['assetsCollapsed', 'inspectorCollapsed']) for (const bad of [null, 0, 'true']) {
      const value = defaultWorkspaceLayout(); value[mode][key] = bad; invalid.push(value);
    }
    for (const key of ['extra', Symbol('extra')]) {
      const value = defaultWorkspaceLayout(); value[mode][key] = true; invalid.push(value);
    }
  }
  const extra = defaultWorkspaceLayout(); extra.extra = true; invalid.push(extra);
  for (const value of invalid) assert.equal(isWorkspaceLayout(value), false);
});

test('old default sizes migrate without changing custom sizes, visibility or the source object', () => {
  const legacy = {
    canvas: { assetsWidth: 242, inspectorWidth: 310, assetsCollapsed: true, inspectorCollapsed: false },
    editing: { assetsWidth: 242, inspectorWidth: 310, timelineHeight: 320, assetsCollapsed: false, inspectorCollapsed: true },
  };
  const before = structuredClone(legacy);
  const result = normalizeWorkspaceLayout(legacy);
  assert.deepEqual(result, {
    canvas: { assetsWidth: 260, inspectorWidth: 320, assetsCollapsed: true, inspectorCollapsed: false },
    editing: { assetsWidth: 260, inspectorWidth: 320, timelineHeight: 300, assetsCollapsed: false, inspectorCollapsed: true },
  });
  assert.deepEqual(legacy, before);
  const custom = structuredClone(legacy); custom.canvas.assetsWidth = 243; custom.editing.timelineHeight = 321;
  const normalized = normalizeWorkspaceLayout(custom);
  assert.equal(normalized.canvas.assetsWidth, 243); assert.equal(normalized.canvas.inspectorWidth, 310);
  assert.equal(normalized.editing.timelineHeight, 321);
});
