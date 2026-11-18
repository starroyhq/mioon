import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {createSequenceEditing, planSequenceEditIntents, readSequenceEditContext} from '../packages/business/src/sequence-edit.ts';
import {prepareSequenceEditHistory, readSequenceEditHistoryEntry} from '../packages/business/src/format5-editor-history.ts';
import {sequenceEditOperationName} from '../packages/contracts/src/sequence-edit.ts';
import type {
  SequenceEditAllocation, SequenceEditBaseline, SequenceEditEnvelope, SequenceEditHistoryEntry,
  SequenceEditImpact, SequenceEditIntent,
} from '../packages/contracts/src/sequence-edit.ts';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import type {ChainWorld} from './helpers/sequence-edit-double.ts';

const id = (suffix: string): string => suffix;
const rootId = id('10000000-0000-4000-8000-000000000001');
const shotA = id('10000000-0000-4000-8000-000000000010');
const shotB = id('10000000-0000-4000-8000-000000000011');
const clipA = id('10000000-0000-4000-8000-000000000020');
const clipB = id('10000000-0000-4000-8000-000000000021');
const edgeRootA = id('10000000-0000-4000-8000-000000000030');
const edgeAB = id('10000000-0000-4000-8000-000000000031');

function emptyImpact(): SequenceEditImpact {
  return {nodeIds: [], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []};
}
function emptyAllocation(): SequenceEditAllocation {
  return {clips: [], nodes: [], splitClips: [], edges: []};
}
function historyState(world: ChainWorld) {
  return prepareSequenceEditHistory(world.store).state;
}
function envelopeFor(world: ChainWorld, intents: readonly SequenceEditIntent[],
  overrides: Partial<SequenceEditEnvelope> = {}): SequenceEditEnvelope {
  const context = readSequenceEditContext(world.store);
  const state = historyState(world);
  const baseline: SequenceEditBaseline = {
    contentRevision: readProjectContentStamp(world.store.db).contentSequence,
    timelineRevision: context.timeline.revision, syncRevision: context.syncRevision,
    historyPosition: state.position, historyRevision: state.revision, targets: [],
  };
  return {
    contractVersion: 1, projectId: world.projectId, epoch: state.epoch, actionId: randomUUID(),
    requestId: `request-${randomUUID()}`, originSide: 'board', filmId: world.rootId,
    intents, baseline, impact: emptyImpact(), allocation: emptyAllocation(), ...overrides,
  };
}
function entryOf(world: ChainWorld, actionId: string): SequenceEditHistoryEntry {
  const entry = readSequenceEditHistoryEntry(world.store, actionId);
  assert.ok(entry, 'history entry must exist');
  return entry;
}
function undoCommand(world: ChainWorld, actionId: string) {
  const state = historyState(world);
  return {projectId: world.projectId, requestId: `undo-${randomUUID()}`, actionId,
    expected: {position: state.position, revision: state.revision}};
}
function redoCommand(world: ChainWorld, actionId: string) {
  const state = historyState(world);
  return {projectId: world.projectId, requestId: `redo-${randomUUID()}`, actionId,
    expected: {position: state.position, revision: state.revision}};
}
function disconnectIntent(fromId: string, toId: string): SequenceEditIntent {
  return {side: 'board', operation: {kind: 'board', edit: {kind: 'disconnect', fromId, toId}}};
}
function connectIntent(fromId: string, toId: string): SequenceEditIntent {
  return {side: 'board', operation: {kind: 'board', edit: {kind: 'connect', fromId, toId}}};
}
function failureCode(run: () => unknown): string | undefined {
  try { run(); return undefined; } catch (error) { return (error as {code?: string}).code; }
}

function world(t: test.TestContext): ChainWorld {
  return createChainWorld(t, {
    rootId,
    shots: [{id: shotA, title: 'A', versionId: '10000000-0000-4000-8000-000000000050'},
      {id: shotB, title: 'B', versionId: '10000000-0000-4000-8000-000000000051'}],
    versions: [
      {versionId: '10000000-0000-4000-8000-000000000050', assetId: '10000000-0000-4000-8000-000000000060',
        sha256: 'a'.repeat(64), durationSeconds: 4},
      {versionId: '10000000-0000-4000-8000-000000000051', assetId: '10000000-0000-4000-8000-000000000061',
        sha256: 'b'.repeat(64), durationSeconds: 4},
    ],
    clips: [
      {nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 60},
      {nodeId: shotB, clipId: clipB, startFrame: 60, durationFrames: 60},
    ],
    edges: [{id: edgeRootA, fromId: rootId, toId: shotA}, {id: edgeAB, fromId: shotA, toId: shotB}],
  });
}

test('a board disconnect commits through the shared transaction, replays and undoes', t => {
  const chain = world(t), editing = createSequenceEditing(chain.store);
  const envelope = envelopeFor(chain, [disconnectIntent(rootId, shotA)]);
  const liveEdge = chain.store.db.prepare('SELECT data FROM project.edges WHERE id=?').get(edgeRootA) as {data: string};
  const receipt = editing.call('sequence.edit', envelope) as Record<string, unknown>;
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.actionId, envelope.actionId);
  assert.equal(receipt.operation, 'board.disconnect');
  assert.deepEqual(receipt.affected, {nodes: 0, edges: 1, mainTrackClips: 2, otherTrackItems: 0, subtitleCues: 0});
  assert.equal(chain.store.db.prepare('SELECT 1 FROM project.edges WHERE id=?').get(edgeRootA), undefined);
  assert.deepEqual(historyState(chain), {epoch: envelope.epoch, position: 1, revision: 2});
  const entry = entryOf(chain, envelope.actionId);
  assert.equal(entry.beforePatch.timeline.clips.length, 2);
  const removedBefore = entry.beforePatch.board.writes.find(entity => entity.id === edgeRootA);
  assert.equal(removedBefore?.data?.source, rootId);
  assert.equal(JSON.parse(liveEdge.data).target, shotA);

  // An exact retry returns the immutable receipt and writes nothing new.
  const replay = editing.call('sequence.edit', envelope) as Record<string, unknown>;
  assert.deepEqual(replay, receipt);
  assert.deepEqual(historyState(chain), {epoch: envelope.epoch, position: 1, revision: 2});

  // A reused request id with another payload is refused without touching state.
  const reused = {...envelope, actionId: randomUUID(), intents: [connectIntent(rootId, shotA)]};
  assert.equal(failureCode(() => editing.call('sequence.edit', reused)), 'SEQUENCE_EDIT_REQUEST_REUSED');

  // Undo restores the edge and moves the cursor backward; redo replays it.
  const undo = editing.call('sequence.undo', undoCommand(chain, envelope.actionId)) as Record<string, unknown>;
  assert.equal(undo.operation, 'undo:board.disconnect');
  assert.equal(chain.store.db.prepare('SELECT 1 FROM project.edges WHERE id=?').get(edgeRootA) !== undefined, true);
  assert.deepEqual(historyState(chain), {epoch: envelope.epoch, position: 0, revision: 3});
  const redo = editing.call('sequence.redo', redoCommand(chain, envelope.actionId)) as Record<string, unknown>;
  assert.equal(redo.operation, 'redo:board.disconnect');
  assert.equal(chain.store.db.prepare('SELECT 1 FROM project.edges WHERE id=?').get(edgeRootA), undefined);
  assert.deepEqual(historyState(chain), {epoch: envelope.epoch, position: 1, revision: 4});
});

test('the sequence service only exists for explicit format-5 projects', t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-format4-seq-'));
  const format4 = createProjectStore({projectId: randomUUID(), projectFile: path.join(root, 'project.mioon'),
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {format4.close(); rmSync(root, {recursive: true, force: true});});
  format4.put('projects', {id: format4.projectId, name: 'Format 4', revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'});
  const editing = createSequenceEditing(format4);
  assert.equal(failureCode(() => editing.call('sequence.history.get', {projectId: format4.projectId})), 'UNKNOWN_OPERATION');
});

test('a stale baseline is refused with the shared revision code', t => {
  const chain = world(t), editing = createSequenceEditing(chain.store);
  const envelope = envelopeFor(chain, [disconnectIntent(rootId, shotA)],
    {baseline: {...envelopeFor(chain, []).baseline, timelineRevision: 99}});
  assert.equal(failureCode(() => editing.call('sequence.edit', envelope)), 'SEQUENCE_EDIT_REVISION_CONFLICT');
});

test('the transaction-internal CS entry exposes the shared operation name', () => {
  assert.equal(sequenceEditOperationName([disconnectIntent(rootId, shotA)]), 'board.disconnect');
  assert.equal(typeof planSequenceEditIntents, 'function');
});

// Additional operation envelope coverage.

const shotC = id('10000000-0000-4000-8000-000000000012');
const clipC = id('10000000-0000-4000-8000-000000000022');
const textNode = id('10000000-0000-4000-8000-000000000070');
const root2 = id('10000000-0000-4000-8000-000000000002');
const shotD = id('10000000-0000-4000-8000-000000000013');
const clipD = id('10000000-0000-4000-8000-000000000023');

function linearWorld(t: test.TestContext, shots: readonly string[]): ChainWorld {
  const versions = shots.map((shot, index) => ({
    versionId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    assetId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    sha256: '0123456789abcdef'[index % 16]!.repeat(64), durationSeconds: 4,
  }));
  const clips = shots.map((shot, index) => ({nodeId: shot,
    clipId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    startFrame: index * 60, durationFrames: 60, versionId: versions[index]!.versionId}));
  const edges = [{id: `50000000-0000-4000-8000-000000000001`, fromId: rootId, toId: shots[0]!},
    ...shots.slice(1).map((shot, index) => ({id: `50000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
      fromId: shots[index]!, toId: shot}))];
  return createChainWorld(t, {rootId, shots: shots.map((shot, index) => ({id: shot, title: `Shot ${index}`,
    versionId: versions[index]!.versionId})), versions, clips, edges});
}

test('classification and graph rules reject illegal ports, extra predecessors/successors and cycles', t => {
  const chain = linearWorld(t, [shotA, shotB]);
  const textWorld = createChainWorld(t, {rootId, nodes: [{id: textNode, type: 'text', name: 'Note'}],
    shots: [{id: shotA, title: 'A'}], clips: [{nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 60}],
    edges: [{id: edgeRootA, fromId: rootId, toId: shotA}]});
  const textEditing = createSequenceEditing(textWorld.store);
  const editing = createSequenceEditing(chain.store);
  assert.equal(failureCode(() => textEditing.call('sequence.edit',
    envelopeFor(textWorld, [connectIntent(textNode, shotA)]))), 'TEXT_IS_ANNOTATION');
  assert.equal(failureCode(() => editing.call('sequence.edit',
    envelopeFor(chain, [connectIntent(shotA, rootId)]))), 'FILM_MUST_START');
  // A already has a predecessor (root); connecting B -> A would give it two.
  assert.equal(failureCode(() => editing.call('sequence.edit',
    envelopeFor(chain, [connectIntent(shotB, shotA)]))), 'MULTIPLE_PREDECESSORS');
  // Root already has one successor, A.
  assert.equal(failureCode(() => editing.call('sequence.edit',
    envelopeFor(chain, [connectIntent(rootId, shotB)]))), 'MULTIPLE_SUCCESSORS');

  // Cycle rejection is covered on the pure planning entry: a persisted cycle
  // can never be committed by the kernel, so the planner is the only reachable
  // CS boundary for this diagnostic.
  const cyclicState = {board: {nodes: [{id: shotA, kind: 'shot' as const}, {id: shotB, kind: 'shot' as const},
    {id: shotC, kind: 'shot' as const}], edges: [{fromId: shotA, toId: shotB}, {fromId: shotB, toId: shotC},
    {fromId: shotC, toId: shotA}]}, filmId: rootId, media: [], clips: [], anchored: []};
  const cyclePlan = planSequenceEditIntents(cyclicState, [connectIntent(rootId, shotA)], emptyAllocation());
  assert.equal(cyclePlan.ok, false);
  assert.equal(cyclePlan.ok === false ? cyclePlan.code : undefined, 'CYCLE');
});

test('inserting an existing node reorders the chain and rewires its edges', t => {
  const chain = linearWorld(t, [shotA, shotB, shotC]);
  const editing = createSequenceEditing(chain.store);
  const envelope = envelopeFor(chain, [{side: 'board', operation: {kind: 'board',
    edit: {kind: 'insert', fromId: rootId, toId: shotA, nodeId: shotC}}}], {
    allocation: {...emptyAllocation(), edges: [
      {id: '60000000-0000-4000-8000-000000000001', fromId: rootId, toId: shotC},
      {id: '60000000-0000-4000-8000-000000000002', fromId: shotC, toId: shotA},
    ]},
  });
  const receipt = editing.call('sequence.edit', envelope) as Record<string, unknown>;
  assert.equal(receipt.operation, 'board.insert');
  const edges = chain.store.db.prepare('SELECT data FROM project.edges ORDER BY id').all().map(row => JSON.parse(String(row.data)));
  const links = edges.map(edge => `${edge.source}>${edge.target}`).sort();
  assert.deepEqual(links, [`${rootId}>${shotC}`, `${shotC}>${shotA}`, `${shotA}>${shotB}`].sort());
  const context = readSequenceEditContext(chain.store);
  assert.deepEqual(context.clips.map(clip => clip.nodeId), [shotC, shotA, shotB]);
  const entry = entryOf(chain, envelope.actionId);
  assert.equal(entry.afterPatch.board.removals.length, 2);
  assert.ok(JSON.stringify(entry.beforePatch).length + JSON.stringify(entry.afterPatch).length <= 4 * 1024 * 1024);
});

test('deleting a middle node archives it, reconnects the neighbours and undo restores it', t => {
  const chain = linearWorld(t, [shotA, shotB]);
  const editing = createSequenceEditing(chain.store);
  const envelope = envelopeFor(chain, [{side: 'board', operation: {kind: 'board',
    edit: {kind: 'delete', nodeId: shotA}}}], {
    allocation: {...emptyAllocation(), edges: [{id: '60000000-0000-4000-8000-000000000010', fromId: rootId, toId: shotB}]},
  });
  editing.call('sequence.edit', envelope);
  const archived = chain.store.db.prepare('SELECT data,archivedAt FROM project.shots WHERE id=?').get(shotA) as {data: string; archivedAt: string | null};
  assert.equal(typeof archived.archivedAt, 'string');
  const links = chain.store.db.prepare('SELECT data FROM project.edges ORDER BY id').all().map(row => JSON.parse(String(row.data)));
  assert.deepEqual(links.map(edge => `${edge.source}>${edge.target}`), [`${rootId}>${shotB}`]);
  // Undo restores the shot row and both original edges.
  editing.call('sequence.undo', undoCommand(chain, envelope.actionId));
  assert.equal((chain.store.db.prepare('SELECT archivedAt FROM project.shots WHERE id=?').get(shotA) as {archivedAt: string | null}).archivedAt, null);
  const restored = chain.store.db.prepare('SELECT data FROM project.edges ORDER BY id').all().map(row => JSON.parse(String(row.data)))
    .map(edge => `${edge.source}>${edge.target}`).sort();
  assert.deepEqual(restored, [`${rootId}>${shotA}`, `${shotA}>${shotB}`].sort());
});

test('connecting an archived node restores it in the same action', t => {
  const chain = createChainWorld(t, {rootId,
    shots: [{id: shotA, title: 'A'}, {id: shotB, title: 'B', versionId: null}],
    nodes: [{id: textNode, type: 'text', name: 'Note'}],
    clips: [{nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 60}],
    edges: [{id: edgeRootA, fromId: rootId, toId: shotA}],
    archived: [{table: 'shots', id: shotB}]});
  const editing = createSequenceEditing(chain.store);
  const envelope = envelopeFor(chain, [connectIntent(shotA, shotB)], {
    allocation: {...emptyAllocation(), clips: [{nodeId: shotB, clipId: '60000000-0000-4000-8000-000000000021'}],
      edges: [{id: '60000000-0000-4000-8000-000000000020', fromId: shotA, toId: shotB}]},
  });
  editing.call('sequence.edit', envelope);
  assert.equal((chain.store.db.prepare('SELECT archivedAt FROM project.shots WHERE id=?').get(shotB) as {archivedAt: string | null}).archivedAt, null);
  const links = chain.store.db.prepare('SELECT data FROM project.edges').all().map(row => JSON.parse(String(row.data)));
  assert.deepEqual(links.map(edge => `${edge.source}>${edge.target}`).sort(), [`${rootId}>${shotA}`, `${shotA}>${shotB}`].sort());
});

test('a second film root can be edited without changing the bound film track', t => {
  const chain = createChainWorld(t, {rootId,
    shots: [{id: shotA, title: 'A'}, {id: shotD, title: 'D'}],
    clips: [{nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 60}],
    edges: [{id: edgeRootA, fromId: rootId, toId: shotA},
      {id: '60000000-0000-4000-8000-000000000030', fromId: root2, toId: shotD}],
    nodes: [{id: root2, type: 'sequence_root', name: 'Second film'}]});
  const editing = createSequenceEditing(chain.store);
  const otherScope = envelopeFor(chain, [{side: 'board', operation: {kind: 'board',
    edit: {kind: 'disconnect', fromId: root2, toId: shotD}}}]);
  assert.equal(failureCode(() => editing.call('sequence.edit', otherScope)), 'FILM_SCOPE_MISMATCH',
    'an action names its bound film root');
  const receipt = editing.call('sequence.edit', envelopeFor(chain, [disconnectIntent(rootId, shotA)])) as Record<string, unknown>;
  assert.equal(receipt.status, 'applied');
  const secondRootEdge = chain.store.db.prepare('SELECT data FROM project.edges WHERE id=?')
    .get('60000000-0000-4000-8000-000000000030') as {data: string};
  assert.deepEqual(JSON.parse(secondRootEdge.data), {id: '60000000-0000-4000-8000-000000000030', projectId: chain.projectId,
    source: root2, target: shotD, kind: 'sequence', createdAt: '2026-01-01T00:00:00.000Z'});
  assert.ok(!readSequenceEditContext(chain.store).clips.length);
});

test('history projection exposes undo/redo availability and conflicts', t => {
  const chain = world(t), editing = createSequenceEditing(chain.store);
  const initial = editing.call('sequence.history.get', {projectId: chain.projectId}) as Record<string, unknown>;
  assert.equal(initial.position, 0);
  assert.equal(initial.undoAvailable, false);
  const envelope = envelopeFor(chain, [disconnectIntent(rootId, shotA)]);
  editing.call('sequence.edit', envelope);
  const afterAction = editing.call('sequence.history.get', {projectId: chain.projectId}) as Record<string, unknown>;
  assert.equal(afterAction.undoAvailable, true);
  assert.equal(afterAction.redoAvailable, false);
  assert.equal((afterAction.undo as {actionId: string}).actionId, envelope.actionId);
  editing.call('sequence.undo', undoCommand(chain, envelope.actionId));
  const afterUndo = editing.call('sequence.history.get', {projectId: chain.projectId}) as Record<string, unknown>;
  assert.equal(afterUndo.undoAvailable, false);
  assert.equal(afterUndo.redoAvailable, true);
  // A stale expected cursor cannot undo blindly.
  assert.equal(failureCode(() => editing.call('sequence.undo', {projectId: chain.projectId,
    requestId: `undo-${randomUUID()}`, actionId: envelope.actionId, expected: {position: 1, revision: 2}})),
  'SEQUENCE_EDIT_HISTORY_CONFLICT');
});
