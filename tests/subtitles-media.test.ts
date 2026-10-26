import type {MediaProcessEvent} from '../packages/business/src/media-processes.ts';
import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256,getTimelineSubtitleTextIssue} from '@mioon/contracts';
import {prepareTimelineSubtitles,timelineSubtitleFilters,createSubtitleInkScanner,subtitleFilterPath} from '../packages/business/src/subtitle-media.ts';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {initializeSubtitleResources} from '../packages/business/src/subtitle-resources.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {parseSubtitleRendererCapability} from '../packages/business/src/subtitle-renderer-capability.ts';
const exec=promisify(execFile),profile={profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256};
const snap=(texts: string[],width: number=720,height: number=1280)=>({timeline:{width,height,subtitles:{profileId:profile.profileId,cues:texts.map((text,i)=>({id:randomUUID(),text,startFrame:i*2,durationFrames:2}))}},subtitleProfile:profile});
const temp=async (t: test.TestContext)=>{const dir=await mkdtemp(path.join(tmpdir(),'mioon-subtitles-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};

test('subtitle capability distinguishes an absent FriBidi option from missing or unverified drawtext',()=>{
 const header='Filter drawtext\n  Draw text on top of video frames using libfreetype library.\n    Inputs:\n       #0: default (video)\n    Outputs:\n       #0: default (video)\ndrawtext AVOptions:\n';
 const rows=['fontfile','textfile','expansion','fontsize','borderw','line_spacing','fontcolor','bordercolor','x','y'].map(name=>`   ${name} <string> ..FV....... synthetic option\n`).join('');
 const ending="\nThis filter has support for timeline through the 'enable' option.\n";
 assert.deepEqual(parseSubtitleRendererCapability(header+rows+ending),{textShaping:false});
 assert.deepEqual(parseSubtitleRendererCapability(header+rows+'   text_shaping <boolean> ..FV....... attempt to shape text before drawing (default true)\n'+ending),{textShaping:true});
 assert.throws(()=>parseSubtitleRendererCapability("Unknown filter 'drawtext'.\n\nExiting with exit code 0\n"),{code:'SUBTITLE_RENDERER_UNAVAILABLE'});
 assert.throws(()=>parseSubtitleRendererCapability(header+rows.replace(/.*fontfile.*\n/u,'')+ending),{code:'SUBTITLE_RENDERER_UNAVAILABLE'});
 for(const output of [header+rows,'unrelated output\n'+header+rows+ending,header+rows+'   text_shaping <string> ..FV....... unknown shape\n'+ending,header+rows+'   x <string> ..FV....... duplicate\n'+ending])assert.throws(()=>parseSubtitleRendererCapability(output),{code:'SUBTITLE_RENDERER_UNVERIFIED'});
 for(const text of ['العربية','עברית','left\u202eright','e\u0301'])assert.ok(getTimelineSubtitleTextIssue(text),'the fixed profile still rejects RTL, controls and combining sequences');
});

test('streaming ink scanner crosses arbitrary chunk boundaries and rejects empty/clipped/short/extra frames',()=>{
 const bytes=Buffer.alloc(4096*256*2);bytes[64*4096+64]=255;bytes[90*4096+150]=1;bytes[4096*256+70*4096+80]=255;
 const scan=createSubtitleInkScanner(2);for(let at=0;at<bytes.length;at+=8191)scan.consume(bytes.subarray(at,at+8191));assert.deepEqual(scan.finish().map(x=>[x.width,x.height]),[[87,27],[1,1]]);
 const short=createSubtitleInkScanner(1);short.consume(Buffer.alloc(4));assert.throws(()=>short.finish(),{code:'SUBTITLE_INK_INVALID'});
 const empty=createSubtitleInkScanner(1);empty.consume(Buffer.alloc(4096*256));assert.throws(()=>empty.finish(),{code:'SUBTITLE_INK_INVALID'});
 const clipped=createSubtitleInkScanner(1),edge=Buffer.alloc(4096*256);edge[64*4096+16]=255;clipped.consume(edge);assert.throws(()=>clipped.finish(),{code:'SUBTITLE_INK_INVALID'});
 assert.throws(()=>createSubtitleInkScanner(1).consume(Buffer.alloc(4096*256+1)),{code:'SUBTITLE_INK_INVALID'});
 for(const count of [0,101,NaN,Infinity,1.5])assert.throws(()=>createSubtitleInkScanner(count));
 for(const value of ['/tmp/line\nfeed','relative',NaN])assert.throws(()=>subtitleFilterPath(value));
});

test('bounded renderer inspection and one font-only process measure literal cues with hostile paths and all 100 captions',async t=>{
 const root=await temp(t),work=path.join(root,"中文 space ' apostrophe :colon,[brackets];semi\\slash");await mkdir(work);
 const texts=['你好，世界！\n字幕与 English 100%',"%{eif:1+1:d} ' \\", '中文字'.repeat(6)+'字幕'];
 const snapshot=snap(texts),events: MediaProcessEvent[]=[],off=onMediaProcess(event=>events.push(event));let prepared;
 try{prepared=await prepareTimelineSubtitles(snapshot,work);}finally{off();}
 assert.equal(events.filter(e=>e.type==='started').length,2);assert.ok(events.filter(e=>e.type==='started').every(event=>event.kind==='ffmpeg'));
 const script=await readFile(path.join(work,'subtitle-measure.filter'),'utf8');
 assert.equal(script.includes(':text_shaping=0'),(prepared)!.textShaping);
 const captionFilters=timelineSubtitleFilters(prepared,0,2,'base').filters.join(';');
 assert.equal(captionFilters.includes(':text_shaping=0'),(prepared)!.textShaping,'measurement and final rendering use the same inspected mode');
 assert.match(timelineSubtitleFilters({...prepared!,textShaping:true},0,2,'base').filters.join(';'),/:text_shaping=0/,'builds with FriBidi always disable its default pre-reordering');
 assert.ok(((prepared)!.entries.get(texts[0]))!.ink.height>28);assert.ok(((prepared)!.entries.get(texts[2]))!.ink.width<=608);
 for(const text of texts)assert.equal(await readFile(((prepared)!.entries.get(text))!.file,'utf8'),text);
 const hundred=path.join(root,'hundred');await mkdir(hundred);const hundredEvents: MediaProcessEvent[]=[],remove=onMediaProcess(e=>hundredEvents.push(e));
 try{const all=await prepareTimelineSubtitles(snap(Array.from({length:100},(_,i)=>`字幕 ${String(i).padStart(3,'0')}`)),hundred);assert.equal((all)!.entries.size,100);}finally{remove();}
 assert.equal(hundredEvents.filter(e=>e.type==='started').length,2);
});

test('caption filters preserve half-open global frames across media edges without adding audio filters',async t=>{
 const root=await temp(t),snapshot=snap(['跨越剪辑边界']);snapshot.timeline.subtitles.cues[0].startFrame=25;snapshot.timeline.subtitles.cues[0].durationFrames=10;
 const prepared=await prepareTimelineSubtitles(snapshot,root),first=timelineSubtitleFilters(prepared,0,30,'layer0'),second=timelineSubtitleFilters(prepared,30,60,'layer0');
 assert.match(first.filters[0],/gte\(n,25\)\*lt\(n,30\)/);assert.match(second.filters[0],/gte\(n,0\)\*lt\(n,5\)/);assert.equal(timelineSubtitleFilters(prepared,35,60,'base').filters.length,0);
 assert.doesNotMatch(first.filters.join(';'),/amix|atrim|asetpts|apad/);assert.throws(()=>timelineSubtitleFilters(prepared,NaN,60,'base'));
});

function wav(){const frames=96000,bytes=Buffer.alloc(44+frames*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);for(let n=0;n<frames;n++)bytes.writeInt16LE(Math.round(9000*Math.sin(2*Math.PI*440*n/48000)),44+n*2);return bytes;}
async function decode(file: string,args: string[],maxBuffer: number=8*1024*1024){return (await exec('ffmpeg',['-v','error','-threads','1','-i',file,...args,'-threads','1','-f','rawvideo','pipe:1'],{encoding:'buffer',maxBuffer,timeout:30000})).stdout;}
function timeline(asset: {id: string},width: number,height: number): FixtureTimeline{const track={id:randomUUID(),name:'Audio',kind:'audio',orderIndex:0,hidden:false,muted:false};return {id:randomUUID(),projectId:randomUUID(),revision:1,fps:30,width,height,durationFrames:60,tracks:[track],clips:[0,30].map(startFrame=>({id:randomUUID(),trackId:track.id,assetId:asset.id,name:'tone',startFrame,durationFrames:30,sourceInFrame:startFrame,rect:{x:0,y:0,width,height},gain:1})),createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};}

test('portrait landscape and square renders show correct boundary frames with identical audio and cleanup',async t=>{
 const root=await temp(t),file=path.join(root,'source.wav');await writeFile(file,wav());
 const asset={id:randomUUID(),mimeType:'audio/wav',path:file,width:0,height:0,duration:2,hasVideo:false,hasAudio:true,audioStreamIndex:0},assets=new Map([[asset.id,asset]]);
 let referenceAudio;
 for(const [width,height] of [[720,1280],[1280,720],[720,720]]){
  const saved=timeline(asset,width,height),snapshot: {timeline: FixtureTimeline; subtitleProfile?: typeof profile}={timeline:saved},plain=path.join(root,`plain-${width}-${height}.mp4`),captioned=path.join(root,`captions-${width}-${height}.mp4`);
  const events: MediaProcessEvent[]=[],off=onMediaProcess(e=>events.push(e));try{await renderTimeline(snapshot as unknown as Parameters<typeof renderTimeline>[0],assets,plain);}finally{off();}
  assert.equal(events.filter(e=>e.type==='started'&&e.kind==='ffmpeg').length,3,'old path uses two clip segments + concat only');
  const cue={id:randomUUID(),text:'你好，字幕\nHello 100%',startFrame:25,durationFrames:10};saved.subtitles={profileId:profile.profileId,cues:[cue]};snapshot.subtitleProfile=profile;
  const captionEvents: MediaProcessEvent[]=[],remove=onMediaProcess(e=>captionEvents.push(e));try{await renderTimeline(snapshot as unknown as Parameters<typeof renderTimeline>[0],assets,captioned);}finally{remove();}
  assert.equal(captionEvents.filter(e=>e.type==='started'&&e.kind==='ffmpeg').length,5,'one help inspection and one measurement; subtitle times add no media segments');
  const video=await decode(captioned,['-vf',"select='eq(n,24)+eq(n,25)+eq(n,29)+eq(n,30)+eq(n,34)+eq(n,35)',format=gray",'-fps_mode','passthrough','-frames:v','6','-an','-pix_fmt','gray']);assert.equal(video.length,width*height*6);
  const counts=[];for(let frame=0;frame<6;frame++){const bytes=video.subarray(frame*width*height,(frame+1)*width*height);let white=0;for(let y=height-168;y<height-48;y++)for(let x=48;x<width-48;x++)if(bytes[y*width+x]>150)white++;counts.push(white);}
  assert.equal(counts[0],0);assert.equal(counts[5],0);for(const count of counts.slice(1,5))assert.ok(count>200);
  const pcmArgs=['-vn','-ac','1','-ar','48000','-c:a','pcm_s16le','-f','s16le'];
  const audio=async (file: string)=>(await exec('ffmpeg',['-v','error','-i',file,...pcmArgs,'pipe:1'],{encoding:'buffer',maxBuffer:1024*1024,timeout:30000})).stdout;
  assert.deepEqual(await audio(captioned),await audio(plain),'subtitles preserve PCM/AAC continuity');
  if(referenceAudio)assert.deepEqual(await audio(captioned),referenceAudio);else referenceAudio=await audio(captioned);
  assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')),false);
 }
});


test('cancelled subtitle measurement joins the child and removes staged files before publication',async t=>{
 const root=await temp(t),file=path.join(root,'audio.wav');await writeFile(file,wav());
 const asset={id:randomUUID(),mimeType:'audio/wav',path:file,width:0,height:0,duration:2,hasVideo:false,hasAudio:true,audioStreamIndex:0},saved=timeline(asset,720,1280);saved.subtitles={profileId:profile.profileId,cues:[{id:randomUUID(),text:'取消字幕渲染',startFrame:0,durationFrames:60}]};
 const controller=new AbortController(),events: MediaProcessEvent[]=[],off=onMediaProcess(e=>{events.push(e);if(e.type==='started'&&e.kind==='ffmpeg'&&events.filter(event=>event.type==='started').length===2)controller.abort();});
 try{await assert.rejects(renderTimeline({timeline:saved,subtitleProfile:profile} as unknown as Parameters<typeof renderTimeline>[0],new Map([[asset.id,asset]]),path.join(root,'out.mp4'),{signal:controller.signal}),{code:'MEDIA_CANCELLED'});}finally{off();}
 assert.equal(events.filter(e=>e.type==='started').length,2);assert.equal(events.filter(e=>e.type==='exited').length,2);assert.deepEqual((await readdir(root)).sort(),['audio.wav']);
});


test('old and empty-cue exports still render when the bundled font directory is absent',async t=>{
 const root=await temp(t),file=path.join(root,'audio.wav');await writeFile(file,wav());initializeSubtitleResources(path.join(root,'missing-resources'));
 const asset={id:randomUUID(),mimeType:'audio/wav',path:file,width:0,height:0,duration:2,hasVideo:false,hasAudio:true,audioStreamIndex:0},saved=timeline(asset,720,720),assets=new Map([[asset.id,asset]]);
 await renderTimeline({timeline:saved} as unknown as Parameters<typeof renderTimeline>[0],assets,path.join(root,'old.mp4'));saved.subtitles={profileId:profile.profileId,cues:[]};await renderTimeline({timeline:saved} as unknown as Parameters<typeof renderTimeline>[0],assets,path.join(root,'empty.mp4'));
 saved.subtitles.cues.push({id:randomUUID(),text:'需要字体',startFrame:0,durationFrames:60});const events: unknown[]=[],off=onMediaProcess(e=>events.push(e));
 try{await assert.rejects(renderTimeline({timeline:saved,subtitleProfile:profile} as unknown as Parameters<typeof renderTimeline>[0],assets,path.join(root,'missing.mp4')),{code:'SUBTITLE_RESOURCE_UNAVAILABLE'});}finally{off();}
 assert.deepEqual((events as unknown),[]);assert.equal((await readdir(root)).includes('missing.mp4'),false);assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')),false);
});
