import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {
  moveSequenceSyncHistory, previewSequenceSync, runSequenceSync,
} from '../packages/business/src/format5-sequence-sync.ts';
import type {SequenceSyncCommand} from '../packages/contracts/src/sequence-sync.ts';
import type {SequenceEditCommitResult, SequenceEditHistoryCommand} from '../packages/contracts/src/sequence-edit.ts';
import {measureCommittedCall, summarizeTiming} from './helpers/commit-timing.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `70000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sha = (letter: string): string => letter.repeat(64);

/** K1 acceptance shape for the TSb track-edit actions: 499 shots, 499 main
 * segments (one slot is free so `clip-add` can grow to 500), 1,000 other-track
 * segments and 500 cues. Each measured call is the shared transaction only
 * (preview is the separate read-only confirmation step). */
test('K1 TSb track edits stay inside the local p95 and history budget', t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-tsb-perf-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(directory, 'project.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(directory, 'records'), cacheDir: path.join(directory, 'cache'), tempDir: path.join(directory, 'temp')})});
  t.after(() => {store.close(); rmSync(directory, {recursive: true, force: true});});
  const projectId = store.projectId;
  const rootNode = id(2), videoTrack = id(3), audioTrack = id(4), timelineId = id(5), freeImage = id(6);
  const shots = 499, auxiliary = 1000, cues = 500;
  const shotIds = Array.from({length: shots}, (_, index) => id(1000 + index));
  const mainClipIds = Array.from({length: shots}, (_, index) => id(3000 + index));
  const groups = Array.from({length: shots}, (_, index) => id(5000 + index));
  const timeline = {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: shots * 60,
    createdAt: at, updatedAt: at, mainTrack: {trackId: videoTrack, sequenceNodeId: rootNode},
    tracks: [{id: videoTrack, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: audioTrack, name: 'A1', kind: 'audio', orderIndex: 1, hidden: false, muted: false}],
    clips: [
      ...shotIds.map((shotId, index) => ({id: mainClipIds[index]!, trackId: videoTrack, name: `Shot ${index}`,
        startFrame: index * 60, durationFrames: 60, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
        sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: shotId, segmentGroupId: groups[index]!, versionMode: 'follow'}})),
      ...Array.from({length: auxiliary}, (_, index) => {
        const owner = index % (shots - 1);
        const offset = 10 + Math.floor(index / (shots - 1)) * 15;
        return {id: id(8000 + index), trackId: audioTrack, name: `Audio ${index}`,
          startFrame: owner * 60 + offset, durationFrames: 5, sourceInFrame: 0,
          rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 0.5, assetId: id(7), sourceState: 'ready',
          anchor: {clipId: mainClipIds[owner]!, offsetFrames: offset}};
      }),
    ],
    subtitles: {profileId: 'bottom_cjk_v1', cues: Array.from({length: cues}, (_, index) => {
      const owner = index % (shots - 1);
      const offset = 45 + Math.floor(index / (shots - 1)) * 5;
      return {id: id(9000 + index), text: `Cue ${index}`, startFrame: owner * 60 + offset, durationFrames: 5,
        anchor: {clipId: mainClipIds[owner]!, offsetFrames: offset}};
    })}};
  const baseline = {version: 1,
    board: shotIds.map(shotId => ({nodeId: shotId, kind: 'shot', selectedVersionId: null})),
    track: mainClipIds.map((clipId, index) => ({nodeId: shotIds[index]!, segmentGroupId: groups[index]!, clipId,
      kind: 'shot', versionMode: 'follow', appliedVersionId: null}))};
  const builtAt = Date.now();
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic TSb K1', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: id(7), projectId, mimeType: 'audio/wav', duration: 1200, sha256: sha('d')});
    store.put('assets', {id: id(8), projectId, mimeType: 'image/png', duration: null, sha256: sha('e')});
    for (const shotId of shotIds) store.put('shots', {id: shotId, projectId, orderIndex: 0, selectedVersionId: null, duration: 2, createdAt: at, updatedAt: at});
    store.put('nodes', {id: rootNode, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    store.put('nodes', {id: freeImage, projectId, type: 'image', assetId: id(8), position: {x: 0, y: 0}, createdAt: at});
    const edges = shotIds.map((shotId, index) => ({id: id(10000 + index), projectId, kind: 'sequence' as const,
      source: index === 0 ? rootNode : shotIds[index - 1]!, target: shotId, createdAt: at}));
    for (const edge of edges) store.put('edges', edge);
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootNode, 1, JSON.stringify(baseline));
  });
  const buildMs = Date.now() - builtAt;
  const lastClip = mainClipIds.at(-1)!, rightClip = id(12000);
  const actions: {name: string; command: SequenceSyncCommand}[] = [
    {name: 'split', command: {kind: 'clip-split', clipId: lastClip, offsetFrames: 30, rightClipId: rightClip}},
    {name: 'trim', command: {kind: 'clip-trim', clipId: lastClip, durationFrames: 30}},
    {name: 'remove', command: {kind: 'clip-remove', clipId: lastClip}},
    {name: 'add', command: {kind: 'clip-add', beforeClipId: null, nodeKind: 'image',
      clip: {id: id(12001), nodeId: freeImage, segmentGroupId: id(12002), startFrame: 0, durationFrames: 30, sourceInFrame: 0}}},
  ];
  // Linux CI gates the deterministic transaction body; native COMMIT is a
  // diagnostic there (shared-runner fsync spikes). macOS also gates total.
  const timings: Record<string, number[]> = {}, codePaths: Record<string, number[]> = {};
  const commits: Record<string, number[]> = {};
  const historyBytes: number[] = [];
  for (const action of actions) {
    timings[action.name] = [];
    codePaths[action.name] = [];
    commits[action.name] = [];
    for (let iteration = 0; iteration < 35; iteration++) {
      const requestId = `k1-${action.name}-${iteration}-${Date.now()}`;
      const preview = previewSequenceSync(store, action.command, {requestId});
      assert.ok('envelope' in preview, `preview ${action.name} failed: ${'code' in preview ? preview.code : ''}`);
      const measured = measureCommittedCall(store, () => runSequenceSync(store, preview.envelope,
        {expectedPlanDigest: preview.planDigest}));
      assert.equal(measured.commits, 1, `sync ${action.name} iteration ${iteration} committed ${measured.commits} times`);
      assert.ok(measured.value.ok, `sync ${action.name} failed: ${'code' in measured.value ? measured.value.code : ''}`);
      const committed = measured.value as SequenceEditCommitResult;
      if (iteration >= 5) {
        timings[action.name]!.push(measured.totalMs);
        codePaths[action.name]!.push(measured.codePathMs);
        commits[action.name]!.push(measured.commitMs);
      }
      const row = store.db.prepare(`SELECT length(CAST(beforePatch AS BLOB))+length(CAST(afterPatch AS BLOB)) AS bytes
        FROM main.editor_history_entries WHERE actionId=?`).get(committed.actionId) as Record<string, any>;
      if (iteration >= 5) historyBytes.push(Number(row.bytes));
      const undoCommand: SequenceEditHistoryCommand = {projectId, requestId: `undo-${requestId}`,
        actionId: committed.actionId, direction: 'undo',
        expected: {position: committed.receipt.history.position, revision: committed.receipt.history.revision}};
      const undone = moveSequenceSyncHistory(store, undoCommand);
      assert.ok(undone.ok, `undo ${action.name} failed: ${'code' in undone ? undone.code : ''}`);
    }
  }
  const summary: Record<string, {p50: number; p95: number; max: number;
    codePath: ReturnType<typeof summarizeTiming>; commit: ReturnType<typeof summarizeTiming>}> = {};
  for (const [name, values] of Object.entries(timings)) {
    const total = summarizeTiming(values);
    summary[name] = {...total, codePath: summarizeTiming(codePaths[name]!), commit: summarizeTiming(commits[name]!)};
  }
  const averageHistoryBytes = Math.round(historyBytes.reduce((sum, value) => sum + value, 0) / historyBytes.length);
  console.log(JSON.stringify({benchmark: 'format5-timeline-sync-b', shots, mainClips: shots, auxiliaryClips: auxiliary,
    cues, buildMs, sync: summary, historyEntries: historyBytes.length, averageHistoryBytes,
    maxHistoryBytes: Math.max(...historyBytes)}));
  assert.ok(buildMs < 180_000, `fixture build took ${buildMs}ms`);
  const budget = process.platform === 'linux' ? 200 : 100;
  for (const [name, value] of Object.entries(summary)) {
    assert.ok(value.codePath.p95 <= budget, `${name} code path p95 ${value.codePath.p95}ms exceeds ${budget}ms`);
    if (process.platform !== 'linux') assert.ok(value.p95 <= budget, `${name} p95 ${value.p95}ms exceeds ${budget}ms`);
  }
  assert.ok(averageHistoryBytes <= 256 * 1024, `average history entry ${averageHistoryBytes} bytes exceeds 256 KiB`);
});
