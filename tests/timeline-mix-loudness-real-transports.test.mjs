import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClient,discoverSchema} from '@mioon/client';
import {readTimelineMixLoudnessEnvelope} from '@mioon/client/timeline-mix-loudness';
import {isTimelineMixLoudnessResponse,TIMELINE_MIX_LOUDNESS_PROFILE} from '@mioon/contracts/timeline-mix-loudness';
import {EXPORT_LOUDNESS_PROFILE} from '@mioon/contracts/export-loudness';
import {startServer} from '../apps/server/src/index.mjs';
import {mediaEnvironment} from '../packages/business/src/media-environment.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';

const execute=promisify(execFile),repo=fileURLToPath(new URL('..',import.meta.url));
const operation='timeline.loudness.prepare',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const environment=(url,token)=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',RUNWAY_MAX_GENERATIONS:'0',
  MIOON_BASE_URL:url,MIOON_TOKEN:token});
async function bounded(promise,label,ms=20000){let timer;try{
  return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);
}finally{clearTimeout(timer);}}
function wav(){
  const frames=96000,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);
  bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
  for(let frame=0;frame<frames;frame++){
    bytes.writeInt16LE(Math.round(8192*Math.sin(2*Math.PI*997*frame/48000)),44+frame*4);
    bytes.writeInt16LE(Math.round(6144*Math.sin(2*Math.PI*733*frame/48000)),46+frame*4);
  }
  return bytes;
}
async function manifest(root,relative=''){
  const result=[];
  for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
    const name=path.join(relative,entry.name);
    if(entry.isDirectory())result.push({directory:name},...await manifest(root,name));
    else if(!/^workbench\.sqlite(?:-wal|-shm|-journal)?$/.test(name)&&name!=='server.lock')
      result.push({file:name,sha256:sha(await readFile(path.join(root,name)))});
  }
  return result.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function cli(url,token,args){
  // execFile continuously decodes UTF-8, bounds both outputs and reaps its child.
  const {stdout,stderr}=await execute(process.execPath,[path.join(repo,'apps/cli/src/index.mjs'),...args],
    {cwd:repo,env:environment(url,token),encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
  assert.ok(!stdout.includes(token)&&!stderr.includes(token),'CLI must not expose its local token');
  assert.equal(stdout.trim().split('\n').length,1);assert.ok(!stdout.includes('\ufffd'));
  const body=JSON.parse(stdout);assert.equal(body.ok,true,'CLI operation must succeed');return body.data;
}
async function official(url,token){
  const client=new Client({name:'timeline-mix-loudness-real-service',version:'1.0.0'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.mjs')],
    cwd:repo,env:environment(url,token),stderr:'pipe'});
  let stderr='',overflow=false;
  transport.stderr?.setEncoding('utf8').on('data',part=>{stderr+=part;if(Buffer.byteLength(stderr)>65536){overflow=true;void client.close();}});
  await bounded(client.connect(transport),'MCP connect');
  return {async call(name,args){
    const result=await client.callTool({name,arguments:args},undefined,{timeout:20000});
    const blocks=result.content.filter(block=>block.type==='text');assert.equal(blocks.length,1);
    const body=JSON.parse(blocks[0].text);assert.deepEqual(result.structuredContent,body);
    assert.equal(Boolean(result.isError),false);assert.equal(body.ok,true,'MCP operation must succeed');
    assert.ok(!JSON.stringify(body).includes(token));assert.ok(!blocks[0].text.includes('\ufffd'));return body.data;
  },async close(){await bounded(client.close(),'MCP close');assert.equal(overflow,false);assert.ok(!stderr.includes(token));}};
}

test('real saved full mix matches across HTTP, CLI and official MCP without rows/files/receipt changes or retained observation listeners',{timeout:120000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'mioon-mix-loudness-real-wire-'));let backend,db,mcp,server,off;
  t.after(async()=>{off?.();await mcp?.close();db?.close();await backend?.close();await rm(root,{recursive:true,force:true});});
  // Capture only the actual server handle for listener inspection. The genuine
  // route, shared business service, decoder and response are never substituted.
  const createServer=http.createServer;
  const capture=t.mock.method(http,'createServer',(...args)=>{server=createServer(...args);return server;});
  try{backend=await startServer({dataDir:root,port:0,chatGateway:async function*(){throw Error('No model/provider call permitted');}});}
  finally{capture.mock.restore();}
  assert.equal(new URL(backend.url).hostname,'127.0.0.1');
  const client=createClient({env:environment(backend.url,backend.token)});
  const project=await client.rpc('project.create',{name:'整片响度 三通道只读验证'});
  let timeline=await client.rpc('timeline.get',{projectId:project.id});
  const bytes=wav(),source=await client.rpc('asset.import',{projectId:project.id,name:'双声道 原始素材.wav',mimeType:'audio/wav',dataBase64:bytes.toString('base64')});
  const trackId=timeline.tracks.find(track=>track.kind==='audio').id;
  for(const clip of [{name:'前段 淡入淡出',startFrame:3,durationFrames:18,sourceInFrame:3,gain:.75,fadeInFrames:4,fadeOutFrames:4},
    {name:'后段 保留相对增益',startFrame:27,durationFrames:30,sourceInFrame:15,gain:.5,fadeInFrames:0,fadeOutFrames:6}])
    timeline=await client.rpc('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId,assetId:source.id,...clip});
  const input={projectId:project.id,expectedRevision:timeline.revision,mixProfile:TIMELINE_MIX_LOUDNESS_PROFILE,
    measurementProfile:EXPORT_LOUDNESS_PROFILE,target:{integratedLufs:-30,truePeakCeilingDbtp:-1}};
  mcp=await official(backend.url,backend.token);
  const definition=discoverSchema({operation});
  assert.deepEqual(await cli(backend.url,backend.token,['schema',operation]),definition);
  assert.deepEqual(await mcp.call('mioon_schema',{operation}),definition);
  assert.ok(definition.description.includes('完整测量编码前浮点混音'));
  db=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});
  const savedSource=JSON.parse(db.prepare('SELECT data FROM assets WHERE id=?').get(source.id).data);
  assert.equal(savedSource.sha256,sha(bytes));assert.equal(savedSource.sizeBytes,bytes.length);
  assert.equal(sha(await readFile(path.join(root,savedSource.relativePath))),sha(bytes));
  const rows=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>
    [name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()]));
  const before={rows:rows(),version:db.prepare('PRAGMA data_version').get().data_version,files:await manifest(root)};
  const listeners=[];
  const observe=(req,res)=>{
    if(req.url!=='/api/rpc')return;
    const baseline={request:req.listenerCount('aborted'),response:res.listenerCount('close')};
    res.once('finish',()=>listeners.push({baseline,remaining:{request:req.listenerCount('aborted'),response:res.listenerCount('close')}}));
  };
  server.prependListener('request',observe);t.after(()=>server.removeListener('request',observe));
  const events=[];off=onMediaProcess(event=>events.push(event));
  const direct=async()=>{
    const response=await fetch(backend.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+backend.token,'content-type':'application/json'},
      body:JSON.stringify({operation,input}),signal:AbortSignal.timeout(20000)});
    assert.equal(response.status,200);const body=await readTimelineMixLoudnessEnvelope(response);assert.equal(body.ok,true);return body.data;
  };
  const reports=[],counts=[];
  for(const [name,call] of [['HTTP',direct],['CLI',()=>cli(backend.url,backend.token,[...operation.split('.'),'--input',JSON.stringify(input)])],
    ['MCP',()=>mcp.call('timeline_loudness_prepare',input)]]){
    const start=events.length,report=await call();reports.push(report);
    assert.equal(isTimelineMixLoudnessResponse(report,input),true,name+' report must satisfy the exact shared contract');
    assert.equal(report.stage,'preencode_float_mix');assert.equal(report.applyAllowed,false);
    assert.equal(report.identity.timelineId,timeline.id);assert.equal(report.identity.timelineRevision,timeline.revision);
    assert.deepEqual(report.identity.range,{startFrame:0,endFrame:57,sampleFrames:57*1600});
    assert.deepEqual(report.identity.sources,[{assetId:source.id,sha256:sha(bytes),sizeBytes:bytes.length}]);
    assert.equal(report.original.state,'valid');assert.equal(report.original.sampleFrames,57*1600);
    assert.equal(report.original.gatingBlockCount,16);assert.ok(report.original.integratedLufs>-30);
    assert.equal(report.candidate.status,'measured');assert.equal(report.candidate.applyAllowed,false);
    assert.equal(report.candidate.measurement.sampleFrames,57*1600);assert.equal(report.candidate.measurement.gatingBlockCount,16);
    assert.equal(report.candidate.meetsTarget,true);assert.equal(report.candidate.meetsTruePeak,true);
    assert.ok(Math.abs(report.candidate.measurement.integratedLufs+30)<=.1);
    assert.ok(report.candidate.measurement.truePeakDbtp<=-1.5);
    assert.ok(report.candidate.gainMultiplier>0&&report.candidate.gainMultiplier<1);
    assert.deepEqual(report.candidate.gains.map(gain=>({clipId:gain.clipId,assetId:gain.assetId,beforeGain:gain.beforeGain,afterGain:gain.afterGain})),
      timeline.clips.map(clip=>({clipId:clip.id,assetId:source.id,beforeGain:clip.gain,afterGain:clip.gain*report.candidate.gainMultiplier})).sort((a,b)=>a.clipId.localeCompare(b.clipId)));
    assert.equal(report.checks.bytesHashed,2*bytes.length);assert.equal(report.checks.passes,2);
    assert.equal(report.checks.pcmBytes,57*1600*8*2);assert.equal(report.checks.audioFullyDecoded,true);
    assert.ok(report.checks.segmentCount>=4);assert.ok(report.checks.decodeWorkFrames>0);
    assert.ok(Buffer.byteLength(JSON.stringify({ok:true,data:report}))<=65536);
    for(const privateValue of [backend.token,root,savedSource.relativePath])assert.ok(!JSON.stringify(report).includes(privateValue));
    const actual=events.slice(start),started=actual.filter(event=>event.type==='started'),exited=actual.filter(event=>event.type==='exited');
    assert.equal(started.filter(event=>event.kind==='ffprobe').length,2,name+' must genuinely probe both complete passes');
    assert.equal(started.filter(event=>event.kind==='ffmpeg').length,2*report.checks.segmentCount,name+' must genuinely decode original and changed-gain segments');
    assert.deepEqual(exited.map(event=>[event.pid,event.kind]).sort(),started.map(event=>[event.pid,event.kind]).sort());
    let active=0,maximum=0;for(const event of actual){active+=event.type==='started'?1:-1;maximum=Math.max(maximum,active);}assert.equal(active,0);assert.equal(maximum,1);
    counts.push({channel:name,probeCount:2,decodeCount:2*report.checks.segmentCount,maximumChildren:maximum});
    assert.deepEqual(rows(),before.rows,name+' must not modify any database record, history or receipt');
    assert.equal(db.prepare('PRAGMA data_version').get().data_version,before.version,name+' must not write the database');
    assert.deepEqual(await manifest(root),before.files,name+' must not modify managed files or create sidefiles');
    assert.equal(listeners.length,reports.length);assert.deepEqual(listeners.at(-1).remaining,listeners.at(-1).baseline);
  }
  const comparable=({checkedAt,...report})=>report;
  for(const report of reports)assert.deepEqual(comparable(report),comparable(reports[0]));
  assert.equal(db.prepare('SELECT count(*) AS n FROM exports').get().n,0);
  assert.equal(listeners.length,3);assert.ok(listeners.every(({remaining})=>remaining.request===0&&remaining.response===0));
  t.diagnostic(JSON.stringify({observations:3,sampleFrames:reports[0].original.sampleFrames,originalLufs:reports[0].original.integratedLufs,
    candidateLufs:reports[0].candidate.measurement.integratedLufs,candidateTruePeakDbtp:reports[0].candidate.measurement.truePeakDbtp,
    counts,listeners,allRowsAndFilesUnchanged:true}));
});
