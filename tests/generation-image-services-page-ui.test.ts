import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSecretCodec, testSecretStorage} from './helpers/secret-codec.ts';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import * as logic from '../apps/web/src/generation-image-services-settings.ts';
import type {GenerationImageServicesClient} from '../apps/web/src/generation-image-services-settings.ts';
import type {GenerationServiceDomain} from '../apps/web/src/generation-services-settings.ts';
import {createCustomImageSettingsV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import type ModelPickerDialog from '../apps/web/src/ModelPickerDialog.tsx';
import {DEFAULT_COMFY_IMAGE_CONFIGURATION} from '../packages/contracts/src/comfy-images.ts';
import * as i18n from '../packages/i18n/src/index.ts';
import * as comfy from '../apps/web/src/comfy-image-settings.ts';
import {createI18nTestContext} from './helpers/i18n.ts';
import * as imageCompatible from '../packages/contracts/src/image-compatible.ts';

type Node = {type: unknown; props: Record<string, unknown> & {children?: unknown[]}};
type Hook = {value?: unknown; deps?: readonly unknown[]; cleanup?: () => void; effect?: () => void | (() => void)};
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'props' in value ? [value as Node, ...nodes((value as Node).props.children)] : [];
function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (value && typeof value === 'object' && 'props' in value) return textContent((value as Node).props.children);
  return '';
}
const flush = async () => {for (let n = 0; n < 40; n++) await Promise.resolve();};

/** The component retention harness follows existing settings tests. Real browser
 * DOM/screenshots are separate evidence, not claimed by these field-port nodes. */
function harness(client: GenerationImageServicesClient, confirm: () => Promise<boolean> = async () => true, kind: logic.GenerationImageDomainKind = 'custom') {
  const scopes = new Map<string, Hook[]>(), fields = new Map<string, {value: string}>();
  let hooks: Hook[] = [], cursor = 0, effects: Array<() => void> = [], selected = 'general', panelKey = '', locale: i18n.Locale = 'zh-Hans', visible = true, allowed = true;
  let domain: GenerationServiceDomain, trees: Node[][] = [];
  const changed = (left?: readonly unknown[], right?: readonly unknown[]) => !left || !right || left.length !== right.length || left.some((value, index) => value !== right[index]);
  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {return {type, props: {...props, children}};},
    useState(initial: unknown) {const hook = hooks[cursor++] ??= {value: typeof initial === 'function' ? (initial as () => unknown)() : initial}; return [hook.value, (value: unknown) => {hook.value = typeof value === 'function' ? (value as (old: unknown) => unknown)(hook.value) : value;}];},
    useRef(initial: unknown) {const hook = hooks[cursor++] ??= {value: {current: initial}}; return hook.value;},
    useMemo(factory: () => unknown, deps: readonly unknown[]) {const hook = hooks[cursor++] ??= {}; if (changed(hook.deps, deps)) {hook.value = factory(); hook.deps = deps;} return hook.value;},
    useLayoutEffect(callback: () => void | (() => void), deps?: readonly unknown[]) {const hook = hooks[cursor++] ??= {}; if (changed(hook.deps, deps)) {hook.deps = deps; hook.effect = callback; effects.push(() => {hook.cleanup?.(); hook.cleanup = callback() || undefined;});}},
  };
  const module = {exports: {} as {useGenerationCustomImageServices(options: unknown): GenerationServiceDomain; useGenerationComfyService(options: unknown): GenerationServiceDomain; useGenerationOfficialImageService(options: unknown): GenerationServiceDomain}};
  const source = readFileSync(new URL('../apps/web/src/GenerationImageServices.tsx', import.meta.url), 'utf8');
  const imports: Record<string, unknown> = {
    react: {...react, __esModule: true, default: react}, './generation-image-services-settings.ts': logic,
    './ModelPickerDialog.tsx': {__esModule: true, default: 'ModelPickerDialog'},
    './i18n/I18nProvider.tsx': {useI18n: () => createI18nTestContext(locale)},
    '../../../packages/i18n/src/index.ts': i18n, './comfy-image-settings.ts': comfy, './SettingsSecretStorageNotice.tsx': {SettingsSecretStorageNotice: 'SettingsSecretStorageNotice'},
    '../../../packages/contracts/src/image-compatible.ts': imageCompatible,
    './SettingsServicesLayout.tsx': {useSettingsServicesPanel: () => ({selected: panelKey === selected, pageVisible: visible, active: visible && panelKey === selected})},
    '@mioon/ui/components/button': {Button: 'Button'}, '@mioon/ui/components/input': {Input: 'Input'}, '@mioon/ui/components/label': {Label: 'Label'},
    './icons.tsx': {__esModule: true, default: 'Icon'},
    '@mioon/ui/components/switch': {Switch: 'Switch'},
    '@mioon/ui/components/workbench-confirm': {useConfirmation: () => confirm}, './WorkspaceControls.tsx': {WorkbenchSelect: 'WorkbenchSelect', WorkbenchTooltip: 'WorkbenchTooltip'},
  };
  Function('module', 'exports', 'require', transformSync(source, {loader: 'tsx', format: 'cjs'}).code)(module, module.exports, (name: string) => {if (name.endsWith('.css')) return {}; assert.ok(name in imports, name); return imports[name];});
  const scope = <T>(key: string, callback: () => T): T => {hooks = scopes.get(key) ?? []; scopes.set(key, hooks); cursor = 0; effects = []; const result = callback(); const pending = effects; effects = []; for (const effect of pending) effect(); return result;};
  const onSelect = (key: string) => {selected = key;};
  const interactionAllowed = () => allowed;
  const render = () => {
    const useDomain = kind === 'custom' ? module.exports.useGenerationCustomImageServices
      : kind === 'official' ? module.exports.useGenerationOfficialImageService : module.exports.useGenerationComfyService;
    domain = scope('owner', () => useDomain({pageVisible: visible, client, onSelect, interactionAllowed}));
    trees = domain.services.map(service => {
      panelKey = service.key; const element = service.content as Node;
      const tree = scope(service.key, () => (element.type as (props: Node['props']) => Node)(element.props)), all = nodes(tree);
      for (const node of all) if (node.type === 'Input' && typeof node.props.ref === 'function') {
        const id = String(node.props['data-testid']); let field = fields.get(id); if (!field) {field = {value: ''}; fields.set(id, field);} node.props.ref(field);
      }
      return all;
    });
    return domain;
  };
  const get = (id: string) => trees.flat().find(node => node.props['data-testid'] === id);
  const find = (id: string) => {const item = get(id); assert.ok(item, id); return item;};
  const picker = () => trees.flat().find(node => node.type === 'ModelPickerDialog')?.props as
    Parameters<typeof ModelPickerDialog>[0] | undefined;
  const click = (id: string) => {
    const button = find(id);
    assert.equal(button.props.disabled, false);
    (button.props.onClick as (event: {currentTarget: unknown}) => void)({currentTarget: button});
    render();
  };
  return {render, get, find, picker, click, fetchModels: (prefix: string) => click(`${prefix}-model-list`), fields, elements: () => trees.flat(), domain: () => domain, select(key: string) {selected = key; return render();}, locale(value: i18n.Locale) {locale = value; return render();},
    visible(value: boolean) {visible = value; return render();}, key(id: string, value: string) {fields.get(id)!.value = value; (find(id).props.onChange as () => void)(); render();},
    lock(value: boolean) {allowed = !value;},
    replayOwnerEffects() {const ownerHooks = scopes.get('owner') ?? []; for (const hook of ownerHooks) hook.cleanup?.(); for (const hook of ownerHooks) if (hook.effect) hook.cleanup = hook.effect() || undefined;},
    unmount() {for (const hook of scopes.get('owner') ?? []) hook.cleanup?.();},
  };
}

async function fixture() {
  let document: unknown = null, writes = 0;
  const settings = await createCustomImageSettingsV2({secretCodec: createTestSecretCodec(), storage: testSecretStorage, persistence: {load: () => document, save: value => {document = structuredClone(value);}}});
  for (const name of ['A', 'B']) await settings.create({expectedRevision: (await settings.get()).revision, connectionId: crypto.randomUUID(), name, configuration: {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true, baseUrl: 'https://images.example/v1', model: 'same-model'}, secret: {action: 'replace', storage: 'persistent', value: 'synthetic-saved-only'}});
  const client: GenerationImageServicesClient = {read: () => settings.get(), write: input => {writes++; assert.ok(input && typeof input === 'object' && 'action' in input); const {action: _action, ...body} = input; return settings.batch(body);}};
  return {settings, client, get writes() {return writes;}};
}

test('retained UUID panels preserve independent fields across detail/locale changes, and whole-page hiding clears all', async t => {
  const f = await fixture(), ui = harness(f.client); t.after(async () => {ui.unmount(); await f.settings.close();}); ui.render(); await flush(); const initial = ui.render(), [a, b] = initial.services;
  assert.ok(a && b); const aId = a.key.slice(6), bId = b.key.slice(6), aField = `${aId}-key`, bField = `${bId}-key`;
  const all = ui.elements(), toggle = ui.find(`${aId}-enabled`), label = all.find(item => item.props.className === 'generation-image-enable');
  assert.equal(all.filter(item => item.props['data-testid'] === `${aId}-enabled`).length, 1); assert.equal(label?.props.htmlFor, toggle.props.id);
  assert.ok(all.indexOf(toggle) > all.indexOf(ui.find(aField)));
  const enableGroup = all.find(item => item.props.className === 'settings-with-help' && nodes(item).some(child => child === label));
  assert.equal(nodes(enableGroup).find(item => item.type === 'WorkbenchTooltip')?.props.content, i18n.translate('zh-Hans', 'image.settings.enableScope'));
  assert.equal(toggle.props['aria-describedby'], undefined);
  ui.select(a.key); ui.key(aField, 'synthetic-panel-a'); const first = ui.fields.get(aField);
  assert.equal(ui.find(`${aId}-enabled`).type, 'Switch');
  const stale = ui.find(`${aId}-enabled`).props.onCheckedChange as (checked: boolean) => void;
  ui.select(b.key); ui.key(bField, 'synthetic-panel-b'); assert.equal(first?.value, 'synthetic-panel-a');
  stale(false); ui.render(); assert.equal(ui.find(`${aId}-enabled`).props.checked, true);
  for (const locale of i18n.LOCALES) {ui.locale(locale); assert.equal(ui.fields.get(aField), first); assert.equal(first?.value, 'synthetic-panel-a'); assert.equal(ui.fields.get(bField)?.value, 'synthetic-panel-b');}
  assert.doesNotMatch(JSON.stringify(ui.domain()), /synthetic-panel/); assert.equal(f.writes, 0);
  ui.visible(false); assert.equal(first?.value, ''); assert.equal(ui.fields.get(bField)?.value, ''); assert.equal(ui.domain().navigation.dirty, true);
});

test('canceled delete keeps the field; confirmed delete clears only that service and stages without any PUT', async t => {
  const f = await fixture(); let answer = false; const ui = harness(f.client, async () => answer); t.after(async () => {ui.unmount(); await f.settings.close();}); ui.render(); await flush(); const [a, b] = ui.render().services; assert.ok(a && b);
  const aId = a.key.slice(6), bId = b.key.slice(6); ui.select(a.key); ui.key(`${aId}-key`, 'synthetic-delete-a'); ui.select(b.key); ui.key(`${bId}-key`, 'synthetic-keep-b'); ui.select(a.key);
  (ui.find(`${aId}-delete`).props.onClick as () => void)(); await flush(); ui.render(); assert.equal(ui.fields.get(`${aId}-key`)?.value, 'synthetic-delete-a'); assert.equal(ui.domain().services.length, 2);
  answer = true; (ui.find(`${aId}-delete`).props.onClick as () => void)(); await flush(); ui.render(); assert.equal(ui.fields.get(`${aId}-key`)?.value, ''); assert.equal(ui.fields.get(`${bId}-key`)?.value, 'synthetic-keep-b'); assert.equal(ui.domain().services.length, 1); assert.equal(f.writes, 0);
});

test('Comfy module read failure remains unknown while a definite unavailable module preserves saved configuration facts', async () => {
  for (const absent of [true, false]) {
    const ui = harness({read: async () => ({revision: 1, configuration: {...DEFAULT_COMFY_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'http://127.0.0.1:8188', model: 'saved.safetensors'}, readiness: {checked: true, checkedAt: new Date().toISOString()}}), write: async () => assert.fail('Read-only fixture'),
      readAvailability: async () => {if (absent) throw Error('Unavailable metadata'); return {schemaVersion: 1, connectorId: 'mioon.comfy-local', implementationVersion: '1', state: 'not_loaded', reason: 'startup_not_loaded', fixedForSession: true};}}, undefined, 'comfy');
    ui.render(); await flush(); const service = ui.render().services[0]!;
    assert.equal(service.configured, true); assert.equal(service.available, absent ? null : false); ui.unmount();
  }
});

test('synchronous page lock refuses old edits/add/discard/delete while an admitted save ticket still runs', async t => {
  const f = await fixture(); let confirmations = 0; const ui = harness(f.client, async () => {confirmations++; return true;}); t.after(async () => {ui.unmount(); await f.settings.close();});
  ui.render(); await flush(); const a = ui.render().services[0]!; const id = a.key.slice(6); ui.select(a.key); ui.key(`${id}-key`, 'synthetic-locked-only');
  const edit = ui.find(`${id}-enabled`).props.onCheckedChange as (checked: boolean) => void, remove = ui.find(`${id}-delete`).props.onClick as () => void;
  ui.lock(true); edit(false); remove(); ui.domain().discard(); assert.equal(ui.domain().add?.(), null); await flush(); ui.render();
  assert.equal(ui.find(`${id}-enabled`).props.checked, true); assert.equal(ui.fields.get(`${id}-key`)?.value, 'synthetic-locked-only'); assert.equal(confirmations, 0);
  const ticket = ui.domain().prepareSave()!; assert.equal(ui.fields.get(`${id}-key`)?.value, ''); assert.equal(await ticket.run(), 'saved'); ticket.dispose(); assert.equal(f.writes, 1);
});

test('effect setup-cleanup-setup creates a fresh owner and fences the first setup read instead of reviving disposal', async t => {
  const f = await fixture(); let resolve!: (value: unknown) => void, reads = 0; const first = new Promise<unknown>(yes => {resolve = yes;});
  const client: GenerationImageServicesClient = {...f.client, read: async () => {reads++; return reads === 1 ? first : f.client.read();}};
  const ui = harness(client); t.after(async () => {ui.unmount(); await f.settings.close();});
  ui.render(); ui.replayOwnerEffects(); await flush(); const ready = ui.render(); assert.equal(ready.ready, true); assert.equal(ready.services.length, 2);
  resolve({revision: 0, connections: [], storage: {persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'}, notice: null}); await flush(); assert.equal(ui.render().services.length, 2);
  const a = ui.domain().services[0]!; const id = a.key.slice(6); ui.select(a.key); ui.key(`${id}-key`, 'synthetic-replay-only'); const ticket = ui.domain().prepareSave()!;
  assert.equal(await ticket.run(), 'saved'); ticket.dispose(); assert.equal(f.writes, 1); assert.equal(reads, 2);
});

test('legacy reset notice is visible for an empty collection and can be dismissed once without consuming the server notice', async () => {
  let reads = 0; const snapshot = {revision: 0, connections: [], storage: {persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'}, notice: 'LEGACY_CUSTOM_IMAGE_SETTINGS_RESET'};
  const ui = harness({read: async () => {reads++; return snapshot;}, write: async () => assert.fail('Dismissing is local')});
  ui.render(); await flush(); const domain = ui.render(); assert.deepEqual(domain.services, []); assert.ok(domain.notice);
  const close = nodes(domain.notice).find(item => item.type === 'Button'); assert.ok(close); (close.props.onClick as () => void)();
  assert.equal(ui.render().notice, undefined); ui.visible(false); ui.visible(true); assert.equal(ui.render().notice, undefined); assert.equal(reads, 1); assert.equal(snapshot.notice, 'LEGACY_CUSTOM_IMAGE_SETTINGS_RESET'); ui.unmount();
});

test('image Check and Get models use the current password input and put safe results beside the owning field', async t => {
  const f = await fixture(), probes: Array<{request: Parameters<NonNullable<GenerationImageServicesClient['probe']>>[0]; signal?: AbortSignal}> = [];
  let finish: ((value: unknown) => void) | undefined;
  f.client.probe = (request, signal) => {probes.push({request, signal}); return new Promise(resolve => {finish = resolve;});};
  const ui = harness(f.client);
  t.after(async () => {ui.unmount(); await f.settings.close();});
  ui.render(); await flush(); const [a,b] = ui.render().services;
  assert.ok(a && b);
  const id = a.key.slice(6);
  const passwordId = `${id}-key`;
  ui.select(a.key);
  ui.key(passwordId, 'synthetic-q21-draft');
  assert.equal(ui.domain().services.find(item => item.key === a.key)?.dirty, true);
  assert.equal(ui.domain().services.find(item => item.key === b.key)?.dirty, false);
  const check = ui.find(`${id}-key-check`);
  assert.equal(check.props.disabled, false);
  (check.props.onClick as () => void)();
  ui.render();
  assert.equal(ui.find(`${id}-model-list`).props.disabled, true);
  assert.deepEqual(probes[0]?.request, {operation:'check',baseUrl:'https://images.example/v1',credential:{source:'draft',value:'synthetic-q21-draft'}});
  finish?.({result:'unauthorized',httpStatus:401}); await flush(); ui.render();
  assert.equal(ui.find(`${id}-probe-result`).props.role, 'alert');
  assert.equal(ui.fields.get(passwordId)?.value, 'synthetic-q21-draft');

  ui.fetchModels(id);
  assert.equal(ui.picker()?.status, 'loading');
  assert.deepEqual(ui.picker()?.items, [{id: 'same-model', added: true, unavailable: false}]);
  assert.deepEqual(probes[1]?.request, {operation:'models',baseUrl:'https://images.example/v1',credential:{source:'draft',value:'synthetic-q21-draft'}});
  ui.select(b.key);
  assert.equal(probes[1]?.signal?.aborted, true);
  finish?.({result:'ok',models:[{id:'model-a'}]}); await flush(); ui.render();
  assert.ok(!ui.elements().some(item => item.props['data-testid'] === `${id}-probe-result`));
  assert.equal(ui.picker(), undefined);
  ui.select(a.key);
  ui.fetchModels(id);
  finish?.({result:'ok',models:[{id:'model-a'}]}); await flush(); ui.render();
  const ready = ui.picker();
  assert.equal(ready?.status, 'ready');
  assert.equal(ready?.mode, 'single');
  assert.deepEqual(ready?.items.map(item => item.id), ['same-model', 'model-a']);
  assert.equal(ui.fields.get(passwordId)?.value, 'synthetic-q21-draft');
  assert.equal(f.writes, 0);
});


test('custom image picker replaces just one staged model, rejects stale and invalid picks, and writes only on Save', async t => {
  const f = await fixture(), ui = harness(f.client);
  t.after(async () => {ui.unmount(); await f.settings.close();});
  const tooLong = 'a'.repeat(121);
  f.client.probe = async () => ({result: 'ok', models: [{id: 'model-a'}, {id: 'model-b'}, {id: tooLong}]});
  ui.render(); await flush(); const [a, b] = ui.render().services;
  assert.ok(a && b);
  const id = a.key.slice(6);
  ui.select(a.key); ui.fetchModels(id); await flush(); ui.render();
  const picker = ui.picker()!;
  assert.equal(picker.status, 'ready');
  assert.equal(picker.mode, 'single');
  assert.equal(picker.unavailableLabel, 'ID 格式不支持');
  assert.deepEqual(picker.items, [
    {id: 'same-model', added: true, unavailable: false},
    {id: 'model-a', added: false, unavailable: false},
    {id: 'model-b', added: false, unavailable: false},
    {id: tooLong, added: false, unavailable: true},
  ]);
  picker.onAdd(['model-a', 'model-b']); picker.onAdd(['unlisted']); picker.onAdd([tooLong]);
  ui.render();
  assert.equal(ui.find(`${id}-model`).props.value, 'same-model');
  picker.onClose(); ui.render(); assert.equal(ui.picker(), undefined);
  picker.onAdd(['model-a']); ui.render();
  assert.equal(ui.find(`${id}-model`).props.value, 'same-model');

  ui.fetchModels(id); await flush(); ui.render();
  ui.picker()!.onAdd(['model-a']); ui.render();
  assert.equal(ui.find(`${id}-model`).props.value, 'model-a');
  assert.equal(ui.find(`${b.key.slice(6)}-model`).props.value, 'same-model');
  assert.ok((await f.settings.get()).connections.every(item => item.configuration.model === 'same-model'));
  assert.equal(f.writes, 0);
  ui.domain().discard(); ui.render();
  assert.equal(ui.find(`${id}-model`).props.value, 'same-model');
  ui.fetchModels(id); await flush(); ui.render();
  ui.picker()!.onAdd(['model-b']); ui.render();
  const ticket = ui.domain().prepareSave()!;
  assert.equal(await ticket.run(), 'saved'); ticket.dispose();
  assert.equal(f.writes, 1);
  const saved = (await f.settings.get()).connections;
  assert.equal(saved.find(item => item.connectionId === id)?.configuration.model, 'model-b');
  assert.equal(saved.find(item => item.connectionId === id)?.secret.configured, true);
});

test('official and custom image settings hide key controls when secure storage is unavailable', async () => {
  const storage = {persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'};
  for (const kind of ['official', 'custom'] as const) {
    const snapshot = kind === 'official'
      ? {revision: 0, configuration: DEFAULT_IMAGE_CONFIGURATION, secret: {configured: false, storage: 'none'}, storage}
      : {revision: 0, connections: [], storage, notice: null};
    const ui = harness({read: async () => snapshot, write: async () => assert.fail('Opening a detail cannot save')}, undefined, kind);
    try {
      ui.render(); await flush(); ui.render();
      const key = kind === 'official' ? 'image:official' : ui.domain().add?.();
      assert.ok(key); ui.select(key);
      const controls = ui.elements();
      assert.ok(!controls.some(node => node.props.type === 'password'));
      assert.ok(!controls.some(node => String(node.props['data-testid']).endsWith('-storage')));
      assert.deepEqual(controls.find(node => node.type === 'SettingsSecretStorageNotice')?.props.storage, storage);
    } finally {ui.unmount();}
  }
});

function officialHarness(probe: NonNullable<GenerationImageServicesClient['probe']>) {
  return harness({
    read: async () => ({revision: 1, configuration: DEFAULT_IMAGE_CONFIGURATION, secret: {configured: true, storage: 'persistent'},
      storage: testSecretStorage()}),
    probe,
    write: async () => assert.fail('Checking the fixed model is read-only'),
  }, undefined, 'official');
}

test('official image check reports exact fixed-model membership and existing failures inline, without a picker', async t => {
  const fixedModel = DEFAULT_IMAGE_CONFIGURATION.model;
  let response: unknown;
  const requests: unknown[] = [];
  const ui = officialHarness(async request => {requests.push(request); return response;});
  t.after(ui.unmount);
  ui.render(); await flush(); ui.select('image:official');

  const action = 'image-official-key-check', result = 'image-official-probe-result';
  const actions = ui.elements().find(item => item.props.className === 'image-generation-actions');
  assert.deepEqual(nodes(actions).filter(item => item.type === 'Button').map(item => item.props['data-testid']), [action]);
  assert.equal(textContent(ui.find(action)), i18n.translate('zh-Hans', 'settings.draftKey.check'));
  assert.equal(ui.get('image-official-model-list'), undefined);
  assert.equal(ui.get(result), undefined);

  const cases = [
    {response: {result: 'ok', models: [{id: 'other-model'}, {id: fixedModel}]}, role: 'status', text: `密钥可用 · ${fixedModel}`},
    {response: {result: 'ok', models: [{id: `${fixedModel}-preview`}]}, role: 'alert', text: `此密钥的模型列表中没有 ${fixedModel}`},
    {response: {result: 'ok', models: []}, role: 'alert', text: `此密钥的模型列表中没有 ${fixedModel}`},
    {response: {result: 'unauthorized', httpStatus: 401}, role: 'alert', text: i18n.translate('zh-Hans', 'settings.draftKey.unauthorized')},
    {response: {result: 'unsupported'}, role: 'alert', text: i18n.translate('zh-Hans', 'settings.draftKey.listUnsupported')},
    {response: {result: 'unreachable'}, role: 'alert', text: i18n.translate('zh-Hans', 'settings.draftKey.failed')},
  ];
  for (const outcome of cases) {
    response = outcome.response;
    ui.click(action);
    assert.equal(ui.find(action).props.disabled, true);
    assert.equal(ui.get(result), undefined);
    assert.equal(ui.picker(), undefined);
    await flush(); ui.render();
    assert.equal(ui.find(result).props.role, outcome.role);
    assert.equal(textContent(ui.find(result)), outcome.text);
    assert.equal(ui.picker(), undefined);
    assert.equal(ui.domain().navigation.dirty, false);
    assert.equal(textContent(ui.find(action)), outcome.role === 'status' ? i18n.translate('zh-Hans', 'settings.draftKey.check') : '重新检查');
  }
  assert.deepEqual(requests, cases.map(() => ({operation: 'models', credential: {source: 'saved', configurationRevision: 1}})));
});

test('official image check clears the previous result on key edits and ignores a reply after leaving the detail', async t => {
  const pending: Array<{request: unknown; signal?: AbortSignal; resolve: (result: unknown) => void}> = [];
  const ui = officialHarness((request, signal) => new Promise(resolve => pending.push({request, signal, resolve})));
  t.after(ui.unmount);
  ui.render(); await flush(); ui.select('image:official');

  const fixedModel = DEFAULT_IMAGE_CONFIGURATION.model;
  const report = {result: 'ok', models: [{id: fixedModel}]};
  ui.key('image-official-key', 'synthetic-image-first');
  ui.click('image-official-key-check');
  assert.deepEqual(pending[0]!.request, {operation: 'models', credential: {source: 'draft', value: 'synthetic-image-first'}});
  pending[0]!.resolve(report);
  await flush(); ui.render();
  assert.equal(textContent(ui.find('image-official-probe-result')), `密钥可用 · ${fixedModel}`);

  ui.key('image-official-key', 'synthetic-image-second');
  assert.equal(ui.get('image-official-probe-result'), undefined);
  ui.click('image-official-key-check');
  assert.deepEqual(pending[1]!.request, {operation: 'models', credential: {source: 'draft', value: 'synthetic-image-second'}});
  ui.select('general');
  assert.equal(pending[1]!.signal?.aborted, true);
  pending[1]!.resolve(report);
  await flush(); ui.select('image:official');
  assert.equal(ui.get('image-official-probe-result'), undefined);
  assert.equal(ui.picker(), undefined);
});
