import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoardUiWireFixture} from './helpers/board-ui-wire-fixture.ts';
import {BOARD_IDS} from './helpers/board-ui-wire-fixture.ts';

/** FR-C follow-up: the preview must allocate copied internal reference line ids
 * exactly like copied node ids, and the commit must write those ids. */
test('pasted internal reference edge ids travel in the preview envelope', async (t) => {
  const fixture = await createBoardUiWireFixture();
  t.after(() => {(fixture.services as {close?: () => void}).close?.(); fixture.store.close();});
  const {store, services, projectId} = fixture;
  const revision = (kind: string, id: string): number => {
    store.db.prepare(`INSERT OR REPLACE INTO project.agent_task_target_revisions_v2
      (projectId,kind,targetId,revision) VALUES(?,?,?,1)`).run(projectId, kind, id);
    return 1;
  };
  store.tx(() => {
    for (const id of [BOARD_IDS.shotA, BOARD_IDS.shotB]) {
      const row = store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(id) as {data: string};
      store.put('shots', {...JSON.parse(row.data), prompt: '', referenceAssetIds: id === BOARD_IDS.shotA ? [BOARD_IDS.imageAsset] : [], parameters: {}});
    }
  });
  const documentId = '70000000-0000-4000-8000-000000000099';
  const snapshot = await services.call('canvas.copy.snapshot', {projectId, documentId,
    targets: [{kind: 'node', id: BOARD_IDS.imageNode, revision: revision('node', BOARD_IDS.imageNode)},
      {kind: 'shot', id: BOARD_IDS.shotA, revision: revision('shot', BOARD_IDS.shotA)}]}) as {snapshotId: string};
  assert.ok(snapshot.snapshotId);
  const preview = await services.call('sequence.preview', {projectId, requestId: 'fr-c-edge-preview-1',
    intents: [{side: 'board', operation: {kind: 'board.paste', documentId, snapshotId: snapshot.snapshotId,
      viewport: {x: 600, y: 400, width: 600, height: 400}}}]}) as {
      envelope: {allocation: {nodes: {fromNodeId: string; nodeId: string}[];
        edges: {id: string; fromId: string; toId: string}[]}};
      planDigest: string};
  const imageCopy = preview.envelope.allocation.nodes.find(item => item.fromNodeId === BOARD_IDS.imageNode)!.nodeId;
  const shotCopy = preview.envelope.allocation.nodes.find(item => item.fromNodeId === BOARD_IDS.shotA)!.nodeId;
  const pair = preview.envelope.allocation.edges.find(item => item.fromId === imageCopy && item.toId === shotCopy);
  assert.ok(pair, 'preview allocates the copied reference edge id');
  await services.call('sequence.commit', {projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
  const row = store.db.prepare('SELECT data FROM project.edges WHERE id=?').get(pair!.id) as {data: string} | undefined;
  assert.ok(row, 'commit writes the exact previewed edge id');
  const data = JSON.parse(row.data) as {source: string; target: string};
  assert.equal(data.source, imageCopy);
  assert.equal(data.target, shotCopy);
});
