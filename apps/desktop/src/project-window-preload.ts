import { PROJECT_WINDOW_CHANNEL, PROJECT_WINDOW_EVENT, isProjectWindowContext, isProjectWindowOpenResult,
  isProjectWindowId, isProjectWindowSettingsSlot, isProjectWindowEntryMode, isProjectWindowLocatorStatus, isProjectWindowLocatorAction } from './project-window-protocol.ts';
import type { ProjectWindowBridge, ProjectWindowContext, ProjectWindowRequest } from './project-window-protocol.ts';
interface WindowTransport {
  invoke(channel: typeof PROJECT_WINDOW_CHANNEL, request: ProjectWindowRequest): Promise<unknown>;
  on(channel: typeof PROJECT_WINDOW_EVENT, listener: (event: unknown, value: unknown) => void): void;
  removeListener(channel: typeof PROJECT_WINDOW_EVENT, listener: (event: unknown, value: unknown) => void): void;
}
const refused = () => new Error('Native window action is unavailable.');
const frozen = (value: ProjectWindowContext): ProjectWindowContext => Object.freeze({ ...value,
  entryReceipt: value.entryReceipt ? Object.freeze({ ...value.entryReceipt, result: Object.freeze({ ...value.entryReceipt.result }) }) : null,
  locatorStatus: value.locatorStatus ? Object.freeze({ ...value.locatorStatus }) : null,
  locatorIntent: value.locatorIntent ? Object.freeze({ ...value.locatorIntent }) : null });
/** Transport and Electron events never cross into the page. */
export function createProjectWindowBridge(transport: WindowTransport): ProjectWindowBridge {
  let identity: ProjectWindowContext | null = null;
  const checked = (value: unknown): ProjectWindowContext => {
    if (!isProjectWindowContext(value) || identity && (value.windowId !== identity.windowId || value.backendId !== identity.backendId ||
      value.contextId !== identity.contextId || value.role !== identity.role || value.initialProjectId !== identity.initialProjectId)) throw refused();
    identity ??= value;
    return frozen(value);
  };
  const context = async (): Promise<ProjectWindowContext> => {
    const value = await transport.invoke(PROJECT_WINDOW_CHANNEL, { action: 'describe' });
    return checked(value);
  };
  const booleanResult = (value: unknown): boolean => { if (typeof value !== 'boolean') throw refused(); return value; };
  const requestProjectEntry: ProjectWindowBridge['requestProjectEntry'] = async mode => {
    if (!isProjectWindowEntryMode(mode)) throw refused();
    const owner = await context();
    return booleanResult(await transport.invoke(PROJECT_WINDOW_CHANNEL, { action: 'project-entry', contextId: owner.contextId, mode }));
  };
  return Object.freeze({
    context, requestProjectEntry,
    async publishLocatorStatus(status) {
      if (!isProjectWindowLocatorStatus(status)) throw refused();
      const owner = await context();
      return booleanResult(await transport.invoke(PROJECT_WINDOW_CHANNEL, { action: 'locator-status', contextId: owner.contextId, status }));
    },
    async requestLocatorAction(action, expectedStatusVersion) {
      if (!isProjectWindowLocatorAction(action) || !Number.isSafeInteger(expectedStatusVersion) || expectedStatusVersion < 0) throw refused();
      const owner = await context();
      return booleanResult(await transport.invoke(PROJECT_WINDOW_CHANNEL, { action: 'locator-action', contextId: owner.contextId, locatorAction: action, expectedStatusVersion }));
    },
    async openProject(projectId, remember, entryToken) {
      if (!isProjectWindowId(projectId) || !isProjectWindowId(entryToken) || typeof remember !== 'boolean') throw refused();
      const owner = await context();
      const value = await transport.invoke(PROJECT_WINDOW_CHANNEL, { action: 'open', contextId: owner.contextId, projectId, remember, entryToken });
      if (!isProjectWindowOpenResult(value)) throw refused();
      return Object.freeze({ ...value });
    },
    showProjects: () => requestProjectEntry('open'),
    async showSettings(slot) {
      if (!isProjectWindowSettingsSlot(slot)) throw refused();
      const owner = await context();
      return booleanResult(await transport.invoke(PROJECT_WINDOW_CHANNEL, { action: 'settings', contextId: owner.contextId, slot }));
    },
    async editorStatus(projectId, phase) {
      if (!isProjectWindowId(projectId) || phase !== 'ready' && phase !== 'failed') throw refused();
      const owner = await context();
      return booleanResult(await transport.invoke(PROJECT_WINDOW_CHANNEL, { action: 'editor-status', contextId: owner.contextId, projectId, phase }));
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw refused();
      let active = true;
      const receive = (_event: unknown, value: unknown) => {
        if (!active) return;
        let next: ProjectWindowContext;
        try { next = checked(value); } catch { return; }
        listener(next);
      };
      transport.on(PROJECT_WINDOW_EVENT, receive);
      return () => { if (active) { active = false; transport.removeListener(PROJECT_WINDOW_EVENT, receive); } };
    },
  } satisfies ProjectWindowBridge);
}
