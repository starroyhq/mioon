import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLiveBoard, subjectBindingCreateOperation, subjectBindingDetachOperation,
  subjectCardCreateOperation, subjectCardDeleteOperation} from '../apps/web/src/board-ui/live.ts';
import {BoardUiSession} from '../apps/web/src/board-ui/live-session.ts';
import {LostResponseState, UNCONFIRMED_CODE} from '../apps/web/src/edit-ui/lost-response.ts';
import {ApiError} from '../apps/web/src/api.ts';
import type {RequestOutcome} from '../apps/web/src/request-outcome-client.ts';
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
  const mount = {projectId, timelineRevision: 4, syncRevision: 2, inSync: true, archived: [], subjects: [], bindings: []};
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
    referenceRoleOptions, unsupportedReferenceEdgeIds} = await import('../apps/web/src/board-ui/inputs.ts');
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
  // No service selected changes nothing on the connectors.
  assert.equal(unsupportedReferenceEdgeIds(null, []).size, 0);
  assert.equal(unsupportedReferenceEdgeIds({service: null, entries: [{status: 'unsupported',
    edgeId: id(96), source: 'edge', role: 'reference_audio', sourceKind: 'audio', label: 'x', orderIndex: 0}]} as never,
  [{id: id(96), kind: 'reference'}]).size, 0);
  // With a service, material and subject lines both map to their connector.
  const unsupported = unsupportedReferenceEdgeIds({service: {providerId: 'wan', modelId: 'wan3.0-video',
    modelName: 'Wan', profileId: 'p', profileVersion: 'v'}, entries: [{status: 'unsupported', edgeId: id(96),
      source: 'edge', role: 'reference_audio', sourceKind: 'audio', label: 'x', orderIndex: 0},
    {status: 'unsupported', bindingId: id(97), source: 'subject', role: 'subject_reference',
      sourceKind: 'subject', label: 'y', orderIndex: 1}]} as never, [{id: id(96), kind: 'reference'},
    {id: id(98), kind: 'reference', subjectBindingId: id(97)}]);
  assert.deepEqual([...unsupported].sort(), [id(96), id(98)].sort());

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

test('live projection names subject cards from retained subject rows and never copies works', () => {
  const input = rows();
  const cardId = id(70), subjectId = id(71), subjectVersion = id(72), subjectAsset = id(73);
  const board = projectLiveBoard({...input, nodes: [...input.nodes, {id: cardId, type: 'subject_card',
    subjectId, position: {x: 20, y: 700}}], subjects: [{id: subjectId, name: '阿琦', kind: 'character',
    headVersionId: subjectVersion, headAssetId: subjectAsset}], thumbnailFor: asset => asset === subjectAsset ? 'subject-thumb' : null});
  const card = board.nodes.find(node => node.id === cardId)!;
  assert.equal(card.kind, 'subject');
  assert.equal(card.name, '阿琦');
  assert.equal(card.subjectId, subjectId);
  assert.equal(card.subjectKind, 'character');
  assert.equal(card.thumbnailUrl, 'subject-thumb');
  assert.equal(board.nodes.filter(node => node.kind === 'subject').length, 1);
});

test('subject command builders and the subject preview/commit handshake keep identities', async () => {
  assert.deepEqual(subjectCardCreateOperation(id(70), id(71), {x: 1, y: 2}),
    {kind: 'subject.card.create', nodeId: id(70), subjectId: id(71), position: {x: 1, y: 2}});
  assert.deepEqual(subjectCardDeleteOperation(id(70)), {kind: 'subject.card.delete', nodeId: id(70)});
  assert.deepEqual(subjectBindingCreateOperation(id(80), id(3), id(71), 'style'), {kind: 'subject-binding',
    edit: {kind: 'create', bindingId: id(80), shotId: id(3), subjectId: id(71), role: 'style'}});
  assert.deepEqual(subjectBindingDetachOperation(id(80)), {kind: 'subject-binding', edit: {kind: 'detach', bindingId: id(80)}});
  const envelope = {contractVersion: 1, projectId, requestId: 'subject-1', subjectIntent: {side: 'board',
    operation: subjectCardDeleteOperation(id(70))}};
  const {calls, rpc} = recorder({
    'sequence.preview': () => ({envelope, planDigest: 'c'.repeat(64), warnings: []}),
    'sequence.commit': () => ({ok: true, actionId: id(90), operation: 'subject.card.delete',
      receipt: {status: 'applied', actionId: id(90), operation: 'subject.card.delete'}}),
  });
  const session = new BoardUiSession(rpc, () => projectId);
  const outcome = await session.runSubject(subjectCardDeleteOperation(id(70)));
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls[0]!.input, {projectId, requestId: calls[0]!.input.requestId,
    subjectIntent: {side: 'board', operation: {kind: 'subject.card.delete', nodeId: id(70)}}});
  assert.deepEqual(calls[1]!.input.envelope, envelope);
  assert.equal(calls[1]!.input.expectedPlanDigest, 'c'.repeat(64));
  const busy = new BoardUiSession(recorder({
    'sequence.preview': async () => {await new Promise(() => {}); return {envelope, planDigest: 'd'.repeat(64)};},
  }).rpc, () => projectId);
  void busy.runSubject(subjectCardDeleteOperation(id(70)));
  const second = await busy.runSubject(subjectCardDeleteOperation(id(70)));
  assert.equal(second.ok, false);
});

// ---------------------------------------------------------------------------
// Lost board commit response: one retained envelope, one read-only receipt
// lookup, retry/abandon without a second write.
// ---------------------------------------------------------------------------
const PLAN_DIGEST = 'e'.repeat(64);
type BoardScenario = 'applied' | 'not-applied' | 'lost-after-write' | 'lost-before-write' | 'rejected';
function boardHarness(initial: {readonly scenarios: readonly BoardScenario[];
  readonly read: RequestOutcome | 'missing' | 'error'}) {
  const calls: {operation: string; input: any}[] = [];
  const writes: {requestId: string; status: 'applied' | 'not_applied'}[] = [];
  const reads: {projectId: string; requestId: string}[] = [];
  const scenarios = [...initial.scenarios];
  let previews = 0;
  const rpc = async (operation: string, input: any) => {
    calls.push({operation, input});
    if (operation === 'sequence.preview') {
      previews++;
      return {envelope: {contractVersion: 1, projectId, requestId: `board-preview-${previews}`,
        intents: input.intents ?? []}, planDigest: PLAN_DIGEST, warnings: []};
    }
    if (operation === 'sequence.commit') {
      const scenario = scenarios.shift() ?? 'applied';
      const requestId = String(input.envelope.requestId);
      if (scenario === 'rejected') throw new ApiError('conflict', 'SEQUENCE_EDIT_REVISION_CONFLICT', {}, true, 409);
      if (scenario === 'lost-before-write') throw new ApiError('lost response', 'NETWORK', undefined, false);
      if (scenario === 'lost-after-write') {
        writes.push({requestId, status: 'applied'});
        throw new ApiError('lost response', 'NETWORK', undefined, false);
      }
      if (scenario === 'not-applied') {
        writes.push({requestId, status: 'not_applied'});
        return {status: 'not_applied', operation: 'board.connect', code: 'SEQUENCE_EDIT_NOOP'};
      }
      writes.push({requestId, status: 'applied'});
      return {status: 'applied', actionId: id(70), operation: 'board.connect'};
    }
    if (operation === 'sequence.history.get') return null;
    throw Object.assign(new Error(`unexpected ${operation}`), {code: 'GENERIC'});
  };
  const readOutcome = async (input: {projectId: string; requestId: string}): Promise<RequestOutcome> => {
    reads.push({projectId: input.projectId, requestId: input.requestId});
    if (initial.read === 'error') throw new ApiError('unavailable', 'REQUEST_OUTCOME_UNAVAILABLE', {}, false);
    if (initial.read === 'missing') return {applied: false, operation: null};
    return initial.read;
  };
  // The preview request id differs from the envelope request id, exactly like
  // the production preview; commit/receipt identity is `envelope.requestId`.
  const session = new BoardUiSession(rpc, () => projectId, {lost: new LostResponseState({readOutcome, readTimeoutMs: 20})});
  return {session, calls, writes, reads,
    commits: (): any[] => calls.filter(call => call.operation === 'sequence.commit'),
    previews: (): number => calls.filter(call => call.operation === 'sequence.preview').length};
}
const appliedBoardRead: RequestOutcome = {applied: true, operation: 'board.connect', status: 'applied', code: null};

test('a board commit whose response is lost resolves applied from one receipt read without writing twice', async () => {
  const h = boardHarness({scenarios: ['lost-after-write'], read: appliedBoardRead});
  const outcome = await h.session.run(intent);
  assert.equal(outcome.ok, true);
  if (outcome.ok) {assert.equal(outcome.status, 'applied'); assert.equal(outcome.actionId, null); assert.equal(outcome.resolvedFromReceipt, true);}
  assert.equal(h.writes.length, 1);
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.reads[0], {projectId, requestId: h.commits()[0]!.input.envelope.requestId});
  assert.equal(h.session.unconfirmed, null);
  // The same action after the settled edit is a new request, not a replay.
  const again = await h.session.run(intent);
  assert.equal(again.ok, true);
  assert.equal(h.commits().length, 2);
});

test('a board commit that never reached the service stays unconfirmed and retry executes exactly once', async () => {
  const h = boardHarness({scenarios: ['lost-before-write', 'applied'], read: 'missing'});
  const first = await h.session.run(intent);
  assert.equal(first.ok, false);
  if (!first.ok) {assert.equal(first.code, UNCONFIRMED_CODE); assert.equal('unconfirmed' in first, true);}
  assert.equal(h.session.unconfirmed?.requestId, h.commits()[0]!.input.envelope.requestId);
  assert.equal(h.writes.length, 0);
  const retried = await h.session.retryUnconfirmed();
  assert.equal(retried.ok, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.commits().length, 2);
  assert.equal(h.commits()[1]!.input.envelope.requestId, h.commits()[0]!.input.envelope.requestId);
  assert.deepEqual(h.commits()[1]!.input.envelope, h.commits()[0]!.input.envelope);
  assert.equal(h.commits()[1]!.input.expectedPlanDigest, PLAN_DIGEST);
  assert.equal(h.session.unconfirmed, null);
  const previews = h.previews();
  assert.equal(previews, 1, 'retry never previews again');
});

test('unconfirmed board edits block runMany and runSubject with the same reason', async () => {
  const h = boardHarness({scenarios: ['lost-before-write'], read: 'missing'});
  const first = await h.session.run(intent);
  assert.equal(first.ok, false);
  const callsBefore = h.calls.length;
  for (const blocked of [await h.session.runMany([intent]),
    await h.session.runSubject(subjectCardDeleteOperation(id(70)))]) {
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, UNCONFIRMED_CODE);
  }
  assert.equal(h.calls.length, callsBefore, 'blocked board writes make no preview or commit call');
});

test('a not-applied board receipt is surfaced as a rejection, not an applied outcome', async () => {
  const h = boardHarness({scenarios: ['not-applied'], read: 'missing'});
  const outcome = await h.session.run(intent);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'SEQUENCE_EDIT_NOOP');
  assert.equal(h.session.unconfirmed, null);
  assert.equal(h.writes[0]!.status, 'not_applied');
  // An explicit not-applied receipt is a conclusion: the next edit still works.
  const next = await h.session.run(intent);
  assert.equal(next.ok, true);
});

test('a definite board rejection keeps the old error path and never reads a receipt', async () => {
  const rejected = boardHarness({scenarios: ['rejected'], read: appliedBoardRead});
  const outcome = await rejected.session.run(intent);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'SEQUENCE_EDIT_REVISION_CONFLICT');
  assert.equal(rejected.reads.length, 0);
  assert.equal(rejected.session.unconfirmed, null);
});

test('board abandon drops the retained envelope without any follow-up write', async () => {
  const h = boardHarness({scenarios: ['lost-before-write'], read: 'missing'});
  await h.session.run(intent);
  assert.ok(h.session.unconfirmed);
  h.session.abandonUnconfirmed();
  assert.equal(h.session.unconfirmed, null);
  assert.equal(h.commits().length, 1);
  assert.equal(h.writes.length, 0);
  const next = await h.session.run(intent);
  assert.equal(next.ok, true);
  assert.equal(h.commits().length, 2);
});

test('a lost subject commit retries the same envelope and never re-previews', async () => {
  const h = boardHarness({scenarios: ['lost-before-write', 'applied'], read: 'missing'});
  const first = await h.session.runSubject(subjectCardDeleteOperation(id(70)));
  assert.equal(first.ok, false);
  const retried = await h.session.retryUnconfirmed();
  assert.equal(retried.ok, true);
  const commits = h.commits();
  assert.equal(commits.length, 2);
  assert.equal(commits[1]!.input.envelope.requestId, commits[0]!.input.envelope.requestId);
  assert.deepEqual(commits[1]!.input.envelope, commits[0]!.input.envelope);
  assert.equal(h.previews(), 1);
});


test('the film chain uses trimmed main-track clip lengths and marks video thumbnails', () => {
  const input = rows();
  const versionA = id(20), assetA = id(10);
  const board = projectLiveBoard({...input,
    clips: [
      {id: id(80), trackId: id(90), durationFrames: 90, sequenceSource: {kind: 'shot', nodeId: shotA}},
      {id: id(81), trackId: id(90), durationFrames: 60, sequenceSource: {kind: 'shot', nodeId: shotB}},
    ],
    assets: [{id: assetA, duration: 4, mimeType: 'video/mp4'}],
    versions: [{id: versionA, shotId: shotA, assetId: assetA, number: 1}],
    thumbnailFor: () => 'thumb-video'});
  assert.equal(board.projection.films[0]!.durationFrames, 90 + 60);
  const a = board.nodes.find(node => node.id === shotA)!;
  assert.equal(a.durationFrames, 90);
  assert.equal(a.thumbnailKind, 'video');
  assert.equal(board.nodes.find(node => node.id === shotB)!.durationFrames, 60);
});

test('a preview refusal carries its bounded reason into the board outcome', async () => {
  const session = new BoardUiSession(async () => ({ok: false, code: 'SEQUENCE_EDIT_REFERENCE_INVALID',
    reason: 'PREVIS_OUTPUT_REQUIRED', ids: []}), () => projectId);
  const outcome = await session.run(boardConnectIntent(shotA, shotB));
  assert.deepEqual(outcome, {ok: false, code: 'SEQUENCE_EDIT_REFERENCE_INVALID',
    reason: 'PREVIS_OUTPUT_REQUIRED', ids: []});
});
