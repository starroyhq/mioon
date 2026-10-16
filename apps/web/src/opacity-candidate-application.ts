/** Created only by the separate internal candidate entry. A server response,
 * profile string or copy of this token cannot select the application branch. */
import {createOpacityCandidateClientBinding} from './opacity-candidate-client-binding.ts';
import {createOpacityCandidateInspectorBinding} from './clip-opacity-candidate-assembly.ts';
import {createOpacityCandidateBrowserContracts, type OpacityBrowserLegacyContracts} from './opacity-candidate-browser-contracts.ts';

export type OpacityCandidateApplication = Readonly<{kind: 'internal-opacity-application'}>;
type RpcOptions = {signal?: AbortSignal; expectedWorkspaceOrigin?: string};
type Value = Record<string, unknown>;
export interface OpacityCandidateTaskClient {
  prepare(input: Value, options?: Value): Promise<unknown>;
  list(input: {projectId: string; limit?: number; cursor?: string; pendingOnly?: boolean}): Promise<unknown>;
  get(input: Value): Promise<unknown>;
  execute(input: Value, options?: Value): Promise<unknown>;
  reconcile(input: Value, options?: Value): Promise<unknown>;
  acknowledge(input: Value, options?: Value): Promise<unknown>;
}
export interface OpacityCandidateApplicationRuntime extends OpacityBrowserLegacyContracts {
  rpc(operation: string, input: Value, options: RpcOptions & {fetcher: typeof fetch; opacityBinding?: object}): Promise<unknown>;
  createEditTaskClient(options: {fetcher: typeof fetch; opacityBinding: object}): OpacityCandidateTaskClient;
}
function fault(): never {throw Object.assign(new Error('Invalid candidate application acknowledgement.'), {code: 'BACKEND_PROTOCOL_ERROR'});}
function application(runtime: OpacityCandidateApplicationRuntime, fetcher: typeof fetch) {
  const contracts = createOpacityCandidateBrowserContracts(runtime);
  const sharedRpc = runtime.rpc;
  const opacityBinding = createOpacityCandidateClientBinding(contracts);
  const taskClient = runtime.createEditTaskClient({fetcher, opacityBinding});
  let inspectedWorkspace: Value | null = null;
  return Object.freeze({taskClient, inspectorBinding: createOpacityCandidateInspectorBinding(fetcher),
    ...contracts,
    validateProjectSnapshot(value: unknown, projectId?: unknown): boolean {
      return contracts.validateProjectSnapshot(value, projectId, inspectedWorkspace);
    },
    async rpc(operation: string, input: Record<string, unknown> = {}, options: RpcOptions = {}): Promise<unknown> {
      const schema = contracts.schemas[operation];
      if (schema && !schema.safeParse(input).success) return fault();
      const result: unknown = await sharedRpc(operation, input, {...options, fetcher, opacityBinding});
      if (operation === 'workspace.restore.inspect') {
        if (!contracts.isWorkspaceInspection(result) || !result || typeof result !== 'object') return fault();
        const observed = result as Value;
        if (inspectedWorkspace && (observed.restored !== inspectedWorkspace.restored || observed.workspaceOrigin !== inspectedWorkspace.workspaceOrigin)) return fault();
        inspectedWorkspace ??= Object.freeze(structuredClone(observed));
      }
      if (['timeline.track.add', 'timeline.track.update', 'timeline.clip.add', 'timeline.clip.update', 'timeline.clip.remove', 'timeline.undo', 'timeline.redo', 'timeline.render'].includes(operation) &&
        !contracts.isTimelineMutationResponse(operation, input, result)) return fault();
      if (operation === 'project.get' && !contracts.validateProjectSnapshot(result, input.projectId, inspectedWorkspace)) return fault();
      if (operation === 'timeline.get' && !contracts.isTimelineRecord(result, {projectId: input.projectId})) return fault();
      return result;
    },
  });
}
type Application = ReturnType<typeof application>;
const applications = new WeakMap<object, Application>();
export function createOpacityCandidateApplication(runtime: OpacityCandidateApplicationRuntime, fetcher: typeof fetch = (...args) => fetch(...args)): OpacityCandidateApplication {
  const token = Object.freeze({kind: 'internal-opacity-application'} as const);applications.set(token, application(runtime, fetcher));return token;
}
export function readOpacityCandidateApplication(value: unknown): Application | null {
  return value !== null && typeof value === 'object' ? applications.get(value) ?? null : null;
}
