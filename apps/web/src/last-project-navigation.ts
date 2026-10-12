import type { LastProjectEnvelope } from '@mioon/contracts/last-project';

const uuid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;
const scope = /^[a-f0-9]{64}$/u;
export interface InitialProjectChoice {
  projectId: string | null;
  source: 'url' | 'remembered' | 'fallback' | 'none';
  notice: string | null;
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

/** Selects a display target only. It never persists a selection or grants an
 * operation authority; callers must still load and validate the project. */
export function chooseInitialProject(projects: readonly { id: string }[], explicit: string | null, observed: LastProjectEnvelope | null): InitialProjectChoice {
  const available = (id: string | null): id is string => typeof id === 'string' && uuid.test(id) && projects.some(project => project.id === id);
  if (available(explicit)) return { projectId: explicit, source: 'url', notice: null };
  const remembered = observed?.supported ? observed.projectId : null;
  if (observed?.supported && observed.targetStatus === 'matching' && available(remembered)) {
    return { projectId: remembered, source: 'remembered', notice: explicit ? '指定链接中的项目不存在，已打开此工作区最近保存的位置。' : null };
  }
  const first = projects.find(project => uuid.test(project.id))?.id ?? null;
  const missing = explicit ? '指定链接中的项目不存在。' : remembered ? '上次记住的项目已不可用。' : null;
  return { projectId: first, source: first ? 'fallback' : 'none', notice: missing ? `${missing}${first ? '已打开列表中的首个项目；可另行选择。' : '请选择或新建项目。'}` : null };
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
export function preferenceCacheIdentity(originScope: string | null, projectId: string, verifiedScope: string | null | undefined): PreferenceCacheIdentity {
  if (originScope === null) return { entryScope: null, cacheId: null };
  if (originScope.startsWith('restored:')) return { entryScope: originScope, cacheId: `restore:${originScope.slice(9)}:${projectId}` };
  if (originScope !== 'normal') return { entryScope: null, cacheId: null };
  if (verifiedScope === undefined) return { entryScope: 'normal', cacheId: projectId };
  if (verifiedScope === null) return { entryScope: 'normal:unverified', cacheId: null };
  if (!scope.test(verifiedScope)) return { entryScope: null, cacheId: null };
  return { entryScope: `normal:${verifiedScope}`, cacheId: `normal:${verifiedScope}:${projectId}` };
}
