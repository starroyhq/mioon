import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer} from '../apps/server/src/index.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {deriveAgentEndpoint} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskSnapshot,AgentTaskPolicy,AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {TaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
async function fixture(t:TestContext,protocol:AgentConfiguration['protocol']='chat_completions',customGateway?:TaskGateway){
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-task-http-v2-'));
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});const initial=await settings.get();
 await settings.put({expectedRevision:initial.revision,configuration:{...initial.configuration,protocol},secret:{action:'replace',storage:'session',value:'SYNTHETIC_TASK_HTTP_KEY'}});
 let models=0;
 const gateway:TaskGateway=async function*(request){models++;const body=JSON.parse(request.body) as {messages?:{role?:string}[];input?:{type?:string}[]};
  const answered=body.messages?.some(item=>item.role==='tool')||body.input?.some(item=>item.type==='function_call_output');
  if(answered){yield {type:'delta',text:'已完成本地创建'};yield {type:'done',output:{text:'已完成本地创建',toolCalls:[],providerOutput:(protocol==='responses'?[{id:'message_final',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'已完成本地创建',annotations:[]}]}]:{role:'assistant',content:'已完成本地创建'}) as AgentTaskJson}};}
  else {const toolCall={id:'call_http',name:'mioon_shot_create',arguments:{title:'HTTP 创建的镜头'}};yield {type:'done',output:{text:'',toolCalls:[toolCall],providerOutput:(protocol==='responses'?[{id:'fc_http',call_id:toolCall.id,type:'function_call',name:toolCall.name,arguments:JSON.stringify(toolCall.arguments),status:'completed'}]:{role:'assistant',content:null,tool_calls:[{id:toolCall.id,type:'function',function:{name:toolCall.name,arguments:JSON.stringify(toolCall.arguments)}}]}) as AgentTaskJson}};}
 };
 const server=await startServer({dataDir:root,port:0,agentSettings:settings,taskGatewayV2:customGateway??gateway});
 t.after(async()=>{await server.close();await settings.close();await rm(root,{recursive:true,force:true});});
 async function request(route:string,method='GET',input?:unknown,authorized=true){
  const response=await fetch(server.url+route,{method,headers:{...(authorized?{Authorization:`Bearer ${server.token}`} : {}),...(input!==undefined?{'Content-Type':'application/json'}:{})},...(input!==undefined?{body:JSON.stringify(input)}:{})});
  const value:unknown=await response.json();assert.ok(object(value));return {status:response.status,data:value.data,error:value.error};
 }
 const created=await request('/api/rpc','POST',{operation:'project.create',input:{name:'HTTP v2 fixture'}});assert.ok(object(created.data)&&typeof created.data.id==='string');const projectId=created.data.id;
 const prefix=`/api/agent/tasks/v2/${projectId}`;
 async function authorize(){const snapshot=await request(prefix);assert.ok(object(snapshot.data));const snapshotSettings=snapshot.data.settings;assert.ok(object(snapshotSettings)&&object(snapshotSettings.configuration));
  const result=await request('/api/rpc','POST',{operation:'agent.authorization.grant',input:{requestId:randomUUID(),expectedRevision:(snapshot.data.authorization as {revision:number}).revision,expectedSettingsRevision:snapshotSettings.revision,destination:deriveAgentEndpoint(snapshotSettings.configuration as unknown as AgentConfiguration),model:snapshotSettings.configuration.model,scope:'project_agent'}});assert.equal(result.status,200);
 }
 async function settle(id:string,status:string[]=['completed','failed','paused','awaiting_approval']):Promise<AgentTaskSnapshot>{
  for(let count=0;count<400;count++){const result=await request(`${prefix}/${id}`);assert.equal(result.status,200);const snapshot=result.data as AgentTaskSnapshot;if(status.includes(snapshot.run.status))return snapshot;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Synthetic HTTP task did not settle');
 }
 return {root,request,prefix,projectId,settings,server,authorize,settle,get models(){return models;}};
}
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: authenticated HTTP task, durable SSE notification, lookup and undo complete without provider access`,async t=>{
 const f=await fixture(t,protocol),input={requestId:randomUUID(),text:'创建一个镜头',expectedSettingsRevision:(await f.settings.get()).revision};
 assert.equal((await f.request(f.prefix,'GET',undefined,false)).status,401);
 assert.equal((await f.request(f.prefix,'POST',input)).status,409);assert.equal(f.models,0);
 await f.authorize();const sent=await f.request(f.prefix,'POST',input);assert.equal(sent.status,200);const accepted=sent.data as AgentTaskSnapshot;
 const ended=await f.settle(accepted.run.id);assert.equal(ended.run.status,'completed');assert.equal(ended.changes.length,1);assert.equal(f.models,2);
 assert.ok(ended.steps.every(step=>step.request===undefined&&step.data===undefined));assert.equal(ended.changes[0]!.before,null);assert.equal(ended.changes[0]!.undo,undefined);
 assert.equal((await f.request(f.prefix,'POST',input)).status,200);assert.equal(f.models,2);
 const lookup=await f.request(`${f.prefix}/requests/${input.requestId}`);assert.ok(object(lookup.data)&&lookup.data.found===true);
 const controller=new AbortController();const stream=await fetch(`${f.server.url}${f.prefix}/${ended.run.id}/events?after=0`,{headers:{Authorization:`Bearer ${f.server.token}`},signal:controller.signal});
 assert.equal(stream.status,200);const reader=stream.body!.getReader(),frame=await reader.read();assert.equal(frame.done,false);assert.match(new TextDecoder().decode(frame.value),/event: changed/u);controller.abort();await reader.cancel().catch(()=>{});
 const undo={requestId:randomUUID(),expectedRevision:ended.run.revision,action:'undo_all'};
 const reverted=await f.request(`${f.prefix}/${ended.run.id}/actions`,'POST',undo);assert.equal(reverted.status,200);assert.equal((reverted.data as AgentTaskSnapshot).run.status,'reverted');
 assert.equal((await f.request(`${f.prefix}/${ended.run.id}/actions`,'POST',undo)).status,200);
 const receipt=await f.request(`${f.prefix}/${ended.run.id}/actions/${undo.requestId}`);assert.ok(object(receipt.data)&&receipt.data.found===true);
 assert.equal(f.models,2);
});
test('policy activation requires explicit fee acknowledgement and retained exact request lookup',async t=>{
 const f=await fixture(t),before=await f.request('/api/agent/tasks/v2/policy');assert.ok(object(before.data));const policy=before.data.policy as AgentTaskPolicy;
 const input={...policy,requestId:randomUUID(),expectedRevision:policy.revision,modes:{...policy.modes,paid:'direct'}};
 assert.equal((await f.request('/api/agent/tasks/v2/policy','PUT',input)).status,409);
 const updated=await f.request('/api/agent/tasks/v2/policy','PUT',{...input,acknowledgePaid:true});assert.equal(updated.status,200);
 const replay=await f.request('/api/agent/tasks/v2/policy','PUT',{...input,acknowledgePaid:true});assert.equal(replay.status,200);
 const receipt=await f.request(`/api/agent/tasks/v2/policy/requests/${input.requestId}`);assert.ok(object(receipt.data)&&receipt.data.found===true);
 assert.equal(f.models,0);
});
test('editor claims and control lookup remain project scoped and stale releases fail',async t=>{
 const f=await fixture(t),shot=await f.request('/api/rpc','POST',{operation:'shot.create',input:{projectId:f.projectId,title:'Protected'}});assert.ok(object(shot.data)&&typeof shot.data.id==='string');
 const shotId=shot.data.id;const listed=await f.request(`/api/agent/tasks/v2/editing?projectId=${f.projectId}`);assert.ok(object(listed.data));const target=(listed.data.targets as {kind:string;id:string;revision:number}[]).find(item=>item.kind==='shot'&&item.id===shotId);assert.ok(target);
 const input={requestId:randomUUID(),action:'claim',projectId:f.projectId,ownerId:randomUUID(),generation:0,sequence:1,targets:[target]};
 assert.equal((await f.request('/api/agent/tasks/v2/editing','POST',input)).status,200);
 assert.equal((await f.request('/api/agent/tasks/v2/editing','POST',{...input,requestId:randomUUID(),action:'release',sequence:0})).status,409);
 const active=await f.request(`/api/agent/tasks/v2/editing?projectId=${f.projectId}&ownerId=${input.ownerId}`);assert.ok(object(active.data)&&Array.isArray(active.data.claims));assert.equal(active.data.claims.length,1);assert.equal(f.models,0);
});
test('workspace backup refuses a live v2 model after its HTTP acceptance has finished',async t=>{
 let enter=()=>{},release=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
 const gateway:TaskGateway=async function*(request){request.beforeSubmit?.();enter();await released;yield {type:'done',output:{text:'合成完成',toolCalls:[],providerOutput:{role:'assistant',content:'合成完成'}}};};
 const f=await fixture(t,'chat_completions',gateway),backupDirectory=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-v2-backup-destination-'));
 t.after(async()=>{await rm(backupDirectory,{recursive:true,force:true});});
 try{
  f.server.setBackupDirectory(backupDirectory);await f.authorize();
  const sent=await f.request(f.prefix,'POST',{requestId:randomUUID(),text:'等待本地合成模型',expectedSettingsRevision:(await f.settings.get()).revision});assert.equal(sent.status,200);await entered;
  const blocked=await f.request('/api/rpc','POST',{operation:'workspace.backup.create',input:{requestId:randomUUID()}});assert.equal(blocked.status,409);assert.ok(object(blocked.error));assert.equal(blocked.error.code,'WORKSPACE_BACKUP_BUSY');
  release();const done=await f.settle((sent.data as AgentTaskSnapshot).run.id);assert.equal(done.run.status,'completed');
  const saved=await f.request('/api/rpc','POST',{operation:'workspace.backup.create',input:{requestId:randomUUID()}});assert.equal(saved.status,200,JSON.stringify(saved.error));
 }finally{release();}
});
