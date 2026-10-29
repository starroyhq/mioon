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
import {CLIP_TRANSITION_PROFILE,type ClipTransitionKind} from '../packages/contracts/src/timeline-clip-transition.ts';
import {CLIP_TRANSFORM_PROFILE} from '../packages/contracts/src/timeline-clip-transform.ts';

// Real FFmpeg acceptance of the shared preview/export renderer. Red and blue
// clips alternate in a centred 360x360 rectangle on the upper track over a
// green bottom track; every cut carries another transition. A sample inside the
// rectangle follows the transition's model; a sample outside must stay green,
// so no transition touches the layers below. The bottom track is cut five
// frames after each cut, so each transition also crosses a segment boundary.
const exec=promisify(execFile);
type Rec=Record<string,any>;
const SIZE=720,SCALE=4,SIDE=SIZE/SCALE,D=20;
const rect={x:180,y:180,width:360,height:360};
const transition=(kind: ClipTransitionKind,durationFrames=D)=>({profileId:CLIP_TRANSITION_PROFILE,kind,durationFrames});

async function fixture(t: test.TestContext){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-transition-media-')));
 const store=openStore(root),services=createServices(store as never,new Map()) as unknown as {call(operation: string,input: unknown): Promise<Rec>;drain?(): Promise<void>};
 t.after(async()=>{await services.drain?.();store.close();rmSync(root,{recursive:true,force:true});});
 const ffmpeg=(args: string[])=>exec('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{maxBuffer:64*1024*1024,timeout:120_000});
 // The red film sounds a 440 Hz tone; the blue film is silent.
 await ffmpeg(['-f','lavfi','-i','color=c=red:s=160x160:r=30:d=6','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=6','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','1','-c:a','aac','-shortest',path.join(root,'red.mp4')]);
 await ffmpeg(['-f','lavfi','-i','color=c=blue:s=160x160:r=30:d=6','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','1',path.join(root,'blue.mp4')]);
 await ffmpeg(['-f','lavfi','-i','color=c=blue:s=64x64:r=30:d=1','-frames:v','1',path.join(root,'blue.png')]);
 await ffmpeg(['-f','lavfi','-i','color=c=green:s=64x64:r=30:d=1','-frames:v','1',path.join(root,'green.png')]);
 const project=await services.call('project.create',{name:'Transition acceptance'});
 await services.call('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:'square_720'});
 let timeline=await services.call('timeline.get',{projectId:project.id});
 const call=async(operation: string,fields: Rec)=>{
  const response=await services.call(operation,{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...fields});
  timeline=response.timeline??response;return response;
 };
 const assets=new Map<string,Rec>();
 for(const [name,mimeType] of [['red.mp4','video/mp4'],['blue.mp4','video/mp4'],['blue.png','image/png'],['green.png','image/png']]){
  const asset=await services.call('asset.import',{projectId:project.id,name,mimeType,dataBase64:readFileSync(path.join(root,name)).toString('base64')});
  assets.set(name,{...asset,path:path.join(root,name)});
 }
 const [bottom,top]=timeline.tracks.filter((track: Rec)=>track.kind==='video').sort((a: Rec,b: Rec)=>a.orderIndex-b.orderIndex);
 async function render(label: string){
  const file=path.join(root,`${label}.mp4`);
  await renderTimeline({timeline} as never,new Map([...assets.values()].map(asset=>[asset.id,asset])) as never,file);
  const {stdout:video}=await exec('ffmpeg',['-v','error','-i',file,'-fps_mode','passthrough','-vf',`scale=${SIDE}:${SIDE}:flags=area`,'-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer',maxBuffer:256*1024*1024,timeout:120_000});
  const {stdout:sound}=await exec('ffmpeg',['-v','error','-i',file,'-f','s16le','-ac','1','-ar','48000','-'],{encoding:'buffer',maxBuffer:256*1024*1024,timeout:120_000});
  const pixel=(frame: number,x: number,y: number)=>{
   const offset=(frame*SIDE*SIDE+Math.floor(y/SCALE)*SIDE+Math.floor(x/SCALE))*3;
   assert.ok(offset+3<=video.length,`${label} has frame ${frame}`);
   return [video[offset]!,video[offset+1]!,video[offset+2]!];
  };
  // Root mean square level of the frames [from, to).
  const level=(from: number,to: number)=>{let sum=0,count=0;for(let index=from*1600;index<to*1600;index++){const value=sound.readInt16LE(index*2)/32768;sum+=value*value;count++;}return Math.sqrt(sum/count);};
  return {pixel,level};
 }
 return {assets,bottom,top,call,render,get timeline(){return timeline;}};
}
type Colour=number[];
const mix=(a: Colour,b: Colour,share: number)=>a.map((value,index)=>value*(1-share)+b[index]!*share);
function close(actual: Colour,expected: Colour,tolerance: number,label: string){
 assert.ok(actual.every((value,index)=>Math.abs(value-expected[index]!)<=tolerance),`${label}: ${actual.join(',')} vs ${expected.map(value=>value.toFixed(0)).join(',')}`);
}

test('each transition kind renders its model inside the rectangle and leaves lower layers alone',{timeout:600_000},async t=>{
 const f=await fixture(t),red=f.assets.get('red.mp4')!.id,blue=f.assets.get('blue.mp4')!.id,still=f.assets.get('blue.png')!.id,green=f.assets.get('green.png')!.id;
 const cuts: [string,ClipTransitionKind|null][]=[[red,null],[blue,'dissolve'],[red,'dipToBlack'],[still,'wipeLeft'],[red,'wipeRight'],[blue,'pushLeft'],[red,'pushRight']];
 const ids: string[]=[];
 for(const [index,[assetId]] of cuts.entries()){
  const response=await f.call('timeline.clip.add',{trackId:f.top.id,assetId,name:`C${index}`,startFrame:index*40,durationFrames:40,sourceInFrame:assetId===still?0:20,rect});
  ids.push(response.clips?.find((clip: Rec)=>clip.name===`C${index}`)?.id??f.timeline.clips.find((clip: Rec)=>clip.name===`C${index}`).id);
 }
 for(let index=0;index<7;index++){
  const startFrame=index?index*40+5:0,endFrame=index<6?(index+1)*40+5:280;
  await f.call('timeline.clip.add',{trackId:f.bottom.id,assetId:green,name:`G${index}`,startFrame,durationFrames:endFrame-startFrame,sourceInFrame:0});
 }
 for(const [index,[,kind]] of cuts.entries())if(kind)await f.call('timeline.clip.setTransition',{clipId:ids[index],transition:transition(kind)});
 const {pixel,level}=await f.render('kinds');
 const GREEN=pixel(20,50,50);
 for(const [index,[,kind]] of cuts.entries()){
  if(!kind)continue;
  const cut=index*40,start=cut-D/2,before=pixel(start-1,360,360),after=pixel(start+D,360,360);
  for(const k of [0,4,8,12,16,19]){
   const frame=start+k,p=k/D,label=`${kind} k=${k}`;
   close(pixel(frame,50,50),GREEN,12,`${label} outside`);
   if(kind==='dissolve')close(pixel(frame,360,360),mix(before,after,p),14,label);
   if(kind==='dipToBlack')close(pixel(frame,360,360),k<D/2?before.map(value=>value*(1-k/(D/2))):after.map(value=>value*((k-D/2)/(D/2))),30,label);
   if(kind==='wipeLeft'||kind==='wipeRight')for(const x of [200,520]){
    const incoming=kind==='wipeLeft'?x>=SIZE*(1-p):x<SIZE*p;
    close(pixel(frame,x,360),incoming?after:before,14,`${label} x=${x}`);
   }
   if(kind==='pushLeft'||kind==='pushRight'){
    const shift=SIZE*p*(kind==='pushLeft'?-1:1),incomingShift=kind==='pushLeft'?SIZE*(1-p):-SIZE*(1-p);
    const covers=(left: number)=>left<=360&&360<left+rect.width;
    close(pixel(frame,360,360),covers(rect.x+shift)?before:covers(rect.x+incomingShift)?after:GREEN,14,label);
   }
  }
 }
 // Pictures cross the cut; sound does not: the red clip's tone stops at its
 // own end and starts at its own start, though its picture reaches further.
 assert.ok(level(32,38)>0.02&&level(42,48)<0.003,`tone ends at the cut: ${level(32,38)} then ${level(42,48)}`);
 assert.ok(level(72,78)<0.003&&level(82,88)>0.02,`tone starts at the cut: ${level(72,78)} then ${level(82,88)}`);
});

test('a push moves transformed content with its transform',{timeout:600_000},async t=>{
 const f=await fixture(t),red=f.assets.get('red.mp4')!.id,blue=f.assets.get('blue.mp4')!.id,green=f.assets.get('green.png')!.id;
 await f.call('timeline.clip.add',{trackId:f.bottom.id,assetId:green,name:'G',startFrame:0,durationFrames:80,sourceInFrame:0});
 await f.call('timeline.clip.add',{trackId:f.top.id,assetId:red,name:'A',startFrame:0,durationFrames:40,sourceInFrame:20,rect});
 await f.call('timeline.clip.add',{trackId:f.top.id,assetId:blue,name:'B',startFrame:40,durationFrames:40,sourceInFrame:20,rect});
 const b=f.timeline.clips.find((clip: Rec)=>clip.name==='B');
 // B shows a 180x180 picture centred in the rectangle, 90 pixels right of it.
 await f.call('timeline.clip.setTransform',{clipId:b.id,transform:{profileId:CLIP_TRANSFORM_PROFILE,keyframes:[{frame:0,x:90,y:0,scale:0.5}],rotation:0,crop:{left:0,top:0,right:0,bottom:0}}});
 await f.call('timeline.clip.setTransition',{clipId:b.id,transition:transition('pushLeft')});
 const {pixel}=await f.render('push-transform'),GREEN=pixel(10,50,50),RED=pixel(20,360,360),BLUE=pixel(70,450,360);
 for(const k of [0,6,12,18]){
  const frame=30+k,p=k/D,left=SIZE*(1-p)+360+90-90;
  for(const x of [300,420,500])close(pixel(frame,x,360),x>=left+6&&x<left+180-6?BLUE:x>=rect.x-SIZE*p+6&&x<rect.x+rect.width-SIZE*p-6?RED:GREEN,14,`k=${k} x=${x}`);
 }
});
