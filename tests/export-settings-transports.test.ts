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
import {startServer} from '../apps/server/src/index.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.ts';

import type {TestContext} from 'node:test';

const REPO=fileURLToPath(new URL('..',import.meta.url));
const TOKEN='synthetic-export-settings-wire-token';
const operation='timeline.export.capabilities';
interface ExportRateControl {mode: string; quality?: string; targetKbps?: number}
const settings=(rateControl: ExportRateControl={mode:'crf',quality:'standard'}): {profileId: string; resolution: string; rateControl: ExportRateControl}=>({profileId:'mp4_h264_v1',resolution:'short_360',rateControl});
const environment=(url?: string): NodeJS.ProcessEnv => ({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',...(url?{MIOON_BASE_URL:url,MIOON_TOKEN:TOKEN}:{})});
const sha=(value: Buffer|string): string=>createHash('sha256').update(value).digest('hex');
const pause=(ms: number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const noPrivate=(value: unknown): void=>{const text=typeof value==='string'?value:JSON.stringify(value);assert.ok(!text.includes(TOKEN));assert.ok(!text.includes('Bearer '));};
async function bounded<T>(promise: Promise<T>,label: string,ms=35000): Promise<T>{let timer: ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} timed out`)),ms);})]);}finally{if(timer)clearTimeout(timer);}}

async function cli(url: string|undefined,args: string[]): Promise<Record<string,unknown> & {ok?: boolean}> {
 const child=spawn(process.execPath,[path.join(REPO,'apps/cli/src/index.ts'),...args],{cwd:REPO,env:environment(url),stdio:['ignore','pipe','pipe']});
 let out='',err='',overflow=false;
 child.stdout.setEncoding('utf8').on('data',part=>{out+=part;if(Buffer.byteLength(out)>1024*1024){overflow=true;child.kill('SIGKILL');}});
 child.stderr.setEncoding('utf8').on('data',part=>{err+=part;if(Buffer.byteLength(err)>64*1024){overflow=true;child.kill('SIGKILL');}});
 const closed=once(child,'close'),timer=setTimeout(()=>child.kill('SIGKILL'),35000);
 let code: number|null, signal: NodeJS.Signals|null;try{[code,signal]=await bounded(closed,'CLI close',38000);}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await bounded(closed,'CLI forced close',3000);}}
 assert.equal(overflow,false,'bounded CLI output');assert.equal(signal,null,err);noPrivate(out);noPrivate(err);
 assert.equal(out.trim().split('\n').length,1,'exactly one JSON acknowledgement');
 const parsed: unknown=JSON.parse(out);assert.ok(typeof parsed==='object'&&parsed!==null);const body=parsed as Record<string,unknown>;assert.equal(code===0,body.ok,out+err);return body;
}
async function officialMcp(t: Pick<TestContext,'after'>,url: string): Promise<{mcp: Client; call: (op: string, input: Record<string, unknown>)=>Promise<Record<string,unknown>>}> {
 const mcp=new Client({name:'export-settings-wire-acceptance',version:'1.0.0'},{capabilities:{}});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(REPO,'apps/mcp/src/index.ts')],cwd:REPO,env:environment(url) as Record<string,string>,stderr:'pipe'});
 let stderr='',overflow=false;
 // Official SDK owns stdout framing; our only SDK-side text collector is stderr.
 (transport.stderr as unknown as NodeJS.ReadableStream|undefined)?.setEncoding('utf8').on('data',(part: string)=>{stderr+=part;if(Buffer.byteLength(stderr)>64*1024){overflow=true;void mcp.close();}});
 t.after(async()=>{await bounded(mcp.close(),'Official MCP close',8000) as unknown;assert.equal(overflow,false);noPrivate(stderr);});
 await bounded(mcp.connect(transport),'Official MCP connect',10000);
 const call=async(op: string,input: Record<string, unknown>): Promise<Record<string,unknown>> =>{
  const response=await mcp.callTool({name:op==='mioon_schema'?op:op.replaceAll('.','_'),arguments:input},undefined,{timeout:35000});
  const content=(response as {content: unknown}).content as Array<{type: string}>;const blocks=content.filter(block=>block.type==='text');assert.equal(blocks.length,1);
  const text=(blocks[0] as unknown as {text: string}).text;const body=JSON.parse(text) as Record<string,unknown>;assert.deepEqual(response.structuredContent,body);assert.equal(Boolean(response.isError),!body.ok);noPrivate(body);return body;
 };
 return {mcp,call};
}

// Valid 16x16 PNG with real CRCs, compressed pixels and hash, made only in memory.
// This is imported through actual HTTP before any successful render is admitted.
function syntheticPng(){
 const chunk=(name: string,data: Buffer): Buffer=>{
  const body=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;
  for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  const head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([head,body,tail]);
 };
 const head=Buffer.alloc(13);head.writeUInt32BE(16);head.writeUInt32BE(16,4);head[8]=8;head[9]=2;
 const rows=Buffer.alloc(16*49,90);for(let row=0;row<16;row++)rows[row*49]=0;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
async function manifest(root: string,relative=''): Promise<Array<Record<string,unknown>>>{
 const entries: Array<Record<string,unknown>>=[];for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
  const name=path.join(relative,entry.name);
  if(entry.isDirectory())entries.push({directory:name},...await manifest(root,name));
  else if(!/^workbench\.sqlite(?:-wal|-shm)?$/.test(name)&&name!=='server.lock')entries.push({file:name,sha256:sha(await readFile(path.join(root,name)))});
 }return entries.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
interface WireProject {id: string}
interface WireTimeline {id: string; revision: number; width: number; height: number; tracks: Array<{id: string; kind: string}>; clips: Array<{id: string}>}
interface WireSource {id: string; sha256: string; sizeBytes: number}
interface WireCheckpoint {rows: Record<string, unknown>; version: unknown; files: Array<Record<string, unknown>>}
interface WireData {status?: string; delivery?: unknown; timelineId?: unknown; issues?: Array<{code: string}>; snapshot?: {delivery?: unknown}; id?: string; [key: string]: unknown}
interface WireResult {ok: boolean; data: WireData; error?: {code?: string; details?: Record<string, unknown>} }
interface WireTransport {name: string; call: (op: string, input: Record<string, unknown>)=>Promise<WireResult>}
interface WireLast {body: Record<string, unknown>; text: string; status: number}
interface EffectMap {[key: string]: boolean|undefined}
interface SchemaOperation {operation: string; inputSchema: Record<string, unknown>; effects: EffectMap; requiresRequestId: boolean}
interface SchemaCatalog {operations: SchemaOperation[]}
const schemaCatalog=(value: unknown): SchemaCatalog => value as SchemaCatalog;
const schemaOperation=(value: unknown): SchemaOperation => value as SchemaOperation;
const requestId=(input: Record<string, unknown>): string => input.requestId as string;
interface WireFixture {
  root: string; project: WireProject; empty: WireProject; source?: WireSource; timeline: WireTimeline;
  db: DatabaseSync; client: {rpc: <T = unknown>(op: string, input?: Record<string, unknown>)=>Promise<T>}; mcp: Client;
  checkpoint: ()=>Promise<WireCheckpoint>; unchanged: (before: WireCheckpoint)=>Promise<void>;
  submissions: Array<Record<string, unknown>>; last: ()=>WireLast|undefined;
  lose: ()=>void; malform: (op?: string)=>void; restart: ()=>Promise<void>;
  transports: WireTransport[]; finished: (id: string)=>Promise<{snapshot: {delivery?: unknown}; assetId?: string}>;
}
const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const wireResult = (value: unknown): WireResult => value as WireResult;
async function wire(t: Pick<TestContext,'after'>,{media=false}: {media?: boolean} = {}): Promise<WireFixture> {
 const root=await mkdtemp(path.join(tmpdir(),'mioon-export-settings-wire-'));
 let backend: Awaited<ReturnType<typeof startServer>>|undefined,proxy: http.Server|undefined,db: DatabaseSync|undefined,drop=false,malformedOperation: string|null=null,last: WireLast|undefined;
 const submissions: Array<Record<string, unknown>>=[];
 t.after(async()=>{
  const failures: unknown[]=[];for(const cleanup of [async()=>{if(proxy){proxy.closeAllConnections();await bounded(new Promise<void>(resolve=>proxy!.close(()=>resolve())),'Proxy close',5000);}},()=>backend?.close(),()=>db?.close(),()=>rm(root,{recursive:true,force:true})])
   try{await cleanup();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Export settings fixture cleanup');
 });
 const start=()=>startServer({dataDir:root,port:0,token:TOKEN,chatGateway:async function*(){throw Error('No model or provider call is permitted');}});
 backend=await start();
 proxy=http.createServer(async(req: http.IncomingMessage,res: http.ServerResponse)=>{try{
  const chunks: Buffer[]=[];let bytes=0;for await(const chunk of req as AsyncIterable<Buffer>){bytes+=chunk.length;if(bytes>32768)throw Error('Fixture request cap');chunks.push(chunk);}
  const raw=Buffer.concat(chunks).toString('utf8'),body=record(JSON.parse(raw));submissions.push(body);
  const upstream=await fetch(backend!.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+TOKEN,'content-type':'application/json'},body:raw,signal:AbortSignal.timeout(30000)});
  const text=await upstream.text();if(Buffer.byteLength(text)>4*1024*1024)throw Error('Fixture response cap');last={body,text,status:upstream.status};
  if(drop&&body.operation==='timeline.render'){drop=false;res.destroy();return;}
  res.writeHead(upstream.status,{'content-type':'application/json'});
  if(malformedOperation===body.operation){malformedOperation=null;res.end(JSON.stringify({ok:true,data:{malformed:true}}));}else res.end(text);
 }catch{res.destroy();}});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const address=proxy.address() as {port:number};const url=`http://127.0.0.1:${address.port}`;
 const direct=createClient({env:environment(backend.url)}) as unknown as WireFixture['client'],client=createClient({env:environment(url)}) as unknown as WireFixture['client'];
 const project=await direct.rpc<WireProject>('project.create',{name:'Synthetic export transport project'});
 const empty=await direct.rpc<WireProject>('project.create',{name:'Synthetic absent timeline project'});
 let timeline=await direct.rpc<WireTimeline>('timeline.get',{projectId:project.id}),source: WireSource|undefined;
 if(media){
  const bytes=syntheticPng();source=await direct.rpc<WireSource>('asset.import',{projectId:project.id,name:'Synthetic pixels.png',mimeType:'image/png',dataBase64:bytes.toString('base64')});
  assert.equal(source.sha256,sha(bytes));assert.equal(source.sizeBytes,bytes.length);
  timeline=await direct.rpc<WireTimeline>('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:source.id,trackId:timeline.tracks.find(track=>track.kind==='video')!.id,startFrame:0,durationFrames:3});
 }
 const database=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});db=database;
 const rows=(): Record<string, unknown>=>Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(value=>{
  const name=record(value).name as string;return [name,database.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()];}));
 const checkpoint=async(): Promise<WireCheckpoint>=>({rows:rows(),version:record(database.prepare('PRAGMA data_version').get()).data_version,files:await manifest(root)});
 const unchanged=async(before: WireCheckpoint): Promise<void>=>{assert.deepEqual(rows(),before.rows);assert.equal(record(database.prepare('PRAGMA data_version').get()).data_version,before.version);assert.deepEqual(await manifest(root),before.files);};
 const official=await officialMcp(t,url);
 const raw=async(op: string,input: Record<string, unknown>): Promise<WireResult>=>{
  let response: Response;try{response=await fetch(url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+TOKEN,'content-type':'application/json'},body:JSON.stringify({operation:op,input}),signal:AbortSignal.timeout(30000)});}catch{return {ok:false,data:{},error:{code:'LOST_TRANSPORT'}};}
  const body=record(await response.json());assert.equal(response.ok,body.ok);noPrivate(body);return wireResult(body);
 };
 return {root,project,empty,source,timeline,db:database,client,mcp:official.mcp,checkpoint,unchanged,submissions,
  last:()=>last,lose:()=>{drop=true;},malform:(op='timeline.render')=>{malformedOperation=op;},
  restart:async()=>{await backend!.close();backend=await start();},
  transports:[{name:'HTTP',call:raw},{name:'CLI',call:(op: string,input: Record<string, unknown>)=>cli(url,[...op.split('.'),'--input',JSON.stringify(input)]) as unknown as Promise<WireResult>},{name:'MCP',call:official.call as unknown as WireTransport['call']}],
  async finished(id: string){const end=Date.now()+30000;while(Date.now()<end){const value=await client.rpc<{status: string; error?: unknown; assetId?: string; snapshot: {delivery?: unknown}}>('export.get',{exportId:id});if(['succeeded','failed'].includes(value.status)){assert.equal(value.status,'succeeded',JSON.stringify(value.error));return value;}await pause(25);}assert.fail('Synthetic render did not reach a terminal state');},
 };
}
test('export settings offline CLI and official MCP expose identical strict schemas and truthful effects without Agent authority',{timeout:45000},async t=>{
 const catalog=schemaCatalog(discoverSchema());assert.deepEqual((await cli(undefined,['schema'])).data,catalog);
 const official=await officialMcp(t,'http://127.0.0.1:1'),tools=(await official.mcp.listTools({})).tools;
 assert.deepEqual((await official.call('mioon_schema',{})).data,catalog);
 for(const op of [operation,'timeline.render','timeline.export.preflight']){
  const definition=catalog.operations.find(item=>item.operation===op),tool=tools.find(item=>item.name===op.replaceAll('.','_'));
  assert.ok(definition&&tool);assert.deepEqual(tool.inputSchema,definition.inputSchema);assert.deepEqual(tool.annotations,effectAnnotations(definition.effects as never));
  assert.equal(definition.inputSchema.additionalProperties,false);
 }
 const definition=schemaOperation(discoverSchema({operation}));assert.equal(definition.requiresRequestId,false);
 for(const key of ['readOnly','idempotent','localProcess'])assert.equal(definition.effects[key],true);
 assert.equal(definition.effects.fileWrite,true,'v2 capability can create bounded owned proof staging');
 for(const key of ['databaseWrite','externalIO','paidGeneration','openWorld','destructive'])assert.equal(definition.effects[key],false);
 const render=schemaOperation(discoverSchema({operation:'timeline.render'}));assert.equal(render.requiresRequestId,true);assert.equal(render.effects.databaseWrite,true);assert.equal(render.effects.fileWrite,true);assert.equal(render.effects.localProcess,true);assert.equal(render.effects.paidGeneration,false);
 assert.ok(!JSON.stringify(READ_TOOL_DEFINITIONS).includes('timeline.export.capabilities'));assert.ok(!JSON.stringify(EDIT_TOOL_DEFINITIONS).includes('timeline.export.capabilities'));
});

test('actual HTTP CLI and MCP capabilities prove CRF and bitrate locally without writes and reject strict injected fields',{timeout:120000},async t=>{
 const w=await wire(t),before=await w.checkpoint(),events: Array<{type: string}>=[],off=onMediaProcess(event=>events.push(event));t.after(off);
 for(const [index,transport] of w.transports.entries()){
  const input: Record<string, unknown>={projectId:w.project.id,expectedRevision:w.timeline.revision,exportSettings:settings((index===1?{mode:'bitrate',targetKbps:4000}:undefined) as ExportRateControl|undefined)};
  const result=await transport.call(operation,input);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.status,'available');assert.equal(isTimelineExportCapabilitiesResponse(result.data,input),true);
  assert.deepEqual(result.data.delivery,resolveTimelineExportDelivery(w.timeline,input.exportSettings));await w.unchanged(before);
 }
 assert.equal(events.filter(event=>event.type==='started').length,6);assert.equal(events.filter(event=>event.type==='exited').length,6);
 const starts=events.length,input: Record<string, unknown>={projectId:w.project.id,expectedRevision:w.timeline.revision,exportSettings:settings()};
 for(const transport of w.transports){
  for(const invalid of [{...input,command:'ffmpeg'},{...input,path:'/private/source'},{...input,url:'https://untrusted.invalid'},
   {...input,exportSettings:{...settings(),fps:60}},{...input,exportSettings:{...settings(),rateControl:{mode:'crf',quality:'standard',targetKbps:4000}}},
   {...input,exportSettings:{...settings(),resolution:'4k'}},{...input,exportSettings:{...settings(),rateControl:{mode:'bitrate',targetKbps:4001}}}]){
   for(const [op,request] of [[operation,invalid],['timeline.render',{...invalid,requestId:randomUUID(),purpose:'export'}]] as Array<[string, Record<string, unknown>]>){
    const result=await transport.call(op,request);assert.equal(result.ok,false);assert.equal(result.error?.code,'VALIDATION_ERROR');
   }
  }
  const extraId=await transport.call(operation,{...input,requestId:randomUUID()});assert.equal(extraId.ok,false);assert.equal(extraId.error?.code,'VALIDATION_ERROR');
  const absent=await transport.call(operation,{...input,projectId:w.empty.id});assert.equal(absent.ok,true);assert.equal(absent.data.status,'blocked');assert.equal(absent.data.timelineId,null);assert.equal(absent.data.issues?.[0]?.code,'TIMELINE_MISSING');
  const stale=await transport.call(operation,{...input,expectedRevision:(input.expectedRevision as number)+1});assert.equal(stale.ok,true);assert.equal(stale.data.status,'stale');assert.equal(stale.data.issues?.[0]?.code,'EXPORT_CAPABILITY_STALE');
  const preview=await transport.call('timeline.render',{...input,requestId:randomUUID(),purpose:'preview'});assert.equal(preview.ok,false);assert.equal(preview.error?.code,'VALIDATION_ERROR');
 }
 assert.equal(events.length,starts,'invalid, absent and stale reads never probe');await w.unchanged(before);
 for(const transport of w.transports.filter(item=>item.name!=='HTTP')){
  const count=w.submissions.length;w.malform(operation);const malformed=await transport.call(operation,input);
  assert.equal(malformed.ok,false);assert.equal(malformed.error?.code,'BACKEND_PROTOCOL_ERROR');assert.deepEqual(malformed.error?.details,{});
  assert.equal(w.submissions.length,count+1,'strict observational ACK failure does not retry');await w.unchanged(before);
 }
});

test('real custom renders recover lost HTTP CLI MCP acknowledgements exactly across duplicate CAS and restart without another probe',{timeout:180000},async t=>{
 const w=await wire(t,{media:true});let timeline=w.timeline;
 for(const [index,transport] of w.transports.entries()){
  const input={projectId:w.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:settings(index===1?{mode:'bitrate',targetKbps:2000}:undefined)};
  const count=w.submissions.length;w.lose();const lost=await transport.call('timeline.render',input);assert.equal(lost.ok,false);
  if(transport.name!=='HTTP')assert.equal(lost.error?.details?.submissionMayHaveSucceeded,true);
  assert.equal(w.submissions.length,count+1,'one dispatch only, never automatic resubmission');
  const last=w.last();if(!last)throw Error('missing last transport response');
  const original=wireResult(JSON.parse(last.text));assert.equal(original.ok,true);assert.equal(isTimelineMutationResponse('timeline.render',input,original.data),true);
  const receipt=w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(requestId(input))?.response as string;
  assert.deepEqual(publicValue(JSON.parse(receipt)),original.data);
  const completed=await w.finished(String(original.data.id));assert.deepEqual(completed.snapshot.delivery,original.data.snapshot?.delivery);assert.ok(completed.assetId);
  const artifact=(await w.client.rpc<Array<{id: string; width: number; height: number; mimeType: string}>>('asset.list',{projectId:w.project.id})).find(asset=>asset.id===completed.assetId);assert.equal(artifact?.width,360);assert.equal(artifact?.height,640);assert.equal(artifact?.mimeType,'video/mp4');
  timeline=await w.client.rpc<WireTimeline>('timeline.clip.update',{projectId:w.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),clipId:timeline.clips[0]!.id,patch:{name:`After ${transport.name} render`}});
  await w.restart();const before=await w.checkpoint(),events: Array<{type: string}>=[],off=onMediaProcess(event=>events.push(event)),previous=process.env.MIOON_FFMPEG_PATH;
  process.env.MIOON_FFMPEG_PATH=path.join(w.root,'missing-owned-ffmpeg');
  try{
   assert.deepEqual(await transport.call('timeline.render',input),original,'historical exact receipt wins over stale CAS and now-unavailable FFmpeg');
   assert.deepEqual(await transport.call('timeline.render',input),original,'duplicate returns original queued ACK, not progressed export');
   const changed=await transport.call('timeline.render',{...input,exportSettings:settings({mode:'crf',quality:'high'})});assert.equal(changed.ok,false);assert.equal(changed.error?.code,'IDEMPOTENCY_CONFLICT');
   const stale=await transport.call('timeline.render',{...input,requestId:randomUUID()});assert.equal(stale.ok,false);assert.equal(stale.error?.code,'REVISION_CONFLICT');
   assert.deepEqual(events,[],'replay and CAS refusal bypass capability subprocesses');await w.unchanged(before);
  }finally{off();if(previous===undefined)delete process.env.MIOON_FFMPEG_PATH;else process.env.MIOON_FFMPEG_PATH=previous;}
  assert.equal(w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(requestId(input))?.['response'],receipt);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM exports WHERE id=?').get(String(original.data.id))?.['n'],1);
 }
});

test('malformed render success stays unknown and explicit original request recovers one immutable real export',{timeout:90000},async t=>{
 const w=await wire(t,{media:true}),input={projectId:w.project.id,expectedRevision:w.timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:settings()};
 const count=w.submissions.length;w.malform();await assert.rejects(w.client.rpc('timeline.render',input),(error: unknown)=>{const failure=error as {code?:string; details?:{requestId?:unknown; submissionMayHaveSucceeded?:boolean}};return failure.code==='BACKEND_PROTOCOL_ERROR'&&failure.details?.requestId===input.requestId&&failure.details?.submissionMayHaveSucceeded===true;});
 assert.equal(w.submissions.length,count+1);const last=w.last();if(!last)throw Error('missing last transport response');const original=wireResult(JSON.parse(last.text));assert.equal(original.ok,true);await w.finished(String(original.data.id));
 const receipt=w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(requestId(input))?.response as string;
 await w.restart();const before=await w.checkpoint();assert.deepEqual(await w.client.rpc('timeline.render',input),original.data);await w.unchanged(before);
 assert.equal(w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(requestId(input))?.['response'],receipt);
 assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM exports WHERE id=?').get(String(original.data.id))?.['n'],1);
});
