import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {schemas,LOCAL_MUTATION_OPERATIONS,isSubjectMutationResponse,isSubjectListResponse} from '@mioon/contracts';
import {type TestContext} from 'node:test';
import {errorView} from './helpers/test-error.ts';
interface SubjectRecord {id: string; projectId: string; revision: number; kind: string; headVersionId: string; name: string; needsReview?: boolean;
  subjectVersionId?: string | null; reviewedHeadVersionId?: string | null; items: SubjectRecord[]; nextCursor?: string | null;
  headVersion: {assetId: string; provenance: Record<string, unknown>; id?: string; number?: number; [key: string]: unknown};
  [key: string]: unknown}
interface SubjectFixture {root: string; store: ReturnType<typeof openStore>; project: SubjectRecord; other: SubjectRecord;
  call<T = SubjectRecord>(operation: string, input: unknown): Promise<T>;
  restart(): void;
  asset(projectId?: string, patch?: Record<string, unknown>): Record<string, unknown> & {id: string; projectId: string};
  create(asset: Record<string, unknown>, patch?: Record<string, unknown>): Record<string, unknown> & {requestId: string; projectId: string; assetId: string};
  add(subject: SubjectRecord, asset: {id: string}, patch?: Record<string, unknown>): Record<string, unknown> & {requestId: string};
  bind(subject: SubjectRecord, shot: SubjectRecord, patch?: Record<string, unknown>): Record<string, unknown> & {requestId: string}}

async function fixture(t: TestContext): Promise<SubjectFixture> {
 const root=await mkdtemp(path.join(tmpdir(),'mioon-subjects-'));let store: ReturnType<typeof openStore> | undefined,services: ReturnType<typeof createServices> | undefined;
 // openStore installs the current subject schema. The historical installer is
 // not rerun: since schema62 it would recreate the replaced identity guard.
 const start=()=>{const opened=openStore(root);store=opened;services=createServices(opened,new Map());};start();
 const f: SubjectFixture = {project: undefined as unknown as SubjectRecord, other: undefined as unknown as SubjectRecord, root,get store(){return store!;},call:<T = SubjectRecord>(op: string,input: unknown)=>services!.call(op,input) as Promise<T>,restart(){store!.close();start();},
  asset(projectId?: string,patch: Record<string, unknown>={}){return store!.put('assets',{id:randomUUID(),projectId:projectId ?? f.project.id,name:'Owned reference',mimeType:'image/png',sha256:'a'.repeat(64),width:640,height:480,relativePath:'media/fixture',provenance:'user-import',...patch});},
  create(asset: Record<string, unknown>,patch: Record<string, unknown>={}){return {projectId:String(asset.projectId),kind:'character',name:'Subject',assetId:String(asset.id),requestId:randomUUID(),...patch};},
  add(subject: SubjectRecord,asset: {id: string},patch: Record<string, unknown>={}){return {projectId:subject.projectId,subjectId:subject.id,expectedRevision:subject.revision,assetId:asset.id,requestId:randomUUID(),...patch};},
  bind(subject: SubjectRecord,shot: SubjectRecord,patch: Record<string, unknown>={}){return {projectId:subject.projectId,subjectId:subject.id,shotId:shot.id,role:subject.kind==='look'?'style':'subject',subjectVersionId:subject.headVersionId,expectedRevision:0,expectedSubjectRevision:subject.revision,requestId:randomUUID(),...patch};},
 };
 f.project=await f.call<SubjectRecord>('project.create',{name:'Subject domain'});f.other=await f.call<SubjectRecord>('project.create',{name:'Foreign private project'});
 t.after(async()=>{store!.close();await rm(root,{recursive:true,force:true});});return f;
}
const snapshot=(f: SubjectFixture,omit: string[]=[])=>Object.fromEntries((f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as {name: string}[]).filter(({name})=>!omit.includes(name)).map(({name})=>{const s=f.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`);s.setReadBigInts(true);return [name,s.all()];}));
const count=(f: SubjectFixture,table: string)=>(f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n: number}).n;
const missing=(e: unknown)=>{const failure=e as {code?: string; status?: number; details?: Record<string, unknown>}; return failure.code==='NOT_FOUND'&&failure.status===404&&Object.keys(failure.details ?? {}).length===0;};
const subjectTables: string[]=['subjects','subject_versions','subject_bindings','subject_requests'];

test('strict schemas, twelve local operations, mandatory keys and bounded noncreating reads',async t=>{
 const f=await fixture(t),before=snapshot(f),projectId=f.project.id;
 assert.deepEqual([...LOCAL_MUTATION_OPERATIONS],['shot.create','shot.update','shot.reorder','node.create','node.update','version.select','asset.range.set','asset.disposition.set','asset.annotation.set','subject.create','subject.version.add','subject.binding.set']);
 for(const op of ['subject.create','subject.version.add','subject.binding.set'])assert.equal((schemas as unknown as Record<string, {safeParse(value: unknown): {success: boolean}}>)[op].safeParse({projectId}).success,false);
 const result=await f.call('subject.list',{projectId});assert.deepEqual(result,{projectId,items:[],nextCursor:null});
 assert.equal(isSubjectListResponse('subject.list',{projectId},result),true);assert.deepEqual(snapshot(f),before);
 for(const input of [{projectId},{projectId,shotId:randomUUID(),subjectId:randomUUID()},{projectId,shotId:randomUUID(),limit:51}])await assert.rejects(f.call('subject.binding.list',input),{code:'VALIDATION_ERROR'});
 await assert.rejects(f.call('subject.list',{projectId,limit:0}),{code:'VALIDATION_ERROR'});
 await assert.rejects(f.call('subject.list',{projectId,cursor:'bad'}),{code:'INVALID_CURSOR'});
});

test('frozen heads, independent binding revisions, review old selection and tombstones preserve all older data and bytes',async t=>{
 const f=await fixture(t),a=f.asset(),b=f.asset(f.project.id,{sha256:'b'.repeat(64),mimeType:'image/webp'}),shot1=await f.call('shot.create',{projectId:f.project.id,title:'First'}),shot2=await f.call('shot.create',{projectId:f.project.id,title:'Second'});
 await writeFile(path.join(f.root,'media/fixture'),'immutable source bytes');const before=snapshot(f,subjectTables),bytes=await readFile(path.join(f.root,'media/fixture'));
 const input=f.create(a),s1=await f.call('subject.create',input);assert.equal(isSubjectMutationResponse('subject.create',input,s1),true);
 assert.deepEqual(s1.headVersion.provenance,{kind:'user-import',versionId:null,shotId:null,jobId:null});
 const first=f.bind(s1,shot1),binding1=await f.call('subject.binding.set',first),binding2=await f.call('subject.binding.set',f.bind(s1,shot2));
 const s2=await f.call('subject.version.add',f.add(s1,b));assert.equal(s2.revision,2);
 const listed=await f.call('subject.binding.list',{projectId:f.project.id,subjectId:s1.id});assert.equal(listed.items.length,2);assert.ok(listed.items.every(i=>i.needsReview&&i.subjectVersionId===s1.headVersionId&&i.revision===1));
 const ackInput=f.bind(s2,shot1,{subjectVersionId:s1.headVersionId,expectedRevision:1}),ack=await f.call('subject.binding.set',ackInput);assert.equal(ack.needsReview,false);assert.equal(ack.subjectVersionId,s1.headVersionId);assert.equal(ack.reviewedHeadVersionId,s2.headVersionId);
 const detached=await f.call('subject.binding.set',f.bind(s2,shot1,{subjectVersionId:null,expectedRevision:2}));assert.equal(detached.revision,3);assert.equal(detached.id,binding1.id);
 const retained=(await f.call('subject.binding.list',{projectId:f.project.id,shotId:shot1.id})).items[0]!;assert.equal(retained.subjectVersionId,null);assert.equal(retained.revision,3);
 const restored=await f.call('subject.binding.set',f.bind(s2,shot1,{subjectVersionId:s1.headVersionId,expectedRevision:3}));assert.equal(restored.revision,4);assert.equal(restored.id,binding1.id);
 // Subject edits add only their exact target evidence; every existing target
 // and every other table still participates in the complete snapshot below.
 for(const target of [
  {kind:'subject',targetId:s1.id,revision:2n},
  {kind:'subject_version',targetId:s1.headVersionId,revision:1n},
  {kind:'subject_binding',targetId:binding1.id,revision:4n},
  {kind:'subject_binding',targetId:binding2.id,revision:1n},
  {kind:'subject_version',targetId:s2.headVersionId,revision:1n},
 ]){
  assert.equal(before.agent_task_target_revisions_v2.some(row=>row.kind===target.kind&&row.targetId===target.targetId),false);
  before.agent_task_target_revisions_v2.push(Object.assign(Object.create(null),{projectId:f.project.id,...target}));
 }
 assert.deepEqual(snapshot(f,subjectTables),before);assert.deepEqual(await readFile(path.join(f.root,'media/fixture')),bytes);
 assert.equal(JSON.stringify(s2).includes('media/'),false);assert.equal(JSON.stringify(s2).includes('url'),false);
 assert.deepEqual(await f.call('subject.binding.set',first),binding1);assert.equal(binding2.revision,1);
});

test('exact replay precedes fresh revisions, survives restart and never refreshes historic head fields',async t=>{
 const f=await fixture(t),a=f.asset(),b=f.asset(),c=f.asset(),shot=await f.call('shot.create',{projectId:f.project.id,title:'Pinned'}),create=f.create(a),s1=await f.call('subject.create',create),bind=f.bind(s1,shot),binding=await f.call('subject.binding.set',bind),add=f.add(s1,b),s2=await f.call('subject.version.add',add);
 await f.call('subject.version.add',f.add(s2,c));f.restart();const before=snapshot(f);
 for(const [op,input,response] of [['subject.create',create,s1],['subject.version.add',add,s2],['subject.binding.set',bind,binding]])assert.deepEqual(await f.call(String(op),input),response);
 assert.deepEqual(snapshot(f),before);
 await assert.rejects(f.call('subject.version.add',{...add,requestId:randomUUID()}),(error: unknown)=>{const failure=errorView(error);const details=failure.details as {operation?: string; projectId?: string; mutationOutcome?: string};return failure.code==='REVISION_CONFLICT'&&details.operation==='subject.version.add'&&details.projectId===f.project.id&&details.mutationOutcome==='not_applied';});
 await assert.rejects(f.call('subject.create',{...create,name:'Changed'}),{code:'IDEMPOTENCY_CONFLICT'});
 await assert.rejects(f.call('subject.binding.set',{...bind,subjectVersionId:null}),{code:'IDEMPOTENCY_CONFLICT'});
});

test('full version pagination, scoped cursors and no-change rejection preserve exact counts',async t=>{
 const f=await fixture(t);let subject=await f.call('subject.create',f.create(f.asset()));const ids=[subject.headVersionId];
 for(let i=0;i<5;i++){subject=await f.call('subject.version.add',f.add(subject,f.asset()));ids.push(subject.headVersionId);}
 const before=snapshot(f);await assert.rejects(f.call('subject.version.add',f.add(subject,{id:subject.headVersion.assetId})),{code:'SUBJECT_NO_CHANGE'});assert.deepEqual(snapshot(f),before);
 const input={projectId:f.project.id,subjectId:subject.id,limit:2},first=await f.call('subject.version.list',input);assert.equal(first.items.length,2);assert.ok(first.nextCursor);
 const second=await f.call('subject.version.list',{...input,cursor:first.nextCursor}),third=await f.call('subject.version.list',{...input,cursor:second.nextCursor});assert.deepEqual([...first.items,...second.items,...third.items].map(v=>v.id),ids);assert.equal(third.nextCursor,null);
 await assert.rejects(f.call('subject.version.list',{...input,limit:3,cursor:first.nextCursor}),{code:'INVALID_CURSOR'});
 await assert.rejects(f.call('subject.list',{projectId:f.project.id,limit:2,cursor:first.nextCursor}),{code:'INVALID_CURSOR'});
 f.restart();await assert.rejects(f.call('subject.version.list',{...input,cursor:first.nextCursor}),{code:'INVALID_CURSOR'});
});

test('role gates, binding ceiling and absent unlink tombstones do not alter shots',async t=>{
 const f=await fixture(t),shot=await f.call('shot.create',{projectId:f.project.id,title:'Capacity'}),subjects=[];
 for(let i=0;i<9;i++)subjects.push(await f.call('subject.create',f.create(f.asset(),{kind:i===8?'look':'product',name:`S${i}`})));
 for(const s of subjects.slice(0,8))await f.call('subject.binding.set',f.bind(s,shot));
 const before=snapshot(f);await assert.rejects(f.call('subject.binding.set',f.bind(subjects[8],shot)),{code:'SUBJECT_BINDING_LIMIT'});assert.deepEqual(snapshot(f),before);
 await assert.rejects(f.call('subject.binding.set',f.bind(subjects[8],shot,{role:'subject'})),{code:'SUBJECT_ROLE_MISMATCH'});
 await f.call('subject.binding.set',f.bind(subjects[0],shot,{subjectVersionId:null,expectedRevision:1}));await f.call('subject.binding.set',f.bind(subjects[8],shot));
 const otherShot=await f.call('shot.create',{projectId:f.project.id,title:'No prior binding'}),tombstone=await f.call('subject.binding.set',f.bind(subjects[0],otherShot,{subjectVersionId:null}));assert.equal(tombstone.revision,1);assert.equal(tombstone.needsReview,false);
 assert.equal((f.store.get('shots',shot.id) as {revision: number}).revision,shot.revision);assert.equal(count(f,'timelines'),0);
});

test('foreign and corrupt ownership fail closed before receipt or revision, including later replay',async t=>{
 const f=await fixture(t),a=f.asset(),foreign=f.asset(f.other.id),create=f.create(a),subject=await f.call('subject.create',create),shot=await f.call('shot.create',{projectId:f.project.id,title:'Owned'}),otherShot=await f.call('shot.create',{projectId:f.other.id,title:'Foreign'});
 await assert.rejects(f.call('subject.create',f.create(foreign,{projectId:f.project.id})),missing);
 await assert.rejects(f.call('subject.binding.set',f.bind(subject,otherShot)),missing);
 const otherSubject=await f.call('subject.create',f.create(foreign));await assert.rejects(f.call('subject.binding.set',f.bind(subject,shot,{subjectVersionId:otherSubject.headVersionId})),missing);
 f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.other.id,'{foreign private data',a.id);const before=snapshot(f);
 await assert.rejects(f.call('subject.create',create),missing);await assert.rejects(f.call('subject.list',{projectId:f.project.id}),missing);assert.deepEqual(snapshot(f),before);
 f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.project.id,JSON.stringify({...a,id:randomUUID()}),a.id);
 await assert.rejects(f.call('subject.create',create),{code:'INVALID_SUBJECT_RECORD'});
 f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...a,sha256:'b'.repeat(64)}),a.id);await assert.rejects(f.call('subject.list',{projectId:f.project.id}),{code:'INVALID_SUBJECT_RECORD'});
});

test('owned media lineage rejects hidden foreign generated owners and freezes valid local provenance',async t=>{
 const f=await fixture(t),a=f.asset(),shot=await f.call('shot.create',{projectId:f.project.id,title:'Source'}),jobId=randomUUID(),versionId=randomUUID();
 f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId:shot.id,versionId,assetId:a.id});f.store.put('versions',{id:versionId,projectId:f.project.id,jobId,shotId:shot.id,assetId:a.id,sha256:a.sha256});
 const subject=await f.call('subject.create',f.create(a));assert.deepEqual(subject.headVersion.provenance,{kind:'user-import',versionId,shotId:shot.id,jobId});
 f.store.db.prepare('UPDATE jobs SET projectId=? WHERE id=?').run(f.other.id,jobId);await assert.rejects(f.call('subject.list',{projectId:f.project.id}),{code:'INVALID_SUBJECT_RECORD'});
});

test('shared namespace collisions are reciprocal, immutable history resists delete/update/replace, writes roll back with receipt',async t=>{
 const f=await fixture(t),a=f.asset(),input=f.create(a),before=snapshot(f);
 f.store.db.exec("CREATE TRIGGER injected_subject_failure BEFORE INSERT ON subject_requests BEGIN SELECT RAISE(ABORT,'receipt failure'); END;");
 await assert.rejects(f.call('subject.create',input),/receipt failure/);assert.deepEqual(snapshot(f),before);f.store.db.exec('DROP TRIGGER injected_subject_failure');
 const subject=await f.call('subject.create',input);
 await assert.rejects(f.call('shot.create',{projectId:f.project.id,title:'collision',requestId:input.requestId}),{code:'IDEMPOTENCY_CONFLICT'});
 const shot=await f.call('shot.create',{projectId:f.project.id,title:'Existing key',requestId:randomUUID()});const existing=f.store.db.prepare('SELECT requestId FROM mutation_requests').get() as {requestId: string};await assert.rejects(f.call('subject.create',{...f.create(a),requestId:existing!.requestId}),{code:'IDEMPOTENCY_CONFLICT'});
 for(const table of ['subject_versions','subject_requests']){
  assert.throws(()=>f.store.db.exec(`DELETE FROM ${table}`),/must be retained/);
  assert.throws(()=>f.store.db.exec(`UPDATE ${table} SET ${table==='subject_versions'?'data=data':'response=response'}`),/immutable/);
  const columns=f.store.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name).join(',');assert.throws(()=>f.store.db.exec(`INSERT OR REPLACE INTO ${table}(${columns}) SELECT ${columns} FROM ${table}`),/immutable/);
 }
 const binding=await f.call('subject.binding.set',f.bind(subject,shot));assert.ok(binding);assert.throws(()=>f.store.db.exec('DELETE FROM subject_bindings'),/retained/);
});

test('corrupt retained responses, oversized rows and post-write owner changes fail closed without leaking or partial writes',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.create(asset),subject=await f.call('subject.create',input),row=f.store.db.prepare('SELECT response FROM subject_requests WHERE requestId=?').get(input.requestId) as {response: string};
 f.store.db.exec('DROP TRIGGER immutable_subject_requests; PRAGMA ignore_check_constraints=ON');
 for(const response of ['{private secret',JSON.stringify({...subject,extra:'private secret'}),JSON.stringify({...subject,headVersion:{...subject.headVersion,sha256:'b'.repeat(64)}}),JSON.stringify({...subject,padding:'x'.repeat(16384)})]){
  f.store.db.prepare('UPDATE subject_requests SET response=? WHERE requestId=?').run(response,input.requestId);const before=snapshot(f);
  await assert.rejects(f.call('subject.create',input),(error: unknown)=>{const failure=errorView(error);return failure.code==='INVALID_SUBJECT_RECORD'&&!(failure.details as {mutationOutcome?: unknown}).mutationOutcome&&!JSON.stringify(failure.details).includes('private secret');});assert.deepEqual(snapshot(f),before);
 }
 f.store.db.prepare('UPDATE subject_requests SET response=? WHERE requestId=?').run(row!.response,input.requestId);
 f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...asset,padding:'x'.repeat(16384)}),asset.id);await assert.rejects(f.call('subject.list',{projectId:f.project.id}),{code:'INVALID_SUBJECT_RECORD'});
 f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(asset),asset.id);f.store.db.exec('PRAGMA ignore_check_constraints=OFF');
 const next=f.asset(),fresh=f.create(next),before=snapshot(f);
 f.store.db.exec(`CREATE TRIGGER reassign_subject_asset AFTER INSERT ON subject_requests BEGIN UPDATE assets SET projectId='${f.other.id}' WHERE id='${next.id}'; END;`);
 await assert.rejects(f.call('subject.create',fresh),missing);assert.deepEqual(snapshot(f),before);
});

test('version and binding identities enforce relational ownership, frozen JSON and retained monotonic revisions',async t=>{
 const f=await fixture(t),subject=await f.call('subject.create',f.create(f.asset())),shot=await f.call('shot.create',{projectId:f.project.id,title:'Relational'}),binding=await f.call('subject.binding.set',f.bind(subject,shot)),before=snapshot(f);
 assert.throws(()=>f.store.db.prepare('UPDATE subjects SET name=? WHERE id=?').run('Changed',subject.id),/immutable/);
 assert.throws(()=>f.store.db.prepare('UPDATE subject_bindings SET revision=revision WHERE id=?').run(binding.id),/immutable/);
 const v={...subject.headVersion,id:randomUUID(),number:2};
 assert.throws(()=>f.store.db.prepare('INSERT INTO subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)').run(v.id,f.project.id,subject.id,2,v.assetId,JSON.stringify({...v,subjectId:randomUUID()})),/CHECK/);
 assert.deepEqual(snapshot(f),before);
});
