import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chooseInitialProject,retainLastProjectScope,createProjectBootGuard,preferenceCacheIdentity,assertLastProjectBootIdentity} from '../apps/web/src/last-project-navigation.ts';
import {createWorkspacePreferences} from '../apps/web/src/workspace-preferences.ts';
import {defaultWorkspaceState,writeWorkspaceState,reconcileWorkspaceState} from '../apps/web/src/workspace-state.ts';
import {validateProjectWorkspace} from '../apps/web/src/restored-workspace.ts';
import {workspaceOriginScope} from '../apps/web/src/workspace-origin.ts';
import {projectOpenAttempt,canPublishProjectOpen,projectResponseMatches,hasProjectResponseOriginMismatch,projectOpenFailureKind} from '../apps/web/src/project-open-state.ts';
import {observeClipAudioRoleCapability} from '../apps/web/src/clip-audio-role-state.ts';
import {isWorkspaceRestoreInspection,canEditTimelineAudioRole} from '@mioon/contracts';
import {createSettingsNavigationRegistry} from '../apps/web/src/settings-navigation-state.ts';
import {createLastProjectController} from '../apps/web/src/last-project-state.ts';
import {editorInitialSelection} from '../apps/web/src/editor-native-window.ts';
import {videoConnectionProviders} from '../apps/web/src/generation-settings.ts';
import {readGenerationProviderDirectory} from '../apps/web/src/video-provider-directory.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const id=n=>`77000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope='a'.repeat(64),otherScope='b'.repeat(64),stamp='2026-10-12T00:00:00.000Z';
const envelope={supported:true,workspaceScope:scope,instanceId:id(9),revision:1,projectId:id(2),updatedAt:stamp,targetStatus:'matching'};
const projects=[{id:id(1)},{id:id(2)}];
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const app=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
function section(start,end){const a=app.indexOf(start),b=app.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);assert.equal(app.indexOf(start,a+start.length),-1);return app.slice(a,b);}
const refreshSource=section('  const refresh = useCallback(', '  async function revealImageAsset(');
const readySource=section('  function projectSessionReady()', '  const workbenchReady =');
const settingsSource=section('  async function prepareSettingsDeparture()', '  async function changeHomePage(');
const guardSource=section('  async function guardNavigation(', '  async function guardProjectNavigation(');
const projectGuardSource=section('  async function guardProjectNavigation(', '  async function prepareSettingsDeparture(');
const selectSource=section('  async function selectProject(', '  async function reloadPreferences(');
const bootSource=section('  async function boot(): Promise<void> {','  useEffect(() => {\n    bootGuard.current!.activate();');
const compile=(code,name,env)=>Function(...Object.keys(env),`${code}\nreturn ${name};`)(...Object.values(env));

test('initial choice uses valid explicit URL then valid locator then ordinary fallback without mutation',()=>{
 const frozen=structuredClone(envelope);
 assert.deepEqual(chooseInitialProject(projects,id(1),envelope),{projectId:id(1),source:'url',notice:null});
 assert.equal(chooseInitialProject(projects,id(3),envelope).projectId,id(2));
 assert.equal(chooseInitialProject(projects,null,envelope).source,'remembered');
 assert.equal(chooseInitialProject(projects,null,{...envelope,targetStatus:'missing'}).projectId,id(1));
 assert.match(renderCoreMessage('zh-Hans',chooseInitialProject(projects,null,{...envelope,targetStatus:'missing'}).notice),/不可用/);
 assert.equal(chooseInitialProject([],null,null).source,'none');
 assert.equal(chooseInitialProject(projects,null,{supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'}).source,'fallback');
 assert.deepEqual(envelope,frozen);
});
test('verified identity cannot change on reconnect and read failure preserves an established scope',()=>{
 assert.equal(retainLastProjectScope(null,scope),scope);assert.equal(retainLastProjectScope(scope,null),scope);
 assert.throws(()=>retainLastProjectScope(scope,otherScope),{code:'LAST_PROJECT_SCOPE_MISMATCH'});
 assert.throws(()=>retainLastProjectScope(null,'normal'),{code:'LAST_PROJECT_SCOPE_MISMATCH'});
});
test('boot tickets reject later boots, project changes and StrictMode disposed lifetimes',()=>{
 let epoch=0;const guard=createProjectBootGuard(()=>epoch);guard.activate();const a=guard.begin();assert.equal(guard.isCurrent(a),true);
 const b=guard.begin();assert.equal(guard.isCurrent(a),false);epoch++;assert.equal(guard.isCurrent(b),false);
 const c=guard.begin();guard.deactivate();guard.activate();assert.equal(guard.isCurrent(c),false);
});

function selectionHarness({refresh,confirm=true,videoDirectory}={}){
 const calls=[],currentProject={current:id(1)},projectEpoch={current:0},navigationEpoch={current:0};
 const view=defaultWorkspaceState();
 const env={msg,...createI18nTestContext(),localizedError:value=>Object.assign(new Error(renderCoreMessage('zh-Hans',value)),{displayMessage:value}),nativeWindow:null,editorInitialSelection,notify:(...args)=>calls.push(['notice',...args]),readableError:e=>e.message,workspaceRef:{current:{restored:false}},loading:false,importSession:{current:{active:true,selection:0}},currentProject,projectEpoch,navigationEpoch,
  agentDraft:{current:false},imageDraft:{current:false},confirm:async()=>confirm,
  dirtyRef:{current:!confirm},subtitlesRef:{current:null},clipDraftRef:{current:null},shotTextRef:{current:null},subjectsRef:{current:null},
  timelineFormatRef:{current:null},deliveryNameRef:{current:null},localDeliveryRef:{current:null},
  application:null,workspaceOriginScope,validateProjectWorkspace,reconcileWorkspaceState,reconcilePending(){},useCallback:fn=>fn,projectOpenAttempt,canPublishProjectOpen,projectResponseMatches,hasProjectResponseOriginMismatch,projectOpenFailureKind,videoConnectionProviders,readGenerationProviderDirectory,videoDirectoryUnavailable:false,
  openedProject:{current:projectOpenAttempt(id(1),0,'normal')},settingsNavigation:{current:createSettingsNavigationRegistry()},
  projectOpening:{phase:'ready',projectId:id(1),error:''},homePage:'projects',
  lastProjectRef:{current:{invalidateNavigation:epoch=>calls.push(['invalidate',epoch]),rememberOpened:(projectId,epoch)=>calls.push(['remember',projectId,epoch])}},
  requestCounter:{current:0},preferencesRef:{current:{flush:async()=>{},load:async()=>view,getStatus:()=>({phase:'saved'}),update:(...args)=>calls.push(['preferences',...args])}},
  tasksRef:{current:{getState:()=>({phase:'idle'}),load:async()=>{}}},viewReady:{current:true},dataRef:{current:{project:{id:id(1)}}},
  emptyData:{},pendingForProject:()=>[],dragging:{current:false},viewRef:{current:view},
  updateView:()=>{},URL,
  window:{location:{href:'http://127.0.0.1:4318/'},history:{pushState(){},replaceState(){}},__mioonUiPreferences:{markOpened:projectId=>calls.push(['markOpened',projectId])}},
  ...Object.fromEntries(['setLastSync','setProviders','setOnline','setPropertiesPage','setTaskState','setPreferenceStatus','setPending','setShowProjects','setData','setNodes','setLoading','setShotDirty','setClipDirty','setSourceDirty','setSubjectDirty','setSubtitleDirty','setInspectorEpoch','setRightDockTab','setPanelOverlay','setSelectedTaskId','setShowTasks','setShowDelivery','setShowImage','setShowProjectChooser','setShowExports','setComparisonId','setPreviewAsset','setRealConfirm','setToast','setMobilePanel','setView','setZoom'].map(name=>[name,value=>calls.push([name,value])])),
 };
 env.context=()=>({projectId:currentProject.current,epoch:navigationEpoch.current,workspace:env.workspaceRef.current});
 env.isCurrent=captured=>captured.projectId===currentProject.current&&captured.epoch===navigationEpoch.current&&workspaceOriginScope(captured.workspace)===workspaceOriginScope(env.workspaceRef.current);
 env.projectSessionReady=()=>compile(readySource,'projectSessionReady',env)();
 env.prepareSettingsDeparture=()=>compile(settingsSource,'prepareSettingsDeparture',env)();
 env.guardNavigation=(...args)=>compile(guardSource,'guardNavigation',env)(...args);
 env.guardProjectNavigation=(...args)=>compile(projectGuardSource,'guardProjectNavigation',env)(...args);
 env.setProjectOpening=value=>{env.projectOpening=value;calls.push(['setProjectOpening',value]);};
 env.setHomePage=value=>{env.homePage=value;calls.push(['setHomePage',value]);};
 env.setLoading=value=>{env.loading=value;calls.push(['setLoading',value]);};
 env.setAuth=value=>{env.auth=value;calls.push(['setAuth',value]);};
 env.setVideoDirectoryUnavailable=value=>{env.videoDirectoryUnavailable=value;calls.push(['setVideoDirectoryUnavailable',value]);};
 // External reads are the only doubles here; actual refresh validates and
 // publishes data, then actual selection plus the H1 gate admits the workbench.
 env.rpc=async(operation,input)=>operation==='project.get'?(refresh?refresh(input.projectId):{
  project:{id:input.projectId},shots:[],nodes:[],edges:[],assets:[],versions:[],jobs:[],exports:[],
  ...(env.workspaceRef.current.restored?{restore:{workspaceOrigin:env.workspaceRef.current.workspaceOrigin,heldExportIds:[]}}:{}),
 }):operation==='video.connection.list'&&videoDirectory?videoDirectory():[];
 env.refresh=(...args)=>{const scope={...env};delete scope.refresh;return compile(refreshSource,'refresh',scope)(...args);};
 return {env,calls,select:(...args)=>compile(selectSource,'selectProject',env)(...args)};
}
test('actual App only remembers a successfully loaded explicit project, never initial recovery or reload-view',async()=>{
 const f=selectionHarness();assert.equal(await f.select(id(2)),true);assert.equal(f.env.projectSessionReady(),true);assert.deepEqual(f.calls.filter(x=>x[0]==='remember'),[['remember',id(2),1]]);
 assert.deepEqual(f.calls.filter(x=>x[0]==='markOpened'),[['markOpened',id(2)]]);
 assert.deepEqual(f.calls.filter(x=>x[0]==='setSelectedTaskId'),[['setSelectedTaskId',undefined]],'Changing projects clears the previous project task-detail selection');
 assert.ok(f.calls.findIndex(x=>x[0]==='markOpened')>f.calls.findIndex(x=>x[0]==='setProjectOpening'&&x[1].phase==='ready'),'recent-open time is recorded only after the actual project-open gate accepts');
 const resetTab=f.calls.find(call=>call[0]==='setRightDockTab')[1];assert.equal(resetTab('tasks'),'properties');
 for(const tab of ['properties','agent','image','delivery'])assert.equal(resetTab(tab),tab);
 for(const args of [[id(2),true],[id(2),false,true,true]]){const g=selectionHarness();assert.equal(await g.select(...args),true);assert.equal(g.calls.some(x=>x[0]==='remember'),false);assert.deepEqual(g.calls.filter(x=>x[0]==='markOpened'),[['markOpened',id(2)]]);}
 const cancelled=selectionHarness({confirm:false});assert.equal(await cancelled.select(id(2)),false);assert.deepEqual(cancelled.calls,[]);
});
test('actual App rejects failed, foreign, unmounted or overtaken load without remembering it',async()=>{
 for(const next of [null,{project:{id:id(3)},shots:[],nodes:[]}]){const f=selectionHarness({refresh:async()=>next});assert.equal(await f.select(id(2)),false);assert.equal(f.calls.some(x=>x[0]==='remember'||x[0]==='markOpened'),false);}
 const gate=deferred(),f=selectionHarness({refresh:()=>gate.promise}),attempt=f.select(id(2));await new Promise(setImmediate);
 f.env.projectEpoch.current++;f.env.currentProject.current=id(3);gate.resolve({project:{id:id(2)},shots:[],nodes:[]});assert.equal(await attempt,false);assert.equal(f.calls.some(x=>x[0]==='remember'||x[0]==='markOpened'),false);
 const g=selectionHarness();g.env.importSession.current.active=false;assert.equal(await g.select(id(2)),false);assert.equal(g.calls.some(x=>x[0]==='remember'||x[0]==='markOpened'),false);
});
test('actual same-project shortcut requires loaded project and a failed activation can be explicitly retried',async()=>{
 const f=selectionHarness();assert.equal(await f.select(id(1)),true);assert.deepEqual(f.calls,[['remember',id(1),0]]);
 const g=selectionHarness();g.env.dataRef.current={};assert.equal(await g.select(id(1)),true);assert.ok(g.calls.some(x=>x[0]==='invalidate'));assert.deepEqual(g.calls.filter(x=>x[0]==='remember'),[['remember',id(1),1]]);
});
test('actual preference-load setup rejection releases only its current loading owner and never remembers',async()=>{
 const f=selectionHarness();f.env.preferencesRef.current.load=async()=>{throw Error('Preference identity rejected');};
 assert.equal(await f.select(id(2)),false);assert.equal(f.env.projectOpening.phase,'error');assert.match(f.env.projectOpening.error,/Preference identity rejected/);assert.equal(f.env.projectSessionReady(),false);assert.ok(f.calls.some(x=>x[0]==='setLoading'&&x[1]===false));assert.equal(f.calls.some(x=>x[0]==='remember'||x[0]==='markOpened'),false);
 const gate=deferred(),g=selectionHarness();g.env.preferencesRef.current.load=()=>gate.promise;const pending=g.select(id(2));await new Promise(setImmediate);g.env.currentProject.current=id(3);g.env.projectEpoch.current++;gate.reject(Error('late'));
 assert.equal(await pending,false);assert.equal(g.calls.some(x=>x[0]==='notice'||x[0]==='remember'||x[0]==='markOpened'||x[0]==='setLoading'&&x[1]===false||x[0]==='setProjectOpening'&&x[1].phase==='error'),false);
});

function bootHarness({discovery=Promise.resolve({envelope,workspaceScope:scope}),restored=false,explicit=null,videoDirectory}={}){
 const selection=selectionHarness({videoDirectory}),{env,calls}=selection,epoch=env.projectEpoch;
 const guard=createProjectBootGuard(()=>epoch.current);guard.activate();const readRpc=env.rpc;
 env.currentProject.current=null;env.openedProject.current=null;env.dataRef.current={};env.viewReady.current=false;
 Object.assign(env,{bootGuard:{current:guard},migrateBrowserStorage:()=>{},workspaceRef:{current:null},preferenceScope:{current:null},locatorIdentity:{current:null},
  audioRoleProbe:{current:null},audioRoleProbeEpoch:{current:0},setAudioRoleCapability:value=>calls.push(['audioRoleCapability',value]),observeClipAudioRoleCapability,isWorkspaceInspection:isWorkspaceRestoreInspection,canEditTimelineAudioRole,
  rpc:async(op,input)=>op==='workspace.restore.inspect'?{restored,...(restored?{workspaceOrigin:id(10)}:{})}:op==='project.list'?projects:readRpc(op,input),
  retainWorkspaceIdentity:(_current,observed)=>observed,setWorkspace:x=>calls.push(['workspace',x]),
  lastProjectRef:{current:{...env.lastProjectRef.current,getState:()=>({identityBlocked:false,revision:null}),discover:()=>{calls.push(['discover']);return discovery;}}},
  setProjects:x=>calls.push(['projects',x]),setProviders:x=>{env.providers=x;calls.push(['providers',x]);},setAuth:x=>{env.auth=x;calls.push(['auth',x]);},setOnline:()=>{},
  retainLastProjectScope,chooseInitialProject,assertLastProjectBootIdentity,URLSearchParams,
  window:{...env.window,location:{...env.window.location,search:explicit?'?project='+explicit:''}},
  selectProject:async(projectId,initial)=>{calls.push(['select',projectId,initial]);return selection.select(projectId,initial);},
 });
 return{env,epoch,calls,guard,boot:()=>compile(bootSource,'boot',env)()};
}
test('actual App startup chooses the remembered nonfirst project, with explicit URL precedence and no remember write',async()=>{
 const f=bootHarness();await f.boot();assert.deepEqual(f.calls.filter(x=>x[0]==='select'),[['select',id(2),true]]);assert.equal(f.env.preferenceScope.current,scope);assert.equal(f.env.projectSessionReady(),true);assert.equal(f.calls.some(x=>x[0]==='remember'),false);
 const g=bootHarness({explicit:id(1)});await g.boot();assert.deepEqual(g.calls.filter(x=>x[0]==='select'),[['select',id(1),true]]);
});
test('video directory failure preserves remembered-project boot and refresh, then clears its error after recovery',async()=>{
 for(const code of ['VIDEO_SETTINGS_CORRUPT','NETWORK']){
  let error=code;const f=bootHarness({videoDirectory:async()=>{if(error)throw Object.assign(Error(error),{code:error});return[];}});
  await f.boot();assert.equal(f.env.auth,true,code);assert.equal(f.env.projectSessionReady(),true);assert.equal(f.env.currentProject.current,id(2));assert.equal(f.env.videoDirectoryUnavailable,true);
  assert.deepEqual(f.calls.filter(x=>x[0]==='select'),[['select',id(2),true]]);assert.equal(f.env.preferenceScope.current,scope);assert.equal(f.calls.some(x=>x[0]==='remember'),false);
  f.env.viewRef.current.activeMode='editing';f.env.viewRef.current.editing.playhead=72;
  assert.equal((await f.env.refresh(id(2))).project.id,id(2));assert.equal(f.env.videoDirectoryUnavailable,true);assert.equal(f.env.viewRef.current.activeMode,'editing');assert.equal(f.env.viewRef.current.editing.playhead,72);
  error=null;assert.equal((await f.env.refresh(id(2))).project.id,id(2));assert.equal(f.env.videoDirectoryUnavailable,false);assert.equal(f.env.projectSessionReady(),true);
 }
});
test('late optional video failure from an older boot cannot replace a newer boot directory state',async()=>{
 const held=deferred();let reads=0;const f=bootHarness({videoDirectory:()=>++reads===1?held.promise:[]});
 const old=f.boot();await new Promise(setImmediate);await f.boot();assert.equal(f.env.auth,true);assert.equal(f.env.videoDirectoryUnavailable,false);assert.equal(f.env.projectSessionReady(),true);
 const count=f.calls.length;held.reject(Object.assign(Error('late corrupt settings'),{code:'VIDEO_SETTINGS_CORRUPT'}));await old;
 assert.equal(f.calls.length,count);assert.equal(f.env.videoDirectoryUnavailable,false);assert.equal(f.env.currentProject.current,id(2));
});
test('optional video directory 401 remains an authentication failure during remembered-project boot',async()=>{
 for(const error of [Object.assign(Error('UNAUTHORIZED'),{code:'UNAUTHORIZED'}),Object.assign(Error('HTTP 401'),{status:401})]){
  const f=bootHarness({videoDirectory:async()=>{throw error;}});await f.boot();assert.equal(f.env.auth,false);assert.equal(f.calls.some(x=>x[0]==='select'),false);assert.equal(f.env.projectSessionReady(),false);
 }
});
test('actual App stale startup cannot replace newer selection, publish data after unmount or inspect restored locator',async()=>{
 const gate=deferred(),f=bootHarness({discovery:gate.promise}),old=f.boot();await new Promise(setImmediate);f.epoch.current++;gate.resolve({envelope,workspaceScope:scope});await old;assert.equal(f.calls.some(x=>x[0]==='select'||x[0]==='projects'),false);
 const held=deferred(),g=bootHarness({discovery:held.promise}),pending=g.boot();await new Promise(setImmediate);g.guard.deactivate();held.resolve({envelope,workspaceScope:scope});await pending;assert.equal(g.calls.some(x=>x[0]==='select'||x[0]==='projects'),false);
 const restored=bootHarness({restored:true});await restored.boot();assert.equal(restored.calls.some(x=>x[0]==='discover'||x[0]==='markOpened'),false);assert.deepEqual(restored.calls.filter(x=>x[0]==='select'),[['select',id(1),true]]);
});
test('initial foreign locator permits uncached manual project fallback; changed established identity blocks startup',async()=>{
 const first=bootHarness({discovery:Promise.resolve(null)});first.env.lastProjectRef.current.getState=()=>({identityBlocked:true,revision:null});await first.boot();
 assert.deepEqual(first.calls.filter(x=>x[0]==='select'),[['select',id(1),true]]);assert.equal(first.env.preferenceScope.current,null);
 for(const revision of [0,1]){
  const changed=bootHarness({discovery:Promise.resolve(null)});changed.env.lastProjectRef.current.getState=()=>({identityBlocked:true,revision});await changed.boot();
  assert.equal(changed.calls.some(x=>x[0]==='select'),false);assert.ok(changed.calls.some(x=>x[0]==='auth'&&x[1]==='error'));assert.equal(changed.env.preferenceScope.current,null);
 }
});

function storage(){const map=new Map();return{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),map};}
const response=data=>({ok:true,status:200,json:async()=>({ok:true,data})});
test('App verified preference scope excludes foreign same-UUID and legacy bare-cache imports',async t=>{
 const local=storage(),legacy=defaultWorkspaceState();legacy.activeMode='editing';legacy.editing.playhead=117;writeWorkspaceState(id(1),legacy,local);writeWorkspaceState(`normal:${otherScope}:${id(1)}`,legacy,local);
 for(const verified of [null,scope]){
  const writes=[];const prefs=createWorkspacePreferences({storage:local,getStorageScope:()=>verified,fetchImpl:async(_url,init)=>{writes.push(init.method);return response({projectId:id(1),revision:0,state:null});}});t.after(()=>prefs.dispose({flush:false}));
  const loaded=await prefs.load(id(1));assert.equal(loaded.activeMode,'canvas');assert.equal(loaded.editing.playhead,0);await prefs.flush();assert.deepEqual(writes,['GET']);
 }
 assert.equal(preferenceCacheIdentity('normal',id(1),null).cacheId,null);assert.notEqual(preferenceCacheIdentity('normal',id(1),scope).entryScope,preferenceCacheIdentity('normal',id(1),otherScope).entryScope);
});
test('same verified workspace can reuse its bounded cache, while unverified offline fallback cannot',async t=>{
 const local=storage(),saved=defaultWorkspaceState();saved.activeMode='editing';saved.editing.playhead=57;writeWorkspaceState(`normal:${scope}:${id(1)}`,saved,local);
 for(const [verified,expected] of [[null,0],[scope,57]]){const prefs=createWorkspacePreferences({storage:local,getStorageScope:()=>verified,fetchImpl:async()=>{throw Error('offline');}});t.after(()=>prefs.dispose({flush:false}));assert.equal((await prefs.load(id(1))).editing.playhead,expected);assert.equal(prefs.getStatus(id(1)).phase,'local');}
});
test('a new boot without verified scope cannot flush queued previous-scope view edits into the new connection',async t=>{
 let verified=scope;const requests=[];const prefs=createWorkspacePreferences({getStorageScope:()=>verified,delayMs:60_000,maxWaitMs:60_000,fetchImpl:async(_url,init)=>{requests.push(init.method);return response({projectId:id(1),revision:0,state:null});}});t.after(()=>prefs.dispose({flush:false}));
 const state=await prefs.load(id(1));state.editing.playhead=80;prefs.update(id(1),state);verified=null;await prefs.flush();assert.deepEqual(requests,['GET']);
 assert.equal((await prefs.load(id(1))).editing.playhead,0);await prefs.flush();assert.deepEqual(requests,['GET','GET']);
});
test('same-session locator mismatch disables previous workspace cache and queued preference writes immediately',async t=>{
 let remote=structuredClone(envelope);const locator=createLastProjectController({client:{get:async()=>remote,put:async()=>{throw Error('Not authorized by this test');}}});t.after(()=>locator.dispose());await locator.discover();
 const local=storage(),saved=defaultWorkspaceState();saved.activeMode='editing';saved.editing.playhead=57;writeWorkspaceState(`normal:${scope}:${id(1)}`,saved,local);
 const requests=[];const prefs=createWorkspacePreferences({storage:local,getStorageScope:()=>locator.getState().identityBlocked?null:scope,delayMs:60_000,maxWaitMs:60_000,fetchImpl:async(_url,init)=>{requests.push(init.method);return response({projectId:id(1),revision:0,state:null});}});t.after(()=>prefs.dispose({flush:false}));
 assert.equal((await prefs.load(id(1))).editing.playhead,57);
 remote={...remote,workspaceScope:otherScope};await locator.recheck();assert.equal(locator.getState().identityBlocked,true);
 await prefs.flush();assert.deepEqual(requests,['GET']);assert.equal((await prefs.load(id(1))).editing.playhead,0);await prefs.flush();assert.deepEqual(requests,['GET','GET']);
});
