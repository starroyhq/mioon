import type {Locale} from '../packages/i18n/src/types.ts';
import type {UiPreferences} from '../packages/contracts/src/ui-preferences.ts';
interface AppearanceState {preferences: UiPreferences; resolvedTheme: string; saved: {writable: boolean; preferences?: UiPreferences} | null; phase: string; pending: boolean; dirty: boolean; edit(value: unknown): void; save(): Promise<unknown>; discard(): void; reload(): Promise<unknown>}
import type {RootHook} from './helpers/strict-root-ui-types.ts';
import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { DEFAULT_UI_PREFERENCES } from '../packages/contracts/src/ui-preferences.ts';
import { appearanceMessages } from '../packages/i18n/src/catalogs/appearance.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import * as navigation from '../apps/web/src/settings-navigation-state.ts';

const code = transformSync(readFileSync(new URL('../apps/web/src/SettingsAppearance.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
const nodes = (tree: RootTree) : RootNode[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = (tree: RootTree) : string => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
function fixture(locale: Locale = 'en', patch: Partial<AppearanceState> = {}) {
  const hooks: RootHook[] = [], edits: unknown[] = [], reports: navigation.SettingsNavigationState[] = [], calls: string[] = []; let cursor = 0, effects: number[] = [], tree: string|number|boolean|RootNode|RootTree[]|null|undefined;
  const state: AppearanceState = { preferences: { ...DEFAULT_UI_PREFERENCES }, resolvedTheme: 'dark', saved: { writable: true, preferences: { ...DEFAULT_UI_PREFERENCES } }, phase: 'ready', pending: false, dirty: false,
    edit(value: unknown) { edits.push(value); }, save: async () => { calls.push('save'); return true; }, discard() { calls.push('discard'); }, reload: async () => { calls.push('reload'); return true; }, ...patch };
  const react = {
    createElement: (type: string, props: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...props, children } }),
    useRef(value: unknown) { return hooks[cursor++] ||= { current: value }; },
    useState(initial: unknown) { const index = cursor++; hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, (value: unknown) => { hooks[index].value = value; }]; },
    useLayoutEffect(callback: () => void | (() => void), deps: readonly unknown[] | undefined) { const index = cursor++, previous = hooks[index]; if (previous && previous.deps!.length === deps!.length && deps!.every((value, i) => Object.is(value, previous.deps![i]))) return; hooks[index] = { callback, deps, cleanup: previous?.cleanup }; effects.push(index); },
  }; (react as typeof react & {default?: unknown}).default = react;
  const primitives = new Proxy({}, { get: (_, key) => String(key) });
  const module = { exports: {} as Record<string, (props: unknown) => RootTree> };
  Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'react') return react;
    if (name === './i18n/I18nProvider.tsx') return i18nTestModule(locale);
    if (name === './UiPreferencesProvider.tsx') return { useUiPreferences: () => state };
    if (name === './settings-navigation-state.ts') return navigation;
    if (name.startsWith('@mioon/ui/')) return primitives;
    assert.fail(`Unexpected appearance setting import ${name}`);
  }, module, module.exports);
  const report = (value: navigation.SettingsNavigationState) => reports.push(value);
  return {
    state, edits, reports, calls,
    render(active: boolean|undefined = true) { cursor = 0; effects = []; tree = module.exports.default({ active, onNavigationStateChange: report }); for (const index of effects) { const hook = hooks[index]; hook.cleanup?.(); hook.cleanup = hook.callback!(); } return tree; },
    node(id: string) { const owner = nodes(tree).find((node: RootNode) => node.props?.['data-testid'] === id); return nodes(owner).find((node: RootNode) => node.type === 'WorkbenchTabs') ?? owner; },
    button(label: string) { return nodes(tree).find((node: RootNode) => node.type === 'WorkbenchButton' && text(node) === label); },
    get tree() { return tree; },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) test(`actual ${locale} settings present dark, light and system with approved localized labels`, () => {
  const f = fixture(locale); f.render(); const select = f.node('appearance-theme');
  const options = (select)!.props.options;
  assert.deepEqual(options.map(option => option.value), ['dark', 'light', 'system']);
  assert.deepEqual(options.map(option => option.label), (['dark', 'light', 'system'] as const).map(value => appearanceMessages[`appearance.${value}` as keyof typeof appearanceMessages][locale]));
  assert.ok((select)!.props.options.every((option: { disabled: boolean; }) => option.disabled === false)); assert.equal((select)!.props.value, 'dark');
  assert.doesNotMatch(text(f.tree), /under review|until approval|尚在确认|仍在確認|確認中|現在はダーク/);
});

test('all three explicit theme choices reach the existing edit/report path while unknown values are rejected', () => {
  const f = fixture(); f.render();
  for (const theme of ['dark', 'light', 'system']) (f.node('appearance-theme'))!.props.onValueChange(theme);
  assert.deepEqual(f.edits, [{ theme: 'dark' }, { theme: 'light' }, { theme: 'system' }]);
  assert.equal(f.reports.at(-1)!.dirty, true);
  const count = f.reports.length; (f.node('appearance-theme'))!.props.onValueChange('unknown');
  assert.equal(f.edits.length, 3); assert.equal(f.reports.length, count);
});

test('hidden and unmounted setting callbacks cannot edit, save or discard a theme draft', () => {
  const f = fixture('en', { dirty: true }); f.render();
  const choose = (f.node('appearance-theme'))!.props.onValueChange, save = (f.node('appearance-save'))!.props.onClick, discard = (f.button('Discard'))!.props.onClick;
  f.render(false); choose('light'); save(); discard();
  assert.deepEqual((f.edits as unknown), []); assert.deepEqual((f.calls as unknown), []);
  f.render(true); choose('light'); assert.deepEqual(f.edits, [{ theme: 'light' }]);
  f.unmount(); choose('system'); save(); discard();
  assert.equal(f.edits.length, 1); assert.deepEqual((f.calls as unknown), []);
});

for (const patch of [{ phase: 'loading' }, { phase: 'saving' }, { pending: true }, { saved: { writable: false } }]) test(`theme input preserves its existing admission fence ${JSON.stringify(patch)}`, () => {
  const f = fixture('en', patch); f.render(); const select = f.node('appearance-theme');
  assert.ok((select)!.props.options.every((option: { disabled: boolean; }) => option.disabled === true)); (select)!.props.onValueChange('light'); assert.deepEqual((f.edits as unknown), []);
});

test('a controlled saved light value is shown and save/discard continue through the existing owner', () => {
  const f = fixture('en', { preferences: { ...DEFAULT_UI_PREFERENCES, theme: 'light' }, dirty: true }); f.render();
  assert.equal((f.node('appearance-theme'))!.props.value, 'light');
  assert.equal((f.node('appearance-save'))!.props.disabled, false); (f.node('appearance-save'))!.props.onClick(); (f.button('Discard'))!.props.onClick();
  assert.deepEqual(f.calls, ['save', 'discard']); assert.ok(f.reports.some(report => report.busy));
});

test('a reload finishing after the settings unmount cannot discard the live global draft', async () => {
  let complete!: (value: boolean) => void; const pending = new Promise<boolean>(resolve => { complete = resolve; });
  const f = fixture('en', { phase: 'error', reload: () => pending }); f.render();
  const alert = nodes(f.tree).find((node: RootNode) => node.type === 'WorkbenchAlert');
  const reload = (alert)!.props.actions.props.onClick(); f.unmount(); (complete)!(true); await reload;
  assert.deepEqual((f.calls as unknown), []);
});
