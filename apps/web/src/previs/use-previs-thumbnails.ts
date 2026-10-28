import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {isPrevisThumbnailGetResponse} from '@mioon/contracts';
import {createPrevisThumbnails,previsThumbnailUrl} from './previs-thumbnails.ts';
import type {PrevisCardThumbnail,PrevisThumbnailNode,PrevisThumbnails} from './previs-thumbnails.ts';

type Read = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
// One thumbnail cache for the window, refilled for the open project.
export function usePrevisThumbnails({projectId, nodes, read}: {projectId: string | null; nodes: readonly PrevisThumbnailNode[]; read: Read}): {thumbnails: Readonly<Record<string, PrevisCardThumbnail>>; put: PrevisThumbnails['put']} {
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
export interface PrevisKeyframeThumbnailNode {readonly id: string; readonly sceneRevision: number; readonly scene: {readonly keyframes: readonly {readonly id: string}[]}}
const RECHECKS = 2, RECHECK_MS = 3000;
/** Cached keyframe thumbnails of the previs node shown in the inspector. They
 * are read again when its scene is saved and when `generation` moves (the
 * editor closed), and once or twice more while some are missing or older. */
export function usePrevisKeyframeThumbnails({projectId, node, generation = 0, read}: {projectId: string | null; node: PrevisKeyframeThumbnailNode | null; generation?: number; read: Read}): Readonly<Record<string, string>> {
  const reader = useRef(read);
  reader.current = read;
  const slots = node ? node.scene.keyframes.map(item => item.id) : [];
  const owner = projectId && node ? `${projectId}:${node.id}` : '', key = owner && slots.length ? `${owner}:${node!.sceneRevision}:${slots.join(',')}:${generation}` : '';
  const [state, setState] = useState<{owner: string; urls: Readonly<Record<string, string>>}>({owner: '', urls: {}});
  useEffect(() => {
    if (!key || !node || !projectId) return;
    let cancelled = false, attempts = 0, timer: ReturnType<typeof setTimeout> | null = null;
    const input = {projectId, nodeId: node.id, slots};
    const fetchOnce = async (): Promise<void> => {
      let result: unknown;
      try { result = await reader.current('previs.thumbnail.get', input); } catch { return; }
      if (cancelled || !isPrevisThumbnailGetResponse(input, result)) return;
      const items = (result as {items: {slot: string; sceneRevision: number; dataBase64: string}[]}).items;
      setState({owner, urls: Object.fromEntries(items.map(item => [item.slot, previsThumbnailUrl(item.dataBase64)]))});
      const stale = items.length < slots.length || items.some(item => item.sceneRevision < node.sceneRevision);
      if (stale && attempts++ < RECHECKS) timer = setTimeout(() => { void fetchOnce(); }, RECHECK_MS);
    };
    void fetchOnce();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [key]);
  return state.owner === owner && owner ? state.urls : {};
}
