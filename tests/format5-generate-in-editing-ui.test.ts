import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BoardUiSession} from '../apps/web/src/board-ui/live-session.ts';
import {
  generatePlaceholderIntent, generateResizeIntent, mainTrackGenerateAroundPlacement, timelineGenerateTargetForBlank,
} from '../apps/web/src/edit-ui/generate-in-editing.ts';
import {createBoardUiWireFixture, BOARD_IDS} from './helpers/board-ui-wire-fixture.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';

const target = {trackId: 'v2', main: false, startFrame: 30, beforeClipId: null};
const clips = [
  {trackId: 'main', startFrame: 0, durationFrames: 120},
  {trackId: 'main', startFrame: 120, durationFrames: 90},
];

test('GE-b: the timeline blank menu offers each generate entry only where GE-a can place it', () => {
  // Main track end: at end target, but not in the middle of the packed track.
  assert.deepEqual(timelineGenerateTargetForBlank({trackId: 'main', trackKind: 'video', mainTrackId: 'main', frame: 210, clips}),
    {trackId: 'main', main: true, startFrame: 210, beforeClipId: null});
  assert.deepEqual(timelineGenerateTargetForBlank({trackId: 'main', trackKind: 'video', mainTrackId: 'main', frame: 240, clips}),
    {trackId: 'main', main: true, startFrame: 210, beforeClipId: null});
  assert.equal(timelineGenerateTargetForBlank({trackId: 'main', trackKind: 'video', mainTrackId: 'main', frame: 60, clips}), null);
  assert.equal(timelineGenerateTargetForBlank({trackId: 'main', trackKind: 'video', mainTrackId: 'main', frame: 150, clips}), null);
  // Other video track: only inside a main-track shot (the anchored clip needs an owner).
  assert.deepEqual(timelineGenerateTargetForBlank({trackId: 'v2', trackKind: 'video', mainTrackId: 'main', frame: 30, clips}),
    {trackId: 'v2', main: false, startFrame: 30, beforeClipId: null});
  assert.equal(timelineGenerateTargetForBlank({trackId: 'v2', trackKind: 'video', mainTrackId: 'main', frame: 240, clips}), null);
  // Audio tracks never get a generation entry.
  assert.equal(timelineGenerateTargetForBlank({trackId: 'a1', trackKind: 'audio', mainTrackId: 'main', frame: 30, clips}), null);
  // No main track yet (an empty format-5 project): no entry.
  assert.equal(timelineGenerateTargetForBlank({trackId: 'v2', trackKind: 'video', mainTrackId: null, frame: 0, clips: []}), null);
});

test('GE-b: a main-track clip offers generate before/after with the packed-track position', () => {
  const around = [
    {id: 'c1', trackId: 'main', startFrame: 0, durationFrames: 60, sequenceSource: {kind: 'shot', nodeId: 's1'}},
    {id: 'c2', trackId: 'main', startFrame: 60, durationFrames: 60, sequenceSource: {kind: 'shot', nodeId: 's2'}},
    {id: 'c3', trackId: 'main', startFrame: 120, durationFrames: 40, sequenceSource: {kind: 'shot', nodeId: 's2'}},
    {id: 'c4', trackId: 'v2', startFrame: 0, durationFrames: 60},
  ];
  assert.deepEqual(mainTrackGenerateAroundPlacement({clipId: 'c2', where: 'before', mainTrackId: 'main', clips: around}),
    {trackId: 'main', main: true, startFrame: 60, beforeClipId: 'c2'});
  // After a split shot inserts after its last segment, not between its segments.
  assert.deepEqual(mainTrackGenerateAroundPlacement({clipId: 'c2', where: 'after', mainTrackId: 'main', clips: around}),
    {trackId: 'main', main: true, startFrame: 120, beforeClipId: null});
  assert.deepEqual(mainTrackGenerateAroundPlacement({clipId: 'c1', where: 'after', mainTrackId: 'main', clips: around}),
    {trackId: 'main', main: true, startFrame: 60, beforeClipId: 'c2'});
  assert.equal(mainTrackGenerateAroundPlacement({clipId: 'c4', where: 'before', mainTrackId: 'main', clips: around}), null);
  assert.equal(mainTrackGenerateAroundPlacement({clipId: 'c1', where: 'after', mainTrackId: null, clips: around}), null);
});

test('GE-b: the blank generate entries build the GE-a intents from the blank point', () => {
  const placeholder = generatePlaceholderIntent({target, settings: {requestId: randomUUID()}, shotId: '70000000-0000-4000-8000-000000000010',
    clipId: '70000000-0000-4000-8000-000000000011', title: '新镜头'});
  assert.equal(placeholder.operation.kind, 'generate-placeholder');
  assert.deepEqual(placeholder.operation.kind === 'generate-placeholder' ? placeholder.operation.placement : null,
    {kind: 'track', trackId: 'v2', startFrame: 30});
  assert.deepEqual(generateResizeIntent('70000000-0000-4000-8000-000000000010', 2),
    {side: 'timeline', operation: {kind: 'generate-resize', shotId: '70000000-0000-4000-8000-000000000010', duration: 2}});
});

test('GE-b: the duration control sends one generate-resize preview and one commit', async () => {
  const calls: {operation: string; input: Record<string, unknown>}[] = [];
  const session = new BoardUiSession(async (operation, input) => {
    calls.push({operation, input: input as Record<string, unknown>});
    if (operation === 'sequence.preview') return {envelope: {}, planDigest: 'a'.repeat(64), warnings: []};
    return {status: 'applied', actionId: '70000000-0000-4000-8000-000000000012',
      operation: 'timeline.generate.resize', receipt: {}};
  }, () => '70000000-0000-4000-8000-000000000001');
  const outcome = await session.runGenerate(generateResizeIntent('70000000-0000-4000-8000-000000000010', 3));
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.operation, 'sequence.preview');
  assert.equal((calls[0]!.input.generateIntent as {operation: {kind: string}}).operation.kind, 'generate-resize');
  assert.equal(calls[1]!.operation, 'sequence.commit');
});

test('GE-b: resizing a placeholder is one history step that restores the old length', async () => {
  const fixture = await createBoardUiWireFixture();
  const projectId = fixture.projectId;
  const shotId = randomUUID(), clipId = randomUUID(), requestId = randomUUID();
  const provider = {id: 'mock', capabilities: {models: ['mock-motion-v1'], inputModes: ['text'], aspectRatios: ['9:16'],
    durations: [2], mock: true, configured: true, enabled: true}, async submit() {return {providerJobId: 'synthetic-job'};},
    async reconcile() {return null;}, async poll() {return {status: 'running' as const};},
    async download() {throw new Error('No synthetic output requested');}};
  const services = createServices(fixture.store, new Map([['mock', provider as never]]), {env: {},
    application: createProjectServiceApplication(fixture.library, undefined, {})});
  const preview = await services.call('sequence.preview', {projectId, requestId: `preview-${requestId}`,
    generateIntent: {side: 'timeline', operation: {kind: 'generate-placeholder',
      placement: {kind: 'main', beforeClipId: BOARD_IDS.clipB},
      settings: {requestId, providerId: 'mock', model: 'mock-motion-v1', region: 'local',
        prompt: 'Synthetic editing generation', aspectRatio: '9:16', duration: 2},
      shotId, clipId, title: '剪辑里生成的镜头'}}}) as any;
  assert.ok((preview as any)?.envelope, JSON.stringify(preview));
  const receipt = await services.call('sequence.commit', {projectId, envelope: (preview as any).envelope,
    expectedPlanDigest: (preview as any).planDigest}) as any;
  assert.equal(receipt.status, 'applied');
  const resized = await services.call('sequence.preview', {projectId, requestId: `resize-${requestId}`,
    generateIntent: {side: 'timeline', operation: {kind: 'generate-resize', shotId, duration: 4}}}) as any;
  await services.call('sequence.commit', {projectId, envelope: resized.envelope, expectedPlanDigest: resized.planDigest});
  const history = await services.call('sequence.history.get', {projectId}) as any;
  assert.equal(history.undo?.operation, 'timeline.generate.resize');
  await services.call('sequence.undo', {projectId, requestId: `undo-${randomUUID()}`, actionId: history.undo.actionId,
    expected: {position: history.position, revision: history.revision}});
  const restored = fixture.store.get('timelines', BOARD_IDS.timeline) as any;
  assert.equal(restored.clips.find((clip: any) => clip.id === clipId).durationFrames, 60);
  assert.equal(restored.clips.find((clip: any) => clip.id === clipId).name, '剪辑里生成的镜头');
  fixture.store.close(); fixture.library.close();
});
