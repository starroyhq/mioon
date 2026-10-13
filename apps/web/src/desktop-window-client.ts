import { isProjectWindowContext, isProjectWindowId, isProjectWindowOpenResult, isProjectWindowSettingsSlot } from '../../desktop/src/project-window-protocol.ts';
import type { ProjectWindowBridge, ProjectWindowContext, ProjectWindowSettingsSlot } from '../../desktop/src/project-window-protocol.ts';
export type { ProjectWindowBridge, ProjectWindowContext, ProjectWindowSettingsSlot } from '../../desktop/src/project-window-protocol.ts';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = () => new Error('桌面窗口身份尚未得到有效确认，请保留当前窗口。');

/** A missing preload means Web. A present but invalid preload never falls back
 * to mounting App, and query strings cannot choose the native renderer role. */
export function readDesktopWindowBridge(host: unknown = globalThis): ProjectWindowBridge | null {
  if (!record(host) || !Object.hasOwn(host, '__mioonProjectWindow')) return null;
  const source: unknown = host.__mioonProjectWindow;
  if (!record(source) || !['context', 'openProject', 'showProjects', 'showSettings', 'editorStatus', 'subscribe'].every(key => typeof source[key] === 'function')) throw failure();
  const { context, openProject, showProjects, showSettings, editorStatus, subscribe } = source;
  if (typeof context !== 'function' || typeof openProject !== 'function' || typeof showProjects !== 'function' || typeof showSettings !== 'function' || typeof editorStatus !== 'function' || typeof subscribe !== 'function') throw failure();
  let identity: ProjectWindowContext | null = null;
  const checked = (value: unknown): ProjectWindowContext => {
    if (!isProjectWindowContext(value) || value.role === 'editor' && value.initialProjectId === null ||
      identity && (value.contextId !== identity.contextId || value.backendId !== identity.backendId || value.role !== identity.role || value.initialProjectId !== identity.initialProjectId)) throw failure();
    identity ??= value;
    return Object.freeze({ ...value });
  };
  const boolean = (value: unknown): boolean => { if (typeof value !== 'boolean') throw failure(); return value; };
  return Object.freeze({
    context: async () => checked(await context()),
    async openProject(projectId: string, remember = true) {
      if (!isProjectWindowId(projectId) || typeof remember !== 'boolean') throw failure();
      const value: unknown = await openProject(projectId, remember);
      if (!isProjectWindowOpenResult(value)) throw failure();
      return Object.freeze({ ...value });
    },
    showProjects: async () => boolean(await showProjects()),
    async showSettings(slot: ProjectWindowSettingsSlot) { if (!isProjectWindowSettingsSlot(slot)) throw failure(); return boolean(await showSettings(slot)); },
    async editorStatus(projectId: string, phase: 'ready' | 'failed') {
      if (!isProjectWindowId(projectId) || phase !== 'ready' && phase !== 'failed') throw failure();
      return boolean(await editorStatus(projectId, phase));
    },
    subscribe(listener: (context: ProjectWindowContext) => void) {
      const release: unknown = subscribe((value: unknown) => {
        // A malformed or foreign late event cannot replace this live owner.
        let next: ProjectWindowContext;
        try { next = checked(value); } catch { return; }
        listener(next);
      });
      if (typeof release !== 'function') throw failure();
      return () => { release(); };
    },
  });
}
