import type {ServiceResponse,MediaJob,MediaShot} from './helpers/strict-service-responses.ts';
import type {WireEnvelope} from './helpers/strict-timeline-wire-response-types.ts';
import type {TestCatalog,TestOperationDefinition} from './helpers/strict-timeline-transport-types.ts';
import type {Failure} from './helpers/strict-timeline-audio-types.ts';
import type {ChildProcess} from 'node:child_process';
import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createServerProject} from './helpers/project-database.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {discoverSchema} from '../packages/client/src/index.ts';
import type { BinaryLike } from 'crypto';

const repo=fileURLToPath(new URL('..',import.meta.url)),token='synthetic-frame-pair-transport-token';
const sleep=(ms: number|undefined)=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=(bytes: Buffer<ArrayBuffer>|BinaryLike)=>createHash('sha256').update(bytes).digest('hex');
const env=(extra: NodeJS.ProcessEnv)=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',...extra});
// The backend stays a child process: the wire guard patches its process-wide
// network and process APIs. While it holds the project the parent cannot open
// a second connection, so the parent asks it over IPC to count rows on its own.
const serverSource=`
import {installWireGuard} from './tests/helpers/inspection-wire-fixture.ts';
installWireGuard({auditPath:process.env.MIOON_WIRE_AUDIT});
const {startServer}=await import('./apps/server/src/index.ts');
let inspect;
const server=await startServer({dataDir:process.env.MIOON_DATA_DIR,port:0,token:process.env.MIOON_TOKEN,inspectProject:received=>{inspect=received;}});
process.on('message',({id,projectId,table})=>{let reply;try{if(table!=='mock_provider_submissions')throw Error('Unsupported fixture count');reply={id,count:inspect(projectId,db=>db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n)};}catch(error){reply={id,error:String(error?.message??error)};}if(process.connected)process.send(reply);});
console.log('FRAME_PAIR_READY '+server.url);
let closing; const close=()=>closing??=server.close().catch(()=>{process.exitCode=1}).finally(()=>{if(process.connected)process.disconnect();});
process.on('SIGTERM',close);process.on('SIGINT',close);process.once('disconnect',close);
`;
async function bounded<T>(promise: Promise<T>,label: string|undefined,milliseconds=10_000){let timer;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),milliseconds);})]);}finally{clearTimeout(timer);}}
async function stopOwned(child: ChildProcess){
 if(!child||child.exitCode!==null||child.signalCode)return;
 const closed=once(child,'close');child.kill('SIGTERM');
 const timer=setTimeout(()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');},3_000);
 try{await bounded(closed,'Owned fixture child cleanup unconfirmed',6_000);}finally{clearTimeout(timer);}
}
function png(color: ArrayLike<number>){
 const chunk=(name: string,bytes:Uint8Array)=>{const type=Buffer.from(name),header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(bytes.length);tail.writeUInt32BE(crc32(Buffer.concat([type,bytes])));return Buffer.concat([header,type,bytes,tail]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(360);header.writeUInt32BE(640,4);header[8]=8;header[9]=2;
 const raw=Buffer.alloc((360*3+1)*640);for(let y=0;y<640;y++)for(let x=0;x<360;x++)raw.set(color,y*(360*3+1)+1+x*3);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
async function runCli(args: string[],environment: { MIOON_BASE_URL?: string; MIOON_TOKEN: string; MIOON_DATA_DIR?: string; MIOON_WIRE_AUDIT?: string; },error?: string|undefined){
 const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...args],{cwd:repo,env:env(environment),stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>2*1024*1024&&child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');});
 child.stderr.setEncoding('utf8').on('data',chunk=>{stderr=(stderr+chunk).slice(-20_000);});
 let code,signal;
 try{[code,signal]=await bounded(once(child,'close'),'Frame pair CLI close timeout',15_000);}finally{await stopOwned(child);}
 assert.equal(signal,null,stderr);assert.equal(stdout.trim().split('\n').length,1);assert.ok(!stdout.includes(token)&&!stderr.includes(token));
 const result=JSON.parse(stdout);assert.equal(result.ok,!error,stdout+stderr);if(error){assert.notEqual(code,0);assert.equal(result.error.code,error);}else assert.equal(code,0,stderr);return result;
}
async function fixture(t: test.TestContext){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-frame-pair-wire-'));const created=createServerProject(root,{name:'首尾帧 transport'}),store=(created.store as unknown as TypedStore);let service,child: ReturnType<typeof spawn>,proxy: http.Server<typeof http.IncomingMessage,typeof http.ServerResponse>,url: string,dropNext=false,dropped!:WireEnvelope<'generation.submit'>;
 let project,other,first,last,foreign,legacyShot;
 const make=async(owner: TypedStore,projectId: string,name: string,color: ArrayLike<number>)=>{const bytes=png(color),id=randomUUID(),relativePath=`media/${id}.png`;await writeFile(path.join(root,relativePath),bytes,{mode:0o600});return owner.put('assets',{id,projectId,name,relativePath,mimeType:'image/png',sha256:sha(bytes),sizeBytes:bytes.length,width:360,height:640,duration:0,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:new Date().toISOString()});};
 try{
  service=(createServices(store,createProviderRegistry({db:store.db,root,env:{}}),{env:{}}) as TypedServices);
  project=store.get('projects',created.projectId)!;
  first=await make(store,project.id,'首帧蓝图',[20,60,190]);last=await make(store,project.id,'尾帧绿图',[20,180,70]);
  legacyShot=await service.call('shot.create',{projectId:project.id,title:'Legacy omitted tail',referenceAssetIds:[first.id],duration:4,parameters:{delayMs:120000}});
  await service.drain();
 }finally{store.close();}
 // The server knows the other project too: a request names its image and must be refused.
 const otherCreated=createServerProject(root,{name:'Foreign frame project'}),otherStore=(otherCreated.store as unknown as TypedStore);
 try{other=otherStore.get('projects',otherCreated.projectId)!;foreign=await make(otherStore,other.id,'Foreign image',[150,70,20]);}finally{otherStore.close();}
 const originalFirst=await readFile(path.join(root,first.relativePath)),originalLast=await readFile(path.join(root,last.relativePath));
 let stdout='',stderr='';
 // Count questions waiting for the running backend; a backend that exits answers none of them.
 const pending=new Map<string,PromiseWithResolvers<number>>();
 async function start(){
  stdout='';stderr='';child=spawn(process.execPath,['--input-type=module','--eval',serverSource],{cwd:repo,env:env({MIOON_DATA_DIR:root,MIOON_TOKEN:token,MIOON_WIRE_AUDIT:path.join(root,'wire-audit.jsonl')}),stdio:['ignore','pipe','pipe','ipc']});
  child.stdout!.setEncoding('utf8').on('data',(chunk: string)=>{stdout=(stdout+chunk).slice(-20_000);});
  child.stderr!.setEncoding('utf8').on('data',(chunk: string)=>{stderr=(stderr+chunk).slice(-20_000);});
  child.on('message',(message: {id: string; count?: number; error?: string})=>{const reply=pending.get(message.id);if(!reply)return;if(message.error!==undefined)reply.reject(Error(message.error));else reply.resolve(message.count!);});
  child.once('exit',()=>{for(const reply of pending.values())reply.reject(Error('Owned backend exited before it answered'));});
  const until=Date.now()+15_000;
  while(Date.now()<until){assert.equal(child.exitCode,null,stdout+stderr);assert.equal(child.signalCode,null,stdout+stderr);const found=/FRAME_PAIR_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];if(found){url=found;return;}await sleep(20);}
  throw Error('Frame pair owned backend readiness timeout: '+stdout+stderr);
 }
 // Rows of one table, counted on the running backend's own connection.
 async function count(table: string){const id=randomUUID(),reply=Promise.withResolvers<number>();pending.set(id,reply);child.send({id,projectId:created.projectId,table},error=>{if(error)reply.reject(error);});try{return await bounded(reply.promise,'Owned backend count');}finally{pending.delete(id);}}
 t.after(async()=>{const errors: (unknown)[]=[];for(const cleanup of [async()=>{if(proxy){proxy.closeAllConnections();await bounded(new Promise(resolve=>proxy.close(resolve)),'Proxy close');}},()=>stopOwned(child),()=>rm(root,{recursive:true,force:true})])try{await cleanup();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Owned frame pair cleanup failed');});
 await writeFile(path.join(root,'wire-audit.jsonl'),'',{mode:0o600});
 await start();
 proxy=http.createServer(async(request,response)=>{try{const chunks:Uint8Array[]=[];for await(const chunk of request)chunks.push(chunk);const body=Buffer.concat(chunks),operation=JSON.parse(body as unknown as string).operation;const upstream=await fetch(url+'/api/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:request.headers.authorization!},body,redirect:'error',signal:AbortSignal.timeout(10_000)});const bytes=Buffer.from(await upstream.arrayBuffer());if(dropNext&&operation==='generation.submit'){dropNext=false;dropped=JSON.parse(bytes as unknown as string);response.destroy();return;}response.writeHead(upstream.status,{'content-type':'application/json'});response.end(bytes);}catch{response.destroy();}});
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const proxyUrl=`http://127.0.0.1:${(proxy.address()! as import('node:net').AddressInfo).port}`;
 async function rpc<O extends string,E extends string|undefined=undefined>(operation:O,input:unknown={},error?:E,base=url):Promise<E extends string?Failure:ServiceResponse<O>>{const response=await fetch(base+'/api/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({operation,input}),redirect:'error',signal:AbortSignal.timeout(10_000)});const result=await response.json();assert.equal(result.ok,!error,JSON.stringify(result));if(error)assert.equal(result.error.code,error);else assert.equal(response.status,200);assert.ok(!JSON.stringify(result).includes(root)&&!JSON.stringify(result).includes(token));return result.data??result.error;}
 return {root,project,other,first,last,foreign,legacyShot,rpc,get url(){return url;},get env(){return {MIOON_BASE_URL:url,MIOON_TOKEN:token};},drop(){dropNext=true;},get dropped(){return dropped;},proxyUrl,
  original:async()=>{assert.deepEqual(await readFile(path.join(root,first.relativePath)),originalFirst);assert.deepEqual(await readFile(path.join(root,last.relativePath)),originalLast);},
  submissions:()=>count('mock_provider_submissions'),
  async restart(){await stopOwned(child);await start();},
 };
}
async function mcp(t: test.TestContext,f: Awaited<ReturnType<typeof fixture>>){
 const client=new Client({name:'frame-pair-wire',version:'1.0.0'},{capabilities:{}}),transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env:env(f.env),stderr:'pipe'});let stderr='';
 (transport.stderr as import('node:stream').Readable|null)?.setEncoding('utf8').on('data',(chunk: string)=>{stderr=(stderr+chunk).slice(-20_000);});
 t.after(async()=>{await bounded(client.close(),'MCP close');assert.ok(!stderr.includes(token));});await client.connect(transport);
 return {client,call:async<O extends string,E extends string|undefined=undefined>(operation:O,input:Record<string,unknown>,error?:E):Promise<E extends string?Failure:ServiceResponse<O>>=>{const response=(await client.callTool({name:operation.replaceAll('.','_'),arguments:input}) as import("@modelcontextprotocol/sdk/types.js").CallToolResult);const value=response.structuredContent as unknown as WireEnvelope<O>;assert.equal(value!.ok,!error,JSON.stringify(response));if(error)assert.equal(value!.error.code,error);assert.ok(!JSON.stringify(value).includes(token));return (value!.data??value!.error) as E extends string?Failure:ServiceResponse<O>;}};
}

test('saved frame pairs share strict real HTTP/CLI/official MCP, exact recovery and restart semantics',async (t: test.TestContext)=>{
 const f=await fixture(t),bridge=await mcp(t,f);let shot:MediaShot,update:Record<string,unknown>,receipt:MediaShot,job:MediaJob,input:Record<string,unknown>;
 await t.test('schema exposes nullable optional tail without changing first-frame attach role',async()=>{
  const schema=discoverSchema() as unknown as TestCatalog;const cli=await runCli(['schema'],f.env);assert.deepEqual(cli.data,schema);
  const tools=await bridge.client.listTools();for(const operation of ['shot.create','shot.update','reference.attach','generation.submit']){const local=schema.operations.find((item: { operation: string; })=>item.operation===operation);assert.ok(local);const tool=tools.tools.find(item=>item.name===operation.replaceAll('.','_'));assert.deepEqual(tool!.inputSchema,local.inputSchema);}
  const old=await f.rpc('project.get',{projectId:f.project.id});assert.equal(Object.hasOwn(old.shots.find((s: { id: string; })=>s.id===f.legacyShot.id)!,'lastFrameAssetId'),false);
 });
 await t.test('HTTP creates, CLI saves and MCP exactly replays the complete stored tail',async()=>{
  shot=await f.rpc('shot.create',{projectId:f.project.id,title:'Paired shot',prompt:'Synthetic pair, no visual conditioning',referenceAssetIds:[f.first.id],duration:4,parameters:{delayMs:120000},requestId:randomUUID()});
  update={shotId:shot.id,expectedRevision:shot.revision,patch:{lastFrameAssetId:f.last.id},requestId:randomUUID()};receipt=(await runCli(['rpc','shot.update','--input',JSON.stringify(update)],f.env)).data;assert.equal(receipt.lastFrameAssetId,f.last.id);assert.deepEqual(await bridge.call('shot.update',update),receipt);shot=receipt;
  await f.rpc('shot.update',{...update,patch:{lastFrameAssetId:null}},'IDEMPOTENCY_CONFLICT');
  await f.rpc('shot.update',{...update,requestId:randomUUID(),expectedRevision:shot.revision,patch:{lastFrameAssetId:f.foreign.id}},'CROSS_PROJECT_REFERENCE');
  await f.rpc('shot.update',{...update,requestId:randomUUID(),expectedRevision:shot.revision,patch:{lastFrameAssetId:f.last.id,arbitraryAuthority:true}},'VALIDATION_ERROR');
 });
 await t.test('lost generation HTTP acknowledgement retains one immutable pair and one provider submission',async()=>{
  assert.ok(shot);input={shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',requestId:randomUUID()};f.drop();await assert.rejects(f.rpc('generation.submit',input,undefined,f.proxyUrl));assert.equal(f.dropped.ok,true);job=f.dropped.data;
  assert.deepEqual(job.snapshot.referenceAssetIds,[f.first.id,f.last.id]);assert.deepEqual(job.snapshot.referenceBindings!.map((x: { role: unknown; })=>x.role),['first_frame','last_frame']);assert.deepEqual(job.snapshot.referenceBindings!.map((x: { sha256: unknown; })=>x.sha256),[f.first.sha256,f.last.sha256]);
  const replay=await bridge.call('generation.submit',input);assert.equal(replay.id,job.id);assert.deepEqual(replay.snapshot,job.snapshot);
  const until=Date.now()+10_000;while((await f.submissions())===0&&Date.now()<until)await sleep(20);assert.equal(await f.submissions(),1);
  await f.rpc('generation.submit',{...input,model:'different'},'IDEMPOTENCY_CONFLICT');
 });
 await t.test('restart finds saved selection and exact keys; explicit clear leaves frozen job unchanged',async()=>{
  assert.ok(job);await bridge.client.close();await f.restart();const project=await f.rpc('project.get',{projectId:f.project.id});const saved=project.shots.find((s: { id: unknown; })=>s.id===shot.id)!;assert.equal(saved.lastFrameAssetId,f.last.id);assert.deepEqual(await f.rpc('shot.update',update),receipt);
  const replay=(await runCli(['rpc','generation.submit','--input',JSON.stringify(input)],f.env)).data;assert.equal(replay.id,job.id);assert.deepEqual(replay.snapshot,job.snapshot);assert.equal(await f.submissions(),1);
  const cleared=await f.rpc('shot.update',{shotId:shot.id,expectedRevision:saved.revision,patch:{lastFrameAssetId:null},requestId:randomUUID()});assert.equal(cleared.lastFrameAssetId,null);assert.deepEqual((await f.rpc('job.get',{jobId:job.id})).snapshot,job.snapshot);await f.original();assert.equal(await readFile(path.join(f.root,'wire-audit.jsonl'),'utf8'),'','No fixture guard observed a forbidden network/process action');
 });
});
