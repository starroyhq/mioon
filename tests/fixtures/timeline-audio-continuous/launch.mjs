/** Explicit synthetic Electron qualification; no execution on import.
 * node tests/fixtures/timeline-audio-continuous/launch.mjs <fresh-output-root>
 * Generated media, workspace, bundled harness and evidence stay in that root.
 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,open,stat,copyFile,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {openStore} from '../../../packages/business/src/db.ts';
import {createServices} from '../../../packages/business/src/services.ts';
import {timelineCompositionSegments} from '../../../packages/contracts/src/timeline-segments.ts';

const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../../..'),exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const seconds=frame=>(frame/30).toFixed(9);
async function ffmpeg(args){return exec(process.env.MIOON_FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-n','-threads','1',...args],{timeout:120000,maxBuffer:256*1024});}
function wav(){
  const samples=25*48000,bytes=Buffer.alloc(44+samples*4);bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*4,40);
  for(let sample=0;sample<samples;sample++){
    const left=Math.round(6200*Math.sin(sample*.057)+1700*Math.cos(sample*.019)),right=-left;
    bytes.writeInt16LE(left,44+sample*4);bytes.writeInt16LE(right,46+sample*4);
  }return bytes;
}
async function independentOracle(root,item,assets){
  const directory=path.join(root,'web/oracle',item.name);await mkdir(directory,{recursive:true});
  const complete=await open(path.join(root,`${item.name}.reference.f32`),'wx+',0o600);let offset=0;
  const byTrack=new Map(item.timeline.tracks.map(track=>[track.id,track])),segments=timelineCompositionSegments(item.timeline),boundaries=[];
  try{
    for(const [index,segment]of segments.entries()){
      const begin=segment.beginFrame,end=segment.endFrame,samples=(end-begin)*1600;
      const clips=item.timeline.clips.filter(clip=>!byTrack.get(clip.trackId).muted&&clip.gain!==0&&assets.get(clip.assetId).hasAudio&&clip.startFrame<=begin&&clip.startFrame+clip.durationFrames>=end)
        .sort((a,b)=>byTrack.get(a.trackId).orderIndex-byTrack.get(b.trackId).orderIndex||a.id.localeCompare(b.id));
      const args=[],filters=[`anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[silence]`],labels=['silence'];
      for(const [voice,clip]of clips.entries()){
        const sourceFrame=clip.sourceInFrame+begin-clip.startFrame;
        args.push('-ss',seconds(sourceFrame),'-t',seconds(end-begin+1),'-i',assets.get(clip.assetId).path);
        const local=(begin-clip.startFrame)*1600,fadeIn=(clip.fadeInFrames??0)*1600,fadeOut=(clip.fadeOutFrames??0)*1600;
        let chain=`[${voice}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.gain},apad,atrim=end_sample=${samples}`;
        if(fadeIn||fadeOut){chain+=`,asettb=1/48000,asetpts=N+${local}`;if(fadeIn)chain+=`,afade=t=in:ss=0:ns=${fadeIn}:curve=tri`;if(fadeOut)chain+=`,afade=t=out:ss=${clip.durationFrames*1600-fadeOut}:ns=${fadeOut}:curve=tri`;}
        filters.push(`${chain},asetpts=N/SR/TB[v${voice}]`);labels.push(`v${voice}`);
      }
      filters.push(`${labels.map(label=>`[${label}]`).join('')}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${samples},asetpts=N/SR/TB[out]`);
      const file=path.join(root,`${item.name}.segment-${index}.f32`);
      await ffmpeg([...args,'-filter_complex_threads','1','-filter_complex',filters.join(';'),'-map','[out]','-vn','-sn','-dn','-c:a','pcm_f32le','-ar','48000','-ac','2','-f','f32le',file]);
      const bytes=await readFile(file);assert.equal(bytes.length,samples*8);assert.ok(bytes.length<=32*1024*1024);
      await complete.write(bytes,0,bytes.length,offset);offset+=bytes.length;boundaries.push({beginFrame:begin,endFrame:end,sourceVoices:clips.length,sampleFrames:samples,sha256:hash(bytes)});
    }
    assert.equal(offset,item.timeline.durationFrames*12800);
    for(let frame=0;frame<item.timeline.durationFrames;frame+=60){
      const count=Math.min(60,item.timeline.durationFrames-frame)*12800,bytes=Buffer.allocUnsafe(count),read=await complete.read(bytes,0,count,frame*12800);assert.equal(read.bytesRead,count);
      await writeFile(path.join(directory,`${String(frame).padStart(5,'0')}.f32`),bytes,{mode:0o600});
    }
  }finally{await complete.close();}
  return {samples:offset/8,compositionSegments:boundaries,referenceMethod:'Independent FFmpeg per ORIGINAL global composition segment; independent volume/afade/amix filters, unnormalized float output, then raw concatenation. Transport blocks do not create decoder segment edges.'};
}
async function seed(root){
  const source=path.join(root,'canonical.wav');await writeFile(source,wav(),{mode:0o600});
  const aac=path.join(root,'canonical-44100.m4a'),video=path.join(root,'embedded-48000.mp4');
  await ffmpeg(['-i',source,'-map','0:a:0','-ar','44100','-ac','2','-c:a','aac','-b:a','160k',aac]);
  await ffmpeg(['-f','lavfi','-i','color=c=black:s=160x90:r=30:d=25','-i',source,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-ar','48000','-t','25',video]);
  const store=openStore(path.join(root,'workspace')),services=createServices(store,new Map()),cases=[],references=[];
  try{
    for(const spec of [{name:'controlled-25s',frames:750,mode:'realtime',complex:true},{name:'aac44100-25s',frames:750,mode:'offline',aac:true,complex:true},
      {name:'controlled-2min',frames:3600,mode:'offline'},{name:'controlled-10min',frames:18000,mode:'offline'},{name:'native-performance',frames:750,mode:'performance'}]){
      const project=await services.call('project.create',{name:`Synthetic continuous ${spec.name}`}),base=await services.call('timeline.get',{projectId:project.id}),assets=new Map();
      for(const [filename,mime]of [[spec.aac?aac:source,spec.aac?'audio/mp4':'audio/wav'],...(spec.complex&&!spec.aac?[[video,'video/mp4']]:[])]){
        const bytes=await readFile(filename),asset=await services.call('asset.import',{projectId:project.id,name:path.basename(filename),mimeType:mime,dataBase64:bytes.toString('base64')});
        const saved=store.get('assets',asset.id);assets.set(asset.id,{...saved,path:path.join(store.root,saved.relativePath)});
      }
      const sound=[...assets.values()].find(asset=>asset.mimeType.startsWith('audio/')),embedded=[...assets.values()].find(asset=>asset.mimeType.startsWith('video/'));
      const tracks=[{id:randomUUID(),kind:'video',orderIndex:0,hidden:true,muted:false},{id:randomUUID(),kind:'audio',orderIndex:1,hidden:false,muted:false},
        {id:randomUUID(),kind:'audio',orderIndex:2,hidden:false,muted:false},{id:randomUUID(),kind:'audio',orderIndex:3,hidden:false,muted:true}];
      const clips=[],clip=(track,asset,startFrame,durationFrames,sourceInFrame=0,gain=.5,fadeInFrames=0,fadeOutFrames=0)=>({id:randomUUID(),trackId:tracks[track].id,assetId:asset.id,name:'Synthetic original clip',startFrame,durationFrames,sourceInFrame,gain,fadeInFrames,fadeOutFrames,
        rect:{x:0,y:0,width:720,height:720}});
      for(let at=0;at<spec.frames;at+=750)clips.push(clip(1,sound,at,Math.min(750,spec.frames-at),0,.5,31,17));
      if(spec.complex){clips.push(clip(2,sound,71,329,3,.25,1,1));clips.push(clip(3,sound,113,220,0,2));clips.push(clip(3,sound,599,5,0,1));if(embedded)clips.push(clip(0,embedded,301,179,7,.4,9,13));}
      else clips.push(clip(3,sound,17,12));
      const timeline={...base,revision:base.revision+1,durationFrames:spec.frames,tracks,clips};store.put('timelines',timeline);
      const item={name:spec.name,timeline,input:{projectId:project.id,timelineId:timeline.id,expectedRevision:timeline.revision,startFrame:0},durationFrames:spec.frames,mode:spec.mode,oraclePrefix:`/oracle/${spec.name}`,boundaries:timelineCompositionSegments(timeline).map(segment=>segment.beginFrame)};
      const reference=await independentOracle(root,item,assets);references.push({name:spec.name,...reference});cases.push(item);
    }
  }finally{await services.drain();store.close();}
  await writeFile(path.join(root,'cases.json'),JSON.stringify({cases,references},null,2),{mode:0o600});return {cases,references};
}
export async function run(rootArgument,{reuse=false}={}){
  const requested=path.resolve(rootArgument);if(!reuse)await mkdir(requested,{mode:0o700});const root=await realpath(requested);
  if(!reuse){await mkdir(path.join(root,'web'),{mode:0o700});await seed(root);}
  else {const manifest=JSON.parse(await readFile(path.join(root,'cases.json'),'utf8'));assert.equal(manifest.cases[0].name,'controlled-25s','Reuse requires this exact synthetic fixture family');}
  await build({entryPoints:[path.join(here,'renderer.ts')],outfile:path.join(root,'web/entry.js'),bundle:true,platform:'browser',format:'esm',target:'chrome144',logLevel:'silent'});
  await build({entryPoints:[path.join(here,'preload.ts')],outfile:path.join(root,'preload.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],logLevel:'silent'});
  await build({entryPoints:[path.join(here,'main.mjs')],outfile:path.join(root,'main.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],define:{'import.meta.url':'__fixture_import_meta_url'},banner:{js:'const __fixture_import_meta_url=require("node:url").pathToFileURL(__filename).href;'},logLevel:'silent'});
  await copyFile(path.join(here,'capture-worklet.js'),path.join(root,'web/capture-worklet.js'));
  await writeFile(path.join(root,'web/index.html'),'<!doctype html><meta charset="utf-8"><title>Synthetic continuous audio qualification</title><body>Running controlled media checks<script type="module" src="/entry.js"></script>',{mode:0o600});
  const ffmpegVersion=await exec(process.env.MIOON_FFMPEG_PATH||'ffmpeg',['-version'],{maxBuffer:256*1024}),ffprobeVersion=await exec(process.env.MIOON_FFPROBE_PATH||'ffprobe',['-version'],{maxBuffer:256*1024});
  await writeFile(path.join(root,'environment.json'),JSON.stringify({launcherNode:process.version,ffmpeg:ffmpegVersion.stdout.split('\n')[0],ffprobe:ffprobeVersion.stdout.split('\n')[0]},null,2),{mode:0o600});
  const sourceFiles=['apps/web/src/timeline-audio-continuous-client.ts','apps/web/src/timeline-audio-continuous-engine.ts','apps/web/src/native-audio-preview-adapter.ts',
    'packages/contracts/src/timeline-audio-continuous.ts','packages/contracts/src/native-audio-preview.ts','packages/business/src/timeline-audio-continuous.ts',
    'packages/business/src/timeline-audio-continuous-decoder.ts','packages/business/src/native-audio-preview.ts','packages/business/src/media-runtime.ts',
    'packages/business/src/media-streaming-runtime.ts','packages/business/src/timeline-audio-preview-coordinator.ts','packages/business/src/services.ts',
    'apps/server/src/timeline-audio-continuous-http.ts','apps/desktop/src/native-audio-preview-host.ts','apps/desktop/src/native-audio-preview-preload.ts',
    ...['launch.mjs','main.mjs','preload.ts','renderer.ts','capture-worklet.js'].map(file=>`tests/fixtures/timeline-audio-continuous/${file}`)];
  const base=await exec('git',['rev-parse','HEAD'],{cwd:repo});
  await writeFile(path.join(root,'source-hashes.json'),JSON.stringify({baseCommit:base.stdout.trim(),files:Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,hash(await readFile(path.join(repo,file)))])))},null,2),{mode:0o600});
  const electron=createRequire(import.meta.url)('electron'),env={...process.env,MIOON_ENABLE_LIVE_PROVIDER:'0'};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  const child=spawn(electron,[path.join(root,'main.cjs')],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  const logs=[];for(const stream of[child.stdout,child.stderr])stream.on('data',bytes=>{if(logs.reduce((n,b)=>n+b.length,0)<2*1024*1024)logs.push(Buffer.from(bytes));});
  const timeout=setTimeout(()=>child.kill('SIGTERM'),10*60*1000);
  const outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});clearTimeout(timeout);
  await writeFile(path.join(root,'electron.log'),Buffer.concat(logs),{mode:0o600});
  let report;try{report=JSON.parse(await readFile(path.join(root,'report.json'),'utf8'));}catch{throw Error(`Electron did not write its report; owned process outcome ${JSON.stringify(outcome)}; see ${path.join(root,'electron.log')}`);}
  console.log(JSON.stringify({root,status:report.status,cases:report.cases?.map(item=>({name:item.name,status:item.status,error:item.error})),outcome}));
  assert.equal(outcome.code,0);assert.equal(report.status,'passed');return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){if(!process.argv[2])throw Error('Supply a fresh synthetic output directory');await run(process.argv[2],{reuse:process.argv.includes('--reuse-fixtures')});}
