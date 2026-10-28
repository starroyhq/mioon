// This owned process has only a synthetic gateway and a local PNG renderer.
// SIGKILL intentionally bypasses shutdown and SQLite transaction cleanup.
import {appendFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import {createAgentTaskRuntime} from '../../packages/business/src/agent/task-runtime-v2.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {createMockImageAdapter} from '../../packages/business/src/images/adapter.ts';
import {createTestAuthorizations,authorizeTestScope} from './agent-authorizations.ts';
import type {AgentTaskJson,AgentTaskToolCall} from '../../packages/contracts/src/agent-tasks-v2.ts';
import type {TaskGateway,TaskModelOutput} from '../../packages/business/src/agent/task-gateway-v2.ts';
const root=process.env.FIXTURE_ROOT!,boundary=process.env.FIXTURE_BOUNDARY!,protocol=process.env.FIXTURE_PROTOCOL==='responses'?'responses':'chat_completions';
const trace=(kind:string)=>appendFileSync(path.join(root,'trace.jsonl'),JSON.stringify({kind})+'\n');
const crash=()=>{trace(boundary);process.kill(process.pid,'SIGKILL');};
const store=openStore(root);let ready=false;const originalTx=store.tx;
store.tx=fn=>{const value=originalTx(fn);if(ready){
 if(boundary==='model_intent'&&store.db.prepare("SELECT 1 FROM agent_task_steps_v2 WHERE position=1 AND status='intent'").get())crash();
 if(boundary==='tool_after_commit'&&store.db.prepare("SELECT 1 FROM shots WHERE json_extract(data,'$.title')='After atomic AI edit'").get())crash();
 if(boundary==='generation_accept'&&store.db.prepare('SELECT 1 FROM image_tasks LIMIT 1').get())crash();
 if(boundary==='result_commit'&&store.db.prepare("SELECT 1 FROM image_tasks WHERE state='succeeded' LIMIT 1").get())crash();
 }return value;};
const services=createServices(store,new Map(),{imageOptions:{generate:async(snapshot,context)=>{trace('image_dispatch');return createMockImageAdapter().generate(snapshot,context);}}});
const project=await services.call('project.create',{name:'Owned SIGKILL fixture'}) as {id:string};
const shot=await services.call('shot.create',{projectId:project.id,title:'Before'}) as {id:string;revision:number};
const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initial=await settings.get();
await settings.put({expectedRevision:0,configuration:{...initial.configuration,protocol},secret:{action:'replace',storage:'session',value:'SYNTHETIC_CRASH_ONLY'}});
const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
const base=createAgentTaskTools({store,services});
const tools={...base,async execute(prepared:Parameters<typeof base.execute>[0],context:Parameters<typeof base.execute>[1]){
 return base.execute(prepared,{...context,recordInside(result,changes){context.recordInside(result,changes);if(boundary==='tool_before_commit'&&prepared.operation==='shot.update')crash();}});
}};
let modelCount=0;
const output=(calls:AgentTaskToolCall[]=[]):TaskModelOutput=>({text:calls.length?'':'Completed locally',toolCalls:calls,providerOutput:protocol==='responses'?calls.map(call=>({type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments),status:'completed'})):{role:'assistant',content:'Completed locally',tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}});
const generated=boundary==='generation_accept'||boundary==='result_commit';
const gateway:TaskGateway=async function*(request){request.beforeSubmit?.();trace('model');if(boundary==='model_send')crash();modelCount++;let calls:AgentTaskToolCall[]=[];
 if(modelCount===1)calls=[{id:randomUUID(),name:'mioon_tools_load',arguments:{groups:[generated?'images':'canvas']}}];
 else if(modelCount===2)calls=[{id:randomUUID(),name:generated?'mioon_image_generate':'mioon_shot_update',arguments:generated?{name:'Local PNG',prompt:'Synthetic local PNG',providerId:'mock',model:'mock-image-v1',options:{size:'1024x1024',quality:'low',background:'opaque',outputFormat:'png',n:1}}:{shotId:shot.id,expectedRevision:1,patch:{title:'After atomic AI edit'}}}];
 else if(generated&&modelCount===3){const task=store.db.prepare('SELECT id FROM image_tasks LIMIT 1').get();if(!task)throw Error('No accepted image task');calls=[{id:randomUUID(),name:'mioon_task_wait',arguments:{kind:'image',id:String(task.id)}}];}
 yield {type:'done',output:output(calls)};
};
const runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});
runtime.journal.updatePolicy({...runtime.policy(),modes:{...runtime.policy().modes,paid:'direct'}});
ready=true;
const requestId=randomUUID();writeFileSync(path.join(root,'fixture.json'),JSON.stringify({projectId:project.id,shotId:shot.id,requestId,protocol}));
await runtime.send(project.id,{requestId,text:'Owned crash test',expectedSettingsRevision:(await settings.get()).revision});
setTimeout(()=>{throw Error('SIGKILL boundary not reached');},15000);
