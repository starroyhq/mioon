import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {createBoardUiWireFixture, BOARD_IDS} from './helpers/board-ui-wire-fixture.ts';
import {createProviderRegistry, registerInputProfileWrapper} from '../packages/business/src/provider-registry.ts';
import {startWorker} from '../packages/business/src/jobs.ts';

/** GP acceptance item 5, RPC layer: a synthetic Mock Format-5 task completes
 * through the real worker, writes the version and selects it for the shot. */
test('a mock Format-5 board generation completes and exposes the written version', async t => {
  const fixture = await createBoardUiWireFixture();
  const registry = createProviderRegistry({db: fixture.store.db, root: fixture.root, env: {}});
  for (const [id, provider] of registry) fixture.providers.set(id, provider);
  // The shared test environment can lack FFmpeg's drawtext; this provider keeps
  // the real worker/publication path but returns a pre-rendered synthetic video
  // instead of asking the mock renderer to draw text.
  const syntheticVideo = join(fixture.root, 'synthetic-generation.mp4');
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
  fixture.providers.set('mock', synthetic);
  const worker = startWorker(fixture.store, fixture.services, fixture.providers as never);
  t.after(async () => { await worker.stop(); await fixture.services.drain?.(); fixture.store.close(); fixture.library.close(); });
  const call = (operation: string, input: unknown): Promise<any> => fixture.services.call(operation, input) as Promise<any>;

  const appendedId = randomUUID();
  const append = await call('sequence.preview', {projectId: fixture.projectId, requestId: `gp-append-${randomUUID()}`,
    intents: [{side: 'board', operation: {kind: 'board.shot.append', nodeId: appendedId, name: '生成镜头'}}]});
  assert.equal(append.ok, undefined, JSON.stringify(append));
  await call('sequence.commit', {projectId: fixture.projectId, envelope: append.envelope,
    expectedPlanDigest: append.planDigest});
  const shot = (await call('project.get', {projectId: fixture.projectId}))
    .shots.find((item: {id: string}) => item.id === appendedId);
  assert.ok(shot);
  const placeholder = (fixture.store.get('timelines', BOARD_IDS.timeline) as any).clips
    .find((item: any) => item.sequenceSource?.nodeId === appendedId);
  assert.equal(placeholder.sourceState, 'placeholder');
  const preview = await call('sequence.preview', {projectId: fixture.projectId, requestId: `gp-shot-${randomUUID()}`,
    intents: [{side: 'board', operation: {kind: 'board.shot.update', shotId: shot.id,
      expectedRevision: shot.revision, patch: {title: '生成镜头', prompt: '雨停后的路口俯拍。', duration: 4,
        aspectRatio: '9:16'}}}]});
  assert.equal(preview.ok, undefined, JSON.stringify(preview));
  const updated = await call('sequence.commit', {projectId: fixture.projectId, envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest});
  assert.equal(updated.status, 'applied');
  const row = (await call('project.get', {projectId: fixture.projectId})).shots.find((item: {id: string}) => item.id === shot.id);
  fixture.store.put('shots', {...row, referenceAssetIds: [], referenceBindings: []});
  const historyBefore = await call('sequence.history.get', {projectId: fixture.projectId});
  const submitted = await call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision + 1,
    providerId: 'mock', requestId: `gp-generate-${randomUUID()}`});
  assert.equal(typeof submitted.id, 'string');
  for (let attempt = 0; attempt < 80; attempt++) {
    await worker.tick();
    const job = (await call('project.get', {projectId: fixture.projectId})).jobs.find((item: {id: string}) => item.id === submitted.id);
    if (job?.status === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const project = await call('project.get', {projectId: fixture.projectId});
  const job = project.jobs.find((item: {id: string}) => item.id === submitted.id);
  assert.equal(job?.status, 'succeeded', JSON.stringify(job));
  assert.equal(typeof job.versionId, 'string');
  const version = project.versions.find((item: {id: string}) => item.id === job.versionId);
  assert.ok(version, 'the completed task publishes a version');
  const after = project.shots.find((item: {id: string}) => item.id === shot.id);
  assert.equal(after.selectedVersionId, job.versionId, 'the shot follows the completed version');
  assert.equal(project.versions.some((item: {id: string}) => item.id === job.versionId), true,
    'the completed task version is visible on the project/version page');
  // GE-a item 5: the main-track placeholder is replaced in the worker's own
  // transaction. The board UI does nothing and adds no board-version history.
  const readyClip = (fixture.store.get('timelines', BOARD_IDS.timeline) as any).clips
    .find((item: any) => item.id === placeholder.id);
  assert.equal(readyClip.sourceState, 'ready');
  assert.equal(readyClip.versionId, job.versionId);
  assert.equal(readyClip.startFrame, placeholder.startFrame);
  assert.equal(readyClip.durationFrames, placeholder.durationFrames);
  const historyAfter = await call('sequence.history.get', {projectId: fixture.projectId});
  assert.equal(historyAfter.position, historyBefore.position, 'task completion is not a user undo entry');
  assert.equal(historyAfter.undo?.actionId, historyBefore.undo?.actionId);
});
