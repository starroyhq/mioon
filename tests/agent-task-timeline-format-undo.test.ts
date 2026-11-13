import {putTestAgentConfiguration,testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {defaultTestAgentConfiguration} from './helpers/agent-preset-configurations.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isTimelineFormatReadResponse,isTimelineRecord,TIMELINE_MUTATION_OPERATIONS} from '@mioon/contracts';
import {agentTaskSnapshotSchema,type AgentTaskSnapshot,type AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import {deriveAgentEndpoint} from '../packages/contracts/src/agent-protocol.ts';
import {projectApiPath,projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {timelineFormatResponseSchema} from '../packages/contracts/src/timeline-format.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import type {TaskGateway,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {startServer,type InspectProject} from '../apps/server/src/index.ts';
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
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initialSettings=await settings.get();
 await putTestAgentConfiguration(settings,{expectedRevision:initialSettings.revision,configuration:defaultTestAgentConfiguration('chat_completions'),secret:{action:'replace',storage:'session',value:'SYNTHETIC_FORMAT_MIO_UNDO_KEY'}});
 let models=0,timelineRevision=0,inspect!:InspectProject;
 const gateway:TaskGateway=async function*(request){
  request.beforeSubmit?.();models++;
  const calls:AgentTaskToolCall[]=models===1?[{id:'load_subtitles',name:'mioon_tools_load',arguments:{names:['mioon_timeline_subtitle_add']}}]:models<=3?[{id:`add_subtitle_${models-1}`,name:'mioon_timeline_subtitle_add',arguments:{expectedRevision:timelineRevision+models-2,startFrame:(models-2)*30,durationFrames:30,text:models===2?'First subtitle':'Second subtitle'}}]:[];
  yield {type:'done',output:output(calls)};
 };
 const server=await startServer({dataDir:root,port:0,agentSettings:settings,taskGatewayV2:gateway,comfyModule:'skip',inspectProject:received=>{inspect=received;}});
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

test('format-4 Mio keeps dual CAS, a reversible frame receipt, and the native undo and redo history', async t=>{
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

 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
 await putTestAgentConfiguration(settings,{expectedRevision:0,configuration:defaultTestAgentConfiguration('chat_completions'),secret:{action:'replace',storage:'session',value:'SYNTHETIC_FRAME_TRANSACTION_KEY'}});
 const authorizations=ports.createAuthorizations(settings);
 await authorizeTestScope(authorizations,'project_agent');
 const policy={...mioTestPolicy,policy:()=>{const base=mioTestPolicy.policy();return {...base,modes:{...base.modes,local_reversible:'confirm' as const}};}};
 const journal=createMioJournal(store,policy),tools=createAgentTaskTools({store,services,journal});

 const rpc=(operation:string,input:Record<string,unknown>={})=>services.call(operation,{projectId,...input});
 const read=async()=>timelineFormatResponseSchema.parse(await rpc('timeline.format.get'));
 const timeline=async(operation='timeline.get',input:Record<string,unknown>={})=>{
  const value=await rpc(operation,input);assert.ok(isTimelineRecord(value,{projectId}));return value;
 };
 const frameArgs=(frame:Awaited<ReturnType<typeof read>>,presetId:string)=>({expectedProjectRevision:frame.projectRevision,expectedRevision:frame.timelineRevision,presetId});
 const initialized=await timeline(),track=initialized.tracks.find(item=>item.kind==='video')!;
 const dataBase64=png({width:16,height:16,rgba:false,pixel:()=>[255,0,0]}).toString('base64');
 const asset=await rpc('asset.import',{name:'Synthetic source.png',mimeType:'image/png',dataBase64});assert.ok(object(asset)&&typeof asset.id==='string');
 const otherAsset=await rpc('asset.import',{name:'Unreferenced.png',mimeType:'image/png',dataBase64});
 assert.ok(object(otherAsset)&&typeof otherAsset.id==='string'&&otherAsset.id!==asset.id);
 const withClip=await timeline('timeline.clip.add',{requestId:randomUUID(),expectedRevision:initialized.revision,assetId:asset.id,trackId:track.id,startFrame:0,durationFrames:90});
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
 const runtime=createMioRuntime({store,journal,policy,tools,agentSettings:settings,authorizations,gateway,selfPort:()=>4318});
 t.after(async()=>{runtime.close();await runtime.drain();tools.dispose();await services.drain();await settings.close();ports.close();store.close();await rm(root,{recursive:true,force:true});});
 const accepted=await runtime.send(projectId,{requestId:randomUUID(),text:'Change the saved frame to ultrawide',expectedSettingsRevision:testAgentExecution(await settings.get()).revision});
 async function waitForRun(expected:AgentTaskSnapshot['run']['status']):Promise<AgentTaskSnapshot>{
  for(let tries=0;tries<1000;tries++){
   const saved=runtime.get(projectId,accepted.run.id);
   if(saved.run.status===expected)return saved;
   assert.ok(!['completed','failed','paused'].includes(saved.run.status),JSON.stringify(saved));
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Synthetic Mio frame run did not reach '+expected);
 }
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
