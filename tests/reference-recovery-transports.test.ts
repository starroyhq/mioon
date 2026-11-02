import type {MediaShot,ServiceResponse} from './helpers/strict-service-responses.ts';
import type {Failure} from './helpers/strict-timeline-audio-types.ts';
import type {FixtureAsset} from './helpers/strict-timeline-core-types.ts';
import type {MediaNode} from './helpers/strict-service-responses.ts';
import type {TypedStore, TypedServices, TypedClient} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import type {InspectProject} from '../apps/server/src/index.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createClient} from '../packages/client/src/index.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {createServerProject, schemaObjects, withoutForeignKeys} from './helpers/project-database.ts';

const repo=fileURLToPath(new URL('..',import.meta.url)),token='reference-recovery-public-synthetic-token';
const environment=(extra: NodeJS.ProcessEnv)=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',...extra});
const clone=<T>(value: T): T=>JSON.parse(JSON.stringify(value));
function png(color: string|number|Uint8Array<ArrayBufferLike>|undefined){
 const chunk=(name: string,data:Buffer)=>{const bytes=Buffer.concat([Buffer.from(name),data]),header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(data.length);tail.writeUInt32BE(crc32(bytes));return Buffer.concat([header,bytes,tail]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(36);header.writeUInt32BE(64,4);header[8]=8;header[9]=2;
 const pixels=Buffer.alloc((36*3+1)*64,color);for(let y=0;y<64;y++)pixels[y*(36*3+1)]=0;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
async function command(operation: string,input: unknown,env: { MIOON_BASE_URL: string; MIOON_TOKEN: string; }){
 const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...operation.split('.'),'--input',JSON.stringify(input)],{cwd:repo,env:environment(env),stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';for(const [stream,append] of [[child.stdout,(b: string)=>stdout+=b],[child.stderr,(b: string)=>stderr+=b]] as const)stream.setEncoding('utf8').on('data',(b:string)=>{append(b);if(stdout.length+stderr.length>1024*1024)child.kill('SIGKILL');});
 const timer=setTimeout(()=>child.kill('SIGKILL'),15000);let code,signal;try{[code,signal]=await once(child,'close');}finally{clearTimeout(timer);}
 assert.equal(signal,null,stderr);assert.ok(!stdout.includes(token)&&!stderr.includes(token));const body=JSON.parse(stdout);assert.equal(code===0,body.ok,stdout+stderr);return body;
}
async function fixture(t: test.TestContext){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-reference-recovery-'));let backend:Awaited<ReturnType<typeof startServer>>,proxy:http.Server,mcp: Client<{ method: string; params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }|undefined; },{ method: string; params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }|undefined; },{ [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }>;
 t.after(async()=>{await mcp?.close();if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}await backend?.close();await rm(root,{recursive:true,force:true});});
 const created=createServerProject(root,{name:'Synthetic reference recovery'}),store=(created.store as unknown as TypedStore),project=store.get('projects',created.projectId)!;const sources: ({ asset: FixtureAsset; node: MediaNode; })[]=[];
 try{const services=(createServices(store,new Map()) as TypedServices);
  for(const color of [65,185]){const asset=await services.call('asset.import',{projectId:project.id,name:'Synthetic reference '+color+'.png',mimeType:'image/png',dataBase64:png(color).toString('base64')});const node=await services.call('node.create',{projectId:project.id,type:'image',assetId:asset.id,position:{x:40,y:40},label:'Reference '+color});sources.push({asset:store.get('assets',asset.id)!,node});}
 }finally{store.close();}
 // The server knows the other project too, so the tests can show its name never leaks.
 const other=createServerProject(root,{name:'Foreign ownership must not leak'}),foreign=(other.store as unknown as TypedStore).get('projects',other.projectId)!;other.store.close();
 // The server's own connection, handed over by each server that starts.
 let inspect!:InspectProject;const start=()=>startServer({dataDir:root,port:0,token,inspectProject:received=>{inspect=received;}});
 backend=await start();let fault: { operation: unknown; mode: unknown; }|null=null;const requests: string[]=[],observed: { request: unknown; status: number; text: string; }[]=[];
 proxy=http.createServer(async(req,res)=>{try{const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>128*1024)throw Error('Synthetic request cap');chunks.push(chunk);}const raw=Buffer.concat(chunks).toString();const request=JSON.parse(raw);requests.push(raw);
  const upstream=await fetch(backend.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:raw});const text=await upstream.text();observed.push({request,status:upstream.status,text});
  if(fault&&fault.operation===request.operation){const mode=fault.mode;fault=null;if(mode==='drop'){res.destroy();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,data:{malformed:true}}));return;}
  res.writeHead(upstream.status,{'content-type':'application/json'});res.end(text);
 }catch{res.destroy();}});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const url=`http://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`,env={MIOON_BASE_URL:url,MIOON_TOKEN:token},client=(createClient({env}) as TypedClient);
 mcp=new Client({name:'reference-recovery-tests',version:'1.0.0'},{capabilities:{}});const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env:environment(env),stderr:'pipe'});(transport.stderr as import("node:stream").Readable|null)?.resume();await mcp.connect(transport);
 // The server holds the project while it runs: read and damage the database on its own connection.
 const db=<T>(fn:(db:DatabaseSync)=>T):T=>inspect(project.id,fn);
 const raw=async(operation: unknown,input: unknown)=>{try{const r=await fetch(url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,input})});return await r.json();}catch{return {ok:false,error:{code:'LOST_TRANSPORT'}};}};
 return {project,foreign,sources,requests,observed,db,raw,client,fault:(operation: unknown,mode='drop')=>{fault={operation,mode};},restart:async()=>{await backend.close();backend=await start();},transports:[
  {name:'HTTP',call:raw},
  {name:'CLI',call:(operation:string,input:unknown)=>command(operation,input,env)},
  {name:'MCP',call:async(operation: string,input: unknown)=>{const r=await mcp.callTool({name:operation.replaceAll('.','_'),arguments:input as Record<string,unknown>}) as import('@modelcontextprotocol/sdk/types.js').CallToolResult;const body=JSON.parse((r.content.find(c=>c.type==='text') as {text:string}).text);assert.deepEqual(body,r.structuredContent);assert.equal(Boolean(r.isError),!body!.ok);return body;}}
 ]};
}
const unknown=(body: {ok:unknown;error?:unknown})=>{assert.equal(body.ok,false);assert.notEqual((body.error as Failure).details?.mutationOutcome,'not_applied');assert.ok(!JSON.stringify(body).includes('Foreign ownership must not leak'));return (body.error as Failure);};
const attach=(f: Awaited<ReturnType<typeof fixture>>,shot:Pick<MediaShot,"id"|"revision">,source=f.sources[0])=>({projectId:f.project.id,sourceNodeId:source.node.id,targetShotId:shot.id,expectedSourceRevision:source.node.revision,expectedShotRevision:shot.revision,requestId:randomUUID(),role:'first_frame'});
const detach=(f: Awaited<ReturnType<typeof fixture>>,result:ServiceResponse<"reference.attach">)=>({projectId:f.project.id,edgeId:result.edge.id,expectedShotRevision:result.shot.revision,requestId:randomUUID()});
const isGuard=({type,name}:{type:string;name:string})=>type==='trigger'&&name==='immutable_reference_responses';
// Recreate a dropped guard in the database that held it: an unqualified CREATE TRIGGER would go to main.
const recreate=({schema,sql}:{schema:string;sql:string|null})=>sql!.replace(/^CREATE TRIGGER /u,`CREATE TRIGGER "${schema}".`);
const state=(f: Awaited<ReturnType<typeof fixture>>)=>f.db((db: DatabaseSync)=>Object.fromEntries(['projects','assets','nodes','shots','edges','jobs','versions','exports','reference_requests'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY ${table==='reference_requests'?'requestId':'id'}`).all()])));

test('real HTTP CLI and official MCP lose attach/detach acknowledgements, retain ownership uncertainty and replay historical exact responses',{timeout:120000},async (t: test.TestContext)=>{
 const f=await fixture(t);
 for(const transport of f.transports){
  const shot=(await f.raw('shot.create',{projectId:f.project.id,title:'Recovery '+transport.name,prompt:'Synthetic source only'})).data,input=attach(f,shot),op='reference.attach';
  const sent=f.requests.length;f.fault(op);unknown(await transport.call(op,input));assert.equal(f.requests.length,sent+1,'no automatic POST retry');
  const original=JSON.parse(f.observed.at(-1)!.text).data;assert.ok(original?.edge);const receipt=f.db((db: DatabaseSync)=>db.prepare('SELECT * FROM reference_requests WHERE requestId=?').get(input.requestId));
  // Deliberate corruption only in this owned fixture. Restore its exact trusted
  // guard before restart: fixed schema admission must never repair a missing one.
  const guard=f.db((db: DatabaseSync)=>schemaObjects(db).find(isGuard));assert.equal(typeof guard?.sql,'string');
  f.db((db: DatabaseSync)=>{db.exec('DROP TRIGGER immutable_reference_responses');db.prepare('UPDATE reference_requests SET response=? WHERE requestId=?').run('null',input.requestId);});
  const corruptState=state(f);unknown(await transport.call(op,input));assert.deepEqual(state(f),corruptState);
  f.db((db: DatabaseSync)=>{db.prepare('UPDATE reference_requests SET response=? WHERE requestId=?').run(receipt!.response,input.requestId);db.exec(recreate(guard!));
   assert.deepEqual(schemaObjects(db).find(isGuard),guard);
   assert.throws(()=>db.prepare('UPDATE reference_requests SET response=? WHERE requestId=?').run(receipt!.response,input.requestId),/reference request responses are immutable/);});
  // The asset is moved to the other project as a corrupt file would hold it.
  const source=f.sources[0].asset;f.db((db: DatabaseSync)=>withoutForeignKeys(db,()=>db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.foreign.id,JSON.stringify({...source,projectId:f.foreign.id}),source.id)));
  const foreignState=state(f);unknown(await transport.call(op,input));assert.deepEqual(state(f),foreignState);
  f.db((db: DatabaseSync)=>db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.project.id,JSON.stringify(source),source.id));
  await f.restart();
  const noOp=attach(f,original.shot),same=await transport.call(op,noOp);assert.deepEqual(same,{ok:true,data:original});
  const remove=detach(f,original),beforeDetach=f.requests.length;f.fault('reference.detach');unknown(await transport.call('reference.detach',remove));assert.equal(f.requests.length,beforeDetach+1);
  const removed=JSON.parse(f.observed.at(-1)!.text).data;assert.equal(removed.detached,true);assert.equal(f.db((db: DatabaseSync)=>db.prepare('SELECT count(*) AS n FROM edges WHERE id=?').get(original.edge.id))!.n,0);
  const changed=(await f.raw('shot.update',{shotId:shot.id,expectedRevision:removed.shot.revision,patch:{prompt:'Later saved text'}})).data;
  const rebound=(await f.raw(op,attach(f,changed,f.sources[1]))).data;assert.ok(rebound?.edge);await f.restart();const beforeReplay=state(f);
  for(const [operation,exact,expected] of [[op,input,original],[op,noOp,original],['reference.detach',remove,removed]] as const){
   const before=f.requests.length;assert.deepEqual(await transport.call(operation,exact),{ok:true,data:expected});assert.equal(f.requests.length,before+1);assert.deepEqual(JSON.parse(f.requests.at(-1)!),{operation,input:exact});
  }
  assert.deepEqual(state(f),beforeReplay,'historical replay cannot undo rebind or change any durable row');
  assert.deepEqual(f.db((db: DatabaseSync)=>db.prepare('SELECT * FROM reference_requests WHERE requestId=?').get(input.requestId)),receipt);
  const conflict=await transport.call('reference.detach',{...remove,requestId:input.requestId});assert.equal(unknown(conflict).code,'IDEMPOTENCY_CONFLICT');
  const stale={...detach(f,rebound),expectedShotRevision:removed.shot.revision};const rejected=await transport.call('reference.detach',stale);assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'REVISION_CONFLICT');
  assert.equal(rejected.error.details.mutationOutcome,'not_applied');assert.equal(rejected.error.details.operation,'reference.detach');assert.equal(rejected.error.details.projectId,f.project.id);assert.equal(rejected.error.details.requestId,stale.requestId);
  assert.equal(f.db((db: DatabaseSync)=>db.prepare('SELECT count(*) AS n FROM reference_requests WHERE requestId=?').get(stale.requestId))!.n,0);assert.deepEqual(state(f),beforeReplay);
 }
 assert.equal(f.db((db: DatabaseSync)=>db.prepare('SELECT count(*) AS n FROM jobs').get())!.n,0);
});

test('real malformed reference HTTP client CLI MCP successes retain exact request identity and recover without duplicate changes',{timeout:120000},async (t: test.TestContext)=>{
 const f=await fixture(t),httpClient={name:'HTTP client',call:async<O extends string>(operation: O,input: unknown)=>{try{return {ok:true,data:await f.client.rpc(operation,input)};}catch(error){return {ok:false,error};}}};
 for(const transport of [httpClient,...f.transports.filter(item=>item.name!=='HTTP')]){
  let shot=(await f.raw('shot.create',{projectId:f.project.id,title:'Malformed '+transport.name})).data;
  let added!:ServiceResponse<"reference.attach">;
  for(const operation of ['reference.attach','reference.detach']){
   const input:ReturnType<typeof attach>|ReturnType<typeof detach>=operation==='reference.attach'?attach(f,shot):detach(f,added),before=f.requests.length;f.fault(operation,'malformed');
   const error=unknown(await transport.call(operation,input));assert.equal(error.code,'BACKEND_PROTOCOL_ERROR');assert.equal(error.details.requestId,input.requestId);assert.equal(error.details.operation,operation);assert.equal(error.details.submissionMayHaveSucceeded,true);assert.equal(f.requests.length,before+1);
   const committed=clone(JSON.parse(f.observed.at(-1)!.text).data);const beforeRecovery=state(f);const response=await transport.call(operation,input);assert.deepEqual(response,{ok:true,data:committed});assert.deepEqual(state(f),beforeRecovery);
   if(operation==='reference.attach'){added=committed;shot=added.shot;}
  }
 }
});
