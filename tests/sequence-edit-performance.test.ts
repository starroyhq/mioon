import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {createSequenceEditing} from '../packages/business/src/sequence-edit.ts';
import {withK1BenchmarkLock} from './helpers/k1-benchmark-lock.ts';
import {measureCommittedCall, summarizeTiming} from './helpers/commit-timing.ts';
import {readSequenceEditContext} from '../packages/business/src/sequence-edit.ts';
import {prepareSequenceEditHistory} from '../packages/business/src/format5-editor-history.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {randomUUID} from 'node:crypto';
import type {SequenceEditEnvelope} from '../packages/contracts/src/sequence-edit.ts';
import {checkPerformanceBudget} from './helpers/performance-budget.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `40000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sha = (letter: string): string => letter.repeat(64);

/** K1 acceptance shape: 500 shots, 500 main-track segments and 1,000 other-track
 * segments (plus cues). The measured call is the shared transaction only:
 * receipt replay, revision checks, projection read, SA plan, changed-row writes,
 * three-state baseline, one history action and commit. Envelope preview is the
 * separate read-only step a real UI/MT caller runs before confirmation. */
test('K1 500+500+1,000 board version selection meets the shared-transaction p95 budget', t => withK1BenchmarkLock(() => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-ts-perf-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(root, 'project.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const projectId = store.projectId;
  const rootNode = id(2), videoTrack = id(3), audioTrack = id(4), timelineId = id(5);
  const shots = 500, auxiliary = 1000, cues = 500;
  const shotIds = Array.from({length: shots}, (_, index) => id(1000 + index));
  const mainClipIds = Array.from({length: shots}, (_, index) => id(3000 + index));
  const groups = Array.from({length: shots}, (_, index) => id(5000 + index));
  const targetShot = shotIds[250]!;
  const assetA = id(7), assetB = id(8), versionA = id(9), versionB = id(10), jobA = id(11), jobB = id(12);
  const timeline = {
    id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: shots * 60,
    createdAt: at, updatedAt: at, mainTrack: {trackId: videoTrack, sequenceNodeId: rootNode},
    tracks: [{id: videoTrack, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: audioTrack, name: 'A1', kind: 'audio', orderIndex: 1, hidden: false, muted: false}],
    clips: [
      ...shotIds.map((shotId, index) => ({id: mainClipIds[index]!, trackId: videoTrack, name: `Shot ${index}`,
        startFrame: index * 60, durationFrames: 60, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
        sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: shotId, segmentGroupId: groups[index]!, versionMode: 'follow'}})),
      ...Array.from({length: auxiliary}, (_, index) => ({id: id(8000 + index), trackId: audioTrack, name: `Audio ${index}`,
        startFrame: index * 30, durationFrames: 30, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280},
        gain: 0.5, assetId: id(6), sourceState: 'ready',
        anchor: {clipId: mainClipIds[Math.floor(index / 2)]!, offsetFrames: (index % 2) * 30}})),
    ],
    subtitles: {profileId: 'bottom_cjk_v1', cues: Array.from({length: cues}, (_, index) => {
      const owner = Math.min(shots - 1, Math.floor(index * 40 / 60));
      return {id: id(9000 + index), text: `Cue ${index}`, startFrame: index * 40, durationFrames: 30,
        anchor: {clipId: mainClipIds[owner]!, offsetFrames: index * 40 - owner * 60}};
    })},
  };
  const baseline = {version: 1,
    board: shotIds.map(shotId => ({nodeId: shotId, kind: 'shot', selectedVersionId: null})),
    track: mainClipIds.map((clipId, index) => ({nodeId: shotIds[index]!, segmentGroupId: groups[index]!, clipId,
      kind: 'shot', versionMode: 'follow', appliedVersionId: null}))};
  const builtAt = Date.now();
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic K1', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: id(6), projectId, mimeType: 'audio/wav', duration: 1200, sha256: sha('d')});
    store.put('assets', {id: assetA, projectId, mimeType: 'video/mp4', duration: 2, sha256: sha('a')});
    store.put('assets', {id: assetB, projectId, mimeType: 'video/mp4', duration: 3, sha256: sha('b')});
    for (const shotId of shotIds) store.put('shots', {id: shotId, projectId, orderIndex: 0, selectedVersionId: null, duration: 2, createdAt: at, updatedAt: at});
    store.put('versions', {id: versionA, projectId, jobId: jobA, shotId: targetShot, number: 1, assetId: assetA, sha256: sha('a'), createdAt: at});
    store.put('versions', {id: versionB, projectId, jobId: jobB, shotId: targetShot, number: 2, assetId: assetB, sha256: sha('b'), createdAt: at});
    store.put('nodes', {id: rootNode, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    const edges: {id: string; projectId: string; kind: 'sequence'; source: string; target: string; createdAt: string}[] = [];
    let source = rootNode;
    for (const [index, shotId] of shotIds.entries()) {
      edges.push({id: id(10000 + index), projectId, kind: 'sequence', source, target: shotId, createdAt: at});
      source = shotId;
    }
    for (const edge of edges) store.put('edges', edge);
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootNode, 1, JSON.stringify(baseline));
  });
  const buildMs = Date.now() - builtAt;
  const editing = createSequenceEditing(store);
  // Linux CI gates the deterministic transaction body; native COMMIT is a
  // separate diagnostic there (shared-runner fsync spikes). macOS also gates
  // total end-to-end latency, which is what a local user feels.
  const timings: number[] = [], codePaths: number[] = [], commits: number[] = [];
  const sourceFrames = (versionId: string): number => versionId === versionA ? 60 : 90;
  for (let iteration = 0; iteration < 35; iteration++) {
    const versionId = iteration % 2 === 0 ? versionA : versionB;
    const state = prepareSequenceEditHistory(store).state;
    const context = readSequenceEditContext(store);
    const envelope: SequenceEditEnvelope = {
      contractVersion: 1, projectId, epoch: state.epoch, actionId: randomUUID(),
      requestId: `k1-sequence-${iteration}-${Date.now()}`, originSide: 'board', filmId: rootNode,
      intents: [{side: 'board', operation: {kind: 'board-version', nodeId: targetShot,
        version: {id: versionId, sourceFrames: sourceFrames(versionId)}}}],
      baseline: {contentRevision: readProjectContentStamp(store.db).contentSequence,
        timelineRevision: context.timeline.revision, syncRevision: context.syncRevision,
        historyPosition: state.position, historyRevision: state.revision, targets: []},
      impact: {nodeIds: [targetShot], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []},
      allocation: {clips: [], nodes: [], splitClips: [], edges: []},
    };
    const measured = measureCommittedCall(store, () => editing.call('sequence.edit', envelope) as {status?: string});
    assert.equal(measured.commits, 1, `board version iteration ${iteration} committed ${measured.commits} times`);
    timings.push(measured.totalMs);
    codePaths.push(measured.codePathMs);
    commits.push(measured.commitMs);
    assert.equal(measured.value.status, 'applied', `board version iteration ${iteration} did not apply`);
  }
  const total = summarizeTiming(timings.slice(5)), codePath = summarizeTiming(codePaths.slice(5)),
    commit = summarizeTiming(commits.slice(5));
  console.log(JSON.stringify({benchmark: 'sequence-edit', shots, mainClips: shots, auxiliaryClips: auxiliary,
    cues, buildMs, ...total, codePath, commit}));
  assert.ok(buildMs < 180_000, `fixture build took ${buildMs}ms`);
  const file = 'tests/sequence-edit-performance.test.ts', budget = process.platform === 'linux' ? 200 : 100;
  const singleMax = process.platform === 'linux' ? 400 : 200;
  checkPerformanceBudget({file, name: 'K1 code path p95', actual: codePath.p95, budget, unit: 'ms'});
  checkPerformanceBudget({file, name: 'K1 code path max', actual: codePath.max, budget: singleMax, unit: 'ms'});
  if (process.platform !== 'linux') {
    checkPerformanceBudget({file, name: 'K1 p95 including COMMIT', actual: total.p95, budget, unit: 'ms'});
    checkPerformanceBudget({file, name: 'K1 max including COMMIT', actual: total.max, budget: singleMax, unit: 'ms'});
  }
}));
