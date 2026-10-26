import test from 'node:test';
import assert from 'node:assert/strict';
import type {MenuItemConstructorOptions} from 'electron';
import {applicationMenuTemplate} from '../apps/desktop/src/application-menu.ts';
import type {ApplicationMenuAction, ApplicationMenuState} from '../apps/desktop/src/application-menu.ts';
import {MENU_COMMAND_IDS, MENU_COMMAND_ACCELERATORS} from '../apps/desktop/src/menu-command-protocol.ts';
import type {MenuCommandId, MenuCommandState} from '../apps/desktop/src/menu-command-protocol.ts';
import {setNativeLanguageReader} from '../apps/desktop/src/app-language-text.ts';

function find(items: readonly MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions {
  for (const item of items) {
    if (item.id === id) return item;
    if (Array.isArray(item.submenu)) { const nested = lookup(item.submenu, id); if (nested) return nested; }
  }
  assert.fail(`Missing menu item ${id}`);
}
function lookup(items: readonly MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    if (Array.isArray(item.submenu)) { const nested = lookup(item.submenu, id); if (nested) return nested; }
  }
}
function click(item: MenuItemConstructorOptions) { assert.equal(typeof item.click, 'function'); Reflect.apply(item.click!, undefined, []); }
function fixture(platform: NodeJS.Platform = 'darwin') {
  const calls: (ApplicationMenuAction | MenuCommandId | string)[] = [];
  const business: MenuCommandState = {version: 1, reportVersion: 1, editingContext: 'timeline', workspaceMode: 'editing',
    assetsVisible: true, inspectorVisible: false, timelineVisible: true,
    commands: Object.fromEntries(MENU_COMMAND_IDS.map(command => [command, true])) as Record<MenuCommandId, boolean>};
  let state: ApplicationMenuState = {canProject: true, canSettings: true, canShow: true, canFocusProjects: true, canHide: true, canClose: true,
    canResize: true, canReload: true, canRestart: true, canEditText: true, canCommand: true, business,
    windows: [{id: 'synthetic-A', label: 'Scene A'}, {id: 'synthetic-B', label: 'Scene B'}]};
  const options = {platform, productName: 'Mioon Dev', state: () => state,
    action: (action: ApplicationMenuAction) => {calls.push(action);}, command: (command: MenuCommandId) => {calls.push(command);},
    focusWindow: (id: string) => {calls.push(id);}};
  return {calls, build: () => applicationMenuTemplate(options), get state() {return state;}, patch(patch: Partial<ApplicationMenuState>) {state = {...state, ...patch};}};
}

test('macOS menu separates application, project, view, editing and recovery commands', () => {
  const f = fixture(), menu = f.build();
  assert.deepEqual(menu.map(item => item.id), ['menu-app', 'menu-file', 'menu-edit', 'menu-view', 'menu-clip', 'menu-window', 'menu-help']);
  const app = find(menu, 'menu-app').submenu, file = find(menu, 'menu-file').submenu;
  assert.ok(Array.isArray(app) && Array.isArray(file));
  assert.equal(find(app, 'app-settings').accelerator, 'CmdOrCtrl+,');
  assert.equal(find(app, 'app-quit').accelerator, 'CmdOrCtrl+Q');
  assert.equal(find(file, 'app-new-project').accelerator, 'CmdOrCtrl+N');
  assert.equal(find(file, 'app-close-window').accelerator, 'CmdOrCtrl+W');
  assert.equal(lookup(file, 'app-quit'), undefined, 'Quit belongs to the macOS app menu');
  assert.equal(lookup(file, 'app-reload'), undefined, 'Recovery is not a project editing action');
  assert.ok(find(find(menu, 'menu-help').submenu as MenuItemConstructorOptions[], 'app-reload'));
  click(find(menu, 'app-close-window')); click(find(menu, 'app-quit'));
  assert.deepEqual(f.calls, ['close-window', 'quit']);
});

test('Windows keeps settings and Quit available through File without taking over Alt+F4 window close', () => {
  const f = fixture('win32'), menu = f.build();
  assert.equal(menu[0].id, 'menu-file'); assert.equal(lookup(menu, 'menu-app'), undefined);
  const file = find(menu, 'menu-file').submenu as MenuItemConstructorOptions[];
  assert.equal(find(file, 'app-settings').accelerator, 'CmdOrCtrl+,');
  assert.notEqual(find(file, 'app-quit').accelerator, 'Alt+F4');
  assert.equal(find(menu, 'app-full-screen').accelerator, 'F11');
});

test('native accelerators and shortcut help use one definition while Space and Backspace remain local', () => {
  const menu = fixture().build();
  for (const [command, accelerator] of Object.entries(MENU_COMMAND_ACCELERATORS)) assert.equal(find(menu, `command-${command}`).accelerator, accelerator);
  for (const command of ['playback-toggle', 'clip-remove', 'clip-ripple-remove']) assert.equal(find(menu, `command-${command}`).accelerator, undefined);
  assert.equal(find(menu, 'command-edit-undo').role, undefined, 'a native role plus click would ignore the guarded command callback');
  const edit = find(menu, 'menu-edit').submenu as MenuItemConstructorOptions[];
  assert.ok(edit.some(item => item.role === 'copy')); assert.ok(edit.some(item => item.role === 'paste'));
});

test('callbacks retained before a modal or shutdown recheck current guards, including native recovery', () => {
  const f = fixture(), old = f.build();
  f.patch({canProject: false, canSettings: false, canShow: false, canFocusProjects: false, canHide: false, canClose: false, canResize: false,
    canReload: false, canRestart: false, canEditText: false, canCommand: false});
  for (const id of ['app-new-project', 'app-open-project', 'app-settings', 'app-close-window', 'app-full-screen', 'app-reload', 'app-restart',
    'command-export', 'command-clip-remove', 'command-edit-undo', 'project-window-synthetic-A']) click(find(old, id));
  assert.deepEqual(f.calls, []);
  const fresh = f.build(); assert.equal(find(fresh, 'command-export').enabled, false);
  assert.equal(find(fresh, 'app-settings').enabled, false); click(find(old, 'app-quit')); assert.deepEqual(f.calls, ['quit']);
});

test('text focus permits native Undo without granting a disabled timeline operation', () => {
  const f = fixture(); assert.ok(f.state.business);
  f.patch({business: {...f.state.business, editingContext: 'text', commands: {...f.state.business.commands, 'edit-undo': false, 'edit-redo': false, 'clip-split': false}}});
  const menu = f.build(); assert.equal(find(menu, 'command-edit-undo').enabled, true);
  assert.equal(find(menu, 'command-clip-split').enabled, false);
  click(find(menu, 'command-edit-undo')); assert.deepEqual(f.calls, ['edit-undo']);
  f.patch({canEditText: false}); click(find(menu, 'command-edit-undo')); assert.deepEqual(f.calls, ['edit-undo']);
});

test('canvas storyboard Undo uses the fixed command without granting Redo or stale callbacks', () => {
  const f = fixture();
  f.patch({canEditText: false, business: {...f.state.business!, editingContext: 'none', workspaceMode: 'canvas',
    commands: {...f.state.business!.commands, 'edit-undo': true, 'edit-redo': false}}});
  const menu = f.build();
  assert.equal(find(menu, 'command-edit-undo').enabled, true);
  assert.equal(find(menu, 'command-edit-redo').enabled, false);
  click(find(menu, 'command-edit-undo')); assert.deepEqual(f.calls, ['edit-undo']);
  f.patch({business: {...f.state.business!, commands: {...f.state.business!.commands, 'edit-undo': false}}});
  click(find(menu, 'command-edit-undo')); assert.deepEqual(f.calls, ['edit-undo']);
});

test('showing a pending native dialog cannot also focus a different project through the window list', () => {
  const f = fixture(), old = f.build(); f.patch({canShow: true, canFocusProjects: false});
  click(find(old, 'project-window-synthetic-B')); assert.deepEqual(f.calls, []);
  const menu = f.build(); assert.equal(find(menu, 'app-show').enabled, true);
  assert.equal(find(menu, 'project-window-synthetic-B').enabled, false);
  click(find(menu, 'app-show')); assert.deepEqual(f.calls, ['show']);
});

test('window callbacks never revive a removed project and view checks follow current renderer state', () => {
  const f = fixture(), old = f.build();
  click(find(old, 'project-window-synthetic-B')); assert.deepEqual(f.calls, ['synthetic-B']);
  f.patch({windows: [{id: 'synthetic-A', label: 'Renamed scene'}], business: {...f.state.business!, workspaceMode: 'canvas', assetsVisible: false}});
  click(find(old, 'project-window-synthetic-B')); assert.deepEqual(f.calls, ['synthetic-B']);
  const fresh = f.build(); assert.equal(find(fresh, 'project-window-synthetic-A').label, 'Renamed scene');
  assert.equal(find(fresh, 'command-workspace-canvas').checked, true); assert.equal(find(fresh, 'command-workspace-editing').checked, false);
  assert.equal(find(fresh, 'command-toggle-assets').checked, false);
});

test('all four menu locales retain platform groups and the explicit development channel', () => {
  try {
    for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
      setNativeLanguageReader(() => locale); const menu = fixture().build();
      assert.equal(menu[0].label, 'Mioon Dev'); assert.ok(find(menu, 'app-quit').label?.includes('Mioon Dev'));
      for (const id of ['menu-file', 'menu-view', 'menu-clip', 'menu-help', 'command-import-media', 'command-export']) assert.ok(find(menu, id).label);
    }
  } finally {setNativeLanguageReader(() => 'zh-Hans');}
});
