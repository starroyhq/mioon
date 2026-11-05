import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import * as logic from '../apps/web/src/generation-image-services-settings.ts';
import type {GenerationImageServicesClient} from '../apps/web/src/generation-image-services-settings.ts';
import type {GenerationServiceDomain} from '../apps/web/src/generation-services-settings.ts';
import {createCustomImageSettingsV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {DEFAULT_COMFY_IMAGE_CONFIGURATION} from '../packages/contracts/src/comfy-images.ts';
import * as i18n from '../packages/i18n/src/index.ts';
import * as comfy from '../apps/web/src/comfy-image-settings.ts';
import {createI18nTestContext} from './helpers/i18n.ts';
import * as imageCompatible from '../packages/contracts/src/image-compatible.ts';

type Node = {type: unknown; props: Record<string, unknown> & {children?: unknown[]}};
type Hook = {value?: unknown; deps?: readonly unknown[]; cleanup?: () => void; effect?: () => void | (() => void)};
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'props' in value ? [value as Node, ...nodes((value as Node).props.children)] : [];
const flush = async () => {for (let n = 0; n < 40; n++) await Promise.resolve();};

/** The component retention harness follows existing settings tests. Real browser
 * DOM/screenshots are separate evidence, not claimed by these field-port nodes. */
function harness(client: GenerationImageServicesClient, confirm: () => Promise<boolean> = async () => true, kind: 'custom' | 'comfy' = 'custom') {
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
  const module = {exports: {} as {useGenerationCustomImageServices(options: unknown): GenerationServiceDomain; useGenerationComfyService(options: unknown): GenerationServiceDomain}};
  const source = readFileSync(new URL('../apps/web/src/GenerationImageServices.tsx', import.meta.url), 'utf8');
  const imports: Record<string, unknown> = {
    react: {...react, __esModule: true, default: react}, './generation-image-services-settings.ts': logic,
    './i18n/I18nProvider.tsx': {useI18n: () => createI18nTestContext(locale)},
    '../../../packages/i18n/src/index.ts': i18n, './comfy-image-settings.ts': comfy, './ImageSettings.tsx': {imageStorageReason: () => ''},
    '../../../packages/contracts/src/image-compatible.ts': imageCompatible,
    './SettingsServicesLayout.tsx': {useSettingsServicesPanel: () => ({selected: panelKey === selected, pageVisible: visible, active: visible && panelKey === selected})},
    '@mioon/ui/components/button': {Button: 'Button'}, '@mioon/ui/components/input': {Input: 'Input'}, '@mioon/ui/components/label': {Label: 'Label'},
    '@mioon/ui/components/switch': {Switch: 'Switch'},
    '@mioon/ui/components/workbench-confirm': {useConfirmation: () => confirm}, './WorkspaceControls.tsx': {WorkbenchSelect: 'WorkbenchSelect'},
  };
  Function('module', 'exports', 'require', transformSync(source, {loader: 'tsx', format: 'cjs'}).code)(module, module.exports, (name: string) => {if (name.endsWith('.css')) return {}; assert.ok(name in imports, name); return imports[name];});
  const scope = <T>(key: string, callback: () => T): T => {hooks = scopes.get(key) ?? []; scopes.set(key, hooks); cursor = 0; effects = []; const result = callback(); const pending = effects; effects = []; for (const effect of pending) effect(); return result;};
  const onSelect = (key: string) => {selected = key;};
  const interactionAllowed = () => allowed;
  const render = () => {
    domain = scope('owner', () => (kind === 'custom' ? module.exports.useGenerationCustomImageServices : module.exports.useGenerationComfyService)({pageVisible: visible, client, onSelect, interactionAllowed}));
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
  const find = (id: string) => {const item = trees.flat().find(node => node.props['data-testid'] === id); assert.ok(item, id); return item;};
  return {render, find, fields, elements: () => trees.flat(), domain: () => domain, select(key: string) {selected = key; return render();}, locale(value: i18n.Locale) {locale = value; return render();},
    visible(value: boolean) {visible = value; return render();}, key(id: string, value: string) {fields.get(id)!.value = value; (find(id).props.onChange as () => void)(); render();},
    lock(value: boolean) {allowed = !value;},
    replayOwnerEffects() {const ownerHooks = scopes.get('owner') ?? []; for (const hook of ownerHooks) hook.cleanup?.(); for (const hook of ownerHooks) if (hook.effect) hook.cleanup = hook.effect() || undefined;},
    unmount() {for (const hook of scopes.get('owner') ?? []) hook.cleanup?.();},
  };
}

async function fixture() {
  let document: unknown = null, writes = 0;
  const settings = await createCustomImageSettingsV2({persistence: {load: () => document, save: value => {document = structuredClone(value);}}});
  for (const name of ['A', 'B']) await settings.create({expectedRevision: (await settings.get()).revision, connectionId: crypto.randomUUID(), name, configuration: {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true, baseUrl: 'https://images.example/v1', model: 'same-model'}, secret: {action: 'replace', storage: 'session', value: 'synthetic-saved-only'}});
  const client: GenerationImageServicesClient = {read: () => settings.get(), write: input => {writes++; assert.ok(input && typeof input === 'object' && 'action' in input); const {action: _action, ...body} = input; return settings.batch(body);}};
  return {settings, client, get writes() {return writes;}};
}

test('retained UUID panels preserve independent fields across detail/locale changes, and whole-page hiding clears all', async t => {
  const f = await fixture(), ui = harness(f.client); t.after(async () => {ui.unmount(); await f.settings.close();}); ui.render(); await flush(); const initial = ui.render(), [a, b] = initial.services;
  assert.ok(a && b); const aId = a.key.slice(6), bId = b.key.slice(6), aField = `${aId}-key`, bField = `${bId}-key`;
  const all = ui.elements(), toggle = ui.find(`${aId}-enabled`), label = all.find(item => item.props.className === 'generation-image-enable');
  assert.equal(all.filter(item => item.props['data-testid'] === `${aId}-enabled`).length, 1); assert.equal(label?.props.htmlFor, toggle.props.id);
  assert.ok(all.indexOf(toggle) > all.indexOf(ui.find(aField))); assert.ok(nodes(label).some(item => item.type === 'small' && item.props.id === toggle.props['aria-describedby']));
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
  resolve({revision: 0, connections: [], storage: {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}, notice: null}); await flush(); assert.equal(ui.render().services.length, 2);
  const a = ui.domain().services[0]!; const id = a.key.slice(6); ui.select(a.key); ui.key(`${id}-key`, 'synthetic-replay-only'); const ticket = ui.domain().prepareSave()!;
  assert.equal(await ticket.run(), 'saved'); ticket.dispose(); assert.equal(f.writes, 1); assert.equal(reads, 2);
});

test('legacy reset notice is visible for an empty collection and can be dismissed once without consuming the server notice', async () => {
  let reads = 0; const snapshot = {revision: 0, connections: [], storage: {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}, notice: 'LEGACY_CUSTOM_IMAGE_SETTINGS_RESET'};
  const ui = harness({read: async () => {reads++; return snapshot;}, write: async () => assert.fail('Dismissing is local')});
  ui.render(); await flush(); const domain = ui.render(); assert.deepEqual(domain.services, []); assert.ok(domain.notice);
  const close = nodes(domain.notice).find(item => item.type === 'Button'); assert.ok(close); (close.props.onClick as () => void)();
  assert.equal(ui.render().notice, undefined); ui.visible(false); ui.visible(true); assert.equal(ui.render().notice, undefined); assert.equal(reads, 1); assert.equal(snapshot.notice, 'LEGACY_CUSTOM_IMAGE_SETTINGS_RESET'); ui.unmount();
});
