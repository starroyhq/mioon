import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSubjectController, normalizeSubjectAssets, subjectImage, subjectImageChoices,
} from '../apps/web/src/subject-state.ts';

const projectId = '60000000-0000-4000-8000-000000000001';
const scope = 'format5-project:1:1';
const format5View = Object.freeze([{id: '60000000-0000-4000-8000-000000000010', mimeType: 'image/png', name: 'reference.png'}]);

test('a format-5 asset view without projectId joins the subject image choices through the project context', () => {
  // The old create dialog filtered the raw asset view: the missing projectId
  // dropped the just-imported image and left only the placeholder.
  assert.deepEqual(subjectImageChoices(format5View, projectId), []);
  // The controller context owns the open project and stamps an ownerless view.
  const contextAssets = normalizeSubjectAssets(format5View, projectId);
  assert.deepEqual(subjectImageChoices(contextAssets, projectId), [contextAssets[0]]);
  assert.equal(subjectImage(contextAssets[0], projectId), true);
  // An explicit foreign owner is never borrowed, and formats 3/4 views (which
  // already carry their own projectId) pass through unchanged.
  const foreign = normalizeSubjectAssets([{id: 'foreign', projectId: 'other-project', mimeType: 'image/png'}], projectId);
  assert.deepEqual(subjectImageChoices(foreign, projectId), []);
  assert.deepEqual(normalizeSubjectAssets([{id: 'owned', projectId, mimeType: 'image/jpeg'}], projectId),
    [{id: 'owned', projectId, mimeType: 'image/jpeg'}]);
  assert.deepEqual(subjectImageChoices(normalizeSubjectAssets([{id: 'clip', mimeType: 'video/mp4'}], projectId), projectId), []);
});

test('creating a subject from a format-5 view without projectId now reaches subject.create', async () => {
  const calls: {operation: string; input: Record<string, unknown>}[] = [];
  const controller = createSubjectController({
    read: async () => ({items: [], nextCursor: null}),
    save: async (operation, input) => { calls.push({operation, input}); return {id: '60000000-0000-4000-8000-000000000099'}; },
  });
  controller.setContext({scope, projectId, assets: format5View, shotIds: []});
  controller.updateCreate({name: '走查主体甲', assetId: format5View[0]!.id}, scope);
  await controller.create(scope);
  assert.deepEqual(calls.map(call => call.operation), ['subject.create']);
  assert.equal(calls[0]!.input.assetId, format5View[0]!.id);

  // A foreign asset never reaches the server.
  calls.length = 0;
  const foreign = createSubjectController({
    read: async () => ({items: [], nextCursor: null}),
    save: async (operation, input) => { calls.push({operation, input}); return {id: 'unexpected'}; },
  });
  foreign.setContext({scope, projectId, assets: [{id: '60000000-0000-4000-8000-000000000011', projectId: 'other', mimeType: 'image/png'}], shotIds: []});
  foreign.updateCreate({name: '外部主体', assetId: '60000000-0000-4000-8000-000000000011'}, scope);
  assert.equal(await foreign.create(scope), null);
  assert.deepEqual(calls, []);
});
