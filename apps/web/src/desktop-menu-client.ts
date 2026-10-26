import {MENU_COMMAND_IDS, isMenuCommandIntent, isMenuCommandState, isMenuDocumentIdentity, sameMenuDocument} from '../../desktop/src/menu-command-protocol.ts';
import type {MenuCommandBridge, MenuCommandId, MenuCommandIntent, MenuCommandState, MenuDocumentIdentity} from '../../desktop/src/menu-command-protocol.ts';

export type {MenuCommandId, MenuCommandState} from '../../desktop/src/menu-command-protocol.ts';
export type MenuCommandView = Omit<MenuCommandState, 'reportVersion'>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => new Error('Native menu commands are unavailable.');
// Component replay/remount does not create a new native document. Keep its
// presentation-report order in bounded memory so a new consumer cannot get
// stuck behind the previous component's accepted report version.
const reportVersions = new Map<string, number>();

/** Web has no native bridge. A malformed desktop bridge stays unavailable; it
 * never grants access to Electron APIs or substitutes a business transport. */
export function readDesktopMenuBridge(host: unknown = globalThis): MenuCommandBridge | null {
  if (!record(host) || !Object.hasOwn(host, '__mioonMenuCommands')) return null;
  const source = host.__mioonMenuCommands;
  if (!record(source) || typeof source.context !== 'function' || typeof source.publish !== 'function' || typeof source.subscribe !== 'function') throw unavailable();
  const {context, publish, subscribe} = source;
  return Object.freeze({
    async context() { const value: unknown = await context(); if (!isMenuDocumentIdentity(value)) throw unavailable(); return Object.freeze({...value}); },
    async publish(state: MenuCommandState) { if (!isMenuCommandState(state)) throw unavailable(); const result: unknown = await publish(state); if (typeof result !== 'boolean') throw unavailable(); return result; },
    subscribe(listener: (intent: MenuCommandIntent) => void) {
      const release: unknown = subscribe((value: unknown) => { if (isMenuCommandIntent(value)) listener(Object.freeze({...value})); });
      if (typeof release !== 'function') throw unavailable();
      return () => { release(); };
    },
  });
}

export function emptyMenuCommands(): Record<MenuCommandId, boolean> {
  return Object.fromEntries(MENU_COMMAND_IDS.map(command => [command, false])) as Record<MenuCommandId, boolean>;
}

/** State reports are hints for the native menu. Every received intent consumes
 * its sequence before reading live guards, so a denied/replayed event cannot
 * become valid later after a dialog, project switch or IME composition ends. */
export function createDesktopMenuController(options: {
  bridge: MenuCommandBridge; identity: MenuDocumentIdentity;
  read(): MenuCommandView; current(): boolean; scope?(command: MenuCommandId): string; execute(command: MenuCommandId): unknown;
}) {
  interface Snapshot {
    readonly view: MenuCommandView;
    readonly scopes: Readonly<Record<MenuCommandId, string>>;
    readonly epochs: Readonly<Record<MenuCommandId, number>>;
  }
  const reportOwner = JSON.stringify([options.identity.backendId, options.identity.windowId, options.identity.contextId, options.identity.role]);
  const snapshots = new Map<number, Snapshot>();
  const owners = new Map<MenuCommandId, {scope: string; enabled: boolean; epoch: number}>();
  let active = true, ready = false, reportVersion = reportVersions.get(reportOwner) ?? 0, sequence = 0, signature = '', release: (() => void) | undefined;
  function capture(): Snapshot {
    const value = options.read(), view = Object.freeze({...value, commands: Object.freeze({...value.commands})});
    const scopes = {} as Record<MenuCommandId, string>, epochs = {} as Record<MenuCommandId, number>;
    for (const command of MENU_COMMAND_IDS) {
      const scope = options.scope?.(command) ?? '', enabled = view.commands[command] === true, previous = owners.get(command);
      // A disabled interval or different target permanently revokes the old
      // command's consent, including target A -> B -> A and modal open/close.
      const epoch = (previous?.epoch ?? 0) + (previous && (previous.scope !== scope || previous.enabled && !enabled) ? 1 : 0);
      owners.set(command, {scope, enabled, epoch}); scopes[command] = scope; epochs[command] = epoch;
    }
    return Object.freeze({view, scopes: Object.freeze(scopes), epochs: Object.freeze(epochs)});
  }
  function refresh(): void {
    if (!active || !ready || !options.current() || reportVersion >= Number.MAX_SAFE_INTEGER) return;
    const snapshot = capture(), next = JSON.stringify(snapshot);
    if (signature === next) return;
    reportVersion = Math.max(reportVersion, reportVersions.get(reportOwner) ?? 0) + 1;
    const state = {...snapshot.view, reportVersion};
    if (!isMenuCommandState(state)) return;
    reportVersions.set(reportOwner, reportVersion);
    while (reportVersions.size > 16) reportVersions.delete(reportVersions.keys().next().value!);
    snapshots.set(reportVersion, snapshot);
    while (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value!);
    signature = next;
    void options.bridge.publish(state).catch(() => {});
  }
  function receive(intent: MenuCommandIntent): void {
    if (!active || !ready || !isMenuCommandIntent(intent) || !sameMenuDocument(options.identity, intent) || intent.sequence <= sequence) return;
    sequence = intent.sequence;
    if (!options.current()) return;
    const previous = snapshots.get(intent.reportVersion);
    if (!previous) return;
    const current = capture(), command = intent.command;
    // Versions identify bounded local snapshots, not permission to use the
    // newest selection. Unrelated updates (such as playback progress while
    // pausing) can advance the report without invalidating this command.
    if (previous.view.commands[command] !== true || current.view.commands[command] !== true ||
        previous.scopes[command] !== current.scopes[command] || previous.epochs[command] !== current.epochs[command]) {refresh(); return;}
    try { void Promise.resolve(options.execute(intent.command)).catch(() => {}); }
    catch { /* Existing action owners report failures; a menu never retries. */ }
    finally { refresh(); }
  }
  const start = (async () => {
    let observed: MenuDocumentIdentity;
    try { observed = await options.bridge.context(); } catch { return false; }
    if (!active || !options.current() || !sameMenuDocument(options.identity, observed)) return false;
    try { release = options.bridge.subscribe(receive); } catch { return false; }
    ready = true; refresh(); return true;
  })();
  return Object.freeze({start, refresh, dispose() { if (active) { active = false; ready = false; release?.(); snapshots.clear(); owners.clear(); } }});
}

interface FocusTarget {
  isContentEditable?: boolean;
  closest?(selector: string): unknown;
  shadowRoot?: {activeElement?: FocusTarget | null} | null;
}
/** Check focus rather than selection text: a retained text selection must not
 * make a later timeline command act on an old input owner. */
export function nativeMenuTextFocus(target: FocusTarget | null): boolean {
  let current = target;
  for (let depth = 0; current && depth < 12; depth++) {
    if (current.isContentEditable || current.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="spinbutton"], [role="combobox"]')) return true;
    const next = current.shadowRoot?.activeElement;
    if (!next || next === current) return false;
    current = next;
  }
  return false;
}

export function nativeMenuSpaceShortcut(event: {key: string; defaultPrevented?: boolean; repeat?: boolean; isComposing?: boolean; keyCode?: number; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean}, blocked: boolean): boolean {
  return !blocked && event.key === ' ' && !event.defaultPrevented && !event.repeat && !event.isComposing && event.keyCode !== 229 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function nativeMenuSpaceTarget(target: FocusTarget | null): boolean {
  return nativeMenuTextFocus(target) || Boolean(target?.closest?.('button, a[href], summary, [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="slider"]'));
}

export interface MenuPlaybackControl {available(): boolean; toggle(): unknown; scope?(): string}
export interface MenuRemovalControl {available(mode: 'remove' | 'ripple'): boolean; request(mode: 'remove' | 'ripple'): unknown}
export interface MenuHelpControl {available(): boolean; open(): boolean}
export function launcherMenuView(value: {ready: boolean; visible: boolean; modalOpen: boolean; composing: boolean; textFocus: boolean; canHelp: boolean}): MenuCommandView {
  const commands = emptyMenuCommands();
  commands['show-help'] = value.ready && value.visible && !value.modalOpen && !value.composing && value.canHelp;
  return {version: 1, editingContext: value.textFocus ? 'text' : 'none', workspaceMode: null,
    assetsVisible: false, inspectorVisible: false, timelineVisible: false, commands};
}
export interface WorkbenchMenuAvailability {
  ready: boolean; visible: boolean; modalOpen: boolean; composing: boolean; textFocus: boolean;
  mode: 'canvas' | 'editing'; assetsVisible: boolean; inspectorVisible: boolean; timelineVisible: boolean;
  canImport: boolean; canExport: boolean; canChangeMode: boolean;
  canUndo: boolean; canRedo: boolean; canSplit: boolean; canRemove: boolean; canRippleRemove: boolean; canPlay: boolean;
}
export function workbenchMenuView(value: WorkbenchMenuAvailability): MenuCommandView {
  const commands = emptyMenuCommands(), available = value.ready && value.visible && !value.modalOpen && !value.composing;
  const editing = available && value.mode === 'editing' && !value.textFocus;
  commands['import-media'] = available && value.canImport;
  commands.export = available && value.canExport;
  commands['workspace-canvas'] = commands['workspace-editing'] = available && value.canChangeMode;
  commands['toggle-assets'] = commands['toggle-inspector'] = commands['show-tasks'] = commands['show-help'] = available;
  commands['toggle-timeline'] = available && value.mode === 'editing';
  commands['edit-undo'] = editing && value.canUndo; commands['edit-redo'] = editing && value.canRedo;
  commands['clip-split'] = editing && value.canSplit; commands['clip-remove'] = editing && value.canRemove;
  commands['clip-ripple-remove'] = editing && value.canRippleRemove; commands['playback-toggle'] = editing && value.canPlay;
  return {version: 1, editingContext: value.textFocus ? 'text' : value.ready && value.mode === 'editing' ? 'timeline' : 'none',
    workspaceMode: value.ready ? value.mode : null, assetsVisible: value.assetsVisible, inspectorVisible: value.inspectorVisible,
    timelineVisible: value.timelineVisible, commands};
}
