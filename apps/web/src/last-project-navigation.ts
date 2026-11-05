import { message as msg } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import type { LastProjectEnvelope } from '@mioon/contracts/last-project';

const uuid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;
const scope = /^[a-f0-9]{64}$/u;
export interface InitialProjectChoice {
  projectId: string | null;
  source: 'url' | 'remembered' | 'fallback' | 'none';
  notice: DisplayMessage | null;
}

export interface ProjectBootTicket { readonly generation: number; readonly selectionEpoch: number }
export function createProjectBootGuard(getSelectionEpoch: () => number) {
  let active = false, generation = 0;
  return {
    activate(): void { active = true; generation++; },
    deactivate(): void { active = false; generation++; },
    begin(): ProjectBootTicket { return Object.freeze({ generation: ++generation, selectionEpoch: getSelectionEpoch() }); },
    isCurrent(ticket: ProjectBootTicket): boolean { return active && ticket.generation === generation && ticket.selectionEpoch === getSelectionEpoch(); },
  };
}

/** Only an explicit URL selects a startup target. A locator observation still
 * establishes cache identity at the caller, but never selects a project. */
export function chooseInitialProject(projects: readonly { id: string }[], explicit: string | null, _observed: LastProjectEnvelope | null): InitialProjectChoice {
  const available = (id: string | null): id is string => typeof id === 'string' && uuid.test(id) && projects.some(project => project.id === id);
  if (available(explicit)) return { projectId: explicit, source: 'url', notice: null };
  return { projectId: null, source: 'none', notice: explicit !== null ? msg('projects.bootMissingEmpty') : null };
}

/** Once observed, a normal workspace's private storage identity is pinned for
 * this renderer. A reconnect must never borrow another workspace's cache. */
export function retainLastProjectScope(current: string | null, observed: string | null): string | null {
  if (observed !== null && !scope.test(observed)) throw Object.assign(new Error('最近项目的工作区身份无效。'), { code: 'LAST_PROJECT_SCOPE_MISMATCH' });
  if (current !== null && observed !== null && observed !== current) throw Object.assign(new Error('连接的工作区已变化，请重新打开页面。'), { code: 'LAST_PROJECT_SCOPE_MISMATCH' });
  return current ?? observed;
}

export function assertLastProjectBootIdentity(state: { identityBlocked: boolean; revision: number | null }): void {
  // A foreign companion file on initial discovery has not established any
  // authority. Disable locator/cache but keep normal manual editing available.
  // Once a baseline was verified, a different identity requires a new renderer.
  if (state.identityBlocked && state.revision !== null) throw Object.assign(new Error('最近项目记录的服务或工作区身份已变化，请重新打开页面。'), { code: 'LAST_PROJECT_SCOPE_MISMATCH' });
}

export interface PreferenceCacheIdentity { entryScope: string | null; cacheId: string | null }
/** `undefined` is the compatibility path for older non-App consumers. The App
 * opts in with null before discovery, which disables unverified local imports. */
export function preferenceCacheIdentity(projectId: string, verifiedScope: string | null | undefined): PreferenceCacheIdentity {
  if (verifiedScope === undefined) return { entryScope: 'normal', cacheId: projectId };
  if (verifiedScope === null) return { entryScope: 'normal:unverified', cacheId: null };
  if (!scope.test(verifiedScope)) return { entryScope: null, cacheId: null };
  return { entryScope: `normal:${verifiedScope}`, cacheId: `normal:${verifiedScope}:${projectId}` };
}
