// In Canvas mode the flow pane is full-bleed and the docks, heading and storyboard float over it, so a plain
// fit-to-view would park nodes underneath them. These helpers turn the overlays' real geometry into per-side
// padding for React Flow's fitView. The selectors name the overlays rendered by App.jsx / WorkspacePanels.jsx.
export type FitPadding = { top: string; right: string; bottom: string; left: string };
export type Box = { left: number; top: number; right: number; bottom: number };
export type Side = 'left' | 'right' | 'top' | 'bottom';

const OVERLAYS: ReadonlyArray<readonly [Side, string]> = [
  ['left', '#dock-assets[data-visible="true"]'], ['left', '.recall-assets'],
  ['right', '#dock-inspector[data-visible="true"]'], ['right', '.recall-inspector'],
  ['top', '.board-toolbar-heading'], ['bottom', '.board-storyboard'],
];
const MAX_SHARE = 0.8;

/** Pure geometry: how far each side of `pane` is covered, plus `margin`, never more than 80% of an axis in total. */
export function fitPadding(pane: Box, overlays: ReadonlyArray<{ side: Side; box: Box }>, margin = 20): FitPadding {
  const inset: Record<Side, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const { side, box } of overlays) {
    const covered = side === 'left' ? box.right - pane.left : side === 'right' ? pane.right - box.left
      : side === 'top' ? box.bottom - pane.top : pane.bottom - box.top;
    inset[side] = Math.max(inset[side], covered);
  }
  const axis = (a: Side, b: Side, size: number) => {
    const first = inset[a] > 0 ? inset[a] + margin : margin, second = inset[b] > 0 ? inset[b] + margin : margin;
    const scale = Math.min(1, (MAX_SHARE * Math.max(size, 0)) / (first + second || 1));
    return [Math.round(first * scale), Math.round(second * scale)] as const;
  };
  const [left, right] = axis('left', 'right', pane.right - pane.left);
  const [top, bottom] = axis('top', 'bottom', pane.bottom - pane.top);
  return { top: `${top}px`, right: `${right}px`, bottom: `${bottom}px`, left: `${left}px` };
}

/** Measures the live overlays over `pane`; falls back to a plain fraction when the pane is not on screen. */
export function measuredFitPadding(pane: Element | null | undefined, fallback = 0.16, margin = 20): FitPadding | number {
  if (!pane) return fallback;
  const paneBox = pane.getBoundingClientRect();
  if (paneBox.width <= 0 || paneBox.height <= 0) return fallback;
  const root = pane.ownerDocument;
  const overlays: Array<{ side: Side; box: Box }> = [];
  for (const [side, selector] of OVERLAYS) for (const element of root.querySelectorAll(selector)) {
    if (!element.getClientRects().length) continue;
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) overlays.push({ side, box });
  }
  return fitPadding(paneBox, overlays, margin);
}
