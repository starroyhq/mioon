import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClient} from '@mioon/client';
import {isExportSamplePeakResponse,EXPORT_SAMPLE_PEAK_ALGORITHM} from '@mioon/contracts/export-sample-peak';
import {startServer} from '../apps/server/src/index.mjs';
import {mediaEnvironment,mediaExecutable} from '../packages/business/src/media-environment.mjs';

const execute=promisify(execFile),repo=fileURLToPath(new URL('..',import.meta.url));
const operation='timeline.export.samplePeak',token='synthetic-real-export-sample-peak-token';
const sha=value=>createHash('sha256').update(value).digest('hex');
const environment=url=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',RUNWAY_MAX_GENERATIONS:'0',...(url?{MIOON_BASE_URL:url,MIOON_TOKEN:token}:{})});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,label,ms=20000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);}finally{clearTimeout(timer);}}
function png(){
  const chunk=(name,data)=>{const body=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;
    for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([head,body,tail]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(16);header.writeUInt32BE(16,4);header[8]=8;header[9]=2;
  const rows=Buffer.alloc(16*49,90);for(let row=0;row<16;row++)rows[row*49]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
function stereoWav(){
  const frames=9600,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);
  bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
  for(let frame=0;frame<frames;frame++){bytes.writeInt16LE(Math.round(8192*Math.sin(2*Math.PI*frame/48)),44+frame*4);
    bytes.writeInt16LE(Math.round(16384*Math.sin(2*Math.PI*frame/96)),46+frame*4);}
  return bytes;
}
async function manifest(root,relative=''){
  const result=[];for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
    const name=path.join(relative,entry.name);
    if(entry.isDirectory())result.push({directory:name},...await manifest(root,name));
    else if(!/^workbench\.sqlite(?:-wal|-shm|-journal)?$/.test(name)&&name!=='server.lock')result.push({file:name,sha256:sha(await readFile(path.join(root,name)))});
  }return result.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function cli(url,input){
  // execFile owns continuous UTF-8 decoding, process reaping and bounded output.
  const {stdout,stderr}=await execute(process.execPath,[path.join(repo,'apps/cli/src/index.mjs'),...operation.split('.'),'--input',JSON.stringify(input)],
    {cwd:repo,env:environment(url),encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
  assert.ok(!stdout.includes(token)&&!stderr.includes(token));assert.equal(stdout.trim().split('\n').length,1);
  const body=JSON.parse(stdout);assert.equal(body.ok,true,stdout);return body.data;
}
async function official(t,url){
  const client=new Client({name:'export-sample-peak-real-service',version:'1.0.0'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.mjs')],cwd:repo,env:environment(url),stderr:'ignore'});
  t.after(()=>bounded(client.close(),'MCP close'));
  await bounded(client.connect(transport),'MCP connect');
  return async input=>{const result=await client.callTool({name:'timeline_export_samplePeak',arguments:input},undefined,{timeout:20000});
    const blocks=result.content.filter(value=>value.type==='text');assert.equal(blocks.length,1);const body=JSON.parse(blocks[0].text);
    assert.deepEqual(result.structuredContent,body);assert.equal(Boolean(result.isError),false);assert.equal(body.ok,true,blocks[0].text);
    assert.ok(!JSON.stringify(body).includes(token));return body.data;};
}
async function independentPcm(file){
  const {stdout:probe}=await execute(mediaExecutable('ffprobe'),['-v','error','-show_streams','-of','json',file],
    {env:mediaEnvironment(),encoding:'utf8',timeout:20000,maxBuffer:64*1024});
  const audio=JSON.parse(probe).streams.filter(stream=>stream.codec_type==='audio');assert.equal(audio.length,1);
  assert.equal(audio[0].codec_name,'aac');assert.equal(Number(audio[0].sample_rate),48000);assert.equal(audio[0].channels,2);
  const {stdout:pcm}=await execute(mediaExecutable('ffmpeg'),['-v','error','-nostdin','-i',file,'-map',`0:${audio[0].index}`,'-vn','-sn','-dn','-acodec','pcm_f32le','-f','f32le','pipe:1'],
    {env:mediaEnvironment(),encoding:'buffer',timeout:20000,maxBuffer:512*1024});
  assert.ok(pcm.length>0);assert.equal(pcm.length%8,0);const peaks=[0,0];
  for(let offset=0;offset<pcm.length;offset+=4){const sample=pcm.readFloatLE(offset);assert.equal(Number.isFinite(sample),true);const channel=(offset/4)%2;peaks[channel]=Math.max(peaks[channel],Math.abs(sample));}
  return {sampleFrames:pcm.length/8,peaks};
}

test('real succeeded named/ranged export has identical HTTP, CLI and MCP sample-peak observations with no data or file mutation',{timeout:120000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'mioon-sample-peak-real-wire-'));let backend,db;
  t.after(async()=>{db?.close();await backend?.close();await rm(root,{recursive:true,force:true});});
  backend=await startServer({dataDir:root,port:0,token,chatGateway:async function*(){throw Error('No model or provider call permitted');}});
  const client=createClient({env:environment(backend.url)});
  const project=await client.rpc('project.create',{name:'Synthetic final-export parity'});
  let timeline=await client.rpc('timeline.get',{projectId:project.id});
  for(const [name,mimeType,bytes,kind] of [['Synthetic pixels.png','image/png',png(),'video'],['Synthetic stereo.wav','audio/wav',stereoWav(),'audio']]){
    const asset=await client.rpc('asset.import',{projectId:project.id,name,mimeType,dataBase64:bytes.toString('base64')});
    timeline=await client.rpc('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),
      trackId:timeline.tracks.find(track=>track.kind===kind).id,assetId:asset.id,startFrame:0,durationFrames:6});
  }
  const exportRange={startFrame:1,endFrame:4},deliveryName='交付 样本峰值 parity';
  const queued=await client.rpc('timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',deliveryName,exportRange});
  let record;const deadline=Date.now()+40000;
  while(Date.now()<deadline){record=await client.rpc('export.get',{exportId:queued.id});if(['succeeded','failed'].includes(record.status))break;await pause(25);}
  assert.equal(record?.status,'succeeded',JSON.stringify(record?.error));
  db=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});
  const asset=JSON.parse(db.prepare('SELECT data FROM assets WHERE id=?').get(record.assetId).data);
  const file=path.join(root,asset.relativePath),bytes=await readFile(file),actualSha=sha(bytes),reference=await independentPcm(file);
  assert.equal(actualSha,asset.sha256);assert.equal(bytes.length,asset.sizeBytes);
  assert.ok(reference.peaks[0]>0&&reference.peaks[1]>reference.peaks[0]);
  const input={projectId:project.id,exportId:record.id},mcp=await official(t,backend.url);
  const rows=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>
    [name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()]));
  const before={rows:rows(),version:db.prepare('PRAGMA data_version').get().data_version,files:await manifest(root)};
  const http=async()=>{const response=await fetch(backend.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,input})});
    assert.equal(response.status,200);const body=await response.json();assert.equal(body.ok,true);return body.data;};
  const reports=[];
  for(const [name,call] of [['HTTP',http],['CLI',()=>cli(backend.url,input)],['MCP',()=>mcp(input)]]){
    const report=await call();reports.push(report);assert.equal(isExportSamplePeakResponse(report,input),true,name+': '+JSON.stringify(report));
    assert.equal(report.status,'ready',name+': '+JSON.stringify(report.reason));assert.equal(report.algorithm,EXPORT_SAMPLE_PEAK_ALGORITHM);
    assert.deepEqual(report.artifact,{assetId:asset.id,sha256:actualSha,sizeBytes:bytes.length,timelineRevision:record.timelineRevision,deliveryName,exportRange});
    assert.deepEqual(report.checks,{bytesHashed:2*bytes.length,audioFullyDecoded:true});
    assert.equal(report.measurement.sampleFrames,reference.sampleFrames);assert.equal(report.measurement.decodedDurationSeconds,reference.sampleFrames/48000);
    assert.deepEqual(report.measurement.channelPeaks.map(channel=>channel.peakLinear),reference.peaks);
    assert.equal(report.measurement.peakLinear,Math.max(...reference.peaks));assert.ok(Math.abs(report.measurement.decodedDurationSeconds-0.1)<=0.1);
    assert.ok(Buffer.byteLength(JSON.stringify(report))<=8192);
    assert.deepEqual(rows(),before.rows,name+' changed database records or receipts');assert.equal(db.prepare('PRAGMA data_version').get().data_version,before.version,name+' performed a database write');
    assert.deepEqual(await manifest(root),before.files,name+' changed managed files or wrote cache/sidefiles');
  }
  const comparable=({checkedAt,...report})=>report;
  for(const report of reports)assert.deepEqual(comparable(report),comparable(reports[0]));
});
