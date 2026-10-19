import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {run,runStreaming,checkMediaEffect} from '../packages/business/src/media-runtime.ts';
import {probe} from '../packages/business/src/media.ts';
import {createPrivateTemporaryDirectory,validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {createTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {parseCube3D,sampleCube3D} from '../packages/business/src/cube-lut.ts';
import {premixTimelineColourLut,prepareTimelineColourLuts,TIMELINE_COLOUR_OUTPUT_FILTER,timelineColourInputFilter} from '../packages/business/src/timeline-colour-lut.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '@mioon/contracts';
import {LUT_RESOURCE_PROFILE} from '../packages/contracts/src/lut-resources.ts';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const runtime={checkMediaEffect,createPrivateTemporaryDirectory,validatePrivateDirectory};
const cube=(fn,size=3)=>`LUT_3D_SIZE ${size}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n`+Array.from({length:size**3},(_,i)=>fn((i%size)/(size-1),(Math.floor(i/size)%size)/(size-1),Math.floor(i/size**2)/(size-1)).join(' ')).join('\n')+'\n';
const identity=(r,g,b)=>[r,g,b],nonlinear=(r,g,b)=>[.05+.9*r*r*(.75+.25*g),.1+.8*g*g*(.6+.4*b),.02+.96*Math.sqrt(b)*(.7+.3*r)];
const content=text=>({bytes:Buffer.from(text),sha256:sha(text),profile:LUT_RESOURCE_PROFILE});
const binding=(value,strength=1)=>({resourceId:randomUUID(),resourceSha256:value.sha256,resourceProfile:LUT_RESOURCE_PROFILE,purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength});
async function sandbox(t){const root=await mkdtemp(path.join(tmpdir(),'mioon-colour-media-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function binary(args,maxStdoutBytes=64*1024*1024){const chunks=[];const output=await runStreaming('ffmpeg',['-v','error','-threads','1','-filter_threads','1',...args],{timeout:30000,maxStdoutBytes,maxStderrBytes:65536,onStdout:chunk=>chunks.push(Buffer.from(chunk))});return Buffer.concat(chunks,output.stdoutBytes);}
async function source(root,{tags=true,transfer='bt709'}={}){
 const raw=path.join(root,randomUUID()+'.yuv'),file=path.join(root,randomUUID()+'.mp4'),n=64*48;
 const frame=Buffer.concat([Buffer.alloc(n,100),Buffer.alloc(n,110),Buffer.alloc(n,140)]);await writeFile(raw,Buffer.concat(Array(30).fill(frame)));
 await run('ffmpeg',['-hide_banner','-loglevel','error','-n','-threads','1','-f','rawvideo','-pixel_format','yuv444p','-video_size','64x48','-framerate','30','-i',raw,'-an','-c:v','libx264','-preset','ultrafast','-qp','0','-threads','1',...(tags?['-color_primaries','bt709','-color_trc',transfer,'-colorspace','bt709','-color_range','tv',...(transfer==='bt709'?[]:['-x264-params',`colorprim=bt709:transfer=${transfer}:colormatrix=bt709`])]:[]),file],{timeout:30000,maxStdoutBytes:0,maxStderrBytes:65536});
 const media=await probe(file),bytes=await readFile(file);
 return {id:randomUUID(),mimeType:'video/mp4',path:file,relativePath:path.basename(file),sha256:sha(bytes),sizeBytes:bytes.length,...media,colourProbe:media.probe};
}
function frozen(asset,look,extraClips=[]){
 const projectId=randomUUID(),trackId=randomUUID(),clipId=randomUUID(),at='2026-10-14T00:00:00.000Z';
 const timeline={id:randomUUID(),projectId,revision:1,fps:30,width:720,height:720,durationFrames:12,createdAt:at,updatedAt:at,
  tracks:[{id:trackId,kind:'video',name:'Video',orderIndex:0,hidden:false,muted:false}],
  clips:[{id:clipId,trackId,assetId:asset.id,name:'Colour fixture',startFrame:0,durationFrames:12,sourceInFrame:0,rect:{x:0,y:0,width:720,height:720},gain:1,
   colour:{profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:asset.sha256,streamIndex:asset.videoStreamIndex,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:at},look}},...extraClips]};
 const assets=[{id:asset.id,sha256:asset.sha256,mimeType:asset.mimeType,relativePath:asset.relativePath,duration:asset.duration,width:asset.width,height:asset.height,hasAudio:asset.hasAudio}];
 return {timeline,assets,colourPlan:createTimelineColourPlan(timeline,assets)};
}
test('production premix preserves oracle on all tetrahedra, ties and boundaries',{timeout:30000},()=>{
 const original=content(cube(nonlinear,5)),parsed=parseCube3D(original.bytes.toString());
 for(const strength of [.01,.25,.5,1]){
  const premixed=premixTimelineColourLut(original,strength),actual=parseCube3D(premixed.text);
  assert.equal(sha(original.bytes),original.sha256);assert.equal(premixed.sha256,sha(premixed.text));
  const points=[[0,0,0],[1,1,1],[.1,.1,.1],[.2,.4,.6],[.6,.2,.4],[.4,.6,.2],[.6,.4,.2],[.4,.2,.6],[.2,.6,.4]];
  let seed=123;for(let n=0;n<300;n++){const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967295);points.push([rand(),rand(),rand()]);}
  for(const rgb of points){const expected=sampleCube3D(parsed,rgb,strength),value=sampleCube3D(actual,rgb);assert.ok(value.every((v,i)=>Math.abs(v-expected[i])<1e-14));}
 }
 assert.throws(()=>premixTimelineColourLut({...original,sha256:'0'.repeat(64)},1));assert.throws(()=>premixTimelineColourLut(original,0));
});
test('owned LUT staging bypasses disabled/zero, deduplicates, detects tamper and cleans only its files',async t=>{
 const root=await sandbox(t),data=content(cube(identity)),look=binding(data,.5);let reads=0;
 const disabled=await prepareTimelineColourLuts({clips:[{clipId:'a',look:{...look,enabled:false}},{clipId:'b',look:{...look,strength:0}}]},path.join(root,'out.mp4'),{readLut(){reads++;throw Error('must not read');}},runtime);
 assert.equal(reads,0);assert.equal(disabled.totalBytes,0);assert.equal(disabled.filter('a'),'');assert.equal(disabled.cleanup(),true);assert.deepEqual(await readdir(root),[]);
 const stage=await prepareTimelineColourLuts({clips:[{clipId:'a',look},{clipId:'b',look}]},path.join(root,'out.mp4'),{readLut(_value,bytes=true){reads++;return bytes?data:undefined;}},runtime);
 assert.equal(stage.filter('a'),stage.filter('b'));assert.match(stage.filter('a'),/^copy,lut3d=/);const dirs=await readdir(root);assert.equal(dirs.length,1);
 const files=await readdir(path.join(root,dirs[0]));assert.equal(files.length,1);const file=path.join(root,dirs[0],files[0]);
 const original=await readFile(file);await writeFile(file,Buffer.alloc(original.length,32));assert.throws(()=>stage.verifyBytes(),{code:'TIMELINE_COLOUR_RESOURCE_CHANGED'});
 await writeFile(path.join(root,dirs[0],'unknown.txt'),'preserve');assert.equal(stage.cleanup(),false);assert.equal(await readFile(path.join(root,dirs[0],'unknown.txt'),'utf8'),'preserve');
});
test('shared production SDR renderer grades source before padding and preview/export decode identically',{timeout:120000},async t=>{
 const root=await sandbox(t),asset=await source(root),data=content(cube(nonlinear,17)),look=binding(data,.5),snapshot=frozen(asset,look),assets=new Map([[asset.id,asset]]),readLut=(_binding,bytes=true)=>bytes?data:undefined;
 const preview=path.join(root,'preview.mp4'),exported=path.join(root,'export.mp4');
 await renderTimeline(snapshot,assets,preview,{readLut});await renderTimeline(structuredClone(snapshot),assets,exported,{readLut});
 const fingerprints=async file=>(await run('ffmpeg',['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-'],{timeout:30000,maxStdoutBytes:65536})).split('\n').filter(line=>line&&!line.startsWith('#')).join('\n');
 assert.equal(await fingerprints(preview),await fingerprints(exported));
 const actual=await binary(['-i',preview,'-vf',`${timelineColourInputFilter('limited')},format=rgb24`,'-frames:v','1','-an','-threads','1','-f','rawvideo','pipe:1']);
 const pixel=(x,y)=>[...actual.subarray((y*720+x)*3,(y*720+x)*3+3)];assert.ok(pixel(360,20).every(v=>v<4),'padding stays black, not LUT-colored');
 const y=(100-16)/219,cb=(110-128)/224,cr=(140-128)/224,rgb=[y+1.5748*cr,y-(.0722*1.8556/.7152)*cb-(.2126*1.5748/.7152)*cr,y+1.8556*cb];
 const expected=sampleCube3D(parseCube3D(data.bytes.toString()),rgb,.5).map(value=>value*255),center=pixel(360,360);assert.ok(center.every((v,i)=>Math.abs(v-expected[i])<4),`center ${center} expected ${expected}`);
 const result=await probe(exported),v=result.probe.streams.find(s=>s.codec_type==='video');assert.equal(v.color_primaries,'bt709');assert.equal(v.color_transfer,'bt709');assert.equal(v.color_space,'bt709');assert.equal(v.color_range,'tv');assert.equal(Number(v.nb_frames),12);
 assert.equal((await readdir(root)).filter(name=>name.startsWith('.timeline-render-')).length,0);
});
test('zero strength managed render needs no resource and differs from unsupported-source bypass',{timeout:120000},async t=>{
 const root=await sandbox(t),asset=await source(root,{tags:false}),data=content(cube(identity)),snapshot=frozen(asset,binding(data,0)),assets=new Map([[asset.id,asset]]);
 await renderTimeline(snapshot,assets,path.join(root,'zero.mp4'),{readLut(){throw Error('zero must bypass');}});
 const bad=structuredClone(snapshot);bad.timeline.clips[0].colour.source.range='full';bad.colourPlan=createTimelineColourPlan(bad.timeline,bad.assets);
 // Untagged range is explicitly selectable; known PQ is not.
 const hdr=await source(root,{transfer:'smpte2084'}),hdrSnapshot=frozen(hdr,null);assert.equal(hdr.colourProbe.streams[0].color_transfer,'smpte2084');
 await assert.rejects(renderTimeline(hdrSnapshot,new Map([[hdr.id,hdr]]),path.join(root,'hdr.mp4')),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
 const changed=structuredClone(snapshot);changed.colourPlan.clips[0].range='full';await assert.rejects(renderTimeline(changed,assets,path.join(root,'changed.mp4')),{code:'INVALID_TIMELINE_SNAPSHOT'});
});

test('managed multitrack padding and subtitles retain layer ownership through an interior range',{timeout:120000},async t=>{
 const root=await sandbox(t),asset=await source(root),data=content(cube(()=>[1,0,0],2)),look=binding(data),snapshot=frozen(asset,null),lower=snapshot.timeline.clips[0],upperTrack={...snapshot.timeline.tracks[0],id:randomUUID(),orderIndex:1};
 snapshot.timeline.tracks.push(upperTrack);snapshot.timeline.clips.push({...structuredClone(lower),id:randomUUID(),trackId:upperTrack.id,startFrame:4,durationFrames:4,rect:{x:180,y:180,width:360,height:360},colour:{...lower.colour,look}});
 snapshot.timeline.subtitles={profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[{id:randomUUID(),text:'White subtitles',startFrame:5,durationFrames:2}]};snapshot.subtitleProfile={profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256};snapshot.colourPlan=createTimelineColourPlan(snapshot.timeline,snapshot.assets);
 const assets=new Map([[asset.id,asset]]),readLut=(_binding,bytes=true)=>bytes?data:undefined,full=path.join(root,'layers.mp4'),selected=path.join(root,'layers-range.mp4');
 await renderTimeline(snapshot,assets,full,{readLut});await renderTimeline({...snapshot,exportRange:{startFrame:3,endFrame:9}},assets,selected,{readLut});
 const decode=file=>binary(['-i',file,'-vf',`${timelineColourInputFilter('limited')},format=rgb24`,'-an','-fps_mode','passthrough','-threads','1','-f','rawvideo','pipe:1']);
 const all=await decode(full),part=await decode(selected),frameBytes=720*720*3;assert.equal(all.length,12*frameBytes);assert.equal(part.length,6*frameBytes);
 const pixel=(bytes,frame,x,y)=>[...bytes.subarray(frame*frameBytes+(y*720+x)*3,frame*frameBytes+(y*720+x)*3+3)];
 for(let n=0;n<6;n++){
  const global=n+3,center=pixel(part,n,360,360),outside=pixel(part,n,100,360),padding=pixel(part,n,360,195);
  if(global>=4&&global<8){assert.ok(center[0]>245&&center[1]<5&&center[2]<5,`upper red at ${global}: ${center}`);}else assert.ok(center[0]<150&&center[1]>60,'outside upper time is lower source');
  assert.ok(padding.every((v,i)=>Math.abs(v-outside[i])<5),`transparent padding shows lower layer, not look at ${global}`);
  for(const [x,y] of [[360,360],[100,360],[360,195]])assert.ok(pixel(part,n,x,y).every((v,i)=>Math.abs(v-pixel(all,global,x,y)[i])<4),'selected range retains global composition');
  let white=0;for(let y=552;y<672;y++)for(let x=48;x<672;x++){const at=n*frameBytes+(y*720+x)*3;if(part[at]>220&&part[at+1]>220&&part[at+2]>220)white++;}
  if(global>=5&&global<7)assert.ok(white>200,`subtitle stays white at ${global}: ${white}`);else assert.equal(white,0,`subtitle half-open boundary at ${global}`);
 }
 const result=await probe(selected);assert.equal(result.probe.streams.find(s=>s.codec_type==='video').color_range,'tv');assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')),false);
});
for(const range of ['limited','full'])test(`actual 10-bit ${range} source uses explicit SDR interpretation and limited output`,{timeout:90000},async t=>{
 const root=await sandbox(t),raw=path.join(root,'ten-bit.yuv'),file=path.join(root,'ten-bit.mp4'),n=64*48,values=[400,440,560],frame=Buffer.alloc(n*3*2);
 for(let c=0;c<3;c++)for(let p=0;p<n;p++)frame.writeUInt16LE(values[c],(c*n+p)*2);await writeFile(raw,Buffer.concat(Array(12).fill(frame)));
 await run('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','rawvideo','-pixel_format','yuv444p10le','-video_size','64x48','-framerate','30','-color_range',range==='full'?'pc':'tv','-i',raw,'-an','-c:v','libx264','-preset','ultrafast','-qp','0','-threads','1','-x264-params',`colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=${range==='full'?'on':'off'}`,'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range',range==='full'?'pc':'tv',file],{timeout:30000,maxStdoutBytes:0,maxStderrBytes:65536});
 const media=await probe(file),stream=media.probe.streams.find(s=>s.codec_type==='video');assert.equal(stream.pix_fmt,'yuv444p10le');assert.equal(stream.color_range,range==='full'?'pc':'tv');assert.equal(stream.color_transfer,'bt709');
 // This encoded source fixture is not the independent lossless conversion oracle.
 // Measure its decoded code values so fixture-encoder quantization is not
 // misattributed to the production LUT/composition/output chain.
 const rawDecoded=await binary(['-i',file,'-frames:v','1','-an','-pix_fmt','yuv444p10le','-threads','1','-f','rawvideo','pipe:1']);assert.equal(rawDecoded.length,n*6);const observed=[0,1,2].map(c=>rawDecoded.readUInt16LE((c*n+24*64+32)*2));for(let c=0;c<3;c++)for(let p=0;p<n;p++)assert.equal(rawDecoded.readUInt16LE((c*n+p)*2),observed[c],'fixture is a uniform decoded 10-bit field');t.diagnostic(`${range} measured source codes: ${observed}`);
 const bytes=await readFile(file),asset={id:randomUUID(),mimeType:'video/mp4',path:file,relativePath:path.basename(file),sha256:sha(bytes),sizeBytes:bytes.length,...media,colourProbe:media.probe},data=content(cube(nonlinear,17)),snapshot=frozen(asset,binding(data,.5));snapshot.timeline.clips[0].colour.source.range=range;snapshot.colourPlan=createTimelineColourPlan(snapshot.timeline,snapshot.assets);
 const output=path.join(root,'output.mp4');await renderTimeline(snapshot,new Map([[asset.id,asset]]),output,{readLut:(_look,read=true)=>read?data:undefined});
 const decoded=await binary(['-i',output,'-vf',`${timelineColourInputFilter('limited')},format=rgb24`,'-frames:v','1','-an','-threads','1','-f','rawvideo','pipe:1']),center=[...decoded.subarray((360*720+360)*3,(360*720+360)*3+3)];
 const y=range==='full'?observed[0]/1023:(observed[0]-64)/876,cb=(observed[1]-512)/(range==='full'?1023:896),cr=(observed[2]-512)/(range==='full'?1023:896),rgb=[y+1.5748*cr,y-(.0722*1.8556/.7152)*cb-(.2126*1.5748/.7152)*cr,y+1.8556*cb],expected=sampleCube3D(parseCube3D(data.bytes.toString()),rgb,.5).map(v=>v*255);
 assert.ok(center.every((v,i)=>Math.abs(v-expected[i])<4),`${range} center ${center}, expected ${expected}`);const out=(await probe(output)).probe.streams.find(s=>s.codec_type==='video');assert.equal(out.color_range,'tv');assert.equal(out.pix_fmt,'yuv420p');
});
test('cancelled colour capability joins its child and removes only owned LUT and segment staging',{timeout:90000},async t=>{
 const root=await sandbox(t),asset=await source(root),data=content(cube(nonlinear)),snapshot=frozen(asset,binding(data,.5)),controller=new AbortController(),before=(await readdir(root)).sort(),events=[],off=onMediaProcess(event=>{events.push(event);if(event.type==='started'&&event.kind==='ffmpeg')controller.abort();});
 try{await assert.rejects(renderTimeline(snapshot,new Map([[asset.id,asset]]),path.join(root,'cancelled.mp4'),{signal:controller.signal,readLut:(_look,read=true)=>read?data:undefined}),{code:'MEDIA_CANCELLED'});}finally{off();}
 assert.equal(events.filter(e=>e.type==='started').length,1);assert.equal(events.filter(e=>e.type==='exited').length,1);assert.deepEqual((await readdir(root)).sort(),before);assert.equal(sha(await readFile(asset.path)),asset.sha256);
});
