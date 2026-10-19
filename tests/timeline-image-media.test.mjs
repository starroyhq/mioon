import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {run,runStreaming} from '../packages/business/src/media-runtime.ts';
import {probe} from '../packages/business/src/media.ts';
import {inspectStaticSrgbPng} from '../packages/business/src/timeline-image-admission.ts';
import {createTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {timelineColourInputFilter} from '../packages/business/src/timeline-colour-lut.ts';
import {TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '@mioon/contracts';
import {png,sha,imageColour,evidenceOnly,timelineFixture,stamp} from './helpers/timeline-image-fixtures.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-image-media-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const imageFile=path.join(root,'image.png'),videoFile=path.join(root,'video.mp4'),bytes=png({width:17,height:19,pixel:(x)=>x<5?[255,0,255,0]:[128,128,128,128]});await writeFile(imageFile,bytes);
 await run('ffmpeg',['-v','error','-threads','1','-f','lavfi','-i','color=black:s=64x64:r=30','-frames:v','6','-an','-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv',videoFile],{timeout:15000});
 const picture=await probe(imageFile),motion=await probe(videoFile),image={id:randomUUID(),mimeType:'image/png',path:imageFile,relativePath:'image.png',sha256:sha(bytes),sizeBytes:bytes.length,...picture,colourProbe:picture.probe,colourImageEvidence:evidenceOnly(await inspectStaticSrgbPng(bytes))},videoBytes=await readFile(videoFile),video={id:randomUUID(),mimeType:'video/mp4',path:videoFile,relativePath:'video.mp4',sha256:sha(videoBytes),sizeBytes:videoBytes.length,...motion,colourProbe:motion.probe};
 const videoColour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:video.sha256,streamIndex:video.videoStreamIndex,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look:null};
 const timeline=timelineFixture([video,image],[videoColour,imageColour(image.colourImageEvidence)]);timeline.clips[1].rect={x:180,y:180,width:360,height:360};timeline.subtitles={profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[{id:randomUUID(),text:'Mixed SDR subtitle',startFrame:2,durationFrames:2}]};
 const assets=[video,image].map(a=>({id:a.id,mimeType:a.mimeType,sha256:a.sha256,relativePath:a.relativePath,width:a.width,height:a.height,duration:a.duration,hasAudio:a.hasAudio}));
 const snapshot={timeline,assets,subtitleProfile:{profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256},colourPlan:createTimelineColourPlan(timeline,assets)};
 return{root,image,video,snapshot,prepared:new Map([[image.id,image],[video.id,video]])};
}
async function decoded(file){const chunks=[];await runStreaming('ffmpeg',['-v','error','-threads','1','-i',file,'-vf',`${timelineColourInputFilter('limited')},format=rgb24`,'-an','-fps_mode','passthrough','-threads','1','-f','rawvideo','pipe:1'],{timeout:20000,maxStdoutBytes:16*1024*1024,onStdout:chunk=>chunks.push(Buffer.from(chunk))});return Buffer.concat(chunks);}
const pixel=(bytes,frame,x,y)=>[...bytes.subarray((frame*720*720+y*720+x)*3,(frame*720*720+y*720+x)*3+3)];
test('production mixed PNG/video/subtitle preview and export share exact decoded output',{timeout:120000},async t=>{
 const f=await fixture(t),preview=path.join(f.root,'preview.mp4'),out=path.join(f.root,'export.mp4');await renderTimeline(f.snapshot,f.prepared,preview);await renderTimeline(structuredClone(f.snapshot),f.prepared,out);
 const first=await decoded(preview),second=await decoded(out);assert.deepEqual(first,second);assert.equal(first.length,6*720*720*3);const expected=.527924914041446*(128/255)*255;
 assert.ok(pixel(first,0,400,350).every(v=>Math.abs(v-expected)<4),`${pixel(first,0,400,350)} expected${expected}`);assert.ok(pixel(first,0,215,350).every(v=>v<4),'hidden alpha0 magenta does not leak');assert.ok(pixel(first,0,185,350).every(v=>v<4),'contain padding stays transparent');
 for(let frame=0;frame<6;frame++){let white=0;for(let y=552;y<672;y++)for(let x=48;x<672;x++)if(pixel(first,frame,x,y).every(v=>v>220))white++;if(frame===2||frame===3)assert.ok(white>200);else assert.equal(white,0);}
 const stream=(await probe(out)).probe.streams.find(s=>s.codec_type==='video');for(const key of ['color_primaries','color_transfer','color_space'])assert.equal(stream[key],'bt709');assert.equal(stream.color_range,'tv');assert.equal((await readdir(f.root)).some(name=>name.startsWith('.timeline-render-')),false);
});
test('creative LUT on straight image RGB leaves alpha/padding/background/subtitle independent',{timeout:120000},async t=>{
 const f=await fixture(t),text='LUT_3D_SIZE 2\n'+Array(8).fill('1 0.25 0').join('\n')+'\n',bytes=Buffer.from(text),look={resourceId:randomUUID(),resourceSha256:sha(bytes),resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1};f.snapshot.timeline.clips[1].colour.look=look;f.snapshot.colourPlan=createTimelineColourPlan(f.snapshot.timeline,f.snapshot.assets);
 const out=path.join(f.root,'look.mp4');await renderTimeline(f.snapshot,f.prepared,out,{readLut:(_binding,read=true)=>read?{bytes,sha256:sha(bytes),profile:look.resourceProfile}:undefined});const rgb=await decoded(out),p=pixel(rgb,0,400,350);assert.ok(p.every((v,i)=>Math.abs(v-[128,32,0][i])<5),String(p));assert.ok(pixel(rgb,0,215,350).every(v=>v<4));assert.ok(pixel(rgb,0,50,50).every(v=>v<4));
});
test('mixed snapshots cannot downgrade, falsify evidence or bypass required PNG interpretation',async t=>{
 const f=await fixture(t);for(const change of [x=>delete x.colourPlan,x=>x.colourPlan.clips[1].algorithmSha256='0'.repeat(64),x=>x.timeline.clips[1].colour.source.evidence.width++,x=>x.timeline.clips[1].colour.source=null]){const snapshot=structuredClone(f.snapshot);change(snapshot);await assert.rejects(renderTimeline(snapshot,f.prepared,path.join(f.root,randomUUID()+'.mp4')));}
});
test('cancelled managed render joins owned children before removing private image staging',{timeout:30000},async t=>{
 const f=await fixture(t),controller=new AbortController(),events=[],off=onMediaProcess(event=>{events.push(event);if(event.type==='started'&&event.kind==='ffmpeg')controller.abort();});try{await assert.rejects(renderTimeline(f.snapshot,f.prepared,path.join(f.root,'cancelled.mp4'),{signal:controller.signal}));}finally{off();}assert.ok(events.some(e=>e.type==='started'));assert.equal((await readdir(f.root)).some(name=>name.startsWith('.timeline-render-')),false);
});
