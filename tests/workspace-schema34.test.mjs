import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32,validateWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34,validateWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';
import {createWorkspaceRestoreProfileV33} from '../packages/business/src/workspace-restore-schema-v33.ts';
import {createWorkspaceRestoreProfileV35} from '../packages/business/src/workspace-restore-schema-v35.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {openStore,classifyCurrentWorkspaceSchema,installCurrentWorkspaceRestoreSchema,validateCurrentWorkspaceRestoreSchema,validateCurrentWorkspaceColourProfile,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {readWorkspaceBackupSchemaVersion} from '../packages/business/src/workspace-backup-schema-versions.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {createServices} from '../packages/business/src/services.ts';
import {RESTORE_READ_OPERATIONS,RESTORE_LOCAL_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {withOrdinaryMigrationSource} from '../apps/desktop/scripts/migration-restore-guard.ts';
import {workspaceBackupSourceSchemaVersion,workspaceRestorationPairSchema} from '../packages/contracts/src/workspace-schema-profiles.ts';
import {projectTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {parseCube3D} from '../packages/business/src/cube-lut.ts';
import {lutInputHash} from '../packages/business/src/lut-resource-validation.ts';
import {open,snapshot,fixture,facade} from './workspace-schema26-fixtures.mjs';
import {png} from './helpers/timeline-image-fixtures.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stamp='2026-10-15T00:00:00.000Z';
const raw=value=>' \n'+JSON.stringify(value,null,'\t').replaceAll('界','\\u754c')+'\n ';
const meta=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:stamp});
const videoBytes=Buffer.from('synthetic owned video source');
const cube=Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
// Independent 1×1 baseline JFIF YCbCr 4:4:4 fixture; role tests preserve exact bytes.
const imageBytes=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDCr99Pzc//2Q==','base64');
const oldProfile=createWorkspaceRestoreProfileV33(initializeWorkspaceSchemaThrough24);
const newProfile=createWorkspaceRestoreProfileV35(initializeWorkspaceSchemaThrough24);
function database(t,version=34,retained=false){
 const db=open(':memory:');t.after(()=>{if(db.isOpen)db.close();});
 if(retained)fixture(db,'ordinary-24-seeded');else initializeWorkspaceSchemaThrough24(db);
 if(version>=26)initializeWorkspaceSchema26(db);
 if(version>=28)initializeWorkspaceSchema28(db);
 if(version>=30)initializeWorkspaceSchema30(db);
 if(version>=32)initializeWorkspaceSchema32(db);
 if(version>=34)initializeWorkspaceSchema34(db);
 return db;
}

// Pin historical source schemas with their own constructors, not the current
// startup path or deletion of newer markers/tables.
function historicalStore(root,version=34){
 mkdirSync(root,{recursive:true,mode:0o700});mkdirSync(path.join(root,'media'),{recursive:true,mode:0o700});
 const db=open(path.join(root,'workbench.sqlite'));initializeWorkspaceSchemaThrough24(db);
 for(const [schema,initialize] of [[26,initializeWorkspaceSchema26],[28,initializeWorkspaceSchema28],[30,initializeWorkspaceSchema30],[32,initializeWorkspaceSchema32],[34,initializeWorkspaceSchema34]])if(version>=schema)initialize(db);
 return {db,close:()=>db.close()};
}
function seed(db,{managed=true,images=true,history=true,render=true,task=false}={}){
 const projectId=randomUUID(),resourceId=randomUUID(),lutRequest=randomUUID(),trackId=randomUUID();
 const project={id:projectId,name:'Mixed SDR 界',createdAt:stamp,updatedAt:stamp};
 const makeAsset=(mimeType,bytes)=>{const id=randomUUID();return{id,projectId,name:mimeType==='image/jpeg'?'Still 界':'Video',mimeType,relativePath:`media/${id}.${mimeType==='image/jpeg'?'jpg':'mp4'}`,sizeBytes:bytes.length,sha256:hash(bytes),width:1,height:1,duration:mimeType==='image/jpeg'?null:1,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:stamp};};
 const videoAsset=makeAsset('video/mp4',videoBytes),imageAsset=makeAsset('image/jpeg',imageBytes),assets=images?[videoAsset,imageAsset]:[videoAsset];
 db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,raw(project));
 for(const asset of assets)db.prepare('INSERT INTO assets VALUES(?,?,?)').run(asset.id,projectId,raw(asset));
 db.prepare('INSERT INTO project_lut_resources VALUES(?,?,?,?,?,?,?,?,?)').run(resourceId,projectId,'look.cube',hash(cube),cube.length,'mioon-cube3d-normalized-tetrahedral-v1',raw(parseCube3D(cube.toString()).metadata),cube,stamp);
 db.prepare('INSERT INTO lut_import_requests VALUES(?,?,?,?)').run(lutRequest,projectId,lutInputHash({projectId,requestId:lutRequest,name:'look.cube'},hash(cube),cube.length),resourceId);
 const look={resourceId,resourceSha256:hash(cube),resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:0.35};
 const videoColour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:videoAsset.sha256,streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look};
 const evidence={profileId:'jfif-ycbcr8-srgb-v1',sha256:imageAsset.sha256,sourceByteLength:imageBytes.length,width:1,height:1,bitDepth:8,alphaMode:'opaque',orientation:1,colourTag:'untagged',sampling:'444',decoderPolicy:'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1'};
 const imageColour={profileId:'mioon-jfif-image-clip-v1',source:{assetSha256:imageAsset.sha256,profileId:'jfif-ycbcr8-srgb-v1',interpretation:'srgb',declaredBy:'user',declaredAt:stamp,evidence},look};
 const track={id:trackId,name:'Video 1',kind:'video',orderIndex:0,hidden:false,muted:false};
 const clips=assets.map((asset,index)=>({id:randomUUID(),assetId:asset.id,trackId,name:asset.name,startFrame:index*30,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,...(managed?{colour:asset.mimeType==='image/jpeg'?imageColour:videoColour}:{})}));
 const timeline={id:randomUUID(),projectId,revision:1,fps:30,width:720,height:1280,tracks:[track],clips,durationFrames:clips.length*30,createdAt:stamp,updatedAt:stamp};
 db.prepare('INSERT INTO timelines VALUES(?,?,?)').run(timeline.id,projectId,raw(timeline));
 if(history){
  const before={tracks:[track],clips:clips.map(({colour,...clip})=>clip),durationFrames:timeline.durationFrames};
  const after={tracks:[track],clips,durationFrames:timeline.durationFrames};
  db.prepare('INSERT INTO timeline_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(),projectId,1,'timeline.clip.update',stamp,raw(before),raw(after));
  db.prepare('INSERT INTO timeline_history_cursors VALUES(?,?)').run(projectId,1);
 }
 let rendered;
 if(render){
  const frozen={timeline,assets};const plan=projectTimelineColourPlan(frozen);if(plan)frozen.colourPlan=plan;
  rendered={id:randomUUID(),projectId,requestId:randomUUID(),mode:'timeline',purpose:'preview',timelineRevision:1,snapshot:frozen,status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
  db.prepare('INSERT INTO exports VALUES(?,?,?)').run(rendered.id,projectId,raw(rendered));
  db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(rendered.requestId,'a'.repeat(64),raw(rendered));
 }
 let taskInput;
 if(task){const requestId=randomUUID();taskInput={projectId,requestId,expectedRevision:1,clipId:clips[0].id,patch:{name:'Retained intent'}};insertTask(db,taskInput);}
 return{projectId,project,assets,videoAsset,imageAsset,timeline,videoColour,imageColour,evidence,rendered,resourceId,taskInput};
}
function insertTask(db,input,status='prepared'){
 const text=raw(input);
 db.prepare('INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,errorCode,createdAt,updatedAt,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),input.projectId,'timeline.clip.update',text,input.requestId,hash(text),'timeline:mutation','new',status,status==='prepared'?1:3,0,status==='not_applied'?'LUT_NOT_FOUND':null,stamp,stamp,16384);
 return text;
}
function rewrite(db,table,sql,...values){
 const guards=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql LIKE '%BEFORE UPDATE%'").all(table);
 for(const guard of guards)db.exec(`DROP TRIGGER "${guard.name}"`);
 db.prepare(sql).run(...values);
 for(const guard of guards)db.exec(guard.sql);
}
function changeTimeline(db,change){const row=db.prepare('SELECT id,data FROM timelines ORDER BY rowid DESC LIMIT 1').get(),value=JSON.parse(row.data);change(value);rewrite(db,'timelines','UPDATE timelines SET data=? WHERE id=?',raw(value),row.id);}
function updateAsset(db,asset,change){const next={...asset,...change};rewrite(db,'assets','UPDATE assets SET data=? WHERE id=?',raw(next),asset.id);return next;}
function rewriteLocation(db,location,value,f){
 if(location==='timeline')rewrite(db,'timelines','UPDATE timelines SET data=? WHERE id=?',raw(value),f.timeline.id);
 if(location==='history')rewrite(db,'timeline_history','UPDATE timeline_history SET afterSnapshot=? WHERE projectId=?',raw(value),f.projectId);
 if(location==='receipt')rewrite(db,'timeline_requests','UPDATE timeline_requests SET response=? WHERE requestId=?',raw(value),f.rendered.requestId);
 if(location==='export')rewrite(db,'exports','UPDATE exports SET data=? WHERE id=?',raw(value),f.rendered.id);
 if(location==='task')rewrite(db,'edit_tasks','UPDATE edit_tasks SET input=? WHERE requestId=?',raw({...f.taskInput,payload:value}),f.taskInput.requestId);
}

for(const retained of [false,true])test(`32→34 adds only its marker and preserves exact rows, types, rowids, DDL and v1 plan (retained=${retained})`,t=>{
 const db=database(t,32,retained);const f=seed(db,{images:false});const before=snapshot(db);
 assert.equal(f.rendered.snapshot.colourPlan.profileId,'mioon-rec709-sdr-render-v1');
 initializeWorkspaceSchema34(db);const after=snapshot(db);assert.deepEqual(after.objects,before.objects);
 after.tables.schema_version.rows=after.tables.schema_version.rows.filter(row=>row[0]!=='34');assert.deepEqual(after.tables,before.tables);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...Array.from({length:24},(_,i)=>i+1),26,28,30,32,34]);
 assert.deepEqual(classifyCurrentWorkspaceSchema(db),{schemaVersion:34,profile:'ordinary'});assert.equal(readWorkspaceBackupSchemaVersion(db),34);assert.equal(readCurrentWorkspaceRole(db),'ordinary-34');
 const stable=snapshot(db);initializeWorkspaceSchema34(db);assert.deepEqual(snapshot(db),stable);
 assert.throws(()=>validateWorkspaceSchema32(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});assert.throws(()=>oldProfile.classifyWorkspaceSchemaV32V33(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
});

for(const point of ['after marker','before commit'])test(`schema34 migration rolls back all retained bytes ${point}`,t=>{
 const db=database(t,32);seed(db,{images:false});const before=snapshot(db);let reached=false;
 const intercepted=facade(db,event=>{if(point==='after marker'?event.phase==='after'&&event.sql==='INSERT INTO main.schema_version(version) VALUES(34)':event.phase==='before'&&event.sql==='COMMIT'){reached=true;throw Object.assign(Error('interrupted'),{code:'INJECTED34'});}});
 assert.throws(()=>initializeWorkspaceSchema34(intercepted),{code:'INJECTED34'});assert.equal(reached,true);assert.equal(db.isTransaction,false);assert.deepEqual(snapshot(db),before);
 assert.doesNotThrow(()=>initializeWorkspaceSchema34(db));
});

for(const version of [24,26,28,30,32,34])test(`current dispatcher retains exact source${version}/restored${version+1} pair without upgrading historical restores`,t=>{
 const db=database(t,version);assert.equal(classifyCurrentWorkspaceSchema(db).schemaVersion,version);
 const info=installCurrentWorkspaceRestoreSchema(db,meta());assert.equal(info.schemaVersion,version+1);assert.equal(info.sourceSchema,version);
 assert.equal(readCurrentWorkspaceRole(db),`restored-${version+1}-evidence`);assert.deepEqual(validateCurrentWorkspaceRestoreSchema(db),info);
 const before=snapshot(db);assert.throws(()=>initializeWorkspaceSchema34(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});assert.deepEqual(snapshot(db),before);
});

test('wire contracts admit only exact registered source/restoration pairings and keep restored schemas out of backup sources',()=>{
 for(const value of [1,24,26,28,30,32,34,36,38,40,44,48])assert.equal(workspaceBackupSourceSchemaVersion.safeParse(value).success,true);
 for(const value of [25,27,29,31,33,35,37,39,41,45,49,34.5])assert.equal(workspaceBackupSourceSchemaVersion.safeParse(value).success,false);
 for(const [profile,sourceSchema,databaseSchemaVersion]of [['restored-local-v1',24,25],['restored-local-v2',26,27],['restored-local-v3',28,29],['restored-local-v4',30,31],['restored-local-v5',32,33],['restored-local-v6',34,35],['restored-local-v7',36,37],['restored-local-v8',38,39],['restored-local-v9',40,41],['restored-local-v11',44,45],['restored-local-v13',48,49]])assert.equal(workspaceRestorationPairSchema.safeParse({profile,sourceSchema,databaseSchemaVersion}).success,true);
 for(const profile of ['restored-local-v10','restored-local-v12','restored-local-v14'])for(const sourceSchema of [24,26,28,30,32,34,36,38,40,44,48])assert.equal(workspaceRestorationPairSchema.safeParse({profile,sourceSchema,databaseSchemaVersion:sourceSchema+1}).success,false);
});

for(const change of ['future marker','missing34','missing32','missing30','missing28','missing26','restored35 without34','restored33 with34'])test(`mixed-role reader rejects corrupt or downgraded markers: ${change}`,t=>{
 const db=database(t);seed(db);
 const sql={'future marker':'INSERT INTO schema_version VALUES(38)',missing34:'DELETE FROM schema_version WHERE version=34',missing32:'DELETE FROM schema_version WHERE version=32',missing30:'DELETE FROM schema_version WHERE version=30',missing28:'DELETE FROM schema_version WHERE version=28',missing26:'DELETE FROM schema_version WHERE version=26','restored35 without34':'DELETE FROM schema_version WHERE version=34;INSERT INTO schema_version VALUES(35)','restored33 with34':'INSERT INTO schema_version VALUES(33)'}[change];db.exec(sql);
 const before=snapshot(db);assert.throws(()=>classifyCurrentWorkspaceSchema(db));assert.throws(()=>validateCurrentWorkspaceColourProfile(db));assert.throws(()=>initializeWorkspaceSchema34(db));assert.throws(()=>readWorkspaceBackupSchemaVersion(db),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});assert.deepEqual(snapshot(db),before);
});

for(const role of [32,33])for(const location of ['timeline','history','receipt','task','export'])for(const payload of ['image clip','image source','mixed plan'])test(`historical${role} rejects ${payload} in ${location} without mutation`,t=>{
 const db=database(t,32),f=seed(db,{managed:false,task:true});
 if(role===33)oldProfile.installWorkspaceRestoreSchemaV33(db,meta());
 const mixedTimeline={...f.timeline,clips:f.timeline.clips.map((clip,index)=>({...clip,colour:index?f.imageColour:f.videoColour}))};
 const value=payload==='image clip'?{...mixedTimeline}:payload==='image source'?{projectId:f.projectId,sourceEvidence:f.imageColour.source}:{projectId:f.projectId,plan:projectTimelineColourPlan({timeline:mixedTimeline,assets:f.assets})};
 rewriteLocation(db,location,value,f);const before=snapshot(db);
 assert.throws(()=>oldProfile.classifyWorkspaceSchemaV32V33(db));assert.throws(()=>classifyCurrentWorkspaceSchema(db));assert.throws(()=>validateCurrentWorkspaceColourProfile(db));
 if(role===32){assert.throws(()=>initializeWorkspaceSchema34(db));assert.throws(()=>readWorkspaceBackupSchemaVersion(db),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});}
 else assert.throws(()=>validateCurrentWorkspaceRestoreSchema(db));
 assert.deepEqual(snapshot(db),before);
});

for(const kind of ['source hash','evidence hash','source profile','clip profile','interpretation','unknown evidence field','wrong MIME','image profile on video','video profile on image','foreign asset','foreign LUT','missing LUT','LUT hash','audio track','duplicate key'])test(`schema34 rejects accepted image binding corruption: ${kind}`,t=>{
 const db=database(t),f=seed(db,{history:false,render:false});
 if(kind==='wrong MIME')updateAsset(db,f.imageAsset,{mimeType:'image/png'});
 else if(kind==='foreign asset'){const other=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(other,raw({id:other}));db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(other,f.imageAsset.id);}
 else if(kind==='foreign LUT'){const other=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(other,raw({id:other}));db.exec('PRAGMA foreign_keys=OFF');rewrite(db,'project_lut_resources','UPDATE project_lut_resources SET projectId=? WHERE id=?',other,f.resourceId);db.exec('PRAGMA foreign_keys=ON');}
 else if(kind==='duplicate key')rewrite(db,'timelines','UPDATE timelines SET data=? WHERE id=?','{"colour":null,"colour":{}}',f.timeline.id);
 else changeTimeline(db,value=>{
  const colour=value.clips[1].colour;
  if(kind==='source hash')colour.source.assetSha256='f'.repeat(64);
  if(kind==='evidence hash')colour.source.evidence.sha256='f'.repeat(64);
  if(kind==='source profile')colour.source.profileId='rec709-yuv-sdr-v1';
  if(kind==='clip profile')colour.profileId='mioon-rec709-sdr-clip-v1';
  if(kind==='interpretation')colour.source.interpretation='display-p3';
  if(kind==='unknown evidence field')colour.source.evidence.future=true;
  if(kind==='image profile on video')value.clips[1].assetId=f.videoAsset.id;
  if(kind==='video profile on image')value.clips[1].colour={...f.videoColour,source:{...f.videoColour.source,assetSha256:f.imageAsset.sha256}};
  if(kind==='missing LUT')colour.look.resourceId=randomUUID();
  if(kind==='LUT hash')colour.look.resourceSha256='f'.repeat(64);
  if(kind==='audio track')value.tracks[0].kind='audio';
 });
 const before=snapshot(db);assert.throws(()=>validateWorkspaceSchema34(db),{code:'WORKSPACE_COLOUR_INVALID'});assert.throws(()=>classifyCurrentWorkspaceSchema(db));assert.deepEqual(snapshot(db),before);
});

for(const profile of ['image','video'])for(const mimeType of ['video/mp4','video/webm','image/png','image/jpeg'])test(`schema34 retains invalidated ${profile} declaration on ${mimeType}, but cannot freeze it for render`,t=>{
 const db=database(t),f=seed(db,{history:false,render:false});
 updateAsset(db,f.imageAsset,{mimeType});const colour={...(profile==='image'?f.imageColour:f.videoColour),source:null};
 changeTimeline(db,value=>{value.clips[1].colour=colour;});const before=snapshot(db);
 assert.doesNotThrow(()=>validateWorkspaceSchema34(db));assert.doesNotThrow(()=>validateCurrentWorkspaceColourProfile(db));assert.deepEqual(snapshot(db),before);
 const timeline=JSON.parse(db.prepare('SELECT data FROM timelines').get().data),assets=f.assets.map(asset=>asset.id===f.imageAsset.id?{...asset,mimeType}:asset);
 assert.deepEqual(timeline.clips[1].colour,colour);assert.throws(()=>projectTimelineColourPlan({timeline,assets}),{code:'INVALID_TIMELINE_COLOUR'});
 const restored=installCurrentWorkspaceRestoreSchema(db,meta());assert.equal(restored.schemaVersion,35);assert.deepEqual(validateCurrentWorkspaceRestoreSchema(db),restored);
});

for(const mimeType of ['image/webp','image/avif','audio/wav','video/quicktime'])test(`invalidated source:null never admits unsupported ${mimeType}`,t=>{
 const db=database(t),f=seed(db,{history:false,render:false});updateAsset(db,f.imageAsset,{mimeType});changeTimeline(db,value=>{value.clips[1].colour.source=null;});assert.throws(()=>validateWorkspaceSchema34(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

for(const kind of ['missing plan','wrong plan profile','changed evidence','changed algorithm','changed display','extra field'])test(`schema34 frozen snapshot rejects ${kind}`,t=>{
 const db=database(t),f=seed(db,{history:false});const changed=structuredClone(f.rendered),plan=changed.snapshot.colourPlan;
 if(kind==='missing plan')delete changed.snapshot.colourPlan;
 if(kind==='wrong plan profile')plan.profileId='mioon-rec709-sdr-render-v1';
 if(kind==='changed evidence')plan.clips[1].evidence.width++;
 if(kind==='changed algorithm')plan.clips[1].algorithmSha256='f'.repeat(64);
 if(kind==='changed display')plan.clips[1].referenceDisplay.gamma=2.2;
 if(kind==='extra field')plan.future=true;
 rewrite(db,'exports','UPDATE exports SET data=? WHERE id=?',raw(changed),f.rendered.id);
 assert.throws(()=>validateWorkspaceSchema34(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

for(const status of ['prepared','not_applied'])test(`schema34 retains unresolved ${status} image intent without granting source or LUT authority`,t=>{
 const db=database(t),f=seed(db,{render:false});const colour=structuredClone(f.imageColour);
 colour.look.resourceId=randomUUID();colour.look.resourceSha256='f'.repeat(64);colour.source.assetSha256=colour.source.evidence.sha256='e'.repeat(64);
 const input={projectId:f.projectId,requestId:randomUUID(),expectedRevision:1,clipId:f.timeline.clips[1].id,patch:{colour}},text=insertTask(db,input,status),before=snapshot(db);
 assert.doesNotThrow(()=>initializeWorkspaceSchema34(db));assert.equal(readWorkspaceBackupSchemaVersion(db),34);assert.deepEqual(snapshot(db),before);
 assert.equal(installCurrentWorkspaceRestoreSchema(db,meta()).schemaVersion,35);assert.equal(db.prepare('SELECT input FROM edit_tasks').get().input,text);
});

for(const fragment of ['CREATE TABLE workspace_restoration','INSERT INTO workspace_restore_timeline_history','CREATE TRIGGER restore_legacy_schema_gate','COMMIT'])test(`restored35 installation rolls back at ${fragment}`,t=>{
 const db=database(t);seed(db);const before=snapshot(db);let fired=false;
 const wrapped={get isTransaction(){return db.isTransaction;},prepare:db.prepare.bind(db),exec(sql){if(!fired&&fragment==='COMMIT'&&sql==='COMMIT'){fired=true;throw Error('injected35');}const result=db.exec(sql);if(!fired&&sql.includes(fragment)){fired=true;throw Error('injected35');}return result;}};
 assert.throws(()=>newProfile.installWorkspaceRestoreSchemaV35(wrapped,meta()),/injected35/);assert.equal(fired,true);assert.equal(db.isTransaction,false);assert.deepEqual(snapshot(db),before);
 assert.equal(newProfile.installWorkspaceRestoreSchemaV35(db,meta()).schemaVersion,35);
});

test('cold backup34→restored35 preserves exact mixed image evidence, raw receipts/history, v3 snapshot, LUT/source bytes across reopen',async t=>{
 const base=mkdtempSync(path.join(tmpdir(),'mioon-mixed-backup-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'source'),backup=path.join(base,'backup'),restored=path.join(base,'restored');
 const store=historicalStore(root),f=seed(store.db,{task:true}),before=snapshot(store.db);
 assert.equal(classifyCurrentWorkspaceSchema(store.db).schemaVersion,34);assert.equal(f.rendered.snapshot.colourPlan.profileId,'mioon-mixed-sdr-render-v3');
 for(const asset of f.assets)writeFileSync(path.join(root,asset.relativePath),asset.mimeType==='image/jpeg'?imageBytes:videoBytes,{mode:0o600});store.close();
 const sourceBytes=readFileSync(path.join(root,'workbench.sqlite'));
 let consumed=false;await withOrdinaryMigrationSource(path.join(root,'workbench.sqlite'),async({file})=>{consumed=true;assert.deepEqual(readFileSync(file),sourceBytes);});assert.equal(consumed,true);
 const captured=await createWorkspaceBackup({source:root,destination:backup});assert.equal(captured.databaseSchemaVersion,34);assert.equal(captured.integrity,'verified');
 assert.equal((await verifyWorkspaceBackup({directory:backup})).databaseSchemaVersion,34);assert.deepEqual(readFileSync(path.join(backup,'payload/workbench.sqlite')),sourceBytes);
 const installed=await restoreWorkspaceBackup({directory:backup,destination:restored});assert.equal(installed.databaseSchemaVersion,35);assert.equal(installed.sourceSchema,34);assert.equal(installed.profile,'restored-local-v6');
 for(let attempt=0;attempt<2;attempt++){
  const reopened=openStore(restored);try{
   assert.equal(getWorkspaceRestoreContext(reopened).schemaVersion,35);const actual=snapshot(reopened.db);
   for(const table of ['timelines','timeline_history','timeline_requests','exports','project_lut_resources','lut_import_requests'])assert.deepEqual(actual.tables[table],before.tables[table],`${table}: raw retained bytes at reopen ${attempt}`);
   assert.deepEqual(JSON.parse(reopened.db.prepare('SELECT data FROM timelines').get().data),f.timeline);
   assert.deepEqual(JSON.parse(reopened.db.prepare('SELECT data FROM exports').get().data).snapshot.colourPlan,f.rendered.snapshot.colourPlan);
   assert.deepEqual(Buffer.from(reopened.db.prepare('SELECT content FROM project_lut_resources').get().content),cube);
   assert.equal(reopened.db.prepare('SELECT input FROM edit_tasks').get().input,raw(f.taskInput));assert.equal(reopened.db.prepare('SELECT executionEpoch FROM edit_tasks').get().executionEpoch,'captured');
   assert.deepEqual(reopened.db.prepare('SELECT id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot FROM workspace_restore_timeline_history ORDER BY capturedRowid').all(),reopened.db.prepare('SELECT id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot FROM timeline_history ORDER BY rowid').all());
   assert.throws(()=>oldProfile.classifyWorkspaceSchemaV32V33(reopened.db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  }finally{reopened.close();}
 }
 assert.deepEqual(readFileSync(path.join(root,'workbench.sqlite')),sourceBytes);assert.deepEqual(readFileSync(path.join(restored,f.imageAsset.relativePath)),imageBytes);assert.deepEqual(readFileSync(path.join(restored,f.videoAsset.relativePath)),videoBytes);
 await assert.rejects(createWorkspaceBackup({source:restored,destination:path.join(base,'forbidden')}),{code:'RESTORE_BACKUP_UNAVAILABLE'});assert.equal(existsSync(path.join(base,'forbidden')),false);
});

for(const location of ['live timeline','archive','held snapshot'])test(`restored35 revalidation rejects corrupted ${location} without repairing captured image evidence`,t=>{
 const db=database(t),f=seed(db);installCurrentWorkspaceRestoreSchema(db,meta());
 if(location==='live timeline')changeTimeline(db,value=>{value.clips[1].colour.source.evidence.sha256='f'.repeat(64);});
 if(location==='archive'){const value={tracks:f.timeline.tracks,clips:structuredClone(f.timeline.clips),durationFrames:60};value.clips[1].colour.source.evidence.alphaMode='premultiplied';rewrite(db,'workspace_restore_timeline_history','UPDATE workspace_restore_timeline_history SET afterSnapshot=?',raw(value));}
 if(location==='held snapshot'){const value=structuredClone(f.rendered);value.snapshot.colourPlan.clips[1].resizeProfile='future-v2';rewrite(db,'exports','UPDATE exports SET data=?',raw(value));}
 const before=snapshot(db);assert.throws(()=>validateCurrentWorkspaceRestoreSchema(db),{code:'WORKSPACE_COLOUR_INVALID'});assert.deepEqual(snapshot(db),before);
});

test('restored35 keeps source inspection and LUT import denied; reads and explicit-origin local actions retain existing fences',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'mioon-mixed-permissions-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let store=historicalStore(root);const f=seed(store.db);store.close();const db=new DatabaseSync(path.join(root,'workbench.sqlite'));
 const info=installCurrentWorkspaceRestoreSchema(db,meta());db.close();store=openStore(root);const services=createServices(store,new Map());
 try{
  const context={expectedWorkspaceOrigin:info.workspaceOrigin};assert.deepEqual(await services.call('timeline.get',{projectId:f.projectId}),f.timeline);
  assert.equal((await services.call('asset.list',{projectId:f.projectId})).length,2);
  const disclosure=await services.call('workspace.restore.inspect',{});assert.equal(disclosure.schemaVersion,35);assert.equal(disclosure.source.schemaVersion,34);
  const before=snapshot(store.db);
  for(const operation of ['timeline.colour.jpeg.inspect','timeline.colour.source.inspect','lut.import']){
   assert.equal(RESTORE_READ_OPERATIONS.includes(operation),false);assert.equal(RESTORE_LOCAL_OPERATIONS.includes(operation),false);
   const input=operation==='lut.import'?{projectId:f.projectId,requestId:randomUUID(),name:'new.cube',dataBase64:cube.toString('base64')}:{projectId:f.projectId,assetId:operation==='timeline.colour.jpeg.inspect'?f.imageAsset.id:f.videoAsset.id};
   await assert.rejects(services.call(operation,input,context),{code:'RESTORE_OPERATION_UNAVAILABLE'});
  }
  for(const [context,code] of [[{},'RESTORE_WORKSPACE_ORIGIN_REQUIRED'],[{expectedWorkspaceOrigin:randomUUID()},'RESTORE_WORKSPACE_ORIGIN_MISMATCH']])await assert.rejects(services.call('project.create',{name:'No authority'},context),{code});
  assert.deepEqual(snapshot(store.db),before);
  const created=await services.call('project.create',{name:'Explicit local action'},context);assert.equal(created.name,'Explicit local action');
  assert.equal(validateCurrentWorkspaceRestoreSchema(store.db).schemaVersion,35);
  assert.throws(()=>store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(raw({...f.rendered,status:'succeeded'}),f.rendered.id),/RESTORED_RECORD_HELD|immutable/i);
 }finally{await services.drain();store.close();}
});

test('cold capture and migration refuse missing34 and corrupt image evidence before publishing a destination',async t=>{
 for(const kind of ['missing34','corrupt evidence']){
  const base=mkdtempSync(path.join(tmpdir(),'mioon-mixed-refuse-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const root=path.join(base,'source'),backup=path.join(base,'backup');
  const store=historicalStore(root);seed(store.db,{render:false});if(kind==='missing34')store.db.exec('DELETE FROM schema_version WHERE version=34');else changeTimeline(store.db,value=>{value.clips[1].colour.source.evidence.sha256='f'.repeat(64);});store.close();
  const bytes=readFileSync(path.join(root,'workbench.sqlite'));let consumed=false;await assert.rejects(withOrdinaryMigrationSource(path.join(root,'workbench.sqlite'),()=>{consumed=true;}));assert.equal(consumed,false);
  await assert.rejects(createWorkspaceBackup({source:root,destination:backup}),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});assert.equal(existsSync(path.join(backup,'COMPLETE.json')),false);assert.deepEqual(readFileSync(path.join(root,'workbench.sqlite')),bytes);
 }
});

// Every historical role must refuse newer identifiers even without outer
// colour/colourPlan keys. Do not rely on a future-expanded generic DTO union.
for(const role of [24,25,26,27,28,29,30,31,32,33])for(const profileId of ['jfif-ycbcr8-srgb-v1','mioon-jfif-image-clip-v1','mioon-mixed-sdr-render-v3'])test(`historical${role} fails closed on standalone ${profileId} receipt`,t=>{
 const source=role%2?role-1:role,db=database(t,source),requestId=randomUUID();
 db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(requestId,'a'.repeat(64),raw({retained:'legacy'}));
 if(role%2)installCurrentWorkspaceRestoreSchema(db,meta());
 rewrite(db,'timeline_requests','UPDATE timeline_requests SET response=? WHERE requestId=?',raw({retained:{profileId}}),requestId);
 const before=snapshot(db);
 assert.throws(()=>classifyCurrentWorkspaceSchema(db));
 assert.throws(()=>validateCurrentWorkspaceColourProfile(db));
 if(role%2)assert.throws(()=>validateCurrentWorkspaceRestoreSchema(db));
 else assert.throws(()=>readWorkspaceBackupSchemaVersion(db),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});
 assert.deepEqual(snapshot(db),before);
});

for(const hostile of ['extra task trigger','extra LUT trigger','temporary LUT shadow','marker trigger'])test(`schema34 additive migration rejects ${hostile} before imported code executes`,t=>{
 const db=database(t,32);seed(db,{images:false});
 const statements={
  'extra task trigger':"CREATE TRIGGER hostile_edit BEFORE INSERT ON edit_tasks BEGIN SELECT RAISE(ABORT,'IMPORTED_CODE_EXECUTED');END",
  'extra LUT trigger':"CREATE TRIGGER hostile_lut BEFORE INSERT ON project_lut_resources BEGIN SELECT RAISE(ABORT,'IMPORTED_CODE_EXECUTED');END",
  'temporary LUT shadow':'CREATE TEMP TABLE project_lut_resources(secret TEXT)',
  'marker trigger':"CREATE TRIGGER hostile_marker BEFORE INSERT ON schema_version BEGIN SELECT RAISE(ABORT,'IMPORTED_CODE_EXECUTED');END",
 };db.exec(statements[hostile]);const before=snapshot(db);
 assert.throws(()=>initializeWorkspaceSchema34(db),error=>error.code==='RESTORE_SCHEMA_UNSUPPORTED'&&!error.message.includes('IMPORTED_CODE_EXECUTED'));
 assert.deepEqual(snapshot(db),before);
});

test('schema34 preserves existing PNG/v2 bytes during marker-only migration',t=>{
 const db=database(t,32),f=seed(db,{images:false,history:false,render:false});
 const bytes=png({width:1,height:1}),asset={...f.videoAsset,mimeType:'image/png',duration:null,sha256:hash(bytes),sizeBytes:bytes.length};updateAsset(db,f.videoAsset,asset);
 const evidence={profileId:'png-rgb8-srgb-v1',sha256:asset.sha256,sourceByteLength:asset.sizeBytes,width:1,height:1,bitDepth:8,alphaMode:'straight',orientation:1,colourTag:'srgb'};
 changeTimeline(db,value=>{value.clips[0].colour={profileId:'mioon-srgb-image-clip-v1',source:{assetSha256:asset.sha256,profileId:'png-rgb8-srgb-v1',interpretation:'srgb',declaredBy:'user',declaredAt:stamp,evidence},look:null};});
 const timeline=JSON.parse(db.prepare('SELECT data FROM timelines').get().data),frozen={timeline,assets:[asset]};frozen.colourPlan=projectTimelineColourPlan(frozen);
 assert.equal(frozen.colourPlan.profileId,'mioon-mixed-sdr-render-v2');const requestId=randomUUID();db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(requestId,'a'.repeat(64),raw(frozen));
 const before=snapshot(db);initializeWorkspaceSchema34(db);const after=snapshot(db);after.tables.schema_version.rows=after.tables.schema_version.rows.filter(row=>row[0]!=='34');assert.deepEqual(after,before);
 assert.equal(JSON.parse(db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(requestId).response).colourPlan.profileId,'mioon-mixed-sdr-render-v2');
});

const frozenConstructorSha256={
  "packages/business/src/workspace-schema-v26.ts": "98811d77cef4cd675123d0d8be22282588d26b09307c07543d7fa7361449d473",
  "packages/business/src/workspace-schema-v28.ts": "c8696ae2ee13ccae8a17ad66417081b9f5e479e79dcf9fdd0b108f4aa01248ed",
  "packages/business/src/workspace-schema-v30.ts": "54cea43b7c6c9ab2cadd316c463794036c40c0bf98b8693b03719bc80c3e1901",
  "packages/business/src/workspace-schema-v32.ts": "155743d3ccdc29489efd612ff27e68b5dd94bdeff0ec8d4b765a41e914ef70a9",
  "packages/business/src/workspace-restore-schema-v27.ts": "49fee1a9b0f891e04f7dc789c5793cfbafba843c728bb8f10bc30529a0c6dc35",
  "packages/business/src/workspace-restore-schema-v29.ts": "07823b4fdf6ffa570e3e1cf2caf3edcd20db37ee6649f134e56e6067ad595a31",
  "packages/business/src/workspace-restore-schema-v31.ts": "0932065643b57395d310792236846357c5927bbc6e5ef596b07ce9caff551764",
  "packages/business/src/workspace-restore-schema-v33.ts": "81feb41eeb6d2853bb3f8a905f4cc7dd57aaf7fec4317374bba4499ddef054da"
};
test('JPEG generation leaves every historical26–33 constructor byte-frozen',()=>{
 for(const [file,expected] of Object.entries(frozenConstructorSha256))assert.equal(hash(readFileSync(new URL('../'+file,import.meta.url))),expected,file);
});

for(const restored of [false,true])test(`fixed34/35 marker reading rejects signed64 overflow without crossing an unbounded value into JS (restored=${restored})`,t=>{
 const db=database(t);if(restored){installCurrentWorkspaceRestoreSchema(db,meta());db.exec('DROP TRIGGER restore_schema_marker_insert');}
 db.exec('INSERT INTO schema_version VALUES(9223372036854775807)');
 const before=snapshot(db);
 assert.throws(()=>newProfile.classifyWorkspaceSchemaV34V35(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.throws(()=>readCurrentWorkspaceRole(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.deepEqual(snapshot(db),before);
});

test('cold-source marker scanner projects oversized imported marker cells away before JS',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE schema_version(version)');
 db.prepare('INSERT INTO schema_version VALUES(?)').run('x'.repeat(2*1024*1024));
 let projected=false;const bounded={prepare(sql){const statement=db.prepare(sql);return {...statement,iterate(...args){const values=[...statement.iterate(...args)];assert.deepEqual(values.map(value=>value.version),[null]);projected=true;return values.values();}};}};
 assert.throws(()=>readWorkspaceBackupSchemaVersion(bounded),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});assert.equal(projected,true);
});


test('ordinary34/restored35 retain one exact v3 snapshot mixing video, PNG and JFIF JPEG',t=>{
 const db=database(t),f=seed(db,{history:false,render:false}),bytes=png({width:1,height:1});
 const asset={...f.imageAsset,id:randomUUID(),mimeType:'image/png',relativePath:'media/mixed.png',sha256:hash(bytes),sizeBytes:bytes.length};
 db.prepare('INSERT INTO assets VALUES(?,?,?)').run(asset.id,f.projectId,raw(asset));
 const evidence={profileId:'png-rgb8-srgb-v1',sha256:asset.sha256,sourceByteLength:asset.sizeBytes,width:1,height:1,bitDepth:8,alphaMode:'straight',orientation:1,colourTag:'srgb'};
 const colour={profileId:'mioon-srgb-image-clip-v1',source:{assetSha256:asset.sha256,profileId:'png-rgb8-srgb-v1',interpretation:'srgb',declaredBy:'user',declaredAt:stamp,evidence},look:f.imageColour.look};
 changeTimeline(db,value=>{value.clips.push({...value.clips[1],id:randomUUID(),assetId:asset.id,startFrame:60,colour});value.durationFrames=90;});
 const timeline=JSON.parse(db.prepare('SELECT data FROM timelines').get().data),frozen={timeline,assets:[...f.assets,asset]};frozen.colourPlan=projectTimelineColourPlan(frozen);
 assert.equal(frozen.colourPlan.profileId,'mioon-mixed-sdr-render-v3');
 assert.deepEqual(frozen.colourPlan.clips.map(clip=>clip.sourceProfileId),['rec709-yuv-sdr-v1','jfif-ycbcr8-srgb-v1','png-rgb8-srgb-v1']);
 const requestId=randomUUID();db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(requestId,'a'.repeat(64),raw(frozen));
 assert.doesNotThrow(()=>validateWorkspaceSchema34(db));const before=db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(requestId).response;
 assert.equal(installCurrentWorkspaceRestoreSchema(db,meta()).schemaVersion,35);assert.equal(validateCurrentWorkspaceRestoreSchema(db).schemaVersion,35);
 assert.equal(db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(requestId).response,before);
});

async function restoredMutationFixture(t,version,{managed=version===35}={}){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-restored-jpeg-edit-'));
 let store=historicalStore(root,version-1),services;
 t.after(async()=>{await services?.drain();store?.close();rmSync(root,{recursive:true,force:true});});
 // The source was constructed at its exact historical role above.
 // All colour data for older profiles stays unmanaged until the request.
 const f=seed(store.db,{managed,render:false});store.close();store=null;
 const db=open(path.join(root,'workbench.sqlite'));let info;
 try{info=installCurrentWorkspaceRestoreSchema(db,meta());}finally{db.close();}
 assert.equal(info.schemaVersion,version);store=openStore(root);services=createServices(store,new Map());
 return{store,services,f,context:{expectedWorkspaceOrigin:info.workspaceOrigin}};
}

test('restored35 accepts origin-bound exact saved JPEG clip colour, replays once, and preserves undo/redo semantics',async t=>{
 const {store,services,f,context}=await restoredMutationFixture(t,35),clip=f.timeline.clips[1];
 const input={projectId:f.projectId,requestId:randomUUID(),expectedRevision:f.timeline.revision,clipId:clip.id,patch:{name:'JPEG local edit',colour:structuredClone(f.imageColour)}};
 const before=snapshot(store.db);
 for(const [context,code]of [[{},'RESTORE_WORKSPACE_ORIGIN_REQUIRED'],[{expectedWorkspaceOrigin:randomUUID()},'RESTORE_WORKSPACE_ORIGIN_MISMATCH']]){
  await assert.rejects(services.call('timeline.clip.update',input,context),{code});assert.deepEqual(snapshot(store.db),before);
 }
 const updated=await services.call('timeline.clip.update',input,context);
 assert.equal(updated.revision,f.timeline.revision+1);assert.equal(updated.clips[1].name,'JPEG local edit');assert.deepEqual(updated.clips[1].colour,f.imageColour);
 const after=snapshot(store.db),count=store.db.prepare('SELECT total_changes() AS n').get().n;
 assert.deepEqual(await services.call('timeline.clip.update',input,context),updated);assert.deepEqual(snapshot(store.db),after);assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,count);
 const undoInput={projectId:f.projectId,requestId:randomUUID(),expectedRevision:updated.revision};
 const undone=await services.call('timeline.undo',undoInput,context);assert.equal(undone.clips[1].name,clip.name);assert.deepEqual(undone.clips[1].colour,f.imageColour);
 const undoState=snapshot(store.db);assert.deepEqual(await services.call('timeline.undo',undoInput,context),undone);assert.deepEqual(snapshot(store.db),undoState);
 const redone=await services.call('timeline.redo',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:undone.revision},context);
 assert.equal(redone.clips[1].name,'JPEG local edit');assert.deepEqual(redone.clips[1].colour,f.imageColour);
 assert.equal(validateCurrentWorkspaceRestoreSchema(store.db).schemaVersion,35);
 // Archived pre-restore history remains exact while local edits use new rows.
 assert.deepEqual(snapshot(store.db).tables.workspace_restore_timeline_history,before.tables.workspace_restore_timeline_history);
});

for(const [version,kind]of [[31,'PNG'],[31,'JPEG'],[33,'JPEG']])for(const operation of ['timeline.clip.add','timeline.clip.update'])test(`restored${version} denies newer ${kind} ${operation} before any write`,async t=>{
 const {store,services,f,context}=await restoredMutationFixture(t,version);
 const evidence={profileId:'png-rgb8-srgb-v1',sha256:f.imageAsset.sha256,sourceByteLength:f.imageAsset.sizeBytes,width:1,height:1,bitDepth:8,alphaMode:'straight',orientation:1,colourTag:'srgb'};
 const colour=kind==='JPEG'?f.imageColour:{profileId:'mioon-srgb-image-clip-v1',source:{assetSha256:f.imageAsset.sha256,profileId:'png-rgb8-srgb-v1',interpretation:'srgb',declaredBy:'user',declaredAt:stamp,evidence},look:f.imageColour.look};
 const input={projectId:f.projectId,requestId:randomUUID(),expectedRevision:f.timeline.revision,...(operation==='timeline.clip.add'?{assetId:f.imageAsset.id,trackId:f.timeline.tracks[0].id,startFrame:60,durationFrames:30,colour}:{clipId:f.timeline.clips[1].id,patch:{colour}})};
 const before=snapshot(store.db),count=store.db.prepare('SELECT total_changes() AS n').get().n;
 await assert.rejects(services.call(operation,input,context),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 assert.deepEqual(snapshot(store.db),before);assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,count);
 assert.equal(validateCurrentWorkspaceRestoreSchema(store.db).schemaVersion,version);
});
