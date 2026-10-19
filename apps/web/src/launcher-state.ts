import { message as msg } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { isProjectWindowId } from '../../desktop/src/project-window-protocol.ts';
import type { ProjectWindowContext } from './desktop-window-client.ts';
import type { ProjectHomeProject } from './ProjectHome.tsx';
import type { SettingsNavigationCapture, SettingsNavigationRegistry } from './settings-navigation-state.ts';
import { TIMELINE_CURRENT_OUTPUT_PRESETS } from '../../../packages/contracts/src/timeline-output-geometry.ts';

export type LauncherOperation = 'workspace.restore.inspect' | 'project.list' | 'project.create';
export type LauncherRpc = (operation: LauncherOperation, input?: Readonly<Record<string, unknown>>, options?: { readonly expectedWorkspaceOrigin?: string }) => Promise<unknown>;
/** These callbacks are the actual existing canonical schemas, passed by the
 * legacy composition root. Their result is still unknown until narrowed here. */
export interface LauncherContractChecks {
  readonly parseCreateInput: (value: unknown) => unknown;
  readonly parseWorkspaceInspection: (value: unknown) => unknown;
  readonly isDefinitiveCreateRejection?: (error: unknown) => boolean;
}
/** Only this client can classify a create at its actual dispatch boundary.
 * Transport proof is injected by the composition root; arbitrary flags and
 * malformed success responses are never evidence that nothing was created. */
export class LauncherCreateError extends Error {
  readonly outcome: 'rejected' | 'unknown';
  constructor(outcome: 'rejected' | 'unknown') {
    super(outcome === 'rejected' ? '新建请求未被接受，请核对输入后明确重试。' : '新建结果尚未确认，请保留原窗口核对。');
    this.name = 'LauncherCreateError';
    this.outcome = outcome;
  }
}
export interface LauncherWorkspace { readonly restored: boolean; readonly workspaceOrigin: string | null }
export interface LauncherProject extends ProjectHomeProject {
  readonly description: string;
  readonly revision: number;
  readonly createdAt: string;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const protocol = () => new Error('项目列表或工作区身份核对无效，请保留当前窗口并重新读取。');
const stamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

/** Validates the existing services' project row, not an asserted RPC generic. */
export function parseLauncherProject(value: unknown): LauncherProject {
  if (!record(value) || !isProjectWindowId(value.id) || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 150 ||
    typeof value.description !== 'string' || value.description.length > 2000 || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1 || !stamp(value.createdAt) || !stamp(value.updatedAt)) throw protocol();
  return Object.freeze({ id: value.id, name: value.name, description: value.description, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt });
}
export function parseLauncherProjects(value: unknown): readonly LauncherProject[] {
  if (!Array.isArray(value)) throw protocol();
  const projects = value.map((item: unknown) => parseLauncherProject(item));
  if (new Set(projects.map(project => project.id)).size !== projects.length) throw protocol();
  return Object.freeze(projects);
}
export function createLauncherClient(rpc: LauncherRpc, checks: LauncherContractChecks) {
  return {
    async inspect(): Promise<LauncherWorkspace> {
      const value: unknown = checks.parseWorkspaceInspection(await rpc('workspace.restore.inspect'));
      if (!record(value) || typeof value.restored !== 'boolean' || value.restored && !isProjectWindowId(value.workspaceOrigin)) throw protocol();
      return Object.freeze({ restored: value.restored, workspaceOrigin: value.restored && typeof value.workspaceOrigin === 'string' ? value.workspaceOrigin : null });
    },
    async list(workspace: LauncherWorkspace): Promise<readonly LauncherProject[]> {
      return parseLauncherProjects(await rpc('project.list', {}, workspace.workspaceOrigin ? { expectedWorkspaceOrigin: workspace.workspaceOrigin } : {}));
    },
    async create(name: string, description: string, timelinePresetId?: string): Promise<LauncherProject> {
      let input: { name: string; description: string; timelinePresetId?: string };
      try {
        const value: unknown = checks.parseCreateInput({ name, description, ...(timelinePresetId === undefined ? {} : { timelinePresetId }) });
        if (!record(value) || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 150 || typeof value.description !== 'string' || value.description.length > 2000 || Object.keys(value).some(key => !['name', 'description', 'timelinePresetId'].includes(key)) || timelinePresetId !== undefined && (value.timelinePresetId !== timelinePresetId || !TIMELINE_CURRENT_OUTPUT_PRESETS.some(item => item.id === timelinePresetId)) || timelinePresetId === undefined && value.timelinePresetId !== undefined) throw protocol();
        input = { name: value.name, description: value.description, ...(timelinePresetId === undefined ? {} : { timelinePresetId }) };
      } catch { throw new LauncherCreateError('rejected'); }
      let response: unknown;
      try { response = await rpc('project.create', input); }
      catch (error) {
        let rejected = false;
        try { rejected = checks.isDefinitiveCreateRejection?.(error) === true; } catch { /* Missing proof stays unknown. */ }
        throw new LauncherCreateError(rejected ? 'rejected' : 'unknown');
      }
      try {
        const project = parseLauncherProject(response);
        if (project.name !== input.name || project.description !== input.description) throw protocol();
        return project;
      } catch { throw new LauncherCreateError('unknown'); }
    },
  };
}
export type LauncherClient = ReturnType<typeof createLauncherClient>;
export interface LauncherCreateMetadata { readonly dirty: boolean; readonly busy: boolean; readonly version: number }
export interface LauncherCloseMetadata extends LauncherCreateMetadata { readonly blocked: boolean }
export interface LauncherState {
  readonly projects: readonly LauncherProject[];
  readonly workspace: LauncherWorkspace | null;
  readonly listBusy: boolean;
  readonly listError: string | DisplayMessage;
  readonly phase: 'home' | 'opening' | 'error';
  readonly openingProjectId: string | null;
  readonly error: string | DisplayMessage;
  readonly notice: string | DisplayMessage;
  readonly creating: boolean;
  readonly createUnknown: boolean;
  readonly version: number;
}
const initialState = (): LauncherState => ({ projects: [], workspace: null, listBusy: true, listError: '', phase: 'home', openingProjectId: null, error: '', notice: '', creating: false, createUnknown: false, version: 0 });
export function launcherCreateDisabledReason(context: ProjectWindowContext, state: LauncherState): string | DisplayMessage {
  if (context.quitting) return msg('projects.quittingCreate');
  if (state.phase === 'opening') return msg('projects.checkingEditorCreateBlocked');
  if (state.createUnknown) return msg('projects.createUnknownRestart');
  if (!state.workspace) return msg('projects.workspaceNotChecked');
  if (state.workspace.restored) return msg('projects.restoredCreateUnavailable');
  return '';
}

/** Compatibility entry point; the native renderer now uses the same guarded
 * owner for launcher and scoped editor pickers. */
export { createLauncherEntryController as createLauncherController } from './project-entry-state.ts';
export type { ProjectEntryController as LauncherController } from './project-entry-state.ts';

/** Combines metadata-only local creation with the canonical settings registry
 * for P0. Captures are exact, single-owner observations; no fields or secrets
 * are copied into a native-close report. */
export function createLauncherCloseSettings(settings: SettingsNavigationRegistry, readLocal: () => LauncherCloseMetadata) {
  const observations = new WeakMap<SettingsNavigationCapture, { settings: SettingsNavigationCapture; local: LauncherCloseMetadata }>();
  return {
    capture(): SettingsNavigationCapture {
      const configuration = settings.capture(), local = readLocal();
      const result = Object.freeze([...configuration, Object.freeze({ slot: 'launcher:create', owner: 1, ...local })]);
      observations.set(result, { settings: configuration, local });
      return result;
    },
    canLeave(capture: SettingsNavigationCapture): boolean {
      const before = observations.get(capture), current = readLocal();
      return Boolean(before && settings.canLeave(before.settings) && before.local.version === current.version && before.local.dirty === current.dirty && !current.busy && !current.blocked);
    },
    needsConfirmation(capture: SettingsNavigationCapture): boolean {
      const before = observations.get(capture);
      return !before || before.local.dirty || settings.needsConfirmation(before.settings);
    },
  };
}
