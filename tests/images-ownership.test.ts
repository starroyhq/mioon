import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {imageFixture,insert} from './images-fixture.mjs';
import {createOwnedMediaGraphReader,createInspectionServices} from '../packages/business/src/inspection.ts';
import {createImageOwnershipReader} from '../packages/business/src/image-ownership.ts';
import {createSubjectRecoveryBoundary} from '../packages/business/src/subjects.ts';
import {type TestContext} from 'node:test';
interface ImageFixture {db: import('node:sqlite').DatabaseSync; projectId: string; otherProjectId: string; assetId: string;
  versionId: string; groupId: string; taskId: string; inputHash: string; asset: Record<string, unknown>; version: Record<string, unknown>;
  snapshot: Record<string, unknown>; input: Record<string, unknown>; receipt: Record<string, unknown>; succeed(): void}
const unavailable=(e: unknown)=>{const failure=e as {code?: string; status?: number}; return failure.code==='INSPECTION_UNAVAILABLE'&&failure.status===404&&!JSON.stringify(e).includes('private payload');};
const graph=(f: ImageFixture)=>createOwnedMediaGraphReader(f.db,f.projectId);
const changeAsset=(f: ImageFixture,patch: Record<string, unknown>)=>f.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...f.asset,...patch}),f.assetId);
function legacyOwner(f: ImageFixture,{foreign=false,oversized=false}: {foreign?: boolean; oversized?: boolean}={}){
 const projectId=foreign?f.otherProjectId:f.projectId,jobId=randomUUID(),shotId=randomUUID(),id=randomUUID();
 insert(f.db,'shots',{id:shotId,projectId,data:JSON.stringify({id:shotId,projectId,referenceAssetIds:[]})});
 insert(f.db,'jobs',{id:jobId,projectId,data:JSON.stringify({id:jobId,projectId,shotId,assetId:f.assetId,versionId:id})});
 insert(f.db,'versions',{id,projectId,jobId,data:JSON.stringify({id,projectId,jobId,shotId,assetId:f.assetId,...(oversized?{private:'private payload'.repeat(6000)}:{})})});return id;
}

test('valid image lineage is typed, immutable and usable as an asset-only clip and subject source',(t: TestContext)=>{
 const f=(imageFixture as unknown as (context: TestContext) => ImageFixture)(t);f.succeed();const read=graph(f),before=(f.db.prepare('SELECT total_changes() n').get() as {n: number}).n;
 assert.deepEqual(read.asset(f.assetId),f.asset);assert.deepEqual(read.imageVersion(f.versionId),f.version);
 const source={imageGroupId:f.groupId,imageTaskId:f.taskId,imageVersionId:f.versionId};assert.deepEqual(read.imageSource(f.assetId),source);
 assert.deepEqual(read.clipSource({assetId:f.assetId}),f.asset);assert.throws(()=>graph(f).clipSource({assetId:f.assetId,versionId:f.versionId}),unavailable);
 const subject=createSubjectRecoveryBoundary(f.db,{projectId:f.projectId}).asset(f.assetId) as {provenance?: unknown};
 assert.deepEqual(subject.provenance,{kind:'synthetic-mock',versionId:null,shotId:null,jobId:null,imageSource:source});
 assert.equal(JSON.stringify(subject).includes('media/'),false);assert.equal((f.db.prepare('SELECT total_changes() n').get() as {n: number}).n,before);
 const raw=createImageOwnershipReader(f.db,f.projectId);assert.equal(raw.task(f.taskId).row.inputHash,f.inputHash);assert.equal(raw.group(f.groupId).revision,2);
});

test('imported legacy subject provenance serializes byte-for-byte without imageSource',t=>{
 const f=imageFixture(t),id=randomUUID(),asset={...f.asset,id,provenance:'user-import'};insert(f.db,'assets',{id,projectId:f.projectId,data:JSON.stringify(asset)});
 const value=createSubjectRecoveryBoundary(f.db,{projectId:f.projectId}).asset(id) as {provenance?: unknown};
 assert.equal(JSON.stringify(value.provenance),'\u007b"kind":"user-import","versionId":null,"shotId":null,"jobId":null}');
 assert.equal(graph(f).imageSource(id),null);
});

for(const patch of [{sha256:'b'.repeat(64)},{sizeBytes:127},{mimeType:'image/jpeg'},{width:512},{height:512},{provenance:'user-import'},{projectId:randomUUID()}])test(`imageVersion cached path rejects changed asset metadata ${Object.keys(patch)[0]}`,(t: TestContext)=>{
 const f=(imageFixture as unknown as (context: TestContext) => ImageFixture)(t);f.succeed();changeAsset(f,patch);const read=graph(f);
 assert.throws(()=>read.imageVersion(f.versionId),unavailable);assert.throws(()=>read.asset(f.assetId),unavailable);
});

for(const variant of ['version-json','version-size','version-sql-project','task-snapshot','task-input','task-receipt','group-project','group-size'])test(`corrupt image ${variant} fails closed before disclosure`,(t: TestContext)=>{
 const f=(imageFixture as unknown as (context: TestContext) => ImageFixture)(t);f.succeed();f.db.exec('PRAGMA foreign_keys=OFF;PRAGMA ignore_check_constraints=ON;DROP TRIGGER immutable_image_versions;DROP TRIGGER immutable_image_task_identity;DROP TRIGGER image_task_state_transitions;DROP TRIGGER immutable_image_group_identity;');
 if(variant==='version-json')f.db.prepare('UPDATE image_versions SET data=?').run(JSON.stringify({...f.version,id:randomUUID(),private:'private payload'}));
 if(variant==='version-size')f.db.prepare('UPDATE image_versions SET data=?').run(JSON.stringify({...f.version,private:'private payload'.repeat(1000)}));
 if(variant==='version-sql-project')f.db.prepare('UPDATE image_versions SET projectId=?').run(f.otherProjectId);
 if(variant==='task-snapshot')f.db.prepare('UPDATE image_tasks SET snapshot=?').run(JSON.stringify({...f.snapshot,prompt:'changed private payload'}));
 if(variant==='task-input')f.db.prepare('UPDATE image_tasks SET input=?').run(JSON.stringify({...f.input,prompt:'changed private payload'}));
 if(variant==='task-receipt')f.db.prepare('UPDATE image_tasks SET stagedReceipt=?').run(JSON.stringify({...f.receipt,sha256:'f'.repeat(64)}));
 if(variant==='group-project')f.db.prepare('UPDATE image_groups SET projectId=?').run(f.otherProjectId);
 if(variant==='group-size')f.db.prepare('UPDATE image_groups SET name=?').run('private payload'.repeat(1000));
 assert.throws(()=>graph(f).asset(f.assetId),unavailable);
});

test('cross-family owner triggers are reciprocal and corrupted mixed owners reject even disguised imports',(t: TestContext)=>{
 const f=(imageFixture as unknown as (context: TestContext) => ImageFixture)(t);f.succeed();assert.throws(()=>legacyOwner(f),/already has an owner/);
 f.db.exec('DROP TRIGGER reject_legacy_image_asset_owner');legacyOwner(f,{foreign:true});assert.throws(()=>graph(f).asset(f.assetId),unavailable);
 changeAsset(f,{provenance:'user-import'});assert.throws(()=>graph(f).asset(f.assetId),unavailable);
 const g=imageFixture(t);insert(g.db,'assets',{id:g.assetId,projectId:g.projectId,data:JSON.stringify({...g.asset,provenance:'user-import'})});legacyOwner(g);
 assert.throws(()=>insert(g.db,'image_versions',{id:g.versionId,projectId:g.projectId,groupId:g.groupId,taskId:g.taskId,number:1,assetId:g.assetId,data:JSON.stringify(g.version)}),/already has an owner/);
});

test('oversized valid-JSON legacy owner cannot hide beside a typed image owner',(t: TestContext)=>{
 const f=(imageFixture as unknown as (context: TestContext) => ImageFixture)(t);f.succeed();f.db.exec('DROP TRIGGER reject_legacy_image_asset_owner');legacyOwner(f,{foreign:true,oversized:true});
 assert.throws(()=>graph(f).asset(f.assetId),unavailable);changeAsset(f,{provenance:'user-import'});assert.throws(()=>graph(f).asset(f.assetId),unavailable);
});

test('damaged duplicate image owners and missing generated owners fail uniformly',(t: TestContext)=>{
 const f=(imageFixture as unknown as (context: TestContext) => ImageFixture)(t);f.succeed();f.db.exec('PRAGMA foreign_keys=OFF;DROP TABLE image_versions;CREATE TABLE image_versions(id TEXT,projectId TEXT,groupId TEXT,taskId TEXT,number INTEGER,assetId TEXT,data TEXT)');
 for(const id of [f.versionId,randomUUID()])insert(f.db,'image_versions',{id,projectId:f.projectId,groupId:f.groupId,taskId:f.taskId,number:1,assetId:f.assetId,data:JSON.stringify({...f.version,id})});
 assert.throws(()=>graph(f).asset(f.assetId),unavailable);f.db.exec('DELETE FROM image_versions');assert.throws(()=>graph(f).asset(f.assetId),unavailable);
});

test('task scope and exact staged receipt are revalidated independently of success state',t=>{
 const f=imageFixture(t),read=createImageOwnershipReader(f.db,f.projectId);assert.equal(read.task(f.taskId).dto.state,'queued');
 assert.throws(()=>createImageOwnershipReader(f.db,f.otherProjectId).task(f.taskId),unavailable);
 f.db.exec('PRAGMA ignore_check_constraints=ON;DROP TRIGGER immutable_image_task_identity;DROP TRIGGER image_task_state_transitions');f.db.prepare("UPDATE image_tasks SET state='persisting',dispatched=1,revision=2,stagedReceipt=?").run(JSON.stringify({...f.receipt,taskId:randomUUID()}));
 assert.throws(()=>createImageOwnershipReader(f.db,f.projectId).task(f.taskId),unavailable);
});
