type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import type {TypedStore as FixtureStore, TypedServices as FixtureServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {callObservedRpc} from '../apps/server/src/rpc-observation.ts';
import {onMediaProcess,hasUnconfirmedMediaProcesses,waitForMediaProcesses} from '../packages/business/src/media-processes.ts';
import type { BinaryLike } from 'crypto';

// Real loopback HTTP, shared services/admission and the production bounded child
// runner. The only synthetic tool is this test's own locally authored executable:
// recognized encoder listing, then a deliberately live first MOV encode. No
// inspector stub, provider, worker, remote service or third-party script is used.
const TOKEN='float-capability-observer-public-test-token';
const SETTINGS={profileId:'mp4_h264_float_checked_v2',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}};
const defer=<T>()=>Promise.withResolvers<T>();
const pause=(ms?: number|undefined)=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded<T>(promise: Promise<T>,label: string,ms: number|undefined=5000){let timer;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} did not settle`)),ms);})]);}finally{clearTimeout(timer);}}
async function eventually(predicate: { (): Promise<boolean>; (): unknown; },label?: string|Error|undefined){const end=performance.now()+5000;while(performance.now()<end){if(await predicate())return;await pause(10);}assert.fail(label);}
const hash=(bytes: NonSharedBuffer|BinaryLike)=>createHash('sha256').update(bytes).digest('hex');
async function stableFiles(root: string,relative: string|undefined=''){
 const out: ({ directory: string; } | { name: string; sha256: string; })[]=[];
 for(const item of await readdir(path.join(root,relative),{withFileTypes:true})){
  const name=path.join(relative,item.name);if(/^workbench\.sqlite(?:-wal|-shm)?$/.test(name)||name==='server.lock')continue;
  if(item.isDirectory())out.push({directory:name},...await stableFiles(root,name));else out.push({name,sha256:hash(await readFile(path.join(root,name)))});
 }
 return out.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function tinyWave(){const bytes=Buffer.alloc(44+4800*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(4800*4,40);return bytes;}

async function fixture(t: test.TestContext){
 const base=await mkdtemp(path.join(tmpdir(),'mioon-float-http-cancel-')),root=path.join(base,'workspace');await mkdir(root,{mode:0o700});
 const originalFfmpeg=process.env.MIOON_FFMPEG_PATH,tool=path.join(base,'controlled-ffmpeg.mjs');
 const listing='Encoders:\n V..... = Video\n A..... = Audio\n ------\n V....D libx264 Synthetic H.264\n A..... aac Synthetic AAC\n A..... pcm_f32le Synthetic float PCM\n';
 await writeFile(tool,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nif(args.includes('-encoders'))process.stdout.write(${JSON.stringify(listing)});\nelse{const file=args.at(-1);if(!file.endsWith('.mov'))process.exit(29);writeFileSync(file,'partial owned MOV');setInterval(()=>{},1000);}\n`,{mode:0o700});
 const restoreTool=()=>{if(originalFfmpeg===undefined)delete process.env.MIOON_FFMPEG_PATH;else process.env.MIOON_FFMPEG_PATH=originalFfmpeg;};
 const store=(openStore(root) as FixtureStore),services=(createServices(store,new Map(),{env:{MIOON_ENABLE_LIVE_PROVIDER:'0'}}) as FixtureServices);
 const project=await services.call('project.create',{name:'Float cancellation synthetic project'});let timeline=await services.call('timeline.get',{projectId:project.id});
 const assetId=randomUUID(),relativePath=`media/${assetId}.wav`,source=tinyWave();await writeFile(path.join(root,relativePath),source,{mode:0o600});
 store.put('assets',{id:assetId,projectId:project.id,name:'Synthetic silence.wav',mimeType:'audio/wav',relativePath,sha256:hash(source),sizeBytes:source.length,width:0,height:0,duration:.1,hasVideo:false,hasAudio:true,audioStreamIndex:0,provenance:'user-import',createdAt:new Date().toISOString()});
 timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:(timeline.tracks.find((track)=>track.kind==='audio'))!.id,assetId,startFrame:0,durationFrames:3});
 const input={projectId:project.id,expectedRevision:timeline.revision,exportSettings:structuredClone(SETTINGS)};
 const media: (import("../packages/business/src/media-processes.ts").MediaProcessEvent)[]=[],requests: unknown[]=[],observations: ({ baseline: { request: number; response: number; }; })[]=[],settled=defer<{signal:AbortSignal;remaining:{request:number;response:number};baseline:{request:number;response:number}}>(),holding=defer<import('../packages/business/src/media-processes.ts').MediaProcessEvent>(),reaped=defer<import('../packages/business/src/media-processes.ts').MediaProcessEvent>();let ffmpegStarts=0,heldPid!: number|undefined,server;
 const off=onMediaProcess(event=>{media.push(((event) as unknown as Parameters<typeof media.push>[0]));if(event.type==='started'&&event.kind==='ffmpeg'&&++ffmpegStarts===2){heldPid=event.pid;holding.resolve(event);}if(event.type==='exited'&&event.pid===heldPid)reaped.resolve(event);});
 const rows=()=>JSON.stringify(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>({name,rows:store.db.prepare(`SELECT * FROM "${(name as string).replaceAll('"','""')}" ORDER BY rowid`).all()})));
 const beforeRows=rows(),beforeFiles=await stableFiles(root);
 const send=(res: http.ServerResponse<http.IncomingMessage>&{ req: http.IncomingMessage; },status: number,body: { ok: boolean; error?: { code: string; }|{ code: unknown; message: unknown; retryable: boolean; }|{ code: unknown; message: unknown; }; data?: unknown; })=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
 server=http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.end('healthy');return;}
  if(req.headers.authorization!==`Bearer ${TOKEN}`){send(res,401,{ok:false,error:{code:'UNAUTHORIZED'}});return;}
  const chunks=[];let bytes=0;
  try{
   for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)throw Error('Test request exceeded fixed input bound');chunks.push(chunk);}
   const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests.push(envelope);
   const observed={baseline:{request:req.listenerCount('aborted'),response:res.listenerCount('close')}};observations.push(observed);
   try{
    const data=await callObservedRpc(req,res,{call(operation,value,options){(observed as typeof observed & {signal:(unknown)}).signal=options?.signal;return services.call(operation,value,options);}},envelope.operation,envelope.input);
    (observed as typeof observed & {result:(unknown)}).result=data;send(res,200,{ok:true,data});
   }catch(error){(observed as typeof observed & {error:(unknown)}).error=error;send(res,(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).status||500,{ok:false,error:{code:(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code||'INTERNAL_ERROR',message:(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).message,retryable:false}});}
   finally{(observed as typeof observed & {remaining:({ request: number; response: number; })}).remaining={request:req.listenerCount('aborted'),response:res.listenerCount('close')};if(requests.length===1)settled.resolve(observed as unknown as Parameters<typeof settled.resolve>[0]);}
  }catch(error){send(res,500,{ok:false,error:{code:(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code||'TEST_FAILURE',message:(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).message}});settled.reject(error);}
 });
 await bounded(new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve as ()=>void);}), 'HTTP listener startup');
 t.after(async()=>{
  try{server.closeAllConnections();await bounded(new Promise(resolve=>server.close(resolve)),'HTTP listener close');await services.drain();await bounded(waitForMediaProcesses(),'Owned media cleanup');}
  finally{restoreTool();off();store.close();await rm(base,{recursive:true,force:true});}
 });
 process.env.MIOON_FFMPEG_PATH=tool;
 return {root,input,media,requests,observations,holding:holding.promise,reaped:reaped.promise,settled:settled.promise,
  url:`http://127.0.0.1:${((server.address() as import('node:net').AddressInfo))!.port}`,
  async finishCancellation(){
   const observed=await bounded(settled.promise,'Disconnected HTTP observer');assert.ok(observed.signal instanceof AbortSignal);assert.equal(observed.signal.aborted,true);assert.deepEqual(observed.remaining,observed.baseline);
   const closed=await bounded(reaped.promise,'Exact held media child reap');assert.equal(closed.pid,heldPid);assert.equal(media.filter(event=>event.type==='exited'&&event.pid===heldPid).length,1);
   await eventually(async()=>!(await readdir(root)).some(name=>name.startsWith('.timeline-float-proof-')),'Private capability staging must be removed after confirmed child close');
   assert.equal(hasUnconfirmedMediaProcesses(),false);assert.equal(requests.length,1,'Disconnect never submits or retries a capability POST');assert.equal(rows(),beforeRows);assert.deepEqual(await stableFiles(root),beforeFiles);
  },
  async newExplicitProbe(){
   restoreTool();assert.equal(await(await fetch(this.url+'/health')).text(),'healthy');
   const response=await fetch(this.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json'},body:JSON.stringify({operation:'timeline.export.capabilities',input})});
   const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.ok,true);assert.equal(body.data.status,'available',JSON.stringify(body));
   assert.equal(requests.length,2,'Only the caller\'s new explicit probe is issued');assert.equal(rows(),beforeRows);assert.deepEqual(await stableFiles(root),beforeFiles);
   assert.equal(store.list('exports').length,0);assert.equal(store.list('assets').filter(asset=>asset.provenance==='export').length,0);
   assert.deepEqual(media.filter(event=>event.type==='started').map(event=>event.pid).sort(),media.filter(event=>event.type==='exited').map(event=>event.pid).sort(),'Every exact owned media child has observed close');
  },
 };
}

test('real HTTP disconnect aborts active v2 capability MOV child, cleans owned staging and permits a fresh explicit proof',{timeout:20000},async t=>{
 if(process.platform==='win32'){t.skip('POSIX installed executable fixture; no native Windows claim');return;}
 const f=await fixture(t),request=http.request(f.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json'}});request.on('error',()=>{});
 request.end(JSON.stringify({operation:'timeline.export.capabilities',input:f.input}));await bounded(f.holding,'Active capability MOV child');
 assert.equal((await readdir(f.root)).filter(name=>name.startsWith('.timeline-float-proof-')).length,1);request.destroy();
 await f.finishCancellation();await f.newExplicitProbe();
});

test('actual CLI Ctrl+C reaches active v2 capability lifecycle without business mutation or retry',{timeout:20000},async t=>{
 if(process.platform==='win32'){t.skip('POSIX signals and installed executable fixture; no native Windows claim');return;}
 const f=await fixture(t),child=spawn(process.execPath,[fileURLToPath(new URL('../apps/cli/src/index.ts',import.meta.url)),'timeline','export','capabilities','--input',JSON.stringify(f.input)],
  {stdio:['ignore','pipe','pipe'],shell:false,env:{PATH:process.env.PATH||'',MIOON_BASE_URL:f.url,MIOON_TOKEN:TOKEN,MIOON_ENABLE_LIVE_PROVIDER:'0'}});
 let stdout='',stderr='',bytes=0;
 // One audited text registration site; UTF-8 decoding survives arbitrary chunk boundaries.
 for(const [stream,append] of ([[child.stdout,(value: string)=>{stdout+=value;}],[child.stderr,(value: string)=>{stderr+=value;}]] as const))stream.setEncoding('utf8').on('data',(value: string|ArrayBufferLike|NodeJS.ArrayBufferView<ArrayBufferLike>)=>{bytes+=Buffer.byteLength(value);if(bytes>65536){child.kill('SIGKILL');return;}append(((value) as unknown as StrictIntersection<Parameters<NonNullable<typeof append>>[0]>));});
 const done=new Promise<{ code: number | null; signal: NodeJS.Signals | null; }>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await bounded(done.catch(()=>{}),'Owned CLI cleanup');});
 await bounded(f.holding,'Actual CLI active capability MOV child');child.kill('SIGINT');
 const outcome=await bounded(done,'Actual CLI Ctrl+C result');assert.equal(outcome.code,130,stderr);assert.equal((outcome.signal as unknown),null);assert.equal(JSON.parse(stdout).error.code,'INTERRUPTED');assert.equal(stdout.trim().split('\n').length,1);
 await f.finishCancellation();await f.newExplicitProbe();
});
