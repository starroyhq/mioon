interface CloseRegistration {slot:string;states:import('../apps/web/src/native-close-sources.ts').NativeCloseSourceState[];released:boolean}
import type {Tree as UiTree,Element as UiElement,Hook as UiHook,ElementProps as UiProps,Module as UiModule} from './helpers/strict-agent-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import * as protection from '../apps/web/src/agent-editing-protection.ts';
import {AGENT_TASK_DISPLAY_TARGET_KINDS,agentTaskEditingSchema, type AgentTaskTarget} from '../packages/contracts/src/agent-tasks-v2.ts';
import {taskDisplayTargets} from '../apps/web/src/agent-task-presentation.ts';
import {i18nTestModule} from './helpers/i18n.ts';

const nodes=(value: UiTree): UiElement[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const text=(value: UiTree): string=>Array.isArray(value)?value.map(text).join(' '):value&&typeof value==='object'?text(value.props?.children):String(value??'');
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function deferred(){let resolve!:(value?:unknown)=>void,reject!:(reason?:unknown)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function harness(){
  const initialProjectId=crypto.randomUUID(),target={kind:'shot',id:crypto.randomUUID(),revision:0},foreignOwner='normal:'+crypto.randomUUID()+':shot:'+target.id;
  let projectId: string=initialProjectId,claims: ReturnType<typeof makeClaim>[]=[],controller: ReturnType<typeof protection.createAgentEditingProtection>,visible=true,readOnly=false,recovery: unknown,confirm: (value?:unknown)=>Promise<unknown>=async()=>true,readHandler: ((...args: Parameters<protection.AgentEditingClient['read']>)=>unknown)|undefined,lookupHandler: ((...args:Parameters<NonNullable<protection.AgentEditingClient['lookup']>>)=>unknown)|undefined,updateHandler: ((input:Parameters<protection.AgentEditingClient['update']>[0])=>unknown)|undefined,storageWriteFailure=false;
  const updates: ({ action: string; ownerId: unknown; })[]=[],reads: unknown[][]=[],lookups: unknown[][]=[],confirmations: unknown[]=[],registrations: CloseRegistration[]=[],slots: UiHook[]=[],storage=new Map();let cursor=0,effects: number[]=[];
  const react={createContext:()=>({}),createElement:(type: import('./helpers/strict-agent-ui-types.ts').ElementType,props: Partial<UiProps>|null,...children: UiTree[])=>(({type,props:{...props,children}}) as unknown as UiElement),useRef:(value: unknown)=>slots[cursor++]??={current:value},useState:(value: unknown)=>{const at=cursor++;slots[at]??={value};return[slots[at].value,(next: (arg0: unknown) => unknown)=>{slots[at].value=typeof next==='function'?next(slots[at].value):next;}];},useLayoutEffect:(fn: ()=>void|(()=>void),deps: readonly unknown[])=>{const at=cursor++,old=slots[at];if(!old||deps.some((value: unknown,index)=>value!==old.deps![index])){slots[at]={...old,fn,deps};effects.push(at);}}};(react as typeof react&{default?:unknown}).default=react;
  const makeClaim=(ownerId: string,claimProject: string=initialProjectId)=>({id:crypto.randomUUID(),projectId:claimProject,ownerId,target:{...target},state:'active',createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-20T00:00:00Z'});
  const client={
    read:async(...args: Parameters<protection.AgentEditingClient['read']>)=>{reads.push(args);return readHandler?readHandler(...args):{claims:[...claims],targets:[target]};},
    lookup:async(...args: Parameters<NonNullable<protection.AgentEditingClient['lookup']>>)=>{lookups.push(args);return lookupHandler?lookupHandler(...args):{claims:[...claims],targets:[target],receipt:{requestId:args[2],projectId:args[0],ownerId:args[1],generation:123,sequence:1}};},
    update:async (input: Parameters<protection.AgentEditingClient['update']>[0])=>{updates.push(input);if(updateHandler)return updateHandler(input);if(input.action==='claim')claims=[...claims,makeClaim(input.ownerId)];else if(input.action==='resolve')claims=claims.filter(claim=>claim.ownerId!==input.ownerId);return{claims:[...claims],targets:[target]};},
  };
  const load=(file: string,boundary?: {}|undefined)=>{const module: UiModule={exports:{}};Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/'+file,import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)((id: string)=>{
    if(id==='react')return react;
    if(id==='./agent-editing-protection.ts')return{...protection,createAgentEditingClient:()=>client,createAgentEditingProtection:(options: { projectId: string; ownerId: string; targets: readonly AgentTaskTarget[]; generation?: number; client?: protection.AgentEditingClient; requestId?: () => string; onChange?: (state: protection.AgentEditingState) => void; })=>(controller=protection.createAgentEditingProtection({...options,client:(client as unknown as protection.AgentEditingClient)}))};
    if(id==='./AgentEditingBoundary.tsx')return boundary;
    if(id==='./agent-task-presentation.ts')return{taskDisplayTargets};
    if(id.includes('I18nProvider'))return i18nTestModule();
    if(id.includes('workbench-confirm'))return{useConfirmation:()=>(value: unknown)=>{confirmations.push(value);return confirm(value);}};
    if(id.includes('workbench-controls'))return{WorkbenchButton:'button'};
    if(id.includes('/button'))return{Button:'button'};
    if(id.includes('packages/i18n'))return{message:(key: unknown)=>({key})};
    if(id.includes('agent-tasks-v2'))return{agentTaskEditingSchema,AGENT_TASK_DISPLAY_TARGET_KINDS};
    if(id.endsWith('.css'))return{};
    throw Error('Unmocked component dependency: '+id);
  },module,module.exports);return module.exports;};
  const boundary=load('AgentEditingBoundary.tsx') as unknown as typeof import('../apps/web/src/AgentEditingBoundary.tsx'),retained=load('AgentRetainedEditing.tsx',boundary);
  const previous=globalThis.sessionStorage;globalThis.sessionStorage=({getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{if(storageWriteFailure)throw Error('Local receipt unavailable');storage.set(key,value);},removeItem:(key:string)=>storage.delete(key)} as unknown as Storage);
  const nativeCloseRegistry={register:(slot: string)=>{const registration: CloseRegistration={slot,states:[],released:false};registrations.push(registration);return{update:(state: import('../apps/web/src/native-close-sources.ts').NativeCloseSourceState)=>registration.states.push({...state}),release:()=>{registration.released=true;}};}};
  const render=()=>{cursor=0;effects=[];const tree=retained.default!({projectId,visible,readOnly,nativeCloseRegistry,recovery,targetName:()=> 'Opening scene'});for(const at of effects){slots[at].cleanup?.();slots[at].cleanup=slots[at].fn!();}return tree;};
  const pending=<Patch extends object = {}>(patch: Patch={} as Patch)=>({requestId:crypto.randomUUID(),projectId:initialProjectId,ownerId:foreignOwner,generation:123,sequence:1,action:'resolve',targets:[target],...patch});
  return{initialProjectId,target,client,updates,reads,lookups,confirmations,registrations,boundary,render,storage,foreignOwner,pending,
    key:()=> 'mioon.agent-editing-recovery.'+initialProjectId,
    closeState:()=>registrations.at(-1)?.states.at(-1),
    setVisible:(value: boolean)=>{visible=value;},setReadOnly:(value: boolean)=>{readOnly=value;},setProject:(value: string)=>{projectId=value;},setRecovery:(value: unknown)=>{recovery=value;},setConfirm:(value: ()=>Promise<unknown>)=>{confirm=value;},setRead:(value: (...args:unknown[])=>unknown)=>{readHandler=value;},setLookup:(value: (...args:unknown[])=>unknown)=>{lookupHandler=value;},setUpdate:(value: (...args:unknown[])=>unknown)=>{updateHandler=value;},setStorageWriteFailure:(value: boolean)=>{storageWriteFailure=value;},
    addForeign(){claims.push(makeClaim(foreignOwner));},controller:()=>controller,
    cleanup(){for(const slot of slots)slot.cleanup?.();controller?.dispose();globalThis.sessionStorage=(previous as unknown as Storage);},
  };
}
const resolveButton=(tree: UiTree)=>nodes(nodes(tree).find((node)=>node.type==='article')).find((node)=>node.type==='button');
const reloadButton=(tree: UiTree)=>nodes(tree).filter((node)=>node.type==='button').at(-1);

test('automatic read leaves no empty recovery card and never dispatches a write',async()=>{
  const h=harness();try{assert.equal(h.render(),null);await flush();assert.equal(h.render(),null);assert.equal(h.reads.length,1);assert.equal(h.updates.length,0);assert.equal(h.closeState()!.blocked,false);}finally{h.cleanup();}
});

test('retained recovery excludes this window active claim while keeping other-window claims explicitly resolvable',async()=>{
  const h=harness();try{
    await h.boundary.acquireAgentEditingTarget(h.initialProjectId,h.target);h.addForeign();h.render();await flush();let tree=h.render();
    const articles=nodes(tree).filter((node)=>node.type==='article');assert.equal(articles.length,1);assert.equal(h.controller().canEdit!(),true);
    assert.match(text(tree),/鏡頭|镜头/u);assert.match(text(tree),/Opening scene/u);assert.doesNotMatch(text(tree),new RegExp(h.target.id+'|'+h.foreignOwner+'|\\bshot\\b'));
    await resolveButton(tree)!.props.onClick();await flush();assert.equal(h.updates.at(-1)!.action,'resolve');assert.equal(h.updates.at(-1)!.ownerId,h.foreignOwner);assert.equal(h.controller().canEdit!(),true);
  }finally{h.cleanup();}
});

test('unknown reads retain the recovery content and safe target name without exposing raw identifiers',async()=>{
  const h=harness();try{
    h.addForeign();h.setRecovery({type:'p',props:{children:['Synthetic interrupted round']}});h.render();await flush();h.setRead(async()=>{throw Error('offline');});
    await reloadButton(h.render())!.props.onClick();await flush();const tree=h.render();assert.match(text(tree),/Synthetic interrupted round/u);assert.match(text(tree),/Opening scene/u);assert.equal(nodes(tree).filter((node)=>node.props?.role==='alert').length,1);assert.doesNotMatch(text(tree),new RegExp(h.target.id+'|'+h.foreignOwner));assert.equal(h.updates.length,0);
  }finally{h.cleanup();}
});

test('recovering an old explicit resolve invalidates matching cached admission and clears only after its exact receipt',async()=>{
  const h=harness();try{
    await h.boundary.acquireAgentEditingTarget(h.initialProjectId,h.target);const ownerId=protection.agentEditingOwnerIdentity('normal',h.boundary.agentEditingWindowOwner(),[h.target]);assert.equal(h.controller().canEdit!(),true);
    const original=h.pending({ownerId}),gate=deferred();h.storage.set(h.key(),JSON.stringify(original));h.setLookup(()=>gate.promise);h.render();await flush();
    assert.equal(h.storage.has(h.key()),true);assert.equal(h.closeState()!.blocked,true);assert.deepEqual(h.lookups,[[h.initialProjectId,ownerId,original.requestId]]);
    gate.resolve!({claims:[],targets:[h.target],receipt:{requestId:original.requestId,projectId:h.initialProjectId,ownerId,generation:123,sequence:1}});await flush();h.render();
    assert.equal(h.storage.has(h.key()),false);assert.equal(h.controller().canEdit!(),false);assert.equal(h.controller().getState!().phase,'uncertain');assert.equal(h.updates.length,1,'Receipt recovery must not repeat the original resolve or claim');
  }finally{h.cleanup();}
});

test('a mismatching receipt keeps the original resolve pending without issuing a replacement',async()=>{
  for(const key of ['requestId','projectId','ownerId','generation','sequence'] as const){const h=harness();try{
    const original=h.pending(),receipt={requestId:original.requestId,projectId:h.initialProjectId,ownerId:original.ownerId,generation:123,sequence:1,[key]:['generation','sequence'].includes(key)?999:crypto.randomUUID()};h.storage.set(h.key(),JSON.stringify(original));h.setLookup(async()=>({claims:[],targets:[h.target],receipt}));h.render();await flush();
    assert.equal(h.storage.get(h.key()),JSON.stringify(original),key);assert.equal(h.closeState()!.blocked,true,key);assert.equal(h.updates.length,0,key);assert.equal(h.lookups.length,1,key);
  }finally{h.cleanup();}}
});

test('hiding the mounted recovery owner for legacy history retains its unknown-receipt close fence and later queries only that receipt',async()=>{
  const h=harness();try{
    const original=h.pending();h.storage.set(h.key(),JSON.stringify(original));h.setLookup(async()=>({claims:[],targets:[h.target]}));h.render();await flush();h.render();
    const registration: CloseRegistration=h.registrations[0];assert.equal(h.closeState()!.blocked,true);assert.equal(h.registrations.length,1);
    h.setVisible(false);h.setRecovery(null);h.render();await flush();
    assert.equal(h.registrations.length,1);assert.equal(registration.released,false);assert.equal(h.closeState()!.blocked,true);assert.equal(h.storage.get(h.key()),JSON.stringify(original));assert.equal(h.updates.length,0);assert.equal(h.lookups.length,1);
    h.setLookup(async()=>({claims:[],targets:[h.target],receipt:{requestId:original.requestId,projectId:original.projectId,ownerId:original.ownerId,generation:original.generation,sequence:original.sequence}}));
    h.setVisible(true);h.render();await flush();h.render();
    assert.deepEqual(h.lookups,[[h.initialProjectId,original.ownerId,original.requestId],[h.initialProjectId,original.ownerId,original.requestId]]);
    assert.equal(h.updates.length,0);assert.equal(h.closeState()!.blocked,false);assert.equal(h.storage.has(h.key()),false);assert.equal(registration.released,false);
  }finally{h.cleanup();}
});

test('a retained resolve confirmation cannot dispatch after hiding, hide/show or a project change',async()=>{
  for(const change of ['hide','hide-show','project','project-return'] as const){const h=harness();try{
    h.addForeign();const confirmation=deferred();h.setConfirm(()=>confirmation.promise);h.render();await flush();resolveButton(h.render())!.props.onClick();await flush();
    if(change.startsWith('hide')){h.setVisible(false);h.render();if(change==='hide-show'){h.setVisible(true);h.render();}}
    else{h.setProject(crypto.randomUUID());h.render();if(change==='project-return'){h.setProject(h.initialProjectId);h.render();}}
    confirmation.resolve!(true);await flush();assert.equal(h.updates.length,0,change);
  }finally{h.cleanup();}}
});

test('corrupt retained receipts fail closed and cannot automatically clear or resolve',async()=>{
  for(const invalid of ['{broken',JSON.stringify({requestId:'invalid'}),JSON.stringify({}),'wrong-action'] as const){const h=harness();try{
    const raw=invalid==='wrong-action'?JSON.stringify(h.pending({action:'claim'})):invalid;
    h.addForeign();h.storage.set(h.key(),raw);h.render();await flush();const tree=h.render();assert.equal(h.storage.get(h.key()),raw);assert.equal(h.closeState()!.blocked,true);assert.equal(h.reads.length,0);assert.equal(h.lookups.length,0);assert.equal(h.updates.length,0);assert.equal(reloadButton(tree)!.props.disabled,true);
    await reloadButton(tree)!.props.onClick();await flush();assert.equal(h.storage.get(h.key()),raw);assert.equal(h.reads.length,0);assert.equal(h.updates.length,0);
  }finally{h.cleanup();}}
});

test('cancelling confirmation preserves the foreign claim and sends no resolve',async()=>{
  const h=harness();try{h.addForeign();h.setConfirm(async()=>false);h.render();await flush();await resolveButton(h.render())!.props.onClick();await flush();assert.equal(h.confirmations.length,1);assert.equal(h.updates.length,0);assert.equal(nodes(h.render()).filter((node)=>node.type==='article').length,1);assert.equal(h.storage.size,0);}finally{h.cleanup();}
});

test('a retained receipt belonging to a different project cannot be cleared through this project',async()=>{
  const h=harness();try{
    const original=h.pending({projectId:crypto.randomUUID()});h.storage.set(h.key(),JSON.stringify(original));h.render();await flush();h.render();
    assert.equal(h.storage.get(h.key()),JSON.stringify(original));assert.equal(h.closeState()!.blocked,true);assert.equal(h.lookups.length,0);assert.equal(h.updates.length,0);
  }finally{h.cleanup();}
});

test('failure to retain an explicit resolve blocks close and prevents all write dispatch',async()=>{
  const h=harness();try{
    h.addForeign();h.render();await flush();h.setStorageWriteFailure(true);await resolveButton(h.render())!.props.onClick();await flush();const tree=h.render();
    assert.equal(h.updates.length,0);assert.equal(h.storage.size,0);assert.equal(h.closeState()!.blocked,true);assert.equal(resolveButton(tree)!.props.disabled,true);
  }finally{h.cleanup();}
});
