/** Fixed native lifecycle metadata only. No business commands, paths, URLs,
 * prompts, credentials, media bytes or arbitrary channels cross this bridge. */
export const PROJECT_WINDOW_CHANNEL = 'mioon:project-window:v2';
export const PROJECT_WINDOW_EVENT = 'mioon:project-window-state:v2';
export type ProjectWindowRole = 'launcher' | 'editor' | 'settings';
export type ProjectWindowSettingsSlot = 'agent' | 'official' | 'custom' | 'comfy';
export type ProjectWindowEntryMode = 'open' | 'new';
export type ProjectWindowPhase = 'none' | 'opening' | 'ready' | 'failed' | 'closing';
export interface ProjectWindowOpenResult {
  readonly ok: boolean;
  readonly reason: 'accepted' | 'already-open' | 'busy' | 'unavailable';
  readonly targetWindowId: string | null;
  readonly targetPhase: Exclude<ProjectWindowPhase, 'none'> | null;
}
export interface ProjectWindowEntryReceipt {
  readonly entryToken: string;
  readonly result: ProjectWindowOpenResult;
}
export type ProjectWindowLocatorAction = 'recheck' | 'retry';
export interface ProjectWindowLocatorStatus {
  readonly version: 1;
  readonly statusVersion: number;
  readonly phase: 'idle' | 'loading' | 'saved' | 'pending' | 'error' | 'conflict' | 'unavailable';
  readonly uncertain: boolean;
  readonly identityBlocked: boolean;
  readonly canRetry: boolean;
  readonly canRecheck: boolean;
  readonly reading: boolean;
  readonly rechecked: boolean;
}
export interface ProjectWindowLocatorIntent {
  readonly action: ProjectWindowLocatorAction;
  readonly expectedStatusVersion: number;
  readonly intentVersion: number;
}
export interface ProjectWindowContext {
  readonly version: 2;
  readonly role: ProjectWindowRole;
  readonly windowId: string;
  readonly contextId: string;
  readonly backendId: string;
  readonly initialProjectId: string | null;
  readonly autoOpen: boolean;
  /** Own immutable editor only, never a global or focused project. */
  readonly editorProjectId: string | null;
  readonly editorPhase: ProjectWindowPhase;
  readonly editorCount: number;
  readonly entryMode: ProjectWindowEntryMode | null;
  readonly entryVersion: number;
  readonly entryReceipt: ProjectWindowEntryReceipt | null;
  readonly settingsSlot: ProjectWindowSettingsSlot | null;
  readonly settingsVersion: number;
  /** One launcher-owned locator queue consumes explicit successful selections. */
  readonly selectionProjectId: string | null;
  readonly selectionVersion: number;
  readonly locatorStatus: ProjectWindowLocatorStatus | null;
  readonly locatorIntent: ProjectWindowLocatorIntent | null;
  readonly quitting: boolean;
}
export type ProjectWindowRequest =
  | { readonly action: 'describe' }
  | { readonly action: 'open'; readonly contextId: string; readonly projectId: string; readonly remember: boolean; readonly entryToken: string }
  | { readonly action: 'projects'; readonly contextId: string }
  | { readonly action: 'project-entry'; readonly contextId: string; readonly mode: ProjectWindowEntryMode }
  | { readonly action: 'locator-status'; readonly contextId: string; readonly status: ProjectWindowLocatorStatus }
  | { readonly action: 'locator-action'; readonly contextId: string; readonly locatorAction: ProjectWindowLocatorAction; readonly expectedStatusVersion: number }
  | { readonly action: 'settings'; readonly contextId: string; readonly slot: ProjectWindowSettingsSlot }
  | { readonly action: 'editor-status'; readonly contextId: string; readonly projectId: string; readonly phase: 'ready' | 'failed' };
export interface ProjectWindowBridge {
  context(): Promise<ProjectWindowContext>;
  publishLocatorStatus(status: ProjectWindowLocatorStatus): Promise<boolean>;
  requestLocatorAction(action: ProjectWindowLocatorAction, expectedStatusVersion: number): Promise<boolean>;
  openProject(projectId: string, remember: boolean, entryToken: string): Promise<ProjectWindowOpenResult>;
  requestProjectEntry(mode: ProjectWindowEntryMode): Promise<boolean>;
  showProjects(): Promise<boolean>;
  showSettings(slot: ProjectWindowSettingsSlot): Promise<boolean>;
  editorStatus(projectId: string, phase: 'ready' | 'failed'): Promise<boolean>;
  subscribe(listener: (context: ProjectWindowContext) => void): () => void;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
export const isProjectWindowId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
export const isProjectWindowSettingsSlot = (value: unknown): value is ProjectWindowSettingsSlot =>
  value === 'agent' || value === 'official' || value === 'custom' || value === 'comfy';
export const isProjectWindowEntryMode = (value: unknown): value is ProjectWindowEntryMode => value === 'open' || value === 'new';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keysAre = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const ordinal = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const editorPhase = (value: unknown): value is Exclude<ProjectWindowPhase, 'none'> =>
  value === 'opening' || value === 'ready' || value === 'failed' || value === 'closing';
export function isProjectWindowRequest(value: unknown): value is ProjectWindowRequest {
  if (!record(value)) return false;
  if (value.action === 'describe') return keysAre(value, ['action']);
  if (!isProjectWindowId(value.contextId)) return false;
  if (value.action === 'open') return keysAre(value, ['action', 'contextId', 'projectId', 'remember', 'entryToken']) &&
    isProjectWindowId(value.projectId) && isProjectWindowId(value.entryToken) && typeof value.remember === 'boolean';
  if (value.action === 'locator-status') return keysAre(value, ['action', 'contextId', 'status']) && isProjectWindowLocatorStatus(value.status);
  if (value.action === 'locator-action') return keysAre(value, ['action', 'contextId', 'locatorAction', 'expectedStatusVersion']) &&
    isProjectWindowLocatorAction(value.locatorAction) && ordinal(value.expectedStatusVersion);
  if (value.action === 'projects') return keysAre(value, ['action', 'contextId']);
  if (value.action === 'project-entry') return keysAre(value, ['action', 'contextId', 'mode']) && isProjectWindowEntryMode(value.mode);
  if (value.action === 'settings') return keysAre(value, ['action', 'contextId', 'slot']) && isProjectWindowSettingsSlot(value.slot);
  return value.action === 'editor-status' && keysAre(value, ['action', 'contextId', 'projectId', 'phase']) &&
    isProjectWindowId(value.projectId) && (value.phase === 'ready' || value.phase === 'failed');
}
export function isProjectWindowOpenResult(value: unknown): value is ProjectWindowOpenResult {
  if (!record(value) || !keysAre(value, ['ok', 'reason', 'targetWindowId', 'targetPhase']) || typeof value.ok !== 'boolean' ||
    (typeof value.reason !== 'string' || !['accepted', 'already-open', 'busy', 'unavailable'].includes(value.reason)) ||
    value.ok !== (value.reason === 'accepted' || value.reason === 'already-open')) return false;
  return value.ok ? isProjectWindowId(value.targetWindowId) && editorPhase(value.targetPhase) :
    value.targetWindowId === null && value.targetPhase === null;
}
export const isProjectWindowLocatorAction = (value: unknown): value is ProjectWindowLocatorAction => value === 'recheck' || value === 'retry';
export function isProjectWindowLocatorStatus(value: unknown): value is ProjectWindowLocatorStatus {
  return record(value) && keysAre(value, ['version', 'statusVersion', 'phase', 'uncertain', 'identityBlocked', 'canRetry', 'canRecheck', 'reading', 'rechecked']) &&
    value.version === 1 && ordinal(value.statusVersion) && typeof value.phase === 'string' &&
    ['idle', 'loading', 'saved', 'pending', 'error', 'conflict', 'unavailable'].includes(value.phase) &&
    ['uncertain', 'identityBlocked', 'canRetry', 'canRecheck', 'reading', 'rechecked'].every(key => typeof value[key] === 'boolean');
}
function isProjectWindowLocatorIntent(value: unknown): value is ProjectWindowLocatorIntent {
  return record(value) && keysAre(value, ['action', 'expectedStatusVersion', 'intentVersion']) && isProjectWindowLocatorAction(value.action) &&
    ordinal(value.expectedStatusVersion) && ordinal(value.intentVersion);
}
export function isProjectWindowContext(value: unknown): value is ProjectWindowContext {
  if (!record(value) || !keysAre(value, ['version', 'role', 'windowId', 'contextId', 'backendId', 'initialProjectId', 'autoOpen',
    'editorProjectId', 'editorPhase', 'editorCount', 'entryMode', 'entryVersion', 'entryReceipt', 'settingsSlot', 'settingsVersion',
    'selectionProjectId', 'selectionVersion', 'locatorStatus', 'locatorIntent', 'quitting']) || value.version !== 2 ||
    (typeof value.role !== 'string' || !['launcher', 'editor', 'settings'].includes(value.role)) || !isProjectWindowId(value.windowId) ||
    !isProjectWindowId(value.contextId) || !isProjectWindowId(value.backendId) || typeof value.autoOpen !== 'boolean' ||
    typeof value.quitting !== 'boolean' || !ordinal(value.editorCount) || !ordinal(value.entryVersion) ||
    !ordinal(value.settingsVersion) || !ordinal(value.selectionVersion)) return false;
  if (value.role === 'editor' ? !isProjectWindowId(value.initialProjectId) || value.editorProjectId !== value.initialProjectId || !editorPhase(value.editorPhase) :
    value.initialProjectId !== null || value.editorProjectId !== null || value.editorPhase !== 'none') return false;
  if (value.entryMode !== null && !isProjectWindowEntryMode(value.entryMode)) return false;
  if (value.settingsSlot !== null && !isProjectWindowSettingsSlot(value.settingsSlot)) return false;
  if (value.role !== 'settings' && (value.settingsSlot !== null || value.settingsVersion !== 0)) return false;
  if (value.role === 'settings' && (value.entryMode !== null || value.entryVersion !== 0 || value.entryReceipt !== null)) return false;
  if (value.selectionProjectId !== null && !isProjectWindowId(value.selectionProjectId)) return false;
  if (value.role !== 'launcher' && (value.selectionProjectId !== null || value.selectionVersion !== 0)) return false;
  if (value.entryReceipt !== null && (!record(value.entryReceipt) || !keysAre(value.entryReceipt, ['entryToken', 'result']) ||
    !isProjectWindowId(value.entryReceipt.entryToken) || !isProjectWindowOpenResult(value.entryReceipt.result))) return false;
  if (value.locatorStatus !== null && !isProjectWindowLocatorStatus(value.locatorStatus)) return false;
  if (value.locatorIntent !== null && (value.role !== 'launcher' || !isProjectWindowLocatorIntent(value.locatorIntent))) return false;
  return value.role === 'launcher' || value.autoOpen === false;
}
