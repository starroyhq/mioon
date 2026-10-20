import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { LANGUAGE_LABELS, LOCALES, isLanguagePreference } from '../packages/i18n/src/index.ts';
import { createI18nTestContext } from './helpers/i18n.ts';

const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
function harness() {
  const changes = [], snapshot = { ...createI18nTestContext('zh-Hans'), preference: 'zh-Hans', persistence: 'saved', saving: false, setPreference: async value => changes.push(value) };
  const hooks = [], effects = []; let cursor = 0;
  const react = { createElement: (type, props, ...children) => ({type, props: {...props, children}}), useId: () => 'language-test',
    useRef(value) { const index = cursor++; return hooks[index] ??= {current:value}; },
    useMemo(factory, deps) { const index = cursor++, old = hooks[index]; if (!old || deps.some((value, offset) => !Object.is(value, old.deps[offset]))) hooks[index] = {deps, value:factory()}; return hooks[index].value; },
    useLayoutEffect(run, deps) { const index = cursor++, old = hooks[index]; if (!old || deps.some((value, offset) => !Object.is(value, old.deps[offset]))) { hooks[index] = {deps, cleanup:old?.cleanup}; effects.push(() => { hooks[index].cleanup?.(); hooks[index].cleanup = run(); }); } },
  };
  react.default = react;
  const source = readFileSync(new URL('../apps/web/src/LanguageControl.tsx', import.meta.url), 'utf8');
  const module = {exports: {}};
  Function('module', 'exports', 'require', transformSync(source, {loader:'tsx', format:'cjs', jsx:'transform'}).code)(module, module.exports, name => {
    if (name === 'react') return react;
    if (name === '@mioon/ui/components/workbench-select') return {WorkbenchSelect:'WorkbenchSelect'};
    if (name === '../../../packages/i18n/src/index.ts') return {LANGUAGE_LABELS, LOCALES, isLanguagePreference};
    if (name === './i18n/I18nProvider.tsx') return {useI18n: () => snapshot};
    assert.fail(`Unexpected language control dependency: ${name}`);
  });
  return {changes, snapshot, render: (props = {}) => { cursor = 0; const tree = module.exports.default(props); for (const run of effects.splice(0)) run(); return tree; }, unmount: () => { for (const hook of hooks) hook?.cleanup?.(); }};
}

test('application language selector keeps every supported preference and delegates persistence to its owner', () => {
  const h = harness(), tree = h.render(), control = nodes(tree).find(node => node.type === 'WorkbenchSelect');
  assert.equal(control.props['data-testid'], 'language-select');
  assert.equal(control.props.value, 'zh-Hans');
  assert.equal(control.props['aria-label'], '界面语言');
  const options = nodes(control).filter(node => node.type === 'option');
  assert.deepEqual(options.map(node => node.props.value), ['system', ...LOCALES]);
  for (const value of ['system', ...LOCALES]) control.props.onChange({target:{value}});
  control.props.onChange({target:{value:'not-a-language'}});
  assert.deepEqual(h.changes, ['system', ...LOCALES]);
  assert.equal(h.snapshot.preference, 'zh-Hans', 'Only the preference store accepts the selected language');
});

test('language persistence notices and saving remain available to assistive technology', () => {
  const h = harness();
  h.snapshot.persistence = 'session'; h.snapshot.saving = true;
  const tree = h.render(), control = nodes(tree).find(node => node.type === 'WorkbenchSelect');
  assert.equal(control.props['aria-busy'], true);
  assert.equal(control.props['aria-describedby'], 'language-test-notice');
  assert.ok(nodes(tree).some(node => node.props?.id === 'language-test-notice' && node.props.role === 'status'));
  assert.ok(nodes(tree).some(node => node.props?.className === 'sr-only' && node.props.role === 'status'));
});

test('hidden or unmounted language owners revoke retained callbacks and reopen with a new visible scope', () => {
  const h = harness(), first = nodes(h.render()).find(node => node.type === 'WorkbenchSelect');
  assert.equal(first.props.visible, true);
  const hidden = nodes(h.render({visible:false})).find(node => node.type === 'WorkbenchSelect');
  assert.equal(hidden.props.visible, false);
  first.props.onChange({target:{value:'en'}}); hidden.props.onChange({target:{value:'ja'}});
  assert.deepEqual(h.changes, []);
  const reopened = nodes(h.render({visible:true})).find(node => node.type === 'WorkbenchSelect');
  first.props.onChange({target:{value:'en'}});
  assert.deepEqual(h.changes, [], 'Reopening does not revive the old visible callback');
  reopened.props.onChange({target:{value:'zh-Hant'}});
  assert.deepEqual(h.changes, ['zh-Hant']);
  assert.equal(reopened.props.id, first.props.id);
  assert.equal(reopened.props['data-testid'], 'language-select');
  h.unmount(); reopened.props.onChange({target:{value:'ja'}});
  assert.deepEqual(h.changes, ['zh-Hant']);
});
