import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { defaultWorkspaceState } from '../apps/web/src/workspace-state.js';
import { workspaceOriginScope } from '../apps/web/src/workspace-origin.js';
import { chooseInitialProject, retainLastProjectScope, createProjectBootGuard, assertLastProjectBootIdentity } from '../apps/web/src/last-project-navigation.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = readFileSync(join(root, 'apps/web/src/App.jsx'), 'utf8');
const A = '88000000-0000-4000-8000-000000000001', B = '88000000-0000-4000-8000-000000000002';
const emptyData = { project: null, shots: [], nodes: [], assets: [], versions: [], edges: [] };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source seam: ${start}`);
  assert.equal(source.indexOf(start, a + start.length), -1, `Ambiguous source seam: ${start}`);
  return source.slice(a, b);
}
const compile = (source, name, env) => Function(...Object.keys(env), `${source}\nreturn ${name};`)(...Object.values(env));
const modesMarkup = section(app, '<Tabs value={workspaceMode} onValueChange={changeMode}', '<TopbarSaveStatus ');
const emptyMarkup = section(app, '      {!data.project && !loading && <div className="canvas-empty">', '\n      {data.project && !nodes.length');
const changeSource = section(app, '  async function changeMode(', '  function revealCanvas(');
const guardSource = section(app, '  async function guardNavigation(', '  async function guardProjectNavigation(');
const updateSource = section(app, '  const updateView = useCallback(', '  const field = ');
const selectSource = section(app, '  async function selectProject(', '  async function reloadPreferences(');
const createSource = section(app, '  async function createProject(', '  async function addShot(');
const bootSource = section(app, '  async function boot() {', '  useEffect(() => {\n    bootGuard.current.activate();');

// Execute actual App JSX with the real shared Tabs/Button components. SSR checks
// emitted accessibility attributes; it does not claim browser focus/layout QA.
const uiRequire = createRequire(join(root, 'packages/ui/package.json'));
const baseRoot = dirname(dirname(uiRequire.resolve('@base-ui/react/tabs')));
const tabSource = readFileSync(join(baseRoot, 'tabs/tab/TabsTab.js'), 'utf8');
const tabClickSource = section(tabSource, '  function activate(event) {', '  function onFocus(event) {');
const fixture = `
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { Tabs, TabsList, TabsTrigger } from '@mioon/ui/components/tabs';
  import { Button } from '@mioon/ui/components/button';
  import { useButton } from ${JSON.stringify(join(baseRoot, 'internals/use-button/useButton.js'))};
  import { createChangeEventDetails } from ${JSON.stringify(join(baseRoot, 'internals/createBaseUIEventDetails.js'))};
  import { REASONS } from ${JSON.stringify(join(baseRoot, 'internals/reasons.js'))};
  const Icon = () => null;
  export function Modes({data, loading, workspaceMode, changeMode}) { return ${modesMarkup}; }
  export function Empty({data, loading, setShowCreate}) { return <>${emptyMarkup}</>; }
  export const render = props => renderToStaticMarkup(<><Modes {...props}/><Empty {...props}/></>);
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
const built = buildSync({ stdin: { contents: fixture, loader: 'jsx', resolveDir: join(root, 'apps/web') }, bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const module = { exports: {} };
Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const ui = module.exports;
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const event = key => ({ key, nativeEvent: { key }, prevented: false, preventDefault() { this.prevented = true; } });
const modeProps = f => ({ data: f.env.dataRef.current, loading: f.env.loading, workspaceMode: f.env.viewRef.current.activeMode, changeMode: f.change, setShowCreate: f.env.setShowCreate });
function openingTag(html, testId) { const tag = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0]; assert.ok(tag, testId); return tag; }
function assertDisabled(html, expected) {
  for (const id of ['workspace-canvas', 'workspace-editing']) assert.equal(/aria-disabled="true"|\sdisabled(?:="")?[\s>]/.test(openingTag(html, id)), expected, id);
}

function harness({ projectId = null, mode = 'canvas', loading = false, ready = Boolean(projectId), restored = false } = {}) {
  const calls = [], view = defaultWorkspaceState(); view.activeMode = mode;
  const env = { emptyData, loading, currentProject: { current: projectId }, projectEpoch: { current: 0 }, navigationEpoch: { current: 0 }, requestCounter: { current: 0 },
    viewRef: { current: view }, viewReady: { current: ready }, dataRef: { current: projectId ? { ...emptyData, project: { id: projectId } } : emptyData },
    workspaceRef: { current: { restored, ...(restored ? { workspaceOrigin: B } : {}) } }, importSession: { current: { active: true } }, dragging: { current: false },
    dirtyRef: { current: false }, subtitlesRef: { current: null }, clipDraftRef: { current: null }, shotTextRef: { current: null }, subjectsRef: { current: null }, agentDraft: { current: false }, imageDraft: { current: false },
    useCallback: fn => fn, workspaceOriginScope, pinNewWorkspaceIntent: (value, workspace) => ({ ...value, workspaceOrigin: workspace.workspaceOrigin }),
    confirm: async () => true, guardProjectNavigation: async () => true, readableError: e => e.message, pendingForProject: () => [], URL, URLSearchParams,
    window: { location: { href: 'http://127.0.0.1:4318/', search: '' }, history: { pushState() {}, replaceState() {} } },
    tasksRef: { current: { getState: () => ({ phase: 'idle' }), load: async () => {} } },
    preferencesRef: { current: { update: (...args) => calls.push(['preferences', ...args]), flush: async () => {}, load: async () => defaultWorkspaceState(), getStatus: () => ({ phase: 'saved' }) } },
    lastProjectRef: { current: { getState: () => ({ identityBlocked: false, revision: null }), invalidateNavigation: () => {}, rememberOpened: (...args) => calls.push(['remember', ...args]), discover: async () => null } },
    preferenceScope: { current: null }, locatorIdentity: { current: null }, migrateBrowserStorage() {}, retainWorkspaceIdentity: (_current, observed) => observed,
    retainLastProjectScope, chooseInitialProject, assertLastProjectBootIdentity,
    ...Object.fromEntries(['setView', 'setMobilePanel', 'setPreviewAsset', 'setComparisonId', 'setShowCreate', 'setProjects', 'setWorkspace', 'setAuth', 'setOnline', 'setProviders', 'setPropertiesPage', 'setTaskState', 'setPreferenceStatus', 'setPending', 'setShowProjects', 'setNodes', 'setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch', 'setRightDockTab', 'setShowExports', 'setRealConfirm', 'setToast', 'setZoom', 'notify'].map(name => [name, (...args) => calls.push([name, ...args])])),
  };
  env.setData = data => { env.dataRef.current = data; calls.push(['data', data]); };
  env.setLoading = value => { env.loading = value; calls.push(['loading', value]); };
  env.refresh = async id => { env.setData({ ...emptyData, project: { id } }); return env.dataRef.current; };
  env.context = () => ({ projectId: env.currentProject.current, epoch: env.navigationEpoch.current, workspace: env.workspaceRef.current });
  env.isCurrent = captured => captured.projectId === env.currentProject.current && captured.epoch === env.navigationEpoch.current && workspaceOriginScope(captured.workspace) === workspaceOriginScope(env.workspaceRef.current);
  env.updateView = compile(updateSource, 'updateView', env);
  env.guardNavigation = (...args) => compile(guardSource, 'guardNavigation', env)(...args);
  env.selectProject = (...args) => compile(selectSource, 'selectProject', env)(...args);
  env.bootGuard = { current: createProjectBootGuard(() => env.projectEpoch.current) }; env.bootGuard.current.activate();
  env.rpc = async operation => { calls.push(['rpc', operation]); return operation === 'workspace.restore.inspect' ? { restored: false } : []; };
  env.run = async (...args) => { calls.push(['dispatch', ...args]); return { id: A }; };
  return { env, calls, change: (...args) => compile(changeSource, 'changeMode', env)(...args), boot: () => compile(bootSource, 'boot', env)(), create: (...args) => compile(createSource, 'createProject', env)(...args) };
}

test('actual empty startup has two visibly disabled project modes and a keyboard-readable explanation', async () => {
  const f = harness(); await f.boot();
  assert.equal(f.env.currentProject.current, null); assert.equal(f.env.viewReady.current, false); assert.equal(f.env.loading, false);
  const html = ui.render(modeProps(f)); assertDisabled(html, true);
  assert.match(html, /<p id="workspace-mode-help">[^<]*创建[^<]*打开[^<]*项目[^<]*画板[^<]*剪辑/);
  const tablist = html.match(/<div[^>]*role="tablist"[^>]*>/)?.[0]; assert.ok(tablist);
  assert.match(tablist, /tabindex="0"/); assert.match(tablist, /aria-describedby="workspace-mode-help"/);
  for (const id of ['workspace-canvas', 'workspace-editing', 'empty-create-project']) assert.match(openingTag(html, id), /aria-describedby="workspace-mode-help"/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test('actual shared disabled-button click and Enter/Space handlers cannot dispatch mode changes', async () => {
  const f = harness(); await f.boot(); f.calls.length = 0;
  let changes = 0; const props = { ...modeProps(f), changeMode: (...args) => { changes++; return f.change(...args); } };
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
    assert.equal(f.calls.find(call => call[0] === 'preferences')[1], A);
    assert.equal(f.calls.some(call => call[0] === 'dispatch' || call[0] === 'rpc'), false);
    await f.change('canvas'); assert.equal(f.env.viewRef.current.activeMode, 'canvas');
    const before = f.calls.length; await f.change('canvas'); await f.change('invalid'); assert.equal(f.calls.length, before);
  }
});

test('the existing empty-state create action and actual project creation enable both modes after successful load', async () => {
  const f = harness(), tree = ui.Empty(modeProps(f));
  nodes(tree).find(node => node.props?.['data-testid'] === 'empty-create-project').props.onClick();
  assert.deepEqual(f.calls, [['setShowCreate', true]]); f.calls.length = 0;
  await f.create('第一个项目', '');
  assert.deepEqual(f.calls.find(call => call[0] === 'dispatch'), ['dispatch', 'project-create', 'project.create', { name: '第一个项目', description: '' }]);
  assert.equal(f.env.currentProject.current, A); assert.equal(f.env.viewReady.current, true); assert.equal(f.env.loading, false);
  assertDisabled(ui.render(modeProps(f)), false); await f.change('editing'); assert.equal(f.env.viewRef.current.activeMode, 'editing');
});

test('loading and not-ready guards still reject mode changes; an empty failed project remains visibly disabled', async () => {
  for (const options of [{ projectId: A, loading: true }, { projectId: A, ready: false }]) {
    const f = harness(options); await f.change('editing'); assert.deepEqual(f.calls, []); assert.equal(f.env.viewRef.current.activeMode, 'canvas');
    if (options.loading) assertDisabled(ui.render(modeProps(f)), true);
  }
  for (const stage of ['preferences', 'project']) {
    const f = harness();
    if (stage === 'preferences') f.env.preferencesRef.current.load = async () => { throw Error('Load failed'); };
    else f.env.refresh = async () => null;
    assert.equal(await f.env.selectProject(A), false); assert.equal(f.env.loading, false);
    assertDisabled(ui.render(modeProps(f)), true); const before = f.calls.filter(call => call[0] === 'preferences').length;
    await f.change('editing'); assert.equal(f.calls.filter(call => call[0] === 'preferences').length, before);
  }
});

test('late project preference replies cannot enable a superseded or disposed owner', async () => {
  for (const outcome of ['resolve', 'reject', 'dispose']) {
    const f = harness(), gate = deferred(); f.env.preferencesRef.current.load = () => gate.promise;
    const opening = f.env.selectProject(A); await new Promise(setImmediate);
    assertDisabled(ui.render(modeProps(f)), true);
    if (outcome === 'dispose') f.env.importSession.current.active = false;
    else { f.env.currentProject.current = B; f.env.projectEpoch.current++; }
    const start = f.calls.length;
    if (outcome === 'reject') gate.reject(Error('Old load failed')); else gate.resolve(defaultWorkspaceState());
    assert.equal(await opening, false); assert.equal(f.env.viewReady.current, false);
    assert.deepEqual(f.calls.slice(start), []); assertDisabled(ui.render(modeProps(f)), true);
  }
});

test('a late discard confirmation cannot switch a replacement project or persist its mode', async () => {
  for (const changeOwner of [f => { f.env.currentProject.current = B; f.env.navigationEpoch.current++; }, f => { f.env.workspaceRef.current = { restored: true, workspaceOrigin: B }; }]) {
    const f = harness({ projectId: A }), gate = deferred(); f.env.dirtyRef.current = true; f.env.confirm = () => gate.promise;
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
