import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {createVideoSettingsV2, isVideoBindingHistoryUnavailable, sanitizeVideoSettingsV2Error, videoSettingsV2Error} from '../packages/business/src/video/settings-v2.ts';
import {defaultVideoModels, VIDEO_PROVIDER_NAMES} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfigurationV2} from '../packages/contracts/src/generation-video-settings.ts';
import type {VideoGenerationSettings} from '../packages/business/src/video/generation.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {createProjectBackgroundState} from '../packages/business/src/background-task-state.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createProjectHostManager} from '../apps/server/src/project-host/manager.ts';
import {createBackgroundCoordinator} from '../apps/server/src/project-host/background-coordinator.ts';
import {backgroundHistorySource} from '../apps/server/src/project-host/background-history.ts';
import {serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import type {ProjectHostRuntime} from '../apps/server/src/project-host/host.ts';

const secret = {action: 'replace', storage: 'session', value: 'synthetic-original-video-key'} as const;
const configuration = (): VideoConnectionConfigurationV2 => ({id: 'abcdef12-0000-4000-8000-000000000003', name: VIDEO_PROVIDER_NAMES.minimax,
  providerId: 'minimax', region: 'global', workspaceId: '', enabled: true, outputHosts: ['output.example.com'], models: defaultVideoModels('minimax')});
const object = (value: unknown): Record<string, unknown> => {assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;};
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {if (Date.now() >= deadline) assert.fail(label); await new Promise(resolve => setTimeout(resolve, 10));}
}
interface Runtime extends ProjectHostRuntime {
  readonly services: ReturnType<typeof createServices>;
  readonly worker: () => ReturnType<typeof startWorker> | undefined;
}

for (const status of ['queued', 'running', 'submission_unknown'] as const) test(`v1 video reset pauses the original ${status} task and releases its S3 lease without a replacement request`, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 's3-g1-recovery-'))), dataDir = path.join(root, 'app');
  const library = openAppLibrary({dataDir}), directories = serverAppDirectories(dataDir), env = {};
  const application = createProjectServiceApplication(library, undefined, env), options = {directory: path.join(dataDir, 'video-settings'), privateRoot: dataDir};
  let settings: VideoGenerationSettings & {close(): Promise<void>} = await createVideoSettings(options), recovery = false, requests = 0;
  const background = createBackgroundCoordinator({index: library.taskIndex, inbox: library.inbox, assertMutationAllowed: application.assertMutationAllowed, checkIntervalMs: 20});
  const manager = createProjectHostManager<Runtime>({directories, registry: library.registry, taskIndex: library.taskIndex,
    assertMutationAllowed: application.assertMutationAllowed, hooks: [background.hooks], onEvent: event => background.onHostEvent(event),
    factory: async context => {
      const {store} = context; ensureProjectRow(store, {name: 'Frozen video identity'});
      const providers = createProviderRegistry({db: store.db, root: store.projectDir, env});
      const services = createServices(store, providers, {application, env, videoSettings: settings, deferBackgroundRecovery: true,
        profileNow: () => Date.UTC(2026, 9, 20), signal: context.signal,
        videoFetch: async () => {requests++; assert.fail('An unavailable frozen history cannot contact a provider');}});
      const state = createProjectBackgroundState(store), sourceHistory = backgroundHistorySource(store);
      let worker: ReturnType<typeof startWorker> | undefined;
      return {services, worker: () => worker, backgroundTasks: state, handle: async () => false,
        activateBackground() {services.activateBackground(); if (recovery) worker ??= startWorker(store, services, providers, {signal: context.signal});},
        isBusy: () => Boolean(worker?.isBusy()) || services.isBusy(), interrupt() {},
        drain: async () => {await worker?.stop(); await services.drain();}, dispose() {state.dispose();},
        unfinishedTasks: () => state.snapshot().filter(task => task.classification !== 'terminal').map(task => ({kind: task.kind, taskId: task.taskId,
          phase: task.keepAlive ? 'active' : 'blocked', reason: task.reason, taskRevision: task.taskRevision, sourceHistory})),
      };
    }});
  background.bindManager(manager);
  t.after(async () => {background.stop(); await manager.closeAll(); await settings.close(); library.close(); await rm(root, {recursive: true, force: true});});
  const oldSettings = settings as Awaited<ReturnType<typeof createVideoSettings>>, configured = configuration();
  await oldSettings.put({action: 'save', expectedRevision: 0, configuration: {...configured, archived: false}, secret});
  const project = await manager.create({name: 'Original accepted task'}), seed = await manager.acquire(project.projectId, 'window');
  const services = seed.host.runtime.services, shot = object(await services.call('shot.create', {projectId: project.projectId, title: 'Original', prompt: 'Synthetic shapes', aspectRatio: '9:16', duration: 4}));
  const requestId = randomUUID(), accepted = object(await services.call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision,
    requestId, providerId: 'minimax', connectionId: configured.id, configurationRevision: 1, modelEntryId: configured.models[0]!.id}));
  const original = seed.host.store.get('jobs', String(accepted.id)) as JobRecord, providerJobId = status === 'running' ? 'original-remote-task' : null;
  services.saveJob(original, {status, phase: status === 'queued' ? 'waiting' : 'polling', providerJobId, submissionCount: status === 'queued' ? 0 : 1, nextPollAt: 0});
  const frozen = seed.host.store.get('jobs', original.id) as JobRecord, binding = frozen.snapshot.executionBinding as VideoExecutionBinding;
  const receipt = seed.host.store.db.prepare("SELECT * FROM idempotency WHERE scope='generation' AND requestId=?").get(requestId);
  seed.release(); await manager.close(project.projectId); await oldSettings.close();
  const file = path.join(options.directory, 'settings.json'), bytes = await readFile(file, 'utf8'); assert.equal(JSON.parse(bytes).version, 1);
  const reset = await createVideoSettingsV2(options); settings = reset; recovery = true;
  assert.equal((await reset.get()).notice, 'VIDEO_SETTINGS_V1_RESET'); assert.equal(await readFile(file, 'utf8'), bytes);
  assert.throws(() => reset.assertBinding(binding), error => {
    assert.equal(object(error).code, 'VIDEO_BINDING_INVALID'); assert.equal(isVideoBindingHistoryUnavailable(error), true); return true;
  });
  const window = await manager.acquire(project.projectId, 'window'), runtime = window.host.runtime;
  await runtime.worker()!.tick();
  await until(() => manager.status(project.projectId)?.leases.task === 0, 'The unavailable configured task retained S3 forever');
  const current = window.host.store.get('jobs', frozen.id) as JobRecord;
  assert.equal(current.status, status); assert.equal(current.phase, 'connection_required'); assert.equal(object(current.error).code, 'VIDEO_SETTINGS_UNAVAILABLE');
  for (const key of ['id', 'projectId', 'shotId', 'requestId', 'requestHash', 'providerId', 'providerJobId', 'submissionCount', 'model', 'snapshot'] as const)
    assert.deepEqual(current[key], frozen[key], `${key}: recovery cannot replace a paid task identity`);
  assert.deepEqual(window.host.store.db.prepare("SELECT * FROM idempotency WHERE scope='generation' AND requestId=?").get(requestId), receipt);
  assert.equal(runtime.backgroundTasks!.snapshot().find(task => task.taskId === frozen.id)!.keepAlive, false);
  assert.equal(runtime.backgroundTasks!.snapshot().find(task => task.taskId === frozen.id)!.reason, 'VIDEO_SETTINGS_UNAVAILABLE');
  const indexed = library.taskIndex.listProject(project.projectId); assert.equal(indexed.length, 1); assert.equal(indexed[0]!.phase, 'blocked');
  assert.equal(indexed[0]!.reason, 'VIDEO_SETTINGS_UNAVAILABLE'); assert.equal(background.inspectProjectWork(project.projectId).mayWriteBack, true);
  const changes = window.host.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  await runtime.worker()!.tick();
  assert.deepEqual(window.host.store.get('jobs', frozen.id), current); assert.equal(window.host.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(window.host.store.list('assets').length, 0); assert.equal(window.host.store.list('versions').length, 0); assert.equal(requests, 0);
  assert.equal(await readFile(file, 'utf8'), bytes, 'background recovery cannot upgrade or rewrite generation settings');
  window.release(); await until(() => manager.status(project.projectId) === null, 'The blocked task prevented closing');
  const reopened = await manager.acquire(project.projectId, 'window'); await reopened.host.runtime.worker()!.tick();
  await until(() => manager.status(project.projectId)?.leases.task === 0, 'A repeated open cannot turn the retired binding into running work');
  assert.equal((reopened.host.store.get('jobs', frozen.id) as JobRecord).status, status); assert.equal(requests, 0);
  reopened.release(); await manager.close(project.projectId);
  await reset.put({action: 'save', expectedRevision: 0, configuration: configured, secret});
  const next = reset.select(configured.id, 1, configured.models[0]!.id); assert.notEqual(next.credentialRef, binding.credentialRef);
  await assert.rejects(reset.acquire(binding), error => {assert.equal(object(error).code, 'VIDEO_BINDING_INVALID'); assert.equal(isVideoBindingHistoryUnavailable(error), false); return true;});
  assert.equal(requests, 0, 're-entering identical key text never heals an old frozen credential reference');
});

test('missing video history has an unforgeable internal classification while malformed and tampered bindings keep the public invalid error', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 's3-g1-binding-'))), settings = await createVideoSettingsV2({directory: path.join(root, 'video-settings'), privateRoot: root});
  t.after(async () => {await settings.close(); await rm(root, {recursive: true, force: true});});
  const current = configuration(); await settings.put({action: 'save', expectedRevision: 0, configuration: current, secret});
  const binding = settings.select(current.id, 1, current.models[0]!.id), before = await readFile(path.join(root, 'video-settings', 'settings.json'), 'utf8');
  for (const missing of [{...binding, connectionId: randomUUID()}, {...binding, configurationRevision: 2}]) {
    let captured: unknown;
    assert.throws(() => settings.assertBinding(missing), error => {captured = error; return object(error).code === 'VIDEO_BINDING_INVALID' && isVideoBindingHistoryUnavailable(error);});
    assert.deepEqual(sanitizeVideoSettingsV2Error(captured), sanitizeVideoSettingsV2Error(videoSettingsV2Error('VIDEO_BINDING_INVALID')));
    assert.deepEqual(Object.keys(object(captured)).sort(), ['code', 'status']);
    assert.equal(isVideoBindingHistoryUnavailable({...object(captured)}), false);
    await assert.rejects(settings.acquire(missing), error => object(error).code === 'VIDEO_BINDING_INVALID' && isVideoBindingHistoryUnavailable(error));
  }
  for (const invalid of [{...binding, connectionId: binding.connectionId.toUpperCase()}, {...binding, configurationRevision: 0},
    {...binding, credentialRef: randomUUID()}, {...binding, unexpected: true}, {...binding, endpoint: 'https://other.example.com/v2'}]) {
    assert.throws(() => settings.assertBinding(invalid), error => object(error).code === 'VIDEO_BINDING_INVALID' && !isVideoBindingHistoryUnavailable(error));
    await assert.rejects(settings.acquire(invalid), error => object(error).code === 'VIDEO_BINDING_INVALID' && !isVideoBindingHistoryUnavailable(error));
  }
  assert.equal(isVideoBindingHistoryUnavailable(videoSettingsV2Error('VIDEO_BINDING_INVALID')), false);
  assert.equal(isVideoBindingHistoryUnavailable(null), false); assert.equal(isVideoBindingHistoryUnavailable('VIDEO_BINDING_INVALID'), false);
  assert.equal(await readFile(path.join(root, 'video-settings', 'settings.json'), 'utf8'), before);
  assert.equal(await settings.acquire(binding), secret.value, 'unrelated rejection cannot replace or invalidate the original credential');
});
