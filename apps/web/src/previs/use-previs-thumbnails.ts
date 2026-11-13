import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {isPrevisThumbnailGetResponse} from '@mioon/contracts';
import {createPrevisThumbnails,previsThumbnailUrl} from './previs-thumbnails.ts';
import type {PrevisCardThumbnail,PrevisThumbnailNode,PrevisThumbnails} from './previs-thumbnails.ts';

type Read = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
const EMPTY_THUMBNAILS = Object.freeze({});
// One thumbnail cache for the window, refilled for the open project.
export function usePrevisThumbnails({projectId, framePresetId, nodes, read}: {projectId: string | null; framePresetId: string | null; nodes: readonly PrevisThumbnailNode[]; read: Read}): {thumbnails: Readonly<Record<string, PrevisCardThumbnail>>; put: PrevisThumbnails['put']} {
  const reader = useRef(read);
  reader.current = read;
  const [state, setState] = useState<{projectId: string | null; framePresetId: string | null; thumbnails: Readonly<Record<string, PrevisCardThumbnail>>}>({projectId: null, framePresetId: null, thumbnails: {}});
  const controller = useRef<PrevisThumbnails | null>(null);
  if (!controller.current) controller.current = createPrevisThumbnails({
    read: (operation, input) => reader.current(operation, input),
    onChange: (thumbnails, projectId, framePresetId) => setState({projectId, framePresetId, thumbnails}),
  });
  const signature = nodes.map(node => `${node.id}:${node.sceneRevision}`).join(',');
  const latest = useRef(nodes);
  latest.current = nodes;
  useLayoutEffect(() => { controller.current!.setNodes(projectId, framePresetId, latest.current); }, [projectId, framePresetId, signature]);
  // Reset rather than dispose: StrictMode remounts effects and the cache must stay usable.
  useLayoutEffect(() => () => controller.current?.setNodes(null, null, []), []);
  const thumbnails = state.projectId === projectId && state.framePresetId === framePresetId ? state.thumbnails : EMPTY_THUMBNAILS;
  return {thumbnails, put: controller.current.put};
}
export interface PrevisKeyframeThumbnailNode {readonly id: string; readonly sceneRevision: number; readonly scene: {readonly keyframes: readonly {readonly id: string}[]}}
const RECHECKS = 2, RECHECK_MS = 3000;
/** Cached keyframe thumbnails of the previs node shown in the inspector. They
 * are read again when its scene is saved and when `generation` moves (the
 * editor closed), and once or twice more while some are missing or older. */
export function usePrevisKeyframeThumbnails({projectId, framePresetId, node, generation = 0, read}: {projectId: string | null; framePresetId: string | null; node: PrevisKeyframeThumbnailNode | null; generation?: number; read: Read}): Readonly<Record<string, string>> {
  const reader = useRef(read);
  reader.current = read;
  const slots = node ? node.scene.keyframes.map(item => item.id) : [];
  const owner = projectId && node && framePresetId ? `${projectId}:${node.id}:${framePresetId}` : '', key = owner && slots.length ? `${owner}:${node!.sceneRevision}:${slots.join(',')}:${generation}` : '';
  const [state, setState] = useState<{owner: string; urls: Readonly<Record<string, string>>}>({owner: '', urls: EMPTY_THUMBNAILS});
  useLayoutEffect(() => {
    setState(current => current.owner === owner ? current : {owner, urls: EMPTY_THUMBNAILS});
  }, [owner]);
  useEffect(() => {
    if (!key || !node || !projectId || !framePresetId) return;
    let cancelled = false, attempts = 0, timer: ReturnType<typeof setTimeout> | null = null;
    const input = {projectId, framePresetId, nodeId: node.id, slots};
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
  return state.owner === owner && owner ? state.urls : EMPTY_THUMBNAILS;
}
