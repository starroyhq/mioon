import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateSource } from './helpers/eval-source.ts';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { defaultWorkspaceState, reconcileWorkspaceState } from '../apps/web/src/workspace-state.ts';
import type { WorkspaceState } from '../apps/web/src/workspace-state.ts';
import { workspaceOriginScope } from '../apps/web/src/workspace-origin.ts';
import { projectOpenAttempt, canPublishProjectOpen, projectResponseMatches, projectOpenFailureKind } from '../apps/web/src/project-open-state.ts';
import { validateProjectWorkspace } from '../apps/web/src/restored-workspace.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { editorInitialSelection } from '../apps/web/src/editor-native-window.ts';
import { chooseInitialProject, retainLastProjectScope, createProjectBootGuard, assertLastProjectBootIdentity } from '../apps/web/src/last-project-navigation.ts';
import { readGenerationProviderDirectory } from '../apps/web/src/video-provider-directory.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = readFileSync(join(root, 'apps/web/src/App.tsx'), 'utf8');
const A = '88000000-0000-4000-8000-000000000001', B = '88000000-0000-4000-8000-000000000002';
const emptyData = { project: null, shots: [], nodes: [], assets: [], versions: [], edges: [] };
interface Deferred<T> {readonly promise: Promise<T>; resolve(value?: T): void; reject(error: unknown): void}
const deferred = <T = unknown>(): Deferred<T> => { let resolve!: (value?: T)=>void, reject!: (error: unknown)=>void; const promise = new Promise<T>((yes, no) => { resolve = (value?: T) => yes(value as T); reject = no; }); return { promise, resolve, reject }; };
function section(source: string, start: string, end: string): string {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source seam: ${start}`);
  assert.equal(source.indexOf(start, a + start.length), -1, `Ambiguous source seam: ${start}`);
  return source.slice(a, b);
}
const compile = (source: string, name: string, env: Record<string, unknown>): ((...args: unknown[])=>unknown) => evaluateSource(`${source}\nreturn ${name};`, Object.keys(env), Object.values(env), {loader: 'tsx'});
const modesMarkup = section(app, '<Tabs value={workspaceMode} onValueChange={changeMode}', '</Tabs>') + '</Tabs>';
const videoDirectoryNoticeSource = section(app, '  const videoDirectoryNotice =', '  if (!workbenchReady && !retainWorkbenchForClip)');
const homeBoundary = section(app, '  if (!workbenchReady && !retainWorkbenchForClip) return <>{webSettingsCenter}<ProjectHome ', '  return <>{webSettingsCenter}<main className={`workbench');
const refreshSource = section(app, '  const refresh = useCallback(', '  async function revealImageAsset(');
const readySource = section(app, '  function projectSessionReady()', '  const workbenchReady =');
const settingsSource = section(app, '  async function prepareSettingsDeparture()', '  async function changeHomePage(');
const projectGuardSource = section(app, '  async function guardProjectNavigation(', '  async function prepareSettingsDeparture(');
const changeSource = section(app, '  async function changeMode(', '  function revealCanvas(');
const guardSource = section(app, '  async function guardNavigation(', '  async function guardProjectNavigation(');
const updateSource = section(app, '  const updateView = useCallback(', '  const field = ');
const selectSource = section(app, '  async function selectProject(', '  async function reloadPreferences(');
const createSource = section(app, '  async function createProject(', '  async function addShot(');
const bootSource = section(app, '  async function boot(): Promise<void> {', '  useEffect(() => {\n    bootGuard.current!.activate();');

// Execute actual App JSX with the real shared Tabs/Button components. SSR checks
// emitted accessibility attributes; it does not claim browser focus/layout QA.
const uiRequire = createRequire(join(root, 'packages/ui/package.json'));
const baseRoot = dirname(dirname(uiRequire.resolve('@base-ui/react/tabs')));
const tabSource = readFileSync(join(baseRoot, 'tabs/tab/TabsTab.js'), 'utf8');
const tabClickSource = section(tabSource, '  function activate(event) {', '  function onFocus(event) {');
const fixture = `
  import { createI18nTestContext } from ${JSON.stringify(join(root, 'tests/helpers/i18n.ts'))};
  const { t, renderMessage } = createI18nTestContext();
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { Tabs, TabsList, TabsTrigger } from '@mioon/ui/components/tabs';
  import { Button } from '@mioon/ui/components/button';
  import ProjectHome from './src/ProjectHome.tsx';
  import { workspaceOriginScope } from './src/workspace-origin.ts';
  import LastProjectStatus from './src/LastProjectStatus.tsx';
  import { useButton } from ${JSON.stringify(join(baseRoot, 'internals/use-button/useButton.js'))};
  import { createChangeEventDetails } from ${JSON.stringify(join(baseRoot, 'internals/createBaseUIEventDetails.js'))};
  import { REASONS } from ${JSON.stringify(join(baseRoot, 'internals/reasons.js'))};
  const Icon = () => null;
  export function Modes({data, loading, workspaceMode, changeMode}) { return ${modesMarkup}; }
  // Only the global settings slot is inert in this projects-page fixture. The
  // actual App early return, ProjectHome, shared controls and status are executed.
  const ProjectHomeConnections = () => null, AgentDockPane = () => null, SettingsNavigationSlot = () => null;
  const AgentSettings = () => null, ImageSettings = () => null, ComfyImageSettings = () => null;
  const RestoredUnavailable = ({title}) => <span>{title}</span>;
  export function Surface({ data, loading, workspaceMode, changeMode, workbenchReady, projects, projectOpening, toast, busy,
    projectListStatus, homePage, changeHomePage, selectProject, refreshHomeProjects, createProject, retainWorkbenchForClip = false, webSettingsCenter = null, videoDirectoryUnavailable = false, preferenceScope = { current: null }, workspace = { restored: false },
    lastProjectStatus, lastProjectRef, restored = false, homeConnection, setHomeConnection, settingsNavigation, prepareSettingsDeparture, setHomePage, locale = 'zh-Hans' }) {
    const { t } = createI18nTestContext(locale);
    ${videoDirectoryNoticeSource}
    ${homeBoundary}
    return <main data-testid="workbench"><Modes {...{ data, loading, workspaceMode, changeMode }} /></main>;
  }
  export const render = props => renderToStaticMarkup(<Surface {...props} />);
  export function nativeProps(props, value) {
    const active = value === props.workspaceMode;
    const trigger = React.Children.toArray(Modes(props).props.children.props.children).find(node => node.props.value === value);
    const disabled = trigger.props.disabled, onValueChange = props.changeMode;
    const _createBaseUIEventDetails = { createChangeEventDetails }, _reasons = { REASONS };
    ${tabClickSource}
    let result;
    function Probe() {
      const { getButtonProps } = useButton({ disabled, composite: true, native: true, focusableWhenDisabled: true });
      result = getButtonProps({ onClick });
      return null;
    }
    renderToStaticMarkup(<Probe />);
    return result;
  }
  export { React, Tabs, TabsList, TabsTrigger, Button };
`;
const built = buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: join(root, 'apps/web') }, bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
const module: {exports: unknown} = { exports: {} };
Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
interface UiModule {render(props: Record<string, unknown>): string; Modes(props: Record<string, unknown>): RenderNodeLike; Surface(props: Record<string, unknown>): RenderNodeLike; nativeProps(props: Record<string, unknown>, value: string): NativeHandlers}
interface RenderNodeLike {props: Record<string, unknown> & {onValueChange?: unknown; onCreate?: unknown; children?: unknown}; [key: string]: unknown}
interface NativeHandlers {onClick(event: unknown): void; onKeyDown(event: unknown): void; onKeyUp(event: unknown): void}
const ui = module.exports as unknown as UiModule;
interface RenderNode {props?: Record<string, unknown> & {children?: unknown; onCreate?: (...args: unknown[])=>unknown}; [key: string]: unknown}
const nodes = (value: unknown): RenderNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value as RenderNode, ...nodes((value as RenderNode).props?.children)] : [];
const event = (key?: string) => ({ key, nativeEvent: { key }, prevented: false, preventDefault() { this.prevented = true; } });
interface EnvAccess extends Record<string, unknown> {
  currentProject: {current: string|null};
  dataRef: {current: Record<string, unknown>};
  viewReady: {current: boolean};
  loading: boolean;
  openedProject: {current: {projectId?: unknown}|null};
  preferencesRef: {current: {load: ()=>Promise<WorkspaceState>; update: (...args: unknown[])=>void; flush: ()=>Promise<unknown>; getStatus: ()=>({phase: string})}};
  viewRef: {current: {activeMode: string}};
  navigationEpoch: {current: number};
  workspaceRef: {current: {restored: boolean; workspaceOrigin?: string}};
  projectOpening: {phase: string; projectId?: string|null; error?: string};
  projectSessionReady: ()=>boolean;
  selectProject: (...args: unknown[])=>Promise<boolean>;
  dirtyRef: {current: boolean};
  confirm: ()=>Promise<boolean>;
  importSession: {current: {active: boolean; selection?: number}};
  projectEpoch: {current: number};
  lastProjectRef: {current: {discover: ()=>Promise<unknown>; getState?: ()=>{identityBlocked: boolean; revision: number|null}; invalidateNavigation?: ()=>void; rememberOpened?: (...args: unknown[])=>void}};
  refresh?: (...args: unknown[])=>Promise<unknown>;
  preferenceScope: {current: unknown};
  projectListStatus: {busy: boolean; error: string};
  projects: unknown[];
}
interface HarnessResult {env: EnvAccess; calls: unknown[][]; change: (...args: unknown[])=>Promise<unknown>; boot: ()=>Promise<unknown>; create: (...args: unknown[])=>Promise<boolean>}
interface HarnessOptions {projectId?: string|null; mode?: string; loading?: boolean; ready?: boolean; restored?: boolean}
const modeProps = (f: HarnessResult): Record<string, unknown> => ({ ...f.env, data: f.env.dataRef.current, loading: f.env.loading, workspaceMode: f.env.viewRef.current.activeMode,
  workbenchReady: f.env.projectSessionReady() && !f.env.loading, changeMode: f.change as never, createProject: f.create, restored: f.env.workspaceRef.current.restored, retainWorkbenchForClip: false, webSettingsCenter: null, preferenceScope: f.env.preferenceScope, workspace: f.env.workspaceRef.current });
function assertHome(html: unknown): void {
  assert.match(String(html), /data-testid="project-home"/);
  assert.doesNotMatch(String(html), /data-testid="workbench"|workspace-canvas|workspace-editing|workspace-mode-help|empty-create-project|react-flow|timeline-panel|inspector-region/);
}
function openingTag(html: unknown, testId: string): string { const tag = String(html).match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0]; assert.ok(tag, testId); return tag!; }
function assertDisabled(html: unknown, expected: boolean): void {
  for (const id of ['workspace-canvas', 'workspace-editing']) assert.equal(/aria-disabled="true"|\sdisabled(?:="")?[\s>]/.test(openingTag(html, id)), expected, id);
}

function harness({ projectId = null, mode = 'canvas', loading = false, ready = Boolean(projectId), restored = false }: HarnessOptions = {}): HarnessResult {
  const calls: unknown[][] = [], view = defaultWorkspaceState(); view.activeMode = mode as never;
  const env: EnvAccess = { msg, ...createI18nTestContext(), localizedError: (value: unknown) => Object.assign(new Error(renderCoreMessage('zh-Hans', value as string)), { displayMessage: value }), clipLoudnessEpoch: { current: 0 }, nativeWindow: null, editorInitialSelection, emptyData, loading, currentProject: { current: projectId }, projectEpoch: { current: 0 }, navigationEpoch: { current: 0 }, requestCounter: { current: 0 }, projectSessionReady: () => false, selectProject: async () => false, refresh: async () => undefined,
    viewRef: { current: view }, viewReady: { current: ready }, dataRef: { current: projectId ? { ...emptyData, project: { id: projectId } } : emptyData },
    workspaceRef: { current: { restored, ...(restored ? { workspaceOrigin: B } : {}) } }, importSession: { current: { active: true, selection: 0 } }, dragging: { current: false },
    audioRoleProbe: { current: null }, audioRoleProbeEpoch: { current: 0 }, observeClipAudioRoleCapability: () => () => {}, isWorkspaceInspection: () => true, canEditTimelineAudioRole: () => true, setAudioRoleCapability: (...args: unknown[]) => calls.push(['setAudioRoleCapability', ...args]),
    dirtyRef: { current: false }, subtitlesRef: { current: null }, clipDraftRef: { current: null }, shotTextRef: { current: null }, subjectsRef: { current: null }, agentDraft: { current: false }, imageDraft: { current: false },
    useCallback: <T>(fn: T): T => fn, workspaceOriginScope, validateProjectWorkspace, reconcileWorkspaceState, readGenerationProviderDirectory, reconcilePending() {}, pinNewWorkspaceIntent: (value: Record<string, unknown>, workspace: {workspaceOrigin?: unknown}) => ({ ...value, workspaceOrigin: workspace.workspaceOrigin }),
    // No editing owner is mounted on the project home; preserve its refresh wait.
    refreshAgentEditingTargets: async () => { await Promise.allSettled([]); },
    confirm: async () => true, readableError: (e: Error) => e.message, pendingForProject: () => [], URL, URLSearchParams,
    window: { location: { href: 'http://127.0.0.1:4318/', search: '' }, history: { pushState() {}, replaceState() {} } },
    tasksRef: { current: { getState: () => ({ phase: 'idle' }), load: async () => {} } },
    preferencesRef: { current: { update: (...args: unknown[]) => calls.push(['preferences', ...args]), flush: async () => {}, load: async () => defaultWorkspaceState(), getStatus: () => ({ phase: 'saved' }) } },
    lastProjectRef: { current: { getState: () => ({ identityBlocked: false, revision: null }), invalidateNavigation: () => {}, rememberOpened: (...args: unknown[]) => calls.push(['remember', ...args]), discover: async () => null } },
    preferenceScope: { current: null }, locatorIdentity: { current: null }, migrateBrowserStorage() {}, retainWorkspaceIdentity: (_current: unknown, observed: unknown) => observed,
    retainLastProjectScope, chooseInitialProject, assertLastProjectBootIdentity, projectOpenAttempt, canPublishProjectOpen, projectResponseMatches, projectOpenFailureKind,
    openedProject: { current: null }, projectCreateFlight: { current: null }, settingsNavigation: { current: createSettingsNavigationRegistry() },
    timelineFormatRef: { current: null }, deliveryNameRef: { current: null }, localDeliveryRef: { current: null },
    projectOpening: { phase: projectId && ready ? 'ready' : 'home', projectId, error: '' }, projects: [],
    projectListStatus: { busy: false, error: '' }, busy: {}, homePage: 'projects', homeConnection: 'agent', toast: null, videoDirectoryUnavailable: false,
    markBusy: (...args: unknown[]) => calls.push(['markBusy', ...args]), setHomeConnection() {}, changeHomePage() {}, refreshHomeProjects() {},
    ...Object.fromEntries(['setLastSync', 'setView', 'setMobilePanel', 'setPreviewAsset', 'setComparisonId', 'setShowCreate', 'setProjects', 'setWorkspace', 'setAuth', 'setOnline', 'setProviders', 'setVideoDirectoryUnavailable', 'setPropertiesPage', 'setTaskState', 'setPreferenceStatus', 'setPending', 'setShowProjects', 'setNodes', 'setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch', 'setRightDockTab', 'setShowExports', 'setRealConfirm', 'setToast', 'setZoom', 'setPanelOverlay', 'setHomePage', 'setHomeConnection', 'setPanelOpen', 'setSettingsOpen', 'setAgentPage', 'setWorkspaceMode', 'setShowTasks', 'setSelectedTaskId', 'setShowDelivery', 'setShowImage', 'setShowProjectChooser', 'setTaskState', 'setShowSettings', 'setWebSettingsOpen', 'setCanvasToolbar', 'notify'].map((name: string) => [name, (...args: unknown[]) => calls.push([name, ...args])])),
  };
  if (projectId && ready) env.openedProject.current = projectOpenAttempt(projectId as string, 0, workspaceOriginScope(env.workspaceRef.current as never) as string) as unknown as {projectId?: unknown};
  env.setProjectOpening = (value: unknown) => { env.projectOpening = value as EnvAccess['projectOpening']; calls.push(['setProjectOpening', value]); };
  env.setProjectListStatus = (value: unknown) => { env.projectListStatus = value as EnvAccess['projectListStatus']; calls.push(['setProjectListStatus', value]); };
  env.setHomePage = (value: unknown) => { env.homePage = value as unknown as string; calls.push(['setHomePage', value]); };
  env.setProjects = (value: unknown) => { env.projects = value as unknown[]; calls.push(['setProjects', value]); };
  env.setVideoDirectoryUnavailable = (value: unknown) => { env.videoDirectoryUnavailable = Boolean(value); calls.push(['setVideoDirectoryUnavailable', value]); };
  env.setData = (data: unknown) => { env.dataRef.current = data as Record<string, unknown>; calls.push(['data', data]); };
  env.setLoading = (value: unknown) => { env.loading = Boolean(value); calls.push(['loading', value]); };
  env.refresh = async (...args: unknown[]) => { const scope = { ...env } as Record<string, unknown>; delete scope.refresh; return compile(refreshSource, 'refresh', scope)(...args); };
  env.context = () => ({ projectId: env.currentProject.current, epoch: env.navigationEpoch.current, workspace: env.workspaceRef.current });
  env.isCurrent = (captured: unknown) => { const value = captured as {projectId?: unknown; epoch?: unknown; workspace?: unknown}; return value.projectId === env.currentProject.current && value.epoch === env.navigationEpoch.current && workspaceOriginScope(value.workspace as never) === workspaceOriginScope(env.workspaceRef.current as never); };
  env.updateView = compile(updateSource, 'updateView', env);
  env.projectSessionReady = () => compile(readySource, 'projectSessionReady', env)() as boolean;
  env.prepareSettingsDeparture = () => compile(settingsSource, 'prepareSettingsDeparture', env)();
  env.guardProjectNavigation = (...args: unknown[]) => compile(projectGuardSource, 'guardProjectNavigation', env)(...args);
  env.guardNavigation = (...args: unknown[]) => compile(guardSource, 'guardNavigation', env)(...args);
  env.selectProject = (...args: unknown[]) => compile(selectSource, 'selectProject', env)(...args) as Promise<boolean>;
  const bootGuard = createProjectBootGuard(() => env.projectEpoch.current); bootGuard.activate();
  env.bootGuard = { current: bootGuard };
  env.rpc = async (operation: string, input: {projectId?: unknown}) => { calls.push(['rpc', operation]);
    if (operation === 'workspace.restore.inspect') return { restored: false };
    if (operation === 'project.get') return { ...emptyData, project: { id: input.projectId }, ...(env.workspaceRef.current.restored ? { exports: [], restore: { workspaceOrigin: env.workspaceRef.current.workspaceOrigin, heldExportIds: [] } } : {}) };
    if (operation === 'video.connection.list') return [];
    return [];
  };
  env.run = async (...args: unknown[]) => { calls.push(['dispatch', ...args]); return { id: A }; };
  return { env, calls, change: async (...args: unknown[]) => await compile(changeSource, 'changeMode', env)(...args), boot: async () => await compile(bootSource, 'boot', env)(), create: async (...args: unknown[]) => await compile(createSource, 'createProject', env)(...args) as boolean };
}

test('actual empty startup shows the independent home and never mounts project mode controls', async () => {
  const f = harness(); await f.boot();
  assert.equal(f.env.currentProject.current, null); assert.equal(f.env.viewReady.current, false); assert.equal(f.env.loading, false);
  assert.equal(f.env.openedProject.current, null); assert.equal(f.env.projectSessionReady(), false);
  const html = ui.render(modeProps(f)); assertHome(html);
  assert.match(html, /还没有项目/); assert.ok(html.includes(createI18nTestContext().t('projects.emptyBody')));
  for (const id of ['project-home-page-projects', 'project-home-page-settings', 'project-home-create-toggle']) {
    assert.match(openingTag(html, id), /type="button"/);
    assert.match(openingTag(html, id), /tabindex="0"/);
  }
  assert.doesNotMatch(html, /role="dialog"/);
});

test('actual home status shows the localized optional video directory failure and clears it after retry', async () => {
  const f = harness(), originalRpc = f.env.rpc as (operation: string, input: {projectId?: unknown}) => Promise<unknown>;
  let unavailable = true;
  f.env.rpc = async (operation: string, input: {projectId?: unknown}) => {
    if (operation === 'video.connection.list' && unavailable) throw new Error('Optional video directory unavailable');
    return originalRpc(operation, input);
  };
  await f.boot();
  assert.equal(f.env.videoDirectoryUnavailable, true);
  assert.equal(f.env.loading, false); assert.equal(f.env.currentProject.current, null);
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
    const html = ui.render({ ...modeProps(f), locale }); assertHome(html);
    assert.match(html, /<p[^>]*role="status"[^>]*data-testid="video-directory-unavailable">/);
    assert.ok(html.includes(createI18nTestContext(locale).t('video.providers.directoryUnavailableHint')), locale);
    assert.doesNotMatch(ui.render({ ...modeProps(f), locale, restored: true }), /data-testid="video-directory-unavailable"/);
  }
  unavailable = false; await f.boot();
  assert.equal(f.env.videoDirectoryUnavailable, false);
  assert.doesNotMatch(ui.render(modeProps(f)), /data-testid="video-directory-unavailable"/);
});

test('unmounted shared mode controls retain defensive click and Enter/Space guards', async () => {
  const f = harness(); await f.boot(); f.calls.length = 0;
  assertHome(ui.render(modeProps(f)));
  let changes = 0; const props = { ...modeProps(f), changeMode: (...args: unknown[]) => { changes++; return f.change(...args); } };
  for (const value of ['canvas', 'editing']) {
    const handlers = ui.nativeProps(props, value), click = event(); handlers.onClick(click); assert.equal(click.prevented, true);
    for (const key of ['Enter', ' ']) { handlers.onKeyDown(event(key)); handlers.onKeyUp(event(key)); }
  }
  await f.change('editing');
  assert.equal(changes, 0); assert.deepEqual(f.calls, []); assert.equal(f.env.viewRef.current.activeMode, 'canvas');
  assert.equal(f.env.navigationEpoch.current, 0);
});

test('actual loaded normal/restored project switches through the shared component callback and guarded preferences', async () => {
  for (const restored of [false, true]) {
    const f = harness({ projectId: A, restored }), props = modeProps(f); assertDisabled(ui.render(props), false);
    assert.doesNotMatch(ui.render(props), /workspace-mode-help/);
    const tree = ui.Modes(props); assert.equal(tree.props.onValueChange, f.change);
    ui.nativeProps(props, 'editing').onClick(event()); await new Promise(setImmediate);
    assert.equal(f.env.viewRef.current.activeMode, 'editing'); assert.equal(f.env.navigationEpoch.current, 1);
    assert.equal(f.calls.filter(call => call[0] === 'preferences').length, 1);
    assert.equal(f.calls.find(call => call[0] === 'preferences')![1], A);
    assert.equal(f.calls.some(call => call[0] === 'dispatch' || call[0] === 'rpc'), false);
    await f.change('canvas'); assert.equal(f.env.viewRef.current.activeMode, 'canvas');
    const before = f.calls.length; await f.change('canvas'); await f.change('invalid'); assert.equal(f.calls.length, before);
  }
});

test('the actual home create callback enables workbench modes only after successful project activation', async () => {
  const f = harness(), props = modeProps(f), tree = ui.Surface(props), home = nodes(tree).find(node => node.props && node.props.onCreate) as RenderNode | undefined;
  assertHome(ui.render(props)); assert.ok(home, 'project home must receive onCreate'); assert.equal(home!.props!.onCreate, f.create); assert.deepEqual(f.calls, []);
  assert.equal(await (home!.props!.onCreate as (...args: unknown[])=>Promise<boolean>)('第一个项目', ''), true);
  const dispatch = f.calls.find((call: unknown[]) => call[0] === 'dispatch') as unknown as unknown[]; assert.deepEqual(dispatch.slice(0, 4), ['dispatch', 'project-create', 'project.create', { name: '第一个项目', description: '' }]); assert.equal(dispatch.length, 6);
  assert.equal(f.env.currentProject.current, A); assert.equal(f.env.viewReady.current, true); assert.equal(f.env.loading, false);
  assert.equal(f.env.projectSessionReady(), true); assert.equal(f.env.openedProject.current!.projectId, A);
  assertDisabled(ui.render(modeProps(f)), false); await f.change('editing'); assert.equal(f.env.viewRef.current.activeMode, 'editing');
});

test('loading and not-ready guards still reject mode changes; failed project activation remains on home', async () => {
  for (const options of [{ projectId: A, loading: true }, { projectId: A, ready: false }]) {
    const f = harness(options); await f.change('editing'); assert.deepEqual(f.calls, []); assert.equal(f.env.viewRef.current.activeMode, 'canvas');
    assertHome(ui.render(modeProps(f))); assert.equal(f.env.projectSessionReady() && !f.env.loading, false);
  }
  for (const stage of ['preferences', 'project']) {
    const f = harness();
    if (stage === 'preferences') f.env.preferencesRef.current.load = async () => { throw Error('Load failed'); };
    else f.env.refresh = async () => null;
    assert.equal(await f.env.selectProject(A), false); assert.equal(f.env.loading, false);
    assertHome(ui.render(modeProps(f))); assert.equal(f.env.projectOpening.phase, 'error'); assert.equal(f.env.projectSessionReady(), false); const before = f.calls.filter(call => call[0] === 'preferences').length;
    await f.change('editing'); assert.equal(f.calls.filter(call => call[0] === 'preferences').length, before);
  }
});

test('late project preference replies cannot enable a superseded or disposed owner', async () => {
  for (const outcome of ['resolve', 'reject', 'dispose']) {
    const f = harness(), gate = deferred(); f.env.preferencesRef.current.load = () => gate.promise as Promise<WorkspaceState>;
    const opening = f.env.selectProject(A); await new Promise(setImmediate);
    assertHome(ui.render(modeProps(f)));
    if (outcome === 'dispose') f.env.importSession.current.active = false;
    else { f.env.currentProject.current = B; f.env.projectEpoch.current++; }
    const start = f.calls.length;
    if (outcome === 'reject') gate.reject(Error('Old load failed')); else gate.resolve(defaultWorkspaceState());
    assert.equal(await opening, false); assert.equal(f.env.viewReady.current, false);
    assert.deepEqual(f.calls.slice(start), []); assertHome(ui.render(modeProps(f))); assert.equal(f.env.projectSessionReady(), false);
  }
});

test('a late discard confirmation cannot switch a replacement project or persist its mode', async () => {
  for (const changeOwner of [(f: HarnessResult) => { f.env.currentProject.current = B; f.env.navigationEpoch.current++; }, (f: HarnessResult) => { f.env.workspaceRef.current = { restored: true, workspaceOrigin: B }; }]) {
    const f = harness({ projectId: A }), gate = deferred(); f.env.dirtyRef.current = true; f.env.confirm = () => gate.promise as Promise<boolean>;
    const changing = f.change('editing'); await new Promise(setImmediate); changeOwner(f); gate.resolve(true); await changing;
    assert.deepEqual(f.calls, []); assert.equal(f.env.viewRef.current.activeMode, 'canvas');
  }
});

test('a stale boot result cannot replace the current empty/project owner', async () => {
  const f = harness(), gate = deferred(); f.env.lastProjectRef.current.discover = () => gate.promise;
  const booting = f.boot(); await new Promise(setImmediate); f.env.projectEpoch.current++; f.env.currentProject.current = B;
  const start = f.calls.length; gate.resolve(null); await booting;
  assert.equal(f.env.currentProject.current, B); assert.deepEqual(f.calls.slice(start), []);
});
