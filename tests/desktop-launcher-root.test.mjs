import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildSync, transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = name => readFileSync(join(root, 'apps/web/src', name), 'utf8');
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const find = (tree, id) => { const node = nodes(tree).find(node => node.props?.['data-testid'] === id); assert.ok(node, id); return node; };
function homeHarness(patch = {}) {
  const actual = createRequire(join(root, 'apps/web/package.json'))('react');
  const slots = [], reports = []; let cursor = 0;
  const react = { ...actual, useId: () => `id-${cursor++}`,
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useRef(value) { return slots[cursor++] ||= { current: value }; },
  };
  const module = { exports: {} };
  Function('require', 'module', 'exports', transformSync(source('ProjectHome.tsx'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(name => {
    if (name === 'react') return react;
    return Object.fromEntries(['Button', 'Input', 'Textarea', 'Label'].map(key => [key, key.toLowerCase()]));
  }, module, module.exports);
  const props = { projects: [], phase: 'home', busy: false, listBusy: false, page: 'projects', onPage() {}, onOpen() {}, onRetry() {}, onRefresh() {}, onCreate: async () => true, settings: null, onCreateStateChange: state => reports.push(state), ...patch };
  return { reports, render(next = {}) { Object.assign(props, next); cursor = 0; return module.exports.default(props); } };
}
test('native launcher create restriction is explained before form and also guards stale handlers', async () => {
  const h = homeHarness(); const original = find(h.render(), 'project-home-create-toggle');
  const disabled = h.render({ createDisabledReason: '请先关闭当前编辑窗口。' });
  assert.equal(find(disabled, 'project-home-create-toggle').props.disabled, true); assert.ok(find(disabled, 'project-home-create-disabled'));
  original.props.onClick(); assert.equal(nodes(h.render()).some(node => node.props?.['data-testid'] === 'project-home-create-form'), false);
});
test('local draft P0 metadata reports synchronously without name or description payloads', async () => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const h = homeHarness({ onCreate: () => pending });
  find(h.render(), 'project-home-create-toggle').props.onClick();
  find(h.render(), 'project-home-name').props.onChange({ target: { value: 'private story title' } });
  assert.equal(h.reports.at(-1).dirty, true); const first = h.reports.at(-1).version;
  find(h.render(), 'project-home-name').props.onChange({ target: { value: 'second title' } });
  assert.ok(h.reports.at(-1).version > first); assert.deepEqual(Object.keys(h.reports.at(-1)).sort(), ['busy', 'dirty', 'version']);
  const work = find(h.render(), 'project-home-create-form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.reports.at(-1).busy, true); finish(false); await work;
  assert.equal(h.reports.at(-1).busy, false); assert.equal(h.reports.at(-1).dirty, true);
  assert.doesNotMatch(JSON.stringify(h.reports), /private story title|second title/);
});
test('host busy presentation alone does not republish local create metadata', () => {
  const h = homeHarness(); h.render(); const initial = h.reports.at(-1);
  h.render({ busy: true, createDisabledReason: '应用正在退出，暂不能新建项目。' });
  h.render({ busy: false, createDisabledReason: '' });
  assert.equal(h.reports.length, 1); assert.equal(h.reports.at(-1), initial);
});
test('typed launcher dependency graph never imports App, editor controllers or legacy settings forms', () => {
  const result = buildSync({ entryPoints: [join(root, 'apps/web/src/LauncherRoot.tsx')], bundle: true, platform: 'browser', write: false, metafile: true, loader: { '.css': 'empty' } });
  const paths = Object.keys(result.metafile.inputs);
  for (const forbidden of ['/App.jsx', '/AgentWorkspace.jsx', '/ImageGeneration.jsx', '/use-subjects.js', '/AgentSettings.jsx', '/ImageSettings.jsx', '/ComfyImageSettings.jsx']) assert.equal(paths.some(path => path.endsWith(forbidden)), false, forbidden);
});
test('root glue has no role URL branch and supplies editor only for verified editor context', () => {
  const rootSource = source('DesktopRoot.tsx');
  assert.doesNotMatch(rootSource, /URLSearchParams|[?&]role/);
  assert.match(rootSource, /host\.context\.role === 'launcher'/); assert.match(rootSource, /renderEditor\(host\.context, host\.bridge\)/);
  const launcher = source('LauncherRoot.tsx');
  assert.match(launcher, /installNativeCloseAdmission/); assert.match(launcher, /document\.visibilityState !== 'hidden'/); assert.match(launcher, /settings\.canLeave\(ticket\.settings\)/);
});

// Exercise the actual launcher callback boundary. The existing forms remain
// outside this host, and their close helper rechecks before cleanup/onClose.
import { createSettingsNavigationRegistry, closeSettingsAfterPermission } from '../apps/web/src/settings-navigation-state.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import { createLauncherCloseSettings, createLauncherController } from '../apps/web/src/launcher-state.ts';
function launcherHarness(confirm = async () => true, options = {}) {
  const actual = createRequire(join(root, 'apps/web/package.json'))('react');
  const slots = [], effects = [], handlers = new Map(); let cursor = 0, admission;
  const react = { ...actual,
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = typeof value === 'function' ? value() : value; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useRef(value) { return slots[cursor++] ||= { current: value }; },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || !dependencies || dependencies.some((value, offset) => !Object.is(value, previous.dependencies?.[offset]))) {
        const current = { dependencies, cleanup: undefined }; slots[index] = current;
        effects.push(() => { previous?.cleanup?.(); current.cleanup = fn(); });
      }
    },
  };
  let context = { version: 1, contextId: 'launcher', backendId: 'backend', role: 'launcher', initialProjectId: null, autoOpen: false,
    editorProjectId: null, editorPhase: 'none', quitting: false, settingsVersion: 0, settingsSlot: null, ...options.context };
  const state = { projects: [], workspace: { restored: false }, phase: 'home', openingProjectId: null, error: '', notice: '', creating: false, createUnknown: false, listBusy: false, listError: '', version: 0 };
  let controller = { getState: () => state, getContext: () => context, activate() {}, dispose() {}, boot: async () => {}, interacted() {}, updateContext() {}, refresh: async () => {}, open: async () => true, create: async () => true };
  const subscribers = new Set();
  const bridge = { context: async () => context, openProject: async () => ({ ok: true, reason: 'accepted' }),
    subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback); } };
  const module = { exports: {} }, window = { location: { search: '', href: 'http://localhost/' } }, document = { visibilityState: 'visible', addEventListener(name, fn) { handlers.set(name, fn); }, removeEventListener() {} };
  const map = {
    react, '@mioon/ui/components/workbench-confirm': { useConfirmation: () => confirm }, './ProjectHome.tsx': { default: 'project-home' }, './LastProjectStatus.tsx': { default: 'locator-status' },
    './last-project-state.ts': { createLastProjectController: () => ({ getState: () => ({ identityBlocked: false, revision: null }), activate() {}, dispose() {}, discover: async () => null }) },
    './settings-navigation-state.ts': { createSettingsNavigationRegistry },
    './native-close-state.ts': { createNativeCloseRegistry, installNativeCloseAdmission: (_window, settings) => { if (options.nativeAdmission) admission = createNativeCloseAdmission({ ...settings, now: () => 1, newToken: () => 'launcher-close-token' }); return () => {}; } },
    './launcher-state.ts': {
      createLauncherClient: () => options.client ?? { inspect: async () => ({ restored: false, workspaceOrigin: null }), list: async () => [] },
      createLauncherController: settings => options.realController ? (controller = createLauncherController(settings)) : controller,
      createLauncherCloseSettings, launcherCreateDisabledReason: () => '',
    },
    './project-home.css': {},
  };
  Function('require', 'module', 'exports', 'window', 'document', transformSync(source('LauncherRoot.tsx'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(name => { assert.ok(Object.hasOwn(map, name), name); return map[name]; }, module, module.exports, window, document);
  let settings;
  const h = { get context() { return context; }, document, handlers, get state() { return controller.getState(); }, controller: () => controller,
    admission: () => admission, drain: () => window.__mioonFlushWorkspacePreferences(), settings: () => settings,
    render() { cursor = 0; return module.exports.default({ context, bridge, rpc() {}, contractChecks: {}, renderSettings: props => { settings = props; return null; } }); },
    flushEffects() { effects.splice(0).forEach(effect => effect()); },
    hostContext(patch, { render = true, effects = true } = {}) {
      context = { ...context, ...patch };
      subscribers.forEach(callback => callback(context));
      if (render) h.render(); if (effects) h.flushEffects();
    },
    hostIntent(slot, timing) { h.hostContext({ settingsSlot: slot, settingsVersion: context.settingsVersion + 1 }, timing); },
    mount() { h.render(); h.flushEffects(); return h.render(); },
  };
  return h;
}
test('authorized settings close accepts same-stack secret cleanup, but changed input cancels before cleanup', async () => {
  const h = launcherHarness(); let home = h.mount(); await home.props.onPage('settings'); home = h.render(); assert.equal(home.props.page, 'settings');
  const settings = h.settings(), owner = settings.registry.register('home:agent'); let version = 1;
  const publish = dirty => owner.update({ dirty, busy: false, blocked: false, version: version++ }); publish(true);
  const capturedVersion = version;
  await closeSettingsAfterPermission(settings.beforeClose, () => capturedVersion === version, () => { publish(false); settings.onClose(); });
  assert.equal(h.render().props.page, 'projects');

  let resolve; const confirmation = new Promise(yes => { resolve = yes; }); const changed = launcherHarness(() => confirmation);
  home = changed.mount(); await home.props.onPage('settings'); changed.render();
  const live = changed.settings(), registration = live.registry.register('home:agent');
  registration.update({ dirty: true, busy: false, blocked: false, version: 1 });
  let cleared = false; const pending = closeSettingsAfterPermission(live.beforeClose, () => true, () => { cleared = true; live.onClose(); });
  registration.update({ dirty: true, busy: false, blocked: false, version: 2 }); resolve(true); await pending;
  assert.equal(cleared, false); assert.equal(changed.render().props.page, 'settings');
});
test('keep-alive settings selection is synchronous and does not release another owner', async () => {
  const h = launcherHarness(); const home = h.mount(); await home.props.onPage('settings'); h.render();
  const settings = h.settings(), owner = settings.registry.register('home:agent'); owner.update({ dirty: true, busy: false, blocked: false, version: 1 });
  settings.onSelect('custom'); h.render(); assert.equal(h.settings().selected, 'custom');
  assert.equal(settings.registry.capture().some(entry => entry.slot === 'home:agent' && entry.dirty), true);
  h.document.visibilityState = 'hidden'; h.handlers.get('visibilitychange')(); h.render(); assert.equal(h.settings().visible, false);
});

test('a superseded initial context rejection cannot unmount an owner established by a newer host event', async () => {
  const actual = createRequire(join(root, 'apps/web/package.json'))('react');
  const slots = [], effects = []; let cursor = 0, receive, reject;
  const pending = new Promise((_resolve, no) => { reject = no; });
  const bridge = { subscribe: callback => { receive = callback; return () => {}; }, context: () => pending };
  const react = { ...actual,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useEffect(fn) { const index = cursor++; if (!(index in slots)) { slots[index] = true; effects.push(fn); } },
  };
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'window', transformSync(source('DesktopRoot.tsx'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(name => {
    if (name === 'react') return react;
    if (name === './LauncherRoot.tsx') return { default: 'launcher' };
    if (name === './desktop-window-client.ts') return { readDesktopWindowBridge: () => bridge };
    assert.fail(name);
  }, module, module.exports, {});
  const render = () => { cursor = 0; return module.exports.default({ rpc() {}, contractChecks: {}, renderWeb: () => actual.createElement('web'), renderEditor: () => actual.createElement('editor'), renderSettings: () => null }); };
  render(); effects.splice(0).forEach(effect => effect());
  receive({ contextId: 'current-owner', role: 'editor' });
  assert.ok(nodes(render()).some(node => node.type === 'editor'));
  reject(new Error('superseded describe failed')); await new Promise(setImmediate);
  assert.ok(nodes(render()).some(node => node.type === 'editor'));
});


test('actual launcher creation uncertainty reaches close-only risk admission without becoming success or replay', async () => {
  const h = launcherHarness(async () => true, { nativeAdmission: true }); const home = h.mount();
  h.state.createUnknown = true; h.state.version++;
  const admission = h.admission();
  assert.equal(admission.inspect().disposition, 'unknown');
  home.props.onCreateStateChange({ dirty: true, busy: false, version: 1 });
  const dirty = admission.inspect(); assert.equal(dirty.disposition, 'unknown-dirty');
  assert.equal(admission.commit(dirty.token, { discardDirty: true, allowDrainFailure: false, expiresAt: 1000 }), false);
  assert.equal(await h.drain(), false); assert.equal(h.state.createUnknown, true);
  assert.equal(admission.inspect('reload', 'http://localhost/').disposition, 'blocked');
  let prevented = false;
  assert.equal(admission.beforeUnload({ preventDefault() { prevented = true; }, returnValue: '' }), false); assert.equal(prevented, true);
  const approved = admission.inspect();
  assert.equal(admission.commit(approved.token, { discardDirty: true, allowDrainFailure: false, allowUnknown: true, expiresAt: 1000 }), true);
  assert.equal(admission.beforeUnload({ preventDefault() { assert.fail('Explicit same-owner risk close should pass once'); }, returnValue: '' }), true);
  assert.equal(h.state.createUnknown, true); assert.equal(await home.props.onCreate('another story', ''), false);
});

test('actual launcher unknown close cannot waive busy settings or changes to the captured creation identity', () => {
  const h = launcherHarness(async () => true, { nativeAdmission: true }); const home = h.mount();
  h.state.createUnknown = true; h.state.version++;
  const admission = h.admission(), first = admission.inspect();
  h.state.version++;
  assert.equal(admission.commit(first.token, { discardDirty: false, allowDrainFailure: false, allowUnknown: true, expiresAt: 1000 }), false);
  home.props.onCreateStateChange({ dirty: true, busy: true, version: 1 }); assert.equal(admission.inspect().disposition, 'blocked');
  home.props.onCreateStateChange({ dirty: true, busy: false, version: 2 });
  const form = h.settings().registry.register('home:agent'); form.update({ dirty: false, busy: false, blocked: true, version: 1 });
  assert.equal(admission.inspect().disposition, 'blocked');
  form.update({ dirty: false, busy: true, blocked: false, version: 2 }); assert.equal(admission.inspect().disposition, 'blocked');
});


const launcherTick = () => new Promise(setImmediate);
for (const editorPhase of ['none', 'ready']) {
  for (const delivery of ['before inspect', 'after inspect']) {
    test(`real launcher ${editorPhase} quit context ${delivery} and deferred prop effect preserve the close capture`, async () => {
      const h = launcherHarness(async () => true, { nativeAdmission: true, realController: true,
        context: { editorPhase, editorProjectId: editorPhase === 'ready' ? 'editor' : null } });
      h.mount(); await launcherTick(); h.render(); h.flushEffects();
      const before = h.state;
      if (delivery === 'before inspect') h.hostContext({ quitting: true }, { effects: false });
      const admission = h.admission(), ticket = admission.inspect();
      assert.equal(ticket.disposition, 'clean');
      if (delivery === 'after inspect') h.hostContext({ quitting: true }, { effects: false });
      // The same host context reaches the real controller a second time through
      // LauncherRoot's deferred prop effect, between native inspect and commit.
      h.flushEffects();
      assert.equal(h.controller().getContext().quitting, true);
      assert.equal(await h.drain(), true);
      assert.equal(admission.commit(ticket.token, { discardDirty: false, allowDrainFailure: false, expiresAt: 1000 }), true);
      assert.equal(h.state, before, 'presentation-only host delivery must not invent a controller mutation');
      assert.equal(admission.beforeUnload({ preventDefault() { assert.fail('Unchanged launcher must close'); }, returnValue: '' }), true);
    });
  }
}

test('real launcher keeps exact input and settings fences across quit context deliveries', async () => {
  for (const change of ['create-input', 'settings-input', 'settings-intent', 'busy-settings']) {
    const h = launcherHarness(async () => true, { nativeAdmission: true, realController: true });
    h.mount(); await launcherTick(); let home = h.render(); h.flushEffects();
    const owner = h.settings().registry.register('home:agent');
    owner.update({ dirty: false, busy: false, blocked: false, version: 1 });
    h.hostContext({ quitting: true }, { effects: false });
    const admission = h.admission(), ticket = admission.inspect(); assert.equal(ticket.disposition, 'clean');
    if (change === 'create-input') home.props.onCreateStateChange({ dirty: true, busy: false, version: 1 });
    if (change === 'settings-input') owner.update({ dirty: true, busy: false, blocked: false, version: 2 });
    if (change === 'settings-intent') h.hostIntent('agent', { effects: false });
    if (change === 'busy-settings') owner.update({ dirty: false, busy: true, blocked: false, version: 2 });
    h.flushEffects();
    assert.equal(admission.commit(ticket.token, { discardDirty: true, allowDrainFailure: false, expiresAt: 1000 }), false, change);
    let prevented = false;
    if (change !== 'settings-intent') {
      assert.equal(admission.beforeUnload({ preventDefault() { prevented = true; }, returnValue: '' }), false, change);
      assert.equal(prevented, true, change);
    }
  }
});

test('real launcher quit presentation cannot waive active creation or its unknown-result risk permission', async () => {
  const pending = Promise.withResolvers();
  const h = launcherHarness(async () => true, { nativeAdmission: true, realController: true,
    client: { inspect: async () => ({ restored: false, workspaceOrigin: null }), list: async () => [], create: () => pending.promise } });
  h.mount(); await launcherTick(); h.render(); h.flushEffects();
  const work = h.controller().create('new project', ''); await launcherTick();
  h.hostContext({ quitting: true }, { effects: false });
  const admission = h.admission(); assert.equal(admission.inspect().disposition, 'blocked');
  pending.reject(new Error('Result unknown')); assert.equal(await work, false);
  const unknown = admission.inspect(); assert.equal(unknown.disposition, 'unknown');
  assert.equal(admission.commit(unknown.token, { discardDirty: false, allowDrainFailure: false, expiresAt: 1000 }), false);
  assert.equal(admission.inspect('reload', 'http://localhost/').disposition, 'blocked');
  const approved = admission.inspect(); h.flushEffects();
  assert.equal(admission.commit(approved.token, { discardDirty: false, allowDrainFailure: false, allowUnknown: true, expiresAt: 1000 }), true);
  assert.equal(h.state.createUnknown, true); assert.equal(await h.drain(), false);
  assert.equal(admission.beforeUnload({ preventDefault() { assert.fail('Same unknown-result owner was explicitly approved'); }, returnValue: '' }), true);
});

test('explicit projects intent returns locally selected settings to projects', async () => {
  const h = launcherHarness(); let home = h.mount(); home.props.onPage('settings'); await launcherTick();
  home = h.render(); h.flushEffects(); assert.equal(home.props.page, 'settings');
  h.hostIntent(null); await launcherTick(); assert.equal(h.render().props.page, 'projects');
});
test('explicit projects intent keeps cancelled settings until another explicit request', async () => {
  let confirmations = 0; const h = launcherHarness(async () => ++confirmations > 1);
  h.mount().props.onPage('settings'); await launcherTick(); h.render(); h.flushEffects();
  const owner = h.settings().registry.register('home:agent'); owner.update({ dirty: true, busy: false, blocked: false, version: 1 });
  h.hostIntent(null); await launcherTick(); assert.equal(confirmations, 1); assert.equal(h.render().props.page, 'settings');
  h.flushEffects(); await launcherTick(); assert.equal(confirmations, 1);
  h.hostIntent(null); await launcherTick(); assert.equal(confirmations, 2); assert.equal(h.render().props.page, 'projects');
});
test('explicit projects intent cannot leave busy or unresolved settings and can leave restored settings', async () => {
  for (const flags of [{ busy: true, blocked: false }, { busy: false, blocked: true }]) {
    let confirmations = 0; const h = launcherHarness(async () => { confirmations++; return true; });
    h.mount().props.onPage('settings'); await launcherTick(); h.render(); h.flushEffects();
    h.settings().registry.register('home:agent').update({ dirty: true, ...flags, version: 1 });
    h.hostIntent(null); await launcherTick(); assert.equal(h.render().props.page, 'settings'); assert.equal(confirmations, 0);
  }
  const restored = launcherHarness(); restored.mount().props.onPage('settings'); await launcherTick();
  restored.state.workspace = { restored: true }; restored.render(); restored.flushEffects();
  restored.hostIntent(null); await launcherTick(); assert.equal(restored.render().props.page, 'projects');
});
test('explicit settings intent invalidates older projects confirmation before React receives the new context', async () => {
  let answer; const h = launcherHarness(() => new Promise(resolve => { answer = resolve; }));
  h.mount().props.onPage('settings'); await launcherTick(); h.render(); h.flushEffects();
  h.settings().registry.register('home:agent').update({ dirty: true, busy: false, blocked: false, version: 1 });
  h.render().props.onPage('projects'); await launcherTick(); assert.equal(typeof answer, 'function');
  h.hostIntent('agent', { render: false, effects: false }); answer(true); await launcherTick();
  assert.equal(h.render().props.page, 'settings', 'new native same-slot intent must fence the older permission before a React effect');
  h.flushEffects(); await launcherTick(); assert.equal(h.render().props.page, 'settings');
});
test('explicit local choice invalidates an older projects confirmation before awaiting its own permission', async () => {
  let answer, confirmations = 0;
  const h = launcherHarness(() => ++confirmations === 1 ? new Promise(resolve => { answer = resolve; }) : Promise.resolve(false));
  h.mount().props.onPage('settings'); await launcherTick(); h.render(); h.flushEffects();
  h.settings().registry.register('home:agent').update({ dirty: true, busy: false, blocked: false, version: 1 });
  h.render().props.onPage('projects'); await launcherTick();
  h.render().props.onPage('settings'); answer(true); await launcherTick();
  assert.equal(h.render().props.page, 'settings');
});

test('a newer local slot choice wins over a received projects intent whose React effect is still pending', async () => {
  let confirmations = 0; const h = launcherHarness(async () => { confirmations++; return true; });
  h.mount().props.onPage('settings'); await launcherTick(); h.render(); h.flushEffects();
  h.settings().registry.register('home:agent').update({ dirty: true, busy: false, blocked: false, version: 1 });
  h.hostIntent(null, { render: false, effects: false });
  h.settings().onSelect('custom'); h.render(); h.flushEffects(); await launcherTick();
  assert.equal(h.render().props.page, 'settings'); assert.equal(h.settings().selected, 'custom'); assert.equal(confirmations, 0);
});
