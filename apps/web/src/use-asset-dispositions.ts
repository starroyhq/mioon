import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createAssetDispositionController } from './asset-disposition-state.ts';

export function useAssetDispositions({ scope, projectId, assets, read, save, hasPending, pendingState, blocked, refreshGeneration }) {
  const callbacks = useRef({ read, save, hasPending, blocked });
  callbacks.current = { read, save, hasPending, blocked };
  const [state, setState] = useState(null), controller = useRef(null);
  if (!controller.current) controller.current = createAssetDispositionController({
    read: input => callbacks.current.read(input), save: input => callbacks.current.save(input),
    hasPending: id => callbacks.current.hasPending(id), canSave: () => !callbacks.current.blocked,
    onChange: setState,
  });
  const idsKey = JSON.stringify(assets.map(asset => asset.id));
  useLayoutEffect(() => {
    controller.current.setContext(projectId ? { scope, projectId, assetIds: JSON.parse(idsKey) } : null);
  }, [scope, projectId, idsKey]);
  useLayoutEffect(() => () => controller.current.dispose(), []);
  useEffect(() => { controller.current.syncPending(); }, [scope, pendingState]);
  const lastRefresh = useRef({ scope, generation: refreshGeneration });
  useEffect(() => {
    const previous = lastRefresh.current;
    lastRefresh.current = { scope, generation: refreshGeneration };
    if (previous.scope === scope && previous.generation !== refreshGeneration) void controller.current.read();
  }, [scope, refreshGeneration]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible' && !controller.current.getState().loading) void controller.current.read(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return { state: state?.scope === scope ? state : null, controller: controller.current };
}
