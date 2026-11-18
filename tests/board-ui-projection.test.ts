import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyChainConnection, deriveFilmChains} from '../packages/contracts/src/board-sequence.ts';
import type {ChainNodeKind} from '../packages/contracts/src/board-sequence.ts';
import {projectBoardUi} from '../apps/web/src/board-ui/projection.ts';
import type {BoardUiNode} from '../apps/web/src/board-ui/projection.ts';
import {boardPorts, isBoardPortCandidate, resolveBoardPortConnection} from '../apps/web/src/board-ui/connection-ports.ts';
import type {BoardPortEndpoint} from '../apps/web/src/board-ui/connection-ports.ts';

const node = (id: string, kind: ChainNodeKind, durationFrames: number | null = null): BoardUiNode => ({
  id, kind, name: `name-${id}`, durationFrames,
});

test('film strip follows SA chain order rather than presentation enumeration', () => {
  const nodes: readonly BoardUiNode[] = [
    {...node('second', 'shot', 90), status: 'generating'},
    {...node('film', 'film'), name: 'Evening', aspectRatio: '9:16', durationFrames: 999},
    {...node('last', 'shot', 150), status: 'pending'},
    {...node('first', 'shot', 120), status: 'ready', thumbnailUrl: 'synthetic:first'},
    {...node('third', 'shot', 90), status: 'ready'},
  ];
  const derivation = deriveFilmChains({nodes, edges: [
    {fromId: 'third', toId: 'last'}, {fromId: 'film', toId: 'first'},
    {fromId: 'second', toId: 'third'}, {fromId: 'first', toId: 'second'},
  ]});
  const projection = projectBoardUi(derivation, nodes, []);
  assert.deepEqual(projection.films[0]!.items.map(item => item.nodeId), ['first', 'second', 'third', 'last']);
  assert.equal(projection.films[0]!.name, 'Evening');
  assert.equal(projection.films[0]!.aspectRatio, '9:16');
  assert.equal(projection.films[0]!.durationFrames, 450, 'the root display does not override the derived duration');
  assert.equal(projection.films[0]!.items[0]!.thumbnailUrl, 'synthetic:first');
  assert.deepEqual(projection.overview, {
    shotCount: 4, completedCount: 2, generatingCount: 1, pendingCount: 1, floatingCount: 0, durationFrames: 450,
  });
  assert.equal(projection.films[0]!.shotCount, 4);
});

test('every film root contributes members and is never counted as floating', () => {
  const nodes = [node('film-b', 'film'), node('b', 'shot', 60), node('a', 'shot', 30),
    node('film-a', 'film'), node('alone-a', 'shot', 40), node('alone-b', 'video', 80), node('annotation', 'text')];
  const derivation = deriveFilmChains({nodes, edges: [
    {fromId: 'film-b', toId: 'b'}, {fromId: 'film-a', toId: 'a'}, {fromId: 'alone-a', toId: 'alone-b'},
  ]});
  const projection = projectBoardUi(derivation, nodes, []);
  assert.deepEqual(projection.films.map(film => film.id), ['film-a', 'film-b']);
  assert.deepEqual(projection.floatingNodeIds, ['alone-a', 'alone-b', 'annotation']);
  assert.deepEqual(projection.films.map(film => film.durationFrames), [30, 60]);
  assert.equal(projection.overview.shotCount, 2);
  assert.equal(projection.overview.durationFrames, 90);
  assert.equal(projection.overview.floatingCount, 3);
  assert.equal(projection.films[1]!.overview.shotCount, 1);
  assert.equal(projection.films[1]!.overview.floatingCount, 3);
});

test('reference sources attached to shots in any film are not floating, including the second root', () => {
  const nodes = [node('film-a', 'film'), node('shot-a', 'shot', 30), node('film-b', 'film'), node('shot-b', 'shot', 60),
    node('image', 'image'), node('subject', 'subject'), node('floating-shot', 'shot', 90)];
  const derivation = deriveFilmChains({nodes, edges: [
    {fromId: 'film-a', toId: 'shot-a'}, {fromId: 'film-b', toId: 'shot-b'},
  ]});
  const references = Object.freeze([
    Object.freeze({sourceId: 'image', targetId: 'shot-a'}),
    Object.freeze({sourceId: 'subject', targetId: 'shot-b'}),
    Object.freeze({sourceId: 'image', targetId: 'floating-shot'}),
  ]);
  const before = JSON.stringify({derivation, references});
  const projection = projectBoardUi(derivation, nodes, references);
  assert.deepEqual(projection.floatingNodeIds, ['floating-shot']);
  assert.equal(projection.overview.floatingCount, 1);
  assert.equal(projection.films[0]!.overview.floatingCount, 1);
  assert.equal(projection.films[1]!.overview.floatingCount, 1);
  assert.deepEqual(derivation.detachedNodeIds, ['floating-shot', 'image', 'subject'], 'SA membership remains unchanged');
  assert.equal(JSON.stringify({derivation, references}), before);
});

test('reference sources connected only to a floating shot remain floating', () => {
  const nodes = [node('film', 'film'), node('in-film', 'shot', 30), node('floating-shot', 'shot', 60), node('image', 'image')];
  const derivation = deriveFilmChains({nodes, edges: [{fromId: 'film', toId: 'in-film'}]});
  const projection = projectBoardUi(derivation, nodes, [{sourceId: 'image', targetId: 'floating-shot'}]);
  assert.deepEqual(projection.floatingNodeIds, ['floating-shot', 'image']);
  assert.equal(projection.overview.floatingCount, 2);
  assert.equal(projection.overview.shotCount, 1);
});

test('nodes with no connection remain floating while a bare film root does not', () => {
  const nodes = [node('empty-film', 'film'), node('film', 'film'), node('in-film', 'shot', 30), node('image', 'image'), node('text', 'text')];
  const projection = projectBoardUi(deriveFilmChains({nodes, edges: [{fromId: 'film', toId: 'in-film'}]}), nodes, []);
  assert.deepEqual(projection.floatingNodeIds, ['image', 'text']);
  assert.equal(projection.overview.floatingCount, 2);
});

test('image and video chain members affect duration but not generated shot status counts', () => {
  const nodes: readonly BoardUiNode[] = [node('film', 'film'), {...node('image', 'image', 30), status: 'ready'},
    {...node('video', 'video', 60), status: 'generating'}, node('shot', 'shot', 90), node('subject', 'subject')];
  const projection = projectBoardUi(deriveFilmChains({nodes, edges: [
    {fromId: 'film', toId: 'image'}, {fromId: 'image', toId: 'video'}, {fromId: 'video', toId: 'shot'},
  ]}), nodes, []);
  assert.deepEqual(projection.overview, {
    shotCount: 1, completedCount: 0, generatingCount: 0, pendingCount: 1, floatingCount: 1, durationFrames: 180,
  });
  assert.equal(projection.films[0]!.items[1]!.kind, 'video');
  assert.equal(projection.films[0]!.items[2]!.status, 'pending');
});

test('unknown member duration stays unknown while an empty film has an exact zero duration', () => {
  const nodes = [node('empty', 'film'), node('film', 'film'), node('shot', 'shot', 90), node('unknown', 'image')];
  const projection = projectBoardUi(deriveFilmChains({nodes, edges: [
    {fromId: 'film', toId: 'shot'}, {fromId: 'shot', toId: 'unknown'},
  ]}), nodes, []);
  assert.equal(projection.films[0]!.durationFrames, 0);
  assert.equal(projection.films[0]!.aspectRatio, null);
  assert.equal(projection.films[1]!.durationFrames, null);
  assert.equal(projection.overview.durationFrames, null);
  assert.equal(projection.films[1]!.items[1]!.durationFrames, null);
  assert.equal(projection.films[1]!.items[1]!.thumbnailUrl, null);
});

test('broken-chain diagnostics and detached membership remain available to the static view', () => {
  const nodes = [node('film', 'film'), node('a', 'shot', 30), node('b', 'shot', 30)];
  const derivation = deriveFilmChains({nodes, edges: [{fromId: 'a', toId: 'b'}, {fromId: 'b', toId: 'a'}]});
  const projection = projectBoardUi(derivation, nodes, []);
  assert.deepEqual(projection.issues, derivation.issues);
  assert.ok(projection.issues.some(issue => issue.code === 'CYCLE'));
  assert.deepEqual(projection.floatingNodeIds, ['a', 'b']);
  assert.equal(projection.overview.shotCount, 0);
  assert.equal(projection.overview.durationFrames, 0);
});

test('projection does not mutate the supplied SA or display data', () => {
  const nodes = Object.freeze([Object.freeze(node('film', 'film')), Object.freeze(node('shot', 'shot', 30))]);
  const derived = deriveFilmChains({nodes, edges: [{fromId: 'film', toId: 'shot'}]});
  Object.freeze(derived.chains[0]!.nodeIds);
  Object.freeze(derived.chains[0]); Object.freeze(derived.chains);
  Object.freeze(derived.detachedNodeIds); Object.freeze(derived.issues); Object.freeze(derived);
  const before = JSON.stringify({nodes, derived});
  const projection = projectBoardUi(derived, nodes, []);
  assert.equal(projection.films[0]!.items[0]!.nodeId, 'shot');
  assert.equal(JSON.stringify({nodes, derived}), before);
});

test('incomplete or invalid presentation adapters fail rather than inventing durations or roots', () => {
  const nodes = [node('film', 'film'), node('shot', 'shot', 30)];
  const derived = deriveFilmChains({nodes, edges: [{fromId: 'film', toId: 'shot'}]});
  assert.throws(() => projectBoardUi(derived, [nodes[0]!], []), /node is missing/);
  assert.throws(() => projectBoardUi(derived, [...nodes, nodes[1]!], []), /Duplicate/);
  assert.throws(() => projectBoardUi(derived, [node('film', 'shot'), nodes[1]!], []), /root is not a film/);
  for (const frames of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => projectBoardUi(derived, [nodes[0]!, node('shot', 'shot', frames)], []), /Invalid board presentation duration/);
  }
  const overflowNodes = [node('film', 'film'), node('a', 'shot', Number.MAX_SAFE_INTEGER), node('b', 'shot', 1)];
  assert.throws(() => projectBoardUi(deriveFilmChains({nodes: overflowNodes, edges: [
    {fromId: 'film', toId: 'a'}, {fromId: 'a', toId: 'b'},
  ]}), overflowNodes, []), /safe integer range/);
});

test('sequence handles stay on the sides and the film exposes only its right output', () => {
  assert.deepEqual(boardPorts('film'), [{id: 'sequence-out', family: 'sequence', type: 'source', side: 'right'}]);
  for (const kind of ['shot', 'image', 'video'] as const) {
    assert.deepEqual(boardPorts(kind).filter(port => port.family === 'sequence').map(port => [port.type, port.side]),
      [['target', 'left'], ['source', 'right']]);
  }
  assert.deepEqual(boardPorts('text'), []);
  for (const kind of ['audio', 'subject', 'previs'] as const) {
    assert.equal(boardPorts(kind).length, 2);
    assert.ok(boardPorts(kind).every(port => port.family === 'reference' && port.type === 'source'));
  }
});

test('shot reference inputs and reference source outputs use only top and bottom', () => {
  const shotReferences = boardPorts('shot').filter(port => port.family === 'reference');
  assert.deepEqual(shotReferences.map(port => [port.type, port.side]), [['target', 'top'], ['target', 'bottom']]);
  for (const kind of ['image', 'video', 'audio', 'subject', 'previs'] as const) {
    const refs = boardPorts(kind).filter(port => port.family === 'reference');
    assert.deepEqual(refs.map(port => [port.type, port.side]), [['source', 'top'], ['source', 'bottom']]);
  }
});

test('image and video use their selected port family and preserve the SA default reference role', () => {
  const shot: BoardPortEndpoint = {nodeId: 'shot', kind: 'shot', portId: 'reference-in-top'};
  const expectedRoles = {image: 'first_frame', video: 'reference_video', audio: 'reference_audio', subject: 'subject_reference', previs: 'composition'};
  for (const kind of ['image', 'video', 'audio', 'subject', 'previs'] as const) {
    assert.deepEqual(resolveBoardPortConnection({nodeId: 'source', kind, portId: 'reference-out-bottom'}, shot), {
      sourceId: 'source', targetId: 'shot', sourcePort: 'reference-out-bottom', targetPort: 'reference-in-top',
      kind: 'reference', role: expectedRoles[kind],
    });
  }
  assert.deepEqual(resolveBoardPortConnection({nodeId: 'image', kind: 'image', portId: 'sequence-out'},
    {nodeId: 'shot', kind: 'shot', portId: 'sequence-in'}), {
    sourceId: 'image', targetId: 'shot', sourcePort: 'sequence-out', targetPort: 'sequence-in', kind: 'sequence',
  });
});

test('dragging backwards from a target normalizes the same source, target and role', () => {
  const source: BoardPortEndpoint = {nodeId: 'image', kind: 'image', portId: 'reference-out-top'};
  const target: BoardPortEndpoint = {nodeId: 'shot', kind: 'shot', portId: 'reference-in-bottom'};
  assert.deepEqual(resolveBoardPortConnection(target, source), resolveBoardPortConnection(source, target));
  assert.equal(isBoardPortCandidate(target, {id: 'image', kind: 'image'}, 'reference-out-top'), true);
  assert.equal(isBoardPortCandidate(source, {id: 'shot', kind: 'shot'}, boardPorts('shot')[3]!), true);
});

test('self links, wrong families, wrong directions and nonexistent handles never highlight', () => {
  const source: BoardPortEndpoint = {nodeId: 'image', kind: 'image', portId: 'reference-out-top'};
  assert.equal(isBoardPortCandidate(source, {id: 'image', kind: 'shot'}, 'reference-in-top'), false);
  assert.equal(isBoardPortCandidate(source, {id: 'shot', kind: 'shot'}, 'sequence-in'), false);
  assert.equal(isBoardPortCandidate(source, {id: 'other', kind: 'image'}, 'reference-out-bottom'), false);
  assert.equal(isBoardPortCandidate(source, {id: 'film', kind: 'film'}, 'reference-in-top'), false);
  assert.equal(resolveBoardPortConnection({nodeId: 'shot', kind: 'shot', portId: 'reference-out-top'},
    {nodeId: 'other', kind: 'shot', portId: 'reference-in-top'}), null);
  assert.equal(resolveBoardPortConnection({nodeId: 'image', kind: 'image', portId: 'sequence-out'},
    {nodeId: 'film', kind: 'film', portId: 'sequence-in'}), null);
});

test('all exposed port pairs agree with SA classification in both drag directions', () => {
  const kinds: readonly ChainNodeKind[] = ['film', 'shot', 'image', 'video', 'audio', 'subject', 'previs', 'text'];
  let valid = 0, refused = 0;
  for (const sourceKind of kinds) for (const targetKind of kinds) {
    for (const sourcePort of boardPorts(sourceKind)) for (const targetPort of boardPorts(targetKind)) {
      const first = {nodeId: 'from', kind: sourceKind, portId: sourcePort.id};
      const second = {nodeId: 'to', kind: targetKind, portId: targetPort.id};
      const classification = classifyChainConnection(sourceKind, targetKind, sourcePort.family);
      const expected = sourcePort.type === 'source' && targetPort.type === 'target'
        && sourcePort.family === targetPort.family && classification.kind !== 'rejected';
      if (sourcePort.type !== 'source' || targetPort.type !== 'target') continue;
      const actual = resolveBoardPortConnection(first, second);
      assert.equal(actual !== null, expected);
      assert.deepEqual(resolveBoardPortConnection(second, first), actual);
      if (actual) valid++; else refused++;
    }
  }
  assert.ok(valid > 0 && refused > 0);
});
