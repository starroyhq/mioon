import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir, cpus} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {FORMAT5_LIMITS} from '../packages/contracts/src/project-format5.ts';
import type {Format5Clip, Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import {
  applyFormat5TimelineEntityUpdateInside, bumpFormat5ContentStampInside, planFormat5TimelineEntityUpdate,
  readFormat5TimelineState, readFormat5TimelineStateForIds,
} from '../packages/business/src/project-file/format5-timeline.ts';
import {TIMELINE_SUBTITLE_PROFILE_ID} from '../packages/contracts/src/timeline-subtitle-profile.ts';
import {checkPerformanceBudget} from './helpers/performance-budget.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const round = (number: number): number => Number(number.toFixed(3));
const modes = ['single', 'batch', 'array-reorder'] as const;
type Mode = typeof modes[number];
function fixture(total: number): Format5Timeline {
  const mainCount = Math.min(total, FORMAT5_LIMITS.mainTrackClips);
  const tracks = [
    {id: id(2), name: 'V1', kind: 'video' as const, orderIndex: 0, hidden: false, muted: false},
    {id: id(3), name: 'A1', kind: 'audio' as const, orderIndex: 1, hidden: false, muted: false},
    {id: id(4), name: 'A2', kind: 'audio' as const, orderIndex: 2, hidden: false, muted: false},
  ];
  const main: Format5Clip[] = Array.from({length: mainCount}, (_, index) => ({
    id: id(10000 + index), trackId: tracks[0]!.id, name: `Placeholder ${index + 1}`,
    startFrame: index * 600, durationFrames: 600, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: .5,
    assetId: null, versionId: null, jobId: null, shotId: id(20000 + index), sourceState: 'placeholder',
    sequenceSource: {kind: 'shot', nodeId: id(20000 + index), segmentGroupId: id(30000 + index), versionMode: 'follow'},
  }));
  const other: Format5Clip[] = Array.from({length: total - mainCount}, (_, index) => {
    const owner = main[index % mainCount]!, lane = Math.floor(index / mainCount) + 1;
    return {id: id(40000 + index), trackId: tracks[lane]!.id, name: `Sound ${index + 1}`,
      startFrame: owner.startFrame + lane, durationFrames: 2, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: .5,
      assetId: id(6), sourceState: 'ready', anchor: {clipId: owner.id, offsetFrames: lane}};
  });
  return {id: id(5), projectId: id(1), revision: 1, width: 720, height: 1280, fps: 30,
    durationFrames: mainCount * 600, createdAt: at, updatedAt: at,
    mainTrack: {trackId: tracks[0]!.id, sequenceNodeId: id(7)}, tracks, clips: [...main, ...other],
    subtitles: {profileId: TIMELINE_SUBTITLE_PROFILE_ID,
      cues: Array.from({length: Math.min(FORMAT5_LIMITS.subtitleCues, mainCount * 2)}, (_, index) => {
        const owner = main[Math.floor(index / 2)]!, offsetFrames = index % 2 * 30;
        return {id: id(50000 + index), text: `Caption ${index + 1}`, startFrame: owner.startFrame + offsetFrames,
          durationFrames: 20, anchor: {clipId: owner.id, offsetFrames}};
      })}};
}
function targetRevision(store: ProjectStore, targetId: string, kind = 'timeline_clip'): number {
  return Number(store.db.prepare('SELECT revision FROM project.agent_task_target_revisions_v2 WHERE projectId=? AND kind=? AND targetId=?').get(store.projectId, kind, targetId)?.revision);
}
function sample(store: ProjectStore, mode: Mode, committed: () => {milliseconds: number; count: number}) {
  const first = id(10000), last = id(10001), cue = id(50000);
  const before = [targetRevision(store, first), targetRevision(store, last), targetRevision(store, cue, 'timeline_subtitle')];
  const changes = Number(store.db.prepare('SELECT total_changes() AS n').get()!.n);
  let readMs = 0, validateMs = 0, writeMs = 0, bytes = 0, beginMs = 0, commitStarted = 0;
  const beforeCommit = committed();
  const started = performance.now();
  store.tx(() => {
    let step = performance.now(); beginMs = step - started;
    // A single-clip edit reads only the one affected row; batch and reorder
    // enumeration read the full row set they intend to compare.
    const state = mode === 'single'
      ? readFormat5TimelineStateForIds(store.db, 'project', {clipIds: [first]})
      : readFormat5TimelineState(store.db, 'project');
    bytes = (state.header ? Buffer.byteLength(state.header.raw) : 0)
      + state.clips.reduce((sum, row) => sum + Buffer.byteLength(row.raw), 0)
      + state.cues.reduce((sum, row) => sum + Buffer.byteLength(row.raw), 0);
    readMs = performance.now() - step;
    step = performance.now();
    const flip = (clip: Format5Clip): Format5Clip => ({...clip, gain: clip.gain === .5 ? .75 : .5});
    const patch = mode === 'single'
      ? {clips: [flip(JSON.parse(state.clips[0]!.raw) as Format5Clip)]}
      : mode === 'batch'
        ? {clips: state.clips.map(row => flip(JSON.parse(row.raw) as Format5Clip))}
        : {clips: [...state.clips].reverse().map(row => JSON.parse(row.raw) as Format5Clip)};
    const plan = planFormat5TimelineEntityUpdate(state, patch);
    validateMs = performance.now() - step;
    step = performance.now();
    if (plan.changed) applyFormat5TimelineEntityUpdateInside(store.db, 'project', plan);
    if (plan.changed) bumpFormat5ContentStampInside(store.db, 'project');
    writeMs = performance.now() - step;
    commitStarted = performance.now();
  });
  const finished = performance.now(), totalMs = finished - started, afterCommit = committed();
  const commitMs = afterCommit.milliseconds - beforeCommit.milliseconds;
  assert.equal(afterCommit.count - beforeCommit.count, 1, 'each sample measures one real COMMIT');
  const terminalFenceMs = Math.max(0, finished - commitStarted - commitMs);
  const after = [targetRevision(store, first), targetRevision(store, last), targetRevision(store, cue, 'timeline_subtitle')];
  const expectedDelta = mode === 'batch' ? [1, 1, 0] : mode === 'single' ? [1, 0, 0] : [0, 0, 0];
  assert.deepEqual(after, before.map((value, index) => value + expectedDelta[index]!));
  // The phases must tile the measured transaction. `unattributedMs` is the
  // part no phase claims: a growing value means new work (record assembly, GC,
  // response serialization…) slipped in without a timer. The failing 1,500-clip
  // samples showed no such gap; their tail sat in `commitMs` (fsync), so keep
  // this number diagnostic instead of hiding it in the total.
  const attributedMs = beginMs + readMs + validateMs + writeMs + terminalFenceMs + commitMs;
  // Linux CI only gates the deterministic code path; the native COMMIT below is
  // a diagnostic there (shared-runner fsync can spike). macOS also gates total,
  // because that is the latency a user on APFS actually feels.
  const codePathMs = beginMs + readMs + validateMs + writeMs + terminalFenceMs;
  return {totalMs, readMs, validateMs, writeMs, beginMs, terminalFenceMs, commitMs, attributedMs,
    unattributedMs: totalMs - attributedMs, codePathMs,
    changedRows: Number(store.db.prepare('SELECT total_changes() AS n').get()!.n) - changes, bytes};
}
function distribution(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {p50: round(sorted[Math.floor(sorted.length * .5)]!), p95: round(sorted[Math.ceil(sorted.length * .95) - 1]!), max: round(sorted.at(-1)!)};
}

for (const total of [100, 500, 1500]) test(`format 5 persisted K1 row-editing budget with ${total} clips`, t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-format5-performance-'));
  const options = {projectId: id(1), projectFile: path.join(root, 'project.mioon'), targetFormat: 5 as const,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})};
  let store = createProjectStore(options);
  try {
    const timeline = fixture(total);
    store.tx(() => {
      store.put('projects', {id: options.projectId, name: 'Synthetic budget', createdAt: at, updatedAt: at, revision: 1});
      store.put('nodes', {id: id(7), projectId: options.projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
      store.put('assets', {id: id(6), projectId: options.projectId, mimeType: 'audio/wav', duration: 1, sha256: 'a'.repeat(64)});
      const main = timeline.clips.filter(clip => clip.sequenceSource);
      for (const [index, clip] of main.entries()) {
        store.put('shots', {id: clip.shotId!, projectId: options.projectId, name: clip.name, orderIndex: index, duration: 20, selectedVersionId: null, createdAt: at, updatedAt: at});
        store.put('edges', {id: id(60000 + index), projectId: options.projectId, kind: 'sequence',
          source: index === 0 ? id(7) : main[index - 1]!.sequenceSource!.nodeId,
          target: clip.sequenceSource!.nodeId, createdAt: at});
      }
      store.put('timelines', timeline);
      const baseline = {version: 1,
        board: main.map(clip => ({nodeId: clip.sequenceSource!.nodeId, kind: 'shot', selectedVersionId: null})),
        track: main.map(clip => ({nodeId: clip.sequenceSource!.nodeId, segmentGroupId: clip.sequenceSource!.segmentGroupId,
          clipId: clip.id, kind: 'shot', versionMode: 'follow', appliedVersionId: null}))};
      store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
        .run(timeline.id, options.projectId, id(7), 1, JSON.stringify(baseline));
    });
    store.close();
    // Measure the persisted project's connection reopen. Fixture creation has
    // already loaded the modules and initialized SQLite for this process.
    const opening = performance.now();
    store = openProjectStore(options);
    const coldOpenMs = performance.now() - opening;
    let committedMs = 0, commits = 0;
    const nativeExec = store.db.exec.bind(store.db);
    // Observe the exact owned connection without changing SQL or its order.
    // Final-state validation runs before this separately timed disk COMMIT.
    t.mock.method(store.db, 'exec', (sql: string) => {
      if (sql !== 'COMMIT') return nativeExec(sql);
      const started = performance.now();
      try {return nativeExec(sql);}
      finally {committedMs += performance.now() - started; commits++;}
    });
    const committed = () => ({milliseconds: committedMs, count: commits});
    const firstEdit = sample(store, 'single', committed), results = [];
    for (const mode of modes) {
      for (let iteration = 0; iteration < 5; iteration++) sample(store, mode, committed);
      const samples = Array.from({length: 30}, () => sample(store, mode, committed));
      const result = {mode, samples: samples.length,
        totalMs: distribution(samples.map(sample => sample.totalMs)), readMs: distribution(samples.map(sample => sample.readMs)),
        validateMs: distribution(samples.map(sample => sample.validateMs)), writeMs: distribution(samples.map(sample => sample.writeMs)),
        beginMs: distribution(samples.map(sample => sample.beginMs)), terminalFenceMs: distribution(samples.map(sample => sample.terminalFenceMs)), commitMs: distribution(samples.map(sample => sample.commitMs)),
        attributedMs: distribution(samples.map(sample => sample.attributedMs)),
        unattributedMs: distribution(samples.map(sample => sample.unattributedMs)),
        codePathMs: distribution(samples.map(sample => sample.codePathMs)),
        changedRows: distribution(samples.map(sample => sample.changedRows)), timelineBytes: samples[0]!.bytes};
      results.push(result);
    }
    t.diagnostic(JSON.stringify({scope: 'kernel-timeline-native-rows-with-terminal-fence', platform: process.platform, arch: process.arch,
      cpu: cpus()[0]?.model, sqlite: store.db.prepare('SELECT sqlite_version() AS version').get()!.version,
      journal: store.db.prepare('PRAGMA project.journal_mode').get()!.journal_mode,
      synchronous: store.db.prepare('PRAGMA project.synchronous').get()!.synchronous,
      totalClips: total, mainClips: Math.min(total, FORMAT5_LIMITS.mainTrackClips), subtitleCues: timeline.subtitles!.cues.length,
      coldOpenMs: round(coldOpenMs),
      firstEdit: Object.fromEntries(Object.entries(firstEdit).map(([key, value]) => [key, round(value)])), results,
      peakProcessRssMiB: round(process.resourceUsage().maxRSS / 1024)}));
    const linux = process.platform === 'linux', file = 'tests/project-format5-performance.test.ts', limit = (value: number) => linux ? value * 2 : value;
    checkPerformanceBudget({file, name: `cold open with ${total} clips`, actual: coldOpenMs, budget: limit(200), unit: 'ms'});
    // Like the steady-state samples, the first edit reports native COMMIT
    // separately on shared Linux runners and gates end-to-end time on macOS.
    checkPerformanceBudget({file, name: `first edit with ${total} clips`,
      actual: linux ? firstEdit.codePathMs : firstEdit.totalMs, budget: limit(200), unit: 'ms'});
    for (const result of results) {
      // The measured phases must explain the transaction median. A large
      // residual is the signal to add a timer, not noise to retry away.
      assert.ok(Math.abs(result.unattributedMs.p50) <= 5, JSON.stringify(result));
      checkPerformanceBudget({file, name: `code path p95 with ${total} clips`, actual: result.codePathMs.p95, budget: limit(100), unit: 'ms'});
      checkPerformanceBudget({file, name: `code path max with ${total} clips`, actual: result.codePathMs.max, budget: limit(200), unit: 'ms'});
      if (!linux) {
        // The macOS developer run keeps the end-to-end assertion including COMMIT.
        checkPerformanceBudget({file, name: `total p95 with ${total} clips`, actual: result.totalMs.p95, budget: 100, unit: 'ms'});
        checkPerformanceBudget({file, name: `total max with ${total} clips`, actual: result.totalMs.max, budget: 200, unit: 'ms'});
      }
    }
  } finally {store.close(); rmSync(root, {recursive: true, force: true});}
});
