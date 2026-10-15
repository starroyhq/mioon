import {createHash} from 'node:crypto';
import {parseCube3D} from '../packages/business/src/cube-lut.ts';
import {lutInputHash} from '../packages/business/src/lut-resource-validation.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38,validateWorkspaceSchema38} from '../packages/business/src/workspace-schema-v38.ts';
import {initializeWorkspaceSchema40,validateWorkspaceSchema40} from '../packages/business/src/workspace-schema-v40.ts';
import {createWorkspaceRestoreProfileV39} from '../packages/business/src/workspace-restore-schema-v39.ts';
import {createWorkspaceRestoreProfileV41} from '../packages/business/src/workspace-restore-schema-v41.ts';
import {validateWorkspaceAudioRoleRows} from '../packages/business/src/workspace-audio-role-validation.ts';
import {validateWorkspaceColourRows} from '../packages/business/src/workspace-colour-validation.ts';
import {createTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {open,insert,snapshot as databaseSnapshot} from './workspace-schema26-fixtures.mjs';
const node=process.version;
assert.equal(node,'v24.21.0');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const stamp='2026-10-15T00:00:00.000Z',envelopeProfile='mioon-clip-linear-attenuation-v1';
const profile=createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24);
const oldProfile=createWorkspaceRestoreProfileV39(initializeWorkspaceSchemaThrough24);
const metadata=()=>({restorationId:id(901),workspaceOrigin:id(902),sourceBackupId:id(903),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:stamp});
function database(t,version=40){
 const db=open(':memory:');t.after(()=>db.close());
 for(const initialize of [initializeWorkspaceSchemaThrough24,initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,initializeWorkspaceSchema32,initializeWorkspaceSchema34,initializeWorkspaceSchema36,initializeWorkspaceSchema38])initialize(db);
 if(version===40)initializeWorkspaceSchema40(db);
 return db;
}
function receipt(feature,envelope=true){
 const asset={id:id(2),projectId:id(1),mimeType:'video/mp4',duration:1,width:720,height:1280,sha256:'a'.repeat(64),hasAudio:true};
 const clip={id:id(4),trackId:id(3),assetId:id(2),name:'Frozen clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1};
 if(envelope)clip.volumeEnvelope={profileId:envelopeProfile,points:[{frame:0,multiplier:1}]};
 if(feature==='audioRole')clip.audioRole='human';
 else clip.colour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:'a'.repeat(64),streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look:null};
 const timeline={id:id(5),projectId:id(1),revision:2,fps:30,width:720,height:1280,tracks:[{id:id(3),name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],clips:[clip],durationFrames:30,createdAt:stamp,updatedAt:stamp};
 const snapshot={timeline,assets:[asset],...(envelope?{volumeEnvelopeProfile:envelopeProfile}:{})};
 if(feature==='audioRole')snapshot.audioRoleProfile='mioon-clip-audio-role-v1';else snapshot.colourPlan=createTimelineColourPlan(timeline,snapshot.assets);
 return {id:id(6),projectId:id(1),requestId:'request-frozen-feature',mode:'timeline',purpose:'export',timelineRevision:2,snapshot,status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
}
function seed(db,value,table='timeline_requests',raw=JSON.stringify(value)){
 insert(db,'projects',{id:id(1),data:JSON.stringify({id:id(1)})});
 insert(db,'projects',{id:id(9),data:JSON.stringify({id:id(9)})});
 const asset=receipt('audioRole').snapshot.assets[0];
 insert(db,'assets',{id:asset.id,projectId:asset.projectId,data:JSON.stringify(asset)});
 if(table==='timeline_requests')insert(db,table,{requestId:'request-frozen-feature',requestHash:'a'.repeat(64),response:raw});
 else insert(db,table,{id:id(6),projectId:id(1),data:raw});
}
function changeCache(db,feature,extra={}){
 const asset=receipt(feature).snapshot.assets[0];
 db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...asset,mimeType:feature==='audioRole'?'image/png':'audio/wav',sha256:'b'.repeat(64),...extra}),asset.id);
}
const error=feature=>({code:feature==='audioRole'?'WORKSPACE_AUDIO_ROLE_INVALID':'WORKSPACE_COLOUR_INVALID'});
function legacyScan(db,feature){
 if(feature==='audioRole')validateWorkspaceAudioRoleRows(db,{allowAudioRoles:true});
 else validateWorkspaceColourRows(db,{allowColour:true,allowMixedImages:true,allowJpegImages:true});
}
for(const feature of ['audioRole','colour'])for(const table of ['timeline_requests','exports'])for(const envelope of [false,true])test(`${feature} ${table} envelope=${envelope}: frozen40/41 ignores current cache MIME/hash, retains raw bytes`,t=>{
 const db=database(t),value=receipt(feature,envelope);seed(db,value,table);validateWorkspaceSchema40(db);legacyScan(db,feature);
 changeCache(db,feature);const before=databaseSnapshot(db);
 assert.throws(()=>legacyScan(db,feature),error(feature));
 validateWorkspaceSchema40(db);assert.equal(profile.classifyWorkspaceSchemaV40V41(db).schemaVersion,40);assert.deepEqual(databaseSnapshot(db),before);
 profile.installWorkspaceRestoreSchemaV41(db,metadata());const restored=databaseSnapshot(db);
 profile.validateWorkspaceRestoreSchemaV41(db);assert.equal(profile.classifyWorkspaceSchemaV40V41(db).schemaVersion,41);assert.deepEqual(databaseSnapshot(db),restored);
 assert.equal(db.prepare(table==='exports'?'SELECT data AS raw FROM exports':'SELECT response AS raw FROM timeline_requests').get().raw,JSON.stringify(value));
});
for(const feature of ['audioRole','colour'])test(`${feature}: exact legacy38/39 outcomes and source38-to40 preflight remain unchanged`,t=>{
 for(const restored of [false,true]){
  const db=database(t,38);seed(db,receipt(feature,false));validateWorkspaceSchema38(db);oldProfile.classifyWorkspaceSchemaV38V39(db);
  if(restored)oldProfile.installWorkspaceRestoreSchemaV39(db,metadata());
  changeCache(db,feature);const before=databaseSnapshot(db);
  if(restored)assert.throws(()=>oldProfile.validateWorkspaceRestoreSchemaV39(db),error(feature));
  else {assert.throws(()=>validateWorkspaceSchema38(db),error(feature));assert.throws(()=>initializeWorkspaceSchema40(db),error(feature));}
  assert.throws(()=>oldProfile.classifyWorkspaceSchemaV38V39(db),error(feature));assert.deepEqual(databaseSnapshot(db),before);
 }
});
const mutations={
 'changed snapshot project':v=>{v.snapshot.timeline.projectId=id(9);},
 'changed frozen asset owner':v=>{v.snapshot.assets[0].projectId=id(9);},
 'changed frozen asset id':v=>{v.snapshot.assets[0].id=id(8);},
 'invalid frozen source hash':v=>{v.snapshot.assets[0].sha256='z'.repeat(64);},
 'changed envelope profile':v=>{v.snapshot.volumeEnvelopeProfile='forged';},
 'changed envelope point':v=>{v.snapshot.timeline.clips[0].volumeEnvelope.points[0].multiplier=2;},
 'missing asset metadata':v=>{delete v.snapshot.assets[0].duration;},
 'duplicate frozen asset':v=>{v.snapshot.assets.push({...v.snapshot.assets[0]});},
 'unreferenced frozen asset':v=>{v.snapshot.assets.push({...v.snapshot.assets[0],id:id(8)});},
 'forged snapshot extra key':v=>{v.snapshot.extra={audioRole:'human',assetId:id(2)};},
 'forged receipt extra key':v=>{v.extra={snapshot:v.snapshot};},
 'partial snapshot wrapper':v=>{delete v.snapshot.timeline.tracks;},
 'partial render wrapper':v=>{delete v.status;},
 'wrong request identity':v=>{v.requestId='changed-request';},
 'wrong export identity':v=>{v.id=id(8);},
};
for(const feature of ['audioRole','colour'])for(const [name,mutate]of Object.entries(mutations))test(`${feature}: reject ${name}`,t=>{
 const db=database(t),value=receipt(feature);mutate(value);seed(db,value,name==='wrong export identity'?'exports':'timeline_requests');changeCache(db,feature);
 const before=databaseSnapshot(db);assert.throws(()=>validateWorkspaceSchema40(db));assert.throws(()=>profile.classifyWorkspaceSchemaV40V41(db));assert.deepEqual(databaseSnapshot(db),before);
});
for(const feature of ['audioRole','colour'])for(const kind of ['owner','missing asset','role profile','duplicate escaped','snapshot profile missing','history','timeline'])test(`${feature}: reject ${kind} without frozen binding escape`,t=>{
 const db=database(t),value=receipt(feature);
 if(kind==='role profile'){if(feature==='audioRole')value.snapshot.audioRoleProfile='forged';else value.snapshot.colourPlan.profileId='forged';}
 if(kind==='snapshot profile missing'){if(feature==='audioRole')delete value.snapshot.audioRoleProfile;else delete value.snapshot.colourPlan;}
 let raw=JSON.stringify(value);
 if(kind==='duplicate escaped')raw=raw.replace('"snapshot":','"snapsh\\u006ft":{},"snapshot":');
 seed(db,value,'timeline_requests',raw);
 if(kind==='owner')db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(id(9),id(2));
 if(kind==='missing asset')db.prepare('DELETE FROM assets WHERE id=?').run(id(2));
 if(kind==='history')insert(db,'timeline_history',{id:id(20),projectId:id(1),position:1,operation:'timeline.clip.update',createdAt:stamp,beforeSnapshot:JSON.stringify({tracks:value.snapshot.timeline.tracks,clips:value.snapshot.timeline.clips,durationFrames:30}),afterSnapshot:'{}'});
 if(kind==='timeline')insert(db,'timelines',{id:id(5),projectId:id(1),data:JSON.stringify(value.snapshot.timeline)});
 changeCache(db,feature);assert.throws(()=>validateWorkspaceSchema40(db));assert.throws(()=>profile.classifyWorkspaceSchemaV40V41(db));
});
test('colour: frozen hash/source plan consistency also covers hidden clips',t=>{
 for(const hidden of [false,true]){
  const db=database(t),value=receipt('colour');value.snapshot.timeline.tracks[0].hidden=hidden;
  value.snapshot.colourPlan=createTimelineColourPlan(value.snapshot.timeline,value.snapshot.assets);
  value.snapshot.assets[0].sha256='b'.repeat(64);seed(db,value);changeCache(db,'colour');assert.throws(()=>validateWorkspaceSchema40(db),error('colour'));
 }
});
test('legacy no-envelope receipt retains 4MiB whole-shape budget, envelope path retains 256KiB snapshot cap',t=>{
 for(const envelope of [false,true]){
  const db=database(t),value=receipt('audioRole',envelope),first=value.snapshot.timeline.clips[0],asset=value.snapshot.assets[0];
  value.snapshot.timeline.clips=Array.from({length:100},(_,n)=>({...first,id:id(100+n),assetId:id(300+n),startFrame:n,durationFrames:1}));
  value.snapshot.timeline.durationFrames=100;
  value.snapshot.assets=Array.from({length:100},(_,n)=>({...asset,id:id(300+n),relativePath:'x'.repeat(4000)}));
  seed(db,value);
  for(const item of value.snapshot.assets)insert(db,'assets',{id:item.id,projectId:id(1),data:JSON.stringify({...item,mimeType:'image/png',sha256:'b'.repeat(64)})});
  assert.ok(Buffer.byteLength(JSON.stringify(value.snapshot))>256*1024);
  if(envelope){assert.throws(()=>validateWorkspaceSchema40(db));assert.throws(()=>profile.classifyWorkspaceSchemaV40V41(db));}
  else {validateWorkspaceSchema40(db);profile.classifyWorkspaceSchemaV40V41(db);}
 }
});
test('frozen ownership binding never reads current asset MIME/hash JSON',t=>{
 const db=database(t),value=receipt('audioRole');seed(db,value);
 db.prepare('UPDATE assets SET data=? WHERE id=?').run('not valid current metadata',id(2));
 validateWorkspaceSchema40(db);profile.classifyWorkspaceSchemaV40V41(db);
 assert.throws(()=>legacyScan(db,'audioRole'),error('audioRole'));
});
for(const kind of ['valid','missing','owner','hash','profile'])test(`frozen colour LUT still enforces retained ${kind} resource identity`,t=>{
 const db=database(t),value=receipt('colour'),resourceId=id(80),resourceProfile='mioon-cube3d-normalized-tetrahedral-v1';
 const cube=Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'),hash=createHash('sha256').update(cube).digest('hex');
 value.snapshot.timeline.clips[0].colour.look={resourceId,resourceSha256:kind==='hash'?'b'.repeat(64):hash,resourceProfile,purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:0.35};
 value.snapshot.colourPlan=createTimelineColourPlan(value.snapshot.timeline,value.snapshot.assets);
 if(kind==='profile')value.snapshot.timeline.clips[0].colour.look.resourceProfile='forged';
 seed(db,value);changeCache(db,'colour');
 if(kind!=='missing'){
  const projectId=kind==='owner'?id(9):id(1),requestId='request-frozen-lut';
  db.prepare('INSERT INTO project_lut_resources VALUES(?,?,?,?,?,?,?,?,?)').run(resourceId,projectId,'look.cube',hash,cube.length,resourceProfile,JSON.stringify(parseCube3D(cube.toString()).metadata),cube,stamp);
  db.prepare('INSERT INTO lut_import_requests VALUES(?,?,?,?)').run(requestId,projectId,lutInputHash({projectId,requestId,name:'look.cube'},hash,cube.length),resourceId);
 }
 if(kind==='valid'){validateWorkspaceSchema40(db);profile.classifyWorkspaceSchemaV40V41(db);}
 else {assert.throws(()=>validateWorkspaceSchema40(db),error('colour'));assert.throws(()=>profile.classifyWorkspaceSchemaV40V41(db),error('colour'));}
});
for(const feature of ['audioRole','colour'])for(const owner of ['bad',id(9),Buffer.from('blob-owner')])test(`${feature}: export row owner ${String(owner)} cannot bypass frozen ownership`,t=>{
 const db=database(t),value=receipt(feature,false);seed(db,value,'exports');
 if(owner!==id(9))insert(db,'projects',{id:owner,data:'{}'});db.prepare('UPDATE exports SET projectId=? WHERE id=?').run(owner,id(6));
 assert.throws(()=>validateWorkspaceSchema40(db),error(feature));assert.throws(()=>profile.classifyWorkspaceSchemaV40V41(db),error(feature));
});
