// Development-package Windows title bar screenshots. Fixed inputs only: the
// outer smoke driver names one scenario, and the app captures its own window.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {App, BrowserWindow, NativeImage} from 'electron';
import {desktopCapturer, screen} from 'electron';
import {WINDOWS_WINDOW_CHROME} from '../../../packages/contracts/src/desktop-window-chrome.ts';

export const WINDOWS_TITLEBAR_SCENARIOS = Object.freeze(['normal-light', 'normal-dark', 'maximized-light',
  'maximized-dark', 'dpi-125', 'dpi-150'] as const);
export type WindowsTitleBarScenario = typeof WINDOWS_TITLEBAR_SCENARIOS[number];
export interface WindowsTitleBarScreenshotOptions {
  app: App;
  getWindow(): BrowserWindow | null;
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
/** Sets the authenticated application preference through the same API the UI uses. */
async function applyTheme(window: BrowserWindow, theme: 'light' | 'dark'): Promise<void> {
  const applied = await evaluate(window, `(async () => {
    const read = await fetch('/api/ui-preferences', {cache: 'no-store', credentials: 'same-origin'});
    const current = await read.json();
    if (!read.ok || !current || current.ok !== true || !current.data || typeof current.data.revision !== 'number') return false;
    const response = await fetch('/api/ui-preferences', {method: 'PUT', cache: 'no-store', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({expectedRevision: current.data.revision, requestId: 'windows-titlebar-' + Math.random().toString(36).slice(2),
        preferences: {...current.data.preferences, theme: ${JSON.stringify(theme)}}})});
    const saved = await response.json();
    return response.ok && saved && saved.ok === true && saved.data.preferences.theme === ${JSON.stringify(theme)};
  })()`) as boolean;
  assert.equal(applied, true, 'The screenshot theme preference must save');
  window.webContents.reload();
  await launcherReady(window);
  await waitFor(window, () => evaluate(window, `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`) as Promise<boolean>,
    30000, 'The screenshot theme did not reach the renderer');
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
      innerWidth: window.innerWidth,
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
/** Runs one screenshot scenario, writes the fixed PNG and a fixed JSON record,
 * then returns so the caller can quit the application. */
export async function runWindowsTitleBarScreenshot({app, getWindow, output, screenshot, scenario, theme, maximized, scale, refreshAppearance}: WindowsTitleBarScreenshotOptions): Promise<void> {
  const window = getWindow();
  assert.ok(window && !window.isDestroyed(), 'The screenshot launcher window must be live');
  assert.ok((WINDOWS_TITLEBAR_SCENARIOS as readonly string[]).includes(scenario), 'Unknown Windows title bar screenshot scenario');
  assert.equal(app.isPackaged, true);
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  await launcherReady(window);
  await applyTheme(window, theme);
  // The saved preference is authoritative only after the window appearance reads
  // it back; that callback also repaints the system caption overlay colors.
  refreshAppearance();
  await new Promise(resolve => setTimeout(resolve, 300));
  if (maximized) await maximize(window);
  await settle(window);
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
  const {png, source} = await capture(window, window.getTitle());
  await mkdir(path.dirname(screenshot), {recursive: true});
  await writeFile(screenshot, png);
  const sha256 = createHash('sha256').update(png).digest('hex');
  await mkdir(path.dirname(output), {recursive: true});
  await writeFile(output, JSON.stringify({schemaVersion: 1, scope: 'windows-titlebar-screenshot', ok: true, scenario,
    platform: 'win32', arch: 'x64', isPackaged: true, theme, scale, maximized, frame: facts.frame,
    devicePixelRatio: facts.devicePixelRatio, overlay: {visible: facts.overlay.visible, right: facts.overlay.right},
    innerWidth: facts.innerWidth, barHeight: facts.barHeight, trailing: facts.trailing,
    screenshot: {bytes: png.length, sha256, source}}, null, 2) + '\n');
}
