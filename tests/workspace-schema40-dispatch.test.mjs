import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38,validateWorkspaceSchema38} from '../packages/business/src/workspace-schema-v38.ts';
import {initializeWorkspaceSchema40,validateWorkspaceSchema40} from '../packages/business/src/workspace-schema-v40.ts';
import {createWorkspaceRestoreProfileV39} from '../packages/business/src/workspace-restore-schema-v39.ts';
import {createWorkspaceSchemaDispatch,readCurrentWorkspaceRole,validateCurrentWorkspaceColourProfile,usesAssetAnnotationSchema,assertTimelineAudioRoleWorkspace} from '../packages/business/src/workspace-schema-dispatch.ts';
import {createTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {parseCube3D} from '../packages/business/src/cube-lut.ts';
import {lutInputHash} from '../packages/business/src/lut-resource-validation.ts';
import {open,insert,snapshot} from './workspace-schema26-fixtures.mjs';

assert.equal(process.version,'v24.21.0');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const stamp='2026-10-15T00:00:00.000Z',ep='mioon-clip-linear-attenuation-v1';
const metadata=()=>({restorationId:id(901),workspaceOrigin:id(902),sourceBackupId:id(903),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:stamp});
const unused=()=>{throw Error('Unexpected legacy profile fallback');};
const dispatch=createWorkspaceSchemaDispatch({initializeThrough24:initializeWorkspaceSchemaThrough24,detectRestoreEvidence:()=>false,classify:unused,install:unused,validate:unused});
const old=createWorkspaceRestoreProfileV39(initializeWorkspaceSchemaThrough24);
// Every disk belongs to this test invocation. No workspace path, media, network,
// service, CLI transport, or installed application database is opened.
function database(t){
 const dir=mkdtempSync(join(process.cwd(),'.owned-envelope-dispatch-')),file=join(dir,'fixture.sqlite');let db=open(file);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 for(const init of [initializeWorkspaceSchemaThrough24,initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,initializeWorkspaceSchema32,initializeWorkspaceSchema34,initializeWorkspaceSchema36,initializeWorkspaceSchema38])init(db);
 return {get db(){return db;},reopen(){db.close();db=open(file);return db;}};
}
// Historical ordinary40 is constructed by its own reviewed initializer; current
// startup would migrate it further to ordinary56.
function historical40(db){initializeWorkspaceSchema40(db);}
function seed(db){
 insert(db,'projects',{id:id(1),data:JSON.stringify({id:id(1),name:'Owned synthetic fixture'})});
 const asset={id:id(2),projectId:id(1),mimeType:'video/mp4',duration:2,width:720,height:1280,hasAudio:true,sha256:'a'.repeat(64)};
 insert(db,'assets',{id:asset.id,projectId:asset.projectId,data:JSON.stringify(asset)});return asset;
}
const envelope=()=>({profileId:ep,points:[{frame:0,multiplier:.5},{frame:30,multiplier:1}]});
function timeline(fields={}){return {id:id(5),projectId:id(1),revision:1,fps:30,width:720,height:1280,tracks:[{id:id(3),name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],clips:[{id:id(4),trackId:id(3),assetId:id(2),name:'Clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,...fields}],durationFrames:30,createdAt:stamp,updatedAt:stamp};}
const edit=v=>({tracks:v.tracks,clips:v.clips,durationFrames:v.durationFrames});
const input=(volumeEnvelope=envelope())=>({projectId:id(1),requestId:'envelope-task',expectedRevision:1,clipId:id(4),patch:{volumeEnvelope}});
function task(db,volumeEnvelope){insert(db,'edit_tasks',{id:id(20),projectId:id(1),operation:'timeline.clip.update',input:JSON.stringify(input(volumeEnvelope),null,1),requestId:'envelope-task',digest:'a'.repeat(64),lane:'timeline:mutation',origin:'new',status:'prepared',revision:1,acknowledged:0,claim:null,claimInstance:null,receiptDigest:null,errorCode:null,createdAt:stamp,updatedAt:stamp,bytes:16384});}
function proposal(db,volumeEnvelope){
 insert(db,'agent_chat_threads',{id:id(30),projectId:id(1),revision:0,nextPosition:2});
 insert(db,'agent_chat_requests',{requestId:'proposal-chat',projectId:id(1),threadId:id(30),runId:id(31),fingerprint:'a'.repeat(64),acceptance:'{}',bytes:2});
 insert(db,'agent_chat_runs',{id:id(31),projectId:id(1),threadId:id(30),requestId:'proposal-chat',position:1,status:'completed',data:'{}',bytes:2});
 insert(db,'agent_edit_proposals',{id:id(32),projectId:id(1),runId:id(31),shotId:id(33),digest:'a'.repeat(64),definition:JSON.stringify({operation:'timeline.clip.update',input:input(volumeEnvelope),patch:input(volumeEnvelope).patch}),status:'pending',approval:null,outcome:null,createdAt:stamp,updatedAt:stamp,bytes:1024});
}
function unchanged(db,fn,code='RESTORE_SCHEMA_UNSUPPORTED'){const before=snapshot(db);assert.throws(fn,{code});assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);}

test('real dispatch migrates source38 marker-only to current ordinary56 and reopens idempotently',t=>{
 const f=database(t),db=f.db;seed(db);const before=snapshot(db);
 assert.deepEqual(dispatch.classify(db),{schemaVersion:38,profile:'ordinary'});
 assert.equal(dispatch.initialize(db),null);assert.equal(readCurrentWorkspaceRole(db),'ordinary-56');
 const after=snapshot(db);
 // Seeded historical rows survive byte-for-byte; schema_version keeps its
 // prefix and gains the reviewed current marker chain.
 for(const [name,value]of Object.entries(before.tables))if(name!=='schema_version')assert.deepEqual(after.tables[name],value,name);
 assert.deepEqual(after.tables.schema_version.rows.slice(0,before.tables.schema_version.rows.length),before.tables.schema_version.rows);
 assert.deepEqual(after.tables.schema_version.rows.map(row=>Number(row[0])),[...Array.from({length:24},(_,index)=>index+1),26,28,30,32,34,36,38,40,44,48,50,52,54,56]);
 assert.deepEqual(dispatch.classify(db),{schemaVersion:56,profile:'ordinary'});assert.equal(dispatch.detect(db),false);
 assert.throws(()=>validateWorkspaceSchema38(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.equal(dispatch.initialize(f.reopen()),null);assert.deepEqual(snapshot(f.db),after);
});

test('dispatch restores source40 as exact41 while fixed source38/restored39 stays unchanged',t=>{
 for(const version of [38,40]){
  const f=database(t);seed(f.db);if(version===40)historical40(f.db);
  const info=dispatch.installRestore(f.db,metadata());assert.equal(info.sourceSchema,version);assert.equal(info.schemaVersion,version+1);assert.equal(info.profile,version===40?'restored-local-v9':'restored-local-v8');
  const before=snapshot(f.db);assert.equal(dispatch.detect(f.db),true);assert.deepEqual(dispatch.initialize(f.reopen()),info);assert.deepEqual(dispatch.validateRestore(f.db),info);assert.deepEqual(snapshot(f.db),before);
  assert.deepEqual(dispatch.classify(f.db),{schemaVersion:version+1,profile:info.profile});
  if(version===38)assert.equal(old.validateWorkspaceRestoreSchemaV39(f.db).schemaVersion,39);else unchanged(f.db,()=>old.classifyWorkspaceSchemaV38V39(f.db));
 }
});

for(const sql of ['INSERT INTO schema_version VALUES(42)','INSERT INTO schema_version VALUES(39)','DELETE FROM schema_version WHERE version=38','DELETE FROM schema_version WHERE version=1','INSERT INTO schema_version VALUES(41)'])test(`dispatch refuses unknown/forged40 marker chain without repair: ${sql}`,t=>{
 const f=database(t);dispatch.initialize(f.db);f.db.exec(sql);
 for(const fn of [()=>dispatch.classify(f.db),()=>dispatch.initialize(f.db),()=>dispatch.installRestore(f.db,metadata())])unchanged(f.db,fn);
});

test('source38 envelope evidence never acquires40 through migration',t=>{
 const {db}=database(t);seed(db);insert(db,'timeline_requests',{requestId:'forbidden-old-envelope',requestHash:'a'.repeat(64),response:'{"volumeEnvelope":null}'});
 for(const fn of [()=>dispatch.initialize(db),()=>dispatch.classify(db)])unchanged(db,fn);
 // The fixed historical classifier is intentionally not reinterpreted.
 assert.deepEqual(old.classifyWorkspaceSchemaV38V39(db),{schemaVersion:38,profile:'ordinary'});
});

for(const value of [null,'active'])test(`dispatch40/41 retains all seven envelope families (${value??'explicit null'})`,t=>{
 const f=database(t),db=f.db;historical40(db);seed(db);
 const v=timeline({volumeEnvelope:value===null?null:envelope()}),raw=JSON.stringify(v,null,2),history=JSON.stringify(edit(v),null,1);
 insert(db,'timelines',{id:v.id,projectId:id(1),data:raw});
 insert(db,'timeline_history',{id:id(10),projectId:id(1),position:1,operation:'timeline.clip.update',createdAt:stamp,beforeSnapshot:history,afterSnapshot:history});
 insert(db,'timeline_history_cursors',{projectId:id(1),position:1});
 insert(db,'timeline_requests',{requestId:'retained-timeline',requestHash:'a'.repeat(64),response:raw});
 insert(db,'exports',{id:v.id,projectId:id(1),data:raw});task(db,v.clips[0].volumeEnvelope);proposal(db,v.clips[0].volumeEnvelope);
 assert.deepEqual(dispatch.classify(db),{schemaVersion:40,profile:'ordinary'});const before=snapshot(db);
 const info=dispatch.installRestore(db,metadata());assert.equal(info.sourceSchema,40);
 for(const name of ['timelines','timeline_history','timeline_requests','exports','agent_edit_proposals'])assert.deepEqual(snapshot(db).tables[name],before.tables[name],name);
 assert.equal(db.prepare('SELECT beforeSnapshot FROM workspace_restore_timeline_history').get().beforeSnapshot,history);
 assert.equal(db.prepare('SELECT afterSnapshot FROM workspace_restore_timeline_history').get().afterSnapshot,history);
 assert.equal(db.prepare('SELECT input FROM edit_tasks').get().input,JSON.stringify(input(v.clips[0].volumeEnvelope),null,1));
 const restored=snapshot(db);assert.deepEqual(dispatch.initialize(f.reopen()),info);assert.deepEqual(snapshot(f.db),restored);assert.equal(dispatch.classify(f.db).schemaVersion,41);
});

function receipt(feature,asset){
 const fields={volumeEnvelope:envelope()};
 if(feature==='role')fields.audioRole='human';
 else fields.colour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:asset.sha256,streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look:null};
 const v=timeline(fields),frozen={timeline:v,assets:[asset],volumeEnvelopeProfile:ep};
 if(feature==='role')frozen.audioRoleProfile='mioon-clip-audio-role-v1';else frozen.colourPlan=createTimelineColourPlan(v,frozen.assets);
 return {id:id(50),projectId:id(1),requestId:'frozen-receipt',mode:'timeline',purpose:'export',timelineRevision:1,snapshot:frozen,status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
}
for(const feature of ['role','colour'])for(const table of ['timeline_requests','exports'])test(`real dispatch frozen ${feature}/${table} survives changed cache with inherited read continuity`,t=>{
 const f=database(t),db=f.db;historical40(db);const asset=seed(db),value=receipt(feature,asset);
 const cube=Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'),hash=createHash('sha256').update(cube).digest('hex'),rp='mioon-cube3d-normalized-tetrahedral-v1';
 db.prepare('INSERT INTO project_lut_resources VALUES(?,?,?,?,?,?,?,?,?)').run(id(80),id(1),'look.cube',hash,cube.length,rp,JSON.stringify(parseCube3D(cube.toString()).metadata),cube,stamp);
 db.prepare('INSERT INTO lut_import_requests VALUES(?,?,?,?)').run('lut-request',id(1),lutInputHash({projectId:id(1),requestId:'lut-request',name:'look.cube'},hash,cube.length),id(80));
 if(feature==='colour'){value.snapshot.timeline.clips[0].colour.look={resourceId:id(80),resourceSha256:hash,resourceProfile:rp,purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:.35};value.snapshot.colourPlan=createTimelineColourPlan(value.snapshot.timeline,value.snapshot.assets);}
 const raw=JSON.stringify(value,null,2);insert(db,table,table==='exports'?{id:value.id,projectId:id(1),data:raw}:{requestId:value.requestId,requestHash:'a'.repeat(64),response:raw});
 db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...asset,mimeType:feature==='role'?'image/png':'audio/wav',sha256:'b'.repeat(64)}),asset.id);
 const images=timeline();images.clips=[];
 for(const [n,mimeType,profileId]of [[61,'image/png','mioon-srgb-image-clip-v1'],[62,'image/jpeg','mioon-jfif-image-clip-v1']]){
  insert(db,'assets',{id:id(n),projectId:id(1),data:JSON.stringify({id:id(n),projectId:id(1),mimeType})});
  images.clips.push({...timeline().clips[0],id:id(n+10),assetId:id(n),colour:{profileId,source:null,look:null}});
 }
 insert(db,'timelines',{id:images.id,projectId:id(1),data:JSON.stringify(images)});
 insert(db,'asset_annotations',{assetId:id(2),projectId:id(1),revision:1,tags:'["retained"]',note:'Exact annotation'});
 for(const restored of [false,true]){
  if(restored)dispatch.installRestore(db,metadata());const before=snapshot(db);
  validateCurrentWorkspaceColourProfile(db);assert.equal(usesAssetAnnotationSchema(db),true);assertTimelineAudioRoleWorkspace(db,{audioRole:'human'});
  assert.equal(dispatch.classify(db).schemaVersion,restored?41:40);if(restored)dispatch.validateRestore(db);assert.deepEqual(snapshot(db),before);
  assert.equal(db.prepare(table==='exports'?'SELECT data AS raw FROM exports':'SELECT response AS raw FROM timeline_requests').get().raw,raw);
  assert.deepEqual(Buffer.from(db.prepare('SELECT content FROM project_lut_resources').get().content),cube);
  assert.equal(db.prepare('SELECT note FROM asset_annotations').get().note,'Exact annotation');
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM timelines').get().data),images);
 }
 f.reopen();assert.equal(dispatch.classify(f.db).schemaVersion,41);
});

for(const feature of ['role','colour'])test(`dispatch preserves old38/39 ${feature} cache-binding rejection rather than applying40 frozen rules`,t=>{
 for(const restored of [false,true]){
  const {db}=database(t),asset=seed(db),value=receipt(feature,asset);
  delete value.snapshot.volumeEnvelopeProfile;delete value.snapshot.timeline.clips[0].volumeEnvelope;
  const raw=JSON.stringify(value);insert(db,'timeline_requests',{requestId:value.requestId,requestHash:'a'.repeat(64),response:raw});
  assert.equal(dispatch.classify(db).schemaVersion,38);if(restored)dispatch.installRestore(db,metadata());
  db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...asset,mimeType:feature==='role'?'image/png':'audio/wav',sha256:'b'.repeat(64)}),asset.id);
  const code=feature==='role'?'WORKSPACE_AUDIO_ROLE_INVALID':'WORKSPACE_COLOUR_INVALID';
  for(const action of [()=>dispatch.classify(db),()=>dispatch.initialize(db),()=>old.classifyWorkspaceSchemaV38V39(db)])unchanged(db,action,code);
  if(restored)unchanged(db,()=>old.validateWorkspaceRestoreSchemaV39(db),code);else unchanged(db,()=>validateWorkspaceSchema38(db),code);
 }
});

import {createServices} from '../packages/business/src/services.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {readTimelineVolumeEnvelopeCapability} from '../packages/business/src/timeline-volume-envelope-capability.ts';
import {assertTimelineVolumeEnvelopeWorkspace} from '../packages/business/src/timeline-volume-envelope-admission.ts';
import {isWorkspaceRestoreInspection,canEditTimelineVolumeEnvelope,workspaceRestoreSchemas} from '../packages/contracts/src/workspace-restore.ts';
import {timelineVolumeEnvelopeCapabilitySchema} from '../packages/contracts/src/timeline-volume-envelope-capability.ts';

const capability=editable=>({profileId:ep,editable});
function privateRoot(t){const root=mkdtempSync(join(process.cwd(),'.owned-envelope-services-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}

test('volume capability input is true-only opt-in and absence never grants editing',()=>{
 const schema=workspaceRestoreSchemas['workspace.restore.inspect'];
 assert.deepEqual(schema.parse({}),{});assert.deepEqual(schema.parse({includeVolumeEnvelopeCapability:true}),{includeVolumeEnvelopeCapability:true});
 for(const value of [false,null,'true',1,{},[]])assert.equal(schema.safeParse({includeVolumeEnvelopeCapability:value}).success,false);
 assert.equal(schema.safeParse({includeVolumeEnvelopeCapability:true,unknown:true}).success,false);
 assert.equal(canEditTimelineVolumeEnvelope({restored:false}),false);
 assert.equal(canEditTimelineVolumeEnvelope({restored:false,volumeEnvelopeCapability:capability(true)}),true);
 for(const value of [{profileId:'forged',editable:true},{...capability(true),unknown:true},{profileId:ep,editable:'true'}]){
  assert.equal(timelineVolumeEnvelopeCapabilitySchema.safeParse(value).success,false);assert.equal(canEditTimelineVolumeEnvelope({restored:false,volumeEnvelopeCapability:value}),false);
 }
});

test('capability denies exact historical38/39 and marker-only40 without modifying fixtures',t=>{
 const {db}=database(t);const before=snapshot(db);assert.deepEqual(readTimelineVolumeEnvelopeCapability(db),capability(false));assert.deepEqual(snapshot(db),before);
 dispatch.installRestore(db,metadata());const restored=snapshot(db);assert.deepEqual(readTimelineVolumeEnvelopeCapability(db),capability(false));assert.deepEqual(snapshot(db),restored);
 const dir=privateRoot(t),marker=open(join(dir,'markers.sqlite'));t.after(()=>marker.close());
 marker.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY)');for(const n of [...Array.from({length:24},(_,i)=>i+1),26,28,30,32,34,36,38,40])marker.prepare('INSERT INTO schema_version VALUES(?)').run(n);
 assert.equal(readCurrentWorkspaceRole(marker),'ordinary-40');const raw=snapshot(marker);assert.deepEqual(readTimelineVolumeEnvelopeCapability(marker),capability(false));assert.deepEqual(snapshot(marker),raw);
});

// Deliberately corrupt only this owned disposable fixture, then restore the
// exact protection SQL. Production admission must detect the damaged rows even
// when the catalog and marker chain are otherwise genuine.
function corruptProtectedRow(db,table,sql){
 const name=`restore_${table}_update`,guard=db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name).sql;
 db.exec(`DROP TRIGGER ${name}`);db.exec(sql);assert.equal(db.prepare('SELECT changes() AS n').get().n,1);db.exec(guard);
}
for(const kind of ['catalog','metadata','holds-receipt','holds-task','holds-proposal','holds-export','task-binding'])test(`full restored41 capability and shared mutation admission fail closed on ${kind} corruption`,t=>{
 const {db}=database(t);historical40(db);const asset=seed(db);insert(db,'timeline_requests',{requestId:'captured-probe',requestHash:'a'.repeat(64),response:'{}'});task(db);proposal(db);const value=receipt('role',asset);insert(db,'exports',{id:value.id,projectId:id(1),data:JSON.stringify(value)});dispatch.installRestore(db,metadata());
 assert.deepEqual(readTimelineVolumeEnvelopeCapability(db),capability(true));assertTimelineVolumeEnvelopeWorkspace(db,{volumeEnvelope:null});
 if(kind==='catalog')db.exec('DROP TRIGGER immutable_timeline_history');
 if(kind==='metadata')corruptProtectedRow(db,'workspace_restoration',"UPDATE workspace_restoration SET manifestHash='z'||substr(manifestHash,2)");
 if(kind.startsWith('holds-')){const table={'holds-receipt':'timeline_requests','holds-task':'edit_tasks','holds-proposal':'agent_edit_proposals','holds-export':'exports'}[kind];corruptProtectedRow(db,'workspace_restore_holds',"UPDATE workspace_restore_holds SET rowHash='"+'f'.repeat(64)+"' WHERE kind='"+table+"'");}
 if(kind==='task-binding')corruptProtectedRow(db,'workspace_restore_holds',"UPDATE workspace_restore_holds SET requestId='forged-task-request' WHERE kind='edit_tasks'");
 const before=snapshot(db);assert.deepEqual(readTimelineVolumeEnvelopeCapability(db),capability(false));
 assert.throws(()=>assertTimelineVolumeEnvelopeWorkspace(db,{volumeEnvelope:null}),{code:'TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED'});
 assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);
});

test('current ordinary56 backup verifies and restores55 with valid actual-service capability responses and exact retained envelope history',async t=>{
 const root=privateRoot(t),source=join(root,'source'),backup=join(root,'backup'),destination=join(root,'restored');
 let store=openStore(source),services=createServices(store,new Map());
 try{
  const ordinary=await services.call('workspace.restore.inspect',{});assert.deepEqual(ordinary,{restored:false});
  const disclosed=await services.call('workspace.restore.inspect',{includeVolumeEnvelopeCapability:true});assert.deepEqual(disclosed,{restored:false,volumeEnvelopeCapability:capability(true)});assert.equal(isWorkspaceRestoreInspection(disclosed),true);assert.equal(canEditTimelineVolumeEnvelope(disclosed),true);
  for(const input of [{includeVolumeEnvelopeCapability:false},{includeVolumeEnvelopeCapability:true,unknown:true}])await assert.rejects(services.call('workspace.restore.inspect',input),{code:'VALIDATION_ERROR'});
  seed(store.db);const value=timeline({volumeEnvelope:envelope()}),history=JSON.stringify(edit(value),null,2);
  insert(store.db,'timelines',{id:value.id,projectId:id(1),data:JSON.stringify(value)});
  insert(store.db,'timeline_history',{id:id(10),projectId:id(1),position:1,operation:'timeline.clip.update',createdAt:stamp,beforeSnapshot:history,afterSnapshot:history});
  insert(store.db,'timeline_history_cursors',{projectId:id(1),position:1});
  insert(store.db,'timeline_requests',{requestId:'retained-envelope',requestHash:'a'.repeat(64),response:JSON.stringify(value,null,2)});
  const before=snapshot(store.db);await services.drain();store.close();store=null;
  const captured=await createWorkspaceBackup({source,destination:backup});assert.equal(captured.databaseSchemaVersion,56);assert.equal(captured.integrity,'verified');assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),captured);
  const result=await restoreWorkspaceBackup({directory:backup,destination});assert.equal(result.sourceSchema,56);assert.equal(result.databaseSchemaVersion,57);assert.equal(result.profile,'restored-local-v17');
  for(let reopen=0;reopen<2;reopen++){
   store=openStore(destination);services=createServices(store,new Map());
   const legacy=await services.call('workspace.restore.inspect',{}),optIn=await services.call('workspace.restore.inspect',{includeVolumeEnvelopeCapability:true});
   assert.equal(Object.hasOwn(legacy,'volumeEnvelopeCapability'),false);assert.deepEqual(optIn,{...legacy,volumeEnvelopeCapability:capability(true)});assert.equal(isWorkspaceRestoreInspection(legacy),true);assert.equal(isWorkspaceRestoreInspection(optIn),true);assert.equal(canEditTimelineVolumeEnvelope(optIn),true);
   const falsePair=structuredClone(optIn);falsePair.schemaVersion=39;falsePair.profile='restored-local-v8';falsePair.source.schemaVersion=38;assert.equal(isWorkspaceRestoreInspection(falsePair),false);
   for(const name of ['projects','assets','timelines','timeline_history','timeline_history_cursors','timeline_requests'])assert.deepEqual(snapshot(store.db).tables[name],before.tables[name],name);
   assert.equal(store.db.prepare('SELECT beforeSnapshot FROM workspace_restore_timeline_history').get().beforeSnapshot,history);
   await services.drain();store.close();store=null;
  }
 }finally{if(store){await services.drain();store.close();}}
});

const heldFamilies=['jobs','exports','versions','job_events','timeline_requests','reference_requests','idempotency','mutation_requests','asset_range_requests','asset_disposition_requests','asset_annotations','asset_annotation_requests','subject_requests','agent_chat_threads','agent_chat_requests','agent_chat_runs','agent_chat_events','agent_chat_steps','agent_chat_quota','agent_edit_proposals','edit_tasks','image_groups','image_tasks','image_versions','image_requests','image_reviews','image_remote_runs','image_remote_observations','project_lut_resources','lut_import_requests','frame_tasks','frame_requests','waveform_cache'];
function assertCorruptedHoldDenied(db,code='RESTORE_CAPTURE_CHANGED'){
 const before=snapshot(db);
 assert.throws(()=>dispatch.validateRestore(db),{code});
 assert.deepEqual(readTimelineVolumeEnvelopeCapability(db),capability(false));
 assert.throws(()=>assertTimelineVolumeEnvelopeWorkspace(db,{volumeEnvelope:null}),{code:'TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED'});
 assert.deepEqual(snapshot(db),before);
}
function alterHeldFixture(db,action,mutate,code){
 const guardName=`restore_workspace_restore_holds_${action}`,guard=db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(guardName).sql;
 db.exec('BEGIN IMMEDIATE');
 try{db.exec(`DROP TRIGGER ${guardName}`);mutate();assert.equal(db.prepare('SELECT changes() AS n').get().n,1);db.exec(guard);assertCorruptedHoldDenied(db,code);}
 finally{db.exec('ROLLBACK');}
}
test('all33 held families reject zero/nonexistent live bindings with intact41 catalog',async t=>{
 const {db}=database(t);historical40(db);dispatch.installRestore(db,metadata());
 const declared=db.prepare("SELECT sql FROM sqlite_schema WHERE name='workspace_restore_holds'").get().sql.match(/kind IN \(([^)]+)\)/)[1].match(/'([^']+)'/g).map(value=>value.slice(1,-1));
 assert.deepEqual(declared,heldFamilies);assert.equal(heldFamilies.length,33);const original=snapshot(db);
 for(const family of heldFamilies)for(const capturedRowid of [0,9007199254740991])await t.test(`${family}: capturedRowid=${capturedRowid} has no live record`,()=>{
  assert.equal(db.prepare(`SELECT count(*) AS n FROM "${family}" WHERE rowid=?`).get(capturedRowid).n,0);
  alterHeldFixture(db,'insert',()=>insert(db,'workspace_restore_holds',{kind:family,id:'forged-held-identity',capturedRowid,projectId:null,namespace:null,requestId:null,operation:null,rowHash:'f'.repeat(64)}));
 });
 assert.deepEqual(snapshot(db),original);assert.deepEqual(readTimelineVolumeEnvelopeCapability(db),capability(true));
 t.diagnostic('Matrix: 33 genuine declared held families × 2 missing live bindings = 66 negatives; no claim of populated-row hash coverage for these missing-row cases.');
});

test('every populated captured family rejects hash and applicable identity-binding mismatch',async t=>{
 const {db}=database(t);historical40(db);const asset=seed(db);task(db);proposal(db);
 insert(db,'timeline_requests',{requestId:'populated-probe',requestHash:'a'.repeat(64),response:'{}'});const value=receipt('role',asset);insert(db,'exports',{id:value.id,projectId:id(1),data:JSON.stringify(value)});
 dispatch.installRestore(db,metadata());const holds=db.prepare('SELECT * FROM workspace_restore_holds ORDER BY kind,id').all(),original=snapshot(db);assert.equal(holds.length,8);
 let count=0;const manifest=[];
 for(const held of holds){
  const fields=['rowHash','id',...['projectId','namespace','requestId','operation'].filter(field=>held[field]!==null)];manifest.push({family:held.kind,fields});
  for(const field of fields){count++;await t.test(`${held.kind}: mismatched ${field}`,()=>{
   const replacement=field==='rowHash'?'f'.repeat(64):field==='projectId'?id(999):`forged-${field}`;
   alterHeldFixture(db,'update',()=>db.prepare(`UPDATE workspace_restore_holds SET "${field}"=? WHERE kind=? AND id=?`).run(replacement,held.kind,held.id),held.kind==='exports'&&['namespace','requestId'].includes(field)?'RESTORE_EXPORT_IDENTITY_UNSUPPORTED':'RESTORE_CAPTURE_CHANGED');
  });}
 }
 assert.deepEqual(snapshot(db),original);assert.deepEqual(readTimelineVolumeEnvelopeCapability(db),capability(true));
 t.diagnostic(JSON.stringify({matrix:'populated-family-hash-and-binding',families:manifest.length,cases:count,manifest}));
});

for(const [kind,sql]of [['table','CREATE TABLE unrelated_fixture_catalog(value TEXT)'],['view','CREATE VIEW unrelated_fixture_catalog AS SELECT 1 AS value']])test(`ordinary40 capability refuses extra ${kind} catalog object without writes`,t=>{
 const {db}=database(t);historical40(db);assert.deepEqual(readTimelineVolumeEnvelopeCapability(db),capability(true));
 db.exec(sql);assert.equal(readCurrentWorkspaceRole(db),'ordinary-40');const before=snapshot(db);
 // Strict historical classification refuses the extra unmanaged catalog object;
 // the capability gate therefore cannot grant envelope editing.
 assert.throws(()=>dispatch.classify(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.deepEqual(readTimelineVolumeEnvelopeCapability(db),capability(false));assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);
});
