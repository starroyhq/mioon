import { PROJECT_WINDOW_CHANNEL, PROJECT_WINDOW_EVENT, isProjectWindowContext, isProjectWindowOpenResult,
  isProjectWindowId, isProjectWindowSettingsSlot } from './project-window-protocol.ts';
import type { ProjectWindowBridge, ProjectWindowContext, ProjectWindowRequest } from './project-window-protocol.ts';

interface WindowTransport {
  invoke(channel: typeof PROJECT_WINDOW_CHANNEL, request: ProjectWindowRequest): Promise<unknown>;
  on(channel: typeof PROJECT_WINDOW_EVENT, listener: (event: unknown, value: unknown) => void): void;
  removeListener(channel: typeof PROJECT_WINDOW_EVENT, listener: (event: unknown, value: unknown) => void): void;
}
const refused = () => new Error('Native window action is unavailable.');
/** The transport and Electron event never cross into the page. No generic IPC,
 * file paths, backend token, business commands or arbitrary target URLs. */
export function createProjectWindowBridge(transport: WindowTransport): ProjectWindowBridge {
  const context = async (): Promise<ProjectWindowContext> => {
    const value = await transport.invoke(PROJECT_WINDOW_CHANNEL, { action: 'describe' });
    if (!isProjectWindowContext(value)) throw refused();
    return Object.freeze({ ...value });
  };
  const booleanResult = (value: unknown): boolean => { if (typeof value !== 'boolean') throw refused(); return value; };
  return Object.freeze({
    context,
    async openProject(projectId: string, remember = true) {
      if (!isProjectWindowId(projectId) || typeof remember !== 'boolean') throw refused();
      const owner = await context();
      const value = await transport.invoke(PROJECT_WINDOW_CHANNEL, { action: 'open', contextId: owner.contextId, projectId, remember });
      if (!isProjectWindowOpenResult(value)) throw refused();
      return Object.freeze({ ...value });
    },
    async showProjects() {
      const owner = await context();
      return booleanResult(await transport.invoke(PROJECT_WINDOW_CHANNEL, { action: 'projects', contextId: owner.contextId }));
    },
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
      const receive = (_event: unknown, value: unknown) => { if (active && isProjectWindowContext(value)) listener(Object.freeze({ ...value })); };
      transport.on(PROJECT_WINDOW_EVENT, receive);
      return () => { if (active) { active = false; transport.removeListener(PROJECT_WINDOW_EVENT, receive); } };
    },
  } satisfies ProjectWindowBridge);
}
