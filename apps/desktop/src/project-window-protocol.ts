/** The native bridge is window navigation only. It never accepts business
 * operations, URLs, filesystem paths, prompts, credentials or arbitrary channels. */
export const PROJECT_WINDOW_CHANNEL = 'mioon:project-window:v1';
export const PROJECT_WINDOW_EVENT = 'mioon:project-window-state:v1';
export type ProjectWindowRole = 'launcher' | 'editor';
export type ProjectWindowSettingsSlot = 'agent' | 'official' | 'custom' | 'comfy';
export type ProjectWindowPhase = 'none' | 'opening' | 'ready' | 'failed';
export interface ProjectWindowContext {
  readonly version: 1;
  readonly role: ProjectWindowRole;
  readonly contextId: string;
  readonly backendId: string;
  readonly initialProjectId: string | null;
  readonly autoOpen: boolean;
  readonly editorProjectId: string | null;
  readonly editorPhase: ProjectWindowPhase;
  readonly settingsSlot: ProjectWindowSettingsSlot | null;
  readonly settingsVersion: number;
  readonly quitting: boolean;
  /** Explicit launcher selection only; absent/zero keeps startup read-only. */
  readonly rememberVersion?: number;
}
export type ProjectWindowRequest =
  | { readonly action: 'describe' }
  | { readonly action: 'open'; readonly contextId: string; readonly projectId: string; readonly remember?: boolean }
  | { readonly action: 'projects'; readonly contextId: string }
  | { readonly action: 'settings'; readonly contextId: string; readonly slot: ProjectWindowSettingsSlot }
  | { readonly action: 'editor-status'; readonly contextId: string; readonly projectId: string; readonly phase: 'ready' | 'failed' };
export interface ProjectWindowOpenResult {
  readonly ok: boolean;
  readonly reason: 'accepted' | 'already-open' | 'another-editor' | 'busy' | 'unavailable';
}
export interface ProjectWindowBridge {
  context(): Promise<ProjectWindowContext>;
  openProject(projectId: string, remember?: boolean): Promise<ProjectWindowOpenResult>;
  showProjects(): Promise<boolean>;
  showSettings(slot: ProjectWindowSettingsSlot): Promise<boolean>;
  editorStatus(projectId: string, phase: 'ready' | 'failed'): Promise<boolean>;
  subscribe(listener: (context: ProjectWindowContext) => void): () => void;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
export const isProjectWindowId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
export const isProjectWindowSettingsSlot = (value: unknown): value is ProjectWindowSettingsSlot =>
  value === 'agent' || value === 'official' || value === 'custom' || value === 'comfy';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keysAre = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function isProjectWindowRequest(value: unknown): value is ProjectWindowRequest {
  if (!record(value)) return false;
  if (value.action === 'describe') return keysAre(value, ['action']);
  if (!isProjectWindowId(value.contextId)) return false;
  if (value.action === 'open') return (Object.hasOwn(value, 'remember')
    ? keysAre(value, ['action', 'contextId', 'projectId', 'remember']) && typeof value.remember === 'boolean'
    : keysAre(value, ['action', 'contextId', 'projectId'])) && isProjectWindowId(value.projectId);
  if (value.action === 'projects') return keysAre(value, ['action', 'contextId']);
  if (value.action === 'settings') return keysAre(value, ['action', 'contextId', 'slot']) && isProjectWindowSettingsSlot(value.slot);
  return value.action === 'editor-status' && keysAre(value, ['action', 'contextId', 'projectId', 'phase']) &&
    isProjectWindowId(value.projectId) && (value.phase === 'ready' || value.phase === 'failed');
}
export function isProjectWindowContext(value: unknown): value is ProjectWindowContext {
  return record(value) && keysAre(value, ['version', 'role', 'contextId', 'backendId', 'initialProjectId', 'autoOpen',
    'editorProjectId', 'editorPhase', 'settingsSlot', 'settingsVersion', 'quitting', ...(Object.hasOwn(value, 'rememberVersion') ? ['rememberVersion'] : [])]) &&
    (!Object.hasOwn(value, 'rememberVersion') || Number.isSafeInteger(value.rememberVersion) && Number(value.rememberVersion) >= 0) && value.version === 1 &&
    (value.role === 'launcher' || value.role === 'editor') && isProjectWindowId(value.contextId) && isProjectWindowId(value.backendId) &&
    (value.initialProjectId === null || isProjectWindowId(value.initialProjectId)) && typeof value.autoOpen === 'boolean' &&
    (value.editorProjectId === null || isProjectWindowId(value.editorProjectId)) && typeof value.editorPhase === 'string' && ['none', 'opening', 'ready', 'failed'].includes(value.editorPhase) &&
    (value.settingsSlot === null || isProjectWindowSettingsSlot(value.settingsSlot)) && Number.isSafeInteger(value.settingsVersion) && Number(value.settingsVersion) >= 0 &&
    typeof value.quitting === 'boolean';
}
export function isProjectWindowOpenResult(value: unknown): value is ProjectWindowOpenResult {
  return record(value) && keysAre(value, ['ok', 'reason']) && typeof value.ok === 'boolean' &&
    typeof value.reason === 'string' && ['accepted', 'already-open', 'another-editor', 'busy', 'unavailable'].includes(value.reason) &&
    value.ok === (value.reason === 'accepted' || value.reason === 'already-open');
}
