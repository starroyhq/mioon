import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createSubjectController, subjectDraftDirty } from './subject-state.js';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';

export function useSubjectInteraction(scope, controller, target = null) {
  const visible = useWorkspaceVisibility();
  const token = useMemo(() => ({ scope, visible, target }), [scope, visible, target]);
  const live = useRef(null);
  useLayoutEffect(() => { live.current = token; return () => { live.current = null; }; }, [token]);
  return { visible, admit: action => {
    if (visible && live.current === token && scope && controller?.getState().scope === scope) return action();
  } };
}

export function useSubjects({ scope, projectId, assets, shotIds, read, save, hasPending, blocked, pendingState, refreshGeneration, onDirtyChange }) {
  const callbacks = useRef({ read, save, hasPending, blocked });
  callbacks.current = { read, save, hasPending, blocked };
  const [state, setState] = useState(null), controller = useRef(null);
  if (!controller.current) controller.current = createSubjectController({
    read: (operation, input) => callbacks.current.read(operation, input),
    save: (operation, input, options) => callbacks.current.save(operation, input, options),
    hasPending: id => callbacks.current.hasPending?.(id), canSave: () => !callbacks.current.blocked,
    onChange: setState,
  });
  const assetsKey = JSON.stringify((assets || []).map(({ id, projectId: owner, mimeType, sha256 }) => ({ id, projectId: owner, mimeType, sha256 })));
  const shotsKey = JSON.stringify(shotIds || []);
  useLayoutEffect(() => { controller.current.setContext(projectId ? { scope, projectId, assets: JSON.parse(assetsKey), shotIds: JSON.parse(shotsKey) } : null); }, [scope, projectId, assetsKey, shotsKey]);
  useLayoutEffect(() => () => controller.current.dispose(), []);
  useEffect(() => { controller.current.syncPending(); }, [scope, pendingState]);
  const visibleState = state?.scope === scope ? state : null, dirty = subjectDraftDirty(visibleState);
  useLayoutEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  const lastRefresh = useRef({ scope, generation: refreshGeneration });
  useEffect(() => {
    const previous = lastRefresh.current;
    lastRefresh.current = { scope, generation: refreshGeneration };
    if (previous.scope === scope && previous.generation !== refreshGeneration) void controller.current.read();
  }, [scope, refreshGeneration]);
  useEffect(() => {
    const refresh = () => { const current = controller.current.getState(); if (document.visibilityState === 'visible' && !current.saving && current.list.phase !== 'loading') void controller.current.read(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return { state: visibleState, controller: controller.current };
}
