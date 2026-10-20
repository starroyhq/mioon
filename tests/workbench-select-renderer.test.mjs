import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';

const source = readFileSync(new URL('../apps/web/src/WorkspaceControls.tsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
const element = (type, props = {}, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const react = {
  createElement: element,
  Children: { toArray: children => children == null ? [] : (Array.isArray(children) ? children.flat(Infinity) : [children]) },
  isValidElement: child => Boolean(child && typeof child === 'object' && child.props),
  useState: initial => [initial, () => {}],
  useRef: current => ({ current }),
  useMemo: factory => factory(),
  useLayoutEffect: () => {},
};
react.default = react;
const module = { exports: {} };
Function('module', 'exports', 'require', code)(module, module.exports, id => {
  if (id === 'react') return react;
  if (id === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => true };
  if (id.startsWith('@mioon/ui/components/')) return new Proxy({}, { get: (_, key) => String(key) });
  throw Error(`Unexpected adapter dependency ${id}`);
});
const children = [element('option', { value: 'runway' }, 'Runway'), element('option', { value: 'wan', disabled: true }, '通义', '万相')];

test('custom option rendering decorates the selected value and menu while preserving plain labels and values', () => {
  const renderOption = option => element('span', {}, element('svg', { 'aria-hidden': true, 'data-provider': option.value }), option.label);
  const tree = module.exports.WorkbenchSelect({ value: 'wan', children, renderOption });
  assert.deepEqual(tree.props.items, [{ value: 'runway', label: 'Runway', disabled: false }, { value: 'wan', label: '通义万相', disabled: true }]);
  const find = type => nodes(tree).find(node => node.type === type);
  assert.deepEqual(find('SelectValue').props.children, renderOption(tree.props.items[1]));
  const items = nodes(tree).filter(node => node.type === 'SelectItem');
  assert.deepEqual(items.map(item => ({ value: item.props.value, label: item.props.label, disabled: item.props.disabled })), tree.props.items);
  assert.deepEqual(items.map(item => item.props.children), tree.props.items.map(renderOption));
  assert.equal(find('SelectTrigger').props.renderOption, undefined, 'The renderer must not leak to the underlying button');
});

test('plain rendering and stale selections retain Base UI value fallback', () => {
  const plain = module.exports.WorkbenchSelect({ value: 'runway', children });
  assert.equal(nodes(plain).find(node => node.type === 'SelectValue').props.children, undefined);
  assert.deepEqual(nodes(plain).filter(node => node.type === 'SelectItem').map(node => node.props.children), ['Runway', '通义万相']);
  const stale = module.exports.WorkbenchSelect({ value: 'archived', children, renderOption: option => option.label });
  assert.equal(nodes(stale).find(node => node.type === 'SelectValue').props.children, undefined);
  assert.equal(stale.props.value, 'archived', 'An invalid selection must never switch to another connection');
});

test('brand markup appears in the trigger with the real React and Base UI components', () => {
  const root = fileURLToPath(new URL('../apps/web/', import.meta.url));
  const fixture = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import assert from 'node:assert/strict';
    import { WorkbenchSelect } from './src/WorkspaceControls.tsx';
    const html = renderToStaticMarkup(<WorkbenchSelect value="runway" aria-label="视频供应商" renderOption={option => <><svg aria-hidden="true" data-provider={option.value} /><span>{option.label}</span></>}><option value="runway">Runway</option></WorkbenchSelect>);
    assert.match(html, /data-provider="runway"/);
    assert.match(html, /aria-hidden="true"/);
    assert.ok(html.includes('<span>Runway</span>'));
    assert.match(html, /aria-label="视频供应商"/);
    console.log('Select renderer verified');
    process.exit(0);
  `;
  const bundle = buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', jsx: 'transform', write: false, logLevel: 'silent' }).outputFiles[0].text;
  const output = execFileSync(process.execPath, ['--input-type=commonjs', '-'], { input: bundle, encoding: 'utf8', timeout: 30_000 });
  assert.match(output, /Select renderer verified/);
});
