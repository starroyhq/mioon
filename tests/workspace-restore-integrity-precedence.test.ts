import test from 'node:test';
import assert from 'node:assert/strict';
import {pairs,fresh,metadata,dispatch,alter,probe,readOnly,id} from './workspace-restore-capture-fixtures.mjs';
import type {DatabaseSync} from 'node:sqlite';
import type {TestContext} from 'node:test';

// Corrupt only owned disposable SQL fixtures, then restore the exact guards.
// Current admission must preserve the fixed historical error before entering
// the new binding scan. No application or constructor checks are weakened.
function corruptCheckBoundValue(db: DatabaseSync,table: string,sql: string,value: unknown) {
  // Only manufacturing impossible-on-the-supported-write-path fixture bytes.
  // Reinstate CHECK enforcement and exact trigger SQL before validation.
  db.exec('PRAGMA ignore_check_constraints=ON');
  try {alter(db,[table],()=>db.prepare(sql).run(value as never));}
  finally {db.exec('PRAGMA ignore_check_constraints=OFF');}
  assert.equal(db.prepare('PRAGMA ignore_check_constraints').get()!.ignore_check_constraints,0);
}
type Mutate=(db: DatabaseSync, pair: {restored: number; validate: (db: DatabaseSync)=>unknown; install: (db: DatabaseSync, info: unknown)=>unknown})=>unknown;
const cases: Array<[string,string,Mutate]> = [
  ['missing restored marker','RESTORE_SCHEMA_UNSUPPORTED',(db,pair)=>alter(db,['schema_version'],()=>db.prepare('DELETE FROM schema_version WHERE version=?').run(pair.restored))],
  ['mixed unknown marker','RESTORE_SCHEMA_UNSUPPORTED',db=>alter(db,['schema_version'],()=>db.exec('INSERT INTO schema_version VALUES(999)'))],
  ['missing metadata','RESTORE_METADATA_INVALID',db=>alter(db,['workspace_restoration'],()=>db.exec('DELETE FROM workspace_restoration'))],
  ['malformed metadata hash','RESTORE_METADATA_INVALID',db=>alter(db,['workspace_restoration'],()=>db.prepare('UPDATE workspace_restoration SET manifestHash=?').run('z'.repeat(64)))],
  ['source pair mismatch','RESTORE_METADATA_INVALID',db=>corruptCheckBoundValue(db,'workspace_restoration','UPDATE workspace_restoration SET sourceSchema=?',999)],
  ['profile pair mismatch','RESTORE_METADATA_INVALID',db=>corruptCheckBoundValue(db,'workspace_restoration','UPDATE workspace_restoration SET profile=?','restored-local-unknown')],
  ['malformed hold hash','RESTORE_IDENTITY_INVALID',db=>alter(db,['workspace_restore_holds'],()=>db.prepare("UPDATE workspace_restore_holds SET rowHash=? WHERE kind='timeline_requests'").run('z'.repeat(64)))],
  ['oversized hold identity','RESTORE_IDENTITY_INVALID',db=>corruptCheckBoundValue(db,'workspace_restore_holds',"UPDATE workspace_restore_holds SET id=? WHERE kind='timeline_requests'",'x'.repeat(2049))],
  ['malformed archive evidence','RESTORE_ARCHIVE_CHANGED',db=>alter(db,['workspace_restore_evidence'],()=>db.prepare("UPDATE workspace_restore_evidence SET digest=? WHERE name='workspace_restore_timeline_history'").run('z'.repeat(64)))],
  ['changed archived history','RESTORE_ARCHIVE_CHANGED',db=>alter(db,['workspace_restore_timeline_history'],()=>db.exec("UPDATE workspace_restore_timeline_history SET beforeSnapshot='{\"changed\":true}'"))],
  ['unbound disabled family','RESTORE_UNBOUND_RECORD',db=>alter(db,['workspace_restore_holds'],()=>db.exec("DELETE FROM workspace_restore_holds WHERE kind='jobs'"))],
  ['foreign task epoch','RESTORE_EPOCH_INVALID',db=>alter(db,['edit_tasks'],()=>db.prepare('UPDATE edit_tasks SET executionEpoch=?').run(id(998)))],
  ['unexpected catalog object','RESTORE_SCHEMA_UNSUPPORTED',db=>db.exec('CREATE TABLE unrelated_integrity_catalog(value TEXT)')],
  ['changed guard SQL','RESTORE_SCHEMA_UNSUPPORTED',db=>db.exec("DROP TRIGGER restore_workspace_restore_holds_update;CREATE TRIGGER restore_workspace_restore_holds_update BEFORE UPDATE ON workspace_restore_holds BEGIN SELECT RAISE(ABORT,'CHANGED_GUARD');END")],
];

for(const pair of pairs) {
  test(`restored${pair.restored}: existing fixed refusals remain authoritative before new capture binding`,async t=>{
    const db=fresh(t,pair as never,{populated:true});pair.install(db as never,metadata());
    for(const [name,laterCode,mutate] of cases)await t.test(name,()=>probe(db,()=>{
      // Frozen25 calls restored catalog mismatches INVALID; fixed27–39 call
      // them UNSUPPORTED. Preserve that historical diagnostic distinction.
      const code=pair.restored===25&&['unexpected catalog object','changed guard SQL'].includes(name)?'RESTORE_SCHEMA_INVALID':laterCode;
      mutate(db,pair);
      readOnly(db,()=>pair.validate(db as never),{code:code as never,full:false} as never);
      // This query is owned only by the new helper. Count its entry separately
      // from the raw historical validator's unbound/bounds/catalog queries.
      let newGateEntries=0;
      const native=db.prepare;
      (db as unknown as {prepare: (sql: string,...args: never[])=>unknown}).prepare=function(this: DatabaseSync,sql: string,...args: never[]){
        if(sql.startsWith('SELECT sourceSchema,CASE WHEN length(CAST(profile AS BLOB))<=40'))newGateEntries++;
        return Reflect.apply(native,this,[sql,...args]);
      };
      try {readOnly(db,()=>dispatch.validateRestore(db),{code:code as never,full:false} as never);}finally{(db as unknown as {prepare: typeof native}).prepare=native;}
      assert.equal(newGateEntries,0,'fixed rejection must occur before the new capture loop');
    }));
    readOnly(db,()=>assert.equal(dispatch.validateRestore(db).schemaVersion,pair.restored));
  });
}
