import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import {agentTaskCheckSchema,agentTaskChecksSchema,agentTaskChecksInputSchema,AGENT_TASK_CHECK_GROUPS,DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskChecks} from '../packages/contracts/src/agent-tasks-v2.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {createAgentClient,AGENT_COMMAND_SCHEMAS,agentInputSchema} from '../packages/client/src/agent.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskHttp} from '../apps/server/src/agent-task-http-v2.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {startServer} from '../apps/server/src/index.ts';

const root=fileURLToPath(new URL('..',import.meta.url)),entry=join(root,'apps/cli/src/index.ts');
const projectId=randomUUID(),runId=randomUUID(),exportId=randomUUID();
const env={MIOON_BASE_URL:'http://127.0.0.1:4318',MIOON_TOKEN:'SYNTHETIC_CHECKS_LOCAL_SESSION'};
function checks():AgentTaskChecks{return {projectId,runId,runRevision:3,groups:[
 {id:'export_render',items:[{id:`export_status:${exportId}`,type:'export_status',source:'host',status:'pending',target:{kind:'export',id:exportId,name:'Synthetic export'},basis:[{kind:'export',id:exportId,revision:0}],reason:{code:'TASK_PENDING'},progress:62,current:{status:'rendering'}}]},
 {id:'generation',items:[]},{id:'timeline',items:[]},{id:'decomposition_frames',items:[]},
]};}
const ok=(data:unknown)=>new Response(JSON.stringify({ok:true,data}),{headers:{'content-type':'application/json'}});

test('checks contract keeps four ordered groups, revision bases and structured safe values strict',()=>{
 const value=checks(),item=value.groups[0]!.items[0]!;
 assert.deepEqual(agentTaskChecksSchema.parse(value),value);
 assert.deepEqual(agentTaskCheckSchema.parse({...item,expected:{width:1920,height:1080},current:{width:1280,height:720},reason:{code:'PARAMETERS_MISMATCH',params:{width:1280,height:720}}}).expected,{width:1920,height:1080});
 for(const bad of [
  {...value,message:'host prose'},
  {...value,groups:[...value.groups].reverse()},
  {...value,groups:value.groups.slice(1)},
  {...value,groups:value.groups.map((group,index)=>index===0?{...group,extra:true}:group)},
 ])assert.equal(agentTaskChecksSchema.safeParse(bad).success,false);
 for(const bad of [
  {...item,source:'goal'}, {...item,progress:101}, {...item,target:{...item.target,url:'https://invalid.example'}},
  {...item,basis:[]}, {...item,basis:[{kind:'export',id:randomUUID(),revision:0}]},
  {...item,basis:[...item.basis,...item.basis]}, {...item,basis:[{...item.basis[0],revision:0,path:'/private/hidden'}]},
  {...item,reason:{code:'TASK_FAILED',message:'provider prose'}},
  {...item,reason:{code:'TASK_FAILED',params:{secret:'private'}}},
  {...item,reason:{code:'OTHER'}}, {...item,current:{status:'provider response with spaces'}},
  {...item,expected:{width:'1920'}}, {...item,current:{issueCodes:['error message']}},
 ])assert.equal(agentTaskCheckSchema.safeParse(bad).success,false);
 const duplicate={...value,groups:value.groups.map((group,index)=>index===0?{...group,items:[item,item]}:group)};
 assert.equal(agentTaskChecksSchema.safeParse(duplicate).success,false);
});

test('checks discovery shares a strict optional boolean preflight input',()=>{
 assert.equal(AGENT_COMMAND_SCHEMAS['agent.task.checks'],agentTaskChecksInputSchema);
 for(const input of [{projectId,runId},{projectId,runId,preflight:true},{projectId,runId,preflight:false}])assert.deepEqual(agentTaskChecksInputSchema.parse(input),input);
 for(const preflight of ['1','true',1,null,{}])assert.equal(agentTaskChecksInputSchema.safeParse({projectId,runId,preflight}).success,false);
 assert.equal(agentTaskChecksInputSchema.safeParse({projectId,runId,extra:true}).success,false);
 const discovered=JSON.stringify(agentInputSchema(agentTaskChecksInputSchema));assert.match(discovered,/"preflight":\{"type":"boolean"\}/u);assert.match(discovered,/"additionalProperties":false/u);
});

test('checks client uses a single authenticated GET and rejects invalid identity or unsafe response data',async()=>{
 const calls:Array<{url:string;options:RequestInit|undefined}>=[];
 const client=createAgentClient({env,fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return ok(checks());}});
 assert.deepEqual(await client.checks({projectId,runId}),checks());
 assert.equal(calls.length,1);assert.equal(calls[0]!.url,`${env.MIOON_BASE_URL}/api/agent/tasks/v2/${projectId}/${runId}/checks`);
 assert.equal(calls[0]!.options?.method,'GET');assert.equal(calls[0]!.options?.body,undefined);assert.equal(calls[0]!.options?.redirect,'error');
 assert.deepEqual(calls[0]!.options?.headers,{authorization:`Bearer ${env.MIOON_TOKEN}`});
 await client.checks({projectId,runId,preflight:true});await client.checks({projectId,runId,preflight:false});
 assert.deepEqual(calls.map(call=>call.url),[`${env.MIOON_BASE_URL}/api/agent/tasks/v2/${projectId}/${runId}/checks`,`${env.MIOON_BASE_URL}/api/agent/tasks/v2/${projectId}/${runId}/checks?preflight=1`,`${env.MIOON_BASE_URL}/api/agent/tasks/v2/${projectId}/${runId}/checks`]);
 assert.ok(calls.every(call=>call.options?.method==='GET'&&call.options.body===undefined));
 for(const bad of [{projectId,runId,requestId:randomUUID()},{projectId,runId:'invalid'},{projectId,runId,refresh:true},{projectId,runId,preflight:'1'}])await assert.rejects(client.checks(bad),{code:'VALIDATION_ERROR'});
 assert.equal(calls.length,3);
 for(const bad of [
  {...checks(),projectId:randomUUID()}, {...checks(),runId:randomUUID()},
  {...checks(),groups:checks().groups.map((group,index)=>index===0?{...group,items:[{...group.items[0],basis:[]}]}:group)},
  {...checks(),message:'PRIVATE_PROVIDER_MESSAGE'},
 ]){
  let requests=0;const invalid=createAgentClient({env,fetchImpl:async()=>{requests++;return ok(bad);}});
  await assert.rejects(invalid.checks({projectId,runId}),{code:'BACKEND_PROTOCOL_ERROR'});assert.equal(requests,1);
 }
 assert.ok(Object.hasOwn(AGENT_COMMAND_SCHEMAS,'agent.task.checks'));
 assert.equal(Object.hasOwn(schemas,'agent.task.checks'),false);
});

test('full checks default to at least sixty seconds while explicit and longer client timeouts remain authoritative',async t=>{
 const timeouts:number[]=[],signals:AbortSignal[]=[],fetchSignals:Array<AbortSignal|null|undefined>=[];
 t.mock.method(AbortSignal,'timeout',(milliseconds:number)=>{timeouts.push(milliseconds);const signal=new AbortController().signal;signals.push(signal);return signal;});
 const fetchImpl:typeof fetch=async(_url,options)=>{fetchSignals.push(options?.signal);return ok(checks());};
 const client=createAgentClient({env,fetchImpl});
 await client.checks({projectId,runId});await client.checks({projectId,runId,preflight:false});await client.checks({projectId,runId,preflight:true});
 await client.checks({projectId,runId,preflight:true},{timeoutMs:25000});await client.checks({projectId,runId,preflight:true},{timeoutMs:90000});
 const longer=createAgentClient({env,fetchImpl,requestTimeoutMs:120000});await longer.checks({projectId,runId,preflight:true});
 const shorter=createAgentClient({env,fetchImpl,requestTimeoutMs:12000});await shorter.checks({projectId,runId,preflight:true});await shorter.checks({projectId,runId,preflight:false});await shorter.checks({projectId,runId});
 assert.deepEqual(timeouts,[30000,30000,60000,25000,90000,120000,60000,12000,12000]);
 assert.deepEqual(fetchSignals,signals);
});

async function command(args:string[],base?:string):Promise<{code:number|null;stdout:string;stderr:string;body:unknown}>{
 const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MIOON_')));
 if(base)Object.assign(childEnv,{MIOON_BASE_URL:base,MIOON_TOKEN:env.MIOON_TOKEN});
 childEnv.MIOON_ENABLE_LIVE_PROVIDER='0';
 const child=spawn(process.execPath,[entry,...args],{cwd:root,env:childEnv,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',(part:string)=>{stdout+=part;});child.stderr.setEncoding('utf8').on('data',(part:string)=>{stderr+=part;});
 const code=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Synthetic checks CLI timed out'));},15000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);resolve(code);});});
 assert.equal(stdout.includes(env.MIOON_TOKEN),false);assert.equal(stderr.includes(env.MIOON_TOKEN),false);
 const body:unknown=JSON.parse(stdout);return {code,stdout,stderr,body};
}
test('checks CLI discovers its strict schema offline and forwards only one GET',async t=>{
 for(const args of [['schema','agent.task.checks'],['agent','task','checks','--help']]){
  const result=await command(args);assert.equal(result.code,0);assert.match(result.stdout,/agent\.task\.checks/u);
  assert.match(result.stdout,/projectId/u);assert.match(result.stdout,/runId/u);assert.match(result.stdout,/"preflight":\{"type":"boolean"\}/u);
  assert.match(result.stdout,/lightweight local checks by default/u);assert.match(result.stdout,/preflight:true/u);assert.match(result.stdout,/full local media preflight/u);
 }
 const calls:Array<{url:string|undefined;method:string|undefined}>=[],server=http.createServer((req,res)=>{
  assert.equal(req.headers.authorization,`Bearer ${env.MIOON_TOKEN}`);calls.push({url:req.url,method:req.method});res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,data:checks()}));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 const result=await command(['agent','task','checks','--input',JSON.stringify({projectId,runId})],base);
 assert.equal(result.code,0);assert.deepEqual(result.body,{ok:true,data:checks()});
 assert.deepEqual(calls,[{url:`/api/agent/tasks/v2/${projectId}/${runId}/checks`,method:'GET'}]);
 for(const preflight of [true,false])assert.equal((await command(['agent','task','checks','--input',JSON.stringify({projectId,runId,preflight})],base)).code,0);
 assert.deepEqual(calls.map(call=>call.url),[`/api/agent/tasks/v2/${projectId}/${runId}/checks`,`/api/agent/tasks/v2/${projectId}/${runId}/checks?preflight=1`,`/api/agent/tasks/v2/${projectId}/${runId}/checks`]);
 for(const input of [{projectId,runId,force:true},{projectId,runId,preflight:'1'}])assert.equal((await command(['agent','task','checks','--input',JSON.stringify(input)],base)).code,2);
 assert.equal(calls.length,3);
});

async function workspace(){
 const directory=await mkdtemp(join(await realpath(tmpdir()),'mioon-checks-transport-'));
 const source=join(directory,'source'),store=openStore(source),projectId=randomUUID(),foreignProjectId=randomUUID(),now='2026-10-28T00:00:00.000Z';
 for(const id of [projectId,foreignProjectId])store.put('projects',{id,name:'Synthetic checks project',revision:1,createdAt:now,updatedAt:now});
 const journal=createAgentTaskJournal(store),created=journal.create({requestId:randomUUID(),projectId,text:'Synthetic checks',configuration:{protocol:'responses'},policy:structuredClone(DEFAULT_AGENT_TASK_POLICY)}).run;
 const run=journal.transition(created.id,created.revision,'completed');store.close();return {directory,source,projectId,foreignProjectId,run};
}
function dump(root:string):unknown{
 const db=new DatabaseSync(join(root,'workbench.sqlite'),{readOnly:true});try{return db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>({name:row.name,sql:row.sql,...(String(row.sql).startsWith('CREATE TABLE')?{rows:db.prepare(`SELECT * FROM "${String(row.name)}"`).all().map(item=>JSON.stringify(item)).sort()}:{})}));}finally{db.close();}
}
test('checks HTTP is authenticated, rejects unknown ownership and parameters, and leaves records unchanged',async t=>{
 const f=await workspace();let models=0,server:Awaited<ReturnType<typeof startServer>>|undefined;
 t.after(async()=>{await server?.close();await rm(f.directory,{recursive:true,force:true});});
 server=await startServer({dataDir:f.source,port:0,taskGatewayV2:async function*(){models++;throw Error('Checks cannot request a model');}});
 const prefix=`/api/agent/tasks/v2/${f.projectId}/${f.run.id}`,before=dump(f.source);
 const request=(suffix='',method='GET',authenticated=true)=>fetch(server!.url+prefix+suffix,{method,headers:authenticated?{authorization:`Bearer ${server!.token}`}:{}});
 assert.equal((await request('/checks','GET',false)).status,401);
 const response=await request('/checks');assert.equal(response.status,200);const body:unknown=await response.json();
 assert.ok(body&&typeof body==='object'&&'data'in body);const result=agentTaskChecksSchema.parse(body.data);
 assert.equal(result.projectId,f.projectId);assert.equal(result.runId,f.run.id);assert.equal(result.runRevision,f.run.revision);
 assert.deepEqual(result.groups.map(group=>group.id),AGENT_TASK_CHECK_GROUPS);
 assert.equal((await request('/checks?preflight=1')).status,200);
 for(const suffix of ['?preflight=0','?preflight=true','?preflight=','?preflight','?preflight=1&preflight=1','?preflight=1&refresh=true','?refresh=true'])assert.equal((await request('/checks'+suffix)).status,400,suffix);
 assert.equal((await request('/checks','POST')).status,405);
 const headers={authorization:`Bearer ${server.token}`};
 assert.equal((await fetch(`${server.url}/api/agent/tasks/v2/${f.foreignProjectId}/${f.run.id}/checks`,{headers})).status,404);
 assert.equal((await fetch(`${server.url}/api/agent/tasks/v2/${f.projectId}/${randomUUID()}/checks`,{headers})).status,404);
 const snapshot=await request();const snapshotBody:unknown=await snapshot.json();assert.ok(snapshotBody&&typeof snapshotBody==='object'&&'data'in snapshotBody);assert.equal(snapshotBody.data!==null&&typeof snapshotBody.data==='object'&&Object.hasOwn(snapshotBody.data,'checks'),false);
 assert.equal(models,0);assert.deepEqual(dump(f.source),before);
});
test('checks remain available in a restored read-only server without credentials, recovery or database writes',async t=>{
 const f=await workspace(),backup=join(f.directory,'backup'),restored=join(f.directory,'restored');let server:Awaited<ReturnType<typeof startServer>>|undefined;
 t.after(async()=>{await server?.close();await rm(f.directory,{recursive:true,force:true});});
 await createWorkspaceBackup({source:f.source,destination:backup});await restoreWorkspaceBackup({directory:backup,destination:restored});
 const before=dump(restored);let models=0;
 server=await startServer({dataDir:restored,port:0,taskGatewayV2:async function*(){models++;throw Error('Restored checks cannot request a model');}});
 const client=createAgentClient({env:{MIOON_BASE_URL:server.url,MIOON_TOKEN:server.token}}),result=await client.checks({projectId:f.projectId,runId:f.run.id});
 assert.equal(result.runId,f.run.id);assert.equal(result.runRevision,f.run.revision);assert.deepEqual(result.groups.map(group=>group.id),AGENT_TASK_CHECK_GROUPS);
 assert.equal(models,0);assert.deepEqual(dump(restored),before);
});

test('disconnecting a checks observer cancels its local preflight and releases it before the next read',{timeout:10000},async t=>{
 const f=await workspace(),store=openStore(f.source),journal=createAgentTaskJournal(store),timelineId=randomUUID();
 const run=journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Synthetic preflight cancellation',configuration:{}}).run,saved=journal.beginStep(run.id,{kind:'tool'});
 journal.markDispatch(run.id,saved.id);
 journal.completeStep(run.id,saved.id,{change:{projectId:f.projectId,operation:'timeline.format.set',targets:[{kind:'timeline',id:f.projectId,revision:1}],before:null,after:null,reversible:true}});
 journal.transition(run.id,journal.run(run.id).revision,'completed');
 store.put('timelines',{id:timelineId,projectId:f.projectId,revision:1,fps:30,width:720,height:1280,tracks:[],clips:[]});
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
 let entered!:()=>void,released!:()=>void,active=0,calls=0;
 const started=new Promise<void>(resolve=>{entered=resolve;}),stopped=new Promise<void>(resolve=>{released=resolve;});
 const runtime=createAgentTaskRuntime({store,journal,agentSettings:settings,authorizations:{assertAuthorized(){throw Error('Checks cannot authorize a model');},snapshot(){return {revision:0,scopes:[]};}},selfPort:()=>0,
  checksPreflight:async(_input,{signal}={})=>{
   calls++;active++;try{
    if(calls===1){entered();await new Promise<never>((_resolve,reject)=>{const cancel=()=>reject(Object.assign(Error('Synthetic observer cancelled'),{name:'AbortError'}));if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});});}
    return {};
   }finally{active--;if(calls===1)released();}
  }});
 let finished=0;const handler=createAgentTaskHttp({runtime}),server=http.createServer((req,res)=>{res.once('finish',()=>{finished++;});void handler.handle(req,res,new URL(req.url??'/',`http://${req.headers.host}`));});
 t.after(async()=>{handler.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.close();await runtime.drain();await settings.close();store.close();await rm(f.directory,{recursive:true,force:true});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
 const url=`http://127.0.0.1:${address.port}/api/agent/tasks/v2/${f.projectId}/${run.id}/checks?preflight=1`,observer=new AbortController();
 const lightweight=await fetch(url.replace('?preflight=1',''));assert.equal(lightweight.status,200);const lightBody:unknown=await lightweight.json();
 assert.ok(lightBody&&typeof lightBody==='object'&&'data'in lightBody);assert.equal(agentTaskChecksSchema.parse(lightBody.data).groups[2]!.items.find(item=>item.type==='timeline_preflight')?.reason?.code,'PREFLIGHT_NOT_REQUESTED');assert.equal(calls,0);assert.equal(active,0);
 const pending=fetch(url,{signal:observer.signal});await started;assert.equal(active,1);observer.abort();await assert.rejects(pending,{name:'AbortError'});await stopped;assert.equal(active,0);assert.equal(finished,1);
 const next=await fetch(url);assert.equal(next.status,200);assert.equal(calls,2);assert.equal(active,0);
 const body:unknown=await next.json();assert.ok(body&&typeof body==='object'&&'data'in body);assert.equal(agentTaskChecksSchema.parse(body.data).groups[2]!.items.find(item=>item.type==='timeline_preflight')?.reason?.code,'PREFLIGHT_UNAVAILABLE');
 assert.equal(finished,2);
});
