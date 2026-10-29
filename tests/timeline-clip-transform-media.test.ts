import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {clipTransformGeometry,CLIP_TRANSFORM_PROFILE,type ClipTransform} from '../packages/contracts/src/timeline-clip-transform.ts';

// Real FFmpeg acceptance of the shared preview/export renderer with a known
// pattern: a white 16:9 film on black. Each checked frame's bright bounding box
// must match the transform model within a few pixels (H.264 and the even
// layer sizes round edges). Splits, trims, moves and segment boundaries inside
// a clip must not move the content.
const exec=promisify(execFile);
type Rec=Record<string,any>;
const SIZE=720,TOLERANCE=4;
const identityCrop={left:0,top:0,right:0,bottom:0};
const transform=(keyframes: ClipTransform['keyframes'],patch: Partial<ClipTransform>={}): ClipTransform=>({profileId:CLIP_TRANSFORM_PROFILE,keyframes,rotation:0,crop:identityCrop,...patch});

async function fixture(t: test.TestContext){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-transform-media-')));
 const store=openStore(root),services=createServices(store as never,new Map()) as unknown as {call(operation: string,input: unknown): Promise<Rec>;drain?(): Promise<void>};
 t.after(async()=>{await services.drain?.();store.close();rmSync(root,{recursive:true,force:true});});
 const ffmpeg=(args: string[])=>exec('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{maxBuffer:64*1024*1024,timeout:120_000});
 await ffmpeg(['-f','lavfi','-i','color=c=white:s=160x90:r=30:d=6','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','1',path.join(root,'white.mp4')]);
 await ffmpeg(['-f','lavfi','-i','color=c=0x401010:s=64x64:r=30:d=1','-frames:v','1',path.join(root,'dark.png')]);
 const project=await services.call('project.create',{name:'Transform acceptance'});
 await services.call('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:'square_720'});
 let timeline=await services.call('timeline.get',{projectId:project.id});
 const call=async(operation: string,fields: Rec)=>{
  const response=await services.call(operation,{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...fields});
  timeline=response.timeline??response;return response;
 };
 const assets=new Map<string,Rec>();
 for(const [name,mimeType] of [['white.mp4','video/mp4'],['dark.png','image/png']]){
  const asset=await services.call('asset.import',{projectId:project.id,name,mimeType,dataBase64:readFileSync(path.join(root,name)).toString('base64')});
  assets.set(name,{...asset,path:path.join(root,name)});
 }
 const videoTracks=()=>timeline.tracks.filter((track: Rec)=>track.kind==='video');
 async function render(label: string){
  const file=path.join(root,`${label}.mp4`);
  await renderTimeline({timeline} as never,new Map([...assets.values()].map(asset=>[asset.id,asset])) as never,file);
  const {stdout}=await exec('ffmpeg',['-v','error','-i',file,'-fps_mode','passthrough','-vf','format=gray','-f','rawvideo','-'],{encoding:'buffer',maxBuffer:256*1024*1024,timeout:120_000});
  return (frame: number)=>{
   const offset=frame*SIZE*SIZE;let x0=SIZE,y0=SIZE,x1=-1,y1=-1;
   assert.ok(offset+SIZE*SIZE<=stdout.length,`${label} has frame ${frame}`);
   for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++)if(stdout[offset+y*SIZE+x]!>128){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
   return x1<0?null:{x0,y0,x1:x1+1,y1:y1+1};
  };
 }
 return {project,assets,videoTracks,call,render,get timeline(){return timeline;}};
}
/** The model's axis-aligned box of a clip's content at a timeline frame. */
function modelBox(clip: Rec,frame: number){
 const g=clipTransformGeometry(clip as never,{width:160,height:90},frame-clip.startFrame),r=g.rotation*Math.PI/180;
 const w=Math.abs(g.width*Math.cos(r))+Math.abs(g.height*Math.sin(r)),h=Math.abs(g.width*Math.sin(r))+Math.abs(g.height*Math.cos(r));
 return {x0:g.centerX-w/2,y0:g.centerY-h/2,x1:g.centerX+w/2,y1:g.centerY+h/2};
}
function near(actual: {x0:number;y0:number;x1:number;y1:number}|null,clip: Rec,frame: number,label: string,tolerance=TOLERANCE){
 const expected=modelBox(clip,frame),visible={x0:Math.max(0,expected.x0),y0:Math.max(0,expected.y0),x1:Math.min(SIZE,expected.x1),y1:Math.min(SIZE,expected.y1)};
 assert.ok(actual,`${label}: frame ${frame} shows the clip`);
 for(const edge of ['x0','y0','x1','y1'] as const)assert.ok(Math.abs(actual![edge]-visible[edge])<=tolerance,`${label}: frame ${frame} ${edge} ${actual![edge]} vs model ${visible[edge].toFixed(1)}`);
}
const clipNamed=(timeline: Rec,name: string)=>timeline.clips.find((clip: Rec)=>clip.name===name);

test('transformed clips render where the model puts them through splits, trims, moves, rotation and crop',{timeout:600_000},async t=>{
 const f=await fixture(t),[main,upper]=f.videoTracks();
 await f.call('timeline.clip.add',{trackId:main.id,assetId:f.assets.get('white.mp4')!.id,name:'A',startFrame:0,durationFrames:120,sourceInFrame:0});
 // A dark still elsewhere puts segment boundaries inside A at frames 45 and 55.
 if(!upper)await f.call('timeline.track.add',{kind:'video'});
 await f.call('timeline.clip.add',{trackId:f.videoTracks()[1].id,assetId:f.assets.get('dark.png')!.id,name:'Dark',startFrame:45,durationFrames:10,rect:{x:0,y:0,width:64,height:64}});
 const a=clipNamed(f.timeline,'A');
 await f.call('timeline.clip.setTransform',{clipId:a.id,transform:transform([{frame:10,x:-150,y:-100,scale:0.4},{frame:100,x:150,y:120,scale:0.8}])});
 const first=await f.render('animated'),frames=[0,10,30,44,45,50,55,70,100,119];
 for(const frame of frames)near(first(frame),clipNamed(f.timeline,'A'),frame,'animated');

 await f.call('timeline.clip.split',{clipId:a.id,atFrame:60});
 const split=await f.render('split'),[left,right]=f.timeline.clips.filter((clip: Rec)=>clip.name==='A').sort((x: Rec,y: Rec)=>x.startFrame-y.startFrame);
 for(const frame of frames){
  const before=first(frame)!,after=split(frame)!;
  for(const edge of ['x0','y0','x1','y1'] as const)assert.ok(Math.abs(before[edge]-after[edge])<=2,`split keeps frame ${frame} ${edge}: ${before[edge]} vs ${after[edge]}`);
  near(after,frame<60?left:right,frame,'split');
 }

 // A head trim keeps clip-local keyframe times; a move keeps them too.
 await f.call('timeline.clip.update',{clipId:right.id,patch:{startFrame:80,sourceInFrame:right.sourceInFrame+20,durationFrames:40}});
 await f.call('timeline.clip.update',{clipId:left.id,patch:{startFrame:10}});
 const moved=await f.render('moved'),[movedLeft,trimmed]=f.timeline.clips.filter((clip: Rec)=>clip.name==='A').sort((x: Rec,y: Rec)=>x.startFrame-y.startFrame);
 assert.deepEqual([movedLeft.startFrame,trimmed.startFrame,trimmed.durationFrames],[10,80,40]);
 for(const frame of [10,40,54,69])near(moved(frame),movedLeft,frame,'moved');
 for(const frame of [80,100,119])near(moved(frame),trimmed,frame,'trimmed');
 assert.equal(moved(5),null,'nothing before the moved clip');

 // Static rotation and crop on the trimmed part: the rotated box's bounds.
 await f.call('timeline.clip.setTransform',{clipId:trimmed.id,transform:transform([{frame:0,x:0,y:0,scale:0.5}],{rotation:30,crop:{left:0.25,top:0,right:0.25,bottom:0}})});
 const rotated=await f.render('rotated'),turned=f.timeline.clips.find((clip: Rec)=>clip.id===trimmed.id);
 // The cropped 80x90 source fits the square by height (640x720), then halves.
 const g=clipTransformGeometry(turned,{width:160,height:90},0);
 assert.deepEqual([Math.round(g.width),Math.round(g.height)],[320,360]);
 for(const frame of [80,119])near(rotated(frame),turned,frame,'rotated',6);
});
