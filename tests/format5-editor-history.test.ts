import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSequenceEditing, readSequenceEditContext, readSequenceEditHistory} from '../packages/business/src/sequence-edit.ts';
import {
  findSequenceEditReceipt, prepareSequenceEditHistory, sequenceEditHistoryFloor, sequenceEditInputDigest,
  writeSequenceEditAction,
} from '../packages/business/src/format5-editor-history.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {SEQUENCE_EDIT_LIMITS} from '../packages/contracts/src/sequence-edit.ts';
import type {SequenceEditAllocation, SequenceEditEnvelope, SequenceEditPatch} from '../packages/contracts/src/sequence-edit.ts';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import type {ChainWorld} from './helpers/sequence-edit-double.ts';

const rootId = '10000000-0000-4000-8000-000000000001';
const shotA = '10000000-0000-4000-8000-000000000010';
const shotB = '10000000-0000-4000-8000-000000000011';
const clipA = '10000000-0000-4000-8000-000000000020';
const clipB = '10000000-0000-4000-8000-000000000021';
const versionA = '10000000-0000-4000-8000-000000000050';
const versionB = '10000000-0000-4000-8000-000000000051';
const versionC = '10000000-0000-4000-8000-000000000052';
const at = '2026-01-01T00:00:00.000Z';

function world(t: test.TestContext): ChainWorld {
  const chain = createChainWorld(t, {
    rootId,
    shots: [{id: shotA, title: 'A', versionId: versionA}, {id: shotB, title: 'B', versionId: versionB}],
    versions: [
      {versionId: versionA, assetId: '10000000-0000-4000-8000-000000000060', sha256: 'a'.repeat(64), durationSeconds: 2},
      {versionId: versionC, assetId: '10000000-0000-4000-8000-000000000062', sha256: 'c'.repeat(64), durationSeconds: 2, shotId: shotA},
      {versionId: versionB, assetId: '10000000-0000-4000-8000-000000000061', sha256: 'b'.repeat(64), durationSeconds: 2},
    ],
    clips: [{nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 60},
      {nodeId: shotB, clipId: clipB, startFrame: 60, durationFrames: 60}],
    edges: [{id: '10000000-0000-4000-8000-000000000030', fromId: rootId, toId: shotA},
      {id: '10000000-0000-4000-8000-000000000031', fromId: shotA, toId: shotB}],
  });
  return chain;
}

function emptyAllocation(): SequenceEditAllocation {
  return {clips: [], nodes: [], splitClips: [], edges: []};
}
function boardVersionEnvelope(chain: ChainWorld, versionId: string): SequenceEditEnvelope {
  const state = prepareSequenceEditHistory(chain.store).state;
  const context = readSequenceEditContext(chain.store);
  return {
    contractVersion: 1, projectId: chain.projectId, epoch: state.epoch, actionId: randomUUID(),
    requestId: `history-${randomUUID()}`, originSide: 'board', filmId: chain.rootId,
    intents: [{side: 'board', operation: {kind: 'board-version', nodeId: shotA,
      version: {id: versionId, sourceFrames: 60}}}],
    baseline: {contentRevision: readProjectContentStamp(chain.store.db).contentSequence,
      timelineRevision: context.timeline.revision, syncRevision: context.syncRevision,
      historyPosition: state.position, historyRevision: state.revision, targets: []},
    impact: {nodeIds: [shotA], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []},
    allocation: emptyAllocation(),
  };
}
function historyRows(chain: ChainWorld) {
  return chain.store.db.prepare(`SELECT position,length(CAST(beforePatch AS BLOB))+length(CAST(afterPatch AS BLOB)) AS bytes
    FROM main.editor_history_entries WHERE projectId=? ORDER BY position`).all(chain.projectId) as Array<{position: number; bytes: number}>;
}

test('205 actions evict the oldest five entries and stop cleanly at the earliest undo', t => {
  const chain = world(t), editing = createSequenceEditing(chain.store);
  const first = boardVersionEnvelope(chain, versionC);
  const firstReceipt = editing.call('sequence.edit', first) as {status?: string};
  assert.equal(firstReceipt.status, 'applied');
  for (let iteration = 1; iteration < 205; iteration++) {
    const envelope = boardVersionEnvelope(chain, iteration % 2 === 0 ? versionC : versionA);
    const receipt = editing.call('sequence.edit', envelope) as {status?: string};
    assert.equal(receipt.status, 'applied', `action ${iteration} must apply`);
  }
  const rows = historyRows(chain);
  assert.equal(rows.length, SEQUENCE_EDIT_LIMITS.historyEntries);
  assert.deepEqual(rows.map(row => row.position), Array.from({length: 200}, (_, index) => index + 6));
  // Only evicted history rows are gone; the immutable receipt for action 1 is
  // still queryable by its original request id.
  const receipt = findSequenceEditReceipt(chain.store, first.requestId);
  assert.equal(receipt?.receipt.actionId, first.actionId);
  assert.equal(receipt?.receipt.status, 'applied');
  // The byte total stays inside the frozen budget.
  assert.ok(rows.reduce((sum, row) => sum + Number(row.bytes), 0) <= SEQUENCE_EDIT_LIMITS.historyBytes);

  const view = editing.call('sequence.history.get', {projectId: chain.projectId}) as Record<string, unknown>;
  assert.equal(view.position, 205);
  assert.equal(view.earliestPosition, 6);
  assert.equal(view.atEarliest, false);
  assert.equal(view.undoAvailable, true);

  // Undo all 199 retained actions down to the earliest retained position.
  for (let position = 205; position > 6; position--) {
    const current = editing.call('sequence.history.get', {projectId: chain.projectId}) as {
      position: number; revision: number; undo: {actionId: string} | null; earliestPosition: number | null;
    };
    assert.equal(current.earliestPosition, 6);
    assert.equal(current.position, position);
    assert.ok(current.undo);
    editing.call('sequence.undo', {projectId: chain.projectId, requestId: `undo-${randomUUID()}`,
      actionId: current.undo.actionId, expected: {position: current.position, revision: current.revision}});
  }
  const atFloor = editing.call('sequence.history.get', {projectId: chain.projectId}) as Record<string, unknown>;
  assert.equal(atFloor.position, 6);
  assert.equal(atFloor.earliestPosition, 6);
  assert.equal(atFloor.atEarliest, false, 'the earliest retained action can still be undone');
  // Undo the earliest retained action, then the stack reports a clear
  // "already at earliest" state and refuses another undo.
  const earliest = editing.call('sequence.history.get', {projectId: chain.projectId}) as {
    position: number; revision: number; undo: {actionId: string} | null;
  };
  assert.ok(earliest.undo);
  editing.call('sequence.undo', {projectId: chain.projectId, requestId: `undo-${randomUUID()}`,
    actionId: earliest.undo.actionId, expected: {position: earliest.position, revision: earliest.revision}});
  const exhausted = editing.call('sequence.history.get', {projectId: chain.projectId}) as Record<string, unknown>;
  assert.equal(exhausted.position, 5);
  assert.equal(exhausted.atEarliest, true);
  assert.equal(exhausted.undoAvailable, false);
  assert.equal(exhausted.redoAvailable, true);
  assert.equal(sequenceEditHistoryFloor(chain.store), 6);
  assert.throws(() => editing.call('sequence.undo', {projectId: chain.projectId,
    requestId: `undo-${randomUUID()}`, actionId: '10000000-0000-4000-8000-0000000000aa',
    expected: {position: 5, revision: exhausted.revision as number}}), (error: {code?: string; details?: {reason?: string}}) =>
    error.code === 'SEQUENCE_EDIT_HISTORY_CONFLICT' && error.details?.reason === 'EARLIEST');
  // Redo still restores the last action after the exhaustion state.
  const redoView = editing.call('sequence.history.get', {projectId: chain.projectId}) as {
    position: number; revision: number; redo: {actionId: string} | null;
  };
  assert.ok(redoView.redo);
  editing.call('sequence.redo', {projectId: chain.projectId, requestId: `redo-${randomUUID()}`,
    actionId: redoView.redo.actionId, expected: {position: redoView.position, revision: redoView.revision}});
  assert.equal((editing.call('sequence.history.get', {projectId: chain.projectId}) as {position: number}).position, 6);

  // A new action after an undo truncates the redo branch. The cursor is below
  // the retained window at this point, so recording at the earliest slot wipes
  // the old branch and the retained window restarts from the new action.
  const beforeBranch = editing.call('sequence.history.get', {projectId: chain.projectId}) as {
    position: number; revision: number; undo: {actionId: string} | null;
  };
  assert.ok(beforeBranch.undo);
  editing.call('sequence.undo', {projectId: chain.projectId, requestId: `undo-${randomUUID()}`,
    actionId: beforeBranch.undo.actionId, expected: {position: beforeBranch.position, revision: beforeBranch.revision}});
  const selected = readSequenceEditContext(chain.store).media.find(item => item.nodeId === shotA)?.selectedVersion?.id ?? versionA;
  const fresh = boardVersionEnvelope(chain, selected === versionA ? versionC : versionA);
  editing.call('sequence.edit', fresh);
  const afterBranch = editing.call('sequence.history.get', {projectId: chain.projectId}) as Record<string, unknown>;
  assert.equal(afterBranch.position, 6);
  assert.equal(afterBranch.redo, null);
  assert.equal(afterBranch.earliestPosition, 6);
  assert.equal(historyRows(chain).length, 1);
});

test('a near-budget history evicts the oldest rows before writing a large action', t => {
  const chain = world(t), editing = createSequenceEditing(chain.store);
  const firstEnvelope = boardVersionEnvelope(chain, versionC);
  editing.call('sequence.edit', firstEnvelope);
  const state = prepareSequenceEditHistory(chain.store).state;
  const paddedPatch = (padLength: number): {before: string; after: string} => {
    const record = (pad: string) => ({
      board: {writes: [{kind: 'shot', id: shotA, data: {id: shotA, projectId: chain.projectId, pad}}], removals: []},
      timeline: {clips: [], cues: [], removedClipIds: [], removedCueIds: [], baseline: {kind: 'unchanged'}},
    });
    return {before: JSON.stringify(record('x'.repeat(padLength))), after: JSON.stringify(record('y'.repeat(padLength)))};
  };
  // Seed 32 entries close to the 128 MiB byte budget through the real trigger
  // path (each entry must stay below the 4 MiB per-entry limit).
  chain.store.tx(() => {
    const add = (position: number, before: string, after: string): void => {
      chain.store.db.prepare(`INSERT INTO main.editor_history_entries(actionId,projectId,epoch,position,operation,origin,beforePatch,afterPatch,createdAt)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), chain.projectId, state.epoch, position, 'board.disconnect', 'user', before, after, at);
    };
    const patch = paddedPatch(2_080_000);
    for (let position = 2; position <= 33; position++) add(position, patch.before, patch.after);
    chain.store.db.prepare('UPDATE main.editor_history_state SET position=33,revision=? WHERE projectId=?')
      .run(34, chain.projectId);
  });
  const seeded = historyRows(chain);
  assert.equal(seeded.length, 33);
  assert.ok(seeded.reduce((sum, row) => sum + Number(row.bytes), 0) <= SEQUENCE_EDIT_LIMITS.historyBytes);
  assert.equal(findSequenceEditReceipt(chain.store, firstEnvelope.requestId)?.receipt.actionId, firstEnvelope.actionId);

  const seededState = prepareSequenceEditHistory(chain.store).state;
  const context = readSequenceEditContext(chain.store);
  const envelope: SequenceEditEnvelope = {
    contractVersion: 1, projectId: chain.projectId, epoch: seededState.epoch, actionId: randomUUID(),
    requestId: `large-${randomUUID()}`, originSide: 'board', filmId: chain.rootId,
    intents: [{side: 'board', operation: {kind: 'board', edit: {kind: 'disconnect', fromId: rootId, toId: shotA}}}],
    baseline: {contentRevision: readProjectContentStamp(chain.store.db).contentSequence,
      timelineRevision: context.timeline.revision, syncRevision: context.syncRevision,
      historyPosition: seededState.position, historyRevision: seededState.revision, targets: []},
    impact: {nodeIds: [shotA], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []},
    allocation: emptyAllocation(),
  };
  const large = paddedPatch(1_500_000);
  const patch: SequenceEditPatch = {
    version: 1,
    before: JSON.parse(large.before) as SequenceEditPatch['before'],
    after: JSON.parse(large.after) as SequenceEditPatch['after'],
  };
  const receipt = writeSequenceEditAction(chain.store, {envelope, patch, receipt: {
    version: 1, requestId: envelope.requestId, inputDigest: sequenceEditInputDigest(envelope),
    projectId: chain.projectId, actionId: envelope.actionId, operation: 'board.disconnect', originSide: 'board',
    status: 'applied', affected: {nodes: 0, edges: 0, mainTrackClips: 0, otherTrackItems: 0, subtitleCues: 0},
    contentRevision: envelope.baseline.contentRevision, timelineRevision: context.timeline.revision,
    syncRevision: context.syncRevision,
  }});
  assert.equal(receipt.history.position, 34);
  const after = historyRows(chain);
  assert.ok(after.reduce((sum, row) => sum + Number(row.bytes), 0) <= SEQUENCE_EDIT_LIMITS.historyBytes);
  assert.equal(after.length, 32, 'one seeded entry and the first action were evicted to fit the large patch');
  assert.equal(sequenceEditHistoryFloor(chain.store), 3);
  assert.ok(after.some(row => row.position === 34));
  // Eviction never removes receipts: the first action (and its history row that
  // was just evicted) still resolves by its original request id.
  const replayed = findSequenceEditReceipt(chain.store, firstEnvelope.requestId);
  assert.equal(replayed?.receipt.actionId, firstEnvelope.actionId);
  assert.equal(readSequenceEditHistory(chain.store).earliestPosition, 3);
});

test('a single patch over the frozen 4 MiB entry budget is still rejected', t => {
  const chain = world(t), editing = createSequenceEditing(chain.store);
  editing.call('sequence.edit', boardVersionEnvelope(chain, versionC));
  const state = prepareSequenceEditHistory(chain.store).state;
  const context = readSequenceEditContext(chain.store);
  const envelope: SequenceEditEnvelope = {
    contractVersion: 1, projectId: chain.projectId, epoch: state.epoch, actionId: randomUUID(),
    requestId: `oversize-${randomUUID()}`, originSide: 'board', filmId: chain.rootId,
    intents: [{side: 'board', operation: {kind: 'board', edit: {kind: 'disconnect', fromId: rootId, toId: shotA}}}],
    baseline: {contentRevision: readProjectContentStamp(chain.store.db).contentSequence,
      timelineRevision: context.timeline.revision, syncRevision: context.syncRevision,
      historyPosition: state.position, historyRevision: state.revision, targets: []},
    impact: {nodeIds: [], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []},
    allocation: emptyAllocation(),
  };
  const record = {board: {writes: [{kind: 'shot', id: shotA, data: {id: shotA, pad: 'x'.repeat(2_200_000)}}],
    removals: []}, timeline: {clips: [], cues: [], removedClipIds: [], removedCueIds: [], baseline: {kind: 'unchanged'}}};
  const patch: SequenceEditPatch = {version: 1, before: JSON.parse(JSON.stringify(record)), after: JSON.parse(JSON.stringify(record))};
  assert.throws(() => writeSequenceEditAction(chain.store, {envelope, patch, receipt: {
    version: 1, requestId: envelope.requestId, inputDigest: sequenceEditInputDigest(envelope),
    projectId: chain.projectId, actionId: envelope.actionId, operation: 'board.disconnect', originSide: 'board',
    status: 'applied', affected: {nodes: 0, edges: 0, mainTrackClips: 0, otherTrackItems: 0, subtitleCues: 0},
    contentRevision: envelope.baseline.contentRevision, timelineRevision: context.timeline.revision,
    syncRevision: context.syncRevision,
  }}), (error: {code?: string}) => error.code === 'SEQUENCE_EDIT_PATCH_INVALID');
  assert.equal(prepareSequenceEditHistory(chain.store).state.position, 1);
});

