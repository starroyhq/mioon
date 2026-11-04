import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomImageSettingsV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {createCustomImageServicesClient, createCustomImageServicesSession, safeCustomImageServices, customImageServicesDirty} from '../apps/web/src/custom-image-services-settings.ts';
import type {CustomImageServicesClient, CustomImageServicesSnapshot, CustomImageServicesWrite} from '../apps/web/src/custom-image-services-settings.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {translate, LOCALES} from '../packages/i18n/src/index.ts';
import {agentTaskErrorKey} from '../apps/web/src/agent-task-errors.ts';

const deferred = <T>() => Promise.withResolvers<T>();
const configured = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true, baseUrl: 'https://images.example.test/v1', model: 'same-model'};
async function fixture() {
  let document: unknown = null;
  const settings = await createCustomImageSettingsV2({persistence: {load: () => structuredClone(document), save: value => {document = structuredClone(value);}}});
  const calls: CustomImageServicesWrite[] = [];
  const client: CustomImageServicesClient = {read: () => settings.get(), write: input => {
    calls.push(structuredClone(input)); const {action, ...payload} = input;
    return action === 'create' ? settings.create(payload) : action === 'put' ? settings.put(payload) : settings.remove(payload);
  }};
  const states: unknown[] = [], session = createCustomImageServicesSession({client, onChange: state => states.push(state)});
  await session.load();
  return {settings, session, states, calls, client};
}

test('browser drafts own lowercase UUIDs, custom instances stay independent and model edits retain their key', async t => {
  const f = await fixture(); t.after(async () => {f.session.dispose(); await f.settings.close();});
  assert.equal(f.session.add('First'), true); const first = f.session.getState().draft!.connectionId;
  assert.match(first, /^[0-9a-f-]{36}$/); f.session.edit({}, configured); f.session.setStorage('session');
  assert.equal(await f.session.save('synthetic-first-only'), true);
  assert.equal(f.calls[0]!.action, 'create'); assert.equal(f.calls[0]!.connectionId, first);
  assert.equal(f.session.add('Second'), true); const second = f.session.getState().draft!.connectionId;
  assert.notEqual(first, second); f.session.edit({}, configured); f.session.setStorage('session'); assert.equal(await f.session.save('synthetic-second-only'), true);
  assert.equal(f.session.select(first), true); f.session.edit({}, {model: 'new-model'}); assert.equal(await f.session.save(), true);
  const snapshot = f.session.getState().snapshot!;
  assert.equal(snapshot.connections[0]!.secret.configured, true); assert.equal(snapshot.connections[1]!.configuration.model, 'same-model');
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-(?:first|second)-only/);
  assert.equal(await f.session.remove(), true); assert.deepEqual(f.session.getState().snapshot!.connections.map(item => item.connectionId), [second]);
});

test('multiple saved image services open without guessing a selected identity; dirty switching is refused', async t => {
  const f = await fixture(); t.after(async () => {f.session.dispose(); await f.settings.close();});
  for (const name of ['A','B']) {f.session.add(name); f.session.edit({}, configured); assert.equal(await f.session.save(), true);}
  const reopened = createCustomImageServicesSession({client: f.client}); t.after(() => reopened.dispose()); await reopened.load();
  assert.equal(reopened.getState().draft, null);
  const first = reopened.getState().snapshot!.connections[0]!.connectionId, second = reopened.getState().snapshot!.connections[1]!.connectionId;
  assert.equal(reopened.select(first), true); reopened.edit({name: 'Unsaved'}); assert.equal(reopened.select(second), false);
  assert.equal(reopened.getState().draft!.connectionId, first); assert.equal(customImageServicesDirty(reopened.getState()), true);
});

test('a conflict reads once without retry, preserves the draft and requires explicit review', async t => {
  const f = await fixture(); t.after(async () => {f.session.dispose(); await f.settings.close();});
  f.session.add('A'); f.session.edit({}, configured); await f.session.save(); let reads = 0, writes = 0;
  const client: CustomImageServicesClient = {read: async () => {reads++; return f.settings.get();}, write: async () => {writes++; throw Object.assign(Error('private diagnostic'), {code: 'IMAGE_SETTINGS_CONFLICT'});}};
  const current = createCustomImageServicesSession({client}); t.after(() => current.dispose()); await current.load(); current.edit({name: 'Unsaved name'});
  assert.equal(await current.save(), false); assert.equal(reads, 2); assert.equal(writes, 1); assert.equal(current.getState().phase, 'review');
  assert.equal(current.getState().draft!.name, 'Unsaved name'); assert.equal(await current.save(), false); assert.equal(writes, 1);
  assert.equal(current.acknowledge(), true); assert.equal(current.getState().recovery, null);
});

test('hidden and disposed custom owners refuse edits and late save acknowledgements', async t => {
  const f = await fixture(); t.after(async () => {f.session.dispose(); await f.settings.close();});
  const pending = deferred<CustomImageServicesSnapshot>(); let writes = 0;
  const current = createCustomImageServicesSession({client: {read: f.client.read, write: () => {writes++; return pending.promise;}}});
  await current.load(); current.add('A'); current.edit({}, configured); current.setStorage('session'); const saving = current.save('synthetic-late');
  current.setVisible(false); assert.equal(current.edit({name: 'Late edit'}), false); assert.equal(await current.save(), false); current.dispose();
  pending.resolve(await f.settings.get()); assert.equal(await saving, false); assert.equal(writes, 1); assert.equal(current.getState().snapshot, null);
});

test('custom settings HTTP is bounded, private and redacted, and rejects secret echoes', async () => {
  const snapshot = {revision: 0, connections: [], storage: {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}, notice: null};
  const calls: {route: string; init?: RequestInit}[] = [];
  const client = createCustomImageServicesClient({fetchImpl: async (route, init) => {calls.push({route: String(route), init}); return Response.json({ok: true, data: snapshot});}});
  assert.deepEqual(await client.read(), snapshot); assert.equal(calls[0]!.route, '/api/images/custom-settings'); assert.equal(calls[0]!.init?.cache, 'no-store');
  assert.equal(calls[0]!.init?.credentials, 'same-origin'); assert.equal(calls[0]!.init?.method, 'GET');
  assert.throws(() => safeCustomImageServices({...snapshot, key: 'must-not-enter-state'}), {code: 'INVALID_RESPONSE'});
});

test('Mio multi-service refusal and session loss guidance render in all four languages', () => {
  assert.equal(agentTaskErrorKey('IMAGE_SETTINGS_SELECTION_REQUIRED'), 'agent.task.error.imageSelectionRequired');
  for (const locale of LOCALES) {
    assert.ok(translate(locale, agentTaskErrorKey('IMAGE_SETTINGS_SELECTION_REQUIRED')).length > 10);
    assert.ok(translate(locale, 'connections.sessionLoss').length > 10);
  }
  assert.equal(translate('zh-Hans', 'connections.sessionLoss'), '应用退出后，正在进行的生成没法继续查询结果。');
});

import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {createI18nTestContext} from './helpers/i18n.ts';
import {message} from '../packages/i18n/src/index.ts';
import {CUSTOM_IMAGE_SETTINGS_V2_LIMITS} from '../packages/contracts/src/generation-image-settings.ts';
import * as sessions from '../apps/web/src/custom-image-services-settings.ts';
import {createSettingsNavigationReporter, closeSettingsAfterPermission} from '../apps/web/src/settings-navigation-state.ts';
type UiNode = {type: unknown; props: Record<string, unknown> & {children: unknown[]}};
type Hook = {value?: unknown; deps?: unknown[]; cleanup?: () => void};
const nodes = (value: unknown): UiNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'props' in value ? [value as UiNode, ...nodes((value as UiNode).props.children)] : [];
function uiHarness(client: CustomImageServicesClient, confirm: (value: unknown) => Promise<boolean> = async () => true) {
  const hooks: Hook[] = []; let cursor = 0, effects: (() => void)[] = [], tree: unknown;
  const depsChanged = (left?: unknown[], right?: unknown[]) => !left || !right || left.length !== right.length || left.some((value, index) => value !== right[index]);
  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): UiNode {
      const ref = props?.ref as {current: unknown} | undefined; if (ref && type === 'Input' && ref.current === null) ref.current = {value: ''};
      return {type, props: {...props, children}};
    },
    useRef(value: unknown) {const hook = hooks[cursor++] ??= {value: {current: value}}; return hook.value;},
    useState(initial: unknown) {const index = cursor++; const hook = hooks[index] ??= {value: typeof initial === 'function' ? (initial as () => unknown)() : initial}; return [hook.value, (next: unknown) => {hook.value = typeof next === 'function' ? (next as (value: unknown) => unknown)(hook.value) : next;}];},
    useMemo(factory: () => unknown, deps: unknown[]) {const hook = hooks[cursor++] ??= {}; if (depsChanged(hook.deps, deps)) {hook.value = factory(); hook.deps = deps;} return hook.value;},
    useLayoutEffect(effect: () => (() => void) | void, deps?: unknown[]) {const hook = hooks[cursor++] ??= {}; if (depsChanged(hook.deps, deps)) {hook.deps = deps; effects.push(() => {hook.cleanup?.(); hook.cleanup = effect() || undefined;});}},
  };
  const reactModule = {...react, default: react};
  const module = {exports: {} as {default: (props: Record<string, unknown>) => unknown}};
  const imports: Record<string, unknown> = {
    react: reactModule, '@mioon/ui/components/button': {Button: 'Button'}, '@mioon/ui/components/input': {Input: 'Input'}, '@mioon/ui/components/label': {Label: 'Label'},
    '@mioon/ui/components/workbench-confirm': {useConfirmation: () => confirm}, '../../../packages/i18n/src/index.ts': {message},
    '../../../packages/contracts/src/generation-image-settings.ts': {CUSTOM_IMAGE_SETTINGS_V2_LIMITS}, './i18n/I18nProvider.tsx': {useI18n: () => createI18nTestContext('zh-Hans')},
    './workspace-visibility.tsx': {useWorkspaceVisibility: () => true}, './WorkspaceControls.tsx': {WorkbenchSelect: 'WorkbenchSelect'},
    './settings-navigation-state.ts': {createSettingsNavigationReporter, closeSettingsAfterPermission}, './custom-image-services-settings.ts': sessions,
  };
  Function('require', 'module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/CustomImageServicesSettings.tsx', import.meta.url), 'utf8'), {loader: 'tsx', format: 'cjs'}).code)((name: string) => {if (name.endsWith('.css')) return {}; assert.ok(Object.hasOwn(imports, name), name); return imports[name];}, module, module.exports);
  const props = {active: true, contextKey: 'test-owner', client};
  const render = (patch: Partial<typeof props> = {}) => {Object.assign(props, patch); cursor = 0; effects = []; tree = module.exports.default(props); const ready = effects; effects = []; ready.forEach(effect => effect()); return tree;};
  const find = (id: string) => {const node = nodes(tree).find(node => node.props['data-testid'] === id); assert.ok(node, id); return node;};
  const act = (id: string, event: string, value?: unknown) => (find(id).props[event] as (value?: unknown) => unknown)(value);
  const key = (value: string) => {const input = find('custom-image-settings-key'), ref = input.props.ref as {current: {value: string}}; ref.current.value = value; (input.props.onChange as () => void)();};
  return {render, find, act, key, get tree() {return tree;}, unmount() {hooks.forEach(hook => hook.cleanup?.());}};
}
const flush = () => new Promise(setImmediate);
test('real custom form keeps passwords out of state, preserves model edits and clears DOM before dispatch or hiding', async t => {
  const f = await fixture(); t.after(async () => {f.session.dispose(); await f.settings.close();});
  const originalWrite = f.client.write; let passwordAtWrite = 'unset';
  const client: CustomImageServicesClient = {...f.client, write: input => {passwordAtWrite = (ui.find('custom-image-settings-key').props.ref as {current: {value: string}}).current.value; return originalWrite(input);}};
  const ui = uiHarness(client); t.after(() => ui.unmount()); ui.render(); await flush(); ui.render(); ui.act('custom-image-service-add', 'onClick'); await flush(); ui.render();
  ui.act('custom-image-settings-base-url', 'onChange', {target: {value: configured.baseUrl}}); ui.act('custom-image-settings-model', 'onChange', {target: {value: configured.model}}); ui.act('custom-image-settings-storage', 'onChange', {target: {value: 'session'}}); ui.render();
  ui.key('synthetic-dom-key'); ui.render(); ui.act('custom-image-settings-model', 'onChange', {target: {value: 'another-model'}}); ui.render();
  assert.equal((ui.find('custom-image-settings-key').props.ref as {current: {value: string}}).current.value, 'synthetic-dom-key');
  const form = nodes(ui.tree).find(node => node.type === 'form')!; (form.props.onSubmit as (event: {preventDefault(): void}) => void)({preventDefault() {}});
  assert.equal((ui.find('custom-image-settings-key').props.ref as {current: {value: string}}).current.value, ''); await flush(); ui.render(); assert.equal(passwordAtWrite, '');
  ui.key('synthetic-hidden-key'); const stale = ui.find('custom-image-service-name').props.onChange as (event: {target: {value: string}}) => void; ui.render({active: false});
  assert.equal((ui.find('custom-image-settings-key').props.ref as {current: {value: string}}).current.value, ''); stale({target: {value: 'late'}}); ui.render({active: true});
  assert.notEqual(ui.find('custom-image-service-name').props.value, 'late');
});

test('editing a password during delete confirmation invalidates permission and leaves the service intact', async t => {
  const f = await fixture(); t.after(async () => {f.session.dispose(); await f.settings.close();});
  f.session.add('A'); f.session.edit({}, configured); await f.session.save();
  const answer = deferred<boolean>(), ui = uiHarness(f.client, () => answer.promise); t.after(() => ui.unmount());
  ui.render(); await flush(); ui.render(); const writes = f.calls.length;
  const deleting = ui.act('custom-image-service-delete', 'onClick'); ui.key('new-input-during-confirmation'); answer.resolve(true); await deleting; await flush(); ui.render();
  assert.equal(f.calls.length, writes); assert.equal((await f.settings.get()).connections.length, 1);
});

import {createGenerationImageServicesClient} from '../apps/web/src/generation-image-services.ts';
test('project service discovery uses the dedicated authenticated route and rejects another project response', async () => {
  const projectId = '10000000-0000-4000-8000-000000000001'; const calls: {route: string; init?: RequestInit}[] = [];
  const client = createGenerationImageServicesClient({fetchImpl: async (route, init) => {calls.push({route: String(route), init}); return Response.json({ok: true, data: {projectId, items: []}});}});
  assert.deepEqual(await client.list(projectId), []); assert.match(calls[0]!.route, /images\/services$/); assert.equal(calls[0]!.init?.method, 'POST');
  assert.equal(calls[0]!.init?.cache, 'no-store'); assert.deepEqual(JSON.parse(calls[0]!.init!.body as string), {operation: 'image.service.list', input: {projectId}});
  const foreign = createGenerationImageServicesClient({fetchImpl: async () => Response.json({ok: true, data: {projectId: '10000000-0000-4000-8000-000000000002', items: []}})});
  await assert.rejects(foreign.list(projectId), {code: 'INVALID_RESPONSE'});
});
