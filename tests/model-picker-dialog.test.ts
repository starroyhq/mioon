import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {transformSync} from 'esbuild';
import {translate} from '../packages/i18n/src/index.ts';
import type {RootNode, RootTree} from './helpers/strict-root-ui-types.ts';
import type ModelPickerDialog from '../apps/web/src/ModelPickerDialog.tsx';

type Picker = Parameters<typeof ModelPickerDialog>[0];
const code = transformSync(readFileSync(new URL('../apps/web/src/ModelPickerDialog.tsx', import.meta.url), 'utf8'),
  {loader: 'tsx', format: 'cjs'}).code;
const nodes = (value: RootTree): RootNode[] => Array.isArray(value) ? value.flatMap(nodes)
  : value && typeof value === 'object' ? [value, ...nodes(value.props.children), ...nodes(value.props.footer as RootTree)] : [];
const text = (value: RootTree): string => Array.isArray(value) ? value.map(text).join('')
  : value && typeof value === 'object' ? text(value.props.children) : typeof value === 'string' ? value : '';

function mount(overrides: Partial<Picker> = {}) {
  const calls: Array<readonly string[]> = [];
  const props: Picker = {
    serviceName: 'Synthetic', status: 'ready',
    items: [{id: 'used', active: true}, {id: 'added', added: true}, {id: 'alpha'},
      {id: 'model-b', label: 'Beta'}, {id: 'namespace/model', unavailable: true}],
    onAdd: ids => calls.push(ids), onClose: () => calls.push(['closed']), ...overrides,
  };
  const hooks: unknown[] = [];
  let cursor = 0;
  const react = {
    Fragment: 'fragment',
    createElement: (type: string, props: RootNode['props'], ...children: RootTree[]) => ({type, props: {...props, children}}),
    useRef: (value: unknown) => hooks[cursor++] ??= {current: value},
    useState(value: unknown) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof value === 'function' ? value() : value;
      return [hooks[index], (next: unknown) => {hooks[index] = typeof next === 'function' ? next(hooks[index]) : next;}];
    },
  };
  const stubs: Record<string, unknown> = {
    react, '@mioon/ui/components/dialog': {Dialog: 'Dialog'}, '@mioon/ui/components/input': {Input: 'Input'},
    '@mioon/ui/components/workbench-controls': {WorkbenchBadge: 'Badge', WorkbenchButton: 'Button', WorkbenchDialogContent: 'DialogContent'},
    './i18n/I18nProvider.tsx': {useI18n: () => ({t: translate.bind(null, 'zh-Hans')})},
    './icons.tsx': {__esModule: true, default: 'Icon'}, './model-picker-dialog.css': {},
  };
  const module = {exports: {}} as {exports: {default: (value: Picker) => RootNode}};
  Function('module', 'exports', 'require', `const React=require('react');${code}`)(module, module.exports, (name: string) => {
    assert.ok(Object.hasOwn(stubs, name), name);
    return stubs[name];
  });
  const render = () => {cursor = 0; return nodes(module.exports.default(props));};
  const byId = (id: string) => render().find(node => node.props['data-testid'] === id)!;
  const label = (name: string) => render().find(node => node.props['aria-label'] === name);
  const click = (name: string) => render().find(node => node.type === 'Button' && text(node) === name)!.props.onClick();
  return {calls, props, render, byId, label, click};
}

test('picker holds new choices locally, counts hidden selections, and locks existing models', () => {
  const picker = mount();
  for (const id of ['used', 'added']) {
    const row = picker.label(id)!;
    assert.equal(row.props.checked, true);
    assert.equal(row.props.disabled, true);
    row.props.onChange({target: {checked: false}});
    assert.equal(picker.label(id)!.props.checked, true);
  }
  assert.equal(picker.label('alpha')!.props.checked, false);
  const unavailable = picker.label('namespace/model')!;
  assert.equal(unavailable.props.disabled, true);
  assert.equal(unavailable.props.checked, false);
  unavailable.props.onChange({target: {checked: true}});
  assert.equal(picker.label('namespace/model')!.props.checked, false);
  assert.equal(picker.byId('model-picker-add').props.disabled, true);
  picker.label('alpha')!.props.onChange({target: {checked: true}});
  picker.label('搜索模型')!.props.onChange({target: {value: ' BETA '}});
  assert.equal(picker.label('alpha'), undefined);
  assert.equal(picker.label('Beta')!.props.checked, false);
  assert.match(text(picker.byId('model-picker-count')), /1/);
  picker.click('全选新模型');
  assert.equal(picker.label('Beta')!.props.checked, true);
  assert.match(text(picker.byId('model-picker-count')), /2/);
  picker.click('清空');
  assert.equal(picker.label('Beta')!.props.checked, false);
  assert.equal(picker.calls.length, 0);
  picker.click('全选新模型');
  picker.byId('model-picker-add').props.onClick();
  assert.deepEqual(picker.calls, [['alpha', 'model-b']]);
});

test('cancel, capacity, and non-ready states cannot publish a model', () => {
  const picker = mount({maxAdditions: 1});
  picker.click('全选新模型');
  assert.equal(picker.byId('model-picker-add').props.disabled, true);
  picker.byId('model-picker-add').props.onClick();
  picker.click('取消');
  assert.deepEqual(picker.calls, [['closed']]);
  for (const status of ['loading', 'error', 'empty'] as const) {
    const pending = mount({status, statusMessage: 'Synthetic status'});
    assert.equal(pending.render().some(node => text(node) === 'Synthetic status'), true);
    pending.byId('model-picker-add').props.onClick();
    assert.equal(pending.calls.length, 0);
    assert.equal(pending.label('alpha'), undefined);
  }
});
