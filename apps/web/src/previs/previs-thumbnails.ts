import {PREVIS_THUMBNAIL_CARD,PREVIS_THUMBNAIL_MIME_TYPE,isPrevisThumbnailGetResponse} from '@mioon/contracts';

// Card thumbnails of the previs nodes on the canvas. They are a disposable
// cache: a card asks again when its node's scene revision moves, and once or
// twice more while the stored thumbnail is older than the scene (the editor
// uploads it a moment after saving). A missing one leaves the card empty.
export interface PrevisCardThumbnail {readonly url: string; readonly sceneRevision: number}
export interface PrevisThumbnailNode {readonly id: string; readonly sceneRevision: number}
export interface PrevisThumbnailOptions {
  readonly read: (operation: string, input: Record<string, unknown>) => Promise<unknown>;
  readonly onChange?: (thumbnails: Readonly<Record<string, PrevisCardThumbnail>>) => void;
  readonly setTimer?: (callback: () => void, delay: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly recheckMs?: number;
}
const RECHECKS = 2, CONCURRENCY = 2;
export const previsThumbnailUrl = (dataBase64: string): string => `data:${PREVIS_THUMBNAIL_MIME_TYPE};base64,${dataBase64}`;
/** A card picture older than the saved scene, for example after Mio saved the
 * scene; the editor renders the card again the next time it opens. */
export function previsThumbnailOutdated(thumbnail: PrevisCardThumbnail | undefined, sceneRevision: unknown): boolean {
  return Boolean(thumbnail) && typeof sceneRevision === 'number' && thumbnail!.sceneRevision < sceneRevision;
}

export function createPrevisThumbnails(options: PrevisThumbnailOptions) {
  const setTimer = options.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const recheckMs = options.recheckMs ?? 3000;
  let projectId: string | null = null, generation = 0, disposed = false;
  let thumbnails: Record<string, PrevisCardThumbnail> = {};
  const wanted = new Map<string, number>(), asked = new Map<string, {sceneRevision: number; attempts: number}>();
  const queue: string[] = [], running = new Set<string>(), timers = new Map<string, unknown>();
  const publish = (): void => { options.onChange?.(thumbnails); };
  const stale = (id: string): boolean => (thumbnails[id]?.sceneRevision ?? 0) < (wanted.get(id) ?? 0);
  function enqueue(id: string): void { if (!queue.includes(id) && !running.has(id)) queue.push(id); pump(); }
  function pump(): void {
    while (!disposed && projectId && running.size < CONCURRENCY && queue.length) {
      const id = queue.shift()!, revision = wanted.get(id);
      if (revision === undefined || !stale(id)) continue;
      const previous = asked.get(id), attempts = previous?.sceneRevision === revision ? previous.attempts + 1 : 1;
      asked.set(id, {sceneRevision: revision, attempts});
      running.add(id);
      void fetchOne(projectId, id, revision, generation).finally(() => { running.delete(id); pump(); });
    }
  }
  async function fetchOne(project: string, id: string, revision: number, at: number): Promise<void> {
    const input = {projectId: project, nodeId: id, slots: [PREVIS_THUMBNAIL_CARD]};
    let result: unknown;
    try { result = await options.read('previs.thumbnail.get', input); } catch { return; }
    if (disposed || at !== generation || !isPrevisThumbnailGetResponse(input, result)) return;
    const item = (result as {items: {sceneRevision: number; dataBase64: string}[]}).items[0];
    if (item && item.sceneRevision > (thumbnails[id]?.sceneRevision ?? 0)) { thumbnails = {...thumbnails, [id]: {url: previsThumbnailUrl(item.dataBase64), sceneRevision: item.sceneRevision}}; publish(); }
    // The editor may still be rendering this revision's thumbnail.
    if (stale(id) && (asked.get(id)?.attempts ?? RECHECKS + 1) <= RECHECKS && wanted.get(id) === revision && !timers.has(id))
      timers.set(id, setTimer(() => { timers.delete(id); if (at === generation) enqueue(id); }, recheckMs));
  }
  /** The previs nodes now on the canvas of one project. */
  function setNodes(nextProjectId: string | null, nodes: readonly PrevisThumbnailNode[]): void {
    if (disposed) return;
    if (nextProjectId !== projectId) {
      projectId = nextProjectId; generation++; wanted.clear(); asked.clear(); queue.length = 0;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      if (Object.keys(thumbnails).length) { thumbnails = {}; publish(); }
    }
    const ids = new Set(nodes.map(node => node.id));
    for (const id of [...wanted.keys()]) if (!ids.has(id)) wanted.delete(id);
    if (Object.keys(thumbnails).some(id => !ids.has(id))) { thumbnails = Object.fromEntries(Object.entries(thumbnails).filter(([id]) => ids.has(id))); publish(); }
    for (const node of nodes) {
      const before = wanted.get(node.id);
      wanted.set(node.id, node.sceneRevision);
      if (before !== node.sceneRevision && stale(node.id)) enqueue(node.id);
    }
  }
  /** The editor uploaded a thumbnail: show it without asking again. */
  function put(nextProjectId: string, nodeId: string, sceneRevision: number, dataBase64: string): void {
    if (disposed || nextProjectId !== projectId || sceneRevision <= (thumbnails[nodeId]?.sceneRevision ?? 0)) return;
    thumbnails = {...thumbnails, [nodeId]: {url: previsThumbnailUrl(dataBase64), sceneRevision}};
    publish();
  }
  function dispose(): void {
    disposed = true; queue.length = 0;
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
  }
  return {setNodes, put, dispose, get: (): Readonly<Record<string, PrevisCardThumbnail>> => thumbnails};
}
export type PrevisThumbnails = ReturnType<typeof createPrevisThumbnails>;
