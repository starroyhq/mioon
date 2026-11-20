import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBoardUiWireFixture, BOARD_IDS} from './helpers/board-ui-wire-fixture.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createFormat5ExportTicket, assertFormat5ExportAdmissible} from '../packages/business/src/format5-timeline-export.ts';
import {adoptFormat5GeneratedVersionInside} from '../packages/business/src/format5-sequence-sync.ts';
import {previewMioSequenceAction, commitMioSequenceAction} from '../packages/business/src/format5-mio-sequence.ts';
import {mioSequenceEditSchemas} from '../packages/contracts/src/mio-sequence.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';

const at = '2026-01-01T00:00:00.000Z';

test('GE-a preview and commit a main-track generation placeholder', async () => {
  const f = await createBoardUiWireFixture();
  const projectId = f.projectId;
  const shotId = randomUUID(), clipId = randomUUID(), requestId = randomUUID();
  const provider = {id: 'mock', capabilities: {models: ['mock-motion-v1'], inputModes: ['text'], aspectRatios: ['9:16'],
    durations: [2], mock: true, configured: true, enabled: true}, async submit() {return {providerJobId: 'synthetic-job'};},
    async reconcile() {return null;}, async poll() {return {status: 'running' as const};},
    async download() {throw new Error('No synthetic output requested');}};
  const services = createServices(f.store, new Map([['mock', provider as never]]), {env: {},
    application: createProjectServiceApplication(f.library, undefined, {})});
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
  const timeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const clip = timeline.clips.find((item: any) => item.id === clipId);
  assert.equal(clip.sourceState, 'placeholder');
  assert.equal(clip.durationFrames, 60);
  assert.equal(clip.sequenceSource.nodeId, shotId);
  const shots = f.store.list('shots').filter((shot: any) => shot.id === shotId);
  assert.equal(shots.length, 1);
  const jobs = f.store.list('jobs').filter((job: any) => job.shotId === shotId);
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0] as any).requestId, requestId);
  // Resize the placeholder by two seconds; following clips move with it.
  const before = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const generated = before.clips.find((item: any) => item.id === clipId) as any;
  const following = before.clips.filter((item: any) => item.trackId === before.mainTrack.trackId
    && item.startFrame >= generated.startFrame + generated.durationFrames)
    .sort((a: any,b: any) => a.startFrame-b.startFrame)[0];
  const resize = await services.call('sequence.preview', {projectId, requestId: `resize-${requestId}`,
    generateIntent: {side: 'timeline', operation: {kind: 'generate-resize', shotId, duration: 4}}}) as any;
  assert.ok(resize?.envelope, JSON.stringify(resize));
  const resizedReceipt = await services.call('sequence.commit', {projectId, envelope: resize.envelope, expectedPlanDigest: resize.planDigest}) as any;
  assert.equal(resizedReceipt.status, 'applied', JSON.stringify(resizedReceipt));
  const resized = f.store.get('timelines', BOARD_IDS.timeline) as any;
  assert.equal(resized.clips.find((item: any) => item.id === clipId).durationFrames, 120);
  if (following) assert.equal(resized.clips.find((item: any) => item.id === following.id).startFrame,
    following.startFrame + 60, JSON.stringify({following, clips: resized.clips.map((c: any) => ({id:c.id,start:c.startFrame,dur:c.durationFrames}))}));
  // One undo restores the placeholder length and the following clip.
  const history = await services.call('sequence.history.get', {projectId}) as any;
  assert.equal(history.undo?.operation, 'timeline.generate.resize');
  await services.call('sequence.undo', {projectId, requestId: `undo-${randomUUID()}`, actionId: history.undo.actionId,
    expected: {position: history.position, revision: history.revision}});
  const undone = f.store.get('timelines', BOARD_IDS.timeline) as any;
  assert.equal(undone.clips.find((item: any) => item.id === clipId).durationFrames, 60);
  if (following) assert.equal(undone.clips.find((item: any) => item.id === following.id).startFrame, following.startFrame,
    JSON.stringify({following, clips: undone.clips.map((c: any) => ({id:c.id,start:c.startFrame,dur:c.durationFrames}))}));
  // Undo the placement itself: the new shot, chain edge and placeholder leave
  // in one step; redo restores the same placeholder.
  const placementHistory = await services.call('sequence.history.get', {projectId}) as any;
  assert.equal(placementHistory.undo?.operation, 'timeline.generate.placeholder');
  await services.call('sequence.undo', {projectId, requestId: `undo-placement-${randomUUID()}`,
    actionId: placementHistory.undo.actionId,
    expected: {position: placementHistory.position, revision: placementHistory.revision}});
  const placementUndone = f.store.get('timelines', BOARD_IDS.timeline) as any;
  assert.equal(placementUndone.clips.some((item: any) => item.id === clipId), false);
  assert.equal(f.store.list('shots').some((item: any) => item.id === shotId), false);
  const redoHistory = await services.call('sequence.history.get', {projectId}) as any;
  await services.call('sequence.redo', {projectId, requestId: `redo-placement-${randomUUID()}`,
    actionId: redoHistory.redo.actionId,
    expected: {position: redoHistory.position, revision: redoHistory.revision}});
  const placementRedone = f.store.get('timelines', BOARD_IDS.timeline) as any;
  assert.equal(placementRedone.clips.find((item: any) => item.id === clipId).sourceState, 'placeholder');
  // First successful version: adopt it into the placeholder in the same transaction.
  const job = (f.store.list('jobs') as any[]).find(item => item.shotId === shotId)!;
  const beforeAdopt = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const shifted = beforeAdopt.clips.filter((item: any) => item.trackId === beforeAdopt.mainTrack.trackId
    && item.startFrame >= beforeAdopt.clips.find((generated: any) => generated.id === clipId).startFrame + 60)
    .sort((left: any, right: any) => left.startFrame - right.startFrame);
  const assetId = randomUUID(), versionId = randomUUID();
  let adopted = false;
  f.store.tx(() => {
    f.store.put('assets', {id: assetId, projectId, name: 'generated.mp4', mimeType: 'video/mp4', duration: 4,
      sha256: 'a'.repeat(64), createdAt: at});
    f.store.put('versions', {id: versionId, projectId, shotId, jobId: job.id, assetId, sha256: 'a'.repeat(64), createdAt: at});
    adopted = adoptFormat5GeneratedVersionInside(f.store, job, {id: versionId, assetId});
  });
  assert.equal(adopted, true);
  const ready = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const readyClip = ready.clips.find((item: any) => item.id === clipId);
  assert.equal(readyClip.sourceState, 'ready');
  assert.equal(readyClip.versionId, versionId);
  assert.equal(readyClip.assetId, assetId);
  assert.equal(readyClip.durationFrames, 120);
  for (const item of shifted) assert.equal(ready.clips.find((clip: any) => clip.id === item.id).startFrame,
    item.startFrame + 60);
  // The video's own audio follows the picture through the existing clip gain path.
  const gainPreview = await services.call('sequence.preview', {projectId, requestId: `gain-${randomUUID()}`,
    propertiesIntent: {side: 'timeline', operation: {kind: 'clip-properties',
      edits: [{clipId, patch: {gain: 0.25}}]}}}) as any;
  await services.call('sequence.commit', {projectId, envelope: gainPreview.envelope, expectedPlanDigest: gainPreview.planDigest});
  const gained = f.store.get('timelines', BOARD_IDS.timeline) as any;
  assert.equal(gained.clips.find((item: any) => item.id === clipId).gain, 0.25);
  assert.equal(gained.clips.filter((item: any) => item.trackId === gained.mainTrack.trackId
    && item.sequenceSource?.nodeId === shotId).length, 1);
  // A late result on a shot whose revision moved on records nothing here.
  f.store.put('shots', {...(f.store.get('shots', shotId) as any), revision: 2});
  const revisedAdopt = f.store.tx(() => adoptFormat5GeneratedVersionInside(f.store, job, {id: versionId, assetId}));
  assert.equal(revisedAdopt, false);
  await services.drain();
  f.store.close();
});

test('GE-a generates on another track as a free shot and replaces in place', async () => {
  const f = await createBoardUiWireFixture();
  const projectId = f.projectId;
  const v2Track = randomUUID();
  const originalTimeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  f.store.put('timelines', {...originalTimeline, tracks: [...originalTimeline.tracks,
    {id: v2Track, name: 'V2', kind: 'video', orderIndex: 2, hidden: false, muted: false}]});
  const shotId = randomUUID(), clipId = randomUUID(), requestId = randomUUID();
  const provider = {id: 'mock', capabilities: {models: ['mock-motion-v1'], inputModes: ['text'], aspectRatios: ['9:16'],
    durations: [2], mock: true, configured: true, enabled: true}, async submit() {return {providerJobId: 'synthetic-job'};},
    async reconcile() {return null;}, async poll() {return {status: 'running' as const};},
    async download() {throw new Error('No synthetic output requested');}};
  const services = createServices(f.store, new Map([['mock', provider as never]]), {env: {},
    application: createProjectServiceApplication(f.library, undefined, {})});
  const preview = await services.call('sequence.preview', {projectId, requestId: `preview-${requestId}`,
    generateIntent: {side: 'timeline', operation: {kind: 'generate-placeholder',
      placement: {kind: 'track', trackId: v2Track, startFrame: 30},
      settings: {requestId, providerId: 'mock', model: 'mock-motion-v1', region: 'local',
        prompt: 'Overlay generation', aspectRatio: '9:16', duration: 2},
      shotId, clipId, title: '游离镜头'}}}) as any;
  assert.ok(preview?.envelope, JSON.stringify(preview));
  await services.call('sequence.commit', {projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
  const timeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const overlay = timeline.clips.find((item: any) => item.id === clipId);
  assert.equal(overlay.sourceState, 'placeholder');
  assert.equal(overlay.shotId, shotId);
  assert.equal(overlay.assetId, null);
  const shot = f.store.get('shots', shotId) as any;
  assert.equal(shot.selectedVersionId, null);
  const edges = f.store.list('edges').filter((edge: any) => edge.source === shotId || edge.target === shotId);
  assert.equal(edges.length, 0);
  const job = (f.store.list('jobs') as any[]).find(item => item.shotId === shotId)!;
  const assetId = randomUUID(), versionId = randomUUID();
  let adopted = false;
  f.store.tx(() => {
    f.store.put('assets', {id: assetId, projectId, name: 'generated.mp4', mimeType: 'video/mp4', duration: 2,
      sha256: 'b'.repeat(64), createdAt: at});
    f.store.put('versions', {id: versionId, projectId, shotId, jobId: job.id, assetId, sha256: 'b'.repeat(64), createdAt: at});
    adopted = adoptFormat5GeneratedVersionInside(f.store, job, {id: versionId, assetId});
  });
  assert.equal(adopted, true);
  const ready = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const readyOverlay = ready.clips.find((item: any) => item.id === clipId);
  assert.equal(readyOverlay.sourceState, 'ready');
  assert.equal(readyOverlay.versionId, versionId);
  assert.equal(readyOverlay.anchor.clipId, BOARD_IDS.clipA);
  await services.drain();
  f.store.close();
});


test('GE-a Mio action previews and commits the same placeholder envelope', async () => {
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind: 'generate',
    placement: {kind: 'main', beforeClipId: null}, providerId: 'mock', model: 'mock-motion-v1', region: 'local',
    prompt: 'Synthetic', aspectRatio: '9:16', duration: 2}).success, true);
  const f = await createBoardUiWireFixture();
  const plan = previewMioSequenceAction(f.store, f.projectId, 'mio-generate-preview', {kind: 'generate',
    placement: {kind: 'main', beforeClipId: BOARD_IDS.clipB}, title: 'Mio 剪辑生成',
    providerId: 'mock', model: 'mock-motion-v1', region: 'local', prompt: 'Mio synthetic', aspectRatio: '9:16', duration: 2});
  let submitted: any = null;
  const receipt = commitMioSequenceAction(f.store, plan, {generationSubmit: (input) => {submitted = input; return {};}});
  assert.equal(receipt.status, 'applied');
  const allocation = plan.envelope.allocation.clips[0]!;
  const timeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const clip = timeline.clips.find((item: any) => item.id === allocation.clipId);
  assert.equal(clip.sourceState, 'placeholder');
  assert.equal(submitted.shotId, allocation.nodeId);
  f.store.close();
});

test('GE-a cancellation leaves the placeholder and its exported range blocked', async () => {
  const f = await createBoardUiWireFixture();
  const projectId = f.projectId, shotId = randomUUID(), clipId = randomUUID(), requestId = randomUUID();
  const provider = {id: 'mock', capabilities: {models: ['mock-motion-v1'], inputModes: ['text'], aspectRatios: ['9:16'],
    durations: [2], mock: true, configured: true, enabled: true}, async submit() {return {providerJobId: 'synthetic-job'};},
    async reconcile() {return null;}, async poll() {return {status: 'running' as const};},
    async download() {throw new Error('No synthetic output requested');}};
  const services = createServices(f.store, new Map([['mock', provider as never]]), {env: {},
    application: createProjectServiceApplication(f.library, undefined, {})});
  const preview = await services.call('sequence.preview', {projectId, requestId: `preview-${requestId}`,
    generateIntent: {side: 'timeline', operation: {kind: 'generate-placeholder',
      placement: {kind: 'main', beforeClipId: BOARD_IDS.clipB},
      settings: {requestId, providerId: 'mock', model: 'mock-motion-v1', region: 'local',
        prompt: 'Cancelable generation', aspectRatio: '9:16', duration: 2},
      shotId, clipId, title: '可取消镜头'}}}) as any;
  await services.call('sequence.commit', {projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
  const job = (f.store.list('jobs') as any[]).find(item => item.shotId === shotId)!;
  const cancelled = await services.call('job.cancel', {jobId: job.id}) as any;
  assert.equal(cancelled.status, 'cancelled');
  const timeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  assert.equal(timeline.clips.find((item: any) => item.id === clipId).sourceState, 'placeholder');
  const ticket = createFormat5ExportTicket(f.store);
  assert.ok(ticket.blockers.some((blocker: any) => blocker.code === 'PLACEHOLDER_CLIP' && blocker.clipId === clipId));
  // Failure, unknown submission and visible background progress all keep the
  // placeholder and its export blocker; only a proven first version adopts it.
  for (const patch of [{status: 'failed', progress: 0}, {status: 'submission_unknown', progress: 0},
    {status: 'running', progress: 42}]) {
    f.store.put('jobs', {...(f.store.get('jobs', job.id) as any), ...patch});
    const current = f.store.get('timelines', BOARD_IDS.timeline) as any;
    assert.equal(current.clips.find((item: any) => item.id === clipId).sourceState, 'placeholder');
    assert.ok(createFormat5ExportTicket(f.store).blockers.some((blocker: any) => blocker.code === 'PLACEHOLDER_CLIP'));
  }
  await services.drain();
  f.store.close();
});


