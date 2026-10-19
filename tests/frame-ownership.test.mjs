import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {imageFixture,insert} from './images-fixture.mjs';
import {migrateFrameSchema} from '../packages/business/src/frame-schema.ts';
import {createFrameOwnershipReader,FRAME_OWNERSHIP_LIMITS} from '../packages/business/src/frame-ownership.ts';
import {createOwnedMediaGraphReader,createInspectionServices,INSPECTION_OPERATIONS} from '../packages/business/src/inspection.ts';
import {createSubjectRecoveryBoundary,createSubjectServices} from '../packages/business/src/subjects.ts';
import {subjectVersionResponseSchema} from '../packages/contracts/src/subjects.ts';
import {FRAME_PROFILE,FRAME_PROFILE_ID,FRAME_SELECTION_RULE,canonicalFrameInput as canonical} from '../packages/contracts/src/frame-extraction.ts';

const at='2026-10-11T00:00:00.000Z';
const unavailable=error=>error.code==='INSPECTION_UNAVAILABLE'&&error.status===404&&!JSON.stringify(error).includes('private payload');
const budget=error=>error.code==='INSPECTION_BUDGET_EXCEEDED';
const graph=f=>createOwnedMediaGraphReader(f.db,f.projectId);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
function tx(db,fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
function changeAsset(f,asset,patch){f.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...asset,...patch}),asset.id);}
function corrupt(f){
 f.db.exec('PRAGMA foreign_keys=OFF;PRAGMA ignore_check_constraints=ON');
 for(const {name} of f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (tbl_name LIKE 'frame_%' OR name LIKE '%frame_asset_owner')").all())f.db.exec(`DROP TRIGGER ${name}`);
}
function sourceAsset(f,patch={}){
 const id=randomUUID(),source={id,projectId:f.projectId,name:'Source.mp4',mimeType:'video/mp4',sha256:'a'.repeat(64),relativePath:`media/${id}.mp4`,sizeBytes:128,duration:3,width:1920,height:1080,hasVideo:true,hasAudio:true,provenance:'user-import',createdAt:at,...patch};
 insert(f.db,'assets',{id,projectId:f.projectId,data:JSON.stringify(source)});return source;
}
function accept(f,source=sourceAsset(f)){
 const {db,projectId}=f,taskId=randomUUID(),requestId=randomUUID(),assetId=randomUUID();
 const input={projectId,sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:56,requestId},inputHash=hash(input);
 const snapshot={schemaVersion:1,projectId,taskId,source:{assetId:source.id,sha256:source.sha256,mimeType:source.mimeType,sizeBytes:source.sizeBytes,relativePath:source.relativePath,duration:source.duration,width:source.width,height:source.height},requested:{sourceFrame:56,fps:30},profile:FRAME_PROFILE};
 const receipt={schemaVersion:1,projectId,taskId,inputHash,sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,
  assetId,sha256:'b'.repeat(64),mimeType:'image/png',width:1024,height:576,byteLength:100,probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:1920,height:1080,rotation:0,sarNumerator:1,sarDenominator:1}};
 const ack={id:taskId,projectId,requestId,sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,state:'queued',revision:1,started:false,result:null,errorCode:null,createdAt:at,updatedAt:at};
 const row={id:taskId,projectId,requestId,inputHash,input:canonical(input),snapshot:canonical(snapshot),state:'queued',revision:1,started:0,stagedReceipt:null,assetId:null,errorCode:null,createdAt:at,updatedAt:at};
 const request={requestId,operation:'frame.extract',projectId,taskId,inputHash,canonicalInput:canonical(input),response:canonical(ack)};
 const asset={id:assetId,projectId,name:'Frame.png',sha256:receipt.sha256,mimeType:'image/png',provenance:'extracted-frame',relativePath:`media/${assetId}.png`,width:1024,height:576,sizeBytes:100,createdAt:at};
 tx(db,()=>{insert(db,'frame_tasks',row);insert(db,'frame_requests',request);});
 const start=()=>db.prepare("UPDATE frame_tasks SET state='running',started=1,revision=2 WHERE id=?").run(taskId);
 const stage=()=>db.prepare("UPDATE frame_tasks SET state='persisting',revision=3,stagedReceipt=? WHERE id=?").run(canonical(receipt),taskId);
 const publish=()=>tx(db,()=>{insert(db,'assets',{id:assetId,projectId,data:JSON.stringify(asset)});db.prepare("UPDATE frame_tasks SET state='succeeded',revision=4,assetId=? WHERE id=?").run(assetId,taskId);});
 const succeed=()=>{start();stage();publish();};
 return {db,projectId,otherProjectId:f.otherProjectId,source,taskId,requestId,assetId,input,inputHash,snapshot,receipt,ack,row,request,asset,start,stage,publish,succeed};
}
function fixture(t){const base=imageFixture(t);tx(base.db,()=>{migrateFrameSchema(base.db);base.db.exec('INSERT INTO schema_version VALUES(20)');});return {...accept(base),image:base};}
function legacyOwner(f,asset=f.asset,{projectId=f.projectId,oversized=false,references=[]}={}){
 const id=randomUUID(),jobId=randomUUID(),shotId=randomUUID();
 insert(f.db,'shots',{id:shotId,projectId,data:JSON.stringify({id:shotId,projectId,referenceAssetIds:references,title:'Shot',prompt:'Saved',aspectRatio:'16:9',duration:3,orderIndex:0,revision:1,selectedVersionId:id})});
 insert(f.db,'jobs',{id:jobId,projectId,data:JSON.stringify({id:jobId,projectId,shotId,assetId:asset.id,versionId:id})});
 insert(f.db,'versions',{id,projectId,jobId,data:JSON.stringify({id,projectId,jobId,shotId,assetId:asset.id,number:1,...(oversized?{private:'private payload'.repeat(6000)}:{})})});return {id,jobId,shotId};
}
function capture(db){return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));}

test('frame result is an owned PNG for clips, references and typed subjects; read APIs do zero writes',t=>{
 const f=fixture(t);f.succeed();const read=graph(f),before=capture(f.db),changes=f.db.prepare('SELECT total_changes() AS n').get().n;
 const provenance={frameTaskId:f.taskId,sourceAssetId:f.source.id,sourceHash:f.source.sha256,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE};
 assert.deepEqual(read.asset(f.assetId),f.asset);assert.deepEqual(read.clipSource({assetId:f.assetId}),f.asset);assert.deepEqual(read.frameSource(f.assetId),provenance);assert.equal(read.imageSource(f.assetId),null);
 assert.equal(read.frameTask(f.taskId).dto.result.assetId,f.assetId);assert.deepEqual(createFrameOwnershipReader(f.db,f.projectId).owners(f.assetId).map(row=>({...row})),[{id:f.taskId}]);
 const subject=createSubjectRecoveryBoundary(f.db,{projectId:f.projectId}).asset(f.assetId);
 assert.deepEqual(subject.provenance,{kind:'extracted-frame',versionId:null,shotId:null,jobId:null,frameSource:provenance});assert.equal(JSON.stringify(subject).includes('media/'),false);
 assert.throws(()=>read.clipSource({assetId:f.assetId,versionId:f.taskId}),unavailable);
 assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,changes);assert.deepEqual(capture(f.db),before);
});

test('strict Agent inspection exposes only existing safe fields and extracted-frame provenance',t=>{
 const f=fixture(t);f.succeed();changeAsset(f,f.asset,{secret:'private payload',url:'https://private.invalid',dataBase64:'private bytes'});
 const services=createInspectionServices({db:f.db}),context=services.createContext({projectId:f.projectId,capabilities:INSPECTION_OPERATIONS}),before=capture(f.db);
 const dto=services.dispatch(context,'asset.inspect',{limit:25}),text=JSON.stringify(dto),frame=dto.items.find(asset=>asset.id===f.assetId);
 assert.equal(frame.provenance,'extracted-frame');
 for(const forbidden of ['frameTaskId','frameSource','sourceAssetId','sourceHash','inputHash','snapshot','receipt','relativePath','private payload','private.invalid'])assert.equal(text.includes(forbidden),false,forbidden);
 assert.deepEqual(INSPECTION_OPERATIONS,['project.inspect','asset.inspect','shot.inspect','timeline.inspect']);assert.deepEqual(capture(f.db),before);
});

test('historical ACK/result/subject reads use frozen bounds despite mutable source metadata drift',t=>{
 const f=fixture(t);f.succeed();const before=createFrameOwnershipReader(f.db,f.projectId).task(f.taskId).dto;
 const subject=createSubjectRecoveryBoundary(f.db,{projectId:f.projectId}).asset(f.assetId);
 changeAsset(f,f.source,{duration:0.01,sizeBytes:7,width:12,height:18,hasAudio:false,hasVideo:false});
 assert.deepEqual(graph(f).frameTask(f.taskId).dto,before);assert.deepEqual(createSubjectRecoveryBoundary(f.db,{projectId:f.projectId}).asset(f.assetId),subject);
 assert.equal(f.db.prepare('SELECT response FROM frame_requests WHERE requestId=?').get(f.requestId).response,canonical(f.ack));
});

for(const [label,patch] of Object.entries({hash:{sha256:'c'.repeat(64)},mime:{mimeType:'video/webm'},path:{relativePath:'media/reassigned.mp4'},jsonProject:{projectId:randomUUID()},jsonId:{id:randomUUID()}}))test(`changed source ${label} rejects historical result and task without disclosure`,t=>{
 const f=fixture(t);f.succeed();changeAsset(f,f.source,patch);assert.throws(()=>graph(f).asset(f.assetId),unavailable);assert.throws(()=>graph(f).frameTask(f.taskId),unavailable);
});
for(const [label,patch] of Object.entries({hash:{sha256:'c'.repeat(64)},mime:{mimeType:'image/jpeg'},path:{relativePath:'media/other.png'},bytes:{sizeBytes:1},width:{width:1},height:{height:1},kind:{provenance:'user-import'},jsonProject:{projectId:randomUUID()}}))test(`changed result ${label} rejects both task and asset reads`,t=>{
 const f=fixture(t);f.succeed();changeAsset(f,f.asset,patch);assert.throws(()=>graph(f).asset(f.assetId),unavailable);assert.throws(()=>createFrameOwnershipReader(f.db,f.projectId).task(f.taskId),unavailable);
});

for(const variant of ['input-hash','input-canonical','input-json','snapshot-task','snapshot-bounds','snapshot-profile','receipt-task','receipt-output','receipt-probe','receipt-null','row-asset','row-project','row-started','row-revision','ack-id','ack-project','ack-time','ack-state','ack-source','ack-extra','request-hash','request-input','request-task','oversized-input','oversized-receipt','oversized-ack'])test(`corrupt frame ${variant} fails closed`,t=>{
 const f=fixture(t);f.succeed();corrupt(f);
 const taskPatch=(field,value)=>f.db.prepare(`UPDATE frame_tasks SET ${field}=? WHERE id=?`).run(value,f.taskId);
 const reqPatch=(field,value)=>f.db.prepare(`UPDATE frame_requests SET ${field}=? WHERE requestId=?`).run(value,f.requestId);
 const snapshot=patch=>taskPatch('snapshot',canonical({...f.snapshot,...patch})),receipt=patch=>taskPatch('stagedReceipt',canonical({...f.receipt,...patch})),ack=patch=>reqPatch('response',canonical({...f.ack,...patch}));
 if(variant==='input-hash')taskPatch('inputHash','d'.repeat(64));
 if(variant==='input-canonical')taskPatch('input',JSON.stringify(f.input,null,1));
 if(variant==='input-json')taskPatch('input',canonical({...f.input,projectId:f.otherProjectId}));
 if(variant==='snapshot-task')snapshot({taskId:randomUUID()});
 if(variant==='snapshot-bounds')snapshot({source:{...f.snapshot.source,duration:0.01}});
 if(variant==='snapshot-profile')snapshot({profile:{...FRAME_PROFILE,selectionRule:'nearest'}});
 if(variant==='receipt-task')receipt({taskId:randomUUID()});
 if(variant==='receipt-output')receipt({assetId:randomUUID()});
 if(variant==='receipt-probe')receipt({probe:{...f.receipt.probe,width:960,height:540},width:960,height:540});
 if(variant==='receipt-null')taskPatch('stagedReceipt',null);
 if(variant==='row-asset')taskPatch('assetId',randomUUID());
 if(variant==='row-project')taskPatch('projectId',f.otherProjectId);
 if(variant==='row-started')taskPatch('started',0);
 if(variant==='row-revision')taskPatch('revision',2);
 if(variant==='ack-id')ack({id:randomUUID()});
 if(variant==='ack-project')ack({projectId:f.otherProjectId});
 if(variant==='ack-time')ack({updatedAt:'2026-10-11T00:00:01.000Z'});
 if(variant==='ack-state')ack({state:'interrupted'});
 if(variant==='ack-source')ack({sourceAssetId:randomUUID()});
 if(variant==='ack-extra')ack({private:'private payload'});
 if(variant==='request-hash')reqPatch('inputHash','d'.repeat(64));
 if(variant==='request-input')reqPatch('canonicalInput',canonical({...f.input,sourceFrame:57}));
 if(variant==='request-task')reqPatch('taskId',randomUUID());
 if(variant==='oversized-input')taskPatch('input',canonical({...f.input,private:'private payload'.repeat(1000)}));
 if(variant==='oversized-receipt')receipt({private:'private payload'.repeat(1000)});
 if(variant==='oversized-ack')ack({private:'private payload'.repeat(1000)});
 assert.throws(()=>graph(f).asset(f.assetId),unavailable);assert.throws(()=>graph(f).frameTask(f.taskId),unavailable);
});

test('queued, interrupted before start and interrupted after start without receipt are readable',t=>{
 const f=fixture(t);assert.deepEqual(graph(f).frameTask(f.taskId).dto,f.ack);
 f.db.prepare("UPDATE frame_tasks SET state='interrupted',revision=2,errorCode='FRAME_INTERRUPTED' WHERE id=?").run(f.taskId);
 assert.equal(graph(f).frameTask(f.taskId).dto.started,false);
 const g=accept(f);g.start();g.db.prepare("UPDATE frame_tasks SET state='interrupted',revision=3,errorCode='FRAME_INTERRUPTED' WHERE id=?").run(g.taskId);
 assert.equal(graph(g).frameTask(g.taskId).dto.started,true);assert.equal(graph(g).frameTask(g.taskId).receipt,null);
});

test('missing/foreign source, output, owner or original ACK uniformly fail closed',t=>{
 for(const variant of ['source-missing','source-foreign','result-missing','result-foreign','owner-missing','ack-missing']){
  const f=fixture(t);f.succeed();corrupt(f);
  if(variant==='source-missing')f.db.prepare('DELETE FROM assets WHERE id=?').run(f.source.id);
  if(variant==='source-foreign')f.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.otherProjectId,f.source.id);
  if(variant==='result-missing')f.db.prepare('DELETE FROM assets WHERE id=?').run(f.assetId);
  if(variant==='result-foreign')f.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.otherProjectId,f.assetId);
  if(variant==='owner-missing')f.db.prepare('DELETE FROM frame_tasks WHERE id=?').run(f.taskId);
  if(variant==='ack-missing')f.db.prepare('DELETE FROM frame_requests WHERE requestId=?').run(f.requestId);
  assert.throws(()=>graph(f).asset(f.assetId),unavailable,variant);assert.throws(()=>graph(f).frameTask(f.taskId),unavailable,variant);
 }
 const f=fixture(t);f.succeed();assert.throws(()=>createOwnedMediaGraphReader(f.db,f.otherProjectId).asset(f.assetId),unavailable);assert.throws(()=>createFrameOwnershipReader(f.db,f.otherProjectId).task(f.taskId),unavailable);
});

for(const oversized of [false,true])for(const disguised of [false,true])test(`legacy/frame mixed owners reject, oversized=${oversized}, disguised=${disguised}`,t=>{
 const f=fixture(t);f.succeed();corrupt(f);legacyOwner(f,f.asset,{projectId:f.otherProjectId,oversized});
 if(disguised)changeAsset(f,f.asset,{provenance:'user-import'});
 assert.throws(()=>graph(f).asset(f.assetId),unavailable);
});

test('image/frame mixed owners reject even when published frame relation was erased',t=>{
 const f=fixture(t);f.image.succeed();corrupt(f);
 f.db.prepare("UPDATE frame_tasks SET state='persisting',started=1,revision=3,stagedReceipt=? WHERE id=?").run(canonical({...f.receipt,assetId:f.image.assetId}),f.taskId);
 assert.throws(()=>graph(f).asset(f.image.assetId),unavailable);
 changeAsset(f,f.image.asset,{provenance:'user-import'});assert.throws(()=>graph(f).asset(f.image.assetId),unavailable);
});

test('receipt reverse relation cannot hide a malformed oversized frame owner',t=>{
 const f=fixture(t);f.succeed();corrupt(f);f.db.prepare('UPDATE frame_tasks SET assetId=NULL,stagedReceipt=? WHERE id=?').run(canonical({...f.receipt,private:'private payload'.repeat(1000)}),f.taskId);
 changeAsset(f,f.asset,{provenance:'user-import'});assert.throws(()=>graph(f).asset(f.assetId),unavailable);
});

test('duplicate frame owners are bounded to two and cannot disappear behind provenance',t=>{
 const f=fixture(t);f.succeed();corrupt(f);
 f.db.exec('CREATE TABLE frame_tasks_copy AS SELECT * FROM frame_tasks;DROP TABLE frame_tasks;ALTER TABLE frame_tasks_copy RENAME TO frame_tasks');
 insert(f.db,'frame_tasks',{...f.row,id:randomUUID(),state:'succeeded',started:1,revision:4,assetId:f.assetId,stagedReceipt:canonical(f.receipt)});
 assert.equal(createFrameOwnershipReader(f.db,f.projectId).owners(f.assetId).length,2);assert.throws(()=>graph(f).asset(f.assetId),unavailable);
});

test('oversized legacy owner rejects imported assets even without any typed owner',t=>{
 const f=fixture(t);legacyOwner(f,f.source,{oversized:true});assert.throws(()=>graph(f).asset(f.source.id),unavailable);
});

test('legacy valid shot-reference cycles and frame-source shot cycles remain supported',t=>{
 const f=fixture(t);f.succeed();changeAsset(f,f.source,{provenance:'generated'});
 const legacy=legacyOwner(f,f.source,{references:[f.source.id,f.assetId]});
 assert.equal(graph(f).asset(f.source.id).id,f.source.id);assert.equal(graph(f).asset(f.assetId).id,f.assetId);assert.equal(graph(f).version(legacy.id).assetId,f.source.id);
 assert.equal(graph(f).frameTask(f.taskId).dto.result.assetId,f.assetId);
});

test('a frame PNG cannot become a video source by corrupting its metadata or task snapshot',t=>{
 const f=fixture(t);f.succeed();const other=accept(f);other.succeed();corrupt(f);
 const input={...other.input,sourceAssetId:f.assetId,sourceHash:f.asset.sha256},inputHash=hash(input),snapshot={...other.snapshot,source:{...other.snapshot.source,assetId:f.assetId,sha256:f.asset.sha256,relativePath:f.asset.relativePath}};
 f.db.prepare('UPDATE frame_tasks SET input=?,inputHash=?,snapshot=?,stagedReceipt=? WHERE id=?').run(canonical(input),inputHash,canonical(snapshot),canonical({...other.receipt,inputHash,sourceAssetId:f.assetId,sourceHash:f.asset.sha256}),other.taskId);
 f.db.prepare('UPDATE frame_requests SET canonicalInput=?,inputHash=?,response=? WHERE requestId=?').run(canonical(input),inputHash,canonical({...other.ack,sourceAssetId:f.assetId,sourceHash:f.asset.sha256}),other.requestId);
 changeAsset(f,f.asset,{mimeType:'video/mp4',provenance:'user-import'});assert.throws(()=>graph(f).asset(other.assetId),unavailable);
});

test('source lineage ancestry uses one bounded graph and stops beyond 16 frame ancestors',t=>{
 const f=fixture(t);f.succeed();const chain=[f];
 for(let i=1;i<17;i++){const next=accept(f);next.succeed();chain.push(next);}
 for(let i=0;i<16;i++){const current=chain[i];changeAsset(f,current.source,{provenance:'generated'});legacyOwner(f,current.source,{references:[chain[i+1].assetId]});}
 assert.equal(graph(f).asset(chain[1].assetId).id,chain[1].assetId);assert.throws(()=>graph(f).asset(chain[0].assetId),budget);
 assert.equal(FRAME_OWNERSHIP_LIMITS.maxAncestors,16);
});

test('one shared reader enforces a 64-task census rather than resetting on each asset',t=>{
 const f=fixture(t);f.succeed();const frames=[f];
 for(let i=1;i<65;i++){const next=accept(f,f.source);next.succeed();frames.push(next);}
 const read=graph(f);for(const frame of frames.slice(0,64))assert.equal(read.asset(frame.assetId).id,frame.assetId);
 assert.throws(()=>read.asset(frames[64].assetId),budget);
});

test('frame metadata has an independent 1 MiB shared budget below the 4 MiB graph ceiling',t=>{
 const f=fixture(t);f.succeed();const frames=[f];
 for(let i=1;i<64;i++){const source=sourceAsset(f,{private:'x'.repeat(14000)}),next=accept(f,source);next.succeed();frames.push(next);}
 const read=graph(f);let stopped=false,count=0;
 for(const frame of frames){try{read.asset(frame.assetId);count++;}catch(error){assert.ok(budget(error));stopped=true;break;}}
 assert.equal(stopped,true);assert.ok(count<64);assert.equal(FRAME_OWNERSHIP_LIMITS.maxMetadataBytes,1024*1024);
});

test('subject versions freeze explicit frameSource and preserve old provenance bytes',t=>{
 const f=fixture(t);f.succeed();const services=createSubjectServices({db:f.db,tx:callback=>tx(f.db,callback)},{canonical,now:()=>at});
 const input={projectId:f.projectId,kind:'look',name:'Frame look',assetId:f.assetId,requestId:randomUUID()},subject=services.handlers['subject.create'](input);
 assert.equal(subjectVersionResponseSchema.safeParse(subject.headVersion).success,true);
 const row=f.db.prepare('SELECT data FROM subject_versions WHERE id=?').get(subject.headVersionId),frozen=JSON.parse(row.data);
 assert.equal(frozen.provenance.frameSource.frameTaskId,f.taskId);assert.deepEqual([frozen.provenance.versionId,frozen.provenance.shotId,frozen.provenance.jobId],[null,null,null]);
 changeAsset(f,f.source,{duration:0.01,hasAudio:false});assert.deepEqual(services.handlers['subject.create'](input),subject);
 assert.equal(f.db.prepare('SELECT data FROM subject_versions WHERE id=?').get(subject.headVersionId).data,row.data);
 const imported={...f.asset,id:randomUUID(),provenance:'user-import'};insert(f.db,'assets',{id:imported.id,projectId:f.projectId,data:JSON.stringify(imported)});
 const old=createSubjectRecoveryBoundary(f.db,{projectId:f.projectId}).asset(imported.id);
 assert.equal(JSON.stringify(old.provenance),'{"kind":"user-import","versionId":null,"shotId":null,"jobId":null}');
 for(const patch of [{frameSource:undefined},{imageSource:{imageGroupId:randomUUID(),imageTaskId:randomUUID(),imageVersionId:randomUUID()}},{versionId:randomUUID()}])assert.equal(subjectVersionResponseSchema.safeParse({...frozen,provenance:{...frozen.provenance,...patch}}).success,false);
});

test('unchanged source bytes do not conceal a foreign legacy source owner',t=>{
 const f=fixture(t);f.succeed();legacyOwner(f,f.source,{projectId:f.otherProjectId});
 assert.throws(()=>graph(f).frameTask(f.taskId),unavailable);assert.throws(()=>graph(f).asset(f.assetId),unavailable);
});

test('oversized frame JSON and owner lists are bounded in SQL before crossing the JS boundary',t=>{
 const f=fixture(t);f.succeed();corrupt(f);f.db.prepare('UPDATE frame_tasks SET stagedReceipt=? WHERE id=?').run(canonical({...f.receipt,private:'private payload'.repeat(1000)}),f.taskId);
 const queries=[],boundedDb={prepare(sql){queries.push(sql);return f.db.prepare(sql);}},original=JSON.parse;
 t.mock.method(JSON,'parse',value=>{assert.equal(String(value).includes('private payload'),false,'oversized JSON crossed SQL guard');return original(value);});
 assert.throws(()=>createOwnedMediaGraphReader(boundedDb,f.projectId).asset(f.assetId),unavailable);
 assert.ok(queries.some(sql=>/FROM frame_tasks WHERE assetId=/.test(sql)&&/LIMIT 2/.test(sql)));
 assert.ok(queries.some(sql=>/FROM frame_tasks WHERE id=/.test(sql)&&/CASE WHEN.*stagedReceipt/s.test(sql)&&/BETWEEN 1 AND 4096/.test(sql)&&/LIMIT 2/.test(sql)));
});

test('tampered frozen frameSource is rejected without rewriting a subject version',t=>{
 const f=fixture(t);f.succeed();const services=createSubjectServices({db:f.db,tx:callback=>tx(f.db,callback)},{canonical,now:()=>at});
 const subject=services.handlers['subject.create']({projectId:f.projectId,kind:'product',name:'Product',assetId:f.assetId,requestId:randomUUID()});
 f.db.exec('DROP TRIGGER immutable_subject_versions');
 const data=JSON.stringify({...subject.headVersion,provenance:{...subject.headVersion.provenance,frameSource:{...subject.headVersion.provenance.frameSource,sourceHash:'c'.repeat(64)}}});
 f.db.prepare('UPDATE subject_versions SET data=? WHERE id=?').run(data,subject.headVersionId);
 const before=f.db.prepare('SELECT total_changes() AS n').get().n;
 assert.throws(()=>createSubjectRecoveryBoundary(f.db,{projectId:f.projectId}).version(subject.headVersionId,subject.id),{code:'INVALID_SUBJECT_RECORD'});
 assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);assert.equal(f.db.prepare('SELECT data FROM subject_versions WHERE id=?').get(subject.headVersionId).data,data);
});
