import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createFrameExtractionController } from './frame-extraction.ts';
import type { FrameAsset, FrameExtractionState, FrameTask } from './frame-extraction.ts';

export type FrameExtractionController=ReturnType<typeof createFrameExtractionController>;
export interface UseFrameExtractionOptions {
  projectId: string|null|undefined;
  sourceScope: string|null;
  sourceAsset: unknown;
  assets?: readonly unknown[];
  visible?: boolean;
  blocked?: boolean;
  rpc: (operation: string,input: unknown)=>Promise<unknown>;
  createRequestId?: ()=>string;
  onResult?: (projectId: string,task: FrameTask)=>unknown;
  revealAsset?: (assetId: string,projectId: string,isStillCurrent: ()=>boolean)=>unknown;
}
export interface UseFrameExtractionResult {state: FrameExtractionState & {visible: boolean}; controller: FrameExtractionController}
const assetFields = ['id', 'projectId', 'sha256', 'name', 'mimeType', 'duration', 'width', 'height', 'sizeBytes', 'provenance'] as const;
const assetValue=(asset: unknown): Record<string, unknown>|null => asset ? Object.fromEntries(assetFields.filter(key => (asset as Record<string,unknown>)[key] !== undefined).map(key => [key, (asset as Record<string,unknown>)[key]])) : null;

// Project polling returns new objects. Configure only on semantic changes so a
// periodic project read cannot invalidate an in-flight extraction acknowledgement.
export function useFrameExtraction({ projectId, sourceScope, sourceAsset, assets = [], visible = false, blocked = false, rpc, createRequestId, onResult, revealAsset }: UseFrameExtractionOptions): UseFrameExtractionResult {
  type FrameCallbacks = Pick<UseFrameExtractionOptions,'projectId'|'sourceScope'|'rpc'|'createRequestId'|'onResult'|'revealAsset'>;
  const callbacks = useRef<FrameCallbacks|null>(null), mounted = useRef(false);
  callbacks.current = { projectId, sourceScope, rpc, createRequestId, onResult, revealAsset };
  const [state, setState] = useState<FrameExtractionState|null>(null), controller = useRef<FrameExtractionController|null>(null);
  const current = (project: string|null,scope: string|null): boolean => mounted.current && callbacks.current?.projectId === project && callbacks.current?.sourceScope === scope;
  if (!controller.current) controller.current = createFrameExtractionController({
    rpc: (operation: string,input: unknown) => callbacks.current!.rpc(operation, input),
    createRequestId: () => callbacks.current?.createRequestId ? callbacks.current.createRequestId() : globalThis.crypto.randomUUID(),
    onChange: (next: FrameExtractionState) => { if (current(next.projectId, next.sourceScope)) setState(next); },
    onResult: (project: string,task: FrameTask) => {
      if (current(project, controller.current!.getSnapshot().sourceScope)) return callbacks.current?.onResult?.(project, task);
    },
    revealAsset: (assetId: string,project: string,isStillCurrent: ()=>boolean) => {
      const scope = controller.current!.getSnapshot().sourceScope;
      const guard = (): boolean => current(project, scope) && isStillCurrent();
      return guard() ? callbacks.current?.revealAsset?.(assetId, project, guard) ?? false : false;
    },
  });
  const sourceKey = JSON.stringify(assetValue(sourceAsset));
  const assetsKey = JSON.stringify(assets.map(assetValue).sort((left, right) => (String(left?.id ?? '')).localeCompare(String(right?.id ?? ''))));
  const stableSource: FrameAsset|null = useMemo(() => JSON.parse(sourceKey) as FrameAsset | null, [sourceKey]);
  const stableAssets: FrameAsset[] = useMemo(() => JSON.parse(assetsKey) as FrameAsset[], [assetsKey]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.dispose(); };
  }, []);
  useLayoutEffect(() => {
    controller.current?.configure({ projectId: projectId ?? null, sourceScope, sourceAsset: stableSource, assets: stableAssets, visible, blocked });
  }, [projectId, sourceScope, stableSource, stableAssets, visible, blocked]);
  useEffect(() => {
    const snapshot = controller.current!.getSnapshot();
    if (visible && !blocked && projectId && !snapshot.historyLoaded && !snapshot.loading) void controller.current!.refreshTasks();
  }, [projectId, sourceScope, visible, blocked]);
  const snapshot: FrameExtractionState & {visible: boolean} = state?.projectId === projectId && state?.sourceScope === sourceScope ? state : { ...controller.current.getSnapshot(), visible: false };
  return { state: snapshot, controller: controller.current };
}
