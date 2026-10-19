import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createSubjectController, subjectDraftDirty } from './subject-state.ts';
import type { SubjectAsset, SubjectContext, SubjectReadInput, SubjectState } from './subject-state.ts';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';

export type SubjectController=ReturnType<typeof createSubjectController>;
export interface SubjectInteractionAdmit {(): unknown}
export interface SubjectInteraction {visible: boolean; admit(action: ()=>unknown): unknown}
export interface UseSubjectsOptions {
  scope: string|null;
  projectId: string|null|undefined;
  assets?: readonly unknown[];
  shotIds?: readonly string[];
  read: (operation: string,input: SubjectReadInput)=>Promise<unknown>;
  save: (operation: string,input: Record<string, unknown>,options: {canExecute: ()=>boolean})=>Promise<unknown>;
  hasPending?: (projectId?: string|null)=>boolean;
  blocked?: boolean;
  pendingState?: unknown;
  refreshGeneration?: unknown;
  onDirtyChange?: (dirty: boolean)=>void;
}
export interface UseSubjectsResult {state: SubjectState|null; controller: SubjectController}
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function useSubjectInteraction(scope: string|null|undefined,controller: {getState(): {scope: string|null}}|null|undefined,target: unknown = null): SubjectInteraction {
  const visible = useWorkspaceVisibility();
  const token = useMemo(() => ({ scope, visible, target }), [scope, visible, target]);
  const live = useRef<{scope: unknown;visible: unknown;target: unknown}|null>(null);
  useLayoutEffect(() => { live.current = token; return () => { live.current = null; }; }, [token]);
  return { visible, admit: (action: ()=>unknown) => {
    if (visible && live.current === token && scope && controller?.getState().scope === scope) return action();
  } };
}

export function useSubjects({ scope, projectId, assets, shotIds, read, save, hasPending, blocked, pendingState, refreshGeneration, onDirtyChange }: UseSubjectsOptions): UseSubjectsResult {
  const callbacks = useRef({ read, save, hasPending, blocked });
  callbacks.current = { read, save, hasPending, blocked };
  const [state, setState] = useState<SubjectState|null>(null), controller = useRef<SubjectController|null>(null);
  if (!controller.current) controller.current = createSubjectController({
    read: (operation: string,input: SubjectReadInput) => callbacks.current.read(operation, input),
    save: (operation: string,input: Record<string, unknown>,options: {canExecute: ()=>boolean}) => callbacks.current.save(operation, input, options),
    hasPending: (id?: string|null) => Boolean(callbacks.current.hasPending?.(id)), canSave: () => !callbacks.current.blocked,
    onChange: setState,
  });
  const assetsKey = JSON.stringify((assets || []).filter(isRecord).map(({ id, projectId: owner, mimeType, sha256 }) => ({ id, projectId: owner, mimeType, sha256 })));
  const shotsKey = JSON.stringify(shotIds || []);
  useLayoutEffect(() => { controller.current!.setContext(projectId ? { scope, projectId, assets: JSON.parse(assetsKey) as SubjectAsset[], shotIds: JSON.parse(shotsKey) as string[] } : null); }, [scope, projectId, assetsKey, shotsKey]);
  useLayoutEffect(() => () => controller.current?.dispose(), []);
  useEffect(() => { controller.current?.syncPending(); }, [scope, pendingState]);
  const visibleState = state?.scope === scope ? state : null, dirty = subjectDraftDirty(visibleState);
  useLayoutEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  const lastRefresh = useRef({ scope, generation: refreshGeneration });
  useEffect(() => {
    const previous = lastRefresh.current;
    lastRefresh.current = { scope, generation: refreshGeneration };
    if (previous.scope === scope && previous.generation !== refreshGeneration) void controller.current?.read();
  }, [scope, refreshGeneration]);
  useEffect(() => {
    const refresh = (): void => { const current = controller.current!.getState(); if (document.visibilityState === 'visible' && !current.saving && current.list.phase !== 'loading') void controller.current!.read(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return { state: visibleState, controller: controller.current };
}
