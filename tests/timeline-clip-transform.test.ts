





import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
 CLIP_TRANSFORM_PROFILE,canonicalClipTransform,clipTransformAt,clipTransformFieldsAfterEdit,clipTransformGeometry,isIdentityClipTransform,
 projectedClipGeometry,splitClipTransformFields,validateClipTransform,type ClipTransform,type ClipTransformKeyframe,
} from '../packages/contracts/src/timeline-clip-transform.ts';
import {CLIP_LAYOUT_PROFILE,isClipLayoutRect,projectClipLayout} from '../packages/contracts/src/timeline-clip-layout.ts';
import {timelineOutputPreset} from '../packages/contracts/src/timeline-output-geometry.ts';
import {isTimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {isTimelineMutationResponse} from '../packages/contracts/src/timeline-acknowledgement.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';






type Rec=Record<string,any>;
const crop={left:0,top:0,right:0,bottom:0};
const make=(keyframes: ClipTransformKeyframe[],patch: Partial<ClipTransform>={}): ClipTransform=>({profileId:CLIP_TRANSFORM_PROFILE,keyframes,rotation:0,crop,...patch});
const zoom=make([{frame:10,x:-100,y:20,scale:0.5},{frame:50,x:100,y:-20,scale:1.5}]);
const invalid=(error: unknown)=>(error as {code?: unknown}).code==='INVALID_CLIP_TRANSFORM';

test('transform values are validated exactly and never normalized',()=>{
 assert.equal(validateClipTransform(zoom,60),zoom);
 assert.equal(validateClipTransform(null,60),null);
 for(const [label,value] of [
  ['profile',{...zoom,profileId:'other'}],['no keyframe',make([])],['17 keyframes',make(Array.from({length:17},(_,frame)=>({frame,x:0,y:0,scale:1})))],
  ['unordered',make([{frame:20,x:0,y:0,scale:1},{frame:10,x:0,y:0,scale:1}])],['repeated frame',make([{frame:5,x:0,y:0,scale:1},{frame:5,x:1,y:0,scale:1}])],
  ['past the end',make([{frame:61,x:0,y:0,scale:1}])],['small scale',make([{frame:0,x:0,y:0,scale:0.04}])],['large scale',make([{frame:0,x:0,y:0,scale:8.5}])],
  ['far offset',make([{frame:0,x:8193,y:0,scale:1}])],['negative zero',make([{frame:0,x:-0,y:0,scale:1}])],['fractional frame',make([{frame:1.5,x:0,y:0,scale:1}])],
  ['rotation',make([{frame:0,x:0,y:0,scale:1}],{rotation:181})],['crop sum',make([{frame:0,x:0,y:0,scale:1}],{crop:{left:0.5,top:0,right:0.5,bottom:0}})],
  ['crop key',make([{frame:0,x:0,y:0,scale:1}],{crop:{left:0,top:0,right:0} as never})],['extra key',{...zoom,opacity:1}],
  ['extra keyframe key',make([{frame:0,x:0,y:0,scale:1,z:0} as never])],
 ] as const)assert.throws(()=>validateClipTransform(value,60),invalid,label);
 assert.throws(()=>validateClipTransform(zoom,0),invalid,'clip duration');
});

test('keyframes hold outside their range and change linearly between them',()=>{
 const clip={durationFrames:60,transform:zoom};
 assert.deepEqual(clipTransformAt(clip,0),{x:-100,y:20,scale:0.5});
 assert.deepEqual(clipTransformAt(clip,30),{x:0,y:0,scale:1});
 assert.deepEqual(clipTransformAt(clip,59),{x:100,y:-20,scale:1.5});
 assert.deepEqual(clipTransformAt({durationFrames:60},30),{x:0,y:0,scale:1});
 assert.equal(isIdentityClipTransform(make([{frame:0,x:0,y:0,scale:1}])),true);
 assert.equal(isIdentityClipTransform(make([{frame:0,x:0,y:0,scale:1}],{rotation:1})),false);
 assert.deepEqual(Object.keys(canonicalClipTransform({crop:{bottom:0,right:0,top:0,left:0},rotation:0,keyframes:[{scale:1,y:0,x:0,frame:0}],profileId:CLIP_TRANSFORM_PROFILE} as never)!),
  ['profileId','keyframes','rotation','crop']);
});

test('splits keep every frame of the animation on both parts',()=>{
 for(const cut of [5,10,30,50,55]){
  const clip={durationFrames:60,transform:zoom},[left,right]=splitClipTransformFields(clip,cut);
  for(let frame=0;frame<60;frame++){
   const part=frame<cut?{durationFrames:cut,...left}:{durationFrames:60-cut,...right};
   // Re-interpolating at the cut may differ from the original by float rounding only.
   const actual=clipTransformAt(part as never,frame<cut?frame:frame-cut),expected=clipTransformAt(clip,frame);
   for(const key of ['x','y','scale'] as const)assert.ok(Math.abs(actual[key]-expected[key])<1e-9,`cut ${cut}, frame ${frame}, ${key}`);
  }
  assert.ok(left.transform!.keyframes.length<=3&&right.transform!.keyframes.length<=3,`cut ${cut} adds at most the interpolated point`);
 }
 assert.deepEqual(splitClipTransformFields({durationFrames:60},30),[{},{}]);
 assert.deepEqual(splitClipTransformFields({durationFrames:60,transform:null},30),[{transform:null},{transform:null}]);
});

test('trims keep clip-local keyframe times and a shrink cuts at the new end',()=>{
 const clip={durationFrames:60,transform:zoom};
 const shrunk=clipTransformFieldsAfterEdit(clip,{durationFrames:30}).transform!;
 assert.deepEqual(shrunk.keyframes,[{frame:10,x:-100,y:20,scale:0.5},{frame:30,x:0,y:0,scale:1}]);
 assert.deepEqual(clipTransformFieldsAfterEdit(clip,{durationFrames:90}).transform!.keyframes,zoom.keyframes,'an extension holds the last value');
 assert.deepEqual(clipTransformFieldsAfterEdit(clip,{}).transform,zoom);
 assert.deepEqual(clipTransformFieldsAfterEdit({durationFrames:60},{durationFrames:10}),{});
});

test('the geometry crops, fits, scales and offsets around the rectangle centre',()=>{
 const clip={durationFrames:60,rect:{x:100,y:0,width:400,height:300},transform:make([{frame:0,x:20,y:-10,scale:2}],{rotation:-30,crop:{left:0.25,top:0,right:0.25,bottom:0}})};
 // A 200x100 source cropped to 100x100 fits the 400x300 rectangle as 300x300.
 assert.deepEqual(clipTransformGeometry(clip,{width:200,height:100},0),{centerX:320,centerY:140,width:600,height:600,rotation:-30});
});

test('the saved 720 basis survives a 1080 round trip and projects every keyframe without clipping its offset',()=>{
 const basis=timelineOutputPreset('portrait_720')!, wide=timelineOutputPreset('landscape_1080')!, ultrawide=timelineOutputPreset('ultrawide_1080')!;
 const layout={profileId:CLIP_LAYOUT_PROFILE,basisPresetId:basis.id};
 const clip={layout,durationFrames:60,rect:{x:14,y:312,width:376,height:642},
  transform:make([{frame:0,x:8192,y:-20,scale:1.2},{frame:60,x:-8192,y:100,scale:1.6}])};
 const bytes=JSON.stringify(clip), original=projectClipLayout(clip,basis), projected=projectClipLayout(clip,wide);
 assert.deepEqual(original.rect,clip.rect);
 assert.deepEqual(original.transform!.keyframes,clip.transform.keyframes);
 assert.equal(projected.transform!.keyframes[0]!.x,8192*(1920/720));
 assert.equal(projected.transform!.keyframes[1]!.y,100*(1080/1280));
 assert.deepEqual(projectClipLayout(clip,ultrawide).transform!.keyframes.map(({x})=>x),[28672,-28672]);
 const mid=projectedClipGeometry(projected.rect,projected.transform,{width:1920,height:1080},30);
 assert.equal(mid.centerX,projected.rect.x+projected.rect.width/2);
 assert.equal(mid.centerY,projected.rect.y+projected.rect.height/2+40*(1080/1280));
 assert.deepEqual(projectClipLayout(clip,basis),original);
 assert.equal(JSON.stringify(clip),bytes);
 for(const invalidLayout of [null,undefined,{...layout,mode:'fill'},{...layout,profileId:'future'},{...layout,basisPresetId:'unknown'}]){
  assert.equal(isClipLayoutRect({...clip,layout:invalidLayout},wide),false);
 }
 assert.equal(isClipLayoutRect({...clip,rect:{...clip.rect,width:718}},wide),false,'only the original basis can bound stored coordinates');
});

test('an anamorphic source fits by its display size with black space left on either side of the fitted axis',()=>{
 const frame=timelineOutputPreset('portrait_1080')!;
 const clip={durationFrames:60,rect:{x:0,y:0,width:frame.width,height:frame.height},
  layout:{profileId:CLIP_LAYOUT_PROFILE,basisPresetId:frame.id}};
 const placed=projectClipLayout(clip,frame);
 const square=projectedClipGeometry(placed.rect,null,{width:1920,height:1080},0);
 assert.deepEqual(square,{centerX:540,centerY:960,width:1080,height:607.5,rotation:0});
 const anamorphic=projectedClipGeometry(placed.rect,null,{width:1920,height:1080,sampleAspectRatio:2},0);
 assert.equal(anamorphic.height,303.75);
 // Frozen definitions only. G exposes no fill or keep-pixels write.
 const fill=Math.max(frame.width/1920,frame.height/1080);
 assert.equal(1080*fill,1920);
 assert.ok(Math.abs(1920*fill-3413.3333333333335)<1e-9);
 const keepPixels={width:1920,height:1080};
 assert.deepEqual([(keepPixels.width-frame.width)/2,(frame.height-keepPixels.height)/2],[420,420]);
});

async function fixture(t: test.TestContext,opener:typeof openStore=openStore){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-clip-transform-')));
 let store=opener(root) as unknown as {db: import('node:sqlite').DatabaseSync;put(table: string,value: Rec): Rec;close(): void};
 let services=createServices(store as never,new Map()) as unknown as {call(operation: string,input: unknown): Promise<Rec>};
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const project=await services.call('project.create',{name:'Transforms'}),projectId=project.id as string;
 const asset=(mimeType: string)=>store.put('assets',{id:randomUUID(),projectId,name:mimeType,mimeType,duration:10,width:640,height:360,hasAudio:mimeType!=='image/png',hasVideo:mimeType!=='audio/wav',
  provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${randomUUID()}.fixture`,createdAt:new Date().toISOString()});
 let timeline=await services.call('timeline.get',{projectId});
 const f={root,projectId,asset,get timeline(){return timeline;},get store(){return store;},
  input:(fields: Rec)=>({projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...fields}),
  async raw(operation: string,input: Rec){const response=await services.call(operation,input);timeline=response.timeline??response;return response;},
  call(operation: string,fields: Rec={}){return f.raw(operation,f.input(fields));},
  inspect:()=>services.call('timeline.inspect',{projectId}),
  async reopen(){store.close();store=opener(root) as never;services=createServices(store as never,new Map()) as never;timeline=await services.call('timeline.get',{projectId});},
 };
 return f;
}
const notApplied=(code: string)=>(error: Rec)=>error.code===code&&error.details?.mutationOutcome==='not_applied'&&error.details?.operation==='timeline.clip.setTransform';

test('the timeline reader distinguishes a saved basis from legacy coordinates and keeps its strict clip shape',async t=>{
 const f=await fixture(t),video=f.timeline.tracks.find((track: Rec)=>track.kind==='video');
 await f.call('timeline.clip.add',{trackId:video.id,assetId:f.asset('video/mp4').id,startFrame:0,durationFrames:60});
 const old=f.timeline, saved=old.clips[0], basis=timelineOutputPreset('landscape_1080')!;
 const rect={x:1600,y:0,width:320,height:600}, layout={profileId:CLIP_LAYOUT_PROFILE,basisPresetId:basis.id};
 const record=(clip:Rec)=>({...old,clips:[clip]});
 assert.equal(isTimelineRecord(old),true);
 assert.equal(isTimelineRecord(record({...saved,rect})),false,'the legacy clip uses the current, narrower frame');
 const based=record({...saved,rect,layout,transform:make([{frame:0,x:8192,y:0,scale:1}])});
 assert.equal(isTimelineRecord(based),true);
 assert.equal(isTimelineRecord(record({...based.clips[0],layout:{...layout,basisPresetId:'portrait_1080'}})),false);
 assert.equal(isTimelineRecord(record({...based.clips[0],rect:{...rect,x:1601}})),false);
 assert.equal(isTimelineRecord(record({...based.clips[0],layout:{...layout,extra:0}})),false);
});

test('setTransform saves one edit, replays exactly, undoes and clears',async t=>{
 const f=await fixture(t),video=f.timeline.tracks.find((track: Rec)=>track.kind==='video');
 await f.call('timeline.clip.add',{trackId:video.id,assetId:f.asset('video/mp4').id,startFrame:0,durationFrames:60});
 const clipId=f.timeline.clips[0].id,revision=f.timeline.revision,input=f.input({clipId,transform:zoom});
 const response=await f.raw('timeline.clip.setTransform',input);
 assert.deepEqual(Object.keys(response).sort(),['clipId','operation','previousTransform','requestId','timeline','transform']);
 assert.deepEqual([response.operation,response.clipId,response.previousTransform,response.timeline.revision],['timeline.clip.setTransform',clipId,null,revision+1]);
 assert.deepEqual(response.transform,zoom);assert.deepEqual(response.timeline.clips[0].transform,zoom);
 assert.equal(isTimelineMutationResponse('timeline.clip.setTransform',input,response),true);
 assert.deepEqual(await f.raw('timeline.clip.setTransform',input),response,'exact replay');
 assert.deepEqual((await f.inspect()).clips[0].transform,{keyframes:zoom.keyframes,rotation:0,crop},'Mio reads the transform');
 await f.call('timeline.undo');assert.equal(Object.hasOwn(f.timeline.clips[0],'transform'),false,'undo removes it');
 await f.call('timeline.redo');assert.deepEqual(f.timeline.clips[0].transform,zoom,'redo restores it');
 const cleared=await f.call('timeline.clip.setTransform',{clipId,transform:null});
 assert.deepEqual([cleared.previousTransform,cleared.transform,Object.hasOwn(f.timeline.clips[0],'transform')],[zoom,null,false]);
});

test('setTransform refuses before writing and proves it',async t=>{
 const f=await fixture(t),video=f.timeline.tracks.find((track: Rec)=>track.kind==='video'),audio=f.timeline.tracks.find((track: Rec)=>track.kind==='audio');
 await f.call('timeline.clip.add',{trackId:video.id,assetId:f.asset('video/mp4').id,startFrame:0,durationFrames:60});
 await f.call('timeline.clip.add',{trackId:audio.id,assetId:f.asset('audio/wav').id,startFrame:0,durationFrames:60});
 const [visual,sound]=f.timeline.clips,before=structuredClone(f.timeline);
 await f.call('timeline.clip.setTransform',{clipId:visual.id,transform:zoom});
 for(const [code,fields] of [
  ['CLIP_TRANSFORM_UNCHANGED',{clipId:visual.id,transform:zoom}],
  ['CLIP_TRANSFORM_INVALID',{clipId:visual.id,transform:make([{frame:61,x:0,y:0,scale:1}])}],
  ['CLIP_TRANSFORM_UNSUPPORTED',{clipId:sound.id,transform:zoom}],
  ['CLIP_NOT_FOUND',{clipId:randomUUID(),transform:zoom}],
 ] as const){
  const revision=f.timeline.revision;
  await assert.rejects(f.call('timeline.clip.setTransform',fields),notApplied(code),code);
  assert.equal((await f.raw('timeline.get',{projectId:f.projectId})).revision,revision,`${code} writes nothing`);
 }
 await assert.rejects(f.raw('timeline.clip.setTransform',{...f.input({clipId:visual.id,transform:null}),expectedRevision:before.revision}),notApplied('REVISION_CONFLICT'));
});

test('split, shrink and move carry the transform with the clip',async t=>{
 const f=await fixture(t),video=f.timeline.tracks.find((track: Rec)=>track.kind==='video');
 await f.call('timeline.clip.add',{trackId:video.id,assetId:f.asset('video/mp4').id,startFrame:0,durationFrames:60});
 const clipId=f.timeline.clips[0].id;
 await f.call('timeline.clip.setTransform',{clipId,transform:zoom});
 await f.call('timeline.clip.split',{clipId,atFrame:30});
 const [left,right]=[...f.timeline.clips].sort((a: Rec,b: Rec)=>a.startFrame-b.startFrame);
 assert.deepEqual(left.transform.keyframes,[{frame:10,x:-100,y:20,scale:0.5},{frame:30,x:0,y:0,scale:1}]);
 assert.deepEqual(right.transform.keyframes,[{frame:0,x:0,y:0,scale:1},{frame:20,x:100,y:-20,scale:1.5}]);
 await f.call('timeline.clip.update',{clipId:right.id,patch:{durationFrames:10}});
 assert.deepEqual(f.timeline.clips.find((clip: Rec)=>clip.id===right.id).transform.keyframes,[{frame:0,x:0,y:0,scale:1},{frame:10,x:50,y:-10,scale:1.25}]);
 await f.call('timeline.clip.update',{clipId:left.id,patch:{startFrame:100}});
 assert.deepEqual(f.timeline.clips.find((clip: Rec)=>clip.id===left.id).transform,left.transform,'a move keeps clip-local keyframes');
});
