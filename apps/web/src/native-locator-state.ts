import type { LastProjectController, LastProjectState } from './last-project-state.ts';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';
import type { ProjectWindowLocatorStatus } from '../../desktop/src/project-window-protocol.ts';
function fields(state: LastProjectState) {
  return { phase: state.phase, uncertain: state.uncertain, identityBlocked: state.identityBlocked,
    canRetry: state.canRetry, canRecheck: state.canRecheck, reading: state.reading, rechecked: state.rechecked !== null };
}
/** Bounded status leaves the launcher; CAS bodies and recovery remain here.
 * An intent is consumed once before invoking any existing locator operation. */
export function createNativeLocatorOwner({ context, bridge, locator }: {
  context: ProjectWindowContext; bridge: ProjectWindowBridge; locator: LastProjectController;
}) {
  let active = false, generation = 0, version = 0, confirmedVersion = 0, seenIntent = 0, previous = '', status: ProjectWindowLocatorStatus | null = null;
  const publications = new Set<ProjectWindowLocatorStatus>();
  function deliver(value: ProjectWindowLocatorStatus) {
    if (!active || publications.has(value)) return;
    const owner = generation;
    publications.add(value);
    let work: Promise<boolean>;
    try { work = bridge.publishLocatorStatus(value); }
    catch { publications.delete(value); return; }
    void work.then(accepted => {
      if (active && owner === generation && accepted) confirmedVersion = Math.max(confirmedVersion, value.statusVersion);
    }, () => { /* Only a later verified host observation can authorize metadata repair. */ })
      .finally(() => { publications.delete(value); });
  }
  function publish() {
    if (!active) return;
    const value = fields(locator.getState()), key = JSON.stringify(value);
    if (key === previous) return;
    previous = key;
    status = Object.freeze({ version: 1, statusVersion: ++version, ...value });
    deliver(status);
  }
  return {
    activate() { active = true; generation++; previous = ''; publish(); }, dispose() { active = false; generation++; }, publish,
    receive(next: ProjectWindowContext) {
      if (!active || next.role !== 'launcher' || next.contextId !== context.contextId || next.backendId !== context.backendId || next.windowId !== context.windowId) return;
      publish();
      if (status && next.locatorStatus?.statusVersion === status.statusVersion &&
          (Object.keys(status) as Array<keyof ProjectWindowLocatorStatus>).every(key => next.locatorStatus?.[key] === status![key])) {
        confirmedVersion = Math.max(confirmedVersion, status.statusVersion);
      }
      // A failed publication never mints a new status or triggers a timer.
      // Only this document's explicit missing/older host observation resends
      // the exact current envelope. Delayed events cannot undo a known ACK.
      if (!next.quitting && status && status.statusVersion > confirmedVersion &&
          (!next.locatorStatus || next.locatorStatus.statusVersion < status.statusVersion)) deliver(status);
      const intent = next.locatorIntent;
      if (!intent || intent.intentVersion <= seenIntent) return;
      seenIntent = intent.intentVersion;
      // Refresh synchronously, so a same-stack locator change that has not yet
      // reached main cannot authorize a stale recovery button.
      if (next.quitting || !status || intent.expectedStatusVersion !== status.statusVersion) return;
      if (intent.action === 'recheck' && status.canRecheck) void locator.recheck();
      if (intent.action === 'retry' && status.canRetry) void locator.retry();
    },
    getStatus: () => status,
  };
}
export type NativeLocatorOwner = ReturnType<typeof createNativeLocatorOwner>;
