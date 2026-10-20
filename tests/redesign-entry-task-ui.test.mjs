import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {i18nTestModule} from './helpers/i18n.ts';
import * as presentation from '../apps/web/src/creation-i18n.ts';
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const find=(tree,id)=>nodes(tree).find(node=>node.props?.['data-testid']===id);
const text=value=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):value==null||typeof value==='boolean'?'':String(value);
const tick=()=>new Promise(setImmediate);
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
function harness(file,initial={},fetcher=()=>assert.fail('Passive UI must not request data')) {
 const slots=[],effects=[];let cursor=0,props=initial;
 const equal=(a,b)=>a?.length===b.length&&b.every((value,index)=>Object.is(a[index],value));
 const react={createElement:(type,values,...children)=>({type,props:{...values,children:children.length===1?children[0]:children}}),
  useRef(value){const index=cursor++;return slots[index]??={current:value};},
  useState(value){const index=cursor++;if(!(index in slots))slots[index]=typeof value==='function'?value():value;return[slots[index],next=>{slots[index]=typeof next==='function'?next(slots[index]):next;}];},
  useMemo(factory,deps){const index=cursor++;if(!slots[index]||!equal(slots[index].deps,deps))slots[index]={deps,value:factory()};return slots[index].value;},
  useEffect(run,deps){const index=cursor++;if(slots[index]&&equal(slots[index].deps,deps))return;const old=slots[index];slots[index]={deps,run,cleanup:old?.cleanup};effects.push(index);},
 };react.useLayoutEffect=react.useEffect;
 const source=readFileSync(new URL(`../apps/web/src/${file}`,import.meta.url),'utf8'),module={exports:{}};
 const primitives={WorkbenchPopover:'Popover',WorkbenchPopoverContent:'Popup',WorkbenchPopoverTitle:'Title',WorkbenchPopoverTrigger:'Trigger',WorkbenchBadge:'Badge',WorkbenchButton:'Button',WorkbenchProgress:'Progress',WorkbenchAlert:'Alert',Clock:'Clock',Eye:'Eye',EyeOff:'EyeOff',Input:'Input',Label:'Label'};
 const require=name=>name==='react'?react:name.endsWith('I18nProvider.tsx')?i18nTestModule():name.endsWith('creation-i18n.ts')?presentation:name.endsWith('LanguageControl.tsx')?{__esModule:true,default:'LanguageControl'}:name.endsWith('.css')?{}:name.startsWith('@mioon/ui/components/')?primitives:assert.fail(`Unexpected entry/task dependency ${name}`);
 Function('module','exports','require','fetch',transformSync(source,{loader:'tsx',format:'cjs',jsx:'transform'}).code)(module,module.exports,require,fetcher);
 return{render(patch={}){props={...props,...patch};cursor=0;let tree=module.exports.default(props);for(const index of effects.splice(0)){slots[index].cleanup?.();slots[index].cleanup=slots[index].run();}cursor=0;tree=module.exports.default(props);return tree;},unmount(){for(const slot of slots)slot?.cleanup?.();}};
}
test('task popover is passive and retained commands lose authority on scope or visibility change',()=>{
 const calls=[],h=harness('TaskPopover.tsx',{scope:'project-a:1',visible:true,count:2,uncertain:true,items:[],onOpenTasks:()=>calls.push('all')});let tree=h.render();assert.equal(tree.props.open,false);assert.deepEqual(calls,[]);
 tree.props.onOpenChange(true);tree=h.render();assert.equal(tree.props.open,true);const retained=find(tree,'task-overview-all');
 h.render({scope:'project-b:2'});retained.props.onClick();assert.deepEqual(calls,[]);
 tree=h.render({visible:false});assert.equal(tree.props.open,false);assert.equal(nodes(tree).find(node=>node.type==='Popup').props.inert,true);
 retained.props.onClick();assert.deepEqual(calls,[]);find(h.render({visible:true}),'task-overview-all').props.onClick();assert.deepEqual(calls,['all']);
});
test('render tasks show only current-project timeline records and held results never claim live progress',()=>{
 const item={id:'export-a',projectId:'project-a',mode:'timeline',purpose:'export',status:'running',progress:NaN,snapshot:{deliveryName:'My delivery'}};
 const h=harness('TaskRenderList.tsx',{items:[item,{...item,id:'other',projectId:'project-b'},{...item,id:'story',mode:'storyboard'}],projectId:'project-a'});let tree=h.render();assert.match(text(tree),/My delivery/);assert.equal(nodes(tree).filter(node=>node.type==='article').length,1);assert.equal(nodes(tree).find(node=>node.type==='Progress').props.value,0);
 assert.equal(nodes(h.render({heldIds:['export-a']})).some(node=>node.type==='Progress'),false);assert.equal(nodes(h.render({heldIds:[],restored:true})).some(node=>node.type==='Progress'),false);
});
test('task popover preserves warning tone for an unconfirmed result without dispatching actions',()=>{
 const h=harness('TaskPopover.tsx',{scope:'project-a:1',visible:true,count:1,uncertain:false,items:[{id:'unknown-a',label:'Unconfirmed generation',status:'提交状态待确认',tone:'warning'}],onOpenTasks:()=>assert.fail('Rendering must not dispatch')});
 const tree=h.render(),row=nodes(tree).find(node=>node.type==='article');assert.equal(row.props['data-tone'],'warning');
 assert.equal(nodes(row).find(node=>node.type==='Badge').props.tone,'warning');assert.match(text(row),/提交状态待确认/);
});
test('unknown task detail link opens its exact original job and stale scopes cannot navigate',()=>{
 const calls=[],props={scope:'project-a:1',visible:true,count:1,uncertain:false,items:[{id:'unknown-a',label:'Original job',status:'待确认',tone:'warning'}],onOpenTasks:id=>calls.push(id)},h=harness('TaskPopover.tsx',props);
 let tree=h.render();const stale=find(tree,'task-overview-inspect-unknown-a');h.render({scope:'project-b:2'});stale.props.onClick();assert.deepEqual(calls,[]);
 tree=h.render();find(tree,'task-overview-inspect-unknown-a').props.onClick();assert.deepEqual(calls,['unknown-a']);
 assert.equal(nodes(h.render({items:[{...props.items[0],tone:'neutral'}]})).some(node=>node.props?.['data-testid']==='task-overview-inspect-unknown-a'),false);
});
test('login preserves one in-flight token request and accepts only the exact successful envelope',async()=>{
 const held=defer(),calls=[],logins=[],h=harness('LoginScreen.tsx',{onLogin:async()=>logins.push('login')},(url,options)=>{calls.push([url,options]);return held.promise;});let tree=h.render();find(tree,'access-token').props.onChange({target:{value:'synthetic-test-access'}});tree=h.render();const form=nodes(tree).find(node=>node.type==='form');form.props.onSubmit({preventDefault(){}});form.props.onSubmit({preventDefault(){}});assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0][1].body),{token:'synthetic-test-access'});assert.equal(calls[0][1].credentials,'same-origin');assert.equal(find(h.render(),'access-token').props.disabled,true);
 held.resolve({status:200,json:async()=>({ok:true})});await tick();assert.deepEqual(logins,['login']);assert.equal(find(h.render(),'access-token').props.value,'');
 const rejected=harness('LoginScreen.tsx',{onLogin:async()=>assert.fail('Malformed login must not grant entry')},async()=>({status:200,json:async()=>({ok:true,unexpected:true})}));tree=rejected.render();find(tree,'access-token').props.onChange({target:{value:'synthetic'}});nodes(rejected.render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();assert.ok(nodes(rejected.render()).some(node=>node.type==='Alert'));
});
test('late login success after unmount cannot grant entry',async()=>{
 const held=defer(),calls=[],h=harness('LoginScreen.tsx',{onLogin:async()=>calls.push('login')},()=>held.promise);let tree=h.render();find(tree,'access-token').props.onChange({target:{value:'synthetic'}});nodes(h.render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});h.unmount();held.resolve({status:200,json:async()=>({ok:true})});await tick();assert.deepEqual(calls,[]);
});


test('task overview counts exactly the shown loaded records and groups all actionable entries without truncation',()=>{
 const items=[...Array.from({length:6},(_,i)=>({id:`running-${i}`,label:`Running ${i}`,status:'处理中',phase:'active',progress:i===0?0:25,tone:'neutral'})),{id:'unknown',label:'Unknown request',status:'待确认',phase:'attention',tone:'warning'},{id:'done',label:'Old complete',status:'完成',tone:'success'}];
 const h=harness('TaskPopover.tsx',{scope:'project-a',visible:true,count:999,uncertain:false,items,onOpenTasks(){}}),tree=h.render();
 assert.equal(nodes(tree).filter(node=>node.type==='article').length,7);assert.equal(nodes(tree).filter(node=>node.type==='Badge'&&text(node)==='7').length,2);assert.equal(nodes(tree).find(node=>node.type==='Progress').props.value,0);assert.match(text(tree),/进行中6/);assert.match(text(tree),/需处理1/);assert.doesNotMatch(text(tree),/Old complete|999/);assert.ok(find(tree,'task-overview-inspect-running-5'));
});
