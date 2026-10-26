import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopTray } from '../apps/desktop/src/tray-host.ts';
import type { TrayAction, TrayMenuItem } from '../apps/desktop/src/tray-host.ts';
import { nativeText, setNativeLanguageReader } from '../apps/desktop/src/app-language-text.ts';
import { desktopTrayHarness } from './helpers/desktop-tray-harness.ts';

function fixture(platform: NodeJS.Platform = 'darwin') {
  const native = desktopTrayHarness(), actions: TrayAction[] = [];
  let interactive = true, hide = true, unavailable = 0, badMenu = false, language = 'en';
  const labels = () => ({show: `${language} show`, hide: `${language} hide`, newProject: 'new', openProject: 'open', settings: 'settings', quit: 'quit'});
  const host = createDesktopTray({platform, productName: 'Mioon Dev', iconDirectory: '/synthetic/icons/tray',
    loadImage: native.nativeImage.createFromPath, createTray: image => new native.Tray(image),
    createMenu: items => { if (badMenu) throw new Error('synthetic'); return items; }, labels,
    canInteract: () => interactive, canHide: () => hide, onAction: action => { actions.push(action); }, onUnavailable: () => { unavailable++; }});
  return {host, native, actions, setInteractive: (value: boolean) => { interactive = value; }, setHide: (value: boolean) => {hide = value;},
    setLanguage: (value: string) => {language = value;}, failMenu: () => {badMenu = true;}, get unavailable() { return unavailable; }};
}

for (const [platform, filename] of [['darwin', 'trayTemplate.png'], ['win32', 'tray.ico'], ['linux', 'tray-color.png']] as const) {
  test(`${platform} uses its bundled artwork and native click/menu behavior`, () => {
    const f = fixture(platform), tray = f.native.trays[0];
    assert.deepEqual(f.native.paths, [`/synthetic/icons/tray/${filename}`]);
    assert.equal(f.native.images[0].template, platform === 'darwin');
    assert.equal(tray.tooltip, 'Mioon Dev'); assert.equal(f.host.available, true);
    tray.emit('click'); assert.deepEqual(f.actions, platform === 'darwin' ? [] : ['show']);
    assert.equal(tray.menu.filter(item => item.type === 'separator').length, 2);
    assert.equal(tray.menu.filter(item => item.click).length, 6);
    f.host.dispose(); assert.equal(f.host.available, false); assert.equal(tray.destroys, 1);
  });
}

test('stale menu callbacks recheck current guards while Quit remains available', () => {
  const f = fixture('win32'), tray = f.native.trays[0], old = tray.menu;
  f.setInteractive(false); f.host.refresh();
  assert.ok(tray.menu.filter(item => item.click && item.label !== 'quit').every(item => item.enabled === false));
  for (const item of old) if (item.label !== 'quit') item.click?.();
  assert.deepEqual(f.actions, []); old.at(-1)!.click!(); assert.deepEqual(f.actions, ['quit']);
  f.setInteractive(true); f.setHide(false); f.host.refresh(); old[1].click!();
  assert.deepEqual(f.actions, ['quit']); old[0].click!(); assert.deepEqual(f.actions, ['quit', 'show']);
  f.host.dispose(); old.at(-1)!.click!(); tray.emit('click'); assert.deepEqual(f.actions, ['quit', 'show']);
});

test('refresh uses current localized labels without constructing another native tray', () => {
  const f = fixture(); f.setLanguage('ja'); f.host.refresh();
  assert.equal(f.native.trays.length, 1); assert.equal(f.native.trays[0].menu[0].label, 'ja show');
  f.host.dispose(); f.host.dispose(); assert.equal(f.native.trays[0].destroys, 1); assert.equal(f.unavailable, 0);
});

test('a lost tray or failed native menu restores a retained UI once and cannot hide it again', () => {
  for (const failure of ['destroyed', 'menu'] as const) {
    const f = fixture(), tray = f.native.trays[0], hide = tray.menu[1].click!;
    if (failure === 'destroyed') tray.destroy(); else f.failMenu();
    f.host.refresh(); f.host.refresh(); hide();
    assert.equal(f.host.available, false); assert.equal(f.unavailable, 1); assert.deepEqual(f.actions, []);
  }
});

test('missing artwork and creation errors preserve startup without retry or environment discovery', () => {
  for (const failure of ['image', 'tray'] as const) {
    let loads = 0, constructs = 0, unavailable = 0;
    const host = createDesktopTray({platform: 'win32', productName: 'Mioon', iconDirectory: '/synthetic/icons/tray',
      loadImage: file => { loads++; assert.equal(file, '/synthetic/icons/tray/tray.ico'); return {isEmpty: () => failure === 'image', setTemplateImage() { assert.fail(); }}; },
      createTray: () => { constructs++; throw new Error('synthetic'); }, createMenu: (items: TrayMenuItem[]) => items,
      labels: () => ({show: '', hide: '', newProject: '', openProject: '', settings: '', quit: ''}), canInteract: () => true, canHide: () => true,
      onAction() { assert.fail(); }, onUnavailable: () => {unavailable++;} });
    host.refresh(); assert.equal(host.available, false); assert.equal(loads, 1); assert.equal(constructs, failure === 'image' ? 0 : 1); assert.equal(unavailable, 1);
  }
});

test('a rejected action is never retried by the tray', async () => {
  const native = desktopTrayHarness(); let requests = 0;
  const host = createDesktopTray({platform: 'win32', productName: 'Mioon', iconDirectory: '/synthetic/icons/tray',
    loadImage: native.nativeImage.createFromPath, createTray: image => new native.Tray(image), createMenu: items => items,
    labels: () => ({show: 'show', hide: 'hide', newProject: 'new', openProject: 'open', settings: 'settings', quit: 'quit'}),
    canInteract: () => true, canHide: () => true, onAction: async () => {requests++; throw new Error('synthetic');} });
  native.trays[0].menu[4].click!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1); assert.equal(host.available, true); host.dispose();
});

test('tray labels cover all four locales and keep channel names explicit', () => {
  try {
    for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
      setNativeLanguageReader(() => locale);
      assert.ok(nativeText('native.trayShow', {name: 'Mioon Dev'}).includes('Mioon Dev'));
      assert.ok(nativeText('native.trayQuit', {name: 'Mioon Dev'}).includes('Mioon Dev'));
      assert.ok(nativeText('native.trayHide')); assert.ok(nativeText('native.traySettings'));
    }
  } finally { setNativeLanguageReader(() => 'zh-Hans'); }
});
