import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {startServer} from '../apps/server/src/index.ts';
import {stageProjectExampleResources} from '../packages/business/src/project-example-resources.ts';
import {createProjectEntryDesktopHost} from '../apps/desktop/src/project-entry-desktop-host.ts';
import type {ProjectEntryDesktopOwner} from '../apps/desktop/src/project-entry-desktop-host.ts';
import {createProjectEntriesDesktopBridge} from '../apps/desktop/src/project-entry-desktop-preload.ts';
import {readProjectEntryDesktopClient} from '../apps/web/src/project-entry-desktop-client.ts';
import {createProjectEntryControlBroker, createProjectEntryControlClient} from '../apps/desktop/src/project-entry-control.ts';
import {parseProjectEntryControlResult, projectEntryControlCommandSchema} from '../packages/contracts/src/project-entry-control.ts';
import {PROJECT_ENTRY_DESKTOP_LIMITS, projectEntryDesktopRequestSchema} from '../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectDesktopSelection, ProjectLocationFacts} from '../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntryControlPort} from '../packages/contracts/src/project-entry-native.ts';
import type {ProjectCopyResponse, ProjectTemplateInput} from '../packages/contracts/src/project-copies.ts';

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
}
async function fixture(t:TestContext,options:Options={}){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-template-entry-')),installed=path.join(root,'examples'),target=path.join(root,'target');mkdirSync(target);
 if(options.installed!==false)await stageProjectExampleResources(resourceRoot,installed);
 if(options.corruptResources){const copied=path.join(installed,'timeline-basics','media','overlay-star.png');chmodSync(copied,0o600);writeFileSync(copied,'Changed installed resource');}
 const server=await startServer({dataDir:path.join(root,'app'),projectTemplatesDir:installed,port:0,token:'synthetic-template-bridge'});
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
  probeLocation:async input=>{probes.push(input);return facts;},admitLocation:async()=>true,
  adoptPrepared:async()=>{adoptions++;return{ok:false,targetWindowId:null,reason:'not-opened'};},openRecent:async()=>assert.fail('An instance is not implicitly opened'),
 });
 const bridge=createProjectEntriesDesktopBridge((_channel,input)=>host.handle('owner',input));
 t.after(async()=>{host.close();client.close();broker.close();await server.close();rmSync(root,{recursive:true,force:true});});
 async function choose(name='Example'):Promise<ProjectDesktopSelection>{const result=await bridge.chooseLocation({purpose:'template',suggestedName:name,message:'Creates a new project folder with its own media.'});assert.ok(result);return result;}
 const input=(selection:ProjectDesktopSelection)=>{assert.ok(selection.template);return{token:selection.token,templateId:selection.template.id,templateVersion:selection.template.version,name:selection.template.name,requestId:randomUUID()};};
 return {root,target,installed,server,host,bridge,client,inputs,probes,choose,input,get chooserCalls(){return chooserCalls;},get adoptions(){return adoptions;},replaceDocument(){contextId=randomUUID();},replaceBackend(){ownerBackendId=randomUUID();},closeOwner(){active=false;}};
}

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
  if(kind==='owner')await assert.rejects(f.host.dispatch('other',{action:'instantiateTemplate',...body}));
  else if(kind==='backend'){f.replaceBackend();await assert.rejects(f.bridge.instantiateTemplate!(body));}
  else if(kind==='token')await assert.rejects(f.bridge.instantiateTemplate!({...body,token:randomUUID()}));
  else if(kind==='expiry'){const now=Date.now();t.mock.method(Date,'now',()=>now+PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs+1);await assert.rejects(f.bridge.instantiateTemplate!(body));t.mock.restoreAll();}
  else if(kind==='purpose'){const wrong=await f.bridge.chooseLocation({purpose:'duplicate',suggestedName:'Wrong',message:''});assert.ok(wrong);await assert.rejects(f.bridge.instantiateTemplate!({...body,token:wrong.token}));}
  else {f.replaceDocument();await assert.rejects(f.bridge.instantiateTemplate!(body));}
  assert.deepEqual(f.inputs,[]);assert.deepEqual(readdirSync(f.target),[]);assert.deepEqual((await f.client.api.listRecent()).registered,[]);
 });
});

test('existing selected files and target folders are not overwritten or registered',async t=>{
 const f=await fixture(t);writeFileSync(path.join(f.target,'Occupied.mioon'),'Existing selected file');
 await assert.rejects(f.choose('Occupied'),{code:'PROJECT_FILE_EXISTS'});assert.equal(readFileSync(path.join(f.target,'Occupied.mioon'),'utf8'),'Existing selected file');assert.deepEqual(f.inputs,[]);
 const selected=await f.choose('Folder');mkdirSync(path.join(f.target,'Folder'));writeFileSync(path.join(f.target,'Folder','keep'),'Existing directory');const before=files(f.target);
 await assert.rejects(f.bridge.instantiateTemplate!(f.input(selected)),{code:'PROJECT_FILE_EXISTS'});assert.deepEqual(files(f.target),before);assert.deepEqual((await f.client.api.listRecent()).registered,[]);
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
