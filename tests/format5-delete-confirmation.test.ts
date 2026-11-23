import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const section = (start: string, end: string) => app.slice(app.indexOf(start), app.indexOf(end));
function compile(scope: Record<string, unknown>, start: string, end: string, name: string) {
  const code = `${transformSync(section(start, end), {loader: 'tsx', format: 'cjs'}).code}\nreturn ${name};`;
  return Function(...Object.keys(scope), code)(...Object.values(scope));
}
function harness() {
  const runs: {nodeId: string; notice: string}[] = [], reviews: {nodeId: string; count: number}[] = [];
  const shot = (id: string) => ({id, projectId: 'p', title: id, selectedVersionId: null});
  const scope: Record<string, unknown> = {
    dataRef: {current: {shots: [shot('generated'), shot('plain')], versions: [{id: 'v', shotId: 'generated'}],
      timeline: {clips: [{sequenceSource: {nodeId: 'plain'}}]}}},
    format5BoardProjection: {nodes: [{id: 'generated', name: 'Generated'}, {id: 'plain', name: 'Plain'}]},
    format5DeleteReview: null,
    setFormat5DeleteReview: (value: {nodeId: string; count: number} | null) => {reviews.push(value as never); scope.format5DeleteReview = value;},
    format5BoardRun: async (intent: {nodeId: string}, notice: string) => {runs.push({nodeId: intent.nodeId, notice}); return {ok: true};},
    boardDeleteIntent: (nodeId: string) => ({nodeId}),
    t: (key: string, params: {count: number}) => `${key}:${params.count}`,
  };
  const del = compile(scope, 'async function format5BoardDeleteNode(', 'async function format5BoardConfirmDelete(', 'format5BoardDeleteNode');
  const confirm = () => compile({...scope, format5DeleteReview: scope.format5DeleteReview},
    'async function format5BoardConfirmDelete(', 'async function format5BoardUpdateNode(', 'format5BoardConfirmDelete')();
  return {del, confirm, runs, reviews, scope};
}
test('format-5 delete asks once for a shot with generated video or a main-track segment', async () => {
  const f = harness();
  await f.del('generated');
  await f.del('plain');
  assert.deepEqual(f.reviews, [{nodeId: 'generated', count: 1}, {nodeId: 'plain', count: 1}]);
  assert.deepEqual(f.runs, [], 'the first click does not write');
  f.scope.format5DeleteReview = {nodeId: 'generated', count: 1};
  await f.confirm();
  assert.deepEqual(f.runs, [{nodeId: 'generated', notice: 'boardUi.notice.deletedCount:1'}]);
  assert.equal(f.scope.format5DeleteReview, null);
});
test('format-5 delete stays direct for an ordinary node', async () => {
  const f = harness();
  f.scope.dataRef = {current: {shots: [{id: 'note', projectId: 'p', title: 'Note', selectedVersionId: null}], versions: [], timeline: {clips: []}}};
  f.scope.format5BoardProjection = {nodes: [{id: 'note', name: 'Note'}]};
  await f.del('note');
  assert.deepEqual(f.reviews, []);
  assert.deepEqual(f.runs, [{nodeId: 'note', notice: 'boardUi.notice.deletedCount:1'}]);
});

test('a format-5 commit rejection keeps its bounded reason for the specific restore notice', async () => {
  const {classifyCommitFailure} = await import('../apps/web/src/edit-ui/lost-response.ts');
  const {ApiError} = await import('../apps/web/src/api.ts');
  const failure = classifyCommitFailure(new ApiError('项目内容与格式 5 不符。', 'PROJECT_INVALID',
    {database: 'project', reason: 'metadata'}, true, 422));
  assert.deepEqual(failure, {kind: 'rejected', code: 'PROJECT_INVALID', reason: 'metadata'});
});

test('board right-click and Delete-key deletion go through the workbench delete decision', () => {
  const board = readFileSync(new URL('../apps/web/src/board-ui/BoardUiLive.tsx', import.meta.url), 'utf8');
  assert.match(board, /readonly onDelete\?: \(nodeId: string\) => void/u);
  assert.match(board, /data-testid="board-menu-delete"[^>]*onClick=\{\(\) => deleteNode\(menuNode\.id, menuNode\.name\)\}/u);
  assert.match(board, /event\.key === 'Delete' \|\| event\.key === 'Backspace'[\s\S]*?deleteNode\(node\.id, node\.name\)/u);
  const fixture = readFileSync(new URL('./fixtures/board-ui-wire/entry.tsx', import.meta.url), 'utf8');
  assert.match(fixture, /onDelete=\{nodeId => \{void run\(boardDeleteIntent\(nodeId\)/u,
    'the real board wire fixture exercises the same delete callback');
});
