import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {createTestAuthorizations} from './helpers/agent-authorizations.ts';
import type {TaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
async function crashFixture(t:TestContext,protocol:string,boundary:string){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-v2-sigkill-'));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./helpers/agent-task-v2-crash-process.ts',import.meta.url))],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,FIXTURE_ROOT:root,FIXTURE_PROTOCOL:protocol,FIXTURE_BOUNDARY:boundary},stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.setEncoding('utf8').on('data',(value:string)=>{stderr+=value;});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rmSync(root,{recursive:true,force:true});});
 const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 assert.equal(result.signal,'SIGKILL',stderr);
 const fixture=JSON.parse(readFileSync(path.join(root,'fixture.json'),'utf8')) as {projectId:string;shotId:string;requestId:string};
 const trace=readFileSync(path.join(root,'trace.jsonl'),'utf8');assert.equal(JSON.parse(trace.trim().split('\n').at(-1)!).kind,boundary);
 return {root,...fixture,trace};
}
for(const protocol of ['chat_completions','responses'] as const)for(const boundary of ['model_intent','model_send','tool_before_commit','tool_after_commit','generation_accept','result_commit'])test(`${protocol}: SIGKILL ${boundary} preserves atomic progress and never resubmits`,{timeout:25000},async t=>{
 const f=await crashFixture(t,protocol,boundary),store=openStore(f.root),services=createServices(store,new Map());
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initial=await settings.get();
 await settings.put({expectedRevision:0,configuration:{...initial.configuration,protocol},secret:{action:'replace',storage:'session',value:'SYNTHETIC_CRASH_ONLY'}});
 const tools=createAgentTaskTools({store,services});let modelRequests=0;
 const gateway:TaskGateway=async function*(){modelRequests++;yield {type:'done',output:{text:'Recovered without repeat',toolCalls:[],providerOutput:protocol==='responses'?[]:{role:'assistant',content:'Recovered without repeat'}}};};
 const runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations:createTestAuthorizations(()=>({...store}),settings),tools,gateway,selfPort:()=>4318});
 t.after(async()=>{runtime.close();await runtime.drain();tools.dispose();await services.drain();await settings.close();store.close();});
 const found=runtime.lookup(f.projectId,f.requestId);assert.ok(found.snapshot);let snapshot=found.snapshot;
 assert.equal(snapshot.run.status,'interrupted');assert.equal(modelRequests,0);
 const expectedTitle=boundary==='tool_after_commit'?'After atomic AI edit':'Before';assert.equal(store.db.prepare("SELECT json_extract(data,'$.title') AS title FROM shots WHERE id=?").get(f.shotId)?.title,expectedTitle);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()!.n,['generation_accept','result_commit'].includes(boundary)?1:0);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM image_versions').get()!.n,boundary==='result_commit'?1:0);
 const command=(action:string,extra:Record<string,unknown>={})=>runtime.action(f.projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});
 const unknown=snapshot.steps.find(step=>step.status==='unknown');
 if(unknown){await assert.rejects(command('resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(modelRequests,0);
  if(unknown.kind==='model')snapshot=await command('resolve_unknown',{stepId:unknown.id,resolution:'discard'});
  else if(unknown.toolCall?.name==='mioon_task_wait')snapshot=await command('resolve_unknown',{stepId:unknown.id,resolution:'accept_result'});
  else snapshot=await command('resolve_unknown',{stepId:unknown.id,resolution:'discard'});
 }
 if(snapshot.run.status==='interrupted'){await command('resume');await runtime.drain();snapshot=runtime.get(f.projectId,snapshot.run.id);assert.equal(snapshot.run.status,'completed',JSON.stringify(snapshot));assert.equal(modelRequests,1);}
 assert.equal(store.db.prepare("SELECT json_extract(data,'$.title') AS title FROM shots WHERE id=?").get(f.shotId)?.title,expectedTitle);assert.equal(store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()!.n,['generation_accept','result_commit'].includes(boundary)?1:0);
 assert.equal(readFileSync(path.join(f.root,'trace.jsonl'),'utf8'),f.trace);
});
