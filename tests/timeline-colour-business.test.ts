import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import type {ServiceResponse as FixtureServiceResult, TypedStore as FixtureStore, TypedServices as FixtureServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {schemaObjects} from './helpers/project-database.ts';
const stamp='2026-10-14T00:00:00.000Z';
const cube='LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
const domain=(timeline: FixtureTimeline)=>({tracks:timeline.tracks,clips:timeline.clips,durationFrames:timeline.durationFrames});
const clone=<T>(value: T): T => JSON.parse(JSON.stringify(value));
async function fixture(t: test.TestContext){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-colour-business-'));let store=(openStore(root) as FixtureStore),services=(createServices(store,new Map()) as FixtureServices);
 t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 const call=<O extends string>(operation: O, input?: unknown) => services.call(operation,input) as Promise<FixtureServiceResult<O>>,projectId=(await call('project.create',{name:'Colour fixture'})).id;
 const asset=(patch: Record<string, unknown>={})=>{const id=randomUUID();return store.put('assets',{id,projectId,name:'Owned source',mimeType:'video/mp4',duration:10,width:720,height:1280,hasVideo:true,hasAudio:true,
   provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${id}.fixture`,createdAt:stamp,...patch});};
 const lut=(owner: unknown=projectId)=>call('lut.import',{projectId:owner,requestId:randomUUID(),name:'Creative.cube',dataBase64:Buffer.from(cube).toString('base64')});
 const colour=(source: { sha256: unknown; },resource?: { id: unknown; sha256: unknown; profile: unknown; })=>({profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:source.sha256,streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},
  look:resource?{resourceId:resource.id,resourceSha256:resource.sha256,resourceProfile:resource.profile,purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:.35}:null});
 const params=<P extends Record<string,unknown>=Record<never,never>>(timeline: { revision: number; },extra: P={} as P):P & {projectId:string;expectedRevision:number;requestId:string}=>({projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...extra});
 const capture=()=>Object.fromEntries(['timelines','timeline_history','timeline_history_cursors','timeline_requests'].map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
 const add=(timeline: FixtureTimeline,source: { id: unknown; },extra: Record<string, unknown>={})=>call('timeline.clip.add',params(timeline,{assetId:source.id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:60,...extra}));
 return {root,get store(){return store;},get services(){return services;},async restart(){await services.drain();store.close();store=(openStore(root) as FixtureStore);services=(createServices(store,new Map()) as FixtureServices);},call,projectId,asset,lut,colour,params,capture,add,timeline:await call('timeline.get',{projectId})};
}
test('add/update persist exact colour, replay preserves it and ordinary edits do not drop it',async t=>{
 const f=await fixture(t),asset=f.asset(),resource=(await f.lut()).resource,colour=f.colour(asset,resource);
 const added=await f.add(f.timeline,asset,{colour});assert.deepEqual(added.clips[0].colour,colour);
 const request=f.params(added,{clipId:added.clips[0].id,patch:{name:'Retitled',gain:.75}}),updated=await f.call('timeline.clip.update',request);
 assert.deepEqual(updated.clips[0].colour,colour);assert.deepEqual(await f.call('timeline.clip.update',request),updated);
 assert.deepEqual(f.store.get('timelines',added.id)!.clips[0].colour,colour);
 const cleared=await f.call('timeline.clip.update',f.params(updated,{clipId:updated.clips[0].id,patch:{colour:null}}));assert.equal((cleared.clips[0].colour as unknown),null);
 const undo=await f.call('timeline.undo',f.params(cleared));assert.deepEqual(undo.clips[0].colour,colour);
 await f.restart();assert.deepEqual((await f.call('timeline.get',{projectId:f.projectId})).clips[0].colour,colour);assert.deepEqual(await f.call('timeline.clip.update',request),updated);
});
test('replacement invalidates source only, undo restores exact source and redo retains independent creative look',async t=>{
 const f=await fixture(t),old=f.asset(),next=f.asset({sha256:'b'.repeat(64)}),colour=f.colour(old,(await f.lut()).resource);
 let timeline=await f.add(f.timeline,old,{colour});const before=clone(timeline),input=f.params(timeline,{clipId:timeline.clips[0].id,assetId:next.id});
 timeline=await f.call('timeline.clip.replaceSource',input);const replacement=clone(timeline);
 assert.deepEqual(timeline.clips[0].colour,{...colour,source:null});assert.equal(timeline.clips[0].assetId,next.id);
 assert.deepEqual(await f.call('timeline.clip.replaceSource',input),timeline);
 timeline=await f.call('timeline.undo',f.params(timeline));assert.deepEqual(domain(timeline),domain(before));
 timeline=await f.call('timeline.redo',f.params(timeline));assert.deepEqual(domain(timeline),domain(replacement));
 const reconfirmed={...colour,source:{...colour.source,assetSha256:next.sha256}};
 timeline=await f.call('timeline.clip.update',f.params(timeline,{clipId:timeline.clips[0].id,patch:{colour:reconfirmed}}));assert.deepEqual(timeline.clips[0].colour,reconfirmed);
});
test('split copies complete source and look exactly, history restores every field',async t=>{
 const f=await fixture(t),asset=f.asset(),colour=f.colour(asset,(await f.lut()).resource),before=await f.add(f.timeline,asset,{colour});
 const split=await f.call('timeline.clip.split',f.params(before,{clipId:before.clips[0].id,atFrame:30}));assert.equal(split.clips.length,2);
 for(const clip of split.clips)assert.deepEqual(clip.colour,colour);
 const undo=await f.call('timeline.undo',f.params(split));assert.deepEqual(domain(undo),domain(before));
 const redo=await f.call('timeline.redo',f.params(undo));assert.deepEqual(domain(redo),domain(split));
});
test('wrong source SHA and wrong owned LUT SHA/owner reject atomically before commit',async t=>{
 // Another project lives in a store of its own: its LUT does not exist in this one.
 const f=await fixture(t),g=await fixture(t),asset=f.asset(),resource=(await f.lut()).resource,foreign=(await g.lut()).resource,base=await f.add(f.timeline,asset),colour=f.colour(asset,resource);
 for(const [patch,code] of ([[{...colour,source:{...colour.source,assetSha256:'c'.repeat(64)}},'TIMELINE_COLOUR_SOURCE_MISMATCH'],
   [{...colour,look:{...colour.look,resourceSha256:'c'.repeat(64)}},'TIMELINE_COLOUR_LOOK_UNAVAILABLE'],
   [f.colour(asset,foreign),'TIMELINE_COLOUR_LOOK_UNAVAILABLE']] as const)){
  const before=f.capture(),request=f.params(base,{clipId:base.clips[0].id,patch:{colour:patch}});
  await assert.rejects(f.call('timeline.clip.update',request),error=>{assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code,code);assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details?.mutationOutcome,'not_applied');return true;});assert.deepEqual(f.capture(),before);
 }
});
test('audio and images cannot receive a managed declaration but legacy/null remains accepted',async t=>{
 const f=await fixture(t);
 for(const mimeType of (['image/png','audio/wav'] as const)){
  const source=f.asset({mimeType,hasVideo:mimeType.startsWith('image/'),hasAudio:mimeType.startsWith('audio/')});
  const trackId=(f.timeline.tracks.find((track)=>track.kind===(mimeType.startsWith('audio/')?'audio':'video')))!.id,before=f.capture();
  await assert.rejects(f.add(f.timeline,source,{trackId,colour:f.colour(source)}),{code:'TIMELINE_COLOUR_SOURCE_MISMATCH'});assert.deepEqual(f.capture(),before);
 }
 const image=f.asset({mimeType:'image/png',hasAudio:false});const legacy=await f.add(f.timeline,image);assert.equal(Object.hasOwn(legacy.clips[0],'colour'),false);
 const disabled=await f.call('timeline.clip.update',f.params(legacy,{clipId:legacy.clips[0].id,patch:{colour:null}}));assert.equal((disabled.clips[0].colour as unknown),null);
});
test('corrupt historical colour cannot be applied by undo, and no saved colour is silently removed',async t=>{
 const f=await fixture(t),asset=f.asset(),colour=f.colour(asset,(await f.lut()).resource),base=await f.add(f.timeline,asset,{colour});
 const changed=await f.call('timeline.clip.update',f.params(base,{clipId:base.clips[0].id,patch:{name:'Updated'}}));
 const entry=f.store.db.prepare('SELECT id,beforeSnapshot FROM timeline_history ORDER BY position DESC LIMIT 1').get(),saved=JSON.parse((((entry)!.beforeSnapshot) as unknown as Parameters<typeof JSON.parse>[0]));saved.clips[0].colour.source.assetSha256='c'.repeat(64);
 // Restore the guard into the database that held it: an unqualified CREATE TRIGGER would go to main.
 const trigger=schemaObjects(f.store.db).find(({type,name})=>type==='trigger'&&name==='immutable_timeline_history')!;f.store.db.exec('DROP TRIGGER immutable_timeline_history');
 f.store.db.prepare('UPDATE timeline_history SET beforeSnapshot=? WHERE id=?').run(JSON.stringify(saved),(entry)!.id);f.store.db.exec(trigger.sql!.replace(/^CREATE TRIGGER /u,`CREATE TRIGGER "${trigger.schema}".`));const before=f.capture();
 await assert.rejects(f.call('timeline.undo',f.params(changed)),{code:'INVALID_TIMELINE_SNAPSHOT'});assert.deepEqual(f.capture(),before);assert.deepEqual(f.store.get('timelines',base.id)!.clips[0].colour,colour);
});

test('real service inspection observes tagged SDR and refuses HDR without changing saved media or SQLite',async t=>{
 const f=await fixture(t);
 for(const [transfer,status] of ([['bt709','compatible'],['smpte2084','unsupported']] as const)){
  const file=path.join(f.root,transfer+'.mp4');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=red:s=64x64:r=30','-t','0.1','-threads','1','-c:v','libx264','-pix_fmt','yuv420p',
   '-color_primaries','bt709','-color_trc',transfer,'-colorspace','bt709','-color_range','tv','-x264-params',`colorprim=bt709:transfer=${transfer}:colormatrix=bt709`,file],{timeout:15000,stdio:'pipe'});
  const asset=await f.call('asset.import',{projectId:f.projectId,name:transfer+'.mp4',mimeType:'video/mp4',dataBase64:(await readFile(file)).toString('base64')});
  const source=path.join(f.root,f.store.get('assets',asset.id)!.relativePath),bytes=await readFile(source),before=f.capture(),changes=(f.store.db.prepare('SELECT total_changes() AS n').get())!.n;
  const result=await f.call('timeline.colour.source.inspect',{projectId:f.projectId,assetId:asset.id});
  assert.equal(result.status,status,JSON.stringify(result));assert.equal(result.assetSha256,asset.sha256);assert.equal(result.evidence.transfer,transfer);assert.equal(result.evidence.pixelFormat,'yuv420p');
  assert.deepEqual(await readFile(source),bytes);assert.deepEqual(f.capture(),before);assert.equal((f.store.db.prepare('SELECT total_changes() AS n').get())!.n,changes);
 }
});
