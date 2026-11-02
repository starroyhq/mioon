import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {HISTORY_TABLES_BY_DOMAIN} from '../packages/business/src/project-file/schema/tables.ts';
import {MIO_QUOTA_BYTES_SQL,MIO_QUOTA_ROWS_SQL} from '../packages/business/src/project-file/schema/domains/mio.ts';

const at='2026-11-02T00:00:00.000Z';
function fixture(t:TestContext){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mio-quota-deltas-')),store=openStore(root);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 store.put('projects',{id:store.projectId,name:'Counter invariant synthetic project'});
 return {root,store,db:store.db,projectId:store.projectId};
}
function assertCounters(db:DatabaseSync):void{
 const actual=db.prepare('SELECT bytes,rows FROM mio_storage_counters WHERE singleton=1').get();
 assert.deepEqual(actual,db.prepare(`SELECT ${MIO_QUOTA_BYTES_SQL} AS bytes,${MIO_QUOTA_ROWS_SQL} AS rows`).get());
}

test('every content table has an atomic delta/check trigger and no trigger scans retained tables',t=>{
 const f=fixture(t),tables=HISTORY_TABLES_BY_DOMAIN.mio.filter(name=>name!=='mio_storage_counters');
 const triggers=f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'quota_mio_*'").all();
 assert.equal(tables.length,19);assert.equal(triggers.length,57);
 for(const table of tables)for(const operation of ['insert','update','delete']){
  const item=triggers.find(row=>row.name===`quota_${table}_${operation}`);assert.ok(item);
  const sql=String(item.sql);assert.doesNotMatch(sql,/\b(?:sum|count)\s*\(/iu);
  assert.match(sql,/UPDATE mio_storage_counters SET bytes=/u);
  assert.equal(/AGENT_TASK_STORAGE_LIMIT/u.test(sql),!['mio_edit_claims','mio_edit_owners','mio_edit_receipts','mio_process_target_revisions','mio_rule_writes'].includes(table));
 }
 assert.deepEqual({...f.db.prepare('SELECT * FROM mio_storage_counters').get()},{singleton:1,bytes:0,rows:1});
 assertCounters(f.db);
});

test('deterministic mixed insert/update/delete/upsert/ignore/replace sequences preserve full totals after every operation',t=>{
 const f=fixture(t),{db,projectId}=f,conversationId=randomUUID();
 db.prepare('INSERT INTO mio_conversations VALUES(?,?,?,?)').run(conversationId,projectId,at,at);
 let seed=0x52d9b13a;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(let index=0;index<500;index++){
  const key=String((next()>>>16)%19),kind=(next()>>>16)%8;
  f.store.tx(()=>{
   if(kind===0)db.prepare('INSERT INTO mio_edit_owners VALUES(?,?,?,?) ON CONFLICT(projectId,ownerId) DO UPDATE SET generation=excluded.generation,sequence=excluded.sequence').run(key,projectId,index,index);
   if(kind===1)db.prepare('INSERT OR REPLACE INTO mio_edit_owners VALUES(?,?,?,?)').run(key,projectId,index,index);
   if(kind===2)db.prepare('DELETE FROM mio_edit_owners WHERE projectId=? AND ownerId=?').run(projectId,key);
   if(kind===3)db.prepare('INSERT OR IGNORE INTO mio_edit_owners VALUES(?,?,?,?)').run(key,projectId,index,index);
   if(kind===4)db.prepare('INSERT INTO mio_edit_claims VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updatedAt=excluded.updatedAt').run(`claim-${key}`,projectId,`owner-${key}`,'shot',key,1,index%2?'active':'uncertain',at,at);
   if(kind===5)db.prepare('DELETE FROM mio_edit_claims WHERE projectId=? AND id=?').run(projectId,`claim-${key}`);
   if(kind===6)db.prepare('UPDATE mio_conversations SET updatedAt=? WHERE id=?').run(index%2?at:'2026-11-03T00:00:00.000Z',conversationId);
   if(kind===7)db.prepare('INSERT INTO mio_edit_receipts VALUES(?,?,?,?,?)').run(`receipt-${index}`,projectId,'owner','0'.repeat(64),JSON.stringify({text:'中文🙂'.repeat(index%11)}));
  });
  assertCounters(db);
  if(index%13===0){
   const before=db.prepare('SELECT * FROM mio_storage_counters').get();
   assert.throws(()=>f.store.tx(()=>{db.prepare('INSERT INTO mio_edit_owners VALUES(?,?,1,1)').run(`rollback-${index}`,projectId);assertCounters(db);throw new Error('rollback synthetic');}),/rollback synthetic/u);
   assert.deepEqual(db.prepare('SELECT * FROM mio_storage_counters').get(),before);assertCounters(db);
  }
 }
 // UPDATE OR REPLACE can implicitly delete a second mutable row as well.
 db.prepare('INSERT OR REPLACE INTO mio_edit_owners VALUES(?,?,1,1)').run('source',projectId);
 db.prepare('INSERT OR REPLACE INTO mio_edit_owners VALUES(?,?,1,1)').run('target-longer',projectId);
 db.prepare('UPDATE OR REPLACE mio_edit_owners SET ownerId=? WHERE ownerId=? AND projectId=?').run('target-longer','source',projectId);assertCounters(db);
 db.exec('SAVEPOINT counter_window');
 db.prepare('DELETE FROM mio_edit_owners WHERE ownerId=?').run('target-longer');assertCounters(db);
 db.exec('ROLLBACK TO counter_window; RELEASE counter_window');assertCounters(db);
 const content='immutable blob',sha=createHash('sha256').update(content).digest('hex');
 db.prepare('INSERT INTO mio_blobs VALUES(?,?,?,?)').run(sha,Buffer.byteLength(content),content,at);
 assert.throws(()=>db.prepare('INSERT OR REPLACE INTO mio_blobs VALUES(?,?,?,?)').run(sha,Buffer.byteLength(content),content,at),/retained/u);assertCounters(db);
 assert.equal(db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers,1);
 f.store.close();const reopened=openStore(f.root);
 try{assert.equal(reopened.db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers,1);assertCounters(reopened.db);}finally{reopened.close();}
});

test('missing counters and an outer conflict policy fail closed instead of losing accounting deltas',t=>{
 const f=fixture(t),{db,projectId}=f;
 for(const sql of ['DELETE FROM mio_storage_counters','INSERT OR REPLACE INTO mio_storage_counters VALUES(1,0,1)','UPDATE mio_storage_counters SET singleton=2'])assert.throws(()=>db.exec(sql),/AGENT_TASK_STORAGE_CORRUPT/u);
 assertCounters(db);
 const previous=db.prepare('SELECT * FROM mio_storage_counters').get();
 // Tamper only inside a rolled-back savepoint: the public doctor separately
 // rejects such discrepancies; writes must not lose deltas under OR IGNORE.
 db.exec('SAVEPOINT corrupt_counter');
 db.prepare('UPDATE mio_storage_counters SET bytes=?').run(Number.MAX_SAFE_INTEGER);
 assert.throws(()=>db.prepare('INSERT OR IGNORE INTO mio_edit_owners VALUES(?,?,1,1)').run('overflow',projectId),/AGENT_TASK_STORAGE_CORRUPT/u);
 assert.equal(db.prepare("SELECT 1 FROM mio_edit_owners WHERE ownerId='overflow'").get(),undefined);
 db.exec('ROLLBACK TO corrupt_counter; RELEASE corrupt_counter');assert.deepEqual(db.prepare('SELECT * FROM mio_storage_counters').get(),previous);
 db.exec('SAVEPOINT missing_counter; DROP TRIGGER mio_storage_counters_delete; DELETE FROM mio_storage_counters');
 assert.throws(()=>db.prepare('INSERT INTO mio_edit_owners VALUES(?,?,1,1)').run('missing',projectId),/AGENT_TASK_STORAGE_CORRUPT/u);
 db.exec('ROLLBACK TO missing_counter; RELEASE missing_counter');assertCounters(db);
});
