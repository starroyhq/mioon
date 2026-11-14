import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {newVideoConnection} from '../apps/web/src/video-settings.ts';
import * as settings from '../apps/web/src/video-settings.ts';
import * as sessions from '../apps/web/src/generation-video-services.ts';
import * as navigation from '../apps/web/src/settings-navigation-state.ts';
import * as contracts from '../packages/contracts/src/video-providers.ts';
import type {CompatibleVideoCheckResult} from '../packages/contracts/src/video-providers.ts';
import type {CompatibleVideoCheck} from '../packages/contracts/src/video-providers.ts';
import type {VideoSettingsClient} from '../apps/web/src/video-settings.ts';
import type {VideoModelsListInput, VideoSettingsSnapshotV2} from '../packages/contracts/src/generation-video-settings.ts';
import type {GenerationServiceDomain} from '../apps/web/src/generation-services-settings.ts';

interface Element {type: unknown; props: Record<string, unknown>}
interface Hook {value?: unknown; deps?: readonly unknown[]; cleanup?: void | (() => void)}
const element = (value: unknown): value is Element => Boolean(value && typeof value === 'object' && 'props' in value);
function nodes(value: unknown): Element[] {return Array.isArray(value) ? value.flatMap(nodes) : element(value) ? [value, ...nodes(value.props.children)] : [];}
function invoke(element: Element, method: string, ...args: unknown[]) {const callback = element.props[method]; assert.equal(typeof callback, 'function'); return (callback as (...args: unknown[]) => unknown)(...args);}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
const flush = async () => {for (let index = 0; index < 6; index++) await new Promise<void>(resolve => setImmediate(resolve));};
function fixture({check, modelsList, write, storage}: Partial<VideoSettingsClient> & {storage?: VideoSettingsSnapshotV2['storage']} = {}) {
  const a = newVideoConnection('compatible'), b = newVideoConnection('compatible'); a.name = 'A'; b.name = 'B'; a.baseUrl = b.baseUrl = 'https://api.example.com/v1';
  let snapshot: VideoSettingsSnapshotV2 = {revision: 1, connections: [a, b].map(configuration => ({configuration, revision: 1, secret: {configured: true, storage: 'session'}})), storage: {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}, notice: null};
  if (storage) {
    snapshot.storage = storage;
    snapshot.connections[0]!.secret.storage = 'persistent';
  }
  const keyA = `video:${a.id}`, keyB = `video:${b.id}`;
  const hooks = new Map<string, Hook[]>(), inputs = new Map<string, {value: string}>(), trees = new Map<string, unknown>(), reports: navigation.SettingsNavigationState[] = [];
  let context = 'domain', cursor = 0, effects: Array<() => void> = [], pageVisible = true, selected = keyA, locale = 'zh-Hans', confirmValue: boolean | Promise<boolean> = true, interaction = true, domain: GenerationServiceDomain;
  const client: VideoSettingsClient = {read: async () => structuredClone(snapshot), write: write ?? (async update => {assert.ok([...inputs.values()].every(input => !input.value)); if (update.action !== 'batch') throw Error('Expected batch'); for (const operation of update.operations) {if (operation.action === 'delete') snapshot.connections = snapshot.connections.filter(view => view.configuration.id !== operation.connectionId); else {const previous = snapshot.connections.find(view => view.configuration.id === operation.configuration.id); snapshot.connections = [...snapshot.connections.filter(view => view.configuration.id !== operation.configuration.id), {configuration: operation.configuration, revision: 2, secret: operation.secret.action === 'replace' ? {configured: true, storage: operation.secret.storage} : previous?.secret ?? {configured: false, storage: 'none'}}];}} snapshot.revision++; return structuredClone(snapshot);}), check, modelsList};
  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {return {type, props: {...props, children}};},
    useRef(initial: unknown) {const list = hooks.get(context)!; const index = cursor++; return (list[index] ??= {value: {current: initial}}).value;},
    useState(initial: unknown) {const list = hooks.get(context)!; const index = cursor++; const hook = list[index] ??= {value: typeof initial === 'function' ? initial() : initial}; return [hook.value, (value: unknown) => {hook.value = typeof value === 'function' ? value(hook.value) : value;}];},
    useLayoutEffect(callback: () => void | (() => void), deps?: readonly unknown[]) {const list = hooks.get(context)!, index = cursor++, old = list[index]; if (!old || !deps || deps.some((value, i) => value !== old.deps?.[i])) effects.push(() => {old?.cleanup?.(); list[index] = {deps, cleanup: callback()};});},
  };
  const source = readFileSync(new URL('../apps/web/src/GenerationVideoServices.tsx', import.meta.url), 'utf8'), module = {exports: {} as typeof import('../apps/web/src/GenerationVideoServices.tsx')};
  Function('require', 'module', 'exports', transformSync(source, {loader: 'tsx', format: 'cjs', jsx: 'transform'}).code)((name: string) => {
    if (name === 'react') return {...react, __esModule: true, default: react};
    if (name === './generation-video-services.ts') return sessions;
    if (name === './video-settings.ts') return settings;
    if (name === './settings-navigation-state.ts') return navigation;
    if (name === '../../../packages/contracts/src/video-providers.ts') return contracts;
    if (name === '../../../packages/i18n/src/index.ts') return {message: (key: string, parameters: unknown) => ({key, parameters})};
    if (name === './i18n/I18nProvider.tsx') return {useI18n: () => ({t: (key: string) => `${locale}:${key}`})};
    if (name === './SettingsServicesLayout.tsx') return {useSettingsServicesPanel: () => ({selected: context === selected, pageVisible, active: context === selected && pageVisible})};
    if (name === '@mioon/ui/components/workbench-confirm') return {useConfirmation: () => () => confirmValue};
    if (name === '@mioon/ui/components/button') return {Button: 'Button'};
    if (name === '@mioon/ui/components/input') return {Input: 'input'};
    if (name === '@mioon/ui/components/textarea') return {Textarea: 'textarea'};
    if (name === './WorkspaceControls.tsx') return {WorkbenchSelect: 'select'};
    if (name === './VideoProviderSettings.tsx') return {ModelEditor: 'ModelEditor'};
    if (name === './ModelPickerDialog.tsx') return {__esModule: true, default: 'ModelPickerDialog'};
    if (name.endsWith('.css')) return {};
    assert.fail('Unexpected video domain dependency: ' + name);
  }, module, module.exports);
  const onNavigationStateChange = (state: navigation.SettingsNavigationState) => reports.push(state), onSelect = (key: string) => {selected = key;};
  function render() {
    context = 'domain'; cursor = 0; effects = []; if (!hooks.has(context)) hooks.set(context, []);
    domain = module.exports.useGenerationVideoServices({client, pageVisible, onNavigationStateChange, onSelect, interactionAllowed: () => interaction}); for (const effect of effects) effect();
    const currentKeys = new Set(domain.services.map(service => service.key));
    for (const [key, list] of hooks) if (key !== 'domain' && !currentKeys.has(key)) {for (const hook of list) hook.cleanup?.(); hooks.delete(key); inputs.delete(key); trees.delete(key);}
    for (const service of domain.services) {
      context = service.key; cursor = 0; effects = []; if (!hooks.has(context)) hooks.set(context, []);
      const content = service.content; assert.ok(element(content)); assert.equal(typeof content.type, 'function');
      const tree = (content.type as (props: Record<string, unknown>) => unknown)(content.props); trees.set(service.key, tree);
      const input = nodes(tree).find(item => item.props['data-testid'] === 'video-connection-key'); assert.ok(input);
      const retained = inputs.get(service.key) ?? {value: ''}; inputs.set(service.key, retained); invoke(input, 'ref', retained);
      for (const effect of effects) effect();
    }
    return domain;
  }
  const find = (key: string, id: string) => {const found = nodes(trees.get(key)).find(item => item.props['data-testid'] === id); assert.ok(found, `${key}:${id}`); return found;};
  render();
  return {keyA, keyB, inputs, reports, render, find, client, all: (key: string) => nodes(trees.get(key)),
    picker: (key: string) => nodes(trees.get(key)).find(item => item.type === 'ModelPickerDialog'),
    domain: () => domain,
    type(key: string, value: string) {inputs.get(key)!.value = value; invoke(find(key, 'video-connection-key'), 'onChange'); render();},
    select(key: string) {selected = key; render();},
    hide() {pageVisible = false; render();}, show() {pageVisible = true; render();},
    locale(value: string) {locale = value; render();},
    confirm(value: boolean | Promise<boolean>) {confirmValue = value;},
    lock(value: boolean) {interaction = !value;},
    unmount() {for (const list of hooks.values()) for (const hook of list) hook.cleanup?.();},
  };
}

test('video panels keep separate retained key refs across detail and locale changes, and expose no nested list or footer', async () => {
  const f = fixture(); await flush(); f.render(); const a = f.inputs.get(f.keyA), b = f.inputs.get(f.keyB);
  f.type(f.keyA, 'synthetic-dom-A'); f.select(f.keyB); f.type(f.keyB, 'synthetic-dom-B'); f.select(f.keyA); f.locale('ja');
  assert.equal(f.inputs.get(f.keyA), a); assert.equal(f.inputs.get(f.keyB), b); assert.equal(a!.value, 'synthetic-dom-A'); assert.equal(b!.value, 'synthetic-dom-B');
  assert.equal(f.domain().navigation.dirty, true); assert.doesNotMatch(JSON.stringify(f.reports), /synthetic-dom/);
  for (const service of f.domain().services) {const all = f.all(service.key); assert.equal(all.some(node => ['footer', 'aside', 'form'].includes(String(node.type))), false); assert.equal(all.filter(node => node.props.type === 'password').length, 1);}
  f.hide(); assert.ok([...f.inputs.values()].every(input => input.value === '')); f.show(); assert.equal(f.inputs.get(f.keyA), a); f.unmount();
});

test('an address edit clears only its own password and old detail callbacks cannot edit a different selected panel', async () => {
  const f = fixture(); await flush(); f.render(); f.type(f.keyA, 'synthetic-dom-A'); const stale = f.find(f.keyA, 'video-connection-name');
  f.select(f.keyB); f.type(f.keyB, 'synthetic-dom-B'); invoke(stale, 'onChange', {target: {value: 'Hidden mutation'}}); f.render(); assert.equal(f.domain().services.find(service => service.key === f.keyA)!.label, 'A');
  invoke(f.find(f.keyB, 'video-connection-base-url'), 'onChange', {target: {value: 'https://other.example.com/v1'}}); f.render(); assert.equal(f.inputs.get(f.keyA)!.value, 'synthetic-dom-A'); assert.equal(f.inputs.get(f.keyB)!.value, ''); f.unmount();
});

test('only a saved persistent video key blocked by system storage displays Keychain guidance', async () => {
  for (const storage of [
    {persistentAvailable: false, sessionScope: 'app', reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'},
    {persistentAvailable: true, sessionScope: 'app', reasonCode: null},
    {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'},
  ] as const) {
    const f = fixture({storage}); await flush(); f.render();
    const keychain = (key: string) => f.all(key).find(node => node.props['data-testid'] === 'video-key-storage-unavailable');
    for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
      f.locale(locale);
      assert.deepEqual(keychain(f.keyA)?.props.children, storage.reasonCode === 'OS_SECRET_STORE_UNAVAILABLE' ? [`${locale}:tasks.error.videoSecretStore`] : undefined);
      assert.equal(keychain(f.keyB), undefined);
      assert.equal(f.inputs.get(f.keyA)?.value, '');
    }
    f.unmount();
  }
});

test('every built-in and custom detail has one derived read-only endpoint that updates locally without a provider request', async () => {
  let writes = 0, checks = 0;
  const f = fixture({write: async () => {writes++; throw Error('Unexpected write');}, check: async () => {checks++; throw Error('Unexpected provider request');}}); await flush(); f.render();
  for (const service of f.domain().services) {
    const outputs = f.all(service.key).filter(node => node.type === 'output'); assert.equal(outputs.length, 1);
    assert.equal(outputs[0]!.props['data-testid'], 'video-connection-endpoint'); assert.equal(outputs[0]!.props.onChange, undefined);
  }
  assert.deepEqual(f.find(f.keyA, 'video-connection-endpoint').props.children, ['https://api.example.com/v1/videos']);
  const password = f.inputs.get(f.keyA);
  invoke(f.find(f.keyA, 'video-connection-base-url'), 'onChange', {target: {value: 'https://new.example.com/v2'}}); f.render();
  assert.deepEqual(f.find(f.keyA, 'video-connection-endpoint').props.children, ['https://new.example.com/v2/videos']); assert.equal(f.inputs.get(f.keyA), password);
  f.select('video:minimax'); assert.deepEqual(f.find('video:minimax', 'video-connection-endpoint').props.children, [contracts.resolveVideoEndpoint('minimax', 'global')]);
  invoke(f.find('video:minimax', 'video-connection-region'), 'onChange', {target: {value: 'cn'}}); f.render();
  assert.deepEqual(f.find('video:minimax', 'video-connection-endpoint').props.children, [contracts.resolveVideoEndpoint('minimax', 'cn')]);
  f.select(f.keyA); invoke(f.find(f.keyA, 'video-connection-base-url'), 'onChange', {target: {value: 'http://unsafe.example.com'}}); f.render();
  assert.deepEqual(f.find(f.keyA, 'video-connection-endpoint').props.children, ['']); assert.equal(writes, 0); assert.equal(checks, 0); f.unmount();
});

test('one page save captures exact A/B bindings and clears every password before any async transport', async () => {
  let writes = 0; const f = fixture({write: async update => {writes++; assert.ok([...f.inputs.values()].every(input => !input.value)); assert.equal(update.action, 'batch'); throw Object.assign(Error('Known no-effect'), {code: 'VIDEO_SETTINGS_CAPACITY'});}}); await flush(); f.render();
  f.type(f.keyA, 'synthetic-save-A'); f.select(f.keyB); f.type(f.keyB, 'synthetic-save-B'); const ticket = f.domain().prepareSave()!;
  assert.ok([...f.inputs.values()].every(input => !input.value)); f.domain().clearKeys(); assert.equal(writes, 0); assert.equal(await ticket.run(), 'error'); ticket.dispose(); f.render(); assert.equal(writes, 1); assert.equal(f.domain().navigation.dirty, true); f.unmount();
});

test('a retained check callback uses the current exact recipient instead of sending a newly typed key to its old address', async () => {
  const checks: CompatibleVideoCheck[] = [], f = fixture({check: async input => {checks.push(structuredClone(input)); return {result: 'ok'};}}); await flush(); f.render();
  const oldCheck = f.find(f.keyA, 'video-compatible-check');
  invoke(f.find(f.keyA, 'video-connection-base-url'), 'onChange', {target: {value: 'https://new-recipient.example/v1'}}); f.render(); f.type(f.keyA, 'synthetic-new-recipient-key');
  invoke(oldCheck, 'onClick'); await flush(); f.render();
  assert.deepEqual(checks, [{source: 'draft', baseUrl: 'https://new-recipient.example/v1', value: 'synthetic-new-recipient-key'}]);
  assert.doesNotMatch(JSON.stringify(f.reports), /synthetic-new-recipient-key/); f.unmount();
});

test('document hiding synchronously fences retained callbacks before parent props commit', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'); let hidden = false, checks = 0;
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {get visibilityState() {return hidden ? 'hidden' : 'visible';}, addEventListener() {}, removeEventListener() {}}});
  try {
    const f = fixture({check: async () => {checks++; return {result: 'ok'};}}); await flush(); f.render(); const oldCheck = f.find(f.keyA, 'video-compatible-check'), oldName = f.find(f.keyA, 'video-connection-name');
    f.type(f.keyA, 'synthetic-hidden-key'); hidden = true;
    invoke(oldCheck, 'onClick'); invoke(oldName, 'onChange', {target: {value: 'Hidden mutation'}}); assert.throws(() => f.domain().prepareSave());
    assert.equal(checks, 0); assert.ok([...f.inputs.values()].every(input => !input.value)); f.render(); assert.equal(f.domain().services.find(service => service.key === f.keyA)!.label, 'A'); f.unmount();
  } finally {if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');}
});

test('the parent save lock fences old detail/add/discard callbacks without a rerender, while admitted save tickets still run', async () => {
  let checks = 0;
  const f = fixture({check: async () => {checks++; return {result: 'ok'};}}); await flush(); f.render(); f.type(f.keyA, 'synthetic-save-lock-key');
  const oldName = f.find(f.keyA, 'video-connection-name'), oldCheck = f.find(f.keyA, 'video-compatible-check'), oldDelete = f.find(f.keyA, 'video-delete-connection');
  f.lock(true);
  invoke(oldName, 'onChange', {target: {value: 'Locked mutation'}}); invoke(oldCheck, 'onClick'); invoke(oldDelete, 'onClick'); assert.equal(f.domain().add?.(), null); f.domain().discard(); await flush(); f.render();
  assert.equal(f.domain().services.find(service => service.key === f.keyA)!.label, 'A'); assert.equal(f.inputs.get(f.keyA)!.value, 'synthetic-save-lock-key'); assert.equal(checks, 0);
  const ticket = f.domain().prepareSave()!; assert.ok([...f.inputs.values()].every(input => !input.value)); assert.equal(await ticket.run(), 'saved'); ticket.dispose(); f.render();
  assert.equal(f.domain().navigation.dirty, false); assert.equal(f.domain().services.filter(service => service.custom).length, 2); f.unmount();
});

test('delete cancellation preserves keys, while confirmed staged deletion clears A only and returns to general', async () => {
  const f = fixture(); await flush(); f.render(); f.type(f.keyA, 'synthetic-dom-A'); f.select(f.keyB); f.type(f.keyB, 'synthetic-dom-B'); f.select(f.keyA);
  f.confirm(false); invoke(f.find(f.keyA, 'video-delete-connection'), 'onClick'); await flush(); f.render(); assert.equal(f.inputs.get(f.keyA)!.value, 'synthetic-dom-A');
  f.confirm(true); invoke(f.find(f.keyA, 'video-delete-connection'), 'onClick'); await flush(); f.render(); assert.equal(f.domain().services.some(service => service.key === f.keyA), false); assert.equal(f.inputs.get(f.keyB)!.value, 'synthetic-dom-B'); assert.equal(f.domain().navigation.dirty, true); f.unmount();
});

test('late checks cannot publish after selection, address edit, save, hide or owner replacement', async () => {
  for (const action of ['select', 'address', 'save', 'hide', 'unmount']) {
    const pending = deferred<CompatibleVideoCheckResult>(); let checks = 0; const f = fixture({check: async () => {checks++; return pending.promise;}}); await flush(); f.render();
    invoke(f.find(f.keyA, 'video-compatible-check'), 'onClick'); f.render(); assert.equal(checks, 1);
    if (action === 'select') f.select(f.keyB);
    if (action === 'address') {invoke(f.find(f.keyA, 'video-connection-base-url'), 'onChange', {target: {value: 'https://other.example.com'}}); f.render();}
    if (action === 'save') {assert.equal(f.domain().prepareSave(), null); f.render();}
    if (action === 'hide') f.hide();
    if (action === 'unmount') f.unmount();
    pending.resolve({result: 'ok', httpStatus: 200}); await flush(); if (action !== 'unmount') {f.render(); assert.equal(nodes(f.find(f.keyA, 'generation-video-detail')).some(node => node.props['data-testid'] === 'video-compatible-check-result'), false); f.unmount();}
  }
});

for (const result of ['ok', 'unauthorized', 'unsupported', 'unreachable', 'denied'] as const) test(`compatible checks retain the ${result} presentation without changing configured facts`, async () => {
  const f = fixture({check: async () => ({result, httpStatus: result === 'unauthorized' ? 401 : result === 'unsupported' ? 404 : 200})}); await flush(); f.render(); invoke(f.find(f.keyA, 'video-compatible-check'), 'onClick'); await flush(); f.render();
  assert.equal(f.find(f.keyA, 'video-compatible-check-result').props['data-result'], result); assert.equal(f.domain().services.find(service => service.key === f.keyA)!.configured, true); f.unmount();
});


test('built-in check and model discovery use one-time draft values and retain no password in UI state', async () => {
  const requests: VideoModelsListInput[] = [];
  let writes = 0;
  const f = fixture({
    modelsList: async input => {
      requests.push(structuredClone(input));
      return input.operation === 'models' ? {result: 'ok', models: [{id: 'veo-3.1-generate-preview'}, {id: 'veo-test-video'}, {id: 'veo-test-not-selected'}]} : {result: 'ok'};
    },
    write: async () => {writes++; throw Error('Unexpected save');},
  });
  await flush();
  f.render();
  f.select('video:veo');
  f.type('video:veo', 'synthetic-video-ui-draft');
  assert.equal(f.domain().services.find(service => service.key === 'video:veo')?.dirty, true);
  invoke(f.find('video:veo', 'video-compatible-check'), 'onClick');
  await flush();
  f.render();
  invoke(f.find('video:veo', 'video-fetch-models'), 'onClick');
  f.render();
  assert.equal(f.picker('video:veo')?.props.status, 'loading');
  await flush();
  f.render();
  assert.deepEqual(requests, [
    {operation: 'check', source: 'draft', providerId: 'veo', region: 'global', workspaceId: '', value: 'synthetic-video-ui-draft'},
    {operation: 'models', source: 'draft', providerId: 'veo', region: 'global', workspaceId: '', value: 'synthetic-video-ui-draft'},
  ]);
  assert.equal(f.find('video:veo', 'video-compatible-check-result').props['data-result'], 'ok');
  const picker = f.picker('video:veo')!;
  assert.equal(picker.props.status, 'ready');
  assert.equal(picker.props.usesDraftKey, true);
  assert.deepEqual(picker.props.items, [
    {id: 'veo-3.1-generate-preview', added: true, unavailable: false},
    {id: 'veo-test-video', added: false, unavailable: false},
    {id: 'veo-test-not-selected', added: false, unavailable: false},
  ]);
  assert.equal(f.all('video:veo').some(node => node.props.model && (node.props.model as {modelId?: unknown}).modelId === 'veo-test-video'), false);
  const visibleProps = {...picker.props};
  assert.deepEqual(Object.keys(visibleProps).sort(), [
    'children', 'items', 'key', 'maxAdditions', 'onAdd', 'onClose', 'serviceName',
    'status', 'statusMessage', 'triggerRef', 'usesDraftKey',
  ]);
  assert.doesNotMatch(JSON.stringify(visibleProps), /synthetic-video-ui-draft/);
  invoke(picker, 'onAdd', ['veo-not-returned']);
  f.render();
  assert.equal(f.picker('video:veo')?.props.status, 'ready');
  invoke(picker, 'onAdd', ['veo-test-video']);
  f.render();
  assert.equal(f.picker('video:veo'), undefined);
  assert.deepEqual(f.all('video:veo').filter(node => node.type === 'ModelEditor').map(node => {
    const model = node.props.model as {modelId: string; enabled: boolean};
    return [model.modelId, model.enabled];
  }), [['veo-3.1-generate-preview', true], ['veo-test-video', false]]);
  assert.equal(f.domain().navigation.dirty, true);
  assert.doesNotMatch(JSON.stringify(f.reports), /synthetic-video-ui-draft/);
  f.domain().discard();
  f.render();
  assert.equal(f.inputs.get('video:veo')?.value, '');
  assert.equal(f.domain().navigation.dirty, false);
  assert.equal(writes, 0);
  f.unmount();
});

test('video model discovery lists IDs outside the existing video contract without staging them', async () => {
  const valid = 'synthetic-model:preview';
  const invalid = ['vendor/synthetic-model', 'v'.repeat(101)];
  const f = fixture({modelsList: async () => ({result: 'ok', models: [...invalid, valid].map(id => ({id}))})});
  await flush();
  f.render();
  invoke(f.find(f.keyA, 'video-fetch-models'), 'onClick');
  await flush();
  f.render();
  const picker = f.picker(f.keyA)!;
  assert.equal(picker.props.status, 'ready');
  assert.deepEqual(picker.props.items, [
    ...invalid.map(id => ({id, added: false, unavailable: true})),
    {id: valid, added: false, unavailable: false},
  ]);
  invoke(picker, 'onAdd', [invalid[0]!, valid]);
  f.render();
  assert.equal(f.domain().navigation.dirty, false);
  assert.equal(f.picker(f.keyA)?.props.status, 'ready');
  invoke(picker, 'onAdd', [valid]);
  f.render();
  assert.equal(f.picker(f.keyA), undefined);
  assert.deepEqual(f.all(f.keyA).filter(node => node.type === 'ModelEditor').map(node => (node.props.model as {modelId: string}).modelId), ['sora-2', valid]);
  f.unmount();
});

test('cancel closes the model picker, aborts the request, and discards late results without writes', async () => {
  const pending = deferred<Awaited<ReturnType<NonNullable<VideoSettingsClient['modelsList']>>>>();
  const signals: (AbortSignal | undefined)[] = [];
  let writes = 0;
  const f = fixture({
    modelsList: async (input, requestSignal) => {
      assert.equal(input.source, 'saved');
      signals.push(requestSignal);
      return pending.promise;
    },
    write: async () => {writes++; throw Error('Unexpected save');},
  });
  await flush();
  f.render();
  invoke(f.find(f.keyA, 'video-fetch-models'), 'onClick');
  f.render();
  const picker = f.picker(f.keyA)!;
  assert.equal(picker.props.status, 'loading');
  assert.equal(picker.props.usesDraftKey, false);
  invoke(picker, 'onClose');
  assert.equal(signals[0]?.aborted, true);
  pending.resolve({result: 'ok', models: [{id: 'synthetic-late-video'}]});
  await flush();
  f.render();
  assert.equal(f.picker(f.keyA), undefined);
  assert.equal(f.domain().navigation.dirty, false);
  assert.equal(f.domain().prepareSave(), null);
  assert.equal(writes, 0);
  f.unmount();
});

test('empty and unsupported model discovery remain read-only picker states', async () => {
  const f = fixture({modelsList: async input => input.providerId === 'kling' ? {result: 'unsupported'} : {result: 'ok', models: []}});
  await flush();
  f.render();
  invoke(f.find(f.keyA, 'video-fetch-models'), 'onClick');
  await flush();
  f.render();
  const empty = f.picker(f.keyA)!;
  assert.equal(empty.props.status, 'empty');
  assert.equal(empty.props.statusMessage, 'zh-Hans:settings.draftKey.modelsEmpty');
  assert.deepEqual(empty.props.items, []);
  assert.equal(f.domain().navigation.dirty, false);
  f.select('video:kling');
  f.type('video:kling', 'synthetic-unsupported-maker');
  invoke(f.find('video:kling', 'video-fetch-models'), 'onClick');
  await flush();
  f.render();
  const unsupported = f.picker('video:kling')!;
  assert.equal(unsupported.props.status, 'error');
  assert.equal(unsupported.props.statusMessage, 'zh-Hans:settings.draftKey.listUnsupported');
  assert.deepEqual(unsupported.props.items, []);
  assert.equal(f.picker(f.keyA), undefined);
  f.unmount();
});

test('model picker preserves the video check messages for provider and transport failures', async () => {
  for (const [result, message] of [
    ['unreachable', 'video.providers.check.unreachable'], ['failed', 'settings.draftKey.failed'],
  ] as const) {
    const f = fixture({modelsList: async () => ({result})});
    await flush();
    f.render();
    invoke(f.find(f.keyA, 'video-fetch-models'), 'onClick');
    await flush();
    f.render();
    const picker = f.picker(f.keyA)!;
    assert.equal(picker.props.status, 'error');
    assert.equal(picker.props.statusMessage, `zh-Hans:${message}`);
    assert.equal(f.domain().navigation.dirty, false);
    f.unmount();
  }
});

test('a model picker retained by stale callbacks cannot add to another service or after a recipient edit', async () => {
  for (const action of ['select', 'address', 'key']) {
    const f = fixture({modelsList: async () => ({result: 'ok', models: [{id: 'synthetic-old-video'}]})});
    await flush();
    f.render();
    invoke(f.find(f.keyA, 'video-fetch-models'), 'onClick');
    await flush();
    f.render();
    const stale = f.picker(f.keyA)!;
    assert.equal(stale.props.status, 'ready');
    if (action === 'select') f.select(f.keyB);
    if (action === 'address') invoke(f.find(f.keyA, 'video-connection-base-url'), 'onChange', {target: {value: 'https://new.example.com/v2'}});
    if (action === 'key') f.type(f.keyA, 'synthetic-new-key');
    invoke(stale, 'onAdd', ['synthetic-old-video']);
    f.render();
    for (const key of [f.keyA, f.keyB]) {
      assert.equal(f.picker(key), undefined);
      assert.equal(f.all(key).some(node => node.props.model && (node.props.model as {modelId?: unknown}).modelId === 'synthetic-old-video'), false);
    }
    f.unmount();
  }
});

test('a saved password cannot be reused by a retained callback after the draft address changes', async () => {
  const requests: VideoModelsListInput[] = [];
  const f = fixture({modelsList: async input => {requests.push(input); return {result: 'ok', models: []};}});
  await flush();
  f.render();
  const button = f.find(f.keyA, 'video-fetch-models');
  invoke(f.find(f.keyA, 'video-connection-base-url'), 'onChange', {target: {value: 'https://new.example.com/v2'}});
  // Even before React commits the new props, the event reads the live draft.
  invoke(button, 'onClick');
  await flush();
  assert.deepEqual(requests, []);
  f.render();
  assert.equal(f.find(f.keyA, 'video-fetch-models').props.disabled, true);
  f.type(f.keyA, 'synthetic-new-video-ui-draft');
  invoke(button, 'onClick');
  await flush();
  assert.deepEqual(requests, [
    {operation: 'models', source: 'draft', providerId: 'compatible', region: 'custom', workspaceId: '', baseUrl: 'https://new.example.com/v2', value: 'synthetic-new-video-ui-draft'},
  ]);
  f.unmount();
});
