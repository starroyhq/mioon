import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parse,operationEffect} from '@mioon/contracts';
import {clipColourSchema,timelineClipColourSchema,timelineColourPlanSchema,timelineMixedColourPlanSchema,createTimelineColourPlan,isTimelineColourSnapshot,isTimelineImageSourceInspection,TIMELINE_IMAGE_TABLE_SHA256} from '../packages/contracts/src/timeline-colour.ts';
const stamp='2026-10-15T00:00:00.000Z',sha='a'.repeat(64);
const evidence=()=>({profileId:'png-rgb8-srgb-v1',sha256:sha,sourceByteLength:123,width:17,height:19,bitDepth:8,alphaMode:'straight',orientation:1,colourTag:'untagged'});
const colour=()=>({profileId:'mioon-srgb-image-clip-v1',source:{assetSha256:sha,profileId:'png-rgb8-srgb-v1',interpretation:'srgb',declaredBy:'user',declaredAt:stamp,evidence:evidence()},look:null});
function fixture(){const asset={id:randomUUID(),sha256:sha,mimeType:'image/png'},track={id:randomUUID(),kind:'video',hidden:false},clip={id:randomUUID(),assetId:asset.id,trackId:track.id,startFrame:0,durationFrames:30,colour:colour()};return{timeline:{tracks:[track],clips:[clip]},assets:[asset]};}
test('new image profile is explicit and historical video schemas remain closed',()=>{
 const image=colour();assert.ok(clipColourSchema.safeParse(image).success);assert.equal(timelineClipColourSchema.safeParse(image).success,false);
 for(const alter of [x=>x.source.interpretation='display-p3',x=>x.source.evidence.bitDepth=16,x=>x.source.evidence.orientation=6,x=>x.source.evidence.colourTag='icc',x=>x.source.assetSha256='b'.repeat(64),x=>x.source.evidence.width=4097,x=>x.source.foo=true]){const x=structuredClone(image);alter(x);assert.equal(clipColourSchema.safeParse(x).success,false);}
});
test('mixed plan freezes file evidence, display policy, table hash and alpha/resize semantics',()=>{
 const f=fixture(),plan=createTimelineColourPlan(f.timeline,f.assets);assert.equal(plan.profileId,'mioon-mixed-sdr-render-v2');assert.ok(timelineMixedColourPlanSchema.safeParse(plan).success);assert.equal(timelineColourPlanSchema.safeParse(plan).success,false);
 assert.equal(plan.clips[0].algorithmSha256,TIMELINE_IMAGE_TABLE_SHA256);assert.deepEqual(plan.clips[0].referenceDisplay,{eotf:'bt1886-zero-black',gamma:2.4,black:0,white:1,luminance:'relative',primaries:'bt709',whitePoint:'D65'});
 const snapshot={...f,colourPlan:plan};assert.ok(isTimelineColourSnapshot(snapshot));
 for(const alter of [x=>x.colourPlan.clips[0].algorithmSha256='b'.repeat(64),x=>x.colourPlan.clips[0].referenceDisplay.gamma=2.2,x=>x.colourPlan.clips[0].evidence.width++,x=>x.colourPlan.clips[0].alpha='straight',x=>delete x.colourPlan]){const x=structuredClone(snapshot);alter(x);assert.equal(isTimelineColourSnapshot(x),false);}
});
test('admission never silently upgrades legacy images or accepts other image MIME',()=>{
 const f=fixture();delete f.timeline.clips[0].colour;assert.equal(createTimelineColourPlan(f.timeline,f.assets),undefined);
 f.timeline.clips[0].colour=colour();for(const mime of ['image/jpeg','image/webp']){f.assets[0].mimeType=mime;assert.throws(()=>createTimelineColourPlan(f.timeline,f.assets),{code:'INVALID_TIMELINE_COLOUR'});}
 f.assets[0].mimeType='image/png';f.timeline.clips[0].colour.source=null;assert.throws(()=>createTimelineColourPlan(f.timeline,f.assets));
});
test('mixed video members retain source-v1 and video-only snapshots stay byte-identical v1',()=>{
 const f=fixture(),image=f.timeline.clips[0],videoAsset={id:randomUUID(),sha256:'b'.repeat(64),mimeType:'video/mp4'},video={...image,id:randomUUID(),assetId:videoAsset.id,colour:{profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:videoAsset.sha256,streamIndex:2,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look:null}};
 f.assets.push(videoAsset);f.timeline.clips.push(video);const mixed=createTimelineColourPlan(f.timeline,f.assets);assert.equal(mixed.clips[1].kind,'video');assert.equal(mixed.clips[1].sourceProfileId,'rec709-yuv-sdr-v1');
 const old=createTimelineColourPlan({...f.timeline,clips:[video]},[videoAsset]);assert.equal(old.profileId,'mioon-rec709-sdr-render-v1');assert.equal(Object.hasOwn(old.clips[0],'kind'),false);assert.equal(Object.hasOwn(old.clips[0],'sourceProfileId'),false);
});
test('image inspection is separate bounded read-only operation and binds actual evidence to request',()=>{
 const input={projectId:randomUUID(),assetId:randomUUID()},response={...input,assetSha256:sha,kind:'image',evidence:evidence(),status:'needs_interpretation'};
 assert.deepEqual(parse('timeline.colour.image.inspect',input),input);assert.ok(isTimelineImageSourceInspection(response,input));assert.equal(isTimelineImageSourceInspection({...response,assetSha256:'b'.repeat(64)},input),false);assert.equal(isTimelineImageSourceInspection({...response,status:'compatible'},input),false);
 const effect=operationEffect('timeline.colour.image.inspect');assert.equal(effect.readOnly,true);assert.equal(effect.fileWrite,false);assert.equal(effect.databaseWrite,false);assert.equal(effect.localProcess,false);assert.equal(effect.externalIO,false);
});
