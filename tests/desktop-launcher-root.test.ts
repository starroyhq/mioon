import { i18nTestModule, renderMessage } from './helpers/i18n.ts';
import * as i18nCore from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildSync, transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = (name: string): string => readFileSync(join(root, 'apps/web/src', name), 'utf8');
interface FakeProps {'data-testid'?: string; children?: unknown; disabled?: boolean; value?: string; type?: unknown;
  onClick?: () => void; onChange?: (event: {target: {value: string}}) => void;
  onSubmit?: (event: {preventDefault(): void}) => Promise<boolean> | boolean; [key: string]: unknown}
interface FakeNode {props: FakeProps; type?: unknown}
interface CreateReport {dirty: boolean; busy: boolean; version: number}
type ReactLike = Record<string, unknown>;
const nodes = (value: unknown): FakeNode[] => Array.isArray(value) ? value.flatMap(nodes)
  : value && typeof value === 'object' ? [{props: (((value as {props?: unknown}).props ?? {}) as FakeProps)},
    ...nodes(((value as {props?: FakeProps}).props)?.children)] : [];
const find = (tree: unknown, id: string): FakeNode => { const node = nodes(tree).find(node => node.props?.['data-testid'] === id); assert.ok(node, id); return node; };
function homeHarness(patch: Record<string, unknown> = {}) {
  const actual: ReactLike = createRequire(join(root, 'apps/web/package.json'))('react');
  const slots: unknown[] = [], reports: CreateReport[] = []; let cursor = 0;
  const react = { ...actual, useId: (): string => `id-${cursor++}`,
    useState(value: unknown): [unknown, (next: unknown) => void] {
      const index = cursor++; if (!(index in slots)) slots[index] = value;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slots[index]) : next; }]; },
    useMemo<T>(factory: () => T, deps: readonly unknown[]): T { const index=cursor++, old=slots[index] as {deps:readonly unknown[];value:T}|undefined; if(!old||deps.some((value,at)=>!Object.is(value,old.deps[at])))slots[index]={deps,value:factory()}; return (slots[index] as {value:T}).value; },
    useRef(value: unknown): {current: unknown} { const index = cursor++; if (!(index in slots)) slots[index] = { current: value }; return slots[index] as {current: unknown}; },
    useEffect(): void { cursor++; },
  };
  const module: {exports: {default?: unknown}} = { exports: {} };
  Function('require', 'module', 'exports', transformSync(source('ProjectHome.tsx'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)((name: string) => {
    if (name === 'react') return react;
    if (name.endsWith('/i18n/I18nProvider.tsx')) return i18nTestModule();
    if (name.includes('packages/i18n/src/index.ts')) return i18nCore;
    if (name === './LanguageControl.tsx') return { default: () => null };
    return Object.fromEntries(['Button', 'Input', 'Textarea', 'Label', 'Dialog', 'WorkbenchButton', 'WorkbenchIcon', 'WorkbenchDialogContent'].map(key => [key, key.toLowerCase()]));
  }, module, module.exports);
  const props: Record<string, unknown> = { projects: [], phase: 'home', busy: false, listBusy: false, page: 'projects', onPage() {}, onOpen() {}, onRetry() {}, onRefresh() {}, onCreate: async () => true, settings: null,
    onCreateStateChange: (state: CreateReport) => reports.push(state), ...patch };
  return { reports, render(next: Record<string, unknown> = {}): FakeNode { Object.assign(props, next); cursor = 0;
    return (module.exports.default as (value: Record<string, unknown>) => FakeNode)(props); } };
}
test('native launcher create restriction is explained before form and also guards stale handlers', async () => {
  const h = homeHarness(); const original = find(h.render(), 'project-home-create-toggle');
  const disabled = h.render({ createDisabledReason: '请先关闭当前编辑窗口。' });
  assert.equal(find(disabled, 'project-home-create-toggle').props.disabled, true); assert.ok(find(disabled, 'project-home-create-disabled'));
  original.props.onClick!(); assert.equal(nodes(h.render()).some(node => node.props?.['data-testid'] === 'project-home-create-form'), false);
});
test('local draft P0 metadata reports synchronously without name or description payloads', async () => {
  let finish!: (value: boolean) => void; const pending = new Promise<boolean>(resolve => { finish = resolve; });
  const h = homeHarness({ onCreate: () => pending });
  find(h.render(), 'project-home-create-toggle').props.onClick!();
  find(h.render(), 'project-home-name').props.onChange!({ target: { value: 'private story title' } });
  assert.equal(h.reports.at(-1)!.dirty, true); const first = h.reports.at(-1)!.version;
  find(h.render(), 'project-home-name').props.onChange!({ target: { value: 'second title' } });
  assert.ok(h.reports.at(-1)!.version > first); assert.deepEqual(Object.keys(h.reports.at(-1)!).sort(), ['busy', 'dirty', 'version']);
  const work = find(h.render(), 'project-home-create-form').props.onSubmit!({ preventDefault() {} });
  assert.equal(h.reports.at(-1)!.busy, true); finish(false); await work;
  assert.equal(h.reports.at(-1)!.busy, false); assert.equal(h.reports.at(-1)!.dirty, true);
  assert.doesNotMatch(JSON.stringify(h.reports), /private story title|second title/);
});
test('host busy presentation alone does not republish local create metadata', () => {
  const h = homeHarness(); h.render(); const initial = h.reports.at(-1)!;
  h.render({ busy: true, createDisabledReason: '应用正在退出，暂不能新建项目。' });
  h.render({ busy: false, createDisabledReason: '' });
  assert.equal(h.reports.length, 1); assert.equal(h.reports.at(-1), initial);
});
test('typed launcher dependency graph never imports App, editor controllers or legacy settings forms', () => {
  const result = buildSync({ entryPoints: [join(root, 'apps/web/src/LauncherRoot.tsx')], bundle: true, platform: 'browser', write: false, metafile: true, loader: { '.css': 'empty' } });
  const paths = Object.keys(result.metafile.inputs);
  for (const forbidden of ['/App.tsx', '/AgentWorkspace.tsx', '/ImageGeneration.tsx', '/use-subjects.ts', '/AgentSettings.tsx', '/ImageSettings.tsx', '/ComfyImageSettings.tsx']) assert.equal(paths.some(path => path.endsWith(forbidden)), false, forbidden);
});

test('root mounts all three verified native roles without project-role URL authority', () => {
  const text = source('DesktopRoot.tsx');
  assert.doesNotMatch(text, /URLSearchParams|[?&]role/);
  assert.match(text, /host\.context\.role === 'launcher'/); assert.match(text, /host\.context\.role === 'settings'/);
  assert.match(text, /<NativeEditorRoot/);
  assert.doesNotMatch(source('LauncherRoot.tsx'), /renderSettings\(/);
  assert.match(source('SettingsRoot.tsx'), /installNativeCloseAdmission/);
  assert.match(source('NativeEditorRoot.tsx'), /renderEditor\(context, bridge, entry\)/);
});

test('empty native home moves only a settled locator summary into Help and retains every recovery state', () => {
  function render(entryPatch: Record<string, unknown> = {}, locatorPatch: Record<string, unknown> = {}): FakeNode {
    const entry = {projects: [], workspace: {restored: false}, listBusy: false, listError: '', phase: 'home', ...entryPatch};
    const locatorState = {phase: 'idle', targetStatus: 'unset', uncertain: false, identityBlocked: false, ...locatorPatch};
    const locator = {getState: () => locatorState}, controller = {getState: () => entry};
    const react = {
      createElement: (type: unknown, props: FakeProps | null, ...children: unknown[]): FakeNode => ({type, props: {...props, children}}),
      useState: (value: unknown): [unknown, () => void] => [typeof value === 'function' ? (value as () => unknown)() : value, () => {}],
      useRef: (value: unknown): {current: unknown} => ({current: value}), useEffect() {},
    };
    const module: {exports: {default?: (props: unknown) => FakeNode}} = {exports: {}};
    const dependencies: Record<string, unknown> = {
      react,
      './last-project-state.ts': {createLastProjectController: () => locator},
      './LastProjectStatus.tsx': {__esModule: true, default: 'locator-status'},
      './native-close-state.ts': {createNativeCloseRegistry: () => ({}), installNativeCloseAdmission() {}},
      './settings-navigation-state.ts': {createSettingsNavigationRegistry: () => ({})},
      './native-project-entry.ts': {useNativeProjectEntry: () => controller},
      './ProjectEntry.tsx': {__esModule: true, default: 'entry'},
      './native-locator-state.ts': {createNativeLocatorOwner: () => ({})},
    };
    Function('require', 'module', 'exports', transformSync(source('LauncherRoot.tsx'), {loader: 'tsx', format: 'cjs', jsx: 'transform'}).code)((name: string) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected launcher dependency: ${name}`); return dependencies[name];
    }, module, module.exports);
    return module.exports.default!({context: {}, bridge: {}, rpc() {}, contractChecks: {}});
  }
  for (const phase of ['idle', 'saved']) {
    const tree = render({}, {phase}); assert.equal(tree.props.status, undefined); assert.ok(tree.props.help);
  }
  const retained = [
    render({projects: [{id: 'project'}]}), render({workspace: {restored: true}}), render({listBusy: true}), render({listError: 'Read failed'}), render({phase: 'error'}),
    ...['loading', 'pending', 'error', 'conflict', 'unavailable'].map(phase => render({}, {phase})),
    render({}, {uncertain: true}), render({}, {identityBlocked: true}), render({}, {targetStatus: 'missing'}),
  ];
  for (const tree of retained) {assert.ok(tree.props.status); assert.equal(tree.props.status, tree.props.help);}
});
test('entry form stale handlers cannot mutate while sealed before React rerenders disabled props', () => {
  let allowed = true;
  const h = homeHarness({ canMutateEntry: () => allowed });
  find(h.render(), 'project-home-create-toggle').props.onClick!();
  const input = find(h.render(), 'project-home-name'); const toggle = find(h.render(), 'project-home-create-toggle');
  const before = h.reports.length; allowed = false;
  input.props.onChange!({ target: { value: 'late secret title' } }); toggle.props.onClick!();
  assert.equal(h.reports.length, before); assert.equal(find(h.render(), 'project-home-name').props.value, '');
});
test('native settings slot delegates before existing key clearing; Web fallback remains present', () => {
  for (const file of ['ImageSettings.tsx', 'ComfyImageSettings.tsx']) assert.match(source(file), /onRequestSelectSlot/);
  const image = source('ImageSettings.tsx');
  assert.ok(image.indexOf('if (onRequestSelectSlot)') < image.indexOf("setKeyNotice(message('image.settings.keySwitched"));
  assert.match(image, /onRequestSelectSlot\(next\); return;/);
  assert.match(source('ComfyImageSettings.tsx'), /else leave\(\(\) => onSelectSlot\(slot\), undefined\)/);
  assert.match(source('SettingsRoot.tsx'), /window\.close\(\); return false/);
});

import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { createSettingsWindowNavigation } from '../apps/web/src/settings-window-state.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import type {ProjectWindowContext} from '../apps/web/src/desktop-window-client.ts';
const uuid = (n: number) => `68000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = (patch: Record<string, unknown> = {}): ProjectWindowContext => ({ version: 2, role: 'settings', windowId: uuid(1), contextId: uuid(2), backendId: uuid(3), initialProjectId: null, autoOpen: false,
  editorProjectId: null, editorPhase: 'none', editorCount: 2, entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: 'agent', settingsVersion: 1,
  selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false, ...patch }) as ProjectWindowContext;
const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
function settingsFixture(confirm: () => Promise<boolean> = async () => true) {
  const registry = createSettingsNavigationRegistry();
  const registration = registry.register('agent');
  registration.update({ dirty: false, busy: false, blocked: false, version: 1 });
  const navigation = createSettingsWindowNavigation({ context: context(), registry, confirm });
  return { registry, registration, navigation };
}
test('settings slot consent is exact and changed input remains with its owner', async () => {
  const answer = Promise.withResolvers<boolean>(); const f = settingsFixture(() => answer.promise);
  f.registration.update({ dirty: true, busy: false, blocked: false, version: 2 });
  const pending = f.navigation.select('custom');
  f.registration.update({ dirty: true, busy: false, blocked: false, version: 3 });
  answer.resolve(true); assert.equal(await pending, false); assert.equal(f.navigation.selected, 'agent');
  assert.equal(f.registry.capture()[0].dirty, true);
});
test('cancelled, busy or unknown settings slot cannot clear or select another form', async () => {
  const cancelled = settingsFixture(async () => false);
  cancelled.registration.update({ dirty: true, busy: false, blocked: false, version: 2 });
  assert.equal(await cancelled.navigation.select('custom'), false); assert.equal(cancelled.navigation.selected, 'agent');
  for (const flags of [{ busy: true, blocked: false }, { busy: false, blocked: true }]) {
    const f = settingsFixture(() => assert.fail('blocked form cannot ask to discard'));
    f.registration.update({ dirty: true, ...flags, version: 2 });
    assert.equal(await f.navigation.select('custom'), false); assert.equal(f.navigation.selected, 'agent');
  }
});
test('accepted slot selection retains registry owners and their nonsecret drafts', async () => {
  const f = settingsFixture(); f.registration.update({ dirty: true, busy: false, blocked: false, version: 2 });
  const before = f.registry.capture();
  assert.equal(await f.navigation.select('custom'), true); assert.equal(f.navigation.selected, 'custom');
  assert.deepEqual(f.registry.capture(), before);
});
test('new host or local same-slot intent invalidates older pending consent synchronously', async () => {
  for (const kind of ['host', 'local']) {
    const answer = Promise.withResolvers<boolean>(); const f = settingsFixture(() => answer.promise);
    f.registration.update({ dirty: true, busy: false, blocked: false, version: 2 });
    const pending = f.navigation.select('custom');
    if (kind === 'host') f.navigation.receive(context({ settingsVersion: 2, settingsSlot: 'agent' }));
    else await f.navigation.select('agent');
    answer.resolve(true); assert.equal(await pending, false); assert.equal(f.navigation.selected, 'agent');
  }
});
test('requesting editor closure does not unmount, clear, hide or change settings owner', async () => {
  const f = settingsFixture(); f.registration.update({ dirty: true, busy: false, blocked: false, version: 2 });
  const before = f.registry.capture(); const version = f.navigation.version;
  f.navigation.receive(context({ editorCount: 1 })); f.navigation.receive(context({ editorCount: 0 }));
  assert.deepEqual(f.registry.capture(), before); assert.equal(f.navigation.version, version); assert.equal(f.navigation.selected, 'agent');
});
test('settings close P0 survives presentation-only quit and preserves exact dirty/busy/unknown fences', () => {
  const f = settingsFixture();
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: f.registry,
    readScope: () => `${uuid(2)}:${f.navigation.version}`, readDocumentURL: () => 'http://localhost/?settings=1', now: () => 1, newToken: () => 'settings-close' });
  const ticket = admission.inspect(); assert.equal(ticket.disposition, 'clean');
  f.navigation.receive(context({ quitting: true }));
  assert.equal(admission.commit(ticket.token, { discardDirty: false, allowDrainFailure: false, expiresAt: 1000 }), true);
  f.registration.update({ dirty: true, busy: false, blocked: false, version: 2 });
  let prevented = false; assert.equal(admission.beforeUnload({ preventDefault() { prevented = true; }, returnValue: '' }), false); assert.equal(prevented, true);
  f.registration.update({ dirty: true, busy: false, blocked: true, version: 3 }); assert.equal(admission.inspect().disposition, 'blocked');
});
test('foreign settings context and stale settings version cannot select an owned form', async () => {
  const f = settingsFixture();
  f.navigation.receive(context({ contextId: uuid(99), settingsSlot: 'custom', settingsVersion: 2 }));
  f.navigation.receive(context({ settingsSlot: 'custom', settingsVersion: 0 }));
  await tick(); assert.equal(f.navigation.selected, 'agent');
});
test('a superseded initial context rejection cannot unmount an established native role', async () => {
  const actual: ReactLike = createRequire(join(root, 'apps/web/package.json'))('react');
  const slots: unknown[] = [], effects: Array<() => void> = []; let cursor = 0;
  let receive: ((...args: unknown[]) => void) | undefined;
  const pending = Promise.withResolvers<unknown>();
  const bridge = { subscribe: (callback: (...args: unknown[]) => void) => { receive = callback; return () => {}; }, context: () => pending.promise };
  const react = { ...actual,
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slots[index]) : next; }]; },
    useEffect(fn: () => void): void { const index = cursor++; if (!(index in slots)) { slots[index] = true; effects.push(fn); } },
  };
  const module: {exports: {default?: unknown}} = { exports: {} };
  Function('require', 'module', 'exports', 'window', transformSync(source('DesktopRoot.tsx'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)((name: string) => {
    if (name === 'react') return react;
    if (name.endsWith('/i18n/I18nProvider.tsx')) return i18nTestModule();
    if (name.includes('packages/i18n/src/index.ts')) return i18nCore;
    if (name === './LanguageControl.tsx') return { default: () => null };
    if (name === './LauncherRoot.tsx') return { __esModule: true, default: 'launcher' };
    if (name === './SettingsRoot.tsx') return { __esModule: true, default: 'settings' };
    if (name === './NativeEditorRoot.tsx') return { __esModule: true, default: 'editor' };
    if (name === './desktop-window-client.ts') return { readDesktopWindowBridge: () => bridge };
    assert.fail(name);
  }, module, module.exports, {});
  const render = (): FakeNode => { cursor = 0; return (module.exports.default as (props: Record<string, unknown>) => FakeNode)({ rpc() {}, contractChecks: {}, renderWeb: () => (actual.createElement as (...args: unknown[]) => unknown)('web'), renderEditor: () => (actual.createElement as (...args: unknown[]) => unknown)('editor'), renderSettings: () => null }); };
  render(); effects.splice(0).forEach(effect => effect()); receive!({ contextId: 'current-owner', role: 'editor' });
  assert.equal(render().type, 'editor'); pending.reject(new Error('superseded')); await tick(); assert.equal(render().type, 'editor');
});

test('scoped picker uses shared focus-managed controlled Dialog and retains hidden form owner', () => {
  const picker = source('ProjectEntry.tsx');
  assert.match(picker, /import \{ Dialog, DialogContent, DialogDescription, DialogTitle \} from '@mioon\/ui\/components\/dialog'/);
  assert.match(picker, /<Dialog open=\{state.shown\}/);
  assert.match(picker, /details\.cancel\(\); void controller\.dismiss\(\)/);
  assert.match(picker, /<DialogContent keepMounted showCloseButton=\{false\} hidden=\{!state.shown\} inert=\{!state.shown\}/);
  assert.doesNotMatch(picker, /role="dialog"|modal-backdrop/);
  const shared = readFileSync(join(root, 'packages/ui/src/components/dialog.tsx'), 'utf8');
  assert.match(shared, /keepMounted = false/); assert.match(shared, /<DialogPortal keepMounted=\{keepMounted\}>/);
});

test('hidden editor picker does not boot catalog reads before an explicit entry action', () => {
  assert.match(source('native-project-entry.ts'), /if \(context.role === 'launcher'\) void controller.boot\(\)/);
});
