import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createFrameExtractionController } from './frame-extraction.ts';

const assetFields = ['id', 'projectId', 'sha256', 'name', 'mimeType', 'duration', 'width', 'height', 'sizeBytes', 'provenance'];
const assetValue = asset => asset ? Object.fromEntries(assetFields.filter(key => asset[key] !== undefined).map(key => [key, asset[key]])) : null;

// Project polling returns new objects. Configure only on semantic changes so a
// periodic project read cannot invalidate an in-flight extraction acknowledgement.
export function useFrameExtraction({ projectId, sourceScope, sourceAsset, assets = [], visible = false, blocked = false, rpc, createRequestId, onResult, revealAsset }) {
  const callbacks = useRef(null), mounted = useRef(false);
  callbacks.current = { projectId, sourceScope, rpc, createRequestId, onResult, revealAsset };
  const [state, setState] = useState(null), controller = useRef(null);
  const current = (project, scope) => mounted.current && callbacks.current.projectId === project && callbacks.current.sourceScope === scope;
  if (!controller.current) controller.current = createFrameExtractionController({
    rpc: (operation, input) => callbacks.current.rpc(operation, input),
    createRequestId: () => callbacks.current.createRequestId ? callbacks.current.createRequestId() : globalThis.crypto.randomUUID(),
    onChange: next => { if (current(next.projectId, next.sourceScope)) setState(next); },
    onResult: (project, task) => {
      if (current(project, controller.current.getSnapshot().sourceScope)) return callbacks.current.onResult?.(project, task);
    },
    revealAsset: (assetId, project, isStillCurrent) => {
      const scope = controller.current.getSnapshot().sourceScope;
      const guard = () => current(project, scope) && isStillCurrent();
      return guard() ? callbacks.current.revealAsset?.(assetId, project, guard) ?? false : false;
    },
  });
  const sourceKey = JSON.stringify(assetValue(sourceAsset));
  const assetsKey = JSON.stringify(assets.map(assetValue).sort((left, right) => (left?.id || '').localeCompare(right?.id || '')));
  const stableSource = useMemo(() => JSON.parse(sourceKey), [sourceKey]);
  const stableAssets = useMemo(() => JSON.parse(assetsKey), [assetsKey]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current.dispose(); };
  }, []);
  useLayoutEffect(() => {
    controller.current.configure({ projectId, sourceScope, sourceAsset: stableSource, assets: stableAssets, visible, blocked });
  }, [projectId, sourceScope, stableSource, stableAssets, visible, blocked]);
  useEffect(() => {
    const snapshot = controller.current.getSnapshot();
    if (visible && !blocked && projectId && !snapshot.historyLoaded && !snapshot.loading) void controller.current.refreshTasks();
  }, [projectId, sourceScope, visible, blocked]);
  const snapshot = state?.projectId === projectId && state?.sourceScope === sourceScope ? state : { ...controller.current.getSnapshot(), visible: false };
  return { state: snapshot, controller: controller.current };
}
