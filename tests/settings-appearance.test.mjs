import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { DEFAULT_UI_PREFERENCES } from '../packages/contracts/src/ui-preferences.ts';
import { appearanceMessages } from '../packages/i18n/src/catalogs/appearance.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import * as navigation from '../apps/web/src/settings-navigation-state.ts';

const code = transformSync(readFileSync(new URL('../apps/web/src/SettingsAppearance.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
function fixture(locale = 'en', patch = {}) {
  const hooks = [], edits = [], reports = [], calls = []; let cursor = 0, effects = [], tree;
  const state = { preferences: { ...DEFAULT_UI_PREFERENCES }, resolvedTheme: 'dark', saved: { writable: true, preferences: { ...DEFAULT_UI_PREFERENCES } }, phase: 'ready', pending: false, dirty: false,
    edit(value) { edits.push(value); }, save: async () => { calls.push('save'); return true; }, discard() { calls.push('discard'); }, reload: async () => { calls.push('reload'); return true; }, ...patch };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef(value) { return hooks[cursor++] ||= { current: value }; },
    useState(initial) { const index = cursor++; hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { hooks[index].value = value; }]; },
    useLayoutEffect(callback, deps) { const index = cursor++, previous = hooks[index]; if (previous && previous.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return; hooks[index] = { callback, deps, cleanup: previous?.cleanup }; effects.push(index); },
  }; react.default = react;
  const primitives = new Proxy({}, { get: (_, key) => String(key) });
  const module = { exports: {} };
  Function('require', 'module', 'exports', code)(name => {
    if (name === 'react') return react;
    if (name === './i18n/I18nProvider.tsx') return i18nTestModule(locale);
    if (name === './UiPreferencesProvider.tsx') return { useUiPreferences: () => state };
    if (name === './settings-navigation-state.ts') return navigation;
    if (name.startsWith('@mioon/ui/')) return primitives;
    assert.fail(`Unexpected appearance setting import ${name}`);
  }, module, module.exports);
  const report = value => reports.push(value);
  return {
    state, edits, reports, calls,
    render(active = true) { cursor = 0; effects = []; tree = module.exports.default({ active, onNavigationStateChange: report }); for (const index of effects) { const hook = hooks[index]; hook.cleanup?.(); hook.cleanup = hook.callback(); } return tree; },
    node(id) { return nodes(tree).find(node => node.props?.['data-testid'] === id); },
    button(label) { return nodes(tree).find(node => node.type === 'WorkbenchButton' && text(node) === label); },
    get tree() { return tree; },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) test(`actual ${locale} settings present dark, light and system with approved localized labels`, () => {
  const f = fixture(locale); f.render(); const select = f.node('appearance-theme');
  const options = nodes(select).filter(node => node.type === 'option');
  assert.deepEqual(options.map(node => node.props.value), ['dark', 'light', 'system']);
  assert.deepEqual(options.map(text), ['dark', 'light', 'system'].map(value => appearanceMessages[`appearance.${value}`][locale]));
  assert.equal(select.props.disabled, false); assert.equal(select.props.value, 'dark');
  assert.doesNotMatch(text(f.tree), /under review|until approval|尚在确认|仍在確認|確認中|現在はダーク/);
});

test('all three explicit theme choices reach the existing edit/report path while unknown values are rejected', () => {
  const f = fixture(); f.render();
  for (const theme of ['dark', 'light', 'system']) f.node('appearance-theme').props.onChange({ target: { value: theme } });
  assert.deepEqual(f.edits, [{ theme: 'dark' }, { theme: 'light' }, { theme: 'system' }]);
  assert.equal(f.reports.at(-1).dirty, true);
  const count = f.reports.length; f.node('appearance-theme').props.onChange({ target: { value: 'unknown' } });
  assert.equal(f.edits.length, 3); assert.equal(f.reports.length, count);
});

test('hidden and unmounted setting callbacks cannot edit, save or discard a theme draft', () => {
  const f = fixture('en', { dirty: true }); f.render();
  const choose = f.node('appearance-theme').props.onChange, save = f.node('appearance-save').props.onClick, discard = f.button('Discard').props.onClick;
  f.render(false); choose({ target: { value: 'light' } }); save(); discard();
  assert.deepEqual(f.edits, []); assert.deepEqual(f.calls, []);
  f.render(true); choose({ target: { value: 'light' } }); assert.deepEqual(f.edits, [{ theme: 'light' }]);
  f.unmount(); choose({ target: { value: 'system' } }); save(); discard();
  assert.equal(f.edits.length, 1); assert.deepEqual(f.calls, []);
});

for (const patch of [{ phase: 'loading' }, { phase: 'saving' }, { pending: true }, { saved: { writable: false } }]) test(`theme input preserves its existing admission fence ${JSON.stringify(patch)}`, () => {
  const f = fixture('en', patch); f.render(); const select = f.node('appearance-theme');
  assert.equal(select.props.disabled, true); select.props.onChange({ target: { value: 'light' } }); assert.deepEqual(f.edits, []);
});

test('a controlled saved light value is shown and save/discard continue through the existing owner', () => {
  const f = fixture('en', { preferences: { ...DEFAULT_UI_PREFERENCES, theme: 'light' }, dirty: true }); f.render();
  assert.equal(f.node('appearance-theme').props.value, 'light');
  assert.equal(f.node('appearance-save').props.disabled, false); f.node('appearance-save').props.onClick(); f.button('Discard').props.onClick();
  assert.deepEqual(f.calls, ['save', 'discard']); assert.ok(f.reports.some(report => report.busy));
});

test('a reload finishing after the settings unmount cannot discard the live global draft', async () => {
  let complete; const pending = new Promise(resolve => { complete = resolve; });
  const f = fixture('en', { phase: 'error', reload: () => pending }); f.render();
  const alert = nodes(f.tree).find(node => node.type === 'WorkbenchAlert');
  const reload = alert.props.actions.props.onClick(); f.unmount(); complete(true); await reload;
  assert.deepEqual(f.calls, []);
});
