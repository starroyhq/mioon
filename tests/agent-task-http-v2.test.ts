import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startServer} from '../apps/server/src/index.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {deriveAgentEndpoint} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskSnapshot,AgentTaskPolicy,AgentTaskJson,AgentTaskHistoryPage,AgentTaskConversationPage} from '../packages/contracts/src/agent-tasks-v2.ts';
import {agentTaskSnapshotSchema,agentTaskHistoryPageSchema,agentTaskConversationPageSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {TaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
async function cliSnapshot(url:string,token:string,projectId:string,runId:string):Promise<AgentTaskSnapshot>;
async function cliSnapshot(url:string,token:string,projectId:string,conversationId:string,command:'history'):Promise<AgentTaskHistoryPage>;
async function cliSnapshot(url:string,token:string,projectId:string,conversationId:string,command:'conversation'):Promise<AgentTaskConversationPage>;
async function cliSnapshot(url:string,token:string,projectId:string,runId:string,command:'status'|'history'|'conversation'='status'):Promise<AgentTaskSnapshot|AgentTaskHistoryPage|AgentTaskConversationPage>{
 const entry=fileURLToPath(new URL('../apps/cli/src/index.ts',import.meta.url)),child=spawn(process.execPath,[entry,'agent','task',command,'--input',JSON.stringify(command==='status'?{projectId,runId}:command==='history'?{projectId}:{projectId,conversationId:runId})],{env:{...process.env,MIOON_BASE_URL:url,MIOON_TOKEN:token,MIOON_ENABLE_LIVE_PROVIDER:'0'},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{stdout+=chunk;});child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{stderr+=chunk;});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Synthetic CLI status timed out'));},15000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('Synthetic CLI status failed'));});});
 assert.equal(stdout.includes(token),false);assert.equal(stderr.includes(token),false);const value:unknown=JSON.parse(stdout);assert.ok(object(value)&&value.ok===true);return command==='history'?agentTaskHistoryPageSchema.parse(value.data):command==='conversation'?agentTaskConversationPageSchema.parse(value.data):agentTaskSnapshotSchema.parse(value.data);
}
async function fixture(t:TestContext,protocol:AgentConfiguration['protocol']='chat_completions',customGateway?:TaskGateway){
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-task-http-v2-'));
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});const initial=await settings.get();
 await settings.put({expectedRevision:initial.revision,configuration:{...initial.configuration,protocol},secret:{action:'replace',storage:'session',value:'SYNTHETIC_TASK_HTTP_KEY'}});
 let models=0;
 const gateway:TaskGateway=async function*(request){models++;const body=JSON.parse(request.body) as {messages?:{role?:string}[];input?:{type?:string}[]};
  const answered=body.messages?.some(item=>item.role==='tool')||body.input?.some(item=>item.type==='function_call_output');
  if(answered){yield {type:'delta',text:'已完成本地创建'};yield {type:'done',output:{text:'已完成本地创建',toolCalls:[],providerOutput:(protocol==='responses'?[{id:'message_final',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'已完成本地创建',annotations:[]}]}]:{role:'assistant',content:'已完成本地创建'}) as AgentTaskJson}};}
  else {const toolCall={id:'call_http',name:'mioon_shot_create',arguments:{title:'HTTP 创建的镜头',duration:4,aspectRatio:'16:9'}};yield {type:'done',output:{text:'',toolCalls:[toolCall],providerOutput:(protocol==='responses'?[{id:'fc_http',call_id:toolCall.id,type:'function_call',name:toolCall.name,arguments:JSON.stringify(toolCall.arguments),status:'completed'}]:{role:'assistant',content:null,tool_calls:[{id:toolCall.id,type:'function',function:{name:toolCall.name,arguments:JSON.stringify(toolCall.arguments)}}]}) as AgentTaskJson}};}
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
 assert.ok(ended.executionEndedAt);assert.equal(Object.hasOwn(ended.run,'executionEndedAt'),false);
 assert.ok(ended.steps.every(step=>step.request===undefined&&step.data===undefined));assert.equal(ended.changes[0]!.before,null);assert.equal(ended.changes[0]!.after,null);assert.equal(ended.changes[0]!.undo,undefined);
 assert.ok(agentTaskSnapshotSchema.safeParse(ended).success);const display=ended.changes[0]!.display;assert.ok(display);assert.equal(display.operation,'shot.create');assert.equal(display.targets[0]?.name,'HTTP 创建的镜头');assert.equal(display.fields.find(field=>field.property==='durationSeconds')?.after,4);assert.equal(display.fields.find(field=>field.property==='aspectRatio')?.after,'16:9');
 const cli=await cliSnapshot(f.server.url,f.server.token,f.projectId,ended.run.id);assert.deepEqual(cli.changes[0]?.display,display);assert.equal(cli.changes[0]?.before,null);assert.equal(cli.changes[0]?.after,null);assert.equal(cli.changes[0]?.undo,undefined);
 assert.equal(cli.executionEndedAt,ended.executionEndedAt);
 assert.equal((await f.request(f.prefix,'POST',input)).status,200);assert.equal(f.models,2);
 const lookup=await f.request(`${f.prefix}/requests/${input.requestId}`);assert.ok(object(lookup.data)&&lookup.data.found===true);
 const controller=new AbortController();const stream=await fetch(`${f.server.url}${f.prefix}/${ended.run.id}/events?after=0`,{headers:{Authorization:`Bearer ${f.server.token}`},signal:controller.signal});
 assert.equal(stream.status,200);const reader=stream.body!.getReader(),frame=await reader.read();assert.equal(frame.done,false);assert.match(new TextDecoder().decode(frame.value),/event: changed/u);controller.abort();await reader.cancel().catch(()=>{});
 const undo={requestId:randomUUID(),expectedRevision:ended.run.revision,action:'undo_all'};
 const reverted=await f.request(`${f.prefix}/${ended.run.id}/actions`,'POST',undo);assert.equal(reverted.status,200);assert.equal((reverted.data as AgentTaskSnapshot).run.status,'reverted');
 assert.equal((reverted.data as AgentTaskSnapshot).executionEndedAt,ended.executionEndedAt);
 assert.equal((await f.request(`${f.prefix}/${ended.run.id}/actions`,'POST',undo)).status,200);
 const receipt=await f.request(`${f.prefix}/${ended.run.id}/actions/${undo.requestId}`);assert.ok(object(receipt.data)&&receipt.data.found===true);
 assert.equal(f.models,2);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: paid approval exposes safe typed original plan without submitting generation`,async t=>{
 let shotId='',shotRevision=0;
 const gateway:TaskGateway=async function*(){
  const toolCall={id:'call_generation_preview',name:'mioon_generation_submit',arguments:{shotId,expectedRevision:shotRevision,providerId:'mock',model:'mock-motion-v1',parameters:{seed:123}}};
  yield {type:'done',output:{text:'synthetic preview',toolCalls:[toolCall],providerOutput:protocol==='responses'?[{id:'fc_preview',call_id:toolCall.id,type:'function_call',name:toolCall.name,arguments:JSON.stringify(toolCall.arguments),status:'completed'}]:{role:'assistant',content:null,tool_calls:[{id:toolCall.id,type:'function',function:{name:toolCall.name,arguments:JSON.stringify(toolCall.arguments)}}]}}};
 };
 const f=await fixture(t,protocol,gateway);const shot=await f.request('/api/rpc','POST',{operation:'shot.create',input:{projectId:f.projectId,title:'Approval target',duration:6,aspectRatio:'16:9',prompt:'DO_NOT_PROJECT_GENERATION_PROMPT'}});assert.equal(shot.status,200);assert.ok(object(shot.data));shotId=String(shot.data.id);shotRevision=Number(shot.data.revision);await f.authorize();
 const sent=await f.request(f.prefix,'POST',{requestId:randomUUID(),text:'synthetic approval preview',expectedSettingsRevision:(await f.settings.get()).revision});assert.equal(sent.status,200);const pending=await f.settle((sent.data as AgentTaskSnapshot).run.id);assert.equal(pending.run.status,'awaiting_approval');assert.equal(pending.changes.length,0);assert.ok(agentTaskSnapshotSchema.safeParse(pending).success);
 const planned=pending.steps.find(step=>step.kind==='tool')?.display;assert.ok(planned);assert.equal(planned.targets[0]?.name,'Approval target');assert.equal(planned.fields.find(field=>field.property==='durationSeconds')?.after,6);assert.equal(planned.fields.find(field=>field.property==='seed')?.after,123);assert.equal(planned.fields.find(field=>field.property==='mode')?.after,'text_to_video');assert.ok(planned.fields.every(field=>field.before===undefined));assert.doesNotMatch(JSON.stringify(planned),/DO_NOT_PROJECT|prompt|snapshot|requestId|expectedRevision/u);
 const jobs=await f.request('/api/rpc','POST',{operation:'job.list',input:{projectId:f.projectId}});assert.equal(jobs.status,200);assert.deepEqual(jobs.data,[]);
 const lookup=await f.request(`${f.prefix}/requests/${(sent.data as AgentTaskSnapshot).run.requestId}`);assert.ok(object(lookup.data)&&object(lookup.data.snapshot));assert.deepEqual((lookup.data.snapshot as unknown as AgentTaskSnapshot).steps.find(step=>step.kind==='tool')?.display,planned);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: conflict snapshot reads current saved values on the server without exposing raw evidence or replaying work`,async t=>{
 let shotId='',shotRevision=0,models=0,enter=()=>{},release=()=>{};
 const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
 const gateway:TaskGateway=async function*(request){
  models++;request.beforeSubmit?.();enter();await released;
  const toolCall={id:'call_conflict_current',name:'mioon_shot_update',arguments:{shotId,expectedRevision:shotRevision,patch:{duration:4,prompt:'Mio original plan'}}};
  yield {type:'done',output:{text:'',toolCalls:[toolCall],providerOutput:protocol==='responses'?[{id:'fc_conflict_current',call_id:toolCall.id,type:'function_call',name:toolCall.name,arguments:JSON.stringify(toolCall.arguments),status:'completed'}]:{role:'assistant',content:null,tool_calls:[{id:toolCall.id,type:'function',function:{name:toolCall.name,arguments:JSON.stringify(toolCall.arguments)}}]}}};
 };
 const f=await fixture(t,protocol,gateway);
 try{
  const created=await f.request('/api/rpc','POST',{operation:'shot.create',input:{projectId:f.projectId,title:'Conflict target',duration:2,prompt:'Saved original'}});assert.equal(created.status,200);assert.ok(object(created.data));shotId=String(created.data.id);shotRevision=Number(created.data.revision);await f.authorize();
  const sent=await f.request(f.prefix,'POST',{requestId:randomUUID(),text:'synthetic conflict',expectedSettingsRevision:(await f.settings.get()).revision});assert.equal(sent.status,200);await entered;
  const changed=await f.request('/api/rpc','POST',{operation:'shot.update',input:{shotId,expectedRevision:shotRevision,patch:{duration:3,prompt:'Saved manual change'}}});assert.equal(changed.status,200);assert.ok(object(changed.data));release();
  const paused=await f.settle((sent.data as AgentTaskSnapshot).run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'conflict');assert.ok(agentTaskSnapshotSchema.safeParse(paused).success);assert.equal(paused.changes.length,0);
  const pending=paused.steps.findLast(step=>step.kind==='tool');assert.ok(pending?.display);assert.equal(pending.display.fields.find(field=>field.property==='durationSeconds')?.after,4);assert.equal(pending.display.fields.find(field=>field.property==='durationSeconds')?.current,3);assert.equal(pending.display.fields.find(field=>field.property==='description')?.current,'Saved manual change');assert.ok(pending.display.fields.every(field=>field.before===undefined));assert.equal(pending.data,undefined);assert.equal(pending.request,undefined);
  const changedAgain=await f.request('/api/rpc','POST',{operation:'shot.update',input:{shotId,expectedRevision:changed.data.revision,patch:{duration:5,prompt:'Latest saved change /private/hidden apiKey=SYNTHETIC_SAVED_PRIVATE'}}});assert.equal(changedAgain.status,200);
  const refreshed=await f.request(`${f.prefix}/${paused.run.id}`);assert.equal(refreshed.status,200);const fresh=agentTaskSnapshotSchema.parse(refreshed.data),freshStep=fresh.steps.find(step=>step.id===pending.id),display=freshStep?.display;assert.ok(display);assert.equal(display.fields.find(field=>field.property==='durationSeconds')?.current,5);assert.equal(display.fields.find(field=>field.property==='durationSeconds')?.after,4);assert.equal(display.fields.find(field=>field.property==='description')?.current,'Latest saved change /private/hidden apiKey=SYNTHETIC_SAVED_PRIVATE');assert.doesNotMatch(JSON.stringify(display),/Saved manual change/u);assert.equal(freshStep?.data,undefined);assert.equal(freshStep?.request,undefined);assert.equal(models,1);assert.equal(fresh.changes.length,0);
 }finally{release();}
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: REST validates locale and keeps original request lookup and language conflicts`,async t=>{
  const requests:string[]=[],gateway:TaskGateway=async function*(request){requests.push(request.body);yield {type:'done',output:{text:'synthetic',toolCalls:[],providerOutput:protocol==='responses'?[]:{role:'assistant',content:'synthetic'}}};};
  const f=await fixture(t,protocol,gateway);await f.authorize();
  const input={requestId:randomUUID(),text:'synthetic',expectedSettingsRevision:(await f.settings.get()).revision,locale:'ja'};
  for(const locale of ['zh-CN','fr',null,1]){const result=await f.request(f.prefix,'POST',{...input,locale});assert.equal(result.status,400);assert.ok(object(result.error));assert.equal(result.error.code,'AGENT_TASK_INVALID');}
  assert.equal(requests.length,0);
  const sent=await f.request(f.prefix,'POST',input);assert.equal(sent.status,200);const run=(sent.data as AgentTaskSnapshot).run;await f.settle(run.id);
  const lookup=await f.request(`${f.prefix}/requests/${input.requestId}`);assert.ok(object(lookup.data)&&object(lookup.data.snapshot));assert.equal((lookup.data.snapshot as unknown as AgentTaskSnapshot).run.id,run.id);
  assert.equal((await f.request(f.prefix,'POST',input)).status,200);const conflict=await f.request(f.prefix,'POST',{...input,locale:'en'});assert.equal(conflict.status,409);assert.ok(object(conflict.error));assert.equal(conflict.error.code,'AGENT_TASK_REQUEST_CONFLICT');assert.equal(requests.length,1);
  const body=JSON.parse(requests[0]!) as {instructions?:string;messages?:{content:string}[]};assert.ok((body.instructions??body.messages![0]!.content).includes('簡潔な日本語'));
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

for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: HTTP and CLI share conversation grouping, scoped members, diagnostics exclusion and receipt identity`,async t=>{
 const bodies:string[]=[];const gateway:TaskGateway=async function*(request){request.beforeSubmit?.();bodies.push(request.body);yield {type:'done',output:{text:`reply ${bodies.length}`,toolCalls:[],providerOutput:protocol==='responses'?[]:{role:'assistant',content:`reply ${bodies.length}`}}};};
 const f=await fixture(t,protocol,gateway);await f.authorize();const revision=(await f.settings.get()).revision;
 const send=async(text:string,conversationId?:string,requestId:string=randomUUID(),diagnostic?:{profile:'text'})=>f.request(f.prefix,'POST',{requestId,text,expectedSettingsRevision:revision,...(conversationId?{conversationId}:{}),...(diagnostic?{diagnostic}:{})});
 const firstResponse=await send('First conversation'),first=agentTaskSnapshotSchema.parse(firstResponse.data);assert.equal(firstResponse.status,200);await f.settle(first.run.id);assert.ok(first.run.conversationId);
 const other=agentTaskSnapshotSchema.parse((await send('Other conversation private')).data);await f.settle(other.run.id);
 const continuationId=randomUUID(),next=agentTaskSnapshotSchema.parse((await send('Continue first',first.run.conversationId,continuationId)).data);await f.settle(next.run.id);assert.equal(next.run.conversationId,first.run.conversationId);assert.ok(bodies[2]?.includes('First conversation'));assert.doesNotMatch(bodies[2]!,/Other conversation private/u);
 const diagnostic=agentTaskSnapshotSchema.parse((await send('PRIVATE_DIAGNOSTIC',undefined,randomUUID(),{profile:'text'})).data);await f.settle(diagnostic.run.id);
 const last=agentTaskSnapshotSchema.parse((await send('After diagnostic',first.run.conversationId)).data);await f.settle(last.run.id);assert.doesNotMatch(bodies.at(-1)!,/PRIVATE_DIAGNOSTIC|Other conversation private/u);
 const history=agentTaskHistoryPageSchema.parse((await f.request(`${f.prefix}/history`)).data);assert.equal(history.conversations.length,2);assert.equal(history.conversations.find(item=>item.id===first.run.conversationId)?.runCount,3);assert.deepEqual(await cliSnapshot(f.server.url,f.server.token,f.projectId,'','history'),history);
 const memberRoute=`${f.prefix}/conversations/${first.run.conversationId}`,members=agentTaskConversationPageSchema.parse((await f.request(memberRoute)).data);assert.equal(members.runs.length,3);assert.ok(members.runs.every(run=>!Object.hasOwn(run,'context')));assert.deepEqual(await cliSnapshot(f.server.url,f.server.token,f.projectId,first.run.conversationId!,'conversation'),members);
 const before=bodies.length;assert.equal((await send('missing',randomUUID())).status,404);const foreign=await f.request('/api/rpc','POST',{operation:'project.create',input:{name:'Foreign conversation owner'}});assert.ok(object(foreign.data)&&typeof foreign.data.id==='string');assert.equal((await f.request(`/api/agent/tasks/v2/${foreign.data.id}/conversations/${first.run.conversationId}`)).status,404);assert.equal((await f.request(`${f.prefix}/conversations/${diagnostic.run.conversationId}`)).status,404);
 assert.equal((await send('Continue first',undefined,continuationId)).status,409);assert.equal((await send('First conversation',first.run.conversationId,first.run.requestId)).status,409);assert.equal((await send('Continue first',first.run.conversationId,continuationId)).status,200);assert.equal(bodies.length,before);
});

async function cliTaskControl(url:string,token:string,command:string,input:Record<string,unknown>):Promise<AgentTaskSnapshot>{
 const entry=fileURLToPath(new URL('../apps/cli/src/index.ts',import.meta.url)),child=spawn(process.execPath,[entry,'agent','task',command,'--input',JSON.stringify(input)],{env:{...process.env,MIOON_BASE_URL:url,MIOON_TOKEN:token,MIOON_ENABLE_LIVE_PROVIDER:'0'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',(value:string)=>{stdout+=value;});child.stderr.setEncoding('utf8').on('data',(value:string)=>{stderr+=value;});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Synthetic CLI control timed out'));},15000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('Synthetic CLI control failed'));});});assert.equal(stdout.includes(token),false);assert.equal(stderr.includes(token),false);const envelope:unknown=JSON.parse(stdout);assert.ok(object(envelope)&&envelope.ok===true);return agentTaskSnapshotSchema.parse(envelope.data);
}
test('HTTP and CLI notes use the same durable queue and control receipt without changing a submitted request',async t=>{
 let enter=()=>{},release=()=>{},models=0;const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;}),bodies:string[]=[];
 const gateway:TaskGateway=async function*(request){bodies.push(request.body);models++;request.beforeSubmit?.();if(models===1){enter();await released;}yield {type:'done',output:{text:'Synthetic response',toolCalls:[],providerOutput:{role:'assistant',content:'Synthetic response'}}};};
 const f=await fixture(t,'chat_completions',gateway);try{await f.authorize();const sent=await f.request(f.prefix,'POST',{requestId:randomUUID(),text:'HTTP and CLI notes',expectedSettingsRevision:(await f.settings.get()).revision}),run=agentTaskSnapshotSchema.parse(sent.data).run;await entered;
 const current=agentTaskSnapshotSchema.parse((await f.request(`${f.prefix}/${run.id}`)).data),http={requestId:randomUUID(),expectedRevision:current.run.revision,action:'note',text:'HTTP_ADDITIONAL_NOTE'};
 const noted=await f.request(`${f.prefix}/${run.id}/actions`,'POST',http);assert.equal(noted.status,200);const one=agentTaskSnapshotSchema.parse(noted.data);assert.equal(one.run.notes?.[0]?.requestId,http.requestId);
 const cliId=randomUUID(),two=await cliTaskControl(f.server.url,f.server.token,'note',{projectId:f.projectId,runId:run.id,requestId:cliId,expectedRevision:one.run.revision,text:'CLI_ADDITIONAL_NOTE'});assert.equal(two.run.notes?.length,2);assert.equal(two.run.notes?.[1]?.requestId,cliId);assert.doesNotMatch(bodies[0]!,/ADDITIONAL_NOTE/);
 const lookup=await f.request(`${f.prefix}/${run.id}/actions/${cliId}`);assert.ok(object(lookup.data)&&object(lookup.data.receipt));assert.equal(lookup.data.receipt.action,'note');assert.deepEqual(lookup.data.receipt.result,{state:'completed',noteRequestId:cliId});
 release();const done=await f.settle(run.id);assert.equal(done.run.status,'completed');assert.equal(models,2);assert.match(bodies[1]!,/HTTP_ADDITIONAL_NOTE/);assert.match(bodies[1]!,/CLI_ADDITIONAL_NOTE/);assert.ok(done.run.notes?.every(note=>note.modelStepId));
 }finally{release();}
});
test('HTTP conflict resume fails closed and CLI skip keeps the saved target with a durable receipt',async t=>{
 let enter=()=>{},release=()=>{},models=0,shotId='',revision=0;const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
 const gateway:TaskGateway=async function*(request){models++;request.beforeSubmit?.();if(models===1){enter();await released;const toolCall={id:'http_skip_conflict',name:'mioon_shot_update',arguments:{shotId,expectedRevision:revision,patch:{prompt:'stale AI plan'}}};yield {type:'done',output:{text:'',toolCalls:[toolCall],providerOutput:{role:'assistant',content:null,tool_calls:[{id:toolCall.id,type:'function',function:{name:toolCall.name,arguments:JSON.stringify(toolCall.arguments)}}]} as AgentTaskJson}};}else yield {type:'done',output:{text:'User edit kept',toolCalls:[],providerOutput:{role:'assistant',content:'User edit kept'} as AgentTaskJson}};};
 const f=await fixture(t,'chat_completions',gateway);try{const created=await f.request('/api/rpc','POST',{operation:'shot.create',input:{projectId:f.projectId,title:'Skip HTTP target',prompt:'original'}});assert.ok(object(created.data));shotId=String(created.data.id);revision=Number(created.data.revision);await f.authorize();const sent=await f.request(f.prefix,'POST',{requestId:randomUUID(),text:'HTTP conflict skip',expectedSettingsRevision:(await f.settings.get()).revision}),run=agentTaskSnapshotSchema.parse(sent.data).run;await entered;
 assert.equal((await f.request('/api/rpc','POST',{operation:'shot.update',input:{shotId,expectedRevision:revision,patch:{prompt:'manual preserved'}}})).status,200);release();const paused=await f.settle(run.id);assert.equal(paused.run.pauseReason,'conflict');
 const denied=await f.request(`${f.prefix}/${run.id}/actions`,'POST',{requestId:randomUUID(),expectedRevision:paused.run.revision,action:'resume'});assert.equal(denied.status,409);assert.ok(object(denied.error));assert.equal(denied.error.code,'AGENT_TASK_SKIP_REQUIRED');
 const requestId=randomUUID(),skipped=await cliTaskControl(f.server.url,f.server.token,'skip',{projectId:f.projectId,runId:run.id,requestId,expectedRevision:paused.run.revision});assert.equal(skipped.run.skippedTargets?.[0]?.target.id,shotId);const done=await f.settle(run.id);assert.equal(done.run.status,'completed');assert.equal(done.changes.length,0);assert.equal(models,2);assert.equal(done.steps.find(step=>step.kind==='tool')?.status,'denied');
 const lookup=await f.request(`${f.prefix}/${run.id}/actions/${requestId}`);assert.ok(object(lookup.data)&&object(lookup.data.receipt));assert.deepEqual(lookup.data.receipt.result,{state:'completed',skippedTargets:[{kind:'shot',id:shotId}]});const inspected=await f.request('/api/rpc','POST',{operation:'shot.inspect',input:{projectId:f.projectId}});assert.equal(inspected.status,200);assert.ok(object(inspected.data)&&Array.isArray(inspected.data.items));const saved=inspected.data.items.find(item=>object(item)&&item.id===shotId);assert.ok(object(saved));assert.equal(saved.prompt,'manual preserved');
 }finally{release();}
});

for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: HTTP note capacity rejection has a durable receipt and CLI reads the unchanged run`,async t=>{
 let enter=()=>{},release=()=>{},models=0;const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
 const gateway:TaskGateway=async function*(request){models++;request.beforeSubmit?.();if(models===1){enter();await released;}yield {type:'done',output:{text:'Synthetic response',toolCalls:[],providerOutput:protocol==='responses'?[]:{role:'assistant',content:'Synthetic response'}}};};
 const f=await fixture(t,protocol,gateway);
 try{
  await f.authorize();const sent=await f.request(f.prefix,'POST',{requestId:randomUUID(),text:'Capacity check',expectedSettingsRevision:(await f.settings.get()).revision});const run=agentTaskSnapshotSchema.parse(sent.data).run;await entered;
  let current=agentTaskSnapshotSchema.parse((await f.request(`${f.prefix}/${run.id}`)).data);
  for(let index=0;index<4;index++){const accepted=await f.request(`${f.prefix}/${run.id}/actions`,'POST',{requestId:randomUUID(),expectedRevision:current.run.revision,action:'note',text:String(index).repeat((index===3?16:32)*1024)});assert.equal(accepted.status,200);current=agentTaskSnapshotSchema.parse(accepted.data);}
  const requestId=randomUUID(),rejected=await f.request(`${f.prefix}/${run.id}/actions`,'POST',{requestId,expectedRevision:current.run.revision,action:'note',text:'x'.repeat(16*1024)});assert.equal(rejected.status,409);assert.ok(object(rejected.error));assert.equal(rejected.error.code,'AGENT_TASK_NOTE_CAPACITY');
  const lookup=await f.request(`${f.prefix}/${run.id}/actions/${requestId}`);assert.ok(object(lookup.data)&&object(lookup.data.receipt));assert.deepEqual(lookup.data.receipt.result,{state:'rejected',code:'AGENT_TASK_NOTE_CAPACITY'});
  const fromCli=await cliSnapshot(f.server.url,f.server.token,f.projectId,run.id);assert.deepEqual(fromCli,current);assert.equal(models,1);release();const done=await f.settle(run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.notes?.length,4);assert.equal(models,2);
 }finally{release();}
});
