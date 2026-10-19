import test from 'node:test';
import assert from 'node:assert/strict';
import {pairs,baseFamilies,expectedPopulated,frozenInventory,fresh,metadata,dispatch,alter,probe,readOnly,insert,snapshot,id,quote} from './workspace-restore-capture-fixtures.mjs';

const wrongHash='f'.repeat(64);

test('historical capture inventory is independently synchronized with all eight frozen family declarations',()=>{
 assert.deepEqual(pairs.map(pair=>pair.families.length),[29,29,31,31,31,31,33,33]);
 for(const pair of pairs)assert.deepEqual(frozenInventory(pair),pair.families,`frozen schema${pair.restored}`);
 assert.equal(pairs.reduce((n,pair)=>n+pair.families.length,0),248);
 assert.equal(pairs.reduce((n,pair)=>n+expectedPopulated(pair).length,0),168);
 assert.equal(pairs.reduce((n,pair)=>n+pair.families.length-expectedPopulated(pair).length,0),80,'pointer-only version-family combinations are not populated content coverage');
});

for(const pair of pairs){
 for(const populated of [false,true])for(const mock of [false,true])test(`historical ${pair.source}→${pair.restored}: ${populated?'populated':'truly empty'} holds, optional mock=${mock}, exact current result and read-only reopen`,t=>{
  const db=fresh(t,pair,{populated,mock}),info=pair.install(db,metadata());
  assert.equal(info.sourceSchema,pair.source);assert.equal(info.schemaVersion,pair.restored);assert.equal(info.profile,pair.profile);
  const populatedKinds=db.prepare('SELECT DISTINCT kind FROM workspace_restore_holds ORDER BY kind').all().map(row=>row.kind);
  assert.deepEqual(populatedKinds,populated?expectedPopulated(pair).sort():[]);
  if(populated)assert.equal(db.prepare("SELECT CAST(capturedRowid AS TEXT) AS id FROM workspace_restore_holds WHERE kind='timeline_requests'").get()!.id,'9007199254740993');
  readOnly(db,()=>{assert.deepEqual(pair.validate(db),info);assert.deepEqual(dispatch.validateRestore(db),info);assert.deepEqual(dispatch.initialize(db),info);});
 });

 test(`historical ${pair.restored}: raw validator accepts only-hash corruption, current boundary refuses it read-only`,t=>{
  const db=fresh(t,pair,{populated:true});pair.install(db,metadata());
  alter(db,['workspace_restore_holds'],()=>db.prepare("UPDATE workspace_restore_holds SET rowHash=? WHERE kind='timeline_requests'").run(wrongHash));
  readOnly(db,()=>assert.equal(pair.validate(db).schemaVersion,pair.restored));
  readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_CAPTURE_CHANGED'} as never);
 });

 test(`historical ${pair.restored}: ${pair.families.length*2} absent-pointer negatives across every fixed family (pointer coverage, not content coverage)`,async t=>{
  const db=fresh(t,pair);pair.install(db,metadata());const original=snapshot(db);let checked=0;
  for(const kind of pair.families)for(const pointer of [0n,-1n])await t.test(`${kind}: absent rowid ${pointer}`,()=>probe(db,()=>{
   assert.equal(db.prepare(`SELECT 1 FROM ${quote(kind)} WHERE rowid=?`).get(pointer),undefined);
   alter(db,['workspace_restore_holds'],()=>insert(db,'workspace_restore_holds',{kind,id:'missing-capture',capturedRowid:pointer,projectId:null,namespace:null,requestId:null,operation:null,rowHash:wrongHash}));
   readOnly(db,()=>assert.equal(pair.validate(db).schemaVersion,pair.restored),{full:false});
   readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_CAPTURE_CHANGED',full:false} as never);checked++;
  }));
  assert.equal(checked,pair.families.length*2);assert.deepEqual(snapshot(db),original);
 });

 test(`historical ${pair.restored}: wrong well-formed hash for each of ${expectedPopulated(pair).length} genuinely populated families`,async t=>{
  const db=fresh(t,pair,{populated:true});pair.install(db,metadata());
  for(const kind of expectedPopulated(pair))await t.test(kind,()=>probe(db,()=>{
   assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_restore_holds WHERE kind=?').get(kind)!.n,1);
   alter(db,['workspace_restore_holds'],()=>db.prepare('UPDATE workspace_restore_holds SET rowHash=? WHERE kind=?').run(wrongHash,kind));
   readOnly(db,()=>assert.equal(pair.validate(db).schemaVersion,pair.restored),{full:false});
   readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_CAPTURE_CHANGED',full:false} as never);
  }));
 });

 test(`historical ${pair.restored}: all five held identity fields bind even when a live row and valid hash still exist`,async t=>{
  const db=fresh(t,pair,{populated:true});pair.install(db,metadata());
  for(const [field,value] of [['id','other-timeline-request'],['projectId',id(99)],['namespace','reference'],['requestId','other-request'],['operation','timeline.redo']])await t.test(field,()=>probe(db,()=>{
   alter(db,['workspace_restore_holds'],()=>db.prepare(`UPDATE workspace_restore_holds SET ${quote(field)}=? WHERE kind='timeline_requests'`).run(value));
   readOnly(db,()=>assert.equal(pair.validate(db).schemaVersion,pair.restored),{full:false});
   readOnly(db,()=>dispatch.validateRestore(db),{code:'RESTORE_CAPTURE_CHANGED',full:false} as never);
  }));
 });
}
