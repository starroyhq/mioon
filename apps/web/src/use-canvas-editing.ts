import {useEffect, useLayoutEffect, useRef, useSyncExternalStore} from 'react';
import {createCanvasEditingController} from './canvas-editing-state.ts';
import type {CanvasEditRpc, CanvasEditingContext} from './canvas-editing-state.ts';
import type {CanvasTarget} from '../../../packages/contracts/src/canvas-editing.ts';

interface UseCanvasEditingOptions extends CanvasEditingContext {
  rpc: CanvasEditRpc;
  refresh: (projectId: string) => Promise<unknown>;
  isCurrent?: () => boolean;
  onError?: (error: unknown) => void;
  onArchived?: (targets: readonly CanvasTarget[]) => void;
}

const detachedContext: CanvasEditingContext = {scope: '', projectId: null, enabled: false, writable: false, base: undefined};

export function useCanvasEditing(options: UseCanvasEditingOptions) {
  const {scope, projectId, enabled, writable, base} = options;
  const callbacks = useRef(options);
  callbacks.current = options;
  const ref = useRef<ReturnType<typeof createCanvasEditingController> | null>(null);
  if (!ref.current) {
    ref.current = createCanvasEditingController({
      rpc: (operation, input) => callbacks.current.rpc(operation, input),
      refresh: id => callbacks.current.refresh(id),
      isCurrent: () => callbacks.current.isCurrent?.() ?? true,
      onError: error => callbacks.current.onError?.(error),
      onArchived: targets => callbacks.current.onArchived?.(targets),
    });
  }
  const controller = ref.current;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => {
    controller.setContext({scope, projectId, enabled, writable, base});
  }, [controller, scope, projectId, enabled, writable, base]);
  useLayoutEffect(() => () => controller.setContext(detachedContext), [controller]);
  // project.get already polls for remote edits. Keep derived reads tied to its
  // content identity instead of creating another polling loop.
  useEffect(() => {
    if (!enabled || !projectId) return;
    void controller.loadHistory();
    void controller.loadArchive();
  }, [controller, enabled, projectId, scope, base?.contentToken]);
  return {...snapshot, ...controller};
}
