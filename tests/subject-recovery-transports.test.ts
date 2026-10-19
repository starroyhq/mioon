import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {isEditTaskEnvelope} from '@mioon/contracts';
import {taskFixture,taskPath,listPath,database,snapshot,REPO,TASK_TOKEN} from './helpers/edit-tasks-http-fixture.ts';
import {type TestContext} from 'node:test';
type TaskFixture = Awaited<ReturnType<typeof taskFixture>>;
type Prepared = {task: {id: string; digest: string; lane: string; status: string; revision: number}; instanceId?: string};
type Applied = {result: {id: string; revision: number; headVersionId: string; [key: string]: unknown}; task: {id: string; digest: string; revision: number; status: string; [key: string]: unknown}};
const subjectTables=['subjects','subject_versions','subject_bindings','subject_requests','edit_tasks'];
const saved=(f: TaskFixture)=>snapshot(f.root,subjectTables);
const inputFor=(f: TaskFixture)=>({projectId:f.project.id,kind:'character',name:'Synthetic subject',assetId:f.source.id,requestId:randomUUID()});
const action=(f: TaskFixture,prepared: {task: {digest: string}; [key: string]: unknown})=>({projectId:f.project.id,digest:prepared.task.digest,instanceId:prepared.instanceId});
const dispatched=(f: TaskFixture)=>f.phases.filter((phase)=>String(phase)==='beforeDispatch').length;

test('real subject task HTTP prepare is bounded/authenticated/closed and rediscovery never dispatches',async (t: TestContext)=>{
 const f=await taskFixture(t),input=inputFor(f),body={projectId:f.project.id,operation:'subject.create',input,origin:'new'},before=saved(f);
 for(const options of [{authenticated:false},{headers:{origin:'https://foreign.example'}},{headers:{host:'foreign.example'}}]){
  const res=await f.request('/api/tasks/prepare',{method:'POST',input:body,...options} as never);assert.ok([401,403].includes(res.status));
 }
 for(const change of [{operation:'subject.delete'},{operation:'subject.list'},{input:{...input,requestId:undefined}},{input:{...input,extra:true}},{input:{...input,name:'x'.repeat(8193)}}]){
  const res=await f.request('/api/tasks/prepare',{method:'POST',input:{...body,...change}});assert.ok([400,413].includes(res.status));
 }
 assert.deepEqual(saved(f),before);const prepared=await f.prepare('subject.create',input) as Prepared,domain=snapshot(f.root);
 assert.equal(prepared.task.lane,'subject:mutation');assert.ok(isEditTaskEnvelope(prepared));
 assert.deepEqual(((await f.list()) as {items: unknown[]}).items,[prepared.task]);assert.deepEqual(await f.get(prepared.task.id),prepared);
 assert.equal(dispatched(f),0);assert.deepEqual(snapshot(f.root),domain);
});

test('real lost subject prepare acknowledgement survives backend restart without automatic execution',async (t: TestContext)=>{
 const f=await taskFixture(t),input=inputFor(f),before=snapshot(f.root);f.lose('/api/tasks/prepare');
 await assert.rejects(f.viaProxy('/api/tasks/prepare',{method:'POST',input:{projectId:f.project.id,operation:'subject.create',input,origin:'new'}}));
 const accepted=(f.observed as {body: {data: unknown}}[])[0]!.body.data as Prepared;assert.ok(isEditTaskEnvelope(accepted));assert.equal(dispatched(f),0);assert.deepEqual(snapshot(f.root),before);
 await f.restart();const found=await f.viaProxy(listPath(f.project.id));assert.deepEqual((found.body.data as {items: unknown[]}).items,[accepted.task]);assert.equal(f.requests.filter(request=>request.method==='POST').length,1);
 assert.equal(dispatched(f),0);const stale=await f.request(taskPath(accepted.task.id,'execute'),{method:'POST',input:action(f,accepted as never)});assert.equal((stale.body.error as {code:string}).code,'EDIT_TASK_STALE_INSTANCE');
 const result=await f.execute(await f.get(accepted.task.id) as never) as Prepared;assert.equal(result.task.status,'applied');assert.equal(dispatched(f),1);
 assert.equal(database(f.root,(db: import('node:sqlite').DatabaseSync)=>(db.prepare('SELECT count(*) n FROM subjects').get() as {n: number}).n),1);
});

test('real dropped subject execute response commits once and recovery returns historical ACK after newer head',async (t: TestContext)=>{
 const f=await taskFixture(t),input=inputFor(f),prepared=(await f.prepare('subject.create',input) as Prepared),route=taskPath(prepared.task.id,'execute');f.lose(route);
 await assert.rejects(f.viaProxy(route,{method:'POST',input:action(f,prepared)}));
 const applied=(f.observed as {body: {data: unknown}}[])[0]!.body.data as Applied;assert.equal(applied.task.status,'applied');assert.ok(isEditTaskEnvelope(applied));
 // Add a second metadata-only fixture source. No media I/O or provider work.
 const assetId=randomUUID();database(f.root,db=>{const value={...f.source,id:assetId,sha256:'b'.repeat(64),relativePath:'media/second-synthetic.png'};db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(assetId,f.project.id,JSON.stringify(value));},true);
 await f.rpc('subject.version.add',{projectId:f.project.id,subjectId:applied.result.id,expectedRevision:applied.result.revision,assetId,requestId:randomUUID()});
 const before=saved(f),domain=snapshot(f.root);await f.restart();const current=await f.get(applied.task.id) as {task: {id: string; digest: string; revision: number; status: string}};
 assert.deepEqual(((await f.reconcile(current.task)) as Applied).result,applied.result);assert.deepEqual(((await f.execute(current as never)) as Applied).result,applied.result);
 assert.equal(dispatched(f),1);assert.deepEqual(saved(f),before);assert.deepEqual(snapshot(f.root),domain);
 await f.acknowledge(current.task);assert.deepEqual(((await f.list()) as {items: unknown[]}).items,[]);
 assert.equal(database(f.root,(db: import('node:sqlite').DatabaseSync)=>(db.prepare('SELECT count(*) n FROM subject_requests').get() as {n: number}).n),2);
});

async function command(operation: string,input: unknown,url: string): Promise<unknown> {
 const child=spawn(process.execPath,[path.join(REPO,'apps/cli/src/index.ts'),...operation.split('.'),'--input',JSON.stringify(input)],{cwd:REPO,env:{...process.env,MIOON_BASE_URL:url,MIOON_TOKEN:TASK_TOKEN,MIOON_ENABLE_LIVE_PROVIDER:'0'},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;if(stdout.length>1024*1024)child.kill('SIGKILL');});child.stderr.setEncoding('utf8').on('data',chunk=>stderr=(stderr+chunk).slice(-20000));
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);let code,signal;try{[code,signal]=await once(child,'close');}finally{clearTimeout(timer);}
 assert.equal(signal,null,stderr);assert.equal(code,0,stdout+stderr);assert.equal((stdout+stderr).includes(TASK_TOKEN),false);return JSON.parse(stdout);
}

test('official CLI and MCP replay all three exact subject receipts without exposing durable task execution tools', {timeout:30000},async (t: TestContext)=>{
 const f=await taskFixture(t),mcp=new Client({name:'subject-recovery-tests',version:'1.0.0'},{capabilities:{}});t.after(()=>mcp.close());
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(REPO,'apps/mcp/src/index.ts')],cwd:REPO,env:{...process.env,MIOON_BASE_URL:f.backend!.url,MIOON_TOKEN:TASK_TOKEN,MIOON_ENABLE_LIVE_PROVIDER:'0'},stderr:'pipe'});(transport.stderr as import('node:stream').Readable & {resume(): void}).resume();await mcp.connect(transport);
 const tools=(await mcp.listTools()).tools;
 assert.equal(tools.some(tool=>/^(?:tasks|edit_tasks)_/.test(tool.name)),false);
 for(const name of ['subject_create','subject_version_add','subject_binding_set'])assert.equal(tools.filter(tool=>tool.name===name).length,1);
 const records: [string, unknown, Applied][]=[];let subject: Applied['result'];
 const create=inputFor(f);const created=await f.execute(await f.prepare('subject.create',create) as never) as Applied;subject=created.result;records.push(['subject.create',create,created]);await f.acknowledge(created.task);
 const assetId=randomUUID();database(f.root,db=>{const value={...f.source,id:assetId,sha256:'c'.repeat(64),relativePath:'media/third-synthetic.png'};db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(assetId,f.project.id,JSON.stringify(value));},true);
 const add={projectId:f.project.id,subjectId:subject!.id,expectedRevision:subject!.revision,assetId,requestId:randomUUID()},added=await f.execute(await f.prepare('subject.version.add',add) as never) as Applied;subject=added.result;records.push(['subject.version.add',add,added]);await f.acknowledge(added.task);
 const bind={projectId:f.project.id,shotId:f.shot.id,subjectId:subject!.id,role:'subject',subjectVersionId:subject!.headVersionId,expectedRevision:0,expectedSubjectRevision:subject!.revision,requestId:randomUUID()},bound=await f.execute(await f.prepare('subject.binding.set',bind) as never) as Applied;records.push(['subject.binding.set',bind,bound]);await f.acknowledge(bound.task);
 const before=saved(f),legacy=snapshot(f.root);
 for(const [operation,input,applied] of records){
  assert.deepEqual(await command(operation,input,f.backend!.url),{ok:true,data:applied.result});
  const response=await mcp.callTool({name:(operation as string).replaceAll('.','_'),arguments:input as Record<string, unknown>});assert.equal(response.isError,false);assert.deepEqual(response.structuredContent,{ok:true,data:applied.result});
  assert.deepEqual(JSON.parse((((response.content ?? []) as {type: string; text?: string}[]).find((block)=>block.type==='text') as {text: string}).text),response.structuredContent);assert.deepEqual(await f.rpc(operation,input),applied.result);
 }
 assert.deepEqual(saved(f),before);assert.deepEqual(snapshot(f.root),legacy);assert.equal(dispatched(f),3);
});
