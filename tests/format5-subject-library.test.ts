import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBoardUiWireFixture, BOARD_IDS} from './helpers/board-ui-wire-fixture.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

/** WT-3-02 product decision 11-21: the format-5 subject library's create and
 * add-version are asset-library writes. They only touch subjects/subject_versions
 * (retained evidence) and never the board, the timeline or the unified undo
 * stack. Format 3/4 keeps its existing behavior. */
test('format 5 creates a subject and a second version without touching the board, timeline or history', async t => {
  const fixture = await createBoardUiWireFixture();
  t.after(() => { fixture.services.drain?.(); fixture.store.close(); fixture.library.close(); });
  const call = (operation: string, input: unknown): Promise<any> => fixture.services.call(operation, input) as Promise<any>;
  const imported = await call('asset.import', {projectId: fixture.projectId, name: '版本二.png',
    mimeType: 'image/png', dataBase64: png({width: 640, height: 960, rgba: false, tagged: false}).toString('base64')});
  const versionTwoAssetId = String(imported.id);
  const before = await call('project.get', {projectId: fixture.projectId});
  const historyBefore = await call('sequence.history.get', {projectId: fixture.projectId});
  const timelineBefore = JSON.stringify({timeline: before.timeline, edges: before.edges, nodes: before.nodes});

  const created = await call('subject.create', {projectId: fixture.projectId, requestId: `wt3-create-${randomUUID()}`,
    kind: 'character', name: '走查主体甲', assetId: BOARD_IDS.imageAsset});
  assert.equal(created.kind, 'character');
  assert.equal(created.headVersion.number, 1);
  assert.equal(created.headVersion.assetId, BOARD_IDS.imageAsset);

  const added = await call('subject.version.add', {projectId: fixture.projectId, requestId: `wt3-version-${randomUUID()}`,
    subjectId: created.id, expectedRevision: created.revision, assetId: versionTwoAssetId});
  assert.equal(added.headVersion.number, 2);
  assert.equal(added.headVersion.assetId, versionTwoAssetId);
  assert.equal(added.revision, 2);

  const list = await call('subject.list', {projectId: fixture.projectId, limit: 20});
  const listed = list.items.find((subject: {id: string}) => subject.id === created.id);
  assert.ok(listed, 'the new subject joins the project subject list');
  assert.equal(listed.headVersion.number, 2);
  const versions = await call('subject.version.list', {projectId: fixture.projectId, subjectId: created.id, limit: 20});
  assert.deepEqual(versions.items.map((version: {number: number}) => version.number).sort((a: number, b: number) => a - b), [1, 2],
    'both retained versions are readable');

  const after = await call('project.get', {projectId: fixture.projectId});
  assert.equal(JSON.stringify({timeline: after.timeline, edges: after.edges, nodes: after.nodes}), timelineBefore,
    'subject library writes never touch the board or the timeline');
  const historyAfter = await call('sequence.history.get', {projectId: fixture.projectId});
  assert.equal(historyAfter.position, historyBefore.position,
    'subject library writes do not enter the board/timeline undo stack');
});
