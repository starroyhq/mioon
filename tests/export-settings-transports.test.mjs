import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClient,discoverSchema,effectAnnotations} from '@mioon/client';
import {isTimelineExportCapabilitiesResponse,isTimelineMutationResponse,publicValue,resolveTimelineExportDelivery} from '@mioon/contracts';
import {startServer} from '../apps/server/src/index.mjs';
import {mediaEnvironment} from '../packages/business/src/media-environment.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.mjs';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.mjs';

const REPO=fileURLToPath(new URL('..',import.meta.url));
const TOKEN='synthetic-export-settings-wire-token';
const operation='timeline.export.capabilities';
const settings=(rateControl={mode:'crf',quality:'standard'})=>({profileId:'mp4_h264_v1',resolution:'short_360',rateControl});
const environment=url=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',...(url?{MIOON_BASE_URL:url,MIOON_TOKEN:TOKEN}:{})});
const sha=value=>createHash('sha256').update(value).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const noPrivate=value=>{const text=typeof value==='string'?value:JSON.stringify(value);assert.ok(!text.includes(TOKEN));assert.ok(!text.includes('Bearer '));};
async function bounded(promise,label,ms=35000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} timed out`)),ms);})]);}finally{clearTimeout(timer);}}

async function cli(url,args){
 const child=spawn(process.execPath,[path.join(REPO,'apps/cli/src/index.mjs'),...args],{cwd:REPO,env:environment(url),stdio:['ignore','pipe','pipe']});
 let out='',err='',overflow=false;
 child.stdout.setEncoding('utf8').on('data',part=>{out+=part;if(Buffer.byteLength(out)>1024*1024){overflow=true;child.kill('SIGKILL');}});
 child.stderr.setEncoding('utf8').on('data',part=>{err+=part;if(Buffer.byteLength(err)>64*1024){overflow=true;child.kill('SIGKILL');}});
 const closed=once(child,'close'),timer=setTimeout(()=>child.kill('SIGKILL'),35000);
 let code,signal;try{[code,signal]=await bounded(closed,'CLI close',38000);}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await bounded(closed,'CLI forced close',3000);}}
 assert.equal(overflow,false,'bounded CLI output');assert.equal(signal,null,err);noPrivate(out);noPrivate(err);
 assert.equal(out.trim().split('\n').length,1,'exactly one JSON acknowledgement');
 const body=JSON.parse(out);assert.equal(code===0,body.ok,out+err);return body;
}
async function officialMcp(t,url){
 const mcp=new Client({name:'export-settings-wire-acceptance',version:'1.0.0'},{capabilities:{}});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(REPO,'apps/mcp/src/index.mjs')],cwd:REPO,env:environment(url),stderr:'pipe'});
 let stderr='',overflow=false;
 // Official SDK owns stdout framing; our only SDK-side text collector is stderr.
 transport.stderr?.setEncoding('utf8').on('data',part=>{stderr+=part;if(Buffer.byteLength(stderr)>64*1024){overflow=true;void mcp.close();}});
 t.after(async()=>{await bounded(mcp.close(),'Official MCP close',8000);assert.equal(overflow,false);noPrivate(stderr);});
 await bounded(mcp.connect(transport),'Official MCP connect',10000);
 const call=async(op,input)=>{
  const response=await mcp.callTool({name:op==='mioon_schema'?op:op.replaceAll('.','_'),arguments:input},undefined,{timeout:35000});
  const blocks=response.content.filter(block=>block.type==='text');assert.equal(blocks.length,1);
  const body=JSON.parse(blocks[0].text);assert.deepEqual(response.structuredContent,body);assert.equal(Boolean(response.isError),!body.ok);noPrivate(body);return body;
 };
 return {mcp,call};
}

// Valid 16x16 PNG with real CRCs, compressed pixels and hash, made only in memory.
// This is imported through actual HTTP before any successful render is admitted.
function syntheticPng(){
 const chunk=(name,data)=>{
  const body=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;
  for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  const head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([head,body,tail]);
 };
 const head=Buffer.alloc(13);head.writeUInt32BE(16);head.writeUInt32BE(16,4);head[8]=8;head[9]=2;
 const rows=Buffer.alloc(16*49,90);for(let row=0;row<16;row++)rows[row*49]=0;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
async function manifest(root,relative=''){
 const entries=[];for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
  const name=path.join(relative,entry.name);
  if(entry.isDirectory())entries.push({directory:name},...await manifest(root,name));
  else if(!/^workbench\.sqlite(?:-wal|-shm)?$/.test(name)&&name!=='server.lock')entries.push({file:name,sha256:sha(await readFile(path.join(root,name)))});
 }return entries.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function wire(t,{media=false}={}){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-export-settings-wire-'));
 let backend,proxy,db,drop=false,malformedOperation=null,last;
 const submissions=[];
 t.after(async()=>{
  const failures=[];for(const cleanup of [async()=>{if(proxy){proxy.closeAllConnections();await bounded(new Promise(resolve=>proxy.close(resolve)),'Proxy close',5000);}},()=>backend?.close(),()=>db?.close(),()=>rm(root,{recursive:true,force:true})])
   try{await cleanup();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Export settings fixture cleanup');
 });
 const start=()=>startServer({dataDir:root,port:0,token:TOKEN,chatGateway:async function*(){throw Error('No model or provider call is permitted');}});
 backend=await start();
 proxy=http.createServer(async(req,res)=>{try{
  const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)throw Error('Fixture request cap');chunks.push(chunk);}
  const raw=Buffer.concat(chunks).toString('utf8'),body=JSON.parse(raw);submissions.push(body);
  const upstream=await fetch(backend.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+TOKEN,'content-type':'application/json'},body:raw,signal:AbortSignal.timeout(30000)});
  const text=await upstream.text();if(Buffer.byteLength(text)>4*1024*1024)throw Error('Fixture response cap');last={body,text,status:upstream.status};
  if(drop&&body.operation==='timeline.render'){drop=false;res.destroy();return;}
  res.writeHead(upstream.status,{'content-type':'application/json'});
  if(malformedOperation===body.operation){malformedOperation=null;res.end(JSON.stringify({ok:true,data:{malformed:true}}));}else res.end(text);
 }catch{res.destroy();}});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const url=`http://127.0.0.1:${proxy.address().port}`;
 const direct=createClient({env:environment(backend.url)}),client=createClient({env:environment(url)});
 const project=await direct.rpc('project.create',{name:'Synthetic export transport project'});
 const empty=await direct.rpc('project.create',{name:'Synthetic absent timeline project'});
 let timeline=await direct.rpc('timeline.get',{projectId:project.id}),source;
 if(media){
  const bytes=syntheticPng();source=await direct.rpc('asset.import',{projectId:project.id,name:'Synthetic pixels.png',mimeType:'image/png',dataBase64:bytes.toString('base64')});
  assert.equal(source.sha256,sha(bytes));assert.equal(source.sizeBytes,bytes.length);
  timeline=await direct.rpc('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:source.id,trackId:timeline.tracks.find(track=>track.kind==='video').id,startFrame:0,durationFrames:3});
 }
 db=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});
 const rows=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>
  [name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()]));
 const checkpoint=async()=>({rows:rows(),version:db.prepare('PRAGMA data_version').get().data_version,files:await manifest(root)});
 const unchanged=async before=>{assert.deepEqual(rows(),before.rows);assert.equal(db.prepare('PRAGMA data_version').get().data_version,before.version);assert.deepEqual(await manifest(root),before.files);};
 const official=await officialMcp(t,url);
 const raw=async(op,input)=>{
  let response;try{response=await fetch(url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+TOKEN,'content-type':'application/json'},body:JSON.stringify({operation:op,input}),signal:AbortSignal.timeout(30000)});}catch{return {ok:false,error:{code:'LOST_TRANSPORT'}};}
  const body=await response.json();assert.equal(response.ok,body.ok);noPrivate(body);return body;
 };
 return {root,project,empty,source,timeline,db,client,mcp:official.mcp,checkpoint,unchanged,submissions,
  last:()=>last,lose:()=>{drop=true;},malform:(op='timeline.render')=>{malformedOperation=op;},
  restart:async()=>{await backend.close();backend=await start();},
  transports:[{name:'HTTP',call:raw},{name:'CLI',call:(op,input)=>cli(url,[...op.split('.'),'--input',JSON.stringify(input)])},{name:'MCP',call:official.call}],
  async finished(id){const end=Date.now()+30000;while(Date.now()<end){const value=await client.rpc('export.get',{exportId:id});if(['succeeded','failed'].includes(value.status)){assert.equal(value.status,'succeeded',JSON.stringify(value.error));return value;}await pause(25);}assert.fail('Synthetic render did not reach a terminal state');},
 };
}

test('export settings offline CLI and official MCP expose identical strict schemas and truthful effects without Agent authority',{timeout:45000},async t=>{
 const catalog=discoverSchema();assert.deepEqual((await cli(undefined,['schema'])).data,catalog);
 const official=await officialMcp(t),tools=(await official.mcp.listTools()).tools;
 assert.deepEqual((await official.call('mioon_schema',{})).data,catalog);
 for(const op of [operation,'timeline.render','timeline.export.preflight']){
  const definition=catalog.operations.find(item=>item.operation===op),tool=tools.find(item=>item.name===op.replaceAll('.','_'));
  assert.ok(definition&&tool);assert.deepEqual(tool.inputSchema,definition.inputSchema);assert.deepEqual(tool.annotations,effectAnnotations(definition.effects));
  assert.equal(definition.inputSchema.additionalProperties,false);
 }
 const definition=discoverSchema({operation});assert.equal(definition.requiresRequestId,false);
 for(const key of ['readOnly','idempotent','localProcess'])assert.equal(definition.effects[key],true);
 assert.equal(definition.effects.fileWrite,true,'v2 capability can create bounded owned proof staging');
 for(const key of ['databaseWrite','externalIO','paidGeneration','openWorld','destructive'])assert.equal(definition.effects[key],false);
 const render=discoverSchema({operation:'timeline.render'});assert.equal(render.requiresRequestId,true);assert.equal(render.effects.databaseWrite,true);assert.equal(render.effects.fileWrite,true);assert.equal(render.effects.localProcess,true);assert.equal(render.effects.paidGeneration,false);
 assert.ok(!JSON.stringify(READ_TOOL_DEFINITIONS).includes('timeline.export.capabilities'));assert.ok(!JSON.stringify(EDIT_TOOL_DEFINITIONS).includes('timeline.export.capabilities'));
});

test('actual HTTP CLI and MCP capabilities prove CRF and bitrate locally without writes and reject strict injected fields',{timeout:120000},async t=>{
 const w=await wire(t),before=await w.checkpoint(),events=[],off=onMediaProcess(event=>events.push(event));t.after(off);
 for(const [index,transport] of w.transports.entries()){
  const input={projectId:w.project.id,expectedRevision:w.timeline.revision,exportSettings:settings(index===1?{mode:'bitrate',targetKbps:4000}:undefined)};
  const result=await transport.call(operation,input);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.status,'available');assert.equal(isTimelineExportCapabilitiesResponse(result.data,input),true);
  assert.deepEqual(result.data.delivery,resolveTimelineExportDelivery(w.timeline,input.exportSettings));await w.unchanged(before);
 }
 assert.equal(events.filter(event=>event.type==='started').length,6);assert.equal(events.filter(event=>event.type==='exited').length,6);
 const starts=events.length,input={projectId:w.project.id,expectedRevision:w.timeline.revision,exportSettings:settings()};
 for(const transport of w.transports){
  for(const invalid of [{...input,command:'ffmpeg'},{...input,path:'/private/source'},{...input,url:'https://untrusted.invalid'},
   {...input,exportSettings:{...settings(),fps:60}},{...input,exportSettings:{...settings(),rateControl:{mode:'crf',quality:'standard',targetKbps:4000}}},
   {...input,exportSettings:{...settings(),resolution:'4k'}},{...input,exportSettings:{...settings(),rateControl:{mode:'bitrate',targetKbps:4001}}}]){
   for(const [op,request] of [[operation,invalid],['timeline.render',{...invalid,requestId:randomUUID(),purpose:'export'}]]){
    const result=await transport.call(op,request);assert.equal(result.ok,false);assert.equal(result.error.code,'VALIDATION_ERROR');
   }
  }
  const extraId=await transport.call(operation,{...input,requestId:randomUUID()});assert.equal(extraId.ok,false);assert.equal(extraId.error.code,'VALIDATION_ERROR');
  const absent=await transport.call(operation,{...input,projectId:w.empty.id});assert.equal(absent.ok,true);assert.equal(absent.data.status,'blocked');assert.equal(absent.data.timelineId,null);assert.equal(absent.data.issues[0].code,'TIMELINE_MISSING');
  const stale=await transport.call(operation,{...input,expectedRevision:input.expectedRevision+1});assert.equal(stale.ok,true);assert.equal(stale.data.status,'stale');assert.equal(stale.data.issues[0].code,'EXPORT_CAPABILITY_STALE');
  const preview=await transport.call('timeline.render',{...input,requestId:randomUUID(),purpose:'preview'});assert.equal(preview.ok,false);assert.equal(preview.error.code,'VALIDATION_ERROR');
 }
 assert.equal(events.length,starts,'invalid, absent and stale reads never probe');await w.unchanged(before);
 for(const transport of w.transports.filter(item=>item.name!=='HTTP')){
  const count=w.submissions.length;w.malform(operation);const malformed=await transport.call(operation,input);
  assert.equal(malformed.ok,false);assert.equal(malformed.error.code,'BACKEND_PROTOCOL_ERROR');assert.deepEqual(malformed.error.details,{});
  assert.equal(w.submissions.length,count+1,'strict observational ACK failure does not retry');await w.unchanged(before);
 }
});

test('real custom renders recover lost HTTP CLI MCP acknowledgements exactly across duplicate CAS and restart without another probe',{timeout:180000},async t=>{
 const w=await wire(t,{media:true});let timeline=w.timeline;
 for(const [index,transport] of w.transports.entries()){
  const input={projectId:w.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:settings(index===1?{mode:'bitrate',targetKbps:2000}:undefined)};
  const count=w.submissions.length;w.lose();const lost=await transport.call('timeline.render',input);assert.equal(lost.ok,false);
  if(transport.name!=='HTTP')assert.equal(lost.error.details.submissionMayHaveSucceeded,true);
  assert.equal(w.submissions.length,count+1,'one dispatch only, never automatic resubmission');
  const original=JSON.parse(w.last().text);assert.equal(original.ok,true);assert.equal(isTimelineMutationResponse('timeline.render',input,original.data),true);
  const receipt=w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
  assert.deepEqual(publicValue(JSON.parse(receipt)),original.data);
  const completed=await w.finished(original.data.id);assert.deepEqual(completed.snapshot.delivery,original.data.snapshot.delivery);assert.ok(completed.assetId);
  const artifact=(await w.client.rpc('asset.list',{projectId:w.project.id})).find(asset=>asset.id===completed.assetId);assert.equal(artifact.width,360);assert.equal(artifact.height,640);assert.equal(artifact.mimeType,'video/mp4');
  timeline=await w.client.rpc('timeline.clip.update',{projectId:w.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),clipId:timeline.clips[0].id,patch:{name:`After ${transport.name} render`}});
  await w.restart();const before=await w.checkpoint(),events=[],off=onMediaProcess(event=>events.push(event)),previous=process.env.MIOON_FFMPEG_PATH;
  process.env.MIOON_FFMPEG_PATH=path.join(w.root,'missing-owned-ffmpeg');
  try{
   assert.deepEqual(await transport.call('timeline.render',input),original,'historical exact receipt wins over stale CAS and now-unavailable FFmpeg');
   assert.deepEqual(await transport.call('timeline.render',input),original,'duplicate returns original queued ACK, not progressed export');
   const changed=await transport.call('timeline.render',{...input,exportSettings:settings({mode:'crf',quality:'high'})});assert.equal(changed.ok,false);assert.equal(changed.error.code,'IDEMPOTENCY_CONFLICT');
   const stale=await transport.call('timeline.render',{...input,requestId:randomUUID()});assert.equal(stale.ok,false);assert.equal(stale.error.code,'REVISION_CONFLICT');
   assert.deepEqual(events,[],'replay and CAS refusal bypass capability subprocesses');await w.unchanged(before);
  }finally{off();if(previous===undefined)delete process.env.MIOON_FFMPEG_PATH;else process.env.MIOON_FFMPEG_PATH=previous;}
  assert.equal(w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,receipt);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM exports WHERE id=?').get(original.data.id).n,1);
 }
});

test('malformed render success stays unknown and explicit original request recovers one immutable real export',{timeout:90000},async t=>{
 const w=await wire(t,{media:true}),input={projectId:w.project.id,expectedRevision:w.timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:settings()};
 const count=w.submissions.length;w.malform();await assert.rejects(w.client.rpc('timeline.render',input),error=>error.code==='BACKEND_PROTOCOL_ERROR'&&error.details.requestId===input.requestId&&error.details.submissionMayHaveSucceeded===true);
 assert.equal(w.submissions.length,count+1);const original=JSON.parse(w.last().text);assert.equal(original.ok,true);await w.finished(original.data.id);
 const receipt=w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
 await w.restart();const before=await w.checkpoint();assert.deepEqual(await w.client.rpc('timeline.render',input),original.data);await w.unchanged(before);
 assert.equal(w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,receipt);
 assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM exports WHERE id=?').get(original.data.id).n,1);
});
