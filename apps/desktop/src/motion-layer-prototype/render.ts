import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { endianness } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, protocol, screen, session } from 'electron';
import type { NativeImage } from 'electron';
import { TIMELINE_SUBTITLE_FONT_SHA256 } from '../../../../packages/contracts/src/timeline-subtitle-profile.ts';

const scheme = 'mioon-motion';
const assetOrigin = `${scheme}://prototype`;
const contentTypes = {
  'index.html': 'text/html; charset=utf-8',
  'page.js': 'text/javascript; charset=utf-8',
  'stylesheet.css': 'text/css; charset=utf-8',
  'font.otf': 'font/otf',
  'video.mp4': 'video/mp4',
};
type Asset = keyof typeof contentTypes;

const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function registerMotionScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  }]);
}

type MotionMode = 'export' | 'preview';
interface MotionWindowOptions {
  assetsDirectory: string;
  width: number;
  height: number;
  fps?: number;
  mode: MotionMode;
  showPreview?: boolean;
  signal?: AbortSignal;
}

export interface MotionWindow {
  window: BrowserWindow;
  devicePixelRatio: number;
  render(frame: number): Promise<Buffer>;
  close(): void;
}

async function readAssets(directory: string, mode: MotionMode): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const names = (Object.keys(contentTypes) as Asset[]).filter(name => mode === 'preview' || name !== 'video.mp4');
  const files = await Promise.all(names.map(async name => {
    const file = join(directory, name);
    if (!(await lstat(file)).isFile()) throw Error(`Invalid motion prototype asset: ${name}`);
    const bytes = await readFile(file);
    if (name === 'font.otf' && createHash('sha256').update(bytes).digest('hex') !== TIMELINE_SUBTITLE_FONT_SHA256) {
      throw Error('Motion prototype font SHA-256 mismatch');
    }
    return [`/${name}`, Uint8Array.from(bytes)] as const;
  }));
  return new Map(files);
}

function assetPath(url: string, entry: string): string | null {
  if (url === entry) return '/index.html';
  // Match exact URLs. No path is constructed from request input.
  const path = url.slice(assetOrigin.length);
  return url.startsWith(`${assetOrigin}/`) && path !== '/index.html' ? path : null;
}

function assetResponse(request: Request, asset: Asset, bytes: Uint8Array<ArrayBuffer>): Response {
  const headers = new Headers({
    'Content-Type': contentTypes[asset],
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  const range = asset === 'video.mp4' ? request.headers.get('range') : null;
  if (range !== null) {
    const parts = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = parts ? Number(parts[1]) : NaN;
    const end = parts?.[2] ? Math.min(Number(parts[2]), bytes.length - 1) : bytes.length - 1;
    if (!Number.isSafeInteger(start) || start < 0 || start > end) {
      headers.set('Content-Range', `bytes */${bytes.length}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers });
  }
  if (asset === 'video.mp4') headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(bytes.length));
  return new Response(bytes, { headers });
}

function withDeadline<T>(action: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (reason: unknown) => { cleanup(); reject(reason); };
    const onAbort = () => fail(signal.reason);
    const timer = setTimeout(() => fail(Error(`Motion prototype ${label} timed out`)), 10_000);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void action.then(value => { cleanup(); resolve(value); }, fail);
  });
}

function rgbaBitmap(image: NativeImage, width: number, height: number, rasterScale: number): Buffer {
  const size = image.getSize();
  const capturedAtNativeScale = rasterScale > 1 &&
    size.width === Math.round(width * rasterScale) && size.height === Math.round(height * rasterScale);
  // Retina preview is rendered at the display scale. Compare it at logical video size,
  // resampling the premultiplied bitmap before converting to straight alpha.
  const normalized = capturedAtNativeScale ? image.resize({ width, height, quality: 'good' }) : image;
  const rgba = normalized.toBitmap({ scaleFactor: 1 });
  const outputSize = normalized.getSize();
  if (outputSize.width !== width || outputSize.height !== height || rgba.length !== width * height * 4) {
    throw Error(`Motion prototype capture returned ${size.width}×${size.height} at DPR ${rasterScale}`);
  }
  // Electron uses Skia's little-endian N32 (premultiplied BGRA) bitmaps.
  // FFmpeg expects straight RGBA for overlay=alpha=straight.
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = rgba[index + 3];
    if (alpha === 0) {
      rgba[index] = rgba[index + 1] = rgba[index + 2] = 0;
    } else if (alpha === 255) {
      const blue = rgba[index];
      rgba[index] = rgba[index + 2];
      rgba[index + 2] = blue;
    } else {
      const blue = rgba[index];
      rgba[index] = Math.round(rgba[index + 2] * 255 / alpha);
      rgba[index + 1] = Math.round(rgba[index + 1] * 255 / alpha);
      rgba[index + 2] = Math.round(blue * 255 / alpha);
    }
  }
  return rgba;
}

export async function createMotionWindow(options: MotionWindowOptions): Promise<MotionWindow> {
  const { assetsDirectory, width, height, fps = 30, mode, signal: caller } = options;
  if (![width, height, fps].every(value => Number.isSafeInteger(value) && value > 0) || endianness() !== 'LE') {
    throw Error('Unsupported motion prototype frame configuration');
  }
  caller?.throwIfAborted();
  const assets = await readAssets(assetsDirectory, mode);
  caller?.throwIfAborted();

  const entry = `${assetOrigin}/index.html?mode=${mode}&width=${width}&height=${height}&fps=${fps}`;
  const isolated = session.fromPartition(`motion-prototype-${randomUUID()}`, { cache: false });
  const allowed = (url: string) => assets.get(assetPath(url, entry) ?? '');
  isolated.webRequest.onBeforeRequest((details, reply) => reply({ cancel: !allowed(details.url) }));
  isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  isolated.protocol.handle(scheme, request => {
    const path = assetPath(request.url, entry);
    if (request.method !== 'GET' || !path) return new Response(null, { status: 403 });
    const bytes = assets.get(path);
    if (!bytes) return new Response(null, { status: 403 });
    return assetResponse(request, path.slice(1) as Asset, bytes);
  });

  const interactive = mode === 'preview' && options.showPreview === true;
  const area = screen.getPrimaryDisplay().workAreaSize;
  const fit = interactive ? Math.min(1, area.width * 0.9 / width, area.height * 0.9 / height) : 1;
  const window = new BrowserWindow({
    width: Math.max(1, Math.round(width * fit)),
    height: Math.max(1, Math.round(height * fit)),
    useContentSize: true,
    enableLargerThanScreen: true,
    show: false,
    frame: interactive,
    transparent: !interactive,
    backgroundColor: interactive ? '#0e0f13' : '#00000000',
    webPreferences: {
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webviewTag: false,
      devTools: false,
      backgroundThrottling: false,
      offscreen: mode === 'export' ? { deviceScaleFactor: 1 } : false,
    },
  });
  const { webContents } = window;
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-frame-navigate', event => event.preventDefault());
  webContents.on('will-redirect', event => event.preventDefault());
  webContents.on('will-attach-webview', event => event.preventDefault());

  const lifetime = new AbortController();
  const signal = lifetime.signal;
  const close = () => { if (!window.isDestroyed()) window.destroy(); };
  const cancel = () => {
    lifetime.abort(caller?.reason);
    close();
  };
  window.once('closed', () => {
    lifetime.abort(Error('Motion prototype window closed'));
    caller?.removeEventListener('abort', cancel);
    isolated.protocol.unhandle(scheme);
    assets.clear();
  });
  webContents.once('render-process-gone', (_event, { reason }) => {
    lifetime.abort(Error(`Motion prototype renderer stopped: ${reason}`));
    close();
  });
  window.once('unresponsive', () => {
    lifetime.abort(Error('Motion prototype renderer is unresponsive'));
    close();
  });
  caller?.addEventListener('abort', cancel, { once: true });
  if (caller?.aborted) cancel();

  let devicePixelRatio: number;
  try {
    signal.throwIfAborted();
    await withDeadline(window.loadURL(entry), signal, 'page load');
    const ratio: unknown = await withDeadline(webContents.executeJavaScript(
      'window.motionPrototype.ready.then(() => devicePixelRatio)'), signal, 'font load');
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 1 || (mode === 'export' && ratio !== 1)) {
      throw Error('Unsupported motion prototype rendering scale');
    }
    devicePixelRatio = ratio;
    if (interactive) window.show();
  } catch (error) {
    close();
    throw error;
  }

  let capturing = false;
  return {
    window,
    devicePixelRatio,
    close,
    async render(frame) {
      if (!Number.isSafeInteger(frame) || frame < 0) throw Error('Invalid motion prototype frame');
      if (capturing) throw Error('Motion prototype frames must be captured serially');
      signal.throwIfAborted();
      capturing = true;
      try {
        await withDeadline(webContents.executeJavaScript(`
          (async () => {
            window.motionPrototype.setOverlayOnly(true);
            if (innerWidth !== ${width} || innerHeight !== ${height}) {
              throw Error('Motion prototype capture expected ${width}×${height}; got ' + innerWidth + '×' + innerHeight);
            }
            window.motionPrototype.render(${frame});
            // Let Chromium submit the committed React frame before copying the surface.
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          })()
        `), signal, 'frame commit');
        const image = await withDeadline(webContents.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true }),
          signal, 'frame capture');
        return rgbaBitmap(image, width, height, devicePixelRatio);
      } catch (error) {
        close();
        throw error;
      } finally {
        capturing = false;
      }
    },
  };
}
