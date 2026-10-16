import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHistoricalRestoreCapture} from '../packages/business/src/workspace-restore-capture-integrity.ts';
import {pairs,expectedPopulated,fresh,metadata,dispatch,alter,probe,readOnly,insert,snapshot,id,quote,wholeRowDigest,refreshFixtureHash} from './workspace-restore-capture-fixtures.mjs';

const contentChanges={jobs:"data=data||' '",exports:"data=data||' '",versions:"data=data||' '",job_events:"event=CAST(event||x'20' AS BLOB)",timeline_requests:"response=response||' '",reference_requests:"response=response||' '",idempotency:"requestHash='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",mutation_requests:"response=response||' '",asset_range_requests:"response=response||' '",asset_disposition_requests:"response=response||' '",subject_requests:"response=response||' '",agent_chat_threads:'revision=revision+1',agent_chat_requests:"acceptance=acceptance||' '",agent_chat_runs:"data=data||' '",agent_chat_events:"data=data||' '",agent_chat_steps:"data=data||' '",agent_chat_quota:'runs=runs+1',agent_edit_proposals:"definition=definition||' '",edit_tasks:"updatedAt='later'",project_lut_resources:"createdAt='2026-10-16T01:00:00.000Z'",asset_annotations:'revision=revision+1',asset_annotation_requests:"response=response||' '"};
for(const pair of pairs){
 test(`historical ${pair.restored}: populated type-preserving content mutations keep identity/FKs and fail capture equality`,async t=>{
  const db=fresh(t,pair,{populated:true});pair.install(db,metadata());
  const holds=db.prepare('SELECT kind,capturedRowid,rowHash FROM workspace_restore_holds');holds.setReadBigInts(true);
  for(const hold of holds.all())assert.equal(wholeRowDigest(db,hold.kind,hold.capturedRowid),hold.rowHash,'independent whole-byte oracle equals unchanged constructor');
  for(const kind of expectedPopulated(pair).filter(name=>name!=='lut_import_requests'))await t.test(kind,()=>probe(db,()=>{
   alter(db,[kind],()=>db.exec(`UPDATE ${quote(kind)} SET ${contentChanges[kind]}`));
   readOnly(db,()=>assert.equal(pair.validate(db).schemaVersion,pair.restored),{full:false});
   readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_CAPTURE_CHANGED',full:false});
  }));
 });

 test(`historical ${pair.restored}: legitimate current-origin growth does not demand new holds or rewrite archives`,t=>{
  const db=fresh(t,pair,{populated:true}),info=pair.install(db,metadata()),before=snapshot(db);
  insert(db,'timeline_requests',{requestId:'new-local-receipt',requestHash:'b'.repeat(64),response:'{}'});
  insert(db,'reference_requests',{requestId:'new-reference-receipt',requestHash:'b'.repeat(64),response:'{}'});
  const requestId='new-local-task',projectId=id(1);
  const task={id:id(200),projectId,operation:'timeline.undo',input:JSON.stringify({projectId,requestId,expectedRevision:1}),requestId,digest:'d'.repeat(64),lane:'timeline:mutation',origin:'new',status:'prepared',revision:1,acknowledged:0,createdAt:'now',updatedAt:'now',bytes:16384};
  assert.throws(()=>insert(db,'edit_tasks',{...task,executionEpoch:'captured'}),/RESTORED_RECORD_HELD|RESTORE_ORIGIN_REQUIRED/);
  assert.throws(()=>insert(db,'edit_tasks',{...task,executionEpoch:id(777)}),/RESTORE_ORIGIN_REQUIRED/);
  insert(db,'edit_tasks',{...task,executionEpoch:info.workspaceOrigin});
  readOnly(db,()=>assert.deepEqual(dispatch.validateRestore(db),info));
  for(const table of ['workspace_restore_holds','workspace_restore_timeline_history','workspace_restore_timeline_cursors','workspace_restore_evidence'])assert.deepEqual(snapshot(db).tables[table],before.tables[table]);
 });

 test(`historical ${pair.restored}: rowid zero, negative and >2^53 plus text/blob chunk boundaries retain independent constructor hashes`,t=>{
  const db=fresh(t,pair);insert(db,'projects',{id:id(1),data:JSON.stringify({id:id(1)})});insert(db,'jobs',{id:id(10),projectId:id(1),data:JSON.stringify({id:id(10),projectId:id(1)})});
  const vectors=[{rowid:0n,value:''},{rowid:-1n,value:Buffer.alloc(0)},{rowid:9007199254740993n,value:'界\0end'},
   {rowid:11n,value:Buffer.from([0,255,13,10])},{rowid:12n,value:'x'.repeat(1048576)},{rowid:13n,value:Buffer.alloc(1048577,0x61)},
   {rowid:14n,value:'界'.repeat(349526)}];
  for(const {rowid,value} of vectors)insert(db,'job_events',{id:rowid,jobId:id(10),event:value,createdAt:'digest-vector'});
  pair.install(db,metadata());
  const held=db.prepare("SELECT capturedRowid,rowHash FROM workspace_restore_holds WHERE kind='job_events'");held.setReadBigInts(true);
  for(const row of held.all())assert.equal(wholeRowDigest(db,'job_events',row.capturedRowid),row.rowHash);
  readOnly(db,()=>dispatch.validateRestore(db));
  for(const {rowid,value} of vectors)probe(db,()=>{
   alter(db,['job_events'],()=>db.prepare('UPDATE job_events SET event=? WHERE rowid=?').run(typeof value==='string'?value+'!':Buffer.concat([value,Buffer.from([33])]),rowid));
   readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_CAPTURE_CHANGED',full:false});
  });
  for(const [rowid,value] of [[0n,Buffer.alloc(0)],[9007199254740993n,Buffer.from('界\0end')]])probe(db,()=>{
   alter(db,['job_events'],()=>db.prepare('UPDATE job_events SET event=? WHERE rowid=?').run(value,rowid));
   readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_CAPTURE_CHANGED',full:false});
  });
 });

 test(`historical ${pair.restored}: null framing and genuine SQLite REAL formatting match constructor bytes`,t=>{
  const db=fresh(t,pair,{populated:true});db.prepare('UPDATE agent_chat_quota SET runs=?,bytes=?,reservedBytes=?').run(1e-7,1.2345678901234567,1e30);
  pair.install(db,metadata());
  assert.equal(db.prepare('SELECT typeof(runs) AS type FROM agent_chat_quota').get().type,'real');
  const stmt=db.prepare('SELECT kind,capturedRowid,rowHash FROM workspace_restore_holds');stmt.setReadBigInts(true);
  for(const row of stmt.all())assert.equal(wholeRowDigest(db,row.kind,row.capturedRowid),row.rowHash);
  readOnly(db,()=>dispatch.validateRestore(db));
  // The constructor excludes only executionEpoch. An epoch mismatch is still
  // refused by the unchanged earlier validator, not mislabeled a digest error.
  probe(db,()=>{alter(db,['edit_tasks'],()=>db.prepare('UPDATE edit_tasks SET executionEpoch=?').run(id(777)));readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_EPOCH_INVALID'});});
 });

 test(`historical ${pair.restored}: invalid live request shape preserves identity diagnostic after matching independent digest`,t=>{
  const db=fresh(t,pair,{populated:true});pair.install(db,metadata());
  alter(db,['timeline_requests','workspace_restore_holds'],()=>{db.exec("UPDATE timeline_requests SET requestId=''");refreshFixtureHash(db,'timeline_requests');});
  readOnly(db,()=>assert.equal(pair.validate(db).schemaVersion,pair.restored));
  readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_IDENTITY_INVALID'});
 });

 test(`historical ${pair.restored}: gate exact tuple is not a version-range admission API`,t=>{
  const db=fresh(t,pair);pair.install(db,metadata());
  readOnly(db,()=>validateHistoricalRestoreCapture(db,pair.restored));
  for(const wrong of [25,27,29,31,33,35,37,39].filter(value=>value!==pair.restored))readOnly(db,()=>validateHistoricalRestoreCapture(db,wrong),{code:'RESTORE_METADATA_INVALID',full:false});
  for(const wrong of [24,26,40,41,42])readOnly(db,()=>validateHistoricalRestoreCapture(db,wrong),{code:'RESTORE_SCHEMA_UNSUPPORTED',full:false});
 });
}

function exportSource(t,pair,{mode='storyboard',explicit=true,receipt=true}={}){
 const db=fresh(t,pair),projectId=id(1),exportId=id(5),requestId='export-matrix-key';
 insert(db,'projects',{id:projectId,data:JSON.stringify({id:projectId})});
 const data={id:exportId,projectId,...(mode==='absent'?{}:{mode}),...(explicit?{requestId}:{})};
 insert(db,'exports',{id:exportId,projectId,data:JSON.stringify(data)});
 if(receipt){
  if(mode==='timeline')insert(db,'timeline_requests',{requestId,requestHash:'a'.repeat(64),response:JSON.stringify({id:exportId,projectId})});
  else insert(db,'idempotency',{scope:'export',requestId,requestHash:'a'.repeat(64),resourceId:exportId});
 }
 const info=pair.install(db,metadata());return {db,info,requestId,exportId,projectId};
}
for(const pair of pairs){
 test(`historical ${pair.restored}: export saved-key matrix preserves explicit, inferred, null and legacy modes`,async t=>{
  for(const mode of ['timeline','storyboard',null,'absent'])for(const explicit of [true,false])await t.test(`mode=${mode}, explicit=${explicit}`,()=>{
   const {db,info,exportId,projectId}=exportSource(t,pair,{mode,explicit});readOnly(db,()=>assert.deepEqual(dispatch.validateRestore(db),info));
   // New receipts may point at the same old resource. The saved primary key,
   // not reverse inference against growing receipt tables, controls reopening.
   for(let n=0;n<3;n++){
    insert(db,'idempotency',{scope:'export',requestId:`later-export-${n}`,requestHash:'b'.repeat(64),resourceId:exportId});
    insert(db,'timeline_requests',{requestId:`later-timeline-${n}`,requestHash:'b'.repeat(64),response:JSON.stringify({id:exportId,projectId})});
   }
   readOnly(db,()=>assert.deepEqual(dispatch.validateRestore(db),info));
  });
  for(const mode of ['timeline','storyboard',null,'absent'])await t.test(`explicit key without saved receipt, mode=${mode}`,()=>{
   const {db}=exportSource(t,pair,{mode,explicit:true,receipt:false});readOnly(db,()=>dispatch.validateRestore(db));
  });
 });

 test(`historical ${pair.restored}: export saved metadata mismatch diagnostics remain specific`,async t=>{
  const {db}=exportSource(t,pair);
  for(const [field,value,code] of [['namespace','other','RESTORE_EXPORT_IDENTITY_UNSUPPORTED'],['namespace','timeline','RESTORE_EXPORT_IDENTITY_UNSUPPORTED'],['requestId','different-key','RESTORE_EXPORT_IDENTITY_UNSUPPORTED'],['operation','timeline.render','RESTORE_CAPTURE_CHANGED'],['projectId',id(99),'RESTORE_CAPTURE_CHANGED']])await t.test(`${field}=${value}`,()=>probe(db,()=>{
   alter(db,['workspace_restore_holds'],()=>db.prepare(`UPDATE workspace_restore_holds SET ${quote(field)}=? WHERE kind='exports'`).run(value));
   readOnly(db,()=>assert.equal(pair.validate(db).schemaVersion,pair.restored),{full:false});
   readOnly(db,()=>dispatch.validateRestore(db),{code,full:false});
  }));
 });

 test(`historical ${pair.restored}: export live malformed mode/request and wrong receipt binding preserve unsupported diagnostics`,async t=>{
  for(const [label,patch] of [['numeric mode',{mode:1}],['unsupported mode',{mode:'other'}],['object mode',{mode:{}}],['numeric request',{requestId:42}],['object request',{requestId:{}}]])await t.test(label,()=>{
   const {db}=exportSource(t,pair);
   alter(db,['exports','workspace_restore_holds'],()=>{const data=JSON.parse(db.prepare('SELECT data FROM exports').get().data);db.prepare('UPDATE exports SET data=?').run(JSON.stringify({...data,...patch}));refreshFixtureHash(db,'exports');});
   readOnly(db,()=>pair.validate(db));readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_EXPORT_IDENTITY_UNSUPPORTED'});
  });
  for(const mode of ['timeline','storyboard'])for(const explicit of [true,false])await t.test(`missing saved receipt: ${mode}, explicit=${explicit}`,()=>{
   const {db}=exportSource(t,pair,{mode,explicit});const table=mode==='timeline'?'timeline_requests':'idempotency';
   alter(db,[table,'workspace_restore_holds'],()=>{db.exec(`DELETE FROM ${table}`);db.prepare('DELETE FROM workspace_restore_holds WHERE kind=?').run(table);});
   readOnly(db,()=>pair.validate(db));readOnly(db,()=>dispatch.validateRestore(db),explicit?{}:{code:'RESTORE_EXPORT_IDENTITY_UNSUPPORTED'});
  });
  for(const mode of ['timeline','storyboard'])await t.test(`wrong receipt resource: ${mode}`,()=>{
   const {db}=exportSource(t,pair,{mode});const table=mode==='timeline'?'timeline_requests':'idempotency';
   alter(db,[table,'workspace_restore_holds'],()=>{if(mode==='timeline')db.prepare('UPDATE timeline_requests SET response=?').run(JSON.stringify({id:id(99),projectId:id(1)}));else db.prepare('UPDATE idempotency SET resourceId=?').run(id(99));refreshFixtureHash(db,table);});
   readOnly(db,()=>pair.validate(db));readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_EXPORT_IDENTITY_UNSUPPORTED'});
  });
  await t.test('wrong timeline receipt project',()=>{
   const {db}=exportSource(t,pair,{mode:'timeline'});
   alter(db,['timeline_requests','workspace_restore_holds'],()=>{db.prepare('UPDATE timeline_requests SET response=?').run(JSON.stringify({id:id(5),projectId:id(99)}));refreshFixtureHash(db,'timeline_requests');});
   readOnly(db,()=>pair.validate(db));readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_EXPORT_IDENTITY_UNSUPPORTED'});
  });
 });
}

for(const pair of pairs){
 test(`historical ${pair.restored}: existing-row swap, cross-family pointer and deleted capture cannot reopen`,async t=>{
  const db=fresh(t,pair,{populated:true});
  insert(db,'timeline_requests',{rowid:1,requestId:'second-timeline',requestHash:'b'.repeat(64),response:'{}'});
  pair.install(db,metadata());
  await t.test('swapped existing pointers',()=>probe(db,()=>{
   alter(db,['workspace_restore_holds'],()=>{
    db.exec("UPDATE workspace_restore_holds SET capturedRowid=-9 WHERE kind='timeline_requests' AND capturedRowid=1; UPDATE workspace_restore_holds SET capturedRowid=1 WHERE kind='timeline_requests' AND capturedRowid=9007199254740993; UPDATE workspace_restore_holds SET capturedRowid=9007199254740993 WHERE kind='timeline_requests' AND capturedRowid=-9;");
   });
   readOnly(db,()=>pair.validate(db));readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_CAPTURE_CHANGED'});
  }));
  await t.test('cross-family existing pointer with donor hash',()=>probe(db,()=>{
   const donor=db.prepare("SELECT capturedRowid,rowHash FROM workspace_restore_holds WHERE kind='reference_requests'").get();
   alter(db,['workspace_restore_holds'],()=>{db.prepare("DELETE FROM workspace_restore_holds WHERE kind='timeline_requests' AND capturedRowid=1").run();db.prepare("UPDATE workspace_restore_holds SET capturedRowid=?,rowHash=? WHERE kind='timeline_requests'").run(donor.capturedRowid,donor.rowHash);});
   readOnly(db,()=>pair.validate(db));readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_CAPTURE_CHANGED'});
  }));
  await t.test('deleted captured row',()=>probe(db,()=>{
   alter(db,['timeline_requests'],()=>db.prepare("DELETE FROM timeline_requests WHERE requestId='retained-timeline'").run());
   assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);readOnly(db,()=>pair.validate(db));readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_CAPTURE_CHANGED'});
  }));
 });

 test(`historical ${pair.restored}: composite JSON identities preserve escaped separators and non-ASCII keys`,t=>{
  const db=fresh(t,pair,{populated:true});
  const keys=[['a,b','c'],['a','b,c'],['a"','\\b'],['界','\0quoted']];
  for(const [scope,requestId] of keys)insert(db,'idempotency',{scope,requestId,requestHash:'c'.repeat(64),resourceId:id(10)});
  pair.install(db,metadata());
  for(const key of keys)assert.ok(db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='idempotency' AND id=?").get(JSON.stringify(key)));
  assert.ok(db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='agent_chat_events' AND id=?").get(JSON.stringify([id(21),1])));
  readOnly(db,()=>dispatch.validateRestore(db));
 });
}
