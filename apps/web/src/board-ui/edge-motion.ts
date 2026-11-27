/** Zoom threshold (25%) at or below which board edges render statically so
 * large-board panning stays smooth while keeping lines, labels and hit areas. */
export const BOARD_STATIC_EDGE_ZOOM_THRESHOLD = 0.25;

export function shouldUseStaticBoardEdges(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom <= BOARD_STATIC_EDGE_ZOOM_THRESHOLD;
}
