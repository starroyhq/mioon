import test from 'node:test';
import assert from 'node:assert/strict';
import { CANVAS_GRID } from '../packages/contracts/src/canvas-position.ts';
import { layoutCanvas } from '../packages/contracts/src/canvas-tidy-layout.ts';
import type { CanvasLayoutEdge, CanvasLayoutNode, CanvasLayoutShot } from '../packages/contracts/src/canvas-tidy-layout.ts';

type LayoutInput = Parameters<typeof layoutCanvas>[0];
type LayoutResult = ReturnType<typeof layoutCanvas>;
type Point = CanvasLayoutShot['position'];
type Card = CanvasLayoutShot | CanvasLayoutNode;

function shot(id: string, orderIndex: number, x: number, y: number, width = 240, height = 232): CanvasLayoutShot {
  return { id, orderIndex, width, height, position: { x, y } };
}

function node(id: string, type: string, x: number, y: number, width = 240, height = 232): CanvasLayoutNode {
  return { id, type, width, height, position: { x, y } };
}

function edge(source: string, target: string, firstFrame = false): CanvasLayoutEdge {
  return firstFrame ? { source, target, kind: 'reference', role: 'first_frame' } : { source, target };
}

function applyMoves(input: LayoutInput, { moves }: LayoutResult): LayoutInput {
  const positions = new Map(moves.map(move => [move.id, move.position]));
  return {
    ...input,
    shots: input.shots.map(item => ({ ...item, position: positions.get(item.id) ?? item.position })),
    nodes: input.nodes.map(item => ({ ...item, position: positions.get(item.id) ?? item.position })),
  };
}

function center(card: Card): Point {
  return { x: card.position.x + card.width / 2, y: card.position.y + card.height / 2 };
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function properCrossing(a: Point, b: Point, c: Point, d: Point): boolean {
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}

function overlaps(a: Card, b: Card): boolean {
  return a.position.x < b.position.x + b.width && b.position.x < a.position.x + a.width
    && a.position.y < b.position.y + b.height && b.position.y < a.position.y + a.height;
}

function hasOverlap(cards: readonly Card[]): boolean {
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) if (overlaps(cards[i]!, cards[j]!)) return true;
  }
  return false;
}

function geometry(input: LayoutInput) {
  const cards = [...input.shots, ...input.nodes];
  const centers = new Map(cards.map(card => [card.id, center(card)]));
  const segments = input.edges.flatMap(({ source, target }) => {
    const a = centers.get(source), b = centers.get(target);
    return a && b && source !== target ? [{ a, b, source, target }] : [];
  });
  const edgeLength = segments.reduce((sum, { a, b }) => sum + Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 0);
  let crossings = 0;
  for (let i = 0; i < segments.length; i++) {
    const { a, b, source, target } = segments[i]!;
    for (let j = i + 1; j < segments.length; j++) {
      const other = segments[j]!;
      if (source === other.source || source === other.target || target === other.source || target === other.target) continue;
      if (properCrossing(a, b, other.a, other.b)) crossings++;
    }
  }
  const width = cards.length === 0 ? 0 : Math.max(...cards.map(card => card.position.x + card.width))
    - Math.min(...cards.map(card => card.position.x));
  const height = cards.length === 0 ? 0 : Math.max(...cards.map(card => card.position.y + card.height))
    - Math.min(...cards.map(card => card.position.y));
  return { edgeLength, crossings, overlap: hasOverlap(cards), width, height };
}

function assertStoryRow(input: LayoutInput, orderedIds: readonly string[]) {
  const row = new Map(input.shots.map(item => [item.id, item]));
  const ordered = orderedIds.map(id => row.get(id)!);
  assert.equal(new Set(ordered.map(item => item.position.y)).size, ordered.length === 0 ? 0 : 1);
  const gap = (input.grid ?? CANVAS_GRID).gap;
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]!, current = ordered[index]!;
    assert.ok(current.position.x >= previous.position.x + previous.width + gap, `${previous.id} precedes ${current.id} with a gutter`);
  }
}

function series(count: number): LayoutInput {
  const { columnWidth, rowHeight } = CANVAS_GRID;
  const shots = Array.from({ length: count }, (_, index) => shot(
    `shot-${index}`, index, (index % 25) * columnWidth * 2 + 600, Math.floor(index / 25) * rowHeight * 4 + 4000,
  ));
  const nodes = shots.map((item, index) => node(
    `ref-${index}`, index % 2 === 0 ? 'image' : 'text',
    ((count - 1 - index) % 25) * columnWidth * 2 + 840, item.position.y - rowHeight,
  ));
  return { shots, nodes, edges: nodes.map((item, index) => edge(item.id, shots[index]!.id, item.type === 'image')) };
}

function dense(): LayoutInput {
  const { shots } = series(12);
  const nodes: CanvasLayoutNode[] = [], edges: CanvasLayoutEdge[] = [];
  for (const [index, item] of shots.entries()) {
    for (let lane = 0; lane < 4; lane++) {
      const reference = node(`ref-${index}-${lane}`, lane % 2 === 0 ? 'image' : 'text',
        item.position.x, item.position.y - (lane + 1) * 320, 180 + lane * 12, 92 + lane * 21);
      nodes.push(reference);
      edges.push(edge(reference.id, item.id, lane === 0));
      if (lane < 2) edges.push(edge(reference.id, shots[(index + 1) % shots.length]!.id));
    }
  }
  return { shots, nodes, edges };
}

const shared: LayoutInput = {
  shots: [shot('left', 0, 900, 950), shot('middle', 1, 1800, 950), shot('right', 2, 2700, 950)],
  nodes: [node('shared', 'image', 50, 50)],
  edges: [edge('shared', 'left'), edge('shared', 'middle', true), edge('shared', 'right')],
};

const reordered: LayoutInput = {
  shots: [shot('last', 10, 700, 650, 336, 164), shot('ä', 3, 1520, 1200, 160, 180),
    shot('z', 3, 980, 80, 136, 300), shot('a', 3, 2000, 200, 240, 200)],
  nodes: [],
  edges: [],
};

const mixed: LayoutInput = {
  shots: [shot('move-shot', 0, 2200, 1100), shot('fixed-shot', 1, 1200, 600)],
  nodes: [node('fixed-node', 'text', 100, 80), node('move-ref', 'image', 400, 1100, 192, 144)],
  edges: [edge('move-ref', 'move-shot', true), edge('move-ref', 'fixed-shot'), edge('fixed-node', 'fixed-shot')],
  selectedIds: new Set(['move-ref', 'move-shot']),
};

const cycles: LayoutInput = {
  shots: [],
  nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'isolated'].map((id, index) => node(id, 'text', 800 + index * 320, 1800, 180, 120)),
  edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('d', 'e'), edge('e', 'f'), edge('f', 'd'), edge('c', 'd')],
};

const samples: readonly { name: string; input: LayoutInput; story?: readonly string[] }[] = [
  { name: 'empty', input: { shots: [], nodes: [], edges: [] } },
  { name: 'single-shot', input: { shots: [shot('only', 0, 700, 1500)], nodes: [], edges: [] }, story: ['only'] },
  { name: 'story-reorder', input: reordered, story: ['a', 'z', 'ä', 'last'] },
  { name: 'selection', input: mixed },
  { name: 'shared-reference', input: shared, story: ['left', 'middle', 'right'] },
  { name: 'multiple-cycles', input: cycles },
  { name: 'dense', input: dense(), story: Array.from({ length: 12 }, (_, index) => `shot-${index}`) },
  ...[50, 200, 500].map(count => ({
    name: `large-${count}`, input: series(count), story: Array.from({ length: count }, (_, index) => `shot-${index}`),
  })),
];

for (const { name, input, story } of samples) test(`canvas tidy layout: ${name}`, t => {
  const original = structuredClone(input);
  const start = performance.now();
  const result = layoutCanvas(input);
  const elapsedMs = Number((performance.now() - start).toFixed(3));
  assert.equal(result.status, name === 'empty' ? 'no-movement' : 'moved');
  assert.deepEqual(input, original, 'layout preserves all input data');
  const final = applyMoves(input, result);
  const after = geometry(final);
  assert.equal(after.overlap, false, 'laid-out cards do not overlap');
  const movable = input.selectedIds?.size ? input.selectedIds : new Set([...input.shots, ...input.nodes].map(item => item.id));
  const kinds = new Map([...input.shots.map(item => [item.id, 'shot'] as const), ...input.nodes.map(item => [item.id, 'node'] as const)]);
  assert.equal(new Set(result.moves.map(move => move.id)).size, result.moves.length, 'each object is moved at most once');
  for (const move of result.moves) {
    assert.ok(movable.has(move.id), `only selected objects move: ${move.id}`);
    assert.equal(move.kind, kinds.get(move.id));
  }
  if (story) assertStoryRow(final, story);
  const reversed = {
    ...input,
    shots: [...input.shots].reverse(),
    nodes: [...input.nodes].reverse(),
    edges: [...input.edges].reverse(),
    selectedIds: input.selectedIds && new Set([...input.selectedIds].reverse()),
  };
  assert.deepEqual(layoutCanvas(reversed), result, 'input enumeration does not change positions or the move order');
  assert.deepEqual(layoutCanvas(final), { status: 'no-movement', moves: [] }, 'applying a tidy layout makes a second run a no-op');
  t.diagnostic(`LY_LAYOUT_SAMPLE ${JSON.stringify({
    name, shots: input.shots.length, nodes: input.nodes.length, edges: input.edges.length,
    moves: result.moves.length, before: geometry(input), after, elapsedMs,
  })}`);
});

test('a shared reference is placed once and minimizes total Manhattan edge length above its three shots', () => {
  const result = layoutCanvas(shared);
  assert.equal(result.status, 'moved');
  assert.equal(result.moves.filter(move => move.id === 'shared').length, 1);
  const final = applyMoves(shared, result);
  const [left, middle, right] = final.shots, reference = final.nodes[0]!;
  assert.ok(reference.position.y + reference.height + CANVAS_GRID.gap <= middle!.position.y);
  // The horizontal minimum is the span of the two outer centers, attained at
  // the median. The nearest clear upper position attains the vertical minimum.
  const minimum = center(right!).x - center(left!).x + 3 * (reference.height + CANVAS_GRID.gap);
  assert.equal(geometry(final).edgeLength, minimum);
});

test('a shared reference breaks a shortest-length tie by avoiding a fixed edge crossing', () => {
  const left = 100, top = 80;
  const right = left + 2 * CANVAS_GRID.columnWidth, upper = top - CANVAS_GRID.rowHeight;
  const tied: LayoutInput = {
    shots: [shot('left', 0, left, top), shot('right', 1, right, top)],
    nodes: [node('fixed', 'text', left + CANVAS_GRID.columnWidth, upper - CANVAS_GRID.rowHeight), node('shared', 'image', 2200, 2000)],
    edges: [edge('fixed', 'left'), edge('shared', 'left'), edge('shared', 'right')],
    selectedIds: new Set(['shared']),
  };
  const at = (x: number) => geometry(applyMoves(tied, {
    status: 'moved', moves: [{ id: 'shared', kind: 'node', position: { x, y: upper } }],
  }));
  const crossed = at(left), clear = at(right);
  assert.equal(crossed.edgeLength, clear.edgeLength, 'both grid positions attain the same shortest length');
  assert.equal(crossed.crossings, 1);
  assert.equal(clear.crossings, 0);
  assert.equal(crossed.overlap, false);
  assert.equal(clear.overlap, false);
  const result = layoutCanvas(tied);
  assert.equal(result.status, 'moved');
  assert.deepEqual(result.moves.map(move => move.id), ['shared']);
  const actual = geometry(applyMoves(tied, result));
  assert.equal(actual.edgeLength, clear.edgeLength);
  assert.equal(actual.crossings, clear.crossings);
  assert.equal(actual.overlap, false);
});

test('all-active tidy uses the project grid rather than historical positions', () => {
  const movedInput: LayoutInput = {
    ...shared,
    shots: shared.shots.map((item, index) => ({ ...item, position: { x: -3000 - index * 300, y: -700 } })),
    nodes: shared.nodes.map(item => ({ ...item, position: { x: -200, y: 4800 } })),
  };
  assert.deepEqual(applyMoves(movedInput, layoutCanvas(movedInput)), applyMoves(shared, layoutCanvas(shared)));
});

test('a fixed connected card anchors either a selected shot or a node-only selection', () => {
  const fixed = node('anchor', 'image', 4000, 3000);
  const shifted = {
    ...fixed,
    position: { x: fixed.position.x + 3 * CANVAS_GRID.columnWidth, y: fixed.position.y + 2 * CANVAS_GRID.rowHeight },
  };
  const scenarios: readonly LayoutInput[] = [
    { shots: [shot('selected', 0, -1200, -900)], nodes: [fixed], edges: [edge(fixed.id, 'selected', true)], selectedIds: new Set(['selected']) },
    { shots: [], nodes: [fixed, node('selected', 'text', -1200, -900)], edges: [edge(fixed.id, 'selected')], selectedIds: new Set(['selected']) },
  ];
  for (const input of scenarios) {
    const first = layoutCanvas(input);
    const second = layoutCanvas({ ...input, nodes: input.nodes.map(item => item.id === fixed.id ? shifted : item) });
    assert.equal(first.status, 'moved');
    assert.equal(second.status, 'moved');
    assert.deepEqual(first.moves.map(move => move.id), ['selected']);
    assert.deepEqual(second.moves.map(move => move.id), ['selected']);
    assert.notDeepEqual(first.moves[0]!.position, second.moves[0]!.position,
      'shifting the connected fixed card well outside the default grid changes the planned position');
  }
});

test('a selection containing only an edge cannot move any card', () => {
  assert.deepEqual(layoutCanvas({ ...mixed, selectedIds: new Set(['only-edge']) }), { status: 'no-movement', moves: [] });
});

test('a fixed reference stays above a selected shot even when a fixed story shot is higher', () => {
  const anchor = shot('story-anchor', 0, 100, 80);
  const fixed = node('fixed-reference', 'image', 5000, 3000);
  const input = {
    shots: [anchor, shot('selected', 1, 200, 200)],
    nodes: [fixed], edges: [edge(fixed.id, 'selected', true)], selectedIds: new Set(['selected']),
  };
  const result = layoutCanvas(input), final = applyMoves(input, result);
  assert.equal(result.status, 'moved');
  assert.deepEqual(result.moves.map(move => move.id), ['selected']);
  assert.deepEqual(final.shots[0], anchor);
  assert.deepEqual(final.nodes[0], fixed);
  assert.ok(final.shots[1]!.position.y >= fixed.position.y + fixed.height + CANVAS_GRID.gap);
});

test('a node-only selection can shift its grid columns around a fixed wall', () => {
  const grid = { columnWidth: 10, rowHeight: 10, gap: 1, coordinateLimit: 20 };
  const fixed = node('wall', 'image', 15, -19, 4, 38);
  const input = { grid, shots: [], nodes: [node('selected', 'text', 0, 0, 5, 5), fixed], edges: [], selectedIds: new Set(['selected']) };
  const result = layoutCanvas(input), final = applyMoves(input, result);
  assert.equal(result.status, 'moved');
  assert.deepEqual(result.moves.map(move => move.id), ['selected']);
  assert.ok(final.nodes[0]!.position.x < 15);
  assert.deepEqual(final.nodes[1], fixed);
  assert.equal(geometry(final).overlap, false);
});

test('a bounded row that cannot fit returns no partial moves', () => {
  const grid = { ...CANVAS_GRID, coordinateLimit: 350 };
  const shots = Array.from({ length: 4 }, (_, index) => shot(`tight-${index}`, index, 100 - index * 70, -80));
  const one = { grid, shots: shots.slice(0, 1), nodes: [], edges: [] };
  assert.equal(layoutCanvas(one).status, 'moved', 'the first card fits within the same coordinate limit');
  const input = { ...one, shots }, original = structuredClone(input);
  assert.deepEqual(layoutCanvas(input), { status: 'no-fit', moves: [] });
  assert.deepEqual(input, original, 'failure leaves the input intact');
});

test('a selected shot finds a clear slot left of the preferred position at the coordinate boundary', () => {
  const input: LayoutInput = {
    grid: { columnWidth: 10, rowHeight: 10, gap: 1, coordinateLimit: 20 },
    shots: [shot('m', 0, 0, 0, 5, 5), shot('f', 1, 15, 0, 4, 5)],
    nodes: [node('wall', 'text', 5, -19, 7, 38)],
    edges: [],
    selectedIds: new Set(['m']),
  };
  const result = layoutCanvas(input);
  assert.equal(result.status, 'moved');
  assert.deepEqual(result.moves.map(move => move.id), ['m']);
  const final = applyMoves(input, result);
  assert.ok(final.shots[0]!.position.x < 5);
  assert.deepEqual(final.shots[1], input.shots[1]);
  assert.deepEqual(final.nodes, input.nodes);
  assert.equal(geometry(final).overlap, false);
});

test('a shot leaves enough room above the row for a tall reference inside the coordinate boundary', () => {
  const grid = { columnWidth: 10, rowHeight: 5, gap: 1, coordinateLimit: 100 };
  const input: LayoutInput = {
    grid,
    shots: [shot('shot', 0, 0, 0, 10, 10)],
    nodes: [node('reference', 'image', -50, -95, 10, 182)],
    edges: [edge('reference', 'shot', true)],
  };
  const result = layoutCanvas(input);
  assert.equal(result.status, 'moved');
  const final = applyMoves(input, result), target = final.shots[0]!, reference = final.nodes[0]!;
  for (const { position, width, height } of [target, reference]) {
    assert.ok(position.x > -grid.coordinateLimit && position.x + width < grid.coordinateLimit);
    assert.ok(position.y > -grid.coordinateLimit && position.y + height < grid.coordinateLimit);
  }
  assert.ok(reference.position.y + reference.height + grid.gap <= target.position.y);
});

test('a blocked upper reference cannot leak the shot move that was already planned', () => {
  const grid = { ...CANVAS_GRID, coordinateLimit: 350 };
  const base: LayoutInput = {
    grid,
    shots: [shot('shot', 0, 100, -80)],
    nodes: [node('fixed', 'text', -349, -349, 698, 397)],
    edges: [],
    selectedIds: new Set(['shot']),
  };
  assert.equal(layoutCanvas(base).status, 'moved', 'the shot can be positioned below the fixed card');
  const blocked: LayoutInput = {
    ...base,
    nodes: [...base.nodes, node('reference', 'image', 40, -100)],
    edges: [edge('reference', 'shot', true)],
    selectedIds: new Set(['shot', 'reference']),
  };
  assert.deepEqual(layoutCanvas(blocked), { status: 'no-fit', moves: [] }, 'the fixed card covers all legal positions above the shot');
});
