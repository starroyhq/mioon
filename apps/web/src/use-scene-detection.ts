import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createSceneDetectionController, sceneTaskActive } from './scene-detection.ts';
import type { SceneDetectionController, SceneDetectionState, SceneDetectTask } from './scene-detection.ts';

export interface UseSceneDetectionOptions {
  projectId: string | null | undefined;
  visible: boolean;
  readOnly: boolean;
  rpc: (operation: string, input: unknown) => Promise<unknown>;
  createRequestId?: () => string;
  onTaskSettled?: (task: SceneDetectTask) => void;
}
const activeDelay = 1000, idleDelay = 5000, failedDelay = 30_000;

// Lists the project's scene tasks while the workbench is visible: every second
// while one is active (its progress lives only in the backend's memory), and
// every five seconds otherwise, so tasks Mio or another window starts show up.
export function useSceneDetection({ projectId, visible, readOnly, rpc, createRequestId, onTaskSettled }: UseSceneDetectionOptions): { state: SceneDetectionState; controller: SceneDetectionController } {
  const callbacks = useRef({ rpc, createRequestId, onTaskSettled });
  callbacks.current = { rpc, createRequestId, onTaskSettled };
  const controller = useRef<SceneDetectionController | null>(null);
  if (!controller.current) controller.current = createSceneDetectionController({
    rpc: (operation, input) => callbacks.current.rpc(operation, input),
    createRequestId: () => callbacks.current.createRequestId ? callbacks.current.createRequestId() : globalThis.crypto.randomUUID(),
    onTaskSettled: task => callbacks.current.onTaskSettled?.(task),
  });
  const current = controller.current;
  const state = useSyncExternalStore(current.subscribe, current.getSnapshot, current.getSnapshot);
  // Reset rather than dispose: StrictMode remounts effects and the controller must stay usable.
  useLayoutEffect(() => {
    current.configure({ projectId: projectId ?? null, visible, readOnly });
  }, [current, projectId, visible, readOnly]);
  useLayoutEffect(() => () => current.configure({ projectId: null }), [current]);
  useEffect(() => {
    if (!visible || !projectId) return;
    let stopped = false, idle = false, timer: ReturnType<typeof setTimeout> | undefined;
    const active = (): boolean => current.getSnapshot().tasks.some(sceneTaskActive);
    const schedule = (delay: number): void => { if (timer) clearTimeout(timer); idle = delay !== activeDelay; timer = setTimeout(() => { void tick(); }, delay); };
    const tick = async (): Promise<void> => {
      if (stopped) return;
      timer = undefined;
      if (typeof document === 'undefined' || document.visibilityState === 'visible') await current.refreshTasks();
      if (!stopped) schedule(active() ? activeDelay : current.getSnapshot().tasksError ? failedDelay : idleDelay);
    };
    // A request accepted between idle reads starts the fast cadence at once.
    const unsubscribe = current.subscribe(() => { if (!stopped && idle && timer && active()) schedule(activeDelay); });
    void tick();
    return () => { stopped = true; unsubscribe(); if (timer) clearTimeout(timer); };
  }, [current, projectId, visible]);
  return { state, controller: current };
}
