import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';
import type {SettingsServicesLayoutProps} from '../apps/web/src/SettingsServicesLayout.tsx';
import type {RootModule} from './helpers/strict-root-ui-types.ts';

const React = createRequire(new URL('../apps/web/package.json', import.meta.url))('react') as typeof import('react');
interface Node {type: unknown; props: Record<string, unknown>}
interface Hook {value?: unknown; deps?: readonly unknown[]; cleanup?: void | (() => void)}
const node = (value: unknown): value is Node => Boolean(value && typeof value === 'object' && 'props' in value);
function nodes(value: unknown): Node[] {
  return Array.isArray(value) ? value.flatMap(nodes) : node(value) ? [value, ...nodes(value.props.children)] : [];
}
function find(tree: unknown, id: string): Node {
  const value = nodes(tree).find(item => item.props['data-testid'] === id); assert.ok(value, id); return value;
}
function invoke(item: Node, name: string, ...args: unknown[]): unknown {
  const callback = item.props[name]; assert.ok(typeof callback === 'function', name); return callback(...args);
}
function fixture() {
  const hooks: Hook[] = [], selected: string[] = [], actions: string[] = [], visibility: boolean[] = [], focused: string[] = [];
  let cursor = 0, pending: Array<() => void> = [];
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({type, props: {...props, children}}),
    useId() { const index = cursor++; return (hooks[index] ??= {value: 'services-' + index}).value; },
    useRef(initial: unknown) { const index = cursor++; return (hooks[index] ??= {value: {current: initial}}).value; },
    createContext: (initial: unknown) => ({Provider: 'PanelProvider', initial}),
    useContext: (context: {initial: unknown}) => context.initial,
    useLayoutEffect(callback: () => void | (() => void), deps?: readonly unknown[]) {
      const index = cursor++, old = hooks[index];
      if (!old || !deps || deps.some((value, i) => value !== old.deps?.[i])) pending.push(() => {
        old?.cleanup?.(); hooks[index] = {deps, cleanup: callback()};
      });
    },
  };
  const module = {exports: {} as RootModule<typeof import('../apps/web/src/SettingsServicesLayout.tsx')>};
  const source = readFileSync(new URL('../apps/web/src/SettingsServicesLayout.tsx', import.meta.url), 'utf8');
  Function('require', 'module', 'exports', transformSync(source, {loader: 'tsx', format: 'cjs', jsx: 'transform'}).code)((name: string) => {
    if (name === 'react') return {...react, __esModule: true, default: react};
    if (name === '@mioon/ui/components/button') return {Button: 'Button'};
    if (name.endsWith('.css')) return {};
    assert.fail('Unexpected shell dependency: ' + name);
  }, module, module.exports);
  const first = React.createElement('input', {type: 'password', defaultValue: 'first-dom-draft'});
  const second = React.createElement('input', {type: 'password', defaultValue: 'second-dom-draft'});
  let props: SettingsServicesLayoutProps = {
    title: 'Opaque settings page', description: 'The caller owns the data.', pageVisible: true, selectedKey: 'first',
    groups: [{key: 'general', items: [{key: 'general', label: 'General'}]}, {key: 'services', title: 'Services', items: [
      {key: 'first', label: 'First', icon: 'I', badge: 'Configured'}, {key: 'disabled', label: 'Disabled', disabled: true}, {key: 'second', label: 'Second'},
    ], action: {label: 'Add', testId: 'add', onAction() { actions.push('add'); }}}],
    panels: [{key: 'general', content: 'General content'}, {key: 'first', content: first}, {key: 'disabled', content: 'Read only'}, {key: 'second', content: second}],
    onSelect(key) { selected.push(key); }, onPageVisibilityChange(value) { visibility.push(value); },
    footer: {state: 'partial', status: 'Some domains saved', save: {label: 'Save', testId: 'save', onAction() { actions.push('save'); }},
      discard: {label: 'Discard', testId: 'discard', onAction() { actions.push('discard'); }}},
  };
  return {first, second, selected, actions, visibility, focused,
    render(patch: Partial<SettingsServicesLayoutProps> = {}) {
      props = {...props, ...patch}; cursor = 0; pending = [];
      const tree = module.exports.default(props); for (const effect of pending) effect();
      for (const item of nodes(tree).filter(item => item.props.role === 'tab')) {
        const ref = item.props.ref, id = String(item.props['data-testid']);
        if (typeof ref === 'function') ref({focus() { focused.push(id); }});
      }
      return tree;
    },
    props: () => props,
    unmount() { for (const hook of hooks) hook.cleanup?.(); },
    panelVisibility: () => module.exports.useSettingsServicesPanel(),
  };
}

test('the generic frame arranges groups, one footer, and opaque caller content', () => {
  const f = fixture(), tree = f.render(), all = nodes(tree);
  assert.equal(find(tree, 'settings-services-layout').props['aria-label'], 'Opaque settings page');
  assert.deepEqual(all.filter(item => item.props.role === 'tab').map(item => item.props['data-testid']), [
    'settings-services-item-general', 'settings-services-item-first', 'settings-services-item-disabled', 'settings-services-item-second',
  ]);
  assert.equal(all.filter(item => item.type === 'footer').length, 1);
  assert.equal(all.find(item => item.type === 'footer')?.props['data-state'], 'partial');
  assert.equal(all.filter(item => item.props['data-testid'] === 'save').length, 1);
  assert.deepEqual(f.actions, []); assert.deepEqual(f.selected, []);
});

test('switching detail or hiding the whole page retains the exact mounted password elements', () => {
  const f = fixture();
  for (const [selectedKey, pageVisible] of [['first', true], ['second', true], ['second', false], ['first', true]] as const) {
    const tree = f.render({selectedKey, pageVisible});
    const panels = nodes(tree).filter(item => item.props.role === 'tabpanel');
    assert.equal(panels.length, 4);
    for (const [key, input] of [['first', f.first], ['second', f.second]] as const) {
      const panel = panels.find(item => item.props['data-service-panel'] === key); assert.ok(panel);
      assert.equal(panel.props.hidden, key !== selectedKey);
      assert.equal(panel.props.inert, key !== selectedKey || !pageVisible);
      const provider = nodes(panel).find(item => item.type === 'PanelProvider'); assert.ok(provider);
      assert.deepEqual(provider.props.value, {selected: key === selectedKey, pageVisible, active: key === selectedKey && pageVisible});
      assert.equal((provider.props.children as unknown[])[0], input);
    }
    assert.equal(find(tree, 'settings-services-layout').props.hidden, !pageVisible);
  }
  assert.deepEqual(f.visibility, [true, false, true]);
  assert.deepEqual(f.actions, []);
});

test('selection, group action, discard, and save delegate once without implicit writes', () => {
  const f = fixture(), tree = f.render();
  invoke(find(tree, 'settings-services-item-second'), 'onClick'); assert.deepEqual(f.selected, ['second']); assert.deepEqual(f.actions, []);
  invoke(find(tree, 'add'), 'onClick'); invoke(find(tree, 'discard'), 'onClick'); invoke(find(tree, 'save'), 'onClick');
  assert.deepEqual(f.actions, ['add', 'discard', 'save']);
});

test('retained callbacks cannot act after the page is hidden or unmounted', () => {
  const f = fixture(), first = f.render();
  f.render({pageVisible: false});
  for (const id of ['settings-services-item-first', 'add', 'discard', 'save']) invoke(find(first, id), 'onClick');
  assert.deepEqual(f.selected, []); assert.deepEqual(f.actions, []);
  const next = f.render({pageVisible: true}); f.unmount();
  for (const id of ['settings-services-item-second', 'add', 'discard', 'save']) invoke(find(next, id), 'onClick');
  assert.deepEqual(f.selected, []); assert.deepEqual(f.actions, []); assert.deepEqual(f.visibility, [true, false, true, false]);
});

test('current disabled state and removed items fence old callbacks', () => {
  const f = fixture(), first = f.render(), props = f.props();
  f.render({groups: [{key: 'services', items: [{key: 'first', label: 'First', disabled: true}]}],
    footer: {...props.footer, save: {...props.footer.save, disabled: true}, discard: {...props.footer.discard!, busy: true}}});
  for (const id of ['settings-services-item-first', 'settings-services-item-second', 'add', 'discard', 'save']) invoke(find(first, id), 'onClick');
  assert.deepEqual(f.actions, []); assert.deepEqual(f.selected, []);
});

test('vertical keyboard navigation skips disabled entries, wraps, and focuses the selected tab', () => {
  const f = fixture(), tree = f.render(); let prevented = 0;
  const press = (id: string, key: string) => invoke(find(tree, 'settings-services-item-' + id), 'onKeyDown', {key, preventDefault() { prevented++; }});
  press('first', 'ArrowDown'); press('second', 'ArrowDown'); press('general', 'ArrowUp'); press('second', 'Home'); press('general', 'End'); press('first', 'Tab');
  assert.deepEqual(f.selected, ['second', 'general', 'second', 'general', 'second']);
  assert.deepEqual(f.focused, ['settings-services-item-second', 'settings-services-item-general', 'settings-services-item-second', 'settings-services-item-general', 'settings-services-item-second']);
  assert.equal(prevented, 5);
});

test('an absent or disabled selection leaves one usable keyboard entry without selecting or saving', () => {
  const f = fixture();
  for (const selectedKey of ['missing', 'disabled']) {
    const tree = f.render({selectedKey});
    assert.deepEqual(nodes(tree).filter(item => item.props.role === 'tab' && item.props.tabIndex === 0).map(item => item.props['data-testid']), ['settings-services-item-general']);
  }
  assert.deepEqual(f.selected, []); assert.deepEqual(f.actions, []);
  assert.deepEqual(f.panelVisibility(), {selected: false, pageVisible: false, active: false});
});
