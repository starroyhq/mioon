import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boardSequenceIssuesForComponent, classifyChainConnection, compareChainIds, compareSequenceEdges, deriveFilmChains,
  planBoardSequenceEdit,
} from '../packages/contracts/src/board-sequence.ts';
import type { BoardSequenceEdit, ChainBoard, ChainNodeKind, SequenceEdge } from '../packages/contracts/src/board-sequence.ts';

const edge = (fromId: string, toId: string): SequenceEdge => ({fromId, toId});
const node = (id: string, kind: ChainNodeKind = 'shot') => ({id, kind});

function canonical(board: ChainBoard): ChainBoard {
  return {
    nodes: [...board.nodes].sort((left, right) => compareChainIds(left.id, right.id) || compareChainIds(left.kind, right.kind)),
    edges: [...board.edges].sort(compareSequenceEdges),
  };
}

function unordered(board: ChainBoard): ChainBoard {
  return {nodes: [...board.nodes].reverse(), edges: [...board.edges].reverse()};
}

test('sequence and reference ports share image and video pairs with an explicit intent', () => {
  for (const source of ['film', 'shot', 'video', 'image'] as const) {
    for (const target of ['shot', 'video', 'image'] as const) {
      assert.deepEqual(classifyChainConnection(source, target), {kind: 'sequence'});
      assert.deepEqual(classifyChainConnection(source, target, 'sequence'), {kind: 'sequence'});
    }
  }
  assert.deepEqual(classifyChainConnection('image', 'shot', 'reference'), {kind: 'reference', role: 'first_frame'});
  assert.deepEqual(classifyChainConnection('video', 'shot', 'reference'), {kind: 'reference', role: 'reference_video'});
  assert.deepEqual(classifyChainConnection('subject', 'shot'), {kind: 'reference', role: 'subject_reference'});
  assert.deepEqual(classifyChainConnection('previs', 'shot'), {kind: 'reference', role: 'composition'});
  assert.deepEqual(classifyChainConnection('audio', 'shot'), {kind: 'reference', role: 'reference_audio'});
  assert.deepEqual(classifyChainConnection('audio', 'shot', 'sequence'), {kind: 'rejected', code: 'INVALID_SEQUENCE_TYPES'});
  assert.deepEqual(classifyChainConnection('image', 'video', 'reference'), {kind: 'rejected', code: 'INVALID_REFERENCE_TYPES'});
  assert.deepEqual(classifyChainConnection('shot', 'film'), {kind: 'rejected', code: 'FILM_MUST_START'});
  assert.deepEqual(classifyChainConnection('film', 'film', 'sequence'), {kind: 'rejected', code: 'FILM_MUST_START'});
  assert.deepEqual(classifyChainConnection('text', 'shot'), {kind: 'rejected', code: 'TEXT_IS_ANNOTATION'});
  assert.deepEqual(classifyChainConnection('shot', 'text'), {kind: 'rejected', code: 'TEXT_IS_ANNOTATION'});
  assert.deepEqual(classifyChainConnection('shot', 'audio'), {kind: 'rejected', code: 'INVALID_CONNECTION_TYPES'});
});

test('derive empty and single-node boards, then independent films and unconnected sequences', () => {
  assert.deepEqual(deriveFilmChains({nodes: [], edges: []}), {chains: [], detachedNodeIds: [], issues: []});
  assert.deepEqual(deriveFilmChains({nodes: [node('Film', 'film')], edges: []}), {
    chains: [{filmId: 'Film', nodeIds: []}], detachedNodeIds: [], issues: [],
  });
  assert.deepEqual(deriveFilmChains({nodes: [node(' shot')], edges: []}), {
    chains: [], detachedNodeIds: [' shot'], issues: [],
  });

  const board: ChainBoard = {
    nodes: [node('a', 'film'), node('z', 'shot'), node('Z', 'film'), node('Z-one', 'shot'),
      node('still', 'image'), node('footage', 'video'), node('alone'), node('stranded'), node('sound', 'audio'), node('x')],
    edges: [edge('stranded', 'x'), edge('a', 'z'), edge('Z-one', 'still'), edge('still', 'footage'), edge('Z', 'Z-one')],
  };
  const expected = {
    chains: [{filmId: 'Z', nodeIds: ['Z-one', 'still', 'footage']}, {filmId: 'a', nodeIds: ['z']}],
    detachedNodeIds: ['alone', 'sound', 'stranded', 'x'], issues: [],
  };
  assert.deepEqual(deriveFilmChains(board), expected);
  assert.equal(JSON.stringify(deriveFilmChains(unordered(board))), JSON.stringify(expected));
});

test('derivation reports duplicates, missing endpoints, wrong types, branch degrees and cyclic components deterministically', () => {
  const board: ChainBoard = {
    nodes: [node('film', 'film'), node('solo', 'film'), node('solo-shot'), node('a'), node('b'), node('c'),
      node('d'), node('e'), node('self'), node('text', 'text'), node('reused'), node('reused', 'video')],
    edges: [edge('film', 'a'), edge('a', 'b'), edge('b', 'a'), edge('a', 'c'), edge('c', 'd'), edge('d', 'e'), edge('e', 'd'),
      edge('self', 'self'), edge('film', 'text'), edge('unknown', 'c'), edge('text', 'film'), edge('solo', 'solo-shot'),
      edge('solo', 'solo-shot'), edge('reused', 'b')],
  };
  const derived = deriveFilmChains(board);
  assert.equal(JSON.stringify(deriveFilmChains(unordered(board))), JSON.stringify(derived));
  assert.deepEqual(derived.chains, [{filmId: 'film', nodeIds: []}, {filmId: 'solo', nodeIds: ['solo-shot']}]);
  assert.deepEqual(derived.issues.map(item => [item.code, item.nodeIds]), [
    ['CYCLE', ['a', 'b']], ['CYCLE', ['d', 'e']], ['CYCLE', ['self']],
    ['DUPLICATE_EDGE', ['solo', 'solo-shot']], ['DUPLICATE_NODE', ['reused']],
    ['FILM_MUST_START', ['film', 'text']], ['MISSING_NODE', ['unknown']],
    ['MULTIPLE_PREDECESSORS', ['a']], ['MULTIPLE_PREDECESSORS', ['d']], ['MULTIPLE_SUCCESSORS', ['a']],
    ['TEXT_IS_ANNOTATION', ['film', 'text']],
  ]);
  assert.deepEqual(derived.issues[0]?.edges, [edge('a', 'b'), edge('b', 'a')]);
  assert.deepEqual(derived.issues[1]?.edges, [edge('d', 'e'), edge('e', 'd')]);
  const local = boardSequenceIssuesForComponent(board, derived.issues, ['film']);
  assert.deepEqual(local, derived.issues.filter(item => !['solo', 'self'].some(id => item.nodeIds.includes(id))));
});

const story = canonical({
  nodes: [node('film', 'film'), node('a'), node('middle'), node('z'), node('inserted', 'image'), node('other', 'film'), node('x')],
  edges: [edge('film', 'a'), edge('a', 'middle'), edge('middle', 'z'), edge('other', 'x')],
});

function checkEdit(
  before: ChainBoard, edit: BoardSequenceEdit, expectedAdded: readonly SequenceEdge[], expectedRemoved: readonly SequenceEdge[],
): ChainBoard {
  const original = JSON.stringify(before);
  const result = planBoardSequenceEdit(before, edit);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(JSON.stringify(before), original);
  assert.equal(JSON.stringify(planBoardSequenceEdit(unordered(before), edit)), JSON.stringify(result));
  assert.deepEqual(result.addedEdges, [...expectedAdded].sort(compareSequenceEdges));
  assert.deepEqual(result.removedEdges, [...expectedRemoved].sort(compareSequenceEdges));
  assert.deepEqual(result.issues, deriveFilmChains(result.board).issues);

  const without = (edges: readonly SequenceEdge[], removed: readonly SequenceEdge[]) =>
    edges.filter(item => !removed.some(candidate => compareSequenceEdges(item, candidate) === 0));
  const after = canonical({
    nodes: before.nodes.filter(item => edit.kind !== 'delete' || item.id !== edit.nodeId),
    edges: [...without(before.edges, result.removedEdges), ...result.addedEdges],
  });
  assert.equal(JSON.stringify(after), JSON.stringify(result.board));

  const missing = before.nodes.filter(item => !after.nodes.some(candidate => candidate.id === item.id));
  const restored = canonical({nodes: [...after.nodes, ...missing], edges: [...without(after.edges, result.addedEdges), ...result.removedEdges]});
  assert.equal(JSON.stringify(restored), original);
  return after;
}

test('every sequence edit applies and undoes exactly, including insertion onto the first edge and deletion at either end', () => {
  const disconnected = checkEdit(story, {kind: 'disconnect', fromId: 'a', toId: 'middle'}, [], [edge('a', 'middle')]);
  assert.deepEqual(deriveFilmChains(disconnected).detachedNodeIds, ['inserted', 'middle', 'z']);
  const connected = checkEdit(disconnected, {kind: 'connect', fromId: 'a', toId: 'middle'}, [edge('a', 'middle')], []);
  assert.deepEqual(connected, story);

  const inserted = checkEdit(story, {kind: 'insert', fromId: 'film', toId: 'a', nodeId: 'inserted'},
    [edge('film', 'inserted'), edge('inserted', 'a')], [edge('film', 'a')]);
  assert.deepEqual(deriveFilmChains(inserted).chains[0]?.nodeIds, ['inserted', 'a', 'middle', 'z']);

  for (const [nodeId, added, removed, expected] of [
    ['a', [edge('film', 'middle')], [edge('film', 'a'), edge('a', 'middle')], ['middle', 'z']],
    ['middle', [edge('a', 'z')], [edge('a', 'middle'), edge('middle', 'z')], ['a', 'z']],
    ['z', [], [edge('middle', 'z')], ['a', 'middle']],
  ] as const) {
    const edited = checkEdit(story, {kind: 'delete', nodeId}, added, removed);
    assert.deepEqual(deriveFilmChains(edited).chains[0]?.nodeIds, expected);
  }
  const rootRemoved = checkEdit(story, {kind: 'delete', nodeId: 'film'}, [], [edge('film', 'a')]);
  assert.deepEqual(deriveFilmChains(rootRemoved).chains, [{filmId: 'other', nodeIds: ['x']}]);
  assert.deepEqual(deriveFilmChains(rootRemoved).detachedNodeIds, ['a', 'inserted', 'middle', 'z']);
});

test('inserting a linked card only splices within its own sequence and never duplicates a target endpoint', () => {
  const earlier = checkEdit(story, {kind: 'insert', fromId: 'film', toId: 'a', nodeId: 'middle'},
    [edge('film', 'middle'), edge('middle', 'a'), edge('a', 'z')],
    [edge('film', 'a'), edge('a', 'middle'), edge('middle', 'z')]);
  assert.deepEqual(deriveFilmChains(earlier).chains[0]?.nodeIds, ['middle', 'a', 'z']);

  const later = checkEdit(story, {kind: 'insert', fromId: 'middle', toId: 'z', nodeId: 'a'},
    [edge('film', 'middle'), edge('middle', 'a'), edge('a', 'z')],
    [edge('film', 'a'), edge('a', 'middle'), edge('middle', 'z')]);
  assert.deepEqual(later, earlier);

  for (const nodeId of ['a', 'middle']) {
    const same = planBoardSequenceEdit(story, {kind: 'insert', fromId: 'a', toId: 'middle', nodeId});
    assert.deepEqual(same, {ok: false, code: 'NODE_ALREADY_LINKED', issues: [{code: 'NODE_ALREADY_LINKED', nodeIds: [nodeId], edges: []}]});
  }

  const detached = checkEdit(story, {kind: 'disconnect', fromId: 'film', toId: 'a'}, [], [edge('film', 'a')]);
  const reordered = checkEdit(detached, {kind: 'insert', fromId: 'a', toId: 'middle', nodeId: 'z'},
    [edge('a', 'z'), edge('z', 'middle')], [edge('a', 'middle'), edge('middle', 'z')]);
  assert.deepEqual(deriveFilmChains(reordered).detachedNodeIds, ['a', 'inserted', 'middle', 'z']);
  const other = planBoardSequenceEdit(story, {kind: 'insert', fromId: 'a', toId: 'middle', nodeId: 'x'});
  assert.deepEqual(other, {ok: false, code: 'NODE_ALREADY_LINKED', issues: [{code: 'NODE_ALREADY_LINKED', nodeIds: ['x'], edges: []}]});
});

test('connections and inserts reject occupied ports, cycles, mismatched node types and missing IDs', () => {
  const board = {...story, nodes: [...story.nodes, node('actor', 'subject'), node('unconnected'), node('standalone', 'film')], edges: [...story.edges, edge('unconnected', 'actor')]};
  const invalidBoard = planBoardSequenceEdit(board, {kind: 'connect', fromId: 'z', toId: 'unconnected'});
  assert.equal(invalidBoard.ok ? undefined : invalidBoard.code, 'INVALID_SEQUENCE_TYPES');

  const clean = {...board, edges: story.edges};
  const cases = [
    [{kind: 'connect', fromId: 'film', toId: 'a'}, 'DUPLICATE_EDGE'],
    [{kind: 'connect', fromId: 'film', toId: 'inserted'}, 'MULTIPLE_SUCCESSORS'],
    [{kind: 'connect', fromId: 'unconnected', toId: 'x'}, 'MULTIPLE_PREDECESSORS'],
    [{kind: 'connect', fromId: 'unconnected', toId: 'unconnected'}, 'CYCLE'],
    [{kind: 'connect', fromId: 'z', toId: 'film'}, 'FILM_MUST_START'],
    [{kind: 'connect', fromId: 'z', toId: 'actor'}, 'INVALID_SEQUENCE_TYPES'],
    [{kind: 'connect', fromId: 'gone', toId: 'unconnected'}, 'MISSING_NODE'],
    [{kind: 'insert', fromId: 'film', toId: 'a', nodeId: 'x'}, 'NODE_ALREADY_LINKED'],
    [{kind: 'insert', fromId: 'film', toId: 'a', nodeId: 'standalone'}, 'FILM_MUST_START'],
    [{kind: 'insert', fromId: 'film', toId: 'z', nodeId: 'inserted'}, 'MISSING_EDGE'],
    [{kind: 'delete', nodeId: 'gone'}, 'MISSING_NODE'],
    [{kind: 'disconnect', fromId: 'z', toId: 'a'}, 'MISSING_EDGE'],
  ] as const satisfies readonly (readonly [BoardSequenceEdit, string])[];
  for (const [edit, expected] of cases) {
    const result = planBoardSequenceEdit(clean, edit);
    assert.ok(!result.ok);
    assert.equal(result.code, expected);
    assert.equal(result.issues[0]?.code, expected);
  }
  const detached = {nodes: [node('a'), node('z')], edges: [edge('a', 'z')]};
  const ring = planBoardSequenceEdit(detached, {kind: 'connect', fromId: 'z', toId: 'a'});
  assert.deepEqual(ring, {
    ok: false, code: 'CYCLE', issues: [{code: 'CYCLE', nodeIds: ['a', 'z'], edges: [edge('a', 'z'), edge('z', 'a')]}],
  });
});

test('disconnect heals cycles and removes duplicate, missing-node and rejected-type lines from the raw board', () => {
  const independent = canonical({
    nodes: [node('self'), node('reused'), node('reused', 'video')],
    edges: [edge('self', 'self')],
  });
  const board = canonical({
    nodes: [...independent.nodes, node('film', 'film'), node('a'), node('b'), node('actor', 'subject')],
    edges: [...independent.edges, edge('film', 'a'), edge('a', 'b'), edge('b', 'a'),
      edge('a', 'gone'), edge('a', 'gone'), edge('a', 'actor')],
  });
  const acyclic = checkEdit(board, {kind: 'disconnect', fromId: 'b', toId: 'a'}, [], [edge('b', 'a')]);
  assert.deepEqual(deriveFilmChains(acyclic).chains, [{filmId: 'film', nodeIds: ['a', 'b']}]);
  const noMissing = checkEdit(acyclic, {kind: 'disconnect', fromId: 'a', toId: 'gone'}, [], [edge('a', 'gone'), edge('a', 'gone')]);
  const repaired = checkEdit(noMissing, {kind: 'disconnect', fromId: 'a', toId: 'actor'}, [], [edge('a', 'actor')]);
  assert.deepEqual(deriveFilmChains(repaired).issues, deriveFilmChains(independent).issues);
});

test('delete removes all representations of a broken card and leaves unrelated records intact', () => {
  const independent = canonical({
    nodes: [node('self'), node('reused'), node('reused', 'video')],
    edges: [edge('self', 'self'), edge('reused', 'self'), edge('reused', 'self')],
  });
  const incident = [edge('film', 'a'), edge('a', 'b'), edge('other', 'a'), edge('a', 'a'), edge('a', 'gone'), edge('a', 'b')];
  const board = canonical({
    nodes: [...independent.nodes, node('film', 'film'), node('a'), node('a', 'image'), node('b'), node('other')],
    edges: [...independent.edges, ...incident],
  });
  const repaired = checkEdit(board, {kind: 'delete', nodeId: 'a'}, [], incident);
  assert.deepEqual(repaired.nodes.filter(item => item.id === 'reused'), independent.nodes.filter(item => item.id === 'reused'));
  assert.deepEqual(repaired.edges, independent.edges);
  assert.deepEqual(deriveFilmChains(repaired).issues, deriveFilmChains(independent).issues);

  const cyclic = canonical({
    nodes: [node('film', 'film'), node('a'), node('b'), node('c')],
    edges: [edge('film', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
  });
  assert.deepEqual(checkEdit(cyclic, {kind: 'delete', nodeId: 'b'}, [], [edge('a', 'b'), edge('b', 'c')]).edges,
    [edge('c', 'a'), edge('film', 'a')]);
});

test('connect, insert and healthy delete work beside unrelated corruption but edits cannot extend a broken chain', () => {
  const board = canonical({
    nodes: [...story.nodes, node('cycle'), node('broken'), node('victim')],
    edges: [...story.edges, edge('cycle', 'cycle'), edge('broken', 'victim'), edge('broken', 'gone')],
  });
  const connected = checkEdit(board, {kind: 'connect', fromId: 'z', toId: 'inserted'}, [edge('z', 'inserted')], []);
  assert.deepEqual(deriveFilmChains(connected).chains[0]?.nodeIds, ['a', 'middle', 'z', 'inserted']);
  const inserted = checkEdit(board, {kind: 'insert', fromId: 'film', toId: 'a', nodeId: 'inserted'},
    [edge('film', 'inserted'), edge('inserted', 'a')], [edge('film', 'a')]);
  assert.deepEqual(deriveFilmChains(inserted).chains[0]?.nodeIds, ['inserted', 'a', 'middle', 'z']);
  const spliced = checkEdit(board, {kind: 'delete', nodeId: 'middle'},
    [edge('a', 'z')], [edge('a', 'middle'), edge('middle', 'z')]);
  assert.deepEqual(deriveFilmChains(spliced).chains[0]?.nodeIds, ['a', 'z']);

  for (const operation of [
    {kind: 'connect', fromId: 'victim', toId: 'inserted'},
    {kind: 'insert', fromId: 'film', toId: 'a', nodeId: 'victim'},
    {kind: 'insert', fromId: 'broken', toId: 'victim', nodeId: 'inserted'},
  ] as const) {
    const rejected = planBoardSequenceEdit(board, operation);
    assert.deepEqual(rejected, {
      ok: false, code: 'MISSING_NODE', issues: [{code: 'MISSING_NODE', nodeIds: ['gone'], edges: [edge('broken', 'gone')]}],
    });
  }
});
