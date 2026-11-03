import {validateTimelineOpacityRows as validateAll} from '../packages/business/src/timeline-retained-opacity.ts';
import {validateTimelineColourRows as validateRows} from '../packages/business/src/timeline-retained-colour.ts';
import {lexerDatabase,snapshot,publicAsset} from './helpers/current-retained-fixture.ts';

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';

import {DatabaseSync} from 'node:sqlite';

import {projectTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {parseCube3D} from '../packages/business/src/cube-lut.ts';
import {lutInputHash} from '../packages/business/src/lut-resource-validation.ts';
import type { BinaryLike } from 'crypto';

const hash=(bytes: Buffer<ArrayBuffer>|BinaryLike)=>createHash('sha256').update(bytes).digest('hex');
const stamp='2026-10-14T00:00:00.000Z';
const bytes=Buffer.from('synthetic owned source');
const cube=Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
function database(t: test.TestContext){return lexerDatabase(t);}

function seed(db: DatabaseSync,{history=true,render=true,colour=true}={}){
 const projectId=randomUUID(),assetId=randomUUID(),timelineId=randomUUID(),clipId=randomUUID(),trackId=randomUUID(),resourceId=randomUUID(),lutRequest=randomUUID();
 const project={id:projectId,name:'SDR workspace'};
 const asset={id:assetId,projectId,mimeType:'video/mp4',relativePath:`media/${assetId}.mp4`,sizeBytes:bytes.length,sha256:hash(bytes),duration:1,width:720,height:1280,hasAudio:false};
 db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify(project));
 db.prepare('INSERT INTO assets VALUES(?,?,?)').run(assetId,projectId,JSON.stringify(asset));
 db.prepare('INSERT INTO project_lut_resources VALUES(?,?,?,?,?,?,?,?,?)').run(resourceId,projectId,'look.cube',hash(cube),cube.length,'mioon-cube3d-normalized-tetrahedral-v1',JSON.stringify(parseCube3D(cube.toString()).metadata),cube,stamp);
 db.prepare('INSERT INTO lut_import_requests VALUES(?,?,?,?)').run(lutRequest,projectId,lutInputHash({projectId,requestId:lutRequest,name:'look.cube'},hash(cube),cube.length),resourceId);
 const declaration={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:asset.sha256,streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look:{resourceId,resourceSha256:hash(cube),resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:0.35}};
 const track={id:trackId,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false},legacyClip={id:clipId,assetId,trackId,name:'Clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1};
 const clip={...legacyClip,...(colour?{colour:declaration}:{})};
 const timeline={id:timelineId,projectId,revision:1,fps:30,width:720,height:1280,tracks:[track],clips:[clip],durationFrames:30,createdAt:stamp,updatedAt:stamp};
 db.prepare('INSERT INTO timelines VALUES(?,?,?)').run(timelineId,projectId,JSON.stringify(timeline));
 if(history){
  const before={tracks:[track],clips:[legacyClip],durationFrames:30},after={tracks:[track],clips:[clip],durationFrames:30};
  db.prepare('INSERT INTO timeline_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(),projectId,1,'timeline.clip.update',stamp,JSON.stringify(before),JSON.stringify(after));
  db.prepare('INSERT INTO timeline_history_cursors VALUES(?,?)').run(projectId,1);
 }
 let rendered;
 if(render){
  const frozen={timeline,assets:[asset].map(publicAsset)};const plan=projectTimelineColourPlan(frozen);if(plan)(frozen as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureSnapshot).colourPlan=plan;
  rendered={id:randomUUID(),projectId,requestId:randomUUID(),mode:'timeline',purpose:'preview',timelineRevision:1,snapshot:frozen,status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
  db.prepare('INSERT INTO exports VALUES(?,?,?)').run(rendered.id,projectId,JSON.stringify(rendered));
  db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(rendered.requestId,'a'.repeat(64),JSON.stringify(rendered));
 }
 assert.doesNotThrow(()=>validateRows(db));
 return {projectId,asset,timeline,declaration,rendered,resourceId};
}
function changeTimeline(db: DatabaseSync,change: (value:import('./helpers/strict-workspace-boundary-types.ts').MutableTimeline)=>void){const row=db.prepare('SELECT id,data FROM timelines LIMIT 1').get(),value=JSON.parse(((row!.data as string)));change(value);db.prepare('UPDATE timelines SET data=? WHERE id=?').run(JSON.stringify(value),row!.id);}
function rewrite(db: DatabaseSync,table: string,sql: string,value: string){
 db.prepare(sql).run(value);
}

for(const kind of ['unknown colour profile','invalid strength','source hash','missing resource','resource hash','resource owner','duplicate key'] as const)test(`current SDR rejects corrupt or stale ${kind}`,t=>{
 const db=database(t);seed(db,{history:false,render:false});
 if(kind==='duplicate key')db.exec(`UPDATE timelines SET data='{"colour":null,"colour":{}}'`);
 else changeTimeline(db,(value)=>{
  const colour=value.clips[0].colour;
  if(kind==='unknown colour profile')colour!.profileId='future-v2';
  if(kind==='invalid strength')colour!.look!.strength=2;
  if(kind==='source hash')colour!.source!.assetSha256='f'.repeat(64);
  if(kind==='missing resource')colour!.look!.resourceId=randomUUID();
  if(kind==='resource hash')colour!.look!.resourceSha256='f'.repeat(64);
  if(kind==='resource owner')value.projectId=randomUUID();
 });
 if(kind==='resource owner'){
  const row=db.prepare('SELECT projectId FROM timelines').get();const other=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(other,JSON.stringify({id:other}));
  rewrite(db,'project_lut_resources','UPDATE project_lut_resources SET projectId=?',other);
 }
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>validateRows(db),{code:'WORKSPACE_COLOUR_INVALID'});assert.throws(()=>validateAll(db));assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

for(const kind of ['missing plan','changed plan','extra plan field'] as const)test(`current SDR snapshot gate refuses ${kind}`,t=>{
 const db=database(t),f=seed(db,{history:false});const changed=structuredClone(f.rendered);
 if(kind==='missing plan')delete (changed!.snapshot as unknown as Record<PropertyKey,unknown>).colourPlan;
 if(kind==='changed plan')((changed!.snapshot as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureSnapshot).colourPlan!.clips[0] as unknown as {range:string}).range='full';
 if(kind==='extra plan field')((changed!.snapshot as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureSnapshot).colourPlan! as unknown as {future:boolean}).future=true;
 rewrite(db,'exports','UPDATE exports SET data=?',JSON.stringify(changed));
 assert.throws(()=>validateRows(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

test('null and invalidated source declarations persist exactly without becoming a render plan',t=>{
 const db=database(t),f=seed(db,{render:false});
 changeTimeline(db,(value)=>{value.clips[0].colour!.source=null;});assert.doesNotThrow(()=>validateRows(db));
 changeTimeline(db,(value)=>{value.clips[0].colour=null;});assert.doesNotThrow(()=>validateRows(db));
 assert.equal(JSON.parse(((db.prepare('SELECT data FROM timelines').get()!.data as string))).clips[0].colour,null);
 assert.equal(JSON.parse(((db.prepare('SELECT afterSnapshot FROM timeline_history').get()!.afterSnapshot as string))).clips[0].colour.look.strength,0.35);
});

for(const status of ['prepared','not_applied'] as const)test(`durable ${status} colour intent may retain an unknown LUT and stale source without granting accepted-source authority`,t=>{
 const db=database(t),f=seed(db,{render:false}),requestId=randomUUID();
 const colour=structuredClone(f.declaration);colour.look.resourceId=randomUUID();colour.look.resourceSha256='f'.repeat(64);colour.source.assetSha256='e'.repeat(64);
 const input=JSON.stringify({projectId:f.projectId,requestId,clipId:f.timeline.clips[0].id,expectedRevision:1,patch:{colour}});
 db.prepare('INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,errorCode,createdAt,updatedAt,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),f.projectId,'timeline.clip.update',input,requestId,hash(input),'timeline:mutation','new',status,status==='prepared'?1:3,0,status==='not_applied'?'LUT_NOT_FOUND':null,stamp,stamp,16384);
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.doesNotThrow(()=>validateRows(db));assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 assert.equal(db.prepare('SELECT input FROM edit_tasks').get()!.input,input);
});

for(const kind of ['audio track','image source'] as const)test(`accepted managed colour refuses ${kind}`,t=>{
 const db=database(t),f=seed(db,{history:false,render:false});
 if(kind==='audio track')changeTimeline(db,(value)=>{value.tracks[0].kind='audio';});
 else {const asset={...f.asset,mimeType:'image/png'};db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(asset),asset.id);}
 assert.throws(()=>validateRows(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

test('oversized JSON is refused before any JSON parser or traversal runs',async t=>{
 const db=database(t),projectId=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId}));
 db.prepare('INSERT INTO timelines VALUES(?,?,?)').run(randomUUID(),projectId,'x'.repeat(4*1024*1024+1));
 let parsed=false;db.function('json_valid',()=>{parsed=true;throw Error('unbounded JSON parse');});
 assert.throws(()=>validateRows(db),{code:'WORKSPACE_COLOUR_INVALID'});assert.equal(parsed,false);
});
