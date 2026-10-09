// Preferred panel dimensions are durable. Effective dimensions are derived from
// the current viewport and must never be written back during a window resize.
export const PANEL_BOUNDS = Object.freeze({
  assetsWidth: Object.freeze({ default: 242, min: 180, max: 480 }),
  inspectorWidth: Object.freeze({ default: 310, min: 240, max: 560 }),
  timelineHeight: Object.freeze({ default: 320, min: 160, max: 800 }),
});

export function clampPanelSize(key, value) {
  const bounds = PANEL_BOUNDS[key];
  return Number.isFinite(value) ? Math.max(bounds.min, Math.min(bounds.max, value)) : bounds.default;
}

export function defaultWorkspaceLayout(shared = {}) {
  const mode = () => ({
    assetsWidth: PANEL_BOUNDS.assetsWidth.default,
    inspectorWidth: PANEL_BOUNDS.inspectorWidth.default,
    assetsCollapsed: shared.assetsCollapsed === true,
    inspectorCollapsed: shared.inspectorCollapsed === true,
  });
  return { canvas: mode(), editing: { ...mode(), timelineHeight: PANEL_BOUNDS.timelineHeight.default } };
}

export function normalizeWorkspaceLayout(value, shared = {}) {
  if (value === undefined) return defaultWorkspaceLayout(shared);
  const mode = source => ({
    assetsWidth: clampPanelSize('assetsWidth', source?.assetsWidth),
    inspectorWidth: clampPanelSize('inspectorWidth', source?.inspectorWidth),
    assetsCollapsed: source?.assetsCollapsed === true,
    inspectorCollapsed: source?.inspectorCollapsed === true,
  });
  return { canvas: mode(value?.canvas), editing: { ...mode(value?.editing), timelineHeight: clampPanelSize('timelineHeight', value?.editing?.timelineHeight) } };
}

// Used at cache/transport boundaries. Only the entire layout may be omitted by a
// legacy caller; a supplied layout must be complete, bounded and exact.
export function isWorkspaceLayout(value) {
  const exact = (object, keys) => object !== null && typeof object === 'object' && !Array.isArray(object) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(object)) && Reflect.ownKeys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  if (!exact(value, ['canvas', 'editing'])) return false;
  return ['canvas', 'editing'].every(mode => {
    const source = value[mode], dimensions = mode === 'editing' ? ['assetsWidth', 'inspectorWidth', 'timelineHeight'] : ['assetsWidth', 'inspectorWidth'];
    return exact(source, [...dimensions, 'assetsCollapsed', 'inspectorCollapsed']) &&
      dimensions.every(key => Number.isFinite(source[key]) && source[key] >= PANEL_BOUNDS[key].min && source[key] <= PANEL_BOUNDS[key].max) &&
      typeof source.assetsCollapsed === 'boolean' && typeof source.inspectorCollapsed === 'boolean';
  });
}

const nonnegative = (value, fallback) => Number.isFinite(value) ? Math.max(0, value) : fallback;

/** Derive one mode's geometry without changing its preferred size or visibility. */
export function effectiveWorkspaceLayout(preferred, {
  width = Infinity, height = Infinity, centerMinWidth = 320, centerMinHeight = 180,
  collapsedWidth = 44, separatorSize = 6,
} = {}) {
  const assetsCollapsed = preferred?.assetsCollapsed === true, inspectorCollapsed = preferred?.inspectorCollapsed === true;
  const collapsed = nonnegative(collapsedWidth, 44), separator = nonnegative(separatorSize, 6);
  const availableWidth = nonnegative(width, Infinity), availableHeight = nonnegative(height, Infinity);
  const budget = Math.max(0, availableWidth - nonnegative(centerMinWidth, 320) - 2 * separator);
  const sides = [
    { value: assetsCollapsed ? collapsed : clampPanelSize('assetsWidth', preferred?.assetsWidth), min: assetsCollapsed ? collapsed : PANEL_BOUNDS.assetsWidth.min },
    { value: inspectorCollapsed ? collapsed : clampPanelSize('inspectorWidth', preferred?.inspectorWidth), min: inspectorCollapsed ? collapsed : PANEL_BOUNDS.inspectorWidth.min },
  ];
  const total = sides[0].value + sides[1].value, minimum = sides[0].min + sides[1].min;
  if (total > budget) {
    if (budget >= minimum) {
      const ratio = (budget - minimum) / (total - minimum);
      for (const side of sides) side.value = side.min + (side.value - side.min) * ratio;
    } else {
      // Very narrow layouts may choose a single-panel presentation. Even before
      // that breakpoint, derived geometry must stay nonnegative and bounded.
      for (const side of sides) side.value = minimum ? side.min * budget / minimum : 0;
    }
  }
  const assetsWidth = sides[0].value, inspectorWidth = sides[1].value;
  const timelineMaxHeight = Math.min(PANEL_BOUNDS.timelineHeight.max, Math.max(0, availableHeight - nonnegative(centerMinHeight, 180) - separator));
  return {
    assetsWidth, inspectorWidth, assetsCollapsed, inspectorCollapsed,
    timelineHeight: Math.min(clampPanelSize('timelineHeight', preferred?.timelineHeight), timelineMaxHeight),
    assetsMaxWidth: Math.min(PANEL_BOUNDS.assetsWidth.max, Math.max(0, budget - inspectorWidth)),
    inspectorMaxWidth: Math.min(PANEL_BOUNDS.inspectorWidth.max, Math.max(0, budget - assetsWidth)),
    timelineMaxHeight,
  };
}
