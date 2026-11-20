import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {createBoardUiWireFixture, BOARD_IDS} from './helpers/board-ui-wire-fixture.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createFormat5ExportTicket, assertFormat5ExportAdmissible} from '../packages/business/src/format5-timeline-export.ts';
import {getFormat5TimelineIssue} from '../packages/contracts/src/project-format5.ts';
import {adoptFormat5GeneratedVersionInside} from '../packages/business/src/format5-sequence-sync.ts';
import {previewMioSequenceAction, commitMioSequenceAction} from '../packages/business/src/format5-mio-sequence.ts';
import {mioSequenceEditSchemas} from '../packages/contracts/src/mio-sequence.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createProviderRegistry, registerInputProfileWrapper} from '../packages/business/src/provider-registry.ts';
import {startWorker} from '../packages/business/src/jobs.ts';

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
  // GE-b: the placeholder clip carries the localized shot name, never "Clip".
  assert.equal(clip.name, '剪辑里生成的镜头');
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
  // Editing the shot (revision/title) while the job runs must not block adoption.
  f.store.put('shots', {...(f.store.get('shots', shotId) as any), revision: 2, title: '生成期间改过标题'});
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
  // Adoption keeps the edit's clip parameters; it does not stretch the cut to
  // the full source length or move following clips.
  assert.equal(readyClip.durationFrames, 60);
  for (const item of shifted) assert.equal(ready.clips.find((clip: any) => clip.id === item.id).startFrame, item.startFrame);
  // The video's own audio follows the picture through the existing clip gain path.
  const gainPreview = await services.call('sequence.preview', {projectId, requestId: `gain-${randomUUID()}`,
    propertiesIntent: {side: 'timeline', operation: {kind: 'clip-properties',
      edits: [{clipId, patch: {gain: 0.25}}]}}}) as any;
  await services.call('sequence.commit', {projectId, envelope: gainPreview.envelope, expectedPlanDigest: gainPreview.planDigest});
  const gained = f.store.get('timelines', BOARD_IDS.timeline) as any;
  assert.equal(gained.clips.find((item: any) => item.id === clipId).gain, 0.25);
  assert.equal(gained.clips.filter((item: any) => item.trackId === gained.mainTrack.trackId
    && item.sequenceSource?.nodeId === shotId).length, 1);
  // A late result for a shot that already selected another version only records
  // the version; the timeline is untouched.
  const otherVersion = {...(f.store.get('versions', versionId) as any), id: randomUUID(), jobId: randomUUID()};
  f.store.put('versions', otherVersion);
  f.store.put('shots', {...(f.store.get('shots', shotId) as any), selectedVersionId: otherVersion.id});
  const lateAdopt = f.store.tx(() => adoptFormat5GeneratedVersionInside(f.store, job, otherVersion));
  assert.equal(lateAdopt, false);
  f.store.put('shots', {...(f.store.get('shots', shotId) as any), selectedVersionId: null, revision: 1});
  // The same completion rule covers any format-5 shot with a follow placeholder,
  // not just shots created by edit generation. shotB's clipB is such a placeholder.
  f.store.put('shots', {...(f.store.get('shots', shotId) as any), revision: 1});
  const otherShotId = '70000000-0000-4000-8000-000000000004';
  const otherAssetId = randomUUID(), otherVersionId = randomUUID();
  const otherJob = {id: randomUUID(), projectId, shotId: otherShotId, snapshot: {shotRevision: 1}};
  let otherAdopted = false;
  f.store.put('assets', {id: otherAssetId, projectId, name: 'board-generated.mp4', mimeType: 'video/mp4',
    duration: 4, sha256: 'c'.repeat(64), createdAt: at});
  f.store.put('versions', {id: otherVersionId, projectId, shotId: otherShotId, jobId: otherJob.id,
    assetId: otherAssetId, sha256: 'c'.repeat(64), createdAt: at});
  f.store.tx(() => {
    otherAdopted = adoptFormat5GeneratedVersionInside(f.store, otherJob, {id: otherVersionId, assetId: otherAssetId});
    console.error('OTHER ISSUE', getFormat5TimelineIssue(f.store.get('timelines', BOARD_IDS.timeline), {projectId}));
    console.error('VERSION', JSON.stringify(f.store.get('versions', otherVersionId)));
  });
  assert.equal(otherAdopted, true);
  const otherReady = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const boardReadyClip = otherReady.clips.find((item: any) => item.sequenceSource?.nodeId === otherShotId);
  assert.equal(boardReadyClip.sourceState, 'ready');
  assert.equal(boardReadyClip.versionId, otherVersionId);
  assert.equal(boardReadyClip.startFrame, 120);
  assert.equal(boardReadyClip.durationFrames, 120);
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
  const f = await createBoardUiWireFixture();
  const tools = createAgentTaskTools({store: f.store, services: f.services});
  const prepared = tools.prepare({projectId: f.projectId, operation: 'mioon_sequence_timeline_edit',
    input: {kind: 'generate', placement: {kind: 'main', beforeClipId: BOARD_IDS.clipB},
      providerId: 'mock', model: 'mock-motion-v1', region: 'local', prompt: 'Paid confirmation lock',
      aspectRatio: '9:16', duration: 2}});
  assert.equal(prepared.risk, 'paid');
  assert.equal(prepared.forceApproval, true);
  tools.dispose();
  assert.equal(mioSequenceEditSchemas['sequence.tool.timeline'].safeParse({kind: 'generate',
    placement: {kind: 'main', beforeClipId: null}, providerId: 'mock', model: 'mock-motion-v1', region: 'local',
    prompt: 'Synthetic', aspectRatio: '9:16', duration: 2}).success, true);
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



test('GE-a real worker publishes a synthetic version into the placeholder', async (t) => {
  const f = await createBoardUiWireFixture();
  const registry = createProviderRegistry({db: f.store.db, root: f.root, env: {}});
  for (const [id, provider] of registry) f.providers.set(id, provider);
  const syntheticVideo = join(f.root, 'synthetic-generation.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=360x640:d=4:r=30',
    '-pix_fmt', 'yuv420p', '-y', syntheticVideo]);
  const baseMock = registry.get('mock')!;
  const synthetic = registerInputProfileWrapper({
    id: 'mock', capabilities: baseMock.capabilities,
    validate: baseMock.validate?.bind(baseMock),
    async submit() {return {providerJobId: `synthetic-${randomUUID()}`};},
    async reconcile() {return null;},
    async poll() {return {status: 'succeeded', progress: 100};},
    async download(_providerJobId: string, destination: string) {copyFileSync(syntheticVideo, destination); return {};},
    async cancel() {return {};},
  }, baseMock);
  f.providers.set('mock', synthetic);
  const worker = startWorker(f.store, f.services, f.providers as never);
  t.after(async () => {await worker.stop(); await f.services.drain?.(); f.store.close(); f.library.close();});
  const shotId = randomUUID(), clipId = randomUUID(), requestId = randomUUID();
  const preview = await f.services.call('sequence.preview', {projectId: f.projectId, requestId: `preview-${requestId}`,
    generateIntent: {side: 'timeline', operation: {kind: 'generate-placeholder',
      placement: {kind: 'main', beforeClipId: BOARD_IDS.clipB},
      settings: {requestId, providerId: 'mock', model: 'mock-motion-v1', region: 'local',
        prompt: 'Real worker generation', aspectRatio: '9:16', duration: 4}, shotId, clipId, title: '真实生成镜头'}}}) as any;
  await f.services.call('sequence.commit', {projectId: f.projectId, envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest});
  const historyBefore = await f.services.call('sequence.history.get', {projectId: f.projectId}) as any;
  const submitted = (f.store.list('jobs') as any[]).find(item => item.shotId === shotId)!;
  for (let attempt = 0; attempt < 120; attempt++) {
    await worker.tick();
    const job = (f.store.get('jobs', submitted.id) as any);
    if (job?.status === 'succeeded' || job?.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const job = f.store.get('jobs', submitted.id) as any;
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  const timeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const clip = timeline.clips.find((item: any) => item.id === clipId);
  assert.equal(clip.sourceState, 'ready');
  assert.equal(clip.versionId, job.versionId);
  const shot = f.store.get('shots', shotId) as any;
  assert.equal(shot.selectedVersionId, job.versionId);
  const historyAfter = await f.services.call('sequence.history.get', {projectId: f.projectId}) as any;
  assert.equal(historyAfter.position, historyBefore.position, 'adoption adds no history entry');
  assert.equal(historyAfter.undo?.actionId, historyBefore.undo?.actionId);
  let undoError: any = null;
  try { await f.services.call('sequence.undo', {projectId: f.projectId, requestId: `undo-adopted-${randomUUID()}`,
    actionId: historyAfter.undo.actionId,
    expected: {position: historyAfter.position, revision: historyAfter.revision}}); }
  catch (error) { undoError = error; }
  assert.equal(undoError?.code, 'SEQUENCE_EDIT_HISTORY_CONFLICT');
  assert.equal(historyAfter.conflict, true);
  // A Mio-initiated generation follows the same worker/adoption path.
  const mioPlan = previewMioSequenceAction(f.store, f.projectId, `mio-${randomUUID()}`, {kind: 'generate',
    placement: {kind: 'main', beforeClipId: BOARD_IDS.clipB}, title: 'Mio 真实生成',
    providerId: 'mock', model: 'mock-motion-v1', region: 'local', prompt: 'Mio real worker generation',
    aspectRatio: '9:16', duration: 2});
  commitMioSequenceAction(f.store, mioPlan, {generationSubmit: (input) => f.services.createGenerationJobInside(input as never)});
  const mioClipId = mioPlan.envelope.allocation.clips[0]!.clipId;
  const mioShotId = mioPlan.envelope.allocation.clips[0]!.nodeId;
  const mioJob = (f.store.list('jobs') as any[]).find(item => item.shotId === mioShotId)!;
  for (let attempt = 0; attempt < 120; attempt++) {
    await worker.tick();
    const value = f.store.get('jobs', mioJob.id) as any;
    if (value?.status === 'succeeded' || value?.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const mioDone = f.store.get('jobs', mioJob.id) as any;
  assert.equal(mioDone.status, 'succeeded', JSON.stringify(mioDone));
  const mioTimeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  assert.equal(mioTimeline.clips.find((item: any) => item.id === mioClipId).sourceState, 'ready');
  assert.equal((f.store.get('shots', mioShotId) as any).selectedVersionId, mioDone.versionId);
});


