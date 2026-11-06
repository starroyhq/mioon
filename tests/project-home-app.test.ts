import {readProjectBackupNativeActions} from '../apps/web/src/project-backup-native.ts';
import type {ProjectFeatureAdmission} from '../apps/web/src/project-feature-admission.ts';
type HomeSnapshot=Omit<ReturnType<typeof snapshot>,'project'>&{project:ReturnType<typeof snapshot>['project']|null};
interface HomeOptions {nativeWindow?:ReturnType<typeof nativeEditor>|null;confirm?:()=>unknown;guard?:(current:()=>unknown)=>unknown;preferences?:(...args:unknown[])=>unknown;preferenceStatus?:{phase:string;error?:Error};directory?:()=>unknown;videoDirectory?:()=>unknown;rpc?:(operation:string,input:{projectId:string})=>unknown;get?:(projectId:string)=>unknown;create?:(...args:unknown[])=>unknown}
interface HomeEnvironment extends Record<string,unknown> {auth:boolean|'error'|null;bootGuard:{current:ReturnType<typeof createProjectBootGuard>};busy:Record<string,unknown>;currentProject:{current:string|null};data:HomeSnapshot;dataRef:{current:HomeSnapshot};homePage:string;importSession:{current:{active:boolean;selection:number}};loading:boolean;nativeWindow:ReturnType<typeof nativeEditor>|null;navigationEpoch:{current:number};openedProject:{current:opening.ProjectOpenAttempt|null};projectCreateFlight:{current:unknown};projectEpoch:{current:number};projectListStatus:{busy:boolean;error:string|i18nCore.DisplayMessage};projectOpening:{phase:string;projectId:string|null;error:string};requestCounter:{current:number};toast:unknown;videoDirectoryUnavailable:boolean;viewReady:{current:boolean};viewRef:{current:ReturnType<typeof defaultWorkspaceState>};webSettingsRequest:{page:string;resolve?:(accepted:boolean)=>void}|null;window:{location:{href:string;search:string;pathname:string};history:{pushState:(...args:unknown[])=>number;replaceState:(...args:unknown[])=>number}};editorSession: {current: string}, workspaceRef:{current:{}};projectEntryIdentityRef:{current:ProjectEntryIdentityOwner}}
interface HomeApi {captureProjectFeatureAdmission(projectId:string):ProjectFeatureAdmission|null;projectSessionReady():boolean;selectProject(projectId:string,remember?:boolean):Promise<boolean>;refresh(projectId:string,silent?:boolean,options?:{opening?:boolean}):Promise<ReturnType<typeof snapshot>|null>;prepareSettingsDeparture():Promise<unknown>;openGlobalSettings(page?:string):unknown;changeHomePage(page:string):Promise<unknown>;refreshHomeProjects():Promise<unknown>;createProject(name:string,description:string):Promise<boolean>;showProjectHome():Promise<boolean>;boot():Promise<void>}
type HomeHarness=ReturnType<typeof harness>;
type HomeUi={canOfferBackupRecovery:typeof import('../apps/web/src/ProjectBackupRecovery.tsx').canOfferBackupRecovery;React:typeof import('react');renderToStaticMarkup:typeof import('react-dom/server').renderToStaticMarkup;ConfirmationProvider:typeof import('../packages/ui/src/components/workbench-confirm.tsx').ConfirmationProvider}&Record<string,unknown>;
import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage } from './helpers/i18n.ts';
import * as i18nCore from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';
import * as opening from '../apps/web/src/project-open-state.ts';
import { editorInitialSelection, revealNativeProjects } from '../apps/web/src/editor-native-window.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { defaultWorkspaceState } from '../apps/web/src/workspace-state.ts';
import { chooseInitialProject, retainLastProjectScope, createProjectBootGuard } from '../apps/web/src/last-project-navigation.ts';
import {videoConnectionProviders} from '../apps/web/src/generation-settings.ts';
import {readGenerationProviderDirectory} from '../apps/web/src/video-provider-directory.ts';

import { lenientFunction } from './helpers/eval-source.ts';
import {projectEntryFixture, projectEntryOwnerFixture, PROJECT_ENTRY_TEST_SCOPE} from './helpers/project-entry-fixture.ts';
import {readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import type {ProjectEntryIdentityOwner} from '../apps/web/src/project-entry-identity.ts';
import {projectDirectoryProjects} from '../apps/web/src/project-directory-presentation.ts';
const Function = lenientFunction;
const root = fileURLToPath(new URL('../', import.meta.url));
// The same assertions can run against an independently extracted baseline App.
const app = readFileSync(process.env.MIOON_HOME_APP_SOURCE || join(root, 'apps/web/src/App.tsx'), 'utf8');
const id = (n: number) => `77000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projects = [1, 2].map(n => ({ id: id(n), name: `项目 ${n}`, updatedAt: '' }));
const snapshot = (projectId: string) => ({ project: { id: projectId, name: '已核对项目' }, shots: [], nodes: [], edges: [], assets: [], versions: [], jobs: [], exports: [] });
const emptyData = { project: null, shots: [], nodes: [], edges: [], assets: [], versions: [], jobs: [], exports: [] };
const deferred = <T = unknown>() => { let resolve!: (value?: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = (yes as (value?: T | PromiseLike<T>) => void); reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
const failure = (code: string|undefined) => Object.assign(new Error(code), { code });
function section(start: string, end: string) {
  const first = app.indexOf(start), last = app.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Actual App boundary is required: ${start.trim()}`);
  assert.equal(app.indexOf(start, first + start.length), -1, `Boundary must be unique: ${start.trim()}`);
  return app.slice(first, last);
}
function environment(options:HomeOptions = {}) {
  const calls: unknown[][] = [], registry = createSettingsNavigationRegistry();
  let created = false;
  const assigned=options.nativeWindow?.context.initialProjectId;
  const directoryProjects=assigned&&/^[a-f0-9-]{36}$/iu.test(assigned)&&!projects.some(project=>project.id===assigned)?[...projects,{id:assigned,name:'宿主分配项目'}]:projects;
  const identity = projectEntryOwnerFixture(() => options.directory ? options.directory() : projectEntryFixture(created ? [...directoryProjects, {id:id(3),name:'新项目'}].filter((project,index,all)=>all.findIndex(item=>item.id===project.id)===index) : directoryProjects), calls);
  const env = { LanguageControl: () => null, renderImportFeedback: (locale: string, value: string|i18nCore.DisplayMessage|null|undefined) => renderCoreMessage((locale as unknown as Parameters<typeof renderCoreMessage>[0]), value), msg, ...createI18nTestContext(), localizedError: (displayMessage: string|i18nCore.DisplayMessage|null|undefined) => Object.assign(new Error(renderCoreMessage('zh-Hans', displayMessage)), { displayMessage }),
    ...opening, videoConnectionProviders, readGenerationProviderDirectory, canOfferBackupRecovery: homeUi().canOfferBackupRecovery,
    editorInitialSelection, revealNativeProjects, nativeWindow: options.nativeWindow ?? null, nativeLeaseRevoked: {current: false},
    clipDraftRef: {current: null}, retainWorkbenchForClip: false, retainSettingsForIdentity: false, guardRetainedInputInteraction() {},


    nativeProjectEntry: { open: async (projectId: unknown) => { calls.push(['nativeEntry.open', projectId]); return true; },
      show: async (mode: unknown) => { calls.push(['nativeEntry.show', mode]); return true; },
      readCloseSnapshot: () => ({ dirty: false, busy: false, unknown: false, identity: [] }) },
    // The hook is a fixed integration boundary here. Its actual arguments are
    // recorded; readiness and selection still execute the real App functions.
    useEditorWindowStatus: (...args: unknown[]) => calls.push(['editorWindowStatus', ...args]),
    useEditorSettingsScope: (binding: unknown) => { calls.push(['editorSettingsScope', binding]); return undefined; },
    chooseInitialProject, retainLastProjectScope, readProjectEntryIdentity, projectDirectoryProjects, projectEntryIdentityRef: {current: identity}, URL, URLSearchParams,
    useCallback: (callback: unknown) => callback, emptyData, loading: false, auth: true, online: true, videoDirectoryUnavailable: false,
    data: emptyData, projects, projectOpening: { phase: 'home', projectId: null, error: '' },
    backupFailure: null, historyView: null, nativeBackup: null, saveIsDirty: false,
    homePage: 'projects', homeConnection: 'agent', webSettingsRequest: null, webSettingsOpen: false, projectListStatus: { busy: false, error: '' }, busy: {}, toast: null,
    currentProject: { current: null }, projectEpoch: { current: 0 }, navigationEpoch: { current: 0 },
    webSettingsRequestRef: { current: null },
    requestCounter: { current: 0 }, projectListSerial: { current: 0 }, openedProject: { current: null }, projectCreateFlight: { current: null },
    importSession: { current: { active: true, selection: 0 } }, editorSession: {current: 'normal'}, workspaceRef: { current: {  } },
    dataRef: { current: emptyData }, viewRef: { current: defaultWorkspaceState() }, viewReady: { current: false },
    settingsNavigation: { current: registry }, agentDraft: { current: false }, imageDraft: { current: false }, dragging: { current: false },
    preferenceScope: { current: null }, locatorIdentity: { current: null },
    notify: (...args: unknown[]) => calls.push(['notice', ...args]), readableError: (error: { message: unknown; }) => error.message,
    confirm: async () => { calls.push(['confirm']); return options.confirm ? options.confirm() : true; },
    guardProjectNavigation: async (_message: unknown, _dirty: unknown, current: () => unknown) => options.guard ? options.guard(current) : current(),
    pendingForProject: () => [], reconcileWorkspaceState: (state: unknown) => state,
    reconcilePending: (...args: unknown[]) => calls.push(['reconcile', ...args]),
    // This fixture owns no editing claims; match the empty-owner refresh wait.
    refreshAgentEditingTargets: async () => { await Promise.allSettled([]); },
    updateView: (...args: unknown[]) => calls.push(['updateView', ...args]), migrateBrowserStorage() {}, isBusy: () => false,
    markBusy: (projectId:string|null,key:string, value: unknown) => { calls.push(['markBusy', projectId, key, value]); if (projectId === env.currentProject.current) env.busy[key] = value; },
    preferencesRef: { current: {
      flush: async (...args: unknown[]) => { calls.push(['flush', ...args]); },
      load: async (...args: unknown[]) => { calls.push(['preferences', ...args]); return options.preferences ? options.preferences(...args) : defaultWorkspaceState(); },
      getStatus: () => options.preferenceStatus || { phase: 'saved' },
      update: (...args: unknown[]) => calls.push(['preferences.update', ...args]),
    } },
    tasksRef: { current: { getState: () => ({ phase: 'idle', items: [] }), load: async (projectId: unknown) => calls.push(['tasks.load', projectId]) } },
    rpc: async (operation: string, input: { projectId: string; }) => {
      calls.push(['rpc', operation, input]);
      if (operation === 'video.connection.list') return options.videoDirectory ? options.videoDirectory() : [];
      if (options.rpc) return options.rpc(operation, input);
      if (operation === 'project.get') return options.get ? options.get(input.projectId) : snapshot(input.projectId);
      if (operation === 'provider.list') return [];
      assert.fail(`Unexpected RPC: ${operation}`);
    },
    run: async (...args: unknown[]) => { calls.push(['run', ...args]); created = true; return options.create ? options.create(...args) : { id: id(3) }; },
    window: { location: { href: 'http://127.0.0.1:4318/', search: '', pathname: '/' }, history: {
      pushState: (...args: unknown[]) => calls.push(['pushState', ...args]), replaceState: (...args: unknown[]) => calls.push(['replaceState', ...args]),
    } },
  } as unknown as HomeEnvironment;
  for (const name of ['ProjectOpening', 'HomePage', 'ProjectListStatus', 'Auth', 'Online', 'Data', 'Projects', 'Providers', 'LastSync',
    'PropertiesPage', 'TaskState', 'PreferenceStatus', 'Pending', 'ShowProjects', 'Nodes', 'Loading', 'ShotDirty', 'ClipDirty', 'SourceDirty',
    'SubjectDirty', 'SubtitleDirty', 'InspectorEpoch', 'RightDockTab', 'ShowExports', 'ComparisonId', 'PreviewAsset', 'RealConfirm',
    'Toast', 'MobilePanel', 'PanelOverlay', 'ShowTasks', 'SelectedTaskId', 'ShowDelivery', 'ShowImage', 'ShowProjectChooser', 'View', 'Zoom', 'Workspace', 'ShowCreate', 'WebSettingsRequest', 'WebSettingsOpen', 'AudioRoleCapability', 'VideoDirectoryUnavailable', 'BackupFailure', 'HistoryView']) {
    const key = name[0].toLowerCase() + name.slice(1);
    env[`set${name}`] = (value:unknown|((old:unknown)=>unknown)) => { env[key] = typeof value === 'function' ? (value as (old:unknown)=>unknown)(env[key]) : value; calls.push([`set${name}`, env[key]]); };
  }
  env.bootGuard = { current: createProjectBootGuard(() => env.projectEpoch.current) }; env.bootGuard.current.activate();
  return { env, calls, registry };
}
function harness(options:HomeOptions = {}) {
  const { env, calls, registry } = environment(options);
  const source = [section('  function captureProjectFeatureAdmission(', '  function projectSessionReady()'),section('  function projectSessionReady()', '  const workbenchReady ='),
    section('  const context = (): CapturedContext =>', '  taskWorkspaceState.current ='),
    section('  async function prepareSettingsDeparture()', '  async function changeMode('),
    section('  const refresh = useCallback(', '  async function revealImageAsset('),
    section('  async function selectProject(', '  async function reloadPreferences('),
    section('  async function boot(): Promise<void> {', '  useEffect(() => {\n    const identity = projectEntryIdentityRef.current!;'),
    section('  async function createProject(', '  async function addShot(')].join('\n');
  // A live lexical environment models React rerenders without reimplementing the
  // production functions. Only external services and unrelated draft guards are fakes.
  const api = Function('env', `with (env) { ${source}\nreturn { captureProjectFeatureAdmission, projectSessionReady, selectProject, refresh, prepareSettingsDeparture, openGlobalSettings, changeHomePage, refreshHomeProjects, createProject, showProjectHome, boot }; }`)(env);
  return { env, calls, registry, ...(api as HomeApi),
    eligible: () => opening.canPublishProjectOpen(env.openedProject.current, { active: env.importSession.current.active,
      currentProjectId: env.currentProject.current, epoch: env.projectEpoch.current, workspaceScope: env.editorSession.current,
      preferencesReady: env.viewReady.current, dataProjectId: env.data.project?.id || null, loading: env.loading }),
    unmount() { env.importSession.current.active = false; env.importSession.current.selection++; env.requestCounter.current++; env.bootGuard.current.deactivate(); env.projectEntryIdentityRef.current.dispose(); },
  };
}
const callsOf = (h:{calls:unknown[][]},name:string)=>h.calls.filter(call=>call[0]===name);

// These production-refresh regressions deliberately need no newly added App
// helper, so the baseline must fail on behavior rather than missing fixture names.
function refreshHarness(options:HomeOptions = {}) {
  const h = environment(options); h.env.currentProject.current = id(1);
  const source = section('  const refresh = useCallback(', '  async function revealImageAsset(');
  (h as typeof h&{refresh:HomeApi['refresh']}).refresh = Function('env', `with (env) { ${source}\nreturn refresh; }`)(h.env) as HomeApi['refresh'];
  return h as typeof h&{refresh:HomeApi['refresh']};
}

test('video directory corruption and network failures keep project startup and local editing available and clear after recovery', async () => {
  for (const code of ['VIDEO_SETTINGS_CORRUPT', 'NETWORK']) {
    let videoError:string|null = code;
    const h = harness({ videoDirectory: async () => { if (videoError) throw failure(videoError); return []; } });
    h.env.window.location.search = `?project=${id(1)}`; await h.boot();
    assert.equal(h.env.auth, true, code); assert.equal(h.eligible(), true, code); assert.equal(h.projectSessionReady(), true, code);
    assert.equal(h.env.videoDirectoryUnavailable, true); assert.equal(h.env.data.project!.id, id(1));
    h.env.viewRef.current.activeMode = 'editing'; h.env.viewRef.current.editing.playhead = 42;
    assert.equal((await h.refresh(id(1)))!.project.id, id(1));
    assert.equal(h.projectSessionReady(), true); assert.equal(h.env.viewRef.current.activeMode, 'editing'); assert.equal(h.env.viewRef.current.editing.playhead, 42);
    assert.equal(h.env.videoDirectoryUnavailable, true);
    videoError = null; assert.equal((await h.refresh(id(1)))!.project.id, id(1));
    assert.equal(h.env.videoDirectoryUnavailable, false); assert.equal(h.eligible(), true);
  }
});

test('stale video directory results cannot publish project data or directory failure state over a newer selection', async () => {
  for (const reject of [false, true]) {
    const held = deferred(); let reads = 0;
    const h = harness({ videoDirectory: () => ++reads === 1 ? held.promise : [] }), old = h.boot(); await tick();
    assert.equal(await h.selectProject(id(2)), true); const count = h.calls.length;
    if (reject) held.reject!(failure('VIDEO_SETTINGS_CORRUPT')); else held.resolve!([]);
    await old; assert.equal(h.calls.length, count); assert.equal(h.env.data.project!.id, id(2));
    assert.equal(h.env.videoDirectoryUnavailable, false); assert.equal(h.eligible(), true);
  }
});

test('video directory authorization failures still log out current startup and project refresh', async () => {
  for (const error of [failure('UNAUTHORIZED'), Object.assign(Error('HTTP 401'), { status: 401 })]) {
    const boot = harness({ videoDirectory: async () => { throw error; } }); await boot.boot();
    assert.equal(boot.env.auth, false); assert.equal(boot.eligible(), false);
    let denied = false; const active = harness({ videoDirectory: async () => { if (denied) throw error; return []; } });
    assert.equal(await active.selectProject(id(1)), true); denied = true;
    assert.equal(await active.refresh(id(1)), null); assert.equal(active.env.auth, false);
  }
});

test('causal regression: actual refresh quarantines wrong-project data before reconciling pending operations', async () => {
  const h = refreshHarness({ get: async () => snapshot(id(2)) });
  await assert.rejects(h.refresh(id(1), false, { opening: true }), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.deepEqual((callsOf(h, 'reconcile') as unknown), []); assert.equal(h.env.data.project, null);
});

test('causal regression: actual refresh cannot publish a response after renderer unmount', async () => {
  const held = deferred(), h = refreshHarness({ get: () => held.promise });
  const pending = h.refresh(id(1), false, { opening: true }); await tick(); h.env.importSession.current.active = false;
  const count = h.calls.length; held.resolve!(snapshot(id(1))); assert.equal(await pending, null);
  assert.equal(h.calls.length, count); assert.deepEqual((callsOf(h, 'reconcile') as unknown), []);
});

test('actual selection keeps home visible after preferences resolve until validated project data settles', async () => {
  const held = deferred(), h = harness({ get: () => held.promise }), pending = h.selectProject(id(1)); await tick();
  assert.equal(h.env.currentProject.current, id(1)); assert.equal(h.env.viewReady.current, true);
  assert.equal(h.env.projectOpening.phase, 'opening'); assert.equal(h.env.loading, true); assert.equal(h.eligible(), false);
  assert.equal(h.env.openedProject.current, null); assert.deepEqual((callsOf(h, 'remember') as unknown), []); assert.deepEqual((callsOf(h, 'tasks.load') as unknown), []);
  held.resolve!(snapshot(id(1))); assert.equal(await pending, true);
  assert.equal(h.env.projectOpening.phase, 'ready'); assert.equal(h.eligible(), true); assert.equal(Object.isFrozen(h.env.openedProject.current), true);
  assert.deepEqual(callsOf(h, 'remember'), []); assert.deepEqual(h.env.openedProject.current, opening.projectOpenAttempt(id(1), 1, 'normal')); assert.deepEqual(callsOf(h, 'tasks.load'), [['tasks.load', id(1)]]);
});

test('actual refresh rejects wrong-project responses before reconciliation or publishing data', async () => {
  const h = harness({ get: async () => snapshot(id(2)) }); assert.equal(await h.selectProject(id(1)), false);
  assert.equal(h.env.projectOpening.phase, 'error'); assert.equal(h.eligible(), false); assert.equal(h.env.auth, true);
  assert.deepEqual((callsOf(h, 'reconcile') as unknown), []); assert.deepEqual((callsOf(h, 'remember') as unknown), []); assert.equal(h.env.data.project, null);
  assert.equal(h.env.loading, false);
});

test('ordinary refresh cannot read or publish before a successful project-open ticket exists', async () => {
  const held = deferred(), h = harness({ get: () => held.promise });
  h.env.currentProject.current = id(1);
  assert.equal(await h.refresh(id(1)), null); assert.deepEqual((callsOf(h, 'rpc') as unknown), []);
  const pending = h.selectProject(id(1)); await tick(); const before = h.calls.length;
  assert.equal(h.env.viewReady.current, true); assert.equal(await h.refresh(id(1)), null); assert.equal(h.calls.length, before);
  held.reject!(Error('load failed')); assert.equal(await pending, false); const failedCount = h.calls.length;
  assert.equal(await h.refresh(id(1)), null); assert.equal(h.calls.length, failedCount); assert.equal(h.eligible(), false);
});

test('same-project data without an accepted opening ticket must take the real load path', async () => {
  const h = harness(); h.env.currentProject.current = id(1); h.env.data = h.env.dataRef.current = snapshot(id(1)); h.env.viewReady.current = true;
  assert.equal(h.projectSessionReady(), false); assert.equal(await h.selectProject(id(1)), true);
  assert.equal(callsOf(h, 'preferences').length, 1); assert.equal(h.env.projectEpoch.current, 1); assert.equal(h.eligible(), true);
  assert.deepEqual(callsOf(h, 'remember'), []); assert.equal(h.env.openedProject.current?.projectId, id(1));
});

for (const code of ['UNAUTHORIZED', 'LAST_PROJECT_SCOPE_MISMATCH', 'LAST_PROJECT_STALE_INSTANCE', 'PROJECT_ENTRY_SCOPE_MISMATCH', 'PROJECT_ENTRY_STALE_INSTANCE']) {
  test(`actual selection preserves ${code} routing from project load and preference fallback`, async () => {
    for (const options of [{ get: async () => { throw failure(code); } }, { preferenceStatus: { phase: 'local', error: failure(code) } }]) {
      const h = harness(options); assert.equal(await h.selectProject(id(1)), false);
      assert.equal(h.env.auth, code === 'UNAUTHORIZED' ? false : 'error'); assert.equal(h.eligible(), false);
      assert.equal(h.env.openedProject.current, null); assert.deepEqual((callsOf(h, 'remember') as unknown), []); assert.deepEqual((callsOf(h, 'tasks.load') as unknown), []);
    }
  });
}

test('slow A and late A failure cannot overwrite a faster B selection', async () => {
  for (const reject of [false, true]) {
    const held = deferred(), h = harness({ get: (projectId: string) => projectId === id(1) ? held.promise : snapshot(projectId) });
    const old = h.selectProject(id(1)); await tick(); assert.equal(await h.selectProject(id(2)), true);
    const before = h.calls.length; if (reject) held.reject!(failure('UNAUTHORIZED')); else held.resolve!(snapshot(id(1)));
    assert.equal(await old, false); assert.equal(h.calls.length, before); assert.equal(h.env.data.project!.id, id(2));
    assert.equal(h.env.projectOpening.projectId, id(2)); assert.equal(h.env.auth, true); assert.equal(h.eligible(), true);
    assert.deepEqual(callsOf(h, 'remember'), []); assert.equal(h.env.openedProject.current?.projectId, id(2));
  }
});

test('same-ID reopen is a new epoch and the first response cannot publish its ticket', async () => {
  const first = deferred(), second = deferred(); let reads = 0;
  const h = harness({ get: () => ++reads === 1 ? first.promise : second.promise });
  const old = h.selectProject(id(1)); await tick(); const next = h.selectProject(id(1)); await tick();
  second.resolve!(snapshot(id(1))); assert.equal(await next, true); const ticket = h.env.openedProject.current, count = h.calls.length;
  first.resolve!(snapshot(id(1))); assert.equal(await old, false); assert.equal(h.env.openedProject.current, ticket);
  assert.equal(ticket!.epoch, 2); assert.equal(h.calls.length, count); assert.deepEqual(callsOf(h, 'remember'), []); assert.equal(h.env.openedProject.current?.epoch, 2);
});

test('unmount rejects late successful and failed project loads without publishing or reconciling', async () => {
  for (const reject of [false, true]) {
    const held = deferred(), h = harness({ get: () => held.promise }), pending = h.selectProject(id(1)); await tick();
    h.unmount(); const count = h.calls.length;
    if (reject) held.reject!(failure('UNAUTHORIZED')); else held.resolve!(snapshot(id(1)));
    assert.equal(await pending, false); assert.equal(h.calls.length, count); assert.equal(h.env.data.project, null);
    assert.equal(h.env.openedProject.current, null); assert.deepEqual((callsOf(h, 'reconcile') as unknown), []);
  }
});

test('workspace replacement prevents a delayed response from reconciling or exposing the workbench', async () => {
  for (const reject of [false, true]) {
    const held = deferred(), h = harness({ get: () => held.promise }), pending = h.selectProject(id(1)); await tick();
    h.env.editorSession.current = 'another-renderer-session'; const count = h.calls.length;
    if (reject) held.reject!(failure('UNAUTHORIZED')); else held.resolve!(snapshot(id(1)));
    assert.equal(await pending, false); assert.equal(h.eligible(), false); assert.equal(h.calls.length, count);
    assert.deepEqual((callsOf(h, 'reconcile') as unknown), []); assert.deepEqual((callsOf(h, 'remember') as unknown), []); assert.equal(h.env.data.project, null);
  }
});

test('settings cancellation and newer input during confirmation leave the same home and project', async () => {
  for (const newerInput of [false, true]) {
    const answer = deferred(), h = harness({ confirm: () => answer.promise }); h.env.homePage = 'settings';
    const owner = h.registry.register('home:agent'); owner.update({ dirty: true, busy: false, blocked: false, version: 1 });
    const pending = h.selectProject(id(1)); await tick();
    if (newerInput) owner.update({ dirty: true, busy: false, blocked: false, version: 2 }); answer.resolve!(newerInput);
    assert.equal(await pending, false); assert.equal(h.env.homePage, 'settings'); assert.equal(h.env.currentProject.current, null);
    assert.equal(h.env.projectEpoch.current, 0); assert.deepEqual((callsOf(h, 'rpc') as unknown), []); assert.deepEqual((callsOf(h, 'preferences') as unknown), []);
  }
});

test('busy or unresolved settings block open, create, and leaving settings without confirmation or RPC', async () => {
  for (const state of [{ dirty: true, busy: true, blocked: false }, { dirty: false, busy: false, blocked: true }]) {
    const h = harness(); h.env.homePage = 'settings'; const owner = h.registry.register('home:custom'); owner.update({ ...state, version: 1 });
    assert.equal(await h.selectProject(id(1)), false); assert.equal(await h.createProject('新项目', ''), false);
    await h.changeHomePage('projects'); assert.equal(h.env.homePage, 'settings'); assert.equal(h.env.currentProject.current, null);
    assert.deepEqual((callsOf(h, 'confirm') as unknown), []); assert.deepEqual((callsOf(h, 'rpc') as unknown), []); assert.deepEqual((callsOf(h, 'run') as unknown), []);
  }
});

test('new settings input during the ordinary project guard invalidates the departure ticket', async () => {
  const guard = deferred(), h = harness({ guard: () => guard.promise }), owner = h.registry.register('home:official');
  owner.update({ dirty: true, busy: false, blocked: false, version: 1 }); const pending = h.selectProject(id(1)); await tick();
  owner.update({ dirty: true, busy: false, blocked: false, version: 2 }); guard.resolve!(true);
  assert.equal(await pending, false); assert.equal(h.env.currentProject.current, null); assert.deepEqual((callsOf(h, 'rpc') as unknown), []);
});

test('selection checks fresh membership and pinned directory identity after the draft guard before preferences or navigation', async () => {
  for (const replacement of [projectEntryFixture([projects[0]!]), projectEntryFixture(projects, {instanceId: id(8)}), projectEntryFixture(projects, {appLibraryScope: 'b'.repeat(64)})]) {
    let directory = projectEntryFixture(projects);
    const h = harness({directory: () => directory, guard: current => {directory = replacement; return current();}});
    await readProjectEntryIdentity(h.env.projectEntryIdentityRef.current);
    h.env.currentProject.current = id(1); h.env.data = h.env.dataRef.current = snapshot(id(1));
    h.env.viewReady.current = true; h.env.openedProject.current = opening.projectOpenAttempt(id(1), 0, 'normal');
    h.env.projectOpening = {phase: 'ready', projectId: id(1), error: ''};
    const before = h.env.dataRef.current; h.calls.length = 0;
    assert.equal(await h.selectProject(id(2)), false);
    assert.deepEqual(callsOf(h, 'directory'), [['directory', '/api/project-entries', 'GET']]);
    for (const effect of ['rpc', 'preferences', 'flush', 'pushState', 'replaceState', 'tasks.load']) assert.deepEqual(callsOf(h, effect), [], effect);
    assert.equal(h.env.currentProject.current, id(1)); assert.equal(h.env.projectEpoch.current, 0); assert.equal(h.env.navigationEpoch.current, 0);
    assert.equal(h.env.dataRef.current, before);
    assert.equal(h.env.projectEntryIdentityRef.current.getState().identityBlocked, replacement.registered.length !== 1);
  }
});

test('creation preflight failure dispatches no mutation, preserves navigation and releases only its own synchronous latch', async () => {
  const h = harness({directory: () => {throw Error('Directory unavailable before dispatch');}});
  assert.equal(await h.createProject('保留的名称', '保留的输入'), false);
  assert.deepEqual(callsOf(h, 'directory'), [['directory', '/api/project-entries', 'GET']]);
  for (const effect of ['run', 'rpc', 'preferences', 'flush', 'pushState', 'replaceState']) assert.deepEqual(callsOf(h, effect), [], effect);
  assert.equal(h.env.currentProject.current, null); assert.equal(h.env.projectEpoch.current, 0); assert.equal(h.env.navigationEpoch.current, 0);
  assert.equal(h.env.projectCreateFlight.current, null); assert.equal(h.env.busy['project-create-flow'], false);
  assert.doesNotMatch(renderCoreMessage('zh-Hans', h.env.projectListStatus.error), /可能已创建/u);
});

test('a late directory check cannot load preferences or create after its renderer navigation owner changes', async () => {
  for (const operation of ['open', 'create']) {
    const held = deferred(), h = harness({directory: () => held.promise});
    const pending = operation === 'open' ? h.selectProject(id(1)) : h.createProject('新项目', ''); await tick();
    h.env.navigationEpoch.current++; h.env.currentProject.current = id(2); const before = h.calls.length;
    held.resolve!(projectEntryFixture(projects)); assert.equal(await pending, false);
    assert.deepEqual(h.calls.slice(before), operation === 'create' ? [['markBusy', null, 'project-create-flow', false]] : []);
    for (const effect of ['run', 'preferences', 'pushState', 'replaceState']) assert.deepEqual(callsOf(h, effect), [], effect);
    assert.equal(h.env.currentProject.current, id(2)); assert.equal(h.env.projectEpoch.current, 0);
  }
});

test('late create completion cannot steal newer navigation and never repeats the create request', async () => {
  const held = deferred(), h = harness({ create: () => held.promise }), pending = h.createProject('新项目', '简述'); await tick();
  assert.equal(callsOf(h, 'run').length, 1); assert.equal(await h.selectProject(id(2)), true); const count = h.calls.length;
  held.resolve!({ id: id(3) }); assert.equal(await pending, false);
  assert.deepEqual(h.calls.slice(count), [['markBusy', null, 'project-create-flow', false]]);
  assert.equal(h.env.currentProject.current, id(2)); assert.equal(callsOf(h, 'run').length, 1);
});

test('create acknowledgements and list responses cannot publish after unmount or a new renderer lifetime', async () => {
  for (const phase of ['ack', 'list']) for (const reactivate of [false, true]) {
    const held = deferred();let reads=0;
    const h = harness(phase === 'ack' ? { create: () => held.promise } : { directory: () => ++reads===1?projectEntryFixture(projects):held.promise });
    const pending = h.createProject('新项目', ''); await tick(); assert.equal(callsOf(h, 'run').length, 1);
    h.unmount(); if (reactivate) { h.env.importSession.current.active = true; h.env.bootGuard.current.activate(); }
    const count = h.calls.length; held.resolve!(phase === 'ack' ? { id: id(3) } : projectEntryFixture([...projects, {id:id(3)}]));
    assert.equal(await pending, false); assert.equal(h.calls.length, count, `${phase}; reactivate=${reactivate}`);
    assert.equal(h.env.currentProject.current, null); assert.equal(h.env.projectCreateFlight.current, null);
    assert.deepEqual((callsOf(h, 'preferences') as unknown), []); assert.equal(callsOf(h, 'run').length, 1);
  }
});

test('create with failed list read keeps uncertainty visible and does not retry mutation automatically', async () => {
  let reads=0;const h = harness({ directory: () => {if(++reads===1)return projectEntryFixture(projects);throw Error('directory unavailable');} });
  assert.equal(await h.createProject('新项目', ''), false); await tick();
  assert.equal(callsOf(h, 'run').length, 1); assert.equal(h.env.currentProject.current, null);
  assert.match(renderCoreMessage('zh-Hans', h.env.projectListStatus.error), /可能已创建/); assert.match(renderCoreMessage('zh-Hans', h.env.projectListStatus.error), /不要直接重复创建/);
});

test('create holds its synchronous latch through the post-acknowledgement project-list read', async () => {
  const listed = deferred();let reads=0;const h = harness({ directory: () => ++reads===1?projectEntryFixture(projects):listed.promise });
  const pending = h.createProject('新项目', '');
  assert.equal(await h.createProject('立即重复', ''), false); await tick();
  assert.equal(callsOf(h, 'run').length, 1); assert.ok(h.env.projectCreateFlight.current); assert.equal(h.env.busy['project-create-flow'], true);
  assert.equal(await h.createProject('ACK 后重复', ''), false); assert.equal(callsOf(h, 'run').length, 1);
  listed.resolve!(projectEntryFixture([...projects, {id:id(3)}])); assert.equal(await pending, true);
  assert.equal(h.env.projectCreateFlight.current, null); assert.equal(h.env.currentProject.current, id(3)); assert.equal(h.eligible(), true);
  assert.equal(callsOf(h, 'run').length, 1);
});

test('actual empty startup chooses home while explicit startup succeeds without rewriting the locator', async () => {
  const h = harness({ directory: () => projectEntryFixture([]) });
  await h.boot(); assert.equal(h.env.auth, true); assert.equal(h.env.projectOpening.phase, 'home'); assert.equal(h.eligible(), false);
  assert.deepEqual((callsOf(h, 'preferences') as unknown), []); assert.deepEqual((callsOf(h, 'remember') as unknown), []);
  const selected = harness(); selected.env.window.location.search = `?project=${id(2)}`; await selected.boot();
  assert.equal(selected.env.data.project!.id, id(2)); assert.equal(selected.eligible(), true); assert.deepEqual((callsOf(selected, 'remember') as unknown), []);
  assert.equal(callsOf(selected, 'replaceState').length, 1);
});

test('nonempty startup without a project URL never reads project contents, and has no retired last-project state', async () => {
  const h = harness({ get() {assert.fail('A home startup must not call project.get.');}});
  await h.boot();
  assert.deepEqual(h.env.projects, projects);assert.equal('lastProjectRef' in h.env,false);assert.deepEqual(callsOf(h,'directory'),[['directory','/api/project-entries','GET']]);assert.equal(h.env.projectEntryIdentityRef.current.getVerifiedScope(),PROJECT_ENTRY_TEST_SCOPE); assert.equal(h.env.projectOpening.phase, 'home'); assert.equal(h.env.currentProject.current, null);
  assert.equal(h.env.data.project, null); assert.equal(h.eligible(), false);
  assert.deepEqual(callsOf(h, 'rpc').filter(call => call[1] === 'project.get'), []);
  for (const action of ['preferences', 'tasks.load', 'remember', 'replaceState', 'pushState']) assert.deepEqual(callsOf(h, action), [], action);
  assert.doesNotMatch(app, /\blastProjectRef\b|\blastProjectStatus\b|\bLastProjectStatus\b|\bcreateLastProjectController\b|\/api\/last-project/u);
});

test('an explicit unavailable project stays on home and never opens the first listed project', async () => {
  const h = harness({ get() {assert.fail('An unavailable URL must not open another project.');}});
  h.env.window.location.search = `?project=${id(3)}`; await h.boot();
  assert.equal(h.env.projectOpening.phase, 'home'); assert.equal(h.env.currentProject.current, null); assert.equal(h.eligible(), false);
  assert.deepEqual(callsOf(h, 'rpc').filter(call => call[1] === 'project.get'), []);
  assert.deepEqual(callsOf(h, 'notice'), [['notice', msg('projects.bootMissingEmpty'), 'error']]);
  assert.deepEqual(callsOf(h, 'remember'), []); assert.deepEqual(callsOf(h, 'replaceState'), []);
});


function nativeEditor(projectId: string) {
  return { context: { version: 2, role: 'editor', windowId: id(7), contextId: id(8), backendId: id(9), initialProjectId: projectId,
    autoOpen: false, editorProjectId: projectId, editorPhase: 'opening', editorCount: 1, entryMode: null, entryVersion: 0, entryReceipt: null,
    settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false },
    bridge: { editorStatus: async () => true, showProjects: async () => true } };
}

test('native startup opens only the host-assigned UUID, regardless of URL or first project', async () => {
  const binding = nativeEditor(id(3));
  const h = harness({ nativeWindow: binding });
  h.env.window.location.search = `?project=${id(1)}`;
  await h.boot();
  assert.equal(h.env.auth, true); assert.equal(h.env.data.project!.id, id(3)); assert.equal(h.eligible(), true);
  assert.deepEqual(callsOf(h, 'rpc').filter(call => call[1] === 'project.get').map(call => (call[2] as {projectId:string}).projectId), [id(3)]);
  assert.deepEqual(callsOf(h, 'preferences').map((call: unknown[]) => call[1]), [id(3)]);
  assert.deepEqual((callsOf(h, 'remember') as unknown), []);
});

test('native assigned-project failure stays on that UUID and never falls through to another project', async () => {
  const h = harness({ nativeWindow: nativeEditor(id(3)), get: async () => { throw failure('NOT_FOUND'); } });
  h.env.window.location.search = `?project=${id(1)}`; await h.boot();
  assert.equal(h.env.projectOpening.phase, 'error'); assert.equal(h.env.projectOpening.projectId, id(3));
  assert.equal(h.env.data.project, null); assert.equal(h.eligible(), false);
  assert.deepEqual(callsOf(h, 'rpc').filter(call => call[1] === 'project.get').map(call => (call[2] as {projectId:string}).projectId), [id(3)]);
  assert.deepEqual((callsOf(h, 'remember') as unknown), []); assert.deepEqual((callsOf(h, 'tasks.load') as unknown), []);
});

test('native invalid assignment cannot borrow a valid Web fallback', async () => {
  const h = harness({ nativeWindow: nativeEditor('invalid-project-id') });
  h.env.window.location.search = `?project=${id(1)}`; await h.boot();
  assert.equal(h.env.auth, 'error'); assert.equal(h.env.data.project, null); assert.equal(h.eligible(), false);
  assert.deepEqual((callsOf(h, 'preferences') as unknown), []); assert.deepEqual((callsOf(h, 'rpc').filter(call => call[1] === 'project.get') as unknown), []);
});

test('late boot discovery cannot select over a newer project or publish after unmount', async () => {
  for (const unmount of [false, true]) {
    const held = deferred();let reads=0;const h = harness({ directory: () => ++reads===1?held.promise:projectEntryFixture(projects) }), pending = h.boot(); await tick();
    if (unmount) h.unmount(); else {await h.env.projectEntryIdentityRef.current.refresh();assert.equal(await h.selectProject(id(2)), true);}
    const count = h.calls.length; held.resolve!(projectEntryFixture(projects)); await pending;
    assert.equal(h.calls.length, count); assert.equal(h.env.currentProject.current, unmount ? null : id(2));
  }
});

let builtHomeUi: HomeUi | undefined;
function homeUi(): HomeUi {
  if (builtHomeUi) return builtHomeUi;
  const fixture = `import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import ProjectHome from './src/ProjectHomeDirectoryScreen.tsx';
    import {ProjectMediaProvider} from './src/project-media-read-gate.tsx';
    import ProjectEntryIdentityStatus from './src/ProjectEntryIdentityStatus.tsx';
    import ProjectHistoryDialog from './src/project-file/ProjectHistoryDialog.tsx';
    import ProjectBackupRecovery, { canOfferBackupRecovery } from './src/ProjectBackupRecovery.tsx';
    import ProjectHomeConnections from './src/ProjectHomeConnections.tsx';
    import EditorWindowOpening from './src/EditorWindowOpening.tsx';
    import SettingsNavigationSlot from './src/SettingsNavigationSlot.tsx';
    import WebSettingsCenter from './src/WebSettingsCenter.tsx';
    import { ConfirmationProvider } from '@mioon/ui/components/workbench-confirm';
    import { Button } from '@mioon/ui/components/button';
    export { React, renderToStaticMarkup, ProjectHome, ProjectHomeConnections, EditorWindowOpening, SettingsNavigationSlot, ProjectMediaProvider, ProjectEntryIdentityStatus, WebSettingsCenter, ConfirmationProvider, Button, ProjectHistoryDialog, ProjectBackupRecovery, canOfferBackupRecovery };`;
  const result = buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: join(root, 'apps/web') }, bundle: true, platform: 'node', format: 'cjs',
    write: false, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const module = {exports:{}} as {exports:HomeUi}; Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return builtHomeUi = module.exports;
}

let presentation:((h:HomeHarness)=>{html:string;mounted:string[];sourceTree():unknown})|undefined;
function boundaryRenderer() {
  if (presentation) return presentation;
  const start = app.indexOf('  if (auth === false && !retainWorkbenchForClip && !retainWorkbenchForIdentity && !retainSettingsForIdentity) return <Login');
  const workbench = app.indexOf('  return <ProjectMediaProvider media={projectMedia}>', start);
  const openingEnd = app.indexOf('>\n', workbench);
  assert.ok(start >= 0 && workbench > start && openingEnd > workbench, 'Actual App render boundaries must exist');
  // Mount the complete, unmodified home/auth branch with real ProjectHome,
  // connection navigation and shared controls. The successful boundary retains
  // App's actual provider, settings/identity-alert siblings and outer workbench
  // element; full workbench internals are outside
  // this focused fixture, rather than replaced by a generic permissive proxy.
  const readiness = section('  const workbenchReady =', '  function readProjectMediaOwner()') + section('  useEditorWindowStatus(', '  const panelSurface =') + section('  const retainWorkbenchForIdentity =', '  const staleClips =');
  const renderSource = readiness + section('  const historyLayer =', '  if (auth === false && !retainWorkbenchForClip') + app.slice(start, workbench) + app.slice(workbench, openingEnd + 1) + '</main></ProjectMediaProvider>;';
  const ui = homeUi();
  const body = transformSync(`function renderBoundary() { ${renderSource} }`, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code;
  presentation = (h:HomeHarness) => {
    const mounted: string[] = [];
    const stub = (name: string) => () => { mounted.push(name); return ui.React.createElement('section', { 'data-stub': name }); };
    const env = { LanguageControl: () => null, renderImportFeedback: (locale: string, value: string|i18nCore.DisplayMessage|null|undefined) => renderCoreMessage((locale as unknown as Parameters<typeof renderCoreMessage>[0]), value), msg, ...createI18nTestContext(), localizedError: (displayMessage: string|i18nCore.DisplayMessage|null|undefined) => Object.assign(new Error(renderCoreMessage('zh-Hans', displayMessage)), { displayMessage }), ...h.env, ...h, ...ui,  workspace: h.env.workspaceRef.current,
      projectMedia: null, setHomeConnection() {}, geometry: { narrow: false, style: {} }, workspaceMode: 'canvas', mobilePanel: 'canvas',
      assetsCollapsed: false, inspectorCollapsed: false, timelineCollapsed: false,
      Icon: () => null, BrandMark: () => null, Login: stub('Login'), RestoredUnavailable: stub('RestoredUnavailable'),
      AgentSettings: stub('AgentSettings'), ImageSettings: stub('ImageSettings'), ComfyImageSettings: stub('ComfyImageSettings'),
      SettingsConnectionForms: stub('SettingsConnectionForms'),
      AgentDockPane: ({ children }:{children?:import("react").ReactNode}) => ui.React.createElement('div', null, children),
      TaskCenter: stub('TaskCenter'), AgentPanel: stub('AgentPanel'), ImageGeneration: stub('ImageGeneration'),
    };
    const render = Function('env', `with (env) { ${body}; return renderBoundary; }`)(env);
    return { html: ui.renderToStaticMarkup(ui.React.createElement(ui.ConfirmationProvider, null, ui.React.createElement(render as import("react").ComponentType))), mounted, sourceTree: () => (render as ()=>unknown)() };
  };
  return presentation;
}

test('actual App renders standalone home, routes settings to the retained center, and exposes workbench only after success', async () => {
  const render = boundaryRenderer(), h = harness();
  assert.match(app, /import ProjectHome from '\.\/ProjectHomeDirectoryScreen\.tsx'/);
  for (const phase of ['home', 'opening', 'error']) {
    h.env.projectOpening = { phase, projectId: id(1), error: phase === 'error' ? '读取失败' : '' };
    const { html, mounted } = render(h); assert.match(html, /data-testid="project-home"/); assert.match(html, new RegExp(`data-phase="${phase}"`));
    assert.match(html, /data-testid="pf-home-loading"/);
    assert.doesNotMatch(html, /data-testid="project-home-open-/);
    assert.doesNotMatch(html, /data-testid="workbench"|task-workspace|react-flow|inspector-region/); assert.deepEqual((mounted as unknown), []);
  }
  await h.changeHomePage('settings');
  assert.equal(h.env.webSettingsRequest!.page, 'general'); assert.equal(typeof h.env.webSettingsRequest!.resolve, 'function'); assert.equal(h.env.homePage, 'projects');
  const settings = render(h); assert.match(settings.html, /data-testid="project-home"/); assert.deepEqual((settings.mounted as unknown), []);
  assert.doesNotMatch(settings.html, /data-testid="workbench"|agent-settings-page|image-settings-page/u, 'Settings are no longer nested inside project-home');
  for (const forbidden of ['TaskCenter', 'AgentPanel', 'ImageGeneration']) assert.equal(settings.mounted.includes(forbidden), false);
  h.env.homePage = 'projects'; assert.equal(await h.selectProject(id(1)), true);
  const ready = render(h); assert.match(ready.html, /<main[^>]+data-testid="workbench"/); assert.doesNotMatch(ready.html, /data-testid="project-home"/);
});

test('actual auth branches retain their existing protections', () => {
  const render = boundaryRenderer(), h = harness(); h.env.auth = false;
  assert.deepEqual(render(h).mounted, ['Login']); assert.doesNotMatch(render(h).html, /data-testid="project-home"|data-testid="workbench"/);
  h.env.auth = 'error'; const failed = render(h); assert.match(failed.html, /暂时无法连接工作台/); assert.doesNotMatch(failed.html, /data-testid="workbench"/);

});

test('identity-blocked dirty home settings retain the keyed settings shell without mounting a workbench or login', async () => {
  let directory = projectEntryFixture(projects);
  const h = harness({directory: () => directory}); await h.boot();
  void h.openGlobalSettings('general'); h.env.webSettingsOpen = true;
  const request = h.env.webSettingsRequest;
  const settingsOwner = h.registry.register('home:secret-input'); settingsOwner.update({dirty:true,busy:false,blocked:true,version:1});
  directory = projectEntryFixture(projects,{instanceId:id(8)}); await h.env.projectEntryIdentityRef.current.refresh();
  assert.equal(await h.selectProject(id(1)),false);
  assert.equal(h.env.currentProject.current,null); assert.equal(h.env.viewReady.current,false); assert.equal(h.env.retainWorkbenchForClip,false);
  const elements = (value:unknown): {key?:unknown;props?:Record<string,unknown>}[] => {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!value || typeof value !== 'object') return [];
    const node = value as {key?:unknown;props?:Record<string,unknown>}; return [node,...elements(node.props?.children)];
  };
  const render = boundaryRenderer();
  for (const auth of [true,false,null,'error'] as const) {
    h.env.auth = auth; const result = render(h), nodes = elements(result.sourceTree());
    assert.match(result.html,/data-testid="project-home"/u);
    assert.doesNotMatch(result.html,/data-testid="workbench"|data-testid="editor-window-opening"|class="boot-page"/u);
    assert.equal(result.mounted.includes('Login'),false);
    const shell = nodes.find(node=>node.key==='global-settings-center'); assert.ok(shell);
    assert.equal(shell.props?.request,request); assert.equal(shell.props?.registry,h.registry);
    assert.equal(shell.props?.interactionBlocked,true);
    assert.equal(nodes.find(node=>node.props?.onCreate===h.createProject)?.props?.active,false);
    assert.equal(h.env.webSettingsRequest,request); assert.equal(h.env.webSettingsOpen,true); assert.equal(h.env.projectCreateFlight.current,null);
  }
  for (const effect of ['preferences','run','pushState','replaceState']) assert.deepEqual(callsOf(h,effect),[],effect);
  // The separate retention requires an open settings shell. A closed shell
  // still takes the existing authentication failure branch without a project.
  h.env.webSettingsOpen = false; h.env.auth = 'error';
  assert.match(render(h).html,/暂时无法连接工作台/u);
});

test('a pinned identity block preserves the loaded workbench and inputs behind inert with a separate alert in every early-return branch', async () => {
  for (const nativeWindow of [null, nativeEditor(id(1))]) {
    let directory = projectEntryFixture(projects);
    const h = harness({nativeWindow, directory: () => directory}); assert.equal(await h.selectProject(id(1)), true);
    const loaded = h.env.dataRef.current, view = h.env.viewRef.current, ticket = h.env.openedProject.current;
    h.env.agentDraft = {current: true}; h.env.imageDraft = {current: true};
    directory = projectEntryFixture(projects, {instanceId: id(8)}); await h.env.projectEntryIdentityRef.current.refresh();
    assert.equal(h.env.projectEntryIdentityRef.current.getState().identityBlocked, true); assert.equal(h.projectSessionReady(), false);
    const render = boundaryRenderer();
    for (const auth of [true, false, null, 'error'] as const) {
      h.env.auth = auth; const result = render(h);
      assert.match(result.html, /<main\b[^>]*\binert=""[^>]*data-testid="workbench"/u);
      assert.match(result.html, /role="alert" data-testid="project-entry-identity-blocked"/u);
      assert.ok(result.html.indexOf('project-entry-identity-blocked') < result.html.indexOf('<main'), 'The alert remains outside the inert workbench');
      assert.doesNotMatch(result.html, /data-testid="project-home"|data-testid="editor-window-opening"|class="boot-page"/u);
      assert.deepEqual(result.mounted, []); assert.equal(h.env.retainWorkbenchForClip, false);
      assert.equal(h.env.dataRef.current, loaded); assert.equal(h.env.viewRef.current, view); assert.equal(h.env.openedProject.current, ticket);
      assert.deepEqual(h.env.agentDraft, {current: true}); assert.deepEqual(h.env.imageDraft, {current: true});
    }
    // A blocked identity alone cannot mount a workbench without a loaded owner.
    h.env.auth = true; h.env.viewReady.current = false;
    const unloaded = render(h).html;
    assert.doesNotMatch(unloaded, /data-testid="workbench"|data-testid="project-entry-identity-blocked"/u);
  }
});

test('identity retention blocks all actual captured input events while the independent clip exceptions remain intact', () => {
  const source = section('  const guardRetainedInputInteraction =', '  function imageEditScope()');
  const guard = (env: Record<string,unknown>) => Function('env', `with (env) {${source}\nreturn guardRetainedInputInteraction;}`)(env) as (event:unknown)=>void;
  for (const retainedTarget of [false, true]) {
    const blocked: string[] = [], event = {target: {closest: () => retainedTarget}, preventDefault: () => blocked.push('prevent'), stopPropagation: () => blocked.push('stop')};
    guard({retainWorkbenchForIdentity:true, retainWorkbenchForClip:false, clipConnectionBlocked:{current:false}})(event);
    assert.deepEqual(blocked, ['prevent', 'stop']);
    blocked.length = 0;
    guard({retainWorkbenchForIdentity:false, retainWorkbenchForClip:true, clipConnectionBlocked:{current:true}})(event);
    assert.deepEqual(blocked, retainedTarget ? [] : ['prevent', 'stop']);
    blocked.length = 0;
    guard({retainWorkbenchForIdentity:false, retainWorkbenchForClip:false, clipConnectionBlocked:{current:false}})(event);
    assert.deepEqual(blocked, []);
  }
});

test('an already captured run dispatcher cannot send session, durable or replay mutations after the directory identity blocks', async () => {
  let directory = projectEntryFixture(projects);
  const h = harness({directory: () => directory}); await readProjectEntryIdentity(h.env.projectEntryIdentityRef.current);
  const dispatches: string[] = [], env = {...h.env, clipConnectionBlocked: {current:false},
    captureTaskWorkspaceIntent: () => null, readTaskRevealContext: () => null, isDurableEditOperation: (operation:string) => operation === 'shot.update',
    runDurable: () => {dispatches.push('durable'); return 'durable';}, runSession: () => {dispatches.push('session'); return 'session';}};
  const source = section('  async function run(', '  async function runDurable(');
  const run = Function('env', `with (env) {${source}\nreturn run;}`)(env) as (...args:unknown[])=>Promise<unknown>;
  assert.equal(await run('edit','shot.update',{}), 'durable'); assert.deepEqual(dispatches,['durable']); dispatches.length = 0;
  directory = projectEntryFixture(projects,{instanceId:id(8)}); await h.env.projectEntryIdentityRef.current.refresh();
  for (const [operation, options] of [['shot.update',{}],['shot.create',{}],['shot.update',{replay:true}]] as const) assert.equal(await run('stale',operation,{},undefined,options),null);
  assert.deepEqual(dispatches,[]);
});

test('actual home keeps optional video directory failure visible across toast changes and clears it on recovery', async () => {
  let unavailable = true;
  const h = harness({ videoDirectory: async () => { if (unavailable) throw failure('VIDEO_SETTINGS_CORRUPT'); return []; }, rpc: async (operation: string) => [] });
  await h.boot(); assert.equal(h.env.auth, true); assert.equal(h.env.videoDirectoryUnavailable, true);
  const render = boundaryRenderer();
  for (const locale of i18nCore.LOCALES) {
    Object.assign(h.env, createI18nTestContext(locale)); h.env.toast = null;
    const shown = render(h).html;
    assert.match(shown, /data-testid="video-directory-unavailable"/);
    assert.ok(shown.includes(i18nCore.translate(locale, 'video.providers.directoryUnavailableHint')));
  }
  unavailable = false; await h.boot();
  assert.equal(h.env.videoDirectoryUnavailable, false); assert.doesNotMatch(render(h).html, /data-testid="video-directory-unavailable"/);
});

test('actual App shares authenticated settled project readiness between workbench display and geometry observation', async () => {
  // Media has a separate owner test; retain the actual opening gate, window
  // status and geometry wiring without invoking its independent hook here.
  const wiring = section('  function projectSessionReady()', '  function readProjectMediaOwner()') + section('  useEditorWindowStatus(', '  const markPanelIntent =');
  const render = boundaryRenderer();
  const cases:[string,(env:HomeEnvironment)=>void,boolean][] = [
    ['validated project', () => {}, true],
    ['unverified directory', (env:HomeEnvironment)=>{env.projectEntryIdentityRef.current.dispose();env.projectEntryIdentityRef.current=projectEntryOwnerFixture(()=>projectEntryFixture(projects));}, false],
    ['no accepted ticket', (env: HomeEnvironment) => { env.openedProject.current = null; }, false],
    ['preferences pending', (env: HomeEnvironment) => { env.viewReady.current = false; }, false],
    ['project data missing', (env: HomeEnvironment) => { env.data = env.dataRef.current = emptyData; }, false],
    ['different loaded project', (env: HomeEnvironment) => { env.data = env.dataRef.current = snapshot(id(2)); }, false],
    ['new selection epoch', (env: HomeEnvironment) => { env.projectEpoch.current++; }, false],
    ['changed workspace', (env: HomeEnvironment) => { env.editorSession.current = 'another-renderer-session'; }, false],
    ['inactive renderer', (env: HomeEnvironment) => { env.importSession.current.active = false; }, false],
    ['load still active', (env: HomeEnvironment) => { env.loading = true; }, false],
    ['logged out', (env: HomeEnvironment) => { env.auth = false; }, false],
    ['authentication pending', (env: HomeEnvironment) => { env.auth = null; }, false],
    ['connection blocked', (env: HomeEnvironment) => { env.auth = 'error'; }, false],
  ];
  for (const [label, change, expected] of cases) {
    const h = harness(), observations: unknown[][] = [], modeLayout = defaultWorkspaceState().layout.canvas;
    h.env.currentProject.current = id(1); h.env.projectEpoch.current = 1;
    h.env.openedProject.current = opening.projectOpenAttempt(id(1), 1, 'normal'); h.env.viewReady.current = true;
    h.env.data = h.env.dataRef.current = snapshot(id(1));await readProjectEntryIdentity(h.env.projectEntryIdentityRef.current); change(h.env);
    const env = { LanguageControl: () => null, renderImportFeedback: (locale: string, value: string|i18nCore.DisplayMessage|null|undefined) => renderCoreMessage((locale as unknown as Parameters<typeof renderCoreMessage>[0]), value), msg, ...createI18nTestContext(), localizedError: (displayMessage: string|i18nCore.DisplayMessage|null|undefined) => Object.assign(new Error(renderCoreMessage('zh-Hans', displayMessage)), { displayMessage }), ...h.env, modeLayout, workspaceMode: 'canvas',
      useRef: (initial: unknown) => ({ current: initial }), useState: (initial: unknown) => [initial, () => {}],
      usePanelGeometry: (...args: unknown[]) => { observations.push(args); return { narrow: false, style: {}, effective: modeLayout }; },
    };
    const result = Function('env', `with (env) { ${wiring}\nreturn { workbenchReady, geometry }; }`)(env);
    assert.equal(observations.length, 1, label);
    assert.equal((observations[0][0] as {current:unknown}).current, null, `${label}: surface has not mounted yet`);
    assert.equal(observations[0][1], modeLayout); assert.equal(observations[0][2], 'canvas');
    assert.equal((result as {workbenchReady:boolean}).workbenchReady, expected, label);
    assert.equal(observations[0][4], expected, `${label}: geometry must use the full opening gate`);
    assert.equal(render(h).html.includes('data-testid="workbench"'), expected, `${label}: display and observation readiness must agree`);
  }
});


test('native pending/error render never mounts launcher home or settings in the editor owner', () => {
  const render = boundaryRenderer(), h = harness({ nativeWindow: nativeEditor(id(3)) });
  h.env.homePage = 'settings';
  for (const phase of ['opening', 'error']) {
    h.env.currentProject.current = id(3); h.env.projectOpening = { phase, projectId: id(3), error: phase === 'error' ? '读取失败' : '' };
    const result = render(h);
    assert.match(result.html, /data-testid="editor-window-opening"/);
    assert.doesNotMatch(result.html, /data-testid="project-home"|data-testid="workbench"/);
    assert.equal(result.mounted.includes('AgentSettings'), false); assert.equal(result.mounted.includes('ImageSettings'), false);
    const report = callsOf(h, 'editorWindowStatus').at(-1);
    assert.deepEqual(report!.slice(0, 5), ['editorWindowStatus', h.env.nativeWindow, id(3), phase, false]);
    assert.equal(report!.length, 5, 'native status has no renderer-local remember callback');
    assert.deepEqual((callsOf(h, 'remember') as unknown), [], 'opening/error cannot persist a locator');
  }
});


test('native and Web accepted selection have no retired locator writer', async () => {
  const render = boundaryRenderer(), h = harness({ nativeWindow: nativeEditor(id(3)) });
  assert.equal(await h.selectProject(id(3), true), true);
  render(h); const report = callsOf(h, 'editorWindowStatus').at(-1);
  assert.equal(report!.length, 5); assert.equal(report![4], true);
  assert.deepEqual((callsOf(h, 'remember') as unknown), []);
  assert.equal(await h.selectProject(id(3)), true); assert.deepEqual((callsOf(h, 'remember') as unknown), []);
  const web = harness(); assert.equal(await web.selectProject(id(1)), true);
  assert.deepEqual(callsOf(web, 'remember'), []); assert.equal(web.env.openedProject.current?.projectId, id(1));
});

test('native alternate project delegates before any editor draft, request or URL mutation', async () => {
  const h = harness({ nativeWindow: nativeEditor(id(3)) }); assert.equal(await h.selectProject(id(3), true), true);
  const data = h.env.data, epoch = h.env.projectEpoch.current, navigation = h.env.navigationEpoch.current;
  const count = h.calls.length;
  assert.equal(await h.selectProject(id(2)), true);
  assert.deepEqual(h.calls.slice(count), [['nativeEntry.open', id(2)]]);
  assert.equal(h.env.data, data); assert.equal(h.env.currentProject.current, id(3));
  assert.equal(h.env.projectEpoch.current, epoch); assert.equal(h.env.navigationEpoch.current, navigation);
});


test('returning to home uses exact navigation guards, invalidates old project reads and leaves recency intact',async()=>{
 const h=harness();await h.selectProject(id(1));const remembered=callsOf(h,'remember').length,epoch=h.env.projectEpoch.current;
 assert.equal(await h.showProjectHome(),true);assert.equal(h.env.currentProject.current,null);assert.equal(h.env.openedProject.current,null);assert.equal(h.env.viewReady.current,false);assert.equal(h.env.data.project,null);assert.equal(h.env.projectOpening.phase,'home');assert.ok(h.env.projectEpoch.current>epoch);assert.equal(callsOf(h,'remember').length,remembered);
 const native=harness({nativeWindow:nativeEditor(id(1))});assert.equal(await native.showProjectHome(),false);assert.deepEqual(callsOf(native,'nativeEntry.show'),[['nativeEntry.show','open']]);
});

test('home navigation cannot discard over a newer scope or a refused draft confirmation',async()=>{
 const h=harness({guard:async()=>false});h.env.currentProject.current=id(1);const before=h.env.projectEpoch.current;assert.equal(await h.showProjectHome(),false);assert.equal(h.env.currentProject.current,id(1));assert.equal(h.env.projectEpoch.current,before);
});


test('failed project opening retains an application-only backup admission without treating the invalid source as ready', async () => {
  const h = harness({get: async () => {throw failure('PROJECT_INVALID');}});
  h.env.nativeBackup=readProjectBackupNativeActions({__mioonProjectBackups:{chooseDestination:async()=>null,reveal:async()=>true}});
  assert.equal(await h.selectProject(id(1)),false);assert.equal(h.projectSessionReady(),false);
  const failed = h.env.backupFailure as {projectId:string;admission:ProjectFeatureAdmission|null};
  assert.equal(failed.projectId,id(1));assert.ok(failed.admission);assert.equal(failed.admission.isCurrent(),true);
  const directory=h.env.projectEntryIdentityRef.current.getState();
  assert.equal(failed.admission.scope,directory.appLibraryScope);assert.equal(failed.admission.key,JSON.stringify([directory.appLibraryScope,directory.instanceId,id(1)]));
  const nodes=(value:unknown): {props?:Record<string,unknown>}[]=>{
    if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object')return [];
    const node=value as {props?:Record<string,unknown>};return [node,...nodes(node.props?.children),...nodes(node.props?.status),...nodes(node.props?.recovery)];
  };
  const recovery=nodes(boundaryRenderer()(h).sourceTree()).find(node=>node.props?.projectId===id(1)&&node.props?.admission===failed.admission);
  assert.ok(recovery,'the actual failed-opening branch passes the captured application admission to backup recovery');
  assert.equal(recovery.props?.interactionBlocked,false);
  const lease={current:true};h.env.nativeLeaseRevoked=lease;
  assert.equal(failed.admission.isCurrent(),false);assert.equal(h.captureProjectFeatureAdmission(id(1)),null);
});

test('project feature admission pins the application pair and checks native lease and selection live without repairing the original owner', async () => {
  let directory=projectEntryFixture(projects);
  const h=harness({directory:()=>directory});assert.equal(await h.selectProject(id(1)),true);
  const first=h.captureProjectFeatureAdmission(id(1));assert.ok(first);assert.equal(first.isCurrent(),true);assert.equal(h.captureProjectFeatureAdmission(id(2)),null);
  h.env.projectEpoch.current++;assert.equal(first.isCurrent(),false);
  const next=h.captureProjectFeatureAdmission(id(1));assert.ok(next);assert.equal(next.scope,first.scope);assert.equal(next.scope,PROJECT_ENTRY_TEST_SCOPE);assert.equal(next.key,first.key,'reopening in the same application keeps the receipt/cache namespace');assert.equal(next.isCurrent(),true);
  directory=projectEntryFixture(projects,{instanceId:id(8)});await h.env.projectEntryIdentityRef.current.refresh();
  assert.equal(h.env.projectEntryIdentityRef.current.getState().identityBlocked,true);assert.equal(next.isCurrent(),false);assert.equal(h.captureProjectFeatureAdmission(id(1)),null);
  directory=projectEntryFixture(projects);await h.env.projectEntryIdentityRef.current.refresh();assert.equal(next.isCurrent(),false,'an old pair returning cannot unblock the pinned window');
  assert.equal(first.isCurrent(),false);assert.equal(h.env.currentProject.current,id(1));
});
