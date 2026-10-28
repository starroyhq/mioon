import {useLayoutEffect,useRef,useState} from 'react';
import {createPrevisThumbnails} from './previs-thumbnails.ts';
import type {PrevisCardThumbnail,PrevisThumbnailNode,PrevisThumbnails} from './previs-thumbnails.ts';

// One thumbnail cache for the window, refilled for the open project.
export function usePrevisThumbnails({projectId, nodes, read}: {projectId: string | null; nodes: readonly PrevisThumbnailNode[]; read: (operation: string, input: Record<string, unknown>) => Promise<unknown>}): {thumbnails: Readonly<Record<string, PrevisCardThumbnail>>; put: PrevisThumbnails['put']} {
  const reader = useRef(read);
  reader.current = read;
  const [thumbnails, setThumbnails] = useState<Readonly<Record<string, PrevisCardThumbnail>>>({});
  const controller = useRef<PrevisThumbnails | null>(null);
  if (!controller.current) controller.current = createPrevisThumbnails({read: (operation, input) => reader.current(operation, input), onChange: setThumbnails});
  const signature = nodes.map(node => `${node.id}:${node.sceneRevision}`).join(',');
  const latest = useRef(nodes);
  latest.current = nodes;
  useLayoutEffect(() => { controller.current!.setNodes(projectId, latest.current); }, [projectId, signature]);
  // Reset rather than dispose: StrictMode remounts effects and the cache must stay usable.
  useLayoutEffect(() => () => controller.current?.setNodes(null, []), []);
  return {thumbnails, put: controller.current.put};
}
