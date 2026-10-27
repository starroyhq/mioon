import type {RootTree, RootNode, RootHook} from './helpers/strict-root-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformSync } from 'esbuild';
import * as navigation from '../apps/web/src/settings-navigation-state.ts';
import * as agent from '../apps/web/src/agent-settings.ts';
import * as image from '../apps/web/src/image-settings.ts';
import * as comfy from '../apps/web/src/comfy-image-settings.ts';
import * as i18nCore from '../packages/i18n/src/index.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import { DEFAULT_COMFY_IMAGE_CONFIGURATION } from '@mioon/contracts';

interface SettingsSnapshot {revision: number; configuration: Record<string, unknown>; secret?: {configured: boolean; storage: string}; storage?: typeof storage; presets?: unknown[]; scope?: string; verification?: string; readiness?: {checked: boolean; checkedAt: null}}
interface SettingsWrite {expectedRevision: number; configuration: Record<string, unknown>; secret?: {action: string; storage: string}}
interface SettingsOverrides {write?(input: SettingsWrite, saved: SettingsSnapshot): unknown; read?(count: number, saved: SettingsSnapshot): unknown; check?(input: unknown): unknown}
const deferred = () => { let resolve!: (value?: unknown) => void, reject!: (error: unknown) => void; const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const copy = <T>(value: T): T => structuredClone(value);
const config = { presetId: 'openai', platformId: 'global', baseUrl: 'https://api.example.com/v1', model: 'synthetic-model', protocol: 'chat_completions' };
const storage = { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' };
function snapshot(slot: string): SettingsSnapshot {
  if (slot === 'agent') return { revision: 0, configuration: { ...config }, secret: { configured: false, storage: 'none' }, storage,
    scope: 'settings_only', verification: 'not_tested', presets: [{ id: 'openai', label: 'OpenAI', platforms: [{ id: 'global', label: 'Global', baseUrl: config.baseUrl, model: config.model, defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], sources: [] }] }] };
  if (slot === 'comfy') return { revision: 0, configuration: { ...copy(DEFAULT_COMFY_IMAGE_CONFIGURATION), enabled: true, baseUrl: 'http://127.0.0.1:8188', model: 'synthetic.safetensors' }, readiness: { checked: false, checkedAt: null } };
  return { revision: 0, configuration: slot === 'official' ? copy(image.DEFAULT_IMAGE_CONFIGURATION) : { ...copy(image.DEFAULT_CUSTOM_IMAGE_CONFIGURATION), baseUrl: 'https://images.example.com/v1', model: 'synthetic-image' }, secret: { configured: false, storage: 'none' }, storage };
}
function fixture(slot: string, options: SettingsOverrides = {}) {
  let saved = snapshot(slot), reads = 0; const writes: SettingsWrite[] = [], checks: unknown[] = [];
  const client = {
    ...(slot === 'comfy' ? { readAvailability: async () => ({ schemaVersion: 1, connectorId: 'mioon.comfy-local', implementationVersion: '1', state: 'available', reason: 'ready', fixedForSession: true }) } : {}),
    read: () => { reads++; return options.read ? options.read(reads, copy(saved)) : Promise.resolve(copy(saved)); },
    write: (input: SettingsWrite) => {
      writes.push(copy(input));
      saved = { ...saved, revision: input.expectedRevision + 1, configuration: copy(input.configuration) };
      if (input.secret) saved.secret = input.secret.action === 'replace' ? { configured: true, storage: input.secret.storage } : input.secret.action === 'remove' ? { configured: false, storage: 'none' } : saved.secret;
      return options.write ? options.write(input, copy(saved)) : Promise.resolve(copy(saved));
    },
    check: (input: unknown) => { checks.push(copy(input)); return options.check?.(input); },
  };
  return { client, writes, checks, get reads() { return reads; }, saved: () => copy(saved) };
}
const nodes = (tree: RootTree) : RootNode[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const equalDeps = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
function renderer(slot: string, f: {client: unknown}, callback?: (value: navigation.SettingsNavigationState) => void, options: {beforeClose?: () => unknown; closeLabel?: string} = {}) {
  const filename = slot === 'agent' ? 'AgentSettings.tsx' : slot === 'comfy' ? 'ComfyImageSettings.tsx' : 'ImageSettings.tsx';
  // Allows the same behavioral assertions to run against a separately extracted
  // baseline component, without changing the working tree or weakening tests.
  const source = readFileSync(process.env.MIOON_SETTINGS_COMPONENT_ROOT ? resolve(process.env.MIOON_SETTINGS_COMPONENT_ROOT, filename) : new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8');
  const hooks: RootHook[] = [], dom = new Map<string, {value: string}>(), changes: navigation.SettingsNavigationState[] = []; let cursor = 0, effects: number[] = [], tree: RootTree, visible = true, contextKey = 'project-one', closes = 0;
  let onNavigationStateChange = callback || (value => changes.push(value));
  const react: {default?: unknown} & Record<string, unknown> = {
    createElement(type: unknown, props: Record<string, unknown> = {}, ...children: unknown[]) { return { type, props: { ...props, children } }; },
    useState(initial: unknown) { const i = cursor++; hooks[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[i].value, (value: unknown) => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; }]; },
    useRef(initial: unknown) { return hooks[cursor++] ||= { current: initial }; },
    useMemo(fn: () => unknown, deps: readonly unknown[]) { const i = cursor++; if (!hooks[i] || !equalDeps(hooks[i].deps, deps)) hooks[i] = { value: fn(), deps }; return hooks[i].value; },
    useLayoutEffect(fn: () => void | (() => void), deps: readonly unknown[]) { const i = cursor++, old = hooks[i]; if (old && equalDeps(old.deps, deps)) return; hooks[i] = { fn, deps, cleanup: old?.cleanup }; effects.push(i); },
  }; react.default = react;
  const module = { exports: {} as {default(props: unknown): RootTree} }, primitives = new Proxy({}, { get: (_, key) => String(key) });
  Function('module', 'exports', 'require', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)(module, module.exports, (name: string) => {
    if (name === 'react') return react;
    if (name === './i18n/I18nProvider.tsx') return i18nTestModule();
    if (name.includes('packages/i18n/src/index.ts')) return i18nCore;
    if (name === './settings-navigation-state.ts') return navigation;
    if (name === './agent-settings.ts') return { ...agent, createAgentSettingsSession: (options?: agent.AgentSettingsSessionOptions|undefined) => agent.createAgentSettingsSession({ ...options, client: f.client as agent.AgentSettingsClient }) };
    if (name === './image-settings.ts') return image;
    if (name === './comfy-image-settings.ts') return comfy;
    if (name === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => visible };
    // Authorization management is a separate presentation leaf; this fixture
    // executes the settings session and its navigation callbacks.
    if (name === './AgentAuthorizations.tsx') return { default: 'AgentAuthorizations', __esModule: true };
    // Execution policy owns a separate session; these cases exercise the
    // credential form's existing dirty, busy and recovery navigation state.
    if (name === './AgentTaskPolicy.tsx') return { default: 'AgentTaskPolicy', __esModule: true };
    // The connection test owns its own diagnostic session (agent-connection-test.ts).
    if (name === './AgentConnectionTest.tsx') return { default: 'AgentConnectionTest', __esModule: true };
    if (name.startsWith('@mioon/ui/') || name === './WorkspaceControls.tsx') return primitives;
    if (name === './icons.tsx') return { default: 'Icon' };
    if (name.endsWith('.css')) return {};
    throw Error(`Unexpected import ${name}`);
  });
  const prefix = slot === 'agent' ? 'agent-settings' : slot === 'official' ? 'image-settings' : `${slot}-image-settings`;
  const ui = {
    render() {
      cursor = 0; effects = [];
      tree = module.exports.default({ active: visible, contextKey, slot, client: f.client, onNavigationStateChange, beforeClose: options.beforeClose, closeLabel: options.closeLabel, onClose() { closes++; } });
      for (const node of nodes(tree)) if (node.props.ref) { const id = node.props.id; if (!dom.has(id)) dom.set(id, { value: '' }); (node.props.ref as {current: unknown}).current = dom.get(id); }
      for (const i of effects) { hooks[i].cleanup?.(); hooks[i].cleanup = hooks[i].fn!(); }
      return tree;
    },
    find(suffix: string) { return nodes(tree).find((node: RootNode) => node.props['data-testid'] === `${prefix}-${suffix}`); },
    edit(value: string|boolean) { const field = ui.find(slot === 'agent' ? 'model' : 'enable'); (field)!.props.onChange({ target: { value, checked: value } }); },
    key(value: string) { const field = ui.find('key'); ((field)!.props.ref as {current: {value: string}}).current.value = value; (field)!.props.onChange({ target: { value } }); },
    save() { (nodes(tree).find((node: RootNode) => node.type === 'form'))!.props.onSubmit({ preventDefault() {} }); },
    back() { return (ui.find('back'))!.props.onClick(); },
    get closes() { return closes; },
    hide() { visible = false; ui.render(); },
    show() { visible = true; ui.render(); },
    project(value: string) { contextKey = value; ui.render(); },
    replaceCallback(value: (value: navigation.SettingsNavigationState) => void) { onNavigationStateChange = value; ui.render(); },
    unmount() { for (const hook of hooks) hook.cleanup?.(); },
    changes, latest: () => changes.at(-1)!,
  };
  return ui;
}
async function ready(ui: ReturnType<typeof renderer>) { ui.render(); await flush(); ui.render(); }
const changedValue = (slot: string) => slot === 'agent' ? 'edited-model' : slot !== 'comfy';
const assertSafe = (changes: navigation.SettingsNavigationState[]) => { for (const state of changes) { assert.deepEqual(Object.keys(state).sort(), ['blocked', 'busy', 'dirty', 'version']); for (const name of ['dirty', 'busy', 'blocked'] as const) assert.equal(typeof state[name], 'boolean'); assert.ok(Number.isSafeInteger(state.version)); assert.equal(Object.isFrozen(state), true); } assert.doesNotMatch(JSON.stringify(changes), /synthetic-key|api\.example|images\.example|edited-model|configuration|secret|storage/); };

for (const slot of ['agent', 'official', 'custom', 'comfy']) {
  test(`${slot}: actual settings publishes synchronous dirty and busy state without form data`, async () => {
    const held = deferred(), f = fixture(slot, { write: () => held.promise }), ui = renderer(slot, f);
    await ready(ui); assert.ok(ui.latest(), 'The mounted settings form must publish navigation state');
    assert.deepEqual({ ...ui.latest(), version: 0 }, { dirty: false, busy: false, blocked: false, version: 0 });
    const beforeEdit = ui.latest().version; ui.edit(changedValue(slot));
    assert.equal(ui.latest().dirty, true, 'Must notify before React renders'); assert.ok(ui.latest().version > beforeEdit);
    const beforeSave = ui.latest().version; ui.save(); assert.equal(ui.latest().busy, true, 'Pending write must be synchronous'); assert.ok(ui.latest().version > beforeSave); assert.equal(f.writes.length, 1);
    (held.resolve)!(f.saved()); await flush(); assert.equal(ui.latest().busy, false); assert.equal(ui.latest().dirty, false); assert.equal(ui.latest().blocked, false);
    assertSafe(ui.changes); ui.unmount();
  });

  test(`${slot}: matching readback after unknown save still blocks until explicit review`, async () => {
    const f = fixture(slot, { write: () => Promise.reject(Object.assign(Error('synthetic-key-never-reflected'), { code: 'NETWORK' })) }), ui = renderer(slot, f);
    await ready(ui); ui.edit(changedValue(slot)); ui.save(); await flush(); ui.render();
    assert.ok(ui.latest(), 'Unknown results need a navigation report'); assert.equal(ui.latest().dirty, false, 'Fixture rereads the matching saved configuration');
    assert.equal(ui.latest().busy, false); assert.equal(ui.latest().blocked, true); assert.equal(f.writes.length, 1); assert.equal(f.reads, 2);
    const registry = navigation.createSettingsNavigationRegistry(), owner = registry.register(slot); owner.update(ui.latest()); assert.equal(registry.canLeave(registry.capture()), false);
    const button = slot === 'comfy' ? nodes(ui.render()).find(node => node.type === 'Button' && JSON.stringify(node.props.children).includes('核对后保留草稿')) : ui.find(slot === 'agent' ? 'review' : 'keep-draft');
    (button)!.props.onClick(); assert.equal(ui.latest().blocked, false); assert.equal(f.writes.length, 1); assertSafe(ui.changes); ui.unmount();
  });

  test(`${slot}: unresolved reconciliation publishes busy and blocked before any readback arrives`, async () => {
    const held = deferred(), f = fixture(slot, { read: (count, saved) => count === 1 ? Promise.resolve(saved) : held.promise,
      write: () => Promise.reject(Object.assign(Error('unknown'), { code: 'NETWORK' })) }), ui = renderer(slot, f);
    await ready(ui); ui.edit(changedValue(slot)); ui.save(); await flush();
    assert.ok(ui.latest(), 'Recovery requires a synchronous navigation report'); assert.equal(ui.latest().busy, true); assert.equal(ui.latest().blocked, true);
    const capturedVersion = ui.latest().version; (held.reject)!(Error('read failed')); await flush();
    assert.equal(ui.latest().busy, false); assert.equal(ui.latest().blocked, true); assert.ok(ui.latest().version > capturedVersion); assert.equal(f.writes.length, 1); ui.unmount();
  });

  test(`${slot}: an edit before async discard confirmation invalidates the exact captured version`, async () => {
    const registry = navigation.createSettingsNavigationRegistry(), owner = registry.register(slot), f = fixture(slot), reports: navigation.SettingsNavigationState[] = [];
    const ui = renderer(slot, f, (value: navigation.SettingsNavigationState) => { reports.push(value); owner.update(value); }); await ready(ui); ui.edit(changedValue(slot));
    const captured = registry.capture(); assert.equal(registry.needsConfirmation(captured), true); assert.equal(registry.canLeave(captured), true);
    const confirmation = deferred(), pending = confirmation.promise.then(approved => approved && registry.canLeave(captured));
    ui.edit(slot === 'agent' ? 'newer-model' : !changedValue(slot)); (confirmation.resolve)!(true);
    assert.equal(await pending, false); assertSafe(reports); ui.unmount(); owner.release();
  });

  test(`${slot}: late save acknowledgement after owner replacement cannot clear the new owner`, async () => {
    const registry = navigation.createSettingsNavigationRegistry(), old = registry.register(slot), held = deferred(), f = fixture(slot, { write: () => held.promise });
    const reports: navigation.SettingsNavigationState[] = [], ui = renderer(slot, f, (value: navigation.SettingsNavigationState) => { reports.push(value); old.update(value); }); await ready(ui); ui.edit(changedValue(slot)); ui.save();
    assert.ok(reports.length, 'Pending writes must publish into the mounted owner');
    const replacement = registry.register(slot); replacement.update({ dirty: true, busy: false, blocked: true, version: 1 });
    const captured = registry.capture(); ui.unmount(); old.release(); const count = reports.length;
    (held.resolve)!(f.saved()); await flush(); assert.equal(reports.length, count, 'Disposed session cannot report a late success');
    assert.deepEqual(registry.capture(), captured); assert.equal(registry.canLeave(captured), false); assert.equal(f.writes.length, 1); replacement.release();
  });
}

for (const slot of ['agent', 'official', 'custom']) test(`${slot}: a second nonempty key invalidates confirmation and hide clears it without reporting bytes`, async () => {
  const registry = navigation.createSettingsNavigationRegistry(), owner = registry.register(slot), reports: navigation.SettingsNavigationState[] = [], ui = renderer(slot, fixture(slot), (value: navigation.SettingsNavigationState) => { reports.push(value); owner.update(value); });
  await ready(ui); ui.key('synthetic-key-first'); assert.ok(reports.length, 'Password edits must publish navigation metadata'); assert.equal((reports.at(-1))!.dirty, true);
  const captured = registry.capture(), version = (reports.at(-1))!.version; ui.key('synthetic-key-second');
  assert.equal((reports.at(-1))!.dirty, true); assert.ok((reports.at(-1))!.version > version); assert.equal(registry.canLeave(captured), false);
  ui.hide(); assert.equal(((ui.find('key'))!.props.ref as {current: {value: string}}).current.value, ''); assert.equal((reports.at(-1))!.dirty, false); assertSafe(reports); ui.unmount(); owner.release();
});

test('Comfy explicit probe reports busy immediately and remains blocked while the probe is pending', async () => {
  const held = deferred(), f = fixture('comfy', { check: () => held.promise }), ui = renderer('comfy', f); await ready(ui);
  (ui.find('check'))!.props.onClick(); assert.ok(ui.latest(), 'The probe must publish navigation metadata'); assert.equal(ui.latest().busy, true); assert.equal(f.checks.length, 1);
  const registry = navigation.createSettingsNavigationRegistry(), owner = registry.register('comfy'); owner.update(ui.latest()); assert.equal(registry.canLeave(registry.capture()), false);
  ui.unmount(); (held.resolve)!({}); await flush(); assert.equal(f.checks.length, 1); owner.release();
});

test('actual callback and context changes invalidate earlier captured status without losing nonsecret drafts', async () => {
  const first: navigation.SettingsNavigationState[] = [], second: navigation.SettingsNavigationState[] = [], ui = renderer('custom', fixture('custom'), value => first.push(value)); await ready(ui);
  ui.edit(true); assert.ok(first.length, 'The current callback owner must receive a report'); const before = first.at(-1)!.version;
  ui.replaceCallback(value => second.push(value)); assert.equal(first.at(-1)!.dirty, false, 'Only the old owner receives its cleanup');
  assert.equal(second.at(-1)!.dirty, true); assert.ok(second.at(-1)!.version > before);
  const changed = second.at(-1)!.version; ui.project('project-two');
  assert.equal(second.at(-1)!.dirty, true); assert.ok(second.at(-1)!.version > changed); assert.equal((ui.find('enable'))!.props.checked, true);
  assertSafe([...first, ...second]); ui.unmount();
});

test('reporter cleanup and callback replacement preserve owner/version fences and exact metadata allowlist', () => {
  const reporter = navigation.createSettingsNavigationReporter(), first: navigation.SettingsNavigationState[] = [], second: navigation.SettingsNavigationState[] = [];
  const old = reporter.connect(value => first.push(value), { dirty: true, phase: 'ready' });
  const next = reporter.connect(value => second.push(value), { dirty: true, phase: 'saving' }); const captured = reporter.getState();
  reporter.disconnect(old); assert.equal(reporter.getState(), captured); assert.equal(second.length, 1);
  reporter.update({ dirty: false, phase: 'future-unknown-phase', recovery: null }); assert.equal(second.at(-1)!.blocked, true);
  reporter.disconnect(next); assert.deepEqual({ ...second.at(-1), version: 0 }, { dirty: false, busy: false, blocked: false, version: 0 });
  assertSafe([...first, ...second]);
});

test('registry binds all four slots, rejects stale reports and invalidates membership changes', () => {
  const registry = navigation.createSettingsNavigationRegistry(), owners = ['agent', 'official', 'custom', 'comfy'].map(slot => registry.register(slot));
  assert.equal(registry.canLeave(registry.capture()), false, 'Unreported forms fail closed');
  owners.forEach(owner => owner.update({ dirty: false, busy: false, blocked: false, version: 1 }));
  let captured = registry.capture(); assert.equal(registry.canLeave(captured), true); assert.equal(registry.needsConfirmation(captured), false);
  owners[2].update({ dirty: true, busy: false, blocked: false, version: 2 }); assert.equal(registry.canLeave(captured), false);
  captured = registry.capture(); assert.equal(registry.needsConfirmation(captured), true);
  owners[2].update({ dirty: false, busy: false, blocked: false, version: 1 }); assert.deepEqual(registry.capture(), captured);
  owners[3].release(); assert.equal(registry.canLeave(captured), false); assert.equal(registry.canLeave([]), false);
});

// Settings › Mio (07-09) has no form-level Back: the settings center's close control and its navigation guard
// close it, and hiding the page clears an entered key. The image forms keep their own Back.
test('agent: the page has no form-level Back; Discard reverts the draft without closing', async () => {
  const f = fixture('agent'), ui = renderer('agent', f, undefined, { beforeClose: () => true }); await ready(ui);
  assert.equal(ui.find('back'), undefined);
  ui.edit(changedValue('agent')); ui.render(); assert.equal(ui.latest().dirty, true); assert.equal(ui.find('cancel')!.props.disabled, false);
  ui.find('cancel')!.props.onClick(); ui.render();
  assert.equal(ui.closes, 0); assert.equal(ui.latest().dirty, false); assert.equal(ui.find('model')!.props.value, f.saved().configuration.model); assert.equal(f.writes.length, 0);
  ui.key('synthetic-key-before-hide'); ui.hide(); assert.equal((ui.find('key')!.props.ref as {current: {value: string}}).current.value, ''); ui.unmount();
});

for (const slot of ['official', 'custom', 'comfy']) {
  test(`${slot}: Back cancellation leaves the visible form editable and saveable`, async () => {
    for (const beforeClose of [() => false, () => Promise.resolve(false), () => Promise.reject(Error('cancelled')), () => { throw Error('cancelled'); }, () => 'yes']) {
      const f = fixture(slot), ui = renderer(slot, f, undefined, { beforeClose }); await ready(ui);
      ui.edit(changedValue(slot)); ui.render(); await ui.back(); assert.equal(ui.closes, 0, 'Rejected permission must not invalidate or close the visible form');
      ui.edit(slot === 'agent' ? 'after-cancel-model' : !changedValue(slot)); ui.save(); await flush();
      assert.equal(f.writes.length, 1, 'The unchanged session must still accept edits and saves after Cancel'); assert.equal(ui.latest().busy, false); assert.equal(ui.latest().blocked, false); ui.unmount();
    }
  });

  test(`${slot}: Back denied during saving or unknown recovery keeps the session usable`, async () => {
    for (const outcome of ['saving', 'unknown']) {
      const held = deferred(); let writes = 0, ui: ReturnType<typeof renderer>;
      const f = fixture(slot, { write: (_, saved) => ++writes > 1 ? Promise.resolve(saved) : outcome === 'saving' ? held.promise : Promise.reject(Object.assign(Error('unknown'), { code: 'NETWORK' })) });
      ui = renderer(slot, f, undefined, { beforeClose: () => !ui.latest().busy && !ui.latest().blocked }); await ready(ui);
      ui.edit(changedValue(slot)); ui.save(); if (outcome === 'unknown') await flush(); ui.render();
      assert.equal(await ui.back(), false); assert.equal(ui.closes, 0);
      if (outcome === 'saving') { (held.resolve)!(f.saved()); await flush(); ui.render(); }
      else {
        const button = slot === 'comfy' ? nodes(ui.render()).find(node => node.type === 'Button' && JSON.stringify(node.props.children).includes('核对后保留草稿')) : ui.find(slot === 'agent' ? 'review' : 'keep-draft');
        (button)!.props.onClick(); ui.render();
      }
      ui.edit(slot === 'agent' ? 'after-denied-model' : !changedValue(slot)); ui.save(); await flush();
      assert.equal(f.writes.length, 2, 'A denied Back must not hide or invalidate the session'); assert.equal(ui.latest().blocked, false); ui.unmount();
    }
  });

  test(`${slot}: old Back permission cannot close after visibility, edits, owner replacement or unmount`, async () => {
    for (const transition of ['visibility', 'edit', 'owner', 'unmount']) {
      const held = deferred(), f = fixture(slot), ui = renderer(slot, f, undefined, { beforeClose: () => held.promise }); await ready(ui);
      ui.edit(changedValue(slot)); ui.render(); const pending = ui.back(); assert.equal(ui.closes, 0);
      if (transition === 'visibility') { ui.hide(); ui.show(); }
      if (transition === 'edit') ui.edit(slot === 'agent' ? 'while-awaiting-model' : !changedValue(slot));
      if (transition === 'owner') ui.replaceCallback(() => {});
      if (transition === 'unmount') ui.unmount();
      (held.resolve)!(true); assert.equal(await pending, false); assert.equal(ui.closes, 0); assert.equal(f.writes.length, 0);
      if (transition !== 'unmount') { ui.edit(slot === 'agent' ? 'still-usable-model' : changedValue(slot)); ui.save(); assert.equal(f.writes.length, 1); await flush(); ui.unmount(); }
    }
  });

  test(`${slot}: accepted current Back runs existing close exactly once, while omitted guard stays synchronous`, async () => {
    const held = deferred(), f = fixture(slot), ui = renderer(slot, f, undefined, { beforeClose: () => held.promise }); await ready(ui);
    if (slot !== 'comfy') ui.key('synthetic-key-before-close');
    const pending = ui.back(); assert.equal(ui.closes, 0);
    if (slot !== 'comfy') assert.equal(((ui.find('key'))!.props.ref as {current: {value: string}}).current.value, 'synthetic-key-before-close', 'Pending permission cannot clear the input');
    (held.resolve)!(true); assert.equal(await pending, true); assert.equal(ui.closes, 1);
    if (slot !== 'comfy') assert.equal(((ui.find('key'))!.props.ref as {current: {value: string}}).current.value, '');
    ui.back(); assert.equal(ui.closes, 1); assert.equal(f.writes.length, 0); ui.unmount();
    const legacy = renderer(slot, fixture(slot)); await ready(legacy); legacy.back(); assert.equal(legacy.closes, 1, 'No guard preserves the existing synchronous close'); legacy.unmount();
  });
}

const textContent = (tree: RootTree): string => Array.isArray(tree) ? tree.map(textContent).join('') : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : tree && typeof tree === 'object' ? textContent(tree.props?.children) : '';
for (const slot of ['official', 'custom', 'comfy']) test(`${slot}: optional closeLabel changes only return text and accessibility labels`, async () => {
  for (const closeLabel of [undefined, '返回项目列表']) {
    const f = fixture(slot), ui = renderer(slot, f, undefined, { closeLabel }); await ready(ui);
    const back = ui.find('back');
    assert.equal((back)!.props['aria-label'], closeLabel ?? (slot === 'agent' ? '返回 Mio 对话' : slot === 'comfy' ? i18nCore.translate('zh-Hans', 'connections.back') : '返回图像工坊'));
    assert.equal(textContent(slot === 'agent' ? ui.find('cancel') : back), closeLabel ?? (slot === 'agent' ? '返回对话' : '返回'));
    assert.equal((back)!.props.disabled, false); assert.equal(ui.latest().dirty, false); assert.equal(ui.latest().busy, false); assert.equal(ui.latest().blocked, false);
    ui.back(); assert.equal(ui.closes, 1, 'Presentation-only label must retain the same synchronous onClose behavior');
    assert.equal(f.writes.length, 0); assert.equal(f.checks.length, 0); ui.unmount();
  }
});
