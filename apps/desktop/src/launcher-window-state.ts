import path from 'node:path';
import { readPrivateFile, writePrivateFileAtomic } from '../../../packages/contracts/src/private-storage.ts';

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type BoundsEvent = 'move' | 'resize' | 'close' | 'closed';
interface LauncherWindow {
  isDestroyed(): boolean;
  getNormalBounds(): WindowBounds;
  on(event: BoundsEvent, listener: () => void): unknown;
  removeListener(event: BoundsEvent, listener: () => void): unknown;
}

const defaults = { width: 1000, height: 680, minWidth: 820, minHeight: 560 };
const maxBytes = 512;
const saveDelayMs = 250;
const keys = ['x', 'y', 'width', 'height'] as const;

function isBounds(value: unknown): value is WindowBounds {
  if (typeof value !== 'object' || value === null || Object.keys(value).length !== keys.length) return false;
  const bounds = value as Record<string, unknown>;
  return keys.every(key => {
    const number = bounds[key];
    return Object.hasOwn(bounds, key) && typeof number === 'number' && Number.isInteger(number) &&
      number >= -0x80000000 && number <= 0x7fffffff;
  }) && Number(bounds.width) > 0 && Number(bounds.height) > 0;
}

function intersectionArea(left: WindowBounds, right: WindowBounds): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return Math.max(0, width) * Math.max(0, height);
}

function fitToDisplay(bounds: WindowBounds, workAreas: readonly WindowBounds[]): WindowBounds | null {
  let display: WindowBounds | undefined;
  let overlap = 0;
  for (const area of workAreas) {
    if (!isBounds(area)) continue;
    const candidate = intersectionArea(bounds, area);
    if (candidate > overlap) { display = area; overlap = candidate; }
  }
  if (!display) return null;
  const width = Math.max(defaults.minWidth, Math.min(bounds.width, display.width));
  const height = Math.max(defaults.minHeight, Math.min(bounds.height, display.height));
  return {
    x: Math.max(display.x, Math.min(bounds.x, display.x + display.width - width)),
    y: Math.max(display.y, Math.min(bounds.y, display.y + display.height - height)),
    width,
    height,
  };
}

/** Private geometry hint for the launcher. It follows the current display
 * arrangement and stores only the normal rectangle, including while maximized. */
export function createLauncherWindowState(root: string, workAreas: () => readonly WindowBounds[]) {
  const file = path.join(root, 'launcher-window-bounds.json');

  function options() {
    try {
      const text = readPrivateFile(file, { root, allowMissing: true, maxBytes, encoding: 'utf8' });
      const saved: unknown = typeof text === 'string' ? JSON.parse(text) : null;
      if (isBounds(saved)) {
        const restored = fitToDisplay(saved, workAreas());
        if (restored) return { ...defaults, ...restored };
      }
    } catch { /* Missing or unreadable geometry uses the centered default. */ }
    return { ...defaults, center: true };
  }

  function track(window: LauncherWindow): void {
    let latest: WindowBounds | undefined;
    let lastSaved: string | undefined;
    let pending: ReturnType<typeof setTimeout> | undefined;

    function observe() {
      try {
        if (window.isDestroyed()) return;
        const bounds = window.getNormalBounds();
        if (isBounds(bounds)) latest = { ...bounds };
      } catch { /* Native teardown can race a resize event. */ }
    }

    function flush() {
      clearTimeout(pending);
      pending = undefined;
      if (!latest) return;
      const serialized = JSON.stringify(latest) + '\n';
      if (serialized === lastSaved) return;
      try {
        writePrivateFileAtomic(file, serialized, { root, maxBytes });
        lastSaved = serialized;
      } catch { /* Geometry persistence must not block a window event. */ }
    }

    function onGeometryChanged() {
      observe();
      clearTimeout(pending);
      pending = setTimeout(flush, saveDelayMs);
      pending.unref();
    }

    function onClose() {
      observe();
      flush();
    }

    function onClosed() {
      window.removeListener('move', onGeometryChanged);
      window.removeListener('resize', onGeometryChanged);
      window.removeListener('close', onClose);
      window.removeListener('closed', onClosed);
      // Native methods are unavailable once closed. Flush the latest observed
      // normal rectangle when destruction bypasses the close event.
      flush();
    }

    observe();
    window.on('move', onGeometryChanged);
    window.on('resize', onGeometryChanged);
    window.on('close', onClose);
    window.on('closed', onClosed);
  }

  return { options, track };
}
