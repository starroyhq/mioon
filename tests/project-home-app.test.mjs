import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';
import * as opening from '../apps/web/src/project-open-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { workspaceOriginScope, retainWorkspaceIdentity } from '../apps/web/src/workspace-origin.js';
import { validateProjectWorkspace } from '../apps/web/src/restored-workspace.js';
import { defaultWorkspaceState } from '../apps/web/src/workspace-state.js';
import { chooseInitialProject, retainLastProjectScope, createProjectBootGuard, assertLastProjectBootIdentity } from '../apps/web/src/last-project-navigation.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
// The same assertions can run against an independently extracted baseline App.
const app = readFileSync(process.env.MIOON_HOME_APP_SOURCE || join(root, 'apps/web/src/App.jsx'), 'utf8');
const id = n => `77000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projects = [1, 2].map(n => ({ id: id(n), name: `项目 ${n}`, updatedAt: '2026-10-13T00:00:00.000Z' }));
const snapshot = projectId => ({ project: { id: projectId, name: '已核对项目' }, shots: [], nodes: [], edges: [], assets: [], versions: [], jobs: [], exports: [] });
const emptyData = { project: null, shots: [], nodes: [], edges: [], assets: [], versions: [], jobs: [], exports: [] };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
const failure = code => Object.assign(new Error(code), { code });
function section(start, end) {
  const first = app.indexOf(start), last = app.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Actual App boundary is required: ${start.trim()}`);
  assert.equal(app.indexOf(start, first + start.length), -1, `Boundary must be unique: ${start.trim()}`);
  return app.slice(first, last);
}
function environment(options = {}) {
  const calls = [], registry = createSettingsNavigationRegistry();
  const env = {
    ...opening, workspaceOriginScope, retainWorkspaceIdentity, validateProjectWorkspace,
    chooseInitialProject, retainLastProjectScope, assertLastProjectBootIdentity, URL, URLSearchParams,
    useCallback: callback => callback, emptyData, loading: false, auth: true, online: true,
    data: emptyData, projects, projectOpening: { phase: 'home', projectId: null, error: '' },
    homePage: 'projects', homeConnection: 'agent', projectListStatus: { busy: false, error: '' }, busy: {}, toast: null,
    currentProject: { current: null }, projectEpoch: { current: 0 }, navigationEpoch: { current: 0 },
    requestCounter: { current: 0 }, projectListSerial: { current: 0 }, openedProject: { current: null }, projectCreateFlight: { current: null },
    importSession: { current: { active: true, selection: 0 } }, workspaceRef: { current: { restored: false } },
    dataRef: { current: emptyData }, viewRef: { current: defaultWorkspaceState() }, viewReady: { current: false },
    settingsNavigation: { current: registry }, agentDraft: { current: false }, imageDraft: { current: false }, dragging: { current: false },
    preferenceScope: { current: null }, locatorIdentity: { current: null },
    notify: (...args) => calls.push(['notice', ...args]), readableError: error => error.message,
    confirm: async () => { calls.push(['confirm']); return options.confirm ? options.confirm() : true; },
    guardProjectNavigation: async (_message, _dirty, current) => options.guard ? options.guard(current) : current(),
    pendingForProject: () => [], reconcileWorkspaceState: state => state,
    reconcilePending: (...args) => calls.push(['reconcile', ...args]),
    updateView: (...args) => calls.push(['updateView', ...args]), migrateBrowserStorage() {}, isBusy: () => false,
    markBusy: (projectId, key, value) => { calls.push(['markBusy', projectId, key, value]); if (projectId === env.currentProject.current) env.busy[key] = value; },
    preferencesRef: { current: {
      flush: async (...args) => { calls.push(['flush', ...args]); },
      load: async (...args) => { calls.push(['preferences', ...args]); return options.preferences ? options.preferences(...args) : defaultWorkspaceState(); },
      getStatus: () => options.preferenceStatus || { phase: 'saved' },
      update: (...args) => calls.push(['preferences.update', ...args]),
    } },
    tasksRef: { current: { getState: () => ({ phase: 'idle', items: [] }), load: async projectId => calls.push(['tasks.load', projectId]) } },
    lastProjectRef: { current: {
      invalidateNavigation: epoch => calls.push(['invalidate', epoch]), rememberOpened: (...args) => calls.push(['remember', ...args]),
      getState: () => ({ phase: 'saved', identityBlocked: false, revision: null }),
      discover: () => options.discovery || Promise.resolve({ workspaceScope: 'a'.repeat(64), envelope: null }),
    } },
    rpc: async (operation, input) => {
      calls.push(['rpc', operation, input]);
      if (options.rpc) return options.rpc(operation, input);
      if (operation === 'project.get') return options.get ? options.get(input.projectId) : snapshot(input.projectId);
      if (operation === 'workspace.restore.inspect') return { restored: false };
      if (operation === 'project.list') return projects;
      if (operation === 'provider.list') return [];
      assert.fail(`Unexpected RPC: ${operation}`);
    },
    run: async (...args) => { calls.push(['run', ...args]); return options.create ? options.create(...args) : { id: id(3) }; },
    window: { location: { href: 'http://127.0.0.1:4318/', search: '', pathname: '/' }, history: {
      pushState: (...args) => calls.push(['pushState', ...args]), replaceState: (...args) => calls.push(['replaceState', ...args]),
    } },
  };
  for (const name of ['ProjectOpening', 'HomePage', 'ProjectListStatus', 'Auth', 'Online', 'Data', 'Projects', 'Providers', 'LastSync',
    'PropertiesPage', 'TaskState', 'PreferenceStatus', 'Pending', 'ShowProjects', 'Nodes', 'Loading', 'ShotDirty', 'ClipDirty', 'SourceDirty',
    'SubjectDirty', 'SubtitleDirty', 'InspectorEpoch', 'RightDockTab', 'ShowExports', 'ComparisonId', 'PreviewAsset', 'RealConfirm',
    'Toast', 'MobilePanel', 'View', 'Zoom', 'Workspace', 'ShowCreate']) {
    const key = name[0].toLowerCase() + name.slice(1);
    env[`set${name}`] = value => { env[key] = typeof value === 'function' ? value(env[key]) : value; calls.push([`set${name}`, env[key]]); };
  }
  env.bootGuard = { current: createProjectBootGuard(() => env.projectEpoch.current) }; env.bootGuard.current.activate();
  return { env, calls, registry };
}
function harness(options = {}) {
  const { env, calls, registry } = environment(options);
  const source = [section('  function projectSessionReady()', '  const workbenchReady ='),
    section('  const context = () =>', '  taskWorkspaceState.current ='),
    section('  async function prepareSettingsDeparture()', '  async function changeMode('),
    section('  const refresh = useCallback(', '  async function revealImageAsset('),
    section('  async function selectProject(', '  async function reloadPreferences('),
    section('  async function boot() {', '  useEffect(() => {\n    bootGuard.current.activate();'),
    section('  async function createProject(', '  async function addShot(')].join('\n');
  // A live lexical environment models React rerenders without reimplementing the
  // production functions. Only external services and unrelated draft guards are fakes.
  const api = Function('env', `with (env) { ${source}\nreturn { projectSessionReady, selectProject, refresh, prepareSettingsDeparture, changeHomePage, refreshHomeProjects, createProject, boot }; }`)(env);
  return { env, calls, registry, ...api,
    eligible: () => opening.canPublishProjectOpen(env.openedProject.current, { active: env.importSession.current.active,
      currentProjectId: env.currentProject.current, epoch: env.projectEpoch.current, workspaceScope: workspaceOriginScope(env.workspaceRef.current) || '',
      preferencesReady: env.viewReady.current, dataProjectId: env.data.project?.id || null, loading: env.loading }),
    unmount() { env.importSession.current.active = false; env.importSession.current.selection++; env.requestCounter.current++; env.bootGuard.current.deactivate(); },
  };
}
const callsOf = (h, name) => h.calls.filter(call => call[0] === name);

// These production-refresh regressions deliberately need no newly added App
// helper, so the baseline must fail on behavior rather than missing fixture names.
function refreshHarness(options = {}) {
  const h = environment(options); h.env.currentProject.current = id(1);
  const source = section('  const refresh = useCallback(', '  async function revealImageAsset(');
  h.refresh = Function('env', `with (env) { ${source}\nreturn refresh; }`)(h.env);
  return h;
}

test('causal regression: actual refresh quarantines wrong-project data before reconciling pending operations', async () => {
  const h = refreshHarness({ get: async () => snapshot(id(2)) });
  await assert.rejects(h.refresh(id(1), false, { opening: true }), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.deepEqual(callsOf(h, 'reconcile'), []); assert.equal(h.env.data.project, null);
});

test('causal regression: actual refresh cannot publish a response after renderer unmount', async () => {
  const held = deferred(), h = refreshHarness({ get: () => held.promise });
  const pending = h.refresh(id(1), false, { opening: true }); await tick(); h.env.importSession.current.active = false;
  const count = h.calls.length; held.resolve(snapshot(id(1))); assert.equal(await pending, null);
  assert.equal(h.calls.length, count); assert.deepEqual(callsOf(h, 'reconcile'), []);
});

test('actual selection keeps home visible after preferences resolve until validated project data settles', async () => {
  const held = deferred(), h = harness({ get: () => held.promise }), pending = h.selectProject(id(1)); await tick();
  assert.equal(h.env.currentProject.current, id(1)); assert.equal(h.env.viewReady.current, true);
  assert.equal(h.env.projectOpening.phase, 'opening'); assert.equal(h.env.loading, true); assert.equal(h.eligible(), false);
  assert.equal(h.env.openedProject.current, null); assert.deepEqual(callsOf(h, 'remember'), []); assert.deepEqual(callsOf(h, 'tasks.load'), []);
  held.resolve(snapshot(id(1))); assert.equal(await pending, true);
  assert.equal(h.env.projectOpening.phase, 'ready'); assert.equal(h.eligible(), true); assert.equal(Object.isFrozen(h.env.openedProject.current), true);
  assert.deepEqual(callsOf(h, 'remember'), [['remember', id(1), 1]]); assert.deepEqual(callsOf(h, 'tasks.load'), [['tasks.load', id(1)]]);
});

test('actual refresh rejects wrong-project responses before reconciliation or publishing data', async () => {
  const h = harness({ get: async () => snapshot(id(2)) }); assert.equal(await h.selectProject(id(1)), false);
  assert.equal(h.env.projectOpening.phase, 'error'); assert.equal(h.eligible(), false); assert.equal(h.env.auth, true);
  assert.deepEqual(callsOf(h, 'reconcile'), []); assert.deepEqual(callsOf(h, 'remember'), []); assert.equal(h.env.data.project, null);
  assert.equal(h.env.loading, false);
});

test('ordinary refresh cannot read or publish before a successful project-open ticket exists', async () => {
  const held = deferred(), h = harness({ get: () => held.promise });
  h.env.currentProject.current = id(1);
  assert.equal(await h.refresh(id(1)), null); assert.deepEqual(callsOf(h, 'rpc'), []);
  const pending = h.selectProject(id(1)); await tick(); const before = h.calls.length;
  assert.equal(h.env.viewReady.current, true); assert.equal(await h.refresh(id(1)), null); assert.equal(h.calls.length, before);
  held.reject(Error('load failed')); assert.equal(await pending, false); const failedCount = h.calls.length;
  assert.equal(await h.refresh(id(1)), null); assert.equal(h.calls.length, failedCount); assert.equal(h.eligible(), false);
});

test('same-project data without an accepted opening ticket must take the real load path', async () => {
  const h = harness(); h.env.currentProject.current = id(1); h.env.data = h.env.dataRef.current = snapshot(id(1)); h.env.viewReady.current = true;
  assert.equal(h.projectSessionReady(), false); assert.equal(await h.selectProject(id(1)), true);
  assert.equal(callsOf(h, 'preferences').length, 1); assert.equal(h.env.projectEpoch.current, 1); assert.equal(h.eligible(), true);
  assert.deepEqual(callsOf(h, 'remember'), [['remember', id(1), 1]]);
});

for (const code of ['UNAUTHORIZED', 'WORKSPACE_ORIGIN_UNVERIFIED', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH', 'LAST_PROJECT_SCOPE_MISMATCH', 'LAST_PROJECT_STALE_INSTANCE']) {
  test(`actual selection preserves ${code} routing from project load and preference fallback`, async () => {
    for (const options of [{ get: async () => { throw failure(code); } }, { preferenceStatus: { phase: 'local', error: failure(code) } }]) {
      const h = harness(options); assert.equal(await h.selectProject(id(1)), false);
      assert.equal(h.env.auth, code === 'UNAUTHORIZED' ? false : 'error'); assert.equal(h.eligible(), false);
      assert.equal(h.env.openedProject.current, null); assert.deepEqual(callsOf(h, 'remember'), []); assert.deepEqual(callsOf(h, 'tasks.load'), []);
    }
  });
}

test('slow A and late A failure cannot overwrite a faster B selection', async () => {
  for (const reject of [false, true]) {
    const held = deferred(), h = harness({ get: projectId => projectId === id(1) ? held.promise : snapshot(projectId) });
    const old = h.selectProject(id(1)); await tick(); assert.equal(await h.selectProject(id(2)), true);
    const before = h.calls.length; if (reject) held.reject(failure('UNAUTHORIZED')); else held.resolve(snapshot(id(1)));
    assert.equal(await old, false); assert.equal(h.calls.length, before); assert.equal(h.env.data.project.id, id(2));
    assert.equal(h.env.projectOpening.projectId, id(2)); assert.equal(h.env.auth, true); assert.equal(h.eligible(), true);
    assert.deepEqual(callsOf(h, 'remember'), [['remember', id(2), 2]]);
  }
});

test('same-ID reopen is a new epoch and the first response cannot publish its ticket', async () => {
  const first = deferred(), second = deferred(); let reads = 0;
  const h = harness({ get: () => ++reads === 1 ? first.promise : second.promise });
  const old = h.selectProject(id(1)); await tick(); const next = h.selectProject(id(1)); await tick();
  second.resolve(snapshot(id(1))); assert.equal(await next, true); const ticket = h.env.openedProject.current, count = h.calls.length;
  first.resolve(snapshot(id(1))); assert.equal(await old, false); assert.equal(h.env.openedProject.current, ticket);
  assert.equal(ticket.epoch, 2); assert.equal(h.calls.length, count); assert.deepEqual(callsOf(h, 'remember'), [['remember', id(1), 2]]);
});

test('unmount rejects late successful and failed project loads without publishing or reconciling', async () => {
  for (const reject of [false, true]) {
    const held = deferred(), h = harness({ get: () => held.promise }), pending = h.selectProject(id(1)); await tick();
    h.unmount(); const count = h.calls.length;
    if (reject) held.reject(failure('UNAUTHORIZED')); else held.resolve(snapshot(id(1)));
    assert.equal(await pending, false); assert.equal(h.calls.length, count); assert.equal(h.env.data.project, null);
    assert.equal(h.env.openedProject.current, null); assert.deepEqual(callsOf(h, 'reconcile'), []);
  }
});

test('workspace replacement prevents a delayed response from reconciling or exposing the workbench', async () => {
  for (const reject of [false, true]) {
    const held = deferred(), h = harness({ get: () => held.promise }), pending = h.selectProject(id(1)); await tick();
    h.env.workspaceRef.current = { restored: true, workspaceOrigin: id(8) }; const count = h.calls.length;
    if (reject) held.reject(failure('UNAUTHORIZED')); else held.resolve(snapshot(id(1)));
    assert.equal(await pending, false); assert.equal(h.eligible(), false); assert.equal(h.calls.length, count);
    assert.deepEqual(callsOf(h, 'reconcile'), []); assert.deepEqual(callsOf(h, 'remember'), []); assert.equal(h.env.data.project, null);
  }
});

test('restored project origin mismatch blocks workspace identity while malformed restore data stays a project error', async () => {
  for (const foreign of [false, true]) {
    const h = harness({ get: async projectId => ({ ...snapshot(projectId), ...(foreign ? { restore: { workspaceOrigin: id(9), heldExportIds: [] } } : {}) }) });
    h.env.workspaceRef.current = { restored: true, workspaceOrigin: id(8) };
    assert.equal(await h.selectProject(id(1)), false); assert.equal(h.env.auth, foreign ? 'error' : true);
    assert.equal(h.env.projectOpening.phase, 'error'); assert.equal(h.eligible(), false);
    assert.deepEqual(callsOf(h, 'reconcile'), []); assert.deepEqual(callsOf(h, 'remember'), []); assert.equal(h.env.data.project, null);
  }
});

test('settings cancellation and newer input during confirmation leave the same home and project', async () => {
  for (const newerInput of [false, true]) {
    const answer = deferred(), h = harness({ confirm: () => answer.promise }); h.env.homePage = 'settings';
    const owner = h.registry.register('home:agent'); owner.update({ dirty: true, busy: false, blocked: false, version: 1 });
    const pending = h.selectProject(id(1)); await tick();
    if (newerInput) owner.update({ dirty: true, busy: false, blocked: false, version: 2 }); answer.resolve(newerInput);
    assert.equal(await pending, false); assert.equal(h.env.homePage, 'settings'); assert.equal(h.env.currentProject.current, null);
    assert.equal(h.env.projectEpoch.current, 0); assert.deepEqual(callsOf(h, 'rpc'), []); assert.deepEqual(callsOf(h, 'preferences'), []);
  }
});

test('busy or unresolved settings block open, create, and leaving settings without confirmation or RPC', async () => {
  for (const state of [{ dirty: true, busy: true, blocked: false }, { dirty: false, busy: false, blocked: true }]) {
    const h = harness(); h.env.homePage = 'settings'; const owner = h.registry.register('home:custom'); owner.update({ ...state, version: 1 });
    assert.equal(await h.selectProject(id(1)), false); assert.equal(await h.createProject('新项目', ''), false);
    await h.changeHomePage('projects'); assert.equal(h.env.homePage, 'settings'); assert.equal(h.env.currentProject.current, null);
    assert.deepEqual(callsOf(h, 'confirm'), []); assert.deepEqual(callsOf(h, 'rpc'), []); assert.deepEqual(callsOf(h, 'run'), []);
  }
});

test('new settings input during the ordinary project guard invalidates the departure ticket', async () => {
  const guard = deferred(), h = harness({ guard: () => guard.promise }), owner = h.registry.register('home:official');
  owner.update({ dirty: true, busy: false, blocked: false, version: 1 }); const pending = h.selectProject(id(1)); await tick();
  owner.update({ dirty: true, busy: false, blocked: false, version: 2 }); guard.resolve(true);
  assert.equal(await pending, false); assert.equal(h.env.currentProject.current, null); assert.deepEqual(callsOf(h, 'rpc'), []);
});

test('late create completion cannot steal newer navigation and never repeats the create request', async () => {
  const held = deferred(), h = harness({ create: () => held.promise }), pending = h.createProject('新项目', '简述'); await tick();
  assert.equal(callsOf(h, 'run').length, 1); assert.equal(await h.selectProject(id(2)), true); const count = h.calls.length;
  held.resolve({ id: id(3) }); assert.equal(await pending, false);
  assert.deepEqual(h.calls.slice(count), [['markBusy', null, 'project-create-flow', false]]);
  assert.equal(h.env.currentProject.current, id(2)); assert.equal(callsOf(h, 'run').length, 1);
});

test('create acknowledgements and list responses cannot publish after unmount or a new renderer lifetime', async () => {
  for (const phase of ['ack', 'list']) for (const reactivate of [false, true]) {
    const held = deferred();
    const h = harness(phase === 'ack' ? { create: () => held.promise } : { rpc: async operation => {
      assert.equal(operation, 'project.list'); return held.promise;
    } });
    const pending = h.createProject('新项目', ''); await tick(); assert.equal(callsOf(h, 'run').length, 1);
    h.unmount(); if (reactivate) { h.env.importSession.current.active = true; h.env.bootGuard.current.activate(); }
    const count = h.calls.length; held.resolve(phase === 'ack' ? { id: id(3) } : [...projects, { ...projects[0], id: id(3) }]);
    assert.equal(await pending, false); assert.equal(h.calls.length, count, `${phase}; reactivate=${reactivate}`);
    assert.equal(h.env.currentProject.current, null); assert.equal(h.env.projectCreateFlight.current, null);
    assert.deepEqual(callsOf(h, 'preferences'), []); assert.equal(callsOf(h, 'run').length, 1);
  }
});

test('create with failed list read keeps uncertainty visible and does not retry mutation automatically', async () => {
  const h = harness({ rpc: async operation => { assert.equal(operation, 'project.list'); throw Error('list unavailable'); } });
  assert.equal(await h.createProject('新项目', ''), false); await tick();
  assert.equal(callsOf(h, 'run').length, 1); assert.equal(h.env.currentProject.current, null);
  assert.match(h.env.projectListStatus.error, /可能已创建/); assert.match(h.env.projectListStatus.error, /不要直接重复创建/);
});

test('create holds its synchronous latch through the post-acknowledgement project-list read', async () => {
  const listed = deferred(), h = harness({ rpc: async (operation, input) => {
    if (operation === 'project.list') return listed.promise;
    if (operation === 'project.get') return snapshot(input.projectId);
    if (operation === 'provider.list') return [];
    assert.fail(`Unexpected RPC: ${operation}`);
  } });
  const pending = h.createProject('新项目', '');
  assert.equal(await h.createProject('立即重复', ''), false); await tick();
  assert.equal(callsOf(h, 'run').length, 1); assert.ok(h.env.projectCreateFlight.current); assert.equal(h.env.busy['project-create-flow'], true);
  assert.equal(await h.createProject('ACK 后重复', ''), false); assert.equal(callsOf(h, 'run').length, 1);
  listed.resolve([...projects, { ...projects[0], id: id(3) }]); assert.equal(await pending, true);
  assert.equal(h.env.projectCreateFlight.current, null); assert.equal(h.env.currentProject.current, id(3)); assert.equal(h.eligible(), true);
  assert.equal(callsOf(h, 'run').length, 1);
});

test('actual empty startup chooses home while explicit startup succeeds without rewriting the locator', async () => {
  const h = harness({ rpc: async operation => operation === 'workspace.restore.inspect' ? { restored: false } : [] });
  await h.boot(); assert.equal(h.env.auth, true); assert.equal(h.env.projectOpening.phase, 'home'); assert.equal(h.eligible(), false);
  assert.deepEqual(callsOf(h, 'preferences'), []); assert.deepEqual(callsOf(h, 'remember'), []);
  const selected = harness(); selected.env.window.location.search = `?project=${id(2)}`; await selected.boot();
  assert.equal(selected.env.data.project.id, id(2)); assert.equal(selected.eligible(), true); assert.deepEqual(callsOf(selected, 'remember'), []);
  assert.equal(callsOf(selected, 'replaceState').length, 1);
});

test('late boot discovery cannot select over a newer project or publish after unmount', async () => {
  for (const unmount of [false, true]) {
    const held = deferred(), h = harness({ discovery: held.promise }), pending = h.boot(); await tick();
    if (unmount) h.unmount(); else assert.equal(await h.selectProject(id(2)), true);
    const count = h.calls.length; held.resolve({ workspaceScope: 'a'.repeat(64), envelope: null }); await pending;
    assert.equal(h.calls.length, count); assert.equal(h.env.currentProject.current, unmount ? null : id(2));
  }
});

let presentation;
function boundaryRenderer() {
  if (presentation) return presentation;
  const start = app.indexOf('  if (auth === false) return <Login');
  const workbench = app.indexOf('  return <main className={`workbench ', start);
  const openingEnd = app.indexOf('>\n', workbench);
  assert.ok(start >= 0 && workbench > start && openingEnd > workbench, 'Actual App render boundaries must exist');
  // Mount the complete, unmodified home/auth branch with real ProjectHome,
  // connection navigation and shared controls. The successful boundary retains
  // App's actual outer workbench element; full workbench internals are outside
  // this focused fixture, rather than replaced by a generic permissive proxy.
  const readiness = section('  const workbenchReady =', '  const panelSurface =');
  const renderSource = readiness + app.slice(start, workbench) + app.slice(workbench, openingEnd + 1) + '</main>;';
  const fixture = `import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import ProjectHome from './src/ProjectHome.tsx';
    import ProjectHomeConnections from './src/ProjectHomeConnections.tsx';
    import SettingsNavigationSlot from './src/SettingsNavigationSlot.tsx';
    import LastProjectStatus from './src/LastProjectStatus.tsx';
    import { Button } from '@mioon/ui/components/button';
    export { React, renderToStaticMarkup, ProjectHome, ProjectHomeConnections, SettingsNavigationSlot, LastProjectStatus, Button };`;
  const result = buildSync({ stdin: { contents: fixture, loader: 'jsx', resolveDir: join(root, 'apps/web') }, bundle: true, platform: 'node', format: 'cjs',
    write: false, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const module = { exports: {} }; Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const ui = module.exports;
  const body = transformSync(`function renderBoundary() { ${renderSource} }`, { loader: 'jsx', format: 'cjs', jsx: 'transform' }).code;
  presentation = h => {
    const mounted = [];
    const stub = name => () => { mounted.push(name); return ui.React.createElement('section', { 'data-stub': name }); };
    const env = { ...h.env, ...h, ...ui, restored: h.env.workspaceRef.current.restored, workspace: h.env.workspaceRef.current,
      lastProjectStatus: null, setHomeConnection() {}, geometry: { narrow: false, style: {} }, workspaceMode: 'canvas', mobilePanel: 'canvas',
      assetsCollapsed: false, inspectorCollapsed: false, timelineCollapsed: false,
      Icon: () => null, Login: stub('Login'), RestoredUnavailable: stub('RestoredUnavailable'),
      AgentSettings: stub('AgentSettings'), ImageSettings: stub('ImageSettings'), ComfyImageSettings: stub('ComfyImageSettings'),
      AgentDockPane: ({ children }) => ui.React.createElement('div', null, children),
      TaskCenter: stub('TaskCenter'), AgentPanel: stub('AgentPanel'), ImageGeneration: stub('ImageGeneration'),
    };
    const render = Function('env', `with (env) { ${body}; return renderBoundary; }`)(env);
    return { html: ui.renderToStaticMarkup(ui.React.createElement(render)), mounted };
  };
  return presentation;
}

test('actual App fully renders standalone home/settings and exposes the original workbench only after success', async () => {
  const render = boundaryRenderer(), h = harness();
  for (const phase of ['home', 'opening', 'error']) {
    h.env.projectOpening = { phase, projectId: id(1), error: phase === 'error' ? '读取失败' : '' };
    const { html, mounted } = render(h); assert.match(html, /data-testid="project-home"/); assert.match(html, new RegExp(`data-phase="${phase}"`));
    assert.doesNotMatch(html, /data-testid="workbench"|task-workspace|react-flow|inspector-region/); assert.deepEqual(mounted, []);
  }
  h.env.homePage = 'settings';
  const settings = render(h); assert.match(settings.html, /全局连接设置/); assert.deepEqual(settings.mounted, ['AgentSettings']);
  for (const forbidden of ['TaskCenter', 'AgentPanel', 'ImageGeneration']) assert.equal(settings.mounted.includes(forbidden), false);
  h.env.homePage = 'projects'; assert.equal(await h.selectProject(id(1)), true);
  const ready = render(h); assert.match(ready.html, /<main[^>]+data-testid="workbench"/); assert.doesNotMatch(ready.html, /data-testid="project-home"/);
});

test('actual auth and restored-home branches retain their existing protections', () => {
  const render = boundaryRenderer(), h = harness(); h.env.auth = false;
  assert.deepEqual(render(h).mounted, ['Login']); assert.doesNotMatch(render(h).html, /data-testid="project-home"|data-testid="workbench"/);
  h.env.auth = 'error'; const failed = render(h); assert.match(failed.html, /暂时无法连接工作台/); assert.doesNotMatch(failed.html, /data-testid="workbench"/);
  h.env.auth = true; h.env.homePage = 'settings'; h.env.workspaceRef.current = { restored: true, workspaceOrigin: id(8) };
  const restored = render(h); assert.match(restored.html, /data-testid="project-home"/);
  assert.ok(restored.mounted.includes('RestoredUnavailable')); assert.equal(restored.mounted.includes('AgentSettings'), false);
  assert.equal(restored.mounted.includes('ImageSettings'), false); assert.equal(restored.mounted.includes('ComfyImageSettings'), false);
});

test('actual App shares authenticated settled project readiness between workbench display and geometry observation', () => {
  const wiring = section('  function projectSessionReady()', '  const markPanelIntent =');
  const render = boundaryRenderer();
  const cases = [
    ['validated project', () => {}, true],
    ['no accepted ticket', env => { env.openedProject.current = null; }, false],
    ['preferences pending', env => { env.viewReady.current = false; }, false],
    ['project data missing', env => { env.data = env.dataRef.current = emptyData; }, false],
    ['different loaded project', env => { env.data = env.dataRef.current = snapshot(id(2)); }, false],
    ['new selection epoch', env => { env.projectEpoch.current++; }, false],
    ['changed workspace', env => { env.workspaceRef.current = { restored: true, workspaceOrigin: id(8) }; }, false],
    ['inactive renderer', env => { env.importSession.current.active = false; }, false],
    ['load still active', env => { env.loading = true; }, false],
    ['logged out', env => { env.auth = false; }, false],
    ['authentication pending', env => { env.auth = null; }, false],
    ['connection blocked', env => { env.auth = 'error'; }, false],
  ];
  for (const [label, change, expected] of cases) {
    const h = harness(), observations = [], modeLayout = defaultWorkspaceState().layout.canvas;
    h.env.currentProject.current = id(1); h.env.projectEpoch.current = 1;
    h.env.openedProject.current = opening.projectOpenAttempt(id(1), 1, 'normal'); h.env.viewReady.current = true;
    h.env.data = h.env.dataRef.current = snapshot(id(1)); change(h.env);
    const env = { ...h.env, modeLayout, workspaceMode: 'canvas',
      useRef: initial => ({ current: initial }), useState: initial => [initial, () => {}],
      usePanelGeometry: (...args) => { observations.push(args); return { narrow: false, style: {} }; },
    };
    const result = Function('env', `with (env) { ${wiring}\nreturn { workbenchReady, geometry }; }`)(env);
    assert.equal(observations.length, 1, label);
    assert.equal(observations[0][0].current, null, `${label}: surface has not mounted yet`);
    assert.equal(observations[0][1], modeLayout); assert.equal(observations[0][2], 'canvas');
    assert.equal(result.workbenchReady, expected, label);
    assert.equal(observations[0][4], expected, `${label}: geometry must use the full opening gate`);
    assert.equal(render(h).html.includes('data-testid="workbench"'), expected, `${label}: display and observation readiness must agree`);
  }
});
