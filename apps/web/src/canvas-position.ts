import { CANVAS_GRID, CANVAS_GRID_ORIGIN, canvasBoxesSeparated } from '../../../packages/contracts/src/canvas-position.ts';
import type { CanvasPosition } from '../../../packages/contracts/src/canvas-position.ts';

export type { CanvasPosition };
export interface PositionedCanvasRecord { readonly position?: CanvasPosition }
const { columnWidth, rowHeight, gap, coordinateLimit } = CANVAS_GRID;
const standardCard = { width: columnWidth - gap, height: rowHeight - gap };
const usable = (position: CanvasPosition | undefined): position is CanvasPosition => Boolean(position && Number.isFinite(position.x) && Number.isFinite(position.y) && Math.abs(position.x) < coordinateLimit && Math.abs(position.y) < coordinateLimit);
/** Keeps the requested position when clear, otherwise searches a bounded grid
 * around it. Existing nodes never move; the fallback lies beyond their bounds. */
export function chooseCanvasPosition(records: readonly PositionedCanvasRecord[], preferred: CanvasPosition): CanvasPosition {
  const base = usable(preferred) ? preferred : CANVAS_GRID_ORIGIN;
  const occupied = records.flatMap(record => usable(record.position) ? [{ ...record.position, ...standardCard }] : []);
  const clear = (candidate: CanvasPosition) => {
    const box = { ...candidate, ...standardCard };
    return occupied.every(position => canvasBoxesSeparated(box, position, gap));
  };
  if (clear(base)) return { ...base };
  for (let ring = 1; ring <= 12; ring++) {
    for (let row = -ring; row <= ring; row++) for (let column = -ring; column <= ring; column++) {
      if (Math.abs(row) !== ring && Math.abs(column) !== ring) continue;
      const candidate = { x: base.x + column * columnWidth, y: base.y + row * rowHeight };
      if (clear(candidate)) return candidate;
    }
  }
  return { x: occupied.reduce((maximum, position) => Math.max(maximum, position.x), base.x) + columnWidth, y: base.y };
}
