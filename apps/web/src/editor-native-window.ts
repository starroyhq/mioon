import { useEffect, useRef } from 'react';
import type { ProjectWindowBridge, ProjectWindowContext, ProjectWindowSettingsSlot } from './desktop-window-client.ts';
import { isProjectWindowContext, isProjectWindowId } from '../../desktop/src/project-window-protocol.ts';
export interface EditorWindowBinding { readonly context: ProjectWindowContext; readonly bridge: ProjectWindowBridge }
/** Native launcher is the sole startup selector. Existing Web selection remains
 * the caller's original URL/locator/list result. No business action is added. */
export function editorInitialSelection(binding: EditorWindowBinding | null, webChoice: { projectId: string | null; notice?: string }): { projectId: string | null; notice?: string } {
  if (!binding) return webChoice;
  if (binding.context.role !== 'editor' || !isProjectWindowId(binding.context.initialProjectId)) throw new Error('编辑窗口没有有效的固定项目。');
  return { projectId: binding.context.initialProjectId, notice: '' };
}
const rememberedVersions = new WeakMap<ProjectWindowBridge, { backendId: string; version: number }>();
/** Report verified renderer readiness first. Remembering uses only the existing
 * caller's locator; native IPC neither writes it nor accepts a business payload.
 * A fresh context read fences superseded intent, quit and document replacement. */
export async function reportEditorWindowStatus(binding: EditorWindowBinding, projectId: string, phase: 'ready' | 'failed', options: {
  isCurrent?(): boolean;
  rememberProject?(projectId: string): unknown;
} = {}): Promise<boolean> {
  const captured = binding.context, version = captured.rememberVersion ?? 0;
  let observedCurrent = true;
  const current = () => observedCurrent && options.isCurrent?.() !== false;
  if (!current() || !isProjectWindowId(projectId)) return false;
  const mayRemember = phase === 'ready' && Boolean(options.rememberProject) && captured.role === 'editor' && !captured.quitting &&
    Number.isSafeInteger(version) && version > 0;
  // React cleanup can lag behind a native event. Observe synchronously while
  // awaiting status/describe so an old reply cannot erase a newer quit, failed
  // opening or explicit selection. Same-version readiness polling is harmless.
  const release = mayRemember ? binding.bridge.subscribe(next => {
    if (!isProjectWindowContext(next) || next.contextId !== captured.contextId || next.backendId !== captured.backendId ||
        next.role !== 'editor' || next.quitting || next.rememberVersion !== version ||
        next.editorProjectId !== projectId || next.editorPhase === 'failed') observedCurrent = false;
  }) : undefined;
  try {
    const accepted = await binding.bridge.editorStatus(projectId, phase);
    if (accepted !== true || !current()) return false;
    if (!mayRemember) return true;
    const fresh = await binding.bridge.context();
    if (!current() || !isProjectWindowContext(fresh) || fresh.contextId !== captured.contextId ||
        fresh.backendId !== captured.backendId || fresh.role !== 'editor' || fresh.quitting ||
        fresh.editorPhase !== 'ready' || fresh.editorProjectId !== projectId || fresh.rememberVersion !== version) return true;
    const previous = rememberedVersions.get(binding.bridge);
    if (previous?.backendId === fresh.backendId && previous.version >= version) return true;
    // Consume before the callback. Re-renders or a throwing locator must not turn
    // one explicit native selection into a retry of a metadata write.
    rememberedVersions.set(binding.bridge, { backendId: fresh.backendId, version });
    options.rememberProject?.(projectId);
    return true;
  } finally { release?.(); }
}
export function useEditorWindowStatus(binding: EditorWindowBinding | null, projectId: string | null, phase: string, ready: boolean,
  rememberProject?: (projectId: string) => unknown) {
  const remember = useRef(rememberProject);
  remember.current = rememberProject;
  useEffect(() => {
    if (!binding || !projectId || !isProjectWindowId(projectId) || (!ready && phase !== 'error')) return;
    let active = true;
    // Host independently verifies this exact document URL and owned backend.
    void reportEditorWindowStatus(binding, projectId, ready ? 'ready' : 'failed', {
      isCurrent: () => active,
      ...(remember.current ? { rememberProject: (id: string) => remember.current?.(id) } : {}),
    }).catch(() => {});
    return () => { active = false; };
  }, [binding?.bridge, binding?.context.contextId, binding?.context.rememberVersion, binding?.context.quitting, projectId, phase, ready, Boolean(rememberProject)]);
}
/** Navigation to a separate settings owner preserves the composer. The current
 * consent is invalidated through its existing visibility method; no send/load is
 * created by this function. Only the still-mounted caller may reactivate. */
export async function openNativeSettings(binding: EditorWindowBinding, slot: ProjectWindowSettingsSlot): Promise<boolean> {
  try { return await binding.bridge.showSettings(slot); } catch { return false; }
}
export function revealNativeProjects(binding: EditorWindowBinding): void { void binding.bridge.showProjects().catch(() => {}); }
