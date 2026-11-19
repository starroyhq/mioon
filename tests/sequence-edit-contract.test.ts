import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {FORMAT5_LIMITS, FORMAT5_STORAGE_ERROR_CODES, format5SyncBaselineSchema} from '../packages/contracts/src/project-format5.ts';
import type {Format5SyncBaseline} from '../packages/contracts/src/project-format5.ts';
import type {ChainSyncOperation, ChainSyncState, ChainSyncPlan} from '../packages/contracts/src/chain-sync-algorithm.ts';
import {
  SEQUENCE_EDIT_CONTRACT_VERSION, SEQUENCE_EDIT_DIGEST_DOMAIN, SEQUENCE_EDIT_ERRORS, SEQUENCE_EDIT_ERROR_CODES,
  SEQUENCE_EDIT_BOARD_ENTITY_KINDS,
  SEQUENCE_EDIT_BASELINE_CHANGE_KINDS, SEQUENCE_EDIT_LIMITS, SEQUENCE_EDIT_NEW_ERROR_CODES,
  SEQUENCE_EDIT_OPERATIONS, SEQUENCE_EDIT_TARGET_KINDS, applySequenceEditBaselineChange,
  canonicalSequenceEditInput, invertSequenceEditPatch, isSequenceEditEnvelope, isSequenceEditErrorCode,
  isSequenceEditInputDigest, isSequenceEditIntentSequence, isSequenceEditRequestId, isSequenceEditUuid,
  sequenceEditEnvelopeOperationName, sequenceEditEnvelopeSchema, sequenceEditHistoryEntrySchema,
  sequenceEditImpactCount, sequenceEditIntentOperationName, sequenceEditIntentSide, sequenceEditOperationName,
  sequenceEditPrevisIntentSchema, sequenceEditPrevisOperationName,
  sequenceEditReceiptSchema, sequenceEditSubjectIntentSchema, sequenceEditSubjectOperationName, sequenceEditUtf8Bytes,
} from '../packages/contracts/src/sequence-edit.ts';
import type {
  BoardSeamProjectionPort, MainTrackProjectionPort, SequenceEditBaselineChange, SequenceEditEnvelope,
  SequenceEditHistoryEntry, SequenceEditIntent, SequenceEditPatch, SequenceEditPlan, SequenceEditReceipt,
  SequenceEditService, SequenceEditStateDelta, SequenceEditSubjectIntent, SequenceEditTransactionRequest,
  SequenceEditPrevisIntent, PrevisIntentOperation, SubjectBindingOperation,
} from '../packages/contracts/src/sequence-edit.ts';
import {defaultPrevisScene} from '../packages/contracts/src/previs.ts';

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
const bindingA = uuid('90'), shotSubjectA = uuid('12');
const createBinding: SubjectBindingOperation = {kind: 'subject-binding', edit: {kind: 'create',
  bindingId: bindingA, shotId: shotA, subjectId: shotSubjectA, role: 'subject'}};
const lockBinding: SubjectBindingOperation = {kind: 'subject-binding', edit: {kind: 'set-mode',
  bindingId: bindingA, bindingMode: 'locked', subjectVersionId: uuid('91')}};
const detachBinding: SubjectBindingOperation = {kind: 'subject-binding', edit: {kind: 'detach', bindingId: bindingA}};
const restoreBinding: SubjectBindingOperation = {kind: 'subject-binding', edit: {kind: 'restore',
  bindingId: bindingA, bindingMode: 'follow', subjectVersionId: null}};
const subjectIntent = (operation: SubjectBindingOperation): SequenceEditSubjectIntent => ({side: 'board', operation});
function subjectEnvelope(overrides: Partial<SequenceEditEnvelope> = {}): SequenceEditEnvelope {
  return envelope({intents: [], subjectIntent: subjectIntent(createBinding),
    impact: {...envelope().impact, subjectBindingIds: [bindingA]},
    baseline: {...envelope().baseline, targets: [{kind: 'subject_binding', id: bindingA, revision: 1}]},
    allocation: {clips: [], nodes: [], splitClips: [],
      edges: [{id: uuid('92'), fromId: uuid('13'), toId: shotA}]},
    ...overrides});
}

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
const cardNode = uuid('13'), bindingEdgeId = uuid('92');
const previsNode = uuid('55');
const previsIntentOf = (operation: PrevisIntentOperation): SequenceEditPrevisIntent => ({side: 'board', operation});
const createPrevis: PrevisIntentOperation = {kind: 'previs-create', nodeId: previsNode, label: 'Scene',
  position: {x: 20, y: 30}};
const savePrevis: PrevisIntentOperation = {kind: 'previs-scene-set', nodeId: previsNode,
  expectedSceneRevision: 1, scene: defaultPrevisScene()};
function previsEnvelope(overrides: Partial<SequenceEditEnvelope> = {}): SequenceEditEnvelope {
  return envelope({intents: [], previsIntent: previsIntentOf(createPrevis),
    impact: {nodeIds: [previsNode], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []},
    baseline: {...envelope().baseline, targets: []}, ...overrides});
}
function bindingEnvelope(overrides: Partial<SequenceEditEnvelope> = {}): SequenceEditEnvelope {
  return subjectEnvelope({allocation: {clips: [], nodes: [], splitClips: [],
    edges: [{id: bindingEdgeId, fromId: cardNode, toId: shotA}]}, ...overrides});
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
  assert.equal(sequenceEditIntentSide({kind: 'board.root.create'}), 'board');
  assert.equal(sequenceEditIntentSide({kind: 'board.shot.append'}), 'board');
  assert.equal(sequenceEditIntentSide({kind: 'board.layout.move'}), 'board');
  const samples: Array<[ChainSyncOperation | import('../packages/contracts/src/sequence-edit.ts').BoardIntentOperation, string]> = [
    [{kind: 'board', edit: {kind: 'connect', fromId: shotA, toId: shotB}}, 'board.connect'],
    [{kind: 'board', edit: {kind: 'disconnect', fromId: shotA, toId: shotB}}, 'board.disconnect'],
    [{kind: 'board', edit: {kind: 'insert', fromId: shotA, toId: shotB, nodeId: nodeA}}, 'board.insert'],
    [{kind: 'board', edit: {kind: 'delete', nodeId: nodeA}}, 'board.delete'],
    [{kind: 'sync-board'}, 'board.sync'],
    [{kind: 'board-version', nodeId: nodeA, version: null}, 'board.version'],
    [{kind: 'board.root.create', nodeId: nodeA, name: 'Film', position: {x: 0, y: 0}}, 'board.root.create'],
    [{kind: 'board.shot.append', nodeId: nodeA, name: 'Shot'}, 'board.shot.append'],
    [{kind: 'board.layout.move', moves: [{nodeId: nodeA, x: 10, y: 20}]}, 'board.layout.move'],
    [{kind: 'track', edit: {kind: 'move', clipId: clipA, beforeClipId: null}}, 'timeline.clip.move'],
    [{kind: 'track', edit: {kind: 'move-off-track', clipId: clipA, trackId: uuid('50'), startFrame: 0}}, 'timeline.clip.move-off-track'],
    [{kind: 'track', edit: {kind: 'remove', clipId: clipA}}, 'timeline.clip.remove'],
    [{kind: 'track', edit: {kind: 'add', clip: {id: clipA, nodeId: nodeA, versionId: null, versionLocked: false,
      startFrame: 0, durationFrames: 30, sourceInFrame: 0}, beforeClipId: null}}, 'timeline.clip.add'],
    [{kind: 'track', edit: {kind: 'split', clipId: clipA, offsetFrames: 10, rightClipId: uuid('51')}}, 'timeline.clip.split'],
    [{kind: 'track', edit: {kind: 'trim', clipId: clipA, durationFrames: 20}}, 'timeline.clip.trim'],
    [{kind: 'track', edit: {kind: 'version', clipId: clipA, version: null, locked: false}}, 'timeline.clip.version'],
  ];
  const subjectSamples: Array<[SubjectBindingOperation, string]> = [
    [createBinding, 'subject.binding.create'],
    [lockBinding, 'subject.binding.set-mode'],
    [detachBinding, 'subject.binding.detach'],
    [restoreBinding, 'subject.binding.restore'],
  ];
  const previsSamples: Array<[PrevisIntentOperation, string]> = [
    [createPrevis, 'previs.create'], [savePrevis, 'previs.scene.set'],
  ];
  assert.equal(subjectSamples.length, 4);
  assert.equal(samples.length + subjectSamples.length + previsSamples.length, SEQUENCE_EDIT_OPERATIONS.length);
  for (const [operation, name] of subjectSamples) {
    assert.equal(sequenceEditSubjectOperationName(operation), name);
    assert.equal(sequenceEditIntentSide(operation), 'board');
    assert.equal((SEQUENCE_EDIT_OPERATIONS as readonly string[]).includes(name), true);
    assert.ok(sequenceEditUtf8Bytes(name) <= SEQUENCE_EDIT_LIMITS.operationBytes);
  }
  for (const [operation, name] of previsSamples) {
    assert.equal(sequenceEditPrevisOperationName(operation), name);
    assert.equal((SEQUENCE_EDIT_OPERATIONS as readonly string[]).includes(name), true);
    assert.ok(sequenceEditUtf8Bytes(name) <= SEQUENCE_EDIT_LIMITS.operationBytes);
  }
  assert.equal(sequenceEditEnvelopeOperationName(subjectEnvelope()), 'subject.binding.create');
  assert.equal(sequenceEditEnvelopeOperationName(envelope()), 'board.connect');
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

test('impact counts cover nodes, edges, main-track and other-track items, cues and bindings', () => {
  const impact = {nodeIds: [nodeA, nodeB], edgeIds: [uuid('40')], mainTrackClipIds: [clipA],
    otherTrackItemIds: [uuid('60')], subtitleCueIds: [uuid('70')], subjectBindingIds: [bindingA]};
  assert.equal(sequenceEditImpactCount(impact), 7);
  assert.deepEqual(SEQUENCE_EDIT_TARGET_KINDS, ['shot', 'node', 'edge', 'clip', 'cue', 'subject_binding']);
});

test('subject binding intents validate the mode/version pair and stay board-only', () => {
  assert.equal(isSequenceEditEnvelope(subjectEnvelope()), true);
  assert.equal(sequenceEditSubjectIntentSchema.safeParse(subjectIntent(createBinding)).success, true);
  for (const operation of [lockBinding, detachBinding, restoreBinding]) {
    assert.equal(sequenceEditSubjectIntentSchema.safeParse(subjectIntent(operation)).success, true);
    assert.equal(isSequenceEditEnvelope(subjectEnvelope({subjectIntent: subjectIntent(operation)})), true);
  }
  // A subject action is exactly one subject intent: no CS/TS intents, board origin.
  const bad: unknown[] = [
    subjectEnvelope({intents: [intent(connect)]}),
    subjectEnvelope({originSide: 'timeline'}),
    subjectEnvelope({subjectIntent: {side: 'timeline', operation: createBinding} as unknown as SequenceEditSubjectIntent}),
  ];
  for (const candidate of bad) assert.equal(sequenceEditEnvelopeSchema.safeParse(candidate).success, false,
    JSON.stringify(candidate).slice(0, 160));
  const invalidEdits = [
    {kind: 'set-mode', bindingId: bindingA, bindingMode: 'locked', subjectVersionId: null},
    {kind: 'set-mode', bindingId: bindingA, bindingMode: 'follow', subjectVersionId: uuid('91')},
    {kind: 'restore', bindingId: bindingA, bindingMode: 'locked', subjectVersionId: null},
    {kind: 'detach', bindingId: bindingA, subjectVersionId: null},
    {kind: 'create', bindingId: bindingA, shotId: shotA},
  ];
  for (const edit of invalidEdits) {
    assert.equal(sequenceEditSubjectIntentSchema.safeParse({side: 'board',
      operation: {kind: 'subject-binding', edit}}).success, false, JSON.stringify(edit));
  }
  assert.equal(sequenceEditEnvelopeSchema.safeParse({...subjectEnvelope(),
    impact: {...envelope().impact, subjectBindingIds: [bindingA, bindingA]}}).success, false);
  assert.equal(isSequenceEditEnvelope({...subjectEnvelope(), intents: [], subjectIntent: undefined}), false,
    'an empty intents array without a subject intent is still invalid');
  // A subject binding row is a tombstone: removals may never carry it, and a
  // create needs its pre-allocated reference edge or it is rejected.
  const tombstonePatch = {version: SEQUENCE_EDIT_CONTRACT_VERSION,
    before: {board: {writes: [], removals: [{kind: 'subject_binding', id: bindingA, data: {}}]}, timeline: timelineDelta},
    after: emptyDelta};
  assert.equal(sequenceEditHistoryEntrySchema.safeParse({actionId, projectId, epoch, position: 1,
    operation: 'subject.binding.create', origin: 'user', beforePatch: tombstonePatch.before,
    afterPatch: tombstonePatch.after, createdAt: '2026-01-01T00:00:00.000Z'}).success, false);
  assert.equal(isSequenceEditEnvelope(subjectEnvelope({allocation: {clips: [], nodes: [], splitClips: [], edges: []}})), false,
    'create requires the reference edge allocation');
  assert.equal(isSequenceEditEnvelope(subjectEnvelope({allocation: {clips: [], nodes: [], splitClips: [],
    edges: [{id: uuid('93'), fromId: uuid('13'), toId: shotB}]}})), false,
    'the allocated edge must target the created binding shot');
});

test('previs intents are one board family: create and scene-save name their node in the impact', () => {
  assert.equal(isSequenceEditEnvelope(previsEnvelope()), true);
  assert.equal(sequenceEditPrevisIntentSchema.safeParse(previsIntentOf(createPrevis)).success, true);
  assert.equal(sequenceEditPrevisIntentSchema.safeParse(previsIntentOf(savePrevis)).success, true);
  assert.equal(sequenceEditEnvelopeOperationName(previsEnvelope()), 'previs.create');
  assert.equal(sequenceEditEnvelopeOperationName(previsEnvelope({previsIntent: previsIntentOf(savePrevis)})), 'previs.scene.set');
  assert.equal(sequenceEditPrevisOperationName(createPrevis), 'previs.create');
  assert.equal(sequenceEditPrevisOperationName(savePrevis), 'previs.scene.set');
  // The node is a board row: create carries exactly one new impact node and the
  // save lists the node it replaces; neither combines with another family.
  assert.equal(sequenceEditEnvelopeSchema.safeParse(previsEnvelope()).success, true);
  assert.equal(sequenceEditEnvelopeSchema.safeParse(previsEnvelope({previsIntent: previsIntentOf(savePrevis),
    baseline: {...envelope().baseline, targets: [{kind: 'node', id: previsNode, revision: 3}]}})).success, true);
  const rejected: unknown[] = [
    previsEnvelope({impact: {...previsEnvelope().impact, nodeIds: [nodeA]}}),
    previsEnvelope({baseline: {...previsEnvelope().baseline, targets: [{kind: 'node', id: previsNode, revision: 1}]}}),
    previsEnvelope({intents: [intent(connect)]}),
    previsEnvelope({subjectIntent: subjectIntent(createBinding)}),
    previsEnvelope({propertiesIntent: {side: 'timeline', operation: {kind: 'clip-properties',
      edits: [{clipId: clipA, patch: {gain: 1}}]}}}),
    envelope({intents: [], subjectIntent: subjectIntent(createBinding), previsIntent: previsIntentOf(createPrevis)}),
    previsEnvelope({previsIntent: previsIntentOf(savePrevis),
      impact: {...previsEnvelope().impact, nodeIds: [nodeA]}}),
    previsEnvelope({previsIntent: {side: 'timeline', operation: createPrevis} as never}),
    previsEnvelope({previsIntent: previsIntentOf({kind: 'previs-create', nodeId: 'not-a-uuid', label: '',
      position: {x: 0, y: 0}})}),
  ];
  for (const candidate of rejected) {
    assert.equal(sequenceEditEnvelopeSchema.safeParse(candidate).success, false, JSON.stringify(candidate).slice(0, 200));
  }
});

test('clip property intents carry one timeline action with bounded patches and clip impact', () => {
  const properties = (edits: unknown[], overrides: Partial<SequenceEditEnvelope> = {}): SequenceEditEnvelope =>
    envelope({intents: [], originSide: 'timeline',
      propertiesIntent: {side: 'timeline', operation: {kind: 'clip-properties', edits}} as never,
      impact: {...envelope().impact, mainTrackClipIds: [clipA]},
      baseline: {...envelope().baseline, targets: [{kind: 'clip', id: clipA, revision: 1}]},
      ...overrides});
  assert.equal(isSequenceEditEnvelope(properties([{clipId: clipA, patch: {gain: 0.5}}])), true);
  assert.equal(sequenceEditEnvelopeOperationName(properties([{clipId: clipA, patch: {gain: 0.5}}])),
    'timeline.clip.set-properties');
  const rejected: unknown[] = [
    // both intent families
    properties([{clipId: clipA, patch: {gain: 0.5}}], {intents: [intent(connect)]}),
    // origin side must be timeline
    properties([{clipId: clipA, patch: {gain: 0.5}}], {originSide: 'board'}),
    // edited clip must appear in the impact
    properties([{clipId: shotB, patch: {gain: 0.5}}]),
    // empty patch and duplicate clip are invalid payloads
    properties([{clipId: clipA, patch: {}}]),
    properties([{clipId: clipA, patch: {gain: 0.5}}, {clipId: clipA, patch: {gain: 0.6}}]),
  ];
  for (const candidate of rejected) assert.equal(sequenceEditEnvelopeSchema.safeParse(candidate).success, false,
    JSON.stringify(candidate).slice(0, 160));
});

test('a subject binding row is a board entity: mixed patches invert and stay in one history entry', () => {
  const bindingRow = {id: bindingA, projectId, shotId: shotA, subjectId: shotSubjectA, role: 'subject',
    revision: 1, bindingMode: 'follow', subjectVersionId: null, reviewedHeadVersionId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'};
  const createdBinding = {...bindingRow};
  const lockedBinding = {...bindingRow, revision: 2, bindingMode: 'locked', subjectVersionId: uuid('91')};
  const edgeRow = {id: uuid('40'), projectId, source: shotSubjectA, target: shotA, kind: 'reference',
    role: 'subject_reference', subjectBindingId: bindingA};
  const shotRow = {id: shotA, projectId, revision: 2, selectedVersionId: null};
  const patch: SequenceEditPatch = {
    version: SEQUENCE_EDIT_CONTRACT_VERSION,
    before: emptyDelta,
    after: {
      board: {
        writes: [
          {kind: 'shot', id: shotA, data: shotRow},
          {kind: 'edge', id: edgeRow.id, data: edgeRow},
          {kind: 'subject_binding', id: bindingA, data: createdBinding},
        ],
        removals: [],
      },
      timeline: {...timelineDelta, removedCueIds: [uuid('70')]},
    },
  };
  assert.equal(sequenceEditHistoryEntrySchema.safeParse({actionId, projectId, epoch, position: 1,
    operation: 'subject.binding.create', origin: 'user', beforePatch: patch.before, afterPatch: patch.after,
    createdAt: '2026-01-01T00:00:00.000Z'}).success, true);
  assert.deepEqual(invertSequenceEditPatch(invertSequenceEditPatch(patch)), patch);
  // The mode change keeps the same row identity and is a full-row write, so undo
  // restores follow and the applied version without consulting another service.
  const modePatch: SequenceEditPatch = {version: SEQUENCE_EDIT_CONTRACT_VERSION,
    before: {board: {writes: [{kind: 'subject_binding', id: bindingA, data: createdBinding}], removals: []},
      timeline: timelineDelta},
    after: {board: {writes: [{kind: 'subject_binding', id: bindingA, data: lockedBinding}], removals: []},
      timeline: timelineDelta}};
  const inverted = invertSequenceEditPatch(modePatch);
  assert.deepEqual(inverted.before.board.writes[0]!.data, lockedBinding);
  assert.deepEqual(inverted.after.board.writes[0]!.data, createdBinding);
  assert.deepEqual(invertSequenceEditPatch(inverted), modePatch);
  // Detach keeps the row and clears only the applied version; it is a write, not
  // a tombstone deletion.
  const detached = {...lockedBinding, revision: 3, bindingMode: 'detached', subjectVersionId: null};
  const detachPatch: SequenceEditPatch = {version: SEQUENCE_EDIT_CONTRACT_VERSION,
    before: modePatch.after, after: {board: {writes: [{kind: 'subject_binding', id: bindingA, data: detached}],
      removals: []}, timeline: timelineDelta}};
  assert.equal(sequenceEditHistoryEntrySchema.safeParse({actionId, projectId, epoch, position: 2,
    operation: 'subject.binding.detach', origin: 'user', beforePatch: detachPatch.before,
    afterPatch: detachPatch.after, createdAt: '2026-01-01T00:00:00.000Z'}).success, true);
  assert.deepEqual(invertSequenceEditPatch(detachPatch).before.board.writes[0]!.data, detached);
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
    affected: {nodes: 1, edges: 1, mainTrackClips: 0, otherTrackItems: 0, subtitleCues: 0, subjectBindings: 1}, history,
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
  for (const code of ['SEQUENCE_EDIT_SUBJECT_BINDING_INVALID', 'SEQUENCE_EDIT_SUBJECT_VERSION_HIDDEN',
    'SEQUENCE_EDIT_SUBJECT_BINDING_LIMIT'] as const) assert.equal(codes.includes(code), true, `missing sb ${code}`);
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

test('board entity kinds retain both subject-binding and TS adoption extensions', () => {
  assert.deepEqual(SEQUENCE_EDIT_BOARD_ENTITY_KINDS, ['shot', 'node', 'edge', 'subject_binding', 'adoption']);
  const anchor = SEQUENCE_EDIT_ERRORS.find(entry => entry.code === 'SEQUENCE_EDIT_ANCHOR_CONFLICT');
  assert.ok(anchor);
  assert.equal(anchor.source, 'sequence-edit');
  assert.equal(anchor.retryable, false);
  const subject = SEQUENCE_EDIT_ERRORS.find(entry => entry.code === 'SEQUENCE_EDIT_SUBJECT_BINDING_INVALID');
  assert.ok(subject);
  assert.equal(subject.source, 'sequence-edit');
});
