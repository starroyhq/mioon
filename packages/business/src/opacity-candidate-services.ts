/** Internal candidate service assembly. The ordinary application never creates
 * a candidate store. Media checks reuse the fixed bounded source preflight
 * and export capability services; no provider service is constructed. */
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {isPromise} from 'node:util/types';
import {AppError} from '../../contracts/src/app-error.ts';
import {getOpacityCandidateAssembly} from './opacity-candidate-store.ts';
import {createOpacityCandidateDomain} from './opacity-candidate-domain.ts';

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const require = createRequire(import.meta.url);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => object(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function unavailable(): never {throw new AppError('RESTORE_OPERATION_UNAVAILABLE', 'This internal candidate operation is unavailable.', 409);}
const serviceStores = new WeakMap<object, object>();
/** Coordinators must use the exact service instance made for their store.
 * Properties and wrapper objects cannot confer this private registration. */
export function isOpacityCandidateServicesForStore(store: unknown, services: unknown): boolean {
  if (!object(store) || !object(services) || serviceStores.get(services) !== store) return false;
  getOpacityCandidateAssembly(store)?.checkpoint();
  return true;
}

export function createOpacityCandidateServices(store: unknown, options: {signal?: AbortSignal} = {}) {
  const candidate = getOpacityCandidateAssembly(store);
  if (!candidate || !object(store) || typeof store.get !== 'function') return unavailable();
  const assembly = candidate;
  assembly.checkpoint();
  const domain = createOpacityCandidateDomain(store);
  const lifetime = new AbortController();
  const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
  const admissionModule: unknown = require('./timeline-export-admission.mjs');
  if (!object(admissionModule) || typeof admissionModule.createTimelineExportAdmissionServices !== 'function') return unavailable();
  const exportAdmission: unknown = admissionModule.createTimelineExportAdmissionServices(store, {signal, hash});
  if (!object(exportAdmission) || !object(exportAdmission.handlers) || typeof exportAdmission.render !== 'function' || typeof exportAdmission.drain !== 'function') return unavailable();
  const drainAdmission = exportAdmission.drain;
  const preflightModule: unknown = require('./timeline-preflight.mjs');
  if (!object(preflightModule) || typeof preflightModule.createTimelinePreflightServices !== 'function') return unavailable();
  const preflight: unknown = preflightModule.createTimelinePreflightServices(store, {signal});
  if (!object(preflight) || !object(preflight.handlers) || typeof preflight.drain !== 'function') return unavailable();
  const drainPreflight = preflight.drain;
  // Concrete legacy entrypoint, not a caller-selected module/validator. Keep
  // this narrow checked boundary rather than pretending legacy JS is typed.
  const module: unknown = require('./timeline.mjs');
  if (!object(module) || typeof module.createTimelineServices !== 'function') return unavailable();
  const get = store.get;
  const made: unknown = module.createTimelineServices(store, {
    required(table: string, id: string): unknown {
      assembly.checkpoint();
      const value: unknown = get(table, id);
      if (!value) throw new AppError('NOT_FOUND', '找不到记录', 404, {id});
      return value;
    },
    check(value: unknown, expectedRevision: unknown): void {
      if (!object(value) || value.revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', '内容已有新版本，请重新读取后再修改', 409);
    },
    hash, now: () => new Date().toISOString(), exportAdmission,
  });
  if (!object(made) || !object(made.handlers)) return unavailable();
  const handlers = {...made.handlers, ...preflight.handlers, ...exportAdmission.handlers};
  const reads = new Set(['timeline.get', 'timeline.history.get']);
  const mutations = new Set(['timeline.clip.update', 'timeline.undo', 'timeline.redo', 'timeline.render']);
  const preparations = new Set(['timeline.export.preflight', 'timeline.export.capabilities']);
  async function call(operation: string, input: unknown, context: Value = {}): Promise<unknown> {
    assembly.checkpoint();
    if (lifetime.signal.aborted || options.signal?.aborted || !reads.has(operation) && !mutations.has(operation) && !preparations.has(operation)) return unavailable();
    if (preparations.has(operation) && context.signal !== undefined && !(context.signal instanceof AbortSignal)) return unavailable();
    const callSignal = preparations.has(operation) && context.signal instanceof AbortSignal ? AbortSignal.any([signal, context.signal]) : signal;
    const parsed = domain.parse(operation, input), handler = handlers[operation];
    if (typeof handler !== 'function') return unavailable();
    const invoke = (frozen: unknown): unknown => {
      assembly.refuseOperation(operation, frozen);
      const result: unknown = handler(frozen, {signal: callSignal});
      // Retain the actual asynchronous handler before checking its owner again.
      // A synchronous revocation must not discard an already rejecting read.
      if (isPromise(result)) return result.then((value: unknown) => {assembly.checkpoint();return value;});
      assembly.checkpoint();
      return result;
    };
    if (mutations.has(operation) || preparations.has(operation)) {
      if (assembly.getRestoreContext() && !assembly.hasInvocation(operation, parsed)) assembly.assertOrigin(context);
      return assembly.withInvocation(operation, assembly.freezeInput(parsed), {signal: callSignal}, invoke);
    }
    return invoke(parsed);
  }
  const services = Object.freeze({call, handlers: Object.freeze(Object.fromEntries([...reads, ...mutations, ...preparations].map(operation =>
    [operation, (input: unknown, context?: Value) => call(operation, input, context)]))),
    async drain(): Promise<void> {
      lifetime.abort();
      const settled = await Promise.allSettled([drainAdmission(), drainPreflight()]);
      for (const result of settled) if (result.status === 'rejected') throw result.reason;
    },
  });
  serviceStores.set(services, store);
  return services;
}
