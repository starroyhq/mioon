// Development-package Windows title bar screenshots. Fixed inputs only: the
// outer smoke driver names one scenario, and the app captures its own window.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {App, NativeImage} from 'electron';
import {BrowserWindow, desktopCapturer, nativeImage, screen} from 'electron';
import {WINDOWS_TITLEBAR_BAND_COLOR_TOLERANCE, WINDOWS_WINDOW_CHROME} from '../../../packages/contracts/src/desktop-window-chrome.ts';
import {windowsTitleBarDiagnostics} from './window-chrome.ts';
import {openRegisteredProject} from './windows-project-open.ts';

export const WINDOWS_TITLEBAR_SCENARIOS = Object.freeze(['normal-light', 'normal-dark', 'maximized-light',
  'maximized-dark', 'dpi-125', 'dpi-150', 'workbench-light', 'workbench-dark', 'workbench-maximized-light',
  'workbench-maximized-dark'] as const);
export type WindowsTitleBarScenario = typeof WINDOWS_TITLEBAR_SCENARIOS[number];
export const WINDOWS_TITLEBAR_SCREENSHOT_PHASES = Object.freeze(['launcher-ready', 'workbench', 'theme', 'appearance', 'maximize', 'settle', 'facts', 'capture', 'verify-band', 'write'] as const);
type ScreenshotPhase = typeof WINDOWS_TITLEBAR_SCREENSHOT_PHASES[number];
export interface WindowsTitleBarScreenshotOptions {
  app: App;
  getWindow(): BrowserWindow | null;
  /** Loopback backend origin used by the workbench scenarios. */
  backendUrl: string;
  output: string;
  screenshot: string;
  scenario: string;
  theme: 'light' | 'dark';
  maximized: boolean;
  scale: number;
  /** Re-reads authenticated appearance so native chrome follows the new theme. */
  refreshAppearance(): void;
}
interface TitleBarFacts {
  frame: string | null;
  theme: string | null;
  innerWidth: number;
  devicePixelRatio: number;
  overlay: {visible: boolean; right: number};
  barHeight: number;
  trailing: number;
  barPaddingLeft: number;
  innerHeight: number;
}
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const evaluate = (window: BrowserWindow, script: string): Promise<unknown> => window.webContents.executeJavaScript(script, true);
async function waitFor(window: BrowserWindow, read: () => Promise<unknown>, deadlineMs: number, message: string): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    if (window.isDestroyed()) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
async function launcherReady(window: BrowserWindow): Promise<void> {
  await waitFor(window, () => evaluate(window, `Boolean(document.querySelector('[data-testid="project-home"]'))`) as Promise<boolean>,
    60000, 'Windows screenshot launcher did not become ready');
}
/** Sets the authenticated application preference through the same API the UI uses.
 * A concurrent writer can bump the revision between the read and the write, so a
 * rejected write is retried against a fresh revision instead of failing the run. */
async function applyTheme(window: BrowserWindow, theme: 'light' | 'dark', ready: () => Promise<void>): Promise<void> {
  const write = async (): Promise<boolean> => evaluate(window, `(async () => {
    const read = await fetch('/api/ui-preferences', {cache: 'no-store', credentials: 'same-origin'});
    const current = await read.json();
    if (!read.ok || !current || current.ok !== true || !current.data || typeof current.data.revision !== 'number') return false;
    const response = await fetch('/api/ui-preferences', {method: 'PUT', cache: 'no-store', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({expectedRevision: current.data.revision, requestId: 'windows-titlebar-' + Math.random().toString(36).slice(2),
        preferences: {...current.data.preferences, theme: ${JSON.stringify(theme)}}})});
    const saved = await response.json();
    return response.ok && saved && saved.ok === true && saved.data.preferences.theme === ${JSON.stringify(theme)};
  })()`) as unknown as boolean;
  let applied = false;
  for (let attempt = 0; attempt < 3 && !applied; attempt += 1) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 300));
    applied = await write();
  }
  assert.equal(applied, true, 'The screenshot theme preference must save');
  // A reload can race the preference write's visibility; retry the whole
  // navigate-and-apply once and report the renderer's real state if it fails.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    window.webContents.reload();
    await ready();
    const reached = await waitFor(window, () => evaluate(window, `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`) as Promise<boolean>,
      20000, '').then(() => true, () => false);
    if (reached) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const state = await evaluate(window, `(async () => {
    const stored = await fetch('/api/ui-preferences', {cache: 'no-store', credentials: 'same-origin'}).then(r => r.json()).catch(() => null);
    return {page: document.documentElement.dataset.theme || 'none', stored: stored?.data?.preferences?.theme || 'none',
      ready: document.readyState, root: document.getElementById('root')?.childElementCount ?? -1};
  })()`) as unknown as {page: string; stored: string; ready: string; root: number};
  throw new Error(`The screenshot theme did not reach the renderer page=${state.page} stored=${state.stored} ready=${state.ready} root=${state.root}`);
}
async function maximize(window: BrowserWindow): Promise<void> {
  if (window.isMaximized()) return;
  const done = new Promise<void>(resolve => window.once('maximize', () => resolve()));
  window.maximize();
  await Promise.race([done, new Promise<void>(resolve => setTimeout(resolve, 5000))]);
}
async function settle(window: BrowserWindow): Promise<void> {
  await evaluate(window, `(async () => {
    await document.fonts.ready;
    for (let index = 0; index < 3; index++) await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    await new Promise(resolve => setTimeout(resolve, 250));
    return true;
  })()`);
}
async function readFacts(window: BrowserWindow): Promise<TitleBarFacts> {
  return record(await evaluate(window, `(() => {
    const overlay = navigator.windowControlsOverlay;
    const rect = overlay && overlay.visible ? overlay.getTitlebarAreaRect() : null;
    const bar = document.querySelector('[data-testid="project-home"]:is(.launcher-home) .launcher-home-sidebar .launcher-home-titlebar')
      || document.querySelector('.launcher-home-titlebar') || document.querySelector('.workbench-topbar');
    const style = bar ? getComputedStyle(bar) : null;
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      frame: document.documentElement.dataset.desktopFrame || null,
      theme: document.documentElement.dataset.theme || null,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      overlay: {visible: Boolean(overlay && overlay.visible === true), right: rect ? rect.right : 0},
      barHeight: bar ? bar.getBoundingClientRect().height : 0,
      trailing: parseFloat(rootStyle.getPropertyValue('--win-titlebar-trailing')) || 0,
      barPaddingLeft: style ? parseFloat(style.paddingLeft) || 0 : 0,
    };
  })()`) as unknown) as unknown as TitleBarFacts;
}
/** Window capture first (includes the system-drawn caption band); the web
 * contents fallback only runs when the desktop capturer cannot name the window. */
async function capture(window: BrowserWindow, title: string): Promise<{png: Buffer; source: 'window' | 'content'}> {
  const bounds = window.getBounds();
  const scaleFactor = screen.getDisplayMatching(bounds).scaleFactor;
  const thumbnailSize = {width: Math.max(320, Math.round(bounds.width * scaleFactor)), height: Math.max(240, Math.round(bounds.height * scaleFactor))};
  try {
    const sources = await desktopCapturer.getSources({types: ['window'], thumbnailSize, fetchWindowIcons: false});
    const source = sources.find(candidate => candidate.name === title && !candidate.thumbnail.isEmpty());
    if (source) {
      const png = source.thumbnail.toPNG();
      if (png.length > 0) return {png, source: 'window'};
    }
  } catch { /* The content capture below is the fixed fallback. */ }
  const image: NativeImage = await window.webContents.capturePage();
  const png = image.toPNG();
  assert.ok(png.length > 0, 'The screenshot capture produced no bytes');
  return {png, source: 'content'};
}
/** Reports the color the page currently shows behind the band (same rule as the
 * renderer) so a failed comparison can be diagnosed from CI artifacts. */
const pageBandColorScript = `(() => {
  const overlay = navigator.windowControlsOverlay;
  if (!overlay || !overlay.getTitlebarAreaRect) return 'none';
  const rect = overlay.getTitlebarAreaRect();
  const band = window.innerWidth - rect.right;
  const x = Math.min(window.innerWidth - 2, Math.round(rect.right + band / 2));
  const y = Math.max(1, Math.min(window.innerHeight - 1, Math.round(rect.y + rect.height / 2)));
  let node = document.elementFromPoint(x, y);
  while (node) {
    const match = getComputedStyle(node).backgroundColor.match(/^rgba?\\(([^)]*)\\)$/);
    if (match) {
      const parts = match[1].split(/[,\\s/]+/).filter(Boolean);
      const alpha = parts.length > 3 ? Number(parts[3]) : 1;
      if (alpha > 0.99) return '#' + parts.slice(0, 3).map(part => Math.round(Number(part)).toString(16).padStart(2, '0')).join('');
    }
    node = node.parentElement;
  }
  return 'none';
})()`;
const cssColorToHex = (color: string | undefined): string => {
  if (!color) return 'none';
  if (/^#[0-9a-fA-F]{6}$/u.test(color)) return color.toLowerCase();
  const match = color.match(/^rgba?\(([^)]*)\)$/u);
  if (!match) return 'invalid';
  const parts = match[1]!.split(/[,\s/]+/u).filter(Boolean);
  return '#' + parts.slice(0, 3).map(part => Math.round(Number(part)).toString(16).padStart(2, '0')).join('');
};

const pixelHex = (pixel: readonly number[]): string => '#' + pixel.map(channel => channel.toString(16).padStart(2, '0')).join('');
/** The caption band is painted by the OS with the color the page reported.
 * Compare both the system band pixel and the page pixel beside it with that
 * exact reported color: this is the feature under test and does not depend on
 * fractional-scale rounding of the band's CSS boundary. */
function bandColorDelta(png: Buffer, facts: TitleBarFacts, reported: string): {delta: number; probe: string} {
  const image = nativeImage.createFromBuffer(png);
  const size = image.getSize(), bitmap = image.toBitmap();
  assert.ok(size.width > 0 && size.height > 0 && bitmap.length === size.width * size.height * 4, 'The screenshot bitmap is not RGBA');
  const hex = cssColorToHex(reported);
  const target = /^#[0-9a-f]{6}$/u.test(hex) ? [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)) : null;
  const scaleX = size.width / facts.innerWidth, scaleY = size.height / facts.innerHeight;
  // Sample 16 CSS px away from the reported boundary: at fractional device
  // scales the 1px page edge/inactive border line rounds onto the old 8px point.
  const xInside = Math.round((facts.overlay.right + 16) * scaleX);
  const xOutside = Math.round((facts.overlay.right - 16) * scaleX);
  const y = Math.round((WINDOWS_WINDOW_CHROME.topbarHeight - 6) * scaleY);
  assert.ok(xInside >= 0 && xInside < size.width && xOutside >= 0 && xOutside < size.width && y >= 0 && y < size.height, 'The band comparison point is outside the capture');
  const pixel = (x: number): number[] => {
    const offset = (y * size.width + x) * 4;
    return [bitmap[offset]!, bitmap[offset + 1]!, bitmap[offset + 2]!];
  };
  const inside = pixel(xInside), outside = pixel(xOutside);
  const probe = `in=${pixelHex(inside)} out=${pixelHex(outside)} target=${hex}`;
  const delta = (actual: number[]): number => Math.max(...actual.map((channel, index) => Math.abs(channel - target[index]!)));
  const probeText = `${probe} xy=${xInside},${xOutside},${y} sz=${size.width}x${size.height} iw=${facts.innerWidth} rt=${facts.overlay.right}`;
  // The system band pixel is the feature under test; the page pixel beside the
  // band can legitimately belong to a different topbar section (especially in
  // dark themes), so it is recorded in the probe but not asserted.
  if (target === null) return {delta: Math.max(Math.abs(inside[0]! - outside[0]!), Math.abs(inside[1]! - outside[1]!), Math.abs(inside[2]! - outside[2]!)), probe: probeText};
  return {delta: delta(inside), probe: probeText};
}

async function workbenchReady(window: BrowserWindow): Promise<void> {
  await waitFor(window, () => evaluate(window, `Boolean(document.querySelector('[data-testid="workbench"]'))`) as Promise<boolean>,
    60000, 'The screenshot workbench did not become ready');
}
/** Template projects cannot be opened through a native dialog in CI, so the
 * launcher renderer creates one through the reviewed backend entry and then
 * opens it through the trusted desktop bridge. Both are product paths. */
async function createWorkbenchScreenshotWindow({app, launcher, backendUrl}: {app: App; launcher: BrowserWindow; backendUrl: string}): Promise<{window: BrowserWindow; root: string}> {
  assert.ok(/^https?:\/\/127\.0\.0\.1:\d+$/u.test(backendUrl), 'The workbench screenshot needs the loopback backend URL');
  const root = path.join(app.getPath('documents'), 'Mioon Windows Screenshot ' + randomUUID());
  await mkdir(root, {recursive: true});
  // The launcher renderer owns the authenticated same-origin fetch; native
  // file dialogs cannot be automated in CI.
  const payload = record(await evaluate(launcher, `(async () => {
    const response = await fetch('/api/rpc', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({operation: 'project.template.instantiate', input: {templateId: 'timeline-basics', templateVersion: 1,
        parentDir: ${JSON.stringify(root)}, name: 'Screenshot ' + crypto.randomUUID().slice(0, 8), requestId: crypto.randomUUID()}})});
    return response.json().catch(() => null);
  })()`) as unknown);
  assert.ok(payload.ok === true, 'The workbench screenshot project could not be created');
  const project = record(record(payload.data).project), projectId = String(project.projectId);
  assert.match(projectId, /^[0-9a-f-]{36}$/u);
  const window = await openRegisteredProject(launcher, backendUrl, projectId);
  return {window, root};
}
const closeScreenshotWindow = async (window: BrowserWindow | undefined): Promise<void> => {
  if (!window || window.isDestroyed()) return;
  const closed = new Promise<void>(resolve => {window.once('closed', () => resolve());});
  try {window.close();} catch {try {window.destroy();} catch { /* Already gone. */ } return;}
  await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 5000))]);
  if (!window.isDestroyed()) try {window.destroy();} catch { /* Already gone. */ }
};

/** Runs one screenshot scenario, writes the fixed PNG and a fixed JSON record,
 * then returns so the caller can quit the application. */
export async function runWindowsTitleBarScreenshot({app, getWindow, backendUrl, output, screenshot, scenario, theme, maximized, scale, refreshAppearance}: WindowsTitleBarScreenshotOptions): Promise<void> {
  let phase: ScreenshotPhase = 'launcher-ready';
  let workbench: BrowserWindow | undefined, workbenchRoot: string | undefined;
  let captured: Buffer | undefined;
  let capturedMismatch: number | undefined;
  let bandProbe = '';
  let diag = '';
  const writeFailure = async (error: unknown): Promise<void> => {
    const message = String((error as Error)?.message ?? error ?? '').replace(/[^A-Za-z0-9# =:._-]/gu, '_').slice(0, 90);
    const detailProbe = bandProbe === '' ? '' : ` ${bandProbe}`;
    const detail = (capturedMismatch === undefined ? `error=${message}` : `bandColorDelta=${capturedMismatch}${detailProbe}${diag} error=${message}`).slice(0, 260);
    try {
      if (captured !== undefined) {
        try {await mkdir(path.dirname(screenshot), {recursive: true}); await writeFile(`${screenshot}.failed.png`, captured);}
        catch { /* The fixed JSON below still records the failing phase. */ }
      }
      await mkdir(path.dirname(output), {recursive: true});
      await writeFile(output, JSON.stringify({schemaVersion: 1, scope: 'windows-titlebar-screenshot', ok: false,
        code: 'WINDOWS_SMOKE_SCREENSHOT_CHECK_FAILED', check: phase, detail}) + '\n');
    } catch { /* The outer smoke driver records its own fixed failure code. */ }
  };
  try {
    const launcher = getWindow();
    assert.ok(launcher && !launcher.isDestroyed(), 'The screenshot launcher window must be live');
    assert.ok((WINDOWS_TITLEBAR_SCENARIOS as readonly string[]).includes(scenario), 'Unknown Windows title bar screenshot scenario');
    assert.equal(app.isPackaged, true);
    assert.equal(process.platform, 'win32');
    assert.equal(process.arch, 'x64');
    await launcherReady(launcher);
    let window = launcher;
    if (scenario.startsWith('workbench-')) {
      phase = 'workbench';
      const created = await createWorkbenchScreenshotWindow({app, launcher, backendUrl});
      window = created.window;
      workbench = created.window;
      workbenchRoot = created.root;
    }
    phase = 'theme';
    await applyTheme(window, theme, scenario.startsWith('workbench-') ? () => workbenchReady(window) : () => launcherReady(window));
    phase = 'appearance';
    // The saved preference is authoritative only after the window appearance reads
    // it back; that callback also repaints the system caption overlay colors.
    refreshAppearance();
    await new Promise(resolve => setTimeout(resolve, 300));
    phase = 'maximize';
    if (maximized) await maximize(window);
    // The system paints caption buttons for the active window; make this the
    // active one before comparing the band with the page beneath it.
    try {window.show(); window.focus(); app.focus({steal: true});} catch { /* Focus is best effort in CI sessions. */ }
    phase = 'settle';
    await settle(window);
    phase = 'facts';
    const facts = await readFacts(window);
    assert.equal(facts.frame, 'win-overlay');
    assert.equal(facts.theme, theme);
    assert.ok(Math.abs(facts.barHeight - WINDOWS_WINDOW_CHROME.topbarHeight) < 0.5, `Screenshot top bar height ${facts.barHeight}`);
    assert.equal(facts.overlay.visible, true, 'The system window controls overlay must be visible');
    assert.ok(facts.overlay.right > 0 && facts.overlay.right < facts.innerWidth);
    const reserved = facts.innerWidth - facts.overlay.right;
    assert.ok(Math.abs(facts.trailing - reserved) <= 1, `Reserved ${facts.trailing} must equal the reported control band ${reserved}`);
    assert.ok(Math.abs(facts.devicePixelRatio - scale) < 0.02, `Device scale factor ${facts.devicePixelRatio} differs from ${scale}`);
    assert.equal(window.isMaximized(), maximized);
    phase = 'capture';
    let pageColor = 'none';
    try {
      const page = await window.webContents.executeJavaScript(`(() => {
        const overlay = navigator.windowControlsOverlay;
        const rect = overlay && overlay.getTitlebarAreaRect ? overlay.getTitlebarAreaRect() : null;
        return {bridge: typeof window.__mioonWindowChrome === 'object', frame: document.documentElement.dataset.desktopFrame || 'none',
          visible: overlay ? overlay.visible === true : false, bandRight: rect ? rect.right : 0};
      })()`) as {bridge: boolean; frame: string; visible: boolean; bandRight: number};
      const diagnostics = windowsTitleBarDiagnostics(window);
      pageColor = await window.webContents.executeJavaScript(pageBandColorScript) as string;
      diag = ` bridge=${page.bridge ? 1 : 0} frame=${page.frame} visible=${page.visible ? 1 : 0} events=${diagnostics?.received ?? 0} page=${pageColor} received=${cssColorToHex(diagnostics?.lastReceived)} applied=${cssColorToHex(diagnostics?.applied)} error=${diagnostics?.error === undefined ? 'none' : diagnostics.error.replace(/[^A-Za-z0-9 =:._#-]/gu, '_')}`;
    } catch { diag = ' diagnostics=unavailable'; }
    let png: Buffer | undefined, source: 'window' | 'content' = 'window', bandDelta = 0;
    captured = undefined;
    // The DWM caption band repaints asynchronously after a theme change; at
    // fractional device scales it can trail the page by a frame or two. Re-capture
    // a bounded number of times while keeping the same color threshold.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        // An inactive window paints the system caption band in the inactive
        // color; re-focus before re-capturing a mismatched fractional-scale shot.
        try { window.show(); window.focus(); app.focus({steal: true}); } catch { /* Best effort in CI sessions. */ }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const shot = await capture(window, window.getTitle());
      png = shot.png; source = shot.source;
      captured = png;
      phase = 'verify-band';
      const measured = bandColorDelta(png, facts, pageColor);
      bandDelta = measured.delta; bandProbe = measured.probe;
      capturedMismatch = bandDelta;
      if (bandDelta <= WINDOWS_TITLEBAR_BAND_COLOR_TOLERANCE) break;
    }
    assert.ok(png !== undefined && png.length > 0, 'The screenshot capture produced no bytes');
    assert.ok(bandDelta <= WINDOWS_TITLEBAR_BAND_COLOR_TOLERANCE, `Caption band color differs from the page by ${bandDelta}`);
    phase = 'write';
    await mkdir(path.dirname(screenshot), {recursive: true});
    await writeFile(screenshot, png);
    const sha256 = createHash('sha256').update(png).digest('hex');
    await mkdir(path.dirname(output), {recursive: true});
    await writeFile(output, JSON.stringify({schemaVersion: 1, scope: 'windows-titlebar-screenshot', ok: true, scenario,
      platform: 'win32', arch: 'x64', isPackaged: true, theme, scale, maximized, frame: facts.frame,
      devicePixelRatio: facts.devicePixelRatio, overlay: {visible: facts.overlay.visible, right: facts.overlay.right},
      innerWidth: facts.innerWidth, barHeight: facts.barHeight, trailing: facts.trailing, bandColorDelta: bandDelta,
      screenshot: {bytes: png.length, sha256, source}}, null, 2) + '\n');
  } catch (error) {
    await writeFailure(error);
  } finally {
    await closeScreenshotWindow(workbench);
    if (workbenchRoot !== undefined) await rm(workbenchRoot, {recursive: true, force: true}).catch(() => {});
  }
}
