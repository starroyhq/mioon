import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { applyWindowsTitleBarOverlay, installWindowChrome, windowChromeOptions, windowsTitleBarAppearance, MAC_TRAFFIC_LIGHT_POSITION } from '../apps/desktop/src/window-chrome.ts';
import type { WindowTitleBarOverlay } from '../apps/desktop/src/window-chrome.ts';
import { DESKTOP_CHROME_SCALE_EVENT, DESKTOP_FULLSCREEN_EVENT, isDesktopChromeScale, macWindowChrome, MAC_WINDOW_CHROME,
  WINDOWS_WINDOW_CHROME, windowsTitleBarOverlay } from '../packages/contracts/src/desktop-window-chrome.ts';
import { WINDOW_BACKGROUNDS } from '../apps/desktop/src/window-appearance.ts';
import { createLauncherWindowState } from '../apps/desktop/src/launcher-window-state.ts';
import type { WindowBounds } from '../apps/desktop/src/launcher-window-state.ts';
import { applyDesktopFrame, desktopFrame, windowsTitleBarTrailingInset } from '../apps/web/src/desktop-frame.ts';
import type { WindowControlsOverlayLike } from '../apps/web/src/desktop-frame.ts';

const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
const macShell = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Mioon/0.4.1 Chrome/152.0.0.0 Electron/44.7.0 Safari/537.36';

test('macOS hides the title bar for traffic lights and Windows uses the system caption overlay; other platforms keep their native frame', () => {
  const options = windowChromeOptions('darwin');
  assert.equal(options.titleBarStyle, 'hidden');
  assert.deepEqual(options.trafficLightPosition, MAC_TRAFFIC_LIGHT_POSITION);
  assert.notEqual(options.trafficLightPosition, MAC_TRAFFIC_LIGHT_POSITION, 'the frozen default must not be handed to Electron');
  for (const platform of ['linux', 'freebsd'] as const) assert.deepEqual(windowChromeOptions(platform as Parameters<typeof windowChromeOptions>[0]), {});
  assert.deepEqual(windowChromeOptions('win32'), {}, 'the overlay needs the resolved app appearance');
  for (const background of [WINDOW_BACKGROUNDS.dark, WINDOW_BACKGROUNDS.light]) {
    const appearance = windowsTitleBarAppearance(background);
    const win = windowChromeOptions('win32', background);
    assert.deepEqual(win, {titleBarStyle: 'hidden', titleBarOverlay: windowsTitleBarOverlay(appearance)});
    assert.equal(win.titleBarOverlay!.height, MAC_WINDOW_CHROME.topbarHeight, 'the overlay band shares the measured top bar height');
    assert.equal(win.titleBarOverlay!.height, WINDOWS_WINDOW_CHROME.topbarHeight);
    assert.notEqual(win.titleBarOverlay, windowsTitleBarOverlay(appearance), 'the frozen table must not be handed to Electron');
  }
  assert.equal(windowsTitleBarAppearance(WINDOW_BACKGROUNDS.dark.toUpperCase()), 'dark');
  assert.equal(windowsTitleBarAppearance('#F6F6F6'), 'light');
  assert.deepEqual(windowsTitleBarOverlay('dark'), {color: '#141518', symbolColor: '#ECEDEF', height: 44});
  assert.deepEqual(windowsTitleBarOverlay('light'), {color: '#FFFFFF', symbolColor: '#191C1F', height: 44});
});

test('the Windows caption overlay follows the same appearance updates as the native window fill', () => {
  const applied: unknown[] = [];
  const holder = {destroyed: false};
  const window = {isDestroyed: () => holder.destroyed, setTitleBarOverlay(options: WindowTitleBarOverlay) {applied.push(options);}};
  applyWindowsTitleBarOverlay(window, WINDOW_BACKGROUNDS.dark);
  applyWindowsTitleBarOverlay(window, WINDOW_BACKGROUNDS.light);
  assert.deepEqual(applied, [windowsTitleBarOverlay('dark'), windowsTitleBarOverlay('light')]);
  holder.destroyed = true;
  applyWindowsTitleBarOverlay(window, WINDOW_BACKGROUNDS.dark);
  assert.equal(applied.length, 2, 'a destroyed window keeps its last painted overlay');
  applyWindowsTitleBarOverlay({isDestroyed: () => false}, WINDOW_BACKGROUNDS.dark);
  const failing = {isDestroyed: () => false, setTitleBarOverlay() {throw new Error('synthetic native failure');}};
  applyWindowsTitleBarOverlay(failing, WINDOW_BACKGROUNDS.dark);
});

test('the measured native controls share the top bar center, outer inset and brand gap', () => {
  const chrome = MAC_WINDOW_CHROME;
  assert.equal(chrome.position.y - chrome.controlOutset + chrome.controlHeight / 2, chrome.topbarHeight / 2);
  assert.equal(chrome.position.x, chrome.position.y);
  assert.equal(chrome.leadingInset - (chrome.position.x - chrome.controlOutset) - chrome.controlGroupWidth, chrome.gap);
  assert.equal(MAC_TRAFFIC_LIGHT_POSITION, chrome.position);
});

test('supported page scales preserve native control centers and the scaled brand gap', () => {
  for (const scale of [0.9, 0.95, 1, 1.1, 1.25]) {
    const chrome = macWindowChrome(scale);
    const inset = chrome.position.x - chrome.controlOutset;
    assert.ok(Math.abs(inset + chrome.controlHeight / 2 - chrome.topbarHeight * scale / 2) < 1);
    assert.equal(chrome.position.x, chrome.position.y);
    assert.ok(Math.abs(chrome.leadingInset * scale - (inset + chrome.controlGroupWidth + chrome.gap * scale)) < 1e-9);
  }
  for (const invalid of [0.89, 1.26, NaN, Infinity, '1', null, undefined]) {
    assert.equal(isDesktopChromeScale(invalid), false);
    if (invalid !== undefined) assert.throws(() => macWindowChrome(invalid as number), RangeError);
  }
  assert.deepEqual(macWindowChrome(), MAC_WINDOW_CHROME);
});

test('native showing and fullscreen transitions restore the inset and publish only current window state', async t => {
  let destroyed = false, contentsDestroyed = false, fullscreen = false, visible = true;
  let position = {x: 8, y: 8};
  const sent: Array<{channel: string; fullscreen: boolean}> = [];
  const visibilityChanges: boolean[] = [];
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => contentsDestroyed,
    send: (channel: string, value: boolean) => {sent.push({channel, fullscreen: value});},
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => destroyed,
    isFullScreen: () => fullscreen,
    setWindowButtonVisibility: (value: boolean) => {visible = value; visibilityChanges.push(value);},
    setWindowButtonPosition: (value: {x: number; y: number}) => {position = value;},
  });
  const release = installWindowChrome(window, 'darwin');
  t.after(release);
  assert.deepEqual(position, MAC_TRAFFIC_LIGHT_POSITION);
  assert.notEqual(position, MAC_TRAFFIC_LIGHT_POSITION);
  assert.equal(visible, true);
  assert.deepEqual(visibilityChanges, [], 'ordinary windows and modal sheets retain their native visibility');
  assert.deepEqual(sent.at(-1), {channel: DESKTOP_FULLSCREEN_EVENT, fullscreen: false});

  window.emit('ready-to-show');
  window.emit('show');
  position = {x: 8, y: 8}; // Native layout can finish after the show callback.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(position, MAC_TRAFFIC_LIGHT_POSITION);
  assert.deepEqual(visibilityChanges, []);

  fullscreen = true;
  window.emit('enter-full-screen');
  assert.equal(visible, false);
  assert.deepEqual(sent.at(-1), {channel: DESKTOP_FULLSCREEN_EVENT, fullscreen: true});
  const fullscreenPosition = position;
  contents.emit('ipc-message', {senderFrame: contents.mainFrame}, DESKTOP_CHROME_SCALE_EVENT, 1.25);
  assert.equal(position, fullscreenPosition);
  contents.emit('dom-ready');
  assert.deepEqual(sent.at(-1), {channel: DESKTOP_FULLSCREEN_EVENT, fullscreen: true});

  fullscreen = false;
  window.emit('leave-full-screen');
  position = {x: 8, y: 8};
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(visible, true);
  assert.deepEqual(visibilityChanges, [false, true]);
  assert.deepEqual(position, macWindowChrome(1.25).position);
  assert.deepEqual(sent.at(-1), {channel: DESKTOP_FULLSCREEN_EVENT, fullscreen: false});

  contentsDestroyed = true;
  const count = sent.length;
  contents.emit('dom-ready');
  assert.equal(sent.length, count);
  window.emit('show');
  destroyed = true;
  window.emit('closed');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(window.eventNames(), []);
  assert.deepEqual(contents.eventNames(), []);
  assert.equal(sent.length, count);
});

test('only the current main frame can update its own native chrome scale within the supported bounds', t => {
  let position = {...MAC_TRAFFIC_LIGHT_POSITION};
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send() {},
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    isFullScreen: () => false,
    setWindowButtonVisibility() {},
    setWindowButtonPosition: (value: {x: number; y: number}) => {position = value;},
  });
  const release = installWindowChrome(window, 'darwin');
  t.after(release);
  for (const scale of [0.9, 1, 1.1, 1.25]) {
    contents.emit('ipc-message', {senderFrame: contents.mainFrame}, DESKTOP_CHROME_SCALE_EVENT, scale);
    assert.deepEqual(position, macWindowChrome(scale).position);
  }
  const expected = position;
  for (const value of [0.89, 1.26, NaN, Infinity, '1', null, undefined]) {
    contents.emit('ipc-message', {senderFrame: contents.mainFrame}, DESKTOP_CHROME_SCALE_EVENT, value);
    assert.equal(position, expected);
  }
  contents.emit('ipc-message', {senderFrame: {}}, DESKTOP_CHROME_SCALE_EVENT, 1);
  contents.emit('ipc-message', {senderFrame: null}, DESKTOP_CHROME_SCALE_EVENT, 1);
  contents.emit('ipc-message', {senderFrame: contents.mainFrame}, 'unrelated-channel', 1);
  contents.emit('ipc-message', {senderFrame: contents.mainFrame}, DESKTOP_CHROME_SCALE_EVENT, 1, 1.25);
  assert.equal(position, expected);
  const previousFrame = contents.mainFrame;
  contents.mainFrame = {};
  contents.emit('ipc-message', {senderFrame: previousFrame}, DESKTOP_CHROME_SCALE_EVENT, 1);
  assert.equal(position, expected);
  contents.emit('ipc-message', {senderFrame: contents.mainFrame}, DESKTOP_CHROME_SCALE_EVENT, 1);
  assert.deepEqual(position, MAC_TRAFFIC_LIGHT_POSITION);
  release();
  const releasedPosition = position;
  contents.emit('ipc-message', {senderFrame: contents.mainFrame}, DESKTOP_CHROME_SCALE_EVENT, 1.25);
  assert.equal(position, releasedPosition);
});

test('native chrome lifecycle leaves other platforms untouched', () => {
  for (const platform of ['linux', 'win32', 'freebsd'] as const) {
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => assert.fail('Native chrome is macOS-only'),
      isFullScreen: () => assert.fail('Native chrome is macOS-only'),
      setWindowButtonVisibility: () => assert.fail('Native chrome is macOS-only'),
      setWindowButtonPosition: () => assert.fail('Native chrome is macOS-only'),
      webContents: Object.assign(new EventEmitter(), {
        mainFrame: {},
        isDestroyed: () => assert.fail('Native chrome is macOS-only'),
        send: () => assert.fail('Native chrome is macOS-only'),
      }),
    });
    installWindowChrome(window, platform)();
    assert.deepEqual(window.eventNames(), []);
    assert.deepEqual(window.webContents.eventNames(), []);
  }
});

test('the macOS main-frame preload retains early fullscreen state and removes its passive listener on unload', () => {
  const source = readFileSync(new URL('../apps/desktop/src/preload.ts', import.meta.url), 'utf8');
  const block = source.match(/if \(process\.isMainFrame && process\.platform === 'darwin'\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(block);
  for (const process of [{isMainFrame: true, platform: 'darwin'}, {isMainFrame: false, platform: 'darwin'}, {isMainFrame: true, platform: 'linux'}, {isMainFrame: true, platform: 'win32'}]) {
    const published: Array<{channel: string; scale: number}> = [];
    const ipc = Object.assign(new EventEmitter(), {send: (channel: string, scale: number) => {published.push({channel, scale});}});
    const documentEvents = new EventEmitter(), windowEvents = new EventEmitter();
    const styles = new Map<string, string>();
    const observed: unknown[] = [];
    let observer: TestObserver | undefined;
    class TestObserver {
      disconnected = false;
      readonly callback: () => void;
      constructor(callback: () => void) {this.callback = callback; observer = this;}
      observe(target: unknown, options: unknown) {observed.push({target, options});}
      disconnect() {this.disconnected = true;}
      styleChanged() {if (!this.disconnected) this.callback();}
    }
    const document = {
      readyState: 'loading',
      documentElement: null as null | {dataset: Record<string, string>; style: {getPropertyValue: (name: string) => string}},
      addEventListener: documentEvents.on.bind(documentEvents),
      removeEventListener: documentEvents.removeListener.bind(documentEvents),
    };
    const window = {addEventListener: windowEvents.on.bind(windowEvents)};
    Function('process', 'document', 'window', 'ipcRenderer', 'DESKTOP_FULLSCREEN_EVENT', 'DESKTOP_CHROME_SCALE_EVENT', 'isDesktopChromeScale', 'MutationObserver', stripTypeScriptTypes(block))(
      process, document, window, ipc, DESKTOP_FULLSCREEN_EVENT, DESKTOP_CHROME_SCALE_EVENT, isDesktopChromeScale, TestObserver);
    const active = process.isMainFrame && process.platform === 'darwin';
    assert.equal(ipc.listenerCount(DESKTOP_FULLSCREEN_EVENT), Number(active));
    ipc.emit(DESKTOP_FULLSCREEN_EVENT, {}, true);
    document.documentElement = {dataset: {}, style: {getPropertyValue: name => styles.get(name) ?? ''}};
    documentEvents.emit('DOMContentLoaded');
    assert.deepEqual(published, active ? [{channel: DESKTOP_CHROME_SCALE_EVENT, scale: 1}] : []);
    assert.deepEqual(observed, active ? [{target: document.documentElement, options: {attributes: true, attributeFilter: ['style']}}] : []);
    styles.set('--mioon-ui-scale', '1.25');
    observer?.styleChanged();
    observer?.styleChanged();
    for (const invalid of ['0.89', '1.26', 'NaN', 'Infinity', 'invalid']) {
      styles.set('--mioon-ui-scale', invalid);
      observer?.styleChanged();
    }
    assert.deepEqual(published, active ? [{channel: DESKTOP_CHROME_SCALE_EVENT, scale: 1}, {channel: DESKTOP_CHROME_SCALE_EVENT, scale: 1.25}] : []);
    assert.equal(document.documentElement.dataset.desktopFullscreen, active ? 'true' : undefined);
    ipc.emit(DESKTOP_FULLSCREEN_EVENT, {}, 'false');
    assert.equal(document.documentElement.dataset.desktopFullscreen, active ? 'true' : undefined);
    ipc.emit(DESKTOP_FULLSCREEN_EVENT, {}, false);
    assert.equal(document.documentElement.dataset.desktopFullscreen, active ? 'false' : undefined);
    windowEvents.emit('unload');
    assert.equal(ipc.listenerCount(DESKTOP_FULLSCREEN_EVENT), 0);
    assert.equal(documentEvents.listenerCount('DOMContentLoaded'), 0);
    assert.equal(observer?.disconnected, active ? true : undefined);
    const publishedCount = published.length;
    styles.set('--mioon-ui-scale', '1');
    observer?.styleChanged();
    assert.equal(published.length, publishedCount);
    ipc.emit(DESKTOP_FULLSCREEN_EVENT, {}, true);
    assert.equal(document.documentElement.dataset.desktopFullscreen, active ? 'false' : undefined);
  }
});

test('the renderer insets its top bar only inside the supported desktop shells', () => {
  const windowsShell = macShell.replace('Macintosh; Intel Mac OS X 10_15_7', 'Windows NT 10.0; Win64; x64');
  assert.equal(desktopFrame(macShell), 'mac-inset');
  assert.equal(desktopFrame(windowsShell), 'win-overlay');
  assert.equal(desktopFrame(windowsShell.replace(' Electron/44.7.0', '')), null, 'a Windows browser keeps its own chrome');
  assert.equal(desktopFrame(macShell.replace('Macintosh; Intel Mac OS X 10_15_7', 'X11; Linux x86_64')), null);
  assert.equal(desktopFrame('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), null);
  assert.equal(desktopFrame(''), null);
  assert.equal(desktopFrame(), null);
});

test('the macOS renderer derives its height and reserved space from the shared native geometry', () => {
  const agents = [macShell, macShell.replace('Macintosh; Intel Mac OS X 10_15_7', 'Windows NT 10.0; Win64; x64'),
    macShell.replace('Macintosh; Intel Mac OS X 10_15_7', 'X11; Linux x86_64'), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'];
  for (const userAgent of agents) {
    const properties = new Map<string, string>();
    const root = {dataset: {} as Record<string, string>, style: {setProperty: (key: string, value: string) => {properties.set(key, value);}}};
    applyDesktopFrame(root as unknown as Parameters<typeof applyDesktopFrame>[0], userAgent, 1, undefined, 1440);
    const mac = userAgent === macShell, windows = userAgent.includes('Windows NT');
    assert.equal(root.dataset.desktopFrame, mac ? 'mac-inset' : windows ? 'win-overlay' : undefined);
    assert.deepEqual([...properties], mac ? [
      ['--wb-topbar', `${MAC_WINDOW_CHROME.topbarHeight}px`],
      ['--mac-titlebar-inset', `${MAC_WINDOW_CHROME.leadingInset}px`],
      ['--mac-titlebar-gap', `${MAC_WINDOW_CHROME.gap}px`],
    ] : windows ? [
      ['--wb-topbar', `${WINDOWS_WINDOW_CHROME.topbarHeight}px`],
      ['--win-titlebar-trailing', '0px'],
    ] : []);
  }
});

test('the Windows renderer reserves exactly the window-control overlay width from the live API', () => {
  const controlWidth = 138;
  let rectRight = 1440 - controlWidth, overlayVisible = true;
  const listeners: Array<() => void> = [];
  const overlay: WindowControlsOverlayLike = {
    get visible() {return overlayVisible;},
    getTitlebarAreaRect: () => ({right: rectRight}),
    addEventListener: (_type, listener) => {listeners.push(listener);},
  };
  const properties = new Map<string, string>();
  const root = {dataset: {} as Record<string, string>, style: {setProperty: (key: string, value: string) => {properties.set(key, value);}}};
  applyDesktopFrame(root as unknown as Parameters<typeof applyDesktopFrame>[0],
    macShell.replace('Macintosh; Intel Mac OS X 10_15_7', 'Windows NT 10.0; Win64; x64'), 1, overlay, 1440);
  assert.equal(root.dataset.desktopFrame, 'win-overlay');
  assert.equal(properties.get('--wb-topbar'), `${WINDOWS_WINDOW_CHROME.topbarHeight}px`);
  assert.equal(`${parseFloat(properties.get('--win-titlebar-trailing')!)}px`, `${controlWidth}px`);
  rectRight = 1440 - 152;
  for (const listener of listeners) listener();
  assert.equal(properties.get('--win-titlebar-trailing'), '152px');
  overlayVisible = false;
  for (const listener of listeners) listener();
  assert.equal(properties.get('--win-titlebar-trailing'), '0px', 'a hidden overlay reserves nothing (fullscreen)');
  assert.equal(windowsTitleBarTrailingInset({visible: true, getTitlebarAreaRect: () => ({right: 1302})}, 1440), 138);
  assert.equal(windowsTitleBarTrailingInset({visible: true, getTitlebarAreaRect: () => ({right: 1302})}, 1440, 1.25), 110.4);
  assert.equal(windowsTitleBarTrailingInset({visible: false, getTitlebarAreaRect: () => ({right: 1302})}, 1440), 0);
  assert.equal(windowsTitleBarTrailingInset({visible: true, getTitlebarAreaRect: () => {throw new Error('closed');}}, 1440), 0);
});

test('the top bar reserves room for the traffic lights, drags the window and keeps its controls clickable', () => {
  const bar = css.match(/:root\[data-desktop-frame="mac-inset"\] \.workbench \.topbar \{([^}]*)\}/)?.[1] ?? '';
  assert.match(bar, /-webkit-app-region:\s*drag/);
  assert.match(bar, /padding-left:\s*var\(--mac-titlebar-leading\)/);
  const controls = css.match(/:root\[data-desktop-frame="mac-inset"\] \.topbar :is\(([^)]*\)?[^)]*)\) \{([^}]*)\}/);
  assert.match(controls?.[2] ?? '', /-webkit-app-region:\s*no-drag/);
  for (const selector of ['a', 'button', 'input', '\\[role="tablist"\\]']) assert.match(controls![1], new RegExp(`(^|, )${selector}(,|$)`));
  // Dialogs and menus can open over the drag region and must keep their pointer events.
  assert.match(css, /:root\[data-desktop-frame="mac-inset"\] :is\(\[data-slot\$="-overlay"\], \[data-slot\$="-content"\]\) \{ -webkit-app-region: no-drag; \}/);
});

test('the top bar reserves the reported Windows control band, drags the window and keeps its controls clickable', () => {
  const bar = css.match(/:root\[data-desktop-frame="win-overlay"\] \.workbench \.topbar \{([^}]*)\}/)?.[1] ?? '';
  assert.match(bar, /-webkit-app-region:\s*drag/);
  assert.match(bar, /padding-right:\s*var\(--win-titlebar-trailing\)/);
  assert.doesNotMatch(bar, /padding-left/, 'Windows has no traffic lights');
  const controls = css.match(/:root\[data-desktop-frame="win-overlay"\] \.topbar :is\(([^)]*\)?[^)]*)\) \{([^}]*)\}/);
  assert.match(controls?.[2] ?? '', /-webkit-app-region:\s*no-drag/);
  for (const selector of ['a', 'button', 'input', '\\[role="tablist"\\]']) assert.match(controls![1], new RegExp(`(^|, )${selector}(,|$)`));
  assert.match(css, /:root\[data-desktop-frame="win-overlay"\] :is\(\[data-slot\$="-overlay"\], \[data-slot\$="-content"\]\) \{ -webkit-app-region: no-drag; \}/);
  assert.match(css, /:root\[data-desktop-frame="win-overlay"\] \.shell-redesign \.workbench-topbar \{[^}]*column-gap: var\(--win-titlebar-gap\)/);
  const launcher = readFileSync(new URL('../apps/web/src/launcher-home.css', import.meta.url), 'utf8');
  assert.match(launcher, /:root\[data-desktop-frame="win-overlay"\] \.launcher-home-titlebar \{ height: var\(--wb-topbar\); -webkit-app-region: drag; \}/);
  assert.match(launcher, /:root\[data-desktop-frame="win-overlay"\] \.project-home-screen > \.project-home\.launcher-home > \.project-home-layout::before \{[^}]*-webkit-app-region: drag/);
  const settings = readFileSync(new URL('../apps/web/src/settings-center.css', import.meta.url), 'utf8');
  assert.match(settings, /:root\[data-desktop-frame="win-overlay"\] \.project-home\.project-home-settings-window > \.project-home-header \{[^}]*padding-right: var\(--win-titlebar-trailing\)[^}]*-webkit-app-region: drag/);
});

test('launcher geometry survives a cancelled close, a native destroy, and a cold restart', t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-launcher-bounds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workAreas = () => [{ x: 0, y: 24, width: 1920, height: 1056 }];
  const state = createLauncherWindowState(root, workAreas);
  assert.deepEqual(state.options(), { width: 1000, height: 680, minWidth: 820, minHeight: 560, center: true });

  let normal: WindowBounds = { x: 460, y: 212, width: 1000, height: 680 };
  let destroyed = false;
  let readsAfterDestroy = 0;
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    getNormalBounds: () => {
      if (destroyed) readsAfterDestroy++;
      return normal;
    },
  });
  state.track(window);
  normal = { x: 190, y: 88, width: 920, height: 600 };
  window.emit('move');
  window.emit('resize');
  window.emit('close'); // The owner declines this close and keeps the window.
  assert.deepEqual(state.options(), { ...normal, minWidth: 820, minHeight: 560 });

  normal = { x: 75, y: 60, width: 870, height: 580 };
  window.emit('move');
  destroyed = true;
  window.emit('closed');
  assert.equal(readsAfterDestroy, 0, 'the closed handler must use the last normal rectangle');
  assert.deepEqual(window.eventNames(), []);
  const expected = { ...normal, minWidth: 820, minHeight: 560 };
  assert.deepEqual(state.options(), expected);
  assert.deepEqual(createLauncherWindowState(root, workAreas).options(), expected);
});

test('launcher geometry falls back to center when a display is gone and fits a saved rectangle to current work areas', t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-launcher-bounds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'launcher-window-bounds.json');
  const saved = { x: -1750, y: 30, width: 1540, height: 900 };
  writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  const primary = { x: 0, y: 24, width: 1920, height: 1056 };
  const secondary = { x: -1440, y: 50, width: 1440, height: 830 };
  let displays = [primary, secondary];
  const state = createLauncherWindowState(root, () => displays);
  assert.deepEqual(state.options(), { ...secondary, minWidth: 820, minHeight: 560 });
  displays = [primary];
  const defaultOptions = { width: 1000, height: 680, minWidth: 820, minHeight: 560, center: true };
  assert.deepEqual(state.options(), defaultOptions);
  writeFileSync(file, JSON.stringify({ x: 20, y: 30, width: -1, height: 600 }));
  assert.deepEqual(state.options(), defaultOptions);
  writeFileSync(file, '{');
  assert.deepEqual(state.options(), defaultOptions);
});
