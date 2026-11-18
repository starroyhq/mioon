import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {FORMAT5_LIMITS, FORMAT5_STORAGE_ERROR_CODES, format5SyncBaselineSchema} from '../packages/contracts/src/project-format5.ts';
import type {Format5SyncBaseline} from '../packages/contracts/src/project-format5.ts';
import type {ChainSyncOperation, ChainSyncState, ChainSyncPlan} from '../packages/contracts/src/chain-sync-algorithm.ts';
import {
  SEQUENCE_EDIT_CONTRACT_VERSION, SEQUENCE_EDIT_DIGEST_DOMAIN, SEQUENCE_EDIT_ERRORS, SEQUENCE_EDIT_ERROR_CODES,
  SEQUENCE_EDIT_BASELINE_CHANGE_KINDS, SEQUENCE_EDIT_LIMITS, SEQUENCE_EDIT_NEW_ERROR_CODES,
  SEQUENCE_EDIT_OPERATIONS, SEQUENCE_EDIT_TARGET_KINDS, applySequenceEditBaselineChange,
  canonicalSequenceEditInput, invertSequenceEditPatch, isSequenceEditEnvelope, isSequenceEditErrorCode,
  isSequenceEditInputDigest, isSequenceEditIntentSequence, isSequenceEditRequestId, isSequenceEditUuid,
  sequenceEditEnvelopeSchema, sequenceEditHistoryEntrySchema, sequenceEditImpactCount,
  sequenceEditIntentOperationName, sequenceEditIntentSide, sequenceEditOperationName, sequenceEditReceiptSchema,
  sequenceEditUtf8Bytes,
} from '../packages/contracts/src/sequence-edit.ts';
import type {
  BoardSeamProjectionPort, MainTrackProjectionPort, SequenceEditBaselineChange, SequenceEditEnvelope,
  SequenceEditHistoryEntry, SequenceEditIntent, SequenceEditPatch, SequenceEditPlan, SequenceEditReceipt,
  SequenceEditService, SequenceEditStateDelta, SequenceEditTransactionRequest,
} from '../packages/contracts/src/sequence-edit.ts';

const uuid = (last: string): string => `10000000-0000-4000-8000-${last.padStart(12, '0')}`;
const projectId = uuid('1'), filmId = uuid('2'), actionId = uuid('3'), epoch = uuid('4');
const nodeA = uuid('10'), nodeB = uuid('11');
const shotA = uuid('20'), shotB = uuid('21');
const clipA = uuid('30');

const boardDelta = {writes: [], removals: []} as const;
const timelineDelta = {clips: [], cues: [], removedClipIds: [], removedCueIds: [], baseline: {kind: 'unchanged'} as const} as const;
const emptyDelta: SequenceEditStateDelta = {board: {...boardDelta}, timeline: {...timelineDelta}};

const intent = (operation: ChainSyncOperation): SequenceEditIntent => ({side: sequenceEditIntentSide(operation), operation});
const connect: ChainSyncOperation = {kind: 'board', edit: {kind: 'connect', fromId: shotA, toId: shotB}};
const syncBoard: ChainSyncOperation = {kind: 'sync-board'};

function envelope(overrides: Partial<SequenceEditEnvelope> = {}): SequenceEditEnvelope {
  return {
    contractVersion: SEQUENCE_EDIT_CONTRACT_VERSION,
    projectId, epoch, actionId, requestId: 'request-0001', originSide: 'board', filmId,
    intents: [intent({kind: 'board', edit: {kind: 'connect', fromId: shotA, toId: shotB}})],
    baseline: {contentRevision: 7, timelineRevision: 3, syncRevision: 2, historyPosition: 0, historyRevision: 1,
      targets: [{kind: 'node', id: nodeA, revision: 4}]},
    impact: {nodeIds: [nodeA, nodeB], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []},
    allocation: {clips: [], nodes: [], splitClips: [], edges: [{id: uuid('40'), fromId: shotA, toId: shotB}]},
    ...overrides,
  };
}

test('the shared contract is versioned and mirrors the frozen history-13 bounds', () => {
  assert.equal(SEQUENCE_EDIT_CONTRACT_VERSION, 1);
  assert.equal(SEQUENCE_EDIT_LIMITS.patchBytes, FORMAT5_LIMITS.historyEntryBytes);
  assert.equal(SEQUENCE_EDIT_LIMITS.receiptBytes, FORMAT5_LIMITS.receiptResponseBytes);
  assert.equal(SEQUENCE_EDIT_LIMITS.historyEntries, FORMAT5_LIMITS.historyEntries);
  assert.equal(SEQUENCE_EDIT_LIMITS.historyBytes, FORMAT5_LIMITS.historyBytes);
  assert.equal(SEQUENCE_EDIT_LIMITS.impactIds,
    FORMAT5_LIMITS.mainTrackClips + FORMAT5_LIMITS.otherTrackClips + FORMAT5_LIMITS.subtitleCues);
  assert.equal(SEQUENCE_EDIT_LIMITS.operationBytes, 200);
  assert.equal(SEQUENCE_EDIT_LIMITS.intents, 2);
  assert.ok(Object.isFrozen(SEQUENCE_EDIT_LIMITS) && Object.isFrozen(SEQUENCE_EDIT_OPERATIONS));
});

test('identities, request keys and utf8 bounds are validated', () => {
  assert.equal(isSequenceEditUuid(uuid('9')), true);
  assert.equal(isSequenceEditUuid('not-a-uuid'), false);
  assert.equal(isSequenceEditUuid(1), false);
  assert.equal(isSequenceEditRequestId('12345678'), true);
  assert.equal(isSequenceEditRequestId('1234567'), false);
  assert.equal(isSequenceEditRequestId('x'.repeat(200)), true);
  assert.equal(isSequenceEditRequestId('x'.repeat(201)), false);
  assert.equal(isSequenceEditRequestId('😀'.repeat(200)), true, '200 code points are at most 800 utf8 bytes');
  assert.equal(isSequenceEditRequestId('😀'.repeat(201)), false);
  assert.equal(sequenceEditUtf8Bytes('😀'.repeat(200)), 800);
  assert.equal(isSequenceEditInputDigest('a'.repeat(64)), true);
  assert.equal(isSequenceEditInputDigest('A'.repeat(64)), false);
  assert.equal(isSequenceEditInputDigest('a'.repeat(63)), false);
});

test('side follows the SA operation kind and every kind maps to one stable name', () => {
  assert.equal(sequenceEditIntentSide({kind: 'board'}), 'board');
  assert.equal(sequenceEditIntentSide({kind: 'sync-board'}), 'board');
  assert.equal(sequenceEditIntentSide({kind: 'board-version'}), 'board');
  assert.equal(sequenceEditIntentSide({kind: 'track'}), 'timeline');
  const samples: Array<[ChainSyncOperation, string]> = [
    [{kind: 'board', edit: {kind: 'connect', fromId: shotA, toId: shotB}}, 'board.connect'],
    [{kind: 'board', edit: {kind: 'disconnect', fromId: shotA, toId: shotB}}, 'board.disconnect'],
    [{kind: 'board', edit: {kind: 'insert', fromId: shotA, toId: shotB, nodeId: nodeA}}, 'board.insert'],
    [{kind: 'board', edit: {kind: 'delete', nodeId: nodeA}}, 'board.delete'],
    [{kind: 'sync-board'}, 'board.sync'],
    [{kind: 'board-version', nodeId: nodeA, version: null}, 'board.version'],
    [{kind: 'track', edit: {kind: 'move', clipId: clipA, beforeClipId: null}}, 'timeline.clip.move'],
    [{kind: 'track', edit: {kind: 'move-off-track', clipId: clipA, trackId: uuid('50'), startFrame: 0}}, 'timeline.clip.move-off-track'],
    [{kind: 'track', edit: {kind: 'remove', clipId: clipA}}, 'timeline.clip.remove'],
    [{kind: 'track', edit: {kind: 'add', clip: {id: clipA, nodeId: nodeA, versionId: null, versionLocked: false,
      startFrame: 0, durationFrames: 30, sourceInFrame: 0}, beforeClipId: null}}, 'timeline.clip.add'],
    [{kind: 'track', edit: {kind: 'split', clipId: clipA, offsetFrames: 10, rightClipId: uuid('51')}}, 'timeline.clip.split'],
    [{kind: 'track', edit: {kind: 'trim', clipId: clipA, durationFrames: 20}}, 'timeline.clip.trim'],
    [{kind: 'track', edit: {kind: 'version', clipId: clipA, version: null, locked: false}}, 'timeline.clip.version'],
  ];
  assert.equal(samples.length, SEQUENCE_EDIT_OPERATIONS.length);
  for (const [operation, name] of samples) {
    assert.equal(sequenceEditIntentOperationName(operation), name);
    assert.equal((SEQUENCE_EDIT_OPERATIONS as readonly string[]).includes(name), true);
    assert.ok(SEQUENCE_EDIT_OPERATIONS.filter(item => item === name).length === 1, `${name} is unique`);
    assert.ok(sequenceEditUtf8Bytes(name) <= SEQUENCE_EDIT_LIMITS.operationBytes);
  }
  assert.equal(sequenceEditOperationName([intent(connect)]), 'board.connect');
  assert.equal(sequenceEditOperationName([intent({kind: 'board', edit: {kind: 'insert', fromId: shotA, toId: shotB,
    nodeId: nodeA}}), intent(syncBoard)]), 'board.insert+board.sync');
});

test('only one action or one repair action plus its sync-board projection is accepted', () => {
  assert.equal(isSequenceEditIntentSequence([intent(connect)]), true);
  assert.equal(isSequenceEditIntentSequence([intent(syncBoard)]), true);
  assert.equal(isSequenceEditIntentSequence([intent(connect), intent(syncBoard)]), true);
  assert.equal(isSequenceEditIntentSequence([intent(syncBoard), intent(connect)]), false);
  assert.equal(isSequenceEditIntentSequence([intent(connect), intent({kind: 'board-version', nodeId: nodeA, version: null})]), false);
  assert.equal(isSequenceEditIntentSequence([]), false);
  assert.equal(isSequenceEditIntentSequence([
    intent(connect), intent(syncBoard), intent(syncBoard),
  ]), false);
  const track: ChainSyncOperation = {kind: 'track', edit: {kind: 'remove', clipId: clipA}};
  assert.equal(isSequenceEditIntentSequence([intent(track), intent(syncBoard)]), false);
  const mismatched = {side: 'timeline', operation: connect} as unknown as SequenceEditIntent;
  assert.equal(isSequenceEditIntentSequence([mismatched]), false);
});

test('the envelope validator accepts a valid board action and rejects contract violations', () => {
  assert.equal(isSequenceEditEnvelope(envelope()), true);
  assert.deepEqual(sequenceEditEnvelopeSchema.safeParse(envelope()).success, true);
  assert.equal(sequenceEditEnvelopeSchema.safeParse(envelope({
    intents: [intent(connect), intent(syncBoard)] as readonly SequenceEditIntent[],
  })).success, true, 'a repair action may append its projection');

  const rejected: unknown[] = [
    envelope({contractVersion: 2 as never}),
    envelope({actionId: 'not-a-uuid'}),
    envelope({epoch: 'not-a-uuid'}),
    envelope({requestId: 'short'}),
    envelope({originSide: 'timeline'}),
    envelope({intents: []}),
    envelope({intents: [intent(syncBoard), intent(connect)]}),
    envelope({intents: [intent({kind: 'track', edit: {kind: 'remove', clipId: clipA}}), intent(syncBoard)]}),
    envelope({baseline: {...envelope().baseline, contentRevision: -1}}),
    envelope({baseline: {...envelope().baseline, targets: [{kind: 'node', id: nodeA, revision: 1},
      {kind: 'node', id: nodeA, revision: 2}]}}),
    envelope({impact: {...envelope().impact, nodeIds: [nodeA, nodeA]}}),
    envelope({allocation: {...envelope().allocation, clips: [{nodeId: nodeA, clipId: clipA},
      {nodeId: nodeB, clipId: clipA}]}}),
    envelope({impact: {...envelope().impact, nodeIds: Array.from({length: SEQUENCE_EDIT_LIMITS.impactIds + 1},
      (_, index) => uuid(String(index + 1000)))}}),
    {...envelope(), unexpected: true},
  ];
  for (const candidate of rejected) assert.equal(sequenceEditEnvelopeSchema.safeParse(candidate).success, false,
    JSON.stringify(candidate).slice(0, 160));
});

test('impact counts cover nodes, edges, main-track and other-track items and cues', () => {
  const impact = {nodeIds: [nodeA, nodeB], edgeIds: [uuid('40')], mainTrackClipIds: [clipA],
    otherTrackItemIds: [uuid('60')], subtitleCueIds: [uuid('70')]};
  assert.equal(sequenceEditImpactCount(impact), 6);
  assert.deepEqual(SEQUENCE_EDIT_TARGET_KINDS, ['shot', 'node', 'edge', 'clip', 'cue']);
});

test('the idempotency input is canonical across key order and stable for the same action', () => {
  const first = envelope();
  const reordered = {
    allocation: {...first.allocation}, impact: {...first.impact}, baseline: {...first.baseline, targets: [...first.baseline.targets]},
    intents: first.intents.map(item => ({operation: item.operation, side: item.side})),
    filmId: first.filmId, originSide: first.originSide, requestId: first.requestId, actionId: first.actionId,
    epoch: first.epoch, projectId: first.projectId, contractVersion: first.contractVersion,
  } as unknown as SequenceEditEnvelope;
  const canonical = canonicalSequenceEditInput(first);
  assert.equal(canonicalSequenceEditInput(reordered), canonical);
  assert.ok(canonical.startsWith(`${SEQUENCE_EDIT_DIGEST_DOMAIN}\n`));
  assert.equal(canonicalSequenceEditInput({...first, allocation: {edges: first.allocation.edges, splitClips: [],
    nodes: [], clips: []}}), canonical, 'key order inside nested objects does not change the canonical form');

  const changed = canonicalSequenceEditInput({...first, baseline: {...first.baseline, syncRevision: 3}});
  assert.notEqual(changed, canonical);
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  assert.match(digest(canonical), /^[a-f0-9]{64}$/u);
  assert.equal(digest(canonical), digest(canonicalSequenceEditInput(envelope())));
  assert.notEqual(digest(changed), digest(canonical));
});

test('undo and redo invert exactly one action identity', () => {
  const patch: SequenceEditPatch = {
    version: SEQUENCE_EDIT_CONTRACT_VERSION,
    before: emptyDelta,
    after: {...emptyDelta, timeline: {...timelineDelta, removedClipIds: [clipA]}},
  };
  assert.deepEqual(invertSequenceEditPatch(invertSequenceEditPatch(patch)), patch);
  assert.deepEqual(invertSequenceEditPatch(patch), {...patch, before: patch.after, after: patch.before});
  const entry: SequenceEditHistoryEntry = {actionId, projectId, epoch, position: 1, operation: 'board.connect',
    origin: 'user', beforePatch: patch.before, afterPatch: patch.after, createdAt: '2026-01-01T00:00:00.000Z'};
  assert.equal(sequenceEditHistoryEntrySchema.safeParse(entry).success, true);
  assert.equal(sequenceEditHistoryEntrySchema.safeParse({...entry, origin: 'agent'}).success, false);
  assert.equal(sequenceEditHistoryEntrySchema.safeParse({...entry, operation: '板'.repeat(67)}).success, false,
    'operation names stay within the frozen 200-byte column');
});

test('receipts keep the applied/not-applied and error-code invariants', () => {
  const history = {epoch, position: 1, revision: 2, undo: {actionId, operation: 'board.connect', affected: 1}, redo: null};
  const applied: SequenceEditReceipt = {version: SEQUENCE_EDIT_CONTRACT_VERSION, requestId: 'request-0001',
    inputDigest: 'a'.repeat(64), projectId, actionId, operation: 'board.connect', originSide: 'board', status: 'applied',
    affected: {nodes: 1, edges: 1, mainTrackClips: 0, otherTrackItems: 0, subtitleCues: 0}, history,
    contentRevision: 8, timelineRevision: 3, syncRevision: 2};
  assert.equal(sequenceEditReceiptSchema.safeParse(applied).success, true);
  assert.equal(sequenceEditReceiptSchema.safeParse({...applied, code: 'CYCLE'}).success, false);
  const notApplied = {...applied, status: 'not_applied' as const, code: 'SEQUENCE_EDIT_REVISION_CONFLICT' as const};
  assert.equal(sequenceEditReceiptSchema.safeParse(notApplied).success, true);
  assert.equal(sequenceEditReceiptSchema.safeParse({...notApplied, code: undefined}).success, false);
  assert.equal(isSequenceEditErrorCode('SEQUENCE_EDIT_REVISION_CONFLICT'), true);
  assert.equal(isSequenceEditErrorCode('NOT_A_REAL_CODE'), false);
});

test('the shared error table covers K5a, SA and contract codes exactly once', () => {
  const codes = SEQUENCE_EDIT_ERRORS.map(entry => entry.code);
  assert.equal(new Set(codes).size, codes.length, 'no duplicate codes');
  assert.deepEqual(new Set(codes), new Set(SEQUENCE_EDIT_ERROR_CODES));
  for (const code of FORMAT5_STORAGE_ERROR_CODES) assert.equal(codes.includes(code), true, `missing ${code}`);
  for (const code of ['INVALID_SEQUENCE_TYPES', 'CYCLE', 'MULTIPLE_PREDECESSORS', 'MISSING_NODE'] as const) {
    assert.equal(codes.includes(code), true, `missing board code ${code}`);
  }
  for (const code of ['DUPLICATE_CLIP', 'TRACK_OVERLAP', 'SOURCE_BOUNDS', 'NEW_CLIP_ID_REQUIRED'] as const) {
    assert.equal(codes.includes(code), true, `missing main-track code ${code}`);
  }
  for (const code of ['CHAIN_TRACK_MISMATCH', 'COPY_NODE_REQUIRED', 'FILM_SCOPE_MISMATCH'] as const) {
    assert.equal(codes.includes(code), true, `missing sync code ${code}`);
  }
  for (const code of SEQUENCE_EDIT_NEW_ERROR_CODES) assert.equal(codes.includes(code), true, `missing new ${code}`);
  const format5 = new Set<string>(FORMAT5_STORAGE_ERROR_CODES);
  for (const entry of SEQUENCE_EDIT_ERRORS) {
    if (format5.has(entry.code)) assert.equal(entry.source, 'format5', entry.code);
    else if (SEQUENCE_EDIT_NEW_ERROR_CODES.includes(entry.code as never)) assert.equal(entry.source, 'sequence-edit', entry.code);
    else assert.equal(entry.source, 'sa', entry.code);
  }
  const retryable = SEQUENCE_EDIT_ERRORS.filter(entry => entry.retryable).map(entry => entry.code).sort();
  assert.deepEqual(retryable, ['CHAIN_TRACK_MISMATCH', 'FORMAT5_SYNC_REVISION_CONFLICT', 'SEQUENCE_EDIT_REVISION_CONFLICT']);
  assert.equal(Object.isFrozen(SEQUENCE_EDIT_ERRORS), true);
});

test('the synchronization baseline is a three-state delta that skips unchanged writes', () => {
  assert.deepEqual(SEQUENCE_EDIT_BASELINE_CHANGE_KINDS, ['unchanged', 'set', 'absent']);
  const value: Format5SyncBaseline = {version: 1,
    board: [{nodeId: shotA, kind: 'shot', selectedVersionId: uuid('80')}],
    track: [{nodeId: shotA, segmentGroupId: uuid('81'), clipId: clipA, kind: 'shot', versionMode: 'follow',
      appliedVersionId: uuid('80')}]};
  assert.equal(format5SyncBaselineSchema.safeParse(value).success, true, 'fixture baseline is a frozen K5a baseline');

  // Encoding: the three states are distinct and serializable.
  const states: SequenceEditBaselineChange[] = [{kind: 'unchanged'}, {kind: 'set', value}, {kind: 'absent'}];
  assert.deepEqual(states.map(state => JSON.parse(JSON.stringify(state)).kind), ['unchanged', 'set', 'absent']);

  // Resolution: unchanged returns the current row without a write (same reference),
  // absent clears it and set stores the snapshot.
  assert.equal(applySequenceEditBaselineChange(value, {kind: 'unchanged'}), value);
  assert.equal(applySequenceEditBaselineChange(null, {kind: 'unchanged'}), null);
  assert.equal(applySequenceEditBaselineChange(value, {kind: 'absent'}), null);
  assert.equal(applySequenceEditBaselineChange(null, {kind: 'absent'}), null);
  assert.equal(applySequenceEditBaselineChange(null, {kind: 'set', value}), value);

  const deltaWith = (baseline: unknown): SequenceEditStateDelta => ({board: {writes: [], removals: []},
    timeline: {...timelineDelta, baseline: baseline as SequenceEditBaselineChange}});
  const entryWith = (before: unknown, after: unknown): unknown => ({actionId, projectId, epoch, position: 1,
    operation: 'board.connect', origin: 'user', beforePatch: deltaWith(before), afterPatch: deltaWith(after),
    createdAt: '2026-01-01T00:00:00.000Z'});
  for (const state of states) assert.equal(sequenceEditHistoryEntrySchema.safeParse(entryWith(state, state)).success, true);
  const rejected = [
    {kind: 'set'}, {kind: 'set', value: null}, {kind: 'set', value: {version: 2, board: [], track: []}},
    {kind: 'unknown'}, {kind: 'unchanged', value}, null,
  ];
  for (const state of rejected) assert.equal(sequenceEditHistoryEntrySchema.safeParse(entryWith(state, state)).success, false,
    JSON.stringify(state));

  // Inversion: set and absent swap on undo; unchanged keeps the stored baseline.
  const write: SequenceEditPatch = {version: SEQUENCE_EDIT_CONTRACT_VERSION,
    before: deltaWith({kind: 'absent'}), after: deltaWith({kind: 'set', value})};
  const inverted = invertSequenceEditPatch(write);
  assert.deepEqual(inverted.before.timeline.baseline, {kind: 'set', value});
  assert.deepEqual(inverted.after.timeline.baseline, {kind: 'absent'});
  assert.deepEqual(invertSequenceEditPatch(inverted), write);
  const unchangedPatch: SequenceEditPatch = {version: SEQUENCE_EDIT_CONTRACT_VERSION,
    before: deltaWith({kind: 'unchanged'}), after: deltaWith({kind: 'unchanged'})};
  assert.deepEqual(invertSequenceEditPatch(unchangedPatch), unchangedPatch);
  assert.equal(applySequenceEditBaselineChange(value, unchangedPatch.after.timeline.baseline), value,
    'undo/redo of an unchanged baseline never rewrites the stored row');
});

test('both transaction entries are typed for CS → TS and TS → CS use inside one transaction', () => {
  const request = {envelope: envelope(), state: {} as ChainSyncState, plan: {} as SequenceEditPlan} as SequenceEditTransactionRequest;
  const board: BoardSeamProjectionPort = {
    projectBoardSeam: (input: SequenceEditTransactionRequest) => {
      assert.equal(input.envelope.actionId, actionId);
      return {ok: true, delta: emptyDelta.board, contentRevision: 8};
    },
  };
  const timeline: MainTrackProjectionPort = {
    projectMainTrack: (input: SequenceEditTransactionRequest) => {
      assert.equal(input.envelope.actionId, actionId);
      return {ok: true, delta: emptyDelta.timeline, warnings: [], timelineRevision: 4, syncRevision: 3};
    },
  };
  const failure: SequenceEditPlan = {} as ChainSyncPlan as SequenceEditPlan;
  assert.equal(failure !== undefined, true);
  assert.deepEqual(board.projectBoardSeam(request), {ok: true, delta: boardDelta, contentRevision: 8});
  assert.equal(timeline.projectMainTrack(request).ok, true);

  const service: SequenceEditService = {
    apply: () => ({ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID', ids: []}),
    undo: () => ({ok: false, code: 'SEQUENCE_EDIT_HISTORY_CONFLICT', ids: [actionId]}),
    redo: () => ({ok: false, code: 'SEQUENCE_EDIT_HISTORY_CONFLICT', ids: [actionId]}),
  };
  assert.equal(service.apply({envelope: envelope()}).ok, false);
  const failureResult = board.projectBoardSeam(request);
  assert.equal('delta' in failureResult, true);
});
