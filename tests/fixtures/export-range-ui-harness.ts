import * as i18n from '../helpers/i18n.ts';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as rangeContract from '@mioon/contracts/timeline-export-range';
import * as floatContract from '@mioon/contracts/timeline-export-float';
import * as deliveryContract from '@mioon/contracts/timeline-delivery';
import * as samplePeakContract from '@mioon/contracts/export-sample-peak';
import * as loudnessContract from '@mioon/contracts/export-loudness';
import * as contracts from '@mioon/contracts';
import {DEFAULT_UI_PREFERENCES} from '../../packages/contracts/src/ui-preferences.ts';
import * as candidatePresentation from '../../apps/web/src/opacity-candidate-render-presentation.ts';
export interface UiNode {readonly type: unknown; readonly props: Record<string, unknown> & {children?: unknown}}
export type UiComponent = (props: Record<string, unknown>) => unknown;
const element = (type: unknown, props: Record<string, unknown>|null|undefined, ...children: unknown[]): unknown => typeof type === 'function' ? (type as (value: Record<string, unknown>)=>unknown)({ ...props, children }) : ({ type, props: { ...props, children } });
export const nodes = (tree: unknown): UiNode[] => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree as UiNode, ...nodes((tree as UiNode).props?.children)];
export const textOf = (tree: unknown): string => Array.isArray(tree) ? tree.map(textOf).join('') : tree && typeof tree === 'object' ? textOf((tree as UiNode).props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
export function component(file: string): {default: UiComponent; [key: string]: unknown} {
  // Render-phase context only: presentation sections retain their actual
  // hidden/inert props; no provider persistence or passive work runs here.
  const cache = new Map<string, Record<string, unknown>>(), react: Record<string, unknown> = { createElement: element, createContext:(value: unknown) => ({value, Provider:'ContextProvider'}), useContext:(context: {value?: unknown}) => context.value, useId: () => 'range-id', useRef:(value: unknown) => ({ current: value }), useState:(value: unknown) => [typeof value === 'function' ? (value as ()=>unknown)() : value, () => {}], useEffect() {}, useLayoutEffect() {} }; react.default = react;
  function load(name: string): unknown {
    if (cache.has(name)) return cache.get(name);
    const module: {exports: Record<string, unknown>} = { exports: {} }; cache.set(name, module.exports);
    const source = readFileSync(new URL(`../../apps/web/src/${name}`, import.meta.url), 'utf8');
    Function('module', 'exports', 'require', transformSync(source, { loader: name.endsWith('.tsx') ? 'tsx' : name.endsWith('.ts') ? 'ts' : 'jsx', format: 'cjs' }).code)(module, module.exports, (key: string) => {
      if (key === './i18n/I18nProvider.tsx') return i18n.i18nTestModule();
      if (key.endsWith('/packages/i18n/src/index.ts')) return i18n;
      if (key === 'react') return react;
      if (key === './UiPreferencesProvider.tsx') return {useUiPreferences:() => ({preferences:DEFAULT_UI_PREFERENCES})};
      if (key === './opacity-candidate-render-presentation.ts') return candidatePresentation;
      // Keep the exact composition props without pretending an asynchronous
      // file inspection has completed. Its real lifecycle has a separate suite.
      if (key === './ExportFileActions.tsx') return {__esModule:true, default:(props: Record<string, unknown>) => ({type:'ExportFileActions', props})};
      if (key === '@mioon/contracts/timeline-export-range') return rangeContract;
      if (key === '@mioon/contracts/timeline-export-float') return floatContract;
      if (key === '@mioon/contracts/timeline-delivery') return deliveryContract;
      if (key === '@mioon/contracts/export-sample-peak') return samplePeakContract;
      if (key === '@mioon/contracts/export-loudness') return loudnessContract;
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
  return load(file) as {default: UiComponent; [key: string]: unknown};
}
