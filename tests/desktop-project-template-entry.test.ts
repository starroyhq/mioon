import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {startServer, type ServerOptions} from './helpers/test-server.ts';
import {stageProjectExampleResources} from '../packages/business/src/project-example-resources.ts';
import {createProjectEntryDesktopHost} from '../apps/desktop/src/project-entry-desktop-host.ts';
import type {ProjectEntryDesktopOwner} from '../apps/desktop/src/project-entry-desktop-host.ts';
import {createProjectEntriesDesktopBridge} from '../apps/desktop/src/project-entry-desktop-preload.ts';
import {readProjectEntryDesktopClient} from '../apps/web/src/project-entry-desktop-client.ts';
import {createProjectHomeNativeActionsController} from '../apps/web/src/project-home-native-actions-state.ts';
import {createProjectEntryControlBroker, createProjectEntryControlClient} from '../apps/desktop/src/project-entry-control.ts';
import {parseProjectEntryControlResult, projectEntryControlCommandSchema} from '../packages/contracts/src/project-entry-control.ts';
import {PROJECT_ENTRY_DESKTOP_LIMITS, projectEntryDesktopRequestSchema} from '../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectDesktopSelection, ProjectLocationFacts} from '../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntryControlPort} from '../packages/contracts/src/project-entry-native.ts';
import type {ProjectCopyResponse, ProjectTemplateInput} from '../packages/contracts/src/project-copies.ts';
import {createProjectWindowHost} from '../apps/desktop/src/project-window-host.ts';
import type {ProjectWindowCreation, ProjectWindowWebContents} from '../apps/desktop/src/project-window-host.ts';
import {createProjectWindowBridge} from '../apps/desktop/src/project-window-preload.ts';
import {createProjectEntryController} from '../apps/web/src/project-entry-state.ts';
import type {ProjectEntryConsumption} from '../apps/web/src/project-entry-state.ts';
import {createProjectEntryIdentityOwner, readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import {createLauncherClient} from '../apps/web/src/launcher-state.ts';
import {evaluateSource, extractBetween} from './helpers/eval-source.ts';

const resourceRoot=fileURLToPath(new URL('../examples/project-file-v1/',import.meta.url));
const facts:ProjectLocationFacts={fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'};
const held=<T>()=>Promise.withResolvers<T>();

test('preload and web adapters keep template selection metadata exclusive to the template purpose',async()=>{
 const ordinary={token:randomUUID(),displayPath:'/synthetic/selected',facts},template={id:'timeline-basics' as const,version:1 as const,name:'Example'};
 for(const endpoint of ['preload','web'] as const){
  let response:unknown=ordinary;
  const bridge=endpoint==='preload'?createProjectEntriesDesktopBridge(async(_channel,input)=>{assert.equal((input as {action:string}).action,'chooseLocation');return{ok:true,data:response};}):readProjectEntryDesktopClient({__mioonProjectEntries:{capabilities:async()=>assert.fail('No capability read in a response-shape check'),chooseLocation:async()=>response}})!;
  assert.ok(bridge);
  for(const purpose of ['create','duplicate','copy-to','save-as'] as const){
   const input={purpose,suggestedName:'Example',message:''};response=ordinary;assert.deepEqual(await bridge.chooseLocation(input),ordinary,`${endpoint}/${purpose}: original valid shape`);
   response={...ordinary,template};await assert.rejects(bridge.chooseLocation(input),`${endpoint}/${purpose}: template metadata is an extra field`);
   response={...ordinary,template:undefined};await assert.rejects(bridge.chooseLocation(input),`${endpoint}/${purpose}: an explicit undefined key is still extra`);
   response=null;assert.equal(await bridge.chooseLocation(input),null,`${endpoint}/${purpose}: cancellation stays valid`);
  }
  const input={purpose:'template' as const,suggestedName:'Example',message:''};response=ordinary;await assert.rejects(bridge.chooseLocation(input),`${endpoint}: missing template metadata`);
  response={...ordinary,template:undefined};await assert.rejects(bridge.chooseLocation(input),`${endpoint}: undefined template metadata`);
  response={...ordinary,template};assert.deepEqual(await bridge.chooseLocation(input),response,`${endpoint}: complete template selection`);
  response={...ordinary,template,unexpected:true};await assert.rejects(bridge.chooseLocation(input),`${endpoint}: other extra fields stay forbidden`);
  response=null;assert.equal(await bridge.chooseLocation(input),null,`${endpoint}: template cancellation stays valid`);
 }
});
function files(root:string):Record<string,string>{
 return Object.fromEntries(readdirSync(root,{recursive:true}).map(String).sort().flatMap(relative=>{
  const file=path.join(root,relative),info=lstatSync(file);return info.isFile()?[[relative,createHash('sha256').update(readFileSync(file)).digest('hex')]]:[];
 }));
}
interface Options {
 readonly installed?:boolean;
 readonly wrap?:(port:ProjectEntryControlPort)=>ProjectEntryControlPort;
 readonly choose?:(name:string)=>Promise<string|null>;
 readonly corruptReply?:boolean;
  readonly corruptResources?:boolean;
 readonly admit?:()=>Promise<boolean>;
 readonly onCopyBoundary?:ServerOptions['projectCopyActionBoundaryForTest'];
}
async function fixture(t:TestContext,options:Options={}){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-template-entry-')),installed=path.join(root,'examples'),target=path.join(root,'target');mkdirSync(target);
 if(options.installed!==false)await stageProjectExampleResources(resourceRoot,installed);
 if(options.corruptResources){const copied=path.join(installed,'timeline-basics','media','overlay-star.png');chmodSync(copied,0o600);writeFileSync(copied,'Changed installed resource');}
 const server=await startServer({dataDir:path.join(root,'app'),projectTemplatesDir:installed,port:0,token:'synthetic-template-bridge',
  ...(options.onCopyBoundary ? {projectCopyActionBoundaryForTest:options.onCopyBoundary} : {})});
 const backendId=randomUUID(),windowId=randomUUID(),window={},otherWindow={},inputs:ProjectTemplateInput[]=[],probes:{path:string;purpose:string;isDirectory:boolean}[]=[],operations=new Map<string,string>();
 let contextId=randomUUID(),ownerBackendId=backendId,active=true,chooserCalls=0,adoptions=0,client!:ReturnType<typeof createProjectEntryControlClient>;
 const original=server.projectEntries.instantiateTemplate!;
 const counted:ProjectEntryControlPort={...server.projectEntries,instantiateTemplate:async input=>{inputs.push(structuredClone(input));return original(input);}};
 const broker=createProjectEntryControlBroker({backendId,control:options.wrap?.(counted)??counted,send:raw=>{
  let value=raw;
  if(options.corruptReply&&raw&&typeof raw==='object'&&'requestId'in raw&&'ok'in raw&&raw.ok===true&&'data'in raw&&operations.get(String(raw.requestId))==='instantiateTemplate'){
   value={...raw,data:{...(raw.data as ProjectCopyResponse),requestId:randomUUID()}};
  }
  queueMicrotask(()=>client.handle(value));
 }});
 client=createProjectEntryControlClient({backendId,send:raw=>{
  if(raw&&typeof raw==='object'&&'requestId'in raw&&'command'in raw)operations.set(String(raw.requestId),(raw.command as {operation:string}).operation);
  queueMicrotask(()=>broker.handle(raw));
 }});
 const owner=(other=false):ProjectEntryDesktopOwner=>{const captured=contextId;return{window:other?otherWindow:window,windowId:other?'77000000-0000-4000-8000-000000000050':windowId,backendId:ownerBackendId,contextId:captured,isCurrent:()=>active&&contextId===captured};};
 const host=createProjectEntryDesktopHost({ownerForEvent:(event:string)=>event==='owner'?owner():event==='other'?owner(true):null,backend:client.api,isReady:()=>true,
  chooseDirectory:async()=>assert.fail('Templates use the save panel'),chooseOpenFile:async()=>assert.fail('No open file in template flow'),
  chooseSaveFile:async(_owner,input)=>{chooserCalls++;return options.choose?options.choose(input.suggestedName):path.join(target,input.suggestedName+'.mioon');},
  probeLocation:async input=>{probes.push(input);return facts;},admitLocation:options.admit??(async()=>true),
  adoptPrepared:async()=>{adoptions++;return{ok:false,targetWindowId:null,reason:'not-opened'};},openRecent:async()=>assert.fail('An instance is not implicitly opened'),
 });
 const bridge=createProjectEntriesDesktopBridge((_channel,input)=>host.handle('owner',input));
 t.after(async()=>{host.close();client.close();broker.close();await server.close();rmSync(root,{recursive:true,force:true});});
 async function choose(name='Example'):Promise<ProjectDesktopSelection>{const result=await bridge.chooseLocation({purpose:'template',suggestedName:name,message:'Creates a new project folder with its own media.'});assert.ok(result);return result;}
 const input=(selection:ProjectDesktopSelection)=>{assert.ok(selection.template);return{token:selection.token,templateId:selection.template.id,templateVersion:selection.template.version,name:selection.template.name,requestId:randomUUID()};};
 return {root,target,installed,server,host,bridge,client,inputs,probes,choose,input,get chooserCalls(){return chooserCalls;},get adoptions(){return adoptions;},replaceDocument(){contextId=randomUUID();},replaceBackend(){ownerBackendId=randomUUID();},closeOwner(){active=false;}};
}

/** Native window surfaces only; document ownership, dialog leases and sealed
 * project admission continue to run in the production window host. */
class TemplatePanelWindow extends EventEmitter {
 readonly webContents:EventEmitter&{mainFrame:{url:string};getURL():string;send(channel:string,value:unknown):void}=Object.assign(new EventEmitter(),{
  mainFrame:{url:'about:blank'},getURL:():string=>this.webContents.mainFrame.url,
  send:(channel:string,value:unknown):void=>{this.webContents.emit(channel,{},value);},
 });
 private destroyed=false;
 readonly creation:ProjectWindowCreation<TemplatePanelWindow>;
 constructor(creation:ProjectWindowCreation<TemplatePanelWindow>){super();this.creation=creation;}
 isDestroyed(){return this.destroyed;}
 isMinimized(){return false;}
 restore(){}
 show(){}
 showInactive(){}
 hide(){}
 focus(){}
 close(){if(!this.destroyed){this.destroyed=true;this.emit('closed');}}
 async loadURL(url:string){
  this.webContents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url});
  this.webContents.mainFrame={url};this.webContents.emit('did-navigate',{},url);this.emit('ready-to-show');
 }
}

async function mainTemplatePanelFixture(t:TestContext,role:'launcher'|'editor'){
 const f=await fixture(t),backendId=randomUUID(),windows:TemplatePanelWindow[]=[],consumed:string[]=[],order:string[]=[];
 const documents=path.join(f.root,'Library','Mobile Documents','com~apple~CloudDocs','Documents');mkdirSync(documents,{recursive:true});
 let entry:ReturnType<typeof createProjectEntryController>|null=null;
 let source:TemplatePanelWindow;
 const expectedWindows=new Map<string,(window:TemplatePanelWindow)=>void>();
 const windowHost:ReturnType<typeof createProjectWindowHost<TemplatePanelWindow>>=createProjectWindowHost<TemplatePanelWindow>({backendId,launcherUrl:'http://127.0.0.1:4321/',editorUrl:id=>`http://127.0.0.1:4321/?project=${id}`,
  isCurrent:()=>true,canInteract:()=>true,projectEntries:f.client.api,
  createWindow:creation=>{
   const window=new TemplatePanelWindow(creation);windows.push(window);
   if(creation.projectId){expectedWindows.get(creation.projectId)?.(window);expectedWindows.delete(creation.projectId);}
   return window;
  },
  consumeProjectEntry:(owner,token,projectId):ProjectEntryConsumption=>{
   assert.equal(owner.window,source);assert.ok(entry);const receipt=entry.consume(token,projectId);
   assert.equal(receipt.accepted,true,'Only the actual sealed renderer permit admits a new editor');consumed.push(token);return receipt;
  },
  admitProject:async(_owner,id)=>(await f.client.api.prepareAcquire({projectId:id})).projectFile,
 });
 const launcher=windowHost.ensureLauncher();assert.ok(launcher);await windowHost.loadFor(launcher);
 source=launcher;
 if(role==='editor'){
  const original=await f.server.projectEntries.create({name:'Original',projectFile:path.join(f.root,'Original.mioon')});
  assert.equal((await windowHost.adoptPrepared(await f.client.api.acquire({projectId:original.projectId,windowId:randomUUID(),expectedProjectFile:original.projectFile}))).ok,true);
  source=windows.at(-1)!;await windowHost.loadFor(source);
  assert.equal(windowHost.dispatch({sender:source.webContents,senderFrame:source.webContents.mainFrame},{action:'editor-status',contextId:windowHost.contextFor(source)!.contextId,projectId:original.projectId,phase:'ready'}),true);
 }
 const main=readFileSync(new URL('../apps/desktop/src/main.ts',import.meta.url),'utf8'),dialogs=new Set<{window:TemplatePanelWindow}>(),panelCalls:{parent:TemplatePanelWindow;defaultPath:string;message:string}[]=[];
 const startup={signal:new AbortController().signal},ready={},session={},context={startup,ready,session};
 const scope={windowHost,ownedWindowHost:windowHost,context,windowContext:context,startupOperation:startup,ready,activeSession:session,
  quitting:false,restarting:false,trayHost:null,windowAdmissions:new WeakMap(),nativeDialogs:dialogs,
  ownedBackend:{projectEntries:f.client.api},createProjectEntryDesktopHost,
  nativeBackendCurrent:()=>{assert.equal(startup.signal.aborted,false);},refreshApplicationMenu:()=>{},
  app:{getPath:(kind:string)=>{assert.equal(kind,'documents');order.push('documents');return documents;}},
  path,nt:(key:string)=>key,
  dialog:{showSaveDialog:async(parent:TemplatePanelWindow,input:{defaultPath:string;message:string;properties:string[]})=>{
   assert.equal(parent,source);assert.equal(dialogs.size,1);assert.equal(windowHost.canHideToTray(),false,'The actual window-host native-dialog lease is held');
   assert.deepEqual(input.properties,['showOverwriteConfirmation','createDirectory']);panelCalls.push({parent,defaultPath:input.defaultPath,message:input.message});order.push('save');
   return {canceled:false,filePath:input.defaultPath};
  },showMessageBox:async(parent:TemplatePanelWindow)=>{assert.equal(parent,source);assert.equal(dialogs.size,1);assert.equal(windowHost.canHideToTray(),false);order.push('cloud-warning');return {response:0};}},
  probeDesktopProjectLocation:async(input:{path:string;purpose:string;isDirectory:boolean})=>{
   assert.equal(dialogs.size,0,'The save sheet lease is released before observing the selected parent');
   assert.equal(windowHost.canHideToTray(),true);assert.deepEqual(input,{path:documents,purpose:'template',isDirectory:true});order.push('probe');return {...facts,cloud:'known-icloud'};
  },
  locationHelp:{openPrivacySettings:()=>assert.fail('No privacy navigation'),revealVerifiedPath:()=>assert.fail('No Finder reveal')},
 };
 const code=extractBetween(main,'function finishNativePresentation(','async function chooseOwnedBackupFile(')
  +extractBetween(main,'function ownsWindowContext(','async function openWindow(')
  +extractBetween(main,'    const nativeOwner=','    const locationHelp=')
  +extractBetween(main,'    const entries=projectEntryHost=','    ownedRelinkHost=assetRelinkHost=');
 const native=evaluateSource<ReturnType<typeof createProjectEntryDesktopHost<{sender:ProjectWindowWebContents;senderFrame:ProjectWindowWebContents['mainFrame']},TemplatePanelWindow>>>(
  'let trayIntent=0,projectEntryHost;'+code+';return entries;',Object.keys(scope),Object.values(scope),{loader:'ts'});
 const event=()=>({sender:source.webContents,senderFrame:source.webContents.mainFrame});
 const desktop=readProjectEntryDesktopClient({__mioonProjectEntries:createProjectEntriesDesktopBridge((_channel,input)=>native.handle(event(),input))});assert.ok(desktop);
 const bridge=createProjectWindowBridge({invoke:async(_channel,input)=>windowHost.dispatch(event(),input),
  on:(channel,listener)=>{source.webContents.on(channel,listener);},removeListener:(channel,listener)=>{source.webContents.removeListener(channel,listener);}});
 const identity=createProjectEntryIdentityOwner({read:()=>desktop.listRecent()});identity.activate();
 entry=createProjectEntryController({context:await bridge.context(),bridge,identity,manageIdentityLifecycle:false,desktopClient:desktop,
  client:createLauncherClient(async()=>assert.fail('No legacy create or open RPC'),{parseCreateInput:value=>value,readDirectory:()=>readProjectEntryIdentity(identity)}),confirm:async()=>true});
 entry.activate();const release=bridge.subscribe(value=>entry?.updateContext(value));await entry.boot();if(role==='editor'){assert.equal(await entry.show('open'),true);await entry.refresh();}
 const dispose=async()=>{release();entry?.dispose();identity.dispose();native.close();windowHost.dispose();await new Promise(setImmediate);};
 const expectWindow=(projectId:string)=>new Promise<TemplatePanelWindow>(resolve=>{expectedWindows.set(projectId,resolve);});
 return {...f,documents,source,windowHost,native,desktop,entry,windows,expectWindow,consumed,dialogs,panelCalls,order,event,dispose};
}

test('real main save-panel wiring creates and sealed-opens the shipped example from launcher and editor with iCloud Documents',async t=>{
 for(const role of ['launcher','editor'] as const)await t.test(role,async t=>{
  const f=await mainTemplatePanelFixture(t,role);
  try{
   const before=files(f.installed),name='時間軸入門',message='Creates a new project folder with its own media.';
   assert.equal(Object.keys(before).length,9,'The real installed catalog contains all nine shipped resources');
   await assert.rejects(f.native.dispatch({sender:f.source.webContents,senderFrame:{url:f.source.webContents.mainFrame.url}},
    {action:'chooseLocation',purpose:'template',suggestedName:name,message}),{code:'PROJECT_ENTRY_UNAVAILABLE'});
   assert.equal(f.panelCalls.length,0,'A same-URL foreign frame cannot request the native panel');
   const grant=await f.entry.prepareHomeNativeDeparture();assert.ok(grant);
   const selection=await f.desktop.chooseLocation({purpose:'template',suggestedName:name,message});assert.ok(selection);
   assert.equal(f.panelCalls.length,1);assert.equal(f.panelCalls[0]!.parent,f.source);assert.equal(f.panelCalls[0]!.defaultPath,path.join(f.documents,name+'.mioon'));assert.equal(f.panelCalls[0]!.message,message);
   assert.deepEqual(f.order,['documents','save','probe','cloud-warning']);assert.equal(f.dialogs.size,0);assert.equal(f.windowHost.canHideToTray(),true);
   assert.equal(selection.displayPath,path.join(f.documents,name,name+'.mioon'));
   const response=await f.desktop.instantiateTemplate!({...f.input(selection),locale:'zh-Hant'});
   assert.equal(f.inputs[0]?.locale,'zh-Hant');
   assert.equal(response.project.projectFile,selection.displayPath);assert.equal(response.project.name,name);
   const candidate=f.expectWindow(response.project.projectId),result=f.entry.openNativeResult(response.project.projectId,grant);
   const opened=await Promise.race([candidate,result.then(()=>assert.fail('Open resolved before creating its candidate editor'))]);assert.ok(opened);await f.windowHost.loadFor(opened);
   const candidateContext=f.windowHost.contextFor(opened)!;assert.equal(candidateContext.editorPhase,'opening');assert.equal(f.entry.getState().sealed,true);
   assert.equal(f.windowHost.dispatch({sender:opened.webContents,senderFrame:opened.webContents.mainFrame},
    {action:'editor-status',contextId:candidateContext.contextId,projectId:response.project.projectId,phase:'ready'}),true);
   assert.equal(await result,true);
   assert.equal(f.consumed.length,1,'Opening consumes the real entry controller seal exactly once');
   assert.equal(f.windows.find(window=>window.creation.projectId===response.project.projectId),opened);
   assert.equal(f.windowHost.contextFor(opened)!.editorProjectId,response.project.projectId);
   assert.equal(f.entry.getState().sealed,false);assert.equal(f.entry.getState().openUnknown,false);
   const instance=files(path.dirname(selection.displayPath));
   for(const [relative,hash] of Object.entries(before).filter(([relative])=>relative.startsWith('timeline-basics/media/'))){
    assert.equal(instance[relative.slice('timeline-basics/'.length)],hash,'Every published media byte matches the shipped example');
   }
   const registered=(await f.client.api.listRecent()).registered;
   assert.equal(registered.filter(value=>value.project.projectId===response.project.projectId).length,1);
   assert.deepEqual(files(f.installed),before,'Instantiation cannot modify packaged example bytes');
   await assert.rejects(f.desktop.chooseLocation({purpose:'template',suggestedName:name,message}),{code:'PROJECT_FILE_EXISTS'});
   assert.equal(f.panelCalls.length,2);assert.equal(f.inputs.length,1);assert.deepEqual(files(path.dirname(selection.displayPath)),instance);
   assert.equal((await f.client.api.listRecent()).registered.length,registered.length,'Selecting the same destination never registers or overwrites another instance');

   // A confirmed native overwrite sheet returns the occupied file path.
   const chosenFile = f.panelCalls[0]!.defaultPath;
   writeFileSync(chosenFile, 'Existing save-panel file', {flag:'wx'});
   await assert.rejects(f.desktop.chooseLocation({purpose:'template',suggestedName:name,message}),{code:'PROJECT_FILE_EXISTS'});
   assert.equal(f.panelCalls.length,3);assert.equal(f.inputs.length,1);
   assert.equal(readFileSync(chosenFile,'utf8'),'Existing save-panel file');
   assert.deepEqual(files(path.dirname(selection.displayPath)),instance);
   assert.equal((await f.client.api.listRecent()).registered.length,registered.length);
  }finally{await f.dispose();}
 });
});

test('only verified installed fixed examples are advertised; missing resources do not open a panel or create anything',async t=>{
 for(const installed of [true,false])await t.test(String(installed),async t=>{
  const f=await fixture(t,{installed}),caps=await f.bridge.capabilities();
  assert.deepEqual(caps.templates,installed?[{id:'timeline-basics',version:1}]:undefined);
  if(!installed){await assert.rejects(f.choose(),{code:'PROJECT_TEMPLATE_NOT_FOUND'});assert.equal(f.chooserCalls,0);assert.deepEqual(f.inputs,[]);assert.deepEqual(readdirSync(f.target),[]);}
 });
});

test('corrupted installed resource bytes do not advertise or dispatch a template capability',async t=>{
 const f=await fixture(t,{corruptResources:true});assert.equal((await f.bridge.capabilities()).templates,undefined);await assert.rejects(f.choose(),{code:'PROJECT_TEMPLATE_NOT_FOUND'});assert.equal(f.chooserCalls,0);assert.deepEqual(f.inputs,[]);assert.deepEqual(readdirSync(f.target),[]);
});

test('save-panel cancellation and an answer from a retired document have zero template effects',async t=>{
 await t.test('cancel',async t=>{
  const f=await fixture(t,{choose:async()=>null}),before=files(f.installed);
  assert.equal(await f.bridge.chooseLocation({purpose:'template',suggestedName:'Cancelled',message:''}),null);
  assert.deepEqual(f.inputs,[]);assert.deepEqual(f.probes,[]);assert.deepEqual(readdirSync(f.target),[]);assert.deepEqual(files(f.installed),before);assert.deepEqual((await f.client.api.listRecent()).registered,[]);
 });
 await t.test('old document',async t=>{
  const gate=held<string|null>(),f=await fixture(t,{choose:()=>gate.promise});
  const pending=f.choose();while(f.chooserCalls===0)await new Promise(setImmediate);
  f.replaceDocument();gate.resolve(path.join(f.target,'Late.mioon'));await assert.rejects(pending);
  assert.deepEqual(f.inputs,[]);assert.deepEqual(f.probes,[]);assert.deepEqual(readdirSync(f.target),[]);
 });
});

test('main binds the selected name and actual dedicated folder; exact replay creates one instance and two explicit selections are independent',async t=>{
 const f=await fixture(t),before=files(f.installed),a=await f.choose('First'),firstInput=f.input(a);
 assert.deepEqual(a.template,{id:'timeline-basics',version:1,name:'First'});assert.equal(a.displayPath,path.join(f.target,'First','First.mioon'));
 assert.deepEqual(f.probes,[{path:f.target,purpose:'template',isDirectory:true}]);
 const first=await f.bridge.instantiateTemplate!(firstInput);assert.equal(first.requestId,firstInput.requestId);assert.equal(first.project.projectFile,a.displayPath);assert.equal(first.project.name,'First');
 assert.deepEqual(f.inputs,[{templateId:'timeline-basics',templateVersion:1,parentDir:f.target,name:'First',requestId:firstInput.requestId}]);
 assert.deepEqual(await f.bridge.instantiateTemplate!(firstInput),first);assert.equal(f.inputs.length,1);
 await assert.rejects(f.bridge.instantiateTemplate!({...firstInput,requestId:randomUUID()}),{code:'PROJECT_ENTRY_REQUEST_CONFLICT'});assert.equal(f.inputs.length,1);
 const b=await f.choose('Second'),second=await f.bridge.instantiateTemplate!(f.input(b));assert.notEqual(first.project.projectId,second.project.projectId);assert.equal(second.project.projectFile,b.displayPath);
 const firstFiles=files(path.dirname(first.project.projectFile)),secondFiles=files(path.dirname(second.project.projectFile));
 assert.ok(Object.keys(firstFiles).length>=5);assert.ok(Object.keys(secondFiles).length>=5);assert.deepEqual(files(f.installed),before);assert.equal(f.adoptions,0);
 const firstMedia=Object.fromEntries(Object.entries(firstFiles).filter(([name])=>!name.endsWith('.mioon'))),secondMedia=Object.fromEntries(Object.entries(secondFiles).filter(([name])=>!name.endsWith('.mioon')));
 assert.deepEqual(firstMedia,secondMedia);assert.equal(Object.keys(firstMedia).length,4);
 const mediaName=Object.keys(firstMedia)[0]!;writeFileSync(path.join(path.dirname(first.project.projectFile),mediaName),'Changed only the first instance');
 assert.deepEqual(files(path.dirname(second.project.projectFile)),secondFiles);assert.deepEqual(files(f.installed),before);
});

test('a save-panel rename is authoritative display data; renderer names and paths cannot redirect its template token',async t=>{
 let picked='';const f=await fixture(t,{choose:async()=>picked});picked=path.join(f.target,'Panel choice.mioon');
 const selected=await f.choose('Suggested');assert.equal(selected.template?.name,'Panel choice');assert.equal(selected.displayPath,path.join(f.target,'Panel choice','Panel choice.mioon'));
 const body=f.input(selected);await assert.rejects(f.host.dispatch('owner',{action:'instantiateTemplate',...body,parentDir:'/renderer/forged'}));
 await assert.rejects(f.host.dispatch('owner',{action:'instantiateTemplate',...body,templateFile:'/renderer/template.mioon'}));assert.equal(f.inputs.length,0);
 await assert.rejects(f.bridge.instantiateTemplate!({...body,name:'Renderer name'}));assert.equal(f.inputs.length,0);assert.deepEqual(readdirSync(f.target),[]);
});

test('a POSIX parent containing a literal backslash keeps its native path through the complete template bridge',async t=>{
 let picked='';const f=await fixture(t,{choose:async()=>picked}),parent=path.join(f.target,'back\\slash');mkdirSync(parent);picked=path.join(parent,'Example.mioon');
 const chosen=await f.choose(),response=await f.bridge.instantiateTemplate!(f.input(chosen));
 assert.equal(f.inputs[0]!.parentDir,parent);assert.equal(response.project.projectFile,path.join(parent,'Example','Example.mioon'));assert.equal(response.project.projectFile,chosen.displayPath);assert.ok(existsSync(response.project.projectFile));
});

test('template tokens reject another owner, expired ticket, wrong purpose and retired context before service dispatch',async t=>{
 for(const kind of ['owner','backend','token','expiry','purpose','context'] as const)await t.test(kind,async t=>{
  const f=await fixture(t),selected=await f.choose(),body=f.input(selected);
  const rejected={code:'PROJECT_ENTRY_UNAVAILABLE',status:409};
  const expired={code:'PROJECT_ENTRY_TICKET_EXPIRED',status:409};
  if(kind==='owner')await assert.rejects(f.host.dispatch('other',{action:'instantiateTemplate',...body}),rejected);
  else if(kind==='backend'){f.replaceBackend();await assert.rejects(f.bridge.instantiateTemplate!(body),rejected);}
  else if(kind==='token')await assert.rejects(f.bridge.instantiateTemplate!({...body,token:randomUUID()}),expired);
  else if(kind==='expiry'){const now=Date.now();t.mock.method(Date,'now',()=>now+PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs+1);await assert.rejects(f.bridge.instantiateTemplate!(body),expired);t.mock.restoreAll();}
  else if(kind==='purpose'){const wrong=await f.bridge.chooseLocation({purpose:'duplicate',suggestedName:'Wrong',message:''});assert.ok(wrong);await assert.rejects(f.bridge.instantiateTemplate!({...body,token:wrong.token}),rejected);}
  else {f.replaceDocument();await assert.rejects(f.bridge.instantiateTemplate!(body),rejected);}
  assert.deepEqual(f.inputs,[]);assert.deepEqual(readdirSync(f.target),[]);assert.deepEqual((await f.client.api.listRecent()).registered,[]);
 });
});

test('existing selected files and target folders are not overwritten or registered',async t=>{
 const f=await fixture(t);writeFileSync(path.join(f.target,'Occupied.mioon'),'Existing selected file');
 await assert.rejects(f.choose('Occupied'),{code:'PROJECT_FILE_EXISTS'});assert.equal(readFileSync(path.join(f.target,'Occupied.mioon'),'utf8'),'Existing selected file');assert.deepEqual(f.inputs,[]);
 const selected=await f.choose('Folder');mkdirSync(path.join(f.target,'Folder'));writeFileSync(path.join(f.target,'Folder','keep'),'Existing directory');const before=files(f.target);
 await assert.rejects(f.bridge.instantiateTemplate!(f.input(selected)),{code:'PROJECT_FILE_EXISTS'});assert.deepEqual(files(f.target),before);assert.deepEqual((await f.client.api.listRecent()).registered,[]);
});

test('a template destination occupied during publication keeps its precise refusal through the renderer', async t => {
 for (const phase of ['records-published', 'directory-placeholder'] as const) await t.test(phase, async t => {
  const name = 'Occupied during publication';
  let occupied: string | undefined;
  const f = await fixture(t, {onCopyBoundary(boundary, input) {
   if (boundary !== phase) return;
   assert.ok('parentDir' in input);
   occupied = path.join(input.parentDir, input.name);
   if (phase === 'records-published') mkdirSync(occupied);
   writeFileSync(path.join(occupied, 'keep.txt'), 'Concurrent file', {flag:'wx'});
  }});
  const installed = files(f.installed);
  const desktop = readProjectEntryDesktopClient({__mioonProjectEntries:f.bridge});
  assert.ok(desktop?.instantiateTemplate);
  const directory = await desktop.listRecent();
  const identity = {appLibraryScope:directory.appLibraryScope, instanceId:directory.instanceId, epoch:1};
  let failure: unknown;
  const controller = createProjectHomeNativeActionsController({
   ports: () => ({example:{templates:[{id:'timeline-basics',version:1}],bridge:{
    chooseLocation: desktop.chooseLocation,
    async instantiateTemplate(input) {
     try {return await desktop.instantiateTemplate!(input);}
     catch (error) {failure = error; throw error;}
    },
   }}}),
   owner: () => identity,
   canStart: () => true,
   readDirectory: desktop.listRecent,
   onRefresh: () => assert.fail('A refused creation must not be treated as a verified write'),
   onOpenCreated: () => assert.fail('A refused creation must not open a project'),
  });
  controller.activate();
  t.after(() => controller.dispose());
  assert.equal(await controller.startExample('Storage', name), false);
  assert.equal(f.chooserCalls, 1);
  assert.equal(f.inputs.length, 1);
  assert.equal(occupied, path.join(f.target, name));
  assert.deepEqual(readdirSync(occupied!), ['keep.txt']);
  assert.equal(readFileSync(path.join(occupied!, 'keep.txt'), 'utf8'), 'Concurrent file');
  assert.deepEqual(files(f.installed), installed);
  assert.deepEqual((await desktop.listRecent()).registered, []);
  assert.equal(controller.getState().kind, 'example-blocked');
  assert.equal(controller.getMetadata().unknown, false);
  assert.ok(failure instanceof Error && 'code' in failure && 'status' in failure);
  assert.equal(failure.status, 409);
  assert.deepEqual([failure.code, controller.getState().reason], phase === 'directory-placeholder'
   ? ['PROJECT_COPY_TARGET_CHANGED', 'unavailable'] : ['PROJECT_FILE_EXISTS', 'exists']);
 });
});

test('template location admission precedes target occupancy checks',async t=>{
 const f=await fixture(t,{admit:async()=>false});writeFileSync(path.join(f.target,'Occupied.mioon'),'Existing selected file');
 await assert.rejects(f.choose('Occupied'),{code:'PROJECT_LOCATION_REJECTED'});
 assert.deepEqual(f.probes,[{path:f.target,purpose:'template',isDirectory:true}]);
 assert.equal(readFileSync(path.join(f.target,'Occupied.mioon'),'utf8'),'Existing selected file');assert.deepEqual(f.inputs,[]);
});

test('template chooser rejects every occupied dedicated target before issuing a ticket',async t=>{
 for(const kind of ['directory','file','symlink'] as const)await t.test(kind,async t=>{
  const f=await fixture(t),target=path.join(f.target,'Occupied');
  if(kind==='directory'){mkdirSync(target);writeFileSync(path.join(target,'keep'),'Existing directory');}
  else if(kind==='file')writeFileSync(target,'Existing file');
  else symlinkSync(path.join(f.root,'absent'),target);
  const before=files(f.target);
  await assert.rejects(f.choose('Occupied'),{code:'PROJECT_FILE_EXISTS'});
  assert.deepEqual(f.probes,[{path:f.target,purpose:'template',isDirectory:true}]);assert.deepEqual(files(f.target),before);
  assert.equal(lstatSync(target).isSymbolicLink(),kind==='symlink');assert.deepEqual(f.inputs,[]);assert.deepEqual((await f.client.api.listRecent()).registered,[]);
 });
});

test('template target observation yields and rechecks its owner before signing a ticket',async t=>{
 const f=await fixture(t),selected=path.join(f.target,'Held.mioon'),entered=held<void>(),release=held<void>(),original=fsPromises.lstat;
 const delayed=(async(...args:Parameters<typeof original>)=>{if(args[0]===selected){entered.resolve();await release.promise;}return original(...args);}) as typeof original;
 t.mock.method(fsPromises,'lstat',delayed);syncBuiltinESMExports();
 try{
  const pending=f.choose('Held'),first=await Promise.race([entered.promise.then(()=>'waiting'),pending.then(()=>'issued',()=>'rejected')]);
  assert.equal(first,'waiting','filesystem observation must yield instead of synchronously issuing a ticket');
  f.replaceDocument();release.resolve();await assert.rejects(pending,{code:'PROJECT_ENTRY_UNAVAILABLE'});
  assert.deepEqual(f.inputs,[]);assert.deepEqual(readdirSync(f.target),[]);
 }finally{release.resolve();t.mock.restoreAll();syncBuiltinESMExports();}
});

test('an invalid utility receipt retains the original template request and exact replay never dispatches another instantiation',async t=>{
 const f=await fixture(t,{corruptReply:true}),chosen=await f.choose(),body=f.input(chosen);
 await assert.rejects(f.bridge.instantiateTemplate!(body),{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN'});assert.equal(f.inputs.length,1);assert.equal(f.inputs[0]!.requestId,body.requestId);assert.ok(existsSync(chosen.displayPath));
 await assert.rejects(f.bridge.instantiateTemplate!(body),{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN'});assert.equal(f.inputs.length,1);assert.equal((await f.client.api.listRecent()).registered.length,1);assert.equal(f.adoptions,0);
});

test('a late committed template result cannot publish to a replacement owner or implicitly open a project',async t=>{
 const committed=held<void>(),release=held<void>(),f=await fixture(t,{wrap:port=>({...port,instantiateTemplate:async input=>{const value=await port.instantiateTemplate!(input);committed.resolve();await release.promise;return value;}})});
 const selected=await f.choose(),body=f.input(selected),pending=f.bridge.instantiateTemplate!(body);await committed.promise;f.replaceDocument();release.resolve();
 await assert.rejects(pending,{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN'});assert.equal(f.inputs.length,1);assert.ok(existsSync(selected.displayPath));assert.equal(f.adoptions,0);
 await assert.rejects(f.bridge.instantiateTemplate!(body));assert.equal(f.inputs.length,1);
});

test('template command and response contracts reject arbitrary catalogs, extra paths and mismatched receipt identities',async t=>{
 const f=await fixture(t),selected=await f.choose(),body=f.input(selected),result=await f.bridge.instantiateTemplate!(body),input=f.inputs[0]!;
 assert.equal(projectEntryDesktopRequestSchema.safeParse({action:'instantiateTemplate',...body,templateId:'untrusted'}).success,false);
 assert.equal(projectEntryDesktopRequestSchema.safeParse({action:'instantiateTemplate',...body,templateVersion:2}).success,false);
 for(const extra of [{templateFile:'/source.mioon'},{projectFile:'/forged.mioon'},{assets:[]}])assert.equal(projectEntryControlCommandSchema.safeParse({operation:'instantiateTemplate',input:{...input,...extra}}).success,false);
 const command={operation:'instantiateTemplate' as const,input:{...input,templateId:'timeline-basics' as const,templateVersion:1 as const}};
 assert.deepEqual(parseProjectEntryControlResult(command,result),result);
 for(const bad of [{...result,requestId:randomUUID()},{...result,project:{...result.project,projectFile:path.join(f.target,'Other','Other.mioon')}},{...result,project:{...result.project,name:'Other'}},{...result,sourceProjectId:result.project.projectId}])assert.throws(()=>parseProjectEntryControlResult(command,bad));
});
