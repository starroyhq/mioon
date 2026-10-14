import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30,validateWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {createWorkspaceRestoreProfileV29} from '../packages/business/src/workspace-restore-schema-v29.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {openStore,classifyCurrentWorkspaceSchema,installCurrentWorkspaceRestoreSchema,validateCurrentWorkspaceRestoreSchema,validateCurrentWorkspaceColourProfile,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {readWorkspaceBackupSchemaVersion} from '../packages/business/src/workspace-backup-schema-versions.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.mjs';
import {withOrdinaryMigrationSource} from '../apps/desktop/scripts/migration-restore-guard.mjs';
import {workspaceBackupSourceSchemaVersion,workspaceRestorationPairSchema} from '../packages/contracts/src/workspace-schema-profiles.ts';
import {projectTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {parseCube3D} from '../packages/business/src/cube-lut.ts';
import {lutInputHash} from '../packages/business/src/lut-resource-validation.ts';
import {open,snapshot,fixture,facade} from './workspace-schema26-fixtures.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stamp='2026-10-14T00:00:00.000Z';
const meta=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:stamp});
const bytes=Buffer.from('synthetic owned source');
const cube=Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
function database(t,version=30,retained=false){
 const db=open(':memory:');t.after(()=>db.close());
 if(retained)fixture(db,'ordinary-24-seeded');else initializeWorkspaceSchemaThrough24(db);
 if(version>=26)initializeWorkspaceSchema26(db);
 if(version>=28)initializeWorkspaceSchema28(db);
 if(version>=30)initializeWorkspaceSchema30(db);
 return db;
}
function seed(db,{history=true,render=true,colour=true}={}){
 const projectId=randomUUID(),assetId=randomUUID(),timelineId=randomUUID(),clipId=randomUUID(),trackId=randomUUID(),resourceId=randomUUID(),lutRequest=randomUUID();
 const project={id:projectId,name:'SDR workspace'};
 const asset={id:assetId,projectId,mimeType:'video/mp4',relativePath:`media/${assetId}.mp4`,sizeBytes:bytes.length,sha256:hash(bytes)};
 db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify(project));
 db.prepare('INSERT INTO assets VALUES(?,?,?)').run(assetId,projectId,JSON.stringify(asset));
 db.prepare('INSERT INTO project_lut_resources VALUES(?,?,?,?,?,?,?,?,?)').run(resourceId,projectId,'look.cube',hash(cube),cube.length,'mioon-cube3d-normalized-tetrahedral-v1',JSON.stringify(parseCube3D(cube.toString()).metadata),cube,stamp);
 db.prepare('INSERT INTO lut_import_requests VALUES(?,?,?,?)').run(lutRequest,projectId,lutInputHash({projectId,requestId:lutRequest,name:'look.cube'},hash(cube),cube.length),resourceId);
 const declaration={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:asset.sha256,streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look:{resourceId,resourceSha256:hash(cube),resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:0.35}};
 const track={id:trackId,kind:'video',hidden:false},legacyClip={id:clipId,assetId,trackId,startFrame:0,durationFrames:30,sourceInFrame:0};
 const clip={...legacyClip,...(colour?{colour:declaration}:{})};
 const timeline={id:timelineId,projectId,revision:1,tracks:[track],clips:[clip],durationFrames:30,createdAt:stamp,updatedAt:stamp};
 db.prepare('INSERT INTO timelines VALUES(?,?,?)').run(timelineId,projectId,JSON.stringify(timeline));
 if(history){
  const before={tracks:[track],clips:[legacyClip],durationFrames:30},after={tracks:[track],clips:[clip],durationFrames:30};
  db.prepare('INSERT INTO timeline_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(),projectId,1,'timeline.clip.update',stamp,JSON.stringify(before),JSON.stringify(after));
  db.prepare('INSERT INTO timeline_history_cursors VALUES(?,?)').run(projectId,1);
 }
 let rendered;
 if(render){
  const frozen={timeline,assets:[asset]};const plan=projectTimelineColourPlan(frozen);if(plan)frozen.colourPlan=plan;
  rendered={id:randomUUID(),projectId,requestId:randomUUID(),mode:'timeline',purpose:'review',timelineRevision:1,snapshot:frozen,status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
  db.prepare('INSERT INTO exports VALUES(?,?,?)').run(rendered.id,projectId,JSON.stringify(rendered));
  db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(rendered.requestId,'a'.repeat(64),JSON.stringify(rendered));
 }
 return {projectId,asset,timeline,declaration,rendered,resourceId};
}
function changeTimeline(db,change){const row=db.prepare('SELECT id,data FROM timelines LIMIT 1').get(),value=JSON.parse(row.data);change(value);db.prepare('UPDATE timelines SET data=? WHERE id=?').run(JSON.stringify(value),row.id);}
function rewrite(db,table,sql,value){
 const guards=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql LIKE '%BEFORE UPDATE%'").all(table);
 for(const guard of guards)db.exec(`DROP TRIGGER "${guard.name}"`);
 db.prepare(sql).run(value);
 for(const guard of guards)db.exec(guard.sql);
}

test('28 to30 is marker-only and preserves frozen seeded raw rows, rowids and schema SQL',t=>{
 const db=database(t,28,true),before=snapshot(db);initializeWorkspaceSchema30(db);const after=snapshot(db);
 assert.deepEqual(after.objects,before.objects);
 after.tables.schema_version.rows=after.tables.schema_version.rows.filter(row=>row[0]!=='30');
 assert.deepEqual(after.tables,before.tables);
 assert.deepEqual(classifyCurrentWorkspaceSchema(db),{schemaVersion:30,profile:'ordinary'});
 assert.equal(readWorkspaceBackupSchemaVersion(db),30);
 const stable=snapshot(db);initializeWorkspaceSchema30(db);assert.deepEqual(snapshot(db),stable);
 assert.throws(()=>createWorkspaceRestoreProfileV29(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV28V29(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
});

for(const point of ['after marker','before commit'])test(`schema30 migration is atomic ${point}`,t=>{
 const db=database(t,28),before=snapshot(db);let reached=false;
 const intercepted=facade(db,event=>{if(point==='after marker'?event.phase==='after'&&event.sql==='INSERT INTO main.schema_version(version) VALUES(30)':event.phase==='before'&&event.sql==='COMMIT'){reached=true;throw Object.assign(Error('interrupted'),{code:'INJECTED30'});}});
 assert.throws(()=>initializeWorkspaceSchema30(intercepted),{code:'INJECTED30'});assert.equal(reached,true);assert.deepEqual(snapshot(db),before);
});

for(const version of [24,26,28,30])test(`current reader keeps exact source${version}/restored${version+1} pair`,t=>{
 const db=database(t,version);assert.equal(classifyCurrentWorkspaceSchema(db).schemaVersion,version);
 const info=installCurrentWorkspaceRestoreSchema(db,meta());assert.equal(info.schemaVersion,version+1);assert.equal(info.sourceSchema,version);
 assert.equal(readCurrentWorkspaceRole(db),`restored-${version+1}-evidence`);assert.deepEqual(validateCurrentWorkspaceRestoreSchema(db),info);
});

test('pair contracts admit30/31 but reject unknown newer versions and cross-pairs',()=>{
 for(const value of [1,24,26,28,30])assert.equal(workspaceBackupSourceSchemaVersion.safeParse(value).success,true);
 for(const value of [25,27,29,31,32,33,30.5])assert.equal(workspaceBackupSourceSchemaVersion.safeParse(value).success,false);
 for(const [index,profile]of ['restored-local-v1','restored-local-v2','restored-local-v3','restored-local-v4'].entries())for(const sourceSchema of [24,26,28,30])for(const databaseSchemaVersion of [25,27,29,31])assert.equal(workspaceRestorationPairSchema.safeParse({profile,sourceSchema,databaseSchemaVersion}).success,sourceSchema===24+2*index&&databaseSchemaVersion===25+2*index);
});

for(const change of ['future marker','missing30','missing26','restore31 without30'])test(`new role rejects stale/corrupt markers: ${change}`,t=>{
 const db=database(t);seed(db,{render:false});
 if(change==='future marker')db.exec('INSERT INTO schema_version VALUES(32)');
 if(change==='missing30')db.exec('DELETE FROM schema_version WHERE version=30');
 if(change==='missing26')db.exec('DELETE FROM schema_version WHERE version=26');
 if(change==='restore31 without30')db.exec('DELETE FROM schema_version WHERE version=30;INSERT INTO schema_version VALUES(31)');
 const before=snapshot(db);assert.throws(()=>classifyCurrentWorkspaceSchema(db));assert.throws(()=>validateCurrentWorkspaceColourProfile(db));assert.deepEqual(snapshot(db),before);
});

for(const location of ['timeline','history','receipt','snapshot','task','escaped key'])test(`historical28 refuses colour including null in ${location} without mutating anything`,t=>{
 const db=database(t,28),f=seed(db,{colour:false,history:false,render:false});
 if(location==='timeline')changeTimeline(db,value=>{value.clips[0].colour=null;});
 if(location==='history')db.prepare('INSERT INTO timeline_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(),f.projectId,1,'timeline.clip.update',stamp,'{}',JSON.stringify({clips:[{colour:null}]}));
 if(location==='receipt')db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(randomUUID(),'a'.repeat(64),JSON.stringify({projectId:f.projectId,clips:[{colour:null}]}));
 if(location==='snapshot')db.prepare('INSERT INTO exports VALUES(?,?,?)').run(randomUUID(),f.projectId,JSON.stringify({colourPlan:null}));
 if(location==='task'){
  const requestId=randomUUID(),input={projectId:f.projectId,requestId,clipId:f.timeline.clips[0].id,colour:null};
  db.prepare('INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),f.projectId,'timeline.clip.update',JSON.stringify(input),requestId,'a'.repeat(64),'timeline:mutation','new','prepared',1,0,stamp,stamp,16384);
 }
 if(location==='escaped key'){
  db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(randomUUID(),'a'.repeat(64),'{"input":{"\\u0063olour":null}}');
 }
 const before=snapshot(db);
 assert.throws(()=>initializeWorkspaceSchema30(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.throws(()=>classifyCurrentWorkspaceSchema(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.throws(()=>readWorkspaceBackupSchemaVersion(db),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});
 assert.deepEqual(snapshot(db),before);
});

for(const kind of ['unknown colour profile','invalid strength','source hash','missing resource','resource hash','resource owner','duplicate key'])test(`schema30 rejects corrupt or stale ${kind}`,t=>{
 const db=database(t);seed(db,{history:false,render:false});
 if(kind==='duplicate key')db.exec(`UPDATE timelines SET data='{"colour":null,"colour":{}}'`);
 else changeTimeline(db,value=>{
  const colour=value.clips[0].colour;
  if(kind==='unknown colour profile')colour.profileId='future-v2';
  if(kind==='invalid strength')colour.look.strength=2;
  if(kind==='source hash')colour.source.assetSha256='f'.repeat(64);
  if(kind==='missing resource')colour.look.resourceId=randomUUID();
  if(kind==='resource hash')colour.look.resourceSha256='f'.repeat(64);
  if(kind==='resource owner')value.projectId=randomUUID();
 });
 if(kind==='resource owner'){
  const row=db.prepare('SELECT projectId FROM timelines').get();const other=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(other,JSON.stringify({id:other}));
  db.exec('PRAGMA foreign_keys=OFF');rewrite(db,'project_lut_resources','UPDATE project_lut_resources SET projectId=?',other);db.exec('PRAGMA foreign_keys=ON');
 }
 const before=snapshot(db);assert.throws(()=>validateWorkspaceSchema30(db));assert.throws(()=>classifyCurrentWorkspaceSchema(db));assert.deepEqual(snapshot(db),before);
});

for(const kind of ['missing plan','changed plan','extra plan field'])test(`schema30 snapshot gate refuses ${kind}`,t=>{
 const db=database(t),f=seed(db,{history:false});const changed=structuredClone(f.rendered);
 if(kind==='missing plan')delete changed.snapshot.colourPlan;
 if(kind==='changed plan')changed.snapshot.colourPlan.clips[0].range='full';
 if(kind==='extra plan field')changed.snapshot.colourPlan.future=true;
 rewrite(db,'exports','UPDATE exports SET data=?',JSON.stringify(changed));
 assert.throws(()=>validateWorkspaceSchema30(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

test('null and invalidated source declarations persist exactly without becoming a render plan',t=>{
 const db=database(t),f=seed(db,{render:false});
 changeTimeline(db,value=>{value.clips[0].colour.source=null;});assert.doesNotThrow(()=>validateWorkspaceSchema30(db));
 changeTimeline(db,value=>{value.clips[0].colour=null;});assert.doesNotThrow(()=>validateWorkspaceSchema30(db));
 assert.equal(JSON.parse(db.prepare('SELECT data FROM timelines').get().data).clips[0].colour,null);
 assert.equal(JSON.parse(db.prepare('SELECT afterSnapshot FROM timeline_history').get().afterSnapshot).clips[0].colour.look.strength,0.35);
});

test('cold backup30 and restored31 preserve exact colour, snapshots, history, LUT bytes and source bytes',async t=>{
 const base=mkdtempSync(path.join(tmpdir(),'mioon-colour-backup-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'source'),backup=path.join(base,'backup'),restored=path.join(base,'restored');
 const store=openStore(root),f=seed(store.db),before=snapshot(store.db);writeFileSync(path.join(root,f.asset.relativePath),bytes,{mode:0o600});store.close();
 const sourceBytes=readFileSync(path.join(root,'workbench.sqlite'));
 let migrated=false;await withOrdinaryMigrationSource(path.join(root,'workbench.sqlite'),async({file})=>{migrated=true;assert.deepEqual(readFileSync(file),sourceBytes);});assert.equal(migrated,true);
 const result=await createWorkspaceBackup({source:root,destination:backup});assert.equal(result.databaseSchemaVersion,30);assert.equal(result.integrity,'verified');
 assert.equal((await verifyWorkspaceBackup({directory:backup})).databaseSchemaVersion,30);
 assert.deepEqual(readFileSync(path.join(backup,'payload/workbench.sqlite')),sourceBytes);
 const installed=await restoreWorkspaceBackup({directory:backup,destination:restored});assert.equal(installed.databaseSchemaVersion,31);assert.equal(installed.sourceSchema,30);assert.equal(installed.profile,'restored-local-v4');
 const reopened=openStore(restored);try{
  assert.equal(getWorkspaceRestoreContext(reopened).schemaVersion,31);const actual=snapshot(reopened.db);
  for(const table of ['timelines','timeline_history','timeline_requests','exports','project_lut_resources','lut_import_requests'])assert.deepEqual(actual.tables[table],before.tables[table],`${table}: raw retained bytes`);
  assert.deepEqual(JSON.parse(reopened.db.prepare('SELECT data FROM timelines').get().data),f.timeline);
  assert.deepEqual(Buffer.from(reopened.db.prepare('SELECT content FROM project_lut_resources').get().content),cube);
 }finally{reopened.close();}
 assert.deepEqual(readFileSync(path.join(root,'workbench.sqlite')),sourceBytes);assert.deepEqual(readFileSync(path.join(restored,f.asset.relativePath)),bytes);
 await assert.rejects(createWorkspaceBackup({source:restored,destination:path.join(base,'forbidden')}),{code:'RESTORE_BACKUP_UNAVAILABLE'});
});

test('cold capture and migration refuse missing30 or corrupt colour before publishing a destination',async t=>{
 for(const kind of ['missing30','corrupt colour']){
  const base=mkdtempSync(path.join(tmpdir(),'mioon-colour-refuse-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'source'),backup=path.join(base,'backup'),store=openStore(root);seed(store.db,{render:false});
  if(kind==='missing30')store.db.exec('DELETE FROM schema_version WHERE version=30');
  else changeTimeline(store.db,value=>{value.clips[0].colour.look.strength=-1;});store.close();
  let consumed=false;await assert.rejects(withOrdinaryMigrationSource(path.join(root,'workbench.sqlite'),()=>{consumed=true;}));assert.equal(consumed,false);
  await assert.rejects(createWorkspaceBackup({source:root,destination:backup}),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});assert.equal(existsSync(path.join(backup,'COMPLETE.json')),false);
 }
});

test('restored31 revalidation refuses corrupted live colour and exact archived evidence',t=>{
 const db=database(t);seed(db,{render:false});installCurrentWorkspaceRestoreSchema(db,meta());
 changeTimeline(db,value=>{value.clips[0].colour.source.assetSha256='f'.repeat(64);});
 assert.throws(()=>validateCurrentWorkspaceRestoreSchema(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

for(const status of ['prepared','not_applied'])test(`durable ${status} colour intent may retain an unknown LUT and stale source without blocking reopen or backup`,t=>{
 const db=database(t),f=seed(db,{render:false}),requestId=randomUUID();
 const colour=structuredClone(f.declaration);colour.look.resourceId=randomUUID();colour.look.resourceSha256='f'.repeat(64);colour.source.assetSha256='e'.repeat(64);
 const input=JSON.stringify({projectId:f.projectId,requestId,clipId:f.timeline.clips[0].id,expectedRevision:1,patch:{colour}});
 db.prepare('INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,errorCode,createdAt,updatedAt,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),f.projectId,'timeline.clip.update',input,requestId,hash(input),'timeline:mutation','new',status,status==='prepared'?1:3,0,status==='not_applied'?'LUT_NOT_FOUND':null,stamp,stamp,16384);
 const before=snapshot(db);assert.doesNotThrow(()=>initializeWorkspaceSchema30(db));assert.equal(readWorkspaceBackupSchemaVersion(db),30);assert.deepEqual(snapshot(db),before);
 assert.equal(installCurrentWorkspaceRestoreSchema(db,meta()).schemaVersion,31);assert.equal(db.prepare('SELECT input FROM edit_tasks').get().input,input);
});

for(const kind of ['audio track','image source'])test(`accepted managed colour refuses ${kind}`,t=>{
 const db=database(t),f=seed(db,{history:false,render:false});
 if(kind==='audio track')changeTimeline(db,value=>{value.tracks[0].kind='audio';});
 else {const asset={...f.asset,mimeType:'image/png'};db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(asset),asset.id);}
 assert.throws(()=>validateWorkspaceSchema30(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

test('restored31 rejects corrupt archived colour even when its live timeline is valid',t=>{
 const db=database(t),f=seed(db,{render:false});installCurrentWorkspaceRestoreSchema(db,meta());
 const archive={tracks:f.timeline.tracks,clips:structuredClone(f.timeline.clips),durationFrames:30};archive.clips[0].colour.profileId='future-v2';
 rewrite(db,'workspace_restore_timeline_history','UPDATE workspace_restore_timeline_history SET afterSnapshot=?',JSON.stringify(archive));
 assert.throws(()=>validateCurrentWorkspaceRestoreSchema(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

test('oversized JSON is refused before any JSON parser or traversal runs',async t=>{
 const {validateWorkspaceColourRows}=await import('../packages/business/src/workspace-colour-validation.ts');
 const db=database(t),projectId=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId}));
 db.prepare('INSERT INTO timelines VALUES(?,?,?)').run(randomUUID(),projectId,'x'.repeat(4*1024*1024+1));
 let parsed=false;db.function('json_valid',()=>{parsed=true;throw Error('unbounded JSON parse');});
 assert.throws(()=>validateWorkspaceColourRows(db,{allowColour:true}),{code:'WORKSPACE_COLOUR_INVALID'});assert.equal(parsed,false);
});
