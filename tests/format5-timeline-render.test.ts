import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import {freezeFormat5RenderSnapshot, readFormat5RenderProjection} from '../packages/business/src/format5-timeline-render.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {isTimelineRenderRecord} from '../packages/contracts/src/timeline-acknowledgement.ts';
import {FORMAT5_TIMELINE_FORMAT, TIMELINE_RESPONSE_BYTES} from '../packages/contracts/src/timeline-replacement.ts';
import {TIMELINE_LIMITS} from '../packages/contracts/src/timeline-limits.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {createTimelineServices} from '../packages/business/src/timeline.ts';
import {createTimelinePreflightServices, timelineSnapshotHash} from '../packages/business/src/timeline-preflight.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';

const rootId = '10000000-0000-4000-8000-000000000001';
const shotA = '10000000-0000-4000-8000-000000000010';
const shotB = '10000000-0000-4000-8000-000000000011';
const clipA = '10000000-0000-4000-8000-000000000020';
const clipB = '10000000-0000-4000-8000-000000000021';
const versionA = '10000000-0000-4000-8000-000000000050';
const versionB = '10000000-0000-4000-8000-000000000051';
const assetA = '10000000-0000-4000-8000-000000000060';
const assetB = '10000000-0000-4000-8000-000000000061';
const cue = '10000000-0000-4000-8000-000000000070';

function fixture(t: test.TestContext) {
  const world = createChainWorld(t, {
    rootId,
    shots: [{id: shotA, title: 'A', versionId: versionA}, {id: shotB, title: 'B', versionId: versionB}],
    versions: [{versionId: versionA, assetId: assetA, sha256: 'a'.repeat(64), durationSeconds: 4, hasAudio: true},
      {versionId: versionB, assetId: assetB, sha256: 'b'.repeat(64), durationSeconds: 4}],
    clips: [{nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 60, versionId: versionA},
      {nodeId: shotB, clipId: clipB, startFrame: 60, durationFrames: 60, versionId: versionB}],
    edges: [{id: '10000000-0000-4000-8000-000000000030', fromId: rootId, toId: shotA},
      {id: '10000000-0000-4000-8000-000000000031', fromId: shotA, toId: shotB}],
  });
  const service = createFormat5SequenceEditService(world.store);
  // Synthetic chain assets need the project-file locator a real managed import
  // always carries before the owned media graph can export them.
  world.store.tx(() => {
    for (const [id, sha] of [[assetA, 'a'], [assetB, 'b']] as const) {
      const asset = JSON.parse(String((world.store.db.prepare('SELECT data FROM project.assets WHERE id=?').get(id) as {data: string}).data)) as Record<string, unknown>;
      world.store.put('assets', {...asset, sizeBytes: 1024, ...(id === assetA ? {hasAudio: true, hasVideo: true} : {}),
        reference: {pathForm: 'relative', path: 'media/source.mp4',
          volume: null, sizeBytes: 1024, mtimeMs: 0, sampledSha256: sha.repeat(64), fullSha256: sha.repeat(64)}});
    }
  });
  return {world, service};
}
function addCue(world: ReturnType<typeof fixture>['world'], service: ReturnType<typeof fixture>['service'], id: string) {
  const preview = service.preview({projectId: world.projectId, requestId: `render-cue-${id}`,
    subtitlesIntent: {side: 'timeline', operation: {kind: 'subtitles', edits: [{kind: 'add',
      cue: {id, text: 'Caption', startFrame: 10, durationFrames: 20}}]}}}) as {envelope: unknown; planDigest: string};
  assert.ok(preview.envelope);
  service.commit({projectId: world.projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
}

test('format-5 row projection freezes a renderer snapshot without mainTrack/subtitle anchors', (t) => {
  const {world, service} = fixture(t);
  addCue(world, service, cue);
  const timeline = readFormat5TimelineRecord(world.store.db, 'project')!;
  const projection = readFormat5RenderProjection(world.store);
  assert.ok(projection);
  assert.equal(projection.legacy.clips.length, 2);
  assert.equal(Object.hasOwn(projection.legacy, 'mainTrack'), false);
  assert.equal(Object.hasOwn(projection.legacy.clips[0]!, 'sequenceSource'), false);
  assert.equal(Object.hasOwn(projection.legacy.clips[0]!, 'sourceState'), false);
  assert.equal(Object.hasOwn(projection.legacy.subtitles!.cues[0]!, 'anchor'), false);
  assert.deepEqual(projection.legacy.subtitles!.cues.map(item => item.id), [cue]);
  const frozen = freezeFormat5RenderSnapshot(world.store, {expectedRevision: timeline.revision}) as {
    timeline: {id: string; revision: number; clips: unknown[]; subtitles?: unknown};
    assets: {id: string; sha256: string; mimeType: string}[];
  };
  assert.equal(frozen.timeline.id, timeline.id);
  assert.equal(frozen.timeline.revision, timeline.revision);
  assert.equal(frozen.timeline.clips.length, 2);
  assert.deepEqual(frozen.assets.map(asset => asset.id).sort(), [assetA, assetB].sort());
  assert.ok(frozen.assets.every(asset => asset.mimeType === 'video/mp4' && asset.sha256.length === 64));
  // The queued render record must satisfy the same frozen-snapshot contract as
  // a legacy render before the export pipeline sees it.
  const request = {projectId: world.projectId, requestId: 'render-projection-0001', expectedRevision: timeline.revision,
    purpose: 'preview' as const};
  const record = {id: '10000000-0000-4000-8000-000000000099', projectId: world.projectId, requestId: request.requestId,
    mode: 'timeline' as const, purpose: 'preview' as const, timelineRevision: timeline.revision, snapshot: frozen,
    status: 'queued' as const, assetId: null, url: null, error: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'};
  assert.equal(isTimelineRenderRecord(record, request), true);
});

test('timeline.render queues the projected format-5 snapshot on the real service transaction', (t) => {
  const {world, service} = fixture(t);
  addCue(world, service, cue);
  const timeline = readFormat5TimelineRecord(world.store.db, 'project')!;
  const timelineServices = createTimelineServices(world.store as never, {
    hash: (value: unknown) => timelineSnapshotHash(value), now: () => '2026-01-01T00:00:00.000Z',
    required: (table: never, id: string) => {const value = world.store.get(table, id); if (!value) throw new AppError('NOT_FOUND', 'Missing', 404); return value;},
    check: (value: {revision?: unknown}, revision?: unknown) => {
      if (value.revision !== revision) throw new AppError('REVISION_CONFLICT', 'Changed', 409);
    },
    beforeEffect: () => {},
  } as never);
  const request = {projectId: world.projectId, expectedRevision: timeline.revision,
    requestId: 'fr-b-render-live-0001', purpose: 'preview' as const};
  const response = timelineServices.handlers['timeline.render']!(request as never, {}) as
    {id: string; mode: string; snapshot: {timeline: {clips: unknown[]; subtitles?: {cues: unknown[]}}}};
  assert.equal(response.mode, 'timeline');
  assert.equal(response.snapshot.timeline.clips.length, 2);
  assert.equal(response.snapshot.timeline.subtitles!.cues.length, 1);
  const stored = world.store.get('exports', response.id) as {snapshot: unknown};
  assert.deepEqual(stored.snapshot, response.snapshot);
  // An exact retry returns the same immutable export receipt.
  const replay = timelineServices.handlers['timeline.render']!(request as never, {}) as {id: string};
  assert.equal(replay.id, response.id);
});

test('format-5 export blockers refuse to freeze instead of rendering a placeholder', (t) => {
  const {world} = fixture(t);
  world.store.tx(() => {
    world.store.put('assets', {id: '10000000-0000-4000-8000-000000000062', projectId: world.projectId,
      mimeType: 'video/mp4', duration: 1, sha256: 'c'.repeat(64), sizeBytes: 1024,
      reference: {pathForm: 'relative', path: 'media/short.mp4', volume: null, sizeBytes: 1024, mtimeMs: 0,
        sampledSha256: 'c'.repeat(64), fullSha256: 'c'.repeat(64)}});
    world.store.put('versions', {id: '10000000-0000-4000-8000-000000000052', projectId: world.projectId,
      jobId: '10000000-0000-4000-8000-000000000072', shotId: shotA, number: 2,
      assetId: '10000000-0000-4000-8000-000000000062', sha256: 'c'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z'});
    world.store.db.prepare("UPDATE project.shots SET data=json_set(data,'$.selectedVersionId',?) WHERE id=?")
      .run('10000000-0000-4000-8000-000000000052', shotA);
  });
  assert.throws(() => freezeFormat5RenderSnapshot(world.store),
    (error: {code?: string; details?: {blockers?: {code: string}[]}}) =>
      error.code === 'EXPORT_BLOCKED' && error.details?.blockers?.[0]?.code === 'VERSION_TOO_SHORT');
});

test('native export freezes exactly 300 clips and 54,000 frames and refuses either excess before probing', async (t) => {
  const {world: {store, projectId, timeline}} = fixture(t);
  const {maxClips, maxFrames} = TIMELINE_LIMITS;
  const trackId = randomUUID();
  const {rect} = timeline.clips[0]!;
  const framesPerClip = maxFrames / maxClips;
  const freeClip = {trackId, name: '镜'.repeat(200), assetId: assetA, sourceInFrame: 0, rect, gain: 1,
    sourceState: 'ready' as const, anchor: null, durationFrames: framesPerClip, fadeInFrames: 3, fadeOutFrames: 3};
  const clips = [...timeline.clips, ...Array.from({length: maxClips - timeline.clips.length}, (_, index) => ({
    ...freeClip, id: randomUUID(), startFrame: (index + timeline.clips.length) * framesPerClip,
  }))];
  const boundary = {...timeline, clips, durationFrames: maxFrames,
    tracks: [...timeline.tracks, {id: trackId, name: 'V2', kind: 'video' as const, orderIndex: 1, hidden: false, muted: false}]};
  store.tx(() => {
    const asset = store.get('assets', assetA) as Record<string, unknown>;
    store.put('assets', {...asset, duration: 7});
    store.put('timelines', boundary);
  });
  const request = {projectId, expectedRevision: timeline.revision, requestId: 'render-exact-limit-0001', purpose: 'export' as const};
  const frozen = freezeFormat5RenderSnapshot(store, request) as {timeline: {durationFrames: number; clips: unknown[]}};
  assert.equal(frozen.timeline.durationFrames, maxFrames);
  assert.equal(frozen.timeline.clips.length, maxClips);
  assert.ok(Buffer.byteLength(JSON.stringify(frozen.timeline)) > TIMELINE_RESPONSE_BYTES);
  const receipt = {id: randomUUID(), projectId, requestId: request.requestId, mode: 'timeline', purpose: request.purpose,
    timelineRevision: timeline.revision, snapshot: frozen, status: 'queued', assetId: null, url: null, error: null,
    createdAt: timeline.createdAt, updatedAt: timeline.updatedAt};
  assert.equal(isTimelineRenderRecord(receipt, request, {format: FORMAT5_TIMELINE_FORMAT}), true);
  assert.equal(isTimelineRenderRecord(receipt, request), false);

  const {handlers} = createTimelinePreflightServices(store, {probe: async () => assert.fail('over-limit export probed a source')});
  const selected = {...request, exportRange: {startFrame: 0, endFrame: 30}};
  const overBoundaries = [
    {...boundary, durationFrames: maxFrames + 1, clips: [...clips.slice(0, -1), {...clips.at(-1)!, durationFrames: framesPerClip + 1}]},
    {...boundary, clips: [...clips, {...freeClip, id: randomUUID(), startFrame: 120, durationFrames: 10}]},
  ];
  for (const overBoundary of overBoundaries) {
    store.tx(() => store.put('timelines', overBoundary));
    assert.throws(() => freezeFormat5RenderSnapshot(store, selected), {
      code: 'TIMELINE_LIMIT', message: '时间线最多支持 300 个片段和 30 分钟（54000 帧）。',
    });
    const report = await handlers['timeline.export.preflight'](selected);
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.issues.map(({code, message}) => [code, message]), [
      ['TIMELINE_LIMIT', '时间线最多支持 300 个片段和 30 分钟（54000 帧）。'],
    ]);
    assert.equal(report.checks.bytesHashed, 0);
  }
});

test('format-5 render projection keeps muted and sound-only flags and the frozen snapshot admits them', (t) => {
  const {world, service} = fixture(t);
  const preview = service.preview({projectId: world.projectId, requestId: 'render-separate-0001',
    soundIntent: {side: 'timeline', operation: {kind: 'separate-sound', clipId: clipA}}}) as {envelope: unknown; planDigest: string};
  assert.ok(preview.envelope);
  service.commit({projectId: world.projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
  const timeline = readFormat5TimelineRecord(world.store.db, 'project')!;
  const source = timeline.clips.find(item => item.id === clipA)!;
  const sound = timeline.clips.find(item => item.soundOnly === true)!;
  assert.equal(source.muted, true);
  assert.ok(sound);
  const projection = readFormat5RenderProjection(world.store)!;
  const legacySource = projection.legacy.clips.find(item => item.id === clipA)!;
  const legacySound = projection.legacy.clips.find(item => item.id === sound.id)!;
  assert.equal(legacySource.muted, true);
  assert.equal(legacySound.soundOnly, true);
  const frozen = freezeFormat5RenderSnapshot(world.store, {expectedRevision: timeline.revision}) as {
    timeline: {id: string; revision: number; clips: Record<string, unknown>[]}; assets: unknown[]};
  const request = {projectId: world.projectId, requestId: 'render-separate-request-0001', expectedRevision: timeline.revision,
    purpose: 'preview' as const};
  const record = {id: '10000000-0000-4000-8000-000000000098', projectId: world.projectId, requestId: request.requestId,
    mode: 'timeline' as const, purpose: 'preview' as const, timelineRevision: timeline.revision, snapshot: frozen,
    status: 'queued' as const, assetId: null, url: null, error: null, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'};
  assert.equal(isTimelineRenderRecord(record, request, {format: FORMAT5_TIMELINE_FORMAT}), true,
    'the format-5 projection accepts both clip flags and the video source on an audio track');
  // The same record is a format-3/4 record until the caller states format 5:
  // released formats keep rejecting the clip sound flags byte for byte.
  assert.equal(isTimelineRenderRecord(record, request), false,
    'a released-format render record still rejects muted/soundOnly');
  // A frozen snapshot without either optional flag stays valid for formats 3/4.
  const plain = structuredClone(record);
  for (const clip of plain.snapshot.timeline.clips as Record<string, unknown>[]) {
    delete clip.muted;
    delete clip.soundOnly;
  }
  assert.equal(isTimelineRenderRecord(plain, request), false,
    'a video source on an audio track is still refused without the soundOnly flag');
});
