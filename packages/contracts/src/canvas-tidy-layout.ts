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

function planShotRow(
  shots: readonly CanvasLayoutShot[], movable: ReadonlySet<string>, fixed: Positions, adjacent: Adjacency,
  headroom: number, grid: CanvasGrid, budget: Budget, finish: (positions: Positions) => boolean,
): Positions | undefined {
  const steps = shots.map(shot => cardStep(shot.width, grid.columnWidth, grid.gap));
  const shotIds = new Set(shots.map(shot => shot.id));
  const row: { shot: CanvasLayoutShot; offset: number; step: number; remaining: number }[] = [];
  let offset = 0, anchorOffset = 0;
  let anchor: CanvasPosition | undefined;
  for (const [index, shot] of shots.entries()) {
    const step = steps[index]!;
    if (movable.has(shot.id)) row.push({ shot, offset, step, remaining: 0 });
    else if (!anchor) { anchor = shot.position; anchorOffset = offset; }
    offset += step;
  }
  if (row.length === 0) {
    const trial = new Map(fixed);
    return finish(trial) ? trial : undefined;
  }
  let span = row.at(-1)!.shot.width;
  for (let index = row.length - 1; index >= 0; index--) {
    row[index]!.remaining = span;
    if (index > 0) span += row[index - 1]!.step;
  }
  const origin = anchor ?? fixedLinkOrigin(row.map(({ shot, offset }) => ({ card: shot, offset })), fixed, adjacent, grid.gap) ?? CANVAS_GRID_ORIGIN;
  const maxHeight = Math.max(...row.map(({ shot }) => shot.height));
  // Unselected reference cards keep their positions. Selected shots can still pass below them.
  let floor = -grid.coordinateLimit;
  for (const { shot } of row) {
    for (const link of adjacent.get(shot.id) ?? []) {
      const id = otherEnd(link, shot.id);
      const card = fixed.get(id);
      if (card && !shotIds.has(id)) floor = Math.max(floor, card.y + card.height + grid.gap);
    }
  }
  const top = boundedStart(Math.max(origin.y, floor) - headroom, maxHeight + headroom, grid.coordinateLimit);
  if (top === undefined || span >= 2 * grid.coordinateLimit) return;

  for (const ring of NEARBY) {
    const y = top + headroom + ring * grid.rowHeight;
    if (y < floor || y - headroom <= -grid.coordinateLimit || y + maxHeight >= grid.coordinateLimit) continue;
    // A fixed wall can block the preferred columns to the right. Try starting farther left on the same story row.
    for (let shift = 0; shift <= SEARCH_RINGS; shift++) {
      const positions: CanvasBox[] = [];
      let nextX = -grid.coordinateLimit;
      for (const { shot, offset, step, remaining } of row) {
        const desired = origin.x + offset - anchorOffset - shift * grid.columnWidth;
        const start = boundedStart(desired, remaining, grid.coordinateLimit)!;
        // Earlier movable shots are clear by construction because nextX advances by at least width + gap.
        const preferred = Math.max(start, nextX);
        const previous = positions.at(-1);
        let found: CanvasBox | undefined;
        for (let skip = 0; skip <= SEARCH_RINGS * 2 && budget.remaining >= 0; skip++) {
          const box = boxAt(shot, { x: preferred + skip * grid.columnWidth, y });
          if ((!previous || canvasBoxesSeparated(previous, box, grid.gap)) && clear(box, fixed, grid, budget)) { found = box; break; }
        }
        if (!found) break;
        positions.push(found);
        nextX = found.x + step;
      }
      if (positions.length === row.length) {
        const trial = new Map(fixed);
        row.forEach(({ shot }, index) => trial.set(shot.id, positions[index]!));
        // A row is accepted only when its references and the rest of the grid can also fit.
        if (finish(trial)) return trial;
      }
      if (budget.remaining < 0) return;
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
  const headroom = references.reduce((space, ref) => ref.shots.some(id => movable.has(id))
    ? Math.max(space, ref.node.height + grid.gap) : space, 0);
  const placed = planShotRow(story, movable, fixed, adjacent, headroom, grid, budget, positions =>
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
