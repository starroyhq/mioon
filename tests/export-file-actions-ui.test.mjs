import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {exportFileStatusSchema} from '../packages/contracts/src/export-file-recovery.ts';
import {i18nTestModule} from './helpers/i18n.ts';

const id = n => `76000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const initial = {projectId:id(1),exportId:id(2),downloadHref:'/media/original-immutable-file'};
const status = (props = initial, patch = {}) => ({projectId:props.projectId,exportId:props.exportId,assetId:id(3),status:'missing',sizeBytes:4,sha256:'a'.repeat(64),...patch});
const response = value => ({ok:true,json:async()=>({ok:true,data:value})});
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const tick = () => new Promise(setImmediate);
const element = (type, props, ...children) => ({type,props:{...props,children}});
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value==='object' ? [value,...nodes(value.props?.children)] : [];
function harness(patch = {}) {
  let props={...initial,...patch},visible=true,cursor=0,dirty=false,tree,mounted=true,inputElement=null,clicks=0;
  const hooks=[],layout=[],passive=[],calls=[],writes=[];
  const effect = queue => (run,deps) => {const index=cursor++,old=hooks[index];if(!old||deps.some((value,i)=>value!==old.deps?.[i])){const next={deps,run,cleanup:old?.cleanup};hooks[index]=next;queue.push(()=>{next.cleanup?.();next.cleanup=run();});}};
  const react={createElement:element,Fragment:'Fragment',useEffect:effect(passive),useLayoutEffect:effect(layout),
    useMemo(run,deps){const index=cursor++,old=hooks[index];if(!old||deps.some((value,i)=>value!==old.deps[i]))hooks[index]={deps,value:run()};return hooks[index].value;},
    useRef(value){const index=cursor++;return hooks[index]??={current:value};},
    useState(value){const index=cursor++;hooks[index]??={value};return[hooks[index].value,next=>{assert.equal(mounted,true,'Unmounted owners must not publish state');const value=typeof next==='function'?next(hooks[index].value):next;if(value!==hooks[index].value){hooks[index].value=value;dirty=true;writes.push(index);}}];}};
  const module={exports:{}};
  Function('require','module','exports','fetch',transformSync(readFileSync(new URL('../apps/web/src/ExportFileActions.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs',jsx:'transform'}).code)(name=>{
    if(name==='react')return react;
    if(name.endsWith('workspace-visibility.tsx'))return{useWorkspaceVisibility:()=>visible};
    if(name.endsWith('I18nProvider.tsx'))return i18nTestModule();
    if(name.endsWith('export-file-recovery.ts'))return{exportFileStatusSchema};
    if(name==='@mioon/ui/components/workbench-controls')return{WorkbenchButton:'Button',WorkbenchAlert:'Alert'};
    assert.fail(`Unexpected file action dependency ${name}`);
  },module,module.exports,(url,options={})=>{const waiting=deferred();calls.push({url,options,...waiting});return waiting.promise;});
  function render(patch={}) {
    props={...props,...patch};let commits=0;
    do {dirty=false;cursor=0;tree=module.exports.default(props);const input=nodes(tree).find(node=>node.type==='input');
      if(input){inputElement??={value:'',files:[],click(){clicks++;}};input.props.ref.current=inputElement;}else if(inputElement){for(const hook of hooks)if(hook?.current===inputElement)hook.current=null;inputElement=null;}
      while(layout.length)layout.shift()();while(passive.length)passive.shift()();assert.ok(++commits<12,'Effects must settle');
    }while(dirty);
    return tree;
  }
  const find = testId => nodes(tree).find(node=>node.props?.['data-testid']===testId);
  function choose(file={size:4}) {find('export-file-locate').props.onClick();const node=nodes(tree).find(node=>node.type==='input'),input=inputElement;input.files=[file];return{node,input,send:()=>node.props.onChange({currentTarget:input,target:input})};}
  return{render,find,calls,writes,props:()=>props,visible(next){visible=next;},nodes:()=>nodes(tree),input:()=>inputElement,clicks:()=>clicks,choose,
    async missing(){calls.at(-1).resolve(response(status(props)));await tick();render();},
    async settle(call,value){call.resolve(response(value));await tick();render();},
    unmount(){for(const hook of hooks)hook?.cleanup?.();mounted=false;}};
}

test('hidden and disabled histories issue no recovery GET and keep the frozen download URL',()=>{
  const hidden=harness();hidden.visible(false);hidden.render();assert.equal(hidden.calls.length,0);assert.equal(hidden.find('export-file-check').props.disabled,true);
  const disabled=harness({disabled:true});const button=disabled.render();assert.equal(disabled.calls.length,0);assert.equal(button.props.render.props.href,initial.downloadHref);assert.equal(button.props.render.props.download,true);
});

test('an old file-chooser change cannot dispatch after hide, reopen, or owner replacement',async()=>{
  for(const transition of ['hide','reopen','project','href','disabled']){
    const h=harness();h.render();await h.missing();const old=h.choose();assert.equal(h.clicks(),1);
    if(transition==='hide'||transition==='reopen'){h.visible(false);h.render();if(transition==='reopen'){h.visible(true);h.render();}}
    else if(transition==='project')h.render({projectId:id(9),exportId:id(10)});
    else if(transition==='href')h.render({downloadHref:'/media/different-frozen-file'});
    else h.render({disabled:true});
    old.send();await tick();h.render();assert.equal(h.calls.filter(call=>call.options.method==='POST').length,0,transition);
  }
});

test('a stale chooser cannot consume the new selection after the same history reopens',async()=>{
  const h=harness();h.render();await h.missing();const old=h.choose();h.visible(false);h.render();h.visible(true);h.render();await h.missing();const current=h.choose();
  old.send();assert.equal(h.calls.filter(call=>call.options.method==='POST').length,0);
  current.send();assert.equal(h.calls.filter(call=>call.options.method==='POST').length,1);
  const post=h.calls.at(-1);assert.equal(post.options.body,current.input.files[0]);assert.equal(post.options.signal,undefined,'Accepted restoration is not aborted by UI retirement');
  await h.settle(post,status(initial,{status:'present'}));assert.equal(h.nodes().find(node=>node.type==='Button'&&node.props.render)?.props.render.props.href,initial.downloadHref);
});

test('late GET results cannot publish after hidden ABA or same-URL download ownership changes',async()=>{
  const h=harness();h.render();const first=h.calls[0];h.visible(false);h.render();assert.equal(first.options.signal.aborted,true);
  h.visible(true);h.render();const second=h.calls.at(-1);await h.settle(first,status(initial,{status:'present'}));assert.ok(h.find('export-file-check'));assert.equal(h.nodes().some(node=>node.props?.render?.props?.href),false);
  h.render({downloadHref:'/media/new-owner'});const third=h.calls.at(-1);await h.settle(second,status(initial,{status:'present'}));assert.ok(h.find('export-file-check'));
  await h.settle(third,status(initial,{status:'present'}));assert.equal(h.nodes().find(node=>node.props?.render)?.props.render.props.href,'/media/new-owner');
});

for(const transition of ['hide-reopen','project','disabled'])test(`accepted POST finishes without publishing to a retired ${transition} owner and releases its shared flight`,async()=>{
  const h=harness();h.render();await h.missing();const old=h.choose();old.send();h.render();const post=h.calls.at(-1);assert.equal(post.options.method,'POST');assert.equal(h.find('export-file-locate').props.disabled,true);
  if(transition==='hide-reopen'){h.visible(false);h.render();h.visible(true);h.render();}
  else if(transition==='project')h.render({projectId:id(9),exportId:id(10),downloadHref:'/media/current-project'});
  else{h.render({disabled:true});h.render({disabled:false});}
  await h.missing();assert.equal(h.find('export-file-locate').props.disabled,true);const held=h.choose();held.send();assert.equal(h.calls.filter(call=>call.options.method==='POST').length,1);
  await h.settle(post,status(initial,{status:'present'}));assert.equal(h.nodes().some(node=>node.props?.render?.props?.href),false,'The old POST cannot make this scope claim the file is present');
  assert.equal(h.calls.at(-1).options.method,undefined,'Reopened scope reconciles through its own read');await h.missing();assert.equal(h.find('export-file-locate').props.disabled,false);
  const next=h.choose();next.send();assert.equal(h.calls.filter(call=>call.options.method==='POST').length,2);await h.settle(h.calls.at(-1),status(h.props(),{status:'present'}));
});

test('accepted POST is not aborted on hide or unmount and never publishes after unmount',async()=>{
  const h=harness();h.render();await h.missing();const selected=h.choose();selected.send();const post=h.calls.at(-1);h.visible(false);h.render();const reads=h.calls.length;h.unmount();post.resolve(response(status(initial,{status:'present'})));await tick();assert.equal(h.calls.length,reads);assert.equal(post.options.signal,undefined);
});

test('size and immutable response mismatches retain the original record and release the next choice',async()=>{
  const h=harness();h.render();await h.missing();const wrong=h.choose({size:3});wrong.send();await tick();h.render();assert.equal(h.calls.length,1);assert.ok(h.nodes().some(node=>node.type==='Alert'));assert.equal(h.find('export-file-locate').props.disabled,false);
  const selected=h.choose();selected.send();const post=h.calls.at(-1);await h.settle(post,status(initial,{status:'present',sha256:'b'.repeat(64)}));assert.ok(h.nodes().some(node=>node.type==='Alert'));assert.equal(h.nodes().some(node=>node.props?.render?.props?.href),false);assert.equal(h.find('export-file-locate').props.disabled,false);
  const next=h.choose();next.send();await h.settle(h.calls.at(-1),status(initial,{status:'present'}));assert.equal(h.nodes().find(node=>node.props?.render)?.props.render.props.href,initial.downloadHref);
});
