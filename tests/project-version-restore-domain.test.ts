import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {TimelineRecord} from '../packages/business/src/timeline-inputs.ts';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import path from 'node:path';
import {createServerProject} from './helpers/project-database.ts';
import {captureProjectDocumentInside,canonicalJson,PROJECT_SNAPSHOT_TABLES,rowKey,tableColumns,snapshotCellValue,validateProjectDocument} from '../packages/business/src/project-versions/document.ts';
import type {ProjectDocument,ProjectSnapshotTable,SnapshotRow} from '../packages/business/src/project-versions/document.ts';
import {buildRestorePlan} from '../packages/business/src/project-versions/preview.ts';
import {applyRestorePlanInside} from '../packages/business/src/project-versions/restore.ts';
import {withProjectRestoreScopeInside} from '../packages/business/src/project-file/restore-scope.ts';
import {createTimelineServices} from '../packages/business/src/timeline.ts';
import {newTimelineRecord} from '../packages/business/src/timeline-new-record.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {createSubjectServices} from '../packages/business/src/subjects.ts';
import {isSubjectListResponse,isSubjectResponse,isSubjectVersionResponse} from '../packages/contracts/src/subjects.ts';
import {readLutResource} from '../packages/business/src/project-lut-reader.ts';
import {parseLutBytes,lutHash} from '../packages/business/src/lut-resource-validation.ts';
import {LUT_RESOURCE_PROFILE} from '../packages/contracts/src/lut-resources.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS,imageTaskResponseSchema,imageGroupResponseSchema} from '../packages/contracts/src/images.ts';
import {createImageOwnershipReader} from '../packages/business/src/image-ownership.ts';
import {assetMediaRecordSchema} from '../packages/contracts/src/asset-media.ts';
import type {RestorePlan} from '../packages/business/src/project-versions/preview.ts';
import {referenceTestAsset} from '../packages/business/src/project-file/test-asset-fixture.ts';
import {createProjectServiceApplication,testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAssetMediaServices} from '../packages/business/src/asset-media-services.ts';
import {createProjectAssetReferenceServices} from '../packages/business/src/project-asset-references.ts';
import {resolveReferencePath} from '../packages/business/src/media-reference/paths.ts';
import {run} from '../packages/business/src/media.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const at='2026-11-03T01:00:00.000Z',later='2026-11-03T02:00:00.000Z';
type Tables=Record<ProjectSnapshotTable,SnapshotRow[]>;
function fixture(t:TestContext,sharedProjectId?:string){
 const root=mkdtempSync(path.join(tmpdir(),'version-domain-')),{store,projectId}=createServerProject(root,{name:'Original',...(sharedProjectId?{projectId:sharedProjectId}:{})});
 store.tx(()=>store.put('timelines',newTimelineRecord(projectId,{fps:30,width:1080,height:1920},()=>at)));
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const capture=()=>store.tx(()=>captureProjectDocumentInside(store));
 const restore=(saved:ProjectDocument)=>store.tx(()=>{const plan=buildRestorePlan(store,saved,captureProjectDocumentInside(store),0,at);applyRestorePlanInside(store,plan,{requestId:randomUUID(),now:later});return plan;});
 const state=()=>JSON.stringify(PROJECT_SNAPSHOT_TABLES.map(table=>store.db.prepare(`SELECT * FROM project.${table} ORDER BY rowid`).all()));
 const asset=()=>{const id=randomUUID();return store.put('assets',{id,projectId,name:'Input.png',mimeType:'image/png',sha256:'a'.repeat(64),sizeBytes:1,relativePath:`media/${id}.png`,provenance:'user-import',width:1080,height:1920,duration:null,hasAudio:false,hasVideo:true});};
 const record=(table:string,id:string)=>store.get(table,id) as Record<string,unknown>|null;
 const timeline=()=>store.list('timelines',projectId)[0] as TimelineRecord;
 return{root,store,projectId,capture,restore,state,asset,record,timeline};
}
function revise(base:ProjectDocument,apply:(tables:Tables)=>void):ProjectDocument{
 const copy=structuredClone(base);apply(copy.tables as Tables);
 for(const table of PROJECT_SNAPSHOT_TABLES)(copy.tables[table] as SnapshotRow[]).sort((a,b)=>rowKey(table,a)<rowKey(table,b)?-1:rowKey(table,a)>rowKey(table,b)?1:0);
 return validateProjectDocument(copy);
}
function insert(f:ReturnType<typeof fixture>,table:ProjectSnapshotTable,row:SnapshotRow):void{
 const columns=tableColumns(table);f.store.db.prepare(`INSERT INTO project.${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(column=>snapshotCellValue(row[column])));
}
function scene(projectId:string,assetId:string,position=1):SnapshotRow{return{id:randomUUID(),projectId,assetId,position,sourceHash:'a'.repeat(64),origin:'detected',taskId:randomUUID(),basedOnResultId:null,requestId:null,profileId:'scene-cuts-v1',fps:30,frameCount:30,options:'{}',cuts:'[0]',createdAt:at};}

/** Portable rows retain the real publisher proof and matching immutable result;
 * only their originating machine keeps the task history. */
async function generatedImages(f:ReturnType<typeof fixture>,count=1){
 const services=createServices(f.store,new Map(),{imageOptions:{autoRun:true},frameOptions:{autoRun:false},sceneOptions:{autoRun:false}});
 const results:Array<{asset:SnapshotRow;group:SnapshotRow;version:SnapshotRow}>=[];let groupId:string|undefined;
 try{
  for(let index=0;index<count;index++){
   const group=groupId?imageGroupResponseSchema.parse(await services.call('image.group.get',{projectId:f.projectId,groupId})):undefined;
   let task=imageTaskResponseSchema.parse(await services.call('image.generate',{projectId:f.projectId,name:'Portable images',prompt:'Real mock publication for a portable snapshot',providerId:'mock',model:IMAGE_MODELS.mock,options:IMAGE_FIXED_OPTIONS,requestId:randomUUID(),...(group?{groupId:group.id,expectedRevision:group.revision}:{})}));
   const deadline=Date.now()+10000;
   while(task.state!=='succeeded'&&Date.now()<deadline){await pause(5);task=imageTaskResponseSchema.parse(await services.call('image.task.get',{projectId:f.projectId,taskId:task.id}));}
   assert.equal(task.state,'succeeded');groupId=task.groupId;
   const captured=f.capture(),version=captured.tables.image_versions.find(row=>row.taskId===task.id),owner=captured.tables.image_groups.find(row=>row.id===groupId);
   assert.ok(version);assert.ok(owner);const asset=captured.tables.assets.find(row=>row.id===version.assetId);assert.ok(asset);
   results.push({asset,group:owner,version});
  }
  return results;
 }finally{await services.drain();}
}

test('restore applies mutable fields, advances current revisions and removes new unreferenced rows',t=>{
 const f=fixture(t),shotId=randomUUID();f.store.put('shots',{id:shotId,projectId:f.projectId,title:'Before',revision:7,createdAt:at,updatedAt:at});
 const saved=f.capture();f.store.put('shots',{id:shotId,projectId:f.projectId,title:'After',revision:12,createdAt:at,updatedAt:later});
 const nodeId=randomUUID();f.store.put('nodes',{id:nodeId,projectId:f.projectId,type:'note',text:'New'});
 const before=f.capture(),plan=f.restore(saved),shot=f.record('shots',shotId)!;
 assert.equal(shot.title,'Before');assert.equal(shot.revision,13);assert.equal(shot.createdAt,at);assert.equal(shot.updatedAt,later);
 assert.equal(f.record('nodes',nodeId),null);assert.ok(f.capture().evidence.contentSequence>before.evidence.contentSequence);
 assert.ok(plan.changes.some(c=>c.table==='nodes'&&c.action==='remove'));
 assert.ok(Number(f.store.db.prepare("SELECT revision FROM project.agent_task_target_revisions_v2 WHERE kind='shot' AND targetId=?").get(shotId)?.revision)>Number(before.evidence.targetRevisions.find(r=>r.kind==='shot'&&r.targetId===shotId)?.revision));
});

test('missing owners and all retained result kinds return with their real IDs and no synthetic jobs',async t=>{
 const f=fixture(t),[image]=await generatedImages(fixture(t,f.projectId));assert.ok(image);
 const base=f.capture(),assetId=randomUUID(),imageAsset=String(image.asset.id),subjectAsset=randomUUID(),shotId=randomUUID(),subjectId=randomUUID(),subjectVersion=randomUUID(),groupId=String(image.group.id),imageVersion=String(image.version.id),versionId=randomUUID(),lutId=randomUUID(),detected=scene(f.projectId,assetId);
 const saved=revise(base,tables=>{
  tables.assets=[assetId,imageAsset,subjectAsset].map(id=>id===imageAsset?image.asset:({id,projectId:f.projectId,data:canonicalJson(referenceTestAsset(f.store.projectDir,{id,projectId:f.projectId,name:'Restored.png',mimeType:'image/png',sha256:'a'.repeat(64),sizeBytes:1,relativePath:`media/${id}.png`,provenance:'user-import',width:1080,height:1920,duration:null,hasAudio:false,hasVideo:true}))}));
  tables.shots=[{id:shotId,projectId:f.projectId,data:canonicalJson({id:shotId,projectId:f.projectId,title:'Restored',revision:1,selectedVersionId:versionId,versionIds:[versionId]})}];
  const jobId=randomUUID();tables.versions=[{id:versionId,projectId:f.projectId,jobId,data:canonicalJson({id:versionId,projectId:f.projectId,jobId,shotId,assetId,sha256:'a'.repeat(64)})}];
  tables.subjects=[{id:subjectId,projectId:f.projectId,kind:'character',name:'Person',revision:1,headVersionId:subjectVersion,createdAt:at,updatedAt:at}];
  tables.subject_versions=[{id:subjectVersion,projectId:f.projectId,subjectId,number:1,assetId:subjectAsset,data:canonicalJson({id:subjectVersion,projectId:f.projectId,subjectId,number:1,assetId:subjectAsset,sha256:'a'.repeat(64),mimeType:'image/png',width:1080,height:1920,provenance:{kind:'user-import',versionId:null,shotId:null,jobId:null},createdAt:at})}];
  tables.image_groups=[image.group];tables.image_versions=[image.version];
  tables.scene_results=[detected,{...scene(f.projectId,assetId,2),origin:'manual',taskId:null,basedOnResultId:detected.id,requestId:randomUUID(),options:null}];
  tables.project_lut_resources=[{id:lutId,projectId:f.projectId,name:'LUT',sha256:'b'.repeat(64),sizeBytes:1,profile:'mioon-cube3d-normalized-tetrahedral-v1',metadata:'{}',content:{type:'blob',base64:'eA=='},createdAt:at}];
 });
 f.restore(saved);

 assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(assetId),{code:'INSPECTION_UNAVAILABLE'},'the original portable legacy owner already lacks its local job before capture');
 assert.equal(createOwnedMediaGraphReader(f.store.db,f.projectId).asset(imageAsset).id,imageAsset,'portable image result is readable before capture without a local task');
 const sourceSubjects=createSubjectServices(f.store,{canonical:canonicalJson,now:()=>later}),sourceInput={projectId:f.projectId};
 assert.equal(isSubjectListResponse('subject.list',sourceInput,sourceSubjects.handlers['subject.list']!(sourceInput)),true);
 const original=f.capture(),target=fixture(t,f.projectId);target.restore(original);
 for(const [table,id]of [['assets',assetId],['shots',shotId],['versions',versionId],['subjects',subjectId],['subject_versions',subjectVersion],['image_groups',groupId],['image_versions',imageVersion],['project_lut_resources',lutId]] as const)assert.equal(target.store.db.prepare(`SELECT id FROM project.${table} WHERE id=?`).get(id)?.id,id);
 assert.equal(target.store.db.prepare('SELECT count(*) n FROM project.scene_results').get()?.n,2);
 for(const table of ['jobs','image_tasks','scene_tasks','subject_variant_batches'])assert.equal(target.store.db.prepare(`SELECT count(*) n FROM main.${table}`).get()?.n,0,table);
 assert.equal(createOwnedMediaGraphReader(target.store.db,target.projectId).asset(subjectAsset).id,subjectAsset);
 assert.equal(createOwnedMediaGraphReader(target.store.db,target.projectId).asset(imageAsset).id,imageAsset);
 assert.throws(()=>createOwnedMediaGraphReader(target.store.db,target.projectId).asset(assetId),{code:'INSPECTION_UNAVAILABLE'},'a missing legacy job stays unavailable, never fabricated');
 const subjects=createSubjectServices(target.store,{canonical:canonicalJson,now:()=>later});
 const input={projectId:target.projectId};assert.equal(isSubjectListResponse('subject.list',input,subjects.handlers['subject.list']!(input)),true);
 assert.deepEqual(target.store.db.prepare('PRAGMA project.foreign_key_check').all(),[]);
});

test('annotation defaults and binding tombstones keep their owner and advance rather than rewinding revisions',t=>{
 const f=fixture(t),asset=f.asset(),base=f.capture(),shotId=randomUUID(),subjectId=randomUUID(),versionId=randomUUID(),binding=randomUUID();
 const populated=revise(base,tables=>{
  tables.shots=[{id:shotId,projectId:f.projectId,data:canonicalJson({id:shotId,projectId:f.projectId,title:'Owner',revision:1})}];
  tables.subjects=[{id:subjectId,projectId:f.projectId,kind:'character',name:'Person',revision:1,headVersionId:versionId,createdAt:at,updatedAt:at}];
  tables.subject_versions=[{id:versionId,projectId:f.projectId,subjectId,number:1,assetId:asset.id,data:canonicalJson({id:versionId,projectId:f.projectId,subjectId,number:1,assetId:asset.id})}];
  tables.subject_bindings=[{id:binding,projectId:f.projectId,shotId,subjectId,role:'subject',revision:4,subjectVersionId:versionId,reviewedHeadVersionId:versionId,createdAt:at,updatedAt:at}];
  tables.asset_annotations=[{assetId:asset.id,projectId:f.projectId,revision:8,tags:'["later"]',note:'Later'}];
 });
 f.restore(populated);const before=f.capture(),plan=f.restore(base);
 assert.deepEqual({...f.store.db.prepare('SELECT tags,note,revision FROM project.asset_annotations WHERE assetId=?').get(asset.id)},{tags:'[]',note:'',revision:10});
 const row=f.store.db.prepare('SELECT subjectVersionId,reviewedHeadVersionId,revision FROM project.subject_bindings WHERE id=?').get(binding)!;
 assert.equal(row.subjectVersionId,null);assert.equal(row.reviewedHeadVersionId,versionId);assert.equal(row.revision,6);
 assert.ok(f.record('shots',shotId));assert.equal(plan.changes.find(c=>c.table==='shots')?.action,'keep-current');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM project.subject_versions').get()?.n,1);assert.ok(f.capture().evidence.contentSequence>before.evidence.contentSequence);
});

test('restore scope only admits exact missing approved rows and never creates ordinary publication permission',t=>{
 const f=fixture(t),asset=f.asset(),row=scene(f.projectId,asset.id),document=revise(f.capture(),tables=>{tables.scene_results=[row];});
 assert.throws(()=>f.store.tx(()=>insert(f,'scene_results',row)),/scene result must bind/);
 f.store.tx(()=>withProjectRestoreScopeInside(f.store,document,[{table:'scene_results',row}],()=>{
  assert.throws(()=>insert(f,'scene_results',{...row,id:randomUUID()}),/scene result must bind/);
  assert.throws(()=>insert(f,'scene_results',{...row,sourceHash:'c'.repeat(64)}),/scene result must bind/);
  insert(f,'scene_results',row);
 }));
 assert.equal(f.store.db.prepare('SELECT id FROM project.scene_results').get()?.id,row.id);
 assert.throws(()=>f.store.tx(()=>insert(f,'scene_results',scene(f.projectId,asset.id,2))),/scene result must bind/);
 assert.equal(f.store.db.prepare("SELECT mioon_restore_row_allowed('scene_results','{}') allowed").get()?.allowed,0);
});

test('forged plans and copied stores reject without scope; throwing and asynchronous scopes cannot leak permission',t=>{
 const f=fixture(t),asset=f.asset(),row=scene(f.projectId,asset.id),document=revise(f.capture(),tables=>{tables.scene_results=[row];}),before=f.state();
 f.store.tx(()=>{
  assert.throws(()=>applyRestorePlanInside(f.store,{changes:[],document} as RestorePlan,{requestId:randomUUID()}),/plan from this live store/);
  assert.throws(()=>withProjectRestoreScopeInside({...f.store},document,[{table:'scene_results',row}],()=>{}),/original live store/);
  assert.throws(()=>withProjectRestoreScopeInside(f.store,document,[{table:'scene_results',row}],()=>{throw Error('Injected');}),/Injected/);
  assert.throws(()=>withProjectRestoreScopeInside(f.store,document,[{table:'scene_results',row}],()=>Promise.resolve()),/asynchronous boundary/);
  assert.throws(()=>insert(f,'scene_results',row),/scene result must bind/);
 });
 assert.equal(f.state(),before);
 assert.equal(f.store.db.prepare("SELECT mioon_restore_row_allowed('scene_results','{}') allowed").get()?.allowed,0);
});

test('constraint failures roll back all prior restored content and clear exact-row admission',t=>{
 const f=fixture(t),asset=f.asset(),saved=revise(f.capture(),tables=>{tables.projects=[{id:f.projectId,data:canonicalJson({id:f.projectId,name:'Will roll back'})}];tables.scene_results=[scene(f.projectId,asset.id)];}),before=f.state();
 const prepare=f.store.db.prepare;
 const fault=t.mock.method(f.store.db,'prepare',function(this:DatabaseSync,sql:string){if(sql==='PRAGMA project.foreign_key_check')throw Error('Injected after writes');return prepare.call(this,sql);});
 assert.throws(()=>f.restore(saved),/Injected after writes/);fault.mock.restore();
 assert.equal(f.state(),before);assert.throws(()=>f.store.tx(()=>insert(f,'scene_results',saved.tables.scene_results[0])),/scene result must bind/);
});

test('existing legal media references stay current as a coherent identity while other asset fields restore',t=>{
 const f=fixture(t),id=randomUUID(),reference={pathForm:'relative' as const,path:'fixed.png',volume:null,sizeBytes:1,mtimeMs:1,sampledSha256:'a'.repeat(64),fullSha256:'a'.repeat(64)};
 f.store.put('assets',{id,projectId:f.projectId,name:'Saved name',mimeType:'image/png',sizeBytes:1,sha256:'a'.repeat(64),width:1080,height:1920,duration:null,reference:{...reference,path:'old.png'},referenceRevision:1});
 const saved=f.capture();f.store.put('assets',{...f.record('assets',id),name:'Current name',reference,referenceRevision:3});
 const plan=f.restore(saved),asset=f.record('assets',id)!;
 assert.equal(asset.name,'Saved name');assert.deepEqual(asset.reference,reference);assert.equal(asset.referenceRevision,3);assert.equal(assetMediaRecordSchema.safeParse(asset).success,true);
 assert.match(plan.changes.find(c=>c.table==='assets')!.reason!,/定位.*保持当前/);assert.equal(JSON.stringify(plan.changes).includes('fixed.png'),false);
});

function realMediaFixture(t:TestContext){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'version-real-reference-')),{store,projectId}=createServerProject(root,{name:'Real references'});
 const library=testProjectAppLibrary(store)!;assert.ok(library);
 const services=createServices(store,new Map(),{application:createProjectServiceApplication(library,undefined,{}),env:{},imageOptions:{autoRun:false},frameOptions:{autoRun:false},sceneOptions:{autoRun:false}});
 const media=createAssetMediaServices(store,{outsidePaths:library.outsidePaths}),references=createProjectAssetReferenceServices(store,{outsidePaths:library.outsidePaths});
 const external=path.join(root,'external');mkdirSync(external);
 t.after(async()=>{await services.drain();store.close();rmSync(root,{recursive:true,force:true});});
 const asset=(id:string)=>{const row=store.db.prepare('SELECT data FROM project.assets WHERE id=?').get(id);assert.ok(row);const{url:_url,...record}=JSON.parse(String(row.data)) as Record<string,unknown>;return assetMediaRecordSchema.parse(record);};
 const capture=()=>store.tx(()=>captureProjectDocumentInside(store));
 const restore=(saved:ProjectDocument)=>store.tx(()=>{const plan=buildRestorePlan(store,saved,captureProjectDocumentInside(store),0,at);applyRestorePlanInside(store,plan,{requestId:randomUUID(),now:later});return plan;});
 const importPath=async(file:string)=>{const result=await media.trustedCall('asset.import.path',{projectId,sourcePath:file,requestId:randomUUID()}) as {asset:{id:string}};return asset(result.asset.id);};
 return{root,store,projectId,library,services,media,references,external,asset,capture,restore,importPath};
}
// Compare names, not database bytes: opening another file descriptor for a
// held SQLite file would itself interfere with the kernel's native locks.
function directoryEntries(root:string):string[]{
 const result:string[]=[];
 const visit=(directory:string):void=>{for(const entry of readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);result.push(path.relative(root,file));if(entry.isDirectory())visit(file);}};
 visit(root);return result.sort();
}

test('real sampled-video import keeps the prepared full-hash identity while mutable metadata restores',async t=>{
 const f=realMediaFixture(t),file=path.join(f.store.projectDir,'sampled.mp4');
 await run('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=32x32:d=0.1','-c:v','libx264','-pix_fmt','yuv420p','-y',file]);
 const imported=await f.importPath(file),saved=f.capture(),bytes=readFileSync(file);
 assert.equal(imported.sha256,null);assert.equal(imported.reference.fullSha256,null);assert.equal(imported.referenceRevision,1);
 await f.media.call('asset.media.prepare',{projectId:f.projectId,assets:[{assetId:imported.id,referenceRevision:1}],purpose:'frame'});
 const current=f.asset(imported.id);assert.equal(current.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(current.reference.fullSha256,current.sha256);
 f.store.put('assets',{...current,name:'Changed after version'});
 const grants=f.library.outsidePaths.list(f.projectId),files=directoryEntries(f.store.projectDir),plan=f.restore(saved),restored=f.asset(imported.id);
 assert.deepEqual(restored,{...imported,reference:current.reference,referenceRevision:current.referenceRevision,sha256:current.sha256,sizeBytes:current.sizeBytes});
 assert.equal(restored.name,imported.name);assert.notEqual(restored.name,'Changed after version');
 assert.match(plan.changes.find(change=>change.table==='assets')!.reason!,/定位.*保持当前/);
 assert.equal((await f.references.inspect(imported.id)).readable,true);
 assert.deepEqual((await f.references.read(imported.id,{maxBytes:bytes.length,expectedSha256:current.sha256!})).bytes,bytes);
 assert.deepEqual(readFileSync(file),bytes);assert.deepEqual(directoryEntries(f.store.projectDir),files);assert.deepEqual(f.library.outsidePaths.list(f.projectId),grants);
});

for(const deleteMedia of [false,true])test(`real deleted imported assets restore only references with ${deleteMedia?'removed':'retained'} media and never regrant outside access`,async t=>{
 const f=realMediaFixture(t),bytes=png(),outside=path.join(f.external,'outside.png');writeFileSync(outside,bytes);
 const upload=await f.services.call('asset.import',{projectId:f.projectId,name:'Uploaded.png',mimeType:'image/png',dataBase64:bytes.toString('base64'),requestId:randomUUID()}) as {id:string};
 const managed=f.asset(upload.id),external=await f.importPath(outside),managedFile=resolveReferencePath(f.store.projectDir,managed.reference)!;
 assert.ok(managedFile);assert.equal(managed.reference.path.startsWith('素材/'),true);assert.equal(resolveReferencePath(f.store.projectDir,external.reference),outside);
 assert.equal((await f.references.inspect(managed.id)).readable,true);assert.equal((await f.references.inspect(external.id)).readable,true);
 assert.deepEqual(f.library.outsidePaths.list(f.projectId).map(grant=>grant.directory),[f.external]);
 const saved=f.capture();
 f.store.tx(()=>{for(const id of [managed.id,external.id])assert.equal(f.store.db.prepare('DELETE FROM project.assets WHERE id=?').run(id).changes,1);});
 if(deleteMedia){unlinkSync(managedFile);unlinkSync(outside);}
 f.library.outsidePaths.revoke(f.projectId,f.external);
 const grants=f.library.outsidePaths.list(f.projectId),projectFiles=directoryEntries(f.store.projectDir),outsideFiles=directoryEntries(f.external);
 assert.deepEqual(grants,[]);assert.equal(f.store.get('assets',managed.id),null);assert.equal(f.store.get('assets',external.id),null);
 const plan=f.restore(saved);
 for(const original of [managed,external]){assert.deepEqual(f.asset(original.id),original);assert.equal(plan.changes.find(change=>change.table==='assets'&&change.key===rowKey('assets',{id:original.id,projectId:f.projectId}))?.action,'add');}
 assert.equal(f.store.list('assets',f.projectId).length,2);assert.deepEqual(f.library.outsidePaths.list(f.projectId),grants);
 assert.deepEqual(directoryEntries(f.store.projectDir),projectFiles);assert.deepEqual(directoryEntries(f.external),outsideFiles);
 const localState=await f.references.inspect(managed.id),outsideState=await f.references.inspect(external.id);
 assert.equal(localState.status,deleteMedia?'missing':'online');assert.equal(localState.readable,!deleteMedia);
 assert.equal(outsideState.status,deleteMedia?'missing':'online');assert.equal(outsideState.outside,true);assert.equal(outsideState.readable,false);
 if(deleteMedia){assert.equal(existsSync(managedFile),false);assert.equal(existsSync(outside),false);await assert.rejects(f.references.read(managed.id,{maxBytes:bytes.length}),{code:'MEDIA_MISSING'});}
 else{assert.deepEqual(readFileSync(managedFile),bytes);assert.deepEqual(readFileSync(outside),bytes);assert.deepEqual((await f.references.read(managed.id,{maxBytes:bytes.length})).bytes,bytes);await assert.rejects(f.references.read(external.id,{maxBytes:bytes.length}),{code:'MEDIA_OUTSIDE_NOT_CONFIRMED'});}
 assert.deepEqual(f.library.outsidePaths.list(f.projectId),[]);
});

test('a real cross-directory relink stays readable after restore without reinstating the old directory grant',async t=>{
 const f=realMediaFixture(t),oldDirectory=path.join(f.external,'old'),newDirectory=path.join(f.external,'new'),bytes=png();mkdirSync(oldDirectory);mkdirSync(newDirectory);
 const originalFile=path.join(oldDirectory,'original.png'),permissionFile=path.join(newDirectory,'another.png'),movedFile=path.join(newDirectory,'moved.png');
 writeFileSync(originalFile,bytes);writeFileSync(permissionFile,png({width:32}));
 const imported=await f.importPath(originalFile);await f.importPath(permissionFile);
 assert.equal(imported.referenceRevision,1);const saved=f.capture();
 renameSync(originalFile,movedFile);
 const preview=await f.media.call('asset.media.relink.preview',{projectId:f.projectId,assetId:imported.id,sourcePath:movedFile,expectedReferenceRevision:1}) as {previewToken:string;chosen:{matches:boolean}};
 assert.equal(preview.chosen.matches,true);
 await f.media.call('asset.media.relink.apply',{projectId:f.projectId,requestId:randomUUID(),previewToken:preview.previewToken});
 const linked=f.asset(imported.id);assert.equal(linked.referenceRevision,2);assert.equal(resolveReferencePath(f.store.projectDir,linked.reference),movedFile);assert.notDeepEqual(linked.reference,imported.reference);
 f.store.put('assets',{...linked,name:'Relinked current name'});f.library.outsidePaths.revoke(f.projectId,oldDirectory);
 const grants=f.library.outsidePaths.list(f.projectId),files=directoryEntries(f.external);assert.deepEqual(grants.map(grant=>grant.directory),[newDirectory]);
 f.restore(saved);const restored=f.asset(imported.id),state=await f.references.inspect(imported.id);
 assert.deepEqual(restored,{...imported,reference:linked.reference,referenceRevision:2,sha256:linked.sha256,sizeBytes:linked.sizeBytes});
 assert.equal(state.status,'online');assert.equal(state.outside,true);assert.equal(state.readable,true);assert.equal(state.referenceRevision,2);
 assert.deepEqual((await f.references.read(imported.id,{maxBytes:bytes.length,expectedReferenceRevision:2,expectedSha256:linked.sha256!})).bytes,bytes);
 assert.equal(existsSync(originalFile),false);assert.deepEqual(readFileSync(movedFile),bytes);assert.deepEqual(directoryEntries(f.external),files);assert.deepEqual(f.library.outsidePaths.list(f.projectId),grants);
});

function timelineDomain(f:ReturnType<typeof fixture>){return createTimelineServices(f.store as unknown as Parameters<typeof createTimelineServices>[0],{
 required:(table,id)=>{if(!f.record(table,id))throw Error('Missing project');},check:(timeline,expected)=>assert.equal(timeline.revision,expected),hash:value=>createHash('sha256').update(canonicalJson(value)).digest('hex'),now:()=>later,exportAdmission:{render:()=>{throw Error('No render');}},
});}
function travel(f:ReturnType<typeof fixture>,operation:'timeline.undo'|'timeline.redo',revision:number):unknown{
 const handler=timelineDomain(f).handlers[operation]!,input={projectId:f.projectId,requestId:randomUUID(),expectedRevision:revision};
 return handler(input as Parameters<typeof handler>[0]);
}

test('timeline restore preserves unchanged target JSON spelling and revisions and appends a coherent undo branch',t=>{
 const f=fixture(t),asset=f.asset(),timeline=f.timeline(),track=randomUUID(),first=randomUUID(),second=randomUUID();
 const clip=(id:string,startFrame:number)=>({id,trackId:track,assetId:asset.id,name:'中',startFrame,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:1080,height:1920},gain:1});
 f.store.put('timelines',{...timeline,revision:2,tracks:[{id:track,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],clips:[clip(first,0),clip(second,30)],durationFrames:60,updatedAt:at});
 const saved=f.capture(),changed=f.record('timelines',String(timeline.id))!;
 const clips=changed.clips as ReturnType<typeof clip>[];clips[0].gain=0.5;
 f.store.put('timelines',{...changed,clips,revision:3,updatedAt:later});
 f.store.db.prepare("UPDATE project.timelines SET data=replace(data,'中','\\u4e2d') WHERE id=?").run(String(timeline.id));
 const child=()=>f.store.db.prepare("SELECT value FROM json_each((SELECT data FROM project.timelines WHERE id=?),'$.clips') WHERE json_extract(value,'$.id')=?").get(String(timeline.id),second)!.value;
 const ledger=(id:string)=>f.store.db.prepare("SELECT revision FROM project.agent_task_target_revisions_v2 WHERE kind='timeline_clip' AND targetId=?").get(id)!.revision;
 const untouched=child(),independentRevision=ledger(second),changedRevision=Number(ledger(first));f.restore(saved);
 assert.equal(child(),untouched);assert.equal(ledger(second),independentRevision);assert.equal(ledger(first),changedRevision+1);
 const restored=f.record('timelines',String(timeline.id))!;assert.equal(restored.revision,4);assert.equal((restored.clips as ReturnType<typeof clip>[])[0].gain,1);
 assert.equal(f.store.db.prepare('SELECT operation FROM main.timeline_history ORDER BY position DESC LIMIT 1').get()?.operation,'project.version.restore');
 travel(f,'timeline.undo',4);
 assert.equal((f.record('timelines',String(timeline.id))!.clips as ReturnType<typeof clip>[])[0].gain,0.5);
});

test('restored timeline format participates in manual undo and redo without clearing original history',t=>{
 const f=fixture(t),saved=f.capture(),timeline=f.timeline();
 f.store.put('timelines',{...timeline,width:1920,height:1080,revision:Number(timeline.revision)+1});
 f.restore(saved);const restored=f.record('timelines',String(timeline.id))!;
 assert.equal(restored.width,timeline.width);assert.equal(restored.height,timeline.height);
 travel(f,'timeline.undo',Number(restored.revision));
 let current=f.record('timelines',String(timeline.id))!;assert.equal(current.width,1920);assert.equal(current.height,1080);
 travel(f,'timeline.redo',Number(current.revision));
 current=f.record('timelines',String(timeline.id))!;assert.equal(current.width,timeline.width);assert.equal(current.height,timeline.height);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.timeline_history').get()?.n,1);
});

test('an aggregate absent from the snapshot stays current when retained editing history needs its owner',t=>{
 const f=fixture(t),saved=revise(f.capture(),tables=>{tables.timelines=[];}),timeline=f.timeline();
 f.store.db.prepare('INSERT INTO main.timeline_history(id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,1,?,?,?,?)').run(randomUUID(),f.projectId,'timeline.track.add',at,'{}','{}');
 const before=f.state(),plan=f.restore(saved),change=plan.changes.find(c=>c.table==='timelines')!;
 assert.equal(change.action,'keep-current');assert.match(change.reason!,/编辑历史.*保持当前/);assert.equal(f.state(),before);
 assert.equal(f.record('timelines',String(timeline.id))!.revision,timeline.revision);assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.timeline_history').get()?.n,1);
});

test('a real subject.create remains readable after canonical capture and missing-row restoration, while changed provenance still rejects',t=>{
 const source=fixture(t),asset=source.asset(),subjects=createSubjectServices(source.store,{canonical:canonicalJson,now:()=>at});
 const created=subjects.handlers['subject.create']!({projectId:source.projectId,kind:'character',name:'Real subject',assetId:asset.id,requestId:randomUUID()});
 assert.ok(isSubjectResponse(created));
 const input={projectId:source.projectId},read=()=>subjects.handlers['subject.list']!(input);
 assert.equal(isSubjectListResponse('subject.list',input,read()),true,'the real pre-capture row is readable');
 const raw=String(source.store.db.prepare('SELECT data FROM project.subject_versions WHERE id=?').get(created.headVersionId)!.data),saved=source.capture();
 assert.notEqual(raw,saved.tables.subject_versions[0].data,'the production record used a different object-key order');
 const target=fixture(t,source.projectId);target.restore(saved);
 const restoredSubjects=createSubjectServices(target.store,{canonical:canonicalJson,now:()=>later}),list=()=>restoredSubjects.handlers['subject.list']!(input);
 assert.equal(isSubjectListResponse('subject.list',input,list()),true);
 const imported=createOwnedMediaGraphReader(target.store.db,target.projectId).subjectVersion(created.headVersionId);
 assert.ok(isSubjectVersionResponse(imported));assert.equal(imported.assetId,asset.id);
 const plain=JSON.parse(String(saved.tables.subject_versions[0].data)) as Record<string,unknown>;
 for(const patch of [{width:1079},{provenance:{kind:'export',versionId:null,shotId:null,jobId:null}}]){
  const forged=revise(saved,tables=>{tables.subject_versions=[{...tables.subject_versions[0],data:canonicalJson({...plain,...patch})}];});
  const rejected=fixture(t,source.projectId);rejected.restore(forged);
  assert.throws(()=>createOwnedMediaGraphReader(rejected.store.db,rejected.projectId).subjectVersion(created.headVersionId),{code:'INSPECTION_UNAVAILABLE'});
 }
});

test('missing mutable rows advance beyond live deletion-ledger evidence without importing old revision counters',t=>{
 const f=fixture(t),asset=f.asset(),shotId=randomUUID(),saved=revise(f.capture(),tables=>{
  tables.shots=[{id:shotId,projectId:f.projectId,data:canonicalJson({id:shotId,projectId:f.projectId,title:'Returned',revision:2})}];
  tables.asset_annotations=[{assetId:asset.id,projectId:f.projectId,revision:3,tags:'[]',note:'Returned'}];
 });
 const seed=f.store.db.prepare('INSERT INTO project.agent_task_target_revisions_v2(projectId,kind,targetId,revision) VALUES(?,?,?,?)');
 seed.run(f.projectId,'shot',shotId,50);seed.run(f.projectId,'asset_annotation',asset.id,80);
 const timeline=f.timeline();f.store.db.prepare('DELETE FROM project.timelines WHERE id=?').run(timeline.id);
 f.store.db.prepare("UPDATE project.agent_task_target_revisions_v2 SET revision=100 WHERE projectId=? AND kind='timeline' AND targetId=?").run(f.projectId,f.projectId);
 f.restore(saved);
 assert.equal(f.record('shots',shotId)!.revision,51);assert.equal(f.store.db.prepare('SELECT revision FROM project.asset_annotations WHERE assetId=?').get(asset.id)?.revision,81);
 assert.equal(f.timeline().revision,101);
 assert.equal(f.store.db.prepare("SELECT revision FROM project.agent_task_target_revisions_v2 WHERE kind='shot' AND targetId=?").get(shotId)?.revision,51);
});

test('valid Cube metadata and immutable bytes remain readable after canonical snapshot restoration',t=>{
 const source=fixture(t),content=Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'),parsed=parseLutBytes(content),id=randomUUID();
 source.store.db.prepare('INSERT INTO project.project_lut_resources(id,projectId,name,sha256,sizeBytes,profile,metadata,content,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').run(id,source.projectId,'Real LUT',lutHash(content),content.length,LUT_RESOURCE_PROFILE,JSON.stringify(parsed.metadata),content,at);
 const original=readLutResource(source.store.db,source.projectId,id,true),saved=source.capture(),target=fixture(t,source.projectId);target.restore(saved);
 assert.deepEqual(readLutResource(target.store.db,target.projectId,id,true),original);
 assert.deepEqual(Buffer.from(target.store.db.prepare('SELECT content FROM project.project_lut_resources WHERE id=?').get(id)!.content as Uint8Array),content);
});

test('an exact restored variant may retain an undone batch, while mismatched batch identity remains forbidden',t=>{
 const f=fixture(t),asset=f.asset(),subjects=createSubjectServices(f.store,{canonical:canonicalJson,now:()=>at}),owner=subjects.handlers['subject.create']!({projectId:f.projectId,kind:'character',name:'Person',assetId:asset.id,requestId:randomUUID()});
 assert.ok(isSubjectResponse(owner));const batchId=randomUUID(),requestId=randomUUID(),input={projectId:f.projectId,subjectId:owner.id,sourceVersionId:owner.headVersionId,kind:'angle',requestId};
 const snapshot={schemaVersion:1,batchId,projectId:f.projectId,subjectId:owner.id,sourceVersionId:owner.headVersionId,kind:'angle',items:[{}]};
 f.store.db.prepare("INSERT INTO main.subject_variant_batches(id,projectId,subjectId,sourceVersionId,kind,requestId,inputHash,input,snapshot,state,revision,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?, ?,?,'active',1,?,?)").run(batchId,f.projectId,owner.id,owner.headVersionId,'angle',requestId,'a'.repeat(64),JSON.stringify(input),JSON.stringify(snapshot),at,at);
 f.store.db.prepare("UPDATE main.subject_variant_batches SET state='undone',revision=2,updatedAt=? WHERE id=?").run(later,batchId);
 const id=randomUUID(),row={id,projectId:f.projectId,subjectId:owner.id,number:2,assetId:asset.id,data:canonicalJson({...owner.headVersion,id,number:2,variant:{kind:'angle',position:'front',focal:'standard',batchId,sourceVersionId:owner.headVersionId}})};
 assert.throws(()=>f.store.tx(()=>insert(f,'subject_versions',row)),/active batch/);
 const saved=revise(f.capture(),tables=>{tables.subject_versions.push(row);tables.subjects[0]={...tables.subjects[0],revision:2};});
 f.restore(saved);assert.equal(f.store.db.prepare('SELECT id FROM project.subject_versions WHERE id=?').get(id)?.id,id);
 assert.equal(f.store.db.prepare('SELECT state FROM main.subject_variant_batches WHERE id=?').get(batchId)?.state,'undone');
 assert.equal(f.store.db.prepare('SELECT revision FROM project.subjects WHERE id=?').get(owner.id)?.revision,2);
 const bad={...row,id:randomUUID(),number:3,data:canonicalJson({...JSON.parse(row.data),id:randomUUID(),number:3,variant:{kind:'angle',position:'front',focal:'standard',batchId,sourceVersionId:randomUUID()}})};
 bad.data=canonicalJson({...JSON.parse(bad.data),id:bad.id});
 const invalid=revise(f.capture(),tables=>{tables.subject_versions.push(bad);});
 f.store.tx(()=>assert.throws(()=>withProjectRestoreScopeInside(f.store,invalid,[{table:'subject_versions',row:bad}],()=>insert(f,'subject_versions',bad)),/active batch/));
});

test('real head restoration followed by version.add leaves a legal numbering gap that restores without synthetic versions',t=>{
 const source=fixture(t),first=source.asset(),second=source.asset(),third=source.asset(),subjects=createSubjectServices(source.store,{canonical:canonicalJson,now:()=>at});
 const owner=subjects.handlers['subject.create']!({projectId:source.projectId,kind:'character',name:'Gapped subject',assetId:first.id,requestId:randomUUID()});assert.ok(isSubjectResponse(owner));
 const old=source.capture();
 const next=subjects.handlers['subject.version.add']!({projectId:source.projectId,subjectId:owner.id,expectedRevision:1,assetId:second.id,requestId:randomUUID()});assert.ok(isSubjectResponse(next));
 source.restore(old);
 const previous=Number(source.store.db.prepare('SELECT revision FROM project.subjects WHERE id=?').get(owner.id)!.revision);assert.equal(previous,3);
 const newest=subjects.handlers['subject.version.add']!({projectId:source.projectId,subjectId:owner.id,expectedRevision:previous,assetId:third.id,requestId:randomUUID()});assert.ok(isSubjectResponse(newest));assert.equal(newest.headVersion.number,4);
 assert.equal(source.store.db.prepare('SELECT id FROM project.subject_versions WHERE subjectId=? AND number=3').get(owner.id),undefined);
 const saved=source.capture(),target=fixture(t,source.projectId);
 target.store.tx(()=>{for(const row of old.tables.assets)insert(target,'assets',row);insert(target,'subjects',old.tables.subjects[0]);insert(target,'subject_versions',old.tables.subject_versions[0]);});
 target.restore(saved);
 const restored=createSubjectServices(target.store,{canonical:canonicalJson,now:()=>later}).handlers['subject.list']!({projectId:target.projectId});
 assert.equal(isSubjectListResponse('subject.list',{projectId:target.projectId},restored),true);
 assert.equal(target.store.db.prepare('SELECT headVersionId FROM project.subjects WHERE id=?').get(owner.id)?.headVersionId,newest.headVersionId);
 assert.ok(Number(target.store.db.prepare('SELECT revision FROM project.subjects WHERE id=?').get(owner.id)?.revision)>=4);
 assert.equal(target.store.db.prepare('SELECT id FROM project.subject_versions WHERE subjectId=? AND number=3').get(owner.id),undefined);
 assert.equal(target.store.db.prepare('SELECT count(*) n FROM project.subject_versions WHERE subjectId=?').get(owner.id)?.n,3);
});

test('a valid newer portable image snapshot cannot add versions beyond a retained older current head',async t=>{
 const f=fixture(t),[first,second]=await generatedImages(fixture(t,f.projectId),2);assert.ok(first);assert.ok(second);
 const versionId=String(first.version.id),secondId=String(second.version.id);
 const original=revise(f.capture(),tables=>{
  tables.assets=[first.asset];tables.image_groups=[first.group];tables.image_versions=[first.version];
 });
 f.restore(original);assert.equal(createImageOwnershipReader(f.store.db,f.projectId).version(versionId).number,1);
 const newer=revise(f.capture(),tables=>{
  tables.assets.push(second.asset);tables.image_versions.push(second.version);tables.image_groups[0]=second.group;
 });
 const source=fixture(t,f.projectId);source.restore(newer);assert.equal(createImageOwnershipReader(source.store.db,source.projectId).version(secondId).number,2);
 const saved=source.capture(),before=f.state();assert.throws(()=>f.restore(saved),{code:'PROJECT_VERSION_DEPENDENCY_CONFLICT'});assert.equal(f.state(),before);
 assert.equal(createImageOwnershipReader(f.store.db,f.projectId).version(versionId).number,1);
 for(const current of [f,source])assert.equal(current.store.db.prepare('SELECT count(*) n FROM main.image_tasks').get()?.n,0);
});

for(const [label,count,number]of [['a tiny snapshot with a huge safe numbering gap',1,Number.MAX_SAFE_INTEGER],['two subjects whose cumulative advances exceed the limit',2,6001]] as const)test(`restore preview bounds ${label} before any writes`,t=>{
 const f=fixture(t),asset=f.asset(),subjects=createSubjectServices(f.store,{canonical:canonicalJson,now:()=>at});
 const owners=Array.from({length:count},(_,index)=>{
  const value=subjects.handlers['subject.create']!({projectId:f.projectId,kind:'character',name:`Budget ${index}`,assetId:asset.id,requestId:randomUUID()});
  assert.ok(isSubjectResponse(value));return value;
 });
 const saved=revise(f.capture(),tables=>{
  for(const owner of owners){
   const id=randomUUID(),base=tables.subject_versions.find(row=>row.id===owner.headVersionId)!;
   tables.subject_versions.push({...base,id,number,data:canonicalJson({...owner.headVersion,id,number})});
   const index=tables.subjects.findIndex(row=>row.id===owner.id);tables.subjects[index]={...tables.subjects[index],revision:number,headVersionId:id};
  }
 });
 assert.ok(Buffer.byteLength(canonicalJson(saved))<20000,'a small legal SQL document cannot imply unbounded synchronous work');
 const before=f.state(),changes=f.store.db.prepare('SELECT total_changes() n').get()!.n;
 assert.throws(()=>f.restore(saved),{code:'PROJECT_VERSION_RESTORE_LIMIT',status:409});
 assert.equal(f.state(),before);assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,changes);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.project_versions').get()?.n,0);
});
