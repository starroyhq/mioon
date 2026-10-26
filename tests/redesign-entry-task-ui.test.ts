import type {RootHook} from './helpers/strict-root-ui-types.ts';
interface HookMemo {deps:readonly unknown[];value:unknown;run?:()=>void|(()=>void);cleanup?:void|(()=>void)}
interface LoginResponse {status:number;json():Promise<unknown>}
import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {i18nTestModule} from './helpers/i18n.ts';
import * as presentation from '../apps/web/src/creation-i18n.ts';
const nodes=(value: RootTree): RootNode[] =>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const find=(tree: string|number|boolean|RootNode|RootTree[]|null|undefined,id: unknown)=>nodes(tree).find(node=>node.props?.['data-testid']===id);
const text=(value: RootTree): string =>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):value==null||typeof value==='boolean'?'':String(value);
const tick=()=>new Promise(setImmediate);
const defer=()=>{let resolve!:(value:LoginResponse)=>void;const promise=new Promise<LoginResponse>(done=>{resolve=done;});return{promise,resolve};};
function harness(file: string,initial: { scope?: string; visible?: boolean; count?: number; uncertain?: boolean; items?: never[]|{ id: string; label: string; status: string; tone: string; }[]|({ id: string; label: string; status: string; phase: string; progress: number; tone: string; }|{ id: string; label: string; status: string; phase: string; tone: string; }|{ id: string; label: string; status: string; tone: string; phase?: undefined; })[]|{ id: string; projectId: string; mode: string; purpose: string; status: string; progress: number; snapshot: { deliveryName: string; }; }[]|{ id: string; label: string; status: string; tone: string; }[]; onOpenTasks?: ((id: unknown) => number)|(() => number)|(() => never)|(() => void); projectId?: string; onLogin?: (() => Promise<number>)|(() => Promise<never>)|(() => Promise<number>); }={},fetcher:(url:unknown,options:RequestInit)=>Promise<LoginResponse>=()=>assert.fail('Passive UI must not request data')) {
 const slots:unknown[]=[],effects: number[]=[];let cursor=0,props=initial;
 const equal=(a:readonly unknown[]|undefined,b:readonly unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(a[index],value));
 const react={createElement:(type:string,values:RootNode['props'],...children:RootTree[])=>({type,props:{...values,children:children.length===1?children[0]:children}}),
  useRef<T>(value:T){const index=cursor++;return (slots[index]??={current:value}) as {current:T};},
  useState<T>(value:T|(()=>T)):[T,(next:T|((value:T)=>T))=>void]{const index=cursor++;if(!(index in slots))slots[index]=typeof value==='function'?(value as ()=>T)():value;return[slots[index] as T,next=>{slots[index]=typeof next==='function'?(next as (value:T)=>T)(slots[index] as T):next;}];},
  useMemo<T>(factory:()=>T,deps:readonly unknown[]){const index=cursor++;if(!slots[index]||!equal((slots[index] as HookMemo).deps,deps))slots[index]={deps,value:factory()};return (slots[index] as HookMemo).value as T;},
  useEffect(run:()=>void|(()=>void),deps:readonly unknown[]){const index=cursor++;if(slots[index]&&equal((slots[index] as HookMemo).deps,deps))return;const old=slots[index] as HookMemo|undefined;slots[index]={deps,run,cleanup:old?.cleanup};effects.push(index);},
 } as {createElement(type:string,values:RootNode['props'],...children:RootTree[]):RootNode;useRef<T>(value:T):{current:T};useState<T>(value:T|(()=>T)):[T,(next:T|((value:T)=>T))=>void];useMemo<T>(factory:()=>T,deps:readonly unknown[]):T;useEffect(run:()=>void|(()=>void),deps:readonly unknown[]):void;useLayoutEffect?: (run:()=>void|(()=>void),deps:readonly unknown[])=>void};react.useLayoutEffect=react.useEffect;
 const source=readFileSync(new URL(`../apps/web/src/${file}`,import.meta.url),'utf8'),module={exports:{} as {default(props:unknown):RootNode}};
 const primitives={WorkbenchPopover:'Popover',WorkbenchPopoverContent:'Popup',WorkbenchPopoverTitle:'Title',WorkbenchPopoverTrigger:'Trigger',WorkbenchBadge:'Badge',WorkbenchButton:'Button',WorkbenchProgress:'Progress',WorkbenchAlert:'Alert',Clock:'Clock',Eye:'Eye',EyeOff:'EyeOff',Input:'Input',Label:'Label'};
 const require=(name: string)=>name==='react'?react:name.endsWith('I18nProvider.tsx')?i18nTestModule():name.endsWith('creation-i18n.ts')?presentation:name.endsWith('LanguageControl.tsx')?{__esModule:true,default:'LanguageControl'}:name.endsWith('.css')?{}:name.startsWith('@mioon/ui/components/')?primitives:assert.fail(`Unexpected entry/task dependency ${name}`);
 Function('module','exports','require','fetch',transformSync(source,{loader:'tsx',format:'cjs',jsx:'transform'}).code)(module,module.exports,require,fetcher);
 return{render(patch: { scope?: string; visible?: boolean; heldIds?: string[]|never[]; restored?: boolean; items?: { tone: string; id: string; label: string; status: string; }[]; }|undefined={}){props={...props,...patch};cursor=0;let tree=module.exports.default(props);for(const index of effects.splice(0)){(slots[index] as HookMemo).cleanup?.();(slots[index] as HookMemo).cleanup=(slots[index] as HookMemo).run!();}cursor=0;tree=module.exports.default(props);return tree;},unmount(){for(const slot of slots)(slot as HookMemo|undefined)?.cleanup?.();}};
}
test('task popover is passive and retained commands lose authority on scope or visibility change',()=>{
 const calls: unknown[]=[],h=harness('TaskPopover.tsx',{scope:'project-a:1',visible:true,count:2,uncertain:true,items:[],onOpenTasks:()=>calls.push('all')});let tree=h.render();assert.equal(tree.props.open,false);assert.deepEqual((calls as unknown),[]);
 tree.props.onOpenChange(true);tree=h.render();assert.equal(tree.props.open,true);const retained=find(tree,'task-overview-all');
 h.render({scope:'project-b:2'});(retained)!.props.onClick();assert.deepEqual((calls as unknown),[]);
 tree=h.render({visible:false});assert.equal(tree.props.open,false);assert.equal((nodes(tree).find((node: RootNode)=>node.type==='Popup'))!.props.inert,true);
 (retained)!.props.onClick();assert.deepEqual((calls as unknown),[]);(find(h.render({visible:true}),'task-overview-all'))!.props.onClick();assert.deepEqual(calls,['all']);
});
test('render tasks show only current-project timeline records and held results never claim live progress',()=>{
 const item={id:'export-a',projectId:'project-a',mode:'timeline',purpose:'export',status:'running',progress:NaN,snapshot:{deliveryName:'My delivery'}};
 const h=harness('TaskRenderList.tsx',{items:[item,{...item,id:'other',projectId:'project-b'},{...item,id:'story',mode:'storyboard'}],projectId:'project-a'});let tree=h.render();assert.match(text(tree),/My delivery/);assert.equal(nodes(tree).filter((node: RootNode)=>node.type==='article').length,1);assert.equal((nodes(tree).find((node: RootNode)=>node.type==='Progress'))!.props.value,0);
 assert.equal(nodes(h.render({heldIds:['export-a']})).some((node: RootNode)=>node.type==='Progress'),false);assert.equal(nodes(h.render({heldIds:[],restored:true})).some((node: RootNode)=>node.type==='Progress'),false);
});
test('task popover preserves warning tone for an unconfirmed result without dispatching actions',()=>{
 const h=harness('TaskPopover.tsx',{scope:'project-a:1',visible:true,count:1,uncertain:false,items:[{id:'unknown-a',label:'Unconfirmed generation',status:'提交状态待确认',tone:'warning'}],onOpenTasks:()=>assert.fail('Rendering must not dispatch')});
 const tree=h.render(),row=nodes(tree).find((node: RootNode)=>node.type==='article');assert.equal((row)!.props['data-tone'],'warning');
 assert.equal((nodes(row).find((node: RootNode)=>node.type==='Badge'))!.props.tone,'warning');assert.match(text(row),/提交状态待确认/);
});
test('unknown task detail link opens its exact original job and stale scopes cannot navigate',()=>{
 const calls: unknown[]=[],props={scope:'project-a:1',visible:true,count:1,uncertain:false,items:[{id:'unknown-a',label:'Original job',status:'待确认',tone:'warning'}],onOpenTasks:(id: unknown)=>calls.push(id)},h=harness('TaskPopover.tsx',props);
 let tree=h.render();const stale=find(tree,'task-overview-inspect-unknown-a');h.render({scope:'project-b:2'});(stale)!.props.onClick();assert.deepEqual((calls as unknown),[]);
 tree=h.render();(find(tree,'task-overview-inspect-unknown-a'))!.props.onClick();assert.deepEqual(calls,['unknown-a']);
 assert.equal(nodes(h.render({items:[{...props.items[0],tone:'neutral'}]})).some((node: RootNode)=>node.props?.['data-testid']==='task-overview-inspect-unknown-a'),false);
});
test('login preserves one in-flight token request and accepts only the exact successful envelope',async()=>{
 const held=defer(),calls:[unknown,RequestInit][]=[],logins: unknown[]=[],h=harness('LoginScreen.tsx',{onLogin:async()=>logins.push('login')},(url,options)=>{calls.push([url,options]);return held.promise;});let tree=h.render();(find(tree,'access-token'))!.props.onChange({target:{value:'synthetic-test-access'}});tree=h.render();const form=nodes(tree).find((node: RootNode)=>node.type==='form');(form)!.props.onSubmit({preventDefault(){}});(form)!.props.onSubmit({preventDefault(){}});assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0][1].body as string),{token:'synthetic-test-access'});assert.equal(calls[0][1].credentials,'same-origin');assert.equal((find(h.render(),'access-token'))!.props.disabled,true);
 (held.resolve)!({status:200,json:async()=>({ok:true})});await tick();assert.deepEqual(logins,['login']);assert.equal((find(h.render(),'access-token'))!.props.value,'');
 const rejected=harness('LoginScreen.tsx',{onLogin:async()=>assert.fail('Malformed login must not grant entry')},async()=>({status:200,json:async()=>({ok:true,unexpected:true})}));tree=rejected.render();(find(tree,'access-token'))!.props.onChange({target:{value:'synthetic'}});(nodes(rejected.render()).find((node: RootNode)=>node.type==='form'))!.props.onSubmit({preventDefault(){}});await tick();assert.ok(nodes(rejected.render()).some((node: RootNode)=>node.type==='Alert'));
});
test('late login success after unmount cannot grant entry',async()=>{
 const held=defer(),calls: unknown[]=[],h=harness('LoginScreen.tsx',{onLogin:async()=>calls.push('login')},()=>held.promise);let tree=h.render();(find(tree,'access-token'))!.props.onChange({target:{value:'synthetic'}});(nodes(h.render()).find((node: RootNode)=>node.type==='form'))!.props.onSubmit({preventDefault(){}});h.unmount();(held.resolve)!({status:200,json:async()=>({ok:true})});await tick();assert.deepEqual((calls as unknown),[]);
});


test('task overview counts exactly the shown loaded records and groups all actionable entries without truncation',()=>{
 const items=[...Array.from({length:6},(_,i)=>({id:`running-${i}`,label:`Running ${i}`,status:'处理中',phase:'active',progress:i===0?0:25,tone:'neutral'})),{id:'unknown',label:'Unknown request',status:'待确认',phase:'attention',tone:'warning'},{id:'done',label:'Old complete',status:'完成',tone:'success'}];
 const h=harness('TaskPopover.tsx',{scope:'project-a',visible:true,count:999,uncertain:false,items,onOpenTasks(){}}),tree=h.render();
 assert.equal(nodes(tree).filter((node: RootNode)=>node.type==='article').length,7);assert.equal(nodes(tree).filter((node: RootNode)=>node.type==='Badge'&&text(node)==='7').length,2);assert.equal((nodes(tree).find((node: RootNode)=>node.type==='Progress'))!.props.value,0);assert.match(text(tree),/进行中6/);assert.match(text(tree),/需处理1/);assert.doesNotMatch(text(tree),/Old complete|999/);assert.ok(find(tree,'task-overview-inspect-running-5'));
});
