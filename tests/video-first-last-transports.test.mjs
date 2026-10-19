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
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {discoverSchema} from '../packages/client/src/index.ts';

const repo=fileURLToPath(new URL('..',import.meta.url)),token='synthetic-frame-pair-transport-token';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const env=extra=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',...extra});
const serverSource=`
import {installWireGuard} from './tests/helpers/inspection-wire-fixture.mjs';
installWireGuard({auditPath:process.env.MIOON_WIRE_AUDIT});
const {startServer}=await import('./apps/server/src/index.ts');
const server=await startServer({dataDir:process.env.MIOON_DATA_DIR,port:0,token:process.env.MIOON_TOKEN});
console.log('FRAME_PAIR_READY '+server.url);
let closing; const close=()=>closing??=server.close().catch(()=>{process.exitCode=1});
process.on('SIGTERM',close);process.on('SIGINT',close);
`;
async function bounded(promise,label,milliseconds=10_000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),milliseconds);})]);}finally{clearTimeout(timer);}}
async function stopOwned(child){
 if(!child||child.exitCode!==null||child.signalCode)return;
 const closed=once(child,'close');child.kill('SIGTERM');
 const timer=setTimeout(()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');},3_000);
 try{await bounded(closed,'Owned fixture child cleanup unconfirmed',6_000);}finally{clearTimeout(timer);}
}
function png(color){
 const chunk=(name,bytes)=>{const type=Buffer.from(name),header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(bytes.length);tail.writeUInt32BE(crc32(Buffer.concat([type,bytes])));return Buffer.concat([header,type,bytes,tail]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(360);header.writeUInt32BE(640,4);header[8]=8;header[9]=2;
 const raw=Buffer.alloc((360*3+1)*640);for(let y=0;y<640;y++)for(let x=0;x<360;x++)raw.set(color,y*(360*3+1)+1+x*3);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
async function runCli(args,environment,error){
 const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...args],{cwd:repo,env:env(environment),stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>2*1024*1024&&child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');});
 child.stderr.setEncoding('utf8').on('data',chunk=>{stderr=(stderr+chunk).slice(-20_000);});
 let code,signal;
 try{[code,signal]=await bounded(once(child,'close'),'Frame pair CLI close timeout',15_000);}finally{await stopOwned(child);}
 assert.equal(signal,null,stderr);assert.equal(stdout.trim().split('\n').length,1);assert.ok(!stdout.includes(token)&&!stderr.includes(token));
 const result=JSON.parse(stdout);assert.equal(result.ok,!error,stdout+stderr);if(error){assert.notEqual(code,0);assert.equal(result.error.code,error);}else assert.equal(code,0,stderr);return result;
}
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-frame-pair-wire-'));let store=openStore(root),service,child,db,proxy,url,dropNext=false,dropped;
 let project,other,first,last,foreign,legacyShot;
 try{
  service=createServices(store,createProviderRegistry({db:store.db,root,env:{}}),{env:{}});
  project=await service.call('project.create',{name:'首尾帧 transport'});other=await service.call('project.create',{name:'Foreign frame project'});
  const make=async(projectId,name,color)=>{const bytes=png(color),id=randomUUID(),relativePath=`media/${id}.png`;await writeFile(path.join(root,relativePath),bytes,{mode:0o600});return store.put('assets',{id,projectId,name,relativePath,mimeType:'image/png',sha256:sha(bytes),sizeBytes:bytes.length,width:360,height:640,duration:0,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:new Date().toISOString()});};
  first=await make(project.id,'首帧蓝图',[20,60,190]);last=await make(project.id,'尾帧绿图',[20,180,70]);foreign=await make(other.id,'Foreign image',[150,70,20]);
  legacyShot=await service.call('shot.create',{projectId:project.id,title:'Legacy omitted tail',referenceAssetIds:[first.id],duration:4,parameters:{delayMs:120000}});
  await service.drain();
 }finally{store.close();}
 const originalFirst=await readFile(path.join(root,first.relativePath)),originalLast=await readFile(path.join(root,last.relativePath));
 let stdout='',stderr='';
 async function start(){
  stdout='';stderr='';child=spawn(process.execPath,['--input-type=module','--eval',serverSource],{cwd:repo,env:env({MIOON_DATA_DIR:root,MIOON_TOKEN:token,MIOON_WIRE_AUDIT:path.join(root,'wire-audit.jsonl')}),stdio:['ignore','pipe','pipe']});
  child.stdout.setEncoding('utf8').on('data',chunk=>{stdout=(stdout+chunk).slice(-20_000);});
  child.stderr.setEncoding('utf8').on('data',chunk=>{stderr=(stderr+chunk).slice(-20_000);});
  const until=Date.now()+15_000;
  while(Date.now()<until){assert.equal(child.exitCode,null,stdout+stderr);assert.equal(child.signalCode,null,stdout+stderr);const found=/FRAME_PAIR_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];if(found){url=found;return;}await sleep(20);}
  throw Error('Frame pair owned backend readiness timeout: '+stdout+stderr);
 }
 t.after(async()=>{const errors=[];for(const cleanup of [async()=>{if(proxy){proxy.closeAllConnections();await bounded(new Promise(resolve=>proxy.close(resolve)),'Proxy close');}},async()=>db?.close(),()=>stopOwned(child),()=>rm(root,{recursive:true,force:true})])try{await cleanup();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Owned frame pair cleanup failed');});
 await writeFile(path.join(root,'wire-audit.jsonl'),'',{mode:0o600});
 await start();db=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});
 proxy=http.createServer(async(request,response)=>{try{const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=Buffer.concat(chunks),operation=JSON.parse(body).operation;const upstream=await fetch(url+'/api/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:request.headers.authorization},body,redirect:'error',signal:AbortSignal.timeout(10_000)});const bytes=Buffer.from(await upstream.arrayBuffer());if(dropNext&&operation==='generation.submit'){dropNext=false;dropped=JSON.parse(bytes);response.destroy();return;}response.writeHead(upstream.status,{'content-type':'application/json'});response.end(bytes);}catch{response.destroy();}});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
 async function rpc(operation,input={},error,base=url){const response=await fetch(base+'/api/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({operation,input}),redirect:'error',signal:AbortSignal.timeout(10_000)});const result=await response.json();assert.equal(result.ok,!error,JSON.stringify(result));if(error)assert.equal(result.error.code,error);else assert.equal(response.status,200);assert.ok(!JSON.stringify(result).includes(root)&&!JSON.stringify(result).includes(token));return result.data??result.error;}
 return {root,project,other,first,last,foreign,legacyShot,rpc,db,get url(){return url;},get env(){return {MIOON_BASE_URL:url,MIOON_TOKEN:token};},drop(){dropNext=true;},get dropped(){return dropped;},proxyUrl,
  original:async()=>{assert.deepEqual(await readFile(path.join(root,first.relativePath)),originalFirst);assert.deepEqual(await readFile(path.join(root,last.relativePath)),originalLast);},
  submissions:()=>db.prepare('SELECT COUNT(*) AS n FROM mock_provider_submissions').get().n,
  async restart(){db.close();db=null;await stopOwned(child);await start();db=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});},
 };
}
async function mcp(t,f){
 const client=new Client({name:'frame-pair-wire',version:'1.0.0'},{capabilities:{}}),transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env:env(f.env),stderr:'pipe'});let stderr='';
 transport.stderr?.setEncoding('utf8').on('data',chunk=>{stderr=(stderr+chunk).slice(-20_000);});
 t.after(async()=>{await bounded(client.close(),'MCP close');assert.ok(!stderr.includes(token));});await client.connect(transport);
 return {client,call:async(operation,input,error)=>{const response=await client.callTool({name:operation.replaceAll('.','_'),arguments:input});const value=response.structuredContent;assert.equal(value.ok,!error,JSON.stringify(response));if(error)assert.equal(value.error.code,error);assert.ok(!JSON.stringify(value).includes(token));return value.data??value.error;}};
}

test('saved frame pairs share strict real HTTP/CLI/official MCP, exact recovery and restart semantics',async t=>{
 const f=await fixture(t),bridge=await mcp(t,f);let shot,update,receipt,job,input;
 await t.test('schema exposes nullable optional tail without changing first-frame attach role',async()=>{
  const schema=discoverSchema();const cli=await runCli(['schema'],f.env);assert.deepEqual(cli.data,schema);
  const tools=await bridge.client.listTools();for(const operation of ['shot.create','shot.update','reference.attach','generation.submit']){const local=schema.operations.find(item=>item.operation===operation);assert.ok(local);const tool=tools.tools.find(item=>item.name===operation.replaceAll('.','_'));assert.deepEqual(tool.inputSchema,local.inputSchema);}
  const old=await f.rpc('project.get',{projectId:f.project.id});assert.equal(Object.hasOwn(old.shots.find(s=>s.id===f.legacyShot.id),'lastFrameAssetId'),false);
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
  assert.deepEqual(job.snapshot.referenceAssetIds,[f.first.id,f.last.id]);assert.deepEqual(job.snapshot.referenceBindings.map(x=>x.role),['first_frame','last_frame']);assert.deepEqual(job.snapshot.referenceBindings.map(x=>x.sha256),[f.first.sha256,f.last.sha256]);
  const replay=await bridge.call('generation.submit',input);assert.equal(replay.id,job.id);assert.deepEqual(replay.snapshot,job.snapshot);
  const until=Date.now()+10_000;while(f.submissions()===0&&Date.now()<until)await sleep(20);assert.equal(f.submissions(),1);
  await f.rpc('generation.submit',{...input,model:'different'},'IDEMPOTENCY_CONFLICT');
 });
 await t.test('restart finds saved selection and exact keys; explicit clear leaves frozen job unchanged',async()=>{
  assert.ok(job);await bridge.client.close();await f.restart();const project=await f.rpc('project.get',{projectId:f.project.id});const saved=project.shots.find(s=>s.id===shot.id);assert.equal(saved.lastFrameAssetId,f.last.id);assert.deepEqual(await f.rpc('shot.update',update),receipt);
  const replay=(await runCli(['rpc','generation.submit','--input',JSON.stringify(input)],f.env)).data;assert.equal(replay.id,job.id);assert.deepEqual(replay.snapshot,job.snapshot);assert.equal(f.submissions(),1);
  const cleared=await f.rpc('shot.update',{shotId:shot.id,expectedRevision:saved.revision,patch:{lastFrameAssetId:null},requestId:randomUUID()});assert.equal(cleared.lastFrameAssetId,null);assert.deepEqual((await f.rpc('job.get',{jobId:job.id})).snapshot,job.snapshot);await f.original();assert.equal(await readFile(path.join(f.root,'wire-audit.jsonl'),'utf8'),'','No fixture guard observed a forbidden network/process action');
 });
});
