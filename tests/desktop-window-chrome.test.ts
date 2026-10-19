import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { windowChromeOptions, MAC_TRAFFIC_LIGHT_POSITION } from '../apps/desktop/src/window-chrome.ts';
import { desktopFrame } from '../apps/web/src/desktop-frame.ts';

const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
const macShell = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Mioon/0.4.1 Chrome/152.0.0.0 Electron/44.7.0 Safari/537.36';

test('macOS hides the native title bar and insets the traffic lights; other platforms keep their native frame', () => {
  const options = windowChromeOptions('darwin');
  assert.equal(options.titleBarStyle, 'hidden');
  assert.deepEqual(options.trafficLightPosition, MAC_TRAFFIC_LIGHT_POSITION);
  assert.notEqual(options.trafficLightPosition, MAC_TRAFFIC_LIGHT_POSITION, 'the frozen default must not be handed to Electron');
  for (const platform of ['win32', 'linux', 'freebsd'] as const) assert.deepEqual(windowChromeOptions(platform as Parameters<typeof windowChromeOptions>[0]), {});
});

test('the renderer insets its top bar only inside the macOS desktop shell', () => {
  assert.equal(desktopFrame(macShell), 'mac-inset');
  assert.equal(desktopFrame(macShell.replace('Macintosh; Intel Mac OS X 10_15_7', 'Windows NT 10.0; Win64; x64')), null);
  assert.equal(desktopFrame(macShell.replace('Macintosh; Intel Mac OS X 10_15_7', 'X11; Linux x86_64')), null);
  assert.equal(desktopFrame('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), null);
  assert.equal(desktopFrame(''), null);
  assert.equal(desktopFrame(), null);
});

test('the top bar reserves room for the traffic lights, drags the window and keeps its controls clickable', () => {
  const bar = css.match(/:root\[data-desktop-frame="mac-inset"\] \.workbench \.topbar \{([^}]*)\}/)?.[1] ?? '';
  assert.match(bar, /-webkit-app-region:\s*drag/);
  // Three 12px lights with 8px gaps start at the configured x; the brand must begin after them.
  const inset = Number(bar.match(/padding-left:\s*(\d+)px/)?.[1]);
  assert.ok(inset >= MAC_TRAFFIC_LIGHT_POSITION.x + 3 * 12 + 2 * 8, `top bar inset ${inset}px overlaps the traffic lights`);
  const controls = css.match(/:root\[data-desktop-frame="mac-inset"\] \.topbar :is\(([^)]*\)?[^)]*)\) \{([^}]*)\}/);
  assert.match(controls?.[2] ?? '', /-webkit-app-region:\s*no-drag/);
  for (const selector of ['a', 'button', 'input', '\\[role="tablist"\\]']) assert.match(controls![1], new RegExp(`(^|, )${selector}(,|$)`));
  // Dialogs and menus can open over the drag region and must keep their pointer events.
  assert.match(css, /:root\[data-desktop-frame="mac-inset"\] :is\(\[data-slot\$="-overlay"\], \[data-slot\$="-content"\]\) \{ -webkit-app-region: no-drag; \}/);
});
