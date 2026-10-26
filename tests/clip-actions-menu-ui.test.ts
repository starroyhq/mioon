import type { TestNode, TestTree, TestElementProps, TestComponent, HookCell } from './helpers/strict-timeline-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {i18nTestModule} from './helpers/i18n.ts';
import * as removal from '../apps/web/src/timeline-removal.ts';
import {hasOpenWorkbenchModal} from '../apps/web/src/workbench-modal-state.ts';
const nodes = (value: TestTree): TestNode[] =>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
function view(locale: string,props: Record<string, unknown>){
 const react={createElement: (type: unknown, props: TestElementProps, ...children: TestTree[])=>({type,props:{...props,children}})};(react as typeof react & {default: unknown}).default=react;
 const module={exports:{} as {ClipActionsMenu: TestComponent}};
 Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/ClipRemovalControls.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)((name: string)=>{
  if(name==='react')return react;
  if(name.includes('I18nProvider'))return i18nTestModule(locale as Parameters<typeof i18nTestModule>[0]);
  if(name==='./timeline-removal.ts')return removal;
  if(name==='./workbench-modal-state.ts')return {hasOpenWorkbenchModal};
  if(name.startsWith('@mioon/ui/'))return new Proxy({}, {get:(_,key)=>key});
  assert.fail(name);
 },module,module.exports);
 return module.exports.ClipActionsMenu(props);
}
test('clip menu lists only wired operations, keeps removal last and preserves actual handlers in four languages',()=>{
 for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const){
  const calls: string[]=[];
  const callbacks=Object.fromEntries(['Split','ShowAsset','ReplaceSource','ReturnToSource','Preview','Remove','RippleRemove'].map(key=>[`on${key}`,()=>calls.push(key)]));
  const tree=view(locale,{disabled:false,...callbacks});
  const items=nodes(tree).filter(node=>node.type==='DropdownMenuItem');
  assert.deepEqual(items.map(node=>node.props['data-testid']),['clip-menu-split','clip-menu-show-asset','clip-menu-replace-source',undefined,undefined,'remove-clip','ripple-remove-clip']);
  assert.deepEqual(items.slice(-2).map(node=>node.props.variant),['destructive','destructive']);
  items.forEach(node=>node.props.onClick());
  assert.deepEqual(calls,['Split','ShowAsset','ReplaceSource','ReturnToSource','Preview','Remove','RippleRemove']);
  assert.equal(nodes(tree).filter(node=>node.type==='DropdownMenuSeparator').length,1);
 }
 const minimal=view('en',{disabled:false,onRemove(){}});
 assert.equal(nodes(minimal).filter(node=>node.type==='DropdownMenuItem').length,1);
 assert.equal(nodes(minimal).filter(node=>node.type==='DropdownMenuSeparator').length,0);
});
test('editing gates disable split, replacement and both removals while readonly source inspection remains available',()=>{
 const tree=view('en',{disabled:true,onSplit(){},onShowAsset(){},onReplaceSource(){},onPreview(){},onRemove(){},onRippleRemove(){}});
 const items=nodes(tree).filter(node=>node.type==='DropdownMenuItem');
 for(const id of ['clip-menu-split','clip-menu-replace-source','remove-clip','ripple-remove-clip'] as const)assert.equal(items.find(node=>node.props['data-testid']===id)!.props.disabled,true,id);
 assert.equal(items.find(node=>node.props['data-testid']==='clip-menu-show-asset')!.props.disabled,undefined);
 assert.equal(nodes(view('en',{disabled:false,splitDisabled:true,onSplit(){}})).find(node=>node.props['data-testid']==='clip-menu-split')!.props.disabled,true);
});
