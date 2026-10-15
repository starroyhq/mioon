import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {pillowJfifFixture,jpegSegment} from './helpers/timeline-jpeg-fixtures.mjs';
import {jpegColour} from './helpers/timeline-jpeg-workflow-fixtures.mjs';
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'mioon-jpeg-business-'));let store=openStore(root),services=createServices(store,new Map());t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});const call=(op,input)=>services.call(op,input),projectId=(await call('project.create',{name:'JFIF JPEG mixed colour'})).id;return{root,projectId,call,get store(){return store;},async reopen(){await services.drain();store.close();store=openStore(root);services=createServices(store,new Map());},params:(timeline,extra={})=>({projectId,requestId:randomUUID(),expectedRevision:timeline.revision,...extra}),import:bytes=>call('asset.import',{projectId,name:'source.jpg',mimeType:'image/jpeg',dataBase64:bytes.toString('base64')})};}
test('actual JFIF JPEG import/inspect/save/replay and reopen preserve explicit mixed profile',async t=>{
 const f=await fixture(t),asset=await f.import(pillowJfifFixture('444')),inspection=await f.call('timeline.colour.jpeg.inspect',{projectId:f.projectId,assetId:asset.id});assert.equal(inspection.status,'needs_interpretation');
 let timeline=await f.call('timeline.get',{projectId:f.projectId});const request=f.params(timeline,{trackId:timeline.tracks[0].id,assetId:asset.id,startFrame:0,durationFrames:6,colour:jpegColour(inspection.evidence)});timeline=await f.call('timeline.clip.add',request);assert.deepEqual(await f.call('timeline.clip.add',request),timeline);
 assert.equal(createTimelineColourPlan(timeline,[asset]).profileId,'mioon-mixed-sdr-render-v3');await f.reopen();assert.deepEqual((await f.call('timeline.get',{projectId:f.projectId})).clips[0].colour,jpegColour(inspection.evidence));
});
test('JFIF JPEG replacement invalidates evidence, preserves look, and undo/redo restore exact intent',async t=>{
 const f=await fixture(t),a=await f.import(pillowJfifFixture('420')),b=await f.import(pillowJfifFixture('422')),inspected=await f.call('timeline.colour.jpeg.inspect',{projectId:f.projectId,assetId:a.id});let timeline=await f.call('timeline.get',{projectId:f.projectId});
 const colour=jpegColour(inspected.evidence);timeline=await f.call('timeline.clip.add',f.params(timeline,{trackId:timeline.tracks[0].id,assetId:a.id,startFrame:0,durationFrames:6,colour}));const clipId=timeline.clips[0].id;
 timeline=await f.call('timeline.clip.replaceSource',f.params(timeline,{clipId,assetId:b.id}));assert.deepEqual(timeline.clips[0].colour,{...colour,source:null});assert.throws(()=>createTimelineColourPlan(timeline,[b]),{code:'INVALID_TIMELINE_COLOUR'});
 timeline=await f.call('timeline.undo',f.params(timeline));assert.deepEqual(timeline.clips[0].colour,colour);timeline=await f.call('timeline.redo',f.params(timeline));assert.equal(timeline.clips[0].colour.source,null);
});
test('ordinary image interpretation cannot grant video, foreign asset or changed SHA authority',async t=>{
 const f=await fixture(t),asset=await f.import(pillowJfifFixture('420')),inspected=await f.call('timeline.colour.jpeg.inspect',{projectId:f.projectId,assetId:asset.id}),timeline=await f.call('timeline.get',{projectId:f.projectId}),colour=jpegColour(inspected.evidence);
 const bad=structuredClone(colour);bad.source.assetSha256='b'.repeat(64);bad.source.evidence.sha256=bad.source.assetSha256;await assert.rejects(f.call('timeline.clip.add',f.params(timeline,{trackId:timeline.tracks[0].id,assetId:asset.id,startFrame:0,durationFrames:6,colour:bad})),{code:'TIMELINE_COLOUR_SOURCE_MISMATCH'});
 await assert.rejects(f.call('timeline.colour.jpeg.inspect',{projectId:randomUUID(),assetId:asset.id}),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
});

test('JPEG checks are distinct from PNG and cannot silently strip EXIF/ICC',async t=>{
 const f=await fixture(t),bytes=pillowJfifFixture('444'),asset=await f.import(bytes);
 await assert.rejects(f.call('timeline.colour.image.inspect',{projectId:f.projectId,assetId:asset.id}),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
 for(const marker of [0xe1,0xe2,0xee]){
  const altered=Buffer.concat([bytes.subarray(0,20),jpegSegment(marker,Buffer.from('Exif\0\0')),bytes.subarray(20)]);
  const unsupported=await f.import(altered);
  await assert.rejects(f.call('timeline.colour.jpeg.inspect',{projectId:f.projectId,assetId:unsupported.id}),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
 }
});
