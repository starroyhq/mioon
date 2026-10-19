import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {isEditTaskEnvelope} from '@mioon/contracts';
import {taskFixture,taskPath,listPath,database,snapshot,REPO,TASK_TOKEN} from './helpers/edit-tasks-http-fixture.mjs';
const subjectTables=['subjects','subject_versions','subject_bindings','subject_requests','edit_tasks'];
const saved=f=>snapshot(f.root,subjectTables);
const inputFor=f=>({projectId:f.project.id,kind:'character',name:'Synthetic subject',assetId:f.source.id,requestId:randomUUID()});
const action=(f,prepared)=>({projectId:f.project.id,digest:prepared.task.digest,instanceId:prepared.instanceId});
const dispatched=f=>f.phases.filter(phase=>phase==='beforeDispatch').length;

test('real subject task HTTP prepare is bounded/authenticated/closed and rediscovery never dispatches',async t=>{
 const f=await taskFixture(t),input=inputFor(f),body={projectId:f.project.id,operation:'subject.create',input,origin:'new'},before=saved(f);
 for(const options of [{authenticated:false},{headers:{origin:'https://foreign.example'}},{headers:{host:'foreign.example'}}]){
  const res=await f.request('/api/tasks/prepare',{method:'POST',input:body,...options});assert.ok([401,403].includes(res.status));
 }
 for(const change of [{operation:'subject.delete'},{operation:'subject.list'},{input:{...input,requestId:undefined}},{input:{...input,extra:true}},{input:{...input,name:'x'.repeat(8193)}}]){
  const res=await f.request('/api/tasks/prepare',{method:'POST',input:{...body,...change}});assert.ok([400,413].includes(res.status));
 }
 assert.deepEqual(saved(f),before);const prepared=await f.prepare('subject.create',input),domain=snapshot(f.root);
 assert.equal(prepared.task.lane,'subject:mutation');assert.ok(isEditTaskEnvelope(prepared));
 assert.deepEqual((await f.list()).items,[prepared.task]);assert.deepEqual(await f.get(prepared.task.id),prepared);
 assert.equal(dispatched(f),0);assert.deepEqual(snapshot(f.root),domain);
});

test('real lost subject prepare acknowledgement survives backend restart without automatic execution',async t=>{
 const f=await taskFixture(t),input=inputFor(f),before=snapshot(f.root);f.lose('/api/tasks/prepare');
 await assert.rejects(f.viaProxy('/api/tasks/prepare',{method:'POST',input:{projectId:f.project.id,operation:'subject.create',input,origin:'new'}}));
 const accepted=f.observed[0].body.data;assert.ok(isEditTaskEnvelope(accepted));assert.equal(dispatched(f),0);assert.deepEqual(snapshot(f.root),before);
 await f.restart();const found=await f.viaProxy(listPath(f.project.id));assert.deepEqual(found.body.data.items,[accepted.task]);assert.equal(f.requests.filter(request=>request.method==='POST').length,1);
 assert.equal(dispatched(f),0);const stale=await f.request(taskPath(accepted.task.id,'execute'),{method:'POST',input:action(f,accepted)});assert.equal(stale.body.error.code,'EDIT_TASK_STALE_INSTANCE');
 const result=await f.execute(await f.get(accepted.task.id));assert.equal(result.task.status,'applied');assert.equal(dispatched(f),1);
 assert.equal(database(f.root,db=>db.prepare('SELECT count(*) n FROM subjects').get().n),1);
});

test('real dropped subject execute response commits once and recovery returns historical ACK after newer head',async t=>{
 const f=await taskFixture(t),input=inputFor(f),prepared=await f.prepare('subject.create',input),route=taskPath(prepared.task.id,'execute');f.lose(route);
 await assert.rejects(f.viaProxy(route,{method:'POST',input:action(f,prepared)}));
 const applied=f.observed[0].body.data;assert.equal(applied.task.status,'applied');assert.ok(isEditTaskEnvelope(applied));
 // Add a second metadata-only fixture source. No media I/O or provider work.
 const assetId=randomUUID();database(f.root,db=>{const value={...f.source,id:assetId,sha256:'b'.repeat(64),relativePath:'media/second-synthetic.png'};db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(assetId,f.project.id,JSON.stringify(value));},true);
 await f.rpc('subject.version.add',{projectId:f.project.id,subjectId:applied.result.id,expectedRevision:applied.result.revision,assetId,requestId:randomUUID()});
 const before=saved(f),domain=snapshot(f.root);await f.restart();const current=await f.get(applied.task.id);
 assert.deepEqual((await f.reconcile(current.task)).result,applied.result);assert.deepEqual((await f.execute(current)).result,applied.result);
 assert.equal(dispatched(f),1);assert.deepEqual(saved(f),before);assert.deepEqual(snapshot(f.root),domain);
 await f.acknowledge(current.task);assert.deepEqual((await f.list()).items,[]);
 assert.equal(database(f.root,db=>db.prepare('SELECT count(*) n FROM subject_requests').get().n),2);
});

async function command(operation,input,url){
 const child=spawn(process.execPath,[path.join(REPO,'apps/cli/src/index.ts'),...operation.split('.'),'--input',JSON.stringify(input)],{cwd:REPO,env:{...process.env,MIOON_BASE_URL:url,MIOON_TOKEN:TASK_TOKEN,MIOON_ENABLE_LIVE_PROVIDER:'0'},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;if(stdout.length>1024*1024)child.kill('SIGKILL');});child.stderr.setEncoding('utf8').on('data',chunk=>stderr=(stderr+chunk).slice(-20000));
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);let code,signal;try{[code,signal]=await once(child,'close');}finally{clearTimeout(timer);}
 assert.equal(signal,null,stderr);assert.equal(code,0,stdout+stderr);assert.equal((stdout+stderr).includes(TASK_TOKEN),false);return JSON.parse(stdout);
}

test('official CLI and MCP replay all three exact subject receipts without exposing durable task execution tools', {timeout:30000},async t=>{
 const f=await taskFixture(t),mcp=new Client({name:'subject-recovery-tests',version:'1.0.0'},{capabilities:{}});t.after(()=>mcp.close());
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(REPO,'apps/mcp/src/index.ts')],cwd:REPO,env:{...process.env,MIOON_BASE_URL:f.backend.url,MIOON_TOKEN:TASK_TOKEN,MIOON_ENABLE_LIVE_PROVIDER:'0'},stderr:'pipe'});transport.stderr?.resume();await mcp.connect(transport);
 const tools=(await mcp.listTools()).tools;
 assert.equal(tools.some(tool=>/^(?:tasks|edit_tasks)_/.test(tool.name)),false);
 for(const name of ['subject_create','subject_version_add','subject_binding_set'])assert.equal(tools.filter(tool=>tool.name===name).length,1);
 const records=[];let subject;
 const create=inputFor(f);const created=await f.execute(await f.prepare('subject.create',create));subject=created.result;records.push(['subject.create',create,created]);await f.acknowledge(created.task);
 const assetId=randomUUID();database(f.root,db=>{const value={...f.source,id:assetId,sha256:'c'.repeat(64),relativePath:'media/third-synthetic.png'};db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(assetId,f.project.id,JSON.stringify(value));},true);
 const add={projectId:f.project.id,subjectId:subject.id,expectedRevision:subject.revision,assetId,requestId:randomUUID()},added=await f.execute(await f.prepare('subject.version.add',add));subject=added.result;records.push(['subject.version.add',add,added]);await f.acknowledge(added.task);
 const bind={projectId:f.project.id,shotId:f.shot.id,subjectId:subject.id,role:'subject',subjectVersionId:subject.headVersionId,expectedRevision:0,expectedSubjectRevision:subject.revision,requestId:randomUUID()},bound=await f.execute(await f.prepare('subject.binding.set',bind));records.push(['subject.binding.set',bind,bound]);await f.acknowledge(bound.task);
 const before=saved(f),legacy=snapshot(f.root);
 for(const [operation,input,applied] of records){
  assert.deepEqual(await command(operation,input,f.backend.url),{ok:true,data:applied.result});
  const response=await mcp.callTool({name:operation.replaceAll('.','_'),arguments:input});assert.equal(response.isError,false);assert.deepEqual(response.structuredContent,{ok:true,data:applied.result});
  assert.deepEqual(JSON.parse(response.content.find(block=>block.type==='text').text),response.structuredContent);assert.deepEqual(await f.rpc(operation,input),applied.result);
 }
 assert.deepEqual(saved(f),before);assert.deepEqual(snapshot(f.root),legacy);assert.equal(dispatched(f),3);
});
