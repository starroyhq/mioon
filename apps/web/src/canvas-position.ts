export interface CanvasPosition { readonly x: number; readonly y: number }
export interface PositionedCanvasRecord { readonly position?: CanvasPosition }
// Nodes render at most 240 × 232; reserve room for ports and a 32px gutter.
const width = 272, height = 264;
const usable = (position: CanvasPosition | undefined): position is CanvasPosition => Boolean(position && Number.isFinite(position.x) && Number.isFinite(position.y) && Math.abs(position.x) < 10_000_000 && Math.abs(position.y) < 10_000_000);
/** Keeps the requested position when clear, otherwise searches a bounded grid
 * around it. Existing nodes never move; the fallback lies beyond their bounds. */
export function chooseCanvasPosition(records: readonly PositionedCanvasRecord[], preferred: CanvasPosition): CanvasPosition {
  const base = usable(preferred) ? preferred : { x: 100, y: 80 };
  const occupied = records.flatMap(record => usable(record.position) ? [record.position] : []);
  const clear = (candidate: CanvasPosition) => occupied.every(position => Math.abs(candidate.x - position.x) >= width || Math.abs(candidate.y - position.y) >= height);
  if (clear(base)) return { ...base };
  for (let ring = 1; ring <= 12; ring++) {
    for (let row = -ring; row <= ring; row++) for (let column = -ring; column <= ring; column++) {
      if (Math.abs(row) !== ring && Math.abs(column) !== ring) continue;
      const candidate = { x: base.x + column * width, y: base.y + row * height };
      if (clear(candidate)) return candidate;
    }
  }
  return { x: occupied.reduce((maximum, position) => Math.max(maximum, position.x), base.x) + width, y: base.y };
}
