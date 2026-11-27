/** Run with node --test scripts/write-perf-study/history.ts in an isolated HOME and TMPDIR. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createChainWorld} from '../../tests/helpers/sequence-edit-double.ts';
import {createFormat5SequenceEditService} from '../../packages/business/src/format5-sequence-edit-service.ts';
import {readFormat5TimelineRecord} from '../../packages/business/src/project-file/format5-timeline.ts';
import {readSequenceEditHistoryEntry} from '../../packages/business/src/format5-editor-history.ts';
import {applyMioSequenceUndo, prepareMioSequenceUndo} from '../../packages/business/src/format5-mio-sequence.ts';
import {readSequenceEditHistory} from '../../packages/business/src/sequence-edit.ts';
import type {SequenceEditAllocation, SequenceEditEnvelope, SequenceEditIntent, SequenceEditReceipt} from '../../packages/contracts/src/sequence-edit.ts';
import type {Format5Timeline} from '../../packages/contracts/src/project-format5.ts';
import {analyzeHistory} from './history-codec.ts';
import type {LiveTimedRows} from './history-codec.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `12345678-0000-4000-8000-${String(number).padStart(12, '0')}`;
const frame = {x: 0, y: 0, width: 720, height: 1280};
const assetMode = process.env.MIOON_HISTORY_ASSETS ?? 'ready';
assert.ok(assetMode === 'ready' || assetMode === 'placeholders');

function createWorld(t: test.TestContext, count: number, dense: boolean, withCues = true) {
  const rootId = id(1), audioId = id(3), assetId = id(4), imageId = id(5), imageAssetId = id(6);
  const shots = Array.from({length: count}, (_, index) => ({id: id(1000 + index), title: `Synthetic shot ${index}`,
    versionId: assetMode === 'ready' ? id(2000 + index) : null}));
  const clips = shots.map((shot, index) => ({nodeId: shot.id, clipId: id(3000 + index), startFrame: index * 60,
    durationFrames: 60, versionId: shot.versionId}));
  const world = createChainWorld(t, {rootId, shots, clips, edges: shots.map((shot, index) =>
    ({id: id(4000 + index), fromId: index === 0 ? rootId : shots[index - 1]!.id, toId: shot.id})),
  versions: shots.flatMap((shot, index) => shot.versionId ? [{versionId: shot.versionId, assetId: id(5000 + index),
    sha256: 'a'.repeat(64), durationSeconds: 4, hasAudio: true}] : [])});
  const {projectId, store} = world;
  const anchorCount = dense ? 2 : 0;
  const audioTrack = {id: audioId, name: 'A1', kind: 'audio' as const, orderIndex: 1, hidden: false, muted: false};
  // Leave the last clip free for a tail removal/split without breaking anchors.
  const auxiliary = clips.slice(0, -1).flatMap((clip, index) => Array.from({length: anchorCount}, (_, lane) => {
    const offsetFrames = 7 + lane * 10;
    return {id: id(6000 + 2 * index + lane), trackId: audioId, name: `Synthetic audio ${index}.${lane}`,
      startFrame: clip.startFrame + offsetFrames, durationFrames: 4, sourceInFrame: 0, rect: frame,
      gain: 1, assetId, sourceState: 'ready' as const, anchor: {clipId: clip.clipId, offsetFrames}};
  }));
  const cues = clips.slice(0, -1).filter((_clip, index) => withCues && (dense || index % 8 === 0)).map((clip, index) => ({
    id: id(8000 + index), text: `合成字幕 ${index}`, startFrame: clip.startFrame + 42, durationFrames: 4,
    anchor: {clipId: clip.clipId, offsetFrames: 42},
  }));
  store.tx(() => {
    store.put('assets', {id: assetId, projectId, mimeType: 'audio/wav', duration: 1200, sha256: 'b'.repeat(64)});
    store.put('assets', {id: imageAssetId, projectId, mimeType: 'image/png', duration: null, sha256: 'c'.repeat(64)});
    store.put('nodes', {id: imageId, projectId, type: 'image', name: 'Synthetic still', assetId: imageAssetId, position: {x: 0, y: 0}, createdAt: at});
    const timeline: Format5Timeline = {...world.timeline,
      tracks: [...world.timeline.tracks, audioTrack], clips: [...world.timeline.clips, ...auxiliary],
      subtitles: {profileId: 'bottom_cjk_v1', cues}};
    store.put('timelines', timeline);
  });
  return {...world, shots, clips, cues, imageId, audioId, auxiliary};
}
type World = ReturnType<typeof createWorld>;
type PlannedEdit = Partial<Pick<SequenceEditEnvelope, 'intents' | 'propertiesIntent' | 'subtitlesIntent' | 'trackIntent' | 'formatIntent'>>
  & {allocation?: Partial<SequenceEditAllocation>};
type BoardEdit = Extract<SequenceEditIntent['operation'], {kind: 'board'}>['edit'];
type TrackEdit = Extract<SequenceEditIntent['operation'], {kind: 'track'}>['edit'];
const board = (edit: BoardEdit, allocation?: Partial<SequenceEditAllocation>): PlannedEdit =>
  ({intents: [{side: 'board', operation: {kind: 'board', edit}}], ...(allocation ? {allocation} : {})});
const layout = (shotIds: string[], sample: number): PlannedEdit => ({intents: [{side: 'board', operation: {
  kind: 'board.layout.move', moves: shotIds.map((nodeId, index) => ({nodeId, x: index + sample + 10, y: -20 - sample})),
}}]});
const track = (edit: TrackEdit): PlannedEdit => ({intents: [{side: 'timeline', operation: {kind: 'track', edit}}]});
const gains = (clips: readonly {clipId: string}[]): PlannedEdit => ({propertiesIntent: {side: 'timeline',
  operation: {kind: 'clip-properties', edits: clips.map(({clipId}) => ({clipId, patch: {gain: 0.66}}))}}});
const actions = {
  'board-move-one': (w: World, sample: number, index: number) => layout([w.shots[index]!.id], sample),
  'board-move-all': (w: World, sample: number) => layout(w.shots.map(shot => shot.id), sample),
  'clip-gain-one': (w: World, _sample: number, index: number) => gains([w.clips[index]!]),
  'clip-gain-24': (w: World, _sample: number, index: number) => {
    const start = Math.min(index, w.clips.length - 24);
    return gains(w.clips.slice(start, start + 24));
  },
  'cue-text': (w: World, sample: number, index: number) => ({subtitlesIntent: {side: 'timeline',
    operation: {kind: 'subtitles', edits: [{kind: 'update', cueId: w.cues[index % w.cues.length]!.id,
      patch: {text: `合成测试字幕 ${sample}。用于测量 UTF-8。`}}]}}}),
  'track-mute': (w: World) => ({trackIntent: {side: 'timeline',
    operation: {kind: 'track-structure', edit: {kind: 'update', trackId: w.audioId, patch: {muted: true}}}}}),
  'format-change': () => ({formatIntent: {side: 'timeline', operation: {kind: 'timeline-format', presetId: 'landscape_720'}}}),
  'track-trim-tail': (w: World) => track({kind: 'trim', clipId: w.clips.at(-1)!.clipId, durationFrames: 56}),
  'track-trim-spread': (w: World, _sample: number, index: number) => track({kind: 'trim',
    clipId: w.clips[index]!.clipId, durationFrames: 56}),
  'track-split-tail': (w: World) => track({kind: 'split', clipId: w.clips.at(-1)!.clipId,
    offsetFrames: 30, rightClipId: randomUUID()}),
  'track-remove-tail': (w: World) => track({kind: 'remove', clipId: w.clips.at(-1)!.clipId}),
  'track-add-tail': (w: World) => track({kind: 'add', beforeClipId: null, nodeKind: 'image',
    clip: {id: randomUUID(), nodeId: w.imageId, splitGroupId: randomUUID(),
      startFrame: 0, durationFrames: 30, sourceInFrame: 0, versionId: null, versionLocked: false}}),
  'board-disconnect': (w: World, _sample: number, index: number) => board({kind: 'disconnect',
    fromId: w.shots[Math.max(1, index) - 1]!.id, toId: w.shots[Math.max(1, index)]!.id}),
  'board-delete-reattach': (w: World, _sample: number, index: number) => {
    const middle = Math.max(1, Math.min(index, w.shots.length - 2));
    return board({kind: 'delete', nodeId: w.shots[middle]!.id}, {edges: [{id: randomUUID(),
      fromId: w.shots[middle - 1]!.id, toId: w.shots[middle + 1]!.id}]});
  },
  'board-insert-head': (w: World, _sample: number, index: number) => {
    const position = Math.max(1, index);
    const selected = w.shots[position]!.id, first = w.shots[0]!.id;
    const unchangedSuccessor = w.shots[position + 1];
    const bridge = unchangedSuccessor ? [{id: randomUUID(), fromId: w.shots[position - 1]!.id,
      toId: unchangedSuccessor.id}] : [];
    return board({kind: 'insert', fromId: w.rootId, toId: first, nodeId: selected}, {
      edges: [{id: randomUUID(), fromId: w.rootId, toId: selected}, {id: randomUUID(), fromId: selected, toId: first}, ...bridge],
    });
  },
  'board-tail-to-head': (w: World) => {
    const selected = w.shots.at(-1)!.id, first = w.shots[0]!.id;
    return board({kind: 'insert', fromId: w.rootId, toId: first, nodeId: selected}, {
      edges: [{id: randomUUID(), fromId: w.rootId, toId: selected}, {id: randomUUID(), fromId: selected, toId: first}],
    });
  },
} satisfies Record<string, (world: World, sample: number, index: number) => PlannedEdit>;

function snapshot(world: World) {
  const timeline = readFormat5TimelineRecord(world.store.db, 'project');
  assert.ok(timeline);
  const {revision: _revision, updatedAt: _updatedAt, ...content} = timeline;
  const baseline = world.store.db.prepare('SELECT baseline FROM project.sequence_sync_state WHERE timelineId=?').get(world.timelineId)?.baseline;
  const position = world.store.db.prepare("SELECT id,json_extract(data,'$.position') AS pos FROM project.shots WHERE projectId=? AND archivedAt IS NULL ORDER BY id")
    .all(world.projectId);
  return {timeline: content, baseline: typeof baseline === 'string' ? JSON.parse(baseline) as unknown : null, position};
}
function checkUndo(world: World, service: ReturnType<typeof createFormat5SequenceEditService>,
  actionId: string, origin: 'user' | 'mio', before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>): void {
  const navigate = (direction: 'undo' | 'redo') => {
    const view = readSequenceEditHistory(world.store, origin);
    const requestId = randomUUID(), projectId = world.projectId;
    const receipt = direction === 'undo' && origin === 'mio'
      ? applyMioSequenceUndo(world.store, prepareMioSequenceUndo(world.store, projectId, requestId, actionId))
      : service[direction]({projectId, requestId, actionId, origin,
        expected: {position: view.position, revision: view.revision}}) as SequenceEditReceipt;
    assert.equal(receipt.status, 'applied');
  };
  navigate('undo');
  assert.deepEqual(snapshot(world), before, 'actual undo preserves content, baseline, and live positions');
  navigate('redo');
  assert.deepEqual(snapshot(world), after, 'actual redo preserves content, baseline, and live positions');
  navigate('undo');
}

function measure(world: World, edit: PlannedEdit, origin: 'user' | 'mio') {
  const {store, projectId} = world;
  const service = createFormat5SequenceEditService(store);
  const before = snapshot(world);
  const requestId = randomUUID();
  const review = service.preview({projectId, requestId, origin, ...edit});
  assert.ok('envelope' in review, JSON.stringify(review));
  const request = {projectId, envelope: review.envelope, expectedPlanDigest: review.planDigest};
  const committed = service.commit(request) as SequenceEditReceipt;
  assert.equal(committed.status, 'applied');
  const {actionId} = committed;
  const row = store.db.prepare(`SELECT origin,
    length(CAST(beforePatch AS BLOB))+length(CAST(afterPatch AS BLOB)) AS bytes
    FROM main.editor_history_entries WHERE actionId=? AND projectId=?`).get(actionId, projectId);
  assert.ok(row);
  assert.equal(row.origin, origin);
  const receipt = store.db.prepare('SELECT length(CAST(response AS BLOB)) AS bytes FROM main.editor_requests WHERE requestId=?').get(requestId);
  assert.ok(receipt);
  assert.deepEqual(service.commit(request), committed, 'identical request replays its receipt');
  const after = snapshot(world);
  const entry = readSequenceEditHistoryEntry(store, actionId);
  assert.ok(entry);
  const studyStarted = performance.now();
  const timedRows = (timeline: Pick<Format5Timeline, 'clips' | 'subtitles'>): LiveTimedRows =>
    ({clips: timeline.clips, cues: timeline.subtitles?.cues ?? []});
  const encoding = analyzeHistory([entry.beforePatch, entry.afterPatch], [timedRows(before.timeline), timedRows(after.timeline)]);
  const studyMs = performance.now() - studyStarted;
  checkUndo(world, service, actionId, origin, before, after);
  return {persistedBytes: Number(row.bytes), receiptBytes: Number(receipt.bytes), studyMs, ...encoding};
}
type Sample = ReturnType<typeof measure>;
function summarize(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b), n = ordered.length;
  assert.ok(n > 0);
  return {min: ordered[0], p50: ordered[Math.ceil(n / 2) - 1], p95: ordered[Math.ceil(n * .95) - 1],
    max: ordered.at(-1), mean: Math.round(values.reduce((sum, value) => sum + value, 0) / n)};
}
const sizes = (process.env.MIOON_HISTORY_SIZES ?? '40,499').split(',').map(Number);
assert.ok(sizes.length > 0 && sizes.every(value => Number.isSafeInteger(value) && value >= 24 && value <= 499));
const sampleCount = Number(process.env.MIOON_HISTORY_SAMPLES ?? 5);
assert.ok(Number.isSafeInteger(sampleCount) && sampleCount >= 2 && sampleCount <= 20);
const selected = process.env.MIOON_HISTORY_ACTIONS?.split(',') ?? Object.keys(actions);
assert.ok(selected.length > 0 && selected.every(action => Object.hasOwn(actions, action)));
const denseMode = process.env.MIOON_HISTORY_DENSITY;
assert.ok(denseMode === undefined || denseMode === 'dense' || denseMode === 'plain');
for (const size of sizes) test(`stored format 5 undo history, ${size} main-track clips`, t => {
  const dense = denseMode !== undefined ? denseMode === 'dense' : size > 40;
  const world = createWorld(t, size, dense);
  const unanchored = selected.some(action => action === 'board-disconnect' || action === 'board-delete-reattach')
    ? createWorld(t, size, false, false) : null;
  const results = new Map<string, Sample[]>();
  for (const action of selected) {
    const build = actions[action as keyof typeof actions];
    const actionWorld = action === 'board-disconnect' || action === 'board-delete-reattach' ? unanchored! : world;
    const entries: Sample[] = [];
    for (let sample = 0; sample < sampleCount; ++sample) {
      const index = Math.round(sample * (size - 1) / (sampleCount - 1));
      const origin = sample % 2 === 0 ? 'user' : 'mio';
      try { entries.push(measure(actionWorld, build(actionWorld, sample, index), origin)); }
      catch (error) {
        const detail = error instanceof Error && 'details' in error ? JSON.stringify(error.details) : '';
        throw new Error(`${action} sample ${sample}: ${String(error)} ${detail}`, {cause: error});
      }
    }
    results.set(action, entries);
  }
  // Report payload bytes separately from SQLite page sizes and sidecar storage.
  const summarizeSamples = (samples: Sample[]) => ({
    n: samples.length, current: summarize(samples.map(sample => sample.persistedBytes)),
    field: summarize(samples.map(sample => sample.fieldBytes)),
    fieldRange: summarize(samples.map(sample => sample.fieldRangeBytes)),
    rangeBaseline: summarize(samples.map(sample => sample.rangeBaselineBytes)),
    baseline: summarize(samples.map(sample => sample.baselineStoredBytes)),
    rangeRows: summarize(samples.map(sample => sample.rangeRows)),
    rangeCount: summarize(samples.map(sample => sample.rangeCount)),
    receipt: summarize(samples.map(sample => sample.receiptBytes)),
    prototypeMs: summarize(samples.map(sample => sample.studyMs)),
  });
  const historySchema = world.store.db.prepare('SELECT version FROM main.schema_version').get()?.version;
  const projectSchema = world.store.db.prepare('PRAGMA project.user_version').get()?.user_version;
  const attached = world.store.db.prepare('PRAGMA database_list').all().map(row =>
    ({schema: row.name, role: row.name === 'main' ? 'local history sidecar' : row.name === 'project' ? 'portable project file'
      : row.name === 'cache' ? 'derived cache' : 'temporary scratch'}));
  const baselineBytes = world.store.db.prepare('SELECT length(CAST(baseline AS BLOB)) AS bytes FROM project.sequence_sync_state WHERE timelineId=?')
    .get(world.timelineId)?.bytes;
  const trackTail = ['track-trim-tail', 'track-split-tail', 'track-remove-tail', 'track-add-tail'].flatMap(action => results.get(action) ?? []);
  console.log(JSON.stringify({kind: 'format5-write-history', projectSchema, historySchema, attached, mainClips: size,
    assetMode, auxiliaryClips: world.auxiliary.length, cues: world.cues.length, baselineBytes,
    unanchoredActions: selected.filter(action => action === 'board-disconnect' || action === 'board-delete-reattach'),
    actions: Object.fromEntries([...results].map(([action, samples]) => [action, summarizeSamples(samples)])),
    ...(trackTail.length ? {tailActionMix: summarizeSamples(trackTail)} : {}),
  }));
});
