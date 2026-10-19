// Preferred panel dimensions are durable. Effective dimensions are derived from
// the current viewport and must never be written back during a window resize.
export type PanelSizeKey='assetsWidth'|'inspectorWidth'|'timelineHeight';
export interface PanelSizeBounds {readonly default: number; readonly min: number; readonly max: number}
export const PANEL_BOUNDS: Readonly<Record<PanelSizeKey,PanelSizeBounds>> = Object.freeze({
  assetsWidth: Object.freeze({ default: 260, min: 180, max: 480 }),
  inspectorWidth: Object.freeze({ default: 320, min: 240, max: 560 }),
  timelineHeight: Object.freeze({ default: 300, min: 160, max: 800 }),
});
export interface LayoutVisibility {
  readonly assetsCollapsed?: unknown;
  readonly inspectorCollapsed?: unknown;
  readonly [key: string]: unknown;
}
export interface WorkspaceModeLayout {
  assetsWidth: number;
  inspectorWidth: number;
  assetsCollapsed: boolean;
  inspectorCollapsed: boolean;
}
export interface WorkspaceEditingLayout extends WorkspaceModeLayout {timelineHeight: number}
export interface WorkspaceLayout {canvas: WorkspaceModeLayout; editing: WorkspaceEditingLayout}
export interface EffectiveWorkspaceLayout extends WorkspaceModeLayout {
  timelineHeight: number;
  assetsMaxWidth: number;
  inspectorMaxWidth: number;
  timelineMaxHeight: number;
}
export interface LayoutMetricsOptions {
  width?: number;
  height?: number;
  centerMinWidth?: number;
  centerMinHeight?: number;
  centerComfortHeight?: number;
  timelineFloorHeight?: number;
  collapsedWidth?: number;
  separatorSize?: number;
}
const isFiniteNumber=(value: unknown): value is number=>typeof value==='number'&&Number.isFinite(value);
const record=(value: unknown): Record<string, unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const property=(value: unknown,key: string): unknown=>record(value)?.[key];

export function clampPanelSize(key: PanelSizeKey,value: unknown): number {
  const bounds = PANEL_BOUNDS[key];
  return isFiniteNumber(value) ? Math.max(bounds.min, Math.min(bounds.max, value)) : bounds.default;
}

export function defaultWorkspaceLayout(shared: LayoutVisibility = {}): WorkspaceLayout {
  const mode = (): WorkspaceModeLayout => ({
    assetsWidth: PANEL_BOUNDS.assetsWidth.default,
    inspectorWidth: PANEL_BOUNDS.inspectorWidth.default,
    assetsCollapsed: shared.assetsCollapsed === true,
    inspectorCollapsed: shared.inspectorCollapsed === true,
  });
  return { canvas: mode(), editing: { ...mode(), timelineHeight: PANEL_BOUNDS.timelineHeight.default } };
}

export function normalizeWorkspaceLayout(value: unknown,shared: LayoutVisibility = {}): WorkspaceLayout {
  if (value === undefined) return defaultWorkspaceLayout(shared);
  // Only the exact former default pair is migrated; customized dimensions keep
  // their saved meaning. A viewport resize still never changes preferred sizes.
  const legacyDefaults = (source: unknown): boolean => property(source,'assetsWidth') === 242 && property(source,'inspectorWidth') === 310;
  const mode = (source: unknown): WorkspaceModeLayout => ({
    assetsWidth: legacyDefaults(source) ? PANEL_BOUNDS.assetsWidth.default : clampPanelSize('assetsWidth', property(source,'assetsWidth')),
    inspectorWidth: legacyDefaults(source) ? PANEL_BOUNDS.inspectorWidth.default : clampPanelSize('inspectorWidth', property(source,'inspectorWidth')),
    assetsCollapsed: property(source,'assetsCollapsed') === true,
    inspectorCollapsed: property(source,'inspectorCollapsed') === true,
  });
  const editing=record(property(value,'editing'));
  const timelineHeight = legacyDefaults(editing) && property(editing,'timelineHeight') === 320
    ? PANEL_BOUNDS.timelineHeight.default : clampPanelSize('timelineHeight', property(editing,'timelineHeight'));
  return { canvas: mode(property(value,'canvas')), editing: { ...mode(editing), timelineHeight } };
}

// Used at cache/transport boundaries. Only the entire layout may be omitted by a
// legacy caller; a supplied layout must be complete, bounded and exact.
export function isWorkspaceLayout(value: unknown): value is WorkspaceLayout {
  const exact = (object: unknown,keys: readonly string[]): boolean => object !== null && typeof object === 'object' && !Array.isArray(object) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(object)) && Reflect.ownKeys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  if (!exact(value, ['canvas', 'editing'])) return false;
  const layout=value as Record<string, unknown>;
  return ['canvas', 'editing'].every(mode => {
    const source = layout[mode], dimensions = mode === 'editing' ? ['assetsWidth', 'inspectorWidth', 'timelineHeight'] : ['assetsWidth', 'inspectorWidth'];
    if(!exact(source, [...dimensions, 'assetsCollapsed', 'inspectorCollapsed']))return false;
    const modeRecord=source as Record<string, unknown>;
    return dimensions.every(key => {
      const item=modeRecord[key], bounds=PANEL_BOUNDS[key as PanelSizeKey];
      return isFiniteNumber(item) && item >= bounds.min && item <= bounds.max;
    }) &&
      typeof modeRecord.assetsCollapsed === 'boolean' && typeof modeRecord.inspectorCollapsed === 'boolean';
  });
}

const nonnegative = (value: unknown,fallback: number): number=>isFiniteNumber(value) ? Math.max(0, value) : fallback;

/** Derive one mode's geometry without changing its preferred size or visibility. */
export function effectiveWorkspaceLayout(preferred: Partial<WorkspaceEditingLayout>|null|undefined, {
  width = Infinity, height = Infinity, centerMinWidth = 320, centerMinHeight = 180,
  centerComfortHeight = 0, timelineFloorHeight = 0, collapsedWidth = 44, separatorSize = 6,
}: LayoutMetricsOptions = {}): EffectiveWorkspaceLayout {
  const assetsCollapsed = preferred?.assetsCollapsed === true, inspectorCollapsed = preferred?.inspectorCollapsed === true;
  const collapsed = nonnegative(collapsedWidth, 44), separator = nonnegative(separatorSize, 6);
  const availableWidth = nonnegative(width, Infinity), availableHeight = nonnegative(height, Infinity);
  const budget = Math.max(0, availableWidth - nonnegative(centerMinWidth, 320) - 2 * separator);
  const sides = [
    { value: assetsCollapsed ? collapsed : clampPanelSize('assetsWidth', preferred?.assetsWidth), min: assetsCollapsed ? collapsed : PANEL_BOUNDS.assetsWidth.min },
    { value: inspectorCollapsed ? collapsed : clampPanelSize('inspectorWidth', preferred?.inspectorWidth), min: inspectorCollapsed ? collapsed : PANEL_BOUNDS.inspectorWidth.min },
  ];
  const total = sides[0]!.value + sides[1]!.value, minimum = sides[0]!.min + sides[1]!.min;
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
  const assetsWidth = sides[0]!.value, inspectorWidth = sides[1]!.value;
  // The center asks for centerComfortHeight as long as the timeline can still keep timelineFloorHeight;
  // below that the center yields down to its hard minimum. Both default to the plain minimum.
  const centerReserve = Math.max(nonnegative(centerMinHeight, 180), Math.min(nonnegative(centerComfortHeight, 0), availableHeight - separator - nonnegative(timelineFloorHeight, 0)));
  const timelineMaxHeight = Math.min(PANEL_BOUNDS.timelineHeight.max, Math.max(0, availableHeight - centerReserve - separator));
  return {
    assetsWidth, inspectorWidth, assetsCollapsed, inspectorCollapsed,
    timelineHeight: Math.min(clampPanelSize('timelineHeight', preferred?.timelineHeight), timelineMaxHeight),
    assetsMaxWidth: Math.min(PANEL_BOUNDS.assetsWidth.max, Math.max(0, budget - inspectorWidth)),
    inspectorMaxWidth: Math.min(PANEL_BOUNDS.inspectorWidth.max, Math.max(0, budget - assetsWidth)),
    timelineMaxHeight,
  };
}
