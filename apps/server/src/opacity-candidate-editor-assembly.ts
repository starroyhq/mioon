/** Internal editor composition for an exact application-owned42/43 store.
 * This is not selected by an HTTP payload and opens no listener or worker. */
import {createRequire} from 'node:module';
import {AppError} from '../../../packages/contracts/src/app-error.ts';
import {getOpacityCandidateAssembly} from '../../../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateServices} from '../../../packages/business/src/opacity-candidate-services.ts';
import {createOpacityCandidateLocalDrafts} from '../../../packages/business/src/opacity-candidate-local-drafts.ts';
import {createLocalDraftHttp} from './local-drafts-http.ts';

type Value = Record<string, unknown>;
type Method = (...args: unknown[]) => unknown;
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const require = createRequire(import.meta.url);
function unavailable(): never {throw new AppError('RESTORE_OPERATION_UNAVAILABLE', 'This internal editor assembly is unavailable.', 409);}

/** Fixed dependencies only: caller options cannot replace the store proof,
 * service, task coordinator, companion codec or historical validators. */
export function createOpacityCandidateEditorAssembly(store: unknown) {
  const candidate = getOpacityCandidateAssembly(store);
  if (!candidate) return unavailable();
  const assembly = candidate, lifetime = new AbortController();
  const checkpoint = (): void => {
    assembly.checkpoint();
    if (lifetime.signal.aborted || getOpacityCandidateAssembly(store) !== assembly) unavailable();
  };
  checkpoint();
  const services = createOpacityCandidateServices(store, {signal: lifetime.signal});
  // A concrete existing legacy entrypoint, with a small checked boundary.
  // No ambient declaration pretends the coordinator is TypeScript.
  const module: unknown = require('../../../packages/business/src/edit-tasks.mjs');
  if (!object(module) || typeof module.createEditTasks !== 'function') return unavailable();
  const made: unknown = Reflect.apply(module.createEditTasks, module, [{store, services}]);
  const names = ['prepare', 'get', 'list', 'execute', 'reconcile', 'acknowledge', 'reconcileStartup', 'drain'] as const;
  if (!object(made) || names.some(name => typeof made[name] !== 'function')) return unavailable();
  const coordinator = made;
  const invoke = (name: typeof names[number], args: unknown[]): unknown => {
    checkpoint();
    const method = coordinator[name];
    if (typeof method !== 'function') return unavailable();
    return Reflect.apply(method as Method, coordinator, args);
  };
  const tasks = Object.freeze({
    prepare: (input: unknown, context?: Value) => invoke('prepare', [input, context]),
    get: (input: unknown) => invoke('get', [input]),
    list: (input: unknown) => invoke('list', [input]),
    execute: async (input: unknown, context?: Value): Promise<unknown> => invoke('execute', [input, context]),
    reconcile: (input: unknown, context?: Value) => invoke('reconcile', [input, context]),
    acknowledge: (input: unknown, context?: Value) => invoke('acknowledge', [input, context]),
    reconcileStartup: () => invoke('reconcileStartup', []),
  });
  const drafts = createOpacityCandidateLocalDrafts(store, {signal: lifetime.signal});
  const localDraftHttp = createLocalDraftHttp({drafts, signal: lifetime.signal});
  let draining: Promise<void> | undefined;
  function drain(): Promise<void> {
    if (draining) return draining;
    lifetime.abort();
    const method = coordinator.drain;
    const taskDrain = Promise.resolve().then(() => typeof method === 'function' ? Reflect.apply(method as Method, coordinator, []) : undefined);
    draining = Promise.allSettled([taskDrain, services.drain()]).then(() => {});
    return draining;
  }
  return Object.freeze({services, tasks, localDraftHttp, drain});
}
