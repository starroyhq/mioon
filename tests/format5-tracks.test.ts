import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {upgradeProjectFormatTo5} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from './helpers/format4-release-fixture.ts';
import {findSequenceEditReceipt, prepareSequenceEditHistory} from '../packages/business/src/format5-editor-history.ts';
import {buildTrackEnvelope, planTrack, runTrackSync} from '../packages/business/src/format5-tracks.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {moveSequenceSyncHistory} from '../packages/business/src/format5-sequence-sync.ts';

let scratch: string;
before(() => {scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'format5-frd-'));});
after(() => {rmSync(scratch, {recursive: true, force: true});});
let serial = 0;
function fixture(): {store: ProjectStore} {
  const base = path.join(scratch, `prepare-${serial++}`);
  mkdirSync(base, {mode: 0o700});
  const source = prepareFormat5Release(base, 'v0.2.0');
  const root = path.join(scratch, `tracks-${serial++}`);
  cpSync(source.sample, root, {recursive: true, errorOnExist: true, force: false});
  const paths = releaseProjectPaths(root);
  for (const directory of [root, ...Object.values(paths.location)]) chmodSync(directory, 0o700);
  return {store: upgradeProjectFormatTo5({projectFile: paths.projectFile, locate: () => paths.location, approveUpgrade: () => true}).store};
}
function action(store: ProjectStore) {
  const state = prepareSequenceEditHistory(store);
  return {epoch: state.state.epoch, historyPosition: state.state.position, historyRevision: state.state.revision};
}
function envelope(store: ProjectStore, edit: Parameters<typeof buildTrackEnvelope>[1]) {
  return buildTrackEnvelope(store, edit, {...action(store), requestId: `track-${randomUUID()}`, actionId: randomUUID()});
}
function record(store: ProjectStore) {
  const value = readFormat5TimelineRecord(store.db, 'project');
  assert.ok(value);
  return value;
}
function run(store: ProjectStore, edit: Parameters<typeof buildTrackEnvelope>[1]) {
  const env = envelope(store, edit);
  return {env, result: runTrackSync(store, env)};
}

test('adding a track is one unified-history action with undo and redo', () => {
  const store = fixture().store;
  try {
    const before = record(store);
    const trackId = randomUUID();
    const {env, result} = run(store, {kind: 'add', trackId, trackKind: 'audio', name: '对白'});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(findSequenceEditReceipt(store, env.requestId)?.receipt.operation, 'timeline.track.add');
    const added = record(store);
    assert.equal(added.tracks.length, before.tracks.length + 1);
    assert.equal(added.mainTrack.trackId, before.mainTrack.trackId);
    assert.deepEqual(added.tracks.find(track => track.id === trackId), {id: trackId, name: '对白', kind: 'audio',
      orderIndex: Math.max(...before.tracks.map(track => track.orderIndex)) + 1, hidden: false, muted: false});
    const state = prepareSequenceEditHistory(store);
    const undo = moveSequenceSyncHistory(store, {projectId: store.projectId, requestId: `undo-${randomUUID()}`,
      actionId: env.actionId, direction: 'undo', expected: {position: state.state.position, revision: state.state.revision}});
    assert.equal(undo.ok, true, JSON.stringify(undo));
    assert.equal(record(store).tracks.some(track => track.id === trackId), false);
    const undoState = prepareSequenceEditHistory(store);
    const redo = moveSequenceSyncHistory(store, {projectId: store.projectId, requestId: `redo-${randomUUID()}`,
      actionId: env.actionId, direction: 'redo', expected: {position: undoState.state.position, revision: undoState.state.revision}});
    assert.equal(redo.ok, true, JSON.stringify(redo));
    assert.equal(record(store).tracks.some(track => track.id === trackId), true);
  } finally {store.close();}
});

test('renaming, hiding, muting and reordering keep main-track identity and undo as one step', () => {
  const store = fixture().store;
  try {
    const before = record(store);
    const main = before.tracks.find(track => track.id === before.mainTrack.trackId)!;
    const free = Math.max(...before.tracks.map(track => track.orderIndex)) + 1;
    assert.ok(free < 12);
    const env = envelope(store, {kind: 'update', trackId: main.id,
      patch: {name: '主画面', muted: true, orderIndex: free}});
    assert.equal(runTrackSync(store, env).ok, true);
    const updated = record(store);
    assert.equal(updated.mainTrack.trackId, before.mainTrack.trackId);
    assert.deepEqual(updated.tracks.find(track => track.id === main.id), {...main, name: '主画面', muted: true, orderIndex: free});
    const state = prepareSequenceEditHistory(store);
    assert.equal(moveSequenceSyncHistory(store, {projectId: store.projectId, requestId: `undo-${randomUUID()}`,
      actionId: env.actionId, direction: 'undo', expected: {position: state.state.position, revision: state.state.revision}}).ok, true);
    assert.deepEqual(record(store).tracks.find(track => track.id === main.id), main);
  } finally {store.close();}
});

test('track actions refuse invalid kind, duplicate id/order, audio hide, unknown tracks and no-ops', () => {
  const store = fixture().store;
  try {
    const current = record(store);
    const main = current.tracks.find(track => track.id === current.mainTrack.trackId)!;
    const refuse = (edit: Parameters<typeof buildTrackEnvelope>[1]): void => {
      const env = envelope(store, edit);
      assert.throws(() => planTrack(store, env.trackIntent!), {code: 'SEQUENCE_EDIT_TRACK_INVALID'});
    };
    refuse({kind: 'add', trackId: main.id, trackKind: 'video'});
    refuse({kind: 'add', trackId: randomUUID(), trackKind: 'audio', orderIndex: main.orderIndex});
    refuse({kind: 'update', trackId: randomUUID(), patch: {name: 'x'}});
    refuse({kind: 'add', trackId: randomUUID(), trackKind: 'audio', name: '   '});
    const audio = envelope(store, {kind: 'add', trackId: randomUUID(), trackKind: 'audio'}).trackIntent!.operation.edit;
    assert.equal(runTrackSync(store, envelope(store, audio)).ok, true);
    const audioId = audio.kind === 'add' ? audio.trackId : '';
    refuse({kind: 'update', trackId: audioId, patch: {hidden: true}});
    const noop = envelope(store, {kind: 'update', trackId: main.id, patch: {name: main.name}});
    const noopResult = runTrackSync(store, noop);
    assert.equal(noopResult.ok, false);
    assert.equal((noopResult as {code: string}).code, 'SEQUENCE_EDIT_NOOP');
    assert.equal(findSequenceEditReceipt(store, noop.requestId)?.receipt.status, 'not_applied');
  } finally {store.close();}
});

test('track adds are bounded at twelve tracks and a repeated request replays one receipt', () => {
  const store = fixture().store;
  try {
    let current = record(store);
    while (current.tracks.length < 12) {
      const trackId = randomUUID();
      assert.equal(run(store, {kind: 'add', trackId, trackKind: current.tracks.filter(track => track.kind === 'video').length
        > current.tracks.filter(track => track.kind === 'audio').length ? 'audio' : 'video'}).result.ok, true);
      current = record(store);
    }
    const extra = envelope(store, {kind: 'add', trackId: randomUUID(), trackKind: 'video'});
    assert.throws(() => planTrack(store, extra.trackIntent!), {code: 'SEQUENCE_EDIT_TRACK_INVALID'});
    // Replaying the last accepted envelope returns the same receipt and does not grow history.
    const before = prepareSequenceEditHistory(store).state.position;
    const replay = envelope(store, {kind: 'update', trackId: current.tracks[0]!.id, patch: {muted: true}});
    assert.equal(runTrackSync(store, replay).ok, true);
    const receipt = findSequenceEditReceipt(store, replay.requestId)!;
    const afterFirst = prepareSequenceEditHistory(store).state;
    const replayAgain = runTrackSync(store, replay);
    assert.equal(replayAgain.ok, true);
    assert.equal((replayAgain as {receipt: {actionId: string}}).receipt.actionId, receipt.receipt.actionId);
    assert.equal(prepareSequenceEditHistory(store).state.revision, afterFirst.revision);
    assert.equal(afterFirst.position, before + 1);
  } finally {store.close();}
});
