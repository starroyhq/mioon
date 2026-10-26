import type {TimelineMixedColourPlanClip} from '../packages/contracts/src/timeline-colour.ts';
type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
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
 for(const alter of ([(x: { source: { interpretation: string; }; })=>x.source.interpretation='display-p3',(x: { source: { evidence: { bitDepth: number; }; }; })=>x.source.evidence.bitDepth=16,(x: { source: { evidence: { orientation: number; }; }; })=>x.source.evidence.orientation=6,(x: { source: { evidence: { colourTag: string; }; }; })=>x.source.evidence.colourTag='icc',(x: { source: { assetSha256: string; }; })=>x.source.assetSha256='b'.repeat(64),(x: { source: { evidence: { width: number; }; }; })=>x.source.evidence.width=4097,(x: { source: { foo: boolean; }; })=>x.source.foo=true] as const)){const x=structuredClone(image);alter(((((x) as unknown as Parameters<typeof alter>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof alter>>[0]>));assert.equal(clipColourSchema.safeParse(x).success,false);}
});
test('mixed plan freezes file evidence, display policy, table hash and alpha/resize semantics',()=>{
 const f=fixture(),plan=createTimelineColourPlan(f.timeline,f.assets);assert.equal((plan)!.profileId,'mioon-mixed-sdr-render-v2');assert.ok(timelineMixedColourPlanSchema.safeParse(plan).success);assert.equal(timelineColourPlanSchema.safeParse(plan).success,false);
 assert.equal(((plan)!.clips[0] as unknown as {algorithmSha256:(string)}).algorithmSha256,TIMELINE_IMAGE_TABLE_SHA256);assert.deepEqual(((plan)!.clips[0] as Extract<TimelineMixedColourPlanClip,{kind:'image'}>).referenceDisplay,{eotf:'bt1886-zero-black',gamma:2.4,black:0,white:1,luminance:'relative',primaries:'bt709',whitePoint:'D65'});
 const snapshot={...f,colourPlan:plan};assert.ok(isTimelineColourSnapshot(snapshot));
 for(const alter of ([(x: { colourPlan: { clips: { algorithmSha256: string; }[]; }; })=>x.colourPlan.clips[0].algorithmSha256='b'.repeat(64),(x: { colourPlan: { clips: { referenceDisplay: { gamma: number; }; }[]; }; })=>x.colourPlan.clips[0].referenceDisplay.gamma=2.2,(x: { colourPlan: { clips: { evidence: { width: number; }; }[]; }; })=>x.colourPlan.clips[0].evidence.width++,(x: { colourPlan: { clips: { alpha: string; }[]; }; })=>x.colourPlan.clips[0].alpha='straight',(x: { colourPlan: unknown; })=>delete x.colourPlan] as const)){const x=structuredClone(snapshot);alter(((((x) as unknown as Parameters<typeof alter>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof alter>>[0]>));assert.equal(isTimelineColourSnapshot(x),false);}
});
test('admission never silently upgrades legacy images or accepts other image MIME',()=>{
 const f=fixture();delete (f.timeline.clips[0] as {colour?: unknown}).colour;assert.equal(createTimelineColourPlan(f.timeline,f.assets),undefined);
 f.timeline.clips[0].colour=colour();for(const mime of (['image/jpeg','image/webp'] as const)){f.assets[0].mimeType=mime;assert.throws(()=>createTimelineColourPlan(f.timeline,f.assets),{code:'INVALID_TIMELINE_COLOUR'});}
 f.assets[0].mimeType='image/png';f.timeline.clips[0].colour.source=(null as unknown as (((((typeof f)["timeline"])["clips"])[number])["colour"])["source"]);assert.throws(()=>createTimelineColourPlan(f.timeline,f.assets));
});
test('mixed video members retain source-v1 and video-only snapshots stay byte-identical v1',()=>{
 const f=fixture(),image=f.timeline.clips[0],videoAsset={id:randomUUID(),sha256:'b'.repeat(64),mimeType:'video/mp4'},video={...image,id:randomUUID(),assetId:videoAsset.id,colour:{profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:videoAsset.sha256,streamIndex:2,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look:null}};
 f.assets.push(videoAsset);f.timeline.clips.push(((video) as unknown as Parameters<typeof f.timeline.clips.push>[0]));const mixed=createTimelineColourPlan(f.timeline,f.assets);assert.equal(((mixed)!.clips[1] as Extract<TimelineMixedColourPlanClip,{kind:'video'}>).kind,'video');assert.equal(((mixed)!.clips[1] as Extract<TimelineMixedColourPlanClip,{kind:'video'}>).sourceProfileId,'rec709-yuv-sdr-v1');
 const old=createTimelineColourPlan({...f.timeline,clips:[video]},[videoAsset]);assert.equal((old)!.profileId,'mioon-rec709-sdr-render-v1');assert.equal(Object.hasOwn((old)!.clips[0],'kind'),false);assert.equal(Object.hasOwn((old)!.clips[0],'sourceProfileId'),false);
});
test('image inspection is separate bounded read-only operation and binds actual evidence to request',()=>{
 const input={projectId:randomUUID(),assetId:randomUUID()},response={...input,assetSha256:sha,kind:'image',evidence:evidence(),status:'needs_interpretation'};
 assert.deepEqual(parse('timeline.colour.image.inspect',input),input);assert.ok(isTimelineImageSourceInspection(response,input));assert.equal(isTimelineImageSourceInspection({...response,assetSha256:'b'.repeat(64)},input),false);assert.equal(isTimelineImageSourceInspection({...response,status:'compatible'},input),false);
 const effect=operationEffect('timeline.colour.image.inspect');assert.equal(effect.readOnly,true);assert.equal(effect.fileWrite,false);assert.equal(effect.databaseWrite,false);assert.equal(effect.localProcess,false);assert.equal(effect.externalIO,false);
});
