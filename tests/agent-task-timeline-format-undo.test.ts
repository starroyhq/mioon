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
import {startServer,type InspectProject} from './helpers/test-server.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

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
