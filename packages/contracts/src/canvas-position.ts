export interface CanvasPosition { readonly x: number; readonly y: number }
export interface CanvasSize { readonly width: number; readonly height: number }
export interface CanvasBox extends CanvasPosition, CanvasSize {}

export interface CanvasGrid {
  readonly columnWidth: number;
  readonly rowHeight: number;
  readonly gap: number;
  readonly coordinateLimit: number;
}

// Up to 240 × 232 for standard cards, plus room for ports and a 32px gutter.
export const CANVAS_GRID: CanvasGrid = Object.freeze({
  columnWidth: 272, rowHeight: 264, gap: 32, coordinateLimit: 10_000_000,
});
export const CANVAS_GRID_ORIGIN: CanvasPosition = Object.freeze({ x: 100, y: 80 });

export function canvasBoxesSeparated(a: CanvasBox, b: CanvasBox, gap: number): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  return dx >= a.width + gap || -dx >= b.width + gap || dy >= a.height + gap || -dy >= b.height + gap;
}
