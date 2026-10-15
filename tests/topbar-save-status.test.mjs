import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage } from './helpers/i18n.ts';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSync, transformSync } from 'esbuild';
import { createWorkspacePreferences, durableWorkspaceState } from '../apps/web/src/workspace-preferences.js';
import { defaultWorkspaceState } from '../apps/web/src/workspace-state.js';
import { projectOpenAttempt, canPublishProjectOpen, projectResponseMatches, projectOpenFailureKind } from '../apps/web/src/project-open-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { workspaceOriginScope } from '../apps/web/src/workspace-origin.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const componentPath = path.join(root, 'apps/web/src/TopbarSaveStatus.tsx');
const app = readFileSync(path.join(root, 'apps/web/src/App.jsx'), 'utf8');
// Exact shipped markup, copied before extraction from c3c10316347d30ed50b365442e78738267ac288a.
// This oracle is deliberately independent of the implementation under test.
const baselineMarkup = "<div className=\"topbar-sync\" title={lastSync ? `最近同步：${lastSync.toLocaleTimeString('zh-CN')}` : ''}><span className={`status-dot ${!online ? 'red' : Object.values(busy).some(Boolean) ? 'orange' : 'green'}`} />{!online ? '连接中断' : Object.values(busy).some(Boolean) ? '正在同步' : inspectorDirty || formatDirty ? '有未保存修改' : '已保存'}</div><div className=\"workspace-save-status\" data-testid=\"workspace-save-status\" data-phase={preferenceStatus.phase} role=\"status\">{['local', 'conflict', 'error'].includes(preferenceStatus.phase) ? <><span>{preferenceStatus.phase === 'conflict' ? '视图已在其他窗口更新' : '视图位置未同步'}</span>{preferenceStatus.phase === 'error' && preferenceStatus.canRetry && <Button variant=\"ghost\" className=\"text-button\" data-testid=\"retry-workspace-save\" onClick={() => preferencesRef.current.flush({ projectId: currentProject.current })}>重试</Button>}<Button variant=\"ghost\" className=\"text-button\" data-testid=\"reload-workspace-preferences\" onClick={reloadPreferences}>载入已保存视图</Button></> : preferenceStatus.pending ? <span>保存视图…</span> : null}</div>";
const baselineHash = '8ba3a9dc48d9ee2a4770cb7f7c10231498fb16ccbb5d89aa556e49190c0ea8e6';
const A = '994d1f5d-b34d-494b-a3cb-fb0e6c5df761';
const B = '297ac636-dd29-4eab-b8e5-a4514df7d3c2';
const SELECTED = 'd6c2b1f0-7712-4411-b6fe-ed1d3e9bf2e9';
const stamp = new Date('2026-10-13T03:04:05.000Z');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const props = (patch = {}) => freeze({ online: true, syncing: false, dirty: false, lastSync: null,
  preferenceStatus: { phase: 'saved', pending: false }, onRetry() {}, onReload() {}, ...patch });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
let originalFetch;
before(() => { originalFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('Presentation must not request data'); }; });
after(() => { globalThis.fetch = originalFetch; });
const views = new Map();
function view(kind) {
  if (views.has(kind)) return views.get(kind);
  const source = kind === 'baseline' ? `
    function Component({ online, syncing, dirty, lastSync, preferenceStatus, onRetry, onReload }) {
      const busy = { work: syncing }, inspectorDirty = dirty, formatDirty = false;
      const currentProject = { current: '${A}' }, preferencesRef = { current: { flush: onRetry } }, reloadPreferences = onReload;
      return <>${baselineMarkup}</>;
    }` : `import Component from './src/TopbarSaveStatus.tsx';`;
  const fixture = `import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { Button } from '@mioon/ui/components/button';
    ${source}
    function DirectComponent(props) { let tree; function Probe() { tree = Component(props); return null; } renderToStaticMarkup(<Probe />); return tree; }
    export { DirectComponent as Component, React, Button, renderToStaticMarkup };
    export const render = props => renderToStaticMarkup(<Component {...props} />);`;
  const result = buildSync({ stdin: { contents: fixture, loader: 'jsx', resolveDir: path.join(root, 'apps/web') },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' } });
  const module = { exports: {} };
  Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  views.set(kind, module.exports);
  return module.exports;
}
function topbarExpectation(html, online, syncing, dirty) {
  const color = !online ? 'red' : syncing ? 'orange' : 'green';
  const label = !online ? '连接中断' : syncing ? '正在同步' : dirty ? '有未保存修改' : '已保存';
  assert.ok(html.startsWith(`<div class="topbar-sync" title=""><span class="status-dot ${color}"></span>${label}</div><div class="workspace-save-status"`));
}
function preferenceExpectation(html, phase, pending, canRetry) {
  assert.ok(html.includes(`data-testid="workspace-save-status" data-phase="${phase}" role="status"`));
  const recovery = ['local', 'conflict', 'error'].includes(phase);
  assert.equal(html.includes('data-testid="reload-workspace-preferences"'), recovery);
  assert.equal(html.includes('data-testid="retry-workspace-save"'), phase === 'error' && Boolean(canRetry));
  assert.equal(html.includes('视图已在其他窗口更新'), phase === 'conflict');
  assert.equal(html.includes('视图位置未同步'), phase === 'local' || phase === 'error');
  assert.equal(html.includes('保存视图…'), !recovery && pending);
  if (!recovery && !pending) assert.ok(html.endsWith(`data-phase="${phase}" role="status"></div>`), ':empty remains applicable');
  for (const button of html.matchAll(/<button[^>]*>/g)) {
    assert.match(button[0], /type="button"/);
    assert.match(button[0], /data-slot="button"/);
    assert.match(button[0], /class="[^"]*text-button/);
  }
}
const phases = ['local', 'conflict', 'error', 'loading', 'saved', 'saving', 'pending', 'future-phase'];

test('baseline oracle is exact frozen shipped markup with two sibling divs', () => {
  assert.equal(createHash('sha256').update(baselineMarkup).digest('hex'), baselineHash);
  if (!existsSync(componentPath)) {
    const region = app.slice(app.indexOf('<div className="topbar-sync"'), app.indexOf('<LastProjectStatus '));
    assert.equal(region, baselineMarkup);
  }
  const actual = view('baseline'), tree = actual.Component(props());
  assert.equal(tree.type, actual.React.Fragment);
  const children = actual.React.Children.toArray(tree.props.children);
  assert.deepEqual(children.map(child => child.type), ['div', 'div']);
  assert.deepEqual(children.map(child => child.props.className), ['topbar-sync', 'workspace-save-status']);
  assert.equal(children[1].props.role, 'status');
});

test('baseline real React markup characterizes offline, busy, dirty, clean and localized time precedence', () => {
  const { render } = view('baseline');
  for (const online of [false, true]) for (const syncing of [false, true]) for (const dirty of [false, true]) {
    topbarExpectation(render(props({ online, syncing, dirty })), online, syncing, dirty);
  }
  assert.ok(render(props({ lastSync: stamp })).includes(`title="最近同步：${stamp.toLocaleTimeString('zh-CN')}"`));
});

test('baseline real shared Buttons characterize all preference priority and recovery combinations', () => {
  const { render } = view('baseline');
  for (const phase of phases) for (const pending of [false, true]) for (const canRetry of [undefined, false, true]) {
    const supplied = props({ preferenceStatus: { phase, pending, canRetry } }), before = JSON.stringify(supplied);
    preferenceExpectation(render(supplied), phase, pending, canRetry);
    assert.equal(JSON.stringify(supplied), before);
  }
});

test('extracted presentation boundary exists as typed source', () => {
  assert.ok(existsSync(componentPath), 'TopbarSaveStatus.tsx must exist before the extraction is accepted');
});

test('actual classic JSX transform executes without relying on an ambient React global', () => {
  assert.equal(typeof globalThis.React, 'undefined');
  const actual = view('baseline'), module = { exports: {} };
  // Vite's current default is classic JSX. The automatic-runtime render fixture
  // above cannot prove that the real source imports its runtime JSX binding.
  const code = transformSync(readFileSync(componentPath, 'utf8'), {
    loader: 'tsx', format: 'cjs', jsx: 'transform',
  }).code;
  Function('require', 'module', 'exports', code)(name => {
    if (name === 'react') return actual.React;
    if (name === './i18n/I18nProvider.tsx') return i18nTestModule();
    if (name === '@mioon/ui/components/button') return { Button: actual.Button };
    assert.fail(`Unexpected component dependency: ${name}`);
  }, module, module.exports);
  for (const phase of ['saved', 'error', 'conflict']) {
    const supplied = props({ preferenceStatus: { phase, pending: true, canRetry: true } });
    const html = actual.renderToStaticMarkup(actual.React.createElement(module.exports.default, supplied));
    assert.equal(html, actual.render(supplied));
  }
});

function section(start, end) {
  const first = app.indexOf(start), last = app.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing App seam: ${start}`);
  assert.equal(app.indexOf(start, first + start.length), -1, `Ambiguous App seam: ${start}`);
  return app.slice(first, last);
}
const statusSource = section('    onStatus: (projectId, status) =>', '\n  });').trim().slice('onStatus: '.length);
const contextSource = section('  const context = () =>', '  taskWorkspaceState.current =');
const settingsDepartureSource = section('  async function prepareSettingsDeparture()', '  async function changeHomePage(');
const sessionReadySource = section('  function projectSessionReady()', '  const workbenchReady =');
const selectSource = section('  async function selectProject(', '  async function reloadPreferences(');
const reloadSource = section('  async function reloadPreferences() {', '  async function boot() {');
const callsite = section('<TopbarSaveStatus ', '<>{nativeWindow ? <NativeLocatorStatus ');
assert.match(callsite, /\/>$/);
const compile = (source, expression, env) => Function(...Object.keys(env), `${source}\nreturn ${expression};`)(...Object.values(env));
let projectElement;
function appElement(env) {
  const actual = view('extracted');
  if (!projectElement) {
    const code = transformSync(`function project({ online, busy, inspectorDirty, formatDirty, annotations = { state: null }, lastSync, preferenceStatus, preferencesRef, currentProject, reloadPreferences }) { return ${callsite}; }`,
      { loader: 'jsx', jsx: 'transform' }).code;
    projectElement = compile(code, 'project', { React: actual.React, TopbarSaveStatus: actual.Component });
  }
  return projectElement(env);
}
const control = (tree, id) => nodes(tree).find(node => node.props?.['data-testid'] === id);

test('extracted real React markup is byte-equivalent to frozen shipped markup across the full matrix', () => {
  const baseline = view('baseline'), extracted = view('extracted');
  for (const online of [false, true]) for (const syncing of [false, true]) for (const dirty of [false, true]) {
    for (const phase of phases) for (const pending of [false, true]) for (const canRetry of [undefined, false, true]) {
      const supplied = props({ online, syncing, dirty, preferenceStatus: { phase, pending, canRetry } });
      const before = JSON.stringify(supplied), html = extracted.render(supplied);
      assert.equal(html, baseline.render(supplied));
      topbarExpectation(html, online, syncing, dirty);
      preferenceExpectation(html, phase, pending, canRetry);
      assert.equal(JSON.stringify(supplied), before);
    }
  }
  const supplied = props({ lastSync: stamp });
  assert.equal(extracted.render(supplied), baseline.render(supplied));
  assert.ok(extracted.render(supplied).includes(stamp.toLocaleTimeString('zh-CN')));
});

test('extracted Fragment retains exact sibling and shared Button semantics with opaque callback identity', () => {
  const actual = view('extracted'), onRetry = () => {}, onReload = () => {};
  const tree = actual.Component(props({ preferenceStatus: { phase: 'error', pending: true, canRetry: true }, onRetry, onReload }));
  assert.equal(tree.type, actual.React.Fragment);
  const siblings = actual.React.Children.toArray(tree.props.children);
  assert.deepEqual(siblings.map(child => child.type), ['div', 'div']);
  assert.deepEqual(siblings.map(child => child.props.className), ['topbar-sync', 'workspace-save-status']);
  assert.deepEqual(Object.keys(siblings[1].props).sort(), ['children', 'className', 'data-phase', 'data-testid', 'role']);
  for (const [id, handler] of [['retry-workspace-save', onRetry], ['reload-workspace-preferences', onReload]]) {
    const button = control(tree, id);
    assert.equal(button.type, actual.Button); assert.equal(button.props.variant, 'ghost');
    assert.equal(button.props.className, 'text-button'); assert.equal(button.props.type, undefined, 'Existing shared default supplies type=button');
    assert.equal(button.props.onClick, handler);
  }
});

test('parent rerender, hidden/restored status and project replacement never call recovery automatically', () => {
  const actual = view('extracted'), calls = [];
  const handlers = { onRetry: () => calls.push('retry'), onReload: () => calls.push('reload') };
  const Parent = ({ show, supplied }) => show ? actual.React.createElement(actual.Component, supplied) : null;
  for (const phase of phases) for (const show of [true, false, true]) {
    const supplied = props({ ...handlers, dirty: phase === 'error', preferenceStatus: { phase, pending: true, canRetry: true } });
    actual.renderToStaticMarkup(actual.React.createElement(Parent, { show, supplied }));
    assert.deepEqual(calls, []);
  }
  const next = props({ ...handlers, online: false, preferenceStatus: { phase: 'saved', pending: false } });
  assert.equal(actual.render(next), view('baseline').render(next));
  for (const phase of ['local', 'conflict', 'error']) {
    const tree = actual.Component(props({ ...handlers, preferenceStatus: { phase, pending: true, canRetry: true } }));
    const before = calls.length;
    control(tree, 'reload-workspace-preferences').props.onClick();
    assert.equal(calls.length, before + 1);
    if (phase === 'error') {
      control(tree, 'retry-workspace-save').props.onClick();
      assert.equal(calls.length, before + 2);
    } else assert.equal(control(tree, 'retry-workspace-save'), undefined);
  }
  assert.deepEqual(calls, ['reload', 'reload', 'reload', 'retry']);
});

test('App owns one busy projection, annotation-aware dirty status, late-bound Retry and unchanged reload fence', () => {
  assert.match(app, /import TopbarSaveStatus from '\.\/TopbarSaveStatus\.tsx';/);
  assert.equal(callsite.match(/Object\.values\(busy\)\.some\(Boolean\)/g)?.length, 1);
  assert.match(callsite, /dirty=\{inspectorDirty \|\| formatDirty \|\| Boolean\(annotations\.state\?\.dirtyCount\)\}/);
  assert.match(callsite, /onRetry=\{\(\) => preferencesRef\.current\.flush\(\{ projectId: currentProject\.current \}\)\}/);
  assert.match(callsite, /onReload=\{reloadPreferences\}/);
  assert.equal(statusSource, '(projectId, status) => { if (currentProject.current === projectId) setPreferenceStatus(status); }');
  assert.match(app, /const busy = busyByProject\[currentProject\.current \|\| 'none'\] \|\| emptyBusy;/);
  assert.match(contextSource, /captured\.projectId === currentProject\.current && captured\.epoch === navigationEpoch\.current && workspaceOriginScope\(captured\.workspace\) === workspaceOriginScope\(workspaceRef\.current\)/);
  assert.equal(reloadSource.trim(), `async function reloadPreferences() {
    const captured = context();
    if (!await confirm(msg('shell.confirm.loadSavedView'))) return;
    if (isCurrent(captured)) await selectProject(captured.projectId, false, true, true);
  }`);
  assert.equal(renderCoreMessage('zh-Hans', msg('shell.confirm.loadSavedView')), '载入已保存视图会替换当前的工作区、选择和位置。继续？');
  assert.match(selectSource, /if \(!importSession\.current\.active \|\| currentProject\.current !== id \|\| projectEpoch\.current !== epoch \|\| workspaceOriginScope\(workspaceRef\.current\) !== attempt\.workspaceScope\) return false;/);
  assert.match(selectSource, /if \(!restored\) throw Object\.assign\(localizedError\([^;]+PROJECT_VIEW_UNAVAILABLE/);
  const source = readFileSync(componentPath, 'utf8');
  assert.doesNotMatch(source, /useState|useEffect|useLayoutEffect|useRef|useMemo|\bmemo\s*\(|\bfetch\s*\(|\brpc\s*\(|setTimeout|setInterval|localStorage|sessionStorage|preferencesRef|currentProject|navigationEpoch|realConfirm|generationReview|Agent/);
  assert.doesNotMatch(source, /:\s*any\b|as\s+any\b|@ts-ignore|@ts-nocheck|\.jsx['"]/);
  assert.deepEqual([...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]), ['./i18n/I18nProvider.tsx', 'react', '@mioon/ui/components/button']);
});

const copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pump = async () => { for (let n = 0; n < 35; n++) await Promise.resolve(); };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => copy(data) });
class Storage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}
class Server {
  records = new Map(); calls = []; hook = null;
  set(projectId, state, revision = 1) { this.records.set(projectId, { projectId, revision, state: durableWorkspaceState(state) }); }
  data(projectId) { return copy(this.records.get(projectId) || { projectId, revision: 0, state: null }); }
  apply = call => {
    const current = this.data(call.projectId);
    if (call.options.method === 'GET') return response({ ok: true, data: current });
    if (current.revision === call.body.expectedRevision + 1 && JSON.stringify(current.state) === JSON.stringify(call.body.state)) return response({ ok: true, data: current });
    if (current.revision !== call.body.expectedRevision) return response({ ok: false, error: { code: 'PREFERENCES_CONFLICT' } }, 409);
    const next = { projectId: call.projectId, revision: current.revision + 1, state: copy(call.body.state) };
    this.records.set(call.projectId, next); return response({ ok: true, data: next });
  };
  fetch = async (url, options) => {
    const call = { url, projectId: decodeURIComponent(url.split('/').at(-1)), options, body: options.body ? JSON.parse(options.body) : null };
    this.calls.push(call);
    return this.hook ? this.hook(call, () => this.apply(call)) : this.apply(call);
  };
  puts() { return this.calls.filter(call => call.options.method === 'PUT'); }
}
// Executes the exact App selectProject, reloadPreferences, context, isCurrent,
// status filter and JSX call site, with the real preference controller. Only
// unrelated React setters/services and the transport are deterministic fixtures.
function harness(t) {
  const server = new Server(), state = { view: defaultWorkspaceState(), preferenceStatus: { phase: 'loading', pending: false },
    inspectorDirty: false, formatDirty: false, inspectorDraft: { title: 'retained inspector draft' }, formatDraft: { width: 1920 },
    paidReview: { token: 'unchanged paid review' }, mobilePanel: 'canvas', rightDockTab: 'properties' };
  const calls = [], currentProject = { current: null }, navigationEpoch = { current: 0 }, projectEpoch = { current: 0 };
  const env = { msg, ...createI18nTestContext(), localizedError: value => Object.assign(new Error(renderCoreMessage('zh-Hans', value)), { displayMessage: value }), nativeWindow: null, nativeProjectEntry: null, currentProject, navigationEpoch, projectEpoch, workspaceRef: { current: { restored: false } }, workspaceOriginScope,
    projectOpenAttempt, canPublishProjectOpen, projectResponseMatches, projectOpenFailureKind,
    openedProject: { current: null }, settingsNavigation: { current: createSettingsNavigationRegistry() },
    loading: false, importSession: { current: { active: true, selection: 0 } }, agentDraft: { current: false }, imageDraft: { current: false },
    guardProjectNavigation: async (_message, _dirty, canLeave) => canLeave(), confirm: async () => true,
    lastProjectRef: { current: { invalidateNavigation() {}, rememberOpened() {} } },
    requestCounter: { current: 0 }, preferencesRef: { current: null }, tasksRef: { current: { getState: () => ({}), load: async () => {} } },
    viewReady: { current: true }, viewRef: { current: state.view }, dataRef: { current: {} }, emptyData: {}, dragging: { current: false },
    pendingForProject: () => [], updateView: () => assert.fail('Selected fixtures must not trigger passive first-item selection'),
    notify: (...args) => calls.push(['notify', ...args]), readableError: error => error.message, URL,
    window: { location: { href: 'http://127.0.0.1:4318/' }, history: { pushState() {}, replaceState() {} } },
    refresh: async (id, _quiet, options) => { assert.equal(options?.opening, true); env.dataRef.current = { project: { id }, shots: [], nodes: [] }; return env.dataRef.current; },
    ...Object.fromEntries(['setProjectOpening', 'setHomePage', 'setAuth', 'setPropertiesPage', 'setTaskState', 'setPending', 'setShowProjects', 'setData', 'setNodes', 'setLoading',
      'setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch', 'setRightDockTab',
      'setShowExports', 'setComparisonId', 'setPreviewAsset', 'setRealConfirm', 'setToast', 'setMobilePanel', 'setZoom']
      .map(name => [name, value => calls.push([name, value])])),
    setPreferenceStatus: value => { state.preferenceStatus = value; calls.push(['status', copy(value)]); },
    setView: value => { state.view = value; calls.push(['view', copy(value)]); },
  };
  env.setRealConfirm = value => { state.paidReview = value; calls.push(['setRealConfirm', value]); };
  env.setShotDirty = value => { state.inspectorDirty = value; calls.push(['setShotDirty', value]); };
  env.setMobilePanel = value => { state.mobilePanel = value; calls.push(['setMobilePanel', value]); };
  const onStatus = compile('', statusSource, { currentProject, setPreferenceStatus: env.setPreferenceStatus });
  const controller = createWorkspacePreferences({ fetchImpl: server.fetch, storage: new Storage(), requestTimeoutMs: 0,
    delayMs: 60_000, maxWaitMs: 60_000, retryDelays: [], getWorkspace: () => env.workspaceRef.current, onStatus });
  env.preferencesRef.current = controller;
  t.after(() => controller.dispose({ flush: false }));
  const actions = compile(`${contextSource}\n${settingsDepartureSource}\n${sessionReadySource}\n${selectSource}\n${reloadSource}`, '{ selectProject, reloadPreferences }', env);
  const display = () => appElement({ online: true, busy: {}, inspectorDirty: state.inspectorDirty, formatDirty: state.formatDirty,
    lastSync: null, preferenceStatus: state.preferenceStatus, preferencesRef: env.preferencesRef, currentProject, reloadPreferences: actions.reloadPreferences });
  return { server, controller, state, calls, env, ...actions, display,
    html: () => view('extracted').renderToStaticMarkup(display()),
    button: id => control(view('extracted').Component(display().props), id),
    edit: (patch, immediate = true) => { const next = copy(state.view); patch(next); state.view = next; env.viewRef.current = next; controller.update(currentProject.current, next, { immediate }); },
  };
}

test('actual App ignores delayed A acknowledgement after B activation without a new write or stale visible state', async t => {
  const h = harness(t), gate = deferred();
  const second = defaultWorkspaceState(); second.canvas.selectedId = SELECTED; second.activeMode = 'editing';
  h.server.set(B, second); await h.selectProject(A, true);
  h.server.hook = (call, apply) => call.options.method === 'PUT' && call.projectId === A ? gate.promise.then(apply) : apply();
  h.edit(value => { value.editing.playhead = 72; }); await pump();
  assert.equal(h.server.puts().length, 1); assert.equal(h.state.preferenceStatus.pending, true);
  await h.selectProject(B);
  const before = copy(h.state), beforeHtml = h.html(), count = h.server.calls.length;
  gate.resolve(); await pump();
  assert.equal(h.controller.getStatus(A).phase, 'saved');
  assert.equal(h.env.currentProject.current, B); assert.equal(h.state.view.canvas.selectedId, SELECTED);
  assert.deepEqual(h.state, before); assert.equal(h.html(), beforeHtml); assert.equal(h.server.calls.length, count);
});

test('actual Reload waits for confirmation and rejects newer project, navigation or workspace context', async t => {
  for (const supersede of ['project', 'navigation', 'workspace', 'cancel', 'accept']) {
    const h = harness(t), confirmation = deferred(), prompts = [];
    // The real App function captures its supplied confirmation function once.
    h.env.confirm = message => { prompts.push(message); return confirmation.promise; };
    const actions = compile(`${contextSource}\n${settingsDepartureSource}\n${sessionReadySource}\n${selectSource}\n${reloadSource}`, '{ selectProject, reloadPreferences }', h.env);
    await actions.selectProject(A, true);
    const element = appElement({ online: true, busy: {}, inspectorDirty: false, formatDirty: false, lastSync: null,
      preferenceStatus: { phase: 'conflict', pending: true }, preferencesRef: h.env.preferencesRef,
      currentProject: h.env.currentProject, reloadPreferences: actions.reloadPreferences });
    const pending = control(view('extracted').Component(element.props), 'reload-workspace-preferences').props.onClick();
    assert.deepEqual(prompts, [msg('shell.confirm.loadSavedView')]);
    assert.deepEqual(prompts.map(value => renderCoreMessage('zh-Hans', value)), ['载入已保存视图会替换当前的工作区、选择和位置。继续？']);
    if (supersede === 'project') await actions.selectProject(B);
    if (supersede === 'navigation') { h.env.navigationEpoch.current++; h.state.view.canvas.selectedId = SELECTED; }
    if (supersede === 'workspace') h.env.workspaceRef.current = { restored: true, workspaceOrigin: B };
    const before = copy(h.state), requests = h.server.calls.length;
    confirmation.resolve(supersede !== 'cancel'); await pending;
    if (supersede === 'accept') {
      assert.equal(h.server.calls.length, requests + 1); assert.equal(h.server.calls.at(-1).options.method, 'GET');
      assert.equal(h.env.currentProject.current, A);
    } else {
      assert.deepEqual(h.state, before); assert.equal(h.server.calls.length, requests);
      assert.equal(h.env.currentProject.current, supersede === 'project' ? B : A);
    }
    assert.equal(h.server.puts().length, 0);
  }
});

test('actual Retry replays exact lost-response body and cannot clean inspector or format drafts', async t => {
  const h = harness(t); await h.selectProject(A, true);
  h.state.inspectorDirty = true; h.state.formatDirty = true; h.state.paidReview = { token: 'still reviewed' };
  const preserved = copy({ inspector: h.state.inspectorDraft, format: h.state.formatDraft, review: h.state.paidReview });
  let lost = true;
  h.server.hook = (call, apply) => { const result = apply(); if (call.options.method === 'PUT' && lost) { lost = false; throw new Error('Lost after commit'); } return result; };
  h.edit(value => { value.editing.playhead = 42; }); await pump();
  assert.equal(h.state.preferenceStatus.phase, 'error'); assert.equal(h.server.puts().length, 1);
  const first = h.server.puts()[0];
  assert.ok(h.html().includes('有未保存修改')); assert.ok(h.html().includes('视图位置未同步'));
  await h.button('retry-workspace-save').props.onClick(); await pump();
  assert.equal(h.server.puts().length, 2); const retry = h.server.puts()[1];
  assert.equal(retry.url, first.url); assert.equal(retry.options.body, first.options.body);
  for (const key of ['method', 'credentials', 'cache', 'keepalive']) assert.equal(retry.options[key], first.options[key]);
  assert.deepEqual(retry.options.headers, first.options.headers); assert.equal(h.server.data(A).revision, 1);
  assert.equal(h.state.preferenceStatus.phase, 'saved'); assert.equal(h.state.inspectorDirty, true); assert.equal(h.state.formatDirty, true);
  assert.deepEqual({ inspector: h.state.inspectorDraft, format: h.state.formatDraft, review: h.state.paidReview }, preserved);
  assert.ok(h.html().includes('有未保存修改')); assert.equal(h.button('retry-workspace-save'), undefined);
});

test('actual App Retry callback reads the current project ref at click rather than render', async t => {
  const h = harness(t); await h.selectProject(A, true);
  const calls = [], original = h.env.preferencesRef.current;
  h.env.preferencesRef.current = { ...original, flush: options => { calls.push(options); return original.flush(options); } };
  h.state.preferenceStatus = { phase: 'error', pending: true, canRetry: true };
  const oldButton = h.button('retry-workspace-save');
  await h.selectProject(B); const count = calls.length, requests = h.server.calls.length;
  await oldButton.props.onClick();
  assert.deepEqual(calls.slice(count), [{ projectId: B }]); assert.equal(h.server.calls.length, requests);
});

test('actual conflict has only Reload and passive rerenders during held saves cannot mutate drafts, panels or paid review', async t => {
  const h = harness(t), gate = deferred(); await h.selectProject(A, true);
  h.state.inspectorDirty = true; h.state.formatDirty = true; h.state.paidReview = { token: 'retained review' };
  h.server.hook = (call, apply) => call.options.method === 'PUT' ? gate.promise.then(apply) : apply();
  h.edit(value => { value.editing.playhead = 25; }); await pump();
  const before = copy(h.state), requests = h.server.calls.length;
  const actual = view('extracted');
  for (const visible of [true, false, true]) {
    actual.renderToStaticMarkup(actual.React.createElement('section', { hidden: !visible }, h.display()));
    assert.deepEqual(h.state, before); assert.equal(h.server.calls.length, requests);
  }
  // Another session wins while the authorized local write is still pending.
  const foreign = defaultWorkspaceState(); foreign.editing.playhead = 99; h.server.set(A, foreign, 1);
  gate.resolve(); await pump();
  assert.equal(h.state.preferenceStatus.phase, 'conflict'); assert.equal(h.state.preferenceStatus.canRetry, false);
  assert.equal(h.button('retry-workspace-save'), undefined); assert.ok(h.button('reload-workspace-preferences'));
  assert.equal(h.server.puts().length, 1); assert.equal(h.state.inspectorDirty, true); assert.equal(h.state.formatDirty, true);
  assert.deepEqual(h.state.inspectorDraft, before.inspectorDraft); assert.deepEqual(h.state.formatDraft, before.formatDraft);
  assert.deepEqual(h.state.paidReview, before.paidReview); assert.equal(h.state.mobilePanel, before.mobilePanel);
});

test('actual App status reports annotation drafts without broadening timeline dirty inputs', () => {
  const element = appElement({ online: true, busy: {}, inspectorDirty: false, formatDirty: false, annotations: { state: { dirtyCount: 1 } }, lastSync: null, preferenceStatus: {}, preferencesRef: { current: {} }, currentProject: { current: null }, reloadPreferences() {} });
  assert.equal(element.props.dirty, true);
  assert.match(app, /const inspectorDirty = shotDirty \|\| clipDirty \|\| sourceDirty \|\| subjectDirty \|\| subtitleDirty;/);
});
