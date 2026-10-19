import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClient,discoverSchema,schemas} from '@mioon/client';
import {effectAnnotations,operationEffect,isTimelineMutationResponse,EXPORT_LOUDNESS_PROFILE,TIMELINE_MIX_LOUDNESS_PROFILE} from '@mioon/contracts';
import {timelineLoudnessCandidateDigest,isTimelineLoudnessApplicableReport} from '@mioon/contracts/timeline-loudness-apply';
import {readTimelineLoudnessApplyEnvelope} from '@mioon/client/timeline-loudness-apply';
import {startServer} from '../apps/server/src/index.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.ts';
import {TIMELINE_EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/timeline-edit-tool-policy.ts';
import {TIMELINE_GAIN_EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/timeline-gain-tool-policy.ts';
import {loudnessApplyFixture} from './fixtures/timeline-loudness-apply.ts';

const repo=fileURLToPath(new URL('..',import.meta.url));
const operation='timeline.loudness.apply',toolName='timeline_loudness_apply';
const token='synthetic-loudness-apply-public-transport-token';
interface WireEnvelope {ok?: boolean; data?: unknown; error?: {code?: string; details?: Record<string, unknown>; [key: string]: unknown}; [key: string]: unknown}
interface ReceiptRow {requestHash: unknown; response: string; [key: string]: unknown}
interface TimelineWire {id: string; revision: number; clips: {id: string; gain: number; [key: string]: unknown}[]; tracks: {id: string; kind: string; [key: string]: unknown}[]; updatedAt?: string; [key: string]: unknown}
interface ReportWire {applyAllowed: boolean; candidate: {applyAllowed: boolean; gains: {clipId: string; afterGain: number}[]}; checks: {audioFullyDecoded: boolean; segmentCount: number}; identity: {snapshotSha256: string}; [key: string]: unknown}
interface MediaEvent {type?: string; kind?: string; pid?: number; [key: string]: unknown}
interface DiscoveryWire {toolName: string; command: string; requiresRequestId: boolean; inputSchema: {required: string[]; properties: Record<string, Record<string, unknown> & {const?: unknown; minimum?: number; maximum?: number; pattern?: string; type?: string; minLength?: number; maxLength?: number}>; additionalProperties: boolean}; effects: {notes: string; [key: string]: unknown}}
interface OfficialClient {client: Client; close(): Promise<void>; call(name: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<WireEnvelope>}
interface Fixture {root: string; backend: Awaited<ReturnType<typeof startServer>>; db: DatabaseSync; mcp: OfficialClient; client: ReturnType<typeof createClient>; requests: {request: http.IncomingMessage; response: http.ServerResponse; baseline: {request: number; response: number}}[]; cleanups: (() => void | Promise<void>)[]; project: {id: string}; source: {id: string}; before: TimelineWire; sourceRecord: {sha256: string; relativePath: string}; prepareInput: Record<string, unknown>; report: ReportWire; input: Record<string, unknown>; http(op: string, input: Record<string, unknown>, options?: {signal?: AbortSignal}): Promise<WireEnvelope>; call(channel: string, input: Record<string, unknown>): Promise<WireEnvelope>; rows(): Record<string, Record<string, unknown>[]>; receipt(requestId: string): ReceiptRow | undefined; timeline(): TimelineWire}
const sha=(bytes: Uint8Array): string=>createHash('sha256').update(bytes).digest('hex');
const pause=(ms: number): Promise<void>=>new Promise<void>(resolve=>{setTimeout(resolve,ms);});
const environment=(url?: string): Record<string, string | undefined>=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',
  ...(url?{MIOON_BASE_URL:url,MIOON_TOKEN:token}:{})});
async function bounded<T>(promise: Promise<T>,label: string,ms=20000): Promise<T> {let timer: ReturnType<typeof setTimeout> | undefined;try{
  return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);
}finally{clearTimeout(timer);}}
function cli(t: import('node:test').TestContext,url: string | undefined,args: string[]): {child: import('node:child_process').ChildProcess; result: Promise<{code: number | null; body: WireEnvelope; text: string}>} {
  const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...args],
    {cwd:repo,env:environment(url),stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',overflow=false,timedOut=false;
  assert.ok(child.stdout && child.stderr);
  child.stdout.setEncoding('utf8').on('data',(part: string)=>{stdout+=part;if(Buffer.byteLength(stdout)>1024*1024){overflow=true;child.kill('SIGKILL');}});
  child.stderr.setEncoding('utf8').on('data',(part: string)=>{stderr+=part;if(Buffer.byteLength(stderr)>65536){overflow=true;child.kill('SIGKILL');}});
  const closed=once(child,'close'),timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},25000);
  t.after(async()=>{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await bounded(closed,'CLI owned child cleanup');});
  const result=(async()=>{
    const [code,signal]=await closed;clearTimeout(timer);assert.equal(timedOut,false);assert.equal(overflow,false);
    assert.equal(signal,null,stderr);assert.equal(stdout.trim().split('\n').length,1,'CLI emits one complete JSON envelope');
    assert.ok(!stdout.includes(token)&&!stderr.includes(token));assert.ok(!stdout.includes('\ufffd')&&!stderr.includes('\ufffd'));
    const body=JSON.parse(stdout) as WireEnvelope;assert.equal(code===0,body.ok,stderr);return {code,body,text:stdout.trim()};
  })();
  // The caller may wait for genuine backend media entry before interrupting.
  return {child,result};
}
async function official(t: import('node:test').TestContext,url?: string): Promise<OfficialClient> {
  const client=new Client({name:'timeline-loudness-apply-public-transports',version:'1.0.0'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],
    cwd:repo,env:environment(url) as Record<string,string>,stderr:'pipe',maxBufferSize:1024*1024});
  let stderr='',overflow=false;const closed=new Promise<void>(resolve=>{client.onclose=()=>resolve();});
  const stderrStream=transport.stderr as unknown as NodeJS.ReadableStream | null;stderrStream?.on('data',(part: string)=>{stderr+=part;if(Buffer.byteLength(stderr)>65536){overflow=true;void close().catch(()=>{});}});
  let closing: Promise<void> | undefined;
  const close=()=>closing??=(async()=>{const owned=transport.pid!==null;await bounded(client.close(),'MCP owned child cleanup');
    if(owned)await bounded(closed,'MCP owned child close confirmation');assert.equal(overflow,false);assert.ok(!stderr.includes(token));})();
  t.after(close);await bounded(client.connect(transport),'official MCP connect');
  return {client,close,async call(name: string,input: Record<string, unknown>,options: Record<string, unknown> = {}): Promise<WireEnvelope> {
    const result=await client.callTool({name,arguments:input} as never,undefined,{timeout:25000,...options} as never) as {content: {type: string; text: string}[]; structuredContent: WireEnvelope; isError?: boolean};
    const blocks=result.content.filter((block: {type: string})=>block.type==='text');assert.equal(blocks.length,1);
    const textBlock=blocks[0];assert.ok(textBlock);assert.ok(Buffer.byteLength(textBlock.text)<=1024*1024);assert.ok(!textBlock.text.includes('\ufffd'));
    const body=JSON.parse(textBlock.text) as WireEnvelope;assert.deepEqual(result.structuredContent,body);
    assert.equal(Boolean(result.isError),!body.ok);assert.ok(!textBlock.text.includes(token));return body;
  }};
}
function wav(): Buffer {
  // Same short real-PCM fixture shape as the full-mix real transport tests.
  const frames=96000,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);
  bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
  for(let frame=0;frame<frames;frame++){
    bytes.writeInt16LE(Math.round(8192*Math.sin(2*Math.PI*997*frame/48000)),44+frame*4);
    bytes.writeInt16LE(Math.round(6144*Math.sin(2*Math.PI*733*frame/48000)),46+frame*4);
  }return bytes;
}
function allRows(db: DatabaseSync): Record<string, Record<string, unknown>[]> {return Object.fromEntries((db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as {name: string}[]).map(({name}: {name: string})=>
  [name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all() as Record<string, unknown>[]]));}
async function fixture(t: import('node:test').TestContext,{saved=true}: {saved?: boolean} = {}): Promise<Fixture> {
  const root=await mkdtemp(path.join(tmpdir(),'mioon-loudness-apply-wire-'));let backend: Awaited<ReturnType<typeof startServer>> | undefined,db: DatabaseSync | undefined,mcp: OfficialClient | undefined,server: http.Server | undefined;
  const cleanups: (() => void | Promise<void>)[] = [];
  t.after(async()=>{for(const cleanup of cleanups)cleanup();try{await mcp?.close();}finally{db?.close();
    try{await backend?.close();}finally{await rm(root,{recursive:true,force:true});}}});
  // Only capture the listener for request counting and lifecycle assertions.
  // Routes, services, storage, FFprobe/FFmpeg and mutation handling stay real.
  const createServer=http.createServer,capture=t.mock.method(http,'createServer',((...args: Parameters<typeof http.createServer>): http.Server=>{const owned=createServer(...args);server=owned;return owned;}) as never);
  try{backend=await startServer({dataDir:root,port:0,token,chatGateway:async function*(){throw Error('No model or provider call permitted');}} as never);}
  finally{capture.mock.restore();}
  const requests: Fixture['requests']=[],observe=(request: http.IncomingMessage,response: http.ServerResponse)=>{if(request.url==='/api/rpc')requests.push({request,response,
    baseline:{request:request.listenerCount('aborted'),response:response.listenerCount('close')}});};
  // Capture the normal authenticated-response lifetime guard before observing
  // media work, so only new per-operation cancellation listeners are compared.
  assert.ok(server);const ownedServer=server;ownedServer.on('request',observe);cleanups.push(()=>{ownedServer.removeListener('request',observe);});
  assert.ok(backend);const client=createClient({env:environment(backend.url)});
  db=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});mcp=await official(t,backend.url);
  assert.ok(db);assert.ok(mcp);
  const f={root,backend,db,mcp,client,requests,cleanups,async http(op: string,input: Record<string, unknown>,{signal}: {signal?: AbortSignal} = {}){
    const response=await fetch(backend.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({operation:op,input}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000)});
    const body=await readTimelineLoudnessApplyEnvelope(response,signal) as WireEnvelope;assert.equal(response.ok,body.ok);
    assert.ok(!JSON.stringify(body).includes(token));return body;
  },async call(channel: string,input: Record<string, unknown>): Promise<WireEnvelope> {
    if(channel==='HTTP')return f.http(operation,input);
    if(channel==='CLI')return (await cli(t,backend?.url,[...operation.split('.'),'--input',JSON.stringify(input)]).result).body;
    return (mcp as OfficialClient).call(toolName,input);
  },rows:()=>allRows(db as DatabaseSync),receipt:(requestId: string)=>db?.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(requestId) as ReceiptRow | undefined,
  timeline:()=>JSON.parse(String((db?.prepare('SELECT data FROM timelines WHERE projectId=?').get(f.project.id) as {data: string} | undefined)?.data)) as TimelineWire} as Fixture;
  if(!saved)return f;
  f.project=await client.rpc('project.create',{name:'固定增益 公共传输 🎬'}) as {id: string};
  let timeline=await client.rpc('timeline.get',{projectId:f.project.id}) as TimelineWire;const bytes=wav();
  f.source=await client.rpc('asset.import',{projectId:f.project.id,name:'双声道 原始素材.wav',mimeType:'audio/wav',dataBase64:bytes.toString('base64')}) as {id: string};
  const audioTrack=timeline.tracks.find((track: {kind: string})=>track.kind==='audio');assert.ok(audioTrack);const trackId=audioTrack.id;
  timeline=await client.rpc('timeline.clip.add',{projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),
    trackId,assetId:f.source.id,name:'已保存片段 🎬',startFrame:0,durationFrames:60,gain:.75,fadeInFrames:0}) as TimelineWire;
  f.before=timeline;f.sourceRecord=JSON.parse(String((db.prepare('SELECT data FROM assets WHERE id=?').get(f.source.id) as {data: string}).data)) as {sha256: string; relativePath: string};
  assert.equal(f.sourceRecord.sha256,sha(bytes));assert.equal(sha(await readFile(path.join(root,f.sourceRecord.relativePath))),sha(bytes));
  f.prepareInput={projectId:f.project.id,expectedRevision:timeline.revision,mixProfile:TIMELINE_MIX_LOUDNESS_PROFILE,
    measurementProfile:EXPORT_LOUDNESS_PROFILE,target:{integratedLufs:-30,truePeakCeilingDbtp:-1}};
  const events: MediaEvent[]=[];const off=onMediaProcess(((event: MediaEvent)=>{events.push(event);}) as never);
  try{const result=await f.http('timeline.loudness.prepare',f.prepareInput);assert.equal(result.ok,true);f.report=result.data as ReportWire;}finally{off();}
  assert.equal(isTimelineLoudnessApplicableReport(f.report),true);assert.equal(f.report.applyAllowed,false);
  assert.equal(f.report.candidate.applyAllowed,false);assert.equal(f.report.checks.audioFullyDecoded,true);
  assertMediaRetired(events,f.report,'prepare');
  f.input={...f.prepareInput,requestId:randomUUID(),snapshotSha256:f.report.identity.snapshotSha256,
    candidateDigest:await timelineLoudnessCandidateDigest(f.report)};
  return f;
}
function assertMediaRetired(events: MediaEvent[],report: ReportWire,label: string): void {
  const started=events.filter((event: MediaEvent)=>event.type==='started'),exited=events.filter((event: MediaEvent)=>event.type==='exited');
  assert.equal(started.filter((event: MediaEvent)=>event.kind==='ffprobe').length,2,label+' genuinely probes both passes');
  assert.equal(started.filter((event: MediaEvent)=>event.kind==='ffmpeg').length,2*report.checks.segmentCount,label+' genuinely decodes both full mixes');
  assert.deepEqual(exited.map((event: MediaEvent)=>[event.pid,event.kind]).sort(),started.map((event: MediaEvent)=>[event.pid,event.kind]).sort(),label+' retires exact owned processes');
}
function assertSingleApplication(f: Fixture,before: Record<string, Record<string, unknown>[]>,ack: TimelineWire): void {
  assert.equal(isTimelineMutationResponse(operation,f.input as never,ack as never),true);
  const current=f.timeline();assert.equal(current.revision,f.before.revision+1);assert.deepEqual(current,ack.timeline);
  const gains=new Map(f.report.candidate.gains.map((item: {clipId: string; afterGain: number})=>[item.clipId,item.afterGain])),expected=structuredClone(f.before);
  for(const clip of expected.clips)if(gains.has(clip.id))clip.gain=gains.get(clip.id) as number;
  expected.revision=current.revision;expected.updatedAt=current.updatedAt;assert.deepEqual(current,expected);
  const after=f.rows();assert.equal(after.timeline_history.length,before.timeline_history.length+1);
  assert.equal(after.timeline_requests.length,before.timeline_requests.length+1);
  assert.equal(after.timeline_history.filter(row=>row.operation===operation).length,1);
  assert.equal(after.timeline_requests.filter(row=>row.requestId===f.input.requestId).length,1);
  assert.deepEqual(after.timeline_requests.slice(0,-1),before.timeline_requests,'old immutable receipts retain exact bytes');
  for(const table of Object.keys(before))if(!['timelines','timeline_history','timeline_history_cursors','timeline_requests'].includes(table))
    assert.deepEqual(after[table],before[table],table+' is outside this mutation');
  const receipt=f.receipt(String(f.input['requestId']));assert.ok(receipt);assert.equal(JSON.stringify(ack),receipt.response);
}
async function waitForReceipt(f: Fixture,requestId: string): Promise<ReceiptRow> {
  const until=Date.now()+25000;
  while(Date.now()<until){const receipt=f.receipt(requestId);if(receipt)return receipt;await pause(25);}
  assert.fail('Accepted mutation did not produce its retained receipt before the bounded deadline');
}

test('actual CLI and official MCP discover strict apply intent and local-mutation annotations offline without adding Agent authority',{timeout:60000},async t=>{
  const definition=discoverSchema({operation}) as unknown as DiscoveryWire,catalog=discoverSchema(),mcp=await official(t);
  assert.deepEqual((await cli(t,undefined,['schema',operation]).result).body,{ok:true,data:definition});
  assert.deepEqual(await mcp.call('mioon_schema',{operation}),{ok:true,data:definition});
  assert.deepEqual((await cli(t,undefined,['schema']).result).body,{ok:true,data:catalog});
  assert.deepEqual(await mcp.call('mioon_schema',{}),{ok:true,data:catalog});
  const tools=(await bounded(mcp.client.listTools(),'MCP tool discovery')).tools,tool=tools.find((item: {name: string})=>item.name===toolName);assert.ok(tool);
  assert.deepEqual(tools.map((item: {name: string})=>item.name).sort(),[...Object.keys(schemas).map((name: string)=>name.replaceAll('.','_')),'mioon_doctor','mioon_capabilities','mioon_schema'].sort());
  assert.deepEqual(Object.keys(tool).sort(),['name','description','inputSchema','annotations'].sort());
  assert.deepEqual(tool.inputSchema,definition.inputSchema);assert.deepEqual(tool.annotations,effectAnnotations(operationEffect(operation)) as never);
  assert.deepEqual(tool.annotations,{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false});
  assert.equal(definition.requiresRequestId,true);assert.equal(definition.command,'timeline loudness apply');
  const required=['projectId','expectedRevision','mixProfile','measurementProfile','target','requestId','snapshotSha256','candidateDigest'];
  assert.deepEqual(definition.inputSchema.required,required);assert.deepEqual(Object.keys(definition.inputSchema.properties),required);
  assert.equal(definition.inputSchema.additionalProperties,false);
  const properties=definition.inputSchema.properties;
  assert.equal(properties['mixProfile']?.const,TIMELINE_MIX_LOUDNESS_PROFILE);assert.equal(properties.measurementProfile.const,EXPORT_LOUDNESS_PROFILE);
  assert.equal(properties['expectedRevision']?.minimum,1);assert.equal(properties['expectedRevision']?.maximum,Number.MAX_SAFE_INTEGER);
  assert.deepEqual(properties['requestId'],{type:'string',minLength:8,maxLength:200});
  assert.equal(properties['snapshotSha256']?.pattern,'^[a-f0-9]{64}$');assert.equal(properties['candidateDigest']?.pattern,'^timeline-loudness-candidate-v1:[a-f0-9]{64}$');
  assert.deepEqual(properties['target'],{type:'object',properties:{integratedLufs:{type:'number',minimum:-60,maximum:-5},
    truePeakCeilingDbtp:{type:'number',minimum:-20,maximum:0}},required:['integratedLufs','truePeakCeilingDbtp'],additionalProperties:false});
  const {notes,...effects}=definition.effects;
  assert.deepEqual(effects,{readOnly:false,idempotent:true,destructive:true,openWorld:false,databaseWrite:true,fileWrite:false,externalIO:false,localProcess:true,paidGeneration:false});
  assert.match(notes,/Socket interruption does not cancel accepted mutation/);assert.match(notes,/No client gains/);
  assert.deepEqual(READ_TOOL_DEFINITIONS.map(item=>item.name),['mioon_project_inspect','mioon_asset_inspect','mioon_shot_inspect','mioon_timeline_inspect']);
  assert.deepEqual(EDIT_TOOL_DEFINITIONS.map(item=>item.name),['mioon_propose_shot_update']);
  assert.deepEqual(TIMELINE_EDIT_TOOL_DEFINITIONS.map(item=>item.name),['mioon_propose_timeline_clip_move']);
  assert.deepEqual(TIMELINE_GAIN_EDIT_TOOL_DEFINITIONS.map(item=>item.name),['mioon_propose_timeline_clip_gain']);
  const {input}=await loudnessApplyFixture();const missing: Record<string, unknown>={...input};delete missing['requestId'];
  for(const invoke of [()=>cli(t,undefined,[...operation.split('.'),'--input',JSON.stringify(missing)]).result.then((result: {body: WireEnvelope})=>result.body),
    ()=>mcp.call(toolName,missing)]){const body=await invoke();assert.equal(body.ok,false);assert.equal(body.error?.code,'VALIDATION_ERROR');}
});

for(const first of ['HTTP','CLI','MCP'])test(`real ${first}-first apply replays the exact ACK across HTTP, CLI and official MCP with one revision/history/receipt`,{timeout:120000},async t=>{
  const f=await fixture(t),before=f.rows(),events: MediaEvent[]=[];const off=onMediaProcess(((event: MediaEvent)=>{events.push(event);}) as never);f.cleanups.push(()=>{off();});
  const channels: string[]=[first,...['HTTP','CLI','MCP'].filter((channel: string)=>channel!==first)];let original: WireEnvelope | undefined;
  for(const channel of channels){
    const requestCount=f.requests.length,start=events.length,result=await f.call(channel,f.input);
    assert.equal(result.ok,true);assert.equal(f.requests.length,requestCount+1,channel+' sends exactly one request');
    if(!original){original=result;assertMediaRetired(events.slice(start),f.report,channel+' apply');assertSingleApplication(f,before,result.data as TimelineWire);}
    else {assert.deepEqual(result,original);assert.equal(events.length,start,channel+' replay is receipt-first without media');}
    const receiptRow=f.receipt(String(f.input['requestId']));assert.ok(receiptRow);assert.equal(JSON.stringify(result.data),receiptRow.response);
  }
  const committed=f.rows(),receiptRow=f.receipt(String(f.input['requestId']));assert.ok(receiptRow);const raw=receiptRow.response,afterApplyMedia=events.length;
  assert.ok(original);assertSingleApplication(f,before,original.data as TimelineWire);
  const conflictPatches: Record<string, unknown>[] = [{target:{...(f.input['target'] as Record<string, unknown>),integratedLufs:-29}},{candidateDigest:'timeline-loudness-candidate-v1:'+ 'f'.repeat(64)},
    {snapshotSha256:'e'.repeat(64)}];
  for(const [index,patch]of conflictPatches.entries()){
    const result=await f.call(channels[index] ?? 'HTTP',{...f.input,...patch});assert.equal(result.ok,false);assert.equal(result.error?.code,'IDEMPOTENCY_CONFLICT');
  }
  assert.equal(events.length,afterApplyMedia,'same-key content conflicts precede media admission');
  assert.deepEqual(f.rows(),committed,'changed same-key content cannot mutate or remeasure');
  const undone=await f.client.rpc('timeline.undo',{projectId:f.project.id,expectedRevision:(original.data as {timeline: TimelineWire}).timeline.revision,requestId:randomUUID()}) as TimelineWire & {revision: number; clips: unknown[]};
  assert.deepEqual(undone.clips,f.before.clips);const undoRows=f.rows();
  const previous=process.env.MIOON_FFMPEG_PATH;
  process.env.MIOON_FFMPEG_PATH=path.join(f.root,'intentionally-unavailable-ffmpeg');
  try{
    const failed=await f.http('timeline.loudness.prepare',{...f.prepareInput,expectedRevision:undone.revision});
    assert.equal(failed.ok,false);assert.equal(failed.error?.code,'TIMELINE_MIX_LOUDNESS_DECODE_FAILED');
    const noMoreMedia=events.length;
    for(const channel of channels){const result=await f.call(channel,f.input);assert.deepEqual(result,original);assert.equal(JSON.stringify(result.data),raw);}
    assert.equal(events.length,noMoreMedia,'retained ACK survives actual decoder failure without another process');assert.deepEqual(f.rows(),undoRows);
    await unlink(path.join(f.root,f.sourceRecord.relativePath));
    for(const channel of channels)assert.deepEqual(await f.call(channel,f.input),original);
    assert.equal(events.length,noMoreMedia,'receipt-first replay does not reopen deleted media');assert.deepEqual(f.rows(),undoRows);
    assert.deepEqual(f.timeline(),undone,'replay after undo must never reapply its old gain');
  }finally{if(previous===undefined)delete process.env.MIOON_FFMPEG_PATH;else process.env.MIOON_FFMPEG_PATH=previous;}
  for(const value of [token,f.root,f.sourceRecord.relativePath])assert.ok(!JSON.stringify(original).includes(value));
});

test('real HTTP rejects client gains, paths and authority; CLI and official MCP reject strict inputs before dispatch',{timeout:90000},async t=>{
  const f=await fixture(t,{saved:false}),{input}=await loudnessApplyFixture(),before=f.rows();
  for(const patch of [{gains:[]},{gainMultiplier:.5},{path:'/private/source.wav'},{filename:'arbitrary.wav'},{applyAllowed:true},
    {target:{...input.target,approved:true}},{candidateDigest:'a'.repeat(64)},{snapshotSha256:'bad'},{requestId:undefined}]){
    const request={...input,...patch},count=f.requests.length;
    const cliResult=await cli(t,f.backend.url,[...operation.split('.'),'--input',JSON.stringify(request)]).result;
    assert.equal(cliResult.code,2);assert.equal(cliResult.body.error?.code,'VALIDATION_ERROR');
    const mcpResult=await f.mcp.call(toolName,request);assert.equal(mcpResult.ok,false);assert.equal(mcpResult.error?.code,'VALIDATION_ERROR');
    assert.equal(f.requests.length,count,'clients reject extra authority before an HTTP dispatch');
    const httpResult=await f.http(operation,request);assert.equal(httpResult.ok,false);assert.equal(httpResult.error?.code,'VALIDATION_ERROR');
    assert.equal(f.requests.length,count+1);assert.deepEqual(f.rows(),before);
  }
  const count=f.requests.length;
  for(const flag of ['--file','--output']){
    const result=await cli(t,f.backend.url,[...operation.split('.'),'--input',JSON.stringify(input),flag,'arbitrary.wav']).result;
    assert.equal(result.code,2);assert.equal(result.body.error?.code,'VALIDATION_ERROR');
  }
  assert.equal(f.requests.length,count);assert.deepEqual(f.rows(),before);
});

for(const channel of ['HTTP','CLI','MCP'])test(`disconnecting actual ${channel} apply stops only its caller; real business work commits once and replays its original key`,{timeout:120000},async t=>{
  const f=await fixture(t),before=f.rows(),events: MediaEvent[]=[];let stop: (() => void) | undefined,interrupted=false,entry: ((value: {baseline: {request: number; response: number}; actual: {request: number; response: number}}) => void) | undefined;
  const entered=new Promise<{baseline: {request: number; response: number}; actual: {request: number; response: number}}>(resolve=>{entry=resolve;});
  const off=onMediaProcess(((event: MediaEvent)=>{
    events.push(event);if(interrupted||event.type!=='started'||event.kind!=='ffmpeg')return;
    interrupted=true;const request=f.requests.at(-1);assert.ok(request);
    // Unlike prepare, mutation transport lifetime never installs a business
    // AbortSignal or per-observation request/response cancellation listeners.
    const enter=entry;assert.ok(enter);enter({baseline:request.baseline,actual:{request:request.request.listenerCount('aborted'),response:request.response.listenerCount('close')}});
    const stopper=stop;assert.ok(stopper);stopper();
  }) as never);f.cleanups.push(()=>{off();});
  let finished;
  if(channel==='CLI'){
    const invocation=cli(t,f.backend.url,[...operation.split('.'),'--input',JSON.stringify(f.input)]);stop=()=>invocation.child.kill('SIGINT');
    finished=invocation.result.then(({code,body}: {code: number | null; body: WireEnvelope})=>{assert.equal(code,130);assert.equal(body.ok,false);assert.equal(body.error?.code,'INTERRUPTED');
      assert.equal(body.error?.details?.['requestId'],f.input.requestId);assert.equal(body.error?.details?.['submissionMayHaveSucceeded'],true);});
  }else{
    const controller=new AbortController();stop=()=>controller.abort();
    const pending=channel==='HTTP'?f.http(operation,f.input,{signal:controller.signal}):f.mcp.call(toolName,f.input,{signal:controller.signal});
    finished=pending.then(()=>assert.fail('Interrupted caller cannot report a received success'),(error: unknown)=>assert.ok(error));
  }
  const observed=await bounded(entered,'actual apply decoder entry');assert.deepEqual(observed.actual,observed.baseline);
  await bounded(finished,'caller interruption');const receipt=await waitForReceipt(f,String(f.input['requestId'])),ack=JSON.parse(receipt.response);
  assertSingleApplication(f,before,ack);assertMediaRetired(events,f.report,'disconnected '+channel+' apply');
  const committed=f.rows(),count=events.length;
  for(const replayChannel of ['HTTP','CLI','MCP']){
    const response=await f.call(replayChannel,f.input);assert.deepEqual(response,{ok:true,data:ack});assert.equal(JSON.stringify(response.data),receipt.response);
  }
  assert.equal(events.length,count,'recovery is exact receipt replay without another media attempt');assert.deepEqual(f.rows(),committed);
  const health=await fetch(f.backend.url+'/health',{signal:AbortSignal.timeout(5000)});assert.equal(health.status,200);
});
