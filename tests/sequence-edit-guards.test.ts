import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {assertLegacyCanvasWriteAllowed, readSequenceEditContext} from '../packages/business/src/sequence-edit.ts';
import {createLocalMutationServices} from '../packages/business/src/local-mutations.ts';
import {inspectCanvasDependencies, readSequenceDependencyComponent} from '../packages/business/src/canvas-dependencies.ts';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import {createSequenceEditing} from '../packages/business/src/sequence-edit.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {prepareSequenceEditHistory, readSequenceEditHistoryEntry} from '../packages/business/src/format5-editor-history.ts';
import type {SequenceEditAllocation, SequenceEditEnvelope, SequenceEditIntent} from '../packages/contracts/src/sequence-edit.ts';

const id = (value: string): string => value;
const rootId = id('10000000-0000-4000-8000-000000000001');
const shotA = id('10000000-0000-4000-8000-000000000010');
const shotB = id('10000000-0000-4000-8000-000000000011');
const clipA = id('10000000-0000-4000-8000-000000000020');
const clipB = id('10000000-0000-4000-8000-000000000021');

function chain(t: test.TestContext) {
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
    clips: [{nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 60, versionId: '10000000-0000-4000-8000-000000000050'},
      {nodeId: shotB, clipId: clipB, startFrame: 60, durationFrames: 60, versionId: '10000000-0000-4000-8000-000000000051'}],
    edges: [{id: '10000000-0000-4000-8000-000000000030', fromId: rootId, toId: shotA},
      {id: '10000000-0000-4000-8000-000000000031', fromId: shotA, toId: shotB}],
  });
}

test('ambiguous legacy canvas writes are rejected under explicit format-5 admission', t => {
  const world = chain(t);
  for (const use of ['edge', 'order', 'version', 'archive'] as const) {
    assert.throws(() => assertLegacyCanvasWriteAllowed(world.store, use), (error: {code?: string}) =>
      error.code === 'UNSUPPORTED_OPERATION', use);
  }
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-format4-guard-'));
  const format4 = createProjectStore({projectId: randomUUID(), projectFile: path.join(root, 'project.mioon'),
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {format4.close(); rmSync(root, {recursive: true, force: true});});
  assert.doesNotThrow(() => assertLegacyCanvasWriteAllowed(format4, 'edge'));
});

test('legacy shot order and version selection handlers refuse to bypass the chain', t => {
  const world = chain(t);
  const mutations = createLocalMutationServices(world.store, {
    check: () => {}, canonical: JSON.stringify, now: () => '2026-01-01T00:00:00.000Z',
    references: {guardManualUpdate: () => {}}, format5: true,
  });
  assert.throws(() => mutations.handlers['shot.reorder']!({projectId: world.projectId, expectedRevision: 1,
    shotIds: [shotA, shotB]} as never), (error: {code?: string}) => error.code === 'UNSUPPORTED_OPERATION');
  assert.throws(() => mutations.handlers['version.select']!({shotId: shotA, versionId: '10000000-0000-4000-8000-000000000050',
    expectedRevision: 1} as never), (error: {code?: string}) => error.code === 'UNSUPPORTED_OPERATION');
});

test('the format-5 dependency component retains chain nodes, edges and main-track clips', t => {
  const world = chain(t);
  const component = readSequenceDependencyComponent(world.store, [{kind: 'shot', id: shotA}]);
  assert.deepEqual([...component.nodeIds].sort(), [rootId, shotA, shotB].sort());
  assert.deepEqual([...component.edgeIds].sort(), ['10000000-0000-4000-8000-000000000030', '10000000-0000-4000-8000-000000000031']);
  assert.deepEqual([...component.clipIds].sort(), [clipA, clipB].sort());
  // A read-only dependency inspection still completes on the format-5 project.
  const effects = inspectCanvasDependencies(world.store, [{kind: 'shot', id: shotA}, {kind: 'node', id: shotA}]);
  assert.equal(typeof effects.digest, 'string');
  assert.deepEqual(effects.blocked, []);
  // Creating a format-5 edit action must observe the chain order before write.
  assert.equal(readSequenceEditContext(world.store).clips.length, 2);
});

test('a 500-segment project keeps common-action history patches within the frozen budget', t => {
  const count = 500;
  const shots = Array.from({length: count}, (_, index) => ({id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    title: `Shot ${index}`, versionId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`}));
  const versions = shots.map((shot, index) => ({versionId: shot.versionId!,
    assetId: `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    sha256: '0123456789abcdef'[index % 16]!.repeat(64), durationSeconds: 4}));
  const clips = shots.map((shot, index) => ({nodeId: shot.id,
    clipId: `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    startFrame: index * 60, durationFrames: 60, versionId: shot.versionId!}));
  const edges = [{id: '70000000-0000-4000-8000-000000000001', fromId: rootId, toId: shots[0]!.id},
    ...shots.slice(1).map((shot, index) => ({id: `70000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
      fromId: shots[index]!.id, toId: shot.id}))];
  const freshWorld = (): ReturnType<typeof createChainWorld> => createChainWorld(t, {rootId, shots, versions, clips, edges});
  const measure = (label: string, world: ReturnType<typeof createChainWorld>,
    intents: readonly SequenceEditIntent[], allocation: SequenceEditAllocation): number => {
    const editing = createSequenceEditing(world.store);
    const state = prepareSequenceEditHistory(world.store).state;
    const context = readSequenceEditContext(world.store);
    const envelope: SequenceEditEnvelope = {contractVersion: 1, projectId: world.projectId, epoch: state.epoch,
      actionId: randomUUID(), requestId: `request-${randomUUID()}`, originSide: 'board', filmId: world.rootId, intents,
      baseline: {contentRevision: readProjectContentStamp(world.store.db).contentSequence,
        timelineRevision: context.timeline.revision, syncRevision: context.syncRevision,
        historyPosition: state.position, historyRevision: state.revision, targets: []},
      impact: {nodeIds: [], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []}, allocation};
    const started = performance.now();
    editing.call('sequence.edit', envelope);
    const elapsed = performance.now() - started;
    const entry = readSequenceEditHistoryEntry(world.store, envelope.actionId);
    if (!entry) throw new Error(`${label} did not record a history entry`);
    const bytes = Buffer.byteLength(JSON.stringify(entry.beforePatch)) + Buffer.byteLength(JSON.stringify(entry.afterPatch));
    t.diagnostic(`${label}: history patch ${bytes} bytes, ${elapsed.toFixed(1)} ms`);
    assert.ok(bytes <= 4 * 1024 * 1024, `${label} exceeds the frozen 4 MiB entry budget`);
    return bytes;
  };
  const sizes: number[] = [];
  {
    const world = freshWorld();
    sizes.push(measure('500-segment disconnect', world, [{side: 'board', operation: {kind: 'board',
      edit: {kind: 'disconnect', fromId: shots[248]!.id, toId: shots[249]!.id}}}], emptyAllocation()));
  }
  {
    const world = freshWorld();
    sizes.push(measure('500-segment delete reattach', world, [{side: 'board', operation: {kind: 'board',
      edit: {kind: 'delete', nodeId: shots[249]!.id}}}], {...emptyAllocation(),
      edges: [{id: '80000000-0000-4000-8000-000000000001', fromId: shots[248]!.id, toId: shots[250]!.id}]}));
  }
  {
    const world = freshWorld();
    sizes.push(measure('500-segment insert (head reorder)', world, [{side: 'board', operation: {kind: 'board',
      edit: {kind: 'insert', fromId: rootId, toId: shots[0]!.id, nodeId: shots[count - 1]!.id}}}], {
      ...emptyAllocation(), edges: [
        {id: '80000000-0000-4000-8000-000000000010', fromId: rootId, toId: shots[count - 1]!.id},
        {id: '80000000-0000-4000-8000-000000000011', fromId: shots[count - 1]!.id, toId: shots[0]!.id},
      ]}));
  }
  const average = sizes.reduce((sum, value) => sum + value, 0) / sizes.length;
  t.diagnostic(`average history patch: ${Math.round(average)} bytes`);
  assert.ok(average > 0);
});

function emptyAllocation(): SequenceEditAllocation {
  return {clips: [], nodes: [], splitClips: [], edges: []};
}
