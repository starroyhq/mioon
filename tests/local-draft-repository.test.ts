import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {SQLInputValue} from 'node:sqlite';
import {schemas} from '@mioon/contracts';
import {clipDraftDiskSchema} from '@mioon/contracts/local-drafts';
import type {ClipDraftDisk,ClipDraftSlot} from '@mioon/contracts/local-drafts';
import {createLocalDeliverySchemas} from '@mioon/contracts/local-delivery';
import {createLocalShotTextSchemas} from '@mioon/contracts/local-shot-text';
import {createLocalDraftRepository,localDraftDigest,LocalDraftRepositoryError} from '../packages/business/src/local-draft-repository.ts';
import type {LocalDraftKind} from '../packages/business/src/local-draft-repository.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {registerProjectTransactionFence,registerProjectTransactionObserver} from '../packages/business/src/project-file/store.ts';
import {DRAFT_TABLES} from '../packages/business/src/project-file/schema/domains/drafts.ts';
import {createServices} from '../packages/business/src/services.ts';

const deliverySchemas=createLocalDeliverySchemas(value=>schemas['timeline.render'].safeParse(value).success);
const shotSchemas=createLocalShotTextSchemas(value=>schemas['shot.update'].safeParse(value).success);
const stamp='2026-11-04T00:00:00.000Z';
const definitions={clip:{table:'local_clip_drafts',fields:['projectId','timelineId','clipId','revision']},
  delivery:{table:'local_delivery_drafts',fields:['projectId','draftRevision','intentRevision']},
  'shot-text':{table:'local_shot_text_drafts',fields:['projectId','shotId','draftRevision','intentRevision']}} as const;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function sqlValue(value:unknown):SQLInputValue{
  if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='bigint')return value;
  throw new TypeError('Fixture SQL projection must be a scalar');
}
function projections(kind:LocalDraftKind,row:Record<string,unknown>){
  const fields:string[]=[...definitions[kind].fields],values=fields.map(field=>sqlValue(row[field]));
  if(kind!=='clip'){
    const intent=object(row.intent)?row.intent:null,input=intent&&object(intent.input)?intent.input:null,outcome=intent&&object(intent.outcome)?intent.outcome:null;
    fields.push('intentId','requestId','intentStatus');values.push(sqlValue(intent?.intentId??null),sqlValue(input?.requestId??null),sqlValue(outcome?.status??null));
  }
  fields.push('data');values.push(JSON.stringify(row));return {fields,values};
}
function nativeInsert(store:ProjectStore,kind:LocalDraftKind,row:Record<string,unknown>,ordinal:number,replace=false,rowid?:number){
  const {fields,values}=projections(kind,row);fields.push('ordinal');values.push(ordinal);
  if(rowid!==undefined){fields.push('rowid');values.push(rowid);}
  return store.db.prepare(`INSERT${replace?' OR REPLACE':''} INTO main.${definitions[kind].table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...values);
}
function nativeUpdate(store:ProjectStore,kind:LocalDraftKind,rowid:number,row:Record<string,unknown>,ordinal:number,newRowid=rowid){
  const {fields,values}=projections(kind,row);fields.push('ordinal','rowid');values.push(ordinal,newRowid);
  return store.db.prepare(`UPDATE OR REPLACE main.${definitions[kind].table} SET ${fields.map(field=>`${field}=?`).join(',')} WHERE rowid=?`).run(...values,rowid);
}
const snapshot=(store:ProjectStore)=>JSON.stringify(Object.fromEntries(DRAFT_TABLES.map(table=>[table,store.db.prepare(`SELECT rowid,* FROM main.${table} ORDER BY rowid`).all()])));
function nonDraftSnapshot(store:ProjectStore):string{
  return JSON.stringify(Object.fromEntries((['main','project','cache'] as const).map(schema=>{
    const objects=store.db.prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema ORDER BY type,name`).all();
    return [schema,{objects,tables:objects.filter(row=>row.type==='table'&&!String(row.name).startsWith('sqlite_')&&!DRAFT_TABLES.includes(String(row.name))).map(row=>{
      const name=String(row.name).replaceAll('"','""');return [name,store.db.prepare(`SELECT * FROM ${schema}."${name}" ORDER BY rowid`).all()];
    })}];
  })));
}
function clip(projectId:string,clipId=randomUUID()):ClipDraftSlot{return {projectId,timelineId:randomUUID(),clipId,revision:1,draft:null};}
function delivery(projectId:string){return deliverySchemas.slot.parse({projectId,draftRevision:1,draft:null,intentRevision:1,intent:{intentId:randomUUID(),timelineId:randomUUID(),baseRevision:1,draft:null,
  input:{projectId,expectedRevision:1,requestId:randomUUID(),purpose:'export'},createdAt:stamp,outcome:{status:'pending'}}});}
function shotRow(projectId:string,pending=false){
  const value={projectId,shotId:randomUUID(),draftRevision:1,draft:null,intentRevision:1,intent:{intentId:randomUUID(),baseRevision:1,
    baseText:{title:'Before',prompt:'Baseline prompt'},draft:{draftId:randomUUID(),revision:1,raw:{title:'After',prompt:'Baseline prompt'}},
    input:{requestId:randomUUID(),shotId:'',expectedRevision:1,patch:{title:'After'}},createdAt:stamp,
    outcome:pending?{status:'pending' as const}:{status:'not_applied' as const,code:'REVISION_CONFLICT',resolvedAt:stamp}}};
  value.intent.input.shotId=value.shotId;return shotSchemas.slot.parse(value);
}
const reason=(expected:string)=>(error:unknown)=>error instanceof LocalDraftRepositoryError&&error.reason===expected;
const sqlFailure=(error:unknown)=>error instanceof Error&&/LOCAL_DRAFT_SQL_|constraint/i.test(error.message);

async function fixture(t:test.TestContext){
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-draft-repository-')),store=openStore(root),services=createServices(store,new Map());
  await services.call('project.create',{name:'SQL draft repository'});
  let owned=true,fault:(point:'beforeCommit'|'afterCommit')=>void=()=>{};
  const repository=createLocalDraftRepository<ClipDraftDisk>({store,kind:'clip',ownsLock:()=>owned,validate:value=>clipDraftDiskSchema.parse(value),fault:point=>fault(point)});
  t.after(async()=>{await services.drain();store.close();rmSync(root,{recursive:true,force:true});});
  return {store,repository,setOwned:(value:boolean)=>{owned=value;},setFault:(value:typeof fault)=>{fault=value;}};
}

test('all four draft tables belong to history; initial reads create no state or SQL changes',async t=>{
  const f=await fixture(t),before=nonDraftSnapshot(f.store),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  for(const table of DRAFT_TABLES)for(const schema of ['main','project','cache']){
    assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM ${schema}.sqlite_schema WHERE type='table' AND name=?`).get(table)!.n,schema==='main'?1:0);
  }
  for(let i=0;i<3;i++){const value=f.repository.read();assert.deepEqual(value.entries,[]);assert.equal(value.version,2);assert.match(value.workspaceScope,/^[0-9a-f]{64}$/);}
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM local_draft_states').get()!.n,0);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);assert.equal(nonDraftSnapshot(f.store),before);
});

test('pure save uses the real transaction fences and only history drafts; stale whole-bundle CAS cannot overwrite it',async t=>{
  const f=await fixture(t),before=nonDraftSnapshot(f.store),initial=f.repository.read(),first={...initial,entries:[clip(f.store.projectId)]};
  let fences=0,observers=0;const removeFence=registerProjectTransactionFence(f.store.db,()=>{fences++;}),removeObserver=registerProjectTransactionObserver(f.store.db,()=>{observers++;});t.after(()=>{removeFence();removeObserver();});
  f.repository.save(first,localDraftDigest(initial));assert.equal(fences,1);assert.equal(observers,1);assert.deepEqual(f.repository.read(),first);
  assert.equal(nonDraftSnapshot(f.store),before);const saved=snapshot(f.store);
  assert.throws(()=>f.repository.save({...initial,entries:[clip(f.store.projectId)]},localDraftDigest(initial)),reason('CONFLICT'));
  assert.equal(snapshot(f.store),saved);assert.equal(nonDraftSnapshot(f.store),before);
});

test('failure before first COMMIT rolls back slot and state; a lost ACK after COMMIT is uncertain with exact saved data',async t=>{
  const f=await fixture(t),initial=f.repository.read(),next={...initial,entries:[clip(f.store.projectId)]},before=snapshot(f.store),business=nonDraftSnapshot(f.store);
  f.setFault(point=>{if(point==='beforeCommit')throw Error('synthetic commit fault');});
  assert.throws(()=>f.repository.save(next,localDraftDigest(initial)),reason('STORAGE_UNAVAILABLE'));assert.equal(snapshot(f.store),before);assert.deepEqual(f.repository.read(),initial);
  f.setFault(point=>{if(point==='afterCommit')throw Error('synthetic lost ACK');});
  assert.throws(()=>f.repository.save(next,localDraftDigest(initial)),reason('SAVE_UNCERTAIN'));f.setFault(()=>{});
  assert.deepEqual(f.repository.read(),next);assert.equal(nonDraftSnapshot(f.store),business);
});

test('removing the final slot preserves the kind scope and still refuses a different channel',async t=>{
  const f=await fixture(t),initial=f.repository.read();f.repository.save({...initial,entries:[clip(f.store.projectId)]},localDraftDigest(initial));
  f.repository.save({...initial,entries:[]},localDraftDigest(f.repository.read()));assert.deepEqual(f.repository.read(),initial);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM local_draft_states WHERE kind='clip'").get()!.n,1);
  const before=snapshot(f.store),foreign=createLocalDraftRepository<ClipDraftDisk>({store:f.store,kind:'clip',channel:'production',ownsLock:()=>true,validate:value=>clipDraftDiskSchema.parse(value)});
  assert.throws(()=>foreign.read(),reason('SCOPE_MISMATCH'));assert.equal(snapshot(f.store),before);
});

test('a nested transaction cannot acknowledge a save or leave an uncommitted state',async t=>{
  const f=await fixture(t),initial=f.repository.read(),before=snapshot(f.store);let acknowledged=false;
  f.store.tx(()=>{assert.throws(()=>{f.repository.save({...initial,entries:[clip(f.store.projectId)]},localDraftDigest(initial));acknowledged=true;},reason('STORAGE_UNAVAILABLE'));assert.equal(snapshot(f.store),before);});
  assert.equal(acknowledged,false);assert.equal(snapshot(f.store),before);
});

test('copied and closed stores cannot create authority; revoked owner is rechecked inside COMMIT',async t=>{
  const f=await fixture(t),initial=f.repository.read(),before=snapshot(f.store);
  const copied=createLocalDraftRepository<ClipDraftDisk>({store:{...f.store},kind:'clip',ownsLock:()=>true,validate:value=>clipDraftDiskSchema.parse(value)});
  assert.throws(()=>copied.read(),reason('OWNER_REQUIRED'));assert.throws(()=>copied.save(initial,localDraftDigest(initial)),reason('OWNER_REQUIRED'));
  f.setFault(point=>{if(point==='beforeCommit')f.setOwned(false);});assert.throws(()=>f.repository.save({...initial,entries:[clip(f.store.projectId)]},localDraftDigest(initial)),reason('OWNER_REQUIRED'));
  assert.equal(snapshot(f.store),before);f.setOwned(true);f.setFault(()=>{});f.store.close();assert.throws(()=>f.repository.read(),reason('OWNER_REQUIRED'));
});

test('native SQL cannot insert a foreign project or a slot without its kind state',async t=>{
  const f=await fixture(t),before=snapshot(f.store),row=clip(f.store.projectId);
  assert.throws(()=>nativeInsert(f.store,'clip',row,1),/LOCAL_DRAFT_SQL_STATE/);assert.equal(snapshot(f.store),before);
  f.store.db.prepare('INSERT INTO local_draft_states(kind,workspaceScope) VALUES(?,?)').run('clip',f.repository.scope());const withState=snapshot(f.store);
  assert.throws(()=>nativeInsert(f.store,'clip',{...row,projectId:randomUUID()},1),/LOCAL_DRAFT_SQL_PROJECT/);assert.equal(snapshot(f.store),withState);
  assert.deepEqual(f.repository.read().entries,[]);
});

test('scope metadata rejects all updates, deletion and replacement through either unique key',async t=>{
  const f=await fixture(t);f.store.db.prepare('INSERT INTO local_draft_states(kind,workspaceScope) VALUES(?,?)').run('clip',f.repository.scope());
  const before=snapshot(f.store),id=Number(f.store.db.prepare("SELECT rowid FROM local_draft_states WHERE kind='clip'").get()!.rowid);
  for(const operation of [()=>f.store.db.exec("UPDATE local_draft_states SET kind='delivery'"),()=>f.store.db.prepare('UPDATE local_draft_states SET workspaceScope=?').run('b'.repeat(64)),
    ()=>f.store.db.exec('DELETE FROM local_draft_states'),()=>f.store.db.prepare('INSERT OR REPLACE INTO local_draft_states(kind,workspaceScope) VALUES(?,?)').run('clip','b'.repeat(64)),
    ()=>f.store.db.prepare('INSERT OR REPLACE INTO local_draft_states(rowid,kind,workspaceScope) VALUES(?,?,?)').run(id,'delivery','b'.repeat(64))]){
    assert.throws(operation,/LOCAL_DRAFT_SQL_STATE/);assert.equal(snapshot(f.store),before);
  }
});

test('scope SQL validation rejects both overlong NUL suffixes and a 64-byte NUL-truncated value',async t=>{
  const f=await fixture(t),before=snapshot(f.store);
  for(const scope of ['a'.repeat(64)+'\0suffix','a'.repeat(63)+'\0']){
    assert.throws(()=>f.store.db.prepare('INSERT INTO local_draft_states(kind,workspaceScope) VALUES(?,?)').run('clip',scope),sqlFailure);
    assert.equal(snapshot(f.store),before);
  }
});

test('missing state is corrupt rather than a new empty bundle, even after the exact schema fence is restored',async t=>{
  const f=await fixture(t),initial=f.repository.read();f.repository.save({...initial,entries:[clip(f.store.projectId)]},localDraftDigest(initial));
  // Trusted corruption probe on the same real store. Restore the exact trigger
  // before reading, so neither a shadow store nor a production bypass is used.
  const sql=String(f.store.db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='trigger' AND name='local_draft_states_guard_delete'").get()!.sql);
  f.store.tx(()=>{f.store.db.exec('DROP TRIGGER local_draft_states_guard_delete');f.store.db.exec("DELETE FROM local_draft_states WHERE kind='clip'");f.store.db.exec(sql);});
  const before=snapshot(f.store);assert.throws(()=>f.repository.read(),reason('STORAGE_UNAVAILABLE'));assert.equal(snapshot(f.store),before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM local_draft_states').get()!.n,0);
});

test('native clip checks reject missing JSON fields, projection mismatches and unsafe numeric revisions without NULL loopholes',async t=>{
  const f=await fixture(t),initial=f.repository.read(),row=clip(f.store.projectId);f.repository.save({...initial,entries:[row]},localDraftDigest(initial));const before=snapshot(f.store);
  const missing=(key:string)=>Object.fromEntries(Object.entries(row).filter(([name])=>name!==key));
  for(const data of [missing('projectId'),missing('revision'),missing('draft'),{...row,revision:'1'},{...row,projectId:randomUUID()},{...row,draft:[]}]){
    assert.throws(()=>f.store.db.prepare('UPDATE local_clip_drafts SET data=?').run(JSON.stringify(data)),sqlFailure);assert.equal(snapshot(f.store),before);
  }
  for(const revision of [0,-1,1.5,9007199254740992]){
    assert.throws(()=>nativeUpdate(f.store,'clip',1,{...row,revision},1),sqlFailure);assert.equal(snapshot(f.store),before);
  }
});

test('intent JSON projections and nullability reject missing fields instead of passing a NULL CHECK',async t=>{
  const f=await fixture(t),row=delivery(f.store.projectId);f.store.db.prepare('INSERT INTO local_draft_states(kind,workspaceScope) VALUES(?,?)').run('delivery',f.repository.scope());nativeInsert(f.store,'delivery',row,1);const before=snapshot(f.store);
  const input={...row.intent!.input};delete (input as Partial<typeof input>).requestId;
  for(const data of [{...row,intent:null},{...row,intent:{...row.intent,input}},{...row,intent:{...row.intent,outcome:{}}},{...row,intent:{...row.intent,intentId:randomUUID()}},
    {...row,draftRevision:0,draft:{draftId:randomUUID(),timelineId:row.intent!.timelineId,baseRevision:1,raw:{deliveryName:'Raw'},updatedAt:stamp}}]){
    assert.throws(()=>f.store.db.prepare('UPDATE local_delivery_drafts SET data=?').run(JSON.stringify(data)),sqlFailure);assert.equal(snapshot(f.store),before);
  }
});

for(const kind of ['delivery','shot-text'] as const)test(`${kind} SQL rejects a numeric JSON requestId before TEXT affinity can disguise it`,async t=>{
  const f=await fixture(t),row=kind==='delivery'?delivery(f.store.projectId):shotRow(f.store.projectId);
  f.store.db.prepare('INSERT INTO local_draft_states(kind,workspaceScope) VALUES(?,?)').run(kind,f.repository.scope());nativeInsert(f.store,kind,row,1);const before=snapshot(f.store);
  const numeric={...row,intent:{...row.intent!,input:{...row.intent!.input,requestId:12345678}}};
  assert.throws(()=>nativeUpdate(f.store,kind,1,numeric,1),sqlFailure);assert.equal(snapshot(f.store),before);
});

for(const key of ['primary-key','rowid','ordinal'])for(const operation of ['insert','update'])test(`clip ${operation} OR REPLACE cannot evict a row through ${key}`,async t=>{
  const f=await fixture(t),initial=f.repository.read(),first=clip(f.store.projectId),second={...clip(f.store.projectId),timelineId:first.timelineId};f.repository.save({...initial,entries:[first,second]},localDraftDigest(initial));const before=snapshot(f.store),third={...clip(f.store.projectId),timelineId:first.timelineId};
  const candidate=key==='primary-key'?first:third,ordinal=key==='ordinal'?1:3;
  assert.throws(()=>operation==='insert'?nativeInsert(f.store,'clip',candidate,ordinal,true,key==='rowid'?1:undefined):nativeUpdate(f.store,'clip',2,candidate,ordinal,key==='rowid'?1:2),sqlFailure);
  assert.equal(snapshot(f.store),before);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM local_clip_drafts').get()!.n,2);
});

for(const key of ['project-primary-key','rowid','ordinal','intentId','requestId'])for(const operation of ['insert','update'])test(`delivery ${operation} OR REPLACE preserves its one-project row for ${key}`,async t=>{
  const f=await fixture(t),first=delivery(f.store.projectId);f.store.db.prepare('INSERT INTO local_draft_states(kind,workspaceScope) VALUES(?,?)').run('delivery',f.repository.scope());nativeInsert(f.store,'delivery',first,1);const before=snapshot(f.store),candidate=delivery(f.store.projectId);
  if(key==='intentId')candidate.intent!.intentId=first.intent!.intentId;if(key==='requestId')candidate.intent!.input.requestId=first.intent!.input.requestId;
  // A single-project history admits at most one delivery row. Its PK already
  // dominates these two intent unique keys; never seed a second project merely
  // to isolate an impossible unique-key conflict in an invalid layout.
  if(operation==='update'&&!['rowid','ordinal'].includes(key))candidate.projectId=randomUUID();
  assert.throws(()=>operation==='insert'?nativeInsert(f.store,'delivery',candidate,key==='ordinal'?1:2,true,key==='rowid'?1:undefined):nativeUpdate(f.store,'delivery',1,candidate,key==='ordinal'?2:1,key==='rowid'?2:1),sqlFailure);
  assert.equal(snapshot(f.store),before);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM local_delivery_drafts').get()!.n,1);
});

for(const key of ['primary-key','shotId','rowid','ordinal','intentId','requestId','pending-project'])for(const operation of ['insert','update'])test(`shot ${operation} OR REPLACE cannot evict a different slot through ${key}`,async t=>{
  const f=await fixture(t),first=shotRow(f.store.projectId,key==='pending-project'),second=shotRow(f.store.projectId),third=shotRow(f.store.projectId,key==='pending-project');
  f.store.db.prepare('INSERT INTO local_draft_states(kind,workspaceScope) VALUES(?,?)').run('shot-text',f.repository.scope());nativeInsert(f.store,'shot-text',first,1);nativeInsert(f.store,'shot-text',second,2);
  const before=snapshot(f.store),candidate=operation==='update'?structuredClone(second):third;
  if(key==='primary-key'||key==='shotId'){candidate.shotId=first.shotId;candidate.intent!.input.shotId=first.shotId;}
  if(key==='intentId')candidate.intent!.intentId=first.intent!.intentId;if(key==='requestId')candidate.intent!.input.requestId=first.intent!.input.requestId;
  if(key==='pending-project')candidate.intent!.outcome={status:'pending'};
  const ordinal=key==='ordinal'?1:operation==='update'?2:3;
  assert.throws(()=>operation==='insert'?nativeInsert(f.store,'shot-text',candidate,ordinal,true,key==='rowid'?1:undefined):nativeUpdate(f.store,'shot-text',2,candidate,ordinal,key==='rowid'?1:2),sqlFailure);
  assert.equal(snapshot(f.store),before);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM local_shot_text_drafts').get()!.n,2);
});
