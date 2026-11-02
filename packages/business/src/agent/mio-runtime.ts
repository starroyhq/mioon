import type {AgentTaskRuntimeOptions} from './task-runtime-v2.ts';
import {createAgentTaskRuntime} from './task-runtime-v2.ts';
import type {AgentTaskJournal} from './task-journal-v2.ts';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {createMioRecords} from './mio-records.ts';
import {createMioAssembly} from './mio-assembly.ts';
import {createMioJournal} from './mio-journal.ts';

/** The host owns this application-library port and the project connection.
 * No server composition types or second database connection are needed here. */
export type MioPolicyPort = Pick<AgentTaskJournal, 'policy' | 'lookupPolicy' | 'updatePolicy'>;
export interface MioRuntimeOptions extends Omit<AgentTaskRuntimeOptions, 'store'> {
  readonly store: ProjectStore;
  readonly policy: MioPolicyPort;
}

/** One executor and cancellation scope per host. The caller drains the runtime
 * before closing its store; disposing the runtime never closes that store. */
export function createMioRuntime({store, policy, journal, ...options}: MioRuntimeOptions) {
  if (!isProjectStore(store)) throw Object.assign(new Error('A live kernel project store is required.'), {code: 'AGENT_TASK_STORAGE_UNAVAILABLE'});
  const source = journal ?? createMioJournal(store, {
    assembly: createMioAssembly(createMioRecords(store)),
    policy: () => policy.policy(),
    lookupPolicy: id => policy.lookupPolicy(id),
    updatePolicy: (input, id) => policy.updatePolicy(input, id),
  });
  const runtime = createAgentTaskRuntime({...options, store, journal: source});
  return {...runtime, interrupt: () => runtime.close(), dispose: () => runtime.close()};
}
export type MioRuntime = ReturnType<typeof createMioRuntime>;

/** The server adapts its existing HTTP/SSE handler to this structural port.
 * Keeping the request generic avoids a dependency on a future server module. */
export interface MioTransport<Request> {
  handle(request: Request): Promise<boolean>;
  interrupt(): void;
  drain?(): Promise<void>;
  dispose?(): void;
}

export function createMioRuntimePort<Request>(options: MioRuntimeOptions & {
  readonly createTransport: (runtime: MioRuntime) => MioTransport<Request>;
}) {
  const {createTransport, ...runtimeOptions} = options;
  const runtime = createMioRuntime(runtimeOptions);
  let transport: MioTransport<Request>;
  try {transport = createTransport(runtime);} catch (error) {runtime.close(); throw error;}
  let interrupted = false, disposed = false;
  const requests = new Set<Promise<boolean>>();
  const interrupt = (): void => {
    if (interrupted) return;
    interrupted = true;
    try {transport.interrupt();} finally {runtime.close();}
  };
  return {
    handle(request: Request): Promise<boolean> {
      if (interrupted) return Promise.resolve(false);
      const pending = Promise.resolve().then(() => interrupted ? false : transport.handle(request));
      requests.add(pending);
      void pending.then(() => requests.delete(pending), () => requests.delete(pending));
      return pending;
    },
    isBusy: (): boolean => requests.size > 0 || runtime.isBusy(),
    interrupt,
    async drain(): Promise<void> {
      // Both scopes must settle before the host closes the shared connection.
      const failures: unknown[] = [];
      const transportDrain = Promise.resolve().then(() => transport.drain?.());
      // A transport may expose only handle/interrupt. Track accepted requests
      // here as well, including work awaiting before it starts an executor.
      do {
        const settled = await Promise.allSettled([runtime.drain(), transportDrain, ...requests]);
        for (const result of settled) if (result.status === 'rejected' && !failures.includes(result.reason)) failures.push(result.reason);
        await runtime.drain();
      } while (requests.size);
      if (failures.length) throw new AggregateError(failures, 'Mio runtime drain failed');
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {interrupt();} finally {transport.dispose?.();}
    },
  };
}
