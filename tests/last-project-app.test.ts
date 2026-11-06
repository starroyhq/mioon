import type {AppFunctions, SelectionEnvironment as LegacySelectionEnvironment, SelectionData} from './helpers/strict-last-project-app-types.ts';
import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chooseInitialProject,retainLastProjectScope,createProjectBootGuard,preferenceCacheIdentity} from '../apps/web/src/last-project-navigation.ts';
import {createWorkspacePreferences} from '../apps/web/src/workspace-preferences.ts';
import {defaultWorkspaceState,writeWorkspaceState,reconcileWorkspaceState} from '../apps/web/src/workspace-state.ts';
import {projectOpenAttempt,canPublishProjectOpen,projectResponseMatches,projectOpenFailureKind} from '../apps/web/src/project-open-state.ts';
import {createSettingsNavigationRegistry} from '../apps/web/src/settings-navigation-state.ts';
import {projectEntryFixture,projectEntryOwnerFixture} from './helpers/project-entry-fixture.ts';
import {readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import type {ProjectEntryIdentityOwner} from '../apps/web/src/project-entry-identity.ts';
import {projectDirectoryProjects} from '../apps/web/src/project-directory-presentation.ts';
// Preserve the existing fixture's declared fields without carrying its retired
// locator property. Strip the catch-all index before applying Omit.
type DeclaredFields<T> = {[K in keyof T as string extends K ? never : number extends K ? never : K]: T[K]};
type SelectionEnvironment = Omit<DeclaredFields<LegacySelectionEnvironment>, 'lastProjectRef'> & Record<string,unknown> & {projectEntryIdentityRef:{current:ProjectEntryIdentityOwner}};
import {editorInitialSelection} from '../apps/web/src/editor-native-window.ts';
import {videoConnectionProviders} from '../apps/web/src/generation-settings.ts';
import {readGenerationProviderDirectory} from '../apps/web/src/video-provider-directory.ts';

import { lenientFunction } from './helpers/eval-source.ts';
import type { DisplayMessage } from '../packages/i18n/src/types.ts';
const Function = lenientFunction;
const id=(n: number)=>`77000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope='a'.repeat(64),otherScope='b'.repeat(64);
const ignoredLegacyObservation=Object.freeze({projectId:id(2)});
const projects=[{id:id(1)},{id:id(2)}];
const deferred=()=>{let resolve!: (value?: unknown) => void,reject!: (value: unknown) => void;const promise=new Promise<unknown>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const app=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
// Execute the actual pure error classifier used by App's new recovery state;
// selection/navigation assertions below still run the unmodified App functions.
const recoverySource=readFileSync(new URL('../apps/web/src/ProjectBackupRecovery.tsx',import.meta.url),'utf8');
const recoveryStart=recoverySource.indexOf('const record ='),recoveryEnd=recoverySource.indexOf('/** A failed project');
assert.ok(recoveryStart>=0&&recoveryEnd>recoveryStart);
const canOfferBackupRecovery=Function(recoverySource.slice(recoveryStart,recoveryEnd).replace('export function','function')+'\nreturn canOfferBackupRecovery;')() as (error:unknown)=>boolean;

function section(start: string,end: string){const a=app.indexOf(start),b=app.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);assert.equal(app.indexOf(start,a+start.length),-1);return app.slice(a,b);}
const refreshSource=section('  const refresh = useCallback(', '  async function revealImageAsset(');
const readySource=section('  function projectSessionReady()', '  const workbenchReady =');
const settingsSource=section('  async function prepareSettingsDeparture()', '  async function changeHomePage(');
const guardSource=section('  async function guardNavigation(', '  async function guardProjectNavigation(');
const projectGuardSource=section('  async function guardProjectNavigation(', '  async function prepareSettingsDeparture(');
const selectSource=section('  function captureProjectFeatureAdmission(', '  function projectSessionReady()') + section('  async function selectProject(', '  async function reloadPreferences(');
const bootSource=section('  async function boot(): Promise<void> {','  useEffect(() => {\n    const identity = projectEntryIdentityRef.current!;');
const compile=<N extends keyof AppFunctions>(code: string,name: N,env: Record<string, unknown>): AppFunctions[N] =>Function(...Object.keys(env),`${code}\nreturn ${name};`)(...Object.values(env)) as AppFunctions[N];

test('initial choice opens only a valid visible explicit URL and ignores compatibility observations',()=>{
 const frozen=structuredClone(ignoredLegacyObservation);
 assert.deepEqual(chooseInitialProject(projects,id(1),ignoredLegacyObservation),{projectId:id(1),source:'url',notice:null});
 for(const explicit of [id(3),'not-a-project','']){
  const choice=chooseInitialProject(projects,explicit,ignoredLegacyObservation);assert.equal(choice.projectId,null);assert.equal(choice.source,'none');
  assert.equal(renderCoreMessage('zh-Hans',choice.notice),'该项目暂时不可用，请在首页重试或选择其他项目');
 }
 for(const observed of [ignoredLegacyObservation,{projectId:id(3)},Object.freeze({unsupported:true}),null]){
  assert.deepEqual(chooseInitialProject(projects,null,observed),{projectId:null,source:'none',notice:null});
 }
 assert.deepEqual(chooseInitialProject([],null,null),{projectId:null,source:'none',notice:null});
 assert.deepEqual(ignoredLegacyObservation,frozen);
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

function selectionHarness({refresh,confirm=true,videoDirectory}: {refresh?(projectId: string): unknown; confirm?: boolean; videoDirectory?(): unknown}={}){
 const calls: [string, ...unknown[]][]=[],currentProject={current:id(1) as string | null},projectEpoch={current:0},navigationEpoch={current:0};
 const view=defaultWorkspaceState(),identity=projectEntryOwnerFixture(()=>projectEntryFixture(projects),calls);
 const env={canOfferBackupRecovery,backupFailure:null,projects,nativeLeaseRevoked:{current:false},msg,...createI18nTestContext(),localizedError:(value?: string|DisplayMessage|null|undefined)=>Object.assign(new Error(renderCoreMessage('zh-Hans',value)),{displayMessage:value}),nativeWindow:null,editorInitialSelection,notify:(...args: unknown[])=>calls.push(['notice',...args]),readableError:(e: Error)=>e.message,editorSession: {current: 'normal'}, workspaceRef:{current:{}},loading:false,importSession:{current:{active:true,selection:0}},currentProject,projectEpoch,navigationEpoch,
  agentDraft:{current:false},imageDraft:{current:false},confirm:async()=>confirm,
  dirtyRef:{current:!confirm},subtitlesRef:{current:null},clipDraftRef:{current:null},shotTextRef:{current:null},subjectsRef:{current:null},
  timelineFormatRef:{current:null},deliveryNameRef:{current:null},localDeliveryRef:{current:null},
  application:null,reconcileWorkspaceState,reconcilePending(){},useCallback:<T>(fn: T): T =>fn,projectOpenAttempt,canPublishProjectOpen,projectResponseMatches,projectOpenFailureKind,videoConnectionProviders,readGenerationProviderDirectory,videoDirectoryUnavailable:false,
  // This fixture owns no editing claims; match the empty-owner refresh wait.
  refreshAgentEditingTargets:async()=>{await Promise.allSettled([]);},
  openedProject:{current:projectOpenAttempt(id(1),0,'normal')},settingsNavigation:{current:createSettingsNavigationRegistry()},
  projectOpening:{phase:'ready',projectId:id(1),error:''},homePage:'projects',
  projectEntryIdentityRef:{current:identity},readProjectEntryIdentity,projectDirectoryProjects,
  requestCounter:{current:0},preferencesRef:{current:{flush:async()=>{},load:async()=>view,getStatus:()=>({phase:'saved'}),update:(...args: unknown[])=>calls.push(['preferences',...args])}},
  tasksRef:{current:{getState:()=>({phase:'idle'}),load:async()=>{}}},viewReady:{current:true},dataRef:{current:{project:{id:id(1)}}},
  emptyData:{},pendingForProject:()=>[],dragging:{current:false},viewRef:{current:view},
  updateView:()=>{},URL,
  window:{location:{href:'http://127.0.0.1:4318/'},history:{pushState(){},replaceState(){}},__mioonUiPreferences:{markOpened:(projectId: string)=>calls.push(['markOpened',projectId])}},
  ...Object.fromEntries(['setBackupFailure','setLastSync','setProviders','setOnline','setPropertiesPage','setTaskState','setPreferenceStatus','setPending','setShowProjects','setData','setNodes','setLoading','setShotDirty','setClipDirty','setSourceDirty','setSubjectDirty','setSubtitleDirty','setInspectorEpoch','setRightDockTab','setPanelOverlay','setSelectedTaskId','setShowTasks','setShowDelivery','setShowImage','setShowProjectChooser','setShowExports','setComparisonId','setPreviewAsset','setRealConfirm','setToast','setMobilePanel','setView','setZoom'].map(name=>[name,(value: unknown)=>calls.push([name,value])])),
 } as unknown as SelectionEnvironment;
 env.context=()=>({projectId:currentProject.current,epoch:navigationEpoch.current,session:env.editorSession.current});
 env.isCurrent=(captured: { projectId: string | null; epoch: number; session: string; })=>captured.projectId===currentProject.current&&captured.epoch===navigationEpoch.current&&captured.session===env.editorSession.current;
 env.projectSessionReady=()=>compile(readySource,'projectSessionReady',env)();
 env.prepareSettingsDeparture=()=>compile(settingsSource,'prepareSettingsDeparture',env)();
 env.guardNavigation=(...args: unknown[])=>compile(guardSource,'guardNavigation',env)(...args);
 env.guardProjectNavigation=(...args: unknown[])=>compile(projectGuardSource,'guardProjectNavigation',env)(...args);
 env.setProjectOpening=(value: { phase: string; projectId: string; error: string; })=>{env.projectOpening=value;calls.push(['setProjectOpening',value]);};
 env.setHomePage=(value: string)=>{env.homePage=value;calls.push(['setHomePage',value]);};
 env.setLoading=(value: boolean)=>{env.loading=value;calls.push(['setLoading',value]);};
 env.setAuth=(value: boolean | string)=>{env.auth=value;calls.push(['setAuth',value]);};
 env.setVideoDirectoryUnavailable=(value: boolean)=>{env.videoDirectoryUnavailable=value;calls.push(['setVideoDirectoryUnavailable',value]);};
 // External reads are the only doubles here; actual refresh validates and
 // publishes data, then actual selection plus the H1 gate admits the workbench.
 env.rpc=async(operation: string,input?: {projectId: string})=>operation==='project.get'?(refresh?refresh(input!.projectId):{
  project:{id:input!.projectId},shots:[],nodes:[],edges:[],assets:[],versions:[],jobs:[],exports:[],
 }):operation==='video.connection.list'&&videoDirectory?videoDirectory():[];
 env.refresh=(...args: unknown[])=>{const scope={...env};delete (scope as {refresh?: unknown}).refresh;return compile(refreshSource,'refresh',scope)(...args);};
 return {env,calls,select:(...args: unknown[])=>compile(selectSource,'selectProject',env)(...args)};
}
test('actual App marks only successfully loaded selections and never mounts a retired locator writer',async()=>{
 const f=selectionHarness();assert.equal(await f.select(id(2)),true);assert.equal(f.env.projectSessionReady(),true);assert.deepEqual(f.calls.filter(x=>x[0]==='remember'),[]);assert.equal('lastProjectRef' in f.env,false);
 assert.deepEqual(f.calls.filter(x=>x[0]==='markOpened'),[['markOpened',id(2)]]);
 assert.deepEqual(f.calls.filter(x=>x[0]==='setSelectedTaskId'),[['setSelectedTaskId',undefined]],'Changing projects clears the previous project task-detail selection');
 assert.ok(f.calls.findIndex(x=>x[0]==='markOpened')>f.calls.findIndex(x=>x[0]==='setProjectOpening'&&(x[1] as {phase: string}).phase==='ready'),'recent-open time is recorded only after the actual project-open gate accepts');
 const resetTab=f.calls.find(call=>call[0]==='setRightDockTab')![1] as (tab: string) => string;assert.equal(resetTab('tasks'),'properties');
 for(const tab of ['properties','agent','image','delivery'])assert.equal(resetTab(tab),tab);
 for(const args of [[id(2),true],[id(2),false,true,true]]){const g=selectionHarness();assert.equal(await g.select(...args),true);assert.equal(g.calls.some(x=>x[0]==='remember'),false);assert.deepEqual(g.calls.filter(x=>x[0]==='markOpened'),[['markOpened',id(2)]]);}
 const cancelled=selectionHarness({confirm:false});assert.equal(await cancelled.select(id(2)),false);assert.deepEqual((cancelled.calls as unknown),[]);
});
test('actual App rejects failed, foreign, unmounted or overtaken load without remembering it',async()=>{
 for(const next of [null,{project:{id:id(3)},shots:[],nodes:[]}]){const f=selectionHarness({refresh:async()=>next});assert.equal(await f.select(id(2)),false);assert.equal(f.calls.some(x=>x[0]==='remember'||x[0]==='markOpened'),false);}
 const gate=deferred(),f=selectionHarness({refresh:()=>gate.promise}),attempt=f.select(id(2));await new Promise(setImmediate);
 f.env.projectEpoch.current++;f.env.currentProject.current=id(3);(gate.resolve)!({project:{id:id(2)},shots:[],nodes:[]});assert.equal(await attempt,false);assert.equal(f.calls.some(x=>x[0]==='remember'||x[0]==='markOpened'),false);
 const g=selectionHarness();g.env.importSession.current.active=false;assert.equal(await g.select(id(2)),false);assert.equal(g.calls.some(x=>x[0]==='remember'||x[0]==='markOpened'),false);
});
test('actual same-project shortcut requires loaded data and a failed activation still takes the guarded load path',async()=>{
 const f=selectionHarness();await readProjectEntryIdentity(f.env.projectEntryIdentityRef.current);f.calls.length=0;assert.equal(await f.select(id(1)),true);assert.deepEqual(f.calls,[]);assert.equal(f.env.projectEpoch.current,0);
 const g=selectionHarness();g.env.dataRef.current={};assert.equal(await g.select(id(1)),true);assert.equal(g.env.projectEpoch.current,1);assert.equal(g.env.openedProject.current?.projectId,id(1));assert.deepEqual(g.calls.filter(x=>x[0]==='remember'),[]);
});
test('actual preference-load setup rejection releases only its current loading owner and never remembers',async()=>{
 const f=selectionHarness();f.env.preferencesRef.current.load=async()=>{throw Error('Preference identity rejected');};
 assert.equal(await f.select(id(2)),false);assert.equal(f.env.projectOpening.phase,'error');assert.match(f.env.projectOpening.error,/Preference identity rejected/);assert.equal(f.env.projectSessionReady(),false);assert.ok(f.calls.some(x=>x[0]==='setLoading'&&x[1]===false));assert.equal(f.calls.some(x=>x[0]==='remember'||x[0]==='markOpened'),false);
 const gate=deferred(),g=selectionHarness();g.env.preferencesRef.current.load=()=>gate.promise;const pending=g.select(id(2));await new Promise(setImmediate);g.env.currentProject.current=id(3);g.env.projectEpoch.current++;(gate.reject)!(Error('late'));
 assert.equal(await pending,false);assert.equal(g.calls.some(x=>x[0]==='notice'||x[0]==='remember'||x[0]==='markOpened'||x[0]==='setLoading'&&x[1]===false||x[0]==='setProjectOpening'&&(x[1] as {phase: string}).phase==='error'),false);
});

function bootHarness({directory=()=>projectEntryFixture(projects),explicit=null,videoDirectory}: {directory?:()=>unknown; explicit?: string|null; videoDirectory?():unknown}={}){
 const selection=selectionHarness({videoDirectory}),{env,calls}=selection,epoch=env.projectEpoch;
 env.projectEntryIdentityRef.current.dispose();env.projectEntryIdentityRef.current=projectEntryOwnerFixture(directory,calls);
 const guard=createProjectBootGuard(()=>epoch.current);guard.activate();const readRpc=env.rpc;
 env.currentProject.current=null;env.openedProject.current=null;env.dataRef.current={};env.viewReady.current=false;
 Object.assign(env,{bootGuard:{current:guard},migrateBrowserStorage:()=>{},editorSession: {current: 'normal'}, workspaceRef:{current:null},preferenceScope:{current:null},locatorIdentity:{current:null},

  rpc:readRpc,
  setWorkspace:(x: unknown)=>calls.push(['workspace',x]),
  setProjects:(x: unknown)=>calls.push(['projects',x]),setProviders:(x: unknown[])=>{env.providers=x;calls.push(['providers',x]);},setAuth:(x: boolean | string)=>{env.auth=x;calls.push(['auth',x]);},setOnline:()=>{},
  retainLastProjectScope,chooseInitialProject,readProjectEntryIdentity,projectDirectoryProjects,URLSearchParams,
  window:{...env.window,location:{...env.window.location,search:explicit?'?project='+explicit:''}},
  selectProject:async(projectId: string,initial: boolean)=>{calls.push(['select',projectId,initial]);return selection.select(projectId,initial);},
 });
 return{env,epoch,calls,guard,boot:()=>compile(bootSource,'boot',env)()};
}
test('actual App startup retains verified scope on home and only explicit URL opens without a remember write',async()=>{
 const f=bootHarness();await f.boot();assert.deepEqual(f.calls.filter(x=>x[0]==='select'),[]);assert.equal(f.env.preferenceScope!.current,scope);assert.equal(f.env.projectSessionReady(),false);assert.equal(f.calls.some(x=>x[0]==='remember'),false);
 const g=bootHarness({explicit:id(1)});await g.boot();assert.deepEqual(g.calls.filter(x=>x[0]==='select'),[['select',id(1),true]]);
});
test('video directory failure preserves explicit-project boot and refresh, then clears its error after recovery',async()=>{
 for(const code of ['VIDEO_SETTINGS_CORRUPT','NETWORK']){
  let error: string | null=code;const f=bootHarness({explicit:id(2),videoDirectory:async()=>{if(error)throw Object.assign(Error(error),{code:error});return[];}});
  await f.boot();assert.equal(f.env.auth,true,code);assert.equal(f.env.projectSessionReady(),true);assert.equal(f.env.currentProject.current,id(2));assert.equal(f.env.videoDirectoryUnavailable,true);
  assert.deepEqual(f.calls.filter(x=>x[0]==='select'),[['select',id(2),true]]);assert.equal(f.env.preferenceScope!.current,scope);assert.equal(f.calls.some(x=>x[0]==='remember'),false);
  f.env.viewRef.current.activeMode='editing';f.env.viewRef.current.editing.playhead=72;
  assert.equal((await f.env.refresh(id(2)))!.project.id,id(2));assert.equal(f.env.videoDirectoryUnavailable,true);assert.equal(f.env.viewRef.current.activeMode,'editing');assert.equal(f.env.viewRef.current.editing.playhead,72);
  error=null;assert.equal((await f.env.refresh(id(2)))!.project.id,id(2));assert.equal(f.env.videoDirectoryUnavailable,false);assert.equal(f.env.projectSessionReady(),true);
 }
});
test('late optional video failure from an older boot cannot replace a newer boot directory state',async()=>{
 const held=deferred();let reads=0;const f=bootHarness({explicit:id(2),videoDirectory:()=>++reads===1?held.promise:[]});
 const old=f.boot();await new Promise(setImmediate);await f.boot();assert.equal(f.env.auth,true);assert.equal(f.env.videoDirectoryUnavailable,false);assert.equal(f.env.projectSessionReady(),true);
 const count=f.calls.length;(held.reject)!(Object.assign(Error('late corrupt settings'),{code:'VIDEO_SETTINGS_CORRUPT'}));await old;
 assert.equal(f.calls.length,count);assert.equal(f.env.videoDirectoryUnavailable,false);assert.equal(f.env.currentProject.current,id(2));
});
test('optional video directory 401 remains an authentication failure during explicit-project boot',async()=>{
 for(const error of [Object.assign(Error('UNAUTHORIZED'),{code:'UNAUTHORIZED'}),Object.assign(Error('HTTP 401'),{status:401})]){
  const f=bootHarness({explicit:id(2),videoDirectory:async()=>{throw error;}});await f.boot();assert.equal(f.env.auth,false);assert.equal(f.calls.some(x=>x[0]==='select'),false);assert.equal(f.env.projectSessionReady(),false);
 }
});
test('actual App stale startup cannot replace newer selection, publish data after unmount',async()=>{
 const gate=deferred(),f=bootHarness({explicit:id(2),directory:()=>gate.promise}),old=f.boot();await new Promise(setImmediate);f.epoch.current++;(gate.resolve)!(projectEntryFixture(projects));await old;assert.equal(f.calls.some(x=>x[0]==='select'||x[0]==='projects'),false);
 const held=deferred(),g=bootHarness({explicit:id(2),directory:()=>held.promise}),pending=g.boot();await new Promise(setImmediate);g.guard.deactivate();(held.resolve)!(projectEntryFixture(projects));await pending;assert.equal(g.calls.some(x=>x[0]==='select'||x[0]==='projects'),false);
});
test('startup requires a strict directory and changed library or same-library instance blocks sticky',async()=>{
 const first=bootHarness({explicit:id(1),directory:()=>null});await first.boot();
 assert.deepEqual(first.calls.filter(x=>x[0]==='select'),[]);assert.equal(first.env.auth,'error');assert.equal(first.env.preferenceScope!.current,null);
 for(const replacement of [projectEntryFixture(projects,{appLibraryScope:otherScope}),projectEntryFixture(projects,{instanceId:id(8)})]){
  let value=projectEntryFixture(projects);const changed=bootHarness({explicit:id(1),directory:()=>value});await changed.boot();
  assert.equal(changed.env.projectSessionReady(),true);const before=changed.calls.filter(x=>x[0]==='select').length;
  value=replacement;await changed.boot();assert.equal(changed.env.auth,'error');assert.equal(changed.env.preferenceScope!.current,null);
  assert.equal(changed.env.projectEntryIdentityRef.current.getState().identityBlocked,true);assert.equal(changed.calls.filter(x=>x[0]==='select').length,before);
  value=projectEntryFixture(projects);await changed.boot();assert.equal(changed.env.auth,'error');assert.equal(changed.env.preferenceScope!.current,null);
  assert.equal(changed.calls.filter(x=>x[0]==='select').length,before);
 }
});

function storage(){const map=new Map<string, string>();return{getItem:(k: string)=>map.get(k)??null,setItem:(k: string,v: string)=>map.set(k,v),removeItem:(k: string)=>map.delete(k),map};}
const response=(data: { projectId: string; revision: number; state: null; })=>({ok:true,status:200,json:async()=>({ok:true,data})} as Response);
test('App verified preference scope excludes foreign same-UUID and legacy bare-cache imports',async t=>{
 const local=storage(),legacy=defaultWorkspaceState();legacy.activeMode='editing';legacy.editing.playhead=117;writeWorkspaceState(id(1),legacy,local);writeWorkspaceState(`normal:${otherScope}:${id(1)}`,legacy,local);
 for(const verified of [null,scope]){
  const writes: unknown[]=[];const prefs=createWorkspacePreferences({storage:local,getStorageScope:()=>verified,fetchImpl:async(_url,init)=>{writes.push((init)!.method);return response({projectId:id(1),revision:0,state:null});}});t.after(()=>prefs.dispose({flush:false}));
  const loaded=await prefs.load(id(1));assert.equal((loaded)!.activeMode,'canvas');assert.equal((loaded)!.editing.playhead,0);await prefs.flush();assert.deepEqual(writes,['GET']);
 }
 assert.equal(preferenceCacheIdentity(id(1),null).cacheId,null);assert.notEqual(preferenceCacheIdentity(id(1),scope).entryScope,preferenceCacheIdentity(id(1),otherScope).entryScope);
});
test('same verified workspace can reuse its bounded cache, while unverified offline fallback cannot',async t=>{
 const local=storage(),saved=defaultWorkspaceState();saved.activeMode='editing';saved.editing.playhead=57;writeWorkspaceState(`normal:${scope}:${id(1)}`,saved,local);
 for(const [verified,expected] of [[null,0],[scope,57]] as const){const prefs=createWorkspacePreferences({storage:local,getStorageScope:()=>verified,fetchImpl:async()=>{throw Error('offline');}});t.after(()=>prefs.dispose({flush:false}));assert.equal(((await prefs.load(id(1))))!.editing.playhead,expected);assert.equal((prefs.getStatus(id(1)))!.phase,'local');}
});
test('a new boot without verified scope cannot flush queued previous-scope view edits into the new connection',async t=>{
 let verified: string | null=scope;const requests: unknown[]=[];const prefs=createWorkspacePreferences({getStorageScope:()=>verified,delayMs:60_000,maxWaitMs:60_000,fetchImpl:async(_url,init)=>{requests.push((init)!.method);return response({projectId:id(1),revision:0,state:null});}});t.after(()=>prefs.dispose({flush:false}));
 const state=await prefs.load(id(1));(state)!.editing.playhead=80;prefs.update(id(1),state);verified=null;await prefs.flush();assert.deepEqual(requests,['GET']);
 assert.equal(((await prefs.load(id(1))))!.editing.playhead,0);await prefs.flush();assert.deepEqual(requests,['GET','GET']);
});
test('same-session directory mismatch disables previous workspace cache and queued preference writes immediately',async t=>{
 for(const replacement of [projectEntryFixture(projects,{appLibraryScope:otherScope}),projectEntryFixture(projects,{instanceId:id(8)})]){
  let remote=projectEntryFixture(projects);const owner=projectEntryOwnerFixture(()=>remote);t.after(()=>owner.dispose());await readProjectEntryIdentity(owner);
  const local=storage(),saved=defaultWorkspaceState();saved.activeMode='editing';saved.editing.playhead=57;writeWorkspaceState(`normal:${scope}:${id(1)}`,saved,local);
  const requests: unknown[]=[];const prefs=createWorkspacePreferences({storage:local,getStorageScope:owner.getVerifiedScope,delayMs:60_000,maxWaitMs:60_000,fetchImpl:async(_url,init)=>{requests.push(init!.method);return response({projectId:id(1),revision:0,state:null});}});t.after(()=>prefs.dispose({flush:false}));
  assert.equal((await prefs.load(id(1)))!.editing.playhead,57);const draft=defaultWorkspaceState();draft.editing.playhead=83;prefs.update(id(1),draft);
  remote=replacement;await owner.refresh();assert.equal(owner.getState().identityBlocked,true);
  await prefs.flush();assert.deepEqual(requests,['GET']);assert.equal((await prefs.load(id(1)))!.editing.playhead,0);await prefs.flush();assert.deepEqual(requests,['GET','GET']);
  remote=projectEntryFixture(projects);owner.dispose();owner.activate();await owner.refresh();assert.equal(owner.getVerifiedScope(),null);
  assert.equal(preferenceCacheIdentity(id(1),scope).cacheId,`normal:${scope}:${id(1)}`);
 }
});
