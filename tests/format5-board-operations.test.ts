import test from 'node:test';
import assert from 'node:assert/strict';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {createCanvasEditing} from '../packages/business/src/canvas-editing.ts';
import type {SequenceEditHistoryView} from '../packages/contracts/src/sequence-edit.ts';

const rootId = '10000000-0000-4000-8000-000000000001';
const shotA = '10000000-0000-4000-8000-000000000010';
const shotB = '10000000-0000-4000-8000-000000000011';
const clipA = '10000000-0000-4000-8000-000000000020';
const clipB = '10000000-0000-4000-8000-000000000021';
const versionA = '10000000-0000-4000-8000-000000000050';
const versionB = '10000000-0000-4000-8000-000000000051';
const assetA = '10000000-0000-4000-8000-000000000060';
const assetB = '10000000-0000-4000-8000-000000000061';
const edgeRootA = '10000000-0000-4000-8000-000000000030';
const edgeAB = '10000000-0000-4000-8000-000000000031';
const documentId = '10000000-0000-4000-8000-000000000090';

function fixture(t: test.TestContext) {
  const world = createChainWorld(t, {
    rootId,
    shots: [{id: shotA, title: 'A', versionId: versionA}, {id: shotB, title: 'B', versionId: versionB}],
    versions: [{versionId: versionA, assetId: assetA, sha256: 'a'.repeat(64), durationSeconds: 4},
      {versionId: versionB, assetId: assetB, sha256: 'b'.repeat(64), durationSeconds: 4}],
    clips: [{nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 60, versionId: versionA},
      {nodeId: shotB, clipId: clipB, startFrame: 60, durationFrames: 60, versionId: versionB}],
    edges: [{id: edgeRootA, fromId: rootId, toId: shotA}, {id: edgeAB, fromId: shotA, toId: shotB}],
  });
  world.store.tx(() => {
    // The synthetic chain fixture only carries identity/order fields; canvas
    // clipboard copy expects the complete saved shot grammar.
    for (const id of [shotA, shotB]) {
      const row = world.store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(id) as {data: string};
      world.store.put('shots', {...JSON.parse(row.data), prompt: '', aspectRatio: '9:16', referenceAssetIds: [], revision: 1,
        parameters: {}, position: {x: id === shotA ? 0 : 300, y: 0}, selectedVersionId: JSON.parse(row.data).selectedVersionId});
    }
    for (const [kind, ids] of [['shot', [shotA, shotB]], ['node', [rootId]], ['timeline_clip', [clipA, clipB]]] as const) {
      for (const id of ids) {
        world.store.db.prepare(`INSERT OR REPLACE INTO project.agent_task_target_revisions_v2
          (projectId,kind,targetId,revision) VALUES(?,?,?,1)`).run(world.projectId, kind, id);
      }
    }
  });
  const owner = {};
  const service = createFormat5SequenceEditService(world.store, {clipboardOwner: owner});
  return {world, owner, service};
}
type Service = ReturnType<typeof fixture>['service'];
function run(service: Service, projectId: string, requestId: string, intents: readonly unknown[]) {
  const preview = service.preview({projectId, requestId, intents}) as {envelope: unknown; planDigest: string};
  assert.ok(preview.envelope, JSON.stringify(preview));
  return service.commit({projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest}) as
    {status: string; affected: Record<string, number>};
}
function sql(world: ReturnType<typeof fixture>['world'], statement: string, ...args: unknown[]): Record<string, unknown> | undefined {
  return world.store.db.prepare(statement).get(...args as never[]) as Record<string, unknown> | undefined;
}

test('node create/update and shot update share the unified board transaction and one-step undo', (t) => {
  const {world, service} = fixture(t);
  const textId = '10000000-0000-4000-8000-0000000000a1';
  run(service, world.projectId, 'fr-c-node-create-1', [{side: 'board', operation: {kind: 'board.node.create',
    nodeId: textId, nodeType: 'text', name: 'Note', position: {x: 10, y: 20}, text: 'hello'}}]);
  let row = sql(world, 'SELECT data FROM project.nodes WHERE id=? AND projectId=?', textId, world.projectId)!;
  let node = JSON.parse(String(row.data)) as Record<string, unknown>;
  assert.equal(node.type, 'text');
  assert.equal(node.text, 'hello');
  assert.equal(node.label, 'Note');
  // Update text node name/text and the shot title in one action.
  run(service, world.projectId, 'fr-c-update-1', [
    {side: 'board', operation: {kind: 'board.node.update', nodeId: textId, expectedRevision: 1, patch: {name: 'Renamed', text: 'edited'}}},
    {side: 'board', operation: {kind: 'board.shot.update', shotId: shotA, expectedRevision: 1, patch: {title: 'Shot A2', duration: 3}}},
  ]);
  node = JSON.parse(String(sql(world, 'SELECT data FROM project.nodes WHERE id=?', textId)!.data)) as Record<string, unknown>;
  assert.equal(node.name, 'Renamed');
  assert.equal(node.text, 'edited');
  const shot = JSON.parse(String(sql(world, 'SELECT data FROM project.shots WHERE id=?', shotA)!.data)) as Record<string, unknown>;
  assert.equal(shot.title, 'Shot A2');
  assert.equal(shot.duration, 3);
  // A stale editor revision is refused before any row changes.
  const stale = service.preview({projectId: world.projectId, requestId: 'fr-c-stale-rev-1',
    intents: [{side: 'board', operation: {kind: 'board.node.update', nodeId: textId, expectedRevision: 99,
      patch: {name: 'Stale'}}}]}) as {ok?: boolean; code?: string};
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'REVISION_CONFLICT');
  // One undo reverses both rows (the action is shared).
  const view = service.history({projectId: world.projectId}) as SequenceEditHistoryView;
  assert.ok(view.undo);
  service.undo({projectId: world.projectId, requestId: 'fr-c-update-undo-1', actionId: view.undo.actionId,
    expected: {position: view.position, revision: view.revision}});
  node = JSON.parse(String(sql(world, 'SELECT data FROM project.nodes WHERE id=?', textId)!.data)) as Record<string, unknown>;
  assert.equal(node.text, 'hello');
  assert.equal(JSON.parse(String(sql(world, 'SELECT data FROM project.shots WHERE id=?', shotA)!.data)).title, 'A');
});

test('archive/restore and duplicate/paste create detached board rows with the shared undo stack', (t) => {
  const {world, owner, service} = fixture(t);
  // A chain shot archives through the existing board delete plan (its main-track
  // clip and sequence edges leave the projection).
  run(service, world.projectId, 'fr-c-archive-1', [{side: 'board', operation: {kind: 'board', edit: {kind: 'delete', nodeId: shotB}}}]);
  let archived = sql(world, 'SELECT archivedAt FROM project.shots WHERE id=?', shotB)!;
  assert.equal(typeof archived.archivedAt, 'string');
  assert.equal(sql(world, 'SELECT 1 FROM project.edges WHERE id=?', edgeAB), undefined);
  run(service, world.projectId, 'fr-c-restore-1', [{side: 'board', operation: {kind: 'board.restore',
    items: [{kind: 'shot', id: shotB}]}}]);
  archived = sql(world, 'SELECT archivedAt FROM project.shots WHERE id=?', shotB)!;
  assert.equal(archived?.archivedAt, null);
  // UI-B2 restore semantics: the shot re-enters at the active chain tail.
  assert.ok(sql(world, "SELECT 1 FROM project.edges WHERE json_extract(data,'$.source')=? AND json_extract(data,'$.target')=?", shotA, shotB),
    'restored shot is connected to the chain tail');
  // Duplicate copies a live shot as a detached board row (no chain edge). The
  // new id is allocated by preview in allocation.nodes and commit reuses it.
  const before = Number(sql(world, 'SELECT COUNT(*) AS n FROM project.shots')!.n);
  const duplicatePreview = service.preview({projectId: world.projectId, requestId: 'fr-c-duplicate-1',
    intents: [{side: 'board', operation: {kind: 'board.duplicate', items: [{kind: 'shot', id: shotA}],
      viewport: {x: 200, y: 200, width: 400, height: 300}}}]}) as
      {envelope: {allocation: {nodes: {fromNodeId: string; nodeId: string}[]}}; planDigest: string};
  const pair = duplicatePreview.envelope.allocation.nodes.find(item => item.fromNodeId === shotA);
  assert.ok(pair, 'duplicate allocates its new id in the preview envelope');
  service.commit({projectId: world.projectId, envelope: duplicatePreview.envelope as never,
    expectedPlanDigest: duplicatePreview.planDigest});
  assert.equal(Number(sql(world, 'SELECT COUNT(*) AS n FROM project.shots')!.n), before + 1);
  assert.ok(sql(world, 'SELECT data FROM project.shots WHERE id=?', pair!.nodeId), 'commit writes the previewed id');
  // Clipboard snapshot + paste through the same owner creates another detached copy.
  const canvas = createCanvasEditing(world.store, {clipboardOwner: owner});
  const shotRevision = Number(sql(world, `SELECT revision FROM project.agent_task_target_revisions_v2
    WHERE projectId=? AND kind='shot' AND targetId=?`, world.projectId, shotA)!.revision);
  const snapshot = canvas.call('canvas.copy.snapshot', {projectId: world.projectId, documentId,
    targets: [{kind: 'shot', id: shotA, revision: shotRevision}]}) as {snapshotId: string};
  assert.ok(snapshot.snapshotId);
  const pastePreview = service.preview({projectId: world.projectId, requestId: 'fr-c-paste-1',
    intents: [{side: 'board', operation: {kind: 'board.paste', documentId, snapshotId: snapshot.snapshotId,
      viewport: {x: 400, y: 400, width: 400, height: 300}}}]}) as
      {envelope: {allocation: {nodes: {fromNodeId: string; nodeId: string}[]}}; planDigest: string};
  const pastePair = pastePreview.envelope.allocation.nodes[0];
  assert.ok(pastePair, 'paste allocates its new id in the preview envelope');
  service.commit({projectId: world.projectId, envelope: pastePreview.envelope as never,
    expectedPlanDigest: pastePreview.planDigest});
  assert.ok(sql(world, 'SELECT data FROM project.shots WHERE id=?', pastePair!.nodeId), 'paste writes the previewed id');
  const detached = world.store.db.prepare(`SELECT data FROM project.shots WHERE archivedAt IS NULL
    AND json_extract(data,'$.title')='A'`).all() as {data: string}[];
  assert.ok(detached.length >= 3, `expected original plus two detached copies, got ${detached.length}`);
});

