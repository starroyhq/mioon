import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {createSequenceEditing} from '../packages/business/src/sequence-edit.ts';
import {previewSequenceSync, runSequenceSync} from '../packages/business/src/format5-sequence-sync.ts';
import {sequenceEditInputDigest} from '../packages/business/src/format5-editor-history.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import type {Format5Cue, Format5Dialogue} from '../packages/contracts/src/project-format5.ts';
import type {SequenceEditDialogueIntent, SequenceEditEnvelope} from '../packages/contracts/src/sequence-edit.ts';
import type {SequenceSyncCommand} from '../packages/contracts/src/sequence-sync.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `60000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sha = (letter: string): string => letter.repeat(64);

const projectId = id(1);
const rootId = id(2);
const shotA = id(3), shotB = id(4), shotC = id(5);
const videoTrack = id(6), audioTrack = id(7), timelineId = id(8);
const clipA = id(9), clipB = id(10), groupA = id(11), groupB = id(12);
const assetA = id(13), versionA = id(14), jobA = id(15);
const line1 = id(16), line2 = id(17), line3 = id(18), line4 = id(19);
const audioAsset = id(22), audioClip = id(23);
const plainCue = id(30);

/** One format-5 project: ready shot A (2 lines) then placeholder shot B on the
 * main track, a floating shot C with one line, an ordinary subtitle inside A's
 * span and a long music clip that keeps the timeline duration stable. */
function fixture(t: test.TestContext): ProjectStore {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-dialogue-'));
  const store = createProjectStore({projectId, projectFile: path.join(root, 'project.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const timeline = {
    id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 300,
    createdAt: at, updatedAt: at, mainTrack: {trackId: videoTrack, sequenceNodeId: rootId},
    tracks: [{id: videoTrack, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: audioTrack, name: 'A1', kind: 'audio', orderIndex: 1, hidden: false, muted: false}],
    clips: [
      {id: clipA, trackId: videoTrack, name: 'Shot A', startFrame: 0, durationFrames: 60, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: assetA, versionId: versionA, shotId: shotA,
        jobId: jobA, sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: shotA, segmentGroupId: groupA, versionMode: 'follow'}},
      {id: clipB, trackId: videoTrack, name: 'Shot B', startFrame: 60, durationFrames: 30, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
        sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: shotB, segmentGroupId: groupB, versionMode: 'follow'}},
      {id: audioClip, trackId: audioTrack, name: 'Music', startFrame: 0, durationFrames: 300, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 0.5, assetId: audioAsset, sourceState: 'ready',
        anchor: {clipId: clipA, offsetFrames: 0}},
    ],
    subtitles: {profileId: 'bottom_cjk_v1', cues: [
      {id: plainCue, text: '普通字幕', startFrame: 50, durationFrames: 5, anchor: {clipId: clipA, offsetFrames: 50}},
    ]},
  };
  const baseline = {version: 1 as const,
    board: [{nodeId: shotA, kind: 'shot' as const, selectedVersionId: versionA}, {nodeId: shotB, kind: 'shot' as const, selectedVersionId: null}],
    track: [{nodeId: shotA, segmentGroupId: groupA, clipId: clipA, kind: 'shot' as const, versionMode: 'follow' as const, appliedVersionId: versionA},
      {nodeId: shotB, segmentGroupId: groupB, clipId: clipB, kind: 'shot' as const, versionMode: 'follow' as const, appliedVersionId: null}]};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Dialogue fixture', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: assetA, projectId, mimeType: 'video/mp4', duration: 2, sha256: sha('a')});
    store.put('assets', {id: audioAsset, projectId, mimeType: 'audio/wav', duration: 10, sha256: sha('d')});
    store.put('versions', {id: versionA, projectId, jobId: jobA, shotId: shotA, number: 1, assetId: assetA, sha256: sha('a'), createdAt: at});
    store.put('shots', {id: shotA, projectId, title: 'A', orderIndex: 0, selectedVersionId: versionA, duration: 2,
      position: {x: 0, y: 0}, createdAt: at, updatedAt: at,
      dialogue: [{id: line1, text: '第一句'}, {id: line2, text: '第二句'}]});
    store.put('shots', {id: shotB, projectId, title: 'B', orderIndex: 1, selectedVersionId: null, duration: 1,
      position: {x: 0, y: 0}, createdAt: at, updatedAt: at});
    store.put('shots', {id: shotC, projectId, title: 'C', orderIndex: 2, selectedVersionId: null, duration: 1,
      position: {x: 0, y: 0}, createdAt: at, updatedAt: at, dialogue: [{id: line3, text: '游离台词'}]});
    store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: '成片', position: {x: 0, y: 0}, createdAt: at});
    store.put('edges', {id: id(20), projectId, kind: 'sequence', source: rootId, target: shotA, createdAt: at});
    store.put('edges', {id: id(21), projectId, kind: 'sequence', source: shotA, target: shotB, createdAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify(baseline));
  });
  return store;
}

function requestId(): string {
  return `dialogue-${Math.random().toString(16).slice(2, 12)}`;
}
function edit(store: ProjectStore) {
  return createFormat5SequenceEditService(store);
}
function previewDialogue(store: ProjectStore, intent: SequenceEditDialogueIntent): Record<string, any> {
  return edit(store).preview({projectId, requestId: requestId(), dialogueIntent: intent}) as Record<string, any>;
}
function commitDialogue(store: ProjectStore, intent: SequenceEditDialogueIntent): Record<string, any> {
  const preview = previewDialogue(store, intent);
  assert.equal(preview.ok, undefined, `preview failed: ${JSON.stringify(preview)}`);
  const result = edit(store).commit({projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest}) as Record<string, any>;
  assert.notEqual(result.status, 'not_applied', `commit failed: ${JSON.stringify(result)}`);
  return result;
}
function dialogueFailure(store: ProjectStore, intent: SequenceEditDialogueIntent): {code: string; ids: string[]} {
  const preview = previewDialogue(store, intent);
  assert.equal(preview.ok, false, `preview unexpectedly succeeded: ${JSON.stringify(preview).slice(0, 400)}`);
  return {code: String(preview.code), ids: [...(preview.ids ?? [])]};
}
function runSync(store: ProjectStore, command: SequenceSyncCommand): Record<string, any> {
  const preview = previewSequenceSync(store, command, {requestId: requestId()});
  assert.ok('envelope' in preview, `sync preview failed: ${'code' in preview ? preview.code : ''}`);
  const result = runSequenceSync(store, preview.envelope, {expectedPlanDigest: preview.planDigest}) as Record<string, any>;
  assert.ok(result.ok !== false, `sync failed: ${result.code}`);
  return result;
}
function undo(store: ProjectStore): void {
  const history = createSequenceEditing(store).call('sequence.history.get', {projectId}) as Record<string, any>;
  assert.ok(history.undo, 'there must be an undo step');
  createSequenceEditing(store).call('sequence.undo', {projectId, requestId: requestId(),
    actionId: history.undo.actionId, expected: {position: history.position, revision: history.revision}});
}
function redo(store: ProjectStore): void {
  const history = createSequenceEditing(store).call('sequence.history.get', {projectId}) as Record<string, any>;
  assert.ok(history.redo, 'there must be a redo step');
  createSequenceEditing(store).call('sequence.redo', {projectId, requestId: requestId(),
    actionId: history.redo.actionId, expected: {position: history.position, revision: history.revision}});
}
function timeline(store: ProjectStore) {
  return readFormat5TimelineRecord(store.db, 'project')!;
}
function cues(store: ProjectStore): Format5Cue[] {
  return timeline(store).subtitles?.cues ?? [];
}
function shotDialogue(store: ProjectStore, shotId: string): Format5Dialogue {
  const row = store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(shotId) as {data: string};
  return (JSON.parse(row.data) as {dialogue?: Format5Dialogue}).dialogue ?? [];
}
function shotRow(store: ProjectStore, shotId: string): Record<string, any> {
  const row = store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(shotId) as {data: string};
  return JSON.parse(row.data) as Record<string, any>;
}
function dialogueCues(store: ProjectStore, shotId: string): Format5Cue[] {
  return cues(store).filter(cue => cue.dialogueRef?.shotId === shotId);
}
function cueFor(store: ProjectStore, shotId: string, lineId: string): Format5Cue | undefined {
  return dialogueCues(store, shotId).find(cue => cue.dialogueRef!.lineId === lineId);
}
function actionName(store: ProjectStore): string {
  const history = createSequenceEditing(store).call('sequence.history.get', {projectId}) as Record<string, any>;
  return String(history.undo?.operation);
}

// ---------------------------------------------------------------------------
// Shot dialogue <-> subtitle cue projection
// ---------------------------------------------------------------------------

test('updating a shot line projects one cue per line and syncs the cue text', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '改过的第一句'},
  ]}});
  assert.equal(actionName(store), 'board.dialogue.update');
  assert.deepEqual(shotDialogue(store, shotA).map(line => line.text), ['改过的第一句', '第二句']);
  const projected = dialogueCues(store, shotA);
  assert.equal(projected.length, 2, 'every valid line owns a real cue');
  for (const cue of projected) {
    const line = shotDialogue(store, shotA).find(item => item.id === cue.dialogueRef?.lineId)!;
    assert.equal(cue.text, line.text);
    assert.ok(cue.anchor && cue.anchor.clipId === clipA);
    assert.ok(cue.startFrame >= 0 && cue.startFrame + cue.durationFrames <= 60);
  }
  assert.equal(cueFor(store, shotA, line1)!.text, '改过的第一句');
  // The ordinary subtitle keeps identity, text, frames and no dialogue link.
  const plain = cues(store).find(cue => cue.id === plainCue)!;
  assert.deepEqual({text: plain.text, startFrame: plain.startFrame, durationFrames: plain.durationFrames,
    dialogueRef: plain.dialogueRef, anchor: plain.anchor}, {text: '普通字幕', startFrame: 50, durationFrames: 5,
    dialogueRef: undefined, anchor: {clipId: clipA, offsetFrames: 50}});
  assert.equal(new Set(cues(store).map(cue => cue.id)).size, cues(store).length, 'cue ids are unique');
  undo(store);
  assert.deepEqual(shotDialogue(store, shotA).map(line => line.text), ['第一句', '第二句']);
  assert.equal(cues(store).length, 1, 'undo removes the projected cues again');
});

test('editing the linked cue text writes the same dialogue line (timeline side)', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  const cue = cueFor(store, shotA, line1)!;
  commitDialogue(store, {side: 'timeline', operation: {kind: 'dialogue', edits: [
    {kind: 'set-text-by-cue', cueId: cue.id, text: '剪辑侧改的'},
  ]}});
  assert.equal(shotDialogue(store, shotA).find(line => line.id === line1)!.text, '剪辑侧改的');
  assert.equal(cueFor(store, shotA, line1)!.text, '剪辑侧改的');
  assert.equal(actionName(store), 'timeline.dialogue.text');
  // A cue without a dialogue link refuses the timeline-side text edit.
  const failure = dialogueFailure(store, {side: 'timeline', operation: {kind: 'dialogue', edits: [
    {kind: 'set-text-by-cue', cueId: plainCue, text: '改普通'},
  ]}});
  assert.equal(failure.code, 'SEQUENCE_EDIT_DIALOGUE_INVALID');
});

test('adding and removing lines creates and removes exactly the matching cues', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'add', shotId: shotA, line: {id: line4, text: '第三句'}},
  ]}});
  assert.equal(shotDialogue(store, shotA).length, 3);
  assert.equal(dialogueCues(store, shotA).length, 3);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [{kind: 'remove', shotId: shotA, lineId: line4}]}});
  assert.equal(shotDialogue(store, shotA).length, 2);
  assert.equal(dialogueCues(store, shotA).length, 2);
  undo(store);
  assert.equal(shotDialogue(store, shotA).length, 3);
  assert.equal(dialogueCues(store, shotA).length, 3);
});

test('reordering lines keeps cue identity and swaps the projected order', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  const before = dialogueCues(store, shotA).sort((left, right) => left.startFrame - right.startFrame);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'reorder', shotId: shotA, lineIds: [line2, line1]},
  ]}});
  assert.deepEqual(shotDialogue(store, shotA).map(line => line.id), [line2, line1]);
  const after = dialogueCues(store, shotA).sort((left, right) => left.startFrame - right.startFrame);
  assert.deepEqual(new Set(after.map(cue => cue.id)), new Set(before.map(cue => cue.id)), 'cue ids follow their lines');
  assert.equal(after[0]!.dialogueRef!.lineId, line2);
  assert.equal(after[1]!.dialogueRef!.lineId, line1);
});

test('dialogue text outside the subtitle norm is rejected without truncation', t => {
  const store = fixture(t);
  const failure = dialogueFailure(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '字'.repeat(21)},
  ]}});
  assert.equal(failure.code, 'SEQUENCE_EDIT_DIALOGUE_INVALID');
  assert.equal(shotDialogue(store, shotA)[0]!.text, '第一句');
});

test('a no-op dialogue request writes no history and replays its receipt', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  const historyBefore = createSequenceEditing(store).call('sequence.history.get', {projectId}) as Record<string, any>;
  const preview = previewDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'SEQUENCE_EDIT_NOOP');
  assert.deepEqual((createSequenceEditing(store).call('sequence.history.get', {projectId}) as Record<string, any>),
    historyBefore, 'no history entry or cursor move');
});

test('an exact retry of the same envelope replays the stored receipt once', t => {
  const store = fixture(t);
  const preview = previewDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  const service = edit(store);
  const first = service.commit({projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest}) as Record<string, any>;
  const projected = cues(store).length;
  const second = service.commit({projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest}) as Record<string, any>;
  assert.equal(second.actionId, first.actionId);
  assert.equal(cues(store).length, projected, 'replay does not write a second action');
});

test('a shot that cannot fit its lines rejects the action instead of moving ordinary cues', t => {
  const store = fixture(t);
  // Fill shot B's span with one ordinary cue so a dialogue line has no legal frames.
  store.tx(() => {
    const record = timeline(store);
    record.subtitles!.cues.push({id: id(31), text: '占满', startFrame: 60, durationFrames: 30, anchor: {clipId: clipB, offsetFrames: 0}});
    store.put('timelines', record);
  });
  const failure = dialogueFailure(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'add', shotId: shotB, line: {id: line4, text: '放不下'}},
  ]}});
  assert.equal(failure.code, 'SEQUENCE_EDIT_DIALOGUE_CONFLICT');
  assert.ok(failure.ids.includes(shotB));
  assert.deepEqual(shotDialogue(store, shotB), []);
  assert.equal(cues(store).find(cue => cue.id === id(31))!.text, '占满');
});

// ---------------------------------------------------------------------------
// Subtitle edits on linked cues write the same dialogue line (coordinator item)
// ---------------------------------------------------------------------------

function commitSubtitles(store: ProjectStore, edits: readonly unknown[]): Record<string, any> {
  const preview = edit(store).preview({projectId, requestId: requestId(),
    subtitlesIntent: {side: 'timeline', operation: {kind: 'subtitles', edits}}}) as Record<string, any>;
  assert.equal(preview.ok, undefined, `subtitle preview failed: ${JSON.stringify(preview)}`);
  const result = edit(store).commit({projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest}) as Record<string, any>;
  assert.notEqual(result.status, 'not_applied', `subtitle commit failed: ${JSON.stringify(result)}`);
  return {...result, envelope: preview.envelope};
}
function subtitleFailure(store: ProjectStore, edits: readonly unknown[]): {code: string} {
  const preview = edit(store).preview({projectId, requestId: requestId(),
    subtitlesIntent: {side: 'timeline', operation: {kind: 'subtitles', edits}}}) as Record<string, any>;
  assert.equal(preview.ok, false, `subtitle preview unexpectedly succeeded: ${JSON.stringify(preview).slice(0, 300)}`);
  return {code: String(preview.code)};
}

test('editing a linked subtitle text writes the shot line in the same subtitle action', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  const cue = cueFor(store, shotA, line1)!;
  const before = timeline(store);
  commitSubtitles(store, [{kind: 'update', cueId: cue.id, patch: {text: '字幕侧改的'}}]);
  assert.equal(cueFor(store, shotA, line1)!.text, '字幕侧改的', 'the cue text changes');
  assert.equal(shotDialogue(store, shotA).find(line => line.id === line1)!.text, '字幕侧改的',
    'the same shot dialogue line changes');
  // Other fields of the cue and its link are kept.
  const after = cueFor(store, shotA, line1)!;
  assert.deepEqual(after.anchor, cue.anchor);
  assert.deepEqual(after.dialogueRef, {shotId: shotA, lineId: line1});
  undo(store);
  assert.equal(cueFor(store, shotA, line1)!.text, '第一句改');
  assert.equal(shotDialogue(store, shotA).find(line => line.id === line1)!.text, '第一句改',
    'one undo restores both sides');
});

test('removing a linked subtitle removes the dialogue line; other lines keep their cues', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  const cue = cueFor(store, shotA, line2)!;
  commitSubtitles(store, [{kind: 'remove', cueId: cue.id}]);
  assert.deepEqual(shotDialogue(store, shotA).map(line => line.id), [line1], 'both sides drop the line');
  assert.equal(dialogueCues(store, shotA).length, 1);
  assert.equal(cueFor(store, shotA, line2), undefined);
  undo(store);
  assert.deepEqual(shotDialogue(store, shotA).map(line => line.id), [line1, line2]);
  assert.equal(cueFor(store, shotA, line2)!.text, '第二句');
});

test('undo of a subtitle add removes its cue and redo restores it', t => {
  const store = fixture(t);
  const added = id(59);
  let preview = edit(store).preview({projectId, requestId: requestId(),
    subtitlesIntent: {side: 'timeline', operation: {kind: 'subtitles', edits: [{kind: 'add',
      cue: {id: added, text: '加一句', startFrame: 10, durationFrames: 20}}]}}}) as Record<string, any>;
  assert.equal(preview.ok, undefined, JSON.stringify(preview));
  const committed = edit(store).commit({projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest}) as Record<string, any>;
  assert.equal(committed.status, 'applied');
  assert.equal(cues(store).some(cue => cue.id === added), true);
  // The incremental delta applier needs the created cue in the inverse removal
  // list; a full-list rewrite would silently leave it behind on undo.
  undo(store);
  assert.equal(cues(store).some(cue => cue.id === added), false, 'undo removes the added cue');
  assert.deepEqual(cues(store).map(cue => cue.id), [plainCue], 'the pre-existing cue stays');
  redo(store);
  assert.equal(cues(store).some(cue => cue.id === added), true, 'redo restores the added cue');
  undo(store);
});

test('subtitle add stays an ordinary cue and linking fields are rejected', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  const added = id(60);
  commitSubtitles(store, [{kind: 'add', cue: {id: added, text: '普通', startFrame: 60, durationFrames: 10,
    dialogueRef: {shotId: shotA, lineId: line2}}}]);
  const stored = cues(store).find(cue => cue.id === added)!;
  assert.equal(stored.dialogueRef, undefined, 'add never links a dialogue line');
  assert.equal(cueFor(store, shotA, line2)!.text, '第二句');
  // An update cannot create/remove the link either.
  const cue = cueFor(store, shotA, line1)!;
  assert.equal(subtitleFailure(store, [{kind: 'update', cueId: cue.id, patch: {dialogueRef: null}}]).code,
    'SEQUENCE_EDIT_SUBTITLE_INVALID');
});

test('a detached linked subtitle can still have its text edited and keeps the link', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  const cue = cueFor(store, shotA, line1)!;
  store.tx(() => {
    const record = timeline(store);
    record.subtitles!.cues.find(item => item.id === cue.id)!.anchor = null;
    store.put('timelines', record);
  });
  commitSubtitles(store, [{kind: 'update', cueId: cue.id, patch: {text: '未挂靠改'}}]);
  const after = cues(store).find(item => item.id === cue.id)!;
  assert.equal(after.text, '未挂靠改');
  assert.equal(after.anchor, null, 'a text edit does not attach a detached cue');
  assert.equal(shotDialogue(store, shotA).find(line => line.id === line1)!.text, '未挂靠改');
  // Timing edits keep the dialogue line untouched.
  const second = cueFor(store, shotA, line2)!;
  commitSubtitles(store, [{kind: 'update', cueId: second.id, patch: {durationFrames: 5}}]);
  assert.equal(shotDialogue(store, shotA).find(line => line.id === line2)!.text, '第二句');
  assert.equal(cueFor(store, shotA, line2)!.dialogueRef!.lineId, line2);
});

// ---------------------------------------------------------------------------
// Main-track lifecycle: split, float, re-attach, archive, copy
// ---------------------------------------------------------------------------

test('splitting a shot keeps cue ids and transfers the anchor by the subtitle start', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  const before = dialogueCues(store, shotA).sort((left, right) => left.startFrame - right.startFrame);
  const rightClip = id(90);
  runSync(store, {kind: 'clip-split', clipId: clipA, offsetFrames: 24, rightClipId: rightClip});
  const after = dialogueCues(store, shotA).sort((left, right) => left.startFrame - right.startFrame);
  assert.deepEqual(after.map(cue => cue.id), before.map(cue => cue.id), 'split keeps cue ids');
  assert.deepEqual(after.map(cue => [cue.startFrame, cue.durationFrames]),
    before.map(cue => [cue.startFrame, cue.durationFrames]), 'split keeps the absolute frames');
  for (const cue of after) {
    const anchor = cue.anchor!;
    assert.ok(anchor.clipId === clipA || anchor.clipId === rightClip);
    if (cue.startFrame >= 24) {
      assert.equal(anchor.clipId, rightClip, 'a cue starting in the right half anchors to the new segment');
      assert.equal(cue.startFrame, 24 + anchor.offsetFrames);
    }
  }
});

test('a detached cue stays unanchored on later unrelated syncs', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  const cue = cueFor(store, shotA, line1)!;
  // Detach it in place (a trim/owner edit would leave exactly this state).
  store.tx(() => {
    const record = timeline(store);
    const target = record.subtitles!.cues.find(item => item.id === cue.id)!;
    target.anchor = null;
    store.put('timelines', record);
  });
  runSync(store, {kind: 'clip-version', clipId: clipA, versionId: versionA, mode: 'locked'});
  const after = cues(store).find(item => item.id === cue.id)!;
  assert.equal(after.anchor, null, 'a later sync does not silently attach a detached cue');
  assert.equal(after.startFrame, cue.startFrame);
  assert.equal(after.text, '第一句改');
});

test('a floating shot keeps its cue in place and re-attaching reuses the same cue', t => {
  const store = fixture(t);
  // Connect the floating shot C at the chain tail: its line is projected.
  edit(store).preview({projectId, requestId: requestId(), intents: [
    {side: 'board', operation: {kind: 'board', edit: {kind: 'connect', fromId: shotB, toId: shotC}}},
  ]});
  runSync(store, {kind: 'clip-move', clipId: clipB, beforeClipId: null}); // keep B as tail before C
  const connect = edit(store).preview({projectId, requestId: requestId(), intents: [
    {side: 'board', operation: {kind: 'board', edit: {kind: 'connect', fromId: shotB, toId: shotC}}},
  ]}) as Record<string, any>;
  assert.equal(connect.ok, undefined, `connect preview failed: ${JSON.stringify(connect)}`);
  edit(store).commit({projectId, envelope: connect.envelope, expectedPlanDigest: connect.planDigest});
  const cCue = cueFor(store, shotC, line3)!;
  assert.ok(cCue.anchor !== null);
  const frame = cCue.startFrame;
  // Disconnect C: it floats, the cue stays in place and keeps its link.
  const disconnect = edit(store).preview({projectId, requestId: requestId(), intents: [
    {side: 'board', operation: {kind: 'board', edit: {kind: 'disconnect', fromId: shotB, toId: shotC}}},
  ]}) as Record<string, any>;
  assert.equal(disconnect.ok, undefined, `disconnect preview failed: ${JSON.stringify(disconnect)}`);
  edit(store).commit({projectId, envelope: disconnect.envelope, expectedPlanDigest: disconnect.planDigest});
  const floating = cueFor(store, shotC, line3)!;
  assert.equal(floating.id, cCue.id);
  assert.equal(floating.startFrame, frame);
  assert.equal(floating.anchor, null, 'a floating shot leaves its cue unanchored in place');
  assert.equal(floating.dialogueRef!.shotId, shotC, 'the link is retained');
  // Re-attach: the same cue is reused (no duplicate) and anchored again.
  const reattach = edit(store).preview({projectId, requestId: requestId(), intents: [
    {side: 'board', operation: {kind: 'board', edit: {kind: 'connect', fromId: shotB, toId: shotC}}},
  ]}) as Record<string, any>;
  assert.equal(reattach.ok, undefined, `reattach preview failed: ${JSON.stringify(reattach)}`);
  edit(store).commit({projectId, envelope: reattach.envelope, expectedPlanDigest: reattach.planDigest});
  const reattached = dialogueCues(store, shotC);
  assert.equal(reattached.length, 1, 're-attaching does not generate a duplicate cue');
  assert.equal(reattached[0]!.id, cCue.id);
  assert.ok(reattached[0]!.anchor !== null, 'the reused cue is anchored to the new main-track segment');
});

test('editing a floating shot line refreshes its detached cue, and removing the line removes it', t => {
  const store = fixture(t);
  const connect = edit(store).preview({projectId, requestId: requestId(), intents: [
    {side: 'board', operation: {kind: 'board', edit: {kind: 'connect', fromId: shotB, toId: shotC}}},
  ]}) as Record<string, any>;
  assert.equal(connect.ok, undefined, `connect preview failed: ${JSON.stringify(connect)}`);
  edit(store).commit({projectId, envelope: connect.envelope, expectedPlanDigest: connect.planDigest});
  const disconnect = edit(store).preview({projectId, requestId: requestId(), intents: [
    {side: 'board', operation: {kind: 'board', edit: {kind: 'disconnect', fromId: shotB, toId: shotC}}},
  ]}) as Record<string, any>;
  assert.equal(disconnect.ok, undefined, `disconnect preview failed: ${JSON.stringify(disconnect)}`);
  edit(store).commit({projectId, envelope: disconnect.envelope, expectedPlanDigest: disconnect.planDigest});
  const detached = cueFor(store, shotC, line3)!;
  assert.equal(detached.anchor, null);
  // Editing the floating shot's line keeps the detached cue in place with the new text.
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotC, lineId: line3, text: '游离台词改'},
  ]}});
  assert.equal(shotDialogue(store, shotC)[0]!.text, '游离台词改');
  const refreshed = cues(store).find(cue => cue.id === detached.id)!;
  assert.equal(refreshed.text, '游离台词改');
  assert.equal(refreshed.anchor, null, 'the floating shot keeps its cue unanchored in place');
  assert.equal(refreshed.startFrame, detached.startFrame);
  // Removing the line removes its detached cue too; undo restores both sides.
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [{kind: 'remove', shotId: shotC, lineId: line3}]}});
  assert.deepEqual(shotDialogue(store, shotC), []);
  assert.equal(cues(store).some(cue => cue.id === detached.id), false);
  undo(store);
  assert.equal(shotDialogue(store, shotC)[0]!.text, '游离台词改');
  assert.equal(cues(store).find(cue => cue.id === detached.id)!.text, '游离台词改');
});

test('archiving a shot turns its linked cues into ordinary cues and undo restores the link', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'add', shotId: shotB, line: {id: line4, text: '镜头B的台词'}},
  ]}});
  const linked = cueFor(store, shotB, line4)!;
  assert.equal(linked.id, line4 ? linked.id : '');
  const archive = edit(store).preview({projectId, requestId: requestId(), intents: [
    {side: 'board', operation: {kind: 'board', edit: {kind: 'delete', nodeId: shotB}}},
  ]}) as Record<string, any>;
  assert.equal(archive.ok, undefined, `archive preview failed: ${JSON.stringify(archive)}`);
  edit(store).commit({projectId, envelope: archive.envelope, expectedPlanDigest: archive.planDigest});
  const archived = cues(store).find(cue => cue.id === linked.id)!;
  assert.equal(archived.dialogueRef, undefined, 'an archived shot makes its cue an ordinary subtitle');
  assert.equal(archived.startFrame, linked.startFrame, 'the ordinary cue keeps its frame');
  assert.equal(archived.text, '镜头B的台词', 'the text is kept');
  undo(store);
  const restored = cues(store).find(cue => cue.id === linked.id)!;
  assert.deepEqual(restored.dialogueRef, {shotId: shotB, lineId: line4}, 'undo restores the dialogue link');
  assert.equal(shotDialogue(store, shotB)[0]!.text, '镜头B的台词');
});

test('copying a shot generates new line ids and a uniquely owned cue', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  // Splitting A produces a movable right part; copying that piece creates a new shot.
  const rightClip = id(91);
  runSync(store, {kind: 'clip-split', clipId: clipA, offsetFrames: 24, rightClipId: rightClip});
  const newShot = id(92);
  runSync(store, {kind: 'clip-move', clipId: rightClip, beforeClipId: null, copyNodeId: newShot});
  const copied = shotDialogue(store, newShot);
  assert.equal(copied.length, 2, 'the copy carries the dialogue lines');
  assert.deepEqual(copied.map(line => line.text), ['第一句改', '第二句']);
  assert.ok(copied.every(line => !shotDialogue(store, shotA).some(source => source.id === line.id)), 'copied lines get new ids');
  const copiedCues = dialogueCues(store, newShot);
  assert.equal(copiedCues.length, 2);
  assert.ok(copiedCues.every(cue => cue.dialogueRef!.shotId === newShot));
  const keys = cues(store).flatMap(cue => cue.dialogueRef ? [`${cue.dialogueRef.shotId}/${cue.dialogueRef.lineId}`] : []);
  assert.equal(new Set(keys).size, keys.length, 'a dialogue line is projected at most once per timeline');
});

test('in-place copy projects fresh dialogue cues and preserves source cues and version ownership on subsequent sync', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  const originalCues = cues(store);
  const originalLines = shotDialogue(store, shotA);
  const copyClipId = id(93), copyNodeId = id(94);
  runSync(store, {kind: 'clip-copy-as-new-shot', clipId: clipA, newClipId: copyClipId, copyNodeId});
  const copied = shotDialogue(store, copyNodeId);
  assert.deepEqual(copied.map(line => line.text), originalLines.map(line => line.text));
  assert.ok(copied.every(line => !originalLines.some(source => source.id === line.id)), 'copied lines get new ids');
  const copiedCues = dialogueCues(store, copyNodeId);
  assert.deepEqual(copiedCues.map(cue => [cue.dialogueRef!.lineId, cue.anchor?.clipId]),
    copied.map(line => [line.id, copyClipId]));
  assert.deepEqual(cues(store), [...originalCues, ...copiedCues]);
  const secondClipId = id(95), secondNodeId = id(96);
  runSync(store, {kind: 'clip-copy-as-new-shot', clipId: copyClipId, newClipId: secondClipId, copyNodeId: secondNodeId});
  const secondCues = dialogueCues(store, secondNodeId);
  assert.deepEqual(secondCues.map(cue => [cue.text, cue.anchor?.clipId]),
    originalLines.map(line => [line.text, secondClipId]));
  runSync(store, {kind: 'clip-trim', clipId: clipB, durationFrames: 20});
  assert.deepEqual(cues(store), [...originalCues, ...copiedCues, ...secondCues]);
  const timeline = readFormat5TimelineRecord(store.db, 'project')!;
  for (const [clipId, nodeId] of [[copyClipId, copyNodeId], [secondClipId, secondNodeId]]) {
    const clip = timeline.clips.find(item => item.id === clipId)!;
    assert.equal(clip.versionId, versionA);
    assert.equal(clip.shotId, shotA);
    assert.equal(clip.sequenceSource?.nodeId, nodeId);
  }
});

test('in-place copy identifies the saved subtitle and missing dialogue space without writing', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  store.tx(() => {
    const record = timeline(store);
    // An unattached cue keeps its absolute frames over the copy's proposed span.
    record.subtitles!.cues.push({id: id(31), text: '挡住这里的一行很长的字幕需要省略', startFrame: 60, durationFrames: 59, anchor: null});
    store.put('timelines', record);
  });
  const beforeTimeline = timeline(store);
  const beforeShots = store.list('shots', projectId);
  const beforeHistory = createSequenceEditing(store).call('sequence.history.get', {projectId});
  const copyNodeId = id(94);
  const failure = previewSequenceSync(store, {kind: 'clip-copy-as-new-shot', clipId: clipA,
    newClipId: id(93), copyNodeId}, {requestId: requestId()});
  assert.ok('ok' in failure && failure.ok === false);
  assert.equal(failure.code, 'SEQUENCE_EDIT_DIALOGUE_CONFLICT');
  assert.deepEqual(failure.ids, [copyNodeId]);
  assert.deepEqual(failure.dialogueConflict, {
    blockers: [{cueId: id(31), startFrame: 60, endFrame: 119, textExcerpt: '挡住这里的一行很长的字幕…'}],
    blockerCount: 1, requiredFrames: 2, availableFrames: 1,
  });
  assert.equal(failure.message,
    '副本的台词放不进去。这段时间已有字幕「挡住这里的一行很长的字幕…」。至少需要 2 帧，这段时间只剩 1 帧。先挪开或删掉挡住的字幕再复制。');
  assert.deepEqual(timeline(store), beforeTimeline);
  assert.deepEqual(store.list('shots', projectId), beforeShots);
  assert.deepEqual(createSequenceEditing(store).call('sequence.history.get', {projectId}), beforeHistory);
});

test('in-place copy of a one-frame split explains the missing space without inventing a subtitle blocker', t => {
  const store = fixture(t);
  commitDialogue(store, {side: 'board', operation: {kind: 'dialogue', edits: [
    {kind: 'update', shotId: shotA, lineId: line1, text: '第一句改'},
  ]}});
  runSync(store, {kind: 'clip-split', clipId: clipA, offsetFrames: 1, rightClipId: id(92)});
  const failure = previewSequenceSync(store, {kind: 'clip-copy-as-new-shot', clipId: clipA,
    newClipId: id(93), copyNodeId: id(94)}, {requestId: requestId()});
  assert.ok('ok' in failure && failure.ok === false);
  assert.equal(failure.code, 'SEQUENCE_EDIT_DIALOGUE_CONFLICT');
  assert.deepEqual(failure.dialogueConflict, {blockers: [], blockerCount: 0, requiredFrames: 2, availableFrames: 1});
  assert.match(failure.message ?? '', /延长片段或减少台词再复制/);
});

test('in-place copy rejects a non-main-track source without creating history or storing a receipt', t => {
  const store = fixture(t);
  const cursor = () => store.db.prepare('SELECT epoch,position,revision FROM main.editor_history_state').all();
  assert.deepEqual(cursor(), []);
  const result = previewSequenceSync(store, {kind: 'clip-copy-as-new-shot', clipId: audioClip,
    newClipId: id(93), copyNodeId: id(94)}, {requestId: requestId()});
  assert.deepEqual(result, {ok: false, code: 'INVALID_TRACK_TARGET', ids: [audioClip]});
  assert.deepEqual(cursor(), []);

  const valid = previewSequenceSync(store, {kind: 'clip-copy-as-new-shot', clipId: clipA,
    newClipId: id(93), copyNodeId: id(94)}, {requestId: requestId()});
  assert.ok('envelope' in valid);
  const envelope: SequenceEditEnvelope = {...valid.envelope, intents: [{side: 'timeline', operation: {kind: 'track',
    edit: {kind: 'copy-as-new-shot', clipId: audioClip, newClipId: id(93), copyNodeId: id(94)}}}]};
  const before = cursor();
  assert.deepEqual(runSequenceSync(store, envelope, {expectedPlanDigest: sequenceEditInputDigest(envelope)}), result);
  assert.deepEqual(cursor(), before);
  assert.deepEqual(store.db.prepare('SELECT requestId FROM main.editor_requests').all(), []);
});
