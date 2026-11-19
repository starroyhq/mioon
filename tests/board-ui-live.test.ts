import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLiveBoard} from '../apps/web/src/board-ui/live.ts';
import {BoardUiSession} from '../apps/web/src/board-ui/live-session.ts';
import {boardConnectIntent, boardLayoutIntent, boardRootCreateIntent, boardShotAppendIntent} from '../apps/web/src/board-ui/live.ts';

const id = (number: number): string => `60000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const projectId = id(1), root = id(2), shotA = id(3), shotB = id(4), image = id(5), text = id(6);
const versionA = id(20), assetA = id(10), imageAsset = id(11);
const at = '2026-01-01T00:00:00.000Z';
const rows = () => ({
  shots: [
    {id: shotA, title: '窗口剪影', selectedVersionId: versionA, position: {x: 100, y: 20}, aspectRatio: '16:9', duration: 2},
    {id: shotB, title: '占位镜头', selectedVersionId: null, position: {x: 390, y: 20}, aspectRatio: '9:16', duration: 5},
  ],
  nodes: [
    {id: root, type: 'sequence_root', name: '成片', position: {x: 0, y: 20}},
    {id: image, type: 'image', assetId: imageAsset, label: '参考图', position: {x: 0, y: 260}},
    {id: text, type: 'text', label: '旁白', position: {x: 0, y: 460}},
  ],
  edges: [
    {id: id(30), kind: 'sequence', source: root, target: shotA},
    {id: id(31), kind: 'sequence', source: shotA, target: shotB},
    {id: id(32), kind: 'reference', source: image, target: shotA, role: 'first_frame'},
  ],
  versions: [{id: versionA, shotId: shotA, assetId: assetA, number: 2}],
  assets: [{id: assetA, duration: 2, mimeType: 'video/mp4'}, {id: imageAsset, duration: null, mimeType: 'image/png'}],
  jobs: [{id: id(50), shotId: shotB, status: 'running'}],
});

test('live projection follows the saved chain, reference membership and generation state', () => {
  const input = rows();
  const board = projectLiveBoard({...input, frameAspect: '9:16',
    thumbnailFor: assetId => assetId === assetA ? 'thumb-a' : null});
  assert.deepEqual(board.projection.films.map(film => film.id), [root]);
  assert.deepEqual(board.projection.films[0]!.items.map(item => item.nodeId), [shotA, shotB]);
  assert.equal(board.projection.films[0]!.aspectRatio, '9:16');
  assert.equal(board.projection.films[0]!.durationFrames, 60 + 150);
  // The reference image is attached to a chain shot, so only the unconnected
  // text card is detached (UI-B1 rule).
  assert.deepEqual(board.projection.floatingNodeIds, [text]);
  const a = board.nodes.find(node => node.id === shotA)!;
  assert.equal(a.status, 'ready'); assert.equal(a.durationFrames, 60); assert.equal(a.thumbnailUrl, 'thumb-a');
  const b = board.nodes.find(node => node.id === shotB)!;
  assert.equal(b.status, 'generating'); assert.equal(b.durationFrames, 150); assert.equal(b.thumbnailUrl, null);
  assert.deepEqual(board.positions[shotA], {x: 100, y: 20});
  assert.equal(board.projection.overview.floatingCount, 1);
});

test('projection skips unknown node types and dangling edges instead of throwing', () => {
  const input = rows();
  const board = projectLiveBoard({...input, nodes: [...input.nodes, {id: id(60), type: 'mystery', name: 'x'}],
    edges: [...input.edges, {id: id(61), kind: 'sequence', source: id(62), target: shotA}]});
  assert.equal(board.nodes.some(node => node.id === id(60)), false);
  assert.equal(board.edges.some(edge => edge.id === id(61)), false);
});

test('command builders emit exactly the shared board intents', () => {
  assert.deepEqual(boardConnectIntent(shotA, shotB), {side: 'board',
    operation: {kind: 'board', edit: {kind: 'connect', fromId: shotA, toId: shotB}}});
  assert.deepEqual(boardLayoutIntent([{nodeId: shotA, x: 1, y: 2}]), {side: 'board',
    operation: {kind: 'board.layout.move', moves: [{nodeId: shotA, x: 1, y: 2}]}});
  assert.deepEqual(boardRootCreateIntent(root, '第二部', {x: 8, y: 9}), {side: 'board',
    operation: {kind: 'board.root.create', nodeId: root, name: '第二部', position: {x: 8, y: 9}}});
  assert.deepEqual(boardShotAppendIntent(shotA, '新镜头'), {side: 'board',
    operation: {kind: 'board.shot.append', nodeId: shotA, name: '新镜头'}});
});

function recorder(outcomes: Record<string, (input: any) => unknown>) {
  const calls: {operation: string; input: any}[] = [];
  const rpc = async (operation: string, input: any) => {
    calls.push({operation, input});
    const handler = outcomes[operation];
    if (!handler) throw Object.assign(new Error('missing'), {code: 'GENERIC'});
    return handler(input);
  };
  return {calls, rpc};
}
const intent = boardConnectIntent(shotA, shotB);

test('the session previews the intent and commits exactly the returned envelope and digest', async () => {
  const envelope = {contractVersion: 1, projectId, requestId: 'preview-1', intents: [intent]};
  const {calls, rpc} = recorder({
    'sequence.preview': () => ({envelope, planDigest: 'a'.repeat(64), warnings: []}),
    'sequence.commit': () => ({ok: true, actionId: id(70), operation: 'board.connect',
      receipt: {status: 'applied', actionId: id(70), operation: 'board.connect'}}),
  });
  const session = new BoardUiSession(rpc, () => projectId);
  const outcome = await session.run(intent);
  assert.equal(outcome.ok, true);
  assert.equal(calls.map(call => call.operation).join(','), 'sequence.preview,sequence.commit');
  assert.equal(calls[1]!.input.expectedPlanDigest, 'a'.repeat(64));
  assert.deepEqual(calls[1]!.input.envelope, envelope);
});

test('an in-flight board command blocks a second click and preview failures surface their code', async () => {
  let release!: (value: unknown) => void;
  const gate = new Promise(resolve => {release = resolve;});
  const done = {ok: true, actionId: id(70), operation: 'board.connect', receipt: {status: 'applied'}};
  const {calls, rpc} = recorder({
    'sequence.preview': async () => {await gate; return {envelope: {requestId: 'p'}, planDigest: 'b'.repeat(64)};},
    'sequence.commit': () => done,
  });
  const session = new BoardUiSession(rpc, () => projectId);
  const first = session.run(intent);
  const second = await session.run(intent);
  assert.equal(second.ok, false);
  release(null);
  assert.equal((await first).ok, true);
  assert.equal(calls.filter(call => call.operation === 'sequence.commit').length, 1);
  const failing = new BoardUiSession(recorder({'sequence.preview': () => ({ok: false, code: 'SEQUENCE_EDIT_REVISION_CONFLICT'})}).rpc,
    () => projectId);
  const result = await failing.run(intent);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'SEQUENCE_EDIT_REVISION_CONFLICT');
});

test('the session binds history and read projections through the same operations', async () => {
  const history = {epoch: projectId, position: 2, revision: 3, undo: {actionId: id(80), operation: 'board.delete', affected: 1},
    redo: null, atEarliest: false};
  const mount = {projectId, timelineRevision: 4, syncRevision: 2, inSync: true, archived: []};
  const {calls, rpc} = recorder({
    'sequence.history.get': () => history,
    'sequence.board.get': () => mount,
    'sequence.undo': () => ({ok: true, actionId: id(80), operation: 'undo:board.delete', receipt: {status: 'applied'}}),
  });
  const session = new BoardUiSession(rpc, () => projectId);
  assert.deepEqual(await session.history(), history);
  assert.deepEqual(await session.board(), mount);
  const outcome = await session.undo(history as never);
  assert.equal(outcome.ok, true);
  assert.equal(calls.at(-1)!.input.actionId, id(80));
  assert.deepEqual(calls.at(-1)!.input.expected, {position: 2, revision: 3});
});

test('reference-line commands and the unified session carry the shared reference intent', async () => {
  const {referenceAttachRequest, subjectBindingCreateRequest, referenceRoleRequest, referenceDetachRequest,
    subjectBindingDetachRequest, referenceReorderRequest, isBoardEditRequest, unsupportedReasonKey,
    referenceRoleOptions} = await import('../apps/web/src/board-ui/inputs.ts');
  const attach = referenceAttachRequest(image, shotA, 'first_frame') as {referenceIntent: any};
  assert.equal(attach.referenceIntent.side, 'board');
  assert.equal(attach.referenceIntent.operation.kind, 'reference-edge');
  assert.equal(attach.referenceIntent.operation.edit.kind, 'attach');
  assert.equal(attach.referenceIntent.operation.edit.shotId, shotA);
  assert.equal(attach.referenceIntent.operation.edit.sourceNodeId, image);
  assert.equal(attach.referenceIntent.operation.edit.role, 'first_frame');
  assert.match(attach.referenceIntent.operation.edit.edgeId, /^[0-9a-f-]{36}$/u);
  const subject = subjectBindingCreateRequest(shotA, id(90), 'style') as {subjectIntent: any};
  assert.equal(subject.subjectIntent.operation.edit.kind, 'create');
  assert.equal(subject.subjectIntent.operation.edit.role, 'style');
  assert.equal(isBoardEditRequest(attach), true);
  assert.equal(isBoardEditRequest({side: 'board', operation: {kind: 'board'}}), false);
  assert.equal((referenceRoleRequest(id(91), shotA, 'reference_image') as {referenceIntent: any})
    .referenceIntent.operation.edit.role, 'reference_image');
  assert.equal((referenceDetachRequest(id(91), shotA) as {referenceIntent: any})
    .referenceIntent.operation.edit.kind, 'detach');
  assert.equal((subjectBindingDetachRequest(id(92)) as {subjectIntent: any})
    .subjectIntent.operation.edit.kind, 'detach');
  assert.deepEqual((referenceReorderRequest(shotA, [id(93), id(94)]) as {referenceIntent: any})
    .referenceIntent.operation.edit.edgeIds, [id(93), id(94)]);
  assert.deepEqual(referenceRoleOptions('image'), ['first_frame', 'last_frame', 'reference_image', 'composition']);
  assert.equal(unsupportedReasonKey('EXCLUSIVE_MODE'), 'boardUi.inputs.reason.exclusiveMode');
  assert.equal(unsupportedReasonKey('SOMETHING_NEW'), 'boardUi.inputs.unsupported');

  const {calls, rpc} = recorder({
    'sequence.preview': (input: any) => ({envelope: {contractVersion: 1, projectId, requestId: input.requestId,
      referenceIntent: input.referenceIntent}, planDigest: 'c'.repeat(64), warnings: []}),
    'sequence.commit': () => ({ok: true, actionId: id(95), operation: 'reference.attach',
      receipt: {status: 'applied', actionId: id(95), operation: 'reference.attach'}}),
  });
  const session = new BoardUiSession(rpc, () => projectId);
  const outcome = await session.run(attach);
  assert.equal(outcome.ok, true);
  assert.equal(calls[0]!.input.referenceIntent.operation.edit.kind, 'attach');
  assert.equal(Object.hasOwn(calls[0]!.input, 'intents'), false);
  assert.equal(calls[1]!.input.envelope.referenceIntent.operation.edit.kind, 'attach');
});
