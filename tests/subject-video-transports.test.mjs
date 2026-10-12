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
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createProviderRegistry} from '../packages/business/src/provider-registry.mjs';
import {mediaEnvironment} from '../packages/business/src/media-environment.mjs';
import {discoverSchema} from '../packages/client/src/index.mjs';

import {isSubjectGenerationResponse} from '@mioon/contracts';

const repo=fileURLToPath(new URL('..',import.meta.url)),token='synthetic-subject-video-transport-token';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const env=extra=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',...extra});
const serverSource=`
import {installWireGuard} from './tests/helpers/inspection-wire-fixture.mjs';
installWireGuard({auditPath:process.env.MIOON_WIRE_AUDIT});
const {startServer}=await import('./apps/server/src/index.mjs');
const server=await startServer({dataDir:process.env.MIOON_DATA_DIR,port:0,token:process.env.MIOON_TOKEN});
console.log('SUBJECT_VIDEO_READY '+server.url);
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
 const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/index.mjs'),...args],{cwd:repo,env:env(environment),stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>2*1024*1024&&child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');});
 child.stderr.setEncoding('utf8').on('data',chunk=>{stderr=(stderr+chunk).slice(-20_000);});
 let code,signal;
 try{[code,signal]=await bounded(once(child,'close'),'Subject video CLI close timeout',15_000);}finally{await stopOwned(child);}
 assert.equal(signal,null,stderr);assert.equal(stdout.trim().split('\n').length,1);assert.ok(!stdout.includes(token)&&!stderr.includes(token));
 const result=JSON.parse(stdout);assert.equal(result.ok,!error,stdout+stderr);if(error){assert.notEqual(code,0);assert.equal(result.error.code,error);}else assert.equal(code,0,stderr);return result;
}
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-subject-video-wire-'));let store=openStore(root),service,child,db,proxy,url,dropNext=false,dropped;
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
  while(Date.now()<until){assert.equal(child.exitCode,null,stdout+stderr);assert.equal(child.signalCode,null,stdout+stderr);const found=/SUBJECT_VIDEO_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];if(found){url=found;return;}await sleep(20);}
  throw Error('Subject video owned backend readiness timeout: '+stdout+stderr);
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
 const client=new Client({name:'subject-video-wire',version:'1.0.0'},{capabilities:{}}),transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.mjs')],cwd:repo,env:env(f.env),stderr:'pipe'});let stderr='';
 transport.stderr?.setEncoding('utf8').on('data',chunk=>{stderr=(stderr+chunk).slice(-20_000);});
 t.after(async()=>{await bounded(client.close(),'MCP close');assert.ok(!stderr.includes(token));});await client.connect(transport);
 return {client,call:async(operation,input,error)=>{const response=await client.callTool({name:operation.replaceAll('.','_'),arguments:input});const value=response.structuredContent;assert.equal(value.ok,!error,JSON.stringify(response));if(error)assert.equal(value.error.code,error);assert.ok(!JSON.stringify(value).includes(token));return value.data??value.error;}};
}

test('explicit subject video input shares strict HTTP/CLI/MCP, historical recovery and backend restart',async t=>{
 const f=await fixture(t),bridge=await mcp(t,f);let subject,shot,input,job;
 await t.test('schema has optional UUID only and stays identical across actual CLI and official MCP',async()=>{
  const schema=discoverSchema(),cli=await runCli(['schema'],f.env);assert.deepEqual(cli.data,schema);
  const definition=schema.operations.find(x=>x.operation==='generation.submit');
  const selector=definition.inputSchema.properties.subjectVersionId;
  const uuidSchema=selector.$ref==='#/properties/shotId'?definition.inputSchema.properties.shotId:selector;
  assert.equal(uuidSchema.type,'string');assert.equal(uuidSchema.format,'uuid');assert.ok(!definition.inputSchema.required.includes('subjectVersionId'));assert.equal(definition.inputSchema.additionalProperties,false);
  const tool=(await bridge.client.listTools()).tools.find(x=>x.name==='generation_submit');assert.deepEqual(tool.inputSchema,definition.inputSchema);
  subject=await f.rpc('subject.create',{projectId:f.project.id,kind:'product',name:'纸盒主体',assetId:f.first.id,requestId:randomUUID()});
  shot=await f.rpc('shot.create',{projectId:f.project.id,title:'Explicit subject',prompt:'A plain product on a table',duration:4,parameters:{delayMs:120000},requestId:randomUUID()});
  const base={shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',requestId:randomUUID()};
  for(const patch of [{subjectVersionId:null},{subjectVersionId:[subject.headVersionId]},{subjectVersionId:'not-a-uuid'},{subjectVersionId:subject.headVersionId,assetHash:f.first.sha256}])await f.rpc('generation.submit',{...base,...patch},'VALIDATION_ERROR');
  assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,0);
 });
 await t.test('lost ACK and exact MCP replay create one original subject task without reference binding inference',async()=>{
  input={shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',subjectVersionId:subject.headVersionId,requestId:randomUUID()};
  f.drop();await assert.rejects(f.rpc('generation.submit',input,undefined,f.proxyUrl));assert.equal(f.dropped.ok,true);job=f.dropped.data;
  assert.equal(isSubjectGenerationResponse('generation.submit',input,job,{projectId:f.project.id}),true);
  assert.deepEqual(job.snapshot.subjectReference,{subjectVersionId:subject.headVersionId,subjectName:subject.name,subjectKind:'product',subjectVersion:subject.headVersion});
  assert.deepEqual(job.snapshot.referenceBindings,[{role:'subject_reference',assetId:f.first.id,sha256:f.first.sha256}]);assert.deepEqual(job.snapshot.referenceConnections,[]);
  const replay=await bridge.call('generation.submit',input);assert.equal(replay.id,job.id);assert.deepEqual(replay.snapshot,job.snapshot);
  const until=Date.now()+10_000;while(f.submissions()===0&&Date.now()<until)await sleep(20);assert.equal(f.submissions(),1);
 });
 await t.test('head and shot changes never replace the selected historical version or original key',async()=>{
  const added=(await runCli(['subject','version','add','--input',JSON.stringify({projectId:f.project.id,subjectId:subject.id,expectedRevision:subject.revision,assetId:f.last.id,requestId:randomUUID()})],f.env)).data;
  assert.equal(added.revision,2);assert.notEqual(added.headVersionId,input.subjectVersionId);
  await f.rpc('shot.update',{shotId:shot.id,expectedRevision:shot.revision,patch:{prompt:'Later draft'},requestId:randomUUID()});
  const historical=await f.rpc('generation.submit',input);assert.equal(historical.id,job.id);assert.deepEqual(historical.snapshot,job.snapshot);
  await f.rpc('generation.submit',{...input,subjectVersionId:added.headVersionId},'IDEMPOTENCY_CONFLICT');
  const omitted={...input};delete omitted.subjectVersionId;await f.rpc('generation.submit',omitted,'IDEMPOTENCY_CONFLICT');
  await f.rpc('generation.submit',{shotId:f.legacyShot.id,expectedRevision:f.legacyShot.revision,providerId:'mock',subjectVersionId:subject.headVersionId,requestId:randomUUID()},'REFERENCE_STATE_CONFLICT');
  assert.equal(f.submissions(),1);assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
 });
 await t.test('backend recreation rediscovers original pinned input and one submission, without changing original files',async()=>{
  await bridge.client.close();await f.restart();
  const replay=(await runCli(['generation','submit','--input',JSON.stringify(input)],f.env)).data;
  assert.equal(replay.id,job.id);assert.deepEqual(replay.snapshot,job.snapshot);assert.equal(f.submissions(),1);
  const current=await f.rpc('project.get',{projectId:f.project.id});assert.equal(current.jobs.length,1);assert.deepEqual(current.jobs[0].snapshot,job.snapshot);
  await f.original();assert.equal(await readFile(path.join(f.root,'wire-audit.jsonl'),'utf8'),'','The guard recorded no forbidden outbound or process action');
 });
});
