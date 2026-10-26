import type {MenuItemConstructorOptions} from 'electron';
import {nativeText as nt} from './app-language-text.ts';
import {MENU_COMMAND_ACCELERATORS} from './menu-command-protocol.ts';
import type {MenuCommandId, MenuCommandState} from './menu-command-protocol.ts';

export type ApplicationMenuAction = 'new-project' | 'open-project' | 'settings' | 'shortcuts' | 'show' | 'hide' |
  'close-window' | 'full-screen' | 'reload' | 'restart' | 'quit';
export interface ApplicationMenuState {
  readonly canProject: boolean; readonly canSettings: boolean; readonly canShow: boolean; readonly canHide: boolean;
  readonly canFocusProjects: boolean;
  readonly canClose: boolean; readonly canResize: boolean; readonly canReload: boolean; readonly canRestart: boolean;
  readonly canEditText: boolean; readonly canCommand: boolean;
  readonly business: MenuCommandState | null;
  readonly windows: readonly {readonly id: string; readonly label: string}[];
}
export interface ApplicationMenuOptions {
  readonly platform: NodeJS.Platform; readonly productName: string;
  state(): ApplicationMenuState;
  action(action: ApplicationMenuAction): unknown;
  command(command: MenuCommandId): unknown;
  focusWindow(id: string): unknown;
}
function allowed(action: ApplicationMenuAction, state: ApplicationMenuState): boolean {
  if (action === 'quit') return true;
  if (action === 'new-project' || action === 'open-project') return state.canProject;
  if (action === 'settings' || action === 'shortcuts') return state.canSettings;
  if (action === 'show') return state.canShow;
  if (action === 'hide') return state.canHide;
  if (action === 'close-window') return state.canClose;
  if (action === 'full-screen') return state.canResize;
  return action === 'reload' ? state.canReload : state.canRestart;
}
function commandAllowed(command: MenuCommandId, state: ApplicationMenuState): boolean {
  if (command === 'edit-undo' || command === 'edit-redo') {
    return state.canEditText && (!state.business || state.business.editingContext === 'text') ||
      state.canCommand && state.business?.editingContext === 'timeline' && state.business.commands[command] === true;
  }
  return state.canCommand && state.business?.commands[command] === true;
}

/** A native menu is a view of current command state. Even callbacks retained
 * from an older menu recheck it before invoking a host or renderer action. */
export function applicationMenuTemplate(options: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  const state = options.state(), mac = options.platform === 'darwin';
  const item = (action: ApplicationMenuAction, label: string, accelerator?: string): MenuItemConstructorOptions => ({
    id: `app-${action}`, label, ...(accelerator ? {accelerator} : {}), enabled: allowed(action, state),
    click: () => { if (allowed(action, options.state())) return options.action(action); },
  });
  const accelerators: Readonly<Partial<Record<MenuCommandId, string>>> = MENU_COMMAND_ACCELERATORS;
  const command = (id: MenuCommandId, label: string, accelerator: string | undefined = accelerators[id], checked?: boolean): MenuItemConstructorOptions => ({
    id: `command-${id}`, label, ...(accelerator ? {accelerator} : {}),
    ...(checked === undefined ? {} : {type: 'checkbox', checked}), enabled: commandAllowed(id, state),
    click: () => { if (commandAllowed(id, options.state())) return options.command(id); },
  });
  const separator: MenuItemConstructorOptions = {type: 'separator'};
  const menu: MenuItemConstructorOptions[] = [];
  if (mac) menu.push({id: 'menu-app', label: options.productName, submenu: [
    {role: 'about', label: nt('native.about')}, separator,
    item('settings', nt('native.traySettings'), 'CmdOrCtrl+,'), separator,
    {role: 'services', label: nt('native.services')}, separator,
    {role: 'hide', label: nt('native.hide')}, {role: 'hideOthers', label: nt('native.hideOthers')},
    {role: 'unhide', label: nt('native.showAll')}, separator,
    item('quit', nt('native.trayQuit', {name: options.productName}), 'CmdOrCtrl+Q'),
  ]});
  menu.push({id: 'menu-file', label: nt('native.menuFile'), submenu: [
    item('new-project', `${nt('native.newProject')}…`, 'CmdOrCtrl+N'),
    item('open-project', `${nt('native.openProject')}…`, 'CmdOrCtrl+O'), separator,
    command('import-media', nt('native.menuImport')),
    command('export', nt('native.menuExport')), separator,
    item('close-window', nt('native.closeWindow'), 'CmdOrCtrl+W'),
    ...(!mac ? [separator, item('settings', nt('native.traySettings'), 'CmdOrCtrl+,'), item('quit', nt('native.quit'), 'CmdOrCtrl+Q')] : []),
  ]}, {id: 'menu-edit', label: nt('native.edit'), submenu: [
    command('edit-undo', nt('native.undo')),
    command('edit-redo', nt('native.redo')), separator,
    {role: 'cut', label: nt('native.cut')}, {role: 'copy', label: nt('native.copy')}, {role: 'paste', label: nt('native.paste')},
    ...(mac ? [{role: 'pasteAndMatchStyle' as const, label: nt('native.pasteMatch')}] : []),
    {role: 'delete', label: nt('native.delete')}, {role: 'selectAll', label: nt('native.selectAll')},
  ]}, {id: 'menu-view', label: nt('native.menuView'), submenu: [
    command('workspace-canvas', nt('native.menuCanvas'), undefined, state.business?.workspaceMode === 'canvas'),
    command('workspace-editing', nt('native.menuEditing'), undefined, state.business?.workspaceMode === 'editing'), separator,
    command('toggle-assets', nt('native.menuAssets'), undefined, state.business?.assetsVisible === true),
    command('toggle-inspector', nt('native.menuInspector'), undefined, state.business?.inspectorVisible === true),
    command('toggle-timeline', nt('native.menuTimeline'), undefined, state.business?.timelineVisible === true),
    command('show-tasks', nt('native.menuTasks')), separator,
    item('full-screen', nt('native.menuFullScreen'), mac ? 'Control+Command+F' : 'F11'),
  ]}, {id: 'menu-clip', label: nt('native.menuClip'), submenu: [
    command('clip-split', nt('native.menuSplit')),
    // Space/Backspace remain local renderer shortcuts so a menu accelerator
    // cannot swallow typing or an IME composition in an unrelated text field.
    command('clip-remove', nt('native.menuRemove')),
    command('clip-ripple-remove', nt('native.menuRippleRemove')), separator,
    command('playback-toggle', nt('native.menuPlayback')),
  ]}, {id: 'menu-window', label: nt('native.window'), submenu: [
    item('show', nt('native.menuShow')), item('hide', nt('native.trayHide')), separator,
    {id: 'window-minimize', role: 'minimize', label: nt('native.minimize'), enabled: state.canResize},
    {id: 'window-zoom', role: 'zoom', label: nt('native.zoom'), enabled: state.canResize}, separator,
    {id: 'window-projects', label: nt('native.menuProjectWindows'), submenu: state.windows.length ? state.windows.map(window => ({
      id: `project-window-${window.id}`, label: window.label, enabled: state.canFocusProjects,
      click: () => { const current = options.state(); if (current.canFocusProjects && current.windows.some(value => value.id === window.id)) options.focusWindow(window.id); },
    })) : [{label: nt('native.menuNoWindows'), enabled: false}]},
  ]}, {id: 'menu-help', role: 'help', label: nt('native.menuHelp'), submenu: [
    command('show-help', nt('native.menuGuide')), item('shortcuts', nt('native.menuShortcuts')), separator,
    {label: nt('native.menuTroubleshooting'), submenu: [item('reload', nt('native.reload'), 'CmdOrCtrl+R'), item('restart', nt('native.restartService'))]},
    ...(!mac ? [separator, {role: 'about' as const, label: nt('native.about')}] : []),
  ]});
  return menu;
}
