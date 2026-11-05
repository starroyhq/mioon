import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {isProjectWindowContext,isProjectWindowRequest} from '../apps/desktop/src/project-window-protocol.ts';
import type {ProjectWindowContext,ProjectWindowBridge} from '../apps/desktop/src/project-window-protocol.ts';
import {reportEditorWindowStatus} from '../apps/web/src/editor-native-window.ts';
import {projectOpenAttempt,canPublishProjectOpen} from '../apps/web/src/project-open-state.ts';

const projectId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',windowId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',contextId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',backendId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const context:ProjectWindowContext={version:2,role:'editor',windowId,contextId,backendId,initialProjectId:projectId,autoOpen:false,editorProjectId:projectId,editorPhase:'ready',editorCount:1,entryMode:null,entryVersion:0,entryReceipt:null,settingsSlot:null,settingsVersion:0,selectionProjectId:null,selectionVersion:0,locatorStatus:null,locatorIntent:null,quitting:false};
const app=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
function section(start:string,end:string){const from=app.indexOf(start),to=app.indexOf(end,from);assert.ok(from>=0&&to>from);return transformSync(app.slice(from,to),{loader:'tsx',format:'cjs'}).code;}
const observe=section('  function observeNativeProjectLease(', '  useLayoutEffect('),ready=section('  function projectSessionReady()', '  const workbenchReady =');
const run=section('  async function run(', '  async function runDurable('),select=section('  async function selectProject(', '  async function showProjectHome(');
function fixture(){
 const importSession={current:{active:true,selection:0,leaseRevoked:false}},nativeLeaseRevoked={current:false},clipConnectionBlocked={current:false},draft={title:'Retained unsaved draft'},data={project:{id:projectId},shots:[{title:'Original project data'}]},published:string[]=[];
 const env={nativeWindow:{context},importSession,nativeLeaseRevoked,clipConnectionBlocked,setNativeLeaseObservation:()=>published.push('lease'),canPublishProjectOpen,openedProject:{current:projectOpenAttempt(projectId,0,'workspace')},currentProject:{current:projectId},projectEpoch:{current:0},editorSession:{current:'workspace'},viewReady:{current:true},dataRef:{current:data},captureTaskWorkspaceIntent:()=>()=>false,readTaskRevealContext:()=>({}),isDurableEditOperation:()=>true,runDurable:async()=>{published.push('submit');return true;},runSession:async()=>{published.push('submit');return true;}};
 const compiled=Function(...Object.keys(env),`${observe}\n${ready}\n${run}\n${select}\nreturn {observeNativeProjectLease,projectSessionReady,run,selectProject};`)(...Object.values(env)) as {observeNativeProjectLease(next:ProjectWindowContext):void;projectSessionReady():boolean;run(key:string,operation:string,input:unknown):Promise<unknown>;selectProject(id:string):Promise<boolean>};
 return {...compiled,...env,draft,data,published};
}

test('lease revocation is a strict read-only context flag; ordinary load failure and legacy contexts remain distinct',()=>{
 assert.equal(isProjectWindowContext(context),true);assert.equal(isProjectWindowContext({...context,editorPhase:'failed',leaseRevoked:false}),true);assert.equal(isProjectWindowContext({...context,editorPhase:'failed',leaseRevoked:true}),true);
 for(const patch of [{leaseRevoked:'true'},{leaseRevoked:true},{editorPhase:'opening',leaseRevoked:true},{leaseRevoked:true,arbitrary:'value'}])assert.equal(isProjectWindowContext({...context,...patch}),false);
 assert.equal(isProjectWindowRequest({action:'editor-status',contextId,projectId,phase:'failed',leaseRevoked:true}),false);
});

test('actual App observer ignores foreign owners and ordinary failures but revocation immediately stops old callbacks and keeps drafts',async()=>{
 const f=fixture();assert.equal(f.projectSessionReady(),true);assert.equal(await f.run('edit','timeline.clip.update',{}),true);
 for(const patch of [{leaseRevoked:false,editorPhase:'failed' as const},{windowId:backendId,leaseRevoked:true,editorPhase:'failed' as const},{contextId:backendId,leaseRevoked:true,editorPhase:'failed' as const},{initialProjectId:windowId,leaseRevoked:true,editorPhase:'failed' as const},{role:'launcher' as const,leaseRevoked:true,editorPhase:'failed' as const}]){f.observeNativeProjectLease({...context,...patch});assert.equal(f.projectSessionReady(),true);}
 const draft=f.draft,data=f.dataRef.current;f.observeNativeProjectLease({...context,editorPhase:'failed',leaseRevoked:true});assert.equal(f.projectSessionReady(),false);assert.equal(await f.run('late','timeline.clip.update',{}),null);assert.equal(await f.selectProject(projectId),false);assert.equal(f.clipConnectionBlocked.current,true);assert.deepEqual(f.published,['submit','lease']);assert.equal(f.draft,draft);assert.equal(f.dataRef.current,data);assert.equal(f.currentProject.current,projectId);assert.equal(f.importSession.current.active,true);
 f.observeNativeProjectLease({...context,leaseRevoked:false});assert.equal(f.projectSessionReady(),false);assert.equal(await f.run('late','generation.submit',{}),null);assert.deepEqual(f.published,['submit','lease']);
});

test('the retained workbench and native close protection remain mounted when the lease is revoked',()=>{
 assert.match(app,/nativeWindow && !workbenchReady && !retainWorkbenchForClip && !nativeLeaseRevoked\.current/);assert.match(app,/!workbenchReady && !retainWorkbenchForClip && !nativeLeaseRevoked\.current\) return/);assert.match(app,/data-testid="native-project-lease-revoked"/);
 assert.match(app,/installNativeCloseAdmission/);assert.doesNotMatch(observe,/setData|emptyData|discard|dispose|currentProject\.current\s*=|setShotDirty|setClipDirty|setSubjectDirty/);
});

test('an old ready callback cannot publish through a freshly revoked host context',async()=>{
 let sent=0;const bridge={context:async()=>({...context,editorPhase:'failed' as const,leaseRevoked:true}),editorStatus:async()=>{sent++;return true;}} as unknown as ProjectWindowBridge;
 assert.equal(await reportEditorWindowStatus({context,bridge},projectId,'ready'),false);assert.equal(sent,0);
});

test('the actual App RPC boundary blocks stale direct project-note and editing leaf callbacks after revocation',async()=>{
 const source=section('  const rpc:typeof productionRpc=', '  const schemas ='),calls:unknown[][]=[],nativeLeaseRevoked={current:false};
 const productionRpc=async(...args:unknown[])=>{calls.push(args);return {accepted:true};},localizedError=()=>new Error('Project lease revoked'),msg=(key:string)=>key;
 const rpc=Function('productionRpc','nativeLeaseRevoked','localizedError','msg',`${source}\nreturn rpc;`)(productionRpc,nativeLeaseRevoked,localizedError,msg) as (operation:string,input:unknown,options?:unknown)=>Promise<unknown>;
 const before={projectId,requestId:'exact-request'},options={projectId};assert.deepEqual(await rpc('project.notes.set',before,options),{accepted:true});assert.deepEqual(calls,[['project.notes.set',before,options]]);
 nativeLeaseRevoked.current=true;for(const operation of ['project.notes.set','previs.node.update','asset.media.prepare','timeline.clip.update'])await assert.rejects(rpc(operation,before,options),{code:'PROJECT_ENTRY_UNAVAILABLE'});assert.equal(calls.length,1);assert.deepEqual(before,{projectId,requestId:'exact-request'});
});
