import type {WorkspaceServices as FixtureServices,WorkspaceClient as FixtureClient} from './helpers/strict-workspace-boundary-types.ts';
import type {FixtureStore} from './helpers/strict-timeline-core-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createClient} from '../packages/client/src/index.ts';
import type { BinaryLike } from 'crypto';

const repo=fileURLToPath(new URL('..',import.meta.url)),token='synthetic-restored-http-cli-mcp-token';
const digest=(value: NonSharedBuffer|BinaryLike)=>createHash('sha256').update(value).digest('hex');
function tree(root: fs.PathLike): {name:string;mode:number;sha256?:string}[]{return fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{const file=path.join((root as unknown as Parameters<typeof path.join>[0]),entry.name),info=fs.lstatSync(file);return [{name:file,mode:info.mode,...(entry.isFile()?{sha256:digest(fs.readFileSync(file))}:{})},...(entry.isDirectory()?tree(file):[])];});}
const database=<T>(root: string,read: (db:DatabaseSync)=>T)=>{const db=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});try{return read(db);}finally{db.close();}};
async function cli(t: { after: (arg0: () => Promise<void>) => void; },args: string[],env: { MIOON_BASE_URL: string; MIOON_TOKEN: string; MIOON_ENABLE_LIVE_PROVIDER: string; }){
 const child=(spawn as unknown as import('./helpers/strict-workspace-boundary-types.ts').SpawnChild)(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...args],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',closed=false,failure;
 const completed=new Promise<Pick<import('./helpers/strict-workspace-boundary-types.ts').ChildOutcome,'code'|'signal'>>(resolve=>{child.once('error',(error)=>{failure=error;});child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});});
 child.stdout.setEncoding('utf8').on('data',(value: string)=>{stdout+=value;if(stdout.length>1024*1024){failure=Error('CLI stdout limit');child.kill('SIGKILL');}});
 child.stderr.setEncoding('utf8').on('data',(value: string)=>{stderr+=value;if(stderr.length>1024*1024){failure=Error('CLI stderr limit');child.kill('SIGKILL');}});
 const timer=setTimeout(()=>{failure=Error('CLI deadline');child.kill('SIGKILL');},15000);
 t.after(async()=>{if(!closed){child.kill('SIGKILL');await completed;}});
 let end;try{end=await completed;}finally{clearTimeout(timer);}if(failure)throw failure;
 assert.equal(end.signal,null,stderr);assert.ok(!stdout.includes(token)&&!stderr.includes(token));
 const body=JSON.parse((stdout as string));assert.equal(end.code===0,body.ok,stdout+stderr);return body;
}
async function fixture(t: test.TestContext){
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-restored-transports-')),source=path.join(base,'source'),backup=path.join(base,'backup'),root=path.join(base,'branch');
 let backend: Awaited<ReturnType<typeof startServer>>,proxy: import('node:http').Server,mcp: Client;let droppedRoute: string|null|undefined=null;const observed: { route: string|undefined; status: number; body: import("./helpers/strict-workspace-boundary-types.ts").WireEnvelope<import('./helpers/strict-opacity-fixture-types.ts').OpacityTaskEnvelope>; }[]=[],requests: { route: string|undefined; method: string|undefined; body: unknown; }[]=[];let mediaStarts=0;
 const off=onMediaProcess(event=>{if(event.type==='started')mediaStarts++;});
 t.after(async()=>{await mcp?.close();if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}await backend?.close();off();fs.rmSync(base,{recursive:true,force:true});});
 const store=(openStore(source) as unknown as FixtureStore),services=(createServices(store,new Map()) as unknown as FixtureServices),tasks=(createEditTasks({store,services}) as unknown as import("./helpers/strict-opacity-fixture-types.ts").OpacityTasks);
 let project,shot,timeline,pending,oldInput,oldAck;
 try{
  project=await services.call('project.create',{name:'恢复传输验收'});
  shot=await services.call('shot.create',{projectId:project.id,title:'旧镜头',requestId:randomUUID()});
  timeline=await services.call('timeline.get',{projectId:project.id});
  oldInput={projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),kind:'audio',name:'原始回执'};
  oldAck=await services.call('timeline.track.add',oldInput);timeline=oldAck;
  pending=tasks.prepare({projectId:project.id,operation:'timeline.track.add',origin:'new',input:{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),kind:'audio',name:'继承未执行'}});
  const now=new Date().toISOString();for(const status of ['queued','running','submission_unknown'] as const)store.put('jobs',{id:randomUUID(),projectId:project.id,shotId:shot.id,providerId:'mock',status,revision:1,snapshot:{},createdAt:now,updatedAt:now});
 }finally{await tasks.drain();await services.drain();store.close();}
 await (createWorkspaceBackup({source,destination:backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);const untouched={source:tree(source),backup:tree(backup)};
 const restored=await (restoreWorkspaceBackup({directory:backup,destination:root}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceRestoreResult>),origin=restored.workspaceOrigin;
 const captured=database(root,(((db: { prepare: (arg0: string) => { (): unknown; new(): unknown; all: { (): unknown; new(): unknown; }; get: { (arg0: string): unknown; new(): unknown; }; }; })=>({jobs:db.prepare('SELECT * FROM jobs ORDER BY id').all(),task:db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(pending.task.id),receipt:db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(oldInput.requestId)})) as unknown as Parameters<typeof database>[1]));
 const forbidden=()=>{throw Error('Restored transport touched executing runtime');};
 const start=()=>startServer(({dataDir:root,port:0,token,agentSettings:{get:forbidden,put:forbidden,close:forbidden},chatGateway:forbidden,imageNetwork:{request:forbidden},comfyNetwork:{httpRequest:forbidden}} as unknown as Parameters<typeof startServer>[0]));
 backend=await start();
 proxy=http.createServer(async(req,res)=>{
  try{
   const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>512*1024)throw Error('fixture request limit');parts.push(part);}
   const bytes=Buffer.concat(parts),route=req.url;requests.push({route,method:req.method,body:bytes.length?JSON.parse((bytes.toString('utf8') as string)):null});
   const response=await fetch(backend.url+route,{method:req.method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(bytes.length?{body:bytes}:{}),signal:AbortSignal.timeout(10000)});
   const text=await response.text();assert.ok(Buffer.byteLength(text)<2*1024*1024);observed.push({route,status:response.status,body:JSON.parse((text as string))});
   if(droppedRoute===route){droppedRoute=null;res.destroy();return;}
   res.writeHead(response.status,{'content-type':'application/json'});res.end(text);
  }catch{res.destroy();}
 });proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 const url=`http://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`,env={...mediaEnvironment(),MIOON_BASE_URL:url,MIOON_TOKEN:token,MIOON_ENABLE_LIVE_PROVIDER:'0'};
 const raw=async<Route extends string>(route: Route,input?:Record<string,unknown>)=>{try{const response=await fetch(url+route,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(10000)});return await response.json();}catch{return {ok:false,error:{code:'LOST_TRANSPORT'}};}};
 const rpc=(operation: unknown,input: unknown,selected=origin)=>raw('/api/rpc',{operation,input,...(selected===undefined?{}:{expectedWorkspaceOrigin:selected})});
 mcp=new Client({name:'restore-real-transport',version:'1.0.0'},{capabilities:{}});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts'),'--workspace-origin',origin],cwd:repo,env,stderr:'pipe'});
 await mcp.connect(transport);(transport.stderr as import('node:stream').Readable|null)?.resume();
 const callMcp=async(operation: string,input: Record<string,unknown>)=>{const result=await (mcp.callTool({name:operation.replaceAll('.','_'),arguments:input}) as Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult>);const body=JSON.parse((result.content.find((item)=>item.type==='text')!.text as string));assert.deepEqual(body,result.structuredContent);assert.equal(Boolean(result.isError),!body!.ok);return body;};
 return {root,source,backup,project,shot,timeline,pending,oldInput,oldAck,origin,raw,rpc,requests,observed,client:((createClient as unknown as (options:import('./helpers/strict-workspace-boundary-types.ts').WorkspaceClientOptions)=>import('./helpers/strict-workspace-boundary-types.ts').WorkspaceClient)({env}) as unknown as FixtureClient),
  db:<T>(read: (db:DatabaseSync)=>T)=>database(root,(read as unknown as Parameters<typeof database>[1])),drop:(route: string|null)=>{droppedRoute=route;},restart:async()=>{await backend.close();backend=await start();},
  assertPreserved:()=>{assert.deepEqual(tree(source),untouched.source);assert.deepEqual(tree(backup),untouched.backup);assert.deepEqual(database(root,(((db: { prepare: (arg0: string) => { (): unknown; new(): unknown; all: { (): unknown; new(): unknown; }; get: { (arg0: string): unknown; new(): unknown; }; }; })=>({jobs:db.prepare('SELECT * FROM jobs ORDER BY id').all(),task:db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(pending.task.id),receipt:db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(oldInput.requestId)})) as unknown as Parameters<typeof database>[1])),captured);},
  mediaStarts:()=>mediaStarts,transports:([{name:'HTTP',call:rpc},{name:'CLI',call:(operation: string,input: unknown)=>cli(t,[...operation.split('.'),'--input',JSON.stringify(input),'--workspace-origin',origin],env)},{name:'MCP',call:callMcp}] as unknown as {name:string;call:import('./helpers/strict-workspace-boundary-types.ts').WorkspaceTransportCall}[])};
}

test('restored actual HTTP, CLI and official MCP edit once, retain lost acknowledgements and replay original receipt across restart',{timeout:120000},async t=>{
 const f=await fixture(t);let timeline=f.timeline;
 for(const transport of f.transports){
  const before=f.requests.length,input={projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),kind:'audio',name:`新 ${transport.name} · 中文`};
  f.drop('/api/rpc');const lost=await transport.call('timeline.track.add',input);assert.equal(lost.ok,false);assert.equal(f.requests.length,before+1,'no hidden retry');
  const accepted=f.observed.at(-1)!.body;assert.equal(accepted.ok,true);const receipt=f.db((db)=>db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId));
  await f.restart();const replay=await transport.call('timeline.track.add',input);assert.deepEqual(replay,accepted);timeline=replay.data;
  assert.deepEqual(f.db((db)=>db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId)),receipt);
  const changed=await transport.call('timeline.track.add',{...input,name:'changed'});assert.equal(changed.ok,false);assert.equal(changed.error.code,'IDEMPOTENCY_CONFLICT');
  assert.deepEqual((await transport.call('timeline.track.add',f.oldInput)).data,f.oldAck);
  const denied=await transport.call('timeline.track.add',f.pending.task.input);assert.equal(denied.ok,false);assert.equal(denied.error.code,'RESTORED_RECORD_HELD');assert.equal(denied.error.details?.mutationOutcome,undefined);
 }
 assert.equal(f.mediaStarts(),0);f.assertPreserved();
});

test('restored durable new lane coexists with captured pending; dropped execution ACK is rediscovered without inherited execution',{timeout:60000},async t=>{
 const f=await fixture(t),input={projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),kind:'audio',name:'新持久意图'};
 const prepared=await f.raw('/api/tasks/prepare',{projectId:f.project.id,operation:'timeline.track.add',input,origin:'new',expectedWorkspaceOrigin:f.origin});assert.equal(prepared.ok,true,JSON.stringify(prepared));
 const value=prepared.data;assert.equal(value.restore.held,false);const route=`/api/tasks/${value.task.id}/execute`,execute={projectId:f.project.id,digest:value.task.digest,instanceId:value.instanceId,expectedWorkspaceOrigin:f.origin};
 f.drop(route);assert.equal((await f.raw(route,(execute as unknown as Parameters<typeof f.raw>[1]))).ok,false);assert.equal(f.observed.at(-1)!.body.data.task.status,'applied');
 await f.restart();const current=await f.raw(`/api/tasks/${value.task.id}?projectId=${f.project.id}`);assert.equal(current.data.task.status,'applied');assert.equal(current.data.task.id,value.task.id);assert.equal(current.data.restore.held,false);
 const duplicate=await f.raw('/api/tasks/prepare',{projectId:f.project.id,operation:'timeline.track.add',input,origin:'new',expectedWorkspaceOrigin:f.origin});assert.equal(duplicate.data.task.id,value.task.id);
 const held=await f.raw(`/api/tasks/${f.pending.task.id}/reconcile`,{projectId:f.project.id,digest:f.pending.task.digest,expectedWorkspaceOrigin:f.origin});assert.equal(held.error.code,'RESTORED_RECORD_HELD');
 assert.equal((f.db((db)=>db.prepare('SELECT count(*) n FROM timeline_requests WHERE requestId=?').get(input.requestId)) as {n:number}).n,1);
 assert.equal(f.mediaStarts(),0);f.assertPreserved();
});

test('restored origin is an explicit mismatch guard across real authenticated routes, never provider or Agent authority',{timeout:60000},async t=>{
 const f=await fixture(t),input={projectId:f.project.id,title:'未批准新来源',requestId:randomUUID()};
 for(const [context,code] of [[{},'RESTORE_WORKSPACE_ORIGIN_REQUIRED'],[{expectedWorkspaceOrigin:randomUUID()},'RESTORE_WORKSPACE_ORIGIN_MISMATCH']] as const){
  const result=await f.raw('/api/rpc',{operation:'shot.create',input,...context});assert.equal(result.error.code,code);
 }
 for(const route of ['/api/agent/settings','/api/images/settings','/api/images/custom-settings','/api/images/comfy-settings'] as const){const result=await f.raw(route);assert.equal(result.error.code,'RESTORE_OPERATION_UNAVAILABLE');}
 assert.equal((await f.rpc('job.retry',{jobId:(f.db((db)=>db.prepare('SELECT id FROM jobs LIMIT 1').get()) as {id:string}).id,requestId:randomUUID()})).error.code,'RESTORED_RECORD_HELD');
 assert.equal((await f.rpc('workspace.backup.inspect',{})).error.code,'RESTORE_OPERATION_UNAVAILABLE');
 assert.equal(f.mediaStarts(),0);f.assertPreserved();
});
