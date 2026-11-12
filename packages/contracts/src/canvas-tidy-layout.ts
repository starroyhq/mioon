import { CANVAS_GRID, CANVAS_GRID_ORIGIN, canvasBoxesSeparated } from './canvas-position.ts';
import type { CanvasBox, CanvasGrid, CanvasPosition, CanvasSize } from './canvas-position.ts';

interface CanvasLayoutCard extends CanvasSize {
  readonly id: string;
  readonly position: CanvasPosition;
}

export interface CanvasLayoutShot extends CanvasLayoutCard { readonly orderIndex: number }
export interface CanvasLayoutNode extends CanvasLayoutCard { readonly type: string }
export interface CanvasLayoutEdge {
  readonly source: string;
  readonly target: string;
  readonly kind?: string;
  readonly role?: string;
}

export interface CanvasLayoutInput {
  /** The active cards only. Existing edges missing an active endpoint are ignored. */
  readonly shots: readonly CanvasLayoutShot[];
  readonly nodes: readonly CanvasLayoutNode[];
  readonly edges: readonly CanvasLayoutEdge[];
  /** Empty means all active cards. Non-card selection IDs never cause a full layout. */
  readonly selectedIds?: ReadonlySet<string>;
  readonly grid?: CanvasGrid;
}

export interface CanvasLayoutMove {
  readonly id: string;
  readonly kind: 'shot' | 'node';
  readonly position: CanvasPosition;
}

export type CanvasLayoutResult =
  | { readonly status: 'moved'; readonly moves: readonly CanvasLayoutMove[] }
  | { readonly status: 'no-movement' | 'no-fit'; readonly moves: readonly [] };

export const TIDY_SHOTS_PER_ROW = 10;

// Deterministic work limits keep dense inputs bounded on any machine.
const MAX_CARDS = 4096;
const MAX_EDGES = 16384;
const MAX_WORK = 8_000_000;
const SEARCH_RINGS = 12;
const GRID_SEARCH_SLACK = 512;
const NEARBY = [0, ...Array.from({ length: SEARCH_RINGS }, (_, index) => [-(index + 1), index + 1]).flat()];

type Positions = Map<string, CanvasBox>;
interface Budget { remaining: number }
interface Link { source: string; target: string; firstFrame: boolean }
type Adjacency = ReadonlyMap<string, readonly Link[]>;
interface Reference { node: CanvasLayoutNode; shots: readonly string[]; firstFrame: readonly string[]; links: readonly Link[] }
interface Endpoint { id: string; point: CanvasPosition; firstFrame: boolean }
interface Route { source: string; target: string; start: CanvasPosition; end: CanvasPosition }
interface ShotSlot { shot: CanvasLayoutShot; offset: number; step: number; remaining: number }
interface ShotRow { slots: ShotSlot[]; headroom: number; height: number; floor: number }

const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const compareNode = (a: CanvasLayoutNode, b: CanvasLayoutNode) => compareId(a.type, b.type) || compareId(a.id, b.id);
const byStory = (a: CanvasLayoutShot, b: CanvasLayoutShot) => a.orderIndex - b.orderIndex || compareId(a.id, b.id);
const boxAt = ({ width, height }: CanvasSize, { x, y }: CanvasPosition): CanvasBox => ({ x, y, width, height });
const centre = (box: CanvasBox): CanvasPosition => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const distance = (a: CanvasPosition, b: CanvasPosition) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const otherEnd = (link: Link, id: string) => link.source === id ? link.target : link.source;
const spend = (budget: Budget, amount: number) => (budget.remaining -= amount) >= 0;
const cardStep = (extent: number, step: number, gap: number) => Math.max(extent + gap, Math.ceil((extent + gap) / step) * step);

function validGrid({ columnWidth, rowHeight, gap, coordinateLimit }: CanvasGrid): boolean {
  const limit = CANVAS_GRID.coordinateLimit;
  return [columnWidth, rowHeight, coordinateLimit].every(value => Number.isFinite(value) && value > 0 && value <= limit)
    && Number.isFinite(gap) && gap >= 0 && gap < Math.min(columnWidth, rowHeight);
}

function validCard(card: CanvasLayoutCard): boolean {
  const max = CANVAS_GRID.coordinateLimit * 2;
  return card.id.length > 0 && Number.isFinite(card.width) && card.width > 0 && card.width <= max
    && Number.isFinite(card.height) && card.height > 0 && card.height <= max
    && Math.abs(card.position.x) <= max && Math.abs(card.position.y) <= max;
}

function inside(box: CanvasBox, limit: number): boolean {
  return box.x > -limit && box.y > -limit && box.x + box.width < limit && box.y + box.height < limit;
}

function clear(box: CanvasBox, placed: Positions, grid: CanvasGrid, budget: Budget, ignore?: string): boolean {
  if (!inside(box, grid.coordinateLimit) || !spend(budget, 1 + placed.size)) return false;
  for (const [id, obstacle] of placed) {
    if (id !== ignore && !canvasBoxesSeparated(box, obstacle, grid.gap)) return false;
  }
  return true;
}

/** Clamp a preferred start so the whole span can stay inside the open coordinate interval. */
function boundedStart(preferred: number, span: number, limit: number): number | undefined {
  const slack = 2 * limit - span;
  if (slack <= 0) return;
  const margin = Math.min(1, slack / 4);
  return Math.min(limit - span - margin, Math.max(-limit + margin, preferred));
}

function fixedLinkOrigin(
  cards: readonly { card: CanvasLayoutCard; offset: number }[],
  placed: Positions, adjacent: Adjacency, gap: number,
): CanvasPosition | undefined {
  const anchors: CanvasPosition[] = [], firstFrames: CanvasPosition[] = [];
  for (const { card, offset } of cards) {
    for (const link of adjacent.get(card.id) ?? []) {
      const other = placed.get(otherEnd(link, card.id));
      if (!other) continue;
      const hint = { x: other.x + (other.width - card.width) / 2 - offset, y: other.y + other.height + gap };
      anchors.push(hint);
      if (link.firstFrame) firstFrames.push(hint);
    }
  }
  const preferred = firstFrames.length ? firstFrames : anchors;
  if (!preferred.length) return;
  const middle = (axis: 'x' | 'y') => {
    const sorted = preferred.map(value => value[axis]).sort((a, b) => a - b);
    return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2;
  };
  return { x: middle('x'), y: middle('y') };
}

function placeShotRow(row: ShotRow, left: number, y: number, fixed: Positions, grid: CanvasGrid, budget: Budget): CanvasBox[] | undefined {
  const positions: CanvasBox[] = [];
  let nextX = -grid.coordinateLimit;
  for (const { shot, offset, step, remaining } of row.slots) {
    const start = boundedStart(left + offset, remaining, grid.coordinateLimit)!;
    const preferred = Math.max(start, nextX), previous = positions.at(-1);
    let found: CanvasBox | undefined;
    for (let skip = 0; skip <= SEARCH_RINGS * 2 && budget.remaining >= 0; skip++) {
      const box = boxAt(shot, { x: preferred + skip * grid.columnWidth, y });
      if ((!previous || canvasBoxesSeparated(previous, box, grid.gap)) && clear(box, fixed, grid, budget)) { found = box; break; }
    }
    if (!found) return;
    positions.push(found);
    nextX = found.x + step;
  }
  return positions;
}

function planShotRows(
  shots: readonly CanvasLayoutShot[], movableShots: readonly CanvasLayoutShot[], references: readonly Reference[],
  fixed: Positions, adjacent: Adjacency, grid: CanvasGrid, budget: Budget, finish: (positions: Positions) => boolean,
): Positions | undefined {
  if (!movableShots.length) {
    const trial = new Map(fixed);
    return finish(trial) ? trial : undefined;
  }
  const { gap, coordinateLimit, columnWidth, rowHeight } = grid;
  const rows: ShotRow[] = [], rowIndex = new Map<string, number>();
  const shotIds = new Set(shots.map(shot => shot.id));
  const wraps = movableShots.length > TIDY_SHOTS_PER_ROW;
  let storyOffset = 0, rowOffset = 0, anchorOffset = 0;
  let anchor: CanvasPosition | undefined;
  for (const shot of shots) {
    const step = cardStep(shot.width, columnWidth, gap);
    let row = rows.at(-1);
    if (!fixed.has(shot.id)) {
      if (!row || row.slots.length === TIDY_SHOTS_PER_ROW) {
        row = { slots: [], headroom: 0, height: 0, floor: -coordinateLimit };
        rows.push(row);
        rowOffset = 0;
      }
      rowIndex.set(shot.id, rows.length - 1);
      row.slots.push({ shot, offset: wraps ? rowOffset : storyOffset, step, remaining: 0 });
      row.height = Math.max(row.height, shot.height);
      rowOffset += step;
      // Fixed reference cards constrain only the shots they serve.
      for (const link of adjacent.get(shot.id) ?? []) {
        const id = otherEnd(link, shot.id), card = fixed.get(id);
        if (card && !shotIds.has(id)) row.floor = Math.max(row.floor, card.y + card.height + gap);
      }
    } else if (!anchor) {
      anchor = shot.position;
      anchorOffset = wraps ? (row?.slots.length === TIDY_SHOTS_PER_ROW ? 0 : rowOffset) : storyOffset;
    }
    storyOffset += step;
  }
  for (const { node, shots: served } of references) {
    const firstRow = served.find(id => rowIndex.has(id));
    if (firstRow === undefined) continue;
    const row = rows[rowIndex.get(firstRow)!]!;
    // A shared card is above its earliest row and reserves space there once.
    row.headroom = Math.max(row.headroom, node.height + gap);
  }
  for (const { slots } of rows) {
    let span = slots.at(-1)!.shot.width;
    for (let index = slots.length - 1; index >= 0; index--) {
      slots[index]!.remaining = span;
      if (index > 0) span += slots[index - 1]!.step;
    }
    if (span >= 2 * coordinateLimit) return;
  }

  const first = rows[0]!;
  const linked = anchor || !fixed.size ? undefined : fixedLinkOrigin(
    first.slots.map(({ shot, offset }) => ({ card: shot, offset })), fixed, adjacent, gap,
  );
  // A later row's reference can anchor columns without pushing all earlier rows down.
  const later = anchor || linked || !wraps || !fixed.size ? undefined : fixedLinkOrigin(
    rows.slice(1).flatMap(row => row.slots.map(({ shot, offset }) => ({ card: shot, offset }))), fixed, adjacent, gap,
  );
  const originX = (anchor?.x ?? linked?.x ?? later?.x ?? CANVAS_GRID_ORIGIN.x) - anchorOffset;
  const originY = anchor?.y ?? linked?.y ?? CANVAS_GRID_ORIGIN.y;
  const totalHeight = rows.reduce((height, row) => height + row.headroom + row.height, (rows.length - 1) * gap);
  const top = boundedStart(Math.max(originY, first.floor) - first.headroom, totalHeight, coordinateLimit);
  if (top === undefined) return;

  for (const ring of NEARBY) {
    const start = top + ring * rowHeight;
    if (start <= -coordinateLimit || start + totalHeight >= coordinateLimit || start + first.headroom < first.floor) continue;
    // Keep the preferred story row, trying earlier columns when fixed cards block the right.
    for (let shift = 0; shift <= SEARCH_RINGS && budget.remaining >= 0; shift++) {
      const left = originX - shift * columnWidth, trial = new Map(fixed);
      let bandTop = start, completed = 0;
      for (const row of rows) {
        let y = Math.max(bandTop + row.headroom, row.floor);
        let positions: CanvasBox[] | undefined;
        const skips = completed === 0 ? 0 : SEARCH_RINGS;
        for (let skip = 0; skip <= skips && y + row.height < coordinateLimit && budget.remaining >= 0; skip++, y += rowHeight) {
          positions = placeShotRow(row, left, y, fixed, grid, budget);
          if (positions) break;
        }
        if (!positions) break;
        row.slots.forEach(({ shot }, index) => trial.set(shot.id, positions[index]!));
        // The next band starts after this row's tallest shot, with room for its own reference cards.
        bandTop = y + row.height + gap;
        completed++;
      }
      if (completed === rows.length && finish(trial)) return trial;
    }
  }
}

function placeLoose(nodes: readonly CanvasLayoutNode[], movableShots: readonly CanvasLayoutShot[], placed: Positions, adjacent: Adjacency, grid: CanvasGrid, budget: Budget): boolean {
  if (nodes.length === 0) return true;
  const { columnWidth, rowHeight, gap, coordinateLimit } = grid;
  const width = Math.max(...nodes.map(node => node.width)), height = Math.max(...nodes.map(node => node.height));
  const pitchX = cardStep(width, columnWidth, gap), pitchY = cardStep(height, rowHeight, gap);
  const leftShot = movableShots[0] && placed.get(movableShots[0].id);
  const belowShots = movableShots.reduce((bottom, shot) => Math.max(bottom, placed.get(shot.id)!.y + shot.height + gap), -Infinity);
  const origin = fixedLinkOrigin(nodes.map(card => ({ card, offset: 0 })), placed, adjacent, gap)
    ?? (leftShot ? { x: leftShot.x, y: belowShots } : CANVAS_GRID_ORIGIN);
  const columns = Math.min(Math.ceil(Math.sqrt(nodes.length)), Math.ceil((2 * coordinateLimit - width) / pitchX));
  if (columns < 1) return false;
  const span = (columns - 1) * pitchX + width;
  const top = boundedStart(origin.y, height, coordinateLimit);
  if (top === undefined) return false;
  const tried = new Set<number>();
  for (const shift of NEARBY) {
    const left = boundedStart(origin.x + shift * columnWidth, span, coordinateLimit);
    if (left === undefined) return false;
    if (tried.has(left)) continue;
    tried.add(left);
    const trial = new Map(placed);
    let next = 0, count = 0;
    for (const node of nodes) {
      let found = false;
      while (next < nodes.length + GRID_SEARCH_SLACK && budget.remaining >= 0) {
        const row = Math.floor(next / columns);
        const dy = row % 2 === 0 ? -row / 2 : (row + 1) / 2;
        const box = boxAt(node, { x: left + (next++ % columns) * pitchX, y: top + dy * pitchY });
        if (!clear(box, trial, grid, budget)) continue;
        trial.set(node.id, box);
        found = true;
        break;
      }
      if (!found) break;
      count++;
    }
    if (count === nodes.length) {
      for (const node of nodes) placed.set(node.id, trial.get(node.id)!);
      return true;
    }
    if (budget.remaining < 0) break;
  }
  return false;
}

const turn = (a: CanvasPosition, b: CanvasPosition, c: CanvasPosition) =>
  Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

/** Straight segments between card centres estimate crossings; shared ends and collinear contacts do not count. */
function countCrossings(middle: CanvasPosition, id: string, ends: readonly Endpoint[], routes: readonly Route[], budget: Budget): number {
  if (!spend(budget, ends.length * routes.length)) return Infinity;
  let count = 0;
  for (const { id: endId, point } of ends) {
    for (const { source, target, start, end } of routes) {
      if (source === id || target === id || source === endId || target === endId) continue;
      if (turn(middle, point, start) * turn(middle, point, end) < 0 && turn(start, end, middle) * turn(start, end, point) < 0) count++;
    }
  }
  return count;
}

interface ScoredBox { box: CanvasBox; centre: CanvasPosition; length: number; firstFrame: number; crossings?: number }

/** Searches grid columns near the length-minimizing median and the story anchor, above every linked shot. */
function referencePosition(reference: Reference, placed: Positions, grid: CanvasGrid, budget: Budget, routes?: readonly Route[]): CanvasBox | undefined {
  const { node, shots, firstFrame, links } = reference;
  const shotBoxes = shots.map(id => placed.get(id)!);
  const anchor = centre(placed.get(firstFrame[0] ?? shots[0]!)!);
  const y = Math.min(...shotBoxes.map(box => box.y)) - node.height - grid.gap;
  const ends: Endpoint[] = [];
  for (const link of links) {
    const id = otherEnd(link, node.id), box = placed.get(id);
    if (box) ends.push({ id, point: centre(box), firstFrame: link.firstFrame });
  }
  const xs = ends.map(({ point }) => point.x).sort((a, b) => a - b);
  const lower = xs[Math.floor((xs.length - 1) / 2)]!, upper = xs[Math.floor(xs.length / 2)]!;
  const pitch = Math.min(grid.columnWidth, node.width + grid.gap);
  const columns = new Set<number>();
  for (const offset of NEARBY) {
    for (const middle of [(lower + upper) / 2, lower, upper, anchor.x]) columns.add(middle + offset * pitch);
  }

  let best: ScoredBox | undefined;
  function consider(box: CanvasBox): boolean {
    if (!inside(box, grid.coordinateLimit)) return false;
    if (!spend(budget, 1 + ends.length)) return false;
    const point = centre(box);
    let length = 0, firstFrameLength = 0;
    for (const end of ends) {
      const value = distance(point, end.point);
      length += value;
      if (end.firstFrame) firstFrameLength += value;
    }
    if ((best && length > best.length) || !clear(box, placed, grid, budget, node.id)) return false;
    const score: ScoredBox = { box, centre: point, length, firstFrame: firstFrameLength };
    if (best && length === best.length) {
      if (routes) {
        score.crossings = countCrossings(point, node.id, ends, routes, budget);
        best.crossings ??= countCrossings(best.centre, node.id, ends, routes, budget);
      }
      const tie = (score.crossings ?? 0) - (best.crossings ?? 0)
        || score.firstFrame - best.firstFrame
        || Math.abs(point.x - anchor.x) - Math.abs(best.centre.x - anchor.x)
        || best.box.y - box.y || box.x - best.box.x;
      if (tie >= 0) return false;
    }
    best = score;
    return true;
  }

  // During refinement, retain the initial location if the bounded candidates offer no improvement.
  const current = placed.get(node.id);
  if (current) consider(current);
  const direct = boxAt(node, { x: lower - node.width / 2, y });
  if (ends.length === 1 && consider(direct)) return direct;
  for (let row = 0; row <= SEARCH_RINGS && budget.remaining >= 0; row++) {
    for (const x of columns) {
      consider(boxAt(node, { x: x - node.width / 2, y: y - row * grid.rowHeight }));
      if (budget.remaining < 0) break;
    }
  }
  return budget.remaining < 0 ? undefined : best?.box;
}

function placeReferences(references: readonly Reference[], links: readonly Link[], placed: Positions, grid: CanvasGrid, budget: Budget): boolean {
  for (const reference of references) {
    const box = referencePosition(reference, placed, grid, budget);
    if (!box) return false;
    placed.set(reference.node.id, box);
  }
  // All endpoints now have deterministic positions. Refine shared references once in story order.
  for (const reference of references) {
    const id = reference.node.id;
    if (new Set(reference.links.map(link => otherEnd(link, id))).size < 2) continue;
    if (!spend(budget, links.length)) return false;
    const routes = links.filter(link => link.source !== id && link.target !== id).map(({ source, target }): Route =>
      ({ source, target, start: centre(placed.get(source)!), end: centre(placed.get(target)!) }));
    const box = referencePosition(reference, placed, grid, budget, routes);
    if (!box) return false;
    placed.set(id, box);
  }
  return true;
}

/** Plan a single atomic layout in canvas coordinates, with no mutation or dependence on the old movable positions. */
export function layoutCanvas({ shots, nodes, edges, selectedIds, grid = CANVAS_GRID }: CanvasLayoutInput): CanvasLayoutResult {
  const noFit: CanvasLayoutResult = { status: 'no-fit', moves: [] };
  if (!validGrid(grid) || shots.length + nodes.length > MAX_CARDS || edges.length > MAX_EDGES) return noFit;
  const story = [...shots].sort(byStory), otherCards = [...nodes].sort(compareNode);
  const cards = [...story, ...otherCards];
  const known = new Set(cards.map(card => card.id));
  if (known.size !== cards.length || !cards.every(validCard) || !story.every(shot => Number.isFinite(shot.orderIndex))) return noFit;
  const movable = new Set(cards.filter(card => !selectedIds?.size || selectedIds.has(card.id)).map(card => card.id));
  if (movable.size === 0) return { status: 'no-movement', moves: [] };
  const fixed: Positions = new Map(cards.filter(card => !movable.has(card.id)).map(card => [card.id, boxAt(card, card.position)]));
  const budget = { remaining: MAX_WORK };

  const rank = new Map(story.map((shot, index) => [shot.id, index]));
  const links = edges.filter(({ source, target }) => source !== target && known.has(source) && known.has(target))
    .map(({ source, target, kind, role }): Link => ({ source, target, firstFrame: kind === 'reference' && role === 'first_frame' }))
    .sort((a, b) => compareId(a.source, b.source) || compareId(a.target, b.target) || Number(b.firstFrame) - Number(a.firstFrame));
  const adjacent = new Map<string, Link[]>();
  for (const link of links) {
    for (const id of [link.source, link.target]) {
      const list = adjacent.get(id) ?? [];
      list.push(link);
      adjacent.set(id, list);
    }
  }
  const references: Reference[] = [], loose: CanvasLayoutNode[] = [];
  const shotOrder = (a: string, b: string) => rank.get(a)! - rank.get(b)!;
  for (const node of otherCards) {
    if (!movable.has(node.id)) continue;
    const connected = adjacent.get(node.id) ?? [];
    const served = new Set<string>(), bindings = new Set<string>();
    for (const link of connected) {
      const id = otherEnd(link, node.id);
      if (!rank.has(id)) continue;
      served.add(id);
      if (link.firstFrame) bindings.add(id);
    }
    if (served.size) references.push({ node, shots: [...served].sort(shotOrder), firstFrame: [...bindings].sort(shotOrder), links: connected });
    else loose.push(node);
  }
  references.sort((a, b) => Number(!a.firstFrame.length) - Number(!b.firstFrame.length)
    || shotOrder(a.firstFrame[0] ?? a.shots[0]!, b.firstFrame[0] ?? b.shots[0]!) || compareNode(a.node, b.node));

  const movableShots = story.filter(shot => movable.has(shot.id));
  const placed = planShotRows(story, movableShots, references, fixed, adjacent, grid, budget, positions =>
    placeLoose(loose, movableShots, positions, adjacent, grid, budget)
    && placeReferences(references, links, positions, grid, budget));
  if (!placed) return noFit;

  const moves: CanvasLayoutMove[] = [];
  for (const card of cards) {
    if (!movable.has(card.id)) continue;
    const { x, y } = placed.get(card.id)!;
    if (x !== card.position.x || y !== card.position.y) moves.push({ id: card.id, kind: rank.has(card.id) ? 'shot' : 'node', position: { x, y } });
  }
  return moves.length ? { status: 'moved', moves } : { status: 'no-movement', moves: [] };
}
