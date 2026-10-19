import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createAssetDispositionController } from './asset-disposition-state.ts';
import type { AssetDispositionContext, AssetDispositionController, AssetDispositionListInput, AssetDispositionState } from './asset-disposition-state.ts';

export interface UseAssetDispositionsOptions {
  scope: unknown;
  projectId: string|null|undefined;
  assets: readonly {readonly id: string; readonly [key: string]: unknown}[];
  read: (input: AssetDispositionListInput)=>Promise<unknown>;
  save: (input: {projectId: string; assetId: string; expectedRevision: number; disposition: 'neutral'|'favorite'|'rejected'})=>Promise<unknown>;
  hasPending: (projectId: string|null)=>boolean;
  pendingState: unknown;
  blocked?: boolean;
  refreshGeneration: unknown;
}
export interface UseAssetDispositionsResult {state: AssetDispositionState|null; controller: AssetDispositionController}

export function useAssetDispositions({ scope, projectId, assets, read, save, hasPending, pendingState, blocked, refreshGeneration }: UseAssetDispositionsOptions): UseAssetDispositionsResult {
  const callbacks = useRef({ read, save, hasPending, blocked });
  callbacks.current = { read, save, hasPending, blocked };
  const [state, setState] = useState<AssetDispositionState|null>(null), controller = useRef<AssetDispositionController|null>(null);
  if (!controller.current) controller.current = createAssetDispositionController({
    read: (input: AssetDispositionListInput) => callbacks.current.read(input), save: (input: {projectId: string; assetId: string; expectedRevision: number; disposition: 'neutral'|'favorite'|'rejected'}) => callbacks.current.save(input),
    hasPending: (id: string|null) => callbacks.current.hasPending(id), canSave: () => !callbacks.current.blocked,
    onChange: setState,
  });
  const idsKey = JSON.stringify(assets.map(asset => asset.id));
  useLayoutEffect(() => {
    controller.current!.setContext(projectId ? { scope, projectId, assetIds: JSON.parse(idsKey) as string[] } : null);
  }, [scope, projectId, idsKey]);
  useLayoutEffect(() => () => controller.current?.dispose(), []);
  useEffect(() => { controller.current?.syncPending(); }, [scope, pendingState]);
  const lastRefresh = useRef({ scope, generation: refreshGeneration });
  useEffect(() => {
    const previous = lastRefresh.current;
    lastRefresh.current = { scope, generation: refreshGeneration };
    if (previous.scope === scope && previous.generation !== refreshGeneration) void controller.current?.read();
  }, [scope, refreshGeneration]);
  useEffect(() => {
    const refresh = (): void => { if (document.visibilityState === 'visible' && !controller.current!.getState().loading) void controller.current!.read(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return { state: state?.scope === scope ? state : null, controller: controller.current };
}
