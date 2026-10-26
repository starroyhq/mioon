import type {ServiceResponse as FixtureServiceResult, TypedStore as FixtureStore, TypedServices as FixtureServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {png,pngChunk,imageColour} from './helpers/timeline-image-fixtures.ts';
async function fixture(t: test.TestContext){const root=await mkdtemp(path.join(tmpdir(),'mioon-image-business-'));let store=(openStore(root) as FixtureStore),services=(createServices(store,new Map()) as FixtureServices);t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});const call=<O extends string>(op: O, input?: unknown) => services.call(op,input) as Promise<FixtureServiceResult<O>>,projectId=(await call('project.create',{name:'PNG mixed colour'})).id;return{root,projectId,call,get store(){return store;},async reopen(){await services.drain();store.close();store=(openStore(root) as FixtureStore);services=(createServices(store,new Map()) as FixtureServices);},params:<P extends Record<string,unknown>=Record<never,never>>(timeline: { revision: number; },extra: P={} as P):P & {projectId:string;expectedRevision:number;requestId:string}=>({projectId,requestId:randomUUID(),expectedRevision:timeline.revision,...extra}),import:(bytes: { toString: (arg0: string) => unknown; })=>call('asset.import',{projectId,name:'source.png',mimeType:'image/png',dataBase64:bytes.toString('base64')})};}
test('actual PNG import/inspect/save/replay and reopen preserve explicit mixed profile',async t=>{
 const f=await fixture(t),asset=await f.import(((png({tagged:false})) as unknown as Parameters<typeof f.import>[0])),inspection=await f.call('timeline.colour.image.inspect',{projectId:f.projectId,assetId:asset.id});assert.equal(inspection.status,'needs_interpretation');
 let timeline=await f.call('timeline.get',{projectId:f.projectId});const request=f.params(timeline,{trackId:timeline.tracks[0].id,assetId:asset.id,startFrame:0,durationFrames:6,colour:imageColour(inspection.evidence)});timeline=await f.call('timeline.clip.add',request);assert.deepEqual(await f.call('timeline.clip.add',request),timeline);
 assert.equal((createTimelineColourPlan(timeline,[asset]))!.profileId,'mioon-mixed-sdr-render-v2');await f.reopen();assert.deepEqual((await f.call('timeline.get',{projectId:f.projectId})).clips[0].colour,imageColour(inspection.evidence));
});
test('PNG replacement invalidates evidence, preserves look, and undo/redo restore exact intent',async t=>{
 const f=await fixture(t),a=await f.import(((png()) as unknown as Parameters<typeof f.import>[0])),b=await f.import(((png({pixel:()=>[255,0,0,128]})) as unknown as Parameters<typeof f.import>[0])),inspected=await f.call('timeline.colour.image.inspect',{projectId:f.projectId,assetId:a.id});let timeline=await f.call('timeline.get',{projectId:f.projectId});
 const colour=imageColour(inspected.evidence);timeline=await f.call('timeline.clip.add',f.params(timeline,{trackId:timeline.tracks[0].id,assetId:a.id,startFrame:0,durationFrames:6,colour}));const clipId=timeline.clips[0].id;
 timeline=await f.call('timeline.clip.replaceSource',f.params(timeline,{clipId,assetId:b.id}));assert.deepEqual(timeline.clips[0].colour,{...colour,source:null});assert.throws(()=>createTimelineColourPlan(timeline,[b]),{code:'INVALID_TIMELINE_COLOUR'});
 timeline=await f.call('timeline.undo',f.params(timeline));assert.deepEqual(timeline.clips[0].colour,colour);timeline=await f.call('timeline.redo',f.params(timeline));assert.equal(((timeline.clips[0].colour)!.source as unknown),null);
});
test('ordinary image interpretation cannot grant video, foreign asset or changed SHA authority',async t=>{
 const f=await fixture(t),asset=await f.import(((png()) as unknown as Parameters<typeof f.import>[0])),inspected=await f.call('timeline.colour.image.inspect',{projectId:f.projectId,assetId:asset.id}),timeline=await f.call('timeline.get',{projectId:f.projectId}),colour=imageColour(inspected.evidence);
 const bad=structuredClone(colour);bad.source.assetSha256='b'.repeat(64);(bad.source.evidence as {sha256: string}).sha256=bad.source.assetSha256;await assert.rejects(f.call('timeline.clip.add',f.params(timeline,{trackId:timeline.tracks[0].id,assetId:asset.id,startFrame:0,durationFrames:6,colour:bad})),{code:'TIMELINE_COLOUR_SOURCE_MISMATCH'});
 await assert.rejects(f.call('timeline.colour.image.inspect',{projectId:randomUUID(),assetId:asset.id}),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
});
