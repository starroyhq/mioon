import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as rangeContract from '@mioon/contracts/timeline-export-range';
import * as deliveryContract from '@mioon/contracts/timeline-delivery';
import * as samplePeakContract from '@mioon/contracts/export-sample-peak';
import * as contracts from '@mioon/contracts';
const element = (type, props, ...children) => typeof type === 'function' ? type({ ...props, children }) : ({ type, props: { ...props, children } });
export const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props?.children)];
export const textOf = tree => Array.isArray(tree) ? tree.map(textOf).join('') : tree && typeof tree === 'object' ? textOf(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
export function component(file) {
  const cache = new Map(), react = { createElement: element, useId: () => 'range-id', useRef: value => ({ current: value }), useState: value => [value, () => {}], useLayoutEffect() {} }; react.default = react;
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const module = { exports: {} }; cache.set(name, module.exports);
    const source = readFileSync(new URL(`../../apps/web/src/${name}`, import.meta.url), 'utf8');
    Function('module', 'exports', 'require', transformSync(source, { loader: name.endsWith('.tsx') ? 'tsx' : name.endsWith('.ts') ? 'ts' : 'jsx', format: 'cjs' }).code)(module, module.exports, key => {
      if (key === 'react') return react;
      if (key === '@mioon/contracts/timeline-export-range') return rangeContract;
      if (key === '@mioon/contracts/timeline-delivery') return deliveryContract;
      if (key === '@mioon/contracts/export-sample-peak') return samplePeakContract;
      if (key === '@mioon/contracts') return contracts;
      if (key === './api.js') return { statusText: String };
      if (key === './icons.jsx') return { __esModule: true, default: 'Icon' };
      if (key.endsWith('.css')) return {};
      if (key.startsWith('@mioon/ui/')) return { Button: 'Button', Input: 'Input', Label: 'Label', Badge: 'Badge' };
      if (key === './WorkspaceControls.jsx') return { WorkbenchSelect: 'Select' };
      if (key.startsWith('./')) return load(key.slice(2));
      throw Error(`Unexpected range UI import: ${key}`);
    });
    cache.set(name, module.exports); return module.exports;
  }
  return load(file);
}
