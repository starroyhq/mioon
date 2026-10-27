import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import type {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/db.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {collectProject,packageDocumentBytes,buildManifest,createProjectFromDocument} from '../packages/business/src/project-package/document.ts';
import {writeProjectPackage,readProjectPackage} from '../packages/business/src/project-package/container.ts';
import {createServices} from '../packages/business/src/services.ts';
import {setImageResultListener} from '../packages/business/src/images.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import {subjectVariantPrompt,subjectVariantImageName} from '../packages/business/src/subject-variant-prompts.ts';
import {IMAGE_MODELS,isSubjectVariantBatch,isSubjectVariantMutationResponse,subjectVariantImageRequestId} from '@mioon/contracts';
import type {SubjectVariantBatch,SubjectVariantSpec} from '@mioon/contracts';

type Row=Record<string, unknown>;
interface Subject {id: string; projectId: string; kind: string; name: string; revision: number; headVersionId: string; headVersion: {id: string; number: number}}
interface Version {id: string; number: number; width: number; height: number; variant?: Row; provenance: Row}
interface Failure {code?: string; status?: number; details?: Row}
const angle=(position: string,focal='standard'): SubjectVariantSpec=>({kind:'angle',position,focal} as SubjectVariantSpec);
const sha=(bytes: Buffer): string=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t: TestContext,{autoRun=true}: {autoRun?: boolean}={}){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-subject-variants-'));
 let store=openStore(root),services=createServices(store,new Map(),{imageOptions:{autoRun}}),closed=false;
 const call=<T=Row>(operation: string,input: unknown): Promise<T>=>services.call(operation,input) as Promise<T>;
 const project=await call<{id: string}>('project.create',{name:'Subject variants'}),projectId=project.id;
 async function asset(patch: Row={},{width=768,height=1024}: {width?: number; height?: number}={}): Promise<{id: string}> {
  // Metadata may claim a size the edit profile refuses; the bytes stay renderable.
  const bytes=await renderMockImagePng({width:Math.min(width,4096),height:Math.min(height,4096)}),id=randomUUID();
  const value={id,projectId,name:'Lin.png',mimeType:'image/png',provenance:'user-import',sha256:sha(bytes),width,height,sizeBytes:bytes.length,relativePath:`media/${id}.png`,url:`/media/${id}`,createdAt:new Date().toISOString(),...patch};
  store.put('assets',value);writeFileSync(path.join(root,String(value.relativePath)),bytes,{mode:0o600});return value;
 }
 const source=await asset();
 const subject=await call<Subject>('subject.create',{projectId,kind:'character',name:'林夏',assetId:source.id,requestId:randomUUID()});
 const f={root,projectId,subject,asset,call,
  get store(){return store;},
  create:(items: SubjectVariantSpec[],patch: Row={})=>call<SubjectVariantBatch>('subject.variants.create',{projectId,subjectId:subject.id,sourceVersionId:subject.headVersionId,kind:items[0]!.kind,items,providerId:'mock',model:IMAGE_MODELS.mock,requestId:randomUUID(),...patch}),
  get:(batch: {id: string})=>call<SubjectVariantBatch>('subject.variants.get',{projectId,batchId:batch.id}),
  submit:async(batch: SubjectVariantBatch)=>{for(const item of batch.items)if(item.status==='pending')await call('image.generate',item.imageInput);},
  async settled(batch: {id: string},done=(value: SubjectVariantBatch)=>value.items.every(item=>item.status==='succeeded')){
   for(let attempt=0;attempt<300;attempt++){const value=await f.get(batch);if(done(value))return value;await pause(20);}
   throw new Error('Batch did not settle');
  },
  subjectNow:async()=>(await call<{items: Subject[]}>('subject.list',{projectId})).items.find(item=>item.id===subject.id)!,
  versions:async()=>(await call<{items: Version[]}>('subject.version.list',{projectId,subjectId:subject.id})).items,
  async restart(){await services.drain?.();store.close();store=openStore(root);services=createServices(store,new Map(),{imageOptions:{autoRun}});},
  async stop(){await services.drain?.();store.close();closed=true;},
 };
 t.after(async()=>{if(!closed){await services.drain?.();store.close();}rmSync(root,{recursive:true,force:true});});
 return f;
}

test('a batch freezes model-sized image edits and links each finished image as a variant version without moving the head',async t=>{
 const f=await fixture(t),batch=await f.create([angle('front-left'),angle('back','wide')]);
 assert.equal(isSubjectVariantBatch(batch),true);
 assert.equal(batch.size,'1152x1536','a 3:4 source keeps its ratio at the model\'s long edge');
 assert.deepEqual(batch.items.map(item=>[item.status,item.attempt,item.imageInput.requestId]),[1,2].map(position=>['pending',1,subjectVariantImageRequestId(batch.id,position,1)]));
 const first=batch.items[0]!.imageInput as Row;
 assert.equal(first.purpose,'edit');assert.deepEqual(first.options,{size:'1152x1536',quality:'low',outputFormat:'png',background:'opaque',n:1});
 assert.equal(first.prompt,subjectVariantPrompt({kind:'character',name:'林夏'},angle('front-left')));
 assert.equal(first.name,subjectVariantImageName({name:'林夏'},angle('front-left')));
 assert.equal(batch.items[1]!.imageInput.name,'林夏 · 补角度 · 背 · 广角');
 await f.submit(batch);const done=await f.settled(batch);
 assert.deepEqual(done.undo,{available:true,blockers:[]});
 const subject=await f.subjectNow();
 assert.equal(subject.headVersionId,f.subject.headVersionId,'variant versions never replace the head');
 assert.equal(subject.revision,3);
 const versions=await f.versions();
 assert.deepEqual(versions.map(version=>[version.number,version.width,version.height,version.variant?.position??null]),[[1,768,1024,null],[2,1152,1536,'front-left'],[3,1152,1536,'back']]);
 assert.deepEqual(versions[1]!.variant,{kind:'angle',position:'front-left',focal:'standard',batchId:batch.id,sourceVersionId:f.subject.headVersionId});
 assert.equal(versions[1]!.provenance.kind,'synthetic-mock');
 assert.deepEqual(done.items.map(item=>item.versionId),[versions[1]!.id,versions[2]!.id]);
 const listed=await f.call<{items: SubjectVariantBatch[]}>('subject.variants.list',{projectId:f.projectId,subjectId:f.subject.id});
 assert.deepEqual(listed.items.map(item=>[item.id,item.undo]),[[batch.id,null]]);
});

test('lighting makes one image and refuses a second item',async t=>{
 const f=await fixture(t),light={kind:'light',azimuth:45,elevation:30,quality:'soft',kelvin:4800} as SubjectVariantSpec;
 const batch=await f.create([light]);
 assert.match(String(batch.items[0]!.imageInput.prompt),/45 degrees to the subject's right .* 30 degrees above eye level, with soft, diffused light .* 4800K/);
 await assert.rejects(f.create([light,{...light,azimuth:-45} as SubjectVariantSpec]),{code:'VALIDATION_ERROR'});
 await assert.rejects(f.create([angle('front'),light]),{code:'VALIDATION_ERROR'});
 await assert.rejects(f.create([angle('front'),angle('front')]),{code:'VALIDATION_ERROR'});
});

test('undo is refused while a version is bound, generated or used as a source, and while an image runs; then the versions are hidden',async t=>{
 const f=await fixture(t),batch=await f.create([angle('left'),angle('right')]);
 await f.submit(batch);await f.settled(batch);
 const [,left,right]=await f.versions(),subject=await f.subjectNow();
 const shot=await f.call<{id: string}>('shot.create',{projectId:f.projectId,title:'Shot',requestId:randomUUID()});
 const bound=await f.call<{revision: number}>('subject.binding.set',{projectId:f.projectId,shotId:shot.id,subjectId:subject.id,role:'subject',subjectVersionId:left!.id,expectedRevision:0,expectedSubjectRevision:subject.revision,requestId:randomUUID()});
 const job=randomUUID();
 f.store.db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(job,f.projectId,JSON.stringify({id:job,projectId:f.projectId,snapshot:{subjectReference:{subjectVersionId:right!.id}}}));
 const derived=await f.create([angle('front')],{sourceVersionId:right!.id});
 const blocked=await f.get(batch);
 assert.deepEqual(blocked.undo,{available:false,blockers:[{code:'BOUND',position:1,shotId:shot.id},{code:'GENERATED',position:2},{code:'SOURCE',position:2,batchId:derived.id}]});
 await assert.rejects(f.call('subject.variants.undo',{projectId:f.projectId,batchId:batch.id,expectedRevision:blocked.revision,requestId:randomUUID()}),
  (error: Failure)=>error.code==='SUBJECT_VARIANT_UNDO_BLOCKED'&&Array.isArray(error.details?.blockers)&&(error.details!.blockers as Row[]).length===3);
 await f.call('subject.binding.set',{projectId:f.projectId,shotId:shot.id,subjectId:subject.id,role:'subject',subjectVersionId:null,expectedRevision:bound.revision,expectedSubjectRevision:subject.revision,requestId:randomUUID()});
 f.store.db.prepare('DELETE FROM jobs WHERE id=?').run(job);
 // The derived batch's own image is still queued, so it cannot be undone yet.
 const queued=await f.get(derived);await f.call('image.generate',queued.items[0]!.imageInput);
 const running=await f.get(derived);
 if(running.items[0]!.status==='running')assert.deepEqual(running.undo,{available:false,blockers:[{code:'IN_PROGRESS',position:1}]});
 const finished=await f.settled(derived);
 const undoneDerived=await f.call<SubjectVariantBatch>('subject.variants.undo',{projectId:f.projectId,batchId:derived.id,expectedRevision:finished.revision,requestId:randomUUID()});
 assert.equal(undoneDerived.state,'undone');
 const current=await f.get(batch);assert.deepEqual(current.undo,{available:true,blockers:[]});
 const undone=await f.call<SubjectVariantBatch>('subject.variants.undo',{projectId:f.projectId,batchId:batch.id,expectedRevision:current.revision,requestId:randomUUID()});
 assert.deepEqual(undone.items.map(item=>item.status),['undone','undone']);
 assert.deepEqual((await f.versions()).map(version=>version.number),[1],'undone versions are hidden');
 await assert.rejects(f.call('subject.binding.set',{projectId:f.projectId,shotId:shot.id,subjectId:subject.id,role:'subject',subjectVersionId:left!.id,expectedRevision:bound.revision+1,expectedSubjectRevision:(await f.subjectNow()).revision,requestId:randomUUID()}),{code:'SUBJECT_VERSION_HIDDEN'});
 await assert.rejects(f.create([angle('front')],{sourceVersionId:left!.id}),{code:'SUBJECT_VERSION_HIDDEN'});
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM subject_versions WHERE subjectId=?').get(f.subject.id)!.n,4,'versions are retained');
});

test('only an image that failed or was cancelled before dispatch is retried, under a new request ID',async t=>{
 const f=await fixture(t,{autoRun:false}),batch=await f.create([angle('high')]);
 await assert.rejects(f.call('subject.variants.retry',{projectId:f.projectId,batchId:batch.id,position:1,expectedRevision:1,requestId:randomUUID()}),{code:'SUBJECT_VARIANT_RETRY_UNAVAILABLE'});
 const task=await f.call<{id: string; revision: number}>('image.generate',batch.items[0]!.imageInput);
 await assert.rejects(f.call('subject.variants.retry',{projectId:f.projectId,batchId:batch.id,position:1,expectedRevision:1,requestId:randomUUID()}),{code:'SUBJECT_VARIANT_RETRY_UNAVAILABLE'});
 await f.call('image.task.cancelQueued',{projectId:f.projectId,taskId:task.id,expectedRevision:task.revision,requestId:randomUUID()});
 assert.equal((await f.get(batch)).items[0]!.status,'cancelled');
 await assert.rejects(f.call('subject.variants.retry',{projectId:f.projectId,batchId:batch.id,position:1,expectedRevision:2,requestId:randomUUID()}),{code:'SUBJECT_VARIANT_REVISION_CONFLICT'});
 const input={projectId:f.projectId,batchId:batch.id,position:1,expectedRevision:1,requestId:randomUUID()};
 const retried=await f.call<SubjectVariantBatch>('subject.variants.retry',input);
 assert.equal(isSubjectVariantMutationResponse('subject.variants.retry',input,retried),true);
 assert.deepEqual([retried.revision,retried.items[0]!.attempt,retried.items[0]!.status,retried.items[0]!.imageInput.requestId],[2,2,'pending',subjectVariantImageRequestId(batch.id,1,2)]);
 assert.deepEqual(await f.call('subject.variants.retry',input),retried,'exact replay returns the original acknowledgement');
});

test('exact replay, request conflicts and provable refusals',async t=>{
 const f=await fixture(t),input={projectId:f.projectId,subjectId:f.subject.id,sourceVersionId:f.subject.headVersionId,kind:'angle',items:[angle('front')],providerId:'mock',model:IMAGE_MODELS.mock,requestId:randomUUID()};
 const created=await f.call<SubjectVariantBatch>('subject.variants.create',input);
 assert.deepEqual(await f.call('subject.variants.create',input),created);
 await assert.rejects(f.call('subject.variants.create',{...input,items:[angle('back')]}),{code:'SUBJECT_VARIANT_REQUEST_CONFLICT'});
 const look=await f.asset();
 const style=await f.call<Subject>('subject.create',{projectId:f.projectId,kind:'location',name:'雨夜街口',assetId:look.id,requestId:randomUUID()});
 const refused={...input,subjectId:style.id,sourceVersionId:style.headVersionId,requestId:randomUUID()};
 await assert.rejects(f.call('subject.variants.create',refused),(error: Failure)=>error.code==='SUBJECT_VARIANT_KIND_UNSUPPORTED'&&(error.details?.subjectVariantOutcome as Row)?.status==='not_accepted');
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM subject_variant_batches').get()!.n,1);
});

test('sources the model cannot edit are refused before a batch is recorded',async t=>{
 const f=await fixture(t);
 for(const [patch,size,reason] of [[{provenance:'export'},{},'origin'],[{},{width:4100,height:1000},'dimensions']] as const){
  const value=await f.asset(patch,size);
  const subject=await f.call<Subject>('subject.create',{projectId:f.projectId,kind:'product',name:'银色手表',assetId:value.id,requestId:randomUUID()});
  await assert.rejects(f.call('subject.variants.create',{projectId:f.projectId,subjectId:subject.id,sourceVersionId:subject.headVersionId,kind:'angle',items:[angle('front')],providerId:'mock',model:IMAGE_MODELS.mock,requestId:randomUUID()}),
   (error: Failure)=>error.code==='SUBJECT_VARIANT_SOURCE_UNSUPPORTED'&&error.details?.reason===reason);
 }
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM subject_variant_batches').get()!.n,0);
});

test('a full image queue refuses a batch that would not fit',async t=>{
 const f=await fixture(t,{autoRun:false}),batch=await f.create(['front','front-left','left','back-left','back','back-right'].map(position=>angle(position)));
 await f.submit(batch);
 await assert.rejects(f.create([angle('right'),angle('front-right'),angle('high')]),{code:'SUBJECT_VARIANT_QUEUE_FULL'});
 assert.equal((await f.create([angle('right'),angle('front-right')])).items.length,2);
});

test('a result published while variants were not listening is linked on the next start',async t=>{
 const f=await fixture(t),batch=await f.create([angle('low')]);
 setImageResultListener(f.store.db,()=>{});
 await f.submit(batch);
 const unlinked=await f.settled(batch,value=>value.items[0]!.image?.state==='succeeded');
 assert.equal(unlinked.items[0]!.status,'running','a finished but unlinked image is not yet a version');
 await f.restart();
 const linked=await f.get(batch);
 assert.equal(linked.items[0]!.status,'succeeded');assert.equal((await f.versions()).length,2);
});

test('storage guards keep variants out of the head and bound to an active batch',async t=>{
 const f=await fixture(t),batch=await f.create([angle('front')]);await f.submit(batch);await f.settled(batch);
 const [, variant]=await f.versions(),subject=await f.subjectNow();
 assert.throws(()=>f.store.db.prepare('UPDATE subjects SET revision=revision+1,headVersionId=? WHERE id=?').run(variant!.id,subject.id),/subject identity is immutable/);
 assert.throws(()=>f.store.db.prepare('UPDATE subjects SET revision=revision+1 WHERE id=?').run(subject.id),/subject identity is immutable/);
 // A variant naming a local batch must match it; an imported one (no local batch) keeps its label.
 const data=(id: string,patch: Row)=>JSON.stringify({...(JSON.parse(String(f.store.db.prepare('SELECT data FROM subject_versions WHERE id=?').get(variant!.id)!.data))),id,number:99,variant:{...variant!.variant,...patch}});
 const insert=(id: string,patch: Row)=>f.store.db.prepare('INSERT INTO subject_versions(id,projectId,subjectId,number,assetId,data) SELECT ?,projectId,subjectId,99,assetId,? FROM subject_versions WHERE id=?').run(id,data(id,patch),variant!.id);
 for(const patch of [{position:'back',kind:'light'},{sourceVersionId:variant!.id}]){const id=randomUUID();assert.throws(()=>insert(id,patch),/must belong to an active batch/);}
 f.store.db.exec('SAVEPOINT orphan');insert(randomUUID(),{batchId:randomUUID()});f.store.db.exec('ROLLBACK TO orphan;RELEASE orphan');
 assert.throws(()=>f.store.db.prepare("UPDATE subject_variant_batches SET kind='light',revision=revision+1 WHERE id=?").run(batch.id),/batch identity is immutable/);
 assert.throws(()=>f.store.db.prepare('DELETE FROM subject_variant_items WHERE batchId=?').run(batch.id),/must be retained/);
});

test('a schema62 backup restores as restored63 that holds every variant row and refuses variant operations',async t=>{
 const f=await fixture(t),kept=await f.create([angle('front'),angle('left')]);await f.submit(kept);await f.settled(kept);
 const hidden=await f.create([angle('right')]);await f.submit(hidden);const done=await f.settled(hidden);
 await f.call('subject.variants.undo',{projectId:f.projectId,batchId:hidden.id,expectedRevision:done.revision,requestId:randomUUID()});
 const visible=(await f.versions()).map(version=>version.id);assert.equal(visible.length,3);
 const tables=['subjects','subject_versions','subject_variant_batches','subject_variant_items','subject_variant_requests'];
 const rows=(db: DatabaseSync)=>Object.fromEntries(tables.map(table=>{const query=db.prepare(`SELECT rowid AS retainedRowid,* FROM ${table} ORDER BY rowid`);query.setReadBigInts(true);return [table,query.all().map(row=>({...row}))];}));
 const before=rows(f.store.db);await f.stop();
 const base=mkdtempSync(path.join(tmpdir(),'mioon-subject-variant-backup-')),backup=path.join(base,'backup'),restored=path.join(base,'restored');
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 assert.equal((await createWorkspaceBackup({source:f.root,destination:backup})).databaseSchemaVersion,62);
 const result=await restoreWorkspaceBackup({directory:backup,destination:restored});
 assert.deepEqual([result.sourceSchema,result.databaseSchemaVersion,result.profile],[62,63,'restored-local-v20']);
 const store=openStore(restored),services=createServices(store,new Map());
 t.after(async()=>{await services.drain?.();store.close();});
 assert.equal(readCurrentWorkspaceRole(store.db),'restored-63-evidence');
 assert.deepEqual(rows(store.db),before,'every subject, version, batch, item and receipt is kept byte for byte');
 assert.deepEqual(store.db.prepare("SELECT kind,count(*) AS n FROM workspace_restore_holds WHERE kind LIKE 'subject_variant_%' GROUP BY kind ORDER BY kind").all().map(row=>[row.kind,row.n]),
  [['subject_variant_batches',2],['subject_variant_items',3],['subject_variant_requests',3]]);
 // The undone batch stays hidden in the restored copy's version list.
 assert.deepEqual((await services.call('subject.version.list',{projectId:f.projectId,subjectId:f.subject.id}) as {items: Version[]}).items.map(version=>version.id),visible);
 const refused: Record<string,Row>={
  'subject.variants.create':{projectId:f.projectId,subjectId:f.subject.id,sourceVersionId:f.subject.headVersionId,kind:'angle',items:[angle('back')],providerId:'mock',model:IMAGE_MODELS.mock,requestId:randomUUID()},
  'subject.variants.retry':{projectId:f.projectId,batchId:kept.id,position:1,expectedRevision:1,requestId:randomUUID()},
  'subject.variants.undo':{projectId:f.projectId,batchId:kept.id,expectedRevision:1,requestId:randomUUID()},
  'subject.variants.get':{projectId:f.projectId,batchId:kept.id},
  'subject.variants.list':{projectId:f.projectId,subjectId:f.subject.id},
 };
 for(const [operation,input] of Object.entries(refused))await assert.rejects(services.call(operation,input),{code:'RESTORE_OPERATION_UNAVAILABLE'},operation);
 assert.throws(()=>store.db.prepare("UPDATE subject_variant_batches SET state='undone',revision=revision+1 WHERE id=?").run(kept.id),/RESTORED_RECORD_HELD/);
 assert.deepEqual(rows(store.db),before);
});

test('a project package leaves hidden variant versions behind and imports the rest with their labels',async t=>{
 const f=await fixture(t),kept=await f.create([angle('front')]);await f.submit(kept);await f.settled(kept);
 const hidden=await f.create([angle('left'),angle('right')]);await f.submit(hidden);const done=await f.settled(hidden);
 await f.call('subject.variants.undo',{projectId:f.projectId,batchId:hidden.id,expectedRevision:done.revision,requestId:randomUUID()});
 const visible=await f.versions();assert.deepEqual(visible.map(version=>version.number),[1,2]);
 const options={media:'all' as const,includeExports:false},collected=collectProject(f.store as never,f.projectId,options);
 assert.deepEqual(collected.missing,[]);
 assert.deepEqual(collected.document.subjectVersions.map(row=>row.id),visible.map(version=>version.id),'versions of the undone batch stay behind');
 const work=mkdtempSync(path.join(tmpdir(),'mioon-subject-variant-package-')),targetRoot=mkdtempSync(path.join(tmpdir(),'mioon-subject-variant-target-')),staging=mkdtempSync(path.join(tmpdir(),'mioon-subject-variant-stage-')),file=path.join(work,'variants.mioon');
 t.after(()=>{for(const directory of [work,targetRoot,staging])rmSync(directory,{recursive:true,force:true});});
 const document=packageDocumentBytes(collected.document),manifest=buildManifest({collected,document,appVersion:'test',options,name:'Subject variants'});
 await pipeline(Readable.from(writeProjectPackage({manifest,document,media:collected.media.map(entry=>entry.source)})),createWriteStream(file));
 const read=await readProjectPackage({source:createReadStream(file),destination:staging});
 const target=openStore(targetRoot),services=createServices(target,new Map());t.after(async()=>{await services.drain?.();target.close();});
 const {projectId}=createProjectFromDocument(target as never,{document:read.document as never,files:new Map([...read.media].map(([key,value])=>[key,value.file])),name:'Imported variants',move:true});
 const subject=(await services.call('subject.list',{projectId}) as {items: Subject[]}).items[0]!;
 // The revision still counts the hidden numbers; the head stays the original version.
 assert.deepEqual([subject.revision,subject.headVersion.number],[4,1]);
 const imported=(await services.call('subject.version.list',{projectId,subjectId:subject.id}) as {items: Version[]}).items;
 assert.deepEqual(imported.map(version=>[version.number,version.variant?.kind??null,version.variant?.position??null]),[[1,null,null],[2,'angle','front']]);
 // The label survives without a local batch, so the imported version is an ordinary choice.
 assert.equal(target.db.prepare('SELECT count(*) AS n FROM subject_variant_batches').get()!.n,0);
 const added=await services.call('subject.version.add',{projectId,subjectId:subject.id,expectedRevision:subject.revision,assetId:(imported[1] as Version&{assetId: string}).assetId,requestId:randomUUID()}) as Subject;
 assert.deepEqual([added.revision,added.headVersion.number],[5,5]);
});
