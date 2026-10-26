/** Fixed presentation commands only. Media, paths, text, RPC operations and
 * execution permissions never cross the native menu bridge. */
export const MENU_COMMAND_CHANNEL = 'mioon:menu-command:v1';
export const MENU_COMMAND_EVENT = 'mioon:menu-command-intent:v1';
export const MENU_COMMAND_IDS = Object.freeze([
  'import-media', 'export', 'workspace-canvas', 'workspace-editing',
  'toggle-assets', 'toggle-inspector', 'toggle-timeline', 'show-tasks', 'show-help',
  'edit-undo', 'edit-redo', 'clip-split', 'clip-remove', 'clip-ripple-remove', 'playback-toggle',
] as const);
export type MenuCommandId = typeof MENU_COMMAND_IDS[number];
/** Shared menu/shortcut-help labels. Space and deletion remain local editor
 * keys so a native accelerator cannot steal input from a text control. */
export const MENU_COMMAND_ACCELERATORS = Object.freeze({
  'edit-undo': 'CmdOrCtrl+Z', 'edit-redo': 'CmdOrCtrl+Shift+Z', 'clip-split': 'CmdOrCtrl+B',
  'import-media': 'CmdOrCtrl+I', export: 'CmdOrCtrl+Shift+E',
} as const satisfies Partial<Record<MenuCommandId, string>>);
export const MENU_COMMAND_LOCAL_SHORTCUTS = Object.freeze({
  'clip-remove': 'Backspace', 'clip-ripple-remove': 'Shift+Backspace', 'playback-toggle': 'Space',
} as const satisfies Partial<Record<MenuCommandId, string>>);
export const MENU_COMMAND_WINDOWS_REDO_SHORTCUT = 'Ctrl+Y';
export interface MenuDocumentIdentity {
  readonly version: 1;
  readonly windowId: string;
  readonly backendId: string;
  readonly contextId: string;
  readonly role: 'launcher' | 'editor' | 'settings';
}
/** Availability is a display hint. Both host ownership and the renderer's
 * existing action guards are checked again when a command is selected. */
export interface MenuCommandState {
  readonly version: 1;
  readonly reportVersion: number;
  readonly editingContext: 'text' | 'timeline' | 'none';
  readonly workspaceMode: 'canvas' | 'editing' | null;
  readonly assetsVisible: boolean;
  readonly inspectorVisible: boolean;
  readonly timelineVisible: boolean;
  readonly commands: Readonly<Record<MenuCommandId, boolean>>;
}
export interface MenuCommandIntent extends MenuDocumentIdentity {
  readonly command: MenuCommandId;
  readonly sequence: number;
  /** Binds a delayed intent to the renderer's exact presentation report. */
  readonly reportVersion: number;
}
export type MenuCommandRequest =
  | {readonly action: 'describe'}
  | {readonly action: 'publish'; readonly contextId: string; readonly state: MenuCommandState};
export interface MenuCommandBridge {
  context(): Promise<MenuDocumentIdentity>;
  publish(state: MenuCommandState): Promise<boolean>;
  /** A document has one active command consumer; a new subscription replaces
   * the previous one instead of executing one menu intent twice. */
  subscribe(listener: (intent: MenuCommandIntent) => void): () => void;
}
/** Main uses this fixed entry only inside an explicitly user-activated script.
 * Ordinary web command clients do not need to expose or call it. */
export interface MenuCommandGestureBridge extends MenuCommandBridge {
  receiveUserGesture(intent: unknown): boolean;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export const isMenuCommandId = (value: unknown): value is MenuCommandId =>
  typeof value === 'string' && MENU_COMMAND_IDS.some(command => command === value);
const identityFields = ['version', 'windowId', 'backendId', 'contextId', 'role'] as const;
function identityValues(value: Record<string, unknown>): boolean {
  return value.version === 1 && id(value.windowId) && id(value.backendId) && id(value.contextId) &&
    (value.role === 'launcher' || value.role === 'editor' || value.role === 'settings');
}
export const isMenuDocumentIdentity = (value: unknown): value is MenuDocumentIdentity =>
  record(value) && keysAre(value, identityFields) && identityValues(value);
export const sameMenuDocument = (left: MenuDocumentIdentity, right: MenuDocumentIdentity): boolean =>
  left.windowId === right.windowId && left.backendId === right.backendId && left.contextId === right.contextId && left.role === right.role;
export function isMenuCommandState(value: unknown): value is MenuCommandState {
  if (!record(value)) return false;
  const commands = value.commands;
  return keysAre(value, ['version', 'reportVersion', 'editingContext', 'workspaceMode', 'assetsVisible', 'inspectorVisible', 'timelineVisible', 'commands']) &&
    value.version === 1 && positive(value.reportVersion) &&
    (value.editingContext === 'text' || value.editingContext === 'timeline' || value.editingContext === 'none') &&
    (value.workspaceMode === null || value.workspaceMode === 'canvas' || value.workspaceMode === 'editing') &&
    typeof value.assetsVisible === 'boolean' && typeof value.inspectorVisible === 'boolean' && typeof value.timelineVisible === 'boolean' &&
    record(commands) && keysAre(commands, MENU_COMMAND_IDS) && MENU_COMMAND_IDS.every(command => typeof commands[command] === 'boolean');
}
export const isMenuCommandIntent = (value: unknown): value is MenuCommandIntent =>
  record(value) && keysAre(value, [...identityFields, 'command', 'sequence', 'reportVersion']) && identityValues(value) &&
    isMenuCommandId(value.command) && positive(value.sequence) && positive(value.reportVersion);
export function isMenuCommandRequest(value: unknown): value is MenuCommandRequest {
  if (!record(value)) return false;
  if (value.action === 'describe') return keysAre(value, ['action']);
  return value.action === 'publish' && keysAre(value, ['action', 'contextId', 'state']) && id(value.contextId) && isMenuCommandState(value.state);
}
export const freezeMenuCommandState = (value: MenuCommandState): MenuCommandState =>
  Object.freeze({...value, commands: Object.freeze({...value.commands})});
