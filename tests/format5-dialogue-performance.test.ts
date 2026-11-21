import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {previewDialogueAction, runDialogueAction} from '../packages/business/src/format5-dialogue.ts';
import {withK1BenchmarkLock} from './helpers/k1-benchmark-lock.ts';
import {measureCommittedCall, summarizeTiming} from './helpers/commit-timing.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `70000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sha = (letter: string): string => letter.repeat(64);

/** K1 acceptance shape for the dialogue edit transaction: 500 shots each with a
 * dialogue line projected to a real cue, 500 main-track segments and 1,000
 * anchored clips. The measured call is the shared transaction only (receipt
 * replay, revision checks, timeline read, planning, one shot row + one cue row,
 * the terminal fence and COMMIT); preview is the separate read-only step a real
 * caller runs before confirming. Budget matches the plan §8 K1 sync budget:
 * p95 <=100 ms on this Mac, Linux CI gates the transaction body p95 <=200 ms. */
test('K1 500 shots / 500 dialogue cues edit meets the local p95 budget', t => withK1BenchmarkLock(() => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-dialogue-perf-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(root, 'project.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const projectId = store.projectId;
  const rootNode = id(2), videoTrack = id(3), audioTrack = id(4), timelineId = id(5);
  const shots = 500, auxiliary = 1000;
  const shotIds = Array.from({length: shots}, (_, index) => id(1000 + index));
  const lineIds = Array.from({length: shots}, (_, index) => id(2000 + index));
  const cueIds = Array.from({length: shots}, (_, index) => id(3000 + index));
  const clipIds = Array.from({length: shots}, (_, index) => id(4000 + index));
  const groups = Array.from({length: shots}, (_, index) => id(5000 + index));
  const targetShot = shotIds[250]!, targetLine = lineIds[250];
  const timeline = {
    id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: shots * 60,
    createdAt: at, updatedAt: at, mainTrack: {trackId: videoTrack, sequenceNodeId: rootNode},
    tracks: [{id: videoTrack, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: audioTrack, name: 'A1', kind: 'audio', orderIndex: 1, hidden: false, muted: false}],
    clips: [
      ...shotIds.map((shotId, index) => ({id: clipIds[index]!, trackId: videoTrack, name: `Shot ${index}`,
        startFrame: index * 60, durationFrames: 60, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
        sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: shotId, segmentGroupId: groups[index]!, versionMode: 'follow'}})),
      ...Array.from({length: auxiliary}, (_, index) => ({id: id(8000 + index), trackId: audioTrack, name: `Audio ${index}`,
        startFrame: index * 30, durationFrames: 30, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280},
        gain: 0.5, assetId: id(6), sourceState: 'ready',
        anchor: {clipId: clipIds[Math.floor(index / 2)]!, offsetFrames: (index % 2) * 30}})),
    ],
    subtitles: {profileId: 'bottom_cjk_v1', cues: shotIds.map((shotId, index) => ({
      id: cueIds[index]!, text: '样本', startFrame: index * 60, durationFrames: 60,
      anchor: {clipId: clipIds[index]!, offsetFrames: 0}, dialogueRef: {shotId, lineId: lineIds[index]!},
    }))},
  };
  const baseline = {version: 1,
    board: shotIds.map(shotId => ({nodeId: shotId, kind: 'shot', selectedVersionId: null})),
    track: clipIds.map((clipId, index) => ({nodeId: shotIds[index]!, segmentGroupId: groups[index]!, clipId,
      kind: 'shot', versionMode: 'follow', appliedVersionId: null}))};
  const builtAt = Date.now();
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic dialogue K1', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: id(6), projectId, mimeType: 'audio/wav', duration: 1200, sha256: sha('d')});
    for (const [index, shotId] of shotIds.entries()) {
      store.put('shots', {id: shotId, projectId, orderIndex: index, selectedVersionId: null, duration: 2,
        position: {x: 0, y: 0}, createdAt: at, updatedAt: at, dialogue: [{id: lineIds[index]!, text: '样本'}]});
    }
    store.put('nodes', {id: rootNode, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    let source = rootNode;
    for (const [index, shotId] of shotIds.entries()) {
      store.put('edges', {id: id(6000 + index), projectId, kind: 'sequence', source, target: shotId, createdAt: at});
      source = shotId;
    }
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootNode, 1, JSON.stringify(baseline));
  });
  const buildMs = Date.now() - builtAt;
  const timings: number[] = [], codePaths: number[] = [], commits: number[] = [];
  for (let iteration = 0; iteration < 35; iteration++) {
    const preview = previewDialogueAction(store, {requestId: `k1-dialogue-${iteration}-${Date.now()}`,
      origin: 'user', dialogueIntent: {side: 'board', operation: {kind: 'dialogue', edits: [
        {kind: 'update', shotId: targetShot, lineId: targetLine, text: iteration % 2 === 0 ? '改A' : '改B'},
      ]}}});
    assert.ok('envelope' in preview, 'preview must succeed');
    const measured = measureCommittedCall(store, () => runDialogueAction(store, preview.envelope));
    assert.equal(measured.commits, 1, `dialogue iteration ${iteration} committed ${measured.commits} times`);
    assert.ok(measured.value.ok, `dialogue iteration ${iteration} failed: ${'code' in measured.value ? measured.value.code : ''}`);
    timings.push(measured.totalMs);
    codePaths.push(measured.codePathMs);
    commits.push(measured.commitMs);
  }
  const total = summarizeTiming(timings.slice(5)), codePath = summarizeTiming(codePaths.slice(5)),
    commit = summarizeTiming(commits.slice(5));
  console.log(JSON.stringify({benchmark: 'format5-dialogue', shots, mainClips: shots, cues: shots,
    auxiliaryClips: auxiliary, buildMs, ...total, codePath, commit}));
  assert.ok(buildMs < 180_000, `fixture build took ${buildMs}ms`);
  const budget = process.platform === 'linux' ? 200 : 100;
  assert.ok(codePath.p95 <= budget, `K1 dialogue code path p95 ${codePath.p95.toFixed(1)}ms exceeds the ${budget}ms budget`);
  if (process.platform !== 'linux') assert.ok(total.p95 <= budget, `K1 dialogue p95 ${total.p95.toFixed(1)}ms exceeds the ${budget}ms budget`);
}));
