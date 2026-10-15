import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createAssetAnnotationController } from './asset-annotation-state.ts';
import type { AnnotationState } from './asset-annotation-state.ts';
import type { NativeCloseRegistry } from './native-close-state.ts';
type Options = Parameters<typeof createAssetAnnotationController>[0] & {
  scope: string; ownerScope: string; projectId: string | null; assets: readonly { id: string; projectId: string }[];
  pendingState: unknown; refreshGeneration: number; registry: NativeCloseRegistry;
};
export function useAssetAnnotations(options: Options) {
  const callbacks = useRef(options); callbacks.current = options;
  const [state, setState] = useState<AnnotationState | null>(null);
  const close = useRef<ReturnType<NativeCloseRegistry['register']> | null>(null);
  const controller = useRef<ReturnType<typeof createAssetAnnotationController> | null>(null);
  if (!controller.current) controller.current = createAssetAnnotationController({
    read: input => callbacks.current.read(input), save: input => callbacks.current.save(input),
    canSave: () => callbacks.current.canSave(), pendingAssetIds: (projectId, ownerScope) => callbacks.current.pendingAssetIds?.(projectId, ownerScope) || [], hasPending: (projectId, assetId, ownerScope) => callbacks.current.hasPending(projectId, assetId, ownerScope),
    onChange: next => { setState({ ...next }); close.current?.update(controller.current!.getCloseState()); },
  });
  const owner = controller.current;
  const ids = JSON.stringify(options.assets.filter(asset => asset.projectId === options.projectId).map(asset => asset.id));
  useLayoutEffect(() => { owner.activate(); close.current = options.registry.register('asset-annotations'); close.current.update(owner.getCloseState()); return () => { close.current?.release(); close.current = null; }; }, [owner, options.registry]);
  useLayoutEffect(() => { owner.setContext(options.projectId ? { scope: options.scope, ownerScope: options.ownerScope, projectId: options.projectId, assetIds: JSON.parse(ids) } : null); }, [owner, options.scope, options.ownerScope, options.projectId, ids]);
  useEffect(() => { owner.syncPending(); }, [owner, options.pendingState]);
  const previous = useRef({ scope: options.scope, refresh: options.refreshGeneration });
  useEffect(() => { const before = previous.current; previous.current = { scope: options.scope, refresh: options.refreshGeneration }; if (before.scope === options.scope && before.refresh !== options.refreshGeneration) { owner.syncPending(); void owner.refresh(); } }, [owner, options.scope, options.refreshGeneration]);
  useEffect(() => { const refresh = () => { if (document.visibilityState === 'visible' && !owner.getState().loading) void owner.refresh(); }; window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh); return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); }; }, [owner]);
  useLayoutEffect(() => { owner.activate(); return () => owner.dispose(); }, [owner]);
  return { state: state?.scope === options.scope ? state : null, controller: owner };
}
