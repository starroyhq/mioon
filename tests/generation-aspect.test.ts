import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ClientError, createClient, errorEnvelope} from '@mioon/client';
import {AppError, isSubjectGenerationResponse, isSubjectGenerationRetryResponse, schemas} from '@mioon/contracts';
import {startServer} from '../apps/server/src/index.ts';
import {ApiError, rpc as webRpc} from '../apps/web/src/api.ts';
import {generationAspectSourceSchema, isGenerationAspectNotApplied} from '../packages/contracts/src/generation-aspect.ts';
import type {GenerationAspectSource} from '../packages/contracts/src/generation-aspect.ts';
import {timelineFormatResponseSchema} from '../packages/contracts/src/timeline-format.ts';
import {defaultVideoModels, resolveVideoEndpoint} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding} from '../packages/contracts/src/video-providers.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {openServerTestStore} from '../packages/business/src/project-file/test-store.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord, ServiceRow} from '../packages/business/src/services.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

function configuredBinding(providerId: 'wan' | 'ark' | 'minimax', aspectRatios?: VideoExecutionBinding['model']['aspectRatios']): VideoExecutionBinding {
  const models = defaultVideoModels(providerId);
  const model = providerId === 'wan' ? models.find(candidate => candidate.templateId === 'wan30-v1')! : models[0]!;
  const region = providerId === 'minimax' ? 'global' : 'cn-beijing';
  return {version: 1, connectionId: randomUUID(), configurationRevision: 1, providerId, region, workspaceId: '',
    endpoint: resolveVideoEndpoint(providerId, region), credentialRef: randomUUID(), model: {...model, aspectRatios: aspectRatios ?? model.aspectRatios}, outputHosts: ['output.example']};
}

async function fixture(t: TestContext, binding?: VideoExecutionBinding, {mockAllowed = true} = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-generation-aspect-')));
  const projectFile = path.join(root, 'project.mioon'), projectId = createProjectFile(projectFile);
  const store = openServerTestStore({projectFile, locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'),
    tempDir: path.join(root, 'tmp')}), format4: {approveUpgrade: () => true}}, path.join(root, 'app'));
  const providers = createProviderRegistry({db: store.db, root, env: {}});
  let providerCalls = 0;
  const services = createServices(store, providers, {env: {}, mockAllowed, profileNow: () => Date.UTC(2026, 10, 12),
    ...(binding ? {videoSettings: {
      select(connectionId, revision, modelEntryId) {
        assert.deepEqual([connectionId, revision, modelEntryId], [binding.connectionId, binding.configurationRevision, binding.model.id]);
        return binding;
      },
      assertBinding() {},
      acquire() { throw Error('Admission must not read credentials'); },
      list() { return []; },
    }} : {}),
    async videoFetch() { providerCalls++; throw Error('Admission must not contact a provider'); },
  });
  t.after(async () => { try { await services.drain(); store.close(); } finally { await rm(root, {recursive: true, force: true}); } });
  await services.call('project.create', {name: 'Generation aspect test'});
  const format = async () => timelineFormatResponseSchema.parse(await services.call('timeline.format.get', {projectId}));
  const setFrame = async (presetId: string) => {
    const previous = await format();
    await services.call('timeline.format.set', {projectId, expectedProjectRevision: previous.projectRevision,
      expectedRevision: previous.timelineRevision, requestId: randomUUID(), presetId});
    return format();
  };
  const shot = async (patch: ServiceRow = {}) => await services.call('shot.create', {projectId, title: 'Paper boat', prompt: 'A synthetic paper boat moves.',
    aspectRatio: '9:16', duration: 4, ...patch}) as {id: string; revision: number};
  const input = (shot: {id: string; revision: number}, aspectSource?: GenerationAspectSource) => ({
    shotId: shot.id, expectedRevision: shot.revision, requestId: randomUUID(), providerId: binding?.providerId ?? 'mock',
    ...(binding ? {connectionId: binding.connectionId, configurationRevision: binding.configurationRevision, modelEntryId: binding.model.id} : {}),
    ...(aspectSource ? {aspectSource} : {}),
  });
  const submit = async (input: ServiceRow) => await services.call('generation.submit', input) as JobRecord;
  const rejected = async (input: ServiceRow, code: string, status: number, details: ServiceRow) => {
    const writes = store.db.prepare('SELECT total_changes() AS n').get()?.n;
    await assert.rejects(submit(input), error => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.deepEqual(error.details, {requestId: input.requestId, shotId: input.shotId, projectId, ...details, mutationOutcome: 'not_applied'});
      assert.equal(isGenerationAspectNotApplied(error, input, projectId), true);
      assert.equal(isGenerationAspectNotApplied(error, input, randomUUID()), false);
      assert.equal(isGenerationAspectNotApplied(error, {...input, requestId: randomUUID()}, projectId), false);
      assert.equal(isGenerationAspectNotApplied(error, {...input, shotId: randomUUID()}, projectId), false);
      return true;
    });
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get()?.n, writes);
    assert.equal(providerCalls, 0);
  };
  return {root, projectId, store, services, format, setFrame, shot, input, submit, rejected, providerCalls: () => providerCalls};
}

test('aspect source syntax is explicit while omission preserves legacy input bytes', () => {
  const old = {shotId: randomUUID(), expectedRevision: 1, requestId: randomUUID(), providerId: 'mock'};
  assert.equal(JSON.stringify(schemas['generation.submit'].parse(old)), JSON.stringify(old));
  assert.deepEqual(generationAspectSourceSchema.parse({kind: 'project', expectedTimelineRevision: 0, aspectRatio: '21:9'}),
    {kind: 'project', expectedTimelineRevision: 0, aspectRatio: '21:9'});
  assert.deepEqual(generationAspectSourceSchema.parse({kind: 'explicit', aspectRatio: 'adaptive'}), {kind: 'explicit', aspectRatio: 'adaptive'});
  for (const aspectSource of [{kind: 'project', aspectRatio: '9:16'}, {kind: 'project', expectedTimelineRevision: -1, aspectRatio: '9:16'},
    {kind: 'project', expectedTimelineRevision: 1, aspectRatio: 'adaptive'}, {kind: 'shot', aspectRatio: '9:16'},
    {kind: 'explicit', aspectRatio: '7:3'}, {kind: 'explicit', aspectRatio: '9:16', expectedTimelineRevision: 1}, null]) {
    assert.equal(schemas['generation.submit'].safeParse({...old, aspectSource}).success, false);
  }
});

test('mock rejects an unsupported project ratio and only submits an explicit supported choice', async t => {
  const f = await fixture(t), shot = await f.shot(), landscape = await f.setFrame('landscape_1080');
  await f.rejected(f.input(shot, {kind: 'project', aspectRatio: '16:9', expectedTimelineRevision: landscape.timelineRevision}),
    'PROJECT_ASPECT_UNSUPPORTED', 400, {projectAspectRatio: '16:9', supportedAspectRatios: ['9:16'], providerId: 'mock', model: 'mock-motion-v1'});
  await f.rejected(f.input(shot, {kind: 'explicit', aspectRatio: 'adaptive'}), 'GENERATION_ASPECT_UNSUPPORTED', 400,
    {aspectRatio: 'adaptive', supportedAspectRatios: ['9:16'], providerId: 'mock', model: 'mock-motion-v1'});
  assert.equal(f.store.list('jobs').length, 0);
  const explicit = await f.submit(f.input(shot, {kind: 'explicit', aspectRatio: '9:16'}));
  const savedShot = await f.submit(f.input(shot, {kind: 'shot'}));
  assert.equal(explicit.snapshot.aspectRatio, '9:16');
  assert.equal(savedShot.snapshot.aspectRatio, '9:16');
  assert.equal(Object.hasOwn(explicit.snapshot.parameters as ServiceRow, 'aspectRatio'), false);
  assert.equal(explicit.submissionCount, 0);
  assert.equal(f.providerCalls(), 0);
});

test('production rejects fresh mock generation before checking its project ratio', async t => {
  const f = await fixture(t, undefined, {mockAllowed: false}), shot = await f.shot(), portrait = await f.format();
  const stale = f.input(shot, {kind: 'project', aspectRatio: '9:16', expectedTimelineRevision: portrait.timelineRevision});
  const landscape = await f.setFrame('landscape_1080');
  const unsupported = f.input(shot, {kind: 'project', aspectRatio: '16:9', expectedTimelineRevision: landscape.timelineRevision});
  const writes = f.store.db.prepare('SELECT total_changes() AS n').get()?.n;
  assert.equal(f.services.generationAvailability.video('mock'), false);
  const providers = await f.services.call('provider.list', {}) as Array<{id: string}>;
  assert.equal(providers.some(provider => provider.id === 'mock'), false);
  for (const input of [stale, unsupported]) {
    await assert.rejects(f.submit(input), {code: 'GENERATION_SERVICE_UNAVAILABLE', status: 409, details: {mutationOutcome: 'not_applied'}});
  }
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()?.n, writes);
  assert.equal(f.store.list('jobs').length, 0);
  assert.equal(f.providerCalls(), 0);
});

test('frame CAS precedes new writes but a lost old confirmation and retry retain their exact snapshots', async t => {
  const f = await fixture(t), shot = await f.shot({aspectRatio: '16:9'}), portrait = await f.format();
  const projectSource = {kind: 'project', aspectRatio: '9:16', expectedTimelineRevision: portrait.timelineRevision} as const;
  const input = f.input(shot, projectSource), original = await f.submit(input);
  assert.equal(original.snapshot.aspectRatio, '9:16');
  assert.equal((f.store.get('shots', shot.id) as ServiceRow).aspectRatio, '16:9');
  const frame = await f.setFrame('landscape_1080');
  assert.deepEqual(await f.submit(input), original, 'the exact accepted request replays before the live frame CAS');
  const changedKey = {...input, aspectSource: {...projectSource, expectedTimelineRevision: frame.timelineRevision}};
  await assert.rejects(f.submit(changedKey), {code: 'IDEMPOTENCY_CONFLICT'});
  await f.rejected(f.input(shot, projectSource), 'PROJECT_ASPECT_CHANGED', 409, {projectAspectRatio: '16:9', timelineRevision: frame.timelineRevision});
  await assert.rejects(f.submit(f.input(shot)), {code: 'UNSUPPORTED_PARAMETERS'}, 'legacy omission uses the saved 16:9 shot, not the former project frame');
  f.store.put('jobs', {...f.store.get('jobs', original.id) as ServiceRow, status: 'failed'});
  const retryInput = {jobId: original.id, requestId: randomUUID()};
  const retry = await f.services.call('job.retry', retryInput) as JobRecord;
  assert.equal(retry.retryOfJobId, original.id);
  assert.deepEqual(retry.snapshot, original.snapshot);
  assert.deepEqual(await f.services.call('job.retry', retryInput), retry);
  assert.equal(f.providerCalls(), 0);
});

test('project revision is rechecked in the transaction after reference verification yields', async t => {
  const f = await fixture(t);
  const asset = await f.services.call('asset.import', {projectId: f.projectId, name: 'Paper boat.png', mimeType: 'image/png',
    dataBase64: png({width: 360, height: 640, pixel: () => [20, 80, 160, 255]}).toString('base64')}) as {id: string};
  const shot = await f.shot({referenceAssetIds: [asset.id]});
  const format = await f.format();
  const input = f.input(shot, {kind: 'project', aspectRatio: '9:16', expectedTimelineRevision: format.timelineRevision});
  // submit runs its synchronous pre-admission against portrait before it
  // yields at the first media read. Apply the frame change in that same turn.
  const pending = f.submit(input);
  const frameChange = f.services.call('timeline.format.set', {projectId: f.projectId, expectedProjectRevision: format.projectRevision,
    expectedRevision: format.timelineRevision, requestId: randomUUID(), presetId: 'landscape_1080'});
  const current = await frameChange as {revision: number};
  await assert.rejects(pending, error => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'PROJECT_ASPECT_CHANGED');
    assert.equal(isGenerationAspectNotApplied(error, input, f.projectId), true);
    assert.deepEqual(error.details, {requestId: input.requestId, shotId: shot.id, projectId: f.projectId, projectAspectRatio: '16:9', timelineRevision: current.revision, mutationOutcome: 'not_applied'});
    return true;
  });
  assert.equal(f.store.list('jobs').length, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM idempotency WHERE scope='generation'").get()?.n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM job_events').get()?.n, 0);
  assert.equal(f.providerCalls(), 0);
});

test('exact configured model pins new project, saved shot or adaptive ratios without rewriting legacy overrides', async t => {
  for (const providerId of ['wan', 'ark'] as const) await t.test(providerId, async t => {
    const binding = configuredBinding(providerId, ['9:16', '16:9']);
    const f = await fixture(t, binding), shot = await f.shot();
    const before = await f.submit(f.input(shot));
    const landscape = await f.setFrame('landscape_1080');
    const request = f.input(shot, {kind: 'project', aspectRatio: '16:9', expectedTimelineRevision: landscape.timelineRevision});
    const next = await f.submit(request);
    assert.equal(before.snapshot.aspectRatio, '9:16');
    assert.equal(next.snapshot.aspectRatio, '16:9');
    assert.equal((next.snapshot.parameters as ServiceRow).aspectRatio, '16:9');
    assert.equal((f.store.get('shots', shot.id) as ServiceRow).aspectRatio, '9:16');
    const legacyInput = {...f.input(shot), parameters: {aspectRatio: '16:9'}};
    const legacy = await f.submit(legacyInput);
    assert.equal(legacy.snapshot.aspectRatio, '9:16');
    assert.equal((legacy.snapshot.parameters as ServiceRow).aspectRatio, '16:9');
    const saved = await f.submit(f.input(shot, {kind: 'shot'}));
    assert.equal(saved.snapshot.aspectRatio, '9:16');
    assert.equal((saved.snapshot.parameters as ServiceRow).aspectRatio, '9:16');
    const adaptive = await f.submit(f.input(shot, {kind: 'explicit', aspectRatio: 'adaptive'}));
    assert.equal(adaptive.snapshot.aspectRatio, '9:16');
    assert.equal((adaptive.snapshot.parameters as ServiceRow).aspectRatio, 'adaptive');
    await assert.rejects(f.submit({...f.input(shot, {kind: 'shot'}), parameters: {aspectRatio: '16:9'}}), {code: 'UNSUPPORTED_PARAMETERS'});
    const square = await f.setFrame('square_1080');
    await f.rejected(f.input(shot, {kind: 'project', aspectRatio: '1:1', expectedTimelineRevision: square.timelineRevision}),
      'PROJECT_ASPECT_UNSUPPORTED', 400, {projectAspectRatio: '1:1', supportedAspectRatios: ['9:16', '16:9', 'adaptive'], providerId, model: binding.model.modelId});
    assert.deepEqual(await f.submit(request), next);
    assert.deepEqual(await f.submit(legacyInput), legacy);
    f.store.put('jobs', {...f.store.get('jobs', legacy.id) as ServiceRow, status: 'failed'});
    const legacyRetry = await f.services.call('job.retry', {jobId: legacy.id, requestId: randomUUID()}) as JobRecord;
    assert.deepEqual(legacyRetry.snapshot, legacy.snapshot);
    assert.equal(f.providerCalls(), 0);
  });
});

test('a configured model without request-level ratio receives only the effective snapshot field', async t => {
  const binding = configuredBinding('minimax'), f = await fixture(t, binding), shot = await f.shot();
  const frame = await f.setFrame('landscape_1080');
  const job = await f.submit(f.input(shot, {kind: 'project', aspectRatio: '16:9', expectedTimelineRevision: frame.timelineRevision}));
  assert.equal(job.snapshot.aspectRatio, '16:9');
  assert.equal(Object.hasOwn(job.snapshot.parameters as ServiceRow, 'aspectRatio'), false);
  await f.rejected(f.input(shot, {kind: 'explicit', aspectRatio: 'adaptive'}), 'GENERATION_ASPECT_UNSUPPORTED', 400,
    {aspectRatio: 'adaptive', supportedAspectRatios: ['9:16', '16:9'], providerId: 'minimax', model: binding.model.modelId});
});

test('connected subject ACK and retry keep the chosen wide ratio and exact reviewed material', async t => {
  const binding = configuredBinding('ark', ['9:16', '16:9', '21:9']);
  binding.model.durationResolutionMap = [{duration: [4, 8], resolution: ['720p']}];
  const f = await fixture(t, binding), shot = await f.shot({duration: 2});
  const asset = await f.services.call('asset.import', {projectId: f.projectId, name: 'Paper model.png', mimeType: 'image/png',
    dataBase64: png({width: 512, height: 512, pixel: () => [20, 80, 160, 255]}).toString('base64')}) as {id: string; referenceRevision: number; sha256: string};
  const subject = await f.services.call('subject.create', {projectId: f.projectId, requestId: randomUUID(),
    name: 'Paper model', kind: 'product', assetId: asset.id}) as {headVersionId: string};
  const frame = await f.setFrame('ultrawide_1080');
  const oldShot = await f.shot();
  const oldInput = {...f.input(oldShot), subjectVersionId: subject.headVersionId};
  const oldJob = await f.submit(oldInput);
  assert.equal(oldJob.snapshot.aspectRatio, '9:16');
  assert.equal(isSubjectGenerationResponse('generation.submit', oldInput, oldJob), true);
  for (const base of [{aspectRatio: '21:9'}, {duration: 2}]) {
    const legacy = {...oldJob, snapshot: {...oldJob.snapshot, ...base, parameters: {aspectRatio: '9:16', durationSeconds: 4}}};
    assert.equal(isSubjectGenerationResponse('generation.submit', oldInput, legacy), false, 'Omission keeps its original base-profile checks');
  }
  const input = {...f.input(shot, {kind: 'project', aspectRatio: '21:9', expectedTimelineRevision: frame.timelineRevision}),
    subjectVersionId: subject.headVersionId, parameters: {durationSeconds: 4},
    referenceRevisions: [{assetId: asset.id, referenceRevision: asset.referenceRevision, sha256: asset.sha256}]};
  const job = await f.submit(input);
  assert.equal(job.snapshot.aspectRatio, '21:9');
  assert.equal(job.snapshot.duration, 2);
  assert.equal((job.snapshot.parameters as ServiceRow).durationSeconds, 4);
  assert.equal(isSubjectGenerationResponse('generation.submit', input, job, {projectId: f.projectId}), true);
  assert.equal(isSubjectGenerationResponse('generation.submit', input, {...job, snapshot: {...job.snapshot, aspectRatio: '16:9'}}), false);
  assert.equal(isSubjectGenerationResponse('generation.submit', input, {...job, snapshot: {...job.snapshot, duration: 21}}), false);
  assert.equal(isSubjectGenerationResponse('generation.submit', input, {...job, snapshot: {...job.snapshot, parameters: {...job.snapshot.parameters as ServiceRow, durationSeconds: 2}}}), false);
  for (const region of [{providerRegion: 'global'}, {executionBinding: {...binding, region: 'global'}}]) {
    const mismatched = {...job, snapshot: {...job.snapshot, ...region}};
    assert.equal(isSubjectGenerationResponse('generation.submit', input, mismatched), false, 'The exact input profile and connection independently validate region');
  }
  assert.deepEqual(await f.services.call('job.get', {jobId: job.id}), job);
  await f.setFrame('square_1080');
  assert.deepEqual(await f.submit(input), job);
  f.store.put('jobs', {...f.store.get('jobs', job.id) as ServiceRow, status: 'failed'});
  const retryInput = {jobId: job.id, requestId: randomUUID()};
  const retry = await f.services.call('job.retry', retryInput) as JobRecord;
  assert.deepEqual(retry.snapshot, job.snapshot);
  assert.equal(isSubjectGenerationRetryResponse(retryInput, retry, {projectId: f.projectId, snapshot: job.snapshot}), true);
  assert.equal(isSubjectGenerationRetryResponse(retryInput, retry), true);
  for (const parameters of [{aspectRatio: '4:3'}, {durationSeconds: 6}]) {
    const invalidRetry = {...retry, snapshot: {...retry.snapshot, parameters: {...retry.snapshot.parameters as ServiceRow, ...parameters}}};
    assert.equal(isSubjectGenerationRetryResponse(retryInput, invalidRetry), false, 'The frozen binding still checks effective parameters without the original request');
  }
  const changedRetry = {...retry, snapshot: {...retry.snapshot, aspectRatio: '16:9',
    parameters: {...retry.snapshot.parameters as ServiceRow, aspectRatio: '16:9'}}};
  assert.equal(isSubjectGenerationRetryResponse(retryInput, changedRetry, {projectId: f.projectId, snapshot: job.snapshot}), false);
  assert.deepEqual(await f.submit(oldInput), oldJob);
  f.store.put('jobs', {...f.store.get('jobs', oldJob.id) as ServiceRow, status: 'failed'});
  const oldRetryInput = {jobId: oldJob.id, requestId: randomUUID()};
  const oldRetry = await f.services.call('job.retry', oldRetryInput) as JobRecord;
  assert.deepEqual(oldRetry.snapshot, oldJob.snapshot);
  assert.equal(isSubjectGenerationRetryResponse(oldRetryInput, oldRetry, {projectId: f.projectId, snapshot: oldJob.snapshot}), true);
  assert.equal(f.providerCalls(), 0);
});

test('project-addressed HTTP preserves the aspect conflict proof in web and CLI transports', async t => {
  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-generation-aspect-http-')));
  const token = 'synthetic-generation-aspect-http-token';
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { try { await server?.close(); } finally { await rm(dataDir, {recursive: true, force: true}); } });
  server = await startServer({dataDir, port: 0, token, comfyModule: 'skip'});
  const base = server.url;
  const cli = createClient({env: {MIOON_BASE_URL: base, MIOON_TOKEN: token}});
  const project = await cli.rpc<{id: string}>('project.create', {name: 'Synthetic generation aspect transport'});
  const projectId = project.id;
  const shot = await cli.rpc<{id: string; revision: number}>('shot.create', {projectId, title: 'Paper boat'});
  const before = timelineFormatResponseSchema.parse(await cli.rpc('timeline.format.get', {projectId}));
  await cli.rpc('timeline.format.set', {projectId, expectedProjectRevision: before.projectRevision,
    expectedRevision: before.timelineRevision, requestId: randomUUID(), presetId: 'landscape_1080'});
  const after = timelineFormatResponseSchema.parse(await cli.rpc('timeline.format.get', {projectId}));
  const input = {shotId: shot.id, expectedRevision: shot.revision, requestId: randomUUID(), providerId: 'mock',
    aspectSource: {kind: 'project', aspectRatio: '9:16', expectedTimelineRevision: before.timelineRevision}};
  const details = {requestId: input.requestId, shotId: shot.id, projectId, projectAspectRatio: '16:9',
    timelineRevision: after.timelineRevision, mutationOutcome: 'not_applied'};
  await assert.rejects(webRpc('generation.submit', input, {projectId, fetcher: (route, options) => fetch(base + route, {
    ...options, headers: {...options?.headers, authorization: `Bearer ${token}`},
  })}), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'PROJECT_ASPECT_CHANGED');
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, details);
    assert.equal(isGenerationAspectNotApplied(error, input, projectId), true);
    return true;
  });
  await assert.rejects(cli.rpc('generation.submit', input, {projectId}), error => {
    assert.ok(error instanceof ClientError);
    assert.equal(error.status, 409);
    const envelope = errorEnvelope(error);
    assert.equal(envelope.error.code, 'PROJECT_ASPECT_CHANGED');
    assert.deepEqual(envelope.error.details, {...details, operation: 'generation.submit', submissionMayHaveSucceeded: false});
    assert.equal(isGenerationAspectNotApplied(error, input, projectId), true);
    return true;
  });
  assert.deepEqual(await cli.rpc('job.list', {projectId}), []);
  const acceptedInput = {...input, requestId: randomUUID(), aspectSource: {kind: 'explicit', aspectRatio: '9:16'}};
  const job = await cli.rpc<JobRecord>('generation.submit', acceptedInput, {projectId});
  assert.equal(job.snapshot.aspectRatio, '9:16');
  assert.equal(job.requestId, acceptedInput.requestId);
  // The worker can advance the job between HTTP requests.
  const replayed = await cli.rpc<JobRecord>('generation.submit', acceptedInput, {projectId});
  const acceptedIdentity = ({id, projectId, shotId, requestId, requestHash, providerId, model, snapshot}: JobRecord) =>
    ({id, projectId, shotId, requestId, requestHash, providerId, model, snapshot});
  assert.deepEqual(acceptedIdentity(replayed), acceptedIdentity(job));
  const jobs = await cli.rpc<JobRecord[]>('job.list', {projectId});
  assert.deepEqual(jobs.map(acceptedIdentity), [acceptedIdentity(job)]);
});
