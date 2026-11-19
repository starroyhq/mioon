import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {readSequenceEditContext} from '../packages/business/src/sequence-edit.ts';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import type {ChainWorld} from './helpers/sequence-edit-double.ts';
import type {BoardIntentOperation, SequenceEditIntent} from '../packages/contracts/src/sequence-edit.ts';

const id = (suffix: string): string => suffix;
const rootId = id('20000000-0000-4000-8000-000000000001');
const shotA = id('20000000-0000-4000-8000-000000000010');
const shotB = id('20000000-0000-4000-8000-000000000011');
const clipA = id('20000000-0000-4000-8000-000000000020');
const clipB = id('20000000-0000-4000-8000-000000000021');
const edgeRootA = id('20000000-0000-4000-8000-000000000030');
const edgeAB = id('20000000-0000-4000-8000-000000000031');

function makeWorld(t: test.TestContext): ChainWorld {
  return createChainWorld(t, {
    rootId,
    shots: [{id: shotA, title: 'A'}, {id: shotB, title: 'B'}],
    clips: [{nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 30},
      {nodeId: shotB, clipId: clipB, startFrame: 30, durationFrames: 30}],
    edges: [{id: edgeRootA, fromId: rootId, toId: shotA}, {id: edgeAB, fromId: shotA, toId: shotB}],
  });
}
type Service = ReturnType<typeof createFormat5SequenceEditService>;
const boardIntent = (operation: BoardIntentOperation): SequenceEditIntent => ({side: 'board', operation});
function preview(service: Service, world: ChainWorld, intents: readonly SequenceEditIntent[], allocation?: unknown) {
  return service.preview({projectId: world.projectId, requestId: `preview-${randomUUID()}`,
    intents, ...(allocation ? {allocation} : {})}) as {envelope: any; planDigest: string; warnings: readonly {code: string}[]};
}
function commit(service: Service, world: ChainWorld, previewResult: {envelope: unknown; planDigest: string}) {
  return service.commit({projectId: world.projectId, envelope: previewResult.envelope,
    expectedPlanDigest: previewResult.planDigest}) as any;
}
function runPreviewed(service: Service, world: ChainWorld, intents: readonly SequenceEditIntent[]) {
  return commit(service, world, preview(service, world, intents));
}
function liveBoard(world: ChainWorld) {
  return readSequenceEditContext(world.store).board;
}
function liveRow(world: ChainWorld, table: 'shots' | 'nodes', id: string): any {
  const context = readSequenceEditContext(world.store);
  return (table === 'shots' ? context.rows.shots : context.rows.nodes).get(id);
}
function mainTimeline(world: ChainWorld) {
  return readSequenceEditContext(world.store).timeline;
}
function history(service: Service, world: ChainWorld) {
  return service.history({projectId: world.projectId}) as any;
}
function undo(service: Service, world: ChainWorld): unknown {
  const view = history(service, world);
  assert.ok(view.undo, 'an undo action is available');
  return service.undo({projectId: world.projectId, requestId: `undo-${randomUUID()}`,
    actionId: view.undo.actionId, expected: {position: view.position, revision: view.revision}});
}
function redo(service: Service, world: ChainWorld): unknown {
  const view = history(service, world);
  assert.ok(view.redo, 'a redo action is available');
  return service.redo({projectId: world.projectId, requestId: `redo-${randomUUID()}`,
    actionId: view.redo.actionId, expected: {position: view.position, revision: view.revision}});
}

test('sequence.board.get exposes revisions, sync state and the archive for the real graph', (t: test.TestContext) => {
  const world = makeWorld(t);
  const service = createFormat5Service(world);
  const before = service.board({projectId: world.projectId}) as any;
  assert.equal(before.timelineRevision, mainTimeline(world).revision);
  assert.equal(before.syncRevision, readSequenceEditContext(world.store).syncRevision);
  assert.equal(before.inSync, true);
  assert.deepEqual(before.archived, []);
  assert.deepEqual(Object.keys(before).sort(), ['archived', 'inSync', 'projectId', 'syncRevision', 'timelineRevision'].sort());
});

test('a layout move is one undoable board action and does not change the timeline or sync revision', (t: test.TestContext) => {
  const world = makeWorld(t);
  const service = createFormat5Service(world);
  const timelineBefore = mainTimeline(world), syncBefore = readSequenceEditContext(world.store).syncRevision;
  const receipt = runPreviewed(service, world, [boardIntent({kind: 'board.layout.move',
    moves: [{nodeId: shotA, x: 120, y: -40}, {nodeId: shotB, x: 410, y: -40}]})]);
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.operation, 'board.layout.move');
  assert.equal(liveRow(world, 'shots', shotA)?.position?.x, 120);
  assert.equal(liveRow(world, 'shots', shotB)?.position?.y, -40);
  assert.equal(mainTimeline(world).revision, timelineBefore.revision);
  assert.equal(readSequenceEditContext(world.store).syncRevision, syncBefore);
  assert.equal(history(service, world).undo.operation, 'board.layout.move');
  undo(service, world);
  assert.equal(liveRow(world, 'shots', shotA)?.position, undefined);
  redo(service, world);
  assert.equal(liveRow(world, 'shots', shotA)?.position?.x, 120);
});

test('a new film root is one undoable board action that leaves the active main track alone', (t: test.TestContext) => {
  const world = makeWorld(t);
  const service = createFormat5Service(world);
  const newRoot = randomUUID();
  const timelineBefore = mainTimeline(world);
  const receipt = runPreviewed(service, world, [boardIntent({kind: 'board.root.create', nodeId: newRoot,
    name: '第二部', position: {x: 640, y: 0}})]);
  assert.equal(receipt.operation, 'board.root.create');
  assert.ok(liveBoard(world).nodes.some(node => node.id === newRoot && node.kind === 'film'));
  assert.equal(mainTimeline(world).revision, timelineBefore.revision);
  assert.equal(mainTimeline(world).clips.length, timelineBefore.clips.length);
  undo(service, world);
  assert.equal(liveBoard(world).nodes.some(node => node.id === newRoot), false);
  redo(service, world);
  assert.ok(liveBoard(world).nodes.some(node => node.id === newRoot && node.kind === 'film'));
});

test('appending a shot to the active film tail creates the shot, edge and main-track clip in one undo step', (t: test.TestContext) => {
  const world = makeWorld(t);
  const service = createFormat5Service(world);
  const newShot = randomUUID();
  const beforeClips = mainTimeline(world).clips.length;
  const receipt = runPreviewed(service, world, [boardIntent({kind: 'board.shot.append', nodeId: newShot,
    name: '新镜头', position: {x: 700, y: 0}})]);
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.operation, 'board.shot.append');
  assert.ok(receipt.affected.mainTrackClips >= 1);
  assert.equal(liveRow(world, 'shots', newShot)?.title, '新镜头');
  const context = readSequenceEditContext(world.store);
  const chain = context.board.nodes.map(node => node.id);
  assert.ok(chain.includes(newShot));
  assert.equal(context.timeline.clips.length, beforeClips + 1);
  const appended = context.timeline.clips.find(clip => clip.sequenceSource?.nodeId === newShot);
  assert.ok(appended, 'the new shot has a main-track clip');
  assert.equal(context.timeline.clips.at(-1)?.sequenceSource?.nodeId, newShot);
  assert.equal(context.syncRevision, 2);
  assert.equal(history(service, world).undo.operation, 'board.shot.append');
  undo(service, world);
  assert.equal(liveRow(world, 'shots', newShot), undefined);
  assert.equal(mainTimeline(world).clips.length, beforeClips);
  redo(service, world);
  assert.equal(mainTimeline(world).clips.length, beforeClips + 1);
});

test('a deleted shot is returned by sequence.board.get and restoring it re-links the chain in one action', (t: test.TestContext) => {
  const world = makeWorld(t);
  const service = createFormat5Service(world);
  runPreviewed(service, world, [{side: 'board', operation: {kind: 'board', edit: {kind: 'delete', nodeId: shotB}}}]);
  assert.equal(liveRow(world, 'shots', shotB), undefined);
  const archived = (service.board({projectId: world.projectId}) as any).archived as Array<{id: string; kind: string; name: string}>;
  assert.ok(archived.some(item => item.id === shotB && item.kind === 'shot' && item.name === 'B'));
  const restored = runPreviewed(service, world, [{side: 'board', operation: {kind: 'board',
    edit: {kind: 'connect', fromId: shotA, toId: shotB}}}]);
  assert.equal(restored.status, 'applied');
  assert.equal(liveRow(world, 'shots', shotB)?.title, 'B');
  assert.deepEqual((service.board({projectId: world.projectId}) as any).archived, []);
  const context = readSequenceEditContext(world.store);
  assert.equal(context.timeline.clips.at(-1)?.sequenceSource?.nodeId, shotB);
});

test('board intents reject occupied ids, unknown layout nodes and invalid payload shapes without writing', (t: test.TestContext) => {
  const world = makeWorld(t);
  const service = createFormat5Service(world);
  const occupied = preview(service, world, [boardIntent({kind: 'board.root.create', nodeId: rootId,
    name: '重复', position: {x: 0, y: 0}})]) as any;
  assert.equal(occupied.ok, false);
  assert.equal(occupied.code, 'SEQUENCE_EDIT_CONTRACT_INVALID');
  const missing = preview(service, world, [boardIntent({kind: 'board.layout.move',
    moves: [{nodeId: randomUUID(), x: 1, y: 1}]})]) as any;
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'SEQUENCE_EDIT_CONTRACT_INVALID');
  const invalid = preview(service, world, [{side: 'board', operation: {kind: 'board.shot.append'}} as never]) as any;
  assert.equal(invalid.ok, false);
  assert.equal(history(service, world).position, 0);
});

test('preview allocates the new edge identity for connect and insert board actions', (t: test.TestContext) => {
  const world = makeWorld(t);
  const service = createFormat5Service(world);
  runPreviewed(service, world, [{side: 'board', operation: {kind: 'board', edit: {kind: 'disconnect', fromId: shotA, toId: shotB}}}]);
  const connectPreview = preview(service, world, [{side: 'board', operation: {kind: 'board',
    edit: {kind: 'connect', fromId: shotA, toId: shotB}}}]);
  assert.ok(connectPreview.envelope.allocation.edges.some((edge: any) => edge.fromId === shotA && edge.toId === shotB));
  commit(service, world, connectPreview);
  // A newly allocated random edge id decides `ORDER BY id`; compare the set, not the row order.
  assert.deepEqual(readSequenceEditContext(world.store).board.edges.map(edge => `${edge.fromId}>${edge.toId}`).sort(),
    [`${rootId}>${shotA}`, `${shotA}>${shotB}`].sort());
  undo(service, world);
  assert.equal(readSequenceEditContext(world.store).board.edges.length, 1);
  redo(service, world);
  assert.equal(readSequenceEditContext(world.store).board.edges.length, 2);
});

function createFormat5Service(world: ChainWorld): Service {
  return createFormat5SequenceEditService(world.store);
}
