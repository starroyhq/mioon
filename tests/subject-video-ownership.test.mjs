import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,typedFrame,typedImage,rowBytes} from './subject-video-fixture.mjs';
import {createOwnedMediaGraphReader,INSPECTION_LIMITS} from '../packages/business/src/inspection.ts';
import {createSubjectOwnershipReader,SUBJECT_OWNER_COLUMNS,SUBJECT_VERSION_COLUMNS} from '../packages/business/src/subject-ownership.ts';

for(const drift of ['asset-sql','asset-json','asset-hash','asset-dimensions','shot-sql','job-sql','subject-owner','version-owner'])test(`subject ${drift} drift denies exact replay, reads and retry without disclosure`,async t=>{
 const f=await fixture(t),a=await f.asset(),subject=await f.subject(a),shot=await f.shot(),input=f.input(shot,subject.headVersionId),job=await f.call('generation.submit',input);
 if(drift==='asset-sql')f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.other.id,a.id);
 if(drift==='asset-json')f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...a,projectId:f.other.id}),a.id);
 if(drift==='asset-hash')f.store.put('assets',{...a,sha256:'d'.repeat(64)});
 if(drift==='asset-dimensions')f.store.put('assets',{...a,width:600});
 if(drift==='shot-sql')f.store.db.prepare('UPDATE shots SET projectId=? WHERE id=?').run(f.other.id,shot.id);
 if(drift==='job-sql')f.store.db.prepare('UPDATE jobs SET projectId=? WHERE id=?').run(f.other.id,job.id);
 if(drift==='subject-owner'){f.store.db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER immutable_subject_identity');f.store.db.prepare('UPDATE subjects SET projectId=? WHERE id=?').run(f.other.id,subject.id);}
 if(drift==='version-owner'){f.store.db.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON; DROP TRIGGER immutable_subject_versions');f.store.db.prepare('UPDATE subject_versions SET projectId=? WHERE id=?').run(f.other.id,subject.headVersionId);}
 const before=rowBytes(f,'jobs',job.id);await assert.rejects(f.call('generation.submit',input));await assert.rejects(f.call('job.get',{jobId:job.id}));await assert.rejects(f.call('job.retry',{jobId:job.id,requestId:randomUUID()}));assert.equal(rowBytes(f,'jobs',job.id),before);assert.equal(f.store.list('jobs').length,1);assert.equal(f.posts(),0);
});

for(const kind of ['image','frame'])for(const stage of ['admission','replay','queued','retry'])test(`typed ${kind} source lineage checked at ${stage}`,async t=>{
 const f=await fixture(t),typed=await (kind==='image'?typedImage(f):typedFrame(f)),subject=await f.subject(typed.asset),shot=await f.shot(),input=f.input(shot,subject.headVersionId);let job;
 if(stage!=='admission')job=await f.call('generation.submit',input);
 if(kind==='image')assert.deepEqual(subject.headVersion.provenance.imageSource,{imageGroupId:typed.groupId,imageTaskId:typed.taskId,imageVersionId:typed.versionId});else assert.equal(subject.headVersion.provenance.frameSource.sourceAssetId,typed.source.id);
 if(kind==='image'){f.store.db.exec('DROP TRIGGER immutable_image_task_identity; DROP TRIGGER image_task_state_transitions');f.store.db.prepare('UPDATE image_tasks SET inputHash=? WHERE id=?').run('e'.repeat(64),typed.taskId);}else f.store.put('assets',{...typed.source,sha256:'e'.repeat(64)});
 if(stage==='admission'||stage==='replay')await assert.rejects(f.call('generation.submit',input));
 if(stage==='retry'){f.store.put('jobs',{...f.store.get('jobs',job.id),status:'failed'});await assert.rejects(f.call('job.retry',{jobId:job.id,requestId:randomUUID()}));}
 if(stage==='queued'){await f.tick();await f.stop();const saved=f.store.get('jobs',job.id);assert.equal(saved.status,'failed');assert.equal(saved.submissionCount,0);assert.equal(f.providers.get('mock').stats(input.requestId).submissionCount,0);}
 assert.equal(f.store.list('jobs').length,stage==='admission'?0:1);
});

for(const boundary of ['after-image-read','final-post'])test(`typed ancestry drift ${boundary} prevents actual Ark POST`,async t=>{
 const f=await fixture(t),typed=await typedFrame(f),subject=await f.subject(typed.asset),shot=await f.shot();let checks=0;
 f.ark({hook:(provider,snapshot,context)=>provider.submit(snapshot,{...context,validateReferenceState:()=>{checks++;if(boundary==='after-image-read'&&checks===5)f.store.put('assets',{...typed.source,sha256:'e'.repeat(64)});context.validateReferenceState();},beforeSubmit:()=>{if(boundary==='final-post')f.store.put('assets',{...typed.source,sha256:'e'.repeat(64)});context.beforeSubmit();}})});
 const job=await f.submit(shot,subject.headVersionId,{providerId:'ark'}),snapshot=JSON.stringify(f.store.get('jobs',job.id).snapshot);await f.tick();await f.stop();const saved=f.store.get('jobs',job.id);assert.equal(saved.status,'failed');assert.equal(saved.submissionCount,0);assert.equal(saved.phase,'input_preflight_failed');assert.equal(JSON.stringify(saved.snapshot),snapshot);assert.equal(f.posts(),0);
});

for(const corruption of ['missing-subject','wrong-version','pruned-bindings','pruned-role','first-frame-role','foreign-project','changed-provenance','old-profile'])test(`queued malformed ${corruption} subject snapshot cannot fall back to first-frame dispatch`,async t=>{
 const f=await fixture(t),subject=await f.subject(await f.asset()),shot=await f.shot(),job=await f.submit(shot,subject.headVersionId),saved=f.store.get('jobs',job.id),s=saved.snapshot;
 if(corruption==='missing-subject')delete s.subjectReference;if(corruption==='wrong-version')s.subjectReference.subjectVersionId=randomUUID();if(corruption==='pruned-bindings')delete s.referenceBindings;if(corruption==='pruned-role')delete s.referenceAssets[0].role;if(corruption==='first-frame-role')s.referenceBindings[0].role='first_frame';if(corruption==='foreign-project')s.subjectReference.subjectVersion.projectId=f.other.id;if(corruption==='changed-provenance')s.subjectReference.subjectVersion.provenance.kind='generated';if(corruption==='old-profile'){s.inputProfileVersion='mioon-input-profiles/2';s.inputProfileId='mock:mock-motion-v1:v2';}
 f.store.put('jobs',saved);const before=JSON.stringify(s);await f.tick();await f.stop();assert.equal(f.store.get('jobs',job.id).status,'failed');assert.equal(f.store.get('jobs',job.id).submissionCount,0);assert.equal(JSON.stringify(f.store.get('jobs',job.id).snapshot),before);assert.equal(f.providers.get('mock').stats(job.requestId).submissionCount,0);
});

async function publishedSubjectVideo(f){
 const typed=await typedFrame(f),subject=await f.subject(typed.asset),shot=await f.shot(),job=await f.submit(shot,subject.headVersionId),asset=await f.asset({mimeType:'video/mp4',provenance:'generated'}),versionId=randomUUID(),saved=f.store.get('jobs',job.id);
 f.store.put('jobs',{...saved,status:'succeeded',versionId,assetId:asset.id});f.store.put('versions',{id:versionId,projectId:f.project.id,shotId:shot.id,jobId:job.id,assetId:asset.id,sha256:asset.sha256,number:1,snapshot:saved.snapshot});f.store.put('shots',{...f.store.get('shots',shot.id),selectedVersionId:versionId});return {typed,subject,shot,job,asset,versionId};
}

test('inspection validates retained subject snapshot lineage without exposing new fields in the inspection DTO',async t=>{
 const f=await fixture(t),published=await publishedSubjectVideo(f);assert.equal(createOwnedMediaGraphReader(f.store.db,f.project.id).version(published.versionId).id,published.versionId);
 const dto=await f.call('shot.inspect',{projectId:f.project.id});assert.doesNotMatch(JSON.stringify(dto),/subjectReference|subjectVersionId|subject_reference/);
 f.store.put('assets',{...published.typed.source,sha256:'f'.repeat(64)});await assert.rejects(f.call('shot.inspect',{projectId:f.project.id}),{code:'INSPECTION_UNAVAILABLE'});await assert.rejects(f.call('version.list',{shotId:published.shot.id}));await assert.rejects(f.call('project.get',{projectId:f.project.id}));
});

test('inspection rejects removed subjectReference with retained subject role markers',async t=>{
 const f=await fixture(t),p=await publishedSubjectVideo(f),saved=f.store.get('jobs',p.job.id);delete saved.snapshot.subjectReference;f.store.put('jobs',saved);await assert.rejects(f.call('shot.inspect',{projectId:f.project.id}),{code:'INSPECTION_UNAVAILABLE'});
});

test('subject ownership rows share supplied budget, bound materialization and use primary-key lookup',async t=>{
 const f=await fixture(t),a=await f.asset(),subject=await f.subject(a),db=f.store.db;let records=INSPECTION_LIMITS.maxReadRecords;
 const reader=createSubjectOwnershipReader(db,f.project.id,{consume:()=>{if(++records>INSPECTION_LIMITS.maxReadRecords)throw Object.assign(Error('Budget'),{code:'INSPECTION_BUDGET_EXCEEDED'});},resolveAsset:()=>assert.fail('No media read after exhausted row budget')});assert.throws(()=>reader.version(subject.headVersionId),{code:'INSPECTION_BUDGET_EXCEEDED'});
 const plans=[db.prepare(`EXPLAIN QUERY PLAN SELECT ${SUBJECT_OWNER_COLUMNS} FROM subjects WHERE id=? AND projectId=? LIMIT 1`).all(subject.id,f.project.id),db.prepare(`EXPLAIN QUERY PLAN SELECT ${SUBJECT_VERSION_COLUMNS} FROM subject_versions WHERE id=? AND projectId=? LIMIT 1`).all(subject.headVersionId,f.project.id)];assert.ok(plans.every(plan=>plan.some(row=>/SEARCH.*INDEX/.test(row.detail))));
 // Edge JSON target matching has no matching expression index. LIMIT bounds
 // returned rows, not scanned rows. Existing ownership reverse probes similarly
 // include defensive OR/oversized-row scans; this feature adds no broad migration.
 const edgePlan=db.prepare("EXPLAIN QUERY PLAN SELECT id FROM edges WHERE CASE WHEN json_valid(data) THEN json_extract(data,'$.target') END=? LIMIT 1025").all(randomUUID());assert.ok(edgePlan.some(row=>/SCAN/.test(row.detail)));
 db.exec('PRAGMA ignore_check_constraints=ON; DROP TRIGGER immutable_subject_versions');db.prepare('UPDATE subject_versions SET data=? WHERE id=?').run('x'.repeat(200000),subject.headVersionId);assert.throws(()=>createOwnedMediaGraphReader(db,f.project.id).subjectVersion(subject.headVersionId));
});

test('large retained history keeps subject row reads bounded; native read-only reopen does not mutate',async t=>{
 const {DatabaseSync}=await import('node:sqlite'),path=await import('node:path');
 const {assertSubjectGenerationSelection,assertSubjectGenerationRequestVacant}=await import('../packages/business/src/generation-inputs.ts');
 const f=await fixture(t),a=await f.asset(),subject=await f.subject(a),shot=await f.shot(),otherShot=await f.shot(),db=f.store.db;
 f.store.tx(()=>{
  const owner=db.prepare('INSERT INTO subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)'),version=db.prepare('INSERT INTO subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)'),edge=db.prepare('INSERT INTO edges(id,projectId,data) VALUES(?,?,?)');
  for(let i=0;i<2000;i++){const id=randomUUID(),versionId=randomUUID(),v={...subject.headVersion,id:versionId,subjectId:id};owner.run(id,f.project.id,'product',`Retained subject ${i}`,1,versionId,v.createdAt,v.createdAt);version.run(versionId,f.project.id,id,1,a.id,JSON.stringify(v));}
  for(let i=0;i<3000;i++){const id=randomUUID();edge.run(id,f.project.id,JSON.stringify({id,projectId:f.project.id,source:shot.id,target:otherShot.id,kind:'decorative'}));}
  for(let i=0;i<2000;i++)f.store.put('jobs',{id:randomUUID(),projectId:f.project.id,shotId:shot.id,requestId:randomUUID(),status:'failed',snapshot:{}});
 });
 let records=0,readBytes=0;const started=performance.now();
 const reader=createSubjectOwnershipReader(db,f.project.id,{consume:value=>{records++;readBytes+=Buffer.byteLength(value);},resolveAsset:()=>({asset:a})});assert.equal(reader.version(subject.headVersionId).id,subject.headVersionId);assert.equal(records,2);assert.ok(readBytes<8192);
 assertSubjectGenerationSelection(db,shot);
 const probeStart=performance.now();assertSubjectGenerationRequestVacant(db,{requestId:randomUUID()});const reservationProbeMs=performance.now()-probeStart;
 const reservationPlan=db.prepare("EXPLAIN QUERY PLAN SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 131072 THEN data END FROM jobs WHERE CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 131072 THEN CASE WHEN json_valid(data) THEN json_extract(data,'$.requestId')=? ELSE 1 END ELSE 1 END LIMIT 2").all(randomUUID()).map(row=>row.detail);assert.ok(reservationPlan.some(detail=>/SCAN jobs/.test(detail)));
 const elapsed=performance.now()-started,plans=db.prepare(`EXPLAIN QUERY PLAN SELECT ${SUBJECT_VERSION_COLUMNS} FROM subject_versions WHERE id=? AND projectId=? LIMIT 1`).all(subject.headVersionId,f.project.id).map(row=>row.detail);
 t.diagnostic(JSON.stringify({subjects:2001,subjectVersions:2001,unrelatedEdges:3000,retainedJobs:2000,reservationProbeMs,reservationQueryPlan:reservationPlan,materializedSubjectRows:records,materializedSubjectBytes:readBytes,elapsedMs:elapsed,subjectVersionQueryPlan:plans,edgeTargetQueryLimitation:'guarded JSON target predicate scans; LIMIT bounds materialized candidates only'}));
 const persisted=rowBytes(f,'shots',shot.id),readOnly=new DatabaseSync(path.join(f.root,'workbench.sqlite'),{readOnly:true});
 try{assert.equal(createOwnedMediaGraphReader(readOnly,f.project.id).subjectReference(subject.headVersionId).subjectVersionId,subject.headVersionId);assert.equal(readOnly.prepare('SELECT total_changes() AS n').get().n,0);assert.equal(readOnly.prepare('SELECT data FROM shots WHERE id=?').get(shot.id).data,persisted);}finally{readOnly.close();}
});

for(const damage of ['missing','wrong-resource','wrong-hash','oversized-hash'])test(`damaged ${damage} generation receipt cannot disclose or recreate a retained subject request`,async t=>{
 const f=await fixture(t),s=await f.subject(await f.asset()),shot=await f.shot(),input=f.input(shot,s.headVersionId),job=await f.call('generation.submit',input),db=f.store.db;
 if(damage==='missing')db.prepare("DELETE FROM idempotency WHERE scope='generation' AND requestId=?").run(input.requestId);
 if(damage==='wrong-resource')db.prepare("UPDATE idempotency SET resourceId=? WHERE scope='generation' AND requestId=?").run(randomUUID(),input.requestId);
 if(damage==='wrong-hash'||damage==='oversized-hash')db.prepare("UPDATE idempotency SET requestHash=? WHERE scope='generation' AND requestId=?").run('f'.repeat(damage==='wrong-hash'?64:200000),input.requestId);
 const before=db.prepare('SELECT * FROM idempotency').all();
 for(const operation of [()=>f.call('generation.submit',input),()=>f.call('generation.submit',Object.fromEntries(Object.entries(input).filter(([key])=>key!=='subjectVersionId'))),()=>f.call('job.get',{jobId:job.id}),()=>f.call('job.list',{projectId:f.project.id}),()=>f.call('project.get',{projectId:f.project.id})])await assert.rejects(operation());
 assert.equal(f.store.list('jobs').length,1);assert.deepEqual(db.prepare('SELECT * FROM idempotency').all(),before);assert.equal(f.providers.get('mock').stats().submissionCount,0);
 await f.tick();await f.stop();assert.equal(f.store.get('jobs',job.id).status,'failed');assert.equal(f.store.get('jobs',job.id).submissionCount,0);assert.equal(f.providers.get('mock').stats().submissionCount,0);
});

test('retained legacy request also prevents new explicit subject admission after its ledger disappears',async t=>{
 const f=await fixture(t),s=await f.subject(await f.asset()),shot=await f.shot(),input=f.input(shot),old=await f.call('generation.submit',input);f.store.db.prepare("DELETE FROM idempotency WHERE scope='generation' AND requestId=?").run(input.requestId);
 await assert.rejects(f.call('generation.submit',{...input,subjectVersionId:s.headVersionId}),{code:'INVALID_GENERATION_RECEIPT'});assert.equal(f.store.list('jobs').length,1);assert.equal(f.store.get('jobs',old.id).status,'queued');
});

for(const shape of ['oversized','nontext','malformed','null'])test(`foreign ${shape} edge cannot hide its first-frame relation before bounded JSON extraction`,async t=>{
 const f=await fixture(t),s=await f.subject(await f.asset()),shot=await f.shot(),id=randomUUID(),data=shape==='oversized'?JSON.stringify({id,projectId:f.other.id,target:shot.id,kind:'reference',role:'first_frame',padding:'x'.repeat(20000)}):shape==='nontext'?Buffer.from('binary edge'):shape==='null'?'null':'{broken foreign edge';
 f.store.db.prepare('INSERT INTO edges(id,projectId,data) VALUES(?,?,?)').run(id,f.other.id,data);await assert.rejects(f.submit(shot,s.headVersionId),{code:'REFERENCE_STATE_CONFLICT'});assert.equal(f.store.list('jobs').length,0);
});

test('paid subject cancel/reconcile can progress with unavailable source, but never disclose its invalid snapshot or resubmit',async t=>{
 const f=await fixture(t),a=await f.asset(),s=await f.subject(a),shot=await f.shot(),job=await f.submit(shot,s.headVersionId);await f.tick();await f.stop();const known=f.store.get('jobs',job.id).providerJobId;let polls=0;
 const provider=f.providers.get('mock');f.providers.set('mock',{...provider,poll:async id=>{assert.equal(id,known);polls++;return {status:'running'};}});f.store.put('assets',{...a,sha256:'e'.repeat(64)});
 await assert.rejects(f.call('job.cancel',{jobId:job.id}));assert.equal(f.store.get('jobs',job.id).status,'cancelled');
 await assert.rejects(f.call('job.reconcile',{jobId:job.id}));assert.equal(polls,1);assert.equal(f.store.get('jobs',job.id).status,'running');assert.equal(f.store.get('jobs',job.id).providerJobId,known);assert.equal(provider.stats(job.requestId).submissionCount,1);assert.equal(f.store.list('jobs').length,1);
});

for(const stage of ['cancel','reconcile-before','reconcile-after'])test(`subject identity drift at ${stage} cannot mutate a foreign job or shot`,async t=>{
 const f=await fixture(t),s=await f.subject(await f.asset()),shot=await f.shot(),job=await f.submit(shot,s.headVersionId);await f.tick();await f.stop();let polls=0;
 const provider=f.providers.get('mock'),drift=()=>f.store.db.prepare('UPDATE shots SET projectId=? WHERE id=?').run(f.other.id,shot.id);
 f.providers.set('mock',{...provider,poll:async()=>{polls++;drift();return {status:'running'};}});if(stage!=='reconcile-after')drift();const before=rowBytes(f,'jobs',job.id);
 await assert.rejects(f.call(stage==='cancel'?'job.cancel':'job.reconcile',{jobId:job.id}));assert.equal(rowBytes(f,'jobs',job.id),before);assert.equal(polls,stage==='reconcile-after'?1:0);assert.equal(provider.stats(job.requestId).submissionCount,1);
});

for(const damage of ['missing','null','number','short','oversized'])test(`retained subject with ${damage} request identity is uncertain, never a vacant fresh key`,async t=>{
 const f=await fixture(t),s=await f.subject(await f.asset()),shot=await f.shot(),input=f.input(shot,s.headVersionId),job=await f.call('generation.submit',input),saved=f.store.get('jobs',job.id);f.store.db.prepare("DELETE FROM idempotency WHERE scope='generation' AND requestId=?").run(input.requestId);
 if(damage==='missing')delete saved.requestId;else saved.requestId=damage==='null'?null:damage==='number'?42:damage==='short'?'bad':'x'.repeat(801);f.store.put('jobs',saved);
 await assert.rejects(f.call('generation.submit',input),{code:'INVALID_GENERATION_RECEIPT'});const omitted={...input};delete omitted.subjectVersionId;await assert.rejects(f.call('generation.submit',omitted),{code:'INVALID_GENERATION_RECEIPT'});assert.equal(f.store.list('jobs').length,1);assert.equal(f.providers.get('mock').stats().submissionCount,0);
});

test('genuine legacy exact replay remains before an unrelated damaged subject reservation',async t=>{
 const f=await fixture(t),s=await f.subject(await f.asset()),shot=await f.shot(),legacyInput=f.input(shot),legacy=await f.call('generation.submit',legacyInput),subject=await f.submit(shot,s.headVersionId),saved=f.store.get('jobs',subject.id);delete saved.requestId;f.store.put('jobs',saved);assert.deepEqual(await f.call('generation.submit',legacyInput),legacy);
});

test('historical provenance-only job without a request key remains compatible with fresh subject and legacy generation',async t=>{
 const f=await fixture(t),a=await f.asset(),source=await f.shot(),jobId=randomUUID(),versionId=randomUUID();f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId:source.id,assetId:a.id,versionId});f.store.put('versions',{id:versionId,projectId:f.project.id,shotId:source.id,jobId,assetId:a.id,sha256:a.sha256});
 const subject=await f.subject(a),shot=await f.shot(),generated=await f.submit(shot,subject.headVersionId);assert.deepEqual(generated.snapshot.subjectReference.subjectVersion.provenance,{kind:'user-import',versionId,shotId:source.id,jobId});const legacy=await f.submit(shot);assert.equal(Object.hasOwn(legacy.snapshot,'subjectReference'),false);assert.equal(f.store.list('jobs').length,3);
});

for(const retainedMarker of ['asset-role','binding-role'])test(`partial ${retainedMarker} subject claim with missing key still reserves an uncertain request`,async t=>{
 const f=await fixture(t),subject=await f.subject(await f.asset()),shot=await f.shot(),input=f.input(shot,subject.headVersionId),job=await f.call('generation.submit',input),saved=f.store.get('jobs',job.id);f.store.db.prepare("DELETE FROM idempotency WHERE scope='generation' AND requestId=?").run(input.requestId);delete saved.requestId;delete saved.snapshot.subjectReference;
 if(retainedMarker==='asset-role')delete saved.snapshot.referenceBindings;else delete saved.snapshot.referenceAssets;f.store.put('jobs',saved);const omitted={...input};delete omitted.subjectVersionId;await assert.rejects(f.call('generation.submit',omitted),{code:'INVALID_GENERATION_RECEIPT'});assert.equal(f.store.list('jobs').length,1);
});

test('subject version disclosure rejects oversized or corrupt linked job through a bounded probe',async t=>{
 const f=await fixture(t),p=await publishedSubjectVideo(f),db=f.store.db,saved=f.store.get('jobs',p.job.id),before=rowBytes(f,'versions',p.versionId);
 for(const data of [JSON.stringify({...saved,padding:'x'.repeat(300000)}),'{private corrupt linked job']){db.prepare('UPDATE jobs SET data=? WHERE id=?').run(data,p.job.id);await assert.rejects(f.call('version.list',{shotId:p.shot.id}),error=>error.code==='INVALID_GENERATION_OWNERSHIP'&&!JSON.stringify(error).includes('private corrupt'));assert.equal(rowBytes(f,'versions',p.versionId),before);}
});
