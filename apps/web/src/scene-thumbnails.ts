import { SOURCE_RANGE_FPS } from '@mioon/contracts';

// View-only thumbnails for the scene dialog's filmstrip and segment strip. One
// hidden video element seeks to each requested frame in turn and paints a small
// JPEG; storyboard keyframes themselves are captured by the backend.
export interface SceneThumbnailVideo {
  src: string; muted: boolean; preload: string; currentTime: number; readyState: number; videoWidth: number; videoHeight: number;
  playsInline?: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  removeAttribute(name: string): void;
  load(): void;
}
export interface SceneThumbnailCanvas {
  width: number; height: number;
  getContext(kind: '2d'): { drawImage(image: unknown, x: number, y: number, width: number, height: number): void } | null;
  toDataURL(type: string, quality?: number): string;
}
export interface SceneThumbnailerOptions {
  /** Identifies the exact source bytes, e.g. asset id and hash. */
  readonly key: string;
  readonly url: string;
  readonly width?: number;
  readonly onUpdate?: () => void;
  readonly createVideo?: () => SceneThumbnailVideo;
  readonly createCanvas?: () => SceneThumbnailCanvas;
  readonly timeoutMs?: number;
}

const cache = new Map<string, string>(), cacheLimit = 800;
function remember(key: string, url: string): void {
  cache.delete(key); cache.set(key, url);
  while (cache.size > cacheLimit) cache.delete(cache.keys().next().value as string);
}
/** Clears the shared cache; tests use it between cases. */
export const clearSceneThumbnails = (): void => cache.clear();

export function createSceneThumbnailer({ key, url, width = 160, onUpdate = () => {}, createVideo = () => document.createElement('video') as unknown as SceneThumbnailVideo,
  createCanvas = () => document.createElement('canvas') as unknown as SceneThumbnailCanvas, timeoutMs = 8000 }: SceneThumbnailerOptions) {
  let video: SceneThumbnailVideo | null = null, opening: Promise<SceneThumbnailVideo | null> | null = null, running = false, disposed = false, failed = false, notify: ReturnType<typeof setTimeout> | null = null;
  const queue: number[] = [];
  const entry = (frame: number): string => `${key}:${width}:${frame}`;
  const changed = (): void => { if (!notify) notify = setTimeout(() => { notify = null; if (!disposed) onUpdate(); }, 60); };
  function wait(element: SceneThumbnailVideo, event: string): Promise<boolean> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: boolean): void => { if (timer) clearTimeout(timer); element.removeEventListener(event, done); element.removeEventListener('error', fail); resolve(value); };
      const done = (): void => finish(true), fail = (): void => finish(false);
      element.addEventListener(event, done); element.addEventListener('error', fail);
      timer = setTimeout(() => finish(false), timeoutMs);
    });
  }
  function media(): Promise<SceneThumbnailVideo | null> {
    if (video) return Promise.resolve(video);
    if (!opening) opening = (async () => {
      const element = createVideo();
      element.muted = true; element.preload = 'auto'; element.playsInline = true;
      const loaded = wait(element, 'loadeddata');
      element.src = url;
      if (!await loaded || disposed) { release(element); return null; }
      video = element; return element;
    })();
    return opening;
  }
  function release(element: SceneThumbnailVideo): void { try { element.removeAttribute('src'); element.load(); } catch {} }
  function paint(element: SceneThumbnailVideo): string | null {
    if (!element.videoWidth || !element.videoHeight) return null;
    try {
      const canvas = createCanvas();
      canvas.width = width; canvas.height = Math.max(1, Math.round(width * element.videoHeight / element.videoWidth));
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.72);
    } catch { return null; }
  }
  async function pump(): Promise<void> {
    if (running || disposed || failed) return;
    running = true;
    try {
      while (queue.length && !disposed) {
        const frame = queue.shift()!;
        if (cache.has(entry(frame))) continue;
        const element = await media();
        if (!element) { failed = true; queue.length = 0; break; }
        const seeked = wait(element, 'seeked');
        element.currentTime = (frame + 0.5) / SOURCE_RANGE_FPS;
        if (!await seeked || disposed) continue;
        const image = paint(element);
        if (image) { remember(entry(frame), image); changed(); }
      }
    } finally { running = false; }
  }
  return {
    get: (frame: number): string | undefined => cache.get(entry(frame)),
    /** Queues frames not painted yet; earlier calls keep their place. */
    request(frames: readonly number[]): void {
      if (disposed || failed) return;
      for (const frame of frames) if (Number.isSafeInteger(frame) && frame >= 0 && !cache.has(entry(frame)) && !queue.includes(frame)) queue.push(frame);
      void pump();
    },
    /** Moves the given frames to the front, for the segment the user is looking at. */
    prioritize(frames: readonly number[]): void {
      if (disposed || failed) return;
      const wanted = frames.filter(frame => Number.isSafeInteger(frame) && frame >= 0 && !cache.has(entry(frame)));
      for (const frame of wanted) { const index = queue.indexOf(frame); if (index >= 0) queue.splice(index, 1); }
      queue.unshift(...wanted);
      void pump();
    },
    unavailable: (): boolean => failed,
    dispose(): void { disposed = true; queue.length = 0; if (notify) clearTimeout(notify); if (video) release(video); video = null; },
  };
}
export type SceneThumbnailer = ReturnType<typeof createSceneThumbnailer>;
