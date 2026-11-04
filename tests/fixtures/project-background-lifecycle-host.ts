import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openAppLibrary} from '../../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../../packages/business/src/project-service-application.ts';
import {createServices} from '../../packages/business/src/services.ts';
import type {Provider, ProviderContext} from '../../packages/business/src/provider-registry.ts';
import {startWorker} from '../../packages/business/src/jobs.ts';
import {createProjectBackgroundState} from '../../packages/business/src/background-task-state.ts';
import {createProjectHostManager} from '../../apps/server/src/project-host/manager.ts';
import {createBackgroundCoordinator} from '../../apps/server/src/project-host/background-coordinator.ts';
import {backgroundHistorySource} from '../../apps/server/src/project-host/background-history.ts';
import {serverAppDirectories} from '../../apps/server/src/project-host/directories.ts';
import {ensureProjectRow} from '../../apps/server/src/project-host/project-initialization.ts';
import type {ProjectHostRuntime} from '../../apps/server/src/project-host/host.ts';

export interface LifecycleRuntime extends ProjectHostRuntime {
  readonly services: ReturnType<typeof createServices>;
  readonly worker: () => ReturnType<typeof startWorker> | undefined;
}
/** The production kernel, B1, domains, publication and worker. Only the trusted
 * embedded Provider uses a parent-owned loopback server as its remote service. */
export function createBackgroundLifecycleHost({dataDir, remote}: {dataDir: string; remote: string}) {
  const directories = serverAppDirectories(dataDir), library = openAppLibrary({dataDir});
  const guard = createProjectServiceApplication(library, undefined, {MIOON_ENABLE_LIVE_PROVIDER: '1'});
  const background = createBackgroundCoordinator({index: library.taskIndex, inbox: library.inbox,
    assertMutationAllowed: guard.assertMutationAllowed, checkIntervalMs: 20});
  const manager = createProjectHostManager<LifecycleRuntime>({directories, registry: library.registry, taskIndex: library.taskIndex,
    assertMutationAllowed: guard.assertMutationAllowed, hooks: [background.hooks], onEvent: event => background.onHostEvent(event),
    factory: async context => {
      const {store} = context; ensureProjectRow(store, {name: library.registry.get(context.projectId)!.name});
      const source = backgroundHistorySource(store);
      const signal = (value: ProviderContext): AbortSignal | undefined => value.signal ?? undefined;
      const post = async (route: string, value: unknown, call: ProviderContext) => {
        const response = await fetch(remote + route, {method: 'POST', body: JSON.stringify(value), headers: {'content-type': 'application/json'}, signal: signal(call)});
        assert.equal(response.status, 200); return await response.json();
      };
      const provider: Provider = {id: 'ark', capabilities: {models: ['fixture'], inputModes: ['text'], aspectRatios: ['9:16'], durations: [4],
        configured: true, enabled: true, mock: false, minPollIntervalMs: 20},
        submit: async (_snapshot, call) => {
          call.beforeSubmit?.();
          assert.ok(library.taskIndex.listProject(store.projectId).some(entry => entry.kind === 'job'
            && entry.taskId === call.jobId && entry.sourceHistory === source && entry.phase === 'active'), 'S3 indexes the committed job before provider dispatch');
          return post('/submit', {requestId: call.requestId, jobId: call.jobId}, call);
        },
        reconcile: async (requestId, call) => post('/reconcile', {requestId}, call),
        poll: async (providerJobId, call) => post('/poll', {providerJobId}, call),
        download: async (providerJobId, destination, call) => {
          const response = await fetch(remote + '/download/' + encodeURIComponent(providerJobId), {signal: signal(call)});
          assert.equal(response.status, 200);
          await writeFile(destination, Buffer.from(await response.arrayBuffer()), {mode: 0o600});
        }};
      const providers = new Map([['ark', provider]]), services = createServices(store, providers, {application: guard,
        env: {MIOON_ENABLE_LIVE_PROVIDER: '1'}, signal: context.signal, deferBackgroundRecovery: true});
      const state = createProjectBackgroundState(store);
      let worker: ReturnType<typeof startWorker> | undefined;
      return {services, worker: () => worker, backgroundTasks: state, handle: async () => false,
        activateBackground() {services.activateBackground(); worker ??= startWorker(store, services, providers, {signal: context.signal});},
        isBusy: () => Boolean(worker?.isBusy()) || services.isBusy(),
        interrupt() {},
        drain: async () => {await worker?.stop(); await services.drain();},
        dispose() {state.dispose();},
        unfinishedTasks: () => state.snapshot().filter(item => item.classification !== 'terminal').map(item => ({kind: item.kind, taskId: item.taskId,
          sourceHistory: source, phase: item.keepAlive ? 'active' : 'blocked', reason: item.reason, taskRevision: item.taskRevision})),
      };
    }});
  background.bindManager(manager);
  let closing: Promise<void> | undefined;
  return {manager, library, background,
    restore: async () => {const result = await manager.restore(); background.acceptRestore(result); return result;},
    close: () => closing ??= (async () => {background.stop(); await manager.closeAll(); library.close();})(),
  };
}
