import { useEffect } from 'react';
import type { ProjectWindowBridge, ProjectWindowContext, ProjectWindowSettingsSlot } from './desktop-window-client.ts';
import { isProjectWindowId } from '../../desktop/src/project-window-protocol.ts';
export interface EditorWindowBinding { readonly context: ProjectWindowContext; readonly bridge: ProjectWindowBridge }
/** Native launcher is the sole startup selector. Existing Web selection remains
 * the caller's original URL/locator/list result. No business action is added. */
export function editorInitialSelection(binding: EditorWindowBinding | null, webChoice: { projectId: string | null; notice?: string }): { projectId: string | null; notice?: string } {
  if (!binding) return webChoice;
  if (binding.context.role !== 'editor' || !isProjectWindowId(binding.context.initialProjectId)) throw new Error('编辑窗口没有有效的固定项目。');
  return { projectId: binding.context.initialProjectId, notice: '' };
}
/** Status reports have no locator write authority. The persistent launcher is
 * the sole native locator writer, ordered by main's explicit selection intent. */
export async function reportEditorWindowStatus(binding: EditorWindowBinding, projectId: string, phase: 'ready' | 'failed', options: {
  isCurrent?(): boolean;
  rememberProject?(projectId: string): unknown;
} = {}): Promise<boolean> {
  const captured = binding.context;
  if (options.isCurrent?.() === false || captured.role !== 'editor' || captured.initialProjectId !== projectId ||
      captured.editorProjectId !== projectId || !isProjectWindowId(projectId)) return false;
  const fresh = await binding.bridge.context();
  if (options.isCurrent?.() === false || fresh.contextId !== captured.contextId || fresh.windowId !== captured.windowId ||
      fresh.backendId !== captured.backendId || fresh.role !== 'editor' || fresh.initialProjectId !== projectId || fresh.quitting) return false;
  const accepted = await binding.bridge.editorStatus(projectId, phase);
  return accepted === true && options.isCurrent?.() !== false;
}
export function useEditorWindowStatus(binding: EditorWindowBinding | null, projectId: string | null, phase: string, ready: boolean,
  _rememberProject?: (projectId: string) => unknown) {
  useEffect(() => {
    if (!binding || !projectId || !isProjectWindowId(projectId) || (!ready && phase !== 'error')) return;
    let active = true;
    void reportEditorWindowStatus(binding, projectId, ready ? 'ready' : 'failed', { isCurrent: () => active }).catch(() => {});
    return () => { active = false; };
  }, [binding?.bridge, binding?.context.contextId, binding?.context.quitting, projectId, phase, ready]);
}
/** Navigation to a separate settings owner preserves the composer. The current
 * consent is invalidated through its existing visibility method; no send/load is
 * created by this function. Only the still-mounted caller may reactivate. */
export async function openNativeSettings(binding: EditorWindowBinding, slot: ProjectWindowSettingsSlot): Promise<boolean> {
  try { return await binding.bridge.showSettings(slot); } catch { return false; }
}
export function revealNativeProjects(binding: EditorWindowBinding): void { void binding.bridge.showProjects().catch(() => {}); }
