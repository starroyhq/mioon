import {putTestAgentConfiguration,testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {defaultTestAgentConfiguration} from './helpers/agent-preset-configurations.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isTimelineFormatReadResponse,isTimelineRecord,TIMELINE_MUTATION_OPERATIONS} from '@mioon/contracts';
import {agentTaskSnapshotSchema,type AgentTaskJson,type AgentTaskSnapshot,type AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import {deriveAgentEndpoint} from '../packages/contracts/src/agent-protocol.ts';
import {projectApiPath,projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {timelineFormatResponseSchema} from '../packages/contracts/src/timeline-format.ts';
import {canvasEditingResponses,createCanvasRequestId} from '../packages/contracts/src/canvas-editing.ts';
import {createTestAgentSettings} from './helpers/secret-codec.ts';
import {PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import type {TaskGateway,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {startServer,type InspectProject} from './helpers/test-server.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {openServerTestStore} from '../packages/business/src/project-file/test-store.ts';
import {FORMAT4_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createMioRuntime} from '../packages/business/src/agent/mio-runtime.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createMioJournal} from '../packages/business/src/agent/mio-journal.ts';
import {mioTestPolicy} from './helpers/mio-runtime-fixture.ts';
import {createMioTestAppPorts} from './helpers/mio-runtime-app-ports.ts';
import {authorizeTestScope} from './helpers/agent-authorizations.ts';
import {readMioProjectImportDependencies} from '../packages/business/src/agent/mio-project-import-dependencies.ts';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function cues(value:unknown):unknown[]{if(value===undefined)return [];assert.ok(object(value)&&Array.isArray(value.cues));return value.cues;}
function output(calls:AgentTaskToolCall[]):TaskModelOutput{
 return {text:calls.length?'':'Subtitles added',toolCalls:calls,providerOutput:calls.length?{role:'assistant',content:null,tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}:{role:'assistant',content:'Subtitles added'}};
}

test('real Mio subtitle undo retains valid locked format history while unknown operations still fail closed',async t=>{
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-format-mio-undo-'));
 const settings=await createTestAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initialSettings=await settings.get();
 await putTestAgentConfiguration(settings,{expectedRevision:initialSettings.revision,configuration:defaultTestAgentConfiguration('chat_completions'),secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_FORMAT_MIO_UNDO_KEY'}});
 let models=0,timelineRevision=0,inspect!:InspectProject;
 const gateway:TaskGateway=async function*(request){
  request.beforeSubmit?.();models++;
  const calls:AgentTaskToolCall[]=models===1?[{id:'load_subtitles',name:'mioon_tools_load',arguments:{names:['mioon_timeline_subtitle_add']}}]:models<=3?[{id:`add_subtitle_${models-1}`,name:'mioon_timeline_subtitle_add',arguments:{expectedRevision:timelineRevision+models-2,startFrame:(models-2)*30,durationFrames:30,text:models===2?'First subtitle':'Second subtitle'}}]:[];
  yield {type:'done',output:output(calls)};
 };
 const server=await startServer({dataDir:root,port:0,agentSettings:settings,taskGatewayV2:gateway,comfyModule:'skip',projectFormatForTest:PROJECT_FILE_SCHEMA_VERSION,inspectProject:received=>{inspect=received;}});
 t.after(async()=>{await server.close();await settings.close();await rm(root,{recursive:true,force:true});});
 async function request(route:string,method='GET',input?:unknown){
  const response=await fetch(server.url+route,{method,headers:{Authorization:`Bearer ${server.token}`,...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});
  const body:unknown=await response.json();assert.ok(object(body));return {status:response.status,body};
 }
 const created=await request('/api/rpc','POST',{operation:'project.create',input:{name:'Mio format undo'}});
 assert.equal(created.status,200,JSON.stringify(created.body));assert.ok(object(created.body.data)&&typeof created.body.data.id==='string');
 const projectId=created.body.data.id,prefix=projectApiPath(projectId,'agent','tasks','v2');
 const rpc=(operation:string,input:unknown)=>request(projectRpcPath(projectId),'POST',{operation,input});
 const pristine=await rpc('timeline.format.get',{projectId});
 assert.equal(pristine.status,200,JSON.stringify(pristine.body));assert.ok(isTimelineFormatReadResponse(pristine.body.data,{projectId}));assert.equal(timelineFormatResponseSchema.parse(pristine.body.data).eligible,true);
 // Give subtitles a valid existing media interval outside Mio; this run owns only the cues.
 const initialized=await rpc('timeline.get',{projectId});
 assert.equal(initialized.status,200,JSON.stringify(initialized.body));assert.ok(isTimelineRecord(initialized.body.data,{projectId}));
 const imported=await rpc('asset.import',{projectId,name:'Synthetic source.png',mimeType:'image/png',dataBase64:png({width:16,height:16,rgba:false,pixel:()=>[255,0,0]}).toString('base64')});
 assert.equal(imported.status,200,JSON.stringify(imported.body));assert.ok(object(imported.body.data)&&typeof imported.body.data.id==='string');const assetId=imported.body.data.id;
 const videoTrack=initialized.body.data.tracks.find(track=>track.kind==='video');assert.ok(videoTrack);
 const populated=await rpc('timeline.clip.add',{projectId,expectedRevision:initialized.body.data.revision,requestId:randomUUID(),assetId,trackId:videoTrack.id,startFrame:0,durationFrames:90});
 assert.equal(populated.status,200,JSON.stringify(populated.body));assert.ok(isTimelineRecord(populated.body.data,{projectId}));timelineRevision=populated.body.data.revision;
 const authorization=await request(prefix);assert.equal(authorization.status,200);assert.ok(object(authorization.body.data)&&object(authorization.body.data.authorization));
 const snapshotSettings=await settings.get(),granted=await request('/api/rpc','POST',{operation:'agent.authorization.grant',input:{requestId:randomUUID(),expectedRevision:authorization.body.data.authorization.revision,expectedSettingsRevision:testAgentExecution(snapshotSettings).revision,destination:deriveAgentEndpoint(testAgentExecution(snapshotSettings).configuration),model:testAgentExecution(snapshotSettings).configuration.model,scope:'project_agent'}});
 assert.equal(granted.status,200,JSON.stringify(granted.body));
 const sent=await request(prefix,'POST',{requestId:randomUUID(),text:'Add two subtitles',expectedSettingsRevision:testAgentExecution(snapshotSettings).revision});
 assert.equal(sent.status,200,JSON.stringify(sent.body));const accepted=agentTaskSnapshotSchema.parse(sent.body.data);
 async function settle():Promise<AgentTaskSnapshot>{
  for(let count=0;count<1000;count++){
   const response=await request(`${prefix}/${accepted.run.id}`);assert.equal(response.status,200,JSON.stringify(response.body));const snapshot=agentTaskSnapshotSchema.parse(response.body.data);
   if(['completed','failed','paused','awaiting_approval'].includes(snapshot.run.status))return snapshot;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Synthetic Mio subtitle run did not settle');
 }
 const completed=await settle();assert.equal(completed.run.status,'completed',JSON.stringify(completed));assert.equal(models,4);
 const added=await rpc('timeline.get',{projectId});assert.equal(added.status,200);assert.ok(isTimelineRecord(added.body.data,{projectId}));
 assert.deepEqual(cues(added.body.data.subtitles).map(cue=>{assert.ok(object(cue));return cue.text;}),['First subtitle','Second subtitle']);
 const undone=await request(`${prefix}/${accepted.run.id}/actions`,'POST',{requestId:randomUUID(),expectedRevision:completed.run.revision,action:'undo_all'});
 assert.equal(undone.status,200,JSON.stringify(undone.body));assert.equal(agentTaskSnapshotSchema.parse(undone.body.data).run.status,'reverted');
 const restored=await rpc('timeline.get',{projectId});assert.equal(restored.status,200);assert.ok(isTimelineRecord(restored.body.data,{projectId}));assert.deepEqual(cues(restored.body.data.subtitles),[]);
 const undoHistory=inspect(projectId,db=>db.prepare("SELECT id,operation FROM timeline_history WHERE projectId=? AND operation='agent.task.undo' ORDER BY position").all(projectId));
 assert.ok(undoHistory.length>0,'the native undo path must have recorded agent.task.undo');
 assert.equal((TIMELINE_MUTATION_OPERATIONS as readonly string[]).includes('agent.task.undo'),false,'Mio compensation is not a client mutation operation');
 const read=await rpc('timeline.format.get',{projectId});
 assert.equal(read.status,200,JSON.stringify(read.body));assert.ok(isTimelineFormatReadResponse(read.body.data,{projectId}));const format=timelineFormatResponseSchema.parse(read.body.data);assert.equal(format.eligible,false);assert.ok(format.blockedReasons.includes('HISTORY_PRESENT'));
 const formatInput={projectId,expectedProjectRevision:format.projectRevision,expectedRevision:format.timelineRevision,requestId:randomUUID(),presetId:'landscape_720'};
 const locked=await rpc('timeline.format.set',formatInput);
 assert.equal(locked.status,409,JSON.stringify(locked.body));assert.ok(object(locked.body.error));assert.equal(locked.body.error.code,'TIMELINE_FORMAT_LOCKED');
 // Only the real backend undo operation is recognized; an unknown saved name stays corruption.
 inspect(projectId,db=>{
  const corrupt=()=>db.prepare('UPDATE timeline_history SET operation=? WHERE id=?').run('agent.task.unrecognized',String(undoHistory[0]!.id));
  assert.throws(corrupt,/immutable/);db.exec('DROP TRIGGER immutable_timeline_history');corrupt();
 });
 for(const [operation,input] of [['timeline.format.get',{projectId}],['timeline.format.set',{...formatInput,requestId:randomUUID()}]] as const){
  const invalid=await rpc(operation,input);assert.equal(invalid.status,409,JSON.stringify(invalid.body));assert.ok(object(invalid.body.error));assert.equal(invalid.body.error.code,'INVALID_TIMELINE_SNAPSHOT');
 }
});

async function format4MioFixture(t: test.TestContext,localMode:'confirm'|'direct'='confirm'){
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-format4-mio-'));
 const projectFile=path.join(root,'project.mioon'),projectId=createProjectFile(projectFile);
 const locate=()=>({localDir:path.join(root,'records'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'tmp')});
 const initialStore=openServerTestStore({projectFile,locate},path.join(root,'tool-app'));
 const initialPorts=createMioTestAppPorts(initialStore);
 await initialPorts.services.call('project.create',{name:'Mio frame transaction'});
 await initialPorts.services.drain();initialPorts.close();initialStore.close();
 const store=openServerTestStore({projectFile,locate,format4:{approveUpgrade:()=>true}},path.join(root,'tool-app'));
 assert.equal(store.db.prepare('PRAGMA project.user_version').get()?.user_version,FORMAT4_PROJECT_SCHEMA_VERSION);
 const ports=createMioTestAppPorts(store),{services}=ports;

 const settings=await createTestAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
 await putTestAgentConfiguration(settings,{expectedRevision:0,configuration:defaultTestAgentConfiguration('chat_completions'),secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_FRAME_TRANSACTION_KEY'}});
 const authorizations=ports.createAuthorizations(settings);
 await authorizeTestScope(authorizations,'project_agent');
 const policy={...mioTestPolicy,policy:()=>{const base=mioTestPolicy.policy();return {...base,modes:{...base.modes,local_reversible:localMode}};}};
 const journal=createMioJournal(store,policy),tools=createAgentTaskTools({store,services,journal});
 let runtime:ReturnType<typeof createMioRuntime>|undefined;
 function startRuntime(gateway:TaskGateway){
  runtime=createMioRuntime({store,journal,policy,tools,agentSettings:settings,authorizations,gateway,selfPort:()=>4318});
  return runtime;
 }
 t.after(async()=>{runtime?.close();await runtime?.drain();tools.dispose();await services.drain();await settings.close();ports.close();store.close();await rm(root,{recursive:true,force:true});});

 const rpc=(operation:string,input:Record<string,unknown>={})=>services.call(operation,{projectId,...input});
 const read=async()=>timelineFormatResponseSchema.parse(await rpc('timeline.format.get'));
 const timeline=async(operation='timeline.get',input:Record<string,unknown>={})=>{
  const value=await rpc(operation,input);assert.ok(isTimelineRecord(value,{projectId}));return value;
 };
 const frameArgs=(frame:Awaited<ReturnType<typeof read>>,presetId:string)=>({expectedProjectRevision:frame.projectRevision,expectedRevision:frame.timelineRevision,presetId});
 const initialized=await timeline(),track=initialized.tracks.find(item=>item.kind==='video')!;
 const dataBase64=png({width:16,height:16,rgba:false,pixel:()=>[255,0,0]}).toString('base64');
 const asset=await rpc('asset.import',{name:'Synthetic source.png',mimeType:'image/png',dataBase64});assert.ok(object(asset)&&typeof asset.id==='string');
 return {store,settings,journal,tools,startRuntime,rpc,read,timeline,frameArgs,initialized,track,assetId:asset.id,dataBase64,projectId};
}

async function waitForMioRun(runtime:ReturnType<typeof createMioRuntime>,projectId:string,runId:string,expected:AgentTaskSnapshot['run']['status']):Promise<AgentTaskSnapshot>{
 for(let tries=0;tries<1000;tries++){
  const saved=runtime.get(projectId,runId);
  if(saved.run.status===expected)return saved;
  assert.ok(!['completed','failed','paused'].includes(saved.run.status),JSON.stringify(saved));
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('Synthetic Mio frame run did not reach '+expected);
}

async function canvasMioFixture(t:test.TestContext, mode:'confirm'|'direct'='confirm'){
 const fixture=await format4MioFixture(t,mode);
 const {store,settings,journal,startRuntime,rpc,projectId}=fixture;
 const history=async()=>canvasEditingResponses['canvas.history.get'].parse(await rpc('canvas.history.get'));
 const cursor=()=>({
  state:store.db.prepare('SELECT * FROM main.canvas_history_state WHERE projectId=?').get(projectId),
  entries:store.db.prepare('SELECT * FROM main.canvas_history_entries WHERE projectId=? ORDER BY position').all(projectId),
  receipts:store.db.prepare('SELECT count(*) AS count FROM main.canvas_requests WHERE projectId=?').get(projectId),
 });
 const userEdit=async(edit:Record<string,unknown>)=>{
  const {revision,requestEpoch,requestAfter}=await history();
  return canvasEditingResponses['canvas.apply'].parse(await rpc('canvas.apply',{
   ...edit,historyRevision:revision,requestId:createCanvasRequestId(requestEpoch,randomUUID(),Math.max(Date.now(),requestAfter+1)),
  }));
 };
 const target=(kind:'shot'|'node',id:string)=>{
  const expectedRevision=journal.targetRevision(projectId,kind,id);
  assert.ok(typeof expectedRevision==='number');
  return {kind,id,expectedRevision};
 };
 const archiveRow=(kind:'shot'|'node',id:string)=>{
  const row=store.db.prepare(`SELECT archivedAt,archiveBatchId,archiveReason FROM project.${kind==='shot'?'shots':'nodes'} WHERE id=?`).get(id);
  assert.ok(row,'a reversible archive preserves the underlying record');
  return {...row};
 };
 async function node(label:string,position:{x:number;y:number}){
  const saved=await rpc('node.create',{type:'text',label,text:'Kept node text',position,requestId:randomUUID()});
  assert.ok(object(saved)&&typeof saved.id==='string');
  return saved.id;
 }
 async function shot(title:string){
  const saved=await rpc('shot.create',{requestId:randomUUID(),title,position:{x:480,y:320}});
  assert.ok(object(saved)&&typeof saved.id==='string');
  return saved.id;
 }
 async function turn(operation:'layout'|'archive'|'restore',args:Record<string,AgentTaskJson>){
  const name=`mioon_canvas_${operation}`,callId='canvas_edit',loaderId='load_canvas_edit';
  let requests=0;
  const gateway:TaskGateway=async function*(request){
   request.beforeSubmit?.();
   const body:unknown=JSON.parse(request.body);assert.ok(object(body)&&Array.isArray(body.tools));
   const advertised=body.tools.some((tool:unknown)=>object(tool)&&object(tool.function)&&tool.function.name===name);
   requests++;
   const calls= requests===1
    ? [{id:loaderId,name:'mioon_tools_load',arguments:{names:[name]}}]
    : requests===2 ? [{id:callId,name,arguments:args}] : [];
   assert.equal(advertised,requests>1);
   yield {type:'done',output:output(calls)};
  };
  const runtime=startRuntime(gateway);
  const started=await runtime.send(projectId,{
   requestId:randomUUID(),text:`Canvas ${operation}`,expectedSettingsRevision:testAgentExecution(await settings.get()).revision,
  });
  const wait=(status:AgentTaskSnapshot['run']['status'])=>waitForMioRun(runtime,projectId,started.run.id,status);
  const step=(snapshot:AgentTaskSnapshot)=>{
   const item=snapshot.steps.find(entry=>entry.toolCall?.id===callId);
   assert.ok(item);
   return item;
  };
  const approve=(snapshot:AgentTaskSnapshot)=>runtime.action(projectId,started.run.id,{
   requestId:randomUUID(),expectedRevision:snapshot.run.revision,action:'approve',stepId:step(snapshot).id,
  });
  const undo=(snapshot:AgentTaskSnapshot)=>{
   assert.equal(requests,3);
   assert.equal(snapshot.changes.length,1);
   const change=snapshot.changes[0]!;
   assert.equal(change.operation,`canvas.${operation}`);
   assert.equal(change.reversible,true);
   return runtime.action(projectId,started.run.id,{
    requestId:randomUUID(),expectedRevision:snapshot.run.revision,action:'undo_change',changeId:change.id,
   });
  };
  return {wait,step,approve,undo};
 }
 return {...fixture,cursor,userEdit,target,archiveRow,node,shot,turn};
}

for(const operation of ['layout','archive','restore'] as const)test(`format-4 Mio ${operation} obeys approval and undoes its own change without moving the user canvas cursor`,async t=>{
 const f=await canvasMioFixture(t);
 const unrelated=await f.node('User card',{x:140,y:160});
 const selected=await f.node('Mio card',{x:1560,y:1180});
 const kind='node',unselected=f.target(kind,unrelated);
 await f.userEdit({operation:'move',moves:[{kind,id:unrelated,revision:unselected.expectedRevision,position:{x:520,y:240}}]});
 if(operation==='restore'){
  await f.userEdit({operation:'archive',targets:[{kind,id:selected,revision:f.target(kind,selected).expectedRevision}]});
 }
 const before=f.cursor(),original=f.store.get('nodes',selected),userCard=f.store.get('nodes',unrelated),oldArchive=f.archiveRow(kind,selected);
 assert.ok(before.state&&before.entries.length>0);
 assert.ok(object(original)&&object(userCard));
 const readLive=async()=>{
  const project=await f.rpc('project.get');
  assert.ok(object(project)&&Array.isArray(project.nodes));
  return project.nodes.some((item:unknown)=>object(item)&&item.id===selected);
 };
 const run=await f.turn(operation,{targets:[{kind,id:selected}]});
 const review=await run.wait('awaiting_approval');
 const step=run.step(review);
 assert.equal(step.status,'awaiting_approval');
 assert.equal(step.tier,'local_reversible');
 assert.equal(review.changes.length,0);
 assert.deepEqual(f.archiveRow(kind,selected),oldArchive);
 assert.deepEqual(f.store.get('nodes',selected),original);
 assert.deepEqual(f.cursor(),before);
 await run.approve(review);
 const completed=await run.wait('completed');
 assert.equal(run.step(completed).status,'completed');
 const changed=f.store.get('nodes',selected),newArchive=f.archiveRow(kind,selected);
 assert.ok(object(changed));
 assert.equal(await readLive(),operation!=='archive');
 if(operation==='layout'){
  assert.notDeepEqual(changed.position,original.position);
  assert.deepEqual(newArchive,oldArchive);
 } else {
  assert.deepEqual(changed.position,original.position);
  assert.equal(typeof newArchive.archivedAt==='string',operation==='archive');
 }
 assert.equal(changed.label,original.label);
 assert.equal(changed.text,original.text);
 assert.deepEqual(f.store.get('nodes',unrelated),userCard);
 assert.deepEqual(f.cursor(),before);
 if(operation==='archive'){
  const ownerId=randomUUID(),{expectedRevision:revision}=f.target(kind,selected);
  f.journal.claim({projectId:f.projectId,ownerId,targets:[{kind,id:selected,revision}]});
  await assert.rejects(run.undo(completed),{code:'AGENT_TASK_TARGET_CLAIMED'});
  assert.deepEqual(f.archiveRow(kind,selected),newArchive);
  assert.deepEqual(f.cursor(),before);
  f.journal.releaseClaims(f.projectId,ownerId);
 }
 const undone=await run.undo(completed),restored=f.store.get('nodes',selected);
 assert.equal(undone.changes[0]?.status,'reverted');
 assert.ok(object(restored));
 assert.deepEqual(restored.position,original.position);
 assert.equal(restored.label,original.label);
 assert.equal(restored.text,original.text);
 assert.deepEqual(f.archiveRow(kind,selected),oldArchive);
 assert.equal(await readLive(),operation!=='restore');
 assert.deepEqual(f.store.get('nodes',unrelated),userCard);
 assert.deepEqual(f.cursor(),before);
});

for(const usedBy of ['version','timeline','two clips of one version'] as const)test(`format-4 Mio archive requires approval in direct mode for a shot used by ${usedBy}`,async t=>{
 const f=await canvasMioFixture(t,'direct'),title='Shot with retained evidence',shotId=await f.shot(title);
 const {store,projectId,assetId}=f;
 const usedVersions=Number(usedBy==='two clips of one version'),versions=Number(usedBy!=='timeline');
 const clips=usedBy==='timeline'?1:usedVersions*2;
 const otherShot=clips?await f.shot('Unused shot in the same selection'):undefined;
 const versionId=randomUUID(),jobId=randomUUID();
 let boundTimeline:typeof f.initialized|undefined;
 if(clips){
  let timeline=f.initialized;
  for(let i=0;i<clips;i++)timeline=await f.timeline('timeline.clip.add',{
   expectedRevision:timeline.revision,requestId:randomUUID(),trackId:f.track.id,assetId,startFrame:i*90,durationFrames:90,
  });
  boundTimeline={...timeline,clips:timeline.clips.map(clip=>({...clip,shotId,...(usedVersions?{versionId,jobId}:{})}))};
  assert.ok(isTimelineRecord(boundTimeline,{projectId}));
 }
 if(versions)store.put('versions',{id:versionId,projectId,shotId,jobId,assetId,sha256:'a'.repeat(64)});
 if(boundTimeline)store.put('timelines',boundTimeline);
 const ids=otherShot?[shotId,otherShot]:[shotId],targets=ids.map(id=>f.target('shot',id));
 const before=f.cursor(),original=ids.map(id=>f.archiveRow('shot',id));
 const preview=canvasEditingResponses['canvas.archive.preview'].parse(await f.rpc('canvas.archive.preview',{
  operation:'archive',targets:targets.map(({kind,id,expectedRevision})=>({kind,id,revision:expectedRevision})),
 }));
 assert.deepEqual([preview.versions,preview.clips,preview.blocked],[versions,clips,[]]);
 assert.equal(preview.shotImpacts.find(item=>item.number===1)?.usedVersions,usedVersions);
 assert.ok(preview.confirmation);
 const run=await f.turn('archive',{targets:targets.map(({kind,id})=>({kind,id}))});
 const review=await run.wait('awaiting_approval'),step=run.step(review);
 assert.equal(step.tier,'local_reversible');
 assert.equal(step.status,'awaiting_approval');
 assert.equal(step.display?.operation,'canvas.archive');
 const display=step.display;
 const shotIndex=display.targets.findIndex(item=>item.kind==='shot'&&item.id===shotId&&item.name===`#01 · ${title}`);
 assert.ok(shotIndex>=0);
 assert.deepEqual(display.targets.map(({id})=>id),ids);
 for(const targetIndex of otherShot?[undefined,shotIndex]:[undefined]){
  const counts=display.fields.filter(field=>field.targetIndex===targetIndex
   &&['canvasVersionCount','canvasTimelineClipCount','canvasTimelineUsedVersionCount'].includes(field.property));
  const at=targetIndex===undefined?{}:{targetIndex};
  assert.deepEqual(counts,[
   {...at,property:'canvasVersionCount',unit:'count',after:versions},
   {...at,property:'canvasTimelineClipCount',unit:'count',after:clips},
   {...at,property:'canvasTimelineUsedVersionCount',unit:'count',after:usedVersions},
  ],JSON.stringify(display));
 }
 assert.equal(review.changes.length,0);
 assert.deepEqual(ids.map(id=>f.archiveRow('shot',id)),original);
 assert.deepEqual(f.cursor(),before);
 await run.approve(review);
 const completed=await run.wait('completed');
 assert.equal(run.step(completed).status,'completed');
 for(const id of ids)assert.equal(typeof f.archiveRow('shot',id).archivedAt,'string');
 assert.equal(completed.changes.length,1);
 assert.deepEqual(f.cursor(),before);
 assert.equal(store.list('versions',projectId).length,versions);
 if(boundTimeline)assert.deepEqual(store.get('timelines',boundTimeline.id),boundTimeline);
 if(usedBy==='timeline')assert.equal((await f.timeline()).clips[0]?.shotId,shotId);
});

test('format-4 Mio layout without a selection and ordinary archive execute under direct policy',async t=>{
 await t.test('layout includes both kinds of live elements',async t=>{
  const f=await canvasMioFixture(t,'direct'),shotId=await f.shot('Live shot'),nodeId=await f.node('Live card',{x:1500,y:840});
  const read=()=>[f.store.get('shots',shotId),f.store.get('nodes',nodeId)].map(item=>{
   assert.ok(object(item));
   return item.position;
  });
  const preserved=f.cursor(),before=read(),run=await f.turn('layout',{});
  const completed=await run.wait('completed');
  assert.equal(run.step(completed).status,'completed');
  assert.notDeepEqual(read()[0],before[0]);
  assert.notDeepEqual(read()[1],before[1]);
  await run.undo(completed);
  assert.deepEqual(read(),before);
  assert.deepEqual(f.cursor(),preserved);
 });
 await t.test('archive of an unused shot needs no approval',async t=>{
  const f=await canvasMioFixture(t,'direct'),id=await f.shot('Unused shot'),before=f.archiveRow('shot',id),cursor=f.cursor();
  const run=await f.turn('archive',{targets:[{kind:'shot',id}]});
  const completed=await run.wait('completed');
  assert.equal(run.step(completed).status,'completed');
  assert.equal(typeof f.archiveRow('shot',id).archivedAt,'string');
  await run.undo(completed);
  assert.deepEqual(f.archiveRow('shot',id),before);
  assert.deepEqual(f.cursor(),cursor);
 });
});

for(const changedBy of ['move','claim'] as const)test(`format-4 Mio refuses an old canvas plan when user ${changedBy} arrives during approval`,async t=>{
 const f=await canvasMioFixture(t),id=await f.node('Touched during approval',{x:1360,y:960}),kind='node';
 const run=await f.turn('archive',{targets:[{kind,id}]});
 const review=await run.wait('awaiting_approval'),step=run.step(review),original=f.archiveRow(kind,id);
 const revision=f.target(kind,id).expectedRevision;
 assert.equal(step.targets?.find(target=>target.kind===kind&&target.id===id)?.revision,revision);
 const ownerId=randomUUID();
 if(changedBy==='move'){
  await f.userEdit({operation:'move',moves:[{kind,id,revision,position:{x:1380,y:980}}]});
  assert.equal(f.target(kind,id).expectedRevision,revision+1);
 } else {
  f.journal.claim({projectId:f.projectId,ownerId,targets:[{kind,id,revision}]});
 }
 const cursor=f.cursor(),current=f.store.get('nodes',id);
 await assert.rejects(run.approve(review),{code:changedBy==='move'?'AGENT_TASK_TARGET_CHANGED':'AGENT_TASK_TARGET_CLAIMED'});
 const completed=await run.wait('completed');
 assert.equal(run.step(completed).status,'rejected');
 assert.equal(completed.changes.length,0);
 assert.deepEqual(f.archiveRow(kind,id),original);
 assert.deepEqual(f.store.get('nodes',id),current);
 assert.deepEqual(f.cursor(),cursor);
 if(changedBy==='claim')f.journal.releaseClaims(f.projectId,ownerId);
});

test('format-4 Mio refuses an earlier approval when archive impact changes without a shot revision change',async t=>{
 const f=await canvasMioFixture(t),kind='shot',id=await f.shot('Shot receives new evidence');
 const run=await f.turn('archive',{targets:[{kind,id}]});
 const review=await run.wait('awaiting_approval'),step=run.step(review),original=f.archiveRow(kind,id);
 const {expectedRevision}=f.target(kind,id);
 const versionId=randomUUID();
 f.store.put('versions',{id:versionId,projectId:f.projectId,shotId:id,jobId:randomUUID(),assetId:f.assetId,sha256:'a'.repeat(64)});
 assert.equal(f.target(kind,id).expectedRevision,expectedRevision);
 const cursor=f.cursor();
 await run.approve(review);
 const completed=await run.wait('completed'),rejected=run.step(completed);
 assert.equal(rejected.id,step.id);
 assert.equal(rejected.status,'rejected');
 assert.equal(rejected.error?.code,'TARGET_CHANGED');
 assert.deepEqual(completed.changes,[]);
 assert.deepEqual(f.archiveRow(kind,id),original);
 assert.ok(f.store.get('versions',versionId));
 assert.deepEqual(f.cursor(),cursor);
});

test('format-4 Mio separately undoes overlapping layout and archive steps through its own revision chain',async t=>{
 const f=await canvasMioFixture(t,'direct'),kind='node',id=await f.node('Moved and archived card',{x:1500,y:1180});
 const before=f.store.get('nodes',id),cursor=f.cursor(),originalArchive=f.archiveRow(kind,id);
 assert.ok(object(before));
 let request=0;
 const gateway:TaskGateway=async function*(input){
  input.beforeSubmit?.();
  const args={targets:[{kind,id}]},names=['mioon_canvas_layout','mioon_canvas_archive'];
  const calls=[
   [{id:'load_both',name:'mioon_tools_load',arguments:{names}}],
   [{id:'layout_first',name:'mioon_canvas_layout',arguments:args}],
   [{id:'archive_next',name:'mioon_canvas_archive',arguments:args}],
   [],
  ][request++];
  assert.ok(calls);
  yield {type:'done',output:output(calls)};
 };
 const runtime=f.startRuntime(gateway),started=await runtime.send(f.projectId,{
  requestId:randomUUID(),text:'Tidy and archive the card',expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,
 });
 const completed=await waitForMioRun(runtime,f.projectId,started.run.id,'completed');
 assert.equal(request,4);
 assert.deepEqual(completed.changes.map(change=>[change.operation,change.status]),[['canvas.layout','applied'],['canvas.archive','applied']]);
 const [layout,archive]=completed.changes;
 assert.ok(layout&&archive);
 const moved=f.store.get('nodes',id);
 assert.ok(object(moved));
 assert.notDeepEqual(moved.position,before.position);
 assert.equal(typeof f.archiveRow(kind,id).archivedAt,'string');
 const undo=(revision:number,changeId:string)=>runtime.action(f.projectId,started.run.id,{
  requestId:randomUUID(),expectedRevision:revision,action:'undo_change',changeId,
 });
 const restored=await undo(completed.run.revision,archive.id);
 assert.deepEqual(restored.changes.map(({status})=>status),['applied','reverted']);
 assert.equal(restored.changes[0]?.undoDisposition,'undo');
 assert.deepEqual(f.archiveRow(kind,id),originalArchive);
 assert.deepEqual(f.cursor(),cursor);
 const reverted=await undo(restored.run.revision,layout.id),saved=f.store.get('nodes',id);
 assert.deepEqual(reverted.changes.map(({status})=>status),['reverted','reverted']);
 assert.ok(object(saved));
 assert.deepEqual(saved.position,before.position);
 assert.deepEqual(f.archiveRow(kind,id),originalArchive);
 assert.deepEqual(f.cursor(),cursor);
});

test('format-4 Mio keeps dual CAS, a reversible frame receipt, and the native undo and redo history', async t=>{
 const {store,settings,journal,tools,startRuntime,rpc,read,timeline,frameArgs,initialized,track,assetId,dataBase64,projectId}=await format4MioFixture(t);
 const otherAsset=await rpc('asset.import',{name:'Unreferenced.png',mimeType:'image/png',dataBase64});
 assert.ok(object(otherAsset)&&typeof otherAsset.id==='string'&&otherAsset.id!==assetId);
 const withClip=await timeline('timeline.clip.add',{requestId:randomUUID(),expectedRevision:initialized.revision,assetId,trackId:track.id,startFrame:0,durationFrames:90});
 const initial=await timeline('timeline.subtitle.add',{requestId:randomUUID(),expectedRevision:withClip.revision,startFrame:0,durationFrames:30,text:'Kept subtitle'});
 const clip=initial.clips[0]!,staleGeometry=tools.prepare({projectId,operation:'timeline.clip.update',input:{
  clipId:clip.id,expectedRevision:withClip.revision,patch:{rect:{x:0,y:0,width:360,height:640}},
 }});
 assert.deepEqual(staleGeometry.targets.map(({kind})=>kind),['timeline_clip','timeline']);
 await assert.rejects(tools.execute(staleGeometry,{runId:randomUUID(),stepId:randomUUID(),requestId:randomUUID(),beforeEffect(){},recordInside(){assert.fail('Stale geometry must not write a receipt');}}),{code:'REVISION_CONFLICT'});
 assert.deepEqual(await timeline(),initial);
 const frame=await read(),args=frameArgs(frame,'ultrawide_1080');
 assert.equal(frame.eligible,true);
 const operation='timeline.format.set';
 for(const stale of [{...args,expectedProjectRevision:args.expectedProjectRevision+1},{...args,expectedRevision:args.expectedRevision-1}]){
  const prepared=tools.prepare({projectId,operation,input:stale});
  await assert.rejects(tools.execute(prepared,{runId:randomUUID(),stepId:randomUUID(),requestId:randomUUID(),beforeEffect(){},recordInside(){assert.fail('Stale format must not write a receipt');}}),{code:'REVISION_CONFLICT'});
  assert.deepEqual(await timeline(),initial);
 }
 const atomicRequestId=randomUUID(),recordFailure=new Error('Synthetic journal write failure');
 const prepared=tools.prepare({projectId,operation,input:args});
 const receiptCount=()=>store.db.prepare('SELECT count(*) AS total FROM main.timeline_requests WHERE requestId=?').get(atomicRequestId)?.total;
 const historyCount=()=>store.db.prepare('SELECT count(*) AS total FROM main.timeline_history WHERE projectId=?').get(projectId)?.total;
 const historyBefore=historyCount();
 await assert.rejects(tools.execute(prepared,{runId:randomUUID(),stepId:randomUUID(),requestId:atomicRequestId,beforeEffect(){},recordInside(){throw recordFailure;}}),error=>error===recordFailure);
 assert.deepEqual(await timeline(),initial);
 assert.equal(historyCount(),historyBefore);
 assert.equal(receiptCount(),0);
 assert.equal(store.db.prepare('SELECT 1 FROM main.timeline_format_requests WHERE requestId=?').get(atomicRequestId),undefined);
 let requests=0;
 const gateway:TaskGateway=async function*(request){
  request.beforeSubmit?.();requests++;
  const calls:AgentTaskToolCall[]=requests===1?[{id:'load_frame',name:'mioon_tools_load',arguments:{names:['mioon_timeline_format_set']}}]
   :requests===2?[{id:'set_frame',name:'mioon_timeline_format_set',arguments:args}]:[];
  yield {type:'done',output:output(calls)};
 };
 const runtime=startRuntime(gateway);
 const accepted=await runtime.send(projectId,{requestId:randomUUID(),text:'Change the saved frame to ultrawide',expectedSettingsRevision:testAgentExecution(await settings.get()).revision});
 const waitForRun=(expected:AgentTaskSnapshot['run']['status'])=>waitForMioRun(runtime,projectId,accepted.run.id,expected);
 const review=await waitForRun('awaiting_approval'),pending=review.steps.find(step=>step.toolCall?.id==='set_frame');
 assert.equal(pending?.status,'awaiting_approval');
 assert.deepEqual(await timeline(),initial,'confirmation has made no writes');
 await runtime.action(projectId,accepted.run.id,{requestId:randomUUID(),expectedRevision:review.run.revision,action:'approve',stepId:pending.id});
 const completed=await waitForRun('completed');
 assert.equal(requests,3);
 const set=completed.steps.find(step=>step.toolCall?.id==='set_frame')!;
 assert.equal(set.tier,'local_reversible');
 assert.deepEqual(set.targets?.map(item=>item.kind),['timeline','project','timeline_clip','timeline_subtitle']);
 assert.deepEqual(set.result,{timelineId:initial.id,revision:initial.revision+1,
  before:{presetId:frame.presetId,width:frame.width,height:frame.height},after:{presetId:'ultrawide_1080',width:2520,height:1080},affectedClips:1});
 assert.equal(completed.changes.length,1);
 const changed=await timeline(),retained=journal.snapshot(accepted.run.id).changes[0]!;
 assert.equal(changed.clips[0]?.layout?.basisPresetId,frame.presetId);
 assert.notDeepEqual(changed.subtitles,initial.subtitles);
 assert.deepEqual(retained.frameDependencies?.map(({kind})=>kind),['timeline_subtitle']);
 assert.equal(Object.hasOwn(completed.changes[0]!,'frameDependencies'),false);
 assert.deepEqual(await rpc(operation,{...args,requestId:set.id}),changed,'replay returns the frozen acceptance');
 assert.deepEqual(readMioProjectImportDependencies(store,otherAsset.id),{status:'clear'},'bound clip and format evidence does not make a different asset unprovable');
 const ownerId=randomUUID(),subtitle=retained.frameDependencies![0]!;
 journal.claim({projectId,ownerId,targets:[subtitle]});
 const undo=()=>runtime.action(projectId,accepted.run.id,{requestId:randomUUID(),expectedRevision:runtime.get(projectId,accepted.run.id).run.revision,action:'undo_all'});
 await assert.rejects(undo(),{code:'AGENT_TASK_TARGET_CLAIMED'});
 assert.deepEqual(await timeline(),changed,'the unchanged cue still fences frame compensation');
 journal.releaseClaims(projectId,ownerId);
 const undone=await undo();
 assert.equal(undone.run.status,'reverted');
 const restored=await timeline();
 assert.deepEqual([restored.width,restored.height,restored.clips,restored.subtitles],[initial.width,initial.height,initial.clips,initial.subtitles]);
 const operations=store.db.prepare('SELECT operation FROM main.timeline_history WHERE projectId=? ORDER BY position').all(projectId);
 assert.deepEqual(operations.slice(-2).map(({operation})=>operation),['timeline.format.set','agent.task.undo']);
 const reversed=await timeline('timeline.undo',{requestId:randomUUID(),expectedRevision:restored.revision});
 assert.deepEqual([reversed.width,reversed.height,reversed.clips,reversed.subtitles],[changed.width,changed.height,changed.clips,changed.subtitles]);
 const redone=await timeline('timeline.redo',{requestId:randomUUID(),expectedRevision:reversed.revision});
 assert.deepEqual([redone.width,redone.height,redone.clips,redone.subtitles],[initial.width,initial.height,initial.clips,initial.subtitles]);
 assert.equal((await read()).eligible,true);
});

for(const edit of ['add','update'] as const)test(`format-4 Mio rereads and requests fresh approval after a stale clip.${edit} rectangle`,async t=>{
 const {store,settings,journal,startRuntime,timeline,read,frameArgs,initialized,track,assetId,projectId}=await format4MioFixture(t);
 const source={assetId,trackId:track.id,startFrame:0,durationFrames:90},operation=`timeline.clip.${edit}`,toolName=`mioon_timeline_clip_${edit}`;
 const original=edit==='add'?initialized:await timeline('timeline.clip.add',{...source,requestId:randomUUID(),expectedRevision:initialized.revision});
 const saved=edit==='add'
  ?await timeline('timeline.format.set',{...frameArgs(await read(),'landscape_1080'),requestId:randomUUID()})
  :await timeline('timeline.track.update',{requestId:randomUUID(),expectedRevision:original.revision,trackId:track.id,patch:{name:'Renamed by user'}});
 const clipId=saved.clips[0]?.id;
 const rectFor=(frame:{width:number;height:number})=>edit==='add'?{x:0,y:0,width:frame.width,height:frame.height}:{x:0,y:0,width:360,height:640};
 const argsFor=(frame:{revision:number;width:number;height:number}):Record<string,AgentTaskJson>=>edit==='add'
  ?{...source,expectedRevision:frame.revision,rect:rectFor(frame)}
  :{clipId:clipId!,expectedRevision:frame.revision,patch:{rect:rectFor(frame)}};
 if(edit==='add')assert.ok(rectFor(original).height>saved.height,'the stale rectangle is outside the new frame');
 const history=()=>store.db.prepare('SELECT operation FROM main.timeline_history WHERE projectId=? ORDER BY position').all(projectId).map(({operation})=>operation);
 const before=history(),receipt=(requestId:string)=>store.db.prepare('SELECT 1 FROM main.timeline_requests WHERE requestId=?').get(requestId);
 let requests=0;
 const gateway:TaskGateway=async function*(request){
  request.beforeSubmit?.();requests++;
  const body:unknown=JSON.parse(request.body);assert.ok(object(body));
  const messages=body.messages;assert.ok(Array.isArray(messages));
  const toolResult=(callId:string):unknown=>{
   const message=messages.findLast((item:unknown)=>object(item)&&item.role==='tool'&&item.tool_call_id===callId);
   assert.ok(object(message)&&typeof message.content==='string');
   return JSON.parse(message.content);
  };
  let calls:AgentTaskToolCall[];
  switch(requests){
   case 1:
    calls=[{id:'load_rect_edit',name:'mioon_tools_load',arguments:{names:[toolName]}}];
    break;
   case 2:
    calls=[{id:'stale_rect',name:toolName,arguments:argsFor(original)}];
    break;
   case 3:{
    const rejected=toolResult('stale_rect');
    assert.ok(object(rejected)&&object(rejected.error));
    assert.equal(rejected.error.code,'REVISION_CONFLICT');
    assert.match(String(rejected.error.message),/重新讀取|重新读取/u);
    calls=[{id:'read_timeline',name:'mioon_timeline_inspect',arguments:{}}];
    break;
   }
   case 4:{
    const observed=toolResult('read_timeline');
    assert.ok(object(observed)&&typeof observed.revision==='number'&&typeof observed.width==='number'&&typeof observed.height==='number');
    assert.deepEqual([observed.revision,observed.width,observed.height],[saved.revision,saved.width,saved.height]);
    assert.ok(Array.isArray(observed.clips)&&observed.clips.length===saved.clips.length);
    if(edit==='update')assert.ok(observed.clips.some((item:unknown)=>object(item)&&item.id===clipId));
    calls=[{id:'fresh_rect',name:toolName,arguments:argsFor({revision:observed.revision,width:observed.width,height:observed.height})}];
    break;
   }
   default:
    assert.equal(requests,5);
    calls=[];
  }
  yield {type:'done',output:output(calls)};
 };
 const runtime=startRuntime(gateway);
 const started=await runtime.send(projectId,{requestId:randomUUID(),text:'Apply the clip rectangle',locale:'zh-Hans',expectedSettingsRevision:testAgentExecution(await settings.get()).revision});
 const approve=(snapshot:AgentTaskSnapshot,stepId:string)=>runtime.action(projectId,started.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action:'approve',stepId});
 const pending=await waitForMioRun(runtime,projectId,started.run.id,'awaiting_approval');
 const late=pending.steps.find(step=>step.toolCall?.id==='stale_rect');assert.equal(late?.status,'awaiting_approval');
 assert.deepEqual(await timeline(),saved);
 await approve(pending,late.id);
 const replanned=await waitForMioRun(runtime,projectId,started.run.id,'awaiting_approval');
 const stale=journal.step(late.id),fresh=replanned.steps.find(step=>step.toolCall?.id==='fresh_rect');
 assert.equal(stale.status,'rejected');assert.equal(stale.error?.code,'REVISION_CONFLICT');
 assert.ok(object(stale.data));assert.equal(stale.data.dispatchPrevented,true);
 assert.equal(fresh?.status,'awaiting_approval');assert.notEqual(fresh.id,stale.id);
 assert.equal(replanned.changes.length,0);
 assert.equal(receipt(stale.id),undefined);
 assert.deepEqual(await timeline(),saved);assert.deepEqual(history(),before);
 await approve(replanned,fresh.id);
 const done=await waitForMioRun(runtime,projectId,started.run.id,'completed'),after=await timeline();
 assert.equal(requests,5);
 assert.equal(done.steps.find(step=>step.id===fresh.id)?.status,'completed');
 assert.equal(done.changes.length,1);
 assert.equal(after.revision,saved.revision+1);
 assert.deepEqual(after.tracks,saved.tracks);
 assert.equal(after.clips.length,1);assert.deepEqual(after.clips[0]?.rect,rectFor(saved));
 if(edit==='update')assert.deepEqual(after.clips,[{...saved.clips[0],rect:rectFor(saved)}]);
 else for(const key of Object.keys(source) as (keyof typeof source)[])assert.equal(after.clips[0]?.[key],source[key]);
 assert.deepEqual(history(),[...before,operation]);
 assert.equal(receipt(stale.id),undefined);assert.ok(receipt(fresh.id));
 if(edit==='add'){
  await timeline('timeline.format.set',{...frameArgs(await read(),'portrait_1080'),requestId:randomUUID()});
  assert.deepEqual(await timeline(operation,{...argsFor(saved),requestId:fresh.id}),after,'replay keeps the original frame and rectangle');
 }
});
