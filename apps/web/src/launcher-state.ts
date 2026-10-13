import { isProjectWindowId } from '../../desktop/src/project-window-protocol.ts';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';
import { chooseInitialProject, assertLastProjectBootIdentity } from './last-project-navigation.ts';
import { createLastProjectController } from './last-project-state.ts';
import type { LastProjectController } from './last-project-state.ts';
import type { ProjectHomeProject } from './ProjectHome.tsx';
import type { SettingsNavigationCapture, SettingsNavigationRegistry } from './settings-navigation-state.ts';

export type LauncherOperation = 'workspace.restore.inspect' | 'project.list' | 'project.create';
export type LauncherRpc = (operation: LauncherOperation, input?: Readonly<Record<string, unknown>>, options?: { readonly expectedWorkspaceOrigin?: string }) => Promise<unknown>;
/** These callbacks are the actual existing canonical schemas, passed by the
 * legacy composition root. Their result is still unknown until narrowed here. */
export interface LauncherContractChecks {
  readonly parseCreateInput: (value: unknown) => unknown;
  readonly parseWorkspaceInspection: (value: unknown) => unknown;
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
    async create(name: string, description: string): Promise<LauncherProject> {
      const value: unknown = checks.parseCreateInput({ name, description });
      if (!record(value) || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 150 || typeof value.description !== 'string' || value.description.length > 2000 || Object.keys(value).some(key => key !== 'name' && key !== 'description')) throw protocol();
      return parseLauncherProject(await rpc('project.create', { name: value.name, description: value.description }));
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
  readonly listError: string;
  readonly phase: 'home' | 'opening' | 'error';
  readonly openingProjectId: string | null;
  readonly error: string;
  readonly notice: string;
  readonly creating: boolean;
  readonly createUnknown: boolean;
  readonly version: number;
}
const initialState = (): LauncherState => ({ projects: [], workspace: null, listBusy: true, listError: '', phase: 'home', openingProjectId: null, error: '', notice: '', creating: false, createUnknown: false, version: 0 });
export function launcherCreateDisabledReason(context: ProjectWindowContext, state: LauncherState): string {
  if (context.quitting) return '应用正在退出，暂不能新建项目。';
  if (state.phase === 'opening') return '正在核对编辑窗口，暂不能新建项目。';
  if (state.createUnknown) return '上次新建结果未确认。请保留此窗口并刷新列表核对；重新启动后也请先核对，避免重复创建。';
  if (!state.workspace) return '工作区身份尚未核对，暂不能新建项目。';
  if (state.workspace.restored) return '恢复分支暂不支持新建项目。';
  if (context.editorProjectId || context.editorPhase !== 'none') return '已有编辑窗口。请在该窗口新建项目，或先关闭它。';
  return '';
}

/** Read-only startup selection and explicit creation/opening. No project
 * controller, editor preferences, generation or business replay lives here. */
export function createLauncherController({ client, bridge, context: initialContext, explicitProjectId = null, locator = createLastProjectController(), onChange = () => {} }: {
  client: LauncherClient; bridge: ProjectWindowBridge; context: ProjectWindowContext; explicitProjectId?: string | null;
  locator?: LastProjectController; onChange?: (state: LauncherState) => void;
}) {
  let state = initialState(), context = initialContext, active = false, lifetime = 0, readSerial = 0, actionSerial = 0;
  let autoOpenConsumed = !initialContext.autoOpen, selection = 0;
  const emit = (patch: Partial<LauncherState>) => { state = Object.freeze({ ...state, ...patch, version: state.version + 1 }); if (active) onChange(state); };
  const alive = (owner: number) => active && owner === lifetime;
  async function open(projectId: string, remember = true): Promise<boolean> {
    if (!active || context.quitting || state.creating || state.createUnknown || !state.projects.some(project => project.id === projectId)) return false;
    selection++; autoOpenConsumed = true;
    const owner = lifetime, action = ++actionSerial;
    if (context.editorProjectId && context.editorProjectId !== projectId) { emit({ notice: '请先关闭当前编辑窗口，再打开另一个项目。' }); return false; }
    emit({ phase: 'opening', openingProjectId: projectId, error: '', notice: '' });
    try {
      const result = await bridge.openProject(projectId, remember);
      if (!alive(owner) || action !== actionSerial) return false;
      if (!result.ok) {
        emit({ phase: 'home', notice: result.reason === 'another-editor' ? '请先关闭当前编辑窗口，再打开另一个项目。' : '窗口暂不能打开，请保留当前窗口，稍后明确重试。' });
        return false;
      }
      // Host readiness, not IPC acceptance, settles opening. An existing editor
      // is already ready and only receives focus.
      if (result.reason === 'already-open' || context.editorProjectId === projectId && context.editorPhase === 'ready') emit({ phase: 'home' });
      return true;
    } catch { if (alive(owner) && action === actionSerial) emit({ phase: 'error', error: '打开窗口的结果尚未确认，请先核对当前窗口。' }); return false; }
  }
  async function refresh(initial = false): Promise<void> {
    if (!active) return;
    const owner = lifetime, serial = ++readSerial, selected = selection;
    emit({ listBusy: true, listError: '' });
    try {
      const workspace = await client.inspect();
      if (!alive(owner) || serial !== readSerial) return;
      if (state.workspace && (workspace.restored !== state.workspace.restored || workspace.workspaceOrigin !== state.workspace.workspaceOrigin)) throw protocol();
      const [projects, remembered] = await Promise.all([client.list(workspace), initial && !workspace.restored ? locator.discover() : Promise.resolve(null)]);
      if (!alive(owner) || serial !== readSerial) return;
      assertLastProjectBootIdentity(locator.getState());
      emit({ workspace, projects, listBusy: false });
      if (initial && context.autoOpen && !autoOpenConsumed && selected === selection && !context.quitting && !context.editorProjectId && context.editorPhase === 'none') {
        autoOpenConsumed = true;
        const choice = chooseInitialProject(projects, explicitProjectId, remembered?.envelope ?? null);
        if (choice.notice) emit({ notice: choice.notice });
        if (choice.projectId) await open(choice.projectId, false);
      }
    } catch { if (alive(owner) && serial === readSerial) emit({ listBusy: false, listError: '暂时无法读取项目列表。请核对连接后刷新；现有输入会保留。' }); }
  }
  return {
    activate() { if (!active) { active = true; lifetime++; locator.activate(); } },
    dispose() { active = false; lifetime++; readSerial++; actionSerial++; locator.dispose(); },
    boot: () => refresh(true), refresh: () => refresh(false), open,
    interacted() { selection++; autoOpenConsumed = true; },
    updateContext(next: ProjectWindowContext) {
      if (next.contextId !== context.contextId || next.backendId !== context.backendId || next.role !== 'launcher') return;
      const previous = context; context = next;
      if (!next.autoOpen) autoOpenConsumed = true;
      // Host presentation arrives through both the synchronous subscription and
      // a later React prop effect. Only an actual launcher state transition may
      // advance its close identity; Quit's own fence is not new local input.
      if (state.openingProjectId && next.editorProjectId === state.openingProjectId && next.editorPhase === 'failed') {
        const error = '编辑窗口未能完成项目读取，请在该窗口核对或关闭后重试。';
        if (state.phase !== 'error' || state.error !== error) emit({ phase: 'error', error });
      } else if (next.editorPhase === 'ready' || previous.editorProjectId && !next.editorProjectId) {
        if (state.phase !== 'home' || state.openingProjectId !== null) emit({ phase: 'home', openingProjectId: null });
      }
    },
    async create(name: string, description: string): Promise<boolean> {
      if (!active || state.creating || launcherCreateDisabledReason(context, state)) return false;
      const owner = lifetime; selection++; autoOpenConsumed = true;
      emit({ creating: true, notice: '', error: '' });
      let currentContext: ProjectWindowContext;
      try { currentContext = await bridge.context(); }
      catch { if (alive(owner)) emit({ creating: false, notice: '编辑窗口身份未确认，请保留此窗口，核对后再新建项目。' }); return false; }
      if (!alive(owner)) return false;
      if (currentContext.contextId !== context.contextId || currentContext.backendId !== context.backendId || currentContext.role !== 'launcher') {
        emit({ creating: false, notice: '窗口身份已变化，未发起新建项目。' }); return false;
      }
      context = currentContext;
      if (launcherCreateDisabledReason(context, state)) { emit({ creating: false, notice: launcherCreateDisabledReason(context, state) }); return false; }
      let created: LauncherProject;
      try { created = await client.create(name, description); }
      catch { if (alive(owner)) emit({ creating: false, createUnknown: true, notice: '新建结果未确认。请保留此窗口并刷新项目列表核对。重新启动后也请先核对，避免重复创建。' }); return false; }
      if (!alive(owner)) return false;
      emit({ creating: false, projects: [created, ...state.projects.filter(project => project.id !== created.id)], notice: '项目已创建。' });
      // A confirmed create is never replayed just because opening failed.
      await open(created.id);
      return true;
    },
    getState: () => state,
    getContext: () => context,
    locator,
  };
}
export type LauncherController = ReturnType<typeof createLauncherController>;

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
